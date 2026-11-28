use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;

use crate::env_utils::host_platform;
use crate::seatbelt::MACOS_SEATBELT_EXECUTABLE;

pub const SEATBELT_RETRY_COOLDOWN_MS: u64 = 60_000;
pub const BWRAP_RETRY_COOLDOWN_MS: u64 = 60_000;
pub const WINDOWS_SANDBOX_PROBE_TTL_MS: u64 = 30_000;

const TRUSTED_BWRAP_DIRS: [&str; 6] = [
    "/usr/bin",
    "/bin",
    "/usr/local/bin",
    "/usr/sbin",
    "/sbin",
    "/run/current-system/sw/bin",
];

fn current_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Clone, Copy)]
enum CooldownCacheEntry {
    VerifiedTrue,
    FailedAt(u64),
}

fn seatbelt_cache() -> &'static Mutex<Option<CooldownCacheEntry>> {
    static CACHE: OnceLock<Mutex<Option<CooldownCacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn bwrap_cache() -> &'static Mutex<HashMap<PathBuf, CooldownCacheEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, CooldownCacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Clone)]
struct CachedWindowsProbe {
    result: WindowsSandboxProbeResult,
    at_ms: u64,
}

fn windows_probe_cache() -> &'static Mutex<Option<CachedWindowsProbe>> {
    static CACHE: OnceLock<Mutex<Option<CachedWindowsProbe>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

/// Resets the Seatbelt verification cache (for deterministic unit tests).
pub fn reset_seatbelt_cache_for_tests() {
    *seatbelt_cache().lock() = None;
}

/// Resets the `bwrap` usability cache (for deterministic unit tests).
pub fn reset_bwrap_cache_for_tests() {
    bwrap_cache().lock().clear();
}

/// Resets the Windows MXC probe cache (for deterministic unit tests).
pub fn reset_windows_probe_cache_for_tests() {
    *windows_probe_cache().lock() = None;
}

/// Injectable hooks for `has_seatbelt_with_options`.
#[derive(Default)]
pub struct SeatbeltCheckOptions<'a> {
    pub now_ms: Option<u64>,
    pub platform: Option<&'a str>,
    pub verifier: Option<&'a dyn Fn() -> bool>,
}

/// Verifies Apple `/usr/bin/sandbox-exec` ownership, permissions, realpath, and `anchor apple`
/// code signature with permanent `true` caching and a 60s negative retry cooldown.
pub fn has_seatbelt() -> bool {
    has_seatbelt_with_options(SeatbeltCheckOptions::default())
}

pub fn has_seatbelt_with_options(opts: SeatbeltCheckOptions<'_>) -> bool {
    let platform = opts.platform.unwrap_or(host_platform());
    if platform != "darwin" {
        return false;
    }
    let now = opts.now_ms.unwrap_or_else(current_epoch_ms);
    {
        let guard = seatbelt_cache().lock();
        match *guard {
            Some(CooldownCacheEntry::VerifiedTrue) => return true,
            Some(CooldownCacheEntry::FailedAt(at))
                if now.saturating_sub(at) < SEATBELT_RETRY_COOLDOWN_MS =>
            {
                return false;
            }
            _ => {}
        }
    }

    let ok = match opts.verifier {
        Some(v) => v(),
        None => verify_host_seatbelt_binary(),
    };

    let mut guard = seatbelt_cache().lock();
    *guard = Some(if ok {
        CooldownCacheEntry::VerifiedTrue
    } else {
        CooldownCacheEntry::FailedAt(now)
    });
    ok
}

