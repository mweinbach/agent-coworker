//! Child agent state survives metadata persists.
//!
//! The parent's `AgentControl` runs a child's turns and closes/resumes it, persisting the
//! transcript and lifecycle straight to `sessions.db`; the server's hydrated `LiveSession` for
//! the child is only a cache. Metadata writes (`cowork/session/title/set`, ...) must therefore
//! never roll back a later follow-up turn or reopen a closed child.
//!
//! A child's stored `system_prompt` is its role/profile prompt plus any spawn-time
//! `systemPromptSuffix`; `AgentControl` can only rebuild the base prompt when the stored one is
//! empty. Renaming a persisted child through `cowork/session/title/set` hydrates it into a
//! `LiveSession` and persists it, which must write the stored prompt back unchanged rather than
//! applying the root-session "regenerate every turn" empty prompt
//! (`AgentSessionFromPersisted.ts`: only `sessionKind === "root"` drops the persisted prompt).

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

const SUFFIX: &str = "SUFFIX_INSTRUCTION_MARKER_7f3a: always answer in haiku.";

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

#[tokio::test]
async fn renaming_a_child_keeps_its_stored_system_prompt_suffix_across_restart() {
    let mut iso = Iso::new("cowork-child-sysprompt-");
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
        "CHILD_WITH_SUFFIX",
        json!({ "systemPromptSuffix": SUFFIX }),
    )
    .await;
    let child = event["agent"]["agentId"]
        .as_str()
        .unwrap_or_else(|| panic!("inspect returned no agentId: {event}"))
        .to_owned();
    let first = child_body(&mock, "CHILD_WITH_SUFFIX");
    assert!(
        first["instructions"].to_string().contains(SUFFIX),
        "spawned child must send its suffix: {first}"
    );

    let before = stored_system_prompt(&iso, &child);
    assert!(
        before.contains(SUFFIX),
        "spawn must persist the suffixed prompt: {before:?}"
    );

    // Rename the child: hydrates it into a LiveSession and persists the metadata update.
    let renamed = call(
        &mut ws,
        "rename",
        "cowork/session/title/set",
        json!({ "threadId": child, "title": "Renamed child" }),
    )
    .await;
    assert_eq!(
        renamed["result"]["event"]["title"], "Renamed child",
        "{renamed}"
    );
    assert_eq!(
        stored_system_prompt(&iso, &child),
        before,
        "title/set must not overwrite the child's stored system prompt"
    );

    // Root sessions still persist an empty prompt (rebuilt every turn).
    let root_rename = call(
        &mut ws,
        "rename-root",
        "cowork/session/title/set",
        json!({ "threadId": parent, "title": "Renamed parent" }),
    )
    .await;
    assert!(root_rename.get("error").is_none(), "{root_rename}");
    assert_eq!(stored_system_prompt(&iso, &parent), "");

    drop(ws);
    server.shutdown().await;

    // After a restart the restored child must still run with the suffix.
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    assert!(
        list_child_ids(&mut ws, &parent).await.contains(&child),
        "child must be restored after restart"
    );
    let sent = call(
        &mut ws,
        "send",
        "cowork/session/agent/input/send",
        json!({ "threadId": parent, "agentId": child, "message": "AFTER_RESTART_INPUT" }),
    )
    .await;
    assert_eq!(sent["result"], json!({}), "input/send failed: {sent}");
    let mut body = None;
    for _ in 0..200 {
        if let Some(b) = mock
            .bodies
            .lock()
            .unwrap()
            .iter()
            .find(|b| b["input"].to_string().contains("AFTER_RESTART_INPUT"))
            .cloned()
        {
            body = Some(b);
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let body = body.expect("restored child never sent a request");
    assert!(
        body["instructions"].to_string().contains(SUFFIX),
        "restored child lost its systemPromptSuffix: {body}"
    );
    let _ = wait_child_idle(&mut ws, &parent, &child, "after-restart").await;
    assert_eq!(stored_system_prompt(&iso, &child), before);

    drop(ws);
    server.shutdown().await;
}

// ---------------------------------------------------------------------------------------------
// Transcript and lifecycle owned by AgentControl
// ---------------------------------------------------------------------------------------------

fn stored_messages_json(iso: &Iso, session_id: &str) -> String {
    let conn = rusqlite::Connection::open(iso.home.join(".cowork").join("sessions.db")).unwrap();
    conn.query_row(
        "SELECT messages_json FROM session_state WHERE session_id = ?1",
        [session_id],
        |r| r.get::<_, String>(0),
    )
    .unwrap()
}

fn stored_status(iso: &Iso, session_id: &str) -> (String, Option<String>) {
    let conn = rusqlite::Connection::open(iso.home.join(".cowork").join("sessions.db")).unwrap();
    conn.query_row(
        "SELECT status, execution_state FROM sessions WHERE session_id = ?1",
        [session_id],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)),
    )
    .unwrap()
}

