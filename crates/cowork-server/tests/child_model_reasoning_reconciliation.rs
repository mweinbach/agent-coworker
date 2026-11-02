//! Reasoning-option reconciliation for routed child agents.
//!
//! A child spawned from a reasoning parent starts from a copy of the parent's provider options,
//! so a GPT-5 parent carrying `reasoningEffort`/`reasoningSummary`/`textVerbosity` must not leak
//! those keys into a non-reasoning child such as a registered `gpt-4o` (its first Responses
//! request would send a `reasoning` payload the model rejects). A reasoning child keeps them
//! (`routeAgentConfig` → `reconcileReasoningProviderOptions` in `src/server/agents/modelRouter.ts`,
//! covered by `test/server/agents/modelRouter.test.ts`).

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
use cowork_config::{ProviderName, get_ai_coworker_paths, upsert_custom_model};
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
            yolo: true,
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

async fn responses_handler(
    State(state): State<MockState>,
    body: axum::body::Bytes,
) -> axum::response::Response {
    let parsed: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    state.bodies.lock().unwrap().push(parsed);
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .body(Body::from(text_sse("resp_child", "Done.")))
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
                "clientInfo": { "name": "child-reasoning-reconciliation", "version": "1.0.0" },
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

async fn call(ws: &mut WsStream, id: &str, method: &str, params: Value) -> Value {
    ws.send(WsMessage::Text(
        json!({ "id": id, "method": method, "params": params })
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
                return val;
            }
        }
    }
}

/// Reads child ids from the `cowork/session/agentList` notification `agent/list` emits.
async fn list_child_ids(ws: &mut WsStream, parent_id: &str) -> Vec<String> {
    ws.send(WsMessage::Text(
        json!({
            "id": "list",
            "method": "cowork/session/agent/list",
            "params": { "threadId": parent_id }
        })
        .to_string()
        .into(),
    ))
    .await
    .unwrap();
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(15), ws.next())
            .await
            .expect("agent list timeout")
            .expect("ws open")
            .expect("ws frame ok");
        if let WsMessage::Text(txt) = frame {
            let val: Value = serde_json::from_str(&txt).unwrap();
            if val["method"] == "cowork/session/agentList" {
                return val["params"]["agents"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|a| a["agentId"].as_str().map(str::to_owned))
                    .collect();
            }
        }
    }
}

