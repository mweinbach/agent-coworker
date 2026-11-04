use std::collections::{BTreeMap, HashMap, HashSet};
use std::ffi::OsStr;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use cowork_config::canonicalize_sync;
use cowork_sandbox::{host_arch, host_platform};
use data_encoding::BASE64;
use ed25519_dalek::{Signer, SigningKey};
use rayon::prelude::*;
use uuid::Uuid;
use walkdir::WalkDir;

use crate::archive::{
    ArchiveFormat, assert_safe_relative_runtime_path, detect_archive_format,
    extract_v1_zip_archive, extract_v2_tar_zst_archive,
};
use crate::error::{EnvError, Result};
use crate::integrity::{
    hash_bytes_dual, hash_regular_file, remove_sealed_tree, seal_tree_readonly,
    verify_ed25519_envelope, verify_installed_runtime, verify_integrity_tree_parallel,
};
use crate::manifest::{
    InstalledRuntimePointer, IntegrityEntryKind, IntegrityFileEntry, PreparedRuntime,
    RuntimeComponents, RuntimeIntegrityManifest, RuntimeManifest, RuntimeManifestComponent,
    RuntimeManifestIntegrityRef, RuntimeManifestPaths, RuntimeManifestPayload,
    RuntimeManifestSource, RuntimePackId, RuntimePackManifest, RuntimeProgressCallback,
    RuntimeSignatureEnvelope, StartupProgressEvent, TrustedKeyRing, compatible_hosts_for_asset,
    is_asset_compatible_with_host, resolve_host_asset, runtime_asset_file_name,
    runtime_release_tag, validate_runtime_version,
};
use crate::shell::{ShellEnvOptions, build_canonical_shell_env, redact_secrets};

pub const DEFAULT_BOOTSTRAP_LOCK_TIMEOUT: Duration = Duration::from_secs(120);
pub const DEFAULT_COWORK_RUNTIME_VERSION: &str = "2026-06-22";
pub const DEFAULT_COWORK_RUNTIME_REPOSITORY: &str = "mweinbach/cowork-runtime";
pub const DEFAULT_COWORK_RUNTIME_BASE_URL: &str = "https://github.com";

const DOWNLOAD_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const DOWNLOAD_STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_CHECKSUM_BYTES: usize = 16 * 1024;
const DOWNLOAD_PROGRESS_STEP_BYTES: u64 = 1024 * 1024;
/// Upper bound on tar entries walked while looking for `pack.json` ahead of signature verification.
const MAX_PACK_ID_SCAN_ENTRIES: usize = crate::archive::MAX_ARCHIVE_ENTRY_COUNT;
/// Upper bound on the size of `pack.json` read ahead of signature verification.
const MAX_PACK_JSON_BYTES: u64 = 1024 * 1024;

pub fn runtime_root_dir(homedir: &Path) -> PathBuf {
    homedir.join(".cowork").join("runtime")
}

/// The `fs4` advisory lock file serializing runtime lifecycle work. It is deliberately not
/// [`legacy_bootstrap_lock_path`]: earlier installers own that path as a directory barrier.
pub fn bootstrap_lock_path(homedir: &Path) -> PathBuf {
    runtime_root_dir(homedir).join(".bootstrap-v2.lock")
}

/// The previous installer's bootstrap barrier: a `.bootstrap.lock` *directory* holding
/// `owner.json` (TS `bootstrapLock.ts`). It is honored, and published as a directory, while the
/// [`bootstrap_lock_path`] lock is held, so older and newer installers exclude each other across
/// an upgrade or rollback.
pub fn legacy_bootstrap_lock_path(homedir: &Path) -> PathBuf {
    runtime_root_dir(homedir).join(".bootstrap.lock")
}

pub fn consumer_lease_lock_path(runtime_dir: &Path) -> PathBuf {
    let mut os = runtime_dir.as_os_str().to_os_string();
    os.push(".lease.lock");
    PathBuf::from(os)
}

fn open_lock_file(path: &Path) -> Result<File> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut opts = OpenOptions::new();
    opts.create(true).read(true).write(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path).map_err(|source| EnvError::IoPath {
        path: path.to_path_buf(),
        source,
    })
}

const LEGACY_BARRIER_MARKER: &str = "owner.json";
/// Owner protocol this installer publishes. The previous TS installer refuses any marker whose
/// protocol is not its own (`cowork-runtime-sqlite-v1`), so it never adopts a live Rust barrier.
const LEGACY_BARRIER_PROTOCOL: &str = "cowork-runtime-flock-v1";
const LEGACY_BARRIER_UPDATED_AT: &str = "flock-owned";
const MAX_LEGACY_MARKER_BYTES: u64 = 64 * 1024;
/// A barrier without a readable owner is treated as mid-publication for this long.
const LEGACY_BARRIER_PUBLICATION_GRACE: Duration = Duration::from_secs(30);
/// No install holds the barrier this long; an older owner record names a reused pid.
const LEGACY_BARRIER_MAX_AGE: Duration = Duration::from_secs(6 * 60 * 60);
const LEGACY_BARRIER_POLL_INTERVAL: Duration = Duration::from_millis(100);

enum LegacyBarrierState {
    Absent,
    Live(String),
    StaleDirectory,
    StaleLockFile,
}

fn unrecognized_legacy_lock(path: &Path, what: &str) -> EnvError {
    EnvError::Lock(format!(
        "Unrecognized Cowork runtime bootstrap lock at {} ({what}). Stop older Cowork processes and remove the obsolete lock before retrying.",
        path.display()
    ))
}

fn io_at(path: &Path) -> impl FnOnce(std::io::Error) -> EnvError + '_ {
    move |source| EnvError::IoPath {
        path: path.to_path_buf(),
        source,
    }
}

fn elapsed_since(time: std::io::Result<std::time::SystemTime>) -> Duration {
    time.ok()
        .and_then(|t| t.elapsed().ok())
        .unwrap_or(Duration::ZERO)
}

/// Whether `pid` names a running process other than this one.
fn other_process_is_alive(pid: u32) -> bool {
    pid != std::process::id() && process_is_alive(pid)
}

#[cfg(unix)]
fn process_is_alive(pid: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    if pid <= 0 {
        return false;
    }
    // SAFETY: signal 0 only checks that the process exists and may be signalled.
    if unsafe { libc::kill(pid, 0) } == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(windows)]
fn process_is_alive(pid: u32) -> bool {
    type Handle = *mut std::ffi::c_void;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(desired_access: u32, inherit_handle: i32, process_id: u32) -> Handle;
        fn GetExitCodeProcess(process: Handle, exit_code: *mut u32) -> i32;
        fn CloseHandle(object: Handle) -> i32;
    }
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const STILL_ACTIVE: u32 = 259;
    const ERROR_ACCESS_DENIED: i32 = 5;

    // SAFETY: plain Win32 calls; the handle is closed before returning.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        // A process we may not query still exists; anything else (invalid pid) is gone.
        return std::io::Error::last_os_error().raw_os_error() == Some(ERROR_ACCESS_DENIED);
    }
    let mut exit_code = 0_u32;
    // SAFETY: `handle` is a valid process handle and `exit_code` is writable.
    let ok = unsafe { GetExitCodeProcess(handle, &mut exit_code) };
    // SAFETY: `handle` was returned by `OpenProcess` above and is closed exactly once.
    let _ = unsafe { CloseHandle(handle) };
    ok == 0 || exit_code == STILL_ACTIVE
}

#[cfg(not(any(unix, windows)))]
fn process_is_alive(_pid: u32) -> bool {
    true
}

/// Most recent `startedAt`/`updatedAt` RFC 3339 timestamp in a barrier owner record. TS's SQLite
/// owners write a non-date `updatedAt`, so only `startedAt` parses for them.
fn owner_record_age(owner: &serde_json::Value) -> Option<Duration> {
    ["startedAt", "updatedAt"]
        .iter()
        .filter_map(|key| owner.get(*key)?.as_str())
        .filter_map(|raw| chrono::DateTime::parse_from_rfc3339(raw).ok())
        .map(|t| t.with_timezone(&chrono::Utc))
        .max()
        .map(|newest| {
            (chrono::Utc::now() - newest)
                .to_std()
                .unwrap_or(Duration::ZERO)
        })
}

fn read_owner_record(marker: &Path) -> Option<serde_json::Value> {
    use std::io::Read;
    let file = File::open(marker).ok()?;
    let mut raw = String::new();
    file.take(MAX_LEGACY_MARKER_BYTES)
        .read_to_string(&mut raw)
        .ok()?;
    serde_json::from_str::<serde_json::Value>(&raw)
        .ok()
        .filter(serde_json::Value::is_object)
}

/// Classifies whatever occupies the legacy `.bootstrap.lock` path. Only called while holding the
/// [`bootstrap_lock_path`] lock, which serializes every installer that understands this protocol.
fn classify_legacy_barrier(path: &Path) -> Result<LegacyBarrierState> {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(LegacyBarrierState::Absent);
        }
        Err(err) => return Err(io_at(path)(err)),
    };
    let ft = meta.file_type();
    if ft.is_symlink() {
        return Err(unrecognized_legacy_lock(path, "symlink"));
    }
    if ft.is_file() {
        // Pre-release builds of this installer `flock`ed a regular file at this path.
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
            .map_err(io_at(path))?;
        return match <File as fs4::FileExt>::try_lock(&file) {
            Ok(()) => {
                let _ = <File as fs4::FileExt>::unlock(&file);
                Ok(LegacyBarrierState::StaleLockFile)
            }
            Err(fs4::TryLockError::WouldBlock) => Ok(LegacyBarrierState::Live(
                "a pre-release installer holds the lock file".to_owned(),
            )),
            Err(fs4::TryLockError::Error(err)) => Err(io_at(path)(err)),
        };
    }
    if !ft.is_dir() {
        return Err(unrecognized_legacy_lock(path, "special file"));
    }

    let marker = path.join(LEGACY_BARRIER_MARKER);
    let marker_meta = match std::fs::symlink_metadata(&marker) {
        Ok(m) => Some(m),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
        Err(err) => return Err(io_at(&marker)(err)),
    };
    let (owner, published_age) = match &marker_meta {
        Some(m) if m.file_type().is_file() => {
            (read_owner_record(&marker), elapsed_since(m.modified()))
        }
        Some(_) => {
            return Err(unrecognized_legacy_lock(
                path,
                "owner.json is not a regular file",
            ));
        }
        None => (None, elapsed_since(meta.modified())),
    };
    let pid = owner
        .as_ref()
        .and_then(|o| o.get("pid")?.as_u64())
        .filter(|pid| *pid > 0)
        .and_then(|pid| u32::try_from(pid).ok());
    let Some(pid) = pid else {
        // An owner that has not finished publishing its marker (TS writes it right after mkdir).
        return Ok(if published_age < LEGACY_BARRIER_PUBLICATION_GRACE {
            LegacyBarrierState::Live("its owner is still being published".to_owned())
        } else {
            LegacyBarrierState::StaleDirectory
        });
    };
    if !other_process_is_alive(pid) {
        return Ok(LegacyBarrierState::StaleDirectory);
    }
    if owner
        .as_ref()
        .and_then(owner_record_age)
        .is_some_and(|age| age > LEGACY_BARRIER_MAX_AGE)
    {
        return Ok(LegacyBarrierState::StaleDirectory);
    }
    Ok(LegacyBarrierState::Live(format!(
        "it is owned by running process {pid}"
    )))
}

/// Removes an abandoned barrier without ever recursing: anything beyond `owner.json` is foreign.
fn remove_legacy_barrier_dir(path: &Path) -> Result<()> {
    match std::fs::remove_file(path.join(LEGACY_BARRIER_MARKER)) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(io_at(path)(err)),
    }
    match std::fs::remove_dir(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(unrecognized_legacy_lock(path, "unexpected entries")),
    }
}

/// The legacy directory barrier this process published; removed again on drop (including unwind).
struct LegacyBarrierGuard {
    path: PathBuf,
    token: String,
}

impl Drop for LegacyBarrierGuard {
    fn drop(&mut self) {
        let marker = self.path.join(LEGACY_BARRIER_MARKER);
        let ours = read_owner_record(&marker).is_some_and(|owner| {
            owner.get("token").and_then(serde_json::Value::as_str) == Some(self.token.as_str())
        });
        if ours {
            let _ = std::fs::remove_file(&marker);
            let _ = std::fs::remove_dir(&self.path);
        }
    }
}

