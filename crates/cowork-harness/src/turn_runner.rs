use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use chrono::Utc;
use cowork_config::ProviderName;
use cowork_inference::{
    CanonicalMessage, Citation, ClientCapabilities as ProjectorCapabilities, ContentBlock,
    ContinuationFingerprintInput, MessageRole, ProviderContinuationState, ProviderOpaqueMeta,
    RATE_LIMIT_RETRY_DEFAULT_MAX_ATTEMPTS, ReasoningStreamMode, RequestPolicy, SessionCostTracker,
    StepBudget, StreamEvent, StreamEventProjector, TextPhase, ToolDefinition, ToolResultPart,
    TurnUsage, compute_continuation_fingerprint, execute_step_with_sink,
};
use cowork_providers::codex_app_server::{DynamicToolCallOutput, DynamicToolHandler};
use cowork_providers::{ProviderStepRequest, ProviderTransport};
use cowork_sandbox::{SandboxPolicy, policy_allows_network};
use cowork_tools::{
    ApprovalDecisionRequest, ApprovalHandler, CatalogToolSearchTool, CodeModeTool,
    CostTrackerBridge, DeferredToolCatalog, StructuredQuestionOption, StructuredUserQuestion,
    ToolBatchCall, ToolExecutionContext, ToolMap, ToolOutput, assert_write_path_allowed,
    create_builtin_tools, execute_tool_batch, maybe_spill_tool_output_with_inner,
};
use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::interactions::{HarnessEventSink, InteractionManager};
use crate::steer::{
    STEER_REJECTED_INTERRUPTED, STEER_REJECTED_MAX_STEPS, STEER_REJECTED_TURN_ENDED,
    SteerCoordinator,
};

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
    /// Inline tool-output spill threshold, already resolved from config. `None` means spilling
    /// is disabled (`toolOutputOverflowChars: null`); the 25,000-char default for an absent
    /// setting is applied at config resolution, never here.
    pub overflow_threshold_chars: Option<usize>,
    pub tool_retry_lineage: bool,
    pub initial_user_message: Option<(String, Option<String>)>,
    /// Resolved `modelSettings.maxRetries` (`AGENT_MODEL_MAX_RETRIES` wins at config load):
    /// retries after the initial model call, converted into the harness-owned per-step attempt
    /// budget by `model_call_max_attempts`. `None` keeps the default budget. This never
    /// reaches provider SDK retries, which stay disabled.
    pub model_max_retries: Option<u32>,
}

#[derive(Debug)]
pub struct TurnRunOutcome {
    pub status: String,
    pub messages: Vec<CanonicalMessage>,
    pub usage: TurnUsage,
    pub last_assistant_text: Option<String>,
    pub updated_continuation: Option<ProviderContinuationState>,
}

/// The visible text of one assistant message (TS `contentText` as used by
/// `AgentSession.getLatestAssistantText`): every text block trimmed, blank ones dropped, joined
/// by `\n`. Commentary-phase text is skipped (TS never persisted it), and so are reasoning,
/// tool, and media blocks. `None` when no text remains.
pub fn assistant_content_text(content: &[ContentBlock]) -> Option<String> {
    let text = content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text, phase, .. } if *phase != Some(TextPhase::Commentary) => {
                Some(text.trim())
            }
            _ => None,
        })
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    (!text.is_empty()).then_some(text)
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
    tool_retry_targets: Vec<ToolRetryTarget>,
    codex_catalog: CodexBridgeCatalog,
}

/// The per-turn tool catalog `run_turn` builds (including deferred `toolSearch` / `toolCall`
/// meta-tools and MCP adapters), published so a Codex dynamic-tool bridge created before the
/// turn starts dispatches the same tools the provider is told about.
#[derive(Clone, Default)]
pub struct CodexBridgeCatalog {
    inner: Arc<parking_lot::RwLock<Option<BridgeCatalogState>>>,
}

#[derive(Clone)]
struct BridgeCatalogState {
    tools: ToolMap,
    deferred: Option<(DeferredToolCatalog, Arc<Mutex<BTreeSet<String>>>)>,
}

impl CodexBridgeCatalog {
    fn publish(&self, state: BridgeCatalogState) {
        *self.inner.write() = Some(state);
    }

    fn snapshot(&self) -> Option<BridgeCatalogState> {
        self.inner.read().clone()
    }
}

/// Annotation type marking the hidden user message that starts a tool-retry turn.
pub const TOOL_RETRY_TURN_ANNOTATION_TYPE: &str = "cowork.toolRetryTurn";
/// Maximum number of failed tool items one `turn/start.retry` may target.
pub const MAX_TOOL_RETRY_TARGETS: usize = 16;

