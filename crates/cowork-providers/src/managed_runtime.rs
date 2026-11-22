//! Generic Cowork-managed provider runtime plumbing.
//!
//! Shared by runtime-downloaded stdio providers (`codex-cli`, `claude-sdk`, `antigravity-acp`).
//! Every managed runtime obeys the same security and lifecycle invariants:
//!
//! 1. **Never searches `PATH`**: only an explicit env override or the repo-pinned, checksum-verified
//!    runtime under `~/.cowork/<runtime_dir>/{versions/<version>,current}/<platform>-<arch>/` may run.
//! 2. **Verify before extract/promote/execute**: downloaded bytes are hashed (SHA-256 or SHA-512)
//!    against the repository-pinned checksum table while streaming under strict timeout and byte
//!    limits; mismatched or oversized downloads fail closed and delete partial files immediately.
//! 3. **Atomic locked promotion + single-flight**: concurrent installs serialize on an in-process
//!    mutex plus cross-process `with_file_lock`, stage into `.staging/<uuid>`, promote into
//!    `versions/<version>/` then `current/`, and prune old versions (keeping 3).
//! 4. **Isolated auth & process groups**: each runtime gets its own `0700` home under
//!    `~/.cowork/auth/<provider>`, strips inherited provider env vars, and spawns in its own
//!    process group so cancellation/close cleans up all descendants.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use cowork_config::{
    ConfigError, FileLockOptions, ensure_private_dir_sync, file_lock_root_for_cowork_home,
    with_file_lock,
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256, Sha512};
use tokio::process::{Child, Command};
use uuid::Uuid;

pub const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
pub const DEFAULT_METADATA_TIMEOUT: Duration = Duration::from_secs(30);
pub const DEFAULT_MAX_METADATA_BYTES: u64 = 4 * 1024 * 1024;
pub const DEFAULT_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(5 * 60);
pub const DEFAULT_MAX_DOWNLOAD_BYTES: u64 = 512 * 1024 * 1024;
const MANAGED_VERSIONS_TO_KEEP: usize = 3;

/// Checksum algorithm used to verify a repo-pinned managed runtime artifact.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChecksumAlgorithm {
    Sha256,
    Sha512,
}

impl ChecksumAlgorithm {
    pub fn label(self) -> &'static str {
        match self {
            Self::Sha256 => "SHA-256",
            Self::Sha512 => "SHA-512",
        }
    }
}

/// Platform/architecture target using Node-compatible identifiers (`darwin`/`linux`/`win32`,
/// `x64`/`arm64`) shared across all Cowork managed runtimes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedRuntimeTarget {
    pub platform: String,
    pub arch: String,
    pub is_musl: bool,
}

impl ManagedRuntimeTarget {
    pub fn host() -> Result<Self, String> {
        Self::new(
            cowork_sandbox::host_platform(),
            cowork_sandbox::host_arch(),
            detect_host_linux_musl(),
        )
    }

    pub fn new(platform: &str, arch: &str, is_musl: bool) -> Result<Self, String> {
        if !matches!(platform, "darwin" | "linux" | "win32") {
            return Err(format!("Unsupported managed runtime platform: {platform}"));
        }
        if !matches!(arch, "x64" | "arm64") {
            return Err(format!("Unsupported managed runtime architecture: {arch}"));
        }
        Ok(Self {
            platform: platform.to_owned(),
            arch: arch.to_owned(),
            is_musl: platform == "linux" && is_musl,
        })
    }

    pub fn is_windows(&self) -> bool {
        self.platform == "win32"
    }

    pub fn exe_suffix(&self) -> &'static str {
        if self.is_windows() { ".exe" } else { "" }
    }

    pub fn dir_name(&self) -> String {
        format!("{}-{}", self.platform, self.arch)
    }
}

