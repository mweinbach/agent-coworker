//! Per-session `outputDirectory` / `uploadsDirectory` persistence: a session records the
//! workspace config dirs it was created with, resumes with them after a restart even when the
//! config changed (`AgentSessionFromPersisted.ts` parity), and writes them back unchanged. Rows
//! without stored dirs keep following the current config.

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
use data_encoding::BASE64;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

struct Env {
    root: TempDir,
    home: PathBuf,
    workspace: PathBuf,
    env: HashMap<String, String>,
    bodies: Arc<Mutex<Vec<Value>>>,
}

impl Env {
    async fn new() -> Self {
        let root = tempfile::Builder::new()
            .prefix("cowork-session-io-dirs-")
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
                    // Only turn steps (requests with tools) are recorded; title generation is not.
                    if parsed["tools"].as_array().is_some_and(|t| !t.is_empty()) {
                        bodies.lock().unwrap().push(parsed);
                    }
                    Response::builder()
                        .status(StatusCode::OK)
                        .header("content-type", "text/event-stream")
                        .body(Body::from(chat_sse_text("ok")))
                        .unwrap()
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
            root,
            home,
            workspace,
            env,
            bodies,
        }
    }

    /// Server options with the given `AGENT_OUTPUT_DIR` / `AGENT_UPLOADS_DIR` (unset when `None`).
    fn options(&self, output_dir: Option<&str>, uploads_dir: Option<&str>) -> ServerOptions {
        let mut env = self.env.clone();
        if let Some(dir) = output_dir {
            env.insert("AGENT_OUTPUT_DIR".into(), dir.into());
        }
        if let Some(dir) = uploads_dir {
            env.insert("AGENT_UPLOADS_DIR".into(), dir.into());
        }
        ServerOptions {
            working_directory: self.workspace.clone(),
            host: "127.0.0.1".into(),
            port: 0,
            yolo: true,
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

    /// `(output_directory, uploads_directory)` columns of the session row.
    fn stored_dirs(&self, session_id: &str) -> (Option<String>, Option<String>) {
        self.db()
            .query_row(
                "SELECT output_directory, uploads_directory FROM sessions WHERE session_id = ?1",
                [session_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap()
    }

    fn last_system_prompt(&self) -> String {
        let bodies = self.bodies.lock().unwrap();
        let body = bodies.last().expect("a turn request reached the provider");
        body["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| m["role"] == "system")
            .map(|m| m["content"].to_string())
            .collect::<Vec<_>>()
            .join("\n")
    }
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
                "clientInfo": { "name": "session-io-dirs", "version": "1.0.0" },
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

async fn start_thread(ws: &mut WsStream, cwd: &Path) -> String {
    let res = call(
        ws,
        "thread-start",
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

/// Runs a turn carrying a `notes.txt` attachment and waits for `turn/completed`.
async fn run_turn_with_attachment(ws: &mut WsStream, thread_id: &str) {
    let res = call(
        ws,
        "turn",
        "turn/start",
        json!({
            "threadId": thread_id,
            "input": [
                { "type": "text", "text": "see file" },
                { "type": "file", "filename": "notes.txt", "mimeType": "text/plain",
                  "contentBase64": BASE64.encode(b"hello uploads") }
            ]
        }),
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
async fn persisted_session_io_dirs_survive_resume_and_repersist() {
    let env = Env::new().await;
    let created_out = env.workspace.join("created-out");
    let created_uploads = env.workspace.join("created-uploads");

    // Create the session while config points at `created-*`: the resolved dirs are recorded.
    let server = start_server(env.options(Some("created-out"), Some("created-uploads")))
        .await
        .unwrap();
    let mut ws = connect(server.ws_url()).await;
    let thread_id = start_thread(&mut ws, &env.workspace).await;
    drop(ws);
    server.shutdown().await;
    let stored = (
        Some(created_out.to_string_lossy().into_owned()),
        Some(created_uploads.to_string_lossy().into_owned()),
    );
    assert_eq!(env.stored_dirs(&thread_id), stored);

    // Resume under a different config: the stored dirs win for uploads and the prompt.
    let server = start_server(env.options(Some("current-out"), Some("current-uploads")))
        .await
        .unwrap();
    let mut ws = connect(server.ws_url()).await;
    run_turn_with_attachment(&mut ws, &thread_id).await;
    drop(ws);
    server.shutdown().await;

    assert_eq!(
        fs::read(created_uploads.join("User Uploads/notes.txt")).unwrap(),
        b"hello uploads"
    );
    assert!(!env.workspace.join("current-uploads").exists());
    let prompt = env.last_system_prompt();
    assert!(
        prompt.contains(&*created_out.to_string_lossy()),
        "system prompt must name the stored output dir: {prompt}"
    );
    assert!(
        !prompt.contains("current-out"),
        "system prompt must not use the current config output dir: {prompt}"
    );

    // The turn re-persisted the session without erasing the stored dirs.
    assert_eq!(env.stored_dirs(&thread_id), stored);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn session_without_stored_io_dirs_falls_back_to_current_config() {
    let env = Env::new().await;

    // Created with defaulted dirs: nothing is recorded.
    let server = start_server(env.options(None, None)).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let thread_id = start_thread(&mut ws, &env.workspace).await;
    drop(ws);
    server.shutdown().await;
    assert_eq!(env.stored_dirs(&thread_id), (None, None));

    // A later config applies to the resumed session.
    let server = start_server(env.options(Some("configured-out"), Some("configured-uploads")))
        .await
        .unwrap();
    let mut ws = connect(server.ws_url()).await;
    run_turn_with_attachment(&mut ws, &thread_id).await;
    drop(ws);
    server.shutdown().await;

    assert_eq!(
        fs::read(
            env.workspace
                .join("configured-uploads/User Uploads/notes.txt")
        )
        .unwrap(),
        b"hello uploads"
    );
    let prompt = env.last_system_prompt();
    assert!(
        prompt.contains(&*env.workspace.join("configured-out").to_string_lossy()),
        "{prompt}"
    );
    assert_eq!(env.stored_dirs(&thread_id), (None, None));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stored_io_dirs_outside_the_workspace_are_ignored_but_kept() {
    let env = Env::new().await;
    let server = start_server(env.options(None, None)).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let thread_id = start_thread(&mut ws, &env.workspace).await;
    drop(ws);
    server.shutdown().await;

    // A row whose stored uploads dir escapes the workspace (e.g. written by an older build).
    let outside = fs::canonicalize(env.root.path())
        .unwrap()
        .join("outside-uploads");
    let outside_str = outside.to_string_lossy().into_owned();
    env.db()
        .execute(
            "UPDATE sessions SET uploads_directory = ?1 WHERE session_id = ?2",
            [&outside_str, &thread_id],
        )
        .unwrap();

    let server = start_server(env.options(None, Some("configured-uploads")))
        .await
        .unwrap();
    let mut ws = connect(server.ws_url()).await;
    run_turn_with_attachment(&mut ws, &thread_id).await;
    drop(ws);
    server.shutdown().await;

    assert!(!outside.exists(), "uploads must not escape the workspace");
    assert!(
        env.workspace
            .join("configured-uploads/User Uploads/notes.txt")
            .exists()
    );
    assert_eq!(env.stored_dirs(&thread_id), (None, Some(outside_str)));
}
