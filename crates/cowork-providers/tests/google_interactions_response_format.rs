//! Parity with TS `googleInteractionsRuntime.buildGoogleStreamOptions` +
//! `googleNative/buildRequest.ts`: `providerOptions.google.responseFormat` (any value, passed
//! through verbatim) and `providerOptions.google.responseMimeType` (non-empty after trimming) are
//! sent as top-level `response_format` / `response_mime_type` on the Interactions request body,
//! and are omitted when not configured.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::{
    Json, Router,
    body::Body,
    extract::State,
    http::{StatusCode, header},
    response::Response,
    routing::post,
};
use cowork_inference::{
    CanonicalMessage, ContentBlock, MessageRole, ProviderOpaqueMeta, RequestPolicy, StepBudget,
};
use cowork_providers::{GoogleInteractionsTransport, ProviderStepRequest, ProviderTransport};
use serde_json::{Map, Value, json};

#[derive(Clone)]
struct MockState {
    requests: Arc<Mutex<Vec<Value>>>,
}

fn sse_reply() -> String {
    [
        json!({
            "event_type": "interaction.start",
            "interaction": { "id": "inter_rf_1", "status": "in_progress" }
        }),
        json!({
            "event_type": "content.start",
            "index": 0,
            "content": { "type": "text", "text": "" }
        }),
        json!({
            "event_type": "content.delta",
            "index": 0,
            "delta": { "type": "text", "text": "{\"ok\":true}" }
        }),
        json!({ "event_type": "content.stop", "index": 0 }),
        json!({
            "event_type": "interaction.complete",
            "interaction": {
                "id": "inter_rf_1",
                "status": "completed",
                "usage": { "total_input_tokens": 5, "total_output_tokens": 3, "total_tokens": 8 }
            }
        }),
    ]
    .iter()
    .map(|e| format!("data: {e}\n\n"))
    .chain(std::iter::once("data: [DONE]\n\n".to_string()))
    .collect()
}

async fn handle(State(state): State<MockState>, Json(payload): Json<Value>) -> Response {
    state.requests.lock().unwrap().push(payload);
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .body(Body::from(sse_reply()))
        .unwrap()
}

/// Runs one step with `provider_options` and returns the request body sent to Google.
async fn request_body(provider_options: Value) -> Value {
    let state = MockState {
        requests: Arc::new(Mutex::new(Vec::new())),
    };
    let app = Router::new()
        .route("/v1beta/interactions", post(handle))
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    let policy = RequestPolicy {
        max_attempts: 1,
        ..RequestPolicy::default()
    };
    GoogleInteractionsTransport::new()
        .stream_step(
            ProviderStepRequest {
                model_id: "gemini-3.1-pro-preview".into(),
                base_url: Some(format!("http://{addr}")),
                api_key: Some("goog-test-key".into()),
                extra_headers: HashMap::new(),
                system_prompt: "You are Cowork.".into(),
                messages: vec![CanonicalMessage {
                    id: "u1".into(),
                    role: MessageRole::User,
                    content: vec![ContentBlock::Text {
                        text: "Reply with JSON".into(),
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
                    created_at: "2026-11-02T00:00:00Z".into(),
                }],
                tools: Vec::new(),
                authorized_tool_names: None,
                provider_options: provider_options
                    .as_object()
                    .cloned()
                    .unwrap_or_else(Map::new),
                continuation: None,
                policy,
                turn_id: "turn-rf".into(),
            },
            &StepBudget::new(10_000, None),
            &mut |_| {},
        )
        .await
        .expect("step succeeds");
    let requests = state.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    requests[0].clone()
}

#[tokio::test]
async fn configured_response_format_and_mime_type_are_forwarded_top_level() {
    let response_format = json!({
        "type": "object",
        "properties": { "ok": { "type": "boolean" } },
        "required": ["ok"]
    });
    let body = request_body(json!({
        "google": {
            "responseMimeType": "  application/json  ",
            "responseFormat": response_format,
            "temperature": 0.2
        }
    }))
    .await;
    assert_eq!(body["response_mime_type"], "application/json");
    assert_eq!(body["response_format"], response_format);
    let gen_cfg = body["generation_config"]
        .as_object()
        .expect("generation_config");
    assert!(!gen_cfg.contains_key("response_format"));
    assert!(!gen_cfg.contains_key("response_mime_type"));
}

#[tokio::test]
async fn vertex_section_is_used_when_google_section_is_absent() {
    let body = request_body(json!({
        "vertex": {
            "responseMimeType": "application/json",
            "responseFormat": { "type": "string" }
        }
    }))
    .await;
    assert_eq!(body["response_mime_type"], "application/json");
    assert_eq!(body["response_format"], json!({ "type": "string" }));
}

#[tokio::test]
async fn response_options_are_omitted_when_not_configured_or_blank() {
    let body = request_body(json!({ "google": { "temperature": 0.2 } })).await;
    let obj = body.as_object().unwrap();
    assert!(!obj.contains_key("response_format"), "{body}");
    assert!(!obj.contains_key("response_mime_type"), "{body}");

    let body = request_body(json!({ "google": { "responseMimeType": "   " } })).await;
    let obj = body.as_object().unwrap();
    assert!(!obj.contains_key("response_mime_type"), "{body}");
    assert!(!obj.contains_key("response_format"), "{body}");

    let body = request_body(json!({})).await;
    let obj = body.as_object().unwrap();
    assert!(!obj.contains_key("response_mime_type"), "{body}");
    assert!(!obj.contains_key("response_format"), "{body}");
}
