use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::{
    Json, Router,
    body::Body,
    extract::State,
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::post,
};
use cowork_inference::{
    CanonicalMessage, ContentBlock, MessageRole, ProviderOpaqueMeta, RequestPolicy, StepBudget,
    StreamEvent, TextPhase, ToolResultPart,
};
use cowork_providers::{
    OpenAiResponsesTransport, ProviderStepRequest, ProviderTransport, ToolDefinition,
};
use serde_json::{Map, Value, json};

#[derive(Clone, Default)]
struct MockOpenAiState {
    requests: Arc<Mutex<Vec<(HeaderMap, Value)>>>,
    responses: Arc<Mutex<Vec<MockSseReply>>>,
}

#[derive(Clone)]
struct MockSseReply {
    status: StatusCode,
    headers: Vec<(String, String)>,
    body: String,
}

async fn handle_responses(
    State(state): State<MockOpenAiState>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Response {
    state.requests.lock().unwrap().push((headers, payload));
    let reply = state.responses.lock().unwrap().remove(0);

    let mut builder = Response::builder().status(reply.status);
    for (k, v) in reply.headers {
        builder = builder.header(k, v);
    }
    builder = builder.header(header::CONTENT_TYPE, "text/event-stream");
    builder
        .body(Body::from(reply.body))
        .expect("mock SSE response")
        .into_response()
}

async fn spawn_mock_openai_server(replies: Vec<MockSseReply>) -> (String, MockOpenAiState) {
    let state = MockOpenAiState {
        requests: Arc::new(Mutex::new(Vec::new())),
        responses: Arc::new(Mutex::new(replies)),
    };
    let app = Router::new()
        .route("/v1/responses", post(handle_responses))
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral 127.0.0.1:0");
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("http://{addr}/v1"), state)
}

fn sse_frame(data: Value) -> String {
    format!("data: {data}\n\n")
}

