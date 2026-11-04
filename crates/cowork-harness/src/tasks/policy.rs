//! Pure task policy: lifecycle transitions, DAG & work-item ownership rules,
//! prompts, media-type mapping, and typed coordinator errors.
//!
//! Mirrors `src/server/tasks/taskPolicy.ts`.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use chrono::{SecondsFormat, Utc};
use cowork_storage::{
    StorageError, TaskActivity, TaskActivityKind, TaskArtifact, TaskArtifactRevision,
    TaskQuestionStatus, TaskRecord, TaskRequirement, TaskRequirementKind,
    TaskReviewArtifactFileSnapshot, TaskStatus, WorkItem, WorkItemStatus,
};
use serde_json::{Map, Value, json};
use thiserror::Error;
use uuid::Uuid;

use super::locks::{TaskLockError, get_pending_terminal_task_lock, is_terminal_task_status};

pub const DEFAULT_ARTIFACT_SETTLEMENT_RETRY_DELAYS_MS: &[u64] = &[0, 25, 100, 250, 500, 1000];

#[derive(Debug, Clone)]
pub struct TaskReviewMaterial {
    pub snapshot: Map<String, Value>,
    pub fingerprint: String,
}

#[derive(Debug, Error)]
pub enum TaskCoordinatorError {
    #[error("{0}")]
    InvalidRequest(String),

    #[error("Task revision conflict: expected {expected}, current {current}")]
    RevisionConflict { expected: i64, current: i64 },

    #[error("Artifact changed on disk: expected {expected_sha256}, current {}", current_sha256.as_deref().unwrap_or("missing"))]
    ArtifactConflict {
        artifact_id: Option<String>,
        expected_sha256: String,
        current_sha256: Option<String>,
    },

    #[error("{}", .0.message)]
    TaskLocked(Box<TaskLockError>),

    #[error("Failed to quiesce task before completion settlement: {0}")]
    QuiescenceFailed(String),

    #[error("Failed to commit task completion settlement atomically: {0}")]
    AtomicSettlementFailed(String),
}

impl From<StorageError> for TaskCoordinatorError {
    fn from(err: StorageError) -> Self {
        match err {
            StorageError::TaskRevisionConflict { expected, current } => {
                Self::RevisionConflict { expected, current }
            }
            StorageError::ArtifactFingerprintConflict {
                expected_fingerprint,
                actual_fingerprint,
            } => Self::ArtifactConflict {
                artifact_id: None,
                expected_sha256: expected_fingerprint,
                current_sha256: actual_fingerprint,
            },
            StorageError::Task(msg) => Self::InvalidRequest(msg),
            other => Self::InvalidRequest(other.to_string()),
        }
    }
}

pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn non_empty(value: &str, name: &str) -> Result<String, TaskCoordinatorError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(TaskCoordinatorError::InvalidRequest(format!(
            "{name} is required"
        )));
    }
    Ok(trimmed.to_owned())
}

pub fn is_valid_task_transition(from: TaskStatus, to: TaskStatus) -> bool {
    match from {
        TaskStatus::Draft => matches!(
            to,
            TaskStatus::Planning | TaskStatus::Working | TaskStatus::Cancelled | TaskStatus::Failed
        ),
        TaskStatus::Planning => matches!(
            to,
            TaskStatus::Working | TaskStatus::Blocked | TaskStatus::Cancelled | TaskStatus::Failed
        ),
        TaskStatus::Working => matches!(
            to,
            TaskStatus::Blocked
                | TaskStatus::AwaitingReview
                | TaskStatus::Completed
                | TaskStatus::Cancelled
                | TaskStatus::Failed
        ),
        TaskStatus::Blocked => matches!(
            to,
            TaskStatus::Working | TaskStatus::Cancelled | TaskStatus::Failed
        ),
        TaskStatus::AwaitingReview => matches!(
            to,
            TaskStatus::Working
                | TaskStatus::Completed
                | TaskStatus::Cancelled
                | TaskStatus::Failed
        ),
        TaskStatus::Completed | TaskStatus::Failed | TaskStatus::Cancelled => false,
    }
}

