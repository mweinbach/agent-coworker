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
    AntigravityProxyAuth, build_antigravity_acp_spawn_env, install_antigravity_acp,
    resolve_antigravity_acp_home, resolve_antigravity_acp_status,
};
use cowork_providers::claude_sdk::{
    CLAUDE_SDK_MANAGED_VERSION, ClaudeSdkInstallOptions, ClaudeSdkProxyAuth, ClaudeSdkTransport,
    build_claude_sdk_spawn_env, install_claude_sdk, resolve_claude_sdk_home,
    resolve_claude_sdk_status,
};
use cowork_providers::codex_app_server::{DynamicToolCallOutput, DynamicToolHandler};
use cowork_providers::{
    ManagedRuntimeTarget, ProviderStepRequest, ProviderTransport, ToolDefinition,
};
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

    // 3. Isolated spawn env pins CLAUDE_CONFIG_DIR, strips ambient credentials across providers,
    //    and injects only the ephemeral loopback proxy URL and placeholder token.
    let mut parent = HashMap::new();
    parent.insert("CLAUDE_CONFIG_DIR".into(), "/Users/someone/.claude".into());
    parent.insert("ANTHROPIC_API_KEY".into(), "leaked-ambient-key".into());
    parent.insert("OPENAI_API_KEY".into(), "leaked-openai-key".into());
    parent.insert("GEMINI_API_KEY".into(), "leaked-gemini-key".into());
    parent.insert("AWS_SECRET_ACCESS_KEY".into(), "leaked-aws-secret".into());
    let proxy_auth = ClaudeSdkProxyAuth {
        base_url: "http://127.0.0.1:43210".into(),
        proxy_token: "sk-ant-oat01-cowork-proxy-deadbeef".into(),
        uses_oauth: true,
    };
    let spawn_env = build_claude_sdk_spawn_env(&cowork_home, &parent, Some(&proxy_auth));
    assert_eq!(
        spawn_env.get("CLAUDE_CONFIG_DIR").map(String::as_str),
        Some(
            resolve_claude_sdk_home(&cowork_home)
                .to_string_lossy()
                .as_ref()
        )
    );
    assert_eq!(
        spawn_env.get("ANTHROPIC_BASE_URL").map(String::as_str),
        Some("http://127.0.0.1:43210")
    );
    assert_eq!(
        spawn_env.get("CLAUDE_CODE_OAUTH_TOKEN").map(String::as_str),
        Some("sk-ant-oat01-cowork-proxy-deadbeef")
    );
    assert!(!spawn_env.contains_key("ANTHROPIC_API_KEY"));
    assert!(!spawn_env.contains_key("OPENAI_API_KEY"));
    assert!(!spawn_env.contains_key("GEMINI_API_KEY"));
    assert!(!spawn_env.contains_key("AWS_SECRET_ACCESS_KEY"));
    assert!(
        spawn_env
            .get("NO_PROXY")
            .is_some_and(|v| v.contains("127.0.0.1"))
    );

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

    // 3. Isolated env strips inherited ANTIGRAVITY_* / AGY_* / cross-provider secrets and pins
    //    only the ephemeral loopback proxy URL and placeholder token.
    let mut parent = HashMap::new();
    parent.insert("ANTIGRAVITY_HOME".into(), "/leaked/home".into());
    parent.insert("AGY_TOKEN".into(), "leaked".into());
    parent.insert("ANTHROPIC_API_KEY".into(), "leaked-anthropic".into());
    parent.insert("GEMINI_API_KEY".into(), "leaked-real-gemini".into());
    let proxy_auth = AntigravityProxyAuth {
        base_url: "http://127.0.0.1:43211".into(),
        proxy_token: "AIzaSyCoworkProxy0123456789".into(),
    };
    let spawn_env = build_antigravity_acp_spawn_env(&cowork_home, &parent, Some(&proxy_auth));
    assert_eq!(
        spawn_env.get("ANTIGRAVITY_HOME").map(String::as_str),
        Some(
            resolve_antigravity_acp_home(&cowork_home)
                .to_string_lossy()
                .as_ref()
        )
    );
    assert!(!spawn_env.contains_key("AGY_TOKEN"));
    assert!(!spawn_env.contains_key("ANTHROPIC_API_KEY"));
    assert_eq!(
        spawn_env.get("GOOGLE_GEMINI_BASE_URL").map(String::as_str),
        Some("http://127.0.0.1:43211")
    );
    assert_eq!(
        spawn_env.get("GEMINI_API_KEY").map(String::as_str),
        Some("AIzaSyCoworkProxy0123456789")
    );
    assert_eq!(
        spawn_env.get("GOOGLE_API_KEY").map(String::as_str),
        Some("AIzaSyCoworkProxy0123456789")
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

#[cfg(unix)]
#[tokio::test]
async fn claude_sdk_isolates_cli_against_repository_hooks_for_api_key_and_oauth() {
    use std::os::unix::fs::PermissionsExt;

    let tmp = TempDir::new().unwrap();
    let script_path = tmp.path().join("mock-claude-args.py");
    let script = r#"#!/usr/bin/env python3
import json, os, sys

args = sys.argv[1:]

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
        payload = json.dumps({
            "args": args,
            "has_oauth": "CLAUDE_CODE_OAUTH_TOKEN" in os.environ,
            "has_api_key": "ANTHROPIC_API_KEY" in os.environ,
        })
        emit({"type": "system", "subtype": "init", "session_id": "claude-iso-1"})
        emit({"type": "stream_event", "event": {"type": "content_block_start", "index": 0, "content_block": {"type": "text"}}})
        emit({"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": payload}}})
        emit({"type": "stream_event", "event": {"type": "content_block_stop", "index": 0}})
        emit({
            "type": "result",
            "subtype": "success",
            "is_error": False,
            "session_id": "claude-iso-1",
            "result": payload,
            "usage": {"input_tokens": 5, "output_tokens": 5}
        })
        break
