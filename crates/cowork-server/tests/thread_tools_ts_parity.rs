//! TS `LocalThreadHost` parity for the agent-facing thread-management tools
//! (`ServerThreadControlBridge`):
//! - `list_threads` enumerates root threads across every workspace (projects and managed
//!   one-off chats) by default, filtering by `cwd` only when one is passed;
//! - `create_thread` requires a prompt and queues it as the new thread's first turn;
//! - `read_thread` returns a compact, cursor-paginated transcript without the UI hydration
//!   snapshot, omitting tool outputs unless asked for.

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
        env.insert("AGENT_PROVIDER".into(), "openai".into());
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
                "id": resp_id,
                "status": "completed",
                "output": [],
                "usage": { "input_tokens": 18, "output_tokens": 9 }
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
                "clientInfo": { "name": "thread-tools-parity-tests", "version": "1.0.0" },
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
        connection_id: "thread-tools-parity-test".to_owned(),
    }
}

fn ids(res: &Value) -> Vec<String> {
    res["threads"]
        .as_array()
        .unwrap_or_else(|| panic!("threads missing: {res}"))
        .iter()
        .map(|t| t["id"].as_str().unwrap().to_owned())
        .collect()
}

fn tool_schema(name: &str) -> Value {
    ThreadManagementTool::all_tools()
        .into_iter()
        .find(|tool| tool.name() == name)
        .unwrap_or_else(|| panic!("missing tool {name}"))
        .input_schema()
}

// ---------------------------------------------------------------------------------------------
// list_threads
// ---------------------------------------------------------------------------------------------

/// TS `listThreads` enumerates root sessions across all workspaces (projects and managed
/// one-off chats) before applying its query and limit.
#[tokio::test]
async fn list_threads_discovers_threads_across_workspaces_by_default() {
    let iso = Iso::new("cowork-thread-tools-global-");
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let bridge = bridge(&server);

    let chat_dir = cowork_config::get_one_off_chats_root(&iso.home).join("chat-elsewhere");
    fs::create_dir_all(&chat_dir).unwrap();
    let chat_cwd = fs::canonicalize(&chat_dir)
        .unwrap()
        .to_string_lossy()
        .into_owned();

    let project_thread = start_thread(&mut ws, &iso.cwd(), "start-project").await;
    bridge
        .set_thread_title(json!({ "threadId": project_thread, "title": "project work" }))
        .await
        .unwrap();
    let chat_thread = start_thread(&mut ws, &chat_cwd, "start-chat").await;
    bridge
        .set_thread_title(json!({ "threadId": chat_thread, "title": "chat elsewhere" }))
        .await
        .unwrap();

    // Default: every workspace.
    let res = bridge.list_threads(json!({})).await.unwrap();
    let listed = ids(&res);
    assert!(listed.contains(&project_thread), "{res}");
    assert!(listed.contains(&chat_thread), "{res}");
    assert_eq!(res["total"], json!(2), "{res}");

    // Query and limit still apply over the global set.
    let res = bridge
        .list_threads(json!({ "query": "ELSEWHERE" }))
        .await
        .unwrap();
    assert_eq!(ids(&res), vec![chat_thread.clone()], "{res}");
    let res = bridge.list_threads(json!({ "limit": 1 })).await.unwrap();
    assert_eq!(ids(&res).len(), 1, "{res}");
    assert_eq!(res["total"], json!(2), "{res}");

    // Project threads carry their project; a query on the project id finds them (TS
    // `threadMatchesQuery` checks projectId/projectName).
    let listed = bridge.list_threads(json!({})).await.unwrap();
    let project_entry = listed["threads"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == json!(project_thread))
        .unwrap()
        .clone();
    let project_id = project_entry["projectId"]
        .as_str()
        .unwrap_or_else(|| panic!("projectId missing: {project_entry}"))
        .to_owned();
    assert!(project_entry["projectName"].is_string(), "{project_entry}");
    let chat_entry = listed["threads"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == json!(chat_thread))
        .unwrap()
        .clone();
    assert!(chat_entry.get("projectId").is_none(), "{chat_entry}");
    let res = bridge
        .list_threads(json!({ "query": project_id }))
        .await
        .unwrap();
    assert_eq!(ids(&res), vec![project_thread.clone()], "{res}");

    // Explicit cwd narrows to that workspace.
    let res = bridge
        .list_threads(json!({ "cwd": iso.cwd() }))
        .await
        .unwrap();
    assert_eq!(ids(&res), vec![project_thread.clone()], "{res}");
    let res = bridge
        .list_threads(json!({ "cwd": chat_cwd }))
        .await
        .unwrap();
    assert_eq!(ids(&res), vec![chat_thread.clone()], "{res}");

    let schema = tool_schema("list_threads");
    assert_eq!(schema["properties"]["query"]["type"], json!("string"));
    assert_eq!(schema["properties"]["limit"]["maximum"], json!(200));

    server.shutdown().await;
}

