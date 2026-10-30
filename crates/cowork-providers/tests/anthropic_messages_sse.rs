use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::{
    Json, Router,
    body::Body,
    extract::State,
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::post,
};
use cowork_inference::{
    CanonicalMessage, ContentBlock, MessageRole, ProviderOpaqueMeta, RequestPolicy, StepBudget,
    StreamEvent, ToolResultPart,
};
use cowork_providers::{
    AnthropicMessagesTransport, ProviderStepRequest, ProviderTransport, ToolDefinition,
};
use serde_json::{Map, Value, json};

#[derive(Clone, Default)]
struct MockAnthropicState {
    requests: Arc<Mutex<Vec<(HeaderMap, Value)>>>,
    replies: Arc<Mutex<Vec<String>>>,
}

async fn handle_messages(
    State(state): State<MockAnthropicState>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Response {
    state.requests.lock().unwrap().push((headers, payload));
    let body = state.replies.lock().unwrap().remove(0);
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .body(Body::from(body))
        .unwrap()
        .into_response()
}

async fn spawn_mock_anthropic_server(replies: Vec<String>) -> (String, MockAnthropicState) {
    let state = MockAnthropicState {
        requests: Arc::new(Mutex::new(Vec::new())),
        replies: Arc::new(Mutex::new(replies)),
    };
    let app = Router::new()
        .route("/v1/messages", post(handle_messages))
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral 127.0.0.1:0");
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("http://{addr}"), state)
}

fn anthropic_sse(event: &str, data: Value) -> String {
    format!("event: {event}\ndata: {data}\n\n")
}

