//! Native Rust `claude-sdk` provider transport speaking Claude Code's bidirectional
//! `--input-format stream-json --output-format stream-json` NDJSON stdio protocol.

pub mod installer;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use chrono::Utc;
use cowork_config::{cowork_home, env_map_from_process};
use cowork_inference::{
    CanonicalMessage, ContentBlock, ContinuationFingerprintInput, MediaKind, MediaSource,
    MessageRole, ProviderContinuationState, ProviderOpaqueMeta, ProviderTransportError,
    ReasoningStreamMode, StepBudget, StopReason, StreamEvent, TurnUsage,
    compute_continuation_fingerprint, filter_persisted_assistant_history,
    validate_continuation_state,
};
use serde_json::{Map, Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::codex_app_server::DynamicToolHandler;
use crate::managed_runtime::{kill_managed_process_tree, spawn_managed_stdio_process};
use crate::transport::{
    ProviderStepRequest, ProviderStepResult, ProviderTransport, StreamEventCallback,
    candidate_continuation_splits, request_disables_all_tools,
};

pub use installer::{
    CLAUDE_SDK_MANAGED_VERSION, ClaudeSdkInstallOptions, build_claude_sdk_spawn_env,
    claude_sdk_override_configured, claude_sdk_uses_oauth_token, install_claude_sdk,
    resolve_claude_sdk_home, resolve_claude_sdk_status, update_managed_claude_sdk,
};

/// CLI-precedence inline settings passed to the managed `claude` subprocess so
/// repository/user hooks (`SessionStart`, `PreToolUse`, etc.), custom status lines,
/// file-suggestion commands, and auto-enabled project MCP servers cannot execute
/// outside Cowork's approval/sandbox boundary.
const CLAUDE_SDK_ISOLATED_SETTINGS_JSON: &str =
    r#"{"disableAllHooks":true,"enableAllProjectMcpServers":false}"#;

#[derive(Clone, Default)]
pub struct ClaudeSdkTransport {
    pub command_override: Option<(String, Vec<String>)>,
    pub env_override: Option<HashMap<String, String>>,
    pub tool_handler: Option<Arc<dyn DynamicToolHandler>>,
    pub install_options: Option<ClaudeSdkInstallOptions>,
    pub disable_tools: bool,
}

impl std::fmt::Debug for ClaudeSdkTransport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClaudeSdkTransport")
            .field("command_override", &self.command_override)
            .field("has_env_override", &self.env_override.is_some())
            .field("has_tool_handler", &self.tool_handler.is_some())
            .field("disable_tools", &self.disable_tools)
            .finish()
    }
}

impl ClaudeSdkTransport {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_env(env: HashMap<String, String>) -> Self {
        Self {
            env_override: Some(env),
            ..Self::default()
        }
    }

    pub fn with_env_and_handler(
        env: HashMap<String, String>,
        tool_handler: Option<Arc<dyn DynamicToolHandler>>,
    ) -> Self {
        Self {
            env_override: Some(env),
            tool_handler,
            ..Self::default()
        }
    }

    pub fn with_tools_disabled(mut self, disable_tools: bool) -> Self {
        self.disable_tools = disable_tools;
        self
    }

    pub fn with_command_override(command: String, args: Vec<String>) -> Self {
        Self {
            command_override: Some((command, args)),
            ..Self::default()
        }
    }

    pub fn with_install_options(mut self, opts: ClaudeSdkInstallOptions) -> Self {
        self.install_options = Some(opts);
        self
    }
}

pub(crate) async fn ensure_claude_sdk_runtime_command(
    cowork_home_dir: &Path,
    env: &HashMap<String, String>,
    opts: &ClaudeSdkInstallOptions,
) -> Result<(String, Vec<String>), ProviderTransportError> {
    let status = resolve_claude_sdk_status(cowork_home_dir, env);
    let stale_managed = status.source == "managed" && status.pin_matches_current == Some(false);
    if !status.available || stale_managed {
        match install_claude_sdk(cowork_home_dir, CLAUDE_SDK_MANAGED_VERSION, false, opts).await {
            Ok(installed) => {
                return Ok((installed.command.to_string_lossy().into_owned(), Vec::new()));
            }
            Err(err) if status.available => {
                tracing::warn!(
                    "[claude-sdk] could not update the managed runtime to {CLAUDE_SDK_MANAGED_VERSION}; using installed runtime: {err}"
                );
            }
            Err(err) => {
                return Err(ProviderTransportError::protocol(format!(
                    "Failed to install the Cowork-managed Claude SDK runtime {CLAUDE_SDK_MANAGED_VERSION}: {err}"
                )));
            }
        }
    }
    match status.command {
        Some(command) => Ok((command, status.args.unwrap_or_default())),
        None => Err(ProviderTransportError::protocol(status.message)),
    }
}

