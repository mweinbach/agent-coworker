//! Startup installs the default `workspace-tools` marketplace plugin on a clean Cowork home
//! (TS `ensureDefaultGlobalSkillsReady`, awaited before startup is ready) when
//! `COWORK_BOOTSTRAP_DEFAULT_SKILLS` allows it, and installs nothing when it is off.
//!
//! The built-in marketplace is served by a loopback mock of the GitHub API and raw hosts.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use axum::Router;
use axum::extract::Path as AxumPath;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::get;
use cowork_server::{ServerOptions, start_server};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::net::TcpListener;

const SHA: &str = "0123456789abcdef0123456789abcdef01234567";

fn walk(root: &Path, dir: &Path, out: &mut Vec<Value>) {
    for entry in fs::read_dir(dir).unwrap().flatten() {
        let path = entry.path();
        let rel = path
            .strip_prefix(root)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        if path.is_dir() {
            out.push(json!({ "path": rel, "type": "tree" }));
            walk(root, &path, out);
        } else {
            out.push(json!({ "path": rel, "type": "blob" }));
        }
    }
}

/// Mock of the built-in marketplace repo with one `workspace-tools` plugin; returns its env
/// overrides and a counter of requests served.
async fn serve_mock_marketplace(base: &Path) -> (HashMap<String, String>, Arc<AtomicUsize>) {
    let repo = base.join("mock-marketplace-repo");
    let plugin = repo.join("plugins/workspace-tools");
    fs::create_dir_all(plugin.join(".cowork-plugin")).unwrap();
    fs::create_dir_all(plugin.join("skills/spreadsheets")).unwrap();
    fs::write(
        plugin.join(".cowork-plugin/plugin.json"),
        json!({ "name": "workspace-tools", "version": "1.0.0", "description": "Docs, PDF, slides, sheets" })
            .to_string(),
    )
    .unwrap();
    fs::write(
        plugin.join("skills/spreadsheets/SKILL.md"),
        "---\nname: spreadsheets\ndescription: Work with spreadsheets\n---\nUse the runtime.\n",
    )
    .unwrap();
    fs::create_dir_all(repo.join(".agents/plugins")).unwrap();
    fs::write(
        repo.join(".agents/plugins/marketplace.json"),
        json!({
            "name": "cowork-skills-plugins",
            "plugins": [{
                "name": "workspace-tools",
                "source": { "source": "local", "path": "./plugins/workspace-tools" },
                "category": "Productivity"
            }]
        })
        .to_string(),
    )
    .unwrap();

    let hits = Arc::new(AtomicUsize::new(0));
    let (h1, h2, h3) = (hits.clone(), hits.clone(), hits.clone());
    let tree_root = repo.clone();
    let raw_root = repo.clone();
    let app = Router::new()
        .route(
            "/repos/{owner}/{repo}/commits/{git_ref}",
            get(move || {
                h1.fetch_add(1, Ordering::SeqCst);
                async { axum::Json(json!({ "sha": SHA })) }
            }),
        )
        .route(
            "/repos/{owner}/{repo}/git/trees/{sha}",
            get(move || {
                h2.fetch_add(1, Ordering::SeqCst);
                let mut tree = Vec::new();
                walk(&tree_root, &tree_root, &mut tree);
                async move { axum::Json(json!({ "sha": SHA, "truncated": false, "tree": tree })) }
            }),
        )
        .route(
            "/raw/{owner}/{repo}/{git_ref}/{*file_path}",
            get(
                move |AxumPath((_o, _r, _g, file_path)): AxumPath<(
                    String,
                    String,
                    String,
                    String,
                )>| {
                    h3.fetch_add(1, Ordering::SeqCst);
                    let target = raw_root.join(file_path.trim_start_matches('/'));
                    async move {
                        match fs::read(&target) {
                            Ok(bytes) => (StatusCode::OK, bytes).into_response(),
                            Err(_) => StatusCode::NOT_FOUND.into_response(),
                        }
                    }
                },
            ),
        );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    let env = HashMap::from([
        (
            "COWORK_GITHUB_API_BASE_URL".to_owned(),
            format!("http://{addr}"),
        ),
        (
            "COWORK_GITHUB_RAW_BASE_URL".to_owned(),
            format!("http://{addr}/raw"),
        ),
    ]);
    (env, hits)
}

