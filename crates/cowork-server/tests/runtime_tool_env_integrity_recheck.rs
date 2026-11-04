//! The tool environment a turn snapshots (`effective_tool_env`) re-verifies the managed runtime
//! before wiring its executables in (TS `prepareTurnToolEnv`): an untouched runtime keeps its
//! overlay through the attestation fast path, and a runtime tampered with after startup
//! verification is refused, so its PATH/env no longer reach tools.

use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use cowork_config::canonicalize_sync;
use cowork_env::{
    RuntimeInstallOptions, TrustedKeyRing, attestation_sidecar_path, build_signed_v1_zip_fixture,
    install_v1_zip_runtime, resolve_host_asset,
};
use cowork_server::ServerOptions;
use ed25519_dalek::SigningKey;

fn write_executable(path: &Path, body: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, body).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

fn install_signed_runtime(
    root: &Path,
    home: &Path,
) -> (cowork_env::PreparedRuntime, TrustedKeyRing) {
    let staging = root.join("staging");
    write_executable(
        &staging.join("dependencies/node/bin/node"),
        "#!/bin/sh\necho v22.12.0\n",
    );
    write_executable(
        &staging.join("dependencies/python/bin/python3"),
        "#!/bin/sh\necho ok\n",
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

    let asset = resolve_host_asset().unwrap();
    let key_id = "test-srv-recheck-key";
    let signing_key = SigningKey::from_bytes(&[0x5a_u8; 32]);
    let mut ring = TrustedKeyRing::with_official_defaults();
    ring.insert_verifying_key(key_id, signing_key.verifying_key());
    let zip_path = root.join("runtime.zip");
    build_signed_v1_zip_fixture(
        &staging,
        "2026-06-22",
        &asset,
        key_id,
        &signing_key,
        &zip_path,
    )
    .unwrap();
    let installed = install_v1_zip_runtime(
        &zip_path,
        &RuntimeInstallOptions {
            homedir: home.to_owned(),
            trusted_keys: ring.clone(),
            expected_version: Some("2026-06-22".to_owned()),
            expected_archive_sha256: None,
            force: false,
            keep_versions: 2,
            on_progress: None,
        },
    )
    .unwrap();
    (installed, ring)
}

fn path_entries(env: &HashMap<String, String>) -> Vec<String> {
    env.get("PATH")
        .map(|p| p.split(':').map(str::to_owned).collect())
        .unwrap_or_default()
}

#[tokio::test]
async fn a_runtime_tampered_after_startup_is_dropped_from_the_tool_env() {
    let tmp = tempfile::tempdir().unwrap();
    let root = canonicalize_sync(tmp.path());
    let home = root.join("home");
    let workspace = root.join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let (runtime, ring) = install_signed_runtime(&root, &home);
    let runtime_dir = runtime.root_dir.to_string_lossy().into_owned();

    let server = cowork_server::start_server_with_trusted_keys(
        ServerOptions {
            working_directory: workspace,
            host: "127.0.0.1".to_owned(),
            port: 0,
            yolo: false,
            mobile_h3: false,
            mobile_h3_host: "127.0.0.1".to_owned(),
            mobile_h3_port: 0,
            homedir: Some(home),
            built_in_dir: None,
            env: HashMap::from([
                ("COWORK_RUNTIME_ALLOW_NETWORK".to_owned(), "0".to_owned()),
                ("COWORK_BOOTSTRAP_DEFAULT_SKILLS".to_owned(), "0".to_owned()),
                ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
            ]),
        },
        Some(ring),
    )
    .await
    .unwrap();
    let rt = server.runtime();
    rt.wait_for_startup_ready().await;
    assert!(rt.startup_snapshot().ready, "{:?}", rt.startup_snapshot());

    // Verified at startup: the overlay is wired in, and re-checking it takes the attestation
    // fast path (a full verification would rewrite the sidecar).
    let sidecar = attestation_sidecar_path(&runtime.root_dir);
    let sidecar_mtime = std::fs::metadata(&sidecar).unwrap().modified().unwrap();
    for _ in 0..3 {
        let env = rt.effective_tool_env();
        assert_eq!(env.get("COWORK_RUNTIME_DIR"), Some(&runtime_dir));
        assert!(
            path_entries(&env)
                .iter()
                .any(|e| Path::new(e).starts_with(&runtime.root_dir)),
            "{env:?}"
        );
    }
    assert_eq!(
        std::fs::metadata(&sidecar).unwrap().modified().unwrap(),
        sidecar_mtime,
        "an untouched runtime must not be re-hashed per turn"
    );

    // Replace the managed interpreter after startup verification.
    let python = &runtime.paths.python;
    std::fs::set_permissions(python, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::write(python, "#!/bin/sh\necho tampered\n").unwrap();

    for _ in 0..2 {
        let env = rt.effective_tool_env();
        assert!(
            !env.keys().any(|k| k.starts_with("COWORK_RUNTIME_")),
            "refused runtime env leaked: {env:?}"
        );
        assert!(
            !path_entries(&env)
                .iter()
                .any(|e| Path::new(e).starts_with(&runtime.root_dir)),
            "refused runtime still on PATH: {env:?}"
        );
        assert!(path_entries(&env).iter().any(|e| e == "/usr/bin"));
    }
    server.shutdown().await;
}
