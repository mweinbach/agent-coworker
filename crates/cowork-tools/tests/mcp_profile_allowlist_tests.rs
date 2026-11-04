//! Regression: profile-scoped MCP access on read-only base roles, matching TS
//! `filterToolsForRole(..., { allowProfileMcp: true })` + `filterToolsForProfile`.
//!
//! A child agent whose profile has `baseRole: explorer` (read-only) gets exactly the MCP
//! servers listed in `profile.allowedMcpServers` (compared after MCP name normalization),
//! while a read-only role without a profile still gets no MCP tools at all.
#![cfg(unix)]

use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::Path;
use std::sync::Arc;

use cowork_config::{AgentConfig, LoadConfigOptions, ProviderName, load_config};
use cowork_mcp::{
    McpConfigSource, McpServerConfig, McpServerTransport, WorkspaceMcpToolCache, upsert_mcp_server,
};
use cowork_tools::{
    BuiltinTool, LoadedMcpBuiltinToolAdapter, McpCallTool, McpToolSearchTool, ToolError,
    ToolExecutionContext, ToolOutput, create_builtin_tools,
};
use serde_json::{Map, Value, json};

/// Stdio MCP server exposing `ping`, which answers with its `SERVER_MARK` env value.
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
      serverInfo: { name: "profile-mock", version: "1.0.0" } } });
  } else if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{
      name: "ping", description: "Answers with the serving MCP server",
      inputSchema: { type: "object", properties: {} } }] } });
  } else if (msg.method === "tools/call") {
    send({ jsonrpc: "2.0", id: msg.id, result: {
      content: [{ type: "text", text: "pong:" + process.env.SERVER_MARK }] } });
  }
});
"#;

const SERVERS: [&str; 3] = ["github", "linear server", "other"];

struct Fixture {
    _tmp: tempfile::TempDir,
    cfg: Arc<AgentConfig>,
    env: HashMap<String, String>,
    home: std::path::PathBuf,
    ws: std::path::PathBuf,
    cache: Arc<WorkspaceMcpToolCache>,
}

