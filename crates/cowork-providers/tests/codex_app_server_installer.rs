//! Managed Codex app-server installer against a deterministic local GitHub release mock.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use axum::Router;
use axum::extract::{Path as AxumPath, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use cowork_providers::codex_app_server::installer::{
    managed_codex_current_path, managed_codex_executable_path,
};
use cowork_providers::codex_app_server::{
    CODEX_APP_SERVER_MANAGED_VERSION, CodexRuntimeInstallOptions, CodexRuntimeTarget,
    resolve_codex_app_server_status, update_managed_codex_app_server,
};
use parking_lot::Mutex;
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::net::TcpListener;

#[derive(Default)]
struct MockRelease {
    base_url: String,
    assets: HashMap<String, Vec<u8>>,
    downloads: Vec<String>,
    metadata_requests: usize,
}

type Shared = Arc<Mutex<MockRelease>>;

async fn release_metadata(State(state): State<Shared>) -> Response {
    let mut guard = state.lock();
    guard.metadata_requests += 1;
    let assets: Vec<_> = guard
        .assets
        .keys()
        .map(|name| {
            json!({
                "name": name,
                "browser_download_url": format!("{}/download/{name}", guard.base_url),
            })
        })
        .collect();
    axum::Json(json!({
        "tag_name": format!("rust-v{CODEX_APP_SERVER_MANAGED_VERSION}"),
        "assets": assets,
    }))
    .into_response()
}

async fn download(State(state): State<Shared>, AxumPath(name): AxumPath<String>) -> Response {
    let mut guard = state.lock();
    guard.downloads.push(name.clone());
    match guard.assets.get(&name) {
        Some(bytes) => bytes.clone().into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn start_mock() -> Shared {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let state: Shared = Arc::new(Mutex::new(MockRelease {
        base_url,
        ..MockRelease::default()
    }));
    let app = Router::new()
        .route(
            &format!("/repos/openai/codex/releases/tags/rust-v{CODEX_APP_SERVER_MANAGED_VERSION}"),
            get(release_metadata),
        )
        .route("/download/{name}", get(download))
        .with_state(Arc::clone(&state));
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    state
}

fn tar_gz_with(entry_name: &str, contents: &[u8]) -> Vec<u8> {
    let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(
        Vec::new(),
        flate2::Compression::fast(),
    ));
    let mut header = tar::Header::new_gnu();
    header.set_size(contents.len() as u64);
    header.set_mode(0o644);
    header.set_cksum();
    builder
        .append_data(&mut header, entry_name, contents)
        .unwrap();
    builder.into_inner().unwrap().finish().unwrap()
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// Serves an app-server + code-mode-host pair whose app-server prints `marker`, returning the
/// checksum override matching those bytes.
fn publish_release(state: &Shared, marker: &str) -> HashMap<String, String> {
    publish_release_with(state, marker, format!("#!/bin/sh\necho {marker}\n"))
}

fn publish_release_with(
    state: &Shared,
    marker: &str,
    app_server_body: String,
) -> HashMap<String, String> {
    let target = CodexRuntimeTarget::host().unwrap();
    let mut published = HashMap::new();
    for (basename, body) in [
        ("codex-app-server", app_server_body),
        (
            "codex-code-mode-host",
            format!("#!/bin/sh\necho host-{marker}\n"),
        ),
    ] {
        let asset = target.asset_name(basename).unwrap();
        let bytes = if asset.ends_with(".tar.gz") {
            tar_gz_with(&format!("dist/{basename}"), body.as_bytes())
        } else {
            body.into_bytes()
        };
        published.insert(asset, bytes);
    }
    let checksums = published
        .iter()
        .map(|(name, bytes)| (name.clone(), sha256_hex(bytes)))
        .collect();
    state.lock().assets = published;
    checksums
}

fn options(
    state: &Shared,
    checksums: Option<HashMap<String, String>>,
) -> CodexRuntimeInstallOptions {
    let mut opts = CodexRuntimeInstallOptions::from_env(&HashMap::new());
    opts.api_base_url = state.lock().base_url.clone();
    opts.github_token = Some("must-not-be-sent-to-a-mock".into());
    opts.expected_checksums = checksums;
    opts
}

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap()
}

#[tokio::test]
async fn fresh_install_makes_managed_runtime_available_with_ts_status_shape() {
    let home = tempfile::tempdir().unwrap();
    let cowork_home = home.path().join(".cowork");
    let state = start_mock().await;
    let checksums = publish_release(&state, "v1");

    let before = resolve_codex_app_server_status(&cowork_home, &HashMap::new());
    assert!(!before.available, "fresh home must start without a runtime");

    let status =
        update_managed_codex_app_server(&cowork_home, false, &options(&state, Some(checksums)))
            .await
            .expect("install");
    let target = CodexRuntimeTarget::host().unwrap();
    let current = managed_codex_current_path(&cowork_home, &target);
    let versioned =
        managed_codex_executable_path(&cowork_home, CODEX_APP_SERVER_MANAGED_VERSION, &target);
    let current_str = current.to_string_lossy().into_owned();
    assert_eq!(
        serde_json::to_value(&status).unwrap(),
        json!({
            "available": true,
            "source": "managed",
            "command": current_str,
            "args": [],
            "version": CODEX_APP_SERVER_MANAGED_VERSION,
            "pinnedVersion": CODEX_APP_SERVER_MANAGED_VERSION,
            "pinMatchesCurrent": true,
            "managedPath": current_str,
            "message": format!("Installed Cowork-managed Codex runtime {CODEX_APP_SERVER_MANAGED_VERSION}."),
        })
    );
    assert!(read(&versioned).contains("echo v1"));
    assert!(read(&current).contains("echo v1"));
    assert!(current.with_file_name("codex-code-mode-host").is_file());
    assert!(versioned.with_file_name("codex-code-mode-host").is_file());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&current).unwrap().permissions().mode();
        assert_eq!(mode & 0o111, 0o111, "promoted runtime must be executable");
    }

    let after = resolve_codex_app_server_status(&cowork_home, &HashMap::new());
    assert!(after.available);
    assert_eq!(after.source, "managed");
    assert_eq!(after.command.as_deref(), Some(current_str.as_str()));
    assert_eq!(
        after.version.as_deref(),
        Some(CODEX_APP_SERVER_MANAGED_VERSION)
    );
    assert_eq!(after.pin_matches_current, Some(true));
    assert_eq!(state.lock().downloads.len(), 2);
}

