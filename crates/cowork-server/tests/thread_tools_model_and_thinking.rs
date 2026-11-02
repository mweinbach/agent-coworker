//! Agent-facing thread tools (`ServerThreadControlBridge`), TS `LocalThreadHost` parity for
//! the `model`/`thinking` arguments (`src/tools/threadManagement.ts`,
//! `src/models/threadReasoningOptions.ts`):
//! - `create_thread { thinking }` validates the level against the new thread's provider/model
//!   (`buildThreadReasoningOptionsPatch`) and applies it before the first turn (`applyThinking`).
//! - `send_message_to_thread { model, thinking }` switches the target thread's model
//!   (`parseThreadModelSelection` against its provider) and applies the level before the
//!   message's turn (`applyModelAndThinking`).
//! - `fork_thread` lists `prompt`, `model` and `thinking` in its schemas and applies `thinking`
//!   to the fork.

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
use cowork_tools::context::normalize_and_validate_args;
use cowork_tools::{ThreadControlBridge, ThreadManagementTool};
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
                "clientInfo": { "name": "thread-tools-thinking-tests", "version": "1.0.0" },
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
        connection_id: "thread-tools-thinking-test".to_owned(),
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

fn tool_schema(name: &str) -> Value {
    ThreadManagementTool::all_tools()
        .into_iter()
        .find(|tool| tool.name() == name)
        .unwrap_or_else(|| panic!("missing tool {name}"))
        .input_schema()
}

/// `(provider, model, providerOptions.<provider> override, requested reasoning effort)`.
fn thread_state(server: &ServerHandle, thread_id: &str) -> (String, String, Value, Option<String>) {
    let live = server.runtime().load_thread(thread_id).unwrap();
    let live = live.lock();
    let provider = live.provider.as_str().to_owned();
    let section = live
        .config_overrides
        .get("providerOptions")
        .and_then(|po| po.get(&provider))
        .cloned()
        .unwrap_or(Value::Null);
    (
        provider,
        live.model.clone(),
        section,
        live.requested_reasoning_effort.clone(),
    )
}

