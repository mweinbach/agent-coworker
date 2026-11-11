//! Transcript inbox identity and capacity boundaries.
//!
//! Batch ids and thread ids are checked before the SQLite inbox is created, so a
//! path-like thread id cannot be joined onto `transcripts/<id>.jsonl`. Pending
//! receipts count toward the cap and are not pruned; completed receipts above the
//! cap are dropped oldest-first. A projection whose JSONL payload no longer
//! matches the stored event conflicts and must not be rewritten.

use std::fs;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use cowork_server::desktop_transcript_inbox::{
    TRANSCRIPT_DEDUPE_MAX_BATCHES, is_safe_thread_id, is_valid_batch_id,
};
use cowork_server::http_desktop::{WebDesktopService, handle_desktop_route};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

struct Fixture {
    _tmp: tempfile::TempDir,
    user_data: PathBuf,
    cwd: PathBuf,
    svc: WebDesktopService,
}

impl Fixture {
    fn new() -> Self {
        let tmp = tempfile::tempdir().expect("tempdir");
        let base = fs::canonicalize(tmp.path()).expect("canonicalize tempdir");
        let home = base.join("home");
        let user_data = base.join("userdata");
        let cwd = base.join("workspace");
        for dir in [&home, &user_data, &cwd] {
            fs::create_dir_all(dir).expect("create fixture dir");
        }
        let svc = WebDesktopService::new(home, user_data.clone());
        Self {
            _tmp: tmp,
            user_data,
            cwd,
            svc,
        }
    }

    fn db_path(&self) -> PathBuf {
        self.user_data.join("transcript-inbox.sqlite")
    }

    fn transcript_path(&self, thread_id: &str) -> PathBuf {
        self.user_data
            .join("transcripts")
            .join(format!("{thread_id}.jsonl"))
    }
}

fn event(thread_id: &str, text: &str) -> Value {
    json!({
        "threadId": thread_id,
        "ts": "2026-01-01T00:00:00.000Z",
        "direction": "client",
        "payload": { "text": text }
    })
}

fn batch(batch_id: &str, thread_id: &str, text: &str) -> Value {
    json!({ "batchId": batch_id, "events": [event(thread_id, text)] })
}

fn post(fix: &Fixture, idempotency_key: Option<&str>, body: &Value) -> (StatusCode, String) {
    let bytes = serde_json::to_vec(body).expect("body");
    let mut headers = HeaderMap::new();
    if let Some(key) = idempotency_key {
        headers.insert(
            "idempotency-key",
            HeaderValue::from_str(key).expect("header value"),
        );
    }
    let response = handle_desktop_route(
        &Method::POST,
        "/cowork/desktop/transcript/batch",
        None,
        &headers,
        &bytes,
        &fix.cwd,
        Some(&fix.svc),
    );
    let status = response.status();
    let body = tokio::runtime::Builder::new_current_thread()
        .build()
        .expect("runtime")
        .block_on(axum::body::to_bytes(response.into_body(), usize::MAX))
        .expect("response body");
    (status, String::from_utf8_lossy(&body).into_owned())
}

fn open_db(fix: &Fixture) -> Connection {
    let conn = Connection::open(fix.db_path()).expect("open inbox");
    conn.busy_timeout(Duration::from_secs(5))
        .expect("busy timeout");
    conn.execute_batch("PRAGMA foreign_keys = ON;")
        .expect("foreign keys");
    conn
}

fn batch_count(fix: &Fixture) -> i64 {
    if !fix.db_path().exists() {
        return 0;
    }
    open_db(fix)
        .query_row("SELECT COUNT(*) FROM transcript_batches", [], |row| {
            row.get(0)
        })
        .expect("count batches")
}

fn batch_exists(fix: &Fixture, batch_id: &str) -> bool {
    if !fix.db_path().exists() {
        return false;
    }
    open_db(fix)
        .query_row(
            "SELECT 1 FROM transcript_batches WHERE batch_id = ?",
            [batch_id],
            |_| Ok(()),
        )
        .optional()
        .expect("lookup batch")
        .is_some()
}

