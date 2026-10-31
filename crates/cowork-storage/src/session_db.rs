use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use cowork_config::{ProviderName, SandboxConfig, same_workspace_path};
use parking_lot::Mutex;
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::error::{Result, StorageError, is_corruption_error};
use crate::hardening::{ensure_private_directory, harden_sqlite_family, quarantine_corrupted_db};
use crate::legacy_import::{create_legacy_session_snapshot, import_legacy_snapshots_from_dir};
use crate::migrations::{bootstrap_session_db, get_applied_migration_versions};
use crate::types::{
    AgentExecutionState, ConversationImportPersistResult, CreateTaskInput,
    PersistedExternalConversationImport, PersistedExternalConversationImportMutation,
    PersistedModelStreamChunk, PersistedSessionMutation, PersistedSessionRecord,
    PersistedSessionSummary, PersistedThreadJournalEvent, PersistedThreadJournalFailure,
    PersistedThreadMetadata, PersistedThreadMetadataPatch, SessionDbOptions, SessionKind,
    SessionPersistenceStatus, SessionTitleSource, StartupReconciliationReport,
    ThreadJournalEventInput,
};
use crate::write_coordinator::{
    SessionDbWriteCoordinator, SessionDbWriteCoordinatorOptions, SessionDbWriteLockDiagnostics,
    now_iso_millis,
};

pub const DEFAULT_BUSY_TIMEOUT_MS: u64 = 5_000;
const ANONYMOUS_IN_MEMORY_DB_PATH: &str = ":memory:";

/// Durable SQLite session database engine compatible with `src/server/sessionDb.ts`.
///
/// Maintains a WAL read-write handle and an isolated committed read-only handle,
/// enforces `0600` file permissions, quarantines corrupted DB files to `.corrupt.<ISO>.bak`,
/// applies schema migrations `1..28`, and coordinates writes via `SessionDbWriteCoordinator`.
pub struct SessionDb {
    db_path: PathBuf,
    sessions_dir: PathBuf,
    busy_timeout_ms: u64,
    pub(crate) rw_conn: Mutex<Option<Connection>>,
    pub(crate) ro_conn: Mutex<Option<Connection>>,
    pub(crate) write_coordinator: Arc<SessionDbWriteCoordinator>,
    closed: AtomicBool,
}

impl SessionDb {
    pub async fn open(opts: SessionDbOptions) -> Result<Self> {
        ensure_private_directory(&opts.root_dir)?;

        let db_path = opts
            .db_path
            .unwrap_or_else(|| opts.root_dir.join("sessions.db"));
        if db_path.as_os_str() == ANONYMOUS_IN_MEMORY_DB_PATH {
            return Err(StorageError::InvalidPath(
                "SessionDb requires a durable file-backed database path; anonymous :memory: databases cannot provide committed-reader isolation.".to_string(),
            ));
        }

        if let Some(parent) = db_path.parent()
            && !parent.as_os_str().is_empty()
        {
            ensure_private_directory(parent)?;
        }

        let busy_timeout_ms = opts.busy_timeout_ms.unwrap_or(DEFAULT_BUSY_TIMEOUT_MS);
        let write_coordinator = Arc::new(SessionDbWriteCoordinator::new(
            SessionDbWriteCoordinatorOptions {
                root_dir: opts.root_dir.clone(),
                acquire_timeout_ms: None,
                retry_delay_ms: None,
                stale_lock_ms: None,
                heartbeat_ms: None,
            },
        ));

        let sessions_dir = opts.sessions_dir.clone();
        let db_path_for_init = db_path.clone();
        let sessions_dir_for_init = sessions_dir.clone();

        let (rw, ro) = write_coordinator
            .run_exclusive("bootstrap_session_db", || async move {
                match open_and_bootstrap_pair(
                    &db_path_for_init,
                    &sessions_dir_for_init,
                    busy_timeout_ms,
                ) {
                    Ok(pair) => Ok(pair),
                    Err(err) if is_corruption_error(&err) => {
                        quarantine_corrupted_db(&db_path_for_init)?;
                        open_and_bootstrap_pair(
                            &db_path_for_init,
                            &sessions_dir_for_init,
                            busy_timeout_ms,
                        )
                    }
                    Err(err) => Err(err),
                }
            })
            .await?;

        Ok(Self {
            db_path,
            sessions_dir,
            busy_timeout_ms,
            rw_conn: Mutex::new(Some(rw)),
            ro_conn: Mutex::new(Some(ro)),
            write_coordinator,
            closed: AtomicBool::new(false),
        })
    }

    pub fn db_path(&self) -> &Path {
        &self.db_path
    }

    pub fn sessions_dir(&self) -> &Path {
        &self.sessions_dir
    }

    pub fn busy_timeout_ms(&self) -> u64 {
        self.busy_timeout_ms
    }

    pub fn write_coordinator(&self) -> &Arc<SessionDbWriteCoordinator> {
        &self.write_coordinator
    }

