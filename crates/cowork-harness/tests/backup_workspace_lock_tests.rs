//! Checkpoint capture holds the workspace lock (after the session lock), the same lock
//! `restore_workspace_backup` holds while it replaces the workspace. Two backup sessions that share
//! a workspace therefore never let a checkpoint fingerprint or archive a tree that is empty or only
//! partially restored, and the shared session -> workspace lock order never deadlocks.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use cowork_config::{
    ConfigError, FileLockOptions, canonicalize_sync, file_lock_root_for_cowork_home,
    with_file_lock_sync,
};
use cowork_harness::backups::{
    BackupLifecycle, BackupTrigger, RECOVERY_DIRECTORY_PREFIX, SessionBackupPublicState,
    SessionLookupMetadata, WorkspaceBackupManager, extract_snapshot_tar_gz_confined,
};
use tempfile::TempDir;

/// Long enough for an unblocked checkpoint of a tiny workspace to finish many times over.
const BLOCKED_PROBE: Duration = Duration::from_millis(500);

struct Fixture {
    guard: TempDir,
    cowork_home: PathBuf,
    workspace: PathBuf,
    manager: WorkspaceBackupManager,
}

fn fixture(prefix: &str) -> Fixture {
    let guard = tempfile::Builder::new()
        .prefix(prefix)
        .tempdir()
        .expect("tempdir");
    let base = canonicalize_sync(guard.path());
    let workspace = base.join("workspace");
    fs::create_dir_all(&workspace).unwrap();
    let cowork_home = base.join("home/.cowork");
    let manager = WorkspaceBackupManager::with_fallback_root(cowork_home.clone(), base.join("fb"));
    Fixture {
        guard,
        cowork_home,
        workspace,
        manager,
    }
}

/// Runs `f` while holding the workspace lock exactly as a restore holds it.
fn with_workspace_lock(fx: &Fixture, f: impl FnOnce()) {
    with_file_lock_sync::<(), ConfigError, _>(
        &fx.workspace,
        || {
            f();
            Ok(())
        },
        FileLockOptions {
            lock_root: Some(file_lock_root_for_cowork_home(&fx.cowork_home)),
            ..FileLockOptions::default()
        },
    )
    .expect("workspace lock");
}

fn write_files(root: &Path, names: &[String], contents: &str) {
    for name in names {
        fs::write(root.join(name), contents).unwrap();
    }
}

fn clear_dir(root: &Path) {
    for entry in fs::read_dir(root).unwrap().flatten() {
        let path = entry.path();
        if path.is_dir() {
            fs::remove_dir_all(&path).unwrap();
        } else {
            fs::remove_file(&path).unwrap();
        }
    }
}

