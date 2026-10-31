use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use cowork_config::ProviderName;
use cowork_harness::{
    HarnessEventSink, InteractionManager, MemoryGenerator, SteerCoordinator,
    SystemPromptBuildOptions, TurnIdempotencyLedger, TurnRunConfig, TurnStepRunner,
    build_layered_system_prompt, generate_heuristic_session_title, generate_remote_session_title,
    materialize_turn_attachments, resolve_turn_mentions,
};
use cowork_inference::{
    BudgetThresholds, CanonicalMessage, ContentBlock, MessageRole, ProviderContinuationState,
    ProviderOpaqueMeta, ProviderTransportError, SessionCostTracker, StepBudget, StopReason,
    StreamEvent, TurnUsage,
};
use cowork_protocol::TurnInput;
use cowork_providers::{
    ProviderStepRequest, ProviderStepResult, ProviderTransport, StreamEventCallback,
};
use cowork_storage::{MemoryScope, MemoryStore, SessionTitleSource};
use cowork_tools::{ASK_SKIP_TOKEN, ToolExecutionContext, discover_skills};
use parking_lot::Mutex;
use serde_json::{Value, json};
use uuid::Uuid;

fn isolated_dirs(prefix: &str) -> (PathBuf, PathBuf) {
    let root = PathBuf::from(format!(
        "/private/tmp/cowork-harness-{prefix}-{}",
        Uuid::new_v4()
    ));
    let home = root.join("home");
    let ws = root.join("workspace");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&ws).unwrap();
    (
        fs::canonicalize(home).unwrap(),
        fs::canonicalize(ws).unwrap(),
    )
}

#[derive(Default)]
struct RecordingSink {
    notifications: Mutex<Vec<(String, Value)>>,
    server_requests: Mutex<Vec<(String, String, Value)>>,
}

impl HarnessEventSink for RecordingSink {
    fn send_notification(&self, method: &str, params: Value) {
        self.notifications.lock().push((method.to_owned(), params));
    }

    fn send_server_request(&self, request_id: &str, method: &str, params: Value) {
        self.server_requests
            .lock()
            .push((request_id.to_owned(), method.to_owned(), params));
    }
}

type ScriptedStepFn = Box<
    dyn FnOnce(
            ProviderStepRequest,
            &mut dyn FnMut(StreamEvent),
        ) -> Result<ProviderStepResult, ProviderTransportError>
        + Send,
>;

struct ScriptedTransport {
    step_counter: AtomicUsize,
    steps: Mutex<Vec<ScriptedStepFn>>,
}

impl ScriptedTransport {
    fn new(steps: Vec<ScriptedStepFn>) -> Self {
        Self {
            step_counter: AtomicUsize::new(0),
            steps: Mutex::new(steps),
        }
    }
}

#[async_trait]
impl ProviderTransport for ScriptedTransport {
    async fn stream_step(
        &self,
        req: ProviderStepRequest,
        budget: &StepBudget,
        on_event: &mut StreamEventCallback<'_>,
    ) -> Result<ProviderStepResult, ProviderTransportError> {
        if budget.cancellation_token().is_cancelled() {
            return Err(ProviderTransportError::aborted("aborted"));
        }
        self.step_counter.fetch_add(1, Ordering::SeqCst);
        let handler = {
            let mut guard = self.steps.lock();
            if guard.is_empty() {
                return Err(ProviderTransportError::protocol(
                    "no scripted steps remaining",
                ));
            }
            guard.remove(0)
        };
        handler(req, on_event)
    }
}

fn assistant_msg(blocks: Vec<ContentBlock>) -> CanonicalMessage {
    CanonicalMessage {
        id: Uuid::new_v4().to_string(),
        role: MessageRole::Assistant,
        content: blocks,
        phase: None,
        provider: Some("openai".to_owned()),
        api: None,
        model: Some("gpt-5.4".to_owned()),
        stop_reason: Some(StopReason::Stop),
        provider_meta: ProviderOpaqueMeta::default(),
        created_at: "2026-10-30T12:00:00.000Z".to_owned(),
    }
}