fn try_publish_legacy_barrier(path: &Path) -> Result<Option<LegacyBarrierGuard>> {
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    match builder.create(path) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => return Ok(None),
        Err(err) => return Err(io_at(path)(err)),
    }
    let token = Uuid::new_v4().to_string();
    let owner = serde_json::json!({
        "protocol": LEGACY_BARRIER_PROTOCOL,
        "pid": std::process::id(),
        "token": &token,
        "startedAt": chrono::Utc::now().to_rfc3339(),
        "updatedAt": LEGACY_BARRIER_UPDATED_AT,
    });
    let marker = path.join(LEGACY_BARRIER_MARKER);
    let mut opts = OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let write = opts.open(&marker).and_then(|mut file| {
        file.write_all(format!("{owner}\n").as_bytes())?;
        file.sync_all()
    });
    if let Err(err) = write {
        let _ = std::fs::remove_file(&marker);
        let _ = std::fs::remove_dir(path);
        return Err(io_at(&marker)(err));
    }
    Ok(Some(LegacyBarrierGuard {
        path: path.to_path_buf(),
        token,
    }))
}

/// Waits (until `deadline`) for no live legacy barrier, reclaims abandoned ones, and publishes
/// this process's own directory barrier so older installers stay out while it is held.
fn acquire_legacy_barrier(
    homedir: &Path,
    deadline: Instant,
    mut report_wait: impl FnMut(),
) -> Result<LegacyBarrierGuard> {
    let path = legacy_bootstrap_lock_path(homedir);
    loop {
        match classify_legacy_barrier(&path)? {
            LegacyBarrierState::Absent => {
                if let Some(guard) = try_publish_legacy_barrier(&path)? {
                    return Ok(guard);
                }
                // Lost a race with an older installer creating its barrier; classify it.
            }
            LegacyBarrierState::StaleDirectory => remove_legacy_barrier_dir(&path)?,
            LegacyBarrierState::StaleLockFile => match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                Err(err) => return Err(io_at(&path)(err)),
            },
            LegacyBarrierState::Live(reason) => {
                if Instant::now() >= deadline {
                    tracing::warn!(
                        path = %path.display(),
                        "timed out waiting for a legacy Cowork runtime bootstrap lock: {reason}"
                    );
                    return Err(EnvError::LockTimeout { path });
                }
                report_wait();
                std::thread::sleep(LEGACY_BARRIER_POLL_INTERVAL);
            }
        }
    }
}

/// Synchronous single-writer bootstrap lock helper: an `fs4` lock on [`bootstrap_lock_path`],
/// then the legacy `.bootstrap.lock` directory barrier (see [`legacy_bootstrap_lock_path`]).
pub fn with_runtime_bootstrap_lock_sync<T, F>(
    homedir: &Path,
    version_hint: &str,
    timeout: Duration,
    on_progress: Option<&RuntimeProgressCallback>,
    work: F,
) -> Result<T>
where
    F: FnOnce() -> Result<T>,
{
    let deadline = Instant::now() + timeout;
    let mut reported_wait = false;
    let mut report_wait = || {
        if !reported_wait {
            reported_wait = true;
            if let Some(cb) = on_progress {
                cb(StartupProgressEvent::waiting(version_hint));
            }
        }
    };

    let lock_path = bootstrap_lock_path(homedir);
    let file = open_lock_file(&lock_path)?;

    match <File as fs4::FileExt>::try_lock(&file) {
        Ok(()) => {}
        Err(fs4::TryLockError::WouldBlock) => {
            report_wait();
            loop {
                std::thread::sleep(Duration::from_millis(15));
                match <File as fs4::FileExt>::try_lock(&file) {
                    Ok(()) => break,
                    Err(fs4::TryLockError::WouldBlock) => {
                        if Instant::now() >= deadline {
                            return Err(EnvError::LockTimeout { path: lock_path });
                        }
                    }
                    Err(fs4::TryLockError::Error(err)) => return Err(EnvError::Io(err)),
                }
            }
        }
        Err(fs4::TryLockError::Error(err)) => return Err(EnvError::Io(err)),
    }

    let result = match acquire_legacy_barrier(homedir, deadline, &mut report_wait) {
        Ok(barrier) => {
            let result = work();
            drop(barrier);
            result
        }
        Err(err) => Err(err),
    };
    let _ = <File as fs4::FileExt>::unlock(&file);
    result
}

/// Async wrapper around `with_runtime_bootstrap_lock_sync` that offloads lock waiting and work onto
/// `tokio::task::spawn_blocking` so Tokio worker threads never block.
pub async fn with_runtime_bootstrap_lock<T, F>(
    homedir: &Path,
    version_hint: &str,
    timeout: Duration,
    on_progress: Option<RuntimeProgressCallback>,
    work: F,
) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T> + Send + 'static,
{
    let home = homedir.to_path_buf();
    let ver = version_hint.to_owned();
    tokio::task::spawn_blocking(move || {
        with_runtime_bootstrap_lock_sync(&home, &ver, timeout, on_progress.as_ref(), work)
    })
    .await
    .map_err(|e| EnvError::Lock(format!("Bootstrap task join error: {e}")))?
}

/// OS-kernel-enforced shared reader lease preventing an active runtime directory from being pruned.
#[derive(Debug)]
pub struct RuntimeConsumerLease {
    file: File,
    runtime_dir: PathBuf,
}

impl RuntimeConsumerLease {
    pub fn acquire(runtime_dir: &Path) -> Result<Self> {
        let canonical = canonicalize_sync(runtime_dir);
        let lease_path = consumer_lease_lock_path(&canonical);
        let file = open_lock_file(&lease_path)?;
        <File as fs4::FileExt>::lock_shared(&file)?;
        if !canonical.is_dir() {
            return Err(EnvError::Lock(format!(
                "Cannot lease missing runtime {}",
                canonical.display()
            )));
        }
        Ok(Self {
            file,
            runtime_dir: canonical,
        })
    }

    pub fn runtime_dir(&self) -> &Path {
        &self.runtime_dir
    }
}

impl Drop for RuntimeConsumerLease {
    fn drop(&mut self) {
        let _ = <File as fs4::FileExt>::unlock(&self.file);
    }
}

// Keep the same lock file across pruning and reinstalling a version: a blocked reader
// may already hold an open handle to its inode.
fn try_lock_unused_runtime(runtime_dir: &Path) -> Result<Option<File>> {
    let path = consumer_lease_lock_path(&canonicalize_sync(runtime_dir));
    let file = open_lock_file(&path)?;
    match <File as fs4::FileExt>::try_lock(&file) {
        Ok(()) => Ok(Some(file)),
        Err(fs4::TryLockError::WouldBlock) => Ok(None),
        Err(fs4::TryLockError::Error(err)) => Err(err.into()),
    }
}

/// Returns `true` when a live lease or a lock error prevents mutation.
pub fn has_active_consumer_lease(runtime_dir: &Path) -> bool {
    if matches!(
        consumer_lease_lock_path(&canonicalize_sync(runtime_dir)).try_exists(),
        Ok(false)
    ) {
        return false;
    }
    !matches!(try_lock_unused_runtime(runtime_dir), Ok(Some(_)))
}

/// Options controlling offline/local Cowork runtime installation and retention.
#[derive(Clone)]
pub struct RuntimeInstallOptions {
    pub homedir: PathBuf,
    pub trusted_keys: TrustedKeyRing,
    pub expected_version: Option<String>,
    pub expected_archive_sha256: Option<String>,
    pub force: bool,
    pub keep_versions: usize,
    pub on_progress: Option<RuntimeProgressCallback>,
}

fn write_current_pointer(root: &Path, runtime: &PreparedRuntime) -> Result<()> {
    let now = chrono::Utc::now().to_rfc3339();
    let payload = serde_json::to_string_pretty(&InstalledRuntimePointer {
        schema_version: 1,
        version: runtime.version.clone(),
        asset: runtime.asset.clone(),
        installed_at: now.clone(),
        confirmed_at: Some(now),
        runtime_dir: None,
        installed_packs: runtime.installed_packs.clone(),
    })
    .map_err(|e| EnvError::Manifest(format!("Failed serializing current.json: {e}")))?;
    cowork_config::write_text_file_atomic(&root.join("current.json"), &payload, None)
        .map_err(|e| EnvError::Manifest(format!("Failed writing current.json: {e}")))
}

pub fn read_current_pointer(homedir: &Path) -> Option<InstalledRuntimePointer> {
    let raw = std::fs::read_to_string(runtime_root_dir(homedir).join("current.json")).ok()?;
    let pointer: InstalledRuntimePointer = serde_json::from_str(&raw).ok()?;
    if pointer.schema_version != 1 || validate_runtime_version(&pointer.version).is_err() {
        return None;
    }
    Some(pointer)
}

/// Parses a `.sha256` release checksum text file (`<64-hex>  <filename>` or `<64-hex>`).
pub fn checksum_from_text(text: &str, expected_file_name: &str) -> Result<String> {
    let is_sha256_hex = |s: &str| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit());
    let mut fallback: Option<String> = None;
    let mut mismatched_name: Option<String> = None;

    for raw_line in text.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.split_whitespace();
        let Some(candidate_hex) = parts.next() else {
            continue;
        };
        if !is_sha256_hex(candidate_hex) {
            return Err(EnvError::Integrity(format!(
                "Invalid SHA-256 digest in checksum file for {expected_file_name}"
            )));
        }
        let hex_lower = candidate_hex.to_ascii_lowercase();
        if let Some(rest) = parts.next() {
            let file_token = rest.trim_start_matches('*');
            let base = Path::new(file_token)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| file_token.to_owned());
            if base == expected_file_name {
                return Ok(hex_lower);
            }
            // A digest that names a different asset must never be used for this one.
            if mismatched_name.is_none() {
                mismatched_name = Some(base);
            }
        } else if fallback.is_none() {
            fallback = Some(hex_lower);
        }
    }

    fallback.ok_or_else(|| match mismatched_name {
        Some(named) => EnvError::Integrity(format!(
            "Checksum file names {named}, expected {expected_file_name}"
        )),
        None => EnvError::Integrity(format!(
            "No valid SHA-256 digest found in checksum file for {expected_file_name}"
        )),
    })
}

/// Prunes older installed runtime directories under `<homedir>/.cowork/runtime`, keeping `keep_versions`
/// newest versions while always preserving `current.json` and any runtime with an active `RuntimeConsumerLease`.
pub fn prune_installed_runtimes(homedir: &Path, keep_versions: usize) -> Result<Vec<PathBuf>> {
    with_runtime_bootstrap_lock_sync(
        homedir,
        "retention",
        DEFAULT_BOOTSTRAP_LOCK_TIMEOUT,
        None,
        || prune_installed_runtimes_locked(homedir, keep_versions),
    )
}

fn prune_installed_runtimes_locked(homedir: &Path, keep_versions: usize) -> Result<Vec<PathBuf>> {
    let root = runtime_root_dir(homedir);
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let keep = keep_versions.max(1);
    let current_ver = read_current_pointer(homedir).map(|p| p.version);

    let mut version_dirs: Vec<(String, PathBuf)> = Vec::new();
    for entry in std::fs::read_dir(&root)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if validate_runtime_version(&name).is_err() || !entry.file_type()?.is_dir() {
            continue;
        }
        let p = entry.path();
        if p.join("runtime.json").is_file() {
            version_dirs.push((name, p));
        }
    }

    // Newest version names sort lexicographically descending (`YYYY-MM-DD`).
    version_dirs.sort_by(|a, b| b.0.cmp(&a.0));

    let mut kept = usize::from(
        version_dirs
            .iter()
            .any(|(ver, _)| current_ver.as_ref() == Some(ver)),
    );
    let mut removed = Vec::new();
    for (ver, dir_path) in version_dirs {
        let is_current = current_ver.as_deref() == Some(ver.as_str());
        if is_current {
            continue;
        }
        if kept < keep {
            kept += 1;
            continue;
        }
        let Some(_lease) = try_lock_unused_runtime(&dir_path)? else {
            continue;
        };
        remove_sealed_tree(&dir_path)?;
        removed.push(dir_path);
    }
    Ok(removed)
}

fn verify_optional_archive_sha256(archive_path: &Path, expected: Option<&str>) -> Result<()> {
    let Some(expected_hex) = expected.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(());
    };
    let (actual_sha256, _, _) = hash_regular_file(archive_path)?;
    if !actual_sha256.eq_ignore_ascii_case(expected_hex) {
        return Err(EnvError::Integrity(format!(
            "Archive SHA-256 mismatch for {}: expected {expected_hex}, got {actual_sha256}",
            archive_path.display()
        )));
    }
    Ok(())
}

