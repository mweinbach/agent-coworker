//! Native Rust `antigravity-acp` provider transport speaking the Agent Client Protocol (ACP)
//! JSON-RPC 2.0 over stdio against the Cowork-managed `antigravity acp` runtime.

pub mod installer;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

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
use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

use crate::codex_app_server::DynamicToolHandler;
use crate::managed_runtime::{kill_managed_process_tree, spawn_managed_stdio_process};
use crate::transport::{
    ProviderStepRequest, ProviderStepResult, ProviderTransport, StreamEventCallback,
    candidate_continuation_splits, request_disables_all_tools,
};

pub use installer::{
    ANTIGRAVITY_ACP_MANAGED_VERSION, AntigravityAcpInstallOptions,
    antigravity_acp_override_configured, build_antigravity_acp_spawn_env, install_antigravity_acp,
    resolve_antigravity_acp_home, resolve_antigravity_acp_status, update_managed_antigravity_acp,
};

const ACP_RPC_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Default)]
pub struct AntigravityAcpTransport {
    pub command_override: Option<(String, Vec<String>)>,
    pub env_override: Option<HashMap<String, String>>,
    pub tool_handler: Option<Arc<dyn DynamicToolHandler>>,
    pub install_options: Option<AntigravityAcpInstallOptions>,
    pub disable_tools: bool,
}

impl std::fmt::Debug for AntigravityAcpTransport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AntigravityAcpTransport")
            .field("command_override", &self.command_override)
            .field("has_env_override", &self.env_override.is_some())
            .field("has_tool_handler", &self.tool_handler.is_some())
            .field("disable_tools", &self.disable_tools)
            .finish()
    }
}

impl AntigravityAcpTransport {
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

    pub fn with_install_options(mut self, opts: AntigravityAcpInstallOptions) -> Self {
        self.install_options = Some(opts);
        self
    }
}

pub(crate) async fn ensure_antigravity_acp_runtime_command(
    cowork_home_dir: &Path,
    env: &HashMap<String, String>,
    opts: &AntigravityAcpInstallOptions,
) -> Result<(String, Vec<String>), ProviderTransportError> {
    let status = resolve_antigravity_acp_status(cowork_home_dir, env);
    let stale_managed = status.source == "managed" && status.pin_matches_current == Some(false);
    if !status.available || stale_managed {
        match install_antigravity_acp(
            cowork_home_dir,
            ANTIGRAVITY_ACP_MANAGED_VERSION,
            false,
            opts,
        )
        .await
        {
            Ok(installed) => {
                return Ok((installed.command.to_string_lossy().into_owned(), Vec::new()));
            }
            Err(err) if status.available => {
                tracing::warn!(
                    "[antigravity-acp] could not update managed runtime to {ANTIGRAVITY_ACP_MANAGED_VERSION}; using installed runtime: {err}"
                );
            }
            Err(err) => {
                return Err(ProviderTransportError::protocol(format!(
                    "Failed to install the Cowork-managed Antigravity ACP runtime {ANTIGRAVITY_ACP_MANAGED_VERSION}: {err}"
                )));
            }
        }
    }
    match status.command {
        Some(command) => Ok((command, status.args.unwrap_or_default())),
        None => Err(ProviderTransportError::protocol(status.message)),
    }
}

fn antigravity_effort(provider_options: &Map<String, Value>) -> Option<&'static str> {
    let section = provider_options
        .get("antigravity-acp")
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
        "xhigh" => Some("xhigh"),
        "max" => Some("max"),
        _ => None,
    }
}

fn extract_plain_text(msg: &CanonicalMessage) -> String {
    let mut parts = Vec::new();
    for block in &msg.content {
        if let ContentBlock::Text { text, .. } = block
            && !text.is_empty()
        {
            parts.push(text.as_str());
        }
    }
    parts.join("\n")
}