pub fn is_terminal_task(task: &TaskRecord) -> bool {
    is_terminal_task_status(task.status)
}

pub fn is_terminal_task_mutation_error(task_id: &str, err: &TaskCoordinatorError) -> bool {
    let msg = err.to_string();
    msg.starts_with(&format!("Task {task_id} is "))
        && msg.contains("cannot be changed until it is reopened or retried")
}

pub fn assert_task_accepts_new_threads(
    task: &TaskRecord,
    allow_pending_terminal_lock: bool,
) -> Result<(), TaskCoordinatorError> {
    if !allow_pending_terminal_lock && let Some(lock) = get_pending_terminal_task_lock(&task.id) {
        return Err(TaskCoordinatorError::TaskLocked(Box::new(lock)));
    }
    if is_terminal_task_status(task.status) {
        return Err(TaskCoordinatorError::InvalidRequest(format!(
            "Task {} is {} and cannot create new focused threads until it is reopened or retried.",
            task.id,
            task.status.as_str()
        )));
    }
    Ok(())
}

pub fn assert_task_accepts_mutation(
    task: &TaskRecord,
    allow_pending_terminal_lock: bool,
) -> Result<(), TaskCoordinatorError> {
    if !allow_pending_terminal_lock && let Some(lock) = get_pending_terminal_task_lock(&task.id) {
        return Err(TaskCoordinatorError::TaskLocked(Box::new(lock)));
    }
    if is_terminal_task_status(task.status) {
        return Err(TaskCoordinatorError::InvalidRequest(format!(
            "Task {} is {} and cannot be changed until it is reopened or retried.",
            task.id,
            task.status.as_str()
        )));
    }
    Ok(())
}

pub fn assert_expected_task_revision(
    task: &TaskRecord,
    expected_revision: i64,
) -> Result<(), TaskCoordinatorError> {
    if task.revision == expected_revision {
        Ok(())
    } else {
        Err(TaskCoordinatorError::RevisionConflict {
            expected: expected_revision,
            current: task.revision,
        })
    }
}

pub fn is_dependency_gated_work_item_status(status: WorkItemStatus) -> bool {
    matches!(
        status,
        WorkItemStatus::InProgress | WorkItemStatus::Review | WorkItemStatus::Done
    )
}

pub fn is_terminal_work_item_status(status: WorkItemStatus) -> bool {
    matches!(
        status,
        WorkItemStatus::Blocked | WorkItemStatus::Done | WorkItemStatus::Abandoned
    )
}

pub fn assert_task_thread_member(
    task: &TaskRecord,
    thread_id: &str,
) -> Result<(), TaskCoordinatorError> {
    if task.threads.iter().any(|t| t.id == thread_id) {
        Ok(())
    } else {
        Err(TaskCoordinatorError::InvalidRequest(format!(
            "Unknown task thread: {thread_id}"
        )))
    }
}

pub fn assert_no_conflicting_work_item_owner(
    item: &WorkItem,
    thread_id: &str,
) -> Result<(), TaskCoordinatorError> {
    for owner in [&item.assigned_thread_id, &item.claimed_by_thread_id] {
        if let Some(owner_id) = owner
            && owner_id != thread_id
        {
            return Err(TaskCoordinatorError::InvalidRequest(format!(
                "Work item is owned by another task thread: {}",
                item.id
            )));
        }
    }
    Ok(())
}