/// Installs, cryptographically verifies, read-only seals, and activates a signed v1 `.zip` runtime archive.
pub fn install_v1_zip_runtime(
    archive_path: &Path,
    opts: &RuntimeInstallOptions,
) -> Result<PreparedRuntime> {
    let version_hint = opts
        .expected_version
        .as_deref()
        .unwrap_or("installing")
        .to_owned();

    with_runtime_bootstrap_lock_sync(
        &opts.homedir,
        &version_hint,
        DEFAULT_BOOTSTRAP_LOCK_TIMEOUT,
        opts.on_progress.as_ref(),
        || {
            if let Some(cb) = &opts.on_progress {
                cb(StartupProgressEvent::installing(&version_hint));
            }
            verify_optional_archive_sha256(archive_path, opts.expected_archive_sha256.as_deref())?;

            let rt_root = runtime_root_dir(&opts.homedir);
            std::fs::create_dir_all(&rt_root)?;
            let staging_dir = rt_root.join(format!(".staging-v1-{}", Uuid::new_v4().simple()));

            let install_res = (|| -> Result<PreparedRuntime> {
                extract_v1_zip_archive(archive_path, &staging_dir)?;
                let staging_verified =
                    verify_installed_runtime(&staging_dir, &opts.trusted_keys, true)?;

                if let Some(expected_ver) = &opts.expected_version
                    && &staging_verified.version != expected_ver
                {
                    return Err(EnvError::Manifest(format!(
                        "Archive version {} does not match expected version {expected_ver}",
                        staging_verified.version
                    )));
                }

                promote_staged_runtime(&staging_dir, &staging_verified.version, opts)
            })();

            if staging_dir.exists() {
                let _ = remove_sealed_tree(&staging_dir);
            }
            install_res
        },
    )
}

fn copy_dir_tree_preserving_symlinks(
    src: &Path,
    dst: &Path,
    skip_rel: &HashSet<&str>,
) -> Result<()> {
    for item in WalkDir::new(src).follow_links(false) {
        let de = item.map_err(|e| EnvError::Archive(format!("Merge walk failed: {e}")))?;
        if de.path() == src {
            continue;
        }
        let rel = de.path().strip_prefix(src).unwrap();
        let rel_posix = rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        if skip_rel.contains(rel_posix.as_str()) {
            continue;
        }
        let target = dst.join(rel);
        let ft = de.file_type();
        if ft.is_dir() {
            std::fs::create_dir_all(&target)?;
        } else if ft.is_symlink() {
            if let Some(p) = target.parent() {
                std::fs::create_dir_all(p)?;
            }
            let link_dest = std::fs::read_link(de.path())?;
            #[cfg(unix)]
            {
                std::os::unix::fs::symlink(link_dest, &target)?;
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::FileTypeExt;
                // Windows distinguishes file and directory symlinks (pnpm `node_modules` links
                // are directory links). Trust the source link's own kind first, then fall back
                // to resolving the target relative to the link's parent in the source tree.
                let points_at_dir = ft.is_symlink_dir()
                    || std::fs::metadata(de.path())
                        .map(|m| m.is_dir())
                        .unwrap_or(false)
                    || de
                        .path()
                        .parent()
                        .map(|parent| parent.join(&link_dest).is_dir())
                        .unwrap_or(false);
                if points_at_dir {
                    std::os::windows::fs::symlink_dir(&link_dest, &target)?;
                } else {
                    std::os::windows::fs::symlink_file(&link_dest, &target)?;
                }
            }
        } else if ft.is_file() {
            if let Some(p) = target.parent() {
                std::fs::create_dir_all(p)?;
            }
            std::fs::copy(de.path(), &target)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = std::fs::symlink_metadata(de.path())?.permissions().mode();
                let mut perms = std::fs::metadata(&target)?.permissions();
                perms.set_mode(mode & 0o777);
                std::fs::set_permissions(&target, perms)?;
            }
        }
    }
    Ok(())
}

/// Installs, verifies (`ed25519-dalek` + parallel `rayon` `blake3`/`sha256`), composes, and
/// read-only seals a set of modular v2 `.tar.zst` runtime packs (`core`, `python-wheels`, `libreoffice`).
pub fn install_v2_pack_set(
    packs: &[(RuntimePackId, &Path)],
    opts: &RuntimeInstallOptions,
) -> Result<PreparedRuntime> {
    if packs.is_empty() {
        return Err(EnvError::Manifest(
            "install_v2_pack_set requires at least one pack".to_owned(),
        ));
    }
    let version_hint = opts
        .expected_version
        .as_deref()
        .unwrap_or("installing")
        .to_owned();

    with_runtime_bootstrap_lock_sync(
        &opts.homedir,
        &version_hint,
        DEFAULT_BOOTSTRAP_LOCK_TIMEOUT,
        opts.on_progress.as_ref(),
        || {
            if let Some(cb) = &opts.on_progress {
                cb(StartupProgressEvent::installing(&version_hint));
            }
            let rt_root = runtime_root_dir(&opts.homedir);
            std::fs::create_dir_all(&rt_root)?;
            let workspace_staging =
                rt_root.join(format!(".staging-v2-{}", Uuid::new_v4().simple()));
            let merged_dir = workspace_staging.join("merged");
            std::fs::create_dir_all(&merged_dir)?;

            let host_asset = resolve_host_asset()?;

            let res = (|| -> Result<PreparedRuntime> {
                let mut resolved_version: Option<String> = None;
                let mut components = BTreeMap::new();
                let mut provided_paths: HashMap<String, String> = HashMap::new();
                let mut trusted_symlinks: Vec<String> = Vec::new();
                let mut installed_pack_names: Vec<String> = Vec::new();

                for (expected_pack_id, archive_path) in packs {
                    let pack_extract_dir =
                        workspace_staging.join(format!("pack-{}", expected_pack_id.as_str()));
                    extract_v2_tar_zst_archive(archive_path, &pack_extract_dir)?;

                    let pack_json_raw = std::fs::read_to_string(pack_extract_dir.join("pack.json"))
                        .map_err(|e| {
                            EnvError::Manifest(format!(
                                "Missing pack.json in {}: {e}",
                                archive_path.display()
                            ))
                        })?;
                    let pack_manifest: RuntimePackManifest =
                        serde_json::from_str(&pack_json_raw)
                            .map_err(|e| EnvError::Manifest(format!("Invalid pack.json: {e}")))?;

                    if pack_manifest.schema_version != 2 {
                        return Err(EnvError::Manifest(format!(
                            "Unsupported pack.json schemaVersion {}",
                            pack_manifest.schema_version
                        )));
                    }
                    if pack_manifest.pack_id != *expected_pack_id {
                        return Err(EnvError::Manifest(format!(
                            "Pack id mismatch: expected {}, got {}",
                            expected_pack_id, pack_manifest.pack_id
                        )));
                    }
                    if !is_asset_compatible_with_host(
                        &pack_manifest.asset,
                        host_platform(),
                        host_arch(),
                        &[],
                    ) {
                        return Err(EnvError::Manifest(format!(
                            "Pack {} asset {} does not match host {host_asset}",
                            pack_manifest.pack_id, pack_manifest.asset
                        )));
                    }
                    if let Some(ver) = &resolved_version {
                        if ver != &pack_manifest.version {
                            return Err(EnvError::Manifest(format!(
                                "Mismatched pack versions inside v2 set: {ver} vs {}",
                                pack_manifest.version
                            )));
                        }
                    } else {
                        resolved_version = Some(pack_manifest.version.clone());
                    }
                    if let Some(exp_ver) = &opts.expected_version
                        && &pack_manifest.version != exp_ver
                    {
                        return Err(EnvError::Manifest(format!(
                            "Pack version {} does not match expected {exp_ver}",
                            pack_manifest.version
                        )));
                    }

                    let int_bytes = std::fs::read(pack_extract_dir.join("pack-integrity.json"))
                        .map_err(|e| {
                            EnvError::Integrity(format!(
                                "Missing pack-integrity.json in {}: {e}",
                                archive_path.display()
                            ))
                        })?;
                    let sig_raw =
                        std::fs::read_to_string(pack_extract_dir.join("pack-integrity.sig"))
                            .map_err(|e| {
                                EnvError::Signature(format!(
                                    "Missing pack-integrity.sig in {}: {e}",
                                    archive_path.display()
                                ))
                            })?;
                    let envelope: RuntimeSignatureEnvelope = serde_json::from_str(&sig_raw)
                        .map_err(|e| EnvError::Signature(format!("Invalid pack sig: {e}")))?;

                    verify_ed25519_envelope(&int_bytes, &envelope, &opts.trusted_keys)?;

                    let pack_int: RuntimeIntegrityManifest = serde_json::from_slice(&int_bytes)
                        .map_err(|e| {
                            EnvError::Integrity(format!("Invalid pack-integrity.json: {e}"))
                        })?;
                    if pack_int.schema_version != 2 {
                        return Err(EnvError::Integrity(format!(
                            "Unsupported pack-integrity.json schemaVersion {}",
                            pack_int.schema_version
                        )));
                    }
                    if pack_int.key_id != envelope.key_id {
                        return Err(EnvError::Signature(
                            "pack-integrity.json keyId does not match signature envelope keyId"
                                .to_owned(),
                        ));
                    }
                    if pack_int.pack_id != Some(*expected_pack_id) {
                        return Err(EnvError::Integrity(
                            "pack-integrity.json packId mismatch".to_owned(),
                        ));
                    }
                    if pack_int.runtime_version != pack_manifest.version
                        || pack_int.asset != pack_manifest.asset
                    {
                        return Err(EnvError::Integrity(
                            "pack-integrity.json version/asset does not match pack.json".to_owned(),
                        ));
                    }
                    // pack.json carries providedPaths and trustedSymlinks: it must be signed so
                    // `verify_integrity_tree_parallel` below rejects any tampering with it.
                    if !pack_int.files.iter().any(|f| f.path == "pack.json") {
                        return Err(EnvError::Integrity(
                            "pack-integrity.json does not sign pack.json".to_owned(),
                        ));
                    }

                    let mut excluded = HashSet::new();
                    excluded.insert("pack-integrity.json".to_owned());
                    excluded.insert("pack-integrity.sig".to_owned());
                    verify_integrity_tree_parallel(
                        &pack_extract_dir,
                        &pack_int.files,
                        &pack_manifest.trusted_symlinks,
                        &excluded,
                    )?;

                    // Merge verified payload into `merged_dir` and store signed pack metadata under `.packs/<id>/`.
                    let skip: HashSet<&str> =
                        ["pack.json", "pack-integrity.json", "pack-integrity.sig"]
                            .into_iter()
                            .collect();
                    copy_dir_tree_preserving_symlinks(&pack_extract_dir, &merged_dir, &skip)?;

                    let meta_dir = merged_dir.join(".packs").join(expected_pack_id.as_str());
                    std::fs::create_dir_all(&meta_dir)?;
                    std::fs::write(meta_dir.join("pack.json"), &pack_json_raw)?;
                    std::fs::write(meta_dir.join("pack-integrity.json"), &int_bytes)?;
                    std::fs::write(meta_dir.join("pack-integrity.sig"), &sig_raw)?;

                    components.extend(pack_manifest.components);
                    provided_paths.extend(pack_manifest.provided_paths);
                    for s in pack_manifest.trusted_symlinks {
                        if !trusted_symlinks.contains(&s) {
                            trusted_symlinks.push(s);
                        }
                    }
                    installed_pack_names.push(expected_pack_id.as_str().to_owned());
                }

                let version = resolved_version.expect("non-empty packs");
                let combined_manifest = RuntimeManifest {
                    schema_version: 2,
                    version: version.clone(),
                    platform: Some(host_platform().to_owned()),
                    arch: Some(host_arch().to_owned()),
                    asset: host_asset,
                    asset_file_name: None,
                    created_at: chrono::Utc::now().to_rfc3339(),
                    compatible_hosts: compatible_hosts_for_asset(&resolve_host_asset()?)
                        .iter()
                        .map(|s| (*s).to_owned())
                        .collect(),
                    source: None,
                    installed_packs: installed_pack_names,
                    components: RuntimeComponents::Map(components),
                    versions: None,
                    paths: RuntimeManifestPaths {
                        bin: provided_paths
                            .get("bin")
                            .cloned()
                            .unwrap_or_else(|| "dependencies/bin".to_owned()),
                        node: provided_paths
                            .get("node")
                            .cloned()
                            .unwrap_or_else(|| "dependencies/node/bin/node".to_owned()),
                        python: provided_paths
                            .get("python")
                            .cloned()
                            .unwrap_or_else(|| "dependencies/python/bin/python3".to_owned()),
                        git: provided_paths.get("git").cloned(),
                        node_modules: provided_paths
                            .get("nodeModules")
                            .cloned()
                            .unwrap_or_else(|| "node_modules".to_owned()),
                        node_resolver: provided_paths
                            .get("nodeResolver")
                            .cloned()
                            .unwrap_or_else(|| "cowork/node-resolver/register.mjs".to_owned()),
                        artifact_tool_package: provided_paths.get("artifactToolPackage").cloned(),
                        pnpm: provided_paths.get("pnpm").cloned(),
                        poppler_bin: provided_paths.get("popplerBin").cloned(),
                        pdftoppm: provided_paths.get("pdftoppm").cloned(),
                        pdfinfo: provided_paths.get("pdfinfo").cloned(),
                        heif_convert: provided_paths.get("heifConvert").cloned(),
                        jxr_dec_app: provided_paths.get("jxrDecApp").cloned(),
                        libreoffice: provided_paths
                            .get("libreOffice")
                            .or_else(|| provided_paths.get("libreoffice"))
                            .cloned(),
                        soffice: provided_paths.get("soffice").cloned(),
                        libreoffice_binary: provided_paths
                            .get("libreOfficeBinary")
                            .or_else(|| provided_paths.get("libreofficeBinary"))
                            .cloned(),
                        uv: provided_paths.get("uv").cloned(),
                        wheelhouse: provided_paths.get("wheelhouse").cloned(),
                    },
                    payload: None,
                    integrity: None,
                    python_packages: Vec::new(),
                    node_packages: Vec::new(),
                    system_tools: Vec::new(),
                    trusted_symlinks,
                };

                std::fs::write(
                    merged_dir.join("runtime.json"),
                    serde_json::to_vec_pretty(&combined_manifest).unwrap(),
                )?;

                // Verify the composed tree before it can replace anything (TS
                // `installRuntimeArchiveLocked` deep-verifies staging first): every pack can pass
                // its own integrity checks while the composition still lacks a required
                // entrypoint (e.g. a core-only set has no Python).
                verify_installed_runtime(&merged_dir, &opts.trusted_keys, true)?;
                promote_staged_runtime(&merged_dir, &version, opts)
            })();

            if workspace_staging.exists() {
                let _ = remove_sealed_tree(&workspace_staging);
            }
            res
        },
    )
}