    pub fn write_lock_diagnostics(&self) -> SessionDbWriteLockDiagnostics {
        self.write_coordinator.diagnostics()
    }

    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        let _ = self.ro_conn.lock().take();
        let _ = self.rw_conn.lock().take();
    }

    pub(crate) fn with_read_conn<T, F>(&self, op: F) -> Result<T>
    where
        F: FnOnce(&Connection) -> Result<T>,
    {
        if self.write_coordinator.owns_current_context() {
            let guard = self.rw_conn.lock();
            let conn = guard
                .as_ref()
                .ok_or_else(|| StorageError::InvalidPath("SessionDb is closed".to_string()))?;
            op(conn)
        } else {
            let guard = self.ro_conn.lock();
            let conn = guard
                .as_ref()
                .ok_or_else(|| StorageError::InvalidPath("SessionDb is closed".to_string()))?;
            op(conn)
        }
    }

    pub(crate) fn with_rw_conn_mut<T, F>(&self, op: F) -> Result<T>
    where
        F: FnOnce(&mut Connection) -> Result<T>,
    {
        let mut guard = self.rw_conn.lock();
        let conn = guard
            .as_mut()
            .ok_or_else(|| StorageError::InvalidPath("SessionDb is closed".to_string()))?;
        op(conn)
    }

    pub fn journal_mode(&self) -> Result<String> {
        let guard = self.rw_conn.lock();
        let conn = guard
            .as_ref()
            .ok_or_else(|| StorageError::InvalidPath("SessionDb is closed".to_string()))?;
        let mode: String = conn.query_row("PRAGMA journal_mode", [], |r| r.get(0))?;
        Ok(mode)
    }

    pub fn applied_migration_versions(&self) -> Result<BTreeSet<u32>> {
        self.with_read_conn(get_applied_migration_versions)
    }

    pub async fn persist_session_mutation(
        &self,
        mutation: PersistedSessionMutation,
    ) -> Result<u64> {
        self.write_coordinator
            .run_exclusive("persist_session_mutation", || async {
                self.with_rw_conn_mut(|conn| persist_session_mutation_sync(conn, &mutation))
            })
            .await
    }

    pub async fn persist_session_snapshot(&self, session_id: &str, snapshot: &Value) -> Result<()> {
        let updated_at = snapshot
            .get("updatedAt")
            .and_then(|v| v.as_str())
            .map(ToOwned::to_owned)
            .unwrap_or_else(now_iso_millis);
        let serialized = serde_json::to_string(snapshot)?;
        let sid = session_id.to_string();

        self.write_coordinator
            .run_exclusive("persist_session_snapshot", || async move {
                self.with_rw_conn_mut(|conn| {
                    conn.execute(
                        "INSERT INTO session_snapshots (session_id, updated_at, snapshot_json)
                         VALUES (?1, ?2, ?3)
                         ON CONFLICT(session_id) DO UPDATE SET
                           updated_at = excluded.updated_at,
                           snapshot_json = excluded.snapshot_json",
                        params![sid, updated_at, serialized],
                    )?;
                    Ok(())
                })
            })
            .await
    }

    pub fn get_session_snapshot(&self, session_id: &str) -> Result<Option<Value>> {
        self.with_read_conn(|conn| {
            let raw: Option<String> = conn
                .query_row(
                    "SELECT snapshot_json FROM session_snapshots WHERE session_id = ?1 LIMIT 1",
                    params![session_id],
                    |row| row.get(0),
                )
                .optional()?;
            let Some(json_str) = raw else {
                return Ok(None);
            };
            let mut parsed: Value = serde_json::from_str(&json_str)?;
            if let Some(obj) = parsed.as_object_mut() {
                obj.entry("taskType").or_insert(Value::Null);
                obj.entry("targetPaths").or_insert(Value::Null);
                obj.entry("profile").or_insert(Value::Null);
            }
            Ok(Some(parsed))
        })
    }

    pub fn project_legacy_snapshot(&self, session_id: &str) -> Result<Option<Value>> {
        let Some(rec) = self.get_session_record(session_id)? else {
            return Ok(None);
        };
        Ok(Some(create_legacy_session_snapshot(&rec)))
    }

    pub fn get_session_record(&self, session_id: &str) -> Result<Option<PersistedSessionRecord>> {
        self.with_read_conn(|conn| read_session_record_from_conn(conn, session_id))
    }

    /// Lists persisted child agent sessions belonging to `parent_session_id` in creation order.
    pub fn list_agent_sessions(
        &self,
        parent_session_id: &str,
    ) -> Result<Vec<PersistedSessionRecord>> {
        let parent_id = parent_session_id.trim();
        if parent_id.is_empty() {
            return Ok(Vec::new());
        }
        self.with_read_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT session_id
                 FROM sessions
                 WHERE parent_session_id = ?1 AND session_kind != 'root'
                 ORDER BY created_at ASC, rowid ASC",
            )?;
            let ids: Vec<String> = stmt
                .query_map(params![parent_id], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;

            let mut out = Vec::with_capacity(ids.len());
            for id in ids {
                if let Some(rec) = read_session_record_from_conn(conn, &id)? {
                    out.push(rec);
                }
            }
            Ok(out)
        })
    }

    pub fn list_sessions(
        &self,
        working_directory: Option<&str>,
    ) -> Result<Vec<PersistedSessionSummary>> {
        let filter_ws = working_directory.map(str::trim).filter(|s| !s.is_empty());

        self.with_read_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT
                   session_id, title, title_source, title_model, provider, model,
                   created_at, updated_at, message_count, last_event_seq,
                   has_pending_ask, has_pending_approval, working_directory
                 FROM sessions
                 WHERE session_kind = 'root'
                 ORDER BY updated_at DESC",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, i64>(8)?,
                    row.get::<_, i64>(9)?,
                    row.get::<_, i64>(10)?,
                    row.get::<_, i64>(11)?,
                    row.get::<_, String>(12)?,
                ))
            })?;

            let mut out = Vec::new();
            for item in rows {
                let (
                    session_id,
                    title,
                    title_source,
                    title_model,
                    provider_raw,
                    model,
                    created_at,
                    updated_at,
                    message_count,
                    last_event_seq,
                    has_pending_ask,
                    has_pending_approval,
                    wd,
                ) = item?;

                if let Some(target_ws) = filter_ws
                    && !same_workspace_path(&wd, target_ws)
                {
                    continue;
                }
                let Some(provider) = ProviderName::parse(&provider_raw) else {
                    continue;
                };
                out.push(PersistedSessionSummary {
                    session_id,
                    title,
                    title_source: SessionTitleSource::from_db(&title_source),
                    title_model,
                    provider,
                    model,
                    created_at,
                    updated_at,
                    message_count: message_count.max(0) as usize,
                    last_event_seq: last_event_seq.max(0) as u64,
                    has_pending_ask: has_pending_ask != 0,
                    has_pending_approval: has_pending_approval != 0,
                });
            }
            Ok(out)
        })
    }

    pub async fn delete_session(&self, session_id: &str) -> Result<()> {
        let sid = session_id.to_string();
        self.write_coordinator
            .run_exclusive("delete_session", || async move {
                self.with_rw_conn_mut(|conn| {
                    let tx = conn.transaction()?;
                    let tree_ids: Vec<String> = {
                        let mut stmt = tx.prepare(
                            "WITH RECURSIVE session_tree(session_id) AS (
                               SELECT ?1
                               UNION
                               SELECT sessions.session_id FROM sessions
                               JOIN session_tree ON sessions.parent_session_id = session_tree.session_id
                             )
                             SELECT session_id FROM session_tree",
                        )?;
                        let mapped = stmt.query_map(params![sid], |r| r.get::<_, String>(0))?;
                        let mut v = Vec::new();
                        for item in mapped {
                            v.push(item?);
                        }
                        v
                    };
                    for id in tree_ids {
                        tx.execute(
                            "DELETE FROM thread_journal_events WHERE thread_id = ?1",
                            params![id],
                        )?;
                        tx.execute(
                            "DELETE FROM thread_journal_failures WHERE thread_id = ?1",
                            params![id],
                        )?;
                        tx.execute(
                            "DELETE FROM thread_metadata WHERE thread_id = ?1",
                            params![id],
                        )?;
                        tx.execute(
                            "DELETE FROM thread_creation_keys WHERE thread_id = ?1",
                            params![id],
                        )?;
                        tx.execute("DELETE FROM sessions WHERE session_id = ?1", params![id])?;
                    }
                    tx.commit()?;
                    Ok(())
                })
            })
            .await
    }

    pub fn get_messages(
        &self,
        session_id: &str,
        offset: usize,
        limit: usize,
    ) -> Result<(Vec<Value>, usize)> {
        self.with_read_conn(|conn| {
            let raw: Option<String> = conn
                .query_row(
                    "SELECT messages_json FROM session_state WHERE session_id = ?1",
                    params![session_id],
                    |r| r.get(0),
                )
                .optional()?;
            let Some(json_str) = raw else {
                return Ok((Vec::new(), 0));
            };
            let all: Vec<Value> = serde_json::from_str(&json_str).unwrap_or_default();
            let total = all.len();
            let safe_limit = limit.max(1);
            let slice = all
                .into_iter()
                .skip(offset)
                .take(safe_limit)
                .collect::<Vec<_>>();
            Ok((slice, total))
        })
    }

    pub async fn persist_model_stream_chunks(
        &self,
        chunks: &[PersistedModelStreamChunk],
    ) -> Result<()> {
        if chunks.is_empty() {
            return Ok(());
        }
        self.write_coordinator
            .run_exclusive("persist_model_stream_chunks", || async {
                self.with_rw_conn_mut(|conn| {
                    let tx = conn.transaction()?;
                    for c in chunks {
                        let raw_json = serde_json::to_string(&c.raw_event)?;
                        tx.execute(
                            "INSERT INTO session_model_stream_chunks (
                               session_id, turn_id, chunk_index, ts, provider, model,
                               raw_format, normalizer_version, raw_event_json
                             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                            params![
                                c.session_id,
                                c.turn_id,
                                c.chunk_index as i64,
                                c.ts,
                                c.provider.as_str(),
                                c.model,
                                c.raw_format,
                                c.normalizer_version as i64,
                                raw_json,
                            ],
                        )?;
                    }
                    tx.commit()?;
                    Ok(())
                })
            })
            .await
    }

    pub async fn append_thread_journal_events(
        &self,
        events: &[ThreadJournalEventInput],
    ) -> Result<Vec<u64>> {
        if events.is_empty() {
            return Ok(Vec::new());
        }
        self.write_coordinator
            .run_exclusive("append_thread_journal_events", || async {
                self.with_rw_conn_mut(|conn| append_thread_journal_events_sync(conn, events))
            })
            .await
    }

    pub fn get_thread_journal_tail_seq(&self, thread_id: &str) -> Result<u64> {
        self.with_read_conn(|conn| {
            let seq: Option<i64> = conn
                .query_row(
                    "SELECT seq FROM thread_journal_events
                     WHERE thread_id = ?1
                     ORDER BY seq DESC
                     LIMIT 1",
                    params![thread_id],
                    |r| r.get(0),
                )
                .optional()?;
            Ok(seq.unwrap_or(0).max(0) as u64)
        })
    }

    pub fn list_thread_journal_events(
        &self,
        thread_id: &str,
        after_seq: u64,
        limit: Option<usize>,
    ) -> Result<Vec<PersistedThreadJournalEvent>> {
        self.with_read_conn(|conn| {
            let mut out = Vec::new();
            let map_row = |row: &rusqlite::Row<'_>| -> rusqlite::Result<RawJournalRow> {
                Ok(RawJournalRow {
                    seq: row.get(0)?,
                    ts: row.get(1)?,
                    event_type: row.get(2)?,
                    turn_id: row.get(3)?,
                    item_id: row.get(4)?,
                    request_id: row.get(5)?,
                    payload_json: row.get(6)?,
                })
            };

            let raw_rows: Vec<_> = if let Some(lim) = limit {
                let mut stmt = conn.prepare(
                    "SELECT seq, ts, event_type, turn_id, item_id, request_id, payload_json
                     FROM thread_journal_events
                     WHERE thread_id = ?1 AND seq > ?2
                     ORDER BY seq ASC
                     LIMIT ?3",
                )?;
                let iter = stmt.query_map(
                    params![thread_id, after_seq as i64, lim.max(1) as i64],
                    map_row,
                )?;
                iter.collect::<rusqlite::Result<Vec<_>>>()?
            } else {
                let mut stmt = conn.prepare(
                    "SELECT seq, ts, event_type, turn_id, item_id, request_id, payload_json
                     FROM thread_journal_events
                     WHERE thread_id = ?1 AND seq > ?2
                     ORDER BY seq ASC",
                )?;
                let iter = stmt.query_map(params![thread_id, after_seq as i64], map_row)?;
                iter.collect::<rusqlite::Result<Vec<_>>>()?
            };

            for raw in raw_rows {
                let payload: Value = serde_json::from_str(&raw.payload_json)?;
                out.push(PersistedThreadJournalEvent {
                    thread_id: thread_id.to_string(),
                    seq: raw.seq.max(0) as u64,
                    ts: raw.ts,
                    event_type: raw.event_type,
                    turn_id: raw.turn_id,
                    item_id: raw.item_id,
                    request_id: raw.request_id,
                    payload,
                });
            }
            Ok(out)
        })
    }

    pub async fn record_thread_journal_failure(
        &self,
        failure: &PersistedThreadJournalFailure,
    ) -> Result<()> {
        self.write_coordinator
            .run_exclusive("record_thread_journal_failure", || async {
                self.with_rw_conn_mut(|conn| {
                    conn.execute(
                        "INSERT INTO thread_journal_failures (
                           thread_id, failed_write_count, dropped_event_count,
                           last_failure_at, last_failure_message
                         ) VALUES (?1, ?2, ?3, ?4, ?5)
                         ON CONFLICT(thread_id) DO UPDATE SET
                           failed_write_count = excluded.failed_write_count,
                           dropped_event_count = excluded.dropped_event_count,
                           last_failure_at = excluded.last_failure_at,
                           last_failure_message = excluded.last_failure_message",
                        params![
                            failure.thread_id,
                            failure.failed_write_count as i64,
                            failure.dropped_event_count as i64,
                            failure.last_failure_at,
                            failure.last_failure_message,
                        ],
                    )?;
                    Ok(())
                })
            })
            .await
    }

    pub fn get_thread_journal_failure(
        &self,
        thread_id: &str,
    ) -> Result<Option<PersistedThreadJournalFailure>> {
        self.with_read_conn(|conn| {
            conn.query_row(
                "SELECT thread_id, failed_write_count, dropped_event_count,
                        last_failure_at, last_failure_message
                 FROM thread_journal_failures
                 WHERE thread_id = ?1",
                params![thread_id],
                |row| {
                    Ok(PersistedThreadJournalFailure {
                        thread_id: row.get(0)?,
                        failed_write_count: row.get::<_, i64>(1)?.max(0) as u64,
                        dropped_event_count: row.get::<_, i64>(2)?.max(0) as u64,
                        last_failure_at: row.get(3)?,
                        last_failure_message: row.get(4)?,
                    })
                },
            )
            .optional()
            .map_err(StorageError::from)
        })
    }

    pub fn list_thread_journal_failures(&self) -> Result<Vec<PersistedThreadJournalFailure>> {
        self.with_read_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT thread_id, failed_write_count, dropped_event_count,
                        last_failure_at, last_failure_message
                 FROM thread_journal_failures",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok(PersistedThreadJournalFailure {
                    thread_id: row.get(0)?,
                    failed_write_count: row.get::<_, i64>(1)?.max(0) as u64,
                    dropped_event_count: row.get::<_, i64>(2)?.max(0) as u64,
                    last_failure_at: row.get(3)?,
                    last_failure_message: row.get(4)?,
                })
            })?;
            let mut out = Vec::new();
            for item in rows {
                out.push(item?);
            }
            Ok(out)
        })
    }

    pub async fn upsert_thread_metadata(
        &self,
        patch: PersistedThreadMetadataPatch,
    ) -> Result<PersistedThreadMetadata> {
        self.write_coordinator
            .run_exclusive("upsert_thread_metadata", || async move {
                self.with_rw_conn_mut(|conn| {
                    let existing: Option<(i64, Option<String>, i64, Option<String>)> = conn
                        .query_row(
                            "SELECT pinned, pinned_at, archived, archived_at
                             FROM thread_metadata WHERE thread_id = ?1",
                            params![patch.thread_id],
                            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                        )
                        .optional()?;
                    let (cur_pinned, cur_pinned_at, cur_archived, cur_archived_at) =
                        existing.unwrap_or((0, None, 0, None));

                    let next_pinned = patch.pinned.unwrap_or(cur_pinned != 0);
                    let next_pinned_at = match patch.pinned_at {
                        Some(val) => val,
                        None if next_pinned => cur_pinned_at.or_else(|| Some(now_iso_millis())),
                        None => None,
                    };
                    let next_archived = patch.archived.unwrap_or(cur_archived != 0);
                    let next_archived_at = match patch.archived_at {
                        Some(val) => val,
                        None if next_archived => cur_archived_at.or_else(|| Some(now_iso_millis())),
                        None => None,
                    };
                    let updated_at = patch.updated_at.unwrap_or_else(now_iso_millis);

                    conn.execute(
                        "INSERT INTO thread_metadata (
                           thread_id, pinned, pinned_at, archived, archived_at, updated_at
                         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                         ON CONFLICT(thread_id) DO UPDATE SET
                           pinned = excluded.pinned,
                           pinned_at = excluded.pinned_at,
                           archived = excluded.archived,
                           archived_at = excluded.archived_at,
                           updated_at = excluded.updated_at",
                        params![
                            patch.thread_id,
                            if next_pinned { 1_i64 } else { 0_i64 },
                            next_pinned_at,
                            if next_archived { 1_i64 } else { 0_i64 },
                            next_archived_at,
                            updated_at,
                        ],
                    )?;

                    Ok(PersistedThreadMetadata {
                        thread_id: patch.thread_id,
                        pinned: next_pinned,
                        pinned_at: next_pinned_at,
                        archived: next_archived,
                        archived_at: next_archived_at,
                        updated_at,
                    })
                })
            })
            .await
    }

    pub fn get_thread_metadata(&self, thread_id: &str) -> Result<Option<PersistedThreadMetadata>> {
        self.with_read_conn(|conn| {
            conn.query_row(
                "SELECT thread_id, pinned, pinned_at, archived, archived_at, updated_at
                 FROM thread_metadata WHERE thread_id = ?1",
                params![thread_id],
                |r| {
                    Ok(PersistedThreadMetadata {
                        thread_id: r.get(0)?,
                        pinned: r.get::<_, i64>(1)? != 0,
                        pinned_at: r.get(2)?,
                        archived: r.get::<_, i64>(3)? != 0,
                        archived_at: r.get(4)?,
                        updated_at: r.get(5)?,
                    })
                },
            )
            .optional()
            .map_err(StorageError::from)
        })
    }

    pub async fn bind_thread_creation_key(
        &self,
        creation_key: &str,
        thread_id: &str,
    ) -> Result<String> {
        let key = creation_key.to_string();
        let tid = thread_id.to_string();
        self.write_coordinator
            .run_exclusive("bind_thread_creation_key", || async move {
                self.with_rw_conn_mut(|conn| {
                    let now = now_iso_millis();
                    conn.execute(
                        "INSERT OR IGNORE INTO thread_creation_keys (
                           creation_key, thread_id, created_at, updated_at
                         ) VALUES (?1, ?2, ?3, ?4)",
                        params![key, tid, now, now],
                    )?;
                    let bound: String = conn.query_row(
                        "SELECT thread_id FROM thread_creation_keys WHERE creation_key = ?1",
                        params![key],
                        |r| r.get(0),
                    )?;
                    Ok(bound)
                })
            })
            .await
    }

    pub fn get_external_conversation_import(
        &self,
        source: &str,
        fingerprint: &str,
    ) -> Result<Option<PersistedExternalConversationImport>> {
        self.with_read_conn(|conn| {
            read_external_conversation_import_from_conn(conn, source, fingerprint)
        })
    }

    pub fn list_external_conversation_imports(
        &self,
        source: Option<&str>,
        limit: Option<usize>,
    ) -> Result<Vec<PersistedExternalConversationImport>> {
        let clamped_limit = limit.unwrap_or(250).clamp(1, 1000) as i64;
        self.with_read_conn(|conn| {
            let mut out = Vec::new();
            let raw_rows: Vec<_> = if let Some(src) = source {
                let mut stmt = conn.prepare(
                    "SELECT source, fingerprint, imported_session_id, source_id, source_path,
                            original_provider, original_model, imported_at, metadata_json
                     FROM external_conversation_imports
                     WHERE source = ?1
                     ORDER BY imported_at DESC
                     LIMIT ?2",
                )?;
                let iter = stmt.query_map(
                    params![src, clamped_limit],
                    map_external_conversation_import_row,
                )?;
                iter.collect::<rusqlite::Result<Vec<_>>>()?
            } else {
                let mut stmt = conn.prepare(
                    "SELECT source, fingerprint, imported_session_id, source_id, source_path,
                            original_provider, original_model, imported_at, metadata_json
                     FROM external_conversation_imports
                     ORDER BY imported_at DESC
                     LIMIT ?1",
                )?;
                let iter =
                    stmt.query_map(params![clamped_limit], map_external_conversation_import_row)?;
                iter.collect::<rusqlite::Result<Vec<_>>>()?
            };
            for (
                src,
                fingerprint,
                imported_session_id,
                source_id,
                source_path,
                original_provider,
                original_model,
                imported_at,
                metadata_json,
            ) in raw_rows
            {
                let metadata: Value =
                    serde_json::from_str(&metadata_json).unwrap_or_else(|_| json!({}));
                out.push(PersistedExternalConversationImport {
                    source: src,
                    fingerprint,
                    imported_session_id,
                    source_id,
                    source_path,
                    original_provider,
                    original_model,
                    imported_at,
                    metadata,
                });
            }
            Ok(out)
        })
    }

    pub async fn persist_external_conversation_import(
        &self,
        input: PersistedExternalConversationImportMutation,
    ) -> Result<ConversationImportPersistResult> {
        self.write_coordinator
            .run_exclusive("persist_external_conversation_import", || async move {
                self.with_rw_conn_mut(|conn| {
                    let tx = conn.transaction()?;
                    if let Some(existing) = read_external_conversation_import_from_conn(
                        &tx,
                        &input.record.source,
                        &input.record.fingerprint,
                    )? {
                        let existing_snap_raw: Option<String> = tx
                            .query_row(
                                "SELECT snapshot_json FROM session_snapshots WHERE session_id = ?1 LIMIT 1",
                                params![existing.imported_session_id],
                                |r| r.get(0),
                            )
                            .optional()?;
                        let snapshot_feed = existing_snap_raw
                            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                            .and_then(|v| v.get("feed").and_then(Value::as_array).cloned())
                            .unwrap_or_default();
                        let model_messages = read_session_record_from_conn(
                            &tx,
                            &existing.imported_session_id,
                        )?
                        .map(|r| r.messages)
                        .unwrap_or_default();
                        return Ok(ConversationImportPersistResult {
                            thread_id: existing.imported_session_id,
                            snapshot_feed,
                            model_messages,
                        });
                    }

                    let session_id = input.mutation.session_id.clone();
                    let snap_session_id = input
                        .snapshot
                        .get("sessionId")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    if input.record.imported_session_id != session_id
                        || snap_session_id != session_id
                    {
                        return Err(StorageError::InvalidPath(
                            "Imported conversation session IDs must match.".to_string(),
                        ));
                    }

                    let session_exists: Option<i64> = tx
                        .query_row(
                            "SELECT 1 FROM sessions WHERE session_id = ?1 LIMIT 1",
                            params![session_id],
                            |r| r.get(0),
                        )
                        .optional()?;
                    if session_exists.is_some() {
                        return Err(StorageError::InvalidPath(format!(
                            "Cannot import into {session_id}: the existing conversation has been preserved."
                        )));
                    }

                    let override_msg_count = input
                        .snapshot
                        .get("messageCount")
                        .and_then(Value::as_u64)
                        .map(|n| n as usize);
                    let last_event_seq = persist_session_mutation_in_tx(
                        &tx,
                        &input.mutation,
                        override_msg_count,
                    )?;

                    let mut full_snapshot = input.snapshot.clone();
                    if let Some(obj) = full_snapshot.as_object_mut() {
                        obj.insert("lastEventSeq".to_string(), json!(last_event_seq));
                    }
                    let updated_at = full_snapshot
                        .get("updatedAt")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned)
                        .unwrap_or_else(now_iso_millis);
                    let serialized_snapshot = serde_json::to_string(&full_snapshot)?;
                    tx.execute(
                        "INSERT INTO session_snapshots (session_id, updated_at, snapshot_json)
                         VALUES (?1, ?2, ?3)
                         ON CONFLICT(session_id) DO UPDATE SET
                           updated_at = excluded.updated_at,
                           snapshot_json = excluded.snapshot_json",
                        params![session_id, updated_at, serialized_snapshot],
                    )?;

                    let metadata_json = serde_json::to_string(&input.record.metadata)?;
                    tx.execute(
                        "INSERT INTO external_conversation_imports (
                           source, fingerprint, imported_session_id, source_id, source_path,
                           original_provider, original_model, imported_at, metadata_json
                         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                         ON CONFLICT(source, fingerprint) DO UPDATE SET
                           imported_session_id = excluded.imported_session_id,
                           source_id = excluded.source_id,
                           source_path = excluded.source_path,
                           original_provider = excluded.original_provider,
                           original_model = excluded.original_model,
                           imported_at = excluded.imported_at,
                           metadata_json = excluded.metadata_json",
                        params![
                            input.record.source,
                            input.record.fingerprint,
                            input.record.imported_session_id,
                            input.record.source_id,
                            input.record.source_path,
                            input.record.original_provider,
                            input.record.original_model,
                            input.record.imported_at,
                            metadata_json,
                        ],
                    )?;

                    tx.commit()?;

                    let snapshot_feed = full_snapshot
                        .get("feed")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    Ok(ConversationImportPersistResult {
                        thread_id: session_id,
                        snapshot_feed,
                        model_messages: input.mutation.snapshot.messages,
                    })
                })
            })
            .await
    }

    pub async fn record_external_conversation_import(
        &self,
        record: &PersistedExternalConversationImport,
    ) -> Result<()> {
        let metadata_json = serde_json::to_string(&record.metadata)?;
        self.write_coordinator
            .run_exclusive("record_external_conversation_import", || async move {
                self.with_rw_conn_mut(|conn| {
                    conn.execute(
                        "INSERT INTO external_conversation_imports (
                           source, fingerprint, imported_session_id, source_id, source_path,
                           original_provider, original_model, imported_at, metadata_json
                         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                         ON CONFLICT(source, fingerprint) DO UPDATE SET
                           imported_session_id = excluded.imported_session_id,
                           source_id = excluded.source_id,
                           source_path = excluded.source_path,
                           original_provider = excluded.original_provider,
                           original_model = excluded.original_model,
                           imported_at = excluded.imported_at,
                           metadata_json = excluded.metadata_json",
                        params![
                            record.source,
                            record.fingerprint,
                            record.imported_session_id,
                            record.source_id,
                            record.source_path,
                            record.original_provider,
                            record.original_model,
                            record.imported_at,
                            metadata_json,
                        ],
                    )?;
                    Ok(())
                })
            })
            .await
    }

    pub async fn create_task(&self, input: CreateTaskInput) -> Result<()> {
        self.write_coordinator
            .run_exclusive("create_task", || async move {
                self.with_rw_conn_mut(|conn| {
                    let tx = conn.transaction()?;
                    let now = input.thread.created_at.clone();
                    tx.execute(
                        "INSERT INTO tasks (
                           task_id, workspace_path, title, objective, context,
                           source_session_id, creation_origin, creation_idempotency_key,
                           status, revision, review_required, review_rounds,
                           created_at, updated_at
                         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10, ?11, ?12, ?13)",
                        params![
                            input.id,
                            input.workspace_path,
                            input.title,
                            input.objective,
                            input.context,
                            input.source_session_id,
                            input.creation_origin,
                            input.creation_idempotency_key,
                            input.initial_status,
                            if input.review_required { 1_i64 } else { 0_i64 },
                            input.review_rounds,
                            now,
                            now,
                        ],
                    )?;
                    tx.execute(
                        "INSERT INTO task_threads (
                           thread_id, task_id, session_id, title, created_by, created_at, updated_at
                         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                        params![
                            input.thread.id,
                            input.id,
                            input.thread.session_id,
                            input.thread.title,
                            input.thread.created_by,
                            input.thread.created_at,
                            input.thread.updated_at,
                        ],
                    )?;
                    for wi in &input.work_items {
                        let outputs_json = serde_json::to_string(&wi.expected_outputs)?;
                        tx.execute(
                            "INSERT INTO task_work_items (
                               work_item_id, task_id, title, description, status,
                               assigned_thread_id, expected_outputs_json, completion_evidence,
                               position, created_at, updated_at
                             ) VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, NULL, ?7, ?8, ?9)",
                            params![
                                wi.id,
                                input.id,
                                wi.title,
                                wi.description,
                                wi.status,
                                outputs_json,
                                wi.position,
                                wi.created_at,
                                wi.updated_at,
                            ],
                        )?;
                    }
                    tx.execute(
                        "INSERT INTO task_activity (
                           activity_id, task_id, seq, thread_id, work_item_id,
                           kind, summary, detail, created_at
                         ) VALUES (?1, ?2, 1, ?3, NULL, 'task_created', ?4, NULL, ?5)",
                        params![
                            Uuid::new_v4().to_string(),
                            input.id,
                            input.thread.id,
                            format!("Task created: {}", input.title),
                            now,
                        ],
                    )?;
                    tx.commit()?;
                    Ok(())
                })
            })
            .await
    }

    pub fn get_task_status(&self, task_id: &str) -> Result<Option<String>> {
        self.with_read_conn(|conn| {
            conn.query_row(
                "SELECT status FROM tasks WHERE task_id = ?1",
                params![task_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(StorageError::from)
        })
    }

    /// Startup crash-recovery reconciliation scoped optionally to a single workspace.
    ///
    /// - Transitions stale `sessions` (`execution_state IN ('running', 'pending_init')`) out of
    ///   transient states (`errored` per `agentExecutionStateSchema`), clears `has_pending_ask` &
    ///   `has_pending_approval` in both `sessions` and `session_snapshots`, and appends a
    ///   `session.interrupted` event.
    /// - Appends `turn/completed` with `status: "interrupted"` in `thread_journal_events` for any
    ///   open `turn/started` turn on reconciled sessions.
    /// - Transitions stale `tasks` (`status IN ('working', 'planning')`) in the target workspace
    ///   whose sessions crashed to `failed`, releasing any active `task_work_item_claims`.
    pub async fn reconcile_stale_execution_states(
        &self,
        working_directory: Option<&str>,
    ) -> Result<StartupReconciliationReport> {
        let ws_filter = working_directory
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToOwned::to_owned);

        self.write_coordinator
            .run_exclusive("reconcile_stale_execution_states", || async move {
                self.with_rw_conn_mut(|conn| {
                    reconcile_stale_execution_states_sync(conn, ws_filter.as_deref())
                })
            })
            .await
    }
}

