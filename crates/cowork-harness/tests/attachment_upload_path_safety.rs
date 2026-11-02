//! Regression tests: inline turn attachments are staged into `<uploads>/User Uploads/` without
//! following workspace-controlled symlinks and without escaping via the client filename.

use std::fs;

use cowork_config::ProviderName;
use cowork_harness::attachments::create_new_file_no_follow;
use cowork_harness::materialize_turn_attachments;
use cowork_protocol::TurnInput;
use serde_json::json;

const PNG_B64: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4//8/AwAI/AL+X6ixAAAAAElFTkSuQmCC";

fn inline_file(filename: &str) -> cowork_protocol::ExtractedTurnInput {
    TurnInput::Parts(vec![
        json!({ "type": "text", "text": "see attached" }),
        json!({
            "type": "file",
            "filename": filename,
            "mimeType": "text/plain",
            "contentBase64": PNG_B64
        }),
    ])
    .extract_payload()
    .unwrap()
}

#[test]
fn stages_inside_real_user_uploads_and_sanitizes_traversing_names() {
    let tmp = tempfile::tempdir().unwrap();
    let ws = fs::canonicalize(tmp.path()).unwrap();
    let uploads = ws.join("uploads");

    for name in ["../../escape.txt", "..\\..\\escape.txt", "/etc/escape.txt"] {
        let m =
            materialize_turn_attachments(&inline_file(name), &uploads, &ws, ProviderName::Openai)
                .unwrap();
        assert_eq!(m.staged_files.len(), 1);
        let staged = &m.staged_files[0];
        assert_eq!(staged.parent().unwrap(), uploads.join("User Uploads"));
        assert!(staged.is_file());
    }
    assert!(!ws.join("escape.txt").exists());
    assert!(!tmp.path().parent().unwrap().join("escape.txt").exists());

    // Same name twice gets a collision-free second name; nothing is overwritten.
    let a =
        materialize_turn_attachments(&inline_file("dup.txt"), &uploads, &ws, ProviderName::Openai)
            .unwrap();
    let b =
        materialize_turn_attachments(&inline_file("dup.txt"), &uploads, &ws, ProviderName::Openai)
            .unwrap();
    assert_ne!(a.staged_files[0], b.staged_files[0]);
    assert!(a.staged_files[0].is_file() && b.staged_files[0].is_file());
}

#[cfg(unix)]
#[test]
fn refuses_symlinked_uploads_or_user_uploads_directory() {
    let tmp = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(tmp.path()).unwrap();
    let victim = root.join("victim");
    fs::create_dir_all(&victim).unwrap();

    // `<ws>/uploads -> victim`
    let ws1 = root.join("ws1");
    fs::create_dir_all(&ws1).unwrap();
    std::os::unix::fs::symlink(&victim, ws1.join("uploads")).unwrap();
    let err = materialize_turn_attachments(
        &inline_file("a.txt"),
        &ws1.join("uploads"),
        &ws1,
        ProviderName::Openai,
    )
    .expect_err("symlinked uploads must be refused");
    assert!(err.contains("real directory"), "unexpected error: {err}");

    // `<ws>/uploads/User Uploads -> victim`
    let ws2 = root.join("ws2");
    fs::create_dir_all(ws2.join("uploads")).unwrap();
    std::os::unix::fs::symlink(&victim, ws2.join("uploads/User Uploads")).unwrap();
    let err = materialize_turn_attachments(
        &inline_file("a.txt"),
        &ws2.join("uploads"),
        &ws2,
        ProviderName::Openai,
    )
    .expect_err("symlinked User Uploads must be refused");
    assert!(err.contains("real directory"), "unexpected error: {err}");

    assert_eq!(fs::read_dir(&victim).unwrap().count(), 0);
}

#[cfg(unix)]
#[test]
fn shared_helper_never_follows_or_overwrites_a_planted_file_symlink() {
    let tmp = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(tmp.path()).unwrap();
    let target = root.join("victim.txt");
    fs::write(&target, "victim").unwrap();
    fs::create_dir_all(root.join("ws/uploads")).unwrap();
    std::os::unix::fs::symlink(&target, root.join("ws/uploads/f.txt")).unwrap();

    assert!(create_new_file_no_follow(&root.join("ws"), &["uploads"], "f.txt").is_err());
    assert_eq!(fs::read_to_string(&target).unwrap(), "victim");
    for bad in ["", ".", "..", "a/b", "a\\b"] {
        assert!(create_new_file_no_follow(&root, &[bad], "x").is_err());
        assert!(create_new_file_no_follow(&root, &[], bad).is_err());
    }
}
