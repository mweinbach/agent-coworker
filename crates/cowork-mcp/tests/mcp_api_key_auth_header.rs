//! API-key MCP auth must build the same header the TypeScript resolver did
//! (`src/mcp/authStore/resolver.ts`): the configured prefix is trimmed and joined to the key
//! with one space, and the config parser trims `prefix`/`headerName` like the TS zod schema.

use std::collections::HashMap;
use std::fs;

use cowork_config::{AgentConfig, LoadConfigOptions, load_config};
use cowork_mcp::registry::{load_mcp_servers, read_mcp_servers_snapshot, set_mcp_server_api_key};
use cowork_mcp::types::{McpConfigSource, McpServerAuthConfig, McpServerTransport};
use serde_json::{Value, json};

struct Fixture {
    _tmp: tempfile::TempDir,
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
        homedir: Some(home),
        built_in_dir: Some(tmp.path().join("builtin")),
        env: Some(env),
    })
    .unwrap();
    Fixture { _tmp: tmp, cfg }
}

fn http_server(name: &str, auth: Value) -> Value {
    json!({
        "name": name,
        "transport": { "type": "http", "url": "https://mcp.example.test/mcp" },
        "auth": auth,
    })
}

/// Stores `secret` for every server, then returns each hydrated server's injected headers.
fn hydrated_headers(fx: &Fixture, names: &[&str]) -> HashMap<String, HashMap<String, String>> {
    for name in names {
        set_mcp_server_api_key(
            &fx.cfg,
            name,
            Some(McpConfigSource::User),
            None,
            None,
            "secret",
        )
        .unwrap();
    }
    load_mcp_servers(&fx.cfg, false, |_| {})
        .unwrap()
        .into_iter()
        .map(|srv| {
            let headers = match srv.config.transport {
                McpServerTransport::Http { headers, .. }
                | McpServerTransport::Sse { headers, .. } => headers.unwrap_or_default(),
                McpServerTransport::Stdio { .. } => HashMap::new(),
            };
            (srv.config.name, headers.into_iter().collect())
        })
        .collect()
}

#[test]
fn configured_prefix_is_joined_to_the_api_key_with_a_space() {
    let fx = fixture(json!([
        http_server("bearer", json!({ "type": "api_key", "prefix": "Bearer" })),
        http_server(
            "bearer-trailing",
            json!({ "type": "api_key", "prefix": "Bearer " })
        ),
        http_server("default", json!({ "type": "api_key" })),
        http_server(
            "custom-header",
            json!({ "type": "api_key", "headerName": "X-API-Key" })
        ),
        http_server(
            "custom-header-prefix",
            json!({ "type": "api_key", "headerName": " X-API-Key ", "prefix": " Token " })
        ),
    ]));
    let headers = hydrated_headers(
        &fx,
        &[
            "bearer",
            "bearer-trailing",
            "default",
            "custom-header",
            "custom-header-prefix",
        ],
    );

    let one = |name: &str| -> (String, String) {
        let map = &headers[name];
        assert_eq!(map.len(), 1, "{name}: {map:?}");
        map.iter()
            .next()
            .map(|(k, v)| (k.clone(), v.clone()))
            .unwrap()
    };
    let pair = |k: &str, v: &str| (k.to_owned(), v.to_owned());
    assert_eq!(one("bearer"), pair("Authorization", "Bearer secret"));
    assert_eq!(
        one("bearer-trailing"),
        pair("Authorization", "Bearer secret")
    );
    assert_eq!(one("default"), pair("Authorization", "Bearer secret"));
    assert_eq!(one("custom-header"), pair("X-API-Key", "secret"));
    assert_eq!(
        one("custom-header-prefix"),
        pair("X-API-Key", "Token secret")
    );
}

#[test]
fn parser_trims_prefix_and_rejects_empty_or_whitespace_prefix_like_ts() {
    let fx = fixture(json!([
        http_server(
            "trimmed",
            json!({ "type": "api_key", "prefix": "  Bearer  " })
        ),
        http_server("empty", json!({ "type": "api_key", "prefix": "" })),
        http_server("blank", json!({ "type": "api_key", "prefix": "   " })),
    ]));
    let snapshot = read_mcp_servers_snapshot(&fx.cfg).unwrap();

    let names: Vec<&str> = snapshot
        .servers
        .iter()
        .map(|s| s.config.name.as_str())
        .collect();
    assert_eq!(names, vec!["trimmed"]);
    let trimmed = load_mcp_servers(&fx.cfg, false, |_| {}).unwrap();
    assert_eq!(
        trimmed[0].config.auth,
        Some(McpServerAuthConfig::ApiKey {
            header_name: None,
            prefix: Some("Bearer".to_owned()),
            key_id: None,
        })
    );
    for rejected in ["empty", "blank"] {
        assert!(
            snapshot
                .warnings
                .iter()
                .any(|w| w.contains(&format!("\"{rejected}\" auth.prefix must not be empty"))),
            "{rejected}: {:?}",
            snapshot.warnings
        );
    }
}
