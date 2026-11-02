//! OpenAI Responses replay parity with `openaiResponsesShared.ts` `transformMessages`:
//! encrypted reasoning items (and text item ids / annotations) are only replayed when provider,
//! api AND model match the target; otherwise reasoning is converted to plain assistant text.
//! Also covers `truncation: "auto"` on every request and `response.incomplete` /
//! `response.failed` error messages carrying `code` / `incomplete_details.reason`.

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
use cowork_inference::{
    CanonicalMessage, ContentBlock, MessageRole, ProviderOpaqueMeta, ProviderTransportError,
    RequestPolicy, StepBudget, StopReason, ToolResultPart,
};
use cowork_providers::{OpenAiResponsesTransport, ProviderStepRequest, ProviderTransport};
use serde_json::{Map, Value, json};

#[derive(Clone)]
struct MockState {
    requests: Arc<Mutex<Vec<Value>>>,
    reply: Arc<String>,
}

async fn handle_responses(State(state): State<MockState>, Json(payload): Json<Value>) -> Response {
    state.requests.lock().unwrap().push(payload);
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .body(Body::from(state.reply.as_str().to_owned()))
        .unwrap()
        .into_response()
}

fn sse(frames: &[Value]) -> String {
    frames
        .iter()
        .map(|frame| format!("data: {frame}\n\n"))
        .collect()
}

fn completed_reply() -> String {
    sse(&[
        json!({"type": "response.created", "response": {"id": "resp_new", "status": "in_progress"}}),
        json!({"type": "response.completed", "response": {"id": "resp_new", "status": "completed"}}),
    ])
}

async fn spawn_mock(reply: String) -> (String, MockState) {
    let state = MockState {
        requests: Arc::new(Mutex::new(Vec::new())),
        reply: Arc::new(reply),
    };
    let app = Router::new()
        .route("/v1/responses", post(handle_responses))
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("http://{addr}/v1"), state)
}

fn user(id: &str, text: &str) -> CanonicalMessage {
    CanonicalMessage {
        id: id.to_string(),
        role: MessageRole::User,
        content: vec![ContentBlock::Text {
            text: text.to_string(),
            phase: None,
            citations: vec![],
            provider_meta: ProviderOpaqueMeta::default(),
        }],
        phase: None,
        provider: None,
        api: None,
        model: None,
        stop_reason: None,
        provider_meta: ProviderOpaqueMeta::default(),
        created_at: "2026-11-01T00:00:00Z".to_string(),
    }
}

fn reasoning_item() -> Value {
    json!({
        "type": "reasoning",
        "id": "rs_prev",
        "encrypted_content": "enc_prev_model",
        "summary": [{"type": "summary_text", "text": "Thinking about pwd."}]
    })
}

/// Assistant turn persisted by the Responses transport: reasoning + text + tool call.
fn openai_assistant(provider: &str, api: Option<&str>, model: &str) -> CanonicalMessage {
    let mut text_extra = Map::new();
    text_extra.insert(
        "annotations".to_string(),
        json!([{"type": "url_citation", "url": "https://example.com"}]),
    );
    let mut args = Map::new();
    args.insert("cmd".to_string(), json!("pwd"));
    CanonicalMessage {
        id: "a1".to_string(),
        role: MessageRole::Assistant,
        content: vec![
            ContentBlock::Thinking {
                text: "Thinking about pwd.".to_string(),
                summary: None,
                redacted: false,
                signature: Some(reasoning_item().to_string()),
                provider_meta: ProviderOpaqueMeta {
                    openai_reasoning_item: Some(reasoning_item()),
                    ..Default::default()
                },
            },
            ContentBlock::Text {
                text: "Running pwd.".to_string(),
                phase: None,
                citations: vec![],
                provider_meta: ProviderOpaqueMeta {
                    openai_item_id: Some("msg_stored_item".to_string()),
                    extra: text_extra,
                    ..Default::default()
                },
            },
            ContentBlock::ToolCall {
                id: "call_1|fc_item_1".to_string(),
                name: "bash".to_string(),
                arguments: args,
                partial_json: None,
                provider_meta: ProviderOpaqueMeta::default(),
            },
        ],
        phase: None,
        provider: Some(provider.to_string()),
        api: api.map(str::to_string),
        model: Some(model.to_string()),
        stop_reason: Some(StopReason::ToolUse),
        provider_meta: ProviderOpaqueMeta::default(),
        created_at: "2026-11-01T00:00:01Z".to_string(),
    }
}

