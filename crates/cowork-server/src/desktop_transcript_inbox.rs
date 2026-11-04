//! Port of origin/main `src/server/transcriptInbox.ts`.
//!
//! Desktop transcript batches are committed to `<userData>/transcript-inbox.sqlite`
//! first (same schema as TS, so a store written by the TS server is picked up
//! as-is), then projected into `<userData>/transcripts/<threadId>.jsonl`.
//! Batches left `pending` after a crash or failed projection are projected on
//! the next append or read of that thread (`projectPending`). Per-thread
//! generation tombstones live in `transcript_generations`; deleting a thread
//! bumps its generation and cancels unprojected events from older
//! generations, so late retries from the client cannot resurrect a deleted
//! transcript.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use cowork_config::{ensure_private_dir_sync, harden_private_file_sync};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

pub const TRANSCRIPT_REQUEST_MAX_EVENTS: usize = 100;
pub const TRANSCRIPT_EVENTS_MAX_BYTES: usize = 256 * 1024;
const TRANSCRIPT_REQUEST_ENVELOPE_RESERVE_BYTES: usize = 16 * 1024;
pub const TRANSCRIPT_REQUEST_BODY_MAX_BYTES: usize =
    TRANSCRIPT_EVENTS_MAX_BYTES + TRANSCRIPT_REQUEST_ENVELOPE_RESERVE_BYTES;
pub const TRANSCRIPT_DEDUPE_MAX_BATCHES: i64 = 10_000;
pub const TRANSCRIPT_DEDUPE_RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1_000;
/// Largest integer JS can represent exactly (`Number.MAX_SAFE_INTEGER`).
pub const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

pub const DATABASE_FILE_NAME: &str = "transcript-inbox.sqlite";

const SCHEMA: &str = "\
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS transcript_batches (
  batch_id TEXT PRIMARY KEY,
  digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending', 'completed')),
  event_count INTEGER NOT NULL,
  byte_count INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER
);
CREATE TABLE IF NOT EXISTS transcript_events (
  delivery_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES transcript_batches(batch_id) ON DELETE CASCADE,
  event_index INTEGER NOT NULL,
  thread_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  event_json TEXT NOT NULL,
  projected INTEGER NOT NULL DEFAULT 0 CHECK(projected IN (0, 1)),
  canceled INTEGER NOT NULL DEFAULT 0 CHECK(canceled IN (0, 1)),
  UNIQUE(batch_id, event_index)
);
CREATE TABLE IF NOT EXISTS transcript_generations (
  thread_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL,
  tombstoned_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_transcript_batches_state_created
  ON transcript_batches(state, created_at_ms);
CREATE INDEX IF NOT EXISTS idx_transcript_events_projection
  ON transcript_events(projected, canceled, thread_id, batch_id, event_index);
CREATE INDEX IF NOT EXISTS idx_transcript_events_batch
  ON transcript_events(batch_id, event_index);
";

/// Error carrying the HTTP status TS attaches to `TranscriptInboxError`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranscriptInboxError {
    pub status: u16,
    pub message: String,
}

impl TranscriptInboxError {
    pub fn new(message: impl Into<String>, status: u16) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for TranscriptInboxError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for TranscriptInboxError {}

/// One validated transcript event (`TranscriptInboxEvent`). Field order
/// matches the object the TS route builds, so the batch digest serializes the
/// same top-level shape.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptInboxEvent {
    pub thread_id: String,
    pub ts: String,
    pub direction: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generation: Option<i64>,
}

/// Line written to the JSONL projection (`ProjectedTranscriptEvent`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectedTranscriptEvent<'a> {
    ts: &'a str,
    thread_id: &'a str,
    direction: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    payload: Option<&'a Value>,
    delivery_id: &'a str,
}

pub fn is_valid_batch_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 256
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
}

pub fn is_safe_thread_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 256
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

enum Fail {
    Inbox(TranscriptInboxError),
    Sql(rusqlite::Error),
    Io(std::io::Error),
}

impl From<rusqlite::Error> for Fail {
    fn from(e: rusqlite::Error) -> Self {
        Self::Sql(e)
    }
}

