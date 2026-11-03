use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock, Weak};
use std::time::{Duration, Instant};

use base64_helper::decode_base64_permissive;
use cowork_config::{
    AgentConfig, ChildModelRoutingMode, LoadConfigOptions, ModelRegistry, ProjectConfigPatch,
    ProviderName, canonicalize_sync, get_ai_coworker_paths, get_one_off_chats_root, is_inside,
    legacy_model_alias, load_config, normalize_child_routing_config, normalize_lexical_path,
    persist_project_config_patch, reconcile_reasoning_provider_options, same_workspace_path,
};
use cowork_protocol::{
    CommandInfo, CreationPreflightParams, CreationPreflightResult, CreationReadinessCheck,
    CreationRepairAction, HarnessContextInput, JsonRpcLiteError, JsonRpcLiteId,
    JsonRpcLiteNotification, JsonRpcLiteOutbound, JsonRpcLiteRequest, JsonRpcThread,
    PersistedJournalEventView, ProjectedTurn, ReplayHealth, RuntimeDiagnosticsDbLocks,
    RuntimeDiagnosticsJournal, RuntimeDiagnosticsPayload, RuntimeDiagnosticsProgress,
    RuntimeDiagnosticsReadResult, RuntimeDiagnosticsSendQueue, RuntimeDiagnosticsStartup,
    RuntimeLibreOfficeCheckResult, RuntimeLibreOfficeSmokeStatus, RuntimeLibreOfficeStatusView,
    ThreadStatus, ThreadTurnProjector, TurnInput, TurnStartParams, error_codes,
};
use cowork_storage::{
    PersistedSessionMutation, PersistedSessionRecord, PersistedSessionSnapshotData,
    PersistedThreadMetadata, PersistedThreadMetadataPatch, SessionDb, SessionKind,
    SessionPersistenceStatus, SessionTitleSource, ThreadJournal, ThreadJournalEventInput,
};
use dashmap::DashMap;
use parking_lot::{Mutex, RwLock};
use regex::Regex;
use serde_json::{Map, Value, json};
use tokio::sync::{Notify, mpsc};
use uuid::Uuid;

use crate::http_desktop::WebDesktopService;
use crate::send_queue::{SendSinkOutcome, SocketSendQueue};
use crate::startup::MobileH3AdminState;

pub const DEFAULT_IDLE_EVICTION_SWEEP_INTERVAL: Duration = Duration::from_secs(60);
pub const DEFAULT_SESSION_IDLE_TIMEOUT: Duration = Duration::from_secs(300);
const THREAD_READ_JOURNAL_BATCH_SIZE: usize = 250;
/// Workspace RPCs whose `cwd` may name a directory that is not a workspace yet.
const UNREGISTERED_WORKSPACE_METHODS: &[&str] = &["cowork/creation/preflight"];
/// TS `MAX_ATTACHMENT_UPLOAD_BASE64_SIZE`: the base64 length of a 100 MB upload.
const MAX_ATTACHMENT_UPLOAD_BASE64_SIZE: usize = (100usize * 1024 * 1024).div_ceil(3) * 4;

/// Turn id of the synthetic leading turn `thread/read` uses for unjournaled seed messages
/// (matches the TS thread-management `readThread` "seed" turn).
const SEED_TURN_ID: &str = "seed";

/// Journal marker recording how many stored messages a thread already had when its first
/// journaled turn started, for threads created without a `thread/started` marker (legacy
/// `sessions/*.json` imports, external conversation imports, sessions persisted before any
/// journaling). `internal/` events are never replayed to clients.
const THREAD_SEED_EVENT: &str = "internal/threadSeed";

/// How many conversation messages precede the journal: `thread.messageCount` from a
/// `thread/started` payload (non-zero for forks, which copy the source's messages without
/// journaling them) or `messageCount` from a [`THREAD_SEED_EVENT`] marker.
fn journal_seed_message_count(event_type: &str, payload: &Value) -> Option<usize> {
    let count = match event_type {
        "thread/started" => payload.pointer("/thread/messageCount"),
        THREAD_SEED_EVENT => payload.get("messageCount"),
        _ => return None,
    };
    count
        .and_then(Value::as_u64)
        .and_then(|n| usize::try_from(n).ok())
}

/// A user/assistant text message from a thread's persisted history.
struct SeedMessage {
    id: String,
    role: &'static str,
    ts: String,
    text: String,
}

/// Persisted user/assistant text messages the journal does not cover.
///
/// Before any journal activity the whole history is shown. Afterwards only the prefix that
/// predates the journal (the `thread/started` `messageCount` of a fork's copied conversation,
/// or the [`THREAD_SEED_EVENT`] count of an imported/pre-journal thread) is kept; later
/// messages are already represented by journal items, so they are never duplicated. Messages
/// are append-only, so that prefix is stable.
fn unjournaled_seed_messages(
    thread_id: &str,
    messages: &[Value],
    seed_message_count: Option<usize>,
    journal_has_items: bool,
    fallback_ts: &str,
) -> Vec<SeedMessage> {
    let seed_len = if journal_has_items {
        seed_message_count.unwrap_or(0).min(messages.len())
    } else {
        messages.len()
    };
    messages[..seed_len]
        .iter()
        .enumerate()
        .filter_map(|(idx, msg)| {
            let role = match msg.get("role").and_then(Value::as_str)? {
                "user" => "user",
                "assistant" => "assistant",
                _ => return None,
            };
            let text = match msg.get("content") {
                Some(Value::String(s)) => s.clone(),
                Some(Value::Array(arr)) => arr
                    .iter()
                    // Reasoning parts (`ContentBlock::Thinking`, legacy `reasoning`) carry the
                    // model's chain of thought, never visible assistant text.
                    .filter(|p| !is_reasoning_part(p))
                    .filter_map(|p| p.get("text").and_then(Value::as_str))
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>()
                    .join("\n"),
                _ => String::new(),
            };
            if text.is_empty() {
                return None;
            }
            let id = msg
                .get("id")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| format!("msg:{thread_id}:{idx}"));
            let ts = msg
                .get("createdAt")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .unwrap_or(fallback_ts)
                .to_owned();
            Some(SeedMessage { id, role, ts, text })
        })
        .collect()
}

fn is_reasoning_part(part: &Value) -> bool {
    matches!(
        part.get("type").and_then(Value::as_str),
        Some("thinking" | "reasoning" | "redacted_thinking" | "redactedThinking")
    )
}

/// Projects seed messages as a completed leading `thread/read` turn of journal-shaped items.
fn seed_projected_turn(seed: Vec<SeedMessage>) -> Option<ProjectedTurn> {
    if seed.is_empty() {
        return None;
    }
    let items = seed
        .into_iter()
        .map(|m| {
            if m.role == "user" {
                json!({
                    "id": m.id,
                    "type": "userMessage",
                    "content": [{ "type": "text", "text": m.text }],
                })
            } else {
                json!({ "id": m.id, "type": "agentMessage", "text": m.text })
            }
        })
        .collect();
    Some(ProjectedTurn {
        id: SEED_TURN_ID.to_owned(),
        status: "completed".to_owned(),
        items,
    })
}

mod base64_helper {
    use data_encoding::{BASE64, BASE64_NOPAD, BASE64URL, BASE64URL_NOPAD};

    pub fn decode_base64_permissive(raw: &str) -> Result<Vec<u8>, String> {
        let trimmed = raw.trim();
        let payload = trimmed
            .split_once(";base64,")
            .map(|(_, b)| b)
            .unwrap_or(trimmed);
        let cleaned: String = payload.chars().filter(|c| !c.is_whitespace()).collect();
        BASE64
            .decode(cleaned.as_bytes())
            .or_else(|_| BASE64_NOPAD.decode(cleaned.as_bytes()))
            .or_else(|_| BASE64URL.decode(cleaned.as_bytes()))
            .or_else(|_| BASE64URL_NOPAD.decode(cleaned.as_bytes()))
            .map_err(|e| format!("Invalid base64 payload: {e}"))
    }
}

/// A root session's model switch, captured under the session lock for the workspace write.
struct RootModelSelection {
    cwd: PathBuf,
    prev_provider: ProviderName,
    prev_model: String,
    provider: ProviderName,
    model: String,
    overrides: Map<String, Value>,
}

/// Serializes a thread's journaled live emissions against `thread/resume`'s replay cut.
///
/// The turn sink journals every notification and server request asynchronously (through the
/// turn's journal writer) and broadcasts it to the thread's subscribers in the same step. Both
/// happen under [`ThreadEmitGate::lock`], and the journal write stays counted in `unpersisted`
/// until it is durable. `thread/resume` takes the lock once `unpersisted` is zero, so every
/// event it has not been sent live is already in the journal slice it reads, and every later
/// event reaches it live because it subscribes before releasing the lock (TS did journal replay
/// and subscribe in one synchronous step).
#[derive(Default)]
pub(crate) struct ThreadEmitGate {
    state: Mutex<ThreadEmitGateState>,
    unpersisted: std::sync::atomic::AtomicUsize,
    persisted: Notify,
}

#[derive(Default)]
pub(crate) struct ThreadEmitGateState {
    /// Server requests already journaled and broadcast that are not resolved yet. A prompt the
    /// interaction manager registered but has not emitted is left for its own live broadcast.
    pub(crate) emitted_requests: HashSet<String>,
}

impl ThreadEmitGate {
    pub(crate) fn lock(&self) -> parking_lot::MutexGuard<'_, ThreadEmitGateState> {
        self.state.lock()
    }

    /// Counts an emitted event whose journal write is not durable yet. Called under
    /// [`Self::lock`] so the resume cut never observes a broadcast without its pending write.
    pub(crate) fn begin_journal_write(&self) {
        self.unpersisted
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }

    pub(crate) fn finish_journal_write(&self) {
        if self
            .unpersisted
            .fetch_sub(1, std::sync::atomic::Ordering::SeqCst)
            == 1
        {
            self.persisted.notify_waiters();
        }
    }

    fn all_persisted(&self) -> bool {
        self.unpersisted.load(std::sync::atomic::Ordering::SeqCst) == 0
    }
}

/// Upper bound on how long `thread/resume` waits for in-flight journal writes before replaying
/// whatever is durable (a stalled journal must not wedge the resume).
const RESUME_JOURNAL_SETTLE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone)]
pub struct LiveSession {
    pub id: String,
    pub session_kind: SessionKind,
    pub parent_session_id: Option<String>,
    pub role: Option<String>,
    pub mode: Option<String>,
    pub depth: Option<i64>,
    pub nickname: Option<String>,
    pub task_type: Option<String>,
    pub target_paths: Option<Vec<String>>,
    pub profile: Option<Value>,
    pub requested_model: Option<String>,
    pub effective_model: Option<String>,
    pub execution_state: Option<cowork_storage::AgentExecutionState>,
    pub sandbox: Option<cowork_config::SandboxConfig>,
    pub cwd: String,
    /// Session `outputDirectory` / `uploadsDirectory` as stored in `sessions.db`: the resolved
    /// workspace config values recorded at creation (`None` when defaulted). Resumed sessions
    /// keep them (`AgentSessionFromPersisted.ts` parity); see `apply_session_io_dirs`.
    pub output_directory: Option<String>,
    pub uploads_directory: Option<String>,
    pub provider: ProviderName,
    pub model: String,
    pub title: String,
    pub title_source: SessionTitleSource,
    pub title_model: Option<String>,
    pub last_message_preview: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub message_count: usize,
    pub last_event_seq: u64,
    pub busy: bool,
    pub has_pending_ask: bool,
    pub has_pending_approval: bool,
    pub enable_mcp: bool,
    pub warn_at_usd: Option<f64>,
    pub stop_at_usd: Option<f64>,
    pub cost_tracker_snapshot: Option<Value>,
    /// Cost tracker shared with the running turn, while one runs. Until that turn ends it, not
    /// `cost_tracker_snapshot`, is the session's usage and budget state, so budget changes
    /// govern the turn's remaining steps (TS parity: one tracker per session).
    pub active_cost_tracker: Option<cowork_harness::SharedTurnCostTracker>,
    pub provider_state: Option<Value>,
    pub todos: Vec<Value>,
    pub workflow_runs: Vec<Value>,
    pub last_memory_generated_index: Option<usize>,
    pub requested_reasoning_effort: Option<String>,
    pub effective_reasoning_effort: Option<String>,
    pub harness_context: Option<Value>,
    pub config_overrides: Map<String, Value>,
    pub messages: Vec<Value>,
    /// The stored system prompt of a non-root (child agent) session, carried so metadata
    /// persists (title, model, config, ...) write it back unchanged. Always empty for root
    /// sessions, which rebuild their prompt every turn (`AgentSessionFromPersisted.ts`
    /// `regenerateRootSystemPrompt` parity); a child's role/profile prompt plus any spawn-time
    /// `systemPromptSuffix` cannot be rebuilt, so `AgentControl` restores it from this column.
    pub system_prompt: String,
    pub subscribers: HashSet<String>,
    pub idle_since: Option<Instant>,
    /// Durable lifecycle status (`sessions.status`). Hydration keeps the stored value so
    /// metadata persists never reopen a closed child agent; only an explicit
    /// `AgentControl::resume` or a direct user turn (`runUserMessageTurn.ts` parity) reopens it.
    pub persistence_status: SessionPersistenceStatus,
    /// `sessions.last_event_seq` as of this cache's last read or write of the row. A larger
    /// stored value means another writer (the parent's `AgentControl`, for a child) committed
    /// since; only then is the child's run state taken from the row.
    pub stored_seq: u64,
}

impl LiveSession {
    pub(crate) fn effective_session_usage_snapshot(&self) -> Option<Value> {
        let current = match &self.active_cost_tracker {
            Some(active) => active.with_tracker(|t| serde_json::to_value(t.get_snapshot()).ok()),
            None => self.cost_tracker_snapshot.clone(),
        };
        if let Some(snap) =
            current.and_then(|snap| with_session_budget(snap, self.warn_at_usd, self.stop_at_usd))
        {
            return Some(snap);
        }

        if self.warn_at_usd.is_some() || self.stop_at_usd.is_some() {
            let tracker = cowork_inference::SessionCostTracker::new(
                self.id.clone(),
                Some(cowork_inference::BudgetThresholds {
                    warn_at_usd: self.warn_at_usd,
                    stop_at_usd: self.stop_at_usd,
                }),
            );
            return serde_json::to_value(tracker.get_snapshot()).ok();
        }

        None
    }

    pub(crate) fn to_snapshot_data(&self) -> PersistedSessionSnapshotData {
        PersistedSessionSnapshotData {
            session_kind: self.session_kind,
            parent_session_id: self.parent_session_id.clone(),
            role: self.role.clone(),
            mode: self.mode.clone(),
            depth: self.depth,
            nickname: self.nickname.clone(),
            task_type: self.task_type.clone(),
            target_paths: self.target_paths.clone(),
            profile: self.profile.clone(),
            requested_model: self
                .requested_model
                .clone()
                .or_else(|| Some(self.model.clone())),
            effective_model: self
                .effective_model
                .clone()
                .or_else(|| Some(self.model.clone())),
            requested_reasoning_effort: self.requested_reasoning_effort.clone(),
            effective_reasoning_effort: self.effective_reasoning_effort.clone(),
            execution_state: self.execution_state,
            last_message_preview: self.last_message_preview.clone(),
            title: self.title.clone(),
            title_source: self.title_source,
            title_model: self.title_model.clone(),
            provider: self.provider,
            model: self.model.clone(),
            working_directory: self.cwd.clone(),
            output_directory: self.output_directory.clone(),
            uploads_directory: self.uploads_directory.clone(),
            provider_options: self.config_overrides.get("providerOptions").cloned(),
            sandbox: self.sandbox.clone(),
            enable_mcp: self.enable_mcp,
            backups_enabled_override: self
                .config_overrides
                .get("backupsEnabled")
                .and_then(Value::as_bool),
            created_at: self.created_at.clone(),
            updated_at: self.updated_at.clone(),
            status: self.persistence_status,
            has_pending_ask: self.has_pending_ask,
            has_pending_approval: self.has_pending_approval,
            system_prompt: self.system_prompt.clone(),
            messages: self.messages.clone(),
            last_memory_generated_index: self.last_memory_generated_index,
            provider_state: self.provider_state.clone(),
            todos: self.todos.clone(),
            harness_context: self.harness_context.clone(),
            cost_tracker: self.effective_session_usage_snapshot(),
        }
    }

    /// The thread's stored `providerOptions` override, with endpoint, header and credential
    /// overrides removed (only `lmstudio.baseUrl` survives).
    ///
    /// SECURITY BOUNDARY: every consumer that turns session overrides into a provider request
    /// reads them through this accessor, so an override persisted before client-side filtering
    /// (or injected through any other path) can never send the saved API key to a
    /// client-chosen URL.
    pub(crate) fn provider_options_override(&self) -> Option<Map<String, Value>> {
        let mut po = self
            .config_overrides
            .get("providerOptions")?
            .as_object()?
            .clone();
        cowork_config::strip_provider_option_endpoints(&mut po);
        Some(po)
    }

    /// Takes over the child-agent state a reconciled persist wrote from the stored row (see
    /// [`adopt_stored_child_agent_state`]), so this cache matches `sessions.db` again.
    fn adopt_child_agent_state(
        &mut self,
        written: &PersistedSessionSnapshotData,
        stored_usage: Option<Value>,
    ) {
        self.messages = written.messages.clone();
        self.message_count = self.messages.len();
        self.persistence_status = written.status;
        self.execution_state = written.execution_state;
        self.last_message_preview = written.last_message_preview.clone();
        self.provider_state = written.provider_state.clone();
        if let Some(usage) = stored_usage
            && self.active_cost_tracker.is_none()
        {
            self.cost_tracker_snapshot = Some(usage);
        }
    }

    /// Refreshes a child agent's run state from its stored row before this server runs a turn
    /// on it, when another writer (the parent's `AgentControl` running a follow-up) committed
    /// since this cache last saw the row; the turn then starts from the newest transcript.
    pub(crate) fn refresh_child_run_state(&mut self, stored: &PersistedSessionRecord) {
        if stored.last_event_seq <= self.stored_seq {
            return;
        }
        self.messages = stored.messages.clone();
        self.message_count = self.messages.len();
        self.persistence_status = stored.status;
        self.execution_state = stored.execution_state;
        self.last_message_preview = stored.last_message_preview.clone();
        // The continuation handle belongs to the transcript it was saved with (a Codex CLI
        // thread id carries no fingerprint guarding it against a changed transcript).
        self.provider_state = stored.provider_state.clone();
        if self.active_cost_tracker.is_none()
            && let Some(usage) = stored
                .cost_tracker
                .clone()
                .and_then(stored_session_usage_snapshot)
        {
            self.cost_tracker_snapshot = Some(usage);
        }
        self.stored_seq = stored.last_event_seq;
    }

    pub(crate) fn from_persisted(record: PersistedSessionRecord) -> Self {
        let warn_at_usd = record
            .cost_tracker
            .as_ref()
            .and_then(|c| {
                c.pointer("/budgetStatus/warnAtUsd")
                    .or_else(|| c.get("warnAtUsd"))
            })
            .and_then(Value::as_f64);
        let stop_at_usd = record
            .cost_tracker
            .as_ref()
            .and_then(|c| {
                c.pointer("/budgetStatus/stopAtUsd")
                    .or_else(|| c.get("stopAtUsd"))
            })
            .and_then(Value::as_f64);
        let cost_tracker_snapshot = record.cost_tracker.and_then(stored_session_usage_snapshot);
        // Legacy model alias migration (`AgentSessionFromPersisted.ts` parity): resume on the
        // aliased model and drop continuation state that belongs to the old model id.
        let (model, provider_state) = match legacy_model_alias(record.provider, &record.model)
            .filter(|alias| {
                !record.provider.is_runtime_discovery_provider() && *alias != record.model.trim()
            }) {
            Some(alias) => (alias.to_owned(), None),
            None => (record.model, record.provider_state),
        };
        let mut config_overrides = Map::new();
        // SECURITY BOUNDARY: a stored override may predate client-side filtering; never let
        // it redirect provider endpoints, headers or credentials after a resume.
        if let Some(Value::Object(mut po)) = record.provider_options {
            cowork_config::strip_provider_option_endpoints(&mut po);
            config_overrides.insert("providerOptions".to_owned(), Value::Object(po));
        }
        if let Some(b) = record.backups_enabled_override {
            config_overrides.insert("backupsEnabled".to_owned(), Value::Bool(b));
        }
        Self {
            id: record.session_id,
            session_kind: record.session_kind,
            parent_session_id: record.parent_session_id,
            role: record.role,
            mode: record.mode,
            depth: record.depth,
            nickname: record.nickname,
            task_type: record.task_type,
            target_paths: record.target_paths,
            profile: record.profile,
            requested_model: record.requested_model,
            effective_model: record.effective_model,
            execution_state: record.execution_state,
            sandbox: record.sandbox,
            cwd: record.working_directory,
            output_directory: record.output_directory,
            uploads_directory: record.uploads_directory,
            provider: record.provider,
            model,
            title: record.title,
            title_source: record.title_source,
            title_model: record.title_model,
            last_message_preview: record.last_message_preview,
            created_at: record.created_at,
            updated_at: record.updated_at,
            message_count: record.message_count,
            last_event_seq: record.last_event_seq,
            busy: false,
            has_pending_ask: record.has_pending_ask,
            has_pending_approval: record.has_pending_approval,
            enable_mcp: record.enable_mcp,
            warn_at_usd,
            stop_at_usd,
            cost_tracker_snapshot,
            active_cost_tracker: None,
            provider_state,
            todos: record.todos,
            workflow_runs: Vec::new(),
            last_memory_generated_index: record.last_memory_generated_index,
            requested_reasoning_effort: record.requested_reasoning_effort,
            effective_reasoning_effort: record.effective_reasoning_effort,
            harness_context: record.harness_context,
            config_overrides,
            messages: record.messages,
            system_prompt: if record.session_kind == SessionKind::Root {
                String::new()
            } else {
                record.system_prompt
            },
            subscribers: HashSet::new(),
            idle_since: Some(Instant::now()),
            persistence_status: record.status,
            stored_seq: record.last_event_seq,
        }
    }
}

/// A stored session usage snapshot in the shape the session cost tracker restores from (it has
/// a `sessionId` and a `budgetStatus`), without the legacy top-level budget keys.
fn stored_session_usage_snapshot(mut usage: Value) -> Option<Value> {
    if usage.get("sessionId").and_then(Value::as_str).is_none()
        || usage
            .get("budgetStatus")
            .and_then(Value::as_object)
            .is_none()
    {
        return None;
    }
    if let Some(obj) = usage.as_object_mut() {
        obj.remove("warnAtUsd");
        obj.remove("stopAtUsd");
    }
    Some(usage)
}

/// `usage` (a cost tracker snapshot) with the session's budget thresholds as its
/// `budgetStatus`; `None` when `usage` is not a restorable snapshot.
fn with_session_budget(
    usage: Value,
    warn_at_usd: Option<f64>,
    stop_at_usd: Option<f64>,
) -> Option<Value> {
    let mut usage = stored_session_usage_snapshot(usage)?;
    if let Some(bs) = usage.get_mut("budgetStatus").and_then(Value::as_object_mut) {
        bs.insert("warnAtUsd".to_owned(), json!(warn_at_usd));
        bs.insert("stopAtUsd".to_owned(), json!(stop_at_usd));
        bs.insert(
            "configured".to_owned(),
            json!(warn_at_usd.is_some() || stop_at_usd.is_some()),
        );
    }
    Some(usage)
}

