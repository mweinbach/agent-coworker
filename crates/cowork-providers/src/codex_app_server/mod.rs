mod citations;
pub mod client;
mod code_mode;
pub mod connectors;
pub mod installer;
pub mod isolation;
pub mod policy;
pub mod tool_activity;
pub mod turn_output;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use async_trait::async_trait;
use chrono::Utc;
use cowork_config::{
    ModelRegistry, ProviderName, SandboxMode, cowork_home, env_map_from_process, host_platform,
    resolve_home_dir,
};
use cowork_inference::{
    CanonicalMessage, ContentBlock, ContinuationFingerprintInput, MediaKind, MediaSource,
    MessageRole, ProviderContinuationState, ProviderOpaqueMeta, ProviderTransportError,
    ReasoningStreamMode, StepBudget, StopReason, StreamEvent, compute_continuation_fingerprint,
    filter_persisted_assistant_history, validate_continuation_state,
};
use serde_json::{Value, json};
use uuid::Uuid;

use code_mode::CodexCodeModeActivity;
use tool_activity::{CodexToolActivity, is_codex_tool_notification};
use turn_output::codex_text_phase;

use crate::transport::{
    ProviderStepRequest, ProviderStepResult, ProviderTransport, StreamEventCallback,
    candidate_continuation_splits,
};

pub use client::{
    CodexAppServerClient, CodexAppServerPool, CodexNotification, CodexTurnSteerParams,
    DynamicToolCallOutput, DynamicToolHandler,
};
pub use connectors::{
    CodexAccountInfo, CodexChatGptLoginChallenge, CodexRateLimits, OpenAiNativeConnectorInfo,
    OpenAiNativeConnectorsEvent, await_codex_chatgpt_login_completion, list_codex_models,
    logout_codex_account, parse_codex_chatgpt_login_challenge, read_codex_account,
    read_openai_native_connectors, set_openai_native_connector_enabled, start_codex_chatgpt_login,
};
pub use installer::{
    CodexRuntimeInstallOptions, CodexRuntimeTarget, install_codex_app_server,
    update_managed_codex_app_server,
};
pub use isolation::{
    CODEX_APP_SERVER_MANAGED_VERSION, CodexInstallStatus, build_codex_spawn_env,
    codex_app_server_override_configured, resolve_codex_app_server_status, resolve_codex_home,
    sync_codex_windows_sandbox_setup_state,
};
pub use policy::{
    CodexSandboxNarrowingInput, CodexSandboxNarrowingOutput, filter_codex_dynamic_tools,
    from_codex_mcp_tool_name, resolve_codex_sandbox_and_approval_policy, to_codex_mcp_tool_name,
};
pub use turn_output::{
    CodexAssistantItems, CodexTurnUsageTracker, assistant_text_from_codex_turn, parse_codex_usage,
};

/// Receives the normalized todo list (`{ content, status, activeForm }` items) whenever the
/// app-server reports a plan/todo update (TS `params.updateTodos`). Same shape as the
/// `todoWrite` tool's `on_todos_updated` callback.
pub type CodexTodosCallback = Arc<dyn Fn(Vec<Value>) + Send + Sync>;

pub trait CodexTurnObserver: Send + Sync {
    fn on_turn_started(
        &self,
        client: Arc<CodexAppServerClient>,
        codex_thread_id: &str,
        codex_turn_id: Option<&str>,
    );
}

#[derive(Clone, Default)]
pub struct CodexAppServerTransport {
    pub command_override: Option<(String, Vec<String>)>,
    pub tool_handler: Option<Arc<dyn DynamicToolHandler>>,
    pub env_override: Option<HashMap<String, String>>,
    pub turn_observer: Option<Arc<dyn CodexTurnObserver>>,
    /// Effective Cowork tool-context restrictions (read-only role, `targetPaths`, sandbox mode)
    /// that must also bound Codex's native shell/file tools, which bypass Cowork's tool checks.
    pub sandbox_restrictions: Option<CodexSandboxRestrictions>,
    /// Bundled install dir whose `config/models` registry gates per-model Codex options
    /// (`normalizeSummaryForModel`). Unset, every model is treated as unknown to the registry.
    pub built_in_dir: Option<PathBuf>,
    /// Session todo sink for app-server `todoList` updates.
    pub todos_handler: Option<CodexTodosCallback>,
    /// Managed-runtime installer settings used when the runtime must be installed before the
    /// turn; `None` derives them from the environment ([`CodexRuntimeInstallOptions::from_env`]).
    pub install_options: Option<CodexRuntimeInstallOptions>,
}

/// Trusted tool-context grants for the native Codex sandbox. Only the server supplies writable
/// roots. Workspace provider options may further restrict access or require approvals.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CodexSandboxRestrictions {
    pub mode: Option<SandboxMode>,
    pub network: Option<bool>,
    pub yolo: Option<bool>,
    pub read_only_role: bool,
    pub target_paths: Vec<PathBuf>,
}

impl std::fmt::Debug for CodexAppServerTransport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CodexAppServerTransport")
            .field("command_override", &self.command_override)
            .field("has_tool_handler", &self.tool_handler.is_some())
            .field("has_env_override", &self.env_override.is_some())
            .field("has_turn_observer", &self.turn_observer.is_some())
            .field("sandbox_restrictions", &self.sandbox_restrictions)
            .field("built_in_dir", &self.built_in_dir)
            .field("has_todos_handler", &self.todos_handler.is_some())
            .field("install_options", &self.install_options)
            .finish()
    }
}

impl CodexAppServerTransport {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_env(env: HashMap<String, String>) -> Self {
        Self {
            env_override: Some(env),
            ..Self::default()
        }
    }

    pub fn with_env_and_bridges(
        env: HashMap<String, String>,
        tool_handler: Option<Arc<dyn DynamicToolHandler>>,
        turn_observer: Option<Arc<dyn CodexTurnObserver>>,
    ) -> Self {
        Self {
            command_override: None,
            tool_handler,
            env_override: Some(env),
            turn_observer,
            sandbox_restrictions: None,
            built_in_dir: None,
            todos_handler: None,
            install_options: None,
        }
    }

