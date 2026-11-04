//! Codex app-server regressions: runtime resolution never searches `PATH`, cancelled/failed turns
//! interrupt then kill the whole app-server process tree, the mutation guard keeps YOLO turns on
//! approvals, Cowork's writable roots and developer instructions reach the app-server, MCP
//! elicitations are declined, natively accepted steers are covered by the continuation
//! fingerprint, and connector ids / reasoning efforts are validated.
#![cfg(unix)]

use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use cowork_config::SandboxMode;
use cowork_inference::{
    CanonicalMessage, ContentBlock, MessageRole, ProviderContinuationState, ProviderOpaqueMeta,
    ProviderTransportError, RequestPolicy, StepBudget,
};
use cowork_providers::codex_app_server::{
    CodexAppServerClient, CodexAppServerTransport, CodexNativeToolContext,
    CodexSandboxRestrictions, CodexTurnObserver, CodexTurnSteerParams, DynamicToolCallOutput,
    DynamicToolHandler, list_codex_models, resolve_codex_app_server_status, resolve_codex_home,
    set_openai_native_connector_enabled,
};
use cowork_providers::{
    ProviderStepRequest, ProviderStepResult, ProviderTransport, ToolDefinition,
};
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const MOCK: &str = r#"
import readline from "node:readline";
import fs from "node:fs";
import { spawn } from "node:child_process";

const [, , logPath, behavior, pidPath] = process.argv;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const log = (obj) => fs.appendFileSync(logPath, JSON.stringify(obj) + "\n");
const spawnGrandchild = () => {
  const child = spawn("sleep", ["300"], { stdio: "ignore" });
  fs.writeFileSync(pidPath, String(child.pid));
};
let threadId = null;

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (!msg.method) {
    log({ reply: msg.id, result: msg.result ?? null, error: msg.error ?? null });
    if (msg.id === "srv-elicit") {
      send({ method: "turn/completed", params: { threadId, turn: { id: "turn-1", status: "completed" } } });
    }
    return;
  }
  log({ method: msg.method, params: msg.params ?? null });
  if (msg.method === "initialize") {
    if (behavior === "thread_fail") spawnGrandchild();
    send({ id: msg.id, result: { serverInfo: { name: "mock-codex", version: "0.160.0" } } });
  } else if (msg.method === "thread/start") {
    if (behavior === "thread_fail") {
      send({ id: msg.id, error: { code: -32603, message: "boom: thread/start failed" } });
      return;
    }
    threadId = "thr-1";
    send({ id: msg.id, result: { thread: { id: threadId } } });
  } else if (msg.method === "thread/resume") {
    threadId = msg.params.threadId;
    send({ id: msg.id, result: { thread: { id: threadId } } });
  } else if (msg.method === "turn/start") {
    send({ id: msg.id, result: { turn: { id: "turn-1" } } });
    if (behavior === "hang" || behavior === "hang_ignore_interrupt") {
      spawnGrandchild();
      return;
    }
    if (behavior === "steer") return;
    if (behavior === "elicit") {
      send({ id: "srv-elicit", method: "mcpServer/elicitation/request", params: { threadId, turnId: "turn-1", serverName: "docs", message: "Pick one" } });
      return;
    }
    send({ method: "item/agentMessage/delta", params: { threadId, turnId: "turn-1", itemId: "a1", delta: "done" } });
    send({ method: "turn/completed", params: { threadId, turn: { id: "turn-1", status: "completed" } } });
  } else if (msg.method === "turn/steer") {
    send({ id: msg.id, result: { turnId: "turn-1" } });
    send({ method: "item/agentMessage/delta", params: { threadId, turnId: "turn-1", itemId: "a1", delta: "steered" } });
    send({ method: "turn/completed", params: { threadId, turn: { id: "turn-1", status: "completed" } } });
  } else if (msg.method === "turn/interrupt") {
    if (behavior === "hang_ignore_interrupt") return;
    send({ id: msg.id, result: {} });
    send({ method: "turn/completed", params: { threadId, turn: { id: "turn-1", status: "interrupted" } } });
  } else if (msg.method === "model/list") {
    send({ id: msg.id, result: { data: [{ id: "gpt-x", supportedReasoningEfforts: ["light", "high", "bogus"], defaultReasoningEffort: "light" }], nextCursor: null } });
  } else if (msg.id !== undefined && msg.id !== null) {
    send({ id: msg.id, result: {} });
  }
});
"#;

