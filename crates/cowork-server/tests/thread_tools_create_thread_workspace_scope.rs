//! `create_thread` (`ServerThreadControlBridge`) is model-callable, so its `cwd` must be scoped
//! like TS `LocalThreadHost.resolveCreateTarget`: only a known project workspace (the server
//! workspace or a desktop-registered `project`), a managed one-off chat, or a managed worktree
//! may host the new thread. Previously any readable absolute directory was accepted, so a
//! prompted root thread could open a thread (and its file tools) on an arbitrary directory and
//! read the result back with `read_thread`. The check runs on the canonical path, before any
//! worktree or thread is created, so a symlink inside an allowed root cannot escape it.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use axum::Router;
use axum::body::Body;
use axum::http::{Response, StatusCode, header};
use axum::response::IntoResponse;
use axum::routing::post;
use cowork_server::memory_and_fork_routes::ServerThreadControlBridge;
use cowork_server::{ServerHandle, ServerOptions, start_server};
use cowork_tools::ThreadControlBridge;
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::net::TcpListener;

const REJECTION: &str = "must match a registered project workspace or a managed one-off chat";

struct Iso {
    _root: TempDir,
    base: PathBuf,
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
        // Desktop-registered project workspaces are part of the allowed set.
        env.insert("COWORK_WEB_DESKTOP_SERVICE".into(), "1".into());
        env.insert("PATH".into(), "/usr/local/bin:/usr/bin:/bin".into());
        Self {
            _root: root,
            base,
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

    /// A readable directory outside every workspace root (the "victim" directory).
    fn outside_dir(&self, name: &str) -> PathBuf {
        let dir = self.base.join("outside").join(name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("secret.txt"), "not for threads").unwrap();
        dir
    }
}

/// Minimal OpenAI Responses mock so the queued first turn of an accepted thread completes.
async fn start_mock(iso: &mut Iso) {
    fn sse(event_type: &str, data: Value) -> String {
        format!("event: {event_type}\ndata: {data}\n\n")
    }
    async fn handler() -> axum::response::Response {
        let mut body = sse(
            "response.created",
            json!({ "type": "response.created", "response": { "id": "resp_1" } }),
        );
        body.push_str(&sse(
            "response.output_item.done",
            json!({
                "type": "response.output_item.done",
                "output_index": 0,
                "item": {
                    "id": "msg_0", "type": "message", "role": "assistant", "status": "completed",
                    "content": [{ "type": "output_text", "text": "Done.", "annotations": [] }]
                }
            }),
        ));
        body.push_str(&sse(
            "response.completed",
            json!({
                "type": "response.completed",
                "response": {
                    "id": "resp_1", "status": "completed", "output": [],
                    "usage": { "input_tokens": 1, "output_tokens": 1 }
                }
            }),
        ));
        Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/event-stream")
            .body(Body::from(body))
            .unwrap()
            .into_response()
    }
    let app = Router::new().route("/v1/responses", post(handler));
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
}

fn bridge(server: &ServerHandle) -> ServerThreadControlBridge {
    ServerThreadControlBridge {
        runtime: server.runtime().clone(),
        connection_id: "create-thread-scope-test".to_owned(),
    }
}

fn session_count(server: &ServerHandle) -> usize {
    server
        .runtime()
        .session_db
        .list_sessions(None)
        .unwrap()
        .len()
}

fn session_cwds(server: &ServerHandle) -> Vec<String> {
    let db = &server.runtime().session_db;
    db.list_sessions(None)
        .unwrap()
        .into_iter()
        .filter_map(|s| db.get_session_record(&s.session_id).ok().flatten())
        .map(|r| r.working_directory)
        .collect()
}

async fn assert_rejected(server: &ServerHandle, args: Value) {
    let before = session_count(server);
    let err = bridge(server)
        .create_thread(args.clone())
        .await
        .expect_err(&format!("create_thread must be rejected for {args}"));
    assert!(
        err.contains(REJECTION),
        "unexpected error for {args}: {err}"
    );
    assert_eq!(
        session_count(server),
        before,
        "a rejected create_thread must not create a thread ({args})"
    );
}

async fn assert_created_in(server: &ServerHandle, cwd: &Path) {
    let before = session_count(server);
    let res = bridge(server)
        .create_thread(json!({
            "prompt": "scoped work",
            "cwd": cwd.to_string_lossy(),
            "model": "gpt-5.4"
        }))
        .await
        .unwrap_or_else(|e| panic!("create_thread in {} failed: {e}", cwd.display()));
    assert_eq!(res["queued"], json!(true), "{res}");
    assert_eq!(session_count(server), before + 1, "{res}");
    let expected = fs::canonicalize(cwd)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    assert!(
        session_cwds(server).contains(&expected),
        "no thread persisted in {expected}: {res}"
    );
}

fn git(dir: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@example.com")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@example.com")
        .status()
        .unwrap();
    assert!(status.success(), "git {args:?} failed");
}

fn worktree_entries(server: &ServerHandle) -> usize {
    fs::read_dir(server.runtime().worktree_service.worktrees_root())
        .map(|it| it.count())
        .unwrap_or(0)
}

