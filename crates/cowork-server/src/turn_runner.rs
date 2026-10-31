use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use cowork_config::{
    ProviderName, canonicalize_sync, get_ai_coworker_paths, read_connection_store,
};
use cowork_harness::{
    HarnessEventSink, InteractionManager, MemoryGenerator, RemoteMemoryModel, RemoteTitleOptions,
    SteerCoordinator, SystemPromptBuildOptions, TurnCancellationHandle, TurnIdempotencyLedger,
    TurnRunConfig, TurnStepRunner, build_layered_system_prompt, generate_heuristic_session_title,
    generate_remote_session_title, materialize_turn_attachments,
    preferred_title_model_for_provider, resolve_turn_mentions,
};
use cowork_inference::{
    BudgetThresholds, CanonicalMessage, ContentBlock, MessageRole, ProviderContinuationState,
    ProviderOpaqueMeta, SessionCostTracker, SessionUsageSnapshot,
};
use cowork_protocol::{
    JsonRpcLiteClientResponse, JsonRpcLiteError, JsonRpcLiteId, JsonRpcLiteNotification,
    JsonRpcLiteOutbound, JsonRpcLiteRequest, JsonRpcLiteResponse, TurnInterruptParams,
    TurnStartParams, TurnSteerParams, error_codes,
};
use cowork_providers::bedrock::{
    BedrockAuthConfig, extract_bedrock_region_override, resolve_bedrock_auth_config,
};
use cowork_providers::chat_completions::lmstudio::{
    LmStudioLocalService, resolve_lmstudio_options,
};
use cowork_providers::{
    AnthropicMessagesTransport, BedrockConverseTransport, ChatCompletionsTransport,
    CodexAppServerTransport, GoogleInteractionsTransport, OpenAiResponsesTransport,
    ProviderTransport, resolve_provider_api_key,
};
use cowork_sandbox::{
    ResolveSandboxPolicyInput, SandboxPolicy, resolve_sandbox_policy, scratch_roots,
};
use cowork_storage::{HOT_MEMORY_ID, MemoryScope, SessionTitleSource, ThreadJournalEventInput};
use cowork_tools::{
    ApprovalHandler, ToolExecutionContext, create_builtin_tools, discover_skills,
    discover_skills_for_config,
};
use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::memory_and_fork_routes::ServerThreadControlBridge;
use crate::registry::{LiveSession, ServerRuntimeState};

const DEFAULT_MAX_TURN_STEPS: usize = 100;
const STEP_TIMEOUT_MS: u64 = 300_000;

pub(crate) struct ActiveTurnControl {
    pub turn_id: String,
    pub cancel: TurnCancellationHandle,
    pub steer: Arc<SteerCoordinator>,
    pub interactions: Arc<InteractionManager>,
}

struct ServerHarnessEventSink {
    runtime: Arc<ServerRuntimeState>,
    thread_id: String,
    fallback_conn_id: Mutex<Option<String>>,
    turn_id: Mutex<Option<String>>,
    live_session: Arc<Mutex<LiveSession>>,
    journal_tx: Mutex<Option<mpsc::UnboundedSender<ThreadJournalEventInput>>>,
    deferred_turn_completed: Mutex<Option<Value>>,
}

impl ServerHarnessEventSink {
    fn set_turn_context(
        &self,
        conn_id: &str,
        turn_id: &str,
        journal_tx: mpsc::UnboundedSender<ThreadJournalEventInput>,
    ) {
        *self.fallback_conn_id.lock() = Some(conn_id.to_owned());
        *self.turn_id.lock() = Some(turn_id.to_owned());
        *self.journal_tx.lock() = Some(journal_tx);
    }

    fn clear_turn_journal_tx(&self) {
        *self.journal_tx.lock() = None;
    }

    fn flush_deferred_turn_completed(&self) {
        if let Some(params) = self.deferred_turn_completed.lock().take() {
            let fallback = self.fallback_conn_id.lock().clone();
            let outbound = JsonRpcLiteOutbound::Notification(JsonRpcLiteNotification {
                method: "turn/completed".to_owned(),
                params: Some(params),
            });
            self.runtime
                .broadcast_to_thread(&self.thread_id, fallback.as_deref(), &outbound);
        }
    }

    fn enqueue_journal(&self, entry: ThreadJournalEventInput) {
        if let Some(tx) = self.journal_tx.lock().as_ref()
            && tx.send(entry.clone()).is_ok()
        {
            return;
        }
        let journal = Arc::clone(&self.runtime.journal);
        tokio::spawn(async move {
            let _ = journal.enqueue(entry).await;
        });
    }
}

impl HarnessEventSink for ServerHarnessEventSink {
    fn send_notification(&self, method: &str, params: Value) {
        if method == "serverRequest/resolved"
            && let Some(im) = self.runtime.interaction_managers.get(&self.thread_id)
        {
            let mut live = self.live_session.lock();
            live.has_pending_approval = im.has_pending_approval();
            live.has_pending_ask = im.has_pending_ask();
        }

        let ts = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let item_id = params
            .get("itemId")
            .and_then(Value::as_str)
            .or_else(|| {
                params
                    .get("item")
                    .and_then(|i| i.get("id"))
                    .and_then(Value::as_str)
            })
            .map(str::to_owned);
        let req_id = params
            .get("requestId")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let turn_id = params
            .get("turnId")
            .and_then(Value::as_str)
            .or_else(|| {
                params
                    .get("turn")
                    .and_then(|t| t.get("id"))
                    .and_then(Value::as_str)
            })
            .map(str::to_owned)
            .or_else(|| self.turn_id.lock().clone());

        self.enqueue_journal(ThreadJournalEventInput {
            thread_id: self.thread_id.clone(),
            ts,
            event_type: method.to_owned(),
            turn_id,
            item_id,
            request_id: req_id,
            payload: params.clone(),
        });

        if method == "turn/completed" {
            *self.deferred_turn_completed.lock() = Some(params);
            return;
        }

        let fallback = self.fallback_conn_id.lock().clone();
        let outbound = JsonRpcLiteOutbound::Notification(JsonRpcLiteNotification {
            method: method.to_owned(),
            params: Some(params),
        });
        self.runtime
            .broadcast_to_thread(&self.thread_id, fallback.as_deref(), &outbound);
    }

