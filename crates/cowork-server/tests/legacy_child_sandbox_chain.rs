//! A legacy child agent row (saved before children persisted their sandbox) whose parent is
//! itself a legacy child must not fall back to the workspace defaults: its ceiling is resolved
//! up the ancestry to the nearest ancestor with a saved sandbox (or the root's effective
//! sandbox), re-applying every legacy ancestor's role narrowing on the way down, and fails
//! closed (read-only) when a link is missing or the ancestry loops. The effective policy is
//! observed through the system prompt's `Shell Execution Policy` line.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::http::{Response, StatusCode};
use axum::routing::post;
use cowork_protocol::WEBSOCKET_SUBPROTOCOL;
use cowork_server::{ServerOptions, start_server};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

const READ_ONLY_NO_NETWORK: &str = r#"{"mode":"read-only","network":false,"requireBackend":false}"#;

struct Env {
    _root: TempDir,
    home: PathBuf,
    workspace: PathBuf,
    env: HashMap<String, String>,
    /// Turn-step request bodies sent to the chat provider.
    bodies: Arc<Mutex<Vec<Value>>>,
}

impl Env {
    async fn new() -> Self {
        let root = tempfile::Builder::new()
            .prefix("cowork-legacy-child-chain-")
            .tempdir()
            .unwrap();
        let base = fs::canonicalize(root.path()).unwrap();
        let home = base.join("home");
        let workspace = base.join("workspace");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&workspace).unwrap();