fn relative_files(root: &Path) -> BTreeSet<String> {
    fn walk(root: &Path, dir: &Path, out: &mut BTreeSet<String>) {
        for entry in fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(root, &path, out);
            } else {
                let rel = path.strip_prefix(root).unwrap();
                out.insert(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    let mut out = BTreeSet::new();
    walk(root, root, &mut out);
    out
}

fn names(prefix: &str, count: usize) -> Vec<String> {
    (0..count).map(|i| format!("{prefix}_{i:03}.txt")).collect()
}

/// Extracts every checkpoint snapshot recorded for the session at `backup_dir`, returning
/// `(checkpoint id, files in its snapshot)`.
fn checkpoint_snapshot_files(backup_dir: &Path, scratch: &Path) -> Vec<(String, BTreeSet<String>)> {
    let raw = fs::read_to_string(backup_dir.join("metadata.json")).unwrap();
    let meta: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let mut out = Vec::new();
    for cp in meta["checkpoints"].as_array().unwrap() {
        let id = cp["id"].as_str().unwrap().to_owned();
        let snap = cp["snapshot"]["path"].as_str().unwrap();
        assert_eq!(cp["snapshot"]["kind"], "tar_gz", "{cp}");
        let dest = scratch.join(format!("extract-{}-{id}", out.len()));
        fs::create_dir_all(&dest).unwrap();
        extract_snapshot_tar_gz_confined(&backup_dir.join(snap), &dest).unwrap();
        out.push((id, relative_files(&dest)));
    }
    out
}

fn backup_dir(state: &SessionBackupPublicState) -> PathBuf {
    PathBuf::from(state.backup_directory.as_deref().expect("backup directory"))
}

fn lookup(_sid: &str) -> SessionLookupMetadata {
    SessionLookupMetadata {
        lifecycle: BackupLifecycle::Deleted,
        title: None,
        provider: None,
        model: None,
        busy: false,
    }
}

#[test]
fn checkpoint_waits_for_workspace_lock_and_never_captures_a_partial_restore() {
    let fx = fixture("cp-ws-lock-");
    let full = names("full", 20);
    write_files(&fx.workspace, &full, "v1\n");
    fx.manager
        .ensure_initial_backup("sess-a", &fx.workspace, None, None, None)
        .expect("initial backup");
    fs::write(fx.workspace.join("added.txt"), "added\n").unwrap();
    let mut expected: BTreeSet<String> = full.iter().cloned().collect();
    expected.insert("added.txt".to_owned());

    let parked = fx.guard.path().join("parked");
    fs::create_dir_all(&parked).unwrap();

    let state = thread::scope(|scope| {
        let mut handle = None;
        with_workspace_lock(&fx, || {
            // Simulate a restore from another session that has moved the workspace's entries out
            // and not yet moved the snapshot's entries in.
            for entry in fs::read_dir(&fx.workspace).unwrap().flatten() {
                fs::rename(entry.path(), parked.join(entry.file_name())).unwrap();
            }
            assert!(relative_files(&fx.workspace).is_empty());

            let h = scope.spawn(|| {
                fx.manager.create_checkpoint(
                    "sess-a",
                    &fx.workspace,
                    BackupTrigger::Manual,
                    None,
                    None,
                    None,
                )
            });
            thread::sleep(BLOCKED_PROBE);
            assert!(
                !h.is_finished(),
                "checkpoint must wait for the workspace lock held by the restore"
            );

            for entry in fs::read_dir(&parked).unwrap().flatten() {
                fs::rename(entry.path(), fx.workspace.join(entry.file_name())).unwrap();
            }
            handle = Some(h);
        });
        handle.unwrap().join().unwrap()
    })
    .expect("checkpoint")
    .expect("checkpoint state");

    let last = state.checkpoints.last().expect("checkpoint");
    assert_eq!(last.id, "cp-0002");
    assert!(last.changed, "added.txt is a change against cp-0001");

    let scratch = fx.guard.path().join("scratch");
    let snapshots = checkpoint_snapshot_files(&backup_dir(&state), &scratch);
    assert_eq!(snapshots.last().unwrap().0, "cp-0002");
    assert_eq!(
        snapshots.last().unwrap().1,
        expected,
        "checkpoint captured the tree mid-restore"
    );
}

#[test]
fn checkpoint_rechecks_recovery_after_acquiring_workspace_lock() {
    let fx = fixture("cp-ws-recovery-");
    write_files(&fx.workspace, &names("f", 3), "v1\n");
    fx.manager
        .ensure_initial_backup("sess-a", &fx.workspace, None, None, None)
        .expect("initial backup");
    fs::write(fx.workspace.join("added.txt"), "added\n").unwrap();

    let result = thread::scope(|scope| {
        let mut handle = None;
        with_workspace_lock(&fx, || {
            // The checkpoint starts while the workspace still looks healthy...
            let h = scope.spawn(|| {
                fx.manager.create_checkpoint(
                    "sess-a",
                    &fx.workspace,
                    BackupTrigger::Manual,
                    None,
                    None,
                    None,
                )
            });
            thread::sleep(BLOCKED_PROBE);
            assert!(
                !h.is_finished(),
                "checkpoint must wait for the workspace lock"
            );
            // ...and the concurrent restore then fails, stranding a recovery directory.
            fs::create_dir_all(
                fx.workspace
                    .join(format!("{RECOVERY_DIRECTORY_PREFIX}test"))
                    .join("files"),
            )
            .unwrap();
            handle = Some(h);
        });
        handle.unwrap().join().unwrap()
    });

    let err = result.expect_err("checkpoint must refuse a workspace that needs recovery");
    assert!(err.contains("recovery"), "{err}");
    let state = fx
        .manager
        .read_session_backup_state("sess-a", &fx.workspace, true);
    assert_eq!(state.checkpoints.len(), 1, "no checkpoint may be recorded");
}

#[test]
fn initial_backup_waits_for_workspace_lock() {
    let fx = fixture("cp-ws-initial-");
    let full = names("full", 10);
    write_files(&fx.workspace, &full, "v1\n");
    let parked = fx.guard.path().join("parked");
    fs::create_dir_all(&parked).unwrap();

    let state = thread::scope(|scope| {
        let mut handle = None;
        with_workspace_lock(&fx, || {
            for entry in fs::read_dir(&fx.workspace).unwrap().flatten() {
                fs::rename(entry.path(), parked.join(entry.file_name())).unwrap();
            }
            let h = scope.spawn(|| {
                fx.manager
                    .ensure_initial_backup("sess-b", &fx.workspace, None, None, None)
            });
            thread::sleep(BLOCKED_PROBE);
            assert!(
                !h.is_finished(),
                "initial snapshot must wait for the workspace lock"
            );
            for entry in fs::read_dir(&parked).unwrap().flatten() {
                fs::rename(entry.path(), fx.workspace.join(entry.file_name())).unwrap();
            }
            handle = Some(h);
        });
        handle.unwrap().join().unwrap()
    })
    .expect("initial backup");

    let scratch = fx.guard.path().join("scratch");
    let snapshots = checkpoint_snapshot_files(&backup_dir(&state), &scratch);
    assert_eq!(snapshots.len(), 1);
    assert_eq!(snapshots[0].1, full.iter().cloned().collect());
}

#[test]
fn concurrent_restores_and_checkpoints_on_a_shared_workspace_stay_consistent() {
    const ROUNDS: usize = 12;
    let fx = fixture("cp-ws-concurrent-");
    // Many top-level entries make the restore's move-out/move-in window wide.
    let tree_x = names("x", 120);
    let tree_y = names("y", 120);
    write_files(&fx.workspace, &tree_x, "x\n");
    fx.manager
        .ensure_initial_backup("sess-restore", &fx.workspace, None, None, None)
        .expect("restore session initial backup");
    fx.manager
        .ensure_initial_backup("sess-checkpoint", &fx.workspace, None, None, None)
        .expect("checkpoint session initial backup");
    clear_dir(&fx.workspace);
    write_files(&fx.workspace, &tree_y, "y\n");
    let restore_state = fx
        .manager
        .create_checkpoint(
            "sess-restore",
            &fx.workspace,
            BackupTrigger::Manual,
            None,
            None,
            None,
        )
        .expect("checkpoint y")
        .expect("state");
    assert_eq!(restore_state.checkpoints.last().unwrap().id, "cp-0002");

    let (done_tx, done_rx) = mpsc::channel::<&'static str>();
    let manager_r = fx.manager.clone();
    let manager_c = fx.manager.clone();
    let ws_r = fx.workspace.clone();
    let ws_c = fx.workspace.clone();
    let tx_r = done_tx.clone();
    let restorer = thread::spawn(move || {
        for round in 0..ROUNDS {
            let target = if round % 2 == 0 {
                "original"
            } else {
                "cp-0002"
            };
            manager_r
                .restore_workspace_backup(&ws_r, "sess-restore", Some(target), None, lookup)
                .unwrap_or_else(|e| panic!("restore round {round}: {e}"));
        }
        let _ = tx_r.send("restorer");
    });
    let checkpointer = thread::spawn(move || {
        let mut last = None;
        for round in 0..ROUNDS * 2 {
            let state = manager_c
                .create_checkpoint(
                    "sess-checkpoint",
                    &ws_c,
                    BackupTrigger::Manual,
                    None,
                    None,
                    None,
                )
                .unwrap_or_else(|e| panic!("checkpoint round {round}: {e}"))
                .expect("manual checkpoint state");
            last = Some(state);
        }
        let _ = done_tx.send("checkpointer");
        last.unwrap()
    });

    for _ in 0..2 {
        done_rx
            .recv_timeout(Duration::from_secs(180))
            .expect("restore/checkpoint loop deadlocked or stalled");
    }
    restorer.join().expect("restorer thread");
    let checkpoint_state = checkpointer.join().expect("checkpointer thread");

    let x: BTreeSet<String> = tree_x.iter().cloned().collect();
    let y: BTreeSet<String> = tree_y.iter().cloned().collect();
    for (label, dir) in [
        ("checkpoint", backup_dir(&checkpoint_state)),
        ("restore", backup_dir(&restore_state)),
    ] {
        let scratch = fx.guard.path().join(format!("scratch-{label}"));
        let snapshots = checkpoint_snapshot_files(&dir, &scratch);
        assert!(snapshots.len() > 1, "{}", dir.display());
        for (id, files) in snapshots {
            assert!(
                files == x || files == y,
                "{} {id} captured a partial tree ({} files)",
                dir.display(),
                files.len()
            );
        }
    }
    // The workspace ends on the last restored tree.
    let final_files = relative_files(&fx.workspace);
    assert!(final_files == x || final_files == y);
}