    /// Resolves per-model Codex options against the model registry under `built_in_dir`.
    pub fn with_built_in_dir(mut self, built_in_dir: Option<PathBuf>) -> Self {
        self.built_in_dir = built_in_dir;
        self
    }

    /// Forwards app-server todo-list updates to the session's todo state.
    pub fn with_todos_handler(mut self, handler: Option<CodexTodosCallback>) -> Self {
        self.todos_handler = handler;
        self
    }

    /// Bounds Codex's native sandbox by the caller's effective tool-context restrictions.
    pub fn with_sandbox_restrictions(mut self, restrictions: CodexSandboxRestrictions) -> Self {
        self.sandbox_restrictions = Some(restrictions);
        self
    }

    pub fn with_command_override(command: String, args: Vec<String>) -> Self {
        Self {
            command_override: Some((command, args)),
            ..Self::default()
        }
    }

    pub fn with_command_and_handler(
        command: String,
        args: Vec<String>,
        tool_handler: Option<Arc<dyn DynamicToolHandler>>,
    ) -> Self {
        Self {
            command_override: Some((command, args)),
            tool_handler,
            ..Self::default()
        }
    }
}

impl CodexAppServerTransport {
    /// TS `resolveCodexAppServerCommand` parity: before the turn spawns the app-server, a missing
    /// runtime (or a managed runtime that is not the app-pinned version) is installed from the
    /// pinned, checksum-verified release. A stale managed runtime that cannot be updated (e.g.
    /// offline) still runs; a missing one fails the turn with the install error.
    async fn resolve_runtime_command(
        &self,
        cowork_home: &Path,
        env: &HashMap<String, String>,
    ) -> Result<(String, Vec<String>), ProviderTransportError> {
        let status = resolve_codex_app_server_status(cowork_home, env);
        let stale_managed = status.source == "managed" && status.pin_matches_current == Some(false);
        if !status.available || stale_managed {
            let opts = self
                .install_options
                .clone()
                .unwrap_or_else(|| CodexRuntimeInstallOptions::from_env(env));
            match install_codex_app_server(
                cowork_home,
                CODEX_APP_SERVER_MANAGED_VERSION,
                false,
                &opts,
            )
            .await
            {
                Ok(installed) => {
                    return Ok((installed.command.to_string_lossy().into_owned(), Vec::new()));
                }
                Err(err) if status.available => {
                    tracing::warn!(
                        "[codex-app-server] could not update the managed runtime to {CODEX_APP_SERVER_MANAGED_VERSION}; using the installed one: {err}"
                    );
                }
                Err(err) => {
                    return Err(ProviderTransportError::protocol(format!(
                        "Failed to install the Cowork-managed Codex runtime {CODEX_APP_SERVER_MANAGED_VERSION}: {err}"
                    )));
                }
            }
        }
        Ok((
            status.command.unwrap_or_else(|| "codex".to_string()),
            status.args.unwrap_or_default(),
        ))
    }
}

#[async_trait]
impl ProviderTransport for CodexAppServerTransport {
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
        let homedir = resolve_home_dir(&env, host_platform());
        let resolved_cowork_home = request
            .provider_options
            .get("coworkHome")
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .unwrap_or_else(|| cowork_home(&env));
        let cwd = request
            .provider_options
            .get("cwd")
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .or_else(|| std::env::current_dir().ok())
            .unwrap_or_else(|| homedir.clone());

        let (command, args) = match &self.command_override {
            Some((cmd, a)) => (cmd.clone(), a.clone()),
            None => {
                let cancel = budget.cancellation_token().clone();
                tokio::select! {
                    resolved = self.resolve_runtime_command(&resolved_cowork_home, &env) => resolved?,
                    () = cancel.cancelled() => {
                        return Err(ProviderTransportError::aborted("Model turn aborted."));
                    }
                }
            }
        };

        let restrictions = resolve_effective_codex_restrictions(
            self.sandbox_restrictions.as_ref(),
            &request.provider_options,
        );
        let policy = resolve_codex_sandbox_and_approval_policy(&CodexSandboxNarrowingInput {
            mode: restrictions.mode.unwrap_or(SandboxMode::WorkspaceWrite),
            network: restrictions.network.unwrap_or(false),
            yolo: restrictions.yolo.unwrap_or(false),
            workspace_dir: cwd.clone(),
            agent_target_paths: restrictions.target_paths.clone(),
            read_only_role: restrictions.read_only_role,
            has_mutation_guard_with_dynamic_tools: false,
        });

        // Scoped children keep Cowork's path-checked read/glob/grep (`runTurn.ts` parity).
        let dynamic_tools =
            filter_codex_dynamic_tools(&request.tools, !restrictions.target_paths.is_empty());
        let wire_dynamic_tools: Vec<Value> = dynamic_tools
            .iter()
            .map(|t| {
                json!({
                    "name": t.name,
                    "description": t.description,
                    "inputSchema": t.parameters,
                })
            })
            .collect();

        let resume_plan = resolve_codex_resume_plan(&request, &wire_dynamic_tools);

        let client = CodexAppServerClient::spawn_stdio(
            &command,
            &args,
            &cwd,
            &resolved_cowork_home,
            &env,
            self.tool_handler.clone(),
        )
        .await?;

        // Pre-arm notification subscription BEFORE `thread/start` and `turn/start` so fast turns never race!
        let mut notif_rx = client.subscribe_notifications();

        let config_overrides =
            codex_thread_config(&request.provider_options, !policy.force_disable_web_search);

