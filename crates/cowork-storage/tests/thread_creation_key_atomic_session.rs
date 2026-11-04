//! `bind_thread_creation_key_with_session` commits a `clientThreadId` binding together with the
//! thread's initial session row, so creators sharing one `sessions.db` (separate handles, as two
//! server processes would hold) always agree on one thread, exactly one of them writes it, and a
//! losing creator never writes over the winner's row.

use std::path::{Path, PathBuf};

use cowork_config::{ProviderName, canonicalize_sync};
use cowork_storage::{
    PersistedSessionMutation, PersistedSessionSnapshotData, SessionDb, SessionDbOptions,
    SessionKind, SessionPersistenceStatus, SessionTitleSource,
};
use rusqlite::{Connection, params};
use tempfile::TempDir;

const WORKSPACE: &str = "/workspace/keyed";
const KEY: &str = "/workspace/keyed\0client-thread-1";

fn temp_root() -> (TempDir, PathBuf) {
    let base = if cfg!(target_os = "macos") {
        PathBuf::from("/private/tmp")
    } else {
        std::env::temp_dir()
    };
    let dir = tempfile::Builder::new()
        .prefix("cowork-stor-keyed-create-")
        .tempdir_in(base)
        .unwrap();
    let root = canonicalize_sync(dir.path());
    std::fs::create_dir_all(root.join("sessions")).unwrap();
    (dir, root)
}

async fn open(root: &Path) -> SessionDb {
    SessionDb::open(SessionDbOptions {
        root_dir: root.to_path_buf(),
        sessions_dir: root.join("sessions"),
        db_path: None,
        busy_timeout_ms: Some(5_000),
    })
    .await
    .unwrap()
}

fn initial(session_id: &str, title: &str) -> PersistedSessionMutation {
    let now = "2026-11-04T12:00:00.000Z".to_owned();
    PersistedSessionMutation {
        session_id: session_id.to_owned(),
        event_type: "thread/started".to_owned(),
        event_ts: Some(now.clone()),
        direction: Some("server".to_owned()),
        payload: None,
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
            effective_model: None,
            requested_reasoning_effort: None,
            effective_reasoning_effort: None,
            execution_state: None,
            last_message_preview: None,
            title: title.to_owned(),
            title_source: SessionTitleSource::Default,
            title_model: None,
            provider: ProviderName::Google,
            model: "gemini-3-flash-preview".to_owned(),
            working_directory: WORKSPACE.to_owned(),
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
            system_prompt: String::new(),
            messages: Vec::new(),
            last_memory_generated_index: None,
            provider_state: None,
            todos: Vec::new(),
            harness_context: None,
            cost_tracker: None,
        },
    }
}

fn count(conn: &Connection, sql: &str, arg: &str) -> i64 {
    conn.query_row(sql, params![arg], |r| r.get(0)).unwrap()
}

#[tokio::test]
async fn racing_creators_on_separate_handles_agree_on_one_committed_thread() {
    let (_tmp, root) = temp_root();
    let db_a = open(&root).await;
    let db_b = open(&root).await;

    let (a, b) = tokio::join!(
        db_a.bind_thread_creation_key_with_session(KEY, initial("thread-a", "from a")),
        db_b.bind_thread_creation_key_with_session(KEY, initial("thread-b", "from b")),
    );
    let (bound_a, seq_a) = a.unwrap();
    let (bound_b, seq_b) = b.unwrap();
    assert_eq!(
        bound_a, bound_b,
        "both creators must resolve the same thread"
    );
    assert_eq!(
        usize::from(seq_a.is_some()) + usize::from(seq_b.is_some()),
        1,
        "exactly one creator writes the initial row"
    );
    let (winner, loser, winner_title) = if seq_a.is_some() {
        ("thread-a", "thread-b", "from a")
    } else {
        ("thread-b", "thread-a", "from b")
    };
    assert_eq!(bound_a, winner);

    let conn = Connection::open(root.join("sessions.db")).unwrap();
    assert_eq!(
        count(
            &conn,
            "SELECT COUNT(*) FROM sessions WHERE working_directory = ?1",
            WORKSPACE
        ),
        1
    );
    assert_eq!(
        count(
            &conn,
            "SELECT COUNT(*) FROM session_events WHERE session_id = ?1",
            winner
        ),
        1
    );
    assert!(db_a.get_session_record(loser).unwrap().is_none());
    let stored = db_b.get_session_record(winner).unwrap().unwrap();
    assert_eq!(stored.title, winner_title);

    // A later creator with the committed key reads the winner's row and writes nothing.
    let (again, seq) = db_b
        .bind_thread_creation_key_with_session(KEY, initial("thread-c", "from c"))
        .await
        .unwrap();
    assert_eq!(again, winner);
    assert_eq!(seq, None);
    assert!(db_b.get_session_record("thread-c").unwrap().is_none());
    assert_eq!(
        db_a.get_session_record(winner).unwrap().unwrap().title,
        winner_title
    );
    assert_eq!(
        count(
            &conn,
            "SELECT COUNT(*) FROM session_events WHERE session_id = ?1",
            winner
        ),
        1
    );
}

#[tokio::test]
async fn a_key_bound_to_a_missing_session_is_rebound_with_the_new_row() {
    let (_tmp, root) = temp_root();
    let db = open(&root).await;
    // A binding committed without its session (the pre-fix two-step creation).
    assert_eq!(
        db.bind_thread_creation_key(KEY, "orphan").await.unwrap(),
        "orphan"
    );

    let (bound, seq) = db
        .bind_thread_creation_key_with_session(KEY, initial("fresh", "fresh"))
        .await
        .unwrap();
    assert_eq!(bound, "fresh");
    assert_eq!(seq, Some(1));
    assert_eq!(
        db.get_session_record("fresh").unwrap().unwrap().title,
        "fresh"
    );
    assert_eq!(
        db.bind_thread_creation_key(KEY, "other").await.unwrap(),
        "fresh"
    );
}
