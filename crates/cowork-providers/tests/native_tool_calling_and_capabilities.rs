use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::{
    Json, Router,
    body::Body,
    extract::{Path as AxumPath, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use cowork_config::{ProviderName, ToolCallingStrategy};
use cowork_inference::{
    CanonicalMessage, ContentBlock, MessageRole, ProviderOpaqueMeta, RequestPolicy, StepBudget,
    StreamEvent, ToolResultPart,
};
use cowork_providers::{
    AnthropicMessagesTransport, COWORK_TOOLS_DISABLED_OPTION_KEY, EndpointCapabilitySource,
    NativeProgrammaticToolCallingKind, NativeToolCallingPlan, NativeToolSearchKind,
    OpenAiResponsesTransport, ProviderStepRequest, ProviderTransport, ToolDefinition,
    anthropic_model_supports_native_tool_features, check_endpoint_capabilities,
    classify_static_endpoint_capabilities, is_native_eager_core_tool,
    is_programmatic_eligible_tool, openai_model_supports_native_tool_features,
    record_rejected_native_capability, resolve_endpoint_tool_capabilities,
    write_native_tool_calling_plan,
};
use serde_json::{Map, Value, json};

#[derive(Clone, Default)]
struct MockWireState {
    requests: Arc<Mutex<Vec<(HeaderMap, Value)>>>,
    model_probes: Arc<Mutex<Vec<(String, HeaderMap)>>>,
    responses: Arc<Mutex<Vec<MockHttpReply>>>,
}

#[derive(Clone)]
struct MockHttpReply {
    status: StatusCode,
    content_type: &'static str,
    body: String,
}

impl MockHttpReply {
    fn sse(body: String) -> Self {
        Self {
            status: StatusCode::OK,
            content_type: "text/event-stream",
            body,
        }
    }

    fn json_err(status: StatusCode, body: Value) -> Self {
        Self {
            status,
            content_type: "application/json",
            body: body.to_string(),
        }
    }
}

async fn handle_post_wire(
    State(state): State<MockWireState>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Response {
    state.requests.lock().unwrap().push((headers, payload));
    let reply = state.responses.lock().unwrap().remove(0);
    Response::builder()
        .status(reply.status)
        .header(header::CONTENT_TYPE, reply.content_type)
        .body(Body::from(reply.body))
        .expect("mock HTTP response")
        .into_response()
}

async fn handle_get_openai_model(
    State(state): State<MockWireState>,
    AxumPath(model_id): AxumPath<String>,
    headers: HeaderMap,
) -> Response {
    state
        .model_probes
        .lock()
        .unwrap()
        .push((model_id.clone(), headers));
    if model_id.starts_with("gpt-5.4") {
        Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "application/json")
            .header("openai-processing-ms", "12")
            .body(Body::from(
                json!({
                    "id": model_id,
                    "object": "model",
                    "owned_by": "openai",
                    "capabilities": {
                        "tool_search": true,
                        "programmatic_tool_calling": true
                    }
                })
                .to_string(),
            ))
            .unwrap()
    } else {
        Response::builder()
            .status(StatusCode::NOT_FOUND)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                json!({ "error": { "message": "model not found" } }).to_string(),
            ))
            .unwrap()
    }
}

async fn handle_get_anthropic_model(
    State(state): State<MockWireState>,
    AxumPath(model_id): AxumPath<String>,
    headers: HeaderMap,
) -> Response {
    state
        .model_probes
        .lock()
        .unwrap()
        .push((model_id.clone(), headers));
    if model_id.starts_with("claude-sonnet-4-6") {
        Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                json!({
                    "id": model_id,
                    "type": "model",
                    "capabilities": {
                        "code_execution": { "supported": true },
                        "tool_search": { "supported": true }
                    }
                })
                .to_string(),
            ))
            .unwrap()
    } else {
        Response::builder()
            .status(StatusCode::NOT_FOUND)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                json!({ "type": "error", "error": { "type": "not_found_error" } }).to_string(),
            ))
            .unwrap()
    }
}

async fn spawn_mock_provider_server(replies: Vec<MockHttpReply>) -> (String, MockWireState) {
    let state = MockWireState {
        requests: Arc::new(Mutex::new(Vec::new())),
        model_probes: Arc::new(Mutex::new(Vec::new())),
        responses: Arc::new(Mutex::new(replies)),
    };
    let app = Router::new()
        .route("/v1/responses", post(handle_post_wire))
        .route("/v1/messages", post(handle_post_wire))
        .route("/v1/models/{model_id}", get(handle_get_openai_model))
        .route(
            "/anthropic/v1/models/{model_id}",
            get(handle_get_anthropic_model),
        )
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral 127.0.0.1:0");
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("http://{addr}"), state)
}

fn openai_sse(data: Value) -> String {
    format!("data: {data}\n\n")
}

fn anthropic_sse(event: &str, data: Value) -> String {
    format!("event: {event}\ndata: {data}\n\n")
}

fn sample_tools() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition {
            name: "bash".to_string(),
            description: "Run shell command".to_string(),
            parameters: json!({
                "type": "object",
                "properties": { "cmd": { "type": "string" } },
                "required": ["cmd"]
            }),
        },
        ToolDefinition {
            name: "askUserQuestion".to_string(),
            description: "Ask user an interactive question".to_string(),
            parameters: json!({
                "type": "object",
                "properties": { "question": { "type": "string" } },
                "required": ["question"]
            }),
        },
        ToolDefinition {
            name: "mcp__github__search_issues".to_string(),
            description: "Search GitHub issues".to_string(),
            parameters: json!({
                "type": "object",
                "properties": { "query": { "type": "string" } },
                "required": ["query"]
            }),
        },
    ]
}

