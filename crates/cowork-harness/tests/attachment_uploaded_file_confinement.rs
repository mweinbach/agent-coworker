//! Regression tests: an `uploadedFile` turn attachment may only reference a regular file inside
//! the uploads directory (`userMessageAttachments.ts` `resolveUploadedAttachmentPath` parity).
//! Workspace files outside it, a symlink inside it, and a path through a symlinked directory
//! that lands outside it are refused before any bytes reach the provider request.

use std::fs;
use std::path::Path;

use cowork_harness::materialize_turn_attachments;
use cowork_inference::{ContentBlock, MediaSource};
use cowork_protocol::{ExtractedTurnInput, TurnInput};
use serde_json::json;

const SECRET: &[u8] = b"\x89PNG\r\n\x1a\nTOP-SECRET-WORKSPACE-BYTES";

fn uploaded(path: &Path, mime: &str) -> ExtractedTurnInput {
    uploaded_named(path, "image.png", mime)
}

fn uploaded_named(path: &Path, filename: &str, mime: &str) -> ExtractedTurnInput {
    TurnInput::Parts(vec![
        json!({ "type": "text", "text": "see attached" }),
        json!({
            "type": "uploadedFile",
            "filename": filename,
            "path": path.to_string_lossy(),
            "mimeType": mime,
        }),
    ])
    .extract_payload()
    .unwrap()
}

fn media_bytes(blocks: &[ContentBlock]) -> Vec<Vec<u8>> {
    blocks
        .iter()
        .filter_map(|b| match b {
            ContentBlock::Media {
                source: MediaSource::Base64 { data, .. },
                ..
            } => Some(data_encoding::BASE64.decode(data.as_bytes()).unwrap()),
            _ => None,
        })
        .collect()
}

struct Fixture {
    _tmp: tempfile::TempDir,
    root: std::path::PathBuf,
    ws: std::path::PathBuf,
    uploads: std::path::PathBuf,
}

fn fixture() -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(tmp.path()).unwrap();
    let ws = root.join("ws");
    let uploads = ws.join("uploads");
    fs::create_dir_all(&uploads).unwrap();
    Fixture {
        _tmp: tmp,
        root,
        ws,
        uploads,
    }
}

fn assert_refused(input: &ExtractedTurnInput, f: &Fixture) {
    let err = materialize_turn_attachments(input, &f.uploads, &f.ws)
        .expect_err("uploadedFile outside the uploads directory must be refused");
    assert!(
        err.contains("outside the uploads directory") || err.contains("symbolic link"),
        "unexpected error: {err}"
    );
}

#[test]
fn genuine_upload_is_attached() {
    let f = fixture();
    let file = f.uploads.join("abc-image.png");
    fs::write(&file, SECRET).unwrap();

    let m = materialize_turn_attachments(&uploaded(&file, "image/png"), &f.uploads, &f.ws).unwrap();
    assert_eq!(media_bytes(&m.content_blocks), vec![SECRET.to_vec()]);
    assert!(m.display_text.contains("abc-image.png"));

    // Files staged under `<uploads>/User Uploads/` and relative paths resolve inside uploads.
    fs::create_dir_all(f.uploads.join("User Uploads")).unwrap();
    fs::write(f.uploads.join("User Uploads/x.png"), SECRET).unwrap();
    let rel = Path::new("User Uploads/x.png");
    let m = materialize_turn_attachments(&uploaded(rel, "image/png"), &f.uploads, &f.ws).unwrap();
    assert_eq!(media_bytes(&m.content_blocks), vec![SECRET.to_vec()]);
}

#[test]
fn non_media_upload_is_noted_without_reading_bytes() {
    let f = fixture();
    let file = f.uploads.join("notes.txt");
    fs::write(&file, b"hello").unwrap();
    let m = materialize_turn_attachments(
        &uploaded_named(&file, "notes.txt", "text/plain"),
        &f.uploads,
        &f.ws,
    )
    .unwrap();
    assert!(media_bytes(&m.content_blocks).is_empty());
    assert!(m.display_text.contains("notes.txt"));
}

#[test]
fn workspace_file_outside_uploads_is_refused() {
    let f = fixture();
    let secret = f.ws.join("secret.png");
    fs::write(&secret, SECRET).unwrap();
    assert_refused(&uploaded(&secret, "image/png"), &f);

    // `..` traversal out of uploads, absolute or relative.
    assert_refused(&uploaded(&f.uploads.join("../secret.png"), "image/png"), &f);
    assert_refused(&uploaded(Path::new("../secret.png"), "image/png"), &f);

    // Files outside the workspace entirely.
    let outside = f.root.join("outside.png");
    fs::write(&outside, SECRET).unwrap();
    assert_refused(&uploaded(&outside, "image/png"), &f);
}