#[tokio::test]
async fn openai_responses_sse_handles_encrypted_reasoning_commentary_composite_ids_and_continuation()
 {
    let step1_sse = [
        sse_frame(json!({
            "type": "response.created",
            "response": {"id": "resp_step_1", "status": "in_progress", "unknown_vendor_field": {"ok": true}}
        })),
        sse_frame(json!({
            "type": "response.output_item.added",
            "item": {"id": "rs_001", "type": "reasoning", "summary": []}
        })),
        sse_frame(json!({
            "type": "response.reasoning_summary_part.added",
            "part": {"type": "summary_text", "text": ""}
        })),
        sse_frame(json!({
            "type": "response.reasoning_summary_text.delta",
            "delta": "Inspecting workspace."
        })),
        sse_frame(json!({
            "type": "response.output_item.done",
            "item": {
                "id": "rs_001",
                "type": "reasoning",
                "encrypted_content": "enc_blob_step_1",
                "summary": [{"type": "summary_text", "text": "Inspecting workspace."}]
            }
        })),
        // Commentary phase message (streamed live, omitted from persisted assistant history)
        sse_frame(json!({
            "type": "response.output_item.added",
            "item": {"id": "msg_comm_1", "type": "message", "phase": "commentary", "content": []}
        })),
        sse_frame(json!({
            "type": "response.content_part.added",
            "part": {"type": "output_text", "text": ""}
        })),
        sse_frame(json!({
            "type": "response.output_text.delta",
            "delta": "Running pwd now."
        })),
        sse_frame(json!({
            "type": "response.output_item.done",
            "item": {
                "id": "msg_comm_1",
                "type": "message",
                "phase": "commentary",
                "content": [{"type": "output_text", "text": "Running pwd now."}]
            }
        })),
        // Function call with composite call_id|item.id
        sse_frame(json!({
            "type": "response.output_item.added",
            "item": {
                "id": "fc_item_42",
                "call_id": "call_xyz",
                "type": "function_call",
                "name": "bash",
                "arguments": ""
            }
        })),
        sse_frame(json!({
            "type": "response.function_call_arguments.delta",
            "delta": "{\"cmd\":\"pw"
        })),
        sse_frame(json!({
            "type": "response.function_call_arguments.delta",
            "delta": "d\"}"
        })),
        sse_frame(json!({
            "type": "response.output_item.done",
            "item": {
                "id": "fc_item_42",
                "call_id": "call_xyz",
                "type": "function_call",
                "name": "bash",
                "arguments": "{\"cmd\":\"pwd\"}"
            }
        })),
        sse_frame(json!({
            "type": "response.completed",
            "response": {
                "id": "resp_step_1",
                "status": "completed",
                "usage": {
                    "input_tokens": 1200,
                    "input_tokens_details": {"cached_tokens": 400},
                    "output_tokens": 90,
                    "output_tokens_details": {"reasoning_tokens": 35},
                    "total_tokens": 1290
                }
            }
        })),
    ]
    .concat();

    let step2_sse = [
        sse_frame(json!({
            "type": "response.created",
            "response": {"id": "resp_step_2", "status": "in_progress"}
        })),
        sse_frame(json!({
            "type": "response.output_item.added",
            "item": {"id": "msg_final_2", "type": "message", "phase": "final_answer", "content": []}
        })),
        sse_frame(json!({
            "type": "response.content_part.added",
            "part": {"type": "output_text", "text": ""}
        })),
        sse_frame(json!({
            "type": "response.output_text.delta",
            "delta": "Working directory is /private/tmp."
        })),
        sse_frame(json!({
            "type": "response.output_item.done",
            "item": {
                "id": "msg_final_2",
                "type": "message",
                "phase": "final_answer",
                "content": [{
                    "type": "output_text",
                    "text": "Working directory is /private/tmp.",
                    "annotations": [{"type": "url_citation", "url": "https://openai.com", "title": "OpenAI"}]
                }]
            }
        })),
        sse_frame(json!({
            "type": "response.completed",
            "response": {
                "id": "resp_step_2",
                "status": "completed",
                "usage": {
                    "input_tokens": 1400,
                    "input_tokens_details": {"cached_tokens": 1000},
                    "output_tokens": 25,
                    "total_tokens": 1425
                }
            }
        })),
    ]
    .concat();

    let step3_replayed_after_tool_change_sse = [
        sse_frame(json!({
            "type": "response.created",
            "response": {"id": "resp_step_3", "status": "in_progress"}
        })),
        sse_frame(json!({
            "type": "response.output_item.added",
            "item": {"id": "msg_final_3", "type": "message", "phase": "final_answer", "content": []}
        })),
        sse_frame(json!({
            "type": "response.content_part.added",
            "part": {"type": "output_text", "text": ""}
        })),
        sse_frame(json!({
            "type": "response.output_text.delta",
            "delta": "Replayed cleanly with encrypted reasoning."
        })),
        sse_frame(json!({
            "type": "response.output_item.done",
            "item": {
                "id": "msg_final_3",
                "type": "message",
                "phase": "final_answer",
                "content": [{"type": "output_text", "text": "Replayed cleanly with encrypted reasoning."}]
            }
        })),
        sse_frame(json!({
            "type": "response.completed",
            "response": {
                "id": "resp_step_3",
                "status": "completed",
                "usage": {"input_tokens": 1500, "output_tokens": 20, "total_tokens": 1520}
            }
        })),
    ]
    .concat();

    let (base_url, mock) = spawn_mock_openai_server(vec![
        // Inject a pre-first-token 429 with retry-after-ms to verify transport + reliability integration!
        MockSseReply {
            status: StatusCode::TOO_MANY_REQUESTS,
            headers: vec![("retry-after-ms".to_string(), "10".to_string())],
            body: "{\"error\":{\"message\":\"rate limit\"}}".to_string(),
        },
        MockSseReply {
            status: StatusCode::OK,
            headers: vec![],
            body: step1_sse,
        },
        MockSseReply {
            status: StatusCode::OK,
            headers: vec![],
            body: step2_sse,
        },
        MockSseReply {
            status: StatusCode::OK,
            headers: vec![],
            body: step3_replayed_after_tool_change_sse,
        },
    ])
    .await;

    let transport = OpenAiResponsesTransport::new();
    let user_msg = CanonicalMessage {
        id: "u1".to_string(),
        role: MessageRole::User,
        phase: None,
        provider: None,
        api: None,
        model: None,
        stop_reason: None,
        provider_meta: ProviderOpaqueMeta::default(),
        created_at: "2026-10-30T00:00:00Z".to_string(),
        content: vec![ContentBlock::Text {
            text: "Check pwd".to_string(),
            phase: None,
            citations: vec![],
            provider_meta: ProviderOpaqueMeta::default(),
        }],
    };
    let bash_tool = ToolDefinition {
        name: "bash".to_string(),
        description: "Run shell command".to_string(),
        parameters: json!({"type": "object", "properties": {"cmd": {"type": "string"}}}),
    };

    let mut opts = Map::new();
    opts.insert("reasoningEffort".to_string(), json!("max")); // normalized to xhigh on gpt-5.4!
    opts.insert("reasoningSummary".to_string(), json!("detailed"));

    let mut streamed_events_step1 = Vec::new();
    let budget1 = StepBudget::new(10_000, None);
    let res1 = transport
        .stream_step(
            ProviderStepRequest {
                model_id: "gpt-5.4".to_string(),
                base_url: Some(base_url.clone()),
                api_key: Some("sk-test-openai".to_string()),
                extra_headers: HashMap::new(),
                system_prompt: "You are Cowork.".to_string(),
                messages: vec![user_msg.clone()],
                tools: vec![bash_tool.clone()],
                authorized_tool_names: None,
                provider_options: opts.clone(),
                continuation: None,
                policy: RequestPolicy {
                    base_delay_ms: 10,
                    ..RequestPolicy::default()
                },
                turn_id: "turn_1".to_string(),
            },
            &budget1,
            &mut |ev| streamed_events_step1.push(ev),
        )
        .await
        .expect("step 1 succeeds after 429 retry");

    // Verify commentary was streamed live, composite tool call ID `call_xyz|fc_item_42` preserved,
    // and commentary omitted from persisted_assistant!
    assert!(streamed_events_step1.iter().any(|ev| matches!(
        ev,
        StreamEvent::TextDelta {
            phase: Some(TextPhase::Commentary),
            delta,
            ..
        } if delta == "Running pwd now."
    )));
    let persisted1 = res1.persisted_assistant.clone().expect("persisted step 1");
    assert!(!persisted1.content.iter().any(|b| matches!(
        b,
        ContentBlock::Text {
            phase: Some(TextPhase::Commentary),
            ..
        }
    )));
    let tool_call = persisted1
        .content
        .iter()
        .find_map(|b| match b {
            ContentBlock::ToolCall { id, arguments, .. } => Some((id.clone(), arguments.clone())),
            _ => None,
        })
        .expect("composite tool call");
    assert_eq!(tool_call.0, "call_xyz|fc_item_42");
    assert_eq!(tool_call.1.get("cmd"), Some(&json!("pwd")));
    assert_eq!(res1.usage.prompt_tokens, 1200);
    assert_eq!(res1.usage.cached_prompt_tokens, Some(400));
    assert_eq!(res1.usage.reasoning_output_tokens, Some(35));

    // Step 2: Send tool result with stored continuation -> MUST use `previous_response_id: "resp_step_1"`
    // and delta input `function_call_output` with `call_id: "call_xyz"`!
    let tool_result_msg = CanonicalMessage {
        id: "tr1".to_string(),
        role: MessageRole::Tool,
        phase: None,
        provider: None,
        api: None,
        model: None,
        stop_reason: None,
        provider_meta: ProviderOpaqueMeta::default(),
        created_at: "2026-10-30T00:00:01Z".to_string(),
        content: vec![ContentBlock::ToolResult {
            tool_call_id: "call_xyz|fc_item_42".to_string(),
            tool_name: Some("bash".to_string()),
            content: vec![ToolResultPart::Text {
                text: "/private/tmp".to_string(),
            }],
            structured_meta: None,
            is_error: false,
            provider_meta: ProviderOpaqueMeta::default(),
        }],
    };

    let full_history_step2 = vec![
        user_msg.clone(),
        persisted1.clone(),
        tool_result_msg.clone(),
    ];
    let budget2 = StepBudget::new(10_000, None);
    let res2 = transport
        .stream_step(
            ProviderStepRequest {
                model_id: "gpt-5.4".to_string(),
                base_url: Some(base_url.clone()),
                api_key: Some("sk-test-openai".to_string()),
                extra_headers: HashMap::new(),
                system_prompt: "You are Cowork.".to_string(),
                messages: full_history_step2.clone(),
                tools: vec![bash_tool.clone()],
                authorized_tool_names: None,
                provider_options: opts.clone(),
                continuation: res1.continuation.clone(),
                policy: RequestPolicy::default(),
                turn_id: "turn_1".to_string(),
            },
            &budget2,
            &mut |_| {},
        )
        .await
        .expect("step 2 stateful continuation succeeds");

    // Step 3: Mutate system prompt on GPT-6 Astra (`gpt-6-astra`) -> continuation invalidated via SHA-256
    // AND Astra parameter rules applied (none -> low, strip temperature/top_p/logprobs, prompt_cache_options.ttl="30m",
    // EU residency strips service_tier="fast", encrypted reasoning replayed in full history)!
    let mut astra_opts = Map::new();
    astra_opts.insert("reasoningEffort".to_string(), json!("none"));
    astra_opts.insert("temperature".to_string(), json!(0.7));
    astra_opts.insert("topP".to_string(), json!(0.9));
    astra_opts.insert("promptCacheRetention".to_string(), json!("short"));
    astra_opts.insert("serviceTier".to_string(), json!("fast"));
    astra_opts.insert("dataResidency".to_string(), json!("eu"));
    astra_opts.insert(
        "include".to_string(),
        json!(["message.output_text.logprobs"]),
    );

    let follow_up_user = CanonicalMessage {
        id: "u2".to_string(),
        role: MessageRole::User,
        phase: None,
        provider: None,
        api: None,
        model: None,
        stop_reason: None,
        provider_meta: ProviderOpaqueMeta::default(),
        created_at: "2026-10-30T00:00:02Z".to_string(),
        content: vec![ContentBlock::Text {
            text: "Summarize".to_string(),
            phase: None,
            citations: vec![],
            provider_meta: ProviderOpaqueMeta::default(),
        }],
    };
    let full_history_step3 = vec![
        user_msg,
        persisted1,
        tool_result_msg,
        res2.persisted_assistant.unwrap(),
        follow_up_user,
    ];

    let budget3 = StepBudget::new(10_000, None);
    let _res3 = transport
        .stream_step(
            ProviderStepRequest {
                model_id: "gpt-6-astra".to_string(),
                base_url: Some(base_url),
                api_key: Some("sk-test-openai".to_string()),
                extra_headers: HashMap::new(),
                system_prompt: "Updated Astra instructions.".to_string(),
                messages: full_history_step3,
                tools: vec![bash_tool],
                authorized_tool_names: None,
                provider_options: astra_opts,
                continuation: res2.continuation,
                policy: RequestPolicy::default(),
                turn_id: "turn_2".to_string(),
            },
            &budget3,
            &mut |_| {},
        )
        .await
        .expect("step 3 Astra replay succeeds");

    let recorded = mock.requests.lock().unwrap();
    assert_eq!(recorded.len(), 4); // 2 attempts for step 1 (429 + 200) + step 2 + step 3

    // Verify Step 1 request payload
    let (_, req1) = &recorded[1];
    assert_eq!(req1["reasoning"]["effort"], "xhigh");
    assert!(req1.get("previous_response_id").is_none());
    assert!(
        req1["include"]
            .as_array()
            .unwrap()
            .contains(&json!("reasoning.encrypted_content"))
    );

    // Verify Step 2 stateful continuation request payload
    let (_, req2) = &recorded[2];
    assert_eq!(req2["previous_response_id"], "resp_step_1");
    assert_eq!(req2["truncation"], "auto");
    let req2_input = req2["input"].as_array().unwrap();
    assert_eq!(req2_input.len(), 1);
    assert_eq!(req2_input[0]["type"], "function_call_output");
    assert_eq!(req2_input[0]["call_id"], "call_xyz");

    // Verify Step 3 Astra rules + invalidated continuation + replayed encrypted reasoning + cross-model fc_ strip!
    let (_, req3) = &recorded[3];
    assert!(
        req3.get("previous_response_id").is_none(),
        "continuation must invalidate when model/system/options change"
    );
    assert_eq!(req3["reasoning"]["effort"], "low"); // Astra migrates none -> low
    assert!(req3.get("temperature").is_none());
    assert!(req3.get("top_p").is_none());
    assert!(req3.get("prompt_cache_retention").is_none());
    assert_eq!(req3["prompt_cache_options"]["ttl"], "30m");
    assert!(
        req3.get("service_tier").is_none(),
        "Astra EU residency forbids fast/priority service_tier"
    );
    assert!(
        !req3["include"]
            .as_array()
            .unwrap()
            .contains(&json!("message.output_text.logprobs"))
    );
    let req3_input = req3["input"].as_array().unwrap();
    // Encrypted reasoning item from step 1 replayed!
    assert!(req3_input.iter().any(|item| {
        item["type"] == "reasoning" && item["encrypted_content"] == "enc_blob_step_1"
    }));
    // Cross-model replay (`gpt-5.4` -> `gpt-6-astra`) strips `fc_` item id on function_call!
    let replayed_fc = req3_input
        .iter()
        .find(|item| item["type"] == "function_call")
        .expect("replayed function_call");
    assert_eq!(replayed_fc["call_id"], "call_xyz");
    assert!(replayed_fc.get("id").is_none() || replayed_fc["id"].is_null());
}

