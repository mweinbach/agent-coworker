//! `~/.cowork/config/marketplaces.json` must decode every document the TypeScript app wrote
//! (`src/plugins/marketplaceRegistry.ts`), which never persisted `id`, and add/remove must never
//! drop or clobber entries they could not decode.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use axum::Router;
use axum::routing::get;
use cowork_config::{AgentConfig, LoadConfigOptions, load_config};
use cowork_harness::extensions::{ExtensionManager, MarketplaceSourceInput};
use serde_json::{Value, json};
use tokio::net::TcpListener;

const LEGACY_TS_FILE: &str = r#"{"version":1,"marketplaces":[{"repo":"acme/skills","ref":"main","marketplacePath":".agents/plugins/marketplace.json","addedAt":"2026-03-01T10:00:00.000Z"}]}"#;

struct Fixture {
    _tmp: tempfile::TempDir,
    cfg: AgentConfig,
    env: HashMap<String, String>,
}

fn fixture(extra_env: HashMap<String, String>) -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("home");
    let ws = tmp.path().join("ws");
    fs::create_dir_all(home.join(".cowork/config")).unwrap();
    fs::create_dir_all(ws.join(".cowork")).unwrap();
    fs::create_dir_all(tmp.path().join("builtin/skills")).unwrap();
    let mut env = HashMap::new();
    env.insert("HOME".to_owned(), home.to_string_lossy().into_owned());
    env.insert(
        "COWORK_HOME_OVERRIDE".to_owned(),
        home.join(".cowork").to_string_lossy().into_owned(),
    );
    env.insert("COWORK_DISABLE_RUNTIME".to_owned(), "1".to_owned());
    env.insert("COWORK_RUNTIME_ALLOW_NETWORK".to_owned(), "0".to_owned());
    env.extend(extra_env);
    let cfg = load_config(LoadConfigOptions {
        cwd: Some(ws),
        homedir: Some(home),
        built_in_dir: Some(tmp.path().join("builtin")),
        env: Some(env.clone()),
    })
    .unwrap();
    Fixture {
        _tmp: tmp,
        cfg,
        env,
    }
}