fn build_acp_prompt_blocks(
    system_prompt: &str,
    messages: &[CanonicalMessage],
    include_history: bool,
) -> Vec<Value> {
    let mut blocks = Vec::new();
    if include_history && !system_prompt.trim().is_empty() {
        blocks.push(json!({
            "type": "text",
            "text": format!("System instructions:\n{}", system_prompt.trim())
        }));
    }
    if include_history && messages.len() > 1 {
        let mut transcript = String::new();
        for msg in &messages[..messages.len() - 1] {
            let role = match msg.role {
                MessageRole::User => "User",
                MessageRole::Assistant => "Assistant",
                MessageRole::Tool => "Tool",
                MessageRole::System | MessageRole::Developer => "System",
            };
            let txt = extract_plain_text(msg);
            if !txt.trim().is_empty() {
                if !transcript.is_empty() {
                    transcript.push_str("\n\n");
                }
                transcript.push_str(role);
                transcript.push_str(": ");
                transcript.push_str(txt.trim());
            }
        }
        if !transcript.is_empty() {
            blocks.push(json!({
                "type": "text",
                "text": format!("Prior conversation context:\n{transcript}\n\nLatest user message:")
            }));
        }
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
                        "mimeType": mime_type,
                        "data": data,
                    }));
                }
                _ => {}
            }
        }
    }
    blocks
}

fn antigravity_fingerprint(request: &ProviderStepRequest, prefix: &[CanonicalMessage]) -> String {
    let mut safe_opts = Map::new();
    if let Some(effort) = antigravity_effort(&request.provider_options) {
        safe_opts.insert("reasoningEffort".into(), Value::String(effort.to_owned()));
    }
    if request_disables_all_tools(&request.provider_options) {
        safe_opts.insert("toolsDisabled".into(), Value::Bool(true));
    }
    compute_continuation_fingerprint(&ContinuationFingerprintInput {
        provider: "antigravity-acp",
        model_id: &request.model_id,
        system_prompt: &request.system_prompt,
        tools: &[],
        authorized_tool_names: request.authorized_tool_names.as_deref(),
        canonical_prefix: prefix,
        stream_options: &safe_opts,
    })
}

fn resolve_resume_acp_session(request: &ProviderStepRequest) -> Option<(&str, usize)> {
    let cont = request.continuation.as_ref()?;
    let ProviderContinuationState::AntigravityAcp { session_id, .. } = cont else {
        return None;
    };
    for (prefix, delta) in candidate_continuation_splits(&request.messages) {
        let fp = antigravity_fingerprint(request, prefix);
        if validate_continuation_state(Some(cont), "antigravity-acp", &request.model_id, &fp)
            .is_some()
            && !delta.is_empty()
        {
            return Some((session_id.as_str(), prefix.len()));
        }
    }
    None
}

type PendingAcpMap = HashMap<u64, oneshot::Sender<Result<Value, ProviderTransportError>>>;

struct AcpStdioClient {
    stdin_tx: mpsc::UnboundedSender<String>,
    pending: Arc<Mutex<PendingAcpMap>>,
    next_id: AtomicU64,
}

impl AcpStdioClient {
    async fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Option<Duration>,
    ) -> Result<Value, ProviderTransportError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().insert(id, tx);
        let payload = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        if self.stdin_tx.send(payload.to_string()).is_err() {
            self.pending.lock().remove(&id);
            return Err(ProviderTransportError::protocol(format!(
                "Antigravity ACP stdin closed before {method}"
            )));
        }
        let waited = match timeout {
            Some(dur) => tokio::time::timeout(dur, rx).await.map_err(|_| {
                self.pending.lock().remove(&id);
                ProviderTransportError::protocol(format!(
                    "Antigravity ACP request '{method}' timed out."
                ))
            })?,
            None => rx.await,
        };
        waited.map_err(|_| {
            ProviderTransportError::protocol(format!(
                "Antigravity ACP closed before replying to '{method}'."
            ))
        })?
    }

    fn notify(&self, method: &str, params: Value) {
        let payload = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        let _ = self.stdin_tx.send(payload.to_string());
    }
}

