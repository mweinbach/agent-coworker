//! Workspace-scoped MCP files (`<ws>/.cowork/mcp-servers.json`, `.cowork/plugins.json`,
//! `.cowork/auth/mcp-credentials.json`) must never be read or written through a symbolic link
//! under the workspace `.cowork` directory: an untrusted repository could otherwise expose the
//! user's global MCP credentials, or make workspace disable/delete actions rewrite global files.
#![cfg(unix)]

use std::collections::HashMap;
use std::fs;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};

use cowork_config::{AgentConfig, LoadConfigOptions, load_config};
use cowork_mcp::{
    McpAuthScope, McpConfigSource, McpServerAuthConfig, McpServerConfig, McpServerTransport,
    PluginScope, delete_mcp_server, load_mcp_servers, read_credentials_for_scope,
    read_mcp_servers_snapshot, read_plugin_overrides, set_mcp_server_api_key,
    set_mcp_server_enabled, try_read_credentials_for_scope, upsert_mcp_server,
};
use serde_json::{Value, json};

struct Fixture {
    _tmp: tempfile::TempDir,
    home_cowork: PathBuf,
    ws_cowork: PathBuf,
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
        home_cowork: home.join(".cowork"),
        ws_cowork: ws.join(".cowork"),
        cfg,
    }
}

fn write_json(path: &Path, value: &Value) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, serde_json::to_string_pretty(value).unwrap()).unwrap();
}

fn api_key_server(name: &str) -> McpServerConfig {
    McpServerConfig {
        name: name.to_owned(),
        transport: McpServerTransport::Http {
            url: "https://mcp.example/mcp".to_owned(),
            headers: None,
        },
        enabled: None,
        required: None,
        retries: Some(0),
        auth: Some(McpServerAuthConfig::ApiKey {
            header_name: None,
            prefix: None,
            key_id: None,
        }),
        icon: None,
    }
}

/// The user's global credential store holds a secret for "shared"; the workspace `.cowork/auth`
/// is a link to the global `auth` directory.
fn link_workspace_auth_to_global(fx: &Fixture) {
    write_json(
        &fx.home_cowork.join("auth/mcp-credentials.json"),
        &json!({
            "version": 1,
            "servers": { "shared": { "apiKey": { "apiKey": "GLOBAL-SECRET", "updatedAt": 1 } } }
        }),
    );
    symlink(fx.home_cowork.join("auth"), fx.ws_cowork.join("auth")).unwrap();
}

#[test]
fn linked_workspace_credentials_are_not_read() {
    let fx = fixture();
    upsert_mcp_server(
        &fx.cfg,
        McpConfigSource::Workspace,
        api_key_server("shared"),
        None,
    )
    .unwrap();
    link_workspace_auth_to_global(&fx);

    assert!(
        read_credentials_for_scope(&fx.cfg, McpAuthScope::Workspace)
            .servers
            .is_empty()
    );
    let err = try_read_credentials_for_scope(&fx.cfg, McpAuthScope::Workspace).unwrap_err();
    assert!(err.contains("symbolic link"), "{err}");

    let snapshot = read_mcp_servers_snapshot(&fx.cfg).unwrap();
    let entry = snapshot
        .servers
        .iter()
        .find(|s| s.config.name == "shared")
        .unwrap();
    assert!(!entry.auth_state.has_stored_secret, "{entry:?}");

    let hydrated = load_mcp_servers(&fx.cfg, true, |_| {}).unwrap();
    let srv = hydrated.iter().find(|s| s.config.name == "shared").unwrap();
    let McpServerTransport::Http { headers, .. } = &srv.config.transport else {
        panic!("expected http");
    };
    assert!(
        !headers
            .as_ref()
            .is_some_and(|h| h.values().any(|v| v.contains("GLOBAL-SECRET"))),
        "global secret leaked into a workspace server: {headers:?}"
    );
}

