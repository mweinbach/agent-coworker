//! `cowork/workspace/fileChanged` producers: the workspace watcher
//! (`src/server/runtime/WorkspaceFileChangeMonitor.ts`) and the `/cowork/fs/rename` and
//! `/cowork/fs/trash` routes (`src/server/webDesktopRoutes.ts`).
//!
//! Watcher tests use generous deadlines and re-arm windows: FSEvents (macOS) and
//! `ReadDirectoryChangesW` (Windows) deliver asynchronously and CI machines are slow.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use cowork_server::http_fs::{handle_fs_rename_with_listener, handle_fs_trash_with_listener};
use cowork_server::workspace_file_monitor::{
    WorkspaceFileChangeEvent, WorkspaceFileChangeKind, WorkspaceFileChangeMonitor,
};
use cowork_server::{ServerOptions, start_server};
use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::protocol::Message as WsMessage;

const WATCH_DEADLINE: Duration = Duration::from_secs(15);

fn canonical_tempdir() -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().expect("tempdir");
    let root = std::fs::canonicalize(tmp.path()).expect("canonical tempdir");
    (tmp, root)
}

type Events = Arc<Mutex<Vec<WorkspaceFileChangeEvent>>>;

fn start_monitor(root: &Path, debounce: Duration) -> (WorkspaceFileChangeMonitor, Events) {
    let events: Events = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&events);
    let monitor = WorkspaceFileChangeMonitor::start(root, debounce, move |event| {
        sink.lock().push(event);
    })
    .expect("start workspace monitor");
    assert!(
        monitor.wait_until_ready(WATCH_DEADLINE),
        "monitor never armed"
    );
    // Let backends that deliver asynchronously (FSEvents) flush anything from before arming.
    std::thread::sleep(Duration::from_millis(300));
    events.lock().clear();
    (monitor, events)
}