fn tool_result() -> CanonicalMessage {
    CanonicalMessage {
        id: "t1".to_string(),
        role: MessageRole::Tool,
        content: vec![ContentBlock::ToolResult {
            tool_call_id: "call_1|fc_item_1".to_string(),
            tool_name: Some("bash".to_string()),
            content: vec![ToolResultPart::Text {
                text: "/tmp".to_string(),
            }],
            structured_meta: None,
            is_error: false,
            provider_meta: ProviderOpaqueMeta::default(),
        }],
        phase: None,
        provider: None,
        api: None,
        model: None,
        stop_reason: None,
        provider_meta: ProviderOpaqueMeta::default(),
        created_at: "2026-11-01T00:00:02Z".to_string(),
    }
}

async fn run_step(
    reply: String,
    model_id: &str,
    messages: Vec<CanonicalMessage>,
) -> (Result<(), ProviderTransportError>, Vec<Value>) {
    let (base_url, mock) = spawn_mock(reply).await;
    let mut opts = Map::new();
    opts.insert("reasoningEffort".to_string(), json!("high"));
    let result = OpenAiResponsesTransport::new()
        .stream_step(
            ProviderStepRequest {
                model_id: model_id.to_string(),
                base_url: Some(base_url),
                api_key: Some("sk-test".to_string()),
                extra_headers: HashMap::new(),
                system_prompt: "You are Cowork.".to_string(),
                messages,
                tools: vec![],
                authorized_tool_names: None,
                provider_options: opts,
                continuation: None,
                policy: RequestPolicy {
                    max_attempts: 1,
                    base_delay_ms: 1,
                    ..RequestPolicy::default()
                },
                turn_id: "turn_1".to_string(),
            },
            &StepBudget::new(10_000, None),
            &mut |_| {},
        )
        .await
        .map(|_| ());
    let requests = mock.requests.lock().unwrap().clone();
    (result, requests)
}

async fn replay_body(model_id: &str, history_assistant: CanonicalMessage) -> Value {
    let (result, requests) = run_step(
        completed_reply(),
        model_id,
        vec![
            user("u1", "pwd?"),
            history_assistant,
            tool_result(),
            user("u2", "again"),
        ],
    )
    .await;
    result.expect("mock Responses request succeeds");
    assert_eq!(requests.len(), 1);
    requests.into_iter().next().unwrap()
}

#[tokio::test]
async fn same_model_replays_encrypted_reasoning_and_stored_item_ids() {
    let body = replay_body(
        "gpt-5.5",
        openai_assistant("openai", Some("openai-responses"), "gpt-5.5"),
    )
    .await;

    assert_eq!(body["truncation"], "auto");
    assert!(body.get("previous_response_id").is_none());
    assert_eq!(
        body["input"],
        json!([
            {"role": "user", "content": [{"type": "input_text", "text": "pwd?"}]},
            reasoning_item(),
            {
                "type": "message",
                "role": "assistant",
                "status": "completed",
                "id": "msg_stored_item",
                "content": [{
                    "type": "output_text",
                    "text": "Running pwd.",
                    "annotations": [{"type": "url_citation", "url": "https://example.com"}]
                }]
            },
            {
                "type": "function_call",
                "id": "fc_item_1",
                "call_id": "call_1",
                "name": "bash",
                "arguments": "{\"cmd\":\"pwd\"}"
            },
            {"type": "function_call_output", "call_id": "call_1", "output": "/tmp"},
            {"role": "user", "content": [{"type": "input_text", "text": "again"}]}
        ])
    );
}

