//! Bedrock Converse stream hardening (TS `bedrockProviderModule.ts` / pi parity):
//! - truncated streams (no `messageStop`, open content blocks, partial EventStream frame) fail
//!   as retryable errors instead of returning partial output;
//! - tool input cut off by `max_tokens` is never repaired into an executable call;
//! - `guardrail_intervened` / `content_filtered` stop reasons fail the turn (non-retryable);
//! - prompt usage includes cache read/write tokens;
//! - `cachePoint` blocks and thinking-signature replay rules in the request body.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Body;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::Response;
use axum::routing::post;
use cowork_inference::{
    CanonicalMessage, ContentBlock, MessageRole, ProviderOpaqueMeta, ProviderTransportError,
    RequestPolicy, StepBudget, StopReason, StreamEvent,
};
use cowork_providers::bedrock::{
    BedrockAuthConfig, BedrockAuthMethod, BedrockConverseTransport, build_converse_request_body,
    encode_eventstream_json_frame,
};
use cowork_providers::{ProviderStepRequest, ProviderStepResult, ProviderTransport};
use serde_json::{Map, Value, json};
use tokio::net::TcpListener;

#[derive(Default)]
struct MockState {
    replies: Vec<Vec<u8>>,
    bodies: Vec<Value>,
}

type Shared = Arc<Mutex<MockState>>;

async fn handle(State(state): State<Shared>, body: String) -> Response {
    let mut guard = state.lock().unwrap();
    guard
        .bodies
        .push(serde_json::from_str(&body).unwrap_or(Value::Null));
    let bytes = guard.replies.remove(0);
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/vnd.amazon.eventstream")
        .body(Body::from(bytes))
        .unwrap()
}

async fn spawn_mock(replies: Vec<Vec<u8>>) -> (String, Shared) {
    let state: Shared = Arc::new(Mutex::new(MockState {
        replies,
        bodies: Vec::new(),
    }));
    let app = Router::new()
        .route("/model/{model_id}/converse-stream", post(handle))
        .with_state(state.clone());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("http://{addr}"), state)
}

fn frames(events: &[(&str, Value)]) -> Vec<u8> {
    let mut out = Vec::new();
    for (event_type, payload) in events {
        out.extend_from_slice(&encode_eventstream_json_frame(event_type, payload).unwrap());
    }
    out
}

fn text_message(role: MessageRole, text: &str) -> CanonicalMessage {
    CanonicalMessage {
        id: "m".into(),
        role,
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
        created_at: "2026-11-01T00:00:00Z".into(),
    }
}

const MODEL: &str = "us.anthropic.claude-sonnet-4-6-v1:0";

async fn run_step(
    base_url: &str,
    events: &mut Vec<StreamEvent>,
) -> Result<ProviderStepResult, ProviderTransportError> {
    let transport = BedrockConverseTransport::with_auth(BedrockAuthConfig {
        method_id: "api_key".into(),
        source: "test".into(),
        region: "us-east-1".into(),
        has_configured_region: false,
        has_configured_profile: false,
        auth: BedrockAuthMethod::BearerToken {
            token: "ABSK-test".into(),
        },
    });
    // Single attempt so a retryable failure surfaces directly instead of consuming later replies.
    let policy = RequestPolicy {
        max_attempts: 1,
        ..RequestPolicy::default()
    };
    transport
        .stream_step(
            ProviderStepRequest {
                model_id: MODEL.into(),
                base_url: Some(base_url.to_string()),
                api_key: None,
                extra_headers: HashMap::new(),
                system_prompt: "System".into(),
                messages: vec![text_message(MessageRole::User, "delete the temp files")],
                tools: Vec::new(),
                authorized_tool_names: None,
                provider_options: Map::new(),
                continuation: None,
                policy,
                turn_id: "turn-bdrk-hard".into(),
            },
            &StepBudget::new(10_000, None),
            &mut |ev| events.push(ev),
        )
        .await
}