/// A failed tool item targeted by `turn/start.retry.toolItemIds`, with the input digest a
/// replacement call must match to carry `retryOf` lineage.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolRetryTarget {
    pub item_id: String,
    pub input_digest: Value,
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
            tool_retry_targets: Vec::new(),
            codex_catalog: CodexBridgeCatalog::default(),
        }
    }

    /// Slot through which `run_turn` publishes its effective tool catalog to a Codex bridge
    /// built with [`Self::build_codex_dynamic_tool_handler_with_catalog`].
    pub fn codex_bridge_catalog(&self) -> CodexBridgeCatalog {
        self.codex_catalog.clone()
    }

    /// Marks this turn as a tool-retry turn: the initial user message carries the hidden
    /// `cowork.toolRetryTurn` annotation and replacement tool calls whose input digest matches a
    /// target get `retryOf` lineage.
    pub fn with_tool_retry_targets(mut self, targets: Vec<ToolRetryTarget>) -> Self {
        self.tool_retry_targets = targets;
        self
    }

    pub fn cancellation_handle(&self) -> TurnCancellationHandle {
        TurnCancellationHandle {
            cancel_token: self.cancel_token.clone(),
            cancel_tx: self.cancel_tx.clone(),
        }
    }

    /// Installs this turn's cancellation receiver on `tool_ctx`. Call before cloning the context
    /// into a provider bridge (e.g. the Codex dynamic-tool handler) so nested tools observe Stop.
    pub fn install_cancellation(&self, tool_ctx: &mut ToolExecutionContext) {
        tool_ctx.cancel_rx = Some(self.cancel_rx.clone());
    }

    /// Creates a `DynamicToolHandler` bridging Codex App-Server dynamic tool calls,
    /// command/file approvals, and `requestUserInput` prompts to `cowork-tools` + `InteractionManager`.
    pub fn build_codex_dynamic_tool_handler(
        tools: ToolMap,
        tool_ctx: ToolExecutionContext,
        interactions: Arc<InteractionManager>,
        overflow_threshold: Option<usize>,
    ) -> Arc<dyn DynamicToolHandler> {
        Self::build_codex_dynamic_tool_handler_with_catalog(
            tools,
            tool_ctx,
            interactions,
            overflow_threshold,
            None,
        )
    }

    /// Like [`Self::build_codex_dynamic_tool_handler`], but dispatches through the catalog the
    /// turn publishes (so deferred `toolSearch` / `toolCall` and MCP tools resolve); `tools` is
    /// only the fallback before the turn publishes its catalog.
    pub fn build_codex_dynamic_tool_handler_with_catalog(
        tools: ToolMap,
        tool_ctx: ToolExecutionContext,
        interactions: Arc<InteractionManager>,
        overflow_threshold: Option<usize>,
        catalog: Option<CodexBridgeCatalog>,
    ) -> Arc<dyn DynamicToolHandler> {
        Arc::new(CodexDynamicBridge {
            tools,
            catalog,
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
        self.install_cancellation(tool_ctx);
        tool_ctx.clear_stop_after_step();

        let shared_cost = Arc::new(Mutex::new((
            std::mem::replace(
                cost_tracker,
                SessionCostTracker::new(&self.cfg.thread_id, None),
            ),
            false,
        )));
        let _restore_cost = RestoreCostTrackerGuard {
            target: cost_tracker,
            shared: Arc::clone(&shared_cost),
        };
        let installed_cost_bridge = if tool_ctx.cost_tracker_bridge.is_none() {
            tool_ctx.cost_tracker_bridge = Some(Arc::new(TurnSharedCostBridge {
                state: Arc::clone(&shared_cost),
                sink: Arc::clone(&sink),
                session_id: self.cfg.thread_id.clone(),
            }));
            true
        } else {
            false
        };

        let code_mode_enabled = tool_ctx
            .agent_config
            .as_ref()
            .is_some_and(|c| c.tool_calling.code_mode);

        let mut tools_map = create_builtin_tools(tool_ctx);
        let mut catalog_tools = tools_map.clone();
        catalog_tools.remove("toolSearch");
        catalog_tools.remove("mcpCall");
        catalog_tools.remove("toolCall");
        catalog_tools.remove("codeMode");

        if (self.cfg.deferred_tool_search || code_mode_enabled)
            && let (Some(cache), Some(agent_cfg)) =
                (&tool_ctx.mcp_tool_cache, &tool_ctx.agent_config)
            && agent_cfg.enable_mcp
        {
            if self.cfg.deferred_tool_search {
                tools_map.remove("toolSearch");
                tools_map.remove("mcpCall");
            }
            if !tool_ctx.read_only_role
                && tool_ctx
                    .allowed_mcp_servers
                    .as_ref()
                    .is_none_or(|s| !s.is_empty())
            {
                let agent_cfg_cloned = Arc::clone(agent_cfg);
                let env_cloned = tool_ctx.env.clone();
                let allowed_servers = tool_ctx.allowed_mcp_servers.clone();
                let existing_keys: BTreeSet<String> = catalog_tools.keys().cloned().collect();
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
                        let name = adapter.name().to_owned();
                        catalog_tools.insert(name.clone(), Arc::clone(&adapter));
                        if self.cfg.deferred_tool_search {
                            tools_map.insert(name, adapter);
                        }
                    }
                }
            }
        }
        let shared_activated = Arc::new(Mutex::new(BTreeSet::<String>::new()));
        let deferred_catalog = DeferredToolCatalog::new(catalog_tools);
        if code_mode_enabled {
            let activated_for_cm = self
                .cfg
                .deferred_tool_search
                .then(|| Arc::clone(&shared_activated));
            tools_map.insert(
                "codeMode".to_owned(),
                Arc::new(CodeModeTool::new(
                    deferred_catalog.clone(),
                    activated_for_cm,
                )),
            );
            if !self.cfg.deferred_tool_search {
                tools_map.insert(
                    "toolSearch".to_owned(),
                    Arc::new(CatalogToolSearchTool::new(deferred_catalog.clone(), None)),
                );
            }
        }

        self.codex_catalog.publish(BridgeCatalogState {
            tools: tools_map.clone(),
            deferred: self
                .cfg
                .deferred_tool_search
                .then(|| (deferred_catalog.clone(), Arc::clone(&shared_activated))),
        });

        let mut projector = StreamEventProjector::new(
            &self.cfg.thread_id,
            ProjectorCapabilities {
                tool_retry_lineage: self.cfg.tool_retry_lineage,
            },
        );

        let retry_tracker = ToolRetryAttemptTracker::new(self.tool_retry_targets.clone());
        let emit_stream_event = |proj: &mut StreamEventProjector, ev: &StreamEvent| {
            let annotated = retry_tracker.observe(ev);
            for notif in proj.project(annotated.as_ref().unwrap_or(ev)) {
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
                    annotations: tool_retry_turn_annotation(&self.tool_retry_targets)
                        .into_iter()
                        .collect(),
                },
            );
        }

        let mut current_continuation = initial_continuation;
        let mut total_usage = TurnUsage::default();
        let mut last_assistant_text: Option<String> = None;
        let mut status = "completed".to_owned();
        let max_steps = self.cfg.max_steps.max(1);
        // True only when the final loop iteration ran to completion (no `break`), i.e. the turn
        // used up its step budget.
        let mut steps_exhausted = false;

        'step_loop: for _step in 0..max_steps {
            steps_exhausted = false;
            if self.cancel_token.is_cancelled() || *self.cancel_rx.borrow() {
                status = "interrupted".to_owned();
                break 'step_loop;
            }

            let budget_exceeded_msg = {
                let mut guard = shared_cost.lock();
                if guard.0.is_budget_exceeded() {
                    let b = guard.0.get_budget_status();
                    let cur = b.current_cost_usd.unwrap_or_default();
                    let thr = b.stop_at_usd.unwrap_or_default();
                    let msg =
                        format!("Session cost budget exceeded (${cur:.4} >= ${thr:.4} stopAtUsd).");
                    let emit_notif = !guard.1;
                    guard.1 = true;
                    Some((cur, thr, msg, emit_notif))
                } else {
                    None
                }
            };
            if let Some((cur, thr, msg, emit_notif)) = budget_exceeded_msg {
                if emit_notif {
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
                        steer_request_id: None,
                        client_message_id: None,
                    },
                );
                status = "failed".to_owned();
                break 'step_loop;
            }

            // Step-boundary injection of any queued `turn/steer` prompts
            steer.settle_native_deliveries().await;
            for entry in steer.drain_pending() {
                record_steer_message(
                    &self.cfg.turn_id,
                    entry,
                    &mut history,
                    &mut projector,
                    &emit_stream_event,
                );
            }

            let step_tool_defs: Vec<ToolDefinition> = if self.cfg.deferred_tool_search {
                deferred_catalog.active_tool_definitions_with_code_mode(
                    &shared_activated.lock(),
                    tools_map.contains_key("codeMode"),
                )
            } else {
                tools_map.values().map(|t| t.definition()).collect()
            };
            let tool_values: Vec<Value> = step_tool_defs
                .iter()
                .filter_map(|d| serde_json::to_value(d).ok())
                .collect();
            let auth_names: Vec<String> = step_tool_defs.iter().map(|d| d.name.clone()).collect();

            // The stored fingerprint covers the post-assistant prefix, while `history` already
            // holds the new tool results / user message. Fingerprint validation therefore belongs
            // to the transports, which check it against their candidate prefix splits
            // (`candidate_continuation_splits`); here only drop state for another provider/model.
            let valid_cont = current_continuation
                .as_ref()
                .filter(|c| {
                    c.provider_id() == self.cfg.provider.as_str() && c.model() == self.cfg.model_id
                })
                .cloned();

            // The harness owns step retries (TS `runTurn.ts` parity: "Cowork owns retries; SDK
            // retries must not multiply its attempt count"). Transports still bound each HTTP
            // attempt with the same timeouts, but run a single attempt so a persistently
            // failing step costs `max_attempts` requests, not `max_attempts²`.
            //
            // `timeoutMs` (response-header timeout per attempt) and `stepTimeoutMs` (wall clock
            // for every attempt, the whole streamed response and backoff) come from this
            // provider's `providerOptions` section and fail closed when invalid
            // (`resolvePiRequestPolicy` parity); `cfg.step_timeout_ms` is the default step budget.
            //
            // The Codex app-server runs a whole agentic loop per step and TS never capped it at the
            // turn level (only its startup RPCs time out), so it gets no step deadline here.
            let exempt_from_step_budget = self.cfg.provider == ProviderName::CodexCli;
            let policy = match step_request_policy(&self.cfg, exempt_from_step_budget) {
                Ok(policy) => policy,
                Err(message) => {
                    emit_stream_event(
                        &mut projector,
                        &StreamEvent::Error {
                            turn_id: self.cfg.turn_id.clone(),
                            message,
                            code: Some("validation_failed".to_owned()),
                            steer_request_id: None,
                            client_message_id: None,
                        },
                    );
                    status = "failed".to_owned();
                    break 'step_loop;
                }
            };
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
                policy: RequestPolicy {
                    max_attempts: 1,
                    ..policy
                },
                turn_id: self.cfg.turn_id.clone(),
            };

            let budget = if exempt_from_step_budget {
                StepBudget::unbounded(Some(self.cancel_token.clone()))
            } else {
                StepBudget::new(policy.step_timeout_ms, Some(self.cancel_token.clone()))
            };
            let partial_output = Mutex::new(PartialStepOutput::default());
            let mut sink_fn = |ev: StreamEvent| {
                partial_output.lock().observe(&ev);
                emit_stream_event(&mut projector, &ev);
            };
            let transport_step = Arc::clone(&transport);
            let step_result = execute_step_with_sink(
                &policy,
                &budget,
                &mut sink_fn,
                &mut |_attempt, mut emit_cb| {
                    // Only the attempt that ends the step can leave partial output behind.
                    partial_output.lock().clear();
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
                        // Keep the prose and reasoning the failed step already streamed so the
                        // next request sees what the transcript shows (`pi/runTurn.ts` parity).
                        // Its tool calls never ran and are dropped. A user stop discards the
                        // in-flight step instead, as TS did (`codexAppServer/runTurn.ts`).
                        if let Some(partial) = partial_output.into_inner().into_message() {
                            history.push(partial);
                        }
                        emit_stream_event(
                            &mut projector,
                            &StreamEvent::Error {
                                turn_id: self.cfg.turn_id.clone(),
                                message: err.message,
                                code: err.code,
                                steer_request_id: None,
                                client_message_id: None,
                            },
                        );
                    }
                    break 'step_loop;
                }
            };

            accumulate_usage(&mut total_usage, &step_ok.usage);
            let (warn_notif, stop_notif) = {
                let mut guard = shared_cost.lock();
                let budget_before = guard.0.get_budget_status();
                let warn_before = budget_before.warning_triggered;
                let stop_before = budget_before.stop_triggered;
                guard.0.record_turn(
                    &self.cfg.turn_id,
                    self.cfg.provider,
                    &self.cfg.model_id,
                    step_ok.usage.clone(),
                    None,
                );
                let budget_now = guard.0.get_budget_status();
                let warn_evt = (!warn_before && budget_now.warning_triggered).then(|| {
                    (
                        budget_now.current_cost_usd.unwrap_or_default(),
                        budget_now.warn_at_usd.unwrap_or_default(),
                    )
                });
                let stop_evt = (!stop_before && budget_now.stop_triggered && !guard.1).then(|| {
                    guard.1 = true;
                    (
                        budget_now.current_cost_usd.unwrap_or_default(),
                        budget_now.stop_at_usd.unwrap_or_default(),
                    )
                });
                (warn_evt, stop_evt)
            };
            if let Some((cur, thr)) = warn_notif {
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
            if let Some((cur, thr)) = stop_notif {
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

            if let Some(text) = assistant_content_text(&step_ok.assistant.content) {
                last_assistant_text = Some(text);
            }
            let mut tool_calls = Vec::<ToolBatchCall>::new();
            for block in &step_ok.assistant.content {
                if let ContentBlock::ToolCall {
                    id,
                    name,
                    arguments,
                    ..
                } = block
                {
                    tool_calls.push(ToolBatchCall {
                        call_id: id.clone(),
                        tool_name: name.clone(),
                        arguments: arguments.clone(),
                    });
                }
            }

            // Steers the native Codex turn accepted mid-step were consumed by this step: record
            // them ahead of its assistant output instead of resubmitting them next step.
            steer.settle_native_deliveries().await;
            for entry in steer.take_natively_delivered() {
                record_steer_message(
                    &self.cfg.turn_id,
                    entry,
                    &mut history,
                    &mut projector,
                    &emit_stream_event,
                );
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
                    steps_exhausted = true;
                    continue 'step_loop;
                }
                break 'step_loop;
            }

            // Partition deferred meta-tools (`toolSearch` / `toolCall`) + normal tools,
            // preserving exact call order and parallel-read batching.
            let mut result_blocks = Vec::with_capacity(tool_calls.len());
            let mut interrupted_mid_batch = false;
            let mut idx = 0usize;
            while idx < tool_calls.len() {
                if self.cancel_token.is_cancelled() || *self.cancel_rx.borrow() {
                    interrupted_mid_batch = true;
                    break;
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
                                    let mut act = shared_activated.lock();
                                    for n in found.discovered_names {
                                        act.insert(n);
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
                            shared_activated.lock().insert(n.clone());
                        }
                        let r = deferred_catalog
                            .execute_tool_call(&call.arguments, tool_ctx)
                            .await;
                        (inner, r)
                    };

                    result_blocks.push(finalize_tool_call_result(
                        &self.cfg.turn_id,
                        ToolCallIdent {
                            call_id: &call.call_id,
                            tool_name: &call.tool_name,
                            inner_tool_name: inner_name.as_deref(),
                        },
                        raw_res,
                        tool_ctx,
                        self.cfg.overflow_threshold_chars,
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
                        ToolCallIdent {
                            call_id: &b_res.call_id,
                            tool_name: &b_res.tool_name,
                            inner_tool_name: None,
                        },
                        b_res.output,
                        tool_ctx,
                        self.cfg.overflow_threshold_chars,
                        &mut projector,
                        &emit_stream_event,
                    ));
                }

                if self.cancel_token.is_cancelled() || *self.cancel_rx.borrow() {
                    interrupted_mid_batch = true;
                    break;
                }
            }

            if interrupted_mid_batch {
                // The assistant's tool calls are already in history (and interrupted turns are
                // persisted), so every call must be answered: keep collected results and
                // synthesize an interruption result for each call that never ran.
                let answered: HashSet<String> = result_blocks
                    .iter()
                    .filter_map(|b| match b {
                        ContentBlock::ToolResult { tool_call_id, .. } => Some(tool_call_id.clone()),
                        _ => None,
                    })
                    .collect();
                for call in &tool_calls {
                    if answered.contains(&call.call_id) {
                        continue;
                    }
                    result_blocks.push(finalize_tool_call_result(
                        &self.cfg.turn_id,
                        ToolCallIdent {
                            call_id: &call.call_id,
                            tool_name: &call.tool_name,
                            inner_tool_name: None,
                        },
                        Err(cowork_tools::ToolError::Execution(
                            TOOL_INTERRUPTED_MESSAGE.to_owned(),
                        )),
                        tool_ctx,
                        None,
                        &mut projector,
                        &emit_stream_event,
                    ));
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

            if interrupted_mid_batch {
                status = "interrupted".to_owned();
                break 'step_loop;
            }

            if tool_ctx.should_stop_after_tool_step() {
                break 'step_loop;
            }
            steps_exhausted = true;
        }

        if status == "interrupted" {
            interactions.cancel_all_pending("Turn interrupted.");
            steer.interrupt_codex_if_bound();
            current_continuation = None;
        }

        // Settle `turn/steer` admission before completing the turn on every exit path. Steers
        // the native Codex turn already consumed are recorded; anything still queued (e.g. the
        // provider or a tool call was interrupted before the next step boundary) is rejected
        // with its originating ids so clients can clear the pending submission instead of
        // losing the accepted guidance silently.
        steer.close_admission();
        steer.settle_native_deliveries().await;
        for entry in steer.take_natively_delivered() {
            record_steer_message(
                &self.cfg.turn_id,
                entry,
                &mut history,
                &mut projector,
                &emit_stream_event,
            );
        }
        let rejection_message = if status == "interrupted" {
            STEER_REJECTED_INTERRUPTED
        } else if steps_exhausted {
            STEER_REJECTED_MAX_STEPS
        } else {
            STEER_REJECTED_TURN_ENDED
        };
        for entry in steer.drain_pending() {
            emit_stream_event(
                &mut projector,
                &StreamEvent::Error {
                    turn_id: self.cfg.turn_id.clone(),
                    message: rejection_message.to_owned(),
                    code: Some("validation_failed".to_owned()),
                    steer_request_id: Some(entry.request_id),
                    client_message_id: entry.client_message_id,
                },
            );
        }

        if installed_cost_bridge {
            tool_ctx.cost_tracker_bridge = None;
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

struct RestoreCostTrackerGuard<'a> {
    target: &'a mut SessionCostTracker,
    shared: Arc<Mutex<(SessionCostTracker, bool)>>,
}

impl Drop for RestoreCostTrackerGuard<'_> {
    fn drop(&mut self) {
        let dummy = SessionCostTracker::new("restoring", None);
        let restored = std::mem::replace(&mut self.shared.lock().0, dummy);
        *self.target = restored;
    }
}