/// Promote a verified ZIP or composed pack set while its bootstrap lock is held.
fn promote_staged_runtime(
    staged_dir: &Path,
    version: &str,
    opts: &RuntimeInstallOptions,
) -> Result<PreparedRuntime> {
    let rt_root = runtime_root_dir(&opts.homedir);
    let final_dir = rt_root.join(version);
    let finish = |runtime: PreparedRuntime| {
        let _ = prune_installed_runtimes_locked(&opts.homedir, opts.keep_versions);
        if let Some(cb) = &opts.on_progress {
            cb(StartupProgressEvent::ready(&runtime.version));
        }
        Ok(runtime)
    };
    let _ = std::fs::remove_file(crate::integrity::attestation_sidecar_path(staged_dir));

    let existing_dir = match std::fs::symlink_metadata(&final_dir) {
        Ok(meta) if meta.is_dir() => true,
        Ok(_) => {
            return Err(EnvError::Manifest(format!(
                "Expected runtime directory at {}",
                final_dir.display()
            )));
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => false,
        Err(err) => return Err(err.into()),
    };
    if existing_dir
        && !opts.force
        && let Ok(existing) = verify_installed_runtime(&final_dir, &opts.trusted_keys, false)
        && existing.version == version
    {
        write_current_pointer(&rt_root, &existing)?;
        return finish(existing);
    }
    let writer_lease = try_lock_unused_runtime(&final_dir)?.ok_or_else(|| {
        EnvError::Lock(format!(
            "Cannot overwrite active leased runtime {}",
            final_dir.display()
        ))
    })?;
    let backup = if existing_dir {
        let backup = rt_root.join(format!(".replaced-{version}-{}", Uuid::new_v4().simple()));
        set_dir_root_mode(&final_dir, 0o755);
        if let Err(err) = std::fs::rename(&final_dir, &backup) {
            set_dir_root_mode(&final_dir, 0o555);
            return Err(err.into());
        }
        Some(backup)
    } else {
        None
    };
    let promote = (|| {
        std::fs::rename(staged_dir, &final_dir)?;
        seal_tree_readonly(&final_dir)?;
        let verified = verify_installed_runtime(&final_dir, &opts.trusted_keys, true)?;
        // Signed bytes are not proof the entrypoints run (e.g. a release missing a shared
        // library): execute them before `current.json` names this tree or the backup is dropped.
        run_promotion_executable_probe(&opts.homedir, &verified)?;
        // A probe must not have mutated the sealed tree it exercised (TS `payloadAfterExecute`).
        let verified = verify_installed_runtime(&final_dir, &opts.trusted_keys, false)?;
        write_current_pointer(&rt_root, &verified)?;
        Ok(verified)
    })();
    match promote {
        Ok(verified) => {
            drop(writer_lease);
            if let Some(backup) = backup {
                let _ = remove_sealed_tree(&backup);
            }
            finish(verified)
        }
        Err(err) => {
            if !staged_dir.exists() {
                let _ = remove_sealed_tree(&final_dir);
            }
            if let Some(backup) = backup {
                std::fs::rename(&backup, &final_dir).map_err(|restore| {
                    EnvError::Manifest(format!(
                        "Runtime promotion failed ({err}); restoring {} from {} failed: {restore}",
                        final_dir.display(),
                        backup.display()
                    ))
                })?;
                set_dir_root_mode(&final_dir, 0o555);
            }
            Err(err)
        }
    }
}

/// Executable smoke check run against a freshly promoted runtime inside the rollback-protected
/// promotion step, before `current.json` names it (TS `verifyRuntime({ execute: true })`). An
/// error rolls the promotion back and keeps the previous installation current.
pub type RuntimeExecutableProbe = Arc<dyn Fn(&PreparedRuntime) -> Result<()> + Send + Sync>;

type ProbeOverrides = parking_lot::Mutex<HashMap<PathBuf, (u64, RuntimeExecutableProbe)>>;

fn executable_probe_overrides() -> &'static ProbeOverrides {
    static OVERRIDES: OnceLock<ProbeOverrides> = OnceLock::new();
    OVERRIDES.get_or_init(Default::default)
}

/// Keeps a [`override_runtime_executable_probe`] replacement active until dropped.
#[must_use = "the probe override ends when this guard is dropped"]
pub struct RuntimeExecutableProbeOverride {
    home: PathBuf,
    id: u64,
}

impl Drop for RuntimeExecutableProbeOverride {
    fn drop(&mut self) {
        let mut overrides = executable_probe_overrides().lock();
        if overrides
            .get(&self.home)
            .is_some_and(|(id, _)| *id == self.id)
        {
            overrides.remove(&self.home);
        }
    }
}

/// Replaces [`run_runtime_executable_checks`] for installs into `homedir` until the returned guard
/// is dropped. Scoped per home so parallel tests stay isolated; intended for fixtures whose
/// stand-in executables cannot run the real checks, or to inject a failing probe.
pub fn override_runtime_executable_probe(
    homedir: &Path,
    probe: RuntimeExecutableProbe,
) -> RuntimeExecutableProbeOverride {
    static NEXT_ID: AtomicU64 = AtomicU64::new(1);
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let home = canonicalize_sync(homedir);
    executable_probe_overrides()
        .lock()
        .insert(home.clone(), (id, probe));
    RuntimeExecutableProbeOverride { home, id }
}

/// [`override_runtime_executable_probe`] with a probe that accepts every runtime.
pub fn skip_runtime_executable_probe(homedir: &Path) -> RuntimeExecutableProbeOverride {
    override_runtime_executable_probe(homedir, Arc::new(|_| Ok(())))
}

fn run_promotion_executable_probe(homedir: &Path, runtime: &PreparedRuntime) -> Result<()> {
    let probe = executable_probe_overrides()
        .lock()
        .get(&canonicalize_sync(homedir))
        .map(|(_, probe)| probe.clone());
    match probe {
        Some(probe) => probe(runtime),
        None => run_runtime_executable_checks(runtime),
    }
}

/// TS `commandVersion` timeout.
const EXECUTABLE_CHECK_TIMEOUT: Duration = Duration::from_secs(120);
/// TS `verifySofficeConversion` timeout.
const SOFFICE_CONVERSION_CHECK_TIMEOUT: Duration = Duration::from_secs(180);
/// TS `execFileCompat` `maxBuffer`.
const MAX_PROBE_OUTPUT_BYTES: u64 = 4 * 1024 * 1024;
const PYTHON_LIBRARY_IMPORT_CHECK: &str =
    "import docx,lxml,PIL,pandas,numpy,pypdf,pdfplumber,reportlab,pdf2image; print('ok')";
const ARTIFACT_TOOL_IMPORT_PROBE: &str = "const m = await import('@oai/artifact-tool'); console.log(Object.keys(m).length > 0 ? 'ok' : 'empty');\n";
const SOFFICE_SMOKE_HTML: &str =
    "<!doctype html><title>Cowork Runtime</title><p>Managed headless LibreOffice smoke test.</p>\n";

struct ProbeScratchDir(PathBuf);

impl ProbeScratchDir {
    fn create() -> Result<Self> {
        let dir =
            std::env::temp_dir().join(format!("cowork-runtime-verify-{}", Uuid::new_v4().simple()));
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&dir).map_err(io_at(&dir))?;
        Ok(Self(dir))
    }
}

impl Drop for ProbeScratchDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn executable_check_failure(executable: &Path, args: &[&OsStr], detail: &str) -> EnvError {
    let argv = args
        .iter()
        .map(|a| a.to_string_lossy())
        .collect::<Vec<_>>()
        .join(" ");
    let mut detail = redact_secrets(detail.trim());
    if detail.len() > 2_000 {
        let mut cut = 2_000;
        while !detail.is_char_boundary(cut) {
            cut -= 1;
        }
        detail.truncate(cut);
    }
    EnvError::Integrity(format!(
        "Installed runtime failed executable verification: {} {argv} failed: {detail}",
        executable.display()
    ))
}

/// Drains a child pipe on its own thread (keeping at most `MAX_PROBE_OUTPUT_BYTES`) so a chatty
/// child never blocks on a full pipe.
fn capture_pipe<R: std::io::Read + Send + 'static>(
    pipe: Option<R>,
) -> std::sync::mpsc::Receiver<Vec<u8>> {
    let (tx, rx) = std::sync::mpsc::channel();
    if let Some(pipe) = pipe {
        std::thread::spawn(move || {
            use std::io::Read;
            let mut limited = pipe.take(MAX_PROBE_OUTPUT_BYTES);
            let mut buf = Vec::new();
            let _ = limited.read_to_end(&mut buf);
            let _ = std::io::copy(&mut limited.into_inner(), &mut std::io::sink());
            let _ = tx.send(buf);
        });
    }
    rx
}

fn kill_probe_tree(child: &mut std::process::Child) {
    #[cfg(unix)]
    if let Ok(pgid) = libc::pid_t::try_from(child.id()) {
        // SAFETY: the child leads its own process group (`process_group(0)`), so this signals
        // only it and its descendants.
        unsafe {
            libc::kill(-pgid, libc::SIGKILL);
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Runs one check (TS `runVerificationCommand`): non-zero exit, spawn failure, or timeout fails.
/// Returns the first line of output.
fn run_executable_check(
    executable: &Path,
    args: &[&OsStr],
    env: &HashMap<String, String>,
    cwd: &Path,
    timeout: Duration,
) -> Result<String> {
    let mut cmd = std::process::Command::new(executable);
    cmd.args(args)
        .env_clear()
        .envs(env)
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| executable_check_failure(executable, args, &format!("spawn error: {e}")))?;
    let stdout = capture_pipe(child.stdout.take());
    let stderr = capture_pipe(child.stderr.take());
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                kill_probe_tree(&mut child);
                return Err(executable_check_failure(
                    executable,
                    args,
                    &format!("timed out after {}ms", timeout.as_millis()),
                ));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(e) => {
                kill_probe_tree(&mut child);
                return Err(executable_check_failure(executable, args, &e.to_string()));
            }
        }
    };
    // A daemonized grandchild may keep a pipe open; never wait on it indefinitely.
    let collect = |rx: std::sync::mpsc::Receiver<Vec<u8>>| {
        String::from_utf8_lossy(&rx.recv_timeout(Duration::from_secs(5)).unwrap_or_default())
            .into_owned()
    };
    let (stdout, stderr) = (collect(stdout), collect(stderr));
    if !status.success() {
        let output = if stderr.trim().is_empty() {
            stdout.trim()
        } else {
            stderr.trim()
        };
        let code = status
            .code()
            .map_or_else(|| "signal".to_owned(), |c| format!("exit {c}"));
        return Err(executable_check_failure(
            executable,
            args,
            &format!("({code}) {output}"),
        ));
    }
    let output = if stdout.trim().is_empty() {
        stderr
    } else {
        stdout
    };
    Ok(output.trim().lines().next().unwrap_or("ok").to_owned())
}

