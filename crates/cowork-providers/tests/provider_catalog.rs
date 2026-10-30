use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Body;
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use axum::routing::get;
use chrono::{Duration as ChronoDuration, Utc};
use cowork_config::{
    ConnectionMode, ModelPreferenceUpdate, ProviderName, StoredConnection, get_ai_coworker_paths,
    model_discovery_cache_path, read_model_discovery_cache_sync, save_provider_connection,
    set_model_preferences, upsert_custom_model, write_text_file_atomic,
};
use cowork_providers::catalog::{
    CatalogBuildOptions, build_provider_catalog, default_provider_auth_methods, mask_api_key,
};
use serde_json::{Value, json};
use tokio::net::TcpListener;
use uuid::Uuid;

#[test]
fn masks_api_keys_and_exposes_all_14_provider_auth_methods() {
    assert_eq!(mask_api_key(""), "****");
    assert_eq!(mask_api_key("abc"), "****");
    assert_eq!(mask_api_key("12345678"), "********");
    assert_eq!(mask_api_key("sk-proj-1234567890abcd"), "sk-p...abcd");

    let methods = default_provider_auth_methods();
    assert_eq!(methods.len(), 14);
    for provider in ProviderName::ALL {
        assert!(
            methods.contains_key(provider.as_str()),
            "missing auth methods for {}",
            provider.as_str()
        );
    }

    let google = methods["google"].as_array().unwrap();
    let google_ids: Vec<&str> = google.iter().filter_map(|m| m["id"].as_str()).collect();
    assert_eq!(
        google_ids,
        vec!["api_key", "exa_api_key", "parallel_api_key"]
    );

    let bedrock = methods["bedrock"].as_array().unwrap();
    let bedrock_ids: Vec<&str> = bedrock.iter().filter_map(|m| m["id"].as_str()).collect();
    assert_eq!(
        bedrock_ids,
        vec!["aws_default", "aws_profile", "aws_keys", "api_key"]
    );
    assert!(bedrock[2]["fields"].as_array().unwrap().len() >= 4);

    assert_eq!(
        methods["firepass"][0]["label"].as_str(),
        Some("Fire Pass API key")
    );
    assert_eq!(
        methods["lmstudio"][0]["label"].as_str(),
        Some("API token (optional)")
    );
    assert_eq!(methods["codex-cli"][0]["id"].as_str(), Some("oauth_cli"));
    assert_eq!(methods["codex-cli"][0]["type"].as_str(), Some("oauth"));
    assert_eq!(methods["codex-cli"][0]["oauthMode"].as_str(), Some("auto"));
}