#[tokio::test]
async fn cross_model_switch_converts_reasoning_to_text() {
    // gpt-5.4 -> gpt-5.5: same provider/api, different model.
    let body = replay_body(
        "gpt-5.5",
        openai_assistant("openai", Some("openai-responses"), "gpt-5.4"),
    )
    .await;

    assert_eq!(body["truncation"], "auto");
    assert!(!body.to_string().contains("enc_prev_model"));
    assert_eq!(
        body["input"],
        json!([
            {"role": "user", "content": [{"type": "input_text", "text": "pwd?"}]},
            {
                "type": "message",
                "role": "assistant",
                "status": "completed",
                "id": "msg_1_0",
                "content": [{"type": "output_text", "text": "Thinking about pwd.", "annotations": []}]
            },
            {
                "type": "message",
                "role": "assistant",
                "status": "completed",
                "id": "msg_1_1",
                "content": [{"type": "output_text", "text": "Running pwd.", "annotations": []}]
            },
            {
                // `fc_` item id is stripped for a different model of the same provider/api.
                "type": "function_call",
                "call_id": "call_1",
                "name": "bash",
                "arguments": "{\"cmd\":\"pwd\"}"
            },
            {"type": "function_call_output", "call_id": "call_1", "output": "/tmp"},
            {"role": "user", "content": [{"type": "input_text", "text": "again"}]}
        ])
    );
}

#[tokio::test]
async fn other_provider_or_api_never_replays_openai_reasoning_items() {
    // Same model id but a different provider (e.g. Azure / OpenRouter / Codex history), and
    // OpenAI history without the Responses api stamp: neither is "same model" in TS terms.
    for assistant in [
        openai_assistant("azure", Some("openai-responses"), "gpt-5.5"),
        openai_assistant("openrouter", Some("openai-completions"), "gpt-5.5"),
        openai_assistant("openai", None, "gpt-5.5"),
    ] {
        let label = format!("{:?}/{:?}", assistant.provider, assistant.api);
        let body = replay_body("gpt-5.5", assistant).await;
        let input = body["input"].as_array().unwrap();
        assert!(
            !input.iter().any(|item| item["type"] == "reasoning"),
            "{label}: reasoning item must not be replayed"
        );
        assert!(
            input.iter().any(|item| item["type"] == "message"
                && item["content"][0]["text"] == "Thinking about pwd."),
            "{label}: reasoning replayed as assistant text"
        );
        assert!(
            !input.iter().any(|item| item["id"] == "msg_stored_item"),
            "{label}: stored text item id dropped"
        );
    }
}

#[tokio::test]
async fn truncation_auto_is_sent_without_previous_response_id() {
    let (result, requests) = run_step(completed_reply(), "gpt-5.5", vec![user("u1", "hi")]).await;
    result.expect("request succeeds");
    assert_eq!(requests[0]["truncation"], "auto");
    assert!(requests[0].get("previous_response_id").is_none());
}

#[tokio::test]
async fn response_incomplete_error_includes_incomplete_reason() {
    let reply = sse(&[
        json!({"type": "response.created", "response": {"id": "resp_x", "status": "in_progress"}}),
        json!({
            "type": "response.incomplete",
            "response": {
                "id": "resp_x",
                "status": "incomplete",
                "incomplete_details": {"reason": "max_output_tokens"}
            }
        }),
    ]);
    let (result, _) = run_step(reply, "gpt-5.5", vec![user("u1", "hi")]).await;
    let err = result.expect_err("incomplete response must error");
    assert_eq!(
        err.message,
        "OpenAI response incomplete. (code: max_output_tokens, status: incomplete)"
    );
    assert_eq!(err.code.as_deref(), Some("max_output_tokens"));
}

#[tokio::test]
async fn response_failed_error_includes_code_type_and_param() {
    let reply = sse(&[
        json!({"type": "response.created", "response": {"id": "resp_y", "status": "in_progress"}}),
        json!({
            "type": "response.failed",
            "response": {
                "id": "resp_y",
                "status": "failed",
                "error": {
                    "code": "invalid_encrypted_content",
                    "message": "Encrypted content could not be verified.",
                    "type": "invalid_request_error",
                    "param": "input[1]"
                }
            }
        }),
    ]);
    let (result, _) = run_step(reply, "gpt-5.5", vec![user("u1", "hi")]).await;
    let err = result.expect_err("failed response must error");
    assert_eq!(
        err.message,
        "Encrypted content could not be verified. (code: invalid_encrypted_content, status: failed, type: invalid_request_error, param: input[1])"
    );
    assert_eq!(err.code.as_deref(), Some("invalid_encrypted_content"));
}

#[tokio::test]
async fn response_failed_without_details_uses_default_message() {
    let reply = sse(&[json!({"type": "response.failed", "response": {"id": "resp_z"}})]);
    let (result, _) = run_step(reply, "gpt-5.5", vec![user("u1", "hi")]).await;
    let err = result.expect_err("failed response must error");
    assert_eq!(err.message, "OpenAI response failed.");
    assert!(err.code.is_none());
}