#[tokio::test]
async fn openai_responses_sse_handles_interleaved_parallel_tool_calls_and_midstream_non_retry() {
    let parallel_sse = [
        sse_frame(json!({
            "type": "response.created",
            "response": { "id": "resp_parallel_1", "status": "in_progress" }
        })),
        sse_frame(json!({
            "type": "response.output_item.added",
            "output_index": 0,
            "item": { "id": "fc_p0", "type": "function_call", "call_id": "call_p0", "name": "read", "arguments": "" }
        })),
        sse_frame(json!({
            "type": "response.output_item.added",
            "output_index": 1,
            "item": { "id": "fc_p1", "type": "function_call", "call_id": "call_p1", "name": "glob", "arguments": "" }
        })),
        sse_frame(json!({
            "type": "response.function_call_arguments.delta",
            "output_index": 0,
            "item_id": "fc_p0",
            "delta": "{\"path\":\"a.rs\"}"
        })),
        sse_frame(json!({
            "type": "response.function_call_arguments.delta",
            "output_index": 1,
            "item_id": "fc_p1",
            "delta": "{\"pattern\":\"*.toml\"}"
        })),
        sse_frame(json!({
            "type": "response.output_item.done",
            "output_index": 0,
            "item": { "id": "fc_p0", "type": "function_call", "call_id": "call_p0", "name": "read", "arguments": "{\"path\":\"a.rs\"}" }
        })),
        sse_frame(json!({
            "type": "response.output_item.done",
            "output_index": 1,
            "item": { "id": "fc_p1", "type": "function_call", "call_id": "call_p1", "name": "glob", "arguments": "{\"pattern\":\"*.toml\"}" }
        })),
        sse_frame(json!({
            "type": "response.completed",
            "response": {
                "id": "resp_parallel_1",
                "status": "completed",
                "usage": { "input_tokens": 50, "output_tokens": 30 }
            }
        })),
        "data: [DONE]\n\n".to_string(),
    ]
    .concat();

    // Second reply emits a visible text delta and then truncates before `response.completed`.
    let midstream_truncated_sse = [
        sse_frame(json!({
            "type": "response.created",
            "response": { "id": "resp_trunc", "status": "in_progress" }
        })),
        sse_frame(json!({
            "type": "response.output_item.added",
            "output_index": 0,
            "item": { "id": "msg_trunc", "type": "message", "role": "assistant", "phase": "final_answer", "content": [] }
        })),
        sse_frame(json!({
            "type": "response.output_text.delta",
            "output_index": 0,
            "delta": "Partial visible output..."
        })),
    ]
    .concat();

    let (base_url, mock) = spawn_mock_openai_server(vec![
        MockSseReply {
            status: StatusCode::OK,
            headers: vec![],
            body: parallel_sse,
        },
        MockSseReply {
            status: StatusCode::OK,
            headers: vec![],
            body: midstream_truncated_sse,
        },
        MockSseReply {
            status: StatusCode::OK,
            headers: vec![],
            body: String::new(),
        },
    ])
    .await;

    let transport = OpenAiResponsesTransport::new();
    let user_msg = CanonicalMessage {
        id: "u_p".to_string(),
        role: MessageRole::User,
        phase: None,
        provider: None,
        api: None,
        model: None,
        stop_reason: None,
        provider_meta: ProviderOpaqueMeta::default(),
        created_at: "2026-10-30T00:00:00Z".to_string(),
        content: vec![ContentBlock::Text {
            text: "Inspect files in parallel".to_string(),
            phase: None,
            citations: vec![],
            provider_meta: ProviderOpaqueMeta::default(),
        }],
    };

    let budget = StepBudget::new(10_000, None);
    let res = transport
        .stream_step(
            ProviderStepRequest {
                model_id: "gpt-5.4".to_string(),
                base_url: Some(base_url.clone()),
                api_key: Some("sk-test".to_string()),
                extra_headers: HashMap::new(),
                system_prompt: "System".to_string(),
                messages: vec![user_msg.clone()],
                tools: vec![],
                authorized_tool_names: None,
                provider_options: Map::new(),
                continuation: None,
                policy: RequestPolicy::default(),
                turn_id: "turn_par".to_string(),
            },
            &budget,
            &mut |_| {},
        )
        .await
        .expect("parallel tool calls succeed");

    assert_eq!(res.assistant.content.len(), 2);
    match (&res.assistant.content[0], &res.assistant.content[1]) {
        (
            ContentBlock::ToolCall {
                id: id0,
                name: n0,
                arguments: a0,
                ..
            },
            ContentBlock::ToolCall {
                id: id1,
                name: n1,
                arguments: a1,
                ..
            },
        ) => {
            assert_eq!(id0, "call_p0|fc_p0");
            assert_eq!(n0, "read");
            assert_eq!(a0["path"], "a.rs");
            assert_eq!(id1, "call_p1|fc_p1");
            assert_eq!(n1, "glob");
            assert_eq!(a1["pattern"], "*.toml");
        }
        other => panic!("expected 2 parallel tool calls, got {other:?}"),
    }

    // Now verify mid-stream truncation after visible output does NOT retry!
    let mut streamed = Vec::new();
    let err = transport
        .stream_step(
            ProviderStepRequest {
                model_id: "gpt-5.4".to_string(),
                base_url: Some(base_url),
                api_key: Some("sk-test".to_string()),
                extra_headers: HashMap::new(),
                system_prompt: "System".to_string(),
                messages: vec![user_msg],
                tools: vec![],
                authorized_tool_names: None,
                provider_options: Map::new(),
                continuation: None,
                policy: RequestPolicy::default(),
                turn_id: "turn_trunc".to_string(),
            },
            &budget,
            &mut |ev| streamed.push(ev),
        )
        .await
        .expect_err("mid-stream truncation after visible delta must error without retry");

    assert!(err.message.contains("ended before completion"));
    assert!(
        streamed
            .iter()
            .any(|ev| matches!(ev, StreamEvent::TextDelta { delta, .. } if delta == "Partial visible output..."))
    );
    // Exactly 2 HTTP calls total (1 for parallel, 1 for truncated — zero duplicate retries!).
    assert_eq!(mock.requests.lock().unwrap().len(), 2);
}