/// An absolute directory outside every workspace root is rejected, in local and worktree
/// mode, and neither a thread nor a worktree is created.
#[tokio::test]
async fn create_thread_rejects_unregistered_absolute_cwd() {
    let iso = Iso::new("cowork-create-thread-scope-outside-");
    let server = start_server(iso.options()).await.unwrap();

    let outside = iso.outside_dir("victim");
    git(&outside, &["init", "-q"]);
    git(&outside, &["add", "."]);
    git(&outside, &["commit", "-q", "-m", "init"]);

    assert_rejected(
        &server,
        json!({ "prompt": "read secret.txt", "cwd": outside.to_string_lossy() }),
    )
    .await;
    assert_rejected(
        &server,
        json!({
            "prompt": "read secret.txt",
            "cwd": outside.to_string_lossy(),
            "environment": "worktree"
        }),
    )
    .await;
    assert_eq!(
        worktree_entries(&server),
        0,
        "no worktree may be created from an unauthorized base"
    );
    // A relative path that walks out of the server workspace is resolved, then rejected.
    assert_rejected(
        &server,
        json!({ "prompt": "read secret.txt", "cwd": "../outside/victim" }),
    )
    .await;
    // Parent directories of allowed roots are not themselves allowed.
    assert_rejected(
        &server,
        json!({ "prompt": "x", "cwd": iso.base.to_string_lossy() }),
    )
    .await;
    assert_rejected(&server, json!({ "prompt": "x", "cwd": "/" })).await;
    // The managed roots themselves are not workspaces.
    let chats_root = cowork_config::get_one_off_chats_root(&iso.home);
    fs::create_dir_all(&chats_root).unwrap();
    assert_rejected(
        &server,
        json!({ "prompt": "x", "cwd": chats_root.to_string_lossy() }),
    )
    .await;

    server.shutdown().await;
}

/// A symlink inside an allowed root that points outside is judged by its canonical target.
#[cfg(unix)]
#[tokio::test]
async fn create_thread_rejects_symlink_escaping_allowed_roots() {
    let iso = Iso::new("cowork-create-thread-scope-symlink-");
    let server = start_server(iso.options()).await.unwrap();
    let outside = iso.outside_dir("linked");

    let in_workspace = iso.workspace.join("escape");
    std::os::unix::fs::symlink(&outside, &in_workspace).unwrap();
    assert_rejected(
        &server,
        json!({ "prompt": "x", "cwd": in_workspace.to_string_lossy() }),
    )
    .await;

    let chats_root = cowork_config::get_one_off_chats_root(&iso.home);
    fs::create_dir_all(&chats_root).unwrap();
    let in_chats = chats_root.join("chat-escape");
    std::os::unix::fs::symlink(&outside, &in_chats).unwrap();
    assert_rejected(
        &server,
        json!({ "prompt": "x", "cwd": in_chats.to_string_lossy() }),
    )
    .await;

    // A registered project entry that is only a link's *parent* does not authorize the link.
    let registered = iso.base.join("registered");
    fs::create_dir_all(&registered).unwrap();
    let nested_link = registered.join("escape");
    std::os::unix::fs::symlink(&outside, &nested_link).unwrap();
    register_project(&server, &iso, &registered);
    assert_rejected(
        &server,
        json!({ "prompt": "x", "cwd": nested_link.to_string_lossy() }),
    )
    .await;

    server.shutdown().await;
}

fn register_project(server: &ServerHandle, iso: &Iso, path: &Path) {
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
                    "path": path.to_string_lossy(),
                    "workspaceKind": "project",
                    "createdAt": "2026-01-01T00:00:00.000Z",
                    "lastOpenedAt": "2026-01-01T00:00:00.000Z"
                }]
            }),
            &iso.workspace,
        )
        .unwrap();
}

/// The server workspace (explicit or defaulted), a desktop-registered project and a managed
/// one-off chat still host new threads.
#[tokio::test]
async fn create_thread_accepts_registered_workspaces_and_one_off_chats() {
    let mut iso = Iso::new("cowork-create-thread-scope-allowed-");
    start_mock(&mut iso).await;
    let server = start_server(iso.options()).await.unwrap();

    // Server workspace, explicit and by default.
    assert_created_in(&server, &iso.workspace).await;
    let before = session_count(&server);
    let res = bridge(&server)
        .create_thread(json!({ "prompt": "default cwd", "model": "gpt-5.4" }))
        .await
        .unwrap();
    assert_eq!(res["queued"], json!(true), "{res}");
    assert_eq!(session_count(&server), before + 1);

    // Desktop-registered project workspace outside the server workspace.
    let registered = iso.base.join("registered");
    fs::create_dir_all(&registered).unwrap();
    // Unregistered first, then accepted once registered.
    assert_rejected(
        &server,
        json!({ "prompt": "x", "cwd": registered.to_string_lossy() }),
    )
    .await;
    register_project(&server, &iso, &registered);
    assert_created_in(&server, &registered).await;

    // Managed one-off chat workspace.
    let chat = cowork_config::get_one_off_chats_root(&iso.home).join("chat-allowed");
    fs::create_dir_all(&chat).unwrap();
    assert_created_in(&server, &chat).await;

    server.shutdown().await;
}
