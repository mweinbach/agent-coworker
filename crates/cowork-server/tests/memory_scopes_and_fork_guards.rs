//! `cowork/memory/{upsert,delete}` return every memory scope (`AgentSession.emitMemories()`
//! parity), and `thread/fork` / the `fork_thread` tool bridge apply `LocalThreadHost.forkThread`
//! guards (blank prompt, task lock, busy, non-root) and treat the initial-prompt kickoff as
//! fire-and-forget.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use cowork_harness::tasks::{
    TaskLockError, TaskLockErrorData, TaskLockKind, register_settling_terminal_session_lock,
};
use cowork_protocol::WEBSOCKET_SUBPROTOCOL;
use cowork_server::memory_and_fork_routes::ServerThreadControlBridge;
use cowork_server::{ServerHandle, ServerOptions, start_server};
use cowork_storage::{SessionKind, TaskStatus};
use cowork_tools::ThreadControlBridge;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tempfile::TempDir;
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

    fn cwd(&self) -> String {
        self.workspace.to_string_lossy().into_owned()
    }
}

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
                "clientInfo": { "name": "memory-fork-guard-tests", "version": "1.0.0" },
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

fn memory_ids(res: &Value) -> Vec<(String, String)> {
    let mut ids: Vec<(String, String)> = res["result"]["event"]["memories"]
        .as_array()
        .unwrap_or_else(|| panic!("memories missing: {res}"))
        .iter()
        .map(|m| {
            (
                m["scope"].as_str().unwrap().to_owned(),
                m["id"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    ids.sort();
    ids
}

fn pair(scope: &str, id: &str) -> (String, String) {
    (scope.to_owned(), id.to_owned())
}

fn root_thread_count(server: &ServerHandle) -> usize {
    server
        .runtime()
        .session_db
        .list_sessions(None)
        .unwrap()
        .len()
}

fn assert_invalid_params(res: &Value, message: &str) {
    assert_eq!(res["error"]["code"], json!(-32602), "{res}");
    assert_eq!(res["error"]["message"], json!(message), "{res}");
}

fn test_lock(task_id: &str) -> TaskLockError {
    TaskLockError {
        message: format!("Thread is locked by task {task_id}"),
        data: TaskLockErrorData {
            category: "task_locked".to_owned(),
            source: "session".to_owned(),
            lock_kind: TaskLockKind::TerminalTaskThread,
            task_id: task_id.to_owned(),
            task_status: TaskStatus::Completed,
            task_title: None,
        },
    }
}

#[tokio::test]
async fn memory_upsert_returns_every_scope() {
    let iso = Iso::new("cowork-mem-upsert-scopes-");
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let cwd = iso.cwd();
    let mut notifs = Vec::new();

    let user = call(
        &mut ws,
        "u1",
        "cowork/memory/upsert",
        json!({ "cwd": cwd, "scope": "user", "id": "user-pref", "content": "Prefers tabs." }),
        &mut notifs,
    )
    .await;
    assert_eq!(memory_ids(&user), vec![pair("user", "user-pref")]);

    let workspace = call(
        &mut ws,
        "w1",
        "cowork/memory/upsert",
        json!({ "cwd": cwd, "scope": "workspace", "id": "ws-note", "content": "Uses cargo." }),
        &mut notifs,
    )
    .await;
    assert_eq!(workspace["result"]["event"]["type"], json!("memory_list"));
    assert_eq!(
        memory_ids(&workspace),
        vec![pair("user", "user-pref"), pair("workspace", "ws-note")],
        "workspace upsert must keep the user scope in its result: {workspace}"
    );

    // Re-upserting the user entry still lists the workspace entry, in `list()` order.
    let again = call(
        &mut ws,
        "u2",
        "cowork/memory/upsert",
        json!({ "cwd": cwd, "scope": "user", "id": "user-pref", "content": "Prefers spaces." }),
        &mut notifs,
    )
    .await;
    assert_eq!(
        memory_ids(&again),
        vec![pair("user", "user-pref"), pair("workspace", "ws-note")]
    );
    let all = call(
        &mut ws,
        "l1",
        "cowork/memory/list",
        json!({ "cwd": cwd }),
        &mut notifs,
    )
    .await;
    assert_eq!(
        again["result"]["event"]["memories"], all["result"]["event"]["memories"],
        "upsert result must match the unscoped list (same ordering)"
    );
    server.shutdown().await;
}

#[tokio::test]
async fn memory_delete_returns_every_scope() {
    let iso = Iso::new("cowork-mem-delete-scopes-");
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let cwd = iso.cwd();
    let mut notifs = Vec::new();

    for (rid, scope, id) in [
        ("a", "user", "user-pref"),
        ("b", "workspace", "ws-keep"),
        ("c", "workspace", "ws-drop"),
    ] {
        let res = call(
            &mut ws,
            rid,
            "cowork/memory/upsert",
            json!({ "cwd": cwd, "scope": scope, "id": id, "content": format!("{id} body") }),
            &mut notifs,
        )
        .await;
        assert!(res.get("error").is_none(), "{res}");
    }

    let deleted = call(
        &mut ws,
        "d1",
        "cowork/memory/delete",
        json!({ "cwd": cwd, "scope": "workspace", "id": "ws-drop" }),
        &mut notifs,
    )
    .await;
    assert_eq!(deleted["result"]["event"]["deleted"], json!(true));
    assert_eq!(
        memory_ids(&deleted),
        vec![pair("user", "user-pref"), pair("workspace", "ws-keep")],
        "workspace delete must keep the user scope in its result: {deleted}"
    );

    let deleted_user = call(
        &mut ws,
        "d2",
        "cowork/memory/delete",
        json!({ "cwd": cwd, "scope": "user", "id": "user-pref" }),
        &mut notifs,
    )
    .await;
    assert_eq!(
        memory_ids(&deleted_user),
        vec![pair("workspace", "ws-keep")],
        "user delete must keep the workspace scope in its result: {deleted_user}"
    );
    server.shutdown().await;
}

#[tokio::test]
async fn fork_rejects_blank_prompt_without_creating_a_thread() {
    let iso = Iso::new("cowork-fork-blank-prompt-");
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let source = start_thread(&mut ws, &iso.cwd(), "openai", "gpt-5.4").await;
    let before = root_thread_count(&server);
    let mut notifs = Vec::new();

    let res = call(
        &mut ws,
        "f1",
        "thread/fork",
        json!({ "threadId": source, "prompt": "   \n\t " }),
        &mut notifs,
    )
    .await;
    assert_invalid_params(&res, "fork_thread prompt must be non-empty when provided");
    assert_eq!(root_thread_count(&server), before);
    assert!(!notifs.iter().any(|n| n["method"] == "thread/started"));
    server.shutdown().await;
}

#[tokio::test]
async fn fork_rejects_task_locked_threads_including_parent_locks() {
    let iso = Iso::new("cowork-fork-task-lock-");
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let cwd = iso.cwd();
    let locked = start_thread(&mut ws, &cwd, "openai", "gpt-5.4").await;
    let mut notifs = Vec::new();

    let lock = test_lock("task-fork-lock");
    let mut guard = register_settling_terminal_session_lock(&locked, lock.clone());
    let res = call(
        &mut ws,
        "f1",
        "thread/fork",
        json!({ "threadId": locked }),
        &mut notifs,
    )
    .await;
    assert_invalid_params(&res, &lock.message);

    // A thread whose (live) parent is locked inherits the lock, and the lock is reported
    // before the root-thread check.
    let child = start_thread(&mut ws, &cwd, "openai", "gpt-5.4").await;
    server
        .runtime()
        .get_live_thread(&child)
        .unwrap()
        .lock()
        .parent_session_id = Some(locked.clone());
    let res = call(
        &mut ws,
        "f2",
        "thread/fork",
        json!({ "threadId": child }),
        &mut notifs,
    )
    .await;
    assert_invalid_params(&res, &lock.message);

    guard.release();
    let res = call(
        &mut ws,
        "f3",
        "thread/fork",
        json!({ "threadId": locked }),
        &mut notifs,
    )
    .await;
    assert!(res.get("error").is_none(), "unlocked fork failed: {res}");
    server.shutdown().await;
}

#[tokio::test]
async fn fork_rejects_busy_threads() {
    let iso = Iso::new("cowork-fork-busy-");
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let source = start_thread(&mut ws, &iso.cwd(), "openai", "gpt-5.4").await;
    let before = root_thread_count(&server);
    let live = server.runtime().get_live_thread(&source).unwrap();
    live.lock().busy = true;
    let mut notifs = Vec::new();

    let res = call(
        &mut ws,
        "f1",
        "thread/fork",
        json!({ "threadId": source }),
        &mut notifs,
    )
    .await;
    assert_invalid_params(&res, "Cannot fork a thread while it is running");
    assert_eq!(root_thread_count(&server), before);

    live.lock().busy = false;
    let res = call(
        &mut ws,
        "f2",
        "thread/fork",
        json!({ "threadId": source }),
        &mut notifs,
    )
    .await;
    assert!(res.get("error").is_none(), "idle fork failed: {res}");
    server.shutdown().await;
}

#[tokio::test]
async fn fork_rejects_non_root_threads() {
    let iso = Iso::new("cowork-fork-non-root-");
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let cwd = iso.cwd();
    let mut notifs = Vec::new();

    let parent = start_thread(&mut ws, &cwd, "openai", "gpt-5.4").await;
    for label in ["kind", "parent", "role"] {
        let thread = start_thread(&mut ws, &cwd, "openai", "gpt-5.4").await;
        {
            let live = server.runtime().get_live_thread(&thread).unwrap();
            let mut live = live.lock();
            match label {
                "kind" => live.session_kind = SessionKind::Agent,
                "parent" => live.parent_session_id = Some(parent.clone()),
                _ => live.role = Some("worker".to_owned()),
            }
        }
        let res = call(
            &mut ws,
            &format!("f-{label}"),
            "thread/fork",
            json!({ "threadId": thread }),
            &mut notifs,
        )
        .await;
        assert_invalid_params(&res, "Only root threads can be forked");
    }
    server.shutdown().await;
}

#[tokio::test]
async fn fork_tool_bridge_applies_the_same_guards() {
    let iso = Iso::new("cowork-fork-bridge-guards-");
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let source = start_thread(&mut ws, &iso.cwd(), "openai", "gpt-5.4").await;
    let bridge = ServerThreadControlBridge {
        runtime: server.runtime().clone(),
        connection_id: "bridge-test".to_owned(),
    };

    let err = bridge
        .fork_thread(json!({ "threadId": source, "prompt": "  " }))
        .await
        .unwrap_err();
    assert_eq!(err, "fork_thread prompt must be non-empty when provided");

    let live = server.runtime().get_live_thread(&source).unwrap();
    live.lock().busy = true;
    let err = bridge
        .fork_thread(json!({ "threadId": source }))
        .await
        .unwrap_err();
    assert_eq!(err, "Cannot fork a thread while it is running");
    live.lock().busy = false;

    live.lock().role = Some("worker".to_owned());
    let err = bridge
        .fork_thread(json!({ "threadId": source }))
        .await
        .unwrap_err();
    assert_eq!(err, "Only root threads can be forked");
    server.shutdown().await;
}

/// The initial prompt is fire-and-forget (TS `void sendUserMessage(...).catch(...)`): a
/// kickoff that `turn/start` rejects (unreachable LM Studio) still returns the persisted fork.
#[tokio::test]
async fn fork_initial_prompt_failure_is_non_fatal() {
    let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let closed_port = closed.local_addr().unwrap().port();
    drop(closed);
    let mut iso = Iso::new("cowork-fork-kickoff-");
    iso.env.insert(
        "LM_STUDIO_BASE_URL".into(),
        format!("http://127.0.0.1:{closed_port}"),
    );
    let server = start_server(iso.options()).await.unwrap();
    let mut ws = connect(server.ws_url()).await;
    let source = start_thread(&mut ws, &iso.cwd(), "lmstudio", "local-model").await;

    // Sanity: `turn/start` on this provider is rejected up front.
    let mut notifs = Vec::new();
    let direct = call(
        &mut ws,
        "t0",
        "turn/start",
        json!({ "threadId": source, "input": "hello" }),
        &mut notifs,
    )
    .await;
    assert_eq!(
        direct["error"]["data"]["reason"],
        json!("lmstudio_unreachable")
    );

    let mut notifs = Vec::new();
    let res = call(
        &mut ws,
        "f1",
        "thread/fork",
        json!({ "threadId": source, "prompt": "  continue from here  " }),
        &mut notifs,
    )
    .await;
    assert!(
        res.get("error").is_none(),
        "fork must survive kickoff failure: {res}"
    );
    assert_eq!(res["result"]["forked"], json!(true));
    assert_eq!(res["result"]["queued"], json!(true));
    assert_eq!(res["result"]["sourceThreadId"], json!(source));
    let fork_id = res["result"]["thread"]["id"].as_str().unwrap().to_owned();
    assert_ne!(fork_id, source);
    assert!(
        notifs
            .iter()
            .any(|n| n["method"] == "thread/started"
                && n["params"]["thread"]["id"] == json!(fork_id)),
        "thread/started missing: {notifs:?}"
    );
    assert!(
        server
            .runtime()
            .session_db
            .get_session_record(&fork_id)
            .unwrap()
            .is_some(),
        "fork must stay persisted"
    );
    let live = server.runtime().get_live_thread(&fork_id).unwrap();
    assert!(
        !live.lock().busy,
        "failed kickoff must not leave the fork busy"
    );
    server.shutdown().await;
}
