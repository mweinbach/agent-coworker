use std::path::PathBuf;

/// Typed errors returned by `cowork-env` runtime verification, shell, `uv`, and `soffice` operations.
#[derive(Debug, thiserror::Error)]
pub enum EnvError {
    #[error("I/O error at {path}: {source}")]
    IoPath {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Unsupported host platform/architecture for Cowork runtime: {platform}-{arch}")]
    UnsupportedHost { platform: String, arch: String },

    #[error("Invalid Cowork runtime manifest: {0}")]
    Manifest(String),

    #[error("Runtime signature verification failed: {0}")]
    Signature(String),

    #[error("Runtime integrity verification failed: {0}")]
    Integrity(String),

    #[error("Unsafe or corrupt runtime archive: {0}")]
    Archive(String),

    #[error("Cowork runtime bootstrap lock timed out at {path}")]
    LockTimeout { path: PathBuf },

    #[error("Cowork runtime lock error: {0}")]
    Lock(String),

    #[error(
        "Cowork runtime is not installed locally and network downloads are disabled (COWORK_RUNTIME_ALLOW_NETWORK=0): {0}"
    )]
    NetworkDisabled(String),

    #[error("Cowork runtime is disabled via COWORK_DISABLE_RUNTIME=1")]
    RuntimeDisabled,

    #[error("uv Python manager unavailable: {0}")]
    UvUnavailable(String),

    #[error("uv Python command failed: {0}")]
    UvFailed(String),

    #[error("Managed LibreOffice launcher is unavailable in active Cowork runtime: {0}")]
    SofficeUnavailable(String),

    #[error("Disallowed LibreOffice/Poppler flag or argument rejected by policy: {0}")]
    SofficeForbiddenFlag(String),

    #[error("LibreOffice conversion requires full OS sandbox enforcement: {0}")]
    SofficeSandboxUnenforced(String),

    #[error("LibreOffice/Poppler invocation timed out after {timeout_ms}ms")]
    SofficeTimeout { timeout_ms: u64 },

    #[error("LibreOffice/Poppler invocation failed: {0}")]
    SofficeFailed(String),

    #[error("Shell execution failed: {0}")]
    ShellFailed(String),
}

pub type Result<T> = std::result::Result<T, EnvError>;
