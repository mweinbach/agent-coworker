// Runtime fixtures use POSIX executables and modes, so this suite only runs on Unix hosts.
#![cfg(unix)]

//! `ensure_cowork_runtime_ready` must target `COWORK_RUNTIME_VERSION`, else the bundled
//! `DEFAULT_COWORK_RUNTIME_VERSION`, and reuse an installed runtime only when it matches. An older
//! runtime left behind in `current.json` by a previous app release is only a recovery fallback
//! (network bootstrap disabled, or installing the target failed), matching TS `ensureReady.ts`.

use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use cowork_config::canonicalize_sync;
use cowork_env::{
    DEFAULT_COWORK_RUNTIME_VERSION, EnsureRuntimeOptions, PreparedRuntime, RuntimeInstallOptions,
    TrustedKeyRing, build_signed_v1_zip_fixture, ensure_cowork_runtime_ready,
    install_v1_zip_runtime, read_current_pointer, resolve_host_asset, runtime_asset_file_name,
};
use ed25519_dalek::SigningKey;
use parking_lot::Mutex;
use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const STALE_VERSION: &str = "2026-01-01";
const REPOSITORY: &str = "acme/cowork-runtime";
const RELEASE_TAG: &str = "target-release";

struct Fixture {
    _tmp: TempDir,
    root: PathBuf,
    home: PathBuf,
    staging: PathBuf,
    asset: String,
    key_id: String,
    signing_key: SigningKey,
    trusted_keys: TrustedKeyRing,
}

fn write_executable(path: &Path, body: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, body).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

fn fixture(prefix: &str) -> Fixture {
    assert_ne!(STALE_VERSION, DEFAULT_COWORK_RUNTIME_VERSION);
    let tmp = tempfile::Builder::new().prefix(prefix).tempdir().unwrap();
    let root = canonicalize_sync(tmp.path());
    let staging = root.join("staging");
    write_executable(
        &staging.join("dependencies/node/bin/node"),
        "#!/bin/bash\necho v22.12.0\n",
    );
    write_executable(
        &staging.join("dependencies/python/bin/python3"),
        "#!/bin/bash\necho Python 3.12.0\n",
    );
    write_executable(
        &staging.join("dependencies/bin/uv"),
        "#!/bin/bash\necho uv 0.5.0\n",
    );
    std::fs::create_dir_all(staging.join("cowork/node-resolver")).unwrap();
    std::fs::write(
        staging.join("cowork/node-resolver/register.mjs"),
        "export const ok = true;\n",
    )
    .unwrap();
    std::fs::create_dir_all(staging.join("node_modules/@oai/artifact-tool")).unwrap();
    std::fs::write(
        staging.join("node_modules/@oai/artifact-tool/index.js"),
        "module.exports = {};\n",
    )
    .unwrap();

    let key_id = "test-runtime-key-1".to_owned();
    let signing_key = SigningKey::from_bytes(&[0x42_u8; 32]);
    let mut trusted_keys = TrustedKeyRing::with_official_defaults();
    trusted_keys.insert_verifying_key(key_id.clone(), signing_key.verifying_key());
    Fixture {
        home: root.join("home"),
        staging,
        asset: resolve_host_asset().unwrap(),
        root,
        _tmp: tmp,
        key_id,
        signing_key,
        trusted_keys,
    }
}

impl Fixture {
    fn build_zip(&self, version: &str) -> PathBuf {
        let zip_path = self.root.join(format!("rt-{version}.zip"));
        build_signed_v1_zip_fixture(
            &self.staging,
            version,
            &self.asset,
            &self.key_id,
            &self.signing_key,
            &zip_path,
        )
        .unwrap();
        zip_path
    }

    /// Installs `version` and activates it in `current.json`.
    fn install(&self, version: &str) -> PreparedRuntime {
        install_v1_zip_runtime(
            &self.build_zip(version),
            &RuntimeInstallOptions {
                homedir: self.home.clone(),
                trusted_keys: self.trusted_keys.clone(),
                expected_version: Some(version.to_owned()),
                expected_archive_sha256: None,
                force: false,
                keep_versions: 10,
                on_progress: None,
            },
        )
        .unwrap()
    }