fn add_server(cfg: &AgentConfig, script: &Path, name: &str) {
    upsert_mcp_server(
        cfg,
        McpConfigSource::User,
        McpServerConfig {
            name: name.to_owned(),
            transport: McpServerTransport::Stdio {
                command: "node".to_owned(),
                args: Some(vec![script.to_string_lossy().into_owned()]),
                env: Some(HashMap::from([("SERVER_MARK".to_owned(), name.to_owned())])),
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
    let script = base.join("profile_server.js");
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
    cfg.tool_calling.deferred_tool_search = false;
    cfg.tool_calling.code_mode = false;
    for name in SERVERS {
        add_server(&cfg, &script, name);
    }
    Fixture {
        _tmp: tmp,
        cfg: Arc::new(cfg),
        env,
        home,
        ws,
        cache: Arc::new(WorkspaceMcpToolCache::new()),
    }
}

/// A read-only (`explorer`-like) child context, optionally scoped by a profile's
/// `allowedMcpServers`.
fn child_ctx(fx: &Fixture, allowed_mcp_servers: Option<&[&str]>) -> ToolExecutionContext {
    let mut ctx = ToolExecutionContext::new_for_tests(
        fx.home.clone(),
        fx.ws.clone(),
        ProviderName::Openai,
        "gpt-5.4",
    );
    ctx.session_id = "agent-explorer-profile".to_owned();
    ctx.env = fx.env.clone();
    ctx.agent_config = Some(Arc::clone(&fx.cfg));
    ctx.mcp_tool_cache = Some(Arc::clone(&fx.cache));
    ctx.read_only_role = true;
    ctx.allowed_mcp_servers =
        allowed_mcp_servers.map(|s| s.iter().map(|n| (*n).to_owned()).collect::<BTreeSet<_>>());
    ctx
}

fn args(v: Value) -> Map<String, Value> {
    serde_json::from_value(v).unwrap()
}

async fn search_all(ctx: &ToolExecutionContext) -> Vec<String> {
    let out = McpToolSearchTool
        .execute(args(json!({ "query": "*", "limit": 20 })), ctx)
        .await
        .expect("toolSearch runs");
    let ToolOutput::Json(v) = out else {
        panic!("expected JSON toolSearch output: {out:?}");
    };
    let mut names: Vec<String> = v["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap().to_owned())
        .collect();
    names.sort();
    names
}

async fn call(ctx: &ToolExecutionContext, tool: &str) -> Result<String, ToolError> {
    McpCallTool
        .execute(args(json!({ "tool": tool })), ctx)
        .await
        .map(|out| out.as_text().unwrap_or_default())
}

/// Every server's adapter, as discovered from the shared cache (what deferred/codeMode
/// catalogs hold).
async fn adapters(fx: &Fixture) -> HashMap<String, Arc<dyn BuiltinTool>> {
    fx.cache
        .with_tools(&fx.cfg, &fx.env, "agent-explorer-profile", |tools, _| {
            let out: HashMap<String, Arc<dyn BuiltinTool>> = tools
                .iter()
                .map(|t| {
                    (
                        t.qualified_name.clone(),
                        LoadedMcpBuiltinToolAdapter::into_builtin(t.clone()),
                    )
                })
                .collect();
            Box::pin(async move { out })
        })
        .await
        .unwrap()
}

#[tokio::test]
async fn explorer_profile_lists_and_calls_only_its_allowed_mcp_servers() {
    let fx = fixture();
    let ctx = child_ctx(&fx, Some(&["github"]));

    let tools = create_builtin_tools(&ctx);
    assert!(
        tools.contains_key("toolSearch") && tools.contains_key("mcpCall"),
        "a profile's allowedMcpServers must reach a read-only base role: {:?}",
        tools.keys().collect::<Vec<_>>()
    );
    assert!(
        !tools.contains_key("write") && !tools.contains_key("edit"),
        "read-only roles keep withholding write-capable built-ins"
    );

    assert_eq!(search_all(&ctx).await, vec!["mcp__github__ping"]);
    let out = call(&ctx, "mcp__github__ping")
        .await
        .expect("profile-allowed MCP tool must execute");
    assert!(out.contains("pong:github"), "{out}");
    let err = call(&ctx, "mcp__other__ping").await.unwrap_err();
    assert!(err.to_string().contains("not allowed"), "{err}");

    let adapters = adapters(&fx).await;
    let ok = adapters["mcp__github__ping"]
        .execute(Map::new(), &ctx)
        .await
        .expect("adapter for the allowed server must execute");
    assert!(ok.as_text().unwrap().contains("pong:github"), "{ok:?}");
    let err = adapters["mcp__other__ping"]
        .execute(Map::new(), &ctx)
        .await
        .unwrap_err();
    assert!(matches!(err, ToolError::PathDenied(_)), "{err:?}");
}

#[tokio::test]
async fn read_only_role_without_profile_gets_no_mcp_tools() {
    let fx = fixture();
    let ctx = child_ctx(&fx, None);

    let tools = create_builtin_tools(&ctx);
    assert!(
        !tools.contains_key("toolSearch") && !tools.contains_key("mcpCall"),
        "unprofiled read-only roles must not get MCP tools: {:?}",
        tools.keys().collect::<Vec<_>>()
    );
    assert!(search_all(&ctx).await.is_empty());
    let err = call(&ctx, "mcp__github__ping").await.unwrap_err();
    assert!(
        matches!(&err, ToolError::PathDenied(m) if m.contains("read-only")),
        "{err:?}"
    );
    let adapters = adapters(&fx).await;
    let err = adapters["mcp__github__ping"]
        .execute(Map::new(), &ctx)
        .await
        .unwrap_err();
    assert!(matches!(err, ToolError::PathDenied(_)), "{err:?}");
}

#[tokio::test]
async fn profile_mcp_server_names_are_normalized() {
    let fx = fixture();
    // `"linear  server"` (two spaces) names the server registered as `"linear server"`, whose
    // tools are `mcp__linear_server__*` — TS normalizes both sides with `normalizeMcpNamePart`.
    let ctx = child_ctx(&fx, Some(&["linear  server"]));
    assert_eq!(search_all(&ctx).await, vec!["mcp__linear_server__ping"]);
    let out = call(&ctx, "mcp__linear_server__ping")
        .await
        .expect("normalized profile server name must allow the tool");
    assert!(out.contains("pong:linear server"), "{out}");
    assert!(call(&ctx, "mcp__github__ping").await.is_err());

    let ctx = child_ctx(&fx, Some(&["linear_server"]));
    assert_eq!(search_all(&ctx).await, vec!["mcp__linear_server__ping"]);
}
