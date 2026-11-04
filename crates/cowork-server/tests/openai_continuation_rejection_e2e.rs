//! A stored OpenAI continuation that OpenAI rejects is never persisted past the failed turn
//! (`runUserMessageTurn.ts` parity: the rejected handle is cleared before retrying from the
//! local transcript), so the next turn starts from the full history instead of resending it.

use std::collections::HashMap;
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

#[derive(Clone, Default)]
struct MockState {
    bodies: Arc<Mutex<Vec<Value>>>,
}

fn sse_event(event_type: &str, data: Value) -> String {
    format!("event: {event_type}\ndata: {data}\n\n")
}

fn text_sse(resp_id: &str, text: &str) -> String {
    [
        sse_event(
            "response.created",
            json!({ "type": "response.created", "response": { "id": resp_id } }),
        ),
        sse_event(
            "response.output_item.added",
            json!({
                "type": "response.output_item.added",
                "output_index": 0,
                "item": { "id": "msg_0", "type": "message", "role": "assistant", "status": "in_progress", "content": [] }
            }),
        ),
        sse_event(
            "response.output_text.delta",
            json!({ "type": "response.output_text.delta", "output_index": 0, "item_id": "msg_0", "delta": text }),
        ),
        sse_event(
            "response.output_item.done",
            json!({
                "type": "response.output_item.done",
                "output_index": 0,
                "item": {
                    "id": "msg_0", "type": "message", "role": "assistant", "status": "completed",
                    "content": [{ "type": "output_text", "text": text, "annotations": [] }]
                }
            }),
        ),
        sse_event(
            "response.completed",
            json!({
                "type": "response.completed",
                "response": {
                    "id": resp_id,
                    "status": "completed",
                    "output": [],
                    "usage": { "input_tokens": 18, "output_tokens": 9 }
                }
            }),
        ),
    ]
    .concat()
}

fn json_error(status: StatusCode, error: Value) -> axum::response::Response {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(json!({ "error": error }).to_string()))
        .unwrap()
        .into_response()
}

/// Thread request 0 (turn 1) yields `resp_stale`; every request carrying it is rejected with OpenAI's
/// `previous_response_not_found`; the turn-2 fallback (request 2) fails with an unrelated,
/// non-retryable 400; later requests succeed.
async fn responses_handler(
    State(state): State<MockState>,
    body: axum::body::Bytes,
) -> axum::response::Response {
    let parsed: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    // Session title generation runs on a separate small model; only thread turns are tracked.
    if parsed["model"] != "gpt-5.4" {
        return text_sse("resp_title", "Title").into_sse();
    }
    let index = {
        let mut bodies = state.bodies.lock().unwrap();
        bodies.push(parsed.clone());
        bodies.len() - 1
    };
    if index == 0 {
        return text_sse("resp_stale", "First answer.").into_sse();
    }
    if parsed["previous_response_id"] == "resp_stale" {
        return json_error(
            StatusCode::BAD_REQUEST,
            json!({
                "message": "Previous response with id 'resp_stale' not found.",
                "type": "invalid_request_error",
                "param": "previous_response_id",
                "code": "previous_response_not_found"
            }),
        );
    }
    if index == 2 {
        return json_error(
            StatusCode::BAD_REQUEST,
            json!({
                "message": "Invalid 'input': unsupported content.",
                "type": "invalid_request_error",
                "param": "input",
                "code": "invalid_value"
            }),
        );
    }
    text_sse(&format!("resp_fresh_{index}"), "Recovered answer.").into_sse()
}

trait IntoSse {
    fn into_sse(self) -> axum::response::Response;
}

impl IntoSse for String {
    fn into_sse(self) -> axum::response::Response {
        Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/event-stream")
            .body(Body::from(self))
            .unwrap()
            .into_response()
    }
}