async fn start_parent(ws: &mut WsStream, iso: &Iso) -> String {
    let cwd = iso.workspace.to_string_lossy().into_owned();
    let th = call(
        ws,
        "start",
        "thread/start",
        json!({ "cwd": cwd, "provider": "openai", "model": "gpt-5.4" }),
    )
    .await;
    th["result"]["thread"]["id"]
        .as_str()
        .unwrap_or_else(|| panic!("thread/start failed: {th}"))
        .to_owned()
}

async fn rename(ws: &mut WsStream, thread_id: &str, title: &str) {
    let res = call(
        ws,
        &format!("rename-{title}"),
        "cowork/session/title/set",
        json!({ "threadId": thread_id, "title": title }),
    )
    .await;
    assert_eq!(res["result"]["event"]["title"], title, "{res}");
}

async fn send_child_input(ws: &mut WsStream, parent: &str, child: &str, message: &str) -> Value {
    call(
        ws,
        &format!("send-{message}"),
        "cowork/session/agent/input/send",
        json!({ "threadId": parent, "agentId": child, "message": message }),
    )
    .await
}

async fn wait_for_request_with(mock: &MockState, marker: &str) -> Value {
    for _ in 0..200 {
        if let Some(body) = mock
            .bodies
            .lock()
            .unwrap()
            .iter()
            .find(|b| b["input"].to_string().contains(marker))
            .cloned()
        {
            return body;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("no Responses request carried {marker}");
}

#[tokio::test]
async fn renaming_a_child_after_a_follow_up_keeps_the_follow_up_across_restart() {
    let mut iso = Iso::new("cowork-child-followup-");
    let mock = start_mock(&mut iso).await;

    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let parent = start_parent(&mut ws, &iso).await;
    let event = spawn_child_and_wait(&mut ws, &parent, "FIRST_CHILD_TASK", json!({})).await;
    let child = event["agent"]["agentId"].as_str().unwrap().to_owned();

    // The first rename hydrates the child into the server's LiveSession cache.
    rename(&mut ws, &child, "Rename one").await;

    // A follow-up through the parent's controller is persisted by AgentControl directly.
    let sent = send_child_input(&mut ws, &parent, &child, "FOLLOW_UP_MARKER_91c2").await;
    assert_eq!(sent["result"], json!({}), "input/send failed: {sent}");
    let _ = wait_for_request_with(&mock, "FOLLOW_UP_MARKER_91c2").await;
    let _ = wait_child_idle(&mut ws, &parent, &child, "follow-up").await;
    assert!(
        stored_messages_json(&iso, &child).contains("FOLLOW_UP_MARKER_91c2"),
        "AgentControl must persist the follow-up"
    );

    // The second rename must not write the cached pre-follow-up transcript back.
    rename(&mut ws, &child, "Rename two").await;
    assert!(
        stored_messages_json(&iso, &child).contains("FOLLOW_UP_MARKER_91c2"),
        "title/set rolled back the child's follow-up turn"
    );

    drop(ws);
    server.shutdown().await;

    // After a restart the restored child still carries the follow-up in its history.
    assert!(stored_messages_json(&iso, &child).contains("FOLLOW_UP_MARKER_91c2"));
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let read = call(
        &mut ws,
        "read-child",
        "thread/read",
        json!({ "threadId": child, "includeTurns": true }),
    )
    .await;
    assert!(
        read.to_string().contains("FOLLOW_UP_MARKER_91c2"),
        "restored child history lost the follow-up: {read}"
    );
    let sent = send_child_input(&mut ws, &parent, &child, "AFTER_RESTART_91c2").await;
    assert_eq!(sent["result"], json!({}), "input/send failed: {sent}");
    let body = wait_for_request_with(&mock, "AFTER_RESTART_91c2").await;
    assert!(
        body["input"].to_string().contains("FOLLOW_UP_MARKER_91c2"),
        "restored child ran without its follow-up history: {body}"
    );
    let _ = wait_child_idle(&mut ws, &parent, &child, "after-restart").await;

    drop(ws);
    server.shutdown().await;
}

#[tokio::test]
async fn renaming_a_closed_child_keeps_it_closed_across_restart() {
    let mut iso = Iso::new("cowork-child-closed-");
    let mock = start_mock(&mut iso).await;

    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let parent = start_parent(&mut ws, &iso).await;
    let event = spawn_child_and_wait(&mut ws, &parent, "CLOSED_CHILD_TASK", json!({})).await;
    let child = event["agent"]["agentId"].as_str().unwrap().to_owned();

    // Hydrate the child while it is still active, then close it through the controller.
    rename(&mut ws, &child, "Before close").await;
    let closed = call(
        &mut ws,
        "close",
        "cowork/session/agent/close",
        json!({ "threadId": parent, "agentId": child }),
    )
    .await;
    assert_eq!(closed["result"], json!({}), "close failed: {closed}");
    assert_eq!(stored_status(&iso, &child).0, "closed");

    // Renaming the closed child must keep its durable lifecycle.
    rename(&mut ws, &child, "After close").await;
    assert_eq!(
        stored_status(&iso, &child),
        ("closed".to_owned(), Some("closed".to_owned())),
        "title/set reopened the closed child"
    );

    drop(ws);
    server.shutdown().await;

    // A restart hydrates the closed child; renaming it again still keeps it closed.
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    rename(&mut ws, &child, "After restart").await;
    assert_eq!(stored_status(&iso, &child).0, "closed");
    drop(ws);
    server.shutdown().await;

    // The reconstructed controller sees the child closed and rejects input until resumed.
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let inspected = call(
        &mut ws,
        "inspect-closed",
        "cowork/session/agent/inspect",
        json!({ "threadId": parent, "agentId": child }),
    )
    .await;
    assert_eq!(
        inspected["result"]["event"]["agent"]["lifecycleState"], "closed",
        "{inspected}"
    );
    let rejected = send_child_input(&mut ws, &parent, &child, "WHILE_CLOSED_5e1d").await;
    assert!(
        rejected["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("is closed")),
        "closed child accepted input: {rejected}"
    );
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(
        !mock
            .bodies
            .lock()
            .unwrap()
            .iter()
            .any(|b| b["input"].to_string().contains("WHILE_CLOSED_5e1d")),
        "closed child ran a turn"
    );

    let resumed = call(
        &mut ws,
        "resume",
        "cowork/session/agent/resume",
        json!({ "threadId": parent, "agentId": child }),
    )
    .await;
    assert_eq!(resumed["result"], json!({}), "resume failed: {resumed}");
    assert_eq!(stored_status(&iso, &child).0, "active");
    let sent = send_child_input(&mut ws, &parent, &child, "AFTER_RESUME_5e1d").await;
    assert_eq!(sent["result"], json!({}), "input/send failed: {sent}");
    let _ = wait_for_request_with(&mock, "AFTER_RESUME_5e1d").await;
    let _ = wait_child_idle(&mut ws, &parent, &child, "after-resume").await;

    drop(ws);
    server.shutdown().await;
}
