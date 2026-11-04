//! Review-round regressions: bounded `pdftoppm` rasters, hardlink rejection and fingerprinting,
//! the legacy `.bootstrap.lock` directory barrier across upgrades/downgrades, and executable
//! checks inside the rollback-protected promotion step.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use cowork_config::canonicalize_sync;
use cowork_env::soffice::{PDFTOPPM_MAX_LONG_EDGE_PX, build_pdftoppm_args};
use cowork_env::{
    EnvError, IntegrityEntryKind, IntegrityFileEntry, PdftoppmJobRequest,
    compute_tree_state_digest_parallel, hash_regular_file, validate_pdftoppm_args,
    verify_integrity_tree_parallel,
};

fn tempdir(prefix: &str) -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::Builder::new().prefix(prefix).tempdir().unwrap();
    let root = canonicalize_sync(tmp.path());
    (tmp, root)
}

fn pdftoppm_request(first: Option<u32>, last: Option<u32>, dpi: u32) -> PdftoppmJobRequest {
    PdftoppmJobRequest {
        pdf_path: PathBuf::from("/in/deck.pdf"),
        output_dir: PathBuf::from("/out"),
        dpi,
        first_page: first,
        last_page: last,
        cwd: PathBuf::from("/out"),
        env: Default::default(),
        timeout: None,
    }
}

#[test]
fn pdftoppm_args_bound_the_raster_long_edge_like_the_ts_preview() {
    assert_eq!(PDFTOPPM_MAX_LONG_EDGE_PX, 1600);
    for dpi in [72, 150, 600] {
        let args = build_pdftoppm_args(
            &pdftoppm_request(Some(1), Some(201), dpi),
            Path::new("/in/deck.pdf"),
            Path::new("/out/page"),
        );
        assert_eq!(
            args,
            [
                "-png",
                "-scale-to",
                "1600",
                "-f",
                "1",
                "-l",
                "201",
                "/in/deck.pdf",
                "/out/page"
            ],
            "dpi={dpi}: the physical page size must never size the bitmap"
        );
        assert!(!args.iter().any(|a| a == "-r"), "dpi={dpi}: {args:?}");
        validate_pdftoppm_args(&args).expect("generated args validate");
    }

    let no_range = build_pdftoppm_args(
        &pdftoppm_request(None, None, 150),
        Path::new("/in/deck.pdf"),
        Path::new("/out/page"),
    );
    assert_eq!(
        no_range,
        ["-png", "-scale-to", "1600", "/in/deck.pdf", "/out/page"]
    );
}

#[test]
fn pdftoppm_validation_rejects_unbounded_resolution_flags() {
    let owned = |args: &[&str]| args.iter().map(|a| (*a).to_owned()).collect::<Vec<_>>();
    for bad in [
        owned(&["-png", "-r", "150", "/in.pdf", "/out/page"]),
        owned(&["-png", "-r", "150", "-scale-to", "1600", "/in.pdf", "/out"]),
        owned(&["-png", "-scale-to", "20000", "/in.pdf", "/out/page"]),
        owned(&["-png", "-scale-to", "0", "/in.pdf", "/out/page"]),
        owned(&[
            "-png",
            "-scale-to",
            "1600",
            "-scale-to",
            "800",
            "/in.pdf",
            "/o",
        ]),
        owned(&[
            "-png",
            "-scale-to",
            "1600",
            "-scale-to-x",
            "9000",
            "/in.pdf",
            "/o",
        ]),
        owned(&["-png", "-rx", "600", "-scale-to", "1600", "/in.pdf", "/o"]),
        owned(&["-png", "-scale-to"]),
    ] {
        let err = validate_pdftoppm_args(&bad).expect_err(&format!("{bad:?} must be rejected"));
        assert!(
            matches!(err, EnvError::SofficeForbiddenFlag(_)),
            "{bad:?}: {err:?}"
        );
    }
}

