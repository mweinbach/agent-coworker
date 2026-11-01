//! Regression: an OpenAI-compatible Chat Completions SSE stream that closes without a terminal
//! choice `finish_reason` must fail as a retryable incomplete stream instead of returning
//! truncated text / tool calls as a successful step, and tool calls whose arguments are not a
//! complete JSON object must never be repaired into an executable call.

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
use cowork_config::ProviderName;
use cowork_inference::{
    CanonicalMessage, ContentBlock, MessageRole, ProviderOpaqueMeta, ProviderTransportError,
    RequestPolicy, StepBudget, StopReason, StreamEvent,
};
use cowork_providers::chat_completions::ChatCompletionsTransport;
use cowork_providers::{ProviderStepRequest, ProviderStepResult, ProviderTransport};
use serde_json::{Map, Value, json};

type Replies = Arc<Mutex<Vec<String>>>;

async fn handle(State(replies): State<Replies>) -> Response {
    let body = replies.lock().unwrap().remove(0);
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .body(Body::from(body))
        .unwrap()
}

async fn spawn_mock(replies: Vec<String>) -> String {
    let app = Router::new()
        .route("/v1/chat/completions", post(handle))
        .with_state(Arc::new(Mutex::new(replies)));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("http://{addr}/v1")
}

fn sse(chunks: &[Value], done: bool) -> String {
    let mut out: String = chunks.iter().map(|c| format!("data: {c}\n\n")).collect();
    if done {
        out.push_str("data: [DONE]\n\n");
    }
    out
}

fn tool_chunk(id: Option<&str>, name: Option<&str>, args: &str, finish: Option<&str>) -> Value {
    let mut function = json!({ "arguments": args });
    if let Some(name) = name {
        function["name"] = json!(name);
    }
    let mut call = json!({ "index": 0, "type": "function", "function": function });
    if let Some(id) = id {
        call["id"] = json!(id);
    }
    json!({
        "id": "chatcmpl-t",
        "choices": [{ "index": 0, "delta": { "tool_calls": [call] }, "finish_reason": finish }]
    })
}

fn text_chunk(text: &str, finish: Option<&str>) -> Value {
    json!({
        "id": "chatcmpl-t",
        "choices": [{ "index": 0, "delta": { "content": text }, "finish_reason": finish }]
    })
}

async fn run_step(
    base_url: &str,
    events: &mut Vec<StreamEvent>,
) -> Result<ProviderStepResult, ProviderTransportError> {
    let user = CanonicalMessage {
        id: "u1".into(),
        role: MessageRole::User,
        content: vec![ContentBlock::Text {
            text: "delete the temp files".into(),
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
    };
    // Single attempt so a retryable failure surfaces directly instead of consuming later replies.
    let policy = RequestPolicy {
        max_attempts: 1,
        ..RequestPolicy::default()
    };
    ChatCompletionsTransport::new(ProviderName::Lmstudio)
        .expect("lmstudio maps to ChatCompletionsTransport")
        .stream_step(
            ProviderStepRequest {
                model_id: "local-model".into(),
                base_url: Some(base_url.to_string()),
                api_key: None,
                extra_headers: HashMap::new(),
                system_prompt: "System".into(),
                messages: vec![user],
                tools: Vec::new(),
                authorized_tool_names: None,
                provider_options: Map::new(),
                continuation: None,
                policy,
                turn_id: "turn-cc-trunc".into(),
            },
            &StepBudget::new(10_000, None),
            &mut |ev| events.push(ev),
        )
        .await
}

fn has_tool_call_end(events: &[StreamEvent]) -> bool {
    events
        .iter()
        .any(|e| matches!(e, StreamEvent::ToolCallEnd { .. }))
}

#[tokio::test]
async fn chat_completions_stream_without_finish_reason_is_a_retryable_error() {
    // Tool call whose partial arguments would be "repaired" to {"command":"rm -rf /tmp"}, then EOF
    // with neither finish_reason nor [DONE].
    let truncated_tool_eof = sse(
        &[
            text_chunk("Cleaning up.", None),
            tool_chunk(
                Some("call_rm"),
                Some("bash"),
                "{\"command\":\"rm -rf /tmp",
                None,
            ),
        ],
        false,
    );
    // Text followed by [DONE] but no finish_reason on any choice.
    let text_done_without_finish = sse(&[text_chunk("The answer is", None)], true);
    // finish_reason present, but the tool call arguments are not a complete JSON object.
    let finish_with_truncated_args = sse(
        &[
            tool_chunk(Some("call_rm"), Some("bash"), "{\"command\":\"rm", None),
            tool_chunk(None, None, " -rf /tmp", Some("length")),
        ],
        true,
    );
    // Providers that omit [DONE] but send finish_reason still complete normally.
    let finish_without_done = sse(
        &[
            tool_chunk(Some("call_ls"), Some("bash"), "{\"command\":", None),
            tool_chunk(None, None, "\"ls\"}", Some("tool_calls")),
        ],
        false,
    );

    let base_url = spawn_mock(vec![
        truncated_tool_eof,
        text_done_without_finish,
        finish_with_truncated_args,
        finish_without_done,
    ])
    .await;

    let mut events = Vec::new();
    let err = run_step(&base_url, &mut events)
        .await
        .expect_err("truncated tool call must not be returned for execution");
    assert!(err.message.contains("without a finish_reason"), "{err:?}");
    assert!(
        err.is_retryable(),
        "incomplete stream must be retryable: {err:?}"
    );
    assert!(
        !has_tool_call_end(&events),
        "unfinished tool call must never be emitted as complete"
    );

    let err = run_step(&base_url, &mut Vec::new())
        .await
        .expect_err("[DONE] without finish_reason must not be a normal stop");
    assert!(err.message.contains("without a finish_reason"), "{err:?}");
    assert!(err.is_retryable());

    let mut events = Vec::new();
    let err = run_step(&base_url, &mut events)
        .await
        .expect_err("partial tool arguments must never be repaired into an executable call");
    assert!(
        err.message.contains("incomplete tool call arguments"),
        "{err:?}"
    );
    assert!(err.is_retryable());
    assert!(!has_tool_call_end(&events));

    let mut events = Vec::new();
    let ok = run_step(&base_url, &mut events)
        .await
        .expect("finish_reason without [DONE] completes normally");
    assert_eq!(ok.assistant.stop_reason, Some(StopReason::ToolUse));
    assert!(ok.assistant.content.iter().any(|b| matches!(
        b,
        ContentBlock::ToolCall { name, arguments, .. }
            if name == "bash" && arguments.get("command").and_then(Value::as_str) == Some("ls")
    )));
    assert!(has_tool_call_end(&events));
}
