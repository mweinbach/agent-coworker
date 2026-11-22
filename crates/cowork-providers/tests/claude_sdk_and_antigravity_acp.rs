//! Deterministic integration tests for the Cowork-managed `claude-sdk` and `antigravity-acp`
//! runtime installers (checksum-verified download + fail-closed tamper rejection) and stdio
//! wire transports (streaming thoughts/text/tools, fail-closed permission bridge, and continuation).

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use async_trait::async_trait;
use axum::Router;
use axum::body::Body;
use axum::http::{Response, StatusCode};
use axum::routing::get;
use cowork_inference::{
    CanonicalMessage, ContentBlock, MediaKind, MediaSource, MessageRole, ProviderContinuationState,
    ProviderOpaqueMeta, RequestPolicy, StepBudget, StreamEvent,
};
use cowork_providers::antigravity_acp::{
    ANTIGRAVITY_ACP_MANAGED_VERSION, AntigravityAcpInstallOptions, AntigravityAcpTransport,
    build_antigravity_acp_spawn_env, install_antigravity_acp, resolve_antigravity_acp_home,
    resolve_antigravity_acp_status,
};
use cowork_providers::claude_sdk::{
    CLAUDE_SDK_MANAGED_VERSION, ClaudeSdkInstallOptions, ClaudeSdkTransport,
    build_claude_sdk_spawn_env, install_claude_sdk, resolve_claude_sdk_home,
    resolve_claude_sdk_status,
};
use cowork_providers::codex_app_server::{DynamicToolCallOutput, DynamicToolHandler};
use cowork_providers::{ManagedRuntimeTarget, ProviderStepRequest, ProviderTransport};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256, Sha512};
use tempfile::TempDir;
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

struct TestApprovalHandler {
    allow: bool,
    calls: AtomicUsize,
}

#[async_trait]
impl DynamicToolHandler for TestApprovalHandler {
    async fn call_tool(
        &self,
        _name: &str,
        _arguments: Map<String, Value>,
    ) -> DynamicToolCallOutput {
        DynamicToolCallOutput {
            text: "ok".to_owned(),
            is_error: false,
        }
    }

    async fn request_approval(&self, _method: &str, _params: &Value) -> bool {
        self.calls.fetch_add(1, Ordering::Relaxed);
        self.allow
    }
}

fn user_msg(text: &str) -> CanonicalMessage {
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
        created_at: "2026-01-01T00:00:00Z".to_owned(),
    }
}

fn make_tar_gz(entry_name: &str, contents: &[u8]) -> Vec<u8> {
    let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    let mut builder = tar::Builder::new(encoder);
    let mut header = tar::Header::new_gnu();
    header.set_size(contents.len() as u64);
    header.set_mode(0o755);
    header.set_cksum();
    builder
        .append_data(&mut header, entry_name, contents)
        .unwrap();
    let encoder = builder.into_inner().unwrap();
    encoder.finish().unwrap()
}

