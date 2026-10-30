use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use axum::routing::{get, post};
use cowork_config::ProviderName;
use cowork_inference::{
    CanonicalMessage, ContentBlock, InferenceModelRegistry, MessageRole, ProviderOpaqueMeta,
    RequestPolicy, StepBudget, StopReason, StreamEvent,
};
use cowork_providers::chat_completions::{
    ChatCompletionsTransport, FIREWORKS_TOOL_SCHEMA_MAX_BYTES,
    FIREWORKS_TOTAL_TOOL_SCHEMA_MAX_BYTES, LmStudioControlClient, ProviderQuirks,
    ThinkTagSplitState, flush_think_tag_split_state, is_loopback_lmstudio_url,
    is_opencode_model_supported, is_user_facing_provider_enabled, normalize_lmstudio_base_url,
    normalize_null_tool_arguments, normalize_nvidia_chat_completions_body,
    resolve_lmstudio_options, sanitize_tools_for_provider, split_think_tagged_text,
    split_think_tagged_text_chunk,
};
use cowork_providers::{ProviderStepRequest, ProviderTransport, ToolDefinition};
use serde_json::{Map, Value, json};
use tokio::net::TcpListener;
use uuid::Uuid;

fn make_user_message(text: &str) -> CanonicalMessage {
    CanonicalMessage {
        id: format!("msg-{}", Uuid::new_v4()),
        role: MessageRole::User,
        content: vec![ContentBlock::Text {
            text: text.to_string(),
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
        created_at: "2026-10-30T00:00:00Z".to_string(),
    }
}

#[tokio::test]
async fn streams_reasoning_content_and_ignores_extra_provider_fields() {
    let captured_bodies: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
    let state = captured_bodies.clone();

    let app = Router::new().route(
        "/v1/chat/completions",
        post(move |State(store): State<Arc<Mutex<Vec<Value>>>>, body: String| async move {
            store
                .lock()
                .unwrap()
                .push(serde_json::from_str(&body).unwrap_or(Value::Null));

            let sse = concat!(
                "data: {\"id\":\"chatcmpl-1\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"reasoning_content\":\"Let me check \"}}],\"stats\":{\"tokens_per_second\":42.5}}\n\n",
                "data: {\"id\":\"chatcmpl-1\",\"choices\":[{\"index\":0,\"delta\":{\"reasoning_content\":\"the workspace.\"}}],\"model_info\":{\"arch\":\"qwen\"}}\n\n",
                "data: {\"id\":\"chatcmpl-1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Reading file...\",\"tool_calls\":[{\"index\":0,\"id\":\"call_lms_1\",\"type\":\"function\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{\\\"path\\\":\\\"\"}}]}}]}\n\n",
                "data: {\"id\":\"chatcmpl-1\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"README.md\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":25,\"completion_tokens\":14,\"prompt_tokens_details\":{\"cached_tokens\":5}},\"stats\":{\"stop_type\":\"eos\"}}\n\n",
                "data: [DONE]\n\n"
            );

            Response::builder()
                .status(StatusCode::OK)
                .header("content-type", "text/event-stream")
                .body(Body::from(sse))
                .unwrap()
        }),
    ).with_state(state);

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    let transport = ChatCompletionsTransport::new(ProviderName::Lmstudio)
        .expect("lmstudio maps to ChatCompletionsTransport");

    let mut events = Vec::new();
    let budget = StepBudget::new(30_000, None);
    let result = transport
        .stream_step(
            ProviderStepRequest {
                model_id: "ornith-1.5-122b-uncensored@q4_k_m".into(),
                base_url: Some(format!("http://127.0.0.1:{port}/v1")),
                api_key: None,
                extra_headers: HashMap::new(),
                system_prompt: "You are a helpful coding assistant.".into(),
                messages: vec![make_user_message("Read README.md")],
                tools: vec![ToolDefinition {
                    name: "read_file".into(),
                    description: "Read a file".into(),
                    parameters: json!({
                        "type": "object",
                        "properties": { "path": { "type": "string" } },
                        "required": ["path"]
                    }),
                }],
                authorized_tool_names: None,
                provider_options: Map::new(),
                continuation: None,
                policy: RequestPolicy::default(),
                turn_id: "turn-lms-1".into(),
            },
            &budget,
            &mut |ev| events.push(ev),
        )
        .await
        .expect("LM Studio SSE with extra stats/model_info fields must succeed");

    server.abort();

    assert_eq!(result.assistant.stop_reason, Some(StopReason::ToolUse));
    assert_eq!(result.usage.prompt_tokens, 25);
    assert_eq!(result.usage.completion_tokens, 14);
    assert_eq!(result.usage.cached_prompt_tokens, Some(5));

    let has_thinking = result.assistant.content.iter().any(|b| {
        matches!(b, ContentBlock::Thinking { text, .. } if text == "Let me check the workspace.")
    });
    assert!(has_thinking, "Expected reasoning_content Thinking block");

    let has_tool = result.assistant.content.iter().any(|b| {
        matches!(
            b,
            ContentBlock::ToolCall { id, name, arguments, .. }
                if id == "call_lms_1"
                && name == "read_file"
                && arguments.get("path").and_then(Value::as_str) == Some("README.md")
        )
    });
    assert!(has_tool, "Expected assembled read_file ToolCall block");
    assert!(
        events
            .iter()
            .any(|e| matches!(e, StreamEvent::ThinkingDelta { .. })),
        "Expected streaming ThinkingDelta events"
    );
    assert!(
        events
            .iter()
            .any(|e| matches!(e, StreamEvent::ToolCallDelta { .. })),
        "Expected streaming ToolCallDelta events"
    );
}

#[tokio::test]
async fn splits_minimax_inline_think_tags_across_arbitrary_chunk_boundaries() {
    // 1. Deterministic 1-byte chunk unit check including attributes, <thinker> false-positive guard, and EOF flush
    let full = "Hello <think data-provider=\"minimax\">secret plan</think> world with <thinker> tag and trailing <thi";
    let mut state = ThinkTagSplitState::default();
    let mut acc_think = String::new();
    let mut acc_vis = String::new();
    for ch in full.chars() {
        let mut buf = [0u8; 4];
        let s = ch.encode_utf8(&mut buf);
        let part = split_think_tagged_text_chunk(&mut state, s);
        acc_think.push_str(&part.thinking_text);
        acc_vis.push_str(&part.visible_text);
    }
    let tail = flush_think_tag_split_state(&mut state);
    acc_think.push_str(&tail.thinking_text);
    acc_vis.push_str(&tail.visible_text);

    assert_eq!(acc_think, "secret plan");
    assert_eq!(acc_vis, "Hello  world with <thinker> tag and trailing <thi");

    let batch = split_think_tagged_text("<THINK>\nstep 1\n</THINK>Final answer.");
    assert_eq!(batch.thinking_text, "\nstep 1\n");
    assert_eq!(batch.visible_text, "Final answer.");

    // 2. End-to-end MiniMax SSE wire stream splitting <think> across SSE frames
    let app = Router::new().route(
        "/v1/chat/completions",
        post(|| async move {
            let chunks = [
                "<th",
                "ink data-p=",
                "\"m\">Plan ",
                "carefully</th",
                "ink>Visible ",
                "answer!",
            ];
            let mut body = String::new();
            for piece in chunks {
                let frame = json!({
                    "id": "mm-1",
                    "choices": [{
                        "index": 0,
                        "delta": { "content": piece }
                    }]
                });
                body.push_str(&format!("data: {frame}\n\n"));
            }
            body.push_str("data: {\"id\":\"mm-1\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n");
            body.push_str("data: [DONE]\n\n");

            Response::builder()
                .status(StatusCode::OK)
                .header("content-type", "text/event-stream")
                .body(Body::from(body))
                .unwrap()
        }),
    );

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    let transport = ChatCompletionsTransport::new(ProviderName::Minimax).unwrap();
    let mut events = Vec::new();
    let res = transport
        .stream_step(
            ProviderStepRequest {
                model_id: "MiniMax-M3".into(),
                base_url: Some(format!("http://127.0.0.1:{port}/v1")),
                api_key: Some("mm-test-key".into()),
                extra_headers: HashMap::new(),
                system_prompt: "System".into(),
                messages: vec![make_user_message("Hi")],
                tools: Vec::new(),
                authorized_tool_names: None,
                provider_options: Map::new(),
                continuation: None,
                policy: RequestPolicy::default(),
                turn_id: "turn-mm".into(),
            },
            &StepBudget::new(30_000, None),
            &mut |e| events.push(e),
        )
        .await
        .unwrap();

    server.abort();

    assert!(events.iter().any(|e| matches!(
        e,
        StreamEvent::ThinkingStart { stream_id, .. } if stream_id.ends_with(":think")
    )));
    assert_eq!(res.assistant.content.len(), 2);
    assert!(matches!(
        &res.assistant.content[0],
        ContentBlock::Thinking { text, .. } if text == "Plan carefully"
    ));
    assert!(matches!(
        &res.assistant.content[1],
        ContentBlock::Text { text, .. } if text == "Visible answer!"
    ));
}

#[test]
fn sanitizes_fireworks_and_firepass_tool_schemas_within_size_caps() {
    let huge_desc = "x".repeat(4500);
    let tools = vec![
        // Tool 1: fits within 4KB after stripping unsupported keys & collapsing tuple/oneOf
        ToolDefinition {
            name: "small_tool".into(),
            description: "Small".into(),
            parameters: json!({
                "$schema": "https://json-schema.org/draft/2020-12/schema",
                "type": "object",
                "properties": {
                    "code": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 100,
                        "pattern": "^[a-z]+$"
                    },
                    "pair": {
                        "type": "array",
                        "prefixItems": [{ "type": "string" }, { "type": "number" }],
                        "additionalItems": false
                    },
                    "choice": {
                        "oneOf": [{ "type": "string" }, { "type": "integer" }]
                    }
                },
                "required": ["code"]
            }),
        },
        // Tool 2: >4KB due to massive nested descriptions -> falls back to shallow shape-preserving object
        ToolDefinition {
            name: "oversized_tool_a".into(),
            description: "Oversized A".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "alpha": { "type": "string", "description": huge_desc },
                    "beta": { "type": "number" }
                },
                "required": ["alpha"]
            }),
        },
        // Tools 3..6: ~3.5KB each so cumulative budget crosses 12KB on the later tools -> relaxed fallback
        ToolDefinition {
            name: "medium_1".into(),
            description: "M1".into(),
            parameters: json!({
                "type": "object",
                "properties": { "p": { "type": "string", "description": "a".repeat(3400) } }
            }),
        },
        ToolDefinition {
            name: "medium_2".into(),
            description: "M2".into(),
            parameters: json!({
                "type": "object",
                "properties": { "p": { "type": "string", "description": "b".repeat(3400) } }
            }),
        },
        ToolDefinition {
            name: "medium_3".into(),
            description: "M3".into(),
            parameters: json!({
                "type": "object",
                "properties": { "p": { "type": "string", "description": "c".repeat(3400) } }
            }),
        },
        ToolDefinition {
            name: "medium_4_exceeds_total".into(),
            description: "M4".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "prop_1": { "type": "string", "description": "d".repeat(3400) }
                }
            }),
        },
    ];

    for provider in [ProviderName::Fireworks, ProviderName::Firepass] {
        let sanitized = sanitize_tools_for_provider(provider, &tools);
        assert_eq!(sanitized.len(), 6);

        // Tool 1 assertions: $schema, minLength, maxLength, pattern, prefixItems, maxItems, oneOf all stripped/converted
        let t1 = &sanitized[0].parameters;
        assert!(t1.get("$schema").is_none());
        assert!(t1["properties"]["code"].get("minLength").is_none());
        assert!(t1["properties"]["code"].get("maxLength").is_none());
        assert!(t1["properties"]["code"].get("pattern").is_none());
        assert!(t1["properties"]["pair"].get("prefixItems").is_none());
        assert!(t1["properties"]["pair"].get("maxItems").is_none());
        assert!(t1["properties"]["pair"]["items"]["anyOf"].is_array());
        assert!(t1["properties"]["choice"].get("oneOf").is_none());
        assert_eq!(
            t1["properties"]["choice"]["anyOf"]
                .as_array()
                .unwrap()
                .len(),
            2
        );

        // Tool 2 assertions: >4KB compacted to shallow shape-preserving schema
        let t2 = &sanitized[1].parameters;
        let t2_bytes = serde_json::to_string(t2).unwrap().len();
        assert!(t2_bytes <= FIREWORKS_TOOL_SCHEMA_MAX_BYTES);
        assert_eq!(t2["properties"]["alpha"], json!({}));
        assert_eq!(t2["properties"]["beta"], json!({}));
        assert_eq!(t2["required"], json!(["alpha"]));
        assert_eq!(t2["additionalProperties"], json!(true));

        // Every individual tool schema is <= 4096 bytes and cumulative fits <= 12288 bytes
        let mut total_bytes = 0usize;
        for tool in &sanitized {
            let b = serde_json::to_string(&tool.parameters).unwrap().len();
            assert!(
                b <= FIREWORKS_TOOL_SCHEMA_MAX_BYTES,
                "Tool {} exceeded 4KB ({b} bytes)",
                tool.name
            );
            total_bytes += b;
        }
        assert!(
            total_bytes <= FIREWORKS_TOTAL_TOOL_SCHEMA_MAX_BYTES,
            "Cumulative tool schema bytes {total_bytes} exceeded 12KB"
        );
    }
}