#[tokio::test]
async fn anthropic_messages_sse_preserves_adaptive_and_budget_thinking_signatures_redacted_blocks_and_cache_breakpoints()
 {
    // Turn 1: Adaptive thinking (`claude-opus-4-7`) emitting signed `thinking`, `redacted_thinking`,
    // `text`, and `tool_use` with fine-grained input_json_delta + extra unknown vendor fields!
    let step1_sse = [
        anthropic_sse(
            "message_start",
            json!({
                "type": "message_start",
                "extra_vendor_meta": {"region": "us"},
                "message": {
                    "id": "msg_ant_1",
                    "type": "message",
                    "role": "assistant",
                    "usage": {
                        "input_tokens": 500,
                        "cache_creation_input_tokens": 200,
                        "cache_read_input_tokens": 1200,
                        "output_tokens": 1
                    }
                }
            }),
        ),
        anthropic_sse(
            "content_block_start",
            json!({
                "type": "content_block_start",
                "index": 0,
                "content_block": {"type": "thinking", "thinking": "", "signature": ""}
            }),
        ),
        anthropic_sse(
            "content_block_delta",
            json!({
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "thinking_delta", "thinking": "Let us check Cargo.toml."}
            }),
        ),
        anthropic_sse(
            "content_block_delta",
            json!({
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "signature_delta", "signature": "sig_part_A_"}
            }),
        ),
        anthropic_sse(
            "content_block_delta",
            json!({
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "signature_delta", "signature": "sig_part_B"}
            }),
        ),
        anthropic_sse(
            "content_block_stop",
            json!({"type": "content_block_stop", "index": 0}),
        ),
        // Redacted thinking block
        anthropic_sse(
            "content_block_start",
            json!({
                "type": "content_block_start",
                "index": 1,
                "content_block": {"type": "redacted_thinking", "data": "opaque_redacted_987"}
            }),
        ),
        anthropic_sse(
            "content_block_stop",
            json!({"type": "content_block_stop", "index": 1}),
        ),
        // Tool use block
        anthropic_sse(
            "content_block_start",
            json!({
                "type": "content_block_start",
                "index": 2,
                "content_block": {"type": "tool_use", "id": "toolu_01", "name": "read", "input": {}}
            }),
        ),
        anthropic_sse(
            "content_block_delta",
            json!({
                "type": "content_block_delta",
                "index": 2,
                "delta": {"type": "input_json_delta", "partial_json": "{\"path\":\"Cargo."}
            }),
        ),
        anthropic_sse(
            "content_block_delta",
            json!({
                "type": "content_block_delta",
                "index": 2,
                "delta": {"type": "input_json_delta", "partial_json": "toml\"}"}
            }),
        ),
        anthropic_sse(
            "content_block_stop",
            json!({"type": "content_block_stop", "index": 2}),
        ),
        anthropic_sse(
            "message_delta",
            json!({
                "type": "message_delta",
                "delta": {"stop_reason": "tool_use"},
                "usage": {"output_tokens": 85}
            }),
        ),
        anthropic_sse("message_stop", json!({"type": "message_stop"})),
    ]
    .concat();

    // Turn 2: Budget-based extended thinking (`claude-sonnet-4-6`) replaying signed thinking + redacted_thinking + tool_result
    let step2_sse = [
        anthropic_sse(
            "message_start",
            json!({
                "type": "message_start",
                "message": {
                    "id": "msg_ant_2",
                    "type": "message",
                    "role": "assistant",
                    "usage": {
                        "input_tokens": 600,
                        "cache_creation_input_tokens": 0,
                        "cache_read_input_tokens": 1700,
                        "output_tokens": 1
                    }
                }
            }),
        ),
        anthropic_sse(
            "content_block_start",
            json!({
                "type": "content_block_start",
                "index": 0,
                "content_block": {"type": "text", "text": ""}
            }),
        ),
        anthropic_sse(
            "content_block_delta",
            json!({
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "text_delta", "text": "Workspace Cargo.toml verified."}
            }),
        ),
        anthropic_sse(
            "content_block_stop",
            json!({"type": "content_block_stop", "index": 0}),
        ),
        anthropic_sse(
            "message_delta",
            json!({
                "type": "message_delta",
                "delta": {"stop_reason": "end_turn"},
                "usage": {"output_tokens": 42}
            }),
        ),
        anthropic_sse("message_stop", json!({"type": "message_stop"})),
    ]
    .concat();

    let (base_url, mock) = spawn_mock_anthropic_server(vec![step1_sse, step2_sse]).await;
    let transport = AnthropicMessagesTransport::new();

    let user_msg = CanonicalMessage {
        id: "u1".to_string(),
        role: MessageRole::User,
        phase: None,
        provider: None,
        api: None,
        model: None,
        stop_reason: None,
        provider_meta: ProviderOpaqueMeta::default(),
        created_at: "2026-10-30T00:00:00Z".to_string(),
        content: vec![ContentBlock::Text {
            text: "Read Cargo.toml".to_string(),
            phase: None,
            citations: vec![],
            provider_meta: ProviderOpaqueMeta::default(),
        }],
    };
    let read_tool = ToolDefinition {
        name: "read".to_string(),
        description: "Read a file".to_string(),
        parameters: json!({"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}),
    };

    // Step 1: Adaptive thinking + long (1h) prompt cache retention
    let mut adaptive_opts = Map::new();
    adaptive_opts.insert("thinking".to_string(), json!({"type": "adaptive"}));
    adaptive_opts.insert("effort".to_string(), json!("high"));
    adaptive_opts.insert("temperature".to_string(), json!(0.5)); // must be omitted when thinking is enabled!
    adaptive_opts.insert("cacheRetention".to_string(), json!("long"));

    let mut step1_events = Vec::new();
    let budget1 = StepBudget::new(10_000, None);
    let res1 = transport
        .stream_step(
            ProviderStepRequest {
                model_id: "claude-opus-4-7".to_string(),
                base_url: Some(base_url.clone()),
                api_key: Some("sk-ant-api03-test".to_string()),
                extra_headers: HashMap::new(),
                system_prompt: "You are Cowork.".to_string(),
                messages: vec![user_msg.clone()],
                tools: vec![read_tool.clone()],
                authorized_tool_names: None,
                provider_options: adaptive_opts,
                continuation: None,
                policy: RequestPolicy::default(),
                turn_id: "turn_ant_1".to_string(),
            },
            &budget1,
            &mut |ev| step1_events.push(ev),
        )
        .await
        .expect("anthropic step 1 succeeds");

    assert!(step1_events.iter().any(|ev| matches!(
        ev,
        StreamEvent::ThinkingDelta { delta, .. } if delta == "Let us check Cargo.toml."
    )));
    // Usage must capture total prompt tokens (500 + 200 + 1200 = 1900), cached=1200, cache_write=200, output=85
    assert_eq!(res1.usage.prompt_tokens, 1900);
    assert_eq!(res1.usage.cached_prompt_tokens, Some(1200));
    assert_eq!(res1.usage.cache_write_prompt_tokens, Some(200));
    assert_eq!(res1.usage.completion_tokens, 85);

    // Step 2: Replay assistant message (signed thinking + redacted_thinking + tool_use) + tool_result
    // using budget-based thinking (`claude-sonnet-4-6`) and short cache retention!
    let tool_result_msg = CanonicalMessage {
        id: "tr_ant_1".to_string(),
        role: MessageRole::Tool,
        phase: None,
        provider: None,
        api: None,
        model: None,
        stop_reason: None,
        provider_meta: ProviderOpaqueMeta::default(),
        created_at: "2026-10-30T00:00:01Z".to_string(),
        content: vec![ContentBlock::ToolResult {
            tool_call_id: "toolu_01".to_string(),
            tool_name: Some("read".to_string()),
            content: vec![ToolResultPart::Text {
                text: "[workspace]\nmembers = [\"crates/*\"]".to_string(),
            }],
            structured_meta: None,
            is_error: false,
            provider_meta: ProviderOpaqueMeta::default(),
        }],
    };

    let mut budget_opts = Map::new();
    budget_opts.insert(
        "thinking".to_string(),
        json!({"type": "enabled", "budgetTokens": 16_000}),
    );
    budget_opts.insert("cacheRetention".to_string(), json!("short"));

    let budget2 = StepBudget::new(10_000, None);
    let res2 = transport
        .stream_step(
            ProviderStepRequest {
                model_id: "claude-sonnet-4-6".to_string(),
                base_url: Some(base_url),
                api_key: Some("sk-ant-api03-test".to_string()),
                extra_headers: HashMap::new(),
                system_prompt: "You are Cowork.".to_string(),
                messages: vec![user_msg, res1.assistant, tool_result_msg],
                tools: vec![read_tool],
                authorized_tool_names: None,
                provider_options: budget_opts,
                continuation: None,
                policy: RequestPolicy::default(),
                turn_id: "turn_ant_1".to_string(),
            },
            &budget2,
            &mut |_| {},
        )
        .await
        .expect("anthropic step 2 succeeds");

    assert!(res2.assistant.content.iter().any(|b| matches!(
        b,
        ContentBlock::Text { text, .. } if text == "Workspace Cargo.toml verified."
    )));

    let recorded = mock.requests.lock().unwrap();
    assert_eq!(recorded.len(), 2);

    // Check Step 1 wire headers & adaptive thinking + 1h cache breakpoints
    let (h1, p1) = &recorded[0];
    assert_eq!(h1.get("anthropic-version").unwrap(), "2023-06-01");
    assert_eq!(h1.get("x-api-key").unwrap(), "sk-ant-api03-test");
    assert_eq!(p1["thinking"]["type"], "adaptive");
    assert_eq!(p1["output_config"]["effort"], "high");
    assert!(p1.get("temperature").is_none());
    assert_eq!(p1["system"][0]["cache_control"]["ttl"], "1h");
    assert_eq!(p1["tools"][0]["cache_control"]["ttl"], "1h");
    assert_eq!(
        p1["messages"][0]["content"][0]["cache_control"]["ttl"],
        "1h"
    );

    // Check Step 2 wire headers (interleaved-thinking beta) + budget thinking + lossless signature/redacted_thinking replay!
    let (h2, p2) = &recorded[1];
    let beta2 = h2.get("anthropic-beta").unwrap().to_str().unwrap();
    assert!(beta2.contains("interleaved-thinking-2025-05-14"));
    assert!(beta2.contains("fine-grained-tool-streaming-2025-05-14"));
    assert_eq!(p2["thinking"]["type"], "enabled");
    assert_eq!(p2["thinking"]["budget_tokens"], 16_000);

    let replayed_assistant_blocks = p2["messages"][1]["content"].as_array().unwrap();
    assert_eq!(replayed_assistant_blocks[0]["type"], "thinking");
    assert_eq!(
        replayed_assistant_blocks[0]["signature"],
        "sig_part_A_sig_part_B"
    );
    assert_eq!(replayed_assistant_blocks[1]["type"], "redacted_thinking");
    assert_eq!(replayed_assistant_blocks[1]["data"], "opaque_redacted_987");
    assert_eq!(replayed_assistant_blocks[2]["type"], "tool_use");
    assert_eq!(replayed_assistant_blocks[2]["input"]["path"], "Cargo.toml");

    // Trailing tool_result has ephemeral cache_control breakpoint!
    let replayed_tool_msg = &p2["messages"][2];
    assert_eq!(replayed_tool_msg["role"], "user");
    assert_eq!(replayed_tool_msg["content"][0]["type"], "tool_result");
    assert_eq!(
        replayed_tool_msg["content"][0]["cache_control"]["type"],
        "ephemeral"
    );
}

#[tokio::test]
async fn anthropic_messages_sse_handles_parallel_tools_oauth_orphan_synthesis_and_midstream_non_retry()
 {
    let parallel_sse = [
        anthropic_sse(
            "message_start",
            json!({
                "type": "message_start",
                "message": { "id": "msg_par", "usage": { "input_tokens": 80, "output_tokens": 0 } }
            }),
        ),
        anthropic_sse(
            "content_block_start",
            json!({
                "type": "content_block_start",
                "index": 0,
                "content_block": { "type": "tool_use", "id": "toolu_a", "name": "Read", "input": {} }
            }),
        ),
        anthropic_sse(
            "content_block_start",
            json!({
                "type": "content_block_start",
                "index": 1,
                "content_block": { "type": "tool_use", "id": "toolu_b", "name": "Bash", "input": {} }
            }),
        ),
        anthropic_sse(
            "content_block_delta",
            json!({
                "type": "content_block_delta",
                "index": 0,
                "delta": { "type": "input_json_delta", "partial_json": "{\"path\":\"src/lib.rs\"}" }
            }),
        ),
        anthropic_sse(
            "content_block_delta",
            json!({
                "type": "content_block_delta",
                "index": 1,
                "delta": { "type": "input_json_delta", "partial_json": "{\"command\":\"pwd\"}" }
            }),
        ),
        anthropic_sse(
            "content_block_stop",
            json!({ "type": "content_block_stop", "index": 0 }),
        ),
        anthropic_sse(
            "content_block_stop",
            json!({ "type": "content_block_stop", "index": 1 }),
        ),
        anthropic_sse(
            "message_delta",
            json!({
                "type": "message_delta",
                "delta": { "stop_reason": "tool_use" },
                "usage": { "output_tokens": 25 }
            }),
        ),
        anthropic_sse("message_stop", json!({ "type": "message_stop" })),
    ]
    .concat();

    let midstream_err_sse = [
        anthropic_sse(
            "message_start",
            json!({
                "type": "message_start",
                "message": { "id": "msg_err", "usage": { "input_tokens": 20, "output_tokens": 0 } }
            }),
        ),
        anthropic_sse(
            "content_block_start",
            json!({
                "type": "content_block_start",
                "index": 0,
                "content_block": { "type": "text", "text": "" }
            }),
        ),
        anthropic_sse(
            "content_block_delta",
            json!({
                "type": "content_block_delta",
                "index": 0,
                "delta": { "type": "text_delta", "text": "Hello before error" }
            }),
        ),
        anthropic_sse(
            "error",
            json!({
                "type": "error",
                "error": { "type": "overloaded_error", "message": "Overloaded mid-stream" }
            }),
        ),
    ]
    .concat();

    let (base_url, mock) =
        spawn_mock_anthropic_server(vec![parallel_sse, midstream_err_sse, String::new()]).await;
    let transport = AnthropicMessagesTransport::new();

    // History with an orphaned tool_use (no matching ToolResult) followed by a new user message!
    let mut orphan_args = Map::new();
    orphan_args.insert("path".to_string(), json!("README.md"));
    let u1 = CanonicalMessage {
        id: "u1".to_string(),
        role: MessageRole::User,
        phase: None,
        provider: None,
        api: None,
        model: None,
        stop_reason: None,
        provider_meta: ProviderOpaqueMeta::default(),
        created_at: "2026-10-30T00:00:00Z".to_string(),
        content: vec![ContentBlock::Text {
            text: "Read README".to_string(),
            phase: None,
            citations: vec![],
            provider_meta: ProviderOpaqueMeta::default(),
        }],
    };
    let a_orphan = CanonicalMessage {
        id: "a1".to_string(),
        role: MessageRole::Assistant,
        phase: None,
        provider: Some("anthropic".to_string()),
        api: None,
        model: Some("claude-sonnet-4-6".to_string()),
        stop_reason: None,
        provider_meta: ProviderOpaqueMeta::default(),
        created_at: "2026-10-30T00:00:01Z".to_string(),
        content: vec![ContentBlock::ToolCall {
            id: "toolu_orphan".to_string(),
            name: "read".to_string(),
            arguments: orphan_args,
            partial_json: None,
            provider_meta: ProviderOpaqueMeta::default(),
        }],
    };
    let u2 = CanonicalMessage {
        id: "u2".to_string(),
        role: MessageRole::User,
        phase: None,
        provider: None,
        api: None,
        model: None,
        stop_reason: None,
        provider_meta: ProviderOpaqueMeta::default(),
        created_at: "2026-10-30T00:00:02Z".to_string(),
        content: vec![ContentBlock::Text {
            text: "Continue".to_string(),
            phase: None,
            citations: vec![],
            provider_meta: ProviderOpaqueMeta::default(),
        }],
    };

    let tools = vec![
        ToolDefinition {
            name: "read".to_string(),
            description: "Read file".to_string(),
            parameters: json!({"type": "object"}),
        },
        ToolDefinition {
            name: "bash".to_string(),
            description: "Run bash".to_string(),
            parameters: json!({"type": "object"}),
        },
    ];

    let budget = StepBudget::new(10_000, None);
    let res = transport
        .stream_step(
            ProviderStepRequest {
                model_id: "claude-sonnet-4-6".to_string(),
                base_url: Some(base_url.clone()),
                api_key: Some("sk-ant-oat01-oauth-token".to_string()),
                extra_headers: HashMap::new(),
                system_prompt: "Custom instructions".to_string(),
                messages: vec![u1, a_orphan, u2.clone()],
                tools: tools.clone(),
                authorized_tool_names: None,
                provider_options: Map::new(),
                continuation: None,
                policy: RequestPolicy::default(),
                turn_id: "turn_ant_oauth".to_string(),
            },
            &budget,
            &mut |_| {},
        )
        .await
        .expect("OAuth parallel tool call succeeds");

    // Verify OAuth tool names mapped back from `Read`/`Bash` -> `read`/`bash`!
    assert_eq!(res.assistant.content.len(), 2);
    assert!(matches!(
        &res.assistant.content[0],
        ContentBlock::ToolCall { id, name, .. } if id == "toolu_a" && name == "read"
    ));
    assert!(matches!(
        &res.assistant.content[1],
        ContentBlock::ToolCall { id, name, .. } if id == "toolu_b" && name == "bash"
    ));

    // Verify mid-stream SSE error after visible text delta does NOT retry!
    let mut events = Vec::new();
    let err = transport
        .stream_step(
            ProviderStepRequest {
                model_id: "claude-sonnet-4-6".to_string(),
                base_url: Some(base_url),
                api_key: Some("sk-ant-api03-key".to_string()),
                extra_headers: HashMap::new(),
                system_prompt: "System".to_string(),
                messages: vec![u2],
                tools,
                authorized_tool_names: None,
                provider_options: Map::new(),
                continuation: None,
                policy: RequestPolicy::default(),
                turn_id: "turn_ant_err".to_string(),
            },
            &budget,
            &mut |ev| events.push(ev),
        )
        .await
        .expect_err("mid-stream overloaded error must not retry after visible text");

    assert!(err.message.contains("Overloaded mid-stream"));
    assert!(events.iter().any(
        |e| matches!(e, StreamEvent::TextDelta { delta, .. } if delta == "Hello before error")
    ));

    let recorded = mock.requests.lock().unwrap();
    assert_eq!(recorded.len(), 2); // No duplicate retry!
    let (h_oauth, p_oauth) = &recorded[0];
    assert_eq!(
        h_oauth.get("authorization").unwrap(),
        "Bearer sk-ant-oat01-oauth-token"
    );
    assert!(h_oauth.get("x-api-key").is_none());
    assert_eq!(
        p_oauth["system"][0]["text"],
        "You are Claude Code, Anthropic's official CLI for Claude."
    );
    // Synthetic error tool_result injected before u2 for orphaned toolu_orphan!
    assert_eq!(p_oauth["messages"][2]["content"][0]["type"], "tool_result");
    assert_eq!(
        p_oauth["messages"][2]["content"][0]["tool_use_id"],
        "toolu_orphan"
    );
    assert_eq!(p_oauth["messages"][2]["content"][0]["is_error"], true);
}
