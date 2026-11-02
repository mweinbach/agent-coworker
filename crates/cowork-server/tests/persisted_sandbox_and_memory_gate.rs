//! Turn-time config regressions:
//!
//! * A resumed session runs under its persisted `sandbox` (mode + network) rather than the
//!   current workspace defaults (`AgentSessionFromPersisted.ts` parity), for root and child
//!   agent sessions alike, and children spawned by a resumed parent inherit the parent's
//!   persisted sandbox (mode, network, backend requirement) rather than the workspace
//!   defaults. The effective policy is observed through the system prompt's
//!   `Shell Execution Policy` line, which is rendered from the resolved sandbox policy.
//! * Automatic memory generation after a turn is gated on `advancedMemory` (TS
//!   `triggerMemoryGeneration` / `runMemoryGenerationOnce`): with it off, no memory-model
//!   request is made and nothing lands in the advanced store; with it on, generation runs.
//! * The SQLite memory store keeps the TS database files (`<workspace>/.cowork/memory.sqlite`,
//!   `~/.cowork/memory.sqlite`, and the shared `projectMemoryDbPath` for one-off chats): rows a
//!   TS install saved are listed by the memory RPCs and injected into turn context, and new
//!   writes land in the same files.

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
    /// Requests that reached the memory-model provider (`together`).
    memory_requests: Arc<Mutex<Vec<Value>>>,
}

impl Env {
    async fn new() -> Self {
        let root = tempfile::Builder::new()
            .prefix("cowork-sandbox-memory-gate-")
            .tempdir()
            .unwrap();
        let base = fs::canonicalize(root.path()).unwrap();
        let home = base.join("home");
        let workspace = base.join("workspace");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&workspace).unwrap();

