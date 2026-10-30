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

/// Sends a JSON `POST` request and converts a `2xx` response body into a streaming `BoxedSseStream`
/// via `eventsource-stream`. Non-`2xx` responses capture HTTP headers (`retry-after`,
/// `retry-after-ms`, `x-should-retry`) and extract vendor error messages cleanly.
pub async fn post_json_sse(
    client: &reqwest::Client,
    url: &str,
    headers: HeaderMap,
    body: &Value,
    timeout: Duration,
) -> Result<BoxedSseStream, ProviderTransportError> {
    let response = client
        .post(url)
        .headers(headers)
        .timeout(timeout)
        .json(body)
        .send()
        .await
        .map_err(map_reqwest_error)?;

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