impl Drop for SessionDb {
    fn drop(&mut self) {
        self.close();
    }
}

fn open_and_bootstrap_pair(
    db_path: &Path,
    sessions_dir: &Path,
    busy_timeout_ms: u64,
) -> Result<(Connection, Connection)> {
    let mut rw = Connection::open(db_path)?;

    if let Err(err) = bootstrap_session_db(&mut rw, busy_timeout_ms, |conn| {
        import_legacy_snapshots_from_dir(conn, sessions_dir)
    }) {
        drop(rw);
        return Err(err);
    }

    harden_sqlite_family(db_path);

    let ro_flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let ro = match Connection::open_with_flags(db_path, ro_flags) {
        Ok(c) => c,
        Err(err) => {
            drop(rw);
            return Err(StorageError::Sqlite(err));
        }
    };
    if let Err(err) = ro.execute_batch(&format!(
        "PRAGMA busy_timeout={};
         PRAGMA foreign_keys=ON;",
        busy_timeout_ms
    )) {
        drop(ro);
        drop(rw);
        return Err(StorageError::Sqlite(err));
    }

    Ok((rw, ro))
}

type RawExternalConversationImportRow = (
    String,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
    String,
);

fn map_external_conversation_import_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<RawExternalConversationImportRow> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
        row.get(7)?,
        row.get(8)?,
    ))
}

