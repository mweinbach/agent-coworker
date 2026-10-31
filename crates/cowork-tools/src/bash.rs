use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use cowork_env::{ShellEnvOptions, build_canonical_shell_env, build_non_login_shell_plan};
use cowork_sandbox::{
    CommandRiskLevel, ResolveSandboxPolicyInput, SandboxCommand, SandboxDenialCategory,
    SandboxErrorCode, SandboxExecutionRequest, SandboxPolicy, SandboxRunner, SandboxType,
    classify_command_detailed, host_platform, resolve_sandbox_policy,
};
use regex::Regex;
use serde_json::{Map, Value, json};

use crate::context::{
    ApprovalDecisionRequest, BuiltinTool, ToolError, ToolExecutionContext, ToolOutput, ToolResult,
    normalize_and_validate_args,
};

const DEFAULT_TIMEOUT_SECONDS: u64 = 300;
const MAX_TIMEOUT_SECONDS: u64 = 600;
const MAX_BUFFER_BYTES: usize = 10 * 1024 * 1024;

pub struct BashTool;

impl BashTool {
    fn resolve_effective_policy(ctx: &ToolExecutionContext) -> SandboxPolicy {
        let target_strs = ctx.target_paths.as_ref().map(|paths| {
            paths
                .iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect::<Vec<_>>()
        });
        resolve_sandbox_policy(&ResolveSandboxPolicyInput {
            config: Some(ctx.sandbox_config.clone()),
            working_directory: ctx.working_directory.clone(),
            project_root: Some(ctx.working_directory.clone()),
            output_directory: Some(ctx.output_directory.clone()),
            uploads_directory: Some(ctx.uploads_directory.clone()),
            tool_runtime_writable_roots: Vec::new(),
            target_paths: target_strs,
            read_only_role: ctx.read_only_role
                || matches!(ctx.sandbox_policy, SandboxPolicy::ReadOnly { .. }),
            yolo: ctx.yolo,
            platform: None,
        })
    }
}

#[async_trait]
impl BuiltinTool for BashTool {
    fn name(&self) -> &str {
        "bash"
    }

