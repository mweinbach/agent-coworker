use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use cowork_config::{
    AgentConfig, ProviderName, SandboxMode as ConfigSandboxMode, ToolCallingConfig,
    ToolCallingStrategy, canonicalize_sync, get_ai_coworker_paths, read_connection_store,
    reconcile_reasoning_provider_options,
};
use cowork_harness::attachments::{
    AttachmentModelCapabilities, materialize_turn_attachments_for_model,
};
use cowork_harness::{
    CodexBridgeCatalog, HarnessEventSink, InteractionManager, MAX_TOOL_RETRY_TARGETS,
    MemoryGenerator, ModelCallRecord, PromptTemplateContext, RemoteMemoryModel, RemoteTitleOptions,
    SharedTurnCostTracker, SteerCoordinator, SystemPromptBuildOptions, ToolRetryTarget,
    TurnCancellationHandle, TurnIdempotencyLedger, TurnReference, TurnRunConfig, TurnStepRunner,
    build_layered_system_prompt, generate_heuristic_session_title, generate_remote_session_title,
    is_failed_tool_outcome, parse_turn_references, preferred_title_model_for_provider,
    resolve_turn_references,
};
use cowork_inference::{
    BudgetThresholds, CanonicalMessage, ContentBlock, MessageRole, ProviderContinuationState,
    ProviderOpaqueMeta, SessionCostTracker, SessionUsageSnapshot, migrate_stored_message,
};
use cowork_protocol::{
    JsonRpcLiteClientResponse, JsonRpcLiteError, JsonRpcLiteId, JsonRpcLiteNotification,
    JsonRpcLiteOutbound, JsonRpcLiteRequest, JsonRpcLiteResponse, PersistedJournalEventView,
    ThreadTurnProjector, TurnInterruptParams, TurnRetrySpec, TurnStartParams, TurnSteerParams,
    TurnToolsMode, error_codes,
};
use cowork_providers::bedrock::{
    BedrockAuthConfig, extract_bedrock_region_override, resolve_bedrock_auth_config,
};
use cowork_providers::chat_completions::lmstudio::{
    LmStudioLocalService, resolve_lmstudio_options,
};
use cowork_providers::codex_app_server::CodexSandboxRestrictions;
use cowork_providers::{
    AnthropicMessagesTransport, BedrockConverseTransport, ChatCompletionsTransport,
    CodexAppServerTransport, GoogleInteractionsTransport, OpenAiResponsesTransport,
    ProviderTransport, resolve_provider_api_key,
};
use cowork_sandbox::{
    ResolveSandboxPolicyInput, SandboxPolicy, policy_allows_network, resolve_sandbox_policy,
    scratch_roots,
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

use crate::memory_and_fork_routes::{
    ServerThreadControlBridge, advance_memory_cursor, memory_generation_model_ref,
};
use crate::registry::{LiveSession, ServerRuntimeState, ThreadEmitGate};

const DEFAULT_MAX_TURN_STEPS: usize = 100;
const USER_MESSAGE_ACCEPTED_EVENT: &str = "internal/userMessageAccepted";
const STEP_TIMEOUT_MS: u64 = 300_000;

pub(crate) struct ActiveTurnControl {
    pub turn_id: String,
    pub cancel: TurnCancellationHandle,
    pub steer: Arc<SteerCoordinator>,
    pub interactions: Arc<InteractionManager>,
    /// Skills/plugin roots the turn was started with, so `turn/steer` resolves references
    /// against the same catalog.
    pub mention_context: Arc<TurnMentionContext>,
}

pub(crate) struct TurnMentionContext {
    pub skills: std::collections::BTreeMap<String, cowork_tools::DiscoveredSkill>,
    pub cowork_home: PathBuf,
    pub working_directory: PathBuf,
}

impl TurnMentionContext {
    fn resolve(
        &self,
        text: &str,
        references: &[TurnReference],
    ) -> cowork_harness::ResolvedTurnMentions {
        resolve_turn_references(
            text,
            references,
            &self.skills,
            &self.cowork_home,
            &self.working_directory,
        )
    }
}

fn parse_references_param(raw: Option<&[Value]>) -> Result<Vec<TurnReference>, JsonRpcLiteError> {
    parse_turn_references(raw).map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))
}

struct ServerHarnessEventSink {
    runtime: Arc<ServerRuntimeState>,
    thread_id: String,
    fallback_conn_id: Mutex<Option<String>>,
    turn_id: Mutex<Option<String>>,
    live_session: Arc<Mutex<LiveSession>>,
    journal_tx: Mutex<Option<mpsc::UnboundedSender<ThreadJournalEventInput>>>,
    deferred_turn_completed: Mutex<Option<Value>>,
    /// Orders this thread's journaled broadcasts against the `thread/resume` replay cut.
    emit_gate: Arc<ThreadEmitGate>,
    /// OTLP trace of this turn: the `cowork.turn` span and one `cowork.model_call` child span
    /// per model call share it.
    span_trace_id: String,
    turn_span_id: String,
    /// Workspace whose current config decides Langfuse consent for each span of this turn.
    config_cwd: PathBuf,
}

/// Pending server requests collected by [`capture_pending_server_requests`] on this thread.
type CapturedServerRequests = Vec<(String, String, Value)>;

thread_local! {
    /// Set only while [`capture_pending_server_requests`] runs
    /// `InteractionManager::replay_pending_requests` on this OS thread: the sink's
    /// `send_server_request` then records the prompt here instead of journaling and
    /// broadcasting it again.
    static PENDING_REQUEST_CAPTURE: std::cell::RefCell<Option<CapturedServerRequests>> =
        const { std::cell::RefCell::new(None) };
}

/// Snapshots `im`'s unanswered prompts as `(request_id, method, params)` without re-emitting
/// them, so `thread/resume` can deliver them to the resuming connection alone.
pub(crate) fn capture_pending_server_requests(im: &InteractionManager) -> CapturedServerRequests {
    PENDING_REQUEST_CAPTURE.with(|slot| *slot.borrow_mut() = Some(Vec::new()));
    // `replay_pending_requests` calls the sink synchronously on this thread.
    im.replay_pending_requests();
    PENDING_REQUEST_CAPTURE
        .with(|slot| slot.borrow_mut().take())
        .unwrap_or_default()
}

