//! Regression: native Google tools (`google_search`, `url_context`) executed by the provider must
//! surface as tool stream events (start / delta / end / result or error) so the projector yields
//! `toolCall` items, while the `ProviderNativeTool` blocks stay in the assistant message for replay
//! (`googleNative/stream/mapToStreamParts.ts` parity).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::{
    Json, Router,
    body::Body,
    extract::State,
    http::{StatusCode, header},
    response::Response,
    routing::post,
};
use cowork_inference::{
    CanonicalMessage, ClientCapabilities, ContentBlock, MessageRole, ProviderNativeToolRole,
    ProviderOpaqueMeta, RequestPolicy, StepBudget, StreamEvent, StreamEventProjector,
};
use cowork_providers::{
    GoogleInteractionsTransport, ProviderStepRequest, ProviderStepResult, ProviderTransport,
};
use serde_json::{Map, Value, json};

#[derive(Clone, Default)]
struct Mock {
    replies: Arc<Mutex<Vec<String>>>,
    requests: Arc<Mutex<Vec<Value>>>,
}

async fn handle(State(mock): State<Mock>, Json(payload): Json<Value>) -> Response {
    mock.requests.lock().unwrap().push(payload);
    let body = mock.replies.lock().unwrap().remove(0);
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .body(Body::from(body))
        .unwrap()
}

async fn spawn_mock(replies: Vec<String>) -> (String, Mock) {
    let mock = Mock {
        replies: Arc::new(Mutex::new(replies)),
        requests: Arc::default(),
    };
    let app = Router::new()
        .route("/v1beta/interactions", post(handle))
        .with_state(mock.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("http://{addr}"), mock)
}

fn sse(events: &[Value]) -> String {
    events.iter().map(|e| format!("data: {e}\n\n")).collect()
}

