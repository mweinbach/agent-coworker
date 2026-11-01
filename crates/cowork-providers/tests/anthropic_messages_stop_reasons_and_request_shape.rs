//! Anthropic Messages parity with the TS runtime (pi-ai 1.0.1 `anthropic-messages.js`):
//!
//! - A tool_use cut off by `stop_reason: max_tokens` (Anthropic still sends `content_block_stop`
//!   first) must fail as a retryable incomplete stream, never be repaired into an executable call.
//! - `refusal` / `sensitive` stops fail the step with pi's error message instead of returning Ok.
//! - Request bodies use pi's per-model `maxTokens` and thinking shape (force-adaptive for 4.6+).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::{
    Json, Router,
    body::Body,
    extract::State,
    http::{HeaderMap, StatusCode, header},
    response::Response,
    routing::post,
};
use cowork_inference::{
    CanonicalMessage, ContentBlock, MessageRole, ProviderOpaqueMeta, ProviderTransportError,
    RequestPolicy, StepBudget, StopReason, StreamEvent,
};
use cowork_providers::{
    AnthropicMessagesTransport, ProviderStepRequest, ProviderStepResult, ProviderTransport,
    ToolDefinition,
};
use serde_json::{Map, Value, json};

#[derive(Clone)]
struct MockState {
    reply: Arc<String>,
    requests: Arc<Mutex<Vec<(HeaderMap, Value)>>>,
}

async fn handle(
    State(state): State<MockState>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Response {
    state.requests.lock().unwrap().push((headers, payload));
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .body(Body::from(state.reply.as_str().to_owned()))
        .unwrap()
}

/// Serves the same SSE body for every request and records each request.
async fn spawn_mock(reply: String) -> (String, MockState) {
    let state = MockState {
        reply: Arc::new(reply),
        requests: Arc::new(Mutex::new(Vec::new())),
    };
    let app = Router::new()
        .route("/v1/messages", post(handle))
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("http://{addr}"), state)
}

fn sse(events: &[Value]) -> String {
    events
        .iter()
        .map(|e| format!("event: {}\ndata: {e}\n\n", e["type"].as_str().unwrap()))
        .collect()
}

fn user_message(text: &str) -> CanonicalMessage {
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
        created_at: "2026-11-01T00:00:00Z".into(),
    }
}

fn bash_tool() -> ToolDefinition {
    ToolDefinition {
        name: "bash".into(),
        description: "Run a shell command".into(),
        parameters: json!({
            "type": "object",
            "properties": { "command": { "type": "string" } },
            "required": ["command"]
        }),
    }
}

async fn run_step(
    base_url: &str,
    model_id: &str,
    provider_options: Map<String, Value>,
    tools: Vec<ToolDefinition>,
    events: &mut Vec<StreamEvent>,
) -> Result<ProviderStepResult, ProviderTransportError> {
    // Single attempt so a retryable failure surfaces directly instead of being retried.
    let policy = RequestPolicy {
        max_attempts: 1,
        ..RequestPolicy::default()
    };
    AnthropicMessagesTransport::new()
        .stream_step(
            ProviderStepRequest {
                model_id: model_id.into(),
                base_url: Some(base_url.to_string()),
                api_key: Some("sk-ant-api03-key".into()),
                extra_headers: HashMap::new(),
                system_prompt: "System".into(),
                messages: vec![user_message("clean the build cache")],
                tools,
                authorized_tool_names: None,
                provider_options,
                continuation: None,
                policy,
                turn_id: "turn-a-stop".into(),
            },
            &StepBudget::new(10_000, None),
            &mut |ev| events.push(ev),
        )
        .await
}

fn message_start() -> Value {
    json!({
        "type": "message_start",
        "message": { "id": "msg_s1", "usage": { "input_tokens": 10, "output_tokens": 0 } }
    })
}