fn text_delta(idx: usize, text: &str) -> (&'static str, Value) {
    (
        "contentBlockDelta",
        json!({ "contentBlockIndex": idx, "delta": { "text": text } }),
    )
}

fn block_stop(idx: usize) -> (&'static str, Value) {
    ("contentBlockStop", json!({ "contentBlockIndex": idx }))
}

fn tool_start(idx: usize, id: &str, name: &str) -> (&'static str, Value) {
    (
        "contentBlockStart",
        json!({
            "contentBlockIndex": idx,
            "start": { "toolUse": { "toolUseId": id, "name": name } }
        }),
    )
}

fn tool_delta(idx: usize, input: &str) -> (&'static str, Value) {
    (
        "contentBlockDelta",
        json!({ "contentBlockIndex": idx, "delta": { "toolUse": { "input": input } } }),
    )
}

fn message_start() -> (&'static str, Value) {
    ("messageStart", json!({ "role": "assistant" }))
}

fn message_stop(reason: &str) -> (&'static str, Value) {
    ("messageStop", json!({ "stopReason": reason }))
}

#[tokio::test]
async fn truncated_bedrock_streams_are_retryable_errors() {
    // 1. Clean EOF without messageStop (text block finished).
    let no_message_stop = frames(&[message_start(), text_delta(0, "Cleaning."), block_stop(0)]);
    // 2. messageStop arrives but a content block was never closed.
    let open_block = frames(&[
        message_start(),
        text_delta(0, "Cleaning."),
        block_stop(0),
        tool_start(1, "toolu_rm", "bash"),
        tool_delta(1, "{\"command\":\"rm -rf /tmp/x\"}"),
        message_stop("tool_use"),
    ]);
    // 3. Complete message, then the stream is cut mid-way through the metadata frame.
    let mut partial_frame = frames(&[
        message_start(),
        text_delta(0, "Done."),
        block_stop(0),
        message_stop("end_turn"),
    ]);
    let metadata = frames(&[(
        "metadata",
        json!({ "usage": { "inputTokens": 5, "outputTokens": 2 } }),
    )]);
    partial_frame.extend_from_slice(&metadata[..metadata.len() / 2]);

    let (base, _state) = spawn_mock(vec![no_message_stop, open_block, partial_frame]).await;

    let mut events = Vec::new();
    let err = run_step(&base, &mut events).await.unwrap_err();
    assert_eq!(err.message, "Bedrock stream ended before messageStop.");
    assert!(err.is_retryable());

    let mut events = Vec::new();
    let err = run_step(&base, &mut events).await.unwrap_err();
    assert_eq!(err.message, "Bedrock stream ended before contentBlockStop.");
    assert!(err.is_retryable());
    // The unfinished tool call must never have been finalized.
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, StreamEvent::ToolCallEnd { .. }))
    );

    let mut events = Vec::new();
    let err = run_step(&base, &mut events).await.unwrap_err();
    assert_eq!(
        err.message,
        "Bedrock stream ended with an incomplete EventStream frame."
    );
    assert!(err.is_retryable());
}