fn verify_host_seatbelt_binary() -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let path = Path::new(MACOS_SEATBELT_EXECUTABLE);
        let Ok(meta) = std::fs::metadata(path) else {
            return false;
        };
        if !meta.is_file() {
            return false;
        }
        let mode = meta.mode();
        if meta.uid() != 0 || (mode & 0o111) == 0 || (mode & 0o022) != 0 {
            return false;
        }
        let Ok(real) = std::fs::canonicalize(path) else {
            return false;
        };
        if real != path {
            return false;
        }
        let mut cmd = Command::new("/usr/bin/codesign");
        cmd.args([
            "--verify",
            "--strict",
            "-R=anchor apple",
            MACOS_SEATBELT_EXECUTABLE,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
        run_command_with_timeout(&mut cmd, Duration::from_secs(5))
            .is_some_and(|out| out.exit_code == Some(0) && !out.signaled)
    }
    #[cfg(not(unix))]
    {
        false
    }
}

/// Locates a trusted `bwrap` binary (`COWORK_BWRAP_PATH` override or fixed root-owned system dirs;
/// never workspace-controlled `PATH`).
///
/// An override that is relative, missing, or not executable is ignored and the fixed system
/// directories are still searched (TS `findBwrap` parity), so a stale override never hides a
/// working `/usr/bin/bwrap`. An override that exists but cannot create namespaces is still
/// returned and then rejected by `is_bwrap_usable`.
pub fn find_bwrap(env: &HashMap<String, String>) -> Option<PathBuf> {
    let trusted: Vec<&Path> = TRUSTED_BWRAP_DIRS.iter().map(Path::new).collect();
    find_bwrap_in(env, &trusted)
}

fn find_bwrap_in(env: &HashMap<String, String>, trusted_dirs: &[&Path]) -> Option<PathBuf> {
    if let Some(override_raw) = env.get("COWORK_BWRAP_PATH") {
        let p = PathBuf::from(override_raw.trim());
        if p.is_absolute() && is_executable_file(&p) {
            return Some(p);
        }
    }
    trusted_dirs
        .iter()
        .map(|dir| dir.join("bwrap"))
        .find(|candidate| is_executable_file(candidate))
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        (meta.mode() & 0o111) != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Injectable hooks for `is_bwrap_usable_with_options`.
#[derive(Default)]
pub struct BwrapProbeOptions<'a> {
    pub now_ms: Option<u64>,
    pub probe_fn: Option<&'a dyn Fn(&Path) -> bool>,
}

/// Probes whether `bwrap` can create user + network + PID + IPC namespaces on the current host,
/// caching `true` permanently and `false` for 60s.
pub fn is_bwrap_usable(bwrap_path: &Path) -> bool {
    is_bwrap_usable_with_options(bwrap_path, BwrapProbeOptions::default())
}

pub fn is_bwrap_usable_with_options(bwrap_path: &Path, opts: BwrapProbeOptions<'_>) -> bool {
    let now = opts.now_ms.unwrap_or_else(current_epoch_ms);
    {
        let guard = bwrap_cache().lock();
        if let Some(entry) = guard.get(bwrap_path) {
            match *entry {
                CooldownCacheEntry::VerifiedTrue => return true,
                CooldownCacheEntry::FailedAt(at)
                    if now.saturating_sub(at) < BWRAP_RETRY_COOLDOWN_MS =>
                {
                    return false;
                }
                _ => {}
            }
        }
    }

    let ok = match opts.probe_fn {
        Some(f) => f(bwrap_path),
        None => probe_host_bwrap(bwrap_path),
    };

    bwrap_cache().lock().insert(
        bwrap_path.to_path_buf(),
        if ok {
            CooldownCacheEntry::VerifiedTrue
        } else {
            CooldownCacheEntry::FailedAt(now)
        },
    );
    ok
}

fn probe_host_bwrap(bwrap_path: &Path) -> bool {
    let probe_cmd = [
        "/usr/bin/true",
        "/bin/true",
        "/run/current-system/sw/bin/true",
    ]
    .into_iter()
    .map(Path::new)
    .find(|p| is_executable_file(p));
    let Some(true_bin) = probe_cmd else {
        return false;
    };
    let mut cmd = Command::new(bwrap_path);
    cmd.args([
        "--ro-bind",
        "/",
        "/",
        "--dev",
        "/dev",
        "--proc",
        "/proc",
        "--unshare-user",
        "--unshare-pid",
        "--unshare-ipc",
        "--unshare-net",
        "--die-with-parent",
        "--",
    ])
    .arg(true_bin)
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null());

    run_command_with_timeout(&mut cmd, Duration::from_secs(5))
        .is_some_and(|out| out.exit_code == Some(0) && !out.signaled)
}