#[tokio::test]
async fn force_reinstalls_while_plain_update_keeps_the_verified_install() {
    let home = tempfile::tempdir().unwrap();
    let cowork_home = home.path().join(".cowork");
    let state = start_mock().await;
    let v1 = publish_release(&state, "v1");
    update_managed_codex_app_server(&cowork_home, false, &options(&state, Some(v1)))
        .await
        .expect("initial install");
    let current = managed_codex_current_path(&cowork_home, &CodexRuntimeTarget::host().unwrap());

    let v2 = publish_release(&state, "v2");
    state.lock().downloads.clear();
    update_managed_codex_app_server(&cowork_home, false, &options(&state, Some(v2.clone())))
        .await
        .expect("non-forced update");
    assert!(
        state.lock().downloads.is_empty(),
        "an existing verified install is re-promoted, not re-downloaded"
    );
    assert!(read(&current).contains("echo v1"));

    update_managed_codex_app_server(&cowork_home, true, &options(&state, Some(v2)))
        .await
        .expect("forced reinstall");
    assert_eq!(state.lock().downloads.len(), 2);
    assert!(read(&current).contains("echo v2"));
    assert!(read(&current.with_file_name("codex-code-mode-host")).contains("host-v2"));
}

#[tokio::test]
async fn checksum_mismatch_fails_closed_without_replacing_existing_install() {
    let home = tempfile::tempdir().unwrap();
    let cowork_home = home.path().join(".cowork");
    let state = start_mock().await;
    let v1 = publish_release(&state, "v1");
    update_managed_codex_app_server(&cowork_home, false, &options(&state, Some(v1.clone())))
        .await
        .expect("initial install");
    let target = CodexRuntimeTarget::host().unwrap();
    let current = managed_codex_current_path(&cowork_home, &target);
    let versioned =
        managed_codex_executable_path(&cowork_home, CODEX_APP_SERVER_MANAGED_VERSION, &target);

    // Tampered upstream bytes, still checked against the v1 digests.
    publish_release(&state, "tampered");
    let err = update_managed_codex_app_server(&cowork_home, true, &options(&state, Some(v1)))
        .await
        .expect_err("tampered assets must be rejected");
    assert!(err.contains("failed checksum verification"), "{err}");
    assert!(read(&current).contains("echo v1"));
    assert!(read(&versioned).contains("echo v1"));
    assert!(read(&current.with_file_name("codex-code-mode-host")).contains("host-v1"));
    assert!(resolve_codex_app_server_status(&cowork_home, &HashMap::new()).available);
}

