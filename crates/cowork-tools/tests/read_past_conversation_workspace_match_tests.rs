//! Regression: `readPastConversation` compares the saved conversation's workspace canonically
//! (TS `sameWorkspacePath`), the same way `SessionDb::list_sessions` filters. A conversation
//! saved under an equivalent spelling (e.g. a trailing slash) is listed AND readable; a
//! genuinely different workspace is still denied.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use cowork_config::ProviderName;
use cowork_storage::{
    AgentExecutionState, PersistedSessionMutation, PersistedSessionSnapshotData, SessionDb,
    SessionDbOptions, SessionKind, SessionPersistenceStatus, SessionTitleSource,
};
use cowork_tools::{AdvancedMemoryStore, ToolError, ToolExecutionContext, create_builtin_tools};
use serde_json::{Map, Value, json};
use uuid::Uuid;

fn test_temp_base() -> PathBuf {
    if cfg!(target_os = "macos") {
        PathBuf::from("/private/tmp")
    } else {
        std::env::temp_dir()
    }
}

async fn seed_session(db: &SessionDb, session_id: &str, working_directory: String) {
    db.persist_session_mutation(PersistedSessionMutation {
        session_id: session_id.to_owned(),
        event_type: "session_saved".to_owned(),
        event_ts: Some("2026-10-30T10:05:00.000Z".to_owned()),
        direction: None,
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
            requested_model: Some("gpt-5.4".to_owned()),
            effective_model: Some("gpt-5.4".to_owned()),
            requested_reasoning_effort: None,
            effective_reasoning_effort: None,
            execution_state: Some(AgentExecutionState::Completed),
            last_message_preview: Some("preview".to_owned()),
            title: format!("Title {session_id}"),
            title_source: SessionTitleSource::Model,
            title_model: None,
            provider: ProviderName::Openai,
            model: "gpt-5.4".to_owned(),
            working_directory,
            output_directory: None,
            uploads_directory: None,
            provider_options: None,
            sandbox: None,
            enable_mcp: false,
            backups_enabled_override: None,
            created_at: "2026-10-30T10:00:00.000Z".to_owned(),
            updated_at: "2026-10-30T10:05:00.000Z".to_owned(),
            status: SessionPersistenceStatus::Active,
            has_pending_ask: false,
            has_pending_approval: false,
            system_prompt: String::new(),
            messages: vec![
                json!({ "role": "user", "content": [{ "type": "text", "text": "Which DB?" }] }),
                json!({ "role": "assistant", "content": [{ "type": "text", "text": "PostgreSQL 17." }] }),
            ],
            last_memory_generated_index: Some(0),
            provider_state: None,
            todos: Vec::new(),
            harness_context: None,
            cost_tracker: None,
        },
    })
    .await
    .unwrap();
}

fn args(v: Value) -> Map<String, Value> {
    serde_json::from_value(v).unwrap()
}

fn with_trailing_slash(p: &Path) -> String {
    format!("{}{}", p.to_string_lossy(), std::path::MAIN_SEPARATOR)
}

#[tokio::test]
async fn past_conversation_saved_with_trailing_slash_workspace_is_listed_and_readable() {
    let base = test_temp_base().join(format!("cowork-past-conv-ws-{}", Uuid::new_v4()));
    let home = base.join("home");
    let ws = base.join("workspace");
    let other_ws = base.join("other");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&ws).unwrap();
    fs::create_dir_all(&other_ws).unwrap();
    let home = fs::canonicalize(home).unwrap();
    let ws = fs::canonicalize(ws).unwrap();
    let other_ws = fs::canonicalize(other_ws).unwrap();
    let cowork_root = home.join(".cowork");

    let db = Arc::new(
        SessionDb::open(SessionDbOptions {
            root_dir: cowork_root.clone(),
            sessions_dir: cowork_root.join("sessions"),
            db_path: Some(cowork_root.join("sessions.db")),
            busy_timeout_ms: Some(5_000),
        })
        .await
        .unwrap(),
    );
    seed_session(&db, "past-trailing-slash", with_trailing_slash(&ws)).await;
    seed_session(
        &db,
        "past-other-workspace",
        other_ws.to_string_lossy().into_owned(),
    )
    .await;

    let mut ctx =
        ToolExecutionContext::new_for_tests(home, ws.clone(), ProviderName::Openai, "gpt-5.4");
    ctx.session_id = "current-session".to_owned();
    ctx.session_db = Some(Arc::clone(&db));
    ctx.advanced_memory = true;
    ctx.advanced_memory_store = Some(Arc::new(AdvancedMemoryStore::new(
        cowork_root.clone(),
        ws.clone(),
        cowork_root.join("workspaces/chats"),
    )));
    let tools = create_builtin_tools(&ctx);
    let tool = tools.get("readPastConversation").expect("tool registered");

    let listed = tool
        .execute(args(json!({ "list": true })), &ctx)
        .await
        .unwrap();
    let listed = listed.as_text().unwrap();
    assert!(listed.contains("past-trailing-slash"), "{listed}");
    assert!(!listed.contains("past-other-workspace"), "{listed}");

    let read = tool
        .execute(args(json!({ "sessionId": "past-trailing-slash" })), &ctx)
        .await
        .expect("an equivalent workspace spelling is the same workspace");
    assert!(read.as_text().unwrap().contains("PostgreSQL 17."));

    let denied = tool
        .execute(args(json!({ "sessionId": "past-other-workspace" })), &ctx)
        .await
        .expect_err("a different workspace is still denied");
    assert!(matches!(denied, ToolError::PathDenied(_)), "{denied:?}");

    let _ = fs::remove_dir_all(&base);
}