/// The installer's default executable probe, matching TS `verifyRuntime({ execute: true })`
/// commands and timeouts: `node --version`, `python --version`, the Python document-library
/// imports, a Node `@oai/artifact-tool` import, `git --version` when bundled, and the managed
/// `soffice --version` plus a headless HTML -> PDF conversion when LibreOffice is bundled.
pub fn run_runtime_executable_checks(runtime: &PreparedRuntime) -> Result<()> {
    let base_env: HashMap<String, String> = std::env::vars_os()
        .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?)))
        .collect();
    // The tree is sealed; keep Python from even attempting `__pycache__` writes into it.
    let extra_env = HashMap::from([("PYTHONDONTWRITEBYTECODE".to_owned(), "1".to_owned())]);
    let env = build_canonical_shell_env(ShellEnvOptions {
        base_env: &base_env,
        runtime: Some(runtime),
        uv_env: None,
        extra_env: Some(&extra_env),
        platform: host_platform(),
        sandboxed: false,
        cowork_home: None,
    });
    let scratch = ProbeScratchDir::create()?;
    let cwd = scratch.0.as_path();
    let check = |exe: &Path, args: &[&OsStr], cwd: &Path, timeout: Duration| {
        run_executable_check(exe, args, &env, cwd, timeout)
    };
    let os = OsStr::new;

    let node = runtime.paths.node.as_path();
    let python = runtime.paths.python.as_path();
    check(node, &[os("--version")], cwd, EXECUTABLE_CHECK_TIMEOUT)?;
    check(python, &[os("--version")], cwd, EXECUTABLE_CHECK_TIMEOUT)?;
    check(
        python,
        &[os("-c"), os(PYTHON_LIBRARY_IMPORT_CHECK)],
        cwd,
        EXECUTABLE_CHECK_TIMEOUT,
    )?;
    let node_probe = cwd.join("probe.mjs");
    std::fs::write(&node_probe, ARTIFACT_TOOL_IMPORT_PROBE).map_err(io_at(&node_probe))?;
    check(
        node,
        &[node_probe.as_os_str()],
        cwd,
        EXECUTABLE_CHECK_TIMEOUT,
    )?;
    if let Some(git) = &runtime.paths.git {
        check(git, &[os("--version")], cwd, EXECUTABLE_CHECK_TIMEOUT)?;
    }
    if let Some(soffice) = &runtime.paths.soffice {
        check(soffice, &[os("--version")], cwd, EXECUTABLE_CHECK_TIMEOUT)?;
        let soffice_dir = cwd.join("soffice");
        std::fs::create_dir(&soffice_dir).map_err(io_at(&soffice_dir))?;
        let input = soffice_dir.join("cowork-soffice-smoke.html");
        std::fs::write(&input, SOFFICE_SMOKE_HTML).map_err(io_at(&input))?;
        check(
            soffice,
            &[
                os("--convert-to"),
                os("pdf"),
                os("--outdir"),
                soffice_dir.as_os_str(),
                input.as_os_str(),
            ],
            &soffice_dir,
            SOFFICE_CONVERSION_CHECK_TIMEOUT,
        )?;
        let output = soffice_dir.join("cowork-soffice-smoke.pdf");
        let produced = std::fs::symlink_metadata(&output)
            .is_ok_and(|m| m.file_type().is_file() && m.len() > 0);
        if !produced {
            return Err(EnvError::Integrity(
                "Installed runtime failed executable verification: managed headless soffice did not produce a non-empty PDF.".to_owned(),
            ));
        }
    }
    Ok(())
}

/// macOS (unlike Linux) refuses to rename a directory the caller cannot write, so a sealed
/// (`0555`) runtime root is opened for owner write around a move.
fn set_dir_root_mode(dir: &Path, mode: u32) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(mode));
    }
    #[cfg(not(unix))]
    {
        let _ = (dir, mode);
    }
}

/// Options for `ensure_cowork_runtime_ready`.
#[derive(Clone)]
pub struct EnsureRuntimeOptions {
    pub homedir: PathBuf,
    pub env: HashMap<String, String>,
    pub trusted_keys: TrustedKeyRing,
    pub on_progress: Option<RuntimeProgressCallback>,
}

fn env_truthy(env: &HashMap<String, String>, key: &str) -> bool {
    matches!(
        env.get(key)
            .map(|s| s.trim().to_ascii_lowercase())
            .as_deref(),
        Some("1" | "true" | "yes" | "on")
    )
}

fn env_explicitly_falsy(env: &HashMap<String, String>, key: &str) -> bool {
    matches!(
        env.get(key)
            .map(|s| s.trim().to_ascii_lowercase())
            .as_deref(),
        Some("0" | "false" | "no" | "off")
    )
}

fn validate_github_repository_slug(repo: &str) -> Result<String> {
    let trimmed = repo.trim();
    let Some((owner, name)) = trimmed.split_once('/') else {
        return Err(EnvError::Manifest(format!(
            "Invalid COWORK_RUNTIME_REPOSITORY {repo:?}; expected owner/repo"
        )));
    };
    let valid_part = |s: &str| {
        !s.is_empty()
            && !s.contains('/')
            && s != "."
            && s != ".."
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
    };
    if !valid_part(owner) || !valid_part(name) {
        return Err(EnvError::Manifest(format!(
            "Invalid COWORK_RUNTIME_REPOSITORY {repo:?}; expected owner/repo"
        )));
    }
    Ok(trimmed.to_owned())
}

fn validate_release_tag(tag: &str) -> Result<String> {
    let trimmed = tag.trim();
    if trimmed.is_empty()
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains("..")
        || trimmed.chars().any(char::is_whitespace)
    {
        return Err(EnvError::Manifest(format!(
            "Invalid COWORK_RUNTIME_RELEASE_TAG {tag:?}"
        )));
    }
    Ok(trimmed.to_owned())
}

fn read_pack_id_from_tar_zst(archive_path: &Path) -> Result<RuntimePackId> {
    let file = File::open(archive_path).map_err(|source| EnvError::IoPath {
        path: archive_path.to_path_buf(),
        source,
    })?;
    let decoder = zstd::stream::read::Decoder::new(file)
        .map_err(|e| EnvError::Archive(format!("zstd decode init failed: {e}")))?;
    let mut tar_archive = tar::Archive::new(decoder);
    let entries = tar_archive
        .entries()
        .map_err(|e| EnvError::Archive(format!("tar entries read failed: {e}")))?;
    let mut scanned_entries: usize = 0;
    let mut scanned_bytes: u64 = 0;
    for entry_res in entries {
        scanned_entries += 1;
        if scanned_entries > MAX_PACK_ID_SCAN_ENTRIES {
            return Err(EnvError::Archive(format!(
                "pack.json not found within the first {MAX_PACK_ID_SCAN_ENTRIES} entries of {}",
                archive_path.display()
            )));
        }
        let mut entry =
            entry_res.map_err(|e| EnvError::Archive(format!("tar entry read failed: {e}")))?;
        // Skipping an entry still decompresses its body, so bound the total bytes we walk
        // before the signed pack-set verification in `install_v2_pack_set` gets a chance to run.
        scanned_bytes = scanned_bytes.saturating_add(entry.size());
        if scanned_bytes > crate::archive::MAX_ARCHIVE_UNPACKED_BYTES {
            return Err(EnvError::Archive(format!(
                "Archive {} exceeded {} unpacked bytes before pack.json was found",
                archive_path.display(),
                crate::archive::MAX_ARCHIVE_UNPACKED_BYTES
            )));
        }
        let raw_path = entry
            .path()
            .map_err(|e| EnvError::Archive(format!("tar entry path failed: {e}")))?
            .to_string_lossy()
            .into_owned();
        let trimmed = raw_path.trim_start_matches("./");
        if trimmed == "pack.json" {
            if !entry.header().entry_type().is_file() {
                return Err(EnvError::Archive(
                    "pack.json inside runtime pack is not a regular file".to_owned(),
                ));
            }
            if entry.size() > MAX_PACK_JSON_BYTES {
                return Err(EnvError::Manifest(format!(
                    "pack.json exceeds {MAX_PACK_JSON_BYTES} byte limit"
                )));
            }
            let mut raw = String::new();
            std::io::Read::read_to_string(
                &mut std::io::Read::take(&mut entry, MAX_PACK_JSON_BYTES + 1),
                &mut raw,
            )?;
            if raw.len() as u64 > MAX_PACK_JSON_BYTES {
                return Err(EnvError::Manifest(format!(
                    "pack.json exceeds {MAX_PACK_JSON_BYTES} byte limit"
                )));
            }
            let manifest: RuntimePackManifest = serde_json::from_str(&raw)
                .map_err(|e| EnvError::Manifest(format!("Invalid pack.json: {e}")))?;
            return Ok(manifest.pack_id);
        }
    }
    Err(EnvError::Manifest(format!(
        "Missing pack.json inside {}",
        archive_path.display()
    )))
}

