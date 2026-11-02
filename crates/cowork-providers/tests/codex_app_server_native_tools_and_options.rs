//! Codex app-server native tool activity (`commandExecution` / `fileChange` / `mcpToolCall`
//! items and their output deltas) projected into tool stream events, plus the
//! `reasoningSummary` -> `turn/start.summary` and `textVerbosity` / `webSearchMode` / `webSearch`
//! thread `config` mappings, todo-list updates, `error` notifications and code-mode raw items,
//! driven by a mocked stdio app-server.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use cowork_inference::{
    CanonicalMessage, ClientCapabilities, ContentBlock, MessageRole, ProviderOpaqueMeta,
    RequestPolicy, StepBudget, StreamEvent, StreamEventProjector,
};
use cowork_providers::codex_app_server::{CodexAppServerTransport, CodexTodosCallback};
use cowork_providers::{ProviderStepRequest, ProviderStepResult, ProviderTransport};
use serde_json::{Map, Value, json};
use uuid::Uuid;

/// Mock app-server; logs every client request to `logPath`. `behavior`:
/// - `tools`: reasoning, a successful and a failed shell command with streamed output, a file
///   edit, an MCP call, another turn's command (ignored), then the final answer.
/// - `todos`: `todoList` updates (notification, item completion, another turn's update).
/// - `error`: a running shell command interrupted by an `error` notification.
/// - `codemode`: code-mode `exec` / `wait` raw items with nested dynamic tool calls.
/// - anything else: a plain one-message turn.
const NATIVE_TOOLS_MOCK: &str = r#"
import readline from "node:readline";
import fs from "node:fs";

