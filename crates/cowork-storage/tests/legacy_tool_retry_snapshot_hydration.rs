//! Pre-upgrade (TS-written) snapshots store tool-retry lineage in a versioned
//! `cowork.toolRetryMetadata` annotation instead of on the tool rows
//! (`encodeToolRetrySnapshotMetadata`, `src/shared/toolRetrySnapshot.ts`). `get_session_snapshot`
//! must expand it back like `hydrateToolRetrySnapshotMetadata` did.
//!
//! `fixtures/ts_tool_retry_metadata_snapshot.json` is real output of the origin/main TS encoder
//! (`encodeToolRetrySnapshotMetadata(sessionSnapshotSchema.parse(...))`, digest from
//! `digestToolInput("bash", { command: "bun test" })`).

use std::fs;
use std::path::PathBuf;

use cowork_config::canonicalize_sync;
use cowork_storage::{SessionDb, SessionDbOptions};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use uuid::Uuid;

const TS_FIXTURE: &str = include_str!("fixtures/ts_tool_retry_metadata_snapshot.json");

struct TempEnv {
    root: PathBuf,
    cowork_root: PathBuf,
    sessions_dir: PathBuf,
}

impl TempEnv {
    fn new() -> Self {
        let root_base = if cfg!(target_os = "macos") {
            PathBuf::from("/private/tmp")
        } else {
            std::env::temp_dir()
        };
        let root = root_base.join(format!("cowork-tool-retry-snapshot-{}", Uuid::new_v4()));
        let cowork_root = root.join("home").join(".cowork");
        let sessions_dir = cowork_root.join("sessions");
        fs::create_dir_all(&sessions_dir).expect("create sessions dir");
        Self {
            root: canonicalize_sync(&root),
            cowork_root: canonicalize_sync(&cowork_root),
            sessions_dir: canonicalize_sync(&sessions_dir),
        }
    }

    async fn open(&self) -> SessionDb {
        SessionDb::open(SessionDbOptions {
            root_dir: self.cowork_root.clone(),
            sessions_dir: self.sessions_dir.clone(),
            db_path: None,
            busy_timeout_ms: Some(5_000),
        })
        .await
        .expect("open session db")
    }

    /// Stores `raw` byte-for-byte as a pre-upgrade `session_snapshots` row.
    fn insert_raw_snapshot(&self, session_id: &str, raw: &str) {
        let conn = Connection::open(self.cowork_root.join("sessions.db")).unwrap();
        conn.execute_batch("PRAGMA foreign_keys = OFF").unwrap();
        conn.execute(
            "INSERT INTO session_snapshots (session_id, updated_at, snapshot_json)
             VALUES (?1, ?2, ?3)",
            params![session_id, "2026-07-10T00:00:00.000Z", raw],
        )
        .unwrap();
    }
}

impl Drop for TempEnv {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn feed_item<'a>(snapshot: &'a Value, id: &str) -> &'a Value {
    snapshot["feed"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == id)
        .unwrap_or_else(|| panic!("feed item {id}"))
}

#[tokio::test]
async fn ts_written_snapshot_restores_tool_retry_lineage() {
    let env = TempEnv::new();
    let db = env.open().await;
    env.insert_raw_snapshot("ts-retry-session", TS_FIXTURE);

    let snapshot = db
        .get_session_snapshot("ts-retry-session")
        .unwrap()
        .expect("snapshot");
    let digest = json!({
        "algorithm": "sha256",
        "value": "36cb26544b5f5f9586faeb9a4069f9bfb1d95462ae08ca68ca5d917a5452a696",
        "canonicalBytes": 49
    });

    let failed = feed_item(&snapshot, "tool-failed");
    assert_eq!(failed["inputDigest"], digest);
    assert!(failed.get("retryOf").is_none());

    let retry = feed_item(&snapshot, "tool-retry");
    assert_eq!(retry["inputDigest"], digest);
    assert_eq!(retry["retryOf"], "tool-failed");

    // The carrier annotation is consumed; the message itself is untouched.
    let assistant = feed_item(&snapshot, "assistant-1");
    assert!(assistant.get("annotations").is_none(), "{assistant}");
    assert_eq!(assistant["text"], "Tests pass now.");
    assert_eq!(snapshot["feed"].as_array().unwrap().len(), 4);
    db.close();
}

