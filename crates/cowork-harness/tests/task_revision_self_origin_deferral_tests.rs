//! Regression: a revision thread that registers its own artifact through `taskUpdate` on an
//! otherwise completion-eligible task (reviewRequired=false, reviewRounds=0) must not try to
//! quiesce its own still-running turn synchronously. Terminal acceptance is deferred until the
//! originating turn returns (TS `deferSelfOriginTerminalTransition`), so the tool call returns
//! promptly and the task still auto-completes afterwards.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use cowork_harness::tasks::{
    RegisterArtifactRequest, StartArtifactRevisionRequest, TaskCoordinator, TaskCoordinatorOptions,
    TaskThreadFactory, TaskThreadFactoryInput, TaskThreadQuiescer,
};
use cowork_storage::{
    ArtifactVersionStore, ArtifactVersionStoreOptions, SessionDb, SessionDbOptions,
    TaskCreationOrigin, TaskRecord, TaskStatus, WorkItemStatus,
    parse_and_validate_task_creation_input,
};
use parking_lot::Mutex;
use serde_json::json;
use tokio::sync::Notify;
use uuid::Uuid;

/// Upper bound the simulated quiescer waits for a busy origin turn (stands in for the server's
/// 5s interrupt / 30s timeout). A synchronous self-quiesce would block for this long and fail.
const ORIGIN_TURN_WAIT: Duration = Duration::from_secs(3);

struct ThreadFactory;

#[async_trait]
impl TaskThreadFactory for ThreadFactory {
    async fn create_task_thread(&self, _input: TaskThreadFactoryInput) -> Result<String, String> {
        Ok(format!("revision-sess-{}", Uuid::new_v4()))
    }
}

/// Mirrors `ServerTaskThreadQuiescer`: non-origin threads are interrupted (no wait here), the
/// origin thread is awaited until its turn stops, failing on timeout.
#[derive(Default)]
struct TurnAwareQuiescer {
    busy: Mutex<HashSet<String>>,
    settled: Notify,
    calls: Mutex<Vec<(TaskStatus, Option<String>)>>,
}

impl TurnAwareQuiescer {
    fn start_turn(&self, session_id: &str) {
        self.busy.lock().insert(session_id.to_owned());
    }

    fn finish_turn(&self, session_id: &str) {
        self.busy.lock().remove(session_id);
        self.settled.notify_waiters();
    }
}

#[async_trait]
impl TaskThreadQuiescer for TurnAwareQuiescer {
    async fn quiesce_task_threads(
        &self,
        task: TaskRecord,
        reason: TaskStatus,
        origin_session_id: Option<String>,
    ) -> Result<(), String> {
        self.calls.lock().push((reason, origin_session_id.clone()));
        let deadline = Instant::now() + ORIGIN_TURN_WAIT;
        for thread in &task.threads {
            if origin_session_id.as_deref() != Some(thread.session_id.as_str()) {
                continue;
            }
            loop {
                let notified = self.settled.notified();
                if !self.busy.lock().contains(&thread.session_id) {
                    break;
                }
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    return Err(format!(
                        "Timed out waiting for task session {} to quiesce",
                        thread.session_id
                    ));
                }
                let _ =
                    tokio::time::timeout(remaining.min(Duration::from_millis(50)), notified).await;
            }
        }
        Ok(())
    }
}