/// Reconciles a child agent's snapshot against its stored row before a write that does not
/// own the child's run state. The parent's `AgentControl` runs the child's turns and closes or
/// resumes it, persisting the transcript, lifecycle status, execution state, preview and usage
/// directly; the server's `LiveSession` copy of those is only a cache. Keeping the stored values
/// means a metadata update never rolls back a later follow-up turn and never reopens a closed
/// child. Nothing is adopted unless the row moved past `known_seq` (the cache's
/// [`LiveSession::stored_seq`]): when it did not, the cache is at least as new, e.g. a direct
/// turn that finished but is not yet persisted. Returns the adopted usage snapshot (without the
/// session budget, which the server owns and overlays here).
fn adopt_stored_child_agent_state(
    stored: Option<&PersistedSessionRecord>,
    snap: &mut PersistedSessionSnapshotData,
    known_seq: u64,
    warn_at_usd: Option<f64>,
    stop_at_usd: Option<f64>,
) -> Option<Value> {
    let stored = stored.filter(|stored| stored.last_event_seq > known_seq)?;
    snap.messages = stored.messages.clone();
    snap.status = stored.status;
    snap.execution_state = stored.execution_state;
    snap.last_message_preview = stored.last_message_preview.clone();
    // The provider continuation handle belongs to whichever transcript it was saved with.
    snap.provider_state = stored.provider_state.clone();
    let usage = stored
        .cost_tracker
        .clone()
        .and_then(stored_session_usage_snapshot)?;
    snap.cost_tracker = with_session_budget(usage.clone(), warn_at_usd, stop_at_usd);
    Some(usage)
}

pub(crate) type SkillImprovementHandle = (
    Arc<cowork_harness::skill_improvement::SkillImprovementService>,
    Option<tokio::task::JoinHandle<()>>,
);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ConnectionAccessFlags {
    pub workspace_control_events_allowed: bool,
    pub task_read_allowed: bool,
    pub task_mutation_allowed: bool,
}

impl Default for ConnectionAccessFlags {
    fn default() -> Self {
        Self {
            workspace_control_events_allowed: true,
            task_read_allowed: true,
            task_mutation_allowed: true,
        }
    }
}

pub struct ServerRuntimeState {
    pub working_directory: PathBuf,
    pub homedir: PathBuf,
    pub built_in_dir: PathBuf,
    pub env: HashMap<String, String>,
    pub yolo: bool,
    pub started_at: Instant,
    pub session_db: Arc<SessionDb>,
    pub journal: Arc<ThreadJournal>,
    pub send_queue: Arc<SocketSendQueue>,
    pub desktop_service: Option<Arc<WebDesktopService>>,
    pub mobile_h3: RwLock<Option<Arc<MobileH3AdminState>>>,
    pub browser_access_token: Option<String>,
    pub network_exposed_listener: bool,
    pub max_pending_requests: usize,
    pub sandbox_manager: cowork_sandbox::SandboxManager,
    pub soffice_runner: Arc<cowork_env::SofficeRunner>,
    pub worktree_service: Arc<cowork_tools::WorktreeService>,
    pub mcp_tool_cache: Arc<cowork_mcp::WorkspaceMcpToolCache>,
    pub artifact_store: Arc<cowork_storage::ArtifactVersionStore>,
    pub task_coordinator: Arc<cowork_harness::tasks::TaskCoordinator>,
    pub task_subscribers: Arc<crate::task_routes::WorkspaceTaskSubscribers>,
    pub canvas_documents: Arc<cowork_harness::canvas::CanvasDocumentPersistenceService>,
    pub backup_manager: Arc<cowork_harness::backups::WorkspaceBackupManager>,
    pub observability: Arc<crate::observability::ServerObservability>,
    pub(crate) workspace_list_revision: std::sync::atomic::AtomicU64,
    pub(crate) skill_improvement: Mutex<Option<SkillImprovementHandle>>,
    pub(crate) task_notif_runtime: Arc<Mutex<Option<Weak<ServerRuntimeState>>>>,
    pub(crate) turn_settled_notify: Arc<Notify>,
    pub(crate) skill_mutation_bus: Mutex<Option<Arc<cowork_harness::SkillMutationBus>>>,
    pub(crate) skill_watcher_seq: std::sync::atomic::AtomicU64,
    pub(crate) agent_controls: DashMap<String, Arc<cowork_harness::AgentControl>>,
    runtime_env_overlay: RwLock<HashMap<String, String>>,
    pub(crate) runtime_trusted_keys: RwLock<cowork_env::TrustedKeyRing>,
    runtime_lease: Mutex<Option<cowork_env::RuntimeConsumerLease>>,
    startup_state: Mutex<RuntimeDiagnosticsStartup>,
    startup_notify: Arc<Notify>,
    bootstrap_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    pub(crate) oauth_manager: Arc<cowork_providers::PkceOAuthManager>,
    pub(crate) oauth_challenges_by_provider: DashMap<(ProviderName, String), String>,
    pub(crate) codex_pool: Arc<cowork_providers::codex_app_server::CodexAppServerPool>,
    pub(crate) pending_codex_logins:
        DashMap<(ProviderName, String), crate::provider_routes::PendingCodexLogin>,
    pub(crate) active_turns: DashMap<String, crate::turn_runner::ActiveTurnControl>,
    /// Sessions deleted (or being deleted) by `cowork/session/delete`. Session ids are never
    /// reused, so a tombstone makes late writers (a cancelled turn's final persist, title or
    /// memory jobs) no-ops instead of resurrecting the deleted rows.
    pub(crate) deleted_sessions: DashMap<String, ()>,
    /// Per-thread advanced-memory generation queue (TS `AgentSession.memoryGenerationQueue`).
    /// An entry exists only while a generation holds or waits on it; the last guard to release
    /// removes it (see `MemoryGenerationGuard`).
    pub(crate) memory_generation_locks: DashMap<String, Arc<tokio::sync::Mutex<()>>>,
    pub(crate) interaction_managers: DashMap<String, Arc<cowork_harness::InteractionManager>>,
    /// Serializes each session's `persist_live_session` writes.
    pub(crate) session_persist_locks: DashMap<String, Arc<tokio::sync::Mutex<()>>>,
    /// Per-thread emission/resume cut (see [`ThreadEmitGate`]).
    pub(crate) thread_emit_gates: DashMap<String, Arc<ThreadEmitGate>>,
    pub(crate) idempotency_ledgers: DashMap<String, Arc<cowork_harness::TurnIdempotencyLedger>>,
    pub(crate) sessions: DashMap<String, Arc<Mutex<LiveSession>>>,
    pub(crate) creation_keys: DashMap<String, String>,
    pub(crate) ws_sinks: DashMap<String, mpsc::Sender<String>>,
    pub(crate) connection_access: DashMap<String, ConnectionAccessFlags>,
    pub(crate) workspace_state_ids: DashMap<String, String>,
    pub(crate) workspace_subscribers: DashMap<String, HashSet<String>>,
    model_registry: OnceLock<ModelRegistry>,
}

