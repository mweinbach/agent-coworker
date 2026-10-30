use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Body;
use axum::extract::{Path as AxumPath, State};
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::Response;
use axum::routing::{get, post};
use cowork_inference::{
    CanonicalMessage, ContentBlock, MessageRole, ProviderOpaqueMeta, RequestPolicy, StepBudget,
    StopReason, StreamEvent,
};
use cowork_providers::bedrock::{
    BedrockAuthConfig, BedrockAuthMethod, BedrockConverseTransport, BedrockDecodedEvent,
    BedrockStreamFrameDecoder, compute_bedrock_auth_fingerprint, discover_bedrock_models,
    encode_eventstream_exception_frame, encode_eventstream_json_frame, mask_bedrock_field_values,
    percent_encode_bedrock_model_id, resolve_bedrock_auth_config,
    should_use_explicit_bedrock_endpoint,
};
use cowork_providers::{ProviderStepRequest, ProviderTransport, ToolDefinition};
use serde_json::{Map, Value, json};
use tokio::net::TcpListener;
use uuid::Uuid;

#[test]
fn encodes_and_decodes_binary_eventstream_frames_across_single_byte_chunks() {
    let mut wire = Vec::new();
    wire.extend_from_slice(
        &encode_eventstream_json_frame("messageStart", &json!({ "role": "assistant" })).unwrap(),
    );
    wire.extend_from_slice(
        &encode_eventstream_json_frame(
            "contentBlockDelta",
            &json!({
                "contentBlockIndex": 0,
                "delta": { "reasoningContent": { "text": "Analyzing..." } }
            }),
        )
        .unwrap(),
    );
    wire.extend_from_slice(
        &encode_eventstream_json_frame("contentBlockStop", &json!({ "contentBlockIndex": 0 }))
            .unwrap(),
    );
    wire.extend_from_slice(
        &encode_eventstream_json_frame("messageStop", &json!({ "stopReason": "end_turn" }))
            .unwrap(),
    );

    let mut decoder = BedrockStreamFrameDecoder::new();
    let mut events = Vec::new();
    for byte in &wire {
        let out = decoder.push_bytes(&[*byte]).unwrap();
        events.extend(out);
    }
    assert!(decoder.is_empty());
    assert_eq!(events.len(), 4);
    assert_eq!(
        events[0],
        BedrockDecodedEvent::Event {
            event_type: "messageStart".into(),
            payload: json!({ "role": "assistant" }),
        }
    );

    let exc_bytes =
        encode_eventstream_exception_frame("throttlingException", "Rate exceeded").unwrap();
    let exc_decoded = decoder.push_bytes(&exc_bytes).unwrap();
    assert_eq!(
        exc_decoded,
        vec![BedrockDecodedEvent::Exception {
            exception_type: "throttlingException".into(),
            message: "Rate exceeded".into(),
        }]
    );
}