#[test]
fn normalizes_nvidia_payload_and_together_opencode_baseten_quirks() {
    // 1. NVIDIA payload normalization
    let raw_nvidia = json!({
        "model": "nvidia/nemotron-3-super-120b-a12b",
        "store": false,
        "max_tokens": 4096,
        "max_completion_tokens": 4096,
        "reasoning_budget": 2048,
        "reasoning_effort": "high",
        "enable_thinking": false,
        "chat_template_kwargs": { "custom_flag": 1 }
    });
    let norm = normalize_nvidia_chat_completions_body(raw_nvidia);
    for forbidden in [
        "store",
        "max_tokens",
        "max_completion_tokens",
        "reasoning_budget",
        "reasoning_effort",
        "enable_thinking",
    ] {
        assert!(
            norm.get(forbidden).is_none(),
            "NVIDIA payload must strip {forbidden}"
        );
    }
    assert_eq!(norm["chat_template_kwargs"]["custom_flag"], json!(1));
    assert_eq!(norm["chat_template_kwargs"]["enable_thinking"], json!(true));

    // 2. Baseten UI gating & discovery header prefix
    assert!(!is_user_facing_provider_enabled(ProviderName::Baseten));
    assert!(is_user_facing_provider_enabled(ProviderName::Together));
    let baseten_quirks = ProviderQuirks::for_provider(ProviderName::Baseten).unwrap();
    assert!(!baseten_quirks.is_user_facing_enabled);
    assert_eq!(baseten_quirks.discovery_auth_prefix, "Api-Key");

    // 3. OpenCode Go & OpenCode Zen quirks and per-provider model allowlists
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let registry = InferenceModelRegistry::load_from_repo_root(&repo_root).unwrap();
    let go_quirks = ProviderQuirks::for_provider(ProviderName::OpencodeGo).unwrap();
    let zen_quirks = ProviderQuirks::for_provider(ProviderName::OpencodeZen).unwrap();
    assert_eq!(go_quirks.default_base_url, "https://opencode.ai/zen/go/v1");
    assert_eq!(zen_quirks.default_base_url, "https://opencode.ai/zen/v1");
    assert!(go_quirks.is_public_catalog);
    assert!(zen_quirks.is_public_catalog);
    assert!(is_opencode_model_supported(
        ProviderName::OpencodeGo,
        "glm-5",
        &registry
    ));
    assert!(is_opencode_model_supported(
        ProviderName::OpencodeZen,
        "claude-opus-4-8",
        &registry
    ));
    assert!(!is_opencode_model_supported(
        ProviderName::OpencodeGo,
        "claude-opus-4-8",
        &registry
    ));

    // 4. Together quirks & null-default tool argument normalization
    let together_quirks = ProviderQuirks::for_provider(ProviderName::Together).unwrap();
    assert!(!together_quirks.supports_store);
    assert!(!together_quirks.supports_developer_role);
    assert!(!together_quirks.supports_reasoning_effort);

    let schema = json!({
        "type": "object",
        "properties": {
            "query": { "type": "string" },
            "limit": { "type": "integer", "default": 10 },
            "nullable_field": { "type": ["string", "null"] }
        },
        "required": ["query"]
    });
    let mut raw_args = Map::new();
    raw_args.insert("query".into(), json!("rust"));
    raw_args.insert("limit".into(), Value::Null);
    raw_args.insert("nullable_field".into(), Value::Null);
    let cleaned = normalize_null_tool_arguments(&raw_args, &schema);
    assert_eq!(cleaned.get("query"), Some(&json!("rust")));
    assert!(
        !cleaned.contains_key("limit"),
        "null value on optional non-nullable property must be stripped so default applies"
    );
    assert_eq!(
        cleaned.get("nullable_field"),
        Some(&Value::Null),
        "explicitly nullable property keeps null"
    );
}

