//! Child agents created by the TS server persisted AI-SDK / pi-ai shaped messages (user messages
//! without `id`/`createdAt`, string content, `tool-call` / `tool-result` parts). After upgrading
//! in place, hydration must migrate those records instead of marking the child unrestorable;
//! only records that truly can't be migrated keep failing closed.

use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use cowork_config::{LoadConfigOptions, ProviderName, load_config};
use cowork_harness::agents::{
    AgentControl, AgentControlConfig, AgentSpawnRequest, ChildTurnError, ChildTurnExecutor,
    ChildTurnInput, ChildTurnResult,
};
use cowork_inference::{
    CanonicalMessage, ContentBlock, MessageRole, ProviderOpaqueMeta, ToolResultPart, TurnUsage,
};
use cowork_storage::{
    PersistedSessionMutation, PersistedSessionSnapshotData, SessionDb, SessionDbOptions,
};
use parking_lot::Mutex;
use serde_json::{Value, json};
use uuid::Uuid;

const PARENT_ID: &str = "root-legacy-child";

fn test_temp_base() -> PathBuf {
    if cfg!(target_os = "macos") {
        PathBuf::from("/private/tmp")
    } else {
        std::env::temp_dir()
    }
}

async fn setup_env(tag: &str) -> (PathBuf, cowork_config::AgentConfig, Arc<SessionDb>) {
    let base = test_temp_base().join(format!("cowork-child-legacy-{tag}-{}", Uuid::new_v4()));
    let home = base.join("home");
    let ws = base.join("ws");
    let builtin = base.join("builtin");
    fs::create_dir_all(home.join(".cowork/config")).unwrap();
    fs::create_dir_all(&ws).unwrap();
    fs::create_dir_all(&builtin).unwrap();

    let mut env = HashMap::new();
    env.insert("HOME".to_owned(), home.to_string_lossy().into_owned());
    env.insert(
        "COWORK_HOME_OVERRIDE".to_owned(),
        home.join(".cowork").to_string_lossy().into_owned(),
    );
    env.insert("COWORK_DISABLE_RUNTIME".to_owned(), "1".to_owned());
    env.insert("COWORK_RUNTIME_ALLOW_NETWORK".to_owned(), "0".to_owned());

    let cfg = load_config(LoadConfigOptions {
        cwd: Some(ws),
        homedir: Some(home.clone()),
        built_in_dir: Some(builtin),
        env: Some(env),
    })
    .unwrap();
    let db = Arc::new(
        SessionDb::open(SessionDbOptions {
            root_dir: home.join(".cowork"),
            sessions_dir: home.join(".cowork/sessions"),
            db_path: None,
            busy_timeout_ms: None,
        })
        .await
        .unwrap(),
    );
    (base, cfg, db)
}

struct EchoExecutor {
    inputs: Mutex<Vec<ChildTurnInput>>,
}

#[async_trait]
impl ChildTurnExecutor for EchoExecutor {
    async fn run_child_turn(
        &self,
        input: ChildTurnInput,
    ) -> Result<ChildTurnResult, ChildTurnError> {
        self.inputs.lock().push(input.clone());
        let text = format!("echo: {}", input.prompt);
        let mut messages = input.initial_messages;
        messages.push(CanonicalMessage {
            id: Uuid::new_v4().to_string(),
            role: MessageRole::Assistant,
            content: vec![ContentBlock::Text {
                text: text.clone(),
                phase: None,
                citations: Vec::new(),
                provider_meta: ProviderOpaqueMeta::default(),
            }],
            phase: None,
            provider: None,
            api: None,
            model: None,
            stop_reason: None,
            provider_meta: ProviderOpaqueMeta::default(),
            created_at: "2026-01-01T00:00:00Z".to_owned(),
        });
        Ok(ChildTurnResult {
            messages,
            latest_assistant_text: Some(text),
            usage: TurnUsage::default(),
        })
    }
}

fn make_control(
    cfg: &cowork_config::AgentConfig,
    db: &Arc<SessionDb>,
    executor: Arc<EchoExecutor>,
) -> AgentControl {
    let connected: BTreeSet<ProviderName> = [cfg.provider].into_iter().collect();
    AgentControl::new(
        AgentControlConfig {
            parent_session_id: PARENT_ID.to_owned(),
            parent_depth: 0,
            agent_config: Arc::new(cfg.clone()),
            session_db: Arc::clone(db),
            connected_providers: connected,
        },
        executor,
        Arc::new(|_, _| {}),
    )
}

