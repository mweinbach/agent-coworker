//! `TaskCoordinator` and `TaskArtifacts` — durable task lifecycle orchestration,
//! per-task async serialization, DAG work-item claims, blocking question auto-resume,
//! content-addressed artifact versioning & live-file conflict detection, minimum-round
//! independent reviewer verification, and terminal `quiesceTaskThreads`.
//!
//! Mirrors `src/server/tasks/TaskCoordinator.ts` and `src/server/tasks/TaskArtifacts.ts`.

use std::collections::{BTreeMap, BTreeSet};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Weak};

use async_trait::async_trait;
use cowork_storage::{
    AgentExecutionState, ArtifactVersionStore, ArtifactVersionStoreOptions, CreateTaskRecordInput,
    MAX_TASK_REVIEW_ROUNDS, QueueTaskQuestionsInput, ResolveTaskQuestionsInput,
    RestoreArtifactFileInput, SessionDb, SetTaskStatusInput, StartTaskArtifactRevisionInput,
    StorageError, StoredArtifactBlob, TaskActivity, TaskActivityKind, TaskArtifact,
    TaskArtifactDetail, TaskArtifactRevision, TaskArtifactRevisionStatus, TaskArtifactVersion,
    TaskArtifactVersionReviewStatus, TaskBlocker, TaskCheckpoint, TaskCheckpointArtifactEntry,
    TaskContextSnapshot, TaskCreationOrigin, TaskCreationResult, TaskDecision, TaskDirective,
    TaskDirectiveCommitHooks, TaskDirectiveCommitPayload, TaskDirectiveContinuation,
    TaskDirectiveQuestionInput, TaskDirectiveRequirementInput, TaskDirectiveResult, TaskQuestion,
    TaskQuestionOption, TaskQuestionResolutionRecordInput, TaskQuestionStatus, TaskQuestionUrgency,
    TaskRecord, TaskRequirement, TaskRequirementKind, TaskReviewArtifactFileSnapshot,
    TaskReviewMaterialReference, TaskReviewRecord, TaskReviewVerdict, TaskStatus, TaskSummary,
    TaskThread, TaskWorkItemRecordInput, UpdateTaskPlanInput, ValidatedTaskCreationInput, WorkItem,
    WorkItemStatus, build_task_review_material_snapshot, fingerprint_task_review_material,
    get_pending_task_review, get_task_review_rounds_from_records, stable_stringify,
};
use dashmap::DashMap;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use uuid::Uuid;

use super::locks::{
    PendingTerminalLockGuard, get_pending_terminal_task_lock, is_terminal_task_status,
    register_pending_terminal_task_locks,
};
use super::policy::{
    TaskCoordinatorError, TaskReviewMaterial, assert_expected_task_revision,
    assert_no_conflicting_work_item_owner, assert_no_incomplete_dependency_removal,
    assert_task_accepts_mutation, assert_task_accepts_new_threads, assert_task_thread_member,
    assert_thread_can_claim_work_item, assert_thread_can_mark_work_item,
    assert_thread_can_mutate_work_item, assert_work_item_dependencies_complete, assert_workspace,
    build_task_question_continuation_prompt, build_task_retry_prompt, canonicalize_workspace_str,
    is_terminal_task, is_terminal_task_mutation_error, is_terminal_work_item_status,
    is_valid_task_transition, live_artifact_evidence, make_activity, make_requirement,
    media_type_for_artifact, non_empty, now_iso, replacement_changes_work_item,
    same_workspace_path, task_snapshot, validate_work_graph,
};