fn claude_sdk_effort(provider_options: &Map<String, Value>) -> Option<&'static str> {
    let section = provider_options
        .get("claude-sdk")
        .and_then(Value::as_object);
    let raw = section
        .and_then(|s| s.get("reasoningEffort").or_else(|| s.get("effort")))
        .or_else(|| {
            provider_options
                .get("reasoningEffort")
                .or_else(|| provider_options.get("effort"))
        })
        .and_then(Value::as_str)?
        .trim()
        .to_ascii_lowercase();
    match raw.as_str() {
        "none" | "off" | "dynamic" => None,
        "minimal" | "light" | "low" => Some("low"),
        "medium" => Some("medium"),
        "high" => Some("high"),
        "xhigh" | "max" => Some("max"),
        _ => None,
    }
}

/// Maps a native Claude Code tool name (from `can_use_tool`) to Cowork's canonical built-in tool
/// identifier so profile allowlists (`authorized_tool_names`) apply uniformly.
fn claude_native_tool_canonical_name(tool_name: &str) -> Option<&'static str> {
    let trimmed = tool_name.trim();
    if trimmed.is_empty() {
        return None;
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("mcp__") || lower.starts_with("mcp_") {
        return Some("mcpCall");
    }
    match lower.as_str() {
        "bash" | "shell" => Some("bash"),
        "read" | "ls" | "notebookread" => Some("read"),
        "write" => Some("write"),
        "edit" | "multiedit" | "notebookedit" => Some("edit"),
        "glob" => Some("glob"),
        "grep" => Some("grep"),
        "webfetch" => Some("webFetch"),
        "websearch" => Some("webSearch"),
        "askuserquestion" => Some("AskUserQuestion"),
        "todowrite" | "todoread" => Some("todoWrite"),
        "skill" => Some("skill"),
        "task" | "agent" => Some("spawnAgent"),
        _ => None,
    }
}

/// Known native Claude Code tools checked against `--disallowedTools` for defense-in-depth
/// alongside the authoritative runtime `can_use_tool` allowlist gate.
const CLAUDE_NATIVE_TOOLS: &[&str] = &[
    "Bash",
    "Read",
    "Write",
    "Edit",
    "MultiEdit",
    "NotebookEdit",
    "NotebookRead",
    "Glob",
    "Grep",
    "LS",
    "WebFetch",
    "WebSearch",
    "TodoWrite",
    "Task",
    "Agent",
    "Skill",
    "AskUserQuestion",
];

fn allowlist_contains_tool(allowlist: &[String], candidate: &str) -> bool {
    allowlist
        .iter()
        .any(|allowed| allowed.trim().eq_ignore_ascii_case(candidate))
}

fn claude_disallowed_native_tools(authorized_tool_names: &[String]) -> Vec<&'static str> {
    CLAUDE_NATIVE_TOOLS
        .iter()
        .copied()
        .filter(|&native| {
            let canonical_allowed = claude_native_tool_canonical_name(native)
                .is_some_and(|canon| allowlist_contains_tool(authorized_tool_names, canon));
            let direct_allowed = allowlist_contains_tool(authorized_tool_names, native);
            !(canonical_allowed || direct_allowed)
        })
        .collect()
}

