//! Remote skill/plugin sources against a commit-addressed mock GitHub: plugin manifest links
//! resolve to their bundle root, and installs record the requested ref separately from the
//! commit SHA they downloaded so updates track moving refs while explicit SHAs stay pinned.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::Router;
use axum::extract::{Path as AxumPath, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use cowork_config::{AgentConfig, LoadConfigOptions, load_config};
use cowork_harness::extensions::ExtensionManager;
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use uuid::Uuid;

#[derive(Default)]
struct MockRepo {
    default_branch: String,
    branches: HashMap<String, String>,
    snapshots: HashMap<String, PathBuf>,
}

#[derive(Default)]
struct MockGitHub {
    repos: HashMap<String, MockRepo>,
    /// Every ref passed to the commit lookup, as `owner/repo@ref`.
    commit_lookups: Vec<String>,
}

type Shared = Arc<Mutex<MockGitHub>>;

impl MockGitHub {
    /// Publishes `snapshot` as commit `sha` and moves each of `branches` to it.
    fn push(
        &mut self,
        repo: &str,
        default_branch: &str,
        branches: &[&str],
        sha: &str,
        snapshot: &Path,
    ) {
        let entry = self.repos.entry(repo.to_owned()).or_default();
        entry.default_branch = default_branch.to_owned();
        entry
            .snapshots
            .insert(sha.to_owned(), snapshot.to_path_buf());
        for branch in branches {
            entry.branches.insert((*branch).to_owned(), sha.to_owned());
        }
    }

    fn resolve(&self, repo: &str, git_ref: &str) -> Option<String> {
        let entry = self.repos.get(repo)?;
        if entry.snapshots.contains_key(git_ref) {
            return Some(git_ref.to_owned());
        }
        let branch = if git_ref == "HEAD" {
            entry.default_branch.as_str()
        } else {
            git_ref
        };
        entry.branches.get(branch).cloned()
    }

    fn snapshot(&self, repo: &str, sha: &str) -> Option<PathBuf> {
        self.repos.get(repo)?.snapshots.get(sha).cloned()
    }
}

async fn repo_meta(
    State(state): State<Shared>,
    AxumPath((owner, repo)): AxumPath<(String, String)>,
) -> Response {
    match state.lock().repos.get(&format!("{owner}/{repo}")) {
        Some(r) => axum::Json(json!({ "default_branch": r.default_branch })).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn commit(
    State(state): State<Shared>,
    AxumPath((owner, repo, git_ref)): AxumPath<(String, String, String)>,
) -> Response {
    let slug = format!("{owner}/{repo}");
    let mut gh = state.lock();
    gh.commit_lookups.push(format!("{slug}@{git_ref}"));
    match gh.resolve(&slug, &git_ref) {
        Some(sha) => axum::Json(json!({ "sha": sha })).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn tree(
    State(state): State<Shared>,
    AxumPath((owner, repo, sha)): AxumPath<(String, String, String)>,
) -> Response {
    let Some(root) = state.lock().snapshot(&format!("{owner}/{repo}"), &sha) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let mut entries = Vec::new();
    for entry in walkdir::WalkDir::new(&root).into_iter().flatten() {
        if entry.path() == root {
            continue;
        }
        let rel = entry
            .path()
            .strip_prefix(&root)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        let kind = if entry.file_type().is_dir() {
            "tree"
        } else {
            "blob"
        };
        entries.push(json!({ "path": rel, "type": kind }));
    }
    axum::Json(json!({ "sha": sha, "truncated": false, "tree": entries })).into_response()
}

/// Serves files only by commit SHA, so a download that is not pinned to one snapshot fails.
async fn raw_file(
    State(state): State<Shared>,
    AxumPath((owner, repo, sha, file_path)): AxumPath<(String, String, String, String)>,
) -> Response {
    let Some(root) = state.lock().snapshot(&format!("{owner}/{repo}"), &sha) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match fs::read(root.join(file_path.trim_start_matches('/'))) {
        Ok(bytes) => (StatusCode::OK, bytes).into_response(),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

struct Fixture {
    base: PathBuf,
    ws: PathBuf,
    cfg: AgentConfig,
    ext: ExtensionManager,
    gh: Shared,
    server: JoinHandle<()>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
        let _ = fs::remove_dir_all(&self.base);
    }
}

/// The canonical `/private/tmp` Seatbelt scratch root on macOS, the platform temp dir elsewhere.
fn test_temp_base() -> PathBuf {
    if cfg!(target_os = "macos") {
        PathBuf::from("/private/tmp")
    } else {
        std::env::temp_dir()
    }
}

async fn fixture(tag: &str) -> Fixture {
    let base = test_temp_base().join(format!("cowork-remote-refs-{tag}-{}", Uuid::new_v4()));
    let home = base.join("home");
    let ws = base.join("ws");
    fs::create_dir_all(home.join(".cowork/config")).unwrap();
    fs::create_dir_all(ws.join(".cowork/skills")).unwrap();
    fs::create_dir_all(base.join("builtin/skills")).unwrap();

    let gh: Shared = Arc::default();
    let app = Router::new()
        .route("/repos/{owner}/{repo}", get(repo_meta))
        .route("/repos/{owner}/{repo}/commits/{git_ref}", get(commit))
        .route("/repos/{owner}/{repo}/git/trees/{sha}", get(tree))
        .route("/raw/{owner}/{repo}/{sha}/{*file_path}", get(raw_file))
        .with_state(gh.clone());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    let mut env = HashMap::new();
    env.insert("HOME".to_owned(), home.to_string_lossy().into_owned());
    env.insert(
        "COWORK_HOME_OVERRIDE".to_owned(),
        home.join(".cowork").to_string_lossy().into_owned(),
    );
    env.insert("COWORK_DISABLE_RUNTIME".to_owned(), "1".to_owned());
    env.insert("COWORK_RUNTIME_ALLOW_NETWORK".to_owned(), "0".to_owned());
    env.insert(
        "COWORK_GITHUB_API_BASE_URL".to_owned(),
        format!("http://{addr}"),
    );
    env.insert(
        "COWORK_GITHUB_RAW_BASE_URL".to_owned(),
        format!("http://{addr}/raw"),
    );
    let cfg = load_config(LoadConfigOptions {
        cwd: Some(ws.clone()),
        homedir: Some(home.clone()),
        built_in_dir: Some(base.join("builtin")),
        env: Some(env.clone()),
    })
    .unwrap();
    Fixture {
        base,
        ws,
        cfg,
        ext: ExtensionManager::new(env),
        gh,
        server,
    }
}

fn write_json(path: &Path, value: &Value) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, serde_json::to_string_pretty(value).unwrap()).unwrap();
}

fn write_text(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

/// Repository snapshot holding a standalone skill and two plugin bundles, one per manifest dir.
fn snapshot(fx: &Fixture, name: &str, version: &str) -> PathBuf {
    let root = fx.base.join("snapshots").join(name);
    write_text(
        &root.join("skills/sql-helper/SKILL.md"),
        &format!(
            "---\nname: sql-helper\ndescription: SQL helper {version}\n---\nBody {version}.\n"
        ),
    );
    write_json(
        &root.join("plugins/acme-suite/.cowork-plugin/plugin.json"),
        &json!({ "name": "acme-suite", "version": "1.0.0", "description": "Acme suite" }),
    );
    write_text(
        &root.join("plugins/acme-suite/skills/audit/SKILL.md"),
        &format!("---\nname: audit\ndescription: Audit {version}\n---\nAudit {version}.\n"),
    );
    write_json(
        &root.join("tools/codex-kit/.codex-plugin/plugin.json"),
        &json!({ "name": "codex-kit", "version": "1.0.0", "description": "Codex kit" }),
    );
    write_text(
        &root.join("tools/codex-kit/skills/lint/SKILL.md"),
        "---\nname: lint\ndescription: Lint things\n---\nLint.\n",
    );
    root
}

fn sha(c: char) -> String {
    std::iter::repeat_n(c, 40).collect()
}

fn read_json(path: &Path) -> Value {
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

fn skill_manifest_path(fx: &Fixture) -> PathBuf {
    fx.ws.join(".cowork/skills/sql-helper/.cowork-skill.json")
}

fn plugin_install_path(fx: &Fixture, id: &str) -> PathBuf {
    fx.cfg
        .workspace_plugins_dir
        .join(id)
        .join(".cowork-plugin/install.json")
}

async fn skill_installation_id(fx: &Fixture) -> String {
    fx.ext
        .read_skills_catalog(&fx.cfg, false)
        .await
        .unwrap()
        .installations
        .into_iter()
        .find(|i| i.name == "sql-helper" && i.scope == "project")
        .expect("sql-helper installed in project scope")
        .installation_id
}

async fn plugin_install_source(fx: &Fixture, id: &str) -> Option<String> {
    fx.ext
        .read_plugins_catalog(&fx.cfg, false)
        .await
        .unwrap()
        .plugins
        .into_iter()
        .find(|p| p.id == id && p.scope == "workspace")
        .expect("plugin installed in workspace scope")
        .install_source
}

#[tokio::test]
async fn plugin_manifest_urls_resolve_to_the_bundle_root() {
    let fx = fixture("manifest").await;
    let v1 = snapshot(&fx, "v1", "v1");
    let a = sha('a');
    fx.gh.lock().push("acme/ext", "main", &["main"], &a, &v1);

    for (source, plugin_id, bundle_root, manifest_rel) in [
        (
            "https://github.com/acme/ext/blob/main/plugins/acme-suite/.cowork-plugin/plugin.json",
            "acme-suite",
            "plugins/acme-suite",
            ".cowork-plugin/plugin.json",
        ),
        (
            "https://raw.githubusercontent.com/acme/ext/main/plugins/acme-suite/.cowork-plugin/plugin.json",
            "acme-suite",
            "plugins/acme-suite",
            ".cowork-plugin/plugin.json",
        ),
        (
            "https://github.com/acme/ext/blob/main/tools/codex-kit/.codex-plugin/plugin.json",
            "codex-kit",
            "tools/codex-kit",
            ".codex-plugin/plugin.json",
        ),
        (
            "https://github.com/acme/ext/tree/main/tools/codex-kit/.codex-plugin",
            "codex-kit",
            "tools/codex-kit",
            ".codex-plugin/plugin.json",
        ),
    ] {
        let preview = fx
            .ext
            .preview_plugin_install(&fx.cfg, source, "workspace")
            .await
            .unwrap_or_else(|e| panic!("preview {source}: {e}"));
        assert_eq!(
            preview.source.subdir.as_deref(),
            Some(bundle_root),
            "{source}"
        );
        assert_eq!(preview.candidates.len(), 1, "{source}");
        assert_eq!(preview.candidates[0].plugin_id, plugin_id, "{source}");

        fx.ext
            .install_plugin(&fx.cfg, source, "workspace")
            .await
            .unwrap_or_else(|e| panic!("install {source}: {e}"));
        let installed = fx.cfg.workspace_plugins_dir.join(plugin_id);
        assert!(installed.join(manifest_rel).is_file(), "{source}");
        assert!(installed.join("skills").is_dir(), "{source}");
        let record = read_json(&plugin_install_path(&fx, plugin_id));
        assert_eq!(record["source"]["subdir"], bundle_root, "{source}");
        assert_eq!(record["source"]["ref"], "main", "{source}");
        assert_eq!(record["source"]["commitSha"], a.as_str(), "{source}");
        assert_eq!(
            plugin_install_source(&fx, plugin_id).await.as_deref(),
            Some(format!("https://github.com/acme/ext/tree/main/{bundle_root}").as_str()),
        );
    }
}

#[tokio::test]
async fn moving_sources_record_the_requested_ref_and_updates_follow_upstream() {
    let fx = fixture("moving").await;
    let v1 = snapshot(&fx, "v1", "v1");
    let (skills_a, ext_a) = (sha('a'), sha('b'));
    {
        let mut gh = fx.gh.lock();
        // A default branch other than `main` proves the real default branch is recorded.
        gh.push("acme/skills", "trunk", &["trunk"], &skills_a, &v1);
        gh.push("acme/ext", "main", &["main"], &ext_a, &v1);
    }

    fx.ext
        .install_skill(&fx.cfg, "acme/skills", "project")
        .await
        .unwrap();
    let origin = read_json(&skill_manifest_path(&fx))["origin"].clone();
    assert_eq!(origin["ref"], "trunk");
    assert_eq!(origin["commitSha"], skills_a.as_str());
    assert_eq!(origin["url"], "https://github.com/acme/skills");
    assert_eq!(origin["subdir"], "skills/sql-helper");

    let plugin_src = "https://github.com/acme/ext/tree/main/plugins/acme-suite";
    fx.ext
        .install_plugin(&fx.cfg, plugin_src, "workspace")
        .await
        .unwrap();
    let source = read_json(&plugin_install_path(&fx, "acme-suite"))["source"].clone();
    assert_eq!(source["ref"], "main");
    assert_eq!(source["commitSha"], ext_a.as_str());
    assert_eq!(source["url"], plugin_src);

    let skill_id = skill_installation_id(&fx).await;
    let check = fx
        .ext
        .check_skill_installation_update(&fx.cfg, &skill_id)
        .await
        .unwrap();
    assert!(!check.can_update, "no upstream change yet");
    let check = fx
        .ext
        .check_plugin_update(&fx.cfg, "acme-suite", Some("workspace"))
        .await
        .unwrap();
    assert!(!check.can_update, "no upstream change yet");

    // Upstream pushes a new commit to both moving refs.
    let v2 = snapshot(&fx, "v2", "v2");
    let (skills_b, ext_b) = (sha('c'), sha('d'));
    {
        let mut gh = fx.gh.lock();
        gh.push("acme/skills", "trunk", &["trunk"], &skills_b, &v2);
        gh.push("acme/ext", "main", &["main"], &ext_b, &v2);
    }

    let check = fx
        .ext
        .check_skill_installation_update(&fx.cfg, &skill_id)
        .await
        .unwrap();
    assert!(check.can_update, "new upstream commit must be detected");
    fx.ext
        .update_skill_installation(&fx.cfg, &skill_id)
        .await
        .unwrap();
    let body = fs::read_to_string(fx.ws.join(".cowork/skills/sql-helper/SKILL.md")).unwrap();
    assert!(body.contains("Body v2."), "{body}");
    let origin = read_json(&skill_manifest_path(&fx))["origin"].clone();
    assert_eq!(origin["ref"], "trunk");
    assert_eq!(origin["commitSha"], skills_b.as_str());

    let check = fx
        .ext
        .check_plugin_update(&fx.cfg, "acme-suite", Some("workspace"))
        .await
        .unwrap();
    assert!(check.can_update, "new upstream commit must be detected");
    fx.ext
        .update_plugin(&fx.cfg, "acme-suite", Some("workspace"))
        .await
        .unwrap();
    let audit = fs::read_to_string(
        fx.cfg
            .workspace_plugins_dir
            .join("acme-suite/skills/audit/SKILL.md"),
    )
    .unwrap();
    assert!(audit.contains("Audit v2."), "{audit}");
    let source = read_json(&plugin_install_path(&fx, "acme-suite"))["source"].clone();
    assert_eq!(source["ref"], "main");
    assert_eq!(source["commitSha"], ext_b.as_str());

    // Every commit lookup re-resolved the requested branch, never a previously resolved SHA.
    let lookups = fx.gh.lock().commit_lookups.clone();
    assert!(
        lookups
            .iter()
            .all(|l| l.ends_with("@trunk") || l.ends_with("@main")),
        "{lookups:?}"
    );
}

#[tokio::test]
async fn explicit_commit_sha_installs_stay_pinned() {
    let fx = fixture("pinned").await;
    let v1 = snapshot(&fx, "v1", "v1");
    let (skills_a, ext_a) = (sha('a'), sha('b'));
    {
        let mut gh = fx.gh.lock();
        gh.push("acme/skills", "main", &["main"], &skills_a, &v1);
        gh.push("acme/ext", "main", &["main"], &ext_a, &v1);
    }

    fx.ext
        .install_skill(
            &fx.cfg,
            &format!("https://github.com/acme/skills/tree/{skills_a}/skills/sql-helper"),
            "project",
        )
        .await
        .unwrap();
    fx.ext
        .install_plugin(
            &fx.cfg,
            &format!("acme/ext/plugins/acme-suite#{ext_a}"),
            "workspace",
        )
        .await
        .unwrap();

    let v2 = snapshot(&fx, "v2", "v2");
    {
        let mut gh = fx.gh.lock();
        gh.push("acme/skills", "main", &["main"], &sha('c'), &v2);
        gh.push("acme/ext", "main", &["main"], &sha('d'), &v2);
    }

    let skill_id = skill_installation_id(&fx).await;
    let check = fx
        .ext
        .check_skill_installation_update(&fx.cfg, &skill_id)
        .await
        .unwrap();
    assert!(
        !check.can_update,
        "a pinned SHA must not see branch movement"
    );
    fx.ext
        .update_skill_installation(&fx.cfg, &skill_id)
        .await
        .unwrap();
    let body = fs::read_to_string(fx.ws.join(".cowork/skills/sql-helper/SKILL.md")).unwrap();
    assert!(body.contains("Body v1."), "{body}");
    let origin = read_json(&skill_manifest_path(&fx))["origin"].clone();
    assert_eq!(origin["ref"], skills_a.as_str());
    assert_eq!(origin["commitSha"], skills_a.as_str());

    let check = fx
        .ext
        .check_plugin_update(&fx.cfg, "acme-suite", Some("workspace"))
        .await
        .unwrap();
    assert!(
        !check.can_update,
        "a pinned SHA must not see branch movement"
    );
    assert_eq!(
        plugin_install_source(&fx, "acme-suite").await.as_deref(),
        Some(format!("https://github.com/acme/ext/tree/{ext_a}/plugins/acme-suite").as_str()),
    );
}

#[tokio::test]
async fn records_that_stored_the_resolved_sha_as_ref_track_their_original_source() {
    let fx = fixture("legacy").await;
    let v1 = snapshot(&fx, "v1", "v1");
    let (skills_a, ext_a) = (sha('a'), sha('b'));
    {
        let mut gh = fx.gh.lock();
        gh.push("acme/skills", "main", &["main"], &skills_a, &v1);
        gh.push("acme/ext", "main", &["main"], &ext_a, &v1);
    }
    fx.ext
        .install_skill(
            &fx.cfg,
            "https://github.com/acme/skills/tree/main/skills/sql-helper",
            "project",
        )
        .await
        .unwrap();
    fx.ext
        .install_plugin(&fx.cfg, "acme/ext", "workspace")
        .await
        .unwrap();

    // Rewrite both records to the earlier shape: `ref` holds the resolved SHA, no `commitSha`.
    let skill_manifest = skill_manifest_path(&fx);
    let mut manifest = read_json(&skill_manifest);
    manifest["origin"]["ref"] = json!(skills_a);
    manifest["origin"]
        .as_object_mut()
        .unwrap()
        .remove("commitSha");
    write_json(&skill_manifest, &manifest);
    let plugin_record = plugin_install_path(&fx, "acme-suite");
    let mut record = read_json(&plugin_record);
    record["source"]["ref"] = json!(ext_a);
    record["source"]
        .as_object_mut()
        .unwrap()
        .remove("commitSha");
    write_json(&plugin_record, &record);

    // The original URL names `main` (skill) or no ref at all, i.e. the default branch (plugin).
    assert_eq!(
        plugin_install_source(&fx, "acme-suite").await.as_deref(),
        Some("https://github.com/acme/ext/tree/HEAD/plugins/acme-suite"),
    );

    let v2 = snapshot(&fx, "v2", "v2");
    let (skills_b, ext_b) = (sha('c'), sha('d'));
    {
        let mut gh = fx.gh.lock();
        gh.push("acme/skills", "main", &["main"], &skills_b, &v2);
        gh.push("acme/ext", "main", &["main"], &ext_b, &v2);
    }

    let skill_id = skill_installation_id(&fx).await;
    let check = fx
        .ext
        .check_skill_installation_update(&fx.cfg, &skill_id)
        .await
        .unwrap();
    assert!(
        check.can_update,
        "legacy record must track its original branch"
    );
    fx.ext
        .update_skill_installation(&fx.cfg, &skill_id)
        .await
        .unwrap();
    let origin = read_json(&skill_manifest)["origin"].clone();
    assert_eq!(origin["ref"], "main");
    assert_eq!(origin["commitSha"], skills_b.as_str());

    let check = fx
        .ext
        .check_plugin_update(&fx.cfg, "acme-suite", Some("workspace"))
        .await
        .unwrap();
    assert!(
        check.can_update,
        "legacy record must track the default branch"
    );
    fx.ext
        .update_plugin(&fx.cfg, "acme-suite", Some("workspace"))
        .await
        .unwrap();
    let source = read_json(&plugin_record)["source"].clone();
    assert_eq!(source["commitSha"], ext_b.as_str());
    let audit = fs::read_to_string(
        fx.cfg
            .workspace_plugins_dir
            .join("acme-suite/skills/audit/SKILL.md"),
    )
    .unwrap();
    assert!(audit.contains("Audit v2."), "{audit}");
}
