use std::collections::BTreeSet;

use rusqlite::{Connection, params};

use crate::error::Result;
use crate::write_coordinator::now_iso_millis;

pub const BASE_SCHEMA_MIGRATION: u32 = 1;
pub const LEGACY_IMPORT_MIGRATION: u32 = 2;
pub const PROVIDER_STATE_MIGRATION: u32 = 3;
pub const SUBAGENT_METADATA_MIGRATION: u32 = 4;
pub const MODEL_STREAM_CHUNKS_MIGRATION: u32 = 5;
pub const COST_TRACKER_MIGRATION: u32 = 6;
pub const BACKUPS_ENABLED_OVERRIDE_MIGRATION: u32 = 7;
pub const AGENT_REALIGNMENT_MIGRATION: u32 = 8;
pub const PROVIDER_OPTIONS_MIGRATION: u32 = 9;
pub const SESSION_SNAPSHOTS_MIGRATION: u32 = 10;
pub const THREAD_JOURNAL_MIGRATION: u32 = 11;
pub const AGENT_TASK_METADATA_MIGRATION: u32 = 12;
pub const RESEARCH_TABLE_MIGRATION: u32 = 13;
pub const RESEARCH_PLAN_COLUMNS_MIGRATION: u32 = 14;
pub const RESEARCH_WORKSPACE_COLUMN_MIGRATION: u32 = 15;
pub const AGENT_PROFILE_METADATA_MIGRATION: u32 = 16;
pub const LAST_MEMORY_GENERATED_INDEX_MIGRATION: u32 = 17;
pub const SANDBOX_CONFIG_MIGRATION: u32 = 18;
pub const TASK_MODE_MIGRATION: u32 = 19;
pub const TASK_ARTIFACT_VERSIONS_MIGRATION: u32 = 20;
pub const TASK_QUESTIONS_MIGRATION: u32 = 21;
pub const TASK_CREATION_MIGRATION: u32 = 22;
pub const TASK_REVIEW_STATE_MIGRATION: u32 = 23;
pub const TASK_ARTIFACT_REVISION_SETTLEMENT_MIGRATION: u32 = 24;
pub const THREAD_CREATION_KEYS_MIGRATION: u32 = 25;
pub const THREAD_JOURNAL_FAILURES_MIGRATION: u32 = 26;
pub const EXTERNAL_CONVERSATION_IMPORTS_MIGRATION: u32 = 27;
pub const THREAD_METADATA_MIGRATION: u32 = 28;

pub const LATEST_SCHEMA_MIGRATION: u32 = THREAD_METADATA_MIGRATION;