fn detect_host_linux_musl() -> bool {
    #[cfg(all(target_os = "linux", target_env = "musl"))]
    {
        true
    }
    #[cfg(all(target_os = "linux", not(target_env = "musl")))]
    {
        Path::new("/etc/alpine-release").is_file()
            || std::fs::read_dir("/lib").ok().is_some_and(|mut entries| {
                entries.any(|e| {
                    e.ok()
                        .and_then(|de| de.file_name().into_string().ok())
                        .is_some_and(|name| name.starts_with("ld-musl-"))
                })
            })
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

/// Canonical install status reported by `cowork/provider/runtime/{status,update}` (wire-identical
/// to `CodexInstallStatus` so desktop/mobile clients reuse one renderer).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedRuntimeInstallStatus {
    pub available: bool,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pinned_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pin_matches_current: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub managed_path: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstalledManagedBinary {
    pub command: PathBuf,
    pub version: String,
}

/// `~/.cowork/<runtime_dir>`.
pub fn managed_runtime_root(cowork_home: &Path, runtime_dir: &str) -> PathBuf {
    cowork_home.join(runtime_dir)
}

/// `~/.cowork/<runtime_dir>/versions/<version>/<platform>-<arch>/<exe_basename>[.exe]`.
pub fn managed_executable_path(
    cowork_home: &Path,
    runtime_dir: &str,
    version: &str,
    target: &ManagedRuntimeTarget,
    exe_basename: &str,
) -> PathBuf {
    managed_runtime_root(cowork_home, runtime_dir)
        .join("versions")
        .join(version)
        .join(target.dir_name())
        .join(format!("{exe_basename}{}", target.exe_suffix()))
}

/// `~/.cowork/<runtime_dir>/current/<platform>-<arch>/<exe_basename>[.exe]`.
pub fn managed_current_path(
    cowork_home: &Path,
    runtime_dir: &str,
    target: &ManagedRuntimeTarget,
    exe_basename: &str,
) -> PathBuf {
    managed_runtime_root(cowork_home, runtime_dir)
        .join("current")
        .join(target.dir_name())
        .join(format!("{exe_basename}{}", target.exe_suffix()))
}

pub fn version_file_path(executable: &Path) -> PathBuf {
    let mut os = executable.as_os_str().to_os_string();
    os.push(".version");
    PathBuf::from(os)
}

pub fn read_managed_version_file(executable: &Path) -> Option<String> {
    std::fs::read_to_string(version_file_path(executable))
        .ok()
        .map(|raw| raw.trim().to_owned())
        .filter(|v| !v.is_empty())
}

/// Resolves an already-installed managed binary (pinned version first, else promoted `current`).
pub fn resolve_installed_managed_command(
    cowork_home: &Path,
    runtime_dir: &str,
    pinned_version: &str,
    target: &ManagedRuntimeTarget,
    exe_basename: &str,
) -> Option<(PathBuf, Option<String>)> {
    let pinned = managed_executable_path(
        cowork_home,
        runtime_dir,
        pinned_version,
        target,
        exe_basename,
    );
    let current = managed_current_path(cowork_home, runtime_dir, target, exe_basename);
    let current_version = read_managed_version_file(&current);
    if pinned.is_file() {
        let pinned_ver =
            read_managed_version_file(&pinned).unwrap_or_else(|| pinned_version.to_owned());
        if !target.is_windows()
            && current.is_file()
            && current_version.as_deref() == Some(pinned_ver.as_str())
        {
            return Some((current, Some(pinned_ver)));
        }
        return Some((pinned, Some(pinned_ver)));
    }
    if current.is_file() {
        return Some((current, current_version));
    }
    None
}

/// Resolves status for any managed runtime without ever searching `PATH`.
#[allow(clippy::too_many_arguments)]
pub fn resolve_managed_runtime_status(
    cowork_home: &Path,
    runtime_dir: &str,
    display_name: &str,
    pinned_version: &str,
    exe_basename: &str,
    override_bin: Option<&str>,
    override_args_raw: Option<&str>,
) -> ManagedRuntimeInstallStatus {
    let target = ManagedRuntimeTarget::host().ok();
    let managed_default = target
        .as_ref()
        .map(|t| managed_current_path(cowork_home, runtime_dir, t, exe_basename))
        .unwrap_or_else(|| managed_runtime_root(cowork_home, runtime_dir));
    let managed_str = managed_default.to_string_lossy().into_owned();

    if let Some(bin) = override_bin.map(str::trim).filter(|s| !s.is_empty()) {
        let args = parse_override_args(override_args_raw);
        return ManagedRuntimeInstallStatus {
            available: true,
            source: "override".to_owned(),
            command: Some(bin.to_owned()),
            args: Some(args),
            version: None,
            pinned_version: Some(pinned_version.to_owned()),
            pin_matches_current: None,
            managed_path: Some(managed_str),
            message: format!("Using overridden {display_name} binary at {bin}."),
        };
    }

    if let Some((managed_path, version)) = target.as_ref().and_then(|t| {
        resolve_installed_managed_command(cowork_home, runtime_dir, pinned_version, t, exe_basename)
    }) {
        let path_str = managed_path.to_string_lossy().into_owned();
        let matches = version.as_deref() == Some(pinned_version);
        let message = format!(
            "Using Cowork-managed {display_name} runtime {}.",
            version.as_deref().unwrap_or("(unknown version)")
        );
        return ManagedRuntimeInstallStatus {
            available: true,
            source: "managed".to_owned(),
            command: Some(path_str.clone()),
            args: Some(Vec::new()),
            version,
            pinned_version: Some(pinned_version.to_owned()),
            pin_matches_current: Some(matches),
            managed_path: Some(path_str),
            message,
        };
    }

    ManagedRuntimeInstallStatus {
        available: false,
        source: "missing".to_owned(),
        command: None,
        args: None,
        version: None,
        pinned_version: Some(pinned_version.to_owned()),
        pin_matches_current: Some(false),
        managed_path: Some(managed_str),
        message: format!(
            "Cowork-managed {display_name} runtime {pinned_version} has not been downloaded yet. Cowork will download and verify it before the first turn."
        ),
    }
}

pub fn parse_override_args(raw: Option<&str>) -> Vec<String> {
    let Some(trimmed) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return Vec::new();
    };
    if trimmed.starts_with('[')
        && trimmed.ends_with(']')
        && let Ok(parsed) = serde_json::from_str::<Vec<String>>(trimmed)
    {
        return parsed;
    }
    let mut out = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut chars = trimmed.chars().peekable();
    while let Some(ch) = chars.next() {
        match quote {
            Some(q) => {
                if ch == '\\'
                    && let Some(&next) = chars.peek()
                    && (next == q || next == '\\')
                {
                    current.push(chars.next().unwrap());
                } else if ch == q {
                    quote = None;
                } else {
                    current.push(ch);
                }
            }
            None => {
                if ch == '"' || ch == '\'' {
                    quote = Some(ch);
                } else if ch.is_whitespace() {
                    if !current.is_empty() {
                        out.push(std::mem::take(&mut current));
                    }
                } else {
                    current.push(ch);
                }
            }
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

pub fn build_install_http_client(label: &str) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(DEFAULT_CONNECT_TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| format!("Failed to build HTTP client for {label} install: {e}"))
}

pub fn in_flight_install_lock(key: &str) -> Arc<tokio::sync::Mutex<()>> {
    static MAP: OnceLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> = OnceLock::new();
    let mut guard = MAP.get_or_init(|| Mutex::new(HashMap::new())).lock();
    Arc::clone(guard.entry(key.to_owned()).or_default())
}

pub fn validate_download_limits(
    label: &str,
    download_timeout: Option<Duration>,
    max_download_bytes: Option<u64>,
) -> Result<(Duration, u64), String> {
    let timeout = download_timeout.unwrap_or(DEFAULT_DOWNLOAD_TIMEOUT);
    if timeout.is_zero() || timeout > DEFAULT_DOWNLOAD_TIMEOUT {
        return Err(format!(
            "{label} download timeout must be positive and no greater than {}ms.",
            DEFAULT_DOWNLOAD_TIMEOUT.as_millis()
        ));
    }
    let max_bytes = max_download_bytes.unwrap_or(DEFAULT_MAX_DOWNLOAD_BYTES);
    if max_bytes == 0 || max_bytes > DEFAULT_MAX_DOWNLOAD_BYTES {
        return Err(format!(
            "{label} download byte limit must be a positive integer no greater than {DEFAULT_MAX_DOWNLOAD_BYTES}."
        ));
    }
    Ok((timeout, max_bytes))
}

pub async fn fetch_bounded_bytes(
    client: &reqwest::Client,
    url: &str,
    user_agent: &str,
    label: &str,
    timeout: Duration,
    max_bytes: u64,
) -> Result<Vec<u8>, String> {
    tokio::time::timeout(timeout, async {
        let mut response = client
            .get(url)
            .header(reqwest::header::USER_AGENT, user_agent)
            .send()
            .await
            .map_err(|e| format!("Failed to fetch {label}: {e}"))?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!(
                "Failed to fetch {label}: {} {}",
                status.as_u16(),
                status.canonical_reason().unwrap_or("")
            )
            .trim_end()
            .to_owned());
        }
        if response.content_length().is_some_and(|len| len > max_bytes) {
            return Err(format!("{label} exceeded its {max_bytes}-byte limit."));
        }
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| format!("Failed to read {label}: {e}"))?
        {
            if (body.len() + chunk.len()) as u64 > max_bytes {
                return Err(format!("{label} exceeded its {max_bytes}-byte limit."));
            }
            body.extend_from_slice(&chunk);
        }
        Ok(body)
    })
    .await
    .map_err(|_| format!("{label} request timed out after {}ms.", timeout.as_millis()))?
}

