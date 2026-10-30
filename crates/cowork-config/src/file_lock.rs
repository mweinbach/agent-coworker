use std::collections::{BTreeSet, HashMap};
use std::fs::OpenOptions;
use std::future::Future;
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use rusqlite::{Connection, ErrorCode};
use sha2::{Digest, Sha256};

use crate::error::{ConfigError, Result};
use crate::paths::{
    canonicalize_sync, cowork_home, ensure_private_dir_sync, env_map_from_process,
    normalize_lexical_path,
};

/// Maximum end-to-end wait time for `with_file_lock` callers (`10_000ms`), matching `src/utils/fileLock.ts`.
pub const FILE_LOCK_ACQUIRE_TIMEOUT_MS: u64 = 10_000;
const DEFAULT_RETRY_DELAY_MS: u64 = 25;

#[derive(Debug, Clone, Default)]
pub struct FileLockOptions {
    pub acquire_timeout_ms: Option<u64>,
    pub retry_delay_ms: Option<u64>,
    pub lock_root: Option<PathBuf>,
}

#[derive(Debug, Clone)]
struct ResolvedLockSet {
    paths: Vec<PathBuf>,
    primary_path: PathBuf,
    queue_key: String,
}

fn async_queues() -> &'static Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>> {
    static QUEUES: OnceLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> = OnceLock::new();
    QUEUES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn sync_queues() -> &'static Mutex<HashMap<String, Arc<Mutex<()>>>> {
    static QUEUES: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    QUEUES.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn file_lock_root_for_cowork_home(cowork_root: &Path) -> PathBuf {
    canonicalize_sync(cowork_root).join("locks").join("files")
}

fn stable_path_identity(target_path: &Path) -> String {
    normalize_lexical_path(target_path)
        .to_string_lossy()
        .to_lowercase()
}

fn database_path_for_identity(identity: &str, lock_root: &Path) -> PathBuf {
    let hash = hex::encode(Sha256::digest(identity.as_bytes()));
    lock_root.join(format!("{hash}.sqlite"))
}

fn resolved_lock_root(lock_root: Option<&Path>) -> PathBuf {
    match lock_root {
        Some(root) => canonicalize_sync(root),
        None => {
            let env = env_map_from_process();
            canonicalize_sync(&file_lock_root_for_cowork_home(&cowork_home(&env)))
        }
    }
}

/// Computes the primary `<sha256>.sqlite` lock database path for `target_path`.
pub fn lock_database_path_for(target_path: &Path, lock_root: Option<&Path>) -> PathBuf {
    let canonical_snapshot = canonicalize_sync(target_path);
    database_path_for_identity(
        &stable_path_identity(&canonical_snapshot),
        &resolved_lock_root(lock_root),
    )
}

fn resolve_lock_set(target_path: &Path, lock_root: Option<&Path>) -> ResolvedLockSet {
    let root = resolved_lock_root(lock_root);
    let lexical_identity = stable_path_identity(&normalize_lexical_path(target_path));
    let canonical_identity = stable_path_identity(&canonicalize_sync(target_path));
    let primary_path = database_path_for_identity(&canonical_identity, &root);

    let mut unique_sorted = BTreeSet::new();
    unique_sorted.insert(database_path_for_identity(&lexical_identity, &root));
    unique_sorted.insert(primary_path.clone());

    let paths: Vec<PathBuf> = unique_sorted.into_iter().collect();
    let queue_key = paths
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("\0");

    ResolvedLockSet {
        paths,
        primary_path,
        queue_key,
    }
}

fn is_sqlite_contention(err: &rusqlite::Error) -> bool {
    match err {
        rusqlite::Error::SqliteFailure(ffi_err, _) => {
            matches!(
                ffi_err.code,
                ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked
            )
        }
        _ => false,
    }
}

struct HeldSqliteLock {
    conn: Option<Connection>,
}

impl HeldSqliteLock {
    fn release(&mut self) {
        if let Some(conn) = self.conn.take() {
            let _ = conn.execute_batch("ROLLBACK");
            let _ = conn.close();
        }
    }
}

impl Drop for HeldSqliteLock {
    fn drop(&mut self) {
        self.release();
    }
}

struct HeldLockSet {
    locks: Vec<HeldSqliteLock>,
}

impl HeldLockSet {
    fn release_all(&mut self) {
        while let Some(mut lock) = self.locks.pop() {
            lock.release();
        }
    }
}

