//! Task Mode JSON-RPC routes (`task/*`, 26 methods), `WorkspaceTaskSubscribers`,
//! `ServerTaskToolBridge`, `ServerTaskThreadFactory`, `ServerTaskContinuationDispatcher`,
//! and `ServerTaskThreadQuiescer`.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use cowork_config::{ProviderName, canonicalize_sync, is_path_inside_one_off_chats_root};
use cowork_harness::tasks::{
    AcceptArtifactVersionRequest, ArtifactBlobInput, ArtifactComparisonService,
    ArtifactPreviewService, BriefRequirementInput, CaptureArtifactVersionRequest,
    RegisterArtifactRequest, ReplacementWorkItemInput, RestoreArtifactVersionRequest,
    StartArtifactRevisionRequest, TaskContinuationDispatcher, TaskCoordinatorError, TaskLockError,
    TaskLockKind, TaskNotification, TaskQuestionAnswerInput, TaskQuestionResumeStatus,
    TaskThreadFactory, TaskThreadFactoryInput, TaskThreadQuiescer, UpdateBriefRequest,
    build_artifact_revision_prompt, get_session_task_lock,
};
use cowork_protocol::{
    JsonRpcLiteError, JsonRpcLiteNotification, JsonRpcLiteOutbound, TurnInput, TurnStartParams,
    error_codes,
};
use cowork_storage::{
    SessionKind, SessionTitleSource, TaskContextSnapshot, TaskCreationOrigin, TaskCreationResult,
    TaskDirective, TaskDirectiveResult, TaskRecord, TaskRequirementKind,
    TaskReviewMaterialReference, TaskStatus, ThreadJournalEventInput, ValidatedTaskCreationInput,
    WorkItemStatus, parse_and_validate_task_creation_input,
};
use cowork_tools::TaskToolBridge;
use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use uuid::Uuid;

use crate::http_desktop::build_workspace_summaries;
use crate::jsonrpc::ConnectionRpcState;
use crate::registry::{LiveSession, ServerRuntimeState};

const DEFAULT_TASK_TERMINAL_QUIESCE_TIMEOUT: Duration = Duration::from_secs(30);

const TASK_READ_ONLY_METHODS: &[&str] = &[
    "task/list",
    "task/read",
    "task/artifact/version/compare",
    "task/artifact/version/preview",
];

// ============================================================================
// WorkspaceTaskSubscribers (`WorkspaceJsonRpcSubscribers` parity)
// ============================================================================

struct BufferedTaskRegistration {
    active_handles: usize,
    committed: bool,
    invalidated: bool,
    task_read_allowed: bool,
    messages: Vec<(String, Value)>,
}

#[derive(Default)]
struct WorkspaceTaskSubscribersState {
    /// `workspace_path -> (connection_id -> task_read_allowed)`
    subscribers: HashMap<String, HashMap<String, bool>>,
    /// `workspace_path -> (connection_id -> BufferedTaskRegistration)`
    buffered: HashMap<String, HashMap<String, BufferedTaskRegistration>>,
}

pub struct WorkspaceTaskSubscribers {
    inner: Mutex<WorkspaceTaskSubscribersState>,
}

pub struct BufferedTaskSubscriptionGuard {
    subscribers: Arc<WorkspaceTaskSubscribers>,
    runtime: Arc<ServerRuntimeState>,
    workspace_path: String,
    connection_id: String,
    task_read_allowed: bool,
    active: bool,
}

impl BufferedTaskSubscriptionGuard {
    pub fn commit(mut self) {
        if !self.active {
            return;
        }
        self.active = false;
        self.subscribers.commit_buffered(
            &self.runtime,
            &self.workspace_path,
            &self.connection_id,
            self.task_read_allowed,
        );
    }

    pub fn rollback(mut self) {
        if !self.active {
            return;
        }
        self.active = false;
        self.subscribers
            .rollback_buffered(&self.workspace_path, &self.connection_id);
    }
}

impl Drop for BufferedTaskSubscriptionGuard {
    fn drop(&mut self) {
        if self.active {
            self.active = false;
            self.subscribers
                .rollback_buffered(&self.workspace_path, &self.connection_id);
        }
    }
}

impl Default for WorkspaceTaskSubscribers {
    fn default() -> Self {
        Self::new()
    }
}

impl WorkspaceTaskSubscribers {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(WorkspaceTaskSubscribersState::default()),
        }
    }

    fn canonical_key(cwd: &str) -> String {
        canonicalize_sync(Path::new(cwd))
            .to_string_lossy()
            .into_owned()
    }

    pub fn register(&self, connection_id: &str, cwd: &str, task_read_allowed: bool) {
        if connection_id.is_empty() || connection_id == "internal" {
            return;
        }
        let key = Self::canonical_key(cwd);
        let mut st = self.inner.lock();
        st.subscribers
            .entry(key)
            .or_default()
            .insert(connection_id.to_owned(), task_read_allowed);
    }

    pub fn begin_buffered_registration(
        self: &Arc<Self>,
        runtime: &Arc<ServerRuntimeState>,
        connection_id: &str,
        cwd: &str,
        task_read_allowed: bool,
    ) -> Option<BufferedTaskSubscriptionGuard> {
        if connection_id.is_empty() || connection_id == "internal" {
            return None;
        }
        let workspace_path = Self::canonical_key(cwd);
        {
            let mut st = self.inner.lock();
            if st
                .subscribers
                .get(&workspace_path)
                .is_some_and(|m| m.contains_key(connection_id))
            {
                return None;
            }
            let buf_map = st.buffered.entry(workspace_path.clone()).or_default();
            let entry = buf_map.entry(connection_id.to_owned()).or_insert_with(|| {
                BufferedTaskRegistration {
                    active_handles: 0,
                    committed: false,
                    invalidated: false,
                    task_read_allowed,
                    messages: Vec::new(),
                }
            });
            entry.active_handles += 1;
            entry.task_read_allowed = task_read_allowed;
        }

        Some(BufferedTaskSubscriptionGuard {
            subscribers: Arc::clone(self),
            runtime: Arc::clone(runtime),
            workspace_path,
            connection_id: connection_id.to_owned(),
            task_read_allowed,
            active: true,
        })
    }

    fn commit_buffered(
        &self,
        runtime: &ServerRuntimeState,
        workspace_path: &str,
        connection_id: &str,
        task_read_allowed: bool,
    ) {
        let flushed = {
            let mut st = self.inner.lock();
            let mut pending_msgs = Vec::new();
            let mut should_register = false;
            if let Some(buf_map) = st.buffered.get_mut(workspace_path) {
                if let Some(entry) = buf_map.get_mut(connection_id) {
                    entry.active_handles = entry.active_handles.saturating_sub(1);
                    if !entry.invalidated && !entry.committed {
                        entry.committed = true;
                        should_register = true;
                        pending_msgs = std::mem::take(&mut entry.messages);
                    }
                }
                buf_map.remove(connection_id);
                if buf_map.is_empty() {
                    st.buffered.remove(workspace_path);
                }
            }
            if should_register {
                st.subscribers
                    .entry(workspace_path.to_owned())
                    .or_default()
                    .insert(connection_id.to_owned(), task_read_allowed);
            }
            pending_msgs
        };

        for (method, params) in flushed {
            runtime.send_to_connection(
                connection_id,
                &JsonRpcLiteOutbound::Notification(JsonRpcLiteNotification {
                    method,
                    params: Some(params),
                }),
            );
        }
    }

    fn rollback_buffered(&self, workspace_path: &str, connection_id: &str) {
        let mut st = self.inner.lock();
        if let Some(buf_map) = st.buffered.get_mut(workspace_path) {
            let mut remove_entry = false;
            if let Some(entry) = buf_map.get_mut(connection_id) {
                entry.active_handles = entry.active_handles.saturating_sub(1);
                if !entry.invalidated && !entry.committed && entry.active_handles == 0 {
                    remove_entry = true;
                }
            }
            if remove_entry {
                buf_map.remove(connection_id);
            }
            if buf_map.is_empty() {
                st.buffered.remove(workspace_path);
            }
        }
    }

    pub fn remove_connection(&self, connection_id: &str) {
        let mut st = self.inner.lock();
        let empty_buf_keys: Vec<String> = st
            .buffered
            .iter_mut()
            .filter_map(|(ws_path, buf_map)| {
                if let Some(mut entry) = buf_map.remove(connection_id) {
                    entry.invalidated = true;
                }
                buf_map.is_empty().then(|| ws_path.clone())
            })
            .collect();
        for k in empty_buf_keys {
            st.buffered.remove(&k);
        }

        let empty_sub_keys: Vec<String> = st
            .subscribers
            .iter_mut()
            .filter_map(|(ws_path, sub_map)| {
                sub_map.remove(connection_id);
                sub_map.is_empty().then(|| ws_path.clone())
            })
            .collect();
        for k in empty_sub_keys {
            st.subscribers.remove(&k);
        }
    }

    pub fn clear(&self) {
        let mut st = self.inner.lock();
        for buf_map in st.buffered.values_mut() {
            for entry in buf_map.values_mut() {
                entry.invalidated = true;
            }
        }
        st.subscribers.clear();
        st.buffered.clear();
    }

    pub fn notify(&self, runtime: &ServerRuntimeState, notification: TaskNotification) {
        let Some(cwd) = notification.params.get("cwd").and_then(Value::as_str) else {
            return;
        };
        let workspace_path = Self::canonical_key(cwd);
        let direct_targets: Vec<String> = {
            let mut st = self.inner.lock();
            let direct: Vec<String> = st
                .subscribers
                .get(&workspace_path)
                .map(|m| {
                    m.iter()
                        .filter(|&(_cid, &allowed)| allowed)
                        .map(|(cid, _)| cid.clone())
                        .collect()
                })
                .unwrap_or_default();
            let direct_set: HashSet<&str> = direct.iter().map(String::as_str).collect();
            if let Some(buf_map) = st.buffered.get_mut(&workspace_path) {
                for (cid, entry) in buf_map.iter_mut() {
                    if direct_set.contains(cid.as_str()) || !entry.task_read_allowed {
                        continue;
                    }
                    entry
                        .messages
                        .push((notification.method.to_owned(), notification.params.clone()));
                }
            }
            direct
        };

        if direct_targets.is_empty() {
            return;
        }
        let frame = JsonRpcLiteOutbound::Notification(JsonRpcLiteNotification {
            method: notification.method.to_owned(),
            params: Some(notification.params),
        });
        for cid in direct_targets {
            runtime.send_to_connection(&cid, &frame);
        }
    }
}

