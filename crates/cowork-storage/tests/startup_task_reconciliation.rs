//! Startup reconciliation must only fail a working/planning task when its *primary*
//! thread (first thread by `created_at, thread_id`) errored. A previously failed
//! secondary thread must leave the task, its work-item claims, and in-progress items intact.

use std::fs;
use std::path::PathBuf;

use cowork_config::{ProviderName, canonicalize_sync};
use cowork_storage::{
    AgentExecutionState, CreateTaskInput, PersistedSessionMutation, PersistedSessionSnapshotData,
    SessionDb, SessionDbOptions, SessionKind, SessionPersistenceStatus, SessionTitleSource,
    TaskActivityKind, TaskRecord, TaskStatus, TaskThread, TaskThreadInput, WorkItemInput,
    WorkItemStatus,
};
use serde_json::json;
use uuid::Uuid;

const PRIMARY_THREAD_ID: &str = "tt-primary";
const SECONDARY_THREAD_ID: &str = "tt-secondary";
const WORK_ITEM_ID: &str = "wi-1";

struct IsolatedStorageEnv {
    root: PathBuf,
    cowork_root: PathBuf,
    sessions_dir: PathBuf,
}

impl IsolatedStorageEnv {
    fn new(prefix: &str) -> Self {
        let root_base = if cfg!(target_os = "macos") {
            PathBuf::from("/private/tmp")
        } else {
            std::env::temp_dir()
        };
        let root = root_base.join(format!("cowork-stor-test-{prefix}-{}", Uuid::new_v4()));
        let cowork_root = root.join("home").join(".cowork");
        let sessions_dir = cowork_root.join("sessions");
        fs::create_dir_all(&sessions_dir).expect("create isolated sessions dir");
        Self {
            root: canonicalize_sync(&root),
            cowork_root: canonicalize_sync(&cowork_root),
            sessions_dir: canonicalize_sync(&sessions_dir),
        }
    }

    fn workspace(&self) -> String {
        let ws = self.root.join("ws");
        fs::create_dir_all(&ws).expect("create workspace dir");
        canonicalize_sync(&ws).to_string_lossy().into_owned()
    }

    async fn open_db(&self) -> SessionDb {
        SessionDb::open(SessionDbOptions {
            root_dir: self.cowork_root.clone(),
            sessions_dir: self.sessions_dir.clone(),
            db_path: None,
            busy_timeout_ms: Some(5_000),
        })
        .await
        .expect("open session db")
    }
}

