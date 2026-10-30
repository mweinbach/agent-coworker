use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use cowork_config::{SandboxConfig, SandboxMode as ConfigSandboxMode, canonicalize_sync};

use crate::env_utils::{
    PARENT_MANAGED_ENV_VAR, host_platform, minimal_sandbox_env, remove_env, sanitized_process_env,
};
use crate::manager::{SandboxGateDecision, SandboxManager, TransformOptions};
use crate::policy::{ResolveSandboxPolicyInput, SandboxPolicy, normalize_sandbox_child_env};
use crate::runner::{
    SandboxExecutionRequest, SandboxExecutionResult, SandboxRunner, extract_exit_code,
    kill_process_group,
};
use crate::{SandboxCommand, SandboxType};

/// Parsed options for cross-platform `cowork-server __sandbox-exec` wrapper mode.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunSandboxExecOptions {
    pub policy_json: Option<String>,
    pub mode: Option<String>,
    pub cwd: Option<PathBuf>,
    pub project_root: Option<PathBuf>,
    pub output_dir: Option<PathBuf>,
    pub uploads_dir: Option<PathBuf>,
    pub writable_roots: Vec<PathBuf>,
    pub target_paths: Vec<String>,
    pub read_only_role: bool,
    pub network: Option<bool>,
    pub yolo: bool,
    pub require_backend: bool,
    pub timeout_ms: Option<u64>,
    pub json_result: bool,
    pub command: Vec<String>,
}

/// Parsed representation of `cowork-server __sandbox-exec ...` CLI arguments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParsedSandboxExecArgs {
    /// Internal Linux stage executed inside `bwrap` to install the native Rust seccomp-BPF filter
    /// and `execvp` the target command without Python.
    LinuxSeccomp {
        deny_network: bool,
        command: Vec<String>,
    },
    /// Cross-platform OS sandbox wrapper mode.
    Run(Box<RunSandboxExecOptions>),
}

/// Parses arguments passed after `cowork-server __sandbox-exec`.
pub fn parse_sandbox_exec_args(args: &[String]) -> Result<ParsedSandboxExecArgs, String> {
    let mut linux_seccomp = false;
    let mut deny_network = false;
    let mut policy_json: Option<String> = None;
    let mut mode: Option<String> = None;
    let mut cwd: Option<PathBuf> = None;
    let mut project_root: Option<PathBuf> = None;
    let mut output_dir: Option<PathBuf> = None;
    let mut uploads_dir: Option<PathBuf> = None;
    let mut writable_roots: Vec<PathBuf> = Vec::new();
    let mut target_paths: Vec<String> = Vec::new();
    let mut read_only_role = false;
    let mut network: Option<bool> = None;
    let mut yolo = false;
    let mut require_backend = false;
    let mut timeout_ms: Option<u64> = None;
    let mut json_result = false;

    let mut idx = 0;
    let mut command_start: Option<usize> = None;

    while idx < args.len() {
        let token = args[idx].as_str();
        if token == "--" {
            command_start = Some(idx + 1);
            break;
        }
        if !token.starts_with('-') || token == "-" {
            command_start = Some(idx);
            break;
        }

        let (flag, inline_val) = match token.split_once('=') {
            Some((k, v)) => (k, Some(v)),
            None => (token, None),
        };

        let mut next_val = |flag_name: &str| -> Result<String, String> {
            if let Some(v) = inline_val {
                return Ok(v.to_owned());
            }
            idx += 1;
            args.get(idx)
                .cloned()
                .ok_or_else(|| format!("missing value for {flag_name}"))
        };

        match flag {
            "--linux-seccomp" => linux_seccomp = true,
            "--deny-network" => deny_network = true,
            "--policy-json" => policy_json = Some(next_val(flag)?),
            "--mode" => mode = Some(next_val(flag)?),
            "--cwd" => cwd = Some(PathBuf::from(next_val(flag)?)),
            "--project-root" => project_root = Some(PathBuf::from(next_val(flag)?)),
            "--output-dir" => output_dir = Some(PathBuf::from(next_val(flag)?)),
            "--uploads-dir" => uploads_dir = Some(PathBuf::from(next_val(flag)?)),
            "--writable-root" => writable_roots.push(PathBuf::from(next_val(flag)?)),
            "--target-path" => target_paths.push(next_val(flag)?),
            "--read-only-role" => read_only_role = true,
            "--allow-network" => network = Some(true),
            "--no-network" => {
                network = Some(false);
                deny_network = true;
            }
            "--network" => {
                let raw = next_val(flag)?;
                match raw.trim().to_ascii_lowercase().as_str() {
                    "true" | "1" | "yes" => network = Some(true),
                    "false" | "0" | "no" => {
                        network = Some(false);
                        deny_network = true;
                    }
                    other => {
                        return Err(format!(
                            "invalid --network value \"{other}\" (expected true or false)"
                        ));
                    }
                }
            }
            "--yolo" => yolo = true,
            "--require-backend" => require_backend = true,
            "--timeout-ms" => {
                let raw = next_val(flag)?;
                let parsed = raw
                    .parse::<u64>()
                    .map_err(|_| format!("invalid --timeout-ms value \"{raw}\""))?;
                timeout_ms = Some(parsed);
            }
            "--json-result" => json_result = true,
            other => return Err(format!("unknown __sandbox-exec flag: {other}")),
        }

        idx += 1;
    }

    let command: Vec<String> = match command_start {
        Some(start) if start < args.len() => args[start..].to_vec(),
        _ => return Err("missing target command for __sandbox-exec".to_owned()),
    };

    if linux_seccomp {
        return Ok(ParsedSandboxExecArgs::LinuxSeccomp {
            deny_network,
            command,
        });
    }

    Ok(ParsedSandboxExecArgs::Run(Box::new(
        RunSandboxExecOptions {
            policy_json,
            mode,
            cwd,
            project_root,
            output_dir,
            uploads_dir,
            writable_roots,
            target_paths,
            read_only_role,
            network,
            yolo,
            require_backend,
            timeout_ms,
            json_result,
            command,
        },
    )))
}