#[test]
fn static_classifier_and_strategy_resolution_cover_openai_anthropic_openrouter_codex_and_loopback()
{
    // Official OpenAI gpt-5.4 vs gpt-4.1
    let oa_54 = classify_static_endpoint_capabilities(
        ProviderName::Openai,
        Some("https://api.openai.com/v1"),
        "gpt-5.4",
    );
    assert_eq!(
        oa_54.native_tool_search,
        Some(NativeToolSearchKind::OpenAiResponses)
    );
    assert_eq!(
        oa_54.native_programmatic_tool_calling,
        Some(NativeProgrammaticToolCallingKind::OpenAiResponses)
    );

    let oa_41 = classify_static_endpoint_capabilities(
        ProviderName::Openai,
        Some("https://api.openai.com/v1"),
        "gpt-4.1",
    );
    assert_eq!(oa_41.native_tool_search, None);
    assert_eq!(oa_41.native_programmatic_tool_calling, None);

    // OpenRouter OpenAI & Anthropic variants
    let or_oa = classify_static_endpoint_capabilities(
        ProviderName::Openai,
        Some("https://openrouter.ai/api/v1"),
        "openai/gpt-5.4",
    );
    assert_eq!(
        or_oa.native_tool_search,
        Some(NativeToolSearchKind::OpenRouterResponses)
    );
    assert_eq!(or_oa.native_programmatic_tool_calling, None);

    let or_ant = classify_static_endpoint_capabilities(
        ProviderName::Anthropic,
        Some("https://openrouter.ai/api/v1"),
        "anthropic/claude-sonnet-4-6",
    );
    assert_eq!(
        or_ant.native_tool_search,
        Some(NativeToolSearchKind::AnthropicRegex)
    );
    assert_eq!(or_ant.native_programmatic_tool_calling, None);

    // Official Anthropic Claude Sonnet 4.6 vs Claude 3.5 Haiku
    let ant_46 = classify_static_endpoint_capabilities(
        ProviderName::Anthropic,
        Some("https://api.anthropic.com"),
        "claude-sonnet-4-6",
    );
    assert_eq!(
        ant_46.native_tool_search,
        Some(NativeToolSearchKind::AnthropicBm25)
    );
    assert_eq!(
        ant_46.native_programmatic_tool_calling,
        Some(NativeProgrammaticToolCallingKind::AnthropicCodeExecution20260120)
    );

    let ant_35 = classify_static_endpoint_capabilities(
        ProviderName::Anthropic,
        Some("https://api.anthropic.com"),
        "claude-3-5-haiku-20241022",
    );
    assert_eq!(ant_35.native_tool_search, None);
    assert_eq!(ant_35.native_programmatic_tool_calling, None);

    // Codex CLI
    let codex = classify_static_endpoint_capabilities(ProviderName::CodexCli, None, "gpt-5.4");
    assert_eq!(
        codex.native_programmatic_tool_calling,
        Some(NativeProgrammaticToolCallingKind::CodexCodeMode)
    );

    // Loopback / custom base URL honors Auto (None) vs Native vs Harness
    let loopback_auto = resolve_endpoint_tool_capabilities(
        ProviderName::Openai,
        Some("http://127.0.0.1:19999/v1"),
        "gpt-5.4",
        ToolCallingStrategy::Auto,
    );
    assert_eq!(loopback_auto.native_tool_search, None);
    assert_eq!(loopback_auto.native_programmatic_tool_calling, None);

    let loopback_native = resolve_endpoint_tool_capabilities(
        ProviderName::Openai,
        Some("http://127.0.0.1:19999/v1"),
        "gpt-5.4",
        ToolCallingStrategy::Native,
    );
    assert_eq!(
        loopback_native.native_tool_search,
        Some(NativeToolSearchKind::OpenAiResponses)
    );
    assert_eq!(
        loopback_native.native_programmatic_tool_calling,
        Some(NativeProgrammaticToolCallingKind::OpenAiResponses)
    );

    let official_harness = resolve_endpoint_tool_capabilities(
        ProviderName::Anthropic,
        Some("https://api.anthropic.com"),
        "claude-sonnet-4-6",
        ToolCallingStrategy::Harness,
    );
    assert_eq!(official_harness.native_tool_search, None);
    assert_eq!(official_harness.native_programmatic_tool_calling, None);

    // Runtime rejection downgrades Auto immediately
    let reject_url = "https://api.openai.com/v1";
    let reject_model = "gpt-5.4-runtime-rejection-unit";
    record_rejected_native_capability(
        ProviderName::Openai,
        Some(reject_url),
        reject_model,
        true,
        true,
        "HTTP 400 unsupported tool_search",
    );
    let after_reject = resolve_endpoint_tool_capabilities(
        ProviderName::Openai,
        Some(reject_url),
        reject_model,
        ToolCallingStrategy::Auto,
    );
    assert_eq!(
        after_reject.source,
        EndpointCapabilitySource::RuntimeFallback
    );
    assert_eq!(after_reject.native_tool_search, None);
    assert_eq!(after_reject.native_programmatic_tool_calling, None);
}