fn read_external_conversation_import_from_conn(
    conn: &Connection,
    source: &str,
    fingerprint: &str,
) -> Result<Option<PersistedExternalConversationImport>> {
    let raw: Option<RawExternalConversationImportRow> = conn
        .query_row(
            "SELECT source, fingerprint, imported_session_id, source_id, source_path,
                    original_provider, original_model, imported_at, metadata_json
             FROM external_conversation_imports
             WHERE source = ?1 AND fingerprint = ?2
             LIMIT 1",
            params![source, fingerprint],
            map_external_conversation_import_row,
        )
        .optional()?;
    let Some((
        src,
        fp,
        imported_session_id,
        source_id,
        source_path,
        original_provider,
        original_model,
        imported_at,
        metadata_json,
    )) = raw
    else {
        return Ok(None);
    };
    let metadata: Value = serde_json::from_str(&metadata_json).unwrap_or_else(|_| json!({}));
    Ok(Some(PersistedExternalConversationImport {
        source: src,
        fingerprint: fp,
        imported_session_id,
        source_id,
        source_path,
        original_provider,
        original_model,
        imported_at,
        metadata,
    }))
}

fn persist_session_mutation_sync(
    conn: &mut Connection,
    input: &PersistedSessionMutation,
) -> Result<u64> {
    let tx = conn.transaction()?;
    let next_seq = persist_session_mutation_in_tx(&tx, input, None)?;
    tx.commit()?;
    Ok(next_seq)
}

