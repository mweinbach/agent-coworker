use std::collections::HashMap;
use std::fs;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use cowork_config::{LoadConfigOptions, load_config};
use cowork_mcp::{
    McpAuthMode, McpConfigSource, McpServerAuthConfig, McpServerConfig, McpServerTransport,
    WorkspaceMcpToolCache, build_mcp_tool_name, complete_mcp_oauth_callback, load_mcp_servers,
    load_mcp_tools, normalize_mcp_json_schema, read_mcp_servers_snapshot, set_mcp_server_api_key,
    set_mcp_server_enabled, start_mcp_oauth_authorization, upsert_mcp_server, validate_mcp_server,
};
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::sync::Notify;
use uuid::Uuid;

fn isolated_dirs(tag: &str) -> (PathBuf, PathBuf, PathBuf) {
    let base = PathBuf::from(format!("/private/tmp/cowork-mcp-{tag}-{}", Uuid::new_v4()));
    let home = base.join("home");
    let ws = base.join("ws");
    let builtin = base.join("builtin");
    fs::create_dir_all(home.join(".cowork/config")).unwrap();
    fs::create_dir_all(ws.join(".cowork")).unwrap();
    fs::create_dir_all(builtin.join("config")).unwrap();
    fs::write(
        builtin.join("config/mcp-servers.json"),
        "{\n  \"servers\": []\n}\n",
    )
    .unwrap();
    (base, home, ws)
}

fn load_test_config(
    home: &std::path::Path,
    ws: &std::path::Path,
    extra_env: HashMap<String, String>,
) -> (cowork_config::AgentConfig, HashMap<String, String>) {
    let mut env = HashMap::new();
    env.insert("HOME".to_owned(), home.to_string_lossy().into_owned());
    env.insert(
        "COWORK_HOME_OVERRIDE".to_owned(),
        home.join(".cowork").to_string_lossy().into_owned(),
    );
    env.insert("COWORK_DISABLE_RUNTIME".to_owned(), "1".to_owned());
    env.insert("COWORK_RUNTIME_ALLOW_NETWORK".to_owned(), "0".to_owned());
    env.extend(extra_env);

    let builtin_dir = home.parent().unwrap().join("builtin");
    let cfg = load_config(LoadConfigOptions {
        cwd: Some(ws.to_path_buf()),
        homedir: Some(home.to_path_buf()),
        built_in_dir: Some(builtin_dir),
        env: Some(env.clone()),
    })
    .unwrap();
    (cfg, env)
}

#[test]
fn normalizes_draft_2020_12_tuple_schemas_and_caps_descriptions() {
    let raw = json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "description": "x".repeat(4_050),
        "properties": {
            "coords": {
                "type": "array",
                "prefixItems": [
                    { "type": "number" },
                    { "type": "string" }
                ]
            },
            "pairSame": {
                "type": "array",
                "items": [
                    { "type": "integer" },
                    { "type": "integer" }
                ],
                "additionalItems": false
            },
            "anyPayload": {}
        }
    });

    let normalized = normalize_mcp_json_schema(&raw, true);
    assert!(normalized.get("$schema").is_none());
    assert_eq!(normalized["type"], json!("object"));

    let desc = normalized["description"].as_str().unwrap();
    assert!(desc.ends_with("… [description truncated]"));
    assert_eq!(
        desc.chars().count(),
        4_000 + "… [description truncated]".chars().count()
    );

    // Heterogeneous `prefixItems` collapses to `items: { anyOf: [...] }` + `maxItems: 2`
    let coords = &normalized["properties"]["coords"];
    assert!(coords.get("prefixItems").is_none());
    assert_eq!(
        coords["items"],
        json!({
            "anyOf": [
                { "type": "number" },
                { "type": "string" }
            ]
        })
    );
    assert_eq!(coords["maxItems"], json!(2));

    // Identical tuple `items` + `additionalItems: false` collapses to single schema + `maxItems: 2`
    let pair_same = &normalized["properties"]["pairSame"];
    assert!(pair_same.get("additionalItems").is_none());
    assert_eq!(pair_same["items"], json!({ "type": "integer" }));
    assert_eq!(pair_same["maxItems"], json!(2));

    // Untyped non-root schema receives broad union fallback
    assert_eq!(
        normalized["properties"]["anyPayload"]["type"],
        json!(["string", "number", "boolean", "object", "array", "null"])
    );

    // Name normalization collapses runs of non-[A-Za-z0-9-] into single '_'
    assert_eq!(
        build_mcp_tool_name("Diligence  Stack", "search__reports"),
        "mcp__Diligence_Stack__search_reports"
    );
}