#[test]
fn layered_system_prompt_assembles_agents_claude_workspace_map_skills_and_mentions() {
    let (home, ws) = isolated_dirs("prompt");
    let cowork_home = home.join(".cowork");

    fs::write(ws.join("AGENTS.md"), "Always follow AGENTS instructions.\n").unwrap();
    fs::write(ws.join("CLAUDE.md"), "Also honor CLAUDE guidelines.\n").unwrap();
    fs::create_dir_all(ws.join("src")).unwrap();
    fs::write(ws.join("src/main.rs"), "fn main() {}\n").unwrap();

    // Skill + Plugin
    let skill_dir = ws.join(".cowork/skills/lint-helper");
    fs::create_dir_all(&skill_dir).unwrap();
    fs::write(
        skill_dir.join("SKILL.md"),
        "---\nname: lint-helper\ndescription: Run workspace lints\n---\nUse `cargo clippy`.\n",
    )
    .unwrap();

    let plugin_dir = cowork_home.join("plugins/github-sync");
    fs::create_dir_all(&plugin_dir).unwrap();
    fs::write(plugin_dir.join("PLUGIN.md"), "Plugin docs for github-sync.").unwrap();

    let skills = discover_skills(None, &cowork_home, &ws);
    let mentions = resolve_turn_mentions(
        "Please run @lint-helper and configure @github-sync now",
        &skills,
        &cowork_home,
        &ws,
    );
    assert_eq!(mentions.injected_skill_blocks.len(), 1);
    assert!(mentions.injected_skill_blocks[0].contains("cargo clippy"));
    assert_eq!(mentions.referenced_plugins.len(), 1);
    assert_eq!(mentions.referenced_plugins[0].0, "github-sync");

    let prompt = build_layered_system_prompt(&SystemPromptBuildOptions {
        prompts_dir: None,
        prompt_template: None,
        working_directory: ws.clone(),
        output_directory: ws.join("output"),
        uploads_directory: ws.join("uploads"),
        cowork_home: cowork_home.clone(),
        provider: ProviderName::Openai,
        model: "gpt-5.4".to_owned(),
        sandbox_mode_label: "workspace-write".to_owned(),
        network_enabled: true,
        available_skills: skills,
        memory_section: Some("Remember: zero warnings.".to_owned()),
        workspace_context: Some(json!({ "activeFile": "src/main.rs" })),
        harness_context: Some(json!({ "locale": "en-US" })),
        referenced_plugins: mentions.referenced_plugins,
        deferred_tool_search_enabled: true,
    });

    assert!(prompt.contains("Always follow AGENTS instructions."));
    assert!(prompt.contains("Also honor CLAUDE guidelines."));
    assert!(prompt.contains("## Workspace Map"));
    assert!(prompt.contains("src/"));
    assert!(prompt.contains("## Skill Loading Policy"));
    assert!(prompt.contains("## Shell Execution Policy"));
    assert!(prompt.contains("lint-helper"));
    assert!(prompt.contains("Remember: zero warnings."));
    assert!(prompt.contains("## Active Workspace Context"));
    assert!(prompt.contains("## Active Harness Context"));
    assert!(prompt.contains("## Referenced Plugins"));
    assert!(prompt.contains("Plugin docs for github-sync."));
    assert!(prompt.contains("toolSearch"));

    let _ = fs::remove_dir_all(ws.parent().unwrap());
}