impl ServerRuntimeState {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        working_directory: PathBuf,
        homedir: PathBuf,
        built_in_dir: PathBuf,
        env: HashMap<String, String>,
        yolo: bool,
        session_db: Arc<SessionDb>,
        journal: Arc<ThreadJournal>,
        desktop_service: Option<Arc<WebDesktopService>>,
        mobile_h3: Option<Arc<MobileH3AdminState>>,
        browser_access_token: Option<String>,
        network_exposed_listener: bool,
        max_pending_requests: usize,
    ) -> Self {
        let sandbox_manager = cowork_sandbox::SandboxManager::with_cache(Arc::new(
            cowork_sandbox::WorkspaceProtectedPathsCache::new(),
        ));
        let soffice_runner = Arc::new(cowork_env::SofficeRunner::new(
            cowork_env::SofficeRunnerConfig {
                max_concurrent: 2,
                default_timeout: Duration::from_secs(30),
                sandbox_manager: sandbox_manager.clone(),
                homedir: homedir.clone(),
            },
        ));
        let runtime_disabled = matches!(
            env.get("COWORK_DISABLE_RUNTIME")
                .map(|s| s.trim().to_ascii_lowercase())
                .as_deref(),
            Some("1" | "true" | "yes" | "on")
        );
        let ai_paths = get_ai_coworker_paths(Some(&homedir), &env);
        let artifact_store = Arc::new(cowork_storage::ArtifactVersionStore::new(
            cowork_storage::ArtifactVersionStoreOptions {
                root_dir: Some(ai_paths.root_dir.join("artifacts")),
                homedir: Some(homedir.clone()),
            },
        ));
        let task_subscribers = Arc::new(crate::task_routes::WorkspaceTaskSubscribers::new());
        let task_notif_runtime: Arc<Mutex<Option<Weak<ServerRuntimeState>>>> =
            Arc::new(Mutex::new(None));
        let subs_for_sink = Arc::clone(&task_subscribers);
        let rt_slot_for_sink = Arc::clone(&task_notif_runtime);
        let task_notify: cowork_harness::tasks::TaskNotificationSink = Arc::new(move |notif| {
            let weak_opt = rt_slot_for_sink.lock().clone();
            if let Some(rt) = weak_opt.and_then(|w| w.upgrade()) {
                subs_for_sink.notify(&rt, notif);
            }
        });
        let task_coordinator = cowork_harness::tasks::TaskCoordinator::new(
            cowork_harness::tasks::TaskCoordinatorOptions {
                session_db: Arc::clone(&session_db),
                notify: Some(task_notify),
                artifact_store: Some(Arc::clone(&artifact_store)),
                quiesce_task_threads: None,
            },
        )
        .expect("TaskCoordinator::new is infallible with explicit artifact_store");
        let worktree_service = Arc::new(cowork_tools::WorktreeService::with_cowork_home(
            ai_paths.root_dir.clone(),
            env.clone(),
        ));
        let canvas_documents = Arc::new(
            cowork_harness::canvas::CanvasDocumentPersistenceService::new(
                ai_paths.root_dir.clone(),
            ),
        );
        let fallback_backup_tmp = env
            .get("TMPDIR")
            .or_else(|| env.get("TMP"))
            .or_else(|| env.get("TEMP"))
            .map(PathBuf::from)
            .unwrap_or_else(|| ai_paths.root_dir.join("tmp"))
            .join("cowork-session-backups");
        let backup_manager = Arc::new(
            cowork_harness::backups::WorkspaceBackupManager::with_fallback_root(
                ai_paths.root_dir.clone(),
                fallback_backup_tmp,
            ),
        );
        let initial_cfg = {
            let mut cfg_env = env.clone();
            cfg_env.insert(
                "AGENT_WORKING_DIR".to_owned(),
                working_directory.to_string_lossy().into_owned(),
            );
            load_config(LoadConfigOptions {
                cwd: Some(working_directory.clone()),
                homedir: Some(homedir.clone()),
                built_in_dir: Some(built_in_dir.clone()),
                env: Some(cfg_env),
            })
            .ok()
        };
        let observability = Arc::new(crate::observability::ServerObservability::new(
            &ai_paths.root_dir,
            &homedir,
            &working_directory,
            &env,
            initial_cfg.as_ref(),
        ));
        observability.record_server_event(
            "info",
            "server.started",
            None,
            Some(&json!({
                "yolo": yolo,
                "networkExposed": network_exposed_listener,
            })),
        );
        {
            let mut props = std::collections::BTreeMap::new();
            props.insert("status".to_owned(), Value::String("ready".to_owned()));
            props.insert("yoloEnabled".to_owned(), Value::Bool(yolo));
            observability.capture_product_event("workspace_server_started", &props);
        }
        Self {
            working_directory,
            homedir,
            built_in_dir,
            env,
            yolo,
            started_at: Instant::now(),
            session_db,
            journal,
            send_queue: Arc::new(SocketSendQueue::default()),
            desktop_service,
            mobile_h3: RwLock::new(mobile_h3),
            browser_access_token,
            network_exposed_listener,
            max_pending_requests,
            sandbox_manager,
            soffice_runner,
            worktree_service,
            mcp_tool_cache: Arc::new(cowork_mcp::WorkspaceMcpToolCache::new()),
            artifact_store,
            task_coordinator,
            task_subscribers,
            canvas_documents,
            backup_manager,
            observability,
            workspace_list_revision: std::sync::atomic::AtomicU64::new(0),
            skill_improvement: Mutex::new(None),
            task_notif_runtime,
            turn_settled_notify: Arc::new(Notify::new()),
            skill_mutation_bus: Mutex::new(None),
            skill_watcher_seq: std::sync::atomic::AtomicU64::new(0),
            agent_controls: DashMap::new(),
            runtime_env_overlay: RwLock::new(HashMap::new()),
            runtime_trusted_keys: RwLock::new(cowork_env::TrustedKeyRing::with_official_defaults()),
            runtime_lease: Mutex::new(None),
            startup_state: Mutex::new(RuntimeDiagnosticsStartup {
                ready: runtime_disabled,
                error: None,
                progress: None,
            }),
            startup_notify: Arc::new(Notify::new()),
            bootstrap_task: Mutex::new(None),
            oauth_manager: Arc::new(cowork_providers::PkceOAuthManager::new()),
            oauth_challenges_by_provider: DashMap::new(),
            codex_pool: Arc::new(cowork_providers::codex_app_server::CodexAppServerPool::new()),
            pending_codex_logins: DashMap::new(),
            active_turns: DashMap::new(),
            deleted_sessions: DashMap::new(),
            memory_generation_locks: DashMap::new(),
            interaction_managers: DashMap::new(),
            thread_emit_gates: DashMap::new(),
            session_persist_locks: DashMap::new(),
            idempotency_ledgers: DashMap::new(),
            sessions: DashMap::new(),
            creation_keys: DashMap::new(),
            ws_sinks: DashMap::new(),
            connection_access: DashMap::new(),
            workspace_state_ids: DashMap::new(),
            workspace_subscribers: DashMap::new(),
            model_registry: OnceLock::new(),
        }
    }

    pub fn active_session_count(&self) -> usize {
        self.sessions.len()
    }

    pub fn model_registry(&self) -> &ModelRegistry {
        self.model_registry
            .get_or_init(|| ModelRegistry::load_from_builtin_dir(&self.built_in_dir))
    }

    pub fn load_workspace_config(&self, cwd: &Path) -> anyhow::Result<AgentConfig> {
        let mut env = self.env.clone();
        env.insert(
            "AGENT_WORKING_DIR".to_owned(),
            cwd.to_string_lossy().into_owned(),
        );
        Ok(load_config(LoadConfigOptions {
            cwd: Some(cwd.to_path_buf()),
            homedir: Some(self.homedir.clone()),
            built_in_dir: Some(self.built_in_dir.clone()),
            env: Some(env),
        })?)
    }

    pub fn register_ws_sink(&self, connection_id: &str, tx: mpsc::Sender<String>) {
        self.ws_sinks.insert(connection_id.to_owned(), tx);
    }

    pub fn set_mobile_h3(&self, mobile_h3: Option<Arc<MobileH3AdminState>>) {
        *self.mobile_h3.write() = mobile_h3;
    }

    pub fn mobile_h3(&self) -> Option<Arc<MobileH3AdminState>> {
        self.mobile_h3.read().clone()
    }

    pub fn set_connection_access(&self, connection_id: &str, flags: ConnectionAccessFlags) {
        self.connection_access
            .insert(connection_id.to_owned(), flags);
        if !flags.workspace_control_events_allowed {
            for mut entry in self.workspace_subscribers.iter_mut() {
                entry.value_mut().remove(connection_id);
            }
        }
    }

    pub fn is_workspace_control_events_allowed(&self, connection_id: &str) -> bool {
        self.connection_access
            .get(connection_id)
            .map(|r| r.value().workspace_control_events_allowed)
            .unwrap_or(true)
    }

    pub fn is_task_read_allowed(&self, connection_id: &str) -> bool {
        self.connection_access
            .get(connection_id)
            .map(|r| r.value().task_read_allowed)
            .unwrap_or(true)
    }

    pub fn remove_connection(&self, connection_id: &str) {
        self.ws_sinks.remove(connection_id);
        self.connection_access.remove(connection_id);
        self.send_queue.remove_connection(connection_id);
        self.task_subscribers.remove_connection(connection_id);
        for mut entry in self.workspace_subscribers.iter_mut() {
            entry.value_mut().remove(connection_id);
        }
        let now = Instant::now();
        for entry in self.sessions.iter() {
            let mut live = entry.value().lock();
            if live.subscribers.remove(connection_id) && live.subscribers.is_empty() {
                live.idle_since = Some(now);
            }
        }
    }

    pub fn send_to_connection(&self, connection_id: &str, outbound: &JsonRpcLiteOutbound) {
        let Ok(payload) = serde_json::to_value(outbound) else {
            return;
        };
        self.send_value_to_connection(connection_id, &payload);
    }

    pub(crate) fn broadcast_to_thread(
        &self,
        thread_id: &str,
        fallback_connection_id: Option<&str>,
        outbound: &JsonRpcLiteOutbound,
    ) {
        let Ok(payload) = serde_json::to_value(outbound) else {
            return;
        };
        let mut recipients: Vec<String> = self
            .get_live_thread(thread_id)
            .map(|arc| arc.lock().subscribers.iter().cloned().collect())
            .unwrap_or_default();
        if let Some(fb) = fallback_connection_id
            && !recipients.iter().any(|c| c == fb)
        {
            recipients.push(fb.to_owned());
        }
        for cid in recipients {
            self.send_value_to_connection(&cid, &payload);
        }
    }

    pub fn broadcast_to_all(&self, outbound: &JsonRpcLiteOutbound) {
        let Ok(payload) = serde_json::to_value(outbound) else {
            return;
        };
        let cids: Vec<String> = self.ws_sinks.iter().map(|r| r.key().clone()).collect();
        for cid in cids {
            self.send_value_to_connection(&cid, &payload);
        }
    }

    pub fn broadcast_workspace_list_changed(&self) {
        let rev = self
            .workspace_list_revision
            .fetch_add(1, std::sync::atomic::Ordering::AcqRel)
            + 1;
        let outbound = JsonRpcLiteOutbound::Notification(JsonRpcLiteNotification {
            method: "workspace/listChanged".to_owned(),
            params: Some(json!({ "revision": rev })),
        });
        self.broadcast_to_all(&outbound);
    }

    pub(crate) fn emit_session_backup_state(
        &self,
        thread_id: &str,
        fallback_conn_id: Option<&str>,
        reason: &str,
        backup: &cowork_harness::backups::SessionBackupPublicState,
    ) {
        let evt = cowork_harness::backups::SessionBackupStateEvent {
            event_type: "session_backup_state".to_owned(),
            session_id: thread_id.to_owned(),
            reason: reason.to_owned(),
            backup: backup.clone(),
        };
        if let Ok(val) = serde_json::to_value(&evt) {
            let outbound = JsonRpcLiteOutbound::Notification(JsonRpcLiteNotification {
                method: "cowork/session/backupState".to_owned(),
                params: Some(val),
            });
            self.broadcast_to_thread(thread_id, fallback_conn_id, &outbound);
        }
    }

    pub fn send_value_to_connection(&self, connection_id: &str, payload: &Value) {
        let Some(tx) = self.ws_sinks.get(connection_id).map(|r| r.value().clone()) else {
            return;
        };
        self.send_queue.send(connection_id, payload, |serialized| {
            match tx.try_send(serialized.to_owned()) {
                Ok(()) => SendSinkOutcome::Accepted,
                Err(mpsc::error::TrySendError::Full(_)) => SendSinkOutcome::Backpressured,
                Err(mpsc::error::TrySendError::Closed(_)) => SendSinkOutcome::Closed,
            }
        });
    }

    pub fn flush_connection_queue(&self, connection_id: &str) {
        let Some(tx) = self.ws_sinks.get(connection_id).map(|r| r.value().clone()) else {
            self.send_queue.remove_connection(connection_id);
            return;
        };
        self.send_queue.flush(connection_id, |serialized| {
            match tx.try_send(serialized.to_owned()) {
                Ok(()) => SendSinkOutcome::Accepted,
                Err(mpsc::error::TrySendError::Full(_)) => SendSinkOutcome::Backpressured,
                Err(mpsc::error::TrySendError::Closed(_)) => SendSinkOutcome::Closed,
            }
        });
    }

    /// Resolves and validates `cwd` for JSON-RPC methods (`requireWorkspacePath` parity).
    pub fn resolve_workspace_path(
        &self,
        raw_cwd: Option<&str>,
        method: &str,
    ) -> Result<PathBuf, String> {
        let fallback = canonicalize_sync(&self.working_directory);
        let Some(raw) = raw_cwd.map(str::trim).filter(|s| !s.is_empty()) else {
            return Ok(fallback);
        };
        // `task/*` (`shared.ts` `requireWorkspacePath` parity): an explicit cwd must be an
        // absolute, canonical path equal to the server workspace. Desktop-registered project
        // workspaces are authorized separately by `resolve_project_task_workspace`.
        if method.starts_with("task/") {
            let resolved = Self::resolve_canonical_task_workspace_path(raw, method)?;
            // On Windows the resolver keeps the path as given (TS `path.resolve` form, e.g. an
            // 8.3 short name or no `\\?\` prefix) once link components are ruled out, while
            // `fallback` is `std::fs::canonicalize`d, so compare the physical directory instead.
            if resolved == fallback || (cfg!(windows) && canonicalize_sync(&resolved) == fallback) {
                return Ok(fallback);
            }
            return Err(format!("{method} cwd must match an authorized workspace"));
        }
        let candidate = Path::new(raw);
        let resolved_input = if candidate.is_absolute() {
            candidate.to_path_buf()
        } else {
            self.working_directory.join(candidate)
        };
        let meta = std::fs::metadata(&resolved_input)
            .map_err(|_| format!("{method} cwd is not a directory: {raw}"))?;
        if !meta.is_dir() {
            return Err(format!("{method} cwd is not a directory: {raw}"));
        }
        let canonical = canonicalize_sync(&resolved_input);

        if method == "create_thread" {
            if self.is_create_thread_workspace(&canonical) {
                return Ok(canonical);
            }
            return Err(format!(
                "{method} cwd must match a registered project workspace or a managed one-off chat"
            ));
        }
        // Creation preflight inspects a directory the user is about to turn into a workspace.
        if UNREGISTERED_WORKSPACE_METHODS.contains(&method) {
            return Ok(canonical);
        }

        // Every other workspace-scoped RPC (thread start/list, uploads, defaults, memory,
        // documents, backups, provider settings, ...) acts only on an authorized workspace: the
        // server workspace, a managed one-off chat or worktree, or a desktop-registered project.
        // Any other host directory would let a client read or write outside its workspaces.
        let one_off_root = canonicalize_sync(&get_one_off_chats_root(&self.homedir));
        let wt_root = canonicalize_sync(&self.worktree_service.worktrees_root());
        if canonical == fallback
            || is_inside(&one_off_root, &canonical)
            || is_inside(&wt_root, &canonical)
            || self.is_create_thread_workspace(&canonical)
        {
            return Ok(canonical);
        }
        if method == "thread/list"
            && let Some(svc) = &self.desktop_service
            && svc
                .workspace_entries(&self.working_directory)
                .iter()
                .any(|w| canonicalize_sync(Path::new(&w.path)) == canonical)
        {
            return Ok(canonical);
        }
        if method == "thread/start" || method == "thread/list" {
            return Err(format!(
                "{method} cwd must match the server workspace or a one-off chat workspace"
            ));
        }
        Err(format!("{method} cwd must match an authorized workspace"))
    }

    /// Whether a canonical directory is a target for the model-callable `create_thread` tool
    /// (TS `LocalThreadHost.resolveCreateTarget` parity: a known `project` workspace or a
    /// managed one-off chat). Accepted: the server workspace, a desktop-registered `project`
    /// workspace (exact canonical match), a directory inside the managed one-off chats root,
    /// or a managed worktree inside the server's worktrees root. `canonical` must already be
    /// symlink-resolved, so a link inside an allowed root that points elsewhere is rejected.
    pub(crate) fn is_create_thread_workspace(&self, canonical: &Path) -> bool {
        if canonical == canonicalize_sync(&self.working_directory) {
            return true;
        }
        let one_off_root = canonicalize_sync(&get_one_off_chats_root(&self.homedir));
        let wt_root = canonicalize_sync(&self.worktree_service.worktrees_root());
        let strictly_inside = |root: &Path| canonical != root && is_inside(root, canonical);
        if strictly_inside(&one_off_root) || strictly_inside(&wt_root) {
            return true;
        }
        let Some(svc) = self.desktop_service.as_deref() else {
            return false;
        };
        let (workspaces, _) = crate::http_desktop::build_workspace_summaries(
            &self.working_directory,
            &self.homedir,
            Some(svc),
        );
        workspaces.iter().any(|w| {
            w.workspace_kind == "project" && canonicalize_sync(Path::new(&w.path)) == canonical
        })
    }

    /// Requires an absolute, existing, already-canonical directory path
    /// (`resolveCanonicalTaskWorkspacePath` parity).
    pub(crate) fn resolve_canonical_task_workspace_path(
        raw: &str,
        method: &str,
    ) -> Result<PathBuf, String> {
        let candidate = Path::new(raw);
        if !candidate.is_absolute() {
            return Err(format!("{method} cwd must use an absolute workspace path"));
        }
        let resolved_input = normalize_lexical_path(candidate);
        if !resolved_input.is_dir() {
            return Err(format!("{method} cwd is not a directory: {raw}"));
        }
        // TS compared `path.resolve(cwd)` with Node's JS `realpathSync`, which on Windows only
        // follows symlinks/junctions: 8.3 short names and the missing `\\?\` prefix that
        // `std::fs::canonicalize` would add are not aliases, so Windows checks link components.
        if cfg!(windows) {
            if cowork_config::path_has_link_component(&resolved_input) {
                return Err(format!(
                    "{method} cwd must use the canonical workspace path"
                ));
            }
            return Ok(resolved_input);
        }
        let canonical = canonicalize_sync(&resolved_input);
        if canonical != resolved_input {
            return Err(format!(
                "{method} cwd must use the canonical workspace path"
            ));
        }
        Ok(canonical)
    }

    fn thread_metadata_or_default(&self, thread_id: &str) -> PersistedThreadMetadata {
        self.session_db
            .get_thread_metadata(thread_id)
            .ok()
            .flatten()
            .unwrap_or(PersistedThreadMetadata {
                thread_id: thread_id.to_owned(),
                pinned: false,
                pinned_at: None,
                archived: false,
                archived_at: None,
                updated_at: String::new(),
            })
    }

    fn journal_tail_seq(&self, thread_id: &str) -> u64 {
        self.journal
            .get_health(thread_id)
            .map(|h| h.tail_seq)
            .unwrap_or(0)
    }

    pub fn build_thread_from_live(&self, live: &LiveSession) -> JsonRpcThread {
        let meta = self.thread_metadata_or_default(&live.id);
        let effective_seq = live.last_event_seq.max(self.journal_tail_seq(&live.id));
        JsonRpcThread {
            id: live.id.clone(),
            title: live.title.clone(),
            preview: live.last_message_preview.clone().unwrap_or_default(),
            model_provider: live.provider.as_str().to_owned(),
            model: live.model.clone(),
            cwd: live.cwd.clone(),
            created_at: live.created_at.clone(),
            updated_at: live.updated_at.clone(),
            message_count: live.message_count,
            last_event_seq: effective_seq,
            has_pending_ask: live.has_pending_ask,
            has_pending_approval: live.has_pending_approval,
            status: ThreadStatus {
                status_type: if live.busy { "running" } else { "loaded" }.to_owned(),
            },
            pinned: meta.pinned,
            pinned_at: meta.pinned_at,
            archived: meta.archived,
            archived_at: meta.archived_at,
            turns: None,
        }
    }

    pub fn build_thread_from_record(&self, record: &PersistedSessionRecord) -> JsonRpcThread {
        let meta = self.thread_metadata_or_default(&record.session_id);
        let effective_seq = record
            .last_event_seq
            .max(self.journal_tail_seq(&record.session_id));
        JsonRpcThread {
            id: record.session_id.clone(),
            title: record.title.clone(),
            preview: record.last_message_preview.clone().unwrap_or_default(),
            model_provider: record.provider.as_str().to_owned(),
            model: record.model.clone(),
            cwd: record.working_directory.clone(),
            created_at: record.created_at.clone(),
            updated_at: record.updated_at.clone(),
            message_count: record.message_count,
            last_event_seq: effective_seq,
            has_pending_ask: record.has_pending_ask,
            has_pending_approval: record.has_pending_approval,
            status: ThreadStatus {
                status_type: "notLoaded".to_owned(),
            },
            pinned: meta.pinned,
            pinned_at: meta.pinned_at,
            archived: meta.archived,
            archived_at: meta.archived_at,
            turns: None,
        }
    }

    fn project_feed_from_journal_or_messages(
        &self,
        thread_id: &str,
        messages: &[Value],
        todos: &[Value],
        fallback_ts: &str,
    ) -> Vec<Value> {
        let mut projector = ThreadTurnProjector::new();
        let mut item_ts_by_id: HashMap<String, String> = HashMap::new();
        let mut cursor = 0u64;
        let mut seed_message_count = None;
        loop {
            let batch = self
                .journal
                .list(thread_id, cursor, Some(THREAD_READ_JOURNAL_BATCH_SIZE))
                .unwrap_or_default();
            if batch.is_empty() {
                break;
            }
            for ev in &batch {
                if seed_message_count.is_none() {
                    seed_message_count = journal_seed_message_count(&ev.event_type, &ev.payload);
                }
                if let Some(raw_id) = ev
                    .payload
                    .pointer("/item/id")
                    .and_then(Value::as_str)
                    .or_else(|| ev.payload.get("itemId").and_then(Value::as_str))
                    .or(ev.item_id.as_deref())
                {
                    item_ts_by_id
                        .entry(raw_id.to_owned())
                        .or_insert_with(|| ev.ts.clone());
                }
                projector.handle(&PersistedJournalEventView {
                    event_type: &ev.event_type,
                    turn_id: ev.turn_id.as_deref(),
                    item_id: ev.item_id.as_deref(),
                    payload: &ev.payload,
                });
            }
            if let Some(last) = batch.last() {
                cursor = last.seq;
            }
            if batch.len() < THREAD_READ_JOURNAL_BATCH_SIZE {
                break;
            }
        }

        let mut feed = Vec::new();
        for turn in projector.build() {
            for item in turn.items {
                let Some(obj) = item.as_object() else {
                    continue;
                };
                let Some(id) = obj
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|s| !s.trim().is_empty())
                else {
                    continue;
                };
                let base_id = id
                    .rsplit_once(':')
                    .map(|(prefix, suffix)| {
                        if suffix.chars().all(|c| c.is_ascii_digit())
                            && item_ts_by_id.contains_key(prefix)
                        {
                            prefix
                        } else {
                            id
                        }
                    })
                    .unwrap_or(id);
                let ts = item_ts_by_id
                    .get(id)
                    .or_else(|| item_ts_by_id.get(base_id))
                    .map(String::as_str)
                    .unwrap_or(fallback_ts);

                match obj.get("type").and_then(Value::as_str) {
                    Some("userMessage") => {
                        let text = obj
                            .get("content")
                            .and_then(Value::as_array)
                            .map(|arr| {
                                arr.iter()
                                    .filter_map(|p| p.get("text").and_then(Value::as_str))
                                    .filter(|s| !s.is_empty())
                                    .collect::<Vec<_>>()
                                    .join("\n")
                            })
                            .unwrap_or_default();
                        let mut entry = json!({
                            "id": id,
                            "kind": "message",
                            "role": "user",
                            "ts": ts,
                            "text": text,
                        });
                        // Keep annotations (e.g. `cowork.toolRetryTurn`) so hidden retry
                        // prompts stay hidden after a reload.
                        if let Some(ann) = obj
                            .get("annotations")
                            .filter(|a| a.as_array().is_some_and(|a| !a.is_empty()))
                        {
                            entry["annotations"] = ann.clone();
                        }
                        feed.push(entry);
                    }
                    Some("agentMessage") => {
                        let text = obj.get("text").and_then(Value::as_str).unwrap_or_default();
                        feed.push(json!({
                            "id": id,
                            "kind": "message",
                            "role": "assistant",
                            "ts": ts,
                            "text": text,
                        }));
                    }
                    Some("reasoning") => {
                        let text = obj.get("text").and_then(Value::as_str).unwrap_or_default();
                        if text.trim().is_empty() {
                            continue;
                        }
                        let mode = match obj.get("mode").and_then(Value::as_str) {
                            Some("summary") => "summary",
                            _ => "reasoning",
                        };
                        feed.push(json!({
                            "id": id,
                            "kind": "reasoning",
                            "mode": mode,
                            "ts": ts,
                            "text": text,
                        }));
                    }
                    Some("toolCall") => {
                        let name = obj
                            .get("toolName")
                            .or_else(|| obj.get("name"))
                            .and_then(Value::as_str)
                            .unwrap_or("tool");
                        let state = obj
                            .get("state")
                            .and_then(Value::as_str)
                            .filter(|s| {
                                matches!(
                                    *s,
                                    "input-streaming"
                                        | "input-available"
                                        | "approval-requested"
                                        | "output-available"
                                        | "output-error"
                                        | "output-denied"
                                )
                            })
                            .unwrap_or("output-available");
                        let mut tool_item = Map::new();
                        tool_item.insert("id".to_owned(), json!(id));
                        tool_item.insert("kind".to_owned(), json!("tool"));
                        tool_item.insert("ts".to_owned(), json!(ts));
                        tool_item.insert("name".to_owned(), json!(name));
                        tool_item.insert("state".to_owned(), json!(state));
                        if let Some(args) = obj.get("args").or_else(|| obj.get("input")) {
                            tool_item.insert("args".to_owned(), args.clone());
                        }
                        if let Some(res) = obj.get("result").or_else(|| obj.get("output")) {
                            tool_item.insert("result".to_owned(), res.clone());
                        }
                        if let Some(retry_of) = obj
                            .get("retryOf")
                            .and_then(Value::as_str)
                            .filter(|s| !s.trim().is_empty())
                        {
                            tool_item.insert("retryOf".to_owned(), json!(retry_of));
                        }
                        if let Some(digest) = obj.get("inputDigest").and_then(Value::as_object)
                            && digest.get("algorithm").and_then(Value::as_str) == Some("sha256")
                            && digest
                                .get("value")
                                .and_then(Value::as_str)
                                .is_some_and(|v| {
                                    v.len() == 64
                                        && v.bytes().all(|b| {
                                            b.is_ascii_hexdigit() && !b.is_ascii_uppercase()
                                        })
                                })
                            && digest
                                .get("canonicalBytes")
                                .and_then(Value::as_u64)
                                .is_some()
                        {
                            tool_item.insert(
                                "inputDigest".to_owned(),
                                json!({
                                    "algorithm": "sha256",
                                    "value": digest["value"],
                                    "canonicalBytes": digest["canonicalBytes"],
                                }),
                            );
                        }
                        if let Some(completed_at) = obj
                            .get("completedAt")
                            .and_then(Value::as_str)
                            .filter(|s| !s.trim().is_empty())
                        {
                            tool_item.insert("completedAt".to_owned(), json!(completed_at));
                        }
                        if let Some(app) = obj.get("approval").and_then(Value::as_object)
                            && let Some(aid) = app
                                .get("approvalId")
                                .and_then(Value::as_str)
                                .filter(|s| !s.trim().is_empty())
                        {
                            let mut app_map = Map::new();
                            app_map.insert("approvalId".to_owned(), json!(aid));
                            if let Some(reason) = app.get("reason") {
                                app_map.insert("reason".to_owned(), reason.clone());
                            }
                            if let Some(tc) = app.get("toolCall") {
                                app_map.insert("toolCall".to_owned(), tc.clone());
                            }
                            tool_item.insert("approval".to_owned(), Value::Object(app_map));
                        }
                        feed.push(Value::Object(tool_item));
                    }
                    _ => {}
                }
            }
        }

        // Forks (and pre-journal history) carry conversation messages the journal never saw;
        // keep that unjournaled prefix ahead of the journal-derived items so the first
        // follow-up turn doesn't drop it.
        let seed = unjournaled_seed_messages(
            thread_id,
            messages,
            seed_message_count,
            !feed.is_empty(),
            fallback_ts,
        );
        if !seed.is_empty() {
            let journal_items = std::mem::take(&mut feed);
            feed.extend(seed.into_iter().map(|m| {
                json!({
                    "id": m.id,
                    "kind": "message",
                    "role": m.role,
                    "ts": m.ts,
                    "text": m.text,
                })
            }));
            feed.extend(journal_items);
        }

        let valid_todos: Vec<Value> = todos
            .iter()
            .filter(|t| {
                t.get("content").and_then(Value::as_str).is_some()
                    && matches!(
                        t.get("status").and_then(Value::as_str),
                        Some("pending" | "in_progress" | "completed")
                    )
                    && t.get("activeForm").and_then(Value::as_str).is_some()
            })
            .map(|t| {
                json!({
                    "content": t["content"],
                    "status": t["status"],
                    "activeForm": t["activeForm"],
                })
            })
            .collect();
        if !valid_todos.is_empty() {
            feed.push(json!({
                "id": format!("todos:{thread_id}"),
                "kind": "todos",
                "ts": fallback_ts,
                "todos": valid_todos,
            }));
        }

        feed
    }

    fn derive_last_turn_usage(session_usage: Option<&Value>) -> Value {
        session_usage
            .and_then(|su| su.get("turns"))
            .and_then(Value::as_array)
            .and_then(|turns| turns.last())
            .and_then(|last| {
                let turn_id = last
                    .get("turnId")
                    .and_then(Value::as_str)
                    .filter(|s| !s.trim().is_empty())?;
                let mut usage = last.get("usage")?.clone();
                if let Some(cost) = last.get("estimatedCostUsd").filter(|v| !v.is_null())
                    && let Some(uobj) = usage.as_object_mut()
                {
                    uobj.insert("estimatedCostUsd".to_owned(), cost.clone());
                }
                Some(json!({
                    "turnId": turn_id,
                    "usage": usage,
                }))
            })
            .unwrap_or(Value::Null)
    }

    pub(crate) fn build_session_snapshot_for_live(&self, live: &LiveSession) -> Value {
        let effective_seq = live.last_event_seq.max(self.journal_tail_seq(&live.id));
        let feed = self.project_feed_from_journal_or_messages(
            &live.id,
            &live.messages,
            &live.todos,
            &live.updated_at,
        );
        let valid_todos: Vec<Value> = live
            .todos
            .iter()
            .filter(|t| {
                t.get("content").and_then(Value::as_str).is_some()
                    && matches!(
                        t.get("status").and_then(Value::as_str),
                        Some("pending" | "in_progress" | "completed")
                    )
                    && t.get("activeForm").and_then(Value::as_str).is_some()
            })
            .map(|t| {
                json!({
                    "content": t["content"],
                    "status": t["status"],
                    "activeForm": t["activeForm"],
                })
            })
            .collect();
        let agents = self
            .agent_controls
            .get(&live.id)
            .and_then(|ctrl| serde_json::to_value(ctrl.list(true)).ok())
            .unwrap_or_else(|| json!([]));
        let session_usage = live.effective_session_usage_snapshot();
        let last_turn_usage = Self::derive_last_turn_usage(session_usage.as_ref());

        json!({
            "sessionId": live.id,
            "title": live.title,
            "titleSource": live.title_source.as_str(),
            "titleModel": live.title_model,
            "provider": live.provider.as_str(),
            "model": live.model,
            "sessionKind": live.session_kind.as_str(),
            "parentSessionId": live.parent_session_id,
            "role": live.role,
            "mode": live.mode,
            "depth": live.depth,
            "nickname": live.nickname,
            "taskType": live.task_type,
            "targetPaths": live.target_paths,
            "profile": live.profile,
            "requestedModel": live.requested_model.clone().or_else(|| Some(live.model.clone())),
            "effectiveModel": live.effective_model.clone().or_else(|| Some(live.model.clone())),
            "requestedReasoningEffort": live.requested_reasoning_effort,
            "effectiveReasoningEffort": live.effective_reasoning_effort,
            "executionState": live.execution_state.map(|s| s.as_str()),
            "lastMessagePreview": live.last_message_preview,
            "createdAt": live.created_at,
            "updatedAt": live.updated_at,
            "messageCount": live.message_count,
            "lastEventSeq": effective_seq,
            "feed": feed,
            "agents": agents,
            "workflowRuns": live.workflow_runs,
            "todos": valid_todos,
            "sessionUsage": session_usage,
            "lastTurnUsage": last_turn_usage,
            "hasPendingAsk": live.has_pending_ask,
            "hasPendingApproval": live.has_pending_approval,
        })
    }

    /// Writes the session's full snapshot from its live state.
    ///
    /// For a child agent session that this server is not running a turn on, the transcript and
    /// run state are reconciled against the stored row first ([`adopt_stored_child_agent_state`])
    /// and adopted back into the cache: the parent's `AgentControl` persists those directly, so
    /// the cached copy can be older than `sessions.db`. Use
    /// [`Self::persist_live_session_after_turn`] for the write that stores a turn's own result.
    pub(crate) async fn persist_live_session(
        &self,
        live_arc: &Arc<Mutex<LiveSession>>,
        event_type: &str,
    ) -> anyhow::Result<()> {
        self.persist_live_session_with(live_arc, event_type, false)
            .await
    }

    /// [`Self::persist_live_session`] for the end of a turn this server ran on the session: the
    /// live transcript is the newest copy and is written as is.
    pub(crate) async fn persist_live_session_after_turn(
        &self,
        live_arc: &Arc<Mutex<LiveSession>>,
        event_type: &str,
    ) -> anyhow::Result<()> {
        self.persist_live_session_with(live_arc, event_type, true)
            .await
    }

    async fn persist_live_session_with(
        &self,
        live_arc: &Arc<Mutex<LiveSession>>,
        event_type: &str,
        live_is_authoritative: bool,
    ) -> anyhow::Result<()> {
        // One persist per session at a time, snapshotting only once it holds the lock
        // (`PersistenceManager.queuePersistSessionSnapshot` serialized them): otherwise an older
        // snapshot taken before a concurrent persist could land after it and roll back newer
        // state such as a finished turn.
        let lock_id = live_arc.lock().id.clone();
        let persist_lock = Arc::clone(
            self.session_persist_locks
                .entry(lock_id)
                .or_default()
                .value(),
        );
        let _persisting = persist_lock.lock().await;
        let (session_id, snapshot_data, child_budget) = {
            let live = live_arc.lock();
            let reconcile_child =
                !live_is_authoritative && live.session_kind != SessionKind::Root && !live.busy;
            (
                live.id.clone(),
                live.to_snapshot_data(),
                reconcile_child.then_some((live.stored_seq, live.warn_at_usd, live.stop_at_usd)),
            )
        };
        if self.is_session_deleted(&session_id) {
            return Ok(());
        }
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let mutation = PersistedSessionMutation {
            session_id: session_id.clone(),
            event_type: event_type.to_owned(),
            event_ts: Some(now),
            direction: Some("server".to_owned()),
            payload: None,
            snapshot: snapshot_data,
        };
        let seq = match child_budget {
            None => self.session_db.persist_session_mutation(mutation).await?,
            Some((known_seq, warn_at_usd, stop_at_usd)) => {
                let mut stored_usage = None;
                let (seq, written) = self
                    .session_db
                    .persist_session_mutation_reconciled(mutation, |stored, snap| {
                        stored_usage = adopt_stored_child_agent_state(
                            stored,
                            snap,
                            known_seq,
                            warn_at_usd,
                            stop_at_usd,
                        );
                    })
                    .await?;
                let mut live = live_arc.lock();
                if seq > 0 && !live.busy {
                    live.adopt_child_agent_state(&written, stored_usage);
                }
                seq
            }
        };
        let effective_seq = seq.max(self.journal_tail_seq(&session_id));
        let snapshot_json = {
            let mut live = live_arc.lock();
            live.last_event_seq = live.last_event_seq.max(effective_seq);
            if seq > 0 {
                live.stored_seq = live.stored_seq.max(seq);
            }
            self.build_session_snapshot_for_live(&live)
        };
        self.session_db
            .persist_session_snapshot(&session_id, &snapshot_json)
            .await?;
        // A delete may have committed between the check above and these writes; undo them so
        // the deleted session cannot reappear.
        if self.is_session_deleted(&session_id) {
            self.session_db.delete_session(&session_id).await?;
        }
        Ok(())
    }

    /// Journals a [`THREAD_SEED_EVENT`] marker before the first journaled turn of a thread that
    /// has stored messages but an empty journal (imported or pre-journal threads never got a
    /// `thread/started` marker). Without it, once the turn journals items the stored prefix would
    /// be treated as covered by the journal and vanish from `thread/read` and the snapshot feed.
    /// Threads created by this server already start their journal with `thread/started`.
    pub(crate) async fn ensure_journal_seed_marker(&self, live_arc: &Arc<Mutex<LiveSession>>) {
        let (thread_id, message_count) = {
            let live = live_arc.lock();
            (live.id.clone(), live.messages.len())
        };
        if message_count == 0 {
            return;
        }
        self.journal.wait_for_idle(&thread_id).await;
        if !matches!(self.journal.list(&thread_id, 0, Some(1)), Ok(events) if events.is_empty()) {
            return;
        }
        let _ = self
            .journal
            .enqueue(ThreadJournalEventInput {
                thread_id: thread_id.clone(),
                ts: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                event_type: THREAD_SEED_EVENT.to_owned(),
                turn_id: None,
                item_id: None,
                request_id: None,
                payload: json!({ "threadId": thread_id, "messageCount": message_count }),
            })
            .await;
    }

    pub(crate) fn is_session_deleted(&self, session_id: &str) -> bool {
        self.deleted_sessions.contains_key(session_id)
    }

    /// Starts a new thread or returns the existing thread bound to `(cwd, clientThreadId)`.
    pub async fn start_or_get_thread(
        &self,
        cwd: &Path,
        client_thread_id: Option<&str>,
        provider_override: Option<&str>,
        model_override: Option<&str>,
        connection_id: &str,
    ) -> Result<(JsonRpcThread, bool), String> {
        let cwd_str = cwd.to_string_lossy().into_owned();
        let creation_key = client_thread_id
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|cid| format!("{cwd_str}\0{cid}"));

        if let Some(key) = &creation_key
            && let Some(existing_id) = self.creation_keys.get(key).map(|v| v.value().clone())
            && let Some(live_arc) = self.try_load_thread(&existing_id)?
        {
            self.subscribe(connection_id, &existing_id);
            let thread = self.build_thread_from_live(&live_arc.lock());
            return Ok((thread, false));
        }

        let candidate_id = Uuid::new_v4().to_string();
        let winning_id = if let Some(key) = &creation_key {
            let bound = self
                .session_db
                .bind_thread_creation_key(key, &candidate_id)
                .await
                .map_err(|e| format!("Failed to bind thread creation key: {e}"))?;
            self.creation_keys.insert(key.clone(), bound.clone());
            bound
        } else {
            candidate_id.clone()
        };

        if winning_id != candidate_id
            && let Some(existing_live) = self.try_load_thread(&winning_id)?
        {
            self.subscribe(connection_id, &winning_id);
            let thread = self.build_thread_from_live(&existing_live.lock());
            return Ok((thread, false));
        }

        let cfg = self
            .load_workspace_config(cwd)
            .map_err(|e| format!("Failed to load workspace config: {e}"))?;
        let provider = match provider_override.map(str::trim).filter(|s| !s.is_empty()) {
            Some(p) => ProviderName::parse(p).ok_or_else(|| format!("Unknown provider: {p}"))?,
            None => cfg.provider,
        };
        let model = model_override
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| {
                if provider == cfg.provider {
                    cfg.model.clone()
                } else {
                    self.model_registry()
                        .default_model_for_config(
                            provider,
                            &self.homedir,
                            &self.env,
                            cfg.provider_options.as_ref(),
                        )
                        .id
                }
            });

        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let mut subscribers = HashSet::new();
        subscribers.insert(connection_id.to_owned());
        let (output_directory, uploads_directory) = crate::turn_runner::config_io_dir_strings(&cfg);

        let live = LiveSession {
            id: winning_id.clone(),
            session_kind: SessionKind::Root,
            parent_session_id: None,
            role: None,
            mode: None,
            depth: None,
            nickname: None,
            task_type: None,
            target_paths: None,
            profile: None,
            requested_model: None,
            effective_model: None,
            execution_state: None,
            sandbox: None,
            cwd: cwd_str,
            output_directory,
            uploads_directory,
            provider,
            model,
            title: "New session".to_owned(),
            title_source: SessionTitleSource::Default,
            title_model: None,
            last_message_preview: None,
            created_at: now.clone(),
            updated_at: now.clone(),
            message_count: 0,
            last_event_seq: 0,
            busy: false,
            has_pending_ask: false,
            has_pending_approval: false,
            enable_mcp: cfg.enable_mcp,
            warn_at_usd: None,
            stop_at_usd: None,
            cost_tracker_snapshot: None,
            active_cost_tracker: None,
            provider_state: None,
            todos: Vec::new(),
            workflow_runs: Vec::new(),
            last_memory_generated_index: None,
            requested_reasoning_effort: None,
            effective_reasoning_effort: None,
            harness_context: None,
            config_overrides: Map::new(),
            messages: Vec::new(),
            system_prompt: String::new(),
            subscribers,
            idle_since: None,
            persistence_status: SessionPersistenceStatus::Active,
            stored_seq: 0,
        };

        // Concurrent `thread/start`s with the same `clientThreadId` all bind the same id; the
        // first to install its session owns creation and the rest join it.
        let created = match self.sessions.entry(winning_id.clone()) {
            dashmap::mapref::entry::Entry::Occupied(_) => None,
            dashmap::mapref::entry::Entry::Vacant(slot) => {
                let live_arc = Arc::new(Mutex::new(live));
                slot.insert(live_arc.clone());
                Some(live_arc)
            }
        };
        let Some(live_arc) = created else {
            let existing = self
                .subscribe(connection_id, &winning_id)
                .ok_or_else(|| format!("Unknown thread: {winning_id}"))?;
            let thread = self.build_thread_from_live(&existing.lock());
            return Ok((thread, false));
        };
        self.persist_live_session(&live_arc, "thread/started")
            .await
            .map_err(|e| format!("Failed to persist thread: {e}"))?;

        let thread = self.build_thread_from_live(&live_arc.lock());
        let _ = self
            .journal
            .enqueue(ThreadJournalEventInput {
                thread_id: winning_id,
                ts: now,
                event_type: "thread/started".to_owned(),
                turn_id: None,
                item_id: None,
                request_id: None,
                payload: json!({ "thread": thread }),
            })
            .await;

        Ok((thread, true))
    }

    /// `(outputDirectory, uploadsDirectory)` to record on a session created in `cwd`: the
    /// workspace config values at creation (forks also start from the target workspace config,
    /// `localThreadHost.forkThread` parity).
    pub(crate) fn new_session_io_dirs(&self, cwd: &Path) -> (Option<String>, Option<String>) {
        self.load_workspace_config(cwd)
            .map(|cfg| crate::turn_runner::config_io_dir_strings(&cfg))
            .unwrap_or_default()
    }

    /// Stored `(outputDirectory, uploadsDirectory)` of a live or persisted session (child
    /// agents inherit their parent's, `modelRouter.ts` `...parentConfig` parity).
    pub(crate) fn session_io_dirs(&self, session_id: &str) -> (Option<String>, Option<String>) {
        if let Some(live) = self.get_live_thread(session_id) {
            let live = live.lock();
            return (
                live.output_directory.clone(),
                live.uploads_directory.clone(),
            );
        }
        self.session_db
            .get_session_record(session_id)
            .ok()
            .flatten()
            .map(|r| (r.output_directory, r.uploads_directory))
            .unwrap_or_default()
    }

    pub fn get_live_thread(&self, thread_id: &str) -> Option<Arc<Mutex<LiveSession>>> {
        self.sessions.get(thread_id).map(|r| r.value().clone())
    }

    /// Gets a live thread or rehydrates it from `SessionDb` if previously evicted.
    pub fn load_thread(&self, thread_id: &str) -> Option<Arc<Mutex<LiveSession>>> {
        self.try_load_thread(thread_id).ok().flatten()
    }

    fn try_load_thread(&self, thread_id: &str) -> Result<Option<Arc<Mutex<LiveSession>>>, String> {
        if self.is_session_deleted(thread_id) {
            return Ok(None);
        }
        if let Some(existing) = self.get_live_thread(thread_id) {
            return Ok(Some(existing));
        }
        let Some(record) = self
            .session_db
            .get_session_record(thread_id)
            .map_err(|e| format!("Failed to load thread {thread_id}: {e}"))?
        else {
            return Ok(None);
        };
        let mut live = LiveSession::from_persisted(record);
        if let Some(snap) = self
            .session_db
            .get_session_snapshot(thread_id)
            .ok()
            .flatten()
            && let Some(runs) = snap.get("workflowRuns").and_then(Value::as_array)
        {
            live.workflow_runs = runs.clone();
        }
        let hydrated = Arc::new(Mutex::new(live));
        // Requests run concurrently, so another caller may have hydrated (or created) this
        // thread since the miss above. Keep whichever instance was installed first so every
        // caller shares one subscriber set and one `busy` reservation; a losing hydration is
        // plain data with no side effects and is simply dropped.
        let installed = self
            .sessions
            .entry(thread_id.to_owned())
            .or_insert_with(|| Arc::clone(&hydrated))
            .value()
            .clone();
        // A delete tombstones before it drops the live entry; re-check so a hydration that
        // raced past the check above cannot leave a deleted thread live.
        if self.is_session_deleted(thread_id) {
            if Arc::ptr_eq(&installed, &hydrated) {
                self.sessions
                    .remove_if(thread_id, |_, v| Arc::ptr_eq(v, &installed));
            }
            return Ok(None);
        }
        Ok(Some(installed))
    }

    pub fn subscribe(
        &self,
        connection_id: &str,
        thread_id: &str,
    ) -> Option<Arc<Mutex<LiveSession>>> {
        loop {
            let live_arc = self.load_thread(thread_id)?;
            {
                let mut live = live_arc.lock();
                live.subscribers.insert(connection_id.to_owned());
                live.idle_since = None;
            }
            // Idle eviction checks `subscribers` and removes atomically, so if the instance is
            // still installed the registration is visible to every later caller. Otherwise it
            // was evicted before we registered: rehydrate and register on the new instance.
            if self
                .get_live_thread(thread_id)
                .is_some_and(|current| Arc::ptr_eq(&current, &live_arc))
            {
                return Some(live_arc);
            }
        }
    }

    pub fn unsubscribe(&self, connection_id: &str, thread_id: &str) -> &'static str {
        if let Some(live_arc) = self.get_live_thread(thread_id) {
            let mut live = live_arc.lock();
            if live.subscribers.remove(connection_id) {
                if live.subscribers.is_empty() {
                    live.idle_since = Some(Instant::now());
                }
                return "unsubscribed";
            }
            return "notSubscribed";
        }
        if self
            .session_db
            .get_session_record(thread_id)
            .ok()
            .flatten()
            .is_some()
        {
            "notSubscribed"
        } else {
            "notLoaded"
        }
    }

    /// Evicts unsubscribed, non-busy sessions idle for at least `max_idle` from memory without deleting `sessions.db` rows.
    pub fn evict_idle_sessions(&self, max_idle: Duration) -> usize {
        let mut to_evict = Vec::new();
        for entry in self.sessions.iter() {
            let id = entry.key();
            let has_running_children = self
                .agent_controls
                .get(id)
                .is_some_and(|ctrl| ctrl.list(false).iter().any(|a| a.busy));
            if has_running_children {
                continue;
            }
            let live = entry.value().lock();
            if live.subscribers.is_empty()
                && !live.busy
                && live
                    .idle_since
                    .is_some_and(|since| since.elapsed() >= max_idle)
            {
                to_evict.push(id.clone());
            }
        }
        let mut count = 0;
        for id in to_evict {
            let has_running_children = self
                .agent_controls
                .get(&id)
                .is_some_and(|ctrl| ctrl.list(false).iter().any(|a| a.busy));
            // Check and remove under the map's shard lock so a concurrent `subscribe` either
            // registers first (and keeps the session) or observes the eviction and rehydrates.
            if !has_running_children
                && self
                    .sessions
                    .remove_if(&id, |_, v| {
                        let l = v.lock();
                        l.subscribers.is_empty() && !l.busy
                    })
                    .is_some()
            {
                let cache = Arc::clone(&self.mcp_tool_cache);
                let evicted_id = id.clone();
                if let Ok(handle) = tokio::runtime::Handle::try_current() {
                    handle.spawn(async move {
                        cache.close_session(&evicted_id).await;
                    });
                }
                count += 1;
            }
        }
        count
    }

    pub fn build_replay_health(&self, thread_id: &str, after_seq: u64) -> Option<ReplayHealth> {
        let health = self.journal.get_health(thread_id).ok()?;
        let reason = if !health.trusted {
            "journal_write_failed"
        } else if after_seq > health.tail_seq {
            "after_seq_beyond_tail"
        } else {
            "ok"
        };
        Some(ReplayHealth {
            trusted: reason == "ok",
            snapshot_required: reason != "ok",
            reason: reason.to_owned(),
            tail_seq: health.tail_seq,
            failed_write_count: health.failed_write_count,
            dropped_event_count: health.dropped_event_count,
        })
    }

    pub async fn resume_thread(
        &self,
        conn: &crate::jsonrpc::ConnectionRpcState,
        thread_id: &str,
        after_seq: u64,
    ) -> Result<(JsonRpcThread, Option<ReplayHealth>), String> {
        let connection_id = &conn.connection_id;
        let Some(mut live_arc) = self.try_load_thread(thread_id)? else {
            return Err(format!("Unknown thread: {thread_id}"));
        };
        let replay = conn.replay_gate.lock().await;
        let gate = self.thread_emit_gate(thread_id);
        let settle_deadline = tokio::time::Instant::now() + RESUME_JOURNAL_SETTLE_TIMEOUT;
        loop {
            self.journal.wait_for_idle(thread_id).await;
            let persisted = gate.persisted.notified();
            tokio::pin!(persisted);
            persisted.as_mut().enable();
            // Every event emitted before this point is either still being written (wait for it)
            // or durable; nothing can be emitted while the gate is held.
            let settled = gate.all_persisted() || tokio::time::Instant::now() >= settle_deadline;
            if settled {
                let emitted = gate.lock();
                let replay_health = self.build_replay_health(thread_id, after_seq);
                let mut replayed_request_ids = HashSet::new();
                if after_seq > 0
                    && replay_health.as_ref().is_none_or(|h| h.trusted)
                    && let Ok(events) = self.journal.list(thread_id, after_seq, None)
                {
                    for ev in events {
                        self.replay_journal_event(connection_id, thread_id, ev, &mut |id| {
                            replayed_request_ids.insert(id.to_owned());
                        });
                    }
                }
                if let Some(subscribed) = self.subscribe(connection_id, thread_id) {
                    live_arc = subscribed;
                }
                // Prompts still awaiting an answer that the journal slice did not carry go to the
                // resuming connection only: they are already journaled and were broadcast to the
                // other subscribers (TS `pendingPromptEvents` / `skipPendingPromptRequestIds`).
                if let Some(im) = self
                    .interaction_managers
                    .get(thread_id)
                    .map(|im| Arc::clone(im.value()))
                {
                    for (request_id, method, params) in
                        crate::turn_runner::capture_pending_server_requests(&im)
                    {
                        if replayed_request_ids.contains(&request_id)
                            || !emitted.emitted_requests.contains(&request_id)
                        {
                            continue;
                        }
                        let frame = JsonRpcLiteOutbound::ServerRequest(JsonRpcLiteRequest {
                            id: JsonRpcLiteId::String(request_id),
                            method,
                            params: Some(params),
                        });
                        self.send_to_connection(connection_id, &frame);
                    }
                }
                let thread = self.build_thread_from_live(&live_arc.lock());
                drop(emitted);
                drop(replay);
                return Ok((thread, replay_health));
            }
            let _ = tokio::time::timeout_at(settle_deadline, persisted).await;
        }
    }

    /// Sends one journaled event to `connection_id` as its original frame; `request:*` events
    /// become server requests and report their id through `on_request`.
    fn replay_journal_event(
        &self,
        connection_id: &str,
        thread_id: &str,
        ev: cowork_storage::PersistedThreadJournalEvent,
        on_request: &mut dyn FnMut(&str),
    ) {
        if ev.event_type.starts_with("internal/") {
            return;
        }
        if let Some(req_method) = ev.event_type.strip_prefix("request:") {
            let req_id = ev
                .request_id
                .unwrap_or_else(|| format!("{thread_id}:{}", ev.seq));
            on_request(&req_id);
            let frame = JsonRpcLiteOutbound::ServerRequest(JsonRpcLiteRequest {
                id: JsonRpcLiteId::String(req_id),
                method: req_method.to_owned(),
                params: Some(ev.payload),
            });
            self.send_to_connection(connection_id, &frame);
            return;
        }
        let frame = JsonRpcLiteOutbound::Notification(JsonRpcLiteNotification {
            method: ev.event_type,
            params: Some(ev.payload),
        });
        self.send_to_connection(connection_id, &frame);
    }

    pub(crate) fn thread_emit_gate(&self, thread_id: &str) -> Arc<ThreadEmitGate> {
        Arc::clone(
            self.thread_emit_gates
                .entry(thread_id.to_owned())
                .or_default()
                .value(),
        )
    }

    pub async fn read_or_hydrate_thread(
        &self,
        thread_id: &str,
        after_seq: u64,
        include_turns: bool,
    ) -> Result<Value, String> {
        self.journal.wait_for_idle(thread_id).await;
        let live_opt = self.get_live_thread(thread_id);
        let record_opt = if live_opt.is_some() {
            None
        } else {
            self.session_db
                .get_session_record(thread_id)
                .map_err(|e| format!("Failed to load thread {thread_id}: {e}"))?
        };

        let mut thread = if let Some(live_arc) = &live_opt {
            self.build_thread_from_live(&live_arc.lock())
        } else if let Some(rec) = &record_opt {
            self.build_thread_from_record(rec)
        } else {
            return Err(format!("Unknown thread: {thread_id}"));
        };

        let snapshot = if let Some(live_arc) = &live_opt {
            self.build_session_snapshot_for_live(&live_arc.lock())
        } else {
            let stored = self
                .session_db
                .get_session_snapshot(thread_id)
                .ok()
                .flatten()
                .filter(|v| {
                    v.get("sessionId")
                        .and_then(Value::as_str)
                        .is_some_and(|s| !s.trim().is_empty())
                        && v.get("feed").and_then(Value::as_array).is_some()
                });
            let mut snap = stored
                .or_else(|| {
                    self.session_db
                        .project_legacy_snapshot(thread_id)
                        .ok()
                        .flatten()
                })
                .unwrap_or(Value::Null);
            if let Some(obj) = snap.as_object_mut() {
                obj.entry("workflowRuns")
                    .or_insert_with(|| Value::Array(Vec::new()));
                if let Some(su) = obj.get_mut("sessionUsage")
                    && !su.is_null()
                    && (su.get("sessionId").is_none() || su.get("budgetStatus").is_none())
                {
                    *su = Value::Null;
                    obj.insert("lastTurnUsage".to_owned(), Value::Null);
                }
            }
            snap
        };

        let mut journal_tail_seq = after_seq;
        if include_turns {
            let mut projector = ThreadTurnProjector::new();
            let mut seed_message_count = None;
            loop {
                let batch = self
                    .journal
                    .list(
                        thread_id,
                        journal_tail_seq,
                        Some(THREAD_READ_JOURNAL_BATCH_SIZE),
                    )
                    .unwrap_or_default();
                if batch.is_empty() {
                    break;
                }
                for ev in &batch {
                    if seed_message_count.is_none() {
                        seed_message_count =
                            journal_seed_message_count(&ev.event_type, &ev.payload);
                    }
                    projector.handle(&PersistedJournalEventView {
                        event_type: &ev.event_type,
                        turn_id: ev.turn_id.as_deref(),
                        item_id: ev.item_id.as_deref(),
                        payload: &ev.payload,
                    });
                }
                if let Some(last) = batch.last() {
                    journal_tail_seq = last.seq;
                }
                if batch.len() < THREAD_READ_JOURNAL_BATCH_SIZE {
                    break;
                }
            }
            let mut turns = projector.build();
            // A full read (not an `afterSeq` delta) leads with the unjournaled seed conversation
            // (e.g. a fork's copied messages), mirroring the snapshot feed.
            if after_seq == 0 {
                let journal_has_items = turns.iter().any(|t| !t.items.is_empty());
                let seed_turn = |messages: &[Value], fallback_ts: &str| {
                    seed_projected_turn(unjournaled_seed_messages(
                        thread_id,
                        messages,
                        seed_message_count,
                        journal_has_items,
                        fallback_ts,
                    ))
                };
                let seed = if let Some(live_arc) = &live_opt {
                    let live = live_arc.lock();
                    seed_turn(&live.messages, &live.updated_at)
                } else {
                    record_opt
                        .as_ref()
                        .and_then(|rec| seed_turn(&rec.messages, &rec.updated_at))
                };
                if let Some(seed) = seed {
                    turns.insert(0, seed);
                }
            }
            thread.turns = Some(turns);
        }

        let replay_health = self.build_replay_health(thread_id, journal_tail_seq);
        let mut resp = Map::new();
        resp.insert(
            "thread".to_owned(),
            serde_json::to_value(&thread).unwrap_or(Value::Null),
        );
        resp.insert("coworkSnapshot".to_owned(), snapshot);
        if include_turns {
            resp.insert("journalTailSeq".to_owned(), json!(journal_tail_seq));
        }
        if let Some(rh) = replay_health {
            resp.insert(
                "replayHealth".to_owned(),
                serde_json::to_value(rh).unwrap_or(Value::Null),
            );
        }
        Ok(Value::Object(resp))
    }

    pub fn list_workspace_threads(
        &self,
        cwd: &Path,
        offset: Option<usize>,
        limit: Option<usize>,
    ) -> (Vec<JsonRpcThread>, usize) {
        let cwd_str = cwd.to_string_lossy().into_owned();
        let mut by_id: HashMap<String, JsonRpcThread> = HashMap::new();

        if let Ok(summaries) = self.session_db.list_sessions(Some(&cwd_str)) {
            for sum in summaries {
                if self.task_coordinator.is_task_thread(&sum.session_id) {
                    continue;
                }
                let Some(record) = self
                    .session_db
                    .get_session_record(&sum.session_id)
                    .ok()
                    .flatten()
                else {
                    continue;
                };
                if record.session_kind != SessionKind::Root
                    || record.parent_session_id.is_some()
                    || record.role.is_some()
                {
                    continue;
                }
                let include = matches!(
                    record.execution_state,
                    Some(
                        cowork_storage::AgentExecutionState::Running
                            | cowork_storage::AgentExecutionState::PendingInit
                    )
                ) || record.message_count > 0
                    || record.title_source != SessionTitleSource::Default
                    || record.has_pending_ask
                    || record.has_pending_approval;
                if include {
                    by_id.insert(
                        record.session_id.clone(),
                        self.build_thread_from_record(&record),
                    );
                }
            }
        }

        for entry in self.sessions.iter() {
            let live = entry.value().lock();
            if live.session_kind != SessionKind::Root
                || live.parent_session_id.is_some()
                || live.role.is_some()
                || self.task_coordinator.is_task_thread(&live.id)
            {
                continue;
            }
            if live.cwd == cwd_str {
                let include = live.busy
                    || live.message_count > 0
                    || live.title_source != SessionTitleSource::Default
                    || live.has_pending_ask
                    || live.has_pending_approval;
                if include {
                    by_id.insert(live.id.clone(), self.build_thread_from_live(&live));
                }
            }
        }

        let mut threads: Vec<JsonRpcThread> = by_id.into_values().collect();
        threads.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        let total = threads.len();
        let start = offset.unwrap_or(0).min(total);
        let end = limit
            .map(|l| start.saturating_add(l).min(total))
            .unwrap_or(total);
        (threads[start..end].to_vec(), total)
    }

    pub async fn set_thread_pinned(
        &self,
        thread_id: &str,
        pinned: bool,
    ) -> Result<JsonRpcThread, String> {
        if self.task_coordinator.is_task_thread(thread_id) {
            return Err("Task-owned threads are not managed by thread-management tools".to_owned());
        }
        if self.load_thread(thread_id).is_none() {
            return Err(format!("Unknown thread: {thread_id}"));
        }
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        self.session_db
            .upsert_thread_metadata(PersistedThreadMetadataPatch {
                thread_id: thread_id.to_owned(),
                pinned: Some(pinned),
                pinned_at: Some(pinned.then(|| now.clone())),
                archived: None,
                archived_at: None,
                updated_at: Some(now),
            })
            .await
            .map_err(|e| e.to_string())?;
        // A concurrent delete can remove the thread while the metadata write is in flight.
        let Some(live_arc) = self.load_thread(thread_id) else {
            return Err(format!("Unknown thread: {thread_id}"));
        };
        let out = self.build_thread_from_live(&live_arc.lock());
        Ok(out)
    }

    pub async fn set_thread_archived(
        &self,
        thread_id: &str,
        archived: bool,
    ) -> Result<JsonRpcThread, String> {
        if self.task_coordinator.is_task_thread(thread_id) {
            return Err("Task-owned threads are not managed by thread-management tools".to_owned());
        }
        if self.load_thread(thread_id).is_none() {
            return Err(format!("Unknown thread: {thread_id}"));
        }
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        self.session_db
            .upsert_thread_metadata(PersistedThreadMetadataPatch {
                thread_id: thread_id.to_owned(),
                pinned: None,
                pinned_at: None,
                archived: Some(archived),
                archived_at: Some(archived.then(|| now.clone())),
                updated_at: Some(now),
            })
            .await
            .map_err(|e| e.to_string())?;
        // A concurrent delete can remove the thread while the metadata write is in flight.
        let Some(live_arc) = self.load_thread(thread_id) else {
            return Err(format!("Unknown thread: {thread_id}"));
        };
        let out = self.build_thread_from_live(&live_arc.lock());
        Ok(out)
    }

    pub async fn set_session_title(&self, thread_id: &str, title: &str) -> Result<Value, String> {
        let Some(live_arc) = self.try_load_thread(thread_id)? else {
            return Err("cowork/session/title/set requires threadId and title".to_owned());
        };
        let trimmed = title.trim();
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let (event, changed) = {
            let mut live = live_arc.lock();
            let prev = (live.title.clone(), live.title_source);
            live.title = if trimmed.is_empty() {
                "New session".to_owned()
            } else {
                trimmed.to_owned()
            };
            live.title_source = if trimmed.is_empty() {
                SessionTitleSource::Default
            } else {
                SessionTitleSource::Manual
            };
            live.updated_at = now;
            let changed = prev != (live.title.clone(), live.title_source);
            let event = json!({
                "type": "session_info",
                "sessionId": live.id,
                "title": live.title,
                "titleSource": live.title_source,
                "titleModel": live.title_model,
                "createdAt": live.created_at,
                "updatedAt": live.updated_at,
                "provider": live.provider,
                "model": live.model,
            });
            (event, changed)
        };
        self.persist_live_session(&live_arc, "session_info")
            .await
            .map_err(|e| e.to_string())?;
        // `SessionMetadataManager.updateSessionInfo` emitted `session_info` (projected as
        // `cowork/session/info`) to every subscriber when the title actually changed.
        if changed {
            self.broadcast_session_event(thread_id, "cowork/session/info", &event);
        }
        Ok(event)
    }

    /// Sends a session-scoped event to every connection subscribed to `thread_id`, mirroring
    /// TS `notificationProjector` (the requester gets it too when subscribed).
    pub(crate) fn broadcast_session_event(&self, thread_id: &str, method: &str, event: &Value) {
        self.broadcast_to_thread(
            thread_id,
            None,
            &JsonRpcLiteOutbound::Notification(JsonRpcLiteNotification {
                method: method.to_owned(),
                params: Some(event.clone()),
            }),
        );
    }

    pub async fn set_session_model(
        &self,
        thread_id: &str,
        provider_raw: Option<&str>,
        model: &str,
    ) -> Result<Value, String> {
        let Some(live_arc) = self.load_thread(thread_id) else {
            return Err("cowork/session/model/set requires threadId and model".to_owned());
        };
        let trimmed_model = model.trim();
        if trimmed_model.is_empty() {
            return Err("Model ID must not be empty".to_owned());
        }
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let (event, root_selection) = {
            let mut live = live_arc.lock();
            // `ProviderAuthManager.setModel` rejected a switch while the agent was running: the
            // turn writes its provider continuation state back to the session when it settles.
            if live.busy {
                return Err("Agent is busy".to_owned());
            }
            let prev_provider = live.provider;
            let prev_model = live.model.clone();
            if let Some(p_str) = provider_raw.map(str::trim).filter(|s| !s.is_empty()) {
                let parsed = ProviderName::parse(p_str)
                    .ok_or_else(|| format!("Unknown provider: {p_str}"))?;
                live.provider = parsed;
            }
            live.model = trimmed_model.to_owned();
            let changed = live.provider != prev_provider || live.model != prev_model;
            if changed {
                live.provider_state = None;
                // Drop reasoning state the newly selected model does not support so the next
                // turn never forwards a stale reasoning payload (`ProviderAuthManager.ts` parity).
                self.reconcile_live_reasoning_state(&mut live);
            }
            live.updated_at = now;
            // Only root sessions write their selection to the workspace defaults
            // (`persistModelSelectionImpl` was root-only); an unchanged selection is a no-op
            // (`setModel` returned before `applyPreparedModelSelection`).
            let root_selection =
                (changed && live.session_kind == SessionKind::Root).then(|| RootModelSelection {
                    cwd: PathBuf::from(&live.cwd),
                    prev_provider,
                    prev_model,
                    provider: live.provider,
                    model: live.model.clone(),
                    overrides: live.config_overrides.clone(),
                });
            let event = json!({
                "type": "config_updated",
                "sessionId": live.id,
                "config": {
                    "provider": live.provider,
                    "model": live.model,
                    "workingDirectory": live.cwd,
                }
            });
            (event, root_selection)
        };
        // TS `applyPreparedModelSelection` persisted the selection before queueing the session
        // snapshot; a failed write keeps the session-local switch and reports an `error` event
        // instead of failing the request.
        let mut persist_error = None;
        if let Some(selection) = &root_selection {
            match self.persist_root_model_selection(selection).await {
                Ok(()) => self.refresh_agent_control_config(thread_id),
                Err(e) => persist_error = Some(e),
            }
        }
        self.persist_live_session(&live_arc, "config_updated")
            .await
            .map_err(|e| e.to_string())?;
        // TS `applyPreparedModelSelection` emitted the update through the notification
        // projector, so every client subscribed to the thread (not only the requester) learns
        // the new selection.
        self.broadcast_to_thread(
            thread_id,
            None,
            &JsonRpcLiteOutbound::Notification(JsonRpcLiteNotification {
                method: "cowork/session/configUpdated".to_owned(),
                params: Some(event.clone()),
            }),
        );
        if let Some(err) = persist_error {
            self.broadcast_to_thread(
                thread_id,
                None,
                &JsonRpcLiteOutbound::Notification(JsonRpcLiteNotification {
                    method: "error".to_owned(),
                    params: Some(json!({
                        "type": "error",
                        "sessionId": thread_id,
                        "message": format!(
                            "Model updated for this session, but failed to persist defaults: {err}"
                        ),
                        "code": "internal_error",
                        "source": "session",
                    })),
                }),
            );
        }
        Ok(event)
    }

    /// Writes a root session's model selection to its workspace `.cowork/config.json`
    /// (`SessionRegistry.persistModelSelectionImpl` → `persistProjectConfigPatch`): provider,
    /// model and the child routing re-normalized for the new selection
    /// (`ProviderAuthManager.prepareModelSelection`'s `persistSelection`).
    async fn persist_root_model_selection(
        &self,
        selection: &RootModelSelection,
    ) -> Result<(), String> {
        let mut current = self
            .load_workspace_config(&selection.cwd)
            .map_err(|e| e.to_string())?;
        current.provider = selection.prev_provider;
        current.model = selection.prev_model.clone();
        crate::extension_mcp_agent_routes::apply_session_child_routing_overrides(
            &mut current,
            &selection.overrides,
        );
        apply_model_selection_child_routing(&mut current, selection.provider, &selection.model);
        let mut patch = ProjectConfigPatch {
            provider: Some(selection.provider),
            model: Some(selection.model.clone()),
            ..ProjectConfigPatch::default()
        };
        set_child_routing_patch(&mut patch, current);
        let paths = get_ai_coworker_paths(Some(&self.homedir), &self.env);
        persist_project_config_patch(
            &selection.cwd.join(".cowork"),
            &patch,
            None,
            Some(&paths.config_dir),
        )
        .await
        .map_err(|e| e.to_string())
    }

    /// Provider-option defaults the selected model declares, used to gate model-specific
    /// reasoning keys. Shares `ModelRegistry::resolved_provider_option_defaults` with config
    /// resolution (`getResolvedModelMetadataSync` in `src/models/metadata.ts`): static registry
    /// metadata, then the provider's discovery cache, then the custom-id placeholder heuristics.
    pub(crate) fn model_provider_option_defaults(
        &self,
        provider: ProviderName,
        model_id: &str,
    ) -> Map<String, Value> {
        let paths = get_ai_coworker_paths(Some(&self.homedir), &self.env);
        self.model_registry()
            .resolved_provider_option_defaults(provider, model_id, &paths)
    }

    /// Reconciles a thread's stored `providerOptions` override and requested reasoning effort
    /// against the thread's current model capabilities.
    pub(crate) fn reconcile_live_reasoning_state(&self, live: &mut LiveSession) {
        let provider = live.provider;
        let defaults = self.model_provider_option_defaults(provider, &live.model);
        if let Some(po) = live
            .config_overrides
            .get("providerOptions")
            .and_then(Value::as_object)
        {
            match reconcile_reasoning_provider_options(po, provider, &defaults) {
                Some(next) => {
                    live.config_overrides
                        .insert("providerOptions".to_owned(), Value::Object(next));
                }
                None => {
                    live.config_overrides.remove("providerOptions");
                }
            }
        }
        if let Some(effort) = live.requested_reasoning_effort.clone()
            && !self.model_accepts_reasoning_effort(provider, &live.model, &effort, &defaults)
        {
            live.requested_reasoning_effort = None;
            live.effective_reasoning_effort = None;
        }
    }

    /// Whether `provider`/`model` takes reasoning effort `effort` (TS
    /// `assertModelReasoningEffort`): the model must declare a reasoning configuration in its
    /// resolved provider-option defaults, and the effort must be one it advertises (discovery
    /// cache first, then the bundled catalog; no list keeps the declared-reasoning check only).
    /// Providers without a reasoning option never take one.
    pub(crate) fn model_accepts_reasoning_effort(
        &self,
        provider: ProviderName,
        model: &str,
        effort: &str,
        defaults: &Map<String, Value>,
    ) -> bool {
        let declares_reasoning = match provider {
            ProviderName::Openai => defaults.contains_key("reasoningEffort"),
            ProviderName::Google => defaults.contains_key("thinkingConfig"),
            ProviderName::Anthropic => {
                defaults.contains_key("effort") || defaults.contains_key("thinking")
            }
            ProviderName::CodexCli => true,
            _ => false,
        };
        if !declares_reasoning {
            return false;
        }
        let paths = get_ai_coworker_paths(Some(&self.homedir), &self.env);
        let declared = cowork_config::models::find_discovered_model_sync(&paths, provider, model)
            .and_then(|cached| cached.reasoning)
            .and_then(|reasoning| reasoning.available_efforts)
            .or_else(|| {
                self.model_registry()
                    .get(provider, model.trim())
                    .and_then(|m| m.supported_reasoning_efforts.clone())
            });
        declared.is_none_or(|efforts| efforts.iter().any(|e| e == effort))
    }

    pub async fn set_session_usage_budget(
        &self,
        thread_id: &str,
        warn_at_usd: Option<Option<f64>>,
        stop_at_usd: Option<Option<f64>>,
    ) -> Result<Value, String> {
        let Some(live_arc) = self.load_thread(thread_id) else {
            return Err("cowork/session/usageBudget/set requires threadId".to_owned());
        };
        let update = cowork_inference::BudgetThresholdUpdate {
            warn_at_usd,
            stop_at_usd,
        };
        let event = {
            let mut live = live_arc.lock();
            // A running turn owns the session's tracker: update it in place so the change
            // governs the turn's next step boundary and its final usage snapshot. The turn
            // detaches it under this same lock, so the change cannot fall between the two.
            let (budget, event) = if let Some(active) = live.active_cost_tracker.clone() {
                active.update_budget(update).map_err(|e| e.to_string())?;
                active.with_tracker(|tracker| {
                    (
                        tracker.get_budget_status(),
                        crate::turn_runner::session_usage_event(&live.id, tracker),
                    )
                })
            } else {
                let mut tracker = crate::turn_runner::rehydrate_session_cost_tracker(
                    &live.id,
                    live.cost_tracker_snapshot.clone(),
                    live.warn_at_usd,
                    live.stop_at_usd,
                );
                tracker.update_budget(update).map_err(|e| e.to_string())?;
                if live.cost_tracker_snapshot.is_some() {
                    live.cost_tracker_snapshot = serde_json::to_value(tracker.get_snapshot()).ok();
                }
                (
                    tracker.get_budget_status(),
                    crate::turn_runner::session_usage_event(&live.id, &tracker),
                )
            };
            live.warn_at_usd = budget.warn_at_usd;
            live.stop_at_usd = budget.stop_at_usd;
            live.updated_at =
                chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            event
        };
        self.persist_live_session(&live_arc, "session_usage")
            .await
            .map_err(|e| e.to_string())?;
        // `setSessionUsageBudget` emitted `session_usage` (`cowork/session/usage`) to the
        // thread's subscribers.
        self.broadcast_session_event(thread_id, "cowork/session/usage", &event);
        Ok(event)
    }

    pub fn build_session_config_event(
        &self,
        session_id: &str,
        cfg: &AgentConfig,
        overrides: Option<&Map<String, Value>>,
    ) -> Value {
        let mut config_obj = json!({
            "yolo": self.yolo,
            "observabilityEnabled": cfg.observability_enabled,
            "backupsEnabled": cfg.backups_enabled,
            "defaultBackupsEnabled": cfg.backups_enabled,
            "enableMemory": cfg.enable_memory,
            "memoryRequireApproval": cfg.memory_require_approval,
            "advancedMemory": cfg.advanced_memory,
            "skillImprovementEnabled": cfg.skill_improvement_enabled,
            "skillImprovementScope": cfg.skill_improvement_scope,
            "skillImprovementExcludedSkills": cfg.skill_improvement_excluded_skills,
            "preferredChildModel": cfg.preferred_child_model,
            "childModelRoutingMode": cfg.child_model_routing_mode,
            "preferredChildModelRef": cfg.preferred_child_model_ref,
            "allowedChildModelRefs": cfg.allowed_child_model_refs,
            "maxSteps": 100,
            "workflowMaxConcurrentAgents": cfg.workflow_max_concurrent_agents,
            "toolOutputOverflowChars": cfg.tool_output_overflow_chars,
            "userName": cfg.user_name,
            "userProfile": {
                "instructions": cfg.user_profile.instructions,
                "work": cfg.user_profile.work,
                "details": cfg.user_profile.details,
            }
        });
        // The persisted workspace overflow default (`projectConfigOverrides`), emitted only when
        // the project config sets it: a number, or `null` for an explicit disable. Absent means
        // the workspace inherits the built-in/user default (TS `getSessionConfigEvent` parity).
        if let Some(project) = &cfg.project_config_overrides {
            config_obj["defaultToolOutputOverflowChars"] =
                json!(project.tool_output_overflow_chars);
        }
        if let Some(m) = &cfg.memory_generation_model {
            config_obj["memoryGenerationModel"] = json!(m);
        }
        if let Some(m) = &cfg.skill_improvement_model {
            config_obj["skillImprovementModel"] = json!(m);
        }
        // The effective editable options: the session override layered over the workspace
        // options exactly as the turn runner merges them, so the event reports what the next
        // turn uses (TS `getSessionConfigEvent` read the merged `state.config.providerOptions`).
        // A partial override (e.g. only `google.nativeWebSearch`) must not hide an inherited
        // workspace setting such as `google.thinkingConfig`.
        let session_po = overrides
            .and_then(|o| o.get("providerOptions"))
            .and_then(Value::as_object);
        let mut effective_po = cfg.provider_options.clone().unwrap_or_default();
        if let Some(over) = session_po {
            overlay_session_provider_options(&mut effective_po, over.clone());
        }
        if let Some(po) = pick_editable_provider_options(&effective_po) {
            config_obj["providerOptions"] = Value::Object(po);
        }
        // The effective profile: the session's stored `userProfile` fields layered over the
        // workspace profile one field at a time (TS `buildNextConfig` spread the patch over
        // `effectiveUserProfile`, and `getSessionConfigEvent` emitted all three fields). The
        // desktop replaces its workspace profile with this event, so a partial override such as
        // only `work` must not blank the inherited `instructions` and `details`.
        if let Some(over) = overrides
            .and_then(|o| o.get("userProfile"))
            .and_then(Value::as_object)
        {
            for field in USER_PROFILE_FIELDS {
                if let Some(v) = over.get(field).and_then(Value::as_str) {
                    config_obj["userProfile"][field] = json!(v);
                }
            }
        }
        if let (Some(Value::Object(dst)), Some(ovr)) = (Some(&mut config_obj), overrides) {
            // `providerOptions` and `userProfile` were merged over the workspace values above.
            for (k, v) in ovr
                .iter()
                .filter(|(k, _)| *k != "providerOptions" && *k != "userProfile")
            {
                if k == "toolOutputOverflowChars" {
                    // A session overflow patch is also the session's project override
                    // (`prepareConfigUpdate` set both).
                    dst.insert("defaultToolOutputOverflowChars".to_owned(), v.clone());
                }
                dst.insert(k.clone(), v.clone());
            }
        }
        json!({
            "type": "session_config",
            "sessionId": session_id,
            "config": config_obj,
        })
    }

    pub async fn set_session_config(
        &self,
        thread_id: &str,
        patch: Map<String, Value>,
    ) -> Result<Value, String> {
        let Some(live_arc) = self.load_thread(thread_id) else {
            return Err("cowork/session/config/set requires threadId and config".to_owned());
        };
        let cwd = PathBuf::from(live_arc.lock().cwd.clone());
        let mut cfg = self
            .load_workspace_config(&cwd)
            .map_err(|e| e.to_string())?;
        // Validate and map the persistable fields before touching live state
        // (`SessionMetadataManager.prepareConfigUpdate` / `buildPersistPatch` parity).
        let mut proj_patch = ProjectConfigPatch::default();
        apply_session_config_to_project_patch(&patch, &mut proj_patch)?;
        // The config the session reported before this update (the workspace write below can
        // change `cfg` itself).
        let cfg_before = cfg.clone();
        if self.should_persist_session_config(&live_arc, &cfg, &patch, &mut proj_patch) {
            // Root sessions persist accepted settings to the workspace (and, for user-scoped
            // keys, the user) config before applying them, as `applyPreparedConfigUpdate` did
            // through `persistProjectConfigPatchImpl`; a failed write rejects the update.
            let paths = get_ai_coworker_paths(Some(&self.homedir), &self.env);
            persist_project_config_patch(
                &cwd.join(".cowork"),
                &proj_patch,
                None,
                Some(&paths.config_dir),
            )
            .await
            .map_err(|e| format!("Failed to persist config defaults: {e}"))?;
            cfg = self
                .load_workspace_config(&cwd)
                .map_err(|e| e.to_string())?;
        }
        let backups_toggled = patch.get("backupsEnabled").and_then(Value::as_bool);
        let refreshes_prompt = SYSTEM_PROMPT_REFRESH_CONFIG_KEYS
            .iter()
            .any(|k| patch.contains_key(*k));
        let (event, meta_for_backup, refreshed_child_prompt, config_changed) = {
            let mut live = live_arc.lock();
            let before =
                self.build_session_config_event(&live.id, &cfg, Some(&live.config_overrides));
            let prior_overrides = live.config_overrides.clone();
            merge_session_config_overrides(&mut live.config_overrides, patch);
            live.updated_at =
                chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            let evt = self.build_session_config_event(&live.id, &cfg, Some(&live.config_overrides));
            // Only root sessions rebuild their prompt every turn; a child keeps its saved prompt,
            // so a change to a key TS refreshed `state.system` on re-renders the child's profile
            // section into it (keeping its role/profile prompt and `systemPromptSuffix`) and it
            // is persisted below, surviving later turns and restarts.
            let refreshed_child_prompt = (refreshes_prompt
                && live.session_kind != SessionKind::Root
                && before["config"] != evt["config"])
                .then(|| {
                    let mut effective = cfg.clone();
                    crate::turn_runner::apply_session_config_overrides(
                        &mut effective,
                        &live.config_overrides,
                    );
                    let base = cowork_harness::agents::persisted_child_system_prompt(
                        &self.built_in_dir,
                        &live.system_prompt,
                        live.role.as_deref(),
                        live.profile.as_ref(),
                    );
                    live.system_prompt = cowork_harness::agents::with_child_user_profile_section(
                        &base,
                        &effective.user_name,
                        &effective.user_profile,
                    );
                    (live.parent_session_id.clone(), live.system_prompt.clone())
                });
            let meta = (
                live.id.clone(),
                live.title.clone(),
                live.provider.as_str().to_owned(),
                live.model.clone(),
            );
            let config_changed = self.build_session_config_event(
                &live.id,
                &cfg_before,
                Some(&prior_overrides),
            )["config"]
                != evt["config"];
            (evt, meta, refreshed_child_prompt, config_changed)
        };
        // The parent's hydrated controller runs the child's executor turns and persists the
        // child with its own copy of the prompt; update it before persisting so neither path
        // writes back the stale one.
        if let Some((Some(parent_id), prompt)) = refreshed_child_prompt
            && let Some(ctrl) = self
                .agent_controls
                .get(&parent_id)
                .map(|c| Arc::clone(c.value()))
        {
            ctrl.set_child_system_prompt(thread_id, &prompt);
        }
        self.persist_live_session(&live_arc, "session_config")
            .await
            .map_err(|e| e.to_string())?;
        self.refresh_agent_control_config(thread_id);
        // `SessionMetadataManager.applyPreparedConfigUpdate` emitted `session_config`
        // (`cowork/session/config`) to the thread's subscribers once an accepted change was
        // persisted; an update that leaves the effective config unchanged emitted nothing.
        if config_changed {
            self.broadcast_session_event(thread_id, "cowork/session/config", &event);
        }
        if let Some(enabled) = backups_toggled {
            let state = if enabled {
                self.backup_manager
                    .ensure_initial_backup(
                        &meta_for_backup.0,
                        &cwd,
                        Some(meta_for_backup.1),
                        Some(meta_for_backup.2),
                        Some(meta_for_backup.3),
                    )
                    .unwrap_or_else(|_| {
                        self.backup_manager.read_session_backup_state(
                            &meta_for_backup.0,
                            &cwd,
                            true,
                        )
                    })
            } else {
                self.backup_manager
                    .read_session_backup_state(&meta_for_backup.0, &cwd, false)
            };
            self.emit_session_backup_state(&meta_for_backup.0, None, "requested", &state);
        }
        Ok(event)
    }

    /// Decides whether an accepted `cowork/session/config/set` patch is written to the config
    /// files, and finalizes `proj_patch` for that write (`prepareConfigUpdate` /
    /// `buildPersistPatch` parity):
    /// - only root sessions persist (`persistProjectConfigPatchImpl` was root-only);
    /// - nothing is written when the patch leaves the effective session config unchanged;
    /// - `featureFlags`, `yolo` and `maxSteps` stay session-only;
    /// - `backupsEnabled` is dropped when it equals the configured default;
    /// - child routing is persisted normalized, together with the session's provider/model.
    fn should_persist_session_config(
        &self,
        live_arc: &Arc<Mutex<LiveSession>>,
        cfg: &AgentConfig,
        patch: &Map<String, Value>,
        proj_patch: &mut ProjectConfigPatch,
    ) -> bool {
        let live = live_arc.lock();
        if live.session_kind != SessionKind::Root {
            return false;
        }
        let mut next_overrides = live.config_overrides.clone();
        merge_session_config_overrides(&mut next_overrides, patch.clone());
        let before = self.build_session_config_event(&live.id, cfg, Some(&live.config_overrides));
        let after = self.build_session_config_event(&live.id, cfg, Some(&next_overrides));
        let clears = patch
            .iter()
            .any(|(k, v)| cleared_config_key(k).is_some() && v.as_bool() == Some(true));
        if before["config"] == after["config"] && !clears {
            return false;
        }

        proj_patch.feature_flags = None;
        // SECURITY BOUNDARY: only the editable provider-option allowlist reaches the workspace
        // config; endpoint, header and credential overrides are never written there.
        proj_patch.provider_options = patch
            .get("providerOptions")
            .and_then(Value::as_object)
            .and_then(pick_editable_provider_options)
            .map(|mut po| {
                cowork_config::strip_provider_option_endpoints(&mut po);
                po
            })
            .filter(|po| !po.is_empty());
        if proj_patch.backups_enabled == Some(cfg.backups_enabled) {
            proj_patch.backups_enabled = None;
        }
        let routing_changed = CHILD_ROUTING_CONFIG_KEYS
            .iter()
            .any(|k| patch.get(*k).is_some_and(|v| !v.is_null()));
        if routing_changed {
            let mut routed = cfg.clone();
            routed.provider = live.provider;
            routed.model = live.model.clone();
            crate::extension_mcp_agent_routes::apply_session_child_routing_overrides(
                &mut routed,
                &next_overrides,
            );
            proj_patch.provider = Some(routed.provider);
            proj_patch.model = Some(routed.model);
            proj_patch.child_model_routing_mode = Some(routed.child_model_routing_mode);
            proj_patch.preferred_child_model = Some(routed.preferred_child_model);
            proj_patch.preferred_child_model_ref = Some(routed.preferred_child_model_ref);
            proj_patch.allowed_child_model_refs = Some(routed.allowed_child_model_refs);
        }
        true
    }

    pub fn get_harness_context(&self, thread_id: &str) -> Result<Value, String> {
        let Some(live_arc) = self.load_thread(thread_id) else {
            return Err("cowork/session/harnessContext/get requires threadId".to_owned());
        };
        let live = live_arc.lock();
        Ok(json!({
            "type": "harness_context",
            "sessionId": live.id,
            "context": live.harness_context,
        }))
    }

    pub async fn set_harness_context(
        &self,
        thread_id: &str,
        input: HarnessContextInput,
    ) -> Result<Value, String> {
        let Some(live_arc) = self.load_thread(thread_id) else {
            return Err("cowork/session/harnessContext/set requires threadId".to_owned());
        };
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let mut ctx_val = serde_json::to_value(&input).map_err(|e| e.to_string())?;
        if let Value::Object(map) = &mut ctx_val {
            map.insert("updatedAt".to_owned(), Value::String(now.clone()));
        }
        let event = {
            let mut live = live_arc.lock();
            live.harness_context = Some(ctx_val.clone());
            live.updated_at = now;
            json!({
                "type": "harness_context",
                "sessionId": live.id,
                "context": ctx_val,
            })
        };
        self.persist_live_session(&live_arc, "harness_context")
            .await
            .map_err(|e| e.to_string())?;
        Ok(event)
    }

    /// `cowork/session/defaults/apply` targets only an idle, unlocked thread of `cwd`
    /// (TS `applySessionDefaults` rejected a running agent with `Agent is busy`).
    fn check_session_defaults_target(
        &self,
        cwd: &Path,
        thread_id: &str,
        live_arc: &Arc<Mutex<LiveSession>>,
    ) -> Result<(), String> {
        {
            let live = live_arc.lock();
            if !same_workspace_path(&cwd.to_string_lossy(), &live.cwd) {
                return Err("Target session is outside the active workspace".to_owned());
            }
            if live.busy {
                return Err("Agent is busy".to_owned());
            }
        }
        if let Some(active_task) = self
            .session_db
            .get_active_task_for_source_session(thread_id)
            .map_err(|e| e.to_string())?
        {
            return Err(format!("Chat is locked by active task {}", active_task.id));
        }
        Ok(())
    }

    pub async fn apply_session_defaults(
        &self,
        cwd: &Path,
        thread_id: Option<&str>,
        provider: Option<&str>,
        model: Option<&str>,
        enable_mcp: Option<bool>,
        config_patch: Option<Map<String, Value>>,
    ) -> Result<Value, String> {
        if provider.is_some() != model.is_some() {
            return Err("provider and model must be provided together".to_owned());
        }
        let parsed_provider = match provider {
            Some(p) => {
                Some(ProviderName::parse(p).ok_or_else(|| format!("Unknown provider: {p}"))?)
            }
            None => None,
        };
        // Resolve and validate the target thread before any write: an unknown, foreign,
        // running or task-locked thread must not change the workspace defaults either.
        let target = match thread_id {
            Some(tid) => {
                let Some(live_arc) = self.load_thread(tid) else {
                    return Err("Unknown thread".to_owned());
                };
                self.check_session_defaults_target(cwd, tid, &live_arc)?;
                Some((tid, live_arc))
            }
            None => None,
        };

        let mut proj_patch = ProjectConfigPatch::default();
        if let Some(p) = parsed_provider {
            proj_patch.provider = Some(p);
        }
        if let Some(m) = model {
            proj_patch.model = Some(m.to_owned());
        }
        if let Some(mcp) = enable_mcp {
            proj_patch.enable_mcp = Some(mcp);
        }
        let config_patch = config_patch
            .map(sanitize_session_defaults_config_patch)
            .transpose()?;
        if let Some(cp) = &config_patch {
            apply_session_config_to_project_patch(cp, &mut proj_patch)?;
        }
        let prev_cfg = self.load_workspace_config(cwd).map_err(|e| e.to_string())?;
        if let (Some(next_provider), Some(next_model)) = (parsed_provider, model) {
            // `prepareModelSelection`'s `persistSelection`: the child routing is re-normalized for
            // the new selection (from the thread's effective routing when one is targeted), and a
            // routing change in the same patch is then normalized against the new model
            // (`prepareConfigUpdate` ran on `preparedModel.nextConfig`).
            let mut routed = prev_cfg.clone();
            if let Some((_, live_arc)) = &target {
                let live = live_arc.lock();
                routed.provider = live.provider;
                routed.model = live.model.clone();
                crate::extension_mcp_agent_routes::apply_session_child_routing_overrides(
                    &mut routed,
                    &live.config_overrides,
                );
            }
            apply_model_selection_child_routing(&mut routed, next_provider, next_model);
            if let Some(cp) = &config_patch {
                crate::extension_mcp_agent_routes::apply_session_child_routing_overrides(
                    &mut routed,
                    cp,
                );
            }
            set_child_routing_patch(&mut proj_patch, routed);
        }

        let paths = get_ai_coworker_paths(Some(&self.homedir), &self.env);
        let project_cowork_dir = cwd.join(".cowork");
        persist_project_config_patch(
            &project_cowork_dir,
            &proj_patch,
            None,
            Some(&paths.config_dir),
        )
        .await
        .map_err(|e| e.to_string())?;

        let refreshed_cfg = self.load_workspace_config(cwd).map_err(|e| e.to_string())?;
        if let Some((tid, live_arc)) = target {
            let (event, notifications) = {
                let mut live = live_arc.lock();
                // A turn that started after the validation above owns the session now.
                if live.busy {
                    return Err("Agent is busy".to_owned());
                }
                let config_before = config_patch.as_ref().map(|_| {
                    self.build_session_config_event(
                        &live.id,
                        &prev_cfg,
                        Some(&live.config_overrides),
                    )
                });
                let prev_provider = live.provider;
                let prev_model = live.model.clone();
                let prev_enable_mcp = live.enable_mcp;
                if let Some(p) = parsed_provider {
                    live.provider = p;
                }
                if let Some(m) = model {
                    live.model = m.to_owned();
                }
                let model_changed = live.provider != prev_provider || live.model != prev_model;
                if model_changed {
                    // Same switch as `cowork/session/model/set` (`applyPreparedModelSelection`):
                    // drop continuation and reasoning state the new model cannot use.
                    live.provider_state = None;
                    self.reconcile_live_reasoning_state(&mut live);
                }
                if let Some(mcp) = enable_mcp {
                    live.enable_mcp = mcp;
                }
                if let Some(cp) = config_patch {
                    merge_session_config_overrides(&mut live.config_overrides, cp);
                }
                // TS applied the model and MCP changes through their managers, which emitted
                // `config_updated` / `session_settings` to the thread's subscribers; the
                // response itself carries only the final `session_config`.
                let mut notifications = Vec::new();
                if model_changed {
                    notifications.push((
                        "cowork/session/configUpdated",
                        json!({
                            "type": "config_updated",
                            "sessionId": live.id,
                            "config": {
                                "provider": live.provider,
                                "model": live.model,
                                "workingDirectory": live.cwd,
                            }
                        }),
                    ));
                }
                if live.enable_mcp != prev_enable_mcp {
                    let mut effective = refreshed_cfg.clone();
                    crate::turn_runner::apply_session_config_overrides(
                        &mut effective,
                        &live.config_overrides,
                    );
                    notifications.push((
                        "cowork/session/settings",
                        json!({
                            "type": "session_settings",
                            "sessionId": live.id,
                            "enableMcp": live.enable_mcp,
                            "enableMemory": effective.enable_memory,
                            "memoryRequireApproval": effective.memory_require_approval,
                        }),
                    ));
                }
                let event = self.build_session_config_event(
                    &live.id,
                    &refreshed_cfg,
                    Some(&live.config_overrides),
                );
                // A config patch that changed the effective session config was applied through
                // `applyPreparedConfigUpdate`, which emitted `session_config`.
                if config_before.is_some_and(|before| before["config"] != event["config"]) {
                    notifications.push(("cowork/session/config", event.clone()));
                }
                (event, notifications)
            };
            self.persist_live_session(&live_arc, "session_config")
                .await
                .map_err(|e| e.to_string())?;
            self.refresh_agent_control_config(tid);
            for (method, params) in notifications {
                self.broadcast_to_thread(
                    tid,
                    None,
                    &JsonRpcLiteOutbound::Notification(JsonRpcLiteNotification {
                        method: method.to_owned(),
                        params: Some(params),
                    }),
                );
            }
            return Ok(event);
        }

        let state_id = self.get_or_create_workspace_state_id(cwd);
        Ok(self.build_session_config_event(&state_id, &refreshed_cfg, None))
    }

    pub fn upload_workspace_file(
        &self,
        cwd: &Path,
        filename: &str,
        content_base64: &str,
    ) -> Result<Value, String> {
        if content_base64.len() > MAX_ATTACHMENT_UPLOAD_BASE64_SIZE {
            return Err("File too large (max 100MB)".to_owned());
        }
        let bytes = decode_base64_permissive(content_base64)?;
        let (clean_name, dst) = write_workspace_upload(cwd, filename, &bytes)?;
        let state_id = self.get_or_create_workspace_state_id(cwd);
        Ok(json!({
            "type": "file_uploaded",
            "sessionId": state_id,
            "filename": clean_name,
            "path": dst.to_string_lossy(),
        }))
    }

    pub async fn delete_session(
        &self,
        cwd: &Path,
        target_session_id: &str,
    ) -> Result<Value, String> {
        if self.task_coordinator.is_task_thread(target_session_id) {
            return Err("Task threads must be managed through the task lifecycle".to_owned());
        }
        if let Ok(Some(active_task)) = self
            .session_db
            .get_active_task_for_source_session(target_session_id)
        {
            return Err(format!("Chat is locked by active task {}", active_task.id));
        }
        // Workspace-scoped (SessionRegistry.ts `deleteSessionImpl`): a target whose live or
        // persisted working directory is another workspace is rejected before any side effect.
        let target_cwd = if let Some(live) = self.get_live_thread(target_session_id) {
            Some(live.lock().cwd.clone())
        } else {
            self.session_db
                .get_session_working_directory(target_session_id)
                .map_err(|e| e.to_string())?
        };
        if let Some(target_cwd) = target_cwd
            && !target_cwd.trim().is_empty()
            && !same_workspace_path(&cwd.to_string_lossy(), &target_cwd)
        {
            return Err("Target session is outside the active workspace".to_owned());
        }
        // Tombstone first: no new turn can load the thread and no late persist can recreate it.
        self.deleted_sessions
            .insert(target_session_id.to_owned(), ());
        // Signal the children now; they are awaited below once the root turn has settled.
        if let Some(ctrl) = self
            .agent_controls
            .get(target_session_id)
            .map(|c| Arc::clone(c.value()))
        {
            ctrl.interrupt_running_children();
        }
        // Cancel the active root turn and wait (bounded) for it to settle so its tools stop and
        // its journal writer drains before the rows are removed (SessionRegistry.ts ordering).
        self.interrupt_session_for_quiesce(target_session_id, "Chat deleted");
        let root_ids = [target_session_id.to_owned()];
        self.wait_for_turns_to_settle(&root_ids, Instant::now() + DELETE_SESSION_SETTLE_TIMEOUT)
            .await;
        // Only after the root settled (so an in-flight spawn cannot escape the lookup), tombstone,
        // cancel and await every descendant so their final persists land before the tree's rows
        // are removed. `SessionDb` also drops late writes for deleted ids if a wait times out.
        let tree_ids = self
            .quiesce_session_tree_for_delete(target_session_id)
            .await;
        for id in &tree_ids {
            self.journal.wait_for_idle(id).await;
            self.mcp_tool_cache.close_session(id).await;
            self.sessions.remove(id);
            self.thread_emit_gates.remove(id);
            self.session_persist_locks.remove(id);
        }
        self.creation_keys
            .retain(|_, bound_id| !tree_ids.contains(bound_id));
        if let Err(e) = self.session_db.delete_session(target_session_id).await {
            for id in &tree_ids {
                self.deleted_sessions.remove(id);
            }
            return Err(e.to_string());
        }
        let state_id = self.get_or_create_workspace_state_id(cwd);
        Ok(json!({
            "type": "session_deleted",
            "sessionId": state_id,
            "targetSessionId": target_session_id,
        }))
    }

    /// Waits (until `deadline`) for every id in `session_ids` to have no active turn.
    async fn wait_for_turns_to_settle(&self, session_ids: &[String], deadline: Instant) {
        loop {
            let notified = self.turn_settled_notify.notified();
            let Some(busy) = session_ids
                .iter()
                .find(|id| self.active_turns.contains_key(id.as_str()))
            else {
                return;
            };
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                tracing::warn!(
                    session_id = busy.as_str(),
                    "active turn did not settle before chat delete; deleting anyway"
                );
                return;
            }
            let _ = tokio::time::timeout(remaining.min(Duration::from_millis(50)), notified).await;
        }
    }

    /// Tombstones `root` and all its live and persisted descendants, cancels their child agents
    /// and turns, and waits (bounded) until each child's loop has stored its final state.
    /// Returns the whole tree, `root` first.
    async fn quiesce_session_tree_for_delete(&self, root: &str) -> Vec<String> {
        let deadline = Instant::now() + DELETE_SESSION_SETTLE_TIMEOUT;
        let mut tree = vec![root.to_owned()];
        let mut seen: HashSet<String> = tree.iter().cloned().collect();
        let mut next = 0;
        while next < tree.len() {
            let session_id = tree[next].clone();
            next += 1;
            self.deleted_sessions.insert(session_id.clone(), ());
            if session_id != root {
                self.interrupt_session_for_quiesce(&session_id, "Chat deleted");
            }
            let mut children = Vec::new();
            if let Some((_, ctrl)) = self.agent_controls.remove(&session_id) {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if let Err(e) = ctrl.quiesce_children(remaining).await {
                    tracing::warn!(session_id = session_id.as_str(), "{e}; deleting anyway");
                }
                children.extend(ctrl.list(true).into_iter().map(|a| a.agent_id));
            }
            children.extend(
                self.session_db
                    .list_session_tree_ids(&session_id)
                    .unwrap_or_default(),
            );
            for child in children {
                if seen.insert(child.clone()) {
                    tree.push(child);
                }
            }
        }
        self.wait_for_turns_to_settle(&tree[1..], deadline).await;
        tree
    }

    pub(crate) fn get_or_create_workspace_state_id(&self, cwd: &Path) -> String {
        let key = cwd.to_string_lossy().into_owned();
        if let Some(existing) = self.workspace_state_ids.get(&key) {
            return existing.value().clone();
        }
        // Atomic get-or-insert so concurrent first callers all observe the same id.
        self.workspace_state_ids
            .entry(key)
            .or_insert_with(|| format!("jsonrpc-control:{}", Uuid::new_v4()))
            .value()
            .clone()
    }

    pub fn read_workspace_state(
        &self,
        connection_id: &str,
        cwd: &Path,
    ) -> Result<Vec<Value>, String> {
        let key = cwd.to_string_lossy().into_owned();
        for mut sub in self.workspace_subscribers.iter_mut() {
            if sub.key() != &key {
                sub.value_mut().remove(connection_id);
            }
        }
        if self.is_workspace_control_events_allowed(connection_id) {
            self.workspace_subscribers
                .entry(key)
                .or_default()
                .insert(connection_id.to_owned());
        } else if let Some(mut sub) = self.workspace_subscribers.get_mut(&key) {
            sub.value_mut().remove(connection_id);
        }

        let cfg = self.load_workspace_config(cwd).map_err(|e| e.to_string())?;
        let session_id = self.get_or_create_workspace_state_id(cwd);

        let mut public_cfg = json!({
            "provider": cfg.provider,
            "model": cfg.model,
            "workingDirectory": cfg.working_directory,
        });
        if let Some(out) = &cfg.output_directory {
            public_cfg["outputDirectory"] = json!(out);
        }
        if let Some(up) = &cfg.uploads_directory {
            public_cfg["uploadsDirectory"] = json!(up);
        }

        Ok(vec![
            json!({
                "type": "config_updated",
                "sessionId": session_id,
                "config": public_cfg,
            }),
            json!({
                "type": "session_settings",
                "sessionId": session_id,
                "enableMcp": cfg.enable_mcp,
                "enableMemory": cfg.enable_memory,
                "memoryRequireApproval": cfg.memory_require_approval,
            }),
            self.build_session_config_event(&session_id, &cfg, None),
        ])
    }

    pub fn list_commands(&self, cwd: &Path) -> Vec<CommandInfo> {
        let hint_re = Regex::new(r"\$([1-9][0-9]*|ARGUMENTS)").unwrap();
        let extract_hints = |template: &str| -> Vec<String> {
            let mut nums = Vec::new();
            let mut has_args = false;
            for cap in hint_re.captures_iter(template) {
                let tok = &cap[1];
                if tok == "ARGUMENTS" {
                    has_args = true;
                } else if let Ok(n) = tok.parse::<u32>()
                    && !nums.contains(&n)
                {
                    nums.push(n);
                }
            }
            nums.sort_unstable();
            let mut out: Vec<String> = nums.into_iter().map(|n| format!("${n}")).collect();
            if has_args {
                out.push("$ARGUMENTS".to_owned());
            }
            out
        };

        let mut by_name: HashMap<String, CommandInfo> = HashMap::new();
        by_name.insert(
            "init".to_owned(),
            CommandInfo {
                name: "init".to_owned(),
                description: Some("create/update AGENTS.md".to_owned()),
                source: "command".to_owned(),
                hints: Vec::new(),
            },
        );
        by_name.insert(
            "review".to_owned(),
            CommandInfo {
                name: "review".to_owned(),
                description: Some(
                    "review changes [commit|branch|pr], defaults to uncommitted".to_owned(),
                ),
                source: "command".to_owned(),
                hints: vec!["$ARGUMENTS".to_owned()],
            },
        );

        if let Ok(cfg) = self.load_workspace_config(cwd) {
            if let Some(cmds) = &cfg.command {
                for (name, tmpl) in cmds {
                    by_name.insert(
                        name.clone(),
                        CommandInfo {
                            name: name.clone(),
                            description: tmpl.description.clone(),
                            source: "command".to_owned(),
                            hints: extract_hints(&tmpl.template),
                        },
                    );
                }
            }
            for (name, skill) in cowork_tools::discover_skills_for_config(&cfg) {
                if !skill.enabled {
                    continue;
                }
                by_name.entry(name.clone()).or_insert(CommandInfo {
                    name,
                    description: Some(skill.description),
                    source: "skill".to_owned(),
                    hints: Vec::new(),
                });
            }
        }

        let mut list: Vec<CommandInfo> = by_name.into_values().collect();
        list.sort_by(|a, b| a.name.cmp(&b.name));
        list
    }

    /// `command/execute`: resolve the slash command (built-in, configured template or enabled
    /// skill), expand its template with the arguments, and run it as a normal `turn/start` whose
    /// projected user message is the literal `/name args` text (SkillManager.ts parity).
    pub async fn execute_command_turn(
        self: &Arc<Self>,
        connection_id: &str,
        thread_id: &str,
        name: &str,
        arguments: Option<&str>,
        client_message_id: Option<&str>,
    ) -> Result<Value, JsonRpcLiteError> {
        let invalid = |m: String| JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m);
        let name = name.trim();
        if name.is_empty() {
            return Err(invalid("Command name is required".to_owned()));
        }
        let Some(live_arc) = self.subscribe(connection_id, thread_id) else {
            return Err(invalid(format!("Unknown thread: {thread_id}")));
        };
        let cwd = PathBuf::from(live_arc.lock().cwd.clone());
        let cfg = self
            .load_workspace_config(&cwd)
            .map_err(|e| invalid(format!("Failed to load workspace config: {e}")))?;
        let (resolved_name, template) = resolve_command_template(&cfg, name).map_err(invalid)?;

        let args_trimmed = arguments.unwrap_or("").trim();
        let expanded = expand_command_template(&template, args_trimmed);
        if expanded.trim().is_empty() {
            return Err(invalid(format!(
                "Command \"{name}\" expanded to empty prompt"
            )));
        }
        let slash_text = if args_trimmed.is_empty() {
            format!("/{resolved_name}")
        } else {
            format!("/{resolved_name} {args_trimmed}")
        };

        self.handle_turn_start_with_display(
            connection_id,
            false,
            &TurnStartParams {
                thread_id: thread_id.to_owned(),
                client_message_id: client_message_id.map(str::to_owned),
                input: TurnInput::Text(expanded),
                references: None,
                retry: None,
            },
            Some(slash_text),
        )
        .await
    }

    pub async fn build_provider_catalog_payload(&self, cwd: &Path) -> Value {
        self.read_provider_catalog(cwd, false).await
    }

    pub async fn run_creation_preflight(
        &self,
        params: &CreationPreflightParams,
    ) -> Result<CreationPreflightResult, String> {
        if params.kind != "chat" && params.kind != "task" {
            return Err(format!(
                "Unsupported creation preflight kind: {}",
                params.kind
            ));
        }

        let mut checks = Vec::new();
        let workspace = match self
            .resolve_workspace_path(params.cwd.as_deref(), "cowork/creation/preflight")
        {
            Ok(ws) => {
                if params.kind == "task"
                    && cowork_config::is_path_inside_one_off_chats_root(&ws, &self.homedir)
                {
                    checks.push(CreationReadinessCheck {
                        id: "project_access".to_owned(),
                        status: "blocked".to_owned(),
                        message: "Tasks run inside a project workspace. Choose a project instead of a quick chat.".to_owned(),
                        repair_action: None,
                    });
                    return Ok(CreationPreflightResult {
                        ready: false,
                        checks,
                    });
                }
                checks.push(CreationReadinessCheck {
                    id: "project_access".to_owned(),
                    status: "ok".to_owned(),
                    message: format!("Workspace is accessible: {}", ws.to_string_lossy()),
                    repair_action: None,
                });
                ws
            }
            Err(msg) => {
                checks.push(CreationReadinessCheck {
                    id: "project_access".to_owned(),
                    status: "blocked".to_owned(),
                    message: msg,
                    repair_action: None,
                });
                return Ok(CreationPreflightResult {
                    ready: false,
                    checks,
                });
            }
        };

        let cfg = self
            .load_workspace_config(&workspace)
            .map_err(|e| e.to_string())?;
        let provider_str = params
            .provider
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| cfg.provider.as_str());
        let model_str = params
            .model
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(&cfg.model);

        let catalog = self.build_provider_catalog_payload(&workspace).await;
        let provider_entry = catalog["all"]
            .as_array()
            .and_then(|arr| arr.iter().find(|e| e["id"].as_str() == Some(provider_str)));

        let provider_label = provider_entry
            .and_then(|e| e["name"].as_str())
            .unwrap_or(provider_str);

        if let Some(entry) = provider_entry
            && entry["state"].as_str() != Some("unreachable")
        {
            checks.push(CreationReadinessCheck {
                id: "provider_connected".to_owned(),
                status: "ok".to_owned(),
                message: format!("{provider_label} is available."),
                repair_action: None,
            });
        } else {
            checks.push(CreationReadinessCheck {
                id: "provider_connected".to_owned(),
                status: "blocked".to_owned(),
                message: format!("Provider {provider_str} is unavailable."),
                repair_action: Some(CreationRepairAction::OpenProviderSettings {
                    provider: provider_str.to_owned(),
                }),
            });
        }

        let is_connected = provider_str == "lmstudio"
            || catalog["connected"]
                .as_array()
                .is_some_and(|arr| arr.iter().any(|v| v.as_str() == Some(provider_str)));

        if is_connected {
            checks.push(CreationReadinessCheck {
                id: "credentials".to_owned(),
                status: "ok".to_owned(),
                message: format!("Credentials for {provider_label} are ready."),
                repair_action: None,
            });
        } else {
            checks.push(CreationReadinessCheck {
                id: "credentials".to_owned(),
                status: "blocked".to_owned(),
                message: format!(
                    "Connect {provider_label} before starting this {}.",
                    params.kind
                ),
                repair_action: Some(CreationRepairAction::ConnectProvider {
                    provider: provider_str.to_owned(),
                }),
            });
        }

        let model_found = provider_entry
            .and_then(|e| e["models"].as_array())
            .and_then(|models| {
                models.iter().find(|m| {
                    (m["id"].as_str() == Some(model_str) || m["model"].as_str() == Some(model_str))
                        && m.get("enabled").and_then(Value::as_bool) != Some(false)
                })
            });

        if let Some(m) = model_found {
            let disp = m["displayName"].as_str().unwrap_or(model_str);
            checks.push(CreationReadinessCheck {
                id: "model_available".to_owned(),
                status: "ok".to_owned(),
                message: format!("{disp} is available."),
                repair_action: None,
            });
        } else {
            checks.push(CreationReadinessCheck {
                id: "model_available".to_owned(),
                status: "blocked".to_owned(),
                message: format!("Model {model_str} is not available for {provider_label}."),
                repair_action: Some(CreationRepairAction::OpenProviderSettings {
                    provider: provider_str.to_owned(),
                }),
            });
        }

        let startup = self.startup_snapshot();
        let (status, message) = if let Some(error) = startup.error {
            (
                "blocked",
                format!("Cowork runtime failed to start: {error}"),
            )
        } else if startup.ready {
            ("ok", "Runtime is ready.".to_owned())
        } else {
            (
                "pending",
                "Cowork is finishing setup in the background.".to_owned(),
            )
        };
        checks.push(CreationReadinessCheck {
            id: "runtime_ready".to_owned(),
            status: status.to_owned(),
            message,
            repair_action: None,
        });

        let ready = checks.iter().all(|c| c.status != "blocked");
        Ok(CreationPreflightResult { ready, checks })
    }

    pub fn effective_tool_env(&self) -> HashMap<String, String> {
        let mut merged = self.env.clone();
        for (k, v) in self.runtime_env_overlay.read().iter() {
            merged.insert(k.clone(), v.clone());
        }
        merged
    }

    pub fn startup_snapshot(&self) -> RuntimeDiagnosticsStartup {
        self.startup_state.lock().clone()
    }

    pub async fn wait_for_startup_ready(&self) {
        loop {
            {
                let st = self.startup_state.lock();
                if st.ready || st.error.is_some() {
                    return;
                }
            }
            let notified = self.startup_notify.notified();
            {
                let st = self.startup_state.lock();
                if st.ready || st.error.is_some() {
                    return;
                }
            }
            notified.await;
        }
    }

    /// [`Self::wait_for_startup_ready`] capped at `timeout`; returns whether startup settled.
    pub async fn wait_for_startup_ready_bounded(&self, timeout: std::time::Duration) -> bool {
        tokio::time::timeout(timeout, self.wait_for_startup_ready())
            .await
            .is_ok()
    }

    /// Spawns asynchronous runtime pack verification/bootstrap without blocking `start_server`.
    pub fn start_background_runtime_bootstrap(
        self: &Arc<Self>,
        trusted_keys_override: Option<cowork_env::TrustedKeyRing>,
        on_runtime_progress: Option<cowork_env::RuntimeProgressCallback>,
    ) {
        let already_settled = {
            let st = self.startup_state.lock();
            st.ready || st.error.is_some()
        };
        if already_settled {
            self.startup_notify.notify_waiters();
            return;
        }

        let this = Arc::clone(self);
        let progress_target = Arc::clone(self);
        let trusted_keys = match trusted_keys_override {
            Some(ring) => {
                *self.runtime_trusted_keys.write() = ring.clone();
                ring
            }
            None => cowork_env::TrustedKeyRing::with_official_defaults(),
        };

        let handle = tokio::spawn(async move {
            let on_progress: cowork_env::RuntimeProgressCallback = Arc::new(move |evt| {
                progress_target.startup_state.lock().progress = Some(RuntimeDiagnosticsProgress {
                    phase: evt.progress.phase.as_str().to_owned(),
                    version: evt.progress.version.clone(),
                    transferred_bytes: evt.progress.transferred_bytes,
                    total_bytes: evt.progress.total_bytes,
                    percent: evt.progress.percent,
                });
                if let Some(report) = &on_runtime_progress {
                    report(evt);
                }
            });

            let outcome =
                cowork_env::ensure_leased_cowork_runtime_ready(cowork_env::EnsureRuntimeOptions {
                    homedir: this.homedir.clone(),
                    env: this.env.clone(),
                    trusted_keys,
                    on_progress: Some(on_progress),
                })
                .await;

            match outcome {
                Ok((prepared, lease)) => {
                    *this.runtime_lease.lock() = lease;
                    let cowork_home = this.homedir.join(".cowork");
                    let canonical_env =
                        cowork_env::build_canonical_shell_env(cowork_env::ShellEnvOptions {
                            base_env: &this.env,
                            runtime: Some(&prepared),
                            uv_env: None,
                            extra_env: None,
                            platform: cowork_sandbox::host_platform(),
                            sandboxed: false,
                            cowork_home: Some(&cowork_home),
                        });
                    *this.runtime_env_overlay.write() = canonical_env;
                    let mut st = this.startup_state.lock();
                    st.ready = true;
                    st.error = None;
                }
                Err(cowork_env::EnvError::RuntimeDisabled)
                | Err(cowork_env::EnvError::NetworkDisabled(_)) => {
                    let mut st = this.startup_state.lock();
                    st.ready = true;
                    st.error = None;
                }
                Err(err) => {
                    let mut st = this.startup_state.lock();
                    st.ready = false;
                    st.error = Some(cowork_env::redact_secrets(&err.to_string()));
                }
            }
            this.startup_notify.notify_waiters();
        });

        *self.bootstrap_task.lock() = Some(handle);
    }

    pub async fn handle_runtime_libreoffice_check(
        &self,
        smoke: bool,
    ) -> RuntimeLibreOfficeCheckResult {
        let env = self.effective_tool_env();
        let diag = self
            .soffice_runner
            .check_capability(&self.working_directory, &env, smoke)
            .await;
        let status_str = match diag.status {
            cowork_env::LibreOfficeCheckStatus::Available => "available",
            cowork_env::LibreOfficeCheckStatus::Unavailable => "unavailable",
        };
        RuntimeLibreOfficeCheckResult {
            status: RuntimeLibreOfficeStatusView {
                status: status_str.to_owned(),
                checked_at: diag.checked_at,
                message: diag.message,
                version: diag.version,
                resolved_path: diag.resolved_path,
                smoke: diag.smoke.map(|s| RuntimeLibreOfficeSmokeStatus {
                    ok: s.ok,
                    duration_ms: s.duration_ms,
                    size_bytes: s.size_bytes,
                    error: s.error,
                }),
            },
        }
    }

    pub fn handle_runtime_diagnostics_read(&self) -> RuntimeDiagnosticsReadResult {
        let startup = self.startup_snapshot();
        let q = self.send_queue.stats();
        let j = self.journal.get_aggregate_health();
        let db = self.session_db.write_lock_diagnostics();

        RuntimeDiagnosticsReadResult {
            diagnostics: RuntimeDiagnosticsPayload {
                startup,
                send_queue: RuntimeDiagnosticsSendQueue {
                    queued_sends: q.queued_sends,
                    dropped_deltas: q.dropped_deltas,
                    dropped_important: q.dropped_important,
                    serialization_failures: q.serialization_failures,
                    send_failures: q.send_failures,
                    external_sink_failures: q.external_sink_failures,
                    max_queue_depth: q.max_queue_depth,
                    queue_depth_by_connection: q.queue_depth_by_connection,
                },
                journal: RuntimeDiagnosticsJournal {
                    untrusted_thread_count: j.untrusted_thread_count,
                    failed_write_count: j.failed_write_count,
                    dropped_event_count: j.dropped_event_count,
                    pending_thread_count: j.pending_thread_count,
                },
                db_locks: RuntimeDiagnosticsDbLocks {
                    wait_count: db.wait_count,
                    timeout_count: db.timeout_count,
                    sqlite_lock_error_count: db.sqlite_lock_error_count,
                    stale_recovery_count: db.stale_recovery_count,
                    last_wait_ms: db.last_wait_ms,
                    max_wait_ms: db.max_wait_ms,
                },
            },
        }
    }

    pub fn list_child_agents(
        &self,
        parent_session_id: &str,
        include_closed: bool,
    ) -> Vec<cowork_harness::PersistentAgentSummary> {
        self.agent_controls
            .get(parent_session_id)
            .map(|c| c.list(include_closed))
            .unwrap_or_default()
    }

    pub async fn shutdown(&self) {
        let mobile_h3 = self.mobile_h3.write().take();
        if let Some(h3) = mobile_h3 {
            h3.stop().await;
        }
        if let Some(task) = self.bootstrap_task.lock().take() {
            task.abort();
        }
        {
            let mut st = self.startup_state.lock();
            if !st.ready {
                st.ready = true;
                st.error = Some("Server stopped before startup completed".to_owned());
            }
        }
        self.startup_notify.notify_waiters();
        if let Some(bus) = self.skill_mutation_bus.lock().take() {
            bus.stop();
        }
        if let Some((_, ticker)) = self.skill_improvement.lock().take()
            && let Some(h) = ticker
        {
            h.abort();
        }
        for entry in self.agent_controls.iter() {
            entry.value().interrupt_running_children();
        }
        self.agent_controls.clear();
        self.mcp_tool_cache.close_all().await;
        self.soffice_runner.shutdown().await;
        *self.runtime_lease.lock() = None;
        self.pending_codex_logins.clear();
        self.codex_pool.close_all().await;
        self.task_subscribers.clear();
        self.connection_access.clear();
        self.ws_sinks.clear();
        self.sessions.clear();
        self.journal.close().await;
        self.session_db.close();
        self.observability
            .record_server_event("info", "server.stopped", None, None);
        self.observability.flush().await;
    }
}

