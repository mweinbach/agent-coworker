//! `plugins.json` (user `~/.cowork/config/plugins.json`, workspace `.cowork/plugins.json`) must
//! decode every document the TypeScript app wrote (`src/plugins/overrides.ts`) and must write
//! exactly the TS v2 shape back.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use cowork_config::{AgentConfig, LoadConfigOptions, load_config};
use cowork_mcp::plugin_overrides::{
    PluginEnableOverride, PluginOverridesFile, PluginScope, discover_installed_plugin_roots,
    mutate_plugin_overrides, normalize_plugin_overrides_document, plugin_mcp_override_key,
    plugin_overrides_path, plugin_skill_override_key, read_plugin_overrides,
};
use serde_json::{Value, json};

struct Fixture {
    _tmp: tempfile::TempDir,
    cfg: AgentConfig,
}

fn fixture() -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("home");
    let ws = tmp.path().join("ws");
    fs::create_dir_all(home.join(".cowork/config")).unwrap();
    fs::create_dir_all(ws.join(".cowork")).unwrap();
    fs::create_dir_all(tmp.path().join("builtin")).unwrap();
    let mut env = HashMap::new();
    env.insert("HOME".to_owned(), home.to_string_lossy().into_owned());
    env.insert(
        "COWORK_HOME_OVERRIDE".to_owned(),
        home.join(".cowork").to_string_lossy().into_owned(),
    );
    env.insert("COWORK_DISABLE_RUNTIME".to_owned(), "1".to_owned());
    env.insert("COWORK_RUNTIME_ALLOW_NETWORK".to_owned(), "0".to_owned());
    let cfg = load_config(LoadConfigOptions {
        cwd: Some(ws.clone()),
        homedir: Some(home),
        built_in_dir: Some(tmp.path().join("builtin")),
        env: Some(env),
    })
    .unwrap();
    Fixture { _tmp: tmp, cfg }
}

fn write_json(path: &Path, value: &Value) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, serde_json::to_string_pretty(value).unwrap()).unwrap();
}