pub fn bootstrap_session_db<F>(
    conn: &mut Connection,
    busy_timeout_ms: u64,
    import_legacy_snapshots: F,
) -> Result<()>
where
    F: FnOnce(&mut Connection) -> Result<()>,
{
    conn.execute_batch(&format!(
        "PRAGMA journal_mode=WAL;
         PRAGMA synchronous=NORMAL;
         PRAGMA foreign_keys=ON;
         PRAGMA busy_timeout={};
         CREATE TABLE IF NOT EXISTS schema_migrations (
           version INTEGER PRIMARY KEY,
           applied_at TEXT NOT NULL
         );",
        busy_timeout_ms
    ))?;

    let mut applied = get_applied_migration_versions(conn)?;
    reconcile_retired_research_migrations(conn, &mut applied)?;

    if !applied.contains(&BASE_SCHEMA_MIGRATION) {
        create_base_schema(conn)?;
        mark_migration(conn, BASE_SCHEMA_MIGRATION)?;
    }

    if !applied.contains(&PROVIDER_STATE_MIGRATION) {
        add_session_state_column_if_missing(conn, "provider_state_json", "TEXT NULL")?;
        mark_migration(conn, PROVIDER_STATE_MIGRATION)?;
    }

    if !applied.contains(&SUBAGENT_METADATA_MIGRATION) {
        add_subagent_metadata_columns(conn)?;
        mark_migration(conn, SUBAGENT_METADATA_MIGRATION)?;
    }

    if !applied.contains(&MODEL_STREAM_CHUNKS_MIGRATION) {
        add_model_stream_chunks_table(conn)?;
        mark_migration(conn, MODEL_STREAM_CHUNKS_MIGRATION)?;
    }

    if !applied.contains(&COST_TRACKER_MIGRATION) {
        add_session_state_column_if_missing(conn, "cost_tracker_json", "TEXT NULL")?;
        mark_migration(conn, COST_TRACKER_MIGRATION)?;
    }

    if !applied.contains(&BACKUPS_ENABLED_OVERRIDE_MIGRATION) {
        add_sessions_column_if_missing(conn, "backups_enabled_override", "INTEGER NULL")?;
        mark_migration(conn, BACKUPS_ENABLED_OVERRIDE_MIGRATION)?;
    }

    if !applied.contains(&AGENT_REALIGNMENT_MIGRATION) {
        add_subagent_metadata_columns(conn)?;
        mark_migration(conn, AGENT_REALIGNMENT_MIGRATION)?;
    }

    if !applied.contains(&PROVIDER_OPTIONS_MIGRATION) {
        add_session_state_column_if_missing(conn, "provider_options_json", "TEXT NULL")?;
        mark_migration(conn, PROVIDER_OPTIONS_MIGRATION)?;
    }

    if !applied.contains(&SESSION_SNAPSHOTS_MIGRATION) {
        add_session_snapshots_table(conn)?;
        mark_migration(conn, SESSION_SNAPSHOTS_MIGRATION)?;
    }

    if !applied.contains(&THREAD_JOURNAL_MIGRATION) {
        add_thread_journal_events_table(conn)?;
        mark_migration(conn, THREAD_JOURNAL_MIGRATION)?;
    }

    if !applied.contains(&AGENT_TASK_METADATA_MIGRATION) {
        add_agent_task_metadata_columns(conn)?;
        mark_migration(conn, AGENT_TASK_METADATA_MIGRATION)?;
    }

    if !applied.contains(&AGENT_PROFILE_METADATA_MIGRATION) {
        add_agent_profile_metadata_column(conn)?;
        mark_migration(conn, AGENT_PROFILE_METADATA_MIGRATION)?;
    }

    if !applied.contains(&LAST_MEMORY_GENERATED_INDEX_MIGRATION) {
        add_session_state_column_if_missing(conn, "last_memory_generated_index", "INTEGER NULL")?;
        mark_migration(conn, LAST_MEMORY_GENERATED_INDEX_MIGRATION)?;
    }

    if !applied.contains(&SANDBOX_CONFIG_MIGRATION) {
        add_session_state_column_if_missing(conn, "sandbox_json", "TEXT NULL")?;
        mark_migration(conn, SANDBOX_CONFIG_MIGRATION)?;
    }

    if !applied.contains(&TASK_MODE_MIGRATION) {
        add_task_mode_tables(conn)?;
        mark_migration(conn, TASK_MODE_MIGRATION)?;
    }

    if !applied.contains(&TASK_ARTIFACT_VERSIONS_MIGRATION) {
        add_task_artifact_version_tables(conn)?;
        mark_migration(conn, TASK_ARTIFACT_VERSIONS_MIGRATION)?;
    }

    if !applied.contains(&TASK_QUESTIONS_MIGRATION) {
        add_task_question_tables(conn)?;
        mark_migration(conn, TASK_QUESTIONS_MIGRATION)?;
    }

    if !applied.contains(&TASK_CREATION_MIGRATION) {
        add_task_creation_columns(conn)?;
        mark_migration(conn, TASK_CREATION_MIGRATION)?;
    }

    if !applied.contains(&TASK_REVIEW_STATE_MIGRATION) {
        add_task_review_tables(conn)?;
        mark_migration(conn, TASK_REVIEW_STATE_MIGRATION)?;
    }

    if !applied.contains(&TASK_ARTIFACT_REVISION_SETTLEMENT_MIGRATION) {
        let tx = conn.transaction()?;
        ensure_artifact_revision_settlement_status_column(&tx)?;
        tx.execute(
            "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?1, ?2)",
            params![
                TASK_ARTIFACT_REVISION_SETTLEMENT_MIGRATION,
                now_iso_millis()
            ],
        )?;
        tx.commit()?;
    }

    if !applied.contains(&THREAD_CREATION_KEYS_MIGRATION) {
        add_thread_creation_keys_table(conn)?;
        mark_migration(conn, THREAD_CREATION_KEYS_MIGRATION)?;
    }

    if !applied.contains(&THREAD_JOURNAL_FAILURES_MIGRATION) {
        add_thread_journal_failures_table(conn)?;
        mark_migration(conn, THREAD_JOURNAL_FAILURES_MIGRATION)?;
    }

    if !applied.contains(&EXTERNAL_CONVERSATION_IMPORTS_MIGRATION) {
        add_external_conversation_imports_table(conn)?;
        mark_migration(conn, EXTERNAL_CONVERSATION_IMPORTS_MIGRATION)?;
    }

    if !applied.contains(&THREAD_METADATA_MIGRATION) {
        add_thread_metadata_table(conn)?;
        mark_migration(conn, THREAD_METADATA_MIGRATION)?;
    }

    if !applied.contains(&LEGACY_IMPORT_MIGRATION) {
        import_legacy_snapshots(conn)?;
        mark_migration(conn, LEGACY_IMPORT_MIGRATION)?;
    }

    Ok(())
}

