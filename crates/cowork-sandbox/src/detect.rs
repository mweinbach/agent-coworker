use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::env_utils::{get_env, host_platform};
use crate::seatbelt::MACOS_SEATBELT_EXECUTABLE;
use crate::windows::{
    WINDOWS_SANDBOX_COMMAND_RUNNER_NAME, WINDOWS_SANDBOX_HELPER_NAME, WINDOWS_SANDBOX_SETUP_NAME,
    verify_windows_authenticode, windows_sandbox_home,
};

pub const SEATBELT_RETRY_COOLDOWN_MS: u64 = 60_000;
pub const BWRAP_RETRY_COOLDOWN_MS: u64 = 60_000;
pub const WINDOWS_SANDBOX_PROBE_TTL_MS: u64 = 30_000;
pub const WINDOWS_SANDBOX_PROBE_TIMEOUT_MS: u64 = 15_000;

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

fn windows_probe_cache() -> &'static Mutex<HashMap<(PathBuf, PathBuf), CachedWindowsProbe>> {
    static CACHE: OnceLock<Mutex<HashMap<(PathBuf, PathBuf), CachedWindowsProbe>>> =
        OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Resets the Seatbelt verification cache (for deterministic unit tests).
pub fn reset_seatbelt_cache_for_tests() {
    *seatbelt_cache().lock() = None;
}

/// Resets the `bwrap` usability cache (for deterministic unit tests).
pub fn reset_bwrap_cache_for_tests() {
    bwrap_cache().lock().clear();
}

/// Resets the Windows sandbox bundle probe cache (for deterministic unit tests).
pub fn reset_windows_probe_cache_for_tests() {
    windows_probe_cache().lock().clear();
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
pub fn find_bwrap(env: &HashMap<String, String>) -> Option<PathBuf> {
    if let Some(override_raw) = env.get("COWORK_BWRAP_PATH") {
        let trimmed = override_raw.trim();
        if !trimmed.is_empty() {
            let p = PathBuf::from(trimmed);
            return if p.is_absolute() && is_executable_file(&p) {
                Some(p)
            } else {
                None
            };
        }
    }
    for dir in TRUSTED_BWRAP_DIRS {
        let candidate = Path::new(dir).join("bwrap");
        if is_executable_file(&candidate) {
            return Some(candidate);
        }
    }
    None
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

/// Locates `cowork-win-sandbox.exe` when all three Windows sandbox binaries (`helper`, `setup`,
/// `command-runner`) exist together.
pub fn find_windows_helper(
    env: &HashMap<String, String>,
    extra_candidate_dirs: &[PathBuf],
) -> Option<PathBuf> {
    if let Some(override_raw) = get_env(env, "COWORK_WIN_SANDBOX_HELPER", "win32") {
        let trimmed = override_raw.trim();
        if !trimmed.is_empty() {
            let helper = PathBuf::from(trimmed);
            let dir = helper.parent().unwrap_or_else(|| Path::new("."));
            let setup = get_env(env, "COWORK_WIN_SANDBOX_SETUP", "win32")
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| dir.join(WINDOWS_SANDBOX_SETUP_NAME));
            let runner = get_env(env, "COWORK_WIN_SANDBOX_COMMAND_RUNNER", "win32")
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| dir.join(WINDOWS_SANDBOX_COMMAND_RUNNER_NAME));
            if helper.is_file() && setup.is_file() && runner.is_file() {
                return Some(helper);
            }
            return None;
        }
    }

    let mut dirs = extra_candidate_dirs.to_vec();
    if let Ok(exe) = std::env::current_exe()
        && let Some(exe_dir) = exe.parent()
    {
        dirs.push(exe_dir.to_path_buf());
        dirs.push(exe_dir.join("windows-sandbox"));
        if let Some(parent) = exe_dir.parent() {
            dirs.push(parent.join("windows-sandbox"));
        }
    }

    for dir in dirs {
        let helper = dir.join(WINDOWS_SANDBOX_HELPER_NAME);
        let setup = dir.join(WINDOWS_SANDBOX_SETUP_NAME);
        let runner = dir.join(WINDOWS_SANDBOX_COMMAND_RUNNER_NAME);
        if helper.is_file() && setup.is_file() && runner.is_file() {
            return Some(helper);
        }
    }
    None
}

