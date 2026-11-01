//! Regression: plugins installed by the TypeScript harness carry the legacy install sidecar
//! `{ "marketplace": { "name", "sourceInput", "sourceHash", ... } }` (no `version` / timestamps /
//! `source`). They must still be treated as managed marketplace installs that can check for and
//! apply updates from their recorded `sourceInput`, and an update rewrites the current format.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use cowork_config::{AgentConfig, LoadConfigOptions, load_config};
use cowork_harness::extensions::ExtensionManager;
use serde_json::{Value, json};

struct Fixture {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    cfg: AgentConfig,
    env: HashMap<String, String>,
}

fn fixture() -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(tmp.path()).unwrap();
    let home = root.join("home");
    let ws = root.join("ws");
    fs::create_dir_all(home.join(".cowork/config")).unwrap();
    fs::create_dir_all(&ws).unwrap();
    fs::create_dir_all(root.join("builtin/skills")).unwrap();
    let mut env = HashMap::new();
    env.insert("HOME".to_owned(), home.to_string_lossy().into_owned());
    env.insert(
        "COWORK_HOME_OVERRIDE".to_owned(),
        home.join(".cowork").to_string_lossy().into_owned(),
    );
    env.insert("COWORK_DISABLE_RUNTIME".to_owned(), "1".to_owned());
    env.insert("COWORK_RUNTIME_ALLOW_NETWORK".to_owned(), "0".to_owned());
    let cfg = load_config(LoadConfigOptions {
        cwd: Some(ws),
        homedir: Some(home),
        built_in_dir: Some(root.join("builtin")),
        env: Some(env.clone()),
    })
    .unwrap();
    Fixture {
        _tmp: tmp,
        root,
        cfg,
        env,
    }
}

fn write_plugin(dir: &Path, payload: &str) {
    fs::create_dir_all(dir.join(".cowork-plugin")).unwrap();
    fs::write(
        dir.join(".cowork-plugin/plugin.json"),
        json!({ "name": "acme-suite", "description": "Acme tools" }).to_string(),
    )
    .unwrap();
    fs::write(dir.join("payload.txt"), payload).unwrap();
}

#[tokio::test]
async fn legacy_marketplace_install_metadata_stays_managed_and_updates_to_current_format() {
    let fx = fixture();
    let ext = ExtensionManager::new(fx.env.clone());

    // Marketplace source with newer content than the installed copy.
    let source = fx.root.join("marketplace/plugins/acme-suite");
    write_plugin(&source, "v2");
    let source_input = source.to_string_lossy().into_owned();

    // Installed by the TypeScript harness with its legacy sidecar schema.
    let installed = fx.cfg.user_plugins_dir.join("acme-suite");
    write_plugin(&installed, "v1");
    fs::write(
        installed.join(".cowork-plugin/install.json"),
        serde_json::to_string_pretty(&json!({
            "marketplace": {
                "name": "cowork-skills",
                "displayName": "Cowork Skills",
                "sourceInput": source_input,
                "sourceHash": "sha-installed-v1"
            }
        }))
        .unwrap(),
    )
    .unwrap();

    let (plugins, _) = ext.collect_installed_plugins(&fx.cfg);
    let entry = plugins
        .iter()
        .find(|p| p.name == "acme-suite")
        .expect("legacy plugin is listed");
    assert_eq!(entry.install_source.as_deref(), Some(source_input.as_str()));
    assert_eq!(
        entry.installed_source_hash.as_deref(),
        Some("sha-installed-v1")
    );
    let marketplace = entry.marketplace.as_ref().expect("marketplace metadata");
    assert_eq!(marketplace.name, "cowork-skills");
    assert_eq!(marketplace.display_name.as_deref(), Some("Cowork Skills"));
    assert_eq!(entry.discovery_kind, "marketplace");

    let check = ext
        .check_plugin_update(&fx.cfg, &entry.id, Some("user"))
        .await
        .expect("update check runs against the recorded marketplace source");
    assert!(check.can_update, "{check:?}");
    assert_eq!(
        check.installed_source_hash.as_deref(),
        Some("sha-installed-v1")
    );
    assert!(check.latest_source_hash.is_some());

    ext.update_plugin(&fx.cfg, &entry.id, Some("user"))
        .await
        .expect("legacy managed plugin updates");
    assert_eq!(
        fs::read_to_string(installed.join("payload.txt")).unwrap(),
        "v2"
    );
    let rewritten: Value = serde_json::from_str(
        &fs::read_to_string(installed.join(".cowork-plugin/install.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(rewritten["version"], json!(1));
    assert_eq!(rewritten["source"]["sourcePath"], json!(source_input));
    assert_eq!(rewritten["sourceHash"], check.latest_source_hash.unwrap());

    let (plugins, _) = ext.collect_installed_plugins(&fx.cfg);
    let entry = plugins.iter().find(|p| p.name == "acme-suite").unwrap();
    assert_eq!(entry.install_source.as_deref(), Some(source_input.as_str()));
}