pub fn get_applied_migration_versions(conn: &Connection) -> Result<BTreeSet<u32>> {
    let mut stmt = conn.prepare("SELECT version FROM schema_migrations ORDER BY version ASC")?;
    let rows = stmt.query_map([], |row| row.get::<_, u32>(0))?;
    let mut set = BTreeSet::new();
    for r in rows {
        set.insert(r?);
    }
    Ok(set)
}

fn mark_migration(conn: &Connection, version: u32) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?1, ?2)",
        params![version, now_iso_millis()],
    )?;
    Ok(())
}

fn table_columns(conn: &Connection, table_name: &str) -> Result<BTreeSet<String>> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table_name})"))?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
    let mut cols = BTreeSet::new();
    for r in rows {
        cols.insert(r?);
    }
    Ok(cols)
}

fn reconcile_retired_research_migrations(
    conn: &mut Connection,
    applied: &mut BTreeSet<u32>,
) -> Result<()> {
    if !applied.contains(&RESEARCH_TABLE_MIGRATION)
        && !applied.contains(&RESEARCH_PLAN_COLUMNS_MIGRATION)
        && !applied.contains(&RESEARCH_WORKSPACE_COLUMN_MIGRATION)
    {
        return Ok(());
    }

    let research_cols = table_columns(conn, "research")?;
    let checks = [
        (RESEARCH_TABLE_MIGRATION, !research_cols.is_empty()),
        (
            RESEARCH_PLAN_COLUMNS_MIGRATION,
            research_cols.contains("plan_pending"),
        ),
        (
            RESEARCH_WORKSPACE_COLUMN_MIGRATION,
            research_cols.contains("workspace_path"),
        ),
    ];

    let tx = conn.transaction()?;
    for (version, is_complete) in checks {
        if !is_complete && applied.contains(&version) {
            tx.execute(
                "DELETE FROM schema_migrations WHERE version = ?1",
                params![version],
            )?;
            applied.remove(&version);
        }
    }
    tx.commit()?;
    Ok(())
}

fn create_base_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS sessions (
           session_id TEXT PRIMARY KEY,
           session_kind TEXT NOT NULL DEFAULT 'root',
           parent_session_id TEXT NULL,
           role TEXT NULL,
           agent_type TEXT NULL,
           mode TEXT NULL,
           depth INTEGER NULL,
           nickname TEXT NULL,
           task_type TEXT NULL,
           target_paths_json TEXT NULL,
           agent_profile_json TEXT NULL,
           requested_model TEXT NULL,
           effective_model TEXT NULL,
           requested_reasoning_effort TEXT NULL,
           effective_reasoning_effort TEXT NULL,
           execution_state TEXT NULL,
           last_message_preview TEXT NULL,
           title TEXT NOT NULL,
           title_source TEXT NOT NULL,
           title_model TEXT NULL,
           provider TEXT NOT NULL,
           model TEXT NOT NULL,
           working_directory TEXT NOT NULL,
           output_directory TEXT NULL,
           uploads_directory TEXT NULL,
           enable_mcp INTEGER NOT NULL,
           backups_enabled_override INTEGER NULL,
           created_at TEXT NOT NULL,
           updated_at TEXT NOT NULL,
           status TEXT NOT NULL,
           has_pending_ask INTEGER NOT NULL,
           has_pending_approval INTEGER NOT NULL,
           message_count INTEGER NOT NULL,
           last_event_seq INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS session_state (
           session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
           system_prompt TEXT NOT NULL,
           messages_json TEXT NOT NULL,
           last_memory_generated_index INTEGER NULL,
           provider_state_json TEXT NULL,
           provider_options_json TEXT NULL,
           sandbox_json TEXT NULL,
           todos_json TEXT NOT NULL,
           harness_context_json TEXT NULL,
           cost_tracker_json TEXT NULL
         );
         CREATE TABLE IF NOT EXISTS session_events (
           session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
           seq INTEGER NOT NULL,
           ts TEXT NOT NULL,
           direction TEXT NOT NULL,
           event_type TEXT NOT NULL,
           payload_json TEXT NOT NULL,
           PRIMARY KEY(session_id, seq)
         );
         CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC);
         CREATE INDEX IF NOT EXISTS idx_session_events_seq_desc ON session_events(session_id, seq DESC);
         CREATE INDEX IF NOT EXISTS idx_sessions_status_updated ON sessions(status, updated_at DESC);
         CREATE INDEX IF NOT EXISTS idx_sessions_parent_updated ON sessions(parent_session_id, updated_at DESC);",
    )?;
    add_model_stream_chunks_table(conn)?;
    add_session_snapshots_table(conn)?;
    add_thread_journal_events_table(conn)?;
    add_thread_journal_failures_table(conn)?;
    add_thread_creation_keys_table(conn)?;
    add_external_conversation_imports_table(conn)?;
    Ok(())
}

