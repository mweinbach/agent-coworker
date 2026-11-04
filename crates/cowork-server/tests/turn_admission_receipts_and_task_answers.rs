//! Turn admission and delivery guarantees across turn boundaries:
//! - a retried answer to a server request resolved in an earlier turn is still recognized as a
//!   duplicate (or a conflict) after the next turn starts;
//! - a `turn/interrupt` that arrives while a reserved turn is still being set up stops that turn
//!   before it reaches the provider;
//! - a child agent's direct `turn/start` and its parent's `AgentControl` input share one turn
//!   reservation, so whichever comes second is rejected;
//! - a task answer steered into a turn that then stops without taking it (a blocking question)
//!   is delivered by a follow-up turn instead of being acknowledged and lost;
//! - a turn never starts with a workspace config that cannot be loaded (fail closed: a broken
//!   config must not widen a read-only sandbox to the permissive default);
//! - LM Studio turns apply model preparation (context-length reload) before inference.

#![recursion_limit = "256"]

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::http::{Response, StatusCode};
use axum::routing::{get, post};
use cowork_protocol::WEBSOCKET_SUBPROTOCOL;
use cowork_server::{ServerOptions, start_server};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::net::TcpListener;
use tokio::sync::Notify;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

const PROVIDER: &str = "nvidia";
const MODEL: &str = "moonshotai/kimi-k2-instruct";

struct Iso {
    _root: TempDir,
    workspace: PathBuf,
    home: PathBuf,
    env: HashMap<String, String>,
}

impl Iso {
    fn new(prefix: &str) -> Self {
        let root = tempfile::Builder::new()
            .prefix(prefix)
            .tempdir_in(std::env::temp_dir())
            .unwrap();
        let base = fs::canonicalize(root.path()).unwrap();
        let home = base.join("home");
        let workspace = base.join("workspace");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(workspace.join(".cowork")).unwrap();
        let mut env = HashMap::new();
        env.insert("HOME".into(), home.to_string_lossy().into_owned());
        env.insert(
            "COWORK_HOME_OVERRIDE".into(),
            home.join(".cowork").to_string_lossy().into_owned(),
        );
        env.insert(
            "COWORK_ELECTRON_USER_DATA_DIR".into(),
            base.join("electron").to_string_lossy().into_owned(),
        );
        env.insert(
            "COWORK_DESKTOP_USER_DATA_DIR".into(),
            base.join("desktop").to_string_lossy().into_owned(),
        );
        env.insert("COWORK_DISABLE_RUNTIME".into(), "1".into());
        env.insert("COWORK_RUNTIME_ALLOW_NETWORK".into(), "0".into());
        env.insert("PATH".into(), "/usr/local/bin:/usr/bin:/bin".into());
        Self {
            _root: root,
            workspace,
            home,
            env,
        }
    }

    fn cwd(&self) -> String {
        self.workspace.to_string_lossy().into_owned()
    }

