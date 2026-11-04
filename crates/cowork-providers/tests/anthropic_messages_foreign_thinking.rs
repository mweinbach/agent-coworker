//! Regression: when a thread switches from OpenAI / Google to Anthropic, history thinking blocks
//! carrying foreign signatures (e.g. the Responses decoder's serialized reasoning-item JSON in
//! `Thinking.signature`) must not be replayed as Anthropic signed / redacted thinking, which fails
//! Anthropic signature verification. Only Anthropic-origin thinking keeps its signature.

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
    CanonicalMessage, ContentBlock, MessageRole, ProviderOpaqueMeta, RequestPolicy, StepBudget,
};
use cowork_providers::{AnthropicMessagesTransport, ProviderStepRequest, ProviderTransport};
use serde_json::{Map, Value, json};

type Captured = Arc<Mutex<Vec<Value>>>;

async fn handle(State(captured): State<Captured>, body: String) -> Response {
    captured
        .lock()
        .unwrap()
        .push(serde_json::from_str(&body).unwrap());
    let events = [
        json!({"type": "message_start", "message": {"id": "msg_1", "usage": {"input_tokens": 1, "output_tokens": 0}}}),
        json!({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
        json!({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "ok"}}),
        json!({"type": "content_block_stop", "index": 0}),
        json!({"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 1}}),
        json!({"type": "message_stop"}),
    ];
    let sse: String = events
        .iter()
        .map(|e| format!("event: {}\ndata: {e}\n\n", e["type"].as_str().unwrap()))
        .collect();
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .body(Body::from(sse))
        .unwrap()
}

fn message(
    role: MessageRole,
    provider: Option<&str>,
    content: Vec<ContentBlock>,
) -> CanonicalMessage {
    CanonicalMessage {
        id: format!("m-{}", content.len()),
        role,
        content,
        phase: None,
        provider: provider.map(str::to_owned),
        api: None,
        model: None,
        stop_reason: None,
        provider_meta: ProviderOpaqueMeta::default(),
        created_at: "2026-10-30T00:00:00Z".into(),
    }
}

fn text(t: &str) -> ContentBlock {
    ContentBlock::Text {
        text: t.into(),
        phase: None,
        citations: Vec::new(),
        provider_meta: ProviderOpaqueMeta::default(),
    }
}

fn thinking(t: &str, redacted: bool, signature: &str, meta: ProviderOpaqueMeta) -> ContentBlock {
    ContentBlock::Thinking {
        text: t.into(),
        summary: None,
        redacted,
        signature: Some(signature.into()),
        provider_meta: meta,
    }
}

#[tokio::test]
async fn foreign_reasoning_is_replayed_as_text_and_only_anthropic_signatures_are_kept() {
    let captured: Captured = Arc::new(Mutex::new(Vec::new()));
    let app = Router::new()
        .route("/v1/messages", post(handle))
        .with_state(captured.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    let openai_item = json!({
        "type": "reasoning",
        "id": "rs_1",
        "encrypted_content": "gAAAA-openai",
        "summary": [{"type": "summary_text", "text": "OpenAI plan"}]
    });
    let history = vec![
        message(MessageRole::User, None, vec![text("first")]),
        message(
            MessageRole::Assistant,
            Some("openai"),
            vec![
                thinking(
                    "OpenAI plan",
                    false,
                    &openai_item.to_string(),
                    ProviderOpaqueMeta {
                        openai_reasoning_item: Some(openai_item.clone()),
                        ..Default::default()
                    },
                ),
                thinking(
                    "",
                    true,
                    "gAAAA-openai-encrypted",
                    ProviderOpaqueMeta::default(),
                ),
                text("openai answer"),
            ],
        ),
        message(MessageRole::User, None, vec![text("second")]),
        message(
            MessageRole::Assistant,
            Some("google"),
            vec![
                thinking(
                    "Gemini thought",
                    false,
                    "google-thought-sig",
                    ProviderOpaqueMeta {
                        google_thought_signature: Some("google-thought-sig".into()),
                        ..Default::default()
                    },
                ),
                text("google answer"),
            ],
        ),
        message(MessageRole::User, None, vec![text("third")]),
        message(
            MessageRole::Assistant,
            Some("anthropic"),
            vec![
                thinking(
                    "Claude thought",
                    false,
                    "anthropic-sig",
                    ProviderOpaqueMeta {
                        anthropic_thinking_signature: Some("anthropic-sig".into()),
                        ..Default::default()
                    },
                ),
                thinking(
                    "",
                    true,
                    "anthropic-redacted",
                    ProviderOpaqueMeta {
                        anthropic_redacted_thinking: Some("anthropic-redacted".into()),
                        ..Default::default()
                    },
                ),
                text("claude answer"),
            ],
        ),
        message(MessageRole::User, None, vec![text("fourth")]),
    ];

    AnthropicMessagesTransport::new()
        .stream_step(
            ProviderStepRequest {
                model_id: "claude-sonnet-4-6".into(),
                base_url: Some(format!("http://{addr}")),
                api_key: Some("sk-ant-api03-key".into()),
                extra_headers: HashMap::new(),
                system_prompt: "System".into(),
                messages: history,
                tools: Vec::new(),
                authorized_tool_names: None,
                provider_options: Map::new(),
                continuation: None,
                policy: RequestPolicy {
                    max_attempts: 1,
                    ..RequestPolicy::default()
                },
                turn_id: "turn-mixed".into(),
            },
            &StepBudget::new(10_000, None),
            &mut |_| {},
        )
        .await
        .expect("mixed-provider history step succeeds");

    let body = captured.lock().unwrap().remove(0);
    let assistants: Vec<&Value> = body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["role"] == "assistant")
        .map(|m| &m["content"])
        .collect();
    assert_eq!(assistants.len(), 3, "{body}");

    // OpenAI reasoning: visible text only; the encrypted redacted item is dropped.
    assert_eq!(
        assistants[0],
        &json!([
            {"type": "text", "text": "OpenAI plan"},
            {"type": "text", "text": "openai answer"}
        ])
    );
    // Google thought: visible text only, no signature.
    assert_eq!(
        assistants[1],
        &json!([
            {"type": "text", "text": "Gemini thought"},
            {"type": "text", "text": "google answer"}
        ])
    );
    // Anthropic-origin thinking keeps its signature and redacted payload.
    assert_eq!(
        assistants[2],
        &json!([
            {"type": "thinking", "thinking": "Claude thought", "signature": "anthropic-sig"},
            {"type": "redacted_thinking", "data": "anthropic-redacted"},
            {"type": "text", "text": "claude answer"}
        ])
    );
}