fn tool_use_events(index: usize, id: &str, chunks: &[&str]) -> Vec<Value> {
    let mut out = vec![json!({
        "type": "content_block_start",
        "index": index,
        "content_block": { "type": "tool_use", "id": id, "name": "bash", "input": {} }
    })];
    for chunk in chunks {
        out.push(json!({
            "type": "content_block_delta",
            "index": index,
            "delta": { "type": "input_json_delta", "partial_json": chunk }
        }));
    }
    out.push(json!({ "type": "content_block_stop", "index": index }));
    out
}

fn message_end(stop_reason: &str, stop_details: Option<Value>) -> Vec<Value> {
    let mut delta = json!({ "stop_reason": stop_reason });
    if let Some(details) = stop_details {
        delta["stop_details"] = details;
    }
    vec![
        json!({ "type": "message_delta", "delta": delta, "usage": { "output_tokens": 7 } }),
        json!({ "type": "message_stop" }),
    ]
}

fn tool_call_ends(events: &[StreamEvent]) -> Vec<(String, Option<Map<String, Value>>)> {
    events
        .iter()
        .filter_map(|ev| match ev {
            StreamEvent::ToolCallEnd { key, arguments, .. } => {
                Some((key.clone(), arguments.clone()))
            }
            _ => None,
        })
        .collect()
}

fn tool_calls(result: &ProviderStepResult) -> Vec<(String, Map<String, Value>)> {
    result
        .assistant
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::ToolCall { id, arguments, .. } => Some((id.clone(), arguments.clone())),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn max_tokens_with_truncated_tool_use_is_a_retryable_error_without_tool_call_end() {
    let mut frames = vec![message_start()];
    frames.extend(tool_use_events(
        0,
        "toolu_rm",
        &["{\"command\":", "\"rm -rf build/cache/old"],
    ));
    frames.extend(message_end("max_tokens", None));
    let (base_url, _) = spawn_mock(sse(&frames)).await;

    let mut events = Vec::new();
    let err = run_step(
        &base_url,
        "claude-sonnet-4-5",
        Map::new(),
        vec![bash_tool()],
        &mut events,
    )
    .await
    .expect_err("a tool_use truncated by max_tokens must not succeed");

    assert_eq!(
        err.message,
        "Anthropic stream ended with incomplete tool call arguments."
    );
    assert!(err.is_network_transient);
    assert!(err.is_retryable());
    assert!(
        tool_call_ends(&events).is_empty(),
        "a truncated tool call must never be finalized: {events:?}"
    );
}

#[tokio::test]
async fn max_tokens_after_complete_tool_use_still_returns_the_tool_call() {
    // A complete tool call followed by a truncated one: the whole step fails, so neither runs.
    let mut frames = vec![message_start()];
    frames.extend(tool_use_events(0, "toolu_ok", &["{\"command\":\"ls\"}"]));
    frames.extend(tool_use_events(
        1,
        "toolu_cut",
        &["{\"command\":\"rm -rf bu"],
    ));
    frames.extend(message_end("max_tokens", None));
    let (base_url, _) = spawn_mock(sse(&frames)).await;
    let mut events = Vec::new();
    let err = run_step(
        &base_url,
        "claude-sonnet-4-5",
        Map::new(),
        vec![bash_tool()],
        &mut events,
    )
    .await
    .expect_err("one truncated tool call fails the step");
    assert!(err.is_retryable());
    assert!(
        tool_call_ends(&events)
            .iter()
            .all(|(key, _)| key != "toolu_cut"),
        "the truncated call must not be finalized: {events:?}"
    );

    // Only complete tool calls: TS kept them on a `length` stop, so the step succeeds.
    let mut frames = vec![message_start()];
    frames.extend(tool_use_events(
        0,
        "toolu_ok",
        &["{\"command\":", "\"ls build\"}"],
    ));
    frames.extend(message_end("max_tokens", None));
    let (base_url, _) = spawn_mock(sse(&frames)).await;
    let mut events = Vec::new();
    let result = run_step(
        &base_url,
        "claude-sonnet-4-5",
        Map::new(),
        vec![bash_tool()],
        &mut events,
    )
    .await
    .expect("complete tool input on max_tokens is kept");

    assert_eq!(result.assistant.stop_reason, Some(StopReason::Length));
    let calls = tool_calls(&result);
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].0, "toolu_ok");
    assert_eq!(calls[0].1["command"], "ls build");
    let ends = tool_call_ends(&events);
    assert_eq!(ends.len(), 1);
    assert_eq!(ends[0].1.as_ref().unwrap()["command"], "ls build");
}

