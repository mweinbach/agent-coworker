//! Gemini replay must only carry Gemini thought signatures: history produced by other providers
//! (Anthropic thinking signatures, OpenAI reasoning JSON) is replayed as plain text, and its
//! foreign signatures are never propagated onto unsigned tool calls.

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
    CanonicalMessage, ContentBlock, MessageRole, ProviderOpaqueMeta, RequestPolicy, StepBudget,
    StopReason, ToolResultPart,
};
use cowork_providers::{
    GoogleInteractionsTransport, ProviderStepRequest, ProviderTransport,
    repair_google_tool_call_signatures,
};
use serde_json::{Map, Value, json};

const GOOGLE_SIG: &str = "c2lnX2dvb2dsZV90aG91Z2h0";
const ANTHROPIC_SIG: &str = "EqQBCkYIBxgCKkDanthropicSignature==";
const OPENAI_REASONING_JSON: &str =
    r#"{"type":"reasoning","id":"rs_foreign","encrypted_content":"enc_openai","summary":[]}"#;

#[derive(Clone, Default)]
struct MockState {
    requests: Arc<Mutex<Vec<Value>>>,
}

async fn handle_interactions(
    State(state): State<MockState>,
    Json(payload): Json<Value>,
) -> Response {
    state.requests.lock().unwrap().push(payload);
    let body = [
        json!({"event_type": "interaction.start", "interaction": {"id": "inter_ok", "status": "in_progress"}}),
        json!({"event_type": "content.start", "index": 0, "content": {"type": "text", "text": ""}}),
        json!({"event_type": "content.delta", "index": 0, "delta": {"type": "text", "text": "done"}}),
        json!({"event_type": "content.stop", "index": 0}),
        json!({"event_type": "interaction.complete", "interaction": {"id": "inter_ok", "status": "completed"}}),
    ]
    .iter()
    .map(|frame| format!("data: {frame}\n\n"))
    .collect::<String>();
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .body(Body::from(body))
        .unwrap()
        .into_response()
}

async fn spawn_mock() -> (String, MockState) {
    let state = MockState::default();
    let app = Router::new()
        .route("/v1beta/interactions", post(handle_interactions))
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("http://{addr}"), state)
}

fn message(
    id: &str,
    role: MessageRole,
    provider: Option<&str>,
    model: Option<&str>,
    content: Vec<ContentBlock>,
) -> CanonicalMessage {
    CanonicalMessage {
        id: id.to_string(),
        role,
        content,
        phase: None,
        provider: provider.map(str::to_string),
        api: None,
        model: model.map(str::to_string),
        stop_reason: (role == MessageRole::Assistant).then_some(StopReason::ToolUse),
        provider_meta: ProviderOpaqueMeta::default(),
        created_at: "2026-11-01T00:00:00Z".to_string(),
    }
}

fn user(id: &str, text: &str) -> CanonicalMessage {
    message(
        id,
        MessageRole::User,
        None,
        None,
        vec![ContentBlock::Text {
            text: text.to_string(),
            phase: None,
            citations: vec![],
            provider_meta: ProviderOpaqueMeta::default(),
        }],
    )
}

fn tool_call(id: &str, meta: ProviderOpaqueMeta) -> ContentBlock {
    let mut args = Map::new();
    args.insert("cmd".to_string(), json!("pwd"));
    ContentBlock::ToolCall {
        id: id.to_string(),
        name: "bash".to_string(),
        arguments: args,
        partial_json: None,
        provider_meta: meta,
    }
}

fn tool_result(id: &str, call_id: &str) -> CanonicalMessage {
    message(
        id,
        MessageRole::Tool,
        None,
        None,
        vec![ContentBlock::ToolResult {
            tool_call_id: call_id.to_string(),
            tool_name: Some("bash".to_string()),
            content: vec![ToolResultPart::Text {
                text: "/tmp".to_string(),
            }],
            structured_meta: None,
            is_error: false,
            provider_meta: ProviderOpaqueMeta::default(),
        }],
    )
}

/// Gemini turn: signed thought followed by an unsigned tool call (repair target).
fn google_assistant() -> CanonicalMessage {
    message(
        "a_google",
        MessageRole::Assistant,
        Some("google"),
        Some("gemini-3.1-pro-preview"),
        vec![
            ContentBlock::Thinking {
                text: "Gemini plan".to_string(),
                summary: Some("Gemini plan".to_string()),
                redacted: false,
                signature: Some(GOOGLE_SIG.to_string()),
                provider_meta: ProviderOpaqueMeta {
                    google_thought_signature: Some(GOOGLE_SIG.to_string()),
                    ..Default::default()
                },
            },
            tool_call("call_g1", ProviderOpaqueMeta::default()),
        ],
    )
}

