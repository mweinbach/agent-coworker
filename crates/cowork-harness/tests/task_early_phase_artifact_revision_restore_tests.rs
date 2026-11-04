//! TS parity (`restoreTaskStatusAfterArtifactRevision`): starting an artifact revision moves a
//! draft or planning task to `working` and records the pre-revision status. When the revision
//! settles without completing the task, that saved early-phase status is restored with a direct
//! status write, even though `working -> draft` / `working -> planning` are not valid forward
//! transitions. The ordinary transition validator must keep rejecting those moves.

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use cowork_harness::tasks::{
    RegisterArtifactRequest, ReplacementWorkItemInput, StartArtifactRevisionRequest,
    TaskCoordinator, TaskCoordinatorOptions, TaskThreadFactory, TaskThreadFactoryInput,
};
use cowork_storage::{
    ArtifactVersionStore, ArtifactVersionStoreOptions, SessionDb, SessionDbOptions,
    TaskArtifactRevision, TaskArtifactRevisionStatus, TaskRecord, TaskStatus,
};
use uuid::Uuid;

struct ThreadFactory;

#[async_trait]
impl TaskThreadFactory for ThreadFactory {
    async fn create_task_thread(&self, _input: TaskThreadFactoryInput) -> Result<String, String> {
        Ok(format!("revision-sess-{}", Uuid::new_v4()))
    }
}

struct Fixture {
    _tmp: tempfile::TempDir,
    ws: String,
    report: PathBuf,
    coordinator: Arc<TaskCoordinator>,
}

async fn fixture() -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let base = std::fs::canonicalize(tmp.path()).unwrap();
    let ws_dir = base.join("workspace");
    let cowork_root = base.join("home").join(".cowork");
    std::fs::create_dir_all(&ws_dir).unwrap();
    std::fs::create_dir_all(&cowork_root).unwrap();
    let session_db = Arc::new(
        SessionDb::open(SessionDbOptions {
            root_dir: cowork_root.clone(),
            db_path: None,
            sessions_dir: cowork_root.join("sessions"),
            busy_timeout_ms: Some(5_000),
        })
        .await
        .unwrap(),
    );
    let artifact_store = Arc::new(ArtifactVersionStore::new(ArtifactVersionStoreOptions {
        root_dir: Some(cowork_root.join("artifacts")),
        homedir: Some(base.join("home")),
    }));
    let coordinator = TaskCoordinator::new(TaskCoordinatorOptions {
        session_db,
        notify: None,
        artifact_store: Some(artifact_store),
        quiesce_task_threads: None,
    })
    .unwrap();
    coordinator.set_thread_factory(Arc::new(ThreadFactory));
    let report = ws_dir.join("report.md");
    std::fs::write(&report, "version one\n").unwrap();
    Fixture {
        _tmp: tmp,
        ws: ws_dir.to_string_lossy().into_owned(),
        report,
        coordinator,
    }
}

fn work_item(id: &str, title: &str, outputs: &[&str]) -> ReplacementWorkItemInput {
    ReplacementWorkItemInput {
        id: Some(id.to_owned()),
        title: title.to_owned(),
        description: None,
        status: None,
        depends_on: None,
        expected_outputs: Some(outputs.iter().map(|s| (*s).to_owned()).collect()),
    }
}

/// TS `createTaskWithArtifact`: a manual (draft) task with one work item producing `report.md`,
/// optionally moved to `planning`, plus any extra work items.
async fn task_with_artifact(
    f: &Fixture,
    prior_status: TaskStatus,
    review_required: bool,
    extra_items: Vec<ReplacementWorkItemInput>,
) -> TaskRecord {
    let created = f
        .coordinator
        .create(
            &f.ws,
            "Artifact review",
            "Produce and review a report.",
            &format!("main-session-{}", Uuid::new_v4()),
            None,
            Some(review_required),
            None,
        )
        .await
        .unwrap();
    assert_eq!(created.status, TaskStatus::Draft);
    let mut items = vec![work_item(
        "deliver-report",
        "Deliver report",
        &["report.md"],
    )];
    items.extend(extra_items);
    let mut task = f
        .coordinator
        .replace_work_items(&created.id, &f.ws, created.revision, items)
        .await
        .unwrap();
    task = f
        .coordinator
        .register_artifact(RegisterArtifactRequest {
            task_id: task.id.clone(),
            workspace_path: f.ws.clone(),
            expected_revision: task.revision,
            session_id: None,
            path: "report.md".to_owned(),
            title: "Report".to_owned(),
            kind: "markdown".to_owned(),
            artifact_id: None,
            base_version_id: None,
            change_summary: None,
            work_item_id: Some("deliver-report".to_owned()),
            provenance: None,
        })
        .await
        .unwrap();
    if prior_status == TaskStatus::Planning {
        task = f
            .coordinator
            .transition(
                &task.id,
                &f.ws,
                task.revision,
                TaskStatus::Planning,
                "Still planning the task",
                None,
                None,
            )
            .await
            .unwrap();
    }
    assert_eq!(task.status, prior_status);
    task
}

