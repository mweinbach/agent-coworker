//! pi `openai-completions` parity for the Chat Completions transport:
//! - error finish reasons (`content_filter`, `network_error`, unknown) fail the step,
//! - reasoning is replayed under the delta field it streamed in (per provider),
//! - parallel tool calls without `index` are keyed by `id` instead of merging,
//! - cache-read / cache-write usage fields from every provider placement are read.

use std::sync::{Arc, Mutex};

use axum::{
    Router,
    body::Body,
    extract::State,
    http::{StatusCode, header},
    response::Response,
    routing::post,
};
use cowork_config::ProviderName;
use cowork_inference::{
    CanonicalMessage, ContentBlock, MessageRole, ProviderOpaqueMeta, ProviderTransportError,
    RequestPolicy, StepBudget, StopReason, StreamEvent,
};
use cowork_providers::chat_completions::sse_decoder::{
    CHAT_COMPLETIONS_REASONING_FIELD_META_KEY, ChatCompletionsStreamAccumulator,
};
use cowork_providers::chat_completions::{
    ChatCompletionsPayloadOptions, ChatCompletionsTransport, ProviderQuirks,
    build_chat_completions_payload, build_chat_completions_payload_with_options,
};
use cowork_providers::{ProviderStepRequest, ProviderStepResult, ProviderTransport};
use serde_json::{Map, Value, json};

const TURN: &str = "turn-pi";

fn run_chunks(
    provider: ProviderName,
    model: &str,
    split_inline_think: bool,
    chunks: &[Value],
) -> (
    Result<ProviderStepResult, ProviderTransportError>,
    Vec<StreamEvent>,
) {
    let mut events = Vec::new();
    let mut emit = |ev: StreamEvent| events.push(ev);
    let mut acc = ChatCompletionsStreamAccumulator::new(
        provider,
        model.to_string(),
        TURN.to_string(),
        split_inline_think,
        &[],
    );
    for chunk in chunks {
        acc.push_data_frame(&chunk.to_string(), &mut emit)
            .expect("chunk decodes");
    }
    let result = acc.finalize(&mut emit);
    (result, events)
}

fn finish_chunk(reason: &str) -> Value {
    json!({ "id": "chatcmpl-p", "choices": [{ "index": 0, "delta": {}, "finish_reason": reason }] })
}

fn delta_chunk(delta: Value) -> Value {
    json!({ "id": "chatcmpl-p", "choices": [{ "index": 0, "delta": delta }] })
}

fn text_chunk(text: &str) -> Value {
    delta_chunk(json!({ "content": text }))
}

fn thinking_field(result: &ProviderStepResult) -> Option<String> {
    result.assistant.content.iter().find_map(|b| match b {
        ContentBlock::Thinking { provider_meta, .. } => provider_meta
            .extra
            .get(CHAT_COMPLETIONS_REASONING_FIELD_META_KEY)
            .and_then(Value::as_str)
            .map(str::to_owned),
        _ => None,
    })
}

fn tool_calls(result: &ProviderStepResult) -> Vec<(String, String, Map<String, Value>)> {
    result
        .assistant
        .content
        .iter()
        .filter_map(|b| match b {
            ContentBlock::ToolCall {
                id,
                name,
                arguments,
                ..
            } => Some((id.clone(), name.clone(), arguments.clone())),
            _ => None,
        })
        .collect()
}

fn user(text: &str) -> CanonicalMessage {
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
        created_at: "2026-01-01T00:00:00Z".into(),
    }
}

fn thinking_block(text: &str, field: Option<&str>, signature: Option<&str>) -> ContentBlock {
    let mut provider_meta = ProviderOpaqueMeta::default();
    if let Some(field) = field {
        provider_meta.extra.insert(
            CHAT_COMPLETIONS_REASONING_FIELD_META_KEY.into(),
            Value::String(field.into()),
        );
    }
    ContentBlock::Thinking {
        text: text.into(),
        summary: None,
        redacted: false,
        signature: signature.map(str::to_owned),
        provider_meta,
    }
}