fn assert_no_inbox_files(fix: &Fixture) {
    assert!(
        !fix.db_path().exists(),
        "rejected ids must not create the inbox database"
    );
    assert!(
        !fix.user_data.join("transcripts").exists(),
        "rejected ids must not create the transcripts directory"
    );
    assert!(!fix.user_data.join("outside.jsonl").exists());
    assert!(!fix.transcript_path("../outside").exists());
    assert!(!fix.transcript_path("nested/name").exists());
    assert!(!fix.transcript_path("..").exists());
}

fn bootstrap_schema(fix: &Fixture) {
    let (status, body) = post(fix, None, &batch("schema-seed", "schema-thread", "seed"));
    assert_eq!(
        (status, body.as_str()),
        (StatusCode::NO_CONTENT, ""),
        "schema bootstrap"
    );
    let conn = open_db(fix);
    conn.execute_batch(
        "DELETE FROM transcript_events;
         DELETE FROM transcript_batches;
         DELETE FROM transcript_generations;",
    )
    .expect("clear seeded inbox");
    drop(conn);
    let transcripts = fix.user_data.join("transcripts");
    if transcripts.exists() {
        fs::remove_dir_all(&transcripts).expect("remove transcripts");
    }
}

fn fill_batches(conn: &mut Connection, state: &str, count: i64, timestamp_at: impl Fn(i64) -> i64) {
    let tx = conn.transaction().expect("begin seed");
    {
        let mut stmt = tx
            .prepare(
                "INSERT INTO transcript_batches(
                    batch_id, digest, state, event_count, byte_count, created_at_ms, completed_at_ms
                 ) VALUES(?1, 'seed', ?2, 0, 0, ?3, ?4)",
            )
            .expect("prepare seed");
        for index in 0..count {
            let id = if state == "completed" && index == 0 {
                "completed-oldest".to_owned()
            } else {
                format!("{state}-{index:05}")
            };
            let timestamp = timestamp_at(index);
            let completed_at = (state == "completed").then_some(timestamp);
            stmt.execute(params![id, state, timestamp, completed_at])
                .expect("insert seed batch");
        }
    }
    tx.commit().expect("commit seed");
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_millis() as i64
}

#[test]
fn unsafe_batch_and_thread_ids_are_rejected_before_any_transcript_is_written() {
    assert!(is_valid_batch_id(&"a".repeat(256)));
    assert!(!is_valid_batch_id(&"a".repeat(257)));
    assert!(is_valid_batch_id("batch.name_1:part-2"));
    assert!(!is_valid_batch_id(""));
    assert!(!is_valid_batch_id("a/b"));
    assert!(!is_valid_batch_id("a\\b"));
    assert!(!is_valid_batch_id("has space"));
    assert!(!is_valid_batch_id("batché"));
    assert!(!is_valid_batch_id("batch\nid"));

    assert!(is_safe_thread_id(&"t".repeat(256)));
    assert!(!is_safe_thread_id(&"t".repeat(257)));
    for thread_id in [
        "../outside",
        "nested/name",
        "nested\\name",
        "thread.id",
        "..",
        "café",
        "bad\0id",
        "has space",
        "",
    ] {
        assert!(!is_safe_thread_id(thread_id), "{thread_id:?}");
    }

    let fix = Fixture::new();
    let rejected_batches = [
        "../escape",
        "has space",
        "batch\\id",
        "a/b",
        "batché",
        "batch\nid",
    ];
    for batch_id in rejected_batches {
        let (status, body) = post(&fix, None, &batch(batch_id, "kept-thread", "nope"));
        assert_eq!(status, StatusCode::BAD_REQUEST, "{batch_id:?} -> {body}");
        assert_eq!(body, "batchId contains invalid characters");
    }
    let too_long = "a".repeat(257);
    let (status, body) = post(&fix, None, &batch(&too_long, "kept-thread", "nope"));
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body, "batchId contains invalid characters");

    let (status, body) = post(&fix, Some("a/b"), &json!([event("kept-thread", "header")]));
    assert_eq!(
        (status, body.as_str()),
        (
            StatusCode::BAD_REQUEST,
            "batchId contains invalid characters"
        )
    );

    let too_long_thread = "t".repeat(257);
    for (index, thread_id) in [
        "../outside",
        "nested/name",
        "nested\\name",
        "thread.id",
        "..",
        "café",
        "bad\0id",
        too_long_thread.as_str(),
    ]
    .into_iter()
    .enumerate()
    {
        let (status, body) = post(
            &fix,
            None,
            &batch(&format!("reject-thread-{index}"), thread_id, "nope"),
        );
        assert_eq!(status, StatusCode::BAD_REQUEST, "{thread_id:?} -> {body}");
        assert_eq!(body, "threadId contains invalid characters");
    }
    assert_no_inbox_files(&fix);

    let accepted = "a".repeat(256);
    assert_eq!(
        post(&fix, None, &batch(&accepted, "kept-thread", "long")).0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        post(
            &fix,
            None,
            &batch("batch.name_1:part-2", "kept-thread", "charset")
        )
        .0,
        StatusCode::NO_CONTENT
    );

    let lines = fs::read_to_string(fix.transcript_path("kept-thread"))
        .expect("accepted transcript")
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("jsonl"))
        .collect::<Vec<_>>();
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[0]["deliveryId"], json!(format!("{accepted}:0")));
    assert_eq!(lines[1]["deliveryId"], json!("batch.name_1:part-2:0"));
    assert_eq!(batch_count(&fix), 2);
    assert!(!fix.user_data.join("outside.jsonl").exists());
    let transcripts = fs::read_dir(fix.user_data.join("transcripts")).expect("transcripts");
    let names = transcripts
        .map(|entry| entry.unwrap().file_name())
        .collect::<Vec<_>>();
    assert_eq!(names, vec![std::ffi::OsString::from("kept-thread.jsonl")]);
}