#[tokio::test]
async fn max_tokens_tool_input_is_not_repaired_but_normal_stops_still_are() {
    // Tool input cut off by max_tokens: strict parse fails -> error, no executable call.
    let truncated = frames(&[
        message_start(),
        tool_start(0, "toolu_rm", "bash"),
        tool_delta(0, "{\"command\":\"rm -rf /tmp/build"),
        block_stop(0),
        message_stop("max_tokens"),
    ]);
    // Same truncated JSON under a normal tool_use stop keeps the TS-parity lenient repair.
    let repaired = frames(&[
        message_start(),
        tool_start(0, "toolu_ls", "list_dir"),
        tool_delta(0, "{\"dir\":\"src\""),
        block_stop(0),
        message_stop("tool_use"),
    ]);
    // max_tokens with complete tool JSON is fine.
    let complete = frames(&[
        message_start(),
        tool_start(0, "toolu_ok", "list_dir"),
        tool_delta(0, "{\"dir\":\".\"}"),
        block_stop(0),
        message_stop("max_tokens"),
    ]);
    let (base, _state) = spawn_mock(vec![truncated, repaired, complete]).await;

    let mut events = Vec::new();
    let err = run_step(&base, &mut events).await.unwrap_err();
    assert_eq!(
        err.message,
        "Bedrock stream ended with incomplete tool call arguments."
    );
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, StreamEvent::ToolCallEnd { .. }))
    );

    let mut events = Vec::new();
    let res = run_step(&base, &mut events).await.unwrap();
    assert_eq!(res.assistant.stop_reason, Some(StopReason::ToolUse));
    let ContentBlock::ToolCall { arguments, .. } = &res.assistant.content[0] else {
        panic!("expected tool call, got {:?}", res.assistant.content);
    };
    assert_eq!(arguments.get("dir"), Some(&json!("src")));
    assert!(events.iter().any(|e| matches!(
        e,
        StreamEvent::ToolCallEnd { key, .. } if key == "toolu_ls"
    )));

    let mut events = Vec::new();
    let res = run_step(&base, &mut events).await.unwrap();
    let ContentBlock::ToolCall { arguments, .. } = &res.assistant.content[0] else {
        panic!("expected tool call, got {:?}", res.assistant.content);
    };
    assert_eq!(arguments.get("dir"), Some(&json!(".")));
}

#[tokio::test]
async fn guardrail_and_content_filter_stop_reasons_fail_the_turn() {
    let guardrail = frames(&[
        message_start(),
        text_delta(0, "Partial"),
        block_stop(0),
        message_stop("guardrail_intervened"),
        (
            "metadata",
            json!({ "usage": { "inputTokens": 5, "outputTokens": 1 } }),
        ),
    ]);
    let filtered = frames(&[
        message_start(),
        text_delta(0, "Partial"),
        block_stop(0),
        message_stop("content_filtered"),
    ]);
    let unknown = frames(&[
        message_start(),
        text_delta(0, "Partial"),
        block_stop(0),
        ("messageStop", json!({})),
    ]);
    let (base, _state) = spawn_mock(vec![guardrail, filtered, unknown]).await;

    let mut events = Vec::new();
    let err = run_step(&base, &mut events).await.unwrap_err();
    assert!(
        err.message.starts_with("An unknown error occurred"),
        "{}",
        err.message
    );
    assert!(err.message.contains("guardrail"), "{}", err.message);
    assert!(!err.is_retryable());

    let mut events = Vec::new();
    let err = run_step(&base, &mut events).await.unwrap_err();
    assert!(err.message.starts_with("An unknown error occurred"));
    assert!(err.message.contains("content_filtered"), "{}", err.message);
    assert!(!err.is_retryable());

    let mut events = Vec::new();
    let err = run_step(&base, &mut events).await.unwrap_err();
    assert!(err.message.starts_with("An unknown error occurred"));
    assert!(!err.is_retryable());
}

#[tokio::test]
async fn usage_includes_cache_tokens_and_request_carries_cache_points() {
    let reply = frames(&[
        message_start(),
        text_delta(0, "Hi."),
        block_stop(0),
        message_stop("end_turn"),
        (
            "metadata",
            json!({
                "usage": {
                    "inputTokens": 120,
                    "outputTokens": 45,
                    "totalTokens": 205,
                    "cacheReadInputTokens": 30,
                    "cacheWriteInputTokens": 10
                }
            }),
        ),
    ]);
    let (base, state) = spawn_mock(vec![reply]).await;
    let mut events = Vec::new();
    let res = run_step(&base, &mut events).await.unwrap();
    assert_eq!(res.assistant.stop_reason, Some(StopReason::Stop));
    assert_eq!(res.usage.prompt_tokens, 160);
    assert_eq!(res.usage.completion_tokens, 45);
    assert_eq!(res.usage.total_tokens, 205);
    assert_eq!(res.usage.cached_prompt_tokens, Some(30));
    assert_eq!(res.usage.cache_write_prompt_tokens, Some(10));

    let bodies = &state.lock().unwrap().bodies;
    let body = &bodies[0];
    assert_eq!(
        body["system"],
        json!([{ "text": "System" }, { "cachePoint": { "type": "default" } }])
    );
    let last = body["messages"].as_array().unwrap().last().unwrap();
    assert_eq!(last["role"], "user");
    assert_eq!(
        last["content"].as_array().unwrap().last().unwrap(),
        &json!({ "cachePoint": { "type": "default" } })
    );
}

