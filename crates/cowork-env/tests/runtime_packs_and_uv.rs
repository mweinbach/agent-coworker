use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use cowork_config::canonicalize_sync;
use cowork_env::{
    EnsureRuntimeOptions, RuntimeBootstrapPhase, RuntimeConsumerLease, RuntimeInstallOptions,
    RuntimePackId, StartupProgressEvent, TrustedKeyRing, UvManagerConfig, UvPythonManager,
    build_signed_v1_zip_fixture, build_signed_v2_pack_tar_zst_fixture,
    compute_tree_state_digest_parallel, ensure_cowork_runtime_ready, format_ndjson_progress_event,
    install_v1_zip_runtime, install_v2_pack_set, prune_installed_runtimes, resolve_host_asset,
    verify_installed_runtime, with_runtime_bootstrap_lock,
};
use ed25519_dalek::SigningKey;
use parking_lot::Mutex;
use tempfile::TempDir;

fn canonical_temp_dir(prefix: &str) -> (TempDir, PathBuf) {
    let dir = tempfile::Builder::new()
        .prefix(prefix)
        .tempdir_in("/private/tmp")
        .expect("create tempdir in /private/tmp");
    let canonical = canonicalize_sync(dir.path());
    (dir, canonical)
}

fn test_keypair() -> (String, SigningKey, TrustedKeyRing) {
    let key_id = "test-runtime-key-1".to_owned();
    let signing_key = SigningKey::from_bytes(&[0x42_u8; 32]);
    let mut ring = TrustedKeyRing::with_official_defaults();
    ring.insert_verifying_key(key_id.clone(), signing_key.verifying_key());
    (key_id, signing_key, ring)
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

/// Populates a minimal working local runtime staging tree (with working `node`, `python3`, `uv`,
/// `soffice`, `pdftoppm`, and a sample offline `.whl` wheel) for deterministic offline tests.
fn populate_full_runtime_staging(staging: &Path) {
    write_executable(
        &staging.join("dependencies/node/bin/node"),
        "#!/bin/bash\necho \"v22.12.0\"\n",
    );
    write_executable(
        &staging.join("dependencies/python/bin/python3"),
        "#!/bin/bash\nexec /usr/bin/python3 \"$@\"\n",
    );
    // Functional local `uv` fixture supporting `uv venv` and `uv pip install` completely offline!
    let uv_script = r#"#!/bin/bash
set -euo pipefail
mkdir -p "${UV_CACHE_DIR:?UV_CACHE_DIR must be set}"
echo "cached-touch" > "${UV_CACHE_DIR}/last-command.txt"

subcmd="${1:-}"
shift || true

if [[ "$subcmd" == "venv" ]]; then
  py="/usr/bin/python3"
  venv_dir=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --python) py="$2"; shift 2 ;;
      --cache-dir) mkdir -p "$2"; shift 2 ;;
      --link-mode) shift 2 ;;
      --no-project|--seed|--quiet|-q) shift ;;
      -*) shift ;;
      *) venv_dir="$1"; shift ;;
    esac
  done
  mkdir -p "${venv_dir}/bin" "${venv_dir}/lib/site-packages"
  cat > "${venv_dir}/pyvenv.cfg" <<EOF
home = $(dirname "$py")
include-system-site-packages = false
version = 3.9.6
EOF
  cat > "${venv_dir}/bin/python3" <<EOF
#!/bin/bash
export PYTHONPATH="${venv_dir}/lib/site-packages:\${PYTHONPATH:-}"
exec /usr/bin/python3 "\$@"
EOF
  chmod 0755 "${venv_dir}/bin/python3"
  ln -sf python3 "${venv_dir}/bin/python"
  exit 0