    fn send_server_request(&self, request_id: &str, method: &str, params: Value) {
        {
            let mut live = self.live_session.lock();
            if method == "item/tool/requestUserInput" {
                live.has_pending_ask = true;
            } else {
                live.has_pending_approval = true;
            }
        }

        let ts = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let turn_id = params
            .get("turnId")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| self.turn_id.lock().clone());

        self.enqueue_journal(ThreadJournalEventInput {
            thread_id: self.thread_id.clone(),
            ts,
            event_type: format!("request:{method}"),
            turn_id,
            item_id: params
                .get("itemId")
                .and_then(Value::as_str)
                .map(str::to_owned),
            request_id: Some(request_id.to_owned()),
            payload: params.clone(),
        });

        let fallback = self.fallback_conn_id.lock().clone();
        let outbound = JsonRpcLiteOutbound::ServerRequest(JsonRpcLiteRequest {
            id: JsonRpcLiteId::String(request_id.to_owned()),
            method: method.to_owned(),
            params: Some(params),
        });
        self.runtime
            .broadcast_to_thread(&self.thread_id, fallback.as_deref(), &outbound);
    }
}

pub(crate) fn new_canonical_message(
    role: MessageRole,
    content: Vec<ContentBlock>,
) -> CanonicalMessage {
    CanonicalMessage {
        id: Uuid::new_v4().to_string(),
        role,
        content,
        phase: None,
        provider: None,
        api: None,
        model: None,
        stop_reason: None,
        provider_meta: ProviderOpaqueMeta::default(),
        created_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    }
}

pub(crate) fn new_text_block(text: &str) -> ContentBlock {
    ContentBlock::Text {
        text: text.to_owned(),
        phase: None,
        citations: Vec::new(),
        provider_meta: ProviderOpaqueMeta::default(),
    }
}

pub(crate) fn parse_stored_canonical_messages(stored: &[Value]) -> Vec<CanonicalMessage> {
    let mut out = Vec::new();
    for val in stored {
        if let Ok(cm) = serde_json::from_value::<CanonicalMessage>(val.clone()) {
            out.push(cm);
            continue;
        }
        let role = match val.get("role").and_then(Value::as_str) {
            Some("assistant") => MessageRole::Assistant,
            Some("system") => MessageRole::System,
            Some("tool") => MessageRole::Tool,
            _ => MessageRole::User,
        };
        if let Some(txt) = val.get("content").and_then(Value::as_str) {
            out.push(new_canonical_message(role, vec![new_text_block(txt)]));
        }
    }
    out
}

pub(crate) type CodexBridgeContext<'a> = (
    &'a ToolExecutionContext,
    &'a Arc<InteractionManager>,
    &'a Arc<SteerCoordinator>,
    Option<usize>,
);

pub(crate) fn select_provider_transport(
    provider: ProviderName,
    bedrock_auth: Option<BedrockAuthConfig>,
    homedir: &Path,
    env: &HashMap<String, String>,
    codex_tool_ctx: Option<CodexBridgeContext<'_>>,
) -> Result<Arc<dyn ProviderTransport>, String> {
    match provider {
        ProviderName::Openai => Ok(Arc::new(OpenAiResponsesTransport::new())),
        ProviderName::Anthropic => Ok(Arc::new(AnthropicMessagesTransport::new())),
        ProviderName::Google => Ok(Arc::new(GoogleInteractionsTransport::new())),
        ProviderName::Bedrock => match bedrock_auth {
            Some(auth) => Ok(Arc::new(BedrockConverseTransport::with_auth(auth))),
            None => Ok(Arc::new(BedrockConverseTransport::with_isolated_env(
                homedir.to_path_buf(),
                env.clone(),
            ))),
        },
        ProviderName::CodexCli => {
            if let Some((tctx, im, steer, overflow)) = codex_tool_ctx {
                let tools_map = create_builtin_tools(tctx);
                let dyn_handler = TurnStepRunner::build_codex_dynamic_tool_handler(
                    tools_map,
                    tctx.clone(),
                    Arc::clone(im),
                    overflow,
                );
                let observer: Arc<dyn cowork_providers::codex_app_server::CodexTurnObserver> =
                    Arc::clone(steer) as _;
                Ok(Arc::new(CodexAppServerTransport::with_env_and_bridges(
                    env.clone(),
                    Some(dyn_handler),
                    Some(observer),
                )))
            } else {
                Ok(Arc::new(CodexAppServerTransport::with_env(env.clone())))
            }
        }
        other => ChatCompletionsTransport::new(other)
            .map(|t| Arc::new(t) as Arc<dyn ProviderTransport>)
            .ok_or_else(|| format!("Unsupported provider transport: {}", other.as_str())),
    }
}

pub(crate) fn build_memory_prompt_section(
    sqlite_store: &cowork_storage::MemoryStore,
    adv_store: &cowork_tools::AdvancedMemoryStore,
    advanced_enabled: bool,
) -> Option<String> {
    let mut parts = Vec::new();
    if advanced_enabled {
        for (scope, label) in [("workspace", "Workspace"), ("global", "Global")] {
            if let Ok(dir) = adv_store.resolve_scope_dir(scope, None) {
                let idx_path = dir.join("MEMORY.md");
                if let Ok(raw) = std::fs::read_to_string(&idx_path) {
                    let trimmed = raw.trim();
                    if !trimmed.is_empty() {
                        parts.push(format!("### {label} Memory Index\n{trimmed}"));
                    }
                }
            }
        }
    } else {
        for (scope, label) in [
            (MemoryScope::Workspace, "Workspace"),
            (MemoryScope::User, "User"),
        ] {
            if let Ok(entries) = sqlite_store.list(Some(scope))
                && !entries.is_empty()
            {
                let mut lines = Vec::new();
                for e in entries.into_iter().take(12) {
                    if e.id == HOT_MEMORY_ID {
                        lines.push(e.content);
                    } else {
                        lines.push(format!("- **{}**: {}", e.id, e.content));
                    }
                }
                parts.push(format!("### {label} Memory\n{}", lines.join("\n")));
            }
        }
    }
    (!parts.is_empty()).then(|| parts.join("\n\n"))
}

