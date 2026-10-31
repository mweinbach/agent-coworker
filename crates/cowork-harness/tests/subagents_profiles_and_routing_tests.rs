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
    AgentProfileUpsertInput, AgentProfilesStore, AgentSpawnRequest, ChildTurnExecutor,
    ChildTurnInput, ChildTurnResult, MAX_ACTIVE_CHILDREN_PER_PARENT, MAX_SPAWN_DEPTH,
    inspect_child_agent_report, resolve_child_model_selection,
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

async fn setup_env(tag: &str) -> (PathBuf, cowork_config::AgentConfig, Arc<SessionDb>) {
    let base = PathBuf::from(format!(
        "/private/tmp/cowork-agents-{tag}-{}",
        Uuid::new_v4()
    ));
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
        async fn run_child_turn(&self, input: ChildTurnInput) -> Result<ChildTurnResult, String> {
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
                        return Err("interrupted".to_owned());
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
