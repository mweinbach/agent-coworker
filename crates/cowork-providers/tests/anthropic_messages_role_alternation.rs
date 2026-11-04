//! Anthropic `/v1/messages` requires `user` / `assistant` turns to alternate. Histories that would
//! otherwise produce adjacent same-role turns (synthesized orphan `tool_result`s before the next
//! user message, a `turn/steer` user message right after tool results, a failed earlier turn
//! leaving `[User, User]`, or a media-only user message dropped between two assistant turns) must
//! be coalesced into a single turn, with `tool_result` blocks kept ahead of other blocks.

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
use cowork_inference::{CanonicalMessage, RequestPolicy, StepBudget};
use cowork_providers::{AnthropicMessagesTransport, ProviderStepRequest, ProviderTransport};
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

fn sse(events: &[Value]) -> String {
    events
        .iter()
        .map(|e| format!("event: {}\ndata: {e}\n\n", e["type"].as_str().unwrap()))
        .collect()
}

async fn spawn_mock() -> (String, MockState) {
    let reply = sse(&[
        json!({"type": "message_start", "message": {"id": "msg_1", "usage": {"input_tokens": 1, "output_tokens": 0}}}),
        json!({"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 1}}),
        json!({"type": "message_stop"}),
    ]);
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

fn msg(id: &str, role: &str, content: Value) -> CanonicalMessage {
    serde_json::from_value(json!({
        "id": id,
        "role": role,
        "content": content,
        "createdAt": "2026-11-01T00:00:00Z",
    }))
    .expect("valid canonical message")
}

fn text(t: &str) -> Value {
    json!({"type": "text", "text": t})
}

fn tool_call(id: &str) -> Value {
    json!({"type": "toolCall", "id": id, "name": "bash", "arguments": {"command": "ls"}})
}

fn tool_result(id: &str) -> Value {
    json!({"type": "toolResult", "tool_call_id": id, "content": [{"type": "text", "text": "ok"}]})
}

async fn wire_messages(messages: Vec<CanonicalMessage>) -> Vec<Value> {
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
                messages,
                tools: Vec::new(),
                authorized_tool_names: None,
                provider_options: Map::new(),
                continuation: None,
                policy,
                turn_id: "turn-alternation".into(),
            },
            &StepBudget::new(10_000, None),
            &mut |_| {},
        )
        .await
        .expect("step succeeds");
    let requests = mock.requests.lock().unwrap();
    requests[0]["messages"].as_array().unwrap().clone()
}

fn roles(messages: &[Value]) -> Vec<&str> {
    messages
        .iter()
        .map(|m| m["role"].as_str().unwrap())
        .collect()
}

fn block_types(message: &Value) -> Vec<&str> {
    message["content"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b["type"].as_str().unwrap())
        .collect()
}

fn assert_alternates(messages: &[Value]) {
    for pair in messages.windows(2) {
        assert_ne!(
            pair[0]["role"], pair[1]["role"],
            "adjacent same-role turns: {messages:#?}"
        );
    }
}

#[tokio::test]
async fn orphaned_tool_call_results_merge_with_the_next_user_message() {
    let wire = wire_messages(vec![
        msg("u1", "user", json!([text("run ls")])),
        msg("a1", "assistant", json!([tool_call("call_1")])),
        msg("u2", "user", json!([text("never mind")])),
    ])
    .await;
    assert_alternates(&wire);
    assert_eq!(roles(&wire), ["user", "assistant", "user"]);
    assert_eq!(block_types(&wire[2]), ["tool_result", "text"]);
    assert_eq!(wire[2]["content"][0]["tool_use_id"], "call_1");
    assert_eq!(wire[2]["content"][0]["is_error"], true);
}

#[tokio::test]
async fn steer_after_tool_results_merges_into_one_user_turn() {
    let wire = wire_messages(vec![
        msg("u1", "user", json!([text("run ls")])),
        msg("a1", "assistant", json!([tool_call("call_1")])),
        msg("t1", "tool", json!([tool_result("call_1")])),
        msg("u2", "user", json!([text("also check git status")])),
    ])
    .await;
    assert_alternates(&wire);
    assert_eq!(roles(&wire), ["user", "assistant", "user"]);
    assert_eq!(block_types(&wire[2]), ["tool_result", "text"]);
    assert_eq!(wire[2]["content"][0]["is_error"], false);
}

#[tokio::test]
async fn consecutive_user_and_assistant_turns_are_coalesced() {
    let wire = wire_messages(vec![
        msg("u1", "user", json!([text("first attempt")])),
        msg("u2", "user", json!([text("second attempt")])),
        msg("a1", "assistant", json!([text("answer one")])),
        // A user message with only unsupported media is dropped, leaving two assistant turns.
        msg(
            "u3",
            "user",
            json!([{"type": "media", "kind": "audio", "source": {"type": "base64", "mime_type": "audio/wav", "data": "AAAA"}}]),
        ),
        msg("a2", "assistant", json!([text("answer two")])),
        msg("u4", "user", json!([text("thanks")])),
    ])
    .await;
    assert_alternates(&wire);
    assert_eq!(roles(&wire), ["user", "assistant", "user"]);
    assert_eq!(wire[0]["content"][0]["text"], "first attempt");
    assert_eq!(wire[0]["content"][1]["text"], "second attempt");
    assert_eq!(wire[1]["content"][0]["text"], "answer one");
    assert_eq!(wire[1]["content"][1]["text"], "answer two");
}