        let bodies: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
        let bodies_route = Arc::clone(&bodies);
        let memory_requests: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
        let memory_route = Arc::clone(&memory_requests);
        let app = Router::new()
            .route(
                "/together/v1/chat/completions",
                post(move |body: axum::body::Bytes| {
                    let memory_requests = Arc::clone(&memory_route);
                    async move {
                        let parsed: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                        memory_requests.lock().unwrap().push(parsed);
                        sse_response(chat_sse_text("NONE"))
                    }
                }),
            )
            .route(
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
        env.insert(
            "TOGETHER_BASE_URL".into(),
            format!("http://127.0.0.1:{port}/together/v1"),
        );
        env.insert("TOGETHER_API_KEY".into(), "together-mock-key".into());
        Self {
            _root: root,
            home,
            workspace,
            env,
            bodies,
            memory_requests,
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

    /// The system prompt of the most recent turn request.
    fn last_system_prompt(&self) -> String {
        let bodies = self.bodies.lock().unwrap();
        let body = bodies.last().expect("a turn request reached the provider");
        body["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| m["role"] == "system")
            .filter_map(|m| m["content"].as_str())
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// The `Shell Execution Policy` sentence of the most recent turn's system prompt.
    fn last_shell_policy(&self) -> String {
        let prompt = self.last_system_prompt();
        prompt
            .lines()
            .find(|l| l.contains("OS sandbox (network:"))
            .unwrap_or_else(|| panic!("system prompt has no sandbox policy line: {prompt}"))
            .to_owned()
    }

    /// Every file under the advanced memory store (`<cowork home>/memories`).
    fn advanced_memory_files(&self) -> Vec<PathBuf> {
        fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
            let Ok(entries) = fs::read_dir(dir) else {
                return;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(&path, out);
                } else {
                    out.push(path);
                }
            }
        }
        let mut out = Vec::new();
        walk(&self.home.join(".cowork").join("memories"), &mut out);
        out
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
                "clientInfo": { "name": "sandbox-memory-gate", "version": "1.0.0" },
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

async fn set_session_config(ws: &mut WsStream, thread_id: &str, config: Value) {
    let set = call(
        ws,
        "cfg",
        "cowork/session/config/set",
        json!({ "threadId": thread_id, "config": config }),
    )
    .await;
    assert!(set.get("error").is_none(), "{set}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn persisted_read_only_sandbox_survives_restart_with_permissive_workspace_defaults() {
    let env = Env::new().await;

    let server = start_server(env.options(None)).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let saved = start_thread(&mut ws, "t-saved", &env.workspace).await;
    let unsaved = start_thread(&mut ws, "t-unsaved", &env.workspace).await;
    drop(ws);
    server.shutdown().await;

    // The session was saved read-only with network disabled (e.g. by the TS server, which
    // persisted `config.sandbox` at creation).
    env.set_stored_sandbox(&saved, READ_ONLY_NO_NETWORK);

    // Restart with workspace defaults of workspace-write + network enabled.
    let server = start_server(env.options(Some("workspace-write")))
        .await
        .unwrap();
    let mut ws = connect(server.ws_url()).await;

    run_turn(&mut ws, "turn-saved", &saved, "hello").await;
    let policy = env.last_shell_policy();
    assert!(
        policy.contains("`read-only` OS sandbox (network: disabled)"),
        "saved sandbox must win over workspace defaults: {policy}"
    );

    // A session without a saved sandbox follows the current workspace defaults.
    run_turn(&mut ws, "turn-unsaved", &unsaved, "hello").await;
    let policy = env.last_shell_policy();
    assert!(
        policy.contains("`workspace-write` OS sandbox (network: enabled)"),
        "{policy}"
    );

    drop(ws);
    server.shutdown().await;

    // Re-persisting after the turn keeps the saved policy.
    assert_eq!(
        env.stored_sandbox(&saved),
        Some(serde_json::from_str::<Value>(READ_ONLY_NO_NETWORK).unwrap())
    );
    assert_eq!(env.stored_sandbox(&unsaved), None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn persisted_child_agent_sandbox_survives_restart_with_permissive_workspace_defaults() {
    let env = Env::new().await;

    let server = start_server(env.options(None)).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let child = start_thread(&mut ws, "t-child", &env.workspace).await;
    drop(ws);
    server.shutdown().await;

    // A persisted child agent (default role, no profile / targetPaths) whose spawn-time
    // sandbox was read-only with network disabled.
    let updated = env
        .db()
        .execute(
            "UPDATE sessions SET session_kind = 'agent', role = 'default' WHERE session_id = ?1",
            [&child],
        )
        .unwrap();
    assert_eq!(updated, 1);
    env.set_stored_sandbox(&child, READ_ONLY_NO_NETWORK);

    let server = start_server(env.options(Some("workspace-write")))
        .await
        .unwrap();
    let mut ws = connect(server.ws_url()).await;
    run_turn(&mut ws, "turn-child", &child, "hello").await;
    let policy = env.last_shell_policy();
    assert!(
        policy.contains("`read-only` OS sandbox (network: disabled)"),
        "child's saved sandbox must win over workspace defaults: {policy}"
    );
    drop(ws);
    server.shutdown().await;
}

/// Spawns a child of `parent_id` through `cowork/session/agent/spawn` and waits until its
/// first turn has settled, returning the child's id.
async fn spawn_child_and_wait(ws: &mut WsStream, parent_id: &str, params: Value) -> String {
    let mut spawn_params = json!({ "threadId": parent_id });
    for (k, v) in params.as_object().unwrap() {
        spawn_params[k] = v.clone();
    }
    send(
        ws,
        json!({ "id": "spawn", "method": "cowork/session/agent/spawn", "params": spawn_params }),
    )
    .await;
    let (mut responded, mut agent_id) = (false, None::<String>);
    while !responded || agent_id.is_none() {
        let val = next_json(ws).await;
        if val.get("method").is_none() && val["id"] == "spawn" {
            assert_eq!(val["result"], json!({}), "spawn failed: {val}");
            responded = true;
        } else if val["method"] == "cowork/session/agentSpawned" {
            agent_id = val["params"]["agent"]["agentId"]
                .as_str()
                .map(str::to_owned);
        }
    }
    let agent_id = agent_id.unwrap();
    for i in 0..200 {
        let res = call(
            ws,
            &format!("inspect-{i}"),
            "cowork/session/agent/inspect",
            json!({ "threadId": parent_id, "agentId": agent_id }),
        )
        .await;
        if res["result"]["event"]["agent"]["busy"] == json!(false) {
            return agent_id;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("child {agent_id} never went idle");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn children_of_a_resumed_parent_inherit_its_persisted_sandbox() {
    const PARENT_SANDBOX: &str = r#"{"mode":"read-only","network":false,"requireBackend":true}"#;
    let env = Env::new().await;

    let server = start_server(env.options(None)).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let parent = start_thread(&mut ws, "t-parent", &env.workspace).await;
    drop(ws);
    server.shutdown().await;

    // The parent was saved read-only, offline and backend-required...
    env.set_stored_sandbox(&parent, PARENT_SANDBOX);

    // ...and resumes in a workspace whose defaults are workspace-write with network enabled.
    let server = start_server(env.options(Some("workspace-write")))
        .await
        .unwrap();
    let mut ws = connect(server.ws_url()).await;

    // An ordinary (default-role, unscoped) child runs under the parent's whole sandbox, not
    // the workspace defaults.
    let child = spawn_child_and_wait(
        &mut ws,
        &parent,
        json!({ "message": "child-sandbox-marker", "contextMode": "none" }),
    )
    .await;
    let policy = env.last_shell_policy();
    assert!(
        env.bodies
            .lock()
            .unwrap()
            .last()
            .is_some_and(|b| b.to_string().contains("child-sandbox-marker")),
        "the last turn request must be the child's"
    );
    assert!(
        policy.contains("`read-only` OS sandbox (network: disabled)"),
        "child must inherit the parent's saved sandbox, not the workspace defaults: {policy}"
    );
    // The child persists its complete effective sandbox, so a resumed child keeps it.
    let expected: Value = serde_json::from_str(PARENT_SANDBOX).unwrap();
    assert_eq!(env.stored_sandbox(&child), Some(expected.clone()));

    // A direct turn on the persisted child after a restart stays read-only and offline.
    drop(ws);
    server.shutdown().await;
    let server = start_server(env.options(Some("workspace-write")))
        .await
        .unwrap();
    let mut ws = connect(server.ws_url()).await;
    run_turn(&mut ws, "turn-child", &child, "hello again").await;
    let policy = env.last_shell_policy();
    assert!(
        policy.contains("`read-only` OS sandbox (network: disabled)"),
        "{policy}"
    );
    assert_eq!(env.stored_sandbox(&child), Some(expected));
    drop(ws);
    server.shutdown().await;
}

/// Waits long enough for the fire-and-forget memory task to have run, if it was spawned.
async fn settle_memory_generation(env: &Env, expect_request: bool) {
    let deadline =
        tokio::time::Instant::now() + Duration::from_secs(if expect_request { 10 } else { 2 });
    while tokio::time::Instant::now() < deadline {
        if expect_request && !env.memory_requests.lock().unwrap().is_empty() {
            // Give the generator a moment to write the offline directive after the request.
            tokio::time::sleep(Duration::from_millis(300)).await;
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn memory_generation_is_skipped_when_advanced_memory_is_off() {
    let env = Env::new().await;
    let server = start_server(env.options(None)).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let thread_id = start_thread(&mut ws, "t", &env.workspace).await;
    // enableMemory defaults on, advancedMemory defaults off; a memory model is configured.
    set_session_config(
        &mut ws,
        &thread_id,
        json!({ "memoryGenerationModel": "together:mem-model" }),
    )
    .await;

    run_turn(
        &mut ws,
        "turn",
        &thread_id,
        "remember: always run cargo fmt first",
    )
    .await;
    settle_memory_generation(&env, false).await;

    assert!(
        env.memory_requests.lock().unwrap().is_empty(),
        "no transcript may be sent to the memory model while advancedMemory is off"
    );
    assert!(
        env.advanced_memory_files().is_empty(),
        "nothing may be written to the advanced store: {:?}",
        env.advanced_memory_files()
    );
    // No automatic extraction into the SQLite store either (TS wrote nothing automatically).
    let listed = call(
        &mut ws,
        "mem-list",
        "cowork/memory/list",
        json!({ "cwd": env.workspace.to_string_lossy() }),
    )
    .await;
    assert!(listed.get("error").is_none(), "{listed}");
    assert!(
        !listed["result"].to_string().contains("cargo fmt"),
        "{listed}"
    );
    drop(ws);
    server.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn memory_generation_runs_when_advanced_memory_is_on() {
    let env = Env::new().await;
    let server = start_server(env.options(None)).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let thread_id = start_thread(&mut ws, "t", &env.workspace).await;
    set_session_config(
        &mut ws,
        &thread_id,
        json!({ "advancedMemory": true, "memoryGenerationModel": "together:mem-model" }),
    )
    .await;

    run_turn(
        &mut ws,
        "turn",
        &thread_id,
        "remember: always run cargo fmt first",
    )
    .await;
    settle_memory_generation(&env, true).await;

    let requests = env.memory_requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 1, "memory model must be called once");
    assert_eq!(requests[0]["model"], json!("mem-model"));
    let files = env.advanced_memory_files();
    assert!(
        files.iter().any(|f| fs::read_to_string(f)
            .unwrap_or_default()
            .contains("cargo fmt")),
        "the explicit directive must land in the advanced store: {files:?}"
    );
    drop(ws);
    server.shutdown().await;
}

const TS_MEMORY_TIMESTAMP: &str = "2025-01-01T00:00:00.000Z";

/// Writes a `memory.sqlite` the way `src/memoryStore.ts` left it: its schema, its completed
/// legacy Markdown import marker, and the given rows.
fn write_ts_memory_db(path: &Path, rows: &[(&str, &str)]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let conn = rusqlite::Connection::open(path).unwrap();
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS memories (
           id TEXT PRIMARY KEY,
           content TEXT NOT NULL,
           created_at TEXT NOT NULL,
           updated_at TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS meta (
           key TEXT PRIMARY KEY,
           value TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_memories_updated_at ON memories(updated_at DESC);
         INSERT OR REPLACE INTO meta(key, value) VALUES('legacy_import_done', '1');",
    )
    .unwrap();
    for (id, content) in rows {
        conn.execute(
            "INSERT INTO memories(id, content, created_at, updated_at) VALUES(?1, ?2, ?3, ?3)",
            rusqlite::params![id, content, TS_MEMORY_TIMESTAMP],
        )
        .unwrap();
    }
}

/// `(id, content)` rows of a memory database, sorted by id.
fn memory_db_rows(path: &Path) -> Vec<(String, String)> {
    let conn = rusqlite::Connection::open(path).unwrap();
    let mut stmt = conn
        .prepare("SELECT id, content FROM memories ORDER BY id")
        .unwrap();
    stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

fn row(id: &str, content: &str) -> (String, String) {
    (id.to_owned(), content.to_owned())
}

/// `(scope, id)` pairs of a `memory_list` result, sorted.
fn listed_memory_ids(res: &Value) -> Vec<(String, String)> {
    let mut ids: Vec<(String, String)> = res["result"]["event"]["memories"]
        .as_array()
        .unwrap_or_else(|| panic!("memories missing: {res}"))
        .iter()
        .map(|m| {
            (
                m["scope"].as_str().unwrap().to_owned(),
                m["id"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    ids.sort();
    ids
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ts_sqlite_memories_survive_upgrade_and_new_writes_share_the_files() {
    let env = Env::new().await;
    let workspace_db = env.workspace.join(".cowork").join("memory.sqlite");
    let user_db = env.home.join(".cowork").join("memory.sqlite");
    write_ts_memory_db(
        &workspace_db,
        &[
            ("hot", "TS workspace hot cache: ship with make release"),
            ("build-tool", "TS workspace note: builds use bazel"),
        ],
    );
    write_ts_memory_db(
        &user_db,
        &[("user-pref", "TS user note: answer in British English")],
    );
    // A dev build of the rewrite wrote `memory.db`; TS never did, so it is not a memory source.
    let stale_dev_db = env.workspace.join(".cowork").join("memory.db");
    write_ts_memory_db(&stale_dev_db, &[("dev-only", "stale dev-build row")]);

    let server = start_server(env.options(None)).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let cwd = env.workspace.to_string_lossy().into_owned();

    let listed = call(&mut ws, "list", "cowork/memory/list", json!({ "cwd": cwd })).await;
    assert_eq!(
        listed_memory_ids(&listed),
        vec![
            ("user".to_owned(), "user-pref".to_owned()),
            ("workspace".to_owned(), "build-tool".to_owned()),
            ("workspace".to_owned(), "hot".to_owned()),
        ],
        "memories saved by the TS install must be listed: {listed}"
    );

    let thread_id = start_thread(&mut ws, "t", &env.workspace).await;
    run_turn(&mut ws, "turn", &thread_id, "hello").await;
    let prompt = env.last_system_prompt();
    for expected in [
        "TS workspace hot cache: ship with make release",
        "TS workspace note: builds use bazel",
        "TS user note: answer in British English",
    ] {
        assert!(
            prompt.contains(expected),
            "turn context must include {expected:?}: {prompt}"
        );
    }
    assert!(!prompt.contains("stale dev-build row"), "{prompt}");

    for (rid, scope, id, content) in [
        ("w", "workspace", "new-ws", "Rust workspace write"),
        ("u", "user", "new-user", "Rust user write"),
    ] {
        let res = call(
            &mut ws,
            rid,
            "cowork/memory/upsert",
            json!({ "cwd": cwd, "scope": scope, "id": id, "content": content }),
        )
        .await;
        assert!(res.get("error").is_none(), "{res}");
    }
    assert_eq!(
        memory_db_rows(&workspace_db),
        vec![
            row("build-tool", "TS workspace note: builds use bazel"),
            row("hot", "TS workspace hot cache: ship with make release"),
            row("new-ws", "Rust workspace write"),
        ]
    );
    assert_eq!(
        memory_db_rows(&user_db),
        vec![
            row("new-user", "Rust user write"),
            row("user-pref", "TS user note: answer in British English"),
        ]
    );
    assert_eq!(
        memory_db_rows(&stale_dev_db),
        vec![row("dev-only", "stale dev-build row")],
        "the stale dev file is left untouched"
    );
    assert!(!env.home.join(".cowork").join("memory.db").exists());
    drop(ws);
    server.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn one_off_chats_share_the_configured_project_memory_db() {
    let env = Env::new().await;
    let chats_root = cowork_config::get_one_off_chats_root(&env.home);
    let chat_a = chats_root.join("chat-a");
    let chat_b = chats_root.join("chat-b");
    fs::create_dir_all(&chat_a).unwrap();
    fs::create_dir_all(&chat_b).unwrap();
    let configured = cowork_config::load_config(cowork_config::LoadConfigOptions {
        cwd: Some(chat_a.clone()),
        homedir: Some(env.home.clone()),
        built_in_dir: Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")),
        env: Some(env.env.clone()),
    })
    .unwrap()
    .project_memory_db_path;
    assert_eq!(configured, chats_root.join(".cowork").join("memory.sqlite"));
    write_ts_memory_db(&configured, &[("shared-note", "TS one-off chat memory")]);

    let server = start_server(env.options(None)).await.unwrap();
    let mut ws = connect(server.ws_url()).await;

    let upsert = call(
        &mut ws,
        "w",
        "cowork/memory/upsert",
        json!({
            "cwd": chat_a.to_string_lossy(),
            "scope": "workspace",
            "id": "chat-a-note",
            "content": "written from chat A"
        }),
    )
    .await;
    assert!(upsert.get("error").is_none(), "{upsert}");
    assert_eq!(
        memory_db_rows(&configured),
        vec![
            row("chat-a-note", "written from chat A"),
            row("shared-note", "TS one-off chat memory"),
        ]
    );
    assert!(!chat_a.join(".cowork").exists(), "no per-chat memory store");

    let listed = call(
        &mut ws,
        "list",
        "cowork/memory/list",
        json!({ "cwd": chat_b.to_string_lossy(), "scope": "workspace" }),
    )
    .await;
    assert_eq!(
        listed_memory_ids(&listed),
        vec![
            ("workspace".to_owned(), "chat-a-note".to_owned()),
            ("workspace".to_owned(), "shared-note".to_owned()),
        ],
        "every one-off chat reads the shared store: {listed}"
    );

    let thread_id = start_thread(&mut ws, "t", &chat_b).await;
    run_turn(&mut ws, "turn", &thread_id, "hello").await;
    let prompt = env.last_system_prompt();
    assert!(prompt.contains("TS one-off chat memory"), "{prompt}");
    assert!(prompt.contains("written from chat A"), "{prompt}");
    drop(ws);
    server.shutdown().await;
}