fn file_entry(root: &Path, rel: &str) -> IntegrityFileEntry {
    let (sha256, blake3, size) = hash_regular_file(&root.join(rel)).unwrap();
    IntegrityFileEntry {
        path: rel.to_owned(),
        kind: IntegrityEntryKind::File,
        size,
        sha256: Some(sha256),
        blake3: Some(blake3),
    }
}

/// Runs on every platform: on Windows this exercises `GetFileInformationByHandle` link counts.
#[test]
fn hardlinked_runtime_files_are_rejected_and_change_the_tree_fingerprint() {
    let (_tmp, root) = tempdir("cowork-hardlink-");
    let tree = root.join("runtime");
    std::fs::create_dir_all(tree.join("bin")).unwrap();
    std::fs::write(tree.join("bin/tool"), b"signed bytes\n").unwrap();
    let files = vec![file_entry(&tree, "bin/tool")];

    verify_integrity_tree_parallel(&tree, &files, &[], &HashSet::new())
        .expect("single-link tree verifies");
    let before = compute_tree_state_digest_parallel(&tree).unwrap();

    // A writable alias outside the tree shares the signed file's contents.
    std::fs::hard_link(tree.join("bin/tool"), root.join("outside-alias")).unwrap();
    let err = verify_integrity_tree_parallel(&tree, &files, &[], &HashSet::new())
        .expect_err("a second link must be rejected");
    assert!(
        err.to_string()
            .contains("Hardlinked runtime file is forbidden"),
        "{err}"
    );
    let after = compute_tree_state_digest_parallel(&tree).unwrap();
    assert_ne!(
        before, after,
        "adding a link must invalidate cached attestations"
    );

    std::fs::remove_file(root.join("outside-alias")).unwrap();
    verify_integrity_tree_parallel(&tree, &files, &[], &HashSet::new())
        .expect("verifies again once the alias is gone");
}

#[cfg(unix)]
mod unix {
    use std::os::unix::fs::PermissionsExt;
    use std::process::{Child, Command};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::time::{Duration, Instant};

    use cowork_env::installer::{
        legacy_bootstrap_lock_path, override_runtime_executable_probe,
        skip_runtime_executable_probe,
    };
    use cowork_env::{
        EnvError, PreparedRuntime, RuntimeBootstrapPhase, RuntimeInstallOptions, RuntimePackId,
        StartupProgressEvent, TrustedKeyRing, bootstrap_lock_path, build_signed_v1_zip_fixture,
        build_signed_v2_pack_tar_zst_fixture, install_v1_zip_runtime, install_v2_pack_set,
        read_current_pointer, resolve_host_asset, runtime_root_dir, verify_installed_runtime,
        with_runtime_bootstrap_lock_sync,
    };
    use ed25519_dalek::SigningKey;

    use super::*;

    const OLD: &str = "2026-05-01";
    const NEW: &str = "2026-06-22";

