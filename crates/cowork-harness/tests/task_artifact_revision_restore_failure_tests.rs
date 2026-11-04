//! Regression (PR #389 review 4460464298): when an artifact revision is cancelled or fails
//! and restoring the prior artifact contents fails, the restore error must propagate before
//! the revision is recorded as cancelled/failed or the task is settled (TS
//! `failActiveRevisionOutcome` awaits `restoreFile` first). Swallowing it would leave the
//! revision's edited bytes on disk while settlement could auto-complete the task and accept
//! the stored prior version.

use std::sync::Arc;

use async_trait::async_trait;
use cowork_harness::tasks::{
    RegisterArtifactRequest, StartArtifactRevisionRequest, TaskCoordinator, TaskCoordinatorOptions,
    TaskThreadFactory, TaskThreadFactoryInput,
};
use cowork_storage::{
    ArtifactVersionStore, ArtifactVersionStoreOptions, SessionDb, SessionDbOptions, TaskStatus,
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

async fn assert_restore_failure_propagates(outcome: &str) {
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
    let original = "# v1\n";
    std::fs::write(&report, original).unwrap();

    let creation = parse_and_validate_task_creation_input(
        &json!({
            "idempotencyKey": format!("rev-restore-fail-{outcome}"),
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
            cowork_storage::TaskCreationOrigin::ChatTool,
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
    let (task_before, _, revision) = coordinator
        .start_artifact_revision(StartArtifactRevisionRequest {
            task_id: created.id.clone(),
            workspace_path: ws.clone(),
            artifact_id,
            expected_revision: task.revision,
            instruction: "Tighten the wording".to_owned(),
            base_version_id: None,
            title: None,
            provider: None,
            model: None,
        })
        .await
        .unwrap();

    // The revision thread edited the file, then the stored prior blob became unreadable
    // (corrupted at its content address), so restoring the prior version fails.
    let edited = "# v2 (edited by the revision)\n";
    std::fs::write(&report, edited).unwrap();
    let sha = sha256_hex(original.as_bytes());
    let blob = cowork_root
        .join("artifacts/objects/sha256")
        .join(&sha[..2])
        .join(&sha);
    assert!(
        blob.exists(),
        "prior blob must be stored at {}",
        blob.display()
    );
    std::fs::write(&blob, "corrupt").unwrap();

    let result = coordinator
        .handle_thread_outcome(&revision.session_id, outcome, None)
        .await;
    assert!(
        result.is_err(),
        "a failed restore must propagate for outcome {outcome}, got {result:?}"
    );

    // Nothing was settled: the revision is still active, the task did not move on, and the
    // edited bytes were not silently accepted as the prior version.
    let still_active = session_db
        .get_active_task_artifact_revision_for_session(&revision.session_id)
        .unwrap()
        .expect("revision must stay active when its prior artifact could not be restored");
    assert_eq!(still_active.id, revision.id);
    assert_eq!(still_active.status, revision.status);
    let task_after = session_db.get_task(&created.id).unwrap().expect("task");
    assert_ne!(task_after.status, TaskStatus::Completed);
    assert_eq!(task_after.status, task_before.status);
    assert_eq!(std::fs::read_to_string(&report).unwrap(), edited);
}

#[tokio::test]
async fn cancelled_revision_propagates_prior_restore_failure() {
    assert_restore_failure_propagates("cancelled").await;
}

#[tokio::test]
async fn errored_revision_propagates_prior_restore_failure() {
    assert_restore_failure_propagates("error").await;
}