elif [[ "$subcmd" == "pip" && "${1:-}" == "install" ]]; then
  shift
  py=""
  find_links="${UV_FIND_LINKS:-}"
  pkgs=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --python) py="$2"; shift 2 ;;
      --find-links|-f) find_links="$2"; shift 2 ;;
      --cache-dir) mkdir -p "$2"; shift 2 ;;
      --link-mode) shift 2 ;;
      --offline|--no-index|--quiet|-q) shift ;;
      -*) shift ;;
      *) pkgs+=("$1"); shift ;;
    esac
  done
  venv_root="$(cd "$(dirname "$py")/.." && pwd)"
  site_pkgs="${venv_root}/lib/site-packages"
  mkdir -p "$site_pkgs" "${UV_CACHE_DIR}/wheels-cache"
  for pkg in "${pkgs[@]}"; do
    pkg_mod="${pkg//-/_}"
    if [[ -n "$find_links" && -f "${find_links}/${pkg_mod}-1.0.0-py3-none-any.whl" ]]; then
      cp "${find_links}/${pkg_mod}-1.0.0-py3-none-any.whl" "${UV_CACHE_DIR}/wheels-cache/"
      /usr/bin/python3 -m zipfile -e "${find_links}/${pkg_mod}-1.0.0-py3-none-any.whl" "$site_pkgs"
    else
      mkdir -p "${site_pkgs}/${pkg_mod}"
      echo "VALUE = 'installed-${pkg_mod}'" > "${site_pkgs}/${pkg_mod}/__init__.py"
    fi
  done
  exit 0
fi

echo "unsupported uv invocation: $subcmd $*" >&2
exit 2
"#;
    write_executable(&staging.join("dependencies/bin/uv"), uv_script);
    write_executable(
        &staging.join("dependencies/bin/soffice"),
        "#!/bin/bash\necho \"LibreOffice 26.2.3.2\"\n",
    );
    write_executable(
        &staging.join("dependencies/libreoffice/program/soffice"),
        "#!/bin/bash\necho \"LibreOffice 26.2.3.2\"\n",
    );
    write_executable(
        &staging.join("dependencies/poppler/bin/pdftoppm"),
        "#!/bin/bash\necho \"pdftoppm 24.08.0\"\n",
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

    // Build a tiny deterministic Python `.whl` (which is a standard zip archive) in `wheels/`.
    std::fs::create_dir_all(staging.join("wheels")).unwrap();
    let wheel_path = staging.join("wheels/demo_pkg-1.0.0-py3-none-any.whl");
    {
        let f = std::fs::File::create(&wheel_path).unwrap();
        let mut zw = zip::ZipWriter::new(f);
        let opts = zip::write::SimpleFileOptions::default();
        zw.start_file("demo_pkg/__init__.py", opts).unwrap();
        std::io::Write::write_all(&mut zw, b"GREETING = 'hello-from-offline-wheelhouse'\n")
            .unwrap();
        zw.finish().unwrap();
    }
}

#[test]
fn v1_zip_runtime_install_verifies_ed25519_and_rayon_digests_and_seals_readonly() {
    let (_tmp, root) = canonical_temp_dir("cowork-v1-zip-");
    let home = root.join("home");
    let staging = root.join("staging");
    populate_full_runtime_staging(&staging);

    let asset = resolve_host_asset().expect("supported host asset");
    let (key_id, signing_key, trusted_keys) = test_keypair();
    let zip_path = root.join("cowork-runtime-v1.zip");
    build_signed_v1_zip_fixture(
        &staging,
        "2026-06-22",
        &asset,
        &key_id,
        &signing_key,
        &zip_path,
    )
    .expect("build signed v1 zip");

    let events: Arc<Mutex<Vec<StartupProgressEvent>>> = Arc::new(Mutex::new(Vec::new()));
    let events_sink = events.clone();

    let installed = install_v1_zip_runtime(
        &zip_path,
        &RuntimeInstallOptions {
            homedir: home.clone(),
            trusted_keys: trusted_keys.clone(),
            expected_version: Some("2026-06-22".to_owned()),
            expected_archive_sha256: None,
            force: false,
            keep_versions: 2,
            on_progress: Some(Arc::new(move |evt| {
                events_sink.lock().push(evt);
            })),
        },
    )
    .expect("install signed v1 zip");

    assert_eq!(installed.version, "2026-06-22");
    assert!(installed.root_dir.is_dir());

    // Sealed read-only check: both directories and files must strip write bits (`mode & 0o222 == 0`).
    let dir_mode = std::fs::metadata(&installed.root_dir)
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(
        dir_mode & 0o222,
        0,
        "installed runtime root dir must be sealed read-only, mode={dir_mode:o}"
    );
    let node_mode = std::fs::metadata(&installed.paths.node)
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(node_mode & 0o222, 0, "node binary must be sealed read-only");
    assert_ne!(node_mode & 0o111, 0, "node binary must remain executable");

    // Attempting to create a new file inside sealed runtime must fail with PermissionDenied (unless running as root).
    if unsafe { libc::geteuid() } != 0 {
        let write_attempt = std::fs::write(installed.root_dir.join("tamper.txt"), b"nope");
        assert!(
            write_attempt.is_err(),
            "sealed runtime directory must reject file creation"
        );
    }

    // Repeat verification hits cached `(inode, mtime, size)` state and still passes full verify.
    let verified_fast =
        verify_installed_runtime(&installed.root_dir, &trusted_keys, false).expect("cached verify");
    let verified_full =
        verify_installed_runtime(&installed.root_dir, &trusted_keys, true).expect("full verify");
    assert_eq!(verified_fast.version, verified_full.version);

    // NDJSON progress events emitted (`installing` -> `ready`).
    let recorded = events.lock();
    assert!(
        recorded
            .iter()
            .any(|e| e.progress.phase == RuntimeBootstrapPhase::Installing),
        "expected installing phase, got {recorded:?}"
    );
    assert!(
        recorded
            .iter()
            .any(|e| e.progress.phase == RuntimeBootstrapPhase::Ready),
        "expected ready phase, got {recorded:?}"
    );
    let ndjson = format_ndjson_progress_event(&recorded[0]);
    let parsed: serde_json::Value = serde_json::from_str(&ndjson).unwrap();
    assert_eq!(parsed["type"], "server_startup_progress");
    assert_eq!(parsed["component"], "cowork-runtime");
}

