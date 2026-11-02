use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use cowork_config::{ChildModelRoutingMode, LoadConfigOptions, ProviderName, load_config};
use cowork_harness::agents::{
    AgentControl, AgentControlConfig, AgentProfileDefinition, AgentProfileScope,
    AgentProfileUpsertInput, AgentProfilesStore, AgentSpawnRequest, ChildTurnError,
    ChildTurnExecutor, ChildTurnInput, ChildTurnResult, MAX_ACTIVE_CHILDREN_PER_PARENT,
    MAX_SPAWN_DEPTH, inspect_child_agent_report, resolve_child_model_selection,
};
use cowork_inference::{
    CanonicalMessage, ContentBlock, MessageRole, ProviderOpaqueMeta, TurnUsage,
};
use cowork_storage::{SessionDb, SessionDbOptions};
use cowork_tools::{AgentControlBridge, ToolExecutionContext, create_builtin_tools};
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio::sync::Notify;
use uuid::Uuid;

/// Per-test scratch base: the canonical `/private/tmp` Seatbelt scratch root on macOS, the
/// platform temp dir (`/tmp` on Linux) elsewhere.
fn test_temp_base() -> PathBuf {
    if cfg!(target_os = "macos") {
        PathBuf::from("/private/tmp")
    } else {
        std::env::temp_dir()
    }
}

