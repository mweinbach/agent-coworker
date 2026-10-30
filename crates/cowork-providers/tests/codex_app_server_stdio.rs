use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use cowork_config::SandboxMode;
use cowork_inference::{
    CanonicalMessage, ContentBlock, MessageRole, ProviderOpaqueMeta, RequestPolicy, StepBudget,
    StreamEvent,
};
use cowork_providers::codex_app_server::{
    CodexAppServerClient, CodexAppServerTransport, CodexSandboxNarrowingInput,
    CodexTurnSteerParams, DynamicToolCallOutput, DynamicToolHandler, build_codex_spawn_env,
    filter_codex_dynamic_tools, from_codex_mcp_tool_name, read_codex_account,
    read_openai_native_connectors, resolve_codex_home, resolve_codex_sandbox_and_approval_policy,
    set_openai_native_connector_enabled, sync_codex_windows_sandbox_setup_state,
    to_codex_mcp_tool_name,
};
use cowork_providers::{ProviderStepRequest, ProviderTransport, ToolDefinition};
use serde_json::{Map, Value, json};
use uuid::Uuid;

#[test]
fn spawns_isolated_codex_home_strips_codex_env_and_syncs_windows_sandbox_markers() {
    let base = PathBuf::from(format!("/private/tmp/cowork-codex-iso-{}", Uuid::new_v4()));
    std::fs::create_dir_all(base.join(".cowork")).unwrap();
    std::fs::create_dir_all(base.join(".codex")).unwrap();
    let base = std::fs::canonicalize(&base).unwrap();

    // Plant a foreign ~/.codex marker that MUST NEVER be read or touched
    std::fs::write(base.join(".codex/auth.json"), "{\"foreign\":true}").unwrap();

    let cowork_home = base.join(".cowork");
    let codex_home = resolve_codex_home(&cowork_home);
    assert_eq!(codex_home, cowork_home.join("auth/codex-cli"));

    let mut parent_env = HashMap::new();
    parent_env.insert("CODEX_API_KEY".into(), "leaked".into());
    parent_env.insert("codex_home".into(), "/bad/path".into());
    parent_env.insert("COWORK_DESKTOP_PARENT_MANAGED".into(), "1".into());
    parent_env.insert("PATH".into(), "/usr/bin:/bin".into());

    let spawn_env = build_codex_spawn_env(&cowork_home, &parent_env);
    assert!(!spawn_env.contains_key("CODEX_API_KEY"));
    assert!(!spawn_env.contains_key("codex_home"));
    assert!(!spawn_env.contains_key("COWORK_DESKTOP_PARENT_MANAGED"));
    assert_eq!(
        spawn_env.get("CODEX_HOME").map(String::as_str),
        Some(codex_home.to_str().unwrap())
    );
    assert_eq!(
        std::fs::metadata(&codex_home).unwrap().permissions().mode() & 0o777,
        0o700
    );

    // Sync Windows sandbox setup state (version 5, newest-wins) between cowork_home and codex_home
    std::fs::create_dir_all(cowork_home.join(".sandbox")).unwrap();
    std::fs::create_dir_all(cowork_home.join(".sandbox-secrets")).unwrap();
    std::fs::write(
        cowork_home.join(".sandbox/setup_marker.json"),
        json!({ "version": 5, "created_at": "2026-10-30T12:00:00Z" }).to_string(),
    )
    .unwrap();
    std::fs::write(
        cowork_home.join(".sandbox-secrets/sandbox_users.json"),
        json!({ "version": 5, "offline_user": "CodexSandboxOffline" }).to_string(),
    )
    .unwrap();

    assert!(sync_codex_windows_sandbox_setup_state(
        &cowork_home,
        &codex_home
    ));
    assert!(codex_home.join(".sandbox/setup_marker.json").is_file());
    assert!(
        codex_home
            .join(".sandbox-secrets/sandbox_users.json")
            .is_file()
    );
    // Foreign ~/.codex untouched
    assert!(!base.join(".codex/.sandbox").exists());

    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn narrows_danger_full_access_without_network_and_enforces_hybrid_dynamic_tool_boundary() {
    let ws = PathBuf::from("/private/tmp/cowork-codex-ws");

    // 1. DangerFullAccess + network: false MUST narrow to workspace-write + networkAccess: false + web_search disabled
    let narrowed = resolve_codex_sandbox_and_approval_policy(&CodexSandboxNarrowingInput {
        mode: SandboxMode::DangerFullAccess,
        network: false,
        yolo: true,
        workspace_dir: ws.clone(),
        agent_target_paths: Vec::new(),
        read_only_role: false,
        has_mutation_guard_with_dynamic_tools: false,
    });
    assert_eq!(narrowed.thread_sandbox, "workspace-write");
    assert_eq!(narrowed.turn_sandbox_policy["type"], "workspaceWrite");
    assert_eq!(narrowed.turn_sandbox_policy["networkAccess"], false);
    assert!(narrowed.force_disable_web_search);

    // 2. Read-only floor preserved even under yolo: true
    let ro = resolve_codex_sandbox_and_approval_policy(&CodexSandboxNarrowingInput {
        mode: SandboxMode::ReadOnly,
        network: true,
        yolo: true,
        workspace_dir: ws.clone(),
        agent_target_paths: Vec::new(),
        read_only_role: false,
        has_mutation_guard_with_dynamic_tools: false,
    });
    assert_eq!(ro.thread_sandbox, "read-only");
    assert_eq!(ro.turn_sandbox_policy["type"], "readOnly");

    // 3. Scoped targetPaths floor preserved + read/glob/grep retained in dynamic tool boundary
    let scoped = resolve_codex_sandbox_and_approval_policy(&CodexSandboxNarrowingInput {
        mode: SandboxMode::DangerFullAccess,
        network: true,
        yolo: true,
        workspace_dir: ws.clone(),
        agent_target_paths: vec![ws.join("src")],
        read_only_role: false,
        has_mutation_guard_with_dynamic_tools: true,
    });
    assert_eq!(scoped.thread_sandbox, "workspace-write");
    assert_eq!(scoped.approval_policy, "on-request");

    let all_tools = vec![
        ToolDefinition {
            name: "bash".into(),
            description: "bash".into(),
            parameters: json!({"type": "object"}),
        },
        ToolDefinition {
            name: "read".into(),
            description: "read".into(),
            parameters: json!({"type": "object"}),
        },
        ToolDefinition {
            name: "glob".into(),
            description: "glob".into(),
            parameters: json!({"type": "object"}),
        },
        ToolDefinition {
            name: "todoWrite".into(),
            description: "todo".into(),
            parameters: json!({"type": "object"}),
        },
        ToolDefinition {
            name: "mcp__github__list_issues".into(),
            description: "gh".into(),
            parameters: json!({"type": "object"}),
        },
    ];

    let unscoped_dyn = filter_codex_dynamic_tools(&all_tools, false);
    let unscoped_names: Vec<&str> = unscoped_dyn.iter().map(|t| t.name.as_str()).collect();
    assert_eq!(
        unscoped_names,
        vec!["todoWrite", "cowork_mcp__github__list_issues"]
    );

    let scoped_dyn = filter_codex_dynamic_tools(&all_tools, true);
    let scoped_names: Vec<&str> = scoped_dyn.iter().map(|t| t.name.as_str()).collect();
    assert!(scoped_names.contains(&"read"));
    assert!(scoped_names.contains(&"glob"));
    assert!(!scoped_names.contains(&"bash"));

    assert_eq!(
        to_codex_mcp_tool_name("mcp__linear__get"),
        "cowork_mcp__linear__get"
    );
    assert_eq!(
        from_codex_mcp_tool_name("cowork_mcp__linear__get"),
        "mcp__linear__get"
    );
}

#[tokio::test]
async fn streams_turn_bridges_dynamic_tool_calls_forwards_live_steer_and_reads_connectors() {
    let base = PathBuf::from(format!("/private/tmp/cowork-codex-rpc-{}", Uuid::new_v4()));
    std::fs::create_dir_all(base.join("workspace")).unwrap();
    std::fs::create_dir_all(base.join("home/.cowork")).unwrap();
    let base = std::fs::canonicalize(&base).unwrap();
    let cowork_home = base.join("home/.cowork");
    let codex_home = resolve_codex_home(&cowork_home);

    // 1. Missing auth.json fast-paths without spawning codex app-server
    let unauth = read_codex_account(&codex_home, None, false).await.unwrap();
    assert!(!unauth.authenticated);
    assert!(unauth.requires_openai_auth);

    // Write isolated auth.json
    std::fs::create_dir_all(&codex_home).unwrap();
    std::fs::write(codex_home.join("auth.json"), "{\"access_token\":\"tok\"}").unwrap();

    // Create a mock stdio codex app-server node/bun script in /private/tmp
    let mock_script = base.join("mock_codex_app_server.mjs");
    std::fs::write(
        &mock_script,
        r#"
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let connectorEnabled = true;

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ id: msg.id, result: { serverInfo: { name: "mock-codex", version: "0.160.0" } } });
  } else if (msg.method === "account/read") {
    send({ id: msg.id, result: { account: { email: "dev@example.com", planType: "pro" }, requiresOpenaiAuth: false } });
  } else if (msg.method === "mcpServerStatus/list") {
    send({
      id: msg.id,
      result: {
        data: [{
          name: "openai-connectors",
          tools: {
            search: {
              _meta: {
                connector_id: "github",
                connector_name: "GitHub",
                connector_description: "Search GitHub repos"
              }
            }
          }
        }],
        nextCursor: null
      }
    });
  } else if (msg.method === "config/read") {
    send({
      id: msg.id,
      result: { config: { apps: { github: { enabled: connectorEnabled } } } }
    });
  } else if (msg.method === "config/value/write") {
    if (msg.params?.keyPath === "apps.github.enabled") {
      connectorEnabled = Boolean(msg.params.value);
    }
    send({ id: msg.id, result: { ok: true } });
  } else if (msg.method === "model/list") {
    send({
      id: msg.id,
      result: {
        data: [{ id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", isDefault: true }],
        nextCursor: null
      }
    });
  } else if (msg.method === "thread/start") {
    send({ id: msg.id, result: { thread: { id: "codex-thr-1" } } });
  } else if (msg.method === "turn/steer") {
    send({
      id: msg.id,
      result: { turnId: msg.params.expectedTurnId, accepted: true }
    });
  } else if (msg.method === "turn/start") {
    // Issue a server-initiated dynamic tool call before completing the turn!
    send({
      id: "srv-tool-1",
      method: "item/tool/call",
      params: {
        threadId: "codex-thr-1",
        turnId: "codex-turn-1",
        callId: "dyn-call-1",
        tool: "cowork_mcp__github__list_issues",
        arguments: { repo: "agent-coworker" }
      }
    });
    // Also send turn/start response
    send({ id: msg.id, result: { turn: { id: "codex-turn-1" } } });
  } else if (msg.id === "srv-tool-1" && msg.result) {
    // Received dynamic tool output from Cowork! Emit deltas and complete turn in a single write
    const combined =
      JSON.stringify({
        method: "item/agentMessage/delta",
        params: { threadId: "codex-thr-1", turnId: "codex-turn-1", itemId: "msg-1", delta: "Found issues: " + msg.result.contentItems[0].text }
      }) + "\n" +
      JSON.stringify({
        method: "turn/completed",
        params: {
          threadId: "codex-thr-1",
          turn: { id: "codex-turn-1", status: "completed" },
          usage: { inputTokens: 40, outputTokens: 12 }
        }
      }) + "\n";
    process.stdout.write(combined);
  }
});
"#,
    )
    .unwrap();

    struct MockToolBridge {
        calls: Mutex<Vec<(String, Map<String, Value>)>>,
    }

    #[async_trait]
    impl DynamicToolHandler for MockToolBridge {
        async fn call_tool(
            &self,
            name: &str,
            arguments: Map<String, Value>,
        ) -> DynamicToolCallOutput {
            self.calls
                .lock()
                .unwrap()
                .push((name.to_string(), arguments));
            DynamicToolCallOutput {
                text: "#42 open".into(),
                is_error: false,
            }
        }
    }

    let bridge = Arc::new(MockToolBridge {
        calls: Mutex::new(Vec::new()),
    });

    let mut env = HashMap::new();
    env.insert(
        "HOME".into(),
        base.join("home").to_string_lossy().into_owned(),
    );
    env.insert(
        "COWORK_HOME_OVERRIDE".into(),
        base.join("home").to_string_lossy().into_owned(),
    );
    env.insert(
        "PATH".into(),
        std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".into()),
    );

    let client = CodexAppServerClient::spawn_stdio(
        "node",
        &[mock_script.to_string_lossy().into_owned()],
        &base.join("workspace"),
        &cowork_home,
        &env,
        Some(bridge.clone()),
    )
    .await
    .unwrap();

    // Account + connectors + steer checks
    let acct = read_codex_account(&codex_home, Some(&client), false)
        .await
        .unwrap();
    assert!(acct.authenticated);
    assert_eq!(acct.email.as_deref(), Some("dev@example.com"));

    let conn_evt = read_openai_native_connectors("sess-1", &codex_home, Some(&client), false)
        .await
        .unwrap();
    assert_eq!(conn_evt.connectors.len(), 1);
    assert_eq!(conn_evt.connectors[0].id, "github");
    assert!(conn_evt.connectors[0].is_enabled);

    let toggled =
        set_openai_native_connector_enabled("sess-1", &codex_home, &client, "github", false)
            .await
            .unwrap();
    assert!(!toggled.connectors[0].is_enabled);

    let steer_res = client
        .steer_turn(CodexTurnSteerParams {
            thread_id: "codex-thr-1".into(),
            expected_turn_id: "codex-turn-1".into(),
            input_text: "Focus on open bugs".into(),
        })
        .await
        .unwrap();
    assert_eq!(steer_res["accepted"], true);

    client.close().await;

    // Also run full ProviderTransport::stream_step with dynamic tool bridging!
    let mut transport = CodexAppServerTransport::with_command_override(
        "node".into(),
        vec![mock_script.to_string_lossy().into_owned()],
    );
    let mut opts = Map::new();
    opts.insert(
        "cwd".into(),
        json!(base.join("workspace").to_string_lossy()),
    );
    opts.insert("coworkHome".into(), json!(cowork_home.to_string_lossy()));

    // Attach dynamic tool handler via transport
    let _ = &mut transport;
    let mut events = Vec::new();
    let step_res = CodexAppServerTransport::with_command_and_handler(
        "node".into(),
        vec![mock_script.to_string_lossy().into_owned()],
        Some(bridge.clone()),
    )
    .stream_step(
        ProviderStepRequest {
            model_id: "gpt-5.6-sol".into(),
            base_url: None,
            api_key: None,
            extra_headers: HashMap::new(),
            system_prompt: "Instructions".into(),
            messages: vec![CanonicalMessage {
                id: "u1".into(),
                role: MessageRole::User,
                content: vec![ContentBlock::Text {
                    text: "List GitHub issues".into(),
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
                created_at: "2026-10-30T00:00:00Z".into(),
            }],
            tools: vec![ToolDefinition {
                name: "mcp__github__list_issues".into(),
                description: "List issues".into(),
                parameters: json!({ "type": "object" }),
            }],
            authorized_tool_names: None,
            provider_options: opts,
            continuation: None,
            policy: RequestPolicy::default(),
            turn_id: "turn-codex-1".into(),
        },
        &StepBudget::new(30_000, None),
        &mut |ev| events.push(ev),
    )
    .await
    .unwrap();

    assert!(events.iter().any(|e| matches!(
        e,
        StreamEvent::TextDelta { delta, .. } if delta.contains("#42 open")
    )));
    assert_eq!(step_res.usage.prompt_tokens, 40);
    assert_eq!(step_res.usage.completion_tokens, 12);

    let recorded_calls = bridge.calls.lock().unwrap();
    assert_eq!(recorded_calls.len(), 1);
    assert_eq!(recorded_calls[0].0, "mcp__github__list_issues");

    let _ = std::fs::remove_dir_all(&base);
}