async fn start_mock(iso: &mut Iso) -> MockState {
    let state = MockState::default();
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
                "clientInfo": { "name": "continuation-rejection-tests", "version": "1.0.0" },
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

async fn next_json(ws: &mut WsStream) -> Value {
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(20), ws.next())
            .await
            .expect("ws timeout")
            .expect("ws open")
            .expect("ws frame");
        if let WsMessage::Text(txt) = frame {
            return serde_json::from_str(&txt).unwrap();
        }
    }
}

async fn call(ws: &mut WsStream, id: &str, method: &str, params: Value) -> Value {
    ws.send(WsMessage::Text(
        json!({ "id": id, "method": method, "params": params })
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    loop {
        let val = next_json(ws).await;
        if val.get("id") == Some(&json!(id)) && val.get("method").is_none() {
            return val;
        }
    }
}

/// Starts a turn and returns its `turn/completed` status.
async fn run_turn(ws: &mut WsStream, thread_id: &str, text: &str, id: &str) -> String {
    let res = call(
        ws,
        id,
        "turn/start",
        json!({ "threadId": thread_id, "input": [{ "type": "text", "text": text }] }),
    )
    .await;
    assert!(res.get("error").is_none(), "turn/start failed: {res}");
    loop {
        let val = next_json(ws).await;
        if val["method"] == "turn/completed" {
            return val["params"]["turn"]["status"]
                .as_str()
                .unwrap_or_default()
                .to_owned();
        }
    }
}

fn stored_response_id(server: &cowork_server::ServerHandle, thread_id: &str) -> Option<String> {
    let live = server.runtime().load_thread(thread_id).unwrap();
    let live = live.lock();
    live.provider_state
        .as_ref()
        .and_then(|state| state["responseId"].as_str())
        .map(str::to_owned)
}

#[tokio::test]
async fn rejected_openai_continuation_is_not_persisted_after_a_failed_turn() {
    let mut iso = Iso::new("cowork-openai-continuation-rejection-");
    let mock = start_mock(&mut iso).await;
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let cwd = iso.workspace.to_string_lossy().into_owned();
    let started = call(
        &mut ws,
        "start",
        "thread/start",
        json!({ "cwd": cwd, "provider": "openai", "model": "gpt-5.4" }),
    )
    .await;
    let thread_id = started["result"]["thread"]["id"]
        .as_str()
        .unwrap_or_else(|| panic!("thread/start failed: {started}"))
        .to_owned();

    assert_eq!(
        run_turn(&mut ws, &thread_id, "first", "turn-1").await,
        "completed"
    );
    assert_eq!(
        stored_response_id(&server, &thread_id).as_deref(),
        Some("resp_stale")
    );

    // Turn 2: the stored handle is rejected, and the full-history fallback fails too.
    assert_eq!(
        run_turn(&mut ws, &thread_id, "second", "turn-2").await,
        "failed"
    );
    {
        let bodies = mock.bodies.lock().unwrap();
        assert_eq!(bodies.len(), 3, "turn 1 + rejected + fallback: {bodies:?}");
        assert_eq!(bodies[1]["previous_response_id"], "resp_stale");
        assert!(bodies[2].get("previous_response_id").is_none());
    }
    assert_eq!(
        stored_response_id(&server, &thread_id),
        None,
        "the rejected continuation must not outlive the failed turn"
    );

    // Turn 3 starts from the local transcript, never the rejected handle.
    assert_eq!(
        run_turn(&mut ws, &thread_id, "third", "turn-3").await,
        "completed"
    );
    let bodies = mock.bodies.lock().unwrap().clone();
    assert_eq!(bodies.len(), 4, "{bodies:?}");
    assert!(bodies[3].get("previous_response_id").is_none());
    let input_text = bodies[3]["input"].to_string();
    assert!(
        input_text.contains("first") && input_text.contains("First answer."),
        "{input_text}"
    );
    assert_eq!(
        stored_response_id(&server, &thread_id).as_deref(),
        Some("resp_fresh_3")
    );
}
