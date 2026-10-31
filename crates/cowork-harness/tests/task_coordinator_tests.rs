use std::io::{Cursor, Write};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use async_trait::async_trait;
use cowork_harness::tasks::{
    ArtifactBlobInput, ArtifactComparisonService, ArtifactPreviewService,
    CaptureArtifactVersionRequest, RegisterArtifactRequest, RestoreArtifactVersionRequest,
    TaskContinuationDispatcher, TaskCoordinator, TaskCoordinatorError, TaskCoordinatorOptions,
    TaskLockKind, TaskNotification, TaskQuestionAnswerInput, TaskQuestionResumeStatus,
    TaskThreadFactory, TaskThreadFactoryInput, TaskThreadQuiescer, get_session_task_lock,
    render_task_context_section,
};
use cowork_storage::{
    ArtifactVersionStore, ArtifactVersionStoreOptions, SessionDb, SessionDbOptions,
    TaskCreationOrigin, TaskDirective, TaskDirectiveContinuation, TaskDirectiveQuestionInput,
    TaskDirectiveQuestionOptionInput, TaskQuestionUrgency, TaskRecord, TaskReviewVerdict,
    TaskStatus, WorkItemStatus, parse_and_validate_task_creation_input,
};
use parking_lot::Mutex;
use serde_json::{Value, json};
use uuid::Uuid;
use zip::ZipWriter;
use zip::write::SimpleFileOptions;

struct TestHarnessEnv {
    base_dir: PathBuf,
    workspace_dir: PathBuf,
    session_db: Arc<SessionDb>,
    artifact_store: Arc<ArtifactVersionStore>,
}

impl TestHarnessEnv {
    async fn new(tag: &str) -> Self {
        let base_dir = PathBuf::from(format!("/private/tmp/cowork-tc-{tag}-{}", Uuid::new_v4()));
        let workspace_dir = base_dir.join("workspace");
        let home_dir = base_dir.join("home");
        let cowork_root = home_dir.join(".cowork");
        std::fs::create_dir_all(&workspace_dir).expect("create workspace");
        std::fs::create_dir_all(&cowork_root).expect("create .cowork");
        let session_db = Arc::new(
            SessionDb::open(SessionDbOptions {
                root_dir: cowork_root.clone(),
                db_path: None,
                sessions_dir: cowork_root.join("sessions"),
                busy_timeout_ms: Some(5_000),
            })
            .await
            .expect("open session_db"),
        );
        let artifact_store = Arc::new(ArtifactVersionStore::new(ArtifactVersionStoreOptions {
            root_dir: Some(cowork_root.join("artifacts")),
            homedir: Some(home_dir),
        }));
        Self {
            base_dir,
            workspace_dir,
            session_db,
            artifact_store,
        }
    }

    fn workspace_str(&self) -> String {
        std::fs::canonicalize(&self.workspace_dir)
            .expect("canonical workspace")
            .to_string_lossy()
            .into_owned()
    }
}

impl Drop for TestHarnessEnv {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.base_dir);
    }
}

struct MockThreadFactory {
    counter: AtomicUsize,
}

#[async_trait]
impl TaskThreadFactory for MockThreadFactory {
    async fn create_task_thread(&self, _input: TaskThreadFactoryInput) -> Result<String, String> {
        let idx = self.counter.fetch_add(1, Ordering::SeqCst) + 1;
        Ok(format!("worker-sess-{idx}-{}", Uuid::new_v4()))
    }
}

struct MockContinuationDispatcher {
    should_fail: AtomicBool,
    calls: Mutex<Vec<(String, String, String)>>,
    mode: Mutex<TaskQuestionResumeStatus>,
}

#[async_trait]
impl TaskContinuationDispatcher for MockContinuationDispatcher {
    async fn dispatch_continuation(
        &self,
        session_id: String,
        prompt: String,
        display_text: String,
    ) -> Result<TaskQuestionResumeStatus, String> {
        self.calls.lock().push((session_id, prompt, display_text));
        if self.should_fail.load(Ordering::SeqCst) {
            return Err("Simulated continuation dispatch error".to_owned());
        }
        Ok(self.mode.lock().clone())
    }
}

struct MockQuiescer {
    quiesced_calls: Mutex<Vec<(String, TaskStatus, Option<String>)>>,
}