struct TurnSharedCostBridge {
    state: Arc<Mutex<(SessionCostTracker, bool)>>,
    sink: Arc<dyn HarnessEventSink>,
    session_id: String,
}

impl CostTrackerBridge for TurnSharedCostBridge {
    fn record_unattributed_cost(&self, amount_usd: f64) -> Result<(), String> {
        let (warn_evt, stop_evt) = {
            let mut guard = self.state.lock();
            let before = guard.0.get_budget_status();
            let warn_before = before.warning_triggered;
            let stop_before = before.stop_triggered;
            guard
                .0
                .record_unattributed_cost(amount_usd)
                .map_err(|e| e.to_string())?;
            let now = guard.0.get_budget_status();
            let warn_evt = (!warn_before && now.warning_triggered).then(|| {
                (
                    now.current_cost_usd.unwrap_or_default(),
                    now.warn_at_usd.unwrap_or_default(),
                )
            });
            let stop_evt = (!stop_before && now.stop_triggered && !guard.1).then(|| {
                guard.1 = true;
                (
                    now.current_cost_usd.unwrap_or_default(),
                    now.stop_at_usd.unwrap_or_default(),
                )
            });
            (warn_evt, stop_evt)
        };
        if let Some((cur, thr)) = warn_evt {
            self.sink.send_notification(
                "cowork/session/budgetWarning",
                json!({
                    "type": "budget_warning",
                    "sessionId": self.session_id,
                    "currentCostUsd": cur,
                    "thresholdUsd": thr,
                    "message": format!("Session cost (${cur:.4}) reached budget warning threshold (${thr:.4})."),
                }),
            );
        }
        if let Some((cur, thr)) = stop_evt {
            self.sink.send_notification(
                "cowork/session/budgetExceeded",
                json!({
                    "type": "budget_exceeded",
                    "sessionId": self.session_id,
                    "currentCostUsd": cur,
                    "thresholdUsd": thr,
                    "message": format!("Session cost budget exceeded (${cur:.4} >= ${thr:.4} stopAtUsd)."),
                }),
            );
        }
        Ok(())
    }

    fn get_budget_status(&self) -> cowork_inference::BudgetStatus {
        self.state.lock().0.get_budget_status()
    }
}

/// Total model-call attempts per step (TS `resolveRateLimitMaxAttempts` parity):
/// `modelSettings.maxRetries` counts retries after the initial call and is clamped to the bounded
/// default budget so a turn cannot stall on a persistently failing provider. Unset keeps the
/// default [`RATE_LIMIT_RETRY_DEFAULT_MAX_ATTEMPTS`].
fn model_call_max_attempts(model_max_retries: Option<u32>) -> usize {
    match model_max_retries {
        None => RATE_LIMIT_RETRY_DEFAULT_MAX_ATTEMPTS,
        Some(retries) => {
            let retries = usize::try_from(retries).unwrap_or(usize::MAX);
            1 + retries.min(RATE_LIMIT_RETRY_DEFAULT_MAX_ATTEMPTS - 1)
        }
    }
}

/// Resolves the per-step [`RequestPolicy`]: `cfg.step_timeout_ms` is the default step budget and
/// the provider's `providerOptions` section may override `timeoutMs` / `stepTimeoutMs` /
/// `maxRetryDelayMs` (invalid explicit values fail the turn) and `cfg.model_max_retries` sets the
/// attempt budget. Transports exempt from the step budget (Codex app-server) never read PI
/// request options, so their section is not validated.
fn step_request_policy(
    cfg: &TurnRunConfig,
    exempt_from_step_budget: bool,
) -> Result<RequestPolicy, String> {
    let fallback = RequestPolicy {
        step_timeout_ms: cfg.step_timeout_ms.clamp(1, 1_800_000),
        max_attempts: model_call_max_attempts(cfg.model_max_retries),
        ..RequestPolicy::default()
    };
    let resolved = if exempt_from_step_budget {
        RequestPolicy::from_options_with_fallback(&Map::new(), &fallback)
    } else {
        RequestPolicy::for_provider(cfg.provider, &cfg.provider_options, &fallback)
    };
    resolved.map_err(|err| err.to_string())
}

#[allow(clippy::too_many_arguments)]
/// Records a `turn/steer` prompt as a user message in history and on the stream.
fn record_steer_message<F>(
    turn_id: &str,
    entry: crate::steer::SteerEntry,
    history: &mut Vec<CanonicalMessage>,
    projector: &mut StreamEventProjector,
    emit: &F,
) where
    F: Fn(&mut StreamEventProjector, &StreamEvent),
{
    emit(
        projector,
        &StreamEvent::UserMessage {
            turn_id: turn_id.to_owned(),
            text: entry.text.clone(),
            client_message_id: entry.client_message_id,
            steer_request_id: Some(entry.request_id),
            annotations: Vec::new(),
        },
    );
    let mut msg = new_user_text_message(&entry.text);
    if !entry.content.is_empty() {
        msg.content = entry.content;
    }
    history.push(msg);
}

/// Synthesized result for a tool call that never ran because the turn was interrupted.
const TOOL_INTERRUPTED_MESSAGE: &str = "Tool call was not executed: the turn was interrupted.";

/// Identity of a tool call whose result is being finalized.
struct ToolCallIdent<'a> {
    call_id: &'a str,
    tool_name: &'a str,
    inner_tool_name: Option<&'a str>,
}

fn finalize_tool_call_result<F>(
    turn_id: &str,
    ident: ToolCallIdent<'_>,
    raw_res: Result<ToolOutput, cowork_tools::ToolError>,
    tool_ctx: &ToolExecutionContext,
    overflow_threshold: Option<usize>,
    projector: &mut StreamEventProjector,
    emit: &F,
) -> ContentBlock
where
    F: Fn(&mut StreamEventProjector, &StreamEvent),
{
    let ToolCallIdent {
        call_id,
        tool_name,
        inner_tool_name,
    } = ident;
    match raw_res {
        Ok(out) => {
            let processed = maybe_spill_tool_output_with_inner(
                tool_name,
                inner_tool_name,
                call_id,
                out,
                tool_ctx,
                overflow_threshold,
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

#[derive(PartialEq)]
enum PartialBlockKey {
    Text(usize),
    Thinking(String, ReasoningStreamMode),
}

struct PartialBlock {
    key: PartialBlockKey,
    open: bool,
    text: String,
    phase: Option<TextPhase>,
    citations: Vec<Citation>,
    redacted: bool,
}

/// Text and reasoning the in-flight model step has streamed, in stream order.
#[derive(Default)]
struct PartialStepOutput {
    blocks: Vec<PartialBlock>,
}

impl PartialStepOutput {
    fn clear(&mut self) {
        self.blocks.clear();
    }

    fn block(&mut self, key: PartialBlockKey) -> &mut PartialBlock {
        let idx = match self.blocks.iter().rposition(|b| b.open && b.key == key) {
            Some(idx) => idx,
            None => {
                self.blocks.push(PartialBlock {
                    key,
                    open: true,
                    text: String::new(),
                    phase: None,
                    citations: Vec::new(),
                    redacted: false,
                });
                self.blocks.len() - 1
            }
        };
        &mut self.blocks[idx]
    }

    fn observe(&mut self, ev: &StreamEvent) {
        match ev {
            StreamEvent::TextStart {
                block_index, phase, ..
            } => {
                let block = self.block(PartialBlockKey::Text(*block_index));
                block.phase = phase.or(block.phase);
            }
            StreamEvent::TextDelta {
                block_index,
                delta,
                phase,
                ..
            } => {
                let block = self.block(PartialBlockKey::Text(*block_index));
                block.text.push_str(delta);
                block.phase = phase.or(block.phase);
            }
            StreamEvent::TextEnd {
                block_index,
                text,
                phase,
                citations,
                ..
            } => {
                let block = self.block(PartialBlockKey::Text(*block_index));
                if !text.is_empty() {
                    block.text.clone_from(text);
                }
                block.phase = phase.or(block.phase);
                block.citations.clone_from(citations);
                block.open = false;
            }
            StreamEvent::ThinkingStart {
                stream_id, mode, ..
            } => {
                self.block(PartialBlockKey::Thinking(stream_id.clone(), *mode));
            }
            StreamEvent::ThinkingDelta {
                stream_id,
                mode,
                delta,
                ..
            } => {
                self.block(PartialBlockKey::Thinking(stream_id.clone(), *mode))
                    .text
                    .push_str(delta);
            }
            StreamEvent::ThinkingEnd {
                stream_id,
                mode,
                text,
                redacted,
                ..
            } => {
                let block = self.block(PartialBlockKey::Thinking(stream_id.clone(), *mode));
                if !text.is_empty() {
                    block.text.clone_from(text);
                }
                block.redacted = *redacted;
                block.open = false;
            }
            _ => {}
        }
    }

    /// The assistant message to keep for a failed step (`pi/runTurn.ts` + `piMessageBridge.ts`
    /// parity): text and reasoning only, with provider state (signatures, item ids, encrypted
    /// reasoning, redacted thinking, provider/api/model) stripped because the response never
    /// completed, so replay sends it as plain content. Commentary and blank blocks are dropped;
    /// `None` when nothing remains.
    fn into_message(self) -> Option<CanonicalMessage> {
        let content: Vec<ContentBlock> = self
            .blocks
            .into_iter()
            .filter(|b| !b.redacted && !b.text.trim().is_empty())
            .filter_map(|b| match b.key {
                PartialBlockKey::Text(_) if b.phase == Some(TextPhase::Commentary) => None,
                PartialBlockKey::Text(_) => Some(ContentBlock::Text {
                    text: b.text,
                    phase: b.phase,
                    citations: b.citations,
                    provider_meta: ProviderOpaqueMeta::default(),
                }),
                PartialBlockKey::Thinking(..) => Some(ContentBlock::Thinking {
                    text: b.text,
                    summary: None,
                    redacted: false,
                    signature: None,
                    provider_meta: ProviderOpaqueMeta::default(),
                }),
            })
            .collect();
        if content.is_empty() {
            return None;
        }
        let mut msg = new_user_text_message("");
        msg.role = MessageRole::Assistant;
        msg.content = content;
        Some(msg)
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

/// Hidden-turn annotation (`{ type: "cowork.toolRetryTurn", version: 1, targetItemIds }`) for a
/// tool-retry turn, or `None` when the turn retries nothing.
pub fn tool_retry_turn_annotation(targets: &[ToolRetryTarget]) -> Option<Value> {
    (!targets.is_empty()).then(|| {
        json!({
            "type": TOOL_RETRY_TURN_ANNOTATION_TYPE,
            "version": 1,
            "targetItemIds": targets.iter().map(|t| t.item_id.clone()).collect::<Vec<_>>(),
        })
    })
}

/// SHA-256 digest of the canonical (sorted-key) JSON encoding of `{ args, toolName }`, matching
/// the `inputDigest` shape (`{ algorithm, value, canonicalBytes }`) clients use for retry lineage.
pub fn digest_tool_input(tool_name: &str, args: &Value) -> Value {
    use sha2::{Digest, Sha256};
    let mut canonical = String::new();
    write_canonical_json(
        &json!({ "args": args, "toolName": tool_name }),
        &mut canonical,
    );
    json!({
        "algorithm": "sha256",
        "value": hex::encode(Sha256::digest(canonical.as_bytes())),
        "canonicalBytes": canonical.len(),
    })
}

fn write_canonical_json(value: &Value, out: &mut String) {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            out.push('{');
            for (i, key) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&Value::String(key.clone()).to_string());
                out.push(':');
                write_canonical_json(&map[key], out);
            }
            out.push('}');
        }
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical_json(item, out);
            }
            out.push(']');
        }
        Value::Number(n) if n.is_f64() => {
            // Match `JSON.stringify` for integral floats (`1.0` -> `1`) and exponent signs.
            let f = n.as_f64().unwrap_or_default();
            if f.fract() == 0.0 && f.abs() < 1e21 {
                out.push_str(&format!("{f:.0}"));
            } else {
                let raw = n.to_string();
                match raw.split_once('e') {
                    Some((mantissa, exp)) if !exp.starts_with('-') && !exp.starts_with('+') => {
                        out.push_str(&format!("{mantissa}e+{exp}"));
                    }
                    _ => out.push_str(&raw),
                }
            }
        }
        other => out.push_str(&other.to_string()),
    }
}