/// Reduce a client-supplied upload filename to one safe path component.
///
/// Both `/` and `\` are treated as separators on every platform (clients may send Windows
/// paths), the last component is kept, and `.`/`..`/empty names are rejected. NUL, control
/// characters and `:` (NTFS alternate-data-stream syntax) are replaced with `_`.
pub fn sanitize_workspace_upload_filename(filename: &str) -> Result<String, String> {
    let last = filename
        .trim()
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .trim();
    if last.is_empty() || last == "." || last == ".." {
        return Err("Invalid upload filename".to_owned());
    }
    Ok(last
        .chars()
        .map(|c| if c.is_control() || c == ':' { '_' } else { c })
        .collect())
}

/// Write an uploaded file to `<workspace>/uploads/<uuid>-<filename>` without following symlinks.
///
/// `uploads` must be a real directory directly inside the canonical workspace (it is created
/// with mode 0700 when missing); a symlink or reparse point there is refused rather than
/// followed. The file is created exclusively (`O_CREAT|O_EXCL|O_NOFOLLOW` on Unix, relative to
/// the already-opened `uploads` directory so the checks cannot be raced by swapping path
/// components). Returns the sanitized filename and the written path.
pub fn write_workspace_upload(
    workspace: &Path,
    filename: &str,
    bytes: &[u8],
) -> Result<(String, PathBuf), String> {
    use std::io::Write;

    let clean_name = sanitize_workspace_upload_filename(filename)?;
    let canonical_ws = std::fs::canonicalize(workspace)
        .map_err(|e| format!("Invalid upload workspace '{}': {e}", workspace.display()))?;
    let uploads_dir = canonical_ws.join("uploads");
    let file_name = format!("{}-{clean_name}", Uuid::new_v4());
    let dst = uploads_dir.join(&file_name);
    if dst.parent() != Some(uploads_dir.as_path()) || uploads_dir.parent() != Some(&canonical_ws) {
        return Err("Invalid upload filename".to_owned());
    }

    let mut file = create_upload_file_nofollow(&canonical_ws, &file_name)?;
    // Defense in depth: the directory we wrote into must canonicalize to `<workspace>/uploads`.
    let canonical_uploads = std::fs::canonicalize(&uploads_dir)
        .map_err(|e| format!("Failed to resolve uploads directory: {e}"))?;
    let write_result = if canonical_uploads != uploads_dir {
        Err("Refusing to write upload: uploads directory escapes the workspace".to_owned())
    } else {
        file.write_all(bytes)
            .and_then(|()| file.sync_all())
            .map_err(|e| format!("Failed to write upload: {e}"))
    };
    if let Err(e) = write_result {
        drop(file);
        if canonical_uploads == uploads_dir {
            let _ = std::fs::remove_file(&dst);
        }
        return Err(e);
    }
    Ok((clean_name, dst))
}

