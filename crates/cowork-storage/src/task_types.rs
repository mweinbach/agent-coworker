//! Durable Task Mode types matching `src/shared/tasks.ts` and `src/server/sessionDb/tasks.ts`.

use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::{Result, StorageError};

pub const DEFAULT_TASK_REVIEW_ROUNDS: i64 = 3;
pub const MAX_TASK_REVIEW_ROUNDS: i64 = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Draft,
    Planning,
    Working,
    Blocked,
    AwaitingReview,
    Completed,
    Failed,
    Cancelled,
}

impl TaskStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            TaskStatus::Draft => "draft",
            TaskStatus::Planning => "planning",
            TaskStatus::Working => "working",
            TaskStatus::Blocked => "blocked",
            TaskStatus::AwaitingReview => "awaiting_review",
            TaskStatus::Completed => "completed",
            TaskStatus::Failed => "failed",
            TaskStatus::Cancelled => "cancelled",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "draft" => Some(TaskStatus::Draft),
            "planning" => Some(TaskStatus::Planning),
            "working" => Some(TaskStatus::Working),
            "blocked" => Some(TaskStatus::Blocked),
            "awaiting_review" => Some(TaskStatus::AwaitingReview),
            "completed" => Some(TaskStatus::Completed),
            "failed" => Some(TaskStatus::Failed),
            "cancelled" => Some(TaskStatus::Cancelled),
            _ => None,
        }
    }

    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            TaskStatus::Completed | TaskStatus::Failed | TaskStatus::Cancelled
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkItemStatus {
    Queued,
    InProgress,
    Blocked,
    Review,
    Done,
    Abandoned,
}

impl WorkItemStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            WorkItemStatus::Queued => "queued",
            WorkItemStatus::InProgress => "in_progress",
            WorkItemStatus::Blocked => "blocked",
            WorkItemStatus::Review => "review",
            WorkItemStatus::Done => "done",
            WorkItemStatus::Abandoned => "abandoned",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "queued" => Some(WorkItemStatus::Queued),
            "in_progress" => Some(WorkItemStatus::InProgress),
            "blocked" => Some(WorkItemStatus::Blocked),
            "review" => Some(WorkItemStatus::Review),
            "done" => Some(WorkItemStatus::Done),
            "abandoned" => Some(WorkItemStatus::Abandoned),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskRequirementKind {
    Requirement,
    Constraint,
    AcceptanceCriterion,
}

impl TaskRequirementKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            TaskRequirementKind::Requirement => "requirement",
            TaskRequirementKind::Constraint => "constraint",
            TaskRequirementKind::AcceptanceCriterion => "acceptance_criterion",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "requirement" => Some(TaskRequirementKind::Requirement),
            "constraint" => Some(TaskRequirementKind::Constraint),
            "acceptance_criterion" => Some(TaskRequirementKind::AcceptanceCriterion),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskCreationOrigin {
    Manual,
    ChatTool,
}

