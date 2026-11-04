//! Promotion safety for modular v2 pack sets: the composed runtime is fully verified before it
//! replaces an installed version, and a failed replacement restores the previous installation
//! (TS `installRuntimeArchiveLocked`: deep-verify staging, rename the old tree to a backup, promote,
//! and rename the backup back on failure).

// Fixtures use Unix modes for executables, matching `runtime_packs_and_uv.rs`.
#![cfg(unix)]

use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};

use cowork_config::canonicalize_sync;
use cowork_env::{
    RuntimeInstallOptions, RuntimePackId, TrustedKeyRing, build_signed_v2_pack_tar_zst_fixture,
    install_v2_pack_set, read_current_pointer, resolve_host_asset, runtime_root_dir,
    verify_installed_runtime,
};
use ed25519_dalek::SigningKey;

const VERSION: &str = "2026-07-01";

fn test_keypair() -> (String, SigningKey, TrustedKeyRing) {
    let key_id = "test-runtime-key-1".to_owned();
    let signing_key = SigningKey::from_bytes(&[0x42_u8; 32]);
    let mut ring = TrustedKeyRing::with_official_defaults();
    ring.insert_verifying_key(key_id.clone(), signing_key.verifying_key());
    (key_id, signing_key, ring)
}

fn write_executable(path: &Path, body: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, body).unwrap();
    let mut perms = std::fs::metadata(path).unwrap().permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(path, perms).unwrap();
}

/// A runtime tree whose `core` pack carries node + the node resolver and whose `python-wheels`
/// pack carries the required Python entrypoint.
fn populate_staging(staging: &Path) {
    write_executable(
        &staging.join("dependencies/node/bin/node"),
        "#!/bin/sh\necho v22.12.0\n",
    );
    write_executable(
        &staging.join("dependencies/python/bin/python3"),
        "#!/bin/sh\necho Python 3.12.0\n",
    );
    write_executable(&staging.join("dependencies/bin/uv"), "#!/bin/sh\nexit 0\n");
    std::fs::create_dir_all(staging.join("cowork/node-resolver")).unwrap();
    std::fs::write(
        staging.join("cowork/node-resolver/register.mjs"),
        "export const ok = true;\n",
    )
    .unwrap();
    std::fs::create_dir_all(staging.join("wheels")).unwrap();
    std::fs::write(staging.join("wheels/README.txt"), "wheelhouse\n").unwrap();
}

struct Fixture {
    _tmp: tempfile::TempDir,
    home: PathBuf,
    core_pack: PathBuf,
    py_pack: PathBuf,
    trusted_keys: TrustedKeyRing,
}

impl Fixture {
    fn new() -> Self {
        let tmp = tempfile::Builder::new()
            .prefix("cowork-v2-promotion")
            .tempdir()
            .unwrap();
        let root = canonicalize_sync(tmp.path());
        let staging = root.join("staging");
        populate_staging(&staging);
        let asset = resolve_host_asset().expect("supported host asset");
        let (key_id, signing_key, trusted_keys) = test_keypair();
        let core_pack = root.join("cowork-runtime-core.tar.zst");
        let py_pack = root.join("cowork-runtime-python-wheels.tar.zst");
        for (pack_id, out) in [
            (RuntimePackId::Core, &core_pack),
            (RuntimePackId::PythonWheels, &py_pack),
        ] {
            build_signed_v2_pack_tar_zst_fixture(
                &staging,
                pack_id,
                VERSION,
                &asset,
                &key_id,
                &signing_key,
                out,
            )
            .expect("build pack");
        }
        Self {
            home: root.join("home"),
            _tmp: tmp,
            core_pack,
            py_pack,
            trusted_keys,
        }
    }

    fn opts(&self, force: bool) -> RuntimeInstallOptions {
        RuntimeInstallOptions {
            homedir: self.home.clone(),
            trusted_keys: self.trusted_keys.clone(),
            expected_version: Some(VERSION.to_owned()),
            expected_archive_sha256: None,
            force,
            keep_versions: 2,
            on_progress: None,
        }
    }

    fn full_set(&self) -> Vec<(RuntimePackId, &Path)> {
        vec![
            (RuntimePackId::Core, self.core_pack.as_path()),
            (RuntimePackId::PythonWheels, self.py_pack.as_path()),
        ]
    }

    fn installed_dir(&self) -> PathBuf {
        runtime_root_dir(&self.home).join(VERSION)
    }

