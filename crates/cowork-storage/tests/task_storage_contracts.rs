use std::fs;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

use cowork_config::canonicalize_sync;
use cowork_storage::{
    ArtifactVersionStore, ArtifactVersionStoreOptions, CreateTaskRecordInput,
    QueueTaskQuestionsInput, ResolveTaskQuestionsInput, RestoreArtifactFileInput, SessionDb,
    SessionDbOptions, StorageError, TaskActivity, TaskActivityKind, TaskCreationOrigin,
    TaskDecision, TaskQuestion, TaskQuestionOption, TaskQuestionResolutionRecordInput,
    TaskQuestionStatus, TaskQuestionUrgency, TaskRequirement, TaskRequirementKind,
    TaskReviewRecord, TaskReviewVerdict, TaskStatus, TaskThread, TaskWorkItemRecordInput,
    WorkItemStatus, parse_and_validate_task_creation_input,
};
use serde_json::{Map, json};
use uuid::Uuid;

struct IsolatedTaskStorageEnv {
    root: PathBuf,
    cowork_root: PathBuf,
    workspace: PathBuf,
}

impl IsolatedTaskStorageEnv {
    fn new(tag: &str) -> Self {
        let base = canonicalize_sync(std::path::Path::new("/private/tmp"));
        let root = base.join(format!("cowork-task-storage-{tag}-{}", Uuid::new_v4()));
        let cowork_root = root.join(".cowork");
        let workspace = root.join("workspace");
        fs::create_dir_all(&cowork_root).unwrap();
        fs::create_dir_all(&workspace).unwrap();
        Self {
            root,
            cowork_root,
            workspace,
        }
    }

    async fn open_db(&self) -> SessionDb {
        SessionDb::open(SessionDbOptions {
            root_dir: self.cowork_root.clone(),
            db_path: None,
            sessions_dir: self.cowork_root.join("sessions"),
            busy_timeout_ms: Some(5_000),
        })
        .await
        .unwrap()
    }
}