/// Assistant turn holding a single tool call with a caller-chosen composite id.
fn assistant_tool_call(provider: &str, model: &str, tool_id: &str) -> CanonicalMessage {
    let mut args = Map::new();
    args.insert("cmd".to_string(), json!("pwd"));
    CanonicalMessage {
        id: "a1".to_string(),
        role: MessageRole::Assistant,
        content: vec![ContentBlock::ToolCall {
            id: tool_id.to_string(),
            name: "bash".to_string(),
            arguments: args,
            partial_json: None,
            provider_meta: ProviderOpaqueMeta::default(),
        }],
        phase: None,
        provider: Some(provider.to_string()),
        api: Some("openai-responses".to_string()),
        model: Some(model.to_string()),
        stop_reason: Some(StopReason::ToolUse),
        provider_meta: ProviderOpaqueMeta::default(),
        created_at: "2026-11-01T00:00:01Z".to_string(),
    }
}

fn tool_result_for(tool_id: &str) -> CanonicalMessage {
    let mut msg = tool_result();
    if let Some(ContentBlock::ToolResult { tool_call_id, .. }) = msg.content.first_mut() {
        *tool_call_id = tool_id.to_string();
    }
    msg
}

/// Replays `assistant_tool_call` + its result and returns the `function_call` and
/// `function_call_output` items, asserting no synthetic orphan output was emitted.
async fn replay_tool_pair(provider: &str, model: &str, tool_id: &str) -> (Value, Value) {
    let (result, requests) = run_step(
        completed_reply(),
        "gpt-5.5",
        vec![
            user("u1", "pwd?"),
            assistant_tool_call(provider, model, tool_id),
            tool_result_for(tool_id),
            user("u2", "again"),
        ],
    )
    .await;
    result.expect("mock Responses request succeeds");
    let body = requests.into_iter().next().unwrap();
    let input = body["input"].as_array().unwrap().clone();
    assert!(
        !body.to_string().contains("No result provided"),
        "{tool_id}: real result must satisfy the normalized call: {input:#?}"
    );
    let calls: Vec<&Value> = input
        .iter()
        .filter(|item| item["type"] == "function_call")
        .collect();
    let outputs: Vec<&Value> = input
        .iter()
        .filter(|item| item["type"] == "function_call_output")
        .collect();
    assert_eq!(calls.len(), 1, "{input:#?}");
    assert_eq!(outputs.len(), 1, "{input:#?}");
    assert_eq!(outputs[0]["output"], "/tmp");
    (calls[0].clone(), outputs[0].clone())
}

#[tokio::test]
async fn cross_model_normalized_tool_call_id_is_applied_to_its_result() {
    // Trailing `_` on the call part is trimmed by cross-model normalization; the result must
    // follow the same normalized id instead of keeping `call_abc_`.
    let (call, output) = replay_tool_pair("openai", "gpt-5.4", "call_abc_|fc_abc").await;
    assert_eq!(call["call_id"], "call_abc");
    assert!(call.get("id").is_none(), "fc_ item id stripped cross-model");
    assert_eq!(output["call_id"], "call_abc");
}

#[tokio::test]
async fn sanitized_and_truncated_tool_call_id_is_applied_to_its_result() {
    // Foreign-provider history: invalid characters become `_`, the call part is truncated to
    // 64 chars (then trailing `_` trimmed), and the item part gains an `fc_` prefix.
    let long_call = format!("call.{}", "x".repeat(70));
    let raw_id = format!("{long_call}|item:1");
    let (call, output) = replay_tool_pair("azure", "gpt-5.5", &raw_id).await;
    let expected_call = format!("call_{}", "x".repeat(59));
    assert_eq!(expected_call.len(), 64);
    assert_eq!(call["call_id"], expected_call.as_str());
    assert_eq!(call["id"], "fc_item_1");
    assert_eq!(output["call_id"], expected_call.as_str());
}

#[tokio::test]
async fn same_model_tool_call_id_is_replayed_verbatim_for_call_and_result() {
    let (call, output) = replay_tool_pair("openai", "gpt-5.5", "call_abc_|fc_abc").await;
    assert_eq!(call["call_id"], "call_abc_");
    assert_eq!(call["id"], "fc_abc");
    assert_eq!(output["call_id"], "call_abc_");
}