#[async_trait]
impl TaskThreadQuiescer for MockQuiescer {
    async fn quiesce_task_threads(
        &self,
        task: TaskRecord,
        reason: TaskStatus,
        origin_session_id: Option<String>,
    ) -> Result<(), String> {
        self.quiesced_calls
            .lock()
            .push((task.id.clone(), reason, origin_session_id));
        Ok(())
    }
}

#[tokio::test]
async fn promotion_locking_occ_dag_claims_and_question_auto_resume() {
    let env = TestHarnessEnv::new("dag-occ").await;

    let notifications: Arc<Mutex<Vec<TaskNotification>>> = Arc::new(Mutex::new(Vec::new()));
    let notif_sink = notifications.clone();
    let quiescer = Arc::new(MockQuiescer {
        quiesced_calls: Mutex::new(Vec::new()),
    });
    let coordinator = TaskCoordinator::new(TaskCoordinatorOptions {
        session_db: env.session_db.clone(),
        notify: Some(Arc::new(move |n| notif_sink.lock().push(n))),
        artifact_store: Some(env.artifact_store.clone()),
        quiesce_task_threads: Some(quiescer.clone()),
    })
    .expect("create coordinator");

    coordinator.set_thread_factory(Arc::new(MockThreadFactory {
        counter: AtomicUsize::new(0),
    }));
    let dispatcher = Arc::new(MockContinuationDispatcher {
        should_fail: AtomicBool::new(false),
        calls: Mutex::new(Vec::new()),
        mode: Mutex::new(TaskQuestionResumeStatus::Queued),
    });
    coordinator.set_continuation_dispatcher(dispatcher.clone());

    let creation = parse_and_validate_task_creation_input(
        &json!({
            "idempotencyKey": "promote-1",
            "title": "Build Analytics Pipeline",
            "objective": "Ship schema and ETL worker",
            "context": "Promoted from source chat",
            "requirements": [
                {
                    "kind": "acceptance_criterion",
                    "text": "Schema and ETL worker implemented"
                }
            ],
            "workItems": [
                {
                    "key": "schema",
                    "title": "Design schema",
                    "description": "Write schema DDL",
                    "expectedOutputs": ["schema.sql"]
                },
                {
                    "key": "etl",
                    "title": "Implement ETL",
                    "description": "Depends on schema",
                    "dependsOn": ["schema"],
                    "expectedOutputs": ["etl.rs"]
                }
            ]
        }),
        false,
    )
    .expect("valid creation input");

    let ws = env.workspace_str();
    let promoted = coordinator
        .create_planned(
            &ws,
            "task-main-1",
            Some("source-chat-1"),
            TaskCreationOrigin::ChatTool,
            "keep_project",
            creation,
            Some("Main"),
        )
        .await
        .expect("create_planned");

    let task = promoted.task;
    assert_eq!(task.status, TaskStatus::Working);
    assert_eq!(task.review_rounds, 3);
    assert!(coordinator.is_task_thread("task-main-1"));
    assert!(!coordinator.is_task_thread("source-chat-1"));

    // Source chat must be task_locked while active!
    let src_lock = get_session_task_lock(Some(&env.session_db), "source-chat-1", None)
        .expect("source chat must be locked");
    assert_eq!(src_lock.data.category, "task_locked");
    assert_eq!(src_lock.data.lock_kind, TaskLockKind::ActiveSourceChat);
    assert_eq!(src_lock.data.task_id, task.id);

    // Optimistic concurrency: stale expectedRevision must fail with RevisionConflict
    let occ_err = coordinator
        .record_decision(
            &task.id,
            &ws,
            task.revision + 99,
            "DB engine?",
            "SQLite WAL",
            "agent",
            None,
            Some(0.9),
            None,
        )
        .await
        .expect_err("stale revision must fail");
    match occ_err {
        TaskCoordinatorError::RevisionConflict { expected, current } => {
            assert_eq!(expected, task.revision + 99);
            assert_eq!(current, task.revision);
        }
        other => panic!("expected RevisionConflict, got {other:?}"),
    }

    // DAG enforcement: cannot claim `etl` before `schema` is done
    let schema_wi = &task.work_items[0];
    let etl_wi = &task.work_items[1];
    let main_thread_id = &task.threads[0].id;

    let dag_err = coordinator
        .claim_work_item(&task.id, &ws, &etl_wi.id, main_thread_id, task.revision)
        .await
        .expect_err("claiming dependent work item before dependency done must fail");
    assert!(
        dag_err.to_string().contains("dependency is not complete"),
        "unexpected error: {dag_err}"
    );

    // Add a worker thread that atomically claims `schema`
    let after_worker_1 = coordinator
        .add_thread(
            &task.id,
            &ws,
            "Schema Worker",
            task.revision,
            "coordinator",
            Some(&schema_wi.id),
            None,
            None,
        )
        .await
        .expect("add worker thread claiming schema");
    let worker_1_thread = &after_worker_1.threads[1];
    assert!(coordinator.is_task_thread(&worker_1_thread.session_id));

    // Another thread trying to claim `schema` must fail (atomic ownership)
    let claim_conflict = coordinator
        .claim_work_item(
            &task.id,
            &ws,
            &schema_wi.id,
            main_thread_id,
            after_worker_1.revision,
        )
        .await
        .expect_err("second worker claiming already-claimed item must fail");
    assert!(
        claim_conflict
            .to_string()
            .contains("owned by another task thread")
    );

    // Mark `schema` done with evidence, then `etl` becomes claimable!
    let after_schema_done = coordinator
        .mark_work_item(
            &task.id,
            &ws,
            &schema_wi.id,
            after_worker_1.revision,
            WorkItemStatus::Done,
            Some("Created tables in migrations.sql"),
            Some(&worker_1_thread.id),
        )
        .await
        .expect("mark schema done");
    let after_etl_claim = coordinator
        .claim_work_item(
            &task.id,
            &ws,
            &etl_wi.id,
            main_thread_id,
            after_schema_done.revision,
        )
        .await
        .expect("etl can now be claimed");
    assert_eq!(
        after_etl_claim.work_items[1].status,
        WorkItemStatus::InProgress
    );

    // Blocking question pauses for input and transitions task to Blocked
    let req_res = coordinator
        .apply_directive(
            "task-main-1",
            TaskDirective::RequestInput {
                idempotency_key: "ask-1".to_owned(),
                expected_revision: after_etl_claim.revision,
                questions: vec![TaskDirectiveQuestionInput {
                    header: "Retention".to_owned(),
                    question: "How long should raw events be retained?".to_owned(),
                    context: Some("Storage budget trade-off".to_owned()),
                    blocking: true,
                    urgency: TaskQuestionUrgency::Now,
                    default_action: None,
                    options: Some(vec![
                        TaskDirectiveQuestionOptionInput {
                            id: "30d".to_owned(),
                            label: "30 days".to_owned(),
                            description: Some("Compact retention".to_owned()),
                        },
                        TaskDirectiveQuestionOptionInput {
                            id: "90d".to_owned(),
                            label: "90 days".to_owned(),
                            description: Some("Quarterly retention".to_owned()),
                        },
                    ]),
                    recommended_option_id: Some("90d".to_owned()),
                    work_item_id: Some(etl_wi.id.clone()),
                    supersedes: None,
                }],
            },
        )
        .await
        .expect("request blocking input");
    assert_eq!(
        req_res.continuation,
        TaskDirectiveContinuation::PauseForInput
    );
    assert_eq!(req_res.task.status, TaskStatus::Blocked);
    let q_id = req_res.task.questions[0].id.clone();

    // Resolving blocking question transitions back to Working and dispatches continuation!
    let (resumed_task, resume_status) = coordinator
        .resolve_questions(
            &task.id,
            &ws,
            req_res.task.revision,
            vec![TaskQuestionAnswerInput {
                question_id: q_id,
                option_id: Some("90d".to_owned()),
                text: None,
            }],
        )
        .await
        .expect("resolve blocking question");
    assert_eq!(resumed_task.status, TaskStatus::Working);
    assert_eq!(resume_status, TaskQuestionResumeStatus::Queued);
    assert_eq!(dispatcher.calls.lock().len(), 1);
    assert!(dispatcher.calls.lock()[0].1.contains("90 days"));

    // Context section renders task state cleanly
    let ctx = coordinator
        .get_context_for_thread("task-main-1")
        .expect("task context snapshot");
    let rendered = render_task_context_section(Some(&ctx));
    assert!(rendered.contains("## Active Task"));
    assert!(rendered.contains("Ship schema and ETL worker"));
    assert!(rendered.contains("90 days"));
}

