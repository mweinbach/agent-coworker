//! Agent-facing thread tools (`ServerThreadControlBridge`), TS `LocalThreadHost` parity
//! (`src/server/threads/localThreadHost.ts`, `src/tools/threadManagement.ts`):
//! - `send_message_to_thread` takes the trimmed `prompt` (`message` is a deprecated alias) and
//!   returns `{ threadId, hostId: "local", queued: true }`.
//! - Sending to a busy thread is not an error: TS returns
//!   `{ threadId, hostId, queued: false, busy: true, activeTurnId }` without applying the
//!   requested `model`/`thinking` and without queueing the prompt.
//! - `fork_thread` without `threadId` forks the calling thread
//!   (`ThreadManagementService.createControl(currentThreadId)`).

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
use cowork_config::ProviderName;
use cowork_protocol::WEBSOCKET_SUBPROTOCOL;
use cowork_server::memory_and_fork_routes::ServerThreadControlBridge;
use cowork_server::{ServerHandle, ServerOptions, start_server};
use cowork_tools::thread_tools::SEND_MESSAGE_PROMPT_CONFLICT;
use cowork_tools::{ThreadControlBridge, ThreadManagementTool, ToolExecutionContext};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::net::TcpListener;
use tokio::sync::Semaphore;
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

/// `gate` holds every model request until a permit is released, so a turn stays in progress
/// (the thread stays busy) for as long as a test needs.
#[derive(Clone)]
struct MockState {
    bodies: Arc<Mutex<Vec<Value>>>,
    gate: Arc<Semaphore>,
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
    state.gate.acquire().await.unwrap().forget();
    let reply = text_sse("resp_default", "Done.");
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .body(Body::from(reply))
        .unwrap()
        .into_response()
}

async fn start_mock(iso: &mut Iso) -> MockState {
    let state = MockState {
        bodies: Arc::default(),
        gate: Arc::new(Semaphore::new(0)),
    };
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
                "clientInfo": { "name": "thread-tools-send-busy-tests", "version": "1.0.0" },
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
        connection_id: "thread-tools-send-busy-test".to_owned(),
    }
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

fn body_count(mock: &MockState, needle: &str) -> usize {
    mock.bodies
        .lock()
        .unwrap()
        .iter()
        .filter(|body| body.to_string().contains(needle))
        .count()
}

// ---------------------------------------------------------------------------------------------
// send_message_to_thread { prompt } and busy targets
// ---------------------------------------------------------------------------------------------

/// The trimmed `prompt` starts a turn and the result carries TS's `SendMessageResult` fields.
/// `message` is still accepted as an alias; conflicting values and blank prompts are rejected
/// before anything is queued.
#[tokio::test]
async fn send_message_takes_prompt_and_returns_ts_result_shape() {
    let mut iso = Iso::new("cowork-send-prompt-", "openai");
    let mock = start_mock(&mut iso).await;
    mock.gate.add_permits(100);
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let bridge = bridge(&server);
    let thread_id = start_thread(&mut ws, &iso.cwd(), "start").await;

    let schema = tool_schema("send_message_to_thread");
    // `threadId` defaults to the calling thread (TS `resolveThreadId`), so only `prompt` is required.
    assert_eq!(schema["required"], json!(["prompt"]), "{schema}");

    let rejected = [
        (
            json!({ "threadId": thread_id, "prompt": "   " }),
            "send_message_to_thread requires a non-empty prompt",
        ),
        (
            json!({ "threadId": thread_id }),
            "send_message_to_thread requires a non-empty prompt",
        ),
        (
            json!({ "threadId": thread_id, "prompt": "a", "message": "b" }),
            SEND_MESSAGE_PROMPT_CONFLICT,
        ),
        (
            json!({ "threadId": "missing-thread", "prompt": "x" }),
            "Unknown thread: missing-thread",
        ),
    ];
    for (args, message) in rejected {
        let err = bridge.send_message_to_thread(args).await.unwrap_err();
        assert_eq!(err, message);
    }

    let res = bridge
        .send_message_to_thread(json!({ "threadId": thread_id, "prompt": "  prompt work  " }))
        .await
        .unwrap();
    assert_eq!(res["threadId"], json!(thread_id), "{res}");
    assert_eq!(res["hostId"], json!("local"), "{res}");
    assert_eq!(res["queued"], json!(true), "{res}");
    assert!(res.get("busy").is_none(), "{res}");
    assert!(res["turn"]["id"].is_string(), "{res}");
    let body = wait_for_model_request(&mock, "prompt work").await;
    assert!(
        !body.to_string().contains("  prompt work  "),
        "the prompt was not trimmed: {body}"
    );

    // Deprecated alias.
    wait_until_idle(&server, &thread_id).await;
    let res = bridge
        .send_message_to_thread(json!({ "threadId": thread_id, "message": "alias work" }))
        .await
        .unwrap();
    assert_eq!(res["queued"], json!(true), "{res}");
    wait_for_model_request(&mock, "alias work").await;

    server.shutdown().await;
}