async fn download_runtime_release_streaming(
    base_url: &str,
    repository: &str,
    release_tag: &str,
    version: &str,
    asset_file_name: &str,
    download_dir: &Path,
    on_progress: Option<&RuntimeProgressCallback>,
) -> Result<(PathBuf, String)> {
    use sha2::{Digest as Sha2Digest, Sha256};

    let clean_base = base_url.trim().trim_end_matches('/');
    let checksum_url = format!(
        "{clean_base}/{repository}/releases/download/{release_tag}/{asset_file_name}.sha256"
    );
    let archive_url =
        format!("{clean_base}/{repository}/releases/download/{release_tag}/{asset_file_name}");

    if let Some(cb) = on_progress {
        cb(StartupProgressEvent::downloading(
            version,
            Some(0),
            None,
            None,
        ));
    }

    let client = reqwest::Client::builder()
        .connect_timeout(DOWNLOAD_CONNECT_TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| EnvError::Archive(format!("Failed building HTTP client: {e}")))?;

    let mut checksum_resp =
        tokio::time::timeout(DOWNLOAD_CONNECT_TIMEOUT, client.get(&checksum_url).send())
            .await
            .map_err(|_| {
                EnvError::Archive(format!(
                    "Timed out fetching runtime checksum {checksum_url}"
                ))
            })?
            .map_err(|e| EnvError::Archive(format!("Failed fetching {checksum_url}: {e}")))?;

    if !checksum_resp.status().is_success() {
        return Err(EnvError::Archive(format!(
            "Runtime checksum download failed for {checksum_url} with HTTP {}",
            checksum_resp.status().as_u16()
        )));
    }

    let mut checksum_bytes = Vec::new();
    while let Some(chunk) =
        tokio::time::timeout(DOWNLOAD_STREAM_IDLE_TIMEOUT, checksum_resp.chunk())
            .await
            .map_err(|_| EnvError::Archive(format!("Timed out reading {checksum_url}")))?
            .map_err(|e| EnvError::Archive(format!("Error reading {checksum_url}: {e}")))?
    {
        if checksum_bytes.len().saturating_add(chunk.len()) > MAX_CHECKSUM_BYTES {
            return Err(EnvError::Integrity(format!(
                "Checksum file {checksum_url} exceeded {MAX_CHECKSUM_BYTES} byte limit"
            )));
        }
        checksum_bytes.extend_from_slice(&chunk);
    }

    let checksum_text = String::from_utf8(checksum_bytes).map_err(|e| {
        EnvError::Integrity(format!(
            "Invalid UTF-8 in checksum file {checksum_url}: {e}"
        ))
    })?;
    let expected_sha256 = checksum_from_text(&checksum_text, asset_file_name)?;

    let mut archive_resp =
        tokio::time::timeout(DOWNLOAD_CONNECT_TIMEOUT, client.get(&archive_url).send())
            .await
            .map_err(|_| {
                EnvError::Archive(format!(
                    "Timed out connecting to runtime archive {archive_url}"
                ))
            })?
            .map_err(|e| EnvError::Archive(format!("Failed fetching {archive_url}: {e}")))?;

    if !archive_resp.status().is_success() {
        return Err(EnvError::Archive(format!(
            "Runtime archive download failed for {archive_url} with HTTP {}",
            archive_resp.status().as_u16()
        )));
    }

    let total_bytes = archive_resp.content_length().filter(|&n| n > 0);
    if let Some(cb) = on_progress {
        cb(StartupProgressEvent::downloading(
            version,
            Some(0),
            total_bytes,
            total_bytes.map(|_| 0),
        ));
    }

    std::fs::create_dir_all(download_dir)?;
    let partial_path = download_dir.join(format!("{asset_file_name}.partial"));
    let final_archive_path = download_dir.join(asset_file_name);

    let mut out_file = tokio::fs::File::create(&partial_path)
        .await
        .map_err(|source| EnvError::IoPath {
            path: partial_path.clone(),
            source,
        })?;
    let mut sha256_hasher = Sha256::new();
    let mut transferred: u64 = 0;
    let mut last_reported_bytes: u64 = 0;

    while let Some(chunk) = tokio::time::timeout(DOWNLOAD_STREAM_IDLE_TIMEOUT, archive_resp.chunk())
        .await
        .map_err(|_| {
            EnvError::Archive(format!(
                "Runtime archive stream stalled after {transferred} bytes from {archive_url}"
            ))
        })?
        .map_err(|e| EnvError::Archive(format!("Stream read error from {archive_url}: {e}")))?
    {
        let next_transferred = transferred.saturating_add(chunk.len() as u64);
        if next_transferred > crate::archive::MAX_ARCHIVE_UNPACKED_BYTES {
            return Err(EnvError::Archive(format!(
                "Downloaded archive exceeded safety limit of {} bytes",
                crate::archive::MAX_ARCHIVE_UNPACKED_BYTES
            )));
        }
        sha256_hasher.update(&chunk);
        tokio::io::AsyncWriteExt::write_all(&mut out_file, &chunk).await?;
        transferred = next_transferred;

        if transferred.saturating_sub(last_reported_bytes) >= DOWNLOAD_PROGRESS_STEP_BYTES {
            last_reported_bytes = transferred;
            if let Some(cb) = on_progress {
                let pct =
                    total_bytes.map(|tot| ((transferred.saturating_mul(100)) / tot).min(100) as u8);
                cb(StartupProgressEvent::downloading(
                    version,
                    Some(transferred),
                    total_bytes,
                    pct,
                ));
            }
        }
    }

    tokio::io::AsyncWriteExt::flush(&mut out_file).await?;
    drop(out_file);

    let actual_sha256 = hex::encode(sha256_hasher.finalize());
    if !actual_sha256.eq_ignore_ascii_case(&expected_sha256) {
        let _ = std::fs::remove_file(&partial_path);
        return Err(EnvError::Integrity(format!(
            "Downloaded runtime archive SHA-256 mismatch for {asset_file_name}: expected {expected_sha256}, got {actual_sha256}"
        )));
    }

    if let Some(cb) = on_progress {
        cb(StartupProgressEvent::downloading(
            version,
            Some(transferred),
            total_bytes.or(Some(transferred)),
            Some(100),
        ));
    }

    std::fs::rename(&partial_path, &final_archive_path)?;
    Ok((final_archive_path, expected_sha256))
}

/// Ensures the Cowork runtime is verified and ready without blocking Tokio async worker threads.
///
/// Honors `COWORK_DISABLE_RUNTIME`, `COWORK_RUNTIME_DIR`, `COWORK_RUNTIME_ARCHIVE_PATH`,
/// `COWORK_RUNTIME_ARCHIVE_SHA256`, `COWORK_RUNTIME_VERSION`, `COWORK_RUNTIME_REPOSITORY`,
/// `COWORK_RUNTIME_RELEASE_TAG`, `COWORK_RUNTIME_BASE_URL`, `COWORK_RUNTIME_FORCE`,
/// `COWORK_RUNTIME_FULL_VERIFY`, and fails closed offline unless `COWORK_RUNTIME_ALLOW_NETWORK=1`.
///
/// An installed runtime is reused only when it matches the target version (`COWORK_RUNTIME_VERSION`,
/// else [`DEFAULT_COWORK_RUNTIME_VERSION`]). Any other verified installed runtime is used only as a
/// recovery fallback when the target cannot be installed (network bootstrap disabled, or the
/// archive/download install failed), matching TS `resolveFallback`. That fallback is skipped when
/// `COWORK_RUNTIME_FORCE=1` or an explicit `COWORK_RUNTIME_VERSION` was requested.
pub async fn ensure_cowork_runtime_ready(opts: EnsureRuntimeOptions) -> Result<PreparedRuntime> {
    if env_truthy(&opts.env, "COWORK_DISABLE_RUNTIME") {
        return Err(EnvError::RuntimeDisabled);
    }

    let local_probe_opts = opts.clone();
    let local_outcome: Result<Option<PreparedRuntime>> = tokio::task::spawn_blocking(move || {
        let force_full = env_truthy(&local_probe_opts.env, "COWORK_RUNTIME_FULL_VERIFY");
        let force_reinstall = env_truthy(&local_probe_opts.env, "COWORK_RUNTIME_FORCE");
        let expected_version = local_probe_opts
            .env
            .get("COWORK_RUNTIME_VERSION")
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty());
        if let Some(ref ver) = expected_version {
            validate_runtime_version(ver)?;
        }
        // TS `ensureCoworkRuntimeReady`: the target is `COWORK_RUNTIME_VERSION`, else the bundled
        // default, so an upgraded app moves off an older cached runtime instead of reusing it.
        let target_version = expected_version
            .clone()
            .unwrap_or_else(|| DEFAULT_COWORK_RUNTIME_VERSION.to_owned());

        if let Some(dir_raw) = local_probe_opts
            .env
            .get("COWORK_RUNTIME_DIR")
            .map(String::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            let dir = PathBuf::from(dir_raw);
            let verified =
                verify_installed_runtime(&dir, &local_probe_opts.trusted_keys, force_full)?;
            if let Some(cb) = &local_probe_opts.on_progress {
                cb(StartupProgressEvent::ready(&verified.version));
            }
            return Ok(Some(verified));
        }

        if let Some(archive_raw) = local_probe_opts
            .env
            .get("COWORK_RUNTIME_ARCHIVE_PATH")
            .map(String::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            let archive_path = PathBuf::from(archive_raw);
            let explicit_sha256 = local_probe_opts
                .env
                .get("COWORK_RUNTIME_ARCHIVE_SHA256")
                .map(|s| s.trim().to_owned())
                .filter(|s| !s.is_empty());
            let resolved_sha256 = if let Some(hex_str) = explicit_sha256 {
                Some(hex_str)
            } else {
                let mut sidecar_os = archive_path.as_os_str().to_os_string();
                sidecar_os.push(".sha256");
                let sidecar_path = PathBuf::from(sidecar_os);
                if sidecar_path.is_file() {
                    let raw = std::fs::read_to_string(&sidecar_path)?;
                    let fname = archive_path
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_default();
                    Some(checksum_from_text(&raw, &fname)?)
                } else {
                    return Err(EnvError::Integrity(format!(
                        "COWORK_RUNTIME_ARCHIVE_PATH ({}) requires COWORK_RUNTIME_ARCHIVE_SHA256 or sibling .sha256 checksum file",
                        archive_path.display()
                    )));
                }
            };

            let install_opts = RuntimeInstallOptions {
                homedir: local_probe_opts.homedir.clone(),
                trusted_keys: local_probe_opts.trusted_keys.clone(),
                expected_version,
                expected_archive_sha256: resolved_sha256,
                force: force_reinstall,
                keep_versions: 2,
                on_progress: local_probe_opts.on_progress.clone(),
            };
            let installed = (|| match detect_archive_format(&archive_path)? {
                ArchiveFormat::V1Zip => install_v1_zip_runtime(&archive_path, &install_opts),
                ArchiveFormat::V2TarZst => {
                    verify_optional_archive_sha256(
                        &archive_path,
                        install_opts.expected_archive_sha256.as_deref(),
                    )?;
                    let pack_id = read_pack_id_from_tar_zst(&archive_path)?;
                    install_v2_pack_set(&[(pack_id, &archive_path)], &install_opts)
                }
            })();
            return match installed {
                Ok(installed) => Ok(Some(installed)),
                Err(err) => recover_with_fallback_runtime(&local_probe_opts, err).map(Some),
            };
        }

        if !force_reinstall
            && let Some(verified) = resolve_target_installed_runtime(
                &local_probe_opts.homedir,
                &target_version,
                &local_probe_opts.trusted_keys,
                force_full,
            )
        {
            if let Some(cb) = &local_probe_opts.on_progress {
                cb(StartupProgressEvent::ready(&verified.version));
            }
            return Ok(Some(verified));
        }

        Ok(None)
    })
    .await
    .map_err(|e| EnvError::Lock(format!("Runtime bootstrap join failure: {e}")))?;

    if let Some(ready) = local_outcome? {
        return Ok(ready);
    }

    let allow_network = env_truthy(&opts.env, "COWORK_RUNTIME_ALLOW_NETWORK")
        || (!env_explicitly_falsy(&opts.env, "COWORK_RUNTIME_ALLOW_NETWORK")
            && opts.env.get("COWORK_DESKTOP_BUNDLE").map(String::as_str) == Some("1"));

    if !allow_network {
        let err = EnvError::NetworkDisabled(format!(
            "No verified runtime found under {}",
            runtime_root_dir(&opts.homedir).display()
        ));
        return recover_with_fallback_runtime_async(&opts, err).await;
    }

    let desired_version = opts
        .env
        .get("COWORK_RUNTIME_VERSION")
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_COWORK_RUNTIME_VERSION.to_owned());
    validate_runtime_version(&desired_version)?;

    let repository = match opts
        .env
        .get("COWORK_RUNTIME_REPOSITORY")
        .map(String::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(raw_repo) => validate_github_repository_slug(raw_repo)?,
        None => DEFAULT_COWORK_RUNTIME_REPOSITORY.to_owned(),
    };

    let release_tag = match opts
        .env
        .get("COWORK_RUNTIME_RELEASE_TAG")
        .map(String::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(raw_tag) => validate_release_tag(raw_tag)?,
        None => runtime_release_tag(&desired_version)?,
    };

    let base_url = opts
        .env
        .get("COWORK_RUNTIME_BASE_URL")
        .or_else(|| opts.env.get("COWORK_RUNTIME_RELEASE_BASE_URL"))
        .map(String::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_COWORK_RUNTIME_BASE_URL)
        .to_owned();

    let host_asset = resolve_host_asset()?;
    let asset_file_name = runtime_asset_file_name(&host_asset);
    let download_dir =
        runtime_root_dir(&opts.homedir).join(format!(".download-{}", Uuid::new_v4().simple()));

    let download_res = download_runtime_release_streaming(
        &base_url,
        &repository,
        &release_tag,
        &desired_version,
        &asset_file_name,
        &download_dir,
        opts.on_progress.as_ref(),
    )
    .await;

    let (downloaded_archive, expected_sha256) = match download_res {
        Ok(pair) => pair,
        Err(err) => {
            let _ = std::fs::remove_dir_all(&download_dir);
            return recover_with_fallback_runtime_async(&opts, err).await;
        }
    };

    let force_reinstall = env_truthy(&opts.env, "COWORK_RUNTIME_FORCE");
    let install_opts = RuntimeInstallOptions {
        homedir: opts.homedir.clone(),
        trusted_keys: opts.trusted_keys.clone(),
        expected_version: Some(desired_version),
        expected_archive_sha256: Some(expected_sha256),
        force: force_reinstall,
        keep_versions: 2,
        on_progress: opts.on_progress.clone(),
    };

    let install_res = tokio::task::spawn_blocking(move || {
        install_v1_zip_runtime(&downloaded_archive, &install_opts)
    })
    .await
    .map_err(|e| EnvError::Lock(format!("Runtime install join failure: {e}")))?;

    let _ = std::fs::remove_dir_all(&download_dir);
    match install_res {
        Ok(installed) => Ok(installed),
        Err(err) => recover_with_fallback_runtime_async(&opts, err).await,
    }
}

