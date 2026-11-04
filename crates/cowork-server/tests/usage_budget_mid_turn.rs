//! Regression coverage for `cowork/session/usageBudget/set` while a turn is running: the change
//! must reach the running turn's cost tracker (TS parity: the session and its running turn share
//! one `SessionCostTracker`). Clearing a hard cap mid-turn lets the turn continue, lowering it
//! below the current spend stops the turn at the next step boundary, and the turn-end usage
//! event and stored snapshot carry the updated thresholds without losing or double-counting the
//! turn's cost. The mock model pauses each turn on an `AskUserQuestion` call until the test
//! answers it.

#![recursion_limit = "256"]

use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::extract::State;
use axum::http::{Response, StatusCode, header};
use axum::response::IntoResponse;
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

/// Well below the cost of one mocked step (1,000 input + 500 output tokens on `gpt-5.4`).
const TINY_CAP_USD: f64 = 1e-9;

struct Iso {
    _root: TempDir,
    home: PathBuf,
    workspace: PathBuf,
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
        fs::create_dir_all(&workspace).unwrap();
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
            home,
            workspace,
            env,
        }
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
// Mock OpenAI Responses endpoint
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Default)]
struct MockState {
    bodies: Arc<Mutex<Vec<Value>>>,
    replies: Arc<Mutex<VecDeque<String>>>,
}

fn sse_event(event_type: &str, data: Value) -> String {
    format!("event: {event_type}\ndata: {data}\n\n")
}

fn completed_sse(resp_id: &str) -> String {
    sse_event(
        "response.completed",
        json!({
            "type": "response.completed",
            "response": {
                "id": resp_id,
                "status": "completed",
                "output": [],
                "usage": { "input_tokens": 1000, "output_tokens": 500 }
            }
        }),
    )
}

fn text_sse(resp_id: &str, text: &str) -> String {
    let mut s = sse_event(
        "response.created",
        json!({ "type": "response.created", "response": { "id": resp_id } }),
    );
    s.push_str(&sse_event(
        "response.output_item.added",
        json!({
            "type": "response.output_item.added",
            "output_index": 0,
            "item": { "id": "msg_0", "type": "message", "role": "assistant", "status": "in_progress", "content": [] }
        }),
    ));
    s.push_str(&sse_event(
        "response.output_text.delta",
        json!({ "type": "response.output_text.delta", "output_index": 0, "item_id": "msg_0", "delta": text }),
    ));
    s.push_str(&sse_event(
        "response.output_item.done",
        json!({
            "type": "response.output_item.done",
            "output_index": 0,
            "item": {
                "id": "msg_0", "type": "message", "role": "assistant", "status": "completed",
                "content": [{ "type": "output_text", "text": text, "annotations": [] }]
            }
        }),
    ));
    s.push_str(&completed_sse(resp_id));
    s
}

/// A step that calls `AskUserQuestion`, which parks the turn's tool execution until answered.
fn ask_sse(resp_id: &str) -> String {
    let args_str = json!({ "question": "Proceed?" }).to_string();
    let mut s = sse_event(
        "response.created",
        json!({ "type": "response.created", "response": { "id": resp_id } }),
    );
    s.push_str(&sse_event(
        "response.output_item.added",
        json!({
            "type": "response.output_item.added",
            "output_index": 0,
            "item": { "type": "function_call", "id": "fc_0", "call_id": "call_ask", "name": "AskUserQuestion" }
        }),
    ));
    s.push_str(&sse_event(
        "response.function_call_arguments.delta",
        json!({ "type": "response.function_call_arguments.delta", "output_index": 0, "delta": args_str }),
    ));
    s.push_str(&sse_event(
        "response.output_item.done",
        json!({
            "type": "response.output_item.done",
            "output_index": 0,
            "item": {
                "type": "function_call", "id": "fc_0", "call_id": "call_ask",
                "name": "AskUserQuestion", "arguments": args_str
            }
        }),
    ));
    s.push_str(&completed_sse(resp_id));
    s
}