#[tokio::test]
async fn revision_thread_register_artifact_defers_auto_completion_until_turn_returns() {
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
    let quiescer = Arc::new(TurnAwareQuiescer::default());
    let coordinator = TaskCoordinator::new(TaskCoordinatorOptions {
        session_db: session_db.clone(),
        notify: None,
        artifact_store: Some(artifact_store),
        quiesce_task_threads: Some(quiescer.clone()),
    })
    .unwrap();
    coordinator.set_thread_factory(Arc::new(ThreadFactory));

    let ws = ws_dir.to_string_lossy().into_owned();
    let report = ws_dir.join("report.md");
    std::fs::write(&report, "# v1\n").unwrap();

    let creation = parse_and_validate_task_creation_input(
        &json!({
            "idempotencyKey": "rev-self-origin-defer",
            "title": "Report",
            "objective": "Write report.md",
            "context": "Regression fixture",
            "reviewRequired": false,
            "reviewRounds": 0,
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
    assert!(!created.review_required);
    assert_eq!(created.review_rounds, 0);

    let wi_id = created.work_items[0].id.clone();
    let main_tid = created.threads[0].id.clone();
    let claimed = coordinator
        .claim_work_item(&created.id, &ws, &wi_id, &main_tid, created.revision)
        .await
        .unwrap();
    let done = coordinator
        .mark_work_item(
            &created.id,
            &ws,
            &wi_id,
            claimed.revision,
            WorkItemStatus::Done,
            Some("Wrote report.md"),
            Some(&main_tid),
        )
        .await
        .unwrap();
    let registered = coordinator
        .register_artifact(RegisterArtifactRequest {
            task_id: created.id.clone(),
            workspace_path: ws.clone(),
            expected_revision: done.revision,
            session_id: Some("task-main".to_owned()),
            path: "report.md".to_owned(),
            title: "Report".to_owned(),
            kind: "markdown".to_owned(),
            artifact_id: None,
            base_version_id: None,
            change_summary: None,
            work_item_id: Some(wi_id),
            provenance: None,
        })
        .await
        .unwrap();
    let artifact_id = registered.artifacts[0].id.clone();

    let (revising, _, revision) = coordinator
        .start_artifact_revision(StartArtifactRevisionRequest {
            task_id: created.id.clone(),
            workspace_path: ws.clone(),
            artifact_id: artifact_id.clone(),
            expected_revision: registered.revision,
            instruction: "Tighten the wording".to_owned(),
            base_version_id: None,
            title: None,
            provider: None,
            model: None,
        })
        .await
        .unwrap();
    assert!(!matches!(
        revising.status,
        TaskStatus::Completed | TaskStatus::AwaitingReview
    ));

    // The revision thread's turn is running and calls `taskUpdate` (register_artifact) to hand
    // in its edited output. The call must not wait on its own turn.
    std::fs::write(&report, "# v2\n").unwrap();
    quiescer.start_turn(&revision.session_id);
    let started = Instant::now();
    let in_turn = tokio::time::timeout(
        Duration::from_secs(1),
        coordinator.register_artifact(RegisterArtifactRequest {
            task_id: created.id.clone(),
            workspace_path: ws.clone(),
            expected_revision: revising.revision,
            session_id: Some(revision.session_id.clone()),
            path: "report.md".to_owned(),
            title: "Report".to_owned(),
            kind: "markdown".to_owned(),
            artifact_id: Some(artifact_id.clone()),
            base_version_id: None,
            change_summary: None,
            work_item_id: None,
            provenance: None,
        }),
    )
    .await
    .expect("register_artifact from the revision thread must not wait on its own turn")
    .expect("register_artifact succeeds");
    assert!(started.elapsed() < Duration::from_secs(1));
    assert_eq!(
        in_turn.status,
        TaskStatus::AwaitingReview,
        "acceptance is deferred until the originating turn settles"
    );
    assert!(
        session_db
            .get_active_task_artifact_revision_for_session(&revision.session_id)
            .unwrap()
            .is_none(),
        "the revision itself is finalized inside the tool call"
    );

    // The turn returns; the deferred acceptance then quiesces and completes the task.
    tokio::time::sleep(Duration::from_millis(100)).await;
    quiescer.finish_turn(&revision.session_id);
    let deadline = Instant::now() + Duration::from_secs(2);
    let finished = loop {
        let task = session_db.get_task(&created.id).unwrap().unwrap();
        if task.status == TaskStatus::Completed || Instant::now() >= deadline {
            break task;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    assert_eq!(
        finished.status,
        TaskStatus::Completed,
        "task must auto-complete once the revision turn returns: {:?}",
        finished.status
    );
    assert!(
        started.elapsed() < ORIGIN_TURN_WAIT,
        "completion must not wait for the quiesce timeout"
    );
    // The deferred run first waits for the originating revision turn, then (as TS `acceptTask`
    // without a session) quiesces again for the terminal write itself.
    let calls = quiescer.calls.lock().clone();
    assert_eq!(
        calls.first(),
        Some(&(TaskStatus::Completed, Some(revision.session_id.clone()))),
        "deferred acceptance first waits on the revision thread as origin: {calls:?}"
    );
    assert!(
        calls
            .iter()
            .all(|(reason, _)| *reason == TaskStatus::Completed),
        "{calls:?}"
    );
    assert_eq!(std::fs::read_to_string(&report).unwrap(), "# v2\n");
}