fn persist_session_mutation_in_tx(
    tx: &Connection,
    input: &PersistedSessionMutation,
    override_message_count: Option<usize>,
) -> Result<u64> {
    let existing_seq: Option<i64> = tx
        .query_row(
            "SELECT last_event_seq FROM sessions WHERE session_id = ?1",
            params![input.session_id],
            |r| r.get(0),
        )
        .optional()?;
    let next_seq = (existing_seq.unwrap_or(0).max(0) as u64) + 1;

    let snap = &input.snapshot;
    let target_paths_json = snap
        .target_paths
        .as_ref()
        .map(serde_json::to_string)
        .transpose()?;
    let agent_profile_json = snap
        .profile
        .as_ref()
        .map(serde_json::to_string)
        .transpose()?;
    let provider_state_json = snap
        .provider_state
        .as_ref()
        .map(serde_json::to_string)
        .transpose()?;
    let provider_options_json = snap
        .provider_options
        .as_ref()
        .map(serde_json::to_string)
        .transpose()?;
    let sandbox_json = snap
        .sandbox
        .as_ref()
        .map(serde_json::to_string)
        .transpose()?;
    let cost_tracker_json = snap
        .cost_tracker
        .as_ref()
        .map(serde_json::to_string)
        .transpose()?;
    let messages_json = serde_json::to_string(&snap.messages)?;
    let todos_json = serde_json::to_string(&snap.todos)?;
    let harness_context_json = serde_json::to_string(&snap.harness_context)?;

    let last_mem_idx = snap
        .last_memory_generated_index
        .unwrap_or(snap.messages.len())
        .min(snap.messages.len());
    let backups_override = snap
        .backups_enabled_override
        .map(|b| if b { 1_i64 } else { 0_i64 });

    let ts = input
        .event_ts
        .clone()
        .unwrap_or_else(|| snap.updated_at.clone());
    let direction = input.direction.as_deref().unwrap_or("system");
    let payload_json = serde_json::to_string(&input.payload.clone().unwrap_or_else(|| json!({})))?;

    tx.execute(
        "INSERT INTO sessions (
           session_id, session_kind, parent_session_id, role, agent_type, mode, depth,
           nickname, task_type, target_paths_json, agent_profile_json, requested_model,
           effective_model, requested_reasoning_effort, effective_reasoning_effort,
           execution_state, last_message_preview, title, title_source, title_model,
           provider, model, working_directory, output_directory, uploads_directory,
           enable_mcp, backups_enabled_override, created_at, updated_at, status,
           has_pending_ask, has_pending_approval, message_count, last_event_seq
         ) VALUES (
           ?1, ?2, ?3, ?4, NULL, ?5, ?6,
           ?7, ?8, ?9, ?10, ?11,
           ?12, ?13, ?14,
           ?15, ?16, ?17, ?18, ?19,
           ?20, ?21, ?22, ?23, ?24,
           ?25, ?26, ?27, ?28, ?29,
           ?30, ?31, ?32, ?33
         )
         ON CONFLICT(session_id) DO UPDATE SET
           session_kind = excluded.session_kind,
           parent_session_id = excluded.parent_session_id,
           role = excluded.role,
           agent_type = excluded.agent_type,
           mode = excluded.mode,
           depth = excluded.depth,
           nickname = excluded.nickname,
           task_type = excluded.task_type,
           target_paths_json = excluded.target_paths_json,
           agent_profile_json = excluded.agent_profile_json,
           requested_model = excluded.requested_model,
           effective_model = excluded.effective_model,
           requested_reasoning_effort = excluded.requested_reasoning_effort,
           effective_reasoning_effort = excluded.effective_reasoning_effort,
           execution_state = excluded.execution_state,
           last_message_preview = excluded.last_message_preview,
           title = excluded.title,
           title_source = excluded.title_source,
           title_model = excluded.title_model,
           provider = excluded.provider,
           model = excluded.model,
           working_directory = excluded.working_directory,
           output_directory = excluded.output_directory,
           uploads_directory = excluded.uploads_directory,
           enable_mcp = excluded.enable_mcp,
           backups_enabled_override = excluded.backups_enabled_override,
           updated_at = excluded.updated_at,
           status = excluded.status,
           has_pending_ask = excluded.has_pending_ask,
           has_pending_approval = excluded.has_pending_approval,
           message_count = excluded.message_count,
           last_event_seq = excluded.last_event_seq",
        params![
            input.session_id,
            snap.session_kind.as_str(),
            snap.parent_session_id,
            snap.role,
            snap.mode,
            snap.depth,
            snap.nickname,
            snap.task_type,
            target_paths_json,
            agent_profile_json,
            snap.requested_model,
            snap.effective_model,
            snap.requested_reasoning_effort,
            snap.effective_reasoning_effort,
            snap.execution_state.map(|s| s.as_str()),
            snap.last_message_preview,
            snap.title,
            snap.title_source.as_str(),
            snap.title_model,
            snap.provider.as_str(),
            snap.model,
            snap.working_directory,
            snap.output_directory,
            snap.uploads_directory,
            if snap.enable_mcp { 1_i64 } else { 0_i64 },
            backups_override,
            snap.created_at,
            snap.updated_at,
            snap.status.as_str(),
            if snap.has_pending_ask { 1_i64 } else { 0_i64 },
            if snap.has_pending_approval {
                1_i64
            } else {
                0_i64
            },
            override_message_count.unwrap_or(snap.messages.len()) as i64,
            next_seq as i64,
        ],
    )?;

    tx.execute(
        "INSERT INTO session_state (
           session_id, system_prompt, messages_json, last_memory_generated_index,
           provider_state_json, provider_options_json, sandbox_json, todos_json,
           harness_context_json, cost_tracker_json
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(session_id) DO UPDATE SET
           system_prompt = excluded.system_prompt,
           messages_json = excluded.messages_json,
           last_memory_generated_index = excluded.last_memory_generated_index,
           provider_state_json = excluded.provider_state_json,
           provider_options_json = excluded.provider_options_json,
           sandbox_json = excluded.sandbox_json,
           todos_json = excluded.todos_json,
           harness_context_json = excluded.harness_context_json,
           cost_tracker_json = excluded.cost_tracker_json",
        params![
            input.session_id,
            snap.system_prompt,
            messages_json,
            last_mem_idx as i64,
            provider_state_json,
            provider_options_json,
            sandbox_json,
            todos_json,
            harness_context_json,
            cost_tracker_json,
        ],
    )?;

    tx.execute(
        "INSERT INTO session_events (
           session_id, seq, ts, direction, event_type, payload_json
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            input.session_id,
            next_seq as i64,
            ts,
            direction,
            input.event_type,
            payload_json,
        ],
    )?;

    Ok(next_seq)
}