fn cache_points(body: &Value) -> usize {
    let count = |v: &Value| {
        v.as_array()
            .map(|a| a.iter().filter(|b| b.get("cachePoint").is_some()).count())
            .unwrap_or(0)
    };
    count(&body["system"])
        + body["messages"]
            .as_array()
            .map(|msgs| msgs.iter().map(|m| count(&m["content"])).sum())
            .unwrap_or(0)
}

#[test]
fn cache_points_follow_ts_model_predicate_and_retention() {
    let user = [text_message(MessageRole::User, "hello")];
    let empty = Map::new();

    for model in [
        "us.anthropic.claude-sonnet-4-6-v1:0",
        "anthropic.claude-opus-4-1-20250805-v1:0",
        "anthropic.claude-3-7-sonnet-20250219-v1:0",
        "anthropic.claude-3-5-haiku-20241022-v1:0",
    ] {
        let body = build_converse_request_body(model, "Sys", &user, &[], &empty);
        assert_eq!(cache_points(&body), 2, "{model}: {body}");
    }
    for model in [
        "anthropic.claude-3-5-sonnet-20240620-v1:0",
        "amazon.nova-pro-v1:0",
        "meta.llama3-70b-instruct-v1:0",
    ] {
        let body = build_converse_request_body(model, "Sys", &user, &[], &empty);
        assert_eq!(cache_points(&body), 0, "{model}: {body}");
    }

    let mut long = Map::new();
    long.insert("bedrock".into(), json!({ "cacheRetention": "long" }));
    let body = build_converse_request_body(MODEL, "Sys", &user, &[], &long);
    assert_eq!(
        body["system"][1],
        json!({ "cachePoint": { "type": "default", "ttl": "1h" } })
    );
    assert_eq!(
        body["messages"][0]["content"][1],
        json!({ "cachePoint": { "type": "default", "ttl": "1h" } })
    );

    let mut none = Map::new();
    none.insert("cacheRetention".into(), json!("none"));
    let body = build_converse_request_body(MODEL, "Sys", &user, &[], &none);
    assert_eq!(cache_points(&body), 0);

    // Trailing assistant turn: only the system prompt gets a cache point.
    let convo = [
        text_message(MessageRole::User, "hello"),
        text_message(MessageRole::Assistant, "hi"),
    ];
    let body = build_converse_request_body(MODEL, "Sys", &convo, &[], &empty);
    assert_eq!(cache_points(&body), 1);
    assert!(body["system"][1].get("cachePoint").is_some());
}

fn thinking_message(
    provider: Option<&str>,
    model: Option<&str>,
    blocks: Vec<ContentBlock>,
) -> CanonicalMessage {
    CanonicalMessage {
        id: "a1".into(),
        role: MessageRole::Assistant,
        content: blocks,
        phase: None,
        provider: provider.map(str::to_string),
        api: provider.map(|p| {
            if p == "bedrock" {
                "bedrock-converse-stream".to_string()
            } else {
                "other-api".to_string()
            }
        }),
        model: model.map(str::to_string),
        stop_reason: Some(StopReason::Stop),
        provider_meta: ProviderOpaqueMeta::default(),
        created_at: "2026-11-01T00:00:00Z".into(),
    }
}