impl Drop for HeldLockSet {
    fn drop(&mut self) {
        self.release_all();
    }
}

fn precreate_private_sqlite_file(lock_path: &Path) -> Result<()> {
    if let Some(parent) = lock_path.parent() {
        ensure_private_dir_sync(parent)?;
    }
    let mut open_opts = OpenOptions::new();
    open_opts.create(true).append(true);
    #[cfg(unix)]
    {
        open_opts.mode(0o600);
    }
    let file = open_opts
        .open(lock_path)
        .map_err(|source| ConfigError::Io {
            path: lock_path.to_path_buf(),
            source,
        })?;
    drop(file);
    #[cfg(unix)]
    {
        let _ = std::fs::set_permissions(lock_path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn acquire_single_lock_blocking(
    lock_path: &Path,
    started_at: Instant,
    deadline: Instant,
    retry_delay: Duration,
) -> Result<HeldSqliteLock> {
    precreate_private_sqlite_file(lock_path)?;

    if Instant::now() >= deadline {
        return Err(ConfigError::FileLockTimeout {
            path: lock_path.to_path_buf(),
            waited_ms: started_at.elapsed().as_millis() as u64,
        });
    }

    let conn = Connection::open(lock_path).map_err(|source| ConfigError::FileLockSqlite {
        path: lock_path.to_path_buf(),
        source,
    })?;
    conn.execute_batch("PRAGMA busy_timeout = 0")
        .map_err(|source| ConfigError::FileLockSqlite {
            path: lock_path.to_path_buf(),
            source,
        })?;

    loop {
        if Instant::now() >= deadline {
            let _ = conn.close();
            return Err(ConfigError::FileLockTimeout {
                path: lock_path.to_path_buf(),
                waited_ms: started_at.elapsed().as_millis() as u64,
            });
        }

        match conn.execute_batch("BEGIN IMMEDIATE") {
            Ok(()) => {
                if Instant::now() > deadline {
                    let _ = conn.execute_batch("ROLLBACK");
                    let _ = conn.close();
                    return Err(ConfigError::FileLockTimeout {
                        path: lock_path.to_path_buf(),
                        waited_ms: started_at.elapsed().as_millis() as u64,
                    });
                }
                return Ok(HeldSqliteLock { conn: Some(conn) });
            }
            Err(err) if is_sqlite_contention(&err) => {
                let now = Instant::now();
                if now >= deadline {
                    let _ = conn.close();
                    return Err(ConfigError::FileLockTimeout {
                        path: lock_path.to_path_buf(),
                        waited_ms: started_at.elapsed().as_millis() as u64,
                    });
                }
                let remaining = deadline.saturating_duration_since(now);
                std::thread::sleep(retry_delay.min(remaining));
            }
            Err(source) => {
                let _ = conn.close();
                return Err(ConfigError::FileLockSqlite {
                    path: lock_path.to_path_buf(),
                    source,
                });
            }
        }
    }
}

async fn acquire_single_lock_async(
    lock_path: &Path,
    started_at: Instant,
    deadline: Instant,
    retry_delay: Duration,
) -> Result<HeldSqliteLock> {
    precreate_private_sqlite_file(lock_path)?;

    if Instant::now() >= deadline {
        return Err(ConfigError::FileLockTimeout {
            path: lock_path.to_path_buf(),
            waited_ms: started_at.elapsed().as_millis() as u64,
        });
    }

    let conn = Connection::open(lock_path).map_err(|source| ConfigError::FileLockSqlite {
        path: lock_path.to_path_buf(),
        source,
    })?;
    conn.execute_batch("PRAGMA busy_timeout = 0")
        .map_err(|source| ConfigError::FileLockSqlite {
            path: lock_path.to_path_buf(),
            source,
        })?;

    loop {
        if Instant::now() >= deadline {
            let _ = conn.close();
            return Err(ConfigError::FileLockTimeout {
                path: lock_path.to_path_buf(),
                waited_ms: started_at.elapsed().as_millis() as u64,
            });
        }

        match conn.execute_batch("BEGIN IMMEDIATE") {
            Ok(()) => {
                if Instant::now() > deadline {
                    let _ = conn.execute_batch("ROLLBACK");
                    let _ = conn.close();
                    return Err(ConfigError::FileLockTimeout {
                        path: lock_path.to_path_buf(),
                        waited_ms: started_at.elapsed().as_millis() as u64,
                    });
                }
                return Ok(HeldSqliteLock { conn: Some(conn) });
            }
            Err(err) if is_sqlite_contention(&err) => {
                let now = Instant::now();
                if now >= deadline {
                    let _ = conn.close();
                    return Err(ConfigError::FileLockTimeout {
                        path: lock_path.to_path_buf(),
                        waited_ms: started_at.elapsed().as_millis() as u64,
                    });
                }
                let remaining = deadline.saturating_duration_since(now);
                tokio::time::sleep(retry_delay.min(remaining)).await;
            }
            Err(source) => {
                let _ = conn.close();
                return Err(ConfigError::FileLockSqlite {
                    path: lock_path.to_path_buf(),
                    source,
                });
            }
        }
    }
}

/// Synchronous cross-process + in-process advisory SQLite file lock (`locks/files/<sha256>.sqlite`).
pub fn with_file_lock_sync<T, E, F>(
    target_path: &Path,
    callback: F,
    opts: FileLockOptions,
) -> std::result::Result<T, E>
where
    E: From<ConfigError>,
    F: FnOnce() -> std::result::Result<T, E>,
{
    let acquire_timeout = Duration::from_millis(
        opts.acquire_timeout_ms
            .unwrap_or(FILE_LOCK_ACQUIRE_TIMEOUT_MS)
            .max(1),
    );
    let retry_delay =
        Duration::from_millis(opts.retry_delay_ms.unwrap_or(DEFAULT_RETRY_DELAY_MS).max(1));
    let started_at = Instant::now();
    let deadline = started_at + acquire_timeout;
    let lock_set = resolve_lock_set(target_path, opts.lock_root.as_deref());

    let queue_mutex = {
        let mut map = sync_queues().lock();
        Arc::clone(
            map.entry(lock_set.queue_key.clone())
                .or_insert_with(|| Arc::new(Mutex::new(()))),
        )
    };

    let Some(_in_process_guard) = queue_mutex.try_lock_until(deadline) else {
        return Err(ConfigError::FileLockTimeout {
            path: lock_set.primary_path,
            waited_ms: started_at.elapsed().as_millis() as u64,
        }
        .into());
    };

    let mut held = HeldLockSet { locks: Vec::new() };
    for lock_path in &lock_set.paths {
        held.locks.push(acquire_single_lock_blocking(
            lock_path,
            started_at,
            deadline,
            retry_delay,
        )?);
    }

    let res = callback();
    held.release_all();
    res
}

/// Async cross-process + in-process advisory SQLite file lock (`locks/files/<sha256>.sqlite`).
pub async fn with_file_lock<T, E, F, Fut>(
    target_path: &Path,
    callback: F,
    opts: FileLockOptions,
) -> std::result::Result<T, E>
where
    E: From<ConfigError>,
    F: FnOnce() -> Fut,
    Fut: Future<Output = std::result::Result<T, E>>,
{
    let acquire_timeout = Duration::from_millis(
        opts.acquire_timeout_ms
            .unwrap_or(FILE_LOCK_ACQUIRE_TIMEOUT_MS)
            .max(1),
    );
    let retry_delay =
        Duration::from_millis(opts.retry_delay_ms.unwrap_or(DEFAULT_RETRY_DELAY_MS).max(1));
    let started_at = Instant::now();
    let deadline = started_at + acquire_timeout;
    let lock_set = resolve_lock_set(target_path, opts.lock_root.as_deref());

    let queue_mutex = {
        let mut map = async_queues().lock();
        Arc::clone(
            map.entry(lock_set.queue_key.clone())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))),
        )
    };

    let remaining = deadline.saturating_duration_since(Instant::now());
    let Ok(_in_process_guard) = tokio::time::timeout(remaining, queue_mutex.lock()).await else {
        return Err(ConfigError::FileLockTimeout {
            path: lock_set.primary_path,
            waited_ms: started_at.elapsed().as_millis() as u64,
        }
        .into());
    };

    let mut held = HeldLockSet { locks: Vec::new() };
    for lock_path in &lock_set.paths {
        held.locks
            .push(acquire_single_lock_async(lock_path, started_at, deadline, retry_delay).await?);
    }

    let res = callback().await;
    held.release_all();
    res
}
