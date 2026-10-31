use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use async_trait::async_trait;
use cowork_config::{AgentConfig, LoadConfigOptions, ProviderName, load_config};
use cowork_harness::{
    AgentControl, AgentControlConfig, ChildTurnExecutor, ChildTurnInput, ChildTurnResult,
    HarnessEventSink, InteractionManager, SteerCoordinator, TurnRunConfig, TurnStepRunner,
};
use cowork_inference::{
    BudgetThresholds, CanonicalMessage, ContentBlock, MessageRole, ProviderOpaqueMeta,
    ProviderTransportError, SessionCostTracker, StepBudget, StopReason, TurnUsage,
};
use cowork_providers::{
    ProviderStepRequest, ProviderStepResult, ProviderTransport, StreamEventCallback,
};
use cowork_storage::{SessionDb, SessionDbOptions};
use cowork_tools::{AgentControlBridge, ToolExecutionContext};
use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use tempfile::TempDir;
use uuid::Uuid;

struct IsolatedEnv {
    _root: TempDir,
    home: PathBuf,
    ws: PathBuf,
    cfg: AgentConfig,
    db: Arc<SessionDb>,
}

async fn setup_env(prefix: &str) -> IsolatedEnv {
    let root = tempfile::Builder::new()
        .prefix(prefix)
        .tempdir_in("/private/tmp")
        .unwrap();
    let base = fs::canonicalize(root.path()).unwrap();
    let home = base.join("home");
    let ws = base.join("workspace");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&ws).unwrap();

    let mut env = HashMap::new();
    env.insert("HOME".to_owned(), home.to_string_lossy().into_owned());
    env.insert(
        "COWORK_HOME_OVERRIDE".to_owned(),
        home.join(".cowork").to_string_lossy().into_owned(),
    );

    let cfg = load_config(LoadConfigOptions {
        cwd: Some(ws.clone()),
        homedir: Some(home.clone()),
        env: Some(env),
        built_in_dir: Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")),
    })
    .unwrap();

    let db = Arc::new(
        SessionDb::open(SessionDbOptions {
            root_dir: cfg.user_cowork_dir.clone(),
            db_path: Some(cfg.user_cowork_dir.join("sessions.db")),
            sessions_dir: cfg.user_cowork_dir.join("sessions"),
            busy_timeout_ms: Some(5_000),
        })
        .await
        .unwrap(),
    );

    IsolatedEnv {
        _root: root,
        home,
        ws,
        cfg,
        db,
    }
}

#[derive(Default)]
struct RecordingSink {
    notifications: Mutex<Vec<(String, Value)>>,
}

impl HarnessEventSink for RecordingSink {
    fn send_notification(&self, method: &str, params: Value) {
        self.notifications.lock().push((method.to_owned(), params));
    }

    fn send_server_request(&self, _request_id: &str, _method: &str, _params: Value) {}
}

type StepFn = Box<
    dyn FnOnce(ProviderStepRequest) -> Result<ProviderStepResult, ProviderTransportError> + Send,
>;

struct QueueTransport {
    steps: Mutex<Vec<StepFn>>,
}

impl QueueTransport {
    fn new(mut steps: Vec<StepFn>) -> Self {
        steps.reverse();
        Self {
            steps: Mutex::new(steps),
        }
    }
}