// ============================================================================
// Coordinator Runtime Adapters (`ThreadFactory`, `Continuation`, `Quiescer`, `ToolBridge`)
// ============================================================================

pub(crate) struct ServerTaskThreadFactory {
    pub runtime: Weak<ServerRuntimeState>,
}

#[async_trait]
impl TaskThreadFactory for ServerTaskThreadFactory {
    async fn create_task_thread(&self, input: TaskThreadFactoryInput) -> Result<String, String> {
        let runtime = self
            .runtime
            .upgrade()
            .ok_or_else(|| "Server runtime has shut down.".to_owned())?;
        let cwd = PathBuf::from(&input.task.workspace_path);
        runtime
            .create_unsubscribed_root_session(
                &cwd,
                input.provider.as_deref(),
                input.model.as_deref(),
                Some(&input.title),
            )
            .await
    }
}

pub(crate) struct ServerTaskContinuationDispatcher {
    pub runtime: Weak<ServerRuntimeState>,
}

#[async_trait]
impl TaskContinuationDispatcher for ServerTaskContinuationDispatcher {
    async fn dispatch_continuation(
        &self,
        session_id: String,
        prompt: String,
        display_text: String,
    ) -> Result<TaskQuestionResumeStatus, String> {
        let runtime = self
            .runtime
            .upgrade()
            .ok_or_else(|| "Server runtime has shut down.".to_owned())?;
        if runtime.load_thread(&session_id).is_none() {
            return Err("Task continuation thread could not be loaded".to_owned());
        }

        if let Some(ctrl) = runtime.active_turns.get(&session_id) {
            let steer = Arc::clone(&ctrl.steer);
            drop(ctrl);
            steer.enqueue_steer(prompt, None).map_err(|e| e.message)?;
            return Ok(TaskQuestionResumeStatus::Steered);
        }

        runtime
            .handle_turn_start_with_display(
                "internal",
                false,
                &TurnStartParams {
                    thread_id: session_id,
                    input: TurnInput::Text(prompt),
                    client_message_id: None,
                    references: None,
                    retry: None,
                },
                Some(display_text),
            )
            .await
            .map_err(|e| e.message)?;

        Ok(TaskQuestionResumeStatus::Queued)
    }
}

pub(crate) struct ServerTaskThreadQuiescer {
    pub runtime: Weak<ServerRuntimeState>,
}

#[async_trait]
impl TaskThreadQuiescer for ServerTaskThreadQuiescer {
    async fn quiesce_task_threads(
        &self,
        task: TaskRecord,
        reason: TaskStatus,
        origin_session_id: Option<String>,
    ) -> Result<(), String> {
        let Some(runtime) = self.runtime.upgrade() else {
            return Ok(());
        };
        let mut session_ids: HashSet<String> =
            task.threads.iter().map(|t| t.session_id.clone()).collect();
        if let Some(ref src) = task.source_session_id {
            session_ids.insert(src.clone());
        }

        let interrupt_msg = format!("Task became {}", reason.as_str());
        for sid in &session_ids {
            if origin_session_id.as_deref() == Some(sid.as_str()) {
                continue;
            }
            runtime.interrupt_session_for_quiesce(sid, &interrupt_msg);
        }

        for sid in &session_ids {
            if let Some(ctrl) = runtime
                .agent_controls
                .get(sid)
                .map(|r| Arc::clone(r.value()))
            {
                ctrl.quiesce_children(DEFAULT_TASK_TERMINAL_QUIESCE_TIMEOUT)
                    .await?;
            }
        }

        let deadline = Instant::now() + DEFAULT_TASK_TERMINAL_QUIESCE_TIMEOUT;
        for sid in &session_ids {
            loop {
                let busy = runtime.active_turns.contains_key(sid)
                    || runtime.get_live_thread(sid).is_some_and(|l| l.lock().busy);
                if !busy {
                    break;
                }
                let now = Instant::now();
                if now >= deadline {
                    runtime.interrupt_session_for_quiesce(sid, &interrupt_msg);
                    return Err(format!(
                        "Timed out waiting for task session {sid} to quiesce"
                    ));
                }
                // If origin session is still busy after 5 seconds (e.g. model kept generating), interrupt it cleanly
                if origin_session_id.as_deref() == Some(sid.as_str())
                    && deadline.saturating_duration_since(now)
                        < DEFAULT_TASK_TERMINAL_QUIESCE_TIMEOUT
                            .saturating_sub(Duration::from_secs(5))
                {
                    runtime.interrupt_session_for_quiesce(sid, &interrupt_msg);
                }
                let notified = runtime.turn_settled_notify.notified();
                let still_busy = runtime.active_turns.contains_key(sid)
                    || runtime.get_live_thread(sid).is_some_and(|l| l.lock().busy);
                if !still_busy {
                    break;
                }
                let wait_slice = deadline
                    .saturating_duration_since(Instant::now())
                    .min(Duration::from_millis(50));
                let _ = tokio::time::timeout(wait_slice, notified).await;
            }
            runtime.journal.wait_for_idle(sid).await;
        }

        Ok(())
    }
}

pub(crate) struct ServerTaskToolBridge {
    pub runtime: Arc<ServerRuntimeState>,
    pub connection_id: String,
}

#[async_trait]
impl TaskToolBridge for ServerTaskToolBridge {
    fn get_task_context(&self, session_id: &str) -> Option<TaskContextSnapshot> {
        self.runtime
            .task_coordinator
            .get_context_for_thread(session_id)
    }

    async fn get_task_review_material(
        &self,
        session_id: &str,
    ) -> Result<TaskReviewMaterialReference, String> {
        self.runtime
            .task_coordinator
            .get_review_material_for_thread(session_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Task mode is not active for this thread".to_owned())
    }

    async fn apply_task_directive(
        &self,
        session_id: &str,
        directive: TaskDirective,
    ) -> Result<TaskDirectiveResult, String> {
        self.runtime
            .task_coordinator
            .apply_directive(session_id, directive)
            .await
            .map_err(|e| e.to_string())
    }

    async fn create_task(
        &self,
        session_id: &str,
        input: ValidatedTaskCreationInput,
    ) -> Result<TaskCreationResult, String> {
        self.runtime
            .create_task_from_chat(session_id, &self.connection_id, input)
            .await
    }
}

pub(crate) fn format_tool_task_lock_error(tool_name: &str, lock: &TaskLockError) -> String {
    match lock.data.lock_kind {
        TaskLockKind::TerminalTaskThread => format!(
            "Tool {tool_name} blocked because task {} is {}. Reopen or retry the task before mutating files or tools.",
            lock.data.task_id,
            lock.data.task_status.as_str()
        ),
        TaskLockKind::ActiveSourceChat => format!(
            "Tool {tool_name} blocked because source chat is locked by active task {}: {}. Continue in the task thread or wait until the task reaches a terminal state.",
            lock.data.task_id,
            lock.data.task_title.as_deref().unwrap_or("")
        ),
    }
}

// ============================================================================
// ServerRuntimeState Task Methods & Route Dispatcher
// ============================================================================

impl ServerRuntimeState {
    pub async fn init_task_coordinator(self: &Arc<Self>) {
        let weak = Arc::downgrade(self);
        *self.task_notif_runtime.lock() = Some(weak.clone());
        self.task_coordinator
            .set_thread_factory(Arc::new(ServerTaskThreadFactory {
                runtime: weak.clone(),
            }));
        self.task_coordinator.set_continuation_dispatcher(Arc::new(
            ServerTaskContinuationDispatcher {
                runtime: weak.clone(),
            },
        ));
        self.task_coordinator
            .set_quiescer(Arc::new(ServerTaskThreadQuiescer { runtime: weak }));
        let ws = self.working_directory.to_string_lossy().into_owned();
        let _ = self.task_coordinator.reconcile_failed_runs(Some(&ws)).await;
    }

    pub fn is_tasks_enabled(&self, workspace_hint: Option<&Path>) -> bool {
        if let Some(ws) = workspace_hint
            && let Ok(cfg) = self.load_workspace_config(ws)
        {
            return cfg.tasks_enabled;
        }
        self.load_workspace_config(&self.working_directory)
            .map(|c| c.tasks_enabled)
            .unwrap_or(false)
    }

    pub fn get_session_task_lock(&self, session_id: &str) -> Option<TaskLockError> {
        get_session_task_lock(
            Some(&self.session_db),
            session_id,
            Some(&|sid: &str| {
                self.get_live_thread(sid)
                    .and_then(|l| l.lock().parent_session_id.clone())
            }),
        )
    }

    pub(crate) fn interrupt_session_for_quiesce(&self, session_id: &str, reason: &str) {
        if let Some(ctrl) = self.active_turns.get(session_id) {
            ctrl.cancel.interrupt(reason);
            ctrl.steer.interrupt_codex_if_bound();
            ctrl.interactions.cancel_all_pending(reason);
        }
        if let Some(live_arc) = self.get_live_thread(session_id) {
            let mut live = live_arc.lock();
            live.provider_state = None;
            live.has_pending_approval = false;
            live.has_pending_ask = false;
        }
    }

