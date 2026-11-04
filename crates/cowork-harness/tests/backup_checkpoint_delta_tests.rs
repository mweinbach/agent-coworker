//! A checkpoint's delta preview compares two saved snapshots: the preceding checkpoint (or the
//! original snapshot for the first checkpoint) against the selected checkpoint. The live
//! workspace never takes part, so a preview is stable once the checkpoint exists.

use std::fs;
use std::path::{Path, PathBuf};

use cowork_config::canonicalize_sync;
use cowork_harness::backups::{
    BackupTrigger, DeltaChangeKind, DeltaEntryKind, MAX_DELTA_FILES, WorkspaceBackupDeltaEvent,
    WorkspaceBackupManager,
};
use tempfile::TempDir;

struct Fixture {
    _guard: TempDir,
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
    fs::create_dir_all(workspace.join("src")).unwrap();
    fs::write(workspace.join("README.md"), "readme v1\n").unwrap();
    fs::write(workspace.join("src/app.txt"), "app v1\n").unwrap();
    let manager = WorkspaceBackupManager::with_fallback_root(
        base.join("home/.cowork"),
        base.join("fallback"),
    );
    manager
        .ensure_initial_backup("sess", &workspace, None, None, None)
        .expect("initial backup");
    Fixture {
        _guard: guard,
        workspace,
        manager,
    }
}

fn checkpoint(fx: &Fixture) -> String {
    let state = fx
        .manager
        .create_checkpoint(
            "sess",
            &fx.workspace,
            BackupTrigger::Manual,
            None,
            None,
            None,
        )
        .expect("create checkpoint")
        .expect("backup state");
    let checkpoint = state.checkpoints.last().expect("checkpoint");
    assert!(checkpoint.changed, "checkpoint should capture a change");
    checkpoint.id.clone()
}

fn delta(fx: &Fixture, checkpoint_id: &str) -> WorkspaceBackupDeltaEvent {
    fx.manager
        .read_workspace_backup_delta(&fx.workspace, "sess", checkpoint_id, None)
        .expect("read delta")
}

fn changes(delta: &WorkspaceBackupDeltaEvent) -> Vec<(String, DeltaChangeKind)> {
    delta
        .files
        .iter()
        .map(|file| {
            assert_eq!(file.kind, DeltaEntryKind::File, "{file:?}");
            (file.path.clone(), file.change)
        })
        .collect()
}

fn write(workspace: &Path, rel: &str, contents: &str) {
    let path = workspace.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, contents).unwrap();
}

#[test]
fn checkpoint_delta_compares_saved_snapshots_not_the_live_workspace() {
    let fx = fixture("cowork-checkpoint-delta-");
    let ws = &fx.workspace;

    // Checkpoint A: modify app, add notes. Inspected immediately, while the live workspace is
    // identical to A, it still reports what A changed relative to its predecessor, the initial
    // checkpoint `cp-0001` (which holds the original snapshot).
    write(ws, "src/app.txt", "app v2\n");
    write(ws, "docs/notes.md", "notes\n");
    let a = checkpoint(&fx);
    let delta_a = delta(&fx, &a);
    assert_eq!(delta_a.checkpoint_id, a);
    assert_eq!(delta_a.baseline_label, "cp-0001");
    assert_eq!(delta_a.current_label, a);
    assert_eq!(
        (
            delta_a.counts.added,
            delta_a.counts.modified,
            delta_a.counts.deleted
        ),
        (1, 1, 0)
    );
    assert_eq!(
        changes(&delta_a),
        vec![
            ("docs/notes.md".to_owned(), DeltaChangeKind::Added),
            ("src/app.txt".to_owned(), DeltaChangeKind::Modified),
        ]
    );
    assert!(!delta_a.truncated);

    // Checkpoint B: delete README, modify notes. Its preview is A -> B only.
    fs::remove_file(ws.join("README.md")).unwrap();
    write(ws, "docs/notes.md", "notes v2\n");
    let b = checkpoint(&fx);
    let delta_b = delta(&fx, &b);
    assert_eq!(delta_b.baseline_label, a);
    assert_eq!(delta_b.current_label, b);
    assert_eq!(
        (
            delta_b.counts.added,
            delta_b.counts.modified,
            delta_b.counts.deleted
        ),
        (0, 1, 1)
    );
    assert_eq!(
        changes(&delta_b),
        vec![
            ("README.md".to_owned(), DeltaChangeKind::Deleted),
            ("docs/notes.md".to_owned(), DeltaChangeKind::Modified),
        ]
    );

    // Later live edits leave both historical previews unchanged.
    write(ws, "src/app.txt", "app v3 (uncheckpointed)\n");
    write(ws, "late.txt", "late\n");
    fs::remove_file(ws.join("docs/notes.md")).unwrap();
    assert_eq!(delta(&fx, &a), delta_a);
    assert_eq!(delta(&fx, &b), delta_b);

    // The initial checkpoint shares the original snapshot, so it reports no changes.
    let initial = delta(&fx, "cp-0001");
    assert_eq!(initial.baseline_label, "Original snapshot");
    assert_eq!(initial.current_label, "cp-0001");
    assert_eq!(
        (
            initial.counts.added,
            initial.counts.modified,
            initial.counts.deleted
        ),
        (0, 0, 0)
    );
    assert!(initial.files.is_empty());

    // Only checkpoint ids are accepted.
    let err = fx
        .manager
        .read_workspace_backup_delta(ws, "sess", "original", None)
        .expect_err("original is not a checkpoint id");
    assert_eq!(err, "Unknown checkpoint id: original");
}

#[test]
fn checkpoint_delta_caps_the_file_preview_but_counts_every_change() {
    let fx = fixture("cowork-checkpoint-delta-cap-");
    let total = MAX_DELTA_FILES + 5;
    for i in 0..total {
        write(&fx.workspace, &format!("bulk/file-{i:04}.txt"), "x\n");
    }
    let id = checkpoint(&fx);
    let preview = delta(&fx, &id);
    assert_eq!(preview.counts.added, total);
    assert_eq!(preview.files.len(), MAX_DELTA_FILES);
    assert!(preview.truncated);
}