fn add_sessions_column_if_missing(conn: &Connection, col: &str, col_def: &str) -> Result<()> {
    let cols = table_columns(conn, "sessions")?;
    if !cols.contains(col) {
        conn.execute_batch(&format!("ALTER TABLE sessions ADD COLUMN {col} {col_def};"))?;
    }
    Ok(())
}

fn add_session_state_column_if_missing(conn: &Connection, col: &str, col_def: &str) -> Result<()> {
    let cols = table_columns(conn, "session_state")?;
    if !cols.contains(col) {
        conn.execute_batch(&format!(
            "ALTER TABLE session_state ADD COLUMN {col} {col_def};"
        ))?;
    }
    Ok(())
}

fn add_agent_task_metadata_columns(conn: &Connection) -> Result<()> {
    add_sessions_column_if_missing(conn, "task_type", "TEXT NULL")?;
    add_sessions_column_if_missing(conn, "target_paths_json", "TEXT NULL")?;
    Ok(())
}

fn add_agent_profile_metadata_column(conn: &Connection) -> Result<()> {
    add_sessions_column_if_missing(conn, "agent_profile_json", "TEXT NULL")
}

fn add_subagent_metadata_columns(conn: &Connection) -> Result<()> {
    add_sessions_column_if_missing(conn, "session_kind", "TEXT NOT NULL DEFAULT 'root'")?;
    add_sessions_column_if_missing(conn, "parent_session_id", "TEXT NULL")?;
    add_sessions_column_if_missing(conn, "role", "TEXT NULL")?;
    add_sessions_column_if_missing(conn, "agent_type", "TEXT NULL")?;
    add_sessions_column_if_missing(conn, "mode", "TEXT NULL")?;
    add_sessions_column_if_missing(conn, "depth", "INTEGER NULL")?;
    add_sessions_column_if_missing(conn, "nickname", "TEXT NULL")?;
    add_agent_task_metadata_columns(conn)?;
    add_sessions_column_if_missing(conn, "requested_model", "TEXT NULL")?;
    add_sessions_column_if_missing(conn, "effective_model", "TEXT NULL")?;
    add_sessions_column_if_missing(conn, "requested_reasoning_effort", "TEXT NULL")?;
    add_sessions_column_if_missing(conn, "effective_reasoning_effort", "TEXT NULL")?;
    add_sessions_column_if_missing(conn, "execution_state", "TEXT NULL")?;
    add_sessions_column_if_missing(conn, "last_message_preview", "TEXT NULL")?;
    add_agent_profile_metadata_column(conn)?;

    conn.execute_batch(
        "UPDATE sessions SET session_kind = 'root' WHERE session_kind IS NULL OR session_kind = '';
         UPDATE sessions SET session_kind = 'agent' WHERE session_kind = 'subagent';
         UPDATE sessions
           SET role = CASE
             WHEN role IS NOT NULL AND role != '' THEN role
             WHEN agent_type = 'general' THEN 'worker'
             WHEN agent_type = 'explore' THEN 'explorer'
             ELSE agent_type
           END
           WHERE role IS NULL OR role = '';
         UPDATE sessions SET effective_model = model WHERE effective_model IS NULL OR effective_model = '';
         UPDATE sessions
           SET execution_state = CASE
             WHEN execution_state IS NOT NULL AND execution_state != '' THEN execution_state
             WHEN status = 'closed' THEN 'closed'
             ELSE 'completed'
           END;
         CREATE INDEX IF NOT EXISTS idx_sessions_parent_updated ON sessions(parent_session_id, updated_at DESC);",
    )?;
    Ok(())
}