/// No-follow, exclusive creation of `<workspace>/uploads/<file_name>` (shared with inline turn
/// attachments); a symlinked or non-directory `uploads` is refused rather than followed.
fn create_upload_file_nofollow(workspace: &Path, file_name: &str) -> Result<std::fs::File, String> {
    cowork_harness::attachments::create_new_file_no_follow(workspace, &["uploads"], file_name)
        .map_err(|e| format!("Failed to write upload: {e}"))
}

const BUILTIN_COMMAND_FALLBACK_TEMPLATES: [(&str, &str); 2] = [
    (
        "init",
        "Create or update an AGENTS.md file for this repository.\n\n$ARGUMENTS",
    ),
    (
        "review",
        "Review the current changes.\n\nTarget: $ARGUMENTS",
    ),
];

/// Resolve a slash command to `(canonical name, template)` with `command/list` precedence:
/// configured templates override the built-ins, and enabled skills fill the remaining names
/// (rendered with the same untrusted-project framing the skill tool uses).
pub fn resolve_command_template(cfg: &AgentConfig, name: &str) -> Result<(String, String), String> {
    let wanted = name.trim();
    let matches = |candidate: &str| candidate == wanted || candidate.eq_ignore_ascii_case(wanted);

    if let Some(cmds) = &cfg.command {
        let mut keys: Vec<&String> = cmds.keys().collect();
        keys.sort();
        // Exact key first, then case-insensitive (TS normalized names to lowercase).
        let hit = keys
            .iter()
            .find(|k| k.as_str() == wanted)
            .or_else(|| keys.iter().find(|k| matches(k)));
        if let Some(key) = hit {
            let template = cmds[*key].template.trim();
            if !template.is_empty() {
                return Ok(((*key).clone(), template.to_owned()));
            }
        }
    }

    for (builtin, fallback) in BUILTIN_COMMAND_FALLBACK_TEMPLATES {
        if matches(builtin) {
            let path = cfg
                .built_in_dir
                .join("prompts")
                .join("commands")
                .join(format!("{builtin}.txt"));
            let template = std::fs::read_to_string(&path)
                .ok()
                .map(|raw| raw.trim().to_owned())
                .filter(|t| !t.is_empty())
                .unwrap_or_else(|| fallback.to_owned());
            return Ok((builtin.to_owned(), template));
        }
    }

    let skills = cowork_tools::discover_skills_for_config(cfg);
    let skill = skills
        .get(wanted)
        .or_else(|| skills.values().find(|s| matches(&s.name)))
        .filter(|s| s.enabled);
    if let Some(skill) = skill {
        let body = cowork_tools::render_skill_body_for_model(skill)
            .map_err(|e| format!("Failed to read skill command '{}': {e}", skill.name))?;
        return Ok((skill.name.clone(), body));
    }
    Err(format!("Unknown command: {wanted}"))
}

