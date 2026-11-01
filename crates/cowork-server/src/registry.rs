use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock, Weak};
use std::time::{Duration, Instant};

use base64_helper::decode_base64_permissive;
use cowork_config::{
    AgentConfig, LoadConfigOptions, ModelRegistry, ProjectConfigPatch, ProviderName,
    canonicalize_sync, get_ai_coworker_paths, get_one_off_chats_root, is_inside, load_config,
    persist_project_config_patch,
};
use cowork_protocol::{
    CommandInfo, CreationPreflightParams, CreationPreflightResult, CreationReadinessCheck,
    CreationRepairAction, HarnessContextInput, JsonRpcLiteError, JsonRpcLiteId,
    JsonRpcLiteNotification, JsonRpcLiteOutbound, JsonRpcLiteRequest, JsonRpcThread,
    PersistedJournalEventView, ReplayHealth, RuntimeDiagnosticsDbLocks, RuntimeDiagnosticsJournal,
    RuntimeDiagnosticsPayload, RuntimeDiagnosticsProgress, RuntimeDiagnosticsReadResult,
    RuntimeDiagnosticsSendQueue, RuntimeDiagnosticsStartup, RuntimeLibreOfficeCheckResult,
    RuntimeLibreOfficeSmokeStatus, RuntimeLibreOfficeStatusView, ThreadStatus, ThreadTurnProjector,
    TurnInput, TurnStartParams, error_codes,
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
    pub workflow_runs: Vec<Value>,
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
    pub(crate) fn effective_session_usage_snapshot(&self) -> Option<Value> {
        if let Some(mut snap) = self.cost_tracker_snapshot.clone()
            && snap.get("sessionId").and_then(Value::as_str).is_some()
            && snap
                .get("budgetStatus")
                .and_then(Value::as_object)
                .is_some()
        {
            if let Some(obj) = snap.as_object_mut() {
                obj.remove("warnAtUsd");
                obj.remove("stopAtUsd");
                if let Some(bs) = obj.get_mut("budgetStatus").and_then(Value::as_object_mut) {
                    bs.insert("warnAtUsd".to_owned(), json!(self.warn_at_usd));
                    bs.insert("stopAtUsd".to_owned(), json!(self.stop_at_usd));
                    bs.insert(
                        "configured".to_owned(),
                        json!(self.warn_at_usd.is_some() || self.stop_at_usd.is_some()),
                    );
                }
            }
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
            output_directory: None,
            uploads_directory: None,
            provider_options: self.config_overrides.get("providerOptions").cloned(),
            sandbox: self.sandbox.clone(),
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
            cost_tracker: self.effective_session_usage_snapshot(),
        }
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
        let cost_tracker_snapshot = record.cost_tracker.and_then(|mut c| {
            if c.get("sessionId").and_then(Value::as_str).is_some()
                && c.get("budgetStatus").and_then(Value::as_object).is_some()
            {
                if let Some(obj) = c.as_object_mut() {
                    obj.remove("warnAtUsd");
                    obj.remove("stopAtUsd");
                }
                Some(c)
            } else {
                None
            }
        });
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
            cost_tracker_snapshot,
            provider_state: record.provider_state,
            todos: record.todos,
            workflow_runs: Vec::new(),
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
    pub(crate) interaction_managers: DashMap<String, Arc<cowork_harness::InteractionManager>>,
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
            interaction_managers: DashMap::new(),
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
        loop {
            let batch = self
                .journal
                .list(thread_id, cursor, Some(THREAD_READ_JOURNAL_BATCH_SIZE))
                .unwrap_or_default();
            if batch.is_empty() {
                break;
            }
            for ev in &batch {
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

        if feed.is_empty() && !messages.is_empty() {
            for (idx, msg) in messages.iter().enumerate() {
                let Some(role) = msg.get("role").and_then(Value::as_str) else {
                    continue;
                };
                if role != "user" && role != "assistant" {
                    continue;
                }
                let text = match msg.get("content") {
                    Some(Value::String(s)) => s.clone(),
                    Some(Value::Array(arr)) => arr
                        .iter()
                        .filter_map(|p| p.get("text").and_then(Value::as_str))
                        .filter(|s| !s.is_empty())
                        .collect::<Vec<_>>()
                        .join("\n"),
                    _ => String::new(),
                };
                if text.is_empty() {
                    continue;
                }
                let msg_id = msg
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|s| !s.trim().is_empty())
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("msg:{thread_id}:{idx}"));
                let msg_ts = msg
                    .get("createdAt")
                    .and_then(Value::as_str)
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or(fallback_ts);
                feed.push(json!({
                    "id": msg_id,
                    "kind": "message",
                    "role": role,
                    "ts": msg_ts,
                    "text": text,
                }));
            }
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

    pub(crate) async fn persist_live_session(
        &self,
        live_arc: &Arc<Mutex<LiveSession>>,
        event_type: &str,
    ) -> anyhow::Result<()> {
        let (session_id, snapshot_data) = {
            let live = live_arc.lock();
            (live.id.clone(), live.to_snapshot_data())
        };
        if self.is_session_deleted(&session_id) {
            return Ok(());
        }
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let seq = self
            .session_db
            .persist_session_mutation(PersistedSessionMutation {
                session_id: session_id.clone(),
                event_type: event_type.to_owned(),
                event_ts: Some(now),
                direction: Some("server".to_owned()),
                payload: None,
                snapshot: snapshot_data,
            })
            .await?;
        let effective_seq = seq.max(self.journal_tail_seq(&session_id));
        let snapshot_json = {
            let mut live = live_arc.lock();
            live.last_event_seq = effective_seq;
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
            workflow_runs: Vec::new(),
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
        if self.is_session_deleted(thread_id) {
            return None;
        }
        if let Some(existing) = self.get_live_thread(thread_id) {
            return Some(existing);
        }
        let record = self
            .session_db
            .get_session_record(thread_id)
            .ok()
            .flatten()?;
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
        let rehydrated = Arc::new(Mutex::new(live));
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
            let should_remove = !has_running_children
                && self.sessions.get(&id).is_some_and(|e| {
                    let l = e.value().lock();
                    l.subscribers.is_empty() && !l.busy
                });
            if should_remove && self.sessions.remove(&id).is_some() {
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
        let live_arc = self.load_thread(thread_id).unwrap();
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
        if let Some(po) = cfg
            .provider_options
            .as_ref()
            .and_then(pick_editable_provider_options)
        {
            config_obj["providerOptions"] = Value::Object(po);
        }
        if let (Some(Value::Object(dst)), Some(ovr)) = (Some(&mut config_obj), overrides) {
            for (k, v) in ovr {
                if k == "providerOptions" {
                    if let Some(m) = v.as_object().and_then(pick_editable_provider_options) {
                        dst.insert(k.clone(), Value::Object(m));
                    } else {
                        dst.remove("providerOptions");
                    }
                } else {
                    dst.insert(k.clone(), v.clone());
                }
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
        let backups_toggled = patch.get("backupsEnabled").and_then(Value::as_bool);
        let (event, meta_for_backup) = {
            let mut live = live_arc.lock();
            for (k, v) in patch {
                live.config_overrides.insert(k, v);
            }
            live.updated_at =
                chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            let evt = self.build_session_config_event(&live.id, &cfg, Some(&live.config_overrides));
            let meta = (
                live.id.clone(),
                live.title.clone(),
                live.provider.as_str().to_owned(),
                live.model.clone(),
            );
            (evt, meta)
        };
        self.persist_live_session(&live_arc, "session_config")
            .await
            .map_err(|e| e.to_string())?;
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
            if let Some(v) = cp.get("advancedMemory").and_then(Value::as_bool) {
                proj_patch.advanced_memory = Some(v);
            }
            if let Some(v) = cp.get("skillImprovementEnabled").and_then(Value::as_bool) {
                proj_patch.skill_improvement_enabled = Some(v);
            }
            if let Some(v) = cp.get("skillImprovementModel").and_then(Value::as_str) {
                proj_patch.skill_improvement_model = Some(v.to_owned());
            }
            if cp
                .get("clearSkillImprovementModel")
                .and_then(Value::as_bool)
                == Some(true)
            {
                proj_patch.clear_skill_improvement_model = true;
            }
            if let Some(v) = cp.get("skillImprovementScope")
                && let Ok(sc) = serde_json::from_value(v.clone())
            {
                proj_patch.skill_improvement_scope = Some(sc);
            }
            if let Some(arr) = cp
                .get("skillImprovementExcludedSkills")
                .and_then(Value::as_array)
            {
                proj_patch.skill_improvement_excluded_skills = Some(
                    arr.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect(),
                );
            }
            if let Some(v) = cp.get("preferredChildModel").and_then(Value::as_str) {
                proj_patch.preferred_child_model = Some(v.to_owned());
            }
            if let Some(v) = cp.get("preferredChildModelRef").and_then(Value::as_str) {
                proj_patch.preferred_child_model_ref = Some(v.to_owned());
            }
            if let Some(arr) = cp.get("allowedChildModelRefs").and_then(Value::as_array) {
                proj_patch.allowed_child_model_refs = Some(
                    arr.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect(),
                );
            }
            if let Some(ff_val) = cp.get("featureFlags")
                && let Ok(ff) = serde_json::from_value(ff_val.clone())
            {
                proj_patch.feature_flags = Some(ff);
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
        // Tombstone first: no new turn can load the thread and no late persist can recreate it.
        self.deleted_sessions
            .insert(target_session_id.to_owned(), ());
        if let Some((_, ctrl)) = self.agent_controls.remove(target_session_id) {
            ctrl.interrupt_running_children();
        }
        // Cancel the active root turn and wait (bounded) for it to settle so its tools stop and
        // its journal writer drains before the rows are removed (SessionRegistry.ts ordering).
        self.interrupt_session_for_quiesce(target_session_id, "Chat deleted");
        let deadline = Instant::now() + DELETE_SESSION_SETTLE_TIMEOUT;
        loop {
            let notified = self.turn_settled_notify.notified();
            if !self.active_turns.contains_key(target_session_id) {
                break;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                tracing::warn!(
                    session_id = target_session_id,
                    "active turn did not settle before chat delete; deleting anyway"
                );
                break;
            }
            let _ = tokio::time::timeout(remaining.min(Duration::from_millis(50)), notified).await;
        }
        self.journal.wait_for_idle(target_session_id).await;
        self.mcp_tool_cache.close_session(target_session_id).await;
        self.sessions.remove(target_session_id);
        self.creation_keys
            .retain(|_, bound_id| bound_id != target_session_id);
        if let Err(e) = self.session_db.delete_session(target_session_id).await {
            self.deleted_sessions.remove(target_session_id);
            return Err(e.to_string());
        }
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

fn pick_editable_provider_options(po: &Map<String, Value>) -> Option<Map<String, Value>> {
    let mut out = Map::new();

    let pick_openai_base = |obj: &Map<String, Value>| -> Map<String, Value> {
        let mut dst = Map::new();
        for key in ["reasoningEffort", "reasoningSummary", "textVerbosity"] {
            if let Some(s) = obj.get(key).and_then(Value::as_str).map(str::trim)
                && !s.is_empty()
            {
                dst.insert(key.to_owned(), Value::String(s.to_owned()));
            }
        }
        dst
    };

    if let Some(openai_obj) = po.get("openai").and_then(Value::as_object) {
        let m = pick_openai_base(openai_obj);
        if !m.is_empty() {
            out.insert("openai".to_owned(), Value::Object(m));
        }
    }

    if let Some(codex_obj) = po.get("codex-cli").and_then(Value::as_object) {
        let mut m = pick_openai_base(codex_obj);
        for key in [
            "webSearchBackend",
            "webSearchFallbackBackend",
            "webSearchMode",
        ] {
            if let Some(s) = codex_obj.get(key).and_then(Value::as_str).map(str::trim)
                && !s.is_empty()
            {
                m.insert(key.to_owned(), Value::String(s.to_owned()));
            }
        }
        if let Some(ws_obj) = codex_obj.get("webSearch").and_then(Value::as_object) {
            let mut ws_dst = Map::new();
            if let Some(cs) = ws_obj
                .get("contextSize")
                .and_then(Value::as_str)
                .map(str::trim)
                && !cs.is_empty()
            {
                ws_dst.insert("contextSize".to_owned(), Value::String(cs.to_owned()));
            }
            if let Some(domains) = ws_obj.get("allowedDomains").and_then(Value::as_array) {
                let strs: Vec<Value> = domains
                    .iter()
                    .filter_map(Value::as_str)
                    .map(|s| Value::String(s.to_owned()))
                    .collect();
                ws_dst.insert("allowedDomains".to_owned(), Value::Array(strs));
            }
            if let Some(loc_obj) = ws_obj.get("location").and_then(Value::as_object) {
                let mut loc_dst = Map::new();
                for k in ["country", "region", "city", "timezone"] {
                    if let Some(s) = loc_obj.get(k).and_then(Value::as_str) {
                        loc_dst.insert(k.to_owned(), Value::String(s.to_owned()));
                    }
                }
                if !loc_dst.is_empty() {
                    ws_dst.insert("location".to_owned(), Value::Object(loc_dst));
                }
            }
            if !ws_dst.is_empty() {
                m.insert("webSearch".to_owned(), Value::Object(ws_dst));
            }
        }
        if !m.is_empty() {
            out.insert("codex-cli".to_owned(), Value::Object(m));
        }
    }

    if let Some(google_obj) = po.get("google").and_then(Value::as_object) {
        let mut m = Map::new();
        if let Some(b) = google_obj.get("nativeWebSearch").and_then(Value::as_bool) {
            m.insert("nativeWebSearch".to_owned(), Value::Bool(b));
        }
        if let Some(tc_obj) = google_obj.get("thinkingConfig").and_then(Value::as_object)
            && let Some(tl) = tc_obj
                .get("thinkingLevel")
                .and_then(Value::as_str)
                .map(str::trim)
            && !tl.is_empty()
        {
            let mut tc_dst = Map::new();
            tc_dst.insert("thinkingLevel".to_owned(), Value::String(tl.to_owned()));
            m.insert("thinkingConfig".to_owned(), Value::Object(tc_dst));
        }
        if let Some(rf) = google_obj.get("responseFormat")
            && !rf.is_null()
        {
            m.insert("responseFormat".to_owned(), rf.clone());
        }
        if let Some(rmt) = google_obj
            .get("responseMimeType")
            .and_then(Value::as_str)
            .map(str::trim)
            && !rmt.is_empty()
        {
            m.insert("responseMimeType".to_owned(), Value::String(rmt.to_owned()));
        }
        if !m.is_empty() {
            out.insert("google".to_owned(), Value::Object(m));
        }
    }

    if let Some(lm_obj) = po.get("lmstudio").and_then(Value::as_object) {
        let mut m = Map::new();
        if let Some(s) = lm_obj.get("baseUrl").and_then(Value::as_str) {
            m.insert("baseUrl".to_owned(), Value::String(s.to_owned()));
        }
        if let Some(n) = lm_obj.get("contextLength").and_then(Value::as_u64)
            && n > 0
        {
            m.insert("contextLength".to_owned(), Value::from(n));
        }
        if let Some(b) = lm_obj.get("autoLoad").and_then(Value::as_bool) {
            m.insert("autoLoad".to_owned(), Value::Bool(b));
        }
        if let Some(b) = lm_obj
            .get("reloadOnContextMismatch")
            .and_then(Value::as_bool)
        {
            m.insert("reloadOnContextMismatch".to_owned(), Value::Bool(b));
        }
        if !m.is_empty() {
            out.insert("lmstudio".to_owned(), Value::Object(m));
        }
    }

    if out.is_empty() { None } else { Some(out) }
}
