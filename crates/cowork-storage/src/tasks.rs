//! Full SQLite task repository methods on `SessionDb` over the 16 task tables.
//!
//! Mirrors `src/server/sessionDb/tasks.ts` and the task methods on `src/server/sessionDb.ts`.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::Path;
use std::pin::Pin;

use cowork_config::canonicalize_sync;
use rusqlite::{Connection, OptionalExtension, params, params_from_iter};
use serde_json::{Map, Value};
use uuid::Uuid;

use crate::error::{Result, StorageError};
use crate::session_db::SessionDb;
use crate::task_types::{
    CreateTaskRecordInput, QueueTaskQuestionsInput, ResolveTaskQuestionsInput,
    StartTaskArtifactRevisionInput, TaskActivity, TaskActivityKind, TaskArtifact,
    TaskArtifactDetail, TaskArtifactRevision, TaskArtifactRevisionStatus, TaskArtifactVersion,
    TaskArtifactVersionReviewStatus, TaskBlocker, TaskCheckpoint, TaskCheckpointArtifactEntry,
    TaskCreationOrigin, TaskDecision, TaskQuestion, TaskQuestionOption, TaskQuestionStatus,
    TaskQuestionUrgency, TaskRecord, TaskRequirement, TaskRequirementKind, TaskReviewRecord,
    TaskReviewVerdict, TaskStatus, TaskSummary, TaskThread, TaskWorkItemRecordInput,
    UpdateTaskPlanInput, WorkItem, WorkItemStatus,
};

const PENDING_ARTIFACT_REVISION_SETTLEMENT: &str = "pending";

pub struct TaskDirectiveCommitPayload {
    pub idempotency_key: String,
    pub receipt_created_at: String,
    pub checkpoint: TaskCheckpoint,
}

pub type TaskDirectiveCommitBuilder =
    Box<dyn FnOnce(&TaskRecord) -> TaskDirectiveCommitPayload + Send>;
pub type TaskCommittedCallback = Box<dyn FnOnce(&TaskRecord, Option<&TaskCheckpoint>) + Send>;

pub struct TaskDirectiveCommitHooks {
    pub create: TaskDirectiveCommitBuilder,
    pub on_committed: Option<TaskCommittedCallback>,
}

#[derive(Debug, Clone)]
pub enum ArtifactRevisionFinalizationOutcome {
    Completed {
        revision_id: String,
        version: Box<TaskArtifactVersion>,
    },
    Cancelled {
        revision_id: String,
        detail: Option<String>,
    },
}

impl ArtifactRevisionFinalizationOutcome {
    pub fn revision_id(&self) -> &str {
        match self {
            Self::Completed { revision_id, .. } | Self::Cancelled { revision_id, .. } => {
                revision_id
            }
        }
    }
}

pub type BoxTaskValidator =
    Box<dyn FnOnce(TaskRecord) -> Pin<Box<dyn Future<Output = Result<()>> + Send>> + Send>;

pub enum PreparedTaskCompletion {
    Ready {
        validate_ready_task: Option<BoxTaskValidator>,
        validate_accepted_task: Option<BoxTaskValidator>,
    },
    NotReady {
        error_message: String,
    },
}

pub enum PreviewCompletionReadinessResult {
    Ready,
    NotReady { error_message: String },
}

pub enum FinalizeArtifactRevisionCompletionResult {
    Committed(TaskRecord),
    NotReady {
        task: TaskRecord,
        error_message: String,
    },
}

#[derive(Debug, Clone)]
pub struct SetTaskStatusInput {
    pub task_id: String,
    pub expected_revision: i64,
    pub status: TaskStatus,
    pub summary: String,
    pub detail: Option<String>,
    pub updated_at: String,
    pub thread_id: Option<String>,
}

fn parse_json_string_array(raw: Option<String>) -> Vec<String> {
    let Some(s) = raw else { return Vec::new() };
    let Ok(Value::Array(arr)) = serde_json::from_str::<Value>(&s) else {
        return Vec::new();
    };
    arr.into_iter()
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect()
}