#[test]
fn idempotency_key_is_trimmed_and_must_match_the_body_batch_id() {
    let fix = Fixture::new();
    let (status, body) = post(
        &fix,
        Some("header-batch"),
        &batch("body-batch", "mismatch-thread", "nope"),
    );
    assert_eq!(
        (status, body.as_str()),
        (
            StatusCode::BAD_REQUEST,
            "Idempotency-Key must match batchId"
        )
    );
    assert_no_inbox_files(&fix);

    assert_eq!(
        post(
            &fix,
            Some("   "),
            &batch("blank-header-batch", "blank-thread", "kept")
        )
        .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        post(
            &fix,
            Some("  trimmed-batch  "),
            &batch("trimmed-batch", "trimmed-thread", "kept")
        )
        .0,
        StatusCode::NO_CONTENT
    );

    let blank = fs::read_to_string(fix.transcript_path("blank-thread")).expect("blank header");
    let trimmed =
        fs::read_to_string(fix.transcript_path("trimmed-thread")).expect("trimmed header");
    assert!(blank.contains("\"deliveryId\":\"blank-header-batch:0\""));
    assert!(trimmed.contains("\"deliveryId\":\"trimmed-batch:0\""));
    assert!(!fix.transcript_path("mismatch-thread").exists());
    assert!(!batch_exists(&fix, "header-batch"));
    assert!(!batch_exists(&fix, "body-batch"));
    assert!(batch_exists(&fix, "blank-header-batch"));
    assert!(batch_exists(&fix, "trimmed-batch"));
}

#[test]
fn pending_batches_fill_the_inbox_and_are_not_evicted() {
    let fix = Fixture::new();
    bootstrap_schema(&fix);
    let mut conn = open_db(&fix);
    fill_batches(&mut conn, "pending", TRANSCRIPT_DEDUPE_MAX_BATCHES, |_| 1);
    drop(conn);
    assert_eq!(batch_count(&fix), TRANSCRIPT_DEDUPE_MAX_BATCHES);

    let (status, body) = post(
        &fix,
        None,
        &batch("overflow-batch", "overflow-thread", "new"),
    );
    assert_eq!(
        (status, body.as_str()),
        (
            StatusCode::SERVICE_UNAVAILABLE,
            "Transcript inbox capacity reached"
        )
    );
    assert_eq!(batch_count(&fix), TRANSCRIPT_DEDUPE_MAX_BATCHES);
    assert!(!batch_exists(&fix, "overflow-batch"));
    assert!(batch_exists(&fix, "pending-00000"));
    assert!(batch_exists(
        &fix,
        &format!("pending-{:05}", TRANSCRIPT_DEDUPE_MAX_BATCHES - 1)
    ));
    assert!(!fix.transcript_path("overflow-thread").exists());
    assert!(!fix.user_data.join("transcripts").exists());
}