#[test]
fn native_feature_gates_follow_model_boundaries_and_official_hosts() {
    for (model, supported) in [
        ("gpt-5.4", true),
        ("gpt-5.3", false),
        ("gpt-5", false),
        ("gpt-6", true),
        ("gpt-4.9", false),
        ("GPT-5.4-mini", true),
        ("openai/gpt-5.4", true),
        ("org/team/gpt-5.4", true),
        ("gpt-5.4.1", true),
        ("o3", false),
        ("chatgpt-5.4", false),
        ("gpt5.4", false),
    ] {
        assert_eq!(
            openai_model_supports_native_tool_features(model),
            supported,
            "{model}"
        );
    }
    for (model, supported) in [
        ("claude-sonnet-4-6", true),
        ("claude-opus-4.1", true),
        ("claude-sonnet-5", true),
        ("claude-4-sonnet", true),
        ("anthropic/claude-opus-4-6", true),
        ("claude-3-5-sonnet-20241022", false),
        ("claude-3-opus-20240229", false),
        ("claude-haiku-4-5", false),
        ("claude-haiku-4.5", false),
        ("claude-haiku-4-5-opus-4", false),
        ("claude-haiku-4", false),
    ] {
        assert_eq!(
            anthropic_model_supports_native_tool_features(model),
            supported,
            "{model}"
        );
    }

    let default_openai =
        classify_static_endpoint_capabilities(ProviderName::Openai, None, "gpt-5.4");
    assert_eq!(
        default_openai.endpoint_host.as_deref(),
        Some("api.openai.com")
    );
    assert_eq!(
        default_openai.native_tool_search,
        Some(NativeToolSearchKind::OpenAiResponses)
    );
    assert_eq!(
        default_openai.native_programmatic_tool_calling,
        Some(NativeProgrammaticToolCallingKind::OpenAiResponses)
    );
    let blank_base =
        classify_static_endpoint_capabilities(ProviderName::Openai, Some("   "), "gpt-5.4");
    assert_eq!(blank_base.endpoint_host.as_deref(), Some("api.openai.com"));

    let regional = classify_static_endpoint_capabilities(
        ProviderName::Openai,
        Some("https://US.API.OPENAI.COM/v1/"),
        "GPT-5.4",
    );
    assert_eq!(regional.endpoint_host.as_deref(), Some("us.api.openai.com"));
    assert_eq!(
        regional.native_tool_search,
        Some(NativeToolSearchKind::OpenAiResponses)
    );
    assert_eq!(
        regional.native_programmatic_tool_calling,
        Some(NativeProgrammaticToolCallingKind::OpenAiResponses)
    );

    for url in [
        "https://api.openai.com.evil.com/v1",
        "https://notapi.openai.com/v1",
        "https://evilapi.openai.com/v1",
    ] {
        let caps =
            classify_static_endpoint_capabilities(ProviderName::Openai, Some(url), "gpt-5.4");
        assert_eq!(caps.native_tool_search, None, "{url}");
        assert_eq!(caps.native_programmatic_tool_calling, None, "{url}");
    }

    let anthropic_subdomain = classify_static_endpoint_capabilities(
        ProviderName::Anthropic,
        Some("https://foo.anthropic.com"),
        "claude-sonnet-4",
    );
    assert_eq!(
        anthropic_subdomain.native_tool_search,
        Some(NativeToolSearchKind::AnthropicBm25)
    );
    assert_eq!(
        anthropic_subdomain.native_programmatic_tool_calling,
        Some(NativeProgrammaticToolCallingKind::AnthropicCodeExecution20260120)
    );
    for url in [
        "https://api.anthropic.com.evil.com",
        "https://anthropic.com.evil.com",
        "https://notanthropic.com",
    ] {
        let caps = classify_static_endpoint_capabilities(
            ProviderName::Anthropic,
            Some(url),
            "claude-opus-4",
        );
        assert_eq!(caps.native_tool_search, None, "{url}");
        assert_eq!(caps.native_programmatic_tool_calling, None, "{url}");
    }

    for url in [
        "https://openrouter.ai.evil.com/api/v1",
        "https://notopenrouter.ai/api/v1",
    ] {
        let caps =
            classify_static_endpoint_capabilities(ProviderName::Openai, Some(url), "gpt-5.4");
        assert_eq!(caps.native_tool_search, None, "{url}");
        assert_eq!(caps.native_programmatic_tool_calling, None, "{url}");
    }

    let openrouter_forced = resolve_endpoint_tool_capabilities(
        ProviderName::Openai,
        Some("https://openrouter.ai/api/v1"),
        "gpt-4.1",
        ToolCallingStrategy::Native,
    );
    assert_eq!(
        openrouter_forced.native_tool_search,
        Some(NativeToolSearchKind::OpenRouterResponses)
    );
    assert_eq!(openrouter_forced.native_programmatic_tool_calling, None);

    let google_forced = resolve_endpoint_tool_capabilities(
        ProviderName::Google,
        None,
        "gpt-5.4",
        ToolCallingStrategy::Native,
    );
    assert_eq!(google_forced.native_tool_search, None);
    assert_eq!(google_forced.native_programmatic_tool_calling, None);
}

#[test]
fn programmatic_eligibility_blocks_interactive_tools_and_anthropic_schema_refs() {
    fn tool(name: &str, parameters: Value) -> ToolDefinition {
        ToolDefinition {
            name: name.to_string(),
            description: String::new(),
            parameters,
        }
    }

    for name in ["bash", "READ", "write", "edit", "Glob", "grep"] {
        assert!(is_native_eager_core_tool(name), "{name}");
    }
    assert!(!is_native_eager_core_tool("askUserQuestion"));
    assert!(!is_native_eager_core_tool("bash "));

    let anthropic = NativeProgrammaticToolCallingKind::AnthropicCodeExecution20260120;
    let openai = NativeProgrammaticToolCallingKind::OpenAiResponses;
    for name in [
        "AskUserQuestion",
        "TOOLSEARCH",
        "toolCall",
        "mcpCall",
        "codeMode",
    ] {
        let blocked = tool(name, json!({ "type": "object" }));
        assert!(
            !is_programmatic_eligible_tool(&blocked, anthropic),
            "{name}"
        );
        assert!(!is_programmatic_eligible_tool(&blocked, openai), "{name}");
        assert!(
            !is_programmatic_eligible_tool(
                &blocked,
                NativeProgrammaticToolCallingKind::CodexCodeMode
            ),
            "{name}"
        );
    }

    let with_ref = tool(
        "bash",
        json!({
            "type": "object",
            "properties": { "q": { "$ref": "#/$defs/Q" } }
        }),
    );
    assert!(!is_programmatic_eligible_tool(&with_ref, anthropic));
    assert!(is_programmatic_eligible_tool(&with_ref, openai));
    assert!(is_programmatic_eligible_tool(
        &with_ref,
        NativeProgrammaticToolCallingKind::CodexCodeMode
    ));

    let nested_array_ref = tool(
        "grep",
        json!({
            "anyOf": [{ "type": "array", "items": [{ "$ref": "#/A" }] }]
        }),
    );
    assert!(!is_programmatic_eligible_tool(&nested_array_ref, anthropic));

    let plain = tool(
        "grep",
        json!({
            "type": "object",
            "properties": { "q": { "type": "string", "description": "not a $ref" } }
        }),
    );
    assert!(is_programmatic_eligible_tool(&plain, anthropic));
}

#[test]
fn runtime_rejection_is_partial_and_ignores_url_and_model_spelling() {
    let model = "gpt-5.4-partial-rejection";
    record_rejected_native_capability(
        ProviderName::Openai,
        Some("https://API.OPENAI.COM/v1/"),
        "GPT-5.4-Partial-Rejection",
        true,
        false,
        "tool_search unsupported",
    );
    let search_only = resolve_endpoint_tool_capabilities(
        ProviderName::Openai,
        Some("https://api.openai.com/v1"),
        "  gpt-5.4-partial-rejection  ",
        ToolCallingStrategy::Auto,
    );
    assert_eq!(
        search_only.source,
        EndpointCapabilitySource::RuntimeFallback
    );
    assert_eq!(search_only.native_tool_search, None);
    assert_eq!(
        search_only.native_programmatic_tool_calling,
        Some(NativeProgrammaticToolCallingKind::OpenAiResponses)
    );

    record_rejected_native_capability(
        ProviderName::Openai,
        Some("https://api.openai.com/v1"),
        model,
        false,
        true,
        "programmatic_tool_calling unsupported",
    );
    let both = resolve_endpoint_tool_capabilities(
        ProviderName::Openai,
        Some("https://api.openai.com/v1"),
        model,
        ToolCallingStrategy::Auto,
    );
    assert_eq!(both.native_tool_search, None);
    assert_eq!(both.native_programmatic_tool_calling, None);
}