        let thread_payload = json!({
            "model": request.model_id,
            "cwd": cwd.to_string_lossy(),
            "approvalPolicy": policy.approval_policy,
            "sandbox": policy.thread_sandbox,
            "developerInstructions": request.system_prompt,
            "dynamicTools": wire_dynamic_tools,
            "config": config_overrides,
            // Code-mode `exec`/`wait` calls only surface as raw response items (`runTurn.ts`).
            "experimentalRawEvents": true,
        });

        // Resume the stored Codex thread when the continuation fingerprint still matches the
        // canonical prefix; otherwise (missing/invalid continuation, model switch, edited history)
        // start a fresh thread seeded with the full serialized canonical history.
        let mut resumed_thread_id: Option<String> = None;
        let thread_res = match &resume_plan {
            Some((stored_thread_id, _)) => {
                let mut resume_payload = thread_payload.clone();
                resume_payload["threadId"] = Value::String(stored_thread_id.clone());
                match client.request("thread/resume", Some(resume_payload)).await {
                    Ok(res) => {
                        resumed_thread_id = Some(stored_thread_id.clone());
                        res
                    }
                    Err(err) if is_invalid_codex_thread_error(&err.message) => {
                        client
                            .request("thread/start", Some(thread_payload.clone()))
                            .await?
                    }
                    Err(err) => return Err(err),
                }
            }
            None => {
                client
                    .request("thread/start", Some(thread_payload.clone()))
                    .await?
            }
        };