#[tokio::test]
async fn claude_sdk_installer_verifies_sha256_and_fails_closed_on_tampering() {
    let payload = b"#!/bin/sh\necho mock-claude-binary\n".to_vec();
    let good_sha256 = hex::encode(Sha256::digest(&payload));
    let target = ManagedRuntimeTarget::host().unwrap();
    let platform_key = cowork_providers::claude_sdk::installer::claude_platform_key(&target)
        .unwrap()
        .to_owned();
    let bin_name = format!("claude{}", target.exe_suffix());
    let serve_path = format!("/{CLAUDE_SDK_MANAGED_VERSION}/{platform_key}/{bin_name}");
    let serve_bytes = Arc::new(payload.clone());
    let tampered = Arc::new(AtomicBool::new(false));
    let tampered_flag = Arc::clone(&tampered);

    let app = Router::new().route(
        &serve_path,
        get(move || {
            let bytes = Arc::clone(&serve_bytes);
            let bad = tampered_flag.load(Ordering::Relaxed);
            async move {
                let body = if bad {
                    b"CORRUPTED-BYTES".to_vec()
                } else {
                    bytes.as_ref().clone()
                };
                Response::builder()
                    .status(StatusCode::OK)
                    .body(Body::from(body))
                    .unwrap()
            }
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    let tmp = TempDir::new().unwrap();
    let cowork_home = tmp.path().join(".cowork");
    let mut checksums = HashMap::new();
    checksums.insert(platform_key.clone(), good_sha256);

    let opts = ClaudeSdkInstallOptions {
        release_base_url: format!("http://127.0.0.1:{port}"),
        target: Some(target.clone()),
        expected_checksums: Some(checksums),
        download_timeout: None,
        max_download_bytes: None,
    };

    // 1. Tampered payload fails closed before promotion.
    tampered.store(true, Ordering::Relaxed);
    let err = install_claude_sdk(&cowork_home, CLAUDE_SDK_MANAGED_VERSION, false, &opts)
        .await
        .expect_err("tampered download must fail checksum verification");
    assert!(err.contains("SHA-256"), "unexpected error: {err}");
    let status_before = resolve_claude_sdk_status(&cowork_home, &HashMap::new());
    assert!(!status_before.available);
    assert_eq!(status_before.source, "missing");

    // 2. Verified payload installs and promotes cleanly.
    tampered.store(false, Ordering::Relaxed);
    let installed = install_claude_sdk(&cowork_home, CLAUDE_SDK_MANAGED_VERSION, false, &opts)
        .await
        .expect("verified download must install");
    assert_eq!(installed.version, CLAUDE_SDK_MANAGED_VERSION);
    assert!(installed.command.is_file());

    let status_after = resolve_claude_sdk_status(&cowork_home, &HashMap::new());
    assert!(status_after.available);
    assert_eq!(status_after.source, "managed");
    assert_eq!(
        status_after.version.as_deref(),
        Some(CLAUDE_SDK_MANAGED_VERSION)
    );
    assert_eq!(status_after.pin_matches_current, Some(true));

    // 3. Isolated spawn env pins CLAUDE_CONFIG_DIR and strips inherited CLAUDE_* secrets.
    let mut parent = HashMap::new();
    parent.insert("CLAUDE_CONFIG_DIR".into(), "/Users/someone/.claude".into());
    parent.insert("ANTHROPIC_API_KEY".into(), "leaked-ambient-key".into());
    let spawn_env = build_claude_sdk_spawn_env(&cowork_home, &parent, Some("sk-ant-oat-test-123"));
    assert_eq!(
        spawn_env.get("CLAUDE_CONFIG_DIR").map(String::as_str),
        Some(
            resolve_claude_sdk_home(&cowork_home)
                .to_string_lossy()
                .as_ref()
        )
    );
    assert_eq!(
        spawn_env.get("CLAUDE_CODE_OAUTH_TOKEN").map(String::as_str),
        Some("sk-ant-oat-test-123")
    );
    assert!(!spawn_env.contains_key("ANTHROPIC_API_KEY"));

    server.abort();
}

#[tokio::test]
async fn antigravity_acp_installer_verifies_sha512_extracts_and_fails_closed() {
    let target = ManagedRuntimeTarget::host().unwrap();
    let platform_key =
        cowork_providers::antigravity_acp::installer::antigravity_platform_key(&target)
            .unwrap()
            .to_owned();
    let payload = if target.is_windows() {
        b"mock-windows-antigravity-exe".to_vec()
    } else {
        make_tar_gz("antigravity", b"#!/bin/sh\necho mock-agy\n")
    };
    let good_sha512 = hex::encode(Sha512::digest(&payload));

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let artifact_path = if target.is_windows() {
        "/artifacts/antigravity.exe"
    } else {
        "/artifacts/antigravity.tar.gz"
    };
    let artifact_url = format!("http://127.0.0.1:{port}{artifact_path}");
    let manifest_path = format!("/manifests/{platform_key}.json");
    let manifest_body = json!({
        "version": ANTIGRAVITY_ACP_MANAGED_VERSION,
        "url": artifact_url,
        "sha512": good_sha512,
    })
    .to_string();

    let serve_bytes = Arc::new(payload);
    let tampered = Arc::new(AtomicBool::new(false));
    let tampered_flag = Arc::clone(&tampered);

    let app = Router::new()
        .route(
            &manifest_path,
            get(move || {
                let body = manifest_body.clone();
                async move {
                    Response::builder()
                        .status(StatusCode::OK)
                        .header("content-type", "application/json")
                        .body(Body::from(body))
                        .unwrap()
                }
            }),
        )
        .route(
            artifact_path,
            get(move || {
                let bytes = Arc::clone(&serve_bytes);
                let bad = tampered_flag.load(Ordering::Relaxed);
                async move {
                    let body = if bad {
                        b"TAMPERED-ARCHIVE".to_vec()
                    } else {
                        bytes.as_ref().clone()
                    };
                    Response::builder()
                        .status(StatusCode::OK)
                        .body(Body::from(body))
                        .unwrap()
                }
            }),
        );
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    let tmp = TempDir::new().unwrap();
    let cowork_home = tmp.path().join(".cowork");
    let mut checksums = HashMap::new();
    checksums.insert(platform_key.clone(), good_sha512);

    let opts = AntigravityAcpInstallOptions {
        manifest_base_url: format!("http://127.0.0.1:{port}"),
        target: Some(target.clone()),
        expected_checksums: Some(checksums),
        download_timeout: None,
        max_download_bytes: None,
    };

    // 1. Tampered archive fails closed BEFORE extraction.
    tampered.store(true, Ordering::Relaxed);
    let err = install_antigravity_acp(&cowork_home, ANTIGRAVITY_ACP_MANAGED_VERSION, false, &opts)
        .await
        .expect_err("tampered archive must fail SHA-512 verification");
    assert!(err.contains("SHA-512"), "unexpected error: {err}");
    assert!(!resolve_antigravity_acp_status(&cowork_home, &HashMap::new()).available);

    // 2. Verified archive installs cleanly.
    tampered.store(false, Ordering::Relaxed);
    let installed =
        install_antigravity_acp(&cowork_home, ANTIGRAVITY_ACP_MANAGED_VERSION, false, &opts)
            .await
            .expect("verified archive must install");
    assert_eq!(installed.version, ANTIGRAVITY_ACP_MANAGED_VERSION);
    assert!(installed.command.is_file());
    let status = resolve_antigravity_acp_status(&cowork_home, &HashMap::new());
    assert!(status.available);
    assert_eq!(status.source, "managed");
    assert_eq!(status.pin_matches_current, Some(true));

    // 3. Isolated env strips inherited ANTIGRAVITY_* / AGY_* and pins ~/.cowork/auth/antigravity-acp.
    let mut parent = HashMap::new();
    parent.insert("ANTIGRAVITY_HOME".into(), "/leaked/home".into());
    parent.insert("AGY_TOKEN".into(), "leaked".into());
    let spawn_env = build_antigravity_acp_spawn_env(&cowork_home, &parent, Some("gem-key-1"));
    assert_eq!(
        spawn_env.get("ANTIGRAVITY_HOME").map(String::as_str),
        Some(
            resolve_antigravity_acp_home(&cowork_home)
                .to_string_lossy()
                .as_ref()
        )
    );
    assert!(!spawn_env.contains_key("AGY_TOKEN"));
    assert_eq!(
        spawn_env.get("GEMINI_API_KEY").map(String::as_str),
        Some("gem-key-1")
    );

    server.abort();
}

#[cfg(unix)]
#[tokio::test]
async fn claude_sdk_transport_streams_thoughts_text_tools_permissions_and_resumes() {
    use std::os::unix::fs::PermissionsExt;

    let tmp = TempDir::new().unwrap();
    let script_path = tmp.path().join("mock-claude.py");
    let script = r#"#!/usr/bin/env python3
import json, sys

args = sys.argv[1:]
resumed = "--resume" in args
resume_id = args[args.index("--resume") + 1] if resumed else None

def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    if msg.get("type") == "control_request" and msg.get("request", {}).get("subtype") == "initialize":
        emit({
            "type": "control_response",
            "response": {"subtype": "success", "request_id": msg["request_id"], "response": {}}
        })
    elif msg.get("type") == "user":
        sid = resume_id or "claude-sess-42"
        emit({"type": "system", "subtype": "init", "session_id": sid})
        # Request permission via stdio control protocol
        emit({
            "type": "control_request",
            "request_id": "perm-1",
            "request": {"subtype": "can_use_tool", "tool_name": "Bash", "input": {"command": "echo hi"}}
        })
        perm_line = sys.stdin.readline().strip()
        perm = json.loads(perm_line)
        behavior = perm["response"]["response"]["behavior"]
        emit({"type": "stream_event", "event": {"type": "content_block_start", "index": 0, "content_block": {"type": "thinking"}}})
        emit({"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "Checking permission."}}})
        emit({"type": "stream_event", "event": {"type": "content_block_stop", "index": 0}})
        emit({"type": "stream_event", "event": {"type": "content_block_start", "index": 1, "content_block": {"type": "tool_use", "id": "tu-1", "name": "Bash"}}})
        emit({"type": "stream_event", "event": {"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": "{\"command\":\"echo hi\"}"}}})
        emit({"type": "stream_event", "event": {"type": "content_block_stop", "index": 1}})
        emit({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "tu-1", "content": f"perm={behavior}", "is_error": behavior != "allow"}]}})
        reply = f"perm={behavior};resumed={resumed};effort={args[args.index('--effort')+1] if '--effort' in args else 'none'}"
        emit({"type": "stream_event", "event": {"type": "content_block_start", "index": 2, "content_block": {"type": "text"}}})
        emit({"type": "stream_event", "event": {"type": "content_block_delta", "index": 2, "delta": {"type": "text_delta", "text": reply}}})
        emit({"type": "stream_event", "event": {"type": "content_block_stop", "index": 2}})
        emit({
            "type": "result",
            "subtype": "success",
            "is_error": False,
            "session_id": sid,
            "result": reply,
            "usage": {"input_tokens": 120, "output_tokens": 35, "cache_read_input_tokens": 10}
        })
        break
"#;
    std::fs::write(&script_path, script).unwrap();
    std::fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o755)).unwrap();

    let mut env = HashMap::new();
    env.insert("HOME".into(), tmp.path().to_string_lossy().into_owned());
    env.insert("PATH".into(), std::env::var("PATH").unwrap_or_default());
    let handler = Arc::new(TestApprovalHandler {
        allow: true,
        calls: AtomicUsize::new(0),
    });

    let mut transport =
        ClaudeSdkTransport::with_env_and_handler(env.clone(), Some(handler.clone()));
    transport.command_override = Some((script_path.to_string_lossy().into_owned(), Vec::new()));

    let mut provider_options = Map::new();
    provider_options.insert("claude-sdk".into(), json!({ "reasoningEffort": "high" }));
    provider_options.insert("cwd".into(), json!(tmp.path().to_string_lossy()));

    let req1 = ProviderStepRequest {
        model_id: "claude-opus-4-8".to_owned(),
        base_url: None,
        api_key: Some("sk-ant-test".to_owned()),
        extra_headers: HashMap::new(),
        system_prompt: "Be concise.".to_owned(),
        messages: vec![user_msg("Hello Claude SDK")],
        tools: Vec::new(),
        authorized_tool_names: None,
        provider_options: provider_options.clone(),
        continuation: None,
        policy: RequestPolicy::default(),
        turn_id: "turn-1".to_owned(),
    };

    let budget = StepBudget::unbounded(Some(CancellationToken::new()));
    let mut events = Vec::new();
    let res1 = transport
        .stream_step(req1, &budget, &mut |ev| events.push(ev))
        .await
        .expect("Claude SDK first turn succeeds");

    assert_eq!(handler.calls.load(Ordering::Relaxed), 1);
    assert!(
        events
            .iter()
            .any(|e| matches!(e, StreamEvent::ThinkingDelta { .. }))
    );
    assert!(
        events
            .iter()
            .any(|e| matches!(e, StreamEvent::ToolCallEnd { key, .. } if key == "tu-1"))
    );
    assert!(events.iter().any(
        |e| matches!(e, StreamEvent::ToolResult { key, name, is_error: false, .. } if key == "tu-1" && name == "Bash")
    ));
    assert_eq!(res1.usage.completion_tokens, 35);
    assert_eq!(res1.usage.cached_prompt_tokens, Some(10));
    let text1 = res1
        .assistant
        .content
        .iter()
        .find_map(|b| match b {
            ContentBlock::Text { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .unwrap();
    assert_eq!(text1, "perm=allow;resumed=False;effort=high");

    // Verify continuation carries sessionId and triggers `--resume` on turn 2 + fail-closed deny when handler is None.
    let cont = res1.continuation.clone().expect("Claude SDK continuation");
    assert!(matches!(
        &cont,
        ProviderContinuationState::ClaudeSdk { session_id, .. } if session_id == "claude-sess-42"
    ));

    let mut deny_transport = ClaudeSdkTransport::with_env(env);
    deny_transport.command_override =
        Some((script_path.to_string_lossy().into_owned(), Vec::new()));
    let req2 = ProviderStepRequest {
        model_id: "claude-opus-4-8".to_owned(),
        base_url: None,
        api_key: Some("sk-ant-test".to_owned()),
        extra_headers: HashMap::new(),
        system_prompt: "Be concise.".to_owned(),
        messages: vec![
            user_msg("Hello Claude SDK"),
            res1.assistant.clone(),
            user_msg("Follow up"),
        ],
        tools: Vec::new(),
        authorized_tool_names: None,
        provider_options,
        continuation: Some(cont),
        policy: RequestPolicy::default(),
        turn_id: "turn-2".to_owned(),
    };
    let mut events2 = Vec::new();
    let res2 = deny_transport
        .stream_step(req2, &budget, &mut |ev| events2.push(ev))
        .await
        .expect("Claude SDK resumed turn succeeds");
    let text2 = res2
        .assistant
        .content
        .iter()
        .find_map(|b| match b {
            ContentBlock::Text { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .unwrap();
    assert_eq!(text2, "perm=deny;resumed=True;effort=high");
}

#[cfg(unix)]
#[tokio::test]
async fn antigravity_acp_transport_speaks_acp_jsonrpc_permissions_and_resumes() {
    use std::os::unix::fs::PermissionsExt;

    let tmp = TempDir::new().unwrap();
    let script_path = tmp.path().join("mock-agy.py");
    let script = r#"#!/usr/bin/env python3
import json, sys

def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

model = "default"
thought = "default"
resumed = False
authed = False

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    method = msg.get("method")
    req_id = msg.get("id")
    params = msg.get("params", {})

    if method == "initialize":
        send({
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "protocolVersion": 1,
                "authMethods": [{"id": "gemini-api-key", "name": "Gemini API Key"}],
                "agentInfo": {"name": "mock-agy", "version": "1.5.14"}
            }
        })
    elif method == "authenticate":
        authed = params.get("methodId") == "gemini-api-key"
        send({"jsonrpc": "2.0", "id": req_id, "result": {}})
    elif method == "session/new":
        send({"jsonrpc": "2.0", "id": req_id, "result": {"sessionId": "acp-sess-99"}})
    elif method == "session/resume":
        resumed = params.get("sessionId") == "acp-sess-99"
        send({"jsonrpc": "2.0", "id": req_id, "result": {"sessionId": params.get("sessionId")}})
    elif method == "session/set_model":
        model = params.get("modelId", model)
        send({"jsonrpc": "2.0", "id": req_id, "result": {}})
    elif method == "session/set_config_option":
        if params.get("configId") == "thought_level":
            thought = params.get("value", thought)
        send({"jsonrpc": "2.0", "id": req_id, "result": {}})
    elif method == "session/prompt":
        sid = params.get("sessionId")
        # Server-initiated permission request
        send({
            "jsonrpc": "2.0",
            "id": 9001,
            "method": "session/request_permission",
            "params": {
                "sessionId": sid,
                "toolCall": {"toolCallId": "tc-1", "title": "run_cmd"},
                "options": [
                    {"optionId": "opt-allow", "name": "Allow once", "kind": "allow_once"},
                    {"optionId": "opt-deny", "name": "Reject once", "kind": "reject_once"}
                ]
            }
        })
        perm_resp = json.loads(sys.stdin.readline().strip())
        chosen = perm_resp["result"]["outcome"].get("optionId", perm_resp["result"]["outcome"].get("outcome"))
        send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": sid, "update": {"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": "Planning via ACP."}}}})
        send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": sid, "update": {"sessionUpdate": "tool_call", "toolCallId": "tc-1", "title": "run_cmd", "rawInput": {"cmd": "ls"}}}})
        send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": sid, "update": {"sessionUpdate": "tool_call_update", "toolCallId": "tc-1", "title": "run_cmd", "status": "completed", "rawOutput": "README.md"}}})
        reply = f"model={model};thought={thought};authed={authed};perm={chosen};resumed={resumed}"
        send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": sid, "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": reply}}}})
        send({
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "stopReason": "end_turn",
                "usage": {"inputTokens": 200, "outputTokens": 40, "thoughtTokens": 15}
            }
        })
        break
"#;
    std::fs::write(&script_path, script).unwrap();
    std::fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o755)).unwrap();

    let mut env = HashMap::new();
    env.insert("HOME".into(), tmp.path().to_string_lossy().into_owned());
    env.insert("PATH".into(), std::env::var("PATH").unwrap_or_default());
    let handler = Arc::new(TestApprovalHandler {
        allow: true,
        calls: AtomicUsize::new(0),
    });

    let mut transport =
        AntigravityAcpTransport::with_env_and_handler(env.clone(), Some(handler.clone()));
    transport.command_override = Some((script_path.to_string_lossy().into_owned(), Vec::new()));

    let mut provider_options = Map::new();
    provider_options.insert(
        "antigravity-acp".into(),
        json!({ "reasoningEffort": "xhigh" }),
    );
    provider_options.insert("cwd".into(), json!(tmp.path().to_string_lossy()));

    let req1 = ProviderStepRequest {
        model_id: "gemini-4-neon".to_owned(),
        base_url: None,
        api_key: Some("gemini-secret".to_owned()),
        extra_headers: HashMap::new(),
        system_prompt: "Be helpful.".to_owned(),
        messages: vec![user_msg("Hello Antigravity")],
        tools: Vec::new(),
        authorized_tool_names: None,
        provider_options: provider_options.clone(),
        continuation: None,
        policy: RequestPolicy::default(),
        turn_id: "turn-acp-1".to_owned(),
    };

    let budget = StepBudget::unbounded(Some(CancellationToken::new()));
    let mut events = Vec::new();
    let res1 = transport
        .stream_step(req1, &budget, &mut |ev| events.push(ev))
        .await
        .expect("Antigravity ACP turn succeeds");

    assert_eq!(handler.calls.load(Ordering::Relaxed), 1);
    assert!(
        events
            .iter()
            .any(|e| matches!(e, StreamEvent::ThinkingDelta { .. }))
    );
    assert!(
        events
            .iter()
            .any(|e| matches!(e, StreamEvent::ToolCallEnd { key, .. } if key == "tc-1"))
    );
    assert!(events.iter().any(
        |e| matches!(e, StreamEvent::ToolResult { key, is_error: false, .. } if key == "tc-1")
    ));
    assert_eq!(res1.usage.prompt_tokens, 200);
    assert_eq!(res1.usage.completion_tokens, 40);
    assert_eq!(res1.usage.reasoning_output_tokens, Some(15));
    let text1 = res1
        .assistant
        .content
        .iter()
        .find_map(|b| match b {
            ContentBlock::Text { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .unwrap();
    assert_eq!(
        text1,
        "model=gemini-4-neon;thought=xhigh;authed=True;perm=opt-allow;resumed=False"
    );

    // Turn 2: verifies session/resume + fail-closed rejection when handler is None.
    let cont = res1.continuation.clone().expect("ACP continuation");
    assert!(matches!(
        &cont,
        ProviderContinuationState::AntigravityAcp { session_id, .. } if session_id == "acp-sess-99"
    ));
    let mut deny_transport = AntigravityAcpTransport::with_env(env);
    deny_transport.command_override =
        Some((script_path.to_string_lossy().into_owned(), Vec::new()));
    let req2 = ProviderStepRequest {
        model_id: "gemini-4-neon".to_owned(),
        base_url: None,
        api_key: Some("gemini-secret".to_owned()),
        extra_headers: HashMap::new(),
        system_prompt: "Be helpful.".to_owned(),
        messages: vec![
            user_msg("Hello Antigravity"),
            res1.assistant.clone(),
            user_msg("Next step"),
        ],
        tools: Vec::new(),
        authorized_tool_names: None,
        provider_options,
        continuation: Some(cont),
        policy: RequestPolicy::default(),
        turn_id: "turn-acp-2".to_owned(),
    };
    let mut events2 = Vec::new();
    let res2 = deny_transport
        .stream_step(req2, &budget, &mut |ev| events2.push(ev))
        .await
        .expect("Antigravity ACP resumed turn succeeds");
    let text2 = res2
        .assistant
        .content
        .iter()
        .find_map(|b| match b {
            ContentBlock::Text { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .unwrap();
    assert_eq!(
        text2,
        "model=gemini-4-neon;thought=xhigh;authed=True;perm=opt-deny;resumed=True"
    );
}

fn user_msg_with_image(text: &str, data: &str, mime_type: &str) -> CanonicalMessage {
    CanonicalMessage {
        id: "u-img".to_owned(),
        role: MessageRole::User,
        content: vec![
            ContentBlock::Text {
                text: text.to_owned(),
                phase: None,
                citations: Vec::new(),
                provider_meta: ProviderOpaqueMeta::default(),
            },
            ContentBlock::Media {
                kind: MediaKind::Image,
                source: MediaSource::Base64 {
                    data: data.to_owned(),
                    mime_type: mime_type.to_owned(),
                },
                provider_meta: ProviderOpaqueMeta::default(),
            },
        ],
        phase: None,
        provider: None,
        api: None,
        model: None,
        stop_reason: None,
        provider_meta: ProviderOpaqueMeta::default(),
        created_at: "2026-01-01T00:00:00Z".to_owned(),
    }
}

fn assistant_msg(text: &str) -> CanonicalMessage {
    CanonicalMessage {
        id: "a1".to_owned(),
        role: MessageRole::Assistant,
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
        created_at: "2026-01-01T00:00:01Z".to_owned(),
    }
}

#[cfg(unix)]
#[tokio::test]
async fn claude_sdk_enforces_authorized_tool_allowlist_and_preserves_history_images() {
    use std::os::unix::fs::PermissionsExt;

    let tmp = TempDir::new().unwrap();
    let script_path = tmp.path().join("mock-claude-allowlist.py");
    let script = r#"#!/usr/bin/env python3
import json, sys

args = sys.argv[1:]
disallowed = args[args.index("--disallowedTools") + 1] if "--disallowedTools" in args else ""

def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    if msg.get("type") == "control_request" and msg.get("request", {}).get("subtype") == "initialize":
        emit({
            "type": "control_response",
            "response": {"subtype": "success", "request_id": msg["request_id"], "response": {}}
        })
    elif msg.get("type") == "user":
        content = msg["message"]["content"]
        image_datas = [
            b["source"]["data"]
            for b in content
            if isinstance(b, dict) and b.get("type") == "image"
        ]
        # First request a disallowed native Bash tool, then an allowed native Read tool.
        emit({
            "type": "control_request",
            "request_id": "perm-bash",
            "request": {"subtype": "can_use_tool", "tool_name": "Bash", "input": {"command": "rm -rf /"}}
        })
        bash_perm = json.loads(sys.stdin.readline().strip())["response"]["response"]["behavior"]
        emit({
            "type": "control_request",
            "request_id": "perm-read",
            "request": {"subtype": "can_use_tool", "tool_name": "Read", "input": {"file_path": "README.md"}}
        })
        read_perm = json.loads(sys.stdin.readline().strip())["response"]["response"]["behavior"]
        reply = f"bash={bash_perm};read={read_perm};images={','.join(image_datas)};has_disallowed_bash={'Bash' in disallowed.split(',')}"
        emit({"type": "stream_event", "event": {"type": "content_block_start", "index": 0, "content_block": {"type": "text"}}})
        emit({"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": reply}}})
        emit({"type": "stream_event", "event": {"type": "content_block_stop", "index": 0}})
        emit({
            "type": "result",
            "subtype": "success",
            "is_error": False,
            "session_id": "claude-allow-1",
            "result": reply,
            "usage": {"input_tokens": 10, "output_tokens": 5}
        })
        break
"#;
    std::fs::write(&script_path, script).unwrap();
    std::fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o755)).unwrap();

    let mut env = HashMap::new();
    env.insert("HOME".into(), tmp.path().to_string_lossy().into_owned());
    env.insert("PATH".into(), std::env::var("PATH").unwrap_or_default());
    // Handler approves everything (simulating YOLO mode); allowlist MUST still deny Bash before handler is called.
    let handler = Arc::new(TestApprovalHandler {
        allow: true,
        calls: AtomicUsize::new(0),
    });
    let mut transport = ClaudeSdkTransport::with_env_and_handler(env, Some(handler.clone()));
    transport.command_override = Some((script_path.to_string_lossy().into_owned(), Vec::new()));

    let mut provider_options = Map::new();
    provider_options.insert("cwd".into(), json!(tmp.path().to_string_lossy()));

    let req = ProviderStepRequest {
        model_id: "claude-opus-4-8".to_owned(),
        base_url: None,
        api_key: Some("sk-ant-test".to_owned()),
        extra_headers: HashMap::new(),
        system_prompt: "Read only.".to_owned(),
        messages: vec![
            user_msg_with_image("Inspect this screenshot", "IMG_TURN_1_BASE64", "image/png"),
            assistant_msg("I see a dashboard."),
            user_msg("What color is the chart?"),
        ],
        tools: Vec::new(),
        authorized_tool_names: Some(vec!["read".to_owned()]),
        provider_options,
        continuation: None,
        policy: RequestPolicy::default(),
        turn_id: "turn-allow-1".to_owned(),
    };

    let budget = StepBudget::unbounded(Some(CancellationToken::new()));
    let res = transport
        .stream_step(req, &budget, &mut |_| {})
        .await
        .expect("Claude SDK turn succeeds");

    // Handler was ONLY consulted for allowed `Read`, never for disallowed `Bash`.
    assert_eq!(handler.calls.load(Ordering::Relaxed), 1);
    let text = res
        .assistant
        .content
        .iter()
        .find_map(|b| match b {
            ContentBlock::Text { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .unwrap();
    assert_eq!(
        text,
        "bash=deny;read=allow;images=IMG_TURN_1_BASE64;has_disallowed_bash=True"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn antigravity_acp_enforces_authorized_tool_allowlist_and_preserves_history_images() {
    use std::os::unix::fs::PermissionsExt;

    let tmp = TempDir::new().unwrap();
    let script_path = tmp.path().join("mock-agy-allowlist.py");
    let script = r#"#!/usr/bin/env python3
import json, sys

def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    method = msg.get("method")
    req_id = msg.get("id")
    params = msg.get("params", {})

    if method == "initialize":
        send({"jsonrpc": "2.0", "id": req_id, "result": {"protocolVersion": 1}})
    elif method == "session/new":
        send({"jsonrpc": "2.0", "id": req_id, "result": {"sessionId": "acp-allow-1"}})
    elif method in ("session/set_model", "session/set_config_option"):
        send({"jsonrpc": "2.0", "id": req_id, "result": {}})
    elif method == "session/prompt":
        sid = params.get("sessionId")
        prompt = params.get("prompt", [])
        image_datas = [
            b["data"]
            for b in prompt
            if isinstance(b, dict) and b.get("type") == "image"
        ]
        # First request a disallowed execute tool, then an allowed read tool.
        send({
            "jsonrpc": "2.0",
            "id": 9101,
            "method": "session/request_permission",
            "params": {
                "sessionId": sid,
                "toolCall": {"toolCallId": "tc-exec", "title": "run_cmd", "kind": "execute"},
                "options": [
                    {"optionId": "opt-allow", "name": "Allow", "kind": "allow_once"},
                    {"optionId": "opt-deny", "name": "Reject", "kind": "reject_once"}
                ]
            }
        })
        exec_resp = json.loads(sys.stdin.readline().strip())["result"]["outcome"].get("optionId")
        send({
            "jsonrpc": "2.0",
            "id": 9102,
            "method": "session/request_permission",
            "params": {
                "sessionId": sid,
                "toolCall": {"toolCallId": "tc-read", "title": "read_file", "kind": "read"},
                "options": [
                    {"optionId": "opt-allow", "name": "Allow", "kind": "allow_once"},
                    {"optionId": "opt-deny", "name": "Reject", "kind": "reject_once"}
                ]
            }
        })
        read_resp = json.loads(sys.stdin.readline().strip())["result"]["outcome"].get("optionId")
        reply = f"exec={exec_resp};read={read_resp};images={','.join(image_datas)}"
        send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": sid, "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": reply}}}})
        send({"jsonrpc": "2.0", "id": req_id, "result": {"stopReason": "end_turn"}})
        break
"#;
    std::fs::write(&script_path, script).unwrap();
    std::fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o755)).unwrap();

    let mut env = HashMap::new();
    env.insert("HOME".into(), tmp.path().to_string_lossy().into_owned());
    env.insert("PATH".into(), std::env::var("PATH").unwrap_or_default());
    let handler = Arc::new(TestApprovalHandler {
        allow: true,
        calls: AtomicUsize::new(0),
    });
    let mut transport = AntigravityAcpTransport::with_env_and_handler(env, Some(handler.clone()));
    transport.command_override = Some((script_path.to_string_lossy().into_owned(), Vec::new()));

    let mut provider_options = Map::new();
    provider_options.insert("cwd".into(), json!(tmp.path().to_string_lossy()));

    let req = ProviderStepRequest {
        model_id: "gemini-4-neon".to_owned(),
        base_url: None,
        api_key: Some("gem-key".to_owned()),
        extra_headers: HashMap::new(),
        system_prompt: "Read only.".to_owned(),
        messages: vec![
            user_msg_with_image("Inspect this image", "ACP_IMG_TURN_1", "image/jpeg"),
            assistant_msg("Got it."),
            user_msg("Summarize what you saw."),
        ],
        tools: Vec::new(),
        authorized_tool_names: Some(vec!["read".to_owned()]),
        provider_options,
        continuation: None,
        policy: RequestPolicy::default(),
        turn_id: "turn-acp-allow-1".to_owned(),
    };

    let budget = StepBudget::unbounded(Some(CancellationToken::new()));
    let res = transport
        .stream_step(req, &budget, &mut |_| {})
        .await
        .expect("ACP turn succeeds");

    // Handler was ONLY consulted for allowed `read_file`, never for disallowed `run_cmd`.
    assert_eq!(handler.calls.load(Ordering::Relaxed), 1);
    let text = res
        .assistant
        .content
        .iter()
        .find_map(|b| match b {
            ContentBlock::Text { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .unwrap();
    assert_eq!(text, "exec=opt-deny;read=opt-allow;images=ACP_IMG_TURN_1");
}

#[cfg(unix)]
#[tokio::test]
async fn antigravity_acp_returns_error_on_subprocess_exit_without_spinning() {
    use std::os::unix::fs::PermissionsExt;

    let tmp = tempfile::tempdir().unwrap();
    let script_path = tmp.path().join("mock-acp-crash.py");
    let script = r#"#!/usr/bin/env python3
import json, sys

def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    method = msg.get("method")
    req_id = msg.get("id")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": req_id, "result": {"protocolVersion": 1}})
    elif method == "session/new":
        send({"jsonrpc": "2.0", "id": req_id, "result": {"sessionId": "acp-crash-1"}})
    elif method == "session/set_model":
        send({"jsonrpc": "2.0", "id": req_id, "result": {}})
    elif method == "session/prompt":
        # Exit immediately mid-prompt so the reader drops the notification channel.
        sys.exit(42)
"#;
    std::fs::write(&script_path, script).unwrap();
    std::fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o755)).unwrap();

    let mut env = HashMap::new();
    env.insert("HOME".into(), tmp.path().to_string_lossy().into_owned());
    env.insert("PATH".into(), std::env::var("PATH").unwrap_or_default());
    let mut transport = AntigravityAcpTransport::with_env(env);
    transport.command_override = Some((script_path.to_string_lossy().into_owned(), Vec::new()));

    let mut provider_options = Map::new();
    provider_options.insert("cwd".into(), json!(tmp.path().to_string_lossy()));

    let req = ProviderStepRequest {
        model_id: "gemini-4-neon".to_owned(),
        base_url: None,
        api_key: Some("gem-key".to_owned()),
        extra_headers: HashMap::new(),
        system_prompt: String::new(),
        messages: vec![user_msg("Trigger exit")],
        tools: Vec::new(),
        authorized_tool_names: None,
        provider_options,
        continuation: None,
        policy: RequestPolicy::default(),
        turn_id: "turn-acp-crash".to_owned(),
    };

    let budget = StepBudget::unbounded(Some(CancellationToken::new()));
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        transport.stream_step(req, &budget, &mut |_| {}),
    )
    .await
    .expect("ACP stream_step must not hang/spin when subprocess exits");
    assert!(
        result.is_err(),
        "expected transport error when ACP subprocess exits mid-prompt"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn antigravity_acp_completes_text_segments_separately_across_tool_calls() {
    use std::os::unix::fs::PermissionsExt;

    let tmp = tempfile::tempdir().unwrap();
    let script_path = tmp.path().join("mock-acp-segments.py");
    let script = r#"#!/usr/bin/env python3
import json, sys

def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    method = msg.get("method")
    req_id = msg.get("id")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": req_id, "result": {"protocolVersion": 1}})
    elif method == "session/new":
        send({"jsonrpc": "2.0", "id": req_id, "result": {"sessionId": "acp-seg-1"}})
    elif method == "session/set_model":
        send({"jsonrpc": "2.0", "id": req_id, "result": {}})
    elif method == "session/prompt":
        sid = msg["params"]["sessionId"]
        send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": sid, "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "Checking files..."}}}})
        send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": sid, "update": {"sessionUpdate": "tool_call", "toolCallId": "tc-1", "title": "read_file", "rawInput": {"path": "README.md"}}}})
        send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": sid, "update": {"sessionUpdate": "tool_call_update", "toolCallId": "tc-1", "title": "read_file", "status": "completed", "rawOutput": {"ok": True}}}})
        send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": sid, "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "Final answer."}}}})
        send({"jsonrpc": "2.0", "id": req_id, "result": {"stopReason": "end_turn"}})
        break