/// Expand `$ARGUMENTS` and `$1..$N` in a command template (commands.ts parity): the highest
/// numbered placeholder takes the remaining tokens, missing tokens expand to nothing, and the
/// arguments are appended when the template has no placeholders. Replacement text is literal.
pub fn expand_command_template(template: &str, arguments: &str) -> String {
    static TOKEN_RE: OnceLock<Regex> = OnceLock::new();
    static PLACEHOLDER_RE: OnceLock<Regex> = OnceLock::new();
    let token_re = TOKEN_RE.get_or_init(|| {
        Regex::new(r#"(?i)\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+"#).expect("valid token regex")
    });
    let placeholder_re = PLACEHOLDER_RE
        .get_or_init(|| Regex::new(r"\$ARGUMENTS|\$(\d+)").expect("valid placeholder regex"));

    let trimmed = arguments.trim();
    let tokens: Vec<String> = token_re
        .find_iter(trimmed)
        .map(|m| {
            let t = m.as_str();
            let t = t.strip_prefix(['"', '\'']).unwrap_or(t);
            t.strip_suffix(['"', '\'']).unwrap_or(t).to_owned()
        })
        .collect();
    let mut max_placeholder = 0usize;
    let mut has_numbered = false;
    for caps in placeholder_re.captures_iter(template) {
        if let Some(n) = caps.get(1) {
            has_numbered = true;
            if let Ok(v) = n.as_str().parse::<usize>() {
                max_placeholder = max_placeholder.max(v);
            }
        }
    }
    let uses_arguments = template.contains("$ARGUMENTS");

    let mut output = placeholder_re
        .replace_all(template, |caps: &regex::Captures<'_>| {
            let Some(n) = caps.get(1) else {
                return trimmed.to_owned();
            };
            let Ok(index) = n.as_str().parse::<usize>() else {
                return String::new();
            };
            if index < 1 || index > tokens.len() {
                return String::new();
            }
            if index == max_placeholder {
                return tokens[index - 1..].join(" ");
            }
            tokens[index - 1].clone()
        })
        .into_owned();
    if !has_numbered && !uses_arguments && !trimmed.is_empty() {
        output = format!("{output}\n\n{trimmed}");
    }
    output.trim().to_owned()
}