/// Runs `mutate` until an event matching `predicate` arrives. `mutate` is retried every 2s in
/// case the first mutation raced the native subscription.
fn wait_for_event(
    events: &Events,
    mut mutate: impl FnMut(),
    predicate: impl Fn(&WorkspaceFileChangeEvent) -> bool,
) -> WorkspaceFileChangeEvent {
    let started = Instant::now();
    let mut last_mutation = Instant::now();
    mutate();
    while started.elapsed() < WATCH_DEADLINE {
        if let Some(event) = events.lock().iter().find(|e| predicate(e)) {
            return event.clone();
        }
        if last_mutation.elapsed() > Duration::from_secs(2) {
            mutate();
            last_mutation = Instant::now();
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!(
        "timed out waiting for a workspace file change event; saw {:?}",
        events.lock()
    );
}

fn is_changed(event: &WorkspaceFileChangeEvent, path: &Path, size: u64) -> bool {
    event.kind == WorkspaceFileChangeKind::Changed
        && event.path == path
        && event.version.as_ref().is_some_and(|v| v.size == size)
}

#[test]
fn monitor_debounces_a_burst_of_writes_into_one_changed_event() {
    let (_tmp, root) = canonical_tempdir();
    let file = root.join("external.md");
    std::fs::write(&file, "old").unwrap();
    let (monitor, events) = start_monitor(&root, Duration::from_millis(200));

    let event = wait_for_event(
        &events,
        || {
            std::fs::write(&file, "r").unwrap();
            std::fs::write(&file, "re").unwrap();
            std::fs::write(&file, "replacement").unwrap();
        },
        |e| is_changed(e, &file, "replacement".len() as u64),
    );
    let version = event.version.expect("changed events carry a version");
    let meta = std::fs::metadata(&file).unwrap();
    assert_eq!(
        version,
        cowork_harness::ooxml::file_change_version_from_metadata(&meta)
    );

    // Quiet period: no second event for the same path, and the parent (the workspace root) is
    // published alongside it.
    std::thread::sleep(Duration::from_millis(1_500));
    let seen = events.lock().clone();
    monitor.stop();
    let for_file: Vec<_> = seen.iter().filter(|e| e.path == file).collect();
    assert_eq!(for_file.len(), 1, "expected one debounced event: {seen:?}");
    assert!(
        seen.iter()
            .any(|e| e.path == root && e.kind == WorkspaceFileChangeKind::Changed),
        "parent directory should be published with the file: {seen:?}"
    );
}

#[test]
fn monitor_reports_deleted_files_with_null_version() {
    let (_tmp, root) = canonical_tempdir();
    let file = root.join("doomed.txt");
    std::fs::write(&file, "bye").unwrap();
    let (monitor, events) = start_monitor(&root, Duration::from_millis(25));

    let event = wait_for_event(
        &events,
        || {
            let _ = std::fs::remove_file(&file);
        },
        |e| e.path == file && e.kind == WorkspaceFileChangeKind::Deleted,
    );
    monitor.stop();
    assert_eq!(event.version, None);
}

#[test]
fn monitor_reports_files_in_nested_and_newly_created_directories() {
    let (_tmp, root) = canonical_tempdir();
    std::fs::create_dir_all(root.join("deck/slides")).unwrap();
    let (monitor, events) = start_monitor(&root, Duration::from_millis(25));

    let nested = root.join("deck/slides/one.xml");
    wait_for_event(
        &events,
        || std::fs::write(&nested, "<a/>").unwrap(),
        |e| is_changed(e, &nested, 4),
    );

    // A directory created after the monitor started is watched too (manual watch set on Linux).
    let fresh_dir = root.join("later");
    std::fs::create_dir(&fresh_dir).unwrap();
    wait_for_event(
        &events,
        || {},
        |e| e.path == fresh_dir && e.kind == WorkspaceFileChangeKind::Changed,
    );
    let fresh = fresh_dir.join("note.md");
    wait_for_event(
        &events,
        || std::fs::write(&fresh, "hello").unwrap(),
        |e| is_changed(e, &fresh, 5),
    );
    monitor.stop();
}

#[test]
fn monitor_ignores_cowork_git_and_node_modules_trees() {
    let (_tmp, root) = canonical_tempdir();
    let ignored = [".cowork", ".cowork-trash", ".git", "node_modules"];
    for dir in ignored {
        std::fs::create_dir_all(root.join(dir).join("nested")).unwrap();
    }
    let (monitor, events) = start_monitor(&root, Duration::from_millis(25));

    for dir in ignored {
        std::fs::write(root.join(dir).join("top.txt"), "x").unwrap();
        std::fs::write(root.join(dir).join("nested/deep.txt"), "x").unwrap();
        std::fs::create_dir(root.join(dir).join("fresh")).unwrap();
        std::fs::write(root.join(dir).join("fresh/new.txt"), "x").unwrap();
    }
    // Events are delivered in order, so once the sentinel arrives the ignored writes (made
    // before it) would have been reported too.
    let sentinel = root.join("sentinel.txt");
    wait_for_event(
        &events,
        || std::fs::write(&sentinel, "done").unwrap(),
        |e| is_changed(e, &sentinel, 4),
    );
    std::thread::sleep(Duration::from_millis(500));
    let seen = events.lock().clone();
    monitor.stop();

    let leaked: Vec<_> = seen
        .iter()
        .filter(|e| ignored.iter().any(|dir| e.path.starts_with(root.join(dir))))
        .collect();
    assert!(
        leaked.is_empty(),
        "ignored trees produced events: {leaked:?}"
    );
}

#[test]
fn stopped_monitor_reports_nothing() {
    let (_tmp, root) = canonical_tempdir();
    let (monitor, events) = start_monitor(&root, Duration::from_millis(25));
    monitor.stop();
    assert!(monitor.is_stopped());
    monitor.stop();

    std::fs::write(root.join("after-stop.txt"), "x").unwrap();
    std::thread::sleep(Duration::from_millis(500));
    assert!(events.lock().is_empty(), "{:?}", events.lock());
}

fn record() -> (
    Arc<Mutex<Vec<WorkspaceFileChangeEvent>>>,
    impl Fn(WorkspaceFileChangeEvent),
) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&events);
    (events, move |event| sink.lock().push(event))
}