#[test]
fn idempotency_ledger_and_multimodal_attachments_stage_and_rollback_cleanly() {
    let (_home, ws) = isolated_dirs("attach");
    let uploads = ws.join("uploads");
    fs::create_dir_all(&uploads).unwrap();

    // 1. Idempotency ledger + journal hydration
    let ledger = TurnIdempotencyLedger::new();
    ledger.hydrate_from_journal_payload(&json!({
        "clientMessageId": "msg-hydrated",
        "turnId": "turn-001",
        "payloadFingerprint": TurnIdempotencyLedger::fingerprint_input("hello", &[])
    }));
    let dup = ledger
        .check_or_record("msg-hydrated", "turn-999", "hello", &[])
        .unwrap();
    assert_eq!(dup.turn_id, "turn-001");
    assert!(dup.was_duplicate);

    let conflict = ledger.check_or_record("msg-hydrated", "turn-999", "different text", &[]);
    assert!(
        conflict.is_err(),
        "reused clientMessageId with different text must conflict"
    );

    // 2. Inline PNG + PDF attachments materialize into `uploads/User Uploads/`
    let png_b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4//8/AwAI/AL+X6ixAAAAAElFTkSuQmCC";
    let input = TurnInput::Parts(vec![
        json!({ "type": "text", "text": "Inspect this image" }),
        json!({
            "type": "file",
            "filename": "chart.png",
            "mimeType": "image/png",
            "contentBase64": png_b64
        }),
    ]);
    let extracted = input.extract_payload().unwrap();
    let materialized = materialize_turn_attachments(&extracted, &uploads, &ws).unwrap();
    assert_eq!(materialized.staged_files.len(), 1);
    assert!(materialized.staged_files[0].exists());
    assert!(materialized.staged_files[0].starts_with(uploads.join("User Uploads")));
    assert!(
        materialized
            .content_blocks
            .iter()
            .any(|b| matches!(b, ContentBlock::Media { .. }))
    );

    // Rollback cleans staged files if pre-turn validation aborts
    let staged_path = materialized.staged_files[0].clone();
    materialized.rollback();
    assert!(!staged_path.exists());

    let _ = fs::remove_dir_all(ws.parent().unwrap());
}