/// Streams `url` into a newly created private file at `dest`, computing `algo` while downloading,
/// and verifies the digest against `expected_hex` BEFORE returning. Deletes `dest` on any failure.
#[allow(clippy::too_many_arguments)]
pub async fn download_and_verify(
    client: &reqwest::Client,
    url: &str,
    user_agent: &str,
    label: &str,
    dest: &Path,
    algo: ChecksumAlgorithm,
    expected_hex: &str,
    timeout: Duration,
    max_bytes: u64,
) -> Result<(), String> {
    let download = async {
        let mut response = client
            .get(url)
            .header(reqwest::header::ACCEPT, "application/octet-stream")
            .header(reqwest::header::USER_AGENT, user_agent)
            .send()
            .await
            .map_err(|e| format!("Failed to download {label}: {e}"))?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!(
                "Failed to download {label}: {} {}",
                status.as_u16(),
                status.canonical_reason().unwrap_or("")
            )
            .trim_end()
            .to_owned());
        }
        if response.content_length().is_some_and(|len| len > max_bytes) {
            return Err(format!(
                "{label} download exceeded its {max_bytes}-byte limit."
            ));
        }
        let mut file = create_new_private_file(dest)?;
        let mut sha256 = (algo == ChecksumAlgorithm::Sha256).then(Sha256::new);
        let mut sha512 = (algo == ChecksumAlgorithm::Sha512).then(Sha512::new);
        let mut written: u64 = 0;
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| format!("Failed to download {label}: {e}"))?
        {
            written = written.saturating_add(chunk.len() as u64);
            if written > max_bytes {
                return Err(format!(
                    "{label} download exceeded its {max_bytes}-byte limit."
                ));
            }
            if let Some(h) = sha256.as_mut() {
                h.update(&chunk);
            }
            if let Some(h) = sha512.as_mut() {
                h.update(&chunk);
            }
            file.write_all(&chunk)
                .map_err(|e| format!("Failed to write {}: {e}", dest.display()))?;
        }
        file.flush()
            .map_err(|e| format!("Failed to write {}: {e}", dest.display()))?;
        let actual = match (sha256, sha512) {
            (Some(h), _) => hex::encode(h.finalize()),
            (_, Some(h)) => hex::encode(h.finalize()),
            _ => unreachable!(),
        };
        if !actual.eq_ignore_ascii_case(expected_hex.trim()) {
            return Err(format!(
                "{label} failed {} checksum verification (expected {}, got {actual}).",
                algo.label(),
                expected_hex.trim()
            ));
        }
        Ok(())
    };
    let result = match tokio::time::timeout(timeout, download).await {
        Ok(res) => res,
        Err(_) => Err(format!(
            "{label} download timed out after {}ms.",
            timeout.as_millis()
        )),
    };
    if result.is_err() {
        let _ = std::fs::remove_file(dest);
    }
    result
}