    fn write_user_config(&self, cfg: Value) {
        let dir = self.home.join(".cowork").join("config");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("config.json"),
            serde_json::to_string_pretty(&cfg).unwrap(),
        )
        .unwrap();
    }

    fn options(&self, yolo: bool) -> ServerOptions {
        ServerOptions {
            working_directory: self.workspace.clone(),
            host: "127.0.0.1".into(),
            port: 0,
            yolo,
            mobile_h3: false,
            mobile_h3_host: "127.0.0.1".into(),
            mobile_h3_port: 0,
            homedir: Some(self.home.clone()),
            built_in_dir: Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")),
            env: self.env.clone(),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Mock chat-completions provider
// ---------------------------------------------------------------------------------------------

fn sse_tool_calls(calls: &[(&str, &str, Value)]) -> String {
    let delta_calls: Vec<Value> = calls
        .iter()
        .enumerate()
        .map(|(idx, (id, name, args))| {
            json!({
                "index": idx,
                "id": id,
                "type": "function",
                "function": { "name": name, "arguments": args.to_string() }
            })
        })
        .collect();
    let chunk = json!({
        "id": "cmpl-tc",
        "choices": [{ "index": 0, "delta": { "role": "assistant", "tool_calls": delta_calls } }]
    });
    let done = json!({
        "id": "cmpl-tc",
        "choices": [{ "index": 0, "delta": {}, "finish_reason": "tool_calls" }],
        "usage": { "prompt_tokens": 20, "completion_tokens": 10, "total_tokens": 30 }
    });
    format!("data: {chunk}\n\ndata: {done}\n\ndata: [DONE]\n\n")
}

fn sse_text(text: &str) -> String {
    let chunk = json!({
        "id": "cmpl-txt",
        "choices": [{ "index": 0, "delta": { "role": "assistant", "content": text } }]
    });
    let done = json!({
        "id": "cmpl-txt",
        "choices": [{ "index": 0, "delta": {}, "finish_reason": "stop" }],
        "usage": { "prompt_tokens": 25, "completion_tokens": 8, "total_tokens": 33 }
    });
    format!("data: {chunk}\n\ndata: {done}\n\ndata: [DONE]\n\n")
}

fn sse_response(payload: String) -> axum::response::Response {
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .body(Body::from(payload))
        .unwrap()
}

fn json_response(value: Value) -> axum::response::Response {
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(value.to_string()))
        .unwrap()
}

#[derive(Clone, Default)]
struct ChatMock {
    bodies: Arc<Mutex<Vec<Value>>>,
    /// Signalled (with a stored permit) when a `HOLD` request arrives.
    held: Arc<Notify>,
    /// Releases every held `HOLD` request.
    release: Arc<Notify>,
}

impl ChatMock {
    fn requests_containing(&self, needle: &str) -> usize {
        self.bodies
            .lock()
            .unwrap()
            .iter()
            .filter(|b| b["messages"].to_string().contains(needle))
            .count()
    }
}

/// The last user message carrying `ASK` asks a question, `HOLD` holds the model call until
/// released, and `WRITE_IT` writes `blocked.txt` in `write_target`; everything else (tool
/// follow-ups, titles) answers `Done`.
async fn start_chat_mock(iso: &mut Iso) -> ChatMock {
    let mock = ChatMock::default();
    let state = mock.clone();
    let write_target = iso.workspace.join("blocked.txt");
    let app = Router::new().route(
        "/v1/chat/completions",
        post(move |body: Bytes| {
            let state = state.clone();
            let write_target = write_target.clone();
            async move {
                let req: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                state.bodies.lock().unwrap().push(req.clone());
                let messages = req["messages"].as_array().cloned().unwrap_or_default();
                let has_tools = req["tools"].as_array().is_some_and(|t| !t.is_empty());
                let last_user_idx = messages.iter().rposition(|m| m["role"] == "user");
                let answered = last_user_idx
                    .is_some_and(|i| messages[i..].iter().any(|m| m["role"] == "tool"));
                let last_user = last_user_idx
                    .map(|i| messages[i]["content"].to_string())
                    .unwrap_or_default();
                if has_tools && !answered && last_user.contains("ASK") {
                    return sse_response(sse_tool_calls(&[(
                        "call_ask_1",
                        "AskUserQuestion",
                        json!({
                            "questions": [{
                                "id": "env",
                                "header": "Environment",
                                "question": "Which environment should we target?",
                                "options": [
                                    { "label": "staging", "description": "Staging" },
                                    { "label": "prod", "description": "Production" }
                                ]
                            }]
                        }),
                    )]));
                }
                if has_tools && !answered && last_user.contains("WRITE_IT") {
                    return sse_response(sse_tool_calls(&[(
                        "call_write_1",
                        "write",
                        json!({
                            "filePath": write_target.to_string_lossy(),
                            "content": "must never be written"
                        }),
                    )]));
                }
                if has_tools && !answered && last_user.contains("HOLD") {
                    let released = state.release.notified();
                    state.held.notify_one();
                    released.await;
                    return sse_response(sse_text("held"));
                }
                sse_response(sse_text("Done"))
            }
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    iso.env.insert(
        "NVIDIA_BASE_URL".into(),
        format!("http://127.0.0.1:{port}/v1"),
    );
    iso.env
        .insert("NVIDIA_API_KEY".into(), "nvapi-mock-test".into());
    mock
}

// ---------------------------------------------------------------------------------------------
// WebSocket helpers
// ---------------------------------------------------------------------------------------------

async fn connect(ws_url: &str) -> WsStream {
    let mut req = ws_url.into_client_request().unwrap();
    req.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        WEBSOCKET_SUBPROTOCOL.parse().unwrap(),
    );
    let (mut ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();
    ws.send(WsMessage::Text(
        json!({
            "id": "init",
            "method": "initialize",
            "params": {
                "clientInfo": { "name": "turn-admission-and-receipts", "version": "1.0.0" },
                "capabilities": { "experimentalApi": true }
            }
        })
        .to_string()
        .into(),
    ))
    .await
    .unwrap();
    let _ = ws.next().await.unwrap().unwrap();
    ws.send(WsMessage::Text(
        json!({ "method": "initialized", "params": {} })
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    ws
}

async fn send(ws: &mut WsStream, frame: Value) {
    ws.send(WsMessage::Text(frame.to_string().into()))
        .await
        .unwrap();
}

async fn next_frame(ws: &mut WsStream, wait: Duration) -> Option<Value> {
    loop {
        let frame = tokio::time::timeout(wait, ws.next()).await.ok()??.ok()?;
        if let WsMessage::Text(txt) = frame {
            return serde_json::from_str(&txt).ok();
        }
    }
}

/// Sends a request and returns its response; every other frame seen meanwhile lands in
/// `frames`.
async fn call(
    ws: &mut WsStream,
    id: &str,
    method: &str,
    params: Value,
    frames: &mut Vec<Value>,
) -> Value {
    send(ws, json!({ "id": id, "method": method, "params": params })).await;
    loop {
        let val = next_frame(ws, Duration::from_secs(30))
            .await
            .unwrap_or_else(|| panic!("timed out waiting for {method} response"));
        if val.get("id") == Some(&json!(id)) && val.get("method").is_none() {
            return val;
        }
        frames.push(val);
    }
}

/// Collects frames until `pred` matches one (returned) or `wait` elapses.
async fn wait_for(
    ws: &mut WsStream,
    frames: &mut Vec<Value>,
    wait: Duration,
    pred: impl Fn(&Value) -> bool,
) -> Option<Value> {
    if let Some(found) = frames.iter().find(|f| pred(f)) {
        return Some(found.clone());
    }
    let deadline = tokio::time::Instant::now() + wait;
    loop {
        let rem = deadline.saturating_duration_since(tokio::time::Instant::now());
        let val = next_frame(ws, rem).await?;
        let hit = pred(&val);
        frames.push(val.clone());
        if hit {
            return Some(val);
        }
    }
}

async fn start_thread(ws: &mut WsStream, cwd: &str, provider: &str, model: &str) -> String {
    let mut frames = Vec::new();
    let res = call(
        ws,
        "start",
        "thread/start",
        json!({ "cwd": cwd, "provider": provider, "model": model }),
        &mut frames,
    )
    .await;
    res["result"]["thread"]["id"]
        .as_str()
        .unwrap_or_else(|| panic!("thread/start failed: {res}"))
        .to_owned()
}

fn is_turn_completed(frame: &Value, turn_id: &str) -> bool {
    frame["method"] == "turn/completed" && frame["params"]["turn"]["id"] == turn_id
}

/// Starts a turn and waits for its `turn/completed`, declining any approval it asks for.
/// Returns the completed turn's status.
async fn run_turn(ws: &mut WsStream, id: &str, thread_id: &str, input: &str) -> String {
    let mut frames = Vec::new();
    let res = call(
        ws,
        id,
        "turn/start",
        json!({ "threadId": thread_id, "input": input }),
        &mut frames,
    )
    .await;
    let turn_id = res["result"]["turn"]["id"]
        .as_str()
        .unwrap_or_else(|| panic!("turn/start failed: {res}"))
        .to_owned();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        if let Some(done) = frames.iter().find(|f| is_turn_completed(f, &turn_id)) {
            return done["params"]["turn"]["status"]
                .as_str()
                .unwrap_or_default()
                .to_owned();
        }
        for approval in frames
            .iter()
            .filter(|f| {
                f.get("id").is_some()
                    && f["method"]
                        .as_str()
                        .is_some_and(|m| m.ends_with("requestApproval"))
            })
            .cloned()
            .collect::<Vec<_>>()
        {
            send(
                ws,
                json!({ "id": approval["id"], "result": { "decision": "decline" } }),
            )
            .await;
        }
        frames.retain(|f| {
            !(f.get("id").is_some()
                && f["method"]
                    .as_str()
                    .is_some_and(|m| m.ends_with("requestApproval")))
        });
        let rem = deadline.saturating_duration_since(tokio::time::Instant::now());
        let val = next_frame(ws, rem)
            .await
            .unwrap_or_else(|| panic!("turn {turn_id} never completed"));
        frames.push(val);
    }
}

// ---------------------------------------------------------------------------------------------
// Server-request receipts across turns
// ---------------------------------------------------------------------------------------------

/// The next turn replaces the thread's interaction manager; an answer the client retries just
/// after it starts must still be recognized from the earlier turn's receipt, not reported as an
/// unknown request.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn resolved_request_receipt_survives_the_next_turn() {
    let mut iso = Iso::new("cowork-receipt-turns-");
    let _mock = start_chat_mock(&mut iso).await;
    let server = start_server(iso.options(false)).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let thread_id = start_thread(&mut ws, &iso.cwd(), PROVIDER, MODEL).await;

    let mut frames = Vec::new();
    let res = call(
        &mut ws,
        "turn-ask",
        "turn/start",
        json!({ "threadId": thread_id, "input": "ASK me which environment to use." }),
        &mut frames,
    )
    .await;
    let ask_turn = res["result"]["turn"]["id"].as_str().unwrap().to_owned();
    let ask = wait_for(&mut ws, &mut frames, Duration::from_secs(20), |f| {
        f["method"] == "item/tool/requestUserInput" && f.get("id").is_some()
    })
    .await
    .unwrap_or_else(|| panic!("never received requestUserInput: {frames:?}"));
    let request_id = ask["id"].clone();
    send(
        &mut ws,
        json!({ "id": request_id, "result": { "answer": "staging" } }),
    )
    .await;
    wait_for(&mut ws, &mut frames, Duration::from_secs(20), |f| {
        is_turn_completed(f, &ask_turn)
    })
    .await
    .unwrap_or_else(|| panic!("asking turn never completed: {frames:?}"));

    // The next turn installs a fresh interaction manager.
    assert_eq!(
        run_turn(&mut ws, "turn-next", &thread_id, "hello again").await,
        "completed"
    );

    // Retrying the identical answer is a recognized duplicate...
    send(
        &mut ws,
        json!({ "id": request_id, "result": { "answer": "staging" } }),
    )
    .await;
    let mut retry_frames = Vec::new();
    let resolved = wait_for(&mut ws, &mut retry_frames, Duration::from_secs(10), |f| {
        (f["method"] == "serverRequest/resolved" && f["params"]["requestId"] == request_id)
            || (f.get("method").is_none() && f["id"] == request_id)
    })
    .await
    .unwrap_or_else(|| panic!("no reply to the retried answer: {retry_frames:?}"));
    assert_eq!(
        resolved["method"], "serverRequest/resolved",
        "a retried answer after the next turn started must be recognized as a duplicate: {resolved}"
    );

    // ...and a different answer is a conflict, not an unknown request.
    send(
        &mut ws,
        json!({ "id": request_id, "result": { "answer": "prod" } }),
    )
    .await;
    let conflict = wait_for(&mut ws, &mut retry_frames, Duration::from_secs(10), |f| {
        f.get("method").is_none() && f["id"] == request_id
    })
    .await
    .unwrap_or_else(|| panic!("no reply to the conflicting answer: {retry_frames:?}"));
    assert_eq!(conflict["error"]["code"], -32602, "{conflict}");
    assert_eq!(
        conflict["error"]["data"]["category"], "interaction_response_conflict",
        "{conflict}"
    );

    server.shutdown().await;
}

// ---------------------------------------------------------------------------------------------
// LM Studio: setup-phase interrupt and model preparation
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Default)]
struct LmStudioMock {
    /// Delay for the OpenAI-compatible `/v1/models` probe (the turn's reachability gate).
    probe_delay_ms: Arc<AtomicU64>,
    probe_started: Arc<Notify>,
    /// Ordered `load`/`unload`/`chat` calls.
    calls: Arc<Mutex<Vec<(String, Value)>>>,
    chat_requests: Arc<AtomicUsize>,
}

const LMS_MODEL: &str = "alpha-coder";

async fn start_lmstudio_mock(iso: &mut Iso, loaded_context_length: u64) -> LmStudioMock {
    let mock = LmStudioMock::default();
    let probe = mock.clone();
    let unload = mock.clone();
    let load = mock.clone();
    let chat = mock.clone();
    let app = Router::new()
        .route(
            "/v1/models",
            get(move || {
                let probe = probe.clone();
                async move {
                    probe.probe_started.notify_one();
                    let delay = probe.probe_delay_ms.load(Ordering::SeqCst);
                    if delay > 0 {
                        tokio::time::sleep(Duration::from_millis(delay)).await;
                    }
                    json_response(json!({
                        "object": "list",
                        "data": [{ "id": LMS_MODEL, "object": "model", "owned_by": "me" }]
                    }))
                }
            }),
        )
        .route(
            "/api/v1/models",
            get(move || async move {
                json_response(json!({
                    "models": [{
                        "key": LMS_MODEL,
                        "type": "llm",
                        "display_name": "Alpha Coder",
                        "max_context_length": 32768,
                        "loaded_instances": [{
                            "id": "alpha-coder:1",
                            "config": { "context_length": loaded_context_length }
                        }]
                    }]
                }))
            }),
        )
        .route(
            "/api/v1/models/unload",
            post(move |body: Bytes| {
                let unload = unload.clone();
                async move {
                    let parsed: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                    unload
                        .calls
                        .lock()
                        .unwrap()
                        .push(("unload".to_owned(), parsed));
                    json_response(json!({ "instance_id": "alpha-coder:1" }))
                }
            }),
        )
        .route(
            "/api/v1/models/load",
            post(move |body: Bytes| {
                let load = load.clone();
                async move {
                    let parsed: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                    let ctx = parsed["context_length"].clone();
                    load.calls.lock().unwrap().push(("load".to_owned(), parsed));
                    json_response(json!({
                        "type": "llm",
                        "instance_id": "alpha-coder:2",
                        "status": "loaded",
                        "load_config": { "context_length": ctx }
                    }))
                }
            }),
        )
        .route(
            "/v1/chat/completions",
            post(move |body: Bytes| {
                let chat = chat.clone();
                async move {
                    let parsed: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                    chat.chat_requests.fetch_add(1, Ordering::SeqCst);
                    chat.calls.lock().unwrap().push(("chat".to_owned(), parsed));
                    sse_response(sse_text("Done"))
                }
            }),
        );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    iso.env.insert(
        "LM_STUDIO_BASE_URL".into(),
        format!("http://127.0.0.1:{port}"),
    );
    mock
}

/// `turn/start` reserves the thread before its async setup (here held open by a slow LM Studio
/// reachability probe). A `turn/interrupt` meanwhile must report the interrupt and the turn must
/// end `interrupted` without sending a model request.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn interrupt_during_turn_setup_stops_the_turn_before_the_provider() {
    let mut iso = Iso::new("cowork-setup-interrupt-");
    let lms = start_lmstudio_mock(&mut iso, 4096).await;
    let server = start_server(iso.options(true)).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let thread_id = start_thread(&mut ws, &iso.cwd(), "lmstudio", LMS_MODEL).await;

    lms.probe_delay_ms.store(1_500, Ordering::SeqCst);
    let probe_started = lms.probe_started.notified();
    send(
        &mut ws,
        json!({
            "id": "turn-slow",
            "method": "turn/start",
            "params": { "threadId": thread_id, "input": "Say hi" }
        }),
    )
    .await;
    tokio::time::timeout(Duration::from_secs(10), probe_started)
        .await
        .expect("turn setup never probed LM Studio");

    let mut frames = Vec::new();
    let interrupted = call(
        &mut ws,
        "interrupt",
        "turn/interrupt",
        json!({ "threadId": thread_id }),
        &mut frames,
    )
    .await;
    assert_eq!(
        interrupted["result"]["interrupted"],
        json!(true),
        "an interrupt during setup must be acknowledged: {interrupted}"
    );

    let started = wait_for(&mut ws, &mut frames, Duration::from_secs(15), |f| {
        f.get("method").is_none() && f["id"] == "turn-slow"
    })
    .await
    .unwrap_or_else(|| panic!("turn/start never answered: {frames:?}"));
    let turn_id = started["result"]["turn"]["id"]
        .as_str()
        .unwrap_or_else(|| panic!("turn/start failed: {started}"))
        .to_owned();
    let completed = wait_for(&mut ws, &mut frames, Duration::from_secs(15), |f| {
        is_turn_completed(f, &turn_id)
    })
    .await
    .unwrap_or_else(|| panic!("interrupted turn never completed: {frames:?}"));
    assert_eq!(completed["params"]["turn"]["status"], "interrupted");
    assert_eq!(
        lms.chat_requests.load(Ordering::SeqCst),
        0,
        "a turn interrupted during setup must not reach the provider"
    );

    server.shutdown().await;
}

/// A loaded LM Studio model whose context length differs from the requested `contextLength`
/// is reloaded with it before the first inference request (`reloadOnContextMismatch` default).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn lmstudio_turn_reloads_a_model_loaded_with_another_context_length() {
    let mut iso = Iso::new("cowork-lms-prepare-");
    let lms = start_lmstudio_mock(&mut iso, 4096).await;
    iso.env
        .insert("LM_STUDIO_CONTEXT_LENGTH".into(), "16384".into());
    let server = start_server(iso.options(true)).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let thread_id = start_thread(&mut ws, &iso.cwd(), "lmstudio", LMS_MODEL).await;

    assert_eq!(
        run_turn(&mut ws, "turn-lms", &thread_id, "Say hi").await,
        "completed"
    );

    let calls = lms.calls.lock().unwrap().clone();
    let kinds: Vec<&str> = calls.iter().map(|(k, _)| k.as_str()).collect();
    let unload_idx = kinds
        .iter()
        .position(|k| *k == "unload")
        .unwrap_or_else(|| panic!("the mismatched instance was never unloaded: {kinds:?}"));
    let load_idx = kinds
        .iter()
        .position(|k| *k == "load")
        .unwrap_or_else(|| panic!("the model was never reloaded: {kinds:?}"));
    let chat_idx = kinds
        .iter()
        .position(|k| *k == "chat")
        .unwrap_or_else(|| panic!("no inference request: {kinds:?}"));
    assert!(
        unload_idx < load_idx && load_idx < chat_idx,
        "reload must precede inference: {kinds:?}"
    );
    assert_eq!(calls[unload_idx].1["instance_id"], "alpha-coder:1");
    assert_eq!(calls[load_idx].1["model"], LMS_MODEL);
    assert_eq!(calls[load_idx].1["context_length"], 16384);

    server.shutdown().await;
}