    pub(crate) async fn create_unsubscribed_root_session(
        &self,
        cwd: &Path,
        provider_override: Option<&str>,
        model_override: Option<&str>,
        title_override: Option<&str>,
    ) -> Result<String, String> {
        let canonical_cwd = canonicalize_sync(cwd);
        let cwd_str = canonical_cwd.to_string_lossy().into_owned();
        let cfg = self
            .load_workspace_config(&canonical_cwd)
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

        let session_id = Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let clean_title = title_override
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("New session");
        let title_source = if title_override.map(str::trim).is_some_and(|s| !s.is_empty()) {
            SessionTitleSource::Manual
        } else {
            SessionTitleSource::Default
        };

        let live = LiveSession {
            id: session_id.clone(),
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
            title: clean_title.to_owned(),
            title_source,
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
            subscribers: HashSet::new(),
            idle_since: Some(Instant::now()),
        };

        let live_arc = Arc::new(Mutex::new(live));
        self.sessions.insert(session_id.clone(), live_arc.clone());
        self.persist_live_session(&live_arc, "thread/started")
            .await
            .map_err(|e| format!("Failed to persist task thread: {e}"))?;

        let thread = self.build_thread_from_live(&live_arc.lock());
        let _ = self
            .journal
            .enqueue(ThreadJournalEventInput {
                thread_id: session_id.clone(),
                ts: now,
                event_type: "thread/started".to_owned(),
                turn_id: None,
                item_id: None,
                request_id: None,
                payload: json!({ "thread": thread }),
            })
            .await;

        Ok(session_id)
    }

    pub(crate) fn subscribe_source_chat_to_task_workspace(
        &self,
        source_session_id: &str,
        fallback_connection_id: &str,
        workspace_path: &str,
    ) {
        let mut conn_ids: Vec<String> = self
            .get_live_thread(source_session_id)
            .map(|l| l.lock().subscribers.iter().cloned().collect())
            .unwrap_or_default();
        if !fallback_connection_id.is_empty()
            && fallback_connection_id != "internal"
            && !conn_ids.iter().any(|c| c == fallback_connection_id)
        {
            conn_ids.push(fallback_connection_id.to_owned());
        }
        for cid in conn_ids {
            self.task_subscribers.register(&cid, workspace_path, true);
        }
    }

    pub async fn create_task_from_chat(
        self: &Arc<Self>,
        source_session_id: &str,
        connection_id: &str,
        creation: ValidatedTaskCreationInput,
    ) -> Result<TaskCreationResult, String> {
        let Some(src_arc) = self.load_thread(source_session_id) else {
            return Err("Tasks can be created only from a root chat".to_owned());
        };
        let (session_kind, cwd_str, src_provider, src_model) = {
            let live = src_arc.lock();
            (
                live.session_kind,
                live.cwd.clone(),
                live.provider,
                live.model.clone(),
            )
        };
        let cwd_path = canonicalize_sync(Path::new(&cwd_str));
        if !self.is_tasks_enabled(Some(&cwd_path)) {
            return Err("Tasks feature is disabled".to_owned());
        }
        if session_kind != SessionKind::Root {
            return Err("Tasks can be created only from a root chat".to_owned());
        }
        if self.task_coordinator.is_task_thread(source_session_id) {
            return Err("Task mode is already active for this thread".to_owned());
        }

        let canonical_cwd_str = cwd_path.to_string_lossy().into_owned();
        if let Some(existing) = self
            .task_coordinator
            .get_by_creation_key(
                &creation.idempotency_key,
                Some(source_session_id),
                Some(&canonical_cwd_str),
            )
            .map_err(|e| e.to_string())?
        {
            let disp = if is_path_inside_one_off_chats_root(
                Path::new(&existing.workspace_path),
                &self.homedir,
            ) {
                "promote_one_off"
            } else {
                "existing_project"
            };
            return Ok(TaskCreationResult {
                task: existing,
                workspace_disposition: disp.to_owned(),
            });
        }

        if let Some(active) = self
            .task_coordinator
            .get_active_for_source_session(source_session_id)
            .map_err(|e| e.to_string())?
        {
            return Err(format!("This chat is locked by active task {}", active.id));
        }

        let workspace_disposition = if is_path_inside_one_off_chats_root(&cwd_path, &self.homedir) {
            "promote_one_off"
        } else {
            "existing_project"
        };

        let task_session_id = self
            .create_unsubscribed_root_session(
                &cwd_path,
                Some(src_provider.as_str()),
                Some(&src_model),
                Some(&creation.title),
            )
            .await?;

        self.subscribe_source_chat_to_task_workspace(
            source_session_id,
            connection_id,
            &canonical_cwd_str,
        );

        let created_res = match self
            .task_coordinator
            .create_planned(
                &canonical_cwd_str,
                &task_session_id,
                Some(source_session_id),
                TaskCreationOrigin::ChatTool,
                workspace_disposition,
                creation,
                None,
            )
            .await
        {
            Ok(res) => res,
            Err(err) => {
                self.sessions.remove(&task_session_id);
                let _ = self.session_db.delete_session(&task_session_id).await;
                return Err(err.to_string());
            }
        };

        self.spawn_task_kickoff_turn(&task_session_id, &created_res.task.title, connection_id);
        Ok(created_res)
    }

    pub(crate) fn spawn_task_kickoff_turn(
        self: &Arc<Self>,
        task_session_id: &str,
        task_title: &str,
        connection_id: &str,
    ) {
        let kickoff = format!(
            "Execute the task \"{task_title}\" using the existing task brief and work graph.\n\nStart with the first unblocked work item. Maintain task state with taskUpdate and ask only at material decision boundaries."
        );
        let display_text = format!("Start task: {task_title}");
        let rt = Arc::clone(self);
        let sid = task_session_id.to_owned();
        let cid = if connection_id.is_empty() {
            "internal".to_owned()
        } else {
            connection_id.to_owned()
        };
        tokio::spawn(async move {
            let start_res = rt
                .handle_turn_start_with_display(
                    &cid,
                    false,
                    &TurnStartParams {
                        thread_id: sid.clone(),
                        input: TurnInput::Text(kickoff),
                        client_message_id: None,
                        references: None,
                        retry: None,
                    },
                    Some(display_text),
                )
                .await;
            if let Err(err) = start_res {
                let _ = rt
                    .task_coordinator
                    .handle_thread_outcome(&sid, "error", Some(&err.message))
                    .await;
            }
        });
    }

    /// Resolves and validates an authorized project workspace for direct `task/*` RPCs.
    fn resolve_project_task_workspace(
        &self,
        raw_cwd: Option<&str>,
        method: &str,
    ) -> Result<String, String> {
        let resolved_path = match self.resolve_workspace_path(raw_cwd, method) {
            Ok(p) => p,
            Err(err) => {
                let Some(req_cwd) = raw_cwd.map(str::trim).filter(|s| !s.is_empty()) else {
                    return Err(err);
                };
                if self.desktop_service.is_none() {
                    return Err(err);
                }
                let candidate = Path::new(req_cwd);
                if !candidate.is_dir() {
                    return Err(err);
                }
                let canon = canonicalize_sync(candidate);
                let (workspaces, _) = build_workspace_summaries(
                    &self.working_directory,
                    &self.homedir,
                    self.desktop_service.as_deref(),
                );
                let Some(found) = workspaces
                    .into_iter()
                    .find(|w| w.path == canon.to_string_lossy())
                else {
                    return Err(err);
                };
                if found.workspace_kind != "project" {
                    return Err(format!(
                        "{method} cwd must match an authorized project workspace"
                    ));
                }
                return Ok(found.path);
            }
        };

        let is_one_off = is_path_inside_one_off_chats_root(&resolved_path, &self.homedir);
        if let Some(svc) = &self.desktop_service {
            let (workspaces, _) = build_workspace_summaries(
                &self.working_directory,
                &self.homedir,
                Some(svc.as_ref()),
            );
            let canonical_str = resolved_path.to_string_lossy().into_owned();
            if let Some(entry) = workspaces.iter().find(|w| w.path == canonical_str) {
                if entry.workspace_kind != "project" {
                    return Err(format!(
                        "{method} cwd must match an authorized project workspace"
                    ));
                }
                return Ok(canonical_str);
            }
            if is_one_off {
                return Err(format!(
                    "{method} cwd must match an authorized project workspace"
                ));
            }
            return Ok(canonical_str);
        }

        if is_one_off {
            return Err(format!(
                "{method} cwd must match an authorized project workspace"
            ));
        }

        Ok(resolved_path.to_string_lossy().into_owned())
    }

    pub async fn handle_task_rpc(
        self: &Arc<Self>,
        conn: &ConnectionRpcState,
        method: &str,
        raw_params: Option<&Value>,
    ) -> Result<Value, JsonRpcLiteError> {
        if !self.is_tasks_enabled(None) {
            return Err(JsonRpcLiteError::new(
                error_codes::METHOD_NOT_FOUND,
                format!("Unknown method: {method}"),
            ));
        }

        // Permission enforcement (`conversations` for reads, `conversations` + `turns` for mutations)
        let is_read_only = TASK_READ_ONLY_METHODS.contains(&method);
        if !conn.task_read_allowed() {
            return Err(JsonRpcLiteError::with_data(
                error_codes::INVALID_REQUEST,
                format!("{method} requires conversations permission"),
                json!({
                    "category": "permission_denied",
                    "permission": "conversations",
                }),
            ));
        }
        if !is_read_only && !conn.task_mutation_allowed() {
            return Err(JsonRpcLiteError::with_data(
                error_codes::INVALID_REQUEST,
                format!("{method} requires turns permission"),
                json!({
                    "category": "permission_denied",
                    "permission": "turns",
                }),
            ));
        }

        let params_obj = parse_task_params_obj(method, raw_params)?;
        let raw_cwd = validate_optional_cwd(method, &params_obj)?;

        // Parse and strictly validate method-specific schema BEFORE resolving workspace
        // so schema errors consistently return INVALID_PARAMS (-32602).
        let validated = parse_and_validate_task_method_params(method, &params_obj)?;

        let workspace_path = self
            .resolve_project_task_workspace(raw_cwd.as_deref(), method)
            .map_err(|m| JsonRpcLiteError::new(error_codes::INVALID_REQUEST, m))?;

        let pending_sub = self.task_subscribers.begin_buffered_registration(
            self,
            &conn.connection_id,
            &workspace_path,
            conn.task_read_allowed(),
        );

        let run_res = self
            .execute_validated_task_rpc(conn, method, validated, &workspace_path)
            .await;

        match run_res {
            Ok(result) => {
                if let Some(guard) = pending_sub {
                    guard.commit();
                } else {
                    self.task_subscribers.register(
                        &conn.connection_id,
                        &workspace_path,
                        conn.task_read_allowed(),
                    );
                }
                Ok(result)
            }
            Err(err) => {
                if let Some(guard) = pending_sub {
                    guard.rollback();
                }
                Err(map_task_coordinator_error(err))
            }
        }
    }