pub fn create_new_private_file(path: &Path) -> Result<std::fs::File, String> {
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path)
        .map_err(|e| format!("Failed to create {}: {e}", path.display()))
}

/// Extracts the first regular file matching any name in `candidate_names` from a verified
/// `.tar.gz` archive into `out` without unpacking any other entries or symlinks.
pub fn extract_executable_from_tar_gz(
    archive: &Path,
    candidate_names: &[&str],
    out: &Path,
    label: &str,
    max_bytes: u64,
) -> Result<bool, String> {
    let err = |e: std::io::Error| format!("Failed to extract {label} archive: {e}");
    for &wanted in candidate_names {
        let file = std::fs::File::open(archive).map_err(err)?;
        let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(file));
        for entry in tar.entries().map_err(err)? {
            let mut entry = entry.map_err(err)?;
            if !entry.header().entry_type().is_file() {
                continue;
            }
            let path = entry.path().map_err(err)?;
            if path.file_name().and_then(|n| n.to_str()) != Some(wanted) {
                continue;
            }
            let mut dest = create_new_private_file(out)?;
            let copied =
                std::io::copy(&mut (&mut entry).take(max_bytes + 1), &mut dest).map_err(err)?;
            if copied > max_bytes {
                drop(dest);
                let _ = std::fs::remove_file(out);
                return Err(format!(
                    "{label} archive entry exceeded its {max_bytes}-byte limit."
                ));
            }
            dest.flush().map_err(err)?;
            return Ok(true);
        }
    }
    Ok(false)
}