impl ServerRuntimeState {
    pub(crate) fn ensure_thread_idempotency_ledger(
        &self,
        thread_id: &str,
    ) -> Arc<TurnIdempotencyLedger> {
        if let Some(existing) = self.idempotency_ledgers.get(thread_id) {
            return Arc::clone(existing.value());
        }
        let ledger = Arc::new(TurnIdempotencyLedger::new());
        if let Ok(events) = self.journal.list(thread_id, 0, None) {
            for ev in events {
                if ev.event_type == "internal/userMessageAccepted" {
                    ledger.hydrate_from_journal_payload(&ev.payload);
                }
            }
        }
        self.idempotency_ledgers
            .insert(thread_id.to_owned(), Arc::clone(&ledger));
        ledger
    }

    pub(crate) fn resolve_client_interaction_response(
        &self,
        connection_id: &str,
        resp: &JsonRpcLiteClientResponse,
    ) -> Option<JsonRpcLiteResponse> {
        let req_id_str = match &resp.id {
            JsonRpcLiteId::String(s) => s.clone(),
            JsonRpcLiteId::Number(n) => n.to_string(),
        };

        let mut owner: Option<Arc<InteractionManager>> = None;
        for entry in self.interaction_managers.iter() {
            if entry.value().owns_request_id(&req_id_str) {
                owner = Some(Arc::clone(entry.value()));
                break;
            }
        }

        let Some(mgr) = owner else {
            return Some(JsonRpcLiteResponse::error(
                Some(resp.id.clone()),
                JsonRpcLiteError::with_data(
                    error_codes::INVALID_REQUEST,
                    format!("Unknown server request id: {req_id_str}"),
                    json!({
                        "category": "interaction_response_not_found",
                        "requestId": req_id_str,
                    }),
                ),
            ));
        };

        let thread_id = mgr.thread_id().to_owned();
        let result_val = resp.result.as_ref().unwrap_or(&Value::Null);
        match mgr.resolve_client_response(&req_id_str, result_val) {
            Ok(val) => {
                if let Some(live_arc) = self.get_live_thread(&thread_id) {
                    let mut live = live_arc.lock();
                    live.has_pending_approval = mgr.has_pending_approval();
                    live.has_pending_ask = mgr.has_pending_ask();
                }
                if val.get("status").and_then(Value::as_str) == Some("already_applied") {
                    self.send_to_connection(
                        connection_id,
                        &JsonRpcLiteOutbound::Notification(JsonRpcLiteNotification {
                            method: "serverRequest/resolved".to_owned(),
                            params: Some(json!({
                                "threadId": thread_id,
                                "requestId": req_id_str,
                            })),
                        }),
                    );
                }
                None
            }
            Err(err) => {
                let category = if err.code == error_codes::INVALID_PARAMS {
                    if err.message.contains("Conflicting") {
                        "interaction_response_conflict"
                    } else {
                        "interaction_response_invalid"
                    }
                } else {
                    "interaction_response_not_pending"
                };
                Some(JsonRpcLiteResponse::error(
                    Some(resp.id.clone()),
                    JsonRpcLiteError::with_data(
                        err.code,
                        err.message,
                        json!({
                            "category": category,
                            "requestId": req_id_str,
                            "threadId": thread_id,
                        }),
                    ),
                ))
            }
        }
    }

    pub async fn handle_turn_start(
        self: &Arc<Self>,
        connection_id: &str,
        tool_retry_lineage: bool,
        params: &TurnStartParams,
    ) -> Result<Value, JsonRpcLiteError> {
        self.handle_turn_start_with_display(connection_id, tool_retry_lineage, params, None)
            .await
    }

