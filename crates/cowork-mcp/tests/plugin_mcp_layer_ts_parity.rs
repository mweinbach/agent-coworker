//! Plugin MCP layers match TS `readPluginLayers` (`src/mcp/configRegistry/layers.ts`):
//! disabled plugins contribute no layer, servers inherit `interface.composerIcon ?? logo`,
//! `pluginDisplayName` is populated on file summaries and catalog entries, and entries in a
//! plugin `servers` array get the same validation as `mcpServers` entries.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use cowork_config::{AgentConfig, LoadConfigOptions, load_config};
use cowork_mcp::{
    McpConfigSource, PluginScope, load_mcp_servers, mutate_plugin_overrides,
    read_mcp_servers_snapshot,
};
use serde_json::{Value, json};

struct Fixture {
    _tmp: tempfile::TempDir,
    ws: PathBuf,
    home: PathBuf,
    cfg: AgentConfig,
}

fn fixture() -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let base = fs::canonicalize(tmp.path()).unwrap();
    let home = base.join("home");
    let ws = base.join("ws");
    fs::create_dir_all(home.join(".cowork/config")).unwrap();
    fs::create_dir_all(ws.join(".cowork")).unwrap();
    fs::create_dir_all(base.join("builtin/config")).unwrap();
    let mut env = HashMap::new();
    env.insert("HOME".to_owned(), home.to_string_lossy().into_owned());
    env.insert(
        "COWORK_HOME_OVERRIDE".to_owned(),
        home.join(".cowork").to_string_lossy().into_owned(),
    );
    env.insert("COWORK_DISABLE_RUNTIME".to_owned(), "1".to_owned());
    env.insert("COWORK_RUNTIME_ALLOW_NETWORK".to_owned(), "0".to_owned());
    env.insert("AGENT_TRUST_WORKSPACE_MCP".to_owned(), "1".to_owned());
    let cfg = load_config(LoadConfigOptions {
        cwd: Some(ws.clone()),
        homedir: Some(home.clone()),
        built_in_dir: Some(base.join("builtin")),
        env: Some(env),
    })
    .unwrap();
    Fixture {
        _tmp: tmp,
        ws,
        home,
        cfg,
    }
}

fn write_json(path: &Path, value: &Value) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, serde_json::to_string_pretty(value).unwrap()).unwrap();
}

fn plugin(root: &Path, manifest: Value, mcp: Value) {
    write_json(&root.join(".cowork-plugin/plugin.json"), &manifest);
    write_json(&root.join(".mcp.json"), &mcp);
}

#[test]
fn disabled_workspace_plugin_does_not_shadow_enabled_user_plugin() {
    let fx = fixture();
    plugin(
        &fx.ws.join(".cowork/plugins/ws-tools"),
        json!({ "name": "ws-tools" }),
        json!({ "mcpServers": { "search": { "url": "https://ws.example/mcp" } } }),
    );
    plugin(
        &fx.home.join(".cowork/plugins/user-tools"),
        json!({ "name": "user-tools" }),
        json!({ "mcpServers": { "search": { "url": "https://user.example/mcp" } } }),
    );
    mutate_plugin_overrides(&fx.cfg, PluginScope::Workspace, |ov| {
        ov.plugins.insert(
            "ws-tools".to_owned(),
            cowork_mcp::PluginEnableOverride { enabled: false },
        );
    })
    .unwrap();

    let snapshot = read_mcp_servers_snapshot(&fx.cfg).unwrap();
    let search: Vec<_> = snapshot
        .servers
        .iter()
        .filter(|s| s.config.name == "search")
        .collect();
    assert_eq!(search.len(), 1);
    assert_eq!(search[0].plugin_id.as_deref(), Some("user-tools"));
    assert_eq!(search[0].config.enabled, Some(true));
    assert!(
        !snapshot
            .files
            .iter()
            .any(|f| f.plugin_id.as_deref() == Some("ws-tools")),
        "a disabled plugin contributes no MCP file: {:?}",
        snapshot.files
    );
    let loaded = load_mcp_servers(&fx.cfg, false, |_| {}).unwrap();
    assert_eq!(
        loaded
            .iter()
            .filter(|s| s.config.name == "search")
            .map(|s| s.config.transport.remote_url().unwrap().to_owned())
            .collect::<Vec<_>>(),
        vec!["https://user.example/mcp".to_owned()]
    );
}

#[test]
fn plugin_display_name_and_icon_are_inherited() {
    let fx = fixture();
    plugin(
        &fx.home.join(".cowork/plugins/acme"),
        json!({
            "name": "acme",
            "interface": { "displayName": "Acme Suite", "composerIcon": "./icon.svg", "logo": "./logo.png" }
        }),
        json!({ "mcpServers": {
            "plain": { "url": "https://acme.example/mcp" },
            "own-icon": { "url": "https://acme.example/other", "icon": "custom.png" }
        } }),
    );
    plugin(
        &fx.home.join(".cowork/plugins/logo-only"),
        json!({ "name": "logo-only", "interface": { "logo": "./logo.png" } }),
        json!({ "mcpServers": { "logo-srv": { "url": "https://logo.example/mcp" } } }),
    );

    let snapshot = read_mcp_servers_snapshot(&fx.cfg).unwrap();
    let by_name = |name: &str| {
        snapshot
            .servers
            .iter()
            .find(|s| s.config.name == name)
            .unwrap()
            .clone()
    };
    let plain = by_name("plain");
    assert_eq!(plain.plugin_display_name.as_deref(), Some("Acme Suite"));
    assert_eq!(plain.config.icon.as_deref(), Some("./icon.svg"));
    assert_eq!(
        by_name("own-icon").config.icon.as_deref(),
        Some("custom.png")
    );
    let logo = by_name("logo-srv");
    assert_eq!(logo.config.icon.as_deref(), Some("./logo.png"));
    // No `interface.displayName`: falls back to the manifest name.
    assert_eq!(logo.plugin_display_name.as_deref(), Some("logo-only"));

    let acme_file = snapshot
        .files
        .iter()
        .find(|f| f.source == McpConfigSource::Plugin && f.plugin_id.as_deref() == Some("acme"))
        .unwrap();
    assert_eq!(acme_file.plugin_display_name.as_deref(), Some("Acme Suite"));
}

#[test]
fn plugin_servers_array_entries_are_validated() {
    let fx = fixture();
    plugin(
        &fx.home.join(".cowork/plugins/arr"),
        json!({ "name": "arr" }),
        json!({ "servers": [
            { "name": "ok", "transport": { "type": "http", "url": "https://ok.example/mcp" } },
            { "name": "bad-scheme", "transport": { "type": "http", "url": "file:///etc/passwd" } },
            { "name": "  ", "transport": { "type": "http", "url": "https://x.example/mcp" } },
            { "name": "stdio-oauth", "transport": { "type": "stdio", "command": "node" },
              "auth": { "type": "oauth" } }
        ] }),
    );
    let snapshot = read_mcp_servers_snapshot(&fx.cfg).unwrap();
    let names: Vec<&str> = snapshot
        .servers
        .iter()
        .map(|s| s.config.name.as_str())
        .collect();
    assert_eq!(names, vec!["ok"], "warnings: {:?}", snapshot.warnings);
    assert_eq!(
        snapshot
            .warnings
            .iter()
            .filter(|w| w.contains("plugin \"arr\""))
            .count(),
        3,
        "{:?}",
        snapshot.warnings
    );
}