    fn current_version(&self) -> Option<String> {
        read_current_pointer(&self.home).map(|p| p.version)
    }

    async fn ensure(&self, env: HashMap<String, String>) -> cowork_env::Result<PreparedRuntime> {
        ensure_cowork_runtime_ready(EnsureRuntimeOptions {
            homedir: self.home.clone(),
            env,
            trusted_keys: self.trusted_keys.clone(),
            on_progress: None,
        })
        .await
    }
}

/// Network-enabled env without `COWORK_RUNTIME_VERSION`, pointed at `base_url`.
fn online_env(base_url: &str) -> HashMap<String, String> {
    HashMap::from([
        ("COWORK_RUNTIME_ALLOW_NETWORK".to_owned(), "1".to_owned()),
        (
            "COWORK_RUNTIME_REPOSITORY".to_owned(),
            REPOSITORY.to_owned(),
        ),
        (
            "COWORK_RUNTIME_RELEASE_TAG".to_owned(),
            RELEASE_TAG.to_owned(),
        ),
        ("COWORK_RUNTIME_BASE_URL".to_owned(), base_url.to_owned()),
    ])
}

/// Serves `archive` (if any) plus its `.sha256` at the release route and records every path.
async fn serve_release(
    asset: &str,
    archive: Option<Vec<u8>>,
) -> (String, Arc<Mutex<Vec<String>>>, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let file_name = runtime_asset_file_name(asset);
    let zip_route = format!("/{REPOSITORY}/releases/download/{RELEASE_TAG}/{file_name}");
    let sha_route = format!("{zip_route}.sha256");
    let sha_body = archive.as_ref().map(|bytes| {
        use sha2::Digest;
        format!(
            "{} *{file_name}\n",
            hex::encode(sha2::Sha256::digest(bytes))
        )
        .into_bytes()
    });
    let requests = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&requests);
    let server = tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let mut buf = [0_u8; 4096];
            let n = stream.read(&mut buf).await.unwrap_or(0);
            let path = String::from_utf8_lossy(&buf[..n])
                .lines()
                .next()
                .and_then(|l| l.split_whitespace().nth(1))
                .unwrap_or("")
                .to_owned();
            seen.lock().push(path.clone());
            let body = match (&archive, &sha_body) {
                (Some(zip), _) if path == zip_route => Some(zip.clone()),
                (_, Some(sha)) if path == sha_route => Some(sha.clone()),
                _ => None,
            };
            let response = match body {
                Some(body) => {
                    let mut out = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    )
                    .into_bytes();
                    out.extend_from_slice(&body);
                    out
                }
                None => b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    .to_vec(),
            };
            let _ = stream.write_all(&response).await;
            let _ = stream.shutdown().await;
        }
    });
    (format!("http://{addr}"), requests, server)
}

#[tokio::test]
async fn stale_current_pointer_with_downloads_enabled_installs_the_bundled_default() {
    let f = fixture("cowork-rt-stale-online-");
    f.install(STALE_VERSION);
    assert_eq!(f.current_version().as_deref(), Some(STALE_VERSION));

    let archive = std::fs::read(f.build_zip(DEFAULT_COWORK_RUNTIME_VERSION)).unwrap();
    let (base_url, requests, server) = serve_release(&f.asset, Some(archive)).await;
    let prepared = f
        .ensure(online_env(&base_url))
        .await
        .expect("download and install the bundled default runtime");
    server.abort();

    assert_eq!(prepared.version, DEFAULT_COWORK_RUNTIME_VERSION);
    assert_eq!(
        f.current_version().as_deref(),
        Some(DEFAULT_COWORK_RUNTIME_VERSION)
    );
    assert!(
        !requests.lock().is_empty(),
        "the stale runtime must not short-circuit the download"
    );
}

