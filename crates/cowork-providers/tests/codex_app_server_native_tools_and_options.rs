//! Codex app-server native tool activity (`commandExecution` / `fileChange` / `mcpToolCall`
//! items and their output deltas) projected into tool stream events, plus the
//! `reasoningSummary` -> `turn/start.summary` and `textVerbosity` -> thread
//! `config.model_verbosity` mappings, driven by a mocked stdio app-server.

use std::collections::HashMap;
use std::path::PathBuf;

use cowork_inference::{
    CanonicalMessage, ClientCapabilities, ContentBlock, MessageRole, ProviderOpaqueMeta,
    RequestPolicy, StepBudget, StreamEvent, StreamEventProjector,
};
use cowork_providers::codex_app_server::CodexAppServerTransport;
use cowork_providers::{ProviderStepRequest, ProviderStepResult, ProviderTransport};
use serde_json::{Map, Value, json};
use uuid::Uuid;

/// Mock app-server; logs every client request to `logPath`. `behavior`:
/// - `tools`: reasoning, a successful and a failed shell command with streamed output, a file
///   edit, an MCP call, another turn's command (ignored), then the final answer.
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
        let mut opts = Map::new();
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
        .with_built_in_dir(built_in_dir);
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