fn signed_thinking(text: &str, sig: &str) -> ContentBlock {
    ContentBlock::Thinking {
        text: text.into(),
        summary: None,
        redacted: false,
        signature: Some(sig.into()),
        provider_meta: ProviderOpaqueMeta {
            anthropic_thinking_signature: Some(sig.into()),
            ..Default::default()
        },
    }
}

fn redacted_thinking(data: &str) -> ContentBlock {
    ContentBlock::Thinking {
        text: String::new(),
        summary: None,
        redacted: true,
        signature: None,
        provider_meta: ProviderOpaqueMeta {
            anthropic_redacted_thinking: Some(data.into()),
            ..Default::default()
        },
    }
}

fn assistant_content(model_id: &str, msg: CanonicalMessage) -> Value {
    let body = build_converse_request_body(
        model_id,
        "",
        &[text_message(MessageRole::User, "hi"), msg],
        &[],
        &Map::new(),
    );
    body["messages"][1]["content"].clone()
}

#[test]
fn thinking_signatures_only_replay_to_the_same_claude_model() {
    // Same Bedrock Claude model: signed reasoning and redacted reasoning replay natively.
    let same = assistant_content(
        MODEL,
        thinking_message(
            Some("bedrock"),
            Some(MODEL),
            vec![
                signed_thinking("plan", "sig-bdrk"),
                redacted_thinking("cmVkYWN0ZWQ="),
            ],
        ),
    );
    assert_eq!(
        same,
        json!([
            { "reasoningContent": { "reasoningText": { "text": "plan", "signature": "sig-bdrk" } } },
            { "reasoningContent": { "redactedContent": "cmVkYWN0ZWQ=" } }
        ])
    );

    // Same Claude model but unsigned reasoning: visible text, never an unsigned reasoning block.
    let unsigned = assistant_content(
        MODEL,
        thinking_message(
            Some("bedrock"),
            Some(MODEL),
            vec![ContentBlock::Thinking {
                text: "unsigned plan".into(),
                summary: None,
                redacted: false,
                signature: None,
                provider_meta: ProviderOpaqueMeta::default(),
            }],
        ),
    );
    assert_eq!(unsigned, json!([{ "text": "unsigned plan" }]));

    // Foreign provider (OpenAI Responses reasoning whose JSON lives in `signature`): text only,
    // redacted payload dropped.
    let foreign = assistant_content(
        MODEL,
        thinking_message(
            Some("openai"),
            Some("gpt-5.4"),
            vec![
                signed_thinking("openai plan", "{\"type\":\"reasoning\"}"),
                redacted_thinking("b3BhcXVl"),
            ],
        ),
    );
    assert_eq!(foreign, json!([{ "text": "openai plan" }]));

    // Another Bedrock model: also foreign.
    let other_model = assistant_content(
        MODEL,
        thinking_message(
            Some("bedrock"),
            Some("us.anthropic.claude-opus-4-6-v1:0"),
            vec![signed_thinking("opus plan", "sig-opus")],
        ),
    );
    assert_eq!(other_model, json!([{ "text": "opus plan" }]));

    // Untagged history is never trusted as signed reasoning.
    let untagged = assistant_content(
        MODEL,
        thinking_message(None, None, vec![signed_thinking("legacy", "sig-legacy")]),
    );
    assert_eq!(untagged, json!([{ "text": "legacy" }]));

    // Non-Claude Bedrock model: same-model reasoning replays without a signature.
    let nova = "amazon.nova-premier-v1:0";
    let non_claude = assistant_content(
        nova,
        thinking_message(
            Some("bedrock"),
            Some(nova),
            vec![signed_thinking("nova plan", "sig-nova")],
        ),
    );
    assert_eq!(
        non_claude,
        json!([{ "reasoningContent": { "reasoningText": { "text": "nova plan" } } }])
    );
}
