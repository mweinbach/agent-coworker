use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::AsyncReadExt;
use tokio::process::Command as TokioCommand;
use tokio::sync::watch;

use crate::denial::{
    ClassifyDenialOptions, SandboxDenialClassification, SandboxEscalationPlan,
    classify_sandbox_denial_detailed, plan_sandbox_escalation,
};
use crate::env_utils::{
    PARENT_MANAGED_ENV_VAR, host_platform, minimal_sandbox_env, remove_env, sanitized_process_env,
};
use crate::manager::{SandboxCapabilities, SandboxGateDecision, SandboxManager, TransformOptions};
use crate::policy::{SandboxPolicy, normalize_sandbox_child_env, policy_allows_network};
use crate::{SandboxCommand, SandboxErrorCode, SandboxType};

pub const DEFAULT_MAX_BUFFER_BYTES: usize = 10 * 1024 * 1024;

/// Parameters for executing a command through `SandboxRunner`.
#[derive(Debug, Clone)]
pub struct SandboxExecutionRequest {
    pub command: SandboxCommand,
    pub policy: SandboxPolicy,
    pub cwd: PathBuf,
    pub yolo: bool,
    pub require_backend: bool,
    pub has_scoped_target_paths: bool,
    pub timeout: Option<Duration>,
    pub max_buffer: usize,
    /// Trusted host environment for backend discovery and verification. Defaults to the process
    /// environment and also seeds the child environment unless a caller supplies its own.
    pub env_source: Option<HashMap<String, String>>,
    /// Prepared environment for the inner command (for example an isolated Office HOME).
    /// Never used to locate or verify the sandbox helper.
    pub child_env_source: Option<HashMap<String, String>>,
    pub extra_env: HashMap<String, String>,
    pub capabilities_override: Option<SandboxCapabilities>,
    pub sandbox_exec_path: Option<PathBuf>,
    /// Credential directories/files (`~/.ssh`, `~/.cowork/auth`, `<ws>/.cowork/auth`, ...) the
    /// sandboxed command may neither read nor write, applied to every policy the OS backend
    /// wraps (including danger-full-access with `network: false`). Commands that run fully
    /// unsandboxed (`--yolo` without a hard floor, danger-full-access with network) are not
    /// wrapped, so this list cannot apply to them.
    pub read_denied_roots: Vec<PathBuf>,
}

impl SandboxExecutionRequest {
    pub fn new(command: SandboxCommand, policy: SandboxPolicy, cwd: impl Into<PathBuf>) -> Self {
        Self {
            command,
            policy,
            cwd: cwd.into(),
            yolo: false,
            require_backend: false,
            has_scoped_target_paths: false,
            timeout: None,
            max_buffer: DEFAULT_MAX_BUFFER_BYTES,
            env_source: None,
            child_env_source: None,
            extra_env: HashMap::new(),
            capabilities_override: None,
            sandbox_exec_path: None,
            read_denied_roots: Vec::new(),
        }
    }
}

/// Structured result of a command executed (or gated) by `SandboxRunner`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxExecutionResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<SandboxErrorCode>,
    pub sandbox: SandboxType,
    pub unsandboxed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sandbox_warning: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub denial: Option<SandboxDenialClassification>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub escalation: Option<SandboxEscalationPlan>,
}

/// Executes child commands inside dedicated OS process groups under `SandboxManager` policies.
#[derive(Clone, Default)]
pub struct SandboxRunner {
    manager: SandboxManager,
}

impl SandboxRunner {
    pub fn new(manager: SandboxManager) -> Self {
        Self { manager }
    }

    pub fn manager(&self) -> &SandboxManager {
        &self.manager
    }

