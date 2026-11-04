//! Regression tests for `turn/start` admission races, legacy history migration, tool-retry
//! lineage, and attachment-preserving `turn/steer`.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::http::{Response, StatusCode};
use axum::routing::{get, post};
use cowork_config::{
    CachedModelDiscoveryModel, ModelDiscoveryResult, ModelDiscoverySource, ProviderName,
    get_ai_coworker_paths, write_model_discovery_cache,
};
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

/// Ordered mock chat-completions responses: `(delay_ms, sse_body)` per request; captures bodies.
type Script = Vec<(u64, String)>;

struct Env {
    _root: TempDir,
    home: PathBuf,
    workspace: PathBuf,
    env: HashMap<String, String>,
    bodies: Arc<Mutex<Vec<Value>>>,
}

impl Env {
    async fn new(script: Script) -> Self {
        let root = tempfile::Builder::new()
            .prefix("cowork-turn-regress-")
            .tempdir()
            .unwrap();
        let base = fs::canonicalize(root.path()).unwrap();
        let home = base.join("home");
        let workspace = base.join("workspace");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&workspace).unwrap();

        let bodies: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
        let bodies_route = Arc::clone(&bodies);
        let script = Arc::new(script);
        let app = Router::new().route(
            "/v1/chat/completions",
            post(move |body: axum::body::Bytes| {
                let bodies = Arc::clone(&bodies_route);
                let script = Arc::clone(&script);
                async move {
                    let parsed: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                    // Background requests without tools (e.g. session-title generation) neither
                    // consume the turn script nor count as turn steps.
                    let is_turn_step = parsed["tools"].as_array().is_some_and(|t| !t.is_empty());
                    let (delay, sse) = if is_turn_step {
                        let idx = {
                            let mut g = bodies.lock().unwrap();
                            g.push(parsed);
                            g.len() - 1
                        };
                        script
                            .get(idx)
                            .cloned()
                            .unwrap_or_else(|| (0, chat_sse_text("done")))
                    } else {
                        (0, chat_sse_text("Generated title"))
                    };
                    tokio::time::sleep(Duration::from_millis(delay)).await;
                    Response::builder()
                        .status(StatusCode::OK)
                        .header("content-type", "text/event-stream")
                        .body(Body::from(sse))
                        .unwrap()
                }
            }),
        )
        // LM Studio reachability probe: slow, so `turn/start` awaits inside its setup window.
        .route(
            "/v1/models",
            get(|| async {
                tokio::time::sleep(Duration::from_millis(300)).await;
                axum::Json(json!({ "object": "list", "data": [{ "id": "local-model", "object": "model" }] }))
            }),
        )
        // LM Studio's native model list, read by the pre-inference model preparation; the model
        // is already loaded, so nothing reloads.
        .route(
            "/api/v1/models",
            get(|| async {
                axum::Json(json!({ "models": [{
                    "key": "local-model",
                    "type": "llm",
                    "loaded_instances": [{ "id": "local-model:1", "config": { "context_length": 8192 } }]
                }] }))
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
            "LM_STUDIO_BASE_URL".into(),
            format!("http://127.0.0.1:{port}"),
        );
        Self {
            _root: root,
            home,
            workspace,
            env,
            bodies,
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

    fn bodies(&self) -> Vec<Value> {
        self.bodies.lock().unwrap().clone()
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

fn chat_sse_tool_call(call_id: &str, tool_name: &str, args: &Value) -> String {
    let args_str = serde_json::to_string(args).unwrap();
    format!(
        concat!(
            "data: {{\"id\":\"t\",\"choices\":[{{\"index\":0,\"delta\":{{\"role\":\"assistant\",\"tool_calls\":[{{\"index\":0,\"id\":{call_id:?},\"type\":\"function\",\"function\":{{\"name\":{tool_name:?},\"arguments\":{args_str:?}}}}}]}}}}]}}\n\n",
            "data: {{\"id\":\"t\",\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"tool_calls\"}}],\"usage\":{{\"prompt_tokens\":5,\"completion_tokens\":2,\"total_tokens\":7}}}}\n\n",
            "data: [DONE]\n\n"
        ),
        call_id = call_id,
        tool_name = tool_name,
        args_str = args_str,
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
                "clientInfo": { "name": "turn-regress", "version": "1.0.0" },
                "capabilities": { "experimentalApi": true, "toolRetryLineage": true }
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

/// Reads frames until every id in `ids` has a response; notifications go to `notifs`.
async fn await_responses(
    ws: &mut WsStream,
    ids: &[&str],
    notifs: &mut Vec<Value>,
) -> HashMap<String, Value> {
    let mut out = HashMap::new();
    while out.len() < ids.len() {
        let frame = tokio::time::timeout(Duration::from_secs(15), ws.next())
            .await
            .expect("response timeout")
            .expect("ws open")
            .expect("frame");
        if let WsMessage::Text(txt) = frame {
            let val: Value = serde_json::from_str(&txt).unwrap();
            if val.get("method").is_some() {
                notifs.push(val);
            } else if let Some(id) = val.get("id").and_then(Value::as_str)
                && ids.contains(&id)
            {
                out.insert(id.to_owned(), val);
            }
        }
    }
    out
}

async fn call(ws: &mut WsStream, id: &str, method: &str, params: Value) -> Value {
    call_collecting(ws, id, method, params, &mut Vec::new()).await
}

async fn call_collecting(
    ws: &mut WsStream,
    id: &str,
    method: &str,
    params: Value,
    notifs: &mut Vec<Value>,
) -> Value {
    send(ws, json!({ "id": id, "method": method, "params": params })).await;
    await_responses(ws, &[id], notifs).await.remove(id).unwrap()
}

/// Reads notifications until `turn/completed` for `turn_id` (checking `notifs` first).
async fn await_turn_completed(ws: &mut WsStream, turn_id: &str, notifs: &mut Vec<Value>) {
    let done = |v: &Value| {
        v["method"] == "turn/completed" && v["params"]["turn"]["id"].as_str() == Some(turn_id)
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

async fn start_thread(ws: &mut WsStream, cwd: &std::path::Path) -> String {
    start_thread_with(ws, cwd, "nvidia", "moonshotai/kimi-k2-instruct").await
}

async fn start_thread_with(
    ws: &mut WsStream,
    cwd: &std::path::Path,
    provider: &str,
    model: &str,
) -> String {
    let res = call(
        ws,
        "thread-start",
        "thread/start",
        json!({ "cwd": cwd.to_string_lossy(), "provider": provider, "model": model }),
    )
    .await;
    res["result"]["thread"]["id"].as_str().unwrap().to_owned()
}

fn completed_items<'a>(notifs: &'a [Value], ty: &str) -> Vec<&'a Value> {
    notifs
        .iter()
        .filter(|v| v["method"] == "item/completed" && v["params"]["item"]["type"] == ty)
        .map(|v| &v["params"]["item"])
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_turn_start_admits_exactly_one_and_setup_errors_release_reservation() {
    let env = Env::new(vec![
        (1500, chat_sse_text("first turn done")),
        (0, chat_sse_text("third turn done")),
    ])
    .await;
    let server = start_server(env.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    // LM Studio's pre-turn reachability probe awaits inside turn/start's setup window.
    let thread_id = start_thread_with(&mut ws, &env.workspace, "lmstudio", "local-model").await;

    // Fire both requests before reading any response so the server handles them concurrently.
    for (id, cid) in [("race-a", "cmsg-a"), ("race-b", "cmsg-b")] {
        send(
            &mut ws,
            json!({
                "id": id,
                "method": "turn/start",
                "params": { "threadId": thread_id, "clientMessageId": cid, "input": format!("hello {cid}") }
            }),
        )
        .await;
    }
    let mut notifs = Vec::new();
    let responses = await_responses(&mut ws, &["race-a", "race-b"], &mut notifs).await;
    let accepted: Vec<&Value> = responses
        .values()
        .filter(|r| r.get("result").is_some())
        .collect();
    let rejected: Vec<&Value> = responses
        .values()
        .filter(|r| r.get("error").is_some())
        .collect();
    assert_eq!(
        accepted.len(),
        1,
        "exactly one turn/start must win: {responses:?}"
    );
    assert_eq!(
        rejected.len(),
        1,
        "the other must be rejected: {responses:?}"
    );
    assert_eq!(rejected[0]["error"]["code"], json!(-32600));
    assert!(
        rejected[0]["error"]["message"]
            .as_str()
            .unwrap()
            .contains("already in progress")
    );
    let turn_id = accepted[0]["result"]["turn"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    await_turn_completed(&mut ws, &turn_id, &mut notifs).await;
    assert_eq!(
        env.bodies().len(),
        1,
        "only one provider request may be issued"
    );

    // A setup failure after the reservation (invalid attachment) must release the thread.
    let bad = call(
        &mut ws,
        "bad-attach",
        "turn/start",
        json!({
            "threadId": thread_id,
            "input": [
                { "type": "text", "text": "with a broken file" },
                { "type": "file", "filename": "x.png", "mimeType": "image/png", "contentBase64": "%%%not-base64%%%" }
            ]
        }),
    )
    .await;
    assert!(
        bad.get("error").is_some(),
        "invalid attachment must fail: {bad}"
    );
    let ok = call(
        &mut ws,
        "after-bad",
        "turn/start",
        json!({ "threadId": thread_id, "input": "third" }),
    )
    .await;
    assert!(
        ok.get("result").is_some(),
        "thread must not stay busy: {ok}"
    );
    let third_id = ok["result"]["turn"]["id"].as_str().unwrap().to_owned();
    await_turn_completed(&mut ws, &third_id, &mut notifs).await;
}

fn legacy_snapshot(session_id: &str, workspace: &std::path::Path) -> Value {
    let png = BASE64.encode(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);
    json!({
        "version": 1,
        "sessionId": session_id,
        "createdAt": "2025-06-01T10:00:00.000Z",
        "updatedAt": "2025-06-01T10:05:00.000Z",
        "session": {
            "title": "Legacy thread",
            "provider": "nvidia",
            "model": "moonshotai/kimi-k2-instruct"
        },
        "config": { "workingDirectory": workspace.to_string_lossy() },
        "context": {
            "system": "",
            "messages": [
                { "role": "user", "content": [
                    { "type": "text", "text": "What is in this image? LEGACY-USER-TEXT" },
                    { "type": "image", "image": png, "mimeType": "image/png" }
                ]},
                { "role": "assistant", "content": [
                    { "type": "reasoning", "text": "Let me read the notes." },
                    { "type": "text", "text": "Reading notes first." },
                    { "type": "tool-call", "toolCallId": "call_legacy_1", "toolName": "read", "input": { "filePath": "notes.txt" } }
                ]},
                { "role": "tool", "content": [
                    { "type": "tool-result", "toolCallId": "call_legacy_1", "toolName": "read",
                      "output": { "type": "text", "value": "LEGACY-TOOL-OUTPUT" } }
                ]},
                { "role": "assistant", "content": [
                    { "type": "text", "text": "LEGACY-ASSISTANT-ANSWER" }
                ]},
                { "role": "mystery", "content": "UNMIGRATABLE-PAYLOAD" }
            ]
        }
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn legacy_structured_history_is_migrated_replayed_and_never_dropped_on_persist() {
    let env = Env::new(vec![(0, chat_sse_text("continuing the legacy thread"))]).await;
    let session_id = "legacy-thread-0001";
    let sessions_dir = env.home.join(".cowork").join("sessions");
    fs::create_dir_all(&sessions_dir).unwrap();
    fs::write(
        sessions_dir.join(format!("{session_id}.json")),
        serde_json::to_vec(&legacy_snapshot(session_id, &env.workspace)).unwrap(),
    )
    .unwrap();

    let server = start_server(env.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let mut notifs = Vec::new();
    let res = call_collecting(
        &mut ws,
        "t1",
        "turn/start",
        json!({ "threadId": session_id, "input": "And now?" }),
        &mut notifs,
    )
    .await;
    assert!(res.get("result").is_some(), "turn/start failed: {res}");
    let turn_id = res["result"]["turn"]["id"].as_str().unwrap().to_owned();
    await_turn_completed(&mut ws, &turn_id, &mut notifs).await;

    // The provider saw the full structured legacy history, not just string-content messages.
    let bodies = env.bodies();
    let req = serde_json::to_string(&bodies[0]["messages"]).unwrap();
    for needle in [
        "LEGACY-USER-TEXT",
        "data:image/png;base64",
        "call_legacy_1",
        "LEGACY-TOOL-OUTPUT",
        "LEGACY-ASSISTANT-ANSWER",
        "And now?",
    ] {
        assert!(
            req.contains(needle),
            "provider request missing {needle}: {req}"
        );
    }
    assert!(!req.contains("UNMIGRATABLE-PAYLOAD"));

    // Persisted history keeps every legacy message (migrated or raw) plus the new turn.
    let db = rusqlite::Connection::open(env.home.join(".cowork").join("sessions.db")).unwrap();
    let raw: String = db
        .query_row(
            "SELECT messages_json FROM session_state WHERE session_id = ?1",
            [session_id],
            |row| row.get(0),
        )
        .unwrap();
    let persisted: Vec<Value> = serde_json::from_str(&raw).unwrap();
    assert_eq!(
        persisted.len(),
        7,
        "5 legacy + user + assistant: {persisted:#?}"
    );
    assert_eq!(
        persisted[4],
        json!({ "role": "mystery", "content": "UNMIGRATABLE-PAYLOAD" })
    );
    for (i, msg) in persisted.iter().enumerate().filter(|(i, _)| *i != 4) {
        assert!(
            msg["id"].as_str().is_some_and(|s| !s.is_empty()),
            "#{i} id: {msg}"
        );
        assert!(msg["createdAt"].as_str().is_some(), "#{i} createdAt: {msg}");
    }
    assert_eq!(persisted[1]["content"][2]["type"], "toolCall");
    assert_eq!(persisted[1]["content"][2]["id"], "call_legacy_1");
    assert_eq!(persisted[2]["content"][0]["type"], "toolResult");
    assert_eq!(persisted[0]["content"][1]["type"], "media");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn tool_retry_marks_hidden_turn_and_carries_retry_of_lineage() {
    let read_args = json!({ "filePath": "retry-target.txt" });
    let env = Env::new(vec![
        (0, chat_sse_tool_call("call_fail", "read", &read_args)),
        (0, chat_sse_text("could not read it")),
        (0, chat_sse_tool_call("call_retry", "read", &read_args)),
        (0, chat_sse_text("read it now")),
    ])
    .await;
    let server = start_server(env.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let thread_id = start_thread(&mut ws, &env.workspace).await;

    let mut notifs = Vec::new();
    let res = call_collecting(
        &mut ws,
        "t1",
        "turn/start",
        json!({ "threadId": thread_id, "input": "read retry-target.txt" }),
        &mut notifs,
    )
    .await;
    let turn1 = res["result"]["turn"]["id"].as_str().unwrap().to_owned();
    await_turn_completed(&mut ws, &turn1, &mut notifs).await;
    let failed = completed_items(&notifs, "toolCall")
        .into_iter()
        .find(|i| i["state"] == "output-error")
        .cloned()
        .expect("failed tool item");
    assert_eq!(failed["inputDigest"]["algorithm"], "sha256");
    let failed_id = failed["id"].as_str().unwrap().to_owned();

    // Retrying a non-failed / unknown item is rejected.
    let bad = call(
        &mut ws,
        "bad-retry",
        "turn/start",
        json!({ "threadId": thread_id, "input": "retry", "retry": { "toolItemIds": ["nope"] } }),
    )
    .await;
    assert_eq!(bad["error"]["code"], json!(-32602), "{bad}");

    fs::write(env.workspace.join("retry-target.txt"), "now it exists").unwrap();
    notifs.clear();
    let res = call_collecting(
        &mut ws,
        "t2",
        "turn/start",
        json!({
            "threadId": thread_id,
            "input": "Continue from where the previous turn stopped.",
            "retry": { "toolItemIds": [failed_id] }
        }),
        &mut notifs,
    )
    .await;
    assert!(
        res.get("result").is_some(),
        "retry turn/start failed: {res}"
    );
    let turn2 = res["result"]["turn"]["id"].as_str().unwrap().to_owned();
    await_turn_completed(&mut ws, &turn2, &mut notifs).await;

    let user_msg = completed_items(&notifs, "userMessage")[0].clone();
    assert_eq!(
        user_msg["annotations"],
        json!([{ "type": "cowork.toolRetryTurn", "version": 1, "targetItemIds": [failed_id] }])
    );
    let replacement = completed_items(&notifs, "toolCall")
        .into_iter()
        .rfind(|i| i["state"] == "output-available")
        .cloned()
        .unwrap_or_else(|| panic!("replacement tool item: {notifs:#?}"));
    assert_eq!(replacement["retryOf"], json!(failed_id));
    assert_eq!(replacement["inputDigest"], failed["inputDigest"]);

    // Once recovered, the same target cannot be retried again.
    let again = call(
        &mut ws,
        "again",
        "turn/start",
        json!({ "threadId": thread_id, "input": "retry", "retry": { "toolItemIds": [failed_id] } }),
    )
    .await;
    assert_eq!(again["error"]["code"], json!(-32602), "{again}");

    // After a reload, the `thread/read` feed keeps the hidden retry prompt's annotation.
    let read = call(
        &mut ws,
        "read",
        "thread/read",
        json!({ "threadId": thread_id, "includeTurns": true }),
    )
    .await;
    let feed = read["result"]["coworkSnapshot"]["feed"]
        .as_array()
        .unwrap_or_else(|| panic!("feed: {read}"));
    assert!(
        feed.iter()
            .any(|e| e["role"] == "user" && e["annotations"][0]["type"] == "cowork.toolRetryTurn"),
        "{feed:#?}"
    );
}

/// Steers a PNG into an in-flight turn on `model` (provider `nvidia`) and returns the last
/// user message the provider received plus the PNG's base64.
async fn steer_png_into_running_turn(env: &Env, model: &str) -> (String, String) {
    let server = start_server(env.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let thread_id = start_thread_with(&mut ws, &env.workspace, "nvidia", model).await;

    let mut notifs = Vec::new();
    let res = call_collecting(
        &mut ws,
        "t1",
        "turn/start",
        json!({ "threadId": thread_id, "input": "start" }),
        &mut notifs,
    )
    .await;
    let turn_id = res["result"]["turn"]["id"].as_str().unwrap().to_owned();
    let png = BASE64.encode(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);
    let steer = call_collecting(
        &mut ws,
        "steer",
        "turn/steer",
        json!({
            "threadId": thread_id,
            "turnId": turn_id,
            "input": [
                { "type": "text", "text": "STEER-TEXT look at this" },
                { "type": "file", "filename": "steer.png", "mimeType": "image/png", "contentBase64": png }
            ]
        }),
        &mut notifs,
    )
    .await;
    assert!(steer.get("result").is_some(), "turn/steer failed: {steer}");
    await_turn_completed(&mut ws, &turn_id, &mut notifs).await;

    let bodies = env.bodies();
    // The steer lands at the first step boundary: before step 1 if it arrived before the first
    // request, otherwise before step 2 of the same turn.
    assert!(!bodies.is_empty() && bodies.len() <= 2, "{}", bodies.len());
    let last_user = bodies[bodies.len() - 1]["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rfind(|m| m["role"] == "user")
        .unwrap()
        .to_string();
    assert!(last_user.contains("STEER-TEXT"), "{last_user}");
    let staged = env.workspace.join("uploads/User Uploads/steer.png");
    assert!(staged.is_file(), "steered attachment must be saved");
    assert!(
        last_user.contains(&staged.display().to_string()),
        "the saved path is noted for the model: {last_user}"
    );
    (last_user, png)
}

/// A text-only model gets the steered image as a saved-path note only
/// (`googleMultimodalPartTypeForMime` returns null for images without image input).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn turn_steer_preserves_attachments_in_the_injected_user_message() {
    let env = Env::new(vec![
        (1500, chat_sse_text("first pass")),
        (0, chat_sse_text("saw the steer image")),
    ])
    .await;
    let (last_user, _) = steer_png_into_running_turn(&env, "moonshotai/kimi-k2-instruct").await;
    assert!(
        last_user.contains("[Attached file saved to: "),
        "{last_user}"
    );
    assert!(!last_user.contains("data:image/png;base64,"), "{last_user}");
}

/// A vision-capable model (here a discovered one) receives the steered image as content.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn turn_steer_attaches_images_for_a_vision_model() {
    const VISION_MODEL: &str = "meta/llama-3.2-90b-vision-instruct";
    let env = Env::new(vec![
        (1500, chat_sse_text("first pass")),
        (0, chat_sse_text("saw the steer image")),
    ])
    .await;
    write_model_discovery_cache(
        &get_ai_coworker_paths(Some(&env.home), &env.env),
        ProviderName::Nvidia,
        ModelDiscoveryResult {
            provider: ProviderName::Nvidia,
            source: ModelDiscoverySource::Api,
            models: vec![CachedModelDiscoveryModel {
                id: VISION_MODEL.to_owned(),
                model: None,
                display_name: VISION_MODEL.to_owned(),
                description: None,
                knowledge_cutoff: None,
                supports_image_input: Some(true),
                is_default: None,
                reasoning: None,
                runtime_options: None,
                runtime_overrides: None,
            }],
            updated_at: None,
            expires_at: None,
            message: None,
        },
        None,
        None,
    )
    .await
    .expect("write nvidia discovery cache");

    let (last_user, png) = steer_png_into_running_turn(&env, VISION_MODEL).await;
    assert!(
        last_user.contains(&format!("data:image/png;base64,{png}")),
        "{last_user}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn session_max_steps_override_limits_the_turn() {
    let env = Env::new(vec![
        (
            0,
            chat_sse_tool_call("call_1", "read", &json!({ "filePath": "a.txt" })),
        ),
        (0, chat_sse_text("should never be requested")),
    ])
    .await;
    let server = start_server(env.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let thread_id = start_thread(&mut ws, &env.workspace).await;

    let set = call(
        &mut ws,
        "cfg",
        "cowork/session/config/set",
        json!({ "threadId": thread_id, "config": { "maxSteps": 1 } }),
    )
    .await;
    assert!(set.get("result").is_some(), "config/set failed: {set}");

    let mut notifs = Vec::new();
    let res = call_collecting(
        &mut ws,
        "t1",
        "turn/start",
        json!({ "threadId": thread_id, "input": "read a.txt" }),
        &mut notifs,
    )
    .await;
    let turn_id = res["result"]["turn"]["id"].as_str().unwrap().to_owned();
    await_turn_completed(&mut ws, &turn_id, &mut notifs).await;
    assert_eq!(
        env.bodies().len(),
        1,
        "maxSteps: 1 must stop after one step"
    );
}

fn tool_names(body: &Value) -> Vec<String> {
    body["tools"]
        .as_array()
        .map(|t| {
            t.iter()
                .filter_map(|d| d["function"]["name"].as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn session_enable_memory_false_override_removes_memory_tool() {
    let env = Env::new(vec![(0, chat_sse_text("one")), (0, chat_sse_text("two"))]).await;
    let server = start_server(env.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let thread_id = start_thread(&mut ws, &env.workspace).await;

    let mut notifs = Vec::new();
    for (i, input) in ["first", "second"].into_iter().enumerate() {
        if i == 1 {
            let set = call(
                &mut ws,
                "cfg",
                "cowork/session/config/set",
                json!({ "threadId": thread_id, "config": { "enableMemory": false } }),
            )
            .await;
            assert!(set.get("result").is_some(), "config/set failed: {set}");
        }
        let res = call_collecting(
            &mut ws,
            &format!("t{i}"),
            "turn/start",
            json!({ "threadId": thread_id, "input": input }),
            &mut notifs,
        )
        .await;
        let turn_id = res["result"]["turn"]["id"].as_str().unwrap().to_owned();
        await_turn_completed(&mut ws, &turn_id, &mut notifs).await;
    }
    let bodies = env.bodies();
    assert_eq!(bodies.len(), 2);
    assert!(
        tool_names(&bodies[0]).iter().any(|n| n == "memory"),
        "{:?}",
        tool_names(&bodies[0])
    );
    assert!(
        !tool_names(&bodies[1]).iter().any(|n| n == "memory"),
        "enableMemory:false must withhold the memory tool: {:?}",
        tool_names(&bodies[1])
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn inline_attachments_stage_into_configured_uploads_directory() {
    let mut env = Env::new(vec![(0, chat_sse_text("ok"))]).await;
    env.env
        .insert("AGENT_UPLOADS_DIR".into(), "configured-uploads".into());
    let server = start_server(env.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let thread_id = start_thread(&mut ws, &env.workspace).await;

    let mut notifs = Vec::new();
    let res = call_collecting(
        &mut ws,
        "t1",
        "turn/start",
        json!({
            "threadId": thread_id,
            "input": [
                { "type": "text", "text": "see file" },
                { "type": "file", "filename": "notes.txt", "mimeType": "text/plain",
                  "contentBase64": BASE64.encode(b"hello uploads") }
            ]
        }),
        &mut notifs,
    )
    .await;
    let turn_id = res["result"]["turn"]["id"]
        .as_str()
        .unwrap_or_else(|| panic!("{res}"))
        .to_owned();
    await_turn_completed(&mut ws, &turn_id, &mut notifs).await;
    let staged = env
        .workspace
        .join("configured-uploads/User Uploads/notes.txt");
    assert_eq!(std::fs::read(&staged).unwrap(), b"hello uploads");
    assert!(!env.workspace.join("uploads/User Uploads").exists());
}