/// Records a replayed prompt while a capture is active; returns whether it was captured.
fn capture_replayed_request(request_id: &str, method: &str, params: &Value) -> bool {
    PENDING_REQUEST_CAPTURE.with(|slot| match slot.borrow_mut().as_mut() {
        Some(captured) => {
            captured.push((request_id.to_owned(), method.to_owned(), params.clone()));
            true
        }
        None => false,
    })
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

    /// The Langfuse exporter the current on-disk config consents to. Re-resolved for every span
    /// so a consent change (e.g. `observabilityEnabled` turned off through
    /// `cowork/session/defaults/apply`) applies to the next span without a restart.
    fn current_langfuse(&self) -> Option<crate::observability::LangfuseExporterConfig> {
        let telemetry = self.runtime.observability.telemetry();
        if telemetry.langfuse_disabled_for_process() {
            return None;
        }
        let cfg = self.runtime.load_workspace_config(&self.config_cwd).ok();
        telemetry.resolve_langfuse(cfg.as_ref())
    }

    /// Exports the turn's own `cowork.turn` span when the current config consents.
    fn emit_turn_span(
        &self,
        status_error: bool,
        duration_ms: u64,
        attributes: std::collections::BTreeMap<String, Value>,
    ) {
        let Some(langfuse) = self.current_langfuse() else {
            return;
        };
        self.runtime.observability.emit_span(
            &langfuse,
            &crate::observability::ObservabilitySpanInput {
                name: "cowork.turn".to_owned(),
                status_error,
                duration_ms,
                attributes,
                trace: Some(self.turn_span_trace()),
            },
        );
    }

    /// Trace ids for the turn's own `cowork.turn` span.
    fn turn_span_trace(&self) -> crate::observability::ObservabilitySpanTrace {
        crate::observability::ObservabilitySpanTrace {
            trace_id: self.span_trace_id.clone(),
            span_id: self.turn_span_id.clone(),
            parent_span_id: None,
        }
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

    /// Queues `entry` for the journal; called under the emit gate. The turn's journal writer
    /// (or the fallback task) marks the write finished once it is durable.
    fn enqueue_journal(&self, entry: ThreadJournalEventInput) {
        self.emit_gate.begin_journal_write();
        if let Some(tx) = self.journal_tx.lock().as_ref()
            && tx.send(entry.clone()).is_ok()
        {
            return;
        }
        let journal = Arc::clone(&self.runtime.journal);
        let gate = Arc::clone(&self.emit_gate);
        tokio::spawn(async move {
            let _ = journal.enqueue(entry).await;
            gate.finish_journal_write();
        });
    }
}

impl HarnessEventSink for ServerHarnessEventSink {
    fn record_model_call(&self, call: &ModelCallRecord<'_>) {
        // Nothing is built (and no payload serialized) unless the current config consents.
        let Some(langfuse) = self.current_langfuse() else {
            return;
        };
        let observability = &self.runtime.observability;
        let trace = crate::observability::ObservabilitySpanTrace {
            trace_id: self.span_trace_id.clone(),
            span_id: crate::observability::ObservabilitySpanTrace::new_span_id(),
            parent_span_id: Some(self.turn_span_id.clone()),
        };
        let turn_id = self.turn_id.lock().clone();
        let span = crate::observability::build_model_call_span(
            call,
            &self.thread_id,
            turn_id.as_deref(),
            trace,
            langfuse.allow_payload_attributes,
            observability.redaction_context(),
        );
        observability.emit_span(&langfuse, &span);
    }

    fn send_notification(&self, method: &str, params: Value) {
        if method == "serverRequest/resolved"
            && let Some(im) = self.runtime.interaction_managers.get(&self.thread_id)
        {
            let mut live = self.live_session.lock();
            live.has_pending_approval = im.has_pending_approval();
            live.has_pending_ask = im.has_pending_ask();
        }

        if method == "cowork/log" {
            if let Some(line) = params
                .get("line")
                .or_else(|| params.get("message"))
                .and_then(Value::as_str)
            {
                self.runtime
                    .observability
                    .record_session_log(&self.thread_id, line);
            }
        } else if method == "error" {
            if let Some(msg) = params.get("message").and_then(Value::as_str) {
                let code = params.get("code").and_then(Value::as_str);
                let source = params.get("source").and_then(Value::as_str);
                self.runtime
                    .observability
                    .record_session_error(&self.thread_id, msg, code, source);
            }
        } else if method == "item/completed"
            && let Some(item) = params.get("item")
        {
            match item.get("type").and_then(Value::as_str) {
                Some("error") => {
                    if let Some(msg) = item.get("message").and_then(Value::as_str) {
                        let code = item.get("code").and_then(Value::as_str);
                        let source = item.get("source").and_then(Value::as_str);
                        self.runtime.observability.record_session_error(
                            &self.thread_id,
                            msg,
                            code,
                            source,
                        );
                    }
                }
                Some("log") => {
                    if let Some(line) = item
                        .get("text")
                        .or_else(|| item.get("line"))
                        .and_then(Value::as_str)
                    {
                        self.runtime
                            .observability
                            .record_session_log(&self.thread_id, line);
                    }
                }
                _ => {}
            }
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

        let mut gate = self.emit_gate.lock();
        if method == "serverRequest/resolved"
            && let Some(request_id) = req_id.as_deref()
        {
            gate.emitted_requests.remove(request_id);
        }
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
        if capture_replayed_request(request_id, method, &params) {
            return;
        }
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

        let mut gate = self.emit_gate.lock();
        gate.emitted_requests.insert(request_id.to_owned());
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

/// Read-only view of a stored history as canonical messages (legacy shapes are migrated;
/// messages that cannot be migrated are omitted from the view, never from storage).
pub(crate) fn parse_stored_canonical_messages(stored: &[Value]) -> Vec<CanonicalMessage> {
    parse_stored_history(stored, None).messages
}

/// Stored history split into replayable canonical messages plus any raw entries that could not
/// be migrated, remembering the original order so persistence never drops a message.
pub(crate) struct StoredHistory {
    pub messages: Vec<CanonicalMessage>,
    /// One slot per stored entry: `None` = migrated (next canonical message), `Some(raw)` = kept raw.
    slots: Vec<Option<Value>>,
}

impl StoredHistory {
    pub(crate) fn unmigrated_count(&self) -> usize {
        self.slots.iter().filter(|s| s.is_some()).count()
    }

    /// Rebuilds the persisted message list from a turn outcome whose first `self.messages.len()`
    /// entries are the migrated prefix, re-inserting unmigrated raw entries in their original
    /// positions.
    pub(crate) fn merge_for_persist(&self, outcome_messages: &[CanonicalMessage]) -> Vec<Value> {
        let mut out = Vec::with_capacity(self.slots.len() + outcome_messages.len());
        let mut canon = outcome_messages.iter();
        for slot in &self.slots {
            match slot {
                Some(raw) => out.push(raw.clone()),
                None => {
                    if let Some(v) = canon.next().and_then(|m| serde_json::to_value(m).ok()) {
                        out.push(v);
                    }
                }
            }
        }
        out.extend(canon.filter_map(|m| serde_json::to_value(m).ok()));
        out
    }
}

pub(crate) fn parse_stored_history(
    stored: &[Value],
    fallback_created_at: Option<&str>,
) -> StoredHistory {
    let mut messages = Vec::with_capacity(stored.len());
    let mut slots = Vec::with_capacity(stored.len());
    for (index, val) in stored.iter().enumerate() {
        match migrate_stored_message(val, index, fallback_created_at) {
            Some(cm) => {
                messages.push(cm);
                slots.push(None);
            }
            None => slots.push(Some(val.clone())),
        }
    }
    StoredHistory { messages, slots }
}

/// How long a replaced interaction manager is kept for duplicate-response recognition; matches
/// the interaction receipt window (5 minutes).
const RETIRED_INTERACTION_MANAGER_TTL: std::time::Duration = std::time::Duration::from_secs(300);
/// Replaced interaction managers kept per thread (oldest dropped first).
const MAX_RETIRED_INTERACTION_MANAGERS_PER_THREAD: usize = 8;

/// Releases a thread's `busy` reservation (taken atomically with the busy check in
/// `turn/start`) unless the turn was committed to `active_turns`.
struct TurnReservation {
    runtime: Arc<ServerRuntimeState>,
    live: Arc<Mutex<LiveSession>>,
    thread_id: String,
    /// Set by a `turn/interrupt` that arrives while the turn is still being set up (see
    /// `ServerRuntimeState::turn_setup_interrupts`).
    setup_interrupt: Arc<std::sync::atomic::AtomicBool>,
    prev_idle_since: Option<std::time::Instant>,
    armed: bool,
}

impl TurnReservation {
    /// Hands the reservation over to the turn's `active_turns` entry (which must already be
    /// installed, so a later `turn/interrupt` finds it). Returns whether a `turn/interrupt`
    /// arrived during setup; the caller then cancels the turn before its first step.
    fn commit(mut self) -> bool {
        self.armed = false;
        self.release_setup_interrupt()
    }

    fn release_setup_interrupt(&self) -> bool {
        self.runtime
            .turn_setup_interrupts
            .remove_if(&self.thread_id, |_, flag| {
                Arc::ptr_eq(flag, &self.setup_interrupt)
            });
        self.setup_interrupt
            .load(std::sync::atomic::Ordering::SeqCst)
    }
}

impl Drop for TurnReservation {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        self.release_setup_interrupt();
        {
            let mut live = self.live.lock();
            live.busy = false;
            live.idle_since = self.prev_idle_since;
        }
        self.runtime.turn_settled_notify.notify_waiters();
    }
}

/// Resolves `turn/start.retry.toolItemIds` against the thread's projected tool items
/// (legacy `resolveToolRetryIntent` parity): each target must be an unresolved failed tool
/// with an input digest.
fn resolve_tool_retry_targets(
    runtime: &ServerRuntimeState,
    thread_id: &str,
    retry: &TurnRetrySpec,
) -> Result<Vec<ToolRetryTarget>, JsonRpcLiteError> {
    let invalid = |msg: String| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, msg);
    let ids = &retry.tool_item_ids;
    if ids.is_empty() || ids.len() > MAX_TOOL_RETRY_TARGETS {
        return Err(invalid(format!(
            "Retry must target between 1 and {MAX_TOOL_RETRY_TARGETS} failed tools."
        )));
    }
    if ids.iter().any(|id| id.trim().is_empty()) {
        return Err(invalid(
            "Retry targets must be non-empty strings.".to_owned(),
        ));
    }
    if ids.iter().collect::<std::collections::BTreeSet<_>>().len() != ids.len() {
        return Err(invalid("Retry targets must be unique.".to_owned()));
    }

    let mut projector = ThreadTurnProjector::new();
    let mut cursor = 0u64;
    loop {
        let batch = runtime
            .journal
            .list(thread_id, cursor, Some(250))
            .unwrap_or_default();
        for ev in &batch {
            projector.handle(&PersistedJournalEventView {
                event_type: &ev.event_type,
                turn_id: ev.turn_id.as_deref(),
                item_id: ev.item_id.as_deref(),
                payload: &ev.payload,
            });
        }
        match batch.last() {
            Some(last) if batch.len() >= 250 => cursor = last.seq,
            _ => break,
        }
    }
    // id -> (failed, retryOf, inputDigest)
    let mut tools: HashMap<String, (bool, Option<String>, Option<Value>)> = HashMap::new();
    for item in projector.build().into_iter().flat_map(|t| t.items) {
        if item.get("type").and_then(Value::as_str) != Some("toolCall") {
            continue;
        }
        let Some(id) = item.get("id").and_then(Value::as_str) else {
            continue;
        };
        let name = item
            .get("toolName")
            .or_else(|| item.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("tool");
        let state = item
            .get("state")
            .and_then(Value::as_str)
            .unwrap_or("output-available");
        let result = item.get("result").or_else(|| item.get("output"));
        tools.insert(
            id.to_owned(),
            (
                is_failed_tool_outcome(name, state, result),
                item.get("retryOf")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                item.get("inputDigest").cloned(),
            ),
        );
    }

    // Failed tools already recovered by a successful (possibly chained) retry.
    let mut recovered = std::collections::BTreeSet::<String>::new();
    for (failed, retry_of, _) in tools.values() {
        if *failed {
            continue;
        }
        let mut seen = std::collections::BTreeSet::new();
        let mut ancestor = retry_of.clone();
        while let Some(aid) = ancestor.filter(|a| seen.insert(a.clone())) {
            match tools.get(&aid) {
                Some((true, next, _)) => {
                    recovered.insert(aid);
                    ancestor = next.clone();
                }
                _ => break,
            }
        }
    }
    loop {
        let newly: Vec<String> = tools
            .iter()
            .filter(|(id, (failed, retry_of, _))| {
                *failed
                    && !recovered.contains(*id)
                    && retry_of.as_ref().is_some_and(|r| recovered.contains(r))
            })
            .map(|(id, _)| id.clone())
            .collect();
        if newly.is_empty() {
            break;
        }
        recovered.extend(newly);
    }

    ids.iter()
        .map(|id| {
            let Some((true, _, digest)) = tools.get(id) else {
                return Err(invalid(format!(
                    "Retry target is not an unresolved failed tool: {id}"
                )));
            };
            if recovered.contains(id) {
                return Err(invalid(format!("Retry target is already recovered: {id}")));
            }
            let Some(digest) = digest.clone() else {
                return Err(invalid(format!(
                    "Retry target does not have complete input digest metadata: {id}"
                )));
            };
            Ok(ToolRetryTarget {
                item_id: id.clone(),
                input_digest: digest,
            })
        })
        .collect()
}

pub(crate) type CodexBridgeContext<'a> = (
    &'a ToolExecutionContext,
    &'a Arc<InteractionManager>,
    &'a Arc<SteerCoordinator>,
    Option<usize>,
    // The turn runner's published catalog (deferred meta-tools, MCP adapters).
    Option<CodexBridgeCatalog>,
);

/// Maps the effective Cowork tool context onto Codex's native sandbox so read-only / scoped
/// sessions stay bounded when Codex runs its own shell and file tools.
fn codex_sandbox_restrictions(tctx: &ToolExecutionContext) -> CodexSandboxRestrictions {
    let mode = match tctx.sandbox_policy.mode() {
        cowork_sandbox::SandboxMode::DangerFullAccess => ConfigSandboxMode::DangerFullAccess,
        cowork_sandbox::SandboxMode::WorkspaceWrite => ConfigSandboxMode::WorkspaceWrite,
        // Codex has no "no-project-write" mode: fail closed to read-only.
        cowork_sandbox::SandboxMode::ReadOnly | cowork_sandbox::SandboxMode::NoProjectWrite => {
            ConfigSandboxMode::ReadOnly
        }
    };
    CodexSandboxRestrictions {
        mode: Some(mode),
        network: Some(policy_allows_network(&tctx.sandbox_policy)),
        yolo: Some(tctx.yolo),
        read_only_role: tctx.read_only_role,
        target_paths: tctx.target_paths.clone().unwrap_or_default(),
    }
}

pub(crate) fn select_provider_transport(
    provider: ProviderName,
    bedrock_auth: Option<BedrockAuthConfig>,
    homedir: &Path,
    env: &HashMap<String, String>,
    codex_tool_ctx: Option<CodexBridgeContext<'_>>,
    // Bundled install dir gating per-model Codex options when no tool context supplies one.
    built_in_dir: Option<&Path>,
) -> Result<Arc<dyn ProviderTransport>, String> {
    select_provider_transport_for_turn(
        provider,
        bedrock_auth,
        homedir,
        env,
        codex_tool_ctx,
        built_in_dir,
        false,
    )
}

pub(crate) fn select_provider_transport_for_turn(
    provider: ProviderName,
    bedrock_auth: Option<BedrockAuthConfig>,
    homedir: &Path,
    env: &HashMap<String, String>,
    codex_tool_ctx: Option<CodexBridgeContext<'_>>,
    built_in_dir: Option<&Path>,
    tools_disabled: bool,
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
            if let Some((tctx, im, steer, overflow, catalog)) = codex_tool_ctx {
                let observer: Arc<dyn cowork_providers::codex_app_server::CodexTurnObserver> =
                    Arc::clone(steer) as _;
                let resolved_built_in_dir = tctx
                    .built_in_dir
                    .clone()
                    .or_else(|| tctx.agent_config.as_ref().map(|c| c.built_in_dir.clone()))
                    .or_else(|| built_in_dir.map(Path::to_path_buf));
                if tools_disabled {
                    return Ok(Arc::new(
                        CodexAppServerTransport::with_env_and_bridges(
                            env.clone(),
                            None,
                            Some(observer),
                        )
                        .with_tools_disabled(true)
                        .with_built_in_dir(resolved_built_in_dir),
                    ));
                }
                let tools_map = create_builtin_tools(tctx);
                let dyn_handler = TurnStepRunner::build_codex_dynamic_tool_handler_with_catalog(
                    tools_map,
                    tctx.clone(),
                    Arc::clone(im),
                    overflow,
                    catalog,
                );
                Ok(Arc::new(
                    CodexAppServerTransport::with_env_and_bridges(
                        env.clone(),
                        Some(dyn_handler),
                        Some(observer),
                    )
                    .with_sandbox_restrictions(codex_sandbox_restrictions(tctx))
                    .with_built_in_dir(resolved_built_in_dir)
                    .with_todos_handler(tctx.on_todos_updated.clone()),
                ))
            } else {
                Ok(Arc::new(
                    CodexAppServerTransport::with_env(env.clone())
                        .with_tools_disabled(tools_disabled)
                        .with_built_in_dir(built_in_dir.map(Path::to_path_buf)),
                ))
            }
        }
        other => ChatCompletionsTransport::new(other)
            .map(|t| Arc::new(t) as Arc<dyn ProviderTransport>)
            .ok_or_else(|| format!("Unsupported provider transport: {}", other.as_str())),
    }
}

/// Endpoint override for `provider`: its provider-options section (`{provider}.baseUrl`), the
/// top-level `baseUrl` when `allow_top_level` (options of the chat's own provider), then the
/// `<PROVIDER>_BASE_URL` environment variable.
pub(crate) fn provider_base_url_override(
    provider: ProviderName,
    provider_opts: &Map<String, Value>,
    env: &HashMap<String, String>,
    allow_top_level: bool,
) -> Option<String> {
    let env_key = match provider {
        ProviderName::Google => "GEMINI_BASE_URL".to_owned(),
        ProviderName::Bedrock => "AWS_BEDROCK_ENDPOINT_URL".to_owned(),
        other => format!(
            "{}_BASE_URL",
            other.as_str().to_ascii_uppercase().replace('-', "_")
        ),
    };
    provider_opts
        .get(provider.as_str())
        .and_then(Value::as_object)
        .and_then(|o| o.get("baseUrl").or_else(|| o.get("base_url")))
        .or_else(|| {
            allow_top_level
                .then(|| {
                    provider_opts
                        .get("baseUrl")
                        .or_else(|| provider_opts.get("base_url"))
                })
                .flatten()
        })
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            env.get(&env_key)
                .map(String::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
        })
}