fn select_permission_option(params: &Value, approved: bool) -> Value {
    let options = params
        .get("options")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if approved {
        let chosen = options
            .iter()
            .find(|o| {
                matches!(
                    o.get("kind").and_then(Value::as_str),
                    Some("allow_once" | "allow_always")
                )
            })
            .or_else(|| options.first())
            .and_then(|o| o.get("optionId").and_then(Value::as_str));
        if let Some(opt_id) = chosen {
            return json!({
                "outcome": {
                    "outcome": "selected",
                    "optionId": opt_id,
                }
            });
        }
    } else if let Some(reject_id) = options
        .iter()
        .find(|o| {
            matches!(
                o.get("kind").and_then(Value::as_str),
                Some("reject_once" | "reject_always")
            )
        })
        .and_then(|o| o.get("optionId").and_then(Value::as_str))
    {
        return json!({
            "outcome": {
                "outcome": "selected",
                "optionId": reject_id,
            }
        });
    }
    json!({
        "outcome": {
            "outcome": "cancelled"
        }
    })
}

fn parse_acp_usage(value: &Value) -> Option<TurnUsage> {
    let usage = value.get("usage").unwrap_or(value);
    let input = usage
        .get("inputTokens")
        .or_else(|| usage.get("input_tokens"))
        .or_else(|| usage.get("promptTokens"))
        .and_then(Value::as_u64);
    let output = usage
        .get("outputTokens")
        .or_else(|| usage.get("output_tokens"))
        .or_else(|| usage.get("completionTokens"))
        .and_then(Value::as_u64);
    let cached = usage
        .get("cachedInputTokens")
        .or_else(|| usage.get("cached_read_tokens"))
        .or_else(|| usage.get("cachedTokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let reasoning = usage
        .get("thoughtTokens")
        .or_else(|| usage.get("reasoningTokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if input.is_none() && output.is_none() {
        return None;
    }
    let prompt_tokens = input.unwrap_or(0);
    let completion_tokens = output.unwrap_or(0);
    Some(TurnUsage {
        prompt_tokens,
        completion_tokens,
        total_tokens: prompt_tokens.saturating_add(completion_tokens),
        cached_prompt_tokens: (cached > 0).then_some(cached),
        cache_write_prompt_tokens: None,
        reasoning_output_tokens: (reasoning > 0).then_some(reasoning),
        estimated_cost_usd: None,
    })
}

#[async_trait]
impl ProviderTransport for AntigravityAcpTransport {
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

        let (command, mut args) = match &self.command_override {
            Some((cmd, a)) => (cmd.clone(), a.clone()),
            None => {
                let opts = self
                    .install_options
                    .clone()
                    .unwrap_or_else(|| AntigravityAcpInstallOptions::from_env(&env));
                ensure_antigravity_acp_runtime_command(&cw_home, &env, &opts).await?
            }
        };
        if !args.iter().any(|a| a == "acp") {
            args.push("acp".to_owned());
            args.push("--disable-telemetry".to_owned());
        }

        let cwd = request
            .provider_options
            .get("cwd")
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .filter(|p| p.is_dir())
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));

        let spawn_env = build_antigravity_acp_spawn_env(&cw_home, &env, request.api_key.as_deref());
        let mut child =
            spawn_managed_stdio_process(&command, &args, &cwd, &spawn_env, "Antigravity ACP")
                .map_err(ProviderTransportError::protocol)?;

        let mut child_stdin = child.stdin.take().ok_or_else(|| {
            ProviderTransportError::protocol("Failed to capture Antigravity ACP stdin")
        })?;
        let child_stdout = child.stdout.take().ok_or_else(|| {
            ProviderTransportError::protocol("Failed to capture Antigravity ACP stdout")
        })?;
        let child_stderr = child.stderr.take();

        if let Some(stderr) = child_stderr {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(_)) = lines.next_line().await {}
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

        let pending: Arc<Mutex<PendingAcpMap>> = Arc::new(Mutex::new(HashMap::new()));
        let (notif_tx, mut notif_rx) = mpsc::unbounded_channel::<(String, Value)>();

        let pending_reader = Arc::clone(&pending);
        let stdin_for_reqs = stdin_tx.clone();
        let handler_for_reqs = self.tool_handler.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(child_stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let Ok(msg) = serde_json::from_str::<Value>(trimmed) else {
                    continue;
                };
                let Some(obj) = msg.as_object() else {
                    continue;
                };
                let id_opt = obj.get("id").cloned();
                let method_opt = obj
                    .get("method")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned);

                match (id_opt, method_opt) {
                    (Some(req_id), Some(method)) => {
                        let params = obj.get("params").cloned().unwrap_or(Value::Null);
                        let tx_reply = stdin_for_reqs.clone();
                        let handler = handler_for_reqs.clone();
                        tokio::spawn(async move {
                            let reply = if method == "session/request_permission" {
                                let approved = if let Some(h) = handler {
                                    h.request_approval(&method, &params).await
                                } else {
                                    false
                                };
                                json!({
                                    "jsonrpc": "2.0",
                                    "id": req_id,
                                    "result": select_permission_option(&params, approved),
                                })
                            } else {
                                json!({
                                    "jsonrpc": "2.0",
                                    "id": req_id,
                                    "error": {
                                        "code": -32601,
                                        "message": format!("Unsupported ACP client method: {method}")
                                    }
                                })
                            };
                            let _ = tx_reply.send(reply.to_string());
                        });
                    }
                    (Some(resp_id), None) => {
                        if let Some(id_num) = resp_id.as_u64()
                            && let Some(tx) = pending_reader.lock().remove(&id_num)
                        {
                            if let Some(err) = obj.get("error") {
                                let msg = err
                                    .get("message")
                                    .and_then(Value::as_str)
                                    .unwrap_or("Antigravity ACP RPC error");
                                let _ = tx.send(Err(ProviderTransportError::protocol(msg)));
                            } else {
                                let _ =
                                    tx.send(Ok(obj.get("result").cloned().unwrap_or(Value::Null)));
                            }
                        }
                    }
                    (None, Some(method)) => {
                        let params = obj.get("params").cloned().unwrap_or(Value::Null);
                        let _ = notif_tx.send((method, params));
                    }
                    _ => {}
                }
            }
            // Fail all pending RPCs on EOF.
            let mut guard = pending_reader.lock();
            for (_, tx) in guard.drain() {
                let _ = tx.send(Err(ProviderTransportError::protocol(
                    "Antigravity ACP process exited unexpectedly.",
                )));
            }
        });

        let client = Arc::new(AcpStdioClient {
            stdin_tx: stdin_tx.clone(),
            pending,
            next_id: AtomicU64::new(1),
        });

        let cancel = budget.cancellation_token().clone();
        let turn_id = request.turn_id.clone();
        let resume_plan = resolve_resume_acp_session(&request);
        let tools_disabled =
            self.disable_tools || request_disables_all_tools(&request.provider_options);

        let setup_res = async {
            let init_res = client
                .request(
                    "initialize",
                    json!({
                        "protocolVersion": 1,
                        "clientInfo": {
                            "name": "agent-coworker",
                            "version": env!("CARGO_PKG_VERSION"),
                        },
                        "clientCapabilities": {},
                    }),
                    Some(ACP_RPC_TIMEOUT),
                )
                .await?;

            // Authenticate via Gemini API key if the agent advertises authMethods and we have a key.
            let advertises_gemini_key = init_res
                .get("authMethods")
                .and_then(Value::as_array)
                .is_some_and(|methods| {
                    methods
                        .iter()
                        .any(|m| m.get("id").and_then(Value::as_str) == Some("gemini-api-key"))
                });
            if advertises_gemini_key
                && request
                    .api_key
                    .as_deref()
                    .is_some_and(|k| !k.trim().is_empty())
            {
                let _ = client
                    .request(
                        "authenticate",
                        json!({ "methodId": "gemini-api-key" }),
                        Some(ACP_RPC_TIMEOUT),
                    )
                    .await;
            }

            let cwd_str = cwd.to_string_lossy().into_owned();
            let mut resumed = false;
            let session_id = if let Some((stored_sid, _)) = resume_plan {
                match client
                    .request(
                        "session/resume",
                        json!({
                            "sessionId": stored_sid,
                            "cwd": cwd_str,
                            "mcpServers": [],
                        }),
                        Some(ACP_RPC_TIMEOUT),
                    )
                    .await
                {
                    Ok(_) => {
                        resumed = true;
                        stored_sid.to_owned()
                    }
                    Err(_) => {
                        let created = client
                            .request(
                                "session/new",
                                json!({ "cwd": cwd_str, "mcpServers": [] }),
                                Some(ACP_RPC_TIMEOUT),
                            )
                            .await?;
                        created
                            .get("sessionId")
                            .and_then(Value::as_str)
                            .map(ToOwned::to_owned)
                            .ok_or_else(|| {
                                ProviderTransportError::protocol(
                                    "Antigravity ACP session/new did not return sessionId",
                                )
                            })?
                    }
                }
            } else {
                let created = client
                    .request(
                        "session/new",
                        json!({ "cwd": cwd_str, "mcpServers": [] }),
                        Some(ACP_RPC_TIMEOUT),
                    )
                    .await?;
                created
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
                    .ok_or_else(|| {
                        ProviderTransportError::protocol(
                            "Antigravity ACP session/new did not return sessionId",
                        )
                    })?
            };

            let _ = client
                .request(
                    "session/set_model",
                    json!({ "sessionId": session_id, "modelId": request.model_id }),
                    Some(ACP_RPC_TIMEOUT),
                )
                .await;

            if let Some(effort) = antigravity_effort(&request.provider_options) {
                let _ = client
                    .request(
                        "session/set_config_option",
                        json!({
                            "sessionId": session_id,
                            "configId": "thought_level",
                            "value": effort,
                        }),
                        Some(ACP_RPC_TIMEOUT),
                    )
                    .await;
            }
            if tools_disabled {
                let _ = client
                    .request(
                        "session/set_config_option",
                        json!({
                            "sessionId": session_id,
                            "configId": "tools_enabled",
                            "value": false,
                        }),
                        Some(ACP_RPC_TIMEOUT),
                    )
                    .await;
            }

            Ok::<(String, bool), ProviderTransportError>((session_id, resumed))
        };

        let (session_id, resumed) = match tokio::select! {
            res = setup_res => res,
            () = cancel.cancelled() => Err(ProviderTransportError::aborted("Model turn aborted.")),
        } {
            Ok(v) => v,
            Err(err) => {
                drop(stdin_tx);
                kill_managed_process_tree(child).await;
                return Err(err);
            }
        };

        let prompt_blocks = match (resumed, resume_plan) {
            (true, Some((_, delta_start))) => {
                build_acp_prompt_blocks("", &request.messages[delta_start..], false)
            }
            _ => build_acp_prompt_blocks(&request.system_prompt, &request.messages, true),
        };
        if prompt_blocks.is_empty() {
            drop(stdin_tx);
            kill_managed_process_tree(child).await;
            return Err(ProviderTransportError::protocol(
                "Antigravity ACP runtime requires a user message.",
            ));
        }

        // Launch session/prompt RPC concurrently while draining `session/update` notifications.
        let prompt_client = Arc::clone(&client);
        let prompt_sid = session_id.clone();
        let prompt_fut = tokio::spawn(async move {
            prompt_client
                .request(
                    "session/prompt",
                    json!({
                        "sessionId": prompt_sid,
                        "prompt": prompt_blocks,
                    }),
                    None,
                )
                .await
        });

        let mut raw_events = Vec::new();
        let mut thinking_started = false;
        let mut thinking_closed = false;
        let mut think_segment: usize = 0;
        let mut think_stream_id = format!("{turn_id}:acp-think-0");
        let mut thinking_text = String::new();
        let mut thinking_segment_text = String::new();
        let mut text_started = false;
        let mut final_text = String::new();
        let mut announced_tools: HashSet<String> = HashSet::new();
        let mut usage = TurnUsage::default();

        let prompt_outcome = budget
            .run(async {
                tokio::pin!(prompt_fut);
                let handle_notif =
                    |method: &str,
                     params: &Value,
                     raw_events: &mut Vec<Value>,
                     thinking_started: &mut bool,
                     thinking_closed: &mut bool,
                     think_segment: &mut usize,
                     think_stream_id: &mut String,
                     thinking_text: &mut String,
                     thinking_segment_text: &mut String,
                     text_started: &mut bool,
                     final_text: &mut String,
                     announced_tools: &mut HashSet<String>,
                     usage: &mut TurnUsage,
                     on_event: &mut StreamEventCallback<'_>| {
                        raw_events.push(json!({ "method": method, "params": params }));
                        if method != "session/update" {
                            return;
                        }
                        let update = params.get("update").unwrap_or(params);
                        let kind = update
                            .get("sessionUpdate")
                            .or_else(|| update.get("type"))
                            .and_then(Value::as_str)
                            .unwrap_or("");
                        let extract_chunk_text = |u: &Value| -> Option<String> {
                            u.get("content")
                                .and_then(|c| c.get("text"))
                                .or_else(|| u.get("text"))
                                .or_else(|| u.get("delta"))
                                .and_then(Value::as_str)
                                .filter(|s| !s.is_empty())
                                .map(ToOwned::to_owned)
                        };
                        match kind {
                            "agent_thought_chunk" => {
                                if let Some(d) = extract_chunk_text(update) {
                                    if !*thinking_started || *thinking_closed {
                                        if *thinking_closed {
                                            *think_segment += 1;
                                            *think_stream_id =
                                                format!("{turn_id}:acp-think-{think_segment}");
                                            *thinking_closed = false;
                                        }
                                        *thinking_started = true;
                                        thinking_segment_text.clear();
                                        on_event(StreamEvent::ThinkingStart {
                                            turn_id: turn_id.clone(),
                                            stream_id: think_stream_id.clone(),
                                            mode: ReasoningStreamMode::Summary,
                                        });
                                    }
                                    thinking_text.push_str(&d);
                                    thinking_segment_text.push_str(&d);
                                    on_event(StreamEvent::ThinkingDelta {
                                        turn_id: turn_id.clone(),
                                        stream_id: think_stream_id.clone(),
                                        mode: ReasoningStreamMode::Summary,
                                        delta: d,
                                    });
                                }
                            }
                            "agent_message_chunk" => {
                                if let Some(d) = extract_chunk_text(update) {
                                    if *thinking_started && !*thinking_closed {
                                        *thinking_closed = true;
                                        on_event(StreamEvent::ThinkingEnd {
                                            turn_id: turn_id.clone(),
                                            stream_id: think_stream_id.clone(),
                                            mode: ReasoningStreamMode::Summary,
                                            text: std::mem::take(thinking_segment_text),
                                            signature: None,
                                            redacted: false,
                                        });
                                    }
                                    if !*text_started {
                                        *text_started = true;
                                        on_event(StreamEvent::TextStart {
                                            turn_id: turn_id.clone(),
                                            block_index: 0,
                                            phase: None,
                                        });
                                    }
                                    final_text.push_str(&d);
                                    on_event(StreamEvent::TextDelta {
                                        turn_id: turn_id.clone(),
                                        block_index: 0,
                                        delta: d,
                                        phase: None,
                                    });
                                }
                            }
                            "tool_call" => {
                                if *thinking_started && !*thinking_closed {
                                    *thinking_closed = true;
                                    on_event(StreamEvent::ThinkingEnd {
                                        turn_id: turn_id.clone(),
                                        stream_id: think_stream_id.clone(),
                                        mode: ReasoningStreamMode::Summary,
                                        text: std::mem::take(thinking_segment_text),
                                        signature: None,
                                        redacted: false,
                                    });
                                }
                                let id = update
                                    .get("toolCallId")
                                    .and_then(Value::as_str)
                                    .unwrap_or("")
                                    .to_owned();
                                let name = update
                                    .get("title")
                                    .or_else(|| update.get("name"))
                                    .or_else(|| update.get("kind"))
                                    .and_then(Value::as_str)
                                    .unwrap_or("tool")
                                    .to_owned();
                                let input = update
                                    .get("rawInput")
                                    .and_then(Value::as_object)
                                    .cloned()
                                    .unwrap_or_default();
                                if !id.is_empty() && announced_tools.insert(id.clone()) {
                                    on_event(StreamEvent::ToolCallStart {
                                        turn_id: turn_id.clone(),
                                        key: id.clone(),
                                        name: name.clone(),
                                        initial_args: (!input.is_empty()).then(|| input.clone()),
                                    });
                                    on_event(StreamEvent::ToolCallEnd {
                                        turn_id: turn_id.clone(),
                                        key: id,
                                        name,
                                        arguments: Some(input),
                                        retry_of: None,
                                        input_digest: None,
                                    });
                                }
                            }
                            "tool_call_update" => {
                                let id = update
                                    .get("toolCallId")
                                    .and_then(Value::as_str)
                                    .unwrap_or("")
                                    .to_owned();
                                let status =
                                    update.get("status").and_then(Value::as_str).unwrap_or("");
                                if !id.is_empty() && matches!(status, "completed" | "failed") {
                                    let name = update
                                        .get("title")
                                        .or_else(|| update.get("kind"))
                                        .and_then(Value::as_str)
                                        .unwrap_or("tool")
                                        .to_owned();
                                    let output = update
                                        .get("rawOutput")
                                        .or_else(|| update.get("content"))
                                        .cloned()
                                        .unwrap_or(Value::Null);
                                    on_event(StreamEvent::ToolResult {
                                        turn_id: turn_id.clone(),
                                        key: id,
                                        name,
                                        result: output,
                                        is_error: status == "failed",
                                        denied: false,
                                    });
                                }
                            }
                            "usage_update" => {
                                if let Some(u) = parse_acp_usage(update) {
                                    *usage = u;
                                }
                            }
                            _ => {}
                        }
                    };

                loop {
                    tokio::select! {
                        biased;
                        () = cancel.cancelled() => {
                            client.notify("session/cancel", json!({ "sessionId": session_id }));
                            return Err(ProviderTransportError::aborted("Model turn aborted."));
                        }
                        maybe_notif = notif_rx.recv() => {
                            if let Some((method, params)) = maybe_notif {
                                handle_notif(
                                    &method,
                                    &params,
                                    &mut raw_events,
                                    &mut thinking_started,
                                    &mut thinking_closed,
                                    &mut think_segment,
                                    &mut think_stream_id,
                                    &mut thinking_text,
                                    &mut thinking_segment_text,
                                    &mut text_started,
                                    &mut final_text,
                                    &mut announced_tools,
                                    &mut usage,
                                    on_event,
                                );
                            }
                        }
                        prompt_res = &mut prompt_fut => {
                            // Drain any buffered notifications emitted just before the prompt reply.
                            while let Ok((method, params)) = notif_rx.try_recv() {
                                handle_notif(
                                    &method,
                                    &params,
                                    &mut raw_events,
                                    &mut thinking_started,
                                    &mut thinking_closed,
                                    &mut think_segment,
                                    &mut think_stream_id,
                                    &mut thinking_text,
                                    &mut thinking_segment_text,
                                    &mut text_started,
                                    &mut final_text,
                                    &mut announced_tools,
                                    &mut usage,
                                    on_event,
                                );
                            }
                            let res = prompt_res.map_err(|e| {
                                ProviderTransportError::protocol(format!(
                                    "Antigravity ACP prompt task failed: {e}"
                                ))
                            })??;
                            return Ok(res);
                        }
                    }
                }
            })
            .await;

        drop(stdin_tx);
        kill_managed_process_tree(child).await;

        let prompt_result = prompt_outcome?;
        if let Some(u) = parse_acp_usage(&prompt_result) {
            usage = u;
        }
        if thinking_started && !thinking_closed {
            on_event(StreamEvent::ThinkingEnd {
                turn_id: turn_id.clone(),
                stream_id: think_stream_id,
                mode: ReasoningStreamMode::Summary,
                text: thinking_segment_text,
                signature: None,
                redacted: false,
            });
        }
        if text_started {
            on_event(StreamEvent::TextEnd {
                turn_id: turn_id.clone(),
                block_index: 0,
                text: final_text.clone(),
                phase: None,
                citations: Vec::new(),
                annotations: Vec::new(),
            });
        }

        let mut content = Vec::new();
        if !thinking_text.is_empty() {
            content.push(ContentBlock::Thinking {
                text: thinking_text,
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
            provider: Some("antigravity-acp".to_owned()),
            api: Some("antigravity-acp".to_owned()),
            model: Some(request.model_id.clone()),
            stop_reason: Some(StopReason::Stop),
            provider_meta: ProviderOpaqueMeta::default(),
            created_at: Utc::now().to_rfc3339(),
        };
        let persisted_assistant = filter_persisted_assistant_history(&assistant);

        let mut next_prefix = request.messages.clone();
        next_prefix.push(persisted_assistant.as_ref().unwrap_or(&assistant).clone());
        let fp = antigravity_fingerprint(&request, &next_prefix);
        let continuation = Some(ProviderContinuationState::AntigravityAcp {
            model: request.model_id,
            session_id,
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