    fn description(&self) -> &str {
        "Execute a shell command inside the native OS sandbox. Prefer dedicated read/write/edit/glob/grep tools for file operations."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "The shell command to execute."
                },
                "timeoutSeconds": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": MAX_TIMEOUT_SECONDS,
                    "description": "Maximum runtime in seconds before the command process group is terminated (default: 300, max: 600)."
                }
            },
            "required": ["command"]
        })
    }

    async fn execute(
        &self,
        mut raw_args: Map<String, Value>,
        ctx: &ToolExecutionContext,
    ) -> ToolResult<ToolOutput> {
        if !raw_args.contains_key("timeoutSeconds")
            && let Some(ms) = raw_args.remove("timeout").and_then(|v| v.as_u64())
        {
            raw_args.insert(
                "timeoutSeconds".to_owned(),
                json!((ms.div_ceil(1000)).clamp(1, MAX_TIMEOUT_SECONDS)),
            );
        }

        let args = normalize_and_validate_args(&self.input_schema(), &raw_args)?;
        let command = args
            .get("command")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidArguments("command is required".to_owned()))?
            .to_owned();
        let timeout_secs = args
            .get("timeoutSeconds")
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_TIMEOUT_SECONDS)
            .min(MAX_TIMEOUT_SECONDS);

        if ctx.is_cancelled() {
            return Ok(ToolOutput::Json(json!({
                "stdout": "",
                "stderr": "Command aborted.",
                "exitCode": 130
            })));
        }

        let policy = Self::resolve_effective_policy(ctx);
        let pre_exec = classify_command_detailed(&command, None, None);
        let matches_explicit_review = {
            static REVIEW_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
            let re = REVIEW_RE.get_or_init(|| {
                Regex::new(
                    r"(?i)\b(?:git\s+push|npm\s+publish|rm|truncate|ch(?:mod|own)\s+-[^\s]*R)\b",
                )
                .expect("valid review regex")
            });
            re.is_match(&command)
        };
        let needs_pre_approval =
            pre_exec.risk_level == CommandRiskLevel::Dangerous || matches_explicit_review;

        if needs_pre_approval && !ctx.yolo {
            let reason_str = if pre_exec.risk_level == CommandRiskLevel::Dangerous {
                "matches_dangerous_pattern"
            } else {
                "requires_manual_review"
            };
            let approved = match &ctx.approval_handler {
                Some(handler) => handler
                    .approve_command(ApprovalDecisionRequest {
                        command: command.clone(),
                        reason: reason_str.to_owned(),
                        category: None,
                        detail: pre_exec.matched_pattern.clone(),
                        cwd: ctx.working_directory.clone(),
                    })
                    .await
                    .map_err(ToolError::Execution)?,
                None => false,
            };
            if !approved {
                return Ok(ToolOutput::Json(json!({
                    "stdout": "",
                    "stderr": "Command was not approved.",
                    "exitCode": 1
                })));
            }
        }

        let platform = host_platform();
        let is_sandboxed = !matches!(policy, SandboxPolicy::DangerFullAccess { .. });
        let shell_env = build_canonical_shell_env(ShellEnvOptions {
            base_env: &ctx.env,
            runtime: None,
            uv_env: None,
            extra_env: None,
            platform,
            sandboxed: is_sandboxed,
            cowork_home: Some(&ctx.cowork_home),
        });
        let plan = build_non_login_shell_plan(&command, &shell_env, platform);
        let is_scoped_child = ctx.target_paths.as_ref().is_some_and(|t| !t.is_empty());

        let runner = SandboxRunner::default();
        let build_req = |pol: SandboxPolicy| SandboxExecutionRequest {
            command: SandboxCommand::new(plan.program.clone(), plan.args.clone()),
            policy: pol,
            cwd: ctx.working_directory.clone(),
            yolo: ctx.yolo,
            require_backend: ctx.sandbox_config.require_backend,
            has_scoped_target_paths: is_scoped_child,
            timeout: Some(Duration::from_secs(timeout_secs)),
            max_buffer: MAX_BUFFER_BYTES,
            env_source: Some(shell_env.clone()),
            extra_env: shell_env.clone(),
            capabilities_override: None,
            sandbox_exec_path: None,
        };

        let make_unsandboxed_cb = || {
            ctx.approval_handler.as_ref().map(|handler| {
                let handler = Arc::clone(handler);
                let cmd = command.clone();
                let cwd = ctx.working_directory.clone();
                move |detail_opt: Option<&str>| {
                    let detail = detail_opt
                        .map(str::to_owned)
                        .unwrap_or_else(|| {
                            "No enforcing OS sandbox is available on this machine, so this command can only run with full filesystem and network access.".to_owned()
                        });
                    async move {
                        handler
                            .approve_command(ApprovalDecisionRequest {
                                command: cmd,
                                reason: "sandbox_denied".to_owned(),
                                category: None,
                                detail: Some(detail),
                                cwd,
                            })
                            .await
                            .unwrap_or(false)
                    }
                }
            })
        };

        let mut run_res = runner
            .run_with_approval(
                build_req(policy.clone()),
                ctx.cancel_rx.clone(),
                make_unsandboxed_cb(),
            )
            .await;

        if let Some(esc) = &run_res.escalation
            && !ctx.yolo
            && let Some(handler) = &ctx.approval_handler
        {
            let category_str = match esc.category {
                SandboxDenialCategory::Network => "network",
                SandboxDenialCategory::Filesystem => "filesystem",
            };
            let approved = handler
                .approve_command(ApprovalDecisionRequest {
                    command: command.clone(),
                    reason: esc.reason.to_owned(),
                    category: Some(category_str.to_owned()),
                    detail: Some(esc.detail.clone()),
                    cwd: ctx.working_directory.clone(),
                })
                .await
                .map_err(ToolError::Execution)?;
            if approved {
                run_res = runner
                    .run_with_approval(
                        build_req(esc.retry_policy.clone()),
                        ctx.cancel_rx.clone(),
                        make_unsandboxed_cb(),
                    )
                    .await;
            }
        }

        let (exit_code, mut stderr) = match run_res.error_code {
            Some(SandboxErrorCode::Timeout) => (
                124,
                format!(
                    "Command timed out after {timeout_secs}s. The child process was terminated."
                ),
            ),
            Some(SandboxErrorCode::AbortErr) => (
                130,
                if run_res.stderr.is_empty() {
                    "Command aborted.".to_owned()
                } else {
                    run_res.stderr.clone()
                },
            ),
            _ => (run_res.exit_code, run_res.stderr.clone()),
        };

        if let Some(warn) = &run_res.sandbox_warning
            && run_res.error_code != Some(SandboxErrorCode::SandboxRequired)
        {
            let notice = if run_res.sandbox == SandboxType::None {
                format!("[sandbox] {warn}; command ran without an OS sandbox.\n")
            } else {
                format!("[sandbox] {warn}\n")
            };
            stderr = format!("{notice}{stderr}");
        }

        Ok(ToolOutput::Json(json!({
            "stdout": run_res.stdout,
            "stderr": stderr,
            "exitCode": exit_code,
        })))
    }
}