#[tokio::test]
async fn stale_current_pointer_is_a_fallback_when_the_download_fails() {
    let f = fixture("cowork-rt-stale-dl-fail-");
    let stale = f.install(STALE_VERSION);

    let (base_url, requests, server) = serve_release(&f.asset, None).await;
    let prepared = f
        .ensure(online_env(&base_url))
        .await
        .expect("fall back to the installed runtime when the download fails");
    server.abort();

    let file_name = runtime_asset_file_name(&f.asset);
    assert!(
        requests
            .lock()
            .iter()
            .any(|p| p.contains(RELEASE_TAG) && p.contains(&file_name)),
        "the target runtime download must be attempted first: {:?}",
        requests.lock()
    );
    assert_eq!(prepared.version, STALE_VERSION);
    assert_eq!(prepared.root_dir, stale.root_dir);
    assert_eq!(f.current_version().as_deref(), Some(STALE_VERSION));
}

#[tokio::test]
async fn stale_current_pointer_is_a_fallback_when_downloads_are_disabled() {
    let f = fixture("cowork-rt-stale-offline-");
    let stale = f.install(STALE_VERSION);

    let prepared = f
        .ensure(HashMap::from([(
            "COWORK_RUNTIME_ALLOW_NETWORK".to_owned(),
            "0".to_owned(),
        )]))
        .await
        .expect("fall back to the installed runtime when network bootstrap is disabled");
    assert_eq!(prepared.version, STALE_VERSION);
    assert_eq!(prepared.root_dir, stale.root_dir);
}

#[tokio::test]
async fn matching_current_pointer_is_reused_without_downloading() {
    let f = fixture("cowork-rt-matching-");
    let current = f.install(DEFAULT_COWORK_RUNTIME_VERSION);

    let (base_url, requests, server) = serve_release(&f.asset, None).await;
    let prepared = f
        .ensure(online_env(&base_url))
        .await
        .expect("reuse the installed target runtime");
    server.abort();

    assert_eq!(prepared.version, DEFAULT_COWORK_RUNTIME_VERSION);
    assert_eq!(prepared.root_dir, current.root_dir);
    assert!(
        requests.lock().is_empty(),
        "a matching runtime must not trigger a download: {:?}",
        requests.lock()
    );
}

#[tokio::test]
async fn installed_target_runtime_is_preferred_and_activated_over_a_stale_pointer() {
    let f = fixture("cowork-rt-installed-target-");
    let target = f.install(DEFAULT_COWORK_RUNTIME_VERSION);
    f.install(STALE_VERSION);
    assert_eq!(f.current_version().as_deref(), Some(STALE_VERSION));

    let prepared = f
        .ensure(HashMap::from([(
            "COWORK_RUNTIME_ALLOW_NETWORK".to_owned(),
            "0".to_owned(),
        )]))
        .await
        .expect("use the installed target runtime");
    assert_eq!(prepared.version, DEFAULT_COWORK_RUNTIME_VERSION);
    assert_eq!(prepared.root_dir, target.root_dir);
    assert_eq!(
        f.current_version().as_deref(),
        Some(DEFAULT_COWORK_RUNTIME_VERSION),
        "the target runtime is re-activated in current.json"
    );
}

#[tokio::test]
async fn explicit_runtime_version_overrides_the_bundled_default() {
    let f = fixture("cowork-rt-explicit-version-");
    let stale = f.install(STALE_VERSION);

    let (base_url, requests, server) = serve_release(&f.asset, None).await;
    let mut env = online_env(&base_url);
    env.insert(
        "COWORK_RUNTIME_VERSION".to_owned(),
        STALE_VERSION.to_owned(),
    );
    let prepared = f.ensure(env).await.expect("reuse the pinned runtime");
    server.abort();

    assert_eq!(prepared.root_dir, stale.root_dir);
    assert!(requests.lock().is_empty(), "{:?}", requests.lock());
}
