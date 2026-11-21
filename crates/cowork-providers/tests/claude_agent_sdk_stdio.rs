//! Deterministic stdio integration tests for `ClaudeAgentSdkTransport`, system CLI discovery,
//! environment sanitization, SDK MCP tool bridging, permission fail-closed checks, and resume
//! continuation fingerprinting.
#![cfg(unix)]

use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use cowork_inference::{
    CanonicalMessage, ContentBlock, MessageRole, ProviderContinuationState, ProviderOpaqueMeta,
    RequestPolicy, StepBudget, StreamEvent,
};
use cowork_providers::claude_agent_sdk::{
    ClaudeAgentSdkTransport, build_claude_spawn_env, parse_claude_auth_status_json,
    resolve_claude_cli_status,
};
use cowork_providers::codex_app_server::{DynamicToolCallOutput, DynamicToolHandler};
use cowork_providers::{ProviderStepRequest, ProviderTransport, ToolDefinition};
use serde_json::{Map, Value, json};

const MOCK_CLAUDE_JS: &str = r#"
import readline from "node:readline";
import fs from "node:fs";

const [, , logPath, mode] = process.argv;
const args = process.argv.slice(4);
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const log = (obj) => fs.appendFileSync(logPath, JSON.stringify(obj) + "\n");

log({ argv: args, hasAnthropicKey: !!process.env.ANTHROPIC_API_KEY, hasClaudeCode: !!process.env.CLAUDECODE });

let pendingMcpInit = false;
let pendingMcpList = false;
let pendingMcpCall = false;
let pendingPermCheck = false;

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  log({ recv: msg });

  if (msg.type === "control_request" && msg.request?.subtype === "initialize") {
    send({
      type: "control_response",
      response: { subtype: "success", request_id: msg.request_id, response: {} }
    });
    send({
      type: "system",
      subtype: "init",
      session_id: "claude-sess-42",
      model: "claude-opus-4-8",
      tools: []
    });
    return;
  }

  if (msg.type === "user") {
    if (mode === "error") {
      send({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["Rate limit exceeded on Claude plan"],
        session_id: "claude-sess-42"
      });
      return;
    }

    if (mode === "tool_bridge") {
      pendingMcpInit = true;
      send({
        type: "control_request",
        request_id: "cli_mcp_init",
        request: {
          subtype: "mcp_message",
          server_name: "cowork",
          message: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }
        }
      });
      return;
    }

    // Simple streaming text + thinking
    send({
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "message_start", message: { id: "m1" } }
    });
    send({
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Thinking..." } }
    });
    send({
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hello " } }
    });
    send({
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "world!" } }
    });
    send({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "claude-sess-42",
      result: "Hello world!",
      total_cost_usd: 0.012,
      usage: {
        input_tokens: 100,
        cache_read_input_tokens: 40,
        cache_creation_input_tokens: 10,
        output_tokens: 25
      }
    });
    return;
  }

  if (msg.type === "control_response") {
    const rid = msg.response?.request_id;
    if (pendingMcpInit && rid === "cli_mcp_init") {
      pendingMcpInit = false;
      pendingMcpList = true;
      send({
        type: "control_request",
        request_id: "cli_mcp_list",
        request: {
          subtype: "mcp_message",
          server_name: "cowork",
          message: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }
        }
      });
      return;
    }
    if (pendingMcpList && rid === "cli_mcp_list") {
      pendingMcpList = false;
      pendingPermCheck = true;
      send({
        type: "control_request",
        request_id: "cli_perm_native",
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          input: { command: "rm -rf /" }
        }
      });
      return;
    }
    if (pendingPermCheck && rid === "cli_perm_native") {
      pendingPermCheck = false;
      pendingMcpCall = true;
      send({
        type: "control_request",
        request_id: "cli_mcp_call",
        request: {
          subtype: "mcp_message",
          server_name: "cowork",
          message: {
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: { name: "mcp__cowork__read_note", arguments: { path: "hello.txt" } }
          }
        }
      });
      return;
    }
    if (pendingMcpCall && rid === "cli_mcp_call") {
      pendingMcpCall = false;
      const toolText = msg.response?.response?.mcp_response?.result?.content?.[0]?.text ?? "";
      send({
        type: "stream_event",
        parent_tool_use_id: null,
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Note says: " + toolText } }
      });
      send({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "claude-sess-42",
        result: "Note says: " + toolText,
        usage: { input_tokens: 50, output_tokens: 12 }
      });
    }
  }
});
"#;