#[test]
fn rename_route_reports_deleted_source_then_changed_destination() {
    let (_tmp, root) = canonical_tempdir();
    let src = root.join("draft.md");
    std::fs::write(&src, "draft body").unwrap();
    let (events, listener) = record();

    let body = serde_json::to_vec(&json!({ "path": src.to_string_lossy(), "newName": "final.md" }))
        .unwrap();
    let res = handle_fs_rename_with_listener(std::slice::from_ref(&root), &root, &body, &listener)
        .expect("rename succeeds");
    assert_eq!(res.status(), 204);

    let dst = root.join("final.md");
    let seen = events.lock().clone();
    assert_eq!(seen.len(), 2, "{seen:?}");
    assert_eq!(seen[0], WorkspaceFileChangeEvent::deleted(src));
    assert_eq!(seen[1].kind, WorkspaceFileChangeKind::Changed);
    assert_eq!(seen[1].path, dst);
    assert_eq!(
        seen[1].version,
        Some(cowork_harness::ooxml::read_file_change_version(&dst).unwrap())
    );
}

#[test]
fn rename_route_reports_only_deleted_for_directories_and_nothing_on_failure() {
    let (_tmp, root) = canonical_tempdir();
    let src = root.join("folder");
    std::fs::create_dir(&src).unwrap();
    std::fs::write(root.join("taken.md"), "x").unwrap();
    let (events, listener) = record();

    let body = serde_json::to_vec(&json!({ "path": src.to_string_lossy(), "newName": "renamed" }))
        .unwrap();
    handle_fs_rename_with_listener(std::slice::from_ref(&root), &root, &body, &listener)
        .expect("rename succeeds");
    // `readFileChangeVersion` rejects directories, so only the source invalidation is sent.
    assert_eq!(
        events.lock().clone(),
        vec![WorkspaceFileChangeEvent::deleted(src)]
    );

    events.lock().clear();
    let body = serde_json::to_vec(
        &json!({ "path": root.join("renamed").to_string_lossy(), "newName": "taken.md" }),
    )
    .unwrap();
    let err = handle_fs_rename_with_listener(std::slice::from_ref(&root), &root, &body, &listener)
        .expect_err("existing destination conflicts");
    assert_eq!(err.status, 409);
    assert!(events.lock().is_empty());
}

#[test]
fn trash_route_reports_deleted_path() {
    let (_tmp, root) = canonical_tempdir();
    let target = root.join("old.pptx");
    std::fs::write(&target, "pptx").unwrap();
    let (events, listener) = record();

    let body = serde_json::to_vec(&json!({ "path": target.to_string_lossy() })).unwrap();
    let res = handle_fs_trash_with_listener(std::slice::from_ref(&root), &root, &body, &listener)
        .expect("trash succeeds");
    assert_eq!(res.status(), 204);
    assert!(!target.exists());
    assert_eq!(
        events.lock().clone(),
        vec![WorkspaceFileChangeEvent::deleted(target)]
    );
}

// --- End to end through the server's WebSocket broadcast ------------------------------------

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

fn server_options(base: &Path, workspace: &Path) -> ServerOptions {
    let home = base.join("home");
    let userdata = base.join("userdata");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&userdata).unwrap();
    let mut env = HashMap::new();
    for key in ["HOME", "COWORK_HOME_OVERRIDE"] {
        env.insert(key.to_owned(), home.to_string_lossy().into_owned());
    }
    for key in [
        "COWORK_ELECTRON_USER_DATA_DIR",
        "COWORK_DESKTOP_USER_DATA_DIR",
    ] {
        env.insert(key.to_owned(), userdata.to_string_lossy().into_owned());
    }
    env.insert("COWORK_DISABLE_RUNTIME".into(), "1".into());
    env.insert("COWORK_RUNTIME_ALLOW_NETWORK".into(), "0".into());
    env.insert("LM_STUDIO_BASE_URL".into(), "http://127.0.0.1:9".into());
    ServerOptions {
        working_directory: workspace.to_path_buf(),
        host: "127.0.0.1".into(),
        port: 0,
        yolo: false,
        mobile_h3: false,
        mobile_h3_host: "127.0.0.1".into(),
        mobile_h3_port: 0,
        homedir: Some(home),
        built_in_dir: Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")),
        env,
    }
}