#[tokio::test]
async fn production_options_verify_against_repo_pinned_checksums() {
    let home = tempfile::tempdir().unwrap();
    let cowork_home = home.path().join(".cowork");
    let state = start_mock().await;
    publish_release(&state, "unpinned");

    let err = update_managed_codex_app_server(&cowork_home, false, &options(&state, None))
        .await
        .expect_err("bytes that do not match the pinned digests must be rejected");
    assert!(err.contains("failed checksum verification"), "{err}");
    let target = CodexRuntimeTarget::host().unwrap();
    assert!(!managed_codex_current_path(&cowork_home, &target).exists());
    assert!(
        !managed_codex_executable_path(&cowork_home, CODEX_APP_SERVER_MANAGED_VERSION, &target)
            .exists()
    );
    assert!(!resolve_codex_app_server_status(&cowork_home, &HashMap::new()).available);
}

#[tokio::test]
async fn missing_release_asset_reports_ts_error() {
    let home = tempfile::tempdir().unwrap();
    let cowork_home = home.path().join(".cowork");
    let state = start_mock().await;
    let checksums = publish_release(&state, "v1");
    let app_server_asset = CodexRuntimeTarget::host()
        .unwrap()
        .asset_name("codex-app-server")
        .unwrap();
    state.lock().assets.remove(&app_server_asset);

    let err =
        update_managed_codex_app_server(&cowork_home, false, &options(&state, Some(checksums)))
            .await
            .expect_err("missing asset");
    assert_eq!(
        err,
        format!("Codex app-server release did not include required asset {app_server_asset}.")
    );
}

/// Minimal JSON-RPC app-server: answers the handshake and completes one turn with "Done.".
const MINIMAL_APP_SERVER: &str = r#"
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "thread/start") {
    send({ id: msg.id, result: { thread: { id: "thr-1" } } });
  } else if (msg.method === "turn/start") {
    send({ id: msg.id, result: { turn: { id: "turn-1" } } });
    const params = { threadId: "thr-1", turnId: "turn-1" };
    send({ method: "item/agentMessage/delta", params: { ...params, itemId: "a1", delta: "Done." } });
    send({ method: "turn/completed", params: { threadId: "thr-1", turn: { id: "turn-1", status: "completed" } } });
  } else if (msg.id !== undefined && msg.method) {
    send({ id: msg.id, result: {} });
  }
});
"#;

fn node_binary() -> std::path::PathBuf {
    std::env::split_paths(&std::env::var_os("PATH").unwrap())
        .map(|dir| dir.join("node"))
        .find(|p| p.is_file())
        .expect("node on PATH")
}

