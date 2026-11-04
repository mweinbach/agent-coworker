//! `session-backup-workspace-v2` fingerprints match the TypeScript `workspaceFingerprint`
//! (`src/server/sessionBackup/fingerprint.ts` on `main`), so a checkpoint of an unchanged
//! workspace deduplicates against metadata written before the Rust upgrade.
//!
//! `TS_FINGERPRINT` was produced by running that TS module (Bun 1.4 and Node 22 agree) over the
//! tree [`build_fixture`] creates. The fixture exercises what distinguishes the TS layout: sibling
//! order by `localeCompare` (not byte order), pre-order directory recursion, 3-tuple directory and
//! symlink lines (raw link target, no mode), and the top-level `.ModelScratchpad` exclusion.
#![cfg(unix)]

use std::fs;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};

use cowork_config::canonicalize_sync;
use cowork_harness::backups::{
    BackupTrigger, WorkspaceBackupManager, compute_workspace_fingerprint,
};
use tempfile::TempDir;

const TS_FINGERPRINT: &str = "cf87d1d20f94999a7ec78f01f89e35697b8e4c48d330e1b999f8f92897b0fc5e";

fn write(path: &Path, content: &str, mode: u32) {
    fs::write(path, content).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
}

fn mkdir(path: &Path, mode: u32) {
    fs::create_dir(path).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
}

/// Same tree, modes and contents the TS fingerprint was computed over.
fn build_fixture(ws: &Path) {
    write(&ws.join("B.txt"), "upper\n", 0o644);
    write(&ws.join("a.txt"), "lower\n", 0o600);
    mkdir(&ws.join("a"), 0o755);
    write(&ws.join("a/z.txt"), "z\n", 0o644);
    symlink("../a.txt", ws.join("a/link")).unwrap();
    write(&ws.join("a-b.txt"), "dash\n", 0o644);
    write(&ws.join("a_b.txt"), "underscore\n", 0o644);
    write(&ws.join("ä.txt"), "umlaut\n", 0o644);
    mkdir(&ws.join("_hidden"), 0o700);
    mkdir(&ws.join("Zeta"), 0o755);
    write(&ws.join("Zeta/10.txt"), "ten\n", 0o644);
    write(&ws.join("Zeta/9.txt"), "nine\n", 0o644);
    fs::set_permissions(ws.join("Zeta"), fs::Permissions::from_mode(0o750)).unwrap();
    symlink("missing/target", ws.join("dangling")).unwrap();
    fs::create_dir(ws.join(".ModelScratchpad")).unwrap();
    fs::write(ws.join(".ModelScratchpad/x.txt"), "ignored\n").unwrap();
}

fn workspace(prefix: &str) -> (TempDir, PathBuf) {
    let guard = tempfile::Builder::new().prefix(prefix).tempdir().unwrap();
    let base = canonicalize_sync(guard.path());
    let ws = base.join("ws");
    fs::create_dir(&ws).unwrap();
    (guard, ws)
}

#[test]
fn fingerprint_matches_typescript_v2_layout() {
    let (_guard, ws) = workspace("bk-fp-ts-");
    build_fixture(&ws);
    assert_eq!(compute_workspace_fingerprint(&ws).unwrap(), TS_FINGERPRINT);

    // Scratchpad contents never affect the fingerprint.
    fs::write(ws.join(".ModelScratchpad/y.txt"), "more\n").unwrap();
    assert_eq!(compute_workspace_fingerprint(&ws).unwrap(), TS_FINGERPRINT);
}

#[test]
fn checkpoint_dedupes_against_a_typescript_recorded_fingerprint() {
    let (guard, ws) = workspace("bk-fp-dedupe-");
    build_fixture(&ws);
    let base = canonicalize_sync(guard.path());
    let manager =
        WorkspaceBackupManager::with_fallback_root(base.join("home/.cowork"), base.join("fb"));
    let state = manager
        .ensure_initial_backup("sess-ts", &ws, None, None, None)
        .unwrap();
    let backup_dir = PathBuf::from(state.backup_directory.unwrap());

    // Rewrite the metadata as the TS server left it: fingerprints from `workspaceFingerprint`.
    let meta_path = backup_dir.join("metadata.json");
    let mut meta: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&meta_path).unwrap()).unwrap();
    meta["originalFingerprint"] = TS_FINGERPRINT.into();
    for cp in meta["checkpoints"].as_array_mut().unwrap() {
        cp["fingerprint"] = TS_FINGERPRINT.into();
    }
    fs::write(&meta_path, serde_json::to_string_pretty(&meta).unwrap()).unwrap();

    let state = manager
        .create_checkpoint("sess-ts", &ws, BackupTrigger::Manual, None, None, None)
        .unwrap()
        .unwrap();
    let last = state.checkpoints.last().unwrap();
    assert_eq!(last.id, "cp-0002");
    assert!(
        !last.changed,
        "unchanged workspace must reuse the TS-created snapshot"
    );
    assert_eq!(last.patch_bytes, 0);
    assert!(
        !backup_dir.join("checkpoints/cp-0002.tar.gz").exists(),
        "no duplicate archive for an unchanged workspace"
    );
}