/// Upper bound on how long `cowork/session/delete` waits for a cancelled turn to settle.
const DELETE_SESSION_SETTLE_TIMEOUT: Duration = Duration::from_secs(10);

// `src/shared/openaiCompatibleOptions.ts` value sets for the editable provider options.
const EDITABLE_REASONING_EFFORT_VALUES: [&str; 8] = [
    "none", "minimal", "light", "low", "medium", "high", "xhigh", "max",
];
const EDITABLE_REASONING_SUMMARY_VALUES: [&str; 3] = ["auto", "concise", "detailed"];
const EDITABLE_TEXT_VERBOSITY_VALUES: [&str; 3] = ["low", "medium", "high"];
const EDITABLE_CODEX_WEB_SEARCH_BACKEND_VALUES: [&str; 3] = ["native", "exa", "parallel"];
const EDITABLE_LOCAL_WEB_SEARCH_PROVIDER_VALUES: [&str; 2] = ["exa", "parallel"];
const EDITABLE_CODEX_WEB_SEARCH_MODE_VALUES: [&str; 3] = ["disabled", "cached", "live"];
const EDITABLE_CODEX_WEB_SEARCH_CONTEXT_SIZE_VALUES: [&str; 3] = ["low", "medium", "high"];
const EDITABLE_GOOGLE_THINKING_LEVEL_VALUES: [&str; 4] = ["minimal", "low", "medium", "high"];

/// `EDITABLE_PROVIDER_OPTIONS_PROVIDER_NAMES`, in the order the TS merge walks them.
const EDITABLE_PROVIDER_OPTION_SECTIONS: [&str; 4] = ["openai", "codex-cli", "google", "lmstudio"];

/// Copies `obj[key]` into `dst` when it is exactly one of `allowed` (TS `is*` enum guards).
fn pick_enum_into(
    dst: &mut Map<String, Value>,
    obj: &Map<String, Value>,
    key: &str,
    allowed: &[&str],
) {
    if let Some(s) = obj.get(key).and_then(Value::as_str)
        && allowed.contains(&s)
    {
        dst.insert(key.to_owned(), Value::String(s.to_owned()));
    }
}

/// TS `pickTrimmedString`.
fn pick_trimmed_string(value: Option<&Value>) -> Option<String> {
    let trimmed = value?.as_str()?.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

/// TS `pickPositiveInteger`: a finite number or numeric string, floored, kept when positive.
fn pick_positive_integer(value: Option<&Value>) -> Option<u64> {
    let n = match value? {
        Value::Number(n) => n.as_f64()?,
        Value::String(s) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                return None;
            }
            trimmed.parse::<f64>().ok()?
        }
        _ => return None,
    };
    if !n.is_finite() {
        return None;
    }
    let floored = n.floor();
    (floored >= 1.0).then_some(floored as u64)
}

