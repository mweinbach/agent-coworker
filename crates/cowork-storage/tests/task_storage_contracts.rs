use std::fs;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

use cowork_config::canonicalize_sync;
use cowork_storage::{
    ArtifactVersionStore, ArtifactVersionStoreOptions, CreateTaskRecordInput,
    QueueTaskQuestionsInput, ResolveTaskQuestionsInput, RestoreArtifactFileInput, SessionDb,
    SessionDbOptions, SetTaskStatusInput, StorageError, TaskActivity, TaskActivityKind,
    TaskCreationOrigin, TaskDecision, TaskQuestion, TaskQuestionOption,
    TaskQuestionResolutionRecordInput, TaskQuestionStatus, TaskQuestionUrgency, TaskRecord,
    TaskRequirement, TaskRequirementKind, TaskReviewRecord, TaskReviewVerdict, TaskStatus,
    TaskThread, TaskWorkItemRecordInput, WorkItemStatus, parse_and_validate_task_creation_input,
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
        let base = canonicalize_sync(&std::env::temp_dir());
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
    // Compare components so the check holds with `\\` separators on Windows.
    assert!(
        blob_path.ends_with(
            std::path::Path::new("objects")
                .join("sha256")
                .join(&v1.sha256[..2])
                .join(&v1.sha256)
        ),
        "unexpected blob path {}",
        blob_path.display()
    );

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

/// `list_tasks(workspace)` must find tasks whose stored `workspace_path` is spelled differently
/// from today's canonical form (pre-upgrade / Electron-written rows; on Windows plain `C:\…`
/// versus `\\?\C:\…`), matching with `same_workspace_path` rather than SQL string equality.
#[tokio::test]
async fn list_tasks_matches_equivalent_workspace_path_spellings() {
    let env = IsolatedTaskStorageEnv::new("list-equivalent");
    let db = env.open_db().await;
    let ws = env.workspace.to_string_lossy().into_owned();
    let other_ws = env.root.join("other");
    fs::create_dir_all(&other_ws).unwrap();

    create_minimal_task(&db, "task-plain", &ws).await;
    create_minimal_task(&db, "task-other", &other_ws.to_string_lossy()).await;
    // Simulate a row persisted with a non-canonical spelling of the same workspace.
    let alias = format!("{ws}{}", std::path::MAIN_SEPARATOR);
    let conn = rusqlite::Connection::open(db.db_path()).unwrap();
    conn.execute(
        "UPDATE tasks SET workspace_path = ?1 WHERE task_id = 'task-plain'",
        rusqlite::params![alias],
    )
    .unwrap();

    let listed = db.list_tasks(Some(&ws)).unwrap();
    assert_eq!(
        listed.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
        vec!["task-plain"]
    );
    assert_eq!(db.list_tasks(None).unwrap().len(), 2);
    db.close();
}

async fn create_minimal_task(db: &SessionDb, task_id: &str, workspace: &str) -> TaskRecord {
    let now = "2026-04-18T12:00:00.000Z".to_string();
    db.create_task_record(CreateTaskRecordInput {
        id: task_id.to_string(),
        workspace_path: workspace.to_string(),
        title: "Listed".to_string(),
        objective: "Objective".to_string(),
        context: String::new(),
        source_session_id: None,
        creation_origin: TaskCreationOrigin::Manual,
        creation_idempotency_key: None,
        initial_status: TaskStatus::Working,
        review_required: false,
        review_rounds: 0,
        thread: TaskThread {
            id: format!("tt-{task_id}"),
            task_id: task_id.to_string(),
            session_id: format!("sess-{task_id}"),
            title: "Primary".to_string(),
            created_by: "coordinator".to_string(),
            created_at: now.clone(),
            updated_at: now.clone(),
        },
        requirements: vec![],
        work_items: vec![],
        decisions: vec![],
    })
    .await
    .unwrap()
}

/// A validated task write keeps a manual `BEGIN IMMEDIATE` open across its async validator.
/// Cancelling the future mid-validation (interrupt, timeout, disconnected client) must roll the
/// transaction back so the shared write connection is usable again and nothing half-applied
/// is committed.
#[tokio::test]
async fn cancelled_validated_task_write_rolls_back_open_transaction() {
    let env = IsolatedTaskStorageEnv::new("cancelled-validated-write");
    let db = env.open_db().await;
    let ws = env.workspace.to_string_lossy().into_owned();
    let created = create_minimal_task(&db, "task-cancel", &ws).await;

    let set_failed = |expected_revision: i64| SetTaskStatusInput {
        task_id: "task-cancel".to_string(),
        expected_revision,
        status: TaskStatus::Failed,
        summary: "Failed".to_string(),
        detail: None,
        updated_at: "2026-04-18T12:01:00.000Z".to_string(),
        thread_id: None,
    };
    let stalled = tokio::time::timeout(
        std::time::Duration::from_millis(50),
        db.set_task_status_validated(
            set_failed(created.revision),
            |_task| std::future::pending::<cowork_storage::Result<()>>(),
            None,
        ),
    )
    .await;
    assert!(
        stalled.is_err(),
        "validator never completes, so the write times out"
    );

    // Nothing from the cancelled write was committed ...
    let unchanged = db.get_task("task-cancel").unwrap().unwrap();
    assert_eq!(unchanged.status, TaskStatus::Working);
    assert_eq!(unchanged.revision, created.revision);
    // ... and the shared write connection accepts new transactions.
    let failed = db
        .set_task_status(set_failed(created.revision))
        .await
        .unwrap();
    assert_eq!(failed.status, TaskStatus::Failed);
    create_minimal_task(&db, "task-after-cancel", &ws).await;
    db.close();
}

#[tokio::test]
async fn list_tasks_preserves_mixed_aliases_symlinks_counts_order_empty_and_unscoped() {
    let env = IsolatedTaskStorageEnv::new("list-full-characterization");
    let db = env.open_db().await;
    let target_ws = env.workspace.to_string_lossy().into_owned();
    let other_dir = env.root.join("other-workspace");
    let empty_dir = env.root.join("empty-workspace");
    fs::create_dir_all(&other_dir).unwrap();
    fs::create_dir_all(&empty_dir).unwrap();
    let other_ws = other_dir.to_string_lossy().into_owned();
    let empty_ws = empty_dir.to_string_lossy().into_owned();

    let trailing_alias = format!("{target_ws}{}", std::path::MAIN_SEPARATOR);
    #[cfg(unix)]
    let alt_alias = {
        let link = env.root.join("workspace-symlink");
        std::os::unix::fs::symlink(&env.workspace, &link).unwrap();
        link.to_string_lossy().into_owned()
    };
    #[cfg(not(unix))]
    let alt_alias = format!("{target_ws}{}.", std::path::MAIN_SEPARATOR);

    // Seed 5 tasks across 2 active workspaces (3 stored spellings for target_ws) plus an
    // unrelated workspace, with strictly unequal timestamps interleaved across workspaces.
    create_minimal_task(&db, "task-target-canon", &target_ws).await;
    create_minimal_task(&db, "task-other-newer", &other_ws).await;
    create_minimal_task(&db, "task-target-alias", &target_ws).await;
    create_minimal_task(&db, "task-target-symlink", &target_ws).await;
    create_minimal_task(&db, "task-other-older", &other_ws).await;

    let conn = rusqlite::Connection::open(db.db_path()).unwrap();
    conn.execute_batch("BEGIN IMMEDIATE;").unwrap();

    // Update stored workspace spellings and distinct descending timestamps.
    for (id, ws_spelling, updated_at) in [
        (
            "task-target-canon",
            target_ws.as_str(),
            "2026-04-18T12:05:00.000Z",
        ),
        (
            "task-other-newer",
            other_ws.as_str(),
            "2026-04-18T12:04:00.000Z",
        ),
        (
            "task-target-alias",
            trailing_alias.as_str(),
            "2026-04-18T12:03:00.000Z",
        ),
        (
            "task-target-symlink",
            alt_alias.as_str(),
            "2026-04-18T12:02:00.000Z",
        ),
        (
            "task-other-older",
            other_ws.as_str(),
            "2026-04-18T12:01:00.000Z",
        ),
    ] {
        conn.execute(
            "UPDATE tasks SET workspace_path = ?1, updated_at = ?2 WHERE task_id = ?3",
            rusqlite::params![ws_spelling, updated_at, id],
        )
        .unwrap();
    }

    // Extra threads: task-target-canon -> 2 total, task-target-alias -> 3 total.
    for (tid, task_id, sid) in [
        ("tt-extra-1", "task-target-canon", "sess-extra-1"),
        ("tt-extra-2", "task-target-alias", "sess-extra-2"),
        ("tt-extra-3", "task-target-alias", "sess-extra-3"),
    ] {
        conn.execute(
            "INSERT INTO task_threads (thread_id, task_id, session_id, title, created_by, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'Extra', 'coordinator', '2026-04-18T12:00:00.000Z', '2026-04-18T12:00:00.000Z')",
            rusqlite::params![tid, task_id, sid],
        )
        .unwrap();
    }

    // Work items across matching and unrelated tasks.
    for (wid, task_id, status, pos) in [
        ("wi-c-1", "task-target-canon", "done", 0),
        ("wi-c-2", "task-target-canon", "done", 1),
        ("wi-c-3", "task-target-canon", "in_progress", 2),
        ("wi-c-4", "task-target-canon", "pending", 3),
        ("wi-on-1", "task-other-newer", "done", 0),
        ("wi-on-2", "task-other-newer", "done", 1),
        ("wi-on-3", "task-other-newer", "done", 2),
        ("wi-a-1", "task-target-alias", "done", 0),
        ("wi-a-2", "task-target-alias", "pending", 1),
        ("wi-s-1", "task-target-symlink", "pending", 0),
    ] {
        conn.execute(
            "INSERT INTO task_work_items (
                work_item_id, task_id, title, description, status, assigned_thread_id,
                expected_outputs_json, completion_evidence, position, created_at, updated_at
             ) VALUES (?1, ?2, 'Item', 'Desc', ?3, NULL, '[]', NULL, ?4, '2026-04-18T12:00:00.000Z', '2026-04-18T12:00:00.000Z')",
            rusqlite::params![wid, task_id, status, pos],
        )
        .unwrap();
    }

    // Blockers: mix of active and resolved, plus tasks with zero blockers.
    for (bid, task_id, status) in [
        ("blk-c-1", "task-target-canon", "active"),
        ("blk-c-2", "task-target-canon", "active"),
        ("blk-c-3", "task-target-canon", "resolved"),
        ("blk-on-1", "task-other-newer", "active"),
        ("blk-s-1", "task-target-symlink", "active"),
        ("blk-oo-1", "task-other-older", "resolved"),
    ] {
        conn.execute(
            "INSERT INTO task_blockers (blocker_id, task_id, work_item_id, description, blocking, status, created_at, resolved_at)
             VALUES (?1, ?2, NULL, 'Blocked', 1, ?3, '2026-04-18T12:00:00.000Z', NULL)",
            rusqlite::params![bid, task_id, status],
        )
        .unwrap();
    }

    // Questions: mix of pending blocking, pending non-blocking, and answered.
    for (qid, task_id, blocking, status) in [
        ("q-c-1", "task-target-canon", 1, "pending"),
        ("q-c-2", "task-target-canon", 0, "pending"),
        ("q-c-3", "task-target-canon", 1, "answered"),
        ("q-on-1", "task-other-newer", 1, "pending"),
        ("q-a-1", "task-target-alias", 0, "pending"),
    ] {
        conn.execute(
            "INSERT INTO task_questions (
                question_id, task_id, thread_id, work_item_id, header, question, context,
                blocking, urgency, default_action, options_json, recommended_option_id,
                status, provisional_decision_id, answer, answer_option_id, resolution_source,
                supersedes, created_at, resolved_at
             ) VALUES (?1, ?2, NULL, NULL, 'Hdr', 'Q?', '', ?3, 'normal', NULL, '[]', NULL, ?4, NULL, NULL, NULL, NULL, NULL, '2026-04-18T12:00:00.000Z', NULL)",
            rusqlite::params![qid, task_id, blocking, status],
        )
        .unwrap();
    }
    conn.execute_batch("COMMIT;").unwrap();
    drop(conn);

    // 1. Scoped query with mixed canonical + trailing-slash alias + real symlink rows.
    let by_canon = db.list_tasks(Some(&target_ws)).unwrap();
    assert_eq!(
        by_canon.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
        vec![
            "task-target-canon",
            "task-target-alias",
            "task-target-symlink"
        ]
    );
    assert_eq!(by_canon[0].workspace_path, target_ws);
    assert_eq!(by_canon[0].thread_count, 2);
    assert_eq!(by_canon[0].completed_work_item_count, 2);
    assert_eq!(by_canon[0].total_work_item_count, 4);
    assert_eq!(by_canon[0].active_blocker_count, 2);
    assert_eq!(by_canon[0].pending_question_count, 2);
    assert_eq!(by_canon[0].blocking_question_count, 1);

    assert_eq!(by_canon[1].workspace_path, trailing_alias);
    assert_eq!(by_canon[1].thread_count, 3);
    assert_eq!(by_canon[1].completed_work_item_count, 1);
    assert_eq!(by_canon[1].total_work_item_count, 2);
    assert_eq!(by_canon[1].active_blocker_count, 0);
    assert_eq!(by_canon[1].pending_question_count, 1);
    assert_eq!(by_canon[1].blocking_question_count, 0);

    assert_eq!(by_canon[2].workspace_path, alt_alias);
    assert_eq!(by_canon[2].thread_count, 1);
    assert_eq!(by_canon[2].completed_work_item_count, 0);
    assert_eq!(by_canon[2].total_work_item_count, 1);
    assert_eq!(by_canon[2].active_blocker_count, 1);
    assert_eq!(by_canon[2].pending_question_count, 0);
    assert_eq!(by_canon[2].blocking_question_count, 0);

    // Querying by trailing-slash alias or real symlink must yield identical summaries.
    assert_eq!(db.list_tasks(Some(&trailing_alias)).unwrap(), by_canon);
    assert_eq!(db.list_tasks(Some(&alt_alias)).unwrap(), by_canon);

    // 2. Single-spelling exact workspace path (hits single-workspace fast path).
    let by_other = db.list_tasks(Some(&other_ws)).unwrap();
    assert_eq!(
        by_other.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
        vec!["task-other-newer", "task-other-older"]
    );
    assert_eq!(by_other[0].completed_work_item_count, 3);
    assert_eq!(by_other[0].total_work_item_count, 3);
    assert_eq!(by_other[0].active_blocker_count, 1);
    assert_eq!(by_other[0].pending_question_count, 1);
    assert_eq!(by_other[0].blocking_question_count, 1);
    assert_eq!(by_other[1].total_work_item_count, 0);
    assert_eq!(by_other[1].active_blocker_count, 0);

    // 3. Empty workspace returns no rows.
    assert!(db.list_tasks(Some(&empty_ws)).unwrap().is_empty());

    // 4. Unscoped query returns all tasks in global descending updated_at order with identical
    //    per-task summaries.
    let unscoped = db.list_tasks(None).unwrap();
    assert_eq!(
        unscoped.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
        vec![
            "task-target-canon",
            "task-other-newer",
            "task-target-alias",
            "task-target-symlink",
            "task-other-older",
        ]
    );
    assert_eq!(unscoped[0], by_canon[0]);
    assert_eq!(unscoped[1], by_other[0]);
    assert_eq!(unscoped[2], by_canon[1]);
    assert_eq!(unscoped[3], by_canon[2]);
    assert_eq!(unscoped[4], by_other[1]);

    db.close();
}

