//! Regression coverage for `cowork/session/defaults/apply` persisting the full supported config
//! patch (including `clear*` sentinels), `cowork/session/config/set` persisting accepted settings
//! across a restart, `cowork/session/usageBudget/set` clearing a cap with an
//! explicit `null` and returning the real usage snapshot, and `turn/start` waiting for managed
//! runtime startup before snapshotting the tool environment.

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
                "usage": { "input_tokens": 1000, "output_tokens": 500 }
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
                "clientInfo": { "name": "defaults-budget-startup-tests", "version": "1.0.0" },
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

async fn send(ws: &mut WsStream, id: &str, method: &str, params: Value) {
    ws.send(WsMessage::Text(
        json!({ "id": id, "method": method, "params": params })
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
}

/// Reads frames until the response for `id` arrives or `wait` elapses.
async fn recv_response(
    ws: &mut WsStream,
    id: &str,
    notifs: &mut Vec<Value>,
    wait: Duration,
) -> Option<Value> {
    let deadline = tokio::time::Instant::now() + wait;
    loop {
        let rem = deadline.saturating_duration_since(tokio::time::Instant::now());
        let Ok(frame) = tokio::time::timeout(rem, ws.next()).await else {
            return None;
        };
        if let WsMessage::Text(txt) = frame.expect("ws open").expect("ws frame") {
            let val: Value = serde_json::from_str(&txt).unwrap();
            if val.get("id") == Some(&json!(id)) && val.get("method").is_none() {
                return Some(val);
            }
            if val.get("method").is_some() {
                notifs.push(val);
            }
        }
    }
}

async fn call(
    ws: &mut WsStream,
    id: &str,
    method: &str,
    params: Value,
    notifs: &mut Vec<Value>,
) -> Value {
    send(ws, id, method, params).await;
    recv_response(ws, id, notifs, Duration::from_secs(20))
        .await
        .unwrap_or_else(|| panic!("timed out waiting for {method} response"))
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

/// Main-model turn requests (excludes the background title-generation call).
fn turn_requests(mock: &MockState) -> usize {
    mock.bodies
        .lock()
        .unwrap()
        .iter()
        .filter(|b| b["model"] == "gpt-5.4")
        .count()
}

fn read_json(path: &Path) -> Value {
    serde_json::from_str(&fs::read_to_string(path).unwrap_or_else(|e| {
        panic!("read {}: {e}", path.display());
    }))
    .unwrap()
}

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

/// Desktop `workspaceDefaults.ts` fields beyond the original subset (memory model, overflow,
/// child routing mode, workflow concurrency, user identity) and their `clear*` sentinels must be
/// persisted, not just acknowledged.
#[tokio::test]
async fn defaults_apply_persists_full_patch_and_clear_sentinels() {
    let iso = Iso::new("cowork-defaults-apply-");
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let cwd = iso.workspace.to_string_lossy().into_owned();
    let thread_id = start_thread(&mut ws, &cwd).await;
    let project_cfg = iso.workspace.join(".cowork").join("config.json");
    let global_cfg = iso.home.join(".cowork").join("config").join("config.json");
    let mut ignored = Vec::new();

    let applied = call(
        &mut ws,
        "apply-1",
        "cowork/session/defaults/apply",
        json!({
            "cwd": cwd,
            "threadId": thread_id,
            "config": {
                "memoryGenerationModel": " gpt-5.4-mini ",
                "toolOutputOverflowChars": 12345,
                "childModelRoutingMode": "cross-provider-allowlist",
                "workflowMaxConcurrentAgents": 7,
                "userName": "Ada",
                "userProfile": { "work": "Engineer" }
            }
        }),
        &mut ignored,
    )
    .await;
    assert!(applied.get("error").is_none(), "apply failed: {applied}");

    let project = read_json(&project_cfg);
    assert_eq!(project["toolOutputOverflowChars"], 12345, "{project}");
    assert_eq!(project["childModelRoutingMode"], "cross-provider-allowlist");
    assert_eq!(project["workflowMaxConcurrentAgents"], 7);
    assert_eq!(project["userName"], "Ada");
    assert_eq!(project["userProfile"]["work"], "Engineer");
    let global = read_json(&global_cfg);
    assert_eq!(global["memoryGenerationModel"], "gpt-5.4-mini", "{global}");

    // An explicit `null` overflow (disable truncation) persists as JSON null.
    let disabled = call(
        &mut ws,
        "apply-null",
        "cowork/session/defaults/apply",
        json!({ "cwd": cwd, "config": { "toolOutputOverflowChars": null } }),
        &mut ignored,
    )
    .await;
    assert!(disabled.get("error").is_none(), "apply failed: {disabled}");
    let project = read_json(&project_cfg);
    assert!(
        project
            .get("toolOutputOverflowChars")
            .is_some_and(Value::is_null),
        "{project}"
    );

    // Clear sentinels delete the persisted keys and drop the live overrides.
    let cleared = call(
        &mut ws,
        "apply-2",
        "cowork/session/defaults/apply",
        json!({
            "cwd": cwd,
            "threadId": thread_id,
            "config": {
                "clearMemoryGenerationModel": true,
                "clearToolOutputOverflowChars": true
            }
        }),
        &mut ignored,
    )
    .await;
    assert!(cleared.get("error").is_none(), "clear failed: {cleared}");
    let project = read_json(&project_cfg);
    assert!(
        project.get("toolOutputOverflowChars").is_none(),
        "{project}"
    );
    assert_eq!(project["workflowMaxConcurrentAgents"], 7);
    let global = read_json(&global_cfg);
    assert!(global.get("memoryGenerationModel").is_none(), "{global}");
    let config = &cleared["result"]["event"]["config"];
    assert!(config.get("memoryGenerationModel").is_none(), "{config}");
    assert!(
        config.get("clearMemoryGenerationModel").is_none(),
        "{config}"
    );
    let live = server.runtime().load_thread(&thread_id).unwrap();
    {
        let live = live.lock();
        assert!(!live.config_overrides.contains_key("memoryGenerationModel"));
        assert!(
            !live
                .config_overrides
                .contains_key("toolOutputOverflowChars")
        );
    }

    // A value combined with its own clear sentinel is rejected before anything is written.
    let conflict = call(
        &mut ws,
        "apply-3",
        "cowork/session/defaults/apply",
        json!({
            "cwd": cwd,
            "config": { "memoryGenerationModel": "x", "clearMemoryGenerationModel": true }
        }),
        &mut ignored,
    )
    .await;
    assert!(
        conflict.get("error").is_some(),
        "expected error: {conflict}"
    );
    assert!(
        read_json(&global_cfg)
            .get("memoryGenerationModel")
            .is_none()
    );

    server.shutdown().await;
}

/// `cowork/session/config/set` on a root session persists accepted settings the way
/// `SessionMetadataManager.applyPreparedConfigUpdate` did (`persistProjectConfigPatchImpl`):
/// workspace keys to `<workspace>/.cowork/config.json`, user-scoped memory keys to the user
/// config, and `yolo` nowhere. A restart (fresh hydration from `sessions.db`) must not undo them.
#[tokio::test]
async fn session_config_set_persists_settings_across_restart() {
    let iso = Iso::new("cowork-session-config-set-");
    let project_cfg = iso.workspace.join(".cowork").join("config.json");
    let global_cfg = iso.home.join(".cowork").join("config").join("config.json");
    let cwd = iso.workspace.to_string_lossy().into_owned();
    let mut ignored = Vec::new();

    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let thread_id = start_thread(&mut ws, &cwd).await;

    // A patch that leaves the effective config unchanged writes nothing (`changed: false`).
    let noop = call(
        &mut ws,
        "set-noop",
        "cowork/session/config/set",
        json!({ "threadId": thread_id, "config": { "enableMemory": true } }),
        &mut ignored,
    )
    .await;
    assert!(noop.get("error").is_none(), "{noop}");
    assert!(
        !project_cfg.exists(),
        "unchanged patch must not write config"
    );

    let set = call(
        &mut ws,
        "set-1",
        "cowork/session/config/set",
        json!({
            "threadId": thread_id,
            "config": {
                "enableMemory": false,
                "memoryRequireApproval": true,
                "toolOutputOverflowChars": 4321,
                "advancedMemory": true,
                "yolo": true
            }
        }),
        &mut ignored,
    )
    .await;
    assert!(set.get("error").is_none(), "{set}");
    let config = &set["result"]["event"]["config"];
    assert_eq!(config["enableMemory"], false, "{config}");
    assert_eq!(config["yolo"], true, "{config}");

    let project = read_json(&project_cfg);
    assert_eq!(project["enableMemory"], false, "{project}");
    assert_eq!(project["memoryRequireApproval"], true, "{project}");
    assert_eq!(project["toolOutputOverflowChars"], 4321, "{project}");
    assert!(project.get("advancedMemory").is_none(), "{project}");
    assert!(project.get("yolo").is_none(), "{project}");
    assert_eq!(read_json(&global_cfg)["advancedMemory"], true);

    // A clear sentinel deletes the persisted key and the live override.
    let cleared = call(
        &mut ws,
        "set-clear",
        "cowork/session/config/set",
        json!({ "threadId": thread_id, "config": { "clearToolOutputOverflowChars": true } }),
        &mut ignored,
    )
    .await;
    assert!(cleared.get("error").is_none(), "{cleared}");
    assert_eq!(
        cleared["result"]["event"]["config"]["toolOutputOverflowChars"],
        25000
    );
    let project = read_json(&project_cfg);
    assert!(
        project.get("toolOutputOverflowChars").is_none(),
        "{project}"
    );
    let set = call(
        &mut ws,
        "set-2",
        "cowork/session/config/set",
        json!({ "threadId": thread_id, "config": { "toolOutputOverflowChars": 999 } }),
        &mut ignored,
    )
    .await;
    assert!(set.get("error").is_none(), "{set}");

    drop(ws);
    server.shutdown().await;

    // Fresh server: the session hydrates from `sessions.db` with no in-memory overrides.
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let read = call(
        &mut ws,
        "read",
        "cowork/session/config/set",
        json!({ "threadId": thread_id, "config": {} }),
        &mut ignored,
    )
    .await;
    assert!(read.get("error").is_none(), "{read}");
    let config = &read["result"]["event"]["config"];
    assert_eq!(config["enableMemory"], false, "{config}");
    assert_eq!(config["memoryRequireApproval"], true, "{config}");
    assert_eq!(config["advancedMemory"], true, "{config}");
    assert_eq!(config["toolOutputOverflowChars"], 999, "{config}");
    // `yolo` is session state only (TS never persisted it).
    assert_eq!(config["yolo"], false, "{config}");

    server.shutdown().await;
}

/// `stopAtUsd: null` clears the hard cap (desktop `clearThreadUsageHardCap`), an omitted field
/// leaves it unchanged, and the result carries the real usage snapshot.
#[tokio::test]
async fn usage_budget_null_clears_cap_and_returns_real_usage() {
    let mut iso = Iso::new("cowork-usage-budget-");
    let mock = start_mock(&mut iso).await;
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let cwd = iso.workspace.to_string_lossy().into_owned();
    let thread_id = start_thread(&mut ws, &cwd).await;
    let mut ignored = Vec::new();

    run_turn(&mut ws, &thread_id, "first", "turn-1").await;
    assert_eq!(turn_requests(&mock), 1);

    let set = call(
        &mut ws,
        "budget-set",
        "cowork/session/usageBudget/set",
        json!({ "threadId": thread_id, "stopAtUsd": 0.0 }),
        &mut ignored,
    )
    .await;
    let usage = &set["result"]["event"]["usage"];
    assert_eq!(set["result"]["event"]["type"], "session_usage", "{set}");
    assert_eq!(usage["sessionId"], thread_id);
    assert_eq!(usage["totalTurns"], 1, "real snapshot expected: {usage}");
    assert_eq!(usage["totalTokens"], 1500);
    assert!(
        usage["estimatedTotalCostUsd"]
            .as_f64()
            .is_some_and(|c| c > 0.0),
        "{usage}"
    );
    assert_eq!(usage["budgetStatus"]["stopAtUsd"], 0.0);
    assert_eq!(usage["budgetStatus"]["stopTriggered"], true);

    // Omitted `stopAtUsd` leaves the cap in place.
    let warn_only = call(
        &mut ws,
        "budget-warn",
        "cowork/session/usageBudget/set",
        json!({ "threadId": thread_id, "warnAtUsd": null }),
        &mut ignored,
    )
    .await;
    assert_eq!(
        warn_only["result"]["event"]["usage"]["budgetStatus"]["stopAtUsd"], 0.0,
        "{warn_only}"
    );

    // Capped: the turn is blocked before any model request.
    let blocked = run_turn(&mut ws, &thread_id, "second", "turn-2").await;
    assert!(
        blocked
            .iter()
            .any(|n| n["method"] == "cowork/session/budgetExceeded"),
        "{blocked:?}"
    );
    assert_eq!(turn_requests(&mock), 1);

    // Explicit null clears the cap; turns run again.
    let clear = call(
        &mut ws,
        "budget-clear",
        "cowork/session/usageBudget/set",
        json!({ "threadId": thread_id, "stopAtUsd": null }),
        &mut ignored,
    )
    .await;
    let status = &clear["result"]["event"]["usage"]["budgetStatus"];
    assert!(status["stopAtUsd"].is_null(), "{clear}");
    assert_eq!(status["configured"], false);
    assert_eq!(
        server
            .runtime()
            .load_thread(&thread_id)
            .unwrap()
            .lock()
            .stop_at_usd,
        None
    );
    run_turn(&mut ws, &thread_id, "third", "turn-3").await;
    assert_eq!(turn_requests(&mock), 2);

    server.shutdown().await;
}

/// `turn/start` waits for managed-runtime bootstrap to settle (the turn snapshots the tool env
/// overlay that bootstrap installs), then proceeds with the host env when bootstrap fails.
#[tokio::test]
async fn turn_start_waits_for_runtime_startup_to_settle() {
    let mut iso = Iso::new("cowork-turn-startup-");
    let mock = start_mock(&mut iso).await;

    // Release server that holds every request until released, then answers 404 so bootstrap
    // settles with an error.
    let (release_tx, release_rx) = tokio::sync::watch::channel(false);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let release_server = tokio::spawn(async move {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        while let Ok((mut s, _)) = listener.accept().await {
            let mut rx = release_rx.clone();
            tokio::spawn(async move {
                let mut buf = [0_u8; 1024];
                let _ = s.read(&mut buf).await;
                let _ = rx.wait_for(|released| *released).await;
                let _ = s
                    .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\nConnection: close\r\n\r\nnot found")
                    .await;
            });
        }
    });
    iso.env.remove("COWORK_DISABLE_RUNTIME");
    iso.env
        .insert("COWORK_RUNTIME_ALLOW_NETWORK".into(), "1".into());
    iso.env
        .insert("COWORK_RUNTIME_BASE_URL".into(), format!("http://{addr}"));

    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let cwd = iso.workspace.to_string_lossy().into_owned();
    let thread_id = start_thread(&mut ws, &cwd).await;
    let snap = server.runtime().startup_snapshot();
    assert!(!snap.ready && snap.error.is_none(), "{snap:?}");

    let mut notifs = Vec::new();
    send(
        &mut ws,
        "turn-gated",
        "turn/start",
        json!({ "threadId": thread_id, "input": [{ "type": "text", "text": "hi" }] }),
    )
    .await;
    let early = recv_response(
        &mut ws,
        "turn-gated",
        &mut notifs,
        Duration::from_millis(800),
    )
    .await;
    assert!(
        early.is_none(),
        "turn/start must wait for startup: {early:?}"
    );
    assert!(mock.bodies.lock().unwrap().is_empty());

    release_tx.send(true).unwrap();
    let res = recv_response(&mut ws, "turn-gated", &mut notifs, Duration::from_secs(20))
        .await
        .expect("turn/start response after startup settles");
    assert!(res.get("error").is_none(), "turn/start failed: {res}");
    let snap = server.runtime().startup_snapshot();
    assert!(snap.error.is_some(), "{snap:?}");
    wait_for_method(&mut ws, &mut notifs, "turn/completed").await;
    assert_eq!(turn_requests(&mock), 1);

    server.shutdown().await;
    release_server.abort();
}
