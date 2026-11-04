//! Regression: standard-mode `mcpCall` validates `arguments` against the MCP tool's
//! `inputSchema` before calling the server, and honours turn cancellation (as the
//! `LoadedMcpBuiltinToolAdapter` used by deferred/codeMode catalogs does); `toolSearch` stops
//! waiting on a cancelled turn as well.
#![cfg(unix)]

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use cowork_config::{AgentConfig, LoadConfigOptions, ProviderName, load_config};
use cowork_mcp::{
    McpConfigSource, McpServerConfig, McpServerTransport, WorkspaceMcpToolCache, upsert_mcp_server,
};
use cowork_tools::{BuiltinTool, McpCallTool, ToolError, ToolExecutionContext};
use serde_json::{Map, Value, json};
use tokio::sync::watch;

/// `echo` requires an integer `n`; `hang` never answers. Every `tools/call` is logged to
/// `CALL_LOG` before it is handled.
const SERVER_JS: &str = r#"
const fs = require("fs");
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: {
      protocolVersion: "2025-11-25", capabilities: { tools: {} },
      serverInfo: { name: "validate-mock", version: "1.0.0" } } });
  } else if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [
      { name: "echo", description: "echo n", inputSchema: {
          type: "object", properties: { n: { type: "integer" } },
          required: ["n"], additionalProperties: false } },
      { name: "hang", description: "never answers", inputSchema: { type: "object", properties: {} } },
    ] } });
  } else if (msg.method === "tools/call") {
    fs.appendFileSync(process.env.CALL_LOG, JSON.stringify(msg.params) + "\n");
    if (msg.params.name === "hang") return;
    send({ jsonrpc: "2.0", id: msg.id, result: {
      content: [{ type: "text", text: "n=" + msg.params.arguments.n }] } });
  }
});
"#;

struct Fixture {
    _tmp: tempfile::TempDir,
    cfg: Arc<AgentConfig>,
    env: HashMap<String, String>,
    home: PathBuf,
    ws: PathBuf,
    call_log: PathBuf,
}

fn fixture() -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let base = fs::canonicalize(tmp.path()).unwrap();
    let home = base.join("home");
    let ws = base.join("ws");
    let builtin = base.join("builtin");
    fs::create_dir_all(home.join(".cowork/config")).unwrap();
    fs::create_dir_all(ws.join(".cowork")).unwrap();
    fs::create_dir_all(builtin.join("config")).unwrap();
    fs::write(builtin.join("config/mcp-servers.json"), r#"{"servers":[]}"#).unwrap();
    let script = base.join("validate_server.js");
    fs::write(&script, SERVER_JS).unwrap();
    let call_log = base.join("calls.log");

    let env = HashMap::from([
        ("HOME".to_owned(), home.to_string_lossy().into_owned()),
        (
            "COWORK_HOME_OVERRIDE".to_owned(),
            home.join(".cowork").to_string_lossy().into_owned(),
        ),
        ("COWORK_DISABLE_RUNTIME".to_owned(), "1".to_owned()),
    ]);
    let mut cfg = load_config(LoadConfigOptions {
        cwd: Some(ws.clone()),
        homedir: Some(home.clone()),
        built_in_dir: Some(builtin),
        env: Some(env.clone()),
    })
    .unwrap();
    cfg.enable_mcp = true;
    cfg.tool_calling.deferred_tool_search = false;
    cfg.tool_calling.code_mode = false;
    add_server(&cfg, &script, &call_log);
    Fixture {
        _tmp: tmp,
        cfg: Arc::new(cfg),
        env,
        home,
        ws,
        call_log,
    }
}

fn add_server(cfg: &AgentConfig, script: &Path, call_log: &Path) {
    upsert_mcp_server(
        cfg,
        McpConfigSource::User,
        McpServerConfig {
            name: "validate".to_owned(),
            transport: McpServerTransport::Stdio {
                command: "node".to_owned(),
                args: Some(vec![script.to_string_lossy().into_owned()]),
                env: Some(HashMap::from([(
                    "CALL_LOG".to_owned(),
                    call_log.to_string_lossy().into_owned(),
                )])),
                cwd: None,
            },
            enabled: None,
            required: None,
            retries: Some(0),
            auth: None,
            icon: None,
        },
        None,
    )
    .unwrap();
}

fn ctx(fx: &Fixture) -> ToolExecutionContext {
    let mut ctx = ToolExecutionContext::new_for_tests(
        fx.home.clone(),
        fx.ws.clone(),
        ProviderName::Openai,
        "gpt-5.4",
    );
    ctx.session_id = "mcp-validate".to_owned();
    ctx.env = fx.env.clone();
    ctx.agent_config = Some(Arc::clone(&fx.cfg));
    ctx.mcp_tool_cache = Some(Arc::new(WorkspaceMcpToolCache::new()));
    ctx
}

fn args(v: Value) -> Map<String, Value> {
    serde_json::from_value(v).unwrap()
}

fn logged_calls(fx: &Fixture) -> Vec<String> {
    fs::read_to_string(&fx.call_log)
        .unwrap_or_default()
        .lines()
        .map(str::to_owned)
        .collect()
}

#[tokio::test]
async fn mcp_call_validates_arguments_against_the_tool_input_schema() {
    let fx = fixture();
    let ctx = ctx(&fx);

    for bad in [
        json!({ "n": "seven" }),
        json!({}),
        json!({ "n": 7, "extra": true }),
    ] {
        let err = McpCallTool
            .execute(
                args(json!({ "tool": "mcp__validate__echo", "arguments": bad.clone() })),
                &ctx,
            )
            .await
            .unwrap_err();
        assert!(
            matches!(err, ToolError::InvalidArguments(_)),
            "{bad}: {err:?}"
        );
    }
    assert!(logged_calls(&fx).is_empty(), "{:?}", logged_calls(&fx));

    let out = McpCallTool
        .execute(
            args(json!({ "tool": "mcp__validate__echo", "arguments": { "n": 7 } })),
            &ctx,
        )
        .await
        .unwrap();
    assert!(out.to_json_value().to_string().contains("n=7"), "{out:?}");
    assert_eq!(logged_calls(&fx).len(), 1);
}

#[tokio::test]
async fn mcp_call_returns_when_the_turn_is_cancelled() {
    let fx = fixture();
    let mut ctx = ctx(&fx);
    let (cancel_tx, cancel_rx) = watch::channel(false);
    ctx.cancel_rx = Some(cancel_rx);

    let call_ctx = ctx.clone();
    let call = tokio::spawn(async move {
        McpCallTool
            .execute(args(json!({ "tool": "mcp__validate__hang" })), &call_ctx)
            .await
    });
    // Wait until the server has received the call, then stop the turn.
    for _ in 0..200 {
        if !logged_calls(&fx).is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert_eq!(logged_calls(&fx).len(), 1, "hang was never called");
    cancel_tx.send(true).unwrap();
    let res = tokio::time::timeout(Duration::from_secs(5), call)
        .await
        .expect("mcpCall kept waiting after the turn was cancelled")
        .unwrap();
    let err = res.unwrap_err();
    assert!(err.to_string().contains("aborted"), "{err:?}");

    // Already cancelled: nothing is called.
    let err = McpCallTool
        .execute(
            args(json!({ "tool": "mcp__validate__echo", "arguments": { "n": 1 } })),
            &ctx,
        )
        .await
        .unwrap_err();
    assert!(err.to_string().contains("aborted"), "{err:?}");
    assert_eq!(logged_calls(&fx).len(), 1);
}