fn echo_executor() -> Arc<EchoExecutor> {
    Arc::new(EchoExecutor {
        inputs: Mutex::new(Vec::new()),
    })
}

/// Spawns a child and lets its first turn finish, so a real agent row exists to rewrite.
async fn spawn_finished_child(cfg: &cowork_config::AgentConfig, db: &Arc<SessionDb>) -> String {
    let control = make_control(cfg, db, echo_executor());
    let agent_id = control
        .spawn(
            AgentSpawnRequest {
                message: "first task".to_owned(),
                role: None,
                profile_ref: None,
                model: None,
                reasoning_effort: None,
                nickname: None,
                task_type: None,
                target_paths: None,
                context_mode: Some("none".to_owned()),
                briefing: None,
                include_parent_todos: false,
                include_harness_context: false,
                fork_context: false,
                system_prompt_suffix: None,
            },
            &[],
            &[],
            None,
        )
        .await
        .unwrap()
        .agent_id;
    control
        .wait(
            std::slice::from_ref(&agent_id),
            Some(5_000),
            Some("all"),
            false,
            false,
        )
        .await
        .unwrap();
    agent_id
}

/// Replaces the child's stored transcript, as if the TS server had written it.
async fn overwrite_stored_messages(db: &SessionDb, agent_id: &str, messages: Vec<Value>) {
    let r = db.get_session_record(agent_id).unwrap().unwrap();
    db.persist_session_mutation(PersistedSessionMutation {
        session_id: r.session_id.clone(),
        event_type: "test.legacy_transcript".to_owned(),
        event_ts: Some(r.updated_at.clone()),
        direction: Some("internal".to_owned()),
        payload: None,
        snapshot: PersistedSessionSnapshotData {
            session_kind: r.session_kind,
            parent_session_id: r.parent_session_id,
            role: r.role,
            mode: r.mode,
            depth: r.depth,
            nickname: r.nickname,
            task_type: r.task_type,
            target_paths: r.target_paths,
            profile: r.profile,
            requested_model: r.requested_model,
            effective_model: r.effective_model,
            requested_reasoning_effort: r.requested_reasoning_effort,
            effective_reasoning_effort: r.effective_reasoning_effort,
            execution_state: r.execution_state,
            last_message_preview: r.last_message_preview,
            title: r.title,
            title_source: r.title_source,
            title_model: r.title_model,
            provider: r.provider,
            model: r.model,
            working_directory: r.working_directory,
            output_directory: r.output_directory,
            uploads_directory: r.uploads_directory,
            provider_options: r.provider_options,
            sandbox: r.sandbox,
            enable_mcp: r.enable_mcp,
            backups_enabled_override: r.backups_enabled_override,
            created_at: r.created_at,
            updated_at: r.updated_at,
            status: r.status,
            has_pending_ask: r.has_pending_ask,
            has_pending_approval: r.has_pending_approval,
            system_prompt: r.system_prompt,
            messages,
            last_memory_generated_index: r.last_memory_generated_index,
            provider_state: r.provider_state,
            todos: r.todos,
            harness_context: r.harness_context,
            cost_tracker: r.cost_tracker,
        },
    })
    .await
    .unwrap();
}