fn assistant(provider: ProviderName, model: &str, content: Vec<ContentBlock>) -> CanonicalMessage {
    CanonicalMessage {
        id: "a1".into(),
        role: MessageRole::Assistant,
        content,
        phase: None,
        provider: Some(provider.as_str().into()),
        api: Some("openai-completions".into()),
        model: Some(model.into()),
        stop_reason: Some(StopReason::Stop),
        provider_meta: ProviderOpaqueMeta::default(),
        created_at: "2026-01-01T00:00:01Z".into(),
    }
}

fn payload_assistant(provider: ProviderName, model: &str, messages: &[CanonicalMessage]) -> Value {
    let quirks = ProviderQuirks::for_provider(provider).unwrap();
    let payload = build_chat_completions_payload(&quirks, model, "", messages, &[], &Map::new());
    payload["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["role"] == "assistant")
        .cloned()
        .expect("assistant message in payload")
}

// ---------------------------------------------------------------------------------------------
// 1) Error finish reasons
// ---------------------------------------------------------------------------------------------

#[test]
fn content_filter_finish_reason_is_a_non_retryable_provider_error() {
    let (result, _) = run_chunks(
        ProviderName::Together,
        "m",
        false,
        &[text_chunk("partial"), finish_chunk("content_filter")],
    );
    let err = result.expect_err("content_filter must fail the step");
    assert_eq!(err.message, "Provider finish_reason: content_filter");
    assert!(!err.is_network_transient);
    assert!(
        !err.is_retryable(),
        "TS isTransientProviderError does not match it"
    );
}

#[test]
fn network_error_finish_reason_keeps_ts_retry_classification() {
    let (result, _) = run_chunks(
        ProviderName::Fireworks,
        "m",
        false,
        &[finish_chunk("network_error")],
    );
    let err = result.expect_err("network_error must fail the step");
    assert_eq!(err.message, "Provider finish_reason: network_error");
    // TS: /network error/ (with a space) does not match `network_error`, so runTurn does not retry.
    assert!(!err.is_retryable());
}

#[test]
fn unknown_finish_reasons_fail_even_with_tool_calls() {
    for reason in ["max_tokens", "insufficient_system_resource", "weird"] {
        let (result, _) = run_chunks(
            ProviderName::OpencodeGo,
            "m",
            false,
            &[
                delta_chunk(json!({ "tool_calls": [{
                    "index": 0, "id": "call_a", "type": "function",
                    "function": { "name": "read", "arguments": "{}" }
                }]})),
                finish_chunk(reason),
            ],
        );
        let err = result.expect_err("unknown finish_reason must fail");
        assert_eq!(err.message, format!("Provider finish_reason: {reason}"));
    }
}

#[test]
fn success_finish_reasons_map_like_pi() {
    let cases = [
        ("stop", StopReason::Stop),
        ("end", StopReason::Stop),
        ("length", StopReason::Length),
        ("tool_calls", StopReason::ToolUse),
        ("function_call", StopReason::ToolUse),
    ];
    for (reason, expected) in cases {
        let (result, _) = run_chunks(
            ProviderName::Together,
            "m",
            false,
            &[text_chunk("ok"), finish_chunk(reason)],
        );
        let result = result.unwrap_or_else(|e| panic!("{reason}: {}", e.message));
        assert_eq!(result.assistant.stop_reason, Some(expected), "{reason}");
    }
}

// ---------------------------------------------------------------------------------------------
// 2) Reasoning field recording + replay
// ---------------------------------------------------------------------------------------------

#[test]
fn records_the_reasoning_delta_field_on_the_thinking_block() {
    let cases = [
        (
            ProviderName::Together,
            "reasoning_content",
            "reasoning_content",
        ),
        (ProviderName::Fireworks, "reasoning", "reasoning"),
        (ProviderName::Nvidia, "reasoning_text", "reasoning_text"),
        // opencode-go streams `reasoning` but must replay as `reasoning_content`.
        (ProviderName::OpencodeGo, "reasoning", "reasoning_content"),
        (ProviderName::OpencodeZen, "reasoning", "reasoning"),
    ];
    for (provider, wire_field, expected) in cases {
        let (result, _) = run_chunks(
            provider,
            "m",
            false,
            &[
                delta_chunk(json!({ wire_field: "Think " })),
                delta_chunk(json!({ wire_field: "more." })),
                text_chunk("Answer"),
                finish_chunk("stop"),
            ],
        );
        let result = result.unwrap();
        assert_eq!(
            thinking_field(&result).as_deref(),
            Some(expected),
            "{provider:?} {wire_field}"
        );
    }
}

#[test]
fn first_non_empty_reasoning_field_wins_without_duplication() {
    // chutes.ai-style duplicate fields: `reasoning_content` takes precedence, text is not doubled.
    let (result, _) = run_chunks(
        ProviderName::Together,
        "m",
        false,
        &[
            delta_chunk(json!({ "reasoning_content": "", "reasoning": "R1" })),
            delta_chunk(json!({ "reasoning_content": "C2", "reasoning": "C2" })),
            finish_chunk("stop"),
        ],
    );
    let result = result.unwrap();
    assert_eq!(thinking_field(&result).as_deref(), Some("reasoning"));
    let text = result.assistant.content.iter().find_map(|b| match b {
        ContentBlock::Thinking { text, .. } => Some(text.clone()),
        _ => None,
    });
    assert_eq!(text.as_deref(), Some("R1C2"));
}

#[test]
fn inline_think_tag_reasoning_has_no_replay_field() {
    let (result, _) = run_chunks(
        ProviderName::Minimax,
        "MiniMax-M2",
        true,
        &[
            text_chunk("<think>hidden</think>Visible"),
            finish_chunk("stop"),
        ],
    );
    let result = result.unwrap();
    assert!(
        result
            .assistant
            .content
            .iter()
            .any(|b| matches!(b, ContentBlock::Thinking { .. }))
    );
    assert_eq!(thinking_field(&result), None);
}

#[test]
fn streamed_reasoning_round_trips_under_its_field_for_every_chat_provider() {
    let cases = [
        (
            ProviderName::Together,
            "reasoning_content",
            "reasoning_content",
        ),
        (ProviderName::Fireworks, "reasoning", "reasoning"),
        (
            ProviderName::Firepass,
            "reasoning_content",
            "reasoning_content",
        ),
        (ProviderName::Nvidia, "reasoning", "reasoning"),
        (ProviderName::Minimax, "reasoning_text", "reasoning_text"),
        (
            ProviderName::Lmstudio,
            "reasoning_content",
            "reasoning_content",
        ),
        (ProviderName::OpencodeGo, "reasoning", "reasoning_content"),
        (ProviderName::OpencodeZen, "reasoning", "reasoning"),
        (ProviderName::Baseten, "reasoning", "reasoning"),
    ];
    for (provider, wire_field, replay_field) in cases {
        let model = "glm-5.1";
        let (result, _) = run_chunks(
            provider,
            model,
            false,
            &[
                delta_chunk(json!({ wire_field: "Need to read the file." })),
                delta_chunk(json!({ "tool_calls": [{
                    "index": 0, "id": "call_1", "type": "function",
                    "function": { "name": "read", "arguments": "{\"path\":\"a\"}" }
                }]})),
                finish_chunk("tool_calls"),
            ],
        );
        let result = result.unwrap();
        let assistant_msg = payload_assistant(provider, model, &[user("go"), result.assistant]);
        assert_eq!(
            assistant_msg[replay_field],
            json!("Need to read the file."),
            "{provider:?}: {assistant_msg}"
        );
        for other in ["reasoning_content", "reasoning", "reasoning_text"] {
            if other != replay_field {
                assert!(
                    assistant_msg.get(other).is_none(),
                    "{provider:?} must not send {other}: {assistant_msg}"
                );
            }
        }
        assert_eq!(assistant_msg["tool_calls"][0]["id"], "call_1");
    }
}

#[test]
fn reasoning_from_another_model_or_without_a_field_is_not_replayed() {
    let other_model = assistant(
        ProviderName::Fireworks,
        "other-model",
        vec![thinking_block("old thoughts", Some("reasoning"), None)],
    );
    let msg = payload_assistant(ProviderName::Fireworks, "kimi", &[user("hi"), other_model]);
    assert!(msg.get("reasoning").is_none(), "{msg}");

    let no_field = assistant(
        ProviderName::Lmstudio,
        "qwen",
        vec![thinking_block("split think", None, None)],
    );
    let msg = payload_assistant(ProviderName::Lmstudio, "qwen", &[user("hi"), no_field]);
    for field in ["reasoning_content", "reasoning", "reasoning_text"] {
        assert!(msg.get(field).is_none(), "{msg}");
    }
}

#[test]
fn replay_joins_non_empty_blocks_and_accepts_legacy_pi_signatures() {
    let msg = assistant(
        ProviderName::Together,
        "m",
        vec![
            thinking_block("   ", Some("reasoning"), None),
            // Legacy TS history: pi `thinkingSignature` imported as `signature`.
            thinking_block("first", None, Some("reasoning_text")),
            thinking_block("second", None, None),
        ],
    );
    let wire = payload_assistant(ProviderName::Together, "m", &[user("hi"), msg]);
    assert_eq!(wire["reasoning_text"], json!("first\nsecond"));
    assert!(wire.get("reasoning").is_none());

    // opencode-go forces a legacy `reasoning` signature to `reasoning_content` as well.
    let legacy = assistant(
        ProviderName::OpencodeGo,
        "kimi-k2.6",
        vec![thinking_block("go thoughts", None, Some("reasoning"))],
    );
    let wire = payload_assistant(ProviderName::OpencodeGo, "kimi-k2.6", &[user("hi"), legacy]);
    assert_eq!(wire["reasoning_content"], json!("go thoughts"));
    assert!(wire.get("reasoning").is_none());
}

#[test]
fn deepseek_style_models_always_carry_reasoning_content() {
    // pi catalog compat.requiresReasoningContentOnAssistantMessages models.
    let text_only = |provider: ProviderName, model: &str| {
        assistant(
            provider,
            model,
            vec![ContentBlock::Text {
                text: "hello".into(),
                phase: None,
                citations: Vec::new(),
                provider_meta: ProviderOpaqueMeta::default(),
            }],
        )
    };
    for (provider, model) in [
        (ProviderName::OpencodeGo, "deepseek-v4-pro"),
        (ProviderName::OpencodeZen, "deepseek-v4-flash"),
        (ProviderName::Fireworks, "accounts/fireworks/models/kimi-k3"),
        (ProviderName::Nvidia, "deepseek-ai/deepseek-v4.1-flash"),
    ] {
        let wire = payload_assistant(provider, model, &[user("hi"), text_only(provider, model)]);
        assert_eq!(wire["reasoning_content"], json!(""), "{provider:?} {model}");
    }
    // Real reasoning is kept, not overwritten with "".
    let with_reasoning = assistant(
        ProviderName::OpencodeGo,
        "deepseek-v4-pro",
        vec![thinking_block("deep", Some("reasoning_content"), None)],
    );
    let wire = payload_assistant(
        ProviderName::OpencodeGo,
        "deepseek-v4-pro",
        &[user("hi"), with_reasoning],
    );
    assert_eq!(wire["reasoning_content"], json!("deep"));

    // Models without the compat flag get no empty field.
    let wire = payload_assistant(
        ProviderName::OpencodeGo,
        "glm-5.1",
        &[user("hi"), text_only(ProviderName::OpencodeGo, "glm-5.1")],
    );
    assert!(wire.get("reasoning_content").is_none(), "{wire}");
}

#[test]
fn deepseek_endpoint_detection_matches_pi_detect_compat() {
    assert!(
        ChatCompletionsPayloadOptions::detect(
            ProviderName::Together,
            "any",
            "https://API.DeepSeek.com/v1/chat/completions"
        )
        .requires_reasoning_content_on_assistant_messages
    );
    assert!(
        !ChatCompletionsPayloadOptions::detect(
            ProviderName::Together,
            "deepseek-ai/DeepSeek-V3",
            "https://api.together.xyz/v1/chat/completions"
        )
        .requires_reasoning_content_on_assistant_messages
    );
    let quirks = ProviderQuirks::for_provider(ProviderName::Together).unwrap();
    let payload = build_chat_completions_payload_with_options(
        &quirks,
        "m",
        "",
        &[
            user("hi"),
            assistant(ProviderName::Together, "other", vec![]),
        ],
        &[],
        &Map::new(),
        ChatCompletionsPayloadOptions {
            requires_reasoning_content_on_assistant_messages: true,
        },
    );
    let wire = payload["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["role"] == "assistant")
        .unwrap()
        .clone();
    assert_eq!(wire["reasoning_content"], json!(""));
}

type Captured = Arc<Mutex<Vec<Value>>>;

async fn capture_handler(State(captured): State<Captured>, body: String) -> Response {
    captured
        .lock()
        .unwrap()
        .push(serde_json::from_str(&body).unwrap());
    let sse = format!(
        "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
        text_chunk("ok"),
        finish_chunk("stop")
    );
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .body(Body::from(sse))
        .unwrap()
}

#[tokio::test]
async fn transport_detects_deepseek_endpoint_from_resolved_base_url() {
    let captured: Captured = Arc::new(Mutex::new(Vec::new()));
    let app = Router::new()
        .route("/deepseek.com/v1/chat/completions", post(capture_handler))
        .with_state(captured.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    let transport = ChatCompletionsTransport::new(ProviderName::Together).unwrap();
    let request = ProviderStepRequest {
        model_id: "deepseek-chat".into(),
        base_url: Some(format!("http://{addr}/deepseek.com/v1")),
        api_key: Some("test-key".into()),
        extra_headers: Default::default(),
        system_prompt: String::new(),
        messages: vec![
            user("hi"),
            assistant(
                ProviderName::Together,
                "deepseek-chat",
                vec![ContentBlock::Text {
                    text: "earlier".into(),
                    phase: None,
                    citations: Vec::new(),
                    provider_meta: ProviderOpaqueMeta::default(),
                }],
            ),
            user("again"),
        ],
        tools: Vec::new(),
        authorized_tool_names: None,
        provider_options: Map::new(),
        continuation: None,
        policy: RequestPolicy {
            max_attempts: 1,
            ..RequestPolicy::default()
        },
        turn_id: TURN.into(),
    };
    let budget = StepBudget::new(30_000, None);
    let mut sink = |_ev: StreamEvent| {};
    transport
        .stream_step(request, &budget, &mut sink)
        .await
        .expect("step succeeds");
    let bodies = captured.lock().unwrap();
    let wire = bodies[0]["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["role"] == "assistant")
        .unwrap()
        .clone();
    assert_eq!(wire["reasoning_content"], json!(""));
}

// ---------------------------------------------------------------------------------------------
// 3) Tool calls without `index`
// ---------------------------------------------------------------------------------------------

#[test]
fn parallel_tool_calls_without_index_are_keyed_by_id() {
    let call = |id: &str, name: Option<&str>, args: &str| {
        let mut function = json!({ "arguments": args });
        if let Some(name) = name {
            function["name"] = json!(name);
        }
        delta_chunk(
            json!({ "tool_calls": [{ "id": id, "type": "function", "function": function }] }),
        )
    };
    let (result, events) = run_chunks(
        ProviderName::Together,
        "m",
        false,
        &[
            call("call_a", Some("read"), "{\"path\":"),
            call("call_b", Some("glob"), "{\"pattern\":"),
            call("call_a", None, "\"a.txt\"}"),
            call("call_b", None, "\"*.rs\"}"),
            finish_chunk("tool_calls"),
        ],
    );
    let result = result.unwrap();
    let calls = tool_calls(&result);
    assert_eq!(calls.len(), 2, "{calls:?}");
    assert_eq!(calls[0].0, "call_a");
    assert_eq!(calls[0].1, "read");
    assert_eq!(calls[0].2["path"], json!("a.txt"));
    assert_eq!(calls[1].0, "call_b");
    assert_eq!(calls[1].1, "glob");
    assert_eq!(calls[1].2["pattern"], json!("*.rs"));
    let starts: Vec<_> = events
        .iter()
        .filter_map(|e| match e {
            StreamEvent::ToolCallStart { key, .. } => Some(key.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(starts, vec!["call_a", "call_b"]);
    assert_eq!(result.assistant.stop_reason, Some(StopReason::ToolUse));
}

#[test]
fn indexed_tool_calls_still_merge_continuation_chunks_without_id() {
    let (result, _) = run_chunks(
        ProviderName::Fireworks,
        "m",
        false,
        &[
            delta_chunk(json!({ "tool_calls": [
                { "index": 0, "id": "call_x", "type": "function", "function": { "name": "read", "arguments": "" } },
                { "index": 1, "id": "call_y", "type": "function", "function": { "name": "glob", "arguments": "" } }
            ]})),
            delta_chunk(
                json!({ "tool_calls": [{ "index": 1, "function": { "arguments": "{\"pattern\":\"*\"}" } }]}),
            ),
            delta_chunk(
                json!({ "tool_calls": [{ "index": 0, "function": { "arguments": "{\"path\":\"p\"}" } }]}),
            ),
            finish_chunk("tool_calls"),
        ],
    );
    let calls = tool_calls(&result.unwrap());
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].0, "call_x");
    assert_eq!(calls[0].2["path"], json!("p"));
    assert_eq!(calls[1].0, "call_y");
    assert_eq!(calls[1].2["pattern"], json!("*"));
}

#[test]
fn tool_call_found_by_id_adopts_a_later_stream_index() {
    let (result, _) = run_chunks(
        ProviderName::Nvidia,
        "m",
        false,
        &[
            delta_chunk(
                json!({ "tool_calls": [{ "id": "call_q", "type": "function", "function": { "name": "read", "arguments": "{\"pa" } }]}),
            ),
            delta_chunk(
                json!({ "tool_calls": [{ "index": 3, "id": "call_q", "function": { "arguments": "th\":" } }]}),
            ),
            delta_chunk(
                json!({ "tool_calls": [{ "index": 3, "function": { "arguments": "\"z\"}" } }]}),
            ),
            finish_chunk("tool_calls"),
        ],
    );
    let calls = tool_calls(&result.unwrap());
    assert_eq!(calls.len(), 1, "{calls:?}");
    assert_eq!(calls[0].0, "call_q");
    assert_eq!(calls[0].2["path"], json!("z"));
}

#[test]
fn tool_call_without_index_or_id_allocates_a_new_slot() {
    let (result, _) = run_chunks(
        ProviderName::Together,
        "m",
        false,
        &[
            delta_chunk(
                json!({ "tool_calls": [{ "type": "function", "function": { "name": "read", "arguments": "{}" } }]}),
            ),
            delta_chunk(
                json!({ "tool_calls": [{ "type": "function", "function": { "name": "glob", "arguments": "{}" } }]}),
            ),
            finish_chunk("tool_calls"),
        ],
    );
    let calls = tool_calls(&result.unwrap());
    assert_eq!(calls.len(), 2, "{calls:?}");
    assert_eq!(calls[0].1, "read");
    assert_eq!(calls[1].1, "glob");
    assert_ne!(calls[0].0, calls[1].0, "synthesized ids must be distinct");
}

// ---------------------------------------------------------------------------------------------
// 4) Usage cache fields
// ---------------------------------------------------------------------------------------------

fn usage_of(chunks: &[Value]) -> cowork_inference::TurnUsage {
    let mut all = vec![text_chunk("ok")];
    all.extend_from_slice(chunks);
    let (result, _) = run_chunks(ProviderName::Together, "m", false, &all);
    result.unwrap().usage
}

#[test]
fn reads_deepseek_prompt_cache_hit_tokens() {
    let usage = usage_of(&[json!({
        "id": "chatcmpl-p",
        "choices": [{ "index": 0, "delta": {}, "finish_reason": "stop" }],
        "usage": { "prompt_tokens": 100, "completion_tokens": 7, "total_tokens": 107,
                   "prompt_cache_hit_tokens": 64, "prompt_cache_miss_tokens": 36 }
    })]);
    assert_eq!(usage.prompt_tokens, 100);
    assert_eq!(usage.cached_prompt_tokens, Some(64));
    assert_eq!(usage.cache_write_prompt_tokens, None);
}

#[test]
fn reads_kimi_top_level_cached_tokens() {
    let usage = usage_of(&[json!({
        "id": "chatcmpl-p",
        "choices": [{ "index": 0, "delta": {}, "finish_reason": "stop" }],
        "usage": { "prompt_tokens": 50, "completion_tokens": 5, "total_tokens": 55, "cached_tokens": 40 }
    })]);
    assert_eq!(usage.cached_prompt_tokens, Some(40));
}

#[test]
fn prompt_tokens_details_take_precedence_and_cache_writes_are_recorded() {
    let usage = usage_of(&[json!({
        "id": "chatcmpl-p",
        "choices": [{ "index": 0, "delta": {}, "finish_reason": "stop" }],
        "usage": {
            "prompt_tokens": 200, "completion_tokens": 9, "total_tokens": 209,
            "prompt_cache_hit_tokens": 77, "cached_tokens": 88,
            "prompt_tokens_details": { "cached_tokens": 0, "cache_write_tokens": 150 },
            "completion_tokens_details": { "reasoning_tokens": 4 }
        }
    })]);
    // `??` precedence: an explicit 0 in prompt_tokens_details wins over the fallbacks.
    assert_eq!(usage.cached_prompt_tokens, Some(0));
    assert_eq!(usage.cache_write_prompt_tokens, Some(150));
    assert_eq!(usage.reasoning_output_tokens, Some(4));
}

#[test]
fn reads_moonshot_choice_level_usage_only_when_chunk_usage_is_absent() {
    let usage = usage_of(&[json!({
        "id": "chatcmpl-p",
        "choices": [{ "index": 0, "delta": {}, "finish_reason": "stop",
                      "usage": { "prompt_tokens": 30, "completion_tokens": 3, "total_tokens": 33,
                                 "cached_tokens": 12 } }]
    })]);
    assert_eq!(usage.prompt_tokens, 30);
    assert_eq!(usage.completion_tokens, 3);
    assert_eq!(usage.cached_prompt_tokens, Some(12));

    let usage = usage_of(&[json!({
        "id": "chatcmpl-p",
        "choices": [{ "index": 0, "delta": {}, "finish_reason": "stop",
                      "usage": { "prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2 } }],
        "usage": { "prompt_tokens": 40, "completion_tokens": 4, "total_tokens": 44 }
    })]);
    assert_eq!(usage.prompt_tokens, 40);
    assert_eq!(usage.completion_tokens, 4);
}