/// Claude turn: signed thinking + unsigned tool call.
fn anthropic_assistant() -> CanonicalMessage {
    message(
        "a_claude",
        MessageRole::Assistant,
        Some("anthropic"),
        Some("claude-opus-4-7"),
        vec![
            ContentBlock::Thinking {
                text: "Claude reasoning".to_string(),
                summary: None,
                redacted: false,
                signature: Some(ANTHROPIC_SIG.to_string()),
                provider_meta: ProviderOpaqueMeta {
                    anthropic_thinking_signature: Some(ANTHROPIC_SIG.to_string()),
                    ..Default::default()
                },
            },
            ContentBlock::Thinking {
                text: String::new(),
                summary: None,
                redacted: true,
                signature: Some("redacted_blob".to_string()),
                provider_meta: ProviderOpaqueMeta::default(),
            },
            tool_call("toolu_01", ProviderOpaqueMeta::default()),
        ],
    )
}

/// GPT turn: reasoning item (signature = reasoning JSON) + composite-id tool call.
fn openai_assistant() -> CanonicalMessage {
    let mut msg = message(
        "a_gpt",
        MessageRole::Assistant,
        Some("openai"),
        Some("gpt-5.5"),
        vec![
            ContentBlock::Thinking {
                text: "GPT summary".to_string(),
                summary: None,
                redacted: false,
                signature: Some(OPENAI_REASONING_JSON.to_string()),
                provider_meta: ProviderOpaqueMeta {
                    openai_reasoning_item: Some(
                        serde_json::from_str(OPENAI_REASONING_JSON).unwrap(),
                    ),
                    ..Default::default()
                },
            },
            tool_call("call_o1|fc_o1", ProviderOpaqueMeta::default()),
        ],
    );
    msg.api = Some("openai-responses".to_string());
    msg
}

fn includes_thoughts_options() -> Map<String, Value> {
    let mut opts = Map::new();
    opts.insert(
        "google".to_string(),
        json!({"thinkingConfig": {"includeThoughts": true, "thinkingLevel": "high"}}),
    );
    opts
}

async fn send(messages: Vec<CanonicalMessage>) -> Value {
    let (base_url, mock) = spawn_mock().await;
    GoogleInteractionsTransport::new()
        .stream_step(
            ProviderStepRequest {
                model_id: "gemini-3.1-pro-preview".to_string(),
                base_url: Some(base_url),
                api_key: Some("goog-test-key".to_string()),
                extra_headers: HashMap::new(),
                system_prompt: "You are Cowork.".to_string(),
                messages,
                tools: vec![],
                authorized_tool_names: None,
                provider_options: includes_thoughts_options(),
                continuation: None,
                policy: RequestPolicy::default(),
                turn_id: "turn_x".to_string(),
            },
            &StepBudget::new(10_000, None),
            &mut |_| {},
        )
        .await
        .expect("mock Gemini request succeeds");
    let requests = mock.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    requests[0].clone()
}

#[tokio::test]
async fn google_to_google_replay_keeps_thought_signatures_and_repairs_tool_calls() {
    let body = send(vec![
        user("u1", "go"),
        google_assistant(),
        tool_result("t1", "call_g1"),
        user("u2", "next"),
    ])
    .await;

    assert_eq!(
        body["input"],
        json!([
            {"type": "user_input", "content": [{"type": "text", "text": "go"}]},
            {
                "type": "thought",
                "signature": GOOGLE_SIG,
                "summary": [{"type": "text", "text": "Gemini plan"}]
            },
            {
                "type": "function_call",
                "id": "call_g1",
                "name": "bash",
                "arguments": {"cmd": "pwd"},
                "signature": GOOGLE_SIG
            },
            {
                "type": "function_result",
                "call_id": "call_g1",
                "result": "/tmp",
                "is_error": false,
                "name": "bash"
            },
            {"type": "user_input", "content": [{"type": "text", "text": "next"}]}
        ])
    );
    // Every tool call was repaired, so thoughts stay enabled.
    assert_eq!(body["generation_config"]["thinking_summaries"], "auto");
}