    /// Runs `req`, optionally invoking `approve_unsandboxed` if the host lacks an enforcing
    /// backend for a non-hard-floor restrictive policy.
    pub async fn run_with_approval<F, Fut>(
        &self,
        req: SandboxExecutionRequest,
        cancel_rx: Option<watch::Receiver<bool>>,
        approve_unsandboxed: Option<F>,
    ) -> SandboxExecutionResult
    where
        F: FnOnce(Option<&str>) -> Fut,
        Fut: std::future::Future<Output = bool>,
    {
        let platform = host_platform();
        let owned_env_src;
        let env_src = match req.env_source.as_ref() {
            Some(e) => e,
            None => {
                owned_env_src = sanitized_process_env();
                &owned_env_src
            }
        };

        let decision = self.manager.evaluate_gate(
            &req.command,
            &req.policy,
            &req.cwd,
            req.yolo,
            req.require_backend,
            req.has_scoped_target_paths,
            TransformOptions {
                platform: Some(platform),
                capabilities: req.capabilities_override.as_ref(),
                sandbox_exec_path: req.sandbox_exec_path.as_deref(),
                env_source: Some(env_src),
                read_denied_roots: &req.read_denied_roots,
            },
        );

        let (exec_file, exec_args, sandbox_env, sandbox_used, unsandboxed, warning) = match decision
        {
            SandboxGateDecision::Deny {
                error_code,
                stderr,
                warning,
            } => {
                return SandboxExecutionResult {
                    stdout: String::new(),
                    stderr,
                    exit_code: 1,
                    error_code: Some(error_code),
                    sandbox: SandboxType::None,
                    unsandboxed: false,
                    sandbox_warning: warning,
                    denial: None,
                    escalation: None,
                };
            }
            SandboxGateDecision::RequireUnsandboxedApproval {
                warning,
                fallback_command,
                ..
            } => {
                let approved = match approve_unsandboxed {
                    Some(cb) => cb(warning.as_deref()).await,
                    None => false,
                };
                if !approved {
                    let msg = warning
                        .as_deref()
                        .unwrap_or("OS sandbox backend does not enforce filesystem/network scope");
                    return SandboxExecutionResult {
                        stdout: String::new(),
                        stderr: format!("Refusing to run: {msg} (declined)."),
                        exit_code: 1,
                        error_code: Some(SandboxErrorCode::SandboxRequired),
                        sandbox: SandboxType::None,
                        unsandboxed: false,
                        sandbox_warning: warning,
                        denial: None,
                        escalation: None,
                    };
                }
                (
                    fallback_command.file,
                    fallback_command.args,
                    fallback_command.env,
                    fallback_command.sandbox,
                    true,
                    warning,
                )
            }
            SandboxGateDecision::RunUnsandboxed { warning } => (
                req.command.file.clone(),
                req.command.args.clone(),
                HashMap::new(),
                SandboxType::None,
                true,
                warning,
            ),
            SandboxGateDecision::RunSandboxed(transformed) => (
                transformed.file,
                transformed.args,
                transformed.env,
                transformed.sandbox,
                transformed.unsandboxed,
                None,
            ),
        };

        let child_env_src = req.child_env_source.as_ref().unwrap_or(env_src);
        let mut child_env = if unsandboxed && req.yolo {
            let mut full = child_env_src.clone();
            remove_env(&mut full, PARENT_MANAGED_ENV_VAR, platform);
            full
        } else {
            let allowlisted = minimal_sandbox_env(child_env_src, platform);
            normalize_sandbox_child_env(&allowlisted, &req.policy, Some(platform))
        };
        for (k, v) in &req.extra_env {
            if !k.eq_ignore_ascii_case(PARENT_MANAGED_ENV_VAR) {
                child_env.insert(k.clone(), v.clone());
            }
        }
        for (k, v) in sandbox_env {
            child_env.insert(k, v);
        }
        remove_env(&mut child_env, PARENT_MANAGED_ENV_VAR, platform);

        let raw = spawn_isolated_process_group(
            &exec_file,
            &exec_args,
            &req.cwd,
            &child_env,
            req.timeout,
            req.max_buffer,
            cancel_rx,
        )
        .await;

        let combined = if raw.stdout.is_empty() {
            raw.stderr.clone()
        } else if raw.stderr.is_empty() {
            raw.stdout.clone()
        } else {
            format!("{}\n{}", raw.stderr, raw.stdout)
        };

        let denial =
            if !unsandboxed && sandbox_used != SandboxType::None && raw.error_code.is_none() {
                classify_sandbox_denial_detailed(
                    &combined,
                    raw.exit_code,
                    ClassifyDenialOptions {
                        network_restricted: !policy_allows_network(&req.policy),
                        platform: Some(platform),
                    },
                )
            } else {
                None
            };

        let escalation = if raw.error_code.is_none() {
            plan_sandbox_escalation(
                &req.policy,
                sandbox_used,
                unsandboxed,
                req.has_scoped_target_paths,
                &raw.stdout,
                &raw.stderr,
                raw.exit_code,
                Some(platform),
            )
        } else {
            None
        };

        SandboxExecutionResult {
            stdout: raw.stdout,
            stderr: raw.stderr,
            exit_code: raw.exit_code,
            error_code: raw.error_code,
            sandbox: sandbox_used,
            unsandboxed,
            sandbox_warning: warning,
            denial,
            escalation,
        }
    }
}

