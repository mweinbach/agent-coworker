//! `waitForAgent` readyAgentIds means "stopped running" (completed, errored, or closed), using
//! the same predicate that wakes the waiter, and failures are additionally flagged in
//! `erroredAgentIds` (legacy StatusBus parity).

use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use cowork_config::{LoadConfigOptions, load_config};
use cowork_harness::agents::{
    AgentControl, AgentControlConfig, AgentSpawnRequest, ChildTurnError, ChildTurnExecutor,
    ChildTurnInput, ChildTurnResult,
};
use cowork_inference::{
    CanonicalMessage, ContentBlock, MessageRole, ProviderOpaqueMeta, TurnUsage,
};
use cowork_storage::{SessionDb, SessionDbOptions};
use parking_lot::Mutex;
use serde_json::Value;
use uuid::Uuid;

fn test_temp_base() -> PathBuf {
    if cfg!(target_os = "macos") {
        PathBuf::from("/private/tmp")
    } else {
        std::env::temp_dir()
    }
}

async fn setup_env(tag: &str) -> (PathBuf, cowork_config::AgentConfig, Arc<SessionDb>) {
    let base = test_temp_base().join(format!("cowork-wait-ready-{tag}-{}", Uuid::new_v4()));
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

fn message(role: MessageRole, text: &str) -> CanonicalMessage {
    CanonicalMessage {
        id: Uuid::new_v4().to_string(),
        role,
        content: vec![ContentBlock::Text {
            text: text.to_owned(),
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
    }
}

/// `FAIL_ME` errors, `HOLD_ME` blocks until cancelled (closed), anything else succeeds.
struct ScriptedExecutor;

#[async_trait]
impl ChildTurnExecutor for ScriptedExecutor {
    async fn run_child_turn(
        &self,
        input: ChildTurnInput,
    ) -> Result<ChildTurnResult, ChildTurnError> {
        let mut messages = input.initial_messages.clone();
        messages.push(message(MessageRole::User, &input.prompt));
        if input.prompt.contains("FAIL_ME") {
            return Err(ChildTurnError::with_partial(
                "Child agent turn failed.",
                ChildTurnResult {
                    messages,
                    latest_assistant_text: None,
                    usage: TurnUsage::default(),
                },
            ));
        }
        if input.prompt.contains("HOLD_ME") {
            input.cancel_token.cancelled().await;
            return Err(ChildTurnError::with_partial(
                "Child agent turn interrupted.",
                ChildTurnResult {
                    messages,
                    latest_assistant_text: None,
                    usage: TurnUsage::default(),
                },
            ));
        }
        let reply = format!("handled: {}", input.prompt);
        messages.push(message(MessageRole::Assistant, &reply));
        Ok(ChildTurnResult {
            messages,
            latest_assistant_text: Some(reply),
            usage: TurnUsage::default(),
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

type Events = Arc<Mutex<Vec<(String, Value)>>>;

async fn control(tag: &str) -> (Arc<AgentControl>, Events) {
    let (_base, cfg, db) = setup_env(tag).await;
    let mut connected = BTreeSet::new();
    connected.insert(cfg.provider);
    let events: Events = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&events);
    let control = Arc::new(AgentControl::new(
        AgentControlConfig {
            parent_session_id: format!("root-{tag}"),
            parent_depth: 0,
            agent_config: Arc::new(cfg),
            session_db: db,
            connected_providers: connected,
        },
        Arc::new(ScriptedExecutor),
        Arc::new(move |method, payload| {
            sink.lock().push((method.to_owned(), payload));
        }),
    ));
    (control, events)
}

fn last_wait_event(events: &Events) -> Value {
    events
        .lock()
        .iter()
        .rev()
        .find(|(m, _)| m == "cowork/session/agentWaitResult")
        .map(|(_, p)| p.clone())
        .expect("agentWaitResult emitted")
}

#[tokio::test]
async fn errored_only_child_is_ready_and_flagged_errored() {
    let (control, events) = control("errored").await;
    let child = control
        .spawn(spawn_req("FAIL_ME now"), &[], &[], None)
        .await
        .unwrap();
    let id = child.agent_id;

    let res = control
        .wait(
            std::slice::from_ref(&id),
            Some(5_000),
            Some("any"),
            false,
            false,
        )
        .await
        .unwrap();
    assert!(
        !res.timed_out,
        "an errored child is terminal and wakes the waiter"
    );
    assert_eq!(res.ready_agent_ids, vec![id.clone()]);
    assert_eq!(res.errored_agent_ids, vec![id.clone()]);

    let evt = last_wait_event(&events);
    assert_eq!(evt["timedOut"], false);
    assert_eq!(evt["readyAgentIds"], serde_json::json!([id.clone()]));
    assert_eq!(evt["erroredAgentIds"], serde_json::json!([id]));
}

#[tokio::test]
async fn mixed_completed_and_errored_children_are_all_ready() {
    let (control, _events) = control("mixed").await;
    let ok = control
        .spawn(spawn_req("succeed please"), &[], &[], None)
        .await
        .unwrap()
        .agent_id;
    let bad = control
        .spawn(spawn_req("FAIL_ME please"), &[], &[], None)
        .await
        .unwrap()
        .agent_id;

    let ids = vec![ok.clone(), bad.clone()];
    let res = control
        .wait(&ids, Some(5_000), Some("all"), false, false)
        .await
        .unwrap();
    assert!(!res.timed_out);
    assert_eq!(
        res.ready_agent_ids, ids,
        "readyAgentIds keeps request order"
    );
    assert_eq!(res.errored_agent_ids, vec![bad]);
}

#[tokio::test]
async fn closed_child_is_ready_but_not_errored() {
    let (control, _events) = control("closed").await;
    let id = control
        .spawn(spawn_req("HOLD_ME until closed"), &[], &[], None)
        .await
        .unwrap()
        .agent_id;

    let waiter = {
        let control = Arc::clone(&control);
        let id = id.clone();
        tokio::spawn(async move {
            control
                .wait(&[id], Some(5_000), Some("any"), false, false)
                .await
        })
    };
    control.close(&id).await.unwrap();

    let res = waiter.await.unwrap().unwrap();
    assert!(
        !res.timed_out,
        "a closed child is terminal and wakes the waiter"
    );
    assert_eq!(res.ready_agent_ids, vec![id]);
    assert!(res.errored_agent_ids.is_empty());
}

#[tokio::test]
async fn timed_out_wait_reports_no_ready_children() {
    let (control, _events) = control("timeout").await;
    let id = control
        .spawn(spawn_req("HOLD_ME forever"), &[], &[], None)
        .await
        .unwrap()
        .agent_id;
    let res = control
        .wait(
            std::slice::from_ref(&id),
            Some(50),
            Some("any"),
            false,
            false,
        )
        .await
        .unwrap();
    assert!(res.timed_out);
    assert!(res.ready_agent_ids.is_empty());
    assert!(res.errored_agent_ids.is_empty());
    control.close(&id).await.unwrap();
}