const [, , logPath, behavior] = process.argv;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const threadId = "thr-1";
const turnId = "turn-1";
const note = (method, params) => send({ method, params: { threadId, turnId, ...params } });

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method) fs.appendFileSync(logPath, JSON.stringify({ method: msg.method, params: msg.params ?? null }) + "\n");
  if (msg.method === "initialize") {
    send({ id: msg.id, result: { serverInfo: { name: "mock-codex", version: "0.160.0" } } });
  } else if (msg.method === "thread/start") {
    send({ id: msg.id, result: { thread: { id: threadId } } });
  } else if (msg.method === "turn/start") {
    send({ id: msg.id, result: { turn: { id: turnId } } });
    if (behavior === "tools") {
      note("item/reasoning/summaryTextDelta", { itemId: "r1", delta: "Inspect first." });
      const cmd = { type: "commandExecution", id: "cmd1", command: "ls -la", cwd: "/w", status: "inProgress" };
      note("item/started", { item: cmd });
      note("item/commandExecution/outputDelta", { itemId: "cmd1", delta: "a.rs\n" });
      note("item/commandExecution/outputDelta", { itemId: "cmd1", delta: "b.rs\n" });
      note("item/completed", { item: { ...cmd, status: "completed", aggregatedOutput: "a.rs\nb.rs\n", exitCode: 0 } });
      const bad = { type: "commandExecution", id: "cmd2", command: "cat /root/x", cwd: "/w", status: "inProgress" };
      note("item/started", { item: bad });
      note("item/completed", { item: { ...bad, status: "failed", aggregatedOutput: "permission denied", exitCode: 1 } });
      const changes = [{ path: "src/a.rs", kind: { type: "update" }, diff: "@@ -1 +1 @@\n-a\n+b\n" }];
      note("item/started", { item: { type: "fileChange", id: "fc1", changes, status: "inProgress" } });
      note("item/completed", { item: { type: "fileChange", id: "fc1", changes, status: "completed" } });
      const mcp = { type: "mcpToolCall", id: "mcp1", server: "docs", tool: "search", arguments: { q: "rust" }, status: "inProgress" };
      note("item/started", { item: mcp });
      note("item/completed", { item: { ...mcp, status: "completed", result: { content: [{ type: "text", text: "hit" }] } } });
      // Another turn's tool activity on the shared connection is ignored.
      send({ method: "item/started", params: { threadId, turnId: "turn-other", item: { type: "commandExecution", id: "x1", command: "rm -rf /", status: "inProgress" } } });
    } else if (behavior === "todos") {
      note("item/todoList/updated", { todos: [
        { content: "Read code", status: "completed" },
        { title: "Write fix", status: "in-progress", active_form: "Writing fix" },
        { text: "Ship", status: "weird" },
        { status: "pending" },
      ] });
      send({ method: "todoList/updated", params: { threadId, turnId: "turn-other", todos: [{ content: "foreign" }] } });
      note("item/completed", { item: { type: "todoList", id: "td1", items: [{ task: "Ship", status: "done" }] } });
      note("todoList/updated", { todos: [{ status: "pending" }] });
    } else if (behavior === "error") {
      const cmd = { type: "commandExecution", id: "cmd9", command: "sleep 9", cwd: "/w", status: "inProgress" };
      note("item/started", { item: cmd });
      send({ method: "error", params: { threadId, turnId: "turn-other", error: { message: "not ours" }, willRetry: false } });
      note("error", { error: { message: "stream disconnected" }, willRetry: true });
    } else if (behavior === "codemode") {
      const raw = (item) => note("rawResponseItem/completed", { item });
      const cited = { contentItems: [{ type: "inputText", text: "cite:\n[Docs](https://docs.rs/x) turn0search0" }] };
      // A script whose nested tool runs inside its cell: folded into the script.
      raw({ type: "custom_tool_call", call_id: "e1", name: "exec", input: "const r = await tools.webSearch({ q: 'x' });\nreturn r;" });
      raw({ type: "custom_tool_call_output", call_id: "e1", output: "Script running with cell ID c1" });
      note("item/started", { item: { type: "dynamicToolCall", id: "d1", tool: "webSearch", arguments: { q: "x" } } });
      note("item/completed", { item: { type: "dynamicToolCall", id: "d1", tool: "webSearch", arguments: { q: "x" }, success: true, ...cited } });
      // A script whose nested tool surfaces on its own: the script is not shown twice.
      raw({ type: "custom_tool_call", call_id: "e2", name: "exec", input: { code: "await tools.read({ path: 'a' })" } });
      note("item/started", { item: { type: "dynamicToolCall", id: "d2", tool: "read", arguments: { path: "a" } } });
      note("item/completed", { item: { type: "dynamicToolCall", id: "d2", tool: "read", arguments: { path: "a" }, success: true, ...cited } });
      raw({ type: "custom_tool_call_output", call_id: "e2", output: "ok" });
      // A wait for an unknown cell still shows as a code execution.
      raw({ type: "function_call", call_id: "w9", name: "wait", arguments: "{\"cell_id\":\"zz\"}" });
      raw({ type: "function_call_output", call_id: "w9", output: "late" });
      // Waiting on the running cell completes the first script with the nested citations.
      raw({ type: "function_call", call_id: "w1", name: "wait", arguments: "{\"cell_id\":\"c1\"}" });
      raw({ type: "function_call_output", call_id: "w1", output: "final" });
    }
    note("item/agentMessage/delta", { itemId: "f1", delta: "Done." });
    send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
  } else if (msg.id !== undefined && msg.method) {
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
        let base =
            std::env::temp_dir().join(format!("cowork-codex-native-tools-{}", Uuid::new_v4()));
        std::fs::create_dir_all(base.join("workspace")).unwrap();
        std::fs::create_dir_all(base.join("home/.cowork")).unwrap();
        let base = std::fs::canonicalize(&base).unwrap();
        let script = base.join("mock_codex_native_tools.mjs");
        std::fs::write(&script, NATIVE_TOOLS_MOCK).unwrap();
        Self { base, script }
    }

    fn log_path(&self, run: &str) -> PathBuf {
        self.base.join(format!("{run}.log"))
    }

    fn logged(&self, run: &str, method: &str) -> Value {
        std::fs::read_to_string(self.log_path(run))
            .unwrap_or_default()
            .lines()
            .map(|l| serde_json::from_str::<Value>(l).unwrap())
            .find(|m| m["method"] == method)
            .unwrap_or_else(|| panic!("{run}: no {method} request"))["params"]
            .clone()
    }

    async fn run(
        &self,
        run: &str,
        behavior: &str,
        model_id: &str,
        codex_options: Value,
        built_in_dir: Option<PathBuf>,
    ) -> (ProviderStepResult, Vec<StreamEvent>) {
        self.run_with(
            run,
            behavior,
            model_id,
            codex_options,
            built_in_dir,
            Map::new(),
            None,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn run_with(
        &self,
        run: &str,
        behavior: &str,
        model_id: &str,
        codex_options: Value,
        built_in_dir: Option<PathBuf>,
        top_level_options: Map<String, Value>,
        todos: Option<CodexTodosCallback>,
    ) -> (ProviderStepResult, Vec<StreamEvent>) {
        let mut opts = top_level_options;
        opts.insert(
            "cwd".into(),
            json!(self.base.join("workspace").to_string_lossy()),
        );
        opts.insert(
            "coworkHome".into(),
            json!(self.base.join("home/.cowork").to_string_lossy()),
        );
        opts.insert("codex-cli".into(), codex_options);
        let mut env = HashMap::new();
        env.insert(
            "PATH".into(),
            std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".into()),
        );
        env.insert(
            "HOME".into(),
            self.base.join("home").to_string_lossy().into(),
        );
        let mut transport = CodexAppServerTransport::with_command_override(
            "node".into(),
            vec![
                self.script.to_string_lossy().into_owned(),
                self.log_path(run).to_string_lossy().into_owned(),
                behavior.into(),
            ],
        )
        .with_built_in_dir(built_in_dir)
        .with_todos_handler(todos);
        transport.env_override = Some(env);
        let mut events = Vec::new();
        let result = transport
            .stream_step(
                ProviderStepRequest {
                    model_id: model_id.into(),
                    base_url: None,
                    api_key: None,
                    extra_headers: HashMap::new(),
                    system_prompt: "Instructions".into(),
                    messages: vec![user_message("list the files")],
                    tools: Vec::new(),
                    authorized_tool_names: None,
                    provider_options: opts,
                    continuation: None,
                    policy: RequestPolicy::default(),
                    turn_id: "turn-native".into(),
                },
                &StepBudget::new(60_000, None),
                &mut |ev| events.push(ev),
            )
            .await
            .expect("codex turn succeeds");
        (result, events)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.base);
    }
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn user_message(text: &str) -> CanonicalMessage {
    CanonicalMessage {
        id: "u1".into(),
        role: MessageRole::User,
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
        created_at: "2026-11-02T00:00:00Z".into(),
    }
}

/// Compact view of tool events: `(kind, key, name, payload)`.
fn tool_events(events: &[StreamEvent]) -> Vec<(&'static str, String, String, Value)> {
    events
        .iter()
        .filter_map(|ev| match ev {
            StreamEvent::ToolCallStart {
                key,
                name,
                initial_args,
                ..
            } => Some((
                "start",
                key.clone(),
                name.clone(),
                json!(initial_args.clone().unwrap_or_default()),
            )),
            StreamEvent::ToolCallEnd {
                key,
                name,
                arguments,
                ..
            } => Some((
                "end",
                key.clone(),
                name.clone(),
                json!(arguments.clone().unwrap_or_default()),
            )),
            StreamEvent::ToolResult {
                key,
                name,
                result,
                is_error,
                ..
            } => Some((
                if *is_error { "error" } else { "result" },
                key.clone(),
                name.clone(),
                result.clone(),
            )),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn codex_native_tool_items_stream_as_tool_events_and_project_into_the_transcript() {
    let fx = Fixture::new();
    let (result, events) = fx
        .run("tools", "tools", "gpt-5.6-sol", json!({}), None)
        .await;

    let cmd_args = json!({ "command": "ls -la", "cwd": "/w" });
    let bad_args = json!({ "command": "cat /root/x", "cwd": "/w" });
    let fc_args = json!({ "paths": ["src/a.rs"] });
    let changes = json!([{ "path": "src/a.rs", "kind": { "type": "update" }, "diff": "@@ -1 +1 @@\n-a\n+b\n" }]);
    let mcp_args = json!({ "q": "rust" });
    let s = |v: &str| v.to_owned();
    assert_eq!(
        tool_events(&events),
        vec![
            ("start", s("cmd1"), s("commandExecution"), cmd_args.clone()),
            ("end", s("cmd1"), s("commandExecution"), cmd_args),
            // Streamed output accumulates as provisional results.
            ("result", s("cmd1"), s("commandExecution"), json!("a.rs\n")),
            (
                "result",
                s("cmd1"),
                s("commandExecution"),
                json!("a.rs\nb.rs\n")
            ),
            (
                "result",
                s("cmd1"),
                s("commandExecution"),
                json!("a.rs\nb.rs\n")
            ),
            ("start", s("cmd2"), s("commandExecution"), bad_args.clone()),
            ("end", s("cmd2"), s("commandExecution"), bad_args),
            (
                "error",
                s("cmd2"),
                s("commandExecution"),
                json!({ "error": "permission denied" })
            ),
            ("start", s("fc1"), s("fileChange"), fc_args.clone()),
            ("end", s("fc1"), s("fileChange"), fc_args),
            ("result", s("fc1"), s("fileChange"), changes),
            ("start", s("mcp1"), s("docs.search"), mcp_args.clone()),
            ("end", s("mcp1"), s("docs.search"), mcp_args),
            (
                "result",
                s("mcp1"),
                s("docs.search"),
                json!({ "content": [{ "type": "text", "text": "hit" }] })
            ),
        ]
    );

    // Reasoning closes before the first tool, as it does before assistant text.
    let thinking_end = events
        .iter()
        .position(|ev| matches!(ev, StreamEvent::ThinkingEnd { .. }))
        .expect("reasoning closed");
    let first_tool = events
        .iter()
        .position(|ev| matches!(ev, StreamEvent::ToolCallStart { .. }))
        .unwrap();
    assert!(thinking_end < first_tool);

    // Provider-executed activity is never handed to the harness as calls to run.
    assert!(
        !result
            .assistant
            .content
            .iter()
            .any(|b| matches!(b, ContentBlock::ToolCall { .. }))
    );
    assert!(
        result
            .assistant
            .content
            .iter()
            .any(|b| matches!(b, ContentBlock::Text { text, .. } if text == "Done."))
    );

    // The live/journal projection ends each tool item in its terminal state.
    let mut projector = StreamEventProjector::new("thr", ClientCapabilities::default());
    let mut final_items: HashMap<String, Value> = HashMap::new();
    for ev in &events {
        for n in projector.project(ev) {
            let item = &n.params["item"];
            if n.method == "item/completed" && item["type"] == "toolCall" {
                final_items.insert(
                    item["toolName"].as_str().unwrap().to_owned()
                        + "|"
                        + item["id"].as_str().unwrap(),
                    item.clone(),
                );
            }
        }
    }
    let by_tool = |name: &str| -> Vec<Value> {
        final_items
            .iter()
            .filter(|(k, _)| k.starts_with(&format!("{name}|")))
            .map(|(_, v)| v.clone())
            .collect()
    };
    let commands = by_tool("commandExecution");
    assert_eq!(commands.len(), 2, "one transcript item per command");
    assert!(commands.iter().any(|c| c["state"] == "output-available"
        && c["result"] == "a.rs\nb.rs\n"
        && c["args"]["command"] == "ls -la"));
    assert!(
        commands
            .iter()
            .any(|c| c["state"] == "output-error" && c["result"]["error"] == "permission denied")
    );
    assert_eq!(by_tool("fileChange")[0]["state"], "output-available");
    assert_eq!(by_tool("docs.search")[0]["args"]["q"], "rust");
}

#[tokio::test]
async fn codex_forwards_reasoning_summary_and_text_verbosity_to_the_app_server() {
    let fx = Fixture::new();
    let root = Some(repo_root());

    // Registry model declaring a `reasoningSummary` default.
    fx.run(
        "sol",
        "plain",
        "gpt-5.6-sol",
        json!({ "reasoningSummary": "concise", "textVerbosity": "low" }),
        root.clone(),
    )
    .await;
    assert_eq!(fx.logged("sol", "turn/start")["summary"], "concise");
    assert_eq!(
        fx.logged("sol", "thread/start")["config"]["model_verbosity"],
        "low"
    );

    // A registry model without a `reasoningSummary` default never receives one.
    fx.run(
        "spark",
        "plain",
        "gpt-5.3-codex-spark",
        json!({ "reasoningSummary": "detailed", "textVerbosity": "high" }),
        root.clone(),
    )
    .await;
    assert!(fx.logged("spark", "turn/start").get("summary").is_none());
    assert_eq!(
        fx.logged("spark", "thread/start")["config"]["model_verbosity"],
        "high"
    );

    // Models unknown to the registry pass valid values through; invalid values are dropped.
    fx.run(
        "unknown",
        "plain",
        "gpt-future",
        json!({ "reasoningSummary": "auto", "textVerbosity": "medium" }),
        root,
    )
    .await;
    assert_eq!(fx.logged("unknown", "turn/start")["summary"], "auto");
    assert_eq!(
        fx.logged("unknown", "thread/start")["config"]["model_verbosity"],
        "medium"
    );
    fx.run(
        "invalid",
        "plain",
        "gpt-5.6-sol",
        json!({ "reasoningSummary": "Verbose", "textVerbosity": "max" }),
        None,
    )
    .await;
    assert!(fx.logged("invalid", "turn/start").get("summary").is_none());
    assert!(
        fx.logged("invalid", "thread/start")["config"]
            .get("model_verbosity")
            .is_none()
    );
}

#[tokio::test]
async fn codex_forwards_web_search_mode_tool_config_and_disables_multi_agent() {
    let fx = Fixture::new();
    let web_options = json!({
        "webSearchMode": "live",
        "webSearch": {
            "contextSize": "high",
            "allowedDomains": ["docs.rs", "", 7],
            "location": { "country": "US", "city": "", "timezone": "America/New_York" },
        },
    });

    // Network allowed: the mode and the tool config pass through.
    let mut network = Map::new();
    network.insert("sandboxNetwork".into(), json!(true));
    fx.run_with(
        "net",
        "plain",
        "gpt-5.6-sol",
        web_options.clone(),
        None,
        network,
        None,
    )
    .await;
    let thread = fx.logged("net", "thread/start");
    assert_eq!(thread["experimentalRawEvents"], true);
    assert_eq!(
        thread["config"],
        json!({
            "features": { "multi_agent": false, "multi_agent_v2": false },
            "web_search": "live",
            "tools": { "web_search": {
                "context_size": "high",
                "allowed_domains": ["docs.rs"],
                "location": { "country": "US", "timezone": "America/New_York" },
            } },
        })
    );

    // No network: web search is forced off and its tool config dropped.
    fx.run("offline", "plain", "gpt-5.6-sol", web_options, None)
        .await;
    assert_eq!(
        fx.logged("offline", "thread/start")["config"],
        json!({
            "features": { "multi_agent": false, "multi_agent_v2": false },
            "web_search": "disabled",
        })
    );

    // Invalid modes are dropped.
    let mut network = Map::new();
    network.insert("sandboxNetwork".into(), json!(true));
    fx.run_with(
        "bad",
        "plain",
        "gpt-5.6-sol",
        json!({ "webSearchMode": "always", "webSearch": { "contextSize": "huge" } }),
        None,
        network,
        None,
    )
    .await;
    let config = fx.logged("bad", "thread/start")["config"].clone();
    assert!(config.get("web_search").is_none() && config.get("tools").is_none());
}

#[tokio::test]
async fn codex_todo_list_updates_reach_the_session_todos() {
    let fx = Fixture::new();
    let updates: Arc<Mutex<Vec<Vec<Value>>>> = Arc::default();
    let sink = Arc::clone(&updates);
    let handler: CodexTodosCallback = Arc::new(move |todos| sink.lock().unwrap().push(todos));
    fx.run_with(
        "todos",
        "todos",
        "gpt-5.6-sol",
        json!({}),
        None,
        Map::new(),
        Some(handler),
    )
    .await;
    assert_eq!(
        *updates.lock().unwrap(),
        vec![
            vec![
                json!({ "content": "Read code", "status": "completed", "activeForm": "Read code" }),
                json!({ "content": "Write fix", "status": "in_progress", "activeForm": "Writing fix" }),
                json!({ "content": "Ship", "status": "pending", "activeForm": "Ship" }),
            ],
            // The `todoList` item's `items`; another turn's update and an all-invalid list are
            // ignored.
            vec![json!({ "content": "Ship", "status": "completed", "activeForm": "Ship" })],
        ]
    );
}

#[tokio::test]
async fn codex_error_notification_fails_in_flight_native_tools() {
    let fx = Fixture::new();
    let (_, events) = fx
        .run("error", "error", "gpt-5.6-sol", json!({}), None)
        .await;
    let args = json!({ "command": "sleep 9", "cwd": "/w" });
    assert_eq!(
        tool_events(&events),
        vec![
            (
                "start",
                "cmd9".into(),
                "commandExecution".into(),
                args.clone()
            ),
            ("end", "cmd9".into(), "commandExecution".into(), args),
            (
                "error",
                "cmd9".into(),
                "commandExecution".into(),
                json!({ "error": "stream disconnected" })
            ),
        ]
    );
}

#[tokio::test]
async fn codex_code_mode_scripts_surface_once_with_nested_citations() {
    let fx = Fixture::new();
    let (result, events) = fx
        .run("codemode", "codemode", "gpt-5.6-sol", json!({}), None)
        .await;
    let cited_items =
        json!([{ "type": "inputText", "text": "cite:\n[Docs](https://docs.rs/x) turn0search0" }]);
    let source =
        json!({ "url": "https://docs.rs/x", "title": "Docs", "referenceId": "turn0search0" });
    let script = json!({ "code": "const r = await tools.webSearch({ q: 'x' });\nreturn r;" });
    let s = |v: &str| v.to_owned();
    assert_eq!(
        tool_events(&events),
        vec![
            ("start", s("e1"), s("webSearch"), script.clone()),
            ("end", s("e1"), s("webSearch"), script),
            // `d1` ran inside the visible `e1` script and is folded into it; `e2` is hidden
            // because its nested `read` call surfaced on its own.
            ("start", s("d2"), s("read"), json!({ "path": "a" })),
            ("end", s("d2"), s("read"), json!({ "path": "a" })),
            (
                "result",
                s("d2"),
                s("read"),
                json!({ "contentItems": cited_items, "citationSources": [source.clone()] })
            ),
            (
                "start",
                s("w9"),
                s("codeExecution"),
                json!({ "cell_id": "zz" })
            ),
            (
                "end",
                s("w9"),
                s("codeExecution"),
                json!({ "cell_id": "zz" })
            ),
            ("result", s("w9"), s("codeExecution"), json!("late")),
            (
                "result",
                s("e1"),
                s("webSearch"),
                json!({ "contentItems": "final", "citationSources": [source] })
            ),
        ]
    );
    assert!(
        !result
            .assistant
            .content
            .iter()
            .any(|b| matches!(b, ContentBlock::ToolCall { .. }))
    );
}
