//! `cowork-storage` — Persistence & Execution Primitives Layer.
//!
//! Module boundaries owned by this crate:
//! - **`sessions.db` SQLite engine**: Bundled `rusqlite` in WAL mode with split read-write and
//!   read-only connection handles, `0600` file permissions, corrupt-DB quarantine, schema
//!   migrations `1..28` (including retired `13..15` reconciliation and legacy `sessions/*.json`
//!   import), and startup stale-state reconciliation.
//! - **`ThreadJournal`**: Monotonic `seq`-ordered per-thread event append/replay with snapshot
//!   fallback and `thread_journal_failures` recording.
//! - **`memory.sqlite` & `ArtifactVersionStore`**: Structured memory storage and content-addressed
//!   SHA-256 task artifact persistence.
//! - **Cross-process locks**: `SessionDbWriteCoordinator` (`locks/session-db-write.lock/owner.json`)
//!   and advisory SQLite `withFileLock` (`locks/files/<sha256>.sqlite`).

/// Target schema migration version for `~/.cowork/sessions.db`.
pub const LATEST_SESSION_DB_SCHEMA_VERSION: u32 = 28;

/// Relative path under `<coworkHome>` for the cross-process session DB write directory lock.
pub const SESSION_DB_WRITE_LOCK_REL_PATH: &str = "locks/session-db-write.lock";

/// Relative directory under `<coworkHome>` for advisory per-file SQLite locks.
pub const FILE_LOCKS_REL_DIR: &str = "locks/files";

/// Returns the home override variable honored by storage lock and DB resolvers.
pub fn storage_home_override_env() -> &'static str {
    cowork_config::COWORK_HOME_OVERRIDE_ENV
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn storage_constants_match_persistence_contract() {
        assert_eq!(LATEST_SESSION_DB_SCHEMA_VERSION, 28);
        assert_eq!(
            SESSION_DB_WRITE_LOCK_REL_PATH,
            "locks/session-db-write.lock"
        );
        assert_eq!(FILE_LOCKS_REL_DIR, "locks/files");
        assert_eq!(storage_home_override_env(), "COWORK_HOME_OVERRIDE");
    }
}