#[tokio::test]
async fn signs_converse_stream_requests_with_sigv4_or_bearer_and_encodes_arn_model_ids() {
    let arn = "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-4-6-v1:0";
    let encoded_arn = percent_encode_bedrock_model_id(arn);
    assert!(encoded_arn.contains("%3A") && encoded_arn.contains("%2F"));
    assert!(!encoded_arn.contains('/'));

    assert!(!should_use_explicit_bedrock_endpoint(
        "https://bedrock-runtime.us-west-2.amazonaws.com",
        Some("us-east-1"),
        false,
    ));
    assert!(should_use_explicit_bedrock_endpoint(
        "http://127.0.0.1:9999",
        Some("us-east-1"),
        true,
    ));

    // Masking check
    let mut raw_vals = HashMap::new();
    raw_vals.insert("region".into(), "us-east-1".into());
    raw_vals.insert("accessKeyId".into(), "AKIAIOSFODNN7EXAMPLE".into());
    raw_vals.insert("secretAccessKey".into(), "short".into());
    let masked = mask_bedrock_field_values(&raw_vals);
    assert_eq!(masked["region"], "us-east-1");
    assert_eq!(masked["accessKeyId"], "AKIA...MPLE");
    assert_eq!(masked["secretAccessKey"], "••••••••");

    #[derive(Default)]
    struct CapturedBedrockReq {
        raw_uri: String,
        headers: HashMap<String, String>,
        body: Value,
    }

    let captured: Arc<Mutex<Vec<CapturedBedrockReq>>> = Arc::new(Mutex::new(Vec::new()));
    let state = captured.clone();

    let app = Router::new()
        .route(
            "/model/{model_id}/converse-stream",
            post(
                move |State(store): State<Arc<Mutex<Vec<CapturedBedrockReq>>>>,
                      uri: Uri,
                      AxumPath(_model_id): AxumPath<String>,
                      headers: HeaderMap,
                      body: String| async move {
                    let mut hmap = HashMap::new();
                    for (k, v) in &headers {
                        if let Ok(s) = v.to_str() {
                            hmap.insert(k.as_str().to_ascii_lowercase(), s.to_string());
                        }
                    }
                    store.lock().unwrap().push(CapturedBedrockReq {
                        raw_uri: uri.to_string(),
                        headers: hmap,
                        body: serde_json::from_str(&body).unwrap_or(Value::Null),
                    });

                    let mut bytes = Vec::new();
                    bytes.extend_from_slice(
                        &encode_eventstream_json_frame(
                            "messageStart",
                            &json!({ "role": "assistant" }),
                        )
                        .unwrap(),
                    );
                    bytes.extend_from_slice(
                        &encode_eventstream_json_frame(
                            "contentBlockDelta",
                            &json!({
                                "contentBlockIndex": 0,
                                "delta": {
                                    "reasoningContent": {
                                        "text": "Checking files...",
                                        "signature": "sig-bedrock-1"
                                    }
                                }
                            }),
                        )
                        .unwrap(),
                    );
                    bytes.extend_from_slice(
                        &encode_eventstream_json_frame(
                            "contentBlockStop",
                            &json!({ "contentBlockIndex": 0 }),
                        )
                        .unwrap(),
                    );
                    bytes.extend_from_slice(
                        &encode_eventstream_json_frame(
                            "contentBlockDelta",
                            &json!({
                                "contentBlockIndex": 1,
                                "delta": { "text": "Let me inspect." }
                            }),
                        )
                        .unwrap(),
                    );
                    bytes.extend_from_slice(
                        &encode_eventstream_json_frame(
                            "contentBlockStop",
                            &json!({ "contentBlockIndex": 1 }),
                        )
                        .unwrap(),
                    );
                    bytes.extend_from_slice(
                        &encode_eventstream_json_frame(
                            "contentBlockStart",
                            &json!({
                                "contentBlockIndex": 2,
                                "start": {
                                    "toolUse": { "toolUseId": "toolu_bdrk_1", "name": "list_dir" }
                                }
                            }),
                        )
                        .unwrap(),
                    );
                    bytes.extend_from_slice(
                        &encode_eventstream_json_frame(
                            "contentBlockDelta",
                            &json!({
                                "contentBlockIndex": 2,
                                "delta": { "toolUse": { "input": "{\"dir\":\".\"}" } }
                            }),
                        )
                        .unwrap(),
                    );
                    bytes.extend_from_slice(
                        &encode_eventstream_json_frame(
                            "contentBlockStop",
                            &json!({ "contentBlockIndex": 2 }),
                        )
                        .unwrap(),
                    );
                    bytes.extend_from_slice(
                        &encode_eventstream_json_frame(
                            "messageStop",
                            &json!({ "stopReason": "tool_use" }),
                        )
                        .unwrap(),
                    );
                    bytes.extend_from_slice(
                        &encode_eventstream_json_frame(
                            "metadata",
                            &json!({
                                "usage": {
                                    "inputTokens": 120,
                                    "outputTokens": 45,
                                    "cacheReadInputTokens": 30,
                                    "cacheWriteInputTokens": 10
                                }
                            }),
                        )
                        .unwrap(),
                    );

                    Response::builder()
                        .status(StatusCode::OK)
                        .header("content-type", "application/vnd.amazon.eventstream")
                        .body(Body::from(bytes))
                        .unwrap()
                },
            ),
        )
        .with_state(state);

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    // 1. SigV4 signed request with adaptive Claude 4.6 ARN
    let sigv4_auth = BedrockAuthConfig {
        method_id: "aws_keys".into(),
        source: "stored".into(),
        region: "us-east-1".into(),
        has_configured_region: true,
        has_configured_profile: false,
        auth: BedrockAuthMethod::SigV4 {
            access_key_id: "AKIAIOSFODNN7EXAMPLE".into(),
            secret_access_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY".into(),
            session_token: Some("AQoEXAMPLEH4aoAH0gNCAPyJxz4BlCFFxWNE1OPTgk5TthT".into()),
        },
    };
    let transport = BedrockConverseTransport::with_auth(sigv4_auth);
    let mut events = Vec::new();
    let mut opts = Map::new();
    opts.insert("reasoningEffort".into(), json!("high"));

    let res = transport
        .stream_step(
            ProviderStepRequest {
                model_id: arn.into(),
                base_url: Some(format!("http://127.0.0.1:{port}")),
                api_key: None,
                extra_headers: HashMap::new(),
                system_prompt: "You are helpful.".into(),
                messages: vec![CanonicalMessage {
                    id: "u1".into(),
                    role: MessageRole::User,
                    content: vec![ContentBlock::Text {
                        text: "Check current dir".into(),
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
                }],
                tools: vec![ToolDefinition {
                    name: "list_dir".into(),
                    description: "List directory".into(),
                    parameters: json!({
                        "type": "object",
                        "properties": { "dir": { "type": "string" } }
                    }),
                }],
                authorized_tool_names: None,
                provider_options: opts,
                continuation: None,
                policy: RequestPolicy::default(),
                turn_id: "turn-bdrk-1".into(),
            },
            &StepBudget::new(30_000, None),
            &mut |ev| events.push(ev),
        )
        .await
        .unwrap();

    // 2. Bearer token request
    let bearer_auth = BedrockAuthConfig {
        method_id: "api_key".into(),
        source: "environment".into(),
        region: "us-east-1".into(),
        has_configured_region: true,
        has_configured_profile: false,
        auth: BedrockAuthMethod::BearerToken {
            token: "ABSK-bedrock-bearer-tok".into(),
        },
    };
    let bearer_transport = BedrockConverseTransport::with_auth(bearer_auth);
    let _ = bearer_transport
        .stream_step(
            ProviderStepRequest {
                model_id: "amazon.nova-lite-v1:0".into(),
                base_url: Some(format!("http://127.0.0.1:{port}")),
                api_key: None,
                extra_headers: HashMap::new(),
                system_prompt: "System".into(),
                messages: vec![CanonicalMessage {
                    id: "u2".into(),
                    role: MessageRole::User,
                    content: vec![ContentBlock::Text {
                        text: "Hi".into(),
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
                }],
                tools: Vec::new(),
                authorized_tool_names: None,
                provider_options: Map::new(),
                continuation: None,
                policy: RequestPolicy::default(),
                turn_id: "turn-bdrk-2".into(),
            },
            &StepBudget::new(30_000, None),
            &mut |_| {},
        )
        .await
        .unwrap();

    server.abort();

    assert_eq!(res.assistant.stop_reason, Some(StopReason::ToolUse));
    assert_eq!(res.usage.prompt_tokens, 120);
    assert_eq!(res.usage.completion_tokens, 45);
    assert_eq!(res.usage.cached_prompt_tokens, Some(30));
    assert_eq!(res.usage.cache_write_prompt_tokens, Some(10));
    assert!(events.iter().any(|e| matches!(e, StreamEvent::ThinkingEnd { signature: Some(sig), .. } if sig == "sig-bedrock-1")));

    let reqs = captured.lock().unwrap();
    assert_eq!(reqs.len(), 2);
    // SigV4 request assertions
    assert!(reqs[0].raw_uri.contains("%2F"));
    let auth_hdr = reqs[0]
        .headers
        .get("authorization")
        .expect("SigV4 Authorization header");
    assert!(auth_hdr.starts_with("AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/"));
    assert!(auth_hdr.contains("/us-east-1/bedrock/aws4_request"));
    assert!(reqs[0].headers.contains_key("x-amz-date"));
    assert!(reqs[0].headers.contains_key("x-amz-security-token"));
    assert_eq!(
        reqs[0].body["additionalModelRequestFields"]["thinking"]["type"],
        "adaptive"
    );
    assert_eq!(
        reqs[0].body["additionalModelRequestFields"]["output_config"]["effort"],
        "high"
    );

    // Bearer request assertions
    assert_eq!(
        reqs[1].headers.get("authorization").map(String::as_str),
        Some("Bearer ABSK-bedrock-bearer-tok")
    );
}

#[tokio::test]
async fn discovers_bedrock_control_plane_foundation_and_inference_profile_models() {
    let dir = PathBuf::from(format!("/private/tmp/cowork-bdrk-test-{}", Uuid::new_v4()));
    std::fs::create_dir_all(dir.join(".aws")).unwrap();
    let dir = std::fs::canonicalize(&dir).unwrap();
    std::fs::write(
        dir.join(".aws/credentials"),
        "[default]\naws_access_key_id = AKIATESTDEFAULT\naws_secret_access_key = SECRETTESTDEFAULT\n",
    )
    .unwrap();
    std::fs::write(dir.join(".aws/config"), "[default]\nregion = us-west-2\n").unwrap();

    let mut env = HashMap::new();
    env.insert("HOME".into(), dir.to_string_lossy().into_owned());
    let resolved = resolve_bedrock_auth_config(&dir, &env, None).expect("resolves ~/.aws default");
    assert_eq!(resolved.method_id, "aws_default");
    assert_eq!(resolved.region, "us-west-2");
    assert!(!compute_bedrock_auth_fingerprint(&resolved).is_empty());

    let app = Router::new()
        .route(
            "/foundation-models",
            get(|| async move {
                Response::builder()
                    .status(StatusCode::OK)
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "modelSummaries": [
                                {
                                    "modelId": "anthropic.claude-sonnet-4-6-v1:0",
                                    "modelArn": "arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-sonnet-4-6-v1:0",
                                    "modelName": "Claude Sonnet 4.6",
                                    "responseStreamingSupported": true,
                                    "inputModalities": ["TEXT", "IMAGE"]
                                },
                                {
                                    "modelId": "amazon.titan-embed-text-v2:0",
                                    "modelArn": "arn:aws:bedrock:us-west-2::foundation-model/amazon.titan-embed-text-v2:0",
                                    "modelName": "Titan Embed",
                                    "responseStreamingSupported": false,
                                    "inputModalities": ["TEXT"]
                                }
                            ]
                        })
                        .to_string(),
                    ))
                    .unwrap()
            }),
        )
        .route(
            "/inference-profiles",
            get(|| async move {
                Response::builder()
                    .status(StatusCode::OK)
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "inferenceProfileSummaries": [
                                {
                                    "inferenceProfileId": "us.anthropic.claude-sonnet-4-6-v1:0",
                                    "inferenceProfileName": "US Claude Sonnet 4.6",
                                    "status": "ACTIVE",
                                    "models": [
                                        { "modelArn": "arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-sonnet-4-6-v1:0" }
                                    ]
                                },
                                {
                                    "inferenceProfileId": "us.inactive.profile",
                                    "status": "INACTIVE",
                                    "models": []
                                }
                            ]
                        })
                        .to_string(),
                    ))
                    .unwrap()
            }),
        )
        .route(
            "/model-customization/custom-model-deployments",
            get(|| async move {
                Response::builder()
                    .status(StatusCode::OK)
                    .header("content-type", "application/json")
                    .body(Body::from(json!({ "modelDeploymentSummaries": [] }).to_string()))
                    .unwrap()
            }),
        )
        .route(
            "/provisioned-model-throughputs",
            get(|| async move {
                Response::builder()
                    .status(StatusCode::OK)
                    .header("content-type", "application/json")
                    .body(Body::from(json!({ "provisionedModelSummaries": [] }).to_string()))
                    .unwrap()
            }),
        )
        .route(
            "/imported-models",
            get(|| async move {
                Response::builder()
                    .status(StatusCode::OK)
                    .header("content-type", "application/json")
                    .body(Body::from(json!({ "modelSummaries": [] }).to_string()))
                    .unwrap()
            }),
        );

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    let client = reqwest::Client::new();
    let discovered = discover_bedrock_models(
        &client,
        &resolved,
        Some(&format!("http://127.0.0.1:{port}")),
    )
    .await
    .unwrap();

    server.abort();
    let _ = std::fs::remove_dir_all(&dir);

    let ids: Vec<&str> = discovered.iter().map(|m| m.id.as_str()).collect();
    assert!(ids.contains(&"anthropic.claude-sonnet-4-6-v1:0"));
    assert!(ids.contains(&"us.anthropic.claude-sonnet-4-6-v1:0"));
    assert!(!ids.contains(&"amazon.titan-embed-text-v2:0"));
    assert!(!ids.contains(&"us.inactive.profile"));
}