struct Iso {
    _root: TempDir,
    base: PathBuf,
    home: PathBuf,
    workspace: PathBuf,
}

impl Iso {
    fn new() -> Self {
        let root = tempfile::Builder::new()
            .prefix("cowork-default-skills-")
            .tempdir()
            .unwrap();
        let base = fs::canonicalize(root.path()).unwrap();
        let home = base.join("home");
        let workspace = base.join("workspace");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&workspace).unwrap();
        Self {
            _root: root,
            base,
            home,
            workspace,
        }
    }

    fn options(&self, extra: &HashMap<String, String>, bootstrap: &str) -> ServerOptions {
        let mut env = HashMap::from([
            ("HOME".to_owned(), self.home.to_string_lossy().into_owned()),
            (
                "COWORK_HOME_OVERRIDE".to_owned(),
                self.home.join(".cowork").to_string_lossy().into_owned(),
            ),
            // Runtime setup stays enabled (offline, nothing installed) so readiness waits on
            // both runtime and default plugin setup, as on desktop.
            ("COWORK_RUNTIME_ALLOW_NETWORK".to_owned(), "0".to_owned()),
            (
                "COWORK_BOOTSTRAP_DEFAULT_SKILLS".to_owned(),
                bootstrap.to_owned(),
            ),
            ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
        ]);
        env.extend(extra.clone());
        ServerOptions {
            working_directory: self.workspace.clone(),
            host: "127.0.0.1".to_owned(),
            port: 0,
            yolo: false,
            mobile_h3: false,
            mobile_h3_host: "127.0.0.1".to_owned(),
            mobile_h3_port: 0,
            homedir: Some(self.home.clone()),
            built_in_dir: None,
            env,
        }
    }

    fn plugin_manifest(&self) -> PathBuf {
        self.home
            .join(".cowork/plugins/workspace-tools/.cowork-plugin/plugin.json")
    }

    fn state_file(&self) -> PathBuf {
        self.home.join(".cowork/config/default-global-skills.json")
    }
}

#[tokio::test]
async fn startup_installs_the_default_plugin_on_a_clean_home_before_ready() {
    let iso = Iso::new();
    let (mock_env, hits) = serve_mock_marketplace(&iso.base).await;

    let server = start_server(iso.options(&mock_env, "1")).await.unwrap();
    server.runtime().wait_for_startup_ready().await;
    let startup = server.runtime().startup_snapshot();
    assert!(startup.ready, "{startup:?}");
    assert!(
        iso.plugin_manifest().is_file(),
        "workspace-tools must be installed before startup is ready"
    );
    assert!(
        iso.home
            .join(".cowork/plugins/workspace-tools/skills/spreadsheets/SKILL.md")
            .is_file()
    );
    let state: Value =
        serde_json::from_str(&fs::read_to_string(iso.state_file()).unwrap()).unwrap();
    assert_eq!(state["plugins"], json!(["workspace-tools"]));
    assert_eq!(state["marketplace"], "mweinbach/cowork-skills-plugins");
    assert!(
        !iso.home
            .join(".cowork/config/default-global-skills.failure.json")
            .exists()
    );
    server.shutdown().await;

    // The recorded state makes the next start skip the marketplace entirely.
    let served = hits.load(Ordering::SeqCst);
    assert!(served > 0);
    let server = start_server(iso.options(&mock_env, "1")).await.unwrap();
    server.runtime().wait_for_startup_ready().await;
    assert_eq!(hits.load(Ordering::SeqCst), served);
    assert!(iso.plugin_manifest().is_file());
    server.shutdown().await;
}

#[tokio::test]
async fn startup_installs_nothing_when_the_default_plugin_bootstrap_is_off() {
    let iso = Iso::new();
    let (mock_env, hits) = serve_mock_marketplace(&iso.base).await;

    let server = start_server(iso.options(&mock_env, "0")).await.unwrap();
    server.runtime().wait_for_startup_ready().await;
    assert!(server.runtime().startup_snapshot().ready);
    assert!(!iso.plugin_manifest().exists());
    assert!(!iso.home.join(".cowork/plugins/workspace-tools").exists());
    assert!(!iso.state_file().exists());
    assert_eq!(hits.load(Ordering::SeqCst), 0);
    server.shutdown().await;
}