        let thread_id = thread_res
            .get("thread")
            .and_then(|t| t.get("id"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .or_else(|| resumed_thread_id.clone())
            .ok_or_else(|| {
                ProviderTransportError::protocol("Codex thread/start did not return thread.id")
            })?;

        let turn_input = match (&resumed_thread_id, &resume_plan) {
            (Some(_), Some((_, delta_start))) => {
                build_codex_turn_input(&request.messages[*delta_start..], false)
            }
            _ => build_codex_turn_input(&request.messages, true),
        };
        if turn_input.is_empty() {
            return Err(ProviderTransportError::protocol(
                "codex app-server runtime requires a user message.",
            ));
        }

        let turn_res = client
            .request(
                "turn/start",
                Some({
                    let mut params = json!({
                        "threadId": thread_id,
                        "input": turn_input,
                        "sandboxPolicy": policy.turn_sandbox_policy,
                        "approvalPolicy": policy.approval_policy,
                    });
                    if let Some(effort) = codex_reasoning_effort(&request.provider_options) {
                        params["effort"] = Value::String(effort);
                    }
                    if let Some(summary) = codex_reasoning_summary(
                        &request.provider_options,
                        codex_model_declares_reasoning_summary(
                            self.built_in_dir.as_deref(),
                            &request.model_id,
                        ),
                    ) {
                        params["summary"] = Value::String(summary);
                    }
                    params
                }),
            )
            .await?;

        let codex_turn_id = turn_res
            .get("turn")
            .and_then(|t| t.get("id"))
            .or_else(|| turn_res.get("turnId"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
        if let Some(obs) = &self.turn_observer {
            obs.on_turn_started(Arc::clone(&client), &thread_id, codex_turn_id.as_deref());
        }

        let turn_id = request.turn_id.clone();
        let think_stream_id = format!("{turn_id}:codex-think");
        let mut thinking_started = false;
        let mut thinking_closed = false;
        let mut thinking_text = String::new();
        let mut items = CodexAssistantItems::new();
        let mut text_started: Vec<bool> = Vec::new();
        let mut text_ended: Vec<bool> = Vec::new();
        let mut usage_tracker = CodexTurnUsageTracker::new();
        let mut tool_activity = CodexToolActivity::new();
        let mut code_mode = CodexCodeModeActivity::new();
        let mut completed_turn: Option<Value> = None;
        let mut raw_events = Vec::new();

        // Codex turns are whole agentic loops: like the TS Codex runtime they are bounded only
        // by the step budget the harness hands us (unbounded for Codex) and cancellation.
        let wait_res = budget
            .run(async {
                // Closes the reasoning stream once assistant text starts (it never reopens).
                macro_rules! close_thinking {
                    () => {
                        if thinking_started && !thinking_closed {
                            thinking_closed = true;
                            on_event(StreamEvent::ThinkingEnd {
                                turn_id: turn_id.clone(),
                                stream_id: think_stream_id.clone(),
                                mode: ReasoningStreamMode::Summary,
                                text: thinking_text.clone(),
                                signature: None,
                                redacted: false,
                            });
                        }
                    };
                }
                while let Some(notif) = notif_rx.recv().await {
                    raw_events.push(json!({
                        "method": notif.method,
                        "params": notif.params,
                    }));
                    let params = &notif.params;
                    let item = params.get("item");
                    let item_type = item.and_then(|i| i.get("type")).and_then(Value::as_str);
                    let is_agent_message = item_type == Some("agentMessage");
                    match notif.method.as_str() {
                        "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta" => {
                            if !targets_codex_turn(params, &thread_id, codex_turn_id.as_deref()) {
                                continue;
                            }
                            if let Some(d) = params.get("delta").and_then(Value::as_str)
                                && !d.is_empty()
                            {
                                if !thinking_started {
                                    thinking_started = true;
                                    on_event(StreamEvent::ThinkingStart {
                                        turn_id: turn_id.clone(),
                                        stream_id: think_stream_id.clone(),
                                        mode: ReasoningStreamMode::Summary,
                                    });
                                }
                                thinking_text.push_str(d);
                                on_event(StreamEvent::ThinkingDelta {
                                    turn_id: turn_id.clone(),
                                    stream_id: think_stream_id.clone(),
                                    mode: ReasoningStreamMode::Summary,
                                    delta: d.to_string(),
                                });
                            }
                        }
                        // Every agentMessage item streams live as its own text block carrying its
                        // `phase` (commentary included); only non-commentary items are joined into
                        // the persisted final text (`notifications.ts` parity).
                        "item/started" if is_agent_message => {
                            if !targets_codex_turn(params, &thread_id, codex_turn_id.as_deref()) {
                                continue;
                            }
                            let item = item.unwrap_or(&Value::Null);
                            let index = items.ensure(
                                item.get("id").and_then(Value::as_str),
                                item.get("text").and_then(Value::as_str).unwrap_or(""),
                            );
                            let phase = items
                                .remember_phase(index, item.get("phase").and_then(Value::as_str));
                            text_started.resize(items.len(), false);
                            text_ended.resize(items.len(), false);
                            if !text_started[index] {
                                close_thinking!();
                                text_started[index] = true;
                                on_event(StreamEvent::TextStart {
                                    turn_id: turn_id.clone(),
                                    block_index: index,
                                    phase: codex_text_phase(phase.as_deref()),
                                });
                            }
                        }
                        "item/agentMessage/delta" => {
                            if !targets_codex_turn(params, &thread_id, codex_turn_id.as_deref()) {
                                continue;
                            }
                            let index =
                                items.ensure(params.get("itemId").and_then(Value::as_str), "");
                            let phase = items
                                .remember_phase(index, params.get("phase").and_then(Value::as_str));
                            text_started.resize(items.len(), false);
                            text_ended.resize(items.len(), false);
                            let delta = params.get("delta").and_then(Value::as_str).unwrap_or("");
                            items.append(index, delta);
                            if delta.is_empty() {
                                continue;
                            }
                            close_thinking!();
                            let phase = codex_text_phase(phase.as_deref());
                            if !text_started[index] {
                                text_started[index] = true;
                                on_event(StreamEvent::TextStart {
                                    turn_id: turn_id.clone(),
                                    block_index: index,
                                    phase,
                                });
                            }
                            on_event(StreamEvent::TextDelta {
                                turn_id: turn_id.clone(),
                                block_index: index,
                                delta: delta.to_string(),
                                phase,
                            });
                        }
                        "item/completed" if is_agent_message => {
                            if !targets_codex_turn(params, &thread_id, codex_turn_id.as_deref()) {
                                continue;
                            }
                            let item = item.unwrap_or(&Value::Null);
                            let index = items.ensure(item.get("id").and_then(Value::as_str), "");
                            let phase = codex_text_phase(
                                items
                                    .remember_phase(
                                        index,
                                        item.get("phase").and_then(Value::as_str),
                                    )
                                    .as_deref(),
                            );
                            items.set_text(
                                index,
                                item.get("text").and_then(Value::as_str).unwrap_or(""),
                            );
                            text_started.resize(items.len(), false);
                            text_ended.resize(items.len(), false);
                            if text_ended[index] {
                                continue;
                            }
                            let text = items.text(index).to_owned();
                            if !text_started[index] {
                                if text.is_empty() {
                                    continue;
                                }
                                // Completed without streamed deltas: surface the whole item.
                                close_thinking!();
                                text_started[index] = true;
                                on_event(StreamEvent::TextStart {
                                    turn_id: turn_id.clone(),
                                    block_index: index,
                                    phase,
                                });
                                on_event(StreamEvent::TextDelta {
                                    turn_id: turn_id.clone(),
                                    block_index: index,
                                    delta: text.clone(),
                                    phase,
                                });
                            }
                            text_ended[index] = true;
                            on_event(StreamEvent::TextEnd {
                                turn_id: turn_id.clone(),
                                block_index: index,
                                text,
                                phase,
                                citations: Vec::new(),
                                annotations: Vec::new(),
                            });
                        }
                        // Plan/todo updates replace the session todo list (`updateTodos`).
                        "todoList/updated" | "item/todoList/updated" => {
                            if !targets_codex_turn(params, &thread_id, codex_turn_id.as_deref()) {
                                continue;
                            }
                            if let (Some(handler), Some(todos)) =
                                (&self.todos_handler, normalize_codex_todo_list(params))
                            {
                                handler(todos);
                            }
                        }
                        "item/completed" if item_type == Some("todoList") => {
                            if !targets_codex_turn(params, &thread_id, codex_turn_id.as_deref()) {
                                continue;
                            }
                            if let (Some(handler), Some(todos)) = (
                                &self.todos_handler,
                                item.and_then(normalize_codex_todo_list),
                            ) {
                                handler(todos);
                            }
                        }
                        // `turn_error` parity: the turn's in-flight native tools fail; the turn
                        // outcome itself still comes from `turn/completed`.
                        "error" => {
                            if !targets_codex_turn(params, &thread_id, codex_turn_id.as_deref()) {
                                continue;
                            }
                            let message = codex_error_notification_message(params);
                            tool_activity.fail_open_tools(&message, &turn_id, &mut *on_event);
                        }
                        // Code-mode `exec` / `wait` calls (`notifications.ts` raw-item routing).
                        "rawResponseItem/completed" => {
                            if !targets_codex_turn(params, &thread_id, codex_turn_id.as_deref()) {
                                continue;
                            }
                            let Some(item) = item else {
                                continue;
                            };
                            let mut events = Vec::new();
                            code_mode.handle_raw_response_item(item, &turn_id, &mut |ev| {
                                events.push(ev)
                            });
                            if !events.is_empty() {
                                close_thinking!();
                                events.into_iter().for_each(&mut *on_event);
                            }
                        }
                        // Native shell/patch/MCP/dynamic tool items and their streamed output
                        // become tool stream events (`notifications.ts` parity).
                        method if is_codex_tool_notification(method, item) => {
                            if !targets_codex_turn(params, &thread_id, codex_turn_id.as_deref()) {
                                continue;
                            }
                            // Dynamic tools a visible code-mode script calls fold into it.
                            if item_type == Some("dynamicToolCall")
                                && let Some(item) = item
                                && code_mode.intercept_dynamic_tool(method, item)
                            {
                                continue;
                            }
                            close_thinking!();
                            tool_activity.handle(method, params, &turn_id, &mut *on_event);
                        }
                        "thread/tokenUsage/updated" => {
                            if !token_usage_targets_codex_turn(
                                params,
                                &thread_id,
                                codex_turn_id.as_deref(),
                            ) {
                                continue;
                            }
                            if let Some(token_usage) = params.get("tokenUsage") {
                                usage_tracker.record(token_usage);
                            }
                        }
                        "turn/completed" => {
                            let turn = params.get("turn").unwrap_or(&Value::Null);
                            let other_thread = params
                                .get("threadId")
                                .and_then(Value::as_str)
                                .is_some_and(|t| t != thread_id);
                            let other_turn = match (
                                codex_turn_id.as_deref(),
                                turn.get("id").and_then(Value::as_str),
                            ) {
                                (Some(expected), Some(got)) => expected != got,
                                _ => false,
                            };
                            if other_thread || other_turn {
                                continue;
                            }
                            completed_turn = Some(turn.clone());
                            return codex_turn_outcome(
                                turn,
                                budget.cancellation_token().is_cancelled(),
                            );
                        }
                        _ => {}
                    }
                }
                // The notification channel only closes when the app-server stdio stream ends
                // (process exit/crash); a turn that never reported `turn/completed` is incomplete.
                Err(ProviderTransportError::protocol(
                    "Codex app-server exited before the turn completed.",
                ))
            })
            .await;

        client.close().await;
        wait_res?;

        if thinking_started && !thinking_closed {
            on_event(StreamEvent::ThinkingEnd {
                turn_id: turn_id.clone(),
                stream_id: think_stream_id,
                mode: ReasoningStreamMode::Summary,
                text: thinking_text.clone(),
                signature: None,
                redacted: false,
            });
        }
        for index in 0..items.len() {
            if text_started.get(index).copied().unwrap_or(false)
                && !text_ended.get(index).copied().unwrap_or(false)
            {
                on_event(StreamEvent::TextEnd {
                    turn_id: turn_id.clone(),
                    block_index: index,
                    text: items.text(index).to_owned(),
                    phase: codex_text_phase(items.phase(index)),
                    citations: Vec::new(),
                    annotations: Vec::new(),
                });
            }
        }

        // `assistantTextFromTurn(finalTurn) || router.assistantText()`: commentary items were only
        // streamed; the persisted answer joins the remaining items with newlines.
        let final_text = completed_turn
            .as_ref()
            .map(assistant_text_from_codex_turn)
            .filter(|text| !text.is_empty())
            .unwrap_or_else(|| items.assistant_text());
        let usage = usage_tracker.usage().unwrap_or_default();

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
            provider: Some("codex-cli".to_string()),
            api: Some("codex-app-server".to_string()),
            model: Some(request.model_id.clone()),
            stop_reason: Some(StopReason::Stop),
            provider_meta: ProviderOpaqueMeta::default(),
            created_at: Utc::now().to_rfc3339(),
        };
        let persisted_assistant = filter_persisted_assistant_history(&assistant);
        let mut next_prefix = request.messages.clone();
        if let Some(ref p) = persisted_assistant {
            next_prefix.push(p.clone());
        } else {
            next_prefix.push(assistant.clone());
        }
        let fp = compute_continuation_fingerprint(&ContinuationFingerprintInput {
            provider: "codex-cli",
            model_id: &request.model_id,
            system_prompt: &request.system_prompt,
            tools: &wire_dynamic_tools,
            authorized_tool_names: request.authorized_tool_names.as_deref(),
            canonical_prefix: &next_prefix,
            stream_options: &request.provider_options,
        });
        let continuation = Some(ProviderContinuationState::CodexCli {
            model: request.model_id,
            thread_id,
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

/// `targetsActiveCodexTurn` parity: drops item notifications that name another thread or turn.
fn targets_codex_turn(params: &Value, thread_id: &str, codex_turn_id: Option<&str>) -> bool {
    let other_thread = params
        .get("threadId")
        .and_then(Value::as_str)
        .is_some_and(|t| t != thread_id);
    let other_turn = match (codex_turn_id, params.get("turnId").and_then(Value::as_str)) {
        (Some(expected), Some(got)) => expected != got,
        _ => false,
    };
    !other_thread && !other_turn
}

/// `thread/tokenUsage/updated` ownership (`notifications.ts` parity): the report must name this
/// turn, or, when it carries no turn id, explicitly name this thread.
fn token_usage_targets_codex_turn(
    params: &Value,
    thread_id: &str,
    codex_turn_id: Option<&str>,
) -> bool {
    let payload_thread = params.get("threadId").and_then(Value::as_str);
    if payload_thread.is_some_and(|t| t != thread_id) {
        return false;
    }
    match (codex_turn_id, params.get("turnId").and_then(Value::as_str)) {
        (Some(expected), Some(got)) => expected == got,
        (Some(_), None) => payload_thread == Some(thread_id),
        (None, _) => true,
    }
}

/// Maps a `turn/completed` payload to the step outcome. Failed turns and turns interrupted without
/// a caller abort are errors (`runTurn.ts` / `notifications.ts` parity); an interruption that the
/// caller requested surfaces as an abort so the harness records the turn as `interrupted`.
fn codex_turn_outcome(turn: &Value, caller_cancelled: bool) -> Result<(), ProviderTransportError> {
    let status = turn.get("status").and_then(Value::as_str).unwrap_or("");
    let detail = turn
        .get("error")
        .and_then(|e| e.get("message"))
        .and_then(Value::as_str)
        .filter(|m| !m.trim().is_empty());
    match status {
        "failed" => Err(ProviderTransportError::protocol(
            detail.unwrap_or("codex app-server turn failed."),
        )),
        "interrupted" | "cancelled" | "canceled" => {
            if caller_cancelled {
                Err(ProviderTransportError::aborted("Model turn aborted."))
            } else {
                Err(ProviderTransportError::protocol(match detail {
                    Some(d) => format!("Codex app-server turn was {status} before completion: {d}"),
                    None => format!("Codex app-server turn was {status} before completion."),
                }))
            }
        }
        _ => Ok(()),
    }
}

/// Returns `(stored_thread_id, delta_start_index)` when the stored Codex continuation is for this
/// model and its fingerprint matches a canonical prefix of `request.messages`.
fn resolve_codex_resume_plan(
    request: &ProviderStepRequest,
    wire_dynamic_tools: &[Value],
) -> Option<(String, usize)> {
    let stored = request.continuation.as_ref()?;
    let ProviderContinuationState::CodexCli {
        thread_id,
        request_fingerprint: Some(_),
        ..
    } = stored
    else {
        return None;
    };
    for (prefix, delta) in candidate_continuation_splits(&request.messages) {
        if !delta.iter().any(|m| m.role == MessageRole::User) {
            continue;
        }
        let fp = compute_continuation_fingerprint(&ContinuationFingerprintInput {
            provider: "codex-cli",
            model_id: &request.model_id,
            system_prompt: &request.system_prompt,
            tools: wire_dynamic_tools,
            authorized_tool_names: request.authorized_tool_names.as_deref(),
            canonical_prefix: prefix,
            stream_options: &request.provider_options,
        });
        if validate_continuation_state(Some(stored), "codex-cli", &request.model_id, &fp).is_some()
        {
            return Some((thread_id.clone(), prefix.len()));
        }
    }
    None
}

/// `isInvalidCodexThreadError` parity: a stored thread the app-server no longer knows about.
fn is_invalid_codex_thread_error(message: &str) -> bool {
    let normalized = message.to_lowercase();
    normalized.contains("thread")
        && [
            "not found",
            "invalid",
            "expired",
            "unknown",
            "does not exist",
        ]
        .iter()
        .any(|needle| normalized.contains(needle))
}

/// Builds Codex `turn/start` input parts (`turnInput.ts` parity). For a resumed thread only the new
/// user messages are sent; a fresh thread is seeded with the full canonical history (role-labelled
/// text, historical tool records, and image attachments) so follow-ups never lose context.
/// Builds the native `turn/steer` input for a steered user message (`runTurn.ts` parity:
/// `buildCodexTurnInput([{ role: "user", content: steer.content ?? steer.text }], { resumedThread:
/// true })`, falling back to a single text item). Text blocks (including injected reference
/// context) join into one text item and images become `image` / `localImage` items.
///
/// Returns `None` when `content` holds something the native input cannot carry faithfully
/// (non-text/non-media blocks, or inline non-image data), so the caller must not mark the steer
/// as natively delivered and should resubmit it through the regular step path instead.
pub fn codex_steer_input(text: &str, content: &[ContentBlock]) -> Option<Vec<Value>> {
    let fallback = || vec![json!({ "type": "text", "text": text, "text_elements": [] })];
    if content.is_empty() {
        return Some(fallback());
    }
    let deliverable = content.iter().all(|block| match block {
        ContentBlock::Text { .. } => true,
        ContentBlock::Media { kind, source, .. } => {
            codex_media_input_part(*kind, source).is_some()
                || !matches!(source, MediaSource::Base64 { .. })
        }
        _ => false,
    });
    if !deliverable {
        return None;
    }
    let message = CanonicalMessage {
        id: String::new(),
        role: MessageRole::User,
        content: content.to_vec(),
        phase: None,
        provider: None,
        api: None,
        model: None,
        stop_reason: None,
        provider_meta: ProviderOpaqueMeta::default(),
        created_at: String::new(),
    };
    let input = build_codex_turn_input(std::slice::from_ref(&message), false);
    Some(if input.is_empty() { fallback() } else { input })
}

fn build_codex_turn_input(messages: &[CanonicalMessage], full_history: bool) -> Vec<Value> {
    let include_role = full_history
        && messages.iter().any(|m| {
            !matches!(
                m.role,
                MessageRole::User | MessageRole::System | MessageRole::Developer
            )
        });
    let mut parts = Vec::new();
    for message in messages {
        match message.role {
            MessageRole::System | MessageRole::Developer => continue,
            MessageRole::User => {}
            _ if !full_history => continue,
            _ => {}
        }
        parts.extend(codex_input_parts_for_message(message, include_role));
    }
    parts
}

fn codex_input_parts_for_message(message: &CanonicalMessage, include_role: bool) -> Vec<Value> {
    let mut texts: Vec<String> = Vec::new();
    let mut media_parts: Vec<Value> = Vec::new();
    for block in &message.content {
        match block {
            ContentBlock::Text { text, .. } => {
                if !text.trim().is_empty() {
                    texts.push(text.clone());
                }
            }
            ContentBlock::Thinking { .. } => {}
            ContentBlock::ToolCall {
                id,
                name,
                arguments,
                ..
            } if include_role => texts.push(format!(
                "[Historical tool call] {}",
                json!({ "toolCallId": id, "toolName": name, "input": arguments })
            )),
            ContentBlock::ProviderNativeTool {
                id,
                name,
                arguments,
                result,
                is_error,
                ..
            } if include_role => texts.push(format!(
                "[Historical tool call] {}",
                json!({
                    "toolCallId": id,
                    "toolName": name,
                    "input": arguments,
                    "output": result,
                    "isError": is_error,
                })
            )),
            ContentBlock::ToolResult {
                tool_call_id,
                tool_name,
                content,
                is_error,
                ..
            } if include_role => {
                let output: Vec<Value> = content
                    .iter()
                    .map(|part| match part {
                        cowork_inference::ToolResultPart::Text { text } => json!(text),
                        cowork_inference::ToolResultPart::Media { kind, .. } => {
                            json!(format!("[{} data omitted]", kind.as_wire_str()))
                        }
                    })
                    .collect();
                texts.push(format!(
                    "[Historical tool result] {}",
                    json!({
                        "toolCallId": tool_call_id,
                        "toolName": tool_name,
                        "output": output,
                        "isError": is_error,
                    })
                ));
            }
            ContentBlock::Media { kind, source, .. } => {
                if let Some(part) = codex_media_input_part(*kind, source) {
                    media_parts.push(part);
                } else {
                    texts.push(codex_attachment_note(*kind, source));
                }
            }
            _ => {}
        }
    }
    let text = texts.join("\n").trim().to_string();
    if text.is_empty() && media_parts.is_empty() {
        return Vec::new();
    }
    let body = if text.is_empty() {
        "[attachment]".to_string()
    } else {
        text
    };
    let label = match message.role {
        MessageRole::User => "User",
        MessageRole::Assistant => "Assistant",
        MessageRole::Tool => "tool",
        MessageRole::System => "system",
        MessageRole::Developer => "developer",
    };
    let text = if include_role {
        format!("{label}: {body}")
    } else {
        body
    };
    let mut parts = vec![json!({ "type": "text", "text": text, "text_elements": [] })];
    parts.extend(media_parts);
    parts
}

fn codex_media_input_part(kind: MediaKind, source: &MediaSource) -> Option<Value> {
    let is_image = kind == MediaKind::Image
        || source
            .mime_type()
            .is_some_and(|m| m.to_ascii_lowercase().starts_with("image/"));
    if !is_image {
        return None;
    }
    Some(match source {
        MediaSource::FileRef { path, .. } => json!({ "type": "localImage", "path": path }),
        MediaSource::Url { url, .. } => json!({ "type": "image", "url": url }),
        MediaSource::Base64 { mime_type, data } => {
            let mime = if mime_type.to_ascii_lowercase().starts_with("image/") {
                mime_type.as_str()
            } else {
                "image/png"
            };
            json!({ "type": "image", "url": format!("data:{mime};base64,{data}") })
        }
    })
}

/// Codex turn input only accepts text and images; other attachments are referenced by location so
/// the agent can still open local files with its own tools.
fn codex_attachment_note(kind: MediaKind, source: &MediaSource) -> String {
    let kind = kind.as_wire_str();
    match source {
        MediaSource::FileRef { path, mime_type } => match mime_type {
            Some(m) => format!("[Attached {kind} file: {path} ({m})]"),
            None => format!("[Attached {kind} file: {path}]"),
        },
        MediaSource::Url { url, .. } => format!("[Attached {kind}: {url}]"),
        MediaSource::Base64 { mime_type, .. } => {
            format!("[Attached {kind} ({mime_type}) omitted: inline data not supported]")
        }
    }
}

/// `codex-cli.<key>` provider option, falling back to the top-level key.
fn codex_provider_option<'a>(
    provider_options: &'a serde_json::Map<String, Value>,
    key: &str,
) -> Option<&'a Value> {
    provider_options
        .get("codex-cli")
        .and_then(|o| o.get(key))
        .or_else(|| provider_options.get(key))
}

/// String `codex-cli.<key>` provider option, falling back to the top-level key.
fn codex_provider_option_str<'a>(
    provider_options: &'a serde_json::Map<String, Value>,
    key: &str,
) -> Option<&'a str> {
    codex_provider_option(provider_options, key).and_then(Value::as_str)
}

/// `codexThreadConfig` parity: the `thread/start` / `thread/resume` `config` overrides.
/// Without network access web search is forced off and its tool config dropped; otherwise
/// `webSearchMode` and the `webSearch` tool options (`contextSize`, `allowedDomains`,
/// `location`) pass through when valid.
fn codex_thread_config(
    provider_options: &serde_json::Map<String, Value>,
    web_search_allowed: bool,
) -> serde_json::Map<String, Value> {
    let mut config = serde_json::Map::new();
    // Child lifecycle, scopes, and budgets belong to Cowork's agent control.
    config.insert(
        "features".into(),
        json!({ "multi_agent": false, "multi_agent_v2": false }),
    );
    if !web_search_allowed {
        config.insert("web_search".into(), Value::String("disabled".into()));
    } else if let Some(mode) = codex_provider_option_str(provider_options, "webSearchMode")
        .filter(|v| matches!(*v, "disabled" | "cached" | "live"))
    {
        config.insert("web_search".into(), Value::String(mode.to_owned()));
    }
    if let Some(verbosity) = codex_text_verbosity(provider_options) {
        config.insert("model_verbosity".into(), Value::String(verbosity));
    }
    if web_search_allowed && let Some(tool_config) = codex_web_search_tool_config(provider_options)
    {
        config.insert("tools".into(), json!({ "web_search": tool_config }));
    }
    config
}

/// `codexWebSearchToolConfig` parity: `codex-cli.webSearch` as Codex's `tools.web_search`.
fn codex_web_search_tool_config(
    provider_options: &serde_json::Map<String, Value>,
) -> Option<Value> {
    let web_search = codex_provider_option(provider_options, "webSearch")?.as_object()?;
    let mut tool_config = serde_json::Map::new();
    if let Some(size) = web_search
        .get("contextSize")
        .and_then(Value::as_str)
        .filter(|v| matches!(*v, "low" | "medium" | "high"))
    {
        tool_config.insert("context_size".into(), Value::String(size.to_owned()));
    }
    let allowed_domains: Vec<Value> = web_search
        .get("allowedDomains")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|d| d.as_str().is_some_and(|d| !d.is_empty()))
        .cloned()
        .collect();
    if !allowed_domains.is_empty() {
        tool_config.insert("allowed_domains".into(), Value::Array(allowed_domains));
    }
    if let Some(location) = web_search.get("location").and_then(Value::as_object) {
        let location: serde_json::Map<String, Value> = ["country", "region", "city", "timezone"]
            .iter()
            .filter_map(|key| {
                let value = location.get(*key)?.as_str().filter(|v| !v.is_empty())?;
                Some(((*key).to_owned(), Value::String(value.to_owned())))
            })
            .collect();
        if !location.is_empty() {
            tool_config.insert("location".into(), Value::Object(location));
        }
    }
    (!tool_config.is_empty()).then_some(Value::Object(tool_config))
}

/// `normalizeTodoList` parity: the `todos` (or `items`) array of a todo-list payload, or the
/// payload itself when it is an array, as `{ content, status, activeForm }` items. `None` when
/// entries exist but none is a usable todo; an empty list clears the todos.
fn normalize_codex_todo_list(value: &Value) -> Option<Vec<Value>> {
    let non_empty_array = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_array)
            .filter(|a| !a.is_empty())
    };
    let candidates: &[Value] = match non_empty_array("todos").or_else(|| non_empty_array("items")) {
        Some(items) => items,
        None => value.as_array().map(Vec::as_slice).unwrap_or_default(),
    };
    let todos: Vec<Value> = candidates
        .iter()
        .filter_map(normalize_codex_todo_item)
        .collect();
    (!todos.is_empty() || candidates.is_empty()).then_some(todos)
}

