use std::collections::BTreeSet;
use std::fs;
#[cfg(unix)]
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

use cowork_config::{ProviderName, canonicalize_sync, get_ai_coworker_paths};
use cowork_storage::{
    AgentExecutionState, CreateTaskInput, FileLockOptions, MemoryScope, MemoryStore,
    MemoryWriteMode, PersistedSessionMutation, PersistedSessionSnapshotData, SessionDb,
    SessionDbOptions, SessionDbWriteCoordinator, SessionDbWriteCoordinatorOptions, SessionKind,
    SessionPersistenceStatus, SessionTitleSource, TaskThreadInput, ThreadJournal,
    ThreadJournalEventInput, WorkItemInput, file_lock_root_for_cowork_home, lock_database_path_for,
    with_file_lock, with_file_lock_sync,
};
use rusqlite::Connection;
use serde_json::json;
use sha2::{Digest, Sha256};
use uuid::Uuid;

struct IsolatedStorageEnv {
    root: PathBuf,
    home: PathBuf,
    cowork_root: PathBuf,
    sessions_dir: PathBuf,
}

impl IsolatedStorageEnv {
    fn new(prefix: &str) -> Self {
        let base = PathBuf::from("/private/tmp");
        let root_base = if base.exists() {
            base
        } else {
            std::env::temp_dir()
        };
        let root = root_base.join(format!("cowork-stor-test-{prefix}-{}", Uuid::new_v4()));
        let home = root.join("home");
        let cowork_root = home.join(".cowork");
        let sessions_dir = cowork_root.join("sessions");
        fs::create_dir_all(&sessions_dir).expect("create isolated sessions dir");
        let root = canonicalize_sync(&root);
        let home = canonicalize_sync(&home);
        let cowork_root = canonicalize_sync(&cowork_root);
        let sessions_dir = canonicalize_sync(&sessions_dir);
        Self {
            root,
            home,
            cowork_root,
            sessions_dir,
        }
    }
}

