//! Regression tests for two TS-parity issues in the MCP registry/credential store.
//!
//! 1. The desktop (`apps/desktop/src/ui/settings/pages/mcpServerDraft.ts`) and mobile
//!    (`apps/mobile/src/features/cowork/mcpServerDraft.ts`) draft builders always emit
//!    `auth: { type: "none" }` for a server without auth, stdio included. The TS config
//!    parser (`src/mcp/configRegistry/parser.ts`) accepts it, so an explicit no-auth stdio
//!    server must be accepted on upsert and kept on load.
//! 2. TS `setMCPServerApiKeyCredential` (`src/mcp/authStore/editor.ts`) writes the record under
//!    `servers[server.name]` and keeps `auth.keyId` only as `apiKey.keyId` metadata, and
//!    `selectCredentialRecord` (`src/mcp/authStore/store.ts`) reads `servers[server.name]`.
//!    A `keyId` that differs from the server name must not change the lookup key.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use cowork_config::{AgentConfig, LoadConfigOptions, load_config};
use cowork_mcp::registry::{
    load_mcp_servers, read_mcp_servers_snapshot, set_mcp_server_api_key, upsert_mcp_server,
};
use cowork_mcp::types::{
    McpAuthMode, McpConfigSource, McpServerAuthConfig, McpServerConfig, McpServerTransport,
};
use serde_json::{Value, json};

struct Fixture {
    _tmp: tempfile::TempDir,
    home: PathBuf,
    cfg: AgentConfig,
}

fn fixture(servers: Value) -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("home");
    let ws = tmp.path().join("ws");
    fs::create_dir_all(home.join(".cowork/config")).unwrap();
    fs::create_dir_all(ws.join(".cowork")).unwrap();
    fs::create_dir_all(tmp.path().join("builtin")).unwrap();
    fs::write(
        home.join(".cowork/config/mcp-servers.json"),
        serde_json::to_string_pretty(&json!({ "servers": servers })).unwrap(),
    )
    .unwrap();
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
        built_in_dir: Some(tmp.path().join("builtin")),
        env: Some(env),
    })
    .unwrap();
    Fixture {
        _tmp: tmp,
        home,
        cfg,
    }
}

#[cfg(unix)]
#[test]
fn untrusted_workspace_discovery_rejects_a_pipe_without_consuming_it() {
    use std::io::{Read, Write, pipe};
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::symlink;

    let fx = fixture(json!([]));
    let (mut reader, mut writer) = pipe().unwrap();
    let document =
        r#"{"servers":[{"name":"from-pipe","transport":{"type":"stdio","command":"ignored"}}]}"#;
    writer.write_all(document.as_bytes()).unwrap();
    drop(writer);
    let path = fx.cfg.project_cowork_dir.join("mcp-servers.json");
    symlink(format!("/dev/fd/{}", reader.as_raw_fd()), &path).unwrap();

    let snapshot = read_mcp_servers_snapshot(&fx.cfg).unwrap();
    assert!(snapshot.servers.is_empty());
    assert!(
        snapshot
            .files
            .iter()
            .any(|file| file.source == McpConfigSource::Workspace && file.parse_error.is_some())
    );
    let mut unread = String::new();
    reader.read_to_string(&mut unread).unwrap();
    assert_eq!(unread, document);
}

#[cfg(unix)]
#[test]
fn listing_mcp_servers_does_not_chmod_the_target_of_a_workspace_credentials_link() {
    use std::os::unix::fs::{PermissionsExt, symlink};

    let fx = fixture(json!([]));
    let executable = fx.home.join("outside-workspace");
    fs::write(&executable, "#!/bin/sh\n").unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
    let auth_dir = fx.cfg.project_cowork_dir.join("auth");
    fs::create_dir_all(&auth_dir).unwrap();
    symlink(&executable, auth_dir.join("mcp-credentials.json")).unwrap();

    read_mcp_servers_snapshot(&fx.cfg).unwrap();

    assert_eq!(
        fs::metadata(&executable).unwrap().permissions().mode() & 0o777,
        0o755
    );
}

fn user_credentials_path(fx: &Fixture) -> PathBuf {
    fx.home.join(".cowork/auth/mcp-credentials.json")
}

fn write_user_credentials(fx: &Fixture, doc: Value) {
    let path = user_credentials_path(fx);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, serde_json::to_string_pretty(&doc).unwrap()).unwrap();
}

fn read_user_credentials(fx: &Fixture) -> Value {
    serde_json::from_str(&fs::read_to_string(user_credentials_path(fx)).unwrap()).unwrap()
}

