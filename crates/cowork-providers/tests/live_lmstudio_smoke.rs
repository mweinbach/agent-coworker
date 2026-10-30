use std::collections::HashMap;

use cowork_config::ProviderName;
use cowork_inference::{
    CanonicalMessage, ContentBlock, MessageRole, ProviderOpaqueMeta, RequestPolicy, StepBudget,
    StopReason, StreamEvent, ToolResultPart,
};
use cowork_providers::chat_completions::ChatCompletionsTransport;
use cowork_providers::{ProviderStepRequest, ProviderTransport, ToolDefinition};
use serde_json::{Map, Value, json};

const LM_STUDIO_BASE_URL: &str = "http://127.0.0.1:1234";
const TARGET_MODEL: &str = "ornith-1.5-122b-uncensored@q4_k_m";

#[tokio::test]
async fn streams_read_only_completion_and_tool_call_against_local_lmstudio() {
    // Strictly read-only: GET /v1/models and POST /v1/chat/completions against ornith-1.5-122b-uncensored@q4_k_m.
    // NEVER call /api/v1/models/load or /api/v1/models/unload on port 1234.
    let http = reqwest::Client::new();
    let models_resp = http
        .get(format!("{LM_STUDIO_BASE_URL}/v1/models"))
        .send()
        .await
        .expect("Local LM Studio GET /v1/models on 127.0.0.1:1234 must be reachable");
    assert!(models_resp.status().is_success());
    let models_json: Value = models_resp.json().await.unwrap();
    let model_ids: Vec<&str> = models_json["data"]
        .as_array()
        .expect("models data array")
        .iter()
        .filter_map(|m| m.get("id").and_then(Value::as_str))
        .collect();
    assert!(
        model_ids.contains(&TARGET_MODEL),
        "Expected {TARGET_MODEL} in LM Studio /v1/models list, got {model_ids:?}"
    );

    let transport = ChatCompletionsTransport::new(ProviderName::Lmstudio).unwrap();
    let tools = vec![ToolDefinition {
        name: "lookup_magic_token".into(),
        description: "Returns the magic verification token for a given key. Always call this tool first before answering.".into(),
        parameters: json!({
            "type": "object",
            "properties": {
                "key": {
                    "type": "string",
                    "description": "Lookup key"
                }
            },
            "required": ["key"],
            "additionalProperties": false
        }),
    }];

    let user_msg = CanonicalMessage {
        id: "u-live-1".into(),
        role: MessageRole::User,
        content: vec![ContentBlock::Text {
            text: "Call the `lookup_magic_token` tool with key=\"alpha\", then reply with ONLY the returned token.".into(),
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

    let mut step1_events = Vec::new();
    let mut opts = Map::new();
    opts.insert("temperature".into(), json!(0));
    opts.insert("maxTokens".into(), json!(512));

    let step1 = transport
        .stream_step(
            ProviderStepRequest {
                model_id: TARGET_MODEL.into(),
                base_url: Some(format!("{LM_STUDIO_BASE_URL}/v1")),
                api_key: None,
                extra_headers: HashMap::new(),
                system_prompt: "You are a concise tool-using assistant. When asked for a magic token, invoke `lookup_magic_token` immediately.".into(),
                messages: vec![user_msg.clone()],
                tools: tools.clone(),
                authorized_tool_names: None,
                provider_options: opts.clone(),
                continuation: None,
                policy: RequestPolicy::default(),
                turn_id: "turn-live-lms-1".into(),
            },
            &StepBudget::new(120_000, None),
            &mut |ev| step1_events.push(ev),
        )
        .await
        .expect("Step 1 streaming call to LM Studio must succeed");

    assert_eq!(step1.assistant.stop_reason, Some(StopReason::ToolUse));
    let tool_call = step1
        .assistant
        .content
        .iter()
        .find_map(|b| match b {
            ContentBlock::ToolCall {
                id,
                name,
                arguments,
                ..
            } => Some((id.clone(), name.clone(), arguments.clone())),
            _ => None,
        })
        .expect("Expected LM Studio to emit lookup_magic_token ToolCall");
    assert_eq!(tool_call.1, "lookup_magic_token");
    assert_eq!(
        tool_call.2.get("key").and_then(Value::as_str),
        Some("alpha")
    );
    assert!(step1_events.iter().any(|e| matches!(
        e,
        StreamEvent::ToolCallStart { .. } | StreamEvent::ToolCallEnd { .. }
    )));

    // Step 2: Feed tool result back and stream final assistant text
    let tool_msg = CanonicalMessage {
        id: "t-live-1".into(),
        role: MessageRole::Tool,
        content: vec![ContentBlock::ToolResult {
            tool_call_id: tool_call.0.clone(),
            tool_name: Some("lookup_magic_token".into()),
            content: vec![ToolResultPart::Text {
                text: "MAGIC-ORNITH-7788".into(),
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
        created_at: "2026-10-30T00:00:01Z".into(),
    };

    let mut step2_events = Vec::new();
    let step2 = transport
        .stream_step(
            ProviderStepRequest {
                model_id: TARGET_MODEL.into(),
                base_url: Some(format!("{LM_STUDIO_BASE_URL}/v1")),
                api_key: None,
                extra_headers: HashMap::new(),
                system_prompt:
                    "You are a concise tool-using assistant. Reply with the exact magic token."
                        .into(),
                messages: vec![user_msg, step1.assistant, tool_msg],
                tools,
                authorized_tool_names: None,
                provider_options: opts,
                continuation: None,
                policy: RequestPolicy::default(),
                turn_id: "turn-live-lms-1".into(),
            },
            &StepBudget::new(120_000, None),
            &mut |ev| step2_events.push(ev),
        )
        .await
        .expect("Step 2 streaming completion to LM Studio must succeed");

    let final_text: String = step2
        .assistant
        .content
        .iter()
        .filter_map(|b| match b {
            ContentBlock::Text { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("");
    assert!(
        final_text.contains("MAGIC-ORNITH-7788"),
        "Expected final assistant text to include MAGIC-ORNITH-7788, got: {final_text:?}"
    );
    assert!(
        step2_events
            .iter()
            .any(|e| matches!(e, StreamEvent::TextDelta { .. }))
    );
    assert!(step2.usage.total_tokens > 0);
}