#[derive(Debug)]
struct LockError(String);

impl From<ConfigError> for LockError {
    fn from(err: ConfigError) -> Self {
        Self(err.to_string())
    }
}

async fn with_runtime_lock<F, Fut>(target: &Path, lock_root: &Path, work: F) -> Result<(), String>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<(), String>>,
{
    with_file_lock(
        target,
        move || async move { work().await.map_err(LockError) },
        FileLockOptions {
            lock_root: Some(lock_root.to_path_buf()),
            ..FileLockOptions::default()
        },
    )
    .await
    .map_err(|LockError(message)| message)
}

pub async fn copy_executable_atomically(
    source: &Path,
    dest: &Path,
    is_windows: bool,
    label: &str,
) -> Result<(), String> {
    let source = source.to_path_buf();
    let dest = dest.to_path_buf();
    let make_executable = !is_windows;
    let label_owned = label.to_owned();
    tokio::task::spawn_blocking(move || {
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
        }
        let mut tmp = dest.as_os_str().to_os_string();
        tmp.push(format!(".tmp-{}", Uuid::new_v4()));
        let tmp = PathBuf::from(tmp);
        let result = (|| {
            std::fs::copy(&source, &tmp)
                .map_err(|e| format!("Failed to copy {}: {e}", source.display()))?;
            #[cfg(unix)]
            if make_executable {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))
                    .map_err(|e| format!("Failed to mark {} executable: {e}", tmp.display()))?;
            }
            #[cfg(not(unix))]
            let _ = make_executable;
            std::fs::rename(&tmp, &dest)
                .map_err(|e| format!("Failed to install {label_owned} at {}: {e}", dest.display()))
        })();
        let _ = std::fs::remove_file(&tmp);
        result
    })
    .await
    .map_err(|e| format!("Failed to install {label}: {e}"))?
}

/// Atomically installs `staged_exe` into `versions/<version>` and promotes it to `current`,
/// then prunes older versions (keeping at most 3).
#[allow(clippy::too_many_arguments)]
pub async fn atomic_promote_managed_runtime(
    cowork_home: &Path,
    runtime_dir: &str,
    version: &str,
    target: &ManagedRuntimeTarget,
    staged_exe: &Path,
    exe_basename: &str,
    label: &str,
) -> Result<InstalledManagedBinary, String> {
    let executable_path =
        managed_executable_path(cowork_home, runtime_dir, version, target, exe_basename);
    let current_path = managed_current_path(cowork_home, runtime_dir, target, exe_basename);
    let lock_root = file_lock_root_for_cowork_home(cowork_home);
    let is_windows = target.is_windows();

    with_runtime_lock(&executable_path, &lock_root, || async {
        copy_executable_atomically(staged_exe, &executable_path, is_windows, label).await?;
        cowork_config::write_text_file_atomic(
            &version_file_path(&executable_path),
            &format!("{version}\n"),
            None,
        )
        .map_err(|e| format!("Failed to write {label} version marker: {e}"))?;

        with_runtime_lock(&current_path, &lock_root, || async {
            match copy_executable_atomically(&executable_path, &current_path, is_windows, label)
                .await
            {
                Ok(()) => cowork_config::write_text_file_atomic(
                    &version_file_path(&current_path),
                    &format!("{version}\n"),
                    None,
                )
                .map_err(|e| format!("Failed to write {label} current version marker: {e}")),
                Err(_) if is_windows => Ok(()),
                Err(err) => Err(err),
            }
        })
        .await
    })
    .await?;

    prune_managed_versions(cowork_home, runtime_dir);
    Ok(InstalledManagedBinary {
        command: if is_windows {
            executable_path
        } else {
            current_path
        },
        version: version.to_owned(),
    })
}