struct RawProcessOutcome {
    stdout: String,
    stderr: String,
    exit_code: i32,
    error_code: Option<SandboxErrorCode>,
}

async fn spawn_isolated_process_group(
    file: &str,
    args: &[String],
    cwd: &Path,
    env: &HashMap<String, String>,
    timeout: Option<Duration>,
    max_buffer: usize,
    mut cancel_rx: Option<watch::Receiver<bool>>,
) -> RawProcessOutcome {
    let mut cmd = TokioCommand::new(file);
    cmd.args(args)
        .current_dir(cwd)
        .env_clear()
        .envs(env)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    #[cfg(unix)]
    {
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    // TS `proc.run`: an already-aborted signal returns ABORT_ERR without spawning anything.
    if cancel_rx.as_ref().is_some_and(|rx| *rx.borrow()) {
        return RawProcessOutcome {
            stdout: String::new(),
            stderr: String::new(),
            exit_code: 130,
            error_code: Some(SandboxErrorCode::AbortErr),
        };
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(err) => {
            let code = if err.kind() == std::io::ErrorKind::NotFound {
                127
            } else if err.kind() == std::io::ErrorKind::PermissionDenied {
                126
            } else {
                1
            };
            return RawProcessOutcome {
                stdout: String::new(),
                stderr: err.to_string(),
                exit_code: code,
                error_code: None,
            };
        }
    };

    let mut tree = ProcessTree::attach(&child);
    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();

    // Output accumulates in shared buffers so a forced stop can still return whatever was read
    // before the readers were aborted.
    let out_buf = Arc::new(Mutex::new(Vec::new()));
    let err_buf = Arc::new(Mutex::new(Vec::new()));
    let overflow = Arc::new(OverflowSignal::default());
    let mut out_task = tokio::spawn(read_capped(
        stdout_pipe,
        max_buffer,
        Arc::clone(&out_buf),
        Arc::clone(&overflow),
    ));
    let mut err_task = tokio::spawn(read_capped(
        stderr_pipe,
        max_buffer,
        Arc::clone(&err_buf),
        Arc::clone(&overflow),
    ));

    enum WaitOutcome {
        Completed(std::io::Result<std::process::ExitStatus>),
        TimedOut,
        Cancelled,
        Overflowed,
    }

    let wait_outcome = {
        // Completion means the root exited AND both pipes reached EOF. A background child that
        // inherited stdout/stderr (`sleep 600 &`) keeps the pipes open after the root exits, so
        // the drain must stay inside the timeout/cancellation race or it can block forever.
        let completion_fut = async {
            let status = child.wait().await;
            join_reader(&mut out_task).await;
            join_reader(&mut err_task).await;
            status
        };
        tokio::pin!(completion_fut);

        let timeout_fut = async {
            match timeout {
                Some(dur) => tokio::time::sleep(dur).await,
                None => std::future::pending::<()>().await,
            }
        };
        tokio::pin!(timeout_fut);

        let cancel_fut = async {
            match cancel_rx.as_mut() {
                Some(rx) => {
                    if *rx.borrow() {
                        return;
                    }
                    while rx.changed().await.is_ok() {
                        if *rx.borrow() {
                            return;
                        }
                    }
                    std::future::pending::<()>().await
                }
                None => std::future::pending::<()>().await,
            }
        };
        tokio::pin!(cancel_fut);

        tokio::select! {
            status = &mut completion_fut => WaitOutcome::Completed(status),
            () = &mut timeout_fut => WaitOutcome::TimedOut,
            () = &mut cancel_fut => WaitOutcome::Cancelled,
            () = overflow.notify.notified() => WaitOutcome::Overflowed,
        }
    };

    // Like TS `terminate("overflow")`, an overflow wins even when the root exited on its own
    // (e.g. SIGPIPE after the reader stopped) before the overflow branch was observed.
    let wait_outcome = if overflow.tripped() && !matches!(wait_outcome, WaitOutcome::Overflowed) {
        if matches!(wait_outcome, WaitOutcome::Completed(_)) {
            // Root reaped and pipes drained: only stragglers in the tree can remain.
            tree.kill(&mut child).await;
            tree.disarm();
            return finish_outcome(
                &out_buf,
                &err_buf,
                &overflow,
                1,
                Some(SandboxErrorCode::MaxBufferExceeded),
            );
        }
        WaitOutcome::Overflowed
    } else {
        wait_outcome
    };

    let (exit_code, error_code) = match wait_outcome {
        WaitOutcome::Completed(status_res) => {
            tree.disarm();
            let exit_code = match status_res {
                Ok(status) => extract_exit_code(status),
                Err(_) => 1,
            };
            (exit_code, None)
        }
        forced => {
            // Kill the whole tree: the root may already have exited while a background
            // descendant still holds the output pipes.
            tree.kill(&mut child).await;
            tree.disarm();
            let _ = child.wait().await;
            // Give the readers a brief window to collect output flushed before the kill, then
            // stop waiting on any pipe holder that escaped the process group.
            let drained = tokio::time::timeout(KILLED_PIPE_DRAIN_GRACE, async {
                join_reader(&mut out_task).await;
                join_reader(&mut err_task).await;
            })
            .await;
            if drained.is_err() {
                out_task.abort();
                err_task.abort();
            }
            match forced {
                WaitOutcome::TimedOut => (124, Some(SandboxErrorCode::Timeout)),
                WaitOutcome::Overflowed => (1, Some(SandboxErrorCode::MaxBufferExceeded)),
                _ => (130, Some(SandboxErrorCode::AbortErr)),
            }
        }
    };

    finish_outcome(&out_buf, &err_buf, &overflow, exit_code, error_code)
}

fn finish_outcome(
    out_buf: &Mutex<Vec<u8>>,
    err_buf: &Mutex<Vec<u8>>,
    overflow: &OverflowSignal,
    exit_code: i32,
    error_code: Option<SandboxErrorCode>,
) -> RawProcessOutcome {
    // TS truncation is code-point safe: a code point split by the byte cap is dropped whole.
    let capped = overflow.tripped();
    let stdout = take_buffer(out_buf, capped);
    let mut stderr = take_buffer(err_buf, capped);
    if error_code == Some(SandboxErrorCode::Timeout) && stderr.is_empty() {
        stderr = "Command timed out".to_owned();
    }
    RawProcessOutcome {
        stdout,
        stderr,
        exit_code,
        error_code,
    }
}

/// How long readers may keep draining after a timeout/cancel/overflow kill before they are
/// aborted.
const KILLED_PIPE_DRAIN_GRACE: Duration = Duration::from_millis(500);

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Awaits a reader task unless its result was already consumed. A `JoinHandle` panics when
/// polled again after completion, and the completion future may have joined one reader before
/// a timeout/cancel/overflow branch won the race.
async fn join_reader(task: &mut tokio::task::JoinHandle<()>) {
    if !task.is_finished() {
        let _ = task.await;
    }
}

/// Set by a reader whose stream exceeded `max_buffer` (TS `terminate("overflow")`).
#[derive(Default)]
struct OverflowSignal {
    hit: AtomicBool,
    notify: tokio::sync::Notify,
}

impl OverflowSignal {
    fn trip(&self) {
        self.hit.store(true, Ordering::SeqCst);
        // `notify_one` stores a permit, so the wake-up survives even if the select has not
        // polled its `notified()` branch yet.
        self.notify.notify_one();
    }

    fn tripped(&self) -> bool {
        self.hit.load(Ordering::SeqCst)
    }
}

fn take_buffer(buf: &Mutex<Vec<u8>>, capped: bool) -> String {
    let mut bytes = std::mem::take(&mut *buf.lock().unwrap_or_else(|e| e.into_inner()));
    if capped {
        trim_incomplete_utf8_tail(&mut bytes);
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

/// Drops a trailing UTF-8 sequence cut short by the byte cap (so it does not decode to U+FFFD).
fn trim_incomplete_utf8_tail(bytes: &mut Vec<u8>) {
    let tail_start = bytes.len().saturating_sub(3);
    for start in (tail_start..bytes.len()).rev() {
        let lead = bytes[start];
        if lead & 0b1100_0000 == 0b1000_0000 {
            continue; // continuation byte: keep looking for the lead byte
        }
        let needed = match lead {
            0xC0..=0xDF => 2,
            0xE0..=0xEF => 3,
            0xF0..=0xF7 => 4,
            _ => return,
        };
        if bytes.len() - start < needed && std::str::from_utf8(&bytes[start..]).is_err() {
            bytes.truncate(start);
        }
        return;
    }
}

async fn read_capped<R: tokio::io::AsyncRead + Unpin>(
    reader: Option<R>,
    max_bytes: usize,
    buf: Arc<Mutex<Vec<u8>>>,
    overflow: Arc<OverflowSignal>,
) {
    let Some(mut r) = reader else {
        return;
    };
    let mut chunk = [0u8; 8192];
    while let Ok(n) = r.read(&mut chunk).await {
        if n == 0 {
            break;
        }
        let mut guard = buf.lock().unwrap_or_else(|e| e.into_inner());
        let remaining = max_bytes.saturating_sub(guard.len());
        if n > remaining {
            // Keep the captured prefix, then stop reading: dropping the pipe also makes further
            // writes fail while the runner kills the tree.
            guard.extend_from_slice(&chunk[..remaining]);
            drop(guard);
            overflow.trip();
            return;
        }
        guard.extend_from_slice(&chunk[..n]);
    }
}

/// Tree-kill handle for a spawned child: the dedicated POSIX process group (`kill(-pgid)`), or on
/// Windows a Job Object the child is assigned to right after spawn (`TerminateJobObject`), falling
/// back to `taskkill /PID <pid> /T /F` (TS `processTree.killTree`) when no job could be attached.
///
/// While armed, dropping the handle (the run future was abandoned) also kills the tree.
struct ProcessTree {
    pid: Option<u32>,
    armed: bool,
    #[cfg(windows)]
    job: Option<win_job::Job>,
}

impl ProcessTree {
    fn attach(child: &tokio::process::Child) -> Self {
        Self {
            pid: child.id(),
            armed: true,
            #[cfg(windows)]
            job: child.raw_handle().and_then(win_job::Job::assign),
        }
    }

    /// Kills every process in the tree, then the root itself.
    async fn kill(&mut self, child: &mut tokio::process::Child) {
        #[cfg(unix)]
        kill_process_group(self.pid);
        #[cfg(windows)]
        {
            let job_killed = self.job.as_ref().is_some_and(win_job::Job::terminate);
            if !job_killed && let Some(pid) = self.pid {
                taskkill_tree(pid).await;
            }
        }
        let _ = child.kill().await;
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for ProcessTree {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        #[cfg(unix)]
        kill_process_group(self.pid);
        #[cfg(windows)]
        if let Some(job) = &self.job {
            job.terminate();
        }
    }
}

/// `taskkill /PID <pid> /T /F`: the TS `killTree` win32 path, used when the child could not be
/// placed in a Job Object.
#[cfg(windows)]
async fn taskkill_tree(pid: u32) {
    let mut cmd = TokioCommand::new("taskkill");
    cmd.args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .kill_on_drop(true);
    let _ = tokio::time::timeout(Duration::from_secs(10), cmd.status()).await;
}

#[cfg(windows)]
mod win_job {
    use std::os::windows::io::RawHandle;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, TerminateJobObject,
    };

    /// Anonymous Job Object holding one child and every descendant it spawns. Deliberately NOT
    /// kill-on-close: a command that exits normally may leave detached background work running
    /// (`Start-Process`), matching TS and the POSIX process-group behavior. Timeout, cancel,
    /// overflow and abandonment terminate the job explicitly.
    pub(super) struct Job(HANDLE);

    // SAFETY: a Job Object handle is a process-wide kernel handle usable from any thread.
    unsafe impl Send for Job {}
    // SAFETY: `TerminateJobObject`/`CloseHandle` are thread-safe on a valid handle.
    unsafe impl Sync for Job {}

    impl Job {
        pub(super) fn assign(process: RawHandle) -> Option<Self> {
            // SAFETY: null attributes/name create an unnamed job with default security.
            let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if job.is_null() {
                return None;
            }
            let job = Self(job);
            // SAFETY: both handles are valid; `process` is the live child's process handle.
            if unsafe { AssignProcessToJobObject(job.0, process as HANDLE) } == 0 {
                return None;
            }
            Some(job)
        }

        pub(super) fn terminate(&self) -> bool {
            // SAFETY: `self.0` is a valid job handle owned by `self`.
            unsafe { TerminateJobObject(self.0, 1) != 0 }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            // SAFETY: `self.0` is a valid handle owned exclusively by `self`.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

pub(crate) fn kill_process_group(pid: Option<u32>) {
    #[cfg(unix)]
    if let Some(pid) = pid
        && pid > 1
    {
        // SAFETY: Child was spawned with `process_group(0)`, making `pid` its own process group leader.
        unsafe {
            let _ = libc::kill(-(pid as libc::pid_t), libc::SIGKILL);
        }
    }
    #[cfg(not(unix))]
    let _ = pid;
}

pub(crate) fn extract_exit_code(status: std::process::ExitStatus) -> i32 {
    if let Some(code) = status.code() {
        return code;
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(sig) = status.signal() {
            return 128 + sig;
        }
    }
    1
}