#[test]
fn v1_zip_rejects_bad_signature_tampered_bytes_and_traversal_entries_fail_closed() {
    let (_tmp, root) = canonical_temp_dir("cowork-v1-tamper-");
    let home = root.join("home");
    let staging = root.join("staging");
    populate_full_runtime_staging(&staging);

    let asset = resolve_host_asset().expect("supported host asset");
    let (key_id, signing_key, _trusted_keys) = test_keypair();
    let wrong_ring = TrustedKeyRing::with_official_defaults(); // does NOT contain `test-runtime-key-1`

    let zip_path = root.join("signed.zip");
    build_signed_v1_zip_fixture(
        &staging,
        "2026-06-22",
        &asset,
        &key_id,
        &signing_key,
        &zip_path,
    )
    .unwrap();

    // 1. Untrusted / wrong key ring -> rejected before activation!
    let err = install_v1_zip_runtime(
        &zip_path,
        &RuntimeInstallOptions {
            homedir: home.clone(),
            trusted_keys: wrong_ring,
            expected_version: None,
            expected_archive_sha256: None,
            force: false,
            keep_versions: 2,
            on_progress: None,
        },
    )
    .expect_err("untrusted signature key must be rejected");
    assert!(
        err.to_string().to_lowercase().contains("key")
            || err.to_string().to_lowercase().contains("signature"),
        "unexpected error: {err}"
    );
    assert!(
        !home.join(".cowork/runtime/current.json").exists(),
        "failed install must never write current.json"
    );

    // 2. Single-byte tamper inside a zip member -> rejected by parallel rayon digest verifier!
    let (_, _, trusted_keys) = test_keypair();
    let tampered_zip = root.join("tampered.zip");
    {
        let src_file = std::fs::File::open(&zip_path).unwrap();
        let mut archive = zip::ZipArchive::new(src_file).unwrap();
        let dst_file = std::fs::File::create(&tampered_zip).unwrap();
        let mut writer = zip::ZipWriter::new(dst_file);
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).unwrap();
            let name = entry.name().unwrap().into_owned();
            let opts = zip::write::SimpleFileOptions::default()
                .unix_permissions(entry.unix_mode().unwrap_or(0o644));
            if entry.is_dir() {
                writer.add_directory(&name, opts).unwrap();
            } else {
                let mut buf = Vec::new();
                std::io::Read::read_to_end(&mut entry, &mut buf).unwrap();
                if name == "cowork/node-resolver/register.mjs" {
                    buf.push(b'\n'); // 1-byte tamper!
                }
                writer.start_file(&name, opts).unwrap();
                std::io::Write::write_all(&mut writer, &buf).unwrap();
            }
        }
        writer.finish().unwrap();
    }

    let tamper_err = install_v1_zip_runtime(
        &tampered_zip,
        &RuntimeInstallOptions {
            homedir: home.clone(),
            trusted_keys: trusted_keys.clone(),
            expected_version: None,
            expected_archive_sha256: None,
            force: false,
            keep_versions: 2,
            on_progress: None,
        },
    )
    .expect_err("1-byte tampered archive must be rejected");
    assert!(
        tamper_err.to_string().to_lowercase().contains("digest")
            || tamper_err.to_string().to_lowercase().contains("size")
            || tamper_err.to_string().to_lowercase().contains("integrity"),
        "unexpected tamper error: {tamper_err}"
    );
    assert!(!home.join(".cowork/runtime/current.json").exists());

    // 3. Path traversal `../escape.sh` zip entry -> rejected during extraction!
    let traversal_zip = root.join("traversal.zip");
    {
        let dst = std::fs::File::create(&traversal_zip).unwrap();
        let mut writer = zip::ZipWriter::new(dst);
        writer
            .start_file("../escape.txt", zip::write::SimpleFileOptions::default())
            .unwrap();
        std::io::Write::write_all(&mut writer, b"pwned").unwrap();
        writer.finish().unwrap();
    }
    let trav_err = install_v1_zip_runtime(
        &traversal_zip,
        &RuntimeInstallOptions {
            homedir: home.clone(),
            trusted_keys,
            expected_version: None,
            expected_archive_sha256: None,
            force: false,
            keep_versions: 2,
            on_progress: None,
        },
    )
    .expect_err("path traversal zip entry must be rejected");
    assert!(!root.join("escape.txt").exists(), "traversal file escaped!");
    assert!(
        trav_err.to_string().to_lowercase().contains("path")
            || trav_err.to_string().to_lowercase().contains("archive")
            || trav_err.to_string().to_lowercase().contains("entry"),
        "unexpected traversal error: {trav_err}"
    );
}