/// Resolves the `SandboxPolicy` and working directory from `ParsedSandboxExecArgs::Run`.
pub fn resolve_cli_run_policy(
    parsed: &ParsedSandboxExecArgs,
) -> Result<(SandboxPolicy, PathBuf, bool, bool, bool), String> {
    let ParsedSandboxExecArgs::Run(opts) = parsed else {
        return Err("expected Run variant".to_owned());
    };
    let RunSandboxExecOptions {
        policy_json,
        mode,
        cwd,
        project_root,
        output_dir,
        uploads_dir,
        writable_roots,
        target_paths,
        read_only_role,
        network,
        yolo,
        require_backend,
        ..
    } = opts.as_ref();

    let raw_cwd = match cwd {
        Some(dir) => {
            if dir.is_absolute() {
                dir.clone()
            } else {
                std::env::current_dir()
                    .unwrap_or_else(|_| PathBuf::from("."))
                    .join(dir)
            }
        }
        None => std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
    };
    let effective_cwd = canonicalize_sync(&raw_cwd);
    let has_scoped_targets = !target_paths.is_empty();

    if let Some(json_str) = policy_json {
        let policy: SandboxPolicy = serde_json::from_str(json_str)
            .map_err(|e| format!("invalid --policy-json payload: {e}"))?;
        return Ok((
            policy,
            effective_cwd,
            *yolo,
            *require_backend,
            has_scoped_targets,
        ));
    }

    let net_bool = network.unwrap_or(true);
    if mode.as_deref() == Some("no-project-write") {
        let mut input = ResolveSandboxPolicyInput::new(&effective_cwd);
        input.project_root = project_root.clone();
        input.output_directory = output_dir.clone();
        input.uploads_directory = uploads_dir.clone();
        input.read_only_role = true;
        input.yolo = *yolo;
        input.config = Some(SandboxConfig {
            mode: ConfigSandboxMode::WorkspaceWrite,
            network: net_bool,
            require_backend: *require_backend,
        });
        let policy = crate::policy::resolve_sandbox_policy(&input);
        return Ok((
            policy,
            effective_cwd,
            *yolo,
            *require_backend,
            has_scoped_targets,
        ));
    }

    let cfg_mode = match mode.as_deref() {
        None | Some("auto") => ConfigSandboxMode::Auto,
        Some("read-only") => ConfigSandboxMode::ReadOnly,
        Some("workspace-write") => ConfigSandboxMode::WorkspaceWrite,
        Some("danger-full-access") => ConfigSandboxMode::DangerFullAccess,
        Some(other) => {
            return Err(format!(
                "invalid --mode \"{other}\" (expected auto, read-only, no-project-write, workspace-write, or danger-full-access)"
            ));
        }
    };

    let mut input = ResolveSandboxPolicyInput::new(&effective_cwd);
    input.project_root = project_root.clone();
    input.output_directory = output_dir.clone();
    input.uploads_directory = uploads_dir.clone();
    input.tool_runtime_writable_roots = writable_roots.clone();
    input.target_paths = if has_scoped_targets {
        Some(target_paths.clone())
    } else {
        None
    };
    input.read_only_role = *read_only_role;
    input.yolo = *yolo;
    input.config = Some(SandboxConfig {
        mode: cfg_mode,
        network: net_bool,
        require_backend: *require_backend,
    });

    let policy = crate::policy::resolve_sandbox_policy(&input);
    Ok((
        policy,
        effective_cwd,
        *yolo,
        *require_backend,
        has_scoped_targets,
    ))
}