#[tokio::test]
async fn normal_tool_use_stop_still_repairs_non_strict_tool_input() {
    let mut frames = vec![message_start()];
    frames.extend(tool_use_events(0, "toolu_fix", &["{\"command\":\"ls\""]));
    frames.extend(message_end("tool_use", None));
    let (base_url, _) = spawn_mock(sse(&frames)).await;

    let mut events = Vec::new();
    let result = run_step(
        &base_url,
        "claude-sonnet-4-5",
        Map::new(),
        vec![bash_tool()],
        &mut events,
    )
    .await
    .expect("a normal tool_use stop keeps the lenient repair");

    assert_eq!(result.assistant.stop_reason, Some(StopReason::ToolUse));
    let calls = tool_calls(&result);
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].1["command"], "ls");
    let ends = tool_call_ends(&events);
    assert_eq!(ends.len(), 1);
    assert_eq!(ends[0].0, "toolu_fix");
    assert_eq!(ends[0].1.as_ref().unwrap()["command"], "ls");
}

#[tokio::test]
async fn refusal_and_sensitive_stops_are_non_retryable_errors() {
    let text_block = |text: &str| {
        vec![
            json!({
                "type": "content_block_start",
                "index": 0,
                "content_block": { "type": "text", "text": "" }
            }),
            json!({
                "type": "content_block_delta",
                "index": 0,
                "delta": { "type": "text_delta", "text": text }
            }),
            json!({ "type": "content_block_stop", "index": 0 }),
        ]
    };
    let cases: [(&str, Option<Value>, &str); 3] = [
        ("refusal", None, "The model refused to complete the request"),
        (
            "refusal",
            Some(json!({ "type": "refusal", "explanation": "Declined for safety." })),
            "Declined for safety.",
        ),
        ("sensitive", None, "Provider stopped with: sensitive"),
    ];
    for (stop_reason, details, expected) in cases {
        let mut frames = vec![message_start()];
        frames.extend(text_block("I can't"));
        frames.extend(message_end(stop_reason, details));
        let (base_url, _) = spawn_mock(sse(&frames)).await;

        let mut events = Vec::new();
        let err = run_step(
            &base_url,
            "claude-sonnet-4-5",
            Map::new(),
            Vec::new(),
            &mut events,
        )
        .await
        .expect_err("an error stop reason must fail the step");
        assert_eq!(err.message, expected);
        assert!(!err.is_retryable(), "{stop_reason} must not be retried");
    }
}

/// `(max_tokens, thinking, output_config, anthropic-beta)` as sent on the wire.
async fn request_shape(model_id: &str, provider_options: Value) -> Value {
    let mut frames = vec![message_start()];
    frames.extend(message_end("end_turn", None));
    let (base_url, mock) = spawn_mock(sse(&frames)).await;
    let mut events = Vec::new();
    run_step(
        &base_url,
        model_id,
        provider_options.as_object().cloned().unwrap_or_default(),
        Vec::new(),
        &mut events,
    )
    .await
    .unwrap_or_else(|err| panic!("{model_id} step failed: {err:?}"));
    let requests = mock.requests.lock().unwrap();
    let (headers, body) = &requests[0];
    json!({
        "max_tokens": body["max_tokens"],
        "thinking": body.get("thinking").cloned().unwrap_or(Value::Null),
        "output_config": body.get("output_config").cloned().unwrap_or(Value::Null),
        "betas": headers
            .get("anthropic-beta")
            .map(|v| v.to_str().unwrap().to_string()),
    })
}

