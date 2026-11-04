//! Agent-facing thread tools (`ServerThreadControlBridge`), TS `LocalThreadHost` parity:
//! - `create_thread` resolves `model` with `parseThreadModelSelection` against the target
//!   workspace's provider: an explicit `provider:modelId` ref selects that provider and passes
//!   only the model ID on, so the queued first turn runs on the named provider's transport
//!   with a valid model ID. Previously the whole ref was stored as the model ID under the
//!   workspace's default provider.
//! - `fork_thread` has no turn cutoff in TS; a `fromTurnIndex` is rejected instead of being
//!   ignored while the whole source history is copied.

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
use cowork_server::memory_and_fork_routes::ServerThreadControlBridge;
use cowork_server::{ServerHandle, ServerOptions, start_server};
use cowork_tools::ThreadControlBridge;
use cowork_tools::thread_tools::FORK_FROM_TURN_INDEX_UNSUPPORTED;
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
    fn new(prefix: &str, workspace_provider: &str) -> Self {
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
        env.insert("AGENT_PROVIDER".into(), workspace_provider.into());
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

    fn cwd(&self) -> String {
        self.workspace.to_string_lossy().into_owned()
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
    s.push_str(&sse_event(
        "response.completed",
        json!({
            "type": "response.completed",
            "response": {
                "id": resp_id, "status": "completed",
                "output": [{
                    "id": "msg_0", "type": "message", "role": "assistant", "status": "completed",
                    "content": [{ "type": "output_text", "text": text, "annotations": [] }]
                }],
                "usage": { "input_tokens": 10, "output_tokens": 5, "total_tokens": 15 }
            }
        }),
    ));
    s
}

async fn responses_handler(
    State(state): State<MockState>,
    body: axum::body::Bytes,
) -> axum::response::Response {
    let parsed: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    state.bodies.lock().unwrap().push(parsed);
    let reply = state
        .replies
        .lock()
        .unwrap()
        .pop_front()
        .unwrap_or_else(|| text_sse("resp_default", "Done."));
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .body(Body::from(reply))
        .unwrap()
        .into_response()
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

// ---------------------------------------------------------------------------------------------
// WebSocket / bridge helpers
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
                "clientInfo": { "name": "thread-tools-model-ref-tests", "version": "1.0.0" },
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

async fn start_thread(ws: &mut WsStream, cwd: &str, id: &str) -> String {
    ws.send(WsMessage::Text(
        json!({
            "id": id,
            "method": "thread/start",
            "params": { "cwd": cwd, "provider": "openai", "model": "gpt-5.4" }
        })
        .to_string()
        .into(),
    ))
    .await
    .unwrap();
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(20), ws.next())
            .await
            .expect("ws timeout")
            .expect("ws open")
            .expect("ws frame");
        if let WsMessage::Text(txt) = frame {
            let val: Value = serde_json::from_str(&txt).unwrap();
            if val.get("id") == Some(&json!(id)) && val.get("method").is_none() {
                return val["result"]["thread"]["id"]
                    .as_str()
                    .unwrap_or_else(|| panic!("thread/start failed: {val}"))
                    .to_owned();
            }
        }
    }
}

fn bridge(server: &ServerHandle) -> ServerThreadControlBridge {
    ServerThreadControlBridge {
        runtime: server.runtime().clone(),
        connection_id: "thread-tools-model-ref-test".to_owned(),
    }
}

async fn thread_count(bridge: &ServerThreadControlBridge) -> usize {
    let res = bridge
        .list_threads(json!({ "includeArchived": true }))
        .await
        .unwrap();
    res["threads"]
        .as_array()
        .unwrap_or_else(|| panic!("threads missing: {res}"))
        .len()
}

