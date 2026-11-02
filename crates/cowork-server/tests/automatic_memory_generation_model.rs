//! Automatic advanced-memory generation after a completed turn (TS `triggerMemoryGeneration` →
//! `runMemoryGenerationOnce` → `MemoryGenerator.run`) resolves its model like explicit
//! generation does: `memoryGenerationModel`, else the preferred child model, else the thread's
//! own model (`MemoryGenerator.resolveTargetConfig`). Without a configured memory model the
//! transcript must still reach a model, and the persisted cursor advances only when the
//! extraction succeeds.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
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
    /// When set, memory extraction requests to the chat endpoint answer 500.
    memory_fail: Arc<AtomicBool>,
    /// When set, the first memory extraction answers after `SLOW_FIRST_MEMORY` and later ones
    /// after `SLOW_LATER_MEMORY`, so a newer extraction would overtake an older one.
    memory_slow: Arc<AtomicBool>,
    /// Memory extraction requests currently awaiting their response, and the peak of that.
    memory_in_flight: Arc<AtomicUsize>,
    memory_max_in_flight: Arc<AtomicUsize>,
}

const SLOW_FIRST_MEMORY: Duration = Duration::from_millis(2_000);
const SLOW_LATER_MEMORY: Duration = Duration::from_millis(100);

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
            .prefix("cowork-auto-memgen-")
            .tempdir()
            .unwrap();
        let base = fs::canonicalize(root.path()).unwrap();
        let home = base.join("home");
        let workspace = base.join("workspace");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&workspace).unwrap();

        let chat: Arc<Mutex<Vec<Value>>> = Arc::default();
        let memory_fail = Arc::new(AtomicBool::new(false));
        let memory_slow = Arc::new(AtomicBool::new(false));
        let memory_in_flight = Arc::new(AtomicUsize::new(0));
        let memory_max_in_flight = Arc::new(AtomicUsize::new(0));
        let chat_route = Arc::clone(&chat);
        let fail_route = Arc::clone(&memory_fail);
        let slow_route = Arc::clone(&memory_slow);
        let in_flight_route = Arc::clone(&memory_in_flight);
        let max_in_flight_route = Arc::clone(&memory_max_in_flight);
        let app = Router::new().route(
            "/v1/chat/completions",
            post(move |body: axum::body::Bytes| {
                let chat = Arc::clone(&chat_route);
                let fail = Arc::clone(&fail_route);
                let slow = Arc::clone(&slow_route);
                let in_flight = Arc::clone(&in_flight_route);
                let max_in_flight = Arc::clone(&max_in_flight_route);
                async move {
                    let parsed: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                    let memory = is_memory_request(&parsed);
                    let memory_ordinal = {
                        let mut chat = chat.lock().unwrap();
                        chat.push(parsed);
                        chat.iter().filter(|b| is_memory_request(b)).count()
                    };
                    if memory && slow.load(Ordering::SeqCst) {
                        let now = in_flight.fetch_add(1, Ordering::SeqCst) + 1;
                        max_in_flight.fetch_max(now, Ordering::SeqCst);
                        tokio::time::sleep(if memory_ordinal == 1 {
                            SLOW_FIRST_MEMORY
                        } else {
                            SLOW_LATER_MEMORY
                        })
                        .await;
                        in_flight.fetch_sub(1, Ordering::SeqCst);
                    }
                    if memory && fail.load(Ordering::SeqCst) {
                        return Response::builder()
                            .status(StatusCode::INTERNAL_SERVER_ERROR)
                            .body(Body::from("{\"error\":{\"message\":\"boom\"}}"))
                            .unwrap();
                    }
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
            memory_fail,
            memory_slow,
            memory_in_flight,
            memory_max_in_flight,
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

    /// Waits until at least `count` memory extraction requests reached the mock.
    async fn await_memory_requests(&self, count: usize) -> Vec<Value> {
        for _ in 0..200 {
            let requests = self.memory_requests();
            if requests.len() >= count {
                return requests;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!(
            "expected {count} memory extraction request(s), got {}",
            self.memory_requests().len()
        );
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
                "clientInfo": { "name": "auto-memgen", "version": "1.0.0" },
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

/// Without `memoryGenerationModel`, a completed turn's transcript is analyzed by the thread's
/// own model, and the cursor advances after that extraction succeeds.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn automatic_generation_without_memory_model_uses_the_thread_model() {
    let env = Env::new().await;
    let server = start_server(env.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let cwd = env.cwd();
    let thread_id = start_thread(&mut ws, &cwd).await;
    set_config(&mut ws, &thread_id, json!({ "advancedMemory": true })).await;

    run_turn(&mut ws, "turn-1", &thread_id, PREFERENCE).await;
    let memory = env.await_memory_requests(1).await;
    assert_eq!(memory[0]["model"], json!(CHAT_MODEL));
    assert!(
        memory[0].to_string().contains("tabs over spaces"),
        "the ordinary preference must reach the memory model: {}",
        memory[0]
    );
    assert!(await_cursor_at_end(&server, &thread_id).await > 0);
    server.shutdown().await;
}

/// A failed automatic extraction leaves the cursor in place, so the next completed turn sends
/// the unprocessed preference to the model again.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn failed_automatic_generation_keeps_the_cursor_for_the_next_turn() {
    let env = Env::new().await;
    let server = start_server(env.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let cwd = env.cwd();
    let thread_id = start_thread(&mut ws, &cwd).await;
    set_config(&mut ws, &thread_id, json!({ "advancedMemory": true })).await;

    env.memory_fail.store(true, Ordering::SeqCst);
    run_turn(&mut ws, "turn-1", &thread_id, PREFERENCE).await;
    env.await_memory_requests(1).await;
    // Give the background task time to (wrongly) checkpoint after the failed request.
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(
        memory_cursor(&server, &thread_id).0,
        0,
        "a failed extraction must not advance the cursor"
    );

    let failed = env.memory_requests().len();

    env.memory_fail.store(false, Ordering::SeqCst);
    run_turn(&mut ws, "turn-2", &thread_id, "Thanks, carry on.").await;
    let memory = env.await_memory_requests(failed + 1).await;
    let retry = &memory[failed];
    assert!(
        retry.to_string().contains("tabs over spaces"),
        "the unprocessed preference must be retried: {retry}"
    );
    await_cursor_at_end(&server, &thread_id).await;
    server.shutdown().await;
}

/// Back-to-back turns queue their extractions on the thread's generation queue (TS
/// `memoryGenerationQueue`): the second starts only after the first committed, reads the cursor
/// the first advanced, and so sends only the second turn's messages. A slower earlier
/// extraction can never overwrite a later checkpoint, so the final cursor covers the whole
/// transcript, and the queue entry is released once the thread is idle.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn back_to_back_turns_serialize_memory_generation_per_thread() {
    const FIRST: &str = "I prefer tabs over spaces in this repository. MARKER-ALPHA";
    const SECOND: &str = "I also prefer rebasing over merge commits. MARKER-BRAVO";

    let env = Env::new().await;
    env.memory_slow.store(true, Ordering::SeqCst);
    let server = start_server(env.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let cwd = env.cwd();
    let thread_id = start_thread(&mut ws, &cwd).await;
    set_config(&mut ws, &thread_id, json!({ "advancedMemory": true })).await;

    run_turn(&mut ws, "turn-1", &thread_id, FIRST).await;
    env.await_memory_requests(1).await;
    run_turn(&mut ws, "turn-2", &thread_id, SECOND).await;
    assert_eq!(
        env.memory_in_flight.load(Ordering::SeqCst),
        1,
        "the second turn must complete while the first extraction is still running"
    );
    assert_eq!(
        env.memory_requests().len(),
        1,
        "the second extraction must wait for the first instead of starting alongside it"
    );

    let requests = env.await_memory_requests(2).await;
    let end = await_cursor_at_end(&server, &thread_id).await;
    for _ in 0..100 {
        if env.memory_in_flight.load(Ordering::SeqCst) == 0
            && server.runtime().memory_generation_queue_count() == 0
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    // Leave room for a stray duplicate extraction or a late checkpoint regression to land.
    tokio::time::sleep(SLOW_LATER_MEMORY * 3).await;

    assert_eq!(
        env.memory_max_in_flight.load(Ordering::SeqCst),
        1,
        "extractions on one thread must not overlap"
    );
    let all = env.memory_requests();
    assert_eq!(all.len(), 2, "one extraction per turn: {all:?}");
    let (first, second) = (requests[0].to_string(), requests[1].to_string());
    assert!(first.contains("MARKER-ALPHA"), "first extraction: {first}");
    assert!(!first.contains("MARKER-BRAVO"), "first extraction: {first}");
    assert!(
        second.contains("MARKER-BRAVO"),
        "second extraction: {second}"
    );
    assert!(
        !second.contains("MARKER-ALPHA"),
        "the second extraction must start from the first one's cursor: {second}"
    );
    let (cursor, len) = memory_cursor(&server, &thread_id);
    assert_eq!(cursor, end, "the final cursor must not regress");
    assert_eq!(cursor, len, "the final cursor covers the whole transcript");
    assert_eq!(
        server.runtime().memory_generation_queue_count(),
        0,
        "an idle thread keeps no generation queue entry"
    );
    server.shutdown().await;
}