// ---------------------------------------------------------------------------------------------
// create_thread
// ---------------------------------------------------------------------------------------------

/// TS `createThread` requires a prompt, starts it as the new thread's first turn and returns
/// `queued: true`.
#[tokio::test]
async fn create_thread_queues_the_initial_prompt() {
    let mut iso = Iso::new("cowork-thread-tools-create-");
    let mock = start_mock(&mut iso).await;
    let server = start_server(iso.options()).await.unwrap();
    let bridge = bridge(&server);

    let schema = tool_schema("create_thread");
    let required: Vec<&str> = schema["required"]
        .as_array()
        .unwrap_or_else(|| panic!("create_thread schema has no required list: {schema}"))
        .iter()
        .filter_map(Value::as_str)
        .collect();
    assert!(required.contains(&"prompt"), "{schema}");
    assert_eq!(schema["properties"]["prompt"]["type"], json!("string"));

    let err = bridge
        .create_thread(json!({ "model": "gpt-5.4" }))
        .await
        .unwrap_err();
    assert!(err.contains("prompt"), "{err}");
    let err = bridge
        .create_thread(json!({ "prompt": "   ", "model": "gpt-5.4" }))
        .await
        .unwrap_err();
    assert!(err.contains("prompt"), "{err}");

    let res = bridge
        .create_thread(json!({
            "prompt": "  delegated work  ",
            "title": "Delegated",
            "model": "gpt-5.4"
        }))
        .await
        .unwrap();
    assert_eq!(res["queued"], json!(true), "{res}");
    let thread_id = res["thread"]["id"].as_str().unwrap().to_owned();
    assert_eq!(res["thread"]["title"], json!("Delegated"), "{res}");

    // The queued turn runs through the normal turn path: the prompt reaches the model and
    // the transcript records both sides.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let read = loop {
        let read = bridge
            .read_thread(json!({ "threadId": thread_id }))
            .await
            .unwrap();
        let done = read["turns"].as_array().is_some_and(|turns| {
            turns.iter().any(|turn| {
                turn["status"] == json!("completed")
                    && turn["items"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|item| item["type"] == json!("assistant"))
            })
        });
        if done {
            break read;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "turn never completed: {read}"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    let items = &read["turns"][0]["items"];
    assert_eq!(
        items[0],
        json!({ "type": "user", "text": "delegated work" }),
        "{read}"
    );
    assert!(
        items
            .as_array()
            .unwrap()
            .contains(&json!({ "type": "assistant", "text": "Done." })),
        "{read}"
    );
    let bodies = mock.bodies.lock().unwrap().clone();
    assert!(
        bodies
            .iter()
            .any(|body| body.to_string().contains("delegated work")),
        "prompt never reached the model: {bodies:?}"
    );

    server.shutdown().await;
}

// ---------------------------------------------------------------------------------------------
// read_thread
// ---------------------------------------------------------------------------------------------

async fn journal(server: &ServerHandle, thread_id: &str, events: Vec<(&str, String, Value)>) {
    let runtime = server.runtime();
    for (event_type, turn_id, payload) in events {
        let item_id = payload
            .pointer("/item/id")
            .and_then(Value::as_str)
            .map(str::to_owned);
        runtime
            .journal
            .enqueue(cowork_storage::ThreadJournalEventInput {
                thread_id: thread_id.to_owned(),
                ts: "2026-07-01T00:00:01.000Z".to_owned(),
                event_type: event_type.to_owned(),
                turn_id: Some(turn_id),
                item_id,
                request_id: None,
                payload,
            })
            .await
            .unwrap();
    }
    runtime.journal.wait_for_idle(thread_id).await;
}

/// Journals `count` completed turns; each has a user message, and the last also has an
/// assistant reply and a tool call with a long result.
async fn journal_turns(server: &ServerHandle, thread_id: &str, count: usize, tool_output: &str) {
    let mut events = Vec::new();
    for n in 1..=count {
        let turn = format!("turn-{n}");
        events.push((
            "turn/started",
            turn.clone(),
            json!({ "threadId": thread_id, "turn": { "id": turn, "status": "inProgress" } }),
        ));
        events.push((
            "item/completed",
            turn.clone(),
            json!({
                "threadId": thread_id,
                "turnId": turn,
                "item": {
                    "id": format!("user-{n}"),
                    "type": "userMessage",
                    "content": [{ "type": "text", "text": format!("message {n}") }]
                }
            }),
        ));
        if n == count {
            events.push((
                "item/completed",
                turn.clone(),
                json!({
                    "threadId": thread_id,
                    "turnId": turn,
                    "item": {
                        "id": "tool-1",
                        "type": "toolCall",
                        "toolName": "bash",
                        "state": "output-available",
                        "args": { "command": "ls" },
                        "result": tool_output
                    }
                }),
            ));
            events.push((
                "item/completed",
                turn.clone(),
                json!({
                    "threadId": thread_id,
                    "turnId": turn,
                    "item": { "id": "agent-1", "type": "agentMessage", "text": "all done" }
                }),
            ));
        }
        events.push((
            "turn/completed",
            turn.clone(),
            json!({ "threadId": thread_id, "turn": { "id": turn, "status": "completed" } }),
        ));
    }
    journal(server, thread_id, events).await;
}

fn turn_ids(res: &Value) -> Vec<String> {
    res["turns"]
        .as_array()
        .unwrap_or_else(|| panic!("turns missing: {res}"))
        .iter()
        .map(|t| t["id"].as_str().unwrap().to_owned())
        .collect()
}

/// TS `readThread`: compact items, `turnLimit` (default 10, max 50) pages from the end,
/// `nextCursor` walks backwards, tool outputs only with `includeOutputs` (truncated at
/// `maxOutputCharsPerItem`, default 2000), and no hydration snapshot.
#[tokio::test]
async fn read_thread_returns_compact_paginated_turns() {
    let iso = Iso::new("cowork-thread-tools-read-");
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let bridge = bridge(&server);
    let thread_id = start_thread(&mut ws, &iso.cwd(), "start-read").await;
    let long_output = "x".repeat(2_500);
    journal_turns(&server, &thread_id, 12, &long_output).await;

    let page = bridge
        .read_thread(json!({ "threadId": thread_id }))
        .await
        .unwrap();
    assert!(page.get("coworkSnapshot").is_none(), "{page}");
    assert!(page["thread"].get("turns").is_none(), "{page}");
    assert_eq!(page["thread"]["id"], json!(thread_id), "{page}");
    let expected: Vec<String> = (3..=12).map(|n| format!("turn-{n}")).collect();
    assert_eq!(turn_ids(&page), expected, "{page}");
    assert_eq!(
        page["turns"][0],
        json!({
            "id": "turn-3",
            "status": "completed",
            "items": [{ "type": "user", "text": "message 3" }]
        }),
        "{page}"
    );
    assert_eq!(
        page["turns"][9]["items"],
        json!([
            { "type": "user", "text": "message 12" },
            { "type": "tool", "toolName": "bash", "state": "output-available", "args": { "command": "ls" } },
            { "type": "assistant", "text": "all done" }
        ]),
        "{page}"
    );
    let cursor = page["nextCursor"]
        .as_str()
        .unwrap_or_else(|| panic!("nextCursor missing: {page}"))
        .to_owned();

    let older = bridge
        .read_thread(json!({ "threadId": thread_id, "cursor": cursor }))
        .await
        .unwrap();
    assert_eq!(
        turn_ids(&older),
        vec!["turn-1".to_owned(), "turn-2".to_owned()],
        "{older}"
    );
    assert!(older.get("nextCursor").is_none(), "{older}");

    let last = bridge
        .read_thread(json!({ "threadId": thread_id, "turnLimit": 1, "includeOutputs": true }))
        .await
        .unwrap();
    assert_eq!(turn_ids(&last), vec!["turn-12".to_owned()], "{last}");
    let tool = &last["turns"][0]["items"][1];
    assert_eq!(
        tool["output"],
        json!(format!("{}…", "x".repeat(2_000))),
        "{last}"
    );
    assert_eq!(tool["outputTruncated"], json!(true), "{last}");
    assert!(last["nextCursor"].is_string(), "{last}");

    let short = bridge
        .read_thread(json!({
            "threadId": thread_id,
            "turnLimit": 1,
            "includeOutputs": true,
            "maxOutputCharsPerItem": 5
        }))
        .await
        .unwrap();
    assert_eq!(short["turns"][0]["items"][1]["output"], json!("xxxxx…"));

    let err = bridge
        .read_thread(json!({ "threadId": thread_id, "cursor": "not-a-cursor" }))
        .await
        .unwrap_err();
    assert_eq!(err, "Invalid thread cursor");

    let schema = tool_schema("read_thread");
    for key in [
        "cursor",
        "turnLimit",
        "includeOutputs",
        "maxOutputCharsPerItem",
    ] {
        assert!(
            schema["properties"].get(key).is_some(),
            "read_thread schema lacks {key}: {schema}"
        );
    }
    assert_eq!(schema["properties"]["turnLimit"]["maximum"], json!(50));
    assert_eq!(
        schema["properties"]["maxOutputCharsPerItem"]["maximum"],
        json!(20_000)
    );

    server.shutdown().await;
}