async fn wait_for_model_request(mock: &MockState, prompt: &str) -> Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        let found = mock
            .bodies
            .lock()
            .unwrap()
            .iter()
            .find(|body| body.to_string().contains(prompt))
            .cloned();
        if let Some(body) = found {
            return body;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the queued turn never reached the OpenAI transport"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

// ---------------------------------------------------------------------------------------------
// create_thread model references
// ---------------------------------------------------------------------------------------------

/// The workspace defaults to Anthropic; `openai:gpt-5.4` must create an OpenAI thread whose
/// model ID is `gpt-5.4`, and the queued turn must go to the OpenAI transport with that ID.
#[tokio::test]
async fn create_thread_provider_qualified_model_selects_that_provider() {
    let mut iso = Iso::new("cowork-create-thread-model-ref-", "anthropic");
    let mock = start_mock(&mut iso).await;
    let server = start_server(iso.options()).await.unwrap();
    let bridge = bridge(&server);

    let res = bridge
        .create_thread(json!({
            "prompt": "cross provider work",
            "model": "  openai:gpt-5.4  "
        }))
        .await
        .unwrap();
    assert_eq!(res["queued"], json!(true), "{res}");
    assert_eq!(res["thread"]["modelProvider"], json!("openai"), "{res}");
    assert_eq!(res["thread"]["model"], json!("gpt-5.4"), "{res}");

    let body = wait_for_model_request(&mock, "cross provider work").await;
    assert_eq!(body["model"], json!("gpt-5.4"), "{body}");

    server.shutdown().await;
}

/// `parseThreadModelSelection` without an explicit provider: a bare model ID, or one whose
/// prefix before `:` is not a provider, stays a model ID on the workspace provider.
#[tokio::test]
async fn create_thread_model_without_known_provider_uses_workspace_provider() {
    let mut iso = Iso::new("cowork-create-thread-model-bare-", "openai");
    let mock = start_mock(&mut iso).await;
    let server = start_server(iso.options()).await.unwrap();
    let bridge = bridge(&server);

    let res = bridge
        .create_thread(json!({ "prompt": "bare model work", "model": "gpt-5.4" }))
        .await
        .unwrap();
    assert_eq!(res["thread"]["modelProvider"], json!("openai"), "{res}");
    assert_eq!(res["thread"]["model"], json!("gpt-5.4"), "{res}");
    let body = wait_for_model_request(&mock, "bare model work").await;
    assert_eq!(body["model"], json!("gpt-5.4"), "{body}");

    let res = bridge
        .create_thread(json!({
            "prompt": "gateway model work",
            "model": "my-gateway:gpt-5.4"
        }))
        .await
        .unwrap();
    assert_eq!(res["thread"]["modelProvider"], json!("openai"), "{res}");
    assert_eq!(res["thread"]["model"], json!("my-gateway:gpt-5.4"), "{res}");
    let body = wait_for_model_request(&mock, "gateway model work").await;
    assert_eq!(body["model"], json!("my-gateway:gpt-5.4"), "{body}");

    server.shutdown().await;
}

/// A known provider with no model ID is rejected (TS `parseChildModelRef` throws) and no
/// thread is created.
#[tokio::test]
async fn create_thread_rejects_provider_ref_without_model_id() {
    let iso = Iso::new("cowork-create-thread-model-empty-", "openai");
    let server = start_server(iso.options()).await.unwrap();
    let bridge = bridge(&server);

    let err = bridge
        .create_thread(json!({ "prompt": "never runs", "model": "anthropic:" }))
        .await
        .unwrap_err();
    assert!(err.contains("Expected provider:modelId"), "{err}");
    assert_eq!(thread_count(&bridge).await, 0);

    server.shutdown().await;
}

// ---------------------------------------------------------------------------------------------
// fork_thread cutoff
// ---------------------------------------------------------------------------------------------

/// A requested `fromTurnIndex` is rejected by the bridge (no fork is created) rather than
/// silently producing a fork of the whole history.
#[tokio::test]
async fn fork_thread_rejects_from_turn_index() {
    let iso = Iso::new("cowork-fork-thread-turn-index-", "openai");
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let bridge = bridge(&server);

    let src = start_thread(&mut ws, &iso.cwd(), "start-src").await;
    // A titled thread is listed even before its first message (as is every fork).
    bridge
        .set_thread_title(json!({ "threadId": src, "title": "source" }))
        .await
        .unwrap();
    assert_eq!(thread_count(&bridge).await, 1);

    for index in [json!(0), json!(3)] {
        let err = bridge
            .fork_thread(json!({ "threadId": src, "fromTurnIndex": index }))
            .await
            .unwrap_err();
        assert_eq!(err, FORK_FROM_TURN_INDEX_UNSUPPORTED);
    }
    assert_eq!(thread_count(&bridge).await, 1, "a fork was created");

    // A fork without a cutoff still works, and an explicit provider ref on the fork resolves
    // through the same `parseThreadModelSelection` helper as `create_thread`.
    let err = bridge
        .fork_thread(json!({ "threadId": src, "model": "openai:" }))
        .await
        .unwrap_err();
    assert!(err.contains("Expected provider:modelId"), "{err}");
    let res = bridge
        .fork_thread(json!({ "threadId": src, "model": "openai:gpt-5.4-mini" }))
        .await
        .unwrap();
    let forked = &res["thread"];
    assert_ne!(forked["id"], json!(src), "{res}");
    assert_eq!(forked["modelProvider"], json!("openai"), "{res}");
    assert_eq!(forked["model"], json!("gpt-5.4-mini"), "{res}");
    assert_eq!(thread_count(&bridge).await, 2);

    server.shutdown().await;
}
