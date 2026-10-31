use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use chrono::Utc;
use cowork_config::ProviderName;
use cowork_inference::{
    CanonicalMessage, ClientCapabilities as ProjectorCapabilities, ContentBlock,
    ContinuationFingerprintInput, MessageRole, ProviderContinuationState, ProviderOpaqueMeta,
    RequestPolicy, SessionCostTracker, StepBudget, StreamEvent, StreamEventProjector,
    ToolDefinition, ToolResultPart, TurnUsage, compute_continuation_fingerprint,
    execute_step_with_sink, validate_continuation_state,
};
use cowork_providers::codex_app_server::{DynamicToolCallOutput, DynamicToolHandler};
use cowork_providers::{ProviderStepRequest, ProviderTransport};
use cowork_tools::{
    ApprovalDecisionRequest, ApprovalHandler, DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS,
    DeferredToolCatalog, StructuredQuestionOption, StructuredUserQuestion, ToolBatchCall,
    ToolExecutionContext, ToolMap, ToolOutput, create_builtin_tools, execute_tool_batch,
    maybe_spill_tool_output_with_inner,
};
use serde_json::{Map, Value, json};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::interactions::{HarnessEventSink, InteractionManager};
use crate::steer::SteerCoordinator;

#[derive(Debug, Clone)]
pub struct TurnRunConfig {
    pub thread_id: String,
    pub turn_id: String,
    pub provider: ProviderName,
    pub model_id: String,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    pub extra_headers: HashMap<String, String>,
    pub system_prompt: String,
    pub provider_options: Map<String, Value>,
    pub deferred_tool_search: bool,
    pub max_steps: usize,
    pub step_timeout_ms: u64,
    pub overflow_threshold_chars: Option<usize>,
    pub tool_retry_lineage: bool,
    pub initial_user_message: Option<(String, Option<String>)>,
}

#[derive(Debug)]
pub struct TurnRunOutcome {
    pub status: String,
    pub messages: Vec<CanonicalMessage>,
    pub usage: TurnUsage,
    pub last_assistant_text: Option<String>,
    pub updated_continuation: Option<ProviderContinuationState>,
}

#[derive(Clone)]
pub struct TurnCancellationHandle {
    cancel_token: CancellationToken,
    cancel_tx: watch::Sender<bool>,
}

impl TurnCancellationHandle {
    pub fn interrupt(&self, _reason: &str) {
        self.cancel_token.cancel();
        let _ = self.cancel_tx.send(true);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancel_token.is_cancelled()
    }
}

pub struct TurnStepRunner {
    cfg: TurnRunConfig,
    cancel_token: CancellationToken,
    cancel_tx: watch::Sender<bool>,
    cancel_rx: watch::Receiver<bool>,
}

impl TurnStepRunner {
    pub fn new(cfg: TurnRunConfig) -> Self {
        let cancel_token = CancellationToken::new();
        let (cancel_tx, cancel_rx) = watch::channel(false);
        Self {
            cfg,
            cancel_token,
            cancel_tx,
            cancel_rx,
        }
    }

    pub fn cancellation_handle(&self) -> TurnCancellationHandle {
        TurnCancellationHandle {
            cancel_token: self.cancel_token.clone(),
            cancel_tx: self.cancel_tx.clone(),
        }
    }

