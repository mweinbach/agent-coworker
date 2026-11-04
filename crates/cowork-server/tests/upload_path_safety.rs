//! Regression tests: `cowork/session/file/upload` must only ever create a new file inside a
//! real `<workspace>/uploads` directory and must never follow a symlink planted there.

use std::fs;

use cowork_server::registry::{sanitize_workspace_upload_filename, write_workspace_upload};

#[test]
fn sanitizes_upload_filenames_to_a_single_component() {
    assert_eq!(
        sanitize_workspace_upload_filename("report.pdf").unwrap(),
        "report.pdf"
    );
    assert_eq!(
        sanitize_workspace_upload_filename("../../etc/passwd").unwrap(),
        "passwd"
    );
    assert_eq!(
        sanitize_workspace_upload_filename("..\\..\\Windows\\evil.dll").unwrap(),
        "evil.dll"
    );
    assert_eq!(
        sanitize_workspace_upload_filename("a:stream\u{1}.txt").unwrap(),
        "a_stream_.txt"
    );
    for bad in ["", "  ", ".", "..", "dir/", "dir/..", "..\\"] {
        assert!(
            sanitize_workspace_upload_filename(bad).is_err(),
            "{bad:?} must be rejected"
        );
    }
}

#[test]
fn writes_upload_inside_real_uploads_directory() {
    let tmp = tempfile::tempdir().unwrap();
    let ws = fs::canonicalize(tmp.path()).unwrap();
    let (name, path) = write_workspace_upload(&ws, "../notes.txt", b"hello").unwrap();
    assert_eq!(name, "notes.txt");
    assert_eq!(path.parent().unwrap(), ws.join("uploads"));
    assert!(
        path.file_name()
            .unwrap()
            .to_string_lossy()
            .ends_with("-notes.txt")
    );
    assert_eq!(fs::read(&path).unwrap(), b"hello");
    assert!(
        !fs::symlink_metadata(ws.join("uploads"))
            .unwrap()
            .file_type()
            .is_symlink()
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode & 0o077, 0, "upload must not be group/world accessible");
    }

    // A second upload reuses the existing real directory.
    let (_, second) = write_workspace_upload(&ws, "notes.txt", b"again").unwrap();
    assert_ne!(second, path);
    assert_eq!(fs::read(&second).unwrap(), b"again");
}

#[cfg(unix)]
#[test]
fn refuses_uploads_symlink_to_victim_directory() {
    let tmp = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(tmp.path()).unwrap();
    let attacker_ws = root.join("attacker-ws");
    let victim = root.join("victim");
    fs::create_dir_all(&attacker_ws).unwrap();
    fs::create_dir_all(&victim).unwrap();
    std::os::unix::fs::symlink(&victim, attacker_ws.join("uploads")).unwrap();

    let err = write_workspace_upload(&attacker_ws, "payload.sh", b"#!/bin/sh\n")
        .expect_err("symlinked uploads dir must be refused");
    assert!(err.contains("real directory"), "unexpected error: {err}");
    assert_eq!(
        fs::read_dir(&victim).unwrap().count(),
        0,
        "nothing may be written through the symlink"
    );
}

#[cfg(unix)]
#[test]
fn refuses_uploads_that_is_a_regular_file_or_dangling_symlink() {
    let tmp = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(tmp.path()).unwrap();

    let ws_file = root.join("ws-file");
    fs::create_dir_all(&ws_file).unwrap();
    fs::write(ws_file.join("uploads"), "not a dir").unwrap();
    assert!(write_workspace_upload(&ws_file, "x.txt", b"x").is_err());
    assert_eq!(
        fs::read_to_string(ws_file.join("uploads")).unwrap(),
        "not a dir"
    );

    // Dangling symlink: must not be "created through" (mkdir would follow it on some paths).
    let ws_dangling = root.join("ws-dangling");
    fs::create_dir_all(&ws_dangling).unwrap();
    let target = root.join("would-be-created");
    std::os::unix::fs::symlink(&target, ws_dangling.join("uploads")).unwrap();
    assert!(write_workspace_upload(&ws_dangling, "x.txt", b"x").is_err());
    assert!(!target.exists());
}