#[test]
fn uploads_directory_equal_to_workspace_does_not_expose_workspace() {
    // `resolveDir` falls back to the workspace root for an out-of-workspace configured
    // uploads directory; that must not turn every workspace file into an "upload".
    let f = fixture();
    let secret = f.ws.join("secret.png");
    fs::write(&secret, SECRET).unwrap();
    let err = materialize_turn_attachments(&uploaded(&secret, "image/png"), &f.ws, &f.ws)
        .expect_err("workspace file must not count as an upload");
    assert!(err.contains("outside the uploads directory"), "{err}");

    // Inline attachments staged under `<ws>/User Uploads/` and the upload route's
    // `<ws>/uploads/` stay referenceable.
    fs::create_dir_all(f.ws.join("User Uploads")).unwrap();
    let staged = f.ws.join("User Uploads/a.png");
    fs::write(&staged, SECRET).unwrap();
    materialize_turn_attachments(&uploaded(&staged, "image/png"), &f.ws, &f.ws).unwrap();
    let routed = f.uploads.join("b.png");
    fs::write(&routed, SECRET).unwrap();
    materialize_turn_attachments(&uploaded(&routed, "image/png"), &f.ws, &f.ws).unwrap();
}

#[test]
fn configured_uploads_dir_and_upload_route_dir_are_both_accepted() {
    let f = fixture();
    let configured = f.ws.join("configured-uploads");
    fs::create_dir_all(&configured).unwrap();
    let a = configured.join("a.png");
    fs::write(&a, SECRET).unwrap();
    // `cowork/session/file/upload` always writes `<ws>/uploads/`.
    let b = f.uploads.join("b.png");
    fs::write(&b, SECRET).unwrap();
    for p in [&a, &b] {
        let m =
            materialize_turn_attachments(&uploaded(p, "image/png"), &configured, &f.ws).unwrap();
        assert_eq!(media_bytes(&m.content_blocks), vec![SECRET.to_vec()]);
    }
    let secret = f.ws.join("secret.png");
    fs::write(&secret, SECRET).unwrap();
    assert!(
        materialize_turn_attachments(&uploaded(&secret, "image/png"), &configured, &f.ws).is_err()
    );
}

#[test]
fn directory_or_missing_upload_is_refused() {
    let f = fixture();
    fs::create_dir_all(f.uploads.join("dir.png")).unwrap();
    assert!(
        materialize_turn_attachments(
            &uploaded(&f.uploads.join("dir.png"), "image/png"),
            &f.uploads,
            &f.ws
        )
        .is_err()
    );
    assert!(
        materialize_turn_attachments(
            &uploaded(&f.uploads.join("missing.png"), "image/png"),
            &f.uploads,
            &f.ws
        )
        .is_err()
    );
}

#[cfg(unix)]
#[test]
fn symlink_inside_uploads_pointing_outside_is_refused() {
    let f = fixture();
    let secret = f.ws.join("secret.png");
    fs::write(&secret, SECRET).unwrap();
    let link = f.uploads.join("link.png");
    std::os::unix::fs::symlink(&secret, &link).unwrap();
    assert_refused(&uploaded(&link, "image/png"), &f);

    let outside = f.root.join("outside.png");
    fs::write(&outside, SECRET).unwrap();
    let link2 = f.uploads.join("link2.png");
    std::os::unix::fs::symlink(&outside, &link2).unwrap();
    assert_refused(&uploaded(&link2, "image/png"), &f);
}

#[cfg(unix)]
#[test]
fn intermediate_directory_symlink_escaping_uploads_is_refused() {
    let f = fixture();
    let private = f.ws.join("private");
    fs::create_dir_all(&private).unwrap();
    fs::write(private.join("secret.png"), SECRET).unwrap();
    std::os::unix::fs::symlink(&private, f.uploads.join("dir")).unwrap();
    assert_refused(
        &uploaded(&f.uploads.join("dir/secret.png"), "image/png"),
        &f,
    );
    assert_refused(&uploaded(Path::new("dir/secret.png"), "image/png"), &f);

    let outside = f.root.join("outside");
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("secret.png"), SECRET).unwrap();
    std::os::unix::fs::symlink(&outside, f.uploads.join("dir2")).unwrap();
    assert_refused(
        &uploaded(&f.uploads.join("dir2/secret.png"), "image/png"),
        &f,
    );
}

#[cfg(unix)]
#[test]
fn symlinked_uploads_directory_is_refused() {
    // `<ws>/uploads -> <ws>/private`: the uploads directory itself redirects into the workspace.
    let tmp = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(tmp.path()).unwrap();
    let ws = root.join("ws");
    let private = ws.join("private");
    fs::create_dir_all(&private).unwrap();
    fs::write(private.join("secret.png"), SECRET).unwrap();
    std::os::unix::fs::symlink(&private, ws.join("uploads")).unwrap();
    let uploads = ws.join("uploads");
    assert!(
        materialize_turn_attachments(
            &uploaded(&uploads.join("secret.png"), "image/png"),
            &uploads,
            &ws
        )
        .is_err()
    );
}

#[cfg(unix)]
#[test]
fn fifo_in_uploads_is_refused_without_blocking() {
    let f = fixture();
    let fifo = f.uploads.join("pipe.png");
    let c = std::ffi::CString::new(fifo.to_string_lossy().as_bytes()).unwrap();
    // SAFETY: valid NUL-terminated path.
    assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
    assert!(
        materialize_turn_attachments(&uploaded(&fifo, "image/png"), &f.uploads, &f.ws).is_err()
    );
}