        let bodies: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
        let bodies_route = Arc::clone(&bodies);
        let app = Router::new().route(
            "/v1/chat/completions",
            post(move |body: axum::body::Bytes| {
                let bodies = Arc::clone(&bodies_route);
                async move {
                    let parsed: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                    // Only turn steps (requests with tools) are recorded; title generation
                    // is not.
                    if parsed["tools"].as_array().is_some_and(|t| !t.is_empty()) {
                        bodies.lock().unwrap().push(parsed);
                    }
                    sse_response(chat_sse_text("ok"))
                }
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let mut env = HashMap::new();
        env.insert("HOME".into(), home.to_string_lossy().into_owned());
        env.insert(
            "COWORK_HOME_OVERRIDE".into(),
            home.join(".cowork").to_string_lossy().into_owned(),
        );
        env.insert("COWORK_DISABLE_RUNTIME".into(), "1".into());
        env.insert("COWORK_RUNTIME_ALLOW_NETWORK".into(), "0".into());
        env.insert(
            "PATH".into(),
            "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin".into(),
        );
        env.insert(
            "NVIDIA_BASE_URL".into(),
            format!("http://127.0.0.1:{port}/v1"),
        );
        env.insert("NVIDIA_API_KEY".into(), "nvapi-mock-test".into());
        Self {
            _root: root,
            home,
            workspace,
            env,
            bodies,
        }
    }

    /// Server options; `sandbox_mode` sets the workspace default through `AGENT_SANDBOX`
    /// (network stays at its enabled default).
    fn options(&self, sandbox_mode: Option<&str>) -> ServerOptions {
        let mut env = self.env.clone();
        if let Some(mode) = sandbox_mode {
            env.insert("AGENT_SANDBOX".into(), mode.into());
        }
        ServerOptions {
            working_directory: self.workspace.clone(),
            host: "127.0.0.1".into(),
            port: 0,
            yolo: false,
            mobile_h3: false,
            mobile_h3_host: "127.0.0.1".into(),
            mobile_h3_port: 0,
            homedir: Some(self.home.clone()),
            built_in_dir: Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")),
            env,
        }
    }

    fn db(&self) -> rusqlite::Connection {
        rusqlite::Connection::open(self.home.join(".cowork").join("sessions.db")).unwrap()
    }

    fn set_stored_sandbox(&self, session_id: &str, sandbox_json: &str) {
        let updated = self
            .db()
            .execute(
                "UPDATE session_state SET sandbox_json = ?1 WHERE session_id = ?2",
                [sandbox_json, session_id],
            )
            .unwrap();
        assert_eq!(updated, 1, "session_state row for {session_id}");
    }

    fn stored_sandbox(&self, session_id: &str) -> Option<Value> {
        let raw: Option<String> = self
            .db()
            .query_row(
                "SELECT sandbox_json FROM session_state WHERE session_id = ?1",
                [session_id],
                |row| row.get(0),
            )
            .unwrap();
        raw.map(|s| serde_json::from_str(&s).unwrap())
    }

    /// Turns a persisted root row into a legacy child agent row of `parent` with `role`: no
    /// saved sandbox.
    fn make_legacy_child(&self, child: &str, parent: &str, role: &str) {
        let updated = self
            .db()
            .execute(
                "UPDATE sessions SET session_kind = 'agent', role = ?1, parent_session_id = ?2 \
                 WHERE session_id = ?3",
                [role, parent, child],
            )
            .unwrap();
        assert_eq!(updated, 1);
        assert_eq!(
            self.stored_sandbox(child),
            None,
            "legacy child has no saved sandbox"
        );
    }

    /// The `Shell Execution Policy` sentence of the most recent turn's system prompt.
    fn last_shell_policy(&self) -> String {
        let bodies = self.bodies.lock().unwrap();
        let body = bodies.last().expect("a turn request reached the provider");
        let prompt = body["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| m["role"] == "system")
            .filter_map(|m| m["content"].as_str())
            .collect::<Vec<_>>()
            .join("\n");
        prompt
            .lines()
            .find(|l| l.contains("OS sandbox (network:"))
            .unwrap_or_else(|| panic!("system prompt has no sandbox policy line: {prompt}"))
            .to_owned()
    }

    /// Creates `count` root sessions (persisted rows) and stops the server.
    async fn create_sessions(&self, count: usize) -> Vec<String> {
        let server = start_server(self.options(None)).await.unwrap();
        let mut ws = connect(server.ws_url()).await;
        let mut ids = Vec::new();
        for i in 0..count {
            ids.push(start_thread(&mut ws, &format!("t-{i}"), &self.workspace).await);
        }
        drop(ws);
        server.shutdown().await;
        ids
    }

    /// Restarts with permissive workspace defaults (workspace-write, network enabled), runs a
    /// direct turn on `thread`, and returns its shell policy line.
    async fn policy_of(&self, thread: &str) -> String {
        let server = start_server(self.options(Some("workspace-write")))
            .await
            .unwrap();
        let mut ws = connect(server.ws_url()).await;
        run_turn(&mut ws, "turn", thread, "hello").await;
        let policy = self.last_shell_policy();
        drop(ws);
        server.shutdown().await;
        policy
    }
}

fn sse_response(body: String) -> Response<Body> {
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .body(Body::from(body))
        .unwrap()
}

fn chat_sse_text(text: &str) -> String {
    format!(
        concat!(
            "data: {{\"id\":\"c\",\"choices\":[{{\"index\":0,\"delta\":{{\"role\":\"assistant\",\"content\":{text:?}}}}}]}}\n\n",
            "data: {{\"id\":\"c\",\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"stop\"}}],\"usage\":{{\"prompt_tokens\":5,\"completion_tokens\":2,\"total_tokens\":7}}}}\n\n",
            "data: [DONE]\n\n"
        ),
        text = text,
    )
}

async fn connect(ws_url: &str) -> WsStream {
    let mut req = ws_url.into_client_request().unwrap();
    req.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        WEBSOCKET_SUBPROTOCOL.parse().unwrap(),
    );
    let (mut ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();
    send(
        &mut ws,
        json!({
            "id": "init",
            "method": "initialize",
            "params": {
                "clientInfo": { "name": "legacy-child-chain", "version": "1.0.0" },
                "capabilities": { "experimentalApi": true }
            }
        }),
    )
    .await;
    let _ = ws.next().await.unwrap().unwrap();
    send(&mut ws, json!({ "method": "initialized", "params": {} })).await;
    ws
}

async fn send(ws: &mut WsStream, msg: Value) {
    ws.send(WsMessage::Text(msg.to_string().into()))
        .await
        .unwrap();
}

async fn next_json(ws: &mut WsStream) -> Value {
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(20), ws.next())
            .await
            .expect("frame timeout")
            .expect("ws open")
            .expect("frame");
        if let WsMessage::Text(txt) = frame {
            return serde_json::from_str(&txt).unwrap();
        }
    }
}

async fn call(ws: &mut WsStream, id: &str, method: &str, params: Value) -> Value {
    send(ws, json!({ "id": id, "method": method, "params": params })).await;
    loop {
        let val = next_json(ws).await;
        if val.get("method").is_none() && val["id"] == id {
            return val;
        }
    }
}

async fn start_thread(ws: &mut WsStream, id: &str, cwd: &Path) -> String {
    let res = call(
        ws,
        id,
        "thread/start",
        json!({
            "cwd": cwd.to_string_lossy(),
            "provider": "nvidia",
            "model": "moonshotai/kimi-k2-instruct"
        }),
    )
    .await;
    res["result"]["thread"]["id"]
        .as_str()
        .unwrap_or_else(|| panic!("thread/start failed: {res}"))
        .to_owned()
}

/// Runs a text turn and waits for its `turn/completed`.
async fn run_turn(ws: &mut WsStream, id: &str, thread_id: &str, text: &str) {
    let res = call(
        ws,
        id,
        "turn/start",
        json!({ "threadId": thread_id, "input": text }),
    )
    .await;
    let turn_id = res["result"]["turn"]["id"]
        .as_str()
        .unwrap_or_else(|| panic!("turn/start failed: {res}"))
        .to_owned();
    loop {
        let val = next_json(ws).await;
        if val["method"] == "turn/completed" && val["params"]["turn"]["id"] == turn_id.as_str() {
            return;
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn legacy_grandchild_inherits_the_nearest_saved_ancestor_sandbox() {
    let env = Env::new().await;
    let ids = env.create_sessions(3).await;
    let (root, mid, leaf) = (&ids[0], &ids[1], &ids[2]);
    // root (saved read-only, offline) -> mid (legacy) -> leaf (legacy).
    env.set_stored_sandbox(root, READ_ONLY_NO_NETWORK);
    env.make_legacy_child(mid, root, "default");
    env.make_legacy_child(leaf, mid, "default");

    let policy = env.policy_of(leaf).await;
    assert!(
        policy.contains("`read-only` OS sandbox (network: disabled)"),
        "a legacy grandchild must not be wider than its saved grandparent: {policy}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn legacy_grandchild_keeps_a_legacy_parents_role_narrowing() {
    let env = Env::new().await;
    let ids = env.create_sessions(3).await;
    let (root, mid, leaf) = (&ids[0], &ids[1], &ids[2]);
    // The root follows the (workspace-write) defaults; the legacy middle child is a read-only
    // reviewer, so its own legacy child must stay read-only too.
    env.make_legacy_child(mid, root, "reviewer");
    env.make_legacy_child(leaf, mid, "default");

    let policy = env.policy_of(leaf).await;
    assert!(
        policy.contains("`read-only` OS sandbox (network: enabled)"),
        "a legacy grandchild must not be wider than its read-only legacy parent: {policy}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn legacy_grandchild_of_an_unsaved_root_follows_the_root_defaults() {
    let env = Env::new().await;
    let ids = env.create_sessions(3).await;
    let (root, mid, leaf) = (&ids[0], &ids[1], &ids[2]);
    env.make_legacy_child(mid, root, "default");
    env.make_legacy_child(leaf, mid, "default");

    let policy = env.policy_of(leaf).await;
    assert!(
        policy.contains("`workspace-write` OS sandbox (network: enabled)"),
        "{policy}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn legacy_grandchild_fails_closed_when_an_ancestor_is_missing() {
    let env = Env::new().await;
    let ids = env.create_sessions(2).await;
    let (mid, leaf) = (&ids[0], &ids[1]);
    env.make_legacy_child(mid, "missing-root-session", "default");
    env.make_legacy_child(leaf, mid, "default");

    let policy = env.policy_of(leaf).await;
    assert!(
        policy.contains("`read-only` OS sandbox"),
        "a broken ancestry must run read-only: {policy}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn legacy_child_ancestry_cycle_fails_closed() {
    let env = Env::new().await;
    let ids = env.create_sessions(2).await;
    let (a, b) = (&ids[0], &ids[1]);
    env.make_legacy_child(a, b, "default");
    env.make_legacy_child(b, a, "default");

    let policy = env.policy_of(a).await;
    assert!(
        policy.contains("`read-only` OS sandbox"),
        "a looping ancestry must run read-only: {policy}"
    );
}