/// Result of `probe_windows_sandbox_bundle`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowsSandboxProbeResult {
    pub ready: bool,
    pub filesystem: bool,
    pub network: bool,
    pub process: bool,
    pub integrity: bool,
    pub setup_required: bool,
    pub warning: Option<String>,
}

/// Raw process outcome returned by `WindowsProbeRunner` (or real `Command` execution).
#[derive(Debug, Clone)]
pub struct ProbeCommandOutput {
    pub exit_code: Option<i32>,
    pub signaled: bool,
    pub stdout: String,
    pub stderr: String,
}

/// Callback signature for custom Windows helper probe execution in offline unit tests.
pub type WindowsProbeRunnerFn<'a> =
    &'a dyn Fn(&Path, &[String]) -> Result<ProbeCommandOutput, String>;

/// Injectable options for `probe_windows_sandbox_bundle` enabling deterministic offline tests.
#[derive(Default)]
pub struct WindowsProbeOptions<'a> {
    pub now_ms: Option<u64>,
    pub cwd: Option<&'a Path>,
    pub probe_runner: Option<WindowsProbeRunnerFn<'a>>,
    pub authenticode_verifier: Option<&'a dyn Fn(&Path) -> bool>,
}

#[derive(Deserialize)]
struct HelperProbePayload {
    ready: Option<bool>,
    filesystem: Option<bool>,
    network: Option<bool>,
    process: Option<bool>,
    integrity: Option<bool>,
    setup_required: Option<bool>,
}

/// Verifies SHA-256 + optional Authenticode (`WinVerifyTrust`) integrity of all three Windows
/// sandbox binaries and runs `cowork-win-sandbox.exe probe`, memoized for 30s per `(helper, sandbox_home)`.
pub fn probe_windows_sandbox_bundle(
    helper_path: &Path,
    env: &HashMap<String, String>,
    opts: WindowsProbeOptions<'_>,
) -> WindowsSandboxProbeResult {
    crate::windows::sync_windows_sandbox_for_env_if_applicable(env);
    let sandbox_home = windows_sandbox_home(env);
    let cache_key = (helper_path.to_path_buf(), sandbox_home.clone());
    let now = opts.now_ms.unwrap_or_else(current_epoch_ms);

    {
        let guard = windows_probe_cache().lock();
        if let Some(cached) = guard.get(&cache_key)
            && now.saturating_sub(cached.at_ms) < WINDOWS_SANDBOX_PROBE_TTL_MS
        {
            return cached.result.clone();
        }
    }

    let result = compute_windows_sandbox_probe(helper_path, &sandbox_home, env, &opts);
    windows_probe_cache().lock().insert(
        cache_key,
        CachedWindowsProbe {
            result: result.clone(),
            at_ms: now,
        },
    );
    result
}