#[tokio::test]
async fn v2_modular_tar_zst_packs_and_uv_ephemeral_venv_work_offline_without_mutating_sealed_runtime()
 {
    let (_tmp, root) = canonical_temp_dir("cowork-v2-uv-");
    let home = root.join("home");
    let staging = root.join("staging");
    populate_full_runtime_staging(&staging);

    let asset = resolve_host_asset().expect("supported host asset");
    let (key_id, signing_key, trusted_keys) = test_keypair();

    // Build all three modular v2 `.tar.zst` packs (`core`, `python-wheels`, `libreoffice`).
    let core_pack = root.join("cowork-runtime-core.tar.zst");
    let py_pack = root.join("cowork-runtime-python-wheels.tar.zst");
    let lo_pack = root.join("cowork-runtime-libreoffice.tar.zst");

    build_signed_v2_pack_tar_zst_fixture(
        &staging,
        RuntimePackId::Core,
        "2026-07-01",
        &asset,
        &key_id,
        &signing_key,
        &core_pack,
    )
    .expect("build core pack");
    build_signed_v2_pack_tar_zst_fixture(
        &staging,
        RuntimePackId::PythonWheels,
        "2026-07-01",
        &asset,
        &key_id,
        &signing_key,
        &py_pack,
    )
    .expect("build python-wheels pack");
    build_signed_v2_pack_tar_zst_fixture(
        &staging,
        RuntimePackId::LibreOffice,
        "2026-07-01",
        &asset,
        &key_id,
        &signing_key,
        &lo_pack,
    )
    .expect("build libreoffice pack");

    // Verify tampered `.tar.zst` pack is rejected fail-closed before installing valid set.
    let tampered_pack = root.join("tampered-core.tar.zst");
    {
        // Re-compress tar stream with 1-byte mutation in a file entry while keeping original signature.
        let raw_zst = std::fs::read(&core_pack).unwrap();
        let tar_bytes = zstd::decode_all(raw_zst.as_slice()).unwrap();
        let needle = b"export const ok = true;";
        let replacement = b"export const ok = false"; // exact same byte length (23 bytes)!
        let pos = tar_bytes
            .windows(needle.len())
            .position(|w| w == needle)
            .expect("find register.mjs payload in tar");
        let mut mutated_tar = tar_bytes;
        mutated_tar[pos..pos + needle.len()].copy_from_slice(replacement);
        // Recompute tar header checksum if needed? Wait: changing file DATA blocks in tar does NOT affect header checksum!
        let recompressed = zstd::encode_all(mutated_tar.as_slice(), 3).unwrap();
        std::fs::write(&tampered_pack, recompressed).unwrap();
    }
    let bad_res = install_v2_pack_set(
        &[(RuntimePackId::Core, tampered_pack.as_path())],
        &RuntimeInstallOptions {
            homedir: home.clone(),
            trusted_keys: trusted_keys.clone(),
            expected_version: Some("2026-07-01".to_owned()),
            expected_archive_sha256: None,
            force: false,
            keep_versions: 2,
            on_progress: None,
        },
    );
    assert!(
        bad_res.is_err(),
        "tampered v2 .tar.zst pack must be rejected by parallel blake3/sha256 verifier"
    );

    // Install valid 3-pack modular v2 `.tar.zst` bundle (`core`, `python-wheels`, `libreoffice`).
    let prepared = install_v2_pack_set(
        &[
            (RuntimePackId::Core, core_pack.as_path()),
            (RuntimePackId::PythonWheels, py_pack.as_path()),
            (RuntimePackId::LibreOffice, lo_pack.as_path()),
        ],
        &RuntimeInstallOptions {
            homedir: home.clone(),
            trusted_keys: trusted_keys.clone(),
            expected_version: Some("2026-07-01".to_owned()),
            expected_archive_sha256: None,
            force: false,
            keep_versions: 2,
            on_progress: None,
        },
    )
    .expect("install v2 modular pack set");

    assert_eq!(
        prepared.installed_packs,
        vec![
            "core".to_owned(),
            "python-wheels".to_owned(),
            "libreoffice".to_owned()
        ]
    );
    assert!(prepared.paths.soffice.as_ref().unwrap().is_file());
    assert!(prepared.paths.uv.as_ref().unwrap().is_file());
    assert!(prepared.paths.wheelhouse.as_ref().unwrap().is_dir());

    // Snapshot the sealed runtime's tree state digest BEFORE `uv` venv creation & wheel installation.
    let tree_digest_before =
        compute_tree_state_digest_parallel(&prepared.root_dir).expect("digest before uv");

    let cowork_home = home.join(".cowork");
    let uv_mgr = UvPythonManager::new(UvManagerConfig {
        cowork_home: cowork_home.clone(),
        uv_binary: prepared.paths.uv.clone(),
        base_python: prepared.paths.python.clone(),
        wheelhouse_dir: prepared.paths.wheelhouse.clone(),
        offline: true,
        timeout: Duration::from_secs(15),
    });

    assert_eq!(uv_mgr.cache_dir(), cowork_home.join("cache/uv"));

    // Provision an ephemeral `.venv` and install `demo_pkg` from the offline sealed wheelhouse!
    let ephemeral = uv_mgr
        .provision_ephemeral_venv(&["demo-pkg"])
        .await
        .expect("provision ephemeral uv venv + install offline wheel");
    let venv_dir_snapshot = ephemeral.venv_dir().to_path_buf();
    assert!(venv_dir_snapshot.is_dir());
    assert!(uv_mgr.cache_dir().join("wheels-cache").is_dir());

    // Execute Python inside the ephemeral `.venv` to prove `demo_pkg` imports cleanly.
    let output = tokio::process::Command::new(ephemeral.python_executable())
        .args(["-c", "import demo_pkg; print(demo_pkg.GREETING)"])
        .output()
        .await
        .expect("run ephemeral python");
    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&output.stdout).trim(),
        "hello-from-offline-wheelhouse"
    );

    // Verify the sealed base runtime tree was 100% UNMUTATED (zero `.pyc`, zero new files, zero mtime changes).
    let tree_digest_after =
        compute_tree_state_digest_parallel(&prepared.root_dir).expect("digest after uv");
    assert_eq!(
        tree_digest_before, tree_digest_after,
        "uv venv/pip install must NEVER mutate the sealed base runtime tree!"
    );

    // Dropping/cleaning up the ephemeral venv removes its temporary directory cleanly.
    ephemeral.cleanup().expect("cleanup ephemeral venv");
    assert!(!venv_dir_snapshot.exists());
}