fn parse_json_object(raw: Option<String>) -> Map<String, Value> {
    let Some(s) = raw else { return Map::new() };
    match serde_json::from_str::<Value>(&s) {
        Ok(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

fn parse_artifact_manifest(raw: Option<String>) -> Vec<TaskCheckpointArtifactEntry> {
    let Some(s) = raw else { return Vec::new() };
    let Ok(Value::Array(arr)) = serde_json::from_str::<Value>(&s) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in arr {
        let Some(obj) = entry.as_object() else {
            continue;
        };
        let (Some(id), Some(path), Some(title), Some(kind)) = (
            obj.get("id").and_then(Value::as_str),
            obj.get("path").and_then(Value::as_str),
            obj.get("title").and_then(Value::as_str),
            obj.get("kind").and_then(Value::as_str),
        ) else {
            continue;
        };
        out.push(TaskCheckpointArtifactEntry {
            id: id.to_owned(),
            path: path.to_owned(),
            title: title.to_owned(),
            kind: kind.to_owned(),
        });
    }
    out
}

fn parse_question_options(raw: Option<String>) -> Vec<TaskQuestionOption> {
    let Some(s) = raw else { return Vec::new() };
    let Ok(Value::Array(arr)) = serde_json::from_str::<Value>(&s) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in arr {
        let Some(obj) = entry.as_object() else {
            continue;
        };
        let (Some(id), Some(label)) = (
            obj.get("id").and_then(Value::as_str),
            obj.get("label").and_then(Value::as_str),
        ) else {
            continue;
        };
        let description = obj
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        out.push(TaskQuestionOption {
            id: id.to_owned(),
            label: label.to_owned(),
            description,
        });
    }
    out
}

#[derive(Debug)]
struct RawTaskRow {
    task_id: String,
    workspace_path: String,
    title: String,
    objective: String,
    context: String,
    source_session_id: Option<String>,
    creation_origin: String,
    status: String,
    revision: i64,
    review_required: i64,
    review_rounds: i64,
    created_at: String,
    updated_at: String,
}

fn read_task_row(conn: &Connection, task_id: &str) -> Result<Option<RawTaskRow>> {
    conn.query_row(
        "SELECT task_id, workspace_path, title, objective, context, source_session_id,
                creation_origin, status, revision, review_required, review_rounds,
                created_at, updated_at
         FROM tasks WHERE task_id = ?1",
        params![task_id],
        |r| {
            Ok(RawTaskRow {
                task_id: r.get(0)?,
                workspace_path: r.get(1)?,
                title: r.get(2)?,
                objective: r.get(3)?,
                context: r.get(4)?,
                source_session_id: r.get(5)?,
                creation_origin: r.get(6)?,
                status: r.get(7)?,
                revision: r.get(8)?,
                review_required: r.get(9)?,
                review_rounds: r.get(10)?,
                created_at: r.get(11)?,
                updated_at: r.get(12)?,
            })
        },
    )
    .optional()
    .map_err(StorageError::from)
}

fn map_artifact_from_row(r: &rusqlite::Row<'_>, task_id: &str) -> rusqlite::Result<TaskArtifact> {
    let prov_raw: Option<String> = r.get("provenance_json")?;
    Ok(TaskArtifact {
        id: r.get("artifact_id")?,
        task_id: task_id.to_owned(),
        work_item_id: r.get("work_item_id")?,
        thread_id: r.get("thread_id")?,
        path: r.get("path")?,
        kind: r.get("kind")?,
        title: r.get("title")?,
        created_by: r.get("created_by")?,
        provenance: parse_json_object(prov_raw),
        created_at: r.get("created_at")?,
    })
}

fn map_artifact_version_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<TaskArtifactVersion> {
    let prov_raw: Option<String> = r.get("provenance_json")?;
    let status_raw: String = r.get("review_status")?;
    let size_bytes: i64 = r.get("size_bytes")?;
    Ok(TaskArtifactVersion {
        id: r.get("version_id")?,
        artifact_id: r.get("artifact_id")?,
        version: r.get("version_number")?,
        parent_version_id: r.get("parent_version_id")?,
        sha256: r.get("sha256")?,
        size_bytes: size_bytes.max(0) as u64,
        media_type: r.get("media_type")?,
        created_by: r.get("created_by")?,
        created_at: r.get("created_at")?,
        change_summary: r.get("change_summary")?,
        provenance: parse_json_object(prov_raw),
        review_status: TaskArtifactVersionReviewStatus::parse(&status_raw)
            .unwrap_or(TaskArtifactVersionReviewStatus::Draft),
    })
}

fn map_artifact_revision_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<TaskArtifactRevision> {
    let status_raw: String = r.get("status")?;
    Ok(TaskArtifactRevision {
        id: r.get("revision_id")?,
        task_id: r.get("task_id")?,
        artifact_id: r.get("artifact_id")?,
        work_item_id: r.get("work_item_id")?,
        task_thread_id: r.get("task_thread_id")?,
        session_id: r.get("session_id")?,
        base_version_id: r.get("base_version_id")?,
        prior_version_id: r.get("prior_version_id")?,
        status: TaskArtifactRevisionStatus::parse(&status_raw)
            .unwrap_or(TaskArtifactRevisionStatus::Active),
        instruction: r.get("instruction")?,
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
        completed_at: r.get("completed_at")?,
    })
}

fn map_review_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<TaskReviewRecord> {
    let verdict_raw: String = r.get("verdict")?;
    let snap_raw: Option<String> = r.get("material_snapshot_json")?;
    Ok(TaskReviewRecord {
        id: r.get("review_id")?,
        task_id: r.get("task_id")?,
        round: r.get("round")?,
        verdict: TaskReviewVerdict::parse(&verdict_raw).unwrap_or(TaskReviewVerdict::Fail),
        feedback: r.get("feedback")?,
        reviewer_agent_id: r.get("reviewer_agent_id")?,
        reviewer_provider: r.get("reviewer_provider")?,
        reviewer_model: r.get("reviewer_model")?,
        task_revision: r.get("task_revision")?,
        material_fingerprint: r.get("material_fingerprint")?,
        material_snapshot: parse_json_object(snap_raw),
        created_at: r.get("created_at")?,
        addressed_at: r.get("addressed_at")?,
        implementation_summary: r.get("implementation_summary")?,
    })
}

fn get_task_sync(conn: &Connection, task_id: &str) -> Result<Option<TaskRecord>> {
    let Some(row) = read_task_row(conn, task_id)? else {
        return Ok(None);
    };

    let mut req_stmt = conn.prepare(
        "SELECT requirement_id, kind, text, source, permanence, status, created_at, supersedes
         FROM task_requirements WHERE task_id = ?1 ORDER BY created_at, requirement_id",
    )?;
    let requirements: Vec<TaskRequirement> = req_stmt
        .query_map(params![&row.task_id], |r| {
            let kind_raw: String = r.get(1)?;
            Ok(TaskRequirement {
                id: r.get(0)?,
                kind: TaskRequirementKind::parse(&kind_raw)
                    .unwrap_or(TaskRequirementKind::Requirement),
                text: r.get(2)?,
                source: r.get(3)?,
                permanence: r.get(4)?,
                status: r.get(5)?,
                created_at: r.get(6)?,
                supersedes: r.get(7)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut thr_stmt = conn.prepare(
        "SELECT thread_id, session_id, title, created_by, created_at, updated_at
         FROM task_threads WHERE task_id = ?1 ORDER BY created_at, thread_id",
    )?;
    let threads: Vec<TaskThread> = thr_stmt
        .query_map(params![&row.task_id], |r| {
            Ok(TaskThread {
                id: r.get(0)?,
                task_id: row.task_id.clone(),
                session_id: r.get(1)?,
                title: r.get(2)?,
                created_by: r.get(3)?,
                created_at: r.get(4)?,
                updated_at: r.get(5)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut dep_stmt = conn.prepare(
        "SELECT work_item_id, depends_on_work_item_id
         FROM task_work_item_dependencies WHERE task_id = ?1",
    )?;
    let mut deps_map: HashMap<String, Vec<String>> = HashMap::new();
    let dep_rows = dep_stmt.query_map(params![&row.task_id], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;
    for dep in dep_rows {
        let (wid, did) = dep?;
        deps_map.entry(wid).or_default().push(did);
    }

    let mut claim_stmt = conn
        .prepare("SELECT work_item_id, thread_id FROM task_work_item_claims WHERE task_id = ?1")?;
    let mut claims_map: HashMap<String, String> = HashMap::new();
    let claim_rows = claim_stmt.query_map(params![&row.task_id], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;
    for cl in claim_rows {
        let (wid, tid) = cl?;
        claims_map.insert(wid, tid);
    }

    let mut wi_stmt = conn.prepare(
        "SELECT work_item_id, title, description, status, assigned_thread_id,
                expected_outputs_json, completion_evidence, position, created_at, updated_at
         FROM task_work_items WHERE task_id = ?1 ORDER BY position, created_at",
    )?;
    let work_items: Vec<WorkItem> = wi_stmt
        .query_map(params![&row.task_id], |r| {
            let wid: String = r.get(0)?;
            let status_raw: String = r.get(3)?;
            let eo_raw: Option<String> = r.get(5)?;
            Ok(WorkItem {
                depends_on: deps_map.remove(&wid).unwrap_or_default(),
                claimed_by_thread_id: claims_map.remove(&wid),
                id: wid,
                task_id: row.task_id.clone(),
                title: r.get(1)?,
                description: r.get(2)?,
                status: WorkItemStatus::parse(&status_raw).unwrap_or(WorkItemStatus::Queued),
                assigned_thread_id: r.get(4)?,
                expected_outputs: parse_json_string_array(eo_raw),
                completion_evidence: r.get(6)?,
                position: r.get(7)?,
                created_at: r.get(8)?,
                updated_at: r.get(9)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut dec_stmt = conn.prepare(
        "SELECT decision_id, question, resolution, source, scope, confidence, status,
                created_at, supersedes
         FROM task_decisions WHERE task_id = ?1 ORDER BY created_at, decision_id",
    )?;
    let decisions: Vec<TaskDecision> = dec_stmt
        .query_map(params![&row.task_id], |r| {
            Ok(TaskDecision {
                id: r.get(0)?,
                task_id: row.task_id.clone(),
                question: r.get(1)?,
                resolution: r.get(2)?,
                source: r.get(3)?,
                scope: r.get(4)?,
                confidence: r.get(5)?,
                status: r.get(6)?,
                created_at: r.get(7)?,
                supersedes: r.get(8)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut q_stmt = conn.prepare(
        "SELECT question_id, thread_id, work_item_id, header, question, context, blocking,
                urgency, default_action, options_json, recommended_option_id, status,
                provisional_decision_id, answer, answer_option_id, resolution_source,
                supersedes, created_at, resolved_at
         FROM task_questions WHERE task_id = ?1 ORDER BY created_at, rowid",
    )?;
    let questions: Vec<TaskQuestion> = q_stmt
        .query_map(params![&row.task_id], |r| {
            let blocking_int: i64 = r.get(6)?;
            let urgency_raw: String = r.get(7)?;
            let options_raw: Option<String> = r.get(9)?;
            let status_raw: String = r.get(11)?;
            let res_src_raw: Option<String> = r.get(15)?;
            let resolution_source = res_src_raw.filter(|s| s == "user" || s == "default");
            Ok(TaskQuestion {
                id: r.get(0)?,
                task_id: row.task_id.clone(),
                thread_id: r.get(1)?,
                work_item_id: r.get(2)?,
                header: r.get(3)?,
                question: r.get(4)?,
                context: r.get(5)?,
                blocking: blocking_int == 1,
                urgency: TaskQuestionUrgency::parse(&urgency_raw)
                    .unwrap_or(TaskQuestionUrgency::BeforeDelivery),
                default_action: r.get(8)?,
                options: parse_question_options(options_raw),
                recommended_option_id: r.get(10)?,
                status: TaskQuestionStatus::parse(&status_raw)
                    .unwrap_or(TaskQuestionStatus::Pending),
                provisional_decision_id: r.get(12)?,
                answer: r.get(13)?,
                answer_option_id: r.get(14)?,
                resolution_source,
                supersedes: r.get(16)?,
                created_at: r.get(17)?,
                resolved_at: r.get(18)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut art_stmt = conn.prepare(
        "SELECT * FROM task_artifacts WHERE task_id = ?1 ORDER BY created_at, artifact_id",
    )?;
    let artifacts: Vec<TaskArtifact> = art_stmt
        .query_map(params![&row.task_id], |r| {
            map_artifact_from_row(r, &row.task_id)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut blk_stmt = conn.prepare(
        "SELECT blocker_id, work_item_id, description, blocking, status, created_at, resolved_at
         FROM task_blockers WHERE task_id = ?1 ORDER BY created_at, blocker_id",
    )?;
    let blockers: Vec<TaskBlocker> = blk_stmt
        .query_map(params![&row.task_id], |r| {
            let blocking_int: i64 = r.get(3)?;
            Ok(TaskBlocker {
                id: r.get(0)?,
                task_id: row.task_id.clone(),
                work_item_id: r.get(1)?,
                description: r.get(2)?,
                blocking: blocking_int == 1,
                status: r.get(4)?,
                created_at: r.get(5)?,
                resolved_at: r.get(6)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut act_stmt = conn.prepare(
        "SELECT activity_id, seq, thread_id, work_item_id, kind, summary, detail, created_at
         FROM task_activity WHERE task_id = ?1 ORDER BY seq DESC LIMIT 200",
    )?;
    let activity: Vec<TaskActivity> = act_stmt
        .query_map(params![&row.task_id], |r| {
            let kind_raw: String = r.get(4)?;
            Ok(TaskActivity {
                id: r.get(0)?,
                seq: r.get(1)?,
                task_id: row.task_id.clone(),
                thread_id: r.get(2)?,
                work_item_id: r.get(3)?,
                kind: TaskActivityKind::parse(&kind_raw)
                    .unwrap_or(TaskActivityKind::ProgressReported),
                summary: r.get(5)?,
                detail: r.get(6)?,
                created_at: r.get(7)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let latest_checkpoint = conn
        .query_row(
            "SELECT checkpoint_id, thread_id, task_revision, reason, agent_summary,
                    context_digest, task_snapshot_json, artifact_manifest_json, created_at
             FROM task_checkpoints WHERE task_id = ?1 ORDER BY created_at DESC LIMIT 1",
            params![&row.task_id],
            |r| {
                let snap_raw: Option<String> = r.get(6)?;
                let man_raw: Option<String> = r.get(7)?;
                Ok(TaskCheckpoint {
                    id: r.get(0)?,
                    task_id: row.task_id.clone(),
                    thread_id: r.get(1)?,
                    task_revision: r.get(2)?,
                    reason: r.get(3)?,
                    agent_summary: r.get(4)?,
                    context_digest: r.get(5)?,
                    task_snapshot: parse_json_object(snap_raw),
                    artifact_manifest: parse_artifact_manifest(man_raw),
                    created_at: r.get(8)?,
                })
            },
        )
        .optional()?;

    let completed_work_item_count = work_items
        .iter()
        .filter(|w| w.status == WorkItemStatus::Done)
        .count();
    let total_work_item_count = work_items.len();
    let active_blocker_count = blockers.iter().filter(|b| b.status == "active").count();
    let pending_question_count = questions
        .iter()
        .filter(|q| q.status == TaskQuestionStatus::Pending)
        .count();
    let blocking_question_count = questions
        .iter()
        .filter(|q| q.status == TaskQuestionStatus::Pending && q.blocking)
        .count();

    Ok(Some(TaskRecord {
        id: row.task_id,
        workspace_path: row.workspace_path,
        title: row.title,
        objective: row.objective,
        context: row.context,
        source_session_id: row.source_session_id,
        creation_origin: TaskCreationOrigin::parse(&row.creation_origin)
            .unwrap_or(TaskCreationOrigin::Manual),
        status: TaskStatus::parse(&row.status).unwrap_or(TaskStatus::Draft),
        revision: row.revision,
        review_required: row.review_required == 1,
        review_rounds: row.review_rounds,
        created_at: row.created_at,
        updated_at: row.updated_at,
        thread_count: threads.len(),
        completed_work_item_count,
        total_work_item_count,
        active_blocker_count,
        pending_question_count,
        blocking_question_count,
        requirements,
        threads,
        work_items,
        decisions,
        questions,
        artifacts,
        blockers,
        activity,
        latest_checkpoint,
    }))
}

fn require_task_sync(conn: &Connection, task_id: &str) -> Result<TaskRecord> {
    get_task_sync(conn, task_id)?
        .ok_or_else(|| StorageError::Task(format!("Unknown task: {task_id}")))
}

fn bump_revision_sync(
    conn: &Connection,
    task_id: &str,
    expected_revision: i64,
    updated_at: &str,
) -> Result<()> {
    let changes = conn.execute(
        "UPDATE tasks SET revision = revision + 1, updated_at = ?1 WHERE task_id = ?2 AND revision = ?3",
        params![updated_at, task_id, expected_revision],
    )?;
    if changes != 1 {
        let current: Option<i64> = conn
            .query_row(
                "SELECT revision FROM tasks WHERE task_id = ?1",
                params![task_id],
                |r| r.get(0),
            )
            .optional()?;
        match current {
            Some(cur) => {
                return Err(StorageError::TaskRevisionConflict {
                    expected: expected_revision,
                    current: cur,
                });
            }
            None => return Err(StorageError::Task(format!("Unknown task: {task_id}"))),
        }
    }
    Ok(())
}

fn bump_current_revision_sync(conn: &Connection, task_id: &str, updated_at: &str) -> Result<()> {
    let changes = conn.execute(
        "UPDATE tasks SET revision = revision + 1, updated_at = ?1 WHERE task_id = ?2",
        params![updated_at, task_id],
    )?;
    if changes != 1 {
        return Err(StorageError::Task(format!("Unknown task: {task_id}")));
    }
    Ok(())
}

fn assert_task_accepts_mutation_sync(conn: &Connection, task_id: &str) -> Result<()> {
    let status_raw: Option<String> = conn
        .query_row(
            "SELECT status FROM tasks WHERE task_id = ?1",
            params![task_id],
            |r| r.get(0),
        )
        .optional()?;
    let Some(raw) = status_raw else {
        return Err(StorageError::Task(format!("Unknown task: {task_id}")));
    };
    if let Some(status) = TaskStatus::parse(&raw)
        && status.is_terminal()
    {
        return Err(StorageError::Task(format!(
            "Task {task_id} is {} and cannot be changed until it is reopened or retried.",
            status.as_str()
        )));
    }
    Ok(())
}

fn insert_thread_sync(conn: &Connection, thread: &TaskThread) -> Result<()> {
    conn.execute(
        "INSERT INTO task_threads(thread_id, task_id, session_id, title, created_by, created_at, updated_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            &thread.id,
            &thread.task_id,
            &thread.session_id,
            &thread.title,
            &thread.created_by,
            &thread.created_at,
            &thread.updated_at,
        ],
    )?;
    Ok(())
}

fn insert_decision_sync(conn: &Connection, decision: &TaskDecision) -> Result<()> {
    if let Some(sup) = &decision.supersedes {
        conn.execute(
            "UPDATE task_decisions SET status = 'superseded' WHERE task_id = ?1 AND decision_id = ?2",
            params![&decision.task_id, sup],
        )?;
    }
    conn.execute(
        "INSERT INTO task_decisions(decision_id, task_id, question, resolution, source, scope, confidence, status, created_at, supersedes)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            &decision.id,
            &decision.task_id,
            &decision.question,
            &decision.resolution,
            &decision.source,
            &decision.scope,
            decision.confidence,
            &decision.status,
            &decision.created_at,
            &decision.supersedes,
        ],
    )?;
    Ok(())
}

fn insert_activity_sync(conn: &Connection, activity: &TaskActivity) -> Result<()> {
    let max_seq: i64 = conn.query_row(
        "SELECT COALESCE(MAX(seq), 0) FROM task_activity WHERE task_id = ?1",
        params![&activity.task_id],
        |r| r.get(0),
    )?;
    let next_seq = max_seq + 1;
    conn.execute(
        "INSERT INTO task_activity(activity_id, task_id, seq, thread_id, work_item_id, kind, summary, detail, created_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            &activity.id,
            &activity.task_id,
            next_seq,
            &activity.thread_id,
            &activity.work_item_id,
            activity.kind.as_str(),
            &activity.summary,
            &activity.detail,
            &activity.created_at,
        ],
    )?;
    Ok(())
}

fn insert_checkpoint_sync(conn: &Connection, checkpoint: &TaskCheckpoint) -> Result<()> {
    conn.execute(
        "INSERT INTO task_checkpoints(checkpoint_id, task_id, thread_id, task_revision, reason, agent_summary, context_digest, task_snapshot_json, artifact_manifest_json, created_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            &checkpoint.id,
            &checkpoint.task_id,
            &checkpoint.thread_id,
            checkpoint.task_revision,
            &checkpoint.reason,
            &checkpoint.agent_summary,
            &checkpoint.context_digest,
            serde_json::to_string(&checkpoint.task_snapshot)?,
            serde_json::to_string(&checkpoint.artifact_manifest)?,
            &checkpoint.created_at,
        ],
    )?;
    Ok(())
}

fn get_directive_receipt_sync(
    conn: &Connection,
    task_id: &str,
    idempotency_key: &str,
) -> Result<Option<i64>> {
    conn.query_row(
        "SELECT result_revision FROM task_directive_receipts WHERE task_id = ?1 AND idempotency_key = ?2",
        params![task_id, idempotency_key],
        |r| r.get(0),
    )
    .optional()
    .map_err(StorageError::from)
}

fn record_directive_receipt_sync(
    conn: &Connection,
    task_id: &str,
    idempotency_key: &str,
    result_revision: i64,
    created_at: &str,
) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO task_directive_receipts(task_id, idempotency_key, result_revision, created_at)
         VALUES(?1, ?2, ?3, ?4)",
        params![task_id, idempotency_key, result_revision, created_at],
    )?;
    Ok(())
}

fn record_directive_commit_in_open_tx(
    conn: &Connection,
    task: &TaskRecord,
    hooks: Option<&mut Option<TaskDirectiveCommitHooks>>,
) -> Result<Option<TaskCheckpoint>> {
    let Some(slot) = hooks else { return Ok(None) };
    let Some(mut h) = slot.take() else {
        return Ok(None);
    };
    let payload = (h.create)(task);
    let created = if get_directive_receipt_sync(conn, &task.id, &payload.idempotency_key)?.is_none()
    {
        insert_checkpoint_sync(conn, &payload.checkpoint)?;
        record_directive_receipt_sync(
            conn,
            &task.id,
            &payload.idempotency_key,
            task.revision,
            &payload.receipt_created_at,
        )?;
        Some(payload.checkpoint)
    } else {
        None
    };
    if let Some(cb) = h.on_committed.take() {
        *slot = Some(TaskDirectiveCommitHooks {
            create: Box::new(|_| unreachable!()),
            on_committed: Some(cb),
        });
    }
    Ok(created)
}

fn upsert_artifact_sync(conn: &Connection, artifact: &TaskArtifact) -> Result<()> {
    conn.execute(
        "INSERT INTO task_artifacts(artifact_id, task_id, work_item_id, thread_id, path, kind, title, created_by, provenance_json, created_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(task_id, path) DO UPDATE SET
           work_item_id = excluded.work_item_id,
           thread_id = excluded.thread_id,
           kind = excluded.kind,
           title = excluded.title,
           provenance_json = excluded.provenance_json",
        params![
            &artifact.id,
            &artifact.task_id,
            &artifact.work_item_id,
            &artifact.thread_id,
            &artifact.path,
            &artifact.kind,
            &artifact.title,
            &artifact.created_by,
            serde_json::to_string(&artifact.provenance)?,
            &artifact.created_at,
        ],
    )?;
    Ok(())
}

fn insert_artifact_version_sync(
    conn: &Connection,
    task_id: &str,
    version: &TaskArtifactVersion,
) -> Result<()> {
    let latest: Option<(String, i64)> = conn
        .query_row(
            "SELECT version_id, version_number FROM task_artifact_versions
             WHERE task_id = ?1 AND artifact_id = ?2 ORDER BY version_number DESC LIMIT 1",
            params![task_id, &version.artifact_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let expected_version = latest.as_ref().map(|(_, n)| *n).unwrap_or(0) + 1;
    if version.version != expected_version {
        return Err(StorageError::Task(format!(
            "Invalid artifact version number: expected {expected_version}, received {}",
            version.version
        )));
    }
    let latest_id = latest.map(|(id, _)| id);
    if latest_id != version.parent_version_id {
        return Err(StorageError::Task(
            "Artifact version parent is not the current latest version".to_string(),
        ));
    }
    conn.execute(
        "INSERT INTO task_artifact_versions(version_id, task_id, artifact_id, version_number, parent_version_id, sha256, size_bytes, media_type, created_by, created_at, change_summary, provenance_json, review_status)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            &version.id,
            task_id,
            &version.artifact_id,
            version.version,
            &version.parent_version_id,
            &version.sha256,
            version.size_bytes as i64,
            &version.media_type,
            &version.created_by,
            &version.created_at,
            &version.change_summary,
            serde_json::to_string(&version.provenance)?,
            version.review_status.as_str(),
        ],
    )?;
    Ok(())
}

fn supersede_pending_artifact_versions_sync(conn: &Connection, artifact_id: &str) -> Result<()> {
    conn.execute(
        "UPDATE task_artifact_versions SET review_status = 'superseded' WHERE artifact_id = ?1 AND review_status = 'draft'",
        params![artifact_id],
    )?;
    Ok(())
}

fn move_artifact_work_item_to_review_sync(
    conn: &Connection,
    task_id: &str,
    work_item_id: Option<&str>,
    updated_at: &str,
) -> Result<()> {
    let Some(wid) = work_item_id else {
        return Ok(());
    };
    conn.execute(
        "UPDATE task_work_items
         SET status = 'review',
             completion_evidence = COALESCE(completion_evidence, 'Artifact ready for review'),
             updated_at = ?1
         WHERE task_id = ?2 AND work_item_id = ?3 AND status NOT IN ('done', 'abandoned')",
        params![updated_at, task_id, wid],
    )?;
    conn.execute(
        "DELETE FROM task_work_item_claims WHERE work_item_id = ?1",
        params![wid],
    )?;
    Ok(())
}

fn abandon_revision_work_item_sync(
    conn: &Connection,
    task_id: &str,
    work_item_id: Option<&str>,
    updated_at: &str,
) -> Result<()> {
    let Some(wid) = work_item_id else {
        return Ok(());
    };
    conn.execute(
        "UPDATE task_work_items
         SET status = 'abandoned',
             completion_evidence = COALESCE(completion_evidence, 'Artifact revision abandoned because the task is terminal'),
             updated_at = ?1
         WHERE task_id = ?2 AND work_item_id = ?3 AND status NOT IN ('done', 'abandoned')",
        params![updated_at, task_id, wid],
    )?;
    conn.execute(
        "DELETE FROM task_work_item_claims WHERE work_item_id = ?1",
        params![wid],
    )?;
    Ok(())
}

fn abandon_active_artifact_revisions_for_terminal_task_sync(
    conn: &Connection,
    task_id: &str,
    updated_at: &str,
) -> Result<()> {
    let mut stmt = conn.prepare(
        "SELECT work_item_id FROM task_artifact_revisions WHERE task_id = ?1 AND status = 'active'",
    )?;
    let work_item_ids: Vec<Option<String>> = stmt
        .query_map(params![task_id], |r| r.get(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);

    conn.execute(
        "UPDATE task_artifact_revisions
         SET status = 'cancelled', settlement_status = 'none', updated_at = ?1, completed_at = ?1
         WHERE task_id = ?2 AND status = 'active'",
        params![updated_at, task_id],
    )?;
    for wid in work_item_ids {
        abandon_revision_work_item_sync(conn, task_id, wid.as_deref(), updated_at)?;
    }
    Ok(())
}

#[derive(Debug)]
struct RawRevisionMeta {
    task_id: String,
    artifact_id: String,
    work_item_id: String,
    task_thread_id: String,
    result_version_id: Option<String>,
    status: String,
}

fn require_artifact_revision_meta_sync(
    conn: &Connection,
    revision_id: &str,
) -> Result<RawRevisionMeta> {
    conn.query_row(
        "SELECT task_id, artifact_id, work_item_id, task_thread_id, result_version_id, status
         FROM task_artifact_revisions WHERE revision_id = ?1",
        params![revision_id],
        |r| {
            Ok(RawRevisionMeta {
                task_id: r.get(0)?,
                artifact_id: r.get(1)?,
                work_item_id: r.get(2)?,
                task_thread_id: r.get(3)?,
                result_version_id: r.get(4)?,
                status: r.get(5)?,
            })
        },
    )
    .optional()?
    .ok_or_else(|| StorageError::Task(format!("Unknown artifact revision: {revision_id}")))
}

fn complete_artifact_revision_in_open_tx(
    conn: &Connection,
    revision_id: &str,
    version: &TaskArtifactVersion,
    updated_at: &str,
    force_pending_settlement: bool,
) -> Result<()> {
    let meta = require_artifact_revision_meta_sync(conn, revision_id)?;
    if meta.status != "active" {
        return Ok(());
    }
    bump_current_revision_sync(conn, &meta.task_id, updated_at)?;
    let active_sibling: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM task_artifact_revisions WHERE task_id = ?1 AND revision_id != ?2 AND status = 'active' LIMIT 1",
            params![&meta.task_id, revision_id],
            |r| r.get(0),
        )
        .optional()?;
    let settlement_status = if active_sibling.is_some() || force_pending_settlement {
        PENDING_ARTIFACT_REVISION_SETTLEMENT
    } else {
        "none"
    };
    supersede_pending_artifact_versions_sync(conn, &meta.artifact_id)?;
    insert_artifact_version_sync(conn, &meta.task_id, version)?;
    conn.execute(
        "UPDATE task_artifact_revisions
         SET result_version_id = ?1, settlement_status = ?2, status = 'completed', updated_at = ?3, completed_at = ?3
         WHERE revision_id = ?4 AND status = 'active'",
        params![&version.id, settlement_status, updated_at, revision_id],
    )?;
    conn.execute(
        "UPDATE task_work_items
         SET status = 'review', completion_evidence = ?1, updated_at = ?2
         WHERE task_id = ?3 AND work_item_id = ?4",
        params![
            &version.change_summary,
            updated_at,
            &meta.task_id,
            &meta.work_item_id
        ],
    )?;
    conn.execute(
        "DELETE FROM task_work_item_claims WHERE work_item_id = ?1",
        params![&meta.work_item_id],
    )?;
    insert_activity_sync(
        conn,
        &TaskActivity {
            id: Uuid::new_v4().to_string(),
            seq: 1,
            task_id: meta.task_id,
            thread_id: Some(meta.task_thread_id),
            work_item_id: Some(meta.work_item_id),
            kind: TaskActivityKind::ArtifactRevisionCompleted,
            summary: format!(
                "Artifact revision ready for review (version {})",
                version.version
            ),
            detail: (!version.change_summary.is_empty()).then(|| version.change_summary.clone()),
            created_at: updated_at.to_owned(),
        },
    )?;
    Ok(())
}

fn fail_artifact_revision_in_open_tx(
    conn: &Connection,
    revision_id: &str,
    status: TaskArtifactRevisionStatus,
    updated_at: &str,
    detail: Option<&str>,
) -> Result<()> {
    let meta = require_artifact_revision_meta_sync(conn, revision_id)?;
    if meta.status != "active" {
        return Ok(());
    }
    bump_current_revision_sync(conn, &meta.task_id, updated_at)?;
    conn.execute(
        "UPDATE task_artifact_revisions
         SET status = ?1, settlement_status = 'none', updated_at = ?2, completed_at = ?2
         WHERE revision_id = ?3 AND status = 'active'",
        params![status.as_str(), updated_at, revision_id],
    )?;
    let wi_status = if status == TaskArtifactRevisionStatus::Cancelled {
        "abandoned"
    } else {
        "blocked"
    };
    conn.execute(
        "UPDATE task_work_items
         SET status = ?1, completion_evidence = ?2, updated_at = ?3
         WHERE task_id = ?4 AND work_item_id = ?5",
        params![
            wi_status,
            detail,
            updated_at,
            &meta.task_id,
            &meta.work_item_id
        ],
    )?;
    conn.execute(
        "DELETE FROM task_work_item_claims WHERE work_item_id = ?1",
        params![&meta.work_item_id],
    )?;
    insert_activity_sync(
        conn,
        &TaskActivity {
            id: Uuid::new_v4().to_string(),
            seq: 1,
            task_id: meta.task_id,
            thread_id: Some(meta.task_thread_id),
            work_item_id: Some(meta.work_item_id),
            kind: TaskActivityKind::ArtifactRevisionFailed,
            summary: if status == TaskArtifactRevisionStatus::Cancelled {
                "Artifact revision cancelled".to_string()
            } else {
                "Artifact revision failed".to_string()
            },
            detail: detail.map(str::to_owned),
            created_at: updated_at.to_owned(),
        },
    )?;
    Ok(())
}

fn set_status_in_open_tx(conn: &Connection, input: &SetTaskStatusInput) -> Result<()> {
    bump_revision_sync(
        conn,
        &input.task_id,
        input.expected_revision,
        &input.updated_at,
    )?;
    conn.execute(
        "UPDATE tasks SET status = ?1 WHERE task_id = ?2",
        params![input.status.as_str(), &input.task_id],
    )?;
    if input.status.is_terminal() {
        abandon_active_artifact_revisions_for_terminal_task_sync(
            conn,
            &input.task_id,
            &input.updated_at,
        )?;
    }
    if input.status == TaskStatus::Cancelled {
        conn.execute(
            "UPDATE task_decisions SET status = 'superseded'
             WHERE task_id = ?1 AND decision_id IN (
               SELECT provisional_decision_id FROM task_questions
               WHERE task_id = ?1 AND status = 'pending' AND provisional_decision_id IS NOT NULL
             )",
            params![&input.task_id],
        )?;
        conn.execute(
            "UPDATE task_questions SET status = 'dismissed', resolved_at = ?1
             WHERE task_id = ?2 AND status = 'pending'",
            params![&input.updated_at, &input.task_id],
        )?;
    }
    insert_activity_sync(
        conn,
        &TaskActivity {
            id: Uuid::new_v4().to_string(),
            seq: 1,
            task_id: input.task_id.clone(),
            thread_id: input.thread_id.clone(),
            work_item_id: None,
            kind: TaskActivityKind::StatusChanged,
            summary: input.summary.clone(),
            detail: input.detail.clone(),
            created_at: input.updated_at.clone(),
        },
    )?;
    Ok(())
}

fn accept_all_artifact_versions_in_open_tx(
    conn: &Connection,
    task_id: &str,
    expected_revision: i64,
    updated_at: &str,
) -> Result<()> {
    bump_revision_sync(conn, task_id, expected_revision, updated_at)?;
    conn.execute(
        "UPDATE task_artifact_versions
         SET review_status = 'superseded'
         WHERE task_id = ?1 AND review_status = 'accepted'
           AND artifact_id IN (
             SELECT artifact_id FROM task_artifact_versions
             WHERE task_id = ?1 AND review_status = 'draft'
             GROUP BY artifact_id
           )",
        params![task_id],
    )?;
    conn.execute(
        "UPDATE task_artifact_versions
         SET review_status = 'accepted'
         WHERE version_id IN (
           SELECT version_id FROM task_artifact_versions draft
           WHERE draft.task_id = ?1 AND draft.review_status = 'draft'
             AND draft.version_number = (
               SELECT MAX(latest.version_number) FROM task_artifact_versions latest
               WHERE latest.artifact_id = draft.artifact_id AND latest.review_status = 'draft'
             )
         )",
        params![task_id],
    )?;
    conn.execute(
        "UPDATE task_work_items
         SET status = 'done',
             completion_evidence = COALESCE(completion_evidence, 'Accepted with task delivery'),
             updated_at = ?1
         WHERE task_id = ?2 AND status = 'review'",
        params![updated_at, task_id],
    )?;
    conn.execute(
        "DELETE FROM task_work_item_claims WHERE task_id = ?1",
        params![task_id],
    )?;
    conn.execute(
        "UPDATE tasks SET status = 'completed' WHERE task_id = ?1",
        params![task_id],
    )?;
    insert_activity_sync(
        conn,
        &TaskActivity {
            id: Uuid::new_v4().to_string(),
            seq: 1,
            task_id: task_id.to_owned(),
            thread_id: None,
            work_item_id: None,
            kind: TaskActivityKind::StatusChanged,
            summary: "Task accepted".to_string(),
            detail: None,
            created_at: updated_at.to_owned(),
        },
    )?;
    Ok(())
}

fn settle_pending_artifact_revision_settlements_in_open_tx(
    conn: &Connection,
    task_id: &str,
    revision_ids: &[String],
    updated_at: &str,
) -> Result<()> {
    let _ = require_task_sync(conn, task_id)?;
    let mut unique_ids: Vec<String> = Vec::new();
    for id in revision_ids {
        if !unique_ids.contains(id) {
            unique_ids.push(id.clone());
        }
    }
    if unique_ids.is_empty() {
        return Ok(());
    }
    let placeholders = (0..unique_ids.len())
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "UPDATE task_artifact_revisions
         SET settlement_status = 'settled', updated_at = ?
         WHERE task_id = ? AND revision_id IN ({placeholders})
           AND status = 'completed' AND settlement_status = ?"
    );
    let mut bind_vals: Vec<String> = Vec::with_capacity(unique_ids.len() + 3);
    bind_vals.push(updated_at.to_owned());
    bind_vals.push(task_id.to_owned());
    bind_vals.extend(unique_ids.iter().cloned());
    bind_vals.push(PENDING_ARTIFACT_REVISION_SETTLEMENT.to_owned());
    let changes = conn.execute(&sql, params_from_iter(bind_vals.iter()))?;
    if changes != unique_ids.len() {
        return Err(StorageError::Task(
            "Pending artifact revision settlements changed before they could be consumed"
                .to_string(),
        ));
    }
    Ok(())
}

fn update_brief_in_open_tx(
    conn: &Connection,
    task_id: &str,
    title: Option<&str>,
    objective: Option<&str>,
    requirements: Option<&[TaskRequirement]>,
    updated_at: &str,
) -> Result<()> {
    if let Some(t) = title {
        conn.execute(
            "UPDATE tasks SET title = ?1 WHERE task_id = ?2",
            params![t, task_id],
        )?;
    }
    if let Some(obj) = objective {
        conn.execute(
            "UPDATE tasks SET objective = ?1 WHERE task_id = ?2",
            params![obj, task_id],
        )?;
    }
    if let Some(reqs) = requirements {
        conn.execute(
            "DELETE FROM task_requirements WHERE task_id = ?1",
            params![task_id],
        )?;
        for req in reqs {
            conn.execute(
                "INSERT INTO task_requirements(requirement_id, task_id, kind, text, source, permanence, status, created_at, supersedes)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    &req.id,
                    task_id,
                    req.kind.as_str(),
                    &req.text,
                    &req.source,
                    &req.permanence,
                    &req.status,
                    &req.created_at,
                    &req.supersedes,
                ],
            )?;
        }
    }
    insert_activity_sync(
        conn,
        &TaskActivity {
            id: Uuid::new_v4().to_string(),
            seq: 1,
            task_id: task_id.to_owned(),
            thread_id: None,
            work_item_id: None,
            kind: TaskActivityKind::BriefUpdated,
            summary: "Task brief updated".to_string(),
            detail: None,
            created_at: updated_at.to_owned(),
        },
    )?;
    Ok(())
}

fn replace_work_items_in_open_tx(
    conn: &Connection,
    task_id: &str,
    items: &[TaskWorkItemRecordInput],
    updated_at: &str,
) -> Result<()> {
    let mut existing_stmt =
        conn.prepare("SELECT work_item_id FROM task_work_items WHERE task_id = ?1")?;
    let existing_ids: HashSet<String> = existing_stmt
        .query_map(params![task_id], |r| r.get(0))?
        .collect::<rusqlite::Result<HashSet<_>>>()?;
    drop(existing_stmt);

    let input_ids: HashSet<String> = items.iter().map(|i| i.id.clone()).collect();
    for existing_id in &existing_ids {
        if input_ids.contains(existing_id) {
            continue;
        }
        let active_rev: Option<String> = conn
            .query_row(
                "SELECT revision_id FROM task_artifact_revisions
                 WHERE task_id = ?1 AND work_item_id = ?2
                   AND (status = 'active' OR (status = 'completed' AND settlement_status = ?3))
                 LIMIT 1",
                params![task_id, existing_id, PENDING_ARTIFACT_REVISION_SETTLEMENT],
                |r| r.get(0),
            )
            .optional()?;
        if active_rev.is_some() {
            return Err(StorageError::Task(format!(
                "Cannot remove work item with active artifact revision or deferred artifact revision: {existing_id}"
            )));
        }
    }

    conn.execute(
        "DELETE FROM task_work_item_dependencies WHERE task_id = ?1",
        params![task_id],
    )?;
    conn.execute(
        "DELETE FROM task_work_item_claims WHERE task_id = ?1",
        params![task_id],
    )?;

    for existing_id in &existing_ids {
        if !input_ids.contains(existing_id) {
            conn.execute(
                "DELETE FROM task_work_items WHERE task_id = ?1 AND work_item_id = ?2",
                params![task_id, existing_id],
            )?;
        }
    }

    for item in items {
        if existing_ids.contains(&item.id) {
            conn.execute(
                "UPDATE task_work_items
                 SET title = ?1, description = ?2, status = ?3, assigned_thread_id = ?4,
                     expected_outputs_json = ?5, completion_evidence = ?6, position = ?7, updated_at = ?8
                 WHERE task_id = ?9 AND work_item_id = ?10",
                params![
                    &item.title,
                    &item.description,
                    item.status.as_str(),
                    &item.assigned_thread_id,
                    serde_json::to_string(&item.expected_outputs)?,
                    &item.completion_evidence,
                    item.position,
                    updated_at,
                    task_id,
                    &item.id,
                ],
            )?;
            continue;
        }
        let conflicting_owner: Option<String> = conn
            .query_row(
                "SELECT task_id FROM task_work_items WHERE work_item_id = ?1",
                params![&item.id],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(owner) = conflicting_owner
            && owner != task_id
        {
            return Err(StorageError::Task(format!(
                "Work item id already belongs to another task: {}",
                item.id
            )));
        }
        conn.execute(
            "INSERT INTO task_work_items(work_item_id, task_id, title, description, status, assigned_thread_id, expected_outputs_json, completion_evidence, position, created_at, updated_at)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                &item.id,
                task_id,
                &item.title,
                &item.description,
                item.status.as_str(),
                &item.assigned_thread_id,
                serde_json::to_string(&item.expected_outputs)?,
                &item.completion_evidence,
                item.position,
                &item.created_at,
                &item.updated_at,
            ],
        )?;
    }

    for item in items {
        for dep_id in &item.depends_on {
            conn.execute(
                "INSERT INTO task_work_item_dependencies(task_id, work_item_id, depends_on_work_item_id)
                 VALUES(?1, ?2, ?3)",
                params![task_id, &item.id, dep_id],
            )?;
        }
        if let Some(claimed_by) = &item.claimed_by_thread_id {
            conn.execute(
                "INSERT INTO task_work_item_claims(work_item_id, task_id, thread_id, claimed_at)
                 VALUES(?1, ?2, ?3, ?4)",
                params![&item.id, task_id, claimed_by, updated_at],
            )?;
        }
    }

    insert_activity_sync(
        conn,
        &TaskActivity {
            id: Uuid::new_v4().to_string(),
            seq: 1,
            task_id: task_id.to_owned(),
            thread_id: None,
            work_item_id: None,
            kind: TaskActivityKind::PlanUpdated,
            summary: format!("Work plan updated ({} items)", items.len()),
            detail: None,
            created_at: updated_at.to_owned(),
        },
    )?;
    Ok(())
}

fn get_artifact_detail_sync(
    conn: &Connection,
    task_id: &str,
    artifact_id: &str,
) -> Result<Option<TaskArtifactDetail>> {
    let artifact = conn
        .query_row(
            "SELECT * FROM task_artifacts WHERE task_id = ?1 AND artifact_id = ?2",
            params![task_id, artifact_id],
            |r| map_artifact_from_row(r, task_id),
        )
        .optional()?;
    let Some(artifact) = artifact else {
        return Ok(None);
    };

    let mut v_stmt = conn.prepare(
        "SELECT * FROM task_artifact_versions WHERE task_id = ?1 AND artifact_id = ?2 ORDER BY version_number ASC",
    )?;
    let versions: Vec<TaskArtifactVersion> = v_stmt
        .query_map(params![task_id, artifact_id], map_artifact_version_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let active_revision = conn
        .query_row(
            "SELECT * FROM task_artifact_revisions WHERE task_id = ?1 AND artifact_id = ?2 AND status = 'active' ORDER BY created_at DESC LIMIT 1",
            params![task_id, artifact_id],
            map_artifact_revision_from_row,
        )
        .optional()?;

    let latest_version_id = versions.last().map(|v| v.id.clone());
    let accepted_version_id = versions
        .iter()
        .rev()
        .find(|v| v.review_status == TaskArtifactVersionReviewStatus::Accepted)
        .map(|v| v.id.clone());

    Ok(Some(TaskArtifactDetail {
        artifact,
        versions,
        latest_version_id,
        accepted_version_id,
        active_revision,
    }))
}

impl SessionDb {
    pub fn get_task(&self, task_id: &str) -> Result<Option<TaskRecord>> {
        self.with_read_conn(|conn| get_task_sync(conn, task_id))
    }

    pub fn get_task_by_creation_key(
        &self,
        idempotency_key: &str,
        source_session_id: Option<&str>,
        workspace_path: Option<&str>,
    ) -> Result<Option<TaskRecord>> {
        self.with_read_conn(|conn| {
            let task_id: Option<String> = if let Some(sid) = source_session_id {
                conn.query_row(
                    "SELECT task_id FROM tasks WHERE source_session_id = ?1 AND creation_idempotency_key = ?2",
                    params![sid, idempotency_key],
                    |r| r.get(0),
                )
                .optional()?
            } else if let Some(ws) = workspace_path {
                conn.query_row(
                    "SELECT task_id FROM tasks WHERE source_session_id IS NULL AND workspace_path = ?1 AND creation_idempotency_key = ?2",
                    params![ws, idempotency_key],
                    |r| r.get(0),
                )
                .optional()?
            } else {
                conn.query_row(
                    "SELECT task_id FROM tasks WHERE creation_idempotency_key = ?1 ORDER BY created_at DESC LIMIT 1",
                    params![idempotency_key],
                    |r| r.get(0),
                )
                .optional()?
            };
            match task_id {
                Some(id) => get_task_sync(conn, &id),
                None => Ok(None),
            }
        })
    }

    pub fn get_active_task_for_source_session(
        &self,
        session_id: &str,
    ) -> Result<Option<TaskRecord>> {
        self.with_read_conn(|conn| {
            let task_id: Option<String> = conn
                .query_row(
                    "SELECT task_id FROM tasks
                     WHERE source_session_id = ?1
                       AND status NOT IN ('completed', 'failed', 'cancelled')
                     ORDER BY created_at DESC LIMIT 1",
                    params![session_id],
                    |r| r.get(0),
                )
                .optional()?;
            match task_id {
                Some(id) => get_task_sync(conn, &id),
                None => Ok(None),
            }
        })
    }

    pub fn list_tasks(&self, workspace_path: Option<&str>) -> Result<Vec<TaskSummary>> {
        let canonical_ws = workspace_path.map(|ws| {
            canonicalize_sync(Path::new(ws))
                .to_string_lossy()
                .into_owned()
        });
        self.with_read_conn(|conn| {
            let base_sql = "SELECT task.task_id, task.workspace_path, task.title, task.objective, task.context,
                  task.source_session_id, task.creation_origin, task.status, task.revision,
                  task.review_required, task.review_rounds, task.created_at, task.updated_at,
                  (SELECT COUNT(*) FROM task_threads WHERE task_id = task.task_id) AS thread_count,
                  (SELECT COUNT(*) FROM task_work_items WHERE task_id = task.task_id AND status = 'done') AS completed_work_item_count,
                  (SELECT COUNT(*) FROM task_work_items WHERE task_id = task.task_id) AS total_work_item_count,
                  COALESCE(blockers.active_count, 0) AS active_blocker_count,
                  (SELECT COUNT(*) FROM task_questions WHERE task_id = task.task_id AND status = 'pending') AS pending_question_count,
                  (SELECT COUNT(*) FROM task_questions WHERE task_id = task.task_id AND status = 'pending' AND blocking = 1) AS blocking_question_count
                FROM tasks AS task
                LEFT JOIN (
                  SELECT task_id, COUNT(*) AS active_count FROM task_blockers
                  WHERE status = 'active' GROUP BY task_id
                ) AS blockers ON blockers.task_id = task.task_id";
            let map_row = |r: &rusqlite::Row<'_>| -> rusqlite::Result<TaskSummary> {
                let origin_raw: String = r.get(6)?;
                let status_raw: String = r.get(7)?;
                let rev_req: i64 = r.get(9)?;
                Ok(TaskSummary {
                    id: r.get(0)?,
                    workspace_path: r.get(1)?,
                    title: r.get(2)?,
                    objective: r.get(3)?,
                    context: r.get(4)?,
                    source_session_id: r.get(5)?,
                    creation_origin: TaskCreationOrigin::parse(&origin_raw)
                        .unwrap_or(TaskCreationOrigin::Manual),
                    status: TaskStatus::parse(&status_raw).unwrap_or(TaskStatus::Draft),
                    revision: r.get(8)?,
                    review_required: rev_req == 1,
                    review_rounds: r.get(10)?,
                    created_at: r.get(11)?,
                    updated_at: r.get(12)?,
                    thread_count: r.get::<_, i64>(13)?.max(0) as usize,
                    completed_work_item_count: r.get::<_, i64>(14)?.max(0) as usize,
                    total_work_item_count: r.get::<_, i64>(15)?.max(0) as usize,
                    active_blocker_count: r.get::<_, i64>(16)?.max(0) as usize,
                    pending_question_count: r.get::<_, i64>(17)?.max(0) as usize,
                    blocking_question_count: r.get::<_, i64>(18)?.max(0) as usize,
                })
            };

            if let Some(ws) = canonical_ws {
                let sql = format!("{base_sql} WHERE task.workspace_path = ?1 ORDER BY task.updated_at DESC");
                let mut stmt = conn.prepare(&sql)?;
                let rows = stmt
                    .query_map(params![ws], map_row)?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            } else {
                let sql = format!("{base_sql} ORDER BY task.updated_at DESC");
                let mut stmt = conn.prepare(&sql)?;
                let rows = stmt
                    .query_map([], map_row)?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            }
        })
    }

    pub fn get_task_for_thread(&self, session_id: &str) -> Result<Option<TaskRecord>> {
        self.with_read_conn(|conn| {
            let task_id: Option<String> = conn
                .query_row(
                    "SELECT task_id FROM task_threads WHERE session_id = ?1",
                    params![session_id],
                    |r| r.get(0),
                )
                .optional()?;
            match task_id {
                Some(id) => get_task_sync(conn, &id),
                None => Ok(None),
            }
        })
    }

    pub fn list_task_reviews(&self, task_id: &str) -> Result<Vec<TaskReviewRecord>> {
        self.with_read_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT * FROM task_reviews WHERE task_id = ?1 ORDER BY round, created_at",
            )?;
            let rows = stmt
                .query_map(params![task_id], map_review_from_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
    }

    pub fn is_task_thread(&self, session_id: &str) -> Result<bool> {
        self.with_read_conn(|conn| {
            let found: Option<i64> = conn
                .query_row(
                    "SELECT 1 FROM task_threads WHERE session_id = ?1",
                    params![session_id],
                    |r| r.get(0),
                )
                .optional()?;
            Ok(found.is_some())
        })
    }

    pub fn get_task_artifact_detail(
        &self,
        task_id: &str,
        artifact_id: &str,
    ) -> Result<Option<TaskArtifactDetail>> {
        self.with_read_conn(|conn| get_artifact_detail_sync(conn, task_id, artifact_id))
    }

    pub fn get_task_artifact_version(
        &self,
        task_id: &str,
        artifact_id: &str,
        version_id: &str,
    ) -> Result<Option<TaskArtifactVersion>> {
        self.with_read_conn(|conn| {
            conn.query_row(
                "SELECT * FROM task_artifact_versions WHERE task_id = ?1 AND artifact_id = ?2 AND version_id = ?3",
                params![task_id, artifact_id, version_id],
                map_artifact_version_from_row,
            )
            .optional()
            .map_err(StorageError::from)
        })
    }

    pub fn get_active_task_artifact_revision_for_session(
        &self,
        session_id: &str,
    ) -> Result<Option<TaskArtifactRevision>> {
        self.with_read_conn(|conn| {
            conn.query_row(
                "SELECT * FROM task_artifact_revisions WHERE session_id = ?1 AND status = 'active' ORDER BY created_at DESC LIMIT 1",
                params![session_id],
                map_artifact_revision_from_row,
            )
            .optional()
            .map_err(StorageError::from)
        })
    }

    pub fn get_task_artifact_revision_for_session(
        &self,
        session_id: &str,
    ) -> Result<Option<TaskArtifactRevision>> {
        self.with_read_conn(|conn| {
            conn.query_row(
                "SELECT * FROM task_artifact_revisions WHERE session_id = ?1 ORDER BY created_at DESC LIMIT 1",
                params![session_id],
                map_artifact_revision_from_row,
            )
            .optional()
            .map_err(StorageError::from)
        })
    }

    pub fn get_task_artifact_revision(
        &self,
        revision_id: &str,
    ) -> Result<Option<TaskArtifactRevision>> {
        self.with_read_conn(|conn| {
            conn.query_row(
                "SELECT * FROM task_artifact_revisions WHERE revision_id = ?1",
                params![revision_id],
                map_artifact_revision_from_row,
            )
            .optional()
            .map_err(StorageError::from)
        })
    }

    pub fn get_task_artifact_revision_prior_task_status(
        &self,
        revision_id: &str,
    ) -> Result<Option<TaskStatus>> {
        self.with_read_conn(|conn| {
            let raw: Option<String> = conn
                .query_row(
                    "SELECT prior_task_status FROM task_artifact_revisions WHERE revision_id = ?1",
                    params![revision_id],
                    |r| r.get(0),
                )
                .optional()?;
            Ok(raw.and_then(|s| TaskStatus::parse(&s)))
        })
    }

    pub fn has_completed_task_artifact_revision_for_work_item(
        &self,
        task_id: &str,
        work_item_id: &str,
    ) -> Result<bool> {
        self.with_read_conn(|conn| {
            let found: Option<i64> = conn
                .query_row(
                    "SELECT 1 FROM task_artifact_revisions
                     WHERE task_id = ?1 AND work_item_id = ?2 AND status = 'completed' AND result_version_id IS NOT NULL
                     LIMIT 1",
                    params![task_id, work_item_id],
                    |r| r.get(0),
                )
                .optional()?;
            Ok(found.is_some())
        })
    }

    pub fn has_pending_task_artifact_revision_settlement(&self, task_id: &str) -> Result<bool> {
        self.with_read_conn(|conn| {
            let found: Option<i64> = conn
                .query_row(
                    "SELECT 1 FROM task_artifact_revisions
                     WHERE task_id = ?1 AND status = 'completed' AND result_version_id IS NOT NULL AND settlement_status = ?2
                     LIMIT 1",
                    params![task_id, PENDING_ARTIFACT_REVISION_SETTLEMENT],
                    |r| r.get(0),
                )
                .optional()?;
            Ok(found.is_some())
        })
    }

    pub fn has_pending_task_artifact_revision_settlement_for_work_item(
        &self,
        task_id: &str,
        work_item_id: &str,
    ) -> Result<bool> {
        self.with_read_conn(|conn| {
            let found: Option<i64> = conn
                .query_row(
                    "SELECT 1 FROM task_artifact_revisions
                     WHERE task_id = ?1 AND work_item_id = ?2 AND status = 'completed' AND result_version_id IS NOT NULL AND settlement_status = ?3
                     LIMIT 1",
                    params![task_id, work_item_id, PENDING_ARTIFACT_REVISION_SETTLEMENT],
                    |r| r.get(0),
                )
                .optional()?;
            Ok(found.is_some())
        })
    }

    pub fn list_pending_task_artifact_revision_settlement_ids(
        &self,
        task_id: &str,
    ) -> Result<Vec<String>> {
        self.with_read_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT revision_id FROM task_artifact_revisions
                 WHERE task_id = ?1 AND status = 'completed' AND result_version_id IS NOT NULL AND settlement_status = ?2
                 ORDER BY completed_at ASC, revision_id ASC",
            )?;
            let ids = stmt
                .query_map(params![task_id, PENDING_ARTIFACT_REVISION_SETTLEMENT], |r| {
                    r.get(0)
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(ids)
        })
    }

    pub fn list_task_artifact_revision_output_paths_for_work_item(
        &self,
        task_id: &str,
        work_item_id: &str,
    ) -> Result<Vec<String>> {
        self.with_read_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT DISTINCT artifact.path
                 FROM task_artifact_revisions revision
                 JOIN task_artifacts artifact
                   ON artifact.task_id = revision.task_id AND artifact.artifact_id = revision.artifact_id
                 WHERE revision.task_id = ?1 AND revision.work_item_id = ?2 AND revision.status IN ('completed', 'cancelled')",
            )?;
            let paths = stmt
                .query_map(params![task_id, work_item_id], |r| r.get(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(paths)
        })
    }

    pub fn list_coordinator_owned_task_artifact_revision_work_item_ids(
        &self,
        task_id: &str,
    ) -> Result<Vec<String>> {
        self.with_read_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT DISTINCT work_item_id FROM task_artifact_revisions
                 WHERE task_id = ?1 AND (status = 'active' OR (status = 'completed' AND settlement_status = ?2))",
            )?;
            let ids = stmt
                .query_map(params![task_id, PENDING_ARTIFACT_REVISION_SETTLEMENT], |r| {
                    r.get(0)
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(ids)
        })
    }

    pub fn has_cancelled_task_artifact_revision_for_work_item(
        &self,
        task_id: &str,
        work_item_id: &str,
    ) -> Result<bool> {
        self.with_read_conn(|conn| {
            let found: Option<i64> = conn
                .query_row(
                    "SELECT 1 FROM task_artifact_revisions
                     WHERE task_id = ?1 AND work_item_id = ?2 AND status = 'cancelled'
                     LIMIT 1",
                    params![task_id, work_item_id],
                    |r| r.get(0),
                )
                .optional()?;
            Ok(found.is_some())
        })
    }

    pub fn get_task_directive_receipt(
        &self,
        task_id: &str,
        idempotency_key: &str,
    ) -> Result<Option<i64>> {
        self.with_read_conn(|conn| get_directive_receipt_sync(conn, task_id, idempotency_key))
    }

    // =========================================================================
    // Exclusive write methods
    // =========================================================================

    pub async fn create_task_record(&self, input: CreateTaskRecordInput) -> Result<TaskRecord> {
        self.write_coordinator
            .run_exclusive("create_task", || async move {
                self.with_rw_conn_mut(|conn| {
                    let tx = conn.transaction()?;
                    let now = input.thread.created_at.clone();
                    tx.execute(
                        "INSERT INTO tasks(
                           task_id, workspace_path, title, objective, context,
                           source_session_id, creation_origin, creation_idempotency_key,
                           status, revision, review_required, review_rounds, created_at, updated_at
                         ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10, ?11, ?12, ?13)",
                        params![
                            &input.id,
                            &input.workspace_path,
                            &input.title,
                            &input.objective,
                            &input.context,
                            &input.source_session_id,
                            input.creation_origin.as_str(),
                            &input.creation_idempotency_key,
                            input.initial_status.as_str(),
                            if input.review_required { 1i64 } else { 0i64 },
                            input.review_rounds,
                            &now,
                            &now,
                        ],
                    )?;
                    insert_thread_sync(&tx, &input.thread)?;
                    for req in &input.requirements {
                        tx.execute(
                            "INSERT INTO task_requirements(requirement_id, task_id, kind, text, source, permanence, status, created_at, supersedes)
                             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                            params![
                                &req.id,
                                &input.id,
                                req.kind.as_str(),
                                &req.text,
                                &req.source,
                                &req.permanence,
                                &req.status,
                                &req.created_at,
                                &req.supersedes,
                            ],
                        )?;
                    }
                    for item in &input.work_items {
                        tx.execute(
                            "INSERT INTO task_work_items(work_item_id, task_id, title, description, status, assigned_thread_id, expected_outputs_json, completion_evidence, position, created_at, updated_at)
                             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                            params![
                                &item.id,
                                &input.id,
                                &item.title,
                                &item.description,
                                item.status.as_str(),
                                &item.assigned_thread_id,
                                serde_json::to_string(&item.expected_outputs)?,
                                &item.completion_evidence,
                                item.position,
                                &item.created_at,
                                &item.updated_at,
                            ],
                        )?;
                    }
                    for item in &input.work_items {
                        for dep in &item.depends_on {
                            tx.execute(
                                "INSERT INTO task_work_item_dependencies(task_id, work_item_id, depends_on_work_item_id)
                                 VALUES(?1, ?2, ?3)",
                                params![&input.id, &item.id, dep],
                            )?;
                        }
                    }
                    for dec in &input.decisions {
                        insert_decision_sync(&tx, dec)?;
                    }
                    insert_activity_sync(
                        &tx,
                        &TaskActivity {
                            id: Uuid::new_v4().to_string(),
                            seq: 1,
                            task_id: input.id.clone(),
                            thread_id: Some(input.thread.id.clone()),
                            work_item_id: None,
                            kind: TaskActivityKind::TaskCreated,
                            summary: format!("Task created: {}", input.title),
                            detail: None,
                            created_at: now,
                        },
                    )?;
                    tx.commit()?;
                    require_task_sync(conn, &input.id)
                })
            })
            .await
    }

    pub async fn add_task_thread(
        &self,
        thread: TaskThread,
        expected_revision: i64,
    ) -> Result<TaskRecord> {
        self.write_coordinator
            .run_exclusive("add_task_thread", || async move {
                self.with_rw_conn_mut(|conn| {
                    let tx = conn.transaction()?;
                    bump_revision_sync(
                        &tx,
                        &thread.task_id,
                        expected_revision,
                        &thread.updated_at,
                    )?;
                    insert_thread_sync(&tx, &thread)?;
                    insert_activity_sync(
                        &tx,
                        &TaskActivity {
                            id: Uuid::new_v4().to_string(),
                            seq: 1,
                            task_id: thread.task_id.clone(),
                            thread_id: Some(thread.id.clone()),
                            work_item_id: None,
                            kind: TaskActivityKind::ThreadCreated,
                            summary: format!("Thread created: {}", thread.title),
                            detail: None,
                            created_at: thread.created_at.clone(),
                        },
                    )?;
                    tx.commit()?;
                    require_task_sync(conn, &thread.task_id)
                })
            })
            .await
    }

    pub async fn update_task_brief(
        &self,
        task_id: String,
        expected_revision: i64,
        title: Option<String>,
        objective: Option<String>,
        requirements: Option<Vec<TaskRequirement>>,
        updated_at: String,
    ) -> Result<TaskRecord> {
        self.write_coordinator
            .run_exclusive("update_task_brief", || async move {
                self.with_rw_conn_mut(|conn| {
                    let tx = conn.transaction()?;
                    bump_revision_sync(&tx, &task_id, expected_revision, &updated_at)?;
                    update_brief_in_open_tx(
                        &tx,
                        &task_id,
                        title.as_deref(),
                        objective.as_deref(),
                        requirements.as_deref(),
                        &updated_at,
                    )?;
                    tx.commit()?;
                    require_task_sync(conn, &task_id)
                })
            })
            .await
    }

    pub async fn update_task_plan(&self, input: UpdateTaskPlanInput) -> Result<TaskRecord> {
        self.write_coordinator
            .run_exclusive("update_task_plan", || async move {
                self.with_rw_conn_mut(|conn| {
                    let tx = conn.transaction()?;
                    bump_revision_sync(
                        &tx,
                        &input.task_id,
                        input.expected_revision,
                        &input.updated_at,
                    )?;
                    if input.title.is_some()
                        || input.objective.is_some()
                        || input.requirements.is_some()
                    {
                        update_brief_in_open_tx(
                            &tx,
                            &input.task_id,
                            input.title.as_deref(),
                            input.objective.as_deref(),
                            input.requirements.as_deref(),
                            &input.updated_at,
                        )?;
                    }
                    replace_work_items_in_open_tx(
                        &tx,
                        &input.task_id,
                        &input.items,
                        &input.updated_at,
                    )?;
                    tx.commit()?;
                    require_task_sync(conn, &input.task_id)
                })
            })
            .await
    }

    pub async fn replace_task_work_items(
        &self,
        task_id: String,
        expected_revision: i64,
        items: Vec<TaskWorkItemRecordInput>,
        updated_at: String,
    ) -> Result<TaskRecord> {
        self.write_coordinator
            .run_exclusive("replace_task_work_items", || async move {
                self.with_rw_conn_mut(|conn| {
                    let tx = conn.transaction()?;
                    bump_revision_sync(&tx, &task_id, expected_revision, &updated_at)?;
                    replace_work_items_in_open_tx(&tx, &task_id, &items, &updated_at)?;
                    tx.commit()?;
                    require_task_sync(conn, &task_id)
                })
            })
            .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn update_task_work_item(
        &self,
        task_id: String,
        work_item_id: String,
        expected_revision: i64,
        status: WorkItemStatus,
        completion_evidence: Option<String>,
        updated_at: String,
        thread_id: Option<String>,
    ) -> Result<TaskRecord> {
        self.write_coordinator
            .run_exclusive("update_task_work_item", || async move {
                self.with_rw_conn_mut(|conn| {
                    let tx = conn.transaction()?;
                    bump_revision_sync(&tx, &task_id, expected_revision, &updated_at)?;
                    let changes = tx.execute(
                        "UPDATE task_work_items
                         SET status = ?1,
                             completion_evidence = COALESCE(?2, completion_evidence),
                             updated_at = ?3
                         WHERE task_id = ?4 AND work_item_id = ?5",
                        params![
                            status.as_str(),
                            &completion_evidence,
                            &updated_at,
                            &task_id,
                            &work_item_id,
                        ],
                    )?;
                    if changes != 1 {
                        return Err(StorageError::Task("Unknown work item".to_string()));
                    }
                    if matches!(
                        status,
                        WorkItemStatus::Done | WorkItemStatus::Abandoned | WorkItemStatus::Blocked
                    ) {
                        tx.execute(
                            "DELETE FROM task_work_item_claims WHERE work_item_id = ?1",
                            params![&work_item_id],
                        )?;
                    }
                    insert_activity_sync(
                        &tx,
                        &TaskActivity {
                            id: Uuid::new_v4().to_string(),
                            seq: 1,
                            task_id: task_id.clone(),
                            thread_id,
                            work_item_id: Some(work_item_id),
                            kind: TaskActivityKind::WorkItemUpdated,
                            summary: format!(
                                "Work item marked {}",
                                status.as_str().replace('_', " ")
                            ),
                            detail: completion_evidence,
                            created_at: updated_at,
                        },
                    )?;
                    tx.commit()?;
                    require_task_sync(conn, &task_id)
                })
            })
            .await
    }

    pub async fn claim_task_work_item(
        &self,
        task_id: String,
        work_item_id: String,
        thread_id: String,
        expected_revision: i64,
        claimed_at: String,
    ) -> Result<TaskRecord> {
        self.write_coordinator
            .run_exclusive("claim_task_work_item", || async move {
                self.with_rw_conn_mut(|conn| {
                    let tx = conn.transaction()?;
                    bump_revision_sync(&tx, &task_id, expected_revision, &claimed_at)?;
                    let existing_owner: Option<String> = tx
                        .query_row(
                            "SELECT thread_id FROM task_work_item_claims WHERE work_item_id = ?1",
                            params![&work_item_id],
                            |r| r.get(0),
                        )
                        .optional()?;
                    if let Some(owner) = existing_owner
                        && owner != thread_id
                    {
                        return Err(StorageError::Task(
                            "Work item is already claimed by another task thread".to_string(),
                        ));
                    }
                    tx.execute(
                        "INSERT OR REPLACE INTO task_work_item_claims(work_item_id, task_id, thread_id, claimed_at)
                         VALUES(?1, ?2, ?3, ?4)",
                        params![&work_item_id, &task_id, &thread_id, &claimed_at],
                    )?;
                    tx.execute(
                        "UPDATE task_work_items SET status = 'in_progress', assigned_thread_id = ?1, updated_at = ?2
                         WHERE task_id = ?3 AND work_item_id = ?4",
                        params![&thread_id, &claimed_at, &task_id, &work_item_id],
                    )?;
                    tx.commit()?;
                    require_task_sync(conn, &task_id)
                })
            })
            .await
    }

    pub async fn record_task_decision(
        &self,
        decision: TaskDecision,
        expected_revision: i64,
        updated_at: String,
    ) -> Result<TaskRecord> {
        self.write_coordinator
            .run_exclusive("record_task_decision", || async move {
                self.with_rw_conn_mut(|conn| {
                    let tx = conn.transaction()?;
                    bump_revision_sync(&tx, &decision.task_id, expected_revision, &updated_at)?;
                    insert_decision_sync(&tx, &decision)?;
                    insert_activity_sync(
                        &tx,
                        &TaskActivity {
                            id: Uuid::new_v4().to_string(),
                            seq: 1,
                            task_id: decision.task_id.clone(),
                            thread_id: None,
                            work_item_id: None,
                            kind: TaskActivityKind::DecisionRecorded,
                            summary: decision.question.clone(),
                            detail: Some(decision.resolution.clone()),
                            created_at: updated_at,
                        },
                    )?;
                    tx.commit()?;
                    require_task_sync(conn, &decision.task_id)
                })
            })
            .await
    }

    pub async fn queue_task_questions(&self, input: QueueTaskQuestionsInput) -> Result<TaskRecord> {
        self.write_coordinator
            .run_exclusive("queue_task_questions", || async move {
                self.with_rw_conn_mut(|conn| {
                    let tx = conn.transaction()?;
                    bump_revision_sync(
                        &tx,
                        &input.task_id,
                        input.expected_revision,
                        &input.updated_at,
                    )?;
                    let prov_by_id: HashMap<String, &TaskDecision> = input
                        .provisional_decisions
                        .iter()
                        .map(|d| (d.id.clone(), d))
                        .collect();

                    for q in &input.questions {
                        if let Some(sup_id) = &q.supersedes {
                            let prior: Option<(Option<String>,)> = tx
                                .query_row(
                                    "SELECT provisional_decision_id FROM task_questions
                                     WHERE task_id = ?1 AND question_id = ?2 AND status = 'pending'",
                                    params![&input.task_id, sup_id],
                                    |r| Ok((r.get(0)?,)),
                                )
                                .optional()?;
                            let Some((prior_prov_id,)) = prior else {
                                return Err(StorageError::Task(format!(
                                    "Unknown pending superseded question: {sup_id}"
                                )));
                            };
                            tx.execute(
                                "UPDATE task_questions SET status = 'superseded', resolved_at = ?1
                                 WHERE task_id = ?2 AND question_id = ?3",
                                params![&input.updated_at, &input.task_id, sup_id],
                            )?;
                            if let Some(prev_dec_id) = prior_prov_id
                                && q.provisional_decision_id.is_none()
                            {
                                tx.execute(
                                    "UPDATE task_decisions SET status = 'superseded'
                                     WHERE task_id = ?1 AND decision_id = ?2",
                                    params![&input.task_id, prev_dec_id],
                                )?;
                            }
                        }

                        if let Some(prov_id) = &q.provisional_decision_id {
                            let Some(prov) = prov_by_id.get(prov_id) else {
                                return Err(StorageError::Task(format!(
                                    "Missing provisional decision: {prov_id}"
                                )));
                            };
                            insert_decision_sync(&tx, prov)?;
                        }

                        tx.execute(
                            "INSERT INTO task_questions(
                               question_id, task_id, thread_id, work_item_id, header, question,
                               context, blocking, urgency, default_action, options_json,
                               recommended_option_id, status, provisional_decision_id, answer,
                               answer_option_id, resolution_source, supersedes, created_at, resolved_at
                             ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)",
                            params![
                                &q.id,
                                &q.task_id,
                                &q.thread_id,
                                &q.work_item_id,
                                &q.header,
                                &q.question,
                                &q.context,
                                if q.blocking { 1i64 } else { 0i64 },
                                q.urgency.as_str(),
                                &q.default_action,
                                serde_json::to_string(&q.options)?,
                                &q.recommended_option_id,
                                q.status.as_str(),
                                &q.provisional_decision_id,
                                &q.answer,
                                &q.answer_option_id,
                                &q.resolution_source,
                                &q.supersedes,
                                &q.created_at,
                                &q.resolved_at,
                            ],
                        )?;
                    }

                    if input.block_task {
                        tx.execute(
                            "UPDATE tasks SET status = 'blocked'
                             WHERE task_id = ?1 AND status IN ('draft', 'planning', 'working')",
                            params![&input.task_id],
                        )?;
                    }

                    let count = input.questions.len();
                    let detail = input
                        .questions
                        .iter()
                        .map(|q| q.question.as_str())
                        .collect::<Vec<_>>()
                        .join("\n");
                    insert_activity_sync(
                        &tx,
                        &TaskActivity {
                            id: Uuid::new_v4().to_string(),
                            seq: 1,
                            task_id: input.task_id.clone(),
                            thread_id: input.questions.first().and_then(|q| q.thread_id.clone()),
                            work_item_id: None,
                            kind: TaskActivityKind::InputRequested,
                            summary: format!(
                                "{count} task question{} queued",
                                if count == 1 { "" } else { "s" }
                            ),
                            detail: Some(detail),
                            created_at: input.updated_at,
                        },
                    )?;
                    tx.commit()?;
                    require_task_sync(conn, &input.task_id)
                })
            })
            .await
    }

    pub async fn resolve_task_questions(
        &self,
        input: ResolveTaskQuestionsInput,
    ) -> Result<TaskRecord> {
        self.write_coordinator
            .run_exclusive("resolve_task_questions", || async move {
                self.with_rw_conn_mut(|conn| {
                    let tx = conn.transaction()?;
                    bump_revision_sync(
                        &tx,
                        &input.task_id,
                        input.expected_revision,
                        &input.updated_at,
                    )?;
                    for res in &input.resolutions {
                        let changes = tx.execute(
                            "UPDATE task_questions
                             SET status = 'answered', answer = ?1, answer_option_id = ?2,
                                 resolution_source = 'user', resolved_at = ?3
                             WHERE task_id = ?4 AND question_id = ?5 AND status = 'pending'",
                            params![
                                &res.answer,
                                &res.answer_option_id,
                                &input.updated_at,
                                &input.task_id,
                                &res.question_id,
                            ],
                        )?;
                        if changes != 1 {
                            return Err(StorageError::Task(format!(
                                "Unknown pending task question: {}",
                                res.question_id
                            )));
                        }
                        insert_decision_sync(&tx, &res.decision)?;
                    }
                    let pending_blocking: i64 = tx.query_row(
                        "SELECT COUNT(*) FROM task_questions WHERE task_id = ?1 AND status = 'pending' AND blocking = 1",
                        params![&input.task_id],
                        |r| r.get(0),
                    )?;
                    let active_blocking: i64 = tx.query_row(
                        "SELECT COUNT(*) FROM task_blockers WHERE task_id = ?1 AND status = 'active' AND blocking = 1",
                        params![&input.task_id],
                        |r| r.get(0),
                    )?;
                    if pending_blocking == 0 && active_blocking == 0 {
                        tx.execute(
                            "UPDATE tasks SET status = 'working' WHERE task_id = ?1 AND status = 'blocked'",
                            params![&input.task_id],
                        )?;
                    }
                    let count = input.resolutions.len();
                    let detail = input
                        .resolutions
                        .iter()
                        .map(|r| format!("{}: {}", r.decision.question, r.answer))
                        .collect::<Vec<_>>()
                        .join("\n");
                    insert_activity_sync(
                        &tx,
                        &TaskActivity {
                            id: Uuid::new_v4().to_string(),
                            seq: 1,
                            task_id: input.task_id.clone(),
                            thread_id: None,
                            work_item_id: None,
                            kind: TaskActivityKind::InputResolved,
                            summary: format!(
                                "{count} task answer{} recorded",
                                if count == 1 { "" } else { "s" }
                            ),
                            detail: Some(detail),
                            created_at: input.updated_at,
                        },
                    )?;
                    tx.commit()?;
                    require_task_sync(conn, &input.task_id)
                })
            })
            .await
    }

    pub async fn default_pending_task_questions(
        &self,
        task_id: String,
        expected_revision: i64,
        updated_at: String,
    ) -> Result<TaskRecord> {
        self.write_coordinator
            .run_exclusive("default_pending_task_questions", || async move {
                self.with_rw_conn_mut(|conn| {
                    let mut stmt = conn.prepare(
                        "SELECT question_id, blocking, default_action, provisional_decision_id
                         FROM task_questions
                         WHERE task_id = ?1 AND status = 'pending'
                         ORDER BY created_at, question_id",
                    )?;
                    let pending: Vec<(String, i64, Option<String>, Option<String>)> = stmt
                        .query_map(params![&task_id], |r| {
                            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
                        })?
                        .collect::<rusqlite::Result<Vec<_>>>()?;
                    drop(stmt);

                    if pending.iter().any(|(_, b, _, _)| *b == 1) {
                        return Err(StorageError::Task(
                            "Task has unresolved blocking questions".to_string(),
                        ));
                    }
                    if pending.is_empty() {
                        return require_task_sync(conn, &task_id);
                    }
                    for (qid, _, def_act, prov_id) in &pending {
                        if def_act.is_none() || prov_id.is_none() {
                            return Err(StorageError::Task(format!(
                                "Task question has no usable default: {qid}"
                            )));
                        }
                    }

                    let tx = conn.transaction()?;
                    bump_revision_sync(&tx, &task_id, expected_revision, &updated_at)?;
                    for (qid, _, _, _) in &pending {
                        tx.execute(
                            "UPDATE task_questions
                             SET status = 'defaulted', answer = default_action, resolution_source = 'default', resolved_at = ?1
                             WHERE task_id = ?2 AND question_id = ?3 AND status = 'pending'",
                            params![&updated_at, &task_id, qid],
                        )?;
                    }
                    let count = pending.len();
                    insert_activity_sync(
                        &tx,
                        &TaskActivity {
                            id: Uuid::new_v4().to_string(),
                            seq: 1,
                            task_id: task_id.clone(),
                            thread_id: None,
                            work_item_id: None,
                            kind: TaskActivityKind::InputDefaulted,
                            summary: format!(
                                "{count} unanswered task question{} resolved with recorded defaults",
                                if count == 1 { "" } else { "s" }
                            ),
                            detail: None,
                            created_at: updated_at,
                        },
                    )?;
                    tx.commit()?;
                    require_task_sync(conn, &task_id)
                })
            })
            .await
    }

    pub async fn register_task_artifact(
        &self,
        artifact: TaskArtifact,
        expected_revision: i64,
        updated_at: String,
    ) -> Result<TaskRecord> {
        self.write_coordinator
            .run_exclusive("register_task_artifact", || async move {
                self.with_rw_conn_mut(|conn| {
                    let tx = conn.transaction()?;
                    bump_revision_sync(&tx, &artifact.task_id, expected_revision, &updated_at)?;
                    upsert_artifact_sync(&tx, &artifact)?;
                    insert_activity_sync(
                        &tx,
                        &TaskActivity {
                            id: Uuid::new_v4().to_string(),
                            seq: 1,
                            task_id: artifact.task_id.clone(),
                            thread_id: artifact.thread_id.clone(),
                            work_item_id: artifact.work_item_id.clone(),
                            kind: TaskActivityKind::ArtifactRegistered,
                            summary: format!("Artifact ready: {}", artifact.title),
                            detail: Some(artifact.path.clone()),
                            created_at: updated_at,
                        },
                    )?;
                    tx.commit()?;
                    require_task_sync(conn, &artifact.task_id)
                })
            })
            .await
    }

    pub async fn register_task_artifact_versioned(
        &self,
        artifact: TaskArtifact,
        version: TaskArtifactVersion,
        expected_revision: i64,
        updated_at: String,
    ) -> Result<TaskRecord> {
        self.write_coordinator
            .run_exclusive("register_task_artifact_versioned", || async move {
                self.with_rw_conn_mut(|conn| {
                    let tx = conn.transaction()?;
                    bump_revision_sync(&tx, &artifact.task_id, expected_revision, &updated_at)?;
                    upsert_artifact_sync(&tx, &artifact)?;
                    insert_artifact_version_sync(&tx, &artifact.task_id, &version)?;
                    move_artifact_work_item_to_review_sync(
                        &tx,
                        &artifact.task_id,
                        artifact.work_item_id.as_deref(),
                        &updated_at,
                    )?;
                    insert_activity_sync(
                        &tx,
                        &TaskActivity {
                            id: Uuid::new_v4().to_string(),
                            seq: 1,
                            task_id: artifact.task_id.clone(),
                            thread_id: artifact.thread_id.clone(),
                            work_item_id: artifact.work_item_id.clone(),
                            kind: TaskActivityKind::ArtifactVersionCaptured,
                            summary: format!(
                                "Artifact version {} ready: {}",
                                version.version, artifact.title
                            ),
                            detail: Some(artifact.path.clone()),
                            created_at: updated_at,
                        },
                    )?;
                    tx.commit()?;
                    require_task_sync(conn, &artifact.task_id)
                })
            })
            .await
    }

    pub async fn register_task_artifact_baseline(
        &self,
        task_id: String,
        artifact_id: String,
        version: TaskArtifactVersion,
        expected_revision: i64,
        updated_at: String,
    ) -> Result<TaskArtifactDetail> {
        self.write_coordinator
            .run_exclusive("register_task_artifact_baseline", || async move {
                self.with_rw_conn_mut(|conn| {
                    let existing = get_artifact_detail_sync(conn, &task_id, &artifact_id)?
                        .ok_or_else(|| {
                            StorageError::Task(format!("Unknown task artifact: {artifact_id}"))
                        })?;
                    if !existing.versions.is_empty() {
                        return Ok(existing);
                    }
                    let tx = conn.transaction()?;
                    bump_revision_sync(&tx, &task_id, expected_revision, &updated_at)?;
                    insert_artifact_version_sync(&tx, &task_id, &version)?;
                    insert_activity_sync(
                        &tx,
                        &TaskActivity {
                            id: Uuid::new_v4().to_string(),
                            seq: 1,
                            task_id: task_id.clone(),
                            thread_id: existing.artifact.thread_id.clone(),
                            work_item_id: existing.artifact.work_item_id.clone(),
                            kind: TaskActivityKind::ArtifactVersionCaptured,
                            summary: format!(
                                "Artifact baseline captured: {}",
                                existing.artifact.title
                            ),
                            detail: Some(existing.artifact.path.clone()),
                            created_at: updated_at,
                        },
                    )?;
                    tx.commit()?;
                    get_artifact_detail_sync(conn, &task_id, &artifact_id)?.ok_or_else(|| {
                        StorageError::Task(format!("Unknown task artifact: {artifact_id}"))
                    })
                })
            })
            .await
    }

    pub async fn capture_task_artifact_version(
        &self,
        task_id: String,
        artifact_id: String,
        version: TaskArtifactVersion,
        expected_revision: i64,
        updated_at: String,
        activity_kind: TaskActivityKind,
    ) -> Result<TaskArtifactDetail> {
        self.write_coordinator
            .run_exclusive("capture_task_artifact_version", || async move {
                self.with_rw_conn_mut(|conn| {
                    let detail = get_artifact_detail_sync(conn, &task_id, &artifact_id)?
                        .ok_or_else(|| {
                            StorageError::Task(format!("Unknown task artifact: {artifact_id}"))
                        })?;
                    let tx = conn.transaction()?;
                    bump_revision_sync(&tx, &task_id, expected_revision, &updated_at)?;
                    supersede_pending_artifact_versions_sync(&tx, &artifact_id)?;
                    insert_artifact_version_sync(&tx, &task_id, &version)?;
                    move_artifact_work_item_to_review_sync(
                        &tx,
                        &task_id,
                        detail.artifact.work_item_id.as_deref(),
                        &updated_at,
                    )?;
                    let summary = if activity_kind == TaskActivityKind::ArtifactVersionRestored {
                        format!(
                            "Artifact restored as version {}: {}",
                            version.version, detail.artifact.title
                        )
                    } else {
                        format!(
                            "Artifact version {} captured: {}",
                            version.version, detail.artifact.title
                        )
                    };
                    insert_activity_sync(
                        &tx,
                        &TaskActivity {
                            id: Uuid::new_v4().to_string(),
                            seq: 1,
                            task_id: task_id.clone(),
                            thread_id: detail.artifact.thread_id.clone(),
                            work_item_id: detail.artifact.work_item_id.clone(),
                            kind: activity_kind,
                            summary,
                            detail: (!version.change_summary.is_empty())
                                .then(|| version.change_summary.clone()),
                            created_at: updated_at,
                        },
                    )?;
                    tx.commit()?;
                    get_artifact_detail_sync(conn, &task_id, &artifact_id)?.ok_or_else(|| {
                        StorageError::Task(format!("Unknown task artifact: {artifact_id}"))
                    })
                })
            })
            .await
    }

    pub async fn start_task_artifact_revision(
        &self,
        input: StartTaskArtifactRevisionInput,
    ) -> Result<TaskRecord> {
        self.write_coordinator
            .run_exclusive("start_task_artifact_revision", || async move {
                self.with_rw_conn_mut(|conn| {
                    let tx = conn.transaction()?;
                    let task_status_raw: String = tx
                        .query_row(
                            "SELECT status FROM tasks WHERE task_id = ?1",
                            params![&input.revision.task_id],
                            |r| r.get(0),
                        )
                        .optional()?
                        .ok_or_else(|| {
                            StorageError::Task(format!("Unknown task: {}", input.revision.task_id))
                        })?;
                    let active_prior: Option<String> = tx
                        .query_row(
                            "SELECT prior_task_status FROM task_artifact_revisions
                             WHERE task_id = ?1 AND status = 'active' ORDER BY created_at ASC LIMIT 1",
                            params![&input.revision.task_id],
                            |r| r.get(0),
                        )
                        .optional()?;
                    bump_revision_sync(
                        &tx,
                        &input.revision.task_id,
                        input.expected_revision,
                        &input.revision.created_at,
                    )?;
                    tx.execute(
                        "UPDATE tasks SET status = 'working' WHERE task_id = ?1",
                        params![&input.revision.task_id],
                    )?;
                    insert_thread_sync(&tx, &input.thread)?;
                    tx.execute(
                        "INSERT INTO task_work_items(work_item_id, task_id, title, description, status, assigned_thread_id, expected_outputs_json, completion_evidence, position, created_at, updated_at)
                         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                        params![
                            &input.work_item.id,
                            &input.revision.task_id,
                            &input.work_item.title,
                            &input.work_item.description,
                            input.work_item.status.as_str(),
                            &input.thread.id,
                            serde_json::to_string(&input.work_item.expected_outputs)?,
                            &input.work_item.completion_evidence,
                            input.work_item.position,
                            &input.work_item.created_at,
                            &input.work_item.updated_at,
                        ],
                    )?;
                    for dep in &input.work_item.depends_on {
                        tx.execute(
                            "INSERT INTO task_work_item_dependencies(task_id, work_item_id, depends_on_work_item_id)
                             VALUES(?1, ?2, ?3)",
                            params![&input.revision.task_id, &input.work_item.id, dep],
                        )?;
                    }
                    tx.execute(
                        "INSERT INTO task_work_item_claims(work_item_id, task_id, thread_id, claimed_at)
                         VALUES(?1, ?2, ?3, ?4)",
                        params![
                            &input.work_item.id,
                            &input.revision.task_id,
                            &input.thread.id,
                            &input.revision.created_at,
                        ],
                    )?;
                    let prior_status = active_prior.unwrap_or(task_status_raw);
                    tx.execute(
                        "INSERT INTO task_artifact_revisions(
                           revision_id, task_id, artifact_id, work_item_id, task_thread_id,
                           session_id, base_version_id, prior_version_id, result_version_id,
                           prior_task_status, settlement_status, status, instruction,
                           created_at, updated_at, completed_at
                         ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, ?9, 'none', ?10, ?11, ?12, ?13, ?14)",
                        params![
                            &input.revision.id,
                            &input.revision.task_id,
                            &input.revision.artifact_id,
                            &input.revision.work_item_id,
                            &input.revision.task_thread_id,
                            &input.revision.session_id,
                            &input.revision.base_version_id,
                            &input.revision.prior_version_id,
                            prior_status,
                            input.revision.status.as_str(),
                            &input.revision.instruction,
                            &input.revision.created_at,
                            &input.revision.updated_at,
                            &input.revision.completed_at,
                        ],
                    )?;
                    insert_activity_sync(
                        &tx,
                        &TaskActivity {
                            id: Uuid::new_v4().to_string(),
                            seq: 1,
                            task_id: input.revision.task_id.clone(),
                            thread_id: Some(input.thread.id.clone()),
                            work_item_id: Some(input.work_item.id.clone()),
                            kind: TaskActivityKind::ArtifactRevisionStarted,
                            summary: format!(
                                "Artifact revision started: {}",
                                input.work_item.title
                            ),
                            detail: Some(input.revision.instruction.clone()),
                            created_at: input.revision.created_at.clone(),
                        },
                    )?;
                    tx.commit()?;
                    require_task_sync(conn, &input.revision.task_id)
                })
            })
            .await
    }

    pub async fn complete_task_artifact_revision(
        &self,
        revision_id: String,
        version: TaskArtifactVersion,
        updated_at: String,
        force_pending_settlement: bool,
    ) -> Result<TaskRecord> {
        self.write_coordinator
            .run_exclusive("complete_task_artifact_revision", || async move {
                self.with_rw_conn_mut(|conn| {
                    let meta = require_artifact_revision_meta_sync(conn, &revision_id)?;
                    if meta.status != "active" {
                        return require_task_sync(conn, &meta.task_id);
                    }
                    let tx = conn.transaction()?;
                    complete_artifact_revision_in_open_tx(
                        &tx,
                        &revision_id,
                        &version,
                        &updated_at,
                        force_pending_settlement,
                    )?;
                    tx.commit()?;
                    require_task_sync(conn, &meta.task_id)
                })
            })
            .await
    }

    pub async fn mark_task_artifact_revision_settlement_pending(
        &self,
        revision_id: String,
        updated_at: String,
    ) -> Result<TaskRecord> {
        self.write_coordinator
            .run_exclusive(
                "mark_task_artifact_revision_settlement_pending",
                || async move {
                    self.with_rw_conn_mut(|conn| {
                        let meta = require_artifact_revision_meta_sync(conn, &revision_id)?;
                        if meta.status != "completed" || meta.result_version_id.is_none() {
                            return require_task_sync(conn, &meta.task_id);
                        }
                        conn.execute(
                            "UPDATE task_artifact_revisions
                             SET settlement_status = ?1, updated_at = ?2
                             WHERE revision_id = ?3 AND status = 'completed' AND result_version_id IS NOT NULL",
                            params![
                                PENDING_ARTIFACT_REVISION_SETTLEMENT,
                                &updated_at,
                                &revision_id
                            ],
                        )?;
                        require_task_sync(conn, &meta.task_id)
                    })
                },
            )
            .await
    }

    pub async fn settle_pending_task_artifact_revision_settlements(
        &self,
        task_id: String,
        updated_at: String,
    ) -> Result<TaskRecord> {
        self.write_coordinator
            .run_exclusive(
                "settle_pending_task_artifact_revision_settlements",
                || async move {
                    self.with_rw_conn_mut(|conn| {
                        let _ = require_task_sync(conn, &task_id)?;
                        conn.execute(
                            "UPDATE task_artifact_revisions
                             SET settlement_status = 'settled', updated_at = ?1
                             WHERE task_id = ?2 AND status = 'completed' AND settlement_status = ?3",
                            params![&updated_at, &task_id, PENDING_ARTIFACT_REVISION_SETTLEMENT],
                        )?;
                        require_task_sync(conn, &task_id)
                    })
                },
            )
            .await
    }

    pub async fn fail_task_artifact_revision(
        &self,
        revision_id: String,
        status: TaskArtifactRevisionStatus,
        updated_at: String,
        detail: Option<String>,
    ) -> Result<TaskRecord> {
        self.write_coordinator
            .run_exclusive("fail_task_artifact_revision", || async move {
                self.with_rw_conn_mut(|conn| {
                    let meta = require_artifact_revision_meta_sync(conn, &revision_id)?;
                    if meta.status != "active" {
                        return require_task_sync(conn, &meta.task_id);
                    }
                    let tx = conn.transaction()?;
                    fail_artifact_revision_in_open_tx(
                        &tx,
                        &revision_id,
                        status,
                        &updated_at,
                        detail.as_deref(),
                    )?;
                    tx.commit()?;
                    require_task_sync(conn, &meta.task_id)
                })
            })
            .await
    }

    pub async fn abandon_task_artifact_revision_for_terminal_task(
        &self,
        revision_id: String,
        updated_at: String,
    ) -> Result<TaskRecord> {
        self.write_coordinator
            .run_exclusive("abandon_task_artifact_revision_terminal", || async move {
                self.with_rw_conn_mut(|conn| {
                    let meta = require_artifact_revision_meta_sync(conn, &revision_id)?;
                    let tx = conn.transaction()?;
                    let task_status_raw: String = tx
                        .query_row(
                            "SELECT status FROM tasks WHERE task_id = ?1",
                            params![&meta.task_id],
                            |r| r.get(0),
                        )
                        .optional()?
                        .ok_or_else(|| {
                            StorageError::Task(format!("Unknown task: {}", meta.task_id))
                        })?;
                    if TaskStatus::parse(&task_status_raw).is_some_and(|s| s.is_terminal()) {
                        let changes = tx.execute(
                            "UPDATE task_artifact_revisions
                             SET status = 'cancelled', settlement_status = 'none', updated_at = ?1, completed_at = ?1
                             WHERE revision_id = ?2 AND status = 'active'",
                            params![&updated_at, &revision_id],
                        )?;
                        if changes > 0 {
                            abandon_revision_work_item_sync(
                                &tx,
                                &meta.task_id,
                                Some(&meta.work_item_id),
                                &updated_at,
                            )?;
                        }
                    }
                    tx.commit()?;
                    require_task_sync(conn, &meta.task_id)
                })
            })
            .await
    }

    pub async fn accept_task_artifact_version(
        &self,
        task_id: String,
        artifact_id: String,
        version_id: String,
        expected_revision: i64,
        updated_at: String,
    ) -> Result<TaskRecord> {
        self.write_coordinator
            .run_exclusive("accept_task_artifact_version", || async move {
                self.with_rw_conn_mut(|conn| {
                    let detail = get_artifact_detail_sync(conn, &task_id, &artifact_id)?
                        .ok_or_else(|| {
                            StorageError::Task(format!("Unknown task artifact: {artifact_id}"))
                        })?;
                    let selected = detail
                        .versions
                        .iter()
                        .find(|v| v.id == version_id)
                        .ok_or_else(|| {
                            StorageError::Task(format!("Unknown artifact version: {version_id}"))
                        })?;
                    if selected.review_status == TaskArtifactVersionReviewStatus::Accepted {
                        return require_task_sync(conn, &task_id);
                    }
                    if selected.review_status != TaskArtifactVersionReviewStatus::Draft {
                        return Err(StorageError::Task(
                            "Only a draft artifact version can be accepted".to_string(),
                        ));
                    }
                    let tx = conn.transaction()?;
                    bump_revision_sync(&tx, &task_id, expected_revision, &updated_at)?;
                    tx.execute(
                        "UPDATE task_artifact_versions SET review_status = 'superseded'
                         WHERE task_id = ?1 AND artifact_id = ?2 AND review_status = 'accepted' AND version_id != ?3",
                        params![&task_id, &artifact_id, &version_id],
                    )?;
                    tx.execute(
                        "UPDATE task_artifact_versions SET review_status = 'accepted'
                         WHERE task_id = ?1 AND artifact_id = ?2 AND version_id = ?3",
                        params![&task_id, &artifact_id, &version_id],
                    )?;
                    let rev_wid: Option<String> = tx
                        .query_row(
                            "SELECT work_item_id FROM task_artifact_revisions
                             WHERE task_id = ?1 AND artifact_id = ?2 AND result_version_id = ?3 AND status = 'completed'
                             ORDER BY completed_at DESC LIMIT 1",
                            params![&task_id, &artifact_id, &version_id],
                            |r| r.get(0),
                        )
                        .optional()?;
                    let work_item_id = rev_wid.or_else(|| detail.artifact.work_item_id.clone());
                    if let Some(wid) = &work_item_id {
                        tx.execute(
                            "UPDATE task_work_items
                             SET status = 'done',
                                 completion_evidence = COALESCE(completion_evidence, ?1),
                                 updated_at = ?2
                             WHERE task_id = ?3 AND work_item_id = ?4 AND status = 'review'",
                            params![
                                format!("Accepted artifact version {version_id}"),
                                &updated_at,
                                &task_id,
                                wid,
                            ],
                        )?;
                    }
                    insert_activity_sync(
                        &tx,
                        &TaskActivity {
                            id: Uuid::new_v4().to_string(),
                            seq: 1,
                            task_id: task_id.clone(),
                            thread_id: detail.artifact.thread_id.clone(),
                            work_item_id,
                            kind: TaskActivityKind::ArtifactVersionAccepted,
                            summary: format!("Artifact accepted: {}", detail.artifact.title),
                            detail: Some(version_id),
                            created_at: updated_at,
                        },
                    )?;
                    tx.commit()?;
                    require_task_sync(conn, &task_id)
                })
            })
            .await
    }

    pub async fn accept_all_task_artifact_versions(
        &self,
        task_id: String,
        expected_revision: i64,
        updated_at: String,
        mut directive_commit: Option<TaskDirectiveCommitHooks>,
    ) -> Result<TaskRecord> {
        self.write_coordinator
            .run_exclusive("accept_all_task_artifact_versions", || async move {
                let (task, checkpoint) = self.with_rw_conn_mut(|conn| {
                    conn.execute_batch("BEGIN IMMEDIATE TRANSACTION")?;
                    let res = (|| -> Result<(TaskRecord, Option<TaskCheckpoint>)> {
                        accept_all_artifact_versions_in_open_tx(
                            conn,
                            &task_id,
                            expected_revision,
                            &updated_at,
                        )?;
                        let task = require_task_sync(conn, &task_id)?;
                        let cp = record_directive_commit_in_open_tx(
                            conn,
                            &task,
                            Some(&mut directive_commit),
                        )?;
                        Ok((task, cp))
                    })();
                    match res {
                        Ok(pair) => {
                            conn.execute_batch("COMMIT")?;
                            Ok(pair)
                        }
                        Err(e) => {
                            let _ = conn.execute_batch("ROLLBACK");
                            Err(e)
                        }
                    }
                })?;
                if let Some(mut h) = directive_commit
                    && let Some(cb) = h.on_committed.take()
                {
                    cb(&task, checkpoint.as_ref());
                }
                Ok(task)
            })
            .await
    }

    pub async fn accept_all_task_artifact_versions_validated<F, Fut>(
        &self,
        task_id: String,
        expected_revision: i64,
        updated_at: String,
        validate_accepted_task: F,
        mut directive_commit: Option<TaskDirectiveCommitHooks>,
    ) -> Result<TaskRecord>
    where
        F: FnOnce(TaskRecord) -> Fut,
        Fut: Future<Output = Result<()>>,
    {
        self.write_coordinator
            .run_exclusive(
                "accept_all_task_artifact_versions_validated",
                || async move {
                    self.with_rw_conn_mut(|conn| {
                        conn.execute_batch("BEGIN IMMEDIATE TRANSACTION")
                            .map_err(StorageError::from)
                    })?;

                    let outcome: Result<(TaskRecord, Option<TaskCheckpoint>)> = async {
                        let mid_task = self.with_rw_conn_mut(|conn| {
                            accept_all_artifact_versions_in_open_tx(
                                conn,
                                &task_id,
                                expected_revision,
                                &updated_at,
                            )?;
                            require_task_sync(conn, &task_id)
                        })?;
                        validate_accepted_task(mid_task.clone()).await?;
                        self.with_rw_conn_mut(|conn| {
                            let cp = record_directive_commit_in_open_tx(
                                conn,
                                &mid_task,
                                Some(&mut directive_commit),
                            )?;
                            Ok((mid_task, cp))
                        })
                    }
                    .await;

                    match outcome {
                        Ok((task, checkpoint)) => {
                            self.with_rw_conn_mut(|conn| {
                                conn.execute_batch("COMMIT").map_err(StorageError::from)
                            })?;
                            if let Some(mut h) = directive_commit
                                && let Some(cb) = h.on_committed.take()
                            {
                                cb(&task, checkpoint.as_ref());
                            }
                            Ok(task)
                        }
                        Err(e) => {
                            let _ = self.with_rw_conn_mut(|conn| {
                                conn.execute_batch("ROLLBACK").map_err(StorageError::from)
                            });
                            Err(e)
                        }
                    }
                },
            )
            .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn preview_artifact_revision_completion_readiness<F, Fut>(
        &self,
        task_id: String,
        revision: ArtifactRevisionFinalizationOutcome,
        updated_at: String,
        summary: String,
        detail: Option<String>,
        thread_id: Option<String>,
        review_required: bool,
        prepare_completion: F,
    ) -> Result<PreviewCompletionReadinessResult>
    where
        F: FnOnce(TaskRecord) -> Fut,
        Fut: Future<Output = Result<PreparedTaskCompletion>>,
    {
        self.write_coordinator
            .run_exclusive(
                "preview_artifact_revision_completion_readiness",
                || async move {
                    self.with_rw_conn_mut(|conn| {
                        conn.execute_batch("BEGIN IMMEDIATE TRANSACTION")
                            .map_err(StorageError::from)
                    })?;

                    let outcome: Result<PreviewCompletionReadinessResult> = async {
                        let initial_task = self.with_rw_conn_mut(|conn| {
                            match &revision {
                                ArtifactRevisionFinalizationOutcome::Completed {
                                    revision_id,
                                    version,
                                } => complete_artifact_revision_in_open_tx(
                                    conn,
                                    revision_id,
                                    version,
                                    &updated_at,
                                    false,
                                )?,
                                ArtifactRevisionFinalizationOutcome::Cancelled {
                                    revision_id,
                                    detail: rev_detail,
                                } => fail_artifact_revision_in_open_tx(
                                    conn,
                                    revision_id,
                                    TaskArtifactRevisionStatus::Cancelled,
                                    &updated_at,
                                    rev_detail.as_deref(),
                                )?,
                            }
                            require_task_sync(conn, &task_id)
                        })?;

                        let prepared = prepare_completion(initial_task).await?;
                        let (validate_ready, validate_accepted) = match prepared {
                            PreparedTaskCompletion::NotReady { error_message } => {
                                return Ok(PreviewCompletionReadinessResult::NotReady {
                                    error_message,
                                });
                            }
                            PreparedTaskCompletion::Ready {
                                validate_ready_task,
                                validate_accepted_task,
                            } => (validate_ready_task, validate_accepted_task),
                        };

                        let ready_task = self.with_rw_conn_mut(|conn| {
                            let cur = require_task_sync(conn, &task_id)?;
                            set_status_in_open_tx(
                                conn,
                                &SetTaskStatusInput {
                                    task_id: task_id.clone(),
                                    expected_revision: cur.revision,
                                    status: TaskStatus::AwaitingReview,
                                    summary,
                                    detail,
                                    updated_at: updated_at.clone(),
                                    thread_id,
                                },
                            )?;
                            require_task_sync(conn, &task_id)
                        })?;

                        if let Some(vr) = validate_ready {
                            vr(ready_task).await?;
                        }
                        if !review_required {
                            let accepted_task = self.with_rw_conn_mut(|conn| {
                                let cur = require_task_sync(conn, &task_id)?;
                                accept_all_artifact_versions_in_open_tx(
                                    conn,
                                    &task_id,
                                    cur.revision,
                                    &updated_at,
                                )?;
                                require_task_sync(conn, &task_id)
                            })?;
                            if let Some(va) = validate_accepted {
                                va(accepted_task).await?;
                            }
                        }
                        Ok(PreviewCompletionReadinessResult::Ready)
                    }
                    .await;

                    let _ = self.with_rw_conn_mut(|conn| {
                        conn.execute_batch("ROLLBACK").map_err(StorageError::from)
                    });
                    outcome
                },
            )
            .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn finalize_artifact_revision_and_propose_task_completion<F, Fut>(
        &self,
        task_id: String,
        revision: ArtifactRevisionFinalizationOutcome,
        updated_at: String,
        summary: String,
        detail: Option<String>,
        thread_id: Option<String>,
        settlement_revision_ids: Vec<String>,
        review_required: bool,
        prepare_completion: F,
    ) -> Result<FinalizeArtifactRevisionCompletionResult>
    where
        F: FnOnce(TaskRecord) -> Fut,
        Fut: Future<Output = Result<PreparedTaskCompletion>>,
    {
        self.write_coordinator
            .run_exclusive(
                "finalize_artifact_revision_and_propose_task_completion",
                || async move {
                    self.with_rw_conn_mut(|conn| {
                        conn.execute_batch("BEGIN IMMEDIATE TRANSACTION")
                            .map_err(StorageError::from)
                    })?;

                    let outcome: Result<FinalizeArtifactRevisionCompletionResult> = async {
                        let initial_task = self.with_rw_conn_mut(|conn| {
                            match &revision {
                                ArtifactRevisionFinalizationOutcome::Completed {
                                    revision_id,
                                    version,
                                } => complete_artifact_revision_in_open_tx(
                                    conn,
                                    revision_id,
                                    version,
                                    &updated_at,
                                    false,
                                )?,
                                ArtifactRevisionFinalizationOutcome::Cancelled {
                                    revision_id,
                                    detail: rev_detail,
                                } => fail_artifact_revision_in_open_tx(
                                    conn,
                                    revision_id,
                                    TaskArtifactRevisionStatus::Cancelled,
                                    &updated_at,
                                    rev_detail.as_deref(),
                                )?,
                            }
                            require_task_sync(conn, &task_id)
                        })?;

                        let prepared = prepare_completion(initial_task.clone()).await?;
                        let (validate_ready, validate_accepted) = match prepared {
                            PreparedTaskCompletion::NotReady { error_message } => {
                                return Ok(FinalizeArtifactRevisionCompletionResult::NotReady {
                                    task: initial_task,
                                    error_message,
                                });
                            }
                            PreparedTaskCompletion::Ready {
                                validate_ready_task,
                                validate_accepted_task,
                            } => (validate_ready_task, validate_accepted_task),
                        };

                        let ready_task = self.with_rw_conn_mut(|conn| {
                            let cur = require_task_sync(conn, &task_id)?;
                            set_status_in_open_tx(
                                conn,
                                &SetTaskStatusInput {
                                    task_id: task_id.clone(),
                                    expected_revision: cur.revision,
                                    status: TaskStatus::AwaitingReview,
                                    summary,
                                    detail,
                                    updated_at: updated_at.clone(),
                                    thread_id,
                                },
                            )?;
                            require_task_sync(conn, &task_id)
                        })?;

                        if let Some(vr) = validate_ready {
                            vr(ready_task).await?;
                        }
                        if !review_required {
                            let accepted_task = self.with_rw_conn_mut(|conn| {
                                let cur = require_task_sync(conn, &task_id)?;
                                accept_all_artifact_versions_in_open_tx(
                                    conn,
                                    &task_id,
                                    cur.revision,
                                    &updated_at,
                                )?;
                                require_task_sync(conn, &task_id)
                            })?;
                            if let Some(va) = validate_accepted {
                                va(accepted_task).await?;
                            }
                        }

                        let final_task = self.with_rw_conn_mut(|conn| {
                            settle_pending_artifact_revision_settlements_in_open_tx(
                                conn,
                                &task_id,
                                &settlement_revision_ids,
                                &updated_at,
                            )?;
                            require_task_sync(conn, &task_id)
                        })?;
                        Ok(FinalizeArtifactRevisionCompletionResult::Committed(
                            final_task,
                        ))
                    }
                    .await;

                    match outcome {
                        Ok(res) => {
                            self.with_rw_conn_mut(|conn| {
                                conn.execute_batch("COMMIT").map_err(StorageError::from)
                            })?;
                            Ok(res)
                        }
                        Err(e) => {
                            let _ = self.with_rw_conn_mut(|conn| {
                                conn.execute_batch("ROLLBACK").map_err(StorageError::from)
                            });
                            Err(e)
                        }
                    }
                },
            )
            .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn propose_task_completion_with_pending_artifact_revision_settlements(
        &self,
        task_id: String,
        expected_revision: i64,
        updated_at: String,
        summary: String,
        detail: Option<String>,
        thread_id: Option<String>,
        settlement_revision_ids: Vec<String>,
        review_required: bool,
        validate_ready_task: Option<BoxTaskValidator>,
        validate_accepted_task: Option<BoxTaskValidator>,
        mut directive_commit: Option<TaskDirectiveCommitHooks>,
    ) -> Result<TaskRecord> {
        self.write_coordinator
            .run_exclusive(
                "propose_task_completion_with_pending_artifact_revision_settlements",
                || async move {
                    self.with_rw_conn_mut(|conn| {
                        conn.execute_batch("BEGIN IMMEDIATE TRANSACTION")
                            .map_err(StorageError::from)
                    })?;

                    let outcome: Result<(TaskRecord, Option<TaskCheckpoint>)> = async {
                        let ready_task = self.with_rw_conn_mut(|conn| {
                            set_status_in_open_tx(
                                conn,
                                &SetTaskStatusInput {
                                    task_id: task_id.clone(),
                                    expected_revision,
                                    status: TaskStatus::AwaitingReview,
                                    summary,
                                    detail,
                                    updated_at: updated_at.clone(),
                                    thread_id,
                                },
                            )?;
                            require_task_sync(conn, &task_id)
                        })?;

                        if let Some(vr) = validate_ready_task {
                            vr(ready_task).await?;
                        }
                        if !review_required {
                            let accepted_task = self.with_rw_conn_mut(|conn| {
                                let cur = require_task_sync(conn, &task_id)?;
                                accept_all_artifact_versions_in_open_tx(
                                    conn,
                                    &task_id,
                                    cur.revision,
                                    &updated_at,
                                )?;
                                require_task_sync(conn, &task_id)
                            })?;
                            if let Some(va) = validate_accepted_task {
                                va(accepted_task).await?;
                            }
                        }

                        self.with_rw_conn_mut(|conn| {
                            settle_pending_artifact_revision_settlements_in_open_tx(
                                conn,
                                &task_id,
                                &settlement_revision_ids,
                                &updated_at,
                            )?;
                            let final_task = require_task_sync(conn, &task_id)?;
                            let cp = record_directive_commit_in_open_tx(
                                conn,
                                &final_task,
                                Some(&mut directive_commit),
                            )?;
                            Ok((final_task, cp))
                        })
                    }
                    .await;

                    match outcome {
                        Ok((task, checkpoint)) => {
                            self.with_rw_conn_mut(|conn| {
                                conn.execute_batch("COMMIT").map_err(StorageError::from)
                            })?;
                            if let Some(mut h) = directive_commit
                                && let Some(cb) = h.on_committed.take()
                            {
                                cb(&task, checkpoint.as_ref());
                            }
                            Ok(task)
                        }
                        Err(e) => {
                            let _ = self.with_rw_conn_mut(|conn| {
                                conn.execute_batch("ROLLBACK").map_err(StorageError::from)
                            });
                            Err(e)
                        }
                    }
                },
            )
            .await
    }

    pub async fn report_task_blocker(
        &self,
        blocker: TaskBlocker,
        expected_revision: i64,
        updated_at: String,
    ) -> Result<TaskRecord> {
        self.write_coordinator
            .run_exclusive("report_task_blocker", || async move {
                self.with_rw_conn_mut(|conn| {
                    let tx = conn.transaction()?;
                    bump_revision_sync(&tx, &blocker.task_id, expected_revision, &updated_at)?;
                    tx.execute(
                        "INSERT INTO task_blockers(blocker_id, task_id, work_item_id, description, blocking, status, created_at, resolved_at)
                         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                        params![
                            &blocker.id,
                            &blocker.task_id,
                            &blocker.work_item_id,
                            &blocker.description,
                            if blocker.blocking { 1i64 } else { 0i64 },
                            &blocker.status,
                            &blocker.created_at,
                            &blocker.resolved_at,
                        ],
                    )?;
                    insert_activity_sync(
                        &tx,
                        &TaskActivity {
                            id: Uuid::new_v4().to_string(),
                            seq: 1,
                            task_id: blocker.task_id.clone(),
                            thread_id: None,
                            work_item_id: blocker.work_item_id.clone(),
                            kind: TaskActivityKind::BlockerReported,
                            summary: blocker.description.clone(),
                            detail: Some(if blocker.blocking {
                                "Blocking".to_string()
                            } else {
                                "Non-blocking".to_string()
                            }),
                            created_at: updated_at,
                        },
                    )?;
                    tx.commit()?;
                    require_task_sync(conn, &blocker.task_id)
                })
            })
            .await
    }

    pub async fn resolve_task_blocker(
        &self,
        task_id: String,
        blocker_id: String,
        expected_revision: i64,
        resolved_at: String,
    ) -> Result<TaskRecord> {
        self.write_coordinator
            .run_exclusive("resolve_task_blocker", || async move {
                self.with_rw_conn_mut(|conn| {
                    let tx = conn.transaction()?;
                    bump_revision_sync(&tx, &task_id, expected_revision, &resolved_at)?;
                    let changes = tx.execute(
                        "UPDATE task_blockers SET status = 'resolved', resolved_at = ?1 WHERE task_id = ?2 AND blocker_id = ?3",
                        params![&resolved_at, &task_id, &blocker_id],
                    )?;
                    if changes != 1 {
                        return Err(StorageError::Task("Unknown blocker".to_string()));
                    }
                    insert_activity_sync(
                        &tx,
                        &TaskActivity {
                            id: Uuid::new_v4().to_string(),
                            seq: 1,
                            task_id: task_id.clone(),
                            thread_id: None,
                            work_item_id: None,
                            kind: TaskActivityKind::BlockerResolved,
                            summary: "Task blocker resolved".to_string(),
                            detail: None,
                            created_at: resolved_at,
                        },
                    )?;
                    tx.commit()?;
                    require_task_sync(conn, &task_id)
                })
            })
            .await
    }

    pub async fn set_task_status(&self, input: SetTaskStatusInput) -> Result<TaskRecord> {
        self.write_coordinator
            .run_exclusive("set_task_status", || async move {
                self.with_rw_conn_mut(|conn| {
                    let tx = conn.transaction()?;
                    set_status_in_open_tx(&tx, &input)?;
                    tx.commit()?;
                    require_task_sync(conn, &input.task_id)
                })
            })
            .await
    }

    pub async fn set_task_status_validated<F, Fut>(
        &self,
        input: SetTaskStatusInput,
        validate_updated_task: F,
        mut directive_commit: Option<TaskDirectiveCommitHooks>,
    ) -> Result<TaskRecord>
    where
        F: FnOnce(TaskRecord) -> Fut,
        Fut: Future<Output = Result<()>>,
    {
        self.write_coordinator
            .run_exclusive("set_task_status", || async move {
                self.with_rw_conn_mut(|conn| {
                    conn.execute_batch("BEGIN IMMEDIATE TRANSACTION")
                        .map_err(StorageError::from)
                })?;

                let outcome: Result<(TaskRecord, Option<TaskCheckpoint>)> = async {
                    let mid_task = self.with_rw_conn_mut(|conn| {
                        set_status_in_open_tx(conn, &input)?;
                        require_task_sync(conn, &input.task_id)
                    })?;
                    validate_updated_task(mid_task.clone()).await?;
                    self.with_rw_conn_mut(|conn| {
                        let cp = record_directive_commit_in_open_tx(
                            conn,
                            &mid_task,
                            Some(&mut directive_commit),
                        )?;
                        Ok((mid_task, cp))
                    })
                }
                .await;

                match outcome {
                    Ok((task, checkpoint)) => {
                        self.with_rw_conn_mut(|conn| {
                            conn.execute_batch("COMMIT").map_err(StorageError::from)
                        })?;
                        if let Some(mut h) = directive_commit
                            && let Some(cb) = h.on_committed.take()
                        {
                            cb(&task, checkpoint.as_ref());
                        }
                        Ok(task)
                    }
                    Err(e) => {
                        let _ = self.with_rw_conn_mut(|conn| {
                            conn.execute_batch("ROLLBACK").map_err(StorageError::from)
                        });
                        Err(e)
                    }
                }
            })
            .await
    }

    pub async fn append_task_activity(
        &self,
        activity: TaskActivity,
        reject_terminal: bool,
    ) -> Result<TaskRecord> {
        self.write_coordinator
            .run_exclusive("append_task_activity", || async move {
                self.with_rw_conn_mut(|conn| {
                    let tx = conn.transaction()?;
                    if reject_terminal {
                        assert_task_accepts_mutation_sync(&tx, &activity.task_id)?;
                    }
                    insert_activity_sync(&tx, &activity)?;
                    tx.execute(
                        "UPDATE tasks SET updated_at = ?1 WHERE task_id = ?2",
                        params![&activity.created_at, &activity.task_id],
                    )?;
                    tx.commit()?;
                    require_task_sync(conn, &activity.task_id)
                })
            })
            .await
    }

    pub async fn append_task_activity_with_revision(
        &self,
        activity: TaskActivity,
        expected_revision: i64,
    ) -> Result<TaskRecord> {
        self.write_coordinator
            .run_exclusive("append_task_activity_with_revision", || async move {
                self.with_rw_conn_mut(|conn| {
                    let tx = conn.transaction()?;
                    bump_revision_sync(
                        &tx,
                        &activity.task_id,
                        expected_revision,
                        &activity.created_at,
                    )?;
                    insert_activity_sync(&tx, &activity)?;
                    tx.commit()?;
                    require_task_sync(conn, &activity.task_id)
                })
            })
            .await
    }

    pub async fn record_task_review(
        &self,
        review: TaskReviewRecord,
        activity: TaskActivity,
        expected_revision: i64,
    ) -> Result<TaskRecord> {
        self.write_coordinator
            .run_exclusive("record_task_review", || async move {
                self.with_rw_conn_mut(|conn| {
                    let tx = conn.transaction()?;
                    bump_revision_sync(
                        &tx,
                        &review.task_id,
                        expected_revision,
                        &review.created_at,
                    )?;
                    tx.execute(
                        "INSERT INTO task_reviews(
                           review_id, task_id, round, verdict, feedback, reviewer_agent_id,
                           reviewer_provider, reviewer_model, task_revision, material_fingerprint,
                           material_snapshot_json, created_at, addressed_at, implementation_summary
                         ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                        params![
                            &review.id,
                            &review.task_id,
                            review.round,
                            review.verdict.as_str(),
                            &review.feedback,
                            &review.reviewer_agent_id,
                            &review.reviewer_provider,
                            &review.reviewer_model,
                            review.task_revision,
                            &review.material_fingerprint,
                            serde_json::to_string(&review.material_snapshot)?,
                            &review.created_at,
                            &review.addressed_at,
                            &review.implementation_summary,
                        ],
                    )?;
                    insert_activity_sync(&tx, &activity)?;
                    tx.commit()?;
                    require_task_sync(conn, &review.task_id)
                })
            })
            .await
    }

    pub async fn address_task_review(
        &self,
        task_id: String,
        review_id: String,
        expected_revision: i64,
        addressed_at: String,
        implementation_summary: String,
        activity: TaskActivity,
    ) -> Result<TaskRecord> {
        self.write_coordinator
            .run_exclusive("address_task_review", || async move {
                self.with_rw_conn_mut(|conn| {
                    let tx = conn.transaction()?;
                    bump_revision_sync(&tx, &task_id, expected_revision, &addressed_at)?;
                    let changes = tx.execute(
                        "UPDATE task_reviews
                         SET addressed_at = ?1, implementation_summary = ?2
                         WHERE task_id = ?3 AND review_id = ?4 AND verdict != 'pass' AND addressed_at IS NULL",
                        params![&addressed_at, &implementation_summary, &task_id, &review_id],
                    )?;
                    if changes != 1 {
                        return Err(StorageError::Task(format!(
                            "Unknown unaddressed review: {review_id}"
                        )));
                    }
                    insert_activity_sync(&tx, &activity)?;
                    tx.commit()?;
                    require_task_sync(conn, &task_id)
                })
            })
            .await
    }

    pub async fn create_task_checkpoint(
        &self,
        checkpoint: TaskCheckpoint,
        reject_terminal: bool,
    ) -> Result<TaskCheckpoint> {
        self.write_coordinator
            .run_exclusive("create_task_checkpoint", || async move {
                self.with_rw_conn_mut(|conn| {
                    let tx = conn.transaction()?;
                    if reject_terminal {
                        assert_task_accepts_mutation_sync(&tx, &checkpoint.task_id)?;
                    }
                    insert_checkpoint_sync(&tx, &checkpoint)?;
                    tx.commit()?;
                    Ok(checkpoint)
                })
            })
            .await
    }

    pub async fn record_task_directive_receipt_with_checkpoint(
        &self,
        task_id: String,
        idempotency_key: String,
        result_revision: i64,
        receipt_created_at: String,
        checkpoint: TaskCheckpoint,
        reject_terminal: bool,
    ) -> Result<Option<TaskCheckpoint>> {
        self.write_coordinator
            .run_exclusive(
                "record_task_directive_receipt_with_checkpoint",
                || async move {
                    self.with_rw_conn_mut(|conn| {
                        let tx = conn.transaction()?;
                        if get_directive_receipt_sync(&tx, &task_id, &idempotency_key)?.is_some() {
                            return Ok(None);
                        }
                        if reject_terminal {
                            assert_task_accepts_mutation_sync(&tx, &task_id)?;
                        }
                        insert_checkpoint_sync(&tx, &checkpoint)?;
                        record_directive_receipt_sync(
                            &tx,
                            &task_id,
                            &idempotency_key,
                            result_revision,
                            &receipt_created_at,
                        )?;
                        tx.commit()?;
                        Ok(Some(checkpoint))
                    })
                },
            )
            .await
    }

    pub async fn record_task_directive_receipt(
        &self,
        task_id: String,
        idempotency_key: String,
        result_revision: i64,
        created_at: String,
    ) -> Result<()> {
        self.write_coordinator
            .run_exclusive("record_task_directive_receipt", || async move {
                self.with_rw_conn_mut(|conn| {
                    record_directive_receipt_sync(
                        conn,
                        &task_id,
                        &idempotency_key,
                        result_revision,
                        &created_at,
                    )
                })
            })
            .await
    }
}