/// `normalizeTodoItem` parity.
fn normalize_codex_todo_item(value: &Value) -> Option<Value> {
    let record = value.as_object()?;
    let content = ["content", "title", "text", "task"]
        .iter()
        .find_map(|key| record.get(*key).and_then(Value::as_str))
        .filter(|c| !c.is_empty())?;
    let status = match record.get("status").and_then(Value::as_str) {
        Some(s @ ("completed" | "in_progress" | "pending")) => s,
        Some("in-progress") => "in_progress",
        Some("done") => "completed",
        _ => "pending",
    };
    let active_form = record
        .get("activeForm")
        .and_then(Value::as_str)
        .or_else(|| record.get("active_form").and_then(Value::as_str))
        .unwrap_or(content);
    Some(json!({ "content": content, "status": status, "activeForm": active_form }))
}

/// Human-readable message of an app-server `error` notification (`payload.error ?? payload`).
fn codex_error_notification_message(params: &Value) -> String {
    let error = params
        .get("error")
        .filter(|e| !e.is_null())
        .unwrap_or(params);
    error
        .get("message")
        .and_then(Value::as_str)
        .or_else(|| error.as_str())
        .filter(|m| !m.trim().is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| "codex app-server error".to_owned())
}

/// Normalized `codex-cli.reasoningEffort` (top-level fallback) forwarded as `turn/start.effort`
/// (`normalizeEffort` parity: `none`/unknown values are omitted).
fn codex_reasoning_effort(provider_options: &serde_json::Map<String, Value>) -> Option<String> {
    let raw = codex_provider_option_str(provider_options, "reasoningEffort")?
        .trim()
        .to_ascii_lowercase();
    matches!(
        raw.as_str(),
        "minimal" | "light" | "low" | "medium" | "high" | "xhigh" | "max"
    )
    .then_some(raw)
}