struct Fixture {
    base: PathBuf,
    script: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let base = std::env::temp_dir().join(format!("cowork-codex-review-{}", Uuid::new_v4()));
        std::fs::create_dir_all(base.join("workspace")).unwrap();
        std::fs::create_dir_all(base.join("home/.cowork")).unwrap();
        let base = std::fs::canonicalize(&base).unwrap();
        let script = base.join("mock_codex.mjs");
        std::fs::write(&script, MOCK).unwrap();
        Self { base, script }
    }

    fn workspace(&self) -> PathBuf {
        self.base.join("workspace")
    }

    fn cowork_home(&self) -> PathBuf {
        self.base.join("home/.cowork")
    }

    fn log_path(&self, behavior: &str) -> PathBuf {
        self.base.join(format!("{behavior}.log"))
    }

    fn pid_path(&self, behavior: &str) -> PathBuf {
        self.base.join(format!("{behavior}.pid"))
    }

    fn logged(&self, behavior: &str) -> Vec<Value> {
        std::fs::read_to_string(self.log_path(behavior))
            .unwrap_or_default()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    fn logged_method(&self, behavior: &str, method: &str) -> Vec<Value> {
        self.logged(behavior)
            .into_iter()
            .filter(|v| v["method"] == method)
            .map(|v| v["params"].clone())
            .collect()
    }

    fn env(&self) -> HashMap<String, String> {
        let mut env = HashMap::new();
        env.insert(
            "PATH".into(),
            std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".into()),
        );
        env.insert(
            "HOME".into(),
            self.base.join("home").to_string_lossy().into(),
        );
        env
    }

    fn args(&self, behavior: &str) -> Vec<String> {
        vec![
            self.script.to_string_lossy().into_owned(),
            self.log_path(behavior).to_string_lossy().into_owned(),
            behavior.into(),
            self.pid_path(behavior).to_string_lossy().into_owned(),
        ]
    }

    fn transport(&self, behavior: &str) -> CodexAppServerTransport {
        let mut transport =
            CodexAppServerTransport::with_command_override("node".into(), self.args(behavior));
        transport.env_override = Some(self.env());
        transport
    }

    fn request(
        &self,
        system_prompt: &str,
        messages: Vec<CanonicalMessage>,
        tools: Vec<ToolDefinition>,
        continuation: Option<ProviderContinuationState>,
    ) -> ProviderStepRequest {
        let mut opts = Map::new();
        opts.insert("cwd".into(), json!(self.workspace().to_string_lossy()));
        opts.insert(
            "coworkHome".into(),
            json!(self.cowork_home().to_string_lossy()),
        );
        ProviderStepRequest {
            model_id: "gpt-5.6-sol".into(),
            base_url: None,
            api_key: None,
            extra_headers: HashMap::new(),
            system_prompt: system_prompt.into(),
            messages,
            tools,
            authorized_tool_names: None,
            provider_options: opts,
            continuation,
            policy: RequestPolicy::default(),
            turn_id: "turn-review".into(),
        }
    }

    async fn run(
        &self,
        transport: &CodexAppServerTransport,
        request: ProviderStepRequest,
        budget: &StepBudget,
    ) -> Result<ProviderStepResult, ProviderTransportError> {
        transport.stream_step(request, budget, &mut |_| {}).await
    }

    /// Waits until the mock reported its grandchild's pid.
    async fn grandchild_pid(&self, behavior: &str) -> u32 {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Ok(raw) = std::fs::read_to_string(self.pid_path(behavior))
                && let Ok(pid) = raw.trim().parse()
            {
                return pid;
            }
            assert!(
                Instant::now() < deadline,
                "mock never spawned its grandchild"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.base);
    }
}

fn text_msg(id: &str, role: MessageRole, text: &str) -> CanonicalMessage {
    CanonicalMessage {
        id: id.into(),
        role,
        content: vec![ContentBlock::Text {
            text: text.into(),
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
        created_at: "2026-11-01T00:00:00Z".into(),
    }
}

/// True once `pid` is gone (or only a zombie awaiting a reaper).
fn process_dead(pid: u32) -> bool {
    if !cfg!(target_os = "linux") {
        // No procfs: `kill -0` fails once the process no longer exists.
        return !std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|s| s.success());
    }
    match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Err(_) => true,
        Ok(stat) => stat
            .rsplit_once(')')
            .and_then(|(_, rest)| rest.split_whitespace().next())
            .is_some_and(|state| state == "Z" || state == "X"),
    }
}