fn add_model_stream_chunks_table(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS session_model_stream_chunks (
           session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
           turn_id TEXT NOT NULL,
           chunk_index INTEGER NOT NULL,
           ts TEXT NOT NULL,
           provider TEXT NOT NULL,
           model TEXT NOT NULL,
           raw_format TEXT NOT NULL,
           normalizer_version INTEGER NOT NULL,
           raw_event_json TEXT NOT NULL,
           PRIMARY KEY(session_id, turn_id, chunk_index)
         );
         CREATE INDEX IF NOT EXISTS idx_session_model_stream_chunks_session_turn
           ON session_model_stream_chunks(session_id, turn_id, chunk_index);",
    )?;
    Ok(())
}

fn add_session_snapshots_table(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS session_snapshots (
           session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
           updated_at TEXT NOT NULL,
           snapshot_json TEXT NOT NULL
         );",
    )?;
    Ok(())
}

fn add_thread_journal_events_table(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS thread_journal_events (
           thread_id TEXT NOT NULL,
           seq INTEGER NOT NULL,
           ts TEXT NOT NULL,
           event_type TEXT NOT NULL,
           turn_id TEXT NULL,
           item_id TEXT NULL,
           request_id TEXT NULL,
           payload_json TEXT NOT NULL,
           PRIMARY KEY(thread_id, seq)
         );
         CREATE INDEX IF NOT EXISTS idx_thread_journal_events_thread_seq
           ON thread_journal_events(thread_id, seq);",
    )?;
    Ok(())
}

fn add_thread_journal_failures_table(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS thread_journal_failures (
           thread_id TEXT PRIMARY KEY,
           failed_write_count INTEGER NOT NULL,
           dropped_event_count INTEGER NOT NULL,
           last_failure_at TEXT NOT NULL,
           last_failure_message TEXT NOT NULL
         );",
    )?;
    Ok(())
}

fn add_thread_metadata_table(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS thread_metadata (
           thread_id TEXT PRIMARY KEY,
           pinned INTEGER NOT NULL DEFAULT 0,
           pinned_at TEXT NULL,
           archived INTEGER NOT NULL DEFAULT 0,
           archived_at TEXT NULL,
           updated_at TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_thread_metadata_flags
           ON thread_metadata(pinned, archived, updated_at DESC);",
    )?;
    Ok(())
}

fn add_thread_creation_keys_table(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS thread_creation_keys (
           creation_key TEXT PRIMARY KEY,
           thread_id TEXT NOT NULL,
           created_at TEXT NOT NULL,
           updated_at TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_thread_creation_keys_thread
           ON thread_creation_keys(thread_id);",
    )?;
    Ok(())
}

fn add_external_conversation_imports_table(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS external_conversation_imports (
           source TEXT NOT NULL,
           fingerprint TEXT NOT NULL,
           imported_session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
           source_id TEXT NOT NULL,
           source_path TEXT NULL,
           original_provider TEXT NULL,
           original_model TEXT NULL,
           imported_at TEXT NOT NULL,
           metadata_json TEXT NOT NULL,
           PRIMARY KEY(source, fingerprint)
         );
         CREATE INDEX IF NOT EXISTS idx_external_conversation_imports_session
           ON external_conversation_imports(imported_session_id);",
    )?;
    Ok(())
}

