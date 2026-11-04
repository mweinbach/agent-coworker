//! Rejected OpenAI continuations fall back to the local transcript (`runUserMessageTurn.ts` /
//! `continuationPolicy.ts` parity): when OpenAI rejects a stored `previous_response_id`, the
//! step is retried once without it from the full history, only before any visible output, and
//! the rejected handle is never sent again.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::{
    Json, Router,
    body::Body,
    extract::State,
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::post,
};
use cowork_inference::{
    CanonicalMessage, ContentBlock, MessageRole, ProviderContinuationState, ProviderOpaqueMeta,
    ProviderTransportError, RequestPolicy, StepBudget, StreamEvent,
};
use cowork_providers::{
    OpenAiResponsesTransport, ProviderStepRequest, ProviderStepResult, ProviderTransport,
};
use serde_json::{Map, Value, json};

type Responder = dyn Fn(&Value, usize) -> Response + Send + Sync;

#[derive(Clone)]
struct MockState {
    requests: Arc<Mutex<Vec<Value>>>,
    responder: Arc<Responder>,
}

async fn handle_responses(State(state): State<MockState>, Json(payload): Json<Value>) -> Response {
    let index = {
        let mut requests = state.requests.lock().unwrap();
        requests.push(payload.clone());
        requests.len() - 1
    };
    (state.responder)(&payload, index)
}

async fn spawn_mock(
    responder: impl Fn(&Value, usize) -> Response + Send + Sync + 'static,
) -> (String, MockState) {
    let state = MockState {
        requests: Arc::new(Mutex::new(Vec::new())),
        responder: Arc::new(responder),
    };
    let app = Router::new()
        .route("/v1/responses", post(handle_responses))
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("http://{addr}/v1"), state)
}

fn sse(frames: &[Value]) -> String {
    frames
        .iter()
        .map(|frame| format!("data: {frame}\n\n"))
        .collect()
}

fn sse_response(body: String) -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .body(Body::from(body))
        .unwrap()
        .into_response()
}

fn json_error(status: StatusCode, error: Value) -> Response {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(json!({ "error": error }).to_string()))
        .unwrap()
        .into_response()
}

/// OpenAI's real rejection for an unknown / expired stored response.
fn previous_response_not_found(id: &str) -> Response {
    json_error(
        StatusCode::BAD_REQUEST,
        json!({
            "message": format!("Previous response with id '{id}' not found."),
            "type": "invalid_request_error",
            "param": "previous_response_id",
            "code": "previous_response_not_found"
        }),
    )
}

fn text_reply(response_id: &str, text: &str) -> Response {
    let msg_id = format!("msg_{response_id}");
    sse_response(sse(&[
        json!({"type": "response.created", "response": {"id": response_id, "status": "in_progress"}}),
        json!({
            "type": "response.output_item.added",
            "item": {"id": msg_id, "type": "message", "content": []}
        }),
        json!({"type": "response.content_part.added", "part": {"type": "output_text", "text": ""}}),
        json!({"type": "response.output_text.delta", "delta": text}),
        json!({
            "type": "response.output_item.done",
            "item": {
                "id": msg_id,
                "type": "message",
                "content": [{"type": "output_text", "text": text}]
            }
        }),
        json!({"type": "response.completed", "response": {"id": response_id, "status": "completed"}}),
    ]))
}

fn previous_response_id(body: &Value) -> Option<&str> {
    body.get("previous_response_id").and_then(Value::as_str)
}

fn user(id: &str, text: &str) -> CanonicalMessage {
    CanonicalMessage {
        id: id.to_string(),
        role: MessageRole::User,
        content: vec![ContentBlock::Text {
            text: text.to_string(),
            phase: None,
            citations: vec![],
            provider_meta: ProviderOpaqueMeta::default(),
        }],
        phase: None,
        provider: None,
        api: None,
        model: None,
        stop_reason: None,
        provider_meta: ProviderOpaqueMeta::default(),
        created_at: "2026-11-01T00:00:00Z".to_string(),
    }
}

fn request(
    base_url: &str,
    messages: Vec<CanonicalMessage>,
    continuation: Option<ProviderContinuationState>,
) -> ProviderStepRequest {
    ProviderStepRequest {
        model_id: "gpt-5.5".to_string(),
        base_url: Some(base_url.to_string()),
        api_key: Some("sk-test".to_string()),
        extra_headers: HashMap::new(),
        system_prompt: "You are Cowork.".to_string(),
        messages,
        tools: vec![],
        authorized_tool_names: None,
        // Reasoning on: no `# Juice` developer item, so `input` is exactly the history.
        provider_options: Map::from_iter([("reasoningEffort".to_string(), json!("high"))]),
        continuation,
        policy: RequestPolicy {
            max_attempts: 1,
            base_delay_ms: 1,
            ..RequestPolicy::default()
        },
        turn_id: "turn_1".to_string(),
    }
}

