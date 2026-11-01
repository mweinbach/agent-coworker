//! Explicit advanced-memory generation (`cowork/memory/advanced/generate` and its folder
//! variant) runs model-based extraction like TS `generateAdvancedMemoryForHistory` →
//! `MemoryGenerator.run`: the configured `memoryGenerationModel`, else the thread's own model.
//! A failed extraction must leave the transcript cursor where it was, so the history stays
//! eligible for extraction.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
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

struct Env {
    _root: TempDir,
    home: PathBuf,
    workspace: PathBuf,
    env: HashMap<String, String>,
    /// Requests to the chat provider (nvidia) endpoint.
    chat: Arc<Mutex<Vec<Value>>>,
    /// Requests to the memory provider (together) endpoint.
    together: Arc<Mutex<Vec<Value>>>,
    /// When set, the together endpoint answers 500.
    together_fail: Arc<AtomicBool>,
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
            .prefix("cowork-explicit-memgen-")
            .tempdir()
            .unwrap();
        let base = fs::canonicalize(root.path()).unwrap();
        let home = base.join("home");
        let workspace = base.join("workspace");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&workspace).unwrap();

        let chat: Arc<Mutex<Vec<Value>>> = Arc::default();
        let together: Arc<Mutex<Vec<Value>>> = Arc::default();
        let together_fail = Arc::new(AtomicBool::new(false));
        let chat_route = Arc::clone(&chat);
        let together_route = Arc::clone(&together);
        let fail_route = Arc::clone(&together_fail);
        let app = Router::new()
            .route(
                "/together/v1/chat/completions",
                post(move |body: axum::body::Bytes| {
                    let together = Arc::clone(&together_route);
                    let fail = Arc::clone(&fail_route);
                    async move {
                        let parsed: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                        together.lock().unwrap().push(parsed);
                        if fail.load(Ordering::SeqCst) {
                            return Response::builder()
                                .status(StatusCode::INTERNAL_SERVER_ERROR)
                                .body(Body::from("{\"error\":{\"message\":\"boom\"}}"))
                                .unwrap();
                        }
                        sse_ok("Prefers tabs over spaces in this repository.")
                    }
                }),
            )
            .route(
                "/v1/chat/completions",
                post(move |body: axum::body::Bytes| {
                    let chat = Arc::clone(&chat_route);
                    async move {
                        let parsed: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                        let memory = is_memory_request(&parsed);
                        chat.lock().unwrap().push(parsed);
                        sse_ok(if memory { "NONE" } else { "Noted." })
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
            chat,
            together,
            together_fail,
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

    fn together_requests(&self) -> Vec<Value> {
        self.together.lock().unwrap().clone()
    }

    fn chat_memory_requests(&self) -> Vec<Value> {
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
                "clientInfo": { "name": "explicit-memgen", "version": "1.0.0" },
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

/// Runs one turn with automatic memory generation off, so the history stays unprocessed.
async fn run_turn(ws: &mut WsStream, thread_id: &str, text: &str) {
    let mut notifs = Vec::new();
    let res = call_collecting(
        ws,
        "turn",
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

/// A thread with unprocessed history (automatic generation was off during the turn).
async fn thread_with_history(ws: &mut WsStream, cwd: &str) -> String {
    let thread_id = start_thread(ws, cwd).await;
    set_config(ws, &thread_id, json!({ "advancedMemory": false })).await;
    run_turn(
        ws,
        &thread_id,
        "I prefer tabs over spaces in this repository.",
    )
    .await;
    thread_id
}

/// `memoryGenerationModel` is honoured by explicit generation, and a failed extraction does not
/// mark the history processed.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn explicit_generate_uses_configured_memory_model_and_keeps_cursor_on_failure() {
    let env = Env::new().await;
    let server = start_server(env.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let cwd = env.cwd();
    let thread_id = thread_with_history(&mut ws, &cwd).await;
    assert_eq!(memory_cursor(&server, &thread_id).0, 0);
    set_config(
        &mut ws,
        &thread_id,
        json!({ "advancedMemory": true, "memoryGenerationModel": "together:mem-model" }),
    )
    .await;

    // The memory model fails: the call errors and the cursor stays put.
    env.together_fail.store(true, Ordering::SeqCst);
    let res = call(
        &mut ws,
        "gen-1",
        "cowork/memory/advanced/generate",
        json!({ "cwd": cwd, "threadId": thread_id }),
    )
    .await;
    assert!(res.get("error").is_some(), "{res}");
    assert_eq!(
        env.together_requests().len(),
        1,
        "memory model must be called"
    );
    assert_eq!(env.together_requests()[0]["model"], json!("mem-model"));
    assert_eq!(
        memory_cursor(&server, &thread_id).0,
        0,
        "a failed extraction must not advance the cursor"
    );

    // Retried via the folder variant once the model works: the same history is analyzed again.
    env.together_fail.store(false, Ordering::SeqCst);
    let res = call(
        &mut ws,
        "gen-2",
        "cowork/memory/advanced/folder/generate",
        json!({ "cwd": cwd, "threadId": thread_id, "folder": "team-notes" }),
    )
    .await;
    assert!(res.get("error").is_none(), "{res}");
    let together = env.together_requests();
    assert_eq!(together.len(), 2, "history must be retried: {together:?}");
    assert!(
        together[1].to_string().contains("tabs over spaces"),
        "the unprocessed preference must reach the memory model: {}",
        together[1]
    );
    let (cursor, len) = memory_cursor(&server, &thread_id);
    assert_eq!(cursor, len, "a successful extraction advances the cursor");
    // The chat provider never served the memory request.
    assert!(env.chat_memory_requests().is_empty());
    server.shutdown().await;
}

/// Without `memoryGenerationModel`, TS `MemoryGenerator.resolveTargetConfig` falls back to the
/// thread's model, so extraction still runs on the thread's own provider.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn explicit_generate_without_memory_model_uses_the_thread_model() {
    let env = Env::new().await;
    let server = start_server(env.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let cwd = env.cwd();
    let thread_id = thread_with_history(&mut ws, &cwd).await;
    set_config(&mut ws, &thread_id, json!({ "advancedMemory": true })).await;

    let res = call(
        &mut ws,
        "gen",
        "cowork/memory/advanced/generate",
        json!({ "cwd": cwd, "threadId": thread_id }),
    )
    .await;
    assert!(res.get("error").is_none(), "{res}");
    let memory = env.chat_memory_requests();
    assert_eq!(memory.len(), 1, "thread model must run the extraction");
    assert_eq!(memory[0]["model"], json!(CHAT_MODEL));
    assert!(env.together_requests().is_empty());
    let (cursor, len) = memory_cursor(&server, &thread_id);
    assert_eq!(cursor, len);
    server.shutdown().await;
}

/// With advanced memory off, explicit generation is a no-op (TS `runMemoryBackfill`): nothing
/// leaves the process and the cursor stays put.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn explicit_generate_is_a_noop_with_advanced_memory_off() {
    let env = Env::new().await;
    let server = start_server(env.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let cwd = env.cwd();
    let thread_id = thread_with_history(&mut ws, &cwd).await;
    set_config(
        &mut ws,
        &thread_id,
        json!({ "memoryGenerationModel": "together:mem-model" }),
    )
    .await;

    let res = call(
        &mut ws,
        "gen",
        "cowork/memory/advanced/generate",
        json!({ "cwd": cwd, "threadId": thread_id }),
    )
    .await;
    assert!(res.get("error").is_none(), "{res}");
    assert!(env.together_requests().is_empty());
    assert!(env.chat_memory_requests().is_empty());
    assert_eq!(memory_cursor(&server, &thread_id).0, 0);
    server.shutdown().await;
}
