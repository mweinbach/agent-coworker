use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::Instant;

use cowork_config::canonicalize_sync;
use cowork_env::{
    RuntimeInstallOptions, TrustedKeyRing, build_signed_v1_zip_fixture, install_v1_zip_runtime,
    resolve_host_asset,
};
use cowork_server::{ServerOptions, start_server};
use ed25519_dalek::SigningKey;
use serde_json::{Value, json};
use tempfile::TempDir;

fn canonical_temp_dir(prefix: &str) -> (TempDir, PathBuf) {
    let dir = tempfile::Builder::new()
        .prefix(prefix)
        .tempdir_in("/private/tmp")
        .expect("create tempdir in /private/tmp");
    let canonical = canonicalize_sync(dir.path());
    (dir, canonical)
}

fn write_executable(path: &Path, body: &str) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(path, body).unwrap();
    let mut perms = std::fs::metadata(path).unwrap().permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(path, perms).unwrap();
}

async fn rpc_post(
    client: &reqwest::Client,
    rpc_url: &str,
    client_id: &str,
    body: &Value,
) -> (reqwest::StatusCode, Value) {
    let resp = client
        .post(rpc_url)
        .header("X-Cowork-Client-Id", client_id)
        .json(body)
        .send()
        .await
        .expect("POST /rpc");
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    let val = if text.trim().is_empty() {
        Value::Null
    } else {
        serde_json::from_str(&text).unwrap_or_else(|_| json!({ "raw": text }))
    };
    (status, val)
}

async fn handshake_http_rpc(client: &reqwest::Client, rpc_url: &str, client_id: &str) {
    let (_, init_res) = rpc_post(
        client,
        rpc_url,
        client_id,
        &json!({
            "id": 1,
            "method": "initialize",
            "params": {
                "clientInfo": { "name": "runtime-rpc-test", "version": "1.0.0" },
                "capabilities": { "experimentalApi": true }
            }
        }),
    )
    .await;
    assert!(init_res.get("result").is_some(), "init_res={init_res}");

    let (status, _) = rpc_post(
        client,
        rpc_url,
        client_id,
        &json!({
            "method": "initialized",
            "params": {}
        }),
    )
    .await;
    assert!(status.is_success());
}

#[tokio::test]
async fn runtime_diagnostics_and_unavailable_libreoffice_rpc_match_strict_wire_contract() {
    let (_tmp, root) = canonical_temp_dir("cowork-srv-rt-unavail-");
    let home = root.join("home");
    let workspace = root.join("workspace");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&workspace).unwrap();

    let mut env = HashMap::new();
    env.insert("HOME".to_owned(), home.to_string_lossy().into_owned());
    env.insert(
        "COWORK_HOME_OVERRIDE".to_owned(),
        home.to_string_lossy().into_owned(),
    );
    env.insert("COWORK_DISABLE_RUNTIME".to_owned(), "1".to_owned());
    env.insert("COWORK_RUNTIME_ALLOW_NETWORK".to_owned(), "0".to_owned());
    env.insert("PATH".to_owned(), "/usr/bin:/bin".to_owned());

    let started = Instant::now();
    let server = start_server(ServerOptions {
        working_directory: workspace.clone(),
        host: "127.0.0.1".to_owned(),
        port: 0,
        yolo: false,
        mobile_h3: false,
        mobile_h3_host: "127.0.0.1".to_owned(),
        mobile_h3_port: 0,
        homedir: Some(home.clone()),
        built_in_dir: None,
        env,
    })
    .await
    .expect("start server");
    let cold_boot_ms = started.elapsed().as_millis();
    assert!(
        cold_boot_ms < 500,
        "server startup should never block on LibreOffice/runtime checks: {cold_boot_ms}ms"
    );

    let client = reqwest::Client::new();
    let rpc_url = server.rpc_url().to_owned();
    let cid = "client-rt-1";
    handshake_http_rpc(&client, &rpc_url, cid).await;

    // 1. Strict `cowork/runtime/diagnostics/read` rejects unknown request keys.
    let (_, bad_diag) = rpc_post(
        &client,
        &rpc_url,
        cid,
        &json!({
            "id": 2,
            "method": "cowork/runtime/diagnostics/read",
            "params": { "extra": true }
        }),
    )
    .await;
    assert_eq!(bad_diag["error"]["code"], -32602);

    // 2. Valid `cowork/runtime/diagnostics/read` returns exact strict schema keys.
    let (_, ok_diag) = rpc_post(
        &client,
        &rpc_url,
        cid,
        &json!({
            "id": 3,
            "method": "cowork/runtime/diagnostics/read",
            "params": {}
        }),
    )
    .await;
    let d = &ok_diag["result"]["diagnostics"];
    assert_eq!(d["startup"]["ready"], true);
    assert_eq!(d["sendQueue"]["queuedSends"], 0);
    assert_eq!(d["sendQueue"]["serializationFailures"], 0);
    assert_eq!(d["sendQueue"]["sendFailures"], 0);
    assert_eq!(d["sendQueue"]["externalSinkFailures"], 0);
    assert_eq!(d["sendQueue"]["maxQueueDepth"], 0);
    assert!(d["sendQueue"]["queueDepthByConnection"].is_object());
    assert_eq!(d["journal"]["untrustedThreadCount"], 0);
    assert_eq!(d["journal"]["failedWriteCount"], 0);
    assert_eq!(d["journal"]["droppedEventCount"], 0);
    assert_eq!(d["journal"]["pendingThreadCount"], 0);
    assert!(d["dbLocks"]["waitCount"].is_u64());
    assert!(d["dbLocks"]["maxWaitMs"].is_u64());

    // 3. `cowork/runtime/libreoffice/check` reports `unavailable` cleanly when runtime is disabled.
    let (_, lo_res) = rpc_post(
        &client,
        &rpc_url,
        cid,
        &json!({
            "id": 4,
            "method": "cowork/runtime/libreoffice/check",
            "params": { "smoke": false }
        }),
    )
    .await;
    assert_eq!(lo_res["result"]["status"]["status"], "unavailable");
    assert!(
        lo_res["result"]["status"]["message"]
            .as_str()
            .unwrap_or("")
            .contains("active Cowork runtime")
    );

    server.shutdown().await;
}

