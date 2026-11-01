//! Deferred directory modes while materializing snapshots that hold read-only directories.
//!
//! These assert the ordering directly (directories stay owner-writable until materialization
//! finishes, and the archived modes are applied afterwards), so they catch a regression even when
//! run as root, which ignores directory write bits.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use super::{
    DeferredDirModes, MODEL_SCRATCHPAD_DIRNAME, copy_snapshot_directory_confined,
    extract_snapshot_tar_gz_deferred, move_entry_to_new_parent, remove_dir_all_force,
    write_snapshot_tar_gz,
};

/// Temp dir whose directories are made owner-writable again before removal, so cleanup also
/// works for an unprivileged user.
struct Scratch {
    tmp: Option<tempfile::TempDir>,
    root: PathBuf,
}

impl Drop for Scratch {
    fn drop(&mut self) {
        make_writable(&self.root);
        drop(self.tmp.take());
    }
}

fn scratch() -> Scratch {
    let tmp = tempfile::tempdir().expect("tempdir");
    let root = fs::canonicalize(tmp.path()).unwrap();
    Scratch {
        tmp: Some(tmp),
        root,
    }
}

fn make_writable(path: &Path) {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return;
    };
    if !meta.is_dir() {
        return;
    }
    let mode = meta.permissions().mode() & 0o7777;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(mode | 0o700));
    for entry in fs::read_dir(path).unwrap().flatten() {
        make_writable(&entry.path());
    }
}

fn mode_of(path: &Path) -> u32 {
    fs::symlink_metadata(path).unwrap().permissions().mode() & 0o7777
}

fn set_mode(path: &Path, mode: u32) {
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
}

/// `locked/` (0555) holding a file and `locked/inner/` (0555) holding a file.
fn populate(root: &Path) {
    fs::create_dir_all(root.join("locked/inner")).unwrap();
    fs::write(root.join("locked/file.txt"), "locked").unwrap();
    fs::write(root.join("locked/inner/deep.txt"), "deep").unwrap();
    set_mode(&root.join("locked/inner"), 0o555);
    set_mode(&root.join("locked"), 0o555);
}

fn assert_deferred_then_applied(dest: &Path, deferred: &DeferredDirModes) {
    // Before the deferred modes are applied every directory is still owner-writable, and the
    // archived modes are what was recorded.
    for rel in ["locked", "locked/inner"] {
        assert_eq!(
            mode_of(&dest.join(rel)) & 0o700,
            0o700,
            "{rel} must stay owner-writable while materializing"
        );
        assert_eq!(deferred.modes.get(Path::new(rel)), Some(&0o555), "{rel}");
    }
    assert_eq!(
        fs::read_to_string(dest.join("locked/inner/deep.txt")).unwrap(),
        "deep"
    );
    assert_eq!(
        fs::read_to_string(dest.join("locked/file.txt")).unwrap(),
        "locked"
    );

    deferred.apply();
    assert_eq!(mode_of(&dest.join("locked")), 0o555);
    assert_eq!(mode_of(&dest.join("locked/inner")), 0o555);
}

#[test]
fn tar_extraction_defers_directory_modes_until_children_exist() {
    let s = scratch();
    let source = s.root.join("source");
    fs::create_dir_all(&source).unwrap();
    populate(&source);
    let archive = s.root.join("snap/snapshot.tar.gz");
    write_snapshot_tar_gz(&source, &archive).unwrap();

    let dest = s.root.join("dest");
    let deferred = extract_snapshot_tar_gz_deferred(&archive, &dest).unwrap();
    assert_deferred_then_applied(&dest, &deferred);
}

#[test]
fn directory_snapshot_copy_defers_directory_modes_until_children_exist() {
    let s = scratch();
    let snapshot = s.root.join("snapshot");
    fs::create_dir_all(&snapshot).unwrap();
    populate(&snapshot);

    let dest = s.root.join("dest");
    let deferred = copy_snapshot_directory_confined(&snapshot, &dest).unwrap();
    assert_deferred_then_applied(&dest, &deferred);
}

#[test]
fn deferred_modes_skip_unpublished_top_level_names_and_symlinks() {
    let s = scratch();
    let workspace = s.root.join("workspace");
    let outside = s.root.join("outside");
    fs::create_dir_all(workspace.join(MODEL_SCRATCHPAD_DIRNAME)).unwrap();
    fs::create_dir_all(workspace.join("real")).unwrap();
    fs::create_dir_all(&outside).unwrap();
    set_mode(&workspace.join(MODEL_SCRATCHPAD_DIRNAME), 0o755);
    set_mode(&outside, 0o755);
    std::os::unix::fs::symlink(&outside, workspace.join("link")).unwrap();

    let mut deferred = DeferredDirModes::new(s.root.join("stage"));
    deferred.record(Path::new(MODEL_SCRATCHPAD_DIRNAME), 0o500);
    deferred.record(Path::new("link"), 0o500);
    deferred.record(Path::new("real"), 0o550);
    deferred.apply_to_workspace(&workspace);

    assert_eq!(mode_of(&workspace.join(MODEL_SCRATCHPAD_DIRNAME)), 0o755);
    assert_eq!(
        mode_of(&outside),
        0o755,
        "symlink target must not be chmodded"
    );
    assert_eq!(mode_of(&workspace.join("real")), 0o550);
}

#[test]
fn force_removal_handles_populated_read_only_directories() {
    let s = scratch();
    let tree = s.root.join("tree");
    fs::create_dir_all(&tree).unwrap();
    populate(&tree);
    let outside = s.root.join("outside");
    fs::create_dir_all(&outside).unwrap();
    set_mode(&outside, 0o555);
    std::os::unix::fs::symlink(&outside, tree.join("link")).unwrap();

    remove_dir_all_force(&tree).unwrap();
    assert!(!tree.exists());
    assert_eq!(
        mode_of(&outside),
        0o555,
        "symlink target must not be chmodded"
    );
}

#[test]
fn moving_a_read_only_directory_to_a_new_parent_keeps_its_contents() {
    let s = scratch();
    let src_parent = s.root.join("workspace");
    let dst_parent = s.root.join("rollback");
    fs::create_dir_all(&src_parent).unwrap();
    fs::create_dir_all(&dst_parent).unwrap();
    populate(&src_parent);

    let relaxed = move_entry_to_new_parent(&src_parent.join("locked"), &dst_parent.join("locked"))
        .expect("move read-only directory");
    let moved = dst_parent.join("locked");
    assert_eq!(
        fs::read_to_string(moved.join("file.txt")).unwrap(),
        "locked"
    );
    match relaxed {
        // Unprivileged: the directory had to be made owner-writable to be moved.
        Some(mode) => {
            assert_eq!(mode, 0o555);
            assert_eq!(mode_of(&moved) & 0o200, 0o200);
        }
        // Root moves it without relaxing anything.
        None => assert_eq!(mode_of(&moved), 0o555),
    }
}
