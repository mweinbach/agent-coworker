//! Regression coverage for thread model reconciliation, fork model refs, skill read roots,
//! turn-usage notifications, `task/*` cwd authorization, persisted child-agent restrictions,
//! and legacy model alias hydration.

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

struct Iso {
    _root: TempDir,
    home: PathBuf,
    workspace: PathBuf,
    base: PathBuf,
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
        env.insert("COWORK_ENABLE_TASKS".into(), "1".into());
        env.insert("PATH".into(), "/usr/local/bin:/usr/bin:/bin".into());
        Self {
            _root: root,
            home,
            workspace,
            base,
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

fn completed(resp_id: &str) -> String {
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
    s.push_str(&completed(resp_id));
    s
}

fn tool_call_sse(resp_id: &str, call_id: &str, name: &str, args: Value) -> String {
    let args_str = serde_json::to_string(&args).unwrap();
    let mut s = sse_event(
        "response.created",
        json!({ "type": "response.created", "response": { "id": resp_id } }),
    );
    s.push_str(&sse_event(
        "response.output_item.added",
        json!({
            "type": "response.output_item.added",
            "output_index": 0,
            "item": { "type": "function_call", "id": "fc_0", "call_id": call_id, "name": name }
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
            "item": { "type": "function_call", "id": "fc_0", "call_id": call_id, "name": name, "arguments": args_str }
        }),
    ));
    s.push_str(&completed(resp_id));
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
                "clientInfo": { "name": "thread-model-usage-tests", "version": "1.0.0" },
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

async fn call(
    ws: &mut WsStream,
    id: &str,
    method: &str,
    params: Value,
    notifs: &mut Vec<Value>,
) -> Value {
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
            if val.get("method").is_some() {
                notifs.push(val);
            }
        }
    }
}

async fn wait_for_method(ws: &mut WsStream, notifs: &mut Vec<Value>, method: &str) {
    if notifs.iter().any(|n| n["method"] == method) {
        return;
    }
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    while tokio::time::Instant::now() < deadline {
        let rem = deadline.saturating_duration_since(tokio::time::Instant::now());
        if let Ok(Some(Ok(WsMessage::Text(txt)))) = tokio::time::timeout(rem, ws.next()).await
            && let Ok(val) = serde_json::from_str::<Value>(&txt)
            && val.get("method").is_some()
        {
            let done = val["method"] == method;
            notifs.push(val);
            if done {
                return;
            }
        }
    }
    panic!("timed out waiting for {method}; got {notifs:?}");
}

async fn run_turn(ws: &mut WsStream, thread_id: &str, text: &str, id: &str) -> Vec<Value> {
    let mut notifs = Vec::new();
    let res = call(
        ws,
        id,
        "turn/start",
        json!({ "threadId": thread_id, "input": [{ "type": "text", "text": text }] }),
        &mut notifs,
    )
    .await;
    assert!(res.get("error").is_none(), "turn/start failed: {res}");
    wait_for_method(ws, &mut notifs, "turn/completed").await;
    notifs
}

async fn start_thread(ws: &mut WsStream, cwd: &str, provider: &str, model: &str) -> String {
    let mut notifs = Vec::new();
    let res = call(
        ws,
        "start",
        "thread/start",
        json!({ "cwd": cwd, "provider": provider, "model": model }),
        &mut notifs,
    )
    .await;
    res["result"]["thread"]["id"]
        .as_str()
        .unwrap_or_else(|| panic!("thread/start failed: {res}"))
        .to_owned()
}

fn tool_names(body: &Value) -> Vec<String> {
    body["tools"]
        .as_array()
        .map(|tools| {
            tools
                .iter()
                .filter_map(|t| t["name"].as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

#[allow(clippy::too_many_arguments)]
fn persist_snapshot(
    session_id: &str,
    kind: &str,
    parent: Option<&str>,
    role: Option<&str>,
    provider: &str,
    model: &str,
    cwd: &str,
    provider_state: Value,
) -> cowork_storage::PersistedSessionMutation {
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    serde_json::from_value(json!({
        "sessionId": session_id,
        "eventType": "thread/started",
        "eventTs": now,
        "direction": null,
        "payload": null,
        "snapshot": {
            "sessionKind": kind,
            "parentSessionId": parent,
            "role": role,
            "mode": null,
            "depth": if kind == "agent" { json!(1) } else { Value::Null },
            "nickname": null,
            "taskType": null,
            "targetPaths": null,
            "profile": null,
            "requestedModel": null,
            "effectiveModel": null,
            "requestedReasoningEffort": null,
            "effectiveReasoningEffort": null,
            "executionState": null,
            "lastMessagePreview": null,
            "title": "Persisted",
            "titleSource": "manual",
            "titleModel": null,
            "provider": provider,
            "model": model,
            "workingDirectory": cwd,
            "outputDirectory": null,
            "uploadsDirectory": null,
            "providerOptions": null,
            "sandbox": null,
            "enableMcp": false,
            "backupsEnabledOverride": null,
            "createdAt": now,
            "updatedAt": now,
            "status": "active",
            "hasPendingAsk": false,
            "hasPendingApproval": false,
            "systemPrompt": "",
            "messages": [],
            "lastMemoryGeneratedIndex": null,
            "providerState": provider_state,
            "todos": [],
            "harnessContext": null,
            "costTracker": null
        }
    }))
    .expect("valid persisted session mutation")
}

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

/// Switching a thread to a non-reasoning model drops stored reasoning options, and every
/// ordinary turn emits `cowork/session/turnUsage` + `cowork/session/usage` before completion.
#[tokio::test]
async fn model_switch_drops_reasoning_and_turns_emit_usage() {
    let mut iso = Iso::new("cowork-model-usage-");
    let mock = start_mock(&mut iso).await;
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let cwd = iso.workspace.to_string_lossy().into_owned();
    let thread_id = start_thread(&mut ws, &cwd, "openai", "gpt-5.4").await;

    let mut ignored = Vec::new();
    let cfg = call(
        &mut ws,
        "cfg",
        "cowork/session/config/set",
        json!({
            "threadId": thread_id,
            "config": { "providerOptions": { "openai": { "reasoningEffort": "low" } } }
        }),
        &mut ignored,
    )
    .await;
    assert!(cfg.get("error").is_none(), "config/set failed: {cfg}");

    // Reasoning model: the stored effort is sent.
    let notifs = run_turn(&mut ws, &thread_id, "first", "turn-1").await;
    {
        let bodies = mock.bodies.lock().unwrap();
        assert_eq!(bodies[0]["reasoning"]["effort"], "low", "{}", bodies[0]);
    }
    let pos = |m: &str| notifs.iter().position(|n| n["method"] == m);
    let turn_usage_idx = pos("cowork/session/turnUsage").expect("turnUsage notification");
    let session_usage_idx = pos("cowork/session/usage").expect("session usage notification");
    let completed_idx = pos("turn/completed").unwrap();
    assert!(turn_usage_idx < completed_idx && session_usage_idx < completed_idx);
    let turn_usage = &notifs[turn_usage_idx]["params"];
    assert_eq!(turn_usage["type"], "turn_usage");
    assert_eq!(turn_usage["sessionId"], thread_id);
    assert!(turn_usage["turnId"].as_str().is_some_and(|s| !s.is_empty()));
    assert_eq!(turn_usage["usage"]["promptTokens"], 18);
    assert_eq!(turn_usage["usage"]["completionTokens"], 9);
    assert_eq!(turn_usage["usage"]["totalTokens"], 27);
    let session_usage = &notifs[session_usage_idx]["params"];
    assert_eq!(session_usage["type"], "session_usage");
    assert_eq!(session_usage["usage"]["sessionId"], thread_id);
    assert_eq!(session_usage["usage"]["totalTurns"], 1);
    assert_eq!(session_usage["usage"]["totalTokens"], 27);
    assert!(session_usage["usage"]["budgetStatus"].is_object());

    // Switch to a non-reasoning custom id: no `reasoning` payload may be forwarded.
    let set = call(
        &mut ws,
        "model",
        "cowork/session/model/set",
        json!({ "threadId": thread_id, "provider": "openai", "model": "gpt-4o" }),
        &mut ignored,
    )
    .await;
    assert!(set.get("error").is_none(), "model/set failed: {set}");
    let live = server.runtime().load_thread(&thread_id).unwrap();
    assert!(
        live.lock()
            .config_overrides
            .get("providerOptions")
            .and_then(|po| po.get("openai"))
            .and_then(|o| o.get("reasoningEffort"))
            .is_none(),
        "stored reasoningEffort must be reconciled away on model switch"
    );

    let notifs = run_turn(&mut ws, &thread_id, "second", "turn-2").await;
    {
        let bodies = mock.bodies.lock().unwrap();
        let last = bodies.last().unwrap();
        assert_eq!(last["model"], "gpt-4o");
        assert!(
            last.get("reasoning").is_none(),
            "stale reasoning sent: {last}"
        );
        assert!(last.get("text").and_then(|t| t.get("verbosity")).is_none());
    }
    let session_usage = notifs
        .iter()
        .find(|n| n["method"] == "cowork/session/usage")
        .expect("usage after second turn");
    assert_eq!(session_usage["params"]["usage"]["totalTurns"], 2);
}

/// `thread/fork` parses `provider:modelId` refs and keeps `/` inside model IDs.
#[tokio::test]
async fn fork_model_refs_preserve_slashes() {
    let iso = Iso::new("cowork-fork-ref-");
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let cwd = iso.workspace.to_string_lossy().into_owned();
    let source = start_thread(&mut ws, &cwd, "nvidia", "moonshotai/kimi-k2-instruct").await;
    let mut ignored = Vec::new();

    let fork = |model: &'static str| json!({ "threadId": source, "model": model });
    let qualified = call(
        &mut ws,
        "f1",
        "thread/fork",
        fork("baseten:nvidia/Nemotron-120B-A12B"),
        &mut ignored,
    )
    .await;
    assert!(qualified.get("error").is_none(), "{qualified}");
    assert_eq!(qualified["result"]["thread"]["modelProvider"], "baseten");
    assert_eq!(
        qualified["result"]["thread"]["model"],
        "nvidia/Nemotron-120B-A12B"
    );

    let bare = call(
        &mut ws,
        "f2",
        "thread/fork",
        fork("nvidia/Nemotron-120B-A12B"),
        &mut ignored,
    )
    .await;
    assert!(bare.get("error").is_none(), "{bare}");
    assert_eq!(bare["result"]["thread"]["modelProvider"], "nvidia");
    assert_eq!(
        bare["result"]["thread"]["model"],
        "nvidia/Nemotron-120B-A12B"
    );
}

/// Reference files of skills discovered under `~/.agents/skills` are readable by `read`, while
/// credential paths stay denied.
#[tokio::test]
async fn discovered_skill_reference_files_are_readable() {
    let mut iso = Iso::new("cowork-skill-roots-");
    let skill_dir = iso.home.join(".agents/skills/demo-skill");
    fs::create_dir_all(skill_dir.join("references")).unwrap();
    fs::write(
        skill_dir.join("SKILL.md"),
        "---\nname: demo-skill\ndescription: Demo skill for read-root coverage.\n---\n\n# Demo\n",
    )
    .unwrap();
    let reference = skill_dir.join("references/guide.md");
    fs::write(&reference, "SKILL-REFERENCE-MARKER-42").unwrap();
    let outside = iso.base.join("outside.txt");
    fs::write(&outside, "OUTSIDE-MARKER").unwrap();

    let mock = start_mock(&mut iso).await;
    mock.replies.lock().unwrap().extend([
        tool_call_sse(
            "resp_1",
            "call_read_skill",
            "read",
            json!({ "filePath": reference.to_string_lossy() }),
        ),
        tool_call_sse(
            "resp_2",
            "call_read_outside",
            "read",
            json!({ "filePath": outside.to_string_lossy() }),
        ),
        text_sse("resp_3", "Read it."),
    ]);
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let cwd = iso.workspace.to_string_lossy().into_owned();
    let thread_id = start_thread(&mut ws, &cwd, "openai", "gpt-5.4").await;
    run_turn(&mut ws, &thread_id, "read the skill guide", "turn-skill").await;

    let bodies = mock.bodies.lock().unwrap();
    assert!(
        bodies.len() >= 3,
        "expected 3 model requests, got {}",
        bodies.len()
    );
    let second = bodies[1].to_string();
    assert!(
        second.contains("SKILL-REFERENCE-MARKER-42"),
        "skill reference read must succeed: {second}"
    );
    let third = bodies[2].to_string();
    assert!(
        !third.contains("OUTSIDE-MARKER"),
        "non-skill path must stay blocked"
    );
    assert!(
        third.contains("readRoots") || third.contains("blocked"),
        "{third}"
    );
}

/// `task/*` cwd must be absolute, canonical and equal to the server workspace or a
/// desktop-registered project workspace.
#[tokio::test]
async fn task_routes_require_authorized_canonical_cwd() {
    let mut iso = Iso::new("cowork-task-cwd-");
    iso.env
        .insert("COWORK_WEB_DESKTOP_SERVICE".into(), "1".into());
    let unregistered = iso.base.join("elsewhere");
    let registered = iso.base.join("registered-project");
    fs::create_dir_all(&unregistered).unwrap();
    fs::create_dir_all(&registered).unwrap();
    let server = start_server(iso.options()).await.unwrap();
    server
        .runtime()
        .desktop_service
        .as_ref()
        .expect("desktop service")
        .save_state_json(
            json!({
                "workspaces": [{
                    "id": "ws-registered",
                    "name": "Registered",
                    "path": registered.to_string_lossy(),
                    "workspaceKind": "project"
                }]
            }),
            &iso.workspace,
        )
        .unwrap();
    let mut ws = connect(server.ws_url()).await;
    let mut ignored = Vec::new();

    let mut list = async |id: &str, cwd: Value| {
        call(
            &mut ws,
            id,
            "task/list",
            json!({ "cwd": cwd }),
            &mut ignored,
        )
        .await
    };

    // Relative path (resolves to an existing dir under the server workspace's parent).
    fs::create_dir_all(iso.workspace.join("sub")).unwrap();
    let rel = list("rel", json!("sub")).await;
    assert_eq!(rel["error"]["code"], -32600, "{rel}");
    let rel_ws = list("rel-ws", json!(".")).await;
    assert_eq!(rel_ws["error"]["code"], -32600, "{rel_ws}");

    let other = list("other", json!(unregistered.to_string_lossy())).await;
    assert_eq!(other["error"]["code"], -32600, "{other}");
    assert!(
        other["error"]["message"]
            .as_str()
            .unwrap_or("")
            .contains("authorized"),
        "{other}"
    );

    // Non-canonical spelling of the server workspace is rejected.
    let dotted = format!(
        "{}/../workspace",
        iso.workspace.join("sub").to_string_lossy()
    );
    let non_canon = list("noncanon", json!(dotted)).await;
    assert_eq!(non_canon["error"]["code"], -32600, "{non_canon}");

    let server_ws = list("ws", json!(iso.workspace.to_string_lossy())).await;
    assert!(server_ws.get("error").is_none(), "{server_ws}");
    let project = list("proj", json!(registered.to_string_lossy())).await;
    assert!(project.get("error").is_none(), "{project}");
    let default_cwd = call(&mut ws, "none", "task/list", json!({}), &mut ignored).await;
    assert!(default_cwd.get("error").is_none(), "{default_cwd}");
}

/// A direct `turn/start` on a persisted read-only child agent keeps the child's tool scope, and
/// an unrestorable child fails closed.
#[tokio::test]
async fn direct_turn_on_persisted_child_keeps_restrictions() {
    let mut iso = Iso::new("cowork-child-scope-");
    let mock = start_mock(&mut iso).await;
    let target = iso.workspace.join("should-not-exist.txt");
    mock.replies.lock().unwrap().extend([
        tool_call_sse(
            "resp_w",
            "call_write",
            "write",
            json!({ "filePath": target.to_string_lossy(), "content": "nope" }),
        ),
        text_sse("resp_done", "Done."),
    ]);
    let server = start_server(iso.options()).await.unwrap();
    let cwd = iso.workspace.to_string_lossy().into_owned();
    let mut ws = connect(server.ws_url()).await;
    let parent = start_thread(&mut ws, &cwd, "openai", "gpt-5.4").await;

    let db = &server.runtime().session_db;
    db.persist_session_mutation(persist_snapshot(
        "child-explorer",
        "agent",
        Some(&parent),
        Some("explorer"),
        "openai",
        "gpt-5.4",
        &cwd,
        Value::Null,
    ))
    .await
    .unwrap();
    db.persist_session_mutation(persist_snapshot(
        "child-broken",
        "agent",
        Some(&parent),
        Some("no-such-role"),
        "openai",
        "gpt-5.4",
        &cwd,
        Value::Null,
    ))
    .await
    .unwrap();

    run_turn(&mut ws, "child-explorer", "write a file", "child-turn").await;
    {
        let bodies = mock.bodies.lock().unwrap();
        let names = tool_names(&bodies[0]);
        assert!(names.iter().any(|n| n == "read"), "{names:?}");
        assert!(
            !names.iter().any(|n| n == "write" || n == "edit"),
            "read-only child must not expose mutation tools: {names:?}"
        );
    }
    assert!(!target.exists(), "read-only child must not write files");

    let mut ignored = Vec::new();
    let broken = call(
        &mut ws,
        "broken",
        "turn/start",
        json!({ "threadId": "child-broken", "input": [{ "type": "text", "text": "hi" }] }),
        &mut ignored,
    )
    .await;
    assert_eq!(broken["error"]["code"], -32600, "{broken}");
    assert!(
        broken["error"]["message"]
            .as_str()
            .unwrap_or("")
            .contains("cannot run"),
        "{broken}"
    );
    let live = server.runtime().load_thread("child-broken").unwrap();
    assert!(
        !live.lock().busy,
        "failed child turn must release the thread"
    );
}

/// Hydrating a persisted thread migrates legacy model aliases and clears stale continuation.
#[tokio::test]
async fn hydration_applies_legacy_model_alias() {
    let iso = Iso::new("cowork-legacy-alias-");
    let server = start_server(iso.options()).await.unwrap();
    let cwd = iso.workspace.to_string_lossy().into_owned();
    let db = &server.runtime().session_db;
    db.persist_session_mutation(persist_snapshot(
        "legacy-google",
        "root",
        None,
        None,
        "google",
        "gemini-3-pro-preview",
        &cwd,
        json!({ "provider": "google", "model": "gemini-3-pro-preview", "responseId": "old" }),
    ))
    .await
    .unwrap();
    db.persist_session_mutation(persist_snapshot(
        "current-google",
        "root",
        None,
        None,
        "google",
        "gemini-3.1-pro-preview",
        &cwd,
        json!({ "provider": "google", "model": "gemini-3.1-pro-preview", "responseId": "keep" }),
    ))
    .await
    .unwrap();

    let legacy = server.runtime().load_thread("legacy-google").unwrap();
    {
        let live = legacy.lock();
        assert_eq!(live.model, "gemini-3.1-pro-preview-customtools");
        assert!(live.provider_state.is_none());
    }
    let current = server.runtime().load_thread("current-google").unwrap();
    {
        let live = current.lock();
        assert_eq!(live.model, "gemini-3.1-pro-preview");
        assert!(live.provider_state.is_some());
    }
}