async fn run_codex_turn(
    home: &Path,
    install: CodexRuntimeInstallOptions,
) -> Result<cowork_providers::ProviderStepResult, cowork_inference::ProviderTransportError> {
    use cowork_inference::{
        CanonicalMessage, ContentBlock, MessageRole, ProviderOpaqueMeta, RequestPolicy, StepBudget,
    };
    use cowork_providers::ProviderTransport;
    use cowork_providers::codex_app_server::CodexAppServerTransport;

    let workspace = home.join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    // No system `codex` on PATH, so only the managed runtime can serve the turn.
    let mut env = HashMap::new();
    env.insert(
        "PATH".to_owned(),
        home.join("empty-bin").to_string_lossy().into_owned(),
    );
    env.insert("HOME".to_owned(), home.to_string_lossy().into_owned());
    let mut transport = CodexAppServerTransport::with_env(env);
    transport.install_options = Some(install);
    let mut opts = serde_json::Map::new();
    opts.insert("cwd".into(), json!(workspace.to_string_lossy()));
    opts.insert(
        "coworkHome".into(),
        json!(home.join(".cowork").to_string_lossy()),
    );
    transport
        .stream_step(
            cowork_providers::ProviderStepRequest {
                model_id: "gpt-5.6-sol".into(),
                base_url: None,
                api_key: None,
                extra_headers: HashMap::new(),
                system_prompt: "Instructions".into(),
                messages: vec![CanonicalMessage {
                    id: "u1".into(),
                    role: MessageRole::User,
                    content: vec![ContentBlock::Text {
                        text: "hi".into(),
                        phase: None,
                        citations: Vec::new(),
                        provider_meta: ProviderOpaqueMeta::default(),
                    }],
                    phase: None,
                    provider: None,
                    api: None,
                    model: None,
                    stop_reason: None,
                    provider_meta: ProviderOpaqueMeta::default(),
                    created_at: "2026-11-02T00:00:00Z".into(),
                }],
                tools: Vec::new(),
                authorized_tool_names: None,
                provider_options: opts,
                continuation: None,
                policy: RequestPolicy::default(),
                turn_id: "turn-install".into(),
            },
            &StepBudget::new(60_000, None),
            &mut |_| {},
        )
        .await
}

#[tokio::test]
async fn first_codex_turn_installs_the_missing_managed_runtime() {
    let home = tempfile::tempdir().unwrap();
    let home = home.path();
    let cowork_home = home.join(".cowork");
    let script = home.join("app_server.mjs");
    std::fs::write(&script, MINIMAL_APP_SERVER).unwrap();
    let state = start_mock().await;
    let body = format!(
        "#!/bin/sh\nexec '{}' '{}' \"$@\"\n",
        node_binary().display(),
        script.display()
    );
    let checksums = publish_release_with(&state, "turn", body);
    assert!(!resolve_codex_app_server_status(&cowork_home, &HashMap::new()).available);

    // Tampered (unpinned) bytes fail the turn with the install error and install nothing.
    let err = run_codex_turn(home, options(&state, None))
        .await
        .expect_err("unverified runtime must not run");
    assert!(
        err.message
            .contains("Failed to install the Cowork-managed Codex runtime")
            && err.message.contains("failed checksum verification"),
        "{}",
        err.message
    );
    assert!(!resolve_codex_app_server_status(&cowork_home, &HashMap::new()).available);

    let result = run_codex_turn(home, options(&state, Some(checksums)))
        .await
        .expect("turn runs on the freshly installed runtime");
    assert!(result.assistant.content.iter().any(
        |b| matches!(b, cowork_inference::ContentBlock::Text { text, .. } if text == "Done.")
    ));
    let status = resolve_codex_app_server_status(&cowork_home, &HashMap::new());
    assert_eq!(status.source, "managed");
    assert_eq!(status.pin_matches_current, Some(true));

    // Later turns reuse the installed runtime without downloading again.
    state.lock().downloads.clear();
    run_codex_turn(home, options(&state, None))
        .await
        .expect("installed runtime is reused");
    assert!(state.lock().downloads.is_empty());
}