/// Re-promotes an existing verified versioned binary to `current` when `!force`.
pub async fn promote_existing_managed_runtime(
    cowork_home: &Path,
    runtime_dir: &str,
    version: &str,
    target: &ManagedRuntimeTarget,
    exe_basename: &str,
    label: &str,
) -> Result<InstalledManagedBinary, String> {
    let executable_path =
        managed_executable_path(cowork_home, runtime_dir, version, target, exe_basename);
    let current_path = managed_current_path(cowork_home, runtime_dir, target, exe_basename);
    let lock_root = file_lock_root_for_cowork_home(cowork_home);
    let is_windows = target.is_windows();

    with_runtime_lock(&current_path, &lock_root, || async {
        match copy_executable_atomically(&executable_path, &current_path, is_windows, label).await {
            Ok(()) => cowork_config::write_text_file_atomic(
                &version_file_path(&current_path),
                &format!("{version}\n"),
                None,
            )
            .map_err(|e| format!("Failed to write {label} current version marker: {e}")),
            Err(_) if is_windows => Ok(()),
            Err(err) => Err(err),
        }
    })
    .await?;

    Ok(InstalledManagedBinary {
        command: if is_windows {
            executable_path
        } else {
            current_path
        },
        version: version.to_owned(),
    })
}

fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let left: Vec<&str> = a.split(['.', '-']).collect();
    let right: Vec<&str> = b.split(['.', '-']).collect();
    for index in 0..left.len().max(right.len()) {
        match (left.get(index), right.get(index)) {
            (None, Some(_)) => return Ordering::Greater,
            (Some(_), None) => return Ordering::Less,
            (Some(l), Some(r)) => match (l.parse::<u64>(), r.parse::<u64>()) {
                (Ok(ln), Ok(rn)) if ln != rn => return ln.cmp(&rn),
                (Ok(_), Ok(_)) => {}
                (Err(_), Err(_)) if l != r => return l.cmp(r),
                (Err(_), Err(_)) => {}
                (Ok(_), Err(_)) => return Ordering::Greater,
                (Err(_), Ok(_)) => return Ordering::Less,
            },
            (None, None) => {}
        }
    }
    Ordering::Equal
}

fn prune_managed_versions(cowork_home: &Path, runtime_dir: &str) {
    let versions_dir = managed_runtime_root(cowork_home, runtime_dir).join("versions");
    let Ok(entries) = std::fs::read_dir(&versions_dir) else {
        return;
    };
    let mut versions: Vec<String> = entries
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|e| e.file_name().to_str().map(str::to_owned))
        .collect();
    if versions.len() <= MANAGED_VERSIONS_TO_KEEP {
        return;
    }
    versions.sort_by(|a, b| compare_versions(a, b));
    let prune_count = versions.len() - MANAGED_VERSIONS_TO_KEEP;
    for version in versions.into_iter().take(prune_count) {
        let _ = std::fs::remove_dir_all(versions_dir.join(version));
    }
}

