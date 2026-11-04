//! Locking around backup reads and entry deletion:
//!
//! - `delete_entry` takes the session lock, then the workspace lock, and refuses to delete while
//!   an interrupted `.restore-rollback-*` directory still needs recovering (TS `deleteEntry`);
//! - `read_workspace_backup_delta` holds the session lock while it stages snapshots inside the
//!   session backup directory, so a concurrent `delete_entry` cannot remove it mid-preview;
//! - `read_workspace_backups` reads under the workspace lock (TS `listWorkspaceBackups`), so the
//!   rollback directory of a restore in progress is not reported as a recovery failure.

use std::fs;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;

use cowork_config::{
    ConfigError, FileLockOptions, canonicalize_sync, file_lock_root_for_cowork_home,
    with_file_lock_sync,
};
use cowork_harness::backups::{
    BackupLifecycle, BackupStatus, BackupTrigger, RECOVERY_DIRECTORY_PREFIX, SessionLookupMetadata,
    WorkspaceBackupManager,
};
use tempfile::TempDir;

/// Long enough for an unblocked call on a tiny workspace to finish many times over.
const BLOCKED_PROBE: Duration = Duration::from_millis(500);

struct Fixture {
    _guard: TempDir,
    cowork_home: PathBuf,
    workspace: PathBuf,
    manager: WorkspaceBackupManager,
}

fn fixture(prefix: &str) -> Fixture {
    let guard = tempfile::Builder::new().prefix(prefix).tempdir().unwrap();
    let base = canonicalize_sync(guard.path());
    let workspace = base.join("workspace");
    fs::create_dir_all(&workspace).unwrap();
    let cowork_home = base.join("home/.cowork");
    let manager = WorkspaceBackupManager::with_fallback_root(cowork_home.clone(), base.join("fb"));
    Fixture {
        _guard: guard,
        cowork_home,
        workspace,
        manager,
    }
}

/// Runs `f` while holding the backup file lock on `target`, as the manager takes it.
fn with_lock(fx: &Fixture, target: &Path, f: impl FnOnce()) {
    with_file_lock_sync::<(), ConfigError, _>(
        target,
        || {
            f();
            Ok(())
        },
        FileLockOptions {
            lock_root: Some(file_lock_root_for_cowork_home(&fx.cowork_home)),
            ..FileLockOptions::default()
        },
    )
    .expect("lock");
}

fn lookup(_sid: &str) -> SessionLookupMetadata {
    SessionLookupMetadata {
        lifecycle: BackupLifecycle::Closed,
        title: None,
        provider: None,
        model: None,
        busy: false,
    }
}

/// Initial backup plus one changed checkpoint; returns the session backup directory.
fn backup_with_changed_checkpoint(fx: &Fixture, session_id: &str) -> (PathBuf, String) {
    fs::write(fx.workspace.join("a.txt"), "v1\n").unwrap();
    let state = fx
        .manager
        .ensure_initial_backup(session_id, &fx.workspace, None, None, None)
        .unwrap();
    fs::write(fx.workspace.join("a.txt"), "v2\n").unwrap();
    fs::write(fx.workspace.join("b.txt"), "new\n").unwrap();
    let state2 = fx
        .manager
        .create_checkpoint(
            session_id,
            &fx.workspace,
            BackupTrigger::Manual,
            None,
            None,
            None,
        )
        .unwrap()
        .unwrap();
    let cp = state2.checkpoints.last().unwrap();
    assert!(cp.changed);
    (
        PathBuf::from(state.backup_directory.unwrap()),
        cp.id.clone(),
    )
}

