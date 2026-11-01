//! Publishing a restored snapshot when the staging directory is on another filesystem than the
//! workspace: `rename` fails with `EXDEV`, so staged entries are copied into place instead.
//!
//! Cross-device mounts are not available in CI, so `EXDEV` is simulated by injecting the rename.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use super::{
    RECOVERY_DIRECTORY_PREFIX, place_staged_entry, replace_directory_contents_with,
    workspace_recovery_failure_reason,
};

struct Fixture {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    workspace: PathBuf,
    staged: PathBuf,
}

/// Workspace holds originals `a.txt` + `b/inner.txt` (plus a preserved `.ModelScratchpad`); the
/// staged snapshot holds `a.txt`, `c.txt` and a directory `d/` with a file and a relative symlink.
fn fixture() -> Fixture {
    let tmp = tempfile::tempdir().expect("tempdir");
    let root = fs::canonicalize(tmp.path()).unwrap();
    let workspace = root.join("workspace");
    let staged = root.join("staged");
    fs::create_dir_all(workspace.join("b")).unwrap();
    fs::create_dir_all(workspace.join(".ModelScratchpad")).unwrap();
    fs::write(workspace.join("a.txt"), "orig-a").unwrap();
    fs::write(workspace.join("b").join("inner.txt"), "orig-b").unwrap();
    fs::write(workspace.join(".ModelScratchpad").join("scratch"), "keep").unwrap();
    fs::create_dir_all(staged.join("d")).unwrap();
    fs::write(staged.join("a.txt"), "new-a").unwrap();
    fs::write(staged.join("c.txt"), "new-c").unwrap();
    fs::write(staged.join("d").join("inner.txt"), "new-d").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink("inner.txt", staged.join("d").join("link")).unwrap();
    Fixture {
        _tmp: tmp,
        root,
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

fn exdev() -> io::Error {
    #[cfg(unix)]
    {
        io::Error::from_raw_os_error(libc::EXDEV)
    }
    #[cfg(not(unix))]
    {
        io::Error::from(io::ErrorKind::CrossesDevices)
    }
}

/// Publishes like `replace_directory_contents`, but every rename fails as if crossing devices.
fn publish_cross_device(workspace: &Path, staged: &Path) -> Result<(), String> {
    replace_directory_contents_with(workspace, staged, |src, dst| {
        place_staged_entry(src, dst, |_, _| Err(exdev()))
    })
}

fn assert_originals_restored(workspace: &Path) {
    assert_eq!(
        fs::read_to_string(workspace.join("a.txt")).unwrap(),
        "orig-a"
    );
    assert_eq!(
        fs::read_to_string(workspace.join("b").join("inner.txt")).unwrap(),
        "orig-b"
    );
    assert!(!workspace.join("c.txt").exists());
    assert!(fs::symlink_metadata(workspace.join("d")).is_err());
    assert_eq!(
        fs::read_to_string(workspace.join(".ModelScratchpad").join("scratch")).unwrap(),
        "keep"
    );
    assert!(rollback_dirs(workspace).is_empty());
    assert!(workspace_recovery_failure_reason(workspace).is_none());
}

#[test]
fn exdev_rename_falls_back_to_copy_and_publishes_snapshot() {
    let f = fixture();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(f.staged.join("c.txt"), fs::Permissions::from_mode(0o751)).unwrap();
        fs::set_permissions(f.staged.join("d"), fs::Permissions::from_mode(0o750)).unwrap();
    }

    publish_cross_device(&f.workspace, &f.staged).expect("cross-device publish");

    assert_eq!(
        fs::read_to_string(f.workspace.join("a.txt")).unwrap(),
        "new-a"
    );
    assert_eq!(
        fs::read_to_string(f.workspace.join("c.txt")).unwrap(),
        "new-c"
    );
    assert_eq!(
        fs::read_to_string(f.workspace.join("d").join("inner.txt")).unwrap(),
        "new-d"
    );
    assert!(!f.workspace.join("b").exists());
    assert_eq!(
        fs::read_to_string(f.workspace.join(".ModelScratchpad").join("scratch")).unwrap(),
        "keep"
    );
    assert!(rollback_dirs(&f.workspace).is_empty());
    assert!(workspace_recovery_failure_reason(&f.workspace).is_none());

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = |p: PathBuf| fs::symlink_metadata(p).unwrap().permissions().mode() & 0o7777;
        assert_eq!(mode(f.workspace.join("c.txt")), 0o751);
        assert_eq!(mode(f.workspace.join("d")), 0o750);
        // Symlinks are recreated verbatim, not dereferenced into copies.
        let link = f.workspace.join("d").join("link");
        assert!(
            fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(fs::read_link(&link).unwrap(), PathBuf::from("inner.txt"));
    }
}

#[test]
fn non_cross_device_rename_errors_do_not_fall_back_to_copy() {
    let f = fixture();
    let err = replace_directory_contents_with(&f.workspace, &f.staged, |src, dst| {
        place_staged_entry(src, dst, |_, _| {
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "injected rename denial",
            ))
        })
    })
    .expect_err("publish must fail");
    assert!(err.contains("injected rename denial"), "{err}");
    assert_originals_restored(&f.workspace);
}

#[test]
fn exdev_copy_failure_after_partial_copy_rolls_back_cleanly() {
    let f = fixture();
    let err = replace_directory_contents_with(&f.workspace, &f.staged, |src, dst| {
        place_staged_entry(src, dst, |_, _| Err(exdev()))?;
        if dst.file_name().is_some_and(|n| n == "d") {
            // The directory was fully copied; fail as if the copy broke right afterwards.
            return Err(io::Error::other("injected copy failure"));
        }
        Ok(())
    })
    .expect_err("publish must fail");
    assert!(err.contains("injected copy failure"), "{err}");
    assert_originals_restored(&f.workspace);
}

#[cfg(unix)]
#[test]
fn exdev_copy_failure_inside_directory_removes_partial_copy() {
    let f = fixture();
    // A socket is neither file, directory nor symlink, so the copy of `d/` fails part-way
    // through, after `d/` itself has been created in the workspace.
    let _listener =
        std::os::unix::net::UnixListener::bind(f.staged.join("d").join("sock")).unwrap();

    let err = publish_cross_device(&f.workspace, &f.staged).expect_err("publish must fail");
    assert!(err.contains("Unsupported staged entry type"), "{err}");
    assert!(err.contains("\"d\""), "{err}");
    assert_originals_restored(&f.workspace);
}

#[cfg(unix)]
#[test]
fn exdev_copy_never_writes_through_an_existing_destination_symlink() {
    let f = fixture();
    let outside = f.root.join("outside.txt");
    fs::write(&outside, "outside").unwrap();
    let dst = f.workspace.join("c.txt");
    std::os::unix::fs::symlink(&outside, &dst).unwrap();

    let err = place_staged_entry(&f.staged.join("c.txt"), &dst, |_, _| Err(exdev()))
        .expect_err("copy must refuse an existing destination");
    assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
    assert_eq!(fs::read_to_string(&outside).unwrap(), "outside");
    assert!(fs::symlink_metadata(&dst).unwrap().file_type().is_symlink());
}