#[tokio::test]
async fn request_bodies_match_pi_per_model_family() {
    // Catalog defaults from `config/models/anthropic/*.json`.
    let budget_defaults = json!({
        "thinking": { "type": "enabled", "budgetTokens": 32000 },
        "disableParallelToolUse": true
    });
    let adaptive_defaults = json!({
        "thinking": { "type": "adaptive" },
        "effort": "high",
        "disableParallelToolUse": true
    });

    let budget_shape = json!({
        "max_tokens": 64000,
        "thinking": { "type": "enabled", "budget_tokens": 32000, "display": "summarized" },
        "output_config": null,
        "betas": "interleaved-thinking-2025-05-14",
    });
    for model in ["claude-haiku-4-5", "claude-sonnet-4-5"] {
        assert_eq!(
            request_shape(model, budget_defaults.clone()).await,
            budget_shape,
            "{model}"
        );
    }

    // pi `forceAdaptiveThinking`: the budget config becomes adaptive, no interleaved beta, and no
    // effort unless one is configured.
    let forced_adaptive_shape = json!({
        "max_tokens": 128000,
        "thinking": { "type": "adaptive", "display": "summarized" },
        "output_config": null,
        "betas": null,
    });
    for model in ["claude-opus-4-6", "claude-sonnet-4-6"] {
        assert_eq!(
            request_shape(model, budget_defaults.clone()).await,
            forced_adaptive_shape,
            "{model}"
        );
    }

    let adaptive_shape = json!({
        "max_tokens": 128000,
        "thinking": { "type": "adaptive", "display": "summarized" },
        "output_config": { "effort": "high" },
        "betas": null,
    });
    for model in ["claude-opus-4-7", "claude-opus-4-8"] {
        assert_eq!(
            request_shape(model, adaptive_defaults.clone()).await,
            adaptive_shape,
            "{model}"
        );
    }
}

#[tokio::test]
async fn request_bodies_follow_ts_option_handling() {
    // No thinking config: TS sent no `thinking` (and no effort) even for adaptive models.
    assert_eq!(
        request_shape("claude-opus-4-7", json!({ "effort": "high" })).await,
        json!({ "max_tokens": 128000, "thinking": null, "output_config": null, "betas": null })
    );
    // `thinking.type: disabled` sends nothing.
    assert_eq!(
        request_shape(
            "claude-haiku-4-5",
            json!({ "thinking": { "type": "disabled" } })
        )
        .await,
        json!({ "max_tokens": 64000, "thinking": null, "output_config": null, "betas": null })
    );
    // `enabled` without a budget uses pi's 1024 fallback; `interleavedThinking: false` drops the beta.
    assert_eq!(
        request_shape(
            "claude-sonnet-4-5",
            json!({ "thinking": { "type": "enabled" }, "interleavedThinking": false })
        )
        .await,
        json!({
            "max_tokens": 64000,
            "thinking": { "type": "enabled", "budget_tokens": 1024, "display": "summarized" },
            "output_config": null,
            "betas": null,
        })
    );
    // Options nested under `anthropic` and an explicit `maxTokens` cap (pi `options.maxTokens`).
    assert_eq!(
        request_shape(
            "claude-opus-4-6",
            json!({ "anthropic": { "thinking": { "type": "adaptive" }, "effort": "low", "maxTokens": 20000 } })
        )
        .await,
        json!({
            "max_tokens": 20000,
            "thinking": { "type": "adaptive", "display": "summarized" },
            "output_config": { "effort": "low" },
            "betas": null,
        })
    );
    // Custom ids: TS `buildAnthropicCustomPiModel` (8192 output tokens, reasoning only for
    // `claude` ids). A budget that would not fit under max_tokens is shrunk to leave answer room.
    assert_eq!(
        request_shape(
            "claude-custom-preview",
            json!({ "thinking": { "type": "enabled", "budgetTokens": 32000 } })
        )
        .await,
        json!({
            "max_tokens": 8192,
            "thinking": { "type": "enabled", "budget_tokens": 7168, "display": "summarized" },
            "output_config": null,
            "betas": "interleaved-thinking-2025-05-14",
        })
    );
    assert_eq!(
        request_shape(
            "acme-proxy-model",
            json!({ "thinking": { "type": "enabled", "budgetTokens": 4000 } })
        )
        .await,
        json!({ "max_tokens": 8192, "thinking": null, "output_config": null, "betas": null })
    );
}
