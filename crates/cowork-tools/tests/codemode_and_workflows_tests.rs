use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use async_trait::async_trait;
use cowork_config::{AgentConfig, LoadConfigOptions, ProviderName, load_config};
use cowork_inference::{BudgetStatus, BudgetThresholds, SessionCostTracker};
use cowork_sandbox::SandboxPolicy;
use cowork_tools::{
    AgentControlBridge, BuiltinTool, CodeModeTool, CostTrackerBridge, DeferredToolCatalog,
    ToolError, ToolExecutionContext, WorkflowTool, assert_write_path_allowed, create_builtin_tools,
    upsert_retained_workflow_run,
};
use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use uuid::Uuid;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf()
}

fn isolated_dirs(prefix: &str) -> (PathBuf, PathBuf) {
    let base = PathBuf::from(format!(
        "/private/tmp/cowork-cm-wf-{prefix}-{}",
        Uuid::new_v4()
    ));
    let home = base.join("home");
    let ws = base.join("workspace");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&ws).unwrap();
    (
        fs::canonicalize(home).unwrap(),
        fs::canonicalize(ws).unwrap(),
    )
}

fn make_agent_config(home: &Path, ws: &Path, built_in_dir: &Path) -> AgentConfig {
    let mut cfg = load_config(LoadConfigOptions {
        cwd: Some(ws.to_path_buf()),
        homedir: Some(home.to_path_buf()),
        ..Default::default()
    })
    .unwrap();
    cfg.workflows_enabled = true;
    cfg.project_cowork_dir = ws.join(".cowork");
    cfg.user_cowork_dir = home.join(".cowork");
    cfg.built_in_dir = built_in_dir.to_path_buf();
    cfg.working_directory = ws.to_path_buf();
    cfg
}

struct SharedTestCostBridge {
    tracker: Mutex<SessionCostTracker>,
}

impl SharedTestCostBridge {
    fn new(budget: Option<BudgetThresholds>) -> Self {
        Self {
            tracker: Mutex::new(SessionCostTracker::new("test-session", budget)),
        }
    }

    fn total_spent(&self) -> f64 {
        self.tracker
            .lock()
            .get_snapshot()
            .estimated_total_cost_usd
            .unwrap_or(0.0)
    }
}

impl CostTrackerBridge for SharedTestCostBridge {
    fn get_budget_status(&self) -> BudgetStatus {
        self.tracker.lock().get_budget_status()
    }

    fn record_unattributed_cost(&self, usd_cost: f64) -> Result<(), String> {
        self.tracker
            .lock()
            .record_unattributed_cost(usd_cost)
            .map_err(|e| e.to_string())
    }
}

#[derive(Clone)]
struct MockChildState {
    prompt: String,
    nickname: Option<String>,
    system_prompt_suffix: Option<String>,
    target_paths: Option<Vec<String>>,
    latest_text: Option<String>,
    execution_state: String,
    usd_cost: f64,
    repair_turns: usize,
}

type AgentResponder =
    Arc<dyn Fn(&MockChildState, Option<&str>) -> Result<(String, f64), String> + Send + Sync>;

struct MockWorkflowAgentControl {
    children: Mutex<BTreeMap<String, MockChildState>>,
    spawn_calls: AtomicUsize,
    send_input_calls: AtomicUsize,
    close_calls: AtomicUsize,
    active_now: AtomicUsize,
    peak_active: AtomicUsize,
    responder: AgentResponder,
}

impl MockWorkflowAgentControl {
    fn new<F>(responder: F) -> Self
    where
        F: Fn(&MockChildState, Option<&str>) -> Result<(String, f64), String>
            + Send
            + Sync
            + 'static,
    {
        Self {
            children: Mutex::new(BTreeMap::new()),
            spawn_calls: AtomicUsize::new(0),
            send_input_calls: AtomicUsize::new(0),
            close_calls: AtomicUsize::new(0),
            active_now: AtomicUsize::new(0),
            peak_active: AtomicUsize::new(0),
            responder: Arc::new(responder),
        }
    }
}