/// Keep a managed runtime stable for the lifetime of a server. Explicit external runtimes
/// are outside installer retention and need no writable lease file.
pub async fn ensure_leased_cowork_runtime_ready(
    mut opts: EnsureRuntimeOptions,
) -> Result<(PreparedRuntime, Option<RuntimeConsumerLease>)> {
    let homedir = opts.homedir.clone();
    let explicit_dir = opts
        .env
        .get("COWORK_RUNTIME_DIR")
        .map(|s| PathBuf::from(s.trim()));
    let trusted_keys = opts.trusted_keys.clone();
    let on_progress = opts.on_progress.take();
    if let Some(report) = on_progress.clone() {
        opts.on_progress = Some(std::sync::Arc::new(move |evt| {
            if evt.progress.phase != crate::manifest::RuntimeBootstrapPhase::Ready {
                report(evt);
            }
        }));
    }
    let prepared = ensure_cowork_runtime_ready(opts).await?;
    let (runtime, lease) = tokio::task::spawn_blocking(move || -> Result<_> {
        let home_runtime_root = canonicalize_sync(&runtime_root_dir(&homedir));
        // A second home may open this version by its physical path outside either home's
        // .cowork/runtime spelling. First installation creates this permanent lock file.
        let has_installer_lease_file =
            std::fs::symlink_metadata(consumer_lease_lock_path(&prepared.root_dir))
                .is_ok_and(|meta| meta.is_file());
        let managed = [Some(prepared.root_dir.as_path()), explicit_dir.as_deref()]
            .into_iter()
            .flatten()
            .any(|path| {
                path.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| validate_runtime_version(n).is_ok())
                    && path.parent().is_some_and(|root| {
                        has_installer_lease_file
                            || root == home_runtime_root
                            || root.ends_with(".cowork/runtime")
                    })
            });
        if !managed {
            return Ok((prepared, None));
        }
        let lease = RuntimeConsumerLease::acquire(&prepared.root_dir)?;
        // Another installer may have replaced this version between bootstrap and lease
        // acquisition. Use the entrypoints from the tree actually protected by our lease.
        let runtime = verify_installed_runtime(lease.runtime_dir(), &trusted_keys, false)?;
        Ok((runtime, Some(lease)))
    })
    .await
    .map_err(|e| EnvError::Lock(format!("Runtime lease task failed: {e}")))??;
    if let Some(report) = on_progress {
        report(StartupProgressEvent::ready(&runtime.version));
    }
    Ok((runtime, lease))
}

/// Points `current.json` at an installed, verified runtime (TS `activateInstalledRuntime`),
/// taking the bootstrap lock only when the pointer actually changes.
fn activate_verified_runtime(homedir: &Path, runtime: &PreparedRuntime) -> Result<()> {
    let already_current = read_current_pointer(homedir)
        .and_then(|pointer| pointer.resolve_runtime_dir(homedir).ok())
        .is_some_and(|dir| canonicalize_sync(&dir) == canonicalize_sync(&runtime.root_dir));
    if already_current {
        return Ok(());
    }
    with_runtime_bootstrap_lock_sync(
        homedir,
        &runtime.version,
        DEFAULT_BOOTSTRAP_LOCK_TIMEOUT,
        None,
        || write_current_pointer(&runtime_root_dir(homedir), runtime),
    )
}

/// Verifies `dir` and activates it, optionally requiring a specific runtime version.
fn confirm_and_activate_runtime(
    homedir: &Path,
    dir: &Path,
    required_version: Option<&str>,
    trusted_keys: &TrustedKeyRing,
    force_full: bool,
) -> Option<PreparedRuntime> {
    if !dir.is_dir() {
        return None;
    }
    let verified = verify_installed_runtime(dir, trusted_keys, force_full).ok()?;
    if required_version.is_some_and(|v| v != verified.version) {
        return None;
    }
    activate_verified_runtime(homedir, &verified).ok()?;
    Some(verified)
}

/// TS `resolveDesiredRuntime`: reuse an installed runtime only when it is the target version, so
/// a `current.json` left pointing at an older runtime by a previous app release is not reused.
fn resolve_target_installed_runtime(
    homedir: &Path,
    target_version: &str,
    trusted_keys: &TrustedKeyRing,
    force_full: bool,
) -> Option<PreparedRuntime> {
    let mut candidates = Vec::new();
    if let Some(pointer) = read_current_pointer(homedir)
        && pointer.version == target_version
        && let Ok(dir) = pointer.resolve_runtime_dir(homedir)
    {
        candidates.push(dir);
    }
    let canonical = runtime_root_dir(homedir).join(target_version);
    if !candidates.contains(&canonical) {
        candidates.push(canonical);
    }
    candidates.iter().find_map(|dir| {
        confirm_and_activate_runtime(homedir, dir, Some(target_version), trusted_keys, force_full)
    })
}

/// TS `resolveFallback`: recovery-only reuse of any verified installed runtime (the current
/// pointer first, then installed versions newest first) when the target runtime cannot be
/// installed because network bootstrap is disabled or installation failed.
fn resolve_fallback_runtime(
    homedir: &Path,
    trusted_keys: &TrustedKeyRing,
    force_full: bool,
) -> Option<PreparedRuntime> {
    let mut candidates = Vec::new();
    if let Some(pointer) = read_current_pointer(homedir)
        && let Ok(dir) = pointer.resolve_runtime_dir(homedir)
    {
        candidates.push(dir);
    }
    let mut installed: Vec<(String, PathBuf)> = std::fs::read_dir(runtime_root_dir(homedir))
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let name = entry.file_name().to_string_lossy().into_owned();
            (validate_runtime_version(&name).is_ok() && entry.path().is_dir())
                .then(|| (name, entry.path()))
        })
        .collect();
    installed.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, dir) in installed {
        if !candidates.contains(&dir) {
            candidates.push(dir);
        }
    }
    candidates
        .iter()
        .find_map(|dir| confirm_and_activate_runtime(homedir, dir, None, trusted_keys, force_full))
}

/// Falls back to a previously installed runtime after `err`, or returns `err` if none verifies.
///
/// No fallback is attempted when the caller demanded a specific outcome: `COWORK_RUNTIME_FORCE=1`
/// (a forced reinstall must not silently keep the old runtime) or an explicit
/// `COWORK_RUNTIME_VERSION` (an older cached runtime is not the version that was asked for).
fn recover_with_fallback_runtime(
    opts: &EnsureRuntimeOptions,
    err: EnvError,
) -> Result<PreparedRuntime> {
    if fallback_recovery_disallowed(opts) {
        return Err(err);
    }
    let force_full = env_truthy(&opts.env, "COWORK_RUNTIME_FULL_VERIFY");
    let Some(fallback) = resolve_fallback_runtime(&opts.homedir, &opts.trusted_keys, force_full)
    else {
        return Err(err);
    };
    tracing::warn!(
        runtime_dir = %fallback.root_dir.display(),
        version = %fallback.version,
        error = %err,
        "using fallback Cowork runtime"
    );
    if let Some(cb) = &opts.on_progress {
        cb(StartupProgressEvent::ready(&fallback.version));
    }
    Ok(fallback)
}

fn fallback_recovery_disallowed(opts: &EnsureRuntimeOptions) -> bool {
    env_truthy(&opts.env, "COWORK_RUNTIME_FORCE")
        || opts
            .env
            .get("COWORK_RUNTIME_VERSION")
            .is_some_and(|v| !v.trim().is_empty())
}

async fn recover_with_fallback_runtime_async(
    opts: &EnsureRuntimeOptions,
    err: EnvError,
) -> Result<PreparedRuntime> {
    let opts = opts.clone();
    tokio::task::spawn_blocking(move || recover_with_fallback_runtime(&opts, err))
        .await
        .map_err(|e| EnvError::Lock(format!("Runtime fallback join failure: {e}")))?
}