async fn wait_until_idle(server: &ServerHandle, thread_id: &str) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        let busy = server
            .runtime()
            .load_thread(thread_id)
            .is_some_and(|live| live.lock().busy);
        if !busy {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "thread {thread_id} never went idle"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Sends through the bridge, retrying while the previous turn is still winding down.
async fn send(bridge: &ServerThreadControlBridge, args: Value) -> Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        match bridge.send_message_to_thread(args.clone()).await {
            Ok(res) => return res,
            Err(err) if err.contains("already in progress") => {
                assert!(tokio::time::Instant::now() < deadline, "{err}");
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            Err(err) => panic!("send_message_to_thread failed: {err}"),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// create_thread { thinking }
// ---------------------------------------------------------------------------------------------

/// `create_thread` lists `thinking`, stores it as the new thread's reasoning override and the
/// queued first turn runs with it.
#[tokio::test]
async fn create_thread_applies_thinking_to_the_new_thread() {
    let mut iso = Iso::new("cowork-create-thread-thinking-", "openai");
    let mock = start_mock(&mut iso).await;
    let server = start_server(iso.options()).await.unwrap();
    let bridge = bridge(&server);

    let schema = tool_schema("create_thread");
    assert_eq!(
        schema["properties"]["thinking"]["type"],
        json!("string"),
        "{schema}"
    );

    let res = bridge
        .create_thread(json!({
            "prompt": "thinking create work",
            "model": "gpt-5.4",
            "thinking": " low "
        }))
        .await
        .unwrap();
    assert_eq!(res["queued"], json!(true), "{res}");
    let thread_id = res["thread"]["id"].as_str().unwrap().to_owned();
    let (provider, model, section, requested) = thread_state(&server, &thread_id);
    assert_eq!((provider.as_str(), model.as_str()), ("openai", "gpt-5.4"));
    assert_eq!(section["reasoningEffort"], json!("low"), "{section}");
    assert_eq!(requested.as_deref(), Some("low"));

    let body = wait_for_model_request(&mock, "thinking create work").await;
    assert_eq!(body["model"], json!("gpt-5.4"), "{body}");
    assert_eq!(body["reasoning"]["effort"], json!("low"), "{body}");

    // Without `model`, the level is validated against the workspace default model.
    let res = bridge
        .create_thread(json!({ "prompt": "default model thinking", "thinking": "medium" }))
        .await
        .unwrap();
    let body = wait_for_model_request(&mock, "default model thinking").await;
    assert_eq!(body["reasoning"]["effort"], json!("medium"), "{body}");
    let (_, _, section, _) = thread_state(&server, res["thread"]["id"].as_str().unwrap());
    assert_eq!(section["reasoningEffort"], json!("medium"), "{section}");

    server.shutdown().await;
}

/// `buildThreadReasoningOptionsPatch` errors surface verbatim and no thread is created.
#[tokio::test]
async fn create_thread_rejects_unsupported_thinking_without_creating_a_thread() {
    let iso = Iso::new("cowork-create-thread-thinking-reject-", "openai");
    let server = start_server(iso.options()).await.unwrap();
    let bridge = bridge(&server);

    let cases = [
        (
            json!({ "prompt": "never runs", "thinking": "dynamic" }),
            "Unsupported reasoning effort for openai: dynamic".to_owned(),
        ),
        (
            json!({ "prompt": "never runs", "model": "gpt-5-mini", "thinking": "xhigh" }),
            "Unsupported reasoning effort for openai:gpt-5-mini: xhigh. Supported efforts: none, minimal, low, medium, high".to_owned(),
        ),
        (
            json!({
                "prompt": "never runs",
                "model": "google:gemini-3.1-pro-preview",
                "thinking": "xhigh"
            }),
            "Unsupported Google thinking level: xhigh".to_owned(),
        ),
        (
            json!({
                "prompt": "never runs",
                "model": "anthropic:claude-sonnet-4-5",
                "thinking": "high"
            }),
            "Reasoning/thinking overrides are not supported for provider anthropic".to_owned(),
        ),
    ];
    for (args, message) in cases {
        let err = bridge.create_thread(args).await.unwrap_err();
        assert_eq!(err, message);
    }
    assert_eq!(
        thread_count(&bridge).await,
        0,
        "a rejected create left a thread"
    );

    server.shutdown().await;
}

// ---------------------------------------------------------------------------------------------
// send_message_to_thread { model, thinking }
// ---------------------------------------------------------------------------------------------

/// `model` (resolved with `parseThreadModelSelection` against the thread's provider) and
/// `thinking` are applied to the target thread before the message's turn runs on it.
#[tokio::test]
async fn send_message_applies_model_and_thinking_before_the_turn() {
    let mut iso = Iso::new("cowork-send-thread-thinking-", "openai");
    let mock = start_mock(&mut iso).await;
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let bridge = bridge(&server);

    let schema = tool_schema("send_message_to_thread");
    for key in ["model", "thinking"] {
        assert!(schema["properties"].get(key).is_some(), "{key}: {schema}");
    }

    let thread_id = start_thread(&mut ws, &iso.cwd(), "start").await;

    let res = send(
        &bridge,
        json!({
            "threadId": thread_id,
            "message": "switched send work",
            "model": "openai:gpt-5.4-mini",
            "thinking": "low"
        }),
    )
    .await;
    assert!(res.get("turn").is_some(), "{res}");
    let (provider, model, section, requested) = thread_state(&server, &thread_id);
    assert_eq!(
        (provider.as_str(), model.as_str()),
        ("openai", "gpt-5.4-mini")
    );
    assert_eq!(section["reasoningEffort"], json!("low"), "{section}");
    assert_eq!(requested.as_deref(), Some("low"));
    let body = wait_for_model_request(&mock, "switched send work").await;
    assert_eq!(body["model"], json!("gpt-5.4-mini"), "{body}");
    assert_eq!(body["reasoning"]["effort"], json!("low"), "{body}");

    // `thinking` alone keeps the model; a bare model ID stays on the thread's provider.
    wait_until_idle(&server, &thread_id).await;
    send(
        &bridge,
        json!({ "threadId": thread_id, "message": "thinking only work", "thinking": "medium" }),
    )
    .await;
    let body = wait_for_model_request(&mock, "thinking only work").await;
    assert_eq!(body["model"], json!("gpt-5.4-mini"), "{body}");
    assert_eq!(body["reasoning"]["effort"], json!("medium"), "{body}");

    wait_until_idle(&server, &thread_id).await;
    send(
        &bridge,
        json!({ "threadId": thread_id, "message": "model only work", "model": "gpt-5.4" }),
    )
    .await;
    let body = wait_for_model_request(&mock, "model only work").await;
    assert_eq!(body["model"], json!("gpt-5.4"), "{body}");
    assert_eq!(body["reasoning"]["effort"], json!("medium"), "{body}");

    server.shutdown().await;
}

/// A rejected `model` or `thinking` fails the call before anything is applied or queued: the
/// model is not switched when the level is invalid for the requested model.
#[tokio::test]
async fn send_message_rejects_invalid_model_or_thinking_without_applying_either() {
    let mut iso = Iso::new("cowork-send-thread-thinking-reject-", "openai");
    let mock = start_mock(&mut iso).await;
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let bridge = bridge(&server);

    let thread_id = start_thread(&mut ws, &iso.cwd(), "start").await;
    let cases = [
        (
            json!({ "threadId": thread_id, "message": "never runs", "model": "openai:" }),
            "Unsupported thread model \"openai:\". Expected provider:modelId.",
        ),
        (
            json!({ "threadId": thread_id, "message": "never runs", "thinking": "dynamic" }),
            "Unsupported reasoning effort for openai: dynamic",
        ),
        (
            json!({
                "threadId": thread_id,
                "message": "never runs",
                "model": "gpt-5-mini",
                "thinking": "xhigh"
            }),
            "Unsupported reasoning effort for openai:gpt-5-mini: xhigh. Supported efforts: none, minimal, low, medium, high",
        ),
    ];
    for (args, message) in cases {
        let err = bridge.send_message_to_thread(args).await.unwrap_err();
        assert_eq!(err, message);
    }
    let (provider, model, section, requested) = thread_state(&server, &thread_id);
    assert_eq!((provider.as_str(), model.as_str()), ("openai", "gpt-5.4"));
    assert_eq!(section, Value::Null);
    assert_eq!(requested, None);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(
        mock.bodies.lock().unwrap().is_empty(),
        "a rejected send reached the model"
    );

    server.shutdown().await;
}

// ---------------------------------------------------------------------------------------------
// fork_thread { prompt, model, thinking }
// ---------------------------------------------------------------------------------------------

/// Both the `fork_thread` tool and the multiplexed `threadManagement` tool list the fork
/// arguments TS accepted, and they pass schema validation.
#[test]
fn fork_thread_schemas_list_prompt_model_and_thinking() {
    for name in ["fork_thread", "threadManagement"] {
        let schema = tool_schema(name);
        for key in ["prompt", "model", "thinking"] {
            assert_eq!(
                schema["properties"][key]["type"],
                json!("string"),
                "{name}.{key}: {schema}"
            );
        }
    }
    let mut args = json!({
        "threadId": "t",
        "prompt": "continue",
        "model": "openai:gpt-5.4-mini",
        "thinking": "low"
    });
    normalize_and_validate_args(&tool_schema("fork_thread"), args.as_object().unwrap()).unwrap();
    args["action"] = json!("fork_thread");
    normalize_and_validate_args(&tool_schema("threadManagement"), args.as_object().unwrap())
        .unwrap();
    for name in ["fork_thread", "threadManagement"] {
        let err = normalize_and_validate_args(
            &tool_schema(name),
            json!({ "action": "fork_thread", "threadId": "t", "thinking": "" })
                .as_object()
                .unwrap(),
        )
        .unwrap_err();
        assert!(err.to_string().contains("Invalid tool arguments"), "{err}");
    }
}

/// `fork_thread { thinking }` through the agent bridge is validated against the fork's own
/// provider/model and stored on the fork; the fork's queued prompt runs with it.
#[tokio::test]
async fn fork_thread_tool_applies_thinking_model_and_prompt() {
    let mut iso = Iso::new("cowork-fork-thread-thinking-", "openai");
    let mock = start_mock(&mut iso).await;
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let bridge = bridge(&server);

    let src = start_thread(&mut ws, &iso.cwd(), "start-src").await;
    bridge
        .set_thread_title(json!({ "threadId": src, "title": "source" }))
        .await
        .unwrap();

    // gpt-5-mini declares no `xhigh`: validated against the fork's model, not the source's.
    let err = bridge
        .fork_thread(json!({ "threadId": src, "model": "gpt-5-mini", "thinking": "xhigh" }))
        .await
        .unwrap_err();
    assert_eq!(
        err,
        "Unsupported reasoning effort for openai:gpt-5-mini: xhigh. Supported efforts: none, minimal, low, medium, high"
    );
    assert_eq!(
        thread_count(&bridge).await,
        1,
        "a rejected fork was created"
    );

    let res = bridge
        .fork_thread(json!({
            "threadId": src,
            "model": "openai:gpt-5.4-mini",
            "thinking": "low",
            "prompt": "forked prompt work"
        }))
        .await
        .unwrap();
    assert_eq!(res["queued"], json!(true), "{res}");
    let fork_id = res["thread"]["id"].as_str().unwrap().to_owned();
    assert_ne!(fork_id, src);
    let (provider, model, section, requested) = thread_state(&server, &fork_id);
    assert_eq!(
        (provider.as_str(), model.as_str()),
        ("openai", "gpt-5.4-mini")
    );
    assert_eq!(section["reasoningEffort"], json!("low"), "{section}");
    assert_eq!(requested.as_deref(), Some("low"));
    // The source keeps its own settings.
    let (_, model, section, _) = thread_state(&server, &src);
    assert_eq!(model, "gpt-5.4");
    assert_eq!(section, Value::Null);

    let body = wait_for_model_request(&mock, "forked prompt work").await;
    assert_eq!(body["model"], json!("gpt-5.4-mini"), "{body}");
    assert_eq!(body["reasoning"]["effort"], json!("low"), "{body}");

    server.shutdown().await;
}