// ---------------------------------------------------------------------------------------------
// Workspace config fail-closed
// ---------------------------------------------------------------------------------------------

/// A read-only user sandbox stays in force: when the workspace config turns into invalid JSON
/// the turn is refused (naming the file) instead of running under the permissive default, and
/// the refusal leaves the thread free for the next turn.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn unloadable_workspace_config_fails_the_turn_closed() {
    let mut iso = Iso::new("cowork-config-fail-closed-");
    let _mock = start_chat_mock(&mut iso).await;
    iso.write_user_config(json!({
        "provider": PROVIDER,
        "model": MODEL,
        "sandbox": { "mode": "read-only" }
    }));
    let target = iso.workspace.join("blocked.txt");
    let workspace_cfg = iso.workspace.join(".cowork").join("config.json");
    let server = start_server(iso.options(false)).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let thread_id = start_thread(&mut ws, &iso.cwd(), PROVIDER, MODEL).await;

    run_turn(&mut ws, "turn-1", &thread_id, "WRITE_IT now").await;
    assert!(
        !target.exists(),
        "the read-only sandbox must deny the write"
    );

    fs::write(&workspace_cfg, "{ this is not json").unwrap();
    let mut frames = Vec::new();
    let refused = call(
        &mut ws,
        "turn-2",
        "turn/start",
        json!({ "threadId": thread_id, "input": "WRITE_IT again" }),
        &mut frames,
    )
    .await;
    let message = refused["error"]["message"].as_str().unwrap_or_else(|| {
        panic!("a turn with an unloadable workspace config must be refused: {refused}")
    });
    assert!(
        message.contains(&*workspace_cfg.to_string_lossy()),
        "the error must name the bad file: {message}"
    );
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!target.exists(), "the write must never run");

    // The refused turn did not leave the thread reserved.
    fs::remove_file(&workspace_cfg).unwrap();
    run_turn(&mut ws, "turn-3", &thread_id, "WRITE_IT once more").await;
    assert!(!target.exists(), "the read-only sandbox still applies");

    server.shutdown().await;
}