pub(crate) fn append_thread_journal_events_sync(
    conn: &mut Connection,
    inputs: &[ThreadJournalEventInput],
) -> Result<Vec<u64>> {
    let tx = conn.transaction()?;
    let mut next_seq_by_thread: HashMap<String, u64> = HashMap::new();
    let mut inserted = Vec::with_capacity(inputs.len());

    for input in inputs {
        let next_seq = match next_seq_by_thread.get(&input.thread_id).copied() {
            Some(seq) => seq,
            None => {
                let latest: Option<i64> = tx
                    .query_row(
                        "SELECT seq FROM thread_journal_events
                         WHERE thread_id = ?1
                         ORDER BY seq DESC
                         LIMIT 1",
                        params![input.thread_id],
                        |r| r.get(0),
                    )
                    .optional()?;
                (latest.unwrap_or(0).max(0) as u64) + 1
            }
        };
        let payload_json = serde_json::to_string(&input.payload)?;
        tx.execute(
            "INSERT INTO thread_journal_events (
               thread_id, seq, ts, event_type, turn_id, item_id, request_id, payload_json
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                input.thread_id,
                next_seq as i64,
                input.ts,
                input.event_type,
                input.turn_id,
                input.item_id,
                input.request_id,
                payload_json,
            ],
        )?;
        inserted.push(next_seq);
        next_seq_by_thread.insert(input.thread_id.clone(), next_seq + 1);
    }

    tx.commit()?;
    Ok(inserted)
}