    fn write_executable(path: &Path, body: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn keys() -> (String, SigningKey, TrustedKeyRing) {
        let key_id = "test-review-round-key".to_owned();
        let signing_key = SigningKey::from_bytes(&[0x5a_u8; 32]);
        let mut ring = TrustedKeyRing::with_official_defaults();
        ring.insert_verifying_key(key_id.clone(), signing_key.verifying_key());
        (key_id, signing_key, ring)
    }

    /// Stand-in executables that pass every default executable check (the conversion writes a
    /// PDF), unless `python_fails_imports` makes `python3 -c ...` exit 1 like a release missing
    /// a native library.
    fn populate(staging: &Path, marker: &str, python_fails_imports: bool) {
        write_executable(
            &staging.join("dependencies/node/bin/node"),
            &format!("#!/bin/sh\necho v22.12.0-{marker}\n"),
        );
        let python = if python_fails_imports {
            "#!/bin/sh\nif [ \"$1\" = \"-c\" ]; then echo 'ImportError: libxml2.so.2' >&2; exit 1; fi\necho Python 3.12.0\n"
        } else {
            "#!/bin/sh\necho Python 3.12.0\n"
        };
        write_executable(&staging.join("dependencies/python/bin/python3"), python);
        write_executable(
            &staging.join("dependencies/bin/soffice"),
            r#"#!/bin/sh
for a in "$@"; do [ "$a" = "--version" ] && { echo "LibreOffice 26.2.3.2"; exit 0; }; done
outdir=""; input=""
while [ $# -gt 0 ]; do
  case "$1" in
    --outdir) outdir="$2"; shift 2 ;;
    --convert-to) shift 2 ;;
    -*) shift ;;
    *) input="$1"; shift ;;
  esac
done
stem="$(basename "$input")"; stem="${stem%.*}"
printf '%%PDF-1.4\n%%%%EOF\n' > "$outdir/$stem.pdf"
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
    }

    struct Fx {
        _tmp: tempfile::TempDir,
        root: PathBuf,
        home: PathBuf,
        key_id: String,
        signing_key: SigningKey,
        trusted_keys: TrustedKeyRing,
    }

    impl Fx {
        fn new(prefix: &str) -> Self {
            let (tmp, root) = tempdir(prefix);
            let (key_id, signing_key, trusted_keys) = keys();
            Self {
                home: root.join("home"),
                root,
                _tmp: tmp,
                key_id,
                signing_key,
                trusted_keys,
            }
        }

        fn opts(&self, version: &str, force: bool) -> RuntimeInstallOptions {
            RuntimeInstallOptions {
                homedir: self.home.clone(),
                trusted_keys: self.trusted_keys.clone(),
                expected_version: Some(version.to_owned()),
                expected_archive_sha256: None,
                force,
                keep_versions: 3,
                on_progress: None,
            }
        }

        fn v1_zip(&self, version: &str, marker: &str, python_fails: bool) -> PathBuf {
            let staging = self.root.join(format!("staging-v1-{version}-{marker}"));
            populate(&staging, marker, python_fails);
            let zip = self.root.join(format!("runtime-{version}-{marker}.zip"));
            build_signed_v1_zip_fixture(
                &staging,
                version,
                &resolve_host_asset().unwrap(),
                &self.key_id,
                &self.signing_key,
                &zip,
            )
            .unwrap();
            zip
        }

        fn v2_packs(&self, version: &str, marker: &str) -> Vec<(RuntimePackId, PathBuf)> {
            let staging = self.root.join(format!("staging-v2-{version}-{marker}"));
            populate(&staging, marker, false);
            [RuntimePackId::Core, RuntimePackId::PythonWheels]
                .into_iter()
                .map(|pack| {
                    let out = self
                        .root
                        .join(format!("{version}-{marker}-{}.tar.zst", pack.as_str()));
                    build_signed_v2_pack_tar_zst_fixture(
                        &staging,
                        pack,
                        version,
                        &resolve_host_asset().unwrap(),
                        &self.key_id,
                        &self.signing_key,
                        &out,
                    )
                    .unwrap();
                    (pack, out)
                })
                .collect()
        }

        fn current_version(&self) -> Option<String> {
            read_current_pointer(&self.home).map(|p| p.version)
        }

        fn node_bytes(&self, version: &str) -> String {
            std::fs::read_to_string(
                runtime_root_dir(&self.home)
                    .join(version)
                    .join("dependencies/node/bin/node"),
            )
            .unwrap()
        }

        fn assert_no_stray_trees(&self) {
            let stray: Vec<String> = std::fs::read_dir(runtime_root_dir(&self.home))
                .unwrap()
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| n.starts_with(".replaced-") || n.starts_with(".staging-"))
                .collect();
            assert!(stray.is_empty(), "stray trees {stray:?}");
        }
    }

    fn failing_probe(calls: Arc<AtomicUsize>) -> cowork_env::installer::RuntimeExecutableProbe {
        Arc::new(move |runtime: &PreparedRuntime| {
            calls.fetch_add(1, Ordering::SeqCst);
            assert!(runtime.paths.node.is_file(), "probe sees the promoted tree");
            Err(EnvError::Integrity(
                "probe: node: dyld: Library not loaded".to_owned(),
            ))
        })
    }

    fn as_refs(packs: &[(RuntimePackId, PathBuf)]) -> Vec<(RuntimePackId, &Path)> {
        packs.iter().map(|(id, p)| (*id, p.as_path())).collect()
    }

    #[test]
    fn failing_probe_rolls_back_a_monolithic_upgrade_and_keeps_the_previous_current() {
        let fx = Fx::new("cowork-probe-v1-");
        let skip = skip_runtime_executable_probe(&fx.home);
        install_v1_zip_runtime(&fx.v1_zip(OLD, "old", false), &fx.opts(OLD, false)).unwrap();
        drop(skip);
        assert_eq!(fx.current_version().as_deref(), Some(OLD));

        let calls = Arc::new(AtomicUsize::new(0));
        let _probe = override_runtime_executable_probe(&fx.home, failing_probe(calls.clone()));
        let err = install_v1_zip_runtime(&fx.v1_zip(NEW, "new", false), &fx.opts(NEW, false))
            .expect_err("a failing probe must reject the upgrade");
        assert!(err.to_string().contains("Library not loaded"), "{err}");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(fx.current_version().as_deref(), Some(OLD));
        assert!(!runtime_root_dir(&fx.home).join(NEW).exists());
        verify_installed_runtime(
            &runtime_root_dir(&fx.home).join(OLD),
            &fx.trusted_keys,
            true,
        )
        .expect("previous runtime still verifies");
        fx.assert_no_stray_trees();
    }

    #[test]
    fn failing_probe_restores_the_replaced_tree_on_a_forced_reinstall() {
        let fx = Fx::new("cowork-probe-force-");
        let skip = skip_runtime_executable_probe(&fx.home);
        install_v1_zip_runtime(&fx.v1_zip(NEW, "first", false), &fx.opts(NEW, false)).unwrap();
        drop(skip);
        let original = fx.node_bytes(NEW);

        let calls = Arc::new(AtomicUsize::new(0));
        let _probe = override_runtime_executable_probe(&fx.home, failing_probe(calls.clone()));
        install_v1_zip_runtime(&fx.v1_zip(NEW, "second", false), &fx.opts(NEW, true))
            .expect_err("a failing probe must reject the replacement");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(fx.node_bytes(NEW), original, "the working tree is restored");
        assert_eq!(fx.current_version().as_deref(), Some(NEW));
        verify_installed_runtime(
            &runtime_root_dir(&fx.home).join(NEW),
            &fx.trusted_keys,
            true,
        )
        .expect("restored runtime verifies");
        fx.assert_no_stray_trees();
    }

    #[test]
    fn failing_probe_rolls_back_a_v2_pack_set_and_keeps_the_previous_current() {
        let fx = Fx::new("cowork-probe-v2-");
        let skip = skip_runtime_executable_probe(&fx.home);
        let old = fx.v2_packs(OLD, "old");
        install_v2_pack_set(&as_refs(&old), &fx.opts(OLD, false)).unwrap();
        let first_new = fx.v2_packs(NEW, "first");
        install_v2_pack_set(&as_refs(&first_new), &fx.opts(NEW, false)).unwrap();
        drop(skip);
        let original = fx.node_bytes(NEW);

        let calls = Arc::new(AtomicUsize::new(0));
        let _probe = override_runtime_executable_probe(&fx.home, failing_probe(calls.clone()));
        let replacement = fx.v2_packs(NEW, "second");
        install_v2_pack_set(&as_refs(&replacement), &fx.opts(NEW, true))
            .expect_err("forced v2 replacement must be rejected");
        assert_eq!(fx.node_bytes(NEW), original);
        assert_eq!(fx.current_version().as_deref(), Some(NEW));

        // A brand-new version through the pack path leaves the previous pointer untouched too.
        std::fs::remove_file(runtime_root_dir(&fx.home).join("current.json")).unwrap();
        let skip = skip_runtime_executable_probe(&fx.home);
        install_v2_pack_set(&as_refs(&old), &fx.opts(OLD, true)).unwrap();
        drop(skip);
        let _probe = override_runtime_executable_probe(&fx.home, failing_probe(calls.clone()));
        let newer = "2026-07-15";
        install_v2_pack_set(&as_refs(&fx.v2_packs(newer, "x")), &fx.opts(newer, false))
            .expect_err("new v2 version must be rejected");
        assert_eq!(fx.current_version().as_deref(), Some(OLD));
        assert!(!runtime_root_dir(&fx.home).join(newer).exists());
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        fx.assert_no_stray_trees();
    }

    /// No override: the default TS-parity checks run the stand-in executables for real.
    #[test]
    fn default_executable_checks_run_the_runtime_and_reject_broken_python_imports() {
        let fx = Fx::new("cowork-probe-default-");
        let installed = install_v1_zip_runtime(&fx.v1_zip(OLD, "ok", false), &fx.opts(OLD, false))
            .expect("working stand-ins pass every default check");
        assert!(installed.paths.soffice.is_some(), "soffice smoke ran");
        assert_eq!(fx.current_version().as_deref(), Some(OLD));

        let err = install_v1_zip_runtime(&fx.v1_zip(NEW, "broken", true), &fx.opts(NEW, false))
            .expect_err("python imports failing must reject the runtime");
        let msg = err.to_string();
        assert!(msg.contains("executable verification"), "{msg}");
        assert!(msg.contains("import docx"), "{msg}");
        assert!(msg.contains("libxml2"), "{msg}");
        assert_eq!(fx.current_version().as_deref(), Some(OLD));
        assert!(!runtime_root_dir(&fx.home).join(NEW).exists());
        fx.assert_no_stray_trees();
    }

    #[test]
    fn default_checks_reject_a_soffice_that_converts_nothing() {
        let fx = Fx::new("cowork-probe-soffice-");
        let staging = fx.root.join("staging");
        populate(&staging, "s", false);
        write_executable(
            &staging.join("dependencies/bin/soffice"),
            "#!/bin/sh\necho LibreOffice 26.2.3.2\n",
        );
        let zip = fx.root.join("rt.zip");
        build_signed_v1_zip_fixture(
            &staging,
            NEW,
            &resolve_host_asset().unwrap(),
            &fx.key_id,
            &fx.signing_key,
            &zip,
        )
        .unwrap();
        let err = install_v1_zip_runtime(&zip, &fx.opts(NEW, false)).expect_err("no PDF");
        assert!(err.to_string().contains("non-empty PDF"), "{err}");
        assert_eq!(fx.current_version(), None);
    }

    // ---- Legacy `.bootstrap.lock` directory barrier ----------------------------------------

    fn spawn_sleeper() -> Child {
        Command::new("sleep")
            .arg("60")
            .spawn()
            .expect("spawn sleep")
    }

    fn dead_pid() -> u32 {
        let mut child = Command::new("true").spawn().unwrap();
        let pid = child.id();
        child.wait().unwrap();
        pid
    }

    /// An owner record in the previous TS installer's format (`bootstrapLock.ts`).
    fn write_ts_barrier(home: &Path, pid: u32) -> PathBuf {
        let legacy = legacy_bootstrap_lock_path(home);
        std::fs::create_dir_all(&legacy).unwrap();
        let owner = serde_json::json!({
            "protocol": "cowork-runtime-sqlite-v1",
            "pid": pid,
            "token": "11111111-2222-3333-4444-555555555555",
            "startedAt": chrono::Utc::now().to_rfc3339(),
            "updatedAt": "sqlite-transaction-owned",
        });
        std::fs::write(legacy.join("owner.json"), format!("{owner}\n")).unwrap();
        legacy
    }

    #[test]
    fn new_lock_is_distinct_from_the_legacy_directory_barrier() {
        let home = Path::new("/h");
        assert_ne!(bootstrap_lock_path(home), legacy_bootstrap_lock_path(home));
        assert!(legacy_bootstrap_lock_path(home).ends_with(".cowork/runtime/.bootstrap.lock"));
    }

    #[test]
    fn upgrade_reclaims_a_stale_legacy_barrier_and_publishes_a_directory_while_held() {
        let (_tmp, root) = tempdir("cowork-legacy-stale-");
        let home = root.join("home");
        let legacy = write_ts_barrier(&home, dead_pid());

        let seen =
            with_runtime_bootstrap_lock_sync(&home, "test", Duration::from_secs(5), None, || {
                let meta = std::fs::symlink_metadata(&legacy).unwrap();
                assert!(
                    meta.is_dir(),
                    "the legacy path stays a directory while held"
                );
                let owner: serde_json::Value =
                    serde_json::from_str(&std::fs::read_to_string(legacy.join("owner.json"))?)
                        .unwrap();
                Ok(owner)
            })
            .expect("a dead owner's barrier is reclaimed");
        assert_eq!(seen["pid"], std::process::id());
        assert_ne!(
            seen["protocol"], "cowork-runtime-sqlite-v1",
            "the old installer must refuse (never adopt) a live Rust barrier"
        );
        assert!(!legacy.exists(), "barrier removed on release");
        assert!(bootstrap_lock_path(&home).is_file());
    }

    #[test]
    fn upgrade_removes_a_pre_release_regular_lock_file_at_the_legacy_path() {
        let (_tmp, root) = tempdir("cowork-legacy-file-");
        let home = root.join("home");
        let legacy = legacy_bootstrap_lock_path(&home);
        std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        std::fs::write(&legacy, b"").unwrap();

        with_runtime_bootstrap_lock_sync(&home, "test", Duration::from_secs(5), None, || {
            assert!(std::fs::symlink_metadata(&legacy).unwrap().is_dir());
            Ok(())
        })
        .unwrap();
        assert!(
            !legacy.exists(),
            "no regular file is left at the legacy path"
        );
    }

    #[test]
    fn upgrade_refuses_while_a_live_legacy_barrier_is_held() {
        let (_tmp, root) = tempdir("cowork-legacy-live-");
        let home = root.join("home");
        let mut sleeper = spawn_sleeper();
        let legacy = write_ts_barrier(&home, sleeper.id());
        let before = std::fs::read(legacy.join("owner.json")).unwrap();

        let ran = AtomicBool::new(false);
        let started = Instant::now();
        let err = with_runtime_bootstrap_lock_sync(
            &home,
            "test",
            Duration::from_millis(400),
            None,
            || {
                ran.store(true, Ordering::SeqCst);
                Ok(())
            },
        )
        .expect_err("a live legacy owner must not be overridden");
        sleeper.kill().unwrap();
        sleeper.wait().unwrap();

        assert!(
            matches!(err, EnvError::LockTimeout { ref path } if *path == legacy),
            "{err:?}"
        );
        assert!(started.elapsed() >= Duration::from_millis(400), "it waited");
        assert!(!ran.load(Ordering::SeqCst));
        assert_eq!(
            std::fs::read(legacy.join("owner.json")).unwrap(),
            before,
            "the live barrier is untouched"
        );
    }

    #[test]
    fn upgrade_waits_for_a_live_legacy_barrier_to_go_away_and_reports_waiting() {
        let (_tmp, root) = tempdir("cowork-legacy-wait-");
        let home = root.join("home");
        let mut sleeper = spawn_sleeper();
        let legacy = write_ts_barrier(&home, sleeper.id());

        let release = {
            let legacy = legacy.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(300));
                // The old installer finishes: it unlinks its marker and removes the directory.
                std::fs::remove_file(legacy.join("owner.json")).unwrap();
                std::fs::remove_dir(&legacy).unwrap();
                sleeper.kill().unwrap();
                sleeper.wait().unwrap();
            })
        };
        let waiting = Arc::new(AtomicUsize::new(0));
        let cb: cowork_env::RuntimeProgressCallback = {
            let waiting = waiting.clone();
            Arc::new(move |event: StartupProgressEvent| {
                if event.progress.phase == RuntimeBootstrapPhase::Waiting {
                    waiting.fetch_add(1, Ordering::SeqCst);
                }
            })
        };
        with_runtime_bootstrap_lock_sync(&home, "test", Duration::from_secs(10), Some(&cb), || {
            assert!(std::fs::symlink_metadata(&legacy).unwrap().is_dir());
            Ok(())
        })
        .expect("proceeds once the legacy owner leaves");
        release.join().unwrap();
        assert_eq!(waiting.load(Ordering::SeqCst), 1, "waiting reported once");
        assert!(!legacy.exists());
    }

    #[test]
    fn a_legacy_barrier_still_being_published_is_respected_then_reclaimed_when_abandoned() {
        let (_tmp, root) = tempdir("cowork-legacy-empty-");
        let home = root.join("home");
        let legacy = legacy_bootstrap_lock_path(&home);
        std::fs::create_dir_all(&legacy).unwrap();

        // Freshly created without an owner: an older installer may be mid-publication.
        let err = with_runtime_bootstrap_lock_sync(
            &home,
            "test",
            Duration::from_millis(250),
            None,
            || Ok(()),
        )
        .expect_err("fresh ownerless barrier is respected");
        assert!(matches!(err, EnvError::LockTimeout { .. }), "{err:?}");

        // Long abandoned (an interrupted older install): reclaimed.
        let old = std::time::SystemTime::now() - Duration::from_secs(3600);
        std::fs::File::open(&legacy)
            .unwrap()
            .set_modified(old)
            .unwrap();
        with_runtime_bootstrap_lock_sync(&home, "test", Duration::from_secs(5), None, || Ok(()))
            .expect("abandoned ownerless barrier is reclaimed");
        assert!(!legacy.exists());
    }

    #[test]
    fn a_legacy_barrier_holding_foreign_entries_is_never_removed() {
        let (_tmp, root) = tempdir("cowork-legacy-foreign-");
        let home = root.join("home");
        let legacy = write_ts_barrier(&home, dead_pid());
        std::fs::write(legacy.join("unrelated"), b"keep").unwrap();

        let err = with_runtime_bootstrap_lock_sync(
            &home,
            "test",
            Duration::from_secs(2),
            None,
            || Ok(()),
        )
        .expect_err("non-recursive reclaim refuses foreign entries");
        assert!(matches!(err, EnvError::Lock(_)), "{err:?}");
        assert!(legacy.join("unrelated").is_file());
    }

    /// After a successful upgrade an older installer (rollback) can still create its barrier
    /// directory, and no regular file squats on the legacy path.
    #[test]
    fn downgrade_after_a_successful_install_can_acquire_the_legacy_directory() {
        let fx = Fx::new("cowork-legacy-downgrade-");
        let _skip = skip_runtime_executable_probe(&fx.home);
        install_v1_zip_runtime(&fx.v1_zip(NEW, "n", false), &fx.opts(NEW, false)).unwrap();

        let legacy = legacy_bootstrap_lock_path(&fx.home);
        match std::fs::symlink_metadata(&legacy) {
            Err(err) => assert_eq!(err.kind(), std::io::ErrorKind::NotFound),
            Ok(meta) => assert!(meta.is_dir(), "legacy path must stay a directory"),
        }
        // TS `acquireLegacyBarrier`: `mkdir` + `owner.json` (`wx+`).
        std::fs::create_dir(&legacy).expect("old installer creates its barrier");
        std::fs::write(legacy.join("owner.json"), b"{}").unwrap();
        std::fs::remove_file(legacy.join("owner.json")).unwrap();
        std::fs::remove_dir(&legacy).unwrap();
    }
}