#[tokio::test]
async fn hydration_is_fail_closed_and_newest_entry_wins() {
    let env = TempEnv::new();
    let db = env.open().await;
    let digest = json!({
        "algorithm": "sha256",
        "value": "a".repeat(64),
        "canonicalBytes": 12
    });
    let newer_digest = json!({
        "algorithm": "sha256",
        "value": "b".repeat(64),
        "canonicalBytes": 13
    });
    let tool = |id: &str| json!({ "id": id, "kind": "tool", "ts": "t", "name": "bash", "state": "output-error" });
    let snapshot = json!({
        "sessionId": "s",
        "feed": [
            {
                "id": "older-msg", "kind": "message", "role": "user", "ts": "t", "text": "a",
                "annotations": [
                    { "type": "cowork.toolRetryMetadata", "version": 1,
                      "entries": [{ "itemId": "dup", "inputDigest": digest, "retryOf": "old" }] },
                    { "type": "cowork.unrelated", "version": 1 }
                ]
            },
            tool("dup"),
            tool("blank"),
            tool("bad-digest"),
            tool("future"),
            {
                "id": "newer-msg", "kind": "message", "role": "assistant", "ts": "t", "text": "b",
                "annotations": [
                    { "type": "cowork.toolRetryMetadata", "version": 2,
                      "entries": [{ "itemId": "future", "retryOf": "x" }] },
                    { "type": "cowork.toolRetryMetadata", "version": 1,
                      "entries": [
                          { "itemId": "dup", "inputDigest": newer_digest },
                          { "itemId": "   ", "retryOf": "x" },
                          { "itemId": "blank", "retryOf": "  " },
                          { "itemId": "bad-digest", "inputDigest": { "algorithm": "sha256", "value": "A".repeat(64), "canonicalBytes": 1 } }
                      ] }
                ]
            }
        ]
    });
    env.insert_raw_snapshot("s", &serde_json::to_string(&snapshot).unwrap());

    let hydrated = db.get_session_snapshot("s").unwrap().expect("snapshot");
    let dup = feed_item(&hydrated, "dup");
    assert_eq!(dup["inputDigest"], newer_digest);
    // The newest entry for an item replaces the older one entirely (TS `Map` first-wins on a
    // reverse scan), so the older `retryOf` is not merged in.
    assert!(dup.get("retryOf").is_none(), "{dup}");
    for id in ["blank", "bad-digest", "future"] {
        let item = feed_item(&hydrated, id);
        assert!(item.get("retryOf").is_none(), "{item}");
        assert!(item.get("inputDigest").is_none(), "{item}");
    }
    assert_eq!(
        feed_item(&hydrated, "older-msg")["annotations"],
        json!([{ "type": "cowork.unrelated", "version": 1 }])
    );
    // Unknown versions are left inert, exactly like the TS reader.
    assert_eq!(
        feed_item(&hydrated, "newer-msg")["annotations"],
        json!([{ "type": "cowork.toolRetryMetadata", "version": 2,
                 "entries": [{ "itemId": "future", "retryOf": "x" }] }])
    );
    db.close();
}

#[tokio::test]
async fn rust_written_snapshot_without_metadata_is_unchanged() {
    let env = TempEnv::new();
    let db = env.open().await;
    let snapshot = json!({
        "sessionId": "rust",
        "taskType": null,
        "targetPaths": null,
        "profile": null,
        "feed": [
            { "id": "retry-turn", "kind": "message", "role": "user", "ts": "t", "text": "retry",
              "annotations": [{ "type": "cowork.toolRetryTurn", "version": 1, "targetItemIds": ["t1"] }] },
            { "id": "t1", "kind": "tool", "ts": "t", "name": "bash", "state": "output-error",
              "retryOf": "t0", "inputDigest": { "algorithm": "sha256", "value": "c".repeat(64), "canonicalBytes": 3 } }
        ]
    });
    env.insert_raw_snapshot("rust", &serde_json::to_string(&snapshot).unwrap());
    assert_eq!(db.get_session_snapshot("rust").unwrap().unwrap(), snapshot);
    db.close();
}