// ---------------------------------------------------------------------------------------------
// Child turn reservation
// ---------------------------------------------------------------------------------------------

async fn child_busy(ws: &mut WsStream, parent: &str, child: &str, tag: &str) -> bool {
    let mut frames = Vec::new();
    let res = call(
        ws,
        &format!("insp-{tag}"),
        "cowork/session/agent/inspect",
        json!({ "threadId": parent, "agentId": child }),
        &mut frames,
    )
    .await;
    res["result"]["event"]["agent"]["busy"] == json!(true)
}

async fn wait_child_idle(ws: &mut WsStream, parent: &str, child: &str, tag: &str) {
    for i in 0..300 {
        if !child_busy(ws, parent, child, &format!("{tag}-{i}")).await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("child {child} never went idle ({tag})");
}

async fn spawn_child(ws: &mut WsStream, parent: &str, message: &str) -> String {
    let mut frames = Vec::new();
    let res = call(
        ws,
        "spawn",
        "cowork/session/agent/spawn",
        json!({ "threadId": parent, "message": message }),
        &mut frames,
    )
    .await;
    assert!(res.get("error").is_none(), "spawn failed: {res}");
    let spawned = wait_for(ws, &mut frames, Duration::from_secs(15), |f| {
        f["method"] == "cowork/session/agentSpawned"
    })
    .await
    .unwrap_or_else(|| panic!("no agentSpawned notification: {frames:?}"));
    spawned["params"]["agent"]["agentId"]
        .as_str()
        .unwrap()
        .to_owned()
}

/// A direct `turn/start` on a child and its parent's `agent/input/send` reserve the same thread:
/// while either runs, the other is rejected instead of running tools and persisting histories
/// for the same child concurrently.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn child_direct_turn_and_parent_input_share_one_reservation() {
    let mut iso = Iso::new("cowork-child-reservation-");
    let mock = start_chat_mock(&mut iso).await;
    let server = start_server(iso.options(true)).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let parent = start_thread(&mut ws, &iso.cwd(), PROVIDER, MODEL).await;

    let child = spawn_child(&mut ws, &parent, "FIRST child task").await;
    wait_child_idle(&mut ws, &parent, &child, "spawned").await;

    // 1. A direct turn on the child is running: the parent's input is rejected.
    let held = mock.held.notified();
    let mut frames = Vec::new();
    let direct = call(
        &mut ws,
        "direct",
        "turn/start",
        json!({ "threadId": child, "input": "HOLD_DIRECT" }),
        &mut frames,
    )
    .await;
    let direct_turn = direct["result"]["turn"]["id"]
        .as_str()
        .unwrap_or_else(|| panic!("direct turn/start failed: {direct}"))
        .to_owned();
    tokio::time::timeout(Duration::from_secs(15), held)
        .await
        .expect("direct child turn never reached the model");
    let rejected = call(
        &mut ws,
        "send-during-direct",
        "cowork/session/agent/input/send",
        json!({ "threadId": parent, "agentId": child, "message": "PARENT_DURING_DIRECT" }),
        &mut frames,
    )
    .await;
    assert!(
        rejected["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("already running a turn")),
        "parent input must be rejected while a direct child turn runs: {rejected}"
    );
    mock.release.notify_waiters();
    wait_for(&mut ws, &mut frames, Duration::from_secs(20), |f| {
        is_turn_completed(f, &direct_turn)
    })
    .await
    .unwrap_or_else(|| panic!("direct child turn never completed: {frames:?}"));
    assert_eq!(mock.requests_containing("PARENT_DURING_DIRECT"), 0);
    wait_child_idle(&mut ws, &parent, &child, "after-direct").await;

    // 2. A parent-driven run is in flight: a direct turn on the child is rejected.
    let held = mock.held.notified();
    let sent = call(
        &mut ws,
        "send-hold",
        "cowork/session/agent/input/send",
        json!({ "threadId": parent, "agentId": child, "message": "HOLD_EXEC" }),
        &mut frames,
    )
    .await;
    assert!(sent.get("error").is_none(), "input/send failed: {sent}");
    tokio::time::timeout(Duration::from_secs(15), held)
        .await
        .expect("parent-driven child run never reached the model");
    let refused = call(
        &mut ws,
        "direct-during-exec",
        "turn/start",
        json!({ "threadId": child, "input": "DIRECT_DURING_EXEC" }),
        &mut frames,
    )
    .await;
    assert!(
        refused["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("already in progress")),
        "a direct turn must be rejected while the parent drives the child: {refused}"
    );
    mock.release.notify_waiters();
    wait_child_idle(&mut ws, &parent, &child, "after-exec").await;
    assert_eq!(mock.requests_containing("DIRECT_DURING_EXEC"), 0);

    // 3. Once both settled, each path works again.
    let sent = call(
        &mut ws,
        "send-after",
        "cowork/session/agent/input/send",
        json!({ "threadId": parent, "agentId": child, "message": "PARENT_AFTER" }),
        &mut frames,
    )
    .await;
    assert!(sent.get("error").is_none(), "input/send failed: {sent}");
    wait_child_idle(&mut ws, &parent, &child, "after-send").await;
    assert_eq!(
        run_turn(&mut ws, "direct-after", &child, "DIRECT_AFTER").await,
        "completed"
    );

    server.shutdown().await;
}

// ---------------------------------------------------------------------------------------------
// Task answers steered into a stopping turn
// ---------------------------------------------------------------------------------------------

const TASK_ANSWER: &str = "Yes, target the Rust 2024 edition.";

/// A blocking task question stops the asking turn after its tool step, which rejects queued
/// steers. An answer that arrives after the question was published but before that turn exits
/// is admitted as a steer (`steered`); it must still reach the agent, through a follow-up turn.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn task_answer_steered_into_a_stopping_turn_is_still_delivered() {
    let mut iso = Iso::new("cowork-task-answer-follow-up-");
    iso.env.insert("COWORK_ENABLE_TASKS".into(), "1".into());

    let bodies: Arc<Mutex<Vec<Value>>> = Arc::default();
    let kickoff_done = Arc::new(AtomicBool::new(false));
    let bodies_route = Arc::clone(&bodies);
    let kickoff_route = Arc::clone(&kickoff_done);
    let app = Router::new().route(
        "/v1/chat/completions",
        post(move |body: Bytes| {
            let bodies = Arc::clone(&bodies_route);
            let kickoff = Arc::clone(&kickoff_route);
            async move {
                let req: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                let model = req["model"].as_str().unwrap_or_default().to_owned();
                if model.contains("mini") || model.contains("nano") {
                    return sse_response(sse_text("Task Title"));
                }
                bodies.lock().unwrap().push(req.clone());
                let messages = req["messages"].to_string();
                let system = req["messages"][0]["content"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned();
                if system.contains("## Active Task") {
                    // Kickoff step 0 (once): publish a blocking question, then keep the same
                    // tool step busy so the answer arrives before the turn stops.
                    if !kickoff.swap(true, Ordering::SeqCst) {
                        let revision = system
                            .lines()
                            .find_map(|l| l.strip_prefix("- Revision: "))
                            .and_then(|r| r.trim().parse::<i64>().ok())
                            .unwrap_or(1);
                        return sse_response(sse_tool_calls(&[
                            (
                                "call_pause_q",
                                "taskUpdate",
                                json!({
                                    "idempotencyKey": "req-input-follow-up",
                                    "type": "request_input",
                                    "expectedRevision": revision,
                                    "questions": [{
                                        "header": "Target",
                                        "question": "Should the deliverable target Rust 2024?",
                                        "urgency": "now",
                                        "blocking": true
                                    }]
                                }),
                            ),
                            (
                                "call_busy",
                                "bash",
                                json!({ "command": "sleep 3", "description": "Wait" }),
                            ),
                        ]));
                    }
                } else if messages.contains("PROMOTE_THIS_CHAT_NOW")
                    && !messages.contains("taskId")
                {
                    return sse_response(sse_tool_calls(&[(
                        "call_create_task",
                        "createTask",
                        json!({
                            "idempotencyKey": "follow-up-idem-1",
                            "title": "Ship Deliverable",
                            "objective": "Produce deliverable.md",
                            "context": "Promoted from chat",
                            "reviewRequired": false,
                            "reviewRounds": 0,
                            "requirements": [
                                { "kind": "acceptance_criterion", "text": "Create deliverable.md" }
                            ],
                            "workItems": [
                                { "key": "build", "title": "Write deliverable.md", "expectedOutputs": ["deliverable.md"] }
                            ]
                        }),
                    )]));
                }
                sse_response(sse_text("Done"))
            }
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    iso.env
        .insert("TOGETHER_API_KEY".into(), "together-test-key".into());
    iso.env.insert(
        "TOGETHER_BASE_URL".into(),
        format!("http://127.0.0.1:{port}/v1"),
    );
    iso.write_user_config(json!({
        "provider": "together",
        "model": "deepseek-ai/DeepSeek-V3"
    }));

    let server = start_server(iso.options(true)).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let mut frames = Vec::new();
    let started = call(
        &mut ws,
        "src-start",
        "thread/start",
        json!({ "cwd": iso.cwd() }),
        &mut frames,
    )
    .await;
    let source = started["result"]["thread"]["id"]
        .as_str()
        .unwrap_or_else(|| panic!("thread/start failed: {started}"))
        .to_owned();
    let promo = call(
        &mut ws,
        "src-turn",
        "turn/start",
        json!({ "threadId": source, "input": "PROMOTE_THIS_CHAT_NOW" }),
        &mut frames,
    )
    .await;
    assert!(
        promo.get("error").is_none(),
        "promotion turn failed: {promo}"
    );

    // The blocking question is published while the kickoff turn's tool step still runs.
    let blocked = wait_for(&mut ws, &mut frames, Duration::from_secs(20), |f| {
        f["method"] == "task/updated" && f["params"]["task"]["blockingQuestionCount"] == 1
    })
    .await
    .unwrap_or_else(|| panic!("the blocking question was never published: {frames:?}"));
    let task_id = blocked["params"]["task"]["id"].as_str().unwrap().to_owned();
    let read = call(
        &mut ws,
        "t-read",
        "task/read",
        json!({ "taskId": task_id }),
        &mut frames,
    )
    .await;
    let revision = read["result"]["task"]["revision"].as_i64().unwrap();
    let question_id = read["result"]["task"]["questions"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let resolved = call(
        &mut ws,
        "t-resolve",
        "task/questions/resolve",
        json!({
            "taskId": task_id,
            "expectedRevision": revision,
            "answers": [{ "questionId": question_id, "text": TASK_ANSWER }]
        }),
        &mut frames,
    )
    .await;
    assert!(
        resolved.get("error").is_none(),
        "questions/resolve failed: {resolved}"
    );
    assert_eq!(
        resolved["result"]["resumeStatus"], "steered",
        "the answer must arrive while the asking turn is still running: {resolved}"
    );

    // The kickoff turn stops after its tool step and rejects the steer; the answer must still
    // reach the model in a later request.
    let mut delivered = false;
    for _ in 0..300 {
        if bodies
            .lock()
            .unwrap()
            .iter()
            .any(|b| b["messages"].to_string().contains(TASK_ANSWER))
        {
            delivered = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(
        delivered,
        "the steered task answer was acknowledged but never delivered to the agent"
    );

    server.shutdown().await;
}
