//! Native Rust Claude Agent SDK transport driving the system `claude` CLI over its
//! bidirectional `--input-format stream-json --output-format stream-json` control protocol.
//!
//! Cowork's own tools (sandboxed file/shell tools, approvals, subagents, user MCP servers) are
//! bridged directly into the Claude CLI session via an in-process SDK MCP server (`"cowork"`,
//! declared with `{"type":"sdk","name":"cowork"}`) over `control_request` / `mcp_message` frames,
//! while Claude Code's built-in tools are disabled (`--tools ""`) so Cowork remains the single
//! policy and sandbox authority.

pub mod discovery;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use chrono::Utc;
use cowork_config::{env_map_from_process, host_platform, resolve_home_dir};
use cowork_inference::{
    CanonicalMessage, ContentBlock, ContinuationFingerprintInput, MediaKind, MediaSource,
    MessageRole, ProviderContinuationState, ProviderOpaqueMeta, ProviderTransportError,
    ReasoningStreamMode, StepBudget, StopReason, StreamEvent, TurnUsage,
    compute_continuation_fingerprint, validate_continuation_state,
};
use serde_json::{Map, Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Mutex;

use crate::codex_app_server::DynamicToolHandler;
use crate::endpoint_capabilities::{
    EndpointToolCapabilities, NativeToolSearchKind, read_native_tool_calling_plan,
    resolve_endpoint_tool_capabilities,
};
use crate::transport::{
    ProviderStepRequest, ProviderStepResult, ProviderTransport, StreamEventCallback,
    ToolDefinition, candidate_continuation_splits, request_disables_all_tools,
};

pub use discovery::{
    ClaudeAuthStatus, ClaudeCliStatus, build_claude_spawn_env, list_claude_sdk_models,
    logout_claude_account, parse_claude_auth_status_json, parse_claude_initialize_models,
    read_claude_auth_status, resolve_claude_cli_status, start_claude_login,
};

const SDK_MCP_SERVER_NAME: &str = "cowork";
const INIT_TIMEOUT: Duration = Duration::from_secs(30);
const SHUTDOWN_GRACE: Duration = Duration::from_secs(3);
const STDERR_TAIL_LIMIT: usize = 32;

/// Native Rust transport backed by the system `claude` CLI (Claude Agent SDK protocol).
#[derive(Clone, Default)]
pub struct ClaudeAgentSdkTransport {
    /// Optional `(program, prefix_args)` override used by deterministic tests.
    pub command_override: Option<(String, Vec<String>)>,
    /// Cowork tool bridge invoked when Claude calls `mcp__cowork__<tool>` over `mcp_message`.
    pub tool_handler: Option<Arc<dyn DynamicToolHandler>>,
    /// Environment override (defaults to current process env).
    pub env_override: Option<HashMap<String, String>>,
    /// Home directory override used for system CLI discovery.
    pub homedir_override: Option<PathBuf>,
    /// Working directory for the spawned `claude` subprocess.
    pub cwd: Option<PathBuf>,
    /// Disables SDK MCP tool bridging (for one-shot calls such as title/memory generation).
    pub disable_tools: bool,
}

impl std::fmt::Debug for ClaudeAgentSdkTransport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClaudeAgentSdkTransport")
            .field("command_override", &self.command_override)
            .field("has_tool_handler", &self.tool_handler.is_some())
            .field("has_env_override", &self.env_override.is_some())
            .field("homedir_override", &self.homedir_override)
            .field("cwd", &self.cwd)
            .field("disable_tools", &self.disable_tools)
            .finish()
    }
}

impl ClaudeAgentSdkTransport {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_env(env: HashMap<String, String>) -> Self {
        Self {
            env_override: Some(env),
            ..Self::default()
        }
    }

    pub fn with_homedir(mut self, homedir: PathBuf) -> Self {
        self.homedir_override = Some(homedir);
        self
    }

    pub fn with_cwd(mut self, cwd: Option<PathBuf>) -> Self {
        self.cwd = cwd;
        self
    }

    pub fn with_tool_handler(mut self, handler: Option<Arc<dyn DynamicToolHandler>>) -> Self {
        self.tool_handler = handler;
        self
    }

    pub fn with_tools_disabled(mut self, disable_tools: bool) -> Self {
        self.disable_tools = disable_tools;
        self
    }

    fn resolve_command(
        &self,
        env: &HashMap<String, String>,
    ) -> Result<(String, Vec<String>), ProviderTransportError> {
        if let Some((prog, args)) = &self.command_override {
            return Ok((prog.clone(), args.clone()));
        }
        let homedir = self
            .homedir_override
            .clone()
            .unwrap_or_else(|| resolve_home_dir(env, host_platform()));
        let status = resolve_claude_cli_status(&homedir, env);
        match status.command {
            Some(cmd) => Ok((cmd, Vec::new())),
            None => Err(ProviderTransportError::fatal(status.message)),
        }
    }
}