async fn recv_json(ws: &mut Ws, timeout: Duration) -> Option<Value> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let msg = tokio::time::timeout_at(deadline, ws.next())
            .await
            .ok()??
            .ok()?;
        if let WsMessage::Text(txt) = msg {
            return serde_json::from_str(&txt).ok();
        }
    }
}

async fn connect_initialized(ws_url: &str) -> Ws {
    let mut req = ws_url.into_client_request().unwrap();
    req.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        HeaderValue::from_static("cowork.jsonrpc.v1"),
    );
    let (mut ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();
    ws.send(WsMessage::Text(
        json!({
            "id": 1,
            "method": "initialize",
            "params": { "clientInfo": { "name": "file-change-test", "version": "0.1.0" } }
        })
        .to_string()
        .into(),
    ))
    .await
    .unwrap();
    loop {
        let frame = recv_json(&mut ws, Duration::from_secs(10))
            .await
            .expect("initialize response");
        if frame.get("id") == Some(&json!(1)) {
            assert!(frame.get("result").is_some(), "{frame}");
            break;
        }
    }
    ws.send(WsMessage::Text(
        json!({ "method": "initialized" }).to_string().into(),
    ))
    .await
    .unwrap();
    ws
}

/// Collects `fileChanged` notifications until one matches `predicate`, running `mutate` again
/// every 2s in case the first one raced the watcher.
async fn wait_for_file_changed(
    ws: &mut Ws,
    seen: &mut Vec<Value>,
    mut mutate: impl FnMut(),
    predicate: impl Fn(&Value) -> bool,
) -> Value {
    let started = Instant::now();
    mutate();
    while started.elapsed() < WATCH_DEADLINE {
        if let Some(found) = seen.iter().find(|p| predicate(p)) {
            return found.clone();
        }
        match recv_json(ws, Duration::from_secs(2)).await {
            Some(frame) if frame["method"] == "cowork/workspace/fileChanged" => {
                seen.push(frame["params"].clone());
            }
            Some(_) => {}
            None => mutate(),
        }
    }
    panic!("timed out waiting for cowork/workspace/fileChanged; saw {seen:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn server_broadcasts_watcher_and_fs_route_file_changes() {
    let (_tmp, base) = canonical_tempdir();
    let workspace = base.join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let handle = start_server(server_options(&base, &workspace))
        .await
        .unwrap();
    let monitor = handle
        .workspace_file_monitor()
        .expect("server watches its workspace");
    assert_eq!(monitor.cwd(), workspace);
    assert!(monitor.wait_until_ready(WATCH_DEADLINE));
    let cwd = workspace.to_string_lossy().into_owned();

    let mut ws = connect_initialized(handle.ws_url()).await;
    let mut seen = Vec::new();

    // External edit picked up by the watcher.
    let deck = workspace.join("deck.md");
    let deck_str = deck.to_string_lossy().into_owned();
    let changed = wait_for_file_changed(
        &mut ws,
        &mut seen,
        || std::fs::write(&deck, "agent edit").unwrap(),
        |p| p["path"] == deck_str.as_str() && p["kind"] == "changed",
    )
    .await;
    assert_eq!(changed["cwd"], cwd.as_str());
    assert_eq!(changed["version"]["size"], "agent edit".len());
    for key in ["modifiedAtMs", "changeTimeMs", "fingerprint"] {
        assert!(changed["version"].get(key).is_some(), "{changed}");
    }

    // Rename route: deleted for the source, changed for the destination.
    let client = reqwest::Client::new();
    let base_url = format!("http://127.0.0.1:{}", handle.port());
    let res = client
        .post(format!("{base_url}/cowork/fs/rename"))
        .json(&json!({ "path": deck_str, "newName": "deck-final.md" }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 204);
    let renamed = workspace.join("deck-final.md");
    let renamed_str = renamed.to_string_lossy().into_owned();
    let deleted = wait_for_file_changed(
        &mut ws,
        &mut seen,
        || {},
        |p| p["path"] == deck_str.as_str() && p["kind"] == "deleted",
    )
    .await;
    assert_eq!(
        deleted,
        json!({ "cwd": cwd, "kind": "deleted", "path": deck_str, "version": null })
    );
    let dest = wait_for_file_changed(
        &mut ws,
        &mut seen,
        || {},
        |p| p["path"] == renamed_str.as_str() && p["kind"] == "changed",
    )
    .await;
    assert_eq!(dest["cwd"], cwd.as_str());
    assert_eq!(dest["version"]["size"], "agent edit".len());

    // Trash route: deleted for the trashed path.
    seen.clear();
    let res = client
        .post(format!("{base_url}/cowork/fs/trash"))
        .json(&json!({ "path": renamed_str }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 204);
    let trashed = wait_for_file_changed(
        &mut ws,
        &mut seen,
        || {},
        |p| p["path"] == renamed_str.as_str() && p["kind"] == "deleted",
    )
    .await;
    assert_eq!(trashed["version"], Value::Null);
    // The trash directory itself is ignored by the watcher.
    let trash_dir = workspace.join(".cowork-trash");
    assert!(
        !seen.iter().any(|p| p["path"]
            .as_str()
            .is_some_and(|s| Path::new(s).starts_with(&trash_dir))),
        "{seen:?}"
    );

    handle.shutdown().await;
}

/// `/cowork/health`, `server_listening` and `fileChanged` report the working directory as it was
/// passed (TS `config.workingDirectory` = `path.resolve(--dir)`), not its realpath: on Windows the
/// canonical form is the verbatim `\\?\C:\...` long-name path, which the desktop does not expect.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn health_listening_and_file_changed_report_working_directory_as_given() {
    // Deliberately not canonicalized: `/var/...` on macOS, `RUNNER~1` short names on Windows.
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().to_path_buf();
    let real_workspace = base.join("workspace");
    std::fs::create_dir_all(real_workspace.join("sub")).unwrap();
    #[cfg(unix)]
    let given_root = {
        let link = base.join("workspace-link");
        std::os::unix::fs::symlink(&real_workspace, &link).unwrap();
        link
    };
    #[cfg(not(unix))]
    let given_root = real_workspace.clone();
    // `--dir <root>/./sub/..` is reported lexically normalized, without resolving links.
    let passed = given_root.join(".").join("sub").join("..");
    let expected = given_root.to_string_lossy().into_owned();

    let handle = start_server(server_options(&base, &passed)).await.unwrap();
    let canonical = std::fs::canonicalize(&real_workspace).unwrap();
    assert_eq!(handle.runtime().working_directory, canonical);

    let health: Value = reqwest::get(format!("http://127.0.0.1:{}/cowork/health", handle.port()))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(health["cwd"], expected.as_str(), "{health}");
    assert_eq!(handle.listening_event().cwd, expected);

    let monitor = handle.workspace_file_monitor().expect("monitor");
    assert_eq!(monitor.cwd(), canonical);
    assert!(monitor.wait_until_ready(WATCH_DEADLINE));
    let mut ws = connect_initialized(handle.ws_url()).await;
    let mut seen = Vec::new();
    let file = canonical.join("given.md");
    let file_str = file.to_string_lossy().into_owned();
    let changed = wait_for_file_changed(
        &mut ws,
        &mut seen,
        || std::fs::write(&file, "x").unwrap(),
        |p| p["path"] == file_str.as_str() && p["kind"] == "changed",
    )
    .await;
    assert_eq!(changed["cwd"], expected.as_str());

    handle.shutdown().await;
}
