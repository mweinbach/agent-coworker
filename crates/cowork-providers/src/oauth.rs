use std::collections::HashMap;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr, SocketAddrV4, SocketAddrV6};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use chrono::{Duration as ChronoDuration, Utc};
use cowork_config::{ensure_private_dir_sync, harden_private_file_sync, write_text_file_atomic};
use cowork_inference::ProviderTransportError;
use data_encoding::BASE64URL_NOPAD;
use parking_lot::Mutex;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::net::TcpListener;
use tokio::sync::watch;
use tokio::task::JoinHandle;
use uuid::Uuid;

use crate::sse::build_http_client;

const CALLBACK_WAIT_TIMEOUT_SECS: u64 = 180;
const TOKEN_HTTP_TIMEOUT_SECS: u64 = 30;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OAuthMode {
    Auto,
    Code,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PkceOAuthConfig {
    pub client_id: String,
    pub authorize_url: String,
    pub token_url: String,
    pub scopes: Vec<String>,
    /// Advertised redirect host (kept strictly separate from listener bind hosts `127.0.0.1` & `::1`).
    pub advertised_redirect_host: String,
    pub callback_path: String,
    pub mode: OAuthMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthPkceChallenge {
    pub challenge_id: String,
    pub authorize_url: String,
    pub redirect_uri: String,
    pub state: String,
    pub code_challenge: String,
    pub bound_port: Option<u16>,
    pub ipv4_listening: bool,
    pub ipv6_listening: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedOAuthCredentials {
    pub access_token: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
struct TokenEndpointResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<i64>,
    #[serde(default)]
    token_type: Option<String>,
    #[serde(default)]
    scope: Option<String>,
}

pub fn generate_pkce_s256_pair() -> (String, String) {
    let mut verifier_bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut verifier_bytes);
    let verifier = BASE64URL_NOPAD.encode(&verifier_bytes);
    let digest = Sha256::digest(verifier.as_bytes());
    let challenge = BASE64URL_NOPAD.encode(&digest);
    (verifier, challenge)
}

pub fn generate_oauth_state() -> String {
    let mut state_bytes = [0u8; 24];
    rand::rng().fill_bytes(&mut state_bytes);
    BASE64URL_NOPAD.encode(&state_bytes)
}

/// Outcome delivered by the loopback callback: the authorization code, or the provider's
/// `?error=` (with `error_description` when present) so a denied flow fails immediately.
type CallbackOutcome = Option<Result<String, String>>;

#[derive(Clone)]
struct CallbackSharedState {
    expected_state: String,
    code_tx: Arc<Mutex<Option<watch::Sender<CallbackOutcome>>>>,
}

struct ActiveChallenge {
    config: PkceOAuthConfig,
    redirect_uri: String,
    code_verifier: String,
    code_rx: Option<watch::Receiver<CallbackOutcome>>,
    server_tasks: Vec<JoinHandle<()>>,
}

impl Drop for ActiveChallenge {
    /// Dropping a `JoinHandle` only detaches its task: abort the loopback callback servers so a
    /// timed-out, failed, or cancelled challenge never leaves its listeners bound.
    fn drop(&mut self) {
        for handle in self.server_tasks.drain(..) {
            handle.abort();
        }
    }
}

#[derive(Clone, Default)]
pub struct PkceOAuthManager {
    challenges: Arc<Mutex<HashMap<String, ActiveChallenge>>>,
}

impl std::fmt::Debug for PkceOAuthManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PkceOAuthManager")
            .field("active_challenges", &self.challenges.lock().len())
            .finish()
    }
}

fn format_redirect_host(host: &str) -> String {
    let trimmed = host.trim();
    if trimmed.contains(':') && !trimmed.starts_with('[') {
        format!("[{trimmed}]")
    } else {
        trimmed.to_string()
    }
}

const DUAL_STACK_BIND_ATTEMPTS: usize = 12;

/// Whether the redirect advertised to the browser can resolve to `[::1]`. An IPv4 literal
/// (`127.0.0.1`) never does, so its IPv6 listener is best effort (the TS MCP OAuth flow pins
/// `127.0.0.1` the same way); `localhost` and every other host need the `[::1]` listener on the
/// same port, or a browser that tries `::1` first would hand `code` and `state` to whichever
/// local process owns `[::1]:port`.
fn advertised_host_requires_ipv6(advertised_host: &str) -> bool {
    advertised_host.trim().parse::<Ipv4Addr>().is_err()
}

