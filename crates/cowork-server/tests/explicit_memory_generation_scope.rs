//! Explicit advanced-memory generation (`cowork/memory/advanced/generate` and
//! `cowork/memory/advanced/folder/generate`) ports TS `generateAdvancedMemoryForHistory` →
//! `runMemoryBackfill`: it analyzes the complete conversation regardless of the automatic
//! cursor, writes extracted memories straight into the requested folder, and moves the
//! automatic checkpoint only when that folder is the thread's own (current) folder.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
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

const CHAT_MODEL: &str = "moonshotai/kimi-k2-instruct";
/// System prompt marker of the memory extraction request.
const MEMORY_PROMPT_MARKER: &str = "durable engineering preference";
/// An ordinary preference: no `remember ...` directive prefix, so only a model can extract it.
const PREFERENCE: &str = "I prefer tabs over spaces in this repository.";

struct Env {
    _root: TempDir,
    home: PathBuf,
    workspace: PathBuf,
    env: HashMap<String, String>,
    /// Requests to the chat provider (nvidia) endpoint.
    chat: Arc<Mutex<Vec<Value>>>,
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

fn sse_ok(text: &str) -> Response<Body> {
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .body(Body::from(chat_sse_text(text)))
        .unwrap()
}

fn is_memory_request(body: &Value) -> bool {
    body.to_string().contains(MEMORY_PROMPT_MARKER)
}

impl Env {
    async fn new() -> Self {
        let root = tempfile::Builder::new()
            .prefix("cowork-explicit-memscope-")
            .tempdir()
            .unwrap();
        let base = fs::canonicalize(root.path()).unwrap();
        let home = base.join("home");
        let workspace = base.join("workspace");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&workspace).unwrap();