async fn assert_process_dies(pid: u32) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !process_dead(pid) {
        if Instant::now() >= deadline {
            let _ = std::process::Command::new("kill")
                .args(["-9", &pid.to_string()])
                .status();
            panic!("app-server grandchild {pid} outlived the closed client");
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

struct GuardedBridge {
    ctx: CodexNativeToolContext,
}

#[async_trait]
impl DynamicToolHandler for GuardedBridge {
    async fn call_tool(
        &self,
        _name: &str,
        _arguments: Map<String, Value>,
    ) -> DynamicToolCallOutput {
        DynamicToolCallOutput {
            text: "ok".into(),
            is_error: false,
        }
    }

    fn native_tool_context(&self) -> CodexNativeToolContext {
        self.ctx.clone()
    }

    async fn request_user_input(&self, _method: &str, _params: &Value) -> Value {
        json!({ "answers": { "routed": true } })
    }
}

fn ask_tool() -> ToolDefinition {
    ToolDefinition {
        name: "AskUserQuestion".into(),
        description: "Ask the user".into(),
        parameters: json!({ "type": "object", "properties": {} }),
    }
}

#[test]
fn runtime_status_never_falls_back_to_a_codex_binary_on_path() {
    let fx = Fixture::new();
    let bin = fx.base.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let foreign = bin.join("codex");
    std::fs::write(&foreign, "#!/bin/sh\nexit 0\n").unwrap();
    std::fs::set_permissions(&foreign, std::fs::Permissions::from_mode(0o755)).unwrap();

    // Absolute, relative and empty PATH segments must all be ignored.
    let mut env = HashMap::new();
    env.insert("PATH".into(), format!("{}::.:bin", bin.display()));
    let status = resolve_codex_app_server_status(&fx.cowork_home(), &env);
    assert!(!status.available, "{status:?}");
    assert_eq!(status.source, "missing");
    assert_eq!(status.command, None);
    assert!(
        status.message.contains("has not been downloaded yet"),
        "{status:?}"
    );

    // The explicit override still wins.
    env.insert(
        "COWORK_CODEX_APP_SERVER_BIN".into(),
        foreign.to_string_lossy().into_owned(),
    );
    let status = resolve_codex_app_server_status(&fx.cowork_home(), &env);
    assert!(status.available);
    assert_eq!(status.source, "override");
    assert_eq!(
        status.command.as_deref(),
        Some(foreign.to_string_lossy().as_ref())
    );
}

#[tokio::test]
async fn mutation_guard_keeps_yolo_on_request_and_forwards_cowork_roots_and_instructions() {
    let fx = Fixture::new();
    let output_dir = fx.workspace().join("output");
    let uploads_dir = fx.base.join("uploads");
    let system = "Intro\n\n## Shell Execution Policy\nUse PowerShell rules.\n\n## Other\nKeep me.";
    let fx_ref = &fx;
    let run = |guard: bool, behavior: &'static str| {
        let fx = fx_ref;
        let mut transport = fx.transport(behavior);
        transport.tool_handler = Some(Arc::new(GuardedBridge {
            ctx: CodexNativeToolContext {
                has_mutation_guard: guard,
                writable_roots: vec![
                    fx.workspace(),
                    output_dir.clone(),
                    uploads_dir.clone(),
                    PathBuf::from("/tmp"),
                ],
            },
        }));
        transport.sandbox_restrictions = Some(CodexSandboxRestrictions {
            mode: Some(SandboxMode::WorkspaceWrite),
            network: Some(true),
            yolo: Some(true),
            ..CodexSandboxRestrictions::default()
        });
        let request = fx.request(
            system,
            vec![text_msg("u1", MessageRole::User, "hi")],
            vec![ask_tool()],
            None,
        );
        async move {
            fx.run(&transport, request, &StepBudget::unbounded(None))
                .await
                .expect("turn succeeds")
        }
    };

    run(true, "default").await;
    let thread = &fx.logged_method("default", "thread/start")[0];
    assert_eq!(thread["approvalPolicy"], "on-request", "{thread}");
    let turn = &fx.logged_method("default", "turn/start")[0];
    assert_eq!(turn["approvalPolicy"], "on-request");
    let roots: Vec<String> = turn["sandboxPolicy"]["writableRoots"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r.as_str().unwrap().to_owned())
        .collect();
    assert_eq!(roots[0], fx.workspace().to_string_lossy());
    assert!(
        roots.contains(&output_dir.to_string_lossy().into_owned()),
        "{roots:?}"
    );
    assert!(
        roots.contains(&uploads_dir.to_string_lossy().into_owned()),
        "{roots:?}"
    );
    for root in &roots {
        assert!(
            !fx.workspace().starts_with(root) || Path::new(root) == fx.workspace(),
            "root {root} widens the workspace"
        );
    }

    let instructions = thread["developerInstructions"].as_str().unwrap();
    assert!(
        instructions.starts_with("## Codex App-Server Tool Boundary\n\n"),
        "{instructions}"
    );
    assert!(
        instructions.contains("Available Cowork dynamic tools for this turn: `AskUserQuestion`.")
    );
    assert!(instructions.contains("call Cowork's dynamic `AskUserQuestion` tool directly"));
    assert!(instructions.contains("Never call the native `request_user_input` tool"));
    assert!(
        !instructions.contains("Shell Execution Policy"),
        "{instructions}"
    );
    assert!(!instructions.contains("PowerShell"), "{instructions}");
    assert!(
        instructions.ends_with("Intro\n## Other\nKeep me."),
        "{instructions}"
    );

    // Without a mutation guard, YOLO keeps Codex's approvals off.
    run(false, "unguarded").await;
    let thread = &fx.logged_method("unguarded", "thread/start")[0];
    assert_eq!(thread["approvalPolicy"], "never");
}

#[tokio::test]
async fn mcp_elicitation_is_declined_without_reaching_the_user_input_bridge() {
    let fx = Fixture::new();
    let mut transport = fx.transport("elicit");
    transport.tool_handler = Some(Arc::new(GuardedBridge {
        ctx: CodexNativeToolContext::default(),
    }));
    let request = fx.request(
        "sys",
        vec![text_msg("u1", MessageRole::User, "hi")],
        Vec::new(),
        None,
    );
    fx.run(&transport, request, &StepBudget::unbounded(None))
        .await
        .expect("turn succeeds");
    let reply = fx
        .logged("elicit")
        .into_iter()
        .find(|v| v["reply"] == "srv-elicit")
        .expect("elicitation answered");
    assert_eq!(
        reply["result"],
        json!({ "action": "decline", "content": null, "_meta": null })
    );
}

struct SteerOnStart {
    text: &'static str,
}

impl CodexTurnObserver for SteerOnStart {
    fn on_turn_started(
        &self,
        client: Arc<CodexAppServerClient>,
        codex_thread_id: &str,
        codex_turn_id: Option<&str>,
    ) {
        let params = CodexTurnSteerParams {
            thread_id: codex_thread_id.to_owned(),
            expected_turn_id: codex_turn_id.unwrap().to_owned(),
            input_text: self.text.to_owned(),
            input: Vec::new(),
        };
        tokio::spawn(async move {
            client.steer_turn(params).await.expect("steer accepted");
        });
    }
}

#[tokio::test]
async fn natively_accepted_steer_is_covered_by_the_continuation_fingerprint() {
    let fx = Fixture::new();
    let mut transport = fx.transport("steer");
    transport.turn_observer = Some(Arc::new(SteerOnStart {
        text: "also add tests",
    }));
    let first_user = text_msg("u1", MessageRole::User, "fix the bug");
    let result = fx
        .run(
            &transport,
            fx.request("sys", vec![first_user.clone()], Vec::new(), None),
            &StepBudget::unbounded(None),
        )
        .await
        .expect("steered turn succeeds");
    let assistant = result
        .persisted_assistant
        .clone()
        .unwrap_or_else(|| result.assistant.clone());

    // The harness records the steer (fresh id and timestamp) ahead of the assistant output.
    let steer_msg = CanonicalMessage {
        created_at: "2026-11-03T12:34:56Z".into(),
        ..text_msg(
            &Uuid::new_v4().to_string(),
            MessageRole::User,
            "also add tests",
        )
    };
    let follow_up = text_msg("u2", MessageRole::User, "thanks, now ship it");

    let resumed = fx.transport("follow_up");
    fx.run(
        &resumed,
        fx.request(
            "sys",
            vec![
                first_user.clone(),
                steer_msg,
                assistant.clone(),
                follow_up.clone(),
            ],
            Vec::new(),
            result.continuation.clone(),
        ),
        &StepBudget::unbounded(None),
    )
    .await
    .expect("follow-up succeeds");
    let resumes = fx.logged_method("follow_up", "thread/resume");
    assert_eq!(resumes.len(), 1, "{:?}", fx.logged("follow_up"));
    assert_eq!(resumes[0]["threadId"], "thr-1");
    assert!(fx.logged_method("follow_up", "thread/start").is_empty());
    let turn = &fx.logged_method("follow_up", "turn/start")[0];
    assert_eq!(turn["input"].as_array().unwrap().len(), 1, "{turn}");
    assert_eq!(turn["input"][0]["text"], "thanks, now ship it");

    // History that lacks the steered message no longer matches the stored thread.
    let mismatch = fx.transport("mismatch");
    fx.run(
        &mismatch,
        fx.request(
            "sys",
            vec![first_user, assistant, follow_up],
            Vec::new(),
            result.continuation,
        ),
        &StepBudget::unbounded(None),
    )
    .await
    .expect("mismatched follow-up succeeds");
    assert!(fx.logged_method("mismatch", "thread/resume").is_empty());
    assert_eq!(fx.logged_method("mismatch", "thread/start").len(), 1);
}

async fn run_cancelled(fx: &Fixture, behavior: &'static str) -> (ProviderTransportError, u32) {
    let transport = fx.transport(behavior);
    let cancel = CancellationToken::new();
    let budget = StepBudget::unbounded(Some(cancel.clone()));
    let request = fx.request(
        "sys",
        vec![text_msg("u1", MessageRole::User, "run forever")],
        Vec::new(),
        None,
    );
    let (res, pid) = tokio::join!(fx.run(&transport, request, &budget), async {
        let pid = fx.grandchild_pid(behavior).await;
        cancel.cancel();
        pid
    });
    (res.expect_err("cancelled turn must not succeed"), pid)
}

#[tokio::test]
async fn cancelled_turn_interrupts_then_kills_the_app_server_process_tree() {
    let fx = Fixture::new();
    let (err, pid) = run_cancelled(&fx, "hang").await;
    assert!(err.is_abort, "{err:?}");
    let interrupts = fx.logged_method("hang", "turn/interrupt");
    assert_eq!(interrupts.len(), 1, "{:?}", fx.logged("hang"));
    assert_eq!(interrupts[0]["threadId"], "thr-1");
    assert_eq!(interrupts[0]["turnId"], "turn-1");
    assert_process_dies(pid).await;
}

#[tokio::test]
async fn unresponsive_interrupt_is_bounded_before_the_tree_kill() {
    let fx = Fixture::new();
    let started = Instant::now();
    let (err, pid) = run_cancelled(&fx, "hang_ignore_interrupt").await;
    assert!(err.is_abort, "{err:?}");
    assert!(
        started.elapsed() < Duration::from_secs(15),
        "cancel took {:?}",
        started.elapsed()
    );
    assert_eq!(
        fx.logged_method("hang_ignore_interrupt", "turn/interrupt")
            .len(),
        1
    );
    assert_process_dies(pid).await;
}

#[tokio::test]
async fn startup_rpc_failure_closes_the_app_server_tree() {
    let fx = Fixture::new();
    let transport = fx.transport("thread_fail");
    let err = fx
        .run(
            &transport,
            fx.request(
                "sys",
                vec![text_msg("u1", MessageRole::User, "hi")],
                Vec::new(),
                None,
            ),
            &StepBudget::unbounded(None),
        )
        .await
        .expect_err("thread/start failure surfaces");
    assert!(err.message.contains("thread/start failed"), "{err:?}");
    let pid = fx.grandchild_pid("thread_fail").await;
    assert_process_dies(pid).await;
}

#[tokio::test]
async fn connector_ids_cannot_inject_config_key_segments_and_light_effort_is_kept() {
    let fx = Fixture::new();
    let client = CodexAppServerClient::spawn_stdio(
        "node",
        &fx.args("connectors"),
        &fx.workspace(),
        &fx.cowork_home(),
        &fx.env(),
        None,
    )
    .await
    .expect("mock app-server starts");
    let codex_home = resolve_codex_home(&fx.cowork_home());
    for bad in [
        "",
        "  ",
        "gmail.enabled",
        "a\u{7}b",
        "x\ny",
        "a b",
        "a\"b",
        "a[0]",
    ] {
        let err = set_openai_native_connector_enabled("s1", &codex_home, &client, bad, false)
            .await
            .expect_err("invalid connector id rejected");
        assert!(err.message.contains("connectorId"), "{bad:?}: {err:?}");
    }
    assert!(
        fx.logged_method("connectors", "config/value/write")
            .is_empty()
    );

    let models = list_codex_models(&client, Duration::from_secs(10))
        .await
        .expect("model/list");
    let reasoning = models[0].reasoning.as_ref().expect("reasoning efforts");
    assert_eq!(
        reasoning.available_efforts.as_deref(),
        Some(&["light".to_owned(), "high".to_owned()][..])
    );
    assert_eq!(reasoning.default_effort.as_deref(), Some("light"));
    client.close().await;
}
