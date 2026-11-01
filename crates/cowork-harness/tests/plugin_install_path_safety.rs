//! Regression tests: a plugin manifest `name` must never let `cowork/plugins/install` write,
//! replace or delete anything outside the target plugins root.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use cowork_config::{AgentConfig, LoadConfigOptions, load_config};
use cowork_harness::extensions::{ExtensionManager, is_valid_plugin_name};

struct Fixture {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    home: PathBuf,
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
        homedir: Some(home.clone()),
        built_in_dir: Some(root.join("builtin")),
        env: Some(env.clone()),
    })
    .unwrap();
    Fixture {
        _tmp: tmp,
        root,
        home,
        cfg,
        env,
    }
}

fn write_plugin_bundle(dir: &Path, name: &str) {
    fs::create_dir_all(dir.join(".cowork-plugin")).unwrap();
    fs::write(
        dir.join(".cowork-plugin/plugin.json"),
        serde_json::json!({ "name": name, "description": "payload" }).to_string(),
    )
    .unwrap();
    fs::write(dir.join("payload.txt"), "attacker-controlled").unwrap();
}

#[test]
fn plugin_name_validation_matches_kebab_case_rule() {
    for ok in ["a", "acme-suite", "x1", "1-2-3"] {
        assert!(is_valid_plugin_name(ok), "{ok} should be valid");
    }
    for bad in [
        "",
        ".",
        "..",
        "../../.config/autostart",
        "a/b",
        "a\\b",
        "/abs",
        "Acme",
        "-a",
        "a-",
        "a--b",
        "a_b",
        "a.b",
        ".incoming-x",
    ] {
        assert!(!is_valid_plugin_name(bad), "{bad:?} should be rejected");
    }
}

#[tokio::test]
async fn user_scope_install_rejects_traversing_manifest_name() {
    let fx = fixture();
    let ext = ExtensionManager::new(fx.env.clone());

    // Victim directory outside ~/.cowork/plugins that the traversal would replace.
    let victim = fx.home.join(".config/autostart");
    fs::create_dir_all(&victim).unwrap();
    fs::write(victim.join("keep.desktop"), "victim").unwrap();

    let bundle = fx.root.join("bundle");
    write_plugin_bundle(&bundle, "../../.config/autostart");

    let err = ext
        .install_plugin(&fx.cfg, bundle.to_str().unwrap(), "user")
        .await
        .expect_err("traversing plugin name must be rejected");
    assert!(
        err.contains("Invalid plugin name"),
        "unexpected error: {err}"
    );

    // Victim untouched, no attacker payload anywhere outside the plugins root.
    assert_eq!(
        fs::read_to_string(victim.join("keep.desktop")).unwrap(),
        "victim"
    );
    assert!(!victim.join("payload.txt").exists());
    // No staging directories left behind next to the plugins root either.
    let plugins_root = &fx.cfg.user_plugins_dir;
    if plugins_root.exists() {
        assert_eq!(fs::read_dir(plugins_root).unwrap().count(), 0);
    }
    let home_cowork_entries: Vec<String> = fs::read_dir(fx.home.join(".cowork"))
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    assert!(
        !home_cowork_entries
            .iter()
            .any(|n| n.starts_with(".incoming")),
        "staging escaped plugins root: {home_cowork_entries:?}"
    );
}

#[tokio::test]
async fn install_rejects_other_unsafe_names_and_preview_flags_them() {
    let fx = fixture();
    let ext = ExtensionManager::new(fx.env.clone());
    for (i, name) in ["..", "/tmp/evil", "a/b", "Bad Name", "a\\..\\b"]
        .iter()
        .enumerate()
    {
        let bundle = fx.root.join(format!("bundle-{i}"));
        write_plugin_bundle(&bundle, name);
        let src = bundle.to_str().unwrap();

        let preview = ext
            .preview_plugin_install(&fx.cfg, src, "workspace")
            .await
            .unwrap();
        assert!(
            preview.candidates[0]
                .diagnostics
                .iter()
                .any(|d| d.code == "invalid_plugin_name" && d.severity == "error"),
            "preview should flag {name:?}"
        );
        for scope in ["user", "workspace"] {
            let err = ext
                .install_plugin(&fx.cfg, src, scope)
                .await
                .expect_err("unsafe plugin name must be rejected");
            assert!(err.contains("Invalid plugin name"), "{name:?}: {err}");
        }
    }
}

#[tokio::test]
async fn valid_plugin_name_still_installs_inside_plugins_root() {
    let fx = fixture();
    let ext = ExtensionManager::new(fx.env.clone());
    let bundle = fx.root.join("bundle-ok");
    write_plugin_bundle(&bundle, "acme-suite");
    ext.install_plugin(&fx.cfg, bundle.to_str().unwrap(), "user")
        .await
        .unwrap();
    let installed = fx.cfg.user_plugins_dir.join("acme-suite");
    assert_eq!(
        fs::read_to_string(installed.join("payload.txt")).unwrap(),
        "attacker-controlled"
    );
    assert!(installed.join(".cowork-plugin/install.json").is_file());
}