    /// The installed runtime still fully verifies as the complete two-pack composition.
    fn assert_complete_install_intact(&self, context: &str) {
        let verified = verify_installed_runtime(&self.installed_dir(), &self.trusted_keys, true)
            .unwrap_or_else(|err| panic!("{context}: installed runtime no longer verifies: {err}"));
        assert_eq!(
            verified.installed_packs,
            ["core", "python-wheels"],
            "{context}"
        );
        assert!(verified.paths.python.is_file(), "{context}");
        assert_eq!(
            read_current_pointer(&self.home).map(|p| p.version),
            Some(VERSION.to_owned()),
            "{context}"
        );
    }

    /// No staging or backup trees are left beside the installed versions.
    fn assert_no_leftovers(&self, context: &str) {
        let leftovers: Vec<String> = std::fs::read_dir(runtime_root_dir(&self.home))
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| name != VERSION && is_tree_leftover(name))
            .collect();
        assert!(leftovers.is_empty(), "{context}: leftovers {leftovers:?}");
    }
}

fn is_tree_leftover(name: &str) -> bool {
    !(name.ends_with(".json") || name.ends_with(".lock"))
}

#[test]
fn core_only_pack_set_does_not_replace_a_complete_installation() {
    let fx = Fixture::new();
    install_v2_pack_set(&fx.full_set(), &fx.opts(false)).expect("install complete pack set");
    fx.assert_complete_install_intact("after initial install");

    // Every pack in a core-only set passes its own integrity checks, but the composition lacks
    // the required Python entrypoint, so it must be rejected before touching the installation.
    for force in [false, true] {
        let err = install_v2_pack_set(
            &[(RuntimePackId::Core, fx.core_pack.as_path())],
            &fx.opts(force),
        )
        .expect_err("core-only composition must fail verification");
        assert!(
            err.to_string().contains("entrypoint"),
            "force={force}: unexpected error {err}"
        );
        fx.assert_complete_install_intact(&format!("after core-only install (force={force})"));
        fx.assert_no_leftovers(&format!("after core-only install (force={force})"));
    }
}

#[test]
fn forced_reinstall_of_a_complete_set_replaces_the_installation_without_leftovers() {
    let fx = Fixture::new();
    install_v2_pack_set(&fx.full_set(), &fx.opts(false)).expect("install complete pack set");

    let reused = install_v2_pack_set(&fx.full_set(), &fx.opts(false)).expect("unforced reinstall");
    assert_eq!(reused.installed_packs, ["core", "python-wheels"]);
    fx.assert_complete_install_intact("after unforced reinstall");
    fx.assert_no_leftovers("after unforced reinstall");

    let replaced = install_v2_pack_set(&fx.full_set(), &fx.opts(true)).expect("forced reinstall");
    assert_eq!(replaced.installed_packs, ["core", "python-wheels"]);
    fx.assert_complete_install_intact("after forced reinstall");
    fx.assert_no_leftovers("after forced reinstall");
}

/// When promotion fails after the installed tree was moved aside, the previous installation is
/// restored (TS: `fs.rename(backup, destination)` in the install failure path).
#[test]
fn failed_promotion_restores_the_previous_installation() {
    let fx = Fixture::new();
    install_v2_pack_set(&fx.full_set(), &fx.opts(false)).expect("install complete pack set");
    let rt_root = runtime_root_dir(&fx.home);
    let original_inode = std::fs::metadata(fx.installed_dir().join("runtime.json"))
        .unwrap()
        .ino();

    // A non-empty directory where `current.json` belongs makes the final pointer write fail.
    std::fs::remove_file(rt_root.join("current.json")).unwrap();
    std::fs::create_dir_all(rt_root.join("current.json/blocker")).unwrap();

    install_v2_pack_set(&fx.full_set(), &fx.opts(true))
        .expect_err("pointer write failure must fail the forced reinstall");

    let restored = verify_installed_runtime(&fx.installed_dir(), &fx.trusted_keys, true)
        .expect("previous installation restored and verifying");
    assert_eq!(restored.installed_packs, ["core", "python-wheels"]);
    assert_eq!(
        std::fs::metadata(fx.installed_dir().join("runtime.json"))
            .unwrap()
            .ino(),
        original_inode,
        "the original tree (not the failed replacement) must be back in place"
    );
    let stray: Vec<String> = std::fs::read_dir(&rt_root)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with(".replaced-") || name.starts_with(".staging-"))
        .collect();
    assert!(stray.is_empty(), "stray trees {stray:?}");
}