    pub(crate) async fn handle_turn_start_with_display(
        self: &Arc<Self>,
        connection_id: &str,
        tool_retry_lineage: bool,
        params: &TurnStartParams,
        display_text_override: Option<String>,
    ) -> Result<Value, JsonRpcLiteError> {
        let extracted = params
            .input
            .extract_payload()
            .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;

        if params.retry.is_some() && !tool_retry_lineage {
            return Err(JsonRpcLiteError::new(
                error_codes::INVALID_REQUEST,
                "turn/start retry requires the toolRetryLineage client capability.",
            ));
        }

        let live_arc = if connection_id == "internal" || connection_id.is_empty() {
            self.load_thread(&params.thread_id)
        } else {
            self.subscribe(connection_id, &params.thread_id)
        };
        let Some(live_arc) = live_arc else {
            return Err(JsonRpcLiteError::new(
                error_codes::INVALID_PARAMS,
                format!("Unknown thread: {}", params.thread_id),
            ));
        };

        if let Some(lock) = self.get_session_task_lock(&params.thread_id) {
            return Err(JsonRpcLiteError::with_data(
                error_codes::INVALID_REQUEST,
                lock.message,
                lock.data.to_json_value(),
            ));
        }

        let ledger = self.ensure_thread_idempotency_ledger(&params.thread_id);
        if let Some(cid) = params.client_message_id.as_deref()
            && let Some(dup) =
                ledger.lookup_existing(cid, &extracted.text, &extracted.attachments)?
        {
            return Ok(json!({
                "turn": {
                    "id": dup.turn_id,
                    "threadId": params.thread_id,
                    "status": "inProgress",
                    "items": [],
                },
                "replayed": true,
            }));
        }

        let (
            provider,
            model_id,
            cwd_path,
            session_provider_opts,
            session_kind,
            warn_at_usd,
            stop_at_usd,
            cost_snapshot_val,
            stored_provider_state,
            harness_context_val,
            title_source_initial,
            title_initial,
            requested_reasoning,
            session_enable_mcp,
        ) = {
            let live = live_arc.lock();
            if live.busy || self.active_turns.contains_key(&params.thread_id) {
                return Err(JsonRpcLiteError::new(
                    error_codes::INVALID_REQUEST,
                    "A turn is already in progress on this thread.",
                ));
            }
            (
                live.provider,
                live.model.clone(),
                PathBuf::from(&live.cwd),
                live.config_overrides
                    .get("providerOptions")
                    .and_then(Value::as_object)
                    .cloned(),
                live.session_kind,
                live.warn_at_usd,
                live.stop_at_usd,
                live.cost_tracker_snapshot.clone(),
                live.provider_state.clone(),
                live.harness_context.clone(),
                live.title_source,
                live.title.clone(),
                live.requested_reasoning_effort.clone(),
                live.enable_mcp,
            )
        };

        let workspace_cfg = self.load_workspace_config(&cwd_path).ok();
        let mut merged_provider_opts = workspace_cfg
            .as_ref()
            .and_then(|cfg| cfg.provider_options.clone())
            .unwrap_or_default();
        if let Some(over) = session_provider_opts {
            for (k, v) in over {
                match (merged_provider_opts.get_mut(&k), v) {
                    (Some(Value::Object(existing_sub)), Value::Object(over_sub)) => {
                        for (sk, sv) in over_sub {
                            existing_sub.insert(sk, sv);
                        }
                    }
                    (_, other) => {
                        merged_provider_opts.insert(k, other);
                    }
                }
            }
        }
        if let Some(effort) = &requested_reasoning {
            let sub = merged_provider_opts
                .entry(provider.as_str().to_owned())
                .or_insert_with(|| Value::Object(Map::new()));
            if let Some(sub_map) = sub.as_object_mut() {
                sub_map
                    .entry("reasoningEffort".to_owned())
                    .or_insert_with(|| Value::String(effort.clone()));
            }
        }

        // Pre-turn LM Studio reachability gate BEFORE idempotency commit (`routes/turn.ts` parity).
        let mut lmstudio_inference_url: Option<String> = None;
        if provider == ProviderName::Lmstudio {
            let svc = LmStudioLocalService::new();
            let status = svc
                .get_status(&self.homedir, &self.env, Some(&merged_provider_opts), None)
                .await;
            if !status.running {
                return Err(JsonRpcLiteError::with_data(
                    error_codes::INVALID_REQUEST,
                    format!(
                        "LM Studio isn't running at {}. Start LM Studio's local server and try again.",
                        status.base_url
                    ),
                    json!({
                        "reason": "lmstudio_unreachable",
                        "provider": "lmstudio",
                        "baseUrl": status.base_url,
                        "installed": status.installed,
                        "canAutoStart": status.can_auto_start,
                    }),
                ));
            }
            let lms_opts = resolve_lmstudio_options(&self.env, Some(&merged_provider_opts), None);
            lmstudio_inference_url = Some(lms_opts.inference_base_url);
            let lms_obj = merged_provider_opts
                .entry("lmstudio".to_owned())
                .or_insert_with(|| json!({}));
            if let Some(map) = lms_obj.as_object_mut() {
                map.entry("autoLoad".to_owned())
                    .or_insert(Value::Bool(false));
            }
        }

        // Re-check task locks after async preflight before committing idempotency (`routes/turn.ts` parity).
        if let Some(lock) = self.get_session_task_lock(&params.thread_id) {
            return Err(JsonRpcLiteError::with_data(
                error_codes::INVALID_REQUEST,
                lock.message,
                lock.data.to_json_value(),
            ));
        }

        // Materialize attachments before committing idempotency so invalid base64 / missing files roll back cleanly!
        let canonical_cwd = canonicalize_sync(&cwd_path);
        let uploads_dir = canonical_cwd.join("uploads");
        let materialized = materialize_turn_attachments(&extracted, &uploads_dir, &canonical_cwd)
            .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;

        let proposed_turn_id = Uuid::new_v4().to_string();
        let idem_outcome = match ledger.check_or_record(
            params.client_message_id.as_deref().unwrap_or(""),
            &proposed_turn_id,
            &extracted.text,
            &extracted.attachments,
        ) {
            Ok(o) => o,
            Err(err) => {
                materialized.rollback();
                return Err(err);
            }
        };
        if idem_outcome.was_duplicate {
            materialized.rollback();
            return Ok(json!({
                "turn": {
                    "id": idem_outcome.turn_id,
                    "threadId": params.thread_id,
                    "status": "inProgress",
                    "items": [],
                },
                "replayed": true,
            }));
        }
        let turn_id = idem_outcome.turn_id;

        if let Some(cid) = params
            .client_message_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            let accepted_payload = TurnIdempotencyLedger::build_journal_payload(
                cid,
                &turn_id,
                &idem_outcome.payload_fingerprint,
            );
            let _ = self
                .journal
                .enqueue(ThreadJournalEventInput {
                    thread_id: params.thread_id.clone(),
                    ts: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                    event_type: "internal/userMessageAccepted".to_owned(),
                    turn_id: Some(turn_id.clone()),
                    item_id: None,
                    request_id: None,
                    payload: accepted_payload,
                })
                .await;
        }

        let paths = get_ai_coworker_paths(Some(&self.homedir), &self.env);
        let conn_store = read_connection_store(&paths).await.ok();
        let api_key = resolve_provider_api_key(provider, conn_store.as_ref(), &self.env);
        let bedrock_auth = if provider == ProviderName::Bedrock {
            let mut auth =
                resolve_bedrock_auth_config(&self.homedir, &self.env, conn_store.as_ref());
            if let (Some(reg), Some(cfg)) = (
                extract_bedrock_region_override(&merged_provider_opts),
                auth.as_mut(),
            ) {
                cfg.region = reg;
                cfg.has_configured_region = true;
            }
            auth
        } else {
            None
        };

        let base_url = match provider {
            ProviderName::Lmstudio => lmstudio_inference_url,
            _ => {
                let env_key = match provider {
                    ProviderName::Google => "GEMINI_BASE_URL".to_owned(),
                    ProviderName::Bedrock => "AWS_BEDROCK_ENDPOINT_URL".to_owned(),
                    other => format!(
                        "{}_BASE_URL",
                        other.as_str().to_ascii_uppercase().replace('-', "_")
                    ),
                };
                merged_provider_opts
                    .get(provider.as_str())
                    .and_then(Value::as_object)
                    .and_then(|o| o.get("baseUrl").or_else(|| o.get("base_url")))
                    .or_else(|| {
                        merged_provider_opts
                            .get("baseUrl")
                            .or_else(|| merged_provider_opts.get("base_url"))
                    })
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .or_else(|| {
                        self.env
                            .get(&env_key)
                            .map(String::as_str)
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .map(str::to_owned)
                    })
            }
        };

