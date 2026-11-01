use std::collections::HashMap;
use std::pin::Pin;
use std::time::Duration;

use cowork_inference::ProviderTransportError;
use eventsource_stream::Eventsource;
use futures_util::{Stream, StreamExt};
use reqwest::header::HeaderMap;
use serde_json::Value;

/// Raw decoded Server-Sent Event frame (`event:` type and `data:` payload).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseFrame {
    pub event: String,
    pub data: String,
}

pub type BoxedSseStream =
    Pin<Box<dyn Stream<Item = Result<SseFrame, ProviderTransportError>> + Send>>;

/// Builds a shared `reqwest::Client` configured with `rustls` and disabled automatic redirects on
/// POST bodies where not appropriate.
pub fn build_http_client() -> Result<reqwest::Client, ProviderTransportError> {
    reqwest::Client::builder()
        .use_rustls_tls()
        .build()
        .map_err(|err| {
            ProviderTransportError::network(format!("Failed to build HTTP client: {err}"))
        })
}

/// Sends `request` and waits for the response headers, failing with a timeout error when they do
/// not arrive within `header_timeout` (connect + TLS + request upload + response headers).
///
/// This is the pi `timeoutMs` contract: the provider SDKs pi hands it to (OpenAI, Anthropic, the
/// Codex SSE path) clear their timer once the response headers arrive, so it never caps the
/// streamed body. Do NOT use `RequestBuilder::timeout` for streaming model calls: reqwest applies
/// that deadline to the whole body as well, killing long streams. The body is bounded by the
/// caller's `StepBudget`.
pub async fn send_with_header_timeout(
    request: reqwest::RequestBuilder,
    header_timeout: Duration,
) -> Result<reqwest::Response, ProviderTransportError> {
    match tokio::time::timeout(header_timeout, request.send()).await {
        Ok(result) => result.map_err(map_reqwest_error),
        Err(_) => Err(ProviderTransportError::timeout(format!(
            "Provider response headers timed out after {}ms",
            header_timeout.as_millis()
        ))),
    }
}

/// Sends a JSON `POST` request and converts a `2xx` response body into a streaming `BoxedSseStream`
/// via `eventsource-stream`. Non-`2xx` responses capture HTTP headers (`retry-after`,
/// `retry-after-ms`, `x-should-retry`) and extract vendor error messages cleanly.
///
/// `header_timeout` bounds only the wait for response headers (see [`send_with_header_timeout`]);
/// the returned stream has no deadline of its own and must be consumed under a `StepBudget`.
pub async fn post_json_sse(
    client: &reqwest::Client,
    url: &str,
    headers: HeaderMap,
    body: &Value,
    header_timeout: Duration,
) -> Result<BoxedSseStream, ProviderTransportError> {
    let response =
        send_with_header_timeout(client.post(url).headers(headers).json(body), header_timeout)
            .await?;

    let status = response.status();
    if !status.is_success() {
        let header_map = extract_headers_lowercase(response.headers());
        let raw_body = response.text().await.unwrap_or_default();
        let message = extract_error_message_from_body(status.as_u16(), &raw_body);
        return Err(ProviderTransportError::http(
            status.as_u16(),
            message,
            header_map,
        ));
    }

    let event_stream = response
        .bytes_stream()
        .eventsource()
        .map(|item| match item {
            Ok(ev) => Ok(SseFrame {
                event: ev.event,
                data: ev.data,
            }),
            Err(err) => Err(ProviderTransportError::network(format!(
                "SSE stream decode error: {err}"
            ))),
        });

    Ok(Box::pin(event_stream))
}

fn map_reqwest_error(err: reqwest::Error) -> ProviderTransportError {
    if err.is_timeout() {
        ProviderTransportError::timeout(format!("HTTP request timed out: {err}"))
    } else if err.is_connect() || err.is_request() || err.is_body() || err.is_decode() {
        ProviderTransportError::network(format!("HTTP transport error: {err}"))
    } else {
        ProviderTransportError::network(err.to_string())
    }
}

