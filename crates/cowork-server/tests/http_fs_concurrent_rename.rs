//! Regression: concurrent `/cowork/fs/rename` and `/cowork/fs/trash` requests that target the same
//! destination must never replace one another's entries. The legacy `renameWithoutReplacing` in
//! `src/server/webDesktopRoutes.ts` serialized the destination check and the rename per
//! destination (`pendingRenames`); a bare check-then-`rename` lets two requests both pass the
//! check, and the second rename then silently overwrites the first file.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Barrier};

use axum::http::StatusCode;
use cowork_server::http_fs::{handle_fs_rename, handle_fs_trash};

const WORKERS: usize = 24;
const ROUNDS: usize = 15;

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

fn trash(root: &Path, src: &Path) -> Result<StatusCode, (StatusCode, String)> {
    let body = serde_json::to_vec(&serde_json::json!({ "path": src.to_string_lossy() })).unwrap();
    handle_fs_trash(&[root.to_path_buf()], root, &body)
        .map(|res| res.status())
        .map_err(|err| (err.status, err.message))
}

#[test]
fn trash_uses_the_innermost_workspace() {
    let (_tmp, outer) = root();
    let inner = outer.join("project");
    std::fs::create_dir(&inner).unwrap();
    let file = inner.join("notes.txt");
    std::fs::write(&file, "nested workspace").unwrap();
    let roots = [outer.clone(), inner.clone()];
    let body = serde_json::to_vec(&serde_json::json!({ "path": file })).unwrap();
    assert_eq!(
        handle_fs_trash(&roots, &outer, &body).unwrap().status(),
        StatusCode::NO_CONTENT
    );
    assert!(!outer.join(".cowork-trash").exists());
    let entry = std::fs::read_dir(inner.join(".cowork-trash"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(entry.path()).unwrap(),
        "nested workspace"
    );
    let body = serde_json::to_vec(&serde_json::json!({ "path": entry.path() })).unwrap();
    assert_eq!(
        handle_fs_trash(&roots, &outer, &body).unwrap_err().status,
        StatusCode::BAD_REQUEST
    );
}

/// Runs `job(i)` on `WORKERS` threads released together by a barrier.
fn run_concurrently<T: Send + 'static>(job: impl Fn(usize) -> T + Send + Sync + 'static) -> Vec<T> {
    let job = Arc::new(job);
    let barrier = Arc::new(Barrier::new(WORKERS));
    let handles: Vec<_> = (0..WORKERS)
        .map(|i| {
            let job = Arc::clone(&job);
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                job(i)
            })
        })
        .collect();
    handles.into_iter().map(|h| h.join().unwrap()).collect()
}

#[test]
fn concurrent_renames_onto_one_name_keep_every_file() {
    for round in 0..ROUNDS {
        let (_tmp, root) = root();
        for i in 0..WORKERS {
            std::fs::write(root.join(format!("src-{i}.txt")), format!("content-{i}")).unwrap();
        }

        let job_root = root.clone();
        let results = run_concurrently(move |i| {
            rename(
                &job_root,
                &job_root.join(format!("src-{i}.txt")),
                "target.txt",
            )
        });

        let winners: Vec<usize> = results
            .iter()
            .enumerate()
            .filter(|(_, r)| **r == Ok(StatusCode::NO_CONTENT))
            .map(|(i, _)| i)
            .collect();
        assert_eq!(winners.len(), 1, "round {round}: {results:?}");
        for (i, result) in results.iter().enumerate() {
            if i == winners[0] {
                continue;
            }
            assert_eq!(
                result,
                &Err((
                    StatusCode::CONFLICT,
                    "An entry with that name already exists".to_owned()
                )),
                "round {round}, worker {i}"
            );
        }

        // No content lost: the winner's bytes are at the destination, every loser is untouched.
        let winner = winners[0];
        assert_eq!(
            std::fs::read_to_string(root.join("target.txt")).unwrap(),
            format!("content-{winner}"),
            "round {round}"
        );
        assert!(!root.join(format!("src-{winner}.txt")).exists());
        for i in (0..WORKERS).filter(|i| *i != winner) {
            assert_eq!(
                std::fs::read_to_string(root.join(format!("src-{i}.txt"))).unwrap(),
                format!("content-{i}"),
                "round {round}, worker {i}"
            );
        }
    }
}

#[test]
fn concurrent_directory_renames_onto_one_name_keep_every_directory() {
    let (_tmp, root) = root();
    for i in 0..WORKERS {
        let dir = root.join(format!("dir-{i}"));
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(dir.join("marker.txt"), format!("dir-{i}")).unwrap();
    }

    let job_root = root.clone();
    let results =
        run_concurrently(move |i| rename(&job_root, &job_root.join(format!("dir-{i}")), "merged"));
    let winners: Vec<usize> = (0..WORKERS)
        .filter(|i| results[*i] == Ok(StatusCode::NO_CONTENT))
        .collect();
    assert_eq!(winners.len(), 1, "{results:?}");
    assert!(
        results
            .iter()
            .filter(|r| r.is_err())
            .all(|r| matches!(r, Err((StatusCode::CONFLICT, _))))
    );
    assert_eq!(
        std::fs::read_to_string(root.join("merged").join("marker.txt")).unwrap(),
        format!("dir-{}", winners[0])
    );
    for i in (0..WORKERS).filter(|i| *i != winners[0]) {
        assert_eq!(
            std::fs::read_to_string(root.join(format!("dir-{i}")).join("marker.txt")).unwrap(),
            format!("dir-{i}")
        );
    }
}

#[test]
fn concurrent_trash_of_same_basename_keeps_every_entry() {
    for round in 0..ROUNDS {
        let (_tmp, root) = root();
        // Same basename in different directories: every request computes the same
        // `<timestamp>-notes.txt` trash name when they land in the same millisecond.
        for i in 0..WORKERS {
            let dir = root.join(format!("d{i}"));
            std::fs::create_dir(&dir).unwrap();
            std::fs::write(dir.join("notes.txt"), format!("notes-{i}")).unwrap();
        }

        let job_root = root.clone();
        let results =
            run_concurrently(move |i| trash(&job_root, &job_root.join(format!("d{i}/notes.txt"))));
        assert!(
            results.iter().all(|r| *r == Ok(StatusCode::NO_CONTENT)),
            "round {round}: {results:?}"
        );

        let mut trashed: Vec<String> = std::fs::read_dir(root.join(".cowork-trash"))
            .unwrap()
            .map(|e| std::fs::read_to_string(e.unwrap().path()).unwrap())
            .collect();
        trashed.sort();
        let mut expected: Vec<String> = (0..WORKERS).map(|i| format!("notes-{i}")).collect();
        expected.sort();
        assert_eq!(trashed, expected, "round {round}");
    }
}