/// The bind error means this host has no usable IPv6 loopback at all (rather than a conflict on
/// one port): `EADDRNOTAVAIL`, or the address family being unsupported.
fn is_ipv6_loopback_unavailable(err: &std::io::Error) -> bool {
    #[cfg(target_os = "linux")]
    const EAFNOSUPPORT: i32 = 97;
    #[cfg(windows)]
    const EAFNOSUPPORT: i32 = 10047;
    #[cfg(not(any(target_os = "linux", windows)))]
    const EAFNOSUPPORT: i32 = 47;
    matches!(
        err.kind(),
        std::io::ErrorKind::AddrNotAvailable | std::io::ErrorKind::Unsupported
    ) || err.raw_os_error() == Some(EAFNOSUPPORT)
}

/// The `[::1]` bind failed because another socket holds (or exclusively reserves) that port:
/// `EADDRINUSE`, or `WSAEACCES` / `EACCES` from `SO_EXCLUSIVEADDRUSE` on Windows.
fn is_ipv6_port_conflict(err: &std::io::Error) -> bool {
    matches!(
        err.kind(),
        std::io::ErrorKind::AddrInUse | std::io::ErrorKind::PermissionDenied
    )
}

async fn bind_dual_stack_ephemeral(
    require_ipv6: bool,
) -> Result<(u16, TcpListener, Option<TcpListener>), ProviderTransportError> {
    bind_dual_stack_with(require_ipv6, |port| async move {
        TcpListener::bind(SocketAddr::V6(SocketAddrV6::new(
            Ipv6Addr::LOCALHOST,
            port,
            0,
            0,
        )))
        .await
    })
    .await
}

/// Binds `127.0.0.1:0` and then `[::1]` on the same port, retrying with a fresh port whenever
/// `[::1]:port` is taken. An IPv4-only result is returned only when IPv6 is optional
/// (`require_ipv6 == false`) or the host has no IPv6 loopback (`[::1]:0` itself cannot bind);
/// otherwise allocation fails closed once the retries are exhausted.
async fn bind_dual_stack_with<V6, F, Fut>(
    require_ipv6: bool,
    mut bind_v6: F,
) -> Result<(u16, TcpListener, Option<V6>), ProviderTransportError>
where
    F: FnMut(u16) -> Fut,
    Fut: std::future::Future<Output = std::io::Result<V6>>,
{
    let mut last_v6_error = None;
    for _ in 0..DUAL_STACK_BIND_ATTEMPTS {
        let v4 = TcpListener::bind(SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)))
            .await
            .map_err(|err| {
                ProviderTransportError::network(format!(
                    "Failed to bind IPv4 loopback OAuth callback listener: {err}"
                ))
            })?;
        let port = v4
            .local_addr()
            .map_err(|err| ProviderTransportError::network(err.to_string()))?
            .port();

        let err = match bind_v6(port).await {
            Ok(v6) => return Ok((port, v4, Some(v6))),
            Err(err) => err,
        };
        if !require_ipv6 {
            if is_ipv6_port_conflict(&err) {
                // Prefer a port both families share, but IPv6 stays best effort.
                last_v6_error = Some(err);
                continue;
            }
            return Ok((port, v4, None));
        }
        if !is_ipv6_port_conflict(&err) {
            // Only a host without an IPv6 loopback may fall back to IPv4 alone.
            match bind_v6(0).await {
                Err(probe_err) if is_ipv6_loopback_unavailable(&probe_err) => {
                    return Ok((port, v4, None));
                }
                Ok(_) | Err(_) => {}
            }
        }
        // Retry another ephemeral port so both 127.0.0.1 and [::1] share the exact same port.
        last_v6_error = Some(err);
    }

    if !require_ipv6 {
        let v4 = TcpListener::bind(SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)))
            .await
            .map_err(|err| ProviderTransportError::network(err.to_string()))?;
        let port = v4
            .local_addr()
            .map_err(|err| ProviderTransportError::network(err.to_string()))?
            .port();
        return Ok((port, v4, None));
    }
    Err(ProviderTransportError::network(format!(
        "Failed to bind the OAuth callback listener on the same port for 127.0.0.1 and [::1]{}",
        last_v6_error
            .map(|err| format!(": {err}"))
            .unwrap_or_default()
    )))
}

