//! `thread/resume` replay and session-mutation guards/broadcasts:
//! - resume delivers a pending prompt to the resuming connection exactly once, never re-journals
//!   it and never re-broadcasts it to the other subscribers (TS `pendingPromptEvents` with
//!   `skipPendingPromptRequestIds`);
//! - resume during a streaming turn neither drops nor duplicates the turn's events;
//! - `cowork/session/model/set` and `cowork/session/defaults/apply` reject a running thread
//!   (`Agent is busy`), and defaults/apply validates its target before writing the workspace
//!   config;
//! - defaults/apply re-normalizes child routing for a model change (`persistSelection`);
//! - title, usage budget and config updates are broadcast to every thread subscriber.

#![recursion_limit = "256"]

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
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

const PROVIDER: &str = "nvidia";
const MODEL: &str = "moonshotai/kimi-k2-instruct";
const STREAM_CHUNKS: usize = 400;

struct Iso {
    _root: TempDir,
    workspace: PathBuf,
    other_workspace: PathBuf,
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
        let other_workspace = base.join("other-workspace");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(workspace.join(".cowork")).unwrap();
        fs::create_dir_all(&other_workspace).unwrap();
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
            other_workspace,
            home,
            env,
        }
    }

    fn cwd(&self) -> String {
        self.workspace.to_string_lossy().into_owned()
    }

    fn workspace_config_path(&self) -> PathBuf {
        self.workspace.join(".cowork").join("config.json")
    }

    fn workspace_config(&self) -> Option<Value> {
        let raw = fs::read_to_string(self.workspace_config_path()).ok()?;
        Some(serde_json::from_str(&raw).unwrap())
    }

    fn options(&self) -> ServerOptions {
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
            env: self.env.clone(),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Mock chat-completions provider
// ---------------------------------------------------------------------------------------------

fn sse_tool_call(call_id: &str, tool_name: &str, args: &Value) -> String {
    let chunk = json!({
        "id": "cmpl-tc",
        "choices": [{
            "index": 0,
            "delta": {
                "role": "assistant",
                "tool_calls": [{
                    "index": 0,
                    "id": call_id,
                    "type": "function",
                    "function": { "name": tool_name, "arguments": args.to_string() }
                }]
            }
        }]
    });
    let done = json!({
        "id": "cmpl-tc",
        "choices": [{ "index": 0, "delta": {}, "finish_reason": "tool_calls" }],
        "usage": { "prompt_tokens": 20, "completion_tokens": 10, "total_tokens": 30 }
    });
    format!("data: {chunk}\n\ndata: {done}\n\ndata: [DONE]\n\n")
}

fn sse_text_chunk(text: &str) -> String {
    let chunk = json!({
        "id": "cmpl-txt",
        "choices": [{ "index": 0, "delta": { "role": "assistant", "content": text } }]
    });
    format!("data: {chunk}\n\n")
}

fn sse_text_end() -> String {
    let done = json!({
        "id": "cmpl-txt",
        "choices": [{ "index": 0, "delta": {}, "finish_reason": "stop" }],
        "usage": { "prompt_tokens": 25, "completion_tokens": 8, "total_tokens": 33 }
    });
    format!("data: {done}\n\ndata: [DONE]\n\n")
}

fn stream_word(i: usize) -> String {
    format!("w{i} ")
}

fn sse_response(body: Body) -> axum::response::Response {
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .body(body)
        .unwrap()
}

/// Turn requests carrying `ASK` ask the user a question; `STREAM` streams [`STREAM_CHUNKS`]
/// words slowly; everything else (tool follow-ups, title generation) answers `Done`.
async fn start_mock(iso: &mut Iso) -> Arc<AtomicUsize> {
    let turn_requests = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&turn_requests);
    let app = Router::new().route(
        "/v1/chat/completions",
        post(move |body: axum::body::Bytes| {
            let counter = Arc::clone(&counter);
            async move {
                let req: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                let messages = req["messages"].as_array().cloned().unwrap_or_default();
                let has_tools = req["tools"].as_array().is_some_and(|t| !t.is_empty());
                let answered = messages.iter().any(|m| m["role"] == "tool");
                let last_user = messages
                    .iter()
                    .rev()
                    .find(|m| m["role"] == "user")
                    .map(|m| m["content"].to_string())
                    .unwrap_or_default();
                if has_tools {
                    counter.fetch_add(1, Ordering::SeqCst);
                }
                if has_tools && !answered && last_user.contains("ASK") {
                    return sse_response(Body::from(sse_tool_call(
                        "call_ask_1",
                        "AskUserQuestion",
                        &json!({
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
                    )));
                }
                if has_tools && !answered && last_user.contains("HOLD") {
                    tokio::time::sleep(Duration::from_secs(4)).await;
                    let mut text = sse_text_chunk("held");
                    text.push_str(&sse_text_end());
                    return sse_response(Body::from(text));
                }
                if has_tools && !answered && last_user.contains("STREAM") {
                    let chunks = futures_util::stream::unfold(0usize, |i| async move {
                        if i > STREAM_CHUNKS {
                            return None;
                        }
                        let frame = if i == STREAM_CHUNKS {
                            sse_text_end()
                        } else {
                            if i % 4 == 0 {
                                tokio::time::sleep(Duration::from_millis(2)).await;
                            }
                            sse_text_chunk(&stream_word(i))
                        };
                        Some((Ok::<_, std::io::Error>(frame), i + 1))
                    });
                    return sse_response(Body::from_stream(chunks));
                }
                let mut text = sse_text_chunk("Done");
                text.push_str(&sse_text_end());
                sse_response(Body::from(text))
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
    turn_requests
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
                "clientInfo": { "name": "session-resume-and-guards", "version": "1.0.0" },
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

async fn next_frame(ws: &mut WsStream, wait: Duration) -> Option<Value> {
    loop {
        let frame = tokio::time::timeout(wait, ws.next()).await.ok()??.ok()?;
        if let WsMessage::Text(txt) = frame {
            return serde_json::from_str(&txt).ok();
        }
    }
}

/// Sends a request and returns its response; every other frame (notifications and server
/// requests) seen meanwhile lands in `frames`.
async fn call(
    ws: &mut WsStream,
    id: &str,
    method: &str,
    params: Value,
    frames: &mut Vec<Value>,
) -> Value {
    ws.send(WsMessage::Text(
        json!({ "id": id, "method": method, "params": params })
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    loop {
        let val = next_frame(ws, Duration::from_secs(20))
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

/// Collects every frame that arrives within `quiet`.
async fn drain(ws: &mut WsStream, frames: &mut Vec<Value>, quiet: Duration) {
    while let Some(val) = next_frame(ws, quiet).await {
        frames.push(val);
    }
}

fn is_ask_request(frame: &Value) -> bool {
    frame["method"] == "item/tool/requestUserInput" && frame.get("id").is_some()
}

fn ask_requests_for(frames: &[Value], request_id: &Value) -> usize {
    frames
        .iter()
        .filter(|f| is_ask_request(f) && &f["id"] == request_id)
        .count()
}

async fn start_thread(ws: &mut WsStream, cwd: &str) -> String {
    let mut frames = Vec::new();
    let res = call(
        ws,
        "start",
        "thread/start",
        json!({ "cwd": cwd, "provider": PROVIDER, "model": MODEL }),
        &mut frames,
    )
    .await;
    res["result"]["thread"]["id"]
        .as_str()
        .unwrap_or_else(|| panic!("thread/start failed: {res}"))
        .to_owned()
}

async fn resume(ws: &mut WsStream, id: &str, thread_id: &str, after_seq: u64) -> Vec<Value> {
    let mut frames = Vec::new();
    let res = call(
        ws,
        id,
        "thread/resume",
        json!({ "threadId": thread_id, "afterSeq": after_seq }),
        &mut frames,
    )
    .await;
    assert!(res.get("error").is_none(), "thread/resume failed: {res}");
    frames
}

/// Starts a turn whose model asks a question and returns the pending request id once `ws`
/// received the prompt; the turn then stays running until answered.
async fn start_turn_with_pending_ask(ws: &mut WsStream, thread_id: &str) -> Value {
    let mut frames = Vec::new();
    let res = call(
        ws,
        "turn",
        "turn/start",
        json!({ "threadId": thread_id, "input": "ASK me which environment to use." }),
        &mut frames,
    )
    .await;
    assert!(res.get("error").is_none(), "turn/start failed: {res}");
    let ask = wait_for(ws, &mut frames, Duration::from_secs(20), is_ask_request)
        .await
        .unwrap_or_else(|| panic!("never received requestUserInput: {frames:?}"));
    ask["id"].clone()
}

// ---------------------------------------------------------------------------------------------
// thread/resume
// ---------------------------------------------------------------------------------------------

/// The pending prompt reaches a resuming client exactly once whether it comes from the journal
/// slice (`afterSeq > 0`) or the interaction manager (`afterSeq = 0`). Resuming never appends a
/// second `request:*` journal entry and never re-broadcasts the prompt to the subscribers that
/// already have it.
#[tokio::test]
async fn resume_delivers_a_pending_prompt_once_without_rejournaling_it() {
    let mut iso = Iso::new("cowork-resume-pending-prompt-");
    let _mock = start_mock(&mut iso).await;
    let server = start_server(iso.options()).await.unwrap();
    let mut owner = connect(server.ws_url()).await;
    let thread_id = start_thread(&mut owner, &iso.cwd()).await;
    let request_id = start_turn_with_pending_ask(&mut owner, &thread_id).await;

    // Journal replay: the prompt comes from the journal slice only.
    let mut journal_client = connect(server.ws_url()).await;
    let mut journal_frames = resume(&mut journal_client, "resume-1", &thread_id, 1).await;
    drain(
        &mut journal_client,
        &mut journal_frames,
        Duration::from_millis(500),
    )
    .await;
    assert_eq!(
        ask_requests_for(&journal_frames, &request_id),
        1,
        "afterSeq resume must deliver the pending prompt exactly once: {journal_frames:?}"
    );

    // No journal replay: the prompt comes from the interaction manager, to this client only.
    let mut fresh_client = connect(server.ws_url()).await;
    let mut fresh_frames = resume(&mut fresh_client, "resume-2", &thread_id, 0).await;
    drain(
        &mut fresh_client,
        &mut fresh_frames,
        Duration::from_millis(500),
    )
    .await;
    assert_eq!(
        ask_requests_for(&fresh_frames, &request_id),
        1,
        "afterSeq=0 resume must deliver the pending prompt exactly once: {fresh_frames:?}"
    );

    // The subscribers that already had the prompt were not sent it again.
    let mut owner_frames = Vec::new();
    drain(&mut owner, &mut owner_frames, Duration::from_millis(500)).await;
    assert_eq!(
        ask_requests_for(&owner_frames, &request_id),
        0,
        "resume re-broadcast the prompt to the turn owner: {owner_frames:?}"
    );
    let mut journal_tail = Vec::new();
    drain(
        &mut journal_client,
        &mut journal_tail,
        Duration::from_millis(300),
    )
    .await;
    assert_eq!(
        ask_requests_for(&journal_tail, &request_id),
        0,
        "a later resume re-broadcast the prompt to an earlier resumer: {journal_tail:?}"
    );

    // The journal still holds a single copy: a third client replaying it sees one prompt.
    let mut audit_client = connect(server.ws_url()).await;
    let mut audit_frames = resume(&mut audit_client, "resume-3", &thread_id, 1).await;
    drain(
        &mut audit_client,
        &mut audit_frames,
        Duration::from_millis(500),
    )
    .await;
    assert_eq!(
        ask_requests_for(&audit_frames, &request_id),
        1,
        "resume re-journaled the pending prompt: {audit_frames:?}"
    );

    // The resumed client can answer it.
    owner_frames.clear();
    audit_client
        .send(WsMessage::Text(
            json!({ "id": request_id, "result": { "answer": "staging" } })
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    wait_for(
        &mut owner,
        &mut owner_frames,
        Duration::from_secs(20),
        |f| f["method"] == "turn/completed",
    )
    .await
    .unwrap_or_else(|| panic!("turn never completed after the answer: {owner_frames:?}"));

    server.shutdown().await;
}

fn agent_text(frames: &[Value]) -> String {
    frames
        .iter()
        .filter(|f| f["method"] == "item/agentMessage/delta")
        .filter_map(|f| f["params"]["delta"].as_str())
        .collect()
}

/// Clients resuming at different points of a streaming turn each see every delta exactly once:
/// events emitted around the replay cut are neither lost (emitted live before the subscription
/// but not yet journaled) nor duplicated (journaled and also delivered live).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn resume_during_a_streaming_turn_neither_drops_nor_duplicates_events() {
    let mut iso = Iso::new("cowork-resume-streaming-");
    let _mock = start_mock(&mut iso).await;
    let server = start_server(iso.options()).await.unwrap();
    let mut owner = connect(server.ws_url()).await;
    let thread_id = start_thread(&mut owner, &iso.cwd()).await;
    let expected: String = (0..STREAM_CHUNKS).map(stream_word).collect();

    let mut owner_frames = Vec::new();
    let res = call(
        &mut owner,
        "turn",
        "turn/start",
        json!({ "threadId": thread_id, "input": "STREAM a long answer." }),
        &mut owner_frames,
    )
    .await;
    assert!(res.get("error").is_none(), "turn/start failed: {res}");

    let ws_url = server.ws_url().to_owned();
    let mut resumers = Vec::new();
    for i in 0..8u64 {
        let ws_url = ws_url.clone();
        let thread_id = thread_id.clone();
        resumers.push(tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(5 + i * 12)).await;
            let mut ws = connect(&ws_url).await;
            let mut frames = resume(&mut ws, "resume", &thread_id, 1).await;
            wait_for(&mut ws, &mut frames, Duration::from_secs(30), |f| {
                f["method"] == "turn/completed"
            })
            .await
            .unwrap_or_else(|| panic!("resumer {i} never saw turn/completed"));
            (i, agent_text(&frames))
        }));
    }
    wait_for(
        &mut owner,
        &mut owner_frames,
        Duration::from_secs(30),
        |f| f["method"] == "turn/completed",
    )
    .await
    .expect("owner never saw turn/completed");
    assert_eq!(agent_text(&owner_frames), expected);
    for handle in resumers {
        let (i, text) = handle.await.unwrap();
        assert_eq!(
            text.len(),
            expected.len(),
            "resumer {i} saw a lost or duplicated delta"
        );
        assert_eq!(text, expected, "resumer {i} saw a lost or duplicated delta");
    }

    server.shutdown().await;
}

// ---------------------------------------------------------------------------------------------
// Session mutation guards
// ---------------------------------------------------------------------------------------------

/// `ProviderAuthManager.setModel` and `applySessionDefaults` rejected a running agent; the
/// defaults apply must not have written the workspace config either.
#[tokio::test]
async fn model_set_and_defaults_apply_reject_a_running_thread() {
    let mut iso = Iso::new("cowork-session-busy-guards-");
    let _mock = start_mock(&mut iso).await;
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let thread_id = start_thread(&mut ws, &iso.cwd()).await;
    let config_before = iso.workspace_config();
    let request_id = start_turn_with_pending_ask(&mut ws, &thread_id).await;

    let mut frames = Vec::new();
    let model_set = call(
        &mut ws,
        "model",
        "cowork/session/model/set",
        json!({ "threadId": thread_id, "provider": "openai", "model": "gpt-5.4" }),
        &mut frames,
    )
    .await;
    assert!(
        model_set["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("Agent is busy")),
        "model/set during a turn must be rejected: {model_set}"
    );
    assert!(
        !frames
            .iter()
            .any(|f| f["method"] == "cowork/session/configUpdated"),
        "a rejected model/set announced a switch: {frames:?}"
    );

    let applied = call(
        &mut ws,
        "apply",
        "cowork/session/defaults/apply",
        json!({
            "cwd": iso.cwd(),
            "threadId": thread_id,
            "provider": "openai",
            "model": "gpt-5.4",
            "config": { "enableMemory": false }
        }),
        &mut frames,
    )
    .await;
    assert!(
        applied["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("Agent is busy")),
        "defaults/apply during a turn must be rejected: {applied}"
    );
    assert_eq!(
        iso.workspace_config(),
        config_before,
        "a rejected defaults/apply wrote the workspace config"
    );

    let read = call(
        &mut ws,
        "read",
        "thread/read",
        json!({ "threadId": thread_id }),
        &mut frames,
    )
    .await;
    assert_eq!(
        read["result"]["thread"]["modelProvider"], PROVIDER,
        "{read}"
    );
    assert_eq!(read["result"]["thread"]["model"], MODEL, "{read}");

    ws.send(WsMessage::Text(
        json!({ "id": request_id, "result": { "answer": "staging" } })
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    wait_for(&mut ws, &mut frames, Duration::from_secs(20), |f| {
        f["method"] == "turn/completed"
    })
    .await
    .expect("turn never completed");

    // Once idle, the same switch is accepted.
    let model_set = call(
        &mut ws,
        "model-idle",
        "cowork/session/model/set",
        json!({ "threadId": thread_id, "provider": "openai", "model": "gpt-5.4" }),
        &mut frames,
    )
    .await;
    assert!(
        model_set.get("error").is_none(),
        "idle model/set failed: {model_set}"
    );

    server.shutdown().await;
}

/// An unknown thread or a thread from another workspace is rejected before the workspace
/// defaults are written, and the foreign thread keeps its model.
#[tokio::test]
async fn defaults_apply_validates_the_target_thread_before_writing_config() {
    let mut iso = Iso::new("cowork-defaults-apply-target-");
    let _mock = start_mock(&mut iso).await;
    // A thread of another workspace, created by a server rooted there (same home/database).
    let foreign_cwd = iso.other_workspace.to_string_lossy().into_owned();
    let foreign_thread = {
        let mut opts = iso.options();
        opts.working_directory = iso.other_workspace.clone();
        let other_server = start_server(opts).await.unwrap();
        let mut other_ws = connect(other_server.ws_url()).await;
        let id = start_thread(&mut other_ws, &foreign_cwd).await;
        other_server.shutdown().await;
        id
    };
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let mut frames = Vec::new();
    let config_before = iso.workspace_config();

    let unknown = call(
        &mut ws,
        "unknown",
        "cowork/session/defaults/apply",
        json!({
            "cwd": iso.cwd(),
            "threadId": "does-not-exist",
            "provider": "openai",
            "model": "gpt-5.4",
            "enableMcp": false
        }),
        &mut frames,
    )
    .await;
    assert!(
        unknown.get("error").is_some(),
        "unknown thread accepted: {unknown}"
    );
    assert_eq!(
        iso.workspace_config(),
        config_before,
        "an unknown threadId wrote the workspace config"
    );

    let foreign = call(
        &mut ws,
        "foreign",
        "cowork/session/defaults/apply",
        json!({
            "cwd": iso.cwd(),
            "threadId": foreign_thread,
            "provider": "openai",
            "model": "gpt-5.4",
            "config": { "enableMemory": false }
        }),
        &mut frames,
    )
    .await;
    assert!(
        foreign["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("outside the active workspace")),
        "a thread from another workspace was accepted: {foreign}"
    );
    assert_eq!(
        iso.workspace_config(),
        config_before,
        "a foreign threadId wrote the workspace config"
    );
    let read = call(
        &mut ws,
        "read",
        "thread/read",
        json!({ "threadId": foreign_thread }),
        &mut frames,
    )
    .await;
    assert_eq!(
        read["result"]["thread"]["modelProvider"], PROVIDER,
        "{read}"
    );
    assert_eq!(read["result"]["thread"]["model"], MODEL, "{read}");

    server.shutdown().await;
}

/// A defaults model switch persists the child routing re-normalized for the new selection, as
/// `cowork/session/model/set` does: a same-provider preferred child of the old provider must not
/// survive a provider switch.
#[tokio::test]
async fn defaults_apply_model_switch_renormalizes_child_routing() {
    let iso = Iso::new("cowork-defaults-apply-routing-");
    fs::write(
        iso.workspace_config_path(),
        json!({
            "provider": "google",
            "model": "gemini-3.1-pro-preview",
            "preferredChildModel": "gemini-3-flash-preview",
            "preferredChildModelRef": "google:gemini-3-flash-preview",
            "childModelRoutingMode": "same-provider",
            "enableMemory": false
        })
        .to_string(),
    )
    .unwrap();
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let mut frames = Vec::new();

    for (id, thread) in [("workspace", None), ("thread", Some(()))] {
        let thread_id = match thread {
            Some(()) => {
                let started = call(
                    &mut ws,
                    "start-bare",
                    "thread/start",
                    json!({ "cwd": iso.cwd() }),
                    &mut frames,
                )
                .await;
                Some(
                    started["result"]["thread"]["id"]
                        .as_str()
                        .unwrap_or_else(|| panic!("thread/start failed: {started}"))
                        .to_owned(),
                )
            }
            None => None,
        };
        let (provider, model) = if thread.is_some() {
            ("anthropic", "claude-opus-4-6")
        } else {
            ("openai", "gpt-5.4")
        };
        let mut params = json!({ "cwd": iso.cwd(), "provider": provider, "model": model });
        if let Some(tid) = &thread_id {
            params["threadId"] = json!(tid);
        }
        let applied = call(
            &mut ws,
            id,
            "cowork/session/defaults/apply",
            params,
            &mut frames,
        )
        .await;
        assert!(applied.get("error").is_none(), "apply failed: {applied}");
        let cfg = iso.workspace_config().expect("workspace config");
        assert_eq!(cfg["provider"], provider, "{id}: {cfg}");
        assert_eq!(cfg["model"], model, "{id}: {cfg}");
        assert_eq!(cfg["preferredChildModel"], model, "{id}: {cfg}");
        assert_eq!(
            cfg["preferredChildModelRef"],
            format!("{provider}:{model}"),
            "{id}: {cfg}"
        );
        assert_eq!(cfg["childModelRoutingMode"], "same-provider", "{id}: {cfg}");
    }

    server.shutdown().await;
}

// ---------------------------------------------------------------------------------------------
// Session update broadcasts
// ---------------------------------------------------------------------------------------------

/// Title, usage budget and config updates reach every client subscribed to the thread, not
/// only the requester (TS `notificationProjector`: `session_info` → `cowork/session/info`,
/// `session_usage` → `cowork/session/usage`, `session_config` → `cowork/session/config`).
#[tokio::test]
async fn session_updates_are_broadcast_to_other_subscribers() {
    let mut iso = Iso::new("cowork-session-update-broadcasts-");
    let _mock = start_mock(&mut iso).await;
    let server = start_server(iso.options()).await.unwrap();
    let mut first = connect(server.ws_url()).await;
    let mut second = connect(server.ws_url()).await;
    let thread_id = start_thread(&mut first, &iso.cwd()).await;
    resume(&mut second, "resume", &thread_id, 0).await;
    let mut first_frames = Vec::new();
    let mut second_frames = Vec::new();

    let cases = [
        (
            "cowork/session/title/set",
            json!({ "threadId": thread_id, "title": "Renamed thread" }),
            "cowork/session/info",
            "session_info",
        ),
        (
            "cowork/session/usageBudget/set",
            json!({ "threadId": thread_id, "warnAtUsd": 1.5, "stopAtUsd": 3.0 }),
            "cowork/session/usage",
            "session_usage",
        ),
        (
            "cowork/session/config/set",
            json!({ "threadId": thread_id, "config": { "enableMemory": false } }),
            "cowork/session/config",
            "session_config",
        ),
    ];
    for (i, (method, params, notification, event_type)) in cases.into_iter().enumerate() {
        let res = call(
            &mut first,
            &format!("req-{i}"),
            method,
            params,
            &mut first_frames,
        )
        .await;
        assert!(res.get("error").is_none(), "{method} failed: {res}");
        assert_eq!(res["result"]["event"]["type"], event_type, "{res}");
        let seen = wait_for(
            &mut second,
            &mut second_frames,
            Duration::from_secs(10),
            |f| f["method"] == notification,
        )
        .await
        .unwrap_or_else(|| {
            panic!("other subscriber never received {notification}: {second_frames:?}")
        });
        assert_eq!(seen["params"], res["result"]["event"], "{notification}");
        assert_eq!(seen["params"]["sessionId"], json!(thread_id));
    }
    let title = second_frames
        .iter()
        .find(|f| f["method"] == "cowork/session/info")
        .unwrap();
    assert_eq!(title["params"]["title"], "Renamed thread");
    let usage = second_frames
        .iter()
        .find(|f| f["method"] == "cowork/session/usage")
        .unwrap();
    assert_eq!(
        usage["params"]["usage"]["budgetStatus"]["stopAtUsd"], 3.0,
        "{usage}"
    );
    let config = second_frames
        .iter()
        .find(|f| f["method"] == "cowork/session/config")
        .unwrap();
    assert_eq!(
        config["params"]["config"]["enableMemory"], false,
        "{config}"
    );

    // A config update that changes nothing announces nothing (TS emitted only on change).
    second_frames.clear();
    let res = call(
        &mut first,
        "noop",
        "cowork/session/config/set",
        json!({ "threadId": thread_id, "config": { "enableMemory": false } }),
        &mut first_frames,
    )
    .await;
    assert!(res.get("error").is_none(), "noop config/set failed: {res}");
    drain(&mut second, &mut second_frames, Duration::from_millis(300)).await;
    assert!(
        !second_frames
            .iter()
            .any(|f| f["method"] == "cowork/session/config"),
        "an unchanged config was announced: {second_frames:?}"
    );

    server.shutdown().await;
}

// ---------------------------------------------------------------------------------------------
// Workspace confinement and subagent steers
// ---------------------------------------------------------------------------------------------

/// Workspace-scoped RPCs act only on authorized workspaces: an unregistered host directory is
/// rejected before anything is written there, a desktop-registered project is accepted (also by
/// `thread/start`), and creation preflight may still inspect a new directory. Uploads larger
/// than TS `MAX_ATTACHMENT_UPLOAD_BASE64_SIZE` are refused before decoding.
#[tokio::test]
async fn workspace_rpcs_are_confined_to_authorized_workspaces() {
    let mut iso = Iso::new("cowork-workspace-confinement-");
    let _mock = start_mock(&mut iso).await;
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let mut frames = Vec::new();
    let outside = iso.other_workspace.clone();
    let outside_cwd = outside.to_string_lossy().into_owned();

    let upload = call(
        &mut ws,
        "upload",
        "cowork/session/file/upload",
        json!({ "cwd": outside_cwd, "filename": "planted.txt", "contentBase64": "aGk=" }),
        &mut frames,
    )
    .await;
    assert!(
        upload["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("authorized workspace")),
        "upload into an unregistered directory was accepted: {upload}"
    );
    assert!(!outside.join("User Uploads").exists() && !outside.join("uploads").exists());

    let defaults = call(
        &mut ws,
        "defaults",
        "cowork/session/defaults/apply",
        json!({ "cwd": outside_cwd, "enableMcp": false }),
        &mut frames,
    )
    .await;
    assert!(
        defaults.get("error").is_some(),
        "defaults/apply on an unregistered directory was accepted: {defaults}"
    );
    assert!(!outside.join(".cowork").exists());

    let runtime = server.runtime();
    for method in [
        "cowork/memory/upsert",
        "cowork/memory/delete",
        "cowork/workspace/document/save",
        "thread/start",
    ] {
        assert!(
            runtime
                .resolve_workspace_path(Some(&outside_cwd), method)
                .is_err(),
            "{method} accepted an unregistered directory"
        );
    }
    assert!(
        runtime
            .resolve_workspace_path(Some(&outside_cwd), "cowork/creation/preflight")
            .is_ok(),
        "creation preflight must inspect directories that are not workspaces yet"
    );
    assert!(
        runtime
            .resolve_workspace_path(Some(&iso.cwd()), "cowork/session/file/upload")
            .is_ok()
    );

    let oversized = "A".repeat((100 * 1024 * 1024usize).div_ceil(3) * 4 + 4);
    let err = runtime
        .upload_workspace_file(&iso.workspace, "huge.bin", &oversized)
        .expect_err("an upload over 100 MB must be refused");
    assert!(err.contains("too large"), "{err}");
    assert!(!iso.workspace.join("User Uploads").join("huge.bin").exists());
    server.shutdown().await;

    // Registered as a desktop project, the same directory is a workspace for every route,
    // `thread/start` included.
    let mut opts = iso.options();
    opts.env
        .insert("COWORK_WEB_DESKTOP_SERVICE".into(), "1".into());
    let server = start_server(opts).await.unwrap();
    let runtime = server.runtime();
    runtime
        .desktop_service
        .as_ref()
        .expect("desktop service")
        .save_state_json(
            json!({
                "workspaces": [{
                    "id": "ws-registered",
                    "name": "Registered",
                    "path": outside_cwd,
                    "workspaceKind": "project",
                    "createdAt": "2026-01-01T00:00:00.000Z",
                    "lastOpenedAt": "2026-01-01T00:00:00.000Z"
                }]
            }),
            &iso.workspace,
        )
        .unwrap();
    for method in [
        "thread/start",
        "thread/list",
        "cowork/session/file/upload",
        "cowork/memory/upsert",
    ] {
        assert!(
            runtime
                .resolve_workspace_path(Some(&outside_cwd), method)
                .is_ok(),
            "{method} rejected a registered project workspace"
        );
    }
    server.shutdown().await;
}

async fn child_ids(ws: &mut WsStream, parent_id: &str) -> Vec<String> {
    let mut frames = Vec::new();
    let res = call(
        ws,
        "agents",
        "cowork/session/agent/list",
        json!({ "threadId": parent_id }),
        &mut frames,
    )
    .await;
    assert!(res.get("error").is_none(), "agent/list failed: {res}");
    let list = wait_for(ws, &mut frames, Duration::from_secs(10), |f| {
        f["method"] == "cowork/session/agentList"
    })
    .await
    .expect("agentList notification");
    list["params"]["agents"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|a| a["agentId"].as_str().map(str::to_owned))
        .collect()
}

/// A subagent turn run by its parent's agent control has no live session or subscriber
/// stream here, so an external `turn/steer` is rejected with a clear error instead of being
/// applied silently or failing as an unknown thread.
#[tokio::test]
async fn turn_steer_rejects_subagent_turns() {
    let mut iso = Iso::new("cowork-subagent-steer-");
    let _mock = start_mock(&mut iso).await;
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let mut frames = Vec::new();
    let parent_id = start_thread(&mut ws, &iso.cwd()).await;
    let spawned = call(
        &mut ws,
        "spawn",
        "cowork/session/agent/spawn",
        json!({ "threadId": parent_id, "message": "HOLD for a while." }),
        &mut frames,
    )
    .await;
    assert!(spawned.get("error").is_none(), "spawn failed: {spawned}");
    let mut child_id = None;
    for _ in 0..100 {
        if let Some(id) = child_ids(&mut ws, &parent_id).await.into_iter().next() {
            child_id = Some(id);
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let child_id = child_id.expect("child agent never appeared");

    let mut steer = Value::Null;
    for attempt in 0..60 {
        steer = call(
            &mut ws,
            &format!("steer-{attempt}"),
            "turn/steer",
            json!({ "threadId": child_id, "input": "change course" }),
            &mut frames,
        )
        .await;
        let no_turn_yet = steer["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("No active turn"));
        if !no_turn_yet {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(
        steer["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("subagent turn")),
        "turn/steer on a running subagent turn must be rejected: {steer}"
    );

    server.shutdown().await;
}
