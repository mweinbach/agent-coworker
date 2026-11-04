//! Legacy `readProviderCatalogSnapshot` parity: a cache-only provider catalog for the system
//! prompt (cached discovery of any age, else bundled static entries, then custom models and
//! preferences) with a `configured` provider list, and no live discovery.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use axum::Router;
use axum::http::StatusCode;
use axum::routing::any;
use cowork_config::{
    CachedModelDiscoveryModel, ConnectionMode, ModelDiscoveryResult, ModelDiscoverySource,
    ModelPreferenceUpdate, ProviderName, StoredConnection, get_ai_coworker_paths,
    save_provider_connection, set_model_preferences, upsert_custom_model,
    write_model_discovery_cache,
};
use cowork_providers::catalog::{CatalogBuildOptions, read_provider_catalog_snapshot};
use cowork_providers::chat_completions::normalize_lmstudio_base_url;
use serde_json::json;
use tokio::net::TcpListener;

const BUILTIN_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");

fn cached_model(id: &str, display_name: &str, is_default: bool) -> CachedModelDiscoveryModel {
    serde_json::from_value(json!({
        "id": id,
        "displayName": display_name,
        "isDefault": is_default,
    }))
    .unwrap()
}

fn discovery(
    provider: ProviderName,
    models: Vec<CachedModelDiscoveryModel>,
) -> ModelDiscoveryResult {
    ModelDiscoveryResult {
        provider,
        source: ModelDiscoverySource::Api,
        models,
        updated_at: None,
        expires_at: None,
        message: None,
    }
}

/// A local server that counts every request, so the test can prove no live discovery ran.
async fn spawn_counting_server() -> (String, Arc<AtomicUsize>) {
    let hits = Arc::new(AtomicUsize::new(0));
    let counter = hits.clone();
    let app = Router::new().fallback(any(move || {
        let counter = counter.clone();
        async move {
            counter.fetch_add(1, Ordering::SeqCst);
            StatusCode::INTERNAL_SERVER_ERROR
        }
    }));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("http://{addr}"), hits)
}

