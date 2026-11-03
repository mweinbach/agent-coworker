//! OpenAI Responses stream hardening:
//!
//! - SSE `error` events go through `buildOpenAiResponseFailedError` (`openaiResponsesProjector.ts`),
//!   so a nested `error.code` (e.g. `previous_response_not_found`, `rate_limit_exceeded`) survives.
//! - A `response.completed` whose `response.status` is `failed` / `cancelled` / `incomplete` is not
//!   a normal completion (`mapStopReason` maps them to `error` / `length`).
//! - An output item that was added but never finished, or a completed `function_call` whose
//!   arguments are not one whole JSON object, must never become an executable tool call.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::{
    Router,
    body::Body,
    extract::State,
    http::{StatusCode, header},
    response::Response,
    routing::post,
};
use cowork_inference::{
    CanonicalMessage, ContentBlock, MessageRole, ProviderOpaqueMeta, ProviderTransportError,
    RequestPolicy, StepBudget, StreamEvent,
};
use cowork_providers::{
    OpenAiResponsesTransport, ProviderStepRequest, ProviderStepResult, ProviderTransport,
};
use serde_json::{Map, Value, json};

#[derive(Clone)]
struct Mock {
    reply: Arc<String>,
    hits: Arc<Mutex<usize>>,
}

async fn handle(State(mock): State<Mock>) -> Response {
    *mock.hits.lock().unwrap() += 1;
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .body(Body::from(mock.reply.as_str().to_owned()))
        .unwrap()
}

async fn spawn_mock(events: &[Value]) -> String {
    let mock = Mock {
        reply: Arc::new(events.iter().map(|e| format!("data: {e}\n\n")).collect()),
        hits: Arc::default(),
    };
    let app = Router::new()
        .route("/v1/responses", post(handle))
        .with_state(mock);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("http://{addr}/v1")
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
        created_at: "2026-11-01T00:00:00Z".into(),
    }
}

async fn run(
    events: &[Value],
) -> (
    Result<ProviderStepResult, ProviderTransportError>,
    Vec<StreamEvent>,
) {
    let base_url = spawn_mock(events).await;
    let mut streamed = Vec::new();
    let result = OpenAiResponsesTransport::new()
        .stream_step(
            ProviderStepRequest {
                model_id: "gpt-5.4".into(),
                base_url: Some(base_url),
                api_key: Some("sk-test-openai".into()),
                extra_headers: HashMap::new(),
                system_prompt: "You are Cowork.".into(),
                messages: vec![user("list files")],
                tools: Vec::new(),
                authorized_tool_names: None,
                provider_options: Map::new(),
                continuation: None,
                policy: RequestPolicy {
                    max_attempts: 1,
                    ..RequestPolicy::default()
                },
                turn_id: "turn_harden".into(),
            },
            &StepBudget::new(10_000, None),
            &mut |ev| streamed.push(ev),
        )
        .await;
    (result, streamed)
}

fn created() -> Value {
    json!({"type": "response.created", "response": {"id": "resp_1", "status": "in_progress"}})
}

fn completed(status: &str) -> Value {
    json!({
        "type": "response.completed",
        "response": {
            "id": "resp_1",
            "status": status,
            "usage": {"input_tokens": 5, "output_tokens": 3, "total_tokens": 8}
        }
    })
}

fn function_call_added() -> Value {
    json!({
        "type": "response.output_item.added",
        "output_index": 0,
        "item": {"id": "fc_1", "call_id": "call_1", "type": "function_call", "name": "bash", "arguments": ""}
    })
}

fn args_delta(delta: &str) -> Value {
    json!({
        "type": "response.function_call_arguments.delta",
        "output_index": 0,
        "item_id": "fc_1",
        "delta": delta
    })
}

fn has_tool_call_end(events: &[StreamEvent]) -> bool {
    events
        .iter()
        .any(|ev| matches!(ev, StreamEvent::ToolCallEnd { .. }))
}

#[tokio::test]
async fn sse_error_event_keeps_nested_error_code() {
    for code in ["previous_response_not_found", "rate_limit_exceeded"] {
        let (result, _) = run(&[
            created(),
            json!({
                "type": "error",
                "error": {"type": "invalid_request_error", "code": code, "message": "Request rejected."}
            }),
        ])
        .await;
        let err = result.expect_err("error event fails the step");
        assert_eq!(err.code.as_deref(), Some(code), "{}", err.message);
        assert!(
            err.message.starts_with("Request rejected.")
                && err.message.contains(&format!("code: {code}")),
            "{}",
            err.message
        );
    }
}

#[tokio::test]
async fn completed_event_with_non_completed_status_is_rejected() {
    for status in ["failed", "cancelled", "incomplete"] {
        let (result, _) = run(&[
            created(),
            json!({
                "type": "response.output_item.added",
                "output_index": 0,
                "item": {"id": "msg_1", "type": "message", "content": []}
            }),
            json!({
                "type": "response.output_item.done",
                "output_index": 0,
                "item": {"id": "msg_1", "type": "message", "content": [{"type": "output_text", "text": "Partial"}]}
            }),
            completed(status),
        ])
        .await;
        let err = result.expect_err("non-completed terminal status fails the step");
        assert!(
            err.message.contains(&format!("status: {status}")),
            "{status}: {}",
            err.message
        );
    }
}

#[tokio::test]
async fn unfinished_function_call_at_completion_is_rejected() {
    let (result, events) = run(&[
        created(),
        function_call_added(),
        args_delta("{\"command\":\"rm -rf bu"),
        completed("completed"),
    ])
    .await;
    let err = result.expect_err("open item at completion fails the step");
    assert!(
        err.message.contains("unfinished content"),
        "{}",
        err.message
    );
    assert!(err.is_retryable(), "a truncated stream is retryable");
    assert!(!has_tool_call_end(&events), "no executable tool call");
}

#[tokio::test]
async fn malformed_completed_function_call_arguments_are_rejected() {
    let (result, events) = run(&[
        created(),
        function_call_added(),
        args_delta("{\"command\":\"rm -rf bu"),
        json!({
            "type": "response.output_item.done",
            "output_index": 0,
            "item": {
                "id": "fc_1",
                "call_id": "call_1",
                "type": "function_call",
                "name": "bash",
                "arguments": "{\"command\":\"rm -rf bu"
            }
        }),
        completed("completed"),
    ])
    .await;
    let err = result.expect_err("malformed arguments fail the step");
    assert!(
        err.message
            .contains("Invalid JSON arguments for OpenAI tool call \"bash\""),
        "{}",
        err.message
    );
    assert!(!has_tool_call_end(&events), "no executable tool call");
}

#[tokio::test]
async fn well_formed_function_call_still_completes() {
    let (result, events) = run(&[
        created(),
        function_call_added(),
        args_delta("{\"command\":"),
        args_delta("\"ls\"}"),
        json!({
            "type": "response.output_item.done",
            "output_index": 0,
            "item": {
                "id": "fc_1",
                "call_id": "call_1",
                "type": "function_call",
                "name": "bash",
                "arguments": "{\"command\":\"ls\"}"
            }
        }),
        completed("completed"),
    ])
    .await;
    let result = result.expect("well-formed call completes");
    assert!(has_tool_call_end(&events));
    let args = result.assistant.content.iter().find_map(|b| match b {
        ContentBlock::ToolCall { arguments, .. } => Some(Value::Object(arguments.clone())),
        _ => None,
    });
    assert_eq!(args, Some(json!({"command": "ls"})));
}