async fn responses_handler(
    State(state): State<MockState>,
    body: axum::body::Bytes,
) -> axum::response::Response {
    let parsed: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let is_turn_request = parsed["model"] == "gpt-5.4";
    state.bodies.lock().unwrap().push(parsed);
    // Background title generation uses another model; never hand it a scripted turn reply.
    let reply = is_turn_request
        .then(|| state.replies.lock().unwrap().pop_front())
        .flatten()
        .unwrap_or_else(|| text_sse("resp_default", "Done."));
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .body(Body::from(reply))
        .unwrap()
        .into_response()
}

async fn start_mock(iso: &mut Iso, replies: Vec<String>) -> MockState {
    let state = MockState::default();
    state.replies.lock().unwrap().extend(replies);
    let app = Router::new()
        .route("/v1/responses", post(responses_handler))
        .with_state(state.clone());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    iso.env
        .insert("OPENAI_API_KEY".into(), "openai-test-key".into());
    iso.env.insert(
        "OPENAI_BASE_URL".into(),
        format!("http://127.0.0.1:{port}/v1"),
    );
    state
}

/// Main-model turn requests (excludes the background title-generation call).
fn turn_requests(mock: &MockState) -> usize {
    mock.bodies
        .lock()
        .unwrap()
        .iter()
        .filter(|b| b["model"] == "gpt-5.4")
        .count()
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
                "clientInfo": { "name": "usage-budget-mid-turn-tests", "version": "1.0.0" },
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

async fn send(ws: &mut WsStream, msg: Value) {
    ws.send(WsMessage::Text(msg.to_string().into()))
        .await
        .unwrap();
}

/// Sends a request and reads frames until its response; notifications and server requests seen
/// on the way are appended to `notifs`.
async fn call(
    ws: &mut WsStream,
    id: &str,
    method: &str,
    params: Value,
    notifs: &mut Vec<Value>,
) -> Value {
    send(ws, json!({ "id": id, "method": method, "params": params })).await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        let rem = deadline.saturating_duration_since(tokio::time::Instant::now());
        let frame = tokio::time::timeout(rem, ws.next())
            .await
            .unwrap_or_else(|_| panic!("timed out waiting for {method} response"));
        if let WsMessage::Text(txt) = frame.expect("ws open").expect("ws frame") {
            let val: Value = serde_json::from_str(&txt).unwrap();
            if val.get("method").is_some() {
                notifs.push(val);
            } else if val.get("id") == Some(&json!(id)) {
                return val;
            }
        }
    }
}

/// Reads frames until a message with `method` arrives and returns it.
async fn wait_for_method(ws: &mut WsStream, notifs: &mut Vec<Value>, method: &str) -> Value {
    if let Some(found) = notifs.iter().find(|n| n["method"] == method) {
        return found.clone();
    }
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    while tokio::time::Instant::now() < deadline {
        let rem = deadline.saturating_duration_since(tokio::time::Instant::now());
        if let Ok(Some(Ok(WsMessage::Text(txt)))) = tokio::time::timeout(rem, ws.next()).await
            && let Ok(val) = serde_json::from_str::<Value>(&txt)
            && val.get("method").is_some()
        {
            notifs.push(val.clone());
            if val["method"] == method {
                return val;
            }
        }
    }
    panic!("timed out waiting for {method}; got {notifs:?}");
}

async fn start_thread(ws: &mut WsStream, cwd: &str) -> String {
    let mut notifs = Vec::new();
    let res = call(
        ws,
        "start",
        "thread/start",
        json!({ "cwd": cwd, "provider": "openai", "model": "gpt-5.4" }),
        &mut notifs,
    )
    .await;
    res["result"]["thread"]["id"]
        .as_str()
        .unwrap_or_else(|| panic!("thread/start failed: {res}"))
        .to_owned()
}

/// Starts a turn and returns once its first step (one `AskUserQuestion` call, already recorded
/// in the cost tracker) is parked waiting for an answer, with the server request id.
async fn start_turn_until_ask(
    ws: &mut WsStream,
    thread_id: &str,
    notifs: &mut Vec<Value>,
) -> String {
    let res = call(
        ws,
        "turn",
        "turn/start",
        json!({ "threadId": thread_id, "input": [{ "type": "text", "text": "go" }] }),
        notifs,
    )
    .await;
    assert!(res.get("error").is_none(), "turn/start failed: {res}");
    let ask = wait_for_method(ws, notifs, "item/tool/requestUserInput").await;
    ask["id"]
        .as_str()
        .unwrap_or_else(|| panic!("requestUserInput without id: {ask}"))
        .to_owned()
}

