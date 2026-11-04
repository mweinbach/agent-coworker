//! Regression: a Google Interactions SSE stream that closes without the terminal
//! `interaction.complete` event (or with an open content block) must fail as a retryable
//! incomplete stream instead of surfacing truncated text / executing a truncated tool call.

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
    GoogleInteractionsTransport, ProviderStepRequest, ProviderStepResult, ProviderTransport,
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
        .route("/v1beta/interactions", post(handle))
        .with_state(Arc::new(Mutex::new(replies)));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("http://{addr}")
}

fn sse(events: &[Value]) -> String {
    events.iter().map(|e| format!("data: {e}\n\n")).collect()
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
    GoogleInteractionsTransport::new()
        .stream_step(
            ProviderStepRequest {
                model_id: "gemini-3-flash-preview".into(),
                base_url: Some(base_url.to_string()),
                api_key: Some("goog-key".into()),
                extra_headers: HashMap::new(),
                system_prompt: "System".into(),
                messages: vec![user],
                tools: Vec::new(),
                authorized_tool_names: None,
                provider_options: Map::new(),
                continuation: None,
                policy,
                turn_id: "turn-g-trunc".into(),
            },
            &StepBudget::new(10_000, None),
            &mut |ev| events.push(ev),
        )
        .await
}

#[tokio::test]
async fn google_stream_without_terminal_event_or_with_open_blocks_is_a_retryable_error() {
    let start = json!({ "event_type": "interaction.start", "interaction": { "id": "inter_t1" } });
    let complete = json!({
        "event_type": "interaction.complete",
        "interaction": { "id": "inter_t1", "status": "completed" }
    });
    let truncated_tool_call = vec![
        start.clone(),
        json!({
            "event_type": "content.start",
            "index": 0,
            "content": { "type": "function_call", "id": "call_rm", "name": "bash", "arguments": {} }
        }),
        // Partial arguments that happen to parse as JSON (`rm -rf /tmp` truncated from a longer path).
        json!({
            "event_type": "content.delta",
            "index": 0,
            "delta": { "type": "arguments_delta", "arguments": "{\"command\":\"rm -rf /tmp\"}" }
        }),
    ];
    let truncated_text = vec![
        start.clone(),
        json!({ "event_type": "content.start", "index": 0, "content": { "type": "text", "text": "" } }),
        json!({ "event_type": "content.delta", "index": 0, "delta": { "type": "text", "text": "The answer is" } }),
        json!({ "event_type": "content.stop", "index": 0 }),
    ];
    let open_block_after_complete = vec![
        start.clone(),
        json!({ "event_type": "content.start", "index": 0, "content": { "type": "text", "text": "" } }),
        json!({ "event_type": "content.delta", "index": 0, "delta": { "type": "text", "text": "half" } }),
        complete.clone(),
    ];
    let requires_action_without_calls = vec![
        start.clone(),
        json!({
            "event_type": "interaction.complete",
            "interaction": { "id": "inter_t1", "status": "requires_action" }
        }),
    ];
    let well_formed = vec![
        start,
        json!({ "event_type": "content.start", "index": 0, "content": { "type": "text", "text": "" } }),
        json!({ "event_type": "content.delta", "index": 0, "delta": { "type": "text", "text": "done" } }),
        json!({ "event_type": "content.stop", "index": 0 }),
        complete,
    ];

    let base_url = spawn_mock(vec![
        sse(&truncated_tool_call),
        sse(&truncated_text),
        sse(&open_block_after_complete),
        sse(&requires_action_without_calls),
        sse(&well_formed),
    ])
    .await;

    let mut events = Vec::new();
    let err = run_step(&base_url, &mut events)
        .await
        .expect_err("truncated tool call must not be returned for execution");
    assert!(
        err.message.contains("before interaction completion"),
        "{err:?}"
    );
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
        .expect_err("text stream without terminal event must not be a normal stop");
    assert!(
        err.message.contains("before interaction completion"),
        "{err:?}"
    );
    assert!(err.is_retryable());

    let err = run_step(&base_url, &mut Vec::new())
        .await
        .expect_err("unfinished content block must fail even after completion");
    assert!(err.message.contains("unfinished content"), "{err:?}");
    assert!(err.is_retryable());

    let err = run_step(&base_url, &mut Vec::new())
        .await
        .expect_err("requires_action without tool calls is invalid");
    assert!(err.message.contains("requires_action"), "{err:?}");

    let ok = run_step(&base_url, &mut Vec::new()).await.unwrap();
    assert_eq!(ok.assistant.stop_reason, Some(StopReason::Stop));
    assert!(matches!(
        ok.assistant.content.as_slice(),
        [ContentBlock::Text { text, .. }] if text == "done"
    ));
}