impl From<std::io::Error> for Fail {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}

impl From<TranscriptInboxError> for Fail {
    fn from(e: TranscriptInboxError) -> Self {
        Self::Inbox(e)
    }
}

/// `rethrowOperational`: busy/locked databases are a retryable 503, other
/// storage failures a 500 with a generic message.
fn rethrow_operational(fail: Fail, message: &str) -> TranscriptInboxError {
    match fail {
        Fail::Inbox(e) => e,
        Fail::Sql(e) => {
            let locked = matches!(
                e.sqlite_error_code(),
                Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked)
            ) || {
                let detail = e.to_string().to_lowercase();
                detail.contains("database is locked") || detail.contains("database locked")
            };
            if locked {
                TranscriptInboxError::new("Transcript inbox is busy", 503)
            } else {
                tracing::warn!(error = %e, "{message}");
                TranscriptInboxError::new(message, 500)
            }
        }
        Fail::Io(e) => {
            tracing::warn!(error = %e, "{message}");
            TranscriptInboxError::new(message, 500)
        }
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

struct Projection {
    /// deliveryId -> parsed line.
    events: HashMap<String, Value>,
    needs_newline: bool,
}

fn read_projection(path: &Path) -> std::io::Result<Projection> {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e),
    };
    let mut events = HashMap::new();
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(parsed) = serde_json::from_str::<Value>(trimmed)
            && let Some(id) = parsed.get("deliveryId").and_then(Value::as_str)
        {
            events.insert(id.to_owned(), parsed);
        }
    }
    Ok(Projection {
        events,
        needs_newline: !raw.is_empty() && !raw.ends_with('\n'),
    })
}

#[derive(Debug)]
pub struct TranscriptInbox {
    user_data_dir: PathBuf,
    database_path: PathBuf,
    transcripts_dir: PathBuf,
    max_batches: i64,
    retention_ms: i64,
    /// Serializes in-process writers; SQLite `BEGIN IMMEDIATE` plus the busy
    /// timeout covers other processes sharing the store.
    lock: parking_lot::Mutex<bool>,
}

impl TranscriptInbox {
    pub fn new(user_data_dir: &Path) -> Self {
        Self {
            user_data_dir: user_data_dir.to_path_buf(),
            database_path: user_data_dir.join(DATABASE_FILE_NAME),
            transcripts_dir: user_data_dir.join("transcripts"),
            max_batches: TRANSCRIPT_DEDUPE_MAX_BATCHES,
            retention_ms: TRANSCRIPT_DEDUPE_RETENTION_MS,
            lock: parking_lot::Mutex::new(false),
        }
    }

    pub fn database_path(&self) -> &Path {
        &self.database_path
    }

    pub fn transcript_file_path(&self, thread_id: &str) -> Result<PathBuf, TranscriptInboxError> {
        if !is_safe_thread_id(thread_id) {
            return Err(TranscriptInboxError::new(
                "threadId contains invalid characters",
                400,
            ));
        }
        Ok(self.transcripts_dir.join(format!("{thread_id}.jsonl")))
    }