#[tokio::test]
async fn foreign_history_replays_reasoning_as_text_without_foreign_signatures() {
    let body = send(vec![
        user("u1", "go"),
        anthropic_assistant(),
        tool_result("t1", "toolu_01"),
        openai_assistant(),
        tool_result("t2", "call_o1|fc_o1"),
        user("u2", "next"),
    ])
    .await;

    assert_eq!(
        body["input"],
        json!([
            {"type": "user_input", "content": [{"type": "text", "text": "go"}]},
            {"type": "model_output", "content": [{"type": "text", "text": "Claude reasoning"}]},
            {
                "type": "function_call",
                "id": "toolu_01",
                "name": "bash",
                "arguments": {"cmd": "pwd"}
            },
            {
                "type": "function_result",
                "call_id": "toolu_01",
                "result": "/tmp",
                "is_error": false,
                "name": "bash"
            },
            {"type": "model_output", "content": [{"type": "text", "text": "GPT summary"}]},
            {
                "type": "function_call",
                "id": "call_o1",
                "name": "bash",
                "arguments": {"cmd": "pwd"}
            },
            {
                "type": "function_result",
                "call_id": "call_o1",
                "result": "/tmp",
                "is_error": false,
                "name": "bash"
            },
            {"type": "user_input", "content": [{"type": "text", "text": "next"}]}
        ])
    );
    let serialized = body.to_string();
    assert!(!serialized.contains(ANTHROPIC_SIG));
    assert!(!serialized.contains("enc_openai"));
    assert!(!serialized.contains("redacted_blob"));
    assert!(
        !body["input"]
            .as_array()
            .unwrap()
            .iter()
            .any(|step| step["type"] == "thought")
    );
    // Foreign tool calls never get a Gemini signature, so they count as unresolved and thought
    // summaries are disabled for this step (same rule as any unsigned replayed tool call).
    assert_eq!(body["generation_config"]["thinking_summaries"], "none");
}

#[tokio::test]
async fn mixed_history_keeps_google_signatures_but_not_foreign_ones() {
    let body = send(vec![
        user("u1", "go"),
        anthropic_assistant(),
        tool_result("t1", "toolu_01"),
        google_assistant(),
        tool_result("t2", "call_g1"),
        user("u2", "next"),
    ])
    .await;

    let steps = body["input"].as_array().unwrap();
    let signed: Vec<(&str, &str)> = steps
        .iter()
        .filter_map(|s| Some((s["type"].as_str()?, s["signature"].as_str()?)))
        .collect();
    assert_eq!(
        signed,
        vec![("thought", GOOGLE_SIG), ("function_call", GOOGLE_SIG)]
    );
    let claude_call = steps
        .iter()
        .find(|s| s["type"] == "function_call" && s["id"] == "toolu_01")
        .unwrap();
    assert!(claude_call.get("signature").is_none());
}

#[test]
fn repair_does_not_propagate_foreign_signatures() {
    let outcome = repair_google_tool_call_signatures(&[
        anthropic_assistant(),
        openai_assistant(),
        google_assistant(),
    ]);
    assert_eq!(outcome.repaired_tool_calls, 1, "only the Gemini tool call");
    assert_eq!(outcome.unresolved_tool_calls, 2, "Claude + GPT tool calls");

    let tool_call_sig = |msg: &CanonicalMessage| {
        msg.content.iter().find_map(|b| match b {
            ContentBlock::ToolCall { provider_meta, .. } => {
                Some(provider_meta.google_thought_signature.clone())
            }
            _ => None,
        })
    };
    assert_eq!(tool_call_sig(&outcome.messages[0]), Some(None));
    assert_eq!(tool_call_sig(&outcome.messages[1]), Some(None));
    assert_eq!(
        tool_call_sig(&outcome.messages[2]),
        Some(Some(GOOGLE_SIG.to_string()))
    );
}

#[test]
fn repair_trusts_only_google_field_for_unstamped_history() {
    // Legacy history without a provider stamp: the generic `signature` may be foreign, so only
    // the Google-specific `google_thought_signature` field is propagated.
    let mut generic_only = google_assistant();
    generic_only.provider = None;
    if let ContentBlock::Thinking { provider_meta, .. } = &mut generic_only.content[0] {
        provider_meta.google_thought_signature = None;
    }
    let outcome = repair_google_tool_call_signatures(&[generic_only]);
    assert_eq!(outcome.repaired_tool_calls, 0);
    assert_eq!(outcome.unresolved_tool_calls, 1);

    let mut google_field = google_assistant();
    google_field.provider = None;
    let outcome = repair_google_tool_call_signatures(&[google_field]);
    assert_eq!(outcome.repaired_tool_calls, 1);
    assert_eq!(outcome.unresolved_tool_calls, 0);
}
