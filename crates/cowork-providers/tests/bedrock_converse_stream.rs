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