fn compute_windows_sandbox_probe(
    helper_path: &Path,
    sandbox_home: &Path,
    env: &HashMap<String, String>,
    opts: &WindowsProbeOptions<'_>,
) -> WindowsSandboxProbeResult {
    if let Err(reason) =
        verify_windows_bundle_integrity(helper_path, env, opts.authenticode_verifier)
    {
        return WindowsSandboxProbeResult {
            ready: false,
            filesystem: false,
            network: false,
            process: false,
            integrity: false,
            setup_required: false,
            warning: Some(format!("Windows sandbox integrity check failed: {reason}.")),
        };
    }

    let cwd = opts
        .cwd
        .map(Path::to_path_buf)
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."));

    let probe_args = vec![
        "probe".to_owned(),
        "--sandbox-home".to_owned(),
        sandbox_home.to_string_lossy().into_owned(),
        "--cwd".to_owned(),
        cwd.to_string_lossy().into_owned(),
    ];

    let output = match opts.probe_runner {
        Some(runner) => match runner(helper_path, &probe_args) {
            Ok(out) => out,
            Err(err) => {
                return failed_probe_after_integrity(format!(
                    "Windows sandbox helper probe failed ({err})."
                ));
            }
        },
        None => {
            let mut cmd = Command::new(helper_path);
            cmd.args(&probe_args)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            match run_command_with_timeout(
                &mut cmd,
                Duration::from_millis(WINDOWS_SANDBOX_PROBE_TIMEOUT_MS),
            ) {
                Some(out) => out,
                None => {
                    return failed_probe_after_integrity(
                        "Windows sandbox helper probe timed out.".to_owned(),
                    );
                }
            }
        }
    };

    if output.signaled || output.exit_code != Some(0) {
        let detail = if !output.stderr.trim().is_empty() {
            output.stderr.trim().to_owned()
        } else if output.signaled {
            "terminated by signal".to_owned()
        } else {
            format!("exit {}", output.exit_code.unwrap_or(1))
        };
        return failed_probe_after_integrity(format!(
            "Windows sandbox helper probe failed ({detail})."
        ));
    }

    let Ok(parsed) = serde_json::from_str::<HelperProbePayload>(&output.stdout) else {
        return failed_probe_after_integrity(
            "Windows sandbox helper probe returned unreadable output.".to_owned(),
        );
    };

    let ready = parsed.ready == Some(true);
    let setup_required = parsed.setup_required == Some(true);
    WindowsSandboxProbeResult {
        ready,
        filesystem: parsed.filesystem == Some(true),
        network: parsed.network == Some(true),
        process: parsed.process == Some(true),
        integrity: parsed.integrity.unwrap_or(true),
        setup_required,
        warning: if ready {
            None
        } else if setup_required {
            Some("Windows sandbox helper setup has not completed yet.".to_owned())
        } else {
            Some("Windows sandbox helper reported an incomplete capability set.".to_owned())
        },
    }
}

fn failed_probe_after_integrity(warning: String) -> WindowsSandboxProbeResult {
    WindowsSandboxProbeResult {
        ready: false,
        filesystem: false,
        network: false,
        process: false,
        integrity: true,
        setup_required: false,
        warning: Some(warning),
    }
}

fn verify_windows_bundle_integrity(
    helper_path: &Path,
    env: &HashMap<String, String>,
    authenticode_override: Option<&dyn Fn(&Path) -> bool>,
) -> Result<(), String> {
    let dir = helper_path.parent().unwrap_or_else(|| Path::new("."));
    let setup_path = get_env(env, "COWORK_WIN_SANDBOX_SETUP", "win32")
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| dir.join(WINDOWS_SANDBOX_SETUP_NAME));
    let runner_path = get_env(env, "COWORK_WIN_SANDBOX_COMMAND_RUNNER", "win32")
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| dir.join(WINDOWS_SANDBOX_COMMAND_RUNNER_NAME));

    let require_authenticode =
        get_env(env, "COWORK_WIN_SANDBOX_REQUIRE_AUTHENTICODE", "win32") == Some("1");

    let entries = [
        (
            helper_path,
            get_env(env, "COWORK_WIN_SANDBOX_HELPER_SHA256", "win32"),
        ),
        (
            setup_path.as_path(),
            get_env(env, "COWORK_WIN_SANDBOX_SETUP_SHA256", "win32"),
        ),
        (
            runner_path.as_path(),
            get_env(env, "COWORK_WIN_SANDBOX_COMMAND_RUNNER_SHA256", "win32"),
        ),
    ];

    for (file_path, expected_raw) in entries {
        let base_name = file_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("helper.exe");
        let Some(expected) = normalize_sha256(expected_raw) else {
            return Err(format!("trusted SHA-256 is missing for {base_name}"));
        };
        let Some(actual) = sha256_file_hex(file_path) else {
            return Err(format!("unable to read {base_name}"));
        };
        if actual != expected {
            return Err(format!("SHA-256 mismatch for {base_name}"));
        }
        if require_authenticode {
            let sig_ok = match authenticode_override {
                Some(verifier) => verifier(file_path),
                None => verify_windows_authenticode(file_path),
            };
            if !sig_ok {
                return Err(format!("Authenticode signature is invalid for {base_name}"));
            }
        }
    }

    Ok(())
}

fn normalize_sha256(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim().to_ascii_lowercase();
    if trimmed.len() == 64 && trimmed.bytes().all(|b| b.is_ascii_hexdigit()) {
        Some(trimmed)
    } else {
        None
    }
}

fn sha256_file_hex(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let digest = Sha256::digest(&bytes);
    Some(hex::encode(digest))
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