impl TaskCreationOrigin {
    pub fn as_str(&self) -> &'static str {
        match self {
            TaskCreationOrigin::Manual => "manual",
            TaskCreationOrigin::ChatTool => "chat_tool",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "manual" => Some(TaskCreationOrigin::Manual),
            "chat_tool" => Some(TaskCreationOrigin::ChatTool),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskReviewVerdict {
    Pass,
    Partial,
    Fail,
}

impl TaskReviewVerdict {
    pub fn as_str(&self) -> &'static str {
        match self {
            TaskReviewVerdict::Pass => "pass",
            TaskReviewVerdict::Partial => "partial",
            TaskReviewVerdict::Fail => "fail",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "pass" => Some(TaskReviewVerdict::Pass),
            "partial" => Some(TaskReviewVerdict::Partial),
            "fail" => Some(TaskReviewVerdict::Fail),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskQuestionUrgency {
    Now,
    BeforeDelivery,
    Optional,
}

impl TaskQuestionUrgency {
    pub fn as_str(&self) -> &'static str {
        match self {
            TaskQuestionUrgency::Now => "now",
            TaskQuestionUrgency::BeforeDelivery => "before_delivery",
            TaskQuestionUrgency::Optional => "optional",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "now" => Some(TaskQuestionUrgency::Now),
            "before_delivery" => Some(TaskQuestionUrgency::BeforeDelivery),
            "optional" => Some(TaskQuestionUrgency::Optional),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskQuestionStatus {
    Pending,
    Answered,
    Defaulted,
    Superseded,
    Dismissed,
}

impl TaskQuestionStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            TaskQuestionStatus::Pending => "pending",
            TaskQuestionStatus::Answered => "answered",
            TaskQuestionStatus::Defaulted => "defaulted",
            TaskQuestionStatus::Superseded => "superseded",
            TaskQuestionStatus::Dismissed => "dismissed",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "pending" => Some(TaskQuestionStatus::Pending),
            "answered" => Some(TaskQuestionStatus::Answered),
            "defaulted" => Some(TaskQuestionStatus::Defaulted),
            "superseded" => Some(TaskQuestionStatus::Superseded),
            "dismissed" => Some(TaskQuestionStatus::Dismissed),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskArtifactVersionReviewStatus {
    Draft,
    Accepted,
    Superseded,
}

impl TaskArtifactVersionReviewStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            TaskArtifactVersionReviewStatus::Draft => "draft",
            TaskArtifactVersionReviewStatus::Accepted => "accepted",
            TaskArtifactVersionReviewStatus::Superseded => "superseded",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "draft" => Some(TaskArtifactVersionReviewStatus::Draft),
            "accepted" => Some(TaskArtifactVersionReviewStatus::Accepted),
            "superseded" => Some(TaskArtifactVersionReviewStatus::Superseded),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskArtifactRevisionStatus {
    Active,
    Completed,
    Cancelled,
    Error,
}

impl TaskArtifactRevisionStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            TaskArtifactRevisionStatus::Active => "active",
            TaskArtifactRevisionStatus::Completed => "completed",
            TaskArtifactRevisionStatus::Cancelled => "cancelled",
            TaskArtifactRevisionStatus::Error => "error",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "active" => Some(TaskArtifactRevisionStatus::Active),
            "completed" => Some(TaskArtifactRevisionStatus::Completed),
            "cancelled" => Some(TaskArtifactRevisionStatus::Cancelled),
            "error" => Some(TaskArtifactRevisionStatus::Error),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskActivityKind {
    TaskCreated,
    BriefUpdated,
    PlanUpdated,
    WorkItemUpdated,
    DecisionRecorded,
    ProgressReported,
    BlockerReported,
    BlockerResolved,
    InputRequested,
    InputResolved,
    InputDefaulted,
    InputResumeFailed,
    ArtifactRegistered,
    ArtifactVersionCaptured,
    ArtifactVersionRestored,
    ArtifactVersionAccepted,
    ArtifactRevisionStarted,
    ArtifactRevisionCompleted,
    ArtifactRevisionFailed,
    ReviewCompleted,
    ReviewAddressed,
    ThreadCreated,
    StatusChanged,
    CheckpointCreated,
}

impl TaskActivityKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            TaskActivityKind::TaskCreated => "task_created",
            TaskActivityKind::BriefUpdated => "brief_updated",
            TaskActivityKind::PlanUpdated => "plan_updated",
            TaskActivityKind::WorkItemUpdated => "work_item_updated",
            TaskActivityKind::DecisionRecorded => "decision_recorded",
            TaskActivityKind::ProgressReported => "progress_reported",
            TaskActivityKind::BlockerReported => "blocker_reported",
            TaskActivityKind::BlockerResolved => "blocker_resolved",
            TaskActivityKind::InputRequested => "input_requested",
            TaskActivityKind::InputResolved => "input_resolved",
            TaskActivityKind::InputDefaulted => "input_defaulted",
            TaskActivityKind::InputResumeFailed => "input_resume_failed",
            TaskActivityKind::ArtifactRegistered => "artifact_registered",
            TaskActivityKind::ArtifactVersionCaptured => "artifact_version_captured",
            TaskActivityKind::ArtifactVersionRestored => "artifact_version_restored",
            TaskActivityKind::ArtifactVersionAccepted => "artifact_version_accepted",
            TaskActivityKind::ArtifactRevisionStarted => "artifact_revision_started",
            TaskActivityKind::ArtifactRevisionCompleted => "artifact_revision_completed",
            TaskActivityKind::ArtifactRevisionFailed => "artifact_revision_failed",
            TaskActivityKind::ReviewCompleted => "review_completed",
            TaskActivityKind::ReviewAddressed => "review_addressed",
            TaskActivityKind::ThreadCreated => "thread_created",
            TaskActivityKind::StatusChanged => "status_changed",
            TaskActivityKind::CheckpointCreated => "checkpoint_created",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "task_created" => Some(TaskActivityKind::TaskCreated),
            "brief_updated" => Some(TaskActivityKind::BriefUpdated),
            "plan_updated" => Some(TaskActivityKind::PlanUpdated),
            "work_item_updated" => Some(TaskActivityKind::WorkItemUpdated),
            "decision_recorded" => Some(TaskActivityKind::DecisionRecorded),
            "progress_reported" => Some(TaskActivityKind::ProgressReported),
            "blocker_reported" => Some(TaskActivityKind::BlockerReported),
            "blocker_resolved" => Some(TaskActivityKind::BlockerResolved),
            "input_requested" => Some(TaskActivityKind::InputRequested),
            "input_resolved" => Some(TaskActivityKind::InputResolved),
            "input_defaulted" => Some(TaskActivityKind::InputDefaulted),
            "input_resume_failed" => Some(TaskActivityKind::InputResumeFailed),
            "artifact_registered" => Some(TaskActivityKind::ArtifactRegistered),
            "artifact_version_captured" => Some(TaskActivityKind::ArtifactVersionCaptured),
            "artifact_version_restored" => Some(TaskActivityKind::ArtifactVersionRestored),
            "artifact_version_accepted" => Some(TaskActivityKind::ArtifactVersionAccepted),
            "artifact_revision_started" => Some(TaskActivityKind::ArtifactRevisionStarted),
            "artifact_revision_completed" => Some(TaskActivityKind::ArtifactRevisionCompleted),
            "artifact_revision_failed" => Some(TaskActivityKind::ArtifactRevisionFailed),
            "review_completed" => Some(TaskActivityKind::ReviewCompleted),
            "review_addressed" => Some(TaskActivityKind::ReviewAddressed),
            "thread_created" => Some(TaskActivityKind::ThreadCreated),
            "status_changed" => Some(TaskActivityKind::StatusChanged),
            "checkpoint_created" => Some(TaskActivityKind::CheckpointCreated),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRequirement {
    pub id: String,
    pub kind: TaskRequirementKind,
    pub text: String,
    pub source: String,
    pub permanence: String,
    pub status: String,
    pub created_at: String,
    pub supersedes: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskThread {
    pub id: String,
    pub task_id: String,
    pub session_id: String,
    pub title: String,
    pub created_by: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkItem {
    pub id: String,
    pub task_id: String,
    pub title: String,
    pub description: String,
    pub status: WorkItemStatus,
    pub depends_on: Vec<String>,
    pub assigned_thread_id: Option<String>,
    pub claimed_by_thread_id: Option<String>,
    pub expected_outputs: Vec<String>,
    pub completion_evidence: Option<String>,
    pub position: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDecision {
    pub id: String,
    pub task_id: String,
    pub question: String,
    pub resolution: String,
    pub source: String,
    pub scope: String,
    pub confidence: Option<f64>,
    pub status: String,
    pub created_at: String,
    pub supersedes: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskQuestionOption {
    pub id: String,
    pub label: String,
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskQuestion {
    pub id: String,
    pub task_id: String,
    pub thread_id: Option<String>,
    pub work_item_id: Option<String>,
    pub header: String,
    pub question: String,
    pub context: String,
    pub blocking: bool,
    pub urgency: TaskQuestionUrgency,
    pub default_action: Option<String>,
    pub options: Vec<TaskQuestionOption>,
    pub recommended_option_id: Option<String>,
    pub status: TaskQuestionStatus,
    pub provisional_decision_id: Option<String>,
    pub answer: Option<String>,
    pub answer_option_id: Option<String>,
    pub resolution_source: Option<String>,
    pub supersedes: Option<String>,
    pub created_at: String,
    pub resolved_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskArtifact {
    pub id: String,
    pub task_id: String,
    pub work_item_id: Option<String>,
    pub thread_id: Option<String>,
    pub path: String,
    pub kind: String,
    pub title: String,
    pub created_by: String,
    pub provenance: Map<String, Value>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskArtifactVersion {
    pub id: String,
    pub artifact_id: String,
    pub version: i64,
    pub parent_version_id: Option<String>,
    pub sha256: String,
    pub size_bytes: u64,
    pub media_type: String,
    pub created_by: String,
    pub created_at: String,
    pub change_summary: String,
    pub provenance: Map<String, Value>,
    pub review_status: TaskArtifactVersionReviewStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskArtifactRevision {
    pub id: String,
    pub task_id: String,
    pub artifact_id: String,
    pub work_item_id: String,
    pub task_thread_id: String,
    pub session_id: String,
    pub base_version_id: String,
    pub prior_version_id: String,
    pub status: TaskArtifactRevisionStatus,
    pub instruction: String,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskArtifactDetail {
    pub artifact: TaskArtifact,
    pub versions: Vec<TaskArtifactVersion>,
    pub latest_version_id: Option<String>,
    pub accepted_version_id: Option<String>,
    pub active_revision: Option<TaskArtifactRevision>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskBlocker {
    pub id: String,
    pub task_id: String,
    pub work_item_id: Option<String>,
    pub description: String,
    pub blocking: bool,
    pub status: String,
    pub created_at: String,
    pub resolved_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskActivity {
    pub id: String,
    pub seq: i64,
    pub task_id: String,
    pub thread_id: Option<String>,
    pub work_item_id: Option<String>,
    pub kind: TaskActivityKind,
    pub summary: String,
    pub detail: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCheckpointArtifactEntry {
    pub id: String,
    pub path: String,
    pub title: String,
    pub kind: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCheckpoint {
    pub id: String,
    pub task_id: String,
    pub thread_id: Option<String>,
    pub task_revision: i64,
    pub reason: String,
    pub agent_summary: String,
    pub context_digest: String,
    pub task_snapshot: Map<String, Value>,
    pub artifact_manifest: Vec<TaskCheckpointArtifactEntry>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSummary {
    pub id: String,
    pub workspace_path: String,
    pub title: String,
    pub objective: String,
    pub context: String,
    pub source_session_id: Option<String>,
    pub creation_origin: TaskCreationOrigin,
    pub status: TaskStatus,
    pub revision: i64,
    pub review_required: bool,
    pub review_rounds: i64,
    pub created_at: String,
    pub updated_at: String,
    pub thread_count: usize,
    pub completed_work_item_count: usize,
    pub total_work_item_count: usize,
    pub active_blocker_count: usize,
    pub pending_question_count: usize,
    pub blocking_question_count: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRecord {
    pub id: String,
    pub workspace_path: String,
    pub title: String,
    pub objective: String,
    pub context: String,
    pub source_session_id: Option<String>,
    pub creation_origin: TaskCreationOrigin,
    pub status: TaskStatus,
    pub revision: i64,
    pub review_required: bool,
    pub review_rounds: i64,
    pub created_at: String,
    pub updated_at: String,
    pub thread_count: usize,
    pub completed_work_item_count: usize,
    pub total_work_item_count: usize,
    pub active_blocker_count: usize,
    pub pending_question_count: usize,
    pub blocking_question_count: usize,
    pub requirements: Vec<TaskRequirement>,
    pub threads: Vec<TaskThread>,
    pub work_items: Vec<WorkItem>,
    pub decisions: Vec<TaskDecision>,
    pub questions: Vec<TaskQuestion>,
    pub artifacts: Vec<TaskArtifact>,
    pub blockers: Vec<TaskBlocker>,
    pub activity: Vec<TaskActivity>,
    pub latest_checkpoint: Option<TaskCheckpoint>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskReviewRecord {
    pub id: String,
    pub task_id: String,
    pub round: i64,
    pub verdict: TaskReviewVerdict,
    pub feedback: String,
    pub reviewer_agent_id: String,
    pub reviewer_provider: String,
    pub reviewer_model: String,
    pub task_revision: i64,
    pub material_fingerprint: String,
    pub material_snapshot: Map<String, Value>,
    pub created_at: String,
    pub addressed_at: Option<String>,
    pub implementation_summary: Option<String>,
}

/// Repository inputs for `SessionDb` task methods.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskWorkItemRecordInput {
    pub id: String,
    pub title: String,
    pub description: String,
    pub status: WorkItemStatus,
    pub depends_on: Vec<String>,
    pub assigned_thread_id: Option<String>,
    pub claimed_by_thread_id: Option<String>,
    pub expected_outputs: Vec<String>,
    pub completion_evidence: Option<String>,
    pub position: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CreateTaskRecordInput {
    pub id: String,
    pub workspace_path: String,
    pub title: String,
    pub objective: String,
    pub context: String,
    pub source_session_id: Option<String>,
    pub creation_origin: TaskCreationOrigin,
    pub creation_idempotency_key: Option<String>,
    pub initial_status: TaskStatus,
    pub review_required: bool,
    pub review_rounds: i64,
    pub thread: TaskThread,
    pub requirements: Vec<TaskRequirement>,
    pub work_items: Vec<TaskWorkItemRecordInput>,
    pub decisions: Vec<TaskDecision>,
}

#[derive(Debug, Clone)]
pub struct StartTaskArtifactRevisionInput {
    pub revision: TaskArtifactRevision,
    pub thread: TaskThread,
    pub work_item: TaskWorkItemRecordInput,
    pub expected_revision: i64,
}

#[derive(Debug, Clone)]
pub struct UpdateTaskPlanInput {
    pub task_id: String,
    pub expected_revision: i64,
    pub title: Option<String>,
    pub objective: Option<String>,
    pub requirements: Option<Vec<TaskRequirement>>,
    pub items: Vec<TaskWorkItemRecordInput>,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct QueueTaskQuestionsInput {
    pub task_id: String,
    pub expected_revision: i64,
    pub questions: Vec<TaskQuestion>,
    pub provisional_decisions: Vec<TaskDecision>,
    pub block_task: bool,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct TaskQuestionResolutionRecordInput {
    pub question_id: String,
    pub answer: String,
    pub answer_option_id: Option<String>,
    pub decision: TaskDecision,
}

#[derive(Debug, Clone)]
pub struct ResolveTaskQuestionsInput {
    pub task_id: String,
    pub expected_revision: i64,
    pub resolutions: Vec<TaskQuestionResolutionRecordInput>,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCreationRequirementInput {
    pub kind: TaskRequirementKind,
    pub text: String,
    #[serde(default = "default_fixed_permanence")]
    pub permanence: String,
}

fn default_fixed_permanence() -> String {
    "fixed".to_string()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCreationWorkItemInput {
    pub key: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default)]
    pub expected_outputs: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCreationDecisionInput {
    pub question: String,
    pub resolution: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidatedTaskCreationInput {
    pub idempotency_key: String,
    pub title: String,
    pub objective: String,
    pub context: String,
    pub requirements: Vec<TaskCreationRequirementInput>,
    pub work_items: Vec<TaskCreationWorkItemInput>,
    #[serde(default)]
    pub decisions: Vec<TaskCreationDecisionInput>,
    #[serde(default = "default_true")]
    pub review_required: bool,
    #[serde(default = "default_review_rounds")]
    pub review_rounds: i64,
}

fn default_true() -> bool {
    true
}

fn default_review_rounds() -> i64 {
    DEFAULT_TASK_REVIEW_ROUNDS
}

/// Validates and normalizes `taskCreationInputSchema` / `parseTaskCreationToolInput`
/// matching `src/shared/tasks.ts`.
pub fn parse_and_validate_task_creation_input(
    raw: &Value,
    allow_nullable_tool_fields: bool,
) -> Result<ValidatedTaskCreationInput> {
    let obj = raw
        .as_object()
        .ok_or_else(|| StorageError::Task("Task creation input must be an object".to_string()))?;

    let allowed_top = [
        "idempotencyKey",
        "title",
        "objective",
        "context",
        "requirements",
        "workItems",
        "decisions",
        "reviewRequired",
        "reviewRounds",
    ];
    for k in obj.keys() {
        if !allowed_top.contains(&k.as_str()) {
            return Err(StorageError::Task(format!(
                "Unrecognized key in task creation input: {k}"
            )));
        }
    }

    let req_trimmed =
        |map: &Map<String, Value>, field: &str, max_len: Option<usize>| -> Result<String> {
            let s = map
                .get(field)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .ok_or_else(|| StorageError::Task(format!("{field} must be a non-empty string")))?;
            if let Some(max) = max_len
                && s.chars().count() > max
            {
                return Err(StorageError::Task(format!(
                    "{field} must be at most {max} characters"
                )));
            }
            Ok(s.to_string())
        };

    let idempotency_key = req_trimmed(obj, "idempotencyKey", Some(200))?;
    let title = req_trimmed(obj, "title", Some(160))?;
    let objective = req_trimmed(obj, "objective", None)?;
    let context = req_trimmed(obj, "context", None)?;

    let reqs_arr = obj
        .get("requirements")
        .and_then(Value::as_array)
        .filter(|a| !a.is_empty())
        .ok_or_else(|| StorageError::Task("At least one requirement is required".to_string()))?;

    let mut requirements = Vec::with_capacity(reqs_arr.len());
    for entry in reqs_arr {
        let rmap = entry
            .as_object()
            .ok_or_else(|| StorageError::Task("Each requirement must be an object".to_string()))?;
        for k in rmap.keys() {
            if !matches!(k.as_str(), "kind" | "text" | "permanence") {
                return Err(StorageError::Task(format!(
                    "Unrecognized key in requirement: {k}"
                )));
            }
        }
        let kind_str = req_trimmed(rmap, "kind", None)?;
        let kind = TaskRequirementKind::parse(&kind_str)
            .ok_or_else(|| StorageError::Task(format!("Invalid requirement kind: {kind_str}")))?;
        let text = req_trimmed(rmap, "text", None)?;
        let permanence = match rmap.get("permanence") {
            None => "fixed".to_string(),
            Some(Value::Null) if allow_nullable_tool_fields => "fixed".to_string(),
            Some(Value::String(p)) if p == "fixed" || p == "temporary" => p.clone(),
            _ => {
                return Err(StorageError::Task(
                    "permanence must be 'fixed' or 'temporary'".to_string(),
                ));
            }
        };
        requirements.push(TaskCreationRequirementInput {
            kind,
            text,
            permanence,
        });
    }

    if !requirements
        .iter()
        .any(|r| r.kind == TaskRequirementKind::AcceptanceCriterion)
    {
        return Err(StorageError::Task(
            "At least one acceptance criterion is required".to_string(),
        ));
    }

    let items_arr = obj
        .get("workItems")
        .and_then(Value::as_array)
        .filter(|a| !a.is_empty())
        .ok_or_else(|| StorageError::Task("At least one work item is required".to_string()))?;

    let mut work_items = Vec::with_capacity(items_arr.len());
    let mut keys = HashSet::new();
    for entry in items_arr {
        let wmap = entry
            .as_object()
            .ok_or_else(|| StorageError::Task("Each workItem must be an object".to_string()))?;
        for k in wmap.keys() {
            if !matches!(
                k.as_str(),
                "key" | "title" | "description" | "dependsOn" | "expectedOutputs"
            ) {
                return Err(StorageError::Task(format!(
                    "Unrecognized key in workItem: {k}"
                )));
            }
        }
        let key = req_trimmed(wmap, "key", Some(80))?;
        if !keys.insert(key.clone()) {
            return Err(StorageError::Task(format!(
                "Duplicate work item key: {key}"
            )));
        }
        let item_title = req_trimmed(wmap, "title", Some(200))?;
        let description = match wmap.get("description") {
            None => String::new(),
            Some(Value::Null) if allow_nullable_tool_fields => String::new(),
            Some(Value::String(s)) => s.trim().to_string(),
            _ => {
                return Err(StorageError::Task(
                    "workItem.description must be a string".to_string(),
                ));
            }
        };
        let depends_on = match wmap.get("dependsOn") {
            None => Vec::new(),
            Some(Value::Null) if allow_nullable_tool_fields => Vec::new(),
            Some(Value::Array(arr)) => {
                let mut out = Vec::with_capacity(arr.len());
                for d in arr {
                    let ds = d
                        .as_str()
                        .map(str::trim)
                        .filter(|s| !s.is_empty() && s.chars().count() <= 80)
                        .ok_or_else(|| StorageError::Task("Invalid dependsOn key".to_string()))?;
                    out.push(ds.to_string());
                }
                out
            }
            _ => {
                return Err(StorageError::Task(
                    "workItem.dependsOn must be an array".to_string(),
                ));
            }
        };
        let expected_outputs = match wmap.get("expectedOutputs") {
            None => Vec::new(),
            Some(Value::Null) if allow_nullable_tool_fields => Vec::new(),
            Some(Value::Array(arr)) => {
                let mut out = Vec::with_capacity(arr.len());
                for eo in arr {
                    let eos = eo
                        .as_str()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .ok_or_else(|| {
                            StorageError::Task("Invalid expectedOutput entry".to_string())
                        })?;
                    out.push(eos.to_string());
                }
                out
            }
            _ => {
                return Err(StorageError::Task(
                    "workItem.expectedOutputs must be an array".to_string(),
                ));
            }
        };
        work_items.push(TaskCreationWorkItemInput {
            key,
            title: item_title,
            description,
            depends_on,
            expected_outputs,
        });
    }

    if !work_items.iter().any(|w| !w.expected_outputs.is_empty()) {
        return Err(StorageError::Task(
            "At least one expected output is required".to_string(),
        ));
    }

    let dep_map: BTreeMap<String, Vec<String>> = work_items
        .iter()
        .map(|w| (w.key.clone(), w.depends_on.clone()))
        .collect();
    for item in &work_items {
        for dep in &item.depends_on {
            if dep == &item.key {
                return Err(StorageError::Task(format!(
                    "Work item {} cannot depend on itself",
                    item.key
                )));
            }
            if !dep_map.contains_key(dep) {
                return Err(StorageError::Task(format!(
                    "Unknown work item dependency: {dep}"
                )));
            }
        }
    }

    let mut visiting = HashSet::new();
    let mut visited = HashSet::new();
    fn has_cycle(
        key: &str,
        dep_map: &BTreeMap<String, Vec<String>>,
        visiting: &mut HashSet<String>,
        visited: &mut HashSet<String>,
    ) -> bool {
        if visiting.contains(key) {
            return true;
        }
        if visited.contains(key) {
            return false;
        }
        visiting.insert(key.to_string());
        if let Some(deps) = dep_map.get(key) {
            for dep in deps {
                if dep_map.contains_key(dep) && has_cycle(dep, dep_map, visiting, visited) {
                    return true;
                }
            }
        }
        visiting.remove(key);
        visited.insert(key.to_string());
        false
    }
    for k in dep_map.keys() {
        if has_cycle(k, &dep_map, &mut visiting, &mut visited) {
            return Err(StorageError::Task(
                "Work item dependencies contain a cycle".to_string(),
            ));
        }
    }

    let decisions = match obj.get("decisions") {
        None => Vec::new(),
        Some(Value::Null) if allow_nullable_tool_fields => Vec::new(),
        Some(Value::Array(arr)) => {
            let mut out = Vec::with_capacity(arr.len());
            for entry in arr {
                let dmap = entry.as_object().ok_or_else(|| {
                    StorageError::Task("Each decision must be an object".to_string())
                })?;
                for k in dmap.keys() {
                    if !matches!(k.as_str(), "question" | "resolution" | "confidence") {
                        return Err(StorageError::Task(format!(
                            "Unrecognized key in decision: {k}"
                        )));
                    }
                }
                let question = req_trimmed(dmap, "question", None)?;
                let resolution = req_trimmed(dmap, "resolution", None)?;
                let confidence = match dmap.get("confidence") {
                    None => None,
                    Some(Value::Null) if allow_nullable_tool_fields => None,
                    Some(v) => {
                        let c = v.as_f64().ok_or_else(|| {
                            StorageError::Task("confidence must be a number".to_string())
                        })?;
                        if !(0.0..=1.0).contains(&c) {
                            return Err(StorageError::Task(
                                "confidence must be between 0 and 1".to_string(),
                            ));
                        }
                        Some(c)
                    }
                };
                out.push(TaskCreationDecisionInput {
                    question,
                    resolution,
                    confidence,
                });
            }
            out
        }
        _ => return Err(StorageError::Task("decisions must be an array".to_string())),
    };

    let review_required = match obj.get("reviewRequired") {
        None => true,
        Some(Value::Null) if allow_nullable_tool_fields => true,
        Some(Value::Bool(b)) => *b,
        _ => {
            return Err(StorageError::Task(
                "reviewRequired must be a boolean".to_string(),
            ));
        }
    };

    let review_rounds = match obj.get("reviewRounds") {
        None => DEFAULT_TASK_REVIEW_ROUNDS,
        Some(Value::Null) if allow_nullable_tool_fields => DEFAULT_TASK_REVIEW_ROUNDS,
        Some(v) => {
            let n = v
                .as_i64()
                .ok_or_else(|| StorageError::Task("reviewRounds must be an integer".to_string()))?;
            if !(0..=MAX_TASK_REVIEW_ROUNDS).contains(&n) {
                return Err(StorageError::Task(format!(
                    "reviewRounds must be between 0 and {MAX_TASK_REVIEW_ROUNDS}"
                )));
            }
            n
        }
    };

    Ok(ValidatedTaskCreationInput {
        idempotency_key,
        title,
        objective,
        context,
        requirements,
        work_items,
        decisions,
        review_required,
        review_rounds,
    })
}

/// Matches `getTaskInputResumeFailure` in `src/shared/tasks.ts`.
pub fn get_task_input_resume_failure(task: &TaskRecord) -> Option<String> {
    if task.status != TaskStatus::Failed {
        return None;
    }
    let latest_status_change = task
        .activity
        .iter()
        .filter(|a| a.kind == TaskActivityKind::StatusChanged)
        .max_by_key(|a| a.seq)?;
    let detail_raw = latest_status_change.detail.as_deref()?;
    let parsed: Value = serde_json::from_str(detail_raw).ok()?;
    if parsed.get("kind").and_then(Value::as_str) != Some("input_resume_failed") {
        return None;
    }
    parsed
        .get("message")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}