async fn handle_oauth_callback(
    State(shared): State<CallbackSharedState>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let state = params.get("state").map(String::as_str).unwrap_or_default();
    if state != shared.expected_state {
        return (
            StatusCode::BAD_REQUEST,
            "Invalid OAuth state parameter (CSRF check failed).",
        )
            .into_response();
    }

    if let Some(err) = params.get("error") {
        let detail = match params
            .get("error_description")
            .map(|d| d.trim())
            .filter(|d| !d.is_empty())
        {
            Some(description) => format!("{err}: {description}"),
            None => err.clone(),
        };
        // Fail the waiting challenge now instead of letting it run out the callback timeout.
        if let Some(tx) = shared.code_tx.lock().take() {
            let _ = tx.send(Some(Err(detail.clone())));
        }
        return (
            StatusCode::BAD_REQUEST,
            format!("OAuth authorization failed: {detail}"),
        )
            .into_response();
    }

    let Some(code) = params
        .get("code")
        .map(String::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return (StatusCode::BAD_REQUEST, "Missing OAuth authorization code.").into_response();
    };

    if let Some(tx) = shared.code_tx.lock().take() {
        let _ = tx.send(Some(Ok(code.to_string())));
    }

    (
        StatusCode::OK,
        Html("<html><body><h1>Authentication complete</h1><p>You may close this window and return to Cowork.</p></body></html>"),
    )
        .into_response()
}

fn persist_oauth_credentials(
    path: &Path,
    creds: &PersistedOAuthCredentials,
) -> Result<(), ProviderTransportError> {
    if let Some(parent) = path.parent() {
        ensure_private_dir_sync(parent).map_err(|e| {
            ProviderTransportError::protocol(format!("Failed to create OAuth auth dir: {e}"))
        })?;
    }
    let json = serde_json::to_string_pretty(creds)
        .map_err(|e| ProviderTransportError::protocol(e.to_string()))?;
    write_text_file_atomic(path, &json, Some(0o600)).map_err(|e| {
        ProviderTransportError::protocol(format!("Failed to persist OAuth credentials: {e}"))
    })?;
    harden_private_file_sync(path);
    Ok(())
}