#[tokio::test]
async fn turn_step_runner_drives_multi_step_tools_mid_turn_steer_deferred_search_and_cost_budget() {
    let (home, ws) = isolated_dirs("runner");
    fs::write(ws.join("target.txt"), "secret-value-42\n").unwrap();

    let sink = Arc::new(RecordingSink::default());
    let interactions = Arc::new(InteractionManager::new("thread-1", sink.clone()));
    let steer = Arc::new(SteerCoordinator::new(
        "thread-1",
        "turn-1",
        sink.clone(),
        None,
    ));

    // Queue a steer message before step 2 so TurnStepRunner injects it at step boundary
    let steer_clone = Arc::clone(&steer);
    let transport = Arc::new(ScriptedTransport::new(vec![
        // Step 1: Model searches deferred catalog via `toolSearch`, then calls `read` via `toolCall`
        Box::new(move |req, emit| {
            // Initial deferred surface only exposes toolSearch + toolCall
            let names: Vec<&str> = req.tools.iter().map(|t| t.name.as_str()).collect();
            assert_eq!(names, vec!["toolSearch", "toolCall"]);

            let call_search_id = "call_s1".to_owned();
            let call_read_id = "call_r1".to_owned();
            emit(StreamEvent::ToolCallStart {
                turn_id: req.turn_id.clone(),
                key: call_search_id.clone(),
                name: "toolSearch".to_owned(),
                initial_args: None,
            });
            emit(StreamEvent::ToolCallEnd {
                turn_id: req.turn_id.clone(),
                key: call_search_id.clone(),
                name: "toolSearch".to_owned(),
                arguments: serde_json::from_value(json!({ "query": "read" })).unwrap(),
                input_digest: None,
                retry_of: None,
            });
            emit(StreamEvent::ToolCallStart {
                turn_id: req.turn_id.clone(),
                key: call_read_id.clone(),
                name: "toolCall".to_owned(),
                initial_args: None,
            });
            emit(StreamEvent::ToolCallEnd {
                turn_id: req.turn_id.clone(),
                key: call_read_id.clone(),
                name: "toolCall".to_owned(),
                arguments: serde_json::from_value(json!({
                    "name": "read",
                    "arguments": { "filePath": "target.txt" }
                }))
                .unwrap(),
                input_digest: None,
                retry_of: None,
            });

            // Queue mid-turn steer while tool execution is about to run!
            steer_clone
                .enqueue_steer(
                    "Also format output in uppercase!".to_owned(),
                    Some("steer-cid-1".to_owned()),
                )
                .unwrap();

            Ok(ProviderStepResult {
                assistant: assistant_msg(vec![
                    ContentBlock::ToolCall {
                        id: call_search_id,
                        name: "toolSearch".to_owned(),
                        arguments: serde_json::from_value(json!({ "query": "read" })).unwrap(),
                        partial_json: None,
                        provider_meta: ProviderOpaqueMeta::default(),
                    },
                    ContentBlock::ToolCall {
                        id: call_read_id,
                        name: "toolCall".to_owned(),
                        arguments: serde_json::from_value(json!({
                            "name": "read",
                            "arguments": { "filePath": "target.txt" }
                        }))
                        .unwrap(),
                        partial_json: None,
                        provider_meta: ProviderOpaqueMeta::default(),
                    },
                ]),
                persisted_assistant: None,
                usage: TurnUsage {
                    prompt_tokens: 1_000,
                    completion_tokens: 500,
                    total_tokens: 1_500,
                    ..Default::default()
                },
                continuation: Some(ProviderContinuationState::OpenAi {
                    model: "gpt-5.4".to_owned(),
                    response_id: "resp_step1".to_owned(),
                    updated_at: "2026-10-30T12:00:01Z".to_owned(),
                    request_fingerprint: String::new(),
                }),
                raw_events: Vec::new(),
            })
        }),
        // Step 2: Sees `read` dynamically activated in `req.tools`, sees tool result + injected steer message!
        Box::new(|req, emit| {
            let names: Vec<&str> = req.tools.iter().map(|t| t.name.as_str()).collect();
            assert!(
                names.contains(&"read"),
                "read tool should be dynamically activated after toolSearch: {names:?}"
            );
            let serialized_msgs = serde_json::to_string(&req.messages).unwrap();
            assert!(serialized_msgs.contains("secret-value-42"));
            assert!(serialized_msgs.contains("Also format output in uppercase!"));

            emit(StreamEvent::TextDelta {
                turn_id: req.turn_id.clone(),
                block_index: 0,
                delta: "SECRET-VALUE-42".to_owned(),
                phase: None,
            });
            Ok(ProviderStepResult {
                assistant: assistant_msg(vec![ContentBlock::Text {
                    text: "SECRET-VALUE-42".to_owned(),
                    phase: None,
                    citations: Vec::new(),
                    provider_meta: ProviderOpaqueMeta::default(),
                }]),
                persisted_assistant: None,
                usage: TurnUsage {
                    prompt_tokens: 1_200,
                    completion_tokens: 300,
                    total_tokens: 1_500,
                    ..Default::default()
                },
                continuation: None,
                raw_events: Vec::new(),
            })
        }),
    ]));

    let mut tool_ctx = ToolExecutionContext::new_for_tests(
        home.clone(),
        ws.clone(),
        ProviderName::Openai,
        "gpt-5.4",
    );
    tool_ctx.approval_handler = Some(interactions.clone());

    let mut cost_tracker = SessionCostTracker::new(
        "thread-1",
        Some(BudgetThresholds {
            warn_at_usd: Some(0.0001),
            stop_at_usd: Some(10.0),
        }),
    );

    let runner = TurnStepRunner::new(TurnRunConfig {
        thread_id: "thread-1".to_owned(),
        turn_id: "turn-1".to_owned(),
        provider: ProviderName::Openai,
        model_id: "gpt-5.4".to_owned(),
        base_url: None,
        api_key: Some("test-key".to_owned()),
        extra_headers: HashMap::new(),
        system_prompt: "Test system prompt".to_owned(),
        provider_options: Default::default(),
        deferred_tool_search: true,
        max_steps: 10,
        step_timeout_ms: 30_000,
        overflow_threshold_chars: Some(25_000),
        tool_retry_lineage: true,
        initial_user_message: None,
    });

    let initial_messages = vec![CanonicalMessage {
        id: "u1".to_owned(),
        role: MessageRole::User,
        content: vec![ContentBlock::Text {
            text: "Read target.txt".to_owned(),
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
        created_at: "2026-10-30T12:00:00Z".to_owned(),
    }];

    let outcome = runner
        .run_turn(
            transport,
            initial_messages,
            &mut tool_ctx,
            &interactions,
            &steer,
            &mut cost_tracker,
            None,
            sink.clone(),
        )
        .await;

    assert_eq!(outcome.status, "completed");
    assert_eq!(
        outcome.last_assistant_text.as_deref(),
        Some("SECRET-VALUE-42")
    );
    assert!(
        sink.notifications
            .lock()
            .iter()
            .any(|(m, _)| m == "cowork/session/steerAccepted"),
        "expected cowork/session/steerAccepted notification"
    );
    assert!(
        sink.notifications
            .lock()
            .iter()
            .any(|(m, p)| m == "turn/completed" && p["turn"]["status"] == "completed")
    );

    let _ = fs::remove_dir_all(ws.parent().unwrap());
}

#[tokio::test]
async fn turn_interrupt_kills_child_process_tree_and_interactions_emit_receipts_and_resolved() {
    let (home, ws) = isolated_dirs("interrupt");
    let sink = Arc::new(RecordingSink::default());
    let interactions = Arc::new(InteractionManager::new("thread-int", sink.clone()));

    // 1. Test `requestUserInput` empty rejection, `ASK_SKIP_TOKEN`, receipt idempotency, and `-32602` conflict
    let im_ask = Arc::clone(&interactions);
    let ask_fut = tokio::spawn(async move {
        use cowork_tools::ApprovalHandler;
        im_ask.ask_user("Pick a deployment target", None).await
    });

    for _ in 0..50 {
        if !sink.server_requests.lock().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let req_id = sink.server_requests.lock()[0].0.clone();

    // Whitespace-only answer is rejected while keeping prompt alive
    let empty_err = interactions
        .resolve_client_response(&req_id, &json!({ "answer": "   " }))
        .unwrap_err();
    assert_eq!(empty_err.code, -32602);

    // Valid `[skipped]` answer resolves prompt and emits `serverRequest/resolved`
    let receipt1 = interactions
        .resolve_client_response(&req_id, &json!({ "answer": ASK_SKIP_TOKEN }))
        .unwrap();
    assert_eq!(receipt1["status"], json!("applied"));
    assert_eq!(ask_fut.await.unwrap().unwrap(), ASK_SKIP_TOKEN);

    // Duplicate identical response is idempotent
    let receipt2 = interactions
        .resolve_client_response(&req_id, &json!({ "answer": ASK_SKIP_TOKEN }))
        .unwrap();
    assert_eq!(receipt2["status"], json!("already_applied"));

    // Conflicting response for same requestId returns -32602
    let conflict_err = interactions
        .resolve_client_response(&req_id, &json!({ "answer": "different" }))
        .unwrap_err();
    assert_eq!(conflict_err.code, -32602);
    assert!(
        sink.notifications
            .lock()
            .iter()
            .any(|(m, p)| m == "serverRequest/resolved" && p["requestId"] == json!(req_id))
    );

    // 2. Test cascading `turn/interrupt` killing child `sleep` process tree & clearing continuation state
    let pid_file = ws.join("sleep_tree.pid");
    let pid_file_str = pid_file.to_string_lossy().into_owned();
    let steer = Arc::new(SteerCoordinator::new(
        "thread-int",
        "turn-int",
        sink.clone(),
        None,
    ));
    let transport = Arc::new(ScriptedTransport::new(vec![Box::new(
        move |_req, _emit| {
            Ok(ProviderStepResult {
                assistant: assistant_msg(vec![ContentBlock::ToolCall {
                    id: "call_bash_sleep".to_owned(),
                    name: "bash".to_owned(),
                    arguments: serde_json::from_value(json!({
                        "command": format!("sleep 120 & echo $! > '{pid_file_str}'; wait")
                    }))
                    .unwrap(),
                    partial_json: None,
                    provider_meta: ProviderOpaqueMeta::default(),
                }]),
                persisted_assistant: None,
                usage: TurnUsage::default(),
                continuation: Some(ProviderContinuationState::OpenAi {
                    model: "gpt-5.4".to_owned(),
                    response_id: "resp_should_be_cleared".to_owned(),
                    updated_at: "2026-10-30T12:00:00Z".to_owned(),
                    request_fingerprint: String::new(),
                }),
                raw_events: Vec::new(),
            })
        },
    )]));

    let mut tool_ctx = ToolExecutionContext::new_for_tests(
        home.clone(),
        ws.clone(),
        ProviderName::Openai,
        "gpt-5.4",
    );
    tool_ctx.yolo = true;
    tool_ctx.approval_handler = Some(interactions.clone());

    let runner = Arc::new(TurnStepRunner::new(TurnRunConfig {
        thread_id: "thread-int".to_owned(),
        turn_id: "turn-int".to_owned(),
        provider: ProviderName::Openai,
        model_id: "gpt-5.4".to_owned(),
        base_url: None,
        api_key: Some("test-key".to_owned()),
        extra_headers: HashMap::new(),
        system_prompt: "Test".to_owned(),
        provider_options: Default::default(),
        deferred_tool_search: false,
        max_steps: 5,
        step_timeout_ms: 30_000,
        overflow_threshold_chars: Some(25_000),
        tool_retry_lineage: false,
        initial_user_message: None,
    }));

    let cancel_handle = runner.cancellation_handle();
    let interactions_for_turn = Arc::clone(&interactions);
    let sink_for_turn = Arc::clone(&sink);
    let turn_task = tokio::spawn(async move {
        let mut cost = SessionCostTracker::new("thread-int", None);
        runner
            .run_turn(
                transport,
                vec![],
                &mut tool_ctx,
                &interactions_for_turn,
                &steer,
                &mut cost,
                None,
                sink_for_turn,
            )
            .await
    });

    for _ in 0..60 {
        if pid_file.exists()
            && !fs::read_to_string(&pid_file)
                .unwrap_or_default()
                .trim()
                .is_empty()
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let child_pid: i32 = fs::read_to_string(&pid_file)
        .unwrap()
        .trim()
        .parse()
        .unwrap();

    cancel_handle.interrupt("user_interrupted");
    let outcome = turn_task.await.unwrap();
    assert_eq!(outcome.status, "interrupted");
    assert!(
        outcome.updated_continuation.is_none(),
        "cancelled/interrupted turn MUST clear continuation state"
    );

    let mut alive = true;
    for _ in 0..30 {
        if unsafe { libc::kill(child_pid, 0) } != 0 {
            alive = false;
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    if alive {
        unsafe {
            let _ = libc::kill(child_pid, libc::SIGKILL);
        }
    }
    assert!(
        !alive,
        "child sleep process {child_pid} must be killed on turn/interrupt"
    );

    // 3. Title generator & MemoryGenerator
    let heuristic = generate_heuristic_session_title(
        "```rust\nfn main() {}\n```\nFix race condition in WebSocket reconnect handler",
    );
    assert!(!heuristic.is_empty() && heuristic.len() <= 60);

    let manual_preserved = generate_remote_session_title(
        SessionTitleSource::Manual,
        "My Custom Title",
        "Fix race condition",
        None,
    )
    .await;
    assert_eq!(manual_preserved.0, "My Custom Title");
    assert_eq!(manual_preserved.1, SessionTitleSource::Manual);

    let mem_store = MemoryStore::new(
        ws.join(".cowork/memory.sqlite"),
        home.join(".cowork/memory.sqlite"),
    );
    let mem_gen = MemoryGenerator::new();
    let messages_json = vec![
        json!({ "role": "user", "content": [{ "type": "text", "text": "Remember: always use bun run test in this repo." }] }),
        json!({ "role": "assistant", "content": [{ "type": "text", "text": "Noted, we will use bun run test." }] }),
    ];
    let new_cursor = mem_gen
        .maybe_generate_from_transcript(&messages_json, 0, Some(&mem_store), None, None)
        .await
        .unwrap();
    assert_eq!(new_cursor, 2);
    let saved = mem_store.list(Some(MemoryScope::Workspace)).unwrap();
    assert!(!saved.is_empty());

    let _ = fs::remove_dir_all(ws.parent().unwrap());
}