        merged_provider_opts.insert(
            "coworkHome".to_owned(),
            Value::String(paths.root_dir.to_string_lossy().into_owned()),
        );
        merged_provider_opts.insert(
            "cwd".to_owned(),
            Value::String(canonical_cwd.to_string_lossy().into_owned()),
        );

        let deferred_tool_search = merged_provider_opts
            .get("deferredToolSearch")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let overflow_threshold = workspace_cfg
            .as_ref()
            .and_then(|c| c.tool_output_overflow_chars)
            .map(|n| n as usize);
        let enable_memory = workspace_cfg.as_ref().is_none_or(|c| c.enable_memory);
        let advanced_memory = workspace_cfg.as_ref().is_some_and(|c| c.advanced_memory);
        let require_file_approval = merged_provider_opts
            .get("requireFileChangeApproval")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            && !self.yolo;

        let sink_impl = Arc::new(ServerHarnessEventSink {
            runtime: Arc::clone(self),
            thread_id: params.thread_id.clone(),
            fallback_conn_id: Mutex::new(Some(connection_id.to_owned())),
            turn_id: Mutex::new(Some(turn_id.clone())),
            live_session: Arc::clone(&live_arc),
            journal_tx: Mutex::new(None),
            deferred_turn_completed: Mutex::new(None),
        });
        let sink: Arc<dyn HarnessEventSink> = sink_impl.clone();

        let interactions = Arc::new(
            InteractionManager::new(&params.thread_id, Arc::clone(&sink))
                .with_turn_id(&turn_id)
                .with_yolo(self.yolo)
                .with_file_change_approval(require_file_approval),
        );
        self.interaction_managers
            .insert(params.thread_id.clone(), Arc::clone(&interactions));

        let steer = Arc::new(SteerCoordinator::new(
            &params.thread_id,
            &turn_id,
            Arc::clone(&sink),
            None,
        ));

        self.subscribe_workspace_control_bg(connection_id, &canonical_cwd);

        let mut effective_agent_cfg = workspace_cfg.clone();
        if let Some(ref mut cfg) = effective_agent_cfg {
            cfg.provider = provider;
            cfg.model = model_id.clone();
            cfg.enable_mcp = session_enable_mcp;
            cfg.provider_options = Some(merged_provider_opts.clone());
        }

        let bundled_skills_dir = self.built_in_dir.join("skills");
        let available_skills = if let Some(ref cfg) = effective_agent_cfg {
            discover_skills_for_config(cfg)
        } else {
            discover_skills(
                bundled_skills_dir
                    .is_dir()
                    .then_some(bundled_skills_dir.as_path()),
                &paths.root_dir,
                &canonical_cwd,
            )
        };
        let mentions = resolve_turn_mentions(
            &extracted.text,
            &available_skills,
            &paths.root_dir,
            &canonical_cwd,
        );

        let sqlite_mem = self.memory_store_for_workspace(&canonical_cwd);
        let adv_mem = self.advanced_memory_store_for_workspace(&canonical_cwd);
        let memory_section = enable_memory
            .then(|| build_memory_prompt_section(&sqlite_mem, &adv_mem, advanced_memory))
            .flatten();

        let output_dir = canonical_cwd.join("output");
        let sandbox_cfg = workspace_cfg
            .as_ref()
            .map(|c| c.sandbox.clone())
            .unwrap_or_default();
        let sandbox_policy = resolve_sandbox_policy(&ResolveSandboxPolicyInput {
            config: Some(sandbox_cfg.clone()),
            working_directory: canonical_cwd.clone(),
            project_root: Some(canonical_cwd.clone()),
            output_directory: Some(output_dir.clone()),
            uploads_directory: Some(uploads_dir.clone()),
            tool_runtime_writable_roots: scratch_roots(None),
            target_paths: None,
            read_only_role: false,
            yolo: self.yolo,
            platform: None,
        });
        let (sandbox_mode_label, network_enabled) = match &sandbox_policy {
            SandboxPolicy::DangerFullAccess { network } => {
                ("danger-full-access".to_owned(), network.unwrap_or(true))
            }
            SandboxPolicy::ReadOnly { network } => ("read-only".to_owned(), *network),
            SandboxPolicy::NoProjectWrite { network, .. } => {
                ("no-project-write".to_owned(), *network)
            }
            SandboxPolicy::WorkspaceWrite { network, .. } => {
                ("workspace-write".to_owned(), *network)
            }
        };

        let prompts_dir = self.built_in_dir.join("prompts");
        let task_ctx = self
            .task_coordinator
            .get_context_for_thread(&params.thread_id);
        let in_task_context = task_ctx.is_some();
        let tasks_enabled = effective_agent_cfg
            .as_ref()
            .map(|c| c.tasks_enabled)
            .unwrap_or_else(|| self.is_tasks_enabled(Some(&canonical_cwd)));
        let task_context_section = task_ctx
            .as_ref()
            .map(|ctx| cowork_harness::tasks::render_task_context_section(Some(ctx)))
            .filter(|s| !s.is_empty());

        let system_prompt = build_layered_system_prompt(&SystemPromptBuildOptions {
            prompts_dir: prompts_dir.is_dir().then_some(prompts_dir),
            prompt_template: None,
            working_directory: canonical_cwd.clone(),
            output_directory: output_dir.clone(),
            uploads_directory: uploads_dir.clone(),
            cowork_home: paths.root_dir.clone(),
            provider,
            model: model_id.clone(),
            sandbox_mode_label,
            network_enabled,
            available_skills,
            memory_section,
            workspace_context: None,
            harness_context: harness_context_val,
            task_context_section,
            referenced_plugins: mentions.referenced_plugins,
            deferred_tool_search_enabled: deferred_tool_search,
        });

