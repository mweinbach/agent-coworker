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

#[derive(Clone)]
struct CallbackSharedState {
    expected_state: String,
    code_tx: Arc<Mutex<Option<watch::Sender<Option<String>>>>>,
}

struct ActiveChallenge {
    config: PkceOAuthConfig,
    redirect_uri: String,
    code_verifier: String,
    code_rx: Option<watch::Receiver<Option<String>>>,
    server_tasks: Vec<JoinHandle<()>>,
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

async fn bind_dual_stack_ephemeral()
-> Result<(u16, TcpListener, Option<TcpListener>), ProviderTransportError> {
    for _ in 0..12 {
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

        match TcpListener::bind(SocketAddr::V6(SocketAddrV6::new(
            Ipv6Addr::LOCALHOST,
            port,
            0,
            0,
        )))
        .await
        {
            Ok(v6) => return Ok((port, v4, Some(v6))),
            Err(err) if err.kind() == std::io::ErrorKind::AddrInUse => {
                // Retry another ephemeral port so both 127.0.0.1 and [::1] share the exact same port.
                continue;
            }
            Err(_) => {
                // Host lacks IPv6 loopback interface
                return Ok((port, v4, None));
            }
        }
    }

    let v4 = TcpListener::bind(SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)))
        .await
        .map_err(|err| ProviderTransportError::network(err.to_string()))?;
    let port = v4.local_addr().unwrap().port();
    Ok((port, v4, None))
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
        return (
            StatusCode::BAD_REQUEST,
            format!("OAuth authorization failed: {err}"),
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
        let _ = tx.send(Some(code.to_string()));
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
                let (port, v4_listener, v6_listener_opt) = bind_dual_stack_ephemeral().await?;
                bound_port = Some(port);
                ipv4_listening = true;
                ipv6_listening = v6_listener_opt.is_some();

                let (tx, rx) = watch::channel::<Option<String>>(None);
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
                        if let Some(c) = rx.borrow().clone() {
                            return Ok(c);
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

        for handle in challenge.server_tasks {
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