/// Spawns a child with `extra` spawn params and waits until its turn has settled.
async fn spawn_child_and_wait(
    ws: &mut WsStream,
    parent_id: &str,
    message: &str,
    extra: Value,
) -> Value {
    let before = list_child_ids(ws, parent_id).await;
    let mut params = json!({ "threadId": parent_id, "message": message });
    for (k, v) in extra.as_object().unwrap() {
        params[k] = v.clone();
    }
    let res = call(
        ws,
        &format!("spawn-{message}"),
        "cowork/session/agent/spawn",
        params,
    )
    .await;
    assert_eq!(res["result"], json!({}), "spawn {message}: {res}");
    let mut agent_id = None;
    for _ in 0..100 {
        if let Some(id) = list_child_ids(ws, parent_id)
            .await
            .into_iter()
            .find(|id| !before.contains(id))
        {
            agent_id = Some(id);
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let agent_id = agent_id.unwrap_or_else(|| panic!("child for {message} never appeared"));
    for i in 0..200 {
        let res = call(
            ws,
            &format!("insp-{agent_id}-{i}"),
            "cowork/session/agent/inspect",
            json!({ "threadId": parent_id, "agentId": agent_id }),
        )
        .await;
        let event = res["result"]["event"].clone();
        if event["agent"]["busy"] == json!(false) {
            return event;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("child {agent_id} never went idle");
}

/// The Responses request body the child that was told `marker` sent.
fn child_body(mock: &MockState, marker: &str) -> Value {
    mock.bodies
        .lock()
        .unwrap()
        .iter()
        .find(|b| b["input"].to_string().contains(marker))
        .cloned()
        .unwrap_or_else(|| panic!("no Responses request carried {marker}"))
}

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

/// Port of `modelRouter.test.ts` "drops inherited reasoning provider options when routing to a
/// non-reasoning child" / "does not inherit parent reasoning effort when routing to a
/// non-reasoning child model" / "keeps reasoning provider options when routing to a reasoning
/// child", exercised end to end through `agent/spawn` and the child's Responses request.
#[tokio::test]
async fn routed_children_reconcile_inherited_reasoning_options_against_child_model() {
    let mut iso = Iso::new("cowork-child-reasoning-");
    let mock = start_mock(&mut iso).await;
    let paths = get_ai_coworker_paths(Some(&iso.home), &iso.env);
    upsert_custom_model(&paths, ProviderName::Openai, "gpt-4o")
        .await
        .expect("register custom gpt-4o");

    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let cwd = iso.workspace.to_string_lossy().into_owned();
    let th = call(
        &mut ws,
        "start",
        "thread/start",
        json!({ "cwd": cwd, "provider": "openai", "model": "gpt-5.4" }),
    )
    .await;
    let parent = th["result"]["thread"]["id"]
        .as_str()
        .unwrap_or_else(|| panic!("thread/start failed: {th}"))
        .to_owned();

    // A GPT-5 parent carries every model-gated OpenAI key in its provider options.
    let cfg = call(
        &mut ws,
        "cfg",
        "cowork/session/config/set",
        json!({
            "threadId": parent,
            "config": { "providerOptions": { "openai": {
                "reasoningEffort": "xhigh",
                "reasoningSummary": "detailed",
                "textVerbosity": "low"
            } } }
        }),
    )
    .await;
    assert!(cfg.get("error").is_none(), "config/set failed: {cfg}");

    // Non-reasoning child, no requested effort: inherited keys are dropped.
    let event = spawn_child_and_wait(
        &mut ws,
        &parent,
        "CHILD_GPT4O_INHERITED",
        json!({ "model": "gpt-4o" }),
    )
    .await;
    assert_eq!(event["agent"]["effectiveModel"], "openai:gpt-4o", "{event}");
    assert!(
        event["agent"]["effectiveReasoningEffort"].is_null(),
        "non-reasoning child must not inherit the parent's effort: {event}"
    );
    let body = child_body(&mock, "CHILD_GPT4O_INHERITED");
    assert_eq!(body["model"], "gpt-4o", "{body}");
    assert!(
        body.get("reasoning").is_none(),
        "gpt-4o child must not send a reasoning payload: {body}"
    );
    assert!(
        body.get("text").and_then(|t| t.get("verbosity")).is_none(),
        "gpt-4o child must not send GPT-5 text verbosity: {body}"
    );

    // Non-reasoning child with an explicitly requested effort: still no reasoning payload.
    let _ = spawn_child_and_wait(
        &mut ws,
        &parent,
        "CHILD_GPT4O_REQUESTED",
        json!({ "model": "gpt-4o", "reasoningEffort": "high" }),
    )
    .await;
    let body = child_body(&mock, "CHILD_GPT4O_REQUESTED");
    assert_eq!(body["model"], "gpt-4o", "{body}");
    assert!(
        body.get("reasoning").is_none(),
        "gpt-4o child must not send a reasoning payload even when an effort is requested: {body}"
    );

    // Reasoning child, model changed and no requested effort: the child's own default effort
    // applies and the inherited summary/verbosity survive (declared in its defaults).
    let event = spawn_child_and_wait(
        &mut ws,
        &parent,
        "CHILD_MINI_DEFAULT",
        json!({ "model": "gpt-5.4-mini" }),
    )
    .await;
    assert_eq!(
        event["agent"]["effectiveReasoningEffort"], "high",
        "{event}"
    );
    let body = child_body(&mock, "CHILD_MINI_DEFAULT");
    assert_eq!(body["model"], "gpt-5.4-mini", "{body}");
    assert_eq!(body["reasoning"]["effort"], "high", "{body}");
    assert_eq!(body["reasoning"]["summary"], "detailed", "{body}");
    assert_eq!(body["text"]["verbosity"], "low", "{body}");

    // Reasoning child with a supported requested effort: the request wins.
    let _ = spawn_child_and_wait(
        &mut ws,
        &parent,
        "CHILD_MINI_LOW",
        json!({ "model": "gpt-5.4-mini", "reasoningEffort": "low" }),
    )
    .await;
    let body = child_body(&mock, "CHILD_MINI_LOW");
    assert_eq!(body["reasoning"]["effort"], "low", "{body}");
    assert_eq!(body["reasoning"]["summary"], "detailed", "{body}");

    server.shutdown().await;
}

/// Port of `modelRouter.test.ts` "inherits parent reasoningEffort from providerOptions when no
/// model requested" / "parent providerOptions reasoningEffort used as last fallback (no model
/// change)" end to end: a gpt-5.4 parent set to `low` must hand `low` (not the model's `high`
/// default) to a same-model child, and a requested effort passes through verbatim.
#[tokio::test]
async fn same_model_children_inherit_the_parents_current_reasoning_effort() {
    let mut iso = Iso::new("cowork-child-effort-inherit-");
    let mock = start_mock(&mut iso).await;

    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let cwd = iso.workspace.to_string_lossy().into_owned();
    let th = call(
        &mut ws,
        "start",
        "thread/start",
        json!({ "cwd": cwd, "provider": "openai", "model": "gpt-5.4" }),
    )
    .await;
    let parent = th["result"]["thread"]["id"]
        .as_str()
        .unwrap_or_else(|| panic!("thread/start failed: {th}"))
        .to_owned();
    let cfg = call(
        &mut ws,
        "cfg",
        "cowork/session/config/set",
        json!({
            "threadId": parent,
            "config": { "providerOptions": { "openai": { "reasoningEffort": "low" } } }
        }),
    )
    .await;
    assert!(cfg.get("error").is_none(), "config/set failed: {cfg}");

    // No model, no effort: the unchanged child inherits the parent's current effort.
    let event = spawn_child_and_wait(&mut ws, &parent, "CHILD_SAME_INHERIT", json!({})).await;
    assert_eq!(
        event["agent"]["effectiveModel"], "openai:gpt-5.4",
        "{event}"
    );
    assert_eq!(
        event["agent"]["effectiveReasoningEffort"], "low",
        "same-model child must inherit the parent's current effort: {event}"
    );
    assert!(
        event["agent"]["requestedReasoningEffort"].is_null(),
        "{event}"
    );
    let body = child_body(&mock, "CHILD_SAME_INHERIT");
    assert_eq!(body["model"], "gpt-5.4", "{body}");
    assert_eq!(body["reasoning"]["effort"], "low", "{body}");

    // A later parent change is picked up by the next spawn.
    let cfg = call(
        &mut ws,
        "cfg2",
        "cowork/session/config/set",
        json!({
            "threadId": parent,
            "config": { "providerOptions": { "openai": { "reasoningEffort": "medium" } } }
        }),
    )
    .await;
    assert!(cfg.get("error").is_none(), "config/set failed: {cfg}");
    let event = spawn_child_and_wait(&mut ws, &parent, "CHILD_SAME_MEDIUM", json!({})).await;
    assert_eq!(
        event["agent"]["effectiveReasoningEffort"], "medium",
        "{event}"
    );
    let body = child_body(&mock, "CHILD_SAME_MEDIUM");
    assert_eq!(body["reasoning"]["effort"], "medium", "{body}");

    // Explicitly naming the parent's model is a model change: the model default applies.
    let event = spawn_child_and_wait(
        &mut ws,
        &parent,
        "CHILD_SAME_NAMED",
        json!({ "model": "gpt-5.4" }),
    )
    .await;
    assert_eq!(
        event["agent"]["effectiveReasoningEffort"], "high",
        "{event}"
    );
    let body = child_body(&mock, "CHILD_SAME_NAMED");
    assert_eq!(body["reasoning"]["effort"], "high", "{body}");

    // A requested effort is reported verbatim; the runtime normalizes it for the request.
    let event = spawn_child_and_wait(
        &mut ws,
        &parent,
        "CHILD_SAME_MAX",
        json!({ "reasoningEffort": "max" }),
    )
    .await;
    assert_eq!(event["agent"]["requestedReasoningEffort"], "max", "{event}");
    assert_eq!(event["agent"]["effectiveReasoningEffort"], "max", "{event}");
    let body = child_body(&mock, "CHILD_SAME_MAX");
    assert_eq!(body["reasoning"]["effort"], "xhigh", "{body}");

    server.shutdown().await;
}