trait FatalErrorExt {
    fn fatal(message: impl Into<String>) -> Self;
}

impl FatalErrorExt for ProviderTransportError {
    fn fatal(message: impl Into<String>) -> Self {
        Self {
            status: None,
            message: message.into(),
            code: Some("CLAUDE_AGENT_SDK_ERROR".to_owned()),
            headers: HashMap::new(),
            is_network_transient: false,
            is_timeout: false,
            is_abort: false,
        }
    }
}

fn filter_effective_tools(request: &ProviderStepRequest) -> Vec<ToolDefinition> {
    match &request.authorized_tool_names {
        Some(allowed) => {
            let allow_set: HashSet<&str> = allowed.iter().map(String::as_str).collect();
            request
                .tools
                .iter()
                .filter(|t| allow_set.contains(t.name.as_str()))
                .cloned()
                .collect()
        }
        None => request.tools.clone(),
    }
}

fn resolve_effort_option(provider_options: &Map<String, Value>) -> Option<String> {
    let section = provider_options
        .get("claude-cli")
        .and_then(Value::as_object)
        .or_else(|| provider_options.get("anthropic").and_then(Value::as_object));
    let raw = section
        .and_then(|s| s.get("effort").or_else(|| s.get("reasoningEffort")))
        .or_else(|| {
            provider_options
                .get("effort")
                .or_else(|| provider_options.get("reasoningEffort"))
        })
        .and_then(Value::as_str)
        .map(str::trim)?;
    match raw {
        "low" | "medium" | "high" | "xhigh" | "max" => Some(raw.to_owned()),
        _ => None,
    }
}

fn build_user_content_blocks(messages: &[CanonicalMessage]) -> Value {
    let mut blocks: Vec<Value> = Vec::new();
    let multi_message = messages.len() > 1
        || messages
            .first()
            .is_some_and(|m| m.role != MessageRole::User);

    for msg in messages {
        let prefix = if multi_message {
            match msg.role {
                MessageRole::User => Some("User:\n"),
                MessageRole::Assistant => Some("Assistant:\n"),
                MessageRole::Tool => Some("Tool result:\n"),
                MessageRole::System | MessageRole::Developer => Some("System:\n"),
            }
        } else {
            None
        };
        let mut msg_text = String::new();
        let mut msg_images: Vec<Value> = Vec::new();

        for block in &msg.content {
            match block {
                ContentBlock::Text { text, .. } => {
                    if !text.is_empty() {
                        if !msg_text.is_empty() {
                            msg_text.push('\n');
                        }
                        msg_text.push_str(text);
                    }
                }
                ContentBlock::Media {
                    kind: MediaKind::Image,
                    source: MediaSource::Base64 { mime_type, data },
                    ..
                } => {
                    msg_images.push(json!({
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": mime_type,
                            "data": data,
                        }
                    }));
                }
                ContentBlock::ToolCall {
                    name, arguments, ..
                } => {
                    if !msg_text.is_empty() {
                        msg_text.push('\n');
                    }
                    msg_text.push_str(&format!(
                        "[Tool call {name}]: {}",
                        Value::Object(arguments.clone())
                    ));
                }
                ContentBlock::ToolResult {
                    tool_name, content, ..
                } => {
                    let rendered: String = content
                        .iter()
                        .filter_map(|part| match part {
                            cowork_inference::ToolResultPart::Text { text } => Some(text.as_str()),
                            _ => None,
                        })
                        .collect::<Vec<_>>()
                        .join("\n");
                    if !rendered.is_empty() {
                        if !msg_text.is_empty() {
                            msg_text.push('\n');
                        }
                        let name_label = tool_name.as_deref().unwrap_or("tool");
                        msg_text.push_str(&format!("[Tool result {name_label}]: {rendered}"));
                    }
                }
                _ => {}
            }
        }

        if !msg_text.is_empty() {
            let full = match prefix {
                Some(p) => format!("{p}{msg_text}"),
                None => msg_text,
            };
            blocks.push(json!({ "type": "text", "text": full }));
        }
        blocks.extend(msg_images);
    }

    if blocks.is_empty() {
        blocks.push(json!({ "type": "text", "text": "" }));
    }
    Value::Array(blocks)
}

fn error_text_from_result(msg: &Value) -> String {
    if let Some(arr) = msg.get("errors").and_then(Value::as_array) {
        let joined: Vec<&str> = arr
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect();
        if !joined.is_empty() {
            return joined.join("; ");
        }
    }
    if let Some(res) = msg
        .get("result")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return res.to_owned();
    }
    if let Some(sub) = msg
        .get("subtype")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && *s != "success")
    {
        return sub.to_owned();
    }
    "Claude Agent SDK returned an error result.".to_owned()
}