/// `codex-cli.reasoningSummary` forwarded as `turn/start.summary` (`normalizeSummaryForModel`
/// parity): omitted for a registry model that declares no `reasoningSummary` default, otherwise
/// passed through when it is one of the app-server's summary modes.
fn codex_reasoning_summary(
    provider_options: &serde_json::Map<String, Value>,
    model_declares_summary: Option<bool>,
) -> Option<String> {
    if model_declares_summary == Some(false) {
        return None;
    }
    codex_provider_option_str(provider_options, "reasoningSummary")
        .filter(|v| matches!(*v, "auto" | "concise" | "detailed" | "none"))
        .map(ToOwned::to_owned)
}

/// `codex-cli.textVerbosity` forwarded as thread `config.model_verbosity`
/// (`normalizeTextVerbosity` parity).
fn codex_text_verbosity(provider_options: &serde_json::Map<String, Value>) -> Option<String> {
    codex_provider_option_str(provider_options, "textVerbosity")
        .filter(|v| matches!(*v, "low" | "medium" | "high"))
        .map(ToOwned::to_owned)
}

/// Whether the bundled registry entry for `model_id` declares a `reasoningSummary` default;
/// `None` when no registry is configured or the model is not in it (`getSupportedModel` miss).
fn codex_model_declares_reasoning_summary(
    built_in_dir: Option<&Path>,
    model_id: &str,
) -> Option<bool> {
    static REGISTRIES: OnceLock<Mutex<HashMap<PathBuf, Arc<ModelRegistry>>>> = OnceLock::new();
    let dir = built_in_dir?;
    let registry = {
        let cache = REGISTRIES.get_or_init(|| Mutex::new(HashMap::new()));
        let mut guard = cache.lock().unwrap_or_else(|poison| poison.into_inner());
        Arc::clone(
            guard
                .entry(dir.to_path_buf())
                .or_insert_with(|| Arc::new(ModelRegistry::load_from_builtin_dir(dir))),
        )
    };
    registry.get(ProviderName::CodexCli, model_id).map(|model| {
        model
            .provider_options_defaults
            .contains_key("reasoningSummary")
    })
}

/// Provider options can come from the workspace and cannot grant native tool permissions.
fn resolve_effective_codex_restrictions(
    transport: Option<&CodexSandboxRestrictions>,
    provider_options: &serde_json::Map<String, Value>,
) -> CodexSandboxRestrictions {
    let mut restrictions = transport
        .cloned()
        .unwrap_or_else(|| CodexSandboxRestrictions {
            mode: Some(SandboxMode::ReadOnly),
            ..Default::default()
        });
    if provider_options.get("sandboxMode").and_then(Value::as_str) == Some("read-only") {
        restrictions.mode = Some(SandboxMode::ReadOnly);
    }
    if provider_options
        .get("sandboxNetwork")
        .and_then(Value::as_bool)
        == Some(false)
    {
        restrictions.network = Some(false);
    }
    if provider_options.get("yolo").and_then(Value::as_bool) == Some(false) {
        restrictions.yolo = Some(false);
    }
    if provider_options
        .get("readOnlyRole")
        .and_then(Value::as_bool)
        == Some(true)
    {
        restrictions.read_only_role = true;
    }
    restrictions
}
