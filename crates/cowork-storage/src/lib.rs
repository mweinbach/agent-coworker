//! `cowork-storage` — Persistence & Lock Coordination Layer.
//!
//! Module boundaries owned by this crate:
//! - **`sessions.db` engine**: Bundled `rusqlite` in WAL mode with split read-write and
//!   committed read-only handles, `0600` private permissions, corrupt-DB `.corrupt.<ts>.bak`
//!   quarantine, schema migrations `1..28` (including retired `13..15` reconciliation and
//!   idempotent legacy `sessions/*.json` import), and workspace-scoped startup stale-state
//!   reconciliation.
//! - **`ThreadJournal`**: Asynchronous monotonic per-thread JSON-RPC event journal with
//!   incremental `afterSeq` replay and automatic snapshot fallback + `thread_journal_failures`
//!   recording on sequence gaps or payload corruption.
//! - **`MemoryStore`**: Workspace and user `memory.sqlite` stores with one-time legacy
//!   `AGENT.md` + `memory/**/*.md` import and bounded prompt hot-cache rendering.
//! - **Cross-process locks**: `SessionDbWriteCoordinator` (`~/.cowork/locks/session-db-write.lock/owner.json`
//!   with stale-PID recovery) and SQLite `with_file_lock` (`~/.cowork/locks/files/<sha256>.sqlite`).

pub mod error;
pub mod hardening;
pub mod legacy_import;
pub mod memory_store;
pub mod migrations;
pub mod session_db;
pub mod thread_journal;
pub mod types;
pub mod write_coordinator;

pub use cowork_config::{
    FILE_LOCK_ACQUIRE_TIMEOUT_MS, FileLockOptions, file_lock_root_for_cowork_home,
    lock_database_path_for, with_file_lock, with_file_lock_sync,
};
pub use error::{Result, StorageError, is_corruption_error};
pub use hardening::{ensure_private_directory, harden_private_file, quarantine_corrupted_db};
pub use legacy_import::{create_legacy_session_snapshot, import_legacy_snapshots_from_dir};
pub use memory_store::{
    HOT_CACHE_PROMPT_LIMIT, HOT_MEMORY_ID, MemoryEntry, MemoryScope, MemoryStore, MemoryWriteMode,
    normalize_memory_id, normalize_stored_memory_id,
};
pub use migrations::{
    BASE_SCHEMA_MIGRATION, EXTERNAL_CONVERSATION_IMPORTS_MIGRATION, LATEST_SCHEMA_MIGRATION,
    LEGACY_IMPORT_MIGRATION, THREAD_CREATION_KEYS_MIGRATION, THREAD_JOURNAL_FAILURES_MIGRATION,
    THREAD_JOURNAL_MIGRATION, THREAD_METADATA_MIGRATION, bootstrap_session_db,
    get_applied_migration_versions,
};
pub use session_db::{DEFAULT_BUSY_TIMEOUT_MS, SessionDb};
pub use thread_journal::{
    ThreadJournal, ThreadJournalAggregateHealth, ThreadJournalHealth, ThreadJournalReplayOutcome,
};
pub use types::{
    AgentExecutionState, CreateTaskInput, PersistedExternalConversationImport,
    PersistedModelStreamChunk, PersistedSessionMutation, PersistedSessionRecord,
    PersistedSessionSnapshotData, PersistedSessionSummary, PersistedThreadJournalEvent,
    PersistedThreadJournalFailure, PersistedThreadMetadata, PersistedThreadMetadataPatch,
    SessionDbOptions, SessionKind, SessionPersistenceStatus, SessionTitleSource,
    StartupReconciliationReport, TaskThreadInput, ThreadJournalEventInput, WorkItemInput,
};
pub use write_coordinator::{
    DEFAULT_ACQUIRE_TIMEOUT_MS, DEFAULT_HEARTBEAT_MS, DEFAULT_RETRY_DELAY_MS,
    DEFAULT_STALE_LOCK_MS, SessionDbWriteCoordinator, SessionDbWriteCoordinatorOptions,
    SessionDbWriteLockDiagnostics, process_alive,
};

/// Target schema migration version for `~/.cowork/sessions.db`.
pub const LATEST_SESSION_DB_SCHEMA_VERSION: u32 = LATEST_SCHEMA_MIGRATION;

/// Latest `sessions.db` schema migration version (`1..28`).
pub const LATEST_SESSION_DB_MIGRATION: u32 = LATEST_SCHEMA_MIGRATION;

/// Relative path under `<coworkHome>` for the cross-process session DB write directory lock.
pub const SESSION_DB_WRITE_LOCK_REL_PATH: &str = "locks/session-db-write.lock";

/// Relative path under `~/.cowork` for the cross-process session DB write lock owner file.
pub const SESSION_DB_WRITE_LOCK_OWNER_REL_PATH: &str = "locks/session-db-write.lock/owner.json";

/// Relative directory under `<coworkHome>` for advisory per-file SQLite locks.
pub const FILE_LOCKS_REL_DIR: &str = "locks/files";

/// Relative directory under `~/.cowork` for SQLite `withFileLock` lock databases.
pub const FILE_LOCK_DIR_REL_PATH: &str = "locks/files";

/// SQLite journal mode enforced on `sessions.db` and `memory.sqlite`.
pub const REQUIRED_JOURNAL_MODE: &str = "wal";

/// Returns the home override variable honored by storage lock and DB resolvers.
pub fn storage_home_override_env() -> &'static str {
    cowork_config::COWORK_HOME_OVERRIDE_ENV
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn storage_invariants_match_contract_constants() {
        assert_eq!(LATEST_SESSION_DB_SCHEMA_VERSION, 28);
        assert_eq!(LATEST_SESSION_DB_MIGRATION, 28);
        assert_eq!(
            SESSION_DB_WRITE_LOCK_REL_PATH,
            "locks/session-db-write.lock"
        );
        assert_eq!(
            SESSION_DB_WRITE_LOCK_OWNER_REL_PATH,
            "locks/session-db-write.lock/owner.json"
        );
        assert_eq!(FILE_LOCKS_REL_DIR, "locks/files");
        assert_eq!(FILE_LOCK_DIR_REL_PATH, "locks/files");
        assert_eq!(REQUIRED_JOURNAL_MODE, "wal");
        assert_eq!(storage_home_override_env(), "COWORK_HOME_OVERRIDE");
    }
}