#[tokio::test]
async fn discovers_live_models_caches_with_24h_ttl_and_falls_back_when_offline() {
    let base = PathBuf::from(format!("/private/tmp/cowork-cat-ttl-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&base).unwrap();
    let base = std::fs::canonicalize(&base).unwrap();

    let mut env = HashMap::new();
    env.insert("HOME".to_string(), base.to_string_lossy().into_owned());
    env.insert(
        "COWORK_HOME_OVERRIDE".to_string(),
        base.to_string_lossy().into_owned(),
    );
    let paths = get_ai_coworker_paths(Some(&base), &env);

    save_provider_connection(
        &paths,
        StoredConnection {
            service: ProviderName::Baseten,
            mode: ConnectionMode::ApiKey,
            method_id: Some("api_key".into()),
            api_key: Some("bst-secret-token-1234".into()),
            values: None,
            updated_at: Utc::now().to_rfc3339(),
        },
    )
    .await
    .unwrap();

    let hits = Arc::new(AtomicUsize::new(0));
    let auth_seen = Arc::new(Mutex::new(Vec::<String>::new()));
    let hits_clone = hits.clone();
    let auth_clone = auth_seen.clone();

    let app = Router::new().route(
        "/v1/models",
        get(move |headers: HeaderMap| {
            let h = hits_clone.clone();
            let a = auth_clone.clone();
            async move {
                h.fetch_add(1, Ordering::SeqCst);
                if let Some(val) = headers.get("authorization").and_then(|v| v.to_str().ok()) {
                    a.lock().unwrap().push(val.to_string());
                }
                Response::builder()
                    .status(StatusCode::OK)
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "data": [
                                { "id": "moonshotai/Kimi-K2.6", "object": "model" },
                                { "id": "text-embedding-3-small", "object": "model" }
                            ]
                        })
                        .to_string(),
                    ))
                    .unwrap()
            }
        }),
    );

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let srv = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    let mut base_url_overrides = HashMap::new();
    base_url_overrides.insert(ProviderName::Baseten, format!("http://127.0.0.1:{port}/v1"));
    // Point LM Studio and public OpenCode endpoints at an unused loopback port so this test stays deterministic and offline
    base_url_overrides.insert(ProviderName::Lmstudio, "http://127.0.0.1:9".to_string());
    base_url_overrides.insert(
        ProviderName::OpencodeGo,
        "http://127.0.0.1:9/v1".to_string(),
    );
    base_url_overrides.insert(
        ProviderName::OpencodeZen,
        "http://127.0.0.1:9/v1".to_string(),
    );

    // 1. Force refresh populates 24h cache and sends `Api-Key` header for Baseten
    let cat1 = build_provider_catalog(&CatalogBuildOptions {
        homedir: base.clone(),
        env: env.clone(),
        provider_options: None,
        refresh: true,
        discovery_timeout_ms: Some(3_000),
        base_url_overrides: base_url_overrides.clone(),
    })
    .await;

    assert_eq!(hits.load(Ordering::SeqCst), 1);
    assert_eq!(
        auth_seen.lock().unwrap().as_slice(),
        &["Api-Key bst-secret-token-1234"]
    );
    let baseten_entry = cat1
        .all
        .iter()
        .find(|e| e.id == ProviderName::Baseten)
        .unwrap();
    assert_eq!(baseten_entry.models.len(), 1);
    assert_eq!(baseten_entry.models[0].id, "moonshotai/Kimi-K2.6");

    let cache_path = model_discovery_cache_path(&paths, ProviderName::Baseten, None);
    assert!(cache_path.is_file());
    assert_eq!(
        std::fs::metadata(&cache_path).unwrap().permissions().mode() & 0o777,
        0o600
    );

    // 2. Subsequent read without `refresh: true` serves fresh 24h cache with 0 new HTTP hits
    let _cat2 = build_provider_catalog(&CatalogBuildOptions {
        homedir: base.clone(),
        env: env.clone(),
        provider_options: None,
        refresh: false,
        discovery_timeout_ms: Some(3_000),
        base_url_overrides: base_url_overrides.clone(),
    })
    .await;
    assert_eq!(hits.load(Ordering::SeqCst), 1);

    // 3. Expire the cache TTL and verify non-forced read re-fetches from server
    let mut expired = read_model_discovery_cache_sync(&paths, ProviderName::Baseten, None).unwrap();
    expired.expires_at = Some((Utc::now() - ChronoDuration::hours(1)).to_rfc3339());
    write_text_file_atomic(
        &cache_path,
        &serde_json::to_string_pretty(&expired).unwrap(),
        Some(0o600),
    )
    .unwrap();

    let _cat3 = build_provider_catalog(&CatalogBuildOptions {
        homedir: base.clone(),
        env: env.clone(),
        provider_options: None,
        refresh: false,
        discovery_timeout_ms: Some(3_000),
        base_url_overrides: base_url_overrides.clone(),
    })
    .await;
    assert_eq!(hits.load(Ordering::SeqCst), 2);

    // 4. Stop server and force refresh -> falls back to cached models with state = "unreachable"
    srv.abort();
    let cat4 = build_provider_catalog(&CatalogBuildOptions {
        homedir: base.clone(),
        env: env.clone(),
        provider_options: None,
        refresh: true,
        discovery_timeout_ms: Some(500),
        base_url_overrides,
    })
    .await;
    let baseten_offline = cat4
        .all
        .iter()
        .find(|e| e.id == ProviderName::Baseten)
        .unwrap();
    assert_eq!(baseten_offline.state.as_deref(), Some("unreachable"));
    assert_eq!(baseten_offline.models[0].id, "moonshotai/Kimi-K2.6");

    let _ = std::fs::remove_dir_all(&base);
}