#[tokio::test]
async fn list_tasks_snapshot_is_consistent_inside_write_tx_and_under_concurrent_writes() {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    let env = IsolatedTaskStorageEnv::new("list-snapshot-consistency");
    let db = Arc::new(env.open_db().await);
    let ws = env.workspace.to_string_lossy().into_owned();
    let other_dir = env.root.join("other-concurrent");
    fs::create_dir_all(&other_dir).unwrap();
    let other_ws = other_dir.to_string_lossy().into_owned();

    let created = create_minimal_task(&db, "task-tx-check", &ws).await;
    create_minimal_task(&db, "task-other-initial", &other_ws).await;

    // Calling list_tasks inside an open write transaction (set_task_status_validated validator)
    // must reuse the caller's active transaction without nested-BEGIN failure and see the
    // uncommitted mutation, while a validator rejection still rolls everything back cleanly.
    let db_in_tx = Arc::clone(&db);
    let ws_in_tx = ws.clone();
    let res = db
        .set_task_status_validated(
            SetTaskStatusInput {
                task_id: "task-tx-check".to_string(),
                expected_revision: created.revision,
                status: TaskStatus::Completed,
                summary: "Should roll back".to_string(),
                detail: None,
                updated_at: "2026-04-18T12:05:00.000Z".to_string(),
                thread_id: None,
            },
            move |_task| {
                let db_inner = Arc::clone(&db_in_tx);
                let ws_inner = ws_in_tx.clone();
                async move {
                    let listed = db_inner.list_tasks(Some(&ws_inner))?;
                    assert_eq!(listed.len(), 1);
                    assert_eq!(listed[0].id, "task-tx-check");
                    assert_eq!(listed[0].status, TaskStatus::Completed);
                    Err(StorageError::Validation {
                        field: "status".to_string(),
                        message: "intentional rollback".to_string(),
                    })
                }
            },
            None,
        )
        .await;
    assert!(res.is_err());

    let after_rollback = db.list_tasks(Some(&ws)).unwrap();
    assert_eq!(after_rollback.len(), 1);
    assert_eq!(after_rollback[0].status, TaskStatus::Working);

    // Concurrent scoped reads on ro_conn alongside concurrent writes on rw_conn must never fail
    // or observe torn/partial rows.
    let stop = Arc::new(AtomicBool::new(false));
    let reader_db = Arc::clone(&db);
    let reader_ws = ws.clone();
    let reader_stop = Arc::clone(&stop);
    let reader = std::thread::spawn(move || {
        let mut reads = 0usize;
        while !reader_stop.load(Ordering::Acquire) {
            let listed = reader_db.list_tasks(Some(&reader_ws)).unwrap();
            assert!(!listed.is_empty());
            for row in &listed {
                assert!(row.id.starts_with("task-tx-check") || row.id.starts_with("task-conc-"));
                assert_eq!(row.thread_count, 1);
            }
            reads += 1;
        }
        reads
    });

    let trailing_alias = format!("{ws}{}", std::path::MAIN_SEPARATOR);
    for i in 0..16 {
        let target_spelling = if i % 2 == 0 {
            ws.as_str()
        } else {
            trailing_alias.as_str()
        };
        create_minimal_task(&db, &format!("task-conc-{i:02}"), target_spelling).await;
        create_minimal_task(&db, &format!("task-other-conc-{i:02}"), &other_ws).await;
    }

    stop.store(true, Ordering::Release);
    let read_count = reader.join().unwrap();
    assert!(
        read_count > 0,
        "reader should execute at least one snapshot read"
    );

    let final_ws = db.list_tasks(Some(&ws)).unwrap();
    assert_eq!(final_ws.len(), 17);
    let final_all = db.list_tasks(None).unwrap();
    assert_eq!(final_all.len(), 34);

    db.close();
}
