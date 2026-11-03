//! `WorkspaceMcpToolCache` must never hold a lock that other workspaces, invalidation or
//! `close_session` need while an MCP server connect is in flight: generation builds are
//! single-flight per workspace, and an invalidated in-flight build is never cached.

use std::collections::HashMap;
use std::fs;
use std::future::Future;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use axum::routing::post;
use cowork_config::{AgentConfig, LoadConfigOptions, load_config};
use cowork_mcp::{
    McpConfigSource, McpServerConfig, McpServerTransport, WorkspaceMcpToolCache, upsert_mcp_server,
};
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::sync::{Notify, Semaphore};
use uuid::Uuid;

/// Bound for operations that must not wait on a hanging connect.
const PROMPT: Duration = Duration::from_secs(5);

fn test_temp_base() -> PathBuf {
    if cfg!(target_os = "macos") {
        PathBuf::from("/private/tmp")
    } else {
        std::env::temp_dir()
    }
}

/// Mock Streamable HTTP MCP server. `initialize` calls numbered `<= gated_inits` wait for a
/// permit on `gate` before answering, so a test can hold a connect in flight.
struct MockServer {
    inits: AtomicUsize,
    init_started: Notify,
    gated_inits: usize,
    gate: Semaphore,
    deleted_sessions: Mutex<Vec<String>>,
    called_sessions: Mutex<Vec<String>>,
}

impl MockServer {
    fn release_gate(&self) {
        self.gate.add_permits(1_000);
    }

    fn inits(&self) -> usize {
        self.inits.load(Ordering::SeqCst)
    }
}

fn rpc_response(session: &str, body: Value) -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .header("mcp-session-id", session)
        .body(Body::from(body.to_string()))
        .unwrap()
}

async fn handle_post(
    State(st): State<Arc<MockServer>>,
    headers: HeaderMap,
    body: String,
) -> Response {
    let msg: Value = serde_json::from_str(&body).unwrap();
    let session = headers
        .get("mcp-session-id")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let Some(id) = msg.get("id").cloned() else {
        return Response::builder()
            .status(StatusCode::ACCEPTED)
            .body(Body::empty())
            .unwrap();
    };
    match msg["method"].as_str().unwrap_or("") {
        "initialize" => {
            let n = st.inits.fetch_add(1, Ordering::SeqCst) + 1;
            st.init_started.notify_waiters();
            if n <= st.gated_inits {
                st.gate.acquire().await.unwrap().forget();
            }
            rpc_response(
                &format!("sess-{n}"),
                json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "protocolVersion": "2025-11-25",
                        "capabilities": { "tools": {} },
                        "serverInfo": { "name": "cache-mock", "version": "1.0.0" }
                    }
                }),
            )
        }
        "tools/list" => rpc_response(
            &session,
            json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": { "tools": [{
                    "name": "whoami",
                    "description": "Returns the MCP session id",
                    "inputSchema": { "type": "object", "properties": {} }
                }] }
            }),
        ),
        "tools/call" => {
            st.called_sessions.lock().push(session.clone());
            rpc_response(
                &session,
                json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": { "content": [{ "type": "text", "text": session }] }
                }),
            )
        }
        _ => rpc_response(
            &session,
            json!({ "jsonrpc": "2.0", "id": id, "result": {} }),
        ),
    }
}

async fn start_mock(gated_inits: usize) -> (Arc<MockServer>, String) {
    let state = Arc::new(MockServer {
        inits: AtomicUsize::new(0),
        init_started: Notify::new(),
        gated_inits,
        gate: Semaphore::new(0),
        deleted_sessions: Mutex::new(Vec::new()),
        called_sessions: Mutex::new(Vec::new()),
    });
    let app = Router::new()
        .route(
            "/mcp",
            post(handle_post).delete(
                |State(st): State<Arc<MockServer>>, headers: HeaderMap| async move {
                    if let Some(sid) = headers.get("mcp-session-id").and_then(|v| v.to_str().ok()) {
                        st.deleted_sessions.lock().push(sid.to_owned());
                    }
                    StatusCode::NO_CONTENT
                },
            ),
        )
        .with_state(Arc::clone(&state));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (state, format!("http://{addr}/mcp"))
}