pub fn assert_thread_can_mutate_work_item(
    task: &TaskRecord,
    item: &WorkItem,
    thread_id: &str,
) -> Result<(), TaskCoordinatorError> {
    assert_task_thread_member(task, thread_id)?;
    assert_no_conflicting_work_item_owner(item, thread_id)?;

    let owns = item.assigned_thread_id.as_deref() == Some(thread_id)
        || item.claimed_by_thread_id.as_deref() == Some(thread_id);
    let primary_thread_id = task.threads.first().map(|t| t.id.as_str());
    if !owns && Some(thread_id) != primary_thread_id {
        return Err(TaskCoordinatorError::InvalidRequest(format!(
            "Work item must be claimed before this task thread can mark it: {}",
            item.id
        )));
    }
    Ok(())
}

pub fn assert_work_item_dependencies_complete(
    items: &[WorkItem],
    item: &WorkItem,
    status: WorkItemStatus,
) -> Result<(), TaskCoordinatorError> {
    if !is_dependency_gated_work_item_status(status) {
        return Ok(());
    }
    for dep_id in &item.depends_on {
        let done = items
            .iter()
            .find(|c| c.id == *dep_id)
            .is_some_and(|c| c.status == WorkItemStatus::Done);
        if !done {
            return Err(TaskCoordinatorError::InvalidRequest(format!(
                "Work item dependency is not complete: {dep_id}"
            )));
        }
    }
    Ok(())
}

pub fn assert_no_incomplete_dependency_removal(
    items: &[WorkItem],
    existing: &WorkItem,
    next: &WorkItem,
) -> Result<(), TaskCoordinatorError> {
    let next_deps: BTreeSet<&str> = next.depends_on.iter().map(String::as_str).collect();
    for dep_id in &existing.depends_on {
        if !next_deps.contains(dep_id.as_str()) {
            let done = items
                .iter()
                .find(|c| c.id == *dep_id)
                .is_some_and(|c| c.status == WorkItemStatus::Done);
            if !done {
                return Err(TaskCoordinatorError::InvalidRequest(format!(
                    "Work item dependency is not complete: {dep_id}"
                )));
            }
        }
    }
    Ok(())
}

pub fn replacement_changes_work_item(existing: Option<&WorkItem>, next: &WorkItem) -> bool {
    let Some(existing) = existing else {
        return true;
    };
    existing.title != next.title
        || existing.description != next.description
        || existing.status != next.status
        || existing.depends_on != next.depends_on
        || existing.expected_outputs != next.expected_outputs
}

pub fn assert_thread_can_mark_work_item(
    task: &TaskRecord,
    item: &WorkItem,
    status: WorkItemStatus,
    thread_id: Option<&str>,
) -> Result<(), TaskCoordinatorError> {
    let Some(thread_id) = thread_id else {
        return Ok(());
    };
    assert_thread_can_mutate_work_item(task, item, thread_id)?;
    assert_work_item_dependencies_complete(&task.work_items, item, status)
}

pub fn assert_thread_can_claim_work_item(
    task: &TaskRecord,
    item: &WorkItem,
    thread_id: &str,
) -> Result<(), TaskCoordinatorError> {
    assert_task_thread_member(task, thread_id)?;
    assert_no_conflicting_work_item_owner(item, thread_id)?;
    assert_work_item_dependencies_complete(&task.work_items, item, WorkItemStatus::InProgress)
}

pub fn make_activity(
    task_id: &str,
    thread_id: Option<String>,
    work_item_id: Option<String>,
    kind: TaskActivityKind,
    summary: String,
    detail: Option<String>,
) -> TaskActivity {
    TaskActivity {
        id: Uuid::new_v4().to_string(),
        seq: 1,
        task_id: task_id.to_owned(),
        thread_id,
        work_item_id,
        kind,
        summary,
        detail,
        created_at: now_iso(),
    }
}

pub fn make_requirement(
    kind: TaskRequirementKind,
    text: &str,
    permanence: Option<&str>,
    source: Option<&str>,
) -> Result<TaskRequirement, TaskCoordinatorError> {
    Ok(TaskRequirement {
        id: Uuid::new_v4().to_string(),
        kind,
        text: non_empty(text, "Requirement text")?,
        source: source.unwrap_or("agent").to_owned(),
        permanence: permanence.unwrap_or("fixed").to_owned(),
        status: "active".to_owned(),
        created_at: now_iso(),
        supersedes: None,
    })
}