impl Drop for IsolatedStorageEnv {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn sample_mutation(
    session_id: &str,
    workspace: &str,
    execution_state: Option<AgentExecutionState>,
    has_pending_ask: bool,
    has_pending_approval: bool,
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
            execution_state,
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
            has_pending_ask,
            has_pending_approval,
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

#[tokio::test]
async fn sessions_db_wal_permissions_split_handles_and_corrupt_quarantine() {
    let iso = IsolatedStorageEnv::new("wal-quarantine");

    // Rejects anonymous :memory: path.
    let mem_err = SessionDb::open(SessionDbOptions {
        root_dir: iso.cowork_root.clone(),
        sessions_dir: iso.sessions_dir.clone(),
        db_path: Some(PathBuf::from(":memory:")),
        busy_timeout_ms: Some(5_000),
    })
    .await;
    assert!(mem_err.is_err());

    // Write corrupt bytes to sessions.db before opening; verify quarantine + clean bootstrap.
    let db_path = iso.cowork_root.join("sessions.db");
    fs::write(&db_path, b"corrupt-sqlite-header-not-a-database-at-all").unwrap();

    let db = SessionDb::open(SessionDbOptions {
        root_dir: iso.cowork_root.clone(),
        sessions_dir: iso.sessions_dir.clone(),
        db_path: None,
        busy_timeout_ms: Some(5_000),
    })
    .await
    .expect("quarantine corrupt db and bootstrap fresh");

    // Verify backup file exists with .corrupt.<ts>.bak naming.
    let entries: Vec<String> = fs::read_dir(&iso.cowork_root)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    assert!(
        entries
            .iter()
            .any(|name| name.starts_with("sessions.db.corrupt.") && name.ends_with(".bak")),
        "expected quarantined backup in {entries:?}"
    );

    assert_eq!(db.journal_mode().unwrap().to_lowercase(), "wal");
    #[cfg(unix)]
    {
        let mode = fs::metadata(&db_path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    // Verify split RW + RO handles work concurrently.
    let ws = iso.root.join("project");
    fs::create_dir_all(&ws).unwrap();
    db.persist_session_mutation(sample_mutation(
        "s-1",
        &ws.to_string_lossy(),
        Some(AgentExecutionState::Completed),
        false,
        false,
    ))
    .await
    .unwrap();
    assert_eq!(db.list_sessions(None).unwrap().len(), 1);
    assert_eq!(
        db.get_session_record("s-1").unwrap().unwrap().title,
        "Session s-1"
    );
    db.close();
}

#[tokio::test]
async fn migrations_1_to_28_fresh_and_incremental_with_retired_13_to_15_reconciliation() {
    // 1. Fresh DB applies all active migrations through 28 and creates all 26 core+task tables.
    let fresh_iso = IsolatedStorageEnv::new("fresh-migrations");
    let fresh_db = SessionDb::open(SessionDbOptions {
        root_dir: fresh_iso.cowork_root.clone(),
        sessions_dir: fresh_iso.sessions_dir.clone(),
        db_path: None,
        busy_timeout_ms: Some(5_000),
    })
    .await
    .unwrap();
    let fresh_versions = fresh_db.applied_migration_versions().unwrap();
    let expected_fresh: BTreeSet<u32> = (1..=12).chain(16..=28).collect();
    assert_eq!(fresh_versions, expected_fresh);
    assert_eq!(fresh_versions.iter().copied().max(), Some(28));
    {
        let raw = Connection::open(fresh_iso.cowork_root.join("sessions.db")).unwrap();
        let mut stmt = raw
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .unwrap();
        let tables: BTreeSet<String> = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        for required_table in [
            "schema_migrations",
            "sessions",
            "session_state",
            "session_events",
            "session_model_stream_chunks",
            "session_snapshots",
            "thread_journal_events",
            "thread_journal_failures",
            "thread_creation_keys",
            "external_conversation_imports",
            "thread_metadata",
            "tasks",
            "task_threads",
            "task_requirements",
            "task_work_items",
            "task_work_item_dependencies",
            "task_work_item_claims",
            "task_decisions",
            "task_artifacts",
            "task_artifact_versions",
            "task_artifact_revisions",
            "task_blockers",
            "task_questions",
            "task_reviews",
            "task_activity",
            "task_checkpoints",
            "task_directive_receipts",
        ] {
            assert!(
                tables.contains(required_table),
                "missing table {required_table} in {tables:?}"
            );
        }
        assert!(
            !tables.contains("research"),
            "retired research table must not be created on fresh DB"
        );
    }
    fresh_db.close();

    // 2. Incremental upgrade from v1 + retired 13..15 reconciliation.
    let iso = IsolatedStorageEnv::new("migrations");
    let db_path = iso.cowork_root.join("sessions.db");

    // Pre-seed a v1 partial database + incomplete retired migration 14 marker.
    {
        let raw = Connection::open(&db_path).unwrap();
        raw.execute_batch(
            "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
             INSERT INTO schema_migrations (version, applied_at) VALUES (1, '2025-01-01T00:00:00.000Z');
             INSERT INTO schema_migrations (version, applied_at) VALUES (13, '2025-01-01T00:00:00.000Z');
             INSERT INTO schema_migrations (version, applied_at) VALUES (14, '2025-01-01T00:00:00.000Z');
             CREATE TABLE research (id TEXT PRIMARY KEY);
             CREATE TABLE sessions (
               session_id TEXT PRIMARY KEY,
               title TEXT NOT NULL,
               title_source TEXT NOT NULL,
               title_model TEXT NULL,
               provider TEXT NOT NULL,
               model TEXT NOT NULL,
               working_directory TEXT NOT NULL,
               output_directory TEXT NULL,
               uploads_directory TEXT NULL,
               enable_mcp INTEGER NOT NULL,
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL,
               status TEXT NOT NULL,
               has_pending_ask INTEGER NOT NULL,
               has_pending_approval INTEGER NOT NULL,
               message_count INTEGER NOT NULL,
               last_event_seq INTEGER NOT NULL
             );
             CREATE TABLE session_state (
               session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
               system_prompt TEXT NOT NULL,
               messages_json TEXT NOT NULL,
               todos_json TEXT NOT NULL,
               harness_context_json TEXT NULL
             );
             CREATE TABLE session_events (
               session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
               seq INTEGER NOT NULL,
               ts TEXT NOT NULL,
               direction TEXT NOT NULL,
               event_type TEXT NOT NULL,
               payload_json TEXT NOT NULL,
               PRIMARY KEY(session_id, seq)
             );
             INSERT INTO sessions VALUES (
               'legacy-v1-row', 'Old Chat', 'default', NULL, 'google', 'gemini-3-flash-preview',
               '/private/tmp/ws', NULL, NULL, 1, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z',
               'active', 0, 0, 1, 1
             );
             INSERT INTO session_state VALUES ('legacy-v1-row', 'sys', '[]', '[]', NULL);",
        )
        .unwrap();
    }

    let db = SessionDb::open(SessionDbOptions {
        root_dir: iso.cowork_root.clone(),
        sessions_dir: iso.sessions_dir.clone(),
        db_path: None,
        busy_timeout_ms: Some(5_000),
    })
    .await
    .unwrap();

    let versions = db.applied_migration_versions().unwrap();
    // 1..=12, 13 (research table exists), 14 removed (plan_pending missing), 16..=28!
    let expected: BTreeSet<u32> = (1..=12).chain(std::iter::once(13)).chain(16..=28).collect();
    assert_eq!(versions, expected);

    // Pre-existing v1 row upgraded cleanly with defaults populated!
    let upgraded = db
        .get_session_record("legacy-v1-row")
        .unwrap()
        .expect("v1 row preserved");
    assert_eq!(upgraded.session_kind, SessionKind::Root);
    assert_eq!(
        upgraded.execution_state,
        Some(AgentExecutionState::Completed)
    );
    assert_eq!(
        upgraded.effective_model.as_deref(),
        Some("gemini-3-flash-preview")
    );
    db.close();
}

#[tokio::test]
async fn legacy_session_json_files_import_idempotently() {
    let iso = IsolatedStorageEnv::new("legacy-import");
    let valid_v7 = json!({
        "version": 7,
        "sessionId": "legacy-json-1",
        "createdAt": "2026-01-10T10:00:00.000Z",
        "updatedAt": "2026-01-10T10:05:00.000Z",
        "session": {
            "title": "Imported V7 Session",
            "titleSource": "manual",
            "titleModel": null,
            "provider": "openai",
            "model": "gpt-5.4",
            "sessionKind": "root",
            "parentSessionId": null,
            "role": null,
            "mode": null,
            "depth": null,
            "nickname": null,
            "taskType": null,
            "targetPaths": null,
            "profile": null,
            "requestedModel": null,
            "effectiveModel": "gpt-5.4",
            "requestedReasoningEffort": null,
            "effectiveReasoningEffort": null,
            "executionState": "completed",
            "lastMessagePreview": "Hello from legacy"
        },
        "config": {
            "workingDirectory": iso.root.to_string_lossy(),
            "enableMcp": true,
            "backupsEnabledOverride": null
        },
        "context": {
            "system": "System prompt",
            "messages": [
                { "role": "user", "content": "Hello from legacy" },
                { "role": "assistant", "content": "Welcome back!" }
            ],
            "todos": [],
            "harnessContext": null,
            "providerState": null,
            "costTracker": null,
            "lastMemoryGeneratedIndex": 2
        }
    });
    fs::write(
        iso.sessions_dir.join("legacy-json-1.json"),
        serde_json::to_string_pretty(&valid_v7).unwrap(),
    )
    .unwrap();
    fs::write(iso.sessions_dir.join("corrupt.json"), "{ invalid json").unwrap();

    let db = SessionDb::open(SessionDbOptions {
        root_dir: iso.cowork_root.clone(),
        sessions_dir: iso.sessions_dir.clone(),
        db_path: None,
        busy_timeout_ms: Some(5_000),
    })
    .await
    .unwrap();

    let rec = db
        .get_session_record("legacy-json-1")
        .unwrap()
        .expect("legacy session imported");
    assert_eq!(rec.title, "Imported V7 Session");
    assert_eq!(rec.message_count, 2);
    assert_eq!(rec.last_event_seq, 1);
    assert!(db.get_session_snapshot("legacy-json-1").unwrap().is_some());
    db.close();

    // Re-opening must NOT re-import or bump last_event_seq.
    let db2 = SessionDb::open(SessionDbOptions {
        root_dir: iso.cowork_root.clone(),
        sessions_dir: iso.sessions_dir.clone(),
        db_path: None,
        busy_timeout_ms: Some(5_000),
    })
    .await
    .unwrap();
    let rec2 = db2.get_session_record("legacy-json-1").unwrap().unwrap();
    assert_eq!(rec2.last_event_seq, 1);
    assert_eq!(db2.list_sessions(None).unwrap().len(), 1);
    db2.close();
}

#[tokio::test]
async fn startup_reconciliation_transitions_stale_sessions_turns_and_tasks_per_workspace() {
    let iso = IsolatedStorageEnv::new("reconcile");
    let ws_a = iso.root.join("ws-a");
    let ws_b = iso.root.join("ws-b");
    fs::create_dir_all(&ws_a).unwrap();
    fs::create_dir_all(&ws_b).unwrap();
    let ws_a_str = ws_a.to_string_lossy().into_owned();
    let ws_b_str = ws_b.to_string_lossy().into_owned();

    let db = SessionDb::open(SessionDbOptions {
        root_dir: iso.cowork_root.clone(),
        sessions_dir: iso.sessions_dir.clone(),
        db_path: None,
        busy_timeout_ms: Some(5_000),
    })
    .await
    .unwrap();

    for (id, ws, state, ask, approval) in [
        (
            "a-running",
            &ws_a_str,
            Some(AgentExecutionState::Running),
            true,
            true,
        ),
        (
            "b-running",
            &ws_b_str,
            Some(AgentExecutionState::Running),
            true,
            true,
        ),
        (
            "b-pending",
            &ws_b_str,
            Some(AgentExecutionState::PendingInit),
            false,
            true,
        ),
        (
            "b-completed",
            &ws_b_str,
            Some(AgentExecutionState::Completed),
            true,
            false,
        ),
    ] {
        db.persist_session_mutation(sample_mutation(id, ws, state, ask, approval))
            .await
            .unwrap();
        let snap = db.project_legacy_snapshot(id).unwrap().unwrap();
        db.persist_session_snapshot(id, &snap).await.unwrap();
    }

    // Add an open turn in thread_journal_events for b-running and a working task in ws-b.
    db.append_thread_journal_events(&[ThreadJournalEventInput {
        thread_id: "b-running".to_string(),
        ts: "2026-04-17T12:00:01.000Z".to_string(),
        event_type: "turn/started".to_string(),
        turn_id: Some("turn-crash-1".to_string()),
        item_id: None,
        request_id: None,
        payload: json!({ "turn": { "id": "turn-crash-1", "status": "inProgress" } }),
    }])
    .await
    .unwrap();

    db.create_task(CreateTaskInput {
        id: "task-b-1".to_string(),
        workspace_path: ws_b_str.clone(),
        title: "Stale Task B".to_string(),
        objective: "Verify crash reconciliation".to_string(),
        context: String::new(),
        source_session_id: None,
        creation_origin: "manual".to_string(),
        creation_idempotency_key: Some("idem-b-1".to_string()),
        initial_status: "working".to_string(),
        review_required: false,
        review_rounds: 0,
        thread: TaskThreadInput {
            id: "tt-b-1".to_string(),
            session_id: "b-running".to_string(),
            title: "Primary".to_string(),
            created_by: "system".to_string(),
            created_at: "2026-04-17T12:00:00.000Z".to_string(),
            updated_at: "2026-04-17T12:00:00.000Z".to_string(),
        },
        work_items: vec![WorkItemInput {
            id: "wi-1".to_string(),
            title: "Run".to_string(),
            description: String::new(),
            status: "in_progress".to_string(),
            position: 0,
            expected_outputs: vec!["done".to_string()],
            created_at: "2026-04-17T12:00:00.000Z".to_string(),
            updated_at: "2026-04-17T12:00:00.000Z".to_string(),
        }],
    })
    .await
    .unwrap();

    let report = db
        .reconcile_stale_execution_states(Some(&ws_b_str))
        .await
        .unwrap();
    assert_eq!(report.sessions_reconciled, 2);
    assert_eq!(report.turns_interrupted, 1);
    assert_eq!(report.tasks_reconciled, 1);

    // Workspace A active session untouched!
    let a_rec = db.get_session_record("a-running").unwrap().unwrap();
    assert_eq!(a_rec.execution_state, Some(AgentExecutionState::Running));
    assert!(a_rec.has_pending_ask);
    assert!(a_rec.has_pending_approval);

    // Workspace B running & pending_init reconciled out of transient states and prompts cleared!
    for id in ["b-running", "b-pending"] {
        let rec = db.get_session_record(id).unwrap().unwrap();
        assert!(rec.execution_state.unwrap().is_reconciled_terminal());
        assert!(!rec.has_pending_ask);
        assert!(!rec.has_pending_approval);
        let snap = db.get_session_snapshot(id).unwrap().unwrap();
        assert_eq!(snap["hasPendingAsk"], json!(false));
        assert_eq!(snap["hasPendingApproval"], json!(false));
    }

    // Open turn in journal now has turn/completed with status "interrupted"!
    let journal_events = db.list_thread_journal_events("b-running", 0, None).unwrap();
    assert_eq!(journal_events.len(), 2);
    assert_eq!(journal_events[1].event_type, "turn/completed");
    assert_eq!(journal_events[1].payload["turn"]["status"], "interrupted");

    // Stale task transitioned out of working!
    assert_eq!(
        db.get_task_status("task-b-1").unwrap().as_deref(),
        Some("failed")
    );

    // Idempotent second run.
    let second = db
        .reconcile_stale_execution_states(Some(&ws_b_str))
        .await
        .unwrap();
    assert_eq!(second.sessions_reconciled, 0);
    assert_eq!(second.turns_interrupted, 0);
    assert_eq!(second.tasks_reconciled, 0);
    db.close();
}

#[tokio::test]
async fn monotonic_thread_journal_replay_and_snapshot_fallback_on_gap_or_corruption() {
    let iso = IsolatedStorageEnv::new("journal");
    let db = Arc::new(
        SessionDb::open(SessionDbOptions {
            root_dir: iso.cowork_root.clone(),
            sessions_dir: iso.sessions_dir.clone(),
            db_path: None,
            busy_timeout_ms: Some(5_000),
        })
        .await
        .unwrap(),
    );

    db.persist_session_mutation(sample_mutation(
        "thread-1",
        &iso.root.to_string_lossy(),
        Some(AgentExecutionState::Completed),
        false,
        false,
    ))
    .await
    .unwrap();
    let snap = db.project_legacy_snapshot("thread-1").unwrap().unwrap();
    db.persist_session_snapshot("thread-1", &snap)
        .await
        .unwrap();

    let journal = ThreadJournal::new(Arc::clone(&db));
    for idx in 1..=1050 {
        journal
            .enqueue(ThreadJournalEventInput {
                thread_id: "thread-1".to_string(),
                ts: "2026-04-17T12:00:00.000Z".to_string(),
                event_type: "item/agentMessage/delta".to_string(),
                turn_id: Some("turn-1".to_string()),
                item_id: Some("msg-1".to_string()),
                request_id: None,
                payload: json!({ "delta": format!("chunk-{idx}") }),
            })
            .await
            .unwrap();
    }
    journal.wait_for_idle("thread-1").await;

    assert_eq!(db.get_thread_journal_tail_seq("thread-1").unwrap(), 1050);
    let all = journal.list("thread-1", 0, None).unwrap();
    assert_eq!(all.len(), 1050);
    for (i, ev) in all.iter().enumerate() {
        assert_eq!(ev.seq, (i + 1) as u64);
    }

    // Incremental replay after_seq = 1045 returns exact tail 1046..=1050.
    let ok_replay = journal.replay_or_fallback("thread-1", 1045).await.unwrap();
    assert!(ok_replay.health.trusted);
    assert!(!ok_replay.health.snapshot_required);
    assert_eq!(ok_replay.events.len(), 5);
    assert!(ok_replay.fallback_snapshot.is_none());

    // Inject sequence gap (delete seq = 1048 directly) -> fallback to snapshot + record thread_journal_failures!
    {
        let raw = Connection::open(iso.cowork_root.join("sessions.db")).unwrap();
        raw.execute(
            "DELETE FROM thread_journal_events WHERE thread_id = 'thread-1' AND seq = 1048",
            [],
        )
        .unwrap();
    }
    let gap_replay = journal.replay_or_fallback("thread-1", 1045).await.unwrap();
    assert!(!gap_replay.health.trusted);
    assert!(gap_replay.health.snapshot_required);
    assert!(gap_replay.fallback_snapshot.is_some());
    let persisted_failure = db
        .get_thread_journal_failure("thread-1")
        .unwrap()
        .expect("gap recorded in thread_journal_failures");
    assert!(persisted_failure.failed_write_count >= 1);

    // Also test corrupt JSON payload on thread-2 -> fallback to snapshot + failure recorded!
    db.persist_session_mutation(sample_mutation(
        "thread-2",
        &iso.root.to_string_lossy(),
        Some(AgentExecutionState::Completed),
        false,
        false,
    ))
    .await
    .unwrap();
    let snap2 = db.project_legacy_snapshot("thread-2").unwrap().unwrap();
    db.persist_session_snapshot("thread-2", &snap2)
        .await
        .unwrap();
    {
        let raw = Connection::open(iso.cowork_root.join("sessions.db")).unwrap();
        raw.execute(
            "INSERT INTO thread_journal_events (thread_id, seq, ts, event_type, turn_id, item_id, request_id, payload_json)
             VALUES ('thread-2', 1, '2026-04-17T12:00:00.000Z', 'turn/started', 't1', NULL, NULL, '{not-json')",
            [],
        )
        .unwrap();
    }
    let corrupt_replay = journal.replay_or_fallback("thread-2", 0).await.unwrap();
    assert!(!corrupt_replay.health.trusted);
    assert!(corrupt_replay.health.snapshot_required);
    assert!(corrupt_replay.fallback_snapshot.is_some());
    assert!(db.get_thread_journal_failure("thread-2").unwrap().is_some());

    journal.close().await;
    db.close();
}

#[tokio::test]
async fn write_coordinator_stale_pid_recovery_and_sqlite_with_file_lock_multi_process() {
    // Child helper dispatch when spawned as a subprocess during multi-process contention tests.
    let iso = IsolatedStorageEnv::new("locks");

    // 1. SessionDbWriteCoordinator stale dead-PID recovery vs live-PID preservation.
    let lock_dir = iso.cowork_root.join("locks/session-db-write.lock");
    fs::create_dir_all(&lock_dir).unwrap();
    fs::write(
        lock_dir.join("owner.json"),
        serde_json::to_string_pretty(&json!({
            "pid": 999_999_991, // guaranteed non-existent PID
            "ownerId": "dead-owner",
            "operation": "crashed_write",
            "startedAt": "2020-01-01T00:00:00.000Z",
            "updatedAt": "2020-01-01T00:00:00.000Z"
        }))
        .unwrap(),
    )
    .unwrap();

    let coordinator = SessionDbWriteCoordinator::new(SessionDbWriteCoordinatorOptions {
        root_dir: iso.cowork_root.clone(),
        acquire_timeout_ms: Some(2_000),
        retry_delay_ms: Some(10),
        stale_lock_ms: Some(30_000),
        heartbeat_ms: Some(200),
    });

    let val = coordinator
        .run_exclusive("recover_after_crash", || async {
            assert!(coordinator.owns_current_context());
            let owner_raw = fs::read_to_string(lock_dir.join("owner.json")).unwrap();
            let owner_json: serde_json::Value = serde_json::from_str(&owner_raw).unwrap();
            assert_eq!(owner_json["pid"], std::process::id());
            Ok::<_, cowork_storage::StorageError>(42)
        })
        .await
        .unwrap();
    assert_eq!(val, 42);
    assert!(!lock_dir.exists());
    assert_eq!(coordinator.diagnostics().stale_recovery_count, 1);

    // Live PID with stalled heartbeat must NEVER be stolen!
    fs::create_dir_all(&lock_dir).unwrap();
    let live_owner_id = "live-stalled-owner";
    fs::write(
        lock_dir.join("owner.json"),
        serde_json::to_string_pretty(&json!({
            "pid": std::process::id(),
            "ownerId": live_owner_id,
            "operation": "long_running_migration",
            "startedAt": "2020-01-01T00:00:00.000Z",
            "updatedAt": "2020-01-01T00:00:00.000Z"
        }))
        .unwrap(),
    )
    .unwrap();
    let live_coordinator = SessionDbWriteCoordinator::new(SessionDbWriteCoordinatorOptions {
        root_dir: iso.cowork_root.clone(),
        acquire_timeout_ms: Some(60),
        retry_delay_ms: Some(15),
        stale_lock_ms: Some(10),
        heartbeat_ms: Some(200),
    });
    let timeout_res = live_coordinator
        .run_exclusive("contending_writer", || async {
            Ok::<_, cowork_storage::StorageError>(())
        })
        .await;
    assert!(matches!(
        timeout_res,
        Err(cowork_storage::StorageError::LockTimeout { .. })
    ));
    assert_eq!(live_coordinator.diagnostics().timeout_count, 1);
    assert_eq!(live_coordinator.diagnostics().stale_recovery_count, 0);
    fs::remove_dir_all(&lock_dir).unwrap();

    // 2. Verify withFileLock SHA-256 path identity matches TypeScript normalize(canonical).toLowerCase()!
    let target_file = iso.root.join("MixedCaseStore.JSON");
    fs::write(&target_file, "0").unwrap();
    let lock_root = file_lock_root_for_cowork_home(&iso.cowork_root);
    let computed_lock_db = lock_database_path_for(&target_file, Some(&lock_root));
    let expected_identity = canonicalize_sync(&target_file)
        .to_string_lossy()
        .to_lowercase();
    let expected_hash = hex::encode(Sha256::digest(expected_identity.as_bytes()));
    assert_eq!(
        computed_lock_db,
        canonicalize_sync(&lock_root).join(format!("{expected_hash}.sqlite"))
    );

    // Symlink alias locks BOTH lexical and canonical identities in sorted order.
    #[cfg(unix)]
    {
        let alias = iso.root.join("alias-store.json");
        symlink(&target_file, &alias).unwrap();
        with_file_lock(
            &alias,
            || async { Ok::<_, cowork_config::ConfigError>(()) },
            FileLockOptions {
                lock_root: Some(lock_root.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let lexical_hash = hex::encode(Sha256::digest(
            alias.to_string_lossy().to_lowercase().as_bytes(),
        ));
        assert!(lock_root.join(format!("{expected_hash}.sqlite")).exists());
        assert!(lock_root.join(format!("{lexical_hash}.sqlite")).exists());
    }

    // 3. Multi-process contention: spawn 6 real OS child processes incrementing a shared file under withFileLock
    // AND inserting rows into sessions.db under SessionDbWriteCoordinator!
    let current_exe = std::env::current_exe().unwrap();
    let counter_file = iso.root.join("shared-counter.txt");
    fs::write(&counter_file, "0").unwrap();

    let mut children = Vec::new();
    for worker_idx in 0..6 {
        let child = Command::new(&current_exe)
            .arg("--exact")
            .arg("multiprocess_lock_child_worker")
            .arg("--nocapture")
            .env("COWORK_MP_CHILD_ACTIVE", "1")
            .env("COWORK_MP_WORKER_IDX", worker_idx.to_string())
            .env("COWORK_MP_COWORK_ROOT", &iso.cowork_root)
            .env("COWORK_MP_SESSIONS_DIR", &iso.sessions_dir)
            .env("COWORK_MP_COUNTER_FILE", &counter_file)
            .env("HOME", &iso.home)
            .env("COWORK_HOME_OVERRIDE", &iso.home)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn child lock worker");
        children.push(child);
    }

    for child in children {
        let out = child.wait_with_output().unwrap();
        assert!(
            out.status.success(),
            "child worker failed: stdout={} stderr={}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
    }

    // 6 workers * 5 increments each = 30 with zero lost updates!
    let final_count: u32 = fs::read_to_string(&counter_file)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    assert_eq!(final_count, 30);

    let db = SessionDb::open(SessionDbOptions {
        root_dir: iso.cowork_root.clone(),
        sessions_dir: iso.sessions_dir.clone(),
        db_path: None,
        busy_timeout_ms: Some(5_000),
    })
    .await
    .unwrap();
    assert_eq!(db.list_sessions(None).unwrap().len(), 6);
    db.close();
}

#[tokio::test]
async fn multiprocess_lock_child_worker() {
    if std::env::var("COWORK_MP_CHILD_ACTIVE").ok().as_deref() != Some("1") {
        return;
    }
    let worker_idx = std::env::var("COWORK_MP_WORKER_IDX").unwrap();
    let cowork_root = PathBuf::from(std::env::var("COWORK_MP_COWORK_ROOT").unwrap());
    let sessions_dir = PathBuf::from(std::env::var("COWORK_MP_SESSIONS_DIR").unwrap());
    let counter_file = PathBuf::from(std::env::var("COWORK_MP_COUNTER_FILE").unwrap());
    let lock_root = file_lock_root_for_cowork_home(&cowork_root);

    for _ in 0..5 {
        let cf = counter_file.clone();
        with_file_lock_sync(
            &counter_file,
            move || {
                let cur: u32 = fs::read_to_string(&cf).unwrap().trim().parse().unwrap();
                std::thread::sleep(Duration::from_millis(5));
                fs::write(&cf, (cur + 1).to_string()).unwrap();
                Ok::<_, cowork_config::ConfigError>(())
            },
            FileLockOptions {
                acquire_timeout_ms: Some(10_000),
                retry_delay_ms: Some(10),
                lock_root: Some(lock_root.clone()),
            },
        )
        .unwrap();
    }

    let db = SessionDb::open(SessionDbOptions {
        root_dir: cowork_root.clone(),
        sessions_dir,
        db_path: None,
        busy_timeout_ms: Some(5_000),
    })
    .await
    .unwrap();
    db.persist_session_mutation(sample_mutation(
        &format!("mp-session-{worker_idx}"),
        &cowork_root.to_string_lossy(),
        Some(AgentExecutionState::Completed),
        false,
        false,
    ))
    .await
    .unwrap();
    db.close();
}

#[tokio::test]
async fn memory_sqlite_store_imports_legacy_markdown_and_renders_hot_cache() {
    let iso = IsolatedStorageEnv::new("memory");
    let ws_cowork = iso.root.join("ws/.cowork");
    fs::create_dir_all(ws_cowork.join("memory")).unwrap();
    fs::write(ws_cowork.join("AGENT.md"), "Always run cargo clippy.").unwrap();
    fs::write(
        ws_cowork.join("memory/Arch Notes.md"),
        "Split RW and RO handles.",
    )
    .unwrap();

    let paths = get_ai_coworker_paths(Some(&iso.home), &std::collections::HashMap::new());
    let store = MemoryStore::new(
        ws_cowork.join("memory.sqlite"),
        paths.root_dir.join("memory.sqlite"),
    );

    let all = store.list(Some(MemoryScope::Workspace)).unwrap();
    assert_eq!(all.len(), 2);
    assert!(all.iter().any(|m| m.id == "hot"));
    assert!(all.iter().any(|m| m.id == "arch-notes"));

    // Create conflict fails in Create mode, succeeds in Upsert mode.
    assert!(
        store
            .upsert(
                MemoryScope::Workspace,
                Some("hot"),
                "Duplicate",
                MemoryWriteMode::Create
            )
            .is_err()
    );
    store
        .upsert(
            MemoryScope::Workspace,
            Some("hot"),
            "Updated hot memory.",
            MemoryWriteMode::Upsert,
        )
        .unwrap();

    let prompt = store.render_prompt_section().unwrap();
    assert!(prompt.contains("#### Workspace Hot Cache"));
    assert!(prompt.contains("Updated hot memory."));
    assert!(store.remove(MemoryScope::Workspace, "arch-notes").unwrap());
}