fn extract_headers_lowercase(headers: &HeaderMap) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for (name, val) in headers {
        if let Ok(text) = val.to_str() {
            map.insert(name.as_str().to_ascii_lowercase(), text.to_string());
        }
    }
    map
}

fn extract_error_message_from_body(status: u16, body: &str) -> String {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return format!("Provider HTTP {status}");
    }
    if let Ok(json_val) = serde_json::from_str::<Value>(trimmed) {
        if let Some(msg) = json_val
            .get("error")
            .and_then(|e| e.get("message").or(Some(e)))
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
        {
            return format!("HTTP {status}: {msg}");
        }
        if let Some(msg) = json_val
            .get("message")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
        {
            return format!("HTTP {status}: {msg}");
        }
    }
    format!("HTTP {status}: {trimmed}")
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::convert::Infallible;
    use std::time::Instant;

    use axum::Router;
    use axum::body::Body;
    use axum::response::Response;
    use axum::routing::post;
    use cowork_config::ProviderName;
    use cowork_inference::{
        CanonicalMessage, ContentBlock, MessageRole, ProviderOpaqueMeta, RequestPolicy, StepBudget,
        StopReason, StreamEvent, execute_step_with_pre_output_retry,
    };
    use serde_json::{Map, json};
    use tokio::io::AsyncReadExt;
    use tokio::net::TcpListener;

    use super::*;
    use crate::chat_completions::ChatCompletionsTransport;
    use crate::transport::{ProviderStepRequest, ProviderTransport};

    fn policy(timeout_ms: u64, step_timeout_ms: u64, max_attempts: usize) -> RequestPolicy {
        RequestPolicy {
            timeout_ms,
            step_timeout_ms,
            max_attempts,
            base_delay_ms: 10,
            max_retry_delay_ms: 50,
        }
    }

    /// Serves SSE with response headers sent immediately, then each frame of `frames` after
    /// `gap` (repeating `frames` forever when `forever` is set).
    async fn spawn_slow_sse_server(
        path: &'static str,
        frames: Vec<String>,
        gap: Duration,
        forever: bool,
    ) -> (String, tokio::task::JoinHandle<()>) {
        let app = Router::new().route(
            path,
            post(move || {
                let frames = frames.clone();
                async move {
                    let stream = futures_util::stream::unfold(0usize, move |i| {
                        let frames = frames.clone();
                        async move {
                            if !forever && i >= frames.len() {
                                return None;
                            }
                            tokio::time::sleep(gap).await;
                            let frame = frames[i % frames.len()].clone();
                            Some((Ok::<_, Infallible>(bytes::Bytes::from(frame)), i + 1))
                        }
                    });
                    Response::builder()
                        .status(200)
                        .header("content-type", "text/event-stream")
                        .body(Body::from_stream(stream))
                        .unwrap()
                }
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (format!("http://{addr}"), server)
    }

    /// Mirrors the provider transports: header timeout from the budget, then consume the stream,
    /// emitting each frame as visible output.
    async fn run_step(url: String, policy: RequestPolicy) -> Result<usize, ProviderTransportError> {
        let budget = StepBudget::new(policy.step_timeout_ms, None);
        let client = build_http_client()?;
        execute_step_with_pre_output_retry(&policy, &budget, |_attempt, mut emit| {
            let client = client.clone();
            let url = url.clone();
            let budget = budget.clone();
            async move {
                let header_timeout = budget.attempt_timeout(policy.timeout_ms)?;
                let mut sse =
                    post_json_sse(&client, &url, HeaderMap::new(), &json!({}), header_timeout)
                        .await?;
                let mut frames = 0;
                while let Some(frame) = sse.next().await {
                    let frame = frame?;
                    emit(StreamEvent::TextDelta {
                        turn_id: "turn".into(),
                        block_index: 0,
                        delta: frame.data,
                        phase: None,
                    });
                    frames += 1;
                }
                Ok(frames)
            }
        })
        .await
    }

    #[tokio::test]
    async fn slow_stream_longer_than_header_timeout_completes_within_step_budget() {
        let frames = (0..4).map(|i| format!("data: chunk-{i}\n\n")).collect();
        // Every inter-chunk gap (and the whole body) exceeds the 150ms header timeout.
        let (url, server) =
            spawn_slow_sse_server("/", frames, Duration::from_millis(250), false).await;
        let started = Instant::now();
        let frames = run_step(url, policy(150, 5_000, 1))
            .await
            .expect("header timeout must not cap the streamed body");
        server.abort();
        assert_eq!(frames, 4);
        assert!(started.elapsed() >= Duration::from_millis(900));
    }

    #[tokio::test]
    async fn server_that_never_sends_headers_times_out_at_header_timeout() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        // Accept and read the request, but never answer.
        let server = tokio::spawn(async move {
            let mut held = Vec::new();
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let mut buf = [0u8; 4096];
                let _ = socket.read(&mut buf).await;
                held.push(socket);
            }
        });
        let started = Instant::now();
        let err = run_step(format!("http://{addr}"), policy(200, 10_000, 1))
            .await
            .expect_err("missing response headers must time out");
        let elapsed = started.elapsed();
        server.abort();
        assert!(err.is_timeout, "{err:?}");
        assert!(
            err.message
                .contains("Provider response headers timed out after 200ms"),
            "{}",
            err.message
        );
        assert!(elapsed >= Duration::from_millis(200), "{elapsed:?}");
        assert!(elapsed < Duration::from_secs(3), "{elapsed:?}");
    }

    #[tokio::test]
    async fn step_budget_bounds_a_never_ending_stream() {
        let (url, server) = spawn_slow_sse_server(
            "/",
            vec!["data: tick\n\n".to_owned()],
            Duration::from_millis(40),
            true,
        )
        .await;
        let started = Instant::now();
        let err = run_step(url, policy(100, 600, 4))
            .await
            .expect_err("an endless stream must hit the step budget");
        let elapsed = started.elapsed();
        server.abort();
        assert!(err.is_timeout, "{err:?}");
        assert!(
            err.message.contains("Model step exceeded 600ms budget"),
            "{}",
            err.message
        );
        assert!(elapsed >= Duration::from_millis(600), "{elapsed:?}");
        assert!(elapsed < Duration::from_secs(3), "{elapsed:?}");
    }

    #[tokio::test]
    async fn chat_completions_transport_streams_past_the_header_timeout() {
        let frames = vec![
            "data: {\"id\":\"c1\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"Hello \"}}]}\n\n".to_owned(),
            "data: {\"id\":\"c1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"slow \"}}]}\n\n".to_owned(),
            "data: {\"id\":\"c1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"world\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":3}}\n\n".to_owned(),
            "data: [DONE]\n\n".to_owned(),
        ];
        let (url, server) = spawn_slow_sse_server(
            "/v1/chat/completions",
            frames,
            Duration::from_millis(200),
            false,
        )
        .await;
        let transport = ChatCompletionsTransport::new(ProviderName::Lmstudio)
            .expect("lmstudio maps to ChatCompletionsTransport");
        let step_policy = policy(100, 5_000, 1);
        let budget = StepBudget::new(step_policy.step_timeout_ms, None);
        let result = transport
            .stream_step(
                ProviderStepRequest {
                    model_id: "local-model".into(),
                    base_url: Some(format!("{url}/v1")),
                    api_key: None,
                    extra_headers: HashMap::new(),
                    system_prompt: "sys".into(),
                    messages: vec![CanonicalMessage {
                        id: "u1".into(),
                        role: MessageRole::User,
                        content: vec![ContentBlock::Text {
                            text: "hi".into(),
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
                    }],
                    tools: Vec::new(),
                    authorized_tool_names: None,
                    provider_options: Map::new(),
                    continuation: None,
                    policy: step_policy,
                    turn_id: "turn".into(),
                },
                &budget,
                &mut |_| {},
            )
            .await
            .expect("a stream slower than timeoutMs must complete within stepTimeoutMs");
        server.abort();
        assert_eq!(result.assistant.stop_reason, Some(StopReason::Stop));
        let text: String = result
            .assistant
            .content
            .iter()
            .filter_map(|b| match b {
                ContentBlock::Text { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(text, "Hello slow world");
    }
}