"#;
    std::fs::write(&script_path, script).unwrap();
    std::fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o755)).unwrap();

    let mut env = HashMap::new();
    env.insert("HOME".into(), tmp.path().to_string_lossy().into_owned());
    env.insert("PATH".into(), std::env::var("PATH").unwrap_or_default());
    let mut transport = AntigravityAcpTransport::with_env(env);
    transport.command_override = Some((script_path.to_string_lossy().into_owned(), Vec::new()));

    let mut provider_options = Map::new();
    provider_options.insert("cwd".into(), json!(tmp.path().to_string_lossy()));

    let req = ProviderStepRequest {
        model_id: "gemini-4-neon".to_owned(),
        base_url: None,
        api_key: Some("gem-key".to_owned()),
        extra_headers: HashMap::new(),
        system_prompt: String::new(),
        messages: vec![user_msg("Inspect and answer")],
        tools: Vec::new(),
        authorized_tool_names: None,
        provider_options,
        continuation: None,
        policy: RequestPolicy::default(),
        turn_id: "turn-acp-segments".to_owned(),
    };

    let budget = StepBudget::unbounded(Some(CancellationToken::new()));
    let mut events = Vec::new();
    let res = transport
        .stream_step(req, &budget, &mut |ev| events.push(ev))
        .await
        .expect("ACP turn succeeds");

    let text_ends: Vec<(usize, String)> = events
        .iter()
        .filter_map(|e| match e {
            StreamEvent::TextEnd {
                block_index, text, ..
            } => Some((*block_index, text.clone())),
            _ => None,
        })
        .collect();
    assert_eq!(
        text_ends,
        vec![
            (0, "Checking files...".to_owned()),
            (1, "Final answer.".to_owned()),
        ],
        "each ACP text segment must complete with segment-specific text without duplicating prior narration"
    );

    let full_text = res
        .assistant
        .content
        .iter()
        .find_map(|b| match b {
            ContentBlock::Text { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .unwrap();
    assert_eq!(full_text, "Checking files...Final answer.");
}

#[cfg(unix)]
#[tokio::test]
async fn antigravity_acp_aborts_before_prompt_when_set_model_fails() {
    use std::os::unix::fs::PermissionsExt;

    let tmp = TempDir::new().unwrap();
    let prompt_marker = tmp.path().join("prompt-called.txt");
    let script_path = tmp.path().join("mock-acp-bad-model.py");
    let script = format!(
        r#"#!/usr/bin/env python3
import json, pathlib, sys

marker = pathlib.Path({marker:?})

def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    method = msg.get("method")
    req_id = msg.get("id")
    if method == "initialize":
        send({{"jsonrpc": "2.0", "id": req_id, "result": {{"protocolVersion": 1}}}})
    elif method == "session/new":
        send({{"jsonrpc": "2.0", "id": req_id, "result": {{"sessionId": "acp-bad-model"}}}})
    elif method == "session/set_model":
        send({{"jsonrpc": "2.0", "id": req_id, "error": {{"code": -32602, "message": "Unknown modelId"}}}})
    elif method == "session/prompt":
        marker.write_text("prompt-sent")
        send({{"jsonrpc": "2.0", "id": req_id, "result": {{"stopReason": "end_turn"}}}})
        break
"#,
        marker = prompt_marker.to_string_lossy()
    );
    std::fs::write(&script_path, script).unwrap();
    std::fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o755)).unwrap();

    let mut env = HashMap::new();
    env.insert("HOME".into(), tmp.path().to_string_lossy().into_owned());
    env.insert("PATH".into(), std::env::var("PATH").unwrap_or_default());
    let mut transport = AntigravityAcpTransport::with_env(env);
    transport.command_override = Some((script_path.to_string_lossy().into_owned(), Vec::new()));

    let mut provider_options = Map::new();
    provider_options.insert("cwd".into(), json!(tmp.path().to_string_lossy()));

    let req = ProviderStepRequest {
        model_id: "nonexistent-model".to_owned(),
        base_url: None,
        api_key: Some("gem-key".to_owned()),
        extra_headers: HashMap::new(),
        system_prompt: String::new(),
        messages: vec![user_msg("Hello")],
        tools: Vec::new(),
        authorized_tool_names: None,
        provider_options,
        continuation: None,
        policy: RequestPolicy::default(),
        turn_id: "turn-acp-bad-model".to_owned(),
    };

    let budget = StepBudget::unbounded(Some(CancellationToken::new()));
    let err = transport
        .stream_step(req, &budget, &mut |_| {})
        .await
        .expect_err("ACP turn must fail when session/set_model rejects the model");
    assert!(
        err.message.contains("nonexistent-model") && err.message.contains("Unknown modelId"),
        "unexpected error: {err:?}"
    );
    assert!(
        !prompt_marker.exists(),
        "session/prompt must not be submitted after session/set_model fails"
    );
}