async fn answer_ask(ws: &mut WsStream, ask_id: &str) {
    send(ws, json!({ "id": ask_id, "result": { "answer": "yes" } })).await;
}

/// The last `cowork/session/usage` notification (the turn-end usage event).
fn last_session_usage(notifs: &[Value]) -> Value {
    notifs
        .iter()
        .rev()
        .find(|n| n["method"] == "cowork/session/usage")
        .unwrap_or_else(|| panic!("no cowork/session/usage notification: {notifs:?}"))["params"]
        ["usage"]
        .clone()
}

fn step_cost(usage: &Value) -> f64 {
    usage["estimatedTotalCostUsd"]
        .as_f64()
        .unwrap_or_else(|| panic!("no estimatedTotalCostUsd: {usage}"))
}

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

/// A hard cap the first step crossed (so the next step boundary would stop the turn) is cleared
/// while the turn waits on a tool: the turn continues to its next step and completes, and the
/// turn-end usage event and stored snapshot carry the cleared cap and the warning threshold set
/// mid-turn, with the turn's cost counted exactly once.
#[tokio::test]
async fn clearing_hard_cap_mid_turn_lets_the_turn_continue() {
    let mut iso = Iso::new("cowork-budget-clear-mid-turn-");
    let mock = start_mock(
        &mut iso,
        vec![ask_sse("resp_ask"), text_sse("resp_done", "Finished.")],
    )
    .await;
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let cwd = iso.workspace.to_string_lossy().into_owned();
    let thread_id = start_thread(&mut ws, &cwd).await;
    let mut notifs = Vec::new();

    let cap = call(
        &mut ws,
        "cap",
        "cowork/session/usageBudget/set",
        json!({ "threadId": thread_id, "stopAtUsd": TINY_CAP_USD }),
        &mut notifs,
    )
    .await;
    assert!(cap.get("error").is_none(), "{cap}");

    let ask_id = start_turn_until_ask(&mut ws, &thread_id, &mut notifs).await;
    assert!(
        notifs
            .iter()
            .any(|n| n["method"] == "cowork/session/budgetExceeded"),
        "the first step must cross the cap: {notifs:?}"
    );
    assert_eq!(turn_requests(&mock), 1);

    let clear = call(
        &mut ws,
        "clear",
        "cowork/session/usageBudget/set",
        json!({ "threadId": thread_id, "stopAtUsd": null, "warnAtUsd": 100.0 }),
        &mut notifs,
    )
    .await;
    let usage = &clear["result"]["event"]["usage"];
    assert!(usage["budgetStatus"]["stopAtUsd"].is_null(), "{clear}");
    assert_eq!(usage["budgetStatus"]["stopTriggered"], false, "{clear}");
    assert_eq!(usage["budgetStatus"]["warnAtUsd"], 100.0, "{clear}");
    // The result reflects the running turn's tracker, including its in-flight step.
    assert_eq!(usage["totalTokens"], 1500, "{clear}");
    let one_step = step_cost(usage);
    assert!(one_step > TINY_CAP_USD, "{clear}");

    answer_ask(&mut ws, &ask_id).await;
    let completed = wait_for_method(&mut ws, &mut notifs, "turn/completed").await;
    assert_eq!(
        completed["params"]["turn"]["status"], "completed",
        "{completed}"
    );
    assert_eq!(turn_requests(&mock), 2, "the turn must reach its next step");

    let final_usage = last_session_usage(&notifs);
    assert!(
        final_usage["budgetStatus"]["stopAtUsd"].is_null(),
        "{final_usage}"
    );
    assert_eq!(final_usage["budgetStatus"]["warnAtUsd"], 100.0);
    assert_eq!(final_usage["totalTokens"], 3000, "{final_usage}");
    assert!((step_cost(&final_usage) - 2.0 * one_step).abs() < 1e-12);

    {
        let live_arc = server.runtime().load_thread(&thread_id).unwrap();
        let live = live_arc.lock();
        assert!(live.active_cost_tracker.is_none());
        assert_eq!(live.stop_at_usd, None);
        assert_eq!(live.warn_at_usd, Some(100.0));
        let stored = live.cost_tracker_snapshot.as_ref().unwrap();
        assert!(stored["budgetStatus"]["stopAtUsd"].is_null(), "{stored}");
        assert_eq!(stored["budgetStatus"]["warnAtUsd"], 100.0, "{stored}");
        assert_eq!(stored["totalTokens"], 3000, "{stored}");
    }

    // After the turn, a budget change applies to the stored snapshot, which keeps the turn's cost.
    let after = call(
        &mut ws,
        "after",
        "cowork/session/usageBudget/set",
        json!({ "threadId": thread_id, "warnAtUsd": 50.0 }),
        &mut notifs,
    )
    .await;
    let usage = &after["result"]["event"]["usage"];
    assert_eq!(usage["totalTokens"], 3000, "{after}");
    assert_eq!(usage["budgetStatus"]["warnAtUsd"], 50.0, "{after}");
    assert!(usage["budgetStatus"]["stopAtUsd"].is_null(), "{after}");

    server.shutdown().await;
}