impl Drop for IsolatedTaskStorageEnv {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[tokio::test]
async fn artifact_version_store_enforces_private_perms_integrity_and_live_file_conflicts() {
    let env = IsolatedTaskStorageEnv::new("artifacts");
    let store = ArtifactVersionStore::new(ArtifactVersionStoreOptions {
        root_dir: Some(env.cowork_root.join("artifacts")),
        homedir: None,
    });

    let live_file = env.workspace.join("docs/spec.md");
    fs::create_dir_all(live_file.parent().unwrap()).unwrap();
    fs::write(&live_file, b"# Version 1\n").unwrap();

    let v1 = store.capture_file(live_file.clone()).await.unwrap();
    assert_eq!(v1.size_bytes, 12);

    let blob_path = store.get_blob_path(&v1.sha256).unwrap();
    assert!(blob_path.exists());
    assert!(blob_path.to_string_lossy().contains(&format!(
        "objects/sha256/{}/{}",
        &v1.sha256[..2],
        v1.sha256
    )));

    #[cfg(unix)]
    {
        let dir_mode = fs::metadata(blob_path.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(dir_mode, 0o700);
        let file_mode = fs::metadata(&blob_path).unwrap().permissions().mode() & 0o777;
        assert_eq!(file_mode, 0o600);
    }

    // Write v2 and capture
    fs::write(&live_file, b"# Version 2\n").unwrap();
    let v2 = store.capture_file(live_file.clone()).await.unwrap();
    assert_ne!(v1.sha256, v2.sha256);

    // Simulate external edit creating v3 on disk without capturing
    fs::write(&live_file, b"# External Drift\n").unwrap();
    let v3_fp = store
        .fingerprint_file(live_file.clone())
        .await
        .unwrap()
        .unwrap();

    // Restoring v1 expecting v2's fingerprint must fail with ArtifactFingerprintConflict!
    let err = store
        .restore_file(RestoreArtifactFileInput {
            blob_sha256: v1.sha256.clone(),
            file_path: live_file.clone(),
            expected_fingerprint: Some(v2.sha256.clone()),
        })
        .await
        .unwrap_err();
    match err {
        StorageError::ArtifactFingerprintConflict {
            expected_fingerprint,
            actual_fingerprint,
        } => {
            assert_eq!(expected_fingerprint, v2.sha256);
            assert_eq!(actual_fingerprint, Some(v3_fp.sha256.clone()));
        }
        other => panic!("unexpected error: {other:?}"),
    }
    assert_eq!(fs::read(&live_file).unwrap(), b"# External Drift\n");

    // Restoring v1 with matching expected_fingerprint succeeds!
    store
        .restore_file(RestoreArtifactFileInput {
            blob_sha256: v1.sha256.clone(),
            file_path: live_file.clone(),
            expected_fingerprint: Some(v3_fp.sha256),
        })
        .await
        .unwrap();
    assert_eq!(fs::read(&live_file).unwrap(), b"# Version 1\n");
}

#[tokio::test]
async fn task_repository_enforces_occ_claims_questions_and_reviews() {
    let env = IsolatedTaskStorageEnv::new("repo");
    let db = env.open_db().await;
    let ws = env.workspace.to_string_lossy().into_owned();
    let now = "2026-04-18T12:00:00.000Z".to_string();

    let created = db
        .create_task_record(CreateTaskRecordInput {
            id: "task-1".to_string(),
            workspace_path: ws.clone(),
            title: "Build Deliverable".to_string(),
            objective: "Create architecture report".to_string(),
            context: "Chat context summary".to_string(),
            source_session_id: Some("chat-source-1".to_string()),
            creation_origin: TaskCreationOrigin::ChatTool,
            creation_idempotency_key: Some("idem-1".to_string()),
            initial_status: TaskStatus::Working,
            review_required: true,
            review_rounds: 3,
            thread: TaskThread {
                id: "tt-1".to_string(),
                task_id: "task-1".to_string(),
                session_id: "sess-primary-1".to_string(),
                title: "Primary".to_string(),
                created_by: "coordinator".to_string(),
                created_at: now.clone(),
                updated_at: now.clone(),
            },
            requirements: vec![TaskRequirement {
                id: "req-1".to_string(),
                kind: TaskRequirementKind::AcceptanceCriterion,
                text: "Deliver report.md".to_string(),
                source: "user".to_string(),
                permanence: "fixed".to_string(),
                status: "active".to_string(),
                created_at: now.clone(),
                supersedes: None,
            }],
            work_items: vec![
                TaskWorkItemRecordInput {
                    id: "wi-1".to_string(),
                    title: "Draft outline".to_string(),
                    description: "Outline sections".to_string(),
                    status: WorkItemStatus::Queued,
                    depends_on: vec![],
                    assigned_thread_id: Some("tt-1".to_string()),
                    claimed_by_thread_id: None,
                    expected_outputs: vec!["report.md".to_string()],
                    completion_evidence: None,
                    position: 0,
                    created_at: now.clone(),
                    updated_at: now.clone(),
                },
                TaskWorkItemRecordInput {
                    id: "wi-2".to_string(),
                    title: "Polish report".to_string(),
                    description: "Polish prose".to_string(),
                    status: WorkItemStatus::Queued,
                    depends_on: vec!["wi-1".to_string()],
                    assigned_thread_id: None,
                    claimed_by_thread_id: None,
                    expected_outputs: vec!["report.md".to_string()],
                    completion_evidence: None,
                    position: 1,
                    created_at: now.clone(),
                    updated_at: now.clone(),
                },
            ],
            decisions: vec![],
        })
        .await
        .unwrap();

    assert_eq!(created.revision, 0);
    assert!(db.is_task_thread("sess-primary-1").unwrap());
    assert!(!db.is_task_thread("chat-source-1").unwrap());
    assert_eq!(
        db.get_active_task_for_source_session("chat-source-1")
            .unwrap()
            .unwrap()
            .id,
        "task-1"
    );

    // Add second worker thread (revision 0 -> 1)
    let after_thread = db
        .add_task_thread(
            TaskThread {
                id: "tt-2".to_string(),
                task_id: "task-1".to_string(),
                session_id: "sess-worker-2".to_string(),
                title: "Worker 2".to_string(),
                created_by: "coordinator".to_string(),
                created_at: now.clone(),
                updated_at: now.clone(),
            },
            0,
        )
        .await
        .unwrap();
    assert_eq!(after_thread.revision, 1);

    // Stale expectedRevision=0 must fail with TaskRevisionConflict!
    let stale_err = db
        .claim_task_work_item(
            "task-1".to_string(),
            "wi-1".to_string(),
            "tt-1".to_string(),
            0,
            now.clone(),
        )
        .await
        .unwrap_err();
    assert!(matches!(
        stale_err,
        StorageError::TaskRevisionConflict {
            expected: 0,
            current: 1
        }
    ));

    // Atomic claim by tt-1 succeeds (revision 1 -> 2), conflicting claim by tt-2 fails!
    let claimed = db
        .claim_task_work_item(
            "task-1".to_string(),
            "wi-1".to_string(),
            "tt-1".to_string(),
            1,
            now.clone(),
        )
        .await
        .unwrap();
    assert_eq!(claimed.revision, 2);
    let conflict_claim = db
        .claim_task_work_item(
            "task-1".to_string(),
            "wi-1".to_string(),
            "tt-2".to_string(),
            2,
            now.clone(),
        )
        .await
        .unwrap_err();
    assert!(
        conflict_claim
            .to_string()
            .contains("Work item is already claimed by another task thread")
    );

    // Queue blocking question -> task moves to Blocked (revision 3 -> 4)
    // Note: failed claim rolled back, so revision is still 2!
    let queued = db
        .queue_task_questions(QueueTaskQuestionsInput {
            task_id: "task-1".to_string(),
            expected_revision: 2,
            questions: vec![TaskQuestion {
                id: "q-1".to_string(),
                task_id: "task-1".to_string(),
                thread_id: Some("tt-1".to_string()),
                work_item_id: Some("wi-1".to_string()),
                header: "Format".to_string(),
                question: "Which output tone?".to_string(),
                context: "Audience check".to_string(),
                blocking: true,
                urgency: TaskQuestionUrgency::Now,
                default_action: None,
                options: vec![TaskQuestionOption {
                    id: "exec".to_string(),
                    label: "Executive".to_string(),
                    description: "Concise".to_string(),
                }],
                recommended_option_id: Some("exec".to_string()),
                status: TaskQuestionStatus::Pending,
                provisional_decision_id: None,
                answer: None,
                answer_option_id: None,
                resolution_source: None,
                supersedes: None,
                created_at: now.clone(),
                resolved_at: None,
            }],
            provisional_decisions: vec![],
            block_task: true,
            updated_at: now.clone(),
        })
        .await
        .unwrap();
    assert_eq!(queued.status, TaskStatus::Blocked);
    assert_eq!(queued.blocking_question_count, 1);

    // Resolve blocking question -> task automatically moves back to Working!
    let resolved = db
        .resolve_task_questions(ResolveTaskQuestionsInput {
            task_id: "task-1".to_string(),
            expected_revision: queued.revision,
            resolutions: vec![TaskQuestionResolutionRecordInput {
                question_id: "q-1".to_string(),
                answer: "Executive".to_string(),
                answer_option_id: Some("exec".to_string()),
                decision: TaskDecision {
                    id: "dec-1".to_string(),
                    task_id: "task-1".to_string(),
                    question: "Which output tone?".to_string(),
                    resolution: "Executive".to_string(),
                    source: "user".to_string(),
                    scope: "task".to_string(),
                    confidence: Some(1.0),
                    status: "active".to_string(),
                    created_at: now.clone(),
                    supersedes: None,
                },
            }],
            updated_at: now.clone(),
        })
        .await
        .unwrap();
    assert_eq!(resolved.status, TaskStatus::Working);
    assert_eq!(resolved.blocking_question_count, 0);

    // Record review & address review
    let reviewed = db
        .record_task_review(
            TaskReviewRecord {
                id: "rev-1".to_string(),
                task_id: "task-1".to_string(),
                round: 1,
                verdict: TaskReviewVerdict::Partial,
                feedback: "Add metrics table".to_string(),
                reviewer_agent_id: "agent-rev-1".to_string(),
                reviewer_provider: "openai".to_string(),
                reviewer_model: "gpt-5.4".to_string(),
                task_revision: resolved.revision,
                material_fingerprint: "a".repeat(64),
                material_snapshot: Map::new(),
                created_at: now.clone(),
                addressed_at: None,
                implementation_summary: None,
            },
            TaskActivity {
                id: "rev-1".to_string(),
                seq: 1,
                task_id: "task-1".to_string(),
                thread_id: Some("tt-1".to_string()),
                work_item_id: None,
                kind: TaskActivityKind::ReviewCompleted,
                summary: "Review round 1 partial".to_string(),
                detail: None,
                created_at: now.clone(),
            },
            resolved.revision,
        )
        .await
        .unwrap();

    let addressed = db
        .address_task_review(
            "task-1".to_string(),
            "rev-1".to_string(),
            reviewed.revision,
            now.clone(),
            "Added metrics table".to_string(),
            TaskActivity {
                id: "act-addr-1".to_string(),
                seq: 1,
                task_id: "task-1".to_string(),
                thread_id: Some("tt-1".to_string()),
                work_item_id: None,
                kind: TaskActivityKind::ReviewAddressed,
                summary: "Addressed review round 1".to_string(),
                detail: None,
                created_at: now,
            },
        )
        .await
        .unwrap();
    let reviews = db.list_task_reviews("task-1").unwrap();
    assert_eq!(reviews.len(), 1);
    assert_eq!(
        reviews[0].implementation_summary.as_deref(),
        Some("Added metrics table")
    );
    assert_eq!(addressed.revision, reviewed.revision + 1);

    // Validate cycle detection in parse_and_validate_task_creation_input
    let cycle_err = parse_and_validate_task_creation_input(
        &json!({
            "idempotencyKey": "k1",
            "title": "Cyclic",
            "objective": "Obj",
            "context": "Ctx",
            "requirements": [{ "kind": "acceptance_criterion", "text": "Crit" }],
            "workItems": [
                { "key": "a", "title": "A", "dependsOn": ["b"], "expectedOutputs": ["out.md"] },
                { "key": "b", "title": "B", "dependsOn": ["a"], "expectedOutputs": [] }
            ]
        }),
        false,
    )
    .unwrap_err();
    assert!(
        cycle_err
            .to_string()
            .contains("Work item dependencies contain a cycle")
    );

    db.close();
}
