//! LM Studio default-model resolution reads the discovery snapshot from the cache file scoped to
//! the configured `[baseUrl, apiKey]` — the same scope the provider catalog writes — instead of
//! the unscoped `lmstudio.json`, and never from an untrusted workspace endpoint.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use cowork_config::{
    CachedModelDiscoveryModel, LoadConfigOptions, ModelDiscoveryResult, ModelDiscoverySource,
    ModelRegistry, ProviderName, canonicalize_sync, get_ai_coworker_paths, load_config,
    write_model_discovery_cache,
};
use serde_json::{Map, Value, json};
use uuid::Uuid;

const LM_BASE: &str = "http://127.0.0.1:4321";
const LM_KEY: &str = "lm-secret";

struct Iso {
    root: PathBuf,
    home: PathBuf,
    workspace: PathBuf,
}

impl Iso {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("cowork-lmstudio-default-{}", Uuid::new_v4()));
        let home = root.join("home");
        let workspace = root.join("workspace");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&workspace).unwrap();
        Self {
            root: canonicalize_sync(&root),
            home: canonicalize_sync(&home),
            workspace: canonicalize_sync(&workspace),
        }
    }

    fn env(&self) -> HashMap<String, String> {
        HashMap::from([
            ("HOME".to_string(), self.home.to_string_lossy().into_owned()),
            (
                "COWORK_HOME_OVERRIDE".to_string(),
                self.home.to_string_lossy().into_owned(),
            ),
        ])
    }

    fn load_model(&self) -> String {
        load_config(LoadConfigOptions {
            cwd: Some(self.workspace.clone()),
            homedir: Some(self.home.clone()),
            built_in_dir: Some(repo_root()),
            env: Some(self.env()),
        })
        .unwrap()
        .model
    }

    async fn write_cache(&self, scope: Option<&str>, id: &str) {
        let paths = get_ai_coworker_paths(Some(&self.home), &self.env());
        let model: CachedModelDiscoveryModel =
            serde_json::from_value(json!({ "id": id, "displayName": id, "isDefault": true }))
                .unwrap();
        write_model_discovery_cache(
            &paths,
            ProviderName::Lmstudio,
            ModelDiscoveryResult {
                provider: ProviderName::Lmstudio,
                source: ModelDiscoverySource::LocalHttp,
                models: vec![model],
                updated_at: None,
                expires_at: None,
                message: None,
            },
            scope,
            Some(0),
        )
        .await
        .unwrap();
    }
}

impl Drop for Iso {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .unwrap()
        .to_path_buf()
}

fn write_json(path: &Path, value: &Value) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, serde_json::to_string_pretty(value).unwrap()).unwrap();
}

/// The scope string TypeScript's `createLmStudioModelDiscoveryAdapter` and the Rust catalog use.
fn scope(base: &str, key: &str) -> String {
    json!([base, key]).to_string()
}

#[tokio::test]
async fn lmstudio_default_model_comes_from_the_scoped_discovery_cache() {
    let iso = Iso::new();
    write_json(
        &iso.home.join(".cowork/config/config.json"),
        &json!({
            "provider": "lmstudio",
            // Trailing `/v1/` normalizes to the same scope the catalog writes.
            "providerOptions": { "lmstudio": { "baseUrl": format!("{LM_BASE}/v1/") } }
        }),
    );
    let now = chrono::Utc::now().to_rfc3339();
    write_json(
        &iso.home.join(".cowork/auth/connections.json"),
        &json!({
            "version": 1,
            "updatedAt": now,
            "services": {
                "lmstudio": {
                    "service": "lmstudio",
                    "mode": "api_key",
                    "apiKey": LM_KEY,
                    "updatedAt": now
                }
            }
        }),
    );
    let paths = get_ai_coworker_paths(Some(&iso.home), &iso.env());
    assert!(
        paths.connections_file.is_file(),
        "test must write the real connections store: {}",
        paths.connections_file.display()
    );

    // Nothing discovered: placeholder default.
    assert_eq!(iso.load_model(), "local-model");

    // Caches for other scopes (the legacy unscoped file, another server, no API key) are ignored.
    iso.write_cache(None, "unscoped-x").await;
    iso.write_cache(Some(&scope("http://127.0.0.1:9999", LM_KEY)), "other-x")
        .await;
    iso.write_cache(Some(&scope(LM_BASE, "")), "keyless-x")
        .await;
    assert_eq!(iso.load_model(), "local-model");

    // The cache the catalog writes for the configured endpoint wins.
    iso.write_cache(Some(&scope(LM_BASE, LM_KEY)), "qwen-x")
        .await;
    assert_eq!(iso.load_model(), "qwen-x");

    // Session creation for LM Studio when the workspace default provider differs uses the same
    // resolution with the trusted config `providerOptions`.
    let registry = ModelRegistry::load_from_builtin_dir(&repo_root());
    let po: Map<String, Value> = json!({ "lmstudio": { "baseUrl": LM_BASE } })
        .as_object()
        .cloned()
        .unwrap();
    assert_eq!(
        registry
            .default_model_for_config(ProviderName::Lmstudio, &iso.home, &iso.env(), Some(&po))
            .id,
        "qwen-x"
    );
    let other: Map<String, Value> = json!({ "lmstudio": { "baseUrl": "http://127.0.0.1:9999" } })
        .as_object()
        .cloned()
        .unwrap();
    assert_eq!(
        registry
            .default_model_for_config(ProviderName::Lmstudio, &iso.home, &iso.env(), Some(&other))
            .id,
        "other-x"
    );

    // An untrusted, non-loopback workspace endpoint is stripped before resolution, so its cache
    // is never consulted and the trusted user endpoint keeps selecting the default.
    let evil = "http://evil.example:1234";
    iso.write_cache(Some(&scope(evil, LM_KEY)), "evil-x").await;
    write_json(
        &iso.workspace.join(".cowork/config.json"),
        &json!({ "providerOptions": { "lmstudio": { "baseUrl": evil } } }),
    );
    assert_eq!(iso.load_model(), "qwen-x");

    // A loopback workspace endpoint is trusted and selects its own scope.
    write_json(
        &iso.workspace.join(".cowork/config.json"),
        &json!({ "providerOptions": { "lmstudio": { "baseUrl": "http://localhost:9999" } } }),
    );
    iso.write_cache(Some(&scope("http://localhost:9999", LM_KEY)), "loopback-x")
        .await;
    assert_eq!(iso.load_model(), "loopback-x");

    // An explicitly configured model is never replaced by the discovered default.
    write_json(
        &iso.workspace.join(".cowork/config.json"),
        &json!({ "model": "my-model" }),
    );
    assert_eq!(iso.load_model(), "my-model");
}
