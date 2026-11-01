//! Regression: when a revision thread completes but capturing its output fails (output
//! removed, blob write fails), the revision must be settled as failed — prior artifact
//! restored, revision no longer active, work item released — instead of erroring out and
//! leaving the revision active so later revisions are rejected.

use std::sync::Arc;

use async_trait::async_trait;
use cowork_harness::tasks::{
    RegisterArtifactRequest, StartArtifactRevisionRequest, TaskCoordinator, TaskCoordinatorOptions,
    TaskThreadFactory, TaskThreadFactoryInput,
};
use cowork_storage::{
    ArtifactVersionStore, ArtifactVersionStoreOptions, SessionDb, SessionDbOptions,
    TaskArtifactRevision, TaskArtifactRevisionStatus, TaskCreationOrigin, WorkItemStatus,
    parse_and_validate_task_creation_input, sha256_hex,
};
use serde_json::json;
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
    cowork_root: std::path::PathBuf,
    report: std::path::PathBuf,
    session_db: Arc<SessionDb>,
    coordinator: Arc<TaskCoordinator>,
    revision: TaskArtifactRevision,
    next_revision: StartArtifactRevisionRequest,
}

async fn start_revision() -> Fixture {
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
        session_db: session_db.clone(),
        notify: None,
        artifact_store: Some(artifact_store),
        quiesce_task_threads: None,
    })
    .unwrap();
    coordinator.set_thread_factory(Arc::new(ThreadFactory));

    let ws = ws_dir.to_string_lossy().into_owned();
    let report = ws_dir.join("report.md");
    std::fs::write(&report, "# v1\n").unwrap();

    let creation = parse_and_validate_task_creation_input(
        &json!({
            "idempotencyKey": "rev-capture-fail",
            "title": "Report",
            "objective": "Write report.md",
            "context": "Regression fixture",
            "requirements": [{ "kind": "acceptance_criterion", "text": "report.md exists" }],
            "workItems": [{
                "key": "write",
                "title": "Write report",
                "description": "Create report.md",
                "expectedOutputs": ["report.md"]
            }]
        }),
        false,
    )
    .unwrap();
    let created = coordinator
        .create_planned(
            &ws,
            "task-main",
            Some("source-chat"),
            TaskCreationOrigin::ChatTool,
            "keep_project",
            creation,
            Some("Main"),
        )
        .await
        .unwrap()
        .task;
    let task = coordinator
        .register_artifact(RegisterArtifactRequest {
            task_id: created.id.clone(),
            workspace_path: ws.clone(),
            expected_revision: created.revision,
            session_id: Some("task-main".to_owned()),
            path: "report.md".to_owned(),
            title: "Report".to_owned(),
            kind: "markdown".to_owned(),
            artifact_id: None,
            base_version_id: None,
            change_summary: None,
            work_item_id: None,
            provenance: None,
        })
        .await
        .unwrap();
    let artifact_id = task.artifacts[0].id.clone();

    let start = |expected_revision| StartArtifactRevisionRequest {
        task_id: created.id.clone(),
        workspace_path: ws.clone(),
        artifact_id: artifact_id.clone(),
        expected_revision,
        instruction: "Tighten the wording".to_owned(),
        base_version_id: None,
        title: None,
        provider: None,
        model: None,
    };
    let (_, _, revision) = coordinator
        .start_artifact_revision(start(task.revision))
        .await
        .unwrap();
    Fixture {
        _tmp: tmp,
        cowork_root,
        report,
        session_db,
        coordinator,
        revision,
        next_revision: start(0),
    }
}

/// Asserts the revision was settled as failed with the prior artifact restored, and that a
/// new revision can start again.
async fn assert_settled_as_failed(f: Fixture) {
    let Fixture {
        report,
        session_db,
        coordinator,
        revision,
        mut next_revision,
        ..
    } = f;
    let result = coordinator
        .handle_thread_outcome(&revision.session_id, "completed", None)
        .await
        .expect("capture failure must settle the revision, not propagate")
        .expect("revision outcome");

    assert_eq!(result.revision.id, revision.id);
    assert_eq!(result.revision.status, TaskArtifactRevisionStatus::Error);
    assert!(
        session_db
            .get_active_task_artifact_revision_for_session(&revision.session_id)
            .unwrap()
            .is_none(),
        "revision must no longer be active"
    );
    let work_item = result
        .task
        .work_items
        .iter()
        .find(|w| w.id == revision.work_item_id)
        .expect("revision work item");
    assert_ne!(
        work_item.status,
        WorkItemStatus::InProgress,
        "{work_item:?}"
    );
    assert_eq!(
        result.detail.versions.len(),
        1,
        "no version may be recorded for a failed capture"
    );
    assert_eq!(std::fs::read_to_string(&report).unwrap(), "# v1\n");

    // A new revision of the same artifact is accepted again.
    next_revision.expected_revision = result.task.revision;
    coordinator
        .start_artifact_revision(next_revision)
        .await
        .expect("a new revision can start after the failed one settled");
}

#[tokio::test]
async fn completed_revision_whose_output_was_removed_is_settled_as_failed() {
    let f = start_revision().await;
    std::fs::remove_file(&f.report).unwrap();
    assert_settled_as_failed(f).await;
}

#[tokio::test]
async fn completed_revision_whose_blob_write_fails_is_settled_as_failed() {
    let f = start_revision().await;
    // The revision thread rewrote the file, but storing its blob fails (a corrupt object
    // already occupies the content address, so the integrity check rejects the capture).
    let revised = "# v2\n";
    std::fs::write(&f.report, revised).unwrap();
    let sha = sha256_hex(revised.as_bytes());
    let blob = f
        .cowork_root
        .join("artifacts/objects/sha256")
        .join(&sha[..2])
        .join(&sha);
    std::fs::create_dir_all(blob.parent().unwrap()).unwrap();
    std::fs::write(&blob, "corrupt").unwrap();
    assert_settled_as_failed(f).await;
}