tokio::task_local! {
    static PENDING_TERMINAL_MUTATION_BYPASS: BTreeSet<String>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskQuestionResumeStatus {
    Queued,
    Steered,
    NotNeeded,
    Failed,
}

impl TaskQuestionResumeStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Steered => "steered",
            Self::NotNeeded => "not_needed",
            Self::Failed => "failed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskQuestionAnswerInput {
    pub question_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub option_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

#[derive(Debug, Clone)]
pub struct TaskNotification {
    pub method: &'static str,
    pub params: Value,
}

pub type TaskNotificationSink = Arc<dyn Fn(TaskNotification) + Send + Sync>;

#[derive(Debug, Clone)]
pub struct TaskThreadFactoryInput {
    pub task: TaskRecord,
    pub title: String,
    pub work_item_id: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
}

#[async_trait]
pub trait TaskThreadFactory: Send + Sync {
    async fn create_task_thread(&self, input: TaskThreadFactoryInput) -> Result<String, String>;
}

#[async_trait]
pub trait TaskContinuationDispatcher: Send + Sync {
    async fn dispatch_continuation(
        &self,
        session_id: String,
        prompt: String,
        display_text: String,
    ) -> Result<TaskQuestionResumeStatus, String>;
}

#[async_trait]
pub trait TaskThreadQuiescer: Send + Sync {
    async fn quiesce_task_threads(
        &self,
        task: TaskRecord,
        reason: TaskStatus,
        origin_session_id: Option<String>,
    ) -> Result<(), String>;
}

#[derive(Debug, Clone)]
pub struct ReplacementWorkItemInput {
    pub id: Option<String>,
    pub title: String,
    pub description: Option<String>,
    pub status: Option<WorkItemStatus>,
    pub depends_on: Option<Vec<String>>,
    pub expected_outputs: Option<Vec<String>>,
}

#[derive(Debug, Clone)]
pub struct UpdateBriefRequest {
    pub task_id: String,
    pub workspace_path: String,
    pub expected_revision: i64,
    pub title: Option<String>,
    pub objective: Option<String>,
    pub requirements: Option<Vec<BriefRequirementInput>>,
}

#[derive(Debug, Clone)]
pub struct BriefRequirementInput {
    pub kind: TaskRequirementKind,
    pub text: String,
    pub permanence: Option<String>,
    pub source: Option<String>,
}

#[derive(Debug, Clone)]
pub struct RegisterArtifactRequest {
    pub task_id: String,
    pub workspace_path: String,
    pub expected_revision: i64,
    pub session_id: Option<String>,
    pub path: String,
    pub title: String,
    pub kind: String,
    pub artifact_id: Option<String>,
    pub base_version_id: Option<String>,
    pub change_summary: Option<String>,
    pub work_item_id: Option<String>,
    pub provenance: Option<Map<String, Value>>,
}

#[derive(Debug, Clone)]
pub struct CaptureArtifactVersionRequest {
    pub task_id: String,
    pub workspace_path: String,
    pub artifact_id: String,
    pub expected_revision: i64,
    pub expected_sha256: Option<String>,
    pub change_summary: Option<String>,
    pub created_by: Option<String>,
    pub provenance: Option<Map<String, Value>>,
}

#[derive(Debug, Clone)]
pub struct RestoreArtifactVersionRequest {
    pub task_id: String,
    pub workspace_path: String,
    pub artifact_id: String,
    pub version_id: String,
    pub expected_revision: i64,
    pub expected_sha256: Option<String>,
    pub created_by: Option<String>,
    pub change_summary: Option<String>,
}

#[derive(Debug, Clone)]
pub struct AcceptArtifactVersionRequest {
    pub task_id: String,
    pub workspace_path: String,
    pub artifact_id: String,
    pub version_id: Option<String>,
    pub expected_revision: i64,
}

#[derive(Debug, Clone)]
pub struct StartArtifactRevisionRequest {
    pub task_id: String,
    pub workspace_path: String,
    pub artifact_id: String,
    pub expected_revision: i64,
    pub instruction: String,
    pub base_version_id: Option<String>,
    pub title: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
}

#[derive(Debug, Clone)]
pub struct RevisionOutcomeResult {
    pub task: TaskRecord,
    pub detail: TaskArtifactDetail,
    pub revision: TaskArtifactRevision,
}

#[derive(Debug, Clone)]
pub struct ReadArtifactVersionOutput {
    pub bytes: Vec<u8>,
    pub filename: String,
    pub mime_type: String,
    pub version: TaskArtifactVersion,
}

pub struct TaskCoordinatorOptions {
    pub session_db: Arc<SessionDb>,
    pub notify: Option<TaskNotificationSink>,
    pub artifact_store: Option<Arc<ArtifactVersionStore>>,
    pub quiesce_task_threads: Option<Arc<dyn TaskThreadQuiescer>>,
}

static NEXT_CONTINUATION_ATTEMPT: AtomicU64 = AtomicU64::new(1);

pub struct TaskCoordinator {
    self_weak: Weak<Self>,
    session_db: Arc<SessionDb>,
    notify: Option<TaskNotificationSink>,
    artifact_store: Arc<ArtifactVersionStore>,
    quiescer: Mutex<Option<Arc<dyn TaskThreadQuiescer>>>,
    thread_factory: Mutex<Option<Arc<dyn TaskThreadFactory>>>,
    continuation_dispatcher: Mutex<Option<Arc<dyn TaskContinuationDispatcher>>>,
    task_mutation_locks: DashMap<String, Arc<tokio::sync::Mutex<()>>>,
    continuation_attempts: DashMap<String, u64>,
}

impl TaskCoordinator {
    pub fn new(options: TaskCoordinatorOptions) -> Result<Arc<Self>, TaskCoordinatorError> {
        let artifact_store = match options.artifact_store {
            Some(store) => store,
            None => {
                let db_parent = options
                    .session_db
                    .db_path()
                    .parent()
                    .unwrap_or_else(|| Path::new("/private/tmp"));
                Arc::new(ArtifactVersionStore::new(ArtifactVersionStoreOptions {
                    root_dir: Some(db_parent.join("artifacts")),
                    homedir: None,
                }))
            }
        };
        Ok(Arc::new_cyclic(|weak| Self {
            self_weak: weak.clone(),
            session_db: options.session_db,
            notify: options.notify,
            artifact_store,
            quiescer: Mutex::new(options.quiesce_task_threads),
            thread_factory: Mutex::new(None),
            continuation_dispatcher: Mutex::new(None),
            task_mutation_locks: DashMap::new(),
            continuation_attempts: DashMap::new(),
        }))
    }

    fn is_task_thread_session(task: &TaskRecord, session_id: Option<&str>) -> bool {
        session_id.is_some_and(|sid| task.threads.iter().any(|t| t.session_id == sid))
    }

    pub fn session_db(&self) -> &Arc<SessionDb> {
        &self.session_db
    }

    pub fn artifact_store(&self) -> &Arc<ArtifactVersionStore> {
        &self.artifact_store
    }

    pub fn set_thread_factory(&self, factory: Arc<dyn TaskThreadFactory>) {
        *self.thread_factory.lock() = Some(factory);
    }

    pub fn set_continuation_dispatcher(&self, dispatcher: Arc<dyn TaskContinuationDispatcher>) {
        *self.continuation_dispatcher.lock() = Some(dispatcher);
    }

    pub fn set_quiescer(&self, quiescer: Arc<dyn TaskThreadQuiescer>) {
        *self.quiescer.lock() = Some(quiescer);
    }

    fn allows_pending_terminal_mutation(task_id: &str) -> bool {
        PENDING_TERMINAL_MUTATION_BYPASS
            .try_with(|set| set.contains(task_id))
            .unwrap_or(false)
    }

    async fn run_with_pending_terminal_bypass<F, Fut, T>(task_id: String, f: F) -> T
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = T>,
    {
        let mut next = PENDING_TERMINAL_MUTATION_BYPASS
            .try_with(|set| set.clone())
            .unwrap_or_default();
        next.insert(task_id);
        PENDING_TERMINAL_MUTATION_BYPASS.scope(next, f()).await
    }

    async fn run_task_mutation<F, Fut, T>(
        &self,
        task_id: &str,
        f: F,
    ) -> Result<T, TaskCoordinatorError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<T, TaskCoordinatorError>>,
    {
        let lock = self
            .task_mutation_locks
            .entry(task_id.to_owned())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone();
        let _guard = lock.lock().await;
        if let Some(pending_lock) = get_pending_terminal_task_lock(task_id)
            && !Self::allows_pending_terminal_mutation(task_id)
        {
            return Err(TaskCoordinatorError::TaskLocked(Box::new(pending_lock)));
        }
        f().await
    }

    async fn prepare_terminal_task_write(
        &self,
        task: &TaskRecord,
        reason: TaskStatus,
        origin_session_id: Option<String>,
    ) -> Result<PendingTerminalLockGuard, TaskCoordinatorError> {
        let mut guard = register_pending_terminal_task_locks(task, reason);
        let quiescer = self.quiescer.lock().clone();
        if let Some(q) = quiescer
            && let Err(e) = q
                .quiesce_task_threads(task.clone(), reason, origin_session_id)
                .await
        {
            guard.release();
            return Err(TaskCoordinatorError::InvalidRequest(e));
        }
        Ok(guard)
    }

    fn prepare_continuation_attempt(&self, task_id: &str) -> u64 {
        let token = NEXT_CONTINUATION_ATTEMPT.fetch_add(1, Ordering::Relaxed);
        self.continuation_attempts.insert(task_id.to_owned(), token);
        token
    }

    fn is_current_continuation_attempt(&self, task_id: &str, attempt: u64) -> bool {
        self.continuation_attempts
            .get(task_id)
            .is_some_and(|v| *v == attempt)
    }

    // =========================================================================
    // Synchronous queries
    // =========================================================================

    pub fn list(
        &self,
        workspace_path: Option<&str>,
    ) -> Result<Vec<TaskSummary>, TaskCoordinatorError> {
        let canon = workspace_path.map(canonicalize_workspace_str);
        Ok(self.session_db.list_tasks(canon.as_deref())?)
    }

    pub fn get(
        &self,
        task_id: &str,
        workspace_path: Option<&str>,
    ) -> Result<Option<TaskRecord>, TaskCoordinatorError> {
        let task = self.session_db.get_task(task_id)?;
        if let (Some(t), Some(ws)) = (&task, workspace_path) {
            assert_workspace(t, ws)?;
        }
        Ok(task)
    }

    pub fn get_by_creation_key(
        &self,
        idempotency_key: &str,
        source_session_id: Option<&str>,
        workspace_path: Option<&str>,
    ) -> Result<Option<TaskRecord>, TaskCoordinatorError> {
        let canon = workspace_path.map(canonicalize_workspace_str);
        Ok(self.session_db.get_task_by_creation_key(
            idempotency_key,
            source_session_id,
            canon.as_deref(),
        )?)
    }

    pub fn get_for_thread(
        &self,
        session_id: &str,
    ) -> Result<Option<TaskRecord>, TaskCoordinatorError> {
        Ok(self.session_db.get_task_for_thread(session_id)?)
    }

    pub fn get_active_for_source_session(
        &self,
        session_id: &str,
    ) -> Result<Option<TaskRecord>, TaskCoordinatorError> {
        Ok(self
            .session_db
            .get_active_task_for_source_session(session_id)?)
    }

    pub fn is_task_thread(&self, session_id: &str) -> bool {
        self.session_db.is_task_thread(session_id).unwrap_or(false)
    }

    pub fn get_context_for_thread(&self, session_id: &str) -> Option<TaskContextSnapshot> {
        let task = self.session_db.get_task_for_thread(session_id).ok()??;
        let thread = task.threads.iter().find(|t| t.session_id == session_id)?;
        let reviews = self.session_db.list_task_reviews(&task.id).ok()?;
        Some(TaskContextSnapshot {
            id: task.id,
            title: task.title,
            objective: task.objective,
            context: task.context,
            source_session_id: task.source_session_id,
            status: task.status,
            revision: task.revision,
            requirements: task
                .requirements
                .into_iter()
                .filter(|r| r.status == "active")
                .collect(),
            work_items: task.work_items,
            decisions: task
                .decisions
                .into_iter()
                .filter(|d| d.status == "active")
                .collect(),
            questions: task.questions,
            blockers: task
                .blockers
                .into_iter()
                .filter(|b| b.status == "active")
                .collect(),
            artifacts: task.artifacts,
            active_thread_id: thread.id.clone(),
            review_required: Some(task.review_required),
            review_rounds: Some(task.review_rounds),
            activity: Some(task.activity),
            reviews: Some(reviews),
        })
    }

    pub async fn get_review_material(
        &self,
        task_id: &str,
        workspace_path: &str,
        expected_revision: Option<i64>,
    ) -> Result<TaskReviewMaterialReference, TaskCoordinatorError> {
        self.run_task_mutation(task_id, || async {
            let task = self.require_task(task_id, workspace_path)?;
            if let Some(exp) = expected_revision {
                assert_expected_task_revision(&task, exp)?;
            }
            let mat = self.current_review_material(&task).await?;
            Ok(TaskReviewMaterialReference {
                fingerprint: mat.fingerprint,
            })
        })
        .await
    }

    pub async fn get_review_material_for_thread(
        &self,
        session_id: &str,
    ) -> Result<Option<TaskReviewMaterialReference>, TaskCoordinatorError> {
        let Some(task) = self.get_for_thread(session_id)? else {
            return Ok(None);
        };
        let mat = self
            .get_review_material(&task.id, &task.workspace_path, Some(task.revision))
            .await?;
        Ok(Some(mat))
    }

    // =========================================================================
    // Creation & planning
    // =========================================================================

    #[allow(clippy::too_many_arguments)]
    pub async fn create(
        &self,
        workspace_path: &str,
        title: &str,
        objective: &str,
        session_id: &str,
        thread_title: Option<&str>,
        review_required: Option<bool>,
        review_rounds: Option<i64>,
    ) -> Result<TaskRecord, TaskCoordinatorError> {
        let created_at = now_iso();
        let task_id = Uuid::new_v4().to_string();
        let thread = TaskThread {
            id: Uuid::new_v4().to_string(),
            task_id: task_id.clone(),
            session_id: non_empty(session_id, "Session id")?,
            title: non_empty(thread_title.unwrap_or("Main"), "Thread title")?,
            created_by: "user".to_owned(),
            created_at: created_at.clone(),
            updated_at: created_at,
        };
        let task = self
            .session_db
            .create_task_record(CreateTaskRecordInput {
                id: task_id,
                workspace_path: canonicalize_workspace_str(workspace_path),
                title: non_empty(title, "Task title")?,
                objective: non_empty(objective, "Task objective")?,
                context: String::new(),
                source_session_id: None,
                creation_origin: TaskCreationOrigin::Manual,
                creation_idempotency_key: None,
                initial_status: TaskStatus::Draft,
                review_required: review_required.unwrap_or(true),
                review_rounds: review_rounds.unwrap_or(0),
                thread,
                requirements: Vec::new(),
                work_items: Vec::new(),
                decisions: Vec::new(),
            })
            .await?;
        self.notify_updated(&task);
        Ok(task)
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn create_planned(
        &self,
        workspace_path: &str,
        session_id: &str,
        source_session_id: Option<&str>,
        creation_origin: TaskCreationOrigin,
        workspace_disposition: &str,
        creation: ValidatedTaskCreationInput,
        thread_title: Option<&str>,
    ) -> Result<TaskCreationResult, TaskCoordinatorError> {
        let canon_ws = canonicalize_workspace_str(workspace_path);
        if let Some(existing) = self.session_db.get_task_by_creation_key(
            &creation.idempotency_key,
            source_session_id,
            Some(&canon_ws),
        )? {
            return Ok(TaskCreationResult {
                task: existing,
                workspace_disposition: workspace_disposition.to_owned(),
            });
        }

        let created_at = now_iso();
        let task_id = Uuid::new_v4().to_string();
        let created_by = match creation_origin {
            TaskCreationOrigin::Manual => "user",
            TaskCreationOrigin::ChatTool => "coordinator",
        };
        let source = match creation_origin {
            TaskCreationOrigin::Manual => "user",
            TaskCreationOrigin::ChatTool => "agent",
        };
        let thread = TaskThread {
            id: Uuid::new_v4().to_string(),
            task_id: task_id.clone(),
            session_id: non_empty(session_id, "Session id")?,
            title: non_empty(thread_title.unwrap_or("Main"), "Thread title")?,
            created_by: created_by.to_owned(),
            created_at: created_at.clone(),
            updated_at: created_at.clone(),
        };

        let mut wi_id_by_key = BTreeMap::new();
        for item in &creation.work_items {
            wi_id_by_key.insert(item.key.clone(), Uuid::new_v4().to_string());
        }

        let mut work_items = Vec::with_capacity(creation.work_items.len());
        for (idx, item) in creation.work_items.iter().enumerate() {
            let mut deps = Vec::with_capacity(item.depends_on.len());
            for key in &item.depends_on {
                let dep_id = wi_id_by_key.get(key).ok_or_else(|| {
                    TaskCoordinatorError::InvalidRequest(format!(
                        "Unknown work item dependency: {key}"
                    ))
                })?;
                deps.push(dep_id.clone());
            }
            work_items.push(TaskWorkItemRecordInput {
                id: wi_id_by_key
                    .get(&item.key)
                    .cloned()
                    .unwrap_or_else(|| Uuid::new_v4().to_string()),
                title: item.title.clone(),
                description: item.description.clone(),
                status: WorkItemStatus::Queued,
                depends_on: deps,
                assigned_thread_id: None,
                claimed_by_thread_id: None,
                expected_outputs: item.expected_outputs.clone(),
                completion_evidence: None,
                position: idx as i64,
                created_at: created_at.clone(),
                updated_at: created_at.clone(),
            });
        }

        let requirements = creation
            .requirements
            .into_iter()
            .map(|r| TaskRequirement {
                id: Uuid::new_v4().to_string(),
                kind: r.kind,
                text: r.text,
                source: source.to_owned(),
                permanence: r.permanence,
                status: "active".to_owned(),
                created_at: created_at.clone(),
                supersedes: None,
            })
            .collect();

        let decisions = creation
            .decisions
            .into_iter()
            .map(|d| TaskDecision {
                id: Uuid::new_v4().to_string(),
                task_id: task_id.clone(),
                question: d.question,
                resolution: d.resolution,
                source: source.to_owned(),
                scope: "task".to_owned(),
                confidence: d.confidence,
                status: "active".to_owned(),
                created_at: created_at.clone(),
                supersedes: None,
            })
            .collect();

        let task = self
            .session_db
            .create_task_record(CreateTaskRecordInput {
                id: task_id,
                workspace_path: canon_ws,
                title: non_empty(&creation.title, "Task title")?,
                objective: non_empty(&creation.objective, "Task objective")?,
                context: non_empty(&creation.context, "Task context")?,
                source_session_id: source_session_id.map(str::to_owned),
                creation_origin,
                creation_idempotency_key: Some(creation.idempotency_key),
                initial_status: TaskStatus::Working,
                review_required: creation.review_required,
                review_rounds: creation.review_rounds,
                thread,
                requirements,
                work_items,
                decisions,
            })
            .await?;

        self.emit(
            "task/created",
            json!({
                "cwd": task.workspace_path,
                "task": task,
                "sourceSessionId": task.source_session_id,
                "takeover": true,
                "workspaceDisposition": workspace_disposition,
            }),
        );
        self.notify_updated(&task);
        Ok(TaskCreationResult {
            task,
            workspace_disposition: workspace_disposition.to_owned(),
        })
    }

    // =========================================================================
    // Threads, Brief, Graph & Work Items
    // =========================================================================

    #[allow(clippy::too_many_arguments)]
    pub async fn add_thread(
        &self,
        task_id: &str,
        workspace_path: &str,
        title: &str,
        expected_revision: i64,
        created_by: &str,
        work_item_id: Option<&str>,
        provider: Option<&str>,
        model: Option<&str>,
    ) -> Result<TaskRecord, TaskCoordinatorError> {
        self.run_task_mutation(task_id, || async {
            self.add_thread_locked(
                task_id,
                workspace_path,
                title,
                expected_revision,
                created_by,
                work_item_id,
                provider,
                model,
            )
            .await
        })
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn add_thread_locked(
        &self,
        task_id: &str,
        workspace_path: &str,
        title: &str,
        expected_revision: i64,
        created_by: &str,
        work_item_id: Option<&str>,
        provider: Option<&str>,
        model: Option<&str>,
    ) -> Result<TaskRecord, TaskCoordinatorError> {
        let task = self.require_task(task_id, workspace_path)?;
        assert_expected_task_revision(&task, expected_revision)?;
        assert_task_accepts_new_threads(&task, false)?;

        let thread_id = Uuid::new_v4().to_string();
        if let Some(wi_id) = work_item_id {
            let wi = task
                .work_items
                .iter()
                .find(|w| w.id == wi_id)
                .ok_or_else(|| {
                    TaskCoordinatorError::InvalidRequest(format!("Unknown work item: {wi_id}"))
                })?;
            assert_no_conflicting_work_item_owner(wi, &thread_id)?;
            assert_work_item_dependencies_complete(
                &task.work_items,
                wi,
                WorkItemStatus::InProgress,
            )?;
        }

        let factory = self.thread_factory.lock().clone().ok_or_else(|| {
            TaskCoordinatorError::InvalidRequest("Task thread creation is unavailable".to_owned())
        })?;
        let clean_title = non_empty(title, "Thread title")?;
        let created_session_id = factory
            .create_task_thread(TaskThreadFactoryInput {
                task: task.clone(),
                title: clean_title.clone(),
                work_item_id: work_item_id.map(str::to_owned),
                provider: provider.map(str::to_owned),
                model: model.map(str::to_owned),
            })
            .await
            .map_err(TaskCoordinatorError::InvalidRequest)?;

        let created_at = now_iso();
        let thread = TaskThread {
            id: thread_id.clone(),
            task_id: task.id.clone(),
            session_id: created_session_id,
            title: clean_title,
            created_by: created_by.to_owned(),
            created_at: created_at.clone(),
            updated_at: created_at,
        };
        let mut updated = self
            .session_db
            .add_task_thread(thread, expected_revision)
            .await?;
        if let Some(wi_id) = work_item_id {
            updated = self
                .claim_work_item_locked(
                    &task.id,
                    &task.workspace_path,
                    wi_id,
                    &thread_id,
                    updated.revision,
                )
                .await?;
        }
        self.notify_updated(&updated);
        Ok(updated)
    }

    pub async fn update_brief(
        &self,
        req: UpdateBriefRequest,
    ) -> Result<TaskRecord, TaskCoordinatorError> {
        let task_id = req.task_id.clone();
        self.run_task_mutation(&task_id, || async {
            let current = self.require_task(&req.task_id, &req.workspace_path)?;
            assert_expected_task_revision(&current, req.expected_revision)?;
            assert_task_accepts_mutation(&current, false)?;
            let title = req
                .title
                .as_deref()
                .map(|t| non_empty(t, "Task title"))
                .transpose()?;
            let objective = req
                .objective
                .as_deref()
                .map(|o| non_empty(o, "Task objective"))
                .transpose()?;
            let requirements = req
                .requirements
                .as_ref()
                .map(|list| {
                    list.iter()
                        .map(|r| {
                            make_requirement(
                                r.kind,
                                &r.text,
                                r.permanence.as_deref(),
                                r.source.as_deref(),
                            )
                        })
                        .collect::<Result<Vec<_>, _>>()
                })
                .transpose()?;
            let updated = self
                .session_db
                .update_task_brief(
                    req.task_id,
                    req.expected_revision,
                    title,
                    objective,
                    requirements,
                    now_iso(),
                )
                .await?;
            self.notify_updated(&updated);
            Ok(updated)
        })
        .await
    }

    pub async fn replace_work_items(
        &self,
        task_id: &str,
        workspace_path: &str,
        expected_revision: i64,
        items: Vec<ReplacementWorkItemInput>,
    ) -> Result<TaskRecord, TaskCoordinatorError> {
        self.run_task_mutation(task_id, || async {
            let current = self.require_task(task_id, workspace_path)?;
            assert_expected_task_revision(&current, expected_revision)?;
            assert_task_accepts_mutation(&current, false)?;
            let now = now_iso();
            let prepared = self.prepare_replacement_work_items(&current, &items, &now, None)?;
            let updated = self
                .session_db
                .replace_task_work_items(current.id, expected_revision, prepared, now)
                .await?;
            self.notify_updated(&updated);
            Ok(updated)
        })
        .await
    }

    fn prepare_replacement_work_items(
        &self,
        current: &TaskRecord,
        input_items: &[ReplacementWorkItemInput],
        updated_at: &str,
        thread_id: Option<&str>,
    ) -> Result<Vec<TaskWorkItemRecordInput>, TaskCoordinatorError> {
        let mut existing_by_id = BTreeMap::<String, &WorkItem>::new();
        for item in &current.work_items {
            let norm = item.id.trim().to_owned();
            if norm.is_empty() {
                return Err(TaskCoordinatorError::InvalidRequest(
                    "Cannot reconcile a work item with an empty id".to_owned(),
                ));
            }
            existing_by_id.insert(norm, item);
        }

        let mut coord_owned_ids = BTreeSet::<String>::new();
        for raw_id in self
            .session_db
            .list_coordinator_owned_task_artifact_revision_work_item_ids(&current.id)?
        {
            coord_owned_ids.insert(raw_id.trim().to_owned());
        }

        let mut seen_input_ids = BTreeSet::<String>::new();
        let mut work_items = Vec::<WorkItem>::with_capacity(input_items.len());
        let mut rows = Vec::with_capacity(input_items.len());

        for (pos, inp) in input_items.iter().enumerate() {
            let id = inp
                .id
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| Uuid::new_v4().to_string());
            if !seen_input_ids.insert(id.clone()) {
                return Err(TaskCoordinatorError::InvalidRequest(format!(
                    "Duplicate work item id after normalization: {id}"
                )));
            }
            let existing = existing_by_id.get(&id).copied();
            let coord_owned = existing.filter(|_| coord_owned_ids.contains(&id));
            let status = coord_owned
                .map(|c| c.status)
                .or(inp.status)
                .or_else(|| existing.map(|e| e.status))
                .unwrap_or(WorkItemStatus::Queued);
            let depends_on = if let Some(c) = coord_owned {
                c.depends_on.clone()
            } else {
                let mut uniq = Vec::new();
                let mut seen = BTreeSet::new();
                for d in inp.depends_on.as_deref().unwrap_or(&[]) {
                    let t = d.trim();
                    if !t.is_empty() && seen.insert(t.to_owned()) {
                        uniq.push(t.to_owned());
                    }
                }
                uniq
            };
            let assigned_thread_id = coord_owned
                .and_then(|c| c.assigned_thread_id.clone())
                .or_else(|| existing.and_then(|e| e.assigned_thread_id.clone()));
            let claimed_by_thread_id = if is_terminal_work_item_status(status) {
                None
            } else {
                coord_owned
                    .and_then(|c| c.claimed_by_thread_id.clone())
                    .or_else(|| existing.and_then(|e| e.claimed_by_thread_id.clone()))
            };
            let expected_outputs = if let Some(c) = coord_owned {
                c.expected_outputs.clone()
            } else {
                inp.expected_outputs
                    .as_deref()
                    .unwrap_or(&[])
                    .iter()
                    .map(|s| s.trim().to_owned())
                    .filter(|s| !s.is_empty())
                    .collect()
            };
            let completion_evidence = coord_owned
                .and_then(|c| c.completion_evidence.clone())
                .or_else(|| existing.and_then(|e| e.completion_evidence.clone()));

            let next = WorkItem {
                id,
                task_id: current.id.clone(),
                title: non_empty(&inp.title, "Work item title")?,
                description: inp
                    .description
                    .as_deref()
                    .map(str::trim)
                    .unwrap_or("")
                    .to_owned(),
                status,
                depends_on,
                assigned_thread_id,
                claimed_by_thread_id,
                expected_outputs,
                completion_evidence,
                position: pos as i64,
                created_at: existing
                    .map(|e| e.created_at.clone())
                    .unwrap_or_else(|| updated_at.to_owned()),
                updated_at: updated_at.to_owned(),
            };
            work_items.push(next.clone());
            rows.push((inp, next, existing, coord_owned.is_some()));
        }

        validate_work_graph(&work_items)?;

        if let Some(tid) = thread_id {
            assert_task_thread_member(current, tid)?;
            for (inp, next, existing, is_coord_owned) in &rows {
                if *is_coord_owned {
                    continue;
                }
                if !replacement_changes_work_item(*existing, next) {
                    continue;
                }
                assert_thread_can_mutate_work_item(current, existing.unwrap_or(next), tid)?;
                if let Some(ex) = existing {
                    assert_no_incomplete_dependency_removal(&work_items, ex, next)?;
                }
                assert_work_item_dependencies_complete(&work_items, next, next.status)?;
                if inp.status == Some(WorkItemStatus::Done) && next.completion_evidence.is_none() {
                    return Err(TaskCoordinatorError::InvalidRequest(
                        "Completion evidence is required before marking a work item done"
                            .to_owned(),
                    ));
                }
            }
        }

        let item_ids: BTreeSet<String> =
            work_items.iter().map(|w| w.id.trim().to_owned()).collect();
        if let Some(removed_coord) = current
            .work_items
            .iter()
            .find(|w| coord_owned_ids.contains(w.id.trim()) && !item_ids.contains(w.id.trim()))
        {
            return Err(TaskCoordinatorError::InvalidRequest(format!(
                "Cannot remove work item with active artifact revision or deferred artifact revision: {}",
                removed_coord.title
            )));
        }

        if let Some(tid) = thread_id {
            for item in &current.work_items {
                if item_ids.contains(item.id.trim()) || coord_owned_ids.contains(item.id.trim()) {
                    continue;
                }
                assert_thread_can_mutate_work_item(current, item, tid)?;
            }
        } else if let Some(removed_claim) = current
            .work_items
            .iter()
            .find(|w| w.claimed_by_thread_id.is_some() && !item_ids.contains(w.id.trim()))
        {
            return Err(TaskCoordinatorError::InvalidRequest(format!(
                "Cannot remove claimed work item: {}",
                removed_claim.title
            )));
        }

        Ok(work_items
            .into_iter()
            .map(|w| TaskWorkItemRecordInput {
                id: w.id,
                title: w.title,
                description: w.description,
                status: w.status,
                depends_on: w.depends_on,
                assigned_thread_id: w.assigned_thread_id,
                claimed_by_thread_id: w.claimed_by_thread_id,
                expected_outputs: w.expected_outputs,
                completion_evidence: w.completion_evidence,
                position: w.position,
                created_at: w.created_at,
                updated_at: w.updated_at,
            })
            .collect())
    }

    #[allow(clippy::too_many_arguments)]
    async fn update_plan_locked(
        &self,
        task_id: &str,
        workspace_path: &str,
        expected_revision: i64,
        objective: Option<&str>,
        requirements: Option<&[TaskDirectiveRequirementInput]>,
        items: &[ReplacementWorkItemInput],
        thread_id: Option<&str>,
    ) -> Result<TaskRecord, TaskCoordinatorError> {
        let current = self.require_task(task_id, workspace_path)?;
        assert_expected_task_revision(&current, expected_revision)?;
        assert_task_accepts_mutation(&current, false)?;
        let now = now_iso();
        let prepared = self.prepare_replacement_work_items(&current, items, &now, thread_id)?;
        let obj = objective
            .map(|o| non_empty(o, "Task objective"))
            .transpose()?;
        let merged_reqs = if let Some(reqs) = requirements {
            let mut out: Vec<TaskRequirement> = current
                .requirements
                .iter()
                .filter(|r| {
                    r.status == "active"
                        && r.permanence == "fixed"
                        && (r.source == "user" || r.source == "policy")
                })
                .cloned()
                .collect();
            for r in reqs {
                out.push(make_requirement(
                    r.kind,
                    &r.text,
                    r.permanence.as_deref(),
                    Some("agent"),
                )?);
            }
            Some(out)
        } else {
            None
        };
        let updated = self
            .session_db
            .update_task_plan(UpdateTaskPlanInput {
                task_id: current.id,
                expected_revision,
                title: None,
                objective: obj,
                requirements: merged_reqs,
                items: prepared,
                updated_at: now,
            })
            .await?;
        self.notify_updated(&updated);
        Ok(updated)
    }

    pub async fn claim_work_item(
        &self,
        task_id: &str,
        workspace_path: &str,
        work_item_id: &str,
        thread_id: &str,
        expected_revision: i64,
    ) -> Result<TaskRecord, TaskCoordinatorError> {
        self.run_task_mutation(task_id, || async {
            self.claim_work_item_locked(
                task_id,
                workspace_path,
                work_item_id,
                thread_id,
                expected_revision,
            )
            .await
        })
        .await
    }

    async fn claim_work_item_locked(
        &self,
        task_id: &str,
        workspace_path: &str,
        work_item_id: &str,
        thread_id: &str,
        expected_revision: i64,
    ) -> Result<TaskRecord, TaskCoordinatorError> {
        let task = self.require_task(task_id, workspace_path)?;
        assert_expected_task_revision(&task, expected_revision)?;
        assert_task_accepts_mutation(&task, false)?;
        let item = task
            .work_items
            .iter()
            .find(|w| w.id == work_item_id)
            .ok_or_else(|| {
                TaskCoordinatorError::InvalidRequest(format!("Unknown work item: {work_item_id}"))
            })?;
        assert_thread_can_claim_work_item(&task, item, thread_id)?;
        let updated = self
            .session_db
            .claim_task_work_item(
                task.id,
                item.id.clone(),
                thread_id.to_owned(),
                expected_revision,
                now_iso(),
            )
            .await?;
        self.notify_updated(&updated);
        Ok(updated)
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn mark_work_item(
        &self,
        task_id: &str,
        workspace_path: &str,
        work_item_id: &str,
        expected_revision: i64,
        status: WorkItemStatus,
        completion_evidence: Option<&str>,
        thread_id: Option<&str>,
    ) -> Result<TaskRecord, TaskCoordinatorError> {
        self.run_task_mutation(task_id, || async {
            self.mark_work_item_locked(
                task_id,
                workspace_path,
                work_item_id,
                expected_revision,
                status,
                completion_evidence,
                thread_id,
            )
            .await
        })
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn mark_work_item_locked(
        &self,
        task_id: &str,
        workspace_path: &str,
        work_item_id: &str,
        expected_revision: i64,
        status: WorkItemStatus,
        completion_evidence: Option<&str>,
        thread_id: Option<&str>,
    ) -> Result<TaskRecord, TaskCoordinatorError> {
        let task = self.require_task(task_id, workspace_path)?;
        assert_expected_task_revision(&task, expected_revision)?;
        assert_task_accepts_mutation(&task, false)?;
        let item = task
            .work_items
            .iter()
            .find(|w| w.id == work_item_id)
            .ok_or_else(|| {
                TaskCoordinatorError::InvalidRequest(format!("Unknown work item: {work_item_id}"))
            })?;
        assert_thread_can_mark_work_item(&task, item, status, thread_id)?;
        let clean_ev = completion_evidence.map(str::trim).filter(|s| !s.is_empty());
        if status == WorkItemStatus::Done
            && clean_ev.is_none()
            && item.completion_evidence.is_none()
        {
            return Err(TaskCoordinatorError::InvalidRequest(
                "Completion evidence is required before marking a work item done".to_owned(),
            ));
        }
        let updated = self
            .session_db
            .update_task_work_item(
                task.id,
                item.id.clone(),
                expected_revision,
                status,
                clean_ev.map(str::to_owned),
                now_iso(),
                thread_id.map(str::to_owned),
            )
            .await?;
        self.notify_updated(&updated);
        Ok(updated)
    }

    // =========================================================================
    // Decisions, Questions, Progress & Blockers
    // =========================================================================

    #[allow(clippy::too_many_arguments)]
    pub async fn record_decision(
        &self,
        task_id: &str,
        workspace_path: &str,
        expected_revision: i64,
        question: &str,
        resolution: &str,
        source: &str,
        scope: Option<&str>,
        confidence: Option<f64>,
        supersedes: Option<&str>,
    ) -> Result<TaskRecord, TaskCoordinatorError> {
        self.run_task_mutation(task_id, || async {
            self.record_decision_locked(
                task_id,
                workspace_path,
                expected_revision,
                question,
                resolution,
                source,
                scope,
                confidence,
                supersedes,
            )
            .await
        })
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn record_decision_locked(
        &self,
        task_id: &str,
        workspace_path: &str,
        expected_revision: i64,
        question: &str,
        resolution: &str,
        source: &str,
        scope: Option<&str>,
        confidence: Option<f64>,
        supersedes: Option<&str>,
    ) -> Result<TaskRecord, TaskCoordinatorError> {
        let task = self.require_task(task_id, workspace_path)?;
        assert_expected_task_revision(&task, expected_revision)?;
        assert_task_accepts_mutation(&task, false)?;
        if let Some(sup_id) = supersedes
            && !task.decisions.iter().any(|d| d.id == sup_id)
        {
            return Err(TaskCoordinatorError::InvalidRequest(format!(
                "Unknown superseded decision: {sup_id}"
            )));
        }
        let created_at = now_iso();
        let decision = TaskDecision {
            id: Uuid::new_v4().to_string(),
            task_id: task.id,
            question: non_empty(question, "Decision question")?,
            resolution: non_empty(resolution, "Decision resolution")?,
            source: source.to_owned(),
            scope: scope.unwrap_or("task").to_owned(),
            confidence,
            status: "active".to_owned(),
            created_at: created_at.clone(),
            supersedes: supersedes.map(str::to_owned),
        };
        let updated = self
            .session_db
            .record_task_decision(decision, expected_revision, created_at)
            .await?;
        self.notify_updated(&updated);
        Ok(updated)
    }

    async fn request_input_locked(
        &self,
        task_id: &str,
        workspace_path: &str,
        expected_revision: i64,
        session_id: &str,
        question_inputs: &[TaskDirectiveQuestionInput],
    ) -> Result<(TaskRecord, TaskDirectiveContinuation), TaskCoordinatorError> {
        let task = self.require_task(task_id, workspace_path)?;
        assert_expected_task_revision(&task, expected_revision)?;
        assert_task_accepts_mutation(&task, false)?;
        if matches!(
            task.status,
            TaskStatus::AwaitingReview
                | TaskStatus::Completed
                | TaskStatus::Failed
                | TaskStatus::Cancelled
        ) {
            return Err(TaskCoordinatorError::InvalidRequest(format!(
                "Task cannot request input while {}",
                task.status.as_str().replace('_', " ")
            )));
        }
        if question_inputs.is_empty() || question_inputs.len() > 3 {
            return Err(TaskCoordinatorError::InvalidRequest(
                "Request input must contain between 1 and 3 questions".to_owned(),
            ));
        }
        let thread = task
            .threads
            .iter()
            .find(|t| t.session_id == session_id)
            .ok_or_else(|| {
                TaskCoordinatorError::InvalidRequest(
                    "Input requests must originate from a task thread".to_owned(),
                )
            })?;

        let pending_by_id: BTreeMap<&str, &TaskQuestion> = task
            .questions
            .iter()
            .filter(|q| q.status == TaskQuestionStatus::Pending)
            .map(|q| (q.id.as_str(), q))
            .collect();
        let mut normalized_questions: BTreeSet<String> = pending_by_id
            .values()
            .map(|q| q.question.trim().to_lowercase())
            .collect();

        let created_at = now_iso();
        let mut provisional_decisions = Vec::new();
        let mut questions = Vec::new();

        for q_in in question_inputs {
            let q_text = non_empty(&q_in.question, "Question")?;
            let norm_q = q_text.to_lowercase();
            let superseded = if let Some(ref sup_id) = q_in.supersedes {
                Some(*pending_by_id.get(sup_id.as_str()).ok_or_else(|| {
                    TaskCoordinatorError::InvalidRequest(format!(
                        "Unknown pending superseded question: {sup_id}"
                    ))
                })?)
            } else {
                None
            };
            let sup_q_norm = superseded.map(|s| s.question.trim().to_lowercase());
            if normalized_questions.contains(&norm_q) && sup_q_norm.as_deref() != Some(&norm_q) {
                return Err(TaskCoordinatorError::InvalidRequest(format!(
                    "Task already has a pending question: {q_text}"
                )));
            }
            if let Some(ref wi_id) = q_in.work_item_id
                && !task.work_items.iter().any(|w| w.id == *wi_id)
            {
                return Err(TaskCoordinatorError::InvalidRequest(format!(
                    "Unknown work item: {wi_id}"
                )));
            }
            if q_in.blocking && q_in.urgency != TaskQuestionUrgency::Now {
                return Err(TaskCoordinatorError::InvalidRequest(
                    "Blocking task questions must use urgency now".to_owned(),
                ));
            }
            let default_action = q_in
                .default_action
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned);
            if !q_in.blocking && default_action.is_none() {
                return Err(TaskCoordinatorError::InvalidRequest(
                    "Non-blocking task questions require a reversible default action".to_owned(),
                ));
            }

            let mut options = Vec::new();
            for opt in q_in.options.as_deref().unwrap_or(&[]) {
                options.push(TaskQuestionOption {
                    id: non_empty(&opt.id, "Question option id")?,
                    label: non_empty(&opt.label, "Question option label")?,
                    description: opt
                        .description
                        .as_deref()
                        .map(str::trim)
                        .unwrap_or("")
                        .to_owned(),
                });
            }
            if options.len() == 1 || options.len() > 3 {
                return Err(TaskCoordinatorError::InvalidRequest(
                    "Task questions must provide either no options or 2 to 3 options".to_owned(),
                ));
            }
            let uniq_opts: BTreeSet<&str> = options.iter().map(|o| o.id.as_str()).collect();
            if uniq_opts.len() != options.len() {
                return Err(TaskCoordinatorError::InvalidRequest(
                    "Task question option ids must be unique".to_owned(),
                ));
            }
            if let Some(ref rec_id) = q_in.recommended_option_id
                && !options.iter().any(|o| o.id == *rec_id)
            {
                return Err(TaskCoordinatorError::InvalidRequest(
                    "Recommended option must reference a question option".to_owned(),
                ));
            }

            let provisional_decision_id = if !q_in.blocking {
                Some(Uuid::new_v4().to_string())
            } else {
                None
            };
            if let (Some(prov_id), Some(def_act)) = (&provisional_decision_id, &default_action) {
                provisional_decisions.push(TaskDecision {
                    id: prov_id.clone(),
                    task_id: task.id.clone(),
                    question: q_text.clone(),
                    resolution: def_act.clone(),
                    source: "agent".to_owned(),
                    scope: "task".to_owned(),
                    confidence: Some(0.5),
                    status: "active".to_owned(),
                    created_at: created_at.clone(),
                    supersedes: superseded.and_then(|s| s.provisional_decision_id.clone()),
                });
            }

            questions.push(TaskQuestion {
                id: Uuid::new_v4().to_string(),
                task_id: task.id.clone(),
                thread_id: Some(thread.id.clone()),
                work_item_id: q_in.work_item_id.clone(),
                header: non_empty(&q_in.header, "Question header")?,
                question: q_text,
                context: q_in
                    .context
                    .as_deref()
                    .map(str::trim)
                    .unwrap_or("")
                    .to_owned(),
                blocking: q_in.blocking,
                urgency: q_in.urgency,
                default_action,
                options,
                recommended_option_id: q_in.recommended_option_id.clone(),
                status: TaskQuestionStatus::Pending,
                provisional_decision_id,
                answer: None,
                answer_option_id: None,
                resolution_source: None,
                supersedes: q_in.supersedes.clone(),
                created_at: created_at.clone(),
                resolved_at: None,
            });
            normalized_questions.insert(norm_q);
        }

        let pause = questions.iter().any(|q| q.blocking);
        let updated = self
            .session_db
            .queue_task_questions(QueueTaskQuestionsInput {
                task_id: task.id,
                expected_revision,
                questions,
                provisional_decisions,
                block_task: pause,
                updated_at: created_at,
            })
            .await?;
        self.notify_updated(&updated);
        self.notify_activity(&updated);
        Ok((
            updated,
            if pause {
                TaskDirectiveContinuation::PauseForInput
            } else {
                TaskDirectiveContinuation::Continue
            },
        ))
    }

    pub async fn resolve_questions(
        &self,
        task_id: &str,
        workspace_path: &str,
        expected_revision: i64,
        answers: Vec<TaskQuestionAnswerInput>,
    ) -> Result<(TaskRecord, TaskQuestionResumeStatus), TaskCoordinatorError> {
        let (prepared_task, resume_info) = self
            .run_task_mutation(task_id, || async {
                let task = self.require_task(task_id, workspace_path)?;
                assert_expected_task_revision(&task, expected_revision)?;
                assert_task_accepts_mutation(&task, false)?;
                if answers.is_empty() || answers.len() > 3 {
                    return Err(TaskCoordinatorError::InvalidRequest(
                        "Resolve questions must contain between 1 and 3 answers".to_owned(),
                    ));
                }
                let mut seen_ids = BTreeSet::new();
                for a in &answers {
                    let qid = non_empty(&a.question_id, "Question id")?;
                    if !seen_ids.insert(qid) {
                        return Err(TaskCoordinatorError::InvalidRequest(
                            "Task question answers must reference unique questions".to_owned(),
                        ));
                    }
                }

                let created_at = now_iso();
                let mut resolutions = Vec::with_capacity(answers.len());
                let mut blocking_pairs = Vec::new();
                let mut resolved_blocking = false;

                for ans_in in &answers {
                    let question = task
                        .questions
                        .iter()
                        .find(|q| {
                            q.id == ans_in.question_id && q.status == TaskQuestionStatus::Pending
                        })
                        .ok_or_else(|| {
                            TaskCoordinatorError::InvalidRequest(format!(
                                "Unknown pending task question: {}",
                                ans_in.question_id
                            ))
                        })?;
                    let opt_id = ans_in
                        .option_id
                        .as_deref()
                        .map(str::trim)
                        .filter(|s| !s.is_empty());
                    let txt = ans_in
                        .text
                        .as_deref()
                        .map(str::trim)
                        .filter(|s| !s.is_empty());
                    if opt_id.is_some() == txt.is_some() {
                        return Err(TaskCoordinatorError::InvalidRequest(
                            "Provide exactly one of optionId or text for each task answer"
                                .to_owned(),
                        ));
                    }
                    let (answer_text, answer_opt_id) = if let Some(oid) = opt_id {
                        let opt =
                            question
                                .options
                                .iter()
                                .find(|o| o.id == oid)
                                .ok_or_else(|| {
                                    TaskCoordinatorError::InvalidRequest(format!(
                                        "Unknown task question option: {oid}"
                                    ))
                                })?;
                        (opt.label.clone(), Some(opt.id.clone()))
                    } else {
                        (non_empty(txt.unwrap_or(""), "Task answer")?, None)
                    };

                    if question.blocking {
                        resolved_blocking = true;
                        blocking_pairs.push((question.question.clone(), answer_text.clone()));
                    }

                    resolutions.push(TaskQuestionResolutionRecordInput {
                        question_id: question.id.clone(),
                        answer: answer_text.clone(),
                        answer_option_id: answer_opt_id,
                        decision: TaskDecision {
                            id: Uuid::new_v4().to_string(),
                            task_id: task.id.clone(),
                            question: question.question.clone(),
                            resolution: answer_text,
                            source: "user".to_owned(),
                            scope: "task".to_owned(),
                            confidence: None,
                            status: "active".to_owned(),
                            created_at: created_at.clone(),
                            supersedes: question.provisional_decision_id.clone(),
                        },
                    });
                }

                let updated = self
                    .session_db
                    .resolve_task_questions(ResolveTaskQuestionsInput {
                        task_id: task.id.clone(),
                        expected_revision,
                        resolutions,
                        updated_at: created_at,
                    })
                    .await?;
                self.notify_updated(&updated);
                self.notify_activity(&updated);

                if !resolved_blocking
                    || updated.status != TaskStatus::Working
                    || task.status != TaskStatus::Blocked
                {
                    return Ok((updated, None));
                }
                let attempt = self.prepare_continuation_attempt(&task.id);
                Ok((updated, Some((blocking_pairs, attempt))))
            })
            .await?;

        let Some((blocking_answers, attempt)) = resume_info else {
            return Ok((prepared_task, TaskQuestionResumeStatus::NotNeeded));
        };

        let prompt = build_task_question_continuation_prompt(&blocking_answers);
        let display_text = format!(
            "Answered {} task question{} in the work panel.",
            blocking_answers.len(),
            if blocking_answers.len() == 1 { "" } else { "s" }
        );
        let status = self
            .dispatch_continuation(&prepared_task, attempt, prompt, display_text, true)
            .await;
        let refreshed = self.require_task(&prepared_task.id, &prepared_task.workspace_path)?;
        Ok((refreshed, status))
    }

    async fn dispatch_continuation(
        &self,
        task: &TaskRecord,
        attempt: u64,
        prompt: String,
        display_text: String,
        record_input_resume_failure_on_error: bool,
    ) -> TaskQuestionResumeStatus {
        if !self.is_current_continuation_attempt(&task.id, attempt) {
            return TaskQuestionResumeStatus::Failed;
        }
        let primary_session_id = task.threads.first().map(|t| t.session_id.clone());
        let dispatcher = self.continuation_dispatcher.lock().clone();
        let outcome = match (primary_session_id.clone(), dispatcher) {
            (Some(sid), Some(disp)) => disp.dispatch_continuation(sid, prompt, display_text).await,
            _ => Err("Task continuation is unavailable".to_owned()),
        };

        match outcome {
            Ok(st) if st != TaskQuestionResumeStatus::Failed => st,
            Ok(_) => {
                if record_input_resume_failure_on_error {
                    let _ = self
                        .record_input_resume_failure(&task.id, "Task continuation failed", attempt)
                        .await;
                } else if let Some(sid) = primary_session_id {
                    let _ = self
                        .fail_primary_task_run(
                            &sid,
                            Some("Task continuation failed"),
                            Some(attempt),
                        )
                        .await;
                }
                TaskQuestionResumeStatus::Failed
            }
            Err(err) => {
                if record_input_resume_failure_on_error {
                    let _ = self
                        .record_input_resume_failure(&task.id, &err, attempt)
                        .await;
                } else if let Some(sid) = primary_session_id {
                    let _ = self
                        .fail_primary_task_run(&sid, Some(&err), Some(attempt))
                        .await;
                }
                TaskQuestionResumeStatus::Failed
            }
        }
    }

    async fn record_input_resume_failure(
        &self,
        task_id: &str,
        error_msg: &str,
        attempt: u64,
    ) -> Result<(), TaskCoordinatorError> {
        self.run_task_mutation(task_id, || async {
            if !self.is_current_continuation_attempt(task_id, attempt) {
                return Ok(());
            }
            let Some(current) = self.session_db.get_task(task_id)? else {
                return Ok(());
            };
            if current.status != TaskStatus::Working && current.status != TaskStatus::Planning {
                return Ok(());
            }
            let message = if error_msg.trim().is_empty() {
                "Task continuation failed".to_owned()
            } else {
                error_msg.trim().to_owned()
            };
            let act = make_activity(
                task_id,
                current.threads.first().map(|t| t.id.clone()),
                None,
                TaskActivityKind::InputResumeFailed,
                "Task answers were saved, but automatic resume failed".to_owned(),
                Some(message.clone()),
            );
            let updated = self.session_db.append_task_activity(act, true).await?;
            self.notify_activity(&updated);
            let detail = json!({
                "kind": "input_resume_failed",
                "message": message,
            })
            .to_string();
            let _ = self
                .transition_locked(
                    &current.id,
                    &current.workspace_path,
                    updated.revision,
                    TaskStatus::Failed,
                    "Task continuation failed",
                    Some(&detail),
                    current.threads.first().map(|t| t.session_id.as_str()),
                )
                .await?;
            Ok(())
        })
        .await
    }

    pub async fn report_progress(
        &self,
        task_id: &str,
        workspace_path: &str,
        session_id: Option<&str>,
        summary: &str,
        detail: Option<&str>,
        work_item_id: Option<&str>,
    ) -> Result<TaskRecord, TaskCoordinatorError> {
        self.run_task_mutation(task_id, || async {
            self.report_progress_locked(
                task_id,
                workspace_path,
                session_id,
                summary,
                detail,
                work_item_id,
            )
            .await
        })
        .await
    }

    async fn report_progress_locked(
        &self,
        task_id: &str,
        workspace_path: &str,
        session_id: Option<&str>,
        summary: &str,
        detail: Option<&str>,
        work_item_id: Option<&str>,
    ) -> Result<TaskRecord, TaskCoordinatorError> {
        let task = self.require_task(task_id, workspace_path)?;
        assert_task_accepts_mutation(&task, false)?;
        if let Some(wi_id) = work_item_id
            && !task.work_items.iter().any(|w| w.id == wi_id)
        {
            return Err(TaskCoordinatorError::InvalidRequest(format!(
                "Unknown work item: {wi_id}"
            )));
        }
        let thread_id = session_id.and_then(|sid| {
            task.threads
                .iter()
                .find(|t| t.session_id == sid)
                .map(|t| t.id.clone())
        });
        let act = make_activity(
            &task.id,
            thread_id,
            work_item_id.map(str::to_owned),
            TaskActivityKind::ProgressReported,
            non_empty(summary, "Progress summary")?,
            detail
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned),
        );
        let updated = self.session_db.append_task_activity(act, true).await?;
        self.notify_activity(&updated);
        Ok(updated)
    }

    pub async fn report_blocker(
        &self,
        task_id: &str,
        workspace_path: &str,
        expected_revision: i64,
        description: &str,
        blocking: bool,
        work_item_id: Option<&str>,
    ) -> Result<TaskRecord, TaskCoordinatorError> {
        self.run_task_mutation(task_id, || async {
            self.report_blocker_locked(
                task_id,
                workspace_path,
                expected_revision,
                description,
                blocking,
                work_item_id,
            )
            .await
        })
        .await
    }

    async fn report_blocker_locked(
        &self,
        task_id: &str,
        workspace_path: &str,
        expected_revision: i64,
        description: &str,
        blocking: bool,
        work_item_id: Option<&str>,
    ) -> Result<TaskRecord, TaskCoordinatorError> {
        let task = self.require_task(task_id, workspace_path)?;
        assert_expected_task_revision(&task, expected_revision)?;
        assert_task_accepts_mutation(&task, false)?;
        if let Some(wi_id) = work_item_id
            && !task.work_items.iter().any(|w| w.id == wi_id)
        {
            return Err(TaskCoordinatorError::InvalidRequest(format!(
                "Unknown work item: {wi_id}"
            )));
        }
        let created_at = now_iso();
        let desc = non_empty(description, "Blocker description")?;
        let blocker = TaskBlocker {
            id: Uuid::new_v4().to_string(),
            task_id: task.id.clone(),
            work_item_id: work_item_id.map(str::to_owned),
            description: desc.clone(),
            blocking,
            status: "active".to_owned(),
            created_at: created_at.clone(),
            resolved_at: None,
        };
        let mut updated = self
            .session_db
            .report_task_blocker(blocker, expected_revision, created_at)
            .await?;
        if blocking
            && (updated.status == TaskStatus::Planning || updated.status == TaskStatus::Working)
        {
            updated = self
                .transition_locked(
                    &task.id,
                    &task.workspace_path,
                    updated.revision,
                    TaskStatus::Blocked,
                    "Task blocked",
                    Some(&desc),
                    None,
                )
                .await?;
        } else {
            self.notify_updated(&updated);
        }
        Ok(updated)
    }

    pub async fn resolve_blocker(
        &self,
        task_id: &str,
        workspace_path: &str,
        blocker_id: &str,
        expected_revision: i64,
    ) -> Result<TaskRecord, TaskCoordinatorError> {
        self.run_task_mutation(task_id, || async {
            let task = self.require_task(task_id, workspace_path)?;
            assert_expected_task_revision(&task, expected_revision)?;
            assert_task_accepts_mutation(&task, false)?;
            if !task.blockers.iter().any(|b| b.id == blocker_id) {
                return Err(TaskCoordinatorError::InvalidRequest(format!(
                    "Unknown blocker: {blocker_id}"
                )));
            }
            let mut updated = self
                .session_db
                .resolve_task_blocker(
                    task.id.clone(),
                    blocker_id.to_owned(),
                    expected_revision,
                    now_iso(),
                )
                .await?;
            let has_blocking = self.has_blocking_state(&updated);
            if updated.status == TaskStatus::Blocked && !has_blocking {
                updated = self
                    .transition_locked(
                        &task.id,
                        &task.workspace_path,
                        updated.revision,
                        TaskStatus::Working,
                        "Task unblocked",
                        None,
                        None,
                    )
                    .await?;
            } else {
                self.notify_updated(&updated);
            }
            Ok(updated)
        })
        .await
    }

    // =========================================================================
    // Artifacts & Revisions (`TaskArtifacts` parity)
    // =========================================================================

    pub fn get_artifact_detail(
        &self,
        task_id: &str,
        workspace_path: &str,
        artifact_id: &str,
    ) -> Result<Option<TaskArtifactDetail>, TaskCoordinatorError> {
        self.require_task(task_id, workspace_path)?;
        Ok(self
            .session_db
            .get_task_artifact_detail(task_id, artifact_id)?)
    }

    pub async fn read_artifact_version(
        &self,
        task_id: &str,
        workspace_path: &str,
        artifact_id: &str,
        version_id: &str,
    ) -> Result<ReadArtifactVersionOutput, TaskCoordinatorError> {
        let detail = self.require_artifact_detail(task_id, workspace_path, artifact_id)?;
        let version = detail
            .versions
            .iter()
            .find(|v| v.id == version_id)
            .cloned()
            .ok_or_else(|| {
                TaskCoordinatorError::InvalidRequest(format!(
                    "Unknown artifact version: {version_id}"
                ))
            })?;
        let bytes = self
            .artifact_store
            .read_bytes(version.sha256.clone())
            .await?;
        let filename = Path::new(&detail.artifact.path)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("artifact")
            .to_owned();
        Ok(ReadArtifactVersionOutput {
            bytes,
            filename,
            mime_type: version.media_type.clone(),
            version,
        })
    }

    pub async fn register_artifact(
        &self,
        req: RegisterArtifactRequest,
    ) -> Result<TaskRecord, TaskCoordinatorError> {
        let task_id = req.task_id.clone();
        self.run_task_mutation(&task_id, || async {
            self.register_artifact_locked(req).await
        })
        .await
    }

    async fn register_artifact_locked(
        &self,
        req: RegisterArtifactRequest,
    ) -> Result<TaskRecord, TaskCoordinatorError> {
        let task = self.require_task(&req.task_id, &req.workspace_path)?;
        assert_expected_task_revision(&task, req.expected_revision)?;
        assert_task_accepts_mutation(&task, false)?;
        if let Some(ref wi_id) = req.work_item_id
            && !task.work_items.iter().any(|w| w.id == *wi_id)
        {
            return Err(TaskCoordinatorError::InvalidRequest(format!(
                "Unknown work item: {wi_id}"
            )));
        }
        let resolved_path = self.resolve_artifact_path(&task, &req.path)?;
        let resolved_str = resolved_path.to_string_lossy().into_owned();

        if let Some(ref sid) = req.session_id
            && let Some(active_rev) = self
                .session_db
                .get_active_task_artifact_revision_for_session(sid)?
        {
            if let Some(ref aid) = req.artifact_id
                && active_rev.artifact_id != *aid
            {
                return Err(TaskCoordinatorError::InvalidRequest(
                    "Active revision targets a different artifact".to_owned(),
                ));
            }
            if let Some(ref bvid) = req.base_version_id
                && active_rev.base_version_id != *bvid
            {
                return Err(TaskCoordinatorError::InvalidRequest(
                    "Artifact base version does not match the active revision".to_owned(),
                ));
            }
            let active_detail = self
                .session_db
                .get_task_artifact_detail(&task.id, &active_rev.artifact_id)?;
            let matches_path = active_detail
                .as_ref()
                .is_some_and(|d| same_workspace_path(&d.artifact.path, &resolved_str));
            if !matches_path {
                return Err(TaskCoordinatorError::InvalidRequest(
                    "Active revision targets a different artifact path".to_owned(),
                ));
            }
            let finalized = self
                .handle_thread_outcome_locked(sid, "completed", None)
                .await?
                .ok_or_else(|| {
                    TaskCoordinatorError::InvalidRequest(
                        "Active artifact revision could not be finalized".to_owned(),
                    )
                })?;
            return Ok(finalized.task);
        }

        let stored = self
            .artifact_store
            .capture_file(resolved_path.clone())
            .await?;
        let thread_id = req.session_id.as_deref().and_then(|sid| {
            task.threads
                .iter()
                .find(|t| t.session_id == sid)
                .map(|t| t.id.clone())
        });
        let created_at = now_iso();
        let existing_artifact = if let Some(ref aid) = req.artifact_id {
            let found = task
                .artifacts
                .iter()
                .find(|a| a.id == *aid)
                .ok_or_else(|| {
                    TaskCoordinatorError::InvalidRequest(format!("Unknown task artifact: {aid}"))
                })?;
            Some(found)
        } else {
            task.artifacts
                .iter()
                .find(|a| same_workspace_path(&a.path, &resolved_str))
        };

        let mut prov = existing_artifact
            .map(|a| a.provenance.clone())
            .unwrap_or_default();
        if let Some(ref p) = req.provenance {
            for (k, v) in p {
                prov.insert(k.clone(), v.clone());
            }
        }

        let clean_kind = non_empty(&req.kind, "Artifact kind")?;
        let clean_title = non_empty(&req.title, "Artifact title")?;
        let artifact_record = TaskArtifact {
            id: existing_artifact
                .map(|a| a.id.clone())
                .unwrap_or_else(|| Uuid::new_v4().to_string()),
            task_id: task.id.clone(),
            work_item_id: req
                .work_item_id
                .clone()
                .or_else(|| existing_artifact.and_then(|a| a.work_item_id.clone())),
            thread_id: thread_id.or_else(|| existing_artifact.and_then(|a| a.thread_id.clone())),
            path: resolved_str.clone(),
            kind: clean_kind.clone(),
            title: clean_title,
            created_by: existing_artifact
                .map(|a| a.created_by.clone())
                .or_else(|| req.session_id.clone())
                .unwrap_or_else(|| "user".to_owned()),
            provenance: prov,
            created_at: existing_artifact
                .map(|a| a.created_at.clone())
                .unwrap_or_else(|| created_at.clone()),
        };

        let existing_detail = if let Some(ex) = existing_artifact {
            self.session_db.get_task_artifact_detail(&task.id, &ex.id)?
        } else {
            None
        };
        let parent_version = existing_detail
            .as_ref()
            .and_then(|d| d.versions.last())
            .cloned();
        if let Some(ref bvid) = req.base_version_id {
            let exists = existing_detail
                .as_ref()
                .is_some_and(|d| d.versions.iter().any(|v| v.id == *bvid));
            if !exists {
                return Err(TaskCoordinatorError::InvalidRequest(format!(
                    "Unknown artifact base version: {bvid}"
                )));
            }
        }
        if parent_version
            .as_ref()
            .is_some_and(|p| p.sha256 == stored.sha256)
        {
            return Ok(task);
        }

        let mut ver_prov = req.provenance.unwrap_or_default();
        if let Some(bvid) = req.base_version_id {
            ver_prov.insert("baseVersionId".to_owned(), Value::String(bvid));
        }
        let change_summary = req
            .change_summary
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| {
                if parent_version.is_some() {
                    "Updated artifact registered".to_owned()
                } else {
                    "Initial artifact registered".to_owned()
                }
            });
        let version = self.make_artifact_version(
            &artifact_record,
            parent_version.as_ref().map(|p| p.version).unwrap_or(0) + 1,
            parent_version.map(|p| p.id),
            &stored,
            media_type_for_artifact(&resolved_str, &clean_kind),
            req.session_id.as_deref().unwrap_or("user"),
            &created_at,
            change_summary,
            ver_prov,
            TaskArtifactVersionReviewStatus::Draft,
        )?;
        let updated = self
            .session_db
            .register_task_artifact_versioned(
                artifact_record,
                version,
                req.expected_revision,
                created_at,
            )
            .await?;
        self.notify_updated(&updated);
        Ok(updated)
    }

    pub async fn ensure_artifact_baseline(
        &self,
        task_id: &str,
        workspace_path: &str,
        artifact_id: &str,
        expected_revision: i64,
        expected_sha256: Option<&str>,
        created_by: Option<&str>,
    ) -> Result<TaskArtifactDetail, TaskCoordinatorError> {
        self.run_task_mutation(task_id, || async {
            self.ensure_artifact_baseline_locked(
                task_id,
                workspace_path,
                artifact_id,
                expected_revision,
                expected_sha256,
                created_by,
            )
            .await
        })
        .await
    }

    async fn ensure_artifact_baseline_locked(
        &self,
        task_id: &str,
        workspace_path: &str,
        artifact_id: &str,
        expected_revision: i64,
        expected_sha256: Option<&str>,
        created_by: Option<&str>,
    ) -> Result<TaskArtifactDetail, TaskCoordinatorError> {
        let task = self.require_task(task_id, workspace_path)?;
        let detail = self.require_artifact_detail(task_id, workspace_path, artifact_id)?;
        if !detail.versions.is_empty() {
            return Ok(detail);
        }
        assert_expected_task_revision(&task, expected_revision)?;
        assert_task_accepts_mutation(&task, false)?;
        let resolved_path = self.resolve_artifact_path(&task, &detail.artifact.path)?;
        let stored = self
            .artifact_store
            .capture_file(resolved_path.clone())
            .await?;
        self.assert_expected_fingerprint(
            &detail.artifact.id,
            expected_sha256,
            Some(&stored.sha256),
        )?;
        let created_at = now_iso();
        let mut prov = Map::new();
        prov.insert("baseline".to_owned(), Value::Bool(true));
        let version = self.make_artifact_version(
            &detail.artifact,
            1,
            None,
            &stored,
            media_type_for_artifact(&resolved_path.to_string_lossy(), &detail.artifact.kind),
            created_by.unwrap_or("system"),
            &created_at,
            "Initial versioning baseline".to_owned(),
            prov,
            TaskArtifactVersionReviewStatus::Accepted,
        )?;
        let baseline = self
            .session_db
            .register_task_artifact_baseline(
                task_id.to_owned(),
                artifact_id.to_owned(),
                version,
                expected_revision,
                created_at,
            )
            .await?;
        if let Some(refreshed) = self.session_db.get_task(task_id)? {
            self.notify_updated(&refreshed);
        }
        Ok(baseline)
    }

    pub async fn capture_artifact_version(
        &self,
        req: CaptureArtifactVersionRequest,
    ) -> Result<(TaskRecord, TaskArtifactDetail, TaskArtifactVersion), TaskCoordinatorError> {
        let task_id = req.task_id.clone();
        self.run_task_mutation(&task_id, || async {
            let mut task = self.require_task(&req.task_id, &req.workspace_path)?;
            assert_expected_task_revision(&task, req.expected_revision)?;
            assert_task_accepts_mutation(&task, false)?;
            let mut detail =
                self.require_artifact_detail(&req.task_id, &req.workspace_path, &req.artifact_id)?;
            if detail.versions.is_empty() {
                detail = self
                    .ensure_artifact_baseline_locked(
                        &req.task_id,
                        &req.workspace_path,
                        &req.artifact_id,
                        req.expected_revision,
                        req.expected_sha256.as_deref(),
                        req.created_by.as_deref(),
                    )
                    .await?;
                task = self.require_task(&req.task_id, &req.workspace_path)?;
                let baseline = detail.versions.first().cloned().ok_or_else(|| {
                    TaskCoordinatorError::InvalidRequest(
                        "Artifact baseline was not created".to_owned(),
                    )
                })?;
                return Ok((task, detail, baseline));
            }

            let resolved_path = self.resolve_artifact_path(&task, &detail.artifact.path)?;
            let stored = self
                .artifact_store
                .capture_file(resolved_path.clone())
                .await?;
            self.assert_expected_fingerprint(
                &detail.artifact.id,
                req.expected_sha256.as_deref(),
                Some(&stored.sha256),
            )?;
            let parent = detail.versions.last().cloned().ok_or_else(|| {
                TaskCoordinatorError::InvalidRequest("Artifact baseline was not created".to_owned())
            })?;
            if parent.sha256 == stored.sha256 {
                return Ok((task, detail, parent));
            }
            let created_at = now_iso();
            let version = self.make_artifact_version(
                &detail.artifact,
                parent.version + 1,
                Some(parent.id),
                &stored,
                media_type_for_artifact(&resolved_path.to_string_lossy(), &detail.artifact.kind),
                req.created_by.as_deref().unwrap_or("user"),
                &created_at,
                req.change_summary
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .unwrap_or("Artifact version captured")
                    .to_owned(),
                req.provenance.unwrap_or_default(),
                TaskArtifactVersionReviewStatus::Draft,
            )?;
            let updated_detail = self
                .session_db
                .capture_task_artifact_version(
                    task.id.clone(),
                    detail.artifact.id.clone(),
                    version.clone(),
                    req.expected_revision,
                    created_at,
                    TaskActivityKind::ArtifactVersionCaptured,
                )
                .await?;
            task = self.require_task(&task.id, &task.workspace_path)?;
            self.notify_updated(&task);
            Ok((task, updated_detail, version))
        })
        .await
    }

    pub async fn restore_artifact_version(
        &self,
        req: RestoreArtifactVersionRequest,
    ) -> Result<(TaskRecord, TaskArtifactDetail, TaskArtifactVersion), TaskCoordinatorError> {
        let task_id = req.task_id.clone();
        self.run_task_mutation(&task_id, || async {
            let mut task = self.require_task(&req.task_id, &req.workspace_path)?;
            assert_expected_task_revision(&task, req.expected_revision)?;
            assert_task_accepts_mutation(&task, false)?;
            let detail =
                self.require_artifact_detail(&req.task_id, &req.workspace_path, &req.artifact_id)?;
            let target = detail
                .versions
                .iter()
                .find(|v| v.id == req.version_id)
                .cloned()
                .ok_or_else(|| {
                    TaskCoordinatorError::InvalidRequest(format!(
                        "Unknown artifact version: {}",
                        req.version_id
                    ))
                })?;
            let parent = detail.versions.last().cloned().ok_or_else(|| {
                TaskCoordinatorError::InvalidRequest(
                    "Artifact has no version to restore from".to_owned(),
                )
            })?;
            let resolved_path = self.resolve_artifact_path(&task, &detail.artifact.path)?;
            let current = self
                .artifact_store
                .capture_file(resolved_path.clone())
                .await?;
            let expected = req
                .expected_sha256
                .as_deref()
                .unwrap_or(parent.sha256.as_str());
            self.assert_expected_fingerprint(
                &detail.artifact.id,
                Some(expected),
                Some(&current.sha256),
            )?;

            let created_at = now_iso();
            let mut prov = Map::new();
            prov.insert(
                "restoredFromVersionId".to_owned(),
                Value::String(target.id.clone()),
            );
            let version = self.make_artifact_version(
                &detail.artifact,
                parent.version + 1,
                Some(parent.id),
                &StoredArtifactBlob {
                    sha256: target.sha256.clone(),
                    size_bytes: target.size_bytes,
                },
                target.media_type.clone(),
                req.created_by.as_deref().unwrap_or("user"),
                &created_at,
                req.change_summary
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .unwrap_or_else(|| {
                        format!("Restored from artifact version {}", target.version)
                    }),
                prov,
                TaskArtifactVersionReviewStatus::Draft,
            )?;

            self.artifact_store
                .restore_file(RestoreArtifactFileInput {
                    blob_sha256: target.sha256.clone(),
                    file_path: resolved_path.clone(),
                    expected_fingerprint: Some(current.sha256.clone()),
                })
                .await
                .map_err(|e| match e {
                    StorageError::ArtifactFingerprintConflict {
                        expected_fingerprint,
                        actual_fingerprint,
                    } => TaskCoordinatorError::ArtifactConflict {
                        artifact_id: Some(detail.artifact.id.clone()),
                        expected_sha256: expected_fingerprint,
                        current_sha256: actual_fingerprint,
                    },
                    other => TaskCoordinatorError::from(other),
                })?;

            let updated_detail = match self
                .session_db
                .capture_task_artifact_version(
                    task.id.clone(),
                    detail.artifact.id.clone(),
                    version.clone(),
                    req.expected_revision,
                    created_at,
                    TaskActivityKind::ArtifactVersionRestored,
                )
                .await
            {
                Ok(d) => d,
                Err(err) => {
                    let _ = self
                        .artifact_store
                        .restore_file(RestoreArtifactFileInput {
                            blob_sha256: current.sha256,
                            file_path: resolved_path,
                            expected_fingerprint: Some(target.sha256),
                        })
                        .await;
                    return Err(TaskCoordinatorError::from(err));
                }
            };

            task = self.require_task(&task.id, &task.workspace_path)?;
            self.notify_updated(&task);
            Ok((task, updated_detail, version))
        })
        .await
    }

    pub async fn accept_artifact_version(
        &self,
        req: AcceptArtifactVersionRequest,
    ) -> Result<(TaskRecord, TaskArtifactDetail), TaskCoordinatorError> {
        let task_id = req.task_id.clone();
        self.run_task_mutation(&task_id, || async {
            let current = self.require_task(&req.task_id, &req.workspace_path)?;
            assert_expected_task_revision(&current, req.expected_revision)?;
            assert_task_accepts_mutation(&current, false)?;
            let detail =
                self.require_artifact_detail(&req.task_id, &req.workspace_path, &req.artifact_id)?;
            let version_id = req.version_id.or(detail.latest_version_id).ok_or_else(|| {
                TaskCoordinatorError::InvalidRequest("Artifact has no version to accept".to_owned())
            })?;
            let task = self
                .session_db
                .accept_task_artifact_version(
                    req.task_id.clone(),
                    req.artifact_id.clone(),
                    version_id,
                    req.expected_revision,
                    now_iso(),
                )
                .await?;
            let updated_detail =
                self.require_artifact_detail(&req.task_id, &req.workspace_path, &req.artifact_id)?;
            self.notify_updated(&task);
            Ok((task, updated_detail))
        })
        .await
    }

    pub async fn start_artifact_revision(
        &self,
        req: StartArtifactRevisionRequest,
    ) -> Result<(TaskRecord, TaskArtifactDetail, TaskArtifactRevision), TaskCoordinatorError> {
        let task_id = req.task_id.clone();
        self.run_task_mutation(&task_id, || async {
            let mut task = self.require_task(&req.task_id, &req.workspace_path)?;
            assert_expected_task_revision(&task, req.expected_revision)?;
            assert_task_accepts_new_threads(&task, false)?;
            let mut detail =
                self.require_artifact_detail(&req.task_id, &req.workspace_path, &req.artifact_id)?;
            if detail.versions.is_empty() {
                detail = self
                    .ensure_artifact_baseline_locked(
                        &req.task_id,
                        &req.workspace_path,
                        &req.artifact_id,
                        req.expected_revision,
                        None,
                        Some("system"),
                    )
                    .await?;
                task = self.require_task(&req.task_id, &req.workspace_path)?;
                assert_task_accepts_new_threads(&task, false)?;
            }
            if detail.active_revision.is_some() {
                return Err(TaskCoordinatorError::InvalidRequest(
                    "Artifact already has an active revision".to_owned(),
                ));
            }
            let prior = detail.versions.last().cloned().ok_or_else(|| {
                TaskCoordinatorError::InvalidRequest("Artifact has no baseline version".to_owned())
            })?;
            let base_id = req
                .base_version_id
                .clone()
                .or_else(|| detail.accepted_version_id.clone())
                .unwrap_or_else(|| prior.id.clone());
            let base = detail
                .versions
                .iter()
                .find(|v| v.id == base_id)
                .cloned()
                .ok_or_else(|| {
                    TaskCoordinatorError::InvalidRequest(format!(
                        "Unknown artifact base version: {base_id}"
                    ))
                })?;
            let resolved_path = self.resolve_artifact_path(&task, &detail.artifact.path)?;
            let current_fp = self
                .artifact_store
                .fingerprint_file(resolved_path.clone())
                .await?;
            self.assert_expected_fingerprint(
                &detail.artifact.id,
                Some(&prior.sha256),
                current_fp.as_ref().map(|f| f.sha256.as_str()),
            )?;

            let changed_base = base.id != prior.id;
            if changed_base {
                self.artifact_store
                    .restore_file(RestoreArtifactFileInput {
                        blob_sha256: base.sha256.clone(),
                        file_path: resolved_path.clone(),
                        expected_fingerprint: current_fp.map(|f| f.sha256),
                    })
                    .await?;
            }

            let Some(factory) = self.thread_factory.lock().clone() else {
                if changed_base {
                    let _ = self
                        .artifact_store
                        .restore_file(RestoreArtifactFileInput {
                            blob_sha256: prior.sha256,
                            file_path: resolved_path,
                            expected_fingerprint: None,
                        })
                        .await;
                }
                return Err(TaskCoordinatorError::InvalidRequest(
                    "Task thread creation is unavailable".to_owned(),
                ));
            };

            let created_at = now_iso();
            let work_item_id = Uuid::new_v4().to_string();
            let default_title = format!("Revise {}", detail.artifact.title);
            let thread_title = non_empty(
                req.title.as_deref().unwrap_or(&default_title),
                "Thread title",
            )?;
            let created_session_id = match factory
                .create_task_thread(TaskThreadFactoryInput {
                    task: task.clone(),
                    title: thread_title.clone(),
                    work_item_id: Some(work_item_id.clone()),
                    provider: req.provider.clone(),
                    model: req.model.clone(),
                })
                .await
            {
                Ok(sid) => sid,
                Err(err) => {
                    if changed_base {
                        let _ = self
                            .artifact_store
                            .restore_file(RestoreArtifactFileInput {
                                blob_sha256: prior.sha256,
                                file_path: resolved_path,
                                expected_fingerprint: None,
                            })
                            .await;
                    }
                    return Err(TaskCoordinatorError::InvalidRequest(err));
                }
            };

            let thread_id = Uuid::new_v4().to_string();
            let thread = TaskThread {
                id: thread_id.clone(),
                task_id: task.id.clone(),
                session_id: created_session_id.clone(),
                title: thread_title.clone(),
                created_by: "coordinator".to_owned(),
                created_at: created_at.clone(),
                updated_at: created_at.clone(),
            };
            let instruction = non_empty(&req.instruction, "Revision instruction")?;
            let revision = TaskArtifactRevision {
                id: Uuid::new_v4().to_string(),
                task_id: task.id.clone(),
                artifact_id: detail.artifact.id.clone(),
                work_item_id: work_item_id.clone(),
                task_thread_id: thread_id.clone(),
                session_id: created_session_id,
                base_version_id: base.id,
                prior_version_id: prior.id.clone(),
                status: TaskArtifactRevisionStatus::Active,
                instruction: instruction.clone(),
                created_at: created_at.clone(),
                updated_at: created_at.clone(),
                completed_at: None,
            };
            let work_item = TaskWorkItemRecordInput {
                id: work_item_id,
                title: thread_title,
                description: instruction,
                status: WorkItemStatus::InProgress,
                depends_on: Vec::new(),
                assigned_thread_id: Some(thread_id.clone()),
                claimed_by_thread_id: Some(thread_id),
                expected_outputs: vec![detail.artifact.path.clone()],
                completion_evidence: None,
                position: task.work_items.len() as i64,
                created_at: created_at.clone(),
                updated_at: created_at,
            };

            task = match self
                .session_db
                .start_task_artifact_revision(StartTaskArtifactRevisionInput {
                    revision: revision.clone(),
                    thread,
                    work_item,
                    expected_revision: task.revision,
                })
                .await
            {
                Ok(t) => t,
                Err(err) => {
                    if changed_base {
                        let _ = self
                            .artifact_store
                            .restore_file(RestoreArtifactFileInput {
                                blob_sha256: prior.sha256,
                                file_path: resolved_path,
                                expected_fingerprint: None,
                            })
                            .await;
                    }
                    return Err(TaskCoordinatorError::from(err));
                }
            };

            detail =
                self.require_artifact_detail(&req.task_id, &req.workspace_path, &req.artifact_id)?;
            self.notify_updated(&task);
            Ok((task, detail, revision))
        })
        .await
    }

    pub async fn handle_thread_outcome(
        &self,
        session_id: &str,
        outcome: &str,
        failure_msg: Option<&str>,
    ) -> Result<Option<RevisionOutcomeResult>, TaskCoordinatorError> {
        let known = self
            .session_db
            .get_active_task_artifact_revision_for_session(session_id)?
            .or(self
                .session_db
                .get_task_artifact_revision_for_session(session_id)?);
        let Some(known_rev) = known else {
            if outcome == "error" {
                let _ = self
                    .fail_primary_task_run(session_id, failure_msg, None)
                    .await;
            }
            return Ok(None);
        };
        let task_id = known_rev.task_id.clone();
        self.run_task_mutation(&task_id, || async {
            self.handle_thread_outcome_locked(session_id, outcome, failure_msg)
                .await
        })
        .await
    }

    async fn handle_thread_outcome_locked(
        &self,
        session_id: &str,
        outcome: &str,
        failure_msg: Option<&str>,
    ) -> Result<Option<RevisionOutcomeResult>, TaskCoordinatorError> {
        let Some(revision) = self
            .session_db
            .get_active_task_artifact_revision_for_session(session_id)?
        else {
            let Some(closed) = self
                .session_db
                .get_task_artifact_revision_for_session(session_id)?
            else {
                return Ok(None);
            };
            let task = self.session_db.get_task(&closed.task_id)?;
            let detail = self
                .session_db
                .get_task_artifact_detail(&closed.task_id, &closed.artifact_id)?;
            return Ok(match (task, detail) {
                (Some(t), Some(d)) => Some(RevisionOutcomeResult {
                    task: t,
                    detail: d,
                    revision: closed,
                }),
                _ => None,
            });
        };

        let task = self
            .session_db
            .get_task(&revision.task_id)?
            .ok_or_else(|| {
                TaskCoordinatorError::InvalidRequest(format!("Unknown task: {}", revision.task_id))
            })?;
        let detail = self
            .session_db
            .get_task_artifact_detail(&task.id, &revision.artifact_id)?
            .ok_or_else(|| {
                TaskCoordinatorError::InvalidRequest(format!(
                    "Unknown task artifact: {}",
                    revision.artifact_id
                ))
            })?;
        let prior = detail
            .versions
            .iter()
            .find(|v| v.id == revision.prior_version_id)
            .cloned()
            .ok_or_else(|| {
                TaskCoordinatorError::InvalidRequest(format!(
                    "Unknown prior artifact version: {}",
                    revision.prior_version_id
                ))
            })?;
        let prior_task_status = self
            .session_db
            .get_task_artifact_revision_prior_task_status(&revision.id)?
            .unwrap_or(task.status);

        if is_terminal_task(&task) {
            let updated_task = self
                .session_db
                .abandon_task_artifact_revision_for_terminal_task(revision.id.clone(), now_iso())
                .await?;
            let updated_rev = self
                .session_db
                .get_task_artifact_revision(&revision.id)?
                .unwrap_or(revision);
            let updated_detail = self
                .session_db
                .get_task_artifact_detail(&task.id, &detail.artifact.id)?
                .unwrap_or(detail);
            self.notify_updated(&updated_task);
            return Ok(Some(RevisionOutcomeResult {
                task: updated_task,
                detail: updated_detail,
                revision: updated_rev,
            }));
        }

        let resolved_path = self.resolve_artifact_path(&task, &detail.artifact.path)?;
        if outcome == "completed" {
            let latest_matches = detail.versions.last().is_some_and(|v| v.id == prior.id);
            if !latest_matches {
                let _ = self
                    .artifact_store
                    .restore_file(RestoreArtifactFileInput {
                        blob_sha256: prior.sha256,
                        file_path: resolved_path,
                        expected_fingerprint: None,
                    })
                    .await;
                let failed = self
                    .session_db
                    .fail_task_artifact_revision(
                        revision.id.clone(),
                        TaskArtifactRevisionStatus::Error,
                        now_iso(),
                        Some(
                            "Artifact version changed while its revision thread was active"
                                .to_owned(),
                        ),
                    )
                    .await?;
                let settled = self
                    .settle_after_revision_outcome(
                        failed,
                        prior_task_status,
                        "error",
                        session_id,
                        Some("Artifact version changed while its revision thread was active"),
                    )
                    .await?;
                let u_rev = self
                    .session_db
                    .get_task_artifact_revision(&revision.id)?
                    .unwrap_or(revision);
                let u_det = self
                    .session_db
                    .get_task_artifact_detail(&task.id, &detail.artifact.id)?
                    .unwrap_or(detail);
                return Ok(Some(RevisionOutcomeResult {
                    task: settled,
                    detail: u_det,
                    revision: u_rev,
                }));
            }

            let stored = self
                .artifact_store
                .capture_file(resolved_path.clone())
                .await?;
            let created_at = now_iso();
            let mut prov = Map::new();
            prov.insert("revisionId".to_owned(), Value::String(revision.id.clone()));
            prov.insert(
                "baseVersionId".to_owned(),
                Value::String(revision.base_version_id.clone()),
            );
            prov.insert("sessionId".to_owned(), Value::String(session_id.to_owned()));
            let version = self.make_artifact_version(
                &detail.artifact,
                prior.version + 1,
                Some(prior.id),
                &stored,
                media_type_for_artifact(&resolved_path.to_string_lossy(), &detail.artifact.kind),
                session_id,
                &created_at,
                revision.instruction.clone(),
                prov,
                TaskArtifactVersionReviewStatus::Draft,
            )?;
            let updated_task = self
                .session_db
                .complete_task_artifact_revision(revision.id.clone(), version, created_at, false)
                .await?;
            let settled = self
                .settle_after_revision_outcome(
                    updated_task,
                    prior_task_status,
                    "completed",
                    session_id,
                    None,
                )
                .await?;
            let u_rev = self
                .session_db
                .get_task_artifact_revision(&revision.id)?
                .unwrap_or(revision);
            let u_det = self
                .session_db
                .get_task_artifact_detail(&task.id, &detail.artifact.id)?
                .unwrap_or(detail);
            Ok(Some(RevisionOutcomeResult {
                task: settled,
                detail: u_det,
                revision: u_rev,
            }))
        } else {
            let _ = self
                .artifact_store
                .restore_file(RestoreArtifactFileInput {
                    blob_sha256: prior.sha256,
                    file_path: resolved_path,
                    expected_fingerprint: None,
                })
                .await;
            let status_enum = if outcome == "cancelled" {
                TaskArtifactRevisionStatus::Cancelled
            } else {
                TaskArtifactRevisionStatus::Error
            };
            let msg = failure_msg.unwrap_or(if outcome == "cancelled" {
                "Revision cancelled"
            } else {
                "Revision thread failed"
            });
            let failed_task = self
                .session_db
                .fail_task_artifact_revision(
                    revision.id.clone(),
                    status_enum,
                    now_iso(),
                    Some(msg.to_owned()),
                )
                .await?;
            let settled = self
                .settle_after_revision_outcome(
                    failed_task,
                    prior_task_status,
                    outcome,
                    session_id,
                    Some(msg),
                )
                .await?;
            let u_rev = self
                .session_db
                .get_task_artifact_revision(&revision.id)?
                .unwrap_or(revision);
            let u_det = self
                .session_db
                .get_task_artifact_detail(&task.id, &detail.artifact.id)?
                .unwrap_or(detail);
            Ok(Some(RevisionOutcomeResult {
                task: settled,
                detail: u_det,
                revision: u_rev,
            }))
        }
    }

    async fn settle_after_revision_outcome(
        &self,
        task: TaskRecord,
        prior_task_status: TaskStatus,
        outcome: &str,
        session_id: &str,
        detail_msg: Option<&str>,
    ) -> Result<TaskRecord, TaskCoordinatorError> {
        let latest = self.session_db.get_task(&task.id)?.unwrap_or(task);
        if is_terminal_task(&latest) {
            return Ok(latest);
        }
        if outcome == "error" {
            if latest.status == TaskStatus::Blocked {
                self.notify_updated(&latest);
                return Ok(latest);
            }
            return self
                .transition_locked(
                    &latest.id,
                    &latest.workspace_path,
                    latest.revision,
                    TaskStatus::Blocked,
                    "Artifact revision failed",
                    detail_msg,
                    Some(session_id),
                )
                .await;
        }
        if self.has_active_artifact_revision(&latest)? {
            self.notify_updated(&latest);
            return Ok(latest);
        }
        if latest.status == TaskStatus::Blocked || self.has_blocking_state(&latest) {
            self.notify_updated(&latest);
            return Ok(latest);
        }
        if (outcome == "completed" || prior_task_status == TaskStatus::AwaitingReview)
            && let Ok(settled) = self
                .propose_completion_locked(
                    &latest.id,
                    &latest.workspace_path,
                    latest.revision,
                    if outcome == "completed" {
                        "Artifact revision completed"
                    } else {
                        "Artifact revision cancelled"
                    },
                    None,
                    Some(session_id),
                    Some(false),
                    false,
                    None,
                    false,
                )
                .await
        {
            return Ok(settled);
        }
        let refreshed = self.session_db.get_task(&latest.id)?.unwrap_or(latest);
        self.notify_updated(&refreshed);
        Ok(refreshed)
    }

    // =========================================================================
    // Reviews, Completion, Lifecycle Transitions & Recovery
    // =========================================================================

    #[allow(clippy::too_many_arguments)]
    pub async fn record_review(
        &self,
        task_id: &str,
        workspace_path: &str,
        session_id: Option<&str>,
        expected_revision: i64,
        expected_material_fingerprint: Option<&str>,
        reviewer_agent_id: &str,
        reviewer_provider: &str,
        reviewer_model: &str,
        verdict: TaskReviewVerdict,
        feedback: &str,
    ) -> Result<(TaskRecord, String, i64), TaskCoordinatorError> {
        self.run_task_mutation(task_id, || async {
            self.record_review_locked(
                task_id,
                workspace_path,
                session_id,
                expected_revision,
                expected_material_fingerprint,
                reviewer_agent_id,
                reviewer_provider,
                reviewer_model,
                verdict,
                feedback,
            )
            .await
        })
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn record_review_locked(
        &self,
        task_id: &str,
        workspace_path: &str,
        session_id: Option<&str>,
        expected_revision: i64,
        expected_material_fingerprint: Option<&str>,
        reviewer_agent_id: &str,
        reviewer_provider: &str,
        reviewer_model: &str,
        verdict: TaskReviewVerdict,
        feedback: &str,
    ) -> Result<(TaskRecord, String, i64), TaskCoordinatorError> {
        let task = self.require_task(task_id, workspace_path)?;
        assert_expected_task_revision(&task, expected_revision)?;
        assert_task_accepts_mutation(&task, false)?;
        if task.status != TaskStatus::Working {
            return Err(TaskCoordinatorError::InvalidRequest(
                "Independent reviews can run only while a task is working".to_owned(),
            ));
        }
        if task.review_rounds <= 0 {
            return Err(TaskCoordinatorError::InvalidRequest(
                "This task does not require independent reviews".to_owned(),
            ));
        }
        if task.work_items.is_empty() {
            return Err(TaskCoordinatorError::InvalidRequest(
                "Task has no work plan".to_owned(),
            ));
        }
        let unfinished = task
            .work_items
            .iter()
            .filter(|w| {
                !matches!(
                    w.status,
                    WorkItemStatus::Done | WorkItemStatus::Review | WorkItemStatus::Abandoned
                )
            })
            .count();
        if unfinished > 0 {
            return Err(TaskCoordinatorError::InvalidRequest(format!(
                "Task has {unfinished} unfinished work item(s)"
            )));
        }
        for item in &task.work_items {
            if !item.expected_outputs.is_empty()
                && !self.has_expected_artifact_output(&task, item)?
            {
                return Err(TaskCoordinatorError::InvalidRequest(format!(
                    "Expected artifact is not registered for: {}",
                    item.title
                )));
            }
        }

        let reviews = self.session_db.list_task_reviews(&task.id)?;
        let rounds = get_task_review_rounds_from_records(&reviews);
        if let Some(pending) = get_pending_task_review(&rounds) {
            return Err(TaskCoordinatorError::InvalidRequest(format!(
                "Review round {} feedback must be addressed before another review",
                pending.round
            )));
        }
        if rounds.len() as i64 >= MAX_TASK_REVIEW_ROUNDS {
            return Err(TaskCoordinatorError::InvalidRequest(format!(
                "Task reached the {MAX_TASK_REVIEW_ROUNDS}-round review safety cap"
            )));
        }
        let clean_agent_id = non_empty(reviewer_agent_id, "Reviewer agent id")?;
        if rounds.iter().any(|r| r.reviewer_agent_id == clean_agent_id) {
            return Err(TaskCoordinatorError::InvalidRequest(
                "Each independent review round must use a new reviewer agent".to_owned(),
            ));
        }

        let round = rounds.len() as i64 + 1;
        let material = self.current_review_material(&task).await?;
        if let Some(exp_fp) = expected_material_fingerprint
            .map(str::trim)
            .filter(|s| !s.is_empty())
            && material.fingerprint != exp_fp
        {
            return Err(TaskCoordinatorError::InvalidRequest(
                "Reviewed material changed before the review could be recorded; rerun a fresh independent review".to_owned(),
            ));
        }

        let review_id = Uuid::new_v4().to_string();
        let clean_feedback = non_empty(feedback, "Review feedback")?;
        let clean_provider = non_empty(reviewer_provider, "Reviewer provider")?;
        let clean_model = non_empty(reviewer_model, "Reviewer model")?;
        let created_at = now_iso();

        let review = TaskReviewRecord {
            id: review_id.clone(),
            task_id: task.id.clone(),
            round,
            verdict,
            feedback: clean_feedback.clone(),
            reviewer_agent_id: clean_agent_id.clone(),
            reviewer_provider: clean_provider.clone(),
            reviewer_model: clean_model.clone(),
            task_revision: task.revision,
            material_fingerprint: material.fingerprint,
            material_snapshot: material.snapshot,
            created_at: created_at.clone(),
            addressed_at: None,
            implementation_summary: None,
        };
        let thread_id = session_id.and_then(|sid| {
            task.threads
                .iter()
                .find(|t| t.session_id == sid)
                .map(|t| t.id.clone())
        });
        let act = TaskActivity {
            id: review_id.clone(),
            seq: 1,
            task_id: task.id.clone(),
            thread_id,
            work_item_id: None,
            kind: TaskActivityKind::ReviewCompleted,
            summary: format!(
                "Independent review round {round}: {}",
                verdict.as_str().to_uppercase()
            ),
            detail: Some(
                json!({
                    "round": round,
                    "verdict": verdict.as_str(),
                    "feedback": clean_feedback,
                    "reviewerAgentId": clean_agent_id,
                    "reviewerProvider": clean_provider,
                    "reviewerModel": clean_model,
                })
                .to_string(),
            ),
            created_at,
        };
        let updated = self
            .session_db
            .record_task_review(review, act, expected_revision)
            .await?;
        self.notify_updated(&updated);
        self.notify_activity(&updated);
        Ok((updated, review_id, round))
    }

    pub async fn address_review(
        &self,
        task_id: &str,
        workspace_path: &str,
        session_id: Option<&str>,
        expected_revision: i64,
        review_id: &str,
        implementation_summary: &str,
    ) -> Result<TaskRecord, TaskCoordinatorError> {
        self.run_task_mutation(task_id, || async {
            self.address_review_locked(
                task_id,
                workspace_path,
                session_id,
                expected_revision,
                review_id,
                implementation_summary,
            )
            .await
        })
        .await
    }

    async fn address_review_locked(
        &self,
        task_id: &str,
        workspace_path: &str,
        session_id: Option<&str>,
        expected_revision: i64,
        review_id: &str,
        implementation_summary: &str,
    ) -> Result<TaskRecord, TaskCoordinatorError> {
        let task = self.require_task(task_id, workspace_path)?;
        assert_expected_task_revision(&task, expected_revision)?;
        assert_task_accepts_mutation(&task, false)?;
        let reviews = self.session_db.list_task_reviews(&task.id)?;
        let rounds = get_task_review_rounds_from_records(&reviews);
        let pending = get_pending_task_review(&rounds).ok_or_else(|| {
            TaskCoordinatorError::InvalidRequest(
                "Task has no unaddressed review feedback".to_owned(),
            )
        })?;
        if pending.review_id != review_id {
            return Err(TaskCoordinatorError::InvalidRequest(format!(
                "Review {review_id} is not the pending review"
            )));
        }
        let clean_summary = non_empty(implementation_summary, "Review implementation summary")?;
        let addressed_at = now_iso();
        let thread_id = session_id.and_then(|sid| {
            task.threads
                .iter()
                .find(|t| t.session_id == sid)
                .map(|t| t.id.clone())
        });
        let act = TaskActivity {
            id: Uuid::new_v4().to_string(),
            seq: 1,
            task_id: task.id.clone(),
            thread_id,
            work_item_id: None,
            kind: TaskActivityKind::ReviewAddressed,
            summary: format!(
                "Independent review round {} feedback implemented",
                pending.round
            ),
            detail: Some(
                json!({
                    "reviewId": pending.review_id,
                    "implementationSummary": clean_summary,
                })
                .to_string(),
            ),
            created_at: addressed_at.clone(),
        };
        let updated = self
            .session_db
            .address_task_review(
                task.id,
                pending.review_id.clone(),
                expected_revision,
                addressed_at,
                clean_summary,
                act,
            )
            .await?;
        self.notify_updated(&updated);
        self.notify_activity(&updated);
        Ok(updated)
    }

    pub async fn propose_completion(
        &self,
        task_id: &str,
        workspace_path: &str,
        expected_revision: i64,
        summary: &str,
        caveats: Option<&[String]>,
    ) -> Result<TaskRecord, TaskCoordinatorError> {
        self.run_task_mutation(task_id, || async {
            self.propose_completion_locked(
                task_id,
                workspace_path,
                expected_revision,
                summary,
                caveats,
                None,
                None,
                false,
                None,
                false,
            )
            .await
        })
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn propose_completion_locked(
        &self,
        task_id: &str,
        workspace_path: &str,
        expected_revision: i64,
        summary: &str,
        caveats: Option<&[String]>,
        session_id: Option<&str>,
        default_pending_questions: Option<bool>,
        defer_terminal_until_origin_settled: bool,
        directive_commit: Option<TaskDirectiveCommitHooks>,
        allow_pending_terminal_mutation: bool,
    ) -> Result<TaskRecord, TaskCoordinatorError> {
        let mut task = self.require_task(task_id, workspace_path)?;
        assert_expected_task_revision(&task, expected_revision)?;
        assert_task_accepts_mutation(
            &task,
            allow_pending_terminal_mutation && Self::allows_pending_terminal_mutation(task_id),
        )?;

        if task
            .questions
            .iter()
            .any(|q| q.status == TaskQuestionStatus::Pending && q.blocking)
        {
            return Err(TaskCoordinatorError::InvalidRequest(
                "Task has unresolved blocking questions".to_owned(),
            ));
        }
        if task
            .questions
            .iter()
            .any(|q| q.status == TaskQuestionStatus::Pending)
        {
            if default_pending_questions == Some(false) {
                return Err(TaskCoordinatorError::InvalidRequest(
                    "Task has unresolved pending questions".to_owned(),
                ));
            }
            task = self
                .session_db
                .default_pending_task_questions(task.id.clone(), expected_revision, now_iso())
                .await?;
            self.notify_updated(&task);
            self.notify_activity(&task);
        }

        let current_material = self.validate_completion_proposal_task(&task).await?;
        if task.status == TaskStatus::AwaitingReview {
            if task.review_required {
                return Ok(task);
            }
            return self
                .accept_task_locked(
                    &task.id,
                    &task.workspace_path,
                    task.revision,
                    session_id,
                    defer_terminal_until_origin_settled,
                    directive_commit,
                )
                .await;
        }

        let caveats_detail = caveats
            .map(|c| {
                c.iter()
                    .map(|s| s.trim())
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .filter(|s| !s.is_empty());

        let (ready_commit, accept_commit) = if task.review_required {
            (directive_commit, None)
        } else {
            (None, directive_commit)
        };

        let ready = if let Some(ref mat) = current_material {
            let thread_id = session_id.and_then(|sid| {
                task.threads
                    .iter()
                    .find(|t| t.session_id == sid)
                    .map(|t| t.id.clone())
            });
            let mat_clone = mat.clone();
            let updated = self
                .session_db
                .set_task_status_validated(
                    SetTaskStatusInput {
                        task_id: task.id.clone(),
                        expected_revision: task.revision,
                        status: TaskStatus::AwaitingReview,
                        summary: non_empty(summary, "Status summary")?,
                        detail: caveats_detail,
                        updated_at: now_iso(),
                        thread_id,
                    },
                    |updated_task| async move {
                        self.assert_live_artifact_evidence_unchanged(&updated_task, &mat_clone)
                            .await
                            .map_err(|e| StorageError::Task(e.to_string()))
                    },
                    ready_commit,
                )
                .await?;
            self.notify_updated(&updated);
            if task.review_required {
                return Ok(updated);
            }
            return self
                .accept_task_locked(
                    &updated.id,
                    &updated.workspace_path,
                    updated.revision,
                    session_id,
                    defer_terminal_until_origin_settled,
                    accept_commit,
                )
                .await;
        } else {
            let updated = self
                .transition_locked(
                    &task.id,
                    &task.workspace_path,
                    task.revision,
                    TaskStatus::AwaitingReview,
                    summary,
                    caveats_detail.as_deref(),
                    session_id,
                )
                .await?;
            if task.review_required {
                return Ok(updated);
            }
            updated
        };

        self.accept_task_locked(
            &ready.id,
            &ready.workspace_path,
            ready.revision,
            session_id,
            defer_terminal_until_origin_settled,
            accept_commit,
        )
        .await
    }

    pub async fn accept_task(
        &self,
        task_id: &str,
        workspace_path: &str,
        expected_revision: i64,
    ) -> Result<TaskRecord, TaskCoordinatorError> {
        self.run_task_mutation(task_id, || async {
            self.accept_task_locked(
                task_id,
                workspace_path,
                expected_revision,
                None,
                false,
                None,
            )
            .await
        })
        .await
    }

    async fn accept_task_locked(
        &self,
        task_id: &str,
        workspace_path: &str,
        expected_revision: i64,
        session_id: Option<&str>,
        defer_terminal_until_origin_settled: bool,
        directive_commit: Option<TaskDirectiveCommitHooks>,
    ) -> Result<TaskRecord, TaskCoordinatorError> {
        let current = self.require_task(task_id, workspace_path)?;
        assert_expected_task_revision(&current, expected_revision)?;
        if current.status != TaskStatus::AwaitingReview {
            return Err(TaskCoordinatorError::InvalidRequest(
                "Task must be awaiting review before it can be accepted".to_owned(),
            ));
        }

        let _reviewed_material = match self.require_completion_review_eligibility(&current).await {
            Ok(Some(mat)) => {
                if let Err(err) = self
                    .assert_live_artifact_evidence_unchanged(&current, &mat)
                    .await
                {
                    self.return_task_to_working_after_stale_acceptance(&current, &err, session_id)
                        .await;
                    return Err(err);
                }
                Some(mat)
            }
            Ok(None) => None,
            Err(err) => {
                self.return_task_to_working_after_stale_acceptance(&current, &err, session_id)
                    .await;
                return Err(err);
            }
        };

        if defer_terminal_until_origin_settled
            && Self::is_task_thread_session(&current, session_id)
            && let (Some(origin_sid), Some(coord)) = (session_id, self.self_weak.upgrade())
        {
            let mut pending_guard =
                register_pending_terminal_task_locks(&current, TaskStatus::Completed);
            let task_for_quiesce = current.clone();
            let task_id_owned = current.id.clone();
            let ws_owned = current.workspace_path.clone();
            let origin_sid_owned = origin_sid.to_owned();
            tokio::spawn(async move {
                let quiescer = coord.quiescer.lock().clone();
                let quiesced = match quiescer {
                    Some(q) => q
                        .quiesce_task_threads(
                            task_for_quiesce,
                            TaskStatus::Completed,
                            Some(origin_sid_owned),
                        )
                        .await
                        .is_ok(),
                    None => true,
                };
                if quiesced {
                    let _ = TaskCoordinator::run_with_pending_terminal_bypass(
                        task_id_owned.clone(),
                        || async {
                            coord
                                .run_task_mutation(&task_id_owned, || async {
                                    let latest = coord.require_task(&task_id_owned, &ws_owned)?;
                                    if is_terminal_task(&latest)
                                        || latest.status != TaskStatus::AwaitingReview
                                    {
                                        return Ok(latest);
                                    }
                                    coord
                                        .accept_task_commit_now(
                                            &latest.id,
                                            &latest.workspace_path,
                                            latest.revision,
                                            None,
                                            directive_commit,
                                        )
                                        .await
                                })
                                .await
                        },
                    )
                    .await;
                }
                pending_guard.release();
            });
            return Ok(current);
        }

        self.accept_task_commit_now(
            &current.id,
            &current.workspace_path,
            expected_revision,
            session_id,
            directive_commit,
        )
        .await
    }

    async fn accept_task_commit_now(
        &self,
        task_id: &str,
        workspace_path: &str,
        expected_revision: i64,
        session_id: Option<&str>,
        directive_commit: Option<TaskDirectiveCommitHooks>,
    ) -> Result<TaskRecord, TaskCoordinatorError> {
        let current = self.require_task(task_id, workspace_path)?;
        assert_expected_task_revision(&current, expected_revision)?;
        if current.status != TaskStatus::AwaitingReview {
            return Err(TaskCoordinatorError::InvalidRequest(
                "Task must be awaiting review before it can be accepted".to_owned(),
            ));
        }

        let reviewed_material = match self.require_completion_review_eligibility(&current).await {
            Ok(Some(mat)) => {
                if let Err(err) = self
                    .assert_live_artifact_evidence_unchanged(&current, &mat)
                    .await
                {
                    self.return_task_to_working_after_stale_acceptance(&current, &err, session_id)
                        .await;
                    return Err(err);
                }
                Some(mat)
            }
            Ok(None) => None,
            Err(err) => {
                self.return_task_to_working_after_stale_acceptance(&current, &err, session_id)
                    .await;
                return Err(err);
            }
        };

        let mut terminal_guard = self
            .prepare_terminal_task_write(
                &current,
                TaskStatus::Completed,
                session_id.map(str::to_owned),
            )
            .await?;

        let result = if let Some(mat) = reviewed_material {
            self.session_db
                .accept_all_task_artifact_versions_validated(
                    current.id.clone(),
                    expected_revision,
                    now_iso(),
                    |accepted_task| async move {
                        self.assert_live_artifact_evidence_unchanged(&accepted_task, &mat)
                            .await
                            .map_err(|e| StorageError::Task(e.to_string()))
                    },
                    directive_commit,
                )
                .await
        } else {
            self.session_db
                .accept_all_task_artifact_versions(
                    current.id.clone(),
                    expected_revision,
                    now_iso(),
                    directive_commit,
                )
                .await
        };

        terminal_guard.release();
        match result {
            Ok(task) => {
                self.continuation_attempts.remove(&task.id);
                self.notify_updated(&task);
                Ok(task)
            }
            Err(err) => {
                let tc_err = TaskCoordinatorError::from(err);
                self.return_task_to_working_after_stale_acceptance(&current, &tc_err, session_id)
                    .await;
                Err(tc_err)
            }
        }
    }

    pub async fn request_changes(
        &self,
        task_id: &str,
        workspace_path: &str,
        expected_revision: i64,
        feedback: &str,
    ) -> Result<TaskRecord, TaskCoordinatorError> {
        self.run_task_mutation(task_id, || async {
            let task = self.require_task(task_id, workspace_path)?;
            assert_expected_task_revision(&task, expected_revision)?;
            if task.status != TaskStatus::AwaitingReview {
                return Err(TaskCoordinatorError::InvalidRequest(
                    "Task must be awaiting review before changes can be requested".to_owned(),
                ));
            }
            self.transition_locked(
                &task.id,
                &task.workspace_path,
                expected_revision,
                TaskStatus::Working,
                "Changes requested",
                Some(feedback),
                None,
            )
            .await
        })
        .await
    }

    pub async fn reopen_task(
        &self,
        task_id: &str,
        workspace_path: &str,
        expected_revision: i64,
        reason: Option<&str>,
    ) -> Result<TaskRecord, TaskCoordinatorError> {
        self.run_task_mutation(task_id, || async {
            let task = self.require_task(task_id, workspace_path)?;
            assert_expected_task_revision(&task, expected_revision)?;
            if task.status != TaskStatus::Completed && task.status != TaskStatus::Cancelled {
                return Err(TaskCoordinatorError::InvalidRequest(
                    "Only completed or cancelled tasks can be reopened".to_owned(),
                ));
            }
            self.recover_terminal_task(&task, expected_revision, "Task reopened", reason, None)
                .await
        })
        .await
    }

    pub async fn retry_task(
        &self,
        task_id: &str,
        workspace_path: &str,
        expected_revision: i64,
    ) -> Result<(TaskRecord, TaskQuestionResumeStatus), TaskCoordinatorError> {
        let (orig_task, recovered, attempt) = self
            .run_task_mutation(task_id, || async {
                let task = self.require_task(task_id, workspace_path)?;
                assert_expected_task_revision(&task, expected_revision)?;
                if task.status != TaskStatus::Failed {
                    return Err(TaskCoordinatorError::InvalidRequest(
                        "Only failed tasks can be retried".to_owned(),
                    ));
                }
                let primary = task.threads.first().cloned().ok_or_else(|| {
                    TaskCoordinatorError::InvalidRequest(
                        "Task has no primary thread to retry".to_owned(),
                    )
                })?;
                let rec = self
                    .recover_terminal_task(
                        &task,
                        task.revision,
                        "Task retry started",
                        None,
                        Some(&primary.session_id),
                    )
                    .await?;
                let att = if rec.status == TaskStatus::Working {
                    Some(self.prepare_continuation_attempt(&task.id))
                } else {
                    None
                };
                Ok((task, rec, att))
            })
            .await?;

        let Some(att) = attempt else {
            return Ok((recovered, TaskQuestionResumeStatus::Failed));
        };
        let prompt = build_task_retry_prompt(&orig_task);
        let display_text = format!("Retry task: {}", orig_task.title);
        let retry_status = self
            .dispatch_continuation(&recovered, att, prompt, display_text, false)
            .await;
        let refreshed = self.require_task(&orig_task.id, &orig_task.workspace_path)?;
        Ok((refreshed, retry_status))
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn transition(
        &self,
        task_id: &str,
        workspace_path: &str,
        expected_revision: i64,
        status: TaskStatus,
        summary: &str,
        detail: Option<&str>,
        session_id: Option<&str>,
    ) -> Result<TaskRecord, TaskCoordinatorError> {
        self.run_task_mutation(task_id, || async {
            self.transition_locked(
                task_id,
                workspace_path,
                expected_revision,
                status,
                summary,
                detail,
                session_id,
            )
            .await
        })
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn transition_locked(
        &self,
        task_id: &str,
        workspace_path: &str,
        expected_revision: i64,
        status: TaskStatus,
        summary: &str,
        detail: Option<&str>,
        session_id: Option<&str>,
    ) -> Result<TaskRecord, TaskCoordinatorError> {
        let task = self.require_task(task_id, workspace_path)?;
        assert_expected_task_revision(&task, expected_revision)?;
        if status == TaskStatus::Completed && task.status == TaskStatus::AwaitingReview {
            return self
                .accept_task_commit_now(
                    &task.id,
                    &task.workspace_path,
                    expected_revision,
                    session_id,
                    None,
                )
                .await;
        }
        if !is_valid_task_transition(task.status, status) {
            return Err(TaskCoordinatorError::InvalidRequest(format!(
                "Invalid task transition: {} -> {}",
                task.status.as_str(),
                status.as_str()
            )));
        }
        if status == TaskStatus::Working && self.has_blocking_state(&task) {
            return Err(TaskCoordinatorError::InvalidRequest(
                "Task cannot return to working while blocking input or issues remain".to_owned(),
            ));
        }

        let thread_id = session_id.and_then(|sid| {
            task.threads
                .iter()
                .find(|t| t.session_id == sid)
                .map(|t| t.id.clone())
        });
        let mut terminal_guard = if is_terminal_task_status(status) {
            Some(
                self.prepare_terminal_task_write(&task, status, session_id.map(str::to_owned))
                    .await?,
            )
        } else {
            None
        };

        let res = self
            .session_db
            .set_task_status(SetTaskStatusInput {
                task_id: task.id.clone(),
                expected_revision,
                status,
                summary: non_empty(summary, "Status summary")?,
                detail: detail
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned),
                updated_at: now_iso(),
                thread_id,
            })
            .await;

        if let Some(ref mut g) = terminal_guard {
            g.release();
        }
        let updated = res?;
        if is_terminal_task_status(updated.status) {
            self.continuation_attempts.remove(&task.id);
        }
        self.notify_updated(&updated);
        Ok(updated)
    }

    async fn recover_terminal_task(
        &self,
        task: &TaskRecord,
        expected_revision: i64,
        summary: &str,
        detail: Option<&str>,
        session_id: Option<&str>,
    ) -> Result<TaskRecord, TaskCoordinatorError> {
        if !is_terminal_task_status(task.status) {
            return Err(TaskCoordinatorError::InvalidRequest(format!(
                "Task {} is not terminal",
                task.id
            )));
        }
        assert_expected_task_revision(task, expected_revision)?;
        let recovery_status = if self.has_blocking_state(task) {
            TaskStatus::Blocked
        } else {
            TaskStatus::Working
        };
        let thread_id = session_id.and_then(|sid| {
            task.threads
                .iter()
                .find(|t| t.session_id == sid)
                .map(|t| t.id.clone())
        });
        let updated = self
            .session_db
            .set_task_status(SetTaskStatusInput {
                task_id: task.id.clone(),
                expected_revision,
                status: recovery_status,
                summary: non_empty(summary, "Status summary")?,
                detail: detail
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned),
                updated_at: now_iso(),
                thread_id,
            })
            .await?;
        self.continuation_attempts.remove(&task.id);
        self.notify_updated(&updated);
        Ok(updated)
    }

    pub async fn reconcile_failed_runs(
        &self,
        workspace_path: Option<&str>,
    ) -> Result<usize, TaskCoordinatorError> {
        let mut reconciled = 0usize;
        for summary in self.list(workspace_path)? {
            if summary.status != TaskStatus::Working && summary.status != TaskStatus::Planning {
                continue;
            }
            let Some(task) = self.session_db.get_task(&summary.id)? else {
                continue;
            };
            let Some(primary) = task.threads.first() else {
                continue;
            };
            let Some(sess) = self.session_db.get_session_record(&primary.session_id)? else {
                continue;
            };
            if sess.execution_state != Some(AgentExecutionState::Errored) {
                continue;
            }
            if let Ok(Some(failed)) = self
                .fail_primary_task_run(
                    &primary.session_id,
                    Some("The persisted primary task run ended with an error"),
                    None,
                )
                .await
                && failed.status == TaskStatus::Failed
            {
                reconciled += 1;
            }
        }
        Ok(reconciled)
    }

    async fn fail_primary_task_run(
        &self,
        session_id: &str,
        failure_msg: Option<&str>,
        continuation_attempt: Option<u64>,
    ) -> Result<Option<TaskRecord>, TaskCoordinatorError> {
        let Some(known_task) = self.session_db.get_task_for_thread(session_id)? else {
            return Ok(None);
        };
        let task_id = known_task.id.clone();
        self.run_task_mutation(&task_id, || async {
            if let Some(att) = continuation_attempt
                && !self.is_current_continuation_attempt(&task_id, att)
            {
                return Ok(None);
            }
            let Some(task) = self.session_db.get_task(&task_id)? else {
                return Ok(None);
            };
            if task.threads.first().map(|t| t.session_id.as_str()) != Some(session_id) {
                return Ok(None);
            }
            if task.status == TaskStatus::Failed {
                return Ok(Some(task));
            }
            if task.status != TaskStatus::Working && task.status != TaskStatus::Planning {
                return Ok(None);
            }
            let detail = failure_msg.unwrap_or("The primary task run ended with an error");
            match self
                .transition_locked(
                    &task.id,
                    &task.workspace_path,
                    task.revision,
                    TaskStatus::Failed,
                    "Task run failed",
                    Some(detail),
                    Some(session_id),
                )
                .await
            {
                Ok(t) => Ok(Some(t)),
                Err(e) => {
                    if let Ok(Some(cur)) = self.session_db.get_task(&task.id)
                        && cur.status == TaskStatus::Failed
                    {
                        return Ok(Some(cur));
                    }
                    Err(e)
                }
            }
        })
        .await
    }

    // =========================================================================
    // Checkpoints & Directives (`taskUpdate` / `reviewTask`)
    // =========================================================================

    pub async fn checkpoint_thread(
        &self,
        session_id: &str,
        reason: &str,
        agent_summary: &str,
        allow_terminal: bool,
    ) -> Result<Option<TaskRecord>, TaskCoordinatorError> {
        let Some(task) = self.get_for_thread(session_id)? else {
            return Ok(None);
        };
        let task_id = task.id.clone();
        self.run_task_mutation(&task_id, || async {
            self.checkpoint_thread_locked(session_id, reason, agent_summary, allow_terminal)
                .await
        })
        .await
    }

    async fn checkpoint_thread_locked(
        &self,
        session_id: &str,
        reason: &str,
        agent_summary: &str,
        allow_terminal: bool,
    ) -> Result<Option<TaskRecord>, TaskCoordinatorError> {
        let Some(task) = self.get_for_thread(session_id)? else {
            return Ok(None);
        };
        if !allow_terminal && is_terminal_task(&task) {
            return Ok(Some(task));
        }
        let thread_id = task
            .threads
            .iter()
            .find(|t| t.session_id == session_id)
            .map(|t| t.id.clone());
        let checkpoint = Self::build_task_checkpoint(&task, thread_id, reason, agent_summary)?;
        match self
            .session_db
            .create_task_checkpoint(checkpoint, !allow_terminal)
            .await
        {
            Ok(cp) => {
                self.notify_checkpoint(&task, &cp);
                Ok(self.session_db.get_task(&task.id)?)
            }
            Err(err) => {
                let tc_err = TaskCoordinatorError::from(err);
                if is_terminal_task_mutation_error(&task.id, &tc_err) {
                    return Ok(self.session_db.get_task(&task.id)?);
                }
                Err(tc_err)
            }
        }
    }

    fn build_task_checkpoint(
        task: &TaskRecord,
        thread_id: Option<String>,
        reason: &str,
        agent_summary: &str,
    ) -> Result<TaskCheckpoint, TaskCoordinatorError> {
        let digest = json!({
            "objective": task.objective,
            "status": task.status,
            "workItems": task.work_items.iter().map(|i| json!({
                "id": i.id,
                "title": i.title,
                "status": i.status,
            })).collect::<Vec<_>>(),
            "decisions": task.decisions.iter().filter(|d| d.status == "active").map(|d| json!({
                "question": d.question,
                "resolution": d.resolution,
            })).collect::<Vec<_>>(),
            "questions": task.questions.iter().filter(|q| q.status == TaskQuestionStatus::Pending).map(|q| json!({
                "question": q.question,
                "blocking": q.blocking,
            })).collect::<Vec<_>>(),
            "blockers": task.blockers.iter().filter(|b| b.status == "active").map(|b| &b.description).collect::<Vec<_>>(),
        })
        .to_string();

        Ok(TaskCheckpoint {
            id: Uuid::new_v4().to_string(),
            task_id: task.id.clone(),
            thread_id,
            task_revision: task.revision,
            reason: non_empty(reason, "Checkpoint reason")?,
            agent_summary: agent_summary.to_owned(),
            context_digest: digest,
            task_snapshot: task_snapshot(task),
            artifact_manifest: task
                .artifacts
                .iter()
                .map(|a| TaskCheckpointArtifactEntry {
                    id: a.id.clone(),
                    path: a.path.clone(),
                    title: a.title.clone(),
                    kind: a.kind.clone(),
                })
                .collect(),
            created_at: now_iso(),
        })
    }

    pub async fn apply_directive(
        &self,
        session_id: &str,
        directive: TaskDirective,
    ) -> Result<TaskDirectiveResult, TaskCoordinatorError> {
        let task = self.get_for_thread(session_id)?.ok_or_else(|| {
            TaskCoordinatorError::InvalidRequest(
                "Task directives are available only in task threads".to_owned(),
            )
        })?;
        let task_id = task.id.clone();
        self.run_task_mutation(&task_id, || async {
            self.apply_directive_locked(session_id, directive).await
        })
        .await
    }

    async fn apply_directive_locked(
        &self,
        session_id: &str,
        directive: TaskDirective,
    ) -> Result<TaskDirectiveResult, TaskCoordinatorError> {
        let current = self.get_for_thread(session_id)?.ok_or_else(|| {
            TaskCoordinatorError::InvalidRequest(
                "Task directives are available only in task threads".to_owned(),
            )
        })?;
        let idem_key = non_empty(directive.idempotency_key(), "Idempotency key")?;
        if self
            .session_db
            .get_task_directive_receipt(&current.id, &idem_key)?
            .is_some()
        {
            let replay = self.require_task(&current.id, &current.workspace_path)?;
            let reviews = self.session_db.list_task_reviews(&current.id)?;
            let cont = if current
                .questions
                .iter()
                .any(|q| q.status == TaskQuestionStatus::Pending && q.blocking)
            {
                TaskDirectiveContinuation::PauseForInput
            } else {
                TaskDirectiveContinuation::Continue
            };
            return Ok(TaskDirectiveResult {
                task: replay,
                reviews: Some(reviews),
                continuation: cont,
            });
        }

        assert_task_accepts_mutation(&current, false)?;
        let thread = current
            .threads
            .iter()
            .find(|t| t.session_id == session_id)
            .cloned();
        let require_thread = || -> Result<TaskThread, TaskCoordinatorError> {
            thread.clone().ok_or_else(|| {
                TaskCoordinatorError::InvalidRequest(format!(
                    "Unknown task thread for session: {session_id}"
                ))
            })
        };

        let directive_type_name = directive.directive_type_name();
        let mut continuation = TaskDirectiveContinuation::Continue;
        let updated = match directive {
            TaskDirective::UpdatePlan {
                expected_revision,
                objective,
                requirements,
                work_items,
                ..
            } => {
                let t = require_thread()?;
                let rep_items: Vec<ReplacementWorkItemInput> = work_items
                    .into_iter()
                    .map(|w| ReplacementWorkItemInput {
                        id: w.id,
                        title: w.title,
                        description: w.description,
                        status: w.status,
                        depends_on: w.depends_on,
                        expected_outputs: w.expected_outputs,
                    })
                    .collect();
                let mut u = self
                    .update_plan_locked(
                        &current.id,
                        &current.workspace_path,
                        expected_revision,
                        objective.as_deref(),
                        requirements.as_deref(),
                        &rep_items,
                        Some(&t.id),
                    )
                    .await?;
                if u.status == TaskStatus::Draft {
                    u = self
                        .transition_locked(
                            &current.id,
                            &current.workspace_path,
                            u.revision,
                            TaskStatus::Planning,
                            "Task plan created",
                            None,
                            Some(session_id),
                        )
                        .await?;
                }
                if u.status == TaskStatus::Planning && !u.work_items.is_empty() {
                    u = self
                        .transition_locked(
                            &current.id,
                            &current.workspace_path,
                            u.revision,
                            TaskStatus::Working,
                            "Task execution started",
                            None,
                            Some(session_id),
                        )
                        .await?;
                }
                u
            }
            TaskDirective::MarkWorkItem {
                expected_revision,
                work_item_id,
                status,
                completion_evidence,
                ..
            } => {
                let t = require_thread()?;
                self.mark_work_item_locked(
                    &current.id,
                    &current.workspace_path,
                    &work_item_id,
                    expected_revision,
                    status,
                    completion_evidence.as_deref(),
                    Some(&t.id),
                )
                .await?
            }
            TaskDirective::RecordDecision {
                expected_revision,
                question,
                resolution,
                confidence,
                scope,
                supersedes,
                ..
            } => {
                self.record_decision_locked(
                    &current.id,
                    &current.workspace_path,
                    expected_revision,
                    &question,
                    &resolution,
                    "agent",
                    scope.as_deref(),
                    confidence,
                    supersedes.as_deref(),
                )
                .await?
            }
            TaskDirective::ReportProgress {
                summary,
                detail,
                work_item_id,
                ..
            } => {
                self.report_progress_locked(
                    &current.id,
                    &current.workspace_path,
                    Some(session_id),
                    &summary,
                    detail.as_deref(),
                    work_item_id.as_deref(),
                )
                .await?
            }
            TaskDirective::ReportBlocker {
                expected_revision,
                description,
                blocking,
                work_item_id,
                ..
            } => {
                self.report_blocker_locked(
                    &current.id,
                    &current.workspace_path,
                    expected_revision,
                    &description,
                    blocking,
                    work_item_id.as_deref(),
                )
                .await?
            }
            TaskDirective::RequestInput {
                expected_revision,
                questions,
                ..
            } => {
                let (u, cont) = self
                    .request_input_locked(
                        &current.id,
                        &current.workspace_path,
                        expected_revision,
                        session_id,
                        &questions,
                    )
                    .await?;
                continuation = cont;
                u
            }
            TaskDirective::RegisterArtifact {
                expected_revision,
                path,
                title,
                kind,
                artifact_id,
                base_version_id,
                change_summary,
                work_item_id,
                provenance,
                ..
            } => {
                self.register_artifact_locked(RegisterArtifactRequest {
                    task_id: current.id.clone(),
                    workspace_path: current.workspace_path.clone(),
                    expected_revision,
                    session_id: Some(session_id.to_owned()),
                    path,
                    title,
                    kind,
                    artifact_id,
                    base_version_id,
                    change_summary,
                    work_item_id,
                    provenance,
                })
                .await?
            }
            TaskDirective::RecordReview {
                expected_revision,
                expected_material_fingerprint,
                reviewer_agent_id,
                reviewer_provider,
                reviewer_model,
                verdict,
                feedback,
                ..
            } => {
                let (u, _, _) = self
                    .record_review_locked(
                        &current.id,
                        &current.workspace_path,
                        Some(session_id),
                        expected_revision,
                        expected_material_fingerprint.as_deref(),
                        &reviewer_agent_id,
                        &reviewer_provider,
                        &reviewer_model,
                        verdict,
                        &feedback,
                    )
                    .await?;
                u
            }
            TaskDirective::AddressReview {
                expected_revision,
                review_id,
                implementation_summary,
                ..
            } => {
                self.address_review_locked(
                    &current.id,
                    &current.workspace_path,
                    Some(session_id),
                    expected_revision,
                    &review_id,
                    &implementation_summary,
                )
                .await?
            }
            TaskDirective::ProposeCompletion {
                expected_revision,
                summary,
                caveats,
                ..
            } => {
                let commit_hooks = if !current.review_required {
                    let idem_for_hook = idem_key.clone();
                    let sid_for_hook = session_id.to_owned();
                    let coord_weak_notify = self.self_weak.clone();
                    Some(TaskDirectiveCommitHooks {
                        create: Box::new(move |committed_task: &TaskRecord| {
                            let tid = committed_task
                                .threads
                                .iter()
                                .find(|t| t.session_id == sid_for_hook)
                                .map(|t| t.id.clone());
                            let cp = Self::build_task_checkpoint(
                                committed_task,
                                tid,
                                &format!("directive {directive_type_name}"),
                                "",
                            )
                            .expect("non-empty directive checkpoint reason");
                            TaskDirectiveCommitPayload {
                                idempotency_key: idem_for_hook,
                                receipt_created_at: now_iso(),
                                checkpoint: cp,
                            }
                        }),
                        on_committed: Some(Box::new(move |committed_task, cp| {
                            if let (Some(c), Some(checkpoint)) = (coord_weak_notify.upgrade(), cp) {
                                c.notify_checkpoint(committed_task, checkpoint);
                            }
                        })),
                    })
                } else {
                    None
                };
                let res = self
                    .propose_completion_locked(
                        &current.id,
                        &current.workspace_path,
                        expected_revision,
                        &summary,
                        caveats.as_deref(),
                        Some(session_id),
                        None,
                        true,
                        commit_hooks,
                        false,
                    )
                    .await?;
                if !current.review_required && res.status == TaskStatus::AwaitingReview {
                    let reviews = self.session_db.list_task_reviews(&current.id)?;
                    return Ok(TaskDirectiveResult {
                        task: res,
                        reviews: Some(reviews),
                        continuation,
                    });
                }
                res
            }
            TaskDirective::CreateThread {
                expected_revision,
                title,
                work_item_id,
                ..
            } => {
                self.add_thread_locked(
                    &current.id,
                    &current.workspace_path,
                    &title,
                    expected_revision,
                    "coordinator",
                    Some(&work_item_id),
                    None,
                    None,
                )
                .await?
            }
        };

        self.session_db
            .record_task_directive_receipt(
                current.id.clone(),
                idem_key,
                updated.revision,
                now_iso(),
            )
            .await?;
        let _ = self
            .checkpoint_thread_locked(
                session_id,
                &format!("directive {directive_type_name}"),
                "",
                true,
            )
            .await?;

        let latest = self.require_task(&current.id, &current.workspace_path)?;
        let reviews = self.session_db.list_task_reviews(&current.id)?;
        Ok(TaskDirectiveResult {
            task: latest,
            reviews: Some(reviews),
            continuation,
        })
    }

    // =========================================================================
    // Internal validation & notification helpers
    // =========================================================================

    fn require_task(
        &self,
        task_id: &str,
        workspace_path: &str,
    ) -> Result<TaskRecord, TaskCoordinatorError> {
        let task = self.session_db.get_task(task_id)?.ok_or_else(|| {
            TaskCoordinatorError::InvalidRequest(format!("Unknown task: {task_id}"))
        })?;
        assert_workspace(&task, workspace_path)?;
        Ok(task)
    }

    fn require_artifact_detail(
        &self,
        task_id: &str,
        workspace_path: &str,
        artifact_id: &str,
    ) -> Result<TaskArtifactDetail, TaskCoordinatorError> {
        self.require_task(task_id, workspace_path)?;
        self.session_db
            .get_task_artifact_detail(task_id, artifact_id)?
            .ok_or_else(|| {
                TaskCoordinatorError::InvalidRequest(format!(
                    "Unknown task artifact: {artifact_id}"
                ))
            })
    }

    fn has_blocking_state(&self, task: &TaskRecord) -> bool {
        task.blockers
            .iter()
            .any(|b| b.status == "active" && b.blocking)
            || task
                .questions
                .iter()
                .any(|q| q.status == TaskQuestionStatus::Pending && q.blocking)
    }

    fn has_active_artifact_revision(
        &self,
        task: &TaskRecord,
    ) -> Result<bool, TaskCoordinatorError> {
        for a in &task.artifacts {
            if let Some(detail) = self.session_db.get_task_artifact_detail(&task.id, &a.id)?
                && detail.active_revision.is_some()
            {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn has_expected_artifact_output(
        &self,
        task: &TaskRecord,
        item: &WorkItem,
    ) -> Result<bool, TaskCoordinatorError> {
        if task
            .artifacts
            .iter()
            .any(|a| a.work_item_id.as_deref() == Some(item.id.as_str()))
        {
            return Ok(true);
        }
        let rev_paths: BTreeSet<String> = self
            .session_db
            .list_task_artifact_revision_output_paths_for_work_item(&task.id, &item.id)?
            .into_iter()
            .collect();
        let outputs_match = !item.expected_outputs.is_empty()
            && item
                .expected_outputs
                .iter()
                .all(|exp| rev_paths.contains(exp));
        if outputs_match
            && self
                .session_db
                .has_completed_task_artifact_revision_for_work_item(&task.id, &item.id)?
        {
            return Ok(true);
        }
        if item.status == WorkItemStatus::Abandoned
            && outputs_match
            && self
                .session_db
                .has_cancelled_task_artifact_revision_for_work_item(&task.id, &item.id)?
        {
            return Ok(true);
        }
        Ok(false)
    }

    fn assert_completion_readiness(&self, task: &TaskRecord) -> Result<(), TaskCoordinatorError> {
        if task
            .questions
            .iter()
            .any(|q| q.status == TaskQuestionStatus::Pending && q.blocking)
        {
            return Err(TaskCoordinatorError::InvalidRequest(
                "Task has unresolved blocking questions".to_owned(),
            ));
        }
        if task
            .questions
            .iter()
            .any(|q| q.status == TaskQuestionStatus::Pending)
        {
            return Err(TaskCoordinatorError::InvalidRequest(
                "Task has unresolved pending questions".to_owned(),
            ));
        }
        if task.work_items.is_empty() {
            return Err(TaskCoordinatorError::InvalidRequest(
                "Task has no work plan".to_owned(),
            ));
        }
        let unfinished = task
            .work_items
            .iter()
            .filter(|w| {
                !matches!(
                    w.status,
                    WorkItemStatus::Done | WorkItemStatus::Review | WorkItemStatus::Abandoned
                )
            })
            .count();
        if unfinished > 0 {
            return Err(TaskCoordinatorError::InvalidRequest(format!(
                "Task has {unfinished} unfinished work item(s)"
            )));
        }
        if task
            .blockers
            .iter()
            .any(|b| b.status == "active" && b.blocking)
        {
            return Err(TaskCoordinatorError::InvalidRequest(
                "Task has unresolved blocking issues".to_owned(),
            ));
        }
        for item in &task.work_items {
            if !item.expected_outputs.is_empty()
                && !self.has_expected_artifact_output(task, item)?
            {
                return Err(TaskCoordinatorError::InvalidRequest(format!(
                    "Expected artifact is not registered for: {}",
                    item.title
                )));
            }
        }
        Ok(())
    }

    async fn validate_completion_proposal_task(
        &self,
        task: &TaskRecord,
    ) -> Result<Option<TaskReviewMaterial>, TaskCoordinatorError> {
        self.assert_completion_readiness(task)?;
        let current_mat = self.require_completion_review_eligibility(task).await?;
        if let Some(ref mat) = current_mat {
            let next_mat = self.current_review_material(task).await?;
            if next_mat.fingerprint != mat.fingerprint {
                return Err(TaskCoordinatorError::InvalidRequest(
                    "Task requires a fresh passing review for the current delivery state before completion".to_owned(),
                ));
            }
        }
        Ok(current_mat)
    }

    async fn require_completion_review_eligibility(
        &self,
        task: &TaskRecord,
    ) -> Result<Option<TaskReviewMaterial>, TaskCoordinatorError> {
        if task.review_rounds <= 0 {
            return Ok(None);
        }
        let reviews = self.session_db.list_task_reviews(&task.id)?;
        let rounds = get_task_review_rounds_from_records(&reviews);
        let material = self.current_review_material(task).await?;
        let current_passes = rounds
            .iter()
            .filter(|r| {
                r.verdict == TaskReviewVerdict::Pass
                    && r.material_fingerprint.as_deref() == Some(material.fingerprint.as_str())
            })
            .count() as i64;
        if let Some(pending) = get_pending_task_review(&rounds) {
            return Err(TaskCoordinatorError::InvalidRequest(format!(
                "Review round {} feedback must be addressed",
                pending.round
            )));
        }
        if current_passes < task.review_rounds {
            return Err(TaskCoordinatorError::InvalidRequest(format!(
                "Task requires {} independent review round(s) with fresh passing reviews for the current delivery state; {current_passes} recorded",
                task.review_rounds
            )));
        }
        let latest_ok = rounds.last().is_some_and(|r| {
            r.verdict == TaskReviewVerdict::Pass
                && r.material_fingerprint.as_deref() == Some(material.fingerprint.as_str())
        });
        if !latest_ok {
            return Err(TaskCoordinatorError::InvalidRequest(
                "Task requires a fresh passing review for the current delivery state before completion".to_owned(),
            ));
        }
        Ok(Some(material))
    }

    async fn return_task_to_working_after_stale_acceptance(
        &self,
        task: &TaskRecord,
        err: &TaskCoordinatorError,
        session_id: Option<&str>,
    ) {
        let Ok(Some(latest)) = self.session_db.get_task(&task.id) else {
            return;
        };
        if latest.status != TaskStatus::AwaitingReview || self.has_blocking_state(&latest) {
            return;
        }
        let thread_id = session_id.and_then(|sid| {
            latest
                .threads
                .iter()
                .find(|t| t.session_id == sid)
                .map(|t| t.id.clone())
        });
        if let Ok(updated) = self
            .session_db
            .set_task_status(SetTaskStatusInput {
                task_id: latest.id,
                expected_revision: latest.revision,
                status: TaskStatus::Working,
                summary: "Task review material changed before acceptance".to_owned(),
                detail: Some(err.to_string()),
                updated_at: now_iso(),
                thread_id,
            })
            .await
        {
            self.notify_updated(&updated);
        }
    }

    async fn assert_live_artifact_evidence_unchanged(
        &self,
        task: &TaskRecord,
        reviewed_material: &TaskReviewMaterial,
    ) -> Result<(), TaskCoordinatorError> {
        let current_mat = self.current_review_material(task).await?;
        let cur_ev = live_artifact_evidence(&current_mat)?;
        let rev_ev = live_artifact_evidence(reviewed_material)?;
        if stable_stringify(&cur_ev) != stable_stringify(&rev_ev) {
            return Err(TaskCoordinatorError::InvalidRequest(
                "Task requires a fresh passing review for the current delivery state before completion".to_owned(),
            ));
        }
        Ok(())
    }

    async fn current_review_material(
        &self,
        task: &TaskRecord,
    ) -> Result<TaskReviewMaterial, TaskCoordinatorError> {
        let mut artifact_details = Vec::with_capacity(task.artifacts.len());
        for a in &task.artifacts {
            let detail = self
                .session_db
                .get_task_artifact_detail(&task.id, &a.id)?
                .ok_or_else(|| {
                    TaskCoordinatorError::InvalidRequest(format!(
                        "Artifact metadata is missing: {}",
                        a.id
                    ))
                })?;
            artifact_details.push(detail);
        }
        let ws_root = std::fs::canonicalize(&task.workspace_path).map_err(|_| {
            TaskCoordinatorError::InvalidRequest("Task workspace does not exist".to_owned())
        })?;
        let mut artifact_files = Vec::with_capacity(task.artifacts.len());
        for a in &task.artifacts {
            let resolved_path = self.resolve_artifact_path(task, &a.path)?;
            let fp = self
                .artifact_store
                .fingerprint_file(resolved_path.clone())
                .await?
                .ok_or_else(|| {
                    TaskCoordinatorError::InvalidRequest(format!(
                        "Artifact does not exist: {}",
                        resolved_path.display()
                    ))
                })?;
            let rel = resolved_path
                .strip_prefix(&ws_root)
                .unwrap_or(&resolved_path)
                .to_string_lossy()
                .replace('\\', "/");
            artifact_files.push(TaskReviewArtifactFileSnapshot {
                artifact_id: a.id.clone(),
                path: a.path.clone(),
                canonical_workspace_relative_path: rel,
                sha256: fp.sha256,
                size_bytes: fp.size_bytes,
            });
        }
        let snapshot =
            build_task_review_material_snapshot(task, &artifact_details, &artifact_files);
        let fingerprint = fingerprint_task_review_material(&snapshot);
        Ok(TaskReviewMaterial {
            snapshot,
            fingerprint,
        })
    }

    fn resolve_artifact_path(
        &self,
        task: &TaskRecord,
        artifact_path: &str,
    ) -> Result<PathBuf, TaskCoordinatorError> {
        let clean = non_empty(artifact_path, "Artifact path")?;
        let ws_canon = std::fs::canonicalize(&task.workspace_path).map_err(|_| {
            TaskCoordinatorError::InvalidRequest(
                "Artifact path is outside the task workspace".to_owned(),
            )
        })?;
        let candidate = if Path::new(&clean).is_absolute() {
            PathBuf::from(&clean)
        } else {
            Path::new(&task.workspace_path).join(&clean)
        };
        let meta = std::fs::metadata(&candidate).map_err(|_| {
            TaskCoordinatorError::InvalidRequest(format!(
                "Artifact does not exist: {}",
                candidate.display()
            ))
        })?;
        let resolved_canon = std::fs::canonicalize(&candidate).map_err(|_| {
            TaskCoordinatorError::InvalidRequest(
                "Artifact path is outside the task workspace".to_owned(),
            )
        })?;
        if !resolved_canon.starts_with(&ws_canon) {
            return Err(TaskCoordinatorError::InvalidRequest(
                "Artifact path is outside the task workspace".to_owned(),
            ));
        }
        if !meta.is_file() {
            return Err(TaskCoordinatorError::InvalidRequest(format!(
                "Artifact is not a file: {}",
                resolved_canon.display()
            )));
        }
        Ok(resolved_canon)
    }

    fn assert_expected_fingerprint(
        &self,
        artifact_id: &str,
        expected_sha256: Option<&str>,
        current_sha256: Option<&str>,
    ) -> Result<(), TaskCoordinatorError> {
        if let Some(exp) = expected_sha256
            && current_sha256 != Some(exp)
        {
            return Err(TaskCoordinatorError::ArtifactConflict {
                artifact_id: Some(artifact_id.to_owned()),
                expected_sha256: exp.to_owned(),
                current_sha256: current_sha256.map(str::to_owned),
            });
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn make_artifact_version(
        &self,
        artifact: &TaskArtifact,
        version: i64,
        parent_version_id: Option<String>,
        stored: &StoredArtifactBlob,
        media_type: String,
        created_by: &str,
        created_at: &str,
        change_summary: String,
        provenance: Map<String, Value>,
        review_status: TaskArtifactVersionReviewStatus,
    ) -> Result<TaskArtifactVersion, TaskCoordinatorError> {
        Ok(TaskArtifactVersion {
            id: Uuid::new_v4().to_string(),
            artifact_id: artifact.id.clone(),
            version,
            parent_version_id,
            sha256: stored.sha256.clone(),
            size_bytes: stored.size_bytes,
            media_type,
            created_by: non_empty(created_by, "Artifact version creator")?,
            created_at: created_at.to_owned(),
            change_summary,
            provenance,
            review_status,
        })
    }

    fn emit(&self, method: &'static str, params: Value) {
        if let Some(ref notify) = self.notify {
            (notify)(TaskNotification { method, params });
        }
    }

    fn notify_updated(&self, task: &TaskRecord) {
        self.emit(
            "task/updated",
            json!({
                "cwd": task.workspace_path,
                "task": task,
            }),
        );
    }

    fn notify_activity(&self, task: &TaskRecord) {
        if let Some(latest) = task.activity.first() {
            self.emit(
                "task/activity",
                json!({
                    "cwd": task.workspace_path,
                    "taskId": task.id,
                    "activity": latest,
                }),
            );
        }
    }

    fn notify_checkpoint(&self, task: &TaskRecord, checkpoint: &TaskCheckpoint) {
        self.emit(
            "task/checkpointCreated",
            json!({
                "cwd": task.workspace_path,
                "taskId": task.id,
                "checkpoint": checkpoint,
            }),
        );
    }
}
