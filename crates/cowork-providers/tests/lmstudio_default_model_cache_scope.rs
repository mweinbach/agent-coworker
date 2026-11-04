//! Writer/reader agreement for the scoped LM Studio discovery cache: the provider catalog writes
//! the snapshot under `[baseUrl, apiKey]`, and config load (with no configured model) must read
//! that same file back to pick the discovered default instead of the `local-model` placeholder.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use axum::Router;
use axum::routing::get;
use chrono::Utc;
use cowork_config::{
    ConnectionMode, LoadConfigOptions, ProviderName, StoredConnection, get_ai_coworker_paths,
    load_config, resolve_lmstudio_discovery_endpoint, save_provider_connection,
};
use cowork_providers::catalog::{
    CatalogBuildOptions, build_provider_catalog, lmstudio_catalog_endpoint,
};
use serde_json::{Map, Value, json};
use tokio::net::TcpListener;
use uuid::Uuid;

const BUILTIN_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");

fn write_json(path: &Path, value: &Value) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, serde_json::to_string_pretty(value).unwrap()).unwrap();
}

async fn spawn_lmstudio(model_id: &'static str) -> String {
    let app = Router::new().route(
        "/v1/models",
        get(move || async move {
            axum::Json(json!({ "object": "list", "data": [{ "id": model_id, "object": "model" }] }))
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("http://127.0.0.1:{port}")
}

/// `CatalogBuildOptions` as `ServerRuntimeState::catalog_build_options` builds them: the trusted
/// config `providerOptions`, plus a base-URL override from `providerOptions.lmstudio.baseUrl`.
fn server_like_options(
    home: &Path,
    env: &HashMap<String, String>,
    provider_options: Option<Map<String, Value>>,
) -> CatalogBuildOptions {
    let mut base_url_overrides = HashMap::new();
    if let Some(url) = provider_options
        .as_ref()
        .and_then(|po| po.get("lmstudio"))
        .and_then(|s| s.get("baseUrl"))
        .and_then(Value::as_str)
    {
        base_url_overrides.insert(ProviderName::Lmstudio, url.to_string());
    }
    // Keep the public OpenCode endpoints offline.
    base_url_overrides.insert(ProviderName::OpencodeGo, "http://127.0.0.1:9/v1".into());
    base_url_overrides.insert(ProviderName::OpencodeZen, "http://127.0.0.1:9/v1".into());
    CatalogBuildOptions {
        built_in_dir: PathBuf::from(BUILTIN_DIR),
        homedir: home.to_path_buf(),
        env: env.clone(),
        provider_options,
        refresh: true,
        discovery_timeout_ms: Some(3_000),
        base_url_overrides,
    }
}

#[tokio::test]
async fn config_default_reads_the_lmstudio_cache_the_catalog_wrote() {
    let root = std::env::temp_dir().join(format!("cowork-lm-scope-{}", Uuid::new_v4()));
    let home = root.join("home");
    let workspace = root.join("workspace");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&workspace).unwrap();
    let env = HashMap::from([
        ("HOME".to_string(), home.to_string_lossy().into_owned()),
        (
            "COWORK_HOME_OVERRIDE".to_string(),
            home.to_string_lossy().into_owned(),
        ),
    ]);
    let paths = get_ai_coworker_paths(Some(&home), &env);
    save_provider_connection(
        &paths,
        StoredConnection {
            service: ProviderName::Lmstudio,
            mode: ConnectionMode::ApiKey,
            method_id: Some("api_key".into()),
            api_key: Some("lm-token".into()),
            values: None,
            updated_at: Utc::now().to_rfc3339(),
        },
    )
    .await
    .unwrap();

    let base = spawn_lmstudio("qwen-x").await;
    write_json(
        &home.join(".cowork/config/config.json"),
        &json!({
            "provider": "lmstudio",
            "providerOptions": { "lmstudio": { "baseUrl": format!("{base}/v1") } }
        }),
    );
    let load = || {
        load_config(LoadConfigOptions {
            cwd: Some(workspace.clone()),
            homedir: Some(home.clone()),
            built_in_dir: Some(PathBuf::from(BUILTIN_DIR)),
            env: Some(env.clone()),
        })
        .unwrap()
    };

    // Before discovery: placeholder.
    let before = load();
    assert_eq!(before.model, "local-model");

    // The catalog's endpoint (and therefore its cache scope) is the one config resolves.
    let opts = server_like_options(&home, &env, before.provider_options.clone());
    let store = cowork_config::read_connection_store(&paths).await.unwrap();
    let catalog_endpoint = lmstudio_catalog_endpoint(&opts, &store);
    let config_endpoint = resolve_lmstudio_discovery_endpoint(
        &env,
        before.provider_options.as_ref(),
        store.provider_api_key(ProviderName::Lmstudio).as_deref(),
    );
    assert_eq!(catalog_endpoint, config_endpoint);
    assert_eq!(
        catalog_endpoint.cache_scope(),
        json!([base, "lm-token"]).to_string()
    );
    // Without the server's override map the catalog still lands on the same endpoint.
    let mut no_override = opts.clone();
    no_override.base_url_overrides.clear();
    assert_eq!(
        lmstudio_catalog_endpoint(&no_override, &store),
        config_endpoint
    );

    // Live discovery writes the scoped cache; config load picks the discovered model up.
    let catalog = build_provider_catalog(&opts).await;
    let lm = catalog
        .all
        .iter()
        .find(|e| e.id == ProviderName::Lmstudio)
        .expect("lmstudio catalog entry");
    assert!(lm.models.iter().any(|m| m.id == "qwen-x"));
    assert_eq!(load().model, "qwen-x");

    let _ = std::fs::remove_dir_all(&root);
}