    async fn execute_validated_task_rpc(
        self: &Arc<Self>,
        conn: &ConnectionRpcState,
        method: &str,
        params: ValidatedTaskRpcParams,
        workspace_path: &str,
    ) -> Result<Value, TaskCoordinatorError> {
        match params {
            ValidatedTaskRpcParams::Create {
                provider,
                model,
                creation,
            } => {
                self.wait_for_startup_ready().await;
                if let Some(existing) = self.task_coordinator.get_by_creation_key(
                    &creation.idempotency_key,
                    None,
                    Some(workspace_path),
                )? {
                    let main_sid = existing
                        .threads
                        .first()
                        .map(|t| t.session_id.as_str())
                        .ok_or_else(|| {
                            TaskCoordinatorError::InvalidRequest(
                                "The existing task thread is unavailable".to_owned(),
                            )
                        })?;
                    let thread = if let Some(live_arc) = self.get_live_thread(main_sid) {
                        self.build_thread_from_live(&live_arc.lock())
                    } else if let Some(rec) =
                        self.session_db.get_session_record(main_sid).ok().flatten()
                    {
                        self.build_thread_from_record(&rec)
                    } else {
                        return Err(TaskCoordinatorError::InvalidRequest(
                            "The existing task thread is unavailable".to_owned(),
                        ));
                    };
                    return Ok(json!({ "task": existing, "thread": thread }));
                }

                let cwd_path = PathBuf::from(workspace_path);
                let session_id = self
                    .create_unsubscribed_root_session(
                        &cwd_path,
                        provider.as_deref(),
                        model.as_deref(),
                        Some(&creation.title),
                    )
                    .await
                    .map_err(TaskCoordinatorError::InvalidRequest)?;

                let created = match self
                    .task_coordinator
                    .create_planned(
                        workspace_path,
                        &session_id,
                        None,
                        TaskCreationOrigin::Manual,
                        "existing_project",
                        creation,
                        None,
                    )
                    .await
                {
                    Ok(res) => res,
                    Err(err) => {
                        self.sessions.remove(&session_id);
                        let _ = self.session_db.delete_session(&session_id).await;
                        return Err(err);
                    }
                };

                let live_arc = self.load_thread(&session_id).ok_or_else(|| {
                    TaskCoordinatorError::InvalidRequest(
                        "Task thread runtime is unavailable".to_owned(),
                    )
                })?;
                let thread = self.build_thread_from_live(&live_arc.lock());
                self.spawn_task_kickoff_turn(&session_id, &created.task.title, &conn.connection_id);
                Ok(json!({ "task": created.task, "thread": thread }))
            }

            ValidatedTaskRpcParams::List => {
                let tasks = self.task_coordinator.list(Some(workspace_path))?;
                let total = tasks.len();
                Ok(json!({ "tasks": tasks, "total": total }))
            }

            ValidatedTaskRpcParams::Read { task_id } => {
                let task = self.task_coordinator.get(&task_id, Some(workspace_path))?;
                Ok(json!({ "task": task }))
            }

            ValidatedTaskRpcParams::UpdateBrief {
                task_id,
                expected_revision,
                title,
                objective,
                requirements,
            } => {
                let task = self
                    .task_coordinator
                    .update_brief(UpdateBriefRequest {
                        task_id,
                        workspace_path: workspace_path.to_owned(),
                        expected_revision,
                        title,
                        objective,
                        requirements,
                    })
                    .await?;
                Ok(json!({ "task": task }))
            }

            ValidatedTaskRpcParams::UpdateGraph {
                task_id,
                expected_revision,
                work_items,
            } => {
                let task = self
                    .task_coordinator
                    .replace_work_items(&task_id, workspace_path, expected_revision, work_items)
                    .await?;
                Ok(json!({ "task": task }))
            }

            ValidatedTaskRpcParams::WorkItemClaim {
                task_id,
                expected_revision,
                work_item_id,
                task_thread_id,
            } => {
                let task = self
                    .task_coordinator
                    .claim_work_item(
                        &task_id,
                        workspace_path,
                        &work_item_id,
                        &task_thread_id,
                        expected_revision,
                    )
                    .await?;
                Ok(json!({ "task": task }))
            }

            ValidatedTaskRpcParams::WorkItemMark {
                task_id,
                expected_revision,
                work_item_id,
                status,
                completion_evidence,
            } => {
                let task = self
                    .task_coordinator
                    .mark_work_item(
                        &task_id,
                        workspace_path,
                        &work_item_id,
                        expected_revision,
                        status,
                        completion_evidence.as_deref(),
                        None,
                    )
                    .await?;
                Ok(json!({ "task": task }))
            }

            ValidatedTaskRpcParams::DecisionRecord {
                task_id,
                expected_revision,
                question,
                resolution,
                source,
                scope,
                confidence,
                supersedes,
            } => {
                let task = self
                    .task_coordinator
                    .record_decision(
                        &task_id,
                        workspace_path,
                        expected_revision,
                        &question,
                        &resolution,
                        &source,
                        scope.as_deref(),
                        confidence,
                        supersedes.as_deref(),
                    )
                    .await?;
                Ok(json!({ "task": task }))
            }

            ValidatedTaskRpcParams::QuestionsResolve {
                task_id,
                expected_revision,
                answers,
            } => {
                let (task, resume_status) = self
                    .task_coordinator
                    .resolve_questions(&task_id, workspace_path, expected_revision, answers)
                    .await?;
                Ok(json!({
                    "task": task,
                    "resumeStatus": resume_status.as_str(),
                }))
            }

            ValidatedTaskRpcParams::BlockerReport {
                task_id,
                expected_revision,
                description,
                blocking,
                work_item_id,
            } => {
                let task = self
                    .task_coordinator
                    .report_blocker(
                        &task_id,
                        workspace_path,
                        expected_revision,
                        &description,
                        blocking,
                        work_item_id.as_deref(),
                    )
                    .await?;
                Ok(json!({ "task": task }))
            }

            ValidatedTaskRpcParams::BlockerResolve {
                task_id,
                expected_revision,
                blocker_id,
            } => {
                let task = self
                    .task_coordinator
                    .resolve_blocker(&task_id, workspace_path, &blocker_id, expected_revision)
                    .await?;
                Ok(json!({ "task": task }))
            }

            ValidatedTaskRpcParams::ArtifactRegister {
                task_id,
                expected_revision,
                path,
                title,
                kind,
                artifact_id,
                base_version_id,
                change_summary,
                work_item_id,
                provenance,
            } => {
                let task = self
                    .task_coordinator
                    .register_artifact(RegisterArtifactRequest {
                        task_id,
                        workspace_path: workspace_path.to_owned(),
                        expected_revision,
                        session_id: None,
                        path,
                        title,
                        kind,
                        artifact_id,
                        base_version_id,
                        change_summary,
                        work_item_id,
                        provenance,
                    })
                    .await?;
                Ok(json!({ "task": task }))
            }

            ValidatedTaskRpcParams::ArtifactRead {
                task_id,
                artifact_id,
            } => {
                let mut detail = self
                    .task_coordinator
                    .get_artifact_detail(&task_id, workspace_path, &artifact_id)?
                    .ok_or_else(|| {
                        TaskCoordinatorError::InvalidRequest(format!(
                            "Unknown task artifact: {artifact_id}"
                        ))
                    })?;
                if detail.versions.is_empty() {
                    let task = self
                        .task_coordinator
                        .get(&task_id, Some(workspace_path))?
                        .ok_or_else(|| {
                            TaskCoordinatorError::InvalidRequest(format!("Unknown task: {task_id}"))
                        })?;
                    if !matches!(
                        task.status,
                        TaskStatus::Completed | TaskStatus::Cancelled | TaskStatus::Failed
                    ) {
                        match self
                            .task_coordinator
                            .ensure_artifact_baseline(
                                &task_id,
                                workspace_path,
                                &artifact_id,
                                task.revision,
                                None,
                                Some("system"),
                            )
                            .await
                        {
                            Ok(d) => detail = d,
                            Err(err) => {
                                let concurrent = self
                                    .task_coordinator
                                    .get_artifact_detail(&task_id, workspace_path, &artifact_id)?
                                    .filter(|d| !d.versions.is_empty());
                                match concurrent {
                                    Some(d) => detail = d,
                                    None => return Err(err),
                                }
                            }
                        }
                    }
                }
                Ok(json!({ "detail": detail }))
            }

            ValidatedTaskRpcParams::ArtifactVersionCapture {
                task_id,
                artifact_id,
                expected_revision,
                change_summary,
            } => {
                let (task, detail, _ver) = self
                    .task_coordinator
                    .capture_artifact_version(CaptureArtifactVersionRequest {
                        task_id,
                        workspace_path: workspace_path.to_owned(),
                        artifact_id,
                        expected_revision,
                        expected_sha256: None,
                        change_summary,
                        created_by: None,
                        provenance: None,
                    })
                    .await?;
                Ok(json!({ "task": task, "detail": detail }))
            }

            ValidatedTaskRpcParams::ArtifactVersionCompare {
                task_id,
                artifact_id,
                base_version_id,
                target_version_id,
            } => {
                let before = self
                    .task_coordinator
                    .read_artifact_version(&task_id, workspace_path, &artifact_id, &base_version_id)
                    .await?;
                let after = self
                    .task_coordinator
                    .read_artifact_version(
                        &task_id,
                        workspace_path,
                        &artifact_id,
                        &target_version_id,
                    )
                    .await?;
                let comparison = ArtifactComparisonService::compare(
                    &ArtifactBlobInput {
                        bytes: &before.bytes,
                        filename: &before.filename,
                        mime_type: Some(before.mime_type.as_str()),
                    },
                    &ArtifactBlobInput {
                        bytes: &after.bytes,
                        filename: &after.filename,
                        mime_type: Some(after.mime_type.as_str()),
                    },
                    None,
                );
                Ok(json!({ "comparison": comparison }))
            }

            ValidatedTaskRpcParams::ArtifactVersionPreview {
                task_id,
                artifact_id,
                version_id,
            } => {
                let source = self
                    .task_coordinator
                    .read_artifact_version(&task_id, workspace_path, &artifact_id, &version_id)
                    .await?;
                let preview = ArtifactPreviewService::preview(&ArtifactBlobInput {
                    bytes: &source.bytes,
                    filename: &source.filename,
                    mime_type: Some(source.mime_type.as_str()),
                });
                Ok(json!({
                    "versionId": version_id,
                    "preview": preview,
                }))
            }

            ValidatedTaskRpcParams::ArtifactVersionRestore {
                task_id,
                artifact_id,
                version_id,
                expected_revision,
                change_summary,
            } => {
                let detail = self.task_coordinator.get_artifact_detail(
                    &task_id,
                    workspace_path,
                    &artifact_id,
                )?;
                let expected_sha256 = detail
                    .and_then(|d| d.versions.last().map(|v| v.sha256.clone()))
                    .ok_or_else(|| {
                        TaskCoordinatorError::InvalidRequest(
                            "Artifact has no current version to restore over".to_owned(),
                        )
                    })?;
                let (task, next_detail, _ver) = self
                    .task_coordinator
                    .restore_artifact_version(RestoreArtifactVersionRequest {
                        task_id,
                        workspace_path: workspace_path.to_owned(),
                        artifact_id,
                        version_id,
                        expected_revision,
                        expected_sha256: Some(expected_sha256),
                        created_by: None,
                        change_summary,
                    })
                    .await?;
                Ok(json!({ "task": task, "detail": next_detail }))
            }

            ValidatedTaskRpcParams::ArtifactVersionAccept {
                task_id,
                artifact_id,
                version_id,
                expected_revision,
            } => {
                let (task, detail) = self
                    .task_coordinator
                    .accept_artifact_version(AcceptArtifactVersionRequest {
                        task_id,
                        workspace_path: workspace_path.to_owned(),
                        artifact_id,
                        version_id,
                        expected_revision,
                    })
                    .await?;
                Ok(json!({ "task": task, "detail": detail }))
            }

            ValidatedTaskRpcParams::ArtifactRevisionStart {
                task_id,
                artifact_id,
                base_version_id,
                expected_revision,
                instruction,
                title,
                provider,
                model,
            } => {
                let (task, detail, revision) = self
                    .task_coordinator
                    .start_artifact_revision(StartArtifactRevisionRequest {
                        task_id,
                        workspace_path: workspace_path.to_owned(),
                        artifact_id,
                        instruction: instruction.clone(),
                        base_version_id: Some(base_version_id),
                        expected_revision,
                        title,
                        provider,
                        model,
                    })
                    .await?;

                let Some(live_arc) = self.load_thread(&revision.session_id) else {
                    let _ = self
                        .task_coordinator
                        .handle_thread_outcome(&revision.session_id, "error", None)
                        .await;
                    return Err(TaskCoordinatorError::InvalidRequest(
                        "Artifact revision thread runtime is unavailable".to_owned(),
                    ));
                };
                let thread = self.build_thread_from_live(&live_arc.lock());
                let prompt = build_artifact_revision_prompt(&detail.artifact, &revision);
                let rt = Arc::clone(self);
                let rev_sid = revision.session_id.clone();
                let cid = conn.connection_id.clone();
                tokio::spawn(async move {
                    let res = rt
                        .handle_turn_start_with_display(
                            &cid,
                            false,
                            &TurnStartParams {
                                thread_id: rev_sid.clone(),
                                input: TurnInput::Text(prompt),
                                client_message_id: None,
                                references: None,
                                retry: None,
                            },
                            Some(instruction),
                        )
                        .await;
                    if let Err(err) = res {
                        let _ = rt
                            .task_coordinator
                            .handle_thread_outcome(&rev_sid, "error", Some(&err.message))
                            .await;
                    }
                });

                Ok(json!({
                    "task": task,
                    "detail": detail,
                    "revision": revision,
                    "thread": thread,
                }))
            }

            ValidatedTaskRpcParams::ThreadCreate {
                task_id,
                expected_revision,
                title,
                work_item_id,
                provider,
                model,
            } => {
                let before = self
                    .task_coordinator
                    .get(&task_id, Some(workspace_path))?
                    .ok_or_else(|| {
                        TaskCoordinatorError::InvalidRequest(format!("Unknown task: {task_id}"))
                    })?;
                let prior_sids: HashSet<String> = before
                    .threads
                    .iter()
                    .map(|t| t.session_id.clone())
                    .collect();
                let task = self
                    .task_coordinator
                    .add_thread(
                        &task_id,
                        &before.workspace_path,
                        &title,
                        expected_revision,
                        "user",
                        work_item_id.as_deref(),
                        provider.as_deref(),
                        model.as_deref(),
                    )
                    .await?;
                let created_thread = task
                    .threads
                    .iter()
                    .find(|t| !prior_sids.contains(&t.session_id))
                    .ok_or_else(|| {
                        TaskCoordinatorError::InvalidRequest(
                            "Task thread was not created".to_owned(),
                        )
                    })?;
                let live_arc = self
                    .load_thread(&created_thread.session_id)
                    .ok_or_else(|| {
                        TaskCoordinatorError::InvalidRequest(
                            "Task thread runtime is unavailable".to_owned(),
                        )
                    })?;
                let thread = self.build_thread_from_live(&live_arc.lock());
                Ok(json!({ "task": task, "thread": thread }))
            }

            ValidatedTaskRpcParams::ProposeCompletion {
                task_id,
                expected_revision,
                summary,
                caveats,
            } => {
                let task = self
                    .task_coordinator
                    .propose_completion(
                        &task_id,
                        workspace_path,
                        expected_revision,
                        &summary,
                        caveats.as_deref(),
                    )
                    .await?;
                Ok(json!({ "task": task }))
            }

            ValidatedTaskRpcParams::Cancel {
                task_id,
                expected_revision,
                reason,
            } => {
                let task = self
                    .task_coordinator
                    .transition(
                        &task_id,
                        workspace_path,
                        expected_revision,
                        TaskStatus::Cancelled,
                        "Task cancelled",
                        reason.as_deref(),
                        None,
                    )
                    .await?;
                Ok(json!({ "task": task }))
            }

            ValidatedTaskRpcParams::Accept {
                task_id,
                expected_revision,
            } => {
                let task = self
                    .task_coordinator
                    .accept_task(&task_id, workspace_path, expected_revision)
                    .await?;
                Ok(json!({ "task": task }))
            }

            ValidatedTaskRpcParams::RequestChanges {
                task_id,
                expected_revision,
                feedback,
            } => {
                let task = self
                    .task_coordinator
                    .request_changes(&task_id, workspace_path, expected_revision, &feedback)
                    .await?;
                Ok(json!({ "task": task }))
            }

            ValidatedTaskRpcParams::Reopen {
                task_id,
                expected_revision,
                reason,
            } => {
                let task = self
                    .task_coordinator
                    .reopen_task(
                        &task_id,
                        workspace_path,
                        expected_revision,
                        reason.as_deref(),
                    )
                    .await?;
                Ok(json!({ "task": task }))
            }

            ValidatedTaskRpcParams::Retry {
                task_id,
                expected_revision,
            } => {
                let (task, retry_status) = self
                    .task_coordinator
                    .retry_task(&task_id, workspace_path, expected_revision)
                    .await?;
                Ok(json!({
                    "task": task,
                    "retryStatus": retry_status.as_str(),
                }))
            }

            ValidatedTaskRpcParams::UnknownMethod => Err(TaskCoordinatorError::InvalidRequest(
                format!("Unknown method: {method}"),
            )),
        }
    }
}

fn map_task_coordinator_error(err: TaskCoordinatorError) -> JsonRpcLiteError {
    match err {
        TaskCoordinatorError::RevisionConflict { expected, current } => {
            JsonRpcLiteError::with_data(
                error_codes::INVALID_REQUEST,
                format!("Task revision conflict: expected {expected}, current {current}"),
                json!({
                    "category": "revision_conflict",
                    "expectedRevision": expected,
                    "currentRevision": current,
                }),
            )
        }
        TaskCoordinatorError::ArtifactConflict {
            ref artifact_id,
            ref expected_sha256,
            ref current_sha256,
        } => {
            let msg = err.to_string();
            let mut data = Map::new();
            data.insert(
                "category".to_owned(),
                Value::String("artifact_conflict".to_owned()),
            );
            if let Some(aid) = artifact_id {
                data.insert("artifactId".to_owned(), Value::String(aid.clone()));
            }
            data.insert(
                "expectedSha256".to_owned(),
                Value::String(expected_sha256.clone()),
            );
            data.insert(
                "currentSha256".to_owned(),
                current_sha256
                    .as_ref()
                    .map(|s| Value::String(s.clone()))
                    .unwrap_or(Value::Null),
            );
            JsonRpcLiteError::with_data(error_codes::INVALID_REQUEST, msg, Value::Object(data))
        }
        TaskCoordinatorError::TaskLocked(lock) => JsonRpcLiteError::with_data(
            error_codes::INVALID_REQUEST,
            lock.message,
            lock.data.to_json_value(),
        ),
        other => JsonRpcLiteError::new(error_codes::INVALID_REQUEST, other.to_string()),
    }
}

// ============================================================================
// Strict Request Schema Parsing (`jsonRpcTaskRequestSchemas` parity)
// ============================================================================

enum ValidatedTaskRpcParams {
    Create {
        provider: Option<String>,
        model: Option<String>,
        creation: ValidatedTaskCreationInput,
    },
    List,
    Read {
        task_id: String,
    },
    UpdateBrief {
        task_id: String,
        expected_revision: i64,
        title: Option<String>,
        objective: Option<String>,
        requirements: Option<Vec<BriefRequirementInput>>,
    },
    UpdateGraph {
        task_id: String,
        expected_revision: i64,
        work_items: Vec<ReplacementWorkItemInput>,
    },
    WorkItemClaim {
        task_id: String,
        expected_revision: i64,
        work_item_id: String,
        task_thread_id: String,
    },
    WorkItemMark {
        task_id: String,
        expected_revision: i64,
        work_item_id: String,
        status: WorkItemStatus,
        completion_evidence: Option<String>,
    },
    DecisionRecord {
        task_id: String,
        expected_revision: i64,
        question: String,
        resolution: String,
        source: String,
        scope: Option<String>,
        confidence: Option<f64>,
        supersedes: Option<String>,
    },
    QuestionsResolve {
        task_id: String,
        expected_revision: i64,
        answers: Vec<TaskQuestionAnswerInput>,
    },
    BlockerReport {
        task_id: String,
        expected_revision: i64,
        description: String,
        blocking: bool,
        work_item_id: Option<String>,
    },
    BlockerResolve {
        task_id: String,
        expected_revision: i64,
        blocker_id: String,
    },
    ArtifactRegister {
        task_id: String,
        expected_revision: i64,
        path: String,
        title: String,
        kind: String,
        artifact_id: Option<String>,
        base_version_id: Option<String>,
        change_summary: Option<String>,
        work_item_id: Option<String>,
        provenance: Option<Map<String, Value>>,
    },
    ArtifactRead {
        task_id: String,
        artifact_id: String,
    },
    ArtifactVersionCapture {
        task_id: String,
        artifact_id: String,
        expected_revision: i64,
        change_summary: Option<String>,
    },
    ArtifactVersionCompare {
        task_id: String,
        artifact_id: String,
        base_version_id: String,
        target_version_id: String,
    },
    ArtifactVersionPreview {
        task_id: String,
        artifact_id: String,
        version_id: String,
    },
    ArtifactVersionRestore {
        task_id: String,
        artifact_id: String,
        version_id: String,
        expected_revision: i64,
        change_summary: Option<String>,
    },
    ArtifactVersionAccept {
        task_id: String,
        artifact_id: String,
        version_id: Option<String>,
        expected_revision: i64,
    },
    ArtifactRevisionStart {
        task_id: String,
        artifact_id: String,
        base_version_id: String,
        expected_revision: i64,
        instruction: String,
        title: Option<String>,
        provider: Option<String>,
        model: Option<String>,
    },
    ThreadCreate {
        task_id: String,
        expected_revision: i64,
        title: String,
        work_item_id: Option<String>,
        provider: Option<String>,
        model: Option<String>,
    },
    ProposeCompletion {
        task_id: String,
        expected_revision: i64,
        summary: String,
        caveats: Option<Vec<String>>,
    },
    Cancel {
        task_id: String,
        expected_revision: i64,
        reason: Option<String>,
    },
    Accept {
        task_id: String,
        expected_revision: i64,
    },
    RequestChanges {
        task_id: String,
        expected_revision: i64,
        feedback: String,
    },
    Reopen {
        task_id: String,
        expected_revision: i64,
        reason: Option<String>,
    },
    Retry {
        task_id: String,
        expected_revision: i64,
    },
    UnknownMethod,
}

fn invalid_params(method: &str, msg: impl Into<String>) -> JsonRpcLiteError {
    let m = msg.into();
    if m.is_empty() {
        JsonRpcLiteError::new(
            error_codes::INVALID_PARAMS,
            format!("Invalid {method} params"),
        )
    } else {
        JsonRpcLiteError::new(error_codes::INVALID_PARAMS, m)
    }
}

fn parse_task_params_obj(
    method: &str,
    raw: Option<&Value>,
) -> Result<Map<String, Value>, JsonRpcLiteError> {
    match raw {
        None | Some(Value::Null) => Ok(Map::new()),
        Some(Value::Object(m)) => Ok(m.clone()),
        Some(_) => Err(invalid_params(method, format!("Invalid {method} params"))),
    }
}

fn check_strict_keys(
    method: &str,
    map: &Map<String, Value>,
    allowed: &[&str],
) -> Result<(), JsonRpcLiteError> {
    for k in map.keys() {
        if !allowed.contains(&k.as_str()) {
            return Err(invalid_params(
                method,
                format!("Unrecognized key in {method}: \"{k}\""),
            ));
        }
    }
    Ok(())
}

fn req_non_empty_str(
    method: &str,
    map: &Map<String, Value>,
    key: &str,
) -> Result<String, JsonRpcLiteError> {
    let Some(val) = map.get(key) else {
        return Err(invalid_params(method, format!("{key} is required")));
    };
    let Some(s) = val.as_str() else {
        return Err(invalid_params(method, format!("{key} must be a string")));
    };
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return Err(invalid_params(method, format!("{key} must be non-empty")));
    }
    Ok(trimmed.to_owned())
}