fn claude_tool_is_authorized(
    req_body: &Value,
    tools_disabled: bool,
    authorized_tool_names: Option<&[String]>,
) -> Result<(), String> {
    if tools_disabled {
        return Err("Tools are disabled for this turn.".to_owned());
    }
    let tool_name = req_body
        .get("tool_name")
        .or_else(|| req_body.get("toolName"))
        .or_else(|| req_body.get("name"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Tool execution denied: missing native tool name.".to_owned())?;
    if let Some(input) = req_body.get("input")
        && !input.is_null()
        && !input.is_object()
    {
        return Err(format!(
            "Tool '{tool_name}' execution denied: native tool input must be a JSON object."
        ));
    }
    let Some(allowlist) = authorized_tool_names else {
        return Ok(());
    };
    if allowlist.is_empty() {
        return Err(format!(
            "Tool '{tool_name}' is not allowed by this session's tool policy."
        ));
    }
    let allowed = allowlist_contains_tool(allowlist, tool_name)
        || claude_native_tool_canonical_name(tool_name)
            .is_some_and(|canon| allowlist_contains_tool(allowlist, canon));
    if allowed {
        Ok(())
    } else {
        Err(format!(
            "Tool '{tool_name}' is not allowed by this session's tool policy."
        ))
    }
}

fn push_claude_history_prefix(blocks: &mut Vec<Value>, prior: &[CanonicalMessage]) {
    let mut pending_text = String::new();
    let mut wrote_header = false;
    let mut has_prior_content = false;

    let ensure_header = |buf: &mut String, wrote_header: &mut bool| {
        if !*wrote_header {
            buf.push_str("Prior conversation context:\n");
            *wrote_header = true;
        }
    };

    for msg in prior {
        let role = match msg.role {
            MessageRole::User => "User",
            MessageRole::Assistant => "Assistant",
            MessageRole::Tool => "Tool",
            MessageRole::System | MessageRole::Developer => "System",
        };
        let mut msg_has_prefix = false;
        let mut wrote_text_since_image = false;

        for block in &msg.content {
            match block {
                ContentBlock::Text { text, .. } if !text.trim().is_empty() => {
                    ensure_header(&mut pending_text, &mut wrote_header);
                    if !msg_has_prefix {
                        if has_prior_content && !pending_text.is_empty() {
                            pending_text.push_str("\n\n");
                        }
                        pending_text.push_str(role);
                        pending_text.push_str(": ");
                        msg_has_prefix = true;
                    } else if wrote_text_since_image {
                        pending_text.push('\n');
                    }
                    pending_text.push_str(text.trim());
                    wrote_text_since_image = true;
                    has_prior_content = true;
                }
                ContentBlock::ToolResult {
                    tool_name,
                    content,
                    is_error,
                    ..
                } => {
                    let rendered = serde_json::to_string(content).unwrap_or_default();
                    if !rendered.is_empty() {
                        ensure_header(&mut pending_text, &mut wrote_header);
                        if !msg_has_prefix {
                            if has_prior_content && !pending_text.is_empty() {
                                pending_text.push_str("\n\n");
                            }
                            pending_text.push_str(role);
                            pending_text.push_str(": ");
                            msg_has_prefix = true;
                        } else if wrote_text_since_image {
                            pending_text.push('\n');
                        }
                        pending_text.push_str(&format!(
                            "[tool_result {} (error={})]: {}",
                            tool_name.as_deref().unwrap_or("tool"),
                            is_error,
                            rendered
                        ));
                        wrote_text_since_image = true;
                        has_prior_content = true;
                    }
                }
                ContentBlock::Media {
                    kind: MediaKind::Image,
                    source: MediaSource::Base64 { data, mime_type },
                    ..
                } => {
                    ensure_header(&mut pending_text, &mut wrote_header);
                    if !msg_has_prefix {
                        if has_prior_content && !pending_text.is_empty() {
                            pending_text.push_str("\n\n");
                        }
                        pending_text.push_str(role);
                        pending_text.push(':');
                        msg_has_prefix = true;
                    }
                    if !pending_text.is_empty() {
                        blocks.push(json!({
                            "type": "text",
                            "text": std::mem::take(&mut pending_text),
                        }));
                    }
                    blocks.push(json!({
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": mime_type,
                            "data": data,
                        }
                    }));
                    wrote_text_since_image = false;
                    has_prior_content = true;
                }
                _ => {}
            }
        }
    }

    if has_prior_content {
        if !pending_text.is_empty() {
            pending_text.push_str("\n\n");
        }
        pending_text.push_str("Latest user message:");
        blocks.push(json!({
            "type": "text",
            "text": pending_text,
        }));
    }
}

fn build_claude_user_content(messages: &[CanonicalMessage], include_history: bool) -> Vec<Value> {
    let mut blocks = Vec::new();
    if include_history && messages.len() > 1 {
        push_claude_history_prefix(&mut blocks, &messages[..messages.len() - 1]);
    }

    let tail: &[CanonicalMessage] = if include_history {
        messages.last().map(std::slice::from_ref).unwrap_or(&[])
    } else {
        messages
    };

    for msg in tail {
        for block in &msg.content {
            match block {
                ContentBlock::Text { text, .. } if !text.is_empty() => {
                    blocks.push(json!({ "type": "text", "text": text }));
                }
                ContentBlock::Media {
                    kind: MediaKind::Image,
                    source: MediaSource::Base64 { data, mime_type },
                    ..
                } => {
                    blocks.push(json!({
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": mime_type,
                            "data": data,
                        }
                    }));
                }
                ContentBlock::ToolResult {
                    tool_name,
                    content,
                    is_error,
                    ..
                } => {
                    let rendered = serde_json::to_string(content).unwrap_or_default();
                    if !rendered.is_empty() {
                        blocks.push(json!({
                            "type": "text",
                            "text": format!(
                                "[tool_result {} (error={})]: {}",
                                tool_name.as_deref().unwrap_or("tool"),
                                is_error,
                                rendered
                            )
                        }));
                    }
                }
                _ => {}
            }
        }
    }
    blocks
}

fn claude_fingerprint(request: &ProviderStepRequest, prefix: &[CanonicalMessage]) -> String {
    let mut safe_opts = Map::new();
    if let Some(effort) = claude_sdk_effort(&request.provider_options) {
        safe_opts.insert("reasoningEffort".into(), Value::String(effort.to_owned()));
    }
    if request_disables_all_tools(&request.provider_options) {
        safe_opts.insert("toolsDisabled".into(), Value::Bool(true));
    }
    compute_continuation_fingerprint(&ContinuationFingerprintInput {
        provider: "claude-sdk",
        model_id: &request.model_id,
        system_prompt: &request.system_prompt,
        tools: &[],
        authorized_tool_names: request.authorized_tool_names.as_deref(),
        canonical_prefix: prefix,
        stream_options: &safe_opts,
    })
}