/// TS `sendMessage` on a busy thread returns `queued: false, busy: true` with the running
/// turn's id, applies neither `model` nor `thinking`, and never queues the prompt.
#[tokio::test]
async fn send_message_to_busy_thread_returns_busy_without_applying_anything() {
    let mut iso = Iso::new("cowork-send-busy-", "openai");
    let mock = start_mock(&mut iso).await;
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let bridge = bridge(&server);
    let thread_id = start_thread(&mut ws, &iso.cwd(), "start").await;

    let first = bridge
        .send_message_to_thread(json!({ "threadId": thread_id, "prompt": "long running work" }))
        .await
        .unwrap();
    let first_turn_id = first["turn"]["id"].as_str().unwrap().to_owned();
    // The turn is held at the model request, so the thread stays busy.
    wait_for_model_request(&mock, "long running work").await;

    let busy_args = json!({
        "threadId": thread_id,
        "prompt": "should not run",
        "model": "openai:gpt-5.4-mini",
        "thinking": "low"
    });
    let res = bridge
        .send_message_to_thread(busy_args.clone())
        .await
        .unwrap();
    assert_eq!(
        res,
        json!({
            "threadId": thread_id,
            "hostId": "local",
            "queued": false,
            "busy": true,
            "activeTurnId": first_turn_id,
        })
    );
    // Nothing was applied to the busy thread.
    let (provider, model, section, requested) = thread_state(&server, &thread_id);
    assert_eq!((provider.as_str(), model.as_str()), ("openai", "gpt-5.4"));
    assert_eq!(section, Value::Null);
    assert_eq!(requested, None);

    // Through the agent-facing tool as well (the tool result is the bridge result).
    let mut ctx = ToolExecutionContext::new_for_tests(
        iso.home.clone(),
        iso.workspace.clone(),
        ProviderName::Openai,
        "gpt-5.4",
    );
    ctx.thread_control = Some(Arc::new(ServerThreadControlBridge {
        runtime: server.runtime().clone(),
        connection_id: "thread-tools-send-busy-tool".to_owned(),
    }));
    let tool = ThreadManagementTool::all_tools()
        .into_iter()
        .find(|tool| tool.name() == "send_message_to_thread")
        .unwrap();
    let out = tool
        .execute(serde_json::from_value(busy_args).unwrap(), &ctx)
        .await
        .unwrap()
        .to_json_value();
    assert_eq!(out["busy"], json!(true), "{out}");
    assert_eq!(out["queued"], json!(false), "{out}");

    // Release the running turn; the busy prompt never reaches the model.
    mock.gate.add_permits(100);
    wait_until_idle(&server, &thread_id).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(body_count(&mock, "should not run"), 0);
    let (_, model, _, _) = thread_state(&server, &thread_id);
    assert_eq!(model, "gpt-5.4");

    server.shutdown().await;
}

// ---------------------------------------------------------------------------------------------
// fork_thread without threadId
// ---------------------------------------------------------------------------------------------

/// The `fork_thread` tool forks the calling thread when `threadId` is omitted. The bridge
/// itself (no calling thread) still requires one.
#[tokio::test]
async fn fork_thread_tool_defaults_to_the_calling_thread() {
    let mut iso = Iso::new("cowork-fork-default-", "openai");
    let mock = start_mock(&mut iso).await;
    mock.gate.add_permits(100);
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let bridge = bridge(&server);
    let src = start_thread(&mut ws, &iso.cwd(), "start-src").await;
    bridge
        .set_thread_title(json!({ "threadId": src, "title": "source" }))
        .await
        .unwrap();

    let schema = tool_schema("fork_thread");
    let required = schema["required"].as_array().cloned().unwrap_or_default();
    assert!(!required.contains(&json!("threadId")), "{schema}");

    let err = bridge.fork_thread(json!({})).await.unwrap_err();
    assert_eq!(err, "fork_thread requires threadId");

    let mut ctx = ToolExecutionContext::new_for_tests(
        iso.home.clone(),
        iso.workspace.clone(),
        ProviderName::Openai,
        "gpt-5.4",
    );
    ctx.session_id = src.clone();
    ctx.thread_control = Some(Arc::new(ServerThreadControlBridge {
        runtime: server.runtime().clone(),
        connection_id: "thread-tools-send-busy-tool".to_owned(),
    }));
    for (name, input) in [
        ("fork_thread", json!({})),
        ("threadManagement", json!({ "action": "fork_thread" })),
    ] {
        let tool = ThreadManagementTool::all_tools()
            .into_iter()
            .find(|tool| tool.name() == name)
            .unwrap();
        let out = tool
            .execute(serde_json::from_value(input).unwrap(), &ctx)
            .await
            .unwrap_or_else(|e| panic!("{name}: {e}"))
            .to_json_value();
        assert_eq!(out["sourceThreadId"], json!(src), "{name}: {out}");
        assert_eq!(out["forked"], json!(true), "{name}: {out}");
        assert_eq!(
            out["thread"]["title"],
            json!("Fork of source"),
            "{name}: {out}"
        );
        assert_ne!(out["thread"]["id"], json!(src), "{name}: {out}");
    }

    server.shutdown().await;
}