fn text_message(id: &str, role: MessageRole, text: &str) -> CanonicalMessage {
    CanonicalMessage {
        id: id.into(),
        role,
        content: vec![ContentBlock::Text {
            text: text.into(),
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
        created_at: "2026-11-01T00:00:00Z".into(),
    }
}

async fn run_step(
    base_url: &str,
    messages: Vec<CanonicalMessage>,
    events: &mut Vec<StreamEvent>,
) -> ProviderStepResult {
    let mut provider_options = Map::new();
    provider_options.insert(
        "google".into(),
        json!({ "nativeWebSearch": true, "nativeUrlContext": true }),
    );
    GoogleInteractionsTransport::new()
        .stream_step(
            ProviderStepRequest {
                model_id: "gemini-3-flash-preview".into(),
                base_url: Some(base_url.to_string()),
                api_key: Some("goog-key".into()),
                extra_headers: HashMap::new(),
                system_prompt: "System".into(),
                messages,
                tools: Vec::new(),
                authorized_tool_names: None,
                provider_options,
                continuation: None,
                policy: RequestPolicy {
                    max_attempts: 1,
                    ..RequestPolicy::default()
                },
                turn_id: "turn-native".into(),
            },
            &StepBudget::new(10_000, None),
            &mut |ev| events.push(ev),
        )
        .await
        .expect("native tool stream completes")
}

fn native_tool_stream() -> String {
    sse(&[
        json!({ "event_type": "interaction.start", "interaction": { "id": "inter_native" } }),
        // google_search: call fully described on start, result on a later block.
        json!({
            "event_type": "content.start",
            "index": 0,
            "content": {
                "type": "google_search_call",
                "id": "gs_1",
                "arguments": { "queries": ["rust 2024 edition"] },
                "signature": "sig_gs"
            }
        }),
        json!({ "event_type": "content.stop", "index": 0 }),
        json!({
            "event_type": "content.start",
            "index": 1,
            "content": {
                "type": "google_search_result",
                "call_id": "gs_1",
                "result": [{ "title": "Rust 2024", "url": "https://blog.rust-lang.org/" }]
            }
        }),
        json!({ "event_type": "content.stop", "index": 1 }),
        // url_context: start has no id; the wire id and arguments arrive in a delta. The result
        // references the wire id and must resolve to the first emitted id.
        json!({
            "event_type": "content.start",
            "index": 2,
            "content": { "type": "url_context_call" }
        }),
        json!({
            "event_type": "content.delta",
            "index": 2,
            "delta": {
                "type": "url_context_call",
                "id": "uc_real",
                "arguments": { "urls": ["https://example.com/a"] }
            }
        }),
        json!({ "event_type": "content.stop", "index": 2 }),
        json!({
            "event_type": "content.start",
            "index": 3,
            "content": {
                "type": "url_context_result",
                "call_id": "uc_real",
                "result": { "url": "https://example.com/a", "status": "failed" },
                "is_error": true
            }
        }),
        json!({ "event_type": "content.stop", "index": 3 }),
        json!({
            "event_type": "content.start",
            "index": 4,
            "content": { "type": "text", "text": "Done." }
        }),
        json!({ "event_type": "content.stop", "index": 4 }),
        json!({
            "event_type": "interaction.complete",
            "interaction": { "id": "inter_native", "status": "completed" }
        }),
    ])
}

fn tool_events(events: &[StreamEvent]) -> Vec<StreamEvent> {
    events
        .iter()
        .filter(|ev| {
            matches!(
                ev,
                StreamEvent::ToolCallStart { .. }
                    | StreamEvent::ToolCallDelta { .. }
                    | StreamEvent::ToolCallEnd { .. }
                    | StreamEvent::ToolResult { .. }
            )
        })
        .cloned()
        .collect()
}

fn obj(value: Value) -> Map<String, Value> {
    value.as_object().cloned().expect("object")
}

#[tokio::test]
async fn google_native_search_and_url_context_emit_tool_events_and_keep_replay_blocks() {
    let follow_up = sse(&[
        json!({ "event_type": "interaction.start", "interaction": { "id": "inter_next" } }),
        json!({ "event_type": "content.start", "index": 0, "content": { "type": "text", "text": "ok" } }),
        json!({ "event_type": "content.stop", "index": 0 }),
        json!({
            "event_type": "interaction.complete",
            "interaction": { "id": "inter_next", "status": "completed" }
        }),
    ]);
    let (base_url, mock) = spawn_mock(vec![native_tool_stream(), follow_up]).await;
    let user = text_message("u1", MessageRole::User, "What changed in Rust 2024?");

    let mut events = Vec::new();
    let result = run_step(&base_url, vec![user.clone()], &mut events).await;

    let turn_id = "turn-native".to_string();
    let search_result_raw = json!([{ "title": "Rust 2024", "url": "https://blog.rust-lang.org/" }]);
    let url_result_raw = json!({ "url": "https://example.com/a", "status": "failed" });
    let expected = vec![
        StreamEvent::ToolCallStart {
            turn_id: turn_id.clone(),
            key: "gs_1".into(),
            name: "nativeWebSearch".into(),
            initial_args: Some(obj(json!({ "queries": ["rust 2024 edition"] }))),
        },
        StreamEvent::ToolCallEnd {
            turn_id: turn_id.clone(),
            key: "gs_1".into(),
            name: "nativeWebSearch".into(),
            arguments: Some(obj(json!({ "queries": ["rust 2024 edition"] }))),
            retry_of: None,
            input_digest: None,
        },
        StreamEvent::ToolResult {
            turn_id: turn_id.clone(),
            key: "gs_1".into(),
            name: "nativeWebSearch".into(),
            result: json!({
                "provider": "google",
                "status": "completed",
                "callId": "gs_1",
                "queries": ["rust 2024 edition"],
                "results": search_result_raw.clone(),
                "raw": search_result_raw,
            }),
            is_error: false,
            denied: false,
        },
        StreamEvent::ToolCallStart {
            turn_id: turn_id.clone(),
            key: "native_2".into(),
            name: "nativeUrlContext".into(),
            initial_args: None,
        },
        StreamEvent::ToolCallDelta {
            turn_id: turn_id.clone(),
            key: "native_2".into(),
            name: "nativeUrlContext".into(),
            delta: r#"{"urls":["https://example.com/a"]}"#.into(),
        },
        StreamEvent::ToolCallEnd {
            turn_id: turn_id.clone(),
            key: "native_2".into(),
            name: "nativeUrlContext".into(),
            arguments: Some(obj(json!({ "urls": ["https://example.com/a"] }))),
            retry_of: None,
            input_digest: None,
        },
        StreamEvent::ToolResult {
            turn_id: turn_id.clone(),
            key: "native_2".into(),
            name: "nativeUrlContext".into(),
            result: json!({
                "provider": "google",
                "status": "completed",
                "callId": "native_2",
                "urls": ["https://example.com/a"],
                "results": [url_result_raw.clone()],
                "raw": url_result_raw,
            }),
            is_error: true,
            denied: false,
        },
    ];
    assert_eq!(tool_events(&events), expected);

    // Provider-executed blocks are retained for replay, with the result bound to the emitted id.
    let natives: Vec<(String, String, ProviderNativeToolRole, bool)> = result
        .assistant
        .content
        .iter()
        .filter_map(|b| match b {
            ContentBlock::ProviderNativeTool {
                id,
                name,
                role,
                is_error,
                ..
            } => Some((id.clone(), name.clone(), *role, *is_error)),
            _ => None,
        })
        .collect();
    assert_eq!(
        natives,
        vec![
            (
                "gs_1".into(),
                "nativeWebSearch".into(),
                ProviderNativeToolRole::Call,
                false
            ),
            (
                "gs_1".into(),
                "nativeWebSearch".into(),
                ProviderNativeToolRole::Result,
                false
            ),
            (
                "native_2".into(),
                "nativeUrlContext".into(),
                ProviderNativeToolRole::Call,
                false
            ),
            (
                "native_2".into(),
                "nativeUrlContext".into(),
                ProviderNativeToolRole::Result,
                true
            ),
        ]
    );
    // Provider-executed calls are never surfaced as harness-executable tool calls.
    assert!(
        !result
            .assistant
            .content
            .iter()
            .any(|b| matches!(b, ContentBlock::ToolCall { .. }))
    );

    // Projection: the events become `toolCall` items in live clients / the journal.
    let mut projector = StreamEventProjector::new("thread-native", ClientCapabilities::default());
    let completed: Vec<Value> = events
        .iter()
        .flat_map(|ev| projector.project(ev))
        .filter(|n| n.method == "item/completed")
        .map(|n| n.params["item"].clone())
        .filter(|item| item["type"] == "toolCall")
        .collect();
    let terminal: Vec<(String, String)> = completed
        .iter()
        .filter(|item| {
            item["state"]
                .as_str()
                .is_some_and(|s| s.starts_with("output-"))
        })
        .map(|item| {
            (
                item["toolName"].as_str().unwrap().to_string(),
                item["state"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    assert_eq!(
        terminal,
        vec![
            ("nativeWebSearch".into(), "output-available".into()),
            ("nativeUrlContext".into(), "output-error".into()),
        ]
    );
    let search_item = completed
        .iter()
        .rfind(|item| item["toolName"] == "nativeWebSearch")
        .unwrap();
    assert_eq!(
        search_item["args"],
        json!({ "queries": ["rust 2024 edition"] })
    );
    assert_eq!(search_item["result"]["callId"], "gs_1");

    // Replay: the next request still round-trips the native call/result pairs.
    let persisted = result.persisted_assistant.expect("persisted assistant");
    let mut next_events = Vec::new();
    run_step(
        &base_url,
        vec![
            user,
            persisted,
            text_message("u2", MessageRole::User, "Thanks"),
        ],
        &mut next_events,
    )
    .await;
    let requests = mock.requests.lock().unwrap();
    let input = requests[1]["input"].to_string();
    for needle in [
        r#""type":"google_search_call""#,
        r#""type":"google_search_result""#,
        r#""type":"url_context_call""#,
        r#""type":"url_context_result""#,
        r#""call_id":"native_2""#,
        r#""id":"native_2""#,
        r#""call_id":"gs_1""#,
    ] {
        assert!(
            input.contains(needle),
            "replay input missing {needle}: {input}"
        );
    }
}

#[tokio::test]
async fn google_native_tool_arguments_delta_streams_tool_input_deltas() {
    let stream = sse(&[
        json!({ "event_type": "interaction.start", "interaction": { "id": "inter_args" } }),
        json!({
            "event_type": "step.start",
            "index": 0,
            "step": { "type": "google_search_call", "id": "gs_args" }
        }),
        json!({
            "event_type": "step.delta",
            "index": 0,
            "delta": { "type": "arguments_delta", "arguments": "{\"queries\":[\"a\"" }
        }),
        json!({
            "event_type": "step.delta",
            "index": 0,
            "delta": { "type": "arguments_delta", "arguments": ",\"b\"]}" }
        }),
        json!({ "event_type": "step.stop", "index": 0 }),
        json!({
            "event_type": "interaction.complete",
            "interaction": { "id": "inter_args", "status": "completed" }
        }),
    ]);
    let (base_url, _mock) = spawn_mock(vec![stream]).await;
    let mut events = Vec::new();
    run_step(
        &base_url,
        vec![text_message("u1", MessageRole::User, "search")],
        &mut events,
    )
    .await;

    let turn_id = "turn-native".to_string();
    assert_eq!(
        tool_events(&events),
        vec![
            StreamEvent::ToolCallStart {
                turn_id: turn_id.clone(),
                key: "gs_args".into(),
                name: "nativeWebSearch".into(),
                initial_args: None,
            },
            StreamEvent::ToolCallDelta {
                turn_id: turn_id.clone(),
                key: "gs_args".into(),
                name: "nativeWebSearch".into(),
                delta: "{\"queries\":[\"a\"".into(),
            },
            StreamEvent::ToolCallDelta {
                turn_id: turn_id.clone(),
                key: "gs_args".into(),
                name: "nativeWebSearch".into(),
                delta: ",\"b\"]}".into(),
            },
            StreamEvent::ToolCallEnd {
                turn_id,
                key: "gs_args".into(),
                name: "nativeWebSearch".into(),
                arguments: Some(obj(json!({ "queries": ["a", "b"] }))),
                retry_of: None,
                input_digest: None,
            },
        ]
    );
}

/// `function_call` payloads on `content.delta` / `step.delta` update the call's name, Gemini
/// thought signature and arguments and stream the arguments as tool input
/// (`processEvent.ts` / `mapToStreamParts.ts` `function_call` delta branches).
#[tokio::test]
async fn google_function_call_delta_updates_name_signature_and_arguments() {
    let stream = sse(&[
        json!({ "event_type": "interaction.start", "interaction": { "id": "inter_fc" } }),
        json!({
            "event_type": "content.start",
            "index": 0,
            "content": { "type": "function_call", "id": "fc_1" }
        }),
        json!({
            "event_type": "content.delta",
            "index": 0,
            "delta": {
                "type": "function_call",
                "name": "bash",
                "signature": "sig_fc",
                "arguments": { "command": "ls" }
            }
        }),
        json!({
            "event_type": "content.delta",
            "index": 0,
            "delta": { "type": "function_call", "arguments": { "cwd": "/tmp" } }
        }),
        json!({ "event_type": "content.stop", "index": 0 }),
        // A `function_call` that first appears as a delta (no start) still becomes a call.
        json!({
            "event_type": "step.delta",
            "index": 1,
            "delta": {
                "type": "function_call",
                "id": "fc_2",
                "name": "read",
                "signature": "sig_fc2",
                "arguments": { "path": "a.txt" }
            }
        }),
        json!({ "event_type": "step.stop", "index": 1 }),
        json!({
            "event_type": "interaction.complete",
            "interaction": { "id": "inter_fc", "status": "requires_action" }
        }),
    ]);
    let (base_url, _mock) = spawn_mock(vec![stream]).await;
    let mut events = Vec::new();
    let result = run_step(
        &base_url,
        vec![text_message("u1", MessageRole::User, "list files")],
        &mut events,
    )
    .await;

    let turn_id = "turn-native".to_string();
    assert_eq!(
        tool_events(&events),
        vec![
            StreamEvent::ToolCallStart {
                turn_id: turn_id.clone(),
                key: "fc_1".into(),
                name: "tool".into(),
                initial_args: None,
            },
            StreamEvent::ToolCallDelta {
                turn_id: turn_id.clone(),
                key: "fc_1".into(),
                name: "bash".into(),
                delta: "{\"command\":\"ls\"}".into(),
            },
            StreamEvent::ToolCallDelta {
                turn_id: turn_id.clone(),
                key: "fc_1".into(),
                name: "bash".into(),
                delta: "{\"cwd\":\"/tmp\"}".into(),
            },
            StreamEvent::ToolCallEnd {
                turn_id: turn_id.clone(),
                key: "fc_1".into(),
                name: "bash".into(),
                arguments: Some(obj(json!({ "command": "ls", "cwd": "/tmp" }))),
                retry_of: None,
                input_digest: None,
            },
            StreamEvent::ToolCallStart {
                turn_id: turn_id.clone(),
                key: "fc_2".into(),
                name: "read".into(),
                initial_args: Some(obj(json!({ "path": "a.txt" }))),
            },
            StreamEvent::ToolCallEnd {
                turn_id,
                key: "fc_2".into(),
                name: "read".into(),
                arguments: Some(obj(json!({ "path": "a.txt" }))),
                retry_of: None,
                input_digest: None,
            },
        ]
    );

    let calls: Vec<_> = result
        .assistant
        .content
        .iter()
        .filter_map(|b| match b {
            ContentBlock::ToolCall {
                id,
                name,
                arguments,
                provider_meta,
                ..
            } => Some((
                id.clone(),
                name.clone(),
                Value::Object(arguments.clone()),
                provider_meta.google_thought_signature.clone(),
            )),
            _ => None,
        })
        .collect();
    assert_eq!(
        calls,
        vec![
            (
                "fc_1".to_string(),
                "bash".to_string(),
                json!({ "command": "ls", "cwd": "/tmp" }),
                Some("sig_fc".to_string()),
            ),
            (
                "fc_2".to_string(),
                "read".to_string(),
                json!({ "path": "a.txt" }),
                Some("sig_fc2".to_string()),
            ),
        ]
    );
}

/// `mcp_server_tool_call` carries the MCP tool `name` and `server_name` at the top level;
/// `processEvent.ts` folds both into the call's arguments on start and delta.
#[tokio::test]
async fn google_mcp_server_tool_call_keeps_name_and_server_name() {
    let stream = sse(&[
        json!({ "event_type": "interaction.start", "interaction": { "id": "inter_mcp" } }),
        json!({
            "event_type": "content.start",
            "index": 0,
            "content": {
                "type": "mcp_server_tool_call",
                "id": "mcp_1",
                "name": "search_docs",
                "server_name": "docs",
                "arguments": { "q": "rust" }
            }
        }),
        json!({ "event_type": "content.stop", "index": 0 }),
        json!({
            "event_type": "content.start",
            "index": 1,
            "content": { "type": "mcp_server_tool_call" }
        }),
        json!({
            "event_type": "content.delta",
            "index": 1,
            "delta": {
                "type": "mcp_server_tool_call",
                "id": "mcp_2",
                "name": "fetch_page",
                "server_name": "web",
                "arguments": { "url": "https://example.com" }
            }
        }),
        json!({ "event_type": "content.stop", "index": 1 }),
        json!({
            "event_type": "content.start",
            "index": 2,
            "content": { "type": "text", "text": "Done." }
        }),
        json!({ "event_type": "content.stop", "index": 2 }),
        json!({
            "event_type": "interaction.complete",
            "interaction": { "id": "inter_mcp", "status": "completed" }
        }),
    ]);
    let (base_url, _mock) = spawn_mock(vec![stream]).await;
    let mut events = Vec::new();
    let result = run_step(
        &base_url,
        vec![text_message("u1", MessageRole::User, "search docs")],
        &mut events,
    )
    .await;

    let ends: Vec<_> = events
        .iter()
        .filter_map(|ev| match ev {
            StreamEvent::ToolCallEnd { key, arguments, .. } => {
                Some((key.clone(), arguments.clone().map(Value::Object)))
            }
            _ => None,
        })
        .collect();
    assert_eq!(
        ends,
        vec![
            (
                "mcp_1".to_string(),
                Some(json!({ "q": "rust", "name": "search_docs", "server_name": "docs" })),
            ),
            // The call keeps its first emitted id; the delta's wire id becomes an alias.
            (
                "native_1".to_string(),
                Some(json!({
                    "url": "https://example.com",
                    "name": "fetch_page",
                    "server_name": "web"
                })),
            ),
        ]
    );
    let native_args: Vec<_> = result
        .assistant
        .content
        .iter()
        .filter_map(|b| match b {
            ContentBlock::ProviderNativeTool {
                role: ProviderNativeToolRole::Call,
                arguments,
                ..
            } => Some(Value::Object(arguments.clone())),
            _ => None,
        })
        .collect();
    assert_eq!(native_args[0]["server_name"], "docs");
    assert_eq!(native_args[0]["name"], "search_docs");
    assert_eq!(native_args[1]["server_name"], "web");
    assert_eq!(native_args[1]["name"], "fetch_page");
}
