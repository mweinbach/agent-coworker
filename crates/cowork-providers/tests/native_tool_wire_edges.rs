//! Wire-contract edges for native tool search and programmatic tool calling.
//!
//! These cases are the requests Anthropic or OpenAI reject outright, or the fallback that would
//! disable a feature the error did not name:
//! - regex versus BM25 tool search, including a case-insensitive `toolSearchVariant`
//! - `cache_control` must never sit on a `defer_loading` tool
//! - programmatic calling suppresses `disable_parallel_tool_use` and skips ineligible tools
//! - container reuse stops at an expired container and loses to an explicit id
//! - OpenRouter emits `openrouter:tool_search`; a foreign tool-search kind emits neither
//! - a 500 or an unrelated 400 does not downgrade; a named 400 downgrades only that feature

use std::sync::{Arc, Mutex};

use axum::{
    Json, Router,
    body::Body,
    extract::{Path as AxumPath, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use cowork_config::{ProviderName, ToolCallingStrategy};
use cowork_inference::{
    CanonicalMessage, ContentBlock, MessageRole, ProviderOpaqueMeta, RequestPolicy, StepBudget,
};
use cowork_providers::{
    AnthropicMessagesTransport, EndpointCapabilitySource, NativeProgrammaticToolCallingKind,
    NativeToolCallingPlan, NativeToolSearchKind, OpenAiResponsesTransport, ProviderStepRequest,
    ProviderTransport, ToolDefinition, check_endpoint_capabilities,
    resolve_endpoint_tool_capabilities, write_native_tool_calling_plan,
};
use serde_json::{Map, Value, json};

#[derive(Clone, Default)]
struct WireState {
    posts: Arc<Mutex<Vec<Value>>>,
    replies: Arc<Mutex<Vec<MockReply>>>,
}

struct MockReply {
    status: StatusCode,
    content_type: &'static str,
    body: String,
}

impl MockReply {
    fn sse(body: String) -> Self {
        Self {
            status: StatusCode::OK,
            content_type: "text/event-stream",
            body,
        }
    }

    fn json_err(status: StatusCode, message: &str) -> Self {
        Self {
            status,
            content_type: "application/json",
            body: json!({ "error": { "message": message } }).to_string(),
        }
    }
}

async fn handle_post(State(state): State<WireState>, Json(payload): Json<Value>) -> Response {
    state.posts.lock().expect("posts").push(payload);
    let mut replies = state.replies.lock().expect("replies");
    assert!(
        !replies.is_empty(),
        "mock provider ran out of scripted replies"
    );
    let reply = replies.remove(0);
    drop(replies);
    Response::builder()
        .status(reply.status)
        .header(header::CONTENT_TYPE, reply.content_type)
        .body(Body::from(reply.body))
        .expect("mock HTTP response")
        .into_response()
}

async fn handle_get_model(AxumPath(model_id): AxumPath<String>) -> Response {
    let body = if model_id.starts_with("claude") {
        json!({
            "id": model_id,
            "type": "model",
            "capabilities": {
                "code_execution": { "supported": true },
                "tool_search": { "supported": true }
            }
        })
    } else {
        json!({
            "id": model_id,
            "object": "model",
            "owned_by": "openai",
            "capabilities": {
                "tool_search": true,
                "programmatic_tool_calling": true
            }
        })
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/json")
        .header("openai-processing-ms", "12")
        .body(Body::from(body.to_string()))
        .expect("mock model probe")
        .into_response()
}

async fn spawn_mock(replies: Vec<MockReply>) -> (String, WireState) {
    let state = WireState {
        posts: Arc::new(Mutex::new(Vec::new())),
        replies: Arc::new(Mutex::new(replies)),
    };
    let app = Router::new()
        .route("/v1/responses", post(handle_post))
        .route("/v1/messages", post(handle_post))
        .route("/v1/models/{model_id}", get(handle_get_model))
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral 127.0.0.1:0");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("http://{addr}"), state)
}

fn fast_policy() -> RequestPolicy {
    RequestPolicy {
        max_attempts: 1,
        base_delay_ms: 0,
        ..RequestPolicy::default()
    }
}

fn object_schema() -> Value {
    json!({
        "type": "object",
        "properties": { "q": { "type": "string" } },
        "required": ["q"]
    })
}

fn tool(name: &str, parameters: Value) -> ToolDefinition {
    ToolDefinition {
        name: name.to_string(),
        description: format!("{name} tool"),
        parameters,
    }
}

fn text_message(id: &str, role: MessageRole, text: &str) -> CanonicalMessage {
    CanonicalMessage {
        id: id.to_string(),
        role,
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
        created_at: "2026-11-04T00:00:00Z".to_string(),
    }
}

fn user_message() -> CanonicalMessage {
    text_message("user-1", MessageRole::User, "Search the repo")
}

fn assistant_with_container(id: &str, container: Value) -> CanonicalMessage {
    let mut message = text_message(id, MessageRole::Assistant, "previous");
    message
        .provider_meta
        .extra
        .insert("anthropicContainer".to_string(), container);
    message
}

fn plan(
    tool_search: Option<NativeToolSearchKind>,
    programmatic: Option<NativeProgrammaticToolCallingKind>,
    deferred: &[&str],
    programmatic_names: &[&str],
) -> NativeToolCallingPlan {
    NativeToolCallingPlan {
        tool_search,
        programmatic_tool_calling: programmatic,
        deferred_tool_names: deferred.iter().map(|name| (*name).to_string()).collect(),
        programmatic_tool_names: programmatic_names
            .iter()
            .map(|name| (*name).to_string())
            .collect(),
        codex_code_mode: None,
    }
}

fn options_with_plan(plan: &NativeToolCallingPlan, extra: Value) -> Map<String, Value> {
    let mut opts = extra.as_object().cloned().unwrap_or_default();
    write_native_tool_calling_plan(&mut opts, plan);
    opts
}

fn sample_catalog() -> Vec<ToolDefinition> {
    vec![
        tool("bash", object_schema()),
        tool("askUserQuestion", object_schema()),
        tool(
            "refTool",
            json!({
                "oneOf": [{ "type": "object" }],
                "properties": { "item": { "$ref": "#/$defs/item" } },
                "$defs": { "item": { "type": "string" } }
            }),
        ),
        tool("badSchema", json!("nope")),
        tool("deferredOnly", object_schema()),
    ]
}

fn tool_named<'a>(tools: &'a [Value], name: &str) -> &'a Value {
    tools
        .iter()
        .find(|tool| tool.get("name").and_then(Value::as_str) == Some(name))
        .unwrap_or_else(|| panic!("missing tool {name}"))
}

fn has_type(tools: &[Value], kind: &str) -> bool {
    tools
        .iter()
        .any(|tool| tool.get("type").and_then(Value::as_str) == Some(kind))
}

fn openai_ok_sse() -> String {
    [
        sse_data(json!({
            "type": "response.output_item.added",
            "output_index": 0,
            "item": { "id": "msg_ok", "type": "message", "content": [] }
        })),
        sse_data(json!({
            "type": "response.output_text.delta",
            "output_index": 0,
            "item_id": "msg_ok",
            "delta": "ok"
        })),
        sse_data(json!({
            "type": "response.output_item.done",
            "output_index": 0,
            "item": {
                "id": "msg_ok",
                "type": "message",
                "content": [{ "type": "output_text", "text": "ok" }]
            }
        })),
        sse_data(json!({
            "type": "response.completed",
            "response": {
                "id": "resp_ok",
                "status": "completed",
                "usage": { "input_tokens": 1, "output_tokens": 1, "total_tokens": 2 }
            }
        })),
    ]
    .concat()
}

fn anthropic_ok_sse() -> String {
    [
        sse_event(
            "message_start",
            json!({
                "type": "message_start",
                "message": {
                    "id": "msg_ok",
                    "type": "message",
                    "role": "assistant",
                    "model": "claude-sonnet-4-6",
                    "usage": { "input_tokens": 1, "output_tokens": 1 }
                }
            }),
        ),
        sse_event(
            "content_block_start",
            json!({
                "type": "content_block_start",
                "index": 0,
                "content_block": { "type": "text", "text": "ok" }
            }),
        ),
        sse_event(
            "content_block_stop",
            json!({ "type": "content_block_stop", "index": 0 }),
        ),
        sse_event(
            "message_delta",
            json!({
                "type": "message_delta",
                "delta": { "stop_reason": "end_turn" },
                "usage": { "output_tokens": 1 }
            }),
        ),
        sse_event("message_stop", json!({ "type": "message_stop" })),
    ]
    .concat()
}

fn sse_data(data: Value) -> String {
    format!("data: {data}\n\n")
}

fn sse_event(event: &str, data: Value) -> String {
    format!("event: {event}\ndata: {data}\n\n")
}

fn repeated_sse(body: &str, count: usize) -> Vec<MockReply> {
    (0..count)
        .map(|_| MockReply::sse(body.to_string()))
        .collect()
}

struct StepInput {
    model_id: &'static str,
    base_url: String,
    api_key: &'static str,
    messages: Vec<CanonicalMessage>,
    tools: Vec<ToolDefinition>,
    provider_options: Map<String, Value>,
}

async fn run_step(transport: &impl ProviderTransport, input: StepInput) -> Result<(), String> {
    transport
        .stream_step(
            ProviderStepRequest {
                model_id: input.model_id.to_string(),
                base_url: Some(input.base_url),
                api_key: Some(input.api_key.to_string()),
                extra_headers: Default::default(),
                system_prompt: "System".to_string(),
                messages: input.messages,
                tools: input.tools,
                authorized_tool_names: None,
                provider_options: input.provider_options,
                continuation: None,
                policy: fast_policy(),
                turn_id: format!("turn-{}", input.model_id),
            },
            &StepBudget::unbounded(None),
            &mut |_event| {},
        )
        .await
        .map(|_| ())
        .map_err(|err| err.message)
}

#[tokio::test]
async fn anthropic_wire_places_regex_cache_breakpoints_and_skips_ineligible_callers() {
    let (origin, state) = spawn_mock(repeated_sse(&anthropic_ok_sse(), 3)).await;
    let base_url = format!("{origin}/v1");
    let transport = AnthropicMessagesTransport::new();
    let tools = sample_catalog();

    let regex_plan = plan(
        Some(NativeToolSearchKind::AnthropicRegex),
        None,
        &["deferredOnly"],
        &["bash", "askUserQuestion", "refTool", "deferredOnly"],
    );
    run_step(
        &transport,
        StepInput {
            model_id: "claude-sonnet-4-6-regex",
            base_url: base_url.clone(),
            api_key: "sk-ant-api03-test",
            messages: vec![user_message()],
            tools: tools.clone(),
            provider_options: options_with_plan(
                &regex_plan,
                json!({
                    "cacheRetention": "short",
                    "disableParallelToolUse": true
                }),
            ),
        },
    )
    .await
    .expect("regex tool search step");

    let variant_plan = plan(
        Some(NativeToolSearchKind::AnthropicBm25),
        None,
        &["deferredOnly"],
        &[],
    );
    run_step(
        &transport,
        StepInput {
            model_id: "claude-sonnet-4-6-variant",
            base_url: base_url.clone(),
            api_key: "sk-ant-api03-test",
            messages: vec![user_message()],
            tools: tools.clone(),
            provider_options: options_with_plan(
                &variant_plan,
                json!({
                    "cacheRetention": "short",
                    "toolSearchVariant": "ReGeX",
                    "disableParallelToolUse": false
                }),
            ),
        },
    )
    .await
    .expect("regex variant step");

    let all_deferred = plan(
        Some(NativeToolSearchKind::AnthropicBm25),
        Some(NativeProgrammaticToolCallingKind::AnthropicCodeExecution20260120),
        &[
            "bash",
            "askUserQuestion",
            "refTool",
            "badSchema",
            "deferredOnly",
        ],
        &["bash", "askUserQuestion", "refTool", "deferredOnly"],
    );
    run_step(
        &transport,
        StepInput {
            model_id: "claude-sonnet-4-6-all-deferred",
            base_url: base_url.clone(),
            api_key: "sk-ant-api03-test",
            messages: vec![user_message()],
            tools,
            provider_options: options_with_plan(
                &all_deferred,
                json!({
                    "cacheRetention": "long",
                    "disableParallelToolUse": true
                }),
            ),
        },
    )
    .await
    .expect("all-deferred programmatic step");

    let posts = state.posts.lock().expect("posts");
    assert_eq!(posts.len(), 3);

    let regex_tools = posts[0]["tools"].as_array().expect("regex tools");
    assert!(has_type(regex_tools, "tool_search_tool_regex_20251119"));
    assert!(!has_type(regex_tools, "tool_search_tool_bm25_20251119"));
    assert!(!has_type(regex_tools, "code_execution_20260120"));
    assert_eq!(
        posts[0].get("tool_choice"),
        Some(&json!({
            "type": "auto",
            "disable_parallel_tool_use": true
        }))
    );
    assert!(posts[0].get("container").is_none());
    let regex_search = tool_named(regex_tools, "tool_search_tool_regex");
    assert!(regex_search.get("cache_control").is_none());
    let bash = tool_named(regex_tools, "bash");
    assert!(bash.get("defer_loading").is_none());
    assert!(bash.get("allowed_callers").is_none());
    assert!(bash.get("cache_control").is_none());
    let deferred = tool_named(regex_tools, "deferredOnly");
    assert_eq!(deferred.get("defer_loading"), Some(&json!(true)));
    assert!(deferred.get("cache_control").is_none());
    assert!(deferred.get("allowed_callers").is_none());
    let cached = tool_named(regex_tools, "badSchema");
    assert_eq!(
        cached.get("cache_control"),
        Some(&json!({ "type": "ephemeral" }))
    );
    assert_eq!(
        cached.get("input_schema"),
        Some(&json!({ "type": "object", "properties": {} }))
    );
    let ref_tool = tool_named(regex_tools, "refTool");
    assert_eq!(
        ref_tool.get("input_schema"),
        Some(&json!({
            "type": "object",
            "properties": { "item": { "$ref": "#/$defs/item" } },
            "$defs": { "item": { "type": "string" } }
        }))
    );
    assert!(ref_tool.get("allowed_callers").is_none());
    assert!(
        tool_named(regex_tools, "askUserQuestion")
            .get("allowed_callers")
            .is_none()
    );

    let variant_tools = posts[1]["tools"].as_array().expect("variant tools");
    assert!(has_type(variant_tools, "tool_search_tool_regex_20251119"));
    assert!(posts[1].get("tool_choice").is_none());

    let deferred_tools = posts[2]["tools"].as_array().expect("deferred tools");
    assert!(has_type(deferred_tools, "tool_search_tool_bm25_20251119"));
    assert!(has_type(deferred_tools, "code_execution_20260120"));
    assert!(posts[2].get("tool_choice").is_none());
    let long_cache = json!({ "type": "ephemeral", "ttl": "1h" });
    for name in [
        "bash",
        "askUserQuestion",
        "refTool",
        "badSchema",
        "deferredOnly",
    ] {
        let custom = tool_named(deferred_tools, name);
        assert_eq!(
            custom.get("defer_loading"),
            Some(&json!(true)),
            "{name} is deferred"
        );
        assert!(custom.get("cache_control").is_none(), "{name} cache");
    }
    assert!(
        tool_named(deferred_tools, "tool_search_tool_bm25")
            .get("cache_control")
            .is_none()
    );
    assert_eq!(
        tool_named(deferred_tools, "code_execution").get("cache_control"),
        Some(&long_cache)
    );
    assert_eq!(
        tool_named(deferred_tools, "bash").get("allowed_callers"),
        Some(&json!(["direct", "code_execution_20260120"]))
    );
    assert_eq!(
        tool_named(deferred_tools, "deferredOnly").get("allowed_callers"),
        Some(&json!(["direct", "code_execution_20260120"]))
    );
    assert!(
        tool_named(deferred_tools, "askUserQuestion")
            .get("allowed_callers")
            .is_none()
    );
    assert!(
        tool_named(deferred_tools, "refTool")
            .get("allowed_callers")
            .is_none()
    );
}

#[tokio::test]
async fn anthropic_container_reuse_stops_at_expiry_and_explicit_id_wins() {
    let (origin, state) = spawn_mock(repeated_sse(&anthropic_ok_sse(), 4)).await;
    let base_url = format!("{origin}/v1");
    let transport = AnthropicMessagesTransport::new();
    let tools = vec![tool("bash", object_schema())];
    let ptc = Some(NativeProgrammaticToolCallingKind::AnthropicCodeExecution20260120);
    let native = plan(
        Some(NativeToolSearchKind::AnthropicBm25),
        ptc,
        &[],
        &["bash"],
    );
    let harness = plan(Some(NativeToolSearchKind::AnthropicBm25), None, &[], &[]);

    let expired_blocks_older = vec![
        user_message(),
        assistant_with_container(
            "older",
            json!({ "id": "cntr_older", "expires_at": "2099-01-01T00:00:00Z" }),
        ),
        assistant_with_container(
            "newer",
            json!({ "id": "cntr_expired", "expires_at": "2000-01-01T00:00:00Z" }),
        ),
    ];
    run_step(
        &transport,
        StepInput {
            model_id: "claude-sonnet-4-6-expired",
            base_url: base_url.clone(),
            api_key: "sk-ant-api03-test",
            messages: expired_blocks_older,
            tools: tools.clone(),
            provider_options: options_with_plan(&native, json!({})),
        },
    )
    .await
    .expect("expired container step");

    let unparseable = vec![
        user_message(),
        assistant_with_container(
            "unparsed",
            json!({ "id": "cntr_unparsed", "expires_at": "tomorrow" }),
        ),
    ];
    run_step(
        &transport,
        StepInput {
            model_id: "claude-sonnet-4-6-unparsed",
            base_url: base_url.clone(),
            api_key: "sk-ant-api03-test",
            messages: unparseable,
            tools: tools.clone(),
            provider_options: options_with_plan(&native, json!({ "container": "   " })),
        },
    )
    .await
    .expect("unparseable expiry step");

    let explicit = vec![
        user_message(),
        assistant_with_container("history", json!("cntr_history")),
    ];
    run_step(
        &transport,
        StepInput {
            model_id: "claude-sonnet-4-6-explicit",
            base_url: base_url.clone(),
            api_key: "sk-ant-api03-test",
            messages: explicit,
            tools: tools.clone(),
            provider_options: options_with_plan(
                &native,
                json!({ "container": "  cntr_explicit  " }),
            ),
        },
    )
    .await
    .expect("explicit container step");

    let no_ptc = vec![
        user_message(),
        assistant_with_container("kept", json!({ "id": "cntr_kept" })),
    ];
    run_step(
        &transport,
        StepInput {
            model_id: "claude-sonnet-4-6-no-ptc",
            base_url,
            api_key: "sk-ant-api03-test",
            messages: no_ptc,
            tools,
            provider_options: options_with_plan(&harness, json!({})),
        },
    )
    .await
    .expect("harness container step");

    let posts = state.posts.lock().expect("posts");
    assert!(posts[0].get("container").is_none());
    assert_eq!(posts[1].get("container"), Some(&json!("cntr_unparsed")));
    assert_eq!(posts[2].get("container"), Some(&json!("cntr_explicit")));
    assert!(posts[3].get("container").is_none());
    assert!(!has_type(
        posts[3]["tools"].as_array().expect("harness tools"),
        "code_execution_20260120"
    ));
}

#[tokio::test]
async fn openai_openrouter_tool_search_is_distinct_from_a_foreign_kind() {
    let (origin, state) = spawn_mock(repeated_sse(&openai_ok_sse(), 2)).await;
    let base_url = format!("{origin}/v1");
    let transport = OpenAiResponsesTransport::new();
    let tools = vec![
        tool("bash", object_schema()),
        tool("mcp__github__search_issues", object_schema()),
    ];

    let openrouter = plan(
        Some(NativeToolSearchKind::OpenRouterResponses),
        None,
        &["mcp__github__search_issues"],
        &[],
    );
    run_step(
        &transport,
        StepInput {
            model_id: "gpt-5.4-openrouter",
            base_url: base_url.clone(),
            api_key: "sk-test",
            messages: vec![user_message()],
            tools: tools.clone(),
            provider_options: options_with_plan(&openrouter, json!({})),
        },
    )
    .await
    .expect("openrouter tool search step");

    let foreign = plan(
        Some(NativeToolSearchKind::AnthropicBm25),
        None,
        &["mcp__github__search_issues"],
        &["bash"],
    );
    run_step(
        &transport,
        StepInput {
            model_id: "gpt-5.4-foreign-kind",
            base_url,
            api_key: "sk-test",
            messages: vec![user_message()],
            tools,
            provider_options: options_with_plan(&foreign, json!({})),
        },
    )
    .await
    .expect("foreign kind step");

    let posts = state.posts.lock().expect("posts");
    let openrouter_tools = posts[0]["tools"].as_array().expect("openrouter tools");
    assert!(has_type(openrouter_tools, "openrouter:tool_search"));
    assert!(!has_type(openrouter_tools, "tool_search"));
    assert!(!has_type(openrouter_tools, "programmatic_tool_calling"));
    assert_eq!(
        tool_named(openrouter_tools, "mcp__github__search_issues").get("defer_loading"),
        Some(&json!(true))
    );
    assert!(
        tool_named(openrouter_tools, "bash")
            .get("defer_loading")
            .is_none()
    );
    assert!(
        openrouter_tools
            .iter()
            .all(|tool| tool.get("allowed_callers").is_none())
    );

    let foreign_tools = posts[1]["tools"].as_array().expect("foreign tools");
    assert!(!has_type(foreign_tools, "tool_search"));
    assert!(!has_type(foreign_tools, "openrouter:tool_search"));
    assert!(!has_type(foreign_tools, "programmatic_tool_calling"));
    assert!(foreign_tools.iter().all(|tool| {
        tool.get("defer_loading").is_none() && tool.get("allowed_callers").is_none()
    }));
}

struct RejectionCase {
    model_id: &'static str,
    provider: ProviderName,
    api_key: &'static str,
    status: StatusCode,
    message: &'static str,
    success_after: bool,
    plan: NativeToolCallingPlan,
    retry_has_tool_search: bool,
    retry_has_programmatic: bool,
    retry_defer_loading: bool,
    retry_allowed_callers: bool,
    cache_tool_search: bool,
    cache_programmatic: bool,
}

async fn assert_rejection(case: RejectionCase) {
    let mut replies = vec![MockReply::json_err(case.status, case.message)];
    let success = if case.provider == ProviderName::Anthropic {
        anthropic_ok_sse()
    } else {
        openai_ok_sse()
    };
    if case.success_after {
        replies.push(MockReply::sse(success));
    }
    let (origin, state) = spawn_mock(replies).await;
    let base_url = format!("{origin}/v1");
    let probed = check_endpoint_capabilities(
        case.provider,
        Some(&base_url),
        case.model_id,
        Some(case.api_key),
        None,
        true,
    )
    .await;
    assert_eq!(probed.source, EndpointCapabilitySource::EndpointCheck);
    assert!(probed.native_tool_search.is_some());
    assert!(probed.native_programmatic_tool_calling.is_some());

    let input = StepInput {
        model_id: case.model_id,
        base_url: base_url.clone(),
        api_key: case.api_key,
        messages: vec![user_message()],
        tools: vec![
            tool("bash", object_schema()),
            tool("mcp__github__search_issues", object_schema()),
        ],
        provider_options: options_with_plan(&case.plan, json!({})),
    };
    let outcome = if case.provider == ProviderName::Anthropic {
        run_step(&AnthropicMessagesTransport::new(), input).await
    } else {
        run_step(&OpenAiResponsesTransport::new(), input).await
    };

    let posts = state.posts.lock().expect("posts");
    let first_tools = posts[0]["tools"].as_array().expect("first tools");
    assert!(
        has_type(first_tools, "tool_search")
            || has_type(first_tools, "tool_search_tool_bm25_20251119"),
        "the rejected request must actually have offered tool search"
    );
    if case.success_after {
        assert!(outcome.is_ok(), "fallback step failed: {outcome:?}");
        assert_eq!(posts.len(), 2, "named client error retries once");
        let retry_tools = posts[1]["tools"].as_array().expect("retry tools");
        assert_eq!(
            has_type(retry_tools, "tool_search")
                || has_type(retry_tools, "tool_search_tool_bm25_20251119"),
            case.retry_has_tool_search,
            "tool search on retry"
        );
        assert_eq!(
            has_type(retry_tools, "programmatic_tool_calling")
                || has_type(retry_tools, "code_execution_20260120"),
            case.retry_has_programmatic,
            "programmatic calling on retry"
        );
        assert_eq!(
            tool_named(retry_tools, "mcp__github__search_issues")
                .get("defer_loading")
                .is_some(),
            case.retry_defer_loading
        );
        assert_eq!(
            tool_named(retry_tools, "bash")
                .get("allowed_callers")
                .is_some(),
            case.retry_allowed_callers
        );
    } else {
        assert!(outcome.is_err(), "unrelated or server error must surface");
        assert_eq!(posts.len(), 1, "no native-tool fallback request");
    }
    drop(posts);

    let resolved = resolve_endpoint_tool_capabilities(
        case.provider,
        Some(&base_url),
        case.model_id,
        ToolCallingStrategy::Auto,
    );
    assert_eq!(
        resolved.native_tool_search.is_some(),
        case.cache_tool_search,
        "cached tool search"
    );
    assert_eq!(
        resolved.native_programmatic_tool_calling.is_some(),
        case.cache_programmatic,
        "cached programmatic calling"
    );
    if case.cache_tool_search && case.cache_programmatic {
        assert_eq!(resolved.source, EndpointCapabilitySource::EndpointCheck);
    } else {
        assert_eq!(resolved.source, EndpointCapabilitySource::RuntimeFallback);
    }
}

#[tokio::test]
async fn native_rejection_downgrades_only_the_named_feature() {
    let both = plan(
        Some(NativeToolSearchKind::OpenAiResponses),
        Some(NativeProgrammaticToolCallingKind::OpenAiResponses),
        &["mcp__github__search_issues"],
        &["bash"],
    );
    assert_rejection(RejectionCase {
        model_id: "gpt-5.4-server-error",
        provider: ProviderName::Openai,
        api_key: "sk-test",
        status: StatusCode::INTERNAL_SERVER_ERROR,
        message: "defer_loading and programmatic_tool_calling are not supported",
        success_after: false,
        plan: both.clone(),
        retry_has_tool_search: false,
        retry_has_programmatic: false,
        retry_defer_loading: false,
        retry_allowed_callers: false,
        cache_tool_search: true,
        cache_programmatic: true,
    })
    .await;

    assert_rejection(RejectionCase {
        model_id: "gpt-5.4-unrelated",
        provider: ProviderName::Openai,
        api_key: "sk-test",
        status: StatusCode::BAD_REQUEST,
        message: "max_tokens must be at most 8192",
        success_after: false,
        plan: both.clone(),
        retry_has_tool_search: false,
        retry_has_programmatic: false,
        retry_defer_loading: false,
        retry_allowed_callers: false,
        cache_tool_search: true,
        cache_programmatic: true,
    })
    .await;

    assert_rejection(RejectionCase {
        model_id: "gpt-5.4-tool-search-only",
        provider: ProviderName::Openai,
        api_key: "sk-test",
        status: StatusCode::BAD_REQUEST,
        message: "defer_loading is not supported",
        success_after: true,
        plan: both.clone(),
        retry_has_tool_search: false,
        retry_has_programmatic: true,
        retry_defer_loading: false,
        retry_allowed_callers: true,
        cache_tool_search: false,
        cache_programmatic: true,
    })
    .await;

    assert_rejection(RejectionCase {
        model_id: "gpt-5.4-generic-tools",
        provider: ProviderName::Openai,
        api_key: "sk-test",
        status: StatusCode::UNPROCESSABLE_ENTITY,
        message: "tools[0].type is invalid",
        success_after: true,
        plan: both,
        retry_has_tool_search: false,
        retry_has_programmatic: false,
        retry_defer_loading: false,
        retry_allowed_callers: false,
        cache_tool_search: false,
        cache_programmatic: false,
    })
    .await;

    let anthropic_both = plan(
        Some(NativeToolSearchKind::AnthropicBm25),
        Some(NativeProgrammaticToolCallingKind::AnthropicCodeExecution20260120),
        &["mcp__github__search_issues"],
        &["bash"],
    );
    assert_rejection(RejectionCase {
        model_id: "claude-sonnet-4-6-ptc-only",
        provider: ProviderName::Anthropic,
        api_key: "sk-ant-api03-test",
        status: StatusCode::BAD_REQUEST,
        message: "allowed_callers is unsupported",
        success_after: true,
        plan: anthropic_both,
        retry_has_tool_search: true,
        retry_has_programmatic: false,
        retry_defer_loading: true,
        retry_allowed_callers: false,
        cache_tool_search: true,
        cache_programmatic: false,
    })
    .await;
}