/// The chat's own model connection, reused when the memory model is on the same provider.
pub(crate) struct CurrentModelConnection<'a> {
    pub provider: ProviderName,
    pub transport: &'a Arc<dyn ProviderTransport>,
    pub base_url: &'a Option<String>,
    pub api_key: &'a Option<String>,
}

impl ServerRuntimeState {
    /// Resolves the configured memory-generation model reference (`provider:modelId`, or a bare
    /// model ID on the chat's provider; legacy `parseChildModelRef`) to a model on that
    /// provider's own transport, endpoint and credentials. `Err` when the reference cannot be
    /// resolved, so the caller skips generation without advancing the transcript cursor.
    pub(crate) async fn resolve_memory_generation_model(
        &self,
        model_ref: &str,
        current: CurrentModelConnection<'_>,
        provider_opts: &Map<String, Value>,
    ) -> Result<RemoteMemoryModel, String> {
        let (target, model_id, _, _) =
            cowork_config::parse_child_model_ref(model_ref, Some(current.provider))
                .ok_or_else(|| format!("invalid memory generation model '{model_ref}'"))?;
        if target == current.provider {
            return Ok(RemoteMemoryModel {
                transport: Arc::clone(current.transport),
                model_id,
                base_url: current.base_url.clone(),
                api_key: current.api_key.clone(),
            });
        }
        let paths = get_ai_coworker_paths(Some(&self.homedir), &self.env);
        let conn_store = read_connection_store(&paths).await.ok();
        let api_key = resolve_provider_api_key(target, conn_store.as_ref(), &self.env);
        let bedrock_auth = (target == ProviderName::Bedrock)
            .then(|| resolve_bedrock_auth_config(&self.homedir, &self.env, conn_store.as_ref()))
            .flatten();
        let base_url = match target {
            ProviderName::Lmstudio => Some(
                resolve_lmstudio_options(&self.env, Some(provider_opts), None).inference_base_url,
            ),
            other => provider_base_url_override(other, provider_opts, &self.env, false),
        };
        let transport = select_provider_transport(
            target,
            bedrock_auth,
            &self.homedir,
            &self.env,
            None,
            Some(&self.built_in_dir),
        )?;
        Ok(RemoteMemoryModel {
            transport,
            model_id,
            base_url,
            api_key,
        })
    }
}

/// Resolved `(outputDirectory, uploadsDirectory)` for a workspace: configured values
/// (`AGENT_OUTPUT_DIR` / `AGENT_UPLOADS_DIR` / project / user / built-in config), falling back
/// to `<workspace>/output` and `<workspace>/uploads`.
pub(crate) fn workspace_io_dirs(
    cfg: Option<&AgentConfig>,
    canonical_cwd: &Path,
) -> (PathBuf, PathBuf) {
    let output = cfg
        .and_then(|c| c.output_directory.clone())
        .unwrap_or_else(|| canonical_cwd.join("output"));
    let uploads = cfg
        .and_then(|c| c.uploads_directory.clone())
        .unwrap_or_else(|| canonical_cwd.join("uploads"));
    (output, uploads)
}

/// `(outputDirectory, uploadsDirectory)` to record on a new session: the resolved workspace
/// config values, `None` when defaulted (`SessionSnapshotBuilder.ts` persists
/// `config.outputDirectory` only when set).
pub(crate) fn config_io_dir_strings(cfg: &AgentConfig) -> (Option<String>, Option<String>) {
    let as_string = |p: &Option<PathBuf>| p.as_ref().map(|p| p.to_string_lossy().into_owned());
    (
        as_string(&cfg.output_directory),
        as_string(&cfg.uploads_directory),
    )
}

/// Layers a session's stored `outputDirectory` / `uploadsDirectory` over `cfg` so a resumed
/// session keeps the dirs it was created with (`AgentSessionFromPersisted.ts` parity). An
/// absent value keeps the config value (rows written before these were persisted). Like
/// configured dirs, a stored dir must resolve inside the workspace; one that does not is
/// ignored.
pub(crate) fn apply_session_io_dirs(
    cfg: &mut AgentConfig,
    output_directory: Option<&str>,
    uploads_directory: Option<&str>,
) {
    let canonical_cwd = canonicalize_sync(&cfg.working_directory);
    let resolve = |raw: Option<&str>| {
        let raw = raw.map(str::trim).filter(|s| !s.is_empty())?;
        let dir = canonical_cwd.join(raw);
        cowork_config::is_inside(&canonical_cwd, &dir).then_some(dir)
    };
    if let Some(dir) = resolve(output_directory) {
        cfg.output_directory = Some(dir);
    }
    if let Some(dir) = resolve(uploads_directory) {
        cfg.uploads_directory = Some(dir);
    }
}

/// Layers a session's persisted `sandbox` over `cfg` so a resumed session keeps the policy it
/// was saved with (mode, network, backend requirement) instead of the current workspace
/// defaults (`AgentSessionFromPersisted.ts` parity: `persisted.sandbox` replaces
/// `config.sandbox` wholesale). A session without a stored sandbox follows the config.
pub(crate) fn apply_session_sandbox(
    cfg: &mut AgentConfig,
    sandbox: Option<&cowork_config::SandboxConfig>,
) {
    if let Some(sandbox) = sandbox {
        cfg.sandbox = sandbox.clone();
    }
}

/// Read roots for file tools, shared by root sessions and (scoped) child agents: the bundled
/// install dir, the non-secret Cowork-home allowlist (`cowork_tools::cowork_home_read_roots`:
/// `~/.cowork/skills` and `~/.cowork/plugins` only), and every enabled discovered skill
/// directory (e.g. `~/.agents/skills/<name>`) so skill reference files stay readable. The whole
/// Cowork home is never a root: its `config/` (user `mcp-servers.json`, whose transport
/// env/headers can hold plaintext secrets), logs, sessions and memories must stay unreadable,
/// and `targetPaths` exempts every external root. Credential paths remain denied by
/// `assert_read_path_allowed`; a skill dir equal to or above the home directory or Cowork home,
/// or one inside Cowork home (covered only through the allowlist), is never added so the roots
/// cannot widen into all of `$HOME` or Cowork state.
pub(crate) fn tool_read_roots(
    built_in_dir: &Path,
    cowork_home: &Path,
    homedir: &Path,
    skills: &std::collections::BTreeMap<String, cowork_tools::DiscoveredSkill>,
) -> Vec<PathBuf> {
    let mut roots = vec![built_in_dir.to_path_buf()];
    roots.extend(cowork_tools::cowork_home_read_roots(cowork_home));
    for skill in skills.values().filter(|s| s.enabled) {
        let dir = canonicalize_sync(&skill.dir_path);
        if dir.parent().is_none()
            || cowork_config::is_inside(&dir, homedir)
            || cowork_config::is_inside(&dir, cowork_home)
            || cowork_config::is_inside(cowork_home, &dir)
        {
            continue;
        }
        if roots.iter().any(|r| cowork_config::is_inside(r, &dir)) {
            continue;
        }
        roots.push(dir);
    }
    roots
}

/// Emits `cowork/session/turnUsage` + `cowork/session/usage` after a turn's usage has been
/// recorded (`turnUsageAggregator.ts` `persistAggregatedUsage` parity). Nothing is emitted when
/// the turn recorded no model usage.
fn emit_turn_usage_notifications(
    sink: &dyn HarnessEventSink,
    thread_id: &str,
    turn_id: &str,
    turn_usage: &cowork_inference::TurnUsage,
    snapshot: &SessionUsageSnapshot,
    tracker: &SessionCostTracker,
) {
    let entries: Vec<_> = snapshot
        .turns
        .iter()
        .filter(|entry| entry.turn_id == turn_id)
        .collect();
    if entries.is_empty() {
        return;
    }
    let mut recorded = turn_usage.clone();
    recorded.estimated_cost_usd = entries
        .iter()
        .map(|entry| entry.estimated_cost_usd)
        .sum::<Option<f64>>();
    sink.send_notification(
        "cowork/session/turnUsage",
        json!({
            "type": "turn_usage",
            "sessionId": thread_id,
            "turnId": turn_id,
            "usage": recorded,
        }),
    );
    sink.send_notification(
        "cowork/session/usage",
        session_usage_event(thread_id, tracker),
    );
}

/// Upper bound on how long `turn/start` waits for managed-runtime bootstrap to settle.
const TURN_STARTUP_READY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// `session_usage` payload (compact usage snapshot), shared by the post-turn
/// `cowork/session/usage` notification and the `cowork/session/usageBudget/set` result.
pub(crate) fn session_usage_event(thread_id: &str, tracker: &SessionCostTracker) -> Value {
    json!({
        "type": "session_usage",
        "sessionId": thread_id,
        "usage": tracker.get_compact_snapshot(None),
    })
}

/// Rehydrates a session's cost tracker from its persisted snapshot, with the live session's
/// budget thresholds (the source of truth) applied on top.
pub(crate) fn rehydrate_session_cost_tracker(
    thread_id: &str,
    snapshot: Option<Value>,
    warn_at_usd: Option<f64>,
    stop_at_usd: Option<f64>,
) -> SessionCostTracker {
    let thresholds = BudgetThresholds {
        warn_at_usd,
        stop_at_usd,
    };
    let mut tracker = snapshot
        .and_then(|v| serde_json::from_value::<SessionUsageSnapshot>(v).ok())
        .map(SessionCostTracker::from_snapshot)
        .unwrap_or_else(|| SessionCostTracker::new(thread_id, Some(thresholds)));
    let _ = tracker.set_budget(thresholds);
    tracker
}

pub(crate) fn apply_session_config_overrides(
    cfg: &mut AgentConfig,
    overrides: &Map<String, Value>,
) {
    if let Some(v) = overrides.get("enableMemory").and_then(Value::as_bool) {
        cfg.enable_memory = v;
    }
    if let Some(v) = overrides
        .get("memoryRequireApproval")
        .and_then(Value::as_bool)
    {
        cfg.memory_require_approval = v;
    }
    if let Some(v) = overrides.get("advancedMemory").and_then(Value::as_bool) {
        cfg.advanced_memory = v;
    }
    if let Some(v) = overrides
        .get("memoryGenerationModel")
        .and_then(Value::as_str)
    {
        cfg.memory_generation_model = Some(v.to_owned());
    }
    match overrides.get("toolOutputOverflowChars") {
        Some(Value::Null) => cfg.tool_output_overflow_chars = None,
        Some(v) => {
            if let Some(n) = v.as_u64() {
                cfg.tool_output_overflow_chars = Some(n);
            }
        }
        None => {}
    }
    // A session `userName` / `userProfile` override is part of the effective config the profile
    // is rendered from (TS `prepareConfigUpdate` refreshed `state.system` from the patched config
    // for every session kind). Root sessions also persist it to the workspace first, but a child
    // agent's override is session-only, so it must be layered here; a child's prompt section is
    // rendered from this config by `set_session_config`. The stored profile holds only the fields
    // the session set; the others keep the workspace values
    // (`{ ...effectiveUserProfile(), ...patch }`).
    if let Some(v) = overrides.get("userName").and_then(Value::as_str) {
        cfg.user_name = v.to_owned();
    }
    if let Some(profile) = overrides.get("userProfile").and_then(Value::as_object) {
        let field = |key: &str| profile.get(key).and_then(Value::as_str).map(str::to_owned);
        if let Some(v) = field("instructions") {
            cfg.user_profile.instructions = v;
        }
        if let Some(v) = field("work") {
            cfg.user_profile.work = v;
        }
        if let Some(v) = field("details") {
            cfg.user_profile.details = v;
        }
    }
    if let Some(po) = overrides.get("providerOptions").and_then(Value::as_object) {
        if let Some(b) = po.get("codeMode").and_then(Value::as_bool) {
            cfg.tool_calling.code_mode = b;
        }
        if let Some(b) = po.get("deferredToolSearch").and_then(Value::as_bool) {
            cfg.tool_calling.deferred_tool_search = b;
        }
        if let Some(s) = po
            .get("toolCallingStrategy")
            .and_then(Value::as_str)
            .and_then(ToolCallingStrategy::parse)
        {
            cfg.tool_calling.strategy = s;
        }
    }
    if let Some(b) = overrides.get("codeMode").and_then(Value::as_bool) {
        cfg.tool_calling.code_mode = b;
    }
    if let Some(b) = overrides.get("deferredToolSearch").and_then(Value::as_bool) {
        cfg.tool_calling.deferred_tool_search = b;
    }
    if let Some(tc) = overrides.get("toolCalling").and_then(Value::as_object) {
        if let Some(b) = tc.get("codeMode").and_then(Value::as_bool) {
            cfg.tool_calling.code_mode = b;
        }
        if let Some(b) = tc.get("deferredToolSearch").and_then(Value::as_bool) {
            cfg.tool_calling.deferred_tool_search = b;
        }
        if let Some(s) = tc
            .get("strategy")
            .and_then(Value::as_str)
            .and_then(ToolCallingStrategy::parse)
        {
            cfg.tool_calling.strategy = s;
        }
    }
}