        let effective_display_text = display_text_override
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| materialized.display_text.clone());

        let runner = TurnStepRunner::new(TurnRunConfig {
            thread_id: params.thread_id.clone(),
            turn_id: turn_id.clone(),
            provider,
            model_id: model_id.clone(),
            base_url: base_url.clone(),
            api_key: api_key.clone(),
            extra_headers: HashMap::new(),
            system_prompt,
            provider_options: merged_provider_opts.clone(),
            deferred_tool_search,
            max_steps: DEFAULT_MAX_TURN_STEPS,
            step_timeout_ms: STEP_TIMEOUT_MS,
            overflow_threshold_chars: overflow_threshold,
            tool_retry_lineage,
            initial_user_message: Some((
                effective_display_text.clone(),
                params.client_message_id.clone(),
            )),
        });
        let cancel_handle = runner.cancellation_handle();

        {
            let mut live = live_arc.lock();
            live.busy = true;
            live.idle_since = None;
        }
        self.active_turns.insert(
            params.thread_id.clone(),
            ActiveTurnControl {
                turn_id: turn_id.clone(),
                cancel: cancel_handle,
                steer: Arc::clone(&steer),
                interactions: Arc::clone(&interactions),
            },
        );

        // Phase 1 session title generation: synchronous heuristic title when still at default!
        if title_source_initial == SessionTitleSource::Default && !extracted.text.trim().is_empty()
        {
            let heuristic = generate_heuristic_session_title(&extracted.text);
            if !heuristic.is_empty() && heuristic != title_initial {
                let now_ts =
                    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                let info_evt = {
                    let mut live = live_arc.lock();
                    if live.title_source == SessionTitleSource::Default {
                        live.title = heuristic;
                        live.title_source = SessionTitleSource::Heuristic;
                        live.updated_at = now_ts;
                    }
                    json!({
                        "type": "session_info",
                        "sessionId": live.id,
                        "title": live.title,
                        "titleSource": live.title_source,
                        "titleModel": live.title_model,
                        "createdAt": live.created_at,
                        "updatedAt": live.updated_at,
                        "provider": live.provider,
                        "model": live.model,
                    })
                };
                self.broadcast_to_thread(
                    &params.thread_id,
                    Some(connection_id),
                    &JsonRpcLiteOutbound::Notification(JsonRpcLiteNotification {
                        method: "cowork/session/info".to_owned(),
                        params: Some(info_evt),
                    }),
                );
            }
        }

        let runtime = Arc::clone(self);
        let thread_id = params.thread_id.clone();
        let conn_id = connection_id.to_owned();
        let live_for_task = Arc::clone(&live_arc);
        let return_turn_id = turn_id.clone();
        let user_query_for_title = extracted.text.clone();

        tokio::spawn(async move {
            let (journal_tx, mut journal_rx) = mpsc::unbounded_channel::<ThreadJournalEventInput>();
            let journal_for_writer = Arc::clone(&runtime.journal);
            let journal_writer = tokio::spawn(async move {
                while let Some(entry) = journal_rx.recv().await {
                    let _ = journal_for_writer.enqueue(entry).await;
                }
            });
            sink_impl.set_turn_context(&conn_id, &turn_id, journal_tx);

            let mut history = {
                let live = live_for_task.lock();
                parse_stored_canonical_messages(&live.messages)
            };

            let mut user_blocks = materialized.content_blocks;
            for skill_block in mentions.injected_skill_blocks {
                user_blocks.push(new_text_block(&skill_block));
            }
            if user_blocks.is_empty() {
                user_blocks.push(new_text_block(&materialized.display_text));
            }
            history.push(new_canonical_message(MessageRole::User, user_blocks));

            let live_for_todos = Arc::clone(&live_for_task);
            let runtime_for_todos = Arc::clone(&runtime);
            let tid_for_todos = thread_id.clone();
            let cid_for_todos = conn_id.clone();
            let on_todos: cowork_tools::TodosUpdatedCallback = Arc::new(move |todos| {
                {
                    let mut live = live_for_todos.lock();
                    live.todos = todos.clone();
                }
                runtime_for_todos.broadcast_to_thread(
                    &tid_for_todos,
                    Some(&cid_for_todos),
                    &JsonRpcLiteOutbound::Notification(JsonRpcLiteNotification {
                        method: "cowork/todos".to_owned(),
                        params: Some(json!({
                            "type": "todos",
                            "sessionId": tid_for_todos,
                            "todos": todos,
                        })),
                    }),
                );
            });

            let mut tool_env = runtime.effective_tool_env();
            tool_env.insert(
                "HOME".to_owned(),
                runtime.homedir.to_string_lossy().into_owned(),
            );
            tool_env.insert(
                "COWORK_HOME_OVERRIDE".to_owned(),
                paths.root_dir.to_string_lossy().into_owned(),
            );

            let approval_bridge: Option<Arc<dyn ApprovalHandler>> =
                Some(Arc::clone(&interactions) as Arc<dyn ApprovalHandler>);
            let thread_bridge: Option<Arc<dyn cowork_tools::ThreadControlBridge>> = (session_kind
                == cowork_storage::SessionKind::Root
                && !in_task_context)
                .then(|| {
                    Arc::new(ServerThreadControlBridge {
                        runtime: Arc::clone(&runtime),
                        connection_id: conn_id.clone(),
                    }) as Arc<dyn cowork_tools::ThreadControlBridge>
                });

            let agent_bridge: Option<Arc<dyn cowork_tools::AgentControlBridge>> =
                if session_kind == cowork_storage::SessionKind::Root {
                    runtime
                        .get_or_create_agent_control(
                            &thread_id,
                            &canonical_cwd,
                            Some(&live_for_task),
                            Some(&conn_id),
                        )
                        .await
                        .ok()
                        .map(|ctrl| ctrl as Arc<dyn cowork_tools::AgentControlBridge>)
                } else {
                    None
                };

            let task_bridge: Option<Arc<dyn cowork_tools::TaskToolBridge>> =
                (session_kind == cowork_storage::SessionKind::Root && tasks_enabled).then(|| {
                    Arc::new(crate::task_routes::ServerTaskToolBridge {
                        runtime: Arc::clone(&runtime),
                        connection_id: conn_id.clone(),
                    }) as Arc<dyn cowork_tools::TaskToolBridge>
                });

            let rt_for_lock_hook = Arc::clone(&runtime);
            let tid_for_lock_hook = thread_id.clone();
            let before_tool_hook: cowork_tools::BeforeToolInvocationHook =
                Arc::new(move |tool_name: &str| {
                    if let Some(lock) = rt_for_lock_hook.get_session_task_lock(&tid_for_lock_hook) {
                        return Err(crate::task_routes::format_tool_task_lock_error(
                            tool_name, &lock,
                        ));
                    }
                    Ok(())
                });

            let mut tool_ctx = ToolExecutionContext {
                session_id: thread_id.clone(),
                session_kind,
                homedir: runtime.homedir.clone(),
                cowork_home: paths.root_dir.clone(),
                working_directory: canonical_cwd.clone(),
                output_directory: output_dir,
                uploads_directory: uploads_dir,
                lock_root: paths.root_dir.join("locks").join("files"),
                env: tool_env,
                provider,
                model: model_id.clone(),
                provider_options: merged_provider_opts.clone(),
                sandbox_config: sandbox_cfg,
                sandbox_policy,
                read_roots: vec![runtime.built_in_dir.clone(), paths.root_dir.clone()],
                yolo: runtime.yolo,
                read_only_role: false,
                target_paths: None,
                advanced_memory,
                bundled_skills_dir: bundled_skills_dir.is_dir().then_some(bundled_skills_dir),
                approval_handler: approval_bridge,
                thread_control: thread_bridge,
                agent_control: agent_bridge,
                task_bridge,
                in_task_context,
                stop_after_step: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                before_tool_invocation: Some(before_tool_hook),
                agent_config: effective_agent_cfg.map(Arc::new),
                mcp_tool_cache: Some(Arc::clone(&runtime.mcp_tool_cache)),
                can_ask_user: !in_task_context,
                allowed_builtin_tools: None,
                allowed_mcp_servers: None,
                allowed_skill_names: None,
                session_db: Some(Arc::clone(&runtime.session_db)),
                memory_store: Some(Arc::new(sqlite_mem.clone())),
                advanced_memory_store: Some(Arc::new(adv_mem.clone())),
                on_todos_updated: Some(on_todos),
                cancel_rx: None,
                dns_override_for_tests: None,
            };

            let mut cost_tracker = cost_snapshot_val
                .and_then(|v| serde_json::from_value::<SessionUsageSnapshot>(v).ok())
                .map(SessionCostTracker::from_snapshot)
                .unwrap_or_else(|| {
                    SessionCostTracker::new(
                        &thread_id,
                        Some(BudgetThresholds {
                            warn_at_usd,
                            stop_at_usd,
                        }),
                    )
                });
            let _ = cost_tracker.set_budget(BudgetThresholds {
                warn_at_usd,
                stop_at_usd,
            });

            let initial_continuation = stored_provider_state
                .and_then(|v| serde_json::from_value::<ProviderContinuationState>(v).ok());

            let transport_res = select_provider_transport(
                provider,
                bedrock_auth,
                &runtime.homedir,
                &runtime.env,
                Some((&tool_ctx, &interactions, &steer, overflow_threshold)),
            );

            match transport_res {
                Ok(transport) => {
                    let outcome = runner
                        .run_turn(
                            Arc::clone(&transport),
                            history,
                            &mut tool_ctx,
                            &interactions,
                            &steer,
                            &mut cost_tracker,
                            initial_continuation,
                            Arc::clone(&sink),
                        )
                        .await;

                    let now =
                        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                    let preview = outcome
                        .last_assistant_text
                        .as_deref()
                        .unwrap_or(&effective_display_text)
                        .chars()
                        .take(180)
                        .collect::<String>();
                    let serialized_msgs: Vec<Value> = outcome
                        .messages
                        .iter()
                        .filter_map(|m| serde_json::to_value(m).ok())
                        .collect();
                    let next_provider_state = if outcome.status == "interrupted" {
                        None
                    } else {
                        outcome
                            .updated_continuation
                            .and_then(|c| serde_json::to_value(c).ok())
                    };
                    let cost_snap = serde_json::to_value(cost_tracker.get_snapshot()).ok();

                    let mem_cursor = {
                        let mut live = live_for_task.lock();
                        live.busy = false;
                        live.has_pending_approval = false;
                        live.has_pending_ask = false;
                        live.updated_at = now;
                        live.messages = serialized_msgs.clone();
                        live.message_count = live.messages.len();
                        live.last_message_preview = Some(preview);
                        live.provider_state = next_provider_state;
                        live.cost_tracker_snapshot = cost_snap;
                        live.last_memory_generated_index.unwrap_or(0)
                    };
                    runtime.active_turns.remove(&thread_id);
                    runtime.turn_settled_notify.notify_waiters();
                    let _ = runtime
                        .persist_live_session(&live_for_task, "turn/completed")
                        .await;

                    sink_impl.clear_turn_journal_tx();
                    let _ = journal_writer.await;
                    sink_impl.flush_deferred_turn_completed();

                    let task_outcome_kind = match outcome.status.as_str() {
                        "completed" => "completed",
                        "interrupted" => "cancelled",
                        _ => "error",
                    };
                    let _ = runtime
                        .task_coordinator
                        .handle_thread_outcome(&thread_id, task_outcome_kind, None)
                        .await;
                    let _ = runtime
                        .task_coordinator
                        .checkpoint_thread(
                            &thread_id,
                            &format!("turn {}", outcome.status),
                            outcome.last_assistant_text.as_deref().unwrap_or(""),
                            false,
                        )
                        .await;

                    // Background MemoryGenerator (offline directive extraction + optional remote model).
                    if enable_memory && outcome.status == "completed" {
                        let live_mem = Arc::clone(&live_for_task);
                        let rt_mem = Arc::clone(&runtime);
                        let remote_mem_model = workspace_cfg
                            .as_ref()
                            .and_then(|c| c.memory_generation_model.clone())
                            .map(|mid| RemoteMemoryModel {
                                transport: Arc::clone(&transport),
                                model_id: mid,
                                base_url: base_url.clone(),
                                api_key: api_key.clone(),
                            });
                        tokio::spawn(async move {
                            let mem_gen = MemoryGenerator::new();
                            if let Ok(next_idx) = mem_gen
                                .maybe_generate_from_transcript(
                                    &serialized_msgs,
                                    mem_cursor,
                                    Some(&sqlite_mem),
                                    Some(&adv_mem),
                                    remote_mem_model,
                                )
                                .await
                                && next_idx > mem_cursor
                            {
                                {
                                    let mut live = live_mem.lock();
                                    live.last_memory_generated_index = Some(next_idx);
                                }
                                let _ = rt_mem
                                    .persist_live_session(&live_mem, "memory_generated")
                                    .await;
                            }
                        });
                    }

                    // Phase 2 session title generation: remote fast model upgrade when available!
                    if outcome.status == "completed"
                        && title_source_initial == SessionTitleSource::Default
                        && !user_query_for_title.trim().is_empty()
                        && let Some(title_model) = preferred_title_model_for_provider(provider)
                    {
                        let live_title = Arc::clone(&live_for_task);
                        let rt_title = Arc::clone(&runtime);
                        let tid_title = thread_id.clone();
                        let cid_title = conn_id.clone();
                        let t_model = title_model.to_owned();
                        tokio::spawn(async move {
                            let (cur_src, cur_title) = {
                                let l = live_title.lock();
                                (l.title_source, l.title.clone())
                            };
                            if cur_src == SessionTitleSource::Manual {
                                return;
                            }
                            let (new_title, new_src) = generate_remote_session_title(
                                cur_src,
                                &cur_title,
                                &user_query_for_title,
                                Some(RemoteTitleOptions {
                                    transport,
                                    model_id: t_model.clone(),
                                    base_url,
                                    api_key,
                                }),
                            )
                            .await;
                            if new_src == SessionTitleSource::Model {
                                let evt = {
                                    let mut l = live_title.lock();
                                    if l.title_source == SessionTitleSource::Manual {
                                        return;
                                    }
                                    l.title = new_title;
                                    l.title_source = SessionTitleSource::Model;
                                    l.title_model = Some(t_model);
                                    l.updated_at = chrono::Utc::now()
                                        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                                    json!({
                                        "type": "session_info",
                                        "sessionId": l.id,
                                        "title": l.title,
                                        "titleSource": l.title_source,
                                        "titleModel": l.title_model,
                                        "createdAt": l.created_at,
                                        "updatedAt": l.updated_at,
                                        "provider": l.provider,
                                        "model": l.model,
                                    })
                                };
                                let _ = rt_title
                                    .persist_live_session(&live_title, "session_info")
                                    .await;
                                rt_title.broadcast_to_thread(
                                    &tid_title,
                                    Some(&cid_title),
                                    &JsonRpcLiteOutbound::Notification(JsonRpcLiteNotification {
                                        method: "cowork/session/info".to_owned(),
                                        params: Some(evt),
                                    }),
                                );
                            }
                        });
                    }
                }
                Err(msg) => {
                    sink.send_notification(
                        "error",
                        json!({
                            "type": "error",
                            "sessionId": thread_id,
                            "message": msg,
                            "code": "provider_error",
                            "source": "provider",
                        }),
                    );
                    sink.send_notification(
                        "turn/completed",
                        json!({
                            "threadId": thread_id,
                            "turn": {
                                "id": turn_id,
                                "status": "failed",
                            }
                        }),
                    );
                    {
                        let mut live = live_for_task.lock();
                        live.busy = false;
                        live.updated_at =
                            chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                    }
                    runtime.active_turns.remove(&thread_id);
                    runtime.turn_settled_notify.notify_waiters();
                    let _ = runtime
                        .persist_live_session(&live_for_task, "turn/completed")
                        .await;
                    sink_impl.clear_turn_journal_tx();
                    let _ = journal_writer.await;
                    sink_impl.flush_deferred_turn_completed();
                    let _ = runtime
                        .task_coordinator
                        .handle_thread_outcome(&thread_id, "error", Some(&msg))
                        .await;
                }
            }
        });

        Ok(json!({
            "turn": {
                "id": return_turn_id,
                "threadId": params.thread_id,
                "status": "inProgress",
                "items": [],
            }
        }))
    }

    pub fn handle_turn_steer(&self, params: &TurnSteerParams) -> Result<Value, JsonRpcLiteError> {
        let steer_text = params
            .input
            .extract_text()
            .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;

        if let Some(lock) = self.get_session_task_lock(&params.thread_id) {
            return Err(JsonRpcLiteError::with_data(
                error_codes::INVALID_REQUEST,
                lock.message,
                lock.data.to_json_value(),
            ));
        }

        let Some(ctrl) = self.active_turns.get(&params.thread_id) else {
            return Err(JsonRpcLiteError::new(
                error_codes::INVALID_REQUEST,
                format!("No active turn to steer on thread {}", params.thread_id),
            ));
        };
        if let Some(expected_turn) = params.turn_id.as_deref().filter(|s| !s.trim().is_empty())
            && ctrl.turn_id != expected_turn
        {
            return Err(JsonRpcLiteError::new(
                error_codes::INVALID_REQUEST,
                format!(
                    "Active turn {} does not match requested turnId {}",
                    ctrl.turn_id, expected_turn
                ),
            ));
        }

        ctrl.steer
            .enqueue_steer(steer_text, params.client_message_id.clone())
    }

    pub fn handle_turn_interrupt(
        &self,
        params: &TurnInterruptParams,
    ) -> Result<Value, JsonRpcLiteError> {
        let mut interrupted_children = 0usize;
        if params.include_subagents.unwrap_or(true)
            && let Some(agent_ctrl) = self.agent_controls.get(&params.thread_id)
        {
            interrupted_children = agent_ctrl.interrupt_running_children();
        }
        if let Some(ctrl) = self.active_turns.get(&params.thread_id) {
            ctrl.cancel.interrupt("Turn interrupted by user");
            ctrl.steer.interrupt_codex_if_bound();
            ctrl.interactions
                .cancel_all_pending("Turn interrupted by user");
            drop(ctrl);
            if let Some(live_arc) = self.get_live_thread(&params.thread_id) {
                let mut live = live_arc.lock();
                live.provider_state = None;
                live.has_pending_approval = false;
                live.has_pending_ask = false;
            }
            return Ok(json!({
                "interrupted": true,
            }));
        }
        Ok(json!({ "interrupted": interrupted_children > 0 }))
    }
}
