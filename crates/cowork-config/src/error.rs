use std::path::PathBuf;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("I/O error at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("Invalid JSON in {path}: {message}")]
    InvalidJson { path: PathBuf, message: String },

    #[error("Config file must contain a JSON object: {0}")]
    NotJsonObject(PathBuf),

    #[error("Validation error: {0}")]
    Validation(String),

    #[error("{0} does not support {1}.")]
    UnsupportedProvider(String, &'static str),

    #[error("Changing observability requires a trusted user config directory.")]
    UntrustedObservabilityChange,

    #[error("Path is outside the permitted roots: {0}")]
    OutsidePermittedRoots(PathBuf),

    #[error("Timed out acquiring file lock at {path} after {waited_ms}ms")]
    FileLockTimeout { path: PathBuf, waited_ms: u64 },

    #[error("SQLite file lock error at {path}: {source}")]
    FileLockSqlite {
        path: PathBuf,
        #[source]
        source: rusqlite::Error,
    },
}

pub type Result<T> = std::result::Result<T, ConfigError>;