fn read_json(path: &Path) -> Value {
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

fn ov(enabled: bool) -> PluginEnableOverride {
    PluginEnableOverride { enabled }
}

/// Asserts `doc` has exactly the TS `PluginOverrideDocument` v2 shape: every override map is
/// `Record<string, boolean>` with trimmed keys and tombstones are `Record<string, true>`.
fn assert_ts_v2_shape(doc: &Value) {
    let obj = doc.as_object().expect("document is an object");
    assert_eq!(obj.get("version"), Some(&json!(2)), "{doc}");
    assert!(
        obj.get("updatedAt")
            .and_then(Value::as_str)
            .is_some_and(|s| chrono::DateTime::parse_from_rfc3339(s).is_ok()),
        "updatedAt must be an ISO timestamp: {doc}"
    );
    for key in ["plugins", "skills", "mcpServers", "removedDefaultPlugins"] {
        let map = obj
            .get(key)
            .and_then(Value::as_object)
            .unwrap_or_else(|| panic!("{key} must be an object: {doc}"));
        for (k, v) in map {
            assert_eq!(k.trim(), k, "{key} key must be trimmed: {doc}");
            assert!(v.is_boolean(), "{key}.{k} must be a boolean: {doc}");
            if key == "removedDefaultPlugins" {
                assert_eq!(v, &json!(true), "{doc}");
            }
        }
    }
}

#[test]
fn reads_ts_v2_document_with_boolean_maps_and_tombstone_record() {
    let fx = fixture();
    let path = plugin_overrides_path(&fx.cfg, PluginScope::User);
    write_json(
        &path,
        &json!({
            "version": 2,
            "updatedAt": "2026-03-01T10:00:00.000Z",
            "plugins": { "foo": false, " bar ": true, "bad": "false", "": false },
            "skills": { "foo:review": false },
            "mcpServers": { "foo:github": false, "foo:slack": true },
            "removedDefaultPlugins": {
                "mweinbach/cowork-skills-plugins:docx": true,
                "workspace-tools": true
            }
        }),
    );

    let doc = read_plugin_overrides(&fx.cfg, PluginScope::User);
    assert_eq!(doc.version, 2);
    assert_eq!(doc.updated_at.as_deref(), Some("2026-03-01T10:00:00.000Z"));
    assert_eq!(
        doc.plugins.into_iter().collect::<Vec<_>>(),
        vec![("bar".to_owned(), ov(true)), ("foo".to_owned(), ov(false))]
    );
    assert_eq!(doc.skills.get("foo:review"), Some(&ov(false)));
    assert_eq!(doc.mcp_servers.get("foo:github"), Some(&ov(false)));
    assert_eq!(doc.mcp_servers.get("foo:slack"), Some(&ov(true)));
    // TS `normalizeDefaultPluginTombstones` keeps only ids that name a default plugin.
    assert_eq!(doc.removed_default_plugins, vec!["workspace-tools"]);
}

#[test]
fn reads_exact_legacy_v2_fixture() {
    let doc = normalize_plugin_overrides_document(&json!({
        "version": 2,
        "plugins": { "foo": false },
        "removedDefaultPlugins": { "mweinbach/cowork-skills-plugins:docx": true }
    }));
    assert_eq!(doc.plugins.get("foo"), Some(&ov(false)));
    assert!(doc.skills.is_empty() && doc.mcp_servers.is_empty());
    // Not a default marketplace plugin id, so TS drops this tombstone on read as well.
    assert!(doc.removed_default_plugins.is_empty());
}

#[test]
fn migrates_ts_v1_disabled_default_plugins_into_tombstones() {
    for version in [Some(json!(1)), None, Some(json!("2")), Some(json!(0))] {
        let mut raw = json!({
            "plugins": {
                "workspace-tools": false,
                "pdf": false,
                "documents": true,
                "foo": false
            },
            "skills": { " foo:review ": false, "foo:x": "nope" },
            "removedDefaultPlugins": { "spreadsheets": true, "presentations": false }
        });
        if let Some(v) = version.clone() {
            raw["version"] = v;
        }
        let doc = normalize_plugin_overrides_document(&raw);
        assert_eq!(doc.version, 2);
        assert_eq!(
            doc.plugins.into_iter().collect::<Vec<_>>(),
            vec![
                ("documents".to_owned(), ov(true)),
                ("foo".to_owned(), ov(false)),
            ],
            "version {version:?}"
        );
        assert_eq!(doc.removed_default_plugins, vec!["workspace-tools"]);
        assert_eq!(
            doc.skills.into_iter().collect::<Vec<_>>(),
            vec![("foo:review".to_owned(), ov(false))]
        );
    }

    // v2 documents are not migrated: a disabled default plugin is a plain override.
    let doc = normalize_plugin_overrides_document(&json!({
        "version": 2,
        "plugins": { "workspace-tools": false }
    }));
    assert_eq!(doc.plugins.get("workspace-tools"), Some(&ov(false)));
    assert!(doc.removed_default_plugins.is_empty());
}

#[test]
fn reads_documents_written_by_earlier_rust_builds() {
    let doc = normalize_plugin_overrides_document(&json!({
        "version": 2,
        "plugins": { "foo": { "enabled": false } },
        "skills": { "foo:review": { "enabled": true } },
        "mcpServers": { "foo:github": { "enabled": false } },
        "removedDefaultPlugins": ["workspace-tools", "bogus", "pdf"]
    }));
    assert_eq!(doc.plugins.get("foo"), Some(&ov(false)));
    assert_eq!(doc.skills.get("foo:review"), Some(&ov(true)));
    assert_eq!(doc.mcp_servers.get("foo:github"), Some(&ov(false)));
    assert_eq!(doc.removed_default_plugins, vec!["workspace-tools"]);
}

#[test]
fn writes_ts_v2_shape_and_migrates_on_rewrite() {
    let fx = fixture();
    let path = plugin_overrides_path(&fx.cfg, PluginScope::Workspace);
    // A TS v1 document plus a Rust-shaped entry; the rewrite must be pure TS v2.
    write_json(
        &path,
        &json!({
            "version": 1,
            "plugins": { "workspace-tools": false, "foo": { "enabled": true } },
            "mcpServers": { "foo:github": false }
        }),
    );

    mutate_plugin_overrides(&fx.cfg, PluginScope::Workspace, |doc| {
        doc.plugins.insert(" bar ".to_owned(), ov(false));
        doc.skills
            .insert(plugin_skill_override_key(" foo ", " review "), ov(false));
        doc.mcp_servers
            .insert(plugin_mcp_override_key("foo", "slack"), ov(true));
        doc.removed_default_plugins.push("presentations".to_owned());
        doc.removed_default_plugins.push("not-a-default".to_owned());
    })
    .unwrap();

    let written = read_json(&path);
    assert_ts_v2_shape(&written);
    let mut expected = written.clone();
    expected["updatedAt"] = Value::Null;
    assert_eq!(
        expected,
        json!({
            "version": 2,
            "updatedAt": null,
            "plugins": { "bar": false, "foo": true },
            "skills": { "foo:review": false },
            "mcpServers": { "foo:github": false, "foo:slack": true },
            "removedDefaultPlugins": { "workspace-tools": true }
        })
    );

    // What Rust wrote reads back identically through the TS normalization rules.
    let reread = read_plugin_overrides(&fx.cfg, PluginScope::Workspace);
    assert_eq!(reread, normalize_plugin_overrides_document(&written));
    assert_eq!(reread.plugins.get("bar"), Some(&ov(false)));
    assert_eq!(reread.removed_default_plugins, vec!["workspace-tools"]);

    // serde round-trip of the in-memory type is the same on-disk document.
    let value = serde_json::to_value(&reread).unwrap();
    assert_eq!(value, written);
    let back: PluginOverridesFile = serde_json::from_value(value).unwrap();
    assert_eq!(back, reread);
}

#[test]
fn mutate_refuses_to_clobber_unparseable_document() {
    let fx = fixture();
    let path = plugin_overrides_path(&fx.cfg, PluginScope::User);
    for garbage in ["{\"version\": 2, \"plugins\": {\"foo\": false", "[1, 2]"] {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, garbage).unwrap();

        let err = mutate_plugin_overrides(&fx.cfg, PluginScope::User, |doc| {
            doc.plugins.insert("bar".to_owned(), ov(false));
        })
        .unwrap_err();
        assert!(err.contains("plugin overrides"), "{err}");
        assert_eq!(fs::read_to_string(&path).unwrap(), garbage);
        // Lookups still degrade to "no overrides".
        assert_eq!(
            read_plugin_overrides(&fx.cfg, PluginScope::User),
            PluginOverridesFile::default()
        );
    }
}

#[test]
fn ts_written_workspace_overrides_disable_discovered_plugin() {
    let fx = fixture();
    let plugin_dir: PathBuf = fx.cfg.workspace_plugins_dir.join("foo");
    write_json(
        &plugin_dir.join(".cowork-plugin/plugin.json"),
        &json!({ "name": "foo", "description": "Foo plugin" }),
    );
    write_json(
        &fx.cfg
            .workspace_plugins_dir
            .join("bar/.cowork-plugin/plugin.json"),
        &json!({ "name": "bar" }),
    );
    write_json(
        &plugin_overrides_path(&fx.cfg, PluginScope::Workspace),
        &json!({
            "version": 2,
            "updatedAt": "2026-03-01T10:00:00.000Z",
            "plugins": { "foo": false },
            "skills": {},
            "mcpServers": {},
            "removedDefaultPlugins": {}
        }),
    );

    let (plugins, warnings) = discover_installed_plugin_roots(&fx.cfg);
    assert!(warnings.is_empty(), "{warnings:?}");
    let foo = plugins.iter().find(|p| p.id == "foo").unwrap();
    let bar = plugins.iter().find(|p| p.id == "bar").unwrap();
    assert!(!foo.enabled);
    assert!(bar.enabled);
}