#[async_trait]
impl AgentControlBridge for MockWorkflowAgentControl {
    async fn spawn_agent(&self, _parent_session_id: &str, args: Value) -> Result<Value, String> {
        self.spawn_calls.fetch_add(1, Ordering::SeqCst);
        let cur = self.active_now.fetch_add(1, Ordering::SeqCst) + 1;
        let _ = self.peak_active.fetch_max(cur, Ordering::SeqCst);
        tokio::time::sleep(std::time::Duration::from_millis(8)).await;

        let agent_id = format!("child-{}", Uuid::new_v4());
        let prompt = args
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let nickname = args
            .get("nickname")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let system_prompt_suffix = args
            .get("systemPromptSuffix")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let target_paths = args
            .get("targetPaths")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            });

        let mut child = MockChildState {
            prompt,
            nickname,
            system_prompt_suffix,
            target_paths,
            latest_text: None,
            execution_state: "running".to_owned(),
            usd_cost: 0.0,
            repair_turns: 0,
        };

        match (self.responder)(&child, None) {
            Ok((text, cost)) => {
                child.latest_text = Some(text);
                child.usd_cost = cost;
                child.execution_state = "completed".to_owned();
            }
            Err(err) => {
                if err.contains("task_locked") {
                    self.active_now.fetch_sub(1, Ordering::SeqCst);
                    return Err(err);
                }
                child.latest_text = Some(err);
                child.usd_cost = 0.05;
                child.execution_state = "errored".to_owned();
            }
        }
        self.active_now.fetch_sub(1, Ordering::SeqCst);
        self.children.lock().insert(agent_id.clone(), child);

        Ok(json!({ "agentId": agent_id }))
    }

    async fn list_agents(&self, _parent_session_id: &str, _args: Value) -> Result<Value, String> {
        Ok(json!({ "agents": [] }))
    }

    async fn send_agent_input(
        &self,
        _parent_session_id: &str,
        args: Value,
    ) -> Result<Value, String> {
        self.send_input_calls.fetch_add(1, Ordering::SeqCst);
        let agent_id = args
            .get("agentId")
            .and_then(Value::as_str)
            .ok_or_else(|| "missing agentId".to_owned())?;
        let msg = args
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();

        let snapshot = self
            .children
            .lock()
            .get(agent_id)
            .cloned()
            .ok_or_else(|| format!("unknown child {agent_id}"))?;

        let next = (self.responder)(&snapshot, Some(&msg));
        let mut guard = self.children.lock();
        let entry = guard.get_mut(agent_id).unwrap();
        entry.repair_turns += 1;
        match next {
            Ok((text, extra_cost)) => {
                entry.latest_text = Some(text);
                entry.usd_cost += extra_cost;
                entry.execution_state = "completed".to_owned();
            }
            Err(_) => {
                entry.execution_state = "errored".to_owned();
            }
        }
        Ok(json!({ "ok": true }))
    }

    async fn wait_for_agent(&self, _parent_session_id: &str, args: Value) -> Result<Value, String> {
        let ids: Vec<String> = args
            .get("agentIds")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();

        let guard = self.children.lock();
        let mut agents = Vec::new();
        let mut inspections = Vec::new();
        for id in &ids {
            if let Some(c) = guard.get(id) {
                agents.push(json!({
                    "agentId": id,
                    "executionState": c.execution_state,
                    "lifecycleState": "active",
                }));
                inspections.push(json!({
                    "agentId": id,
                    "latestAssistantText": c.latest_assistant_text_ref(),
                }));
            }
        }

        Ok(json!({
            "timedOut": false,
            "agents": agents,
            "inspections": inspections,
        }))
    }

    async fn inspect_agent(&self, _parent_session_id: &str, args: Value) -> Result<Value, String> {
        let id = args
            .get("agentId")
            .and_then(Value::as_str)
            .ok_or_else(|| "missing agentId".to_owned())?;
        let guard = self.children.lock();
        let c = guard
            .get(id)
            .ok_or_else(|| format!("child {id} not found"))?;
        Ok(json!({
            "agent": {
                "agentId": id,
                "executionState": c.execution_state,
            },
            "latestAssistantText": c.latest_text,
            "sessionUsage": {
                "estimatedTotalCostUsd": c.usd_cost,
            }
        }))
    }

    async fn resume_agent(&self, _parent_session_id: &str, _args: Value) -> Result<Value, String> {
        Ok(json!({}))
    }

    async fn close_agent(&self, _parent_session_id: &str, _args: Value) -> Result<Value, String> {
        self.close_calls.fetch_add(1, Ordering::SeqCst);
        Ok(json!({ "closed": true }))
    }
}