pub fn validate_work_graph(items: &[WorkItem]) -> Result<(), TaskCoordinatorError> {
    let mut ids = BTreeSet::new();
    for item in items {
        if !ids.insert(item.id.clone()) {
            return Err(TaskCoordinatorError::InvalidRequest(format!(
                "Duplicate work item id: {}",
                item.id
            )));
        }
    }
    let mut by_id = BTreeMap::new();
    for item in items {
        for dep in &item.depends_on {
            if !ids.contains(dep) {
                return Err(TaskCoordinatorError::InvalidRequest(format!(
                    "Work item {} depends on unknown item {}",
                    item.id, dep
                )));
            }
            if dep == &item.id {
                return Err(TaskCoordinatorError::InvalidRequest(format!(
                    "Work item {} cannot depend on itself",
                    item.id
                )));
            }
        }
        by_id.insert(item.id.as_str(), item);
    }

    fn visit<'a>(
        id: &'a str,
        by_id: &BTreeMap<&'a str, &'a WorkItem>,
        visiting: &mut BTreeSet<&'a str>,
        visited: &mut BTreeSet<&'a str>,
    ) -> Result<(), TaskCoordinatorError> {
        if visiting.contains(id) {
            return Err(TaskCoordinatorError::InvalidRequest(
                "Work item dependency graph contains a cycle".to_owned(),
            ));
        }
        if visited.contains(id) {
            return Ok(());
        }
        visiting.insert(id);
        if let Some(item) = by_id.get(id) {
            for dep in &item.depends_on {
                visit(dep.as_str(), by_id, visiting, visited)?;
            }
        }
        visiting.remove(id);
        visited.insert(id);
        Ok(())
    }

    let mut visiting = BTreeSet::new();
    let mut visited = BTreeSet::new();
    for item in items {
        visit(&item.id, &by_id, &mut visiting, &mut visited)?;
    }
    Ok(())
}

