//! Regression: an Anthropic Messages SSE stream that closes cleanly without the terminal
//! `message_stop` event (or with a content block still open) must fail as a retryable
//! incomplete stream instead of returning truncated text / tool calls as a successful step.

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
    RequestPolicy, StepBudget, StopReason, StreamEvent,
};
use cowork_providers::{
    AnthropicMessagesTransport, ProviderStepRequest, ProviderStepResult, ProviderTransport,
};
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
        .route("/v1/messages", post(handle))
        .with_state(Arc::new(Mutex::new(replies)));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("http://{addr}")
}

fn sse(events: &[Value]) -> String {
    events
        .iter()
        .map(|e| format!("event: {}\ndata: {e}\n\n", e["type"].as_str().unwrap()))
        .collect()
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
    AnthropicMessagesTransport::new()
        .stream_step(
            ProviderStepRequest {
                model_id: "claude-sonnet-4-6".into(),
                base_url: Some(base_url.to_string()),
                api_key: Some("sk-ant-api03-key".into()),
                extra_headers: HashMap::new(),
                system_prompt: "System".into(),
                messages: vec![user],
                tools: Vec::new(),
                authorized_tool_names: None,
                provider_options: Map::new(),
                continuation: None,
                policy,
                turn_id: "turn-a-trunc".into(),
            },
            &StepBudget::new(10_000, None),
            &mut |ev| events.push(ev),
        )
        .await
}

#[tokio::test]
async fn anthropic_stream_without_message_stop_or_with_open_blocks_is_a_retryable_error() {
    let start = json!({
        "type": "message_start",
        "message": { "id": "msg_t1", "usage": { "input_tokens": 10, "output_tokens": 0 } }
    });
    let text_start = json!({
        "type": "content_block_start",
        "index": 0,
        "content_block": { "type": "text", "text": "" }
    });
    let text_delta = |t: &str| {
        json!({
            "type": "content_block_delta",
            "index": 0,
            "delta": { "type": "text_delta", "text": t }
        })
    };
    let stop = |i: usize| json!({ "type": "content_block_stop", "index": i });
    let message_delta = json!({
        "type": "message_delta",
        "delta": { "stop_reason": "end_turn" },
        "usage": { "output_tokens": 3 }
    });
    let message_stop = json!({ "type": "message_stop" });

    // Text block finished, then a tool call whose partial arguments parse, then EOF.
    let finished_text_then_truncated_tool = vec![
        start.clone(),
        text_start.clone(),
        text_delta("Cleaning up."),
        stop(0),
        json!({
            "type": "content_block_start",
            "index": 1,
            "content_block": { "type": "tool_use", "id": "toolu_rm", "name": "bash", "input": {} }
        }),
        json!({
            "type": "content_block_delta",
            "index": 1,
            "delta": { "type": "input_json_delta", "partial_json": "{\"command\":\"rm -rf /tmp\"}" }
        }),
    ];
    // Every block closed, but the message never terminated.
    let finished_text_without_message_stop = vec![
        start.clone(),
        text_start.clone(),
        text_delta("The answer is"),
        stop(0),
    ];
    // message_stop arrives while a block is still open.
    let open_block_at_message_stop = vec![
        start.clone(),
        text_start.clone(),
        text_delta("half"),
        message_delta.clone(),
        message_stop.clone(),
    ];
    let well_formed = vec![
        start,
        text_start,
        text_delta("done"),
        stop(0),
        message_delta,
        message_stop,
    ];

    let base_url = spawn_mock(vec![
        sse(&finished_text_then_truncated_tool),
        sse(&finished_text_without_message_stop),
        sse(&open_block_at_message_stop),
        sse(&well_formed),
    ])
    .await;

    let mut events = Vec::new();
    let err = run_step(&base_url, &mut events)
        .await
        .expect_err("truncated tool call must not be returned for execution");
    assert!(err.message.contains("before message_stop"), "{err:?}");
    assert!(
        err.is_retryable(),
        "incomplete stream must be retryable: {err:?}"
    );
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, StreamEvent::ToolCallEnd { .. })),
        "unfinished tool call must never be emitted as complete"
    );

    let err = run_step(&base_url, &mut Vec::new())
        .await
        .expect_err("closed blocks without message_stop must not be a normal stop");
    assert!(err.message.contains("before message_stop"), "{err:?}");
    assert!(err.is_retryable());

    let err = run_step(&base_url, &mut Vec::new())
        .await
        .expect_err("unfinished content block must fail even after message_stop");
    assert!(err.message.contains("unfinished content"), "{err:?}");
    assert!(err.is_retryable());

    let ok = run_step(&base_url, &mut Vec::new()).await.unwrap();
    assert_eq!(ok.assistant.stop_reason, Some(StopReason::Stop));
    assert!(matches!(
        ok.assistant.content.as_slice(),
        [ContentBlock::Text { text, .. }] if text == "done"
    ));
}