fn opt_non_empty_str(
    method: &str,
    map: &Map<String, Value>,
    key: &str,
) -> Result<Option<String>, JsonRpcLiteError> {
    let Some(val) = map.get(key) else {
        return Ok(None);
    };
    let Some(s) = val.as_str() else {
        return Err(invalid_params(method, format!("{key} must be a string")));
    };
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return Err(invalid_params(method, format!("{key} must be non-empty")));
    }
    Ok(Some(trimmed.to_owned()))
}

fn validate_optional_cwd(
    method: &str,
    map: &Map<String, Value>,
) -> Result<Option<String>, JsonRpcLiteError> {
    opt_non_empty_str(method, map, "cwd")
}

fn req_expected_revision(method: &str, map: &Map<String, Value>) -> Result<i64, JsonRpcLiteError> {
    let Some(val) = map.get("expectedRevision") else {
        return Err(invalid_params(method, "expectedRevision is required"));
    };
    if let Some(n) = val.as_i64()
        && n >= 0
    {
        return Ok(n);
    }
    if let Some(u) = val.as_u64()
        && let Ok(n) = i64::try_from(u)
    {
        return Ok(n);
    }
    Err(invalid_params(
        method,
        "expectedRevision must be a non-negative integer",
    ))
}

fn req_bool(method: &str, map: &Map<String, Value>, key: &str) -> Result<bool, JsonRpcLiteError> {
    map.get(key)
        .and_then(Value::as_bool)
        .ok_or_else(|| invalid_params(method, format!("{key} must be a boolean")))
}

