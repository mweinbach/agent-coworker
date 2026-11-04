//! Regression tests for `cowork/session/delete`:
//! - deletion is workspace-scoped: a `cwd` in another workspace cannot delete a live or
//!   persisted session (SessionRegistry.ts `deleteSessionImpl` parity), and the target survives;
//! - deleting an idle parent with a running child agent awaits the child's settlement, so the
//!   child's late final persist cannot recreate it as an orphan row;
//! - `SessionDb` drops late persists for a deleted tree if a settlement wait times out.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::http::{Response, StatusCode, header};
use axum::routing::post;
use cowork_config::ProviderName;
use cowork_protocol::WEBSOCKET_SUBPROTOCOL;
use cowork_server::{ServerOptions, start_server};
use cowork_storage::{
    PersistedSessionMutation, PersistedSessionSnapshotData, SessionDb, SessionDbOptions,
    SessionKind, SessionPersistenceStatus, SessionTitleSource,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::net::TcpListener;
use tokio::sync::Notify;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

fn test_temp_base() -> PathBuf {
    if cfg!(target_os = "macos") {
        PathBuf::from("/private/tmp")
    } else {
        std::env::temp_dir()
    }
}

struct Iso {
    _root: TempDir,
    home: PathBuf,
    workspace: PathBuf,
    other_workspace: PathBuf,
}

impl Iso {
    fn new() -> Self {
        let root = tempfile::Builder::new()
            .prefix("cowork-session-delete-scope-")
            .tempdir_in(test_temp_base())
            .unwrap();
        let base = fs::canonicalize(root.path()).unwrap();
        let home = base.join("home");
        let workspace = base.join("workspace");
        let other_workspace = base.join("other-workspace");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&other_workspace).unwrap();
        Self {
            _root: root,
            home,
            workspace,
            other_workspace,
        }
    }

    fn db_path(&self) -> PathBuf {
        self.home.join(".cowork/sessions.db")
    }

    fn options(&self, llm_port: u16) -> ServerOptions {
        let base = self.home.parent().unwrap();
        let mut env = HashMap::new();
        env.insert("HOME".into(), self.home.to_string_lossy().into_owned());
        env.insert(
            "COWORK_HOME_OVERRIDE".into(),
            self.home.join(".cowork").to_string_lossy().into_owned(),
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
        env.insert(
            "PATH".into(),
            "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin".into(),
        );
        env.insert("TOGETHER_API_KEY".into(), "together-test-key".into());
        env.insert(
            "TOGETHER_BASE_URL".into(),
            format!("http://127.0.0.1:{llm_port}/v1"),
        );
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
            env,
        }
    }
}

/// Rows in `sessions` for `session_id`, plus rows whose parent is `session_id`.
fn session_rows(db_path: &Path, session_id: &str) -> (i64, i64) {
    let conn = rusqlite::Connection::open(db_path).unwrap();
    let own: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sessions WHERE session_id = ?1",
            [session_id],
            |r| r.get(0),
        )
        .unwrap();
    let children: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sessions WHERE parent_session_id = ?1",
            [session_id],
            |r| r.get(0),
        )
        .unwrap();
    (own, children)
}