/// Mirrors the legacy `isFailedToolOutcome` rule used to decide whether a tool item failed.
pub fn is_failed_tool_outcome(tool_name: &str, state: &str, result: Option<&Value>) -> bool {
    if matches!(state, "output-error" | "output-denied") {
        return true;
    }
    match result {
        Some(Value::Object(obj)) => {
            obj.get("denied") == Some(&Value::Bool(true))
                || obj.get("ok") == Some(&Value::Bool(false))
                || obj.contains_key("error")
        }
        Some(Value::String(text)) => {
            tool_name.eq_ignore_ascii_case("skill")
                && text.to_ascii_lowercase().contains("not found")
        }
        _ => false,
    }
}

#[derive(Default)]
struct ToolAttempt {
    name: String,
    input_text: String,
    initial_args: Option<Map<String, Value>>,
    retry_of: Option<String>,
    terminal: bool,
}

#[derive(Default)]
struct ToolRetryAttemptState {
    attempts: HashMap<String, ToolAttempt>,
    resolved_targets: BTreeSet<String>,
}

/// Stamps `inputDigest` (and `retryOf` for retry-target matches) on `ToolCallEnd` events and
/// marks a target resolved once its replacement call succeeds.
struct ToolRetryAttemptTracker {
    targets: Vec<ToolRetryTarget>,
    state: Mutex<ToolRetryAttemptState>,
}

impl ToolRetryAttemptTracker {
    fn new(targets: Vec<ToolRetryTarget>) -> Self {
        Self {
            targets,
            state: Mutex::new(ToolRetryAttemptState::default()),
        }
    }

