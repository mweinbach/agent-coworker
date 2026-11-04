use std::fs;
use std::path::{Path, PathBuf};

use chrono::Utc;

use crate::error::Result;

pub fn ensure_private_directory(dir_path: &Path) -> Result<()> {
    cowork_config::ensure_private_dir_sync(dir_path)?;
    Ok(())
}

pub fn harden_private_file(file_path: &Path) {
    cowork_config::harden_private_file_sync(file_path);
}

pub fn harden_sqlite_family(db_path: &Path) {
    harden_private_file(db_path);
    for suffix in ["-wal", "-shm"] {
        let sidecar = append_file_suffix(db_path, suffix);
        if sidecar.exists() {
            harden_private_file(&sidecar);
        }
    }
}

/// Quarantines a corrupted SQLite database to `<dbPath>.corrupt.<ISO-timestamp>.bak`.
/// Fails closed if the primary database file cannot be renamed so data is never overwritten.
pub fn quarantine_corrupted_db(db_path: &Path) -> Result<PathBuf> {
    let ts = Utc::now()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        .replace(':', "-");
    let suffix = format!(".corrupt.{ts}.bak");
    let backup_path = append_file_suffix(db_path, &suffix);

    // Recovery MUST stop if the primary corrupt copy cannot be preserved.
    fs::rename(db_path, &backup_path)?;
    harden_private_file(&backup_path);

    // Move stale WAL/SHM sidecars alongside the quarantined copy if present so the
    // freshly created replacement database never replays corrupted WAL frames.
    for sidecar_ext in ["-wal", "-shm"] {
        let sidecar = append_file_suffix(db_path, sidecar_ext);
        if sidecar.exists() {
            let sidecar_backup = append_file_suffix(&backup_path, sidecar_ext);
            let _ = fs::rename(&sidecar, &sidecar_backup);
        }
    }

    Ok(backup_path)
}

fn append_file_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut os = path.as_os_str().to_os_string();
    os.push(suffix);
    PathBuf::from(os)
}