async fn step(
    transport: &OpenAiResponsesTransport,
    req: ProviderStepRequest,
) -> (
    Result<ProviderStepResult, ProviderTransportError>,
    Vec<StreamEvent>,
) {
    let mut events = Vec::new();
    let result = transport
        .stream_step(req, &StepBudget::new(10_000, None), &mut |ev| {
            events.push(ev)
        })
        .await;
    (result, events)
}

fn response_id_of(continuation: &Option<ProviderContinuationState>) -> &str {
    match continuation {
        Some(ProviderContinuationState::OpenAi { response_id, .. }) => response_id,
        other => panic!("expected an OpenAI continuation, got {other:?}"),
    }
}

/// Turn 1 succeeds against the mock and yields the continuation `resp_stale` plus the history a
/// following turn would send (`[u1, assistant, u2]`), so turn 2's continuation fingerprint is
/// valid and the transport really sends `previous_response_id: resp_stale`.
async fn seed_stale_continuation(
    base_url: &str,
) -> (Vec<CanonicalMessage>, Option<ProviderContinuationState>) {
    let transport = OpenAiResponsesTransport::new();
    let messages = vec![user("u1", "hello")];
    let (result, _) = step(&transport, request(base_url, messages.clone(), None)).await;
    let result = result.expect("seed turn succeeds");
    assert_eq!(response_id_of(&result.continuation), "resp_stale");
    let mut history = messages;
    history.push(result.persisted_assistant.expect("persisted assistant"));
    history.push(user("u2", "and now?"));
    (history, result.continuation)
}

/// Seeds `resp_stale` on request 0, then rejects every request carrying it.
fn rejecting_responder(
    fallback: impl Fn(&Value, usize) -> Response + Send + Sync + 'static,
) -> impl Fn(&Value, usize) -> Response + Send + Sync + 'static {
    move |body, index| {
        if index == 0 {
            return text_reply("resp_stale", "Hi there.");
        }
        if previous_response_id(body) == Some("resp_stale") {
            return previous_response_not_found("resp_stale");
        }
        fallback(body, index)
    }
}

#[tokio::test]
async fn rejected_previous_response_id_retries_once_from_full_history() {
    let (base_url, mock) = spawn_mock(rejecting_responder(|_, index| {
        text_reply(&format!("resp_fresh_{index}"), &format!("reply {index}"))
    }))
    .await;
    let (history, stale) = seed_stale_continuation(&base_url).await;

    let transport = OpenAiResponsesTransport::new();
    let (result, events) = step(&transport, request(&base_url, history.clone(), stale)).await;
    let result = result.expect("rejected continuation falls back to the local transcript");

    let requests = mock.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 3, "seed + rejected + one fallback");
    // The rejected request only carried the delta after the stored prefix.
    assert_eq!(previous_response_id(&requests[1]), Some("resp_stale"));
    assert_eq!(requests[1]["input"].as_array().unwrap().len(), 1);
    // The fallback carries no handle and the whole local history.
    assert!(requests[2].get("previous_response_id").is_none());
    assert_eq!(
        requests[2]["input"],
        json!([
            {"role": "user", "content": [{"type": "input_text", "text": "hello"}]},
            {
                "type": "message",
                "role": "assistant",
                "status": "completed",
                "id": "msg_resp_stale",
                "content": [{"type": "output_text", "text": "Hi there.", "annotations": []}]
            },
            {"role": "user", "content": [{"type": "input_text", "text": "and now?"}]}
        ])
    );
    // The fresh response replaces the stale handle.
    assert_eq!(response_id_of(&result.continuation), "resp_fresh_2");
    let text: String = events
        .iter()
        .filter_map(|ev| match ev {
            StreamEvent::TextDelta { delta, .. } => Some(delta.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(text, "reply 2", "only the fallback's output is streamed");

    // Next turn: continues from the fresh handle, never the rejected one.
    let mut next_history = history;
    next_history.push(result.persisted_assistant.clone().unwrap());
    next_history.push(user("u3", "thanks"));
    let (next, _) = step(
        &OpenAiResponsesTransport::new(),
        request(&base_url, next_history, result.continuation.clone()),
    )
    .await;
    next.expect("next turn succeeds");
    let requests = mock.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 4);
    assert_eq!(previous_response_id(&requests[3]), Some("resp_fresh_2"));
    assert_eq!(requests[3]["input"].as_array().unwrap().len(), 1);
    assert!(
        requests
            .iter()
            .skip(2)
            .all(|r| previous_response_id(r) != Some("resp_stale"))
    );
}

#[tokio::test]
async fn http_continuation_error_code_triggers_full_history_replay() {
    let (base_url, mock) = spawn_mock(|body, index| {
        if index == 0 {
            return text_reply("resp_stale", "Hi there.");
        }
        if previous_response_id(body).is_some() {
            return json_error(
                StatusCode::BAD_REQUEST,
                json!({"code": "previous_response_not_found", "message": "The requested item does not exist."}),
            );
        }
        text_reply("resp_fresh", "ok")
    }).await;
    let (history, stale) = seed_stale_continuation(&base_url).await;
    let (result, _) = step(
        &OpenAiResponsesTransport::new(),
        request(&base_url, history, stale),
    )
    .await;

    assert_eq!(response_id_of(&result.unwrap().continuation), "resp_fresh");
    let requests = mock.requests.lock().unwrap();
    assert_eq!(requests.len(), 3);
    assert_eq!(requests[2]["input"].as_array().unwrap().len(), 3);
}

#[tokio::test]
async fn failed_fallback_never_resends_the_rejected_handle_from_the_same_transport() {
    let (base_url, mock) = spawn_mock(rejecting_responder(|_, index| {
        if index == 2 {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({"message": "The server had an error.", "type": "server_error"}),
            )
        } else {
            text_reply(&format!("resp_fresh_{index}"), "ok")
        }
    }))
    .await;
    let (history, stale) = seed_stale_continuation(&base_url).await;

    // Harness step retries reuse the same request (and the server's per-turn transport).
    let transport = OpenAiResponsesTransport::new();
    let (first, _) = step(
        &transport,
        request(&base_url, history.clone(), stale.clone()),
    )
    .await;
    let err = first.expect_err("fallback failure propagates");
    assert_eq!(err.status, Some(500));
    let (second, _) = step(&transport, request(&base_url, history, stale)).await;
    assert_eq!(
        response_id_of(&second.unwrap().continuation),
        "resp_fresh_3"
    );

    let requests = mock.requests.lock().unwrap().clone();
    assert_eq!(
        requests.len(),
        4,
        "seed + rejected + failed fallback + retry"
    );
    assert_eq!(previous_response_id(&requests[1]), Some("resp_stale"));
    assert!(requests[2].get("previous_response_id").is_none());
    assert!(requests[3].get("previous_response_id").is_none());
    assert_eq!(requests[3]["input"].as_array().unwrap().len(), 3);
}

