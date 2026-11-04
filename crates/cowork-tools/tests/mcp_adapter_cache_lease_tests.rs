//! Regression: deferred-tool / code-mode MCP adapters must execute through
//! `WorkspaceMcpToolCache::with_tools`, so an in-flight call holds a generation lease (a
//! config update cannot close its connection mid-call) and later calls reach the current
//! generation instead of a retired, closed transport.
#![cfg(unix)]

use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use cowork_config::{AgentConfig, LoadConfigOptions, ProviderName, load_config};
use cowork_mcp::{
    McpConfigSource, McpServerConfig, McpServerTransport, WorkspaceMcpToolCache, upsert_mcp_server,
};
use cowork_tools::{BuiltinTool, LoadedMcpBuiltinToolAdapter, ToolExecutionContext};
use serde_json::json;

/// Stdio MCP server exposing `whoami`, which answers after `ms` with the `GENERATION_MARK`
/// env value of the process that served it.
const SERVER_JS: &str = r#"
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: {
      protocolVersion: "2025-11-25", capabilities: { tools: {} },
      serverInfo: { name: "lease-mock", version: "1.0.0" } } });
  } else if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{
      name: "whoami", description: "Reports the serving generation",
      inputSchema: { type: "object", properties: { ms: { type: "integer" } } } }] } });
  } else if (msg.method === "tools/call") {
    setTimeout(() => send({ jsonrpc: "2.0", id: msg.id, result: {
      content: [{ type: "text", text: "gen:" + process.env.GENERATION_MARK }] } }),
      (msg.params.arguments && msg.params.arguments.ms) || 0);
  }
});
"#;

fn write_server(script: &Path, mark: &str, cfg: &AgentConfig) {
    upsert_mcp_server(
        cfg,
        McpConfigSource::User,
        McpServerConfig {
            name: "lease".to_owned(),
            transport: McpServerTransport::Stdio {
                command: "node".to_owned(),
                args: Some(vec![script.to_string_lossy().into_owned()]),
                env: Some(HashMap::from([(
                    "GENERATION_MARK".to_owned(),
                    mark.to_owned(),
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

#[tokio::test]
async fn adapter_call_holds_cache_lease_and_follows_current_generation() {
    let tmp = tempfile::tempdir().unwrap();
    let base = fs::canonicalize(tmp.path()).unwrap();
    let home = base.join("home");
    let ws = base.join("ws");
    let builtin = base.join("builtin");
    fs::create_dir_all(home.join(".cowork/config")).unwrap();
    fs::create_dir_all(ws.join(".cowork")).unwrap();
    fs::create_dir_all(builtin.join("config")).unwrap();
    fs::write(builtin.join("config/mcp-servers.json"), r#"{"servers":[]}"#).unwrap();
    let script = base.join("lease_server.js");
    fs::write(&script, SERVER_JS).unwrap();

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
    write_server(&script, "v1", &cfg);
    let cfg = Arc::new(cfg);

    let cache = Arc::new(WorkspaceMcpToolCache::new());
    let mut ctx = ToolExecutionContext::new_for_tests(
        home.clone(),
        ws.clone(),
        ProviderName::Openai,
        "gpt-5.4",
    );
    ctx.session_id = "sess-lease".to_owned();
    ctx.env = env.clone();
    ctx.agent_config = Some(Arc::clone(&cfg));
    ctx.mcp_tool_cache = Some(Arc::clone(&cache));

    // Discovery, as the turn runner does: the lease ends when `with_tools` returns.
    let adapter: Arc<dyn BuiltinTool> = cache
        .with_tools(&cfg, &env, "sess-lease", |tools, _| {
            let tool = tools
                .iter()
                .find(|t| t.qualified_name == "mcp__lease__whoami")
                .cloned()
                .expect("whoami discovered");
            Box::pin(async move { LoadedMcpBuiltinToolAdapter::into_builtin(tool) })
        })
        .await
        .unwrap();

    // Start a slow call on generation 1.
    let slow = {
        let adapter = Arc::clone(&adapter);
        let ctx = ctx.clone();
        tokio::spawn(async move {
            adapter
                .execute(serde_json::from_value(json!({ "ms": 1500 })).unwrap(), &ctx)
                .await
        })
    };
    tokio::time::sleep(Duration::from_millis(400)).await;

    // Update the server config mid-call: the next `with_tools` builds generation 2 and
    // retires generation 1.
    write_server(&script, "v2", &cfg);
    cache
        .with_tools(&cfg, &env, "sess-lease", |_, _| Box::pin(async {}))
        .await
        .unwrap();

    let slow_out = tokio::time::timeout(Duration::from_secs(20), slow)
        .await
        .expect("slow call finishes")
        .unwrap()
        .expect("in-flight call must survive a config update");
    let slow_text = slow_out.as_text().unwrap();
    assert!(slow_text.contains("gen:v1"), "{slow_text}");

    // A later call through the same (discovery-time) adapter reaches generation 2.
    let next = adapter
        .execute(serde_json::from_value(json!({})).unwrap(), &ctx)
        .await
        .expect("later call uses the current generation, not the retired transport");
    let next_text = next.as_text().unwrap();
    assert!(next_text.contains("gen:v2"), "{next_text}");
}