    fn active_attempt<'a>(state: &'a mut ToolRetryAttemptState, key: &str) -> &'a mut ToolAttempt {
        let entry = state.attempts.entry(key.to_owned()).or_default();
        if entry.terminal {
            *entry = ToolAttempt::default();
        }
        entry
    }

    /// Returns an annotated copy of `ev` when it gains digest/lineage metadata.
    fn observe(&self, ev: &StreamEvent) -> Option<StreamEvent> {
        let mut state = self.state.lock();
        match ev {
            StreamEvent::ToolCallStart {
                key,
                name,
                initial_args,
                ..
            } => {
                let attempt = Self::active_attempt(&mut state, key);
                attempt.name = name.clone();
                attempt.initial_args = initial_args.clone();
                None
            }
            StreamEvent::ToolCallDelta { key, delta, .. } => {
                Self::active_attempt(&mut state, key)
                    .input_text
                    .push_str(delta);
                None
            }
            StreamEvent::ToolCallEnd {
                turn_id,
                key,
                name,
                arguments,
                retry_of,
                input_digest,
            } => {
                if input_digest.is_some() {
                    return None;
                }
                let resolved = state.resolved_targets.clone();
                let attempt = Self::active_attempt(&mut state, key);
                let args = match arguments {
                    Some(explicit) => Some(Value::Object(explicit.clone())),
                    None if !attempt.input_text.trim().is_empty() => {
                        serde_json::from_str::<Value>(&attempt.input_text).ok()
                    }
                    None => Some(Value::Object(
                        attempt.initial_args.clone().unwrap_or_default(),
                    )),
                }?;
                let tool_name = if name.is_empty() || name == "tool" {
                    attempt.name.clone()
                } else {
                    name.clone()
                };
                let digest = digest_tool_input(&tool_name, &args);
                let matched = retry_of.clone().or_else(|| {
                    self.targets
                        .iter()
                        .find(|t| !resolved.contains(&t.item_id) && t.input_digest == digest)
                        .map(|t| t.item_id.clone())
                });
                attempt.retry_of = matched.clone();
                Some(StreamEvent::ToolCallEnd {
                    turn_id: turn_id.clone(),
                    key: key.clone(),
                    name: name.clone(),
                    arguments: arguments.clone(),
                    retry_of: matched,
                    input_digest: Some(digest),
                })
            }
            StreamEvent::ToolResult {
                key,
                name,
                result,
                is_error,
                denied,
                ..
            } => {
                let successful = !*is_error
                    && !*denied
                    && !is_failed_tool_outcome(name, "output-available", Some(result));
                let retry_of = state.attempts.get_mut(key).and_then(|attempt| {
                    attempt.terminal = true;
                    attempt.retry_of.clone()
                });
                if successful && let Some(target) = retry_of {
                    state.resolved_targets.insert(target);
                }
                None
            }
            _ => None,
        }
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
    catalog: Option<CodexBridgeCatalog>,
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
        let published = self.catalog.as_ref().and_then(CodexBridgeCatalog::snapshot);
        let raw_res = match published.as_ref().and_then(|p| p.deferred.as_ref()) {
            // Deferred meta-tools dispatch through the turn's catalog, like the harness loop.
            Some((catalog, activated)) if name == "toolSearch" => {
                catalog.execute_tool_search(&arguments).map(|found| {
                    activated.lock().extend(found.discovered_names);
                    ToolOutput::Json(found.value)
                })
            }
            Some((catalog, activated)) if name == "toolCall" => {
                if let Some(inner) = arguments.get("name").and_then(Value::as_str) {
                    activated.lock().insert(inner.to_owned());
                }
                catalog.execute_tool_call(&arguments, &self.tool_ctx).await
            }
            _ => {
                let tools = published.as_ref().map_or(&self.tools, |p| &p.tools);
                let Some(tool) = tools.get(name) else {
                    return DynamicToolCallOutput {
                        text: format!("Unknown dynamic tool '{name}'"),
                        is_error: true,
                    };
                };
                tool.execute(arguments, &self.tool_ctx).await
            }
        };
        match raw_res {
            Ok(out) => {
                let processed = maybe_spill_tool_output_with_inner(
                    name,
                    None,
                    &Uuid::new_v4().to_string(),
                    out,
                    &self.tool_ctx,
                    self.overflow_threshold,
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
        let is_file_change = is_codex_file_change_approval(method);
        // TS `handleServerRequest`: the hard-floor check runs before both YOLO and interactive
        // acceptance, so a floor-violating escalation is never auto-accepted nor shown as approvable.
        if let Err(reason) =
            assert_codex_approval_preserves_policy(&self.tool_ctx, is_file_change, params)
        {
            tracing::warn!(
                method,
                %reason,
                "[codex-app-server] Native tool approval declined"
            );
            return false;
        }
        let approved = self.tool_ctx.yolo
            || self
                .prompt_native_approval(method, is_file_change, params)
                .await;
        if !approved {
            return false;
        }
        // Re-check after the wait: a path may have been re-pointed (e.g. via symlink) meanwhile.
        if let Err(reason) =
            assert_codex_approval_preserves_policy(&self.tool_ctx, is_file_change, params)
        {
            tracing::warn!(
                method,
                %reason,
                "[codex-app-server] Native tool approval declined after wait"
            );
            return false;
        }
        true
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

/// `item/fileChange/requestApproval` and the legacy `applyPatchApproval` grant file writes; every
/// other native approval (`item/commandExecution/requestApproval`, `execCommandApproval`) can rerun
/// a command outside Codex's sandbox.
fn is_codex_file_change_approval(method: &str) -> bool {
    method.contains("fileChange") || method == "applyPatchApproval"
}

/// TS `assertApprovalPreservesPolicy`: a native Codex approval must not let the child escape the
/// hard floors `resolve_codex_sandbox_and_approval_policy` put on the turn. Command escalation is
/// refused outright for scoped, read-only and network-disabled turns; scoped file grants must keep
/// `grantRoot` and every listed path inside the assigned `targetPaths`.
fn assert_codex_approval_preserves_policy(
    ctx: &ToolExecutionContext,
    is_file_change: bool,
    params: &Value,
) -> Result<(), String> {
    let policy = &ctx.sandbox_policy;
    let read_only = ctx.read_only_role
        || matches!(
            policy,
            SandboxPolicy::ReadOnly { .. } | SandboxPolicy::NoProjectWrite { .. }
        );
    let scoped = ctx.target_paths.as_ref().is_some_and(|t| !t.is_empty());
    if !is_file_change {
        // A native approval can rerun a command outside its sandbox. The request does not attest
        // that the hard floors survive accepting it; neither a harmless-looking command nor a
        // human/YOLO approval proves containment.
        if read_only || scoped || !policy_allows_network(policy) || !ctx.sandbox_config.network {
            return Err("Command approval cannot preserve this turn's sandbox hard floors.".into());
        }
        return Ok(());
    }
    if read_only {
        return Err(format!(
            "File approval blocked: sandbox mode is {}.",
            policy.kind_str()
        ));
    }
    if !scoped {
        return Ok(());
    }

    // Codex grants access to grantRoot, not merely the displayed patch paths. Without an explicit
    // root the extent of a native file grant is ambiguous.
    let grant_root = params
        .get("grantRoot")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or("Scoped file approval requires an explicit grantRoot.")?;
    let cwd = params
        .get("cwd")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(|| ctx.working_directory.clone());
    let mut targets: Vec<&Value> = Vec::new();
    if let Some(path) = params.get("path").filter(|v| !v.is_null()) {
        targets.push(path);
    }
    for key in ["paths", "files"] {
        match params.get(key) {
            None | Some(Value::Null) => {}
            Some(Value::Array(entries)) => targets.extend(entries),
            Some(_) => return Err(format!("Invalid file approval {key}.")),
        }
    }
    // Legacy `applyPatchApproval` carries its paths as `fileChanges` keys.
    let change_keys: Vec<Value> = match params.get("fileChanges") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Object(changes)) => changes.keys().cloned().map(Value::String).collect(),
        Some(_) => return Err("Invalid file approval fileChanges.".into()),
    };
    targets.extend(&change_keys);

    let grant_root = Value::String(grant_root.to_owned());
    for target in std::iter::once(&grant_root).chain(targets) {
        let Some(raw) = target.as_str().filter(|s| !s.trim().is_empty()) else {
            return Err("Scoped file approval contains an ambiguous target.".into());
        };
        // `path.resolve(workingDirectory, cwd, target)`: absolute segments replace the base.
        let resolved = ctx.working_directory.join(&cwd).join(raw);
        assert_write_path_allowed(&resolved, ctx).map_err(|e| e.to_string())?;
    }
    Ok(())
}

impl CodexDynamicBridge {
    /// Shows a native Codex approval to the user. Only reached once
    /// [`assert_codex_approval_preserves_policy`] has accepted the request.
    async fn prompt_native_approval(
        &self,
        method: &str,
        is_file_change: bool,
        params: &Value,
    ) -> bool {
        if is_file_change {
            let fp = ["grantRoot", "path", "filePath"]
                .iter()
                .find_map(|key| params.get(*key).and_then(Value::as_str))
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    struct NullSink;
    impl HarnessEventSink for NullSink {
        fn send_notification(&self, _method: &str, _params: Value) {}
        fn send_server_request(&self, _request_id: &str, _method: &str, _params: Value) {}
    }

    fn test_config(provider: ProviderName, model: &str, max_steps: usize) -> TurnRunConfig {
        TurnRunConfig {
            thread_id: "t".to_owned(),
            turn_id: "turn".to_owned(),
            provider,
            model_id: model.to_owned(),
            base_url: None,
            api_key: None,
            extra_headers: HashMap::new(),
            system_prompt: "sys".to_owned(),
            provider_options: Map::new(),
            deferred_tool_search: false,
            max_steps,
            step_timeout_ms: 5_000,
            overflow_threshold_chars: None,
            tool_retry_lineage: false,
            initial_user_message: None,
            model_max_retries: None,
        }
    }

    /// Blocks until the context's cancellation receiver fires.
    struct WaitForStopTool;

    #[async_trait]
    impl cowork_tools::BuiltinTool for WaitForStopTool {
        fn name(&self) -> &str {
            "waitForStop"
        }
        fn description(&self) -> &str {
            "waits for turn cancellation"
        }
        fn input_schema(&self) -> Value {
            json!({ "type": "object" })
        }
        async fn execute(
            &self,
            _raw_args: Map<String, Value>,
            ctx: &ToolExecutionContext,
        ) -> cowork_tools::ToolResult<ToolOutput> {
            let Some(mut rx) = ctx.cancel_rx.clone() else {
                tokio::time::sleep(Duration::from_secs(30)).await;
                return Ok(ToolOutput::Text("never cancelled".to_owned()));
            };
            while !*rx.borrow() {
                if rx.changed().await.is_err() {
                    break;
                }
            }
            Ok(ToolOutput::Text("cancelled".to_owned()))
        }
    }

    #[tokio::test]
    async fn codex_bridge_built_after_install_cancellation_observes_stop() {
        let dir = tempfile::tempdir().unwrap();
        let runner = TurnStepRunner::new(test_config(ProviderName::CodexCli, "m", 1));
        let mut ctx = ToolExecutionContext::new_for_tests(
            dir.path().to_path_buf(),
            dir.path().to_path_buf(),
            ProviderName::CodexCli,
            "m",
        );
        runner.install_cancellation(&mut ctx);
        let mut tools = ToolMap::new();
        tools.insert("waitForStop".to_owned(), Arc::new(WaitForStopTool));
        let im = Arc::new(InteractionManager::new("t", Arc::new(NullSink)));
        let bridge = TurnStepRunner::build_codex_dynamic_tool_handler(tools, ctx, im, None);

        let call = tokio::spawn(async move { bridge.call_tool("waitForStop", Map::new()).await });
        tokio::time::sleep(Duration::from_millis(50)).await;
        runner.cancellation_handle().interrupt("stop");
        let out = tokio::time::timeout(Duration::from_secs(5), call)
            .await
            .expect("nested bridge tool must observe Stop")
            .unwrap();
        assert_eq!(out.text, "cancelled");
    }

    #[test]
    fn tool_input_digest_is_canonical_and_key_order_independent() {
        let a = digest_tool_input("read", &json!({ "b": 1.0, "a": "x" }));
        let b = digest_tool_input("read", &json!({ "a": "x", "b": 1 }));
        assert_eq!(a, b);
        // `{"args":{"a":"x","b":1},"toolName":"read"}`
        assert_eq!(a["canonicalBytes"], json!(42));
        assert_ne!(a, digest_tool_input("write", &json!({ "a": "x", "b": 1 })));
    }

    /// Records each step's continuation; validates it the way the OpenAI transport does.
    struct ContinuationProbeTransport {
        seen: Mutex<Vec<(bool, bool)>>,
    }

    #[async_trait]
    impl ProviderTransport for ContinuationProbeTransport {
        async fn stream_step(
            &self,
            req: ProviderStepRequest,
            _budget: &StepBudget,
            _on_event: &mut cowork_providers::StreamEventCallback<'_>,
        ) -> Result<cowork_providers::ProviderStepResult, cowork_inference::ProviderTransportError>
        {
            let step = self.seen.lock().len();
            let tool_values: Vec<Value> = req
                .tools
                .iter()
                .map(|t| serde_json::to_value(t).unwrap())
                .collect();
            let prefix_valid = req.continuation.as_ref().is_some_and(|stored| {
                cowork_providers::candidate_continuation_splits(&req.messages)
                    .into_iter()
                    .any(|(prefix, _)| {
                        let fp = compute_continuation_fingerprint(&ContinuationFingerprintInput {
                            provider: "openai",
                            model_id: &req.model_id,
                            system_prompt: &req.system_prompt,
                            tools: &tool_values,
                            authorized_tool_names: req.authorized_tool_names.as_deref(),
                            canonical_prefix: prefix,
                            stream_options: &req.provider_options,
                        });
                        cowork_inference::validate_continuation_state(
                            Some(stored),
                            "openai",
                            &req.model_id,
                            &fp,
                        )
                        .is_some()
                    })
            });
            self.seen
                .lock()
                .push((req.continuation.is_some(), prefix_valid));
            let content = if step == 0 {
                vec![ContentBlock::ToolCall {
                    id: "call_1".to_owned(),
                    name: "noSuchTool".to_owned(),
                    arguments: Map::new(),
                    partial_json: None,
                    provider_meta: ProviderOpaqueMeta::default(),
                }]
            } else {
                vec![ContentBlock::Text {
                    text: "done".to_owned(),
                    phase: None,
                    citations: Vec::new(),
                    provider_meta: ProviderOpaqueMeta::default(),
                }]
            };
            let mut assistant = new_user_text_message("");
            assistant.role = MessageRole::Assistant;
            assistant.content = content;
            Ok(cowork_providers::ProviderStepResult {
                assistant,
                persisted_assistant: None,
                usage: TurnUsage::default(),
                continuation: Some(ProviderContinuationState::OpenAi {
                    model: req.model_id.clone(),
                    response_id: format!("resp_{step}"),
                    updated_at: "2026-01-01T00:00:00.000Z".to_owned(),
                    request_fingerprint: String::new(),
                }),
                raw_events: Vec::new(),
            })
        }
    }

    #[tokio::test]
    async fn continuation_survives_a_tool_iteration() {
        let dir = tempfile::tempdir().unwrap();
        let runner = TurnStepRunner::new(test_config(ProviderName::Openai, "gpt-test", 4));
        let mut ctx = ToolExecutionContext::new_for_tests(
            dir.path().to_path_buf(),
            dir.path().to_path_buf(),
            ProviderName::Openai,
            "gpt-test",
        );
        let sink: Arc<dyn HarnessEventSink> = Arc::new(NullSink);
        let im = Arc::new(InteractionManager::new("t", Arc::clone(&sink)));
        let steer = Arc::new(SteerCoordinator::new("t", "turn", Arc::clone(&sink), None));
        let transport = Arc::new(ContinuationProbeTransport {
            seen: Mutex::new(Vec::new()),
        });
        let mut cost = SessionCostTracker::new("t", None);
        let outcome = runner
            .run_turn(
                transport.clone(),
                vec![new_user_text_message("hi")],
                &mut ctx,
                &im,
                &steer,
                &mut cost,
                None,
                sink,
            )
            .await;
        assert_eq!(outcome.status, "completed");
        // Step 2 follows a tool iteration: it must still receive the continuation, and the
        // transport's candidate-prefix check must accept it.
        assert_eq!(*transport.seen.lock(), vec![(false, false), (true, true)]);
    }

    /// Answers every step with one fixed assistant message.
    struct FixedAssistantTransport {
        content: Vec<ContentBlock>,
    }

    #[async_trait]
    impl ProviderTransport for FixedAssistantTransport {
        async fn stream_step(
            &self,
            _req: ProviderStepRequest,
            _budget: &StepBudget,
            _on_event: &mut cowork_providers::StreamEventCallback<'_>,
        ) -> Result<cowork_providers::ProviderStepResult, cowork_inference::ProviderTransportError>
        {
            let mut assistant = new_user_text_message("");
            assistant.role = MessageRole::Assistant;
            assistant.content = self.content.clone();
            Ok(cowork_providers::ProviderStepResult {
                assistant,
                persisted_assistant: None,
                usage: TurnUsage::default(),
                continuation: None,
                raw_events: Vec::new(),
            })
        }
    }

    fn text_block(text: &str, phase: Option<TextPhase>) -> ContentBlock {
        ContentBlock::Text {
            text: text.to_owned(),
            phase,
            citations: Vec::new(),
            provider_meta: ProviderOpaqueMeta::default(),
        }
    }

    #[tokio::test]
    async fn last_assistant_text_joins_every_text_block_of_the_final_message() {
        let dir = tempfile::tempdir().unwrap();
        let runner = TurnStepRunner::new(test_config(ProviderName::Anthropic, "claude-test", 4));
        let mut ctx = ToolExecutionContext::new_for_tests(
            dir.path().to_path_buf(),
            dir.path().to_path_buf(),
            ProviderName::Anthropic,
            "claude-test",
        );
        let sink: Arc<dyn HarnessEventSink> = Arc::new(NullSink);
        let im = Arc::new(InteractionManager::new("t", Arc::clone(&sink)));
        let steer = Arc::new(SteerCoordinator::new("t", "turn", Arc::clone(&sink), None));
        // The report spans two text blocks; reasoning and commentary carry decoy reports.
        let transport = Arc::new(FixedAssistantTransport {
            content: vec![
                ContentBlock::Thinking {
                    text:
                        "<agent_report>{\"status\":\"failed\",\"summary\":\"draft\"}</agent_report>"
                            .to_owned(),
                    summary: None,
                    redacted: false,
                    signature: None,
                    provider_meta: ProviderOpaqueMeta::default(),
                },
                text_block(
                    "<agent_report>{\"status\":\"blocked\",\"summary\":\"aside\"}</agent_report>",
                    Some(TextPhase::Commentary),
                ),
                text_block("  Finished the review.  ", None),
                text_block("   ", None),
                text_block("<agent_report>\n{\"status\":\"completed\",", None),
                text_block("\"summary\":\"All checks pass\"}\n</agent_report>\n", None),
            ],
        });
        let mut cost = SessionCostTracker::new("t", None);
        let outcome = runner
            .run_turn(
                transport,
                vec![new_user_text_message("review")],
                &mut ctx,
                &im,
                &steer,
                &mut cost,
                None,
                sink,
            )
            .await;
        assert_eq!(outcome.status, "completed");
        let text = outcome.last_assistant_text.as_deref();
        assert_eq!(
            text,
            Some(
                "Finished the review.\n<agent_report>\n{\"status\":\"completed\",\n\
                 \"summary\":\"All checks pass\"}\n</agent_report>"
            )
        );
        let report = crate::agents::inspect_child_agent_report(text, true);
        assert!(report.report_valid, "{:?}", report.report_diagnostic);
        assert_eq!(report.report_block_count, 1);
        let parsed = report.parsed_report.unwrap();
        assert_eq!(parsed.status, "completed");
        assert_eq!(parsed.summary, "All checks pass");
    }

    #[test]
    fn assistant_content_text_is_none_without_visible_text() {
        let content = vec![
            text_block("only commentary", Some(TextPhase::Commentary)),
            text_block("  \n", Some(TextPhase::FinalAnswer)),
        ];
        assert_eq!(assistant_content_text(&content), None);
    }

    /// Emits two tool calls and interrupts the turn while the step streams.
    struct InterruptDuringStepTransport {
        handle: Mutex<Option<TurnCancellationHandle>>,
    }

    #[async_trait]
    impl ProviderTransport for InterruptDuringStepTransport {
        async fn stream_step(
            &self,
            req: ProviderStepRequest,
            _budget: &StepBudget,
            _on_event: &mut cowork_providers::StreamEventCallback<'_>,
        ) -> Result<cowork_providers::ProviderStepResult, cowork_inference::ProviderTransportError>
        {
            if let Some(h) = self.handle.lock().as_ref() {
                h.interrupt("stop");
            }
            let call = |id: &str| ContentBlock::ToolCall {
                id: id.to_owned(),
                name: "noSuchTool".to_owned(),
                arguments: Map::new(),
                partial_json: None,
                provider_meta: ProviderOpaqueMeta::default(),
            };
            let mut assistant = new_user_text_message("");
            assistant.role = MessageRole::Assistant;
            assistant.content = vec![call("call_a"), call("call_b")];
            let _ = req;
            Ok(cowork_providers::ProviderStepResult {
                assistant,
                persisted_assistant: None,
                usage: TurnUsage::default(),
                continuation: None,
                raw_events: Vec::new(),
            })
        }
    }

    #[tokio::test]
    async fn interruption_during_tool_batch_answers_every_tool_call() {
        let dir = tempfile::tempdir().unwrap();
        let runner = TurnStepRunner::new(test_config(ProviderName::Openai, "gpt-test", 4));
        let mut ctx = ToolExecutionContext::new_for_tests(
            dir.path().to_path_buf(),
            dir.path().to_path_buf(),
            ProviderName::Openai,
            "gpt-test",
        );
        let sink: Arc<dyn HarnessEventSink> = Arc::new(NullSink);
        let im = Arc::new(InteractionManager::new("t", Arc::clone(&sink)));
        let steer = Arc::new(SteerCoordinator::new("t", "turn", Arc::clone(&sink), None));
        let transport = Arc::new(InterruptDuringStepTransport {
            handle: Mutex::new(Some(runner.cancellation_handle())),
        });
        let mut cost = SessionCostTracker::new("t", None);
        let outcome = runner
            .run_turn(
                transport,
                vec![new_user_text_message("hi")],
                &mut ctx,
                &im,
                &steer,
                &mut cost,
                None,
                sink,
            )
            .await;
        assert_eq!(outcome.status, "interrupted");
        let last = outcome.messages.last().expect("tool message");
        assert_eq!(last.role, MessageRole::Tool);
        let ids: Vec<(&str, bool)> = last
            .content
            .iter()
            .filter_map(|b| match b {
                ContentBlock::ToolResult {
                    tool_call_id,
                    is_error,
                    ..
                } => Some((tool_call_id.as_str(), *is_error)),
                _ => None,
            })
            .collect();
        assert_eq!(ids, vec![("call_a", true), ("call_b", true)]);
    }

    /// How [`PartialOutputTransport`] ends step 2 after streaming partial output.
    #[derive(Clone, Copy, PartialEq)]
    enum PartialStepEnding {
        /// The provider stream disconnects.
        StreamError,
        /// The user stops generation.
        UserStop,
        /// The provider fails before streaming anything.
        SilentError,
    }

    /// Step 1 completes with a tool call; step 2 streams reasoning, prose, commentary and a tool
    /// call, then ends per `ending` without returning an assistant message.
    struct PartialOutputTransport {
        handle: TurnCancellationHandle,
        ending: PartialStepEnding,
        steps: Mutex<usize>,
    }

    #[async_trait]
    impl ProviderTransport for PartialOutputTransport {
        async fn stream_step(
            &self,
            _req: ProviderStepRequest,
            _budget: &StepBudget,
            on_event: &mut cowork_providers::StreamEventCallback<'_>,
        ) -> Result<cowork_providers::ProviderStepResult, cowork_inference::ProviderTransportError>
        {
            let step = {
                let mut steps = self.steps.lock();
                *steps += 1;
                *steps
            };
            if step == 1 {
                let mut assistant = new_user_text_message("");
                assistant.role = MessageRole::Assistant;
                assistant.content = vec![ContentBlock::ToolCall {
                    id: "call_1".to_owned(),
                    name: "noSuchTool".to_owned(),
                    arguments: Map::new(),
                    partial_json: None,
                    provider_meta: ProviderOpaqueMeta::default(),
                }];
                return Ok(cowork_providers::ProviderStepResult {
                    assistant,
                    persisted_assistant: None,
                    usage: TurnUsage::default(),
                    continuation: None,
                    raw_events: Vec::new(),
                });
            }
            if self.ending == PartialStepEnding::SilentError {
                return Err(cowork_inference::ProviderTransportError::protocol(
                    "provider exploded",
                ));
            }
            let turn_id = "turn".to_owned();
            let mode = ReasoningStreamMode::Reasoning;
            for ev in [
                StreamEvent::ThinkingStart {
                    turn_id: turn_id.clone(),
                    stream_id: "rs_1".to_owned(),
                    mode,
                },
                StreamEvent::ThinkingDelta {
                    turn_id: turn_id.clone(),
                    stream_id: "rs_1".to_owned(),
                    mode,
                    delta: "Weighing ".to_owned(),
                },
                StreamEvent::ThinkingEnd {
                    turn_id: turn_id.clone(),
                    stream_id: "rs_1".to_owned(),
                    mode,
                    text: "Weighing options.".to_owned(),
                    signature: Some("sig-from-unfinished-response".to_owned()),
                    redacted: false,
                },
                StreamEvent::TextDelta {
                    turn_id: turn_id.clone(),
                    block_index: 0,
                    delta: "Working on it".to_owned(),
                    phase: Some(TextPhase::Commentary),
                },
                StreamEvent::TextStart {
                    turn_id: turn_id.clone(),
                    block_index: 1,
                    phase: None,
                },
                StreamEvent::TextDelta {
                    turn_id: turn_id.clone(),
                    block_index: 1,
                    delta: "The answer ".to_owned(),
                    phase: None,
                },
                StreamEvent::TextDelta {
                    turn_id: turn_id.clone(),
                    block_index: 1,
                    delta: "is".to_owned(),
                    phase: None,
                },
                StreamEvent::ToolCallStart {
                    turn_id: turn_id.clone(),
                    key: "call_2".to_owned(),
                    name: "noSuchTool".to_owned(),
                    initial_args: None,
                },
            ] {
                on_event(ev);
            }
            match self.ending {
                PartialStepEnding::StreamError => Err(
                    cowork_inference::ProviderTransportError::network("stream disconnected"),
                ),
                _ => {
                    self.handle.interrupt("stop");
                    Err(cowork_inference::ProviderTransportError::aborted(
                        "Model turn aborted.",
                    ))
                }
            }
        }
    }

    async fn run_partial_output_turn(ending: PartialStepEnding) -> TurnRunOutcome {
        let dir = tempfile::tempdir().unwrap();
        let runner = TurnStepRunner::new(test_config(ProviderName::Openai, "gpt-test", 4));
        let mut ctx = ToolExecutionContext::new_for_tests(
            dir.path().to_path_buf(),
            dir.path().to_path_buf(),
            ProviderName::Openai,
            "gpt-test",
        );
        let sink: Arc<dyn HarnessEventSink> = Arc::new(NullSink);
        let im = Arc::new(InteractionManager::new("t", Arc::clone(&sink)));
        let steer = Arc::new(SteerCoordinator::new("t", "turn", Arc::clone(&sink), None));
        let transport = Arc::new(PartialOutputTransport {
            handle: runner.cancellation_handle(),
            ending,
            steps: Mutex::new(0),
        });
        let mut cost = SessionCostTracker::new("t", None);
        runner
            .run_turn(
                transport,
                vec![new_user_text_message("hi")],
                &mut ctx,
                &im,
                &steer,
                &mut cost,
                None,
                sink,
            )
            .await
    }

    fn roles(outcome: &TurnRunOutcome) -> Vec<MessageRole> {
        outcome.messages.iter().map(|m| m.role).collect()
    }

    #[tokio::test]
    async fn failed_step_keeps_streamed_text_and_reasoning_but_not_tool_calls() {
        let outcome = run_partial_output_turn(PartialStepEnding::StreamError).await;
        assert_eq!(outcome.status, "failed");
        assert_eq!(
            roles(&outcome),
            vec![
                MessageRole::User,
                MessageRole::Assistant,
                MessageRole::Tool,
                MessageRole::Assistant,
            ]
        );
        let partial = outcome.messages.last().unwrap();
        // The step never completed: no provider state may be replayed from it.
        assert_eq!(partial.provider, None);
        assert_eq!(partial.api, None);
        assert_eq!(partial.model, None);
        assert_eq!(partial.stop_reason, None);
        assert_eq!(
            partial.content,
            vec![
                ContentBlock::Thinking {
                    text: "Weighing options.".to_owned(),
                    summary: None,
                    redacted: false,
                    signature: None,
                    provider_meta: ProviderOpaqueMeta::default(),
                },
                ContentBlock::Text {
                    text: "The answer is".to_owned(),
                    phase: None,
                    citations: Vec::new(),
                    provider_meta: ProviderOpaqueMeta::default(),
                },
            ]
        );
    }

    #[tokio::test]
    async fn failed_step_without_streamed_output_adds_no_assistant_message() {
        let outcome = run_partial_output_turn(PartialStepEnding::SilentError).await;
        assert_eq!(outcome.status, "failed");
        assert_eq!(
            roles(&outcome),
            vec![MessageRole::User, MessageRole::Assistant, MessageRole::Tool]
        );
    }

    #[tokio::test]
    async fn user_stop_discards_the_in_flight_step_output() {
        // TS parity: a stopped step's partial output never entered history
        // (`codexAppServer/runTurn.ts`, `persistCancelledInvocationProgress`).
        let outcome = run_partial_output_turn(PartialStepEnding::UserStop).await;
        assert_eq!(outcome.status, "interrupted");
        assert_eq!(
            roles(&outcome),
            vec![MessageRole::User, MessageRole::Assistant, MessageRole::Tool]
        );
    }

    /// Simulates a steer accepted by the live native Codex turn during step 1.
    struct NativeSteerTransport {
        steer: Arc<SteerCoordinator>,
        steps: Mutex<usize>,
    }

    #[async_trait]
    impl ProviderTransport for NativeSteerTransport {
        async fn stream_step(
            &self,
            _req: ProviderStepRequest,
            _budget: &StepBudget,
            _on_event: &mut cowork_providers::StreamEventCallback<'_>,
        ) -> Result<cowork_providers::ProviderStepResult, cowork_inference::ProviderTransportError>
        {
            *self.steps.lock() += 1;
            if *self.steps.lock() == 1 {
                let res = self
                    .steer
                    .enqueue_steer("NATIVE-STEER".to_owned(), None)
                    .unwrap();
                self.steer
                    .mark_natively_delivered_for_tests(res["steerRequestId"].as_str().unwrap());
            }
            let mut assistant = new_user_text_message("");
            assistant.role = MessageRole::Assistant;
            assistant.content = vec![ContentBlock::Text {
                text: "done".to_owned(),
                phase: None,
                citations: Vec::new(),
                provider_meta: ProviderOpaqueMeta::default(),
            }];
            Ok(cowork_providers::ProviderStepResult {
                assistant,
                persisted_assistant: None,
                usage: TurnUsage::default(),
                continuation: None,
                raw_events: Vec::new(),
            })
        }
    }

    #[tokio::test]
    async fn natively_delivered_codex_steer_is_recorded_once_and_not_resubmitted() {
        let dir = tempfile::tempdir().unwrap();
        let runner = TurnStepRunner::new(test_config(ProviderName::CodexCli, "m", 4));
        let mut ctx = ToolExecutionContext::new_for_tests(
            dir.path().to_path_buf(),
            dir.path().to_path_buf(),
            ProviderName::CodexCli,
            "m",
        );
        let sink: Arc<dyn HarnessEventSink> = Arc::new(NullSink);
        let im = Arc::new(InteractionManager::new("t", Arc::clone(&sink)));
        let steer = Arc::new(SteerCoordinator::new("t", "turn", Arc::clone(&sink), None));
        let transport = Arc::new(NativeSteerTransport {
            steer: Arc::clone(&steer),
            steps: Mutex::new(0),
        });
        let mut cost = SessionCostTracker::new("t", None);
        let outcome = runner
            .run_turn(
                transport.clone(),
                vec![new_user_text_message("hi")],
                &mut ctx,
                &im,
                &steer,
                &mut cost,
                None,
                sink,
            )
            .await;
        assert_eq!(outcome.status, "completed");
        assert_eq!(
            *transport.steps.lock(),
            1,
            "native steer must not trigger another step"
        );
        let steer_msgs: Vec<usize> = outcome
            .messages
            .iter()
            .enumerate()
            .filter(|(_, m)| serde_json::to_string(m).unwrap().contains("NATIVE-STEER"))
            .map(|(i, _)| i)
            .collect();
        assert_eq!(steer_msgs.len(), 1, "steer recorded exactly once");
        // Recorded ahead of the step's assistant output.
        assert_eq!(
            outcome.messages[steer_msgs[0] + 1].role,
            MessageRole::Assistant
        );
        assert!(!steer.has_pending());
    }

    /// Simulates the native Codex turn invoking deferred meta-tools through the dynamic bridge.
    struct CodexMetaToolTransport {
        bridge: Arc<dyn DynamicToolHandler>,
        outputs: Mutex<Vec<DynamicToolCallOutput>>,
    }

    #[async_trait]
    impl ProviderTransport for CodexMetaToolTransport {
        async fn stream_step(
            &self,
            _req: ProviderStepRequest,
            _budget: &StepBudget,
            _on_event: &mut cowork_providers::StreamEventCallback<'_>,
        ) -> Result<cowork_providers::ProviderStepResult, cowork_inference::ProviderTransportError>
        {
            let mut search = Map::new();
            search.insert("query".to_owned(), json!("read"));
            let found = self.bridge.call_tool("toolSearch", search).await;
            let mut call = Map::new();
            call.insert("name".to_owned(), json!("read"));
            call.insert("arguments".to_owned(), json!({ "filePath": "note.txt" }));
            let read = self.bridge.call_tool("toolCall", call).await;
            self.outputs.lock().extend([found, read]);
            let mut assistant = new_user_text_message("");
            assistant.role = MessageRole::Assistant;
            assistant.content = vec![ContentBlock::Text {
                text: "done".to_owned(),
                phase: None,
                citations: Vec::new(),
                provider_meta: ProviderOpaqueMeta::default(),
            }];
            Ok(cowork_providers::ProviderStepResult {
                assistant,
                persisted_assistant: None,
                usage: TurnUsage::default(),
                continuation: None,
                raw_events: Vec::new(),
            })
        }
    }

    #[tokio::test]
    async fn codex_bridge_dispatches_deferred_meta_tools_from_turn_catalog() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("note.txt"), "META-TOOL-CONTENT").unwrap();
        let mut cfg = test_config(ProviderName::CodexCli, "m", 2);
        cfg.deferred_tool_search = true;
        let runner = TurnStepRunner::new(cfg);
        let mut ctx = ToolExecutionContext::new_for_tests(
            dir.path().to_path_buf(),
            dir.path().to_path_buf(),
            ProviderName::CodexCli,
            "m",
        );
        let sink: Arc<dyn HarnessEventSink> = Arc::new(NullSink);
        let im = Arc::new(InteractionManager::new("t", Arc::clone(&sink)));
        let steer = Arc::new(SteerCoordinator::new("t", "turn", Arc::clone(&sink), None));
        // Built before the turn, like the server does: the fallback map lacks `toolCall`.
        let bridge = TurnStepRunner::build_codex_dynamic_tool_handler_with_catalog(
            create_builtin_tools(&ctx),
            ctx.clone(),
            Arc::clone(&im),
            None,
            Some(runner.codex_bridge_catalog()),
        );
        let transport = Arc::new(CodexMetaToolTransport {
            bridge,
            outputs: Mutex::new(Vec::new()),
        });
        let mut cost = SessionCostTracker::new("t", None);
        let outcome = runner
            .run_turn(
                transport.clone(),
                vec![new_user_text_message("hi")],
                &mut ctx,
                &im,
                &steer,
                &mut cost,
                None,
                sink,
            )
            .await;
        assert_eq!(outcome.status, "completed");
        let outputs = transport.outputs.lock();
        assert!(!outputs[0].is_error, "toolSearch: {}", outputs[0].text);
        assert!(outputs[0].text.contains("read"), "{}", outputs[0].text);
        assert!(!outputs[1].is_error, "toolCall: {}", outputs[1].text);
        assert!(
            outputs[1].text.contains("META-TOOL-CONTENT"),
            "{}",
            outputs[1].text
        );
    }

    /// Two tool iterations then a final answer, each step reporting usage.
    struct ThreeStepUsageTransport {
        steps: Mutex<usize>,
    }

    #[async_trait]
    impl ProviderTransport for ThreeStepUsageTransport {
        async fn stream_step(
            &self,
            _req: ProviderStepRequest,
            _budget: &StepBudget,
            _on_event: &mut cowork_providers::StreamEventCallback<'_>,
        ) -> Result<cowork_providers::ProviderStepResult, cowork_inference::ProviderTransportError>
        {
            let step = {
                let mut steps = self.steps.lock();
                *steps += 1;
                *steps
            };
            let content = if step < 3 {
                vec![ContentBlock::ToolCall {
                    id: format!("call_{step}"),
                    name: "noSuchTool".to_owned(),
                    arguments: Map::new(),
                    partial_json: None,
                    provider_meta: ProviderOpaqueMeta::default(),
                }]
            } else {
                vec![ContentBlock::Text {
                    text: "done".to_owned(),
                    phase: None,
                    citations: Vec::new(),
                    provider_meta: ProviderOpaqueMeta::default(),
                }]
            };
            let mut assistant = new_user_text_message("");
            assistant.role = MessageRole::Assistant;
            assistant.content = content;
            Ok(cowork_providers::ProviderStepResult {
                assistant,
                persisted_assistant: None,
                usage: TurnUsage {
                    prompt_tokens: 100,
                    completion_tokens: 10,
                    total_tokens: 110,
                    ..TurnUsage::default()
                },
                continuation: None,
                raw_events: Vec::new(),
            })
        }
    }

    #[tokio::test]
    async fn multi_step_turn_records_one_aggregated_cost_entry() {
        let dir = tempfile::tempdir().unwrap();
        let runner = TurnStepRunner::new(test_config(ProviderName::Openai, "gpt-test", 8));
        let mut ctx = ToolExecutionContext::new_for_tests(
            dir.path().to_path_buf(),
            dir.path().to_path_buf(),
            ProviderName::Openai,
            "gpt-test",
        );
        let sink: Arc<dyn HarnessEventSink> = Arc::new(NullSink);
        let im = Arc::new(InteractionManager::new("t", Arc::clone(&sink)));
        let steer = Arc::new(SteerCoordinator::new("t", "turn", Arc::clone(&sink), None));
        let transport = Arc::new(ThreeStepUsageTransport {
            steps: Mutex::new(0),
        });
        let mut cost = SessionCostTracker::new("t", None);
        let outcome = runner
            .run_turn(
                transport.clone(),
                vec![new_user_text_message("hi")],
                &mut ctx,
                &im,
                &steer,
                &mut cost,
                None,
                sink,
            )
            .await;
        assert_eq!(outcome.status, "completed");
        assert_eq!(*transport.steps.lock(), 3);
        assert_eq!(outcome.usage.total_tokens, 330);

        let snap = cost.get_snapshot();
        assert_eq!(snap.total_turns, 1);
        assert_eq!(snap.turns.len(), 1);
        assert_eq!(snap.turns[0].turn_id, "turn");
        assert_eq!(snap.turns[0].usage.prompt_tokens, 300);
        assert_eq!(snap.turns[0].usage.completion_tokens, 30);
        assert_eq!(snap.turns[0].usage.total_tokens, 330);
        assert_eq!(snap.total_tokens, 330);
        assert_eq!(snap.by_model[0].turns, 1);
    }

    #[derive(Default)]
    struct RecordingSink {
        notifications: Mutex<Vec<(String, Value)>>,
    }
    impl HarnessEventSink for RecordingSink {
        fn send_notification(&self, method: &str, params: Value) {
            self.notifications.lock().push((method.to_owned(), params));
        }
        fn send_server_request(&self, _request_id: &str, _method: &str, _params: Value) {}
    }

    /// How [`SteerThenInterruptTransport`] ends its step after queueing a steer.
    #[derive(Clone, Copy)]
    enum SteerStepEnding {
        /// The provider call is interrupted (aborted) mid-stream.
        ProviderAbort,
        /// The provider returns tool calls and the turn is interrupted before they run.
        ToolBatchInterrupt,
        /// The provider call fails with a non-abort error.
        ProviderFailure,
        /// The provider returns a final text answer (no tool calls).
        FinalText,
    }

    /// Accepts a non-native `turn/steer` while the provider call is running, then ends the step
    /// without reaching the next step boundary (where queued steers are normally drained).
    struct SteerThenInterruptTransport {
        steer: Arc<SteerCoordinator>,
        handle: TurnCancellationHandle,
        ending: SteerStepEnding,
    }

    #[async_trait]
    impl ProviderTransport for SteerThenInterruptTransport {
        async fn stream_step(
            &self,
            _req: ProviderStepRequest,
            _budget: &StepBudget,
            _on_event: &mut cowork_providers::StreamEventCallback<'_>,
        ) -> Result<cowork_providers::ProviderStepResult, cowork_inference::ProviderTransportError>
        {
            self.steer
                .enqueue_steer("Also check the tests.".to_owned(), Some("cm-1".to_owned()))
                .expect("steer accepted while the provider call runs");
            match self.ending {
                SteerStepEnding::ProviderAbort => {
                    self.handle.interrupt("stop");
                    Err(cowork_inference::ProviderTransportError::aborted(
                        "aborted by user",
                    ))
                }
                SteerStepEnding::ProviderFailure => Err(
                    cowork_inference::ProviderTransportError::protocol("provider exploded"),
                ),
                SteerStepEnding::ToolBatchInterrupt | SteerStepEnding::FinalText => {
                    let mut assistant = new_user_text_message("done");
                    assistant.role = MessageRole::Assistant;
                    if matches!(self.ending, SteerStepEnding::ToolBatchInterrupt) {
                        self.handle.interrupt("stop");
                        assistant.content = vec![ContentBlock::ToolCall {
                            id: "call_a".to_owned(),
                            name: "noSuchTool".to_owned(),
                            arguments: Map::new(),
                            partial_json: None,
                            provider_meta: ProviderOpaqueMeta::default(),
                        }];
                    }
                    Ok(cowork_providers::ProviderStepResult {
                        assistant,
                        persisted_assistant: None,
                        usage: TurnUsage::default(),
                        continuation: None,
                        raw_events: Vec::new(),
                    })
                }
            }
        }
    }

    async fn run_turn_with_queued_steer(
        ending: SteerStepEnding,
        max_steps: usize,
    ) -> (TurnRunOutcome, Vec<(String, Value)>, Arc<SteerCoordinator>) {
        let dir = tempfile::tempdir().unwrap();
        let runner = TurnStepRunner::new(test_config(ProviderName::Openai, "gpt-test", max_steps));
        let mut ctx = ToolExecutionContext::new_for_tests(
            dir.path().to_path_buf(),
            dir.path().to_path_buf(),
            ProviderName::Openai,
            "gpt-test",
        );
        let recorder = Arc::new(RecordingSink::default());
        let sink: Arc<dyn HarnessEventSink> = recorder.clone();
        let im = Arc::new(InteractionManager::new("t", Arc::clone(&sink)));
        let steer = Arc::new(SteerCoordinator::new("t", "turn", Arc::clone(&sink), None));
        let transport = Arc::new(SteerThenInterruptTransport {
            steer: Arc::clone(&steer),
            handle: runner.cancellation_handle(),
            ending,
        });
        let mut cost = SessionCostTracker::new("t", None);
        let outcome = runner
            .run_turn(
                transport,
                vec![new_user_text_message("hi")],
                &mut ctx,
                &im,
                &steer,
                &mut cost,
                None,
                sink,
            )
            .await;
        let notifications = recorder.notifications.lock().clone();
        (outcome, notifications, steer)
    }

    /// Asserts the queued steer was rejected with its originating ids before `turn/completed`,
    /// and never recorded as a user message.
    fn assert_steer_rejected(
        outcome: &TurnRunOutcome,
        notifications: &[(String, Value)],
        steer: &SteerCoordinator,
        expected_message: &str,
    ) {
        let steer_request_id = notifications
            .iter()
            .find(|(m, _)| m == "cowork/session/steerAccepted")
            .and_then(|(_, p)| p["steerRequestId"].as_str())
            .expect("steer accepted")
            .to_owned();
        let rejection_idx = notifications
            .iter()
            .position(|(m, p)| {
                m == "item/completed"
                    && p["item"]["type"] == "error"
                    && p["item"]["steerRequestId"] == json!(steer_request_id)
            })
            .expect("queued steer must be rejected with a correlated error item");
        let item = &notifications[rejection_idx].1["item"];
        assert_eq!(item["clientMessageId"], "cm-1");
        assert_eq!(item["message"], expected_message);
        assert_eq!(item["code"], "validation_failed");
        assert_eq!(item["source"], "session");
        let completed_idx = notifications
            .iter()
            .position(|(m, _)| m == "turn/completed")
            .expect("turn completed");
        assert!(
            rejection_idx < completed_idx,
            "steer rejection must precede turn/completed"
        );
        assert!(
            !notifications
                .iter()
                .any(|(_, p)| p["item"]["type"] == "userMessage"),
            "rejected steer must not be recorded as a user message"
        );
        assert!(
            !outcome.messages.iter().any(|m| m.role == MessageRole::User
                && m.content.iter().any(|b| matches!(
                    b,
                    ContentBlock::Text { text, .. } if text.contains("Also check the tests.")
                ))),
            "rejected steer must not enter history"
        );
        assert!(!steer.has_pending());
        let late = steer
            .enqueue_steer("too late".to_owned(), None)
            .expect_err("a settled turn must not admit new steers");
        assert_eq!(late.message, "Active turn no longer accepts steering.");
    }

    #[tokio::test]
    async fn queued_steer_is_rejected_when_provider_call_is_interrupted() {
        let (outcome, notifications, steer) =
            run_turn_with_queued_steer(SteerStepEnding::ProviderAbort, 4).await;
        assert_eq!(outcome.status, "interrupted");
        assert_steer_rejected(&outcome, &notifications, &steer, STEER_REJECTED_INTERRUPTED);
    }

    #[tokio::test]
    async fn queued_steer_is_rejected_when_tool_batch_is_interrupted() {
        let (outcome, notifications, steer) =
            run_turn_with_queued_steer(SteerStepEnding::ToolBatchInterrupt, 4).await;
        assert_eq!(outcome.status, "interrupted");
        assert_steer_rejected(&outcome, &notifications, &steer, STEER_REJECTED_INTERRUPTED);
    }

    #[tokio::test]
    async fn queued_steer_is_rejected_when_provider_call_fails() {
        let (outcome, notifications, steer) =
            run_turn_with_queued_steer(SteerStepEnding::ProviderFailure, 4).await;
        assert_eq!(outcome.status, "failed");
        assert_steer_rejected(&outcome, &notifications, &steer, STEER_REJECTED_TURN_ENDED);
    }

    #[tokio::test]
    async fn queued_steer_is_rejected_when_step_budget_is_exhausted() {
        let (outcome, notifications, steer) =
            run_turn_with_queued_steer(SteerStepEnding::FinalText, 1).await;
        assert_eq!(outcome.status, "completed");
        assert_steer_rejected(&outcome, &notifications, &steer, STEER_REJECTED_MAX_STEPS);
    }

    /// A persistently overloaded provider must cost the policy's `max_attempts` HTTP requests per
    /// step. Harness and transport both looping would multiply that to `max_attempts²`.
    #[tokio::test]
    async fn persistent_503_step_issues_exactly_policy_max_attempts_http_requests() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let hits = Arc::new(AtomicUsize::new(0));
        let app = {
            let hits = Arc::clone(&hits);
            axum::Router::new().route(
                "/v1/chat/completions",
                axum::routing::post(move || {
                    let hits = Arc::clone(&hits);
                    async move {
                        hits.fetch_add(1, Ordering::SeqCst);
                        (
                            axum::http::StatusCode::SERVICE_UNAVAILABLE,
                            [("retry-after-ms", "0")],
                            r#"{"error":{"message":"overloaded"}}"#,
                        )
                    }
                }),
            )
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let dir = tempfile::tempdir().unwrap();
        let mut cfg = test_config(ProviderName::Together, "m", 1);
        cfg.base_url = Some(format!("http://{addr}/v1"));
        cfg.api_key = Some("test-key".to_owned());
        cfg.step_timeout_ms = 30_000;
        let runner = TurnStepRunner::new(cfg);
        let mut ctx = ToolExecutionContext::new_for_tests(
            dir.path().to_path_buf(),
            dir.path().to_path_buf(),
            ProviderName::Together,
            "m",
        );
        let sink: Arc<dyn HarnessEventSink> = Arc::new(NullSink);
        let im = Arc::new(InteractionManager::new("t", Arc::clone(&sink)));
        let steer = Arc::new(SteerCoordinator::new("t", "turn", Arc::clone(&sink), None));
        let transport: Arc<dyn ProviderTransport> = Arc::new(
            cowork_providers::ChatCompletionsTransport::new(ProviderName::Together)
                .expect("together quirks"),
        );
        let mut cost = SessionCostTracker::new("t", None);
        let outcome = runner
            .run_turn(
                transport,
                vec![new_user_text_message("hi")],
                &mut ctx,
                &im,
                &steer,
                &mut cost,
                None,
                sink,
            )
            .await;
        server.abort();

        assert_eq!(outcome.status, "failed");
        let max_attempts = RequestPolicy::default().max_attempts;
        assert_eq!(
            max_attempts,
            cowork_inference::RATE_LIMIT_RETRY_DEFAULT_MAX_ATTEMPTS
        );
        assert_eq!(
            hits.load(Ordering::SeqCst),
            max_attempts,
            "one retry loop per step: expected max_attempts requests, not max_attempts²"
        );
    }

    /// Sleeps `delay` per step (ignoring the budget, like a transport that never checks it) and
    /// records the budget/policy the harness handed it.
    struct BudgetProbeTransport {
        delay: Duration,
        seen: Mutex<Vec<(bool, RequestPolicy)>>,
    }

    #[async_trait]
    impl ProviderTransport for BudgetProbeTransport {
        async fn stream_step(
            &self,
            req: ProviderStepRequest,
            budget: &StepBudget,
            _on_event: &mut cowork_providers::StreamEventCallback<'_>,
        ) -> Result<cowork_providers::ProviderStepResult, cowork_inference::ProviderTransportError>
        {
            self.seen.lock().push((budget.is_unbounded(), req.policy));
            tokio::time::sleep(self.delay).await;
            let mut assistant = new_user_text_message("done");
            assistant.role = MessageRole::Assistant;
            Ok(cowork_providers::ProviderStepResult {
                assistant,
                persisted_assistant: None,
                usage: TurnUsage::default(),
                continuation: None,
                raw_events: Vec::new(),
            })
        }
    }

    async fn run_budget_probe(
        cfg: TurnRunConfig,
        delay: Duration,
    ) -> (String, Arc<BudgetProbeTransport>) {
        let dir = tempfile::tempdir().unwrap();
        let provider = cfg.provider;
        let runner = TurnStepRunner::new(cfg);
        let mut ctx = ToolExecutionContext::new_for_tests(
            dir.path().to_path_buf(),
            dir.path().to_path_buf(),
            provider,
            "m",
        );
        let sink: Arc<dyn HarnessEventSink> = Arc::new(NullSink);
        let im = Arc::new(InteractionManager::new("t", Arc::clone(&sink)));
        let steer = Arc::new(SteerCoordinator::new("t", "turn", Arc::clone(&sink), None));
        let transport = Arc::new(BudgetProbeTransport {
            delay,
            seen: Mutex::new(Vec::new()),
        });
        let mut cost = SessionCostTracker::new("t", None);
        let outcome = runner
            .run_turn(
                transport.clone(),
                vec![new_user_text_message("hi")],
                &mut ctx,
                &im,
                &steer,
                &mut cost,
                None,
                sink,
            )
            .await;
        (outcome.status, transport)
    }

    #[tokio::test]
    async fn step_longer_than_timeout_ms_completes_within_step_timeout_ms() {
        let mut cfg = test_config(ProviderName::Openai, "m", 1);
        cfg.provider_options = json!({ "openai": { "timeoutMs": 50, "stepTimeoutMs": 5_000 } })
            .as_object()
            .cloned()
            .unwrap();
        let (status, transport) = run_budget_probe(cfg, Duration::from_millis(300)).await;
        assert_eq!(status, "completed");
        let seen = transport.seen.lock();
        assert!(!seen[0].0, "non-Codex steps are bounded by the step budget");
        assert_eq!(seen[0].1.timeout_ms, 50);
        assert_eq!(seen[0].1.step_timeout_ms, 5_000);
        assert_eq!(seen[0].1.max_attempts, 1, "transports run a single attempt");
    }

    #[tokio::test]
    async fn provider_step_timeout_ms_bounds_the_whole_step() {
        let mut cfg = test_config(ProviderName::Openai, "m", 1);
        cfg.provider_options = json!({ "openai": { "stepTimeoutMs": 100 } })
            .as_object()
            .cloned()
            .unwrap();
        let (status, transport) = run_budget_probe(cfg, Duration::from_secs(5)).await;
        assert_eq!(status, "failed");
        assert_eq!(transport.seen.lock()[0].1.timeout_ms, 100);
    }

    #[tokio::test]
    async fn invalid_request_policy_fails_the_turn_before_any_request() {
        let mut cfg = test_config(ProviderName::Anthropic, "m", 1);
        cfg.provider_options = json!({ "anthropic": { "timeoutMs": 0 } })
            .as_object()
            .cloned()
            .unwrap();
        let (status, transport) = run_budget_probe(cfg, Duration::ZERO).await;
        assert_eq!(status, "failed");
        assert!(transport.seen.lock().is_empty());
    }

    #[tokio::test]
    async fn codex_app_server_steps_have_no_step_deadline() {
        let mut cfg = test_config(ProviderName::CodexCli, "m", 1);
        cfg.step_timeout_ms = 100;
        let (status, transport) = run_budget_probe(cfg, Duration::from_millis(400)).await;
        assert_eq!(status, "completed");
        assert!(transport.seen.lock()[0].0, "Codex gets an unbounded budget");
    }
}
