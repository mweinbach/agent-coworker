//! Snapshots holding populated read-only directories (mode `0555`) must stay restorable and
//! delta-inspectable for an ordinary (non-root) user: final directory modes are applied only
//! after every descendant exists, and restoring over a workspace that already holds such
//! directories (from an earlier restore) must neither fail nor strand a `.restore-rollback-*`
//! directory.
//!
//! Root ignores directory write bits, so under root these tests still exercise the code path but
//! cannot demonstrate the ordering bug; they print a note instead of failing.

#![cfg(unix)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use cowork_config::canonicalize_sync;
use cowork_harness::backups::{
    BackupLifecycle, RECOVERY_DIRECTORY_PREFIX, SessionLookupMetadata, WorkspaceBackupManager,
    extract_snapshot_tar_gz_confined, write_snapshot_tar_gz,
};
use tempfile::TempDir;

/// Guard that makes every directory under `root` owner-writable before the `TempDir` is removed,
/// so cleanup also works for an unprivileged user.
struct WritableTempDir {
    dir: Option<TempDir>,
    path: PathBuf,
}

impl Drop for WritableTempDir {
    fn drop(&mut self) {
        make_tree_writable(&self.path);
        drop(self.dir.take());
    }
}

fn canonical_temp_dir(prefix: &str) -> WritableTempDir {
    let base = if cfg!(target_os = "macos") {
        PathBuf::from("/private/tmp")
    } else {
        std::env::temp_dir()
    };
    let dir = tempfile::Builder::new()
        .prefix(prefix)
        .tempdir_in(base)
        .expect("create tempdir");
    let path = canonicalize_sync(dir.path());
    WritableTempDir {
        dir: Some(dir),
        path,
    }
}

fn make_tree_writable(path: &Path) {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return;
    };
    if !meta.is_dir() {
        return;
    }
    let mode = meta.permissions().mode() & 0o7777;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(mode | 0o700));
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            make_tree_writable(&entry.path());
        }
    }
}

fn running_as_root() -> bool {
    // SAFETY: `geteuid` has no preconditions and cannot fail.
    unsafe { libc::geteuid() == 0 }
}

fn note_if_root(test: &str) {
    if running_as_root() {
        eprintln!(
            "{test}: running as root, which ignores directory write bits; the code path is \
             exercised but the read-only ordering bug cannot be demonstrated here."
        );
    }
}

fn mode_of(path: &Path) -> u32 {
    fs::symlink_metadata(path).unwrap().permissions().mode() & 0o7777
}

fn set_mode(path: &Path, mode: u32) {
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
}

/// Populates `root` with a top-level read-only directory, a read-only directory nested inside a
/// writable one, and a read-only directory nested inside a read-only one. Modes are applied
/// deepest-first so the tree can be built by an unprivileged user.
fn populate_read_only_tree(root: &Path) {
    fs::create_dir_all(root.join("locked/inner")).unwrap();
    fs::write(root.join("locked/file.txt"), "locked file\n").unwrap();
    fs::write(root.join("locked/inner/deep.txt"), "deep file\n").unwrap();
    fs::create_dir_all(root.join("open/sealed")).unwrap();
    fs::write(root.join("open/sealed/note.txt"), "sealed note\n").unwrap();
    fs::write(root.join("README.md"), "# readme\n").unwrap();

    set_mode(&root.join("locked/inner"), 0o555);
    set_mode(&root.join("locked"), 0o555);
    set_mode(&root.join("open/sealed"), 0o555);
}

fn assert_read_only_tree(root: &Path) {
    assert_eq!(
        fs::read_to_string(root.join("locked/file.txt")).unwrap(),
        "locked file\n"
    );
    assert_eq!(
        fs::read_to_string(root.join("locked/inner/deep.txt")).unwrap(),
        "deep file\n"
    );
    assert_eq!(
        fs::read_to_string(root.join("open/sealed/note.txt")).unwrap(),
        "sealed note\n"
    );
    assert_eq!(
        fs::read_to_string(root.join("README.md")).unwrap(),
        "# readme\n"
    );
    assert_eq!(mode_of(&root.join("locked")), 0o555);
    assert_eq!(mode_of(&root.join("locked/inner")), 0o555);
    assert_eq!(mode_of(&root.join("open/sealed")), 0o555);
}