fn add_task_mode_tables(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS tasks (
           task_id TEXT PRIMARY KEY,
           workspace_path TEXT NOT NULL,
           title TEXT NOT NULL,
           objective TEXT NOT NULL,
           context TEXT NOT NULL DEFAULT '',
           source_session_id TEXT NULL,
           creation_origin TEXT NOT NULL DEFAULT 'manual',
           creation_idempotency_key TEXT NULL,
           status TEXT NOT NULL,
           revision INTEGER NOT NULL DEFAULT 0,
           review_required INTEGER NOT NULL DEFAULT 1,
           review_rounds INTEGER NOT NULL DEFAULT 0,
           created_at TEXT NOT NULL,
           updated_at TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS task_threads (
           thread_id TEXT PRIMARY KEY,
           task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
           session_id TEXT NOT NULL UNIQUE,
           title TEXT NOT NULL,
           created_by TEXT NOT NULL,
           created_at TEXT NOT NULL,
           updated_at TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS task_requirements (
           requirement_id TEXT PRIMARY KEY,
           task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
           kind TEXT NOT NULL,
           text TEXT NOT NULL,
           source TEXT NOT NULL,
           permanence TEXT NOT NULL,
           status TEXT NOT NULL,
           created_at TEXT NOT NULL,
           supersedes TEXT NULL
         );
         CREATE TABLE IF NOT EXISTS task_work_items (
           work_item_id TEXT PRIMARY KEY,
           task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
           title TEXT NOT NULL,
           description TEXT NOT NULL,
           status TEXT NOT NULL,
           assigned_thread_id TEXT NULL,
           expected_outputs_json TEXT NOT NULL,
           completion_evidence TEXT NULL,
           position INTEGER NOT NULL,
           created_at TEXT NOT NULL,
           updated_at TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS task_work_item_dependencies (
           task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
           work_item_id TEXT NOT NULL REFERENCES task_work_items(work_item_id) ON DELETE CASCADE,
           depends_on_work_item_id TEXT NOT NULL REFERENCES task_work_items(work_item_id) ON DELETE CASCADE,
           PRIMARY KEY(work_item_id, depends_on_work_item_id)
         );
         CREATE TABLE IF NOT EXISTS task_work_item_claims (
           work_item_id TEXT PRIMARY KEY REFERENCES task_work_items(work_item_id) ON DELETE CASCADE,
           task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
           thread_id TEXT NOT NULL REFERENCES task_threads(thread_id) ON DELETE CASCADE,
           claimed_at TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS task_decisions (
           decision_id TEXT PRIMARY KEY,
           task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
           question TEXT NOT NULL,
           resolution TEXT NOT NULL,
           source TEXT NOT NULL,
           scope TEXT NOT NULL,
           confidence REAL NULL,
           status TEXT NOT NULL,
           created_at TEXT NOT NULL,
           supersedes TEXT NULL
         );
         CREATE TABLE IF NOT EXISTS task_artifacts (
           artifact_id TEXT PRIMARY KEY,
           task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
           work_item_id TEXT NULL,
           thread_id TEXT NULL,
           path TEXT NOT NULL,
           kind TEXT NOT NULL,
           title TEXT NOT NULL,
           created_by TEXT NOT NULL,
           provenance_json TEXT NOT NULL,
           created_at TEXT NOT NULL,
           UNIQUE(task_id, path)
         );
         CREATE TABLE IF NOT EXISTS task_blockers (
           blocker_id TEXT PRIMARY KEY,
           task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
           work_item_id TEXT NULL,
           description TEXT NOT NULL,
           blocking INTEGER NOT NULL,
           status TEXT NOT NULL,
           created_at TEXT NOT NULL,
           resolved_at TEXT NULL
         );
         CREATE TABLE IF NOT EXISTS task_activity (
           activity_id TEXT PRIMARY KEY,
           task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
           seq INTEGER NOT NULL,
           thread_id TEXT NULL,
           work_item_id TEXT NULL,
           kind TEXT NOT NULL,
           summary TEXT NOT NULL,
           detail TEXT NULL,
           created_at TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS task_checkpoints (
           checkpoint_id TEXT PRIMARY KEY,
           task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
           thread_id TEXT NULL,
           task_revision INTEGER NOT NULL,
           reason TEXT NOT NULL,
           agent_summary TEXT NOT NULL,
           context_digest TEXT NOT NULL,
           task_snapshot_json TEXT NOT NULL,
           artifact_manifest_json TEXT NOT NULL,
           created_at TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS task_directive_receipts (
           task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
           idempotency_key TEXT NOT NULL,
           result_revision INTEGER NOT NULL,
           created_at TEXT NOT NULL,
           PRIMARY KEY(task_id, idempotency_key)
         );
         CREATE INDEX IF NOT EXISTS idx_tasks_workspace_updated ON tasks(workspace_path, updated_at DESC);
         CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_creation_source_key ON tasks(source_session_id, creation_idempotency_key) WHERE source_session_id IS NOT NULL AND creation_idempotency_key IS NOT NULL;
         CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_creation_workspace_key ON tasks(workspace_path, creation_idempotency_key) WHERE source_session_id IS NULL AND creation_idempotency_key IS NOT NULL;
         CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_active_source ON tasks(source_session_id) WHERE source_session_id IS NOT NULL AND status NOT IN ('completed', 'failed', 'cancelled');
         CREATE INDEX IF NOT EXISTS idx_task_threads_task ON task_threads(task_id, updated_at DESC);
         CREATE INDEX IF NOT EXISTS idx_task_work_items_task_position ON task_work_items(task_id, position);
         CREATE UNIQUE INDEX IF NOT EXISTS idx_task_activity_task_seq ON task_activity(task_id, seq);
         CREATE INDEX IF NOT EXISTS idx_task_checkpoints_task_created ON task_checkpoints(task_id, created_at DESC);",
    )?;
    add_task_artifact_version_tables(conn)?;
    add_task_question_tables(conn)?;
    add_task_review_tables(conn)?;
    Ok(())
}

fn add_task_artifact_version_tables(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS task_artifact_versions (
           version_id TEXT PRIMARY KEY,
           task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
           artifact_id TEXT NOT NULL REFERENCES task_artifacts(artifact_id) ON DELETE CASCADE,
           version_number INTEGER NOT NULL,
           parent_version_id TEXT NULL REFERENCES task_artifact_versions(version_id) ON DELETE SET NULL,
           sha256 TEXT NOT NULL,
           size_bytes INTEGER NOT NULL,
           media_type TEXT NOT NULL,
           created_by TEXT NOT NULL,
           created_at TEXT NOT NULL,
           change_summary TEXT NOT NULL,
           provenance_json TEXT NOT NULL,
           review_status TEXT NOT NULL,
           UNIQUE(artifact_id, version_number)
         );
         CREATE TABLE IF NOT EXISTS task_artifact_revisions (
           revision_id TEXT PRIMARY KEY,
           task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
           artifact_id TEXT NOT NULL REFERENCES task_artifacts(artifact_id) ON DELETE CASCADE,
           work_item_id TEXT NOT NULL REFERENCES task_work_items(work_item_id) ON DELETE CASCADE,
           task_thread_id TEXT NOT NULL REFERENCES task_threads(thread_id) ON DELETE CASCADE,
           session_id TEXT NOT NULL,
           base_version_id TEXT NOT NULL REFERENCES task_artifact_versions(version_id),
           prior_version_id TEXT NOT NULL REFERENCES task_artifact_versions(version_id),
           result_version_id TEXT NULL REFERENCES task_artifact_versions(version_id) ON DELETE SET NULL,
           prior_task_status TEXT NOT NULL,
           settlement_status TEXT NOT NULL DEFAULT 'none',
           status TEXT NOT NULL,
           instruction TEXT NOT NULL,
           created_at TEXT NOT NULL,
           updated_at TEXT NOT NULL,
           completed_at TEXT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_task_artifact_versions_artifact ON task_artifact_versions(artifact_id, version_number);
         CREATE INDEX IF NOT EXISTS idx_task_artifact_versions_task ON task_artifact_versions(task_id, created_at DESC);
         CREATE INDEX IF NOT EXISTS idx_task_artifact_revisions_artifact ON task_artifact_revisions(artifact_id, created_at DESC);
         CREATE INDEX IF NOT EXISTS idx_task_artifact_revisions_session ON task_artifact_revisions(session_id, status);
         CREATE UNIQUE INDEX IF NOT EXISTS idx_task_artifact_revisions_active ON task_artifact_revisions(artifact_id) WHERE status = 'active';",
    )?;
    let rev_cols = table_columns(conn, "task_artifact_revisions")?;
    if !rev_cols.contains("prior_task_status") {
        conn.execute_batch(
            "ALTER TABLE task_artifact_revisions ADD COLUMN prior_task_status TEXT NOT NULL DEFAULT 'working';",
        )?;
    }
    Ok(())
}

fn ensure_artifact_revision_settlement_status_column(conn: &Connection) -> Result<()> {
    let rev_cols = table_columns(conn, "task_artifact_revisions")?;
    if !rev_cols.contains("settlement_status") {
        conn.execute_batch(
            "ALTER TABLE task_artifact_revisions ADD COLUMN settlement_status TEXT NOT NULL DEFAULT 'none';",
        )?;
    }
    conn.execute_batch(
        "UPDATE task_artifact_revisions
           SET settlement_status = 'none'
           WHERE settlement_status IS NULL OR settlement_status = '';
         UPDATE task_artifact_revisions AS revision
           SET settlement_status = 'pending'
           WHERE revision.status = 'completed'
             AND revision.result_version_id IS NOT NULL
             AND revision.settlement_status = 'none'
             AND EXISTS (
               SELECT 1 FROM task_artifact_revisions AS sibling
               WHERE sibling.task_id = revision.task_id
                 AND sibling.revision_id != revision.revision_id
                 AND sibling.status = 'active'
             );",
    )?;
    Ok(())
}

fn add_task_question_tables(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS task_questions (
           question_id TEXT PRIMARY KEY,
           task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
           thread_id TEXT NULL REFERENCES task_threads(thread_id) ON DELETE SET NULL,
           work_item_id TEXT NULL REFERENCES task_work_items(work_item_id) ON DELETE SET NULL,
           header TEXT NOT NULL,
           question TEXT NOT NULL,
           context TEXT NOT NULL,
           blocking INTEGER NOT NULL,
           urgency TEXT NOT NULL,
           default_action TEXT NULL,
           options_json TEXT NOT NULL,
           recommended_option_id TEXT NULL,
           status TEXT NOT NULL,
           provisional_decision_id TEXT NULL REFERENCES task_decisions(decision_id) ON DELETE SET NULL,
           answer TEXT NULL,
           answer_option_id TEXT NULL,
           resolution_source TEXT NULL,
           supersedes TEXT NULL REFERENCES task_questions(question_id) ON DELETE SET NULL,
           created_at TEXT NOT NULL,
           resolved_at TEXT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_task_questions_task_status ON task_questions(task_id, status, created_at);
         CREATE INDEX IF NOT EXISTS idx_task_questions_blocking ON task_questions(task_id, blocking, status);",
    )?;
    Ok(())
}

fn add_task_creation_columns(conn: &Connection) -> Result<()> {
    let cols = table_columns(conn, "tasks")?;
    if !cols.contains("context") {
        conn.execute_batch("ALTER TABLE tasks ADD COLUMN context TEXT NOT NULL DEFAULT '';")?;
    }
    if !cols.contains("source_session_id") {
        conn.execute_batch("ALTER TABLE tasks ADD COLUMN source_session_id TEXT NULL;")?;
    }
    if !cols.contains("creation_origin") {
        conn.execute_batch(
            "ALTER TABLE tasks ADD COLUMN creation_origin TEXT NOT NULL DEFAULT 'manual';",
        )?;
    }
    if !cols.contains("creation_idempotency_key") {
        conn.execute_batch("ALTER TABLE tasks ADD COLUMN creation_idempotency_key TEXT NULL;")?;
    }
    if !cols.contains("review_rounds") {
        conn.execute_batch(
            "ALTER TABLE tasks ADD COLUMN review_rounds INTEGER NOT NULL DEFAULT 0;",
        )?;
    }
    conn.execute_batch(
        "DROP INDEX IF EXISTS idx_tasks_creation_key;
         CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_creation_source_key ON tasks(source_session_id, creation_idempotency_key) WHERE source_session_id IS NOT NULL AND creation_idempotency_key IS NOT NULL;
         CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_creation_workspace_key ON tasks(workspace_path, creation_idempotency_key) WHERE source_session_id IS NULL AND creation_idempotency_key IS NOT NULL;
         CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_active_source ON tasks(source_session_id) WHERE source_session_id IS NOT NULL AND status NOT IN ('completed', 'failed', 'cancelled');",
    )?;
    Ok(())
}

fn add_task_review_tables(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS task_reviews (
           review_id TEXT PRIMARY KEY,
           task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
           round INTEGER NOT NULL,
           verdict TEXT NOT NULL,
           feedback TEXT NOT NULL,
           reviewer_agent_id TEXT NOT NULL,
           reviewer_provider TEXT NOT NULL,
           reviewer_model TEXT NOT NULL,
           task_revision INTEGER NOT NULL,
           material_fingerprint TEXT NOT NULL,
           material_snapshot_json TEXT NOT NULL,
           created_at TEXT NOT NULL,
           addressed_at TEXT NULL,
           implementation_summary TEXT NULL,
           UNIQUE(task_id, round),
           UNIQUE(task_id, reviewer_agent_id)
         );
         CREATE INDEX IF NOT EXISTS idx_task_reviews_task_round ON task_reviews(task_id, round);
         CREATE INDEX IF NOT EXISTS idx_task_reviews_task_fingerprint ON task_reviews(task_id, material_fingerprint);",
    )?;
    Ok(())
}