fn collect_integrity_entries_parallel(
    root: &Path,
    excluded: &HashSet<&str>,
) -> Result<(Vec<IntegrityFileEntry>, Vec<String>)> {
    let mut disk_entries: Vec<(String, PathBuf, bool)> = Vec::new();
    let mut trusted_symlinks: Vec<String> = Vec::new();

    for item in WalkDir::new(root).follow_links(false) {
        let de = item.map_err(|e| EnvError::Archive(format!("Fixture walk failed: {e}")))?;
        if de.path() == root {
            continue;
        }
        let rel = de
            .path()
            .strip_prefix(root)
            .unwrap()
            .components()
            .map(|c| c.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        let clean = assert_safe_relative_runtime_path(&rel, "fixture entry")?;
        if excluded.contains(clean.as_str()) {
            continue;
        }
        let ft = de.file_type();
        if ft.is_dir() {
            continue;
        }
        if ft.is_symlink() {
            trusted_symlinks.push(clean.clone());
            disk_entries.push((clean, de.path().to_path_buf(), true));
        } else if ft.is_file() {
            disk_entries.push((clean, de.path().to_path_buf(), false));
        }
    }

    disk_entries.sort_by(|a, b| a.0.cmp(&b.0));
    trusted_symlinks.sort();

    let files = disk_entries
        .par_iter()
        .map(|(rel, full, is_link)| -> Result<IntegrityFileEntry> {
            if *is_link {
                let target = std::fs::read_link(full)?
                    .to_string_lossy()
                    .replace('\\', "/");
                let (sha256, blake3, size) = hash_bytes_dual(target.as_bytes());
                Ok(IntegrityFileEntry {
                    path: rel.clone(),
                    kind: IntegrityEntryKind::Symlink,
                    size,
                    sha256: Some(sha256),
                    blake3: Some(blake3),
                })
            } else {
                let (sha256, blake3, size) = hash_regular_file(full)?;
                Ok(IntegrityFileEntry {
                    path: rel.clone(),
                    kind: IntegrityEntryKind::File,
                    size,
                    sha256: Some(sha256),
                    blake3: Some(blake3),
                })
            }
        })
        .collect::<Result<Vec<_>>>()?;

    Ok((files, trusted_symlinks))
}

fn sign_bytes_envelope(
    bytes: &[u8],
    key_id: &str,
    signing_key: &SigningKey,
) -> RuntimeSignatureEnvelope {
    let sig = signing_key.sign(bytes);
    RuntimeSignatureEnvelope {
        schema_version: 1,
        algorithm: "Ed25519".to_owned(),
        key_id: key_id.to_owned(),
        signature: BASE64.encode(&sig.to_bytes()),
    }
}

fn detect_staging_manifest_paths(staging: &Path) -> RuntimeManifestPaths {
    let pick = |rel: &str| staging.join(rel).exists().then(|| rel.to_owned());
    let poppler_bin = staging
        .join("dependencies/poppler/bin")
        .is_dir()
        .then(|| "dependencies/poppler/bin".to_owned());
    let libreoffice = staging
        .join("dependencies/libreoffice")
        .is_dir()
        .then(|| "dependencies/libreoffice".to_owned());
    let wheelhouse = staging.join("wheels").is_dir().then(|| "wheels".to_owned());

    RuntimeManifestPaths {
        bin: "dependencies/bin".to_owned(),
        node: "dependencies/node/bin/node".to_owned(),
        python: "dependencies/python/bin/python3".to_owned(),
        git: pick("dependencies/git/bin/git"),
        node_modules: "node_modules".to_owned(),
        node_resolver: "cowork/node-resolver/register.mjs".to_owned(),
        artifact_tool_package: pick("node_modules/@oai/artifact-tool"),
        pnpm: pick("dependencies/bin/pnpm"),
        poppler_bin,
        pdftoppm: pick("dependencies/poppler/bin/pdftoppm"),
        pdfinfo: pick("dependencies/poppler/bin/pdfinfo"),
        heif_convert: pick("dependencies/bin/heif-convert"),
        jxr_dec_app: pick("dependencies/bin/JxrDecApp"),
        libreoffice,
        soffice: pick("dependencies/bin/soffice"),
        libreoffice_binary: pick("dependencies/libreoffice/program/soffice"),
        uv: pick("dependencies/bin/uv"),
        wheelhouse,
    }
}

/// Builds a signed v1 `.zip` Cowork runtime archive from `staging_dir` for packaging or deterministic offline tests.
pub fn build_signed_v1_zip_fixture(
    staging_dir: &Path,
    version: &str,
    asset: &str,
    key_id: &str,
    signing_key: &SigningKey,
    output_zip_path: &Path,
) -> Result<()> {
    let tmp_build = staging_dir
        .parent()
        .unwrap_or(staging_dir)
        .join(format!(".v1-zip-build-{}", Uuid::new_v4().simple()));
    copy_dir_tree_preserving_symlinks(staging_dir, &tmp_build, &HashSet::new())?;

    let (pre_files, symlinks_pre) =
        collect_integrity_entries_parallel(&tmp_build, &HashSet::new())?;
    let pre_bytes: u64 = pre_files.iter().map(|f| f.size).sum();
    let compat_hosts: Vec<String> = compatible_hosts_for_asset(asset)
        .iter()
        .map(|s| (*s).to_owned())
        .collect();
    let detected_paths = detect_staging_manifest_paths(&tmp_build);

    let manifest = RuntimeManifest {
        schema_version: 2,
        version: version.to_owned(),
        platform: None,
        arch: None,
        asset: asset.to_owned(),
        asset_file_name: Some(runtime_asset_file_name(asset)),
        created_at: "2026-06-22T00:00:00Z".to_owned(),
        compatible_hosts: compat_hosts,
        source: Some(RuntimeManifestSource {
            kind: "local-dir".to_owned(),
            bundle_version: "1.0.0".to_owned(),
            target_platform: host_platform().to_owned(),
            target_arch: host_arch().to_owned(),
        }),
        installed_packs: Vec::new(),
        components: RuntimeComponents::List(vec![
            RuntimeManifestComponent {
                id: "node".to_owned(),
                strategy: "bundle-or-build".to_owned(),
                path: detected_paths.node.clone(),
                source: Some("fixture".to_owned()),
                note: None,
            },
            RuntimeManifestComponent {
                id: "python".to_owned(),
                strategy: "bundle-or-build".to_owned(),
                path: detected_paths.python.clone(),
                source: Some("fixture".to_owned()),
                note: None,
            },
        ]),
        versions: None,
        paths: detected_paths.clone(),
        payload: Some(RuntimeManifestPayload {
            file_count: pre_files.len() as u64,
            unpacked_bytes: pre_bytes,
        }),
        integrity: Some(RuntimeManifestIntegrityRef {
            algorithm: "Ed25519".to_owned(),
            key_id: key_id.to_owned(),
            manifest: "runtime-integrity.json".to_owned(),
            signature: "runtime-integrity.sig".to_owned(),
        }),
        python_packages: Vec::new(),
        node_packages: Vec::new(),
        system_tools: Vec::new(),
        trusted_symlinks: symlinks_pre,
    };
    std::fs::write(
        tmp_build.join("runtime.json"),
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )?;

    let excluded: HashSet<&str> = ["runtime-integrity.json", "runtime-integrity.sig"]
        .into_iter()
        .collect();
    let (files, _) = collect_integrity_entries_parallel(&tmp_build, &excluded)?;

    let mut entrypoints = BTreeMap::new();
    entrypoints.insert("node".to_owned(), vec![detected_paths.node.clone()]);
    entrypoints.insert("python".to_owned(), vec![detected_paths.python.clone()]);
    entrypoints.insert(
        "nodeResolver".to_owned(),
        vec![detected_paths.node_resolver.clone()],
    );
    let mut components = BTreeMap::new();
    components.insert("node".to_owned(), vec![detected_paths.node]);
    components.insert("python".to_owned(), vec![detected_paths.python]);

    let integrity = RuntimeIntegrityManifest {
        schema_version: 2,
        algorithm: "Ed25519".to_owned(),
        key_id: key_id.to_owned(),
        runtime_version: version.to_owned(),
        asset: asset.to_owned(),
        pack_id: None,
        files,
        components,
        entrypoints,
    };
    let int_bytes = serde_json::to_vec_pretty(&integrity).unwrap();
    let sig_env = sign_bytes_envelope(&int_bytes, key_id, signing_key);

    std::fs::write(tmp_build.join("runtime-integrity.json"), &int_bytes)?;
    std::fs::write(
        tmp_build.join("runtime-integrity.sig"),
        serde_json::to_vec_pretty(&sig_env).unwrap(),
    )?;

    let out_file = File::create(output_zip_path)?;
    let mut zw = zip::ZipWriter::new(out_file);

    for item in WalkDir::new(&tmp_build)
        .follow_links(false)
        .sort_by_file_name()
    {
        let de = item.unwrap();
        if de.path() == tmp_build {
            continue;
        }
        let rel = de
            .path()
            .strip_prefix(&tmp_build)
            .unwrap()
            .components()
            .map(|c| c.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        let ft = de.file_type();
        if ft.is_dir() {
            let opts = zip::write::SimpleFileOptions::default().unix_permissions(0o755);
            zw.add_directory(format!("{rel}/"), opts)
                .map_err(|e| EnvError::Archive(format!("Zip dir write failed: {e}")))?;
        } else if ft.is_symlink() {
            let target = std::fs::read_link(de.path())?
                .to_string_lossy()
                .replace('\\', "/");
            let opts = zip::write::SimpleFileOptions::default().unix_permissions(0o120777);
            zw.start_file(&rel, opts)
                .map_err(|e| EnvError::Archive(format!("Zip symlink write failed: {e}")))?;
            zw.write_all(target.as_bytes())?;
        } else if ft.is_file() {
            #[cfg(unix)]
            let mode = {
                use std::os::unix::fs::PermissionsExt;
                std::fs::symlink_metadata(de.path())?.permissions().mode() & 0o777
            };
            #[cfg(not(unix))]
            let mode = 0o755_u32;
            let opts = zip::write::SimpleFileOptions::default().unix_permissions(mode);
            zw.start_file(&rel, opts)
                .map_err(|e| EnvError::Archive(format!("Zip file write failed: {e}")))?;
            let bytes = std::fs::read(de.path())?;
            zw.write_all(&bytes)?;
        }
    }
    zw.finish()
        .map_err(|e| EnvError::Archive(format!("Zip finalize failed: {e}")))?;
    let _ = std::fs::remove_dir_all(&tmp_build);
    Ok(())
}

fn belongs_to_pack(rel_path: &str, pack_id: RuntimePackId) -> bool {
    match pack_id {
        RuntimePackId::Core => {
            rel_path.starts_with("dependencies/node/")
                || rel_path.starts_with("node_modules/")
                || rel_path.starts_with("cowork/")
                || rel_path.starts_with("dependencies/git/")
                || rel_path == "dependencies/bin/uv"
        }
        RuntimePackId::PythonWheels => {
            rel_path.starts_with("dependencies/python/") || rel_path.starts_with("wheels/")
        }
        RuntimePackId::LibreOffice => {
            rel_path.starts_with("dependencies/libreoffice/")
                || rel_path.starts_with("dependencies/poppler/")
                || rel_path == "dependencies/bin/soffice"
        }
    }
}

/// Builds a signed modular v2 `.tar.zst` runtime pack (`core`, `python-wheels`, or `libreoffice`).
pub fn build_signed_v2_pack_tar_zst_fixture(
    staging_dir: &Path,
    pack_id: RuntimePackId,
    version: &str,
    asset: &str,
    key_id: &str,
    signing_key: &SigningKey,
    output_tar_zst_path: &Path,
) -> Result<()> {
    let tmp_pack = staging_dir.parent().unwrap_or(staging_dir).join(format!(
        ".v2-pack-build-{}-{}",
        pack_id.as_str(),
        Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&tmp_pack)?;

    for item in WalkDir::new(staging_dir).follow_links(false) {
        let de = item.unwrap();
        if de.path() == staging_dir || de.file_type().is_dir() {
            continue;
        }
        let rel = de
            .path()
            .strip_prefix(staging_dir)
            .unwrap()
            .components()
            .map(|c| c.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        if !belongs_to_pack(&rel, pack_id) {
            continue;
        }
        let dst = tmp_pack.join(&rel);
        if let Some(p) = dst.parent() {
            std::fs::create_dir_all(p)?;
        }
        if de.file_type().is_symlink() {
            let link_dest = std::fs::read_link(de.path())?;
            #[cfg(unix)]
            {
                std::os::unix::fs::symlink(link_dest, &dst)?;
            }
        } else {
            std::fs::copy(de.path(), &dst)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = std::fs::symlink_metadata(de.path())?.permissions().mode();
                let mut perms = std::fs::metadata(&dst)?.permissions();
                perms.set_mode(mode & 0o777);
                std::fs::set_permissions(&dst, perms)?;
            }
        }
    }

    let (_, trusted_symlinks) = collect_integrity_entries_parallel(&tmp_pack, &HashSet::new())?;

    let mut provided_paths = BTreeMap::new();
    match pack_id {
        RuntimePackId::Core => {
            provided_paths.insert("bin".to_owned(), "dependencies/bin".to_owned());
            provided_paths.insert("node".to_owned(), "dependencies/node/bin/node".to_owned());
            provided_paths.insert("nodeModules".to_owned(), "node_modules".to_owned());
            provided_paths.insert(
                "nodeResolver".to_owned(),
                "cowork/node-resolver/register.mjs".to_owned(),
            );
            if tmp_pack.join("dependencies/bin/uv").is_file() {
                provided_paths.insert("uv".to_owned(), "dependencies/bin/uv".to_owned());
            }
        }
        RuntimePackId::PythonWheels => {
            provided_paths.insert(
                "python".to_owned(),
                "dependencies/python/bin/python3".to_owned(),
            );
            if tmp_pack.join("wheels").is_dir() {
                provided_paths.insert("wheelhouse".to_owned(), "wheels".to_owned());
            }
        }
        RuntimePackId::LibreOffice => {
            if tmp_pack.join("dependencies/libreoffice").is_dir() {
                provided_paths.insert(
                    "libreOffice".to_owned(),
                    "dependencies/libreoffice".to_owned(),
                );
            }
            if tmp_pack.join("dependencies/bin/soffice").is_file() {
                provided_paths.insert("soffice".to_owned(), "dependencies/bin/soffice".to_owned());
            }
            if tmp_pack
                .join("dependencies/libreoffice/program/soffice")
                .is_file()
            {
                provided_paths.insert(
                    "libreOfficeBinary".to_owned(),
                    "dependencies/libreoffice/program/soffice".to_owned(),
                );
            }
            if tmp_pack.join("dependencies/poppler/bin").is_dir() {
                provided_paths.insert(
                    "popplerBin".to_owned(),
                    "dependencies/poppler/bin".to_owned(),
                );
            }
            if tmp_pack.join("dependencies/poppler/bin/pdftoppm").is_file() {
                provided_paths.insert(
                    "pdftoppm".to_owned(),
                    "dependencies/poppler/bin/pdftoppm".to_owned(),
                );
            }
        }
    }

    let pack_manifest = RuntimePackManifest {
        schema_version: 2,
        pack_id,
        version: version.to_owned(),
        platform: host_platform().to_owned(),
        arch: host_arch().to_owned(),
        asset: asset.to_owned(),
        created_at: "2026-07-01T00:00:00Z".to_owned(),
        components: BTreeMap::new(),
        provided_paths,
        trusted_symlinks,
    };
    std::fs::write(
        tmp_pack.join("pack.json"),
        serde_json::to_vec_pretty(&pack_manifest).unwrap(),
    )?;

    let excluded: HashSet<&str> = ["pack-integrity.json", "pack-integrity.sig"]
        .into_iter()
        .collect();
    let (files, _) = collect_integrity_entries_parallel(&tmp_pack, &excluded)?;

    let integrity = RuntimeIntegrityManifest {
        schema_version: 2,
        algorithm: "Ed25519".to_owned(),
        key_id: key_id.to_owned(),
        runtime_version: version.to_owned(),
        asset: asset.to_owned(),
        pack_id: Some(pack_id),
        files,
        components: BTreeMap::new(),
        entrypoints: BTreeMap::new(),
    };
    let int_bytes = serde_json::to_vec_pretty(&integrity).unwrap();
    let sig_env = sign_bytes_envelope(&int_bytes, key_id, signing_key);

    std::fs::write(tmp_pack.join("pack-integrity.json"), &int_bytes)?;
    std::fs::write(
        tmp_pack.join("pack-integrity.sig"),
        serde_json::to_vec_pretty(&sig_env).unwrap(),
    )?;

    let out_file = File::create(output_tar_zst_path)?;
    let encoder = zstd::stream::write::Encoder::new(out_file, 3)
        .map_err(|e| EnvError::Archive(format!("zstd encoder init failed: {e}")))?;
    let mut tar_builder = tar::Builder::new(encoder);
    tar_builder.follow_symlinks(false);
    tar_builder
        .append_dir_all(".", &tmp_pack)
        .map_err(|e| EnvError::Archive(format!("tar build failed: {e}")))?;
    let encoder = tar_builder
        .into_inner()
        .map_err(|e| EnvError::Archive(format!("tar finish failed: {e}")))?;
    encoder
        .finish()
        .map_err(|e| EnvError::Archive(format!("zstd finish failed: {e}")))?;

    let _ = std::fs::remove_dir_all(&tmp_pack);
    Ok(())
}
