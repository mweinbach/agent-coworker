//! Anthropic Messages tool definitions must carry the complete (already normalized) parameter
//! schema as `input_schema`. Rebuilding it from only `properties` / `required` drops root-level
//! `$defs` / `definitions` (leaving dangling `$ref`s that make Anthropic reject the request) and
//! root-level constraints such as `additionalProperties`.

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
    CanonicalMessage, ContentBlock, MessageRole, ProviderOpaqueMeta, RequestPolicy, StepBudget,
};
use cowork_providers::{
    AnthropicMessagesTransport, ProviderStepRequest, ProviderTransport, ToolDefinition,
};
use serde_json::{Map, Value, json};

#[derive(Clone)]
struct MockState {
    reply: Arc<String>,
    requests: Arc<Mutex<Vec<Value>>>,
}

async fn handle(State(state): State<MockState>, Json(payload): Json<Value>) -> Response {
    state.requests.lock().unwrap().push(payload);
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .body(Body::from(state.reply.as_str().to_owned()))
        .unwrap()
}

async fn spawn_mock() -> (String, MockState) {
    let events = [
        json!({
            "type": "message_start",
            "message": { "id": "msg_schema", "usage": { "input_tokens": 3, "output_tokens": 0 } }
        }),
        json!({
            "type": "message_delta",
            "delta": { "stop_reason": "end_turn" },
            "usage": { "output_tokens": 1 }
        }),
        json!({ "type": "message_stop" }),
    ];
    let reply: String = events
        .iter()
        .map(|e| format!("event: {}\ndata: {e}\n\n", e["type"].as_str().unwrap()))
        .collect();
    let state = MockState {
        reply: Arc::new(reply),
        requests: Arc::new(Mutex::new(Vec::new())),
    };
    let app = Router::new()
        .route("/v1/messages", post(handle))
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("http://{addr}"), state)
}

fn user_message() -> CanonicalMessage {
    CanonicalMessage {
        id: "u1".into(),
        role: MessageRole::User,
        content: vec![ContentBlock::Text {
            text: "create the ticket".into(),
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
        created_at: "2026-11-02T00:00:00Z".into(),
    }
}

/// Sends one step with `tools` and returns the wire `tools` array.
async fn wire_tools(tools: Vec<ToolDefinition>) -> Vec<Value> {
    let (base_url, mock) = spawn_mock().await;
    let policy = RequestPolicy {
        max_attempts: 1,
        ..RequestPolicy::default()
    };
    AnthropicMessagesTransport::new()
        .stream_step(
            ProviderStepRequest {
                model_id: "claude-sonnet-4-5".into(),
                base_url: Some(base_url),
                api_key: Some("sk-ant-api03-key".into()),
                extra_headers: HashMap::new(),
                system_prompt: "System".into(),
                messages: vec![user_message()],
                tools,
                authorized_tool_names: None,
                provider_options: Map::new(),
                continuation: None,
                policy,
                turn_id: "turn-schema".into(),
            },
            &StepBudget::new(10_000, None),
            &mut |_| {},
        )
        .await
        .expect("step succeeds");
    let requests = mock.requests.lock().unwrap();
    requests[0]["tools"]
        .as_array()
        .cloned()
        .expect("request carries tools")
}

/// An MCP-style schema whose properties reference root-level `$defs` / `definitions`.
fn mcp_ticket_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "priority": { "$ref": "#/$defs/Priority" },
            "assignee": { "$ref": "#/definitions/User" },
            "labels": {
                "type": "array",
                "items": { "anyOf": [{ "type": "string" }, { "type": "integer" }] }
            },
            "due": { "anyOf": [{ "type": "string", "format": "date" }, { "type": "null" }] }
        },
        "required": ["priority"],
        "additionalProperties": false,
        "$defs": {
            "Priority": { "type": "string", "enum": ["low", "high"] }
        },
        "definitions": {
            "User": {
                "type": "object",
                "properties": { "login": { "type": "string" } },
                "required": ["login"],
                "additionalProperties": false
            }
        }
    })
}

#[tokio::test]
async fn tool_input_schema_preserves_defs_refs_and_root_constraints() {
    let schema = mcp_ticket_schema();
    let tools = wire_tools(vec![ToolDefinition {
        name: "mcp__tracker__createTicket".into(),
        description: "Create a ticket".into(),
        parameters: schema.clone(),
    }])
    .await;
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0]["name"], "mcp__tracker__createTicket");
    assert_eq!(
        tools[0]["input_schema"], schema,
        "the normalized schema must reach Anthropic intact"
    );
}

#[tokio::test]
async fn tool_input_schema_adds_object_type_and_empty_properties_when_missing() {
    let tools = wire_tools(vec![
        ToolDefinition {
            name: "noType".into(),
            description: "Schema without a root type".into(),
            parameters: json!({
                "properties": { "q": { "$ref": "#/$defs/Q" } },
                "$defs": { "Q": { "type": "string" } }
            }),
        },
        ToolDefinition {
            name: "emptySchema".into(),
            description: "Empty schema".into(),
            parameters: json!({}),
        },
        ToolDefinition {
            name: "nonObjectSchema".into(),
            description: "Null parameters".into(),
            parameters: Value::Null,
        },
    ])
    .await;
    assert_eq!(
        tools[0]["input_schema"],
        json!({
            "type": "object",
            "properties": { "q": { "$ref": "#/$defs/Q" } },
            "$defs": { "Q": { "type": "string" } }
        })
    );
    assert_eq!(
        tools[1]["input_schema"],
        json!({ "type": "object", "properties": {} })
    );
    assert_eq!(
        tools[2]["input_schema"],
        json!({ "type": "object", "properties": {} })
    );
}

#[tokio::test]
async fn tool_input_schema_drops_root_level_combinators_anthropic_rejects() {
    // Anthropic rejects `oneOf` / `allOf` / `anyOf` at the top level of `input_schema`; nested
    // combinators (and every other root keyword) still pass through untouched.
    let tools = wire_tools(vec![ToolDefinition {
        name: "rootUnion".into(),
        description: "Root-level union".into(),
        parameters: json!({
            "type": "object",
            "properties": {
                "a": { "type": "string" },
                "b": { "oneOf": [{ "type": "string" }, { "type": "number" }] }
            },
            "anyOf": [{ "required": ["a"] }, { "required": ["b"] }],
            "oneOf": [{ "required": ["a"] }],
            "allOf": [{ "required": ["b"] }],
            "additionalProperties": false
        }),
    }])
    .await;
    assert_eq!(
        tools[0]["input_schema"],
        json!({
            "type": "object",
            "properties": {
                "a": { "type": "string" },
                "b": { "oneOf": [{ "type": "string" }, { "type": "number" }] }
            },
            "additionalProperties": false
        })
    );
}