#[tokio::test]
async fn active_endpoint_probe_verifies_anthropic_and_openai_model_capabilities() {
    let (origin, state) = spawn_mock_provider_server(Vec::new()).await;

    // 1. Custom OpenAI-compatible proxy advertising `gpt-5.4` capabilities upgrades from None -> Native!
    let oa_base = format!("{origin}/v1");
    let oa_caps = check_endpoint_capabilities(
        ProviderName::Openai,
        Some(&oa_base),
        "gpt-5.4-probed",
        Some("sk-test-openai"),
        None,
        false,
    )
    .await;
    assert_eq!(oa_caps.source, EndpointCapabilitySource::EndpointCheck);
    assert_eq!(
        oa_caps.native_tool_search,
        Some(NativeToolSearchKind::OpenAiResponses)
    );
    assert_eq!(
        oa_caps.native_programmatic_tool_calling,
        Some(NativeProgrammaticToolCallingKind::OpenAiResponses)
    );

    // Cached repeat call does NOT hit HTTP server again unless `force_refresh: true`.
    let count_after_first = state.model_probes.lock().unwrap().len();
    let _cached = check_endpoint_capabilities(
        ProviderName::Openai,
        Some(&oa_base),
        "gpt-5.4-probed",
        Some("sk-test-openai"),
        None,
        false,
    )
    .await;
    assert_eq!(state.model_probes.lock().unwrap().len(), count_after_first);

    // 404 model on custom OpenAI endpoint stays on Cowork harness (None).
    let missing_caps = check_endpoint_capabilities(
        ProviderName::Openai,
        Some(&oa_base),
        "local-llama-3",
        Some("sk-test-openai"),
        None,
        true,
    )
    .await;
    assert_eq!(missing_caps.source, EndpointCapabilitySource::EndpointCheck);
    assert_eq!(missing_caps.native_tool_search, None);
    assert_eq!(missing_caps.native_programmatic_tool_calling, None);

    // 2. Custom Anthropic gateway returning `/v1/models/{id}` capabilities upgrades to native BM25 + code execution!
    let ant_base = format!("{origin}/anthropic");
    let ant_caps = check_endpoint_capabilities(
        ProviderName::Anthropic,
        Some(&ant_base),
        "claude-sonnet-4-6-probed",
        Some("sk-ant-api03-test"),
        None,
        true,
    )
    .await;
    assert_eq!(ant_caps.source, EndpointCapabilitySource::EndpointCheck);
    assert_eq!(
        ant_caps.native_tool_search,
        Some(NativeToolSearchKind::AnthropicBm25)
    );
    assert_eq!(
        ant_caps.native_programmatic_tool_calling,
        Some(NativeProgrammaticToolCallingKind::AnthropicCodeExecution20260120)
    );
}