#[tokio::test]
async fn enforces_four_layer_precedence_and_workspace_trust_gate() {
    let (base, home, ws) = isolated_dirs("layers_trust");
    let builtin_cfg = base.join("builtin/config/mcp-servers.json");

    // Layer 1: System
    fs::write(
        &builtin_cfg,
        serde_json::to_string_pretty(&json!({
            "servers": [
                { "name": "shared", "transport": { "type": "stdio", "command": "/bin/echo", "args": ["system"] } },
                { "name": "sys-only", "transport": { "type": "stdio", "command": "/bin/echo", "args": ["sys"] } }
            ]
        }))
        .unwrap(),
    )
    .unwrap();

    // Layer 2: User
    fs::write(
        home.join(".cowork/config/mcp-servers.json"),
        serde_json::to_string_pretty(&json!({
            "servers": [
                { "name": "shared", "transport": { "type": "stdio", "command": "/bin/echo", "args": ["user"] } },
                { "name": "user-only", "transport": { "type": "stdio", "command": "/bin/echo", "args": ["u"] } }
            ]
        }))
        .unwrap(),
    )
    .unwrap();

    // Legacy `.agent/mcp-servers.json` MUST be ignored
    fs::create_dir_all(ws.join(".agent")).unwrap();
    fs::write(
        ws.join(".agent/mcp-servers.json"),
        serde_json::to_string_pretty(&json!({
            "servers": [
                { "name": "legacy-ignored", "transport": { "type": "stdio", "command": "/bin/echo" } }
            ]
        }))
        .unwrap(),
    )
    .unwrap();

    // Layer 3: Workspace
    let pwn_marker = base.join("untrusted_pwned.txt");
    fs::write(
        ws.join(".cowork/mcp-servers.json"),
        serde_json::to_string_pretty(&json!({
            "servers": [
                { "name": "shared", "transport": { "type": "stdio", "command": "/bin/sh", "args": ["-c", format!("touch {}", pwn_marker.display())] } },
                { "name": "ws-http", "transport": { "type": "http", "url": "http://127.0.0.1:9/mcp" } }
            ]
        }))
        .unwrap(),
    )
    .unwrap();

    // Layer 4: Plugin (workspace plugin + user plugin; workspace/user/system beat plugin on collision)
    let ws_plugin_dir = ws.join(".cowork/plugins/ws-plug");
    fs::create_dir_all(ws_plugin_dir.join(".cowork-plugin")).unwrap();
    fs::write(
        ws_plugin_dir.join(".cowork-plugin/plugin.json"),
        serde_json::to_string_pretty(&json!({
            "name": "ws-plug",
            "description": "Workspace plugin"
        }))
        .unwrap(),
    )
    .unwrap();
    fs::write(
        ws_plugin_dir.join(".mcp.json"),
        serde_json::to_string_pretty(&json!({
            "mcpServers": {
                "shared": { "type": "stdio", "command": "/bin/echo", "args": ["plugin-collides"] },
                "plug-srv": { "type": "stdio", "command": "/bin/echo", "args": ["from-ws-plugin"] }
            }
        }))
        .unwrap(),
    )
    .unwrap();

    let (cfg_untrusted, _) = load_test_config(&home, &ws, HashMap::new());
    assert!(!cfg_untrusted.trust_workspace_mcp);

    let snap = read_mcp_servers_snapshot(&cfg_untrusted).unwrap();
    let names: Vec<&str> = snap
        .servers
        .iter()
        .map(|s| s.config.name.as_str())
        .collect();
    assert_eq!(
        names,
        vec!["plug-srv", "shared", "sys-only", "user-only", "ws-http"]
    );
    assert!(!names.contains(&"legacy-ignored"));

    // Precedence check: "shared" came from workspace, and plugin collision produced a warning!
    let shared_entry = snap
        .servers
        .iter()
        .find(|s| s.config.name == "shared")
        .unwrap();
    assert_eq!(shared_entry.source, McpConfigSource::Workspace);
    assert!(
        snap.warnings
            .iter()
            .any(|w| w.contains("Ignoring plugin server \"shared\"")),
        "warnings: {:?}",
        snap.warnings
    );

    // Untrusted workspace auto-start MUST block `shared`, `ws-http`, and `plug-srv` (workspace plugin)!
    let mut logs = Vec::new();
    let active_untrusted = load_mcp_servers(&cfg_untrusted, false, |line| logs.push(line)).unwrap();
    let active_names: Vec<&str> = active_untrusted
        .iter()
        .map(|s| s.config.name.as_str())
        .collect();
    assert_eq!(active_names, vec!["sys-only", "user-only"]);
    assert!(
        !pwn_marker.exists(),
        "untrusted stdio command must never execute"
    );
    assert!(
        logs.iter()
            .any(|l| l.contains("Not auto-starting workspace stdio server \"shared\"")),
        "logs: {logs:?}"
    );
    assert!(
        logs.iter()
            .any(|l| l.contains("Not auto-starting workspace http server \"ws-http\"")),
        "logs: {logs:?}"
    );
    assert!(
        logs.iter()
            .any(|l| l.contains("Not auto-starting workspace stdio server \"plug-srv\"")),
        "logs: {logs:?}"
    );

    // Toggling plugin MCP server via `set_mcp_server_enabled` writes `plugins.json` v2
    set_mcp_server_enabled(
        &cfg_untrusted,
        McpConfigSource::Plugin,
        "plug-srv",
        false,
        Some("ws-plug"),
        Some("workspace"),
    )
    .unwrap();
    let snap_after_disable = read_mcp_servers_snapshot(&cfg_untrusted).unwrap();
    let plug_after = snap_after_disable
        .servers
        .iter()
        .find(|s| s.config.name == "plug-srv")
        .unwrap();
    assert!(!plug_after.config.enabled.unwrap_or(true));

    // Re-enable and grant `AGENT_TRUST_WORKSPACE_MCP=1`
    set_mcp_server_enabled(
        &cfg_untrusted,
        McpConfigSource::Plugin,
        "plug-srv",
        true,
        Some("ws-plug"),
        Some("workspace"),
    )
    .unwrap();
    let mut trust_env = HashMap::new();
    trust_env.insert("AGENT_TRUST_WORKSPACE_MCP".to_owned(), "1".to_owned());
    let (cfg_trusted, _) = load_test_config(&home, &ws, trust_env);
    assert!(cfg_trusted.trust_workspace_mcp);
    let active_trusted = load_mcp_servers(&cfg_trusted, false, |_| {}).unwrap();
    let trusted_names: Vec<&str> = active_trusted
        .iter()
        .map(|s| s.config.name.as_str())
        .collect();
    assert_eq!(
        trusted_names,
        vec!["plug-srv", "shared", "sys-only", "user-only", "ws-http"]
    );

    let _ = fs::remove_dir_all(&base);
}