#[tokio::test]
async fn snapshot_reads_caches_static_entries_custom_models_and_configured_providers() {
    let home = tempfile::tempdir().unwrap();
    let base: PathBuf = std::fs::canonicalize(home.path()).unwrap();
    let mut env = HashMap::new();
    env.insert("HOME".to_owned(), base.to_string_lossy().into_owned());
    env.insert("TOGETHER_API_KEY".to_owned(), "together-key".to_owned());
    env.insert("GEMINI_API_KEY".to_owned(), "gemini-key".to_owned());
    let paths = get_ai_coworker_paths(Some(&base), &env);

    // OpenAI: an already-expired discovery cache is still used, but grants no credentials.
    write_model_discovery_cache(
        &paths,
        ProviderName::Openai,
        discovery(
            ProviderName::Openai,
            vec![
                cached_model("gpt-5.4", "GPT-5.4 (cached)", true),
                cached_model("ft:custom-1", "FT Custom", false),
            ],
        ),
        None,
        Some(-60_000),
    )
    .await
    .unwrap();
    upsert_custom_model(&paths, ProviderName::Openai, "my-deploy")
        .await
        .unwrap();
    set_model_preferences(
        &paths,
        ProviderName::Openai,
        &[ModelPreferenceUpdate {
            id: "ft:custom-1".to_owned(),
            enabled: false,
        }],
    )
    .await
    .unwrap();

    // LM Studio: a cache under the configured base URL's scope makes it configured.
    let (mock_url, hits) = spawn_counting_server().await;
    let lmstudio_base = normalize_lmstudio_base_url(Some(&mock_url));
    write_model_discovery_cache(
        &paths,
        ProviderName::Lmstudio,
        discovery(
            ProviderName::Lmstudio,
            vec![cached_model("qwen/qwen3-8b", "Qwen3 8B", false)],
        ),
        Some(&json!([lmstudio_base, ""]).to_string()),
        None,
    )
    .await
    .unwrap();

    save_provider_connection(
        &paths,
        StoredConnection {
            service: ProviderName::Anthropic,
            mode: ConnectionMode::ApiKey,
            method_id: None,
            api_key: Some("sk-ant-test".to_owned()),
            values: None,
            updated_at: "2026-11-01T00:00:00Z".to_owned(),
        },
    )
    .await
    .unwrap();
    std::fs::create_dir_all(&paths.codex_auth_dir).unwrap();
    std::fs::write(paths.codex_auth_dir.join("auth.json"), "{}").unwrap();

    let mut base_url_overrides = HashMap::new();
    for provider in [
        ProviderName::Together,
        ProviderName::Google,
        ProviderName::Anthropic,
        ProviderName::Openai,
        ProviderName::Lmstudio,
    ] {
        base_url_overrides.insert(provider, mock_url.clone());
    }
    let snapshot = read_provider_catalog_snapshot(&CatalogBuildOptions {
        built_in_dir: BUILTIN_DIR.into(),
        homedir: base.clone(),
        env: env.clone(),
        provider_options: None,
        refresh: true,
        discovery_timeout_ms: Some(500),
        base_url_overrides,
    })
    .await;

    assert_eq!(
        hits.load(Ordering::SeqCst),
        0,
        "snapshot must not discover live"
    );
    assert_eq!(snapshot.source, "cache-only");
    assert_eq!(
        snapshot.all.iter().map(|e| e.id).collect::<Vec<_>>(),
        ProviderName::ALL.to_vec()
    );

    let openai = snapshot
        .all
        .iter()
        .find(|e| e.id == ProviderName::Openai)
        .unwrap();
    let openai_models: Vec<(&str, &str, Option<bool>)> = openai
        .models
        .iter()
        .map(|m| (m.id.as_str(), m.display_name.as_str(), m.enabled))
        .collect();
    assert_eq!(
        openai_models,
        [
            ("gpt-5.4", "GPT-5.4 (cached)", None),
            ("ft:custom-1", "FT Custom", Some(false)),
            ("my-deploy", "my-deploy", None),
        ]
    );
    assert_eq!(openai.default_model, "gpt-5.4");
    assert_eq!(
        snapshot.default.get("openai").map(String::as_str),
        Some("gpt-5.4")
    );

    // Uncached providers get their bundled static entry, sorted by id like the TS registry.
    let anthropic = snapshot
        .all
        .iter()
        .find(|e| e.id == ProviderName::Anthropic)
        .unwrap();
    let ids: Vec<&str> = anthropic.models.iter().map(|m| m.id.as_str()).collect();
    let mut sorted = ids.clone();
    sorted.sort_by_key(|id| id.to_lowercase());
    assert_eq!(ids, sorted);
    assert!(ids.contains(&"claude-opus-4-8"));
    assert!(!anthropic.default_model.is_empty());

    let lmstudio = snapshot
        .all
        .iter()
        .find(|e| e.id == ProviderName::Lmstudio)
        .unwrap();
    assert_eq!(lmstudio.models.len(), 1);
    assert_eq!(lmstudio.models[0].id, "qwen/qwen3-8b");

    let expected_configured = [
        ProviderName::Google,
        ProviderName::Anthropic,
        ProviderName::Together,
        ProviderName::Lmstudio,
        ProviderName::CodexCli,
    ];
    assert_eq!(
        snapshot.configured,
        ProviderName::ALL
            .into_iter()
            .filter(|p| expected_configured.contains(p))
            .collect::<Vec<_>>()
    );
    for provider in [
        ProviderName::Openai,
        ProviderName::Bedrock,
        ProviderName::Fireworks,
    ] {
        assert!(!snapshot.configured.contains(&provider), "{provider:?}");
    }
}
