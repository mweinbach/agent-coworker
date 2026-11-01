use std::collections::HashMap;
use std::path::{Path, PathBuf};
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
    pub env_source: Option<HashMap<String, String>>,
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

        let mut child_env = if unsandboxed && req.yolo {
            let mut full = env_src.clone();
            remove_env(&mut full, PARENT_MANAGED_ENV_VAR, platform);
            full
        } else {
            let allowlisted = minimal_sandbox_env(env_src, platform);
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
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
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

    let pid = child.id();
    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();

    // Output accumulates in shared buffers so a forced stop can still return whatever was read
    // before the readers were aborted.
    let out_buf = Arc::new(Mutex::new(Vec::new()));
    let err_buf = Arc::new(Mutex::new(Vec::new()));
    let mut out_task = tokio::spawn(read_capped(stdout_pipe, max_buffer, Arc::clone(&out_buf)));
    let mut err_task = tokio::spawn(read_capped(stderr_pipe, max_buffer, Arc::clone(&err_buf)));

    enum WaitOutcome {
        Completed(std::io::Result<std::process::ExitStatus>),
        TimedOut,
        Cancelled,
    }

    let wait_outcome = {
        // Completion means the root exited AND both pipes reached EOF. A background child that
        // inherited stdout/stderr (`sleep 600 &`) keeps the pipes open after the root exits, so
        // the drain must stay inside the timeout/cancellation race or it can block forever.
        let completion_fut = async {
            let status = child.wait().await;
            let _ = (&mut out_task).await;
            let _ = (&mut err_task).await;
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
        }
    };

    let timed_out = matches!(wait_outcome, WaitOutcome::TimedOut);
    let (exit_code, error_code) = match wait_outcome {
        WaitOutcome::Completed(status_res) => {
            let exit_code = match status_res {
                Ok(status) => extract_exit_code(status),
                Err(_) => 1,
            };
            (exit_code, None)
        }
        WaitOutcome::TimedOut | WaitOutcome::Cancelled => {
            // Kill the whole group: the root may already have exited while a background
            // descendant still holds the output pipes.
            kill_process_group(pid);
            let _ = child.kill().await;
            let _ = child.wait().await;
            // Give the readers a brief window to collect output flushed before the kill, then
            // stop waiting on any pipe holder that escaped the process group.
            let drained = tokio::time::timeout(KILLED_PIPE_DRAIN_GRACE, async {
                let _ = (&mut out_task).await;
                let _ = (&mut err_task).await;
            })
            .await;
            if drained.is_err() {
                out_task.abort();
                err_task.abort();
            }
            if timed_out {
                (124, Some(SandboxErrorCode::Timeout))
            } else {
                (130, Some(SandboxErrorCode::AbortErr))
            }
        }
    };

    let stdout = take_buffer(&out_buf);
    let mut stderr = take_buffer(&err_buf);
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

/// How long readers may keep draining after a timeout/cancel kill before they are aborted.
const KILLED_PIPE_DRAIN_GRACE: Duration = Duration::from_millis(500);

fn take_buffer(buf: &Mutex<Vec<u8>>) -> String {
    let bytes = std::mem::take(&mut *buf.lock().unwrap_or_else(|e| e.into_inner()));
    String::from_utf8_lossy(&bytes).into_owned()
}

async fn read_capped<R: tokio::io::AsyncRead + Unpin>(
    reader: Option<R>,
    max_bytes: usize,
    buf: Arc<Mutex<Vec<u8>>>,
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
        if guard.len() < max_bytes {
            let remaining = max_bytes - guard.len();
            guard.extend_from_slice(&chunk[..n.min(remaining)]);
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