#[tokio::test]
async fn resolves_cowork_home_fallback_and_nested_provider_options_across_transports() {
    use cowork_config::{
        ConnectionMode, ProviderName, StoredConnection, get_ai_coworker_paths,
        save_provider_connection,
    };
    use cowork_providers::bedrock::build_converse_request_body;
    use cowork_providers::chat_completions::{ProviderQuirks, build_chat_completions_payload};
    use cowork_providers::{
        AnthropicMessagesTransport, GoogleInteractionsTransport, OpenAiResponsesTransport,
    };

    // 1. `build_converse_request_body` nested `provider_options.bedrock` precedence + top-level fallback
    let mut nested_opts = Map::new();
    nested_opts.insert("maxTokens".into(), json!(1024));
    nested_opts.insert("temperature".into(), json!(0.8));
    nested_opts.insert("reasoningEffort".into(), json!("low"));
    nested_opts.insert(
        "bedrock".into(),
        json!({
            "maxTokens": 4096,
            "reasoningEffort": "high",
        }),
    );
    let body = build_converse_request_body(
        "us.anthropic.claude-sonnet-4-6",
        "System",
        &[],
        &[],
        &nested_opts,
    );
    assert_eq!(body["inferenceConfig"]["maxTokens"], json!(4096));
    assert_eq!(body["inferenceConfig"]["temperature"], json!(0.8));
    assert_eq!(
        body["additionalModelRequestFields"]["thinking"],
        json!({ "type": "adaptive" })
    );
    assert_eq!(
        body["additionalModelRequestFields"]["output_config"]["effort"],
        json!("high")
    );

    // 2. Chat Completions nested `provider_options.<provider>` precedence + top-level fallback
    let mut cc_opts = Map::new();
    cc_opts.insert("maxTokens".into(), json!(512));
    cc_opts.insert("temperature".into(), json!(0.5));
    cc_opts.insert("effort".into(), json!("low"));
    cc_opts.insert(
        "fireworks".into(),
        json!({
            "maxTokens": 2048,
            "effort": "high",
        }),
    );
    let quirks = ProviderQuirks::for_provider(ProviderName::Fireworks).unwrap();
    let cc_body = build_chat_completions_payload(&quirks, "kimi-k2", "Sys", &[], &[], &cc_opts);
    assert_eq!(cc_body["max_tokens"], json!(2048));
    assert_eq!(cc_body["temperature"], json!(0.5));
    assert_eq!(cc_body["reasoning_effort"], json!("high"));

    // 3. `BedrockConverseTransport::new()` fallback `resolve_auth` honors `provider_options.coworkHome`
    // and nested `provider_options.bedrock.region`
    let base = PathBuf::from(format!("/private/tmp/cowork-bdrk-home-{}", Uuid::new_v4()));
    let home = base.join("home");
    std::fs::create_dir_all(home.join(".aws")).unwrap();
    let home = std::fs::canonicalize(&home).unwrap();

    std::fs::write(
        home.join(".aws/credentials"),
        "[isolated-prof]\naws_access_key_id = AKIAIOSFODNN7ISOLATE\naws_secret_access_key = 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\n",
    )
    .unwrap();
    std::fs::write(
        home.join(".aws/config"),
        "[profile isolated-prof]\nregion = ap-southeast-2\n",
    )
    .unwrap();

    let mut env = HashMap::new();
    env.insert("HOME".into(), home.to_string_lossy().into_owned());
    env.insert(
        "COWORK_HOME_OVERRIDE".into(),
        home.to_string_lossy().into_owned(),
    );
    let paths = get_ai_coworker_paths(Some(&home), &env);

    let mut saved_vals = HashMap::new();
    saved_vals.insert("profile".into(), "isolated-prof".into());
    save_provider_connection(
        &paths,
        StoredConnection {
            service: ProviderName::Bedrock,
            mode: ConnectionMode::Credentials,
            method_id: Some("aws_profile".into()),
            api_key: None,
            values: Some(saved_vals),
            updated_at: "2026-10-30T00:00:00Z".into(),
        },
    )
    .await
    .unwrap();

    let captured_auth: Arc<Mutex<Vec<(String, Value)>>> = Arc::new(Mutex::new(Vec::new()));
    let cap_clone = captured_auth.clone();

    let mut frame_bytes = Vec::new();
    frame_bytes.extend_from_slice(
        &encode_eventstream_json_frame("messageStart", &json!({ "role": "assistant" })).unwrap(),
    );
    frame_bytes.extend_from_slice(
        &encode_eventstream_json_frame(
            "contentBlockDelta",
            &json!({ "contentBlockIndex": 0, "delta": { "text": "ok" } }),
        )
        .unwrap(),
    );
    frame_bytes.extend_from_slice(
        &encode_eventstream_json_frame("contentBlockStop", &json!({ "contentBlockIndex": 0 }))
            .unwrap(),
    );
    frame_bytes.extend_from_slice(
        &encode_eventstream_json_frame("messageStop", &json!({ "stopReason": "end_turn" }))
            .unwrap(),
    );

    let bdrk_app = Router::new().route(
        "/model/{model_id}/converse-stream",
        post(
            move |AxumPath(_model_id): AxumPath<String>, headers: HeaderMap, body: String| {
                let cap = cap_clone.clone();
                let bytes = frame_bytes.clone();
                async move {
                    let auth = headers
                        .get("authorization")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("")
                        .to_string();
                    let parsed: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
                    cap.lock().unwrap().push((auth, parsed));
                    Response::builder()
                        .status(StatusCode::OK)
                        .header("content-type", "application/vnd.amazon.eventstream")
                        .body(Body::from(bytes))
                        .unwrap()
                }
            },
        ),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let bdrk_port = listener.local_addr().unwrap().port();
    let bdrk_srv = tokio::spawn(async move {
        let _ = axum::serve(listener, bdrk_app).await;
    });

    // Call `BedrockConverseTransport::new()` (no `with_auth`), passing `coworkHome`
    let fallback_transport = BedrockConverseTransport::new();
    let mut step_opts = Map::new();
    step_opts.insert(
        "coworkHome".into(),
        Value::String(paths.root_dir.to_string_lossy().into_owned()),
    );
    step_opts.insert("temperature".into(), json!(0.3));
    step_opts.insert(
        "bedrock".into(),
        json!({
            "maxTokens": 3000,
        }),
    );

    let msg = CanonicalMessage {
        id: "u1".into(),
        role: MessageRole::User,
        content: vec![ContentBlock::Text {
            text: "Hello".into(),
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

    fallback_transport
        .stream_step(
            ProviderStepRequest {
                model_id: "amazon.nova-lite-v1:0".into(),
                base_url: Some(format!("http://127.0.0.1:{bdrk_port}")),
                api_key: None,
                extra_headers: HashMap::new(),
                system_prompt: "Sys".into(),
                messages: vec![msg.clone()],
                tools: Vec::new(),
                authorized_tool_names: None,
                provider_options: step_opts,
                continuation: None,
                policy: RequestPolicy::default(),
                turn_id: "turn-fb-1".into(),
            },
            &StepBudget::new(10_000, None),
            &mut |_| {},
        )
        .await
        .unwrap();

    // Now override `region` via nested `provider_options.bedrock.region`
    let mut step_opts_override = Map::new();
    step_opts_override.insert(
        "coworkHome".into(),
        Value::String(paths.root_dir.to_string_lossy().into_owned()),
    );
    step_opts_override.insert("region".into(), json!("us-west-1"));
    step_opts_override.insert("bedrock".into(), json!({ "region": "eu-central-1" }));

    fallback_transport
        .stream_step(
            ProviderStepRequest {
                model_id: "amazon.nova-lite-v1:0".into(),
                base_url: Some(format!("http://127.0.0.1:{bdrk_port}")),
                api_key: None,
                extra_headers: HashMap::new(),
                system_prompt: "Sys".into(),
                messages: vec![msg.clone()],
                tools: Vec::new(),
                authorized_tool_names: None,
                provider_options: step_opts_override,
                continuation: None,
                policy: RequestPolicy::default(),
                turn_id: "turn-fb-2".into(),
            },
            &StepBudget::new(10_000, None),
            &mut |_| {},
        )
        .await
        .unwrap();

    bdrk_srv.abort();
    {
        let seen = captured_auth.lock().unwrap();
        assert_eq!(seen.len(), 2);
        assert!(
            seen[0].0.contains("/ap-southeast-2/bedrock/aws4_request"),
            "expected isolated AWS profile region ap-southeast-2 in SigV4 header, got: {}",
            seen[0].0
        );
        assert_eq!(seen[0].1["inferenceConfig"]["maxTokens"], json!(3000));
        assert_eq!(seen[0].1["inferenceConfig"]["temperature"], json!(0.3));
        assert!(
            seen[1].0.contains("/eu-central-1/bedrock/aws4_request"),
            "expected nested provider_options.bedrock.region override eu-central-1, got: {}",
            seen[1].0
        );
    }

    // 4. Audit OpenAI Responses, Anthropic Messages, and Google Interactions nested `provider_options.<provider>` + top-level fallback
    let sse_bodies: Arc<Mutex<HashMap<String, Value>>> = Arc::new(Mutex::new(HashMap::new()));
    let sb_openai = sse_bodies.clone();
    let sb_anth = sse_bodies.clone();
    let sb_goog = sse_bodies.clone();

    let sse_app = Router::new()
        .route(
            "/openai/responses",
            post(move |body: String| {
                let sb = sb_openai.clone();
                async move {
                    sb.lock()
                        .unwrap()
                        .insert("openai".into(), serde_json::from_str(&body).unwrap());
                    let sse = concat!(
                        "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_1\"}}\n\n",
                        "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"id\":\"m1\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"hi\"}]}],\"usage\":{\"input_tokens\":5,\"output_tokens\":2,\"total_tokens\":7}}}\n\n"
                    );
                    Response::builder()
                        .status(StatusCode::OK)
                        .header("content-type", "text/event-stream")
                        .body(Body::from(sse))
                        .unwrap()
                }
            }),
        )
        .route(
            "/anthropic/v1/messages",
            post(move |body: String| {
                let sb = sb_anth.clone();
                async move {
                    sb.lock()
                        .unwrap()
                        .insert("anthropic".into(), serde_json::from_str(&body).unwrap());
                    let sse = concat!(
                        "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"usage\":{\"input_tokens\":5,\"output_tokens\":1}}}\n\n",
                        "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
                        "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"hi\"}}\n\n",
                        "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
                        "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":2}}\n\n",
                        "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
                    );
                    Response::builder()
                        .status(StatusCode::OK)
                        .header("content-type", "text/event-stream")
                        .body(Body::from(sse))
                        .unwrap()
                }
            }),
        )
        .route(
            "/google/v1beta/interactions",
            post(move |body: String| {
                let sb = sb_goog.clone();
                async move {
                    sb.lock()
                        .unwrap()
                        .insert("google".into(), serde_json::from_str(&body).unwrap());
                    let sse = concat!(
                        "event: interaction.start\ndata: {\"event_type\":\"interaction.start\",\"interaction\":{\"id\":\"int_1\"}}\n\n",
                        "event: content.delta\ndata: {\"event_type\":\"content.delta\",\"index\":0,\"delta\":{\"type\":\"text\",\"text\":\"hi\"}}\n\n",
                        "event: interaction.complete\ndata: {\"event_type\":\"interaction.complete\",\"interaction\":{\"id\":\"int_1\",\"status\":\"completed\",\"usage\":{\"total_input_tokens\":5,\"total_output_tokens\":2,\"total_tokens\":7}}}\n\n"
                    );
                    Response::builder()
                        .status(StatusCode::OK)
                        .header("content-type", "text/event-stream")
                        .body(Body::from(sse))
                        .unwrap()
                }
            }),
        );

    let sse_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let sse_port = sse_listener.local_addr().unwrap().port();
    let sse_srv = tokio::spawn(async move {
        let _ = axum::serve(sse_listener, sse_app).await;
    });

    // OpenAI: nested `openai` overrides top-level `maxTokens` + `effort`, top-level `temperature` falls back
    let mut oai_opts = Map::new();
    oai_opts.insert("maxTokens".into(), json!(500));
    oai_opts.insert("temperature".into(), json!(0.4));
    oai_opts.insert("effort".into(), json!("low"));
    oai_opts.insert(
        "openai".into(),
        json!({ "maxTokens": 2500, "effort": "high" }),
    );
    OpenAiResponsesTransport::new()
        .stream_step(
            ProviderStepRequest {
                model_id: "gpt-5.4".into(),
                base_url: Some(format!("http://127.0.0.1:{sse_port}/openai")),
                api_key: Some("sk-oai".into()),
                extra_headers: HashMap::new(),
                system_prompt: "Sys".into(),
                messages: vec![msg.clone()],
                tools: Vec::new(),
                authorized_tool_names: None,
                provider_options: oai_opts,
                continuation: None,
                policy: RequestPolicy::default(),
                turn_id: "t-oai".into(),
            },
            &StepBudget::new(10_000, None),
            &mut |_| {},
        )
        .await
        .unwrap();

    // Anthropic: nested `anthropic.reasoningEffort` + top-level `maxTokens` fallback
    let mut anth_opts = Map::new();
    anth_opts.insert("maxTokens".into(), json!(4444));
    anth_opts.insert("reasoningEffort".into(), json!("low"));
    anth_opts.insert("anthropic".into(), json!({ "reasoningEffort": "medium" }));
    AnthropicMessagesTransport::new()
        .stream_step(
            ProviderStepRequest {
                model_id: "claude-sonnet-4-6".into(),
                base_url: Some(format!("http://127.0.0.1:{sse_port}/anthropic")),
                api_key: Some("sk-ant-api03-test".into()),
                extra_headers: HashMap::new(),
                system_prompt: "Sys".into(),
                messages: vec![msg.clone()],
                tools: Vec::new(),
                authorized_tool_names: None,
                provider_options: anth_opts,
                continuation: None,
                policy: RequestPolicy::default(),
                turn_id: "t-anth".into(),
            },
            &StepBudget::new(10_000, None),
            &mut |_| {},
        )
        .await
        .unwrap();

    // Google: nested `google` has `maxTokens` + `reasoningEffort`, top-level `temperature` still falls back!
    let mut goog_opts = Map::new();
    goog_opts.insert("temperature".into(), json!(0.25));
    goog_opts.insert("maxTokens".into(), json!(900));
    goog_opts.insert(
        "google".into(),
        json!({ "maxTokens": 3333, "reasoningEffort": "high" }),
    );
    GoogleInteractionsTransport::new()
        .stream_step(
            ProviderStepRequest {
                model_id: "gemini-3.1-pro-preview".into(),
                base_url: Some(format!("http://127.0.0.1:{sse_port}/google")),
                api_key: Some("AIza-test".into()),
                extra_headers: HashMap::new(),
                system_prompt: "Sys".into(),
                messages: vec![msg],
                tools: Vec::new(),
                authorized_tool_names: None,
                provider_options: goog_opts,
                continuation: None,
                policy: RequestPolicy::default(),
                turn_id: "t-goog".into(),
            },
            &StepBudget::new(10_000, None),
            &mut |_| {},
        )
        .await
        .unwrap();

    sse_srv.abort();
    let captured_sse = sse_bodies.lock().unwrap();
    assert_eq!(captured_sse["openai"]["max_output_tokens"], json!(2500));
    assert_eq!(captured_sse["openai"]["temperature"], json!(0.4));
    assert_eq!(captured_sse["openai"]["reasoning"]["effort"], json!("high"));

    assert_eq!(captured_sse["anthropic"]["max_tokens"], json!(4444));
    assert_eq!(
        captured_sse["anthropic"]["output_config"]["effort"],
        json!("medium")
    );

    assert_eq!(
        captured_sse["google"]["generation_config"]["max_output_tokens"],
        json!(3333)
    );
    assert_eq!(
        captured_sse["google"]["generation_config"]["temperature"],
        json!(0.25)
    );
    assert_eq!(
        captured_sse["google"]["generation_config"]["thinking_level"],
        json!("high")
    );

    let _ = std::fs::remove_dir_all(&base);
}