#[tokio::test]
async fn runtime_libreoffice_check_succeeds_with_smoke_true_against_verified_sealed_runtime() {
    let (_tmp, root) = canonical_temp_dir("cowork-srv-rt-lo-");
    let home = root.join("home");
    let workspace = root.join("workspace");
    let staging = root.join("staging");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&workspace).unwrap();

    write_executable(
        &staging.join("dependencies/node/bin/node"),
        "#!/bin/bash\necho v22.12.0\n",
    );
    write_executable(
        &staging.join("dependencies/python/bin/python3"),
        "#!/bin/bash\nexec /usr/bin/python3 \"$@\"\n",
    );
    write_executable(
        &staging.join("dependencies/bin/soffice"),
        r#"#!/bin/bash
set -euo pipefail
for arg in "$@"; do
  if [[ "$arg" == "--version" ]]; then
    echo "LibreOffice 26.2.3.2"
    exit 0
  fi
done
outdir=""
input_file=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --outdir) outdir="$2"; shift 2 ;;
    --convert-to) shift 2 ;;
    -*) shift ;;
    *) input_file="$1"; shift ;;
  esac
done
base="$(basename "$input_file")"
stem="${base%.*}"
printf '%%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%%%EOF\n' > "${outdir}/${stem}.pdf"
"#,
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
    let key_id = "test-srv-key-1";
    let signing_key = SigningKey::from_bytes(&[0x77_u8; 32]);
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
            homedir: home.clone(),
            trusted_keys: ring,
            expected_version: Some("2026-06-22".to_owned()),
            expected_archive_sha256: None,
            force: false,
            keep_versions: 2,
            on_progress: None,
        },
    )
    .unwrap();

    let mut env = HashMap::new();
    env.insert("HOME".to_owned(), home.to_string_lossy().into_owned());
    env.insert(
        "COWORK_HOME_OVERRIDE".to_owned(),
        home.to_string_lossy().into_owned(),
    );
    env.insert("COWORK_DISABLE_RUNTIME".to_owned(), "1".to_owned());
    env.insert("COWORK_RUNTIME_ALLOW_NETWORK".to_owned(), "0".to_owned());
    env.insert("PATH".to_owned(), "/usr/bin:/bin".to_owned());
    env.insert(
        "COWORK_RUNTIME_SOFFICE".to_owned(),
        installed
            .paths
            .soffice
            .as_ref()
            .unwrap()
            .to_string_lossy()
            .into_owned(),
    );

    let server = start_server(ServerOptions {
        working_directory: workspace,
        host: "127.0.0.1".to_owned(),
        port: 0,
        yolo: false,
        mobile_h3: false,
        mobile_h3_host: "127.0.0.1".to_owned(),
        mobile_h3_port: 0,
        homedir: Some(home),
        built_in_dir: None,
        env,
    })
    .await
    .expect("start server");

    let client = reqwest::Client::new();
    let rpc_url = server.rpc_url().to_owned();
    let cid = "client-rt-lo";
    handshake_http_rpc(&client, &rpc_url, cid).await;

    // 1. Version-only check (`smoke: false`).
    let (_, ver_res) = rpc_post(
        &client,
        &rpc_url,
        cid,
        &json!({
            "id": 10,
            "method": "cowork/runtime/libreoffice/check",
            "params": { "cwd": "C:/unhydrated-client-cwd", "smoke": false }
        }),
    )
    .await;
    assert_eq!(ver_res["result"]["status"]["status"], "available");
    assert_eq!(ver_res["result"]["status"]["version"], "26.2.3.2");
    assert!(ver_res["result"]["status"].get("smoke").is_none());

    // 2. Sandboxed PDF smoke conversion (`smoke: true`).
    let (_, smoke_res) = rpc_post(
        &client,
        &rpc_url,
        cid,
        &json!({
            "id": 11,
            "method": "cowork/runtime/libreoffice/check",
            "params": { "smoke": true }
        }),
    )
    .await;
    assert_eq!(smoke_res["result"]["status"]["status"], "available");
    assert_eq!(smoke_res["result"]["status"]["smoke"]["ok"], true);
    assert!(
        smoke_res["result"]["status"]["smoke"]["sizeBytes"]
            .as_u64()
            .unwrap_or(0)
            > 10
    );

    server.shutdown().await;
}