/// Executes `cowork-server __sandbox-exec ...` synchronously on the main thread before Tokio starts,
/// returning the process exit code.
pub fn run_sandbox_exec_cli(args: &[String]) -> i32 {
    let parsed = match parse_sandbox_exec_args(args) {
        Ok(p) => p,
        Err(err) => {
            let _ = writeln!(std::io::stderr(), "cowork-server __sandbox-exec: {err}");
            return 125;
        }
    };

    match &parsed {
        ParsedSandboxExecArgs::LinuxSeccomp {
            deny_network,
            command,
        } => exec_linux_seccomp_stage(*deny_network, command),
        ParsedSandboxExecArgs::Run(run_opts) => {
            let RunSandboxExecOptions {
                timeout_ms,
                json_result,
                command,
                ..
            } = run_opts.as_ref();
            let (policy, cwd, yolo, require_backend, has_scoped_targets) =
                match resolve_cli_run_policy(&parsed) {
                    Ok(v) => v,
                    Err(err) => {
                        let _ = writeln!(std::io::stderr(), "cowork-server __sandbox-exec: {err}");
                        return 125;
                    }
                };

            let inner = SandboxCommand {
                file: command[0].clone(),
                args: command[1..].to_vec(),
            };

            if *json_result {
                let Ok(rt) = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                else {
                    let _ = writeln!(
                        std::io::stderr(),
                        "cowork-server __sandbox-exec: failed to initialize runtime"
                    );
                    return 125;
                };
                let runner = SandboxRunner::default();
                let mut req = SandboxExecutionRequest::new(inner, policy, cwd);
                req.yolo = yolo;
                req.require_backend = require_backend;
                req.has_scoped_target_paths = has_scoped_targets;
                req.timeout = timeout_ms.map(Duration::from_millis);
                let res: SandboxExecutionResult = rt.block_on(runner.run_with_approval(
                    req,
                    None,
                    None::<fn(Option<&str>) -> std::future::Ready<bool>>,
                ));
                if let Ok(json_line) = serde_json::to_string(&res) {
                    let mut out = std::io::stdout().lock();
                    let _ = writeln!(out, "{json_line}");
                    let _ = out.flush();
                }
                return res.exit_code;
            }

            run_transparent_cli_command(
                &inner,
                &policy,
                &cwd,
                yolo,
                require_backend,
                has_scoped_targets,
                timeout_ms.map(Duration::from_millis),
            )
        }
    }
}

