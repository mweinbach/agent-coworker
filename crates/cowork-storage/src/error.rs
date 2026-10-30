use thiserror::Error;

pub type Result<T> = std::result::Result<T, StorageError>;

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("JSON serialization error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Configuration error: {0}")]
    Config(#[from] cowork_config::ConfigError),

    #[error("Invalid database path: {0}")]
    InvalidPath(String),

    #[error("Validation error in {field}: {message}")]
    Validation { field: String, message: String },

    #[error(
        "Timed out acquiring session DB write lock after {waited_ms}ms for {operation}{details}"
    )]
    LockTimeout {
        operation: String,
        waited_ms: u64,
        details: String,
    },

    #[error("Not found: {0}")]
    NotFound(String),

    #[error("Conflict: {0}")]
    Conflict(String),
}

impl StorageError {
    pub fn is_database_locked(&self) -> bool {
        match self {
            StorageError::Sqlite(rusqlite::Error::SqliteFailure(err, _)) => {
                matches!(
                    err.code,
                    rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
                )
            }
            _ => self
                .to_string()
                .to_lowercase()
                .contains("database is locked"),
        }
    }
}

/// Matches `isCorruptionError` in `src/server/sessionDb/normalizers.ts` plus `rusqlite::ErrorCode`.
pub fn is_corruption_error(error: &StorageError) -> bool {
    if let StorageError::Sqlite(rusqlite::Error::SqliteFailure(err, _)) = error
        && matches!(
            err.code,
            rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase
        )
    {
        return true;
    }

    let msg = error.to_string().to_lowercase();
    msg.contains("database disk image is malformed")
        || msg.contains("file is not a database")
        || msg.contains("database corruption")
}
