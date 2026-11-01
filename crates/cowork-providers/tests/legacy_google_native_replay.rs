//! Legacy TS Google history with `providerToolCall` / `providerToolResult` parts migrates into
//! canonical native-tool blocks that the Google Interactions transport replays as native steps.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::{
    Json, Router,
    body::Body,
    extract::State,
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::post,
};
use cowork_inference::{RequestPolicy, StepBudget, migrate_stored_message};
use cowork_providers::{GoogleInteractionsTransport, ProviderStepRequest, ProviderTransport};
use serde_json::{Map, Value, json};

type Recorded = Arc<Mutex<Vec<Value>>>;

async fn handle_interactions(
    State(recorded): State<Recorded>,
    Json(payload): Json<Value>,
) -> Response {
    recorded.lock().unwrap().push(payload);
    let sse = [
        json!({"event_type": "interaction.start", "interaction": {"id": "inter_new"}}),
        json!({"event_type": "content.start", "index": 0, "content": {"type": "text", "text": "ok"}}),
        json!({"event_type": "content.stop", "index": 0}),
        json!({
            "event_type": "interaction.complete",
            "interaction": {"id": "inter_new", "status": "completed",
                "usage": {"total_input_tokens": 10, "total_output_tokens": 1}}
        }),
    ]
    .iter()
    .map(|e| format!("data: {e}\n\n"))
    .chain(std::iter::once("data: [DONE]\n\n".to_string()))
    .collect::<String>();
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .body(Body::from(sse))
        .unwrap()
        .into_response()
}

#[tokio::test]
async fn legacy_google_native_tool_history_replays_as_native_interactions_steps() {
    let stored = [
        json!({"role": "user", "content": "What is rustls?"}),
        json!({
            "role": "assistant",
            "provider": "google",
            "model": "gemini-3.1-pro-preview",
            "content": [
                {
                    "type": "providerToolCall",
                    "id": "gsearch_1",
                    "name": "nativeWebSearch",
                    "arguments": {"queries": ["rustls"]},
                    "thoughtSignature": "sig_search"
                },
                {
                    "type": "providerToolResult",
                    "callId": "gsearch_1",
                    "name": "nativeWebSearch",
                    "result": {"sources": [{"url": "https://docs.rs/rustls"}]}
                },
                {
                    "type": "providerToolCall",
                    "id": "url_1",
                    "name": "nativeUrlContext",
                    "arguments": {"urls": ["https://docs.rs/rustls"]}
                },
                {
                    "type": "providerToolResult",
                    "callId": "url_1",
                    "name": "nativeUrlContext",
                    "result": [{"url": "https://docs.rs/rustls", "status": "success"}],
                    "isError": true
                },
                {"type": "text", "text": "rustls is a memory-safe TLS library."}
            ]
        }),
        json!({"role": "user", "content": "Summarize it again."}),
    ];
    let messages: Vec<_> = stored
        .iter()
        .enumerate()
        .map(|(i, raw)| migrate_stored_message(raw, i, None).expect("legacy message migrates"))
        .collect();

    let recorded: Recorded = Arc::default();
    let app = Router::new()
        .route("/v1beta/interactions", post(handle_interactions))
        .with_state(recorded.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    let budget = StepBudget::new(10_000, None);
    GoogleInteractionsTransport::new()
        .stream_step(
            ProviderStepRequest {
                model_id: "gemini-3.1-pro-preview".to_string(),
                base_url: Some(format!("http://{addr}")),
                api_key: Some("goog-test-key".to_string()),
                extra_headers: HashMap::new(),
                system_prompt: "You are Cowork.".to_string(),
                messages,
                tools: Vec::new(),
                authorized_tool_names: None,
                provider_options: Map::new(),
                continuation: None,
                policy: RequestPolicy::default(),
                turn_id: "turn_legacy".to_string(),
            },
            &budget,
            &mut |_| {},
        )
        .await
        .expect("replay of migrated legacy history succeeds");

    let recorded = recorded.lock().unwrap();
    assert_eq!(recorded.len(), 1);
    let steps = recorded[0]["input"].as_array().expect("input steps");
    assert_eq!(
        steps,
        &vec![
            json!({"type": "user_input", "content": [{"type": "text", "text": "What is rustls?"}]}),
            json!({
                "type": "google_search_call",
                "id": "gsearch_1",
                "arguments": {"queries": ["rustls"]},
                "signature": "sig_search"
            }),
            json!({
                "type": "google_search_result",
                "call_id": "gsearch_1",
                "result": {"sources": [{"url": "https://docs.rs/rustls"}]}
            }),
            json!({
                "type": "url_context_call",
                "id": "url_1",
                "arguments": {"urls": ["https://docs.rs/rustls"]}
            }),
            json!({
                "type": "url_context_result",
                "call_id": "url_1",
                "result": [{"url": "https://docs.rs/rustls", "status": "success"}],
                "is_error": true
            }),
            json!({
                "type": "model_output",
                "content": [{"type": "text", "text": "rustls is a memory-safe TLS library."}]
            }),
            json!({"type": "user_input", "content": [{"type": "text", "text": "Summarize it again."}]}),
        ]
    );
}