fn stdio_server(name: &str, auth: Option<McpServerAuthConfig>) -> McpServerConfig {
    McpServerConfig {
        name: name.to_owned(),
        transport: McpServerTransport::Stdio {
            command: "node".to_owned(),
            args: Some(vec!["server.js".to_owned()]),
            env: None,
            cwd: None,
        },
        enabled: None,
        required: None,
        retries: None,
        auth,
        icon: None,
    }
}

fn injected_headers(fx: &Fixture, name: &str) -> HashMap<String, String> {
    let server = load_mcp_servers(&fx.cfg, false, |_| {})
        .unwrap()
        .into_iter()
        .find(|srv| srv.config.name == name)
        .unwrap_or_else(|| panic!("server {name} should load"));
    match server.config.transport {
        McpServerTransport::Http { headers, .. } | McpServerTransport::Sse { headers, .. } => {
            headers.unwrap_or_default()
        }
        McpServerTransport::Stdio { .. } => HashMap::new(),
    }
}

// ---- Finding 1: explicit `auth: { type: "none" }` on stdio servers ----

#[test]
fn upsert_accepts_stdio_server_with_explicit_no_auth() {
    let fx = fixture(json!([]));
    let snapshot = upsert_mcp_server(
        &fx.cfg,
        McpConfigSource::User,
        stdio_server("local-tools", Some(McpServerAuthConfig::None)),
        None,
    )
    .expect("stdio server with auth.type=none must be accepted");
    let entry = snapshot
        .servers
        .iter()
        .find(|s| s.config.name == "local-tools")
        .expect("upserted stdio server is listed");
    assert_eq!(entry.auth_mode, McpAuthMode::None);
    assert_eq!(entry.config.auth, Some(McpServerAuthConfig::None));

    // Editing the same server (desktop/mobile edit flow) also succeeds.
    upsert_mcp_server(
        &fx.cfg,
        McpConfigSource::User,
        stdio_server("local-tools-renamed", Some(McpServerAuthConfig::None)),
        Some("local-tools"),
    )
    .expect("editing a stdio server with auth.type=none must be accepted");
}

#[test]
fn ui_written_stdio_server_with_no_auth_is_loaded() {
    let fx = fixture(json!([{
        "name": "local-tools",
        "transport": { "type": "stdio", "command": "node", "args": ["server.js"] },
        "auth": { "type": "none" },
    }]));
    let loaded = load_mcp_servers(&fx.cfg, false, |_| {}).unwrap();
    assert!(
        loaded.iter().any(|srv| srv.config.name == "local-tools"),
        "stdio server with auth.type=none must not be skipped on load"
    );
    let snapshot = read_mcp_servers_snapshot(&fx.cfg).unwrap();
    assert!(
        snapshot
            .servers
            .iter()
            .any(|s| s.config.name == "local-tools"),
        "stdio server with auth.type=none must appear in the snapshot"
    );
}

#[test]
fn stdio_server_with_http_auth_is_still_rejected() {
    let fx = fixture(json!([]));
    for auth in [
        McpServerAuthConfig::ApiKey {
            header_name: None,
            prefix: None,
            key_id: None,
        },
        McpServerAuthConfig::OAuth {
            scope: None,
            resource: None,
            oauth_mode: None,
        },
    ] {
        let err = upsert_mcp_server(
            &fx.cfg,
            McpConfigSource::User,
            stdio_server("local-tools", Some(auth)),
            None,
        )
        .expect_err("stdio server with api_key/oauth auth must be rejected");
        assert!(err.contains("cannot configure HTTP/OAuth auth"), "{err}");
    }
}

// ---- Finding 2: credential records stay keyed by server name ----

fn api_key_server_with_key_id(name: &str, key_id: &str) -> Value {
    json!({
        "name": name,
        "transport": { "type": "http", "url": "https://mcp.example.test/mcp" },
        "auth": { "type": "api_key", "keyId": key_id },
    })
}

#[test]
fn existing_ts_credential_is_found_by_server_name_not_key_id() {
    let fx = fixture(json!([api_key_server_with_key_id("github-prod", "github")]));
    // Record as written by TS `setMCPServerApiKeyCredential`: keyed by server name,
    // keyId kept as metadata.
    write_user_credentials(
        &fx,
        json!({
            "version": 1,
            "updatedAt": "2025-03-04T05:06:07.890Z",
            "servers": {
                "github-prod": {
                    "apiKey": {
                        "value": "prod-token",
                        "keyId": "github",
                        "updatedAt": "2025-03-04T05:06:07.890Z",
                    }
                }
            }
        }),
    );

    let snapshot = read_mcp_servers_snapshot(&fx.cfg).unwrap();
    let entry = snapshot
        .servers
        .iter()
        .find(|s| s.config.name == "github-prod")
        .unwrap();
    assert_eq!(
        entry.auth_mode,
        McpAuthMode::ApiKey,
        "{}",
        entry.auth_message
    );
    assert!(entry.auth_state.has_stored_secret);

    assert_eq!(
        injected_headers(&fx, "github-prod")
            .get("Authorization")
            .map(String::as_str),
        Some("Bearer prod-token")
    );
}