pub fn canonicalize_workspace_str(workspace_path: &str) -> String {
    let p = Path::new(workspace_path.trim());
    std::fs::canonicalize(p)
        .unwrap_or_else(|_| p.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

pub fn same_workspace_path(left: &str, right: &str) -> bool {
    canonicalize_workspace_str(left) == canonicalize_workspace_str(right)
}

pub fn assert_workspace(
    task: &TaskRecord,
    workspace_path: &str,
) -> Result<(), TaskCoordinatorError> {
    if same_workspace_path(&task.workspace_path, workspace_path) {
        Ok(())
    } else {
        Err(TaskCoordinatorError::InvalidRequest(
            "Task is outside the active workspace".to_owned(),
        ))
    }
}

pub fn task_snapshot(task: &TaskRecord) -> Map<String, Value> {
    let val = json!({
        "id": task.id,
        "workspacePath": task.workspace_path,
        "title": task.title,
        "objective": task.objective,
        "status": task.status,
        "revision": task.revision,
        "reviewRequired": task.review_required,
        "reviewRounds": task.review_rounds,
        "requirements": task.requirements,
        "threads": task.threads,
        "workItems": task.work_items,
        "decisions": task.decisions,
        "questions": task.questions,
        "blockers": task.blockers,
        "artifacts": task.artifacts,
    });
    val.as_object().cloned().unwrap_or_default()
}

pub fn build_task_question_continuation_prompt(answers: &[(String, String)]) -> String {
    let mut lines = vec!["The user answered blocking questions in the task work panel.".to_owned()];
    for (q, a) in answers {
        lines.push(format!("- {q}: {a}"));
    }
    lines.push(
        "Review the authoritative task record and latest checkpoint, then continue the work."
            .to_owned(),
    );
    lines.push(
        "Do not re-ask resolved questions unless the task requirements materially change."
            .to_owned(),
    );
    lines.join("\n")
}

pub fn build_task_retry_prompt(task: &TaskRecord) -> String {
    let answers: Vec<(String, String)> = task
        .questions
        .iter()
        .filter_map(|q| {
            if q.status == TaskQuestionStatus::Answered {
                q.answer.as_ref().map(|a| (q.question.clone(), a.clone()))
            } else {
                None
            }
        })
        .collect();
    let mut parts = vec![
        format!("Retry the task \"{}\" in its existing task thread.", task.title),
        "The previous run failed before the task reached a review or completion state.".to_owned(),
        "Review the authoritative task brief, work graph, decisions, artifacts, and latest checkpoint before continuing.".to_owned(),
        "Preserve completed work and resume the first unblocked unfinished work item. Do not restart completed work unless validation shows it is invalid.".to_owned(),
    ];
    if !answers.is_empty() {
        parts.push(build_task_question_continuation_prompt(&answers));
    }
    parts.join("\n\n")
}

pub fn media_type_for_artifact(file_path: &str, kind: &str) -> String {
    let ext = Path::new(file_path)
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "csv" => "text/csv".to_owned(),
        "docx" => {
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document".to_owned()
        }
        "html" => "text/html".to_owned(),
        "jpeg" | "jpg" => "image/jpeg".to_owned(),
        "json" => "application/json".to_owned(),
        "md" => "text/markdown".to_owned(),
        "pdf" => "application/pdf".to_owned(),
        "png" => "image/png".to_owned(),
        "pptx" => {
            "application/vnd.openxmlformats-officedocument.presentationml.presentation".to_owned()
        }
        "svg" => "image/svg+xml".to_owned(),
        "txt" => "text/plain".to_owned(),
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet".to_owned(),
        _ => {
            if kind.contains('/') {
                kind.to_owned()
            } else {
                "application/octet-stream".to_owned()
            }
        }
    }
}

pub fn build_artifact_revision_prompt(
    artifact: &TaskArtifact,
    revision: &TaskArtifactRevision,
) -> String {
    [
        format!("Revise the task artifact at {}.", artifact.path),
        "Apply only the requested delta and preserve unaffected content and formatting.".to_owned(),
        format!("Requested revision: {}", revision.instruction),
        "When finished, verify the artifact remains readable and editable.".to_owned(),
    ]
    .join("\n\n")
}

pub fn live_artifact_evidence(
    material: &TaskReviewMaterial,
) -> Result<Value, TaskCoordinatorError> {
    let arr = material
        .snapshot
        .get("artifacts")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            TaskCoordinatorError::InvalidRequest("Invalid review material artifacts".to_owned())
        })?;
    let mut out = Vec::with_capacity(arr.len());
    for entry in arr {
        let obj = entry.as_object().ok_or_else(|| {
            TaskCoordinatorError::InvalidRequest("Invalid review material artifact".to_owned())
        })?;
        let id = obj
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                TaskCoordinatorError::InvalidRequest(
                    "Invalid review material artifact id".to_owned(),
                )
            })?
            .to_owned();
        let path = obj
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                TaskCoordinatorError::InvalidRequest(
                    "Invalid review material artifact path".to_owned(),
                )
            })?
            .to_owned();
        let live_file_val = obj.get("liveFile").cloned().unwrap_or(Value::Null);
        let live_file: Option<TaskReviewArtifactFileSnapshot> = if live_file_val.is_null() {
            None
        } else {
            serde_json::from_value(live_file_val).map_err(|_| {
                TaskCoordinatorError::InvalidRequest(
                    "Invalid review material live file evidence".to_owned(),
                )
            })?
        };
        out.push(json!({
            "id": id,
            "path": path,
            "liveFile": live_file,
        }));
    }
    Ok(Value::Array(out))
}