fn resolve_resume_session(request: &ProviderStepRequest) -> Option<(&str, usize)> {
    let cont = request.continuation.as_ref()?;
    let ProviderContinuationState::ClaudeSdk { session_id, .. } = cont else {
        return None;
    };
    for (prefix, delta) in candidate_continuation_splits(&request.messages) {
        let fp = claude_fingerprint(request, prefix);
        if validate_continuation_state(Some(cont), "claude-sdk", &request.model_id, &fp).is_some()
            && !delta.is_empty()
        {
            return Some((session_id.as_str(), prefix.len()));
        }
    }
    None
}

fn parse_claude_usage(usage_val: &Value) -> TurnUsage {
    let input = usage_val
        .get("input_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let output = usage_val
        .get("output_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let cache_read = usage_val
        .get("cache_read_input_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let cache_write = usage_val
        .get("cache_creation_input_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    TurnUsage {
        prompt_tokens: input.saturating_add(cache_read).saturating_add(cache_write),
        completion_tokens: output,
        total_tokens: input
            .saturating_add(cache_read)
            .saturating_add(cache_write)
            .saturating_add(output),
        cached_prompt_tokens: (cache_read > 0).then_some(cache_read),
        cache_write_prompt_tokens: (cache_write > 0).then_some(cache_write),
        reasoning_output_tokens: None,
        estimated_cost_usd: None,
    }
}

#[derive(Default)]
struct StreamBlockState {
    kind: String,
    tool_id: String,
    tool_name: String,
    tool_input_json: String,
    text_buf: String,
    thinking_buf: String,
    text_block_index: usize,
    stream_id: String,
}

fn build_claude_sdk_args(
    base_args: Vec<String>,
    request: &ProviderStepRequest,
    resume_session_id: Option<&str>,
    tools_disabled: bool,
) -> Vec<String> {
    let mut args = base_args;
    args.push("--print".to_owned());
    if claude_sdk_uses_oauth_token(request.api_key.as_deref()) {
        // Claude Code's `--bare` intentionally ignores OAuth credentials including
        // `CLAUDE_CODE_OAUTH_TOKEN`. Restrict settings strictly to `user` scope (which
        // resolves to Cowork's isolated `CLAUDE_CONFIG_DIR`) so untrusted repository
        // `project` (`.claude/settings.json`, `CLAUDE.md`, project skills/agents) and
        // `local` (`.claude/settings.local.json`) settings are never loaded, paired with
        // CLI-precedence `disableAllHooks`, `--strict-mcp-config`, and `--disable-slash-commands`.
        args.push("--setting-sources".to_owned());
        args.push("user".to_owned());
    } else {
        // Bare mode skips all auto-discovery of project/user hooks, `CLAUDE.md`, skills,
        // custom commands, subagents, installed plugins, auto-memory, and `.mcp.json`.
        args.push("--bare".to_owned());
    }
    args.extend([
        "--settings".to_owned(),
        CLAUDE_SDK_ISOLATED_SETTINGS_JSON.to_owned(),
        "--strict-mcp-config".to_owned(),
        "--disable-slash-commands".to_owned(),
        "--input-format".to_owned(),
        "stream-json".to_owned(),
        "--output-format".to_owned(),
        "stream-json".to_owned(),
        "--verbose".to_owned(),
        "--include-partial-messages".to_owned(),
        "--permission-prompt-tool".to_owned(),
        "stdio".to_owned(),
        "--model".to_owned(),
        request.model_id.clone(),
    ]);
    if let Some(effort) = claude_sdk_effort(&request.provider_options) {
        args.push("--effort".to_owned());
        args.push(effort.to_owned());
    }
    if let Some(session_id) = resume_session_id {
        args.push("--resume".to_owned());
        args.push(session_id.to_owned());
    }
    if !request.system_prompt.trim().is_empty() {
        args.push("--append-system-prompt".to_owned());
        args.push(request.system_prompt.clone());
    }
    if tools_disabled || request.authorized_tool_names.as_deref() == Some(&[]) {
        args.push("--tools".to_owned());
        args.push(String::new());
    } else if let Some(allowlist) = request.authorized_tool_names.as_deref() {
        let disallowed = claude_disallowed_native_tools(allowlist);
        if !disallowed.is_empty() {
            args.push("--disallowedTools".to_owned());
            args.push(disallowed.join(","));
        }
    }
    args
}

#[async_trait]
impl ProviderTransport for ClaudeSdkTransport {
    async fn stream_step(
        &self,
        request: ProviderStepRequest,
        budget: &StepBudget,
        on_event: &mut StreamEventCallback<'_>,
    ) -> Result<ProviderStepResult, ProviderTransportError> {
        let env = self
            .env_override
            .clone()
            .unwrap_or_else(env_map_from_process);
        let cw_home = cowork_home(&env);

        let (command, base_args) = match &self.command_override {
            Some((cmd, args)) => (cmd.clone(), args.clone()),
            None => {
                let opts = self
                    .install_options
                    .clone()
                    .unwrap_or_else(|| ClaudeSdkInstallOptions::from_env(&env));
                ensure_claude_sdk_runtime_command(&cw_home, &env, &opts).await?
            }
        };

        let cwd = request
            .provider_options
            .get("cwd")
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .filter(|p| p.is_dir())
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));

        let resume_plan = resolve_resume_session(&request);
        let user_blocks = match resume_plan {
            Some((_, delta_start)) => {
                build_claude_user_content(&request.messages[delta_start..], false)
            }
            None => build_claude_user_content(&request.messages, true),
        };
        if user_blocks.is_empty() {
            return Err(ProviderTransportError::protocol(
                "Claude SDK runtime requires a user message.",
            ));
        }

        let tools_disabled =
            self.disable_tools || request_disables_all_tools(&request.provider_options);

        let args = build_claude_sdk_args(
            base_args,
            &request,
            resume_plan.map(|(session_id, _)| session_id),
            tools_disabled,
        );

        let spawn_env = build_claude_sdk_spawn_env(&cw_home, &env, request.api_key.as_deref());
        let mut child =
            spawn_managed_stdio_process(&command, &args, &cwd, &spawn_env, "Claude SDK")
                .map_err(ProviderTransportError::protocol)?;

        let mut child_stdin = child.stdin.take().ok_or_else(|| {
            ProviderTransportError::protocol("Failed to capture Claude SDK stdin")
        })?;
        let child_stdout = child.stdout.take().ok_or_else(|| {
            ProviderTransportError::protocol("Failed to capture Claude SDK stdout")
        })?;
        let child_stderr = child.stderr.take();

        let stderr_tail = Arc::new(parking_lot::Mutex::new(String::new()));
        if let Some(stderr) = child_stderr {
            let tail = Arc::clone(&stderr_tail);
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let mut guard = tail.lock();
                    if guard.len() > 4096 {
                        let keep = guard.len().saturating_sub(2048);
                        guard.drain(..keep);
                    }
                    if !guard.is_empty() {
                        guard.push('\n');
                    }
                    guard.push_str(&line);
                }
            });
        }

        let (stdin_tx, mut stdin_rx) = mpsc::unbounded_channel::<String>();
        tokio::spawn(async move {
            while let Some(mut line) = stdin_rx.recv().await {
                if !line.ends_with('\n') {
                    line.push('\n');
                }
                if child_stdin.write_all(line.as_bytes()).await.is_err() {
                    break;
                }
                let _ = child_stdin.flush().await;
            }
        });

        // 1. Send initialize control request + user message immediately on NDJSON stdin.
        let init_req = json!({
            "type": "control_request",
            "request_id": format!("init-{}", Uuid::new_v4()),
            "request": { "subtype": "initialize" }
        });
        let _ = stdin_tx.send(init_req.to_string());

        let user_msg = json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": user_blocks,
            }
        });
        let _ = stdin_tx.send(user_msg.to_string());

        let turn_id = request.turn_id.clone();
        let mut session_id: Option<String> = resume_plan.map(|(s, _)| s.to_owned());
        let mut raw_events = Vec::new();
        let mut active_blocks: HashMap<usize, StreamBlockState> = HashMap::new();
        let mut next_text_block_index: usize = 0;
        let mut think_segment: usize = 0;
        let mut announced_tools: HashMap<String, String> = HashMap::new();
        let mut final_text = String::new();
        let mut final_thinking = String::new();
        let mut usage = TurnUsage::default();
        let mut saw_result = false;
        let mut result_error: Option<String> = None;

        let cancel = budget.cancellation_token().clone();
        let tool_handler = self.tool_handler.clone();
        let stdin_for_ctrl = stdin_tx.clone();

        let stream_res = budget
            .run(async {
                let mut lines = BufReader::new(child_stdout).lines();
                loop {
                    let line = tokio::select! {
                        biased;
                        () = cancel.cancelled() => {
                            let interrupt = json!({
                                "type": "control_request",
                                "request_id": format!("int-{}", Uuid::new_v4()),
                                "request": { "subtype": "interrupt" }
                            });
                            let _ = stdin_for_ctrl.send(interrupt.to_string());
                            return Err(ProviderTransportError::aborted("Model turn aborted."));
                        }
                        next = lines.next_line() => match next {
                            Ok(Some(line)) => line,
                            Ok(None) => break,
                            Err(err) => {
                                return Err(ProviderTransportError::protocol(format!(
                                    "Claude SDK stdout read failed: {err}"
                                )));
                            }
                        }
                    };
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    let Ok(msg) = serde_json::from_str::<Value>(trimmed) else {
                        continue;
                    };
                    raw_events.push(msg.clone());
                    if let Some(sid) = msg.get("session_id").and_then(Value::as_str)
                        && !sid.trim().is_empty()
                    {
                        session_id = Some(sid.trim().to_owned());
                    }

                    match msg.get("type").and_then(Value::as_str).unwrap_or("") {
                        "control_request" => {
                            let req_id = msg
                                .get("request_id")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_owned();
                            let req_body = msg.get("request").cloned().unwrap_or(Value::Null);
                            let subtype = req_body
                                .get("subtype")
                                .and_then(Value::as_str)
                                .unwrap_or("");
                            if subtype == "can_use_tool" {
                                let (approved, deny_message) = match claude_tool_is_authorized(
                                    &req_body,
                                    tools_disabled,
                                    request.authorized_tool_names.as_deref(),
                                ) {
                                    Err(reason) => (false, reason),
                                    Ok(()) => {
                                        let ok = if let Some(handler) = &tool_handler {
                                            handler
                                                .request_approval("claude/can_use_tool", &req_body)
                                                .await
                                        } else {
                                            false
                                        };
                                        (
                                            ok,
                                            "Tool execution denied by Cowork approval policy."
                                                .to_owned(),
                                        )
                                    }
                                };
                                let reply = if approved {
                                    let input = req_body
                                        .get("input")
                                        .cloned()
                                        .unwrap_or_else(|| json!({}));
                                    json!({
                                        "type": "control_response",
                                        "response": {
                                            "subtype": "success",
                                            "request_id": req_id,
                                            "response": {
                                                "behavior": "allow",
                                                "updatedInput": input,
                                            }
                                        }
                                    })
                                } else {
                                    json!({
                                        "type": "control_response",
                                        "response": {
                                            "subtype": "success",
                                            "request_id": req_id,
                                            "response": {
                                                "behavior": "deny",
                                                "message": deny_message,
                                            }
                                        }
                                    })
                                };
                                let _ = stdin_for_ctrl.send(reply.to_string());
                            } else if !req_id.is_empty() {
                                let reply = json!({
                                    "type": "control_response",
                                    "response": {
                                        "subtype": "error",
                                        "request_id": req_id,
                                        "error": format!("Unsupported Claude SDK control request: {subtype}"),
                                    }
                                });
                                let _ = stdin_for_ctrl.send(reply.to_string());
                            }
                        }
                        "stream_event" => {
                            let Some(ev) = msg.get("event") else {
                                continue;
                            };
                            let idx = ev
                                .get("index")
                                .and_then(Value::as_u64)
                                .unwrap_or(0) as usize;
                            match ev.get("type").and_then(Value::as_str).unwrap_or("") {
                                "content_block_start" => {
                                    let cb = ev.get("content_block").unwrap_or(&Value::Null);
                                    let kind = cb
                                        .get("type")
                                        .and_then(Value::as_str)
                                        .unwrap_or("")
                                        .to_owned();
                                    let mut st = StreamBlockState {
                                        kind: kind.clone(),
                                        ..Default::default()
                                    };
                                    match kind.as_str() {
                                        "thinking" => {
                                            let sid =
                                                format!("{turn_id}:claude-sdk-think-{think_segment}");
                                            think_segment += 1;
                                            st.stream_id = sid.clone();
                                            on_event(StreamEvent::ThinkingStart {
                                                turn_id: turn_id.clone(),
                                                stream_id: sid,
                                                mode: ReasoningStreamMode::Summary,
                                            });
                                        }
                                        "text" => {
                                            let bi = next_text_block_index;
                                            next_text_block_index += 1;
                                            st.text_block_index = bi;
                                            on_event(StreamEvent::TextStart {
                                                turn_id: turn_id.clone(),
                                                block_index: bi,
                                                phase: None,
                                            });
                                        }
                                        "tool_use" => {
                                            st.tool_id = cb
                                                .get("id")
                                                .and_then(Value::as_str)
                                                .unwrap_or("")
                                                .to_owned();
                                            st.tool_name = cb
                                                .get("name")
                                                .and_then(Value::as_str)
                                                .unwrap_or("tool")
                                                .to_owned();
                                            if !st.tool_id.is_empty()
                                                && !announced_tools.contains_key(&st.tool_id)
                                            {
                                                announced_tools.insert(
                                                    st.tool_id.clone(),
                                                    st.tool_name.clone(),
                                                );
                                                on_event(StreamEvent::ToolCallStart {
                                                    turn_id: turn_id.clone(),
                                                    key: st.tool_id.clone(),
                                                    name: st.tool_name.clone(),
                                                    initial_args: None,
                                                });
                                            }
                                        }
                                        _ => {}
                                    }
                                    active_blocks.insert(idx, st);
                                }
                                "content_block_delta" => {
                                    let delta = ev.get("delta").unwrap_or(&Value::Null);
                                    let dtype = delta.get("type").and_then(Value::as_str).unwrap_or("");
                                    if let Some(st) = active_blocks.get_mut(&idx) {
                                        match dtype {
                                            "thinking_delta" => {
                                                if let Some(d) =
                                                    delta.get("thinking").and_then(Value::as_str)
                                                    && !d.is_empty()
                                                {
                                                    st.thinking_buf.push_str(d);
                                                    final_thinking.push_str(d);
                                                    on_event(StreamEvent::ThinkingDelta {
                                                        turn_id: turn_id.clone(),
                                                        stream_id: st.stream_id.clone(),
                                                        mode: ReasoningStreamMode::Summary,
                                                        delta: d.to_owned(),
                                                    });
                                                }
                                            }
                                            "text_delta" => {
                                                if let Some(d) =
                                                    delta.get("text").and_then(Value::as_str)
                                                    && !d.is_empty()
                                                {
                                                    st.text_buf.push_str(d);
                                                    final_text.push_str(d);
                                                    on_event(StreamEvent::TextDelta {
                                                        turn_id: turn_id.clone(),
                                                        block_index: st.text_block_index,
                                                        delta: d.to_owned(),
                                                        phase: None,
                                                    });
                                                }
                                            }
                                            "input_json_delta" => {
                                                if let Some(part) = delta
                                                    .get("partial_json")
                                                    .and_then(Value::as_str)
                                                {
                                                    st.tool_input_json.push_str(part);
                                                }
                                            }
                                            _ => {}
                                        }
                                    }
                                }
                                "content_block_stop" => {
                                    if let Some(st) = active_blocks.remove(&idx) {
                                        match st.kind.as_str() {
                                            "thinking" => {
                                                on_event(StreamEvent::ThinkingEnd {
                                                    turn_id: turn_id.clone(),
                                                    stream_id: st.stream_id,
                                                    mode: ReasoningStreamMode::Summary,
                                                    text: st.thinking_buf,
                                                    signature: None,
                                                    redacted: false,
                                                });
                                            }
                                            "text" => {
                                                on_event(StreamEvent::TextEnd {
                                                    turn_id: turn_id.clone(),
                                                    block_index: st.text_block_index,
                                                    text: st.text_buf,
                                                    phase: None,
                                                    citations: Vec::new(),
                                                    annotations: Vec::new(),
                                                });
                                            }
                                            "tool_use" if !st.tool_id.is_empty() => {
                                                let input = serde_json::from_str::<Map<String, Value>>(
                                                    &st.tool_input_json,
                                                )
                                                .unwrap_or_default();
                                                on_event(StreamEvent::ToolCallEnd {
                                                    turn_id: turn_id.clone(),
                                                    key: st.tool_id,
                                                    name: st.tool_name,
                                                    arguments: Some(input),
                                                    retry_of: None,
                                                    input_digest: None,
                                                });
                                            }
                                            _ => {}
                                        }
                                    }
                                }
                                _ => {}
                            }
                        }
                        "assistant" => {
                            if let Some(u) = msg.pointer("/message/usage") {
                                usage = parse_claude_usage(u);
                            }
                            if let Some(blocks) =
                                msg.pointer("/message/content").and_then(Value::as_array)
                            {
                                for block in blocks {
                                    match block.get("type").and_then(Value::as_str).unwrap_or("") {
                                        "text" => {
                                            let txt = block
                                                .get("text")
                                                .and_then(Value::as_str)
                                                .unwrap_or("");
                                            if final_text.is_empty() && !txt.is_empty() {
                                                let bi = next_text_block_index;
                                                next_text_block_index += 1;
                                                final_text.push_str(txt);
                                                on_event(StreamEvent::TextStart {
                                                    turn_id: turn_id.clone(),
                                                    block_index: bi,
                                                    phase: None,
                                                });
                                                on_event(StreamEvent::TextDelta {
                                                    turn_id: turn_id.clone(),
                                                    block_index: bi,
                                                    delta: txt.to_owned(),
                                                    phase: None,
                                                });
                                                on_event(StreamEvent::TextEnd {
                                                    turn_id: turn_id.clone(),
                                                    block_index: bi,
                                                    text: txt.to_owned(),
                                                    phase: None,
                                                    citations: Vec::new(),
                                                    annotations: Vec::new(),
                                                });
                                            }
                                        }
                                        "tool_use" => {
                                            let id = block
                                                .get("id")
                                                .and_then(Value::as_str)
                                                .unwrap_or("");
                                            let name = block
                                                .get("name")
                                                .and_then(Value::as_str)
                                                .unwrap_or("tool");
                                            if !id.is_empty()
                                                && !announced_tools.contains_key(id)
                                            {
                                                announced_tools
                                                    .insert(id.to_owned(), name.to_owned());
                                                let input = block
                                                    .get("input")
                                                    .and_then(Value::as_object)
                                                    .cloned()
                                                    .unwrap_or_default();
                                                on_event(StreamEvent::ToolCallStart {
                                                    turn_id: turn_id.clone(),
                                                    key: id.to_owned(),
                                                    name: name.to_owned(),
                                                    initial_args: (!input.is_empty())
                                                        .then(|| input.clone()),
                                                });
                                                on_event(StreamEvent::ToolCallEnd {
                                                    turn_id: turn_id.clone(),
                                                    key: id.to_owned(),
                                                    name: name.to_owned(),
                                                    arguments: Some(input),
                                                    retry_of: None,
                                                    input_digest: None,
                                                });
                                            }
                                        }
                                        _ => {}
                                    }
                                }
                            }
                        }
                        "user" => {
                            if let Some(blocks) =
                                msg.pointer("/message/content").and_then(Value::as_array)
                            {
                                for block in blocks {
                                    if block.get("type").and_then(Value::as_str)
                                        == Some("tool_result")
                                    {
                                        let id = block
                                            .get("tool_use_id")
                                            .and_then(Value::as_str)
                                            .unwrap_or("")
                                            .to_owned();
                                        let is_error = block
                                            .get("is_error")
                                            .and_then(Value::as_bool)
                                            .unwrap_or(false);
                                        let content = block
                                            .get("content")
                                            .cloned()
                                            .unwrap_or(Value::Null);
                                        if !id.is_empty() {
                                            let name = announced_tools
                                                .get(&id)
                                                .cloned()
                                                .unwrap_or_else(|| "tool".to_owned());
                                            on_event(StreamEvent::ToolResult {
                                                turn_id: turn_id.clone(),
                                                key: id,
                                                name,
                                                result: content,
                                                is_error,
                                                denied: false,
                                            });
                                        }
                                    }
                                }
                            }
                        }
                        "result" => {
                            saw_result = true;
                            if let Some(u) = msg.get("usage") {
                                usage = parse_claude_usage(u);
                            }
                            if let Some(res_text) = msg.get("result").and_then(Value::as_str)
                                && final_text.is_empty()
                                && !res_text.is_empty()
                                && msg.get("is_error").and_then(Value::as_bool) != Some(true)
                            {
                                let bi = next_text_block_index;
                                next_text_block_index += 1;
                                final_text.push_str(res_text);
                                on_event(StreamEvent::TextStart {
                                    turn_id: turn_id.clone(),
                                    block_index: bi,
                                    phase: None,
                                });
                                on_event(StreamEvent::TextDelta {
                                    turn_id: turn_id.clone(),
                                    block_index: bi,
                                    delta: res_text.to_owned(),
                                    phase: None,
                                });
                                on_event(StreamEvent::TextEnd {
                                    turn_id: turn_id.clone(),
                                    block_index: bi,
                                    text: res_text.to_owned(),
                                    phase: None,
                                    citations: Vec::new(),
                                    annotations: Vec::new(),
                                });
                            }
                            if msg.get("is_error").and_then(Value::as_bool) == Some(true)
                                || msg
                                    .get("subtype")
                                    .and_then(Value::as_str)
                                    .is_some_and(|s| s.starts_with("error"))
                            {
                                let detail = msg
                                    .get("result")
                                    .and_then(Value::as_str)
                                    .or_else(|| {
                                        msg.get("errors")
                                            .and_then(Value::as_array)
                                            .and_then(|arr| arr.first())
                                            .and_then(Value::as_str)
                                    })
                                    .unwrap_or("Claude SDK turn failed.");
                                result_error = Some(detail.to_owned());
                            }
                            break;
                        }
                        _ => {}
                    }
                }
                Ok::<(), ProviderTransportError>(())
            })
            .await;

        drop(stdin_tx);
        kill_managed_process_tree(child).await;

        stream_res?;
        if let Some(err) = result_error {
            return Err(ProviderTransportError::protocol(err));
        }
        if !saw_result {
            let detail = stderr_tail.lock().trim().to_owned();
            let msg = if detail.is_empty() {
                "Claude SDK exited before returning a result event.".to_owned()
            } else {
                format!("Claude SDK exited before returning a result event: {detail}")
            };
            return Err(ProviderTransportError::protocol(msg));
        }

        let mut content = Vec::new();
        if !final_thinking.is_empty() {
            content.push(ContentBlock::Thinking {
                text: final_thinking,
                summary: None,
                redacted: false,
                signature: None,
                provider_meta: ProviderOpaqueMeta::default(),
            });
        }
        if !final_text.is_empty() {
            content.push(ContentBlock::Text {
                text: final_text,
                phase: None,
                citations: Vec::new(),
                provider_meta: ProviderOpaqueMeta::default(),
            });
        }

        let assistant = CanonicalMessage {
            id: format!("msg-{}", Uuid::new_v4()),
            role: MessageRole::Assistant,
            content,
            phase: None,
            provider: Some("claude-sdk".to_owned()),
            api: Some("claude-sdk".to_owned()),
            model: Some(request.model_id.clone()),
            stop_reason: Some(StopReason::Stop),
            provider_meta: ProviderOpaqueMeta::default(),
            created_at: Utc::now().to_rfc3339(),
        };
        let persisted_assistant = filter_persisted_assistant_history(&assistant);

        let mut next_prefix = request.messages.clone();
        next_prefix.push(persisted_assistant.as_ref().unwrap_or(&assistant).clone());
        let fp = claude_fingerprint(&request, &next_prefix);
        let continuation = session_id.map(|sid| ProviderContinuationState::ClaudeSdk {
            model: request.model_id,
            session_id: sid,
            updated_at: Utc::now().to_rfc3339(),
            request_fingerprint: Some(fp),
        });

        Ok(ProviderStepResult {
            assistant,
            persisted_assistant,
            usage,
            continuation,
            raw_events,
        })
    }
}
