//! A direct `turn/start` on a child agent session runs with the child's own system prompt.
//!
//! TS ran every turn with `state.system`, which only root sessions regenerate: a child keeps
//! the role/profile prompt plus spawn-time `systemPromptSuffix` it was created with
//! (`AgentControl.ts`, restored by `AgentSessionFromPersisted.ts`). A resumed child must
//! therefore not be given the root/model template on the direct turn path, and a
//! `cowork/session/config/set` profile change on the child keeps that prompt (the profile is
//! re-rendered into it) for direct turns, executor turns and restarts alike.

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
                "clientInfo": { "name": "child-system-prompt-persistence", "version": "1.0.0" },
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

const SUFFIX: &str = "SUFFIX_INSTRUCTION_MARKER_91c2: always answer in haiku.";

fn stored_system_prompt(iso: &Iso, session_id: &str) -> String {
    let conn = rusqlite::Connection::open(iso.home.join(".cowork").join("sessions.db")).unwrap();
    conn.query_row(
        "SELECT system_prompt FROM session_state WHERE session_id = ?1",
        [session_id],
        |r| r.get::<_, String>(0),
    )
    .unwrap()
}

async fn wait_child_idle(ws: &mut WsStream, parent_id: &str, agent_id: &str, tag: &str) -> Value {
    for i in 0..200 {
        let res = call(
            ws,
            &format!("insp-{tag}-{i}"),
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
    panic!("child {agent_id} never went idle ({tag})");
}

/// Runs a direct `turn/start` on `thread_id` and waits for its `turn/completed`.
async fn run_direct_turn(ws: &mut WsStream, id: &str, thread_id: &str, text: &str) {
    let res = call(
        ws,
        id,
        "turn/start",
        json!({ "threadId": thread_id, "input": text }),
    )
    .await;
    let turn_id = res["result"]["turn"]["id"]
        .as_str()
        .unwrap_or_else(|| panic!("turn/start failed: {res}"))
        .to_owned();
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(20), ws.next())
            .await
            .expect("turn/completed timeout")
            .expect("ws open")
            .expect("ws frame");
        if let WsMessage::Text(txt) = frame {
            let val: Value = serde_json::from_str(&txt).unwrap();
            if val["method"] == "turn/completed" && val["params"]["turn"]["id"] == turn_id.as_str()
            {
                return;
            }
        }
    }
}

/// The `instructions` the request that carried `marker` sent.
fn instructions_for(mock: &MockState, marker: &str) -> String {
    child_body(mock, marker)["instructions"]
        .as_str()
        .unwrap_or_else(|| panic!("request for {marker} has no instructions"))
        .to_owned()
}