/// Normalized snapshot of `mxc_sdk::v1::probe(None)` host capabilities for cross-platform testing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowsMxcProbeSnapshot {
    pub tier: Option<String>,
    pub base_container_api_present: bool,
    pub supports_deny_paths: bool,
    pub supports_ingress_host_loopback_allow: bool,
    pub warnings: Vec<String>,
    pub error: Option<String>,
}

/// Result of `probe_windows_mxc_sandbox`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowsSandboxProbeResult {
    pub ready: bool,
    pub filesystem: bool,
    pub network: bool,
    pub process: bool,
    pub integrity: bool,
    pub supports_deny_paths: bool,
    pub supports_ingress_host_loopback_allow: bool,
    pub tier: Option<String>,
    pub warning: Option<String>,
}

/// Injectable options for `probe_windows_mxc_sandbox` enabling deterministic offline tests.
#[derive(Default)]
pub struct WindowsProbeOptions<'a> {
    pub now_ms: Option<u64>,
    pub platform: Option<&'a str>,
    pub probe_fn: Option<&'a dyn Fn() -> Result<WindowsMxcProbeSnapshot, String>>,
}

/// Probes native Windows ProcessContainer (MXC / PSEC) availability via `mxc_sdk::v1::probe(None)`,
/// memoized for 30s (`WINDOWS_SANDBOX_PROBE_TTL_MS`).
pub fn probe_windows_mxc_sandbox(opts: WindowsProbeOptions<'_>) -> WindowsSandboxProbeResult {
    let platform = opts.platform.unwrap_or(host_platform());
    if platform != "win32" {
        return WindowsSandboxProbeResult {
            ready: false,
            filesystem: false,
            network: false,
            process: false,
            integrity: false,
            supports_deny_paths: false,
            supports_ingress_host_loopback_allow: false,
            tier: None,
            warning: Some(
                "Windows ProcessContainer (MXC) is only available on Windows.".to_owned(),
            ),
        };
    }

    let now = opts.now_ms.unwrap_or_else(current_epoch_ms);
    {
        let guard = windows_probe_cache().lock();
        if let Some(cached) = guard.as_ref()
            && now.saturating_sub(cached.at_ms) < WINDOWS_SANDBOX_PROBE_TTL_MS
        {
            return cached.result.clone();
        }
    }

    let raw = match opts.probe_fn {
        Some(f) => f(),
        None => probe_host_windows_mxc(),
    };
    let result = interpret_windows_mxc_probe(raw);

    *windows_probe_cache().lock() = Some(CachedWindowsProbe {
        result: result.clone(),
        at_ms: now,
    });
    result
}

/// Interprets a raw MXC probe snapshot into Cowork's enforcement capabilities.
pub fn interpret_windows_mxc_probe(
    raw: Result<WindowsMxcProbeSnapshot, String>,
) -> WindowsSandboxProbeResult {
    match raw {
        Ok(snap)
            if snap.base_container_api_present
                && snap.tier.is_some()
                && snap.supports_deny_paths
                && snap.error.is_none() =>
        {
            WindowsSandboxProbeResult {
                ready: true,
                filesystem: true,
                network: true,
                process: true,
                integrity: true,
                supports_deny_paths: true,
                supports_ingress_host_loopback_allow: snap.supports_ingress_host_loopback_allow,
                tier: snap.tier,
                warning: None,
            }
        }
        Ok(snap) => {
            let detail = snap
                .error
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| {
                    if !snap.base_container_api_present {
                        "native Windows PSEC ProcessContainer API (processmodel.dll) is not present on this Windows build".to_owned()
                    } else if snap.tier.is_none() {
                        "ProcessContainer tier is unavailable".to_owned()
                    } else if !snap.supports_deny_paths {
                        "host PSEC runtime does not support deniedPaths required to protect credential stores".to_owned()
                    } else {
                        "ProcessContainer tier is unavailable".to_owned()
                    }
                });
            WindowsSandboxProbeResult {
                ready: false,
                filesystem: false,
                network: false,
                process: false,
                integrity: false,
                supports_deny_paths: snap.supports_deny_paths,
                supports_ingress_host_loopback_allow: snap.supports_ingress_host_loopback_allow,
                tier: snap.tier,
                warning: Some(format!(
                    "Windows ProcessContainer (MXC/PSEC) sandbox is unavailable: {detail}."
                )),
            }
        }
        Err(err) => WindowsSandboxProbeResult {
            ready: false,
            filesystem: false,
            network: false,
            process: false,
            integrity: false,
            supports_deny_paths: false,
            supports_ingress_host_loopback_allow: false,
            tier: None,
            warning: Some(format!(
                "Windows ProcessContainer (MXC/PSEC) sandbox probe failed: {err}."
            )),
        },
    }
}

