use std::collections::HashSet;
use std::fs;
use std::future::Future;
#[cfg(unix)]
use std::os::unix::fs::DirBuilderExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use chrono::Utc;
use parking_lot::Mutex as SyncMutex;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex as AsyncMutex;
use tokio::task::JoinHandle;
use uuid::Uuid;

use crate::error::{Result, StorageError};
use crate::hardening::{ensure_private_directory, harden_private_file};

pub const DEFAULT_ACQUIRE_TIMEOUT_MS: u64 = 30_000;
pub const DEFAULT_RETRY_DELAY_MS: u64 = 50;
pub const DEFAULT_STALE_LOCK_MS: u64 = 30_000;
pub const DEFAULT_HEARTBEAT_MS: u64 = 1_000;

tokio::task_local! {
    static ACTIVE_WRITE_LOCKS: HashSet<PathBuf>;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LockOwnerMetadata {
    pid: u32,
    started_at: String,
    updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    owner_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    operation: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SessionDbWriteCoordinatorOptions {
    pub root_dir: PathBuf,
    pub acquire_timeout_ms: Option<u64>,
    pub retry_delay_ms: Option<u64>,
    pub stale_lock_ms: Option<u64>,
    pub heartbeat_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDbWriteLockDiagnostics {
    pub wait_count: u64,
    pub timeout_count: u64,
    pub sqlite_lock_error_count: u64,
    pub stale_recovery_count: u64,
    pub last_wait_ms: u64,
    pub max_wait_ms: u64,
}

/// Cross-process write lock coordinator compatible with `src/server/sessionDb/writeCoordinator.ts`.
///
/// Acquires `<rootDir>/locks/session-db-write.lock` (`0700`) and writes `owner.json` (`0600`)
/// containing `{ pid, ownerId, operation, startedAt, updatedAt }`.
pub struct SessionDbWriteCoordinator {
    lock_root_dir: PathBuf,
    lock_dir: PathBuf,
    owner_file_path: PathBuf,
    acquire_timeout_ms: u64,
    retry_delay_ms: u64,
    stale_lock_ms: u64,
    heartbeat_ms: u64,
    local_mutex: AsyncMutex<()>,
    diagnostics: Arc<SyncMutex<SessionDbWriteLockDiagnostics>>,
}

impl SessionDbWriteCoordinator {
    pub fn new(opts: SessionDbWriteCoordinatorOptions) -> Self {
        let lock_root_dir = opts.root_dir.join("locks");
        let lock_dir = lock_root_dir.join("session-db-write.lock");
        let owner_file_path = lock_dir.join("owner.json");
        Self {
            lock_root_dir,
            lock_dir,
            owner_file_path,
            acquire_timeout_ms: opts
                .acquire_timeout_ms
                .unwrap_or(DEFAULT_ACQUIRE_TIMEOUT_MS),
            retry_delay_ms: opts.retry_delay_ms.unwrap_or(DEFAULT_RETRY_DELAY_MS).max(1),
            stale_lock_ms: opts.stale_lock_ms.unwrap_or(DEFAULT_STALE_LOCK_MS),
            heartbeat_ms: opts.heartbeat_ms.unwrap_or(DEFAULT_HEARTBEAT_MS).max(50),
            local_mutex: AsyncMutex::new(()),
            diagnostics: Arc::new(SyncMutex::new(SessionDbWriteLockDiagnostics::default())),
        }
    }

    pub fn owns_current_context(&self) -> bool {
        ACTIVE_WRITE_LOCKS
            .try_with(|locks| locks.contains(&self.lock_dir))
            .unwrap_or(false)
    }

    pub fn diagnostics(&self) -> SessionDbWriteLockDiagnostics {
        *self.diagnostics.lock()
    }

    pub async fn run_exclusive<T, F, Fut>(&self, operation: &str, callback: F) -> Result<T>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<T>>,
    {
        if self.owns_current_context() {
            return callback().await;
        }

        let _local_guard = self.local_mutex.lock().await;
        let handle = self.acquire(operation).await?;

        let mut next_locks = ACTIVE_WRITE_LOCKS
            .try_with(|locks| locks.clone())
            .unwrap_or_default();
        next_locks.insert(self.lock_dir.clone());

        let outcome = ACTIVE_WRITE_LOCKS.scope(next_locks, callback()).await;
        if let Err(ref err) = outcome
            && err.is_database_locked()
        {
            self.diagnostics.lock().sqlite_lock_error_count += 1;
        }

        handle.release();
        outcome
    }

    async fn acquire(&self, operation: &str) -> Result<AcquiredLockHandle> {
        ensure_private_directory(&self.lock_root_dir)?;

        let started = Instant::now();
        let mut stale_recoveries: u64 = 0;

        loop {
            let owner = make_owner_metadata(operation);
            match create_lock_dir(&self.lock_dir) {
                Ok(()) => {
                    if let Err(err) = write_owner_metadata(&self.owner_file_path, &owner) {
                        let _ = fs::remove_dir_all(&self.lock_dir);
                        return Err(err);
                    }

                    let waited_ms = started.elapsed().as_millis() as u64;
                    if waited_ms > 0 || stale_recoveries > 0 {
                        self.record_wait(waited_ms, stale_recoveries);
                    }

                    let heartbeat = self.spawn_heartbeat(owner.clone());
                    return Ok(AcquiredLockHandle {
                        lock_dir: self.lock_dir.clone(),
                        owner_file_path: self.owner_file_path.clone(),
                        owner,
                        heartbeat,
                    });
                }
                Err(err) if is_contention_io_error(&err) => {
                    if err.kind() == std::io::ErrorKind::AlreadyExists && self.cleanup_stale_lock()
                    {
                        stale_recoveries += 1;
                        continue;
                    }

                    let waited_ms = started.elapsed().as_millis() as u64;
                    if waited_ms >= self.acquire_timeout_ms {
                        let blocking = read_owner_metadata(&self.owner_file_path);
                        let details = if let Some(b) = blocking {
                            format!(
                                "; blocking owner pid={} operation={:?} startedAt={} updatedAt={}",
                                b.pid,
                                b.operation.as_deref().unwrap_or("unknown"),
                                b.started_at,
                                b.updated_at
                            )
                        } else {
                            String::new()
                        };
                        self.record_wait(waited_ms, stale_recoveries);
                        self.diagnostics.lock().timeout_count += 1;
                        return Err(StorageError::LockTimeout {
                            operation: operation.to_string(),
                            waited_ms,
                            details,
                        });
                    }

                    tokio::time::sleep(Duration::from_millis(self.retry_delay_ms)).await;
                }
                Err(err) => return Err(StorageError::Io(err)),
            }
        }
    }

    fn cleanup_stale_lock(&self) -> bool {
        if let Some(owner) = read_owner_metadata(&self.owner_file_path) {
            // A stalled heartbeat is NOT proof that a live writer released its lock!
            if process_alive(owner.pid) {
                return false;
            }
            let _ = fs::remove_dir_all(&self.lock_dir);
            return true;
        }

        match fs::metadata(&self.lock_dir) {
            Ok(meta) => {
                if let Ok(modified) = meta.modified()
                    && let Ok(age) = SystemTime::now().duration_since(modified)
                    && age.as_millis() as u64 >= self.stale_lock_ms
                {
                    let _ = fs::remove_dir_all(&self.lock_dir);
                    return true;
                }
                false
            }
            Err(_) => true,
        }
    }

    fn record_wait(&self, waited_ms: u64, stale_recoveries: u64) {
        let mut diag = self.diagnostics.lock();
        diag.wait_count += 1;
        diag.stale_recovery_count += stale_recoveries;
        diag.last_wait_ms = waited_ms;
        diag.max_wait_ms = diag.max_wait_ms.max(waited_ms);
    }

    fn spawn_heartbeat(&self, owner: LockOwnerMetadata) -> JoinHandle<()> {
        let owner_path = self.owner_file_path.clone();
        let interval_ms = self.heartbeat_ms;
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_millis(interval_ms));
            ticker.tick().await;
            loop {
                ticker.tick().await;
                let mut next = owner.clone();
                next.updated_at = now_iso_millis();
                let _ = write_owner_metadata(&owner_path, &next);
            }
        })
    }
}

