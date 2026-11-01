//! Regression: `/fs/rename` must not treat a case-variant destination as a case-only rename of
//! the source when the directory really holds a distinct entry with that exact name (legacy
//! `renameWithoutReplacing` in `src/server/webDesktopRoutes.ts`).

use std::path::{Path, PathBuf};

use axum::http::StatusCode;
use cowork_server::http_fs::handle_fs_rename;

fn root() -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().expect("tempdir");
    let root = std::fs::canonicalize(tmp.path()).unwrap();
    (tmp, root)
}

fn rename(root: &Path, src: &Path, new_name: &str) -> Result<StatusCode, (StatusCode, String)> {
    let body = serde_json::to_vec(&serde_json::json!({
        "path": src.to_string_lossy(),
        "newName": new_name,
    }))
    .unwrap();
    handle_fs_rename(&[root.to_path_buf()], root, &body)
        .map(|res| res.status())
        .map_err(|err| (err.status, err.message))
}

fn names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

/// Probes whether the temp filesystem distinguishes `a` from `A`.
fn is_case_sensitive(dir: &Path) -> bool {
    let probe = dir.join("case-probe");
    std::fs::write(&probe, "").unwrap();
    let sensitive = std::fs::symlink_metadata(dir.join("CASE-PROBE")).is_err();
    std::fs::remove_file(probe).unwrap();
    sensitive
}

#[test]
fn case_variant_rename_onto_distinct_entry_conflicts_instead_of_replacing() {
    let (_tmp, root) = root();
    if !is_case_sensitive(&root) {
        eprintln!("skipping: temp filesystem is case-insensitive");
        return;
    }
    std::fs::write(root.join("Report.txt"), "upper").unwrap();
    std::fs::write(root.join("report.txt"), "lower").unwrap();

    let err = rename(&root, &root.join("Report.txt"), "report.txt").unwrap_err();
    assert_eq!(err.0, StatusCode::CONFLICT, "{err:?}");
    assert_eq!(names(&root), vec!["Report.txt", "report.txt"]);
    assert_eq!(
        std::fs::read_to_string(root.join("report.txt")).unwrap(),
        "lower"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("Report.txt")).unwrap(),
        "upper"
    );

    // Directories get the same protection.
    std::fs::create_dir(root.join("Docs")).unwrap();
    std::fs::create_dir(root.join("docs")).unwrap();
    std::fs::write(root.join("docs").join("keep.txt"), "keep").unwrap();
    let err = rename(&root, &root.join("Docs"), "docs").unwrap_err();
    assert_eq!(err.0, StatusCode::CONFLICT, "{err:?}");
    assert!(root.join("docs").join("keep.txt").exists());
}

#[test]
fn case_only_rename_without_distinct_entry_succeeds() {
    let (_tmp, root) = root();
    std::fs::write(root.join("Notes.md"), "notes").unwrap();

    assert_eq!(
        rename(&root, &root.join("Notes.md"), "notes.md"),
        Ok(StatusCode::NO_CONTENT)
    );
    assert_eq!(names(&root), vec!["notes.md"]);
    assert_eq!(
        std::fs::read_to_string(root.join("notes.md")).unwrap(),
        "notes"
    );
}

#[test]
fn rename_onto_different_existing_name_conflicts() {
    let (_tmp, root) = root();
    std::fs::write(root.join("a.txt"), "a").unwrap();
    std::fs::write(root.join("b.txt"), "b").unwrap();

    let err = rename(&root, &root.join("a.txt"), "b.txt").unwrap_err();
    assert_eq!(err.0, StatusCode::CONFLICT, "{err:?}");
    assert_eq!(std::fs::read_to_string(root.join("b.txt")).unwrap(), "b");

    assert_eq!(
        rename(&root, &root.join("a.txt"), "c.txt"),
        Ok(StatusCode::NO_CONTENT)
    );
    assert_eq!(names(&root), vec!["b.txt", "c.txt"]);
}