#[test]
fn completed_batches_above_the_cap_are_evicted_oldest_first() {
    let fix = Fixture::new();
    bootstrap_schema(&fix);
    let now = now_ms();
    let mut conn = open_db(&fix);
    fill_batches(
        &mut conn,
        "completed",
        TRANSCRIPT_DEDUPE_MAX_BATCHES,
        |index| now - 120_000 + index,
    );
    drop(conn);

    let (status, body) = post(&fix, None, &batch("fresh-batch", "fresh-thread", "fresh"));
    assert_eq!(
        (status, body.as_str()),
        (StatusCode::NO_CONTENT, ""),
        "a full inbox of completed receipts must still accept a batch"
    );
    assert_eq!(batch_count(&fix), TRANSCRIPT_DEDUPE_MAX_BATCHES);
    assert!(!batch_exists(&fix, "completed-oldest"));
    assert!(batch_exists(
        &fix,
        &format!("completed-{:05}", TRANSCRIPT_DEDUPE_MAX_BATCHES - 1)
    ));
    assert!(batch_exists(&fix, "fresh-batch"));
    let line = fs::read_to_string(fix.transcript_path("fresh-thread")).expect("fresh transcript");
    assert!(line.contains("\"deliveryId\":\"fresh-batch:0\""));
    assert!(line.contains("\"text\":\"fresh\""));
}

#[test]
fn tampered_projection_conflicts_and_is_not_rewritten() {
    let fix = Fixture::new();
    let body = batch("conflict-batch", "conflict-thread", "first");
    assert_eq!(post(&fix, None, &body).0, StatusCode::NO_CONTENT);

    let path = fix.transcript_path("conflict-thread");
    let original = fs::read_to_string(&path).expect("projection");
    let mut line: Value = serde_json::from_str(original.trim()).expect("projected json");
    line["payload"]["text"] = json!("tampered");
    let tampered = format!("{}\n", serde_json::to_string(&line).expect("tampered json"));
    assert!(tampered.contains("\"text\":\"tampered\""));
    assert!(!tampered.contains("\"text\":\"first\""));
    fs::write(&path, &tampered).expect("tamper projection");

    let conn = open_db(&fix);
    conn.execute(
        "UPDATE transcript_events SET projected = 0 WHERE batch_id = 'conflict-batch'",
        [],
    )
    .expect("reset projected");
    conn.execute(
        "UPDATE transcript_batches SET state = 'pending', completed_at_ms = NULL WHERE batch_id = 'conflict-batch'",
        [],
    )
    .expect("reset batch");
    drop(conn);

    let (status, message) = post(&fix, None, &body);
    assert_eq!(status, StatusCode::CONFLICT, "{message}");
    assert_eq!(
        message,
        "Idempotency key conflicts with the existing transcript projection"
    );
    assert_eq!(
        fs::read_to_string(&path).expect("projection after conflict"),
        tampered
    );
    assert_eq!(
        fs::read_to_string(&path)
            .expect("line count")
            .lines()
            .count(),
        1
    );

    let conn = open_db(&fix);
    let (event_json, projected, state): (String, i64, String) = conn
        .query_row(
            "SELECT events.event_json, events.projected, batches.state
             FROM transcript_events AS events
             JOIN transcript_batches AS batches ON batches.batch_id = events.batch_id
             WHERE events.batch_id = 'conflict-batch'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("stored event");
    let stored: Value = serde_json::from_str(&event_json).expect("event_json");
    assert_eq!(stored["payload"]["text"], "first");
    assert_eq!(projected, 0);
    assert_eq!(state, "pending");
}