#[tokio::test]
async fn merges_custom_models_applies_preferences_and_repairs_disabled_default_model() {
    let base = PathBuf::from(format!("/private/tmp/cowork-cat-prefs-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&base).unwrap();
    let base = std::fs::canonicalize(&base).unwrap();

    let mut env = HashMap::new();
    env.insert("HOME".to_string(), base.to_string_lossy().into_owned());
    env.insert(
        "COWORK_HOME_OVERRIDE".to_string(),
        base.to_string_lossy().into_owned(),
    );
    let paths = get_ai_coworker_paths(Some(&base), &env);

    // Add a custom GPT-5 deployment on OpenAI
    upsert_custom_model(&paths, ProviderName::Openai, "gpt-5.4-custom-deploy")
        .await
        .unwrap();

    let mut base_url_overrides = HashMap::new();
    base_url_overrides.insert(ProviderName::Lmstudio, "http://127.0.0.1:9".to_string());

    let cat_initial = build_provider_catalog(&CatalogBuildOptions {
        homedir: base.clone(),
        env: env.clone(),
        provider_options: None,
        refresh: false,
        discovery_timeout_ms: Some(500),
        base_url_overrides: base_url_overrides.clone(),
    })
    .await;
    assert_eq!(cat_initial.all.len(), 14);

    let openai_initial = cat_initial
        .all
        .iter()
        .find(|e| e.id == ProviderName::Openai)
        .unwrap();
    let initial_default = openai_initial.default_model.clone();
    assert!(!initial_default.is_empty());

    let custom_model = openai_initial
        .models
        .iter()
        .find(|m| m.id == "gpt-5.4-custom-deploy")
        .expect("custom model merged");
    assert_eq!(
        custom_model
            .runtime_options
            .as_ref()
            .and_then(|m| m.get("source"))
            .and_then(Value::as_str),
        Some("custom")
    );
    assert!(
        custom_model.reasoning.is_some(),
        "custom gpt-5 model should advertise reasoning efforts"
    );

    // Disable the default OpenAI model -> `defaultModel` and `defaults["openai"]` MUST repair to an enabled model!
    set_model_preferences(
        &paths,
        ProviderName::Openai,
        &[ModelPreferenceUpdate {
            id: initial_default.clone(),
            enabled: false,
        }],
    )
    .await
    .unwrap();

    let cat_after_disable = build_provider_catalog(&CatalogBuildOptions {
        homedir: base.clone(),
        env: env.clone(),
        provider_options: None,
        refresh: false,
        discovery_timeout_ms: Some(500),
        base_url_overrides,
    })
    .await;

    let openai_after = cat_after_disable
        .all
        .iter()
        .find(|e| e.id == ProviderName::Openai)
        .unwrap();
    let disabled_entry = openai_after
        .models
        .iter()
        .find(|m| m.id == initial_default)
        .unwrap();
    assert_eq!(disabled_entry.enabled, Some(false));
    assert_ne!(openai_after.default_model, initial_default);
    assert_eq!(
        cat_after_disable.default.get("openai"),
        Some(&openai_after.default_model)
    );
    // Enabled models MUST omit `enabled` (`None`), never `Some(true)`
    let repair_target = openai_after
        .models
        .iter()
        .find(|m| m.id == openai_after.default_model)
        .unwrap();
    assert_eq!(repair_target.enabled, None);

    let _ = std::fs::remove_dir_all(&base);
}
