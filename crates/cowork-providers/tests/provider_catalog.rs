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

#[tokio::test]
async fn discovers_codex_cli_models_via_app_server_caches_with_24h_ttl_and_refreshes_on_expiry() {
    let base = PathBuf::from(format!("/private/tmp/cowork-cat-codex-{}", Uuid::new_v4()));
    let home = base.join("home");
    std::fs::create_dir_all(&home).unwrap();
    let home = std::fs::canonicalize(&home).unwrap();

    let mut env = HashMap::new();
    env.insert("HOME".to_string(), home.to_string_lossy().into_owned());
    env.insert(
        "COWORK_HOME_OVERRIDE".to_string(),
        home.to_string_lossy().into_owned(),
    );
    let paths = get_ai_coworker_paths(Some(&home), &env);

    // Populate isolated `<homedir>/.cowork/auth/codex-cli/auth.json`
    std::fs::create_dir_all(&paths.codex_auth_dir).unwrap();
    write_text_file_atomic(
        &paths.codex_auth_dir.join("auth.json"),
        r#"{"access_token":"codex-cat-tok","email":"dev@example.com"}"#,
        Some(0o600),
    )
    .unwrap();

    let counter_file = base.join("model_list_calls.txt");
    let script_path = base.join("mock_codex_catalog.mjs");
    std::fs::write(
        &script_path,
        format!(
            r#"import fs from "node:fs";
import readline from "node:readline";

const counterFile = {counter:?};
const expectedCodexHome = {codex_home:?};
if (process.env.CODEX_HOME !== expectedCodexHome) {{
  process.stderr.write(`Unexpected CODEX_HOME: ${{process.env.CODEX_HOME}}\n`);
  process.exit(2);
}}

const rl = readline.createInterface({{ input: process.stdin, crlfDelay: Infinity }});
function send(obj) {{
  process.stdout.write(JSON.stringify(obj) + "\n");
}}

rl.on("line", (line) => {{
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {{
    send({{ id: msg.id, result: {{ serverInfo: {{ name: "mock-codex", version: "0.160.0" }} }} }});
  }} else if (msg.method === "account/read") {{
    send({{ id: msg.id, result: {{ account: {{ email: "dev@example.com", planType: "pro" }}, requiresOpenaiAuth: false }} }});
  }} else if (msg.method === "model/list") {{
    const prev = fs.existsSync(counterFile) ? Number(fs.readFileSync(counterFile, "utf8")) : 0;
    const next = prev + 1;
    fs.writeFileSync(counterFile, String(next), "utf8");
    if (!msg.params?.cursor) {{
      send({{
        id: msg.id,
        result: {{
          data: [{{
            id: `gpt-5.4-codex-live-p${{next}}`,
            displayName: "GPT-5.4 Codex Live",
            isDefault: true,
            supportsImageInput: true,
            reasoningEfforts: ["low", "medium", "high", "xhigh"],
            defaultReasoningEffort: "high"
          }}],
          nextCursor: "page-2"
        }}
      }});
    }} else {{
      send({{
        id: msg.id,
        result: {{
          data: [{{
            id: "gpt-5.3-codex-mini",
            displayName: "GPT-5.3 Codex Mini",
            isDefault: false,
            supportsImageInput: false,
            reasoningEfforts: ["low", "medium"],
            defaultReasoningEffort: "medium"
          }}],
          nextCursor: null
        }}
      }});
    }}
  }}
}});
"#,
            counter = counter_file.to_string_lossy(),
            codex_home = paths.codex_auth_dir.to_string_lossy(),
        ),
    )
    .unwrap();

    // Find `node` executable from build/test runner PATH to write a self-contained wrapper script
    let node_bin = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .map(|p| p.join("node"))
        .find(|p| p.is_file())
        .unwrap_or_else(|| PathBuf::from("/usr/local/bin/node"));
    let wrapper_path = base.join("mock-codex-bin");
    std::fs::write(
        &wrapper_path,
        format!(
            "#!/bin/sh\nexec \"{}\" \"{}\" \"$@\"\n",
            node_bin.display(),
            script_path.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&wrapper_path, std::fs::Permissions::from_mode(0o755)).unwrap();

    env.insert(
        "COWORK_CODEX_APP_SERVER_BIN".to_string(),
        wrapper_path.to_string_lossy().into_owned(),
    );

    let mut base_url_overrides = HashMap::new();
    base_url_overrides.insert(ProviderName::Lmstudio, "http://127.0.0.1:9".to_string());
    base_url_overrides.insert(
        ProviderName::OpencodeGo,
        "http://127.0.0.1:9/v1".to_string(),
    );
    base_url_overrides.insert(
        ProviderName::OpencodeZen,
        "http://127.0.0.1:9/v1".to_string(),
    );

    // 1. `refresh: true` queries `codex app-server` `model/list` (both pages) and writes 24h cache
    let cat1 = build_provider_catalog(&CatalogBuildOptions {
        homedir: home.clone(),
        env: env.clone(),
        provider_options: None,
        refresh: true,
        discovery_timeout_ms: Some(5_000),
        base_url_overrides: base_url_overrides.clone(),
    })
    .await;

    let calls_after_refresh: usize = std::fs::read_to_string(&counter_file)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    assert_eq!(
        calls_after_refresh, 2,
        "expected 2 paginated model/list calls"
    );

    let codex_entry = cat1
        .all
        .iter()
        .find(|e| e.id == ProviderName::CodexCli)
        .unwrap();
    assert_eq!(codex_entry.state.as_deref(), Some("ready"));
    assert!(
        codex_entry
            .models
            .iter()
            .any(|m| m.id == "gpt-5.4-codex-live-p1")
    );
    assert!(
        codex_entry
            .models
            .iter()
            .any(|m| m.id == "gpt-5.3-codex-mini")
    );
    assert_eq!(codex_entry.default_model, "gpt-5.4-codex-live-p1");

    let cache_path = model_discovery_cache_path(&paths, ProviderName::CodexCli, None);
    assert!(cache_path.is_file());

    // 2. Subsequent read within 24h TTL (`refresh: false`) serves from cache without spawning codex
    let _cat2 = build_provider_catalog(&CatalogBuildOptions {
        homedir: home.clone(),
        env: env.clone(),
        provider_options: None,
        refresh: false,
        discovery_timeout_ms: Some(5_000),
        base_url_overrides: base_url_overrides.clone(),
    })
    .await;
    let calls_cached: usize = std::fs::read_to_string(&counter_file)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    assert_eq!(calls_cached, 2, "fresh 24h cache must not re-query codex");

    // 3. Expire 24h cache TTL -> authenticated non-forced read (`refresh: false`) re-queries `model/list` and updates cache
    let mut expired =
        read_model_discovery_cache_sync(&paths, ProviderName::CodexCli, None).unwrap();
    expired.expires_at = Some((Utc::now() - ChronoDuration::hours(2)).to_rfc3339());
    write_text_file_atomic(
        &cache_path,
        &serde_json::to_string_pretty(&expired).unwrap(),
        Some(0o600),
    )
    .unwrap();

    let cat3 = build_provider_catalog(&CatalogBuildOptions {
        homedir: home.clone(),
        env: env.clone(),
        provider_options: None,
        refresh: false,
        discovery_timeout_ms: Some(5_000),
        base_url_overrides,
    })
    .await;
    let calls_after_expiry: usize = std::fs::read_to_string(&counter_file)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    assert_eq!(
        calls_after_expiry, 4,
        "expired 24h cache must trigger live model/list refresh when authenticated"
    );
    let codex_entry_3 = cat3
        .all
        .iter()
        .find(|e| e.id == ProviderName::CodexCli)
        .unwrap();
    assert!(
        codex_entry_3
            .models
            .iter()
            .any(|m| m.id == "gpt-5.4-codex-live-p3")
    );

    let refreshed_cache =
        read_model_discovery_cache_sync(&paths, ProviderName::CodexCli, None).unwrap();
    let refreshed_exp =
        chrono::DateTime::parse_from_rfc3339(refreshed_cache.expires_at.as_deref().unwrap())
            .unwrap();
    assert!(refreshed_exp > Utc::now());

    let _ = std::fs::remove_dir_all(&base);
}