#[tokio::test]
async fn lmstudio_daemon_load_unload_hits_mock_server_only() {
    assert_eq!(
        normalize_lmstudio_base_url(Some("http://127.0.0.1:9999/v1/")),
        "http://127.0.0.1:9999"
    );
    assert_eq!(
        normalize_lmstudio_base_url(Some("http://127.0.0.1:9999/api/v1")),
        "http://127.0.0.1:9999"
    );
    assert!(is_loopback_lmstudio_url("http://127.0.0.1:1234"));
    assert!(is_loopback_lmstudio_url("http://[::1]:1234"));
    assert!(is_loopback_lmstudio_url("http://localhost:1234"));
    assert!(!is_loopback_lmstudio_url("https://remote.example.com:1234"));

    #[derive(Default)]
    struct MockDaemonState {
        load_calls: Vec<Value>,
        unload_calls: Vec<Value>,
        auth_headers: Vec<String>,
    }

    let state = Arc::new(Mutex::new(MockDaemonState::default()));
    let s1 = state.clone();
    let s2 = state.clone();
    let s3 = state.clone();

    let app = Router::new()
        .route(
            "/api/v1/models",
            get(move |headers: HeaderMap| {
                let s = s1.clone();
                async move {
                    if let Some(auth) = headers.get("authorization").and_then(|v| v.to_str().ok()) {
                        s.lock().unwrap().auth_headers.push(auth.to_string());
                    }
                    Response::builder()
                        .status(StatusCode::OK)
                        .header("content-type", "application/json")
                        .body(Body::from(
                            json!({
                                "models": [
                                    {
                                        "key": "text-embedding-nomic",
                                        "type": "embedding",
                                        "loaded_instances": []
                                    },
                                    {
                                        "key": "zeta-coder",
                                        "type": "llm",
                                        "max_context_length": 32768,
                                        "loaded_instances": []
                                    },
                                    {
                                        "key": "alpha-coder",
                                        "type": "llm",
                                        "max_context_length": 65536,
                                        "loaded_instances": [
                                            { "id": "alpha-coder:1", "config": { "context_length": 4096 } }
                                        ]
                                    }
                                ]
                            })
                            .to_string(),
                        ))
                        .unwrap()
                }
            }),
        )
        .route(
            "/api/v1/models/unload",
            post(move |body: String| {
                let s = s2.clone();
                async move {
                    s.lock()
                        .unwrap()
                        .unload_calls
                        .push(serde_json::from_str(&body).unwrap());
                    Response::builder()
                        .status(StatusCode::OK)
                        .header("content-type", "application/json")
                        .body(Body::from(json!({ "status": "unloaded" }).to_string()))
                        .unwrap()
                }
            }),
        )
        .route(
            "/api/v1/models/load",
            post(move |body: String| {
                let s = s3.clone();
                async move {
                    s.lock()
                        .unwrap()
                        .load_calls
                        .push(serde_json::from_str(&body).unwrap());
                    Response::builder()
                        .status(StatusCode::OK)
                        .header("content-type", "application/json")
                        .body(Body::from(
                            json!({
                                "type": "llm",
                                "instance_id": "alpha-coder:2",
                                "load_time_seconds": 0.42,
                                "status": "loaded",
                                "load_config": { "context_length": 16384 }
                            })
                            .to_string(),
                        ))
                        .unwrap()
                }
            }),
        );

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    let mut env = HashMap::new();
    env.insert(
        "LM_STUDIO_BASE_URL".into(),
        format!("http://127.0.0.1:{port}/v1"),
    );
    env.insert("LM_STUDIO_API_TOKEN".into(), "lms-secret-tok".into());
    env.insert("LM_STUDIO_CONTEXT_LENGTH".into(), "16384".into());

    let opts = resolve_lmstudio_options(&env, None, None);
    assert_eq!(opts.base_url, format!("http://127.0.0.1:{port}"));
    assert_eq!(opts.context_length, Some(16384));

    let client = LmStudioControlClient::new(opts);
    let models = client.list_native_models().await.unwrap();
    // Embedding filtered out, sorted lexicographically by key: alpha-coder, zeta-coder
    assert_eq!(models.len(), 2);
    assert_eq!(models[0].key, "alpha-coder");
    assert_eq!(models[1].key, "zeta-coder");

    // Prepare alpha-coder with context_length=16384 when current instance is 4096 -> unloads alpha-coder:1 then loads with 16384
    let prepared = client
        .prepare_model_for_inference("alpha-coder")
        .await
        .unwrap();
    assert_eq!(prepared.key, "alpha-coder");

    server.abort();

    let recorded = state.lock().unwrap();
    assert!(
        recorded
            .auth_headers
            .iter()
            .any(|h| h == "Bearer lms-secret-tok")
    );
    assert_eq!(recorded.unload_calls.len(), 1);
    assert_eq!(recorded.unload_calls[0]["instance_id"], "alpha-coder:1");
    assert_eq!(recorded.load_calls.len(), 1);
    assert_eq!(recorded.load_calls[0]["model"], "alpha-coder");
    assert_eq!(recorded.load_calls[0]["context_length"], 16384);
    assert_eq!(recorded.load_calls[0]["echo_load_config"], true);
}