/// Polls for the request that carried `marker` (executor turns run in the background).
async fn wait_instructions_for(mock: &MockState, marker: &str) -> String {
    for _ in 0..200 {
        let found = mock
            .bodies
            .lock()
            .unwrap()
            .iter()
            .any(|b| b["input"].to_string().contains(marker));
        if found {
            return instructions_for(mock, marker);
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("no Responses request carried {marker}");
}

const ROOT_TEMPLATE_OPENING: &str =
    "You are an AI assistant running locally on the user's computer.";
const SUB_AGENT_BASE_OPENING: &str = "You are a collaborative child agent";

/// The child's role prompt + suffix lead its instructions and the root template is absent.
fn assert_child_prompt(instructions: &str, saved: &str, context: &str) {
    assert!(
        instructions.starts_with(saved.trim()),
        "{context}: instructions must start with the child's saved prompt.\nsaved: {saved}\ninstructions: {instructions}"
    );
    assert!(
        instructions.contains(SUB_AGENT_BASE_OPENING),
        "{context}: role prompt missing: {instructions}"
    );
    assert_eq!(
        instructions.matches(SUFFIX).count(),
        1,
        "{context}: suffix must appear exactly once: {instructions}"
    );
    assert!(
        !instructions.contains(ROOT_TEMPLATE_OPENING),
        "{context}: root template must not be used for a child: {instructions}"
    );
}

#[tokio::test]
async fn direct_turn_on_resumed_child_uses_its_role_prompt_and_suffix() {
    let mut iso = Iso::new("cowork-child-direct-turn-");
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
    let event = spawn_child_and_wait(
        &mut ws,
        &parent,
        "SPAWN_WITH_SUFFIX",
        json!({ "systemPromptSuffix": SUFFIX }),
    )
    .await;
    let child = event["agent"]["agentId"].as_str().unwrap().to_owned();
    let saved = stored_system_prompt(&iso, &child);
    assert!(saved.contains(SUFFIX), "{saved:?}");
    drop(ws);
    server.shutdown().await;

    // After a restart, a direct turn on the child runs with its saved prompt.
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    // Hydrate the parent's controller so the child's executor copy is live too.
    assert!(list_child_ids(&mut ws, &parent).await.contains(&child));
    run_direct_turn(&mut ws, "direct-1", &child, "DIRECT_AFTER_RESTART").await;
    let instructions = instructions_for(&mock, "DIRECT_AFTER_RESTART");
    assert_child_prompt(&instructions, &saved, "direct turn after restart");

    // A root session still gets the root (model) template.
    run_direct_turn(&mut ws, "root-1", &parent, "ROOT_DIRECT_TURN").await;
    let root_instructions = instructions_for(&mock, "ROOT_DIRECT_TURN");
    assert!(
        root_instructions.contains(ROOT_TEMPLATE_OPENING),
        "{root_instructions}"
    );
    assert!(!root_instructions.contains(SUFFIX), "{root_instructions}");

    // A child profile change keeps the role prompt + suffix and carries the profile.
    let set = call(
        &mut ws,
        "cfg-1",
        "cowork/session/config/set",
        json!({ "threadId": child, "config": { "userName": "FIRST_CHILD_USER_MARKER" } }),
    )
    .await;
    assert!(set.get("error").is_none(), "{set}");
    let stored = stored_system_prompt(&iso, &child);
    assert!(stored.starts_with(saved.trim()), "{stored}");
    assert!(stored.contains("FIRST_CHILD_USER_MARKER"), "{stored}");
    run_direct_turn(&mut ws, "direct-2", &child, "DIRECT_AFTER_PROFILE").await;
    let instructions = instructions_for(&mock, "DIRECT_AFTER_PROFILE");
    assert_child_prompt(&instructions, &saved, "direct turn after profile change");
    assert!(
        instructions.contains("FIRST_CHILD_USER_MARKER"),
        "{instructions}"
    );

    // The executor path runs with the same prompt and does not persist a stale copy.
    let sent = call(
        &mut ws,
        "send",
        "cowork/session/agent/input/send",
        json!({ "threadId": parent, "agentId": child, "message": "EXECUTOR_AFTER_PROFILE" }),
    )
    .await;
    assert_eq!(sent["result"], json!({}), "input/send failed: {sent}");
    let instructions = wait_instructions_for(&mock, "EXECUTOR_AFTER_PROFILE").await;
    assert_child_prompt(&instructions, &saved, "executor turn after profile change");
    assert!(
        instructions.contains("FIRST_CHILD_USER_MARKER"),
        "{instructions}"
    );
    let _ = wait_child_idle(&mut ws, &parent, &child, "executor").await;
    assert_eq!(stored_system_prompt(&iso, &child), stored);

    // A later change replaces the profile section rather than stacking another one.
    let set = call(
        &mut ws,
        "cfg-2",
        "cowork/session/config/set",
        json!({ "threadId": child, "config": { "userName": "SECOND_CHILD_USER_MARKER" } }),
    )
    .await;
    assert!(set.get("error").is_none(), "{set}");
    let stored = stored_system_prompt(&iso, &child);
    assert!(stored.contains("SECOND_CHILD_USER_MARKER"), "{stored}");
    assert!(!stored.contains("FIRST_CHILD_USER_MARKER"), "{stored}");
    assert_eq!(stored.matches(SUFFIX).count(), 1, "{stored}");
    drop(ws);
    server.shutdown().await;

    // The regenerated prompt survives a restart.
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    run_direct_turn(&mut ws, "direct-3", &child, "DIRECT_AFTER_SECOND_RESTART").await;
    let instructions = instructions_for(&mock, "DIRECT_AFTER_SECOND_RESTART");
    assert_child_prompt(&instructions, &saved, "direct turn after second restart");
    assert!(
        instructions.contains("SECOND_CHILD_USER_MARKER"),
        "{instructions}"
    );
    drop(ws);
    server.shutdown().await;
}

#[tokio::test]
async fn direct_turn_on_legacy_child_without_saved_prompt_rebuilds_its_role_prompt() {
    let mut iso = Iso::new("cowork-child-direct-legacy-");
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
    let parent = th["result"]["thread"]["id"].as_str().unwrap().to_owned();
    let event = spawn_child_and_wait(&mut ws, &parent, "SPAWN_LEGACY", json!({})).await;
    let child = event["agent"]["agentId"].as_str().unwrap().to_owned();
    let saved = stored_system_prompt(&iso, &child);
    drop(ws);
    server.shutdown().await;

    // A row written before children persisted their prompt.
    let conn = rusqlite::Connection::open(iso.home.join(".cowork").join("sessions.db")).unwrap();
    conn.execute(
        "UPDATE session_state SET system_prompt = '' WHERE session_id = ?1",
        [&child],
    )
    .unwrap();
    drop(conn);

    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    run_direct_turn(&mut ws, "direct", &child, "LEGACY_DIRECT_TURN").await;
    let instructions = instructions_for(&mock, "LEGACY_DIRECT_TURN");
    assert!(
        instructions.starts_with(saved.trim()),
        "the rebuilt role prompt must match the spawn-time one.\nsaved: {saved}\ninstructions: {instructions}"
    );
    assert!(
        !instructions.contains(ROOT_TEMPLATE_OPENING),
        "{instructions}"
    );
    drop(ws);
    server.shutdown().await;
}