impl Drop for IsolatedStorageEnv {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn session_mutation(
    session_id: &str,
    workspace: &str,
    execution_state: AgentExecutionState,
) -> PersistedSessionMutation {
    let now = "2026-04-17T12:00:00.000Z".to_string();
    PersistedSessionMutation {
        session_id: session_id.to_string(),
        event_type: "session.created".to_string(),
        event_ts: Some(now.clone()),
        direction: Some("system".to_string()),
        payload: Some(json!({})),
        snapshot: PersistedSessionSnapshotData {
            session_kind: SessionKind::Root,
            parent_session_id: None,
            role: None,
            mode: None,
            depth: None,
            nickname: None,
            task_type: None,
            target_paths: None,
            profile: None,
            requested_model: None,
            effective_model: Some("gemini-3-flash-preview".to_string()),
            requested_reasoning_effort: None,
            effective_reasoning_effort: None,
            execution_state: Some(execution_state),
            last_message_preview: None,
            title: format!("Session {session_id}"),
            title_source: SessionTitleSource::Default,
            title_model: None,
            provider: ProviderName::Google,
            model: "gemini-3-flash-preview".to_string(),
            working_directory: workspace.to_string(),
            output_directory: None,
            uploads_directory: None,
            provider_options: None,
            sandbox: None,
            enable_mcp: false,
            backups_enabled_override: None,
            created_at: now.clone(),
            updated_at: now,
            status: SessionPersistenceStatus::Active,
            has_pending_ask: false,
            has_pending_approval: false,
            system_prompt: "You are a helpful coworker.".to_string(),
            messages: vec![json!({ "role": "user", "content": "Hello!" })],
            last_memory_generated_index: Some(0),
            provider_state: None,
            todos: vec![],
            harness_context: None,
            cost_tracker: None,
        },
    }
}

/// Seeds a `working` task whose primary thread runs on `primary_session` and whose
/// later-created secondary thread runs on `secondary_session`. The primary thread holds a
/// claim on an in-progress work item.
async fn seed_task_with_two_threads(
    db: &SessionDb,
    workspace: &str,
    task_id: &str,
    primary_session: (&str, AgentExecutionState),
    secondary_session: (&str, AgentExecutionState),
) -> TaskRecord {
    for (session_id, state) in [primary_session, secondary_session] {
        db.persist_session_mutation(session_mutation(session_id, workspace, state))
            .await
            .unwrap();
    }

    db.create_task(CreateTaskInput {
        id: task_id.to_string(),
        workspace_path: workspace.to_string(),
        title: "Two-thread task".to_string(),
        objective: "Verify primary-only startup reconciliation".to_string(),
        context: String::new(),
        source_session_id: None,
        creation_origin: "manual".to_string(),
        creation_idempotency_key: Some(format!("idem-{task_id}")),
        initial_status: "working".to_string(),
        review_required: false,
        review_rounds: 0,
        thread: TaskThreadInput {
            id: PRIMARY_THREAD_ID.to_string(),
            session_id: primary_session.0.to_string(),
            title: "Primary".to_string(),
            created_by: "system".to_string(),
            created_at: "2026-04-17T12:00:00.000Z".to_string(),
            updated_at: "2026-04-17T12:00:00.000Z".to_string(),
        },
        work_items: vec![WorkItemInput {
            id: WORK_ITEM_ID.to_string(),
            title: "Run".to_string(),
            description: String::new(),
            status: "queued".to_string(),
            position: 0,
            expected_outputs: vec!["done".to_string()],
            created_at: "2026-04-17T12:00:00.000Z".to_string(),
            updated_at: "2026-04-17T12:00:00.000Z".to_string(),
        }],
    })
    .await
    .unwrap();
    let created = db.get_task(task_id).unwrap().unwrap();

    let with_secondary = db
        .add_task_thread(
            TaskThread {
                id: SECONDARY_THREAD_ID.to_string(),
                task_id: task_id.to_string(),
                session_id: secondary_session.0.to_string(),
                title: "Secondary".to_string(),
                created_by: "agent".to_string(),
                created_at: "2026-04-17T12:00:05.000Z".to_string(),
                updated_at: "2026-04-17T12:00:05.000Z".to_string(),
            },
            created.revision,
        )
        .await
        .unwrap();

    let claimed = db
        .claim_task_work_item(
            task_id.to_string(),
            WORK_ITEM_ID.to_string(),
            PRIMARY_THREAD_ID.to_string(),
            with_secondary.revision,
            "2026-04-17T12:00:10.000Z".to_string(),
        )
        .await
        .unwrap();

    assert_eq!(claimed.status, TaskStatus::Working);
    assert_eq!(
        claimed
            .threads
            .iter()
            .map(|t| t.id.as_str())
            .collect::<Vec<_>>(),
        vec![PRIMARY_THREAD_ID, SECONDARY_THREAD_ID],
        "primary thread must sort first"
    );
    let item = &claimed.work_items[0];
    assert_eq!(item.status, WorkItemStatus::InProgress);
    assert_eq!(
        item.claimed_by_thread_id.as_deref(),
        Some(PRIMARY_THREAD_ID)
    );
    claimed
}

#[tokio::test]
async fn startup_reconciliation_keeps_task_with_healthy_primary_and_errored_secondary() {
    let iso = IsolatedStorageEnv::new("startup-secondary-errored");
    let ws = iso.workspace();
    let db = iso.open_db().await;

    let before = seed_task_with_two_threads(
        &db,
        &ws,
        "task-secondary-errored",
        ("primary-healthy", AgentExecutionState::Completed),
        ("secondary-failed", AgentExecutionState::Errored),
    )
    .await;

    let report = db
        .reconcile_stale_execution_states(Some(&ws))
        .await
        .unwrap();
    assert_eq!(report.sessions_reconciled, 0);
    assert_eq!(report.tasks_reconciled, 0);

    let after = db.get_task("task-secondary-errored").unwrap().unwrap();
    assert_eq!(after.status, TaskStatus::Working);
    assert_eq!(after.revision, before.revision);
    let item = &after.work_items[0];
    assert_eq!(item.status, WorkItemStatus::InProgress);
    assert_eq!(
        item.claimed_by_thread_id.as_deref(),
        Some(PRIMARY_THREAD_ID)
    );
    db.close();
}

#[tokio::test]
async fn startup_reconciliation_keeps_task_when_running_secondary_crashed() {
    // The secondary was mid-run at shutdown and is reconciled to `errored` during this
    // same startup pass; the healthy primary must still keep the task alive.
    let iso = IsolatedStorageEnv::new("startup-secondary-running");
    let ws = iso.workspace();
    let db = iso.open_db().await;

    seed_task_with_two_threads(
        &db,
        &ws,
        "task-secondary-running",
        ("primary-idle", AgentExecutionState::Completed),
        ("secondary-running", AgentExecutionState::Running),
    )
    .await;

    let report = db
        .reconcile_stale_execution_states(Some(&ws))
        .await
        .unwrap();
    assert_eq!(report.sessions_reconciled, 1);
    assert_eq!(report.tasks_reconciled, 0);
    assert_eq!(
        db.get_session_record("secondary-running")
            .unwrap()
            .unwrap()
            .execution_state,
        Some(AgentExecutionState::Errored)
    );

    let after = db.get_task("task-secondary-running").unwrap().unwrap();
    assert_eq!(after.status, TaskStatus::Working);
    let item = &after.work_items[0];
    assert_eq!(item.status, WorkItemStatus::InProgress);
    assert_eq!(
        item.claimed_by_thread_id.as_deref(),
        Some(PRIMARY_THREAD_ID)
    );
    db.close();
}

#[tokio::test]
async fn startup_reconciliation_fails_task_when_primary_errored() {
    let iso = IsolatedStorageEnv::new("startup-primary-errored");
    let ws = iso.workspace();
    let db = iso.open_db().await;

    seed_task_with_two_threads(
        &db,
        &ws,
        "task-primary-errored",
        ("primary-running", AgentExecutionState::Running),
        ("secondary-healthy", AgentExecutionState::Completed),
    )
    .await;

    let report = db
        .reconcile_stale_execution_states(Some(&ws))
        .await
        .unwrap();
    assert_eq!(report.sessions_reconciled, 1);
    assert_eq!(report.tasks_reconciled, 1);

    let after = db.get_task("task-primary-errored").unwrap().unwrap();
    assert_eq!(after.status, TaskStatus::Failed);
    let item = &after.work_items[0];
    assert_eq!(item.status, WorkItemStatus::Blocked);
    assert_eq!(item.claimed_by_thread_id, None);

    // Idempotent: a second pass finds nothing left to fail.
    let second = db
        .reconcile_stale_execution_states(Some(&ws))
        .await
        .unwrap();
    assert_eq!(second.tasks_reconciled, 0);
    db.close();
}

#[tokio::test]
async fn startup_reconciliation_fails_task_when_primary_previously_errored() {
    let iso = IsolatedStorageEnv::new("startup-primary-prev-errored");
    let ws = iso.workspace();
    let db = iso.open_db().await;

    seed_task_with_two_threads(
        &db,
        &ws,
        "task-primary-prev-errored",
        ("primary-failed", AgentExecutionState::Errored),
        ("secondary-ok", AgentExecutionState::Completed),
    )
    .await;

    let report = db
        .reconcile_stale_execution_states(Some(&ws))
        .await
        .unwrap();
    assert_eq!(report.sessions_reconciled, 0);
    assert_eq!(report.tasks_reconciled, 1);

    let after = db.get_task("task-primary-prev-errored").unwrap().unwrap();
    assert_eq!(after.status, TaskStatus::Failed);
    let item = &after.work_items[0];
    assert_eq!(item.status, WorkItemStatus::Blocked);
    assert_eq!(item.claimed_by_thread_id, None);
    db.close();
}

/// Failing a task at startup must apply the same terminal side effects as a runtime
/// `set_status(failed)`: an active artifact revision is cancelled (so a later retry can start a
/// new one and complete) and a `status_changed` activity records the transition.
#[tokio::test]
async fn startup_reconciliation_abandons_active_revisions_and_logs_status_change() {
    let iso = IsolatedStorageEnv::new("startup-primary-active-revision");
    let ws = iso.workspace();
    let db = iso.open_db().await;
    let task_id = "task-primary-revision";

    seed_task_with_two_threads(
        &db,
        &ws,
        task_id,
        ("primary-revising", AgentExecutionState::Running),
        ("secondary-idle", AgentExecutionState::Completed),
    )
    .await;
    {
        let conn = rusqlite::Connection::open(db.db_path()).unwrap();
        conn.execute(
            "INSERT INTO task_artifacts (
               artifact_id, task_id, work_item_id, thread_id, path, kind, title, created_by,
               provenance_json, created_at
             ) VALUES ('artifact-1', ?1, ?2, ?3, 'report.md', 'document', 'Report', 'agent',
                       '{}', '2026-04-17T12:00:15.000Z')",
            rusqlite::params![task_id, WORK_ITEM_ID, PRIMARY_THREAD_ID],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO task_artifact_versions (
               version_id, task_id, artifact_id, version_number, parent_version_id, sha256,
               size_bytes, media_type, created_by, created_at, change_summary, provenance_json,
               review_status
             ) VALUES ('v-base', ?1, 'artifact-1', 1, NULL, 'abc', 3, 'text/markdown', 'agent',
                       '2026-04-17T12:00:15.000Z', 'Initial', '{}', 'accepted')",
            rusqlite::params![task_id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO task_artifact_revisions (
               revision_id, task_id, artifact_id, work_item_id, task_thread_id, session_id,
               base_version_id, prior_version_id, result_version_id, prior_task_status,
               settlement_status, status, instruction, created_at, updated_at, completed_at
             ) VALUES ('rev-1', ?1, 'artifact-1', ?2, ?3, 'primary-revising', 'v-base', 'v-base',
                       NULL, 'working', 'none', 'active', 'Revise it',
                       '2026-04-17T12:00:20.000Z', '2026-04-17T12:00:20.000Z', NULL)",
            rusqlite::params![task_id, WORK_ITEM_ID, PRIMARY_THREAD_ID],
        )
        .unwrap();
    }

    let report = db
        .reconcile_stale_execution_states(Some(&ws))
        .await
        .unwrap();
    assert_eq!(report.tasks_reconciled, 1);

    let conn = rusqlite::Connection::open(db.db_path()).unwrap();
    let (status, completed_at): (String, Option<String>) = conn
        .query_row(
            "SELECT status, completed_at FROM task_artifact_revisions WHERE revision_id = 'rev-1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(status, "cancelled");
    assert!(completed_at.is_some());

    let after = db.get_task(task_id).unwrap().unwrap();
    assert_eq!(after.status, TaskStatus::Failed);
    // The revision's work item is abandoned exactly as a runtime terminal transition does.
    assert_eq!(after.work_items[0].status, WorkItemStatus::Abandoned);
    assert_eq!(after.work_items[0].claimed_by_thread_id, None);
    let status_change = after
        .activity
        .iter()
        .find(|a| a.kind == TaskActivityKind::StatusChanged)
        .expect("startup failure logs a status_changed activity");
    assert_eq!(status_change.summary, "Task run failed");
    assert_eq!(status_change.thread_id.as_deref(), Some(PRIMARY_THREAD_ID));
    db.close();
}