    /// TS constructor work (private dir, private DB file, WAL), done lazily on
    /// first use so a missing user-data dir surfaces as a request error.
    fn ensure_initialized(&self, initialized: &mut bool) -> Result<(), Fail> {
        if *initialized {
            return Ok(());
        }
        ensure_private_dir_sync(&self.user_data_dir)
            .map_err(|e| Fail::Io(std::io::Error::other(e.to_string())))?;
        let mut opts = std::fs::OpenOptions::new();
        opts.append(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        drop(opts.open(&self.database_path)?);
        harden_private_file_sync(&self.database_path);
        let conn = self.open_raw()?;
        conn.query_row("PRAGMA journal_mode = WAL", [], |_| Ok(()))?;
        drop(conn);
        self.harden_database_files();
        *initialized = true;
        Ok(())
    }

    fn harden_database_files(&self) {
        for suffix in ["", "-wal", "-shm"] {
            let path = PathBuf::from(format!("{}{suffix}", self.database_path.display()));
            if path.exists() {
                harden_private_file_sync(&path);
            }
        }
    }

    fn open_raw(&self) -> Result<Connection, rusqlite::Error> {
        let conn = Connection::open(&self.database_path)?;
        conn.busy_timeout(Duration::from_millis(5_000))?;
        conn.execute_batch(SCHEMA)?;
        Ok(conn)
    }

    fn with_immediate_transaction<T>(
        &self,
        initialized: &mut bool,
        op: impl FnOnce(&Transaction<'_>) -> Result<T, Fail>,
    ) -> Result<T, Fail> {
        self.ensure_initialized(initialized)?;
        let mut conn = self.open_raw()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let result = op(&tx)?;
        tx.commit()?;
        drop(conn);
        self.harden_database_files();
        Ok(result)
    }

    /// `appendBatch(events, batchId)`.
    pub fn append_batch(
        &self,
        events: &[TranscriptInboxEvent],
        batch_id: &str,
    ) -> Result<(), TranscriptInboxError> {
        if !is_valid_batch_id(batch_id) {
            return Err(TranscriptInboxError::new(
                "batchId contains invalid characters",
                400,
            ));
        }
        if events.is_empty() || events.len() > TRANSCRIPT_REQUEST_MAX_EVENTS {
            return Err(TranscriptInboxError::new(
                format!("Transcript batches must contain 1-{TRANSCRIPT_REQUEST_MAX_EVENTS} events"),
                413,
            ));
        }
        if events.iter().any(|e| !is_safe_thread_id(&e.thread_id)) {
            return Err(TranscriptInboxError::new(
                "threadId contains invalid characters",
                400,
            ));
        }
        let serialized = serde_json::to_string(events)
            .map_err(|e| TranscriptInboxError::new(e.to_string(), 400))?;
        let byte_count = serialized.len();
        if byte_count > TRANSCRIPT_EVENTS_MAX_BYTES {
            return Err(TranscriptInboxError::new(
                "Transcript batch exceeds the request byte limit",
                413,
            ));
        }
        let digest = hex::encode(Sha256::digest(serialized.as_bytes()));
        let timestamp = now_ms();

        let mut initialized = self.lock.lock();
        self.with_immediate_transaction(&mut initialized, |db| {
            let existing: Option<String> = db
                .query_row(
                    "SELECT digest FROM transcript_batches WHERE batch_id = ?",
                    [batch_id],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(existing) = existing {
                if existing != digest && !matches_typescript_receipt(db, batch_id, events, &existing)? {
                    return Err(TranscriptInboxError::new(
                        "Idempotency key was reused with different transcript data",
                        409,
                    )
                    .into());
                }
                complete_settled_batches(db, timestamp)?;
                return Ok(());
            }
            self.prune(db, timestamp, 1)?;
            let count: i64 =
                db.query_row("SELECT COUNT(*) FROM transcript_batches", [], |r| r.get(0))?;
            if count >= self.max_batches {
                return Err(TranscriptInboxError::new("Transcript inbox capacity reached", 503).into());
            }
            db.execute(
                "INSERT INTO transcript_batches(batch_id, digest, state, event_count, byte_count, created_at_ms) VALUES(?, ?, 'pending', ?, ?, ?)",
                params![batch_id, digest, events.len() as i64, byte_count as i64, timestamp],
            )?;
            for (index, event) in events.iter().enumerate() {
                let current = read_generation_in_database(db, &event.thread_id)?;
                let generation = event.generation.unwrap_or(current);
                let delivery_id = format!("{batch_id}:{index}");
                let projected = ProjectedTranscriptEvent {
                    ts: &event.ts,
                    thread_id: &event.thread_id,
                    direction: &event.direction,
                    payload: event.payload.as_ref(),
                    delivery_id: &delivery_id,
                };
                let event_json = serde_json::to_string(&projected)
                    .map_err(|e| TranscriptInboxError::new(e.to_string(), 400))?;
                db.execute(
                    "INSERT INTO transcript_events(delivery_id, batch_id, event_index, thread_id, generation, event_json, canceled) VALUES(?, ?, ?, ?, ?, ?, ?)",
                    params![
                        delivery_id,
                        batch_id,
                        index as i64,
                        event.thread_id,
                        generation,
                        event_json,
                        i64::from(generation != current),
                    ],
                )?;
            }
            complete_settled_batches(db, timestamp)?;
            Ok(())
        })
        .map_err(|f| rethrow_operational(f, "Unable to commit transcript batch"))?;

        let mut seen: Vec<&str> = Vec::new();
        for event in events {
            if !seen.contains(&event.thread_id.as_str()) {
                seen.push(&event.thread_id);
            }
        }
        for thread_id in seen {
            self.project_pending_locked(&mut initialized, Some(thread_id))?;
        }
        Ok(())
    }

    /// `projectPending(threadId?)`: projects committed-but-unprojected batches
    /// (crash recovery, including batches committed by the TS server).
    pub fn project_pending(&self, thread_id: Option<&str>) -> Result<(), TranscriptInboxError> {
        let mut initialized = self.lock.lock();
        self.project_pending_locked(&mut initialized, thread_id)
    }

    fn project_pending_locked(
        &self,
        initialized: &mut bool,
        thread_id: Option<&str>,
    ) -> Result<(), TranscriptInboxError> {
        let batch_ids = (|| -> Result<Vec<String>, Fail> {
            self.ensure_initialized(initialized)?;
            let conn = self.open_raw()?;
            // Insertion order: timestamps can tie or move backward, and batch ids are opaque.
            let ids = match thread_id {
                Some(tid) => {
                    let mut stmt = conn.prepare(
                        "SELECT batch_id FROM transcript_batches AS batches WHERE state = 'pending' AND EXISTS (SELECT 1 FROM transcript_events AS events WHERE events.batch_id = batches.batch_id AND events.projected = 0 AND events.canceled = 0 AND events.thread_id = ?) ORDER BY batches.rowid",
                    )?;
                    stmt.query_map([tid], |r| r.get::<_, String>(0))?
                        .collect::<Result<Vec<_>, _>>()?
                }
                None => {
                    let mut stmt = conn.prepare(
                        "SELECT batch_id FROM transcript_batches WHERE state = 'pending' ORDER BY rowid",
                    )?;
                    stmt.query_map([], |r| r.get::<_, String>(0))?
                        .collect::<Result<Vec<_>, _>>()?
                }
            };
            Ok(ids)
        })()
        .map_err(|f| rethrow_operational(f, "Unable to read pending transcript batches"))?;
        for batch_id in batch_ids {
            self.project_batch(initialized, &batch_id, thread_id)?;
        }
        Ok(())
    }

    fn project_batch(
        &self,
        initialized: &mut bool,
        batch_id: &str,
        thread_id: Option<&str>,
    ) -> Result<(), TranscriptInboxError> {
        // Files extended by this projection, truncated back if the transaction
        // does not commit so a retry never sees a half-recorded projection.
        let mut appended: Vec<(PathBuf, u64)> = Vec::new();
        let result = self.with_immediate_transaction(initialized, |db| {
            let rows: Vec<(String, String, i64, String)> = {
                let mut stmt = db.prepare(
                    "SELECT delivery_id, thread_id, generation, event_json FROM transcript_events WHERE batch_id = ?1 AND projected = 0 AND canceled = 0 AND (?2 IS NULL OR thread_id = ?2) ORDER BY event_index",
                )?;
                stmt.query_map(params![batch_id, thread_id], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
                })?
                .collect::<Result<Vec<_>, _>>()?
            };
            let mut projections: HashMap<String, Projection> = HashMap::new();
            let mut order: Vec<String> = Vec::new();
            let mut append_by_thread: HashMap<String, Vec<String>> = HashMap::new();
            for (delivery_id, row_thread, generation, event_json) in rows {
                if read_generation_in_database(db, &row_thread)? != generation {
                    db.execute(
                        "UPDATE transcript_events SET canceled = 1 WHERE delivery_id = ?",
                        [&delivery_id],
                    )?;
                    continue;
                }
                let path = self.transcript_file_path(&row_thread)?;
                if !projections.contains_key(&row_thread) {
                    projections.insert(row_thread.clone(), read_projection(&path)?);
                }
                let projection = projections
                    .get_mut(&row_thread)
                    .expect("projection inserted above");
                let row_value: Value = serde_json::from_str(&event_json).unwrap_or(Value::Null);
                match projection.events.get(&delivery_id) {
                    Some(existing) if *existing != row_value => {
                        return Err(TranscriptInboxError::new(
                            "Idempotency key conflicts with the existing transcript projection",
                            409,
                        )
                        .into());
                    }
                    Some(_) => {}
                    None => {
                        if !append_by_thread.contains_key(&row_thread) {
                            order.push(row_thread.clone());
                        }
                        append_by_thread
                            .entry(row_thread.clone())
                            .or_default()
                            .push(event_json);
                        projection.events.insert(delivery_id, row_value);
                    }
                }
            }
            ensure_private_dir_sync(&self.transcripts_dir)
                .map_err(|e| Fail::Io(std::io::Error::other(e.to_string())))?;
            for thread in &order {
                let path = self.transcript_file_path(thread)?;
                let leading = if projections.get(thread).is_some_and(|p| p.needs_newline) {
                    "\n"
                } else {
                    ""
                };
                let lines = &append_by_thread[thread];
                let chunk = format!("{leading}{}\n", lines.join("\n"));
                let mut opts = std::fs::OpenOptions::new();
                opts.append(true).create(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    opts.mode(0o600);
                }
                let mut file = opts.open(&path)?;
                let original_len = file.metadata()?.len();
                appended.push((path.clone(), original_len));
                file.write_all(chunk.as_bytes())?;
                file.sync_data()?;
                harden_private_file_sync(&path);
            }
            db.execute(
                "UPDATE transcript_events SET projected = 1 WHERE batch_id = ?1 AND projected = 0 AND canceled = 0 AND (?2 IS NULL OR thread_id = ?2)",
                params![batch_id, thread_id],
            )?;
            let ts = now_ms();
            complete_settled_batches(db, ts)?;
            self.prune(db, ts, 0)?;
            Ok(())
        });
        if let Err(fail) = result {
            for (path, len) in &appended {
                if let Ok(f) = std::fs::OpenOptions::new().write(true).open(path) {
                    let _ = f.set_len(*len);
                }
            }
            return Err(rethrow_operational(
                fail,
                "Unable to project transcript batch",
            ));
        }
        Ok(())
    }

    /// `deleteThread(threadId, targetGeneration?)`: tombstones the thread's
    /// generation, cancels unprojected events from older generations, and
    /// removes the projection. Returns the resulting generation.
    pub fn delete_thread(
        &self,
        thread_id: &str,
        target_generation: Option<i64>,
    ) -> Result<i64, TranscriptInboxError> {
        if !is_safe_thread_id(thread_id) {
            return Err(TranscriptInboxError::new(
                "threadId contains invalid characters",
                400,
            ));
        }
        if let Some(target) = target_generation
            && !(1..=MAX_SAFE_INTEGER).contains(&target)
        {
            return Err(TranscriptInboxError::new(
                "generation must be a positive integer",
                400,
            ));
        }
        let path = self.transcript_file_path(thread_id)?;
        let mut initialized = self.lock.lock();
        self.with_immediate_transaction(&mut initialized, |db| {
            let current = read_generation_in_database(db, thread_id)?;
            if let Some(target) = target_generation
                && target <= current
            {
                return Ok(current);
            }
            let generation = target_generation.unwrap_or(current + 1);
            if !(0..=MAX_SAFE_INTEGER).contains(&generation) {
                return Err(TranscriptInboxError::new(
                    "generation must be a non-negative integer",
                    400,
                )
                .into());
            }
            db.execute(
                "INSERT INTO transcript_generations(thread_id, generation, tombstoned_at_ms) VALUES(?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET generation = excluded.generation, tombstoned_at_ms = excluded.tombstoned_at_ms",
                params![thread_id, generation, now_ms()],
            )?;
            db.execute(
                "UPDATE transcript_events SET canceled = 1 WHERE thread_id = ? AND generation < ? AND projected = 0",
                params![thread_id, generation],
            )?;
            match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => {
                    return Err(TranscriptInboxError::new(
                        "Unable to delete transcript projection",
                        500,
                    )
                    .into());
                }
            }
            complete_settled_batches(db, now_ms())?;
            Ok(generation)
        })
        .map_err(|f| rethrow_operational(f, "Unable to tombstone transcript"))
    }

    /// `readGeneration(threadId)`.
    pub fn read_generation(&self, thread_id: &str) -> Result<i64, TranscriptInboxError> {
        let mut initialized = self.lock.lock();
        (|| -> Result<i64, Fail> {
            self.ensure_initialized(&mut initialized)?;
            let conn = self.open_raw()?;
            Ok(read_generation_in_database(&conn, thread_id)?)
        })()
        .map_err(|f| rethrow_operational(f, "Unable to read transcript generation"))
    }

    fn prune(&self, db: &Connection, timestamp: i64, reserve: i64) -> Result<(), rusqlite::Error> {
        db.execute(
            "DELETE FROM transcript_batches WHERE state = 'completed' AND completed_at_ms IS NOT NULL AND completed_at_ms < ?",
            [timestamp - self.retention_ms],
        )?;
        let count: i64 =
            db.query_row("SELECT COUNT(*) FROM transcript_batches", [], |r| r.get(0))?;
        let excess = count + reserve - self.max_batches;
        if excess <= 0 {
            return Ok(());
        }
        db.execute(
            "DELETE FROM transcript_batches WHERE batch_id IN (SELECT batch_id FROM transcript_batches WHERE state = 'completed' ORDER BY completed_at_ms, created_at_ms LIMIT ?)",
            [excess],
        )?;
        Ok(())
    }
}

fn matches_typescript_receipt(
    db: &Connection,
    batch_id: &str,
    events: &[TranscriptInboxEvent],
    digest: &str,
) -> rusqlite::Result<bool> {
    // The TS receipt hashed JSON.stringify after Zod ordered the event fields.
    // Its projection kept those exact bytes, including nested payload key order,
    // except that it appended deliveryId in place of the optional generation.
    let mut stmt = db.prepare(
        "SELECT event_json FROM transcript_events WHERE batch_id = ? ORDER BY event_index",
    )?;
    let mut rows = stmt.query([batch_id])?;
    let mut original = String::from("[");
    for (index, event) in events.iter().enumerate() {
        let Some(row) = rows.next()? else {
            return Ok(false);
        };
        let projected: String = row.get(0)?;
        let suffix = format!(r#","deliveryId":"{batch_id}:{index}"}}"#);
        let Some(fields) = projected.strip_suffix(&suffix) else {
            return Ok(false);
        };
        if index != 0 {
            original.push(',');
        }
        original.push_str(fields);
        if let Some(generation) = event.generation {
            original.push_str(r#","generation":"#);
            original.push_str(&generation.to_string());
        }
        original.push('}');
    }
    original.push(']');
    if rows.next()?.is_some() || hex::encode(Sha256::digest(original.as_bytes())) != digest {
        return Ok(false);
    }
    // Verify the retry supplied the same events, in the same order. The receipt
    // above distinguishes omitted and explicit generations even when the inbox
    // resolved both to the same integer.
    let Ok(stored) = serde_json::from_str::<Value>(&original) else {
        return Ok(false);
    };
    Ok(serde_json::to_value(events).is_ok_and(|retry| stored == retry))
}

fn complete_settled_batches(db: &Connection, timestamp: i64) -> Result<(), rusqlite::Error> {
    db.execute(
        "UPDATE transcript_batches SET state = 'completed', completed_at_ms = ? WHERE state = 'pending' AND NOT EXISTS (SELECT 1 FROM transcript_events WHERE transcript_events.batch_id = transcript_batches.batch_id AND projected = 0 AND canceled = 0)",
        [timestamp],
    )?;
    Ok(())
}

fn read_generation_in_database(db: &Connection, thread_id: &str) -> Result<i64, rusqlite::Error> {
    Ok(db
        .query_row(
            "SELECT generation FROM transcript_generations WHERE thread_id = ?",
            [thread_id],
            |r| r.get::<_, i64>(0),
        )
        .optional()?
        .unwrap_or(0))
}
