//! Regression tests: a transcript batch whose projection failed must still be
//! written by a retry with the same id, and never duplicated.

use std::fs;
use std::path::Path;
use std::sync::Arc;

use axum::http::{HeaderMap, Method, StatusCode};
use cowork_server::http_desktop::{WebDesktopService, handle_desktop_route};
use serde_json::json;

fn post_batch(svc: &WebDesktopService, cwd: &Path, batch_id: &str, text: &str) -> StatusCode {
    let body = serde_json::to_vec(&json!({
        "batchId": batch_id,
        "events": [
            { "threadId": "thread-a", "ts": "2026-01-01T00:00:00.000Z", "direction": "client", "payload": { "type": "message", "text": text } },
            { "threadId": "thread-b", "ts": "2026-01-01T00:00:00.000Z", "direction": "server", "payload": { "type": "message", "text": text } },
        ],
    }))
    .unwrap();
    handle_desktop_route(
        &Method::POST,
        "/cowork/desktop/transcript/batch",
        None,
        &HeaderMap::new(),
        &body,
        cwd,
        Some(svc),
    )
    .status()
}

fn line_count(path: &Path) -> usize {
    fs::read_to_string(path).map_or(0, |s| s.lines().count())
}

#[test]
fn failed_append_does_not_record_receipt_and_retry_persists() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("home");
    let user_data = tmp.path().join("userdata");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&user_data).unwrap();
    let svc = WebDesktopService::new(home, user_data.clone());
    let transcripts = user_data.join("transcripts");

    // Inject a storage failure: the transcripts directory path is a file.
    fs::write(&transcripts, "not a directory").unwrap();
    let status = post_batch(&svc, tmp.path(), "batch-1", "hello");
    assert!(
        status.is_server_error(),
        "storage failure must be a retryable 5xx, got {status}"
    );

    // Storage recovers; the retry with the same id must actually append.
    fs::remove_file(&transcripts).unwrap();
    assert_eq!(
        post_batch(&svc, tmp.path(), "batch-1", "hello"),
        StatusCode::NO_CONTENT
    );
    assert_eq!(line_count(&transcripts.join("thread-a.jsonl")), 1);
    assert_eq!(line_count(&transcripts.join("thread-b.jsonl")), 1);

    // A further duplicate is acknowledged without appending again.
    assert_eq!(
        post_batch(&svc, tmp.path(), "batch-1", "hello"),
        StatusCode::NO_CONTENT
    );
    assert_eq!(line_count(&transcripts.join("thread-a.jsonl")), 1);
    // Same id, different payload is still a conflict.
    assert_eq!(
        post_batch(&svc, tmp.path(), "batch-1", "different"),
        StatusCode::CONFLICT
    );
}

#[cfg(unix)]
#[test]
fn partial_projection_failure_does_not_duplicate_on_retry() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("home");
    let user_data = tmp.path().join("userdata");
    let transcripts = user_data.join("transcripts");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&transcripts).unwrap();
    let svc = WebDesktopService::new(home, user_data);

    // thread-b's file path is a directory, so projecting thread-b fails. As in
    // TS, the batch is committed to the SQLite inbox first and projected per
    // thread: thread-a's projection is recorded as done, thread-b's stays
    // pending.
    fs::create_dir_all(transcripts.join("thread-b.jsonl")).unwrap();
    let status = post_batch(&svc, tmp.path(), "batch-2", "hi");
    assert!(status.is_server_error(), "got {status}");
    assert_eq!(line_count(&transcripts.join("thread-a.jsonl")), 1);

    // The retry projects only what is still pending: no duplicate lines.
    fs::remove_dir(transcripts.join("thread-b.jsonl")).unwrap();
    assert_eq!(
        post_batch(&svc, tmp.path(), "batch-2", "hi"),
        StatusCode::NO_CONTENT
    );
    assert_eq!(line_count(&transcripts.join("thread-a.jsonl")), 1);
    assert_eq!(line_count(&transcripts.join("thread-b.jsonl")), 1);
}

#[test]
fn concurrent_same_id_batches_append_once() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("home");
    let user_data = tmp.path().join("userdata");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&user_data).unwrap();
    let svc = Arc::new(WebDesktopService::new(home, user_data.clone()));
    let cwd = tmp.path().to_path_buf();

    let handles: Vec<_> = (0..8)
        .map(|_| {
            let svc = Arc::clone(&svc);
            let cwd = cwd.clone();
            std::thread::spawn(move || post_batch(&svc, &cwd, "batch-3", "same"))
        })
        .collect();
    for h in handles {
        assert_eq!(h.join().unwrap(), StatusCode::NO_CONTENT);
    }
    let transcripts = user_data.join("transcripts");
    assert_eq!(line_count(&transcripts.join("thread-a.jsonl")), 1);
    assert_eq!(line_count(&transcripts.join("thread-b.jsonl")), 1);
}