/// Loopback GitHub that serves a valid, empty marketplace manifest for every repo.
async fn loopback_github() -> HashMap<String, String> {
    let app = Router::new().route(
        "/raw/{*path}",
        get(|| async {
            axum::Json(json!({
                "name": "loopback-marketplace",
                "plugins": [],
                "skills": []
            }))
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    HashMap::from([
        (
            "COWORK_GITHUB_API_BASE_URL".to_owned(),
            format!("http://{addr}"),
        ),
        (
            "COWORK_GITHUB_RAW_BASE_URL".to_owned(),
            format!("http://{addr}/raw"),
        ),
    ])
}

fn registry_path(cfg: &AgentConfig) -> PathBuf {
    cfg.user_cowork_dir.join("config/marketplaces.json")
}

fn read_json(path: &Path) -> Value {
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

/// Mirrors TS `readPersistedMarketplaces` + `normalizePersistedEntry` over a written document:
/// returns the `(id, repo, ref, marketplacePath, addedAt)` tuples TS would list.
fn ts_view(doc: &Value) -> Vec<(String, String, String, String, String)> {
    assert_eq!(doc["version"], json!(1), "{doc}");
    doc["marketplaces"]
        .as_array()
        .expect("marketplaces array")
        .iter()
        .map(|entry| {
            let field = |k: &str| {
                entry[k]
                    .as_str()
                    .unwrap_or_else(|| panic!("TS field {k} must be a string: {entry}"))
                    .to_owned()
            };
            let repo = field("repo");
            (
                repo.trim().to_lowercase(),
                repo,
                field("ref"),
                field("marketplacePath"),
                field("addedAt"),
            )
        })
        .collect()
}

fn listed(
    entries: &[cowork_harness::extensions::MarketplaceCatalogEntry],
) -> Vec<(String, String, bool, Option<String>)> {
    entries
        .iter()
        .map(|m| (m.id.clone(), m.repo.clone(), m.built_in, m.added_at.clone()))
        .collect()
}

#[tokio::test]
async fn legacy_ts_registry_without_ids_lists_user_marketplaces() {
    let fx = fixture(HashMap::new());
    fs::write(registry_path(&fx.cfg), LEGACY_TS_FILE).unwrap();
    let ext = ExtensionManager::new(fx.env.clone());

    let list = ext.read_marketplaces(&fx.cfg).await.unwrap();
    assert_eq!(
        listed(&list),
        vec![
            (
                "mweinbach/cowork-skills-plugins".to_owned(),
                "mweinbach/cowork-skills-plugins".to_owned(),
                true,
                None
            ),
            (
                "acme/skills".to_owned(),
                "acme/skills".to_owned(),
                false,
                Some("2026-03-01T10:00:00.000Z".to_owned())
            ),
        ]
    );
    assert_eq!(list[1].git_ref, "main");
    assert_eq!(list[1].marketplace_path, ".agents/plugins/marketplace.json");
    // Listing never rewrites the file.
    assert_eq!(
        fs::read_to_string(registry_path(&fx.cfg)).unwrap(),
        LEGACY_TS_FILE
    );
}

#[tokio::test]
async fn invalid_registry_elements_are_skipped_individually_with_ts_dedupe() {
    let fx = fixture(HashMap::new());
    fs::write(
        registry_path(&fx.cfg),
        serde_json::to_string(&json!({
            "version": 1,
            "marketplaces": [
                { "repo": "  Acme/Skills  ", "ref": " dev ", "marketplacePath": " ", "addedAt": "2026-03-01T10:00:00.000Z" },
                { "repo": "acme/skills", "ref": "main" },
                { "repo": "MWeinbach/Cowork-Skills-Plugins" },
                { "repo": "not a slug" },
                { "repo": 42 },
                "acme/stringly",
                null,
                { "id": "ignored-id", "repo": "Other/Market", "builtIn": true },
                { "id": "zeta/rust", "repo": "zeta/rust", "ref": "v2", "marketplacePath": "m.json", "builtIn": false, "addedAt": "2026-04-01T00:00:00+00:00" }
            ]
        }))
        .unwrap(),
    )
    .unwrap();
    let ext = ExtensionManager::new(fx.env.clone());

    let list = ext.read_marketplaces(&fx.cfg).await.unwrap();
    assert_eq!(
        listed(&list),
        vec![
            (
                "mweinbach/cowork-skills-plugins".to_owned(),
                "mweinbach/cowork-skills-plugins".to_owned(),
                true,
                None
            ),
            (
                "acme/skills".to_owned(),
                "Acme/Skills".to_owned(),
                false,
                Some("2026-03-01T10:00:00.000Z".to_owned())
            ),
            (
                "other/market".to_owned(),
                "Other/Market".to_owned(),
                false,
                Some("1970-01-01T00:00:00.000Z".to_owned())
            ),
            (
                "zeta/rust".to_owned(),
                "zeta/rust".to_owned(),
                false,
                Some("2026-04-01T00:00:00+00:00".to_owned())
            ),
        ]
    );
    assert_eq!(list[1].git_ref, "dev");
    assert_eq!(list[1].marketplace_path, ".agents/plugins/marketplace.json");
    assert_eq!(list[2].git_ref, "main");
    assert_eq!(list[3].git_ref, "v2");
    assert_eq!(list[3].marketplace_path, "m.json");
}

#[tokio::test]
async fn add_preserves_legacy_entries_and_uses_ts_lowercase_ids() {
    let fx = fixture(loopback_github().await);
    let path = registry_path(&fx.cfg);
    fs::write(&path, LEGACY_TS_FILE).unwrap();
    let ext = ExtensionManager::new(fx.env.clone());

    let list = ext
        .add_marketplace(
            &fx.cfg,
            MarketplaceSourceInput {
                source: "https://github.com/Zeta/Tools".to_owned(),
                git_ref: None,
                marketplace_path: None,
            },
        )
        .await
        .unwrap();
    let ids: Vec<&str> = list.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(
        ids,
        vec![
            "mweinbach/cowork-skills-plugins",
            "acme/skills",
            "zeta/tools"
        ]
    );
    assert!(list.iter().all(|m| m.fetch_error.is_none()), "{list:?}");

    let written = read_json(&path);
    let view = ts_view(&written);
    assert_eq!(view.len(), 2);
    assert_eq!(
        view[0],
        (
            "acme/skills".to_owned(),
            "acme/skills".to_owned(),
            "main".to_owned(),
            ".agents/plugins/marketplace.json".to_owned(),
            "2026-03-01T10:00:00.000Z".to_owned()
        )
    );
    assert_eq!(view[1].0, "zeta/tools");
    assert_eq!(view[1].1, "Zeta/Tools");
    assert_eq!(view[1].2, "main");
    assert!(
        chrono::DateTime::parse_from_rfc3339(&view[1].4).is_ok() && view[1].4.ends_with('Z'),
        "addedAt must be a TS-style ISO timestamp: {}",
        view[1].4
    );
    // Rust additionally persists the derived (lowercased) id; TS ignores it.
    assert_eq!(written["marketplaces"][0]["id"], json!("acme/skills"));
    assert_eq!(written["marketplaces"][1]["id"], json!("zeta/tools"));

    // Lookups by id are case-insensitive like TS `marketplaceIdForRepo`.
    let detail = ext
        .read_marketplace_detail(&fx.cfg, "ZETA/tools")
        .await
        .unwrap();
    assert_eq!(detail.source.id, "zeta/tools");

    // Duplicates (any case) and the built-in marketplace are rejected without touching the file.
    let before = fs::read_to_string(&path).unwrap();
    for (source, needle) in [
        ("ACME/skills", "already configured"),
        ("Mweinbach/Cowork-Skills-Plugins", "built-in marketplace"),
    ] {
        let err = ext
            .add_marketplace(
                &fx.cfg,
                MarketplaceSourceInput {
                    source: source.to_owned(),
                    git_ref: None,
                    marketplace_path: None,
                },
            )
            .await
            .unwrap_err();
        assert!(err.contains(needle), "{source}: {err}");
    }
    assert_eq!(fs::read_to_string(&path).unwrap(), before);
}

#[tokio::test]
async fn remove_preserves_other_legacy_entries() {
    let fx = fixture(HashMap::new());
    let path = registry_path(&fx.cfg);
    fs::write(
        &path,
        r#"{"version":1,"marketplaces":[{"repo":"acme/skills","ref":"main","marketplacePath":".agents/plugins/marketplace.json","addedAt":"2026-03-01T10:00:00.000Z"},{"repo":"Beta/Market","ref":"release","marketplacePath":"custom/marketplace.json","addedAt":"2026-03-02T10:00:00.000Z"}]}"#,
    )
    .unwrap();
    let ext = ExtensionManager::new(fx.env.clone());

    let list = ext
        .remove_marketplace(&fx.cfg, "ACME/Skills")
        .await
        .unwrap();
    let ids: Vec<&str> = list.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(ids, vec!["mweinbach/cowork-skills-plugins", "beta/market"]);
    assert_eq!(
        ts_view(&read_json(&path)),
        vec![(
            "beta/market".to_owned(),
            "Beta/Market".to_owned(),
            "release".to_owned(),
            "custom/marketplace.json".to_owned(),
            "2026-03-02T10:00:00.000Z".to_owned()
        )]
    );

    let err = ext
        .remove_marketplace(&fx.cfg, "acme/skills")
        .await
        .unwrap_err();
    assert!(err.contains("not configured"), "{err}");
    let err = ext
        .remove_marketplace(&fx.cfg, "MWEINBACH/cowork-skills-plugins")
        .await
        .unwrap_err();
    assert!(err.contains("cannot be removed"), "{err}");
    assert_eq!(ts_view(&read_json(&path)).len(), 1);
}

#[tokio::test]
async fn unreadable_registry_is_never_clobbered() {
    let fx = fixture(loopback_github().await);
    let path = registry_path(&fx.cfg);
    let ext = ExtensionManager::new(fx.env.clone());

    for garbage in [
        r#"{"version":1,"marketplaces":[{"repo":"acme/skills""#,
        r#"{"version":2,"marketplaces":[{"repo":"acme/skills"}]}"#,
        r#"{"version":1,"marketplaces":{"repo":"acme/skills"}}"#,
        "[]",
    ] {
        fs::write(&path, garbage).unwrap();

        // Listing degrades to the built-in marketplace only.
        let list = ext.read_marketplaces(&fx.cfg).await.unwrap();
        assert_eq!(list.len(), 1, "{garbage}");
        assert!(list[0].built_in);

        let err = ext
            .add_marketplace(
                &fx.cfg,
                MarketplaceSourceInput {
                    source: "zeta/tools".to_owned(),
                    git_ref: None,
                    marketplace_path: None,
                },
            )
            .await
            .unwrap_err();
        assert!(err.contains("Invalid marketplace registry"), "{err}");
        let err = ext
            .remove_marketplace(&fx.cfg, "acme/skills")
            .await
            .unwrap_err();
        assert!(err.contains("Invalid marketplace registry"), "{err}");

        assert_eq!(fs::read_to_string(&path).unwrap(), garbage);
    }
}