fn find_node() -> String {
    std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .map(|d| d.join("node"))
        .find(|p| p.is_file())
        .expect("node binary must be on PATH for stdio mock tests")
        .to_string_lossy()
        .into_owned()
}

struct MockToolHandler {
    calls: Mutex<Vec<(String, Map<String, Value>)>>,
}

#[async_trait]
impl DynamicToolHandler for MockToolHandler {
    async fn call_tool(&self, name: &str, arguments: Map<String, Value>) -> DynamicToolCallOutput {
        self.calls
            .lock()
            .unwrap()
            .push((name.to_owned(), arguments.clone()));
        DynamicToolCallOutput {
            text: format!(
                "content-of-{}",
                arguments
                    .get("path")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
            ),
            is_error: false,
        }
    }
}

fn user_message(text: &str) -> CanonicalMessage {
    CanonicalMessage {
        id: "u1".to_owned(),
        role: MessageRole::User,
        content: vec![ContentBlock::Text {
            text: text.to_owned(),
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
        created_at: "2026-11-19T00:00:00Z".to_owned(),
    }
}

#[test]
fn discovery_ignores_relative_path_and_spawn_env_strips_api_key_and_claudecode() {
    let dir = tempfile::tempdir().unwrap();
    let rel_bin = dir.path().join("bin");
    std::fs::create_dir_all(&rel_bin).unwrap();
    let fake_cli = rel_bin.join("claude");
    std::fs::write(&fake_cli, "#!/bin/sh\necho ok\n").unwrap();
    std::fs::set_permissions(&fake_cli, std::fs::Permissions::from_mode(0o755)).unwrap();

    // Relative / empty PATH segments must be ignored.
    let mut env = HashMap::new();
    env.insert("PATH".to_owned(), ".:./bin::relative/bin".to_owned());
    let missing = resolve_claude_cli_status(dir.path(), &env);
    assert!(!missing.available);

    // Absolute PATH segment resolves cleanly.
    env.insert("PATH".to_owned(), rel_bin.to_string_lossy().into_owned());
    let found = resolve_claude_cli_status(dir.path(), &env);
    assert!(found.available);
    assert_eq!(found.source, "system");
    assert_eq!(
        found.command.as_deref(),
        Some(fake_cli.to_string_lossy().as_ref())
    );

    // Spawn env strips ANTHROPIC_API_KEY and CLAUDECODE so subscription auth is used.
    env.insert("ANTHROPIC_API_KEY".to_owned(), "sk-ant-secret".to_owned());
    env.insert("CLAUDECODE".to_owned(), "1".to_owned());
    let spawn_env = build_claude_spawn_env(&env);
    assert!(!spawn_env.contains_key("ANTHROPIC_API_KEY"));
    assert!(!spawn_env.contains_key("CLAUDECODE"));
    assert_eq!(
        spawn_env.get("CLAUDE_CODE_ENTRYPOINT").map(String::as_str),
        Some("sdk-rs")
    );

    // Auth JSON parser captures subscription details cleanly.
    let parsed = parse_claude_auth_status_json(
        r#"{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max","planTier":"max_20x","email":"user@example.com"}"#,
    )
    .expect("valid auth status JSON");
    assert!(parsed.logged_in);
    assert_eq!(parsed.subscription_type.as_deref(), Some("max"));
    assert_eq!(parsed.plan_tier.as_deref(), Some("max_20x"));
    assert!(parsed.message.contains("max"));
}

#[tokio::test]
async fn claude_agent_sdk_streams_deltas_bridges_sdk_mcp_tools_and_resumes_session() {
    let dir = tempfile::tempdir().unwrap();
    let script_path = dir.path().join("mock_claude.mjs");
    let log_path = dir.path().join("trace.jsonl");
    std::fs::write(&script_path, MOCK_CLAUDE_JS).unwrap();

    let node = find_node();
    let mut env = HashMap::new();
    env.insert(
        "PATH".to_owned(),
        std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".into()),
    );
    env.insert("ANTHROPIC_API_KEY".to_owned(), "sk-should-strip".to_owned());
    env.insert("CLAUDECODE".to_owned(), "1".to_owned());

    // 1. Streaming + thinking + continuation token + env stripping.
    let transport = ClaudeAgentSdkTransport {
        command_override: Some((
            node.clone(),
            vec![
                script_path.to_string_lossy().into_owned(),
                log_path.to_string_lossy().into_owned(),
                "simple".to_owned(),
            ],
        )),
        env_override: Some(env.clone()),
        cwd: Some(dir.path().to_path_buf()),
        ..Default::default()
    };

    let req = ProviderStepRequest {
        model_id: "claude-opus-4-8".to_owned(),
        base_url: None,
        api_key: None,
        extra_headers: HashMap::new(),
        system_prompt: "You are Cowork.".to_owned(),
        messages: vec![user_message("Hi Claude")],
        tools: Vec::new(),
        authorized_tool_names: None,
        provider_options: Map::new(),
        continuation: None,
        policy: RequestPolicy::default(),
        turn_id: "turn-1".to_owned(),
    };

    let mut events = Vec::new();
    let res = transport
        .stream_step(req.clone(), &StepBudget::unbounded(None), &mut |ev| {
            events.push(ev);
        })
        .await
        .expect("simple stream_step succeeds");

    assert_eq!(res.usage.prompt_tokens, 150);
    assert_eq!(res.usage.cached_prompt_tokens, Some(40));
    assert_eq!(res.usage.cache_write_prompt_tokens, Some(10));
    assert_eq!(res.usage.completion_tokens, 25);
    assert_eq!(res.usage.estimated_cost_usd, Some(0.012));
    assert!(
        events.iter().any(
            |e| matches!(e, StreamEvent::ThinkingDelta { delta, .. } if delta == "Thinking...")
        )
    );
    assert!(
        events
            .iter()
            .any(|e| matches!(e, StreamEvent::TextDelta { delta, .. } if delta == "Hello "))
    );
    let Some(ProviderContinuationState::ClaudeCli { session_id, .. }) = res.continuation.clone()
    else {
        panic!("expected ClaudeCli continuation state");
    };
    assert_eq!(session_id, "claude-sess-42");

    // Verify ANTHROPIC_API_KEY & CLAUDECODE were stripped in child env.
    let log_raw = std::fs::read_to_string(&log_path).unwrap();
    let first_log: Value = serde_json::from_str(log_raw.lines().next().unwrap()).unwrap();
    assert_eq!(first_log["hasAnthropicKey"], json!(false));
    assert_eq!(first_log["hasClaudeCode"], json!(false));

    // 2. Follow-up turn reuses `--resume=claude-sess-42`.
    let log_path_2 = dir.path().join("trace2.jsonl");
    let transport_2 = ClaudeAgentSdkTransport {
        command_override: Some((
            node.clone(),
            vec![
                script_path.to_string_lossy().into_owned(),
                log_path_2.to_string_lossy().into_owned(),
                "simple".to_owned(),
            ],
        )),
        env_override: Some(env.clone()),
        cwd: Some(dir.path().to_path_buf()),
        ..Default::default()
    };
    let mut follow_req = req;
    follow_req.messages.push(res.assistant);
    follow_req.messages.push(user_message("Follow up"));
    follow_req.continuation = res.continuation;
    follow_req.turn_id = "turn-2".to_owned();
    transport_2
        .stream_step(follow_req, &StepBudget::unbounded(None), &mut |_| {})
        .await
        .expect("resumed turn succeeds");
    let log_raw_2 = std::fs::read_to_string(&log_path_2).unwrap();
    assert!(
        log_raw_2.contains("--resume=claude-sess-42"),
        "follow-up turn should pass --resume=claude-sess-42: {log_raw_2}"
    );

    // 3. Bidirectional SDK MCP tool bridge + fail-closed permission denial of native Bash.
    let log_path_3 = dir.path().join("trace3.jsonl");
    let handler = Arc::new(MockToolHandler {
        calls: Mutex::new(Vec::new()),
    });
    let transport_3 = ClaudeAgentSdkTransport {
        command_override: Some((
            node.clone(),
            vec![
                script_path.to_string_lossy().into_owned(),
                log_path_3.to_string_lossy().into_owned(),
                "tool_bridge".to_owned(),
            ],
        )),
        tool_handler: Some(Arc::clone(&handler) as Arc<dyn DynamicToolHandler>),
        env_override: Some(env.clone()),
        cwd: Some(dir.path().to_path_buf()),
        ..Default::default()
    };
    let tool_req = ProviderStepRequest {
        model_id: "claude-opus-4-8".to_owned(),
        base_url: None,
        api_key: None,
        extra_headers: HashMap::new(),
        system_prompt: "Use tools.".to_owned(),
        messages: vec![user_message("Read hello.txt")],
        tools: vec![ToolDefinition {
            name: "read_note".to_owned(),
            description: "Reads a note.".to_owned(),
            parameters: json!({ "type": "object", "properties": { "path": { "type": "string" } } }),
        }],
        authorized_tool_names: None,
        provider_options: Map::new(),
        continuation: None,
        policy: RequestPolicy::default(),
        turn_id: "turn-3".to_owned(),
    };
    let mut tool_events = Vec::new();
    let tool_res = transport_3
        .stream_step(tool_req, &StepBudget::unbounded(None), &mut |ev| {
            tool_events.push(ev);
        })
        .await
        .expect("tool_bridge turn succeeds");
    assert_eq!(handler.calls.lock().unwrap().len(), 1);
    assert_eq!(handler.calls.lock().unwrap()[0].0, "read_note");
    assert!(
        tool_events
            .iter()
            .any(|e| matches!(e, StreamEvent::ToolCallStart { name, .. } if name == "read_note"))
    );
    assert!(tool_events.iter().any(|e| {
        matches!(e, StreamEvent::ToolResult { name, is_error: false, .. } if name == "read_note")
    }));
    let final_text = tool_res
        .assistant
        .content
        .iter()
        .find_map(|b| match b {
            ContentBlock::Text { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .unwrap_or("");
    assert_eq!(final_text, "Note says: content-of-hello.txt");
    let log_raw_3 = std::fs::read_to_string(&log_path_3).unwrap();
    assert!(
        log_raw_3.contains("\"behavior\":\"deny\""),
        "native Bash tool permission request must be denied fail-closed: {log_raw_3}"
    );

    // 4. Error result surfaces clearly.
    let log_path_4 = dir.path().join("trace4.jsonl");
    let transport_4 = ClaudeAgentSdkTransport {
        command_override: Some((
            node,
            vec![
                script_path.to_string_lossy().into_owned(),
                log_path_4.to_string_lossy().into_owned(),
                "error".to_owned(),
            ],
        )),
        env_override: Some(env),
        cwd: Some(dir.path().to_path_buf()),
        ..Default::default()
    };
    let err_req = ProviderStepRequest {
        model_id: "claude-opus-4-8".to_owned(),
        base_url: None,
        api_key: None,
        extra_headers: HashMap::new(),
        system_prompt: String::new(),
        messages: vec![user_message("Fail")],
        tools: Vec::new(),
        authorized_tool_names: None,
        provider_options: Map::new(),
        continuation: None,
        policy: RequestPolicy::default(),
        turn_id: "turn-4".to_owned(),
    };
    let err = transport_4
        .stream_step(err_req, &StepBudget::unbounded(None), &mut |_| {})
        .await
        .expect_err("error result must return Err");
    assert!(err.message.contains("Rate limit exceeded on Claude plan"));
}

#[tokio::test]
async fn claude_agent_sdk_discovers_live_models_via_initialize_and_caches_in_catalog() {
    use cowork_config::ProviderName;
    use cowork_providers::{
        CatalogBuildOptions, build_provider_catalog,
        claude_agent_sdk::parse_claude_initialize_models,
    };

    // 1. Unit-check the initialize `models` parser (deduping `default` + `opus`, efforts, Haiku).
    let parsed = parse_claude_initialize_models(&json!([
        {
            "value": "default",
            "resolvedModel": "claude-opus-5-5",
            "displayName": "Default (recommended)",
            "description": "Opus 5.5 · Best for everyday, complex tasks",
            "supportsEffort": true,
            "supportedEffortLevels": ["low", "medium", "high", "xhigh", "max"]
        },
        {
            "value": "opus",
            "resolvedModel": "claude-opus-5-5",
            "displayName": "Opus 5.5",
            "description": "For complex work and everyday tasks",
            "supportsEffort": true,
            "supportedEffortLevels": ["low", "medium", "high", "xhigh", "max"]
        },
        {
            "value": "fable",
            "resolvedModel": "claude-fable-5-2",
            "displayName": "Fable 5.2",
            "description": "For your toughest challenges",
            "supportsEffort": true,
            "supportedEffortLevels": ["low", "medium", "high", "xhigh", "max"]
        },
        {
            "value": "claude-haiku-4-5-20251001",
            "resolvedModel": "claude-haiku-4-5-20251001",
            "displayName": "Haiku 4.5",
            "description": "Fastest for quick answers",
            "supportsThinkingOff": true
        }
    ]));
    assert_eq!(parsed.len(), 3);
    assert_eq!(parsed[0].id, "claude-opus-5-5");
    assert_eq!(parsed[0].display_name, "Claude Opus 5.5");
    assert_eq!(parsed[0].is_default, Some(true));
    assert_eq!(
        parsed[0]
            .reasoning
            .as_ref()
            .and_then(|r| r.available_efforts.as_ref())
            .map(Vec::as_slice),
        Some(
            &[
                "low".to_owned(),
                "medium".to_owned(),
                "high".to_owned(),
                "xhigh".to_owned(),
                "max".to_owned(),
            ][..]
        )
    );
    assert_eq!(parsed[1].id, "claude-fable-5-2");
    assert_eq!(parsed[1].display_name, "Claude Fable 5.2");
    assert_eq!(parsed[2].id, "claude-haiku-4-5-20251001");
    assert!(parsed[2].reasoning.is_none());

    // 2. End-to-end catalog discovery against an executable mock `claude` CLI.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let calls_log = dir.path().join("calls.log");
        let node = find_node();
        let mock_js = dir.path().join("mock_claude_discover.mjs");
        let js_src = format!(
            r#"import fs from "node:fs";
import readline from "node:readline";
const args = process.argv.slice(2);
fs.appendFileSync({log}, JSON.stringify(args) + "\n");
if (args[0] === "auth" && args[1] === "status") {{
  process.stdout.write(JSON.stringify({{ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max", email: "dev@example.com" }}) + "\n");
  process.exit(0);
}}
const rl = readline.createInterface({{ input: process.stdin, crlfDelay: Infinity }});
rl.on("line", (line) => {{
  const msg = JSON.parse(line);
  if (msg.type === "control_request" && msg.request && msg.request.subtype === "initialize") {{
    process.stdout.write(JSON.stringify({{
      type: "control_response",
      response: {{
        subtype: "success",
        request_id: msg.request_id,
        response: {{
          models: [
            {{ value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] }},
            {{ value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", description: "Best for complex tasks", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] }},
            {{ value: "fable", resolvedModel: "claude-fable-5-2", displayName: "Fable 5.2", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] }},
            {{ value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5.5", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] }}
          ]
        }}
      }}
    }}) + "\n");
    process.exit(0);
  }}
}});
"#,
            log = serde_json::to_string(&calls_log.to_string_lossy().to_string()).unwrap()
        );
        std::fs::write(&mock_js, js_src).unwrap();

        let mock_bin = dir.path().join("mock-claude");
        let wrapper = format!(
            "#!/bin/sh\nexec \"{node}\" \"{}\" \"$@\"\n",
            mock_js.to_string_lossy()
        );
        std::fs::write(&mock_bin, wrapper).unwrap();
        std::fs::set_permissions(&mock_bin, std::fs::Permissions::from_mode(0o755)).unwrap();

        let repo_root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .to_path_buf();

        let mut env = HashMap::new();
        env.insert(
            "COWORK_CLAUDE_AGENT_SDK_BIN".to_owned(),
            mock_bin.to_string_lossy().into_owned(),
        );
        env.insert(
            "PATH".to_owned(),
            std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".into()),
        );

        let opts = CatalogBuildOptions {
            built_in_dir: repo_root.clone(),
            homedir: dir.path().to_path_buf(),
            env: env.clone(),
            provider_options: None,
            refresh: false,
            discovery_timeout_ms: Some(5_000),
            base_url_overrides: HashMap::new(),
        };

        let cat = build_provider_catalog(&opts).await;
        assert!(cat.connected.iter().any(|p| p == "claude-cli"));
        let claude = cat
            .all
            .iter()
            .find(|e| e.id == ProviderName::ClaudeCli)
            .expect("claude-cli entry");
        assert_eq!(claude.default_model, "claude-opus-5-5");
        let ids: Vec<&str> = claude.models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["claude-opus-5-5", "claude-fable-5-2", "claude-sonnet-5-5"]
        );
        // All live-discovered models must be enabled by default (discovery_authoritative).
        assert!(claude.models.iter().all(|m| m.enabled != Some(false)));

        let calls_after_first = std::fs::read_to_string(&calls_log).unwrap();
        let init_spawns_first = calls_after_first
            .lines()
            .filter(|l| l.contains("stream-json"))
            .count();
        assert_eq!(init_spawns_first, 1);

        // Second non-refresh read should serve from the 24h discovery cache without re-spawning.
        let cat_cached = build_provider_catalog(&opts).await;
        let claude_cached = cat_cached
            .all
            .iter()
            .find(|e| e.id == ProviderName::ClaudeCli)
            .unwrap();
        assert_eq!(claude_cached.default_model, "claude-opus-5-5");
        let calls_after_second = std::fs::read_to_string(&calls_log).unwrap();
        let init_spawns_second = calls_after_second
            .lines()
            .filter(|l| l.contains("stream-json"))
            .count();
        assert_eq!(init_spawns_second, 1);
    }
}

#[tokio::test]
async fn claude_agent_sdk_native_tool_search_wires_toolsearch_and_always_load_meta() {
    use cowork_providers::{
        NativeToolCallingPlan, NativeToolSearchKind, write_native_tool_calling_plan,
    };

    let dir = tempfile::tempdir().unwrap();
    let script_path = dir.path().join("mock_claude_ts.mjs");
    let log_path = dir.path().join("trace_ts.jsonl");
    let mock_js = r#"
import fs from "node:fs";
import readline from "node:readline";

const [, , logPath] = process.argv;
const args = process.argv.slice(3);
const log = (entry) => fs.appendFileSync(logPath, JSON.stringify(entry) + "\n");
log({ event: "spawn", args, enableToolSearch: process.env.ENABLE_TOOL_SEARCH ?? null });

const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.type === "control_request" && msg.request?.subtype === "initialize") {
    send({
      type: "control_response",
      response: { subtype: "success", request_id: msg.request_id, response: { ok: true } },
    });
  } else if (msg.type === "user") {
    send({
      type: "control_request",
      request_id: "req_list",
      request: {
        subtype: "mcp_message",
        server_name: "cowork",
        message: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      },
    });
  } else if (msg.type === "control_response" && msg.response?.request_id === "req_list") {
    log({ event: "tools_list", tools: msg.response.response.mcp_response.result.tools });
    send({
      type: "control_request",
      request_id: "req_allow_ts",
      request: { subtype: "can_use_tool", tool_name: "ToolSearch", input: { query: "docs" } },
    });
  } else if (msg.type === "control_response" && msg.response?.request_id === "req_allow_ts") {
    log({ event: "can_use_tool_search", decision: msg.response.response });
    send({
      type: "control_request",
      request_id: "req_deny_bash",
      request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls" } },
    });
  } else if (msg.type === "control_response" && msg.response?.request_id === "req_deny_bash") {
    log({ event: "can_use_bash", decision: msg.response.response });
    send({
      type: "result",
      subtype: "success",
      session_id: "claude-sess-ts",
      result: "Done.",
      is_error: false,
    });
  }
});
"#;
    std::fs::write(&script_path, mock_js).unwrap();

    let node = find_node();
    let mut env = HashMap::new();
    env.insert(
        "PATH".to_owned(),
        std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".into()),
    );

    let mut opts = Map::new();
    write_native_tool_calling_plan(
        &mut opts,
        &NativeToolCallingPlan {
            tool_search: Some(NativeToolSearchKind::ClaudeAgentSdk),
            programmatic_tool_calling: None,
            deferred_tool_names: vec!["mcp__docs__search".into()],
            programmatic_tool_names: Vec::new(),
            codex_code_mode: None,
        },
    );

    let transport = ClaudeAgentSdkTransport {
        command_override: Some((
            node,
            vec![
                script_path.to_string_lossy().into_owned(),
                log_path.to_string_lossy().into_owned(),
            ],
        )),
        tool_handler: Some(Arc::new(MockToolHandler {
            calls: Mutex::new(Vec::new()),
        })),
        env_override: Some(env),
        cwd: Some(dir.path().to_path_buf()),
        ..Default::default()
    };

    transport
        .stream_step(
            ProviderStepRequest {
                model_id: "claude-opus-5-5".to_owned(),
                base_url: None,
                api_key: None,
                extra_headers: HashMap::new(),
                system_prompt: "You are Cowork.".to_owned(),
                messages: vec![user_message("Search docs")],
                tools: vec![
                    ToolDefinition {
                        name: "bash".to_owned(),
                        description: "Run bash".to_owned(),
                        parameters: json!({ "type": "object" }),
                    },
                    ToolDefinition {
                        name: "mcp__docs__search".to_owned(),
                        description: "Search docs".to_owned(),
                        parameters: json!({ "type": "object" }),
                    },
                ],
                authorized_tool_names: None,
                provider_options: opts,
                continuation: None,
                policy: RequestPolicy::default(),
                turn_id: "turn-claude-ts".to_owned(),
            },
            &StepBudget::unbounded(None),
            &mut |_| {},
        )
        .await
        .expect("claude native tool search turn succeeds");

    let entries: Vec<Value> = std::fs::read_to_string(&log_path)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str::<Value>(l).unwrap())
        .collect();
    let spawn = entries.iter().find(|e| e["event"] == "spawn").unwrap();
    assert_eq!(spawn["enableToolSearch"], json!("true"));
    let args = spawn["args"].as_array().unwrap();
    let tools_pos = args.iter().position(|a| a == "--tools").unwrap();
    assert_eq!(args[tools_pos + 1], json!("ToolSearch"));
    let mcp_pos = args.iter().position(|a| a == "--mcp-config").unwrap();
    let mcp_cfg: Value = serde_json::from_str(args[mcp_pos + 1].as_str().unwrap()).unwrap();
    assert!(mcp_cfg["mcpServers"]["cowork"].get("alwaysLoad").is_none());

    let tools_list = entries.iter().find(|e| e["event"] == "tools_list").unwrap()["tools"]
        .as_array()
        .unwrap();
    let bash_tool = tools_list.iter().find(|t| t["name"] == "bash").unwrap();
    let mcp_tool = tools_list
        .iter()
        .find(|t| t["name"] == "mcp__docs__search")
        .unwrap();
    assert_eq!(bash_tool["_meta"]["anthropic/alwaysLoad"], json!(true));
    assert_eq!(mcp_tool["_meta"]["anthropic/alwaysLoad"], json!(false));

    let allow_ts = entries
        .iter()
        .find(|e| e["event"] == "can_use_tool_search")
        .unwrap();
    assert_eq!(allow_ts["decision"]["behavior"], json!("allow"));
    let deny_bash = entries
        .iter()
        .find(|e| e["event"] == "can_use_bash")
        .unwrap();
    assert_eq!(deny_bash["decision"]["behavior"], json!("deny"));
}