        let chat: Arc<Mutex<Vec<Value>>> = Arc::default();
        let chat_route = Arc::clone(&chat);
        let app = Router::new().route(
            "/v1/chat/completions",
            post(move |body: axum::body::Bytes| {
                let chat = Arc::clone(&chat_route);
                async move {
                    let parsed: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                    let memory = is_memory_request(&parsed);
                    chat.lock().unwrap().push(parsed);
                    sse_ok(if memory {
                        "Prefers tabs over spaces in this repository."
                    } else {
                        "Noted."
                    })
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
        env.insert("PATH".into(), "/usr/local/bin:/usr/bin:/bin".into());
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
            chat,
        }
    }

    fn options(&self) -> ServerOptions {
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
            env: self.env.clone(),
        }
    }

    fn cwd(&self) -> String {
        self.workspace.to_string_lossy().into_owned()
    }

    fn memory_requests(&self) -> Vec<Value> {
        self.chat
            .lock()
            .unwrap()
            .iter()
            .filter(|b| is_memory_request(b))
            .cloned()
            .collect()
    }
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
                "clientInfo": { "name": "explicit-memscope", "version": "1.0.0" },
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

async fn call_collecting(
    ws: &mut WsStream,
    id: &str,
    method: &str,
    params: Value,
    notifs: &mut Vec<Value>,
) -> Value {
    send(ws, json!({ "id": id, "method": method, "params": params })).await;
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(30), ws.next())
            .await
            .expect("response timeout")
            .expect("ws open")
            .expect("frame");
        if let WsMessage::Text(txt) = frame {
            let val: Value = serde_json::from_str(&txt).unwrap();
            if val.get("method").is_some() {
                notifs.push(val);
            } else if val.get("id").and_then(Value::as_str) == Some(id) {
                return val;
            }
        }
    }
}

async fn call(ws: &mut WsStream, id: &str, method: &str, params: Value) -> Value {
    call_collecting(ws, id, method, params, &mut Vec::new()).await
}

async fn start_thread(ws: &mut WsStream, cwd: &str) -> String {
    let res = call(
        ws,
        "thread-start",
        "thread/start",
        json!({ "cwd": cwd, "provider": "nvidia", "model": CHAT_MODEL }),
    )
    .await;
    res["result"]["thread"]["id"]
        .as_str()
        .unwrap_or_else(|| panic!("thread/start failed: {res}"))
        .to_owned()
}

async fn set_config(ws: &mut WsStream, thread_id: &str, config: Value) {
    let res = call(
        ws,
        "cfg",
        "cowork/session/config/set",
        json!({ "threadId": thread_id, "config": config }),
    )
    .await;
    assert!(res.get("error").is_none(), "config/set failed: {res}");
}

async fn run_turn(ws: &mut WsStream, id: &str, thread_id: &str, text: &str) {
    let mut notifs = Vec::new();
    let res = call_collecting(
        ws,
        id,
        "turn/start",
        json!({ "threadId": thread_id, "input": text }),
        &mut notifs,
    )
    .await;
    let turn_id = res["result"]["turn"]["id"]
        .as_str()
        .unwrap_or_else(|| panic!("turn/start failed: {res}"))
        .to_owned();
    let done = |v: &Value| {
        v["method"] == "turn/completed" && v["params"]["turn"]["id"].as_str() == Some(&turn_id)
    };
    while !notifs.iter().any(done) {
        let frame = tokio::time::timeout(Duration::from_secs(20), ws.next())
            .await
            .expect("turn completion timeout")
            .expect("ws open")
            .expect("frame");
        if let WsMessage::Text(txt) = frame {
            let val: Value = serde_json::from_str(&txt).unwrap();
            if val.get("method").is_some() {
                notifs.push(val);
            }
        }
    }
}

fn memory_cursor(server: &cowork_server::ServerHandle, thread_id: &str) -> (usize, usize) {
    let live = server.runtime().load_thread(thread_id).unwrap();
    let live = live.lock();
    (
        live.last_memory_generated_index.unwrap_or(0),
        live.messages.len(),
    )
}

/// Waits until the cursor reaches the end of the transcript.
async fn await_cursor_at_end(server: &cowork_server::ServerHandle, thread_id: &str) -> usize {
    for _ in 0..200 {
        let (cursor, len) = memory_cursor(server, thread_id);
        if cursor == len {
            return cursor;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let (cursor, len) = memory_cursor(server, thread_id);
    panic!("memory cursor did not advance: cursor {cursor}, transcript {len}");
}

async fn rpc(ws: &mut WsStream, id: &str, method: &str, params: Value) -> Value {
    let res = call(ws, id, method, params).await;
    assert!(res.get("error").is_none(), "{method} failed: {res}");
    res
}

fn memories(res: &Value) -> Vec<Value> {
    res["result"]["event"]["memories"]
        .as_array()
        .cloned()
        .unwrap_or_default()
}

fn has_body(entries: &[Value], needle: &str) -> bool {
    entries
        .iter()
        .any(|e| e["body"].as_str().is_some_and(|b| b.contains(needle)))
}

/// A thread whose history was not processed (advanced memory off during the turn).
async fn thread_with_unprocessed_history(ws: &mut WsStream, cwd: &str) -> String {
    let thread_id = start_thread(ws, cwd).await;
    set_config(ws, &thread_id, json!({ "advancedMemory": false })).await;
    run_turn(ws, "turn-1", &thread_id, PREFERENCE).await;
    set_config(ws, &thread_id, json!({ "advancedMemory": true })).await;
    thread_id
}

/// After automatic generation checkpointed the whole transcript, an explicit request still
/// sends the full history to the memory model (e.g. to regenerate deleted memories).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn explicit_generate_processes_full_history_after_automatic_checkpoint() {
    let env = Env::new().await;
    let server = start_server(env.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let cwd = env.cwd();
    let thread_id = start_thread(&mut ws, &cwd).await;
    set_config(&mut ws, &thread_id, json!({ "advancedMemory": true })).await;
    run_turn(&mut ws, "turn-1", &thread_id, PREFERENCE).await;
    let checkpoint = await_cursor_at_end(&server, &thread_id).await;
    let automatic = env.memory_requests().len();

    rpc(
        &mut ws,
        "gen",
        "cowork/memory/advanced/generate",
        json!({ "cwd": cwd, "threadId": thread_id }),
    )
    .await;
    let memory = env.memory_requests();
    assert_eq!(
        memory.len(),
        automatic + 1,
        "explicit generation must analyze the already-checkpointed history"
    );
    assert!(
        memory[automatic].to_string().contains("tabs over spaces"),
        "the full history must reach the memory model: {}",
        memory[automatic]
    );
    assert_eq!(memory_cursor(&server, &thread_id).0, checkpoint);
    server.shutdown().await;
}

/// Generating into another folder analyzes the history but never moves the automatic cursor,
/// which belongs to the thread's own folder; generating into the current folder does.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn explicit_generate_checkpoints_only_for_the_current_folder() {
    let env = Env::new().await;
    let server = start_server(env.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let cwd = env.cwd();
    let thread_id = thread_with_unprocessed_history(&mut ws, &cwd).await;
    assert_eq!(memory_cursor(&server, &thread_id).0, 0);

    rpc(
        &mut ws,
        "gen-other",
        "cowork/memory/advanced/folder/generate",
        json!({ "cwd": cwd, "threadId": thread_id, "folder": "team-notes" }),
    )
    .await;
    assert_eq!(env.memory_requests().len(), 1);
    assert_eq!(
        memory_cursor(&server, &thread_id).0,
        0,
        "another folder must not move the automatic checkpoint"
    );

    // The current folder, named explicitly, is the automatic folder: it checkpoints.
    let current = rpc(
        &mut ws,
        "list",
        "cowork/memory/advanced/list",
        json!({ "cwd": cwd }),
    )
    .await["result"]["event"]["folder"]
        .as_str()
        .unwrap()
        .to_owned();
    rpc(
        &mut ws,
        "gen-current",
        "cowork/memory/advanced/folder/generate",
        json!({ "cwd": cwd, "threadId": thread_id, "folder": current }),
    )
    .await;
    assert_eq!(env.memory_requests().len(), 2);
    let (cursor, len) = memory_cursor(&server, &thread_id);
    assert_eq!(cursor, len);
    server.shutdown().await;
}

/// `folder/generate` writes only the newly extracted memories into the requested folder:
/// existing workspace memories are not copied there, same-slug target entries are not
/// overwritten by unrelated workspace entries, and the workspace folder itself is untouched.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn folder_generate_writes_only_new_memories_into_the_target_folder() {
    let env = Env::new().await;
    let server = start_server(env.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let cwd = env.cwd();
    let thread_id = thread_with_unprocessed_history(&mut ws, &cwd).await;

    for (slug, body) in [
        ("editor-choice", "Workspace says vim."),
        ("workspace-only", "Only in the workspace folder."),
    ] {
        rpc(
            &mut ws,
            slug,
            "cowork/memory/advanced/upsert",
            json!({ "cwd": cwd, "slug": slug, "name": slug, "description": "ws", "body": body }),
        )
        .await;
    }
    rpc(
        &mut ws,
        "team",
        "cowork/memory/advanced/folder/upsert",
        json!({
            "cwd": cwd, "folder": "team-notes", "slug": "editor-choice",
            "name": "editor-choice", "description": "team", "body": "Team says emacs."
        }),
    )
    .await;

    let res = rpc(
        &mut ws,
        "gen",
        "cowork/memory/advanced/folder/generate",
        json!({ "cwd": cwd, "threadId": thread_id, "folder": "team-notes" }),
    )
    .await;
    assert_eq!(res["result"]["event"]["folder"], json!("team-notes"));

    let team = memories(
        &rpc(
            &mut ws,
            "team-list",
            "cowork/memory/advanced/folder/list",
            json!({ "cwd": cwd, "folder": "team-notes" }),
        )
        .await,
    );
    assert!(
        has_body(&team, "tabs over spaces"),
        "the extracted memory belongs in the target folder: {team:?}"
    );
    assert!(has_body(&team, "Team says emacs."), "{team:?}");
    assert!(!has_body(&team, "Workspace says vim."), "{team:?}");
    assert!(
        !has_body(&team, "Only in the workspace folder."),
        "workspace memories must not be copied: {team:?}"
    );
    assert_eq!(team.len(), 2, "{team:?}");

    let workspace = memories(
        &rpc(
            &mut ws,
            "ws-list",
            "cowork/memory/advanced/list",
            json!({ "cwd": cwd }),
        )
        .await,
    );
    assert!(
        !has_body(&workspace, "tabs over spaces"),
        "extraction must not land in the workspace folder: {workspace:?}"
    );
    assert_eq!(workspace.len(), 2, "{workspace:?}");
    server.shutdown().await;
}