#[tokio::test]
async fn fs4_bootstrap_lock_serializes_concurrent_writers_emits_waiting_and_honors_consumer_leases_and_offline_guard()
 {
    let (_tmp, root) = canonical_temp_dir("cowork-fs4-lock-");
    let home = root.join("home");
    std::fs::create_dir_all(&home).unwrap();

    // 1. Offline guard: `COWORK_RUNTIME_ALLOW_NETWORK=0` fails closed when no local runtime is present!
    let mut env = HashMap::new();
    env.insert("COWORK_RUNTIME_ALLOW_NETWORK".to_owned(), "0".to_owned());
    let offline_err = ensure_cowork_runtime_ready(EnsureRuntimeOptions {
        homedir: home.clone(),
        env,
        trusted_keys: TrustedKeyRing::with_official_defaults(),
        on_progress: None,
    })
    .await
    .expect_err("must fail closed offline when runtime missing");
    assert!(
        offline_err.to_string().to_lowercase().contains("network")
            || offline_err.to_string().to_lowercase().contains("offline"),
        "unexpected offline error: {offline_err}"
    );

    // 2. Concurrent `fs4` lock contention emits `waiting` NDJSON event and serializes access.
    let progress_events: Arc<Mutex<Vec<StartupProgressEvent>>> = Arc::new(Mutex::new(Vec::new()));
    let entered_first = Arc::new(tokio::sync::Notify::new());
    let release_first = Arc::new(tokio::sync::Notify::new());

    let home1 = home.clone();
    let entered_clone = entered_first.clone();
    let release_clone = release_first.clone();
    let t1 = tokio::spawn(async move {
        with_runtime_bootstrap_lock(
            &home1,
            "2026-06-22",
            Duration::from_secs(5),
            None,
            move || {
                entered_clone.notify_one();
                // Hold the OS file lock briefly while t2 contends.
                std::thread::sleep(Duration::from_millis(120));
                release_clone.notify_waiters();
                Ok::<_, cowork_env::EnvError>("first")
            },
        )
        .await
    });

    entered_first.notified().await;
    let home2 = home.clone();
    let events_sink = progress_events.clone();
    let t2 = tokio::spawn(async move {
        with_runtime_bootstrap_lock(
            &home2,
            "2026-06-22",
            Duration::from_secs(5),
            Some(Arc::new(move |evt| {
                events_sink.lock().push(evt);
            })),
            || Ok::<_, cowork_env::EnvError>("second"),
        )
        .await
    });

    assert_eq!(t1.await.unwrap().unwrap(), "first");
    assert_eq!(t2.await.unwrap().unwrap(), "second");
    assert!(
        progress_events
            .lock()
            .iter()
            .any(|e| e.progress.phase == RuntimeBootstrapPhase::Waiting),
        "contended second writer must emit `waiting` startup progress event"
    );

    // 3. Consumer lease prevents pruning of a leased old runtime version!
    let staging = root.join("staging");
    populate_full_runtime_staging(&staging);
    let asset = resolve_host_asset().unwrap();
    let (key_id, signing_key, trusted_keys) = test_keypair();

    for ver in ["2026-01-01", "2026-02-01", "2026-03-01"] {
        let zip_path = root.join(format!("rt-{ver}.zip"));
        build_signed_v1_zip_fixture(&staging, ver, &asset, &key_id, &signing_key, &zip_path)
            .unwrap();
        // Install without auto-pruning (`keep_versions: 10`) first, then hold a lease on `2026-01-01`.
        install_v1_zip_runtime(
            &zip_path,
            &RuntimeInstallOptions {
                homedir: home.clone(),
                trusted_keys: trusted_keys.clone(),
                expected_version: Some(ver.to_owned()),
                expected_archive_sha256: None,
                force: false,
                keep_versions: 10,
                on_progress: None,
            },
        )
        .unwrap();
    }

    let v1_dir = home.join(".cowork/runtime/2026-01-01");
    let v2_dir = home.join(".cowork/runtime/2026-02-01");
    let v3_dir = home.join(".cowork/runtime/2026-03-01");
    let lease = RuntimeConsumerLease::acquire(&v1_dir).expect("acquire consumer lease on v1");

    // Prune keeping 2 versions (`v3` is active current, `v2` is 2nd newest, `v1` would be pruned EXCEPT it has an active lease!).
    prune_installed_runtimes(&home, 2).expect("prune with active lease");
    assert!(
        v1_dir.exists(),
        "actively leased runtime 2026-01-01 must NOT be pruned!"
    );
    assert!(v2_dir.exists());
    assert!(v3_dir.exists());

    drop(lease);
    prune_installed_runtimes(&home, 2).expect("prune after lease drop");
    assert!(
        !v1_dir.exists(),
        "unleased old runtime 2026-01-01 must be unsealed and pruned cleanly once lease drops"
    );
    assert!(v2_dir.exists());
    assert!(v3_dir.exists());
}