pub(crate) fn build_memory_prompt_section(
    sqlite_store: &cowork_storage::MemoryStore,
    adv_store: &cowork_tools::AdvancedMemoryStore,
    advanced_enabled: bool,
) -> Option<String> {
    let mut parts = Vec::new();
    if advanced_enabled {
        // The session's own folder, the shared `(chats)` folder (TS `renderPromptSection`
        // injected it into project sessions too), then `_global`. Each index is rendered from
        // the entry files (TS `renderIndex`), not read from a possibly missing/stale MEMORY.md.
        for (scope, dir) in adv_store.readable_scope_dirs() {
            if let Ok(index) = adv_store.render_index(&dir, scope)
                && !index.is_empty()
            {
                let label = cowork_tools::memory::scope_display_label(scope);
                parts.push(format!("### {label} Memory Index\n{index}"));
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
    /// Sandbox ceiling for a persisted child agent saved without a sandbox (rows written before
    /// children persisted theirs): its parent's effective sandbox. The child's own role/scope
    /// narrowing is applied on top by the caller.
    ///
    /// The ancestry is walked up to the nearest ancestor with a saved sandbox, or to the root
    /// (whose effective sandbox is its saved sandbox layered over `workspace` defaults, exactly
    /// as its own turns apply it in `apply_session_sandbox`). Every legacy child crossed on the
    /// way re-applies its own role/scope narrowing on the way back down, so the result is never
    /// wider than any ancestor. Fails closed to read-only (as a child whose scope cannot be
    /// restored does) when a link is missing, an intermediate scope cannot be restored, the
    /// ancestry loops, or it is deeper than `MAX_LEGACY_CHILD_ANCESTRY`.
    fn legacy_child_parent_sandbox(
        &self,
        workspace: &AgentConfig,
        parent_session_id: Option<&str>,
    ) -> cowork_config::SandboxConfig {
        const MAX_LEGACY_CHILD_ANCESTRY: usize = 64;
        let fail_closed = || cowork_config::SandboxConfig {
            mode: ConfigSandboxMode::ReadOnly,
            ..workspace.sandbox.clone()
        };
        // Legacy child ancestors crossed on the way up, nearest first.
        let mut legacy_ancestors: Vec<cowork_storage::PersistedSessionRecord> = Vec::new();
        let mut visited: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut next = parent_session_id.map(str::to_owned);
        let ceiling = loop {
            let Some(id) = next.take() else {
                return fail_closed();
            };
            if visited.len() >= MAX_LEGACY_CHILD_ANCESTRY || !visited.insert(id.clone()) {
                return fail_closed();
            }
            let record = self.session_db.get_session_record(&id).ok().flatten();
            let live = self.get_live_thread(&id).map(|live| {
                let live = live.lock();
                (
                    live.sandbox.clone(),
                    live.session_kind,
                    live.parent_session_id.clone(),
                )
            });
            let (saved, kind, parent) = match (live, &record) {
                (Some(live), _) => live,
                (None, Some(row)) => (
                    row.sandbox.clone(),
                    row.session_kind,
                    row.parent_session_id.clone(),
                ),
                (None, None) => return fail_closed(),
            };
            if saved.is_some() || kind != cowork_storage::SessionKind::Agent {
                let mut ancestor_cfg = workspace.clone();
                apply_session_sandbox(&mut ancestor_cfg, saved.as_ref());
                break ancestor_cfg.sandbox;
            }
            // A legacy child ancestor: its own narrowing needs its persisted row.
            let Some(row) = record else {
                return fail_closed();
            };
            legacy_ancestors.push(row);
            next = parent;
        };
        let mut sandbox = ceiling;
        for row in legacy_ancestors.iter().rev() {
            let mut ancestor_cfg = workspace.clone();
            ancestor_cfg.sandbox = sandbox;
            match cowork_harness::agents::restore_persisted_child_restrictions(&ancestor_cfg, row) {
                Ok(restored) => sandbox = restored.sandbox,
                Err(_) => return fail_closed(),
            }
        }
        sandbox
    }

    pub(crate) fn ensure_thread_idempotency_ledger(
        &self,
        thread_id: &str,
    ) -> Arc<TurnIdempotencyLedger> {
        if let Some(existing) = self.idempotency_ledgers.get(thread_id) {
            return Arc::clone(existing.value());
        }
        let ledger = Arc::new(TurnIdempotencyLedger::new());
        match self
            .journal
            .list_by_type(thread_id, USER_MESSAGE_ACCEPTED_EVENT)
        {
            Ok(events) => {
                for ev in events {
                    ledger.hydrate_from_journal_payload(&ev.payload);
                }
            }
            Err(err) => {
                tracing::warn!(%thread_id, error = %err, "idempotency ledger hydration failed; misses will consult the journal");
                ledger.mark_incomplete();
            }
        }
        Arc::clone(
            self.idempotency_ledgers
                .entry(thread_id.to_owned())
                .or_insert(ledger)
                .value(),
        )
    }

    /// Durable `clientMessageId` receipt for `turn/start` idempotency: the first
    /// `internal/userMessageAccepted` journal payload recorded for the key on this thread.
    pub(crate) fn load_user_message_receipt(
        &self,
        thread_id: &str,
        client_message_id: &str,
    ) -> Option<Value> {
        match self.journal.find_by_payload_string(
            thread_id,
            USER_MESSAGE_ACCEPTED_EVENT,
            "clientMessageId",
            client_message_id,
        ) {
            Ok(found) => found.map(|ev| ev.payload),
            Err(err) => {
                tracing::warn!(%thread_id, error = %err, "idempotency receipt lookup failed");
                None
            }
        }
    }

    /// Keeps a thread's replaced interaction manager for the receipt window, so its resolved
    /// server-request receipts survive the turn boundary (bounded by count and age per thread).
    fn retire_interaction_manager(&self, thread_id: &str, manager: Arc<InteractionManager>) {
        let now = std::time::Instant::now();
        let mut retired = self
            .retired_interaction_managers
            .entry(thread_id.to_owned())
            .or_default();
        retired.retain(|(at, _)| now.duration_since(*at) <= RETIRED_INTERACTION_MANAGER_TTL);
        while retired.len() >= MAX_RETIRED_INTERACTION_MANAGERS_PER_THREAD {
            retired.pop_front();
        }
        retired.push_back((now, manager));
    }

    fn retired_interaction_owner(&self, request_id: &str) -> Option<Arc<InteractionManager>> {
        let now = std::time::Instant::now();
        self.retired_interaction_managers.iter().find_map(|entry| {
            entry
                .value()
                .iter()
                .rev()
                .filter(|(at, _)| now.duration_since(*at) <= RETIRED_INTERACTION_MANAGER_TTL)
                .find(|(_, mgr)| mgr.owns_request_id(request_id))
                .map(|(_, mgr)| Arc::clone(mgr))
        })
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
        // A request resolved in an earlier turn: its receipt lives on that turn's (retired)
        // manager, which answers a retry as `already_applied` or a conflict.
        if owner.is_none() {
            owner = self.retired_interaction_owner(&req_id_str);
        }

        let Some(mgr) = owner.filter(|mgr| {
            self.get_live_thread(mgr.thread_id())
                .is_some_and(|live| live.lock().subscribers.contains(connection_id))
        }) else {
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
        let references = parse_references_param(params.references.as_deref())?;
        let tools_disabled = matches!(params.tools, Some(TurnToolsMode::None));

        if tools_disabled && params.retry.is_some() {
            return Err(JsonRpcLiteError::new(
                error_codes::INVALID_PARAMS,
                "turn/start retry cannot be combined with tools: \"none\".",
            ));
        }

        if params.retry.is_some() && !tool_retry_lineage {
            return Err(JsonRpcLiteError::new(
                error_codes::INVALID_REQUEST,
                "turn/start retry requires the toolRetryLineage client capability.",
            ));
        }

        // The turn snapshots `effective_tool_env()`, which only gains the managed runtime's
        // PATH/Node/env overlay once bootstrap settles (`waitForStartupReady` parity). Disabled
        // runtimes start ready and failed bootstraps settle with an error, so neither blocks;
        // the cap keeps a stalled download from hanging turns, which then use the host env.
        if !self
            .wait_for_startup_ready_bounded(TURN_STARTUP_READY_TIMEOUT)
            .await
        {
            tracing::warn!(
                thread_id = %params.thread_id,
                "runtime startup not settled before turn/start; continuing with host environment"
            );
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
            && let Some(dup) = ledger.lookup_existing_turn_with_journal(
                cid,
                &extracted.text,
                &extracted.attachments,
                params.tools,
                |cid| self.load_user_message_receipt(&params.thread_id, cid),
            )?
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

        let retry_targets = match params.retry.as_ref() {
            Some(spec) => resolve_tool_retry_targets(self, &params.thread_id, spec)?,
            None => Vec::new(),
        };

        // A child agent's row may be newer than this cache (see `refresh_child_run_state`);
        // read it before taking the session lock.
        let stored_child_row = (live_arc.lock().session_kind != cowork_storage::SessionKind::Root)
            .then(|| {
                self.session_db
                    .get_session_record(&params.thread_id)
                    .ok()
                    .flatten()
            })
            .flatten();

        let setup_interrupt = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (
            provider,
            model_id,
            cwd_path,
            session_provider_opts,
            session_kind,
            stored_provider_state,
            harness_context_val,
            title_source_initial,
            title_initial,
            requested_reasoning,
            session_enable_mcp,
            session_backups_override,
            session_yolo_override,
            prev_idle_since,
        ) = {
            let mut live = live_arc.lock();
            if live.busy || self.active_turns.contains_key(&params.thread_id) {
                return Err(JsonRpcLiteError::new(
                    error_codes::INVALID_REQUEST,
                    "A turn is already in progress on this thread.",
                ));
            }
            // Reserve the thread in the same critical section as the check so concurrent
            // `turn/start` requests cannot both pass it while this one awaits setup.
            live.busy = true;
            // Published with the reservation so a `turn/interrupt` during setup is not lost.
            self.turn_setup_interrupts
                .insert(params.thread_id.clone(), Arc::clone(&setup_interrupt));
            // The parent's `AgentControl` may have run a follow-up on this child since this
            // cache last saw its row; start from the stored transcript then.
            if let Some(stored) = &stored_child_row {
                live.refresh_child_run_state(stored);
            }
            // A direct user turn reopens a closed session (`runUserMessageTurn.ts` parity);
            // closing and resuming otherwise go through the parent's `AgentControl`.
            if live.persistence_status == cowork_storage::SessionPersistenceStatus::Closed {
                live.persistence_status = cowork_storage::SessionPersistenceStatus::Active;
                if live.execution_state == Some(cowork_storage::AgentExecutionState::Closed) {
                    live.execution_state = Some(cowork_storage::AgentExecutionState::Completed);
                }
            }
            let prev_idle_since = live.idle_since.take();
            (
                live.provider,
                live.model.clone(),
                PathBuf::from(&live.cwd),
                // SECURITY BOUNDARY: endpoint/header/credential overrides are stripped here.
                live.provider_options_override(),
                live.session_kind,
                live.provider_state.clone(),
                live.harness_context.clone(),
                live.title_source,
                live.title.clone(),
                live.requested_reasoning_effort.clone(),
                live.enable_mcp,
                live.config_overrides
                    .get("backupsEnabled")
                    .and_then(Value::as_bool),
                live.config_overrides.get("yolo").and_then(Value::as_bool),
                prev_idle_since,
            )
        };
        // Session `cowork/session/config/set { maxSteps }` override (legacy `state.maxSteps`).
        let max_steps = live_arc
            .lock()
            .config_overrides
            .get("maxSteps")
            .and_then(Value::as_u64)
            .map_or(DEFAULT_MAX_TURN_STEPS, |n| n as usize);
        let reservation = TurnReservation {
            runtime: Arc::clone(self),
            live: Arc::clone(&live_arc),
            thread_id: params.thread_id.clone(),
            setup_interrupt,
            prev_idle_since,
            armed: true,
        };
        let effective_yolo = session_yolo_override.unwrap_or(self.yolo);

        // Effective session config: `cowork/session/config/set` overrides layered over the
        // workspace config, so prompt, tool context and memory generation all see them.
        let (session_config_overrides, session_output_dir, session_uploads_dir, session_sandbox) = {
            let live = live_arc.lock();
            (
                live.config_overrides.clone(),
                live.output_directory.clone(),
                live.uploads_directory.clone(),
                live.sandbox.clone(),
            )
        };
        // Fail closed: without the merged config a root thread with no saved sandbox would fall
        // back to `SandboxConfig::default()` (workspace writes + network), widening a stricter
        // user/workspace policy. The reservation is released when this returns.
        let loaded_cfg = self.load_workspace_config(&cwd_path).map_err(|e| {
            JsonRpcLiteError::new(
                error_codes::INVALID_REQUEST,
                format!("Cannot start a turn: the workspace config could not be loaded: {e:#}"),
            )
        })?;
        let mut workspace_cfg = Some(loaded_cfg).map(|mut cfg| {
            apply_session_config_overrides(&mut cfg, &session_config_overrides);
            apply_session_io_dirs(
                &mut cfg,
                session_output_dir.as_deref(),
                session_uploads_dir.as_deref(),
            );
            apply_session_sandbox(&mut cfg, session_sandbox.as_ref());
            cfg
        });
        // A direct `turn/start` on a persisted child agent session must keep the child's
        // role/profile/targetPaths restrictions (the same scope the child executor applies);
        // fail closed when they cannot be rebuilt.
        let child_restrictions = if session_kind == cowork_storage::SessionKind::Agent {
            let restored = workspace_cfg
                .as_mut()
                .ok_or_else(|| "workspace config could not be loaded".to_owned())
                .and_then(|cfg| {
                    let row = self
                        .session_db
                        .get_session_record(&params.thread_id)
                        .map_err(|e| e.to_string())?
                        .ok_or_else(|| "persisted child session record is missing".to_owned())?;
                    if row.sandbox.is_none() {
                        // A legacy child saved without a sandbox: it inherited its parent's
                        // effective sandbox at spawn, so derive it from the parent rather than
                        // run it under the (possibly wider) workspace defaults.
                        cfg.sandbox =
                            self.legacy_child_parent_sandbox(cfg, row.parent_session_id.as_deref());
                    }
                    cowork_harness::agents::restore_persisted_child_restrictions(cfg, &row)
                });
            match restored {
                Ok(r) => {
                    // The restored sandbox was derived from (and is never wider than) the
                    // persisted sandbox applied above, so a saved read-only policy or
                    // `network: false` is never widened by the child's targetPaths.
                    if let Some(cfg) = workspace_cfg.as_mut() {
                        cfg.sandbox = r.sandbox.clone();
                    }
                    Some(r)
                }
                Err(e) => {
                    return Err(JsonRpcLiteError::new(
                        error_codes::INVALID_REQUEST,
                        format!(
                            "Child agent '{}' cannot run: {e}. Close it and spawn a new agent.",
                            params.thread_id
                        ),
                    ));
                }
            }
        } else {
            None
        };
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
        // TS `applyReasoningEffort` wrote the effort only into OpenAI-compatible provider options
        // (`openai`, `codex-cli`), and only for a model that takes it; Google thinking travels
        // as `thinkingConfig`, so injecting `reasoningEffort` there would make the Google
        // request builder send `thinking_level` to non-reasoning models.
        let model_defaults = self.model_provider_option_defaults(provider, &model_id);
        if let Some(effort) = requested_reasoning.as_ref().filter(|effort| {
            matches!(provider, ProviderName::Openai | ProviderName::CodexCli)
                && self.model_accepts_reasoning_effort(provider, &model_id, effort, &model_defaults)
        }) {
            let sub = merged_provider_opts
                .entry(provider.as_str().to_owned())
                .or_insert_with(|| Value::Object(Map::new()));
            if let Some(sub_map) = sub.as_object_mut() {
                sub_map
                    .entry("reasoningEffort".to_owned())
                    .or_insert_with(|| Value::String(effort.clone()));
            }
        }
        // Workspace defaults are reconciled against the workspace model, not this thread's
        // model; drop gated reasoning keys the thread's model does not support so the provider
        // serializer never emits an unsupported `reasoning` payload.
        merged_provider_opts =
            reconcile_reasoning_provider_options(&merged_provider_opts, provider, &model_defaults)
                .unwrap_or_default();

        // Pre-turn LM Studio reachability gate BEFORE idempotency commit (`routes/turn.ts` parity).
        let mut lmstudio_inference_url: Option<String> = None;
        // Applied in the turn task before inference (`prepareLmStudioModelMetadataForInference`).
        let mut lmstudio_prepare: Option<
            cowork_providers::chat_completions::lmstudio::LmStudioOptions,
        > = None;
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
            lmstudio_inference_url = Some(lms_opts.inference_base_url.clone());
            lmstudio_prepare = Some(lms_opts);
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
        let (output_dir, uploads_dir) = workspace_io_dirs(workspace_cfg.as_ref(), &canonical_cwd);
        let attachment_caps = AttachmentModelCapabilities::resolve(
            self.model_registry(),
            provider,
            &model_id,
            &self.homedir,
            &self.env,
        );
        let materialized = materialize_turn_attachments_for_model(
            &extracted,
            &uploads_dir,
            &canonical_cwd,
            attachment_caps,
        )
        .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;

        // Imported / pre-journal threads: record the stored prefix before this turn journals.
        self.ensure_journal_seed_marker(&live_arc).await;

        let proposed_turn_id = Uuid::new_v4().to_string();
        let idem_outcome = match ledger.check_or_record_turn_with_journal(
            params.client_message_id.as_deref().unwrap_or(""),
            &proposed_turn_id,
            &extracted.text,
            &extracted.attachments,
            params.tools,
            |cid| self.load_user_message_receipt(&params.thread_id, cid),
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
                    event_type: USER_MESSAGE_ACCEPTED_EVENT.to_owned(),
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
            _ => provider_base_url_override(provider, &merged_provider_opts, &self.env, true),
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
            .unwrap_or_else(|| {
                workspace_cfg
                    .as_ref()
                    .is_some_and(|c| c.tool_calling.deferred_tool_search)
            });
        let code_mode_enabled = merged_provider_opts
            .get("codeMode")
            .and_then(Value::as_bool)
            .unwrap_or_else(|| {
                workspace_cfg
                    .as_ref()
                    .is_some_and(|c| c.tool_calling.code_mode)
            });
        let tool_calling_strategy = merged_provider_opts
            .get("toolCallingStrategy")
            .and_then(Value::as_str)
            .and_then(ToolCallingStrategy::parse)
            .unwrap_or_else(|| {
                workspace_cfg
                    .as_ref()
                    .map_or(ToolCallingStrategy::Auto, |c| c.tool_calling.strategy)
            });
        let effective_tool_calling = ToolCallingConfig {
            code_mode: code_mode_enabled && !tools_disabled,
            deferred_tool_search: deferred_tool_search && !tools_disabled,
            strategy: tool_calling_strategy,
        };
        // A loaded config already resolved absent -> default and null -> None (spilling off);
        // when the workspace config could not be loaded, keep the default threshold rather than
        // silently disabling spilling.
        let overflow_threshold = workspace_cfg
            .as_ref()
            .map_or(
                Some(cowork_config::DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS),
                |c| c.tool_output_overflow_chars,
            )
            .map(|n| n as usize);
        // `modelSettings.maxRetries` / `AGENT_MODEL_MAX_RETRIES`, already resolved by the config
        // loader; the harness converts it into the per-step model-call attempt budget.
        let model_max_retries = workspace_cfg
            .as_ref()
            .and_then(|c| c.model_settings.as_ref())
            .and_then(|m| m.max_retries);
        let enable_memory = workspace_cfg.as_ref().is_none_or(|c| c.enable_memory);
        let advanced_memory = workspace_cfg.as_ref().is_some_and(|c| c.advanced_memory);
        let require_file_approval = merged_provider_opts
            .get("requireFileChangeApproval")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            && !effective_yolo;

        let sink_impl = Arc::new(ServerHarnessEventSink {
            runtime: Arc::clone(self),
            thread_id: params.thread_id.clone(),
            fallback_conn_id: Mutex::new(Some(connection_id.to_owned())),
            turn_id: Mutex::new(Some(turn_id.clone())),
            live_session: Arc::clone(&live_arc),
            journal_tx: Mutex::new(None),
            deferred_turn_completed: Mutex::new(None),
            emit_gate: self.thread_emit_gate(&params.thread_id),
            span_trace_id: crate::observability::ObservabilitySpanTrace::new_trace_id(),
            turn_span_id: crate::observability::ObservabilitySpanTrace::new_span_id(),
            config_cwd: cwd_path.clone(),
        });
        let sink: Arc<dyn HarnessEventSink> = sink_impl.clone();

        let interactions = Arc::new(
            InteractionManager::new(&params.thread_id, Arc::clone(&sink))
                .with_turn_id(&turn_id)
                .with_yolo(effective_yolo)
                .with_file_change_approval(require_file_approval),
        );
        if let Some(previous) = self
            .interaction_managers
            .insert(params.thread_id.clone(), Arc::clone(&interactions))
        {
            self.retire_interaction_manager(&params.thread_id, previous);
        }

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
            cfg.tool_calling = effective_tool_calling.clone();
        }

        let bundled_skills_dir = self.built_in_dir.join("skills");
        let mut available_skills = if let Some(ref cfg) = effective_agent_cfg {
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
        if let Some(allow) = child_restrictions
            .as_ref()
            .and_then(|r| r.allowed_skill_names.as_ref())
        {
            available_skills.retain(|name, _| allow.contains(name));
        }
        let mention_context = Arc::new(TurnMentionContext {
            skills: available_skills.clone(),
            cowork_home: paths.root_dir.clone(),
            working_directory: canonical_cwd.clone(),
        });
        // Plugin references resolve through the installed plugin catalog (loaded lazily).
        let mentions = cowork_harness::resolve_turn_references_with_plugin_catalog(
            &extracted.text,
            &references,
            &mention_context.skills,
            || {
                effective_agent_cfg
                    .as_ref()
                    .map(cowork_harness::installed_plugin_catalog)
                    .unwrap_or_default()
            },
        );
        let mentioned_skill_names = mentions.injected_skill_names.clone();

        let sqlite_mem = self.memory_store_for_workspace(&canonical_cwd);
        let adv_mem = self.advanced_memory_store_for_workspace(&canonical_cwd);
        let memory_section = enable_memory
            .then(|| build_memory_prompt_section(&sqlite_mem, &adv_mem, advanced_memory))
            .flatten();

        // `workspace_cfg` already carries the persisted session sandbox; when the workspace
        // config cannot be loaded the saved policy still beats the permissive default.
        let sandbox_cfg = workspace_cfg
            .as_ref()
            .map(|c| c.sandbox.clone())
            .or_else(|| session_sandbox.clone())
            .unwrap_or_default();
        let sandbox_policy = resolve_sandbox_policy(&ResolveSandboxPolicyInput {
            config: Some(sandbox_cfg.clone()),
            working_directory: canonical_cwd.clone(),
            project_root: Some(canonical_cwd.clone()),
            output_directory: Some(output_dir.clone()),
            uploads_directory: Some(uploads_dir.clone()),
            tool_runtime_writable_roots: scratch_roots(None),
            target_paths: child_restrictions.as_ref().and_then(|r| {
                r.target_paths.as_ref().map(|paths| {
                    paths
                        .iter()
                        .map(|p| p.to_string_lossy().into_owned())
                        .collect()
                })
            }),
            read_only_role: child_restrictions
                .as_ref()
                .is_some_and(|r| r.read_only_role),
            yolo: effective_yolo,
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

        let session_model = self.model_registry().get(provider, &model_id);
        // A child agent runs with its own saved prompt (TS used `state.system`, which only root
        // sessions regenerate), as the child executor does with `role_prompt`; a legacy child
        // saved without one gets its role/profile prompt rebuilt as `AgentControl` restores it.
        // Root sessions rebuild the model's template every turn.
        let child_system_prompt = (session_kind == cowork_storage::SessionKind::Agent).then(|| {
            let live = live_arc.lock();
            cowork_harness::agents::persisted_child_system_prompt(
                &self.built_in_dir,
                &live.system_prompt,
                live.role.as_deref(),
                live.profile.as_ref(),
            )
        });
        let resolved_prompt_template = child_system_prompt.or_else(|| {
            session_model
                .map(|m| m.prompt_template.trim().to_owned())
                .filter(|t| !t.is_empty() && t != "default")
                .or_else(|| {
                    if provider == ProviderName::Lmstudio {
                        Some("system-models/local.md".to_owned())
                    } else {
                        None
                    }
                })
        });

        if !tools_disabled
            && tool_calling_strategy == ToolCallingStrategy::Auto
            && (deferred_tool_search || code_mode_enabled)
            && matches!(provider, ProviderName::Openai | ProviderName::Anthropic)
            && !cowork_providers::has_cached_endpoint_check(
                provider,
                base_url.as_deref(),
                &model_id,
            )
        {
            let _ = cowork_providers::check_endpoint_capabilities(
                provider,
                base_url.as_deref(),
                &model_id,
                api_key.as_deref(),
                None,
                false,
            )
            .await;
        }
        let endpoint_caps = cowork_providers::resolve_endpoint_tool_capabilities(
            provider,
            base_url.as_deref(),
            &model_id,
            tool_calling_strategy,
        );

        let available_skills_for_usage = available_skills.clone();
        let read_roots = tool_read_roots(
            &self.built_in_dir,
            &paths.root_dir,
            &self.homedir,
            &available_skills,
        );
        let system_prompt = build_layered_system_prompt(&SystemPromptBuildOptions {
            prompts_dir: prompts_dir.is_dir().then_some(prompts_dir),
            prompt_template: resolved_prompt_template,
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
            deferred_tool_search_enabled: deferred_tool_search && !tools_disabled,
            code_mode_enabled: code_mode_enabled && !tools_disabled,
            template_context: PromptTemplateContext {
                model_display_name: session_model.map(|m| m.display_name.clone()),
                knowledge_cutoff: session_model.map(|m| m.knowledge_cutoff.clone()),
                supports_image_input: session_model.map(|m| m.supports_image_input).or_else(|| {
                    cowork_config::models::find_discovered_model_sync(&paths, provider, &model_id)
                        .and_then(|m| m.supports_image_input)
                }),
                enable_memory: Some(enable_memory),
                advanced_memory,
                provider_options: Some(merged_provider_opts.clone()),
                provider_catalog: Some(
                    cowork_harness::system_prompt::PromptProviderCatalog::from_snapshot(
                        cowork_providers::read_provider_catalog_snapshot(
                            &self.catalog_build_options(&canonical_cwd, false),
                        )
                        .await,
                    ),
                ),
                native_tool_search_enabled: !tools_disabled
                    && deferred_tool_search
                    && endpoint_caps.native_tool_search.is_some(),
                native_code_execution_enabled: !tools_disabled
                    && code_mode_enabled
                    && endpoint_caps.native_programmatic_tool_calling.is_some(),
                ..effective_agent_cfg
                    .as_ref()
                    .map(PromptTemplateContext::from_config)
                    .unwrap_or_default()
            },
        });
        let system_prompt = if tools_disabled {
            format!(
                "{system_prompt}\n\n## Tool Availability\nTools are disabled for this turn. Respond directly without calling any tools."
            )
        } else {
            system_prompt
        };

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
            deferred_tool_search: deferred_tool_search && !tools_disabled,
            max_steps,
            step_timeout_ms: STEP_TIMEOUT_MS,
            overflow_threshold_chars: overflow_threshold,
            tool_retry_lineage,
            initial_user_message: Some((
                effective_display_text.clone(),
                params.client_message_id.clone(),
            )),
            model_max_retries,
        })
        .with_tool_retry_targets(retry_targets)
        .with_tools_disabled(tools_disabled)
        .with_tool_calling(effective_tool_calling);
        let cancel_handle = runner.cancellation_handle();

        self.active_turns.insert(
            params.thread_id.clone(),
            ActiveTurnControl {
                turn_id: turn_id.clone(),
                cancel: cancel_handle,
                steer: Arc::clone(&steer),
                interactions: Arc::clone(&interactions),
                mention_context,
            },
        );
        if reservation.commit() {
            // Interrupted during setup: the runner sees the cancellation before its first step,
            // so the turn ends `interrupted` without dispatching to the provider.
            runner
                .cancellation_handle()
                .interrupt("Turn interrupted by user");
        }

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
        let allow_thread_management_tools = self.is_task_read_allowed(connection_id);
        let live_for_task = Arc::clone(&live_arc);
        let return_turn_id = turn_id.clone();
        let user_query_for_title = extracted.text.clone();

        let backups_enabled = session_backups_override
            .unwrap_or_else(|| workspace_cfg.as_ref().is_some_and(|c| c.backups_enabled));

        self.observability.record_server_event(
            "info",
            "turn.started",
            Some(&params.thread_id),
            Some(&json!({
                "turnId": turn_id,
                "provider": provider.as_str(),
                "model": model_id,
            })),
        );
        {
            let mut analytics_props = std::collections::BTreeMap::new();
            analytics_props.insert(
                "provider".to_owned(),
                Value::String(provider.as_str().to_owned()),
            );
            analytics_props.insert("model".to_owned(), Value::String(model_id.clone()));
            self.observability
                .capture_product_event("turn_started", &analytics_props);
        }

        tokio::spawn(async move {
            let turn_started_instant = std::time::Instant::now();
            let (journal_tx, mut journal_rx) = mpsc::unbounded_channel::<ThreadJournalEventInput>();
            let journal_for_writer = Arc::clone(&runtime.journal);
            let gate_for_writer = Arc::clone(&sink_impl.emit_gate);
            let journal_writer = tokio::spawn(async move {
                while let Some(entry) = journal_rx.recv().await {
                    let _ = journal_for_writer.enqueue(entry).await;
                    gate_for_writer.finish_journal_write();
                }
            });
            sink_impl.set_turn_context(&conn_id, &turn_id, journal_tx);

            if backups_enabled && session_kind == cowork_storage::SessionKind::Root {
                let bm = Arc::clone(&runtime.backup_manager);
                let tid_bk = thread_id.clone();
                let cwd_bk = canonical_cwd.clone();
                let title_bk = {
                    let l = live_for_task.lock();
                    l.title.clone()
                };
                let prov_bk = provider.as_str().to_owned();
                let model_bk = model_id.clone();
                let _ = tokio::task::spawn_blocking(move || {
                    bm.ensure_initial_backup(
                        &tid_bk,
                        &cwd_bk,
                        Some(title_bk),
                        Some(prov_bk),
                        Some(model_bk),
                    )
                })
                .await;
            }

            let stored_history = {
                let live = live_for_task.lock();
                parse_stored_history(&live.messages, Some(&live.created_at))
            };
            let unmigrated = stored_history.unmigrated_count();
            if unmigrated > 0 {
                runtime.observability.record_session_log(
                    &thread_id,
                    &format!(
                        "{unmigrated} stored message(s) could not be migrated to the canonical format; they are preserved in history but not replayed to the model."
                    ),
                );
            }
            let mut history = stored_history.messages.clone();
            let turn_message_start_index = history.len();

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
            crate::extension_mcp_agent_routes::insert_tool_home_env(
                &mut tool_env,
                &runtime.homedir,
            );

            let approval_bridge: Option<Arc<dyn ApprovalHandler>> =
                Some(Arc::clone(&interactions) as Arc<dyn ApprovalHandler>);
            let thread_bridge: Option<Arc<dyn cowork_tools::ThreadControlBridge>> = (session_kind
                == cowork_storage::SessionKind::Root
                && !in_task_context
                && allow_thread_management_tools)
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

            let live_for_wf = Arc::clone(&live_for_task);
            let sink_for_wf = Arc::clone(&sink);
            let tid_for_wf = thread_id.clone();
            let on_workflow_progress: cowork_tools::WorkflowProgressCallback =
                Arc::new(move |progress: Value| {
                    {
                        let mut live = live_for_wf.lock();
                        cowork_tools::upsert_retained_workflow_run(
                            &mut live.workflow_runs,
                            progress.clone(),
                        );
                    }
                    sink_for_wf.send_notification(
                        "cowork/session/workflowProgress",
                        json!({
                            "type": "workflow_progress",
                            "sessionId": tid_for_wf,
                            "progress": progress,
                        }),
                    );
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
                read_roots,
                yolo: effective_yolo,
                read_only_role: child_restrictions
                    .as_ref()
                    .is_some_and(|r| r.read_only_role),
                target_paths: child_restrictions
                    .as_ref()
                    .and_then(|r| r.target_paths.clone()),
                advanced_memory,
                bundled_skills_dir: bundled_skills_dir.is_dir().then_some(bundled_skills_dir),
                built_in_dir: Some(runtime.built_in_dir.clone()),
                approval_handler: approval_bridge,
                thread_control: thread_bridge,
                agent_control: agent_bridge,
                task_bridge,
                cost_tracker_bridge: None,
                on_workflow_progress: Some(on_workflow_progress),
                in_task_context,
                stop_after_step: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                before_tool_invocation: Some(before_tool_hook),
                agent_config: effective_agent_cfg.map(Arc::new),
                mcp_tool_cache: Some(Arc::clone(&runtime.mcp_tool_cache)),
                can_ask_user: !in_task_context,
                allowed_builtin_tools: child_restrictions
                    .as_ref()
                    .map(|r| r.allowed_builtin_tools.clone()),
                allowed_mcp_servers: child_restrictions
                    .as_ref()
                    .and_then(|r| r.allowed_mcp_servers.clone()),
                allowed_skill_names: child_restrictions
                    .as_ref()
                    .and_then(|r| r.allowed_skill_names.clone()),
                session_db: Some(Arc::clone(&runtime.session_db)),
                memory_store: Some(Arc::new(sqlite_mem.clone())),
                advanced_memory_store: Some(Arc::new(adv_mem.clone())),
                on_todos_updated: Some(on_todos),
                cancel_rx: None,
                dns_override_for_tests: None,
            };

            let initial_continuation = stored_provider_state
                .and_then(|v| serde_json::from_value::<ProviderContinuationState>(v).ok());

            // Install cancellation before the Codex bridge clones `tool_ctx`, so Stop reaches
            // nested tools run through the dynamic-tool bridge.
            runner.install_cancellation(&mut tool_ctx);
            // A failed LM Studio preparation fails the turn like a transport error (TS threw it
            // from model resolution).
            let lmstudio_prepared = match &lmstudio_prepare {
                Some(opts) => {
                    crate::extension_mcp_agent_routes::prepare_lmstudio_model_for_turn(
                        opts, &model_id,
                    )
                    .await
                }
                None => Ok(()),
            };
            let transport_res = lmstudio_prepared.and_then(|()| {
                select_provider_transport_for_turn(
                    provider,
                    bedrock_auth,
                    &runtime.homedir,
                    &runtime.env,
                    Some((
                        &tool_ctx,
                        &interactions,
                        &steer,
                        overflow_threshold,
                        Some(runner.codex_bridge_catalog()),
                    )),
                    Some(&runtime.built_in_dir),
                    tools_disabled,
                )
            });

            match transport_res {
                Ok(transport) => {
                    // Rehydrate and attach the turn's cost tracker in one critical section, so a
                    // concurrent `cowork/session/usageBudget/set` updates either the stored
                    // state read here or the tracker the turn runs with.
                    let shared_cost = {
                        let mut live = live_for_task.lock();
                        let shared = SharedTurnCostTracker::new(rehydrate_session_cost_tracker(
                            &thread_id,
                            live.cost_tracker_snapshot.clone(),
                            live.warn_at_usd,
                            live.stop_at_usd,
                        ));
                        live.active_cost_tracker = Some(shared.clone());
                        shared
                    };
                    let outcome = runner
                        .run_turn_with_shared_cost(
                            Arc::clone(&transport),
                            history,
                            &mut tool_ctx,
                            &interactions,
                            &steer,
                            shared_cost.clone(),
                            initial_continuation.clone(),
                            Arc::clone(&sink),
                        )
                        .await;
                    // Detach under the session lock: budget changes accepted until now are in
                    // this tracker (and so in the final usage events); later ones land on the
                    // stored snapshot written here, which already includes this turn's cost.
                    let (cost_tracker, full_usage_snapshot) = {
                        let mut live = live_for_task.lock();
                        live.active_cost_tracker = None;
                        let tracker = shared_cost.take();
                        let snapshot = tracker.get_snapshot();
                        live.cost_tracker_snapshot = serde_json::to_value(&snapshot).ok();
                        (tracker, snapshot)
                    };

                    let now =
                        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                    let preview = outcome
                        .last_assistant_text
                        .as_deref()
                        .unwrap_or(&effective_display_text)
                        .chars()
                        .take(180)
                        .collect::<String>();
                    let serialized_msgs: Vec<Value> =
                        stored_history.merge_for_persist(&outcome.messages);
                    // A failed turn that never advanced an OpenAI continuation may have failed
                    // because OpenAI rejected that handle (`runUserMessageTurn.ts` clears it
                    // before retrying from the local transcript), so it is not persisted.
                    let stale_openai_continuation = outcome.status == "failed"
                        && matches!(
                            outcome.updated_continuation,
                            Some(ProviderContinuationState::OpenAi { .. })
                        )
                        && outcome.updated_continuation == initial_continuation;
                    let next_provider_state =
                        if outcome.status == "interrupted" || stale_openai_continuation {
                            None
                        } else {
                            outcome
                                .updated_continuation
                                .and_then(|c| serde_json::to_value(c).ok())
                        };
                    emit_turn_usage_notifications(
                        sink.as_ref(),
                        &thread_id,
                        &turn_id,
                        &outcome.usage,
                        &full_usage_snapshot,
                        &cost_tracker,
                    );

                    {
                        let mut live = live_for_task.lock();
                        live.busy = false;
                        live.has_pending_approval = false;
                        live.has_pending_ask = false;
                        live.updated_at = now;
                        live.messages = serialized_msgs.clone();
                        live.message_count = live.messages.len();
                        live.last_message_preview = Some(preview);
                        live.provider_state = next_provider_state;
                    }
                    sink_impl.clear_turn_journal_tx();
                    let _ = journal_writer.await;
                    let _ = runtime
                        .persist_live_session_after_turn(&live_for_task, "turn/completed")
                        .await;
                    // Release the turn only once its history is persisted: a parent-driven
                    // child run (`reserve_child_thread`) and settle waiters key off
                    // `active_turns`, so none of them can read the stored row before it lands.
                    runtime.active_turns.remove(&thread_id);
                    runtime.turn_settled_notify.notify_waiters();
                    sink_impl.flush_deferred_turn_completed();

                    let turn_duration_ms = turn_started_instant.elapsed().as_millis() as u64;
                    runtime.observability.record_server_event(
                        if outcome.status == "completed" {
                            "info"
                        } else {
                            "warn"
                        },
                        "turn.completed",
                        Some(&thread_id),
                        Some(&json!({
                            "turnId": turn_id,
                            "status": outcome.status,
                            "provider": provider.as_str(),
                            "model": model_id,
                            "durationMs": turn_duration_ms,
                        })),
                    );
                    {
                        let mut span_attrs = std::collections::BTreeMap::new();
                        span_attrs.insert(
                            "cowork.session.id".to_owned(),
                            Value::String(thread_id.clone()),
                        );
                        span_attrs
                            .insert("cowork.turn.id".to_owned(), Value::String(turn_id.clone()));
                        span_attrs.insert(
                            "cowork.provider".to_owned(),
                            Value::String(provider.as_str().to_owned()),
                        );
                        span_attrs
                            .insert("cowork.model".to_owned(), Value::String(model_id.clone()));
                        span_attrs.insert(
                            "cowork.turn.status".to_owned(),
                            Value::String(outcome.status.clone()),
                        );
                        sink_impl.emit_turn_span(
                            outcome.status != "completed",
                            turn_duration_ms,
                            span_attrs,
                        );

                        let mut analytics_props = std::collections::BTreeMap::new();
                        analytics_props.insert(
                            "provider".to_owned(),
                            Value::String(provider.as_str().to_owned()),
                        );
                        analytics_props.insert("model".to_owned(), Value::String(model_id.clone()));
                        analytics_props
                            .insert("status".to_owned(), Value::String(outcome.status.clone()));
                        analytics_props
                            .insert("durationMs".to_owned(), Value::from(turn_duration_ms));
                        runtime.observability.capture_product_event(
                            if outcome.status == "completed" {
                                "turn_completed"
                            } else {
                                "turn_failed"
                            },
                            &analytics_props,
                        );
                    }

                    if outcome.status == "completed"
                        && backups_enabled
                        && session_kind == cowork_storage::SessionKind::Root
                    {
                        let bm = Arc::clone(&runtime.backup_manager);
                        let tid_bk = thread_id.clone();
                        let cwd_bk = canonical_cwd.clone();
                        let title_bk = {
                            let l = live_for_task.lock();
                            l.title.clone()
                        };
                        let prov_bk = provider.as_str().to_owned();
                        let model_bk = model_id.clone();
                        if let Ok(Ok(Some(state))) = tokio::task::spawn_blocking(move || {
                            bm.create_checkpoint(
                                &tid_bk,
                                &cwd_bk,
                                cowork_harness::backups::BackupTrigger::Auto,
                                Some(title_bk),
                                Some(prov_bk),
                                Some(model_bk),
                            )
                        })
                        .await
                        {
                            runtime.emit_session_backup_state(
                                &thread_id,
                                Some(&conn_id),
                                "auto_checkpoint",
                                &state,
                            );
                        }
                    }

                    if outcome.status == "completed"
                        && session_kind == cowork_storage::SessionKind::Root
                        && let Some(completed_usage) = collect_completed_turn_skill_usage(
                            &thread_id,
                            &turn_id,
                            &canonical_cwd,
                            &mentioned_skill_names,
                            &available_skills_for_usage,
                            &outcome.messages,
                            turn_message_start_index,
                        )
                    {
                        let _ = runtime
                            .ensure_skill_improvement_service()
                            .record_completed_turn_usage(completed_usage);
                    }

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

                    // Background advanced-memory generation (model-based extraction plus
                    // explicit directives). TS `triggerMemoryGeneration` /
                    // `runMemoryGenerationOnce` are no-ops unless `advancedMemory` is on, so the
                    // gate runs before the memory model is resolved or the transcript leaves the
                    // process. With advanced memory off, explicit "remember" requests go through
                    // the model's `memory` tool into the SQLite store, as in TS.
                    if enable_memory && advanced_memory && outcome.status == "completed" {
                        let live_mem = Arc::clone(&live_for_task);
                        let rt_mem = Arc::clone(&runtime);
                        let tid_mem = thread_id.clone();
                        let mem_model_ref = memory_generation_model_ref(
                            workspace_cfg.as_ref(),
                            provider,
                            &model_id,
                        );
                        let mem_transport = Arc::clone(&transport);
                        let mem_base_url = base_url.clone();
                        let mem_api_key = api_key.clone();
                        let mem_provider_opts = merged_provider_opts.clone();
                        // TS `triggerMemoryGeneration` fixes only the target index when the turn
                        // completes and chains `runMemoryGenerationOnce` onto the per-session
                        // `memoryGenerationQueue`; the cursor is read when the queued run starts,
                        // so back-to-back turns never resend an already-processed range and a
                        // slower earlier run cannot regress a later run's checkpoint. Failures
                        // are swallowed and leave the queue usable. The run stays in the
                        // background, so turn completion never waits on it.
                        tokio::spawn(async move {
                            let _generation = rt_mem.lock_memory_generation(&tid_mem).await;
                            if rt_mem.is_session_deleted(&tid_mem) {
                                return;
                            }
                            let start = live_mem.lock().last_memory_generated_index.unwrap_or(0);
                            // TS `runMemoryGenerationOnce` returns early when nothing is past the
                            // cursor (the generator needs a user + assistant pair); otherwise
                            // `MemoryGenerator.resolveTargetConfig` picks `memoryGenerationModel`,
                            // else the preferred child model, else the thread's own model, so
                            // ordinary history is always model-analyzed.
                            if serialized_msgs.len() < start.saturating_add(2) {
                                return;
                            }
                            let remote_mem_model = match rt_mem
                                .resolve_memory_generation_model(
                                    &mem_model_ref,
                                    CurrentModelConnection {
                                        provider,
                                        transport: &mem_transport,
                                        base_url: &mem_base_url,
                                        api_key: &mem_api_key,
                                    },
                                    &mem_provider_opts,
                                )
                                .await
                            {
                                Ok(model) => model,
                                Err(err) => {
                                    // Leave the cursor so the transcript is retried once the
                                    // model reference resolves.
                                    tracing::warn!(model = %mem_model_ref, error = %err, "memory generation model unavailable; skipping memory generation");
                                    return;
                                }
                            };
                            let generated = MemoryGenerator::new()
                                .maybe_generate_from_transcript(
                                    &serialized_msgs,
                                    start,
                                    Some(&sqlite_mem),
                                    Some(&adv_mem),
                                    Some(remote_mem_model),
                                )
                                .await;
                            let next_idx = match generated {
                                Ok(next_idx) => next_idx,
                                Err(err) => {
                                    tracing::warn!(error = %err, "memory generation failed; transcript cursor not advanced");
                                    return;
                                }
                            };
                            if advance_memory_cursor(&live_mem, next_idx) {
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
                    // `run_turn` never ran, so reject steers accepted during setup the same way
                    // it would on exit (correlated errors), instead of dropping them silently.
                    steer.close_admission();
                    let pending_steers = steer.drain_pending();
                    if !pending_steers.is_empty() {
                        let mut steer_projector = cowork_inference::StreamEventProjector::new(
                            &thread_id,
                            cowork_inference::ClientCapabilities::default(),
                        );
                        for entry in pending_steers {
                            for notif in
                                steer_projector.project(&cowork_inference::StreamEvent::Error {
                                    turn_id: turn_id.clone(),
                                    message: cowork_harness::steer::STEER_REJECTED_TURN_ENDED
                                        .to_owned(),
                                    code: Some("validation_failed".to_owned()),
                                    steer_request_id: Some(entry.request_id),
                                    client_message_id: entry.client_message_id,
                                })
                            {
                                sink.send_notification(&notif.method, notif.params);
                            }
                        }
                    }
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
                    sink_impl.clear_turn_journal_tx();
                    let _ = journal_writer.await;
                    let _ = runtime
                        .persist_live_session_after_turn(&live_for_task, "turn/completed")
                        .await;
                    // Release the turn only once its history is persisted: a parent-driven
                    // child run (`reserve_child_thread`) and settle waiters key off
                    // `active_turns`, so none of them can read the stored row before it lands.
                    runtime.active_turns.remove(&thread_id);
                    runtime.turn_settled_notify.notify_waiters();
                    sink_impl.flush_deferred_turn_completed();
                    let turn_duration_ms = turn_started_instant.elapsed().as_millis() as u64;
                    runtime.observability.record_server_event(
                        "error",
                        "turn.failed",
                        Some(&thread_id),
                        Some(&json!({
                            "turnId": turn_id,
                            "provider": provider.as_str(),
                            "model": model_id,
                            "durationMs": turn_duration_ms,
                            "error": msg,
                        })),
                    );
                    {
                        let mut span_attrs = std::collections::BTreeMap::new();
                        span_attrs.insert(
                            "cowork.session.id".to_owned(),
                            Value::String(thread_id.clone()),
                        );
                        span_attrs
                            .insert("cowork.turn.id".to_owned(), Value::String(turn_id.clone()));
                        span_attrs.insert(
                            "cowork.provider".to_owned(),
                            Value::String(provider.as_str().to_owned()),
                        );
                        span_attrs
                            .insert("cowork.model".to_owned(), Value::String(model_id.clone()));
                        span_attrs.insert(
                            "cowork.turn.status".to_owned(),
                            Value::String("failed".to_owned()),
                        );
                        sink_impl.emit_turn_span(true, turn_duration_ms, span_attrs);

                        let mut analytics_props = std::collections::BTreeMap::new();
                        analytics_props.insert(
                            "provider".to_owned(),
                            Value::String(provider.as_str().to_owned()),
                        );
                        analytics_props.insert("model".to_owned(), Value::String(model_id.clone()));
                        analytics_props
                            .insert("status".to_owned(), Value::String("failed".to_owned()));
                        analytics_props
                            .insert("durationMs".to_owned(), Value::from(turn_duration_ms));
                        runtime
                            .observability
                            .capture_product_event("turn_failed", &analytics_props);
                    }
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
        let extracted = params
            .input
            .extract_payload()
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
        // A subagent turn run by its parent's `AgentControl` executor emits nothing to thread
        // subscribers and has no live session here, so an external steer would be applied
        // silently (text) or fail on the missing session (attachments). Only turns this server
        // runs for the thread (whose interaction manager is the registered one) take steers.
        let server_run_turn = self
            .interaction_managers
            .get(&params.thread_id)
            .is_some_and(|im| Arc::ptr_eq(im.value(), &ctrl.interactions));
        if !server_run_turn {
            return Err(JsonRpcLiteError::new(
                error_codes::INVALID_REQUEST,
                format!(
                    "Thread {} is running a subagent turn driven by its parent agent; turn/steer is not supported for it. Send input through the parent agent instead.",
                    params.thread_id
                ),
            ));
        }

        // Legacy `resolveSteerReferences`: explicit references (then `@` mentions) fold the
        // referenced skills' bodies into the model-facing steer message ahead of its content.
        let references = parse_references_param(params.references.as_deref())?;
        let mentions = ctrl.mention_context.resolve(&extracted.text, &references);
        let reference_context = (!mentions.injected_skill_blocks.is_empty()).then(|| {
            new_text_block(&format!(
                "Reference context for this steer:\n\n{}",
                mentions.injected_skill_blocks.join("\n\n")
            ))
        });
        let references_key = (!references.is_empty()).then(|| {
            references
                .iter()
                .map(|r| {
                    let kind = match r.kind {
                        cowork_harness::TurnReferenceKind::Skill => "skill",
                        cowork_harness::TurnReferenceKind::Plugin => "plugin",
                    };
                    format!("{kind}:{}", r.name)
                })
                .collect::<Vec<_>>()
        });

        if extracted.attachments.is_empty() {
            let Some(reference_block) = reference_context else {
                return ctrl
                    .steer
                    .enqueue_steer(extracted.text, params.client_message_id.clone());
            };
            let dedupe_key = references_key
                .as_ref()
                .and_then(|refs| serde_json::to_string(&(extracted.text.trim(), refs)).ok());
            let content = vec![reference_block, new_text_block(extracted.text.trim())];
            return ctrl.steer.enqueue_steer_with_content(
                extracted.text,
                content,
                dedupe_key,
                params.client_message_id.clone(),
            );
        }

        // Materialize attachments exactly like `turn/start` so the steered user message carries
        // the same media blocks and upload notes.
        let Some((cwd, session_output_dir, session_uploads_dir, provider, model_id)) =
            self.get_live_thread(&params.thread_id).map(|live| {
                let live = live.lock();
                (
                    PathBuf::from(&live.cwd),
                    live.output_directory.clone(),
                    live.uploads_directory.clone(),
                    live.provider,
                    live.model.clone(),
                )
            })
        else {
            return Err(JsonRpcLiteError::new(
                error_codes::INVALID_PARAMS,
                format!("Unknown thread: {}", params.thread_id),
            ));
        };
        let canonical_cwd = canonicalize_sync(&cwd);
        let steer_cfg = self
            .load_workspace_config(&canonical_cwd)
            .ok()
            .map(|mut cfg| {
                apply_session_io_dirs(
                    &mut cfg,
                    session_output_dir.as_deref(),
                    session_uploads_dir.as_deref(),
                );
                cfg
            });
        let (_, uploads_dir) = workspace_io_dirs(steer_cfg.as_ref(), &canonical_cwd);
        let attachment_caps = AttachmentModelCapabilities::resolve(
            self.model_registry(),
            provider,
            &model_id,
            &self.homedir,
            &self.env,
        );
        let materialized = materialize_turn_attachments_for_model(
            &extracted,
            &uploads_dir,
            &canonical_cwd,
            attachment_caps,
        )
        .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m))?;
        let dedupe_key = match &references_key {
            Some(refs) => {
                serde_json::to_string(&(&extracted.text, &extracted.attachments, refs)).ok()
            }
            None => serde_json::to_string(&(&extracted.text, &extracted.attachments)).ok(),
        };
        let mut content = materialized.content_blocks.clone();
        if let Some(reference_block) = reference_context {
            content.insert(0, reference_block);
        }
        let result = ctrl.steer.enqueue_steer_with_content(
            materialized.display_text.clone(),
            content,
            dedupe_key,
            params.client_message_id.clone(),
        );
        let accepted_new = match &result {
            Ok(v) => v.get("replayed") != Some(&Value::Bool(true)),
            Err(_) => false,
        };
        if !accepted_new {
            materialized.rollback();
        }
        result
    }

    pub fn handle_turn_interrupt(
        &self,
        params: &TurnInterruptParams,
    ) -> Result<Value, JsonRpcLiteError> {
        let mut interrupted_children = 0usize;
        // Only an explicit `includeSubagents: true` cancels child agents (legacy
        // `TurnExecutionManager.cancel` parity; omitted means the thread's own turn only).
        if params.include_subagents == Some(true)
            && let Some(agent_ctrl) = self.agent_controls.get(&params.thread_id)
        {
            interrupted_children = agent_ctrl.interrupt_running_children();
        }
        // A reserved turn still in setup has no `active_turns` entry yet: flag it so it ends
        // before its first step. Flag first, then check `active_turns`: `turn/start` installs
        // `active_turns` before it reads the flag, so one of the two always sees this interrupt.
        let interrupted_in_setup = self
            .turn_setup_interrupts
            .get(&params.thread_id)
            .map(|flag| flag.store(true, std::sync::atomic::Ordering::SeqCst))
            .is_some();
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
        Ok(json!({ "interrupted": interrupted_in_setup || interrupted_children > 0 }))
    }
}

fn collect_completed_turn_skill_usage(
    session_id: &str,
    turn_id: &str,
    working_directory: &Path,
    mentioned_skill_names: &[String],
    available_skills: &std::collections::BTreeMap<String, cowork_tools::DiscoveredSkill>,
    messages: &[CanonicalMessage],
    message_start_index: usize,
) -> Option<cowork_harness::skill_improvement::CompletedTurnSkillUsage> {
    if available_skills.is_empty() {
        return None;
    }

    let now_ts = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let mut usages = Vec::new();
    let mut seen = std::collections::BTreeSet::new();

    // Skills injected from explicit `references` or `@` mentions (resolved at turn start).
    for name in mentioned_skill_names {
        let skill = available_skills
            .get(name)
            .or_else(|| available_skills.values().find(|s| &s.name == name));
        if let Some(skill) = skill
            && seen.insert((skill.name.clone(), "at-mention"))
        {
            usages.push(
                cowork_harness::skill_improvement::CompletedTurnSkillUsageInput {
                    skill_name: skill.name.clone(),
                    kind: "reference".to_owned(),
                    source: "at-mention".to_owned(),
                    turn_id: turn_id.to_owned(),
                    used_at: now_ts.clone(),
                    skill_path: Some(skill.skill_md_path.to_string_lossy().into_owned()),
                    skill_source: Some(skill.scope.as_str().to_owned()),
                },
            );
        }
    }

    let start = message_start_index.min(messages.len());
    for msg in &messages[start..] {
        for block in &msg.content {
            let ContentBlock::ToolCall {
                name, arguments, ..
            } = block
            else {
                continue;
            };
            let extracted_skill_name = if name == "skill" {
                arguments
                    .get("name")
                    .or_else(|| arguments.get("skill"))
                    .and_then(Value::as_str)
            } else if name == "toolCall"
                && arguments.get("name").and_then(Value::as_str) == Some("skill")
            {
                arguments
                    .get("arguments")
                    .and_then(|a| a.get("name").or_else(|| a.get("skill")))
                    .and_then(Value::as_str)
            } else {
                None
            };
            let Some(skill_name) = extracted_skill_name
                .map(str::trim)
                .filter(|s| !s.is_empty())
            else {
                continue;
            };
            if let Some(skill) = available_skills.get(skill_name)
                && seen.insert((skill.name.clone(), "skill-tool"))
            {
                usages.push(
                    cowork_harness::skill_improvement::CompletedTurnSkillUsageInput {
                        skill_name: skill.name.clone(),
                        kind: "tool".to_owned(),
                        source: "skill-tool".to_owned(),
                        turn_id: turn_id.to_owned(),
                        used_at: now_ts.clone(),
                        skill_path: Some(skill.skill_md_path.to_string_lossy().into_owned()),
                        skill_source: Some(skill.scope.as_str().to_owned()),
                    },
                );
            }
        }
    }

    if usages.is_empty() {
        return None;
    }

    let mut transcript_lines = Vec::new();
    for msg in &messages[start..] {
        let role_label = match msg.role {
            MessageRole::User => "user",
            MessageRole::Assistant => "assistant",
            MessageRole::Tool => "tool",
            MessageRole::System => "system",
            MessageRole::Developer => "developer",
        };
        for block in &msg.content {
            match block {
                ContentBlock::Text { text, .. } if !text.trim().is_empty() => {
                    transcript_lines.push(format!("[{role_label}] {}", text.trim()));
                }
                ContentBlock::ToolCall {
                    name, arguments, ..
                } => {
                    let args_str = serde_json::to_string(arguments).unwrap_or_default();
                    transcript_lines.push(format!("[tool_call:{name}] {args_str}"));
                }
                ContentBlock::ToolResult {
                    tool_name, content, ..
                } => {
                    let label = tool_name.as_deref().unwrap_or("tool");
                    transcript_lines.push(format!("[tool_result:{label}] {content:?}"));
                }
                _ => {}
            }
        }
    }

    Some(cowork_harness::skill_improvement::CompletedTurnSkillUsage {
        session_id: session_id.to_owned(),
        turn_id: turn_id.to_owned(),
        working_directory: working_directory.to_string_lossy().into_owned(),
        message_start_index: start,
        message_end_index: messages.len(),
        transcript: transcript_lines.join("\n"),
        usages,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_sandbox_restrictions_carry_scoped_read_only_context() {
        let dir = std::env::temp_dir();
        let mut ctx = ToolExecutionContext::new_for_tests(
            dir.clone(),
            dir.clone(),
            ProviderName::CodexCli,
            "m",
        );
        ctx.sandbox_policy = SandboxPolicy::ReadOnly { network: false };
        ctx.read_only_role = true;
        ctx.target_paths = Some(vec![dir.join("src")]);
        let r = codex_sandbox_restrictions(&ctx);
        assert_eq!(r.mode, Some(ConfigSandboxMode::ReadOnly));
        assert_eq!(r.network, Some(false));
        assert_eq!(r.yolo, Some(false));
        assert!(r.read_only_role);
        assert_eq!(r.target_paths, vec![dir.join("src")]);
    }

    /// Imported TS conversations carry Google attachments as legacy
    /// `{ type: "audio" | "video" | "document", data, mimeType }` user parts; they must reach the
    /// model history (not only the raw-preserved storage slots) together with their prompt text.
    #[test]
    fn parse_stored_history_keeps_legacy_google_media_user_messages_in_model_history() {
        use cowork_inference::{MediaKind, MediaSource};

        let cases = [
            ("audio", "audio/wav", MediaKind::Audio),
            ("video", "video/webm", MediaKind::Video),
            ("document", "application/pdf", MediaKind::Document),
        ];
        let stored: Vec<Value> = cases
            .iter()
            .map(|(ty, mime, _)| {
                serde_json::json!({
                    "role": "user",
                    "content": [
                        { "type": "text", "text": format!("describe the {ty}") },
                        { "type": ty, "data": "QUJD", "mimeType": mime }
                    ]
                })
            })
            .collect();

        let history = parse_stored_history(&stored, Some("2026-01-01T00:00:00.000Z"));
        assert_eq!(history.unmigrated_count(), 0);
        assert_eq!(history.messages.len(), 3);
        for (msg, (ty, mime, kind)) in history.messages.iter().zip(cases) {
            assert_eq!(msg.role, MessageRole::User);
            assert_eq!(msg.content.len(), 2, "{ty}: text and media both survive");
            assert!(
                matches!(&msg.content[0], ContentBlock::Text { text, .. } if *text == format!("describe the {ty}"))
            );
            assert_eq!(
                msg.content[1],
                ContentBlock::Media {
                    kind,
                    source: MediaSource::Base64 {
                        mime_type: mime.to_owned(),
                        data: "QUJD".to_owned(),
                    },
                    provider_meta: ProviderOpaqueMeta::default(),
                },
                "{ty}"
            );
        }
    }
}
