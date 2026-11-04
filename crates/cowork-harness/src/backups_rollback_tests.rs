//! Rollback behavior of `replace_directory_contents` when publishing a restored snapshot fails.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use super::{
    RECOVERY_DIRECTORY_PREFIX, replace_directory_contents, replace_directory_contents_with,
    workspace_recovery_failure_reason,
};

struct Fixture {
    _tmp: tempfile::TempDir,
    workspace: PathBuf,
    staged: PathBuf,
}

/// Workspace holds originals `a.txt` + `b/inner.txt`; the staged snapshot holds `a.txt` + `c.txt`.
fn fixture() -> Fixture {
    let tmp = tempfile::tempdir().expect("tempdir");
    let root = fs::canonicalize(tmp.path()).unwrap();
    let workspace = root.join("workspace");
    let staged = root.join("staged");
    fs::create_dir_all(workspace.join("b")).unwrap();
    fs::write(workspace.join("a.txt"), "orig-a").unwrap();
    fs::write(workspace.join("b").join("inner.txt"), "orig-b").unwrap();
    fs::create_dir_all(&staged).unwrap();
    fs::write(staged.join("a.txt"), "new-a").unwrap();
    fs::write(staged.join("c.txt"), "new-c").unwrap();
    Fixture {
        _tmp: tmp,
        workspace,
        staged,
    }
}

fn rollback_dirs(workspace: &Path) -> Vec<PathBuf> {
    fs::read_dir(workspace)
        .unwrap()
        .map(|e| e.unwrap())
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with(RECOVERY_DIRECTORY_PREFIX)
        })
        .map(|e| e.path())
        .collect()
}

fn injected_failure() -> io::Error {
    io::Error::other("injected publish failure")
}

#[test]
fn incomplete_rollback_keeps_recovery_dir_and_reports_its_path() {
    let f = fixture();
    let workspace = f.workspace.clone();
    let err = replace_directory_contents_with(&f.workspace, &f.staged, |src, dst| {
        if dst.file_name().is_some_and(|n| n == "c.txt") {
            // Something recreated an original's name as a non-empty directory, so moving the
            // original `b/` back during rollback fails.
            fs::create_dir_all(workspace.join("b")).unwrap();
            fs::write(workspace.join("b").join("blocker"), "x").unwrap();
            return Err(injected_failure());
        }
        fs::rename(src, dst)
    })
    .expect_err("publish must fail");

    let dirs = rollback_dirs(&f.workspace);
    assert_eq!(dirs.len(), 1, "rollback dir must be kept: {err}");
    let recovery_files = dirs[0].join("files");
    assert!(
        err.contains(&recovery_files.display().to_string()),
        "error must report the recovery path: {err}"
    );
    assert!(err.contains("injected publish failure"), "{err}");
    assert!(
        err.contains("\"b\""),
        "error must name the unrecovered entry: {err}"
    );
    // The unrecovered original is still recoverable from the kept directory.
    assert_eq!(
        fs::read_to_string(recovery_files.join("b").join("inner.txt")).unwrap(),
        "orig-b"
    );
    // Originals that could be moved back were, and restored entries were removed.
    assert_eq!(
        fs::read_to_string(f.workspace.join("a.txt")).unwrap(),
        "orig-a"
    );
    assert!(!f.workspace.join("c.txt").exists());
    // Further backup operations are blocked until the recovery dir is resolved.
    assert!(workspace_recovery_failure_reason(&f.workspace).is_some());
}

#[test]
fn complete_rollback_removes_recovery_dir_and_restores_originals() {
    let f = fixture();
    let err = replace_directory_contents_with(&f.workspace, &f.staged, |src, dst| {
        if dst.file_name().is_some_and(|n| n == "c.txt") {
            return Err(injected_failure());
        }
        fs::rename(src, dst)
    })
    .expect_err("publish must fail");

    assert!(err.contains("injected publish failure"), "{err}");
    assert!(!err.contains("recover previous files"), "{err}");
    assert!(rollback_dirs(&f.workspace).is_empty());
    assert_eq!(
        fs::read_to_string(f.workspace.join("a.txt")).unwrap(),
        "orig-a"
    );
    assert_eq!(
        fs::read_to_string(f.workspace.join("b").join("inner.txt")).unwrap(),
        "orig-b"
    );
    assert!(!f.workspace.join("c.txt").exists());
    assert!(workspace_recovery_failure_reason(&f.workspace).is_none());
}

#[test]
fn successful_publish_replaces_contents_and_removes_recovery_dir() {
    let f = fixture();
    replace_directory_contents(&f.workspace, &f.staged).expect("publish");
    assert!(rollback_dirs(&f.workspace).is_empty());
    assert_eq!(
        fs::read_to_string(f.workspace.join("a.txt")).unwrap(),
        "new-a"
    );
    assert_eq!(
        fs::read_to_string(f.workspace.join("c.txt")).unwrap(),
        "new-c"
    );
    assert!(!f.workspace.join("b").exists());
}