fn opt_string_vec(
    method: &str,
    map: &Map<String, Value>,
    key: &str,
) -> Result<Option<Vec<String>>, JsonRpcLiteError> {
    let Some(val) = map.get(key) else {
        return Ok(None);
    };
    let Some(arr) = val.as_array() else {
        return Err(invalid_params(method, format!("{key} must be an array")));
    };
    let mut out = Vec::with_capacity(arr.len());
    for item in arr {
        let Some(s) = item.as_str() else {
            return Err(invalid_params(
                method,
                format!("{key} entries must be non-empty strings"),
            ));
        };
        let t = s.trim();
        if t.is_empty() {
            return Err(invalid_params(
                method,
                format!("{key} entries must be non-empty strings"),
            ));
        }
        out.push(t.to_owned());
    }
    Ok(Some(out))
}

fn parse_work_item_status(method: &str, raw: &str) -> Result<WorkItemStatus, JsonRpcLiteError> {
    serde_json::from_value::<WorkItemStatus>(Value::String(raw.to_owned()))
        .map_err(|_| invalid_params(method, format!("Invalid work item status: {raw}")))
}

fn parse_and_validate_task_method_params(
    method: &str,
    map: &Map<String, Value>,
) -> Result<ValidatedTaskRpcParams, JsonRpcLiteError> {
    match method {
        "task/create" => {
            check_strict_keys(
                method,
                map,
                &[
                    "cwd",
                    "provider",
                    "model",
                    "idempotencyKey",
                    "title",
                    "objective",
                    "context",
                    "reviewRequired",
                    "reviewRounds",
                    "requirements",
                    "workItems",
                    "decisions",
                    "questions",
                ],
            )?;
            let provider = opt_non_empty_str(method, map, "provider")?;
            let model = opt_non_empty_str(method, map, "model")?;
            let mut raw_creation = map.clone();
            raw_creation.remove("cwd");
            raw_creation.remove("provider");
            raw_creation.remove("model");
            let creation =
                parse_and_validate_task_creation_input(&Value::Object(raw_creation), false)
                    .map_err(|e| invalid_params(method, e.to_string()))?;
            Ok(ValidatedTaskRpcParams::Create {
                provider,
                model,
                creation,
            })
        }

        "task/list" => {
            check_strict_keys(method, map, &["cwd"])?;
            Ok(ValidatedTaskRpcParams::List)
        }

        "task/read" => {
            check_strict_keys(method, map, &["cwd", "taskId"])?;
            let task_id = req_non_empty_str(method, map, "taskId")?;
            Ok(ValidatedTaskRpcParams::Read { task_id })
        }

        "task/updateBrief" => {
            check_strict_keys(
                method,
                map,
                &[
                    "cwd",
                    "taskId",
                    "expectedRevision",
                    "title",
                    "objective",
                    "requirements",
                ],
            )?;
            let task_id = req_non_empty_str(method, map, "taskId")?;
            let expected_revision = req_expected_revision(method, map)?;
            let title = opt_non_empty_str(method, map, "title")?;
            let objective = opt_non_empty_str(method, map, "objective")?;
            let requirements = match map.get("requirements") {
                None => None,
                Some(v) => {
                    let arr = v
                        .as_array()
                        .ok_or_else(|| invalid_params(method, "requirements must be an array"))?;
                    let mut parsed_reqs = Vec::with_capacity(arr.len());
                    for item in arr {
                        let obj = item.as_object().ok_or_else(|| {
                            invalid_params(method, "requirement must be an object")
                        })?;
                        check_strict_keys(method, obj, &["kind", "text", "permanence", "source"])?;
                        let kind_str = req_non_empty_str(method, obj, "kind")?;
                        let kind = serde_json::from_value::<TaskRequirementKind>(Value::String(
                            kind_str.clone(),
                        ))
                        .map_err(|_| {
                            invalid_params(method, format!("Invalid requirement kind: {kind_str}"))
                        })?;
                        let text = req_non_empty_str(method, obj, "text")?;
                        let permanence = match opt_non_empty_str(method, obj, "permanence")? {
                            None => None,
                            Some(p) => {
                                if !matches!(p.as_str(), "fixed" | "temporary") {
                                    return Err(invalid_params(
                                        method,
                                        "Invalid requirement permanence",
                                    ));
                                }
                                Some(p)
                            }
                        };
                        let source = opt_non_empty_str(method, obj, "source")?;
                        if let Some(ref s) = source
                            && !matches!(s.as_str(), "user" | "agent" | "policy")
                        {
                            return Err(invalid_params(method, "Invalid requirement source"));
                        }
                        parsed_reqs.push(BriefRequirementInput {
                            kind,
                            text,
                            permanence,
                            source,
                        });
                    }
                    Some(parsed_reqs)
                }
            };
            if title.is_none() && objective.is_none() && requirements.is_none() {
                return Err(invalid_params(
                    method,
                    "At least one brief field is required",
                ));
            }
            Ok(ValidatedTaskRpcParams::UpdateBrief {
                task_id,
                expected_revision,
                title,
                objective,
                requirements,
            })
        }

        "task/updateGraph" => {
            check_strict_keys(
                method,
                map,
                &["cwd", "taskId", "expectedRevision", "workItems"],
            )?;
            let task_id = req_non_empty_str(method, map, "taskId")?;
            let expected_revision = req_expected_revision(method, map)?;
            let arr = map
                .get("workItems")
                .and_then(Value::as_array)
                .ok_or_else(|| invalid_params(method, "workItems must be an array"))?;
            let mut work_items = Vec::with_capacity(arr.len());
            for item in arr {
                let obj = item
                    .as_object()
                    .ok_or_else(|| invalid_params(method, "workItem must be an object"))?;
                check_strict_keys(
                    method,
                    obj,
                    &[
                        "id",
                        "title",
                        "description",
                        "status",
                        "dependsOn",
                        "expectedOutputs",
                    ],
                )?;
                let id = opt_non_empty_str(method, obj, "id")?;
                let title = req_non_empty_str(method, obj, "title")?;
                let description = match obj.get("description") {
                    None => None,
                    Some(v) => Some(
                        v.as_str()
                            .ok_or_else(|| invalid_params(method, "description must be a string"))?
                            .to_owned(),
                    ),
                };
                let status = match opt_non_empty_str(method, obj, "status")? {
                    None => None,
                    Some(s) => Some(parse_work_item_status(method, &s)?),
                };
                let depends_on = opt_string_vec(method, obj, "dependsOn")?;
                let expected_outputs = opt_string_vec(method, obj, "expectedOutputs")?;
                work_items.push(ReplacementWorkItemInput {
                    id,
                    title,
                    description,
                    status,
                    depends_on,
                    expected_outputs,
                });
            }
            Ok(ValidatedTaskRpcParams::UpdateGraph {
                task_id,
                expected_revision,
                work_items,
            })
        }

        "task/workItem/claim" => {
            check_strict_keys(
                method,
                map,
                &[
                    "cwd",
                    "taskId",
                    "expectedRevision",
                    "workItemId",
                    "taskThreadId",
                ],
            )?;
            let task_id = req_non_empty_str(method, map, "taskId")?;
            let expected_revision = req_expected_revision(method, map)?;
            let work_item_id = req_non_empty_str(method, map, "workItemId")?;
            let task_thread_id = req_non_empty_str(method, map, "taskThreadId")?;
            Ok(ValidatedTaskRpcParams::WorkItemClaim {
                task_id,
                expected_revision,
                work_item_id,
                task_thread_id,
            })
        }

        "task/workItem/mark" => {
            check_strict_keys(
                method,
                map,
                &[
                    "cwd",
                    "taskId",
                    "expectedRevision",
                    "workItemId",
                    "status",
                    "completionEvidence",
                ],
            )?;
            let task_id = req_non_empty_str(method, map, "taskId")?;
            let expected_revision = req_expected_revision(method, map)?;
            let work_item_id = req_non_empty_str(method, map, "workItemId")?;
            let status_raw = req_non_empty_str(method, map, "status")?;
            let status = parse_work_item_status(method, &status_raw)?;
            let completion_evidence = opt_non_empty_str(method, map, "completionEvidence")?;
            Ok(ValidatedTaskRpcParams::WorkItemMark {
                task_id,
                expected_revision,
                work_item_id,
                status,
                completion_evidence,
            })
        }

        "task/decision/record" => {
            check_strict_keys(
                method,
                map,
                &[
                    "cwd",
                    "taskId",
                    "expectedRevision",
                    "question",
                    "resolution",
                    "source",
                    "scope",
                    "confidence",
                    "supersedes",
                ],
            )?;
            let task_id = req_non_empty_str(method, map, "taskId")?;
            let expected_revision = req_expected_revision(method, map)?;
            let question = req_non_empty_str(method, map, "question")?;
            let resolution = req_non_empty_str(method, map, "resolution")?;
            let source =
                opt_non_empty_str(method, map, "source")?.unwrap_or_else(|| "user".to_owned());
            if !matches!(source.as_str(), "user" | "agent" | "policy") {
                return Err(invalid_params(method, "Invalid decision source"));
            }
            let scope = opt_non_empty_str(method, map, "scope")?;
            if let Some(ref sc) = scope
                && !matches!(sc.as_str(), "task" | "project")
            {
                return Err(invalid_params(method, "Invalid decision scope"));
            }
            let confidence = match map.get("confidence") {
                None => None,
                Some(v) => {
                    let c = v.as_f64().ok_or_else(|| {
                        invalid_params(method, "confidence must be a number between 0 and 1")
                    })?;
                    if !(0.0..=1.0).contains(&c) {
                        return Err(invalid_params(method, "confidence must be between 0 and 1"));
                    }
                    Some(c)
                }
            };
            let supersedes = opt_non_empty_str(method, map, "supersedes")?;
            Ok(ValidatedTaskRpcParams::DecisionRecord {
                task_id,
                expected_revision,
                question,
                resolution,
                source,
                scope,
                confidence,
                supersedes,
            })
        }

        "task/questions/resolve" => {
            check_strict_keys(
                method,
                map,
                &["cwd", "taskId", "expectedRevision", "answers"],
            )?;
            let task_id = req_non_empty_str(method, map, "taskId")?;
            let expected_revision = req_expected_revision(method, map)?;
            let arr = map
                .get("answers")
                .and_then(Value::as_array)
                .ok_or_else(|| invalid_params(method, "answers must be an array"))?;
            if arr.is_empty() || arr.len() > 3 {
                return Err(invalid_params(
                    method,
                    "answers must contain between 1 and 3 entries",
                ));
            }
            let mut answers = Vec::with_capacity(arr.len());
            for item in arr {
                let obj = item
                    .as_object()
                    .ok_or_else(|| invalid_params(method, "answer must be an object"))?;
                check_strict_keys(method, obj, &["questionId", "optionId", "text"])?;
                let question_id = req_non_empty_str(method, obj, "questionId")?;
                let option_id = opt_non_empty_str(method, obj, "optionId")?;
                let text = opt_non_empty_str(method, obj, "text")?;
                if option_id.is_some() == text.is_some() {
                    return Err(invalid_params(
                        method,
                        "Provide exactly one of optionId or text",
                    ));
                }
                answers.push(TaskQuestionAnswerInput {
                    question_id,
                    option_id,
                    text,
                });
            }
            Ok(ValidatedTaskRpcParams::QuestionsResolve {
                task_id,
                expected_revision,
                answers,
            })
        }

        "task/blocker/report" => {
            check_strict_keys(
                method,
                map,
                &[
                    "cwd",
                    "taskId",
                    "expectedRevision",
                    "description",
                    "blocking",
                    "workItemId",
                ],
            )?;
            let task_id = req_non_empty_str(method, map, "taskId")?;
            let expected_revision = req_expected_revision(method, map)?;
            let description = req_non_empty_str(method, map, "description")?;
            let blocking = req_bool(method, map, "blocking")?;
            let work_item_id = opt_non_empty_str(method, map, "workItemId")?;
            Ok(ValidatedTaskRpcParams::BlockerReport {
                task_id,
                expected_revision,
                description,
                blocking,
                work_item_id,
            })
        }

        "task/blocker/resolve" => {
            check_strict_keys(
                method,
                map,
                &["cwd", "taskId", "expectedRevision", "blockerId"],
            )?;
            let task_id = req_non_empty_str(method, map, "taskId")?;
            let expected_revision = req_expected_revision(method, map)?;
            let blocker_id = req_non_empty_str(method, map, "blockerId")?;
            Ok(ValidatedTaskRpcParams::BlockerResolve {
                task_id,
                expected_revision,
                blocker_id,
            })
        }

        "task/artifact/register" => {
            check_strict_keys(
                method,
                map,
                &[
                    "cwd",
                    "taskId",
                    "expectedRevision",
                    "path",
                    "title",
                    "kind",
                    "artifactId",
                    "baseVersionId",
                    "changeSummary",
                    "workItemId",
                    "provenance",
                ],
            )?;
            let task_id = req_non_empty_str(method, map, "taskId")?;
            let expected_revision = req_expected_revision(method, map)?;
            let path = req_non_empty_str(method, map, "path")?;
            let title = req_non_empty_str(method, map, "title")?;
            let kind = req_non_empty_str(method, map, "kind")?;
            let artifact_id = opt_non_empty_str(method, map, "artifactId")?;
            let base_version_id = opt_non_empty_str(method, map, "baseVersionId")?;
            let change_summary = opt_non_empty_str(method, map, "changeSummary")?;
            let work_item_id = opt_non_empty_str(method, map, "workItemId")?;
            let provenance = match map.get("provenance") {
                None => None,
                Some(v) => Some(
                    v.as_object()
                        .ok_or_else(|| invalid_params(method, "provenance must be an object"))?
                        .clone(),
                ),
            };
            Ok(ValidatedTaskRpcParams::ArtifactRegister {
                task_id,
                expected_revision,
                path,
                title,
                kind,
                artifact_id,
                base_version_id,
                change_summary,
                work_item_id,
                provenance,
            })
        }

        "task/artifact/read" => {
            check_strict_keys(method, map, &["cwd", "taskId", "artifactId"])?;
            let task_id = req_non_empty_str(method, map, "taskId")?;
            let artifact_id = req_non_empty_str(method, map, "artifactId")?;
            Ok(ValidatedTaskRpcParams::ArtifactRead {
                task_id,
                artifact_id,
            })
        }

        "task/artifact/version/capture" => {
            check_strict_keys(
                method,
                map,
                &[
                    "cwd",
                    "taskId",
                    "artifactId",
                    "expectedRevision",
                    "changeSummary",
                ],
            )?;
            let task_id = req_non_empty_str(method, map, "taskId")?;
            let artifact_id = req_non_empty_str(method, map, "artifactId")?;
            let expected_revision = req_expected_revision(method, map)?;
            let change_summary = opt_non_empty_str(method, map, "changeSummary")?;
            Ok(ValidatedTaskRpcParams::ArtifactVersionCapture {
                task_id,
                artifact_id,
                expected_revision,
                change_summary,
            })
        }

        "task/artifact/version/compare" => {
            check_strict_keys(
                method,
                map,
                &[
                    "cwd",
                    "taskId",
                    "artifactId",
                    "baseVersionId",
                    "targetVersionId",
                ],
            )?;
            let task_id = req_non_empty_str(method, map, "taskId")?;
            let artifact_id = req_non_empty_str(method, map, "artifactId")?;
            let base_version_id = req_non_empty_str(method, map, "baseVersionId")?;
            let target_version_id = req_non_empty_str(method, map, "targetVersionId")?;
            Ok(ValidatedTaskRpcParams::ArtifactVersionCompare {
                task_id,
                artifact_id,
                base_version_id,
                target_version_id,
            })
        }

        "task/artifact/version/preview" => {
            check_strict_keys(method, map, &["cwd", "taskId", "artifactId", "versionId"])?;
            let task_id = req_non_empty_str(method, map, "taskId")?;
            let artifact_id = req_non_empty_str(method, map, "artifactId")?;
            let version_id = req_non_empty_str(method, map, "versionId")?;
            Ok(ValidatedTaskRpcParams::ArtifactVersionPreview {
                task_id,
                artifact_id,
                version_id,
            })
        }

        "task/artifact/version/restore" => {
            check_strict_keys(
                method,
                map,
                &[
                    "cwd",
                    "taskId",
                    "artifactId",
                    "versionId",
                    "expectedRevision",
                    "changeSummary",
                ],
            )?;
            let task_id = req_non_empty_str(method, map, "taskId")?;
            let artifact_id = req_non_empty_str(method, map, "artifactId")?;
            let version_id = req_non_empty_str(method, map, "versionId")?;
            let expected_revision = req_expected_revision(method, map)?;
            let change_summary = opt_non_empty_str(method, map, "changeSummary")?;
            Ok(ValidatedTaskRpcParams::ArtifactVersionRestore {
                task_id,
                artifact_id,
                version_id,
                expected_revision,
                change_summary,
            })
        }

        "task/artifact/version/accept" => {
            check_strict_keys(
                method,
                map,
                &[
                    "cwd",
                    "taskId",
                    "artifactId",
                    "versionId",
                    "expectedRevision",
                ],
            )?;
            let task_id = req_non_empty_str(method, map, "taskId")?;
            let artifact_id = req_non_empty_str(method, map, "artifactId")?;
            let version_id = opt_non_empty_str(method, map, "versionId")?;
            let expected_revision = req_expected_revision(method, map)?;
            Ok(ValidatedTaskRpcParams::ArtifactVersionAccept {
                task_id,
                artifact_id,
                version_id,
                expected_revision,
            })
        }

        "task/artifact/revision/start" => {
            check_strict_keys(
                method,
                map,
                &[
                    "cwd",
                    "taskId",
                    "artifactId",
                    "baseVersionId",
                    "expectedRevision",
                    "instruction",
                    "title",
                    "provider",
                    "model",
                ],
            )?;
            let task_id = req_non_empty_str(method, map, "taskId")?;
            let artifact_id = req_non_empty_str(method, map, "artifactId")?;
            let base_version_id = req_non_empty_str(method, map, "baseVersionId")?;
            let expected_revision = req_expected_revision(method, map)?;
            let instruction = req_non_empty_str(method, map, "instruction")?;
            let title = opt_non_empty_str(method, map, "title")?;
            let provider = opt_non_empty_str(method, map, "provider")?;
            let model = opt_non_empty_str(method, map, "model")?;
            Ok(ValidatedTaskRpcParams::ArtifactRevisionStart {
                task_id,
                artifact_id,
                base_version_id,
                expected_revision,
                instruction,
                title,
                provider,
                model,
            })
        }

        "task/thread/create" => {
            check_strict_keys(
                method,
                map,
                &[
                    "cwd",
                    "taskId",
                    "expectedRevision",
                    "title",
                    "workItemId",
                    "provider",
                    "model",
                ],
            )?;
            let task_id = req_non_empty_str(method, map, "taskId")?;
            let expected_revision = req_expected_revision(method, map)?;
            let title = req_non_empty_str(method, map, "title")?;
            let work_item_id = opt_non_empty_str(method, map, "workItemId")?;
            let provider = opt_non_empty_str(method, map, "provider")?;
            let model = opt_non_empty_str(method, map, "model")?;
            Ok(ValidatedTaskRpcParams::ThreadCreate {
                task_id,
                expected_revision,
                title,
                work_item_id,
                provider,
                model,
            })
        }

        "task/proposeCompletion" => {
            check_strict_keys(
                method,
                map,
                &["cwd", "taskId", "expectedRevision", "summary", "caveats"],
            )?;
            let task_id = req_non_empty_str(method, map, "taskId")?;
            let expected_revision = req_expected_revision(method, map)?;
            let summary = req_non_empty_str(method, map, "summary")?;
            let caveats = opt_string_vec(method, map, "caveats")?;
            Ok(ValidatedTaskRpcParams::ProposeCompletion {
                task_id,
                expected_revision,
                summary,
                caveats,
            })
        }

        "task/cancel" => {
            check_strict_keys(
                method,
                map,
                &["cwd", "taskId", "expectedRevision", "reason"],
            )?;
            let task_id = req_non_empty_str(method, map, "taskId")?;
            let expected_revision = req_expected_revision(method, map)?;
            let reason = opt_non_empty_str(method, map, "reason")?;
            Ok(ValidatedTaskRpcParams::Cancel {
                task_id,
                expected_revision,
                reason,
            })
        }

        "task/accept" => {
            check_strict_keys(method, map, &["cwd", "taskId", "expectedRevision"])?;
            let task_id = req_non_empty_str(method, map, "taskId")?;
            let expected_revision = req_expected_revision(method, map)?;
            Ok(ValidatedTaskRpcParams::Accept {
                task_id,
                expected_revision,
            })
        }

        "task/requestChanges" => {
            check_strict_keys(
                method,
                map,
                &["cwd", "taskId", "expectedRevision", "feedback"],
            )?;
            let task_id = req_non_empty_str(method, map, "taskId")?;
            let expected_revision = req_expected_revision(method, map)?;
            let feedback = req_non_empty_str(method, map, "feedback")?;
            Ok(ValidatedTaskRpcParams::RequestChanges {
                task_id,
                expected_revision,
                feedback,
            })
        }

        "task/reopen" => {
            check_strict_keys(
                method,
                map,
                &["cwd", "taskId", "expectedRevision", "reason"],
            )?;
            let task_id = req_non_empty_str(method, map, "taskId")?;
            let expected_revision = req_expected_revision(method, map)?;
            let reason = opt_non_empty_str(method, map, "reason")?;
            Ok(ValidatedTaskRpcParams::Reopen {
                task_id,
                expected_revision,
                reason,
            })
        }

        "task/retry" => {
            check_strict_keys(method, map, &["cwd", "taskId", "expectedRevision"])?;
            let task_id = req_non_empty_str(method, map, "taskId")?;
            let expected_revision = req_expected_revision(method, map)?;
            Ok(ValidatedTaskRpcParams::Retry {
                task_id,
                expected_revision,
            })
        }

        _ => Ok(ValidatedTaskRpcParams::UnknownMethod),
    }
}