#[tokio::test]
async fn background_runtime_bootstrap_is_non_blocking_and_surfaces_redacted_startup_error_on_tampered_dir()
 {
    let (_tmp, root) = canonical_temp_dir("cowork-srv-rt-tamper-");
    let home = root.join("home");
    let workspace = root.join("workspace");
    let broken_rt = root.join("broken-runtime");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::create_dir_all(&broken_rt).unwrap();
    std::fs::write(broken_rt.join("runtime.json"), "{ invalid json").unwrap();

    let mut env = HashMap::new();
    env.insert("HOME".to_owned(), home.to_string_lossy().into_owned());
    env.insert(
        "COWORK_HOME_OVERRIDE".to_owned(),
        home.to_string_lossy().into_owned(),
    );
    env.insert("COWORK_RUNTIME_ALLOW_NETWORK".to_owned(), "0".to_owned());
    env.insert(
        "COWORK_RUNTIME_DIR".to_owned(),
        broken_rt.to_string_lossy().into_owned(),
    );

    let server = start_server(ServerOptions {
        working_directory: workspace,
        host: "127.0.0.1".to_owned(),
        port: 0,
        yolo: false,
        mobile_h3: false,
        mobile_h3_host: "127.0.0.1".to_owned(),
        mobile_h3_port: 0,
        homedir: Some(home),
        built_in_dir: None,
        env,
    })
    .await
    .expect("start server non-blocking even when COWORK_RUNTIME_DIR is broken");

    server.runtime().wait_for_startup_ready().await;

    let client = reqwest::Client::new();
    let rpc_url = server.rpc_url().to_owned();
    let cid = "client-rt-tamper";
    handshake_http_rpc(&client, &rpc_url, cid).await;

    let (_, diag_res) = rpc_post(
        &client,
        &rpc_url,
        cid,
        &json!({
            "id": 20,
            "method": "cowork/runtime/diagnostics/read",
            "params": {}
        }),
    )
    .await;
    let startup = &diag_res["result"]["diagnostics"]["startup"];
    assert_eq!(startup["ready"], true);
    assert!(
        startup["error"]
            .as_str()
            .unwrap_or("")
            .contains("runtime.json"),
        "expected startup.error mentioning broken runtime.json, got {startup}"
    );

    server.shutdown().await;
}
