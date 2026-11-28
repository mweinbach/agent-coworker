//! Ephemeral per-turn loopback credential-broker proxy for Cowork-managed CLI runtimes
//! (`claude-sdk`, `antigravity-acp`).
//!
//! Keeps saved provider secrets (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `GEMINI_API_KEY`)
//! strictly inside the Cowork server process so neither the managed CLI subprocess nor any native
//! tool child it spawns (e.g., `Bash`) ever inherits the real account credential in its
//! environment. Each turn receives an ephemeral 256-bit random placeholder token and a loopback
//! `127.0.0.1:<port>` base URL that authenticates the placeholder in constant time, swaps in the
//! real credential on the outbound HTTPS request to the configured upstream origin (with redirects
//! disabled), streams the response back verbatim, and shuts down immediately when the turn ends.

use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::extract::State;
use axum::http::{HeaderMap, HeaderName, HeaderValue, Request, Response, StatusCode};
use axum::routing::any;
use rand::RngCore;
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use url::Url;

const MAX_PROXY_REQUEST_BYTES: usize = 64 * 1024 * 1024;
const PROXY_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// Upstream authentication mode brokered by [`CredentialBrokerProxy`].
#[derive(Clone)]
pub(crate) enum UpstreamAuth {
    /// Injects `x-api-key: <secret>` on outbound requests to Anthropic.
    AnthropicApiKey(String),
    /// Injects `Authorization: Bearer <secret>` on outbound requests to Anthropic.
    AnthropicOAuthToken(String),
    /// Injects `x-goog-api-key: <secret>` on outbound requests to Gemini / Google AI.
    GeminiApiKey(String),
}

impl std::fmt::Debug for UpstreamAuth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::AnthropicApiKey(_) => f.write_str("UpstreamAuth::AnthropicApiKey([REDACTED])"),
            Self::AnthropicOAuthToken(_) => {
                f.write_str("UpstreamAuth::AnthropicOAuthToken([REDACTED])")
            }
            Self::GeminiApiKey(_) => f.write_str("UpstreamAuth::GeminiApiKey([REDACTED])"),
        }
    }
}

impl UpstreamAuth {
    fn generate_proxy_token(&self) -> String {
        let mut raw = [0u8; 32];
        rand::rng().fill_bytes(&mut raw);
        let hex_token = hex::encode(raw);
        match self {
            Self::AnthropicApiKey(_) => format!("sk-ant-api03-cowork-proxy-{hex_token}"),
            Self::AnthropicOAuthToken(_) => format!("sk-ant-oat01-cowork-proxy-{hex_token}"),
            Self::GeminiApiKey(_) => format!("AIzaSyCoworkProxy{}", &hex_token[..48]),
        }
    }

    fn verify_inbound(&self, headers: &HeaderMap, query: Option<&str>, expected: &str) -> bool {
        let header_str = |name: &str| {
            headers
                .get(name)
                .and_then(|v| v.to_str().ok())
                .map(str::trim)
        };
        let bearer_token = header_str("authorization").and_then(|v| {
            let (scheme, token) = v.split_once(' ')?;
            scheme
                .eq_ignore_ascii_case("bearer")
                .then_some(token.trim())
        });

        match self {
            Self::AnthropicApiKey(_) | Self::AnthropicOAuthToken(_) => {
                header_str("x-api-key").is_some_and(|v| ct_eq(v, expected))
                    || bearer_token.is_some_and(|v| ct_eq(v, expected))
            }
            Self::GeminiApiKey(_) => {
                if header_str("x-goog-api-key").is_some_and(|v| ct_eq(v, expected)) {
                    return true;
                }
                if let Some(q) = query {
                    for (k, v) in url::form_urlencoded::parse(q.as_bytes()) {
                        if k == "key" && ct_eq(v.as_ref(), expected) {
                            return true;
                        }
                    }
                }
                false
            }
        }
    }