fn rollback_dirs(workspace: &Path) -> Vec<String> {
    fs::read_dir(workspace)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with(RECOVERY_DIRECTORY_PREFIX))
        .collect()
}

fn lookup(_: &str) -> SessionLookupMetadata {
    SessionLookupMetadata {
        lifecycle: BackupLifecycle::Active,
        busy: false,
        title: None,
        provider: None,
        model: None,
    }
}

#[test]
fn extracting_snapshot_with_populated_read_only_directories_succeeds() {
    note_if_root("extracting_snapshot_with_populated_read_only_directories_succeeds");
    let tmp = canonical_temp_dir("cowork-backup-ro-extract-");
    let source = tmp.path.join("source");
    fs::create_dir_all(&source).unwrap();
    populate_read_only_tree(&source);

    let archive = tmp.path.join("snap/snapshot.tar.gz");
    write_snapshot_tar_gz(&source, &archive).expect("write snapshot");

    let dest = tmp.path.join("dest");
    extract_snapshot_tar_gz_confined(&archive, &dest).expect("extract snapshot");
    assert_read_only_tree(&dest);
}

#[test]
fn restore_and_re_restore_with_read_only_directories() {
    note_if_root("restore_and_re_restore_with_read_only_directories");
    let tmp = canonical_temp_dir("cowork-backup-ro-restore-");
    let cowork_home = tmp.path.join("home/.cowork");
    let fallback = tmp.path.join("fallback");
    let ws = tmp.path.join("workspace");
    fs::create_dir_all(&cowork_home).unwrap();
    fs::create_dir_all(&fallback).unwrap();
    fs::create_dir_all(&ws).unwrap();
    populate_read_only_tree(&ws);

    let mgr = WorkspaceBackupManager::with_fallback_root(cowork_home, fallback);
    mgr.ensure_initial_backup("sess-ro", &ws, None, None, None)
        .expect("initial backup");

    // Inspecting a checkpoint extracts it and its predecessor; both trees hold read-only
    // directories, only the real change is reported, and no temporary extraction is left behind.
    fs::write(ws.join("added.txt"), "added\n").unwrap();
    let checkpoint = mgr
        .create_checkpoint(
            "sess-ro",
            &ws,
            cowork_harness::backups::BackupTrigger::Manual,
            None,
            None,
            None,
        )
        .expect("checkpoint with added file")
        .expect("backup state");
    let checkpoint_id = checkpoint
        .checkpoints
        .last()
        .expect("checkpoint")
        .id
        .clone();
    let delta = mgr
        .read_workspace_backup_delta(&ws, "sess-ro", &checkpoint_id, None)
        .expect("delta between snapshots with read-only directories");
    assert_eq!(delta.counts.added, 1, "delta: {:?}", delta.files);
    assert_eq!(delta.counts.modified, 0, "delta: {:?}", delta.files);
    assert_eq!(delta.counts.deleted, 0, "delta: {:?}", delta.files);
    let backup_dir = PathBuf::from(checkpoint.backup_directory.expect("backup directory"));
    let leftovers: Vec<_> = fs::read_dir(&backup_dir)
        .unwrap()
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with(".delta-"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");

    // First restore: the workspace already holds the read-only directories (they were never
    // removed), so this also covers restoring over them.
    mgr.restore_workspace_backup(&ws, "sess-ro", Some("original"), None, lookup)
        .expect("restore original");
    assert!(!ws.join("added.txt").exists());
    assert_read_only_tree(&ws);
    assert!(rollback_dirs(&ws).is_empty(), "{:?}", rollback_dirs(&ws));

    // Second restore over the read-only directories produced by the first one.
    fs::write(ws.join("added-again.txt"), "again\n").unwrap();
    mgr.restore_workspace_backup(&ws, "sess-ro", Some("original"), None, lookup)
        .expect("re-restore original over read-only directories");
    assert!(!ws.join("added-again.txt").exists());
    assert_read_only_tree(&ws);
    assert!(rollback_dirs(&ws).is_empty(), "{:?}", rollback_dirs(&ws));

    // Further backup operations are not blocked by a stranded recovery directory.
    mgr.create_checkpoint(
        "sess-ro",
        &ws,
        cowork_harness::backups::BackupTrigger::Manual,
        None,
        None,
        None,
    )
    .expect("checkpoint after restores");
    mgr.delete_entry(&ws, "sess-ro", None, lookup)
        .expect("delete backup entry");
}
