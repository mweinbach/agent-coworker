//! Regression coverage for file-tool read roots under Cowork home: a child agent scoped with
//! `targetPaths` (and a root session) can read user skill and plugin files, but never the rest of
//! `~/.cowork` — user MCP config (`config/mcp-servers.json`, whose transport env/headers can hold
//! plaintext secrets), logs or sessions.

#![recursion_limit = "256"]

use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
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

const SKILL_MARKER: &str = "SKILL-REFERENCE-MARKER-31";
const PLUGIN_MARKER: &str = "PLUGIN-README-MARKER-32";
const MCP_SECRET_MARKER: &str = "MCP-SECRET-MARKER-33";
const LOG_MARKER: &str = "LOG-SECRET-MARKER-34";
const SESSION_MARKER: &str = "SESSION-SECRET-MARKER-35";

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

/// Seeded files under Cowork home: two that must stay readable, three that must not.
struct CoworkHomeFiles {
    skill_reference: PathBuf,
    plugin_readme: PathBuf,
    mcp_config: PathBuf,
    log_file: PathBuf,
    session_file: PathBuf,
}

fn seed_cowork_home(home: &Path) -> CoworkHomeFiles {
    let cowork = home.join(".cowork");
    let skill_dir = cowork.join("skills/demo-skill");
    fs::create_dir_all(skill_dir.join("references")).unwrap();
    fs::write(
        skill_dir.join("SKILL.md"),
        "---\nname: demo-skill\ndescription: Demo skill for scoped read-root coverage.\n---\n\n# Demo\n",
    )
    .unwrap();
    let skill_reference = skill_dir.join("references/guide.md");
    fs::write(&skill_reference, SKILL_MARKER).unwrap();

    let plugin_dir = cowork.join("plugins/demo-plugin");
    fs::create_dir_all(&plugin_dir).unwrap();
    let plugin_readme = plugin_dir.join("README.md");
    fs::write(&plugin_readme, PLUGIN_MARKER).unwrap();

    fs::create_dir_all(cowork.join("config")).unwrap();
    let mcp_config = cowork.join("config/mcp-servers.json");
    fs::write(
        &mcp_config,
        json!({ "servers": [], "note": MCP_SECRET_MARKER }).to_string(),
    )
    .unwrap();

    fs::create_dir_all(cowork.join("logs")).unwrap();
    let log_file = cowork.join("logs/server.log");
    fs::write(&log_file, LOG_MARKER).unwrap();

    fs::create_dir_all(cowork.join("sessions")).unwrap();
    let session_file = cowork.join("sessions/old-session.json");
    fs::write(&session_file, SESSION_MARKER).unwrap();

    CoworkHomeFiles {
        skill_reference,
        plugin_readme,
        mcp_config,
        log_file,
        session_file,
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

/// Queues one `read` tool call per path, one `grep` over all of Cowork home, then a final text
/// reply.
fn queue_reads(mock: &MockState, home: &Path, paths: &[&Path]) {
    let mut replies = mock.replies.lock().unwrap();
    for (i, path) in paths.iter().enumerate() {
        replies.push_back(tool_call_sse(
            &format!("resp_read_{i}"),
            &format!("call_read_{i}"),
            "read",
            json!({ "filePath": path.to_string_lossy() }),
        ));
    }
    replies.push_back(tool_call_sse(
        "resp_grep",
        "call_grep",
        "grep",
        json!({
            "pattern": "SECRET-MARKER",
            "path": home.join(".cowork").to_string_lossy(),
        }),
    ));
    replies.push_back(text_sse("resp_done", "Done."));
}

/// The `function_call_output` text the model received for `call_id`.
fn tool_output(bodies: &[Value], call_id: &str) -> String {
    bodies
        .iter()
        .rev()
        .filter_map(|b| b["input"].as_array())
        .flatten()
        .find(|item| item["type"] == "function_call_output" && item["call_id"] == call_id)
        .map(|item| item["output"].to_string())
        .unwrap_or_else(|| panic!("no function_call_output for {call_id}"))
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
                "clientInfo": { "name": "scoped-child-read-roots-tests", "version": "1.0.0" },
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
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
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

async fn run_turn(ws: &mut WsStream, thread_id: &str, text: &str, id: &str) {
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

/// A persisted `worker` child agent of `parent` scoped to `target_paths`.
fn scoped_child_snapshot(
    session_id: &str,
    parent: &str,
    cwd: &str,
    target_paths: &[&str],
) -> cowork_storage::PersistedSessionMutation {
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    serde_json::from_value(json!({
        "sessionId": session_id,
        "eventType": "thread/started",
        "eventTs": now,
        "direction": null,
        "payload": null,
        "snapshot": {
            "sessionKind": "agent",
            "parentSessionId": parent,
            "role": "worker",
            "mode": null,
            "depth": 1,
            "nickname": null,
            "taskType": null,
            "targetPaths": target_paths,
            "profile": null,
            "requestedModel": null,
            "effectiveModel": null,
            "requestedReasoningEffort": null,
            "effectiveReasoningEffort": null,
            "executionState": null,
            "lastMessagePreview": null,
            "title": "Scoped child",
            "titleSource": "manual",
            "titleModel": null,
            "provider": "openai",
            "model": "gpt-5.4",
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
            "providerState": null,
            "todos": [],
            "harnessContext": null,
            "costTracker": null
        }
    }))
    .expect("valid persisted session mutation")
}

/// Asserts the skill/plugin reads succeeded and every MCP-config/log/session read (and the grep
/// over Cowork home) was denied without leaking file contents.
fn assert_cowork_home_reads(bodies: &[Value]) {
    let all = Value::Array(bodies.to_vec()).to_string();
    for marker in [MCP_SECRET_MARKER, LOG_MARKER, SESSION_MARKER] {
        assert!(
            !all.contains(marker),
            "secret Cowork-home content {marker} reached the model"
        );
    }
    let skill = tool_output(bodies, "call_read_0");
    assert!(
        skill.contains(SKILL_MARKER),
        "skill read must succeed: {skill}"
    );
    let plugin = tool_output(bodies, "call_read_1");
    assert!(
        plugin.contains(PLUGIN_MARKER),
        "plugin read must succeed: {plugin}"
    );
    for call_id in ["call_read_2", "call_read_3", "call_read_4", "call_grep"] {
        let out = tool_output(bodies, call_id);
        assert!(
            out.contains("blocked") || out.contains("outside"),
            "{call_id} must be denied: {out}"
        );
    }
}

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

/// A child agent scoped with `targetPaths` keeps `read`, but Cowork home is limited to the user
/// skills and plugins directories: MCP config, logs and sessions are denied.
#[tokio::test]
async fn scoped_child_reads_skills_but_not_cowork_config_logs_or_sessions() {
    let mut iso = Iso::new("cowork-scoped-child-roots-");
    let files = seed_cowork_home(&iso.home);
    fs::create_dir_all(iso.workspace.join("src")).unwrap();
    let mock = start_mock(&mut iso).await;
    queue_reads(
        &mock,
        &iso.home,
        &[
            &files.skill_reference,
            &files.plugin_readme,
            &files.mcp_config,
            &files.log_file,
            &files.session_file,
        ],
    );

    let server = start_server(iso.options()).await.unwrap();
    let cwd = iso.workspace.to_string_lossy().into_owned();
    let mut ws = connect(server.ws_url()).await;
    let parent = start_thread(&mut ws, &cwd).await;
    server
        .runtime()
        .session_db
        .persist_session_mutation(scoped_child_snapshot(
            "child-scoped",
            &parent,
            &cwd,
            &["src"],
        ))
        .await
        .unwrap();

    run_turn(&mut ws, "child-scoped", "read the files", "child-turn").await;

    let bodies = mock.bodies.lock().unwrap().clone();
    assert!(
        bodies.len() >= 7,
        "expected 7 tool-loop model requests, got {}",
        bodies.len()
    );
    assert_cowork_home_reads(&bodies);
    // TS `createReadPathChecker` order: the lexical read-root check runs before the
    // `targetPaths` guard, so Cowork-home state outside the skills/plugins allowlist is refused
    // as outside the read roots (a path inside the read roots but outside `targetPaths` would
    // get the `targetPaths` denial instead).
    for call_id in ["call_read_2", "call_read_3", "call_read_4"] {
        let out = tool_output(&bodies, call_id);
        assert!(
            out.contains("outside configured readRoots"),
            "{call_id}: {out}"
        );
    }
}

/// Root sessions get the same Cowork-home allowlist: skills and plugins stay readable, the rest
/// of Cowork home does not.
#[tokio::test]
async fn root_session_reads_skills_but_not_cowork_config_logs_or_sessions() {
    let mut iso = Iso::new("cowork-root-roots-");
    let files = seed_cowork_home(&iso.home);
    let mock = start_mock(&mut iso).await;
    queue_reads(
        &mock,
        &iso.home,
        &[
            &files.skill_reference,
            &files.plugin_readme,
            &files.mcp_config,
            &files.log_file,
            &files.session_file,
        ],
    );

    let server = start_server(iso.options()).await.unwrap();
    let cwd = iso.workspace.to_string_lossy().into_owned();
    let mut ws = connect(server.ws_url()).await;
    let thread_id = start_thread(&mut ws, &cwd).await;
    run_turn(&mut ws, &thread_id, "read the files", "root-turn").await;

    let bodies = mock.bodies.lock().unwrap().clone();
    assert!(
        bodies.len() >= 7,
        "expected 7 tool-loop model requests, got {}",
        bodies.len()
    );
    assert_cowork_home_reads(&bodies);
}
