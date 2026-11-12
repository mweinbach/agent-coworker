//! `list_projects` and worktree-backed threads (TS `LocalThreadHost` parity).
//!
//! - `list_projects` returns only `project` workspaces as TS `ProjectSummary`
//!   (`projectId`, `name`, `path`, `hostId: "local"`, `active`). Managed one-off chat directories
//!   (`~/.cowork/chats/<id>`) stay hidden.
//! - `thread/fork` and `create_thread` with a worktree environment register the new worktree in
//!   the web desktop state (TS `ensureDesktopWorkspace`). Without that it is missing from
//!   `workspace/list`, `workspace/switch` rejects it, and it falls outside the `/cowork/fs/*`
//!   roots.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use axum::Router;
use axum::body::Body;
use axum::http::{Response, StatusCode, header};
use axum::response::IntoResponse;
use axum::routing::post;
use cowork_protocol::{ThreadEnvironment, ThreadForkParams};
use cowork_server::http_desktop::build_workspace_summaries;
use cowork_server::memory_and_fork_routes::ServerThreadControlBridge;
use cowork_server::{ServerHandle, ServerOptions, start_server};
use cowork_tools::ThreadControlBridge;
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::net::TcpListener;

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
        env.insert("COWORK_WEB_DESKTOP_SERVICE".into(), "1".into());
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

/// Minimal OpenAI Responses mock so `create_thread`'s queued first turn completes.
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
        connection_id: "projects-and-worktrees-test".to_owned(),
    }
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

fn init_repo(dir: &Path) {
    fs::write(dir.join("README.md"), "hello\n").unwrap();
    git(dir, &["init", "-q"]);
    git(dir, &["add", "."]);
    git(dir, &["commit", "-q", "-m", "init"]);
}

fn save_workspaces(server: &ServerHandle, workspaces: Value) {
    server
        .runtime()
        .desktop_service
        .as_ref()
        .expect("desktop service")
        .save_state_json(json!({ "workspaces": workspaces }))
        .unwrap();
}

/// Asserts that `path` is a registered `project` workspace in the desktop state (what
/// `workspace/list` and `workspace/switch` read) and inside the `/cowork/fs/*` roots.
fn assert_registered_project(server: &ServerHandle, path: &Path, expected_name: &str) {
    let rt = server.runtime();
    let svc = rt.desktop_service.as_deref().expect("desktop service");
    let canon = fs::canonicalize(path).unwrap();
    let (workspaces, _) = build_workspace_summaries(&rt.working_directory, &rt.homedir, Some(svc));
    let entry = workspaces
        .iter()
        .find(|w| Path::new(&w.path) == canon)
        .unwrap_or_else(|| {
            panic!(
                "{} missing from workspace list: {workspaces:?}",
                canon.display()
            )
        });
    assert_eq!(entry.workspace_kind, "project", "{entry:?}");
    assert_eq!(entry.name, expected_name, "{entry:?}");
    assert!(entry.id.starts_with("project-"), "{entry:?}");
    assert!(
        svc.allowed_fs_roots(&rt.working_directory)
            .iter()
            .any(|root| root == &canon),
        "{} missing from /cowork/fs roots",
        canon.display()
    );
}

/// Hidden one-off chats are filtered out and each project is a TS `ProjectSummary`.
#[tokio::test]
async fn list_projects_returns_project_summaries_without_one_off_chats() {
    let iso = Iso::new("cowork-list-projects-shape-");
    let server = start_server(iso.options()).await.unwrap();

    let chat = cowork_config::get_one_off_chats_root(&iso.home).join("chat-hidden");
    fs::create_dir_all(&chat).unwrap();
    let other = iso.home.join("other-project");
    fs::create_dir_all(&other).unwrap();
    save_workspaces(
        &server,
        json!([
            {
                "id": "ws-main",
                "name": "Main",
                "path": iso.workspace.to_string_lossy(),
                "workspaceKind": "project",
                "defaultProvider": "openai",
                "defaultModel": "gpt-5.4",
                "createdAt": "2026-01-01T00:00:00.000Z",
                "lastOpenedAt": "2026-01-01T00:00:00.000Z"
            },
            {
                "id": "chat-1",
                "name": "Quick chat",
                "path": chat.to_string_lossy(),
                "workspaceKind": "oneOffChat",
                "createdAt": "2026-01-01T00:00:00.000Z",
                "lastOpenedAt": "2026-01-01T00:00:00.000Z"
            },
            {
                "id": "ws-other",
                "name": "Other",
                "path": other.to_string_lossy(),
                "workspaceKind": "project",
                "createdAt": "2026-01-01T00:00:00.000Z",
                "lastOpenedAt": "2026-01-01T00:00:00.000Z"
            }
        ]),
    );

    let res = bridge(&server).list_projects().await.unwrap();
    assert_eq!(
        res,
        json!({
            "projects": [
                {
                    "projectId": "ws-main",
                    "name": "Main",
                    "path": iso.workspace.to_string_lossy(),
                    "hostId": "local",
                    "active": true,
                    "defaultProvider": "openai",
                    "defaultModel": "gpt-5.4"
                },
                {
                    "projectId": "ws-other",
                    "name": "Other",
                    "path": other.to_string_lossy(),
                    "hostId": "local",
                    "active": false
                }
            ]
        })
    );

    server.shutdown().await;
}