/// TS `pickBoolean`: a boolean or a yes/no style string.
fn pick_boolean(value: Option<&Value>) -> Option<bool> {
    match value? {
        Value::Bool(b) => Some(*b),
        Value::String(s) => match s.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "y" | "on" => Some(true),
            "0" | "false" | "no" | "n" | "off" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

/// TS `pickOpenAiCompatibleProviderOptionsSection`, without the empty-section check.
fn pick_openai_compatible_fields(obj: &Map<String, Value>) -> Map<String, Value> {
    let mut dst = Map::new();
    pick_enum_into(
        &mut dst,
        obj,
        "reasoningEffort",
        &EDITABLE_REASONING_EFFORT_VALUES,
    );
    pick_enum_into(
        &mut dst,
        obj,
        "reasoningSummary",
        &EDITABLE_REASONING_SUMMARY_VALUES,
    );
    pick_enum_into(
        &mut dst,
        obj,
        "textVerbosity",
        &EDITABLE_TEXT_VERBOSITY_VALUES,
    );
    dst
}

/// TS `pickCodexWebSearchOptions`. An explicit `location` object is kept even when no field
/// survives, because the merge reads `location: {}` as "clear the stored location".
fn pick_codex_web_search(obj: &Map<String, Value>) -> Option<Map<String, Value>> {
    let mut dst = Map::new();
    pick_enum_into(
        &mut dst,
        obj,
        "contextSize",
        &EDITABLE_CODEX_WEB_SEARCH_CONTEXT_SIZE_VALUES,
    );
    if let Some(domains) = obj.get("allowedDomains").and_then(Value::as_array) {
        let kept: Vec<Value> = domains
            .iter()
            .filter_map(|d| pick_trimmed_string(Some(d)))
            .map(Value::String)
            .collect();
        dst.insert("allowedDomains".to_owned(), Value::Array(kept));
    }
    if let Some(loc) = obj.get("location").and_then(Value::as_object) {
        let mut loc_dst = Map::new();
        for key in ["country", "region", "city", "timezone"] {
            if let Some(s) = pick_trimmed_string(loc.get(key)) {
                loc_dst.insert(key.to_owned(), Value::String(s));
            }
        }
        dst.insert("location".to_owned(), Value::Object(loc_dst));
    }
    (!dst.is_empty()).then_some(dst)
}

/// TS `pickCodexCliProviderOptionsSection`.
fn pick_codex_cli_section(obj: &Map<String, Value>) -> Option<Map<String, Value>> {
    let mut dst = pick_openai_compatible_fields(obj);
    pick_enum_into(
        &mut dst,
        obj,
        "webSearchBackend",
        &EDITABLE_CODEX_WEB_SEARCH_BACKEND_VALUES,
    );
    pick_enum_into(
        &mut dst,
        obj,
        "webSearchFallbackBackend",
        &EDITABLE_LOCAL_WEB_SEARCH_PROVIDER_VALUES,
    );
    pick_enum_into(
        &mut dst,
        obj,
        "webSearchMode",
        &EDITABLE_CODEX_WEB_SEARCH_MODE_VALUES,
    );
    if let Some(ws) = obj
        .get("webSearch")
        .and_then(Value::as_object)
        .and_then(pick_codex_web_search)
    {
        dst.insert("webSearch".to_owned(), Value::Object(ws));
    }
    (!dst.is_empty()).then_some(dst)
}

/// TS `pickGoogleThinkingConfig`: a valid `thinkingLevel`, or `{}` for an explicit empty
/// object (which the merge reads as "clear the stored level").
fn pick_google_thinking_config(obj: &Map<String, Value>) -> Option<Map<String, Value>> {
    let mut dst = Map::new();
    pick_enum_into(
        &mut dst,
        obj,
        "thinkingLevel",
        &EDITABLE_GOOGLE_THINKING_LEVEL_VALUES,
    );
    if !dst.is_empty() || obj.is_empty() {
        Some(dst)
    } else {
        None
    }
}

/// TS `pickGoogleProviderOptionsSection`. A `null` `responseFormat` is dropped (TS kept any
/// defined value) so the Google request never carries `response_format: null`.
fn pick_google_section(obj: &Map<String, Value>) -> Option<Map<String, Value>> {
    let mut dst = Map::new();
    if let Some(b) = pick_boolean(obj.get("nativeWebSearch")) {
        dst.insert("nativeWebSearch".to_owned(), Value::Bool(b));
    }
    if let Some(tc) = obj
        .get("thinkingConfig")
        .and_then(Value::as_object)
        .and_then(pick_google_thinking_config)
    {
        dst.insert("thinkingConfig".to_owned(), Value::Object(tc));
    }
    if let Some(rf) = obj.get("responseFormat")
        && !rf.is_null()
    {
        dst.insert("responseFormat".to_owned(), rf.clone());
    }
    if let Some(mime) = pick_trimmed_string(obj.get("responseMimeType")) {
        dst.insert("responseMimeType".to_owned(), Value::String(mime));
    }
    (!dst.is_empty()).then_some(dst)
}

/// TS `pickLmStudioProviderOptionsSection`. `baseUrl` is editable for LM Studio alone (a local
/// server); every cloud provider endpoint stays non-editable.
fn pick_lmstudio_section(obj: &Map<String, Value>) -> Option<Map<String, Value>> {
    let mut dst = Map::new();
    if let Some(url) = pick_trimmed_string(obj.get("baseUrl")) {
        dst.insert("baseUrl".to_owned(), Value::String(url));
    }
    if let Some(n) = pick_positive_integer(obj.get("contextLength")) {
        dst.insert("contextLength".to_owned(), Value::from(n));
    }
    for key in ["autoLoad", "reloadOnContextMismatch"] {
        if let Some(b) = pick_boolean(obj.get(key)) {
            dst.insert(key.to_owned(), Value::Bool(b));
        }
    }
    (!dst.is_empty()).then_some(dst)
}

/// The editable fields of one provider section (`undefined` in TS when nothing is editable).
fn pick_editable_provider_section(provider: &str, section: &Value) -> Option<Map<String, Value>> {
    let obj = section.as_object()?;
    match provider {
        "openai" => {
            let dst = pick_openai_compatible_fields(obj);
            (!dst.is_empty()).then_some(dst)
        }
        "codex-cli" => pick_codex_cli_section(obj),
        "google" => pick_google_section(obj),
        "lmstudio" => pick_lmstudio_section(obj),
        _ => None,
    }
}

/// Layers a session's stored `providerOptions` override onto the workspace provider options one
/// provider section deep: a section's keys replace the workspace section's keys, and a
/// non-object value replaces the entry. This is the merge the root turn runner applies before
/// a turn (`turn_runner.rs`), so anything reporting the effective session options must use it.
pub(crate) fn overlay_session_provider_options(
    base: &mut Map<String, Value>,
    over: Map<String, Value>,
) {
    for (k, v) in over {
        match (base.get_mut(&k), v) {
            (Some(Value::Object(existing)), Value::Object(over_section)) => {
                existing.extend(over_section);
            }
            (_, other) => {
                base.insert(k, other);
            }
        }
    }
}

/// `pickEditableOpenAiCompatibleProviderOptions` parity.
fn pick_editable_provider_options(po: &Map<String, Value>) -> Option<Map<String, Value>> {
    let mut out = Map::new();
    for provider in EDITABLE_PROVIDER_OPTION_SECTIONS {
        if let Some(section) = po
            .get(provider)
            .and_then(|s| pick_editable_provider_section(provider, s))
        {
            out.insert(provider.to_owned(), Value::Object(section));
        }
    }
    (!out.is_empty()).then_some(out)
}

/// `mergeEditableOpenAiCompatibleProviderOptions` parity for one Codex section: the patch's
/// `webSearch` merges into the stored one, and its `location` merges field by field (an
/// explicit empty `location` clears it).
fn merge_codex_cli_section(
    current: &Map<String, Value>,
    patch: Map<String, Value>,
) -> Map<String, Value> {
    let mut next_web_search = current
        .get("webSearch")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut patch_web_search = patch
        .get("webSearch")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let current_location = next_web_search
        .get("location")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let patch_location = patch_web_search.remove("location");
    let resolved_location = match &patch_location {
        Some(loc) => {
            let loc = loc.as_object().cloned().unwrap_or_default();
            (!loc.is_empty()).then(|| {
                let mut merged = current_location;
                merged.extend(loc);
                merged
            })
        }
        None => (!current_location.is_empty()).then_some(current_location),
    };
    next_web_search.extend(patch_web_search);
    match resolved_location {
        Some(loc) => {
            next_web_search.insert("location".to_owned(), Value::Object(loc));
        }
        None if patch_location.is_some() => {
            next_web_search.remove("location");
        }
        None => {}
    }

    let mut next = current.clone();
    next.extend(patch);
    if !next_web_search.is_empty() {
        next.insert("webSearch".to_owned(), Value::Object(next_web_search));
    }
    next
}

/// `mergeEditableOpenAiCompatibleProviderOptions` parity for one Google section. Whenever the
/// raw patch names `thinkingConfig` (even with no editable field), the stored `thinkingConfig`
/// is kept and only its `thinkingLevel` is set or, when the patch has none, removed.
fn merge_google_section(
    current: &Map<String, Value>,
    patch: Map<String, Value>,
    raw_patch: &Value,
) -> Map<String, Value> {
    let patch_has_thinking_config = raw_patch
        .as_object()
        .is_some_and(|raw| raw.contains_key("thinkingConfig"));
    let patch_level = patch
        .get("thinkingConfig")
        .and_then(|tc| tc.get("thinkingLevel"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|level| !level.is_empty())
        .map(str::to_owned);
    let mut next = current.clone();
    next.extend(patch);
    if patch_has_thinking_config {
        let mut thinking_config = current
            .get("thinkingConfig")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        match patch_level {
            Some(level) => {
                thinking_config.insert("thinkingLevel".to_owned(), Value::String(level));
            }
            None => {
                thinking_config.remove("thinkingLevel");
            }
        }
        next.insert("thinkingConfig".to_owned(), Value::Object(thinking_config));
    }
    next
}

/// Merges a raw client `providerOptions` patch into a stored override
/// (`mergeEditableOpenAiCompatibleProviderOptions` parity): each editable provider section is
/// reduced to its editable fields and merged over the stored section, so sibling settings set
/// by an earlier patch (e.g. `/reasoning` then `/verbosity`) survive. A section with nothing
/// editable, a `null` value or an unknown enum value leaves the stored section untouched. The
/// session tool-exposure toggles are merged as top-level booleans.
fn merge_editable_provider_options(
    base: Option<&Map<String, Value>>,
    patch: &Map<String, Value>,
) -> Option<Map<String, Value>> {
    let mut current = base.cloned().unwrap_or_default();
    for provider in EDITABLE_PROVIDER_OPTION_SECTIONS {
        let Some(raw_section) = patch.get(provider) else {
            continue;
        };
        let Some(cleaned) = pick_editable_provider_section(provider, raw_section) else {
            continue;
        };
        let current_section = current
            .get(provider)
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let next = match provider {
            "codex-cli" => merge_codex_cli_section(&current_section, cleaned),
            "google" => merge_google_section(&current_section, cleaned, raw_section),
            _ => {
                let mut next = current_section;
                next.extend(cleaned);
                next
            }
        };
        current.insert(provider.to_owned(), Value::Object(next));
    }
    for key in SESSION_TOOL_EXPOSURE_KEYS {
        if let Some(b) = patch.get(key).and_then(Value::as_bool) {
            current.insert(key.to_owned(), Value::Bool(b));
        }
    }
    // SECURITY BOUNDARY: a stored override may predate client-side filtering; never carry an
    // endpoint, header or credential override forward through a merge.
    cowork_config::strip_provider_option_endpoints(&mut current);
    (!current.is_empty()).then_some(current)
}

/// Top-level boolean tool-exposure toggles the Rust turn runner reads from session
/// `providerOptions` (`turn_runner.rs`). They select tools, never endpoints or credentials.
const SESSION_TOOL_EXPOSURE_KEYS: [&str; 2] = ["deferredToolSearch", "codeMode"];

/// Reduces a client-supplied `providerOptions` map to what a session may store: the editable
/// allowlist (`pickEditableOpenAiCompatibleProviderOptions` parity) plus the boolean
/// tool-exposure toggles.
fn editable_session_provider_options(po: &Map<String, Value>) -> Option<Map<String, Value>> {
    let mut out = pick_editable_provider_options(po).unwrap_or_default();
    for key in SESSION_TOOL_EXPOSURE_KEYS {
        if let Some(b) = po.get(key).and_then(Value::as_bool) {
            out.insert(key.to_owned(), Value::Bool(b));
        }
    }
    (!out.is_empty()).then_some(out)
}

/// Merges a client-supplied partial `providerOptions` patch into the session override
/// (`SessionMetadataManager` → `mergeEditableOpenAiCompatibleProviderOptions` parity): only the
/// editable allowlist is merged, unknown keys are dropped silently, sibling settings and nested
/// values from earlier patches are kept, and a patch with nothing editable (or a non-object
/// patch such as `null`) leaves the current override untouched.
///
/// SECURITY BOUNDARY: `cowork/session/config/set` is reachable by any local client, so cloud
/// provider `baseUrl`/`headers`/credential overrides must never be persisted; the next turn
/// would send the user's saved API key to the client-chosen URL. Only `lmstudio.baseUrl`
/// (a local server) is editable, as in the TypeScript schema.
fn store_client_provider_options(overrides: &mut Map<String, Value>, value: &Value) {
    let Some(patch) = value.as_object() else {
        return;
    };
    let merged = merge_editable_provider_options(
        overrides.get("providerOptions").and_then(Value::as_object),
        patch,
    );
    match merged {
        Some(po) => {
            overrides.insert("providerOptions".to_owned(), Value::Object(po));
        }
        None => {
            overrides.remove("providerOptions");
        }
    }
}

/// Validates and filters the `providerOptions` of a `cowork/session/defaults/apply` config
/// patch. The TypeScript request schema was `.strict()` here, so an endpoint, header or
/// credential override is rejected outright; other keys are reduced to the editable allowlist.
fn sanitize_session_defaults_config_patch(
    mut cp: Map<String, Value>,
) -> Result<Map<String, Value>, String> {
    let Some(raw) = cp.remove("providerOptions") else {
        return Ok(cp);
    };
    let Value::Object(po) = raw else {
        return Err("providerOptions must be an object".to_owned());
    };
    let mut stripped = po.clone();
    cowork_config::strip_provider_option_endpoints(&mut stripped);
    if stripped != po {
        return Err(
            "providerOptions cannot override provider endpoints, headers or credentials".to_owned(),
        );
    }
    if let Some(editable) = editable_session_provider_options(&po) {
        cp.insert("providerOptions".to_owned(), Value::Object(editable));
    }
    Ok(cp)
}

/// Maps a `clear*` sentinel in a session config patch to the config key it clears.
fn cleared_config_key(key: &str) -> Option<&'static str> {
    match key {
        "clearMemoryGenerationModel" => Some("memoryGenerationModel"),
        "clearSkillImprovementModel" => Some("skillImprovementModel"),
        "clearToolOutputOverflowChars" => Some("toolOutputOverflowChars"),
        _ => None,
    }
}

/// Session config keys whose change re-normalizes and persists child model routing.
const CHILD_ROUTING_CONFIG_KEYS: [&str; 4] = [
    "preferredChildModel",
    "childModelRoutingMode",
    "preferredChildModelRef",
    "allowedChildModelRefs",
];

/// Session config keys on which TS `prepareConfigUpdate` re-rendered the session's system
/// prompt; for a child agent the saved prompt's user-profile section is re-rendered.
const SYSTEM_PROMPT_REFRESH_CONFIG_KEYS: [&str; 5] = [
    "userName",
    "userProfile",
    "enableMemory",
    "advancedMemory",
    "providerOptions",
];

/// Applies a session config patch to a thread's live overrides: `clear*` sentinels remove the
/// key they clear, `providerOptions` merges through the editable allowlist, and a
/// `preferredChildModel` sent without `preferredChildModelRef` supersedes a stored ref (as
/// `prepareConfigUpdate` resolved it).
fn merge_session_config_overrides(overrides: &mut Map<String, Value>, patch: Map<String, Value>) {
    if patch.contains_key("preferredChildModel") && !patch.contains_key("preferredChildModelRef") {
        overrides.remove("preferredChildModelRef");
    }
    for (k, v) in patch {
        if let Some(cleared) = cleared_config_key(&k) {
            if v.as_bool() == Some(true) {
                overrides.remove(cleared);
            }
            continue;
        }
        if k == "providerOptions" {
            store_client_provider_options(overrides, &v);
            continue;
        }
        if k == "userProfile" {
            store_client_user_profile(overrides, &v);
            continue;
        }
        overrides.insert(k, v);
    }
}

/// The fields of a `userProfile`, as the TS `userProfileSchema` and `effectiveUserProfile`
/// named them.
const USER_PROFILE_FIELDS: [&str; 3] = ["instructions", "work", "details"];

/// Reduces a client `userProfile` patch to the fields it sets (TS `{ ...effective, ...patch }`
/// spread): a string replaces the field, including `""`, which clears it; `null` also clears
/// it, since the TS session config and event read a `null` field as `""`; an omitted field (or a
/// non-string value) leaves the current value alone. `None` when the patch is not an object.
fn user_profile_patch_fields(value: &Value) -> Option<Map<String, Value>> {
    let obj = value.as_object()?;
    Some(
        USER_PROFILE_FIELDS
            .iter()
            .filter_map(|field| match obj.get(*field)? {
                Value::String(s) => Some(((*field).to_owned(), Value::String(s.clone()))),
                Value::Null => Some(((*field).to_owned(), Value::String(String::new()))),
                _ => None,
            })
            .collect(),
    )
}

/// Merges a client `userProfile` patch into the session override field by field
/// (`SessionMetadataManager.buildNextConfig` parity), so successive partial patches accumulate
/// instead of each replacing the stored profile.
fn store_client_user_profile(overrides: &mut Map<String, Value>, value: &Value) {
    let Some(fields) = user_profile_patch_fields(value) else {
        return;
    };
    let mut merged = overrides
        .get("userProfile")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    merged.extend(fields);
    if !merged.is_empty() {
        overrides.insert("userProfile".to_owned(), Value::Object(merged));
    }
}

fn trimmed_model(cp: &Map<String, Value>, key: &str) -> Option<Option<String>> {
    cp.get(key).and_then(Value::as_str).map(|v| {
        let t = v.trim();
        (!t.is_empty()).then(|| t.to_owned())
    })
}

fn string_list(cp: &Map<String, Value>, key: &str) -> Option<Vec<String>> {
    cp.get(key).and_then(Value::as_array).map(|arr| {
        arr.iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect()
    })
}

/// Forwards every persistable field of a `cowork/session/defaults/apply` config patch
/// (`SessionMetadataManager.buildPersistPatch` parity), including the `clear*` sentinels.
/// Switches `cfg` to `provider`/`model` and re-normalizes its child routing for the new
/// selection (`ProviderAuthManager.prepareModelSelection`): a stale preferred child target must
/// not survive a provider switch, and a child model that followed the main model keeps
/// following it.
fn apply_model_selection_child_routing(cfg: &mut AgentConfig, provider: ProviderName, model: &str) {
    let preferred_ref =
        if cfg.child_model_routing_mode == ChildModelRoutingMode::CrossProviderAllowlist {
            cfg.preferred_child_model_ref.clone()
        } else if cfg.provider != provider || cfg.preferred_child_model == cfg.model {
            format!("{}:{model}", provider.as_str())
        } else if !cfg.preferred_child_model_ref.trim().is_empty() {
            cfg.preferred_child_model_ref.clone()
        } else {
            cfg.preferred_child_model.clone()
        };
    let routing = normalize_child_routing_config(
        provider,
        model,
        cfg.child_model_routing_mode,
        Some(&preferred_ref),
        Some(&cfg.allowed_child_model_refs),
    );
    cfg.provider = provider;
    cfg.model = model.to_owned();
    cfg.child_model_routing_mode = routing.child_model_routing_mode;
    cfg.preferred_child_model = routing.preferred_child_model;
    cfg.preferred_child_model_ref = routing.preferred_child_model_ref;
    cfg.allowed_child_model_refs = routing.allowed_child_model_refs;
}

/// Writes `routed`'s child routing into `patch` (`persistSelection`'s routing fields).
fn set_child_routing_patch(patch: &mut ProjectConfigPatch, routed: AgentConfig) {
    patch.child_model_routing_mode = Some(routed.child_model_routing_mode);
    patch.preferred_child_model = Some(routed.preferred_child_model);
    patch.preferred_child_model_ref = Some(routed.preferred_child_model_ref);
    patch.allowed_child_model_refs = Some(routed.allowed_child_model_refs);
}

fn apply_session_config_to_project_patch(
    cp: &Map<String, Value>,
    patch: &mut ProjectConfigPatch,
) -> Result<(), String> {
    let flag = |key: &str| cp.get(key).and_then(Value::as_bool) == Some(true);
    for (value_key, clear_key) in [
        ("memoryGenerationModel", "clearMemoryGenerationModel"),
        ("skillImprovementModel", "clearSkillImprovementModel"),
        ("toolOutputOverflowChars", "clearToolOutputOverflowChars"),
    ] {
        if cp.contains_key(value_key) && flag(clear_key) {
            return Err(format!("{value_key} cannot be combined with {clear_key}"));
        }
    }

    let bool_field = |key: &str| cp.get(key).and_then(Value::as_bool);
    if let Some(v) = bool_field("enableMemory") {
        patch.enable_memory = Some(v);
    }
    if let Some(v) = bool_field("memoryRequireApproval") {
        patch.memory_require_approval = Some(v);
    }
    if let Some(v) = bool_field("backupsEnabled") {
        patch.backups_enabled = Some(v);
    }
    if let Some(v) = bool_field("observabilityEnabled") {
        patch.observability_enabled = Some(v);
    }
    if let Some(v) = bool_field("advancedMemory") {
        patch.advanced_memory = Some(v);
    }
    if let Some(v) = bool_field("skillImprovementEnabled") {
        patch.skill_improvement_enabled = Some(v);
    }
    if let Some(v) = trimmed_model(cp, "memoryGenerationModel") {
        patch.memory_generation_model = v;
    }
    if flag("clearMemoryGenerationModel") {
        patch.clear_memory_generation_model = true;
    }
    if let Some(v) = trimmed_model(cp, "skillImprovementModel") {
        patch.skill_improvement_model = v;
    }
    if flag("clearSkillImprovementModel") {
        patch.clear_skill_improvement_model = true;
    }
    if let Some(v) = cp.get("skillImprovementScope")
        && let Ok(sc) = serde_json::from_value(v.clone())
    {
        patch.skill_improvement_scope = Some(sc);
    }
    if let Some(v) = string_list(cp, "skillImprovementExcludedSkills") {
        patch.skill_improvement_excluded_skills = Some(v);
    }
    if let Some(v) = cp.get("preferredChildModel").and_then(Value::as_str) {
        patch.preferred_child_model = Some(v.to_owned());
    }
    if let Some(v) = cp.get("childModelRoutingMode")
        && let Ok(mode) = serde_json::from_value(v.clone())
    {
        patch.child_model_routing_mode = Some(mode);
    }
    if let Some(v) = cp.get("preferredChildModelRef").and_then(Value::as_str) {
        patch.preferred_child_model_ref = Some(v.to_owned());
    }
    if let Some(v) = string_list(cp, "allowedChildModelRefs") {
        patch.allowed_child_model_refs = Some(v);
    }
    if let Some(n) = cp
        .get("workflowMaxConcurrentAgents")
        .and_then(Value::as_u64)
    {
        patch.workflow_max_concurrent_agents = Some(cowork_tools::resolve_workflow_concurrency(
            usize::try_from(n).ok(),
        ));
    }
    match cp.get("toolOutputOverflowChars") {
        Some(Value::Null) => patch.tool_output_overflow_chars = Some(None),
        Some(v) => {
            if let Some(n) = v.as_u64() {
                patch.tool_output_overflow_chars = Some(Some(n));
            }
        }
        None => {}
    }
    if flag("clearToolOutputOverflowChars") {
        patch.clear_tool_output_overflow_chars = true;
    }
    if let Some(v) = cp.get("userName").and_then(Value::as_str) {
        patch.user_name = Some(v.to_owned());
    }
    // Only the fields the patch sets reach the config file, where `persist_config_patch_file`
    // merges them over the stored profile (`ConfigPatchStore.ts` spread parity).
    if let Some(fields) = cp.get("userProfile").and_then(user_profile_patch_fields)
        && let Ok(profile) = serde_json::from_value(Value::Object(fields))
    {
        patch.user_profile = Some(profile);
    }
    if let Some(ff_val) = cp.get("featureFlags")
        && let Ok(ff) = serde_json::from_value(ff_val.clone())
    {
        patch.feature_flags = Some(ff);
    }
    if let Some(v) = cp.get("providerOptions").and_then(Value::as_object) {
        patch.provider_options = Some(v.clone());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seed_messages_skip_thinking_and_reasoning_parts() {
        let messages = vec![
            json!({ "role": "user", "content": [{ "type": "text", "text": "hello" }] }),
            json!({
                "role": "assistant",
                "content": [
                    { "type": "thinking", "text": "secret chain of thought", "redacted": false },
                    { "type": "reasoning", "text": "legacy reasoning" },
                    { "type": "text", "text": "visible answer" }
                ]
            }),
            json!({
                "role": "assistant",
                "content": [{ "type": "thinking", "text": "only thinking" }]
            }),
        ];
        let seed = unjournaled_seed_messages("t", &messages, None, false, "ts");
        let texts: Vec<(&str, &str)> = seed.iter().map(|m| (m.role, m.text.as_str())).collect();
        assert_eq!(
            texts,
            vec![("user", "hello"), ("assistant", "visible answer")],
            "reasoning parts must not become visible seed text"
        );
    }
}