/// Waits until the mock has received at least `n` `initialize` requests.
async fn wait_for_inits(server: &MockServer, n: usize) {
    tokio::time::timeout(PROMPT, async {
        loop {
            let notified = server.init_started.notified();
            if server.inits() >= n {
                return;
            }
            notified.await;
        }
    })
    .await
    .expect("initialize request never reached the mock server");
}

async fn wait_for_deleted(server: &MockServer, session: &str) {
    tokio::time::timeout(PROMPT, async {
        while !server.deleted_sessions.lock().iter().any(|s| s == session) {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("connection {session} was never closed"));
}

/// An isolated home + workspace whose user layer configures one HTTP MCP server at `url`.
fn workspace_with_server(tag: &str, url: &str) -> (AgentConfig, HashMap<String, String>) {
    let base = test_temp_base().join(format!("cowork-mcp-cache-{tag}-{}", Uuid::new_v4()));
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
        built_in_dir: Some(builtin),
        env: Some(env.clone()),
    })
    .unwrap();

    upsert_mcp_server(
        &cfg,
        McpConfigSource::User,
        McpServerConfig {
            name: "mock".to_owned(),
            transport: McpServerTransport::Http {
                url: url.to_owned(),
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
    (cfg, env)
}

/// Runs one `with_tools` lease that calls the mock's `whoami` tool and returns the MCP session
/// id that served it.
fn call_whoami(
    cache: &Arc<WorkspaceMcpToolCache>,
    cfg: &AgentConfig,
    env: &HashMap<String, String>,
    session_id: &str,
) -> impl Future<Output = String> + Send + 'static {
    let cache = Arc::clone(cache);
    let cfg = cfg.clone();
    let env = env.clone();
    let session_id = session_id.to_owned();
    async move {
        cache
            .with_tools(&cfg, &env, &session_id, |tools, errors| {
                assert!(errors.is_empty(), "unexpected MCP errors: {errors:?}");
                let tool = tools
                    .iter()
                    .find(|t| t.qualified_name == "mcp__mock__whoami")
                    .expect("mock tool is loaded")
                    .clone();
                Box::pin(async move {
                    let out = tool.call(json!({})).await.unwrap();
                    out["content"][0]["text"].as_str().unwrap().to_owned()
                })
            })
            .await
            .unwrap()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn hanging_connect_in_one_workspace_does_not_block_another_workspace() {
    let (hanging, hanging_url) = start_mock(usize::MAX).await;
    let (healthy, healthy_url) = start_mock(0).await;
    let (cfg_a, env_a) = workspace_with_server("hang-a", &hanging_url);
    let (cfg_b, env_b) = workspace_with_server("hang-b", &healthy_url);
    let cache = Arc::new(WorkspaceMcpToolCache::new());

    let stuck = tokio::spawn(call_whoami(&cache, &cfg_a, &env_a, "session-a"));
    wait_for_inits(&hanging, 1).await;

    let served_by = tokio::time::timeout(PROMPT, call_whoami(&cache, &cfg_b, &env_b, "session-b"))
        .await
        .expect("workspace B must not wait for workspace A's hanging connect");
    assert_eq!(served_by, "sess-1");
    assert_eq!(healthy.inits(), 1);

    // Cache-wide invalidation must not queue behind the hanging connect either.
    tokio::time::timeout(PROMPT, cache.invalidate_all())
        .await
        .expect("invalidate_all must not wait for an in-flight connect");

    assert!(!stuck.is_finished());
    stuck.abort();
    hanging.release_gate();
    cache.close_all().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_callers_for_the_same_workspace_share_one_connect() {
    let (server, url) = start_mock(1).await;
    let (cfg, env) = workspace_with_server("single-flight", &url);
    let cache = Arc::new(WorkspaceMcpToolCache::new());

    let first = tokio::spawn(call_whoami(&cache, &cfg, &env, "session-1"));
    wait_for_inits(&server, 1).await;
    let second = tokio::spawn(call_whoami(&cache, &cfg, &env, "session-2"));
    let third = tokio::spawn(call_whoami(&cache, &cfg, &env, "session-1"));
    // Give the later callers time to queue on the in-flight build.
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        server.inits(),
        1,
        "same-workspace callers must not connect again"
    );

    server.release_gate();
    for handle in [first, second, third] {
        let served_by = tokio::time::timeout(PROMPT, handle).await.unwrap().unwrap();
        assert_eq!(served_by, "sess-1");
    }
    assert_eq!(server.inits(), 1);
    cache.close_all().await;
    wait_for_deleted(&server, "sess-1").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn invalidation_during_connect_is_not_blocked_and_the_stale_build_is_not_cached() {
    let (server, url) = start_mock(1).await;
    let (cfg, env) = workspace_with_server("invalidate", &url);
    let cache = Arc::new(WorkspaceMcpToolCache::new());

    let in_flight = tokio::spawn(call_whoami(&cache, &cfg, &env, "session-1"));
    wait_for_inits(&server, 1).await;

    tokio::time::timeout(PROMPT, cache.invalidate_workspace(&cfg.working_directory))
        .await
        .expect("invalidate_workspace must not wait for an in-flight connect");

    // The caller that was waiting on the invalidated build is still served by it once...
    server.release_gate();
    let served_by = tokio::time::timeout(PROMPT, in_flight)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(served_by, "sess-1");
    // ...but the stale build is retired, not cached: its connection closes after that call.
    wait_for_deleted(&server, "sess-1").await;

    // The next call reconnects, and that fresh generation is the one that gets cached.
    let served_by = call_whoami(&cache, &cfg, &env, "session-1").await;
    assert_eq!(served_by, "sess-2");
    assert_eq!(server.inits(), 2);
    let served_by = call_whoami(&cache, &cfg, &env, "session-1").await;
    assert_eq!(served_by, "sess-2");
    assert_eq!(server.inits(), 2);
    cache.close_all().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn next_call_after_invalidation_does_not_queue_behind_the_stale_connect() {
    let (server, url) = start_mock(1).await;
    let (cfg, env) = workspace_with_server("invalidate-requeue", &url);
    let cache = Arc::new(WorkspaceMcpToolCache::new());

    let stale = tokio::spawn(call_whoami(&cache, &cfg, &env, "session-1"));
    wait_for_inits(&server, 1).await;
    cache.invalidate_workspace(&cfg.working_directory).await;

    // `initialize` #2 is not gated: the new epoch builds its own generation right away.
    let served_by = tokio::time::timeout(PROMPT, call_whoami(&cache, &cfg, &env, "session-2"))
        .await
        .expect("post-invalidation call must not wait for the stale connect");
    assert_eq!(served_by, "sess-2");

    // When the stale build finishes it serves its waiting caller but does not replace the
    // fresh generation.
    server.release_gate();
    let stale_served_by = tokio::time::timeout(PROMPT, stale).await.unwrap().unwrap();
    assert_eq!(stale_served_by, "sess-1");
    wait_for_deleted(&server, "sess-1").await;
    assert_eq!(call_whoami(&cache, &cfg, &env, "session-2").await, "sess-2");
    assert_eq!(server.inits(), 2);
    assert!(
        !server.deleted_sessions.lock().iter().any(|s| s == "sess-2"),
        "the cached generation must stay open"
    );
    cache.close_all().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn close_session_does_not_wait_for_an_in_flight_connect() {
    let (server, url) = start_mock(1).await;
    let (cfg, env) = workspace_with_server("close-session", &url);
    let cache = Arc::new(WorkspaceMcpToolCache::new());

    let in_flight = tokio::spawn(call_whoami(&cache, &cfg, &env, "session-1"));
    wait_for_inits(&server, 1).await;

    tokio::time::timeout(PROMPT, cache.close_session("session-1"))
        .await
        .expect("close_session must not wait for an in-flight connect");

    // Closing the workspace's last session during discovery releases the eventual connection
    // (TS `closeSession`): the waiting call is served, then the build is retired.
    server.release_gate();
    let served_by = tokio::time::timeout(PROMPT, in_flight)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(served_by, "sess-1");
    wait_for_deleted(&server, "sess-1").await;

    assert_eq!(call_whoami(&cache, &cfg, &env, "session-1").await, "sess-2");
    cache.close_all().await;
    wait_for_deleted(&server, "sess-2").await;
}

/// A `with_tools` caller dropped mid-await (e.g. a tool call abandoned after its cancellation
/// grace, or an aborted RPC handler) must give its generation lease back, so a later retirement
/// still closes the MCP connection.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancelled_with_tools_call_still_lets_its_generation_close() {
    let (server, url) = start_mock(0).await;
    let (cfg, env) = workspace_with_server("cancelled-call", &url);
    let cache = Arc::new(WorkspaceMcpToolCache::new());

    let hung = cache.with_tools(&cfg, &env, "session-1", |_tools, _errors| {
        Box::pin(std::future::pending::<()>())
    });
    assert!(
        tokio::time::timeout(Duration::from_millis(300), hung)
            .await
            .is_err(),
        "the caller's future never completes"
    );
    assert_eq!(server.inits(), 1);

    cache.invalidate_workspace(&cfg.working_directory).await;
    wait_for_deleted(&server, "sess-1").await;
    cache.close_all().await;
}

/// A session whose working directory changes must stop holding its previous workspace's
/// generation open.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn session_moving_workspaces_releases_the_previous_workspace() {
    let (server_a, url_a) = start_mock(0).await;
    let (server_b, url_b) = start_mock(0).await;
    let (cfg_a, env_a) = workspace_with_server("move-a", &url_a);
    let (cfg_b, env_b) = workspace_with_server("move-b", &url_b);
    let cache = Arc::new(WorkspaceMcpToolCache::new());

    assert_eq!(
        call_whoami(&cache, &cfg_a, &env_a, "session-1").await,
        "sess-1"
    );
    assert_eq!(
        call_whoami(&cache, &cfg_b, &env_b, "session-1").await,
        "sess-1"
    );
    wait_for_deleted(&server_a, "sess-1").await;

    cache.close_session("session-1").await;
    wait_for_deleted(&server_b, "sess-1").await;
    cache.close_all().await;
}

/// `close_session` for a session whose call is still queued behind another session's build
/// must stick: the queued call may not re-register the closed session, or the workspace would
/// never retire once its remaining sessions close.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn closed_session_queued_on_a_build_is_not_re_registered() {
    let (server, url) = start_mock(1).await;
    let (cfg, env) = workspace_with_server("closed-queued", &url);
    let cache = Arc::new(WorkspaceMcpToolCache::new());

    let first = tokio::spawn(call_whoami(&cache, &cfg, &env, "session-1"));
    wait_for_inits(&server, 1).await;
    let queued = tokio::spawn(call_whoami(&cache, &cfg, &env, "session-2"));
    tokio::time::sleep(Duration::from_millis(200)).await;
    cache.close_session("session-2").await;

    server.release_gate();
    for handle in [first, queued] {
        assert_eq!(
            tokio::time::timeout(PROMPT, handle).await.unwrap().unwrap(),
            "sess-1"
        );
    }
    assert!(server.deleted_sessions.lock().is_empty());

    cache.close_session("session-1").await;
    wait_for_deleted(&server, "sess-1").await;
    cache.close_all().await;
}

/// A cached stdio connection whose server process died is reconnected on the next call instead
/// of being reused until every call times out.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn dead_stdio_connection_is_reconnected() {
    let base = test_temp_base().join(format!("cowork-mcp-cache-dead-{}", Uuid::new_v4()));
    fs::create_dir_all(&base).unwrap();
    let script = base.join("exit_after_call.js");
    // Answers one `tools/call` with its pid, then exits.
    fs::write(
        &script,
        r#"
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "dying", version: "1" } } });
  } else if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "whoami", inputSchema: { type: "object", properties: {} } }] } });
  } else if (msg.method === "tools/call") {
    send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: String(process.pid) }] } });
    setTimeout(() => process.exit(0), 10);
  }
});
"#,
    )
    .unwrap();
    let (cfg, env) = workspace_with_server("dead-stdio", "http://127.0.0.1:9/unused");
    upsert_mcp_server(
        &cfg,
        McpConfigSource::User,
        McpServerConfig {
            name: "mock".to_owned(),
            transport: McpServerTransport::Stdio {
                command: "node".to_owned(),
                args: Some(vec![script.to_string_lossy().into_owned()]),
                env: None,
                cwd: None,
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
    let cache = Arc::new(WorkspaceMcpToolCache::new());

    let first = tokio::time::timeout(PROMPT, call_whoami(&cache, &cfg, &env, "session-1"))
        .await
        .expect("first call");
    // Let the server exit and the transport's reader observe EOF.
    tokio::time::sleep(Duration::from_millis(500)).await;
    let second = tokio::time::timeout(PROMPT, call_whoami(&cache, &cfg, &env, "session-1"))
        .await
        .expect("a dead cached connection must be replaced, not reused until the request timeout");
    assert_ne!(
        first, second,
        "second call must be served by a new server process"
    );
    cache.close_all().await;
    let _ = fs::remove_dir_all(&base);
}