impl PkceOAuthManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn start_challenge(
        &self,
        config: PkceOAuthConfig,
    ) -> Result<OAuthPkceChallenge, ProviderTransportError> {
        let (code_verifier, code_challenge) = generate_pkce_s256_pair();
        let state = generate_oauth_state();
        let challenge_id = Uuid::new_v4().to_string();

        let callback_path = if config.callback_path.starts_with('/') {
            config.callback_path.clone()
        } else {
            format!("/{}", config.callback_path)
        };

        let mut bound_port = None;
        let mut ipv4_listening = false;
        let mut ipv6_listening = false;
        let mut code_rx_opt = None;
        let mut server_tasks = Vec::new();

        let redirect_uri = match config.mode {
            OAuthMode::Auto => {
                let (port, v4_listener, v6_listener_opt) = bind_dual_stack_ephemeral(
                    advertised_host_requires_ipv6(&config.advertised_redirect_host),
                )
                .await?;
                bound_port = Some(port);
                ipv4_listening = true;
                ipv6_listening = v6_listener_opt.is_some();

                let (tx, rx) = watch::channel::<CallbackOutcome>(None);
                code_rx_opt = Some(rx);

                let cb_state = CallbackSharedState {
                    expected_state: state.clone(),
                    code_tx: Arc::new(Mutex::new(Some(tx))),
                };

                let app_v4 = Router::new()
                    .route(&callback_path, get(handle_oauth_callback))
                    .with_state(cb_state.clone());
                server_tasks.push(tokio::spawn(async move {
                    let _ = axum::serve(v4_listener, app_v4).await;
                }));

                if let Some(v6_listener) = v6_listener_opt {
                    let app_v6 = Router::new()
                        .route(&callback_path, get(handle_oauth_callback))
                        .with_state(cb_state);
                    server_tasks.push(tokio::spawn(async move {
                        let _ = axum::serve(v6_listener, app_v6).await;
                    }));
                }

                format!(
                    "http://{}:{port}{callback_path}",
                    format_redirect_host(&config.advertised_redirect_host)
                )
            }
            OAuthMode::Code => format!(
                "https://{}{callback_path}",
                format_redirect_host(&config.advertised_redirect_host)
            ),
        };

        let mut auth_url = url::Url::parse(&config.authorize_url).map_err(|err| {
            ProviderTransportError::protocol(format!("Invalid OAuth authorize_url: {err}"))
        })?;
        {
            let mut qp = auth_url.query_pairs_mut();
            qp.append_pair("response_type", "code");
            qp.append_pair("client_id", &config.client_id);
            qp.append_pair("redirect_uri", &redirect_uri);
            if !config.scopes.is_empty() {
                qp.append_pair("scope", &config.scopes.join(" "));
            }
            qp.append_pair("state", &state);
            qp.append_pair("code_challenge", &code_challenge);
            qp.append_pair("code_challenge_method", "S256");
            if let Some(res) = config.resource.as_deref().filter(|s| !s.is_empty()) {
                qp.append_pair("resource", res);
            }
        }

        let authorize_url_str = auth_url.to_string();

        self.challenges.lock().insert(
            challenge_id.clone(),
            ActiveChallenge {
                config,
                redirect_uri: redirect_uri.clone(),
                code_verifier,
                code_rx: code_rx_opt,
                server_tasks,
            },
        );

        Ok(OAuthPkceChallenge {
            challenge_id,
            authorize_url: authorize_url_str,
            redirect_uri,
            state,
            code_challenge,
            bound_port,
            ipv4_listening,
            ipv6_listening,
        })
    }

    pub async fn complete_challenge(
        &self,
        challenge_id: &str,
        pasted_code: Option<&str>,
        credentials_file: Option<&Path>,
    ) -> Result<PersistedOAuthCredentials, ProviderTransportError> {
        let mut challenge = self.challenges.lock().remove(challenge_id).ok_or_else(|| {
            ProviderTransportError::protocol(format!(
                "Unknown or expired OAuth challenge: {challenge_id}"
            ))
        })?;

        let code = if let Some(explicit) = pasted_code.map(str::trim).filter(|s| !s.is_empty()) {
            explicit.to_string()
        } else if let Some(mut rx) = challenge.code_rx.take() {
            tokio::time::timeout(
                Duration::from_secs(CALLBACK_WAIT_TIMEOUT_SECS),
                async move {
                    loop {
                        match rx.borrow().clone() {
                            Some(Ok(c)) => return Ok(c),
                            Some(Err(err)) => {
                                return Err(ProviderTransportError::protocol(format!(
                                    "OAuth authorization failed: {err}"
                                )));
                            }
                            None => {}
                        }
                        if rx.changed().await.is_err() {
                            return Err(ProviderTransportError::protocol(
                                "OAuth callback listener closed before receiving authorization code.",
                            ));
                        }
                    }
                },
            )
            .await
            .map_err(|_| {
                ProviderTransportError::timeout("Timed out waiting for loopback OAuth callback.")
            })??
        } else {
            return Err(ProviderTransportError::protocol(
                "Authorization code is required for manual OAuth mode.",
            ));
        };

        for handle in challenge.server_tasks.drain(..) {
            handle.abort();
        }

        let form_body: String = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("grant_type", "authorization_code")
            .append_pair("client_id", &challenge.config.client_id)
            .append_pair("code", &code)
            .append_pair("redirect_uri", &challenge.redirect_uri)
            .append_pair("code_verifier", &challenge.code_verifier)
            .finish();

        let creds = exchange_oauth_token(&challenge.config.token_url, form_body, None).await?;
        if let Some(file) = credentials_file {
            persist_oauth_credentials(file, &creds)?;
        }
        Ok(creds)
    }

    pub async fn refresh_tokens(
        &self,
        token_url: &str,
        client_id: &str,
        refresh_token: &str,
        credentials_file: Option<&Path>,
    ) -> Result<PersistedOAuthCredentials, ProviderTransportError> {
        let form_body: String = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("grant_type", "refresh_token")
            .append_pair("client_id", client_id)
            .append_pair("refresh_token", refresh_token)
            .finish();

        let creds = exchange_oauth_token(token_url, form_body, Some(refresh_token)).await?;
        if let Some(file) = credentials_file {
            persist_oauth_credentials(file, &creds)?;
        }
        Ok(creds)
    }
}

async fn exchange_oauth_token(
    token_url: &str,
    form_body: String,
    fallback_refresh_token: Option<&str>,
) -> Result<PersistedOAuthCredentials, ProviderTransportError> {
    let client = build_http_client()?;
    let resp = client
        .post(token_url)
        .header("content-type", "application/x-www-form-urlencoded")
        .header("accept", "application/json")
        .timeout(Duration::from_secs(TOKEN_HTTP_TIMEOUT_SECS))
        .body(form_body)
        .send()
        .await
        .map_err(|err| {
            ProviderTransportError::network(format!("OAuth token request failed: {err}"))
        })?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(ProviderTransportError::http(
            status.as_u16(),
            format!(
                "OAuth token endpoint returned {}: {}",
                status.as_u16(),
                body.trim()
            ),
            HashMap::new(),
        ));
    }

    let parsed: TokenEndpointResponse = resp.json().await.map_err(|err| {
        ProviderTransportError::protocol(format!("Invalid OAuth token JSON response: {err}"))
    })?;

    let now = Utc::now();
    let expires_at = parsed
        .expires_in
        .filter(|secs| *secs > 0)
        .map(|secs| (now + ChronoDuration::seconds(secs)).to_rfc3339());

    Ok(PersistedOAuthCredentials {
        access_token: parsed.access_token,
        refresh_token: parsed
            .refresh_token
            .or_else(|| fallback_refresh_token.map(ToOwned::to_owned)),
        expires_at,
        token_type: parsed.token_type,
        scope: parsed.scope,
        updated_at: now.to_rfc3339(),
    })
}

