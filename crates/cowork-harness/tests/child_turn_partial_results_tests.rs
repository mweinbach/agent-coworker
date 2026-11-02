//! A child turn that completes provider/tool steps and is then interrupted (or whose provider fails
//! on a later step) must keep its request, the completed tool call/result and the incurred usage,
//! so a follow-up resumes from what actually happened.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use cowork_config::{AgentConfig, LoadConfigOptions, load_config};
use cowork_harness::agents::{
    AgentControl, AgentControlConfig, AgentSpawnRequest, ChildTurnError, ChildTurnExecutor,
    ChildTurnInput, ChildTurnResult,
};
use cowork_inference::{
    CanonicalMessage, ContentBlock, MessageRole, ProviderOpaqueMeta, ToolResultPart, TurnUsage,
};
use cowork_storage::{SessionDb, SessionDbOptions};
use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use tokio::sync::Notify;
use uuid::Uuid;

fn test_temp_base() -> PathBuf {
    if cfg!(target_os = "macos") {
        PathBuf::from("/private/tmp")
    } else {
        std::env::temp_dir()
    }
}

async fn setup_env(tag: &str) -> (PathBuf, cowork_config::AgentConfig, Arc<SessionDb>) {
    let base = test_temp_base().join(format!("cowork-child-partial-{tag}-{}", Uuid::new_v4()));
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

fn message(role: MessageRole, content: Vec<ContentBlock>) -> CanonicalMessage {
    CanonicalMessage {
        id: Uuid::new_v4().to_string(),
        role,
        content,
        phase: None,
        provider: None,
        api: None,
        model: None,
        stop_reason: None,
        provider_meta: ProviderOpaqueMeta::default(),
        created_at: "2026-01-01T00:00:00Z".to_owned(),
    }
}

fn text(text: &str) -> ContentBlock {
    ContentBlock::Text {
        text: text.to_owned(),
        phase: None,
        citations: Vec::new(),
        provider_meta: ProviderOpaqueMeta::default(),
    }
}

fn usage(prompt: u64, completion: u64) -> TurnUsage {
    TurnUsage {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: prompt + completion,
        ..Default::default()
    }
}

/// Step 1 of a scripted child turn: the request, a `write` tool call and its result.
fn history_after_tool_step(input: &ChildTurnInput, call_id: &str) -> Vec<CanonicalMessage> {
    let mut args = Map::new();
    args.insert("path".to_owned(), json!("notes/partial.txt"));
    let mut messages = input.initial_messages.clone();
    messages.push(message(MessageRole::User, vec![text(&input.prompt)]));
    messages.push(message(
        MessageRole::Assistant,
        vec![ContentBlock::ToolCall {
            id: call_id.to_owned(),
            name: "write".to_owned(),
            arguments: args,
            partial_json: None,
            provider_meta: ProviderOpaqueMeta::default(),
        }],
    ));
    messages.push(message(
        MessageRole::Tool,
        vec![ContentBlock::ToolResult {
            tool_call_id: call_id.to_owned(),
            tool_name: Some("write".to_owned()),
            content: vec![ToolResultPart::Text {
                text: "wrote notes/partial.txt".to_owned(),
            }],
            structured_meta: None,
            is_error: false,
            provider_meta: ProviderOpaqueMeta::default(),
        }],
    ));
    messages
}

/// Scripted executor: `INTERRUPT_ME` runs a tool step then blocks until cancelled, `FAIL_ME` runs a
/// tool step then fails, anything else answers with text.
#[derive(Default)]
struct ScriptedExecutor {
    inputs: Mutex<Vec<ChildTurnInput>>,
    tool_step_done: Notify,
    release_cleanup: Notify,
}

#[async_trait]
impl ChildTurnExecutor for ScriptedExecutor {
    async fn run_child_turn(
        &self,
        input: ChildTurnInput,
    ) -> Result<ChildTurnResult, ChildTurnError> {
        self.inputs.lock().push(input.clone());
        if input.prompt.contains("INTERRUPT_ME") {
            let messages = history_after_tool_step(&input, "call_interrupt");
            self.tool_step_done.notify_one();
            input.cancel_token.cancelled().await;
            if input.prompt.contains("HOLD_CLEANUP") {
                self.release_cleanup.notified().await;
            }
            return Err(ChildTurnError::with_partial(
                "Child agent turn interrupted.",
                ChildTurnResult {
                    messages,
                    latest_assistant_text: None,
                    usage: usage(20, 10),
                },
            ));
        }
        if input.prompt.contains("FAIL_ME") {
            return Err(ChildTurnError::with_partial(
                "Child agent turn failed.",
                ChildTurnResult {
                    messages: history_after_tool_step(&input, "call_fail"),
                    latest_assistant_text: None,
                    usage: usage(20, 10),
                },
            ));
        }
        if input.prompt.contains("HOLD_SUCCESS") {
            self.tool_step_done.notify_one();
            self.release_cleanup.notified().await;
        }
        let reply = format!("handled: {}", input.prompt);
        let mut messages = input.initial_messages;
        messages.push(message(MessageRole::User, vec![text(&input.prompt)]));
        messages.push(message(MessageRole::Assistant, vec![text(&reply)]));
        Ok(ChildTurnResult {
            messages,
            latest_assistant_text: Some(reply),
            usage: usage(25, 8),
        })
    }
}

fn spawn_req(message: &str) -> AgentSpawnRequest {
    AgentSpawnRequest {
        message: message.to_owned(),
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
    }
}

fn total_tokens(usage: Option<&Value>) -> u64 {
    usage
        .and_then(|u| u.get("totalTokens"))
        .and_then(Value::as_u64)
        .unwrap_or_default()
}

fn has_partial_step(messages: &[CanonicalMessage], prompt: &str, call_id: &str) -> bool {
    let has_request = messages.iter().any(|m| {
        m.role == MessageRole::User
            && m.content
                .iter()
                .any(|b| matches!(b, ContentBlock::Text { text, .. } if text == prompt))
    });
    let has_call = messages.iter().any(|m| {
        m.content
            .iter()
            .any(|b| matches!(b, ContentBlock::ToolCall { id, .. } if id == call_id))
    });
    let has_result = messages.iter().any(|m| {
        m.content.iter().any(
            |b| matches!(b, ContentBlock::ToolResult { tool_call_id, .. } if tool_call_id == call_id),
        )
    });
    has_request && has_call && has_result
}

async fn wait_settled(control: &AgentControl, agent_id: &str) {
    control
        .wait(
            &[agent_id.to_owned()],
            Some(5_000),
            Some("all"),
            false,
            false,
        )
        .await
        .unwrap();
    for _ in 0..200 {
        if !control.inspect(agent_id).unwrap().agent.busy {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("child {agent_id} never settled");
}

fn stored_messages(db: &SessionDb, agent_id: &str) -> Vec<CanonicalMessage> {
    db.get_session_record(agent_id)
        .unwrap()
        .unwrap()
        .messages
        .into_iter()
        .map(|m| serde_json::from_value(m).unwrap())
        .collect()
}

fn open_parent(
    cfg: &AgentConfig,
    db: &Arc<SessionDb>,
    executor: &Arc<ScriptedExecutor>,
) -> AgentControl {
    AgentControl::new(
        AgentControlConfig {
            parent_session_id: "root-partial".to_owned(),
            parent_depth: 0,
            agent_config: Arc::new(cfg.clone()),
            session_db: Arc::clone(db),
            connected_providers: [cfg.provider].into_iter().collect(),
        },
        Arc::clone(executor) as Arc<dyn ChildTurnExecutor>,
        Arc::new(|_, _| {}),
    )
}

#[tokio::test]
async fn interrupted_and_failed_child_turns_keep_partial_history_and_usage() {
    let (base, cfg, db) = setup_env("partial").await;
    let executor = Arc::new(ScriptedExecutor::default());
    let control = open_parent(&cfg, &db, &executor);

    // Interrupt after the tool step: status semantics unchanged ("completed"), but the request,
    // tool call/result and step usage survive.
    let interrupt_prompt = "INTERRUPT_ME: write notes";
    let tool_step_done = executor.tool_step_done.notified();
    let a = control
        .spawn(spawn_req(interrupt_prompt), &[], &[], None)
        .await
        .unwrap()
        .agent_id;
    tokio::time::timeout(Duration::from_secs(5), tool_step_done)
        .await
        .expect("tool step ran");
    assert_eq!(control.interrupt_running_children(), 1);
    wait_settled(&control, &a).await;

    let insp = control.inspect(&a).unwrap();
    assert_eq!(insp.agent.execution_state, "completed");
    assert_eq!(total_tokens(insp.session_usage.as_ref()), 30);
    assert_eq!(total_tokens(insp.last_turn_usage.as_ref()), 30);
    let stored = stored_messages(&db, &a);
    assert!(
        has_partial_step(&stored, interrupt_prompt, "call_interrupt"),
        "{stored:?}"
    );

    // Reopening the parent must keep the usage that the interrupted turn already incurred.
    let control = open_parent(&cfg, &db, &executor);
    let restored = control.inspect(&a).unwrap();
    assert_eq!(total_tokens(restored.session_usage.as_ref()), 30);
    assert_eq!(total_tokens(restored.last_turn_usage.as_ref()), 30);

    // A follow-up continues from the partial history and accumulates usage.
    control.send_input(&a, "continue", false).await.unwrap();
    wait_settled(&control, &a).await;
    let follow_up = executor
        .inputs
        .lock()
        .iter()
        .rfind(|i| i.agent_id == a && i.prompt == "continue")
        .cloned()
        .expect("follow-up turn ran");
    assert!(
        has_partial_step(
            &follow_up.initial_messages,
            interrupt_prompt,
            "call_interrupt"
        ),
        "{:?}",
        follow_up.initial_messages
    );
    let insp = control.inspect(&a).unwrap();
    assert_eq!(insp.agent.execution_state, "completed");
    assert_eq!(total_tokens(insp.session_usage.as_ref()), 63);
    let stored = stored_messages(&db, &a);
    assert!(has_partial_step(
        &stored,
        interrupt_prompt,
        "call_interrupt"
    ));
    assert!(stored.iter().any(|m| {
        m.content
            .iter()
            .any(|b| matches!(b, ContentBlock::Text { text, .. } if text == "handled: continue"))
    }));

    // A provider failure after the tool step stays "errored" but keeps the same partial state.
    let fail_prompt = "FAIL_ME: write notes";
    let b = control
        .spawn(spawn_req(fail_prompt), &[], &[], None)
        .await
        .unwrap()
        .agent_id;
    wait_settled(&control, &b).await;
    let insp = control.inspect(&b).unwrap();
    assert_eq!(insp.agent.execution_state, "errored");
    assert_eq!(total_tokens(insp.session_usage.as_ref()), 30);
    let stored = stored_messages(&db, &b);
    assert!(
        has_partial_step(&stored, fail_prompt, "call_fail"),
        "{stored:?}"
    );

    let _ = fs::remove_dir_all(&base);
}

#[tokio::test]
async fn close_and_resume_wait_for_the_interrupted_child_transcript() {
    let (base, cfg, db) = setup_env("closing").await;
    let executor = Arc::new(ScriptedExecutor::default());
    let control = open_parent(&cfg, &db, &executor);
    // Closing a running turn must preserve its partial tool history before a concurrent resume
    // can admit another turn on the same transcript.
    let held = "INTERRUPT_ME HOLD_CLEANUP";
    let c = control
        .spawn(spawn_req(held), &[], &[], None)
        .await
        .unwrap()
        .agent_id;
    executor.tool_step_done.notified().await;
    let mut closing = Box::pin(control.close(&c));
    assert!(futures::poll!(&mut closing).is_pending());
    let mut resuming = Box::pin(control.resume(&c));
    assert!(futures::poll!(&mut resuming).is_pending());
    assert_eq!(control.inspect(&c).unwrap().agent.lifecycle_state, "closed");
    executor.release_cleanup.notify_one();
    let (closed, resumed) = tokio::join!(closing, resuming);
    assert_eq!(closed.unwrap().lifecycle_state, "closed");
    assert_eq!(resumed.unwrap().lifecycle_state, "active");
    control.send_input(&c, "after close", false).await.unwrap();
    wait_settled(&control, &c).await;
    {
        let inputs = executor.inputs.lock();
        let follow_up = inputs
            .iter()
            .find(|i| i.agent_id == c && i.prompt == "after close")
            .unwrap();
        assert!(has_partial_step(
            &follow_up.initial_messages,
            held,
            "call_interrupt"
        ));
    }

    let _ = fs::remove_dir_all(&base);
}

#[tokio::test]
async fn follow_up_waits_for_the_previous_status_to_reach_disk() {
    let (base, cfg, db) = setup_env("finalizing").await;
    let executor = Arc::new(ScriptedExecutor::default());
    let control = open_parent(&cfg, &db, &executor);
    // The executor returned, but the old loop still owes a durable completion and status event.
    // Hold the DB lock there and check that a follow-up waits before starting a fresh loop.
    let d = control
        .spawn(spawn_req("HOLD_SUCCESS"), &[], &[], None)
        .await
        .unwrap()
        .agent_id;
    executor.tool_step_done.notified().await;
    let mut follow_up = Box::pin(control.send_input(&d, "after persisted turn", false));
    db.write_coordinator()
        .run_exclusive("hold final status", || async {
            executor.release_cleanup.notify_one();
            tokio::time::timeout(Duration::from_secs(5), async {
                while control.inspect(&d).unwrap().agent.busy {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            assert!(futures::poll!(&mut follow_up).is_pending());
            Ok(())
        })
        .await
        .unwrap();
    follow_up.await.unwrap();
    wait_settled(&control, &d).await;

    let _ = fs::remove_dir_all(&base);
}