#[tokio::test]
async fn non_continuation_errors_are_not_retried_without_the_handle() {
    let (base_url, mock) = spawn_mock(|_, index| {
        if index == 0 {
            return text_reply("resp_stale", "Hi there.");
        }
        json_error(
            StatusCode::BAD_REQUEST,
            json!({
                "message": "Invalid value for 'reasoning.effort'.",
                "type": "invalid_request_error",
                "param": "reasoning.effort",
                "code": "invalid_value"
            }),
        )
    })
    .await;
    let (history, stale) = seed_stale_continuation(&base_url).await;

    let (result, _) = step(
        &OpenAiResponsesTransport::new(),
        request(&base_url, history, stale),
    )
    .await;
    let err = result.expect_err("unrelated 400 propagates");
    let requests = mock.requests.lock().unwrap().clone();
    assert_eq!(previous_response_id(&requests[1]), Some("resp_stale"));
    assert_eq!(err.status, Some(400));
    assert!(err.message.contains("reasoning.effort"), "{}", err.message);
    assert_eq!(requests.len(), 2, "no fallback request");
}

#[tokio::test]
async fn rejection_after_visible_output_is_not_retried() {
    let (base_url, mock) = spawn_mock(|_, index| {
        if index == 0 {
            return text_reply("resp_stale", "Hi there.");
        }
        sse_response(sse(&[
            json!({"type": "response.created", "response": {"id": "resp_partial", "status": "in_progress"}}),
            json!({
                "type": "response.output_item.added",
                "item": {"id": "msg_partial", "type": "message", "content": []}
            }),
            json!({"type": "response.content_part.added", "part": {"type": "output_text", "text": ""}}),
            json!({"type": "response.output_text.delta", "delta": "Partial"}),
            json!({
                "type": "error",
                "code": "previous_response_not_found",
                "message": "Previous response with id 'resp_stale' not found."
            }),
        ]))
    })
    .await;
    let (history, stale) = seed_stale_continuation(&base_url).await;

    let (result, events) = step(
        &OpenAiResponsesTransport::new(),
        request(&base_url, history, stale),
    )
    .await;
    let err = result.expect_err("mid-stream rejection propagates");
    assert_eq!(err.code.as_deref(), Some("previous_response_not_found"));
    assert!(
        events
            .iter()
            .any(|ev| matches!(ev, StreamEvent::TextDelta { delta, .. } if delta == "Partial"))
    );
    assert_eq!(
        mock.requests.lock().unwrap().len(),
        2,
        "no fallback request"
    );
}

#[tokio::test]
async fn rejection_without_a_sent_handle_is_not_retried() {
    let (base_url, mock) = spawn_mock(|_, _| previous_response_not_found("resp_other")).await;
    let (result, _) = step(
        &OpenAiResponsesTransport::new(),
        request(&base_url, vec![user("u1", "hello")], None),
    )
    .await;
    assert_eq!(result.expect_err("propagates").status, Some(400));
    assert_eq!(mock.requests.lock().unwrap().len(), 1);
}