/// Lowering the hard cap below the current spend while the turn waits on a tool stops the turn
/// at its next step boundary, before any further model request, and the turn-end usage event
/// carries the lowered cap.
#[tokio::test]
async fn lowering_hard_cap_mid_turn_stops_at_next_step_boundary() {
    let mut iso = Iso::new("cowork-budget-lower-mid-turn-");
    let mock = start_mock(
        &mut iso,
        vec![
            ask_sse("resp_ask"),
            text_sse("resp_never", "This step must not run."),
        ],
    )
    .await;
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let cwd = iso.workspace.to_string_lossy().into_owned();
    let thread_id = start_thread(&mut ws, &cwd).await;
    let mut notifs = Vec::new();

    let ask_id = start_turn_until_ask(&mut ws, &thread_id, &mut notifs).await;
    assert_eq!(turn_requests(&mock), 1);

    let lower = call(
        &mut ws,
        "lower",
        "cowork/session/usageBudget/set",
        json!({ "threadId": thread_id, "stopAtUsd": TINY_CAP_USD }),
        &mut notifs,
    )
    .await;
    let usage = &lower["result"]["event"]["usage"];
    assert_eq!(usage["budgetStatus"]["stopAtUsd"], TINY_CAP_USD, "{lower}");
    assert_eq!(usage["budgetStatus"]["stopTriggered"], true, "{lower}");
    assert!(step_cost(usage) > TINY_CAP_USD, "{lower}");

    answer_ask(&mut ws, &ask_id).await;
    let completed = wait_for_method(&mut ws, &mut notifs, "turn/completed").await;
    assert_eq!(
        completed["params"]["turn"]["status"], "failed",
        "{completed}"
    );
    assert_eq!(
        turn_requests(&mock),
        1,
        "the lowered cap must stop the turn before its next step"
    );
    let exceeded = notifs
        .iter()
        .find(|n| n["method"] == "cowork/session/budgetExceeded")
        .unwrap_or_else(|| panic!("no budgetExceeded notification: {notifs:?}"));
    assert_eq!(
        exceeded["params"]["thresholdUsd"], TINY_CAP_USD,
        "{exceeded}"
    );

    let final_usage = last_session_usage(&notifs);
    assert_eq!(
        final_usage["budgetStatus"]["stopAtUsd"], TINY_CAP_USD,
        "{final_usage}"
    );
    assert_eq!(final_usage["budgetStatus"]["stopTriggered"], true);
    assert_eq!(final_usage["totalTokens"], 1500, "{final_usage}");

    {
        let live_arc = server.runtime().load_thread(&thread_id).unwrap();
        let live = live_arc.lock();
        assert!(live.active_cost_tracker.is_none());
        assert_eq!(live.stop_at_usd, Some(TINY_CAP_USD));
        let stored = live.cost_tracker_snapshot.as_ref().unwrap();
        assert_eq!(
            stored["budgetStatus"]["stopAtUsd"], TINY_CAP_USD,
            "{stored}"
        );
        assert_eq!(stored["totalTokens"], 1500, "{stored}");
    }

    server.shutdown().await;
}