#[test]
fn linked_workspace_credentials_are_not_written() {
    let fx = fixture();
    upsert_mcp_server(
        &fx.cfg,
        McpConfigSource::Workspace,
        api_key_server("shared"),
        None,
    )
    .unwrap();
    link_workspace_auth_to_global(&fx);
    let global = fx.home_cowork.join("auth/mcp-credentials.json");
    let before = fs::read_to_string(&global).unwrap();

    let err = set_mcp_server_api_key(
        &fx.cfg,
        "shared",
        Some(McpConfigSource::Workspace),
        None,
        None,
        "workspace-key",
    )
    .unwrap_err();
    assert!(err.contains("symbolic link"), "{err}");
    // Deleting the workspace server must not clean up the global record either.
    delete_mcp_server(&fx.cfg, McpConfigSource::Workspace, "shared").unwrap();
    assert_eq!(fs::read_to_string(&global).unwrap(), before);
}

#[test]
fn linked_workspace_mcp_servers_file_is_ignored_and_not_rewritten() {
    let fx = fixture();
    upsert_mcp_server(
        &fx.cfg,
        McpConfigSource::User,
        api_key_server("global-srv"),
        None,
    )
    .unwrap();
    let global = fx.home_cowork.join("config/mcp-servers.json");
    let before = fs::read_to_string(&global).unwrap();
    symlink(&global, fx.ws_cowork.join("mcp-servers.json")).unwrap();

    let snapshot = read_mcp_servers_snapshot(&fx.cfg).unwrap();
    let ws_file = snapshot
        .files
        .iter()
        .find(|f| f.source == McpConfigSource::Workspace)
        .unwrap();
    assert!(
        ws_file
            .parse_error
            .as_deref()
            .is_some_and(|e| e.contains("symbolic link")),
        "{ws_file:?}"
    );
    let entry = snapshot
        .servers
        .iter()
        .find(|s| s.config.name == "global-srv")
        .unwrap();
    assert_eq!(entry.source, McpConfigSource::User, "{entry:?}");

    let err = set_mcp_server_enabled(
        &fx.cfg,
        McpConfigSource::Workspace,
        "global-srv",
        false,
        None,
        None,
    )
    .unwrap_err();
    assert!(err.contains("symbolic link"), "{err}");
    let err = delete_mcp_server(&fx.cfg, McpConfigSource::Workspace, "global-srv").unwrap_err();
    assert!(err.contains("symbolic link"), "{err}");
    assert_eq!(fs::read_to_string(&global).unwrap(), before);
}

#[test]
fn linked_workspace_plugin_overrides_are_ignored_and_not_rewritten() {
    let fx = fixture();
    let global = fx.home_cowork.join("config/plugins.json");
    write_json(
        &global,
        &json!({ "version": 2, "plugins": { "p": false }, "skills": {}, "mcpServers": {} }),
    );
    let before = fs::read_to_string(&global).unwrap();
    symlink(&global, fx.ws_cowork.join("plugins.json")).unwrap();

    assert!(
        read_plugin_overrides(&fx.cfg, PluginScope::Workspace)
            .plugins
            .is_empty()
    );
    assert!(
        !read_plugin_overrides(&fx.cfg, PluginScope::User)
            .plugins
            .is_empty()
    );
    let err = set_mcp_server_enabled(
        &fx.cfg,
        McpConfigSource::Plugin,
        "srv",
        false,
        Some("p"),
        Some("workspace"),
    )
    .unwrap_err();
    assert!(err.contains("symbolic link"), "{err}");
    assert_eq!(fs::read_to_string(&global).unwrap(), before);
}

#[test]
fn linked_workspace_cowork_dir_is_refused() {
    let fx = fixture();
    write_json(
        &fx.home_cowork.join("auth/mcp-credentials.json"),
        &json!({
            "version": 1,
            "servers": { "shared": { "apiKey": { "apiKey": "GLOBAL-SECRET", "updatedAt": 1 } } }
        }),
    );
    fs::remove_dir_all(&fx.ws_cowork).unwrap();
    symlink(&fx.home_cowork, &fx.ws_cowork).unwrap();
    assert!(
        read_credentials_for_scope(&fx.cfg, McpAuthScope::Workspace)
            .servers
            .is_empty()
    );
    // The user tier itself is unaffected.
    assert!(
        read_credentials_for_scope(&fx.cfg, McpAuthScope::User)
            .servers
            .contains_key("shared")
    );
}