#[tokio::test]
async fn artifact_store_conflict_detection_three_round_reviews_and_terminal_quiesce() {
    let env = TestHarnessEnv::new("review-artifacts").await;

    let quiescer = Arc::new(MockQuiescer {
        quiesced_calls: Mutex::new(Vec::new()),
    });
    let coordinator = TaskCoordinator::new(TaskCoordinatorOptions {
        session_db: env.session_db.clone(),
        notify: None,
        artifact_store: Some(env.artifact_store.clone()),
        quiesce_task_threads: Some(quiescer.clone()),
    })
    .expect("create coordinator");

    let ws = env.workspace_str();
    let report_path = env.workspace_dir.join("report.md");
    std::fs::write(&report_path, "# Draft v1\nInitial findings.\n").expect("write report v1");

    let creation = parse_and_validate_task_creation_input(
        &json!({
            "idempotencyKey": "promote-2",
            "title": "Deliver Final Report",
            "objective": "Write verified markdown report",
            "context": "Requires 3 independent review rounds",
            "reviewRequired": true,
            "reviewRounds": 3,
            "requirements": [
                {
                    "kind": "acceptance_criterion",
                    "text": "report.md exists and covers findings"
                }
            ],
            "workItems": [
                {
                    "key": "write-report",
                    "title": "Author report.md",
                    "description": "Create report.md with findings",
                    "expectedOutputs": ["report.md"]
                }
            ]
        }),
        false,
    )
    .expect("valid creation");

    let created = coordinator
        .create_planned(
            &ws,
            "task-main-2",
            Some("source-chat-2"),
            TaskCreationOrigin::ChatTool,
            "keep_project",
            creation,
            Some("Main"),
        )
        .await
        .expect("create task")
        .task;

    let wi_id = created.work_items[0].id.clone();
    let main_tid = created.threads[0].id.clone();
    let t1 = coordinator
        .claim_work_item(&created.id, &ws, &wi_id, &main_tid, created.revision)
        .await
        .expect("claim wi");
    let t2 = coordinator
        .mark_work_item(
            &created.id,
            &ws,
            &wi_id,
            t1.revision,
            WorkItemStatus::Done,
            Some("Wrote report.md"),
            Some(&main_tid),
        )
        .await
        .expect("mark wi done");

    // Register artifact v1
    let t3 = coordinator
        .register_artifact(RegisterArtifactRequest {
            task_id: created.id.clone(),
            workspace_path: ws.clone(),
            expected_revision: t2.revision,
            session_id: Some("task-main-2".to_owned()),
            path: "report.md".to_owned(),
            title: "Final Report".to_owned(),
            kind: "markdown".to_owned(),
            artifact_id: None,
            base_version_id: None,
            change_summary: Some("Initial report".to_owned()),
            work_item_id: Some(wi_id.clone()),
            provenance: None,
        })
        .await
        .expect("register artifact");
    let artifact_id = t3.artifacts[0].id.clone();
    let detail_v1 = coordinator
        .get_artifact_detail(&created.id, &ws, &artifact_id)
        .expect("get detail")
        .expect("detail exists");
    let v1 = &detail_v1.versions[0];

    // Verify content-addressed blob exists at <root>/objects/sha256/<2-char>/<sha256> with 0600/0700 perms
    let blob_path = env
        .artifact_store
        .get_blob_path(&v1.sha256)
        .expect("blob path");
    assert!(blob_path.is_file());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let file_mode = std::fs::metadata(&blob_path).unwrap().permissions().mode() & 0o777;
        let dir_mode = std::fs::metadata(blob_path.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(file_mode, 0o600);
        assert_eq!(dir_mode, 0o700);
    }

    // Capture v2, then externally edit live file and verify restore detects ArtifactConflict!
    std::fs::write(&report_path, "# Draft v2\nUpdated section.\n").expect("write v2");
    let (t4, _detail_v2, v2) = coordinator
        .capture_artifact_version(CaptureArtifactVersionRequest {
            task_id: created.id.clone(),
            workspace_path: ws.clone(),
            artifact_id: artifact_id.clone(),
            expected_revision: t3.revision,
            expected_sha256: None,
            change_summary: Some("Added section".to_owned()),
            created_by: Some("user".to_owned()),
            provenance: None,
        })
        .await
        .expect("capture v2");

    std::fs::write(&report_path, "# Externally drifted edit!\n").expect("external drift");
    let conflict_err = coordinator
        .restore_artifact_version(RestoreArtifactVersionRequest {
            task_id: created.id.clone(),
            workspace_path: ws.clone(),
            artifact_id: artifact_id.clone(),
            version_id: v1.id.clone(),
            expected_revision: t4.revision,
            expected_sha256: Some(v2.sha256.clone()),
            created_by: Some("user".to_owned()),
            change_summary: None,
        })
        .await
        .expect_err("restore over externally modified file must fail with ArtifactConflict");
    match conflict_err {
        TaskCoordinatorError::ArtifactConflict {
            artifact_id: Some(aid),
            expected_sha256,
            current_sha256: Some(cur),
        } => {
            assert_eq!(aid, artifact_id);
            assert_eq!(expected_sha256, v2.sha256);
            assert_ne!(cur, v2.sha256);
        }
        other => panic!("expected ArtifactConflict, got {other:?}"),
    }

    // Restore v2 cleanly by passing actual current hash, then test 3-round review enforcement
    let cur_fp = env
        .artifact_store
        .fingerprint_file_sync(&report_path)
        .unwrap()
        .unwrap();
    let (t5, _, _) = coordinator
        .restore_artifact_version(RestoreArtifactVersionRequest {
            task_id: created.id.clone(),
            workspace_path: ws.clone(),
            artifact_id: artifact_id.clone(),
            version_id: v2.id.clone(),
            expected_revision: t4.revision,
            expected_sha256: Some(cur_fp.sha256),
            created_by: Some("user".to_owned()),
            change_summary: Some("Reset to v2".to_owned()),
        })
        .await
        .expect("restore v2 with matching expected_sha256");

    // Proposing completion before 3 passing reviews must fail
    let premature = coordinator
        .propose_completion(&created.id, &ws, t5.revision, "Ready early", None)
        .await
        .expect_err("must require 3 passing reviews");
    assert!(
        premature
            .to_string()
            .contains("3 independent review round(s)")
    );

    // Round 1: PARTIAL -> blocks Round 2 until address_review is called!
    let mat1 = coordinator
        .get_review_material(&created.id, &ws, Some(t5.revision))
        .await
        .expect("material 1");
    let (t6, rev1_id, round1) = coordinator
        .record_review(
            &created.id,
            &ws,
            Some("task-main-2"),
            t5.revision,
            Some(&mat1.fingerprint),
            "reviewer-agent-1",
            "openai",
            "gpt-5.4",
            TaskReviewVerdict::Partial,
            "Add an executive summary.",
        )
        .await
        .expect("record round 1 partial");
    assert_eq!(round1, 1);

    let unaddressed_err = coordinator
        .record_review(
            &created.id,
            &ws,
            Some("task-main-2"),
            t6.revision,
            None,
            "reviewer-agent-2",
            "openai",
            "gpt-5.4",
            TaskReviewVerdict::Pass,
            "LGTM",
        )
        .await
        .expect_err("must address round 1 feedback first");
    assert!(unaddressed_err.to_string().contains("must be addressed"));

    let t7 = coordinator
        .address_review(
            &created.id,
            &ws,
            Some("task-main-2"),
            t6.revision,
            &rev1_id,
            "Added executive summary to report.md",
        )
        .await
        .expect("address round 1");

    // Record 3 passing reviews with distinct reviewer agent IDs
    let mut cur_task = t7;
    for idx in 2..=4 {
        let mat = coordinator
            .get_review_material(&created.id, &ws, Some(cur_task.revision))
            .await
            .expect("review material");
        let (next_t, _, r_num) = coordinator
            .record_review(
                &created.id,
                &ws,
                Some("task-main-2"),
                cur_task.revision,
                Some(&mat.fingerprint),
                &format!("reviewer-agent-{idx}"),
                "openai",
                "gpt-5.4",
                TaskReviewVerdict::Pass,
                "All criteria verified.",
            )
            .await
            .expect("record passing review");
        assert_eq!(r_num, idx);
        cur_task = next_t;
    }

    // Mutate live workspace file on disk AFTER the 3 passing reviews -> propose_completion MUST reject!
    std::fs::write(&report_path, "# Silent post-review tamper\n").expect("tamper report");
    let tamper_err = coordinator
        .propose_completion(
            &created.id,
            &ws,
            cur_task.revision,
            "Try completing with tampered file",
            None,
        )
        .await
        .expect_err("post-review live file mutation must invalidate review sign-off");
    assert!(tamper_err.to_string().contains("fresh passing review"));

    // Restore exact reviewed bytes ("# Draft v2\nUpdated section.\n") -> propose_completion + accept_task succeed and quiesce!
    std::fs::write(&report_path, "# Draft v2\nUpdated section.\n").expect("restore reviewed bytes");
    let awaiting = coordinator
        .propose_completion(&created.id, &ws, cur_task.revision, "Verified report", None)
        .await
        .expect("propose completion with matching fingerprint");
    assert_eq!(awaiting.status, TaskStatus::AwaitingReview);

    let completed = coordinator
        .accept_task(&created.id, &ws, awaiting.revision)
        .await
        .expect("accept task");
    assert_eq!(completed.status, TaskStatus::Completed);
    assert_eq!(quiescer.quiesced_calls.lock().len(), 1);
    assert_eq!(quiescer.quiesced_calls.lock()[0].1, TaskStatus::Completed);

    // Terminal task thread is now locked (`terminal_task_thread`), while source chat is unlocked!
    assert!(get_session_task_lock(Some(&env.session_db), "source-chat-2", None).is_none());
    let term_lock = get_session_task_lock(Some(&env.session_db), "task-main-2", None)
        .expect("terminal task thread must be locked");
    assert_eq!(term_lock.data.lock_kind, TaskLockKind::TerminalTaskThread);
}