#[cfg(windows)]
fn probe_host_windows_mxc() -> Result<WindowsMxcProbeSnapshot, String> {
    match mxc_sdk::v1::probe(None) {
        Ok(out) => Ok(WindowsMxcProbeSnapshot {
            tier: out.tier.map(str::to_owned),
            base_container_api_present: out.probes.base_container_api_present,
            supports_deny_paths: out.probes.base_container_supports_deny_paths,
            supports_ingress_host_loopback_allow: out
                .probes
                .base_container_supports_ingress_host_loopback_allow,
            warnings: out.warnings,
            error: out.error,
        }),
        Err(err) => Err(err.message),
    }
}

#[cfg(not(windows))]
fn probe_host_windows_mxc() -> Result<WindowsMxcProbeSnapshot, String> {
    Err("native Windows PSEC ProcessContainer is only supported on Windows".to_owned())
}

/// Raw process outcome returned by internal host probes (`codesign`, `bwrap`).
#[derive(Debug, Clone)]
pub struct ProbeCommandOutput {
    pub exit_code: Option<i32>,
    pub signaled: bool,
    pub stdout: String,
    pub stderr: String,
}

fn run_command_with_timeout(cmd: &mut Command, timeout: Duration) -> Option<ProbeCommandOutput> {
    let mut child = cmd.spawn().ok()?;
    let stdout_handle = child.stdout.take().map(|mut out| {
        std::thread::spawn(move || {
            let mut s = String::new();
            let _ = out.read_to_string(&mut s);
            s
        })
    });
    let stderr_handle = child.stderr.take().map(|mut err| {
        std::thread::spawn(move || {
            let mut s = String::new();
            let _ = err.read_to_string(&mut s);
            s
        })
    });

    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let stdout = stdout_handle
                    .and_then(|h| h.join().ok())
                    .unwrap_or_default();
                let stderr = stderr_handle
                    .and_then(|h| h.join().ok())
                    .unwrap_or_default();
                #[cfg(unix)]
                let signaled = {
                    use std::os::unix::process::ExitStatusExt;
                    status.signal().is_some()
                };
                #[cfg(not(unix))]
                let signaled = false;
                return Some(ProbeCommandOutput {
                    exit_code: status.code(),
                    signaled,
                    stdout,
                    stderr,
                });
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_mxc_probe_requires_base_container_api_tier_and_no_error() {
        let ready = interpret_windows_mxc_probe(Ok(WindowsMxcProbeSnapshot {
            tier: Some("base_container".to_owned()),
            base_container_api_present: true,
            supports_deny_paths: true,
            supports_ingress_host_loopback_allow: true,
            warnings: Vec::new(),
            error: None,
        }));
        assert!(ready.ready);
        assert!(ready.filesystem && ready.network && ready.process && ready.integrity);
        assert!(ready.supports_deny_paths);
        assert!(ready.supports_ingress_host_loopback_allow);
        assert!(ready.warning.is_none());

        let no_psec = interpret_windows_mxc_probe(Ok(WindowsMxcProbeSnapshot {
            tier: None,
            base_container_api_present: false,
            supports_deny_paths: false,
            supports_ingress_host_loopback_allow: false,
            warnings: Vec::new(),
            error: Some("PSEC API unavailable on this Windows build".to_owned()),
        }));
        assert!(!no_psec.ready);
        assert!(!no_psec.filesystem && !no_psec.network && !no_psec.process && !no_psec.integrity);
        assert!(
            no_psec
                .warning
                .as_deref()
                .unwrap_or("")
                .contains("PSEC API unavailable")
        );

        let missing_tier = interpret_windows_mxc_probe(Ok(WindowsMxcProbeSnapshot {
            tier: None,
            base_container_api_present: true,
            supports_deny_paths: false,
            supports_ingress_host_loopback_allow: false,
            warnings: Vec::new(),
            error: None,
        }));
        assert!(!missing_tier.ready);

        // Hosts lacking `deniedPaths` support must fail closed so workspace credential
        // stores (e.g. `.cowork/auth/mcp-credentials.json`) cannot be exposed inside a
        // sandbox reported as enforcing.
        let missing_deny_paths = interpret_windows_mxc_probe(Ok(WindowsMxcProbeSnapshot {
            tier: Some("base_container".to_owned()),
            base_container_api_present: true,
            supports_deny_paths: false,
            supports_ingress_host_loopback_allow: true,
            warnings: Vec::new(),
            error: None,
        }));
        assert!(!missing_deny_paths.ready);
        assert!(
            !missing_deny_paths.filesystem
                && !missing_deny_paths.network
                && !missing_deny_paths.process
                && !missing_deny_paths.integrity
        );
        assert!(!missing_deny_paths.supports_deny_paths);
        assert!(
            missing_deny_paths
                .warning
                .as_deref()
                .unwrap_or("")
                .contains("deniedPaths")
        );

        let err_res = interpret_windows_mxc_probe(Err("probe failed".to_owned()));
        assert!(!err_res.ready);
        assert!(
            err_res
                .warning
                .as_deref()
                .unwrap_or("")
                .contains("probe failed")
        );
    }

    #[cfg(unix)]
    fn write_executable(path: &Path) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn unusable_bwrap_override_falls_back_to_trusted_system_dirs_only() {
        let tmp = tempfile::tempdir().unwrap();
        let root = cowork_config::canonicalize_sync(tmp.path());
        let system_dir = root.join("usr-bin");
        let system_bwrap = system_dir.join("bwrap");
        write_executable(&system_bwrap);
        let evil_dir = root.join("workspace/node_modules/.bin");
        write_executable(&evil_dir.join("bwrap"));
        let not_executable = root.join("plain/bwrap");
        std::fs::create_dir_all(not_executable.parent().unwrap()).unwrap();
        std::fs::write(&not_executable, b"x").unwrap();

        let trusted = [root.join("empty-dir"), system_dir.clone()];
        let trusted: Vec<&Path> = trusted.iter().map(PathBuf::as_path).collect();
        for stale in [
            "relative/bwrap".to_owned(),
            root.join("missing/bwrap").to_string_lossy().into_owned(),
            not_executable.to_string_lossy().into_owned(),
            String::new(),
        ] {
            let mut env = HashMap::new();
            env.insert("COWORK_BWRAP_PATH".to_owned(), stale.clone());
            env.insert("PATH".to_owned(), evil_dir.to_string_lossy().into_owned());
            assert_eq!(
                find_bwrap_in(&env, &trusted),
                Some(system_bwrap.clone()),
                "{stale:?}"
            );
        }

        let valid_override = root.join("custom/bwrap");
        write_executable(&valid_override);
        let mut env = HashMap::new();
        env.insert(
            "COWORK_BWRAP_PATH".to_owned(),
            valid_override.to_string_lossy().into_owned(),
        );
        assert_eq!(find_bwrap_in(&env, &trusted), Some(valid_override));
    }
}