"#;
    std::fs::write(&script_path, script).unwrap();
    std::fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o755)).unwrap();

    let mut env = HashMap::new();
    env.insert("HOME".into(), tmp.path().to_string_lossy().into_owned());
    env.insert("PATH".into(), std::env::var("PATH").unwrap_or_default());

    let mut transport = ClaudeSdkTransport::with_env(env);
    transport.command_override = Some((script_path.to_string_lossy().into_owned(), Vec::new()));

    let mut provider_options = Map::new();
    provider_options.insert("cwd".into(), json!(tmp.path().to_string_lossy()));
    let budget = StepBudget::unbounded(Some(CancellationToken::new()));

    // 1. API key auth uses `--bare` plus CLI-precedence `disableAllHooks`, `--strict-mcp-config`,
    //    and `--disable-slash-commands`.
    let api_req = ProviderStepRequest {
        model_id: "claude-opus-4-8".to_owned(),
        base_url: None,
        api_key: Some("sk-ant-api03-test".to_owned()),
        extra_headers: HashMap::new(),
        system_prompt: String::new(),
        messages: vec![user_msg("inspect")],
        tools: Vec::new(),
        authorized_tool_names: None,
        provider_options: provider_options.clone(),
        continuation: None,
        policy: RequestPolicy::default(),
        turn_id: "turn-iso-api".to_owned(),
    };
    let api_res = transport
        .stream_step(api_req, &budget, &mut |_| {})
        .await
        .expect("API key turn succeeds");
    let api_text = api_res
        .assistant
        .content
        .iter()
        .find_map(|b| match b {
            ContentBlock::Text { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .unwrap();
    let api_json: Value = serde_json::from_str(api_text).unwrap();
    let api_args: Vec<&str> = api_json["args"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert_eq!(api_json["has_api_key"], json!(true));
    assert_eq!(api_json["has_oauth"], json!(false));
    assert!(api_args.contains(&"--print"));
    assert!(api_args.contains(&"--bare"));
    assert!(!api_args.contains(&"--setting-sources"));
    assert!(api_args.contains(&"--strict-mcp-config"));
    assert!(api_args.contains(&"--disable-slash-commands"));
    let settings_idx = api_args
        .iter()
        .position(|&a| a == "--settings")
        .expect("--settings flag must be passed");
    let settings_val: Value = serde_json::from_str(api_args[settings_idx + 1]).unwrap();
    assert_eq!(settings_val["disableAllHooks"], json!(true));
    assert_eq!(settings_val["enableAllProjectMcpServers"], json!(false));

    // 2. OAuth token auth omits `--bare` (which ignores `CLAUDE_CODE_OAUTH_TOKEN`) and isolates
    //    via `--setting-sources user` (Cowork's isolated CLAUDE_CONFIG_DIR), CLI-precedence
    //    `disableAllHooks`, `--strict-mcp-config`, and `--disable-slash-commands`.
    let oauth_req = ProviderStepRequest {
        model_id: "claude-opus-4-8".to_owned(),
        base_url: None,
        api_key: Some("sk-ant-oat01-test".to_owned()),
        extra_headers: HashMap::new(),
        system_prompt: String::new(),
        messages: vec![user_msg("inspect")],
        tools: Vec::new(),
        authorized_tool_names: None,
        provider_options,
        continuation: None,
        policy: RequestPolicy::default(),
        turn_id: "turn-iso-oauth".to_owned(),
    };
    let oauth_res = transport
        .stream_step(oauth_req, &budget, &mut |_| {})
        .await
        .expect("OAuth token turn succeeds");
    let oauth_text = oauth_res
        .assistant
        .content
        .iter()
        .find_map(|b| match b {
            ContentBlock::Text { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .unwrap();
    let oauth_json: Value = serde_json::from_str(oauth_text).unwrap();
    let oauth_args: Vec<&str> = oauth_json["args"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert_eq!(oauth_json["has_oauth"], json!(true));
    assert_eq!(oauth_json["has_api_key"], json!(false));
    assert!(oauth_args.contains(&"--print"));
    assert!(!oauth_args.contains(&"--bare"));
    let src_idx = oauth_args
        .iter()
        .position(|&a| a == "--setting-sources")
        .expect("--setting-sources flag must be passed for OAuth tokens");
    assert_eq!(oauth_args[src_idx + 1], "user");
    assert!(oauth_args.contains(&"--strict-mcp-config"));
    assert!(oauth_args.contains(&"--disable-slash-commands"));
    let oauth_settings_idx = oauth_args
        .iter()
        .position(|&a| a == "--settings")
        .expect("--settings flag must be passed for OAuth tokens");
    let oauth_settings_val: Value =
        serde_json::from_str(oauth_args[oauth_settings_idx + 1]).unwrap();
    assert_eq!(oauth_settings_val["disableAllHooks"], json!(true));
    assert_eq!(
        oauth_settings_val["enableAllProjectMcpServers"],
        json!(false)
    );
}

#[cfg(unix)]
#[tokio::test]
async fn claude_sdk_and_antigravity_broker_credentials_via_loopback_proxy_without_exposing_secrets_in_env()
 {
    use std::os::unix::fs::PermissionsExt;

    use axum::http::HeaderMap;
    use axum::routing::post;
    use parking_lot::Mutex;

    type ObservedUpstreamRequest = (String, Option<String>, Option<String>, Option<String>);

    let seen_upstream: Arc<Mutex<Vec<ObservedUpstreamRequest>>> = Arc::new(Mutex::new(Vec::new()));
    let seen_for_anthropic = Arc::clone(&seen_upstream);
    let seen_for_gemini = Arc::clone(&seen_upstream);

    let app = Router::new()
        .route(
            "/v1/messages",
            post(move |headers: HeaderMap| {
                let seen = Arc::clone(&seen_for_anthropic);
                async move {
                    let x_api = headers
                        .get("x-api-key")
                        .and_then(|v| v.to_str().ok())
                        .map(str::to_owned);
                    let auth = headers
                        .get("authorization")
                        .and_then(|v| v.to_str().ok())
                        .map(str::to_owned);
                    seen.lock()
                        .push(("/v1/messages".to_owned(), x_api, auth, None));
                    Response::builder()
                        .status(StatusCode::OK)
                        .header("content-type", "application/json")
                        .body(Body::from(r#"{"ok":true,"provider":"anthropic"}"#))
                        .unwrap()
                }
            }),
        )
        .route(
            "/v1beta/models/gemini:generateContent",
            post(move |uri: axum::http::Uri, headers: HeaderMap| {
                let seen = Arc::clone(&seen_for_gemini);
                async move {
                    let x_goog = headers
                        .get("x-goog-api-key")
                        .and_then(|v| v.to_str().ok())
                        .map(str::to_owned);
                    let query = uri.query().map(str::to_owned);
                    seen.lock()
                        .push((uri.path().to_owned(), x_goog, None, query));
                    Response::builder()
                        .status(StatusCode::OK)
                        .header("content-type", "application/json")
                        .body(Body::from(r#"{"ok":true,"provider":"gemini"}"#))
                        .unwrap()
                }
            }),
        );

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_port = listener.local_addr().unwrap().port();
    let upstream_url = format!("http://127.0.0.1:{upstream_port}");
    let upstream_server = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    let tmp = TempDir::new().unwrap();
    let real_claude_api_key = "sk-ant-api03-REAL-SECRET-NEVER-IN-CHILD-ENV";
    let real_claude_oauth = "sk-ant-oat01-REAL-OAUTH-NEVER-IN-CHILD-ENV";
    let real_gemini_key = "AIzaSyREAL-GEMINI-SECRET-NEVER-IN-CHILD-ENV";

    // Mock Claude CLI that inspects its entire os.environ, checks 401 on wrong token, and calls
    // ANTHROPIC_BASE_URL using the placeholder credential from its environment.
    let claude_script_path = tmp.path().join("mock-claude-proxy.py");
    let claude_script = r#"#!/usr/bin/env python3
import json, os, sys, urllib.error, urllib.request

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
        base = os.environ["ANTHROPIC_BASE_URL"]
        all_env_values = "\n".join(os.environ.values())
        # 1. Wrong token must fail with 401.
        bad_req = urllib.request.Request(
            f"{base}/v1/messages",
            data=b"{}",
            headers={"x-api-key": "wrong-token", "content-type": "application/json"},
            method="POST",
        )
        try:
            urllib.request.urlopen(bad_req)
            bad_status = 200
        except urllib.error.HTTPError as e:
            bad_status = e.code

        # 2. Placeholder token from env authenticates through Cowork's loopback broker.
        if "CLAUDE_CODE_OAUTH_TOKEN" in os.environ:
            headers = {
                "authorization": f"Bearer {os.environ['CLAUDE_CODE_OAUTH_TOKEN']}",
                "content-type": "application/json",
            }
        else:
            headers = {
                "x-api-key": os.environ["ANTHROPIC_API_KEY"],
                "content-type": "application/json",
            }
        ok_req = urllib.request.Request(
            f"{base}/v1/messages",
            data=b"{}",
            headers=headers,
            method="POST",
        )
        with urllib.request.urlopen(ok_req) as resp:
            body = resp.read().decode("utf-8")
            ok_status = resp.status

        payload = json.dumps({
            "base": base,
            "bad_status": bad_status,
            "ok_status": ok_status,
            "body": body,
            "leaked_real": "REAL-SECRET" in all_env_values or "REAL-OAUTH" in all_env_values,
        })
        emit({"type": "system", "subtype": "init", "session_id": "claude-proxy-1"})
        emit({"type": "stream_event", "event": {"type": "content_block_start", "index": 0, "content_block": {"type": "text"}}})
        emit({"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": payload}}})
        emit({"type": "stream_event", "event": {"type": "content_block_stop", "index": 0}})
        emit({
            "type": "result",
            "subtype": "success",
            "is_error": False,
            "session_id": "claude-proxy-1",
            "result": payload,
            "usage": {"input_tokens": 5, "output_tokens": 5}
        })
        break
"#;
    std::fs::write(&claude_script_path, claude_script).unwrap();
    std::fs::set_permissions(&claude_script_path, std::fs::Permissions::from_mode(0o755)).unwrap();

    let mut env = HashMap::new();
    env.insert("HOME".into(), tmp.path().to_string_lossy().into_owned());
    env.insert("PATH".into(), std::env::var("PATH").unwrap_or_default());
    let mut provider_options = Map::new();
    provider_options.insert("cwd".into(), json!(tmp.path().to_string_lossy()));
    let budget = StepBudget::unbounded(Some(CancellationToken::new()));

    let mut claude_transport = ClaudeSdkTransport::with_env(env.clone());
    claude_transport.command_override = Some((
        claude_script_path.to_string_lossy().into_owned(),
        Vec::new(),
    ));

    // 1. Claude API-key turn: real secret never enters env, upstream receives real x-api-key.
    let api_res = claude_transport
        .stream_step(
            ProviderStepRequest {
                model_id: "claude-opus-4-8".to_owned(),
                base_url: Some(upstream_url.clone()),
                api_key: Some(real_claude_api_key.to_owned()),
                extra_headers: HashMap::new(),
                system_prompt: String::new(),
                messages: vec![user_msg("proxy api")],
                tools: Vec::new(),
                authorized_tool_names: None,
                provider_options: provider_options.clone(),
                continuation: None,
                policy: RequestPolicy::default(),
                turn_id: "turn-proxy-claude-api".to_owned(),
            },
            &budget,
            &mut |_| {},
        )
        .await
        .expect("Claude SDK API-key proxied turn succeeds");
    let api_text = api_res
        .assistant
        .content
        .iter()
        .find_map(|b| match b {
            ContentBlock::Text { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .unwrap();
    let api_payload: Value = serde_json::from_str(api_text).unwrap();
    assert_eq!(api_payload["leaked_real"], json!(false));
    assert_eq!(api_payload["bad_status"], json!(401));
    assert_eq!(api_payload["ok_status"], json!(200));
    let claude_proxy_base = api_payload["base"].as_str().unwrap().to_owned();
    // Proxy must be torn down immediately once stream_step finishes.
    assert!(
        reqwest::Client::new()
            .post(format!("{claude_proxy_base}/v1/messages"))
            .send()
            .await
            .is_err(),
        "ephemeral loopback proxy must close immediately after turn completes"
    );

    // 2. Claude OAuth turn: real OAuth token never enters env, upstream receives Authorization: Bearer.
    let oauth_res = claude_transport
        .stream_step(
            ProviderStepRequest {
                model_id: "claude-opus-4-8".to_owned(),
                base_url: Some(upstream_url.clone()),
                api_key: Some(real_claude_oauth.to_owned()),
                extra_headers: HashMap::new(),
                system_prompt: String::new(),
                messages: vec![user_msg("proxy oauth")],
                tools: Vec::new(),
                authorized_tool_names: None,
                provider_options: provider_options.clone(),
                continuation: None,
                policy: RequestPolicy::default(),
                turn_id: "turn-proxy-claude-oauth".to_owned(),
            },
            &budget,
            &mut |_| {},
        )
        .await
        .expect("Claude SDK OAuth proxied turn succeeds");
    let oauth_text = oauth_res
        .assistant
        .content
        .iter()
        .find_map(|b| match b {
            ContentBlock::Text { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .unwrap();
    let oauth_payload: Value = serde_json::from_str(oauth_text).unwrap();
    assert_eq!(oauth_payload["leaked_real"], json!(false));
    assert_eq!(oauth_payload["bad_status"], json!(401));
    assert_eq!(oauth_payload["ok_status"], json!(200));

    // 3. Antigravity ACP turn: real Gemini key never enters env, query `?key=` is stripped and
    //    swapped for real `x-goog-api-key` header upstream.
    let acp_script_path = tmp.path().join("mock-acp-proxy.py");
    let acp_script = r#"#!/usr/bin/env python3
import json, os, sys, urllib.error, urllib.request

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
        send({"jsonrpc": "2.0", "id": req_id, "result": {"sessionId": "acp-proxy-1"}})
    elif method == "session/set_model":
        send({"jsonrpc": "2.0", "id": req_id, "result": {}})
    elif method == "session/prompt":
        sid = msg["params"]["sessionId"]
        base = os.environ["GOOGLE_GEMINI_BASE_URL"]
        token = os.environ["GEMINI_API_KEY"]
        all_env_values = "\n".join(os.environ.values())

        bad_req = urllib.request.Request(
            f"{base}/v1beta/models/gemini:generateContent?alt=sse&key=wrong-key",
            data=b"{}",
            headers={"content-type": "application/json"},
            method="POST",
        )
        try:
            urllib.request.urlopen(bad_req)
            bad_status = 200
        except urllib.error.HTTPError as e:
            bad_status = e.code

        ok_req = urllib.request.Request(
            f"{base}/v1beta/models/gemini:generateContent?alt=sse&key={token}",
            data=b"{}",
            headers={"content-type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(ok_req) as resp:
            body = resp.read().decode("utf-8")
            ok_status = resp.status

        payload = json.dumps({
            "bad_status": bad_status,
            "ok_status": ok_status,
            "body": body,
            "leaked_real": "REAL-GEMINI-SECRET" in all_env_values,
        })
        send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": sid, "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": payload}}}})
        send({"jsonrpc": "2.0", "id": req_id, "result": {"stopReason": "end_turn"}})
        break
"#;
    std::fs::write(&acp_script_path, acp_script).unwrap();
    std::fs::set_permissions(&acp_script_path, std::fs::Permissions::from_mode(0o755)).unwrap();

    let mut acp_transport = AntigravityAcpTransport::with_env(env);
    acp_transport.command_override =
        Some((acp_script_path.to_string_lossy().into_owned(), Vec::new()));
    let acp_res = acp_transport
        .stream_step(
            ProviderStepRequest {
                model_id: "gemini-4-neon".to_owned(),
                base_url: Some(upstream_url),
                api_key: Some(real_gemini_key.to_owned()),
                extra_headers: HashMap::new(),
                system_prompt: String::new(),
                messages: vec![user_msg("proxy gemini")],
                tools: Vec::new(),
                authorized_tool_names: None,
                provider_options,
                continuation: None,
                policy: RequestPolicy::default(),
                turn_id: "turn-proxy-acp".to_owned(),
            },
            &budget,
            &mut |_| {},
        )
        .await
        .expect("Antigravity ACP proxied turn succeeds");
    let acp_text = acp_res
        .assistant
        .content
        .iter()
        .find_map(|b| match b {
            ContentBlock::Text { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .unwrap();
    let acp_payload: Value = serde_json::from_str(acp_text).unwrap();
    assert_eq!(acp_payload["leaked_real"], json!(false));
    assert_eq!(acp_payload["bad_status"], json!(401));
    assert_eq!(acp_payload["ok_status"], json!(200));

    let observed = seen_upstream.lock().clone();
    assert_eq!(observed.len(), 3);
    assert_eq!(
        observed[0],
        (
            "/v1/messages".to_owned(),
            Some(real_claude_api_key.to_owned()),
            None,
            None,
        )
    );
    assert_eq!(
        observed[1],
        (
            "/v1/messages".to_owned(),
            None,
            Some(format!("Bearer {real_claude_oauth}")),
            None,
        )
    );
    assert_eq!(
        observed[2],
        (
            "/v1beta/models/gemini:generateContent".to_owned(),
            Some(real_gemini_key.to_owned()),
            None,
            Some("alt=sse".to_owned()),
        )
    );

    upstream_server.abort();
}

#[cfg(unix)]
#[tokio::test]
async fn antigravity_acp_merges_incremental_tool_call_updates_before_completion() {
    use std::os::unix::fs::PermissionsExt;

    let tmp = TempDir::new().unwrap();
    let script_path = tmp.path().join("mock-agy-incremental.py");
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
        send({"jsonrpc": "2.0", "id": req_id, "result": {}})
    elif method == "session/new":
        send({"jsonrpc": "2.0", "id": req_id, "result": {"sessionId": "acp-inc-1"}})
    elif method == "session/set_model":
        send({"jsonrpc": "2.0", "id": req_id, "result": {}})
    elif method == "session/prompt":
        sid = params.get("sessionId")
        # 1. Pending tool_call announced with NO rawInput yet.
        send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": sid, "update": {"sessionUpdate": "tool_call", "toolCallId": "tc-inc-1", "title": "run_cmd", "status": "pending"}}})
        # 2. Non-terminal in_progress update supplies rawInput AND intermediate rawOutput.
        send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": sid, "update": {"sessionUpdate": "tool_call_update", "toolCallId": "tc-inc-1", "status": "in_progress", "rawInput": {"command": "git status"}, "rawOutput": "On branch main\n"}}})
        # 3. Terminal completion update carries ONLY status (no rawInput, no rawOutput).
        send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": sid, "update": {"sessionUpdate": "tool_call_update", "toolCallId": "tc-inc-1", "status": "completed"}}})
        # 4. Second tool receives rawInput only on the terminal update.
        send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": sid, "update": {"sessionUpdate": "tool_call", "toolCallId": "tc-inc-2", "title": "read_file", "status": "pending"}}})
        send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": sid, "update": {"sessionUpdate": "tool_call_update", "toolCallId": "tc-inc-2", "status": "completed", "rawInput": {"path": "README.md"}, "rawOutput": "Hello world"}}})
        send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": sid, "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "Done."}}}})
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

    let budget = StepBudget::unbounded(Some(CancellationToken::new()));
    let mut events = Vec::new();
    transport
        .stream_step(
            ProviderStepRequest {
                model_id: "gemini-4-neon".to_owned(),
                base_url: None,
                api_key: Some("gemini-secret".to_owned()),
                extra_headers: HashMap::new(),
                system_prompt: String::new(),
                messages: vec![user_msg("inspect")],
                tools: Vec::new(),
                authorized_tool_names: None,
                provider_options,
                continuation: None,
                policy: RequestPolicy::default(),
                turn_id: "turn-acp-inc".to_owned(),
            },
            &budget,
            &mut |ev| events.push(ev),
        )
        .await
        .expect("incremental ACP turn succeeds");

    // tc-inc-1: ToolCallEnd must carry {"command": "git status"} (never empty {}),
    // and ToolResult must preserve the intermediate rawOutput ("On branch main\n").
    let tc1_ends: Vec<_> = events
        .iter()
        .filter_map(|ev| match ev {
            StreamEvent::ToolCallEnd {
                key,
                name,
                arguments,
                ..
            } if key == "tc-inc-1" => Some((name.clone(), arguments.clone())),
            _ => None,
        })
        .collect();
    assert_eq!(tc1_ends.len(), 1);
    assert_eq!(tc1_ends[0].0, "run_cmd");
    assert_eq!(
        tc1_ends[0].1.as_ref().and_then(|m| m.get("command")),
        Some(&json!("git status"))
    );

    let tc1_res = events
        .iter()
        .find_map(|ev| match ev {
            StreamEvent::ToolResult {
                key,
                name,
                result,
                is_error,
                ..
            } if key == "tc-inc-1" => Some((name.clone(), result.clone(), *is_error)),
            _ => None,
        })
        .expect("tc-inc-1 result emitted");
    assert_eq!(tc1_res.0, "run_cmd");
    assert_eq!(tc1_res.1, json!("On branch main\n"));
    assert!(!tc1_res.2);

    // tc-inc-2: terminal update supplies rawInput; ToolCallEnd must precede ToolResult with path.
    let tc2_end_idx = events
        .iter()
        .position(|ev| {
            matches!(
                ev,
                StreamEvent::ToolCallEnd { key, arguments: Some(args), .. }
                    if key == "tc-inc-2" && args.get("path") == Some(&json!("README.md"))
            )
        })
        .expect("tc-inc-2 ToolCallEnd with terminal rawInput");
    let tc2_res_idx = events
        .iter()
        .position(|ev| {
            matches!(
                ev,
                StreamEvent::ToolResult { key, result, .. }
                    if key == "tc-inc-2" && result == &json!("Hello world")
            )
        })
        .expect("tc-inc-2 ToolResult with rawOutput");
    assert!(tc2_end_idx < tc2_res_idx);
}

struct RecordingHarnessToolHandler {
    allow_native_approval: bool,
    approval_calls: AtomicUsize,
    tool_calls: parking_lot::Mutex<Vec<(String, Map<String, Value>)>>,
}

impl RecordingHarnessToolHandler {
    fn new(allow_native_approval: bool) -> Self {
        Self {
            allow_native_approval,
            approval_calls: AtomicUsize::new(0),
            tool_calls: parking_lot::Mutex::new(Vec::new()),
        }
    }
}

#[async_trait]
impl DynamicToolHandler for RecordingHarnessToolHandler {
    async fn call_tool(&self, name: &str, arguments: Map<String, Value>) -> DynamicToolCallOutput {
        self.tool_calls
            .lock()
            .push((name.to_owned(), arguments.clone()));
        DynamicToolCallOutput {
            text: json!({ "handled": name, "arguments": arguments }).to_string(),
            is_error: false,
        }
    }

    async fn request_approval(&self, _method: &str, _params: &Value) -> bool {
        self.approval_calls.fetch_add(1, Ordering::Relaxed);
        self.allow_native_approval
    }
}

fn sample_harness_tools() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition {
            name: "bash".to_owned(),
            description: "Native shell".to_owned(),
            parameters: json!({ "type": "object", "properties": { "command": { "type": "string" } } }),
        },
        ToolDefinition {
            name: "read".to_owned(),
            description: "Native read".to_owned(),
            parameters: json!({ "type": "object", "properties": { "path": { "type": "string" } } }),
        },
        ToolDefinition {
            name: "taskUpdate".to_owned(),
            description: "Update durable task state".to_owned(),
            parameters: json!({
                "type": "object",
                "properties": { "directive": { "type": "object" } },
                "required": ["directive"]
            }),
        },
        ToolDefinition {
            name: "reviewTask".to_owned(),
            description: "Run independent task review".to_owned(),
            parameters: json!({
                "type": "object",
                "properties": { "round": { "type": "integer" } }
            }),
        },
    ]
}

#[cfg(unix)]
#[tokio::test]
async fn claude_sdk_bridges_harness_tools_over_authenticated_loopback_mcp_and_enforces_allowlist() {
    use std::os::unix::fs::PermissionsExt;

    let tmp = TempDir::new().unwrap();
    let script_path = tmp.path().join("mock-claude-mcp-bridge.py");
    let script = r#"#!/usr/bin/env python3
import json, os, stat, sys, urllib.error, urllib.request

args = sys.argv[1:]

def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

def mcp_post(url, headers, payload):
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"content-type": "application/json", **headers},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as resp:
            raw = resp.read().decode("utf-8")
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8")
        return e.code, raw

def ask(req_id, tool_name, tool_input):
    emit({
        "type": "control_request",
        "request_id": req_id,
        "request": {"subtype": "can_use_tool", "tool_name": tool_name, "input": tool_input},
    })
    resp = json.loads(sys.stdin.readline().strip())
    return resp["response"]["response"]["behavior"]

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
        has_mcp_config = "--mcp-config" in args
        if not has_mcp_config:
            payload = json.dumps({"has_mcp_config": False})
        else:
            cfg_path = args[args.index("--mcp-config") + 1]
            cfg_mode = stat.S_IMODE(os.stat(cfg_path).st_mode)
            cfg = json.loads(open(cfg_path, "r", encoding="utf-8").read())
            srv = cfg["mcpServers"]["cowork"]
            url = srv["url"]
            auth_headers = srv["headers"]

            bad_auth_code, _ = mcp_post(url, {"Authorization": "Bearer wrong"}, {"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
            origin_code, _ = mcp_post(url, {**auth_headers, "Origin": "https://evil.example"}, {"jsonrpc": "2.0", "id": 2, "method": "tools/list"})

            init_code, init_body = mcp_post(url, auth_headers, {"jsonrpc": "2.0", "id": 3, "method": "initialize", "params": {"protocolVersion": "2025-03-26"}})
            notif_code, _ = mcp_post(url, auth_headers, {"jsonrpc": "2.0", "method": "notifications/initialized"})
            list_code, list_body = mcp_post(url, auth_headers, {"jsonrpc": "2.0", "id": 4, "method": "tools/list"})
            listed_names = [t["name"] for t in list_body["result"]["tools"]]

            perm_task = ask("p-task", "mcp__cowork__taskUpdate", {"directive": {"type": "add_note", "summary": "done"}})
            perm_unknown = ask("p-unknown", "mcp__cowork__notRegistered", {})
            perm_native_bash = ask("p-bash", "Bash", {"command": "echo nope"})

            call_code, call_body = mcp_post(url, auth_headers, {
                "jsonrpc": "2.0",
                "id": 5,
                "method": "tools/call",
                "params": {"name": "taskUpdate", "arguments": {"directive": {"type": "add_note", "summary": "done"}}},
            })
            unauth_call_code, unauth_call_body = mcp_post(url, auth_headers, {
                "jsonrpc": "2.0",
                "id": 6,
                "method": "tools/call",
                "params": {"name": "bash", "arguments": {"command": "whoami"}},
            })

            emit({"type": "stream_event", "event": {"type": "content_block_start", "index": 0, "content_block": {"type": "tool_use", "id": "tu-mcp-1", "name": "mcp__cowork__taskUpdate"}}})
            emit({"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": "{\"directive\":{\"type\":\"add_note\"}}"}}})
            emit({"type": "stream_event", "event": {"type": "content_block_stop", "index": 0}})
            emit({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "tu-mcp-1", "content": call_body["result"]["content"][0]["text"], "is_error": False}]}})

            payload = json.dumps({
                "has_mcp_config": True,
                "cfg_path": cfg_path,
                "cfg_mode": cfg_mode,
                "url": url,
                "bad_auth_code": bad_auth_code,
                "origin_code": origin_code,
                "init_code": init_code,
                "notif_code": notif_code,
                "list_code": list_code,
                "listed_names": listed_names,
                "perm_task": perm_task,
                "perm_unknown": perm_unknown,
                "perm_native_bash": perm_native_bash,
                "call_code": call_code,
                "call_text": call_body["result"]["content"][0]["text"],
                "unauth_call_code": unauth_call_code,
                "unauth_call_err": unauth_call_body["error"]["code"],
                "system_prompt_has_note": "--append-system-prompt" in args and "mcp__cowork__taskUpdate" in args[args.index("--append-system-prompt") + 1],
            })

        emit({"type": "system", "subtype": "init", "session_id": "claude-mcp-1"})
        emit({"type": "stream_event", "event": {"type": "content_block_start", "index": 1, "content_block": {"type": "text"}}})
        emit({"type": "stream_event", "event": {"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": payload}}})
        emit({"type": "stream_event", "event": {"type": "content_block_stop", "index": 1}})
        emit({
            "type": "result",
            "subtype": "success",
            "is_error": False,
            "session_id": "claude-mcp-1",
            "result": payload,
            "usage": {"input_tokens": 10, "output_tokens": 10},
        })
        break
"#;
    std::fs::write(&script_path, script).unwrap();
    std::fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o755)).unwrap();

    let mut env = HashMap::new();
    env.insert("HOME".into(), tmp.path().to_string_lossy().into_owned());
    env.insert("PATH".into(), std::env::var("PATH").unwrap_or_default());

    let handler = Arc::new(RecordingHarnessToolHandler::new(false));
    let mut transport =
        ClaudeSdkTransport::with_env_and_handler(env.clone(), Some(handler.clone()));
    transport.command_override = Some((script_path.to_string_lossy().into_owned(), Vec::new()));

    let mut provider_options = Map::new();
    provider_options.insert("cwd".into(), json!(tmp.path().to_string_lossy()));
    let budget = StepBudget::unbounded(Some(CancellationToken::new()));

    let mut events = Vec::new();
    let res = transport
        .stream_step(
            ProviderStepRequest {
                model_id: "claude-opus-4-8".to_owned(),
                base_url: None,
                api_key: None,
                extra_headers: HashMap::new(),
                system_prompt: "Execute the task.".to_owned(),
                messages: vec![user_msg("Update task state")],
                tools: sample_harness_tools(),
                authorized_tool_names: Some(vec![
                    "taskUpdate".to_owned(),
                    "reviewTask".to_owned(),
                    "read".to_owned(),
                ]),
                provider_options: provider_options.clone(),
                continuation: None,
                policy: RequestPolicy::default(),
                turn_id: "turn-claude-mcp".to_owned(),
            },
            &budget,
            &mut |ev| events.push(ev),
        )
        .await
        .expect("Claude SDK bridged harness tool turn succeeds");

    let text = res
        .assistant
        .content
        .iter()
        .find_map(|b| match b {
            ContentBlock::Text { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .unwrap();
    let payload: Value = serde_json::from_str(text).unwrap();
    assert_eq!(payload["has_mcp_config"], json!(true));
    assert_eq!(payload["cfg_mode"], json!(0o600));
    assert_eq!(payload["bad_auth_code"], json!(401));
    assert_eq!(payload["origin_code"], json!(403));
    assert_eq!(payload["init_code"], json!(200));
    assert_eq!(payload["notif_code"], json!(202));
    assert_eq!(payload["list_code"], json!(200));
    assert_eq!(payload["listed_names"], json!(["taskUpdate", "reviewTask"]));
    assert_eq!(payload["perm_task"], json!("allow"));
    assert_eq!(payload["perm_unknown"], json!("deny"));
    assert_eq!(payload["perm_native_bash"], json!("deny"));
    assert_eq!(payload["call_code"], json!(200));
    assert_eq!(payload["unauth_call_code"], json!(200));
    assert_eq!(payload["unauth_call_err"], json!(-32602));
    assert_eq!(payload["system_prompt_has_note"], json!(true));

    // Only `taskUpdate` was executed through DynamicToolHandler::call_tool; native approval
    // handler was never needed for the bridged tool and blocked disallowed tools before reaching it.
    let recorded = handler.tool_calls.lock().clone();
    assert_eq!(recorded.len(), 1);
    assert_eq!(recorded[0].0, "taskUpdate");
    assert_eq!(handler.approval_calls.load(Ordering::Relaxed), 0);

    // Stream events normalize `mcp__cowork__taskUpdate` -> `taskUpdate`.
    assert!(events.iter().any(|e| matches!(
        e,
        StreamEvent::ToolCallEnd { key, name, .. } if key == "tu-mcp-1" && name == "taskUpdate"
    )));
    assert!(events.iter().any(|e| matches!(
        e,
        StreamEvent::ToolResult { key, name, is_error: false, .. } if key == "tu-mcp-1" && name == "taskUpdate"
    )));

    // Ephemeral config file and loopback MCP bridge must both be torn down once the turn ends.
    let cfg_path = payload["cfg_path"].as_str().unwrap();
    assert!(
        !std::path::Path::new(cfg_path).exists(),
        "ephemeral Claude --mcp-config file must be deleted after turn ends"
    );
    let mcp_url = payload["url"].as_str().unwrap();
    assert!(
        reqwest::Client::new().post(mcp_url).send().await.is_err(),
        "ephemeral loopback MCP bridge must close immediately after turn completes"
    );

    // When tools_disabled is set, no MCP bridge or `--mcp-config` is exposed.
    let mut disabled_transport =
        ClaudeSdkTransport::with_env_and_handler(env, Some(handler)).with_tools_disabled(true);
    disabled_transport.command_override =
        Some((script_path.to_string_lossy().into_owned(), Vec::new()));
    let disabled_res = disabled_transport
        .stream_step(
            ProviderStepRequest {
                model_id: "claude-opus-4-8".to_owned(),
                base_url: None,
                api_key: None,
                extra_headers: HashMap::new(),
                system_prompt: String::new(),
                messages: vec![user_msg("No tools")],
                tools: sample_harness_tools(),
                authorized_tool_names: Some(vec!["taskUpdate".to_owned()]),
                provider_options,
                continuation: None,
                policy: RequestPolicy::default(),
                turn_id: "turn-claude-mcp-disabled".to_owned(),
            },
            &budget,
            &mut |_| {},
        )
        .await
        .expect("disabled tools turn succeeds");
    let disabled_text = disabled_res
        .assistant
        .content
        .iter()
        .find_map(|b| match b {
            ContentBlock::Text { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .unwrap();
    let disabled_payload: Value = serde_json::from_str(disabled_text).unwrap();
    assert_eq!(disabled_payload["has_mcp_config"], json!(false));
}

#[cfg(unix)]
#[tokio::test]
async fn antigravity_acp_bridges_harness_tools_over_authenticated_loopback_mcp_and_enforces_allowlist()
 {
    use std::os::unix::fs::PermissionsExt;

    let tmp = TempDir::new().unwrap();
    let script_path = tmp.path().join("mock-acp-mcp-bridge.py");
    let script = r#"#!/usr/bin/env python3
import json, os, sys, urllib.error, urllib.request

forbid_http = os.environ.get("MOCK_ACP_FORBID_HTTP") == "1"

def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

def mcp_post(url, headers, payload):
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"content-type": "application/json", **headers},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as resp:
            raw = resp.read().decode("utf-8")
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8")
        return e.code, raw

def ask_perm(req_id, sid, tool_call):
    send({
        "jsonrpc": "2.0",
        "id": req_id,
        "method": "session/request_permission",
        "params": {
            "sessionId": sid,
            "toolCall": tool_call,
            "options": [
                {"optionId": "opt-allow", "name": "Allow", "kind": "allow_once"},
                {"optionId": "opt-deny", "name": "Reject", "kind": "reject_once"},
            ],
        },
    })
    resp = json.loads(sys.stdin.readline().strip())
    return resp["result"]["outcome"].get("optionId")

seen_mcp_servers = []
resumed = False

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    method = msg.get("method")
    req_id = msg.get("id")
    params = msg.get("params", {})

    if method == "initialize":
        caps = {"mcpCapabilities": {"http": not forbid_http}}
        send({"jsonrpc": "2.0", "id": req_id, "result": {"protocolVersion": 1, "agentCapabilities": caps}})
    elif method == "session/new":
        seen_mcp_servers = params.get("mcpServers", [])
        send({"jsonrpc": "2.0", "id": req_id, "result": {"sessionId": "acp-mcp-1"}})
    elif method == "session/resume":
        resumed = True
        seen_mcp_servers = params.get("mcpServers", [])
        send({"jsonrpc": "2.0", "id": req_id, "result": {"sessionId": params.get("sessionId")}})
    elif method in ("session/set_model", "session/set_config_option"):
        send({"jsonrpc": "2.0", "id": req_id, "result": {}})
    elif method == "session/prompt":
        sid = params["sessionId"]
        srv = seen_mcp_servers[0]
        url = srv["url"]
        auth_headers = {h["name"]: h["value"] for h in srv["headers"]}

        bad_auth_code, _ = mcp_post(url, {"Authorization": "Bearer wrong"}, {"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        origin_code, _ = mcp_post(url, {**auth_headers, "Origin": "https://evil.example"}, {"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        init_code, _ = mcp_post(url, auth_headers, {"jsonrpc": "2.0", "id": 3, "method": "initialize", "params": {"protocolVersion": "2025-03-26"}})
        notif_code, _ = mcp_post(url, auth_headers, {"jsonrpc": "2.0", "method": "notifications/initialized"})
        list_code, list_body = mcp_post(url, auth_headers, {"jsonrpc": "2.0", "id": 4, "method": "tools/list"})
        listed_names = [t["name"] for t in list_body["result"]["tools"]]

        perm_bridged = ask_perm(9201, sid, {"toolCallId": "tc-1", "toolName": "mcp__cowork__reviewTask", "kind": "other", "rawInput": {"round": 1}})
        # Forged native `execute` kind with bridged name must NEVER bypass native approval.
        perm_forged_exec = ask_perm(9202, sid, {"toolCallId": "tc-2", "toolName": "mcp__cowork__reviewTask", "kind": "execute", "rawInput": {"command": "id"}})
        perm_unregistered = ask_perm(9203, sid, {"toolCallId": "tc-3", "toolName": "mcp__cowork__unknownTool", "kind": "other"})

        call_code, call_body = mcp_post(url, auth_headers, {
            "jsonrpc": "2.0",
            "id": 5,
            "method": "tools/call",
            "params": {"name": "reviewTask", "arguments": {"round": 1}},
        })

        send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": sid, "update": {"sessionUpdate": "tool_call", "toolCallId": "tc-mcp-1", "toolName": "mcp__cowork__reviewTask", "rawInput": {"round": 1}}}})
        send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": sid, "update": {"sessionUpdate": "tool_call_update", "toolCallId": "tc-mcp-1", "toolName": "mcp__cowork__reviewTask", "status": "completed", "rawOutput": call_body["result"]["content"][0]["text"]}}})

        payload = json.dumps({
            "server_name": srv["name"],
            "server_type": srv["type"],
            "url": url,
            "resumed": resumed,
            "bad_auth_code": bad_auth_code,
            "origin_code": origin_code,
            "init_code": init_code,
            "notif_code": notif_code,
            "list_code": list_code,
            "listed_names": listed_names,
            "perm_bridged": perm_bridged,
            "perm_forged_exec": perm_forged_exec,
            "perm_unregistered": perm_unregistered,
            "call_code": call_code,
            "call_text": call_body["result"]["content"][0]["text"],
        })
        send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": sid, "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": payload}}}})
        send({"jsonrpc": "2.0", "id": req_id, "result": {"stopReason": "end_turn"}})
        break
"#;
    std::fs::write(&script_path, script).unwrap();
    std::fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o755)).unwrap();

    let mut env = HashMap::new();
    env.insert("HOME".into(), tmp.path().to_string_lossy().into_owned());
    env.insert("PATH".into(), std::env::var("PATH").unwrap_or_default());

    let handler = Arc::new(RecordingHarnessToolHandler::new(false));
    let mut transport =
        AntigravityAcpTransport::with_env_and_handler(env.clone(), Some(handler.clone()));
    transport.command_override = Some((script_path.to_string_lossy().into_owned(), Vec::new()));

    let mut provider_options = Map::new();
    provider_options.insert("cwd".into(), json!(tmp.path().to_string_lossy()));
    let budget = StepBudget::unbounded(Some(CancellationToken::new()));

    let mut events = Vec::new();
    let res = transport
        .stream_step(
            ProviderStepRequest {
                model_id: "gemini-4-neon".to_owned(),
                base_url: None,
                api_key: None,
                extra_headers: HashMap::new(),
                system_prompt: "Review the task.".to_owned(),
                messages: vec![user_msg("Run review")],
                tools: sample_harness_tools(),
                authorized_tool_names: Some(vec!["taskUpdate".to_owned(), "reviewTask".to_owned()]),
                provider_options: provider_options.clone(),
                continuation: None,
                policy: RequestPolicy::default(),
                turn_id: "turn-acp-mcp-1".to_owned(),
            },
            &budget,
            &mut |ev| events.push(ev),
        )
        .await
        .expect("ACP bridged harness tool turn succeeds");

    let text = res
        .assistant
        .content
        .iter()
        .find_map(|b| match b {
            ContentBlock::Text { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .unwrap();
    let payload: Value = serde_json::from_str(text).unwrap();
    assert_eq!(payload["server_name"], json!("cowork"));
    assert_eq!(payload["server_type"], json!("http"));
    assert_eq!(payload["resumed"], json!(false));
    assert_eq!(payload["bad_auth_code"], json!(401));
    assert_eq!(payload["origin_code"], json!(403));
    assert_eq!(payload["init_code"], json!(200));
    assert_eq!(payload["notif_code"], json!(202));
    assert_eq!(payload["list_code"], json!(200));
    assert_eq!(payload["listed_names"], json!(["taskUpdate", "reviewTask"]));
    assert_eq!(payload["perm_bridged"], json!("opt-allow"));
    assert_eq!(payload["perm_forged_exec"], json!("opt-deny"));
    assert_eq!(payload["perm_unregistered"], json!("opt-deny"));
    assert_eq!(payload["call_code"], json!(200));

    let recorded = handler.tool_calls.lock().clone();
    assert_eq!(recorded.len(), 1);
    assert_eq!(recorded[0].0, "reviewTask");
    assert_eq!(recorded[0].1.get("round"), Some(&json!(1)));

    // Stream events normalize `mcp__cowork__reviewTask` -> `reviewTask`.
    assert!(events.iter().any(|e| matches!(
        e,
        StreamEvent::ToolCallEnd { key, name, .. } if key == "tc-mcp-1" && name == "reviewTask"
    )));
    assert!(events.iter().any(|e| matches!(
        e,
        StreamEvent::ToolResult { key, name, is_error: false, .. } if key == "tc-mcp-1" && name == "reviewTask"
    )));

    // Loopback MCP bridge shuts down immediately on turn completion.
    let mcp_url = payload["url"].as_str().unwrap();
    assert!(
        reqwest::Client::new().post(mcp_url).send().await.is_err(),
        "ephemeral ACP loopback MCP bridge must close immediately after turn completes"
    );

    // Turn 2 resumes with fresh bridge in `session/resume`.
    let res2 = transport
        .stream_step(
            ProviderStepRequest {
                model_id: "gemini-4-neon".to_owned(),
                base_url: None,
                api_key: None,
                extra_headers: HashMap::new(),
                system_prompt: "Review the task.".to_owned(),
                messages: vec![
                    user_msg("Run review"),
                    res.assistant.clone(),
                    user_msg("Next round"),
                ],
                tools: sample_harness_tools(),
                authorized_tool_names: Some(vec!["taskUpdate".to_owned(), "reviewTask".to_owned()]),
                provider_options: provider_options.clone(),
                continuation: res.continuation.clone(),
                policy: RequestPolicy::default(),
                turn_id: "turn-acp-mcp-2".to_owned(),
            },
            &budget,
            &mut |_| {},
        )
        .await
        .expect("ACP resumed bridged turn succeeds");
    let text2 = res2
        .assistant
        .content
        .iter()
        .find_map(|b| match b {
            ContentBlock::Text { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .unwrap();
    let payload2: Value = serde_json::from_str(text2).unwrap();
    assert_eq!(payload2["resumed"], json!(true));
    assert_eq!(
        payload2["listed_names"],
        json!(["taskUpdate", "reviewTask"])
    );

    // If ACP explicitly declares `mcpCapabilities.http: false`, fail closed rather than silently
    // dropping required Cowork harness tools.
    let mut forbid_env = env;
    forbid_env.insert("MOCK_ACP_FORBID_HTTP".into(), "1".into());
    let mut forbid_transport =
        AntigravityAcpTransport::with_env_and_handler(forbid_env, Some(handler));
    forbid_transport.command_override =
        Some((script_path.to_string_lossy().into_owned(), Vec::new()));
    let err = forbid_transport
        .stream_step(
            ProviderStepRequest {
                model_id: "gemini-4-neon".to_owned(),
                base_url: None,
                api_key: None,
                extra_headers: HashMap::new(),
                system_prompt: String::new(),
                messages: vec![user_msg("Needs bridge")],
                tools: sample_harness_tools(),
                authorized_tool_names: Some(vec!["taskUpdate".to_owned()]),
                provider_options,
                continuation: None,
                policy: RequestPolicy::default(),
                turn_id: "turn-acp-no-http".to_owned(),
            },
            &budget,
            &mut |_| {},
        )
        .await
        .expect_err(
            "ACP without HTTP MCP capability must fail closed when harness tools are required",
        );
    assert!(
        err.message.contains("HTTP MCP"),
        "unexpected error: {err:?}"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn claude_sdk_and_acp_bridge_webfetch_while_blocking_native_webfetch() {
    use std::os::unix::fs::PermissionsExt;

    let tmp = TempDir::new().unwrap();
    let web_fetch_tools = vec![
        ToolDefinition {
            name: "read".to_owned(),
            description: "Read local file".to_owned(),
            parameters: json!({ "type": "object", "properties": { "path": { "type": "string" } } }),
        },
        ToolDefinition {
            name: "webFetch".to_owned(),
            description: "Fetch URL via Cowork DNS-pinned HTTP client".to_owned(),
            parameters: json!({
                "type": "object",
                "properties": { "url": { "type": "string" } },
                "required": ["url"]
            }),
        },
    ];

    // 1. Claude SDK: always passes `--disallowedTools ...WebFetch...`, denies native `WebFetch`
    //    `can_use_tool`, and bridges Cowork's `webFetch` as `mcp__cowork__webFetch`.
    let claude_script = tmp.path().join("mock-claude-webfetch.py");
    let claude_py = r#"#!/usr/bin/env python3
import json, sys, urllib.request

args = sys.argv[1:]
disallowed = args[args.index("--disallowedTools") + 1] if "--disallowedTools" in args else ""
mcp_cfg_path = args[args.index("--mcp-config") + 1] if "--mcp-config" in args else None
assert mcp_cfg_path, f"expected --mcp-config for bridged webFetch: {args}"
with open(mcp_cfg_path, "r") as f:
    mcp_cfg = json.load(f)
srv = mcp_cfg["mcpServers"]["cowork"]
mcp_url = srv["url"]
mcp_headers = srv["headers"]

def rpc(method, params, rid):
    req = urllib.request.Request(
        mcp_url,
        data=json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params}).encode(),
        headers={"Content-Type": "application/json", **mcp_headers},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read().decode())

def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

def ask(req_id, tool_name, tool_input):
    emit({
        "type": "control_request",
        "request_id": req_id,
        "request": {"subtype": "can_use_tool", "tool_name": tool_name, "input": tool_input},
    })
    return json.loads(sys.stdin.readline().strip())["response"]["response"]["behavior"]

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    if msg.get("type") == "control_request" and msg.get("request", {}).get("subtype") == "initialize":
        emit({"type": "control_response", "response": {"subtype": "success", "request_id": msg["request_id"], "response": {}}})
    elif msg.get("type") == "user":
        listed = [t["name"] for t in rpc("tools/list", {}, 1)["result"]["tools"]]
        native_perm = ask("p-native", "WebFetch", {"url": "https://example.com/docs"})
        bridged_perm = ask("p-bridged", "mcp__cowork__webFetch", {"url": "https://example.com/docs"})
        call_res = rpc("tools/call", {"name": "webFetch", "arguments": {"url": "https://example.com/docs"}}, 2)
        summary = json.dumps({
            "disallowed": disallowed.split(",") if disallowed else [],
            "listed": listed,
            "native_perm": native_perm,
            "bridged_perm": bridged_perm,
            "call_text": call_res["result"]["content"][0]["text"],
        })
        emit({"type": "stream_event", "event": {"type": "content_block_start", "index": 0, "content_block": {"type": "text"}}})
        emit({"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": summary}}})
        emit({"type": "stream_event", "event": {"type": "content_block_stop", "index": 0}})
        emit({
            "type": "result",
            "subtype": "success",
            "is_error": False,
            "session_id": "claude-webfetch-1",
            "result": summary,
            "usage": {"input_tokens": 5, "output_tokens": 5},
        })
        break
"#;
    std::fs::write(&claude_script, claude_py).unwrap();
    std::fs::set_permissions(&claude_script, std::fs::Permissions::from_mode(0o755)).unwrap();

    let mut env = HashMap::new();
    env.insert("HOME".into(), tmp.path().to_string_lossy().into_owned());
    env.insert("PATH".into(), std::env::var("PATH").unwrap_or_default());

    let handler = Arc::new(RecordingHarnessToolHandler::new(true));
    let mut claude_transport =
        ClaudeSdkTransport::with_env_and_handler(env.clone(), Some(handler.clone()));
    claude_transport.command_override =
        Some((claude_script.to_string_lossy().into_owned(), Vec::new()));

    let mut provider_options = Map::new();
    provider_options.insert("cwd".into(), json!(tmp.path().to_string_lossy()));
    let budget = StepBudget::unbounded(Some(CancellationToken::new()));

    // Verify both unrestricted (`authorized_tool_names: None`) and explicit `webFetch` allowlist.
    for allowlist in [None, Some(vec!["webFetch".to_owned()])] {
        let res = claude_transport
            .stream_step(
                ProviderStepRequest {
                    model_id: "claude-opus-4-8".to_owned(),
                    base_url: None,
                    api_key: Some("sk-ant-test".to_owned()),
                    extra_headers: HashMap::new(),
                    system_prompt: "Fetch docs.".to_owned(),
                    messages: vec![user_msg("Read https://example.com/docs")],
                    tools: web_fetch_tools.clone(),
                    authorized_tool_names: allowlist,
                    provider_options: provider_options.clone(),
                    continuation: None,
                    policy: RequestPolicy::default(),
                    turn_id: "turn-claude-wf".to_owned(),
                },
                &budget,
                &mut |_| {},
            )
            .await
            .expect("Claude SDK bridged webFetch turn succeeds");
        let text = res
            .assistant
            .content
            .iter()
            .find_map(|b| match b {
                ContentBlock::Text { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .unwrap();
        let payload: Value = serde_json::from_str(text).unwrap();
        assert!(
            payload["disallowed"]
                .as_array()
                .unwrap()
                .iter()
                .any(|v| v == "WebFetch"),
            "Claude SDK must always disable native WebFetch via --disallowedTools: {payload}"
        );
        assert_eq!(payload["listed"], json!(["webFetch"]));
        assert_eq!(payload["native_perm"], json!("deny"));
        assert_eq!(payload["bridged_perm"], json!("allow"));
        assert!(payload["call_text"].as_str().unwrap().contains("webFetch"));
    }

    // 2. Antigravity ACP: denies native `web_fetch` / `read_url_content` / `kind: "fetch"`
    //    permissions and bridges Cowork's `webFetch` over the loopback MCP server.
    let acp_script = tmp.path().join("mock-acp-webfetch.py");
    let acp_py = r#"#!/usr/bin/env python3
import json, sys, urllib.request

def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

def rpc(url, headers, method, params, rid):
    req = urllib.request.Request(
        url,
        data=json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params}).encode(),
        headers={"Content-Type": "application/json", **headers},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read().decode())

def ask_perm(rid, sid, tool_call):
    send({
        "jsonrpc": "2.0",
        "id": rid,
        "method": "session/request_permission",
        "params": {
            "sessionId": sid,
            "toolCall": tool_call,
            "options": [
                {"optionId": "opt-allow", "name": "Allow", "kind": "allow_once"},
                {"optionId": "opt-reject", "name": "Reject", "kind": "reject_once"},
            ],
        },
    })
    resp = json.loads(sys.stdin.readline().strip())
    return resp["result"]["outcome"]["optionId"]

mcp_url = None
mcp_headers = {}
sid = "acp-wf-1"

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    method = msg.get("method")
    rid = msg.get("id")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": rid, "result": {"protocolVersion": 1, "agentCapabilities": {"mcpCapabilities": {"http": True}}}})
    elif method == "session/new":
        servers = msg.get("params", {}).get("mcpServers", [])
        srv = next(s for s in servers if s.get("name") == "cowork")
        mcp_url = srv["url"]
        mcp_headers = {h["name"]: h["value"] for h in srv.get("headers", [])}
        send({"jsonrpc": "2.0", "id": rid, "result": {"sessionId": sid}})
    elif method in ("session/set_model", "session/set_config_option"):
        send({"jsonrpc": "2.0", "id": rid, "result": {}})
    elif method == "session/prompt":
        listed = [t["name"] for t in rpc(mcp_url, mcp_headers, "tools/list", {}, 1)["result"]["tools"]]
        native_name_perm = ask_perm(91, sid, {"toolCallId": "tc-1", "toolName": "read_url_content", "kind": "fetch", "rawInput": {"url": "https://example.com"}})
        native_kind_perm = ask_perm(92, sid, {"toolCallId": "tc-2", "toolName": "custom_fetch", "kind": "fetch", "rawInput": {"href": "https://example.com"}})
        bridged_perm = ask_perm(93, sid, {"toolCallId": "tc-3", "toolName": "cowork/webFetch", "kind": "other", "rawInput": {"url": "https://example.com"}})
        call_res = rpc(mcp_url, mcp_headers, "tools/call", {"name": "webFetch", "arguments": {"url": "https://example.com"}}, 2)
        summary = json.dumps({
            "listed": listed,
            "native_name_perm": native_name_perm,
            "native_kind_perm": native_kind_perm,
            "bridged_perm": bridged_perm,
            "call_text": call_res["result"]["content"][0]["text"],
        })
        send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": sid, "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": summary}}}})
        send({"jsonrpc": "2.0", "id": rid, "result": {"stopReason": "end_turn"}})
        break
"#;
    std::fs::write(&acp_script, acp_py).unwrap();
    std::fs::set_permissions(&acp_script, std::fs::Permissions::from_mode(0o755)).unwrap();

    let mut acp_transport =
        AntigravityAcpTransport::with_env_and_handler(env, Some(handler.clone()));
    acp_transport.command_override = Some((acp_script.to_string_lossy().into_owned(), Vec::new()));

    for allowlist in [None, Some(vec!["webFetch".to_owned()])] {
        let res = acp_transport
            .stream_step(
                ProviderStepRequest {
                    model_id: "gemini-4-neon".to_owned(),
                    base_url: None,
                    api_key: None,
                    extra_headers: HashMap::new(),
                    system_prompt: "Fetch docs.".to_owned(),
                    messages: vec![user_msg("Read https://example.com")],
                    tools: web_fetch_tools.clone(),
                    authorized_tool_names: allowlist,
                    provider_options: provider_options.clone(),
                    continuation: None,
                    policy: RequestPolicy::default(),
                    turn_id: "turn-acp-wf".to_owned(),
                },
                &budget,
                &mut |_| {},
            )
            .await
            .expect("ACP bridged webFetch turn succeeds");
        let text = res
            .assistant
            .content
            .iter()
            .find_map(|b| match b {
                ContentBlock::Text { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .unwrap();
        let payload: Value = serde_json::from_str(text).unwrap();
        assert_eq!(payload["listed"], json!(["webFetch"]));
        assert_eq!(payload["native_name_perm"], json!("opt-reject"));
        assert_eq!(payload["native_kind_perm"], json!("opt-reject"));
        assert_eq!(payload["bridged_perm"], json!("opt-allow"));
        assert!(payload["call_text"].as_str().unwrap().contains("webFetch"));
    }

    assert_eq!(
        handler.approval_calls.load(Ordering::Relaxed),
        0,
        "native WebFetch must be denied before reaching the approval handler, and bridged webFetch executes via MCP"
    );
}