impl MockChildState {
    fn latest_assistant_text_ref(&self) -> Option<&str> {
        self.latest_text.as_deref()
    }
}

#[tokio::test]
async fn code_mode_tool_exposes_catalog_runs_typescript_and_enforces_permissions() {
    let built_in = repo_root();
    let (home, ws) = isolated_dirs("codemode");
    fs::write(ws.join("alpha.txt"), "hello from workspace\n").unwrap();
    fs::write(ws.join("beta.txt"), "second file\n").unwrap();

    let mut cfg = make_agent_config(&home, &ws, &built_in);
    cfg.tool_calling.code_mode = true;

    let mut ctx = ToolExecutionContext::new_for_tests(
        home.clone(),
        ws.clone(),
        ProviderName::Openai,
        "gpt-5.4",
    );
    ctx.agent_config = Some(Arc::new(cfg));
    ctx.read_only_role = true; // `write` and `edit` must NOT be callable inside codeMode!

    let tools = create_builtin_tools(&ctx);
    assert!(tools.contains_key("codeMode"), "codeMode must be exposed");
    assert!(
        tools.contains_key("toolSearch"),
        "toolSearch must be exposed alongside codeMode"
    );
    assert!(
        !tools.contains_key("write"),
        "read-only role must omit write"
    );

    // Verify reserved meta-tools are hidden from catalog search and blocked on call
    let cat = DeferredToolCatalog::new(tools.clone());
    let cm = CodeModeTool::new(cat, None);
    let details = cm
        .execute_with_details(
            r#"
            interface Summary {
              matchedTools: string[];
              alphaContent: string;
              writeBlocked: boolean;
              recursiveBlocked: boolean;
            }
            const found = (await tools.search("read")) as { tools: Array<{ name: string }> };
            console.log("searched tools:", found.tools.length);
            const alpha = await tools.call("read", { filePath: "alpha.txt" });

            let writeBlocked = false;
            try {
              await tools.call("write", { filePath: "hacked.txt", content: "nope" });
            } catch {
              writeBlocked = true;
            }

            let recursiveBlocked = false;
            try {
              await tools.call("codeMode", { code: "return 1;" });
            } catch {
              recursiveBlocked = true;
            }

            const out: Summary = {
              matchedTools: found.tools.map((t) => t.name),
              alphaContent: String(alpha),
              writeBlocked,
              recursiveBlocked,
            };
            return out;
            "#,
            &ctx,
        )
        .await
        .expect("codeMode TypeScript execution should succeed");

    assert!(
        details.value["matchedTools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == "read")
    );
    assert!(
        !details.value["matchedTools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == "codeMode" || v == "toolSearch")
    );
    assert!(
        details.value["alphaContent"]
            .as_str()
            .unwrap()
            .contains("hello from workspace")
    );
    assert_eq!(details.value["writeBlocked"], json!(true));
    assert_eq!(details.value["recursiveBlocked"], json!(true));
    assert_eq!(details.logs.len(), 1);
    assert!(details.logs[0].contains("searched tools:"));

    let _ = fs::remove_dir_all(home.parent().unwrap());
}

#[tokio::test]
async fn workflow_tool_lists_saves_enforces_no_imports_and_runs_deep_research_ts() {
    let built_in = repo_root();
    let (home, ws) = isolated_dirs("deep-research");
    let cfg = make_agent_config(&home, &ws, &built_in);

    let mock_ctrl = Arc::new(MockWorkflowAgentControl::new(|child, _repair| {
        let nick = child.nickname.as_deref().unwrap_or("");
        if nick == "research-plan" {
            return Ok((
                r#"<workflow_result>{
                  "questions": [
                    {"title": "Q1: Heap isolation", "focus": "Runtime::set_memory_limit"},
                    {"title": "Q2: Wall-clock interrupts", "focus": "set_interrupt_handler"}
                  ],
                  "planningLimitations": []
                }</workflow_result>"#
                    .to_owned(),
                0.04,
            ));
        }
        if nick.starts_with("research:") {
            return Ok((
                format!(
                    r#"<workflow_result>{{
                      "claims": [{{
                        "statement": "QuickJS enforces heap limits in {nick}",
                        "evidence": "Verified via set_memory_limit",
                        "sources": [{{"title": "QuickJS Docs", "locator": "https://bellard.org/quickjs"}}],
                        "uncertainty": "low"
                      }}],
                      "reportMarkdown": "Detailed section for {nick} citing https://bellard.org/quickjs.",
                      "sources": [{{"title": "QuickJS Docs", "locator": "https://bellard.org/quickjs"}}],
                      "limitations": []
                    }}</workflow_result>"#
                ),
                0.06,
            ));
        }
        if nick == "verify:1" {
            return Ok((
                r#"<workflow_result>{
                  "claims": [{
                    "candidateIndex": 0,
                    "verified": true,
                    "reason": "Primary source confirmed",
                    "evidence": "Runtime::set_memory_limit caps allocations",
                    "sources": [{"title": "QuickJS Docs", "locator": "https://bellard.org/quickjs"}],
                    "correctedStatement": "QuickJS enforces heap limits in research:1"
                  }],
                  "limitations": []
                }</workflow_result>"#
                    .to_owned(),
                0.05,
            ));
        }
        if nick == "verify:2" {
            return Ok((
                r#"<workflow_result>{
                  "claims": [{
                    "candidateIndex": 1,
                    "verified": true,
                    "reason": "Primary source confirmed",
                    "evidence": "set_interrupt_handler halts tight loops",
                    "sources": [{"title": "QuickJS Docs", "locator": "https://bellard.org/quickjs"}],
                    "correctedStatement": "QuickJS enforces heap limits in research:2"
                  }],
                  "limitations": []
                }</workflow_result>"#
                    .to_owned(),
                0.05,
            ));
        }
        if nick == "research-synthesis" {
            return Ok((
                r##"<workflow_result>{
                  "title": "Sandboxed QuickJS Architecture",
                  "executiveSummary": "Heap limits and interrupt handlers isolate scripts.",
                  "reportMarkdown": "# Sandboxed QuickJS Architecture\n\nVerified claims across both shards."
                }</workflow_result>"##
                    .to_owned(),
                0.08,
            ));
        }
        Ok(("Fallback child output".to_owned(), 0.01))
    }));

    let progress_events: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
    let retained_runs: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
    let pe_clone = Arc::clone(&progress_events);
    let rr_clone = Arc::clone(&retained_runs);
    let cost_bridge = Arc::new(SharedTestCostBridge::new(None));

    let mut ctx = ToolExecutionContext::new_for_tests(
        home.clone(),
        ws.clone(),
        ProviderName::Openai,
        "gpt-5.4",
    );
    ctx.built_in_dir = Some(built_in.clone());
    ctx.agent_config = Some(Arc::new(cfg));
    ctx.agent_control = Some(mock_ctrl.clone());
    ctx.cost_tracker_bridge = Some(cost_bridge.clone());
    ctx.on_workflow_progress = Some(Arc::new(move |prog| {
        pe_clone.lock().push(prog.clone());
        let mut runs = rr_clone.lock();
        upsert_retained_workflow_run(&mut runs, prog);
    }));

    let tools = create_builtin_tools(&ctx);
    assert!(
        tools.contains_key("workflow"),
        "workflow tool must be registered on root session"
    );
    let wf_tool = WorkflowTool;

    // 1. `list` discovers bundled `deep-research`
    let list_out = wf_tool
        .execute(
            serde_json::from_value::<Map<String, Value>>(json!({ "action": "list" })).unwrap(),
            &ctx,
        )
        .await
        .unwrap()
        .to_json_value();
    assert_eq!(list_out["ok"], json!(true));
    assert!(
        list_out["workflows"]
            .as_array()
            .unwrap()
            .iter()
            .any(|w| w["name"] == "deep-research" && w["scope"] == "bundled")
    );

    // 2. `run` returns `{ ok: false, issues }` (not ToolError!) when script contains external imports
    let import_rejected = wf_tool
        .execute(
            serde_json::from_value::<Map<String, Value>>(json!({
                "action": "run",
                "script": r#"
                    import fs from "node:fs";
                    export const meta = { name: "bad-wf", description: "bad", phases: [] };
                    export default async function () { return fs.readdirSync("."); }
                "#
            }))
            .unwrap(),
            &ctx,
        )
        .await
        .unwrap()
        .to_json_value();
    assert_eq!(import_rejected["ok"], json!(false));
    assert_eq!(
        import_rejected["error"],
        json!("the workflow script did not compile")
    );
    assert!(
        import_rejected["issues"]
            .as_array()
            .unwrap()
            .iter()
            .any(|i| {
                i["path"] == "imports"
                    && i["message"]
                        .as_str()
                        .unwrap()
                        .contains("may not import anything")
            })
    );

    // 3. `save` works in project & global scopes and enforces project > global precedence
    let custom_global = r#"
        export const meta = { name: "custom-check", description: "global desc", phases: ["s1"] };
        export default async function ({ phase }) { phase("s1"); return "global"; }
    "#;
    let custom_project = r#"
        export const meta = { name: "custom-check", description: "project desc", phases: ["s1"] };
        export default async function ({ phase }) { phase("s1"); return "project"; }
    "#;
    wf_tool
        .execute(
            serde_json::from_value::<Map<String, Value>>(json!({
                "action": "save",
                "name": "custom-check",
                "scope": "global",
                "script": custom_global,
            }))
            .unwrap(),
            &ctx,
        )
        .await
        .unwrap();
    wf_tool
        .execute(
            serde_json::from_value::<Map<String, Value>>(json!({
                "action": "save",
                "name": "custom-check",
                "scope": "project",
                "script": custom_project,
            }))
            .unwrap(),
            &ctx,
        )
        .await
        .unwrap();
    let list_override = wf_tool
        .execute(
            serde_json::from_value::<Map<String, Value>>(json!({ "action": "list" })).unwrap(),
            &ctx,
        )
        .await
        .unwrap()
        .to_json_value();
    let custom_entry = list_override["workflows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|w| w["name"] == "custom-check")
        .unwrap();
    assert_eq!(custom_entry["scope"], json!("project"));
    assert_eq!(custom_entry["description"], json!("project desc"));

    // Read-only sandbox blocks save & live run, but allows dryRun!
    let mut ro_ctx = ctx.clone();
    ro_ctx.sandbox_policy = SandboxPolicy::ReadOnly { network: false };
    let ro_err = wf_tool
        .execute(
            serde_json::from_value::<Map<String, Value>>(json!({
                "action": "save",
                "name": "ro-blocked",
                "scope": "project",
                "script": custom_project,
            }))
            .unwrap(),
            &ro_ctx,
        )
        .await
        .unwrap_err();
    assert!(ro_err.to_string().contains("sandbox mode is read-only"));

    // 4. `dryRun` spawns 0 real child agents even under read-only sandbox!
    let dry_out = wf_tool
        .execute(
            serde_json::from_value::<Map<String, Value>>(json!({
                "action": "run",
                "script": r#"
                    export const meta = { name: "dry-probe", description: "dry", phases: ["p1"] };
                    export default async function ({ workflow, agent }) {
                      return await workflow("p1", () => agent("check", { label: "probe" }));
                    }
                "#,
                "dryRun": true,
            }))
            .unwrap(),
            &ro_ctx,
        )
        .await
        .unwrap()
        .to_json_value();
    assert_eq!(dry_out["ok"], json!(true));
    assert_eq!(dry_out["result"], json!("[dry-run] probe"));
    assert_eq!(mock_ctrl.spawn_calls.load(Ordering::SeqCst), 0);
    assert!(
        progress_events.lock().is_empty(),
        "dryRun must not emit session progress"
    );

    // 5. Live `run` of bundled `workflows/deep-research.ts`!
    let live_out = wf_tool
        .execute(
            serde_json::from_value::<Map<String, Value>>(json!({
                "action": "run",
                "name": "deep-research",
                "args": {
                    "query": "How does cowork-js-vm isolate scripts?",
                    "maxQuestions": 2,
                    "maxClaimsPerQuestion": 2
                }
            }))
            .unwrap(),
            &ctx,
        )
        .await
        .unwrap()
        .to_json_value();

    assert_eq!(live_out["ok"], json!(true), "live_out = {live_out}");
    assert_eq!(live_out["name"], json!("deep-research"));
    assert_eq!(live_out["definition"]["scope"], json!("bundled"));
    // 1 research-plan + 2 research shards + 2 verify shards + 1 synthesis = 6 child agents!
    assert_eq!(live_out["agentCount"], json!(6));
    assert_eq!(live_out["erroredCount"], json!(0));
    assert_eq!(live_out["result"]["status"], json!("complete"));
    assert_eq!(live_out["result"]["coverage"]["verifiedClaims"], json!(2));
    assert!(
        live_out["result"]["reportMarkdown"]
            .as_str()
            .unwrap()
            .contains("# Sandboxed QuickJS Architecture")
    );
    let expected_cost = 0.04 + 2.0 * 0.06 + 2.0 * 0.05 + 0.08;
    assert!((live_out["spentUsd"].as_f64().unwrap() - expected_cost).abs() < 1e-6);
    assert!((cost_bridge.total_spent() - expected_cost).abs() < 1e-6);

    let events = progress_events.lock();
    assert!(!events.is_empty());
    let final_evt = events.last().unwrap();
    assert_eq!(final_evt["outcome"], json!("completed"));
    assert_eq!(final_evt["currentPhase"], json!("synthesize"));
    assert_eq!(retained_runs.lock().len(), 1);

    let _ = fs::remove_dir_all(home.parent().unwrap());
}