/// Builds a stripped, isolated child environment for a Cowork-managed provider runtime:
/// creates `<cowork_home>/auth/<provider_dir>` with `0700` permissions, removes any variable
/// matching `strip_prefixes` (case-insensitive) plus `COWORK_DESKTOP_PARENT_MANAGED`, and inserts
/// `set_vars`.
pub fn build_isolated_runtime_env(
    cowork_home: &Path,
    provider_auth_dir: &str,
    strip_prefixes: &[&str],
    set_vars: &[(String, String)],
    parent_env: &HashMap<String, String>,
) -> (PathBuf, HashMap<String, String>) {
    let auth_home = cowork_home.join("auth").join(provider_auth_dir);
    let _ = ensure_private_dir_sync(&auth_home);

    let mut spawn_env = HashMap::with_capacity(parent_env.len() + set_vars.len());
    for (k, v) in parent_env {
        let upper = k.to_ascii_uppercase();
        if strip_prefixes
            .iter()
            .any(|prefix| upper.starts_with(prefix))
            || k.eq_ignore_ascii_case(cowork_sandbox::PARENT_MANAGED_ENV_VAR)
        {
            continue;
        }
        spawn_env.insert(k.clone(), v.clone());
    }
    for (k, v) in set_vars {
        spawn_env.insert(k.clone(), v.clone());
    }
    (auth_home, spawn_env)
}

/// Spawns a managed stdio subprocess in its own process group with a clean environment.
pub fn spawn_managed_stdio_process(
    command: &str,
    args: &[String],
    cwd: &Path,
    spawn_env: &HashMap<String, String>,
    label: &str,
) -> Result<Child, String> {
    let mut cmd = Command::new(command);
    cmd.args(args)
        .current_dir(cwd)
        .env_clear()
        .envs(spawn_env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    cmd.process_group(0);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn()
        .map_err(|err| format!("Failed to spawn {label} ({command}): {err}"))
}

#[cfg(any(windows, test))]
fn windows_taskkill_args(pid: u32) -> [String; 4] {
    [
        "/PID".to_owned(),
        pid.to_string(),
        "/T".to_owned(),
        "/F".to_owned(),
    ]
}

#[cfg(windows)]
fn windows_process_tree_kill_command(pid: u32) -> Command {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut cmd = Command::new("taskkill");
    cmd.args(windows_taskkill_args(pid))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// Terminates a spawned managed stdio child and its entire process tree cleanly
/// (its process group on Unix, `taskkill /PID <pid> /T /F` on Windows).
pub async fn kill_managed_process_tree(mut child: Child) {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        let pgid = format!("-{pid}");
        // Separate the negative process-group ID with `--` so procps-ng `kill` on Linux
        // does not misparse `-<pid>` as a signal option.
        let _ = Command::new("kill")
            .args(["-s", "TERM", "--", &pgid])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;
        let _ = tokio::time::timeout(Duration::from_millis(500), child.wait()).await;
        let _ = Command::new("kill")
            .args(["-s", "KILL", "--", &pgid])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;
    }
    #[cfg(windows)]
    if let Some(pid) = child.id() {
        // Kill the process tree while the root is still unreaped so its PID cannot be reused.
        let mut cmd = windows_process_tree_kill_command(pid);
        let _ = tokio::time::timeout(Duration::from_secs(5), cmd.status()).await;
    }
    let _ = child.kill().await;
    let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
}

#[cfg(test)]
mod kill_tree_tests {
    use super::*;

    #[test]
    fn windows_taskkill_args_target_whole_process_tree_forcefully() {
        assert_eq!(windows_taskkill_args(4242), ["/PID", "4242", "/T", "/F"]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn kill_managed_process_tree_terminates_process_group_descendants() {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "sleep 60 & echo $!; wait"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .process_group(0);
        let mut child = cmd.spawn().expect("spawn sh process group");
        let stdout = child.stdout.take().expect("stdout");
        let mut reader = tokio::io::BufReader::new(stdout);
        let mut line = String::new();
        tokio::io::AsyncBufReadExt::read_line(&mut reader, &mut line)
            .await
            .expect("read grandchild pid");
        let grandchild_pid: i32 = line.trim().parse().expect("parse grandchild pid");

        kill_managed_process_tree(child).await;

        let alive = std::process::Command::new("kill")
            .args(["-0", &grandchild_pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        assert!(
            !alive,
            "grandchild pid {grandchild_pid} must be terminated with its process group"
        );
    }
}