fn reconcile_stale_execution_states_sync(
    conn: &mut Connection,
    workspace_filter: Option<&str>,
) -> Result<StartupReconciliationReport> {
    let tx = conn.transaction()?;
    let now = now_iso_millis();

    let candidates: Vec<(String, String)> = {
        let mut stmt = tx.prepare(
            "SELECT session_id, working_directory
             FROM sessions
             WHERE execution_state IN ('running', 'pending_init')",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };

    let mut reconciled_session_ids: Vec<String> = Vec::new();
    for (session_id, wd) in candidates {
        if let Some(target_ws) = workspace_filter
            && !same_workspace_path(&wd, target_ws)
        {
            continue;
        }
        let changed = tx.execute(
            "UPDATE sessions
             SET execution_state = 'errored',
                 has_pending_ask = 0,
                 has_pending_approval = 0
             WHERE session_id = ?1
               AND execution_state IN ('running', 'pending_init')",
            params![session_id],
        )?;
        if changed == 0 {
            continue;
        }

        // Keep session_snapshots JSON synchronized with cleared prompt gates and terminal state.
        tx.execute(
            "UPDATE session_snapshots
             SET snapshot_json = json_set(
               snapshot_json,
               '$.executionState', 'errored',
               '$.hasPendingAsk', json('false'),
               '$.hasPendingApproval', json('false')
             )
             WHERE session_id = ?1
               AND json_valid(snapshot_json)",
            params![session_id],
        )?;

        reconciled_session_ids.push(session_id);
    }

    // Reconcile open turns in thread_journal_events for reconciled sessions.
    let mut turns_interrupted = 0_usize;
    for session_id in &reconciled_session_ids {
        let open_turns = find_open_journal_turns(&tx, session_id)?;
        if open_turns.is_empty() {
            continue;
        }
        let latest_seq: i64 = tx
            .query_row(
                "SELECT seq FROM thread_journal_events
                 WHERE thread_id = ?1 ORDER BY seq DESC LIMIT 1",
                params![session_id],
                |r| r.get(0),
            )
            .optional()?
            .unwrap_or(0);
        for (next_seq, turn_id) in (latest_seq + 1..).zip(open_turns) {
            let payload_json = serde_json::to_string(&json!({
                "turn": {
                    "id": turn_id,
                    "status": "interrupted",
                }
            }))?;
            tx.execute(
                "INSERT INTO thread_journal_events (
                   thread_id, seq, ts, event_type, turn_id, item_id, request_id, payload_json
                 ) VALUES (?1, ?2, ?3, 'turn/completed', ?4, NULL, NULL, ?5)",
                params![session_id, next_seq, now, turn_id, payload_json],
            )?;
            turns_interrupted += 1;
        }
    }

    // Reconcile active tasks in ('working', 'planning') scoped to target workspace.
    let active_tasks: Vec<(String, String)> = {
        let mut stmt = tx.prepare(
            "SELECT task_id, workspace_path
             FROM tasks
             WHERE status IN ('working', 'planning')",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };

    let mut tasks_reconciled = 0_usize;
    for (task_id, ws_path) in active_tasks {
        if let Some(target_ws) = workspace_filter
            && !same_workspace_path(&ws_path, target_ws)
        {
            continue;
        }
        let changed = tx.execute(
            "UPDATE tasks
             SET status = 'failed',
                 revision = revision + 1,
                 updated_at = ?2
             WHERE task_id = ?1
               AND status IN ('working', 'planning')",
            params![task_id, now],
        )?;
        if changed > 0 {
            tx.execute(
                "DELETE FROM task_work_item_claims WHERE task_id = ?1",
                params![task_id],
            )?;
            tx.execute(
                "UPDATE task_work_items
                 SET status = 'blocked', updated_at = ?2
                 WHERE task_id = ?1 AND status = 'in_progress'",
                params![task_id, now],
            )?;
            tasks_reconciled += changed;
        }
    }

    tx.commit()?;
    Ok(StartupReconciliationReport {
        sessions_reconciled: reconciled_session_ids.len(),
        turns_interrupted,
        tasks_reconciled,
    })
}

fn find_open_journal_turns(conn: &Connection, thread_id: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT event_type, turn_id
         FROM thread_journal_events
         WHERE thread_id = ?1
         ORDER BY seq ASC",
    )?;
    let rows = stmt.query_map(params![thread_id], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
    })?;

    let mut open_order: Vec<String> = Vec::new();
    let mut closed: BTreeSet<String> = BTreeSet::new();
    for item in rows {
        let (event_type, Some(turn_id)) = item? else {
            continue;
        };
        if event_type == "turn/started" {
            closed.remove(&turn_id);
            if !open_order.contains(&turn_id) {
                open_order.push(turn_id);
            }
        } else if event_type == "turn/completed" {
            closed.insert(turn_id);
        }
    }
    open_order.retain(|tid| !closed.contains(tid));
    Ok(open_order)
}

pub(crate) fn read_session_record_from_conn(
    conn: &Connection,
    session_id: &str,
) -> Result<Option<PersistedSessionRecord>> {
    let row = conn
        .query_row(
            "SELECT
               s.session_id,
               s.session_kind,
               s.parent_session_id,
               COALESCE(
                 s.role,
                 CASE s.agent_type
                   WHEN 'general' THEN 'worker'
                   WHEN 'explore' THEN 'explorer'
                   ELSE s.agent_type
                 END
               ) AS role,
               s.mode,
               s.depth,
               s.nickname,
               s.task_type,
               s.target_paths_json,
               s.agent_profile_json,
               s.requested_model,
               s.effective_model,
               s.requested_reasoning_effort,
               s.effective_reasoning_effort,
               s.execution_state,
               s.last_message_preview,
               s.title,
               s.title_source,
               s.title_model,
               s.provider,
               s.model,
               s.working_directory,
               s.output_directory,
               s.uploads_directory,
               s.enable_mcp,
               s.backups_enabled_override,
               s.created_at,
               s.updated_at,
               s.status,
               s.has_pending_ask,
               s.has_pending_approval,
               s.message_count,
               s.last_event_seq,
               st.system_prompt,
               st.messages_json,
               st.last_memory_generated_index,
               st.provider_state_json,
               st.provider_options_json,
               st.sandbox_json,
               st.todos_json,
               st.harness_context_json,
               st.cost_tracker_json
             FROM sessions s
             JOIN session_state st ON st.session_id = s.session_id
             WHERE s.session_id = ?1
             LIMIT 1",
            params![session_id],
            |r| {
                Ok(RawSessionRecordRow {
                    session_id: r.get(0)?,
                    session_kind: r.get(1)?,
                    parent_session_id: r.get(2)?,
                    role: r.get(3)?,
                    mode: r.get(4)?,
                    depth: r.get(5)?,
                    nickname: r.get(6)?,
                    task_type: r.get(7)?,
                    target_paths_json: r.get(8)?,
                    agent_profile_json: r.get(9)?,
                    requested_model: r.get(10)?,
                    effective_model: r.get(11)?,
                    requested_reasoning_effort: r.get(12)?,
                    effective_reasoning_effort: r.get(13)?,
                    execution_state: r.get(14)?,
                    last_message_preview: r.get(15)?,
                    title: r.get(16)?,
                    title_source: r.get(17)?,
                    title_model: r.get(18)?,
                    provider: r.get(19)?,
                    model: r.get(20)?,
                    working_directory: r.get(21)?,
                    output_directory: r.get(22)?,
                    uploads_directory: r.get(23)?,
                    enable_mcp: r.get(24)?,
                    backups_enabled_override: r.get(25)?,
                    created_at: r.get(26)?,
                    updated_at: r.get(27)?,
                    status: r.get(28)?,
                    has_pending_ask: r.get(29)?,
                    has_pending_approval: r.get(30)?,
                    message_count: r.get(31)?,
                    last_event_seq: r.get(32)?,
                    system_prompt: r.get(33)?,
                    messages_json: r.get(34)?,
                    last_memory_generated_index: r.get(35)?,
                    provider_state_json: r.get(36)?,
                    provider_options_json: r.get(37)?,
                    sandbox_json: r.get(38)?,
                    todos_json: r.get(39)?,
                    harness_context_json: r.get(40)?,
                    cost_tracker_json: r.get(41)?,
                })
            },
        )
        .optional()?;

    let Some(raw) = row else {
        return Ok(None);
    };
    let Some(provider) = ProviderName::parse(&raw.provider) else {
        return Ok(None);
    };

    let target_paths: Option<Vec<String>> = raw
        .target_paths_json
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok());
    let profile: Option<Value> = raw
        .agent_profile_json
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .filter(|v: &Value| !v.is_null());
    let messages: Vec<Value> = serde_json::from_str(&raw.messages_json).unwrap_or_default();
    let todos: Vec<Value> = serde_json::from_str(&raw.todos_json).unwrap_or_default();
    let provider_state: Option<Value> = raw
        .provider_state_json
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .filter(|v: &Value| !v.is_null());
    let provider_options: Option<Value> = raw
        .provider_options_json
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .filter(|v: &Value| !v.is_null());
    let sandbox: Option<SandboxConfig> = raw
        .sandbox_json
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok());
    let harness_context: Option<Value> = raw
        .harness_context_json
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .filter(|v: &Value| !v.is_null());
    let cost_tracker: Option<Value> = raw
        .cost_tracker_json
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .filter(|v: &Value| !v.is_null());

    Ok(Some(PersistedSessionRecord {
        session_id: raw.session_id,
        session_kind: SessionKind::from_db(&raw.session_kind),
        parent_session_id: raw.parent_session_id,
        role: raw.role,
        mode: raw.mode,
        depth: raw.depth,
        nickname: raw.nickname,
        task_type: raw.task_type,
        target_paths,
        profile,
        requested_model: raw.requested_model,
        effective_model: raw.effective_model,
        requested_reasoning_effort: raw.requested_reasoning_effort,
        effective_reasoning_effort: raw.effective_reasoning_effort,
        execution_state: raw
            .execution_state
            .as_deref()
            .and_then(AgentExecutionState::from_db),
        last_message_preview: raw.last_message_preview,
        title: raw.title,
        title_source: SessionTitleSource::from_db(&raw.title_source),
        title_model: raw.title_model,
        provider,
        model: raw.model,
        working_directory: raw.working_directory,
        output_directory: raw.output_directory,
        uploads_directory: raw.uploads_directory,
        provider_options,
        sandbox,
        enable_mcp: raw.enable_mcp != 0,
        backups_enabled_override: raw.backups_enabled_override.map(|v| v != 0),
        created_at: raw.created_at,
        updated_at: raw.updated_at,
        status: SessionPersistenceStatus::from_db(&raw.status)
            .unwrap_or(SessionPersistenceStatus::Active),
        has_pending_ask: raw.has_pending_ask != 0,
        has_pending_approval: raw.has_pending_approval != 0,
        message_count: raw.message_count.max(0) as usize,
        last_event_seq: raw.last_event_seq.max(0) as u64,
        system_prompt: raw.system_prompt,
        messages,
        last_memory_generated_index: raw.last_memory_generated_index.map(|n| n.max(0) as usize),
        provider_state,
        todos,
        harness_context,
        cost_tracker,
    }))
}