    fn apply_upstream(&self, headers: &mut reqwest::header::HeaderMap) -> Result<(), String> {
        match self {
            Self::AnthropicApiKey(secret) => {
                let value = HeaderValue::from_str(secret)
                    .map_err(|_| "Invalid Anthropic API key header value.".to_owned())?;
                headers.insert(HeaderName::from_static("x-api-key"), value);
            }
            Self::AnthropicOAuthToken(secret) => {
                let value = HeaderValue::from_str(&format!("Bearer {secret}"))
                    .map_err(|_| "Invalid Anthropic OAuth token header value.".to_owned())?;
                headers.insert(HeaderName::from_static("authorization"), value);
            }
            Self::GeminiApiKey(secret) => {
                let value = HeaderValue::from_str(secret)
                    .map_err(|_| "Invalid Gemini API key header value.".to_owned())?;
                headers.insert(HeaderName::from_static("x-goog-api-key"), value);
            }
        }
        Ok(())
    }

    fn strips_query_key(&self) -> bool {
        matches!(self, Self::GeminiApiKey(_))
    }
}

struct ProxyState {
    upstream_base: Url,
    auth: UpstreamAuth,
    proxy_token: String,
    client: reqwest::Client,
}

/// Active loopback credential-broker proxy bound strictly to `127.0.0.1:<port>`.
/// Shuts down immediately when dropped.
pub(crate) struct CredentialBrokerProxy {
    base_url: String,
    proxy_token: String,
    shutdown_tx: Option<oneshot::Sender<()>>,
    server_task: JoinHandle<()>,
}

impl CredentialBrokerProxy {
    pub(crate) async fn start(upstream_base_url: &str, auth: UpstreamAuth) -> Result<Self, String> {
        let trimmed = upstream_base_url.trim().trim_end_matches('/');
        let upstream_base = Url::parse(trimmed)
            .map_err(|err| format!("Invalid upstream provider URL '{trimmed}': {err}"))?;
        if !matches!(upstream_base.scheme(), "http" | "https") || upstream_base.host_str().is_none()
        {
            return Err(format!(
                "Upstream provider URL must use http:// or https:// with a host: '{trimmed}'"
            ));
        }

        // Disable automatic redirects so an upstream 3xx can never forward the real
        // provider credential to an attacker-controlled third-party host.
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(PROXY_CONNECT_TIMEOUT)
            .build()
            .map_err(|err| format!("Failed to construct credential proxy HTTP client: {err}"))?;

        let proxy_token = auth.generate_proxy_token();
        let state = Arc::new(ProxyState {
            upstream_base,
            auth,
            proxy_token: proxy_token.clone(),
            client,
        });

        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|err| format!("Failed to bind loopback credential proxy: {err}"))?;
        let port = listener
            .local_addr()
            .map_err(|err| format!("Failed to inspect loopback credential proxy address: {err}"))?
            .port();

        let app = Router::new()
            .fallback(any(handle_proxy_request))
            .with_state(state);
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        let server_task = tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    let _ = shutdown_rx.await;
                })
                .await;
        });

        Ok(Self {
            base_url: format!("http://127.0.0.1:{port}"),
            proxy_token,
            shutdown_tx: Some(shutdown_tx),
            server_task,
        })
    }

    pub(crate) fn base_url(&self) -> &str {
        &self.base_url
    }

    pub(crate) fn proxy_token(&self) -> &str {
        &self.proxy_token
    }
}

impl Drop for CredentialBrokerProxy {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
        self.server_task.abort();
    }
}

/// Ensures `127.0.0.1` and `localhost` are present in `NO_PROXY` / `no_proxy` so host proxy
/// settings never intercept local loopback credential brokering.
pub(crate) fn merge_loopback_no_proxy(existing: Option<&str>) -> String {
    let mut entries: Vec<String> = existing
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
        .collect();
    for required in ["127.0.0.1", "localhost"] {
        if !entries.iter().any(|e| e.eq_ignore_ascii_case(required)) {
            entries.push(required.to_owned());
        }
    }
    entries.join(",")
}