async fn setup_env(tag: &str) -> (PathBuf, cowork_config::AgentConfig, Arc<SessionDb>) {
    let base = test_temp_base().join(format!("cowork-agents-{tag}-{}", Uuid::new_v4()));
    let home = base.join("home");
    let ws = base.join("ws");
    let builtin = base.join("builtin");
    fs::create_dir_all(home.join(".cowork/config")).unwrap();
    fs::create_dir_all(ws.join("src")).unwrap();
    fs::create_dir_all(ws.join("other")).unwrap();
    fs::create_dir_all(builtin.join("skills/helper")).unwrap();
    fs::write(
        builtin.join("skills/helper/SKILL.md"),
        "---\nname: helper\ndescription: Bundled helper\n---\nHelper instructions.\n",
    )
    .unwrap();
    fs::write(ws.join("src/allowed.rs"), "pub fn ok() {}\n").unwrap();
    fs::write(ws.join("other/secret.rs"), "pub fn nope() {}\n").unwrap();

    let mut env = HashMap::new();
    env.insert("HOME".to_owned(), home.to_string_lossy().into_owned());
    env.insert(
        "COWORK_HOME_OVERRIDE".to_owned(),
        home.join(".cowork").to_string_lossy().into_owned(),
    );
    env.insert("COWORK_DISABLE_RUNTIME".to_owned(), "1".to_owned());
    env.insert("COWORK_RUNTIME_ALLOW_NETWORK".to_owned(), "0".to_owned());

    let cfg = load_config(LoadConfigOptions {
        cwd: Some(ws.clone()),
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

#[test]
fn parses_agent_report_strictly_and_falls_back_for_legacy_json() {
    // 1. Valid `<agent_report>` (extracts last block if multiple appear)
    let text = r#"Here is my investigation.
<agent_report>
{"status":"blocked","summary":"earlier draft"}
</agent_report>
Final report:
<agent_report>
{
  "status": "completed",
  "summary": "Implemented OAuth PKCE and verified tests.",
  "filesChanged": ["crates/cowork-mcp/src/oauth.rs"],
  "filesRead": ["src/mcp/oauth.ts"],
  "verification": [{ "command": "cargo test -p cowork-mcp", "outcome": "passed" }],
  "residualRisks": ["None"]
}
</agent_report>"#;

    let res = inspect_child_agent_report(Some(text), true);
    assert!(res.report_found);
    assert!(res.report_valid);
    assert_eq!(res.report_block_count, 2);
    let parsed = res.parsed_report.unwrap();
    assert_eq!(parsed.status, "completed");
    assert_eq!(
        parsed.files_changed,
        Some(vec!["crates/cowork-mcp/src/oauth.rs".to_owned()])
    );

    // 2. Rejects unknown fields (`additionalProperties: false`) inside `<agent_report>`
    let bad = r#"Done.
<agent_report>
{"status":"completed","summary":"ok","unexpectedField":123}
</agent_report>"#;
    let bad_res = inspect_child_agent_report(Some(bad), true);
    assert!(bad_res.report_found);
    assert!(!bad_res.report_valid);
    assert!(bad_res.parsed_report.is_none());
    assert!(
        bad_res
            .report_diagnostic
            .unwrap()
            .contains("unexpectedField")
    );

    // 3. Legacy fenced JSON fallback when no `<agent_report>` tag is present
    let legacy =
        "Completed work:\n```json\n{\"status\":\"completed\",\"summary\":\"Legacy JSON ok\"}\n```";
    let leg_res = inspect_child_agent_report(Some(legacy), false);
    assert!(!leg_res.report_found);
    assert!(leg_res.report_valid);
    assert_eq!(leg_res.parsed_report.unwrap().summary, "Legacy JSON ok");
    assert_eq!(
        leg_res.report_diagnostic.as_deref(),
        Some("Parsed legacy report without an <agent_report> footer.")
    );
}

#[test]
fn enforces_cross_provider_child_model_routing_and_layered_agent_profiles() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    let (base, mut cfg, _db) = rt.block_on(setup_env("routing_profiles"));
    cfg.provider = ProviderName::Openai;
    cfg.model = "gpt-5.4".to_owned();
    cfg.child_model_routing_mode = ChildModelRoutingMode::SameProvider;
    cfg.preferred_child_model_ref = "anthropic:claude-sonnet-4-6".to_owned();

    let mut connected = BTreeSet::new();
    connected.insert(ProviderName::Openai);

    // 1. Omitted `model` inherits parent provider + model (ignoring preferredChildModelRef UI hint)
    let inherited = resolve_child_model_selection(
        &cfg,
        ProviderName::Openai,
        "gpt-5.4",
        None,
        None,
        &connected,
    )
    .unwrap();
    assert_eq!(inherited.provider, ProviderName::Openai);
    assert_eq!(inherited.model_id, "gpt-5.4");

    // 2. Cross-provider ref rejected when `SameProviderOnly`
    let denied_mode = resolve_child_model_selection(
        &cfg,
        ProviderName::Openai,
        "gpt-5.4",
        Some("anthropic:claude-sonnet-4-6"),
        None,
        &connected,
    );
    assert!(denied_mode.is_err());

    // 3. Cross-provider ref rejected when allowlisted mode is enabled but not in `allowed_child_model_refs`
    cfg.child_model_routing_mode = ChildModelRoutingMode::CrossProviderAllowlist;
    cfg.allowed_child_model_refs = vec!["anthropic:claude-sonnet-4-6".to_owned()];
    let denied_unlisted = resolve_child_model_selection(
        &cfg,
        ProviderName::Openai,
        "gpt-5.4",
        Some("google:gemini-2.5-pro"),
        None,
        &connected,
    );
    assert!(denied_unlisted.is_err());

    // 4. Cross-provider ref rejected when allowlisted but target provider is not authenticated!
    let denied_unauthed = resolve_child_model_selection(
        &cfg,
        ProviderName::Openai,
        "gpt-5.4",
        Some("anthropic:claude-sonnet-4-6"),
        None,
        &connected,
    );
    assert!(denied_unauthed.is_err());

    // 5. Succeeds once Anthropic is connected AND ref is allowlisted!
    connected.insert(ProviderName::Anthropic);
    let ok_cross = resolve_child_model_selection(
        &cfg,
        ProviderName::Openai,
        "gpt-5.4",
        Some("anthropic:claude-sonnet-4-6"),
        Some("high"),
        &connected,
    )
    .unwrap();
    assert_eq!(ok_cross.provider, ProviderName::Anthropic);
    assert_eq!(ok_cross.model_id, "claude-sonnet-4-6");

    // 6. Layered `AgentProfilesStore`: global + workspace shadowing + workspace availability toggle
    let store = AgentProfilesStore::new(&cfg.user_cowork_dir, &cfg.working_directory);
    store
        .upsert(AgentProfileUpsertInput {
            scope: AgentProfileScope::Global,
            profile: AgentProfileDefinition {
                version: 1,
                id: "sec-auditor".to_owned(),
                display_name: "Global Sec Auditor".to_owned(),
                description: "Global auditor".to_owned(),
                enabled: true,
                base_role: "explorer".to_owned(),
                prompt: "Audit carefully.".to_owned(),
                // Attempt to escalate `write` on a read-only `explorer` baseRole!
                allowed_built_in_tools: vec!["read".to_owned(), "write".to_owned()],
                allowed_mcp_servers: Vec::new(),
                skill_names: vec!["helper".to_owned()],
                model: None,
                reasoning_effort: None,
                default_task_type: None,
                default_context_mode: None,
            },
        })
        .unwrap();

    // Disable global profile for this workspace, verify resolution blocks bare ref, then re-enable
    store
        .set_workspace_availability("sec-auditor", false)
        .unwrap();
    assert!(store.resolve_profile("sec-auditor").is_err());
    store
        .set_workspace_availability("sec-auditor", true)
        .unwrap();
    let snap = store.resolve_profile("sec-auditor").unwrap();
    assert_eq!(snap.base_role, "explorer");

    // Workspace copy shadows global profile on bare ref `"sec-auditor"`
    store
        .copy_profile(
            "global:sec-auditor",
            AgentProfileScope::Workspace,
            Some("sec-auditor"),
            Some("Workspace Sec Auditor"),
        )
        .unwrap();
    let shadowed = store.resolve_profile("sec-auditor").unwrap();
    assert_eq!(shadowed.scope, AgentProfileScope::Workspace);
    assert_eq!(shadowed.display_name, "Workspace Sec Auditor");

    let _ = fs::remove_dir_all(&base);
}

#[tokio::test]
async fn enforces_atomic_16_child_cap_max_depth_1_context_modes_target_paths_and_steer() {
    let (base, cfg, db) = setup_env("cap_depth_ctx").await;

    struct MockExecutor {
        hold_gate: Arc<Notify>,
        active_now: AtomicUsize,
        peak_active: AtomicUsize,
        recorded_inputs: Mutex<Vec<ChildTurnInput>>,
    }

    #[async_trait]
    impl ChildTurnExecutor for MockExecutor {
        async fn run_child_turn(
            &self,
            input: ChildTurnInput,
        ) -> Result<ChildTurnResult, ChildTurnError> {
            let cur = self.active_now.fetch_add(1, Ordering::SeqCst) + 1;
            self.peak_active.fetch_max(cur, Ordering::SeqCst);
            self.recorded_inputs.lock().push(input.clone());

            if input.prompt.contains("HOLD_SLOT") {
                tokio::select! {
                    _ = self.hold_gate.notified() => {}
                    _ = async {
                        while !input.cancel_token.is_cancelled() {
                            tokio::time::sleep(Duration::from_millis(10)).await;
                        }
                    } => {
                        self.active_now.fetch_sub(1, Ordering::SeqCst);
                        return Err("interrupted".into());
                    }
                }
            }

            self.active_now.fetch_sub(1, Ordering::SeqCst);
            let final_text = format!(
                "Handled: {}\n<agent_report>\n{{\"status\":\"completed\",\"summary\":\"done {}\"}}\n</agent_report>",
                input.prompt, input.agent_id
            );
            let mut messages = input.initial_messages;
            messages.push(CanonicalMessage {
                id: Uuid::new_v4().to_string(),
                role: MessageRole::User,
                content: vec![ContentBlock::Text {
                    text: input.prompt,
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
            messages.push(CanonicalMessage {
                id: Uuid::new_v4().to_string(),
                role: MessageRole::Assistant,
                content: vec![ContentBlock::Text {
                    text: final_text.clone(),
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
                created_at: "2026-01-01T00:00:01Z".to_owned(),
            });

            Ok(ChildTurnResult {
                messages,
                latest_assistant_text: Some(final_text),
                usage: TurnUsage::default(),
            })
        }
    }

    let hold_gate = Arc::new(Notify::new());
    let executor = Arc::new(MockExecutor {
        hold_gate: Arc::clone(&hold_gate),
        active_now: AtomicUsize::new(0),
        peak_active: AtomicUsize::new(0),
        recorded_inputs: Mutex::new(Vec::new()),
    });

    let events_seen = Arc::new(Mutex::new(Vec::<(String, Value)>::new()));
    let events_clone = Arc::clone(&events_seen);

    let mut connected = BTreeSet::new();
    connected.insert(cfg.provider);

    let control = Arc::new(AgentControl::new(
        AgentControlConfig {
            parent_session_id: "root-session-1".to_owned(),
            parent_depth: 0,
            agent_config: Arc::new(cfg.clone()),
            session_db: Arc::clone(&db),
            connected_providers: connected.clone(),
        },
        executor.clone(),
        Arc::new(move |method, payload| {
            events_clone.lock().push((method.to_owned(), payload));
        }),
    ));

    // 1. Fire 20 concurrent spawns that hold active slots -> atomically admit exactly 16 and reject 4!
    let mut handles = Vec::new();
    for idx in 0..20 {
        let ctrl = Arc::clone(&control);
        handles.push(tokio::spawn(async move {
            ctrl.spawn(
                AgentSpawnRequest {
                    message: format!("HOLD_SLOT worker {idx}"),
                    role: Some("worker".to_owned()),
                    profile_ref: None,
                    model: None,
                    reasoning_effort: None,
                    nickname: Some(format!("w-{idx}")),
                    task_type: Some("implement".to_owned()),
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
        }));
    }

    let mut ok_ids = Vec::new();
    let mut err_msgs = Vec::new();
    for h in handles {
        match h.await.unwrap() {
            Ok(summary) => ok_ids.push(summary.agent_id),
            Err(e) => err_msgs.push(e),
        }
    }
    assert_eq!(ok_ids.len(), MAX_ACTIVE_CHILDREN_PER_PARENT);
    assert_eq!(err_msgs.len(), 4);
    assert!(
        executor.peak_active.load(Ordering::SeqCst) <= MAX_ACTIVE_CHILDREN_PER_PARENT,
        "peak active children must never exceed 16"
    );

    // Release all 16 held children and wait for `mode="all"` + `includeReport=true`!
    hold_gate.notify_waiters();
    let wait_res = control
        .wait(&ok_ids, Some(5_000), Some("all"), true, true)
        .await
        .unwrap();
    assert!(!wait_res.timed_out);
    assert_eq!(wait_res.ready_agent_ids.len(), 16);
    assert!(wait_res.errored_agent_ids.is_empty());
    assert_eq!(wait_res.inspections.as_ref().unwrap().len(), 16);
    assert!(
        wait_res.inspections.as_ref().unwrap()[0]
            .parsed_report
            .as_ref()
            .is_some_and(|r| r.status == "completed")
    );

    // 2. Verify `MAX_SPAWN_DEPTH = 1` blocks recursive grandchild spawns!
    assert_eq!(MAX_SPAWN_DEPTH, 1);
    let child_control = AgentControl::new(
        AgentControlConfig {
            parent_session_id: ok_ids[0].clone(),
            parent_depth: 1,
            agent_config: Arc::new(cfg.clone()),
            session_db: Arc::clone(&db),
            connected_providers: connected,
        },
        executor.clone(),
        Arc::new(|_, _| {}),
    );
    let depth_err = child_control
        .spawn(
            AgentSpawnRequest {
                message: "Try grandchild".to_owned(),
                role: None,
                profile_ref: None,
                model: None,
                reasoning_effort: None,
                nickname: None,
                task_type: None,
                target_paths: None,
                context_mode: None,
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
        .unwrap_err();
    assert!(depth_err.contains("exceeds the maximum spawn depth of 1"));

    // 3. Verify `contextMode: "brief"` (injects `Parent briefing:\n...`) and `contextMode: "full"` (clones parent history)!
    let parent_history = vec![CanonicalMessage {
        id: Uuid::new_v4().to_string(),
        role: MessageRole::User,
        content: vec![ContentBlock::Text {
            text: "Original user goal: migrate auth.".to_owned(),
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
    }];
    let brief_child = control
        .spawn(
            AgentSpawnRequest {
                message: "Audit token storage".to_owned(),
                role: Some("explorer".to_owned()),
                profile_ref: None,
                model: None,
                reasoning_effort: None,
                nickname: None,
                task_type: None,
                target_paths: None,
                context_mode: Some("brief".to_owned()),
                briefing: Some("Auth lives in crates/cowork-mcp/src/credentials.rs".to_owned()),
                include_parent_todos: false,
                include_harness_context: false,
                fork_context: false,
                system_prompt_suffix: None,
            },
            &parent_history,
            &[],
            None,
        )
        .await
        .unwrap();
    let full_child = control
        .spawn(
            AgentSpawnRequest {
                message: "Review full context".to_owned(),
                role: Some("reviewer".to_owned()),
                profile_ref: None,
                model: None,
                reasoning_effort: None,
                nickname: None,
                task_type: None,
                target_paths: None,
                context_mode: Some("full".to_owned()),
                briefing: None,
                include_parent_todos: true,
                include_harness_context: true,
                fork_context: false,
                system_prompt_suffix: None,
            },
            &parent_history,
            &[json!({"content":"Check tests","status":"pending","activeForm":"Checking tests"})],
            Some(&json!({"goal":"auth"})),
        )
        .await
        .unwrap();

    control
        .wait(
            &[brief_child.agent_id.clone(), full_child.agent_id.clone()],
            Some(5_000),
            Some("all"),
            false,
            false,
        )
        .await
        .unwrap();

    {
        let inputs = executor.recorded_inputs.lock();
        let brief_in = inputs
            .iter()
            .find(|i| i.agent_id == brief_child.agent_id)
            .unwrap();
        assert_eq!(brief_in.initial_messages.len(), 1);
        let ContentBlock::Text { ref text, .. } = brief_in.initial_messages[0].content[0] else {
            panic!("expected briefing text");
        };
        assert!(text.starts_with("Parent briefing:\nAuth lives in"));
        assert!(
            brief_in.read_only_role,
            "explorer role must enforce read_only_role"
        );

        let full_in = inputs
            .iter()
            .find(|i| i.agent_id == full_child.agent_id)
            .unwrap();
        assert_eq!(full_in.initial_messages.len(), 1);
        let ContentBlock::Text { ref text, .. } = full_in.initial_messages[0].content[0] else {
            panic!("expected cloned parent text");
        };
        assert!(text.contains("Original user goal: migrate auth."));
    }

    // 4. Verify `targetPaths` tool surface & confinement (`bash` withheld, external `skills/` readable, outside-target workspace read/write blocked)!
    let mut scoped_ctx = ToolExecutionContext::new_for_tests(
        cfg.user_cowork_dir.parent().unwrap().to_path_buf(),
        cfg.working_directory.clone(),
        cfg.provider,
        &cfg.model,
    );
    scoped_ctx.session_kind = cowork_storage::SessionKind::Agent;
    scoped_ctx.can_ask_user = false;
    scoped_ctx.read_roots = vec![cfg.built_in_dir.clone()];
    scoped_ctx.bundled_skills_dir = Some(cfg.built_in_dir.join("skills"));
    scoped_ctx.target_paths = Some(vec![cfg.working_directory.join("src")]);
    scoped_ctx.agent_control = Some(control.clone() as Arc<dyn AgentControlBridge>);

    let scoped_tools = create_builtin_tools(&scoped_ctx);
    assert!(
        !scoped_tools.contains_key("bash"),
        "targetPaths MUST withhold bash"
    );
    assert!(
        !scoped_tools.contains_key("AskUserQuestion"),
        "child subagents MUST withhold AskUserQuestion"
    );
    assert!(
        !scoped_tools.contains_key("spawnAgent"),
        "child subagents MUST withhold spawnAgent"
    );
    assert!(
        !scoped_tools.contains_key("memory"),
        "targetPaths MUST withhold memory tools"
    );

    // Allowed read inside `src/`
    let ok_read = scoped_tools
        .get("read")
        .unwrap()
        .execute(
            serde_json::from_value(json!({ "filePath": "src/allowed.rs" })).unwrap(),
            &scoped_ctx,
        )
        .await;
    assert!(ok_read.is_ok());

    // Blocked read inside workspace `other/secret.rs` (outside `targetPaths`)
    let denied_ws_read = scoped_tools
        .get("read")
        .unwrap()
        .execute(
            serde_json::from_value(json!({ "filePath": "other/secret.rs" })).unwrap(),
            &scoped_ctx,
        )
        .await;
    assert!(denied_ws_read.is_err());

    // Allowed external read of bundled `SKILL.md` (`projectPathsOnly: true`)!
    let external_skill_read = scoped_tools
        .get("read")
        .unwrap()
        .execute(
            serde_json::from_value(json!({
                "filePath": cfg.built_in_dir.join("skills/helper/SKILL.md").to_string_lossy()
            }))
            .unwrap(),
            &scoped_ctx,
        )
        .await;
    assert!(
        external_skill_read.is_ok(),
        "external read_roots (bundled skills) must remain readable under targetPaths"
    );

    // Blocked write outside `targetPaths`
    let denied_write = scoped_tools
        .get("write")
        .unwrap()
        .execute(
            serde_json::from_value(json!({
                "filePath": "other/hack.rs",
                "content": "nope"
            }))
            .unwrap(),
            &scoped_ctx,
        )
        .await;
    assert!(denied_write.is_err());

    // 5. Verify `close`, `resume`, and `send_input` (`interrupt: true`) lifecycle!
    let closed_summary = control.close(&brief_child.agent_id).await.unwrap();
    assert_eq!(closed_summary.lifecycle_state, "closed");
    assert_eq!(closed_summary.execution_state, "closed");

    let resumed = control.resume(&brief_child.agent_id).await.unwrap();
    assert_eq!(resumed.lifecycle_state, "active");

    control
        .send_input(&brief_child.agent_id, "Follow-up task", false)
        .await
        .unwrap();
    let after_followup = control
        .wait(
            std::slice::from_ref(&brief_child.agent_id),
            Some(5_000),
            Some("all"),
            true,
            false,
        )
        .await
        .unwrap();
    assert!(
        after_followup.inspections.unwrap()[0]
            .latest_assistant_text
            .as_deref()
            .unwrap()
            .contains("Follow-up task")
    );

    // Verify SQLite persistence via `SessionDb::list_agent_sessions`
    let persisted_children = db.list_agent_sessions("root-session-1").unwrap();
    assert_eq!(persisted_children.len(), 18);

    let _ = fs::remove_dir_all(&base);
}

/// Regression: child model ids resolve against the same catalog as the root session
/// (bundled registry + custom-model store + discovery cache), not only the bundled registry.
#[tokio::test]
async fn child_model_routing_accepts_user_custom_models_and_rejects_unknown_ids() {
    let (base, mut cfg, _db) = setup_env("custom_child_model").await;
    cfg.provider = ProviderName::Openai;
    cfg.model = "gpt-5.4".to_owned();
    let home = cfg.user_cowork_dir.parent().unwrap().to_path_buf();
    let paths = cowork_config::get_ai_coworker_paths(Some(&home), &HashMap::new());
    cowork_config::upsert_custom_model(&paths, ProviderName::Openai, "my-custom-model")
        .await
        .unwrap();
    let connected: BTreeSet<ProviderName> = [ProviderName::Openai].into_iter().collect();

    for requested in ["my-custom-model", "openai:my-custom-model"] {
        let sel = resolve_child_model_selection(
            &cfg,
            ProviderName::Openai,
            "gpt-5.4",
            Some(requested),
            None,
            &connected,
        )
        .unwrap_or_else(|e| panic!("{requested}: {e}"));
        assert_eq!(sel.provider, ProviderName::Openai);
        assert_eq!(sel.model_id, "my-custom-model");
    }

    assert!(
        resolve_child_model_selection(
            &cfg,
            ProviderName::Openai,
            "gpt-5.4",
            Some("definitely-not-a-model"),
            None,
            &connected,
        )
        .is_err()
    );

    let _ = fs::remove_dir_all(&base);
}

/// Regression: children rebuilt after a server restart keep their spawn-time targetPaths,
/// profile allowlists and transcript, and fail closed when the scope can't be restored.
#[tokio::test]
async fn restarted_children_keep_scope_and_transcript_and_fail_closed() {
    let (base, cfg, db) = setup_env("restart_scope").await;
    fs::create_dir_all(cfg.working_directory.join("scoped")).unwrap();

    AgentProfilesStore::new(&cfg.user_cowork_dir, &cfg.working_directory)
        .upsert(AgentProfileUpsertInput {
            scope: AgentProfileScope::Workspace,
            profile: AgentProfileDefinition {
                version: 1,
                id: "narrow".to_owned(),
                display_name: "Narrow".to_owned(),
                description: "Narrow worker".to_owned(),
                enabled: true,
                base_role: "worker".to_owned(),
                prompt: "Stay narrow.".to_owned(),
                allowed_built_in_tools: vec!["read".to_owned(), "grep".to_owned()],
                allowed_mcp_servers: vec!["mcp-a".to_owned()],
                skill_names: vec!["helper".to_owned()],
                model: None,
                reasoning_effort: None,
                default_task_type: None,
                default_context_mode: None,
            },
        })
        .unwrap();

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

    let connected: BTreeSet<ProviderName> = [cfg.provider].into_iter().collect();
    let make_control = |executor: Arc<EchoExecutor>| {
        AgentControl::new(
            AgentControlConfig {
                parent_session_id: "root-restart".to_owned(),
                parent_depth: 0,
                agent_config: Arc::new(cfg.clone()),
                session_db: Arc::clone(&db),
                connected_providers: connected.clone(),
            },
            executor,
            Arc::new(|_, _| {}),
        )
    };
    let spawn_req = |message: &str, target: &str| AgentSpawnRequest {
        message: message.to_owned(),
        role: None,
        profile_ref: Some("narrow".to_owned()),
        model: None,
        reasoning_effort: None,
        nickname: None,
        task_type: None,
        target_paths: Some(vec![target.to_owned()]),
        context_mode: Some("none".to_owned()),
        briefing: None,
        include_parent_todos: false,
        include_harness_context: false,
        fork_context: false,
        system_prompt_suffix: None,
    };

    let exec1 = Arc::new(EchoExecutor {
        inputs: Mutex::new(Vec::new()),
    });
    let control1 = make_control(Arc::clone(&exec1));
    let first_task = format!(
        "first task {}\n<agent_report>{{\"status\":\"completed\",\"summary\":\"Scoped review done\"}}</agent_report>",
        "x".repeat(250)
    );
    let a = control1
        .spawn(spawn_req(&first_task, "src"), &[], &[], None)
        .await
        .unwrap()
        .agent_id;
    let b = control1
        .spawn(spawn_req("scoped task", "scoped"), &[], &[], None)
        .await
        .unwrap()
        .agent_id;
    control1
        .wait(
            &[a.clone(), b.clone()],
            Some(5_000),
            Some("all"),
            false,
            false,
        )
        .await
        .unwrap();
    let spawn_input = exec1
        .inputs
        .lock()
        .iter()
        .find(|i| i.agent_id == a)
        .cloned()
        .unwrap();
    assert!(spawn_input.target_paths.is_some());
    drop(control1);

    // Simulate a server restart.
    let exec2 = Arc::new(EchoExecutor {
        inputs: Mutex::new(Vec::new()),
    });
    let control2 = make_control(Arc::clone(&exec2));
    let restored = control2.inspect(&a).unwrap();
    let expected_reply = format!("echo: {first_task}");
    assert_eq!(
        restored.latest_assistant_text.as_deref(),
        Some(expected_reply.as_str())
    );
    assert_eq!(
        restored.parsed_report.unwrap().summary,
        "Scoped review done"
    );
    assert_eq!(
        restored.agent.last_message_preview.unwrap().chars().count(),
        240
    );
    control2.send_input(&a, "second task", false).await.unwrap();
    control2
        .wait(
            std::slice::from_ref(&a),
            Some(5_000),
            Some("all"),
            false,
            false,
        )
        .await
        .unwrap();
    let resumed_input = exec2.inputs.lock()[0].clone();
    assert_eq!(resumed_input.target_paths, spawn_input.target_paths);
    assert_eq!(resumed_input.sandbox, spawn_input.sandbox);
    assert_eq!(
        resumed_input.allowed_builtin_tools,
        spawn_input.allowed_builtin_tools
    );
    assert_eq!(
        resumed_input.allowed_mcp_servers,
        spawn_input.allowed_mcp_servers
    );
    assert_eq!(
        resumed_input.allowed_skill_names,
        spawn_input.allowed_skill_names
    );
    assert_eq!(resumed_input.role_prompt, spawn_input.role_prompt);
    let history = serde_json::to_string(&resumed_input.initial_messages).unwrap();
    assert!(history.contains("echo: first task"), "{history}");

    control2.close(&a).await.unwrap();
    let stored =
        serde_json::to_string(&db.get_session_record(&a).unwrap().unwrap().messages).unwrap();
    assert!(stored.contains("echo: first task") && stored.contains("echo: second task"));

    // Child B's targetPaths now escape the workspace -> refuse to run rather than widen scope.
    #[cfg(unix)]
    {
        let outside = base.join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::remove_dir_all(cfg.working_directory.join("scoped")).unwrap();
        std::os::unix::fs::symlink(&outside, cfg.working_directory.join("scoped")).unwrap();
        let control3 = make_control(Arc::new(EchoExecutor {
            inputs: Mutex::new(Vec::new()),
        }));
        let err = control3.send_input(&b, "escape", false).await.unwrap_err();
        assert!(err.contains("cannot run after restart"), "{err}");
        // Closing never wipes the stored transcript.
        control3.close(&b).await.unwrap();
        let stored_b =
            serde_json::to_string(&db.get_session_record(&b).unwrap().unwrap().messages).unwrap();
        assert!(stored_b.contains("echo: scoped task"), "{stored_b}");
    }

    let _ = fs::remove_dir_all(&base);
}

/// Regression: a profile's empty `allowedMcpServers` / `skillNames` / `allowedBuiltInTools`
/// lists deny all (TS `filterToolsForProfile` parity); `None` is reserved for "no profile".
#[tokio::test]
async fn empty_profile_allowlists_deny_all_instead_of_granting_everything() {
    let (base, cfg, db) = setup_env("empty_allowlists").await;
    AgentProfilesStore::new(&cfg.user_cowork_dir, &cfg.working_directory)
        .upsert(AgentProfileUpsertInput {
            scope: AgentProfileScope::Workspace,
            profile: AgentProfileDefinition {
                version: 1,
                id: "locked".to_owned(),
                display_name: "Locked".to_owned(),
                description: "No tools".to_owned(),
                enabled: true,
                base_role: "worker".to_owned(),
                prompt: String::new(),
                allowed_built_in_tools: Vec::new(),
                allowed_mcp_servers: Vec::new(),
                skill_names: Vec::new(),
                model: None,
                reasoning_effort: None,
                default_task_type: None,
                default_context_mode: None,
            },
        })
        .unwrap();

    struct Recorder(Mutex<Vec<ChildTurnInput>>);
    #[async_trait]
    impl ChildTurnExecutor for Recorder {
        async fn run_child_turn(
            &self,
            input: ChildTurnInput,
        ) -> Result<ChildTurnResult, ChildTurnError> {
            self.0.lock().push(input.clone());
            Ok(ChildTurnResult {
                messages: input.initial_messages,
                latest_assistant_text: Some("done".to_owned()),
                usage: TurnUsage::default(),
            })
        }
    }
    let recorder = Arc::new(Recorder(Mutex::new(Vec::new())));
    let control = AgentControl::new(
        AgentControlConfig {
            parent_session_id: "root-empty-allowlists".to_owned(),
            parent_depth: 0,
            agent_config: Arc::new(cfg.clone()),
            session_db: Arc::clone(&db),
            connected_providers: [cfg.provider].into_iter().collect(),
        },
        recorder.clone(),
        Arc::new(|_, _| {}),
    );
    let mk = |profile_ref: Option<&str>| AgentSpawnRequest {
        message: "go".to_owned(),
        role: Some("worker".to_owned()),
        profile_ref: profile_ref.map(str::to_owned),
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
    };
    let locked = control
        .spawn(mk(Some("locked")), &[], &[], None)
        .await
        .unwrap()
        .agent_id;
    let plain = control
        .spawn(mk(None), &[], &[], None)
        .await
        .unwrap()
        .agent_id;
    control
        .wait(
            &[locked.clone(), plain.clone()],
            Some(5_000),
            Some("all"),
            false,
            false,
        )
        .await
        .unwrap();

    let inputs = recorder.0.lock().clone();
    let locked_in = inputs.iter().find(|i| i.agent_id == locked).unwrap();
    assert!(locked_in.allowed_builtin_tools.is_empty());
    assert_eq!(locked_in.allowed_mcp_servers, Some(BTreeSet::new()));
    assert_eq!(locked_in.allowed_skill_names, Some(BTreeSet::new()));
    let plain_in = inputs.iter().find(|i| i.agent_id == plain).unwrap();
    assert!(!plain_in.allowed_builtin_tools.is_empty());
    assert_eq!(plain_in.allowed_mcp_servers, None);
    assert_eq!(plain_in.allowed_skill_names, None);

    // Restart restoration uses the same semantics.
    drop(control);
    let recorder2 = Arc::new(Recorder(Mutex::new(Vec::new())));
    let control2 = AgentControl::new(
        AgentControlConfig {
            parent_session_id: "root-empty-allowlists".to_owned(),
            parent_depth: 0,
            agent_config: Arc::new(cfg.clone()),
            session_db: Arc::clone(&db),
            connected_providers: [cfg.provider].into_iter().collect(),
        },
        recorder2.clone(),
        Arc::new(|_, _| {}),
    );
    control2.send_input(&locked, "again", false).await.unwrap();
    control2
        .wait(
            std::slice::from_ref(&locked),
            Some(5_000),
            Some("all"),
            false,
            false,
        )
        .await
        .unwrap();
    let restored = recorder2.0.lock()[0].clone();
    assert!(restored.allowed_builtin_tools.is_empty());
    assert_eq!(restored.allowed_mcp_servers, Some(BTreeSet::new()));
    assert_eq!(restored.allowed_skill_names, Some(BTreeSet::new()));

    let _ = fs::remove_dir_all(&base);
}

/// `profileRef: "default"` without an explicit `contextMode` must inherit the parent's full
/// context (TS `buildBuiltInProfileEntries` gives the main-agent profile
/// `defaultContextMode: "full"`); other built-in profiles keep the `"none"` fallback.
#[tokio::test]
async fn default_profile_spawn_without_context_mode_inherits_full_parent_context() {
    let (base, cfg, db) = setup_env("default_profile_ctx").await;

    struct Recorder(Mutex<Vec<ChildTurnInput>>);
    #[async_trait]
    impl ChildTurnExecutor for Recorder {
        async fn run_child_turn(
            &self,
            input: ChildTurnInput,
        ) -> Result<ChildTurnResult, ChildTurnError> {
            self.0.lock().push(input.clone());
            Ok(ChildTurnResult {
                messages: input.initial_messages,
                latest_assistant_text: Some("done".to_owned()),
                usage: TurnUsage::default(),
            })
        }
    }
    let recorder = Arc::new(Recorder(Mutex::new(Vec::new())));
    let control = AgentControl::new(
        AgentControlConfig {
            parent_session_id: "root-default-profile-ctx".to_owned(),
            parent_depth: 0,
            agent_config: Arc::new(cfg.clone()),
            session_db: Arc::clone(&db),
            connected_providers: [cfg.provider].into_iter().collect(),
        },
        recorder.clone(),
        Arc::new(|_, _| {}),
    );
    let parent_history = vec![CanonicalMessage {
        id: Uuid::new_v4().to_string(),
        role: MessageRole::User,
        content: vec![ContentBlock::Text {
            text: "Parent goal: ship the rewrite.".to_owned(),
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
    }];
    let parent_todos =
        vec![json!({"content":"Run tests","status":"pending","activeForm":"Running tests"})];
    let parent_harness = json!({"goal":"rewrite"});
    let mk = |profile_ref: &str| AgentSpawnRequest {
        message: "go".to_owned(),
        role: None,
        profile_ref: Some(profile_ref.to_owned()),
        model: None,
        reasoning_effort: None,
        nickname: None,
        task_type: None,
        target_paths: None,
        context_mode: None,
        briefing: None,
        include_parent_todos: false,
        include_harness_context: false,
        fork_context: false,
        system_prompt_suffix: None,
    };

    let mut ids = Vec::new();
    for profile_ref in ["default", "global:default", "explorer", "worker"] {
        let summary = control
            .spawn(
                mk(profile_ref),
                &parent_history,
                &parent_todos,
                Some(&parent_harness),
            )
            .await
            .unwrap();
        ids.push((profile_ref, summary.agent_id));
    }
    let agent_ids: Vec<String> = ids.iter().map(|(_, id)| id.clone()).collect();
    control
        .wait(&agent_ids, Some(5_000), Some("all"), false, false)
        .await
        .unwrap();

    let inputs = recorder.0.lock().clone();
    for (profile_ref, agent_id) in &ids {
        let input = inputs.iter().find(|i| &i.agent_id == agent_id).unwrap();
        if profile_ref.ends_with("default") {
            assert_eq!(input.initial_messages.len(), 1, "{profile_ref}");
            let ContentBlock::Text { ref text, .. } = input.initial_messages[0].content[0] else {
                panic!("expected cloned parent text for {profile_ref}");
            };
            assert!(text.contains("Parent goal: ship the rewrite."));
            assert_eq!(input.todos, parent_todos, "{profile_ref}");
            assert_eq!(
                input.harness_context.as_ref(),
                Some(&parent_harness),
                "{profile_ref}"
            );
        } else {
            assert!(input.initial_messages.is_empty(), "{profile_ref}");
            assert!(input.todos.is_empty(), "{profile_ref}");
            assert_eq!(input.harness_context, None, "{profile_ref}");
        }
    }

    let _ = fs::remove_dir_all(&base);
}

/// Stop/deadline races (`race_with_cancel_and_deadline` in workflow host agents) drop the spawn
/// future while it awaits `persist_session_mutation`. The reserved slot must be released on drop,
/// otherwise later spawns lose capacity and `quiesce_children` waits for phantom children.
#[tokio::test]
async fn dropped_spawn_mid_persist_releases_its_reserved_slot() {
    let (base, cfg, db) = setup_env("spawn_drop_mid_persist").await;

    struct HoldUntilCancelled;
    #[async_trait]
    impl ChildTurnExecutor for HoldUntilCancelled {
        async fn run_child_turn(
            &self,
            input: ChildTurnInput,
        ) -> Result<ChildTurnResult, ChildTurnError> {
            input.cancel_token.cancelled().await;
            Err("interrupted".into())
        }
    }
    let control = AgentControl::new(
        AgentControlConfig {
            parent_session_id: "root-spawn-drop".to_owned(),
            parent_depth: 0,
            agent_config: Arc::new(cfg.clone()),
            session_db: Arc::clone(&db),
            connected_providers: [cfg.provider].into_iter().collect(),
        },
        Arc::new(HoldUntilCancelled),
        Arc::new(|_, _| {}),
    );
    let req = || AgentSpawnRequest {
        message: "go".to_owned(),
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
    };

    // Hold the session DB write lock so every spawn pends inside `persist_session_mutation`.
    let (held_tx, held_rx) = tokio::sync::oneshot::channel::<()>();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
    let holder_db = Arc::clone(&db);
    let holder = tokio::spawn(async move {
        holder_db
            .write_coordinator()
            .run_exclusive("test_hold_write_lock", || async move {
                let _ = held_tx.send(());
                let _ = release_rx.await;
                Ok(())
            })
            .await
    });
    held_rx.await.expect("write lock held");

    // Drop as many mid-persist spawns as there are slots; each would leak one reservation.
    for _ in 0..MAX_ACTIVE_CHILDREN_PER_PARENT {
        let outcome = tokio::time::timeout(
            Duration::from_millis(50),
            control.spawn(req(), &[], &[], None),
        )
        .await;
        assert!(outcome.is_err(), "spawn should pend on the held write lock");
    }
    assert!(control.list(true).is_empty());

    // No children and no live reservations: quiesce settles immediately instead of timing out.
    control
        .quiesce_children(Duration::from_millis(500))
        .await
        .expect("dropped spawns must not keep the parent busy");

    // A spawn that survives the same write lock must wake a concurrent quiesce as soon as it
    // installs a cancellable child. The executor cannot finish until quiesce cancels it.
    let mut spawning = Box::pin(control.spawn(req(), &[], &[], None));
    assert!(futures::poll!(&mut spawning).is_pending());
    let mut quiescing = Box::pin(control.quiesce_children(Duration::from_secs(5)));
    assert!(futures::poll!(&mut quiescing).is_pending());
    release_tx.send(()).unwrap();
    holder.await.unwrap().unwrap();
    let (spawned, quiesced) = tokio::join!(spawning, quiescing);
    let agent = spawned.unwrap();
    quiesced.expect("child installed during quiesce must be cancelled");
    assert!(!control.inspect(&agent.agent_id).unwrap().agent.busy);

    // Full capacity is available again.
    for _ in 0..MAX_ACTIVE_CHILDREN_PER_PARENT {
        control
            .spawn(req(), &[], &[], None)
            .await
            .expect("slot available after dropped spawns");
    }
    let err = control.spawn(req(), &[], &[], None).await.unwrap_err();
    assert!(err.contains("Maximum active child agents"), "{err}");

    control
        .quiesce_children(Duration::from_secs(5))
        .await
        .unwrap();
    let _ = fs::remove_dir_all(&base);
}
