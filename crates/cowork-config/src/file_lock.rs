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
    /// Lock databases to take, sorted (the global acquisition order).
    paths: Vec<PathBuf>,
    primary_path: PathBuf,
}

/// In-process gate for one `<sha256>.sqlite` lock database, shared by sync and async callers.
///
/// Every caller that touches a lock database (pre-create, open, `BEGIN IMMEDIATE`, close) holds
/// its gate first, so no thread in this process opens or closes a descriptor on that inode while
/// another thread holds its SQLite lock: on POSIX, closing any descriptor of an inode drops every
/// `fcntl` lock the process holds on it, which would silently release the cross-process lock.
/// Gates are per lock path (not per lock set), so a caller reaching the same database through a
/// symlinked and a canonical target path is serialized too. Not reentrant: a nested lock on the
/// same path waits until its deadline, as before.
#[derive(Default)]
struct PathGate {
    locked: Mutex<bool>,
    sync_waiters: parking_lot::Condvar,
    async_waiters: tokio::sync::Notify,
}

impl PathGate {
    fn try_acquire(&self) -> bool {
        let mut locked = self.locked.lock();
        !std::mem::replace(&mut *locked, true)
    }

    fn acquire_blocking(&self, deadline: Instant) -> bool {
        let mut locked = self.locked.lock();
        while *locked {
            if self
                .sync_waiters
                .wait_until(&mut locked, deadline)
                .timed_out()
                && *locked
            {
                return false;
            }
        }
        *locked = true;
        true
    }

    async fn acquire_async(&self, deadline: Instant) -> bool {
        loop {
            let notified = self.async_waiters.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.try_acquire() {
                return true;
            }
            if tokio::time::timeout_at(deadline.into(), notified)
                .await
                .is_err()
            {
                return self.try_acquire();
            }
        }
    }

    fn release(&self) {
        *self.locked.lock() = false;
        // Wake one waiter of each kind; the loser of the race waits again and is woken by the
        // winner's own release.
        self.sync_waiters.notify_one();
        self.async_waiters.notify_one();
    }
}

fn path_gate(lock_path: &Path) -> Arc<PathGate> {
    static GATES: OnceLock<Mutex<HashMap<PathBuf, Arc<PathGate>>>> = OnceLock::new();
    let mut gates = GATES.get_or_init(|| Mutex::new(HashMap::new())).lock();
    Arc::clone(gates.entry(lock_path.to_path_buf()).or_default())
}

/// A held [`PathGate`]; released on drop.
struct HeldGate(Arc<PathGate>);

impl Drop for HeldGate {
    fn drop(&mut self) {
        self.0.release();
    }
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

    ResolvedLockSet {
        paths,
        primary_path,
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
    /// `(gate, lock)` pairs in acquisition order; each SQLite lock is released (and its
    /// connection closed) before its gate.
    locks: Vec<(HeldGate, Option<HeldSqliteLock>)>,
}

impl HeldLockSet {
    fn release_all(&mut self) {
        while let Some((gate, lock)) = self.locks.pop() {
            if let Some(mut lock) = lock {
                lock.release();
            }
            drop(gate);
        }
    }
}

impl Drop for HeldLockSet {
    fn drop(&mut self) {
        self.release_all();
    }
}

/// Creates a missing lock database as a private (`0600`) file. An existing one is never opened
/// here: closing that descriptor would drop the `fcntl` locks this process holds on the inode.
fn precreate_private_sqlite_file(lock_path: &Path) -> Result<()> {
    if let Some(parent) = lock_path.parent() {
        ensure_private_dir_sync(parent)?;
    }
    let mut open_opts = OpenOptions::new();
    open_opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        open_opts.mode(0o600);
    }
    match open_opts.open(lock_path) {
        Ok(file) => drop(file),
        Err(source) if source.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(source) => {
            return Err(ConfigError::Io {
                path: lock_path.to_path_buf(),
                source,
            });
        }
    }
    #[cfg(unix)]
    {
        // Path-based `chmod`: no descriptor is opened on the (possibly locked) inode.
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

    let mut held = HeldLockSet { locks: Vec::new() };
    for lock_path in &lock_set.paths {
        let gate = path_gate(lock_path);
        if !gate.acquire_blocking(deadline) {
            return Err(ConfigError::FileLockTimeout {
                path: lock_set.primary_path,
                waited_ms: started_at.elapsed().as_millis() as u64,
            }
            .into());
        }
        held.locks.push((HeldGate(gate), None));
        let lock = acquire_single_lock_blocking(lock_path, started_at, deadline, retry_delay)?;
        if let Some(last) = held.locks.last_mut() {
            last.1 = Some(lock);
        }
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

    let mut held = HeldLockSet { locks: Vec::new() };
    for lock_path in &lock_set.paths {
        let gate = path_gate(lock_path);
        if !gate.acquire_async(deadline).await {
            return Err(ConfigError::FileLockTimeout {
                path: lock_set.primary_path,
                waited_ms: started_at.elapsed().as_millis() as u64,
            }
            .into());
        }
        held.locks.push((HeldGate(gate), None));
        let lock = acquire_single_lock_async(lock_path, started_at, deadline, retry_delay).await?;
        if let Some(last) = held.locks.last_mut() {
            last.1 = Some(lock);
        }
    }

    let res = callback().await;
    held.release_all();
    res
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    const PROBE_ENV: &str = "COWORK_FILE_LOCK_PROBE_PATH";
    const PROBE_ACQUIRED: i32 = 10;
    const PROBE_BUSY: i32 = 11;

    /// Child-process half of [`probe_from_other_process`]: tries `BEGIN IMMEDIATE` once on the
    /// lock database named by `COWORK_FILE_LOCK_PROBE_PATH` and reports through the exit code.
    #[test]
    #[ignore = "helper run in a child process by the fcntl lock tests"]
    fn probe_child_begin_immediate() {
        let Ok(path) = std::env::var(PROBE_ENV) else {
            return;
        };
        let conn = Connection::open(path).unwrap();
        conn.execute_batch("PRAGMA busy_timeout = 0").unwrap();
        match conn.execute_batch("BEGIN IMMEDIATE") {
            Ok(()) => std::process::exit(PROBE_ACQUIRED),
            Err(err) if is_sqlite_contention(&err) => std::process::exit(PROBE_BUSY),
            Err(err) => panic!("unexpected probe error: {err}"),
        }
    }

    /// Whether another process can take the SQLite write lock on `lock_path` right now. POSIX
    /// `fcntl` locks are per process, so only a different process observes a lock this process
    /// lost by closing a descriptor.
    fn probe_from_other_process(lock_path: &Path) -> bool {
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "file_lock::tests::probe_child_begin_immediate",
                "--test-threads=1",
            ])
            .env(PROBE_ENV, lock_path)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
        match status.code() {
            Some(PROBE_ACQUIRED) => true,
            Some(PROBE_BUSY) => false,
            other => panic!("probe child exited unexpectedly: {other:?}"),
        }
    }