fn parse_claude_usage(usage_val: Option<&Value>, total_cost_usd: Option<f64>) -> TurnUsage {
    let Some(obj) = usage_val.and_then(Value::as_object) else {
        return TurnUsage {
            estimated_cost_usd: total_cost_usd,
            ..TurnUsage::default()
        };
    };
    let input = obj.get("input_tokens").and_then(Value::as_u64).unwrap_or(0);
    let cache_read = obj
        .get("cache_read_input_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let cache_create = obj
        .get("cache_creation_input_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let output = obj
        .get("output_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let prompt_tokens = input
        .saturating_add(cache_read)
        .saturating_add(cache_create);
    TurnUsage {
        prompt_tokens,
        completion_tokens: output,
        total_tokens: prompt_tokens.saturating_add(output),
        cached_prompt_tokens: (cache_read > 0).then_some(cache_read),
        cache_write_prompt_tokens: (cache_create > 0).then_some(cache_create),
        reasoning_output_tokens: None,
        estimated_cost_usd: total_cost_usd,
    }
}

async fn write_ndjson_line(
    stdin: &mut tokio::process::ChildStdin,
    payload: &Value,
) -> Result<(), ProviderTransportError> {
    let mut line = serde_json::to_string(payload).map_err(|e| {
        ProviderTransportError::fatal(format!("Failed to serialize SDK frame: {e}"))
    })?;
    line.push('\n');
    stdin.write_all(line.as_bytes()).await.map_err(|e| {
        ProviderTransportError::network(format!("Failed writing to Claude CLI: {e}"))
    })?;
    stdin
        .flush()
        .await
        .map_err(|e| ProviderTransportError::network(format!("Failed flushing Claude CLI: {e}")))?;
    Ok(())
}

fn mcp_tools_list_value(
    tools: &[ToolDefinition],
    native_deferred_tool_names: Option<&HashSet<String>>,
) -> Value {
    let list: Vec<Value> = tools
        .iter()
        .map(|t| {
            let mut definition = json!({
                "name": t.name,
                "description": t.description,
                "inputSchema": t.parameters,
            });
            if let Some(deferred) = native_deferred_tool_names {
                definition["_meta"] = json!({
                    "anthropic/alwaysLoad": !deferred.contains(&t.name),
                });
            }
            definition
        })
        .collect();
    json!({ "tools": list })
}

#[allow(clippy::too_many_arguments)]
async fn handle_inbound_control_request(
    msg: &Value,
    turn_id: &str,
    tools: &[ToolDefinition],
    native_deferred_tool_names: Option<&HashSet<String>>,
    tool_handler: Option<&Arc<dyn DynamicToolHandler>>,
    budget: &StepBudget,
    on_event: &mut StreamEventCallback<'_>,
    stdin: &mut tokio::process::ChildStdin,
    tool_call_seq: &mut usize,
) -> Result<(), ProviderTransportError> {
    let Some(request_id) = msg.get("request_id").and_then(Value::as_str) else {
        return Ok(());
    };
    let req = msg.get("request").unwrap_or(&Value::Null);
    let subtype = req.get("subtype").and_then(Value::as_str).unwrap_or("");

    let reply = match subtype {
        "mcp_message" => {
            let server_name = req.get("server_name").and_then(Value::as_str).unwrap_or("");
            let rpc = req.get("message").unwrap_or(&Value::Null);
            let rpc_id = rpc.get("id").cloned();
            let method = rpc.get("method").and_then(Value::as_str).unwrap_or("");

            let mcp_response = if server_name != SDK_MCP_SERVER_NAME {
                json!({
                    "jsonrpc": "2.0",
                    "id": rpc_id,
                    "error": {
                        "code": -32601,
                        "message": format!("Unknown SDK MCP server: {server_name}"),
                    }
                })
            } else {
                match method {
                    "initialize" => json!({
                        "jsonrpc": "2.0",
                        "id": rpc_id,
                        "result": {
                            "protocolVersion": "2025-11-25",
                            "capabilities": { "tools": { "listChanged": false } },
                            "serverInfo": { "name": SDK_MCP_SERVER_NAME, "version": "1.0.0" }
                        }
                    }),
                    "notifications/initialized" => json!({
                        "jsonrpc": "2.0",
                        "result": {}
                    }),
                    "tools/list" => json!({
                        "jsonrpc": "2.0",
                        "id": rpc_id,
                        "result": mcp_tools_list_value(tools, native_deferred_tool_names),
                    }),
                    "tools/call" => {
                        let params = rpc.get("params").unwrap_or(&Value::Null);
                        let raw_name = params
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        let tool_name = raw_name.strip_prefix("mcp__cowork__").unwrap_or(raw_name);
                        let args = params
                            .get("arguments")
                            .and_then(Value::as_object)
                            .cloned()
                            .unwrap_or_default();

                        *tool_call_seq += 1;
                        let call_key = format!("claude-mcp-{}", *tool_call_seq);
                        on_event(StreamEvent::ToolCallStart {
                            turn_id: turn_id.to_owned(),
                            key: call_key.clone(),
                            name: tool_name.to_owned(),
                            initial_args: Some(args.clone()),
                        });
                        on_event(StreamEvent::ToolCallEnd {
                            turn_id: turn_id.to_owned(),
                            key: call_key.clone(),
                            name: tool_name.to_owned(),
                            arguments: Some(args.clone()),
                            retry_of: None,
                            input_digest: None,
                        });

                        let (text, is_error) = match tool_handler {
                            Some(handler) => {
                                let out = tokio::select! {
                                    biased;
                                    _ = budget.cancellation_token().cancelled() => {
                                        return Err(ProviderTransportError::aborted("Turn cancelled."));
                                    }
                                    res = handler.call_tool(tool_name, args) => res,
                                };
                                (out.text, out.is_error)
                            }
                            None => (
                                format!("Tool '{tool_name}' is unavailable in this session."),
                                true,
                            ),
                        };

                        on_event(StreamEvent::ToolResult {
                            turn_id: turn_id.to_owned(),
                            key: call_key,
                            name: tool_name.to_owned(),
                            result: Value::String(text.clone()),
                            is_error,
                            denied: false,
                        });

                        json!({
                            "jsonrpc": "2.0",
                            "id": rpc_id,
                            "result": {
                                "content": [{ "type": "text", "text": text }],
                                "isError": is_error,
                            }
                        })
                    }
                    other => json!({
                        "jsonrpc": "2.0",
                        "id": rpc_id,
                        "error": {
                            "code": -32601,
                            "message": format!("Unsupported MCP method: {other}"),
                        }
                    }),
                }
            };

            json!({
                "type": "control_response",
                "response": {
                    "subtype": "success",
                    "request_id": request_id,
                    "response": {
                        "mcp_response": mcp_response,
                    }
                }
            })
        }
        "can_use_tool" => {
            let tool_name = req.get("tool_name").and_then(Value::as_str).unwrap_or("");
            let input = req.get("input").cloned().unwrap_or_else(|| json!({}));
            let decision = if tool_name.starts_with("mcp__cowork__")
                || (native_deferred_tool_names.is_some() && tool_name == "ToolSearch")
            {
                json!({
                    "behavior": "allow",
                    "updatedInput": input,
                })
            } else {
                json!({
                    "behavior": "deny",
                    "message": "Native Claude CLI tools are disabled in Cowork; use Cowork tools instead.",
                })
            };
            json!({
                "type": "control_response",
                "response": {
                    "subtype": "success",
                    "request_id": request_id,
                    "response": decision,
                }
            })
        }
        other => json!({
            "type": "control_response",
            "response": {
                "subtype": "error",
                "request_id": request_id,
                "error": format!("Unsupported control request subtype: {other}"),
            }
        }),
    };

    write_ndjson_line(stdin, &reply).await
}

#[async_trait]
impl ProviderTransport for ClaudeAgentSdkTransport {
    fn native_tool_capabilities(
        &self,
        base_url: Option<&str>,
        model_id: &str,
        strategy: cowork_config::ToolCallingStrategy,
    ) -> EndpointToolCapabilities {
        resolve_endpoint_tool_capabilities(
            cowork_config::ProviderName::ClaudeCli,
            base_url,
            model_id,
            strategy,
        )
    }

    async fn stream_step(
        &self,
        request: ProviderStepRequest,
        budget: &StepBudget,
        on_event: &mut StreamEventCallback<'_>,
    ) -> Result<ProviderStepResult, ProviderTransportError> {
        if budget.cancellation_token().is_cancelled() {
            return Err(ProviderTransportError::aborted("Turn cancelled."));
        }

        let parent_env = self
            .env_override
            .clone()
            .unwrap_or_else(env_map_from_process);
        let (program, prefix_args) = self.resolve_command(&parent_env)?;
        let mut spawn_env = build_claude_spawn_env(&parent_env);

        let tools_disabled =
            self.disable_tools || request_disables_all_tools(&request.provider_options);
        let effective_tools = if tools_disabled {
            Vec::new()
        } else {
            filter_effective_tools(&request)
        };
        let bridge_tools =
            !tools_disabled && self.tool_handler.is_some() && !effective_tools.is_empty();
        let native_deferred_tool_names: Option<HashSet<String>> = if bridge_tools {
            read_native_tool_calling_plan(&request.provider_options).and_then(|plan| {
                if matches!(plan.tool_search, Some(NativeToolSearchKind::ClaudeAgentSdk)) {
                    Some(plan.deferred_tool_names.into_iter().collect())
                } else {
                    None
                }
            })
        } else {
            None
        };
        let native_tool_search_enabled = native_deferred_tool_names.is_some();
        if bridge_tools {
            spawn_env.insert(
                "ENABLE_TOOL_SEARCH".to_owned(),
                (if native_tool_search_enabled {
                    "true"
                } else {
                    "false"
                })
                .to_owned(),
            );
        }

        // Validate continuation (`--resume=<session_id>`) using prefix SHA-256 fingerprint.
        let tools_json: Vec<Value> = effective_tools
            .iter()
            .map(|t| {
                json!({
                    "name": t.name,
                    "description": t.description,
                    "parameters": t.parameters,
                })
            })
            .collect();
        let mut resume_session_id: Option<String> = None;
        let mut input_messages: &[CanonicalMessage] = &request.messages;

        if !tools_disabled
            && let Some(ProviderContinuationState::ClaudeCli { session_id, .. }) =
                request.continuation.as_ref()
            && !session_id.trim().is_empty()
        {
            for (prefix, delta) in candidate_continuation_splits(&request.messages) {
                if delta.is_empty() {
                    continue;
                }
                let fp = compute_continuation_fingerprint(&ContinuationFingerprintInput {
                    provider: "claude-cli",
                    model_id: &request.model_id,
                    system_prompt: &request.system_prompt,
                    tools: &tools_json,
                    authorized_tool_names: request.authorized_tool_names.as_deref(),
                    canonical_prefix: prefix,
                    stream_options: &request.provider_options,
                });
                if validate_continuation_state(
                    request.continuation.as_ref(),
                    "claude-cli",
                    &request.model_id,
                    &fp,
                )
                .is_some()
                {
                    resume_session_id = Some(session_id.clone());
                    input_messages = delta;
                    break;
                }
            }
        }

        let mut args = prefix_args;
        args.extend([
            "--output-format".to_owned(),
            "stream-json".to_owned(),
            "--input-format".to_owned(),
            "stream-json".to_owned(),
            "--verbose".to_owned(),
            "--include-partial-messages".to_owned(),
            "--tools".to_owned(),
            (if native_tool_search_enabled {
                "ToolSearch"
            } else {
                ""
            })
            .to_owned(),
            "--setting-sources=".to_owned(),
            "--strict-mcp-config".to_owned(),
            "--permission-mode".to_owned(),
            "bypassPermissions".to_owned(),
        ]);

        if !request.system_prompt.is_empty() {
            args.push("--system-prompt".to_owned());
            args.push(request.system_prompt.clone());
        } else {
            args.push("--system-prompt".to_owned());
            args.push(String::new());
        }

        if !request.model_id.trim().is_empty() {
            args.push("--model".to_owned());
            args.push(request.model_id.trim().to_owned());
        }

        if let Some(effort) = resolve_effort_option(&request.provider_options) {
            args.push("--effort".to_owned());
            args.push(effort);
        }

        if bridge_tools {
            let mut server_config = json!({
                "type": "sdk",
                "name": SDK_MCP_SERVER_NAME,
            });
            if !native_tool_search_enabled {
                server_config["alwaysLoad"] = Value::Bool(true);
            }
            let mcp_cfg = json!({
                "mcpServers": {
                    SDK_MCP_SERVER_NAME: server_config,
                }
            });
            args.push("--mcp-config".to_owned());
            args.push(mcp_cfg.to_string());
        } else {
            args.push("--max-turns".to_owned());
            args.push("1".to_owned());
        }

        if tools_disabled {
            args.push("--no-session-persistence".to_owned());
        } else if let Some(sid) = &resume_session_id {
            args.push(format!("--resume={sid}"));
        }

        let mut cmd = tokio::process::Command::new(&program);
        cmd.args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env_clear()
            .envs(&spawn_env)
            .kill_on_drop(true);
        if let Some(cwd) = &self.cwd {
            cmd.current_dir(cwd);
        }

        let mut child = cmd.spawn().map_err(|e| {
            ProviderTransportError::fatal(format!(
                "Failed to spawn Claude Agent SDK CLI ({program}): {e}"
            ))
        })?;

        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| ProviderTransportError::fatal("Claude CLI stdin unavailable"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| ProviderTransportError::fatal("Claude CLI stdout unavailable"))?;
        let stderr = child.stderr.take();

        let stderr_lines: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let stderr_task = stderr.map(|err_pipe| {
            let tail = Arc::clone(&stderr_lines);
            tokio::spawn(async move {
                let mut reader = BufReader::new(err_pipe).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    let mut guard = tail.lock().await;
                    if guard.len() >= STDERR_TAIL_LIMIT {
                        guard.remove(0);
                    }
                    guard.push(trimmed.to_owned());
                }
            })
        });

        let mut stdout_lines = BufReader::new(stdout).lines();

        // 1. Control protocol initialize handshake.
        let init_req_id = "cowork_init_1";
        write_ndjson_line(
            &mut stdin,
            &json!({
                "type": "control_request",
                "request_id": init_req_id,
                "request": {
                    "subtype": "initialize",
                    "hooks": null,
                }
            }),
        )
        .await?;

        let mut raw_events: Vec<Value> = Vec::new();
        let mut session_id: Option<String> = resume_session_id.clone();
        let mut tool_call_seq: usize = 0;

        let init_deadline = tokio::time::Instant::now() + INIT_TIMEOUT;
        loop {
            let next_line = tokio::select! {
                biased;
                _ = budget.cancellation_token().cancelled() => {
                    let _ = child.kill().await;
                    return Err(ProviderTransportError::aborted("Turn cancelled."));
                }
                _ = tokio::time::sleep_until(init_deadline) => {
                    let _ = child.kill().await;
                    return Err(ProviderTransportError::timeout("Timed out waiting for Claude CLI initialize handshake."));
                }
                res = stdout_lines.next_line() => res,
            };

            let line = match next_line {
                Ok(Some(l)) => l,
                Ok(None) => {
                    let tail = stderr_lines.lock().await.join(" | ");
                    let msg = if tail.is_empty() {
                        "Claude CLI exited before completing initialize handshake.".to_owned()
                    } else {
                        format!("Claude CLI exited during initialize: {tail}")
                    };
                    return Err(ProviderTransportError::fatal(msg));
                }
                Err(e) => {
                    return Err(ProviderTransportError::network(format!(
                        "Failed reading Claude CLI stdout: {e}"
                    )));
                }
            };

            let trimmed = line.trim();
            if trimmed.is_empty() || !trimmed.starts_with('{') {
                continue;
            }
            let Ok(val) = serde_json::from_str::<Value>(trimmed) else {
                continue;
            };
            let msg_type = val.get("type").and_then(Value::as_str).unwrap_or("");
            if msg_type == "control_response" {
                let resp = val.get("response").unwrap_or(&Value::Null);
                if resp.get("request_id").and_then(Value::as_str) == Some(init_req_id) {
                    if resp.get("subtype").and_then(Value::as_str) == Some("error") {
                        let err = resp
                            .get("error")
                            .and_then(Value::as_str)
                            .unwrap_or("Claude CLI initialize failed");
                        let _ = child.kill().await;
                        return Err(ProviderTransportError::fatal(err));
                    }
                    break;
                }
            } else if msg_type == "control_request" {
                handle_inbound_control_request(
                    &val,
                    &request.turn_id,
                    &effective_tools,
                    native_deferred_tool_names.as_ref(),
                    self.tool_handler.as_ref(),
                    budget,
                    on_event,
                    &mut stdin,
                    &mut tool_call_seq,
                )
                .await?;
            } else if msg_type == "system"
                && let Some(sid) = val.get("session_id").and_then(Value::as_str)
                && !sid.is_empty()
            {
                session_id = Some(sid.to_owned());
            }
        }

        // 2. Send user prompt message over stream-json stdin.
        let user_content = build_user_content_blocks(input_messages);
        write_ndjson_line(
            &mut stdin,
            &json!({
                "type": "user",
                "message": {
                    "role": "user",
                    "content": user_content,
                },
                "session_id": session_id.as_deref().unwrap_or(""),
                "parent_tool_use_id": null,
            }),
        )
        .await?;

        // 3. Stream events & serve bidirectional control requests until terminal `result`.
        let mut accumulated_text = String::new();
        let mut accumulated_thinking = String::new();
        let mut text_started = false;
        let mut thinking_started = false;
        let mut saw_stream_text_in_msg = false;
        let mut saw_stream_thinking_in_msg = false;
        let mut final_usage = TurnUsage::default();
        let mut result_received = false;
        let mut result_error: Option<String> = None;

        loop {
            let next_line = tokio::select! {
                biased;
                _ = budget.cancellation_token().cancelled() => {
                    let _ = write_ndjson_line(
                        &mut stdin,
                        &json!({
                            "type": "control_request",
                            "request_id": "cowork_interrupt_1",
                            "request": { "subtype": "interrupt" }
                        }),
                    ).await;
                    let _ = tokio::time::timeout(Duration::from_millis(500), child.wait()).await;
                    let _ = child.kill().await;
                    return Err(ProviderTransportError::aborted("Turn cancelled."));
                }
                res = stdout_lines.next_line() => res,
            };

            let line = match next_line {
                Ok(Some(l)) => l,
                Ok(None) => break,
                Err(e) => {
                    let _ = child.kill().await;
                    return Err(ProviderTransportError::network(format!(
                        "Failed reading Claude CLI stream: {e}"
                    )));
                }
            };

            let trimmed = line.trim();
            if trimmed.is_empty() || !trimmed.starts_with('{') {
                continue;
            }
            let Ok(val) = serde_json::from_str::<Value>(trimmed) else {
                continue;
            };

            let msg_type = val.get("type").and_then(Value::as_str).unwrap_or("");
            match msg_type {
                "control_request" => {
                    handle_inbound_control_request(
                        &val,
                        &request.turn_id,
                        &effective_tools,
                        native_deferred_tool_names.as_ref(),
                        self.tool_handler.as_ref(),
                        budget,
                        on_event,
                        &mut stdin,
                        &mut tool_call_seq,
                    )
                    .await?;
                }
                "control_response" | "control_cancel_request" | "transcript_mirror" => {}
                "system" => {
                    if let Some(sid) = val.get("session_id").and_then(Value::as_str)
                        && !sid.is_empty()
                    {
                        session_id = Some(sid.to_owned());
                    }
                    raw_events.push(val);
                }
                "stream_event" => {
                    // Ignore subagent-nested deltas unless top-level.
                    if val.get("parent_tool_use_id").is_some_and(|v| !v.is_null()) {
                        continue;
                    }
                    let event = val.get("event").unwrap_or(&Value::Null);
                    let ev_type = event.get("type").and_then(Value::as_str).unwrap_or("");
                    match ev_type {
                        "message_start" => {
                            saw_stream_text_in_msg = false;
                            saw_stream_thinking_in_msg = false;
                        }
                        "content_block_delta" => {
                            let delta = event.get("delta").unwrap_or(&Value::Null);
                            let d_type = delta.get("type").and_then(Value::as_str).unwrap_or("");
                            match d_type {
                                "text_delta" => {
                                    if let Some(chunk) = delta.get("text").and_then(Value::as_str)
                                        && !chunk.is_empty()
                                    {
                                        if !text_started {
                                            text_started = true;
                                            on_event(StreamEvent::TextStart {
                                                turn_id: request.turn_id.clone(),
                                                block_index: 0,
                                                phase: None,
                                            });
                                        }
                                        saw_stream_text_in_msg = true;
                                        accumulated_text.push_str(chunk);
                                        on_event(StreamEvent::TextDelta {
                                            turn_id: request.turn_id.clone(),
                                            block_index: 0,
                                            delta: chunk.to_owned(),
                                            phase: None,
                                        });
                                    }
                                }
                                "thinking_delta" => {
                                    if let Some(chunk) =
                                        delta.get("thinking").and_then(Value::as_str)
                                        && !chunk.is_empty()
                                    {
                                        if !thinking_started {
                                            thinking_started = true;
                                            on_event(StreamEvent::ThinkingStart {
                                                turn_id: request.turn_id.clone(),
                                                stream_id: "claude-thinking-0".to_owned(),
                                                mode: ReasoningStreamMode::Reasoning,
                                            });
                                        }
                                        saw_stream_thinking_in_msg = true;
                                        accumulated_thinking.push_str(chunk);
                                        on_event(StreamEvent::ThinkingDelta {
                                            turn_id: request.turn_id.clone(),
                                            stream_id: "claude-thinking-0".to_owned(),
                                            mode: ReasoningStreamMode::Reasoning,
                                            delta: chunk.to_owned(),
                                        });
                                    }
                                }
                                _ => {}
                            }
                        }
                        _ => {}
                    }
                }
                "assistant" => {
                    if val.get("parent_tool_use_id").is_some_and(|v| !v.is_null()) {
                        continue;
                    }
                    if let Some(sid) = val.get("session_id").and_then(Value::as_str)
                        && !sid.is_empty()
                    {
                        session_id = Some(sid.to_owned());
                    }
                    if let Some(blocks) = val.pointer("/message/content").and_then(Value::as_array)
                    {
                        for block in blocks {
                            match block.get("type").and_then(Value::as_str) {
                                Some("text") if !saw_stream_text_in_msg => {
                                    if let Some(chunk) = block.get("text").and_then(Value::as_str)
                                        && !chunk.is_empty()
                                    {
                                        if !text_started {
                                            text_started = true;
                                            on_event(StreamEvent::TextStart {
                                                turn_id: request.turn_id.clone(),
                                                block_index: 0,
                                                phase: None,
                                            });
                                        }
                                        accumulated_text.push_str(chunk);
                                        on_event(StreamEvent::TextDelta {
                                            turn_id: request.turn_id.clone(),
                                            block_index: 0,
                                            delta: chunk.to_owned(),
                                            phase: None,
                                        });
                                    }
                                }
                                Some("thinking") if !saw_stream_thinking_in_msg => {
                                    if let Some(chunk) =
                                        block.get("thinking").and_then(Value::as_str)
                                        && !chunk.is_empty()
                                    {
                                        if !thinking_started {
                                            thinking_started = true;
                                            on_event(StreamEvent::ThinkingStart {
                                                turn_id: request.turn_id.clone(),
                                                stream_id: "claude-thinking-0".to_owned(),
                                                mode: ReasoningStreamMode::Reasoning,
                                            });
                                        }
                                        accumulated_thinking.push_str(chunk);
                                        on_event(StreamEvent::ThinkingDelta {
                                            turn_id: request.turn_id.clone(),
                                            stream_id: "claude-thinking-0".to_owned(),
                                            mode: ReasoningStreamMode::Reasoning,
                                            delta: chunk.to_owned(),
                                        });
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                    saw_stream_text_in_msg = false;
                    saw_stream_thinking_in_msg = false;
                    raw_events.push(val);
                }
                "result" => {
                    if let Some(sid) = val.get("session_id").and_then(Value::as_str)
                        && !sid.is_empty()
                    {
                        session_id = Some(sid.to_owned());
                    }
                    let total_cost = val.get("total_cost_usd").and_then(Value::as_f64);
                    final_usage = parse_claude_usage(val.get("usage"), total_cost);

                    if val.get("is_error").and_then(Value::as_bool) == Some(true) {
                        result_error = Some(error_text_from_result(&val));
                    } else if accumulated_text.is_empty()
                        && let Some(res_text) = val
                            .get("result")
                            .and_then(Value::as_str)
                            .filter(|s| !s.is_empty())
                    {
                        if !text_started {
                            text_started = true;
                            on_event(StreamEvent::TextStart {
                                turn_id: request.turn_id.clone(),
                                block_index: 0,
                                phase: None,
                            });
                        }
                        accumulated_text.push_str(res_text);
                        on_event(StreamEvent::TextDelta {
                            turn_id: request.turn_id.clone(),
                            block_index: 0,
                            delta: res_text.to_owned(),
                            phase: None,
                        });
                    }
                    raw_events.push(val);
                    result_received = true;
                    break;
                }
                _ => {
                    raw_events.push(val);
                }
            }
        }

        // Gracefully close stdin so the CLI flushes its session and exits cleanly.
        drop(stdin);
        let exit_status = match tokio::time::timeout(SHUTDOWN_GRACE, child.wait()).await {
            Ok(Ok(status)) => Some(status),
            _ => {
                let _ = child.kill().await;
                child.wait().await.ok()
            }
        };
        if let Some(task) = stderr_task {
            let _ = tokio::time::timeout(Duration::from_millis(250), task).await;
        }

        if let Some(err) = result_error {
            return Err(ProviderTransportError::fatal(err));
        }
        if !result_received {
            let tail = stderr_lines.lock().await.join(" | ");
            let code_info = exit_status
                .and_then(|s| s.code())
                .map(|c| format!("exit code {c}"))
                .unwrap_or_else(|| "unexpected EOF".to_owned());
            let detail = if tail.is_empty() {
                format!("Claude Agent SDK terminated without a result ({code_info}).")
            } else {
                format!("Claude Agent SDK failed ({code_info}): {tail}")
            };
            return Err(ProviderTransportError::fatal(detail));
        }

        if thinking_started {
            on_event(StreamEvent::ThinkingEnd {
                turn_id: request.turn_id.clone(),
                stream_id: "claude-thinking-0".to_owned(),
                mode: ReasoningStreamMode::Reasoning,
                text: accumulated_thinking.clone(),
                signature: None,
                redacted: false,
            });
        }
        if text_started {
            on_event(StreamEvent::TextEnd {
                turn_id: request.turn_id.clone(),
                block_index: 0,
                text: accumulated_text.clone(),
                phase: None,
                citations: Vec::new(),
                annotations: Vec::new(),
            });
        }

        let mut content = Vec::new();
        if !accumulated_thinking.is_empty() {
            content.push(ContentBlock::Thinking {
                text: accumulated_thinking,
                summary: None,
                signature: None,
                redacted: false,
                provider_meta: ProviderOpaqueMeta::default(),
            });
        }
        if !accumulated_text.is_empty() {
            content.push(ContentBlock::Text {
                text: accumulated_text,
                phase: None,
                citations: Vec::new(),
                provider_meta: ProviderOpaqueMeta::default(),
            });
        }

        let assistant = CanonicalMessage {
            id: format!("claude-msg-{}", uuid::Uuid::new_v4()),
            role: MessageRole::Assistant,
            content,
            phase: None,
            provider: Some("claude-cli".to_owned()),
            api: Some("claude-agent-sdk".to_owned()),
            model: Some(request.model_id.clone()),
            stop_reason: Some(StopReason::Stop),
            provider_meta: ProviderOpaqueMeta::default(),
            created_at: Utc::now().to_rfc3339(),
        };

        let continuation =
            if !tools_disabled && let Some(sid) = session_id.filter(|s| !s.is_empty()) {
                let mut next_prefix = request.messages.clone();
                next_prefix.push(assistant.clone());
                let fp = compute_continuation_fingerprint(&ContinuationFingerprintInput {
                    provider: "claude-cli",
                    model_id: &request.model_id,
                    system_prompt: &request.system_prompt,
                    tools: &tools_json,
                    authorized_tool_names: request.authorized_tool_names.as_deref(),
                    canonical_prefix: &next_prefix,
                    stream_options: &request.provider_options,
                });
                Some(ProviderContinuationState::ClaudeCli {
                    model: request.model_id.clone(),
                    session_id: sid,
                    updated_at: Utc::now().to_rfc3339(),
                    request_fingerprint: Some(fp),
                })
            } else {
                None
            };

        Ok(ProviderStepResult {
            assistant,
            persisted_assistant: None,
            usage: final_usage,
            continuation,
            raw_events,
        })
    }
}