fn run_transparent_cli_command(
    inner: &SandboxCommand,
    policy: &SandboxPolicy,
    cwd: &PathBuf,
    yolo: bool,
    require_backend: bool,
    has_scoped_targets: bool,
    timeout: Option<Duration>,
) -> i32 {
    let platform = host_platform();
    let env_src = sanitized_process_env();
    let manager = SandboxManager::new();
    let decision = manager.evaluate_gate(
        inner,
        policy,
        cwd,
        yolo,
        require_backend,
        has_scoped_targets,
        TransformOptions {
            platform: Some(platform),
            capabilities: None,
            sandbox_exec_path: None,
            env_source: Some(&env_src),
        },
    );

    let (exec_file, exec_args, sandbox_env, unsandboxed) = match decision {
        SandboxGateDecision::Deny { stderr, .. } => {
            let _ = writeln!(std::io::stderr(), "SANDBOX_REQUIRED: {stderr}");
            return 125;
        }
        SandboxGateDecision::RequireUnsandboxedApproval { warning, .. } => {
            let detail = warning
                .as_deref()
                .unwrap_or("OS sandbox backend does not enforce filesystem/network scope");
            let _ = writeln!(
                std::io::stderr(),
                "SANDBOX_REQUIRED: Refusing to run unsandboxed without interactive approval ({detail})."
            );
            return 125;
        }
        SandboxGateDecision::RunUnsandboxed { .. } => {
            (inner.file.clone(), inner.args.clone(), HashMap::new(), true)
        }
        SandboxGateDecision::RunSandboxed(t) => {
            debug_assert_ne!(t.sandbox, SandboxType::None);
            (t.file, t.args, t.env, t.unsandboxed)
        }
    };

    let mut child_env = if unsandboxed && yolo {
        env_src
    } else {
        let allowlisted = minimal_sandbox_env(&env_src, platform);
        normalize_sandbox_child_env(&allowlisted, policy, Some(platform))
    };
    for (k, v) in sandbox_env {
        child_env.insert(k, v);
    }
    remove_env(&mut child_env, PARENT_MANAGED_ENV_VAR, platform);

    let mut cmd = Command::new(&exec_file);
    cmd.args(&exec_args)
        .current_dir(cwd)
        .env_clear()
        .envs(&child_env)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(err) => {
            let _ = writeln!(std::io::stderr(), "{exec_file}: {err}");
            return if err.kind() == std::io::ErrorKind::NotFound {
                127
            } else if err.kind() == std::io::ErrorKind::PermissionDenied {
                126
            } else {
                125
            };
        }
    };

    let pid = Some(child.id());
    match timeout {
        None => match child.wait() {
            Ok(status) => extract_exit_code(status),
            Err(_) => 1,
        },
        Some(dur) => {
            let deadline = Instant::now() + dur;
            loop {
                match child.try_wait() {
                    Ok(Some(status)) => return extract_exit_code(status),
                    Ok(None) => {
                        if Instant::now() >= deadline {
                            kill_process_group(pid);
                            let _ = child.kill();
                            let _ = child.wait();
                            let _ = writeln!(std::io::stderr(), "Command timed out");
                            return 124;
                        }
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    Err(_) => {
                        kill_process_group(pid);
                        let _ = child.kill();
                        let _ = child.wait();
                        return 1;
                    }
                }
            }
        }
    }
}

#[cfg(target_os = "linux")]
fn exec_linux_seccomp_stage(deny_network: bool, command: &[String]) -> i32 {
    use std::os::unix::process::CommandExt;

    if let Err(err) = crate::linux_seccomp::apply_linux_seccomp_filter(deny_network) {
        let _ = writeln!(
            std::io::stderr(),
            "Linux sandbox socket mediation failed: {err}"
        );
        return 125;
    }

    let err = Command::new(&command[0]).args(&command[1..]).exec();
    let _ = writeln!(std::io::stderr(), "{}: {err}", command[0]);
    if err.kind() == std::io::ErrorKind::NotFound {
        127
    } else if err.kind() == std::io::ErrorKind::PermissionDenied {
        126
    } else {
        125
    }
}

#[cfg(not(target_os = "linux"))]
fn exec_linux_seccomp_stage(_deny_network: bool, _command: &[String]) -> i32 {
    let _ = writeln!(
        std::io::stderr(),
        "Linux sandbox socket mediation failed: seccomp-BPF is only supported on Linux"
    );
    125
}