#[tokio::test]
async fn openai_responses_native_tool_search_ptc_caller_echo_continuation_fallback_and_tools_none()
{
    let step1_sse = [
        openai_sse(json!({
            "type": "response.created",
            "response": { "id": "resp_ptc_1", "status": "in_progress" }
        })),
        openai_sse(json!({
            "type": "response.output_item.added",
            "output_index": 0,
            "item": { "id": "ts_1", "type": "tool_search_call", "query": "github issues" }
        })),
        openai_sse(json!({
            "type": "response.output_item.done",
            "output_index": 0,
            "item": { "id": "ts_1", "type": "tool_search_call", "query": "github issues" }
        })),
        openai_sse(json!({
            "type": "response.output_item.added",
            "output_index": 1,
            "item": { "id": "tso_1", "type": "tool_search_output", "tools": ["mcp__github__search_issues"] }
        })),
        openai_sse(json!({
            "type": "response.output_item.done",
            "output_index": 1,
            "item": { "id": "tso_1", "type": "tool_search_output", "tools": ["mcp__github__search_issues"] }
        })),
        openai_sse(json!({
            "type": "response.output_item.added",
            "output_index": 2,
            "item": { "id": "prog_1", "type": "program", "code": "" }
        })),
        openai_sse(json!({
            "type": "response.program.delta",
            "output_index": 2,
            "item_id": "prog_1",
            "delta": "const issues = await mcp__github__search_issues({ query: 'bug' });"
        })),
        openai_sse(json!({
            "type": "response.output_item.done",
            "output_index": 2,
            "item": {
                "id": "prog_1",
                "type": "program",
                "code": "const issues = await mcp__github__search_issues({ query: 'bug' });"
            }
        })),
        openai_sse(json!({
            "type": "response.output_item.added",
            "output_index": 3,
            "item": {
                "id": "fc_item_1",
                "call_id": "call_gh_1",
                "type": "function_call",
                "name": "mcp__github__search_issues",
                "caller": { "type": "programmatic", "program_id": "prog_1" },
                "arguments": ""
            }
        })),
        openai_sse(json!({
            "type": "response.function_call_arguments.done",
            "output_index": 3,
            "item_id": "fc_item_1",
            "arguments": "{\"query\":\"bug\"}"
        })),
        openai_sse(json!({
            "type": "response.output_item.done",
            "output_index": 3,
            "item": {
                "id": "fc_item_1",
                "call_id": "call_gh_1",
                "type": "function_call",
                "name": "mcp__github__search_issues",
                "caller": { "type": "programmatic", "program_id": "prog_1" },
                "arguments": "{\"query\":\"bug\"}"
            }
        })),
        openai_sse(json!({
            "type": "response.completed",
            "response": {
                "id": "resp_ptc_1",
                "status": "completed",
                "usage": { "input_tokens": 100, "output_tokens": 30, "total_tokens": 130 }
            }
        })),
    ]
    .concat();

    // Step 2 returns ONLY a `program_output` item (no final assistant text yet), requiring an
    // automatic empty-input continuation step!
    let step2_sse = [
        openai_sse(json!({
            "type": "response.created",
            "response": { "id": "resp_ptc_2", "status": "in_progress" }
        })),
        openai_sse(json!({
            "type": "response.output_item.added",
            "output_index": 0,
            "item": { "id": "po_1", "type": "program_output", "program_id": "prog_1", "output": "Found 1 bug" }
        })),
        openai_sse(json!({
            "type": "response.output_item.done",
            "output_index": 0,
            "item": { "id": "po_1", "type": "program_output", "program_id": "prog_1", "output": "Found 1 bug" }
        })),
        openai_sse(json!({
            "type": "response.completed",
            "response": {
                "id": "resp_ptc_2",
                "status": "completed",
                "usage": { "input_tokens": 120, "output_tokens": 15, "total_tokens": 135 }
            }
        })),
    ]
    .concat();

    // Fallback test replies: HTTP 400 rejecting native tool -> immediate retry 200 SSE!
    let fallback_ok_sse = [
        openai_sse(json!({
            "type": "response.created",
            "response": { "id": "resp_fb_1", "status": "in_progress" }
        })),
        openai_sse(json!({
            "type": "response.output_item.added",
            "output_index": 0,
            "item": { "id": "msg_fb_1", "type": "message", "content": [] }
        })),
        openai_sse(json!({
            "type": "response.output_text.delta",
            "output_index": 0,
            "item_id": "msg_fb_1",
            "delta": "Fallback succeeded."
        })),
        openai_sse(json!({
            "type": "response.output_item.done",
            "output_index": 0,
            "item": {
                "id": "msg_fb_1",
                "type": "message",
                "content": [{ "type": "output_text", "text": "Fallback succeeded." }]
            }
        })),
        openai_sse(json!({
            "type": "response.completed",
            "response": {
                "id": "resp_fb_1",
                "status": "completed",
                "usage": { "input_tokens": 20, "output_tokens": 5, "total_tokens": 25 }
            }
        })),
    ]
    .concat();

    let (origin, state) = spawn_mock_provider_server(vec![
        MockHttpReply::sse(step1_sse),
        MockHttpReply::sse(step2_sse),
        MockHttpReply::json_err(
            StatusCode::BAD_REQUEST,
            json!({
                "error": {
                    "message": "Invalid value: 'programmatic_tool_calling' is not supported for tools[1].type",
                    "type": "invalid_request_error"
                }
            }),
        ),
        MockHttpReply::sse(fallback_ok_sse.clone()),
        MockHttpReply::sse(fallback_ok_sse),
    ])
    .await;
    let base_url = format!("{origin}/v1");
    let transport = OpenAiResponsesTransport::new();

    let mut provider_options = Map::new();
    let plan = NativeToolCallingPlan {
        tool_search: Some(NativeToolSearchKind::OpenAiResponses),
        programmatic_tool_calling: Some(NativeProgrammaticToolCallingKind::OpenAiResponses),
        deferred_tool_names: vec!["mcp__github__search_issues".to_string()],
        programmatic_tool_names: vec!["bash".to_string(), "mcp__github__search_issues".to_string()],
        codex_code_mode: None,
    };
    write_native_tool_calling_plan(&mut provider_options, &plan);

    let user_msg = CanonicalMessage {
        id: "u1".to_string(),
        role: MessageRole::User,
        content: vec![ContentBlock::Text {
            text: "Find open bug issues".to_string(),
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
        created_at: "2026-11-04T00:00:00Z".to_string(),
    };

    let mut events = Vec::new();
    let step1 = transport
        .stream_step(
            ProviderStepRequest {
                model_id: "gpt-5.4".to_string(),
                base_url: Some(base_url.clone()),
                api_key: Some("sk-test".to_string()),
                extra_headers: HashMap::new(),
                system_prompt: "System".to_string(),
                messages: vec![user_msg.clone()],
                tools: sample_tools(),
                authorized_tool_names: None,
                provider_options: provider_options.clone(),
                continuation: None,
                policy: RequestPolicy::default(),
                turn_id: "turn-oa-ptc".to_string(),
            },
            &StepBudget::unbounded(None),
            &mut |ev: StreamEvent| events.push(ev),
        )
        .await
        .expect("step 1 should succeed");

    // Verify Step 1 wire tools envelope
    {
        let reqs = state.requests.lock().unwrap();
        let wire_tools = reqs[0].1["tools"].as_array().expect("tools array");
        assert!(
            wire_tools
                .iter()
                .any(|t| t == &json!({ "type": "tool_search" }))
        );
        assert!(
            wire_tools
                .iter()
                .any(|t| t == &json!({ "type": "programmatic_tool_calling" }))
        );
        let bash_tool = wire_tools
            .iter()
            .find(|t| t.get("name") == Some(&json!("bash")))
            .expect("bash tool");
        assert!(bash_tool.get("defer_loading").is_none());
        assert_eq!(
            bash_tool.get("allowed_callers"),
            Some(&json!(["direct", "programmatic"]))
        );

        let ask_tool = wire_tools
            .iter()
            .find(|t| t.get("name") == Some(&json!("askUserQuestion")))
            .expect("askUserQuestion tool");
        assert!(ask_tool.get("allowed_callers").is_none());

        let gh_tool = wire_tools
            .iter()
            .find(|t| t.get("name") == Some(&json!("mcp__github__search_issues")))
            .expect("github tool");
        assert_eq!(gh_tool.get("defer_loading"), Some(&json!(true)));
        assert_eq!(
            gh_tool.get("allowed_callers"),
            Some(&json!(["direct", "programmatic"]))
        );
    }

    // Extract tool call and verify `openaiCaller` was captured on `provider_meta.extra`
    let tc_block = step1
        .assistant
        .content
        .iter()
        .find_map(|b| match b {
            ContentBlock::ToolCall {
                id,
                name,
                provider_meta,
                ..
            } => Some((id.clone(), name.clone(), provider_meta.clone())),
            _ => None,
        })
        .expect("expected programmatic function_call block");
    assert_eq!(tc_block.1, "mcp__github__search_issues");
    let caller_val = tc_block
        .2
        .extra
        .get("openaiCaller")
        .cloned()
        .expect("openaiCaller preserved");
    assert_eq!(
        caller_val,
        json!({ "type": "programmatic", "program_id": "prog_1" })
    );

    // Step 2: send full replay (continuation = None) with `openaiCaller` stamped on ToolResult
    let mut tr_extra = Map::new();
    tr_extra.insert("openaiCaller".to_string(), caller_val.clone());
    let tool_msg = CanonicalMessage {
        id: "tr1".to_string(),
        role: MessageRole::Tool,
        content: vec![ContentBlock::ToolResult {
            tool_call_id: tc_block.0,
            tool_name: Some(tc_block.1),
            content: vec![ToolResultPart::Text {
                text: "[{\"number\":42}]".to_string(),
            }],
            is_error: false,
            structured_meta: None,
            provider_meta: ProviderOpaqueMeta {
                extra: tr_extra,
                ..Default::default()
            },
        }],
        phase: None,
        provider: None,
        api: None,
        model: None,
        stop_reason: None,
        provider_meta: ProviderOpaqueMeta::default(),
        created_at: "2026-11-04T00:00:01Z".to_string(),
    };

    let step2 = transport
        .stream_step(
            ProviderStepRequest {
                model_id: "gpt-5.4".to_string(),
                base_url: Some(base_url.clone()),
                api_key: Some("sk-test".to_string()),
                extra_headers: HashMap::new(),
                system_prompt: "System".to_string(),
                messages: vec![user_msg.clone(), step1.assistant, tool_msg],
                tools: sample_tools(),
                authorized_tool_names: None,
                provider_options: provider_options.clone(),
                continuation: None,
                policy: RequestPolicy::default(),
                turn_id: "turn-oa-ptc".to_string(),
            },
            &StepBudget::unbounded(None),
            &mut |_ev| {},
        )
        .await
        .expect("step 2 should succeed");

    // Verify Step 2 replayed native items + echoed `caller` on `function_call_output`, and marked
    // `requiresContinuationStep: true` on `program_output`-only response!
    {
        let reqs = state.requests.lock().unwrap();
        let input = reqs[1].1["input"].as_array().expect("step 2 input array");
        assert!(
            input
                .iter()
                .any(|i| i.get("type") == Some(&json!("tool_search_call")))
        );
        assert!(
            input
                .iter()
                .any(|i| i.get("type") == Some(&json!("tool_search_output")))
        );
        assert!(
            input
                .iter()
                .any(|i| i.get("type") == Some(&json!("program")))
        );
        let fco = input
            .iter()
            .find(|i| i.get("type") == Some(&json!("function_call_output")))
            .expect("function_call_output item");
        assert_eq!(fco.get("caller"), Some(&caller_val));
    }
    assert_eq!(
        step2
            .assistant
            .provider_meta
            .extra
            .get("requiresContinuationStep"),
        Some(&json!(true))
    );

    // Step 3: Pre-output HTTP 400 rejecting native PTC automatically retries with plain eager tools!
    let fb_res = transport
        .stream_step(
            ProviderStepRequest {
                model_id: "gpt-5.4-fallback".to_string(),
                base_url: Some(base_url.clone()),
                api_key: Some("sk-test".to_string()),
                extra_headers: HashMap::new(),
                system_prompt: "System".to_string(),
                messages: vec![user_msg.clone()],
                tools: sample_tools(),
                authorized_tool_names: None,
                provider_options: provider_options.clone(),
                continuation: None,
                policy: RequestPolicy::default(),
                turn_id: "turn-oa-fb".to_string(),
            },
            &StepBudget::unbounded(None),
            &mut |_ev| {},
        )
        .await
        .expect("HTTP 400 native rejection should retry and succeed with plain tools");
    assert!(fb_res.assistant.content.iter().any(|b| matches!(
        b,
        ContentBlock::Text { text, .. } if text == "Fallback succeeded."
    )));
    {
        let reqs = state.requests.lock().unwrap();
        // reqs[2] had native tools; reqs[3] was the automatic fallback without native tools!
        let retry_tools = reqs[3].1["tools"].as_array().expect("retry tools");
        assert!(
            !retry_tools
                .iter()
                .any(|t| t.get("type") == Some(&json!("programmatic_tool_calling")))
        );
        assert!(
            retry_tools
                .iter()
                .all(|t| t.get("allowed_callers").is_none())
        );
    }
    let post_fb_caps = resolve_endpoint_tool_capabilities(
        ProviderName::Openai,
        Some(&base_url),
        "gpt-5.4-fallback",
        ToolCallingStrategy::Auto,
    );
    assert_eq!(
        post_fb_caps.source,
        EndpointCapabilitySource::RuntimeFallback
    );
    assert_eq!(post_fb_caps.native_programmatic_tool_calling, None);

    // Step 4: `tools: "none"` (`__coworkToolsDisabled: true`) suppresses ALL tools even when plan is set!
    let mut disabled_opts = provider_options.clone();
    disabled_opts.insert(COWORK_TOOLS_DISABLED_OPTION_KEY.to_string(), json!(true));
    transport
        .stream_step(
            ProviderStepRequest {
                model_id: "gpt-5.4".to_string(),
                base_url: Some(base_url),
                api_key: Some("sk-test".to_string()),
                extra_headers: HashMap::new(),
                system_prompt: "System".to_string(),
                messages: vec![user_msg],
                tools: sample_tools(),
                authorized_tool_names: Some(Vec::new()),
                provider_options: disabled_opts,
                continuation: None,
                policy: RequestPolicy::default(),
                turn_id: "turn-oa-disabled".to_string(),
            },
            &StepBudget::unbounded(None),
            &mut |_ev| {},
        )
        .await
        .expect("tools:none step should succeed");
    {
        let reqs = state.requests.lock().unwrap();
        assert!(
            reqs[4].1.get("tools").is_none(),
            "tools:none must omit all tools on OpenAI wire"
        );
    }
}

#[tokio::test]
async fn anthropic_messages_native_tool_search_code_execution_cache_control_container_pause_turn_and_fallback()
 {
    let step1_sse = [
        anthropic_sse(
            "message_start",
            json!({
                "type": "message_start",
                "message": {
                    "id": "msg_ant_1",
                    "type": "message",
                    "role": "assistant",
                    "model": "claude-sonnet-4-6",
                    "container": {
                        "id": "cntr_reuse_123",
                        "expires_at": "2026-12-01T00:00:00Z"
                    },
                    "usage": { "input_tokens": 90, "output_tokens": 1 }
                }
            }),
        ),
        anthropic_sse(
            "content_block_start",
            json!({
                "type": "content_block_start",
                "index": 0,
                "content_block": {
                    "type": "server_tool_use",
                    "id": "srvtoolu_ts_1",
                    "name": "tool_search_tool_bm25",
                    "input": {}
                }
            }),
        ),
        anthropic_sse(
            "content_block_delta",
            json!({
                "type": "content_block_delta",
                "index": 0,
                "delta": {
                    "type": "input_json_delta",
                    "partial_json": "{\"query\":\"github\"}"
                }
            }),
        ),
        anthropic_sse(
            "content_block_stop",
            json!({ "type": "content_block_stop", "index": 0 }),
        ),
        anthropic_sse(
            "content_block_start",
            json!({
                "type": "content_block_start",
                "index": 1,
                "content_block": {
                    "type": "tool_search_tool_result",
                    "tool_use_id": "srvtoolu_ts_1",
                    "content": {
                        "type": "tool_search_tool_search_result",
                        "tool_references": [{ "type": "tool_reference", "tool_name": "mcp__github__search_issues" }]
                    }
                }
            }),
        ),
        anthropic_sse(
            "content_block_stop",
            json!({ "type": "content_block_stop", "index": 1 }),
        ),
        anthropic_sse(
            "content_block_start",
            json!({
                "type": "content_block_start",
                "index": 2,
                "content_block": {
                    "type": "tool_use",
                    "id": "toolu_gh_1",
                    "name": "mcp__github__search_issues",
                    "caller": { "type": "code_execution_20260120", "tool_id": "srvtoolu_ce_1" },
                    "input": {}
                }
            }),
        ),
        anthropic_sse(
            "content_block_delta",
            json!({
                "type": "content_block_delta",
                "index": 2,
                "delta": { "type": "input_json_delta", "partial_json": "{\"query\":\"crash\"}" }
            }),
        ),
        anthropic_sse(
            "content_block_stop",
            json!({ "type": "content_block_stop", "index": 2 }),
        ),
        anthropic_sse(
            "message_delta",
            json!({
                "type": "message_delta",
                "delta": { "stop_reason": "pause_turn" },
                "usage": { "output_tokens": 42 }
            }),
        ),
        anthropic_sse("message_stop", json!({ "type": "message_stop" })),
    ]
    .concat();

    let step2_sse = [
        anthropic_sse(
            "message_start",
            json!({
                "type": "message_start",
                "message": {
                    "id": "msg_ant_2",
                    "type": "message",
                    "role": "assistant",
                    "model": "claude-sonnet-4-6",
                    "usage": { "input_tokens": 110, "output_tokens": 1 }
                }
            }),
        ),
        anthropic_sse(
            "content_block_start",
            json!({
                "type": "content_block_start",
                "index": 0,
                "content_block": { "type": "text", "text": "All done." }
            }),
        ),
        anthropic_sse(
            "content_block_stop",
            json!({ "type": "content_block_stop", "index": 0 }),
        ),
        anthropic_sse(
            "message_delta",
            json!({
                "type": "message_delta",
                "delta": { "stop_reason": "end_turn" },
                "usage": { "output_tokens": 10 }
            }),
        ),
        anthropic_sse("message_stop", json!({ "type": "message_stop" })),
    ]
    .concat();

    let (origin, state) = spawn_mock_provider_server(vec![
        MockHttpReply::sse(step1_sse),
        MockHttpReply::sse(step2_sse.clone()),
        MockHttpReply::json_err(
            StatusCode::BAD_REQUEST,
            json!({
                "type": "error",
                "error": {
                    "type": "invalid_request_error",
                    "message": "tools.4.code_execution_20260120: unsupported tool type"
                }
            }),
        ),
        MockHttpReply::sse(step2_sse.clone()),
        MockHttpReply::sse(step2_sse),
    ])
    .await;
    let transport = AnthropicMessagesTransport::new();

    let mut provider_options = Map::new();
    provider_options.insert(
        "anthropic".to_string(),
        json!({ "cacheRetention": "short" }),
    );
    let plan = NativeToolCallingPlan {
        tool_search: Some(NativeToolSearchKind::AnthropicBm25),
        programmatic_tool_calling: Some(
            NativeProgrammaticToolCallingKind::AnthropicCodeExecution20260120,
        ),
        deferred_tool_names: vec!["mcp__github__search_issues".to_string()],
        programmatic_tool_names: vec!["bash".to_string(), "mcp__github__search_issues".to_string()],
        codex_code_mode: None,
    };
    write_native_tool_calling_plan(&mut provider_options, &plan);

    let user_msg = CanonicalMessage {
        id: "u-ant-1".to_string(),
        role: MessageRole::User,
        content: vec![ContentBlock::Text {
            text: "Search crash issues".to_string(),
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
        created_at: "2026-11-04T00:00:00Z".to_string(),
    };

    let step1 = transport
        .stream_step(
            ProviderStepRequest {
                model_id: "claude-sonnet-4-6".to_string(),
                base_url: Some(origin.clone()),
                api_key: Some("sk-ant-api03-test".to_string()),
                extra_headers: HashMap::new(),
                system_prompt: "System prompt".to_string(),
                messages: vec![user_msg.clone()],
                tools: sample_tools(),
                authorized_tool_names: None,
                provider_options: provider_options.clone(),
                continuation: None,
                policy: RequestPolicy::default(),
                turn_id: "turn-ant-ptc".to_string(),
            },
            &StepBudget::unbounded(None),
            &mut |_ev| {},
        )
        .await
        .expect("Anthropic step 1 should succeed");

    // Verify Step 1 wire payload & cache_control placement
    {
        let reqs = state.requests.lock().unwrap();
        let wire_tools = reqs[0].1["tools"].as_array().expect("Anthropic tools");
        assert!(
            wire_tools
                .iter()
                .any(|t| t.get("type") == Some(&json!("tool_search_tool_bm25_20251119")))
        );
        assert!(
            wire_tools
                .iter()
                .any(|t| t.get("type") == Some(&json!("code_execution_20260120")))
        );

        let bash_tool = wire_tools
            .iter()
            .find(|t| t.get("name") == Some(&json!("bash")))
            .unwrap();
        assert!(bash_tool.get("cache_control").is_none());
        assert_eq!(
            bash_tool.get("allowed_callers"),
            Some(&json!(["direct", "code_execution_20260120"]))
        );

        // `askUserQuestion` is the last NON-deferred custom tool -> receives `cache_control`, and NO `allowed_callers`!
        let ask_tool = wire_tools
            .iter()
            .find(|t| t.get("name") == Some(&json!("askUserQuestion")))
            .unwrap();
        assert!(ask_tool.get("cache_control").is_some());
        assert!(ask_tool.get("allowed_callers").is_none());

        // Deferred tool MUST NOT have `cache_control`, and MUST have `defer_loading: true`!
        let gh_tool = wire_tools
            .iter()
            .find(|t| t.get("name") == Some(&json!("mcp__github__search_issues")))
            .unwrap();
        assert_eq!(gh_tool.get("defer_loading"), Some(&json!(true)));
        assert!(gh_tool.get("cache_control").is_none());
        assert_eq!(
            gh_tool.get("allowed_callers"),
            Some(&json!(["direct", "code_execution_20260120"]))
        );
    }

    assert_eq!(
        step1
            .assistant
            .provider_meta
            .extra
            .get("requiresContinuationStep"),
        Some(&json!(true)),
        "pause_turn must set requiresContinuationStep"
    );
    assert_eq!(
        step1.assistant.provider_meta.extra["anthropicContainer"]["id"],
        json!("cntr_reuse_123")
    );

    let tool_msg = CanonicalMessage {
        id: "tr-ant-1".to_string(),
        role: MessageRole::Tool,
        content: vec![ContentBlock::ToolResult {
            tool_call_id: "toolu_gh_1".to_string(),
            tool_name: Some("mcp__github__search_issues".to_string()),
            content: vec![ToolResultPart::Text {
                text: "[]".to_string(),
            }],
            is_error: false,
            structured_meta: None,
            provider_meta: ProviderOpaqueMeta::default(),
        }],
        phase: None,
        provider: None,
        api: None,
        model: None,
        stop_reason: None,
        provider_meta: ProviderOpaqueMeta::default(),
        created_at: "2026-11-04T00:00:01Z".to_string(),
    };

    // Step 2: verify `container` ID reuse + replayed `server_tool_use` (with streamed input) + `tool_use.caller`
    let _step2 = transport
        .stream_step(
            ProviderStepRequest {
                model_id: "claude-sonnet-4-6".to_string(),
                base_url: Some(origin.clone()),
                api_key: Some("sk-ant-api03-test".to_string()),
                extra_headers: HashMap::new(),
                system_prompt: "System prompt".to_string(),
                messages: vec![user_msg.clone(), step1.assistant.clone(), tool_msg.clone()],
                tools: sample_tools(),
                authorized_tool_names: None,
                provider_options: provider_options.clone(),
                continuation: None,
                policy: RequestPolicy::default(),
                turn_id: "turn-ant-ptc".to_string(),
            },
            &StepBudget::unbounded(None),
            &mut |_ev| {},
        )
        .await
        .expect("Anthropic step 2 should succeed");

    {
        let reqs = state.requests.lock().unwrap();
        assert_eq!(reqs[1].1.get("container"), Some(&json!("cntr_reuse_123")));
        let assistant_wire = reqs[1].1["messages"][1]["content"]
            .as_array()
            .expect("replayed assistant blocks");
        let srv_use = assistant_wire
            .iter()
            .find(|b| b.get("type") == Some(&json!("server_tool_use")))
            .expect("replayed server_tool_use");
        assert_eq!(srv_use.get("input"), Some(&json!({ "query": "github" })));
        let cli_use = assistant_wire
            .iter()
            .find(|b| b.get("type") == Some(&json!("tool_use")))
            .expect("replayed tool_use");
        assert_eq!(
            cli_use.get("caller"),
            Some(&json!({ "type": "code_execution_20260120", "tool_id": "srvtoolu_ce_1" }))
        );
    }

    // Step 3: Pre-output HTTP 400 fallback retries with plain eager tools
    transport
        .stream_step(
            ProviderStepRequest {
                model_id: "claude-sonnet-4-6-fallback".to_string(),
                base_url: Some(origin.clone()),
                api_key: Some("sk-ant-api03-test".to_string()),
                extra_headers: HashMap::new(),
                system_prompt: "System prompt".to_string(),
                messages: vec![user_msg.clone()],
                tools: sample_tools(),
                authorized_tool_names: None,
                provider_options: provider_options.clone(),
                continuation: None,
                policy: RequestPolicy::default(),
                turn_id: "turn-ant-fb".to_string(),
            },
            &StepBudget::unbounded(None),
            &mut |_ev| {},
        )
        .await
        .expect("Anthropic HTTP 400 native rejection should retry and succeed");
    {
        let reqs = state.requests.lock().unwrap();
        let retry_tools = reqs[3].1["tools"]
            .as_array()
            .expect("Anthropic retry tools");
        assert!(
            !retry_tools
                .iter()
                .any(|t| t.get("type") == Some(&json!("code_execution_20260120")))
        );
    }

    // Step 4: `tools: "none"` omits both `tools` AND `container`!
    let mut disabled_opts = provider_options;
    disabled_opts.insert(COWORK_TOOLS_DISABLED_OPTION_KEY.to_string(), json!(true));
    transport
        .stream_step(
            ProviderStepRequest {
                model_id: "claude-sonnet-4-6".to_string(),
                base_url: Some(origin),
                api_key: Some("sk-ant-api03-test".to_string()),
                extra_headers: HashMap::new(),
                system_prompt: "System prompt".to_string(),
                messages: vec![user_msg, step1.assistant, tool_msg],
                tools: sample_tools(),
                authorized_tool_names: Some(Vec::new()),
                provider_options: disabled_opts,
                continuation: None,
                policy: RequestPolicy::default(),
                turn_id: "turn-ant-disabled".to_string(),
            },
            &StepBudget::unbounded(None),
            &mut |_ev| {},
        )
        .await
        .expect("Anthropic tools:none step should succeed");
    {
        let reqs = state.requests.lock().unwrap();
        assert!(reqs[4].1.get("tools").is_none());
        assert!(reqs[4].1.get("container").is_none());
    }
}