#[tokio::test]
async fn workflow_spills_oversized_prompts_repairs_json_schema_in_one_turn_and_replays_journal_at_zero_cost()
 {
    let built_in = repo_root();
    let (home, ws) = isolated_dirs("spill-repair-replay");
    fs::create_dir_all(ws.join("docs")).unwrap();
    let cfg = make_agent_config(&home, &ws, &built_in);

    let mock_ctrl = Arc::new(MockWorkflowAgentControl::new(|child, repair_msg| {
        let nick = child.nickname.as_deref().unwrap_or("");
        if nick == "needs-repair" {
            // Verify schema systemPromptSuffix was attached on spawn!
            assert!(
                child
                    .system_prompt_suffix
                    .as_deref()
                    .unwrap_or("")
                    .contains("<workflow_result>")
            );
            if repair_msg.is_none() {
                // First turn intentionally fails JSON schema (`count` is string instead of integer)
                return Ok((
                    r#"<workflow_result>{"count":"wrong-type"}</workflow_result>"#.to_owned(),
                    0.15,
                ));
            }
            // Repair turn succeeds!
            assert!(repair_msg.unwrap().contains("did not validate"));
            return Ok((
                r#"<workflow_result>{"count":42}</workflow_result>"#.to_owned(),
                0.10,
            ));
        }
        if nick == "oversized-reader" {
            // Prompt was >20,000 chars so child must receive pointer prompt + targetPaths entry!
            assert!(
                child.prompt.contains(".ModelScratchpad/workflows/inputs/"),
                "expected pointer prompt, got len={}",
                child.prompt.len()
            );
            let tps = child.target_paths.as_ref().expect("targetPaths preserved");
            assert!(tps.iter().any(|p| p == "docs"));
            assert!(tps.iter().any(
                |p| p.starts_with(".ModelScratchpad/workflows/inputs/") && p.ends_with(".txt")
            ));
            return Ok(("spilled-ok".to_owned(), 0.20));
        }
        if nick.starts_with("jury:") {
            let pass = !nick.ends_with(":3");
            let score = if pass { 0.9 } else { 0.2 };
            return Ok((
                format!(
                    r#"<workflow_result>{{"pass":{pass},"score":{score},"reason":"vote from {nick}"}}</workflow_result>"#
                ),
                0.02,
            ));
        }
        if nick == "tail-step" {
            return Ok((format!("tail:{}", child.prompt), 0.12));
        }
        Ok(("ok".to_owned(), 0.05))
    }));

    let cost_bridge = Arc::new(SharedTestCostBridge::new(None));
    let mut ctx = ToolExecutionContext::new_for_tests(
        home.clone(),
        ws.clone(),
        ProviderName::Openai,
        "gpt-5.4",
    );
    ctx.built_in_dir = Some(built_in);
    ctx.agent_config = Some(Arc::new(cfg));
    ctx.agent_control = Some(mock_ctrl.clone());
    ctx.cost_tracker_bridge = Some(cost_bridge.clone());

    let wf_tool = WorkflowTool;
    let huge_blob = "X".repeat(24_500);

    let script_v1 = r#"
        export const meta = {
          name: "spill-repair-test",
          description: "Tests spill, 1-turn repair, pipeline, and journal resume",
          phases: ["ingest", "finalize"]
        };
        export default async function ({ workflow, agent, pipeline, judge, compact, args }) {
          const repaired = await workflow("ingest", async () => {
            const r = await agent("Extract count", {
              label: "needs-repair",
              schema: {
                type: "object",
                properties: { count: { type: "integer" } },
                required: ["count"],
                additionalProperties: false
              }
            });
            const spilled = await agent(args.bigPrompt, {
              label: "oversized-reader",
              targetPaths: ["docs"],
              inputFormat: "txt"
            });
            const judged = await judge("candidate text", {
              n: 3,
              aggregate: "majority",
              agent: { label: "jury" }
            });
            return {
              count: r.count,
              spilled,
              verdict: judged.verdict,
              compacted: compact([null, "kept", undefined, 7])
            };
          });

          const piped = await workflow("finalize", () =>
            pipeline(
              ["itemA"],
              (item, orig, idx) => Promise.resolve(`${item}:${orig}:${idx}`),
              (acc) => agent(`${args.tailPrefix}:${acc}`, { label: "tail-step" })
            )
          );

          return { repaired, piped };
        }
    "#;

    // Run 1: executes all 3 agents (with 1 automatic repair turn on `needs-repair`)
    let run1 = wf_tool
        .execute(
            serde_json::from_value::<Map<String, Value>>(json!({
                "action": "run",
                "script": script_v1,
                "args": {
                    "bigPrompt": huge_blob,
                    "tailPrefix": "v1"
                }
            }))
            .unwrap(),
            &ctx,
        )
        .await
        .unwrap()
        .to_json_value();

    assert_eq!(run1["ok"], json!(true), "run1 = {run1}");
    assert_eq!(run1["result"]["repaired"]["count"], json!(42));
    assert_eq!(run1["result"]["repaired"]["spilled"], json!("spilled-ok"));
    assert_eq!(run1["result"]["repaired"]["verdict"], json!("pass"));
    assert_eq!(run1["result"]["repaired"]["compacted"], json!(["kept", 7]));
    assert_eq!(run1["result"]["piped"], json!(["tail:v1:itemA:itemA:0"]));
    // 1 needs-repair + 1 oversized-reader + 3 jury + 1 tail-step = 6 spawns!
    assert_eq!(mock_ctrl.spawn_calls.load(Ordering::SeqCst), 6);
    assert_eq!(mock_ctrl.send_input_calls.load(Ordering::SeqCst), 1);

    // Verify spilled file on disk is 24,500 chars and read-only (`0400`) and write-protected
    let inputs_dir = ws.join(".ModelScratchpad").join("workflows").join("inputs");
    let spilled_files: Vec<PathBuf> = fs::read_dir(&inputs_dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    assert_eq!(spilled_files.len(), 1);
    assert_eq!(fs::read_to_string(&spilled_files[0]).unwrap().len(), 24_500);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(&spilled_files[0])
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o400, "spilled input file must be 0400 read-only");
    }
    assert!(
        matches!(
            assert_write_path_allowed(&spilled_files[0], &ctx),
            Err(ToolError::PathDenied(_))
        ),
        "tools must be blocked from writing to workflow input spill directory"
    );

    // Run 2: resume from Run 1's `runId` with IDENTICAL `args`, where shards 1 & 2 are unchanged
    // and only shard 3's prompt changes (`"v2"` instead of `"v1"` in script)!
    let run1_id = run1["runId"].as_str().unwrap().to_owned();
    let script_v2 = script_v1.replace("${args.tailPrefix}:${acc}", "changed:${acc}");

    let spawns_before_resume = mock_ctrl.spawn_calls.load(Ordering::SeqCst);
    let cost_before_resume = cost_bridge.total_spent();

    let run2 = wf_tool
        .execute(
            serde_json::from_value::<Map<String, Value>>(json!({
                "action": "run",
                "script": script_v2,
                "args": {
                    "bigPrompt": huge_blob,
                    "tailPrefix": "v1"
                },
                "resumeFromRunId": run1_id,
            }))
            .unwrap(),
            &ctx,
        )
        .await
        .unwrap()
        .to_json_value();

    assert_eq!(run2["ok"], json!(true), "run2 = {run2}");
    assert_eq!(run2["resumedFromRunId"], json!(run1_id));
    assert_eq!(run2["agentCount"], json!(6));
    assert_eq!(
        run2["cachedCount"],
        json!(5),
        "5 completed shards must replay from journal"
    );
    assert_eq!(
        mock_ctrl.spawn_calls.load(Ordering::SeqCst) - spawns_before_resume,
        1,
        "only the 1 modified shard may spawn a child agent"
    );
    // Cached shards cost $0.00; only `tail-step` ($0.12) ran!
    assert!((run2["spentUsd"].as_f64().unwrap() - 0.12).abs() < 1e-6);
    assert!((cost_bridge.total_spent() - cost_before_resume - 0.12).abs() < 1e-6);
    assert_eq!(
        run2["result"]["piped"],
        json!(["tail:changed:itemA:itemA:0"])
    );

    // 3. Hard-budget `stopAtUsd` serializes concurrency to 1 and stops admitting further agents!
    let hard_ctrl = Arc::new(MockWorkflowAgentControl::new(|_child, _| {
        Ok(("costly".to_owned(), 0.35))
    }));
    let hard_cost = Arc::new(SharedTestCostBridge::new(Some(BudgetThresholds {
        warn_at_usd: Some(0.10),
        stop_at_usd: Some(0.30),
    })));
    let mut hard_ctx = ctx.clone();
    hard_ctx.agent_control = Some(hard_ctrl.clone());
    hard_ctx.cost_tracker_bridge = Some(hard_cost);

    let budget_script = r#"
        export const meta = { name: "budget-cap", description: "cap", phases: ["p1"] };
        export default async function ({ workflow, parallel, agent }) {
          return await workflow("p1", () =>
            parallel(["a", "b", "c"].map((x) => () => agent(`work ${x}`, { label: `shard-${x}` })))
          );
        }
    "#;
    let capped_out = wf_tool
        .execute(
            serde_json::from_value::<Map<String, Value>>(json!({
                "action": "run",
                "script": budget_script,
            }))
            .unwrap(),
            &hard_ctx,
        )
        .await
        .unwrap()
        .to_json_value();

    assert_eq!(capped_out["ok"], json!(true));
    assert_eq!(
        hard_ctrl.peak_active.load(Ordering::SeqCst),
        1,
        "stopAtUsd must serialize scheduler admission to 1"
    );
    assert_eq!(
        hard_ctrl.spawn_calls.load(Ordering::SeqCst),
        1,
        "second and third shards must not spawn after shard 1 exhausts stopAtUsd"
    );
    // `parallel` maps rejected/budget-exhausted items to `null`
    assert_eq!(capped_out["result"], json!(["costly", null, null]));

    let _ = fs::remove_dir_all(home.parent().unwrap());
}