async fn start_revision(f: &Fixture, task: &TaskRecord) -> TaskArtifactRevision {
    let (started, _, revision) = f
        .coordinator
        .start_artifact_revision(StartArtifactRevisionRequest {
            task_id: task.id.clone(),
            workspace_path: f.ws.clone(),
            artifact_id: task.artifacts[0].id.clone(),
            expected_revision: task.revision,
            instruction: "Explore an early-phase artifact change.".to_owned(),
            base_version_id: None,
            title: None,
            provider: None,
            model: None,
        })
        .await
        .unwrap();
    assert_eq!(started.status, TaskStatus::Working);
    revision
}

async fn assert_cancel_restores(prior_status: TaskStatus) {
    let f = fixture().await;
    let task = task_with_artifact(&f, prior_status, true, Vec::new()).await;
    let revision = start_revision(&f, &task).await;

    std::fs::write(&f.report, "early-phase edit to discard\n").unwrap();
    let cancelled = f
        .coordinator
        .handle_thread_outcome(&revision.session_id, "cancelled", None)
        .await
        .expect("cancelling an early-phase revision must not error")
        .expect("revision outcome");

    assert_eq!(
        cancelled.revision.status,
        TaskArtifactRevisionStatus::Cancelled
    );
    assert_eq!(cancelled.task.status, prior_status);
    assert_eq!(
        f.coordinator
            .get(&task.id, Some(&f.ws))
            .unwrap()
            .expect("task")
            .status,
        prior_status,
        "the restored status must be persisted"
    );
    assert_eq!(std::fs::read_to_string(&f.report).unwrap(), "version one\n");
}

#[tokio::test]
async fn cancelling_a_draft_phase_revision_restores_draft() {
    assert_cancel_restores(TaskStatus::Draft).await;
}

#[tokio::test]
async fn cancelling_a_planning_phase_revision_restores_planning() {
    assert_cancel_restores(TaskStatus::Planning).await;
}

/// A completed revision whose completion proposal is ineligible (queued follow-up work) also
/// restores the saved early-phase status instead of leaving the task working
/// (TS `restoreAfterArtifactRevisionCompletionProposalFailure`).
#[tokio::test]
async fn completed_draft_phase_revision_with_ineligible_completion_restores_draft() {
    let f = fixture().await;
    let task = task_with_artifact(
        &f,
        TaskStatus::Draft,
        false,
        vec![work_item("follow-up", "Follow up", &[])],
    )
    .await;
    let revision = start_revision(&f, &task).await;

    std::fs::write(&f.report, "version two\n").unwrap();
    let completed = f
        .coordinator
        .handle_thread_outcome(&revision.session_id, "completed", None)
        .await
        .expect("an ineligible completion must not fail the revision outcome")
        .expect("revision outcome");

    assert_eq!(
        completed.revision.status,
        TaskArtifactRevisionStatus::Completed
    );
    assert_eq!(completed.task.status, TaskStatus::Draft);
}

/// The restoration is not a general backdoor: the public transition API still rejects moving a
/// working task back to an early phase.
#[tokio::test]
async fn ordinary_transitions_still_reject_working_to_early_phase() {
    let f = fixture().await;
    let task = task_with_artifact(&f, TaskStatus::Draft, true, Vec::new()).await;
    let working = f
        .coordinator
        .transition(
            &task.id,
            &f.ws,
            task.revision,
            TaskStatus::Working,
            "Task execution started",
            None,
            None,
        )
        .await
        .unwrap();
    for early in [TaskStatus::Draft, TaskStatus::Planning] {
        let err = f
            .coordinator
            .transition(
                &working.id,
                &f.ws,
                working.revision,
                early,
                "Back to an early phase",
                None,
                None,
            )
            .await
            .expect_err("working -> early phase must stay invalid");
        assert!(err.to_string().contains("Invalid task transition"), "{err}");
    }
}