// ---------------------------------------------------------------------------------------------
// set_thread_title / set_thread_pinned / set_thread_archived without threadId
// ---------------------------------------------------------------------------------------------

/// The title/pinned/archived tools act on the calling thread when `threadId` is omitted, on
/// both the direct tools and `threadManagement`. The bridge itself (no calling thread) fails
/// with TS's `"<operation> requires threadId"` and trims a padded id.
#[tokio::test]
async fn thread_setters_default_to_the_calling_thread() {
    let mut iso = Iso::new("cowork-setter-default-", "openai");
    let mock = start_mock(&mut iso).await;
    mock.gate.add_permits(100);
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let bridge = bridge(&server);
    let calling = start_thread(&mut ws, &iso.cwd(), "start-calling").await;
    let other = start_thread(&mut ws, &iso.cwd(), "start-other").await;

    for (name, field) in [
        ("set_thread_title", "title"),
        ("set_thread_pinned", "pinned"),
        ("set_thread_archived", "archived"),
    ] {
        let schema = tool_schema(name);
        assert_eq!(schema["required"], json!([field]), "{schema}");
    }

    // Bridge: TS `requireThreadId` text for a missing or blank id.
    for (err, op) in [
        (
            bridge
                .set_thread_title(json!({ "title": "x" }))
                .await
                .unwrap_err(),
            "set_thread_title",
        ),
        (
            bridge
                .set_thread_pinned(json!({ "threadId": "  ", "pinned": true }))
                .await
                .unwrap_err(),
            "set_thread_pinned",
        ),
        (
            bridge
                .set_thread_archived(json!({ "threadId": null, "archived": true }))
                .await
                .unwrap_err(),
            "set_thread_archived",
        ),
    ] {
        assert_eq!(err, format!("{op} requires threadId"));
    }
    // Bridge: a padded id is trimmed.
    let out = bridge
        .set_thread_pinned(json!({ "threadId": format!("  {other}  "), "pinned": false }))
        .await
        .unwrap();
    assert_eq!(out["thread"]["id"], json!(other), "{out}");

    let mut ctx = ToolExecutionContext::new_for_tests(
        iso.home.clone(),
        iso.workspace.clone(),
        ProviderName::Openai,
        "gpt-5.4",
    );
    ctx.session_id = calling.clone();
    ctx.thread_control = Some(Arc::new(ServerThreadControlBridge {
        runtime: server.runtime().clone(),
        connection_id: "thread-tools-setter-default-tool".to_owned(),
    }));
    let run = |name: &'static str, input: Value| {
        let ctx = &ctx;
        async move {
            ThreadManagementTool::all_tools()
                .into_iter()
                .find(|tool| tool.name() == name)
                .unwrap()
                .execute(serde_json::from_value(input).unwrap(), ctx)
                .await
                .unwrap_or_else(|e| panic!("{name}: {e}"))
                .to_json_value()
        }
    };
    let title_of = |id: &str| {
        server
            .runtime()
            .load_thread(id)
            .unwrap()
            .lock()
            .title
            .clone()
    };

    run("set_thread_title", json!({ "title": "Direct default" })).await;
    assert_eq!(title_of(&calling), "Direct default");
    run(
        "threadManagement",
        json!({ "action": "set_thread_title", "title": "Umbrella default" }),
    )
    .await;
    assert_eq!(title_of(&calling), "Umbrella default");
    run(
        "set_thread_title",
        json!({ "threadId": other, "title": "Explicit other" }),
    )
    .await;
    assert_eq!(title_of(&other), "Explicit other");
    assert_eq!(title_of(&calling), "Umbrella default");

    for (input, field) in [
        (json!({ "pinned": true }), "pinned"),
        (
            json!({ "action": "set_thread_pinned", "pinned": true }),
            "pinned",
        ),
        (json!({ "archived": true }), "archived"),
        (
            json!({ "action": "set_thread_archived", "archived": true }),
            "archived",
        ),
    ] {
        let name = if input.get("action").is_some() {
            "threadManagement"
        } else if field == "pinned" {
            "set_thread_pinned"
        } else {
            "set_thread_archived"
        };
        let out = run(name, input.clone()).await;
        assert_eq!(out["thread"]["id"], json!(calling), "{name} {input}: {out}");
        assert_eq!(out["thread"][field], json!(true), "{name} {input}: {out}");
    }
}