#[async_trait]
impl ProviderTransport for QueueTransport {
    async fn stream_step(
        &self,
        req: ProviderStepRequest,
        _budget: &StepBudget,
        _on_event: &mut StreamEventCallback<'_>,
    ) -> Result<ProviderStepResult, ProviderTransportError> {
        let step = self
            .steps
            .lock()
            .pop()
            .expect("unexpected extra model step");
        step(req)
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

#[derive(Default)]
struct WorkflowChildExecutor {
    calls: AtomicUsize,
    recorded_role_prompts: Mutex<Vec<String>>,
}

#[async_trait]
impl ChildTurnExecutor for WorkflowChildExecutor {
    async fn run_child_turn(&self, input: ChildTurnInput) -> Result<ChildTurnResult, String> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.recorded_role_prompts.lock().push(input.role_prompt);
        let reply = r#"<workflow_result>{"answer":"QuickJS isolate verified","confidence":0.99}</workflow_result>"#;
        let mut messages = input.initial_messages;
        messages.push(assistant_msg(vec![ContentBlock::Text {
            text: reply.to_owned(),
            phase: None,
            citations: Vec::new(),
            provider_meta: ProviderOpaqueMeta::default(),
        }]));
        Ok(ChildTurnResult {
            messages,
            latest_assistant_text: Some(reply.to_owned()),
            usage: TurnUsage {
                prompt_tokens: 100_000,
                completion_tokens: 20_000,
                total_tokens: 120_000,
                ..Default::default()
            },
        })
    }
}

#[tokio::test]
async fn turn_runner_composes_code_mode_with_deferred_tool_search_and_rolls_up_workflow_agent_costs()
 {
    let mut iso = setup_env("harness-cm-wf-").await;
    iso.cfg.provider = ProviderName::Openai;
    iso.cfg.model = "gpt-5.4".to_owned();
    iso.cfg.tool_calling.deferred_tool_search = true;
    iso.cfg.tool_calling.code_mode = true;

    fs::write(iso.ws.join("hello.txt"), "Hello from harness codeMode!\n").unwrap();

    // ------------------------------------------------------------------------
    // Part 1: `TurnStepRunner` with `deferred_tool_search = true` + `codeMode = true`
    // ------------------------------------------------------------------------
    let transport = Arc::new(QueueTransport::new(vec![
        Box::new(|req| {
            let names: Vec<&str> = req.tools.iter().map(|t| t.name.as_str()).collect();
            assert!(
                names.contains(&"codeMode")
                    && names.contains(&"toolSearch")
                    && names.contains(&"toolCall"),
                "initial deferred surface must expose codeMode + toolSearch + toolCall: {names:?}"
            );
            assert!(
                !names.contains(&"read"),
                "deferred tools must NOT be directly exposed before search/call: {names:?}"
            );

            Ok(ProviderStepResult {
                assistant: assistant_msg(vec![ContentBlock::ToolCall {
                    id: "tc_cm_1".to_owned(),
                    name: "codeMode".to_owned(),
                    arguments: serde_json::from_value(json!({
                        "code": r#"
                            const searchRes: any = await tools.search("read");
                            const fileText: any = await tools.call("read", { filePath: "hello.txt" });
                            return { matched: searchRes.tools.length > 0, fileText };
                        "#
                    }))
                    .unwrap(),
                    partial_json: None,
                    provider_meta: ProviderOpaqueMeta::default(),
                }]),
                persisted_assistant: None,
                usage: TurnUsage {
                    prompt_tokens: 500,
                    completion_tokens: 100,
                    total_tokens: 600,
                    ..Default::default()
                },
                continuation: None,
                raw_events: Vec::new(),
            })
        }),
        Box::new(|req| {
            let names: Vec<&str> = req.tools.iter().map(|t| t.name.as_str()).collect();
            assert!(
                names.contains(&"read"),
                "`read` discovered/invoked inside codeMode must activate on subsequent steps: {names:?}"
            );
            let tool_msg = req
                .messages
                .iter()
                .find(|m| m.role == MessageRole::Tool)
                .expect("tool result message");
            let ContentBlock::ToolResult {
                is_error,
                ref content,
                ..
            } = tool_msg.content[0]
            else {
                panic!("expected ToolResult");
            };
            assert!(!is_error, "codeMode tool call must succeed: {content:?}");
            Ok(ProviderStepResult {
                assistant: assistant_msg(vec![ContentBlock::Text {
                    text: "codeMode completed cleanly.".to_owned(),
                    phase: None,
                    citations: Vec::new(),
                    provider_meta: ProviderOpaqueMeta::default(),
                }]),
                persisted_assistant: None,
                usage: TurnUsage::default(),
                continuation: None,
                raw_events: Vec::new(),
            })
        }),
    ]));

    let mut tool_ctx = ToolExecutionContext::new_for_tests(
        iso.home.clone(),
        iso.ws.clone(),
        ProviderName::Openai,
        "gpt-5.4",
    );
    tool_ctx.yolo = true;
    tool_ctx.built_in_dir = Some(iso.cfg.built_in_dir.clone());
    tool_ctx.agent_config = Some(Arc::new(iso.cfg.clone()));

    let sink = Arc::new(RecordingSink::default());
    let interactions = Arc::new(InteractionManager::new(
        "sess-1",
        sink.clone() as Arc<dyn HarnessEventSink>,
    ));
    let steer = Arc::new(SteerCoordinator::new(
        "sess-1",
        "turn-1",
        sink.clone() as Arc<dyn HarnessEventSink>,
        None,
    ));
    let mut cost_tracker = SessionCostTracker::new("sess-1", None);

    let runner = TurnStepRunner::new(TurnRunConfig {
        thread_id: "sess-1".to_owned(),
        turn_id: "turn-1".to_owned(),
        provider: ProviderName::Openai,
        model_id: "gpt-5.4".to_owned(),
        base_url: None,
        api_key: None,
        extra_headers: HashMap::new(),
        system_prompt: "test".to_owned(),
        provider_options: Map::new(),
        deferred_tool_search: true,
        max_steps: 4,
        step_timeout_ms: 15_000,
        overflow_threshold_chars: None,
        tool_retry_lineage: false,
        initial_user_message: Some(("Read hello.txt via codeMode".to_owned(), None)),
    });

    let outcome = runner
        .run_turn(
            transport,
            Vec::new(),
            &mut tool_ctx,
            &interactions,
            &steer,
            &mut cost_tracker,
            None,
            sink.clone(),
        )
        .await;
    assert_eq!(outcome.status, "completed");

    // ------------------------------------------------------------------------
    // Part 2: `TurnStepRunner` + `workflow` tool + real `AgentControl` cost rollup!
    // ------------------------------------------------------------------------
    iso.cfg.workflows_enabled = true;
    iso.cfg.tool_calling.deferred_tool_search = false;
    iso.cfg.tool_calling.code_mode = false;
    tool_ctx.agent_config = Some(Arc::new(iso.cfg.clone()));

    let mut connected = BTreeSet::new();
    connected.insert(ProviderName::Openai);
    let child_exec = Arc::new(WorkflowChildExecutor::default());
    let agent_ctrl = Arc::new(AgentControl::new(
        AgentControlConfig {
            parent_session_id: "sess-wf".to_owned(),
            parent_depth: 0,
            agent_config: Arc::new(iso.cfg.clone()),
            session_db: Arc::clone(&iso.db),
            connected_providers: connected,
        },
        child_exec.clone(),
        Arc::new(|_, _| {}),
    ));
    tool_ctx.session_id = "sess-wf".to_owned();
    tool_ctx.agent_control = Some(agent_ctrl.clone() as Arc<dyn AgentControlBridge>);

    let wf_sink = Arc::new(RecordingSink::default());
    let wf_interactions = Arc::new(InteractionManager::new(
        "sess-wf",
        wf_sink.clone() as Arc<dyn HarnessEventSink>,
    ));
    let wf_steer = Arc::new(SteerCoordinator::new(
        "sess-wf",
        "turn-wf",
        wf_sink.clone() as Arc<dyn HarnessEventSink>,
        None,
    ));
    let mut wf_cost = SessionCostTracker::new(
        "sess-wf",
        Some(BudgetThresholds {
            warn_at_usd: Some(0.10),
            stop_at_usd: None,
        }),
    );

    let wf_transport = Arc::new(QueueTransport::new(vec![
        Box::new(|_req| {
            Ok(ProviderStepResult {
                assistant: assistant_msg(vec![ContentBlock::ToolCall {
                    id: "tc_wf_1".to_owned(),
                    name: "workflow".to_owned(),
                    arguments: serde_json::from_value(json!({
                        "action": "run",
                        "script": r#"
                            export const meta = { name: "cost-check", description: "check", phases: ["p1"] };
                            export default async function ({ workflow, agent }) {
                              return await workflow("p1", () =>
                                agent("Verify isolate", {
                                  label: "verifier",
                                  agentType: "explorer",
                                  schema: {
                                    type: "object",
                                    properties: {
                                      answer: { type: "string" },
                                      confidence: { type: "number" }
                                    },
                                    required: ["answer", "confidence"],
                                    additionalProperties: false
                                  }
                                })
                              );
                            }
                        "#
                    }))
                    .unwrap(),
                    partial_json: None,
                    provider_meta: ProviderOpaqueMeta::default(),
                }]),
                persisted_assistant: None,
                usage: TurnUsage::default(),
                continuation: None,
                raw_events: Vec::new(),
            })
        }),
        Box::new(|_req| {
            Ok(ProviderStepResult {
                assistant: assistant_msg(vec![ContentBlock::Text {
                    text: "Workflow finished.".to_owned(),
                    phase: None,
                    citations: Vec::new(),
                    provider_meta: ProviderOpaqueMeta::default(),
                }]),
                persisted_assistant: None,
                usage: TurnUsage::default(),
                continuation: None,
                raw_events: Vec::new(),
            })
        }),
    ]));

    let wf_runner = TurnStepRunner::new(TurnRunConfig {
        thread_id: "sess-wf".to_owned(),
        turn_id: "turn-wf".to_owned(),
        provider: ProviderName::Openai,
        model_id: "gpt-5.4".to_owned(),
        base_url: None,
        api_key: None,
        extra_headers: HashMap::new(),
        system_prompt: "test".to_owned(),
        provider_options: Map::new(),
        deferred_tool_search: false,
        max_steps: 4,
        step_timeout_ms: 15_000,
        overflow_threshold_chars: None,
        tool_retry_lineage: false,
        initial_user_message: Some(("Run workflow".to_owned(), None)),
    });

    let wf_outcome = wf_runner
        .run_turn(
            wf_transport,
            Vec::new(),
            &mut tool_ctx,
            &wf_interactions,
            &wf_steer,
            &mut wf_cost,
            None,
            wf_sink.clone(),
        )
        .await;
    assert_eq!(wf_outcome.status, "completed");
    assert_eq!(
        child_exec.calls.load(Ordering::SeqCst),
        1,
        "wf_outcome.messages = {:?}",
        wf_outcome.messages
    );

    // Verify `systemPromptSuffix` with `<workflow_result>` instructions reached child `role_prompt`!
    {
        let prompts = child_exec.recorded_role_prompts.lock();
        assert!(prompts[0].contains("<workflow_result>"));
    }

    // Verify child token USD spend rolled into parent `SessionCostTracker` as unattributed cost
    // AND emitted `cowork/session/budgetWarning`!
    let snap = wf_cost.get_snapshot();
    assert!(
        snap.cost_breakdown.unwrap().other_cost_usd > 0.10,
        "expected child USD spend to roll into parent other_cost_usd, got: {snap:?}"
    );
    let notifs = wf_sink.notifications.lock();
    assert!(
        notifs
            .iter()
            .any(|(m, _)| m == "cowork/session/budgetWarning"),
        "expected budgetWarning notification when workflow child spend crossed warnAtUsd: {notifs:?}"
    );
}

#[tokio::test]
async fn turn_runner_keeps_mcp_tools_deferred_under_non_deferred_code_mode_and_exposes_code_mode_on_agent_and_read_only_roles()
 {
    use axum::Router;
    use axum::body::{Body, Bytes};
    use axum::http::{Response, StatusCode, header};
    use axum::routing::post;
    use cowork_mcp::{
        McpConfigSource, McpServerConfig, McpServerTransport, WorkspaceMcpToolCache,
        upsert_mcp_server,
    };
    use cowork_storage::SessionKind;
    use tokio::net::TcpListener;

    let mut iso = setup_env("harness-cm-mcp-roles-").await;
    fs::write(iso.ws.join("readonly_note.txt"), "safe-read-note\n").unwrap();

    // Spin up a local loopback Streamable HTTP MCP server exposing `lookup_doc`
    let mcp_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mcp_port = mcp_listener.local_addr().unwrap().port();
    let mcp_app = Router::new().route(
        "/mcp",
        post(|body: Bytes| async move {
            let msg: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
            let mid = msg.get("id");
            let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
            if mid.is_none() {
                return Response::builder()
                    .status(StatusCode::ACCEPTED)
                    .body(Body::empty())
                    .unwrap();
            }
            let result = match method {
                "initialize" => json!({
                    "protocolVersion": "2024-11-05",
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "local_docs", "version": "1.0.0" }
                }),
                "tools/list" => json!({
                    "tools": [{
                        "name": "lookup_doc",
                        "description": "Looks up architecture documentation by topic",
                        "inputSchema": {
                            "type": "object",
                            "additionalProperties": false,
                            "properties": {
                                "topic": { "type": "string" }
                            },
                            "required": ["topic"]
                        }
                    }]
                }),
                "tools/call" => {
                    let topic = msg["params"]["arguments"]["topic"]
                        .as_str()
                        .unwrap_or("unknown");
                    json!({
                        "content": [{ "type": "text", "text": format!("doc-body:{topic}") }]
                    })
                }
                _ => json!({}),
            };
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    serde_json::to_string(&json!({
                        "jsonrpc": "2.0",
                        "id": mid,
                        "result": result
                    }))
                    .unwrap(),
                ))
                .unwrap()
        }),
    );
    let mcp_task = tokio::spawn(async move {
        let _ = axum::serve(mcp_listener, mcp_app).await;
    });

    upsert_mcp_server(
        &iso.cfg,
        McpConfigSource::User,
        McpServerConfig {
            name: "local_docs".to_owned(),
            transport: McpServerTransport::Http {
                url: format!("http://127.0.0.1:{mcp_port}/mcp"),
                headers: None,
            },
            enabled: Some(true),
            required: None,
            retries: Some(0),
            auth: None,
            icon: None,
        },
        None,
    )
    .unwrap();

    // Reload config so `enable_mcp` + workspace MCP servers are active, with `deferred_tool_search = false` and `code_mode = true`!
    let mut env_map = HashMap::new();
    env_map.insert("HOME".to_owned(), iso.home.to_string_lossy().into_owned());
    env_map.insert(
        "COWORK_HOME_OVERRIDE".to_owned(),
        iso.home.join(".cowork").to_string_lossy().into_owned(),
    );
    iso.cfg = load_config(LoadConfigOptions {
        cwd: Some(iso.ws.clone()),
        homedir: Some(iso.home.clone()),
        env: Some(env_map.clone()),
        built_in_dir: Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")),
    })
    .unwrap();
    iso.cfg.provider = ProviderName::Openai;
    iso.cfg.model = "gpt-5.4".to_owned();
    iso.cfg.enable_mcp = true;
    iso.cfg.tool_calling.deferred_tool_search = false;
    iso.cfg.tool_calling.code_mode = true;

    let mcp_cache = Arc::new(WorkspaceMcpToolCache::new());

    // ------------------------------------------------------------------------
    // Part A: `code_mode = true`, `deferred_tool_search = false`, `enable_mcp = true`
    // Cached `mcp__local_docs__lookup_doc` MUST stay in `DeferredToolCatalog` and NEVER appear in `req.tools`!
    // ------------------------------------------------------------------------
    let non_deferred_transport = Arc::new(QueueTransport::new(vec![
        Box::new(|req| {
            let names: Vec<&str> = req.tools.iter().map(|t| t.name.as_str()).collect();
            assert!(
                names.contains(&"codeMode")
                    && names.contains(&"toolSearch")
                    && names.contains(&"mcpCall"),
                "non-deferred codeMode + MCP must expose codeMode + toolSearch + mcpCall: {names:?}"
            );
            assert!(
                !names.iter().any(|n| n.starts_with("mcp__")),
                "cached mcp__server__tool schemas MUST NOT be eagerly exposed when deferred_tool_search == false: {names:?}"
            );
            Ok(ProviderStepResult {
                assistant: assistant_msg(vec![ContentBlock::ToolCall {
                    id: "tc_cm_mcp".to_owned(),
                    name: "codeMode".to_owned(),
                    arguments: serde_json::from_value(json!({
                        "code": r#"
                            const s: any = await tools.search("lookup_doc");
                            const res: any = await tools.call("mcp__local_docs__lookup_doc", { topic: "quickjs" });
                            return { found: s.tools.map((t: any) => t.name), res };
                        "#
                    }))
                    .unwrap(),
                    partial_json: None,
                    provider_meta: ProviderOpaqueMeta::default(),
                }]),
                persisted_assistant: None,
                usage: TurnUsage::default(),
                continuation: None,
                raw_events: Vec::new(),
            })
        }),
        Box::new(|req| {
            let names: Vec<&str> = req.tools.iter().map(|t| t.name.as_str()).collect();
            assert!(
                !names.iter().any(|n| n.starts_with("mcp__")),
                "even after codeMode calls an MCP tool, deferred_tool_search == false must NOT hydrate mcp__ schemas onto step_tool_defs: {names:?}"
            );
            let tool_msg = req
                .messages
                .iter()
                .find(|m| m.role == MessageRole::Tool)
                .expect("tool result");
            let ContentBlock::ToolResult {
                is_error,
                ref content,
                ..
            } = tool_msg.content[0]
            else {
                panic!("expected ToolResult");
            };
            assert!(!is_error, "codeMode MCP call must succeed: {content:?}");
            let payload_str = serde_json::to_string(content).unwrap();
            assert!(
                payload_str.contains("mcp__local_docs__lookup_doc")
                    && payload_str.contains("doc-body:quickjs"),
                "expected MCP output inside codeMode result: {payload_str}"
            );
            Ok(ProviderStepResult {
                assistant: assistant_msg(vec![ContentBlock::Text {
                    text: "MCP via codeMode succeeded.".to_owned(),
                    phase: None,
                    citations: Vec::new(),
                    provider_meta: ProviderOpaqueMeta::default(),
                }]),
                persisted_assistant: None,
                usage: TurnUsage::default(),
                continuation: None,
                raw_events: Vec::new(),
            })
        }),
    ]));

    let mut ctx_a = ToolExecutionContext::new_for_tests(
        iso.home.clone(),
        iso.ws.clone(),
        ProviderName::Openai,
        "gpt-5.4",
    );
    ctx_a.session_id = "sess-non-deferred-mcp".to_owned();
    ctx_a.env = env_map.clone();
    ctx_a.agent_config = Some(Arc::new(iso.cfg.clone()));
    ctx_a.mcp_tool_cache = Some(Arc::clone(&mcp_cache));

    let sink_a = Arc::new(RecordingSink::default());
    let im_a = Arc::new(InteractionManager::new(
        "sess-non-deferred-mcp",
        sink_a.clone(),
    ));
    let steer_a = Arc::new(SteerCoordinator::new(
        "sess-non-deferred-mcp",
        "t-a",
        sink_a.clone(),
        None,
    ));
    let mut cost_a = SessionCostTracker::new("sess-non-deferred-mcp", None);
    let runner_a = TurnStepRunner::new(TurnRunConfig {
        thread_id: "sess-non-deferred-mcp".to_owned(),
        turn_id: "t-a".to_owned(),
        provider: ProviderName::Openai,
        model_id: "gpt-5.4".to_owned(),
        base_url: None,
        api_key: None,
        extra_headers: HashMap::new(),
        system_prompt: "test".to_owned(),
        provider_options: Map::new(),
        deferred_tool_search: false,
        max_steps: 4,
        step_timeout_ms: 10_000,
        overflow_threshold_chars: None,
        tool_retry_lineage: false,
        initial_user_message: Some(("lookup quickjs doc".to_owned(), None)),
    });
    let out_a = runner_a
        .run_turn(
            non_deferred_transport,
            Vec::new(),
            &mut ctx_a,
            &im_a,
            &steer_a,
            &mut cost_a,
            None,
            sink_a,
        )
        .await;
    assert_eq!(out_a.status, "completed");

    // ------------------------------------------------------------------------
    // Part B: `SessionKind::Agent` + `read_only_role = true` with `deferred_tool_search = true` + `code_mode = true`
    // `codeMode` MUST be exposed on subagent & read-only roles while keeping `write` inaccessible!
    // ------------------------------------------------------------------------
    let mut ro_agent_cfg = iso.cfg.clone();
    ro_agent_cfg.tool_calling.deferred_tool_search = true;
    ro_agent_cfg.tool_calling.code_mode = true;

    let ro_agent_transport = Arc::new(QueueTransport::new(vec![
        Box::new(|req| {
            let names: Vec<&str> = req.tools.iter().map(|t| t.name.as_str()).collect();
            assert!(
                names.contains(&"codeMode"),
                "SessionKind::Agent + read_only_role MUST expose codeMode when enabled: {names:?}"
            );
            Ok(ProviderStepResult {
                assistant: assistant_msg(vec![ContentBlock::ToolCall {
                    id: "tc_ro_cm".to_owned(),
                    name: "codeMode".to_owned(),
                    arguments: serde_json::from_value(json!({
                        "code": r#"
                            const note: any = await tools.call("read", { filePath: "readonly_note.txt" });
                            let writeBlocked = false;
                            try {
                              await tools.call("write", { filePath: "blocked.txt", content: "nope" });
                            } catch {
                              writeBlocked = true;
                            }
                            return { note, writeBlocked };
                        "#
                    }))
                    .unwrap(),
                    partial_json: None,
                    provider_meta: ProviderOpaqueMeta::default(),
                }]),
                persisted_assistant: None,
                usage: TurnUsage::default(),
                continuation: None,
                raw_events: Vec::new(),
            })
        }),
        Box::new(|req| {
            let tool_msg = req
                .messages
                .iter()
                .find(|m| m.role == MessageRole::Tool)
                .expect("tool result");
            let ContentBlock::ToolResult {
                is_error,
                ref content,
                ..
            } = tool_msg.content[0]
            else {
                panic!("expected ToolResult");
            };
            assert!(
                !is_error,
                "read-only agent codeMode call must succeed: {content:?}"
            );
            let s = serde_json::to_string(content).unwrap();
            assert!(
                s.contains("safe-read-note") && s.contains("\\\"writeBlocked\\\":true"),
                "got {s}"
            );
            Ok(ProviderStepResult {
                assistant: assistant_msg(vec![ContentBlock::Text {
                    text: "Read-only agent codeMode done.".to_owned(),
                    phase: None,
                    citations: Vec::new(),
                    provider_meta: ProviderOpaqueMeta::default(),
                }]),
                persisted_assistant: None,
                usage: TurnUsage::default(),
                continuation: None,
                raw_events: Vec::new(),
            })
        }),
    ]));

    let mut ctx_b = ToolExecutionContext::new_for_tests(
        iso.home.clone(),
        iso.ws.clone(),
        ProviderName::Openai,
        "gpt-5.4",
    );
    ctx_b.session_id = "agent-ro-1".to_owned();
    ctx_b.session_kind = SessionKind::Agent;
    ctx_b.read_only_role = true;
    ctx_b.agent_config = Some(Arc::new(ro_agent_cfg));

    let sink_b = Arc::new(RecordingSink::default());
    let im_b = Arc::new(InteractionManager::new("agent-ro-1", sink_b.clone()));
    let steer_b = Arc::new(SteerCoordinator::new(
        "agent-ro-1",
        "t-b",
        sink_b.clone(),
        None,
    ));
    let mut cost_b = SessionCostTracker::new("agent-ro-1", None);
    let runner_b = TurnStepRunner::new(TurnRunConfig {
        thread_id: "agent-ro-1".to_owned(),
        turn_id: "t-b".to_owned(),
        provider: ProviderName::Openai,
        model_id: "gpt-5.4".to_owned(),
        base_url: None,
        api_key: None,
        extra_headers: HashMap::new(),
        system_prompt: "test".to_owned(),
        provider_options: Map::new(),
        deferred_tool_search: true,
        max_steps: 4,
        step_timeout_ms: 10_000,
        overflow_threshold_chars: None,
        tool_retry_lineage: false,
        initial_user_message: Some(("inspect readonly_note.txt".to_owned(), None)),
    });
    let out_b = runner_b
        .run_turn(
            ro_agent_transport,
            Vec::new(),
            &mut ctx_b,
            &im_b,
            &steer_b,
            &mut cost_b,
            None,
            sink_b,
        )
        .await;
    assert_eq!(out_b.status, "completed");

    mcp_task.abort();
}
