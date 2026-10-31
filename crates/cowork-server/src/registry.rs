use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use base64_helper::decode_base64_permissive;
use cowork_config::{
    AgentConfig, LoadConfigOptions, ModelRegistry, ProjectConfigPatch, ProviderName,
    canonicalize_sync, ensure_private_dir_sync, get_ai_coworker_paths, get_one_off_chats_root,
    is_inside, load_config, persist_project_config_patch,
};
use cowork_protocol::{
    CommandInfo, CreationPreflightParams, CreationPreflightResult, CreationReadinessCheck,
    CreationRepairAction, HarnessContextInput, JsonRpcLiteId, JsonRpcLiteNotification,
    JsonRpcLiteOutbound, JsonRpcLiteRequest, JsonRpcThread, PersistedJournalEventView,
    ReplayHealth, RuntimeDiagnosticsDbLocks, RuntimeDiagnosticsJournal, RuntimeDiagnosticsPayload,
    RuntimeDiagnosticsProgress, RuntimeDiagnosticsReadResult, RuntimeDiagnosticsSendQueue,
    RuntimeDiagnosticsStartup, RuntimeLibreOfficeCheckResult, RuntimeLibreOfficeSmokeStatus,
    RuntimeLibreOfficeStatusView, ThreadStatus, ThreadTurnProjector,
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

#[derive(Debug, Clone)]
pub struct LiveSession {
    pub id: String,
    pub session_kind: SessionKind,
    pub cwd: String,
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
    pub provider_state: Option<Value>,
    pub todos: Vec<Value>,
    pub last_memory_generated_index: Option<usize>,
    pub requested_reasoning_effort: Option<String>,
    pub effective_reasoning_effort: Option<String>,
    pub harness_context: Option<Value>,
    pub config_overrides: Map<String, Value>,
    pub messages: Vec<Value>,
    pub subscribers: HashSet<String>,
    pub idle_since: Option<Instant>,
}

impl LiveSession {
    pub(crate) fn to_snapshot_data(&self) -> PersistedSessionSnapshotData {
        let mut cost_json = self
            .cost_tracker_snapshot
            .clone()
            .unwrap_or_else(|| json!({ "totalCostUsd": 0.0, "inputTokens": 0, "outputTokens": 0 }));
        if let Some(obj) = cost_json.as_object_mut() {
            obj.insert("warnAtUsd".to_owned(), json!(self.warn_at_usd));
            obj.insert("stopAtUsd".to_owned(), json!(self.stop_at_usd));
        }
        PersistedSessionSnapshotData {
            session_kind: self.session_kind,
            parent_session_id: None,
            role: None,
            mode: None,
            depth: None,
            nickname: None,
            task_type: None,
            target_paths: None,
            profile: None,
            requested_model: Some(self.model.clone()),
            effective_model: Some(self.model.clone()),
            requested_reasoning_effort: self.requested_reasoning_effort.clone(),
            effective_reasoning_effort: self.effective_reasoning_effort.clone(),
            execution_state: None,
            last_message_preview: self.last_message_preview.clone(),
            title: self.title.clone(),
            title_source: self.title_source,
            title_model: self.title_model.clone(),
            provider: self.provider,
            model: self.model.clone(),
            working_directory: self.cwd.clone(),
            output_directory: None,
            uploads_directory: None,
            provider_options: self.config_overrides.get("providerOptions").cloned(),
            sandbox: None,
            enable_mcp: self.enable_mcp,
            backups_enabled_override: self
                .config_overrides
                .get("backupsEnabled")
                .and_then(Value::as_bool),
            created_at: self.created_at.clone(),
            updated_at: self.updated_at.clone(),
            status: SessionPersistenceStatus::Active,
            has_pending_ask: self.has_pending_ask,
            has_pending_approval: self.has_pending_approval,
            system_prompt: String::new(),
            messages: self.messages.clone(),
            last_memory_generated_index: self.last_memory_generated_index,
            provider_state: self.provider_state.clone(),
            todos: self.todos.clone(),
            harness_context: self.harness_context.clone(),
            cost_tracker: Some(cost_json),
        }
    }

    pub(crate) fn from_persisted(record: PersistedSessionRecord) -> Self {
        let warn_at_usd = record
            .cost_tracker
            .as_ref()
            .and_then(|c| c.get("warnAtUsd"))
            .and_then(Value::as_f64);
        let stop_at_usd = record
            .cost_tracker
            .as_ref()
            .and_then(|c| c.get("stopAtUsd"))
            .and_then(Value::as_f64);
        let mut config_overrides = Map::new();
        if let Some(po) = record.provider_options {
            config_overrides.insert("providerOptions".to_owned(), po);
        }
        if let Some(b) = record.backups_enabled_override {
            config_overrides.insert("backupsEnabled".to_owned(), Value::Bool(b));
        }
        Self {
            id: record.session_id,
            session_kind: record.session_kind,
            cwd: record.working_directory,
            provider: record.provider,
            model: record.model,
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
            cost_tracker_snapshot: record.cost_tracker,
            provider_state: record.provider_state,
            todos: record.todos,
            last_memory_generated_index: record.last_memory_generated_index,
            requested_reasoning_effort: record.requested_reasoning_effort,
            effective_reasoning_effort: record.effective_reasoning_effort,
            harness_context: record.harness_context,
            config_overrides,
            messages: record.messages,
            subscribers: HashSet::new(),
            idle_since: Some(Instant::now()),
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
    pub mobile_h3: Option<Arc<MobileH3AdminState>>,
    pub browser_access_token: Option<String>,
    pub network_exposed_listener: bool,
    pub max_pending_requests: usize,
    pub sandbox_manager: cowork_sandbox::SandboxManager,
    pub soffice_runner: Arc<cowork_env::SofficeRunner>,
    pub worktree_service: Arc<cowork_tools::WorktreeService>,
    runtime_env_overlay: RwLock<HashMap<String, String>>,
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
    pub(crate) interaction_managers: DashMap<String, Arc<cowork_harness::InteractionManager>>,
    pub(crate) idempotency_ledgers: DashMap<String, Arc<cowork_harness::TurnIdempotencyLedger>>,
    pub(crate) sessions: DashMap<String, Arc<Mutex<LiveSession>>>,
    pub(crate) creation_keys: DashMap<String, String>,
    ws_sinks: DashMap<String, mpsc::Sender<String>>,
    workspace_state_ids: DashMap<String, String>,
    workspace_subscribers: DashMap<String, HashSet<String>>,
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
        let worktree_service = Arc::new(cowork_tools::WorktreeService::with_cowork_home(
            ai_paths.root_dir,
            env.clone(),
        ));
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
            mobile_h3,
            browser_access_token,
            network_exposed_listener,
            max_pending_requests,
            sandbox_manager,
            soffice_runner,
            worktree_service,
            runtime_env_overlay: RwLock::new(HashMap::new()),
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
            interaction_managers: DashMap::new(),
            idempotency_ledgers: DashMap::new(),
            sessions: DashMap::new(),
            creation_keys: DashMap::new(),
            ws_sinks: DashMap::new(),
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

    pub fn remove_connection(&self, connection_id: &str) {
        self.ws_sinks.remove(connection_id);
        self.send_queue.remove_connection(connection_id);
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

        if method == "thread/start" || method == "thread/list" {
            let one_off_root = canonicalize_sync(&get_one_off_chats_root(&self.homedir));
            let wt_root = canonicalize_sync(&self.worktree_service.worktrees_root());
            if canonical == fallback
                || is_inside(&one_off_root, &canonical)
                || is_inside(&wt_root, &canonical)
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
            return Err(format!(
                "{method} cwd must match the server workspace or a one-off chat workspace"
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

    pub fn build_thread_from_live(&self, live: &LiveSession) -> JsonRpcThread {
        let meta = self.thread_metadata_or_default(&live.id);
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
            last_event_seq: live.last_event_seq,
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
            last_event_seq: record.last_event_seq,
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

    pub(crate) async fn persist_live_session(
        &self,
        live_arc: &Arc<Mutex<LiveSession>>,
        event_type: &str,
    ) -> anyhow::Result<()> {
        let (session_id, snapshot_data) = {
            let live = live_arc.lock();
            (live.id.clone(), live.to_snapshot_data())
        };
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let seq = self
            .session_db
            .persist_session_mutation(PersistedSessionMutation {
                session_id: session_id.clone(),
                event_type: event_type.to_owned(),
                event_ts: Some(now),
                direction: Some("server".to_owned()),
                payload: None,
                snapshot: snapshot_data.clone(),
            })
            .await?;
        {
            let mut live = live_arc.lock();
            live.last_event_seq = seq;
        }
        let snapshot_json = serde_json::to_value(&snapshot_data)?;
        self.session_db
            .persist_session_snapshot(&session_id, &snapshot_json)
            .await?;
        Ok(())
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
            && let Some(live_arc) = self.load_thread(&existing_id)
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
            && let Some(existing_live) = self.load_thread(&winning_id)
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
                    self.model_registry().default_for(provider).id
                }
            });

        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let mut subscribers = HashSet::new();
        subscribers.insert(connection_id.to_owned());

        let live = LiveSession {
            id: winning_id.clone(),
            session_kind: SessionKind::Root,
            cwd: cwd_str,
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
            provider_state: None,
            todos: Vec::new(),
            last_memory_generated_index: None,
            requested_reasoning_effort: None,
            effective_reasoning_effort: None,
            harness_context: None,
            config_overrides: Map::new(),
            messages: Vec::new(),
            subscribers,
            idle_since: None,
        };

        let live_arc = Arc::new(Mutex::new(live));
        self.sessions.insert(winning_id.clone(), live_arc.clone());
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

    pub fn get_live_thread(&self, thread_id: &str) -> Option<Arc<Mutex<LiveSession>>> {
        self.sessions.get(thread_id).map(|r| r.value().clone())
    }

    /// Gets a live thread or rehydrates it from `SessionDb` if previously evicted.
    pub fn load_thread(&self, thread_id: &str) -> Option<Arc<Mutex<LiveSession>>> {
        if let Some(existing) = self.get_live_thread(thread_id) {
            return Some(existing);
        }
        let record = self
            .session_db
            .get_session_record(thread_id)
            .ok()
            .flatten()?;
        let rehydrated = Arc::new(Mutex::new(LiveSession::from_persisted(record)));
        self.sessions
            .insert(thread_id.to_owned(), rehydrated.clone());
        Some(rehydrated)
    }

    pub fn subscribe(
        &self,
        connection_id: &str,
        thread_id: &str,
    ) -> Option<Arc<Mutex<LiveSession>>> {
        let live_arc = self.load_thread(thread_id)?;
        {
            let mut live = live_arc.lock();
            live.subscribers.insert(connection_id.to_owned());
            live.idle_since = None;
        }
        Some(live_arc)
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
            let live = entry.value().lock();
            if live.subscribers.is_empty()
                && !live.busy
                && live
                    .idle_since
                    .is_some_and(|since| since.elapsed() >= max_idle)
            {
                to_evict.push(entry.key().clone());
            }
        }
        let mut count = 0;
        for id in to_evict {
            let should_remove = self.sessions.get(&id).is_some_and(|e| {
                let l = e.value().lock();
                l.subscribers.is_empty() && !l.busy
            });
            if should_remove && self.sessions.remove(&id).is_some() {
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
        connection_id: &str,
        thread_id: &str,
        after_seq: u64,
    ) -> Result<(JsonRpcThread, Option<ReplayHealth>), String> {
        let Some(live_arc) = self.load_thread(thread_id) else {
            return Err(format!("Unknown thread: {thread_id}"));
        };
        self.journal.wait_for_idle(thread_id).await;
        let replay_health = self.build_replay_health(thread_id, after_seq);

        if after_seq > 0
            && replay_health.as_ref().is_none_or(|h| h.trusted)
            && let Ok(events) = self.journal.list(thread_id, after_seq, None)
        {
            for ev in events {
                if ev.event_type.starts_with("internal/") {
                    continue;
                }
                if let Some(req_method) = ev.event_type.strip_prefix("request:") {
                    let req_id = ev
                        .request_id
                        .unwrap_or_else(|| format!("{thread_id}:{}", ev.seq));
                    let frame = JsonRpcLiteOutbound::ServerRequest(JsonRpcLiteRequest {
                        id: JsonRpcLiteId::String(req_id),
                        method: req_method.to_owned(),
                        params: Some(ev.payload),
                    });
                    self.send_to_connection(connection_id, &frame);
                    continue;
                }
                let frame = JsonRpcLiteOutbound::Notification(JsonRpcLiteNotification {
                    method: ev.event_type,
                    params: Some(ev.payload),
                });
                self.send_to_connection(connection_id, &frame);
            }
        }

        self.subscribe(connection_id, thread_id);
        if let Some(im) = self.interaction_managers.get(thread_id) {
            im.replay_pending_requests();
        }
        let thread = self.build_thread_from_live(&live_arc.lock());
        Ok((thread, replay_health))
    }

    pub async fn read_or_hydrate_thread(
        &self,
        thread_id: &str,
        after_seq: u64,
        include_turns: bool,
    ) -> Result<Value, String> {
        self.journal.wait_for_idle(thread_id).await;
        let live_opt = self.get_live_thread(thread_id);
        let record_opt = self.session_db.get_session_record(thread_id).ok().flatten();

        let mut thread = if let Some(live_arc) = &live_opt {
            self.build_thread_from_live(&live_arc.lock())
        } else if let Some(rec) = &record_opt {
            self.build_thread_from_record(rec)
        } else {
            return Err(format!("Unknown thread: {thread_id}"));
        };

        let snapshot = self
            .session_db
            .get_session_snapshot(thread_id)
            .ok()
            .flatten()
            .or_else(|| {
                self.session_db
                    .project_legacy_snapshot(thread_id)
                    .ok()
                    .flatten()
            })
            .or_else(|| {
                live_opt
                    .as_ref()
                    .and_then(|l| serde_json::to_value(l.lock().to_snapshot_data()).ok())
            })
            .unwrap_or(Value::Null);

        let mut journal_tail_seq = after_seq;
        if include_turns {
            let mut projector = ThreadTurnProjector::new();
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
            thread.turns = Some(projector.build());
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
        let live_arc = self.load_thread(thread_id).unwrap();
        let out = self.build_thread_from_live(&live_arc.lock());
        Ok(out)
    }

    pub async fn set_thread_archived(
        &self,
        thread_id: &str,
        archived: bool,
    ) -> Result<JsonRpcThread, String> {
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
        let live_arc = self.load_thread(thread_id).unwrap();
        let out = self.build_thread_from_live(&live_arc.lock());
        Ok(out)
    }

    pub async fn set_session_title(&self, thread_id: &str, title: &str) -> Result<Value, String> {
        let Some(live_arc) = self.load_thread(thread_id) else {
            return Err("cowork/session/title/set requires threadId and title".to_owned());
        };
        let trimmed = title.trim();
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let event = {
            let mut live = live_arc.lock();
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
        self.persist_live_session(&live_arc, "session_info")
            .await
            .map_err(|e| e.to_string())?;
        Ok(event)
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
        let event = {
            let mut live = live_arc.lock();
            let prev_provider = live.provider;
            let prev_model = live.model.clone();
            if let Some(p_str) = provider_raw.map(str::trim).filter(|s| !s.is_empty()) {
                let parsed = ProviderName::parse(p_str)
                    .ok_or_else(|| format!("Unknown provider: {p_str}"))?;
                live.provider = parsed;
            }
            live.model = trimmed_model.to_owned();
            if live.provider != prev_provider || live.model != prev_model {
                live.provider_state = None;
            }
            live.updated_at = now;
            json!({
                "type": "config_updated",
                "sessionId": live.id,
                "config": {
                    "provider": live.provider,
                    "model": live.model,
                    "workingDirectory": live.cwd,
                }
            })
        };
        self.persist_live_session(&live_arc, "config_updated")
            .await
            .map_err(|e| e.to_string())?;
        Ok(event)
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
        let event = {
            let mut live = live_arc.lock();
            if let Some(w) = warn_at_usd {
                live.warn_at_usd = w;
            }
            if let Some(s) = stop_at_usd {
                live.stop_at_usd = s;
            }
            live.updated_at =
                chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            json!({
                "type": "session_usage",
                "sessionId": live.id,
                "usage": {
                    "inputTokens": 0,
                    "outputTokens": 0,
                    "cachedInputTokens": 0,
                    "totalCostUsd": 0.0,
                    "warnAtUsd": live.warn_at_usd,
                    "stopAtUsd": live.stop_at_usd,
                }
            })
        };
        self.persist_live_session(&live_arc, "session_usage")
            .await
            .map_err(|e| e.to_string())?;
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
        if let Some(m) = &cfg.memory_generation_model {
            config_obj["memoryGenerationModel"] = json!(m);
        }
        if let Some(m) = &cfg.skill_improvement_model {
            config_obj["skillImprovementModel"] = json!(m);
        }
        if let Some(po) = &cfg.provider_options {
            config_obj["providerOptions"] = Value::Object(po.clone());
        }
        if let (Some(Value::Object(dst)), Some(ovr)) = (Some(&mut config_obj), overrides) {
            for (k, v) in ovr {
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
        let cfg = self
            .load_workspace_config(&cwd)
            .map_err(|e| e.to_string())?;
        let event = {
            let mut live = live_arc.lock();
            for (k, v) in patch {
                live.config_overrides.insert(k, v);
            }
            live.updated_at =
                chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            self.build_session_config_event(&live.id, &cfg, Some(&live.config_overrides))
        };
        self.persist_live_session(&live_arc, "session_config")
            .await
            .map_err(|e| e.to_string())?;
        Ok(event)
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
        if let Some(cp) = &config_patch {
            if let Some(v) = cp.get("enableMemory").and_then(Value::as_bool) {
                proj_patch.enable_memory = Some(v);
            }
            if let Some(v) = cp.get("memoryRequireApproval").and_then(Value::as_bool) {
                proj_patch.memory_require_approval = Some(v);
            }
            if let Some(v) = cp.get("backupsEnabled").and_then(Value::as_bool) {
                proj_patch.backups_enabled = Some(v);
            }
            if let Some(v) = cp.get("observabilityEnabled").and_then(Value::as_bool) {
                proj_patch.observability_enabled = Some(v);
            }
            if let Some(v) = cp.get("providerOptions").and_then(Value::as_object) {
                proj_patch.provider_options = Some(v.clone());
            }
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
        if let Some(tid) = thread_id {
            let Some(live_arc) = self.load_thread(tid) else {
                return Err("Unknown thread".to_owned());
            };
            let event = {
                let mut live = live_arc.lock();
                if let Some(p) = parsed_provider {
                    live.provider = p;
                }
                if let Some(m) = model {
                    live.model = m.to_owned();
                }
                if let Some(mcp) = enable_mcp {
                    live.enable_mcp = mcp;
                }
                if let Some(cp) = config_patch {
                    for (k, v) in cp {
                        live.config_overrides.insert(k, v);
                    }
                }
                self.build_session_config_event(
                    &live.id,
                    &refreshed_cfg,
                    Some(&live.config_overrides),
                )
            };
            self.persist_live_session(&live_arc, "session_config")
                .await
                .map_err(|e| e.to_string())?;
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
        let clean_name = Path::new(filename.trim())
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .filter(|n| !n.is_empty() && n != "." && n != "..")
            .ok_or_else(|| "Invalid upload filename".to_owned())?;
        let bytes = decode_base64_permissive(content_base64)?;
        let uploads_dir = cwd.join("uploads");
        let _ = ensure_private_dir_sync(&uploads_dir);
        let dst = uploads_dir.join(format!("{}-{clean_name}", Uuid::new_v4()));
        std::fs::write(&dst, bytes).map_err(|e| format!("Failed to write upload: {e}"))?;
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
        self.sessions.remove(target_session_id);
        self.creation_keys
            .retain(|_, bound_id| bound_id != target_session_id);
        self.session_db
            .delete_session(target_session_id)
            .await
            .map_err(|e| e.to_string())?;
        let state_id = self.get_or_create_workspace_state_id(cwd);
        Ok(json!({
            "type": "session_deleted",
            "sessionId": state_id,
            "targetSessionId": target_session_id,
        }))
    }

    pub(crate) fn get_or_create_workspace_state_id(&self, cwd: &Path) -> String {
        let key = cwd.to_string_lossy().into_owned();
        if let Some(existing) = self.workspace_state_ids.get(&key) {
            return existing.value().clone();
        }
        let created = format!("jsonrpc-control:{}", Uuid::new_v4());
        self.workspace_state_ids.insert(key, created.clone());
        created
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
        self.workspace_subscribers
            .entry(key)
            .or_default()
            .insert(connection_id.to_owned());

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
            for skill_dir in &cfg.skills_dirs {
                if let Ok(rd) = std::fs::read_dir(skill_dir) {
                    for entry in rd.flatten() {
                        if entry.path().join("SKILL.md").is_file() {
                            let name = entry.file_name().to_string_lossy().into_owned();
                            by_name.entry(name.clone()).or_insert(CommandInfo {
                                name,
                                description: None,
                                source: "skill".to_owned(),
                                hints: Vec::new(),
                            });
                        }
                    }
                }
            }
        }

        let mut list: Vec<CommandInfo> = by_name.into_values().collect();
        list.sort_by(|a, b| a.name.cmp(&b.name));
        list
    }

    pub async fn execute_command_turn(
        &self,
        connection_id: &str,
        thread_id: &str,
        name: &str,
        arguments: Option<&str>,
        client_message_id: Option<&str>,
    ) -> Result<Value, String> {
        let Some(live_arc) = self.subscribe(connection_id, thread_id) else {
            return Err(format!("Unknown thread: {thread_id}"));
        };
        let cmds = {
            let cwd = PathBuf::from(live_arc.lock().cwd.clone());
            self.list_commands(&cwd)
        };
        if !cmds.iter().any(|c| c.name == name.trim()) {
            return Err(format!("Unknown command: {}", name.trim()));
        }

        let turn_id = Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let args_trimmed = arguments.unwrap_or("").trim();
        let slash_text = if args_trimmed.is_empty() {
            format!("/{}", name.trim())
        } else {
            format!("/{} {args_trimmed}", name.trim())
        };

        {
            let mut live = live_arc.lock();
            live.message_count += 1;
            live.last_message_preview = Some(slash_text.clone());
            live.updated_at = now.clone();
            live.messages.push(json!({
                "role": "user",
                "content": slash_text,
                "clientMessageId": client_message_id,
            }));
        }
        let _ = self
            .persist_live_session(&live_arc, "command/execute")
            .await;

        let user_item_id = format!("user:{turn_id}");
        for (ev_type, item_id, payload) in [
            (
                "turn/started",
                None,
                json!({
                    "threadId": thread_id,
                    "turn": { "id": turn_id, "threadId": thread_id, "status": "inProgress", "items": [] }
                }),
            ),
            (
                "item/completed",
                Some(user_item_id.clone()),
                json!({
                    "threadId": thread_id,
                    "turnId": turn_id,
                    "item": {
                        "id": user_item_id,
                        "type": "userMessage",
                        "content": [{ "type": "text", "text": slash_text }],
                        "clientMessageId": client_message_id,
                    }
                }),
            ),
            (
                "turn/completed",
                None,
                json!({
                    "threadId": thread_id,
                    "turn": { "id": turn_id, "threadId": thread_id, "status": "completed", "items": [] }
                }),
            ),
        ] {
            let _ = self
                .journal
                .enqueue(ThreadJournalEventInput {
                    thread_id: thread_id.to_owned(),
                    ts: now.clone(),
                    event_type: ev_type.to_owned(),
                    turn_id: Some(turn_id.clone()),
                    item_id,
                    request_id: None,
                    payload: payload.clone(),
                })
                .await;
            self.send_to_connection(
                connection_id,
                &JsonRpcLiteOutbound::Notification(JsonRpcLiteNotification {
                    method: ev_type.to_owned(),
                    params: Some(payload),
                }),
            );
        }

        Ok(json!({
            "turn": {
                "id": turn_id,
                "threadId": thread_id,
                "status": "inProgress",
                "items": []
            }
        }))
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

        checks.push(CreationReadinessCheck {
            id: "runtime_ready".to_owned(),
            status: "ok".to_owned(),
            message: "Runtime is ready.".to_owned(),
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
            if self.startup_state.lock().ready {
                return;
            }
            let notified = self.startup_notify.notified();
            if self.startup_state.lock().ready {
                return;
            }
            notified.await;
        }
    }

    /// Spawns asynchronous runtime pack verification/bootstrap without blocking `start_server`.
    pub fn start_background_runtime_bootstrap(
        self: &Arc<Self>,
        trusted_keys_override: Option<cowork_env::TrustedKeyRing>,
    ) {
        if self.startup_state.lock().ready {
            self.startup_notify.notify_waiters();
            return;
        }

        let this = Arc::clone(self);
        let progress_target = Arc::clone(self);
        let trusted_keys = trusted_keys_override
            .unwrap_or_else(cowork_env::TrustedKeyRing::with_official_defaults);

        let handle = tokio::spawn(async move {
            let on_progress: cowork_env::RuntimeProgressCallback = Arc::new(move |evt| {
                let mut guard = progress_target.startup_state.lock();
                guard.progress = Some(RuntimeDiagnosticsProgress {
                    phase: evt.progress.phase.as_str().to_owned(),
                    version: evt.progress.version,
                    transferred_bytes: evt.progress.transferred_bytes,
                    total_bytes: evt.progress.total_bytes,
                    percent: evt.progress.percent,
                });
            });

            let outcome =
                cowork_env::ensure_cowork_runtime_ready(cowork_env::EnsureRuntimeOptions {
                    homedir: this.homedir.clone(),
                    env: this.env.clone(),
                    trusted_keys,
                    on_progress: Some(on_progress),
                })
                .await;

            match outcome {
                Ok(prepared) => {
                    if let Ok(lease) = cowork_env::RuntimeConsumerLease::acquire(&prepared.root_dir)
                    {
                        *this.runtime_lease.lock() = Some(lease);
                    }
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
                    st.ready = true;
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

    pub async fn shutdown(&self) {
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
        self.soffice_runner.shutdown().await;
        *self.runtime_lease.lock() = None;
        self.pending_codex_logins.clear();
        self.codex_pool.close_all().await;
        self.ws_sinks.clear();
        self.sessions.clear();
        self.journal.close().await;
        self.session_db.close();
    }
}

pub fn provider_display_name(provider: ProviderName) -> &'static str {
    match provider {
        ProviderName::Google => "Google",
        ProviderName::Openai => "OpenAI",
        ProviderName::Anthropic => "Anthropic",
        ProviderName::Bedrock => "Amazon Bedrock",
        ProviderName::Baseten => "Baseten",
        ProviderName::Together => "Together AI",
        ProviderName::Fireworks => "Fireworks AI",
        ProviderName::Firepass => "Fire Pass",
        ProviderName::Nvidia => "NVIDIA",
        ProviderName::Lmstudio => "LM Studio",
        ProviderName::Minimax => "MiniMax",
        ProviderName::OpencodeGo => "OpenCode Go",
        ProviderName::OpencodeZen => "OpenCode Zen",
        ProviderName::CodexCli => "Codex",
    }
}