/// `thread/fork` into a worktree registers the worktree as a desktop project workspace named
/// `<fork title> worktree`.
#[tokio::test]
async fn fork_into_worktree_registers_desktop_workspace() {
    let iso = Iso::new("cowork-fork-worktree-workspace-");
    init_repo(&iso.workspace);
    let server = start_server(iso.options()).await.unwrap();
    let rt = server.runtime();

    let (source, _) = rt
        .start_or_get_thread(&iso.workspace, None, None, None, "fork-test")
        .await
        .unwrap();
    let res = rt
        .handle_thread_fork(
            None,
            &ThreadForkParams {
                thread_id: source.id.clone(),
                environment: Some(ThreadEnvironment::Worktree {
                    r#ref: None,
                    branch_name: None,
                    starting_state: None,
                }),
                title: Some("Feature".to_owned()),
                prompt: None,
                model: None,
                thinking: None,
            },
        )
        .await
        .unwrap_or_else(|e| panic!("fork failed: {}", e.message));
    assert_eq!(res["environment"]["type"], json!("worktree"), "{res}");
    let wt_cwd = PathBuf::from(res["environment"]["cwd"].as_str().unwrap());
    assert!(wt_cwd.is_dir(), "{res}");
    assert_registered_project(&server, &wt_cwd, "Feature worktree");

    // Registered exactly once.
    let svc = rt.desktop_service.as_deref().unwrap();
    let canon = fs::canonicalize(&wt_cwd).unwrap();
    let matches = svc
        .workspace_entries(&rt.working_directory)
        .into_iter()
        .filter(|w| Path::new(&w.path) == canon)
        .count();
    assert_eq!(matches, 1);

    server.shutdown().await;
}

/// `create_thread` with `environment: "worktree"` registers the worktree as
/// `<base project name> worktree`.
#[tokio::test]
async fn create_thread_worktree_registers_desktop_workspace() {
    let mut iso = Iso::new("cowork-create-thread-worktree-workspace-");
    init_repo(&iso.workspace);
    start_mock(&mut iso).await;
    let server = start_server(iso.options()).await.unwrap();
    save_workspaces(
        &server,
        json!([{
            "id": "ws-main",
            "name": "Main",
            "path": iso.workspace.to_string_lossy(),
            "workspaceKind": "project",
            "createdAt": "2026-01-01T00:00:00.000Z",
            "lastOpenedAt": "2026-01-01T00:00:00.000Z"
        }]),
    );

    let res = bridge(&server)
        .create_thread(json!({
            "prompt": "work in a worktree",
            "cwd": iso.workspace.to_string_lossy(),
            "model": "gpt-5.4",
            "environment": "worktree"
        }))
        .await
        .unwrap();
    assert_eq!(res["queued"], json!(true), "{res}");
    let cwd = PathBuf::from(res["thread"]["cwd"].as_str().unwrap());
    assert_ne!(cwd, iso.workspace, "{res}");
    assert_registered_project(&server, &cwd, "Main worktree");

    // The worktree is now a listed project too.
    let projects = bridge(&server).list_projects().await.unwrap();
    assert!(
        projects["projects"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["name"] == json!("Main worktree")),
        "{projects}"
    );

    server.shutdown().await;
}