    #[test]
    fn precreate_does_not_drop_fcntl_locks_on_an_existing_lock_file() {
        let dir = tempfile::tempdir().unwrap();
        let lock_path = dir.path().join("locks").join("held.sqlite");
        precreate_private_sqlite_file(&lock_path).unwrap();
        let conn = Connection::open(&lock_path).unwrap();
        conn.execute_batch("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE")
            .unwrap();
        assert!(!probe_from_other_process(&lock_path), "lock must be held");

        precreate_private_sqlite_file(&lock_path).unwrap();
        assert!(
            !probe_from_other_process(&lock_path),
            "re-creating an existing lock file closed a descriptor and dropped the lock"
        );
        conn.execute_batch("ROLLBACK").unwrap();
        assert!(probe_from_other_process(&lock_path));
    }

    /// A sync caller and an async caller of the same lock path share one in-process gate, so
    /// the sync caller never touches the lock database while the async caller holds it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sync_caller_waits_for_async_holder_without_dropping_its_lock() {
        let dir = tempfile::tempdir().unwrap();
        let lock_root = dir.path().join("locks");
        let target = dir.path().join("target.json");
        std::fs::write(&target, "{}").unwrap();
        let opts = || FileLockOptions {
            lock_root: Some(lock_root.clone()),
            ..Default::default()
        };
        let lock_path = lock_database_path_for(&target, Some(&lock_root));
        let inside_async = Arc::new(std::sync::atomic::AtomicBool::new(false));

        let sync_thread = with_file_lock::<_, ConfigError, _, _>(
            &target,
            || {
                let inside_async = Arc::clone(&inside_async);
                let target = target.clone();
                let opts = opts();
                let lock_path = lock_path.clone();
                async move {
                    inside_async.store(true, std::sync::atomic::Ordering::SeqCst);
                    let flag = Arc::clone(&inside_async);
                    let sync_thread = std::thread::spawn(move || {
                        with_file_lock_sync::<_, ConfigError, _>(
                            &target,
                            || {
                                assert!(
                                    !flag.load(std::sync::atomic::Ordering::SeqCst),
                                    "sync caller ran while the async caller held the lock"
                                );
                                Ok(())
                            },
                            opts,
                        )
                    });
                    // Give the sync caller time to reach the lock database.
                    tokio::time::sleep(Duration::from_millis(300)).await;
                    assert!(
                        !probe_from_other_process(&lock_path),
                        "another process acquired the lock while it was held"
                    );
                    inside_async.store(false, std::sync::atomic::Ordering::SeqCst);
                    Ok(sync_thread)
                }
            },
            opts(),
        )
        .await
        .unwrap();
        sync_thread.join().unwrap().unwrap();
    }
}