async fn connect_ready_ws(ws_url: &str) -> WsStream {
    let mut req = ws_url.into_client_request().unwrap();
    req.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        WEBSOCKET_SUBPROTOCOL.parse().unwrap(),
    );
    let (mut ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();
    ws.send(WsMessage::Text(
        json!({
            "id": "init-1",
            "method": "initialize",
            "params": {
                "clientInfo": { "name": "session-delete-scope", "version": "1.0.0" },
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

async fn ws_call(ws: &mut WsStream, id: &str, method: &str, params: Value) -> Value {
    ws.send(WsMessage::Text(
        json!({ "id": id, "method": method, "params": params })
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(30), ws.next())
            .await
            .expect("ws_call timeout")
            .expect("ws open")
            .expect("ws frame ok");
        if let WsMessage::Text(txt) = frame {
            let val: Value = serde_json::from_str(&txt).unwrap();
            if val.get("id") == Some(&json!(id)) && val.get("method").is_none() {
                return val;
            }
        }
    }
}

async fn start_thread(ws: &mut WsStream, cwd: &Path) -> String {
    let th = ws_call(
        ws,
        "th-start",
        "thread/start",
        json!({
            "cwd": cwd.to_string_lossy(),
            "provider": "together",
            "model": "moonshotai/Kimi-K2.5"
        }),
    )
    .await;
    th["result"]["thread"]["id"]
        .as_str()
        .unwrap_or_else(|| panic!("thread/start: {th}"))
        .to_owned()
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

async fn spawn_child(ws: &mut WsStream, parent_id: &str, message: &str) -> String {
    let res = ws_call(
        ws,
        "spawn",
        "cowork/session/agent/spawn",
        json!({ "threadId": parent_id, "message": message }),
    )
    .await;
    assert_eq!(res["result"], json!({}), "spawn: {res}");
    for _ in 0..100 {
        if let Some(id) = list_child_ids(ws, parent_id).await.into_iter().next() {
            return id;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("child for {message} never appeared");
}

fn sse_text(text: &str) -> Response<Body> {
    let body = format!(
        concat!(
            "data: {{\"id\":\"cmpl-txt\",\"choices\":[{{\"index\":0,\"delta\":{{\"role\":\"assistant\",\"content\":{text:?}}}}}]}}\n\n",
            "data: {{\"id\":\"cmpl-txt\",\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"stop\"}}],\"usage\":{{\"prompt_tokens\":5,\"completion_tokens\":2,\"total_tokens\":7}}}}\n\n",
            "data: [DONE]\n\n"
        ),
        text = text,
    );
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .body(Body::from(body))
        .unwrap()
}

/// Mock chat-completions provider: requests mentioning `CHILD_HOLD` signal `held` and then
/// block until `release` fires; everything else answers immediately.
async fn mock_provider(held: Arc<Notify>, release: Arc<Notify>) -> u16 {
    let app = Router::new().route(
        "/v1/chat/completions",
        post(move |body: Bytes| {
            let held = Arc::clone(&held);
            let release = Arc::clone(&release);
            async move {
                if String::from_utf8_lossy(&body).contains("CHILD_HOLD") {
                    held.notify_one();
                    release.notified().await;
                    return sse_text("released");
                }
                sse_text("ok")
            }
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    port
}

async fn run_turn(ws: &mut WsStream, thread_id: &str, id: &str) {
    ws.send(WsMessage::Text(
        json!({
            "id": id,
            "method": "turn/start",
            "params": { "threadId": thread_id, "input": "hello" }
        })
        .to_string()
        .into(),
    ))
    .await
    .unwrap();
    let (mut responded, mut completed) = (false, false);
    while !(responded && completed) {
        let frame = tokio::time::timeout(Duration::from_secs(30), ws.next())
            .await
            .expect("turn timeout")
            .expect("ws open")
            .expect("ws frame ok");
        if let WsMessage::Text(txt) = frame {
            let val: Value = serde_json::from_str(&txt).unwrap();
            if val.get("id") == Some(&json!(id)) && val.get("method").is_none() {
                assert!(val.get("error").is_none(), "turn/start: {val}");
                responded = true;
            } else if val["method"] == "turn/completed" {
                completed = true;
            }
        }
    }
}

async fn delete(ws: &mut WsStream, id: &str, cwd: &Path, target: &str) -> Value {
    ws_call(
        ws,
        id,
        "cowork/session/delete",
        json!({ "cwd": cwd.to_string_lossy(), "targetSessionId": target }),
    )
    .await
}

fn assert_rejected_cross_workspace(res: &Value) {
    let message = res["error"]["message"].as_str().unwrap_or_default();
    // An unregistered `cwd` is refused by workspace authorization before the target check;
    // a registered-but-different workspace reaches the target-scope check.
    assert!(
        message.contains("Target session is outside the active workspace")
            || message.contains("cwd must match an authorized workspace"),
        "cross-workspace delete must be rejected: {res}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn session_delete_rejects_a_live_or_persisted_target_from_another_workspace() {
    let iso = Iso::new();
    let port = mock_provider(Arc::new(Notify::new()), Arc::new(Notify::new())).await;

    let server = start_server(iso.options(port)).await.unwrap();
    let mut ws = connect_ready_ws(server.ws_url()).await;
    let thread_id = start_thread(&mut ws, &iso.workspace).await;
    run_turn(&mut ws, &thread_id, "turn-1").await;
    assert_eq!(session_rows(&iso.db_path(), &thread_id).0, 1);

    // Live target: a request scoped to another workspace is rejected and nothing is removed.
    let res = delete(&mut ws, "del-live", &iso.other_workspace, &thread_id).await;
    assert_rejected_cross_workspace(&res);
    let read = ws_call(
        &mut ws,
        "read-live",
        "thread/read",
        json!({ "threadId": thread_id }),
    )
    .await;
    assert!(read.get("error").is_none(), "target must stay live: {read}");
    assert_eq!(session_rows(&iso.db_path(), &thread_id).0, 1);
    // The rejected delete left no tombstone: the thread still accepts a turn.
    run_turn(&mut ws, &thread_id, "turn-2").await;
    drop(ws);
    server.shutdown().await;

    // Persisted-only target (fresh server, nothing hydrated): still workspace-scoped.
    let server = start_server(iso.options(port)).await.unwrap();
    let mut ws = connect_ready_ws(server.ws_url()).await;
    assert!(server.runtime().get_live_thread(&thread_id).is_none());
    let res = delete(&mut ws, "del-persisted", &iso.other_workspace, &thread_id).await;
    assert_rejected_cross_workspace(&res);
    assert_eq!(session_rows(&iso.db_path(), &thread_id).0, 1);

    // The owning workspace can delete it.
    let res = delete(&mut ws, "del-owner", &iso.workspace, &thread_id).await;
    assert_eq!(res["result"]["event"]["type"], "session_deleted", "{res}");
    assert_eq!(session_rows(&iso.db_path(), &thread_id).0, 0);
    drop(ws);
    server.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn deleting_an_idle_parent_awaits_its_running_child_and_leaves_no_orphan() {
    let iso = Iso::new();
    let held = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let port = mock_provider(Arc::clone(&held), Arc::clone(&release)).await;

    let server = start_server(iso.options(port)).await.unwrap();
    let mut ws = connect_ready_ws(server.ws_url()).await;
    let parent_id = start_thread(&mut ws, &iso.workspace).await;

    let child_in_flight = held.notified();
    let child_id = spawn_child(&mut ws, &parent_id, "CHILD_HOLD: wait for release").await;
    tokio::time::timeout(Duration::from_secs(15), child_in_flight)
        .await
        .expect("child turn reached the provider");
    assert_eq!(
        session_rows(&iso.db_path(), &child_id).0,
        1,
        "child row exists before delete"
    );

    let res = delete(&mut ws, "del-parent", &iso.workspace, &parent_id).await;
    assert_eq!(res["result"]["event"]["type"], "session_deleted", "{res}");

    // Unblock anything still waiting on the provider and give late writers time to land.
    release.notify_waiters();
    tokio::time::sleep(Duration::from_millis(1500)).await;

    assert_eq!(
        session_rows(&iso.db_path(), &parent_id),
        (0, 0),
        "parent row and child rows must be gone"
    );
    assert_eq!(
        session_rows(&iso.db_path(), &child_id).0,
        0,
        "deleted child agent was recreated as an orphan row"
    );
    let read = ws_call(
        &mut ws,
        "read-child",
        "thread/read",
        json!({ "threadId": child_id }),
    )
    .await;
    assert!(read.get("error").is_some(), "child resurrected: {read}");
    drop(ws);
    server.shutdown().await;
}

fn mutation(session_id: &str, parent: Option<&str>, workspace: &str) -> PersistedSessionMutation {
    let now = "2026-11-02T12:00:00.000Z".to_owned();
    PersistedSessionMutation {
        session_id: session_id.to_owned(),
        event_type: "agent_status".to_owned(),
        event_ts: Some(now.clone()),
        direction: Some("system".to_owned()),
        payload: Some(json!({})),
        snapshot: PersistedSessionSnapshotData {
            session_kind: if parent.is_some() {
                SessionKind::Agent
            } else {
                SessionKind::Root
            },
            parent_session_id: parent.map(str::to_owned),
            role: None,
            mode: None,
            depth: parent.map(|_| 1),
            nickname: None,
            task_type: None,
            target_paths: None,
            profile: None,
            requested_model: None,
            effective_model: None,
            requested_reasoning_effort: None,
            effective_reasoning_effort: None,
            execution_state: None,
            last_message_preview: None,
            title: format!("Session {session_id}"),
            title_source: SessionTitleSource::Default,
            title_model: None,
            provider: ProviderName::Together,
            model: "moonshotai/Kimi-K2.5".to_owned(),
            working_directory: workspace.to_owned(),
            output_directory: None,
            uploads_directory: None,
            provider_options: None,
            sandbox: None,
            enable_mcp: false,
            backups_enabled_override: None,
            created_at: now.clone(),
            updated_at: now,
            status: SessionPersistenceStatus::Active,
            has_pending_ask: false,
            has_pending_approval: false,
            system_prompt: String::new(),
            messages: vec![],
            last_memory_generated_index: None,
            provider_state: None,
            todos: vec![],
            harness_context: None,
            cost_tracker: None,
        },
    }
}

/// Backstop for a settlement wait that times out: once `delete_session` removed a tree, a late
/// persist for a deleted id, or for a new child of one, must not recreate rows.
#[tokio::test]
async fn session_db_drops_late_persists_for_a_deleted_session_tree() {
    let iso = Iso::new();
    let root_dir = iso.home.join(".cowork");
    let db = SessionDb::open(SessionDbOptions {
        root_dir: root_dir.clone(),
        db_path: None,
        sessions_dir: root_dir.join("sessions"),
        busy_timeout_ms: Some(5_000),
    })
    .await
    .unwrap();
    let ws = iso.workspace.to_string_lossy().into_owned();
    db.persist_session_mutation(mutation("parent", None, &ws))
        .await
        .unwrap();
    db.persist_session_mutation(mutation("child", Some("parent"), &ws))
        .await
        .unwrap();
    assert_eq!(
        db.list_session_tree_ids("parent").unwrap(),
        vec!["child".to_owned()]
    );

    db.delete_session("parent").await.unwrap();
    db.persist_session_mutation(mutation("child", Some("parent"), &ws))
        .await
        .unwrap();
    db.persist_session_mutation(mutation("parent", None, &ws))
        .await
        .unwrap();
    db.persist_session_mutation(mutation("late-child", Some("parent"), &ws))
        .await
        .unwrap();
    for id in ["parent", "child", "late-child"] {
        assert!(
            db.get_session_record(id).unwrap().is_none(),
            "{id} was recreated after delete"
        );
    }

    // Unrelated sessions still persist normally.
    db.persist_session_mutation(mutation("other", None, &ws))
        .await
        .unwrap();
    assert!(db.get_session_record("other").unwrap().is_some());
}