fn text_of(message: &CanonicalMessage) -> String {
    message
        .content
        .iter()
        .filter_map(|b| match b {
            ContentBlock::Text { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("")
}

#[tokio::test]
async fn ts_shaped_child_transcript_hydrates_and_accepts_send_input() {
    let (base, cfg, db) = setup_env("migrate").await;
    let agent_id = spawn_finished_child(&cfg, &db).await;

    // A transcript the TS server could have written: `runUserMessageTurn.ts` appended user
    // messages with string content and no id/createdAt, and AI-SDK tool parts.
    let legacy_transcript = vec![
        json!({ "role": "user", "content": "first task" }),
        json!({
            "role": "assistant",
            "content": [
                { "type": "text", "text": "Let me read it." },
                {
                    "type": "tool-call",
                    "toolCallId": "call_legacy_1",
                    "toolName": "read",
                    "input": { "filePath": "src/lib.rs" }
                }
            ]
        }),
        json!({
            "role": "tool",
            "content": [{
                "type": "tool-result",
                "toolCallId": "call_legacy_1",
                "toolName": "read",
                "output": { "type": "text", "value": "pub fn legacy() {}" }
            }]
        }),
        json!({ "role": "assistant", "content": "legacy answer" }),
        json!({ "role": "user", "content": [{ "type": "text", "text": "follow-up from TS" }] }),
    ];
    overwrite_stored_messages(&db, &agent_id, legacy_transcript.clone()).await;

    // Simulate the upgraded server reopening the parent.
    let exec = echo_executor();
    let control = make_control(&cfg, &db, Arc::clone(&exec));
    control
        .send_input(&agent_id, "second task", false)
        .await
        .expect("migrated child accepts new input");
    control
        .wait(
            std::slice::from_ref(&agent_id),
            Some(5_000),
            Some("all"),
            false,
            false,
        )
        .await
        .unwrap();

    let history = exec.inputs.lock()[0].initial_messages.clone();
    assert_eq!(history.len(), legacy_transcript.len(), "{history:#?}");
    let roles: Vec<MessageRole> = history.iter().map(|m| m.role).collect();
    assert_eq!(
        roles,
        vec![
            MessageRole::User,
            MessageRole::Assistant,
            MessageRole::Tool,
            MessageRole::Assistant,
            MessageRole::User,
        ]
    );
    assert_eq!(text_of(&history[0]), "first task");
    assert_eq!(text_of(&history[3]), "legacy answer");
    assert_eq!(text_of(&history[4]), "follow-up from TS");
    for m in &history {
        assert!(!m.id.trim().is_empty(), "migrated message lacks an id");
        assert!(
            !m.created_at.trim().is_empty(),
            "migrated message lacks createdAt"
        );
    }
    assert!(
        history[1].content.iter().any(|b| matches!(
            b,
            ContentBlock::ToolCall { id, name, arguments, .. }
                if id == "call_legacy_1"
                    && name == "read"
                    && arguments.get("filePath") == Some(&json!("src/lib.rs"))
        )),
        "{:#?}",
        history[1]
    );
    assert!(
        history[2].content.iter().any(|b| matches!(
            b,
            ContentBlock::ToolResult { tool_call_id, content, .. }
                if tool_call_id == "call_legacy_1"
                    && content.iter().any(|p| matches!(
                        p,
                        ToolResultPart::Text { text } if text.contains("pub fn legacy()")
                    ))
        )),
        "{:#?}",
        history[2]
    );

    // The follow-up turn persisted the migrated history plus its own reply.
    control.close(&agent_id).await.unwrap();
    let stored = db.get_session_record(&agent_id).unwrap().unwrap().messages;
    let decoded: Vec<CanonicalMessage> = stored
        .iter()
        .map(|v| serde_json::from_value(v.clone()).expect("stored canonically after migration"))
        .collect();
    assert_eq!(decoded.len(), legacy_transcript.len() + 1);
    assert_eq!(text_of(&decoded[0]), "first task");
    assert_eq!(text_of(decoded.last().unwrap()), "echo: second task");

    let _ = fs::remove_dir_all(&base);
}

#[tokio::test]
async fn unmigratable_child_transcript_still_fails_closed_and_is_kept_verbatim() {
    let (base, cfg, db) = setup_env("corrupt").await;
    let agent_id = spawn_finished_child(&cfg, &db).await;

    let corrupt_transcript = vec![
        json!({ "role": "user", "content": "first task" }),
        json!({ "role": "oracle", "content": "no such role" }),
    ];
    overwrite_stored_messages(&db, &agent_id, corrupt_transcript.clone()).await;

    let exec = echo_executor();
    let control = make_control(&cfg, &db, Arc::clone(&exec));
    let err = control
        .send_input(&agent_id, "second task", false)
        .await
        .unwrap_err();
    assert!(err.contains("cannot run after restart"), "{err}");
    assert!(err.contains("message 1"), "{err}");
    assert!(exec.inputs.lock().is_empty());

    // Closing never rewrites the raw transcript it could not decode.
    control.close(&agent_id).await.unwrap();
    let stored = db.get_session_record(&agent_id).unwrap().unwrap().messages;
    assert_eq!(stored, corrupt_transcript);

    let _ = fs::remove_dir_all(&base);
}