#[test]
fn key_id_does_not_select_another_servers_credential() {
    let fx = fixture(json!([
        api_key_server_with_key_id("github-prod", "github"),
        {
            "name": "github",
            "transport": { "type": "http", "url": "https://mcp.example.test/other" },
            "auth": { "type": "api_key" },
        },
    ]));
    write_user_credentials(
        &fx,
        json!({
            "version": 1,
            "servers": {
                "github": { "apiKey": { "value": "other-server-token" } }
            }
        }),
    );

    let snapshot = read_mcp_servers_snapshot(&fx.cfg).unwrap();
    let prod = snapshot
        .servers
        .iter()
        .find(|s| s.config.name == "github-prod")
        .unwrap();
    assert_eq!(
        prod.auth_mode,
        McpAuthMode::Missing,
        "{}",
        prod.auth_message
    );
    assert!(!prod.auth_state.has_stored_secret);
    assert!(
        !injected_headers(&fx, "github-prod").contains_key("Authorization"),
        "github-prod must not borrow the `github` server's credential"
    );
}

#[test]
fn set_api_key_writes_under_server_name_with_key_id_metadata() {
    let fx = fixture(json!([api_key_server_with_key_id("github-prod", "github")]));
    set_mcp_server_api_key(
        &fx.cfg,
        "github-prod",
        Some(McpConfigSource::User),
        None,
        None,
        "  new-token  ",
    )
    .unwrap();

    let doc = read_user_credentials(&fx);
    let servers = doc["servers"].as_object().unwrap();
    assert!(
        !servers.contains_key("github"),
        "keyId must not be used as the record key: {doc}"
    );
    let api_key = &servers["github-prod"]["apiKey"];
    assert_eq!(api_key["apiKey"], "new-token");
    assert_eq!(api_key["keyId"], "github");

    assert_eq!(
        injected_headers(&fx, "github-prod")
            .get("Authorization")
            .map(String::as_str),
        Some("Bearer new-token")
    );
}

#[test]
fn set_api_key_without_key_id_omits_metadata() {
    let fx = fixture(json!([{
        "name": "plain",
        "transport": { "type": "http", "url": "https://mcp.example.test/mcp" },
        "auth": { "type": "api_key" },
    }]));
    set_mcp_server_api_key(
        &fx.cfg,
        "plain",
        Some(McpConfigSource::User),
        None,
        None,
        "tok",
    )
    .unwrap();
    let doc = read_user_credentials(&fx);
    let api_key = doc["servers"]["plain"]["apiKey"].as_object().unwrap();
    assert!(!api_key.contains_key("keyId"), "{doc}");
}

/// TS `McpAuthFlow.setApiKey` refuses before touching the credential store when the target is not
/// configured for API key auth: `ok:false`, mode `missing`, and no credential record.
#[test]
fn set_api_key_rejects_servers_not_configured_for_api_key_auth() {
    let fx = fixture(json!([
        {
            "name": "no-auth",
            "transport": { "type": "http", "url": "https://mcp.example.test/none" },
            "auth": { "type": "none" },
        },
        {
            "name": "oauth-srv",
            "transport": { "type": "http", "url": "https://mcp.example.test/oauth" },
            "auth": { "type": "oauth" },
        },
        {
            "name": "implicit",
            "transport": { "type": "stdio", "command": "node", "args": ["server.js"] },
        },
    ]));

    for name in ["no-auth", "oauth-srv", "implicit"] {
        let res = set_mcp_server_api_key(
            &fx.cfg,
            name,
            Some(McpConfigSource::User),
            None,
            None,
            "sk-should-not-be-stored",
        )
        .unwrap();
        assert!(!res.ok, "{name}: {res:?}");
        assert_eq!(res.mode, McpAuthMode::Missing, "{name}");
        assert_eq!(res.name, name);
        assert_eq!(res.source, McpConfigSource::User);
        assert_eq!(
            res.message,
            format!("MCP server \"{name}\" is not configured for API key auth.")
        );
    }

    assert!(
        !user_credentials_path(&fx).exists(),
        "no credential file may be created for non-API-key servers"
    );
    let snapshot = read_mcp_servers_snapshot(&fx.cfg).unwrap();
    for server in &snapshot.servers {
        assert!(
            !server.auth_state.has_stored_secret,
            "{} unexpectedly has a stored secret",
            server.config.name
        );
    }
}