struct RawSessionRecordRow {
    session_id: String,
    session_kind: String,
    parent_session_id: Option<String>,
    role: Option<String>,
    mode: Option<String>,
    depth: Option<i64>,
    nickname: Option<String>,
    task_type: Option<String>,
    target_paths_json: Option<String>,
    agent_profile_json: Option<String>,
    requested_model: Option<String>,
    effective_model: Option<String>,
    requested_reasoning_effort: Option<String>,
    effective_reasoning_effort: Option<String>,
    execution_state: Option<String>,
    last_message_preview: Option<String>,
    title: String,
    title_source: String,
    title_model: Option<String>,
    provider: String,
    model: String,
    working_directory: String,
    output_directory: Option<String>,
    uploads_directory: Option<String>,
    enable_mcp: i64,
    backups_enabled_override: Option<i64>,
    created_at: String,
    updated_at: String,
    status: String,
    has_pending_ask: i64,
    has_pending_approval: i64,
    message_count: i64,
    last_event_seq: i64,
    system_prompt: String,
    messages_json: String,
    last_memory_generated_index: Option<i64>,
    provider_state_json: Option<String>,
    provider_options_json: Option<String>,
    sandbox_json: Option<String>,
    todos_json: String,
    harness_context_json: Option<String>,
    cost_tracker_json: Option<String>,
}

struct RawJournalRow {
    seq: i64,
    ts: String,
    event_type: String,
    turn_id: Option<String>,
    item_id: Option<String>,
    request_id: Option<String>,
    payload_json: String,
}