struct AcquiredLockHandle {
    lock_dir: PathBuf,
    owner_file_path: PathBuf,
    owner: LockOwnerMetadata,
    heartbeat: JoinHandle<()>,
}

impl AcquiredLockHandle {
    fn release(self) {
        self.heartbeat.abort();
        let live_owner = read_owner_metadata(&self.owner_file_path);
        let should_remove = match live_owner {
            None => true,
            Some(live) => live.owner_id == self.owner.owner_id,
        };
        if should_remove {
            let _ = fs::remove_dir_all(&self.lock_dir);
        }
    }
}

fn create_lock_dir(path: &Path) -> std::io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    builder.mode(0o700);
    builder.create(path)
}

fn is_contention_io_error(err: &std::io::Error) -> bool {
    matches!(
        err.kind(),
        std::io::ErrorKind::AlreadyExists | std::io::ErrorKind::PermissionDenied
    )
}

fn make_owner_metadata(operation: &str) -> LockOwnerMetadata {
    let at = now_iso_millis();
    LockOwnerMetadata {
        pid: std::process::id(),
        started_at: at.clone(),
        updated_at: at,
        owner_id: Some(Uuid::new_v4().to_string()),
        operation: Some(operation.to_string()),
    }
}

fn write_owner_metadata(owner_path: &Path, owner: &LockOwnerMetadata) -> Result<()> {
    let payload = format!("{}\n", serde_json::to_string_pretty(owner)?);
    fs::write(owner_path, payload)?;
    harden_private_file(owner_path);
    Ok(())
}

fn read_owner_metadata(owner_path: &Path) -> Option<LockOwnerMetadata> {
    let raw = fs::read_to_string(owner_path).ok()?;
    let parsed: LockOwnerMetadata = serde_json::from_str(&raw).ok()?;
    if parsed.pid == 0 || parsed.started_at.is_empty() || parsed.updated_at.is_empty() {
        return None;
    }
    Some(parsed)
}

pub fn process_alive(pid: u32) -> bool {
    if pid == 0 || pid > i32::MAX as u32 {
        return false;
    }
    #[cfg(unix)]
    {
        // SAFETY: kill(pid, 0) sends no signal and only probes process existence/permission.
        let rc = unsafe { libc::kill(pid as libc::pid_t, 0) };
        if rc == 0 {
            return true;
        }
        let errno = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
        errno != libc::ESRCH
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        true
    }
}

pub(crate) fn now_iso_millis() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