    /// Creates a `DynamicToolHandler` bridging Codex App-Server dynamic tool calls,
    /// command/file approvals, and `requestUserInput` prompts to `cowork-tools` + `InteractionManager`.
    pub fn build_codex_dynamic_tool_handler(
        tools: ToolMap,
        tool_ctx: ToolExecutionContext,
        interactions: Arc<InteractionManager>,
        overflow_threshold: Option<usize>,
    ) -> Arc<dyn DynamicToolHandler> {
        Arc::new(CodexDynamicBridge {
            tools,
            tool_ctx,
            interactions,
            overflow_threshold,
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn run_turn(
        &self,
        transport: Arc<dyn ProviderTransport>,
        mut history: Vec<CanonicalMessage>,
        tool_ctx: &mut ToolExecutionContext,
        interactions: &Arc<InteractionManager>,
        steer: &Arc<SteerCoordinator>,
        cost_tracker: &mut SessionCostTracker,
        initial_continuation: Option<ProviderContinuationState>,
        sink: Arc<dyn HarnessEventSink>,
    ) -> TurnRunOutcome {
        tool_ctx.cancel_rx = Some(self.cancel_rx.clone());
        tool_ctx.clear_stop_after_step();

        let mut tools_map = create_builtin_tools(tool_ctx);
        if self.cfg.deferred_tool_search
            && let (Some(cache), Some(agent_cfg)) =
                (&tool_ctx.mcp_tool_cache, &tool_ctx.agent_config)
            && agent_cfg.enable_mcp
        {
            tools_map.remove("toolSearch");
            tools_map.remove("mcpCall");
            if !tool_ctx.read_only_role {
                let agent_cfg_cloned = Arc::clone(agent_cfg);
                let env_cloned = tool_ctx.env.clone();
                let allowed_servers = tool_ctx.allowed_mcp_servers.clone();
                let existing_keys: BTreeSet<String> = tools_map.keys().cloned().collect();
                if let Ok(mcp_adapters) = cache
                    .with_tools(
                        &agent_cfg_cloned,
                        &env_cloned,
                        &tool_ctx.session_id,
                        move |loaded, _| {
                            let mut out: Vec<Arc<dyn cowork_tools::BuiltinTool>> = Vec::new();
                            for t in loaded {
                                if let Some(ref allow) = allowed_servers
                                    && !allow.contains(&t.server_name)
                                {
                                    continue;
                                }
                                if !existing_keys.contains(&t.qualified_name) {
                                    out.push(
                                        cowork_tools::LoadedMcpBuiltinToolAdapter::into_builtin(
                                            t.clone(),
                                        ),
                                    );
                                }
                            }
                            Box::pin(async move { out })
                        },
                    )
                    .await
                {
                    for adapter in mcp_adapters {
                        tools_map.insert(adapter.name().to_owned(), adapter);
                    }
                }
            }
        }
        let deferred_catalog = DeferredToolCatalog::new(tools_map.clone());
        let mut activated_deferred_tools = BTreeSet::<String>::new();

        let mut projector = StreamEventProjector::new(
            &self.cfg.thread_id,
            ProjectorCapabilities {
                tool_retry_lineage: self.cfg.tool_retry_lineage,
            },
        );

        let emit_stream_event = |proj: &mut StreamEventProjector, ev: &StreamEvent| {
            for notif in proj.project(ev) {
                sink.send_notification(&notif.method, notif.params);
            }
        };

        emit_stream_event(
            &mut projector,
            &StreamEvent::TurnStarted {
                turn_id: self.cfg.turn_id.clone(),
            },
        );
        if let Some((ref user_text, ref client_msg_id)) = self.cfg.initial_user_message {
            emit_stream_event(
                &mut projector,
                &StreamEvent::UserMessage {
                    turn_id: self.cfg.turn_id.clone(),
                    text: user_text.clone(),
                    client_message_id: client_msg_id.clone(),
                    steer_request_id: None,
                    annotations: Vec::new(),
                },
            );
        }

        let mut current_continuation = initial_continuation;
        let mut total_usage = TurnUsage::default();
        let mut last_assistant_text: Option<String> = None;
        let mut status = "completed".to_owned();
        let mut emitted_budget_exceeded = false;
        let max_steps = self.cfg.max_steps.max(1);

        'step_loop: for _step in 0..max_steps {
            if self.cancel_token.is_cancelled() || *self.cancel_rx.borrow() {
                status = "interrupted".to_owned();
                break 'step_loop;
            }

            if cost_tracker.is_budget_exceeded() {
                let b = cost_tracker.get_budget_status();
                let cur = b.current_cost_usd.unwrap_or_default();
                let thr = b.stop_at_usd.unwrap_or_default();
                let msg =
                    format!("Session cost budget exceeded (${cur:.4} >= ${thr:.4} stopAtUsd).");
                if !emitted_budget_exceeded {
                    sink.send_notification(
                        "cowork/session/budgetExceeded",
                        json!({
                            "type": "budget_exceeded",
                            "sessionId": self.cfg.thread_id,
                            "currentCostUsd": cur,
                            "thresholdUsd": thr,
                            "message": msg,
                        }),
                    );
                }
                emit_stream_event(
                    &mut projector,
                    &StreamEvent::Error {
                        turn_id: self.cfg.turn_id.clone(),
                        message: msg,
                        code: Some("validation_failed".to_owned()),
                    },
                );
                status = "failed".to_owned();
                break 'step_loop;
            }

            // Step-boundary injection of any queued `turn/steer` prompts
            for entry in steer.drain_pending() {
                emit_stream_event(
                    &mut projector,
                    &StreamEvent::UserMessage {
                        turn_id: self.cfg.turn_id.clone(),
                        text: entry.text.clone(),
                        client_message_id: entry.client_message_id,
                        steer_request_id: Some(entry.request_id),
                        annotations: Vec::new(),
                    },
                );
                history.push(new_user_text_message(&entry.text));
            }

            let step_tool_defs: Vec<ToolDefinition> = if self.cfg.deferred_tool_search {
                deferred_catalog.active_tool_definitions(&activated_deferred_tools)
            } else {
                tools_map.values().map(|t| t.definition()).collect()
            };
            let tool_values: Vec<Value> = step_tool_defs
                .iter()
                .filter_map(|d| serde_json::to_value(d).ok())
                .collect();
            let auth_names: Vec<String> = step_tool_defs.iter().map(|d| d.name.clone()).collect();

            let fp = compute_continuation_fingerprint(&ContinuationFingerprintInput {
                provider: self.cfg.provider.as_str(),
                model_id: &self.cfg.model_id,
                system_prompt: &self.cfg.system_prompt,
                tools: &tool_values,
                authorized_tool_names: Some(&auth_names),
                canonical_prefix: &history,
                stream_options: &self.cfg.provider_options,
            });
            let valid_cont = validate_continuation_state(
                current_continuation.as_ref(),
                self.cfg.provider.as_str(),
                &self.cfg.model_id,
                &fp,
            )
            .cloned();

            let req_template = ProviderStepRequest {
                model_id: self.cfg.model_id.clone(),
                base_url: self.cfg.base_url.clone(),
                api_key: self.cfg.api_key.clone(),
                extra_headers: self.cfg.extra_headers.clone(),
                system_prompt: self.cfg.system_prompt.clone(),
                messages: history.clone(),
                tools: step_tool_defs,
                authorized_tool_names: Some(auth_names.clone()),
                provider_options: self.cfg.provider_options.clone(),
                continuation: valid_cont,
                policy: RequestPolicy::default(),
                turn_id: self.cfg.turn_id.clone(),
            };

            let budget = StepBudget::new(self.cfg.step_timeout_ms, Some(self.cancel_token.clone()));
            let policy = req_template.policy;
            let mut sink_fn = |ev: StreamEvent| {
                emit_stream_event(&mut projector, &ev);
            };
            let transport_step = Arc::clone(&transport);
            let step_result = execute_step_with_sink(
                &policy,
                &budget,
                &mut sink_fn,
                &mut |_attempt, mut emit_cb| {
                    let t = Arc::clone(&transport_step);
                    let r = req_template.clone();
                    let b = budget.clone();
                    async move { t.stream_step(r, &b, &mut *emit_cb).await }
                },
            )
            .await;

            let step_ok = match step_result {
                Ok(res) => res,
                Err(err) => {
                    if err.is_abort || self.cancel_token.is_cancelled() {
                        status = "interrupted".to_owned();
                    } else {
                        status = "failed".to_owned();
                        emit_stream_event(
                            &mut projector,
                            &StreamEvent::Error {
                                turn_id: self.cfg.turn_id.clone(),
                                message: err.message,
                                code: err.code,
                            },
                        );
                    }
                    break 'step_loop;
                }
            };

            accumulate_usage(&mut total_usage, &step_ok.usage);
            let budget_before = cost_tracker.get_budget_status();
            let warn_before = budget_before.warning_triggered;
            let stop_before = budget_before.stop_triggered;
            cost_tracker.record_turn(
                &self.cfg.turn_id,
                self.cfg.provider,
                &self.cfg.model_id,
                step_ok.usage.clone(),
                None,
            );
            let budget_now = cost_tracker.get_budget_status();
            if !warn_before && budget_now.warning_triggered {
                let cur = budget_now.current_cost_usd.unwrap_or_default();
                let thr = budget_now.warn_at_usd.unwrap_or_default();
                sink.send_notification(
                    "cowork/session/budgetWarning",
                    json!({
                        "type": "budget_warning",
                        "sessionId": self.cfg.thread_id,
                        "currentCostUsd": cur,
                        "thresholdUsd": thr,
                        "message": format!("Session cost (${cur:.4}) reached budget warning threshold (${thr:.4})."),
                    }),
                );
            }
            if !stop_before && budget_now.stop_triggered && !emitted_budget_exceeded {
                emitted_budget_exceeded = true;
                let cur = budget_now.current_cost_usd.unwrap_or_default();
                let thr = budget_now.stop_at_usd.unwrap_or_default();
                sink.send_notification(
                    "cowork/session/budgetExceeded",
                    json!({
                        "type": "budget_exceeded",
                        "sessionId": self.cfg.thread_id,
                        "currentCostUsd": cur,
                        "thresholdUsd": thr,
                        "message": format!("Session cost budget exceeded (${cur:.4} >= ${thr:.4} stopAtUsd)."),
                    }),
                );
            }

            let mut tool_calls = Vec::<ToolBatchCall>::new();
            for block in &step_ok.assistant.content {
                match block {
                    ContentBlock::Text { text, .. } if !text.trim().is_empty() => {
                        last_assistant_text = Some(text.clone());
                    }
                    ContentBlock::ToolCall {
                        id,
                        name,
                        arguments,
                        ..
                    } => {
                        tool_calls.push(ToolBatchCall {
                            call_id: id.clone(),
                            tool_name: name.clone(),
                            arguments: arguments.clone(),
                        });
                    }
                    _ => {}
                }
            }

            let persisted_assistant = step_ok
                .persisted_assistant
                .unwrap_or_else(|| step_ok.assistant.clone());
            history.push(persisted_assistant);

            // Stamp updated continuation state with the post-assistant prefix fingerprint!
            if let Some(mut next_cont) = step_ok.continuation {
                let next_fp = compute_continuation_fingerprint(&ContinuationFingerprintInput {
                    provider: self.cfg.provider.as_str(),
                    model_id: &self.cfg.model_id,
                    system_prompt: &self.cfg.system_prompt,
                    tools: &tool_values,
                    authorized_tool_names: Some(&auth_names),
                    canonical_prefix: &history,
                    stream_options: &self.cfg.provider_options,
                });
                match &mut next_cont {
                    ProviderContinuationState::OpenAi {
                        request_fingerprint,
                        ..
                    }
                    | ProviderContinuationState::Google {
                        request_fingerprint,
                        ..
                    } => {
                        if request_fingerprint.is_empty() {
                            *request_fingerprint = next_fp;
                        }
                    }
                    ProviderContinuationState::CodexCli { .. } => {}
                }
                current_continuation = Some(next_cont);
            }

            if tool_calls.is_empty() {
                // End-of-pass race check: if a `turn/steer` arrived while the final response
                // streamed, continue inside the SAME `turnId` instead of closing the turn!
                if steer.has_pending() && !self.cancel_token.is_cancelled() {
                    continue 'step_loop;
                }
                break 'step_loop;
            }

            // Partition deferred meta-tools (`toolSearch` / `toolCall`) + normal tools,
            // preserving exact call order and parallel-read batching.
            let mut result_blocks = Vec::with_capacity(tool_calls.len());
            let mut idx = 0usize;
            while idx < tool_calls.len() {
                if self.cancel_token.is_cancelled() || *self.cancel_rx.borrow() {
                    status = "interrupted".to_owned();
                    break 'step_loop;
                }

                let call = &tool_calls[idx];
                if self.cfg.deferred_tool_search
                    && matches!(call.tool_name.as_str(), "toolSearch" | "toolCall")
                {
                    let (inner_name, raw_res) = if call.tool_name == "toolSearch" {
                        match tool_ctx.check_before_tool_invocation("toolSearch") {
                            Err(e) => (None, Err(e)),
                            Ok(()) => match deferred_catalog.execute_tool_search(&call.arguments) {
                                Ok(found) => {
                                    for n in found.discovered_names {
                                        activated_deferred_tools.insert(n);
                                    }
                                    (None, Ok(ToolOutput::Json(found.value)))
                                }
                                Err(e) => (None, Err(e)),
                            },
                        }
                    } else {
                        let inner = call
                            .arguments
                            .get("name")
                            .and_then(Value::as_str)
                            .map(str::to_owned);
                        if let Some(ref n) = inner {
                            activated_deferred_tools.insert(n.clone());
                        }
                        let r = deferred_catalog
                            .execute_tool_call(&call.arguments, tool_ctx)
                            .await;
                        (inner, r)
                    };

                    result_blocks.push(finalize_tool_call_result(
                        &self.cfg.turn_id,
                        &call.call_id,
                        &call.tool_name,
                        inner_name.as_deref(),
                        raw_res,
                        tool_ctx,
                        self.cfg
                            .overflow_threshold_chars
                            .or(Some(DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS)),
                        &mut projector,
                        &emit_stream_event,
                    ));
                    idx += 1;
                    continue;
                }

                let batch_start = idx;
                while idx < tool_calls.len()
                    && !(self.cfg.deferred_tool_search
                        && matches!(
                            tool_calls[idx].tool_name.as_str(),
                            "toolSearch" | "toolCall"
                        ))
                {
                    idx += 1;
                }

                let batch_results =
                    execute_tool_batch(&tools_map, &tool_calls[batch_start..idx], tool_ctx, None)
                        .await;

                for b_res in batch_results {
                    result_blocks.push(finalize_tool_call_result(
                        &self.cfg.turn_id,
                        &b_res.call_id,
                        &b_res.tool_name,
                        None,
                        b_res.output,
                        tool_ctx,
                        self.cfg
                            .overflow_threshold_chars
                            .or(Some(DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS)),
                        &mut projector,
                        &emit_stream_event,
                    ));
                }

                if self.cancel_token.is_cancelled() || *self.cancel_rx.borrow() {
                    status = "interrupted".to_owned();
                    break 'step_loop;
                }
            }

            history.push(CanonicalMessage {
                id: Uuid::new_v4().to_string(),
                role: MessageRole::Tool,
                content: result_blocks,
                phase: None,
                provider: None,
                api: None,
                model: None,
                stop_reason: None,
                provider_meta: ProviderOpaqueMeta::default(),
                created_at: Utc::now().to_rfc3339(),
            });

            if tool_ctx.should_stop_after_tool_step() {
                break 'step_loop;
            }
        }

        if status == "interrupted" {
            interactions.cancel_all_pending("Turn interrupted.");
            steer.interrupt_codex_if_bound();
            current_continuation = None;
        }

        emit_stream_event(
            &mut projector,
            &StreamEvent::TurnCompleted {
                turn_id: self.cfg.turn_id.clone(),
                status: status.clone(),
                usage: Some(total_usage.clone()),
            },
        );

        TurnRunOutcome {
            status,
            messages: history,
            usage: total_usage,
            last_assistant_text,
            updated_continuation: current_continuation,
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn finalize_tool_call_result<F>(
    turn_id: &str,
    call_id: &str,
    tool_name: &str,
    inner_tool_name: Option<&str>,
    raw_res: Result<ToolOutput, cowork_tools::ToolError>,
    tool_ctx: &ToolExecutionContext,
    overflow_threshold: Option<usize>,
    projector: &mut StreamEventProjector,
    emit: &F,
) -> ContentBlock
where
    F: Fn(&mut StreamEventProjector, &StreamEvent),
{
    match raw_res {
        Ok(out) => {
            let processed = maybe_spill_tool_output_with_inner(
                tool_name,
                inner_tool_name,
                call_id,
                out,
                &tool_ctx.working_directory,
                overflow_threshold,
                &tool_ctx.sandbox_policy,
            )
            .unwrap_or_else(|e| ToolOutput::Text(format!("Tool output error: {e}")));

            let json_val = processed.to_json_value();
            let parts = processed.to_tool_result_parts();
            emit(
                projector,
                &StreamEvent::ToolResult {
                    turn_id: turn_id.to_owned(),
                    key: call_id.to_owned(),
                    name: tool_name.to_owned(),
                    result: json_val.clone(),
                    is_error: false,
                    denied: false,
                },
            );
            ContentBlock::ToolResult {
                tool_call_id: call_id.to_owned(),
                tool_name: Some(tool_name.to_owned()),
                content: parts,
                structured_meta: Some(json_val),
                is_error: false,
                provider_meta: ProviderOpaqueMeta::default(),
            }
        }
        Err(err) => {
            let denied = matches!(err, cowork_tools::ToolError::PathDenied(_));
            let err_str = err.to_string();
            let json_err = json!({ "error": err_str });
            emit(
                projector,
                &StreamEvent::ToolResult {
                    turn_id: turn_id.to_owned(),
                    key: call_id.to_owned(),
                    name: tool_name.to_owned(),
                    result: json_err.clone(),
                    is_error: true,
                    denied,
                },
            );
            ContentBlock::ToolResult {
                tool_call_id: call_id.to_owned(),
                tool_name: Some(tool_name.to_owned()),
                content: vec![ToolResultPart::Text { text: err_str }],
                structured_meta: Some(json_err),
                is_error: true,
                provider_meta: ProviderOpaqueMeta::default(),
            }
        }
    }
}

fn new_user_text_message(text: &str) -> CanonicalMessage {
    CanonicalMessage {
        id: Uuid::new_v4().to_string(),
        role: MessageRole::User,
        content: vec![ContentBlock::Text {
            text: text.to_owned(),
            phase: None,
            citations: Vec::new(),
            provider_meta: ProviderOpaqueMeta::default(),
        }],
        phase: None,
        provider: None,
        api: None,
        model: None,
        stop_reason: None,
        provider_meta: ProviderOpaqueMeta::default(),
        created_at: Utc::now().to_rfc3339(),
    }
}

fn accumulate_usage(dst: &mut TurnUsage, src: &TurnUsage) {
    dst.prompt_tokens += src.prompt_tokens;
    dst.completion_tokens += src.completion_tokens;
    dst.total_tokens += src.total_tokens;
    if let Some(v) = src.cached_prompt_tokens {
        dst.cached_prompt_tokens = Some(dst.cached_prompt_tokens.unwrap_or(0) + v);
    }
    if let Some(v) = src.cache_write_prompt_tokens {
        dst.cache_write_prompt_tokens = Some(dst.cache_write_prompt_tokens.unwrap_or(0) + v);
    }
    if let Some(v) = src.reasoning_output_tokens {
        dst.reasoning_output_tokens = Some(dst.reasoning_output_tokens.unwrap_or(0) + v);
    }
}

struct CodexDynamicBridge {
    tools: ToolMap,
    tool_ctx: ToolExecutionContext,
    interactions: Arc<InteractionManager>,
    overflow_threshold: Option<usize>,
}

#[async_trait]
impl DynamicToolHandler for CodexDynamicBridge {
    async fn call_tool(&self, name: &str, arguments: Map<String, Value>) -> DynamicToolCallOutput {
        if let Err(err) = self.tool_ctx.check_before_tool_invocation(name) {
            return DynamicToolCallOutput {
                text: err.to_string(),
                is_error: true,
            };
        }
        let Some(tool) = self.tools.get(name) else {
            return DynamicToolCallOutput {
                text: format!("Unknown dynamic tool '{name}'"),
                is_error: true,
            };
        };
        match tool.execute(arguments, &self.tool_ctx).await {
            Ok(out) => {
                let processed = maybe_spill_tool_output_with_inner(
                    name,
                    None,
                    &Uuid::new_v4().to_string(),
                    out,
                    &self.tool_ctx.working_directory,
                    self.overflow_threshold,
                    &self.tool_ctx.sandbox_policy,
                )
                .unwrap_or_else(|e| ToolOutput::Text(e.to_string()));
                DynamicToolCallOutput {
                    text: processed
                        .as_text()
                        .unwrap_or_else(|| processed.to_json_value().to_string()),
                    is_error: false,
                }
            }
            Err(err) => DynamicToolCallOutput {
                text: err.to_string(),
                is_error: true,
            },
        }
    }

    async fn request_approval(&self, method: &str, params: &Value) -> bool {
        if self.tool_ctx.yolo {
            return true;
        }
        if method.contains("fileChange") {
            let fp = params
                .get("filePath")
                .and_then(Value::as_str)
                .map(PathBuf::from)
                .unwrap_or_else(|| self.tool_ctx.working_directory.clone());
            return self
                .interactions
                .approve_command(ApprovalDecisionRequest {
                    command: format!("apply_patch {}", fp.display()),
                    reason: params
                        .get("reason")
                        .and_then(Value::as_str)
                        .unwrap_or("requires_manual_review")
                        .to_owned(),
                    category: Some("filesystem".to_owned()),
                    detail: Some(format!("Modify file {}", fp.display())),
                    cwd: self.tool_ctx.working_directory.clone(),
                })
                .await
                .unwrap_or(false);
        }
        let cmd = params
            .get("command")
            .and_then(|v| {
                if let Some(s) = v.as_str() {
                    Some(s.to_owned())
                } else {
                    v.as_array().map(|arr| {
                        arr.iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join(" ")
                    })
                }
            })
            .unwrap_or_else(|| method.to_owned());
        self.interactions
            .approve_command(ApprovalDecisionRequest {
                command: cmd,
                reason: params
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or("codex_approval")
                    .to_owned(),
                category: None,
                detail: None,
                cwd: self.tool_ctx.working_directory.clone(),
            })
            .await
            .unwrap_or(false)
    }

    async fn request_user_input(&self, _method: &str, params: &Value) -> Value {
        let mut questions = Vec::new();
        if let Some(arr) = params.get("questions").and_then(Value::as_array) {
            for (i, q) in arr.iter().enumerate() {
                questions.push(StructuredUserQuestion {
                    id: q
                        .get("id")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                        .unwrap_or_else(|| format!("q_{}", i + 1)),
                    header: q.get("header").and_then(Value::as_str).map(str::to_owned),
                    question: q
                        .get("question")
                        .and_then(Value::as_str)
                        .unwrap_or("Input requested")
                        .to_owned(),
                    options: q.get("options").and_then(Value::as_array).map(|opts| {
                        opts.iter()
                            .filter_map(|o| {
                                Some(StructuredQuestionOption {
                                    label: o.get("label").and_then(Value::as_str)?.to_owned(),
                                    description: o
                                        .get("description")
                                        .and_then(Value::as_str)
                                        .map(str::to_owned),
                                })
                            })
                            .collect()
                    }),
                    is_other: q.get("isOther").and_then(Value::as_bool).unwrap_or(true),
                    is_secret: q.get("isSecret").and_then(Value::as_bool).unwrap_or(false),
                });
            }
        }
        match self.interactions.ask_user_structured(questions).await {
            Ok(map) => {
                let mut formatted = Map::new();
                for (k, v) in map {
                    formatted.insert(k, json!({ "answers": [v] }));
                }
                json!({ "answers": formatted })
            }
            Err(_) => json!({ "answers": {} }),
        }
    }
}