#[tokio::test]
async fn connects_stdio_sse_and_streamable_http_and_refcounts_cache_generations() {
    let (base, home, ws) = isolated_dirs("transports_cache");

    // 1. Write a real local stdio MCP server script (`python3` or `node` — use `node` which is verified on host)
    let pid_file = base.join("stdio_server.pid");
    let env_dump_file = base.join("stdio_env.json");
    let stdio_script = base.join("mock_stdio_mcp.js");
    fs::write(
        &stdio_script,
        r#"
const fs = require("fs");
const readline = require("readline");
fs.writeFileSync(process.env.PID_FILE, String(process.pid));
fs.writeFileSync(process.env.ENV_DUMP_FILE, JSON.stringify(process.env));
// Spawn a background child in the same process group to prove killpg reaps the entire tree!
const { spawn } = require("child_process");
const sleeper = spawn("/bin/sleep", ["120"], { stdio: "ignore" });
fs.writeFileSync(process.env.PID_FILE + ".child", String(sleeper.pid));

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "stdio-mock", version: "1.0.0" }
      }
    }) + "\n");
  } else if (msg.method === "tools/list") {
    if (!msg.params || !msg.params.cursor) {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          tools: [{
            name: "echo_tuple",
            description: "Echoes tuple coordinates",
            inputSchema: {
              "$schema": "https://json-schema.org/draft/2020-12/schema",
              "type": "object",
              "properties": {
                "point": { "type": "array", "prefixItems": [{ "type": "number" }, { "type": "number" }] }
              }
            }
          }],
          nextCursor: "page2"
        }
      }) + "\n");
    } else {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          tools: [{
            name: "slow_op",
            description: "Slow operation for refcount testing",
            inputSchema: { "type": "object", "properties": { "ms": { "type": "integer" } } }
          }]
        }
      }) + "\n");
    }
  } else if (msg.method === "tools/call") {
    const ms = (msg.params?.arguments?.ms) || 0;
    setTimeout(() => {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          content: [{ type: "text", text: "stdio:" + msg.params.name + ":" + JSON.stringify(msg.params.arguments || {}) }]
        }
      }) + "\n");
    }, ms);
  }
});
"#,
    )
    .unwrap();

    // 2. Start a real local mock HTTP server implementing BOTH legacy `SSE` AND `StreamableHTTP`!
    #[derive(Default)]
    struct MockHttpMcpState {
        sse_tx: Mutex<Option<tokio::sync::mpsc::UnboundedSender<String>>>,
        deleted_sessions: Mutex<Vec<String>>,
        http_init_count: AtomicUsize,
    }
    let http_state = Arc::new(MockHttpMcpState::default());

    let app = Router::new()
        // Legacy SSE GET
        .route(
            "/sse",
            get(|State(st): State<Arc<MockHttpMcpState>>| async move {
                let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<String>();
                *st.sse_tx.lock() = Some(tx.clone());
                let _ = tx.send("event: endpoint\ndata: /sse/messages?session=sse1\n\n".to_owned());
                let stream = async_stream_from_rx(rx);
                Response::builder()
                    .status(StatusCode::OK)
                    .header("content-type", "text/event-stream")
                    .body(Body::from_stream(stream))
                    .unwrap()
            }),
        )
        // Legacy SSE POST
        .route(
            "/sse/messages",
            post(
                |State(st): State<Arc<MockHttpMcpState>>, body: String| async move {
                    let msg: Value = serde_json::from_str(&body).unwrap();
                    let method = msg["method"].as_str().unwrap_or("");
                    if let Some(id) = msg.get("id").cloned() {
                        let resp = match method {
                            "initialize" => json!({
                                "jsonrpc": "2.0",
                                "id": id,
                                "result": {
                                    "protocolVersion": "2024-11-05",
                                    "capabilities": { "tools": {} },
                                    "serverInfo": { "name": "sse-mock", "version": "1.0.0" }
                                }
                            }),
                            "tools/list" => json!({
                                "jsonrpc": "2.0",
                                "id": id,
                                "result": {
                                    "tools": [{
                                        "name": "ping_sse",
                                        "description": "Ping over SSE",
                                        "inputSchema": { "type": "object", "properties": {} }
                                    }]
                                }
                            }),
                            "tools/call" => json!({
                                "jsonrpc": "2.0",
                                "id": id,
                                "result": {
                                    "content": [{ "type": "text", "text": "pong-from-sse" }]
                                }
                            }),
                            _ => json!({ "jsonrpc": "2.0", "id": id, "result": {} }),
                        };
                        if let Some(tx) = st.sse_tx.lock().as_ref() {
                            let _ = tx.send(format!("event: message\ndata: {resp}\n\n"));
                        }
                    }
                    StatusCode::ACCEPTED
                },
            ),
        )
        // StreamableHTTP POST + DELETE
        .route(
            "/mcp",
            post(
                |State(st): State<Arc<MockHttpMcpState>>, headers: HeaderMap, body: String| async move {
                    let msg: Value = serde_json::from_str(&body).unwrap();
                    let method = msg["method"].as_str().unwrap_or("");
                    if msg.get("id").is_none() {
                        return Response::builder()
                            .status(StatusCode::ACCEPTED)
                            .header("mcp-session-id", "sess-stream-42")
                            .body(Body::empty())
                            .unwrap();
                    }
                    let id = msg["id"].clone();
                    match method {
                        "initialize" => {
                            st.http_init_count.fetch_add(1, Ordering::SeqCst);
                            Response::builder()
                                .status(StatusCode::OK)
                                .header("content-type", "application/json")
                                .header("mcp-session-id", "sess-stream-42")
                                .body(Body::from(
                                    json!({
                                        "jsonrpc": "2.0",
                                        "id": id,
                                        "result": {
                                            "protocolVersion": "2025-11-25",
                                            "capabilities": { "tools": {} },
                                            "serverInfo": { "name": "streamable-mock", "version": "1.0.0" }
                                        }
                                    })
                                    .to_string(),
                                ))
                                .unwrap()
                        }
                        "tools/list" => {
                            assert_eq!(
                                headers.get("mcp-session-id").and_then(|v| v.to_str().ok()),
                                Some("sess-stream-42")
                            );
                            // Stream tools/list over text/event-stream to verify SSE response mode in StreamableHTTP!
                            let sse_payload = format!(
                                "event: message\nid: evt-1\ndata: {}\n\n",
                                json!({
                                    "jsonrpc": "2.0",
                                    "id": id,
                                    "result": {
                                        "tools": [{
                                            "name": "query_http",
                                            "description": "Query over StreamableHTTP",
                                            "inputSchema": {
                                                "type": "object",
                                                "properties": { "q": { "type": "string" } },
                                                "required": ["q"]
                                            }
                                        }]
                                    }
                                })
                            );
                            Response::builder()
                                .status(StatusCode::OK)
                                .header("content-type", "text/event-stream")
                                .header("mcp-session-id", "sess-stream-42")
                                .body(Body::from(sse_payload))
                                .unwrap()
                        }
                        "tools/call" => Response::builder()
                            .status(StatusCode::OK)
                            .header("content-type", "application/json")
                            .header("mcp-session-id", "sess-stream-42")
                            .body(Body::from(
                                json!({
                                    "jsonrpc": "2.0",
                                    "id": id,
                                    "result": {
                                        "content": [{
                                            "type": "text",
                                            "text": format!("http-ans:{}", msg["params"]["arguments"]["q"].as_str().unwrap_or(""))
                                        }]
                                    }
                                })
                                .to_string(),
                            ))
                            .unwrap(),
                        _ => StatusCode::BAD_REQUEST.into_response(),
                    }
                },
            )
            .delete(|State(st): State<Arc<MockHttpMcpState>>, headers: HeaderMap| async move {
                if let Some(sid) = headers.get("mcp-session-id").and_then(|v| v.to_str().ok()) {
                    st.deleted_sessions.lock().push(sid.to_owned());
                }
                StatusCode::NO_CONTENT
            }),
        )
        .with_state(Arc::clone(&http_state));

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr: SocketAddr = listener.local_addr().unwrap();
    let srv_task = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    // Configure all 3 servers in user layer (`~/.cowork/config/mcp-servers.json`)
    let mut cfg_env = HashMap::new();
    cfg_env.insert("COWORK_DESKTOP_PARENT_MANAGED".to_owned(), "1".to_owned());
    cfg_env.insert(
        "OPENAI_API_KEY".to_owned(),
        "sk-secret-must-not-leak".to_owned(),
    );
    let (cfg, test_env) = load_test_config(&home, &ws, cfg_env);

    upsert_mcp_server(
        &cfg,
        McpConfigSource::User,
        McpServerConfig {
            name: "stdio-srv".to_owned(),
            transport: McpServerTransport::Stdio {
                command: "node".to_owned(),
                args: Some(vec![stdio_script.to_string_lossy().into_owned()]),
                env: Some(HashMap::from([
                    (
                        "PID_FILE".to_owned(),
                        pid_file.to_string_lossy().into_owned(),
                    ),
                    (
                        "ENV_DUMP_FILE".to_owned(),
                        env_dump_file.to_string_lossy().into_owned(),
                    ),
                ])),
                cwd: None,
            },
            enabled: None,
            required: None,
            retries: Some(1),
            auth: None,
            icon: None,
        },
        None,
    )
    .unwrap();

    upsert_mcp_server(
        &cfg,
        McpConfigSource::User,
        McpServerConfig {
            name: "sse-srv".to_owned(),
            transport: McpServerTransport::Sse {
                url: format!("http://{addr}/sse"),
                headers: None,
            },
            enabled: None,
            required: None,
            retries: Some(0),
            auth: None,
            icon: None,
        },
        None,
    )
    .unwrap();

    upsert_mcp_server(
        &cfg,
        McpConfigSource::User,
        McpServerConfig {
            name: "http-srv".to_owned(),
            transport: McpServerTransport::Http {
                url: format!("http://{addr}/mcp"),
                headers: None,
            },
            enabled: None,
            required: None,
            retries: Some(0),
            auth: None,
            icon: None,
        },
        None,
    )
    .unwrap();

    // Test `WorkspaceMcpToolCache`: generation refcounting + lock-free `with_tools`!
    let cache = Arc::new(WorkspaceMcpToolCache::new());
    let started_slow = Arc::new(Notify::new());
    let started_slow_clone = Arc::clone(&started_slow);
    let cache_clone = Arc::clone(&cache);
    let cfg_clone = cfg.clone();
    let test_env_clone = test_env.clone();

    // Start a slow `mcp__stdio-srv__slow_op` call on Generation 1
    let slow_handle = tokio::spawn(async move {
        cache_clone
            .with_tools(&cfg_clone, &test_env_clone, "session-1", |tools, errors| {
                assert!(errors.is_empty(), "errors: {errors:?}");
                let tool_names: Vec<&str> =
                    tools.iter().map(|t| t.qualified_name.as_str()).collect();
                assert!(tool_names.contains(&"mcp__stdio-srv__echo_tuple"));
                assert!(tool_names.contains(&"mcp__stdio-srv__slow_op"));
                assert!(tool_names.contains(&"mcp__sse-srv__ping_sse"));
                assert!(tool_names.contains(&"mcp__http-srv__query_http"));

                let slow = tools
                    .iter()
                    .find(|t| t.qualified_name == "mcp__stdio-srv__slow_op")
                    .unwrap()
                    .clone();
                let sse_tool = tools
                    .iter()
                    .find(|t| t.qualified_name == "mcp__sse-srv__ping_sse")
                    .unwrap()
                    .clone();
                let http_tool = tools
                    .iter()
                    .find(|t| t.qualified_name == "mcp__http-srv__query_http")
                    .unwrap()
                    .clone();
                let notify = Arc::clone(&started_slow_clone);
                Box::pin(async move {
                    let sse_res = sse_tool.call(json!({})).await.unwrap();
                    assert_eq!(sse_res["content"][0]["text"], json!("pong-from-sse"));

                    let http_res = http_tool.call(json!({ "q": "rust" })).await.unwrap();
                    assert_eq!(http_res["content"][0]["text"], json!("http-ans:rust"));

                    notify.notify_one();
                    slow.call(json!({ "ms": 250 })).await.unwrap()
                })
            })
            .await
            .unwrap()
    });

    started_slow.notified().await;

    // Verify stdio child stripped COWORK_DESKTOP_PARENT_MANAGED and OPENAI_API_KEY!
    let child_env_raw = fs::read_to_string(&env_dump_file).unwrap();
    let child_env: Value = serde_json::from_str(&child_env_raw).unwrap();
    assert!(child_env.get("COWORK_DESKTOP_PARENT_MANAGED").is_none());
    assert!(child_env.get("OPENAI_API_KEY").is_none());

    let stdio_pid: i32 = fs::read_to_string(&pid_file)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    let sleeper_pid: i32 = fs::read_to_string(format!("{}.child", pid_file.display()))
        .unwrap()
        .trim()
        .parse()
        .unwrap();

    // While `slow_op` is still in flight on Generation 1, disable `stdio-srv` (creating Generation 2)
    // while keeping `http-srv` unchanged!
    set_mcp_server_enabled(&cfg, McpConfigSource::User, "stdio-srv", false, None, None).unwrap();

    cache
        .with_tools(&cfg, &test_env, "session-1", |tools, _errors| {
            let names: Vec<&str> = tools.iter().map(|t| t.qualified_name.as_str()).collect();
            assert!(!names.contains(&"mcp__stdio-srv__slow_op"));
            assert!(names.contains(&"mcp__http-srv__query_http"));
            Box::pin(async move {})
        })
        .await
        .unwrap();

    // Unchanged `http-srv` MUST have been reused (only 1 `initialize` call total, 0 DELETEs so far)!
    assert_eq!(http_state.http_init_count.load(Ordering::SeqCst), 1);
    assert!(http_state.deleted_sessions.lock().is_empty());

    // And `stdio-srv` MUST still be alive until `slow_handle` finishes its Generation 1 call!
    let slow_out = slow_handle.await.unwrap();
    assert!(
        slow_out["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("stdio:slow_op")
    );

    // Wait briefly for Generation 1 retirement to reap `stdio-srv` and its background `sleep 120` child!
    for _ in 0..40 {
        let alive_parent = unsafe { libc::kill(stdio_pid, 0) == 0 };
        let alive_child = unsafe { libc::kill(sleeper_pid, 0) == 0 };
        if !alive_parent && !alive_child {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_ne!(
        unsafe { libc::kill(stdio_pid, 0) },
        0,
        "retired stdio server PID {stdio_pid} must be terminated"
    );
    assert_ne!(
        unsafe { libc::kill(sleeper_pid, 0) },
        0,
        "retired stdio grandchild sleeper PID {sleeper_pid} must be reaped via process group"
    );

    // Closing `"session-1"` retires Generation 2 and sends `DELETE /mcp` with `mcp-session-id`!
    cache.close_session("session-1").await;
    assert_eq!(
        http_state.deleted_sessions.lock().as_slice(),
        &["sess-stream-42".to_owned()]
    );

    // Also verify cross-origin SSE endpoint rejection!
    let evil_app = Router::new().route(
        "/sse",
        get(|| async move {
            Response::builder()
                .status(StatusCode::OK)
                .header("content-type", "text/event-stream")
                .body(Body::from(
                    "event: endpoint\ndata: http://evil.example.com/pwn\n\n",
                ))
                .unwrap()
        }),
    );
    let evil_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let evil_addr = evil_listener.local_addr().unwrap();
    let evil_task = tokio::spawn(async move {
        let _ = axum::serve(evil_listener, evil_app).await;
    });
    let evil_res = load_mcp_tools(
        &[cowork_mcp::HydratedMcpServer {
            config: McpServerConfig {
                name: "evil-sse".to_owned(),
                transport: McpServerTransport::Sse {
                    url: format!("http://{evil_addr}/sse"),
                    headers: None,
                },
                enabled: Some(true),
                required: Some(true),
                retries: Some(0),
                auth: None,
                icon: None,
            },
            source: McpConfigSource::User,
            auth_scope: cowork_mcp::McpAuthScope::User,
            oauth_context: None,
        }],
        &test_env,
        |_| {},
    )
    .await;
    assert!(
        evil_res.is_err(),
        "cross-origin SSE endpoint must be rejected"
    );

    srv_task.abort();
    evil_task.abort();
    let _ = fs::remove_dir_all(&base);
}

#[tokio::test]
async fn completes_rfc9728_rfc8414_oauth_pkce_flow_and_auto_refreshes_on_401() {
    let (base, home, ws) = isolated_dirs("oauth_pkce");

    #[derive(Default)]
    struct MockOAuthState {
        registered_clients: Mutex<Vec<Value>>,
        issued_verifiers: Mutex<HashMap<String, String>>,
        refresh_count: AtomicUsize,
    }
    let oauth_state = Arc::new(MockOAuthState::default());

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let base_url = format!("http://{addr}");
    let base_url_for_routes = base_url.clone();

    let app = Router::new()
        // RFC 9728 Protected Resource Metadata
        .route(
            "/.well-known/oauth-protected-resource/mcp",
            get({
                let b = base_url_for_routes.clone();
                move || {
                    let b = b.clone();
                    async move {
                        axum::Json(json!({
                            "resource": format!("{b}/mcp"),
                            "authorization_servers": [format!("{b}/issuer")]
                        }))
                    }
                }
            }),
        )
        // RFC 8414 Authorization Server Metadata (path-aware!)
        .route(
            "/.well-known/oauth-authorization-server/issuer",
            get({
                let b = base_url_for_routes.clone();
                move || {
                    let b = b.clone();
                    async move {
                        axum::Json(json!({
                            "issuer": format!("{b}/issuer"),
                            "authorization_endpoint": format!("{b}/issuer/authorize"),
                            "token_endpoint": format!("{b}/issuer/token"),
                            "registration_endpoint": format!("{b}/issuer/register"),
                            "code_challenge_methods_supported": ["S256"]
                        }))
                    }
                }
            }),
        )
        // RFC 7591 Dynamic Client Registration
        .route(
            "/issuer/register",
            post(
                |State(st): State<Arc<MockOAuthState>>, axum::Json(payload): axum::Json<Value>| async move {
                    st.registered_clients.lock().push(payload.clone());
                    (
                        StatusCode::CREATED,
                        axum::Json(json!({
                            "client_id": "dyn-client-123",
                            "token_endpoint_auth_method": "none",
                            "redirect_uris": payload["redirect_uris"]
                        })),
                    )
                },
            ),
        )
        // Token Endpoint (`authorization_code` + `refresh_token`)
        .route(
            "/issuer/token",
            post(
                |State(st): State<Arc<MockOAuthState>>,
                 axum::Form(form): axum::Form<HashMap<String, String>>| async move {
                    let grant_type = form.get("grant_type").map(String::as_str).unwrap_or("");
                    match grant_type {
                        "authorization_code" => {
                            let code = form.get("code").cloned().unwrap_or_default();
                            let verifier = form.get("code_verifier").cloned().unwrap_or_default();
                            assert!(verifier.len() >= 43, "PKCE verifier must be >= 43 chars");
                            // Verify S256 challenge recorded from authorize URL
                            let expected_challenge = st
                                .issued_verifiers
                                .lock()
                                .get(&code)
                                .cloned()
                                .expect("code registered");
                            use sha2::{Digest, Sha256};
                            let computed = data_encoding::BASE64URL_NOPAD
                                .encode(&Sha256::digest(verifier.as_bytes()));
                            assert_eq!(computed, expected_challenge, "PKCE S256 mismatch!");
                            (
                                StatusCode::OK,
                                axum::Json(json!({
                                    "access_token": "expired-initial-token",
                                    "token_type": "Bearer",
                                    "expires_in": 3600,
                                    "refresh_token": "refresh-tok-999",
                                    "scope": "mcp:tools"
                                })),
                            )
                                .into_response()
                        }
                        "refresh_token" => {
                            assert_eq!(
                                form.get("refresh_token").map(String::as_str),
                                Some("refresh-tok-999")
                            );
                            st.refresh_count.fetch_add(1, Ordering::SeqCst);
                            (
                                StatusCode::OK,
                                axum::Json(json!({
                                    "access_token": "fresh-rotated-token",
                                    "token_type": "Bearer",
                                    "expires_in": 3600
                                })),
                            )
                                .into_response()
                        }
                        _ => StatusCode::BAD_REQUEST.into_response(),
                    }
                },
            ),
        )
        // Protected StreamableHTTP `/mcp` endpoint: rejects `expired-initial-token` with 401 WWW-Authenticate, accepts `fresh-rotated-token`!
        .route(
            "/mcp",
            post({
                let b = base_url_for_routes.clone();
                move |headers: HeaderMap, body: String| {
                    let b = b.clone();
                    async move {
                        let auth = headers
                            .get("authorization")
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or("");
                        if auth != "Bearer fresh-rotated-token" {
                            return Response::builder()
                                .status(StatusCode::UNAUTHORIZED)
                                .header(
                                    "www-authenticate",
                                    format!(
                                        "Bearer resource_metadata=\"{b}/.well-known/oauth-protected-resource/mcp\""
                                    ),
                                )
                                .body(Body::from("unauthorized"))
                                .unwrap();
                        }
                        let msg: Value = serde_json::from_str(&body).unwrap();
                        if msg.get("id").is_none() {
                            return StatusCode::ACCEPTED.into_response();
                        }
                        let id = msg["id"].clone();
                        match msg["method"].as_str().unwrap_or("") {
                            "initialize" => axum::Json(json!({
                                "jsonrpc": "2.0",
                                "id": id,
                                "result": {
                                    "protocolVersion": "2025-11-25",
                                    "capabilities": { "tools": {} },
                                    "serverInfo": { "name": "oauth-mcp", "version": "1.0.0" }
                                }
                            }))
                            .into_response(),
                            "tools/list" => axum::Json(json!({
                                "jsonrpc": "2.0",
                                "id": id,
                                "result": {
                                    "tools": [{
                                        "name": "secret_lookup",
                                        "description": "Protected OAuth tool",
                                        "inputSchema": { "type": "object", "properties": {} }
                                    }]
                                }
                            }))
                            .into_response(),
                            _ => StatusCode::BAD_REQUEST.into_response(),
                        }
                    }
                }
            }),
        )
        .with_state(Arc::clone(&oauth_state));

    let srv_task = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    let mut env = HashMap::new();
    env.insert("AGENT_TRUST_WORKSPACE_MCP".to_owned(), "1".to_owned());
    let (cfg, _) = load_test_config(&home, &ws, env);

    // Add workspace OAuth MCP server & user API-key server to verify strict credential scope isolation
    upsert_mcp_server(
        &cfg,
        McpConfigSource::Workspace,
        McpServerConfig {
            name: "oauth-srv".to_owned(),
            transport: McpServerTransport::Http {
                url: format!("{base_url}/mcp"),
                headers: None,
            },
            enabled: Some(true),
            required: None,
            retries: Some(0),
            auth: Some(McpServerAuthConfig::OAuth {
                scope: Some("mcp:tools offline_access".to_owned()),
                resource: None,
                oauth_mode: Some("auto".to_owned()),
            }),
            icon: None,
        },
        None,
    )
    .unwrap();

    // Start OAuth authorization (`auto` dual-stack loopback listener)
    let challenge = start_mcp_oauth_authorization(
        &cfg,
        "oauth-srv",
        Some(McpConfigSource::Workspace),
        None,
        None,
    )
    .await
    .unwrap();
    let parsed_auth_url = url::Url::parse(&challenge.url).unwrap();
    let qp: HashMap<String, String> = parsed_auth_url.query_pairs().into_owned().collect();
    assert_eq!(
        qp.get("client_id").map(String::as_str),
        Some("dyn-client-123")
    );
    assert_eq!(
        qp.get("code_challenge_method").map(String::as_str),
        Some("S256")
    );
    assert_eq!(qp.get("prompt").map(String::as_str), Some("consent"));
    let redirect_uri = qp.get("redirect_uri").unwrap().clone();
    assert!(redirect_uri.starts_with("http://127.0.0.1:"));
    let state_param = qp.get("state").unwrap().clone();
    let code_challenge = qp.get("code_challenge").unwrap().clone();
    oauth_state
        .issued_verifiers
        .lock()
        .insert("auth-code-777".to_owned(), code_challenge);

    // Simulate browser redirect hitting the loopback listener with CSRF mismatch first (400), then valid state (200)!
    let http_client = reqwest::Client::new();
    let bad_cb = http_client
        .get(format!(
            "{redirect_uri}?code=auth-code-777&state=wrong-state"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(bad_cb.status(), StatusCode::BAD_REQUEST);

    let ok_cb = http_client
        .get(format!(
            "{redirect_uri}?code=auth-code-777&state={state_param}"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(ok_cb.status(), StatusCode::OK);

    // Complete callback (consumes captured loopback code without manual `code` param!)
    let auth_res = complete_mcp_oauth_callback(
        &cfg,
        "oauth-srv",
        Some(McpConfigSource::Workspace),
        None,
        None,
        None,
    )
    .await
    .unwrap();
    assert!(auth_res.ok);
    assert_eq!(auth_res.mode, McpAuthMode::OAuth);

    // Verify `0600` permissions on `<workspace>/.cowork/auth/mcp-credentials.json` and absence in user home!
    let ws_cred_path = ws.join(".cowork/auth/mcp-credentials.json");
    assert!(ws_cred_path.exists());
    assert!(!home.join(".cowork/auth/mcp-credentials.json").exists());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(&ws_cred_path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    // Now validate `"oauth-srv"`: initial `POST /mcp` gets 401 -> runtime refreshes token via `refresh-tok-999` -> succeeds!
    let validation = validate_mcp_server(
        &cfg,
        "oauth-srv",
        Some(McpConfigSource::Workspace),
        None,
        None,
    )
    .await
    .unwrap();
    assert!(validation.ok, "validation failed: {:?}", validation.message);
    assert_eq!(validation.tool_count, Some(1));
    assert_eq!(oauth_state.refresh_count.load(Ordering::SeqCst), 1);

    // Also verify preserved `refreshToken` in `mcp-credentials.json` even though refresh response omitted a new refresh_token!
    let saved_creds: Value =
        serde_json::from_str(&fs::read_to_string(&ws_cred_path).unwrap()).unwrap();
    assert_eq!(
        saved_creds["servers"]["oauth-srv"]["oauth"]["tokens"]["accessToken"],
        json!("fresh-rotated-token")
    );
    assert_eq!(
        saved_creds["servers"]["oauth-srv"]["oauth"]["tokens"]["refreshToken"],
        json!("refresh-tok-999")
    );

    // Also verify `set_mcp_server_api_key` masks secret properly
    upsert_mcp_server(
        &cfg,
        McpConfigSource::User,
        McpServerConfig {
            name: "apikey-srv".to_owned(),
            transport: McpServerTransport::Http {
                url: format!("{base_url}/mcp"),
                headers: None,
            },
            enabled: Some(true),
            required: None,
            retries: Some(0),
            auth: Some(McpServerAuthConfig::ApiKey {
                header_name: Some("X-API-Key".to_owned()),
                prefix: None,
                key_id: None,
            }),
            icon: None,
        },
        None,
    )
    .unwrap();
    let key_res = set_mcp_server_api_key(
        &cfg,
        "apikey-srv",
        Some(McpConfigSource::User),
        None,
        None,
        "sk-live-1234567890abcdef",
    )
    .unwrap();
    assert!(key_res.ok);
    assert!(key_res.message.contains("sk-l...cdef"));
    assert!(!key_res.message.contains("1234567890"));

    srv_task.abort();
    let _ = fs::remove_dir_all(&base);
}

fn async_stream_from_rx(
    rx: tokio::sync::mpsc::UnboundedReceiver<String>,
) -> impl futures_util::Stream<Item = Result<axum::body::Bytes, std::convert::Infallible>> {
    futures_util::stream::unfold(rx, |mut rx| async move {
        rx.recv()
            .await
            .map(|msg| (Ok(axum::body::Bytes::from(msg)), rx))
    })
}