#[test]
fn delete_entry_refuses_while_a_restore_recovery_directory_is_present() {
    let fx = fixture("bk-del-guard-");
    let (backup_dir, _) = backup_with_changed_checkpoint(&fx, "sess-del");
    let recovery = fx
        .workspace
        .join(format!("{RECOVERY_DIRECTORY_PREFIX}interrupted"));
    fs::create_dir_all(recovery.join("files")).unwrap();

    let err = fx
        .manager
        .delete_entry(&fx.workspace, "sess-del", None, lookup)
        .expect_err("deleting a backup while recovery is pending must fail");
    assert!(err.contains("unfinished restore recovery"), "{err}");
    assert!(
        backup_dir.join("metadata.json").is_file(),
        "backup must be kept for recovery"
    );

    fs::remove_dir_all(&recovery).unwrap();
    let event = fx
        .manager
        .delete_entry(&fx.workspace, "sess-del", None, lookup)
        .unwrap();
    assert!(event.backups.is_empty());
    assert!(!backup_dir.exists());
}

#[test]
fn delete_entry_waits_for_the_workspace_lock() {
    let fx = fixture("bk-del-wslock-");
    let (backup_dir, _) = backup_with_changed_checkpoint(&fx, "sess-del-ws");

    thread::scope(|scope| {
        with_lock(&fx, &fx.workspace, || {
            let handle = scope.spawn(|| {
                fx.manager
                    .delete_entry(&fx.workspace, "sess-del-ws", None, lookup)
            });
            thread::sleep(BLOCKED_PROBE);
            assert!(
                !handle.is_finished(),
                "delete_entry must wait for the workspace lock"
            );
            assert!(backup_dir.exists());
            // Released when this closure returns; the scope joins the deletion.
        });
    });
    assert!(!backup_dir.exists());
}

#[test]
fn delta_preview_holds_the_session_lock() {
    let fx = fixture("bk-delta-lock-");
    let (backup_dir, checkpoint_id) = backup_with_changed_checkpoint(&fx, "sess-delta");

    let event = thread::scope(|scope| {
        let mut handle = None;
        with_lock(&fx, &backup_dir, || {
            let h = scope.spawn(|| {
                fx.manager.read_workspace_backup_delta(
                    &fx.workspace,
                    "sess-delta",
                    &checkpoint_id,
                    None,
                )
            });
            thread::sleep(BLOCKED_PROBE);
            assert!(
                !h.is_finished(),
                "delta preview must wait for the session lock"
            );
            let staging: Vec<String> = fs::read_dir(&backup_dir)
                .unwrap()
                .flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| n.starts_with(".delta-"))
                .collect();
            assert!(
                staging.is_empty(),
                "no staging directory may be created without the session lock: {staging:?}"
            );
            handle = Some(h);
        });
        handle.unwrap().join().unwrap()
    })
    .expect("delta");

    assert_eq!(event.counts.added, 1);
    assert_eq!(event.counts.modified, 1);
    assert_eq!(event.counts.deleted, 0);
}

#[test]
fn listing_waits_for_an_in_progress_restore_instead_of_reporting_recovery_failure() {
    let fx = fixture("bk-list-wslock-");
    backup_with_changed_checkpoint(&fx, "sess-list");
    let rollback = fx
        .workspace
        .join(format!("{RECOVERY_DIRECTORY_PREFIX}in-progress"));

    let event = thread::scope(|scope| {
        let mut handle = None;
        with_lock(&fx, &fx.workspace, || {
            // A restore holding the workspace lock has its rollback directory in place.
            fs::create_dir_all(rollback.join("files")).unwrap();
            let h = scope.spawn(|| {
                fx.manager
                    .read_workspace_backups(&fx.workspace, None, lookup)
            });
            thread::sleep(BLOCKED_PROBE);
            assert!(!h.is_finished(), "listing must wait for the workspace lock");
            // The restore completes and removes its rollback directory before unlocking.
            fs::remove_dir_all(&rollback).unwrap();
            handle = Some(h);
        });
        handle.unwrap().join().unwrap()
    })
    .expect("listing");

    assert_eq!(event.backups.len(), 1);
    let entry = &event.backups[0];
    assert_eq!(entry.status, BackupStatus::Ready, "{entry:?}");
    assert!(entry.failure_reason.is_none(), "{entry:?}");
}