pub(crate) fn ct_eq(left: &str, right: &str) -> bool {
    let a = left.as_bytes();
    let b = right.as_bytes();
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (&x, &y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn is_hop_by_hop_or_blocked_request_header(name: &str) -> bool {
    matches!(
        name,
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailers"
            | "transfer-encoding"
            | "upgrade"
            | "host"
            | "content-length"
            | "authorization"
            | "x-api-key"
            | "x-goog-api-key"
            | "cookie"
    )
}

fn is_hop_by_hop_or_blocked_response_header(name: &str) -> bool {
    matches!(
        name,
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailers"
            | "transfer-encoding"
            | "upgrade"
            | "set-cookie"
    )
}

fn build_upstream_url(
    upstream_base: &Url,
    req_path: &str,
    req_query: Option<&str>,
    strip_query_key: bool,
) -> Result<Url, &'static str> {
    if !req_path.starts_with('/')
        || req_path.starts_with("//")
        || req_path.contains('\\')
        || req_path.split('/').any(|seg| seg == "..")
    {
        return Err("Invalid proxy request path.");
    }

    let mut url = upstream_base.clone();
    let base_path = url.path().trim_end_matches('/');
    let combined_path = if base_path.is_empty() {
        req_path.to_owned()
    } else {
        format!("{base_path}{req_path}")
    };
    url.set_path(&combined_path);

    if let Some(q) = req_query {
        if strip_query_key {
            let mut serializer = url::form_urlencoded::Serializer::new(String::new());
            for (k, v) in url::form_urlencoded::parse(q.as_bytes()) {
                if k != "key" {
                    serializer.append_pair(k.as_ref(), v.as_ref());
                }
            }
            let filtered = serializer.finish();
            url.set_query((!filtered.is_empty()).then_some(filtered.as_str()));
        } else {
            url.set_query(Some(q));
        }
    } else {
        url.set_query(None);
    }

    Ok(url)
}

async fn handle_proxy_request(
    State(state): State<Arc<ProxyState>>,
    req: Request<Body>,
) -> Response<Body> {
    let (parts, body) = req.into_parts();
    let query = parts.uri.query();
    if !state
        .auth
        .verify_inbound(&parts.headers, query, &state.proxy_token)
    {
        return Response::builder()
            .status(StatusCode::UNAUTHORIZED)
            .body(Body::from("Unauthorized proxy request"))
            .unwrap_or_else(|_| Response::new(Body::empty()));
    }

    let upstream_url = match build_upstream_url(
        &state.upstream_base,
        parts.uri.path(),
        query,
        state.auth.strips_query_key(),
    ) {
        Ok(url) => url,
        Err(msg) => {
            return Response::builder()
                .status(StatusCode::BAD_REQUEST)
                .body(Body::from(msg))
                .unwrap_or_else(|_| Response::new(Body::empty()));
        }
    };

    let body_bytes = match to_bytes(body, MAX_PROXY_REQUEST_BYTES).await {
        Ok(bytes) => bytes,
        Err(_) => {
            return Response::builder()
                .status(StatusCode::PAYLOAD_TOO_LARGE)
                .body(Body::from("Proxy request body exceeded size limit"))
                .unwrap_or_else(|_| Response::new(Body::empty()));
        }
    };

    let mut out_headers = reqwest::header::HeaderMap::new();
    for (name, value) in &parts.headers {
        let lower = name.as_str().to_ascii_lowercase();
        if is_hop_by_hop_or_blocked_request_header(&lower) {
            continue;
        }
        out_headers.append(name.clone(), value.clone());
    }
    if state.auth.apply_upstream(&mut out_headers).is_err() {
        return Response::builder()
            .status(StatusCode::INTERNAL_SERVER_ERROR)
            .body(Body::from("Failed to apply upstream provider credentials"))
            .unwrap_or_else(|_| Response::new(Body::empty()));
    }

    let upstream_resp = match state
        .client
        .request(parts.method, upstream_url)
        .headers(out_headers)
        .body(body_bytes)
        .send()
        .await
    {
        Ok(resp) => resp,
        Err(_) => {
            return Response::builder()
                .status(StatusCode::BAD_GATEWAY)
                .body(Body::from("Upstream provider request failed"))
                .unwrap_or_else(|_| Response::new(Body::empty()));
        }
    };

    let mut builder = Response::builder().status(upstream_resp.status());
    if let Some(resp_headers) = builder.headers_mut() {
        for (name, value) in upstream_resp.headers() {
            let lower = name.as_str().to_ascii_lowercase();
            if is_hop_by_hop_or_blocked_response_header(&lower) {
                continue;
            }
            resp_headers.append(name.clone(), value.clone());
        }
    }
    builder
        .body(Body::from_stream(upstream_resp.bytes_stream()))
        .unwrap_or_else(|_| Response::new(Body::empty()))
}