#[cfg(test)]
mod tests {
    use std::io::{Error, ErrorKind};
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    /// Drives `bind_dual_stack_with` with a scripted `[::1]` binder: `script(call, port)`.
    async fn bind_with(
        require_ipv6: bool,
        script: impl Fn(usize, u16) -> std::io::Result<()>,
    ) -> (Result<(u16, bool), ProviderTransportError>, Vec<u16>) {
        let calls = AtomicUsize::new(0);
        let ports = Mutex::new(Vec::new());
        let result = bind_dual_stack_with(require_ipv6, |port| {
            let call = calls.fetch_add(1, Ordering::SeqCst);
            ports.lock().push(port);
            let outcome = script(call, port);
            async move { outcome }
        })
        .await
        .map(|(port, _v4, v6)| (port, v6.is_some()));
        (result, ports.into_inner())
    }

    #[test]
    fn only_ipv4_literal_redirect_hosts_make_ipv6_optional() {
        assert!(!advertised_host_requires_ipv6("127.0.0.1"));
        assert!(!advertised_host_requires_ipv6(" 127.0.0.1 "));
        assert!(advertised_host_requires_ipv6("localhost"));
        assert!(advertised_host_requires_ipv6("::1"));
    }

    #[tokio::test]
    async fn permission_denied_on_ipv6_port_retries_a_fresh_port() {
        // `WSAEACCES`: another process holds `[::1]:port` with `SO_EXCLUSIVEADDRUSE`.
        let (result, ports) = bind_with(true, |call, _| {
            if call < 2 {
                Err(Error::from(ErrorKind::PermissionDenied))
            } else {
                Ok(())
            }
        })
        .await;
        let (port, ipv6) = result.expect("third port binds both families");
        assert!(ipv6, "localhost redirect keeps the [::1] listener");
        assert_eq!(ports.len(), 3);
        assert!(
            ports.iter().all(|p| *p != 0),
            "no [::1]:0 probe on conflicts"
        );
        assert_eq!(ports.last(), Some(&port));
    }

    #[tokio::test]
    async fn exhausted_ipv6_retries_fail_closed_for_localhost_redirects() {
        for kind in [ErrorKind::AddrInUse, ErrorKind::PermissionDenied] {
            let (result, ports) = bind_with(true, |_, _| Err(Error::from(kind))).await;
            let err = result.expect_err("never advertise localhost with an IPv4-only listener");
            assert!(err.message.contains("[::1]"), "{}", err.message);
            assert_eq!(ports.len(), DUAL_STACK_BIND_ATTEMPTS);
        }
        // `[::1]` itself works (the `[::1]:0` probe binds) but every same-port bind fails.
        let (result, _) = bind_with(true, |_, port| {
            if port == 0 {
                Ok(())
            } else {
                Err(Error::other("unexpected bind failure"))
            }
        })
        .await;
        result.expect_err("an unexplained [::1] failure is not treated as missing IPv6");
    }

    #[tokio::test]
    async fn host_without_ipv6_loopback_falls_back_to_ipv4_only() {
        let (result, ports) =
            bind_with(true, |_, _| Err(Error::from(ErrorKind::AddrNotAvailable))).await;
        let (_, ipv6) = result.expect("IPv4-only host still gets a listener");
        assert!(!ipv6);
        assert_eq!(ports.len(), 2, "port bind + [::1]:0 probe");
        assert_eq!(ports[1], 0);
    }

    #[tokio::test]
    async fn ipv4_literal_redirects_keep_ipv6_best_effort() {
        let (result, ports) =
            bind_with(false, |_, _| Err(Error::from(ErrorKind::PermissionDenied))).await;
        let (_, ipv6) = result.expect("127.0.0.1 redirect never needs [::1]");
        assert!(!ipv6);
        assert_eq!(ports.len(), DUAL_STACK_BIND_ATTEMPTS);
    }
}