fn build_minimal_docx(paragraphs: &[(&str, Option<&str>)]) -> Vec<u8> {
    let mut buf = Cursor::new(Vec::new());
    {
        let mut zip = ZipWriter::new(&mut buf);
        let opts = SimpleFileOptions::default();
        let mut body = String::new();
        for (txt, style) in paragraphs {
            body.push_str("<w:p>");
            if let Some(st) = style {
                body.push_str(&format!("<w:pPr><w:pStyle w:val=\"{st}\"/></w:pPr>"));
            }
            body.push_str(&format!("<w:r><w:t>{txt}</w:t></w:r></w:p>"));
        }
        let xml = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?><w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body>{body}</w:body></w:document>"
        );
        zip.start_file("word/document.xml", opts).unwrap();
        zip.write_all(xml.as_bytes()).unwrap();
        zip.finish().unwrap();
    }
    buf.into_inner()
}

#[test]
fn preview_and_comparison_services_handle_text_png_and_docx() {
    let before_txt = ArtifactBlobInput {
        bytes: b"line 1\nline 2\n",
        filename: "notes.md",
        mime_type: Some("text/markdown"),
    };
    let after_txt = ArtifactBlobInput {
        bytes: b"line 1\nline 2 updated\nline 3\n",
        filename: "notes.md",
        mime_type: Some("text/markdown"),
    };
    let txt_preview = ArtifactPreviewService::preview(&after_txt);
    assert_eq!(txt_preview["kind"], Value::String("text".to_owned()));
    assert_eq!(
        txt_preview["text"],
        Value::String("line 1\nline 2 updated\nline 3\n".to_owned())
    );

    let txt_diff = ArtifactComparisonService::compare(&before_txt, &after_txt, None);
    assert_eq!(txt_diff["kind"], Value::String("text".to_owned()));
    assert!(txt_diff["summary"]["totalChanges"].as_u64().unwrap() > 0);
    assert!(
        txt_diff["unifiedDiff"]
            .as_str()
            .unwrap()
            .contains("+line 2 updated")
    );

    let docx_v1 = build_minimal_docx(&[("Exec Summary", Some("Heading1")), ("Old body.", None)]);
    let docx_v2 = build_minimal_docx(&[("Exec Summary", Some("Heading1")), ("New body!", None)]);
    let b_docx = ArtifactBlobInput {
        bytes: &docx_v1,
        filename: "spec.docx",
        mime_type: None,
    };
    let a_docx = ArtifactBlobInput {
        bytes: &docx_v2,
        filename: "spec.docx",
        mime_type: None,
    };
    let docx_preview = ArtifactPreviewService::preview(&a_docx);
    assert_eq!(docx_preview["kind"], Value::String("docx".to_owned()));
    assert_eq!(
        docx_preview["document"]["headings"][0]["text"],
        json!("Exec Summary")
    );
    assert_eq!(
        docx_preview["document"]["paragraphs"][0]["text"],
        json!("New body!")
    );

    let docx_diff = ArtifactComparisonService::compare(&b_docx, &a_docx, None);
    assert_eq!(docx_diff["kind"], Value::String("docx".to_owned()));
    assert_eq!(docx_diff["summary"]["modified"], json!(1));
}
