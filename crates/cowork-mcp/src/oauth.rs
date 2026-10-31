use std::collections::HashMap;
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use axum::Router;
use axum::extract::Query;
use axum::http::StatusCode;
use axum::response::Html;
use axum::routing::get;
use cowork_config::AgentConfig;
use dashmap::DashMap;
use parking_lot::Mutex;
use rand::RngCore;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use url::Url;

use crate::credentials::{
    StoredOAuthClientInfo, StoredOAuthTokens, StoredPendingOAuthFlow, credential_key_for_server,
    mutate_credentials_file, mutate_credentials_for_scope, now_epoch_ms, read_credentials_file,
};
use crate::registry::resolve_target_mcp_server;
use crate::types::{
    McpAuthMode, McpAuthMutationResult, McpConfigSource, McpOAuthChallengePayload,
    McpOAuthChallengeResult, McpOAuthRuntimeContext, McpServerAuthConfig,
};

const PENDING_OAUTH_TTL_MS: u64 = 10 * 60 * 1_000;

struct ActiveCallbackListener {
    captured_code: Arc<Mutex<Option<String>>>,
    shutdown_tx: Option<oneshot::Sender<()>>,
    expires_at: u64,
}

static CALLBACK_LISTENERS: LazyLock<DashMap<String, ActiveCallbackListener>> =
    LazyLock::new(DashMap::new);

fn listener_map_key(scope_path: &std::path::Path, server_name: &str) -> String {
    format!("{}::{server_name}", scope_path.display())
}

#[derive(Debug, Clone, Deserialize)]
struct ProtectedResourceMetadata {
    #[serde(default)]
    resource: Option<String>,
    #[serde(default)]
    authorization_servers: Option<Vec<String>>,
    #[serde(default)]
    scopes_supported: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
struct AuthServerMetadata {
    #[serde(default)]
    issuer: Option<String>,
    #[serde(default)]
    authorization_endpoint: Option<String>,
    #[serde(default)]
    token_endpoint: Option<String>,
    #[serde(default)]
    registration_endpoint: Option<String>,
}

#[derive(Debug, Clone)]
struct DiscoveredOAuthEndpoints {
    issuer: String,
    authorization_endpoint: String,
    token_endpoint: String,
    registration_endpoint: Option<String>,
    resource: String,
    default_scope: Option<String>,
}

fn check_resource_allowed(server_url: &Url, candidate_resource: &str) -> bool {
    let Ok(res_url) = Url::parse(candidate_resource) else {
        return false;
    };
    if res_url.scheme() != server_url.scheme()
        || res_url.host_str() != server_url.host_str()
        || res_url.port_or_known_default() != server_url.port_or_known_default()
    {
        return false;
    }
    let srv_path = server_url.path().trim_end_matches('/');
    let res_path = res_url.path().trim_end_matches('/');
    res_path.is_empty() || srv_path == res_path || srv_path.starts_with(&format!("{res_path}/"))
}

fn extract_www_authenticate_param(header_val: &str, key: &str) -> Option<String> {
    let needle = format!("{key}=");
    let idx = header_val.find(&needle)?;
    let rest = &header_val[idx + needle.len()..];
    if let Some(quoted) = rest.strip_prefix('"') {
        let end = quoted.find('"')?;
        Some(quoted[..end].to_owned())
    } else {
        let end = rest
            .find(|c: char| c == ',' || c.is_whitespace())
            .unwrap_or(rest.len());
        Some(rest[..end].to_owned())
    }
}

async fn discover_oauth_endpoints(
    client: &reqwest::Client,
    remote_url: &str,
    configured_resource: Option<&str>,
) -> Result<DiscoveredOAuthEndpoints, String> {
    let server_url = Url::parse(remote_url).map_err(|e| format!("Invalid MCP URL: {e}"))?;
    let origin = format!(
        "{}://{}{}",
        server_url.scheme(),
        server_url.host_str().unwrap_or("127.0.0.1"),
        match server_url.port() {
            Some(p) => format!(":{p}"),
            None => String::new(),
        }
    );
    let path = server_url.path().trim_end_matches('/');

    // Optional unauthenticated probe to inspect `WWW-Authenticate: Bearer resource_metadata="..."`
    let mut header_resource_metadata_url: Option<String> = None;
    if let Ok(probe_resp) = client
        .post(remote_url)
        .header("Accept", "application/json, text/event-stream")
        .header("Content-Type", "application/json")
        .body(r#"{"jsonrpc":"2.0","id":0,"method":"ping"}"#)
        .send()
        .await
        && probe_resp.status() == StatusCode::UNAUTHORIZED
        && let Some(www) = probe_resp
            .headers()
            .get("www-authenticate")
            .and_then(|v| v.to_str().ok())
    {
        header_resource_metadata_url = extract_www_authenticate_param(www, "resource_metadata");
    }

    // RFC 9728 Protected Resource Metadata candidate URLs
    let mut prm_candidates = Vec::new();
    if let Some(u) = header_resource_metadata_url {
        prm_candidates.push(u);
    }
    if !path.is_empty() {
        prm_candidates.push(format!(
            "{origin}/.well-known/oauth-protected-resource{path}"
        ));
    }
    prm_candidates.push(format!("{origin}/.well-known/oauth-protected-resource"));

    let mut prm: Option<ProtectedResourceMetadata> = None;
    for url in prm_candidates {
        if let Ok(resp) = client.get(&url).send().await
            && resp.status().is_success()
            && let Ok(meta) = resp.json::<ProtectedResourceMetadata>().await
        {
            if let Some(ref res_str) = meta.resource
                && !check_resource_allowed(&server_url, res_str)
            {
                return Err(format!(
                    "Protected resource metadata mismatch: {res_str} is not allowed for {remote_url}"
                ));
            }
            prm = Some(meta);
            break;
        }
    }

    let resource = configured_resource
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .or_else(|| prm.as_ref().and_then(|m| m.resource.clone()))
        .unwrap_or_else(|| remote_url.to_owned());

    let default_scope = prm
        .as_ref()
        .and_then(|m| m.scopes_supported.as_ref())
        .filter(|s| !s.is_empty())
        .map(|s| s.join(" "));

    let issuer_str = prm
        .as_ref()
        .and_then(|m| m.authorization_servers.as_ref())
        .and_then(|v| v.first())
        .cloned()
        .unwrap_or_else(|| origin.clone());

    let issuer_url =
        Url::parse(&issuer_str).map_err(|e| format!("Invalid authorization server URL: {e}"))?;
    let issuer_origin = format!(
        "{}://{}{}",
        issuer_url.scheme(),
        issuer_url.host_str().unwrap_or("127.0.0.1"),
        match issuer_url.port() {
            Some(p) => format!(":{p}"),
            None => String::new(),
        }
    );
    let issuer_path = issuer_url.path().trim_end_matches('/');

    // RFC 8414 + OIDC discovery probes (path-aware first, then root)
    let mut as_candidates = Vec::new();
    if !issuer_path.is_empty() {
        as_candidates.push(format!(
            "{issuer_origin}/.well-known/oauth-authorization-server{issuer_path}"
        ));
        as_candidates.push(format!(
            "{issuer_origin}/.well-known/openid-configuration{issuer_path}"
        ));
        as_candidates.push(format!(
            "{issuer_origin}{issuer_path}/.well-known/openid-configuration"
        ));
    }
    as_candidates.push(format!(
        "{issuer_origin}/.well-known/oauth-authorization-server"
    ));
    as_candidates.push(format!("{issuer_origin}/.well-known/openid-configuration"));

    for url in as_candidates {
        if let Ok(resp) = client.get(&url).send().await
            && resp.status().is_success()
            && let Ok(meta) = resp.json::<AuthServerMetadata>().await
            && let (Some(auth_ep), Some(tok_ep)) =
                (meta.authorization_endpoint, meta.token_endpoint)
        {
            return Ok(DiscoveredOAuthEndpoints {
                issuer: meta.issuer.unwrap_or_else(|| issuer_str.clone()),
                authorization_endpoint: auth_ep,
                token_endpoint: tok_ep,
                registration_endpoint: meta.registration_endpoint,
                resource,
                default_scope,
            });
        }
    }

    // Fallback to standard `/authorize` + `/token` relative to issuer
    let base = issuer_str.trim_end_matches('/');
    Ok(DiscoveredOAuthEndpoints {
        issuer: issuer_str.clone(),
        authorization_endpoint: format!("{base}/authorize"),
        token_endpoint: format!("{base}/token"),
        registration_endpoint: None,
        resource,
        default_scope,
    })
}

fn random_base64url(num_bytes: usize) -> String {
    let mut buf = vec![0u8; num_bytes];
    rand::rng().fill_bytes(&mut buf);
    data_encoding::BASE64URL_NOPAD.encode(&buf)
}

fn pkce_s256_challenge(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    data_encoding::BASE64URL_NOPAD.encode(&digest)
}

async fn spawn_loopback_callback_server(
    expected_state: String,
) -> Result<(u16, Arc<Mutex<Option<String>>>, oneshot::Sender<()>), String> {
    let v4_listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Failed to bind OAuth loopback listener: {e}"))?;
    let port = v4_listener.local_addr().map_err(|e| e.to_string())?.port();
    let v6_listener = TcpListener::bind(format!("[::1]:{port}")).await.ok();

    let captured_code: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let (shutdown_tx, mut shutdown_rx) = oneshot::channel::<()>();

    let captured_for_route = Arc::clone(&captured_code);
    let app = Router::new().route(
        "/oauth/callback",
        get(move |Query(params): Query<HashMap<String, String>>| {
            let captured = Arc::clone(&captured_for_route);
            let exp_state = expected_state.clone();
            async move {
                if params.get("state").map(String::as_str) != Some(exp_state.as_str()) {
                    return (
                        StatusCode::BAD_REQUEST,
                        Html("<html><body><h2>Invalid OAuth state.</h2></body></html>".to_owned()),
                    );
                }
                let Some(code) = params.get("code").cloned().filter(|c| !c.trim().is_empty()) else {
                    return (
                        StatusCode::BAD_REQUEST,
                        Html("<html><body><h2>Missing authorization code.</h2></body></html>".to_owned()),
                    );
                };
                *captured.lock() = Some(code);
                (
                    StatusCode::OK,
                    Html("<html><body><h2>Authorization complete. You may close this tab and return to Cowork.</h2></body></html>".to_owned()),
                )
            }
        }),
    );

    let app_v6 = app.clone();
    tokio::spawn(async move {
        let v4_fut = axum::serve(v4_listener, app);
        if let Some(v6) = v6_listener {
            let v6_fut = axum::serve(v6, app_v6);
            tokio::select! {
                _ = v4_fut => {},
                _ = v6_fut => {},
                _ = &mut shutdown_rx => {},
                _ = tokio::time::sleep(Duration::from_millis(PENDING_OAUTH_TTL_MS)) => {},
            }
        } else {
            tokio::select! {
                _ = v4_fut => {},
                _ = &mut shutdown_rx => {},
                _ = tokio::time::sleep(Duration::from_millis(PENDING_OAUTH_TTL_MS)) => {},
            }
        }
    });

    Ok((port, captured_code, shutdown_tx))
}

/// Starts an RFC 9728 / RFC 8414 / RFC 7591 OAuth 2.1 PKCE S256 authorization flow.
pub async fn start_mcp_oauth_authorization(
    config: &AgentConfig,
    name: &str,
    source: Option<McpConfigSource>,
    plugin_id: Option<&str>,
    plugin_scope: Option<&str>,
) -> Result<McpOAuthChallengeResult, String> {
    let resolved = resolve_target_mcp_server(config, name, source, plugin_id, plugin_scope)?;
    let Some(remote_url) = resolved.config.transport.remote_url().map(str::to_owned) else {
        return Err(format!(
            "MCP server \"{}\" does not use an HTTP/SSE transport.",
            resolved.config.name
        ));
    };

    let (configured_scope, configured_resource, oauth_mode) = match resolved.config.auth.as_ref() {
        Some(McpServerAuthConfig::OAuth {
            scope,
            resource,
            oauth_mode,
        }) => (
            scope.clone(),
            resource.clone(),
            oauth_mode.as_deref().unwrap_or("auto").to_owned(),
        ),
        _ => (None, None, "auto".to_owned()),
    };

    let http_client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let endpoints =
        discover_oauth_endpoints(&http_client, &remote_url, configured_resource.as_deref()).await?;

    let verifier = random_base64url(48); // 64 base64url chars (RFC 7636 43..=128)
    let challenge = pkce_s256_challenge(&verifier);
    let state = random_base64url(24);
    let expires_at = now_epoch_ms() + PENDING_OAUTH_TTL_MS;

    let cred_path = crate::credentials::credentials_path_for_scope(config, resolved.auth_scope);
    let map_key = listener_map_key(&cred_path, &resolved.config.name);

    // Tear down any previous pending listener for this server
    if let Some((_, mut prev)) = CALLBACK_LISTENERS.remove(&map_key)
        && let Some(tx) = prev.shutdown_tx.take()
    {
        let _ = tx.send(());
    }

    let (redirect_uri, instructions) = if oauth_mode == "code" {
        (
            "urn:ietf:wg:oauth:2.0:oob".to_owned(),
            "Open the authorization URL, approve access, and paste the returned authorization code."
                .to_owned(),
        )
    } else {
        let (port, captured, shutdown_tx) = spawn_loopback_callback_server(state.clone()).await?;
        CALLBACK_LISTENERS.insert(
            map_key,
            ActiveCallbackListener {
                captured_code: captured,
                shutdown_tx: Some(shutdown_tx),
                expires_at,
            },
        );
        (
            format!("http://127.0.0.1:{port}/oauth/callback"),
            "Open the authorization URL in your browser to finish signing in.".to_owned(),
        )
    };

    let cred_key = credential_key_for_server(&resolved.config.name, resolved.config.auth.as_ref());
    let existing_creds = read_credentials_file(&cred_path);
    let existing_client = existing_creds
        .servers
        .get(&cred_key)
        .and_then(|s| s.oauth.as_ref())
        .and_then(|o| o.client_info.clone())
        .filter(|c| {
            c.redirect_uris
                .as_ref()
                .is_some_and(|uris| uris.contains(&redirect_uri))
        });

    let client_info = if let Some(reused) = existing_client {
        reused
    } else if let Some(reg_ep) = endpoints.registration_endpoint.as_ref() {
        let reg_resp = http_client
            .post(reg_ep)
            .json(&json!({
                "client_name": "Cowork",
                "redirect_uris": [redirect_uri],
                "grant_types": ["authorization_code", "refresh_token"],
                "response_types": ["code"],
                "token_endpoint_auth_method": "none"
            }))
            .send()
            .await
            .map_err(|e| format!("OAuth dynamic client registration failed: {e}"))?;
        if !reg_resp.status().is_success() {
            return Err(format!(
                "OAuth dynamic client registration failed with HTTP {}",
                reg_resp.status()
            ));
        }
        let body: Value = reg_resp.json().await.map_err(|e| e.to_string())?;
        let cid = body
            .get("client_id")
            .and_then(Value::as_str)
            .ok_or_else(|| "Dynamic client registration response missing client_id".to_owned())?
            .to_owned();
        StoredOAuthClientInfo {
            client_id: cid,
            client_secret: body
                .get("client_secret")
                .and_then(Value::as_str)
                .map(str::to_owned),
            token_endpoint_auth_method: body
                .get("token_endpoint_auth_method")
                .and_then(Value::as_str)
                .map(str::to_owned),
            redirect_uris: Some(vec![redirect_uri.clone()]),
        }
    } else {
        StoredOAuthClientInfo {
            client_id: "cowork-mcp-client".to_owned(),
            client_secret: None,
            token_endpoint_auth_method: Some("none".to_owned()),
            redirect_uris: Some(vec![redirect_uri.clone()]),
        }
    };

    let mut auth_url = Url::parse(&endpoints.authorization_endpoint)
        .map_err(|e| format!("Invalid authorization_endpoint: {e}"))?;
    {
        let mut qp = auth_url.query_pairs_mut();
        qp.append_pair("response_type", "code");
        qp.append_pair("client_id", &client_info.client_id);
        qp.append_pair("redirect_uri", &redirect_uri);
        qp.append_pair("code_challenge", &challenge);
        qp.append_pair("code_challenge_method", "S256");
        qp.append_pair("state", &state);
        qp.append_pair("resource", &endpoints.resource);
        qp.append_pair("prompt", "consent");
        if let Some(sc) = configured_scope
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .or(endpoints.default_scope.as_deref())
        {
            qp.append_pair("scope", sc);
        }
    }

    let pending = StoredPendingOAuthFlow {
        state,
        code_verifier: verifier,
        redirect_uri,
        authorization_endpoint: endpoints.authorization_endpoint,
        token_endpoint: endpoints.token_endpoint,
        resource: Some(endpoints.resource),
        expires_at,
    };

    mutate_credentials_for_scope(config, resolved.auth_scope, |store| {
        let entry = store.servers.entry(cred_key).or_default();
        let oauth = entry.oauth.get_or_insert_with(Default::default);
        oauth.client_info = Some(client_info);
        oauth.pending = Some(pending);
        oauth.discovery_issuer = Some(endpoints.issuer);
        oauth.updated_at = now_epoch_ms();
    })?;

    let url_str: String = auth_url.into();
    let expires_iso =
        chrono::DateTime::from_timestamp_millis(expires_at as i64).map(|dt| dt.to_rfc3339());
    let method_str = if oauth_mode == "code" {
        "code".to_owned()
    } else {
        "auto".to_owned()
    };

    Ok(McpOAuthChallengeResult {
        name: resolved.config.name,
        source: resolved.source,
        url: url_str.clone(),
        instructions: instructions.clone(),
        expires_at,
        challenge: McpOAuthChallengePayload {
            method: method_str,
            instructions,
            url: Some(url_str),
            expires_at: expires_iso,
        },
    })
}

/// Completes a pending OAuth 2.1 PKCE callback using either a manual `code` (or callback URL)
/// or the authorization code captured by the local loopback callback listener.
pub async fn complete_mcp_oauth_callback(
    config: &AgentConfig,
    name: &str,
    source: Option<McpConfigSource>,
    plugin_id: Option<&str>,
    plugin_scope: Option<&str>,
    provided_code: Option<&str>,
) -> Result<McpAuthMutationResult, String> {
    let resolved = resolve_target_mcp_server(config, name, source, plugin_id, plugin_scope)?;
    let cred_path = crate::credentials::credentials_path_for_scope(config, resolved.auth_scope);
    let cred_key = credential_key_for_server(&resolved.config.name, resolved.config.auth.as_ref());
    let map_key = listener_map_key(&cred_path, &resolved.config.name);

    let store = read_credentials_file(&cred_path);
    let oauth_entry = store
        .servers
        .get(&cred_key)
        .and_then(|s| s.oauth.clone())
        .ok_or_else(|| format!("No pending OAuth flow for \"{}\".", resolved.config.name))?;
    let pending = oauth_entry.pending.ok_or_else(|| {
        format!(
            "No pending OAuth challenge for \"{}\".",
            resolved.config.name
        )
    })?;
    if now_epoch_ms() > pending.expires_at {
        return Err(format!(
            "OAuth challenge for \"{}\" has expired.",
            resolved.config.name
        ));
    }
    let client_info = oauth_entry
        .client_info
        .ok_or_else(|| "Missing OAuth client registration metadata.".to_owned())?;

    // Resolve code from explicit argument (supports raw code or full callback URL) or loopback listener
    let auth_code = if let Some(raw_input) = provided_code.map(str::trim).filter(|s| !s.is_empty())
    {
        if let Ok(cb_url) = Url::parse(raw_input) {
            let qp: HashMap<String, String> = cb_url.query_pairs().into_owned().collect();
            if let Some(st) = qp.get("state")
                && st != &pending.state
            {
                return Err("OAuth callback state mismatch.".to_owned());
            }
            qp.get("code")
                .cloned()
                .ok_or_else(|| "Callback URL did not contain a code query parameter.".to_owned())?
        } else {
            raw_input.to_owned()
        }
    } else {
        // Poll briefly (up to 2s at 50ms intervals) if browser redirect just arrived
        let mut captured = None;
        for _ in 0..40 {
            if let Some(listener) = CALLBACK_LISTENERS.get(&map_key) {
                if listener.expires_at < now_epoch_ms() {
                    break;
                }
                if let Some(c) = listener.captured_code.lock().clone() {
                    captured = Some(c);
                    break;
                }
            } else {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        captured.ok_or_else(|| {
            "Authorization code has not been received yet; complete sign-in in your browser first."
                .to_owned()
        })?
    };

    if let Some((_, mut listener)) = CALLBACK_LISTENERS.remove(&map_key)
        && let Some(tx) = listener.shutdown_tx.take()
    {
        let _ = tx.send(());
    }

    let http_client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let mut form = vec![
        ("grant_type".to_owned(), "authorization_code".to_owned()),
        ("code".to_owned(), auth_code),
        ("redirect_uri".to_owned(), pending.redirect_uri),
        ("client_id".to_owned(), client_info.client_id.clone()),
        ("code_verifier".to_owned(), pending.code_verifier),
    ];
    if let Some(secret) = client_info.client_secret.as_ref() {
        form.push(("client_secret".to_owned(), secret.clone()));
    }
    if let Some(res) = pending.resource.as_ref() {
        form.push(("resource".to_owned(), res.clone()));
    }

    let encoded_form: String = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(form.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .finish();

    let tok_resp = http_client
        .post(&pending.token_endpoint)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(encoded_form)
        .send()
        .await
        .map_err(|e| format!("OAuth token exchange failed: {e}"))?;
    if !tok_resp.status().is_success() {
        let status = tok_resp.status();
        let body_txt = tok_resp.text().await.unwrap_or_default();
        return Err(format!(
            "OAuth token exchange failed ({status}): {body_txt}"
        ));
    }

    let tok_json: Value = tok_resp.json().await.map_err(|e| e.to_string())?;
    let access_token = tok_json
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or_else(|| "OAuth token response missing access_token".to_owned())?
        .to_owned();
    let expires_at = tok_json
        .get("expires_in")
        .and_then(Value::as_u64)
        .map(|secs| now_epoch_ms() + secs.saturating_mul(1_000));

    let tokens = StoredOAuthTokens {
        access_token,
        token_type: tok_json
            .get("token_type")
            .and_then(Value::as_str)
            .map(str::to_owned),
        refresh_token: tok_json
            .get("refresh_token")
            .and_then(Value::as_str)
            .map(str::to_owned),
        expires_at,
        scope: tok_json
            .get("scope")
            .and_then(Value::as_str)
            .map(str::to_owned),
    };

    mutate_credentials_for_scope(config, resolved.auth_scope, |store| {
        let entry = store.servers.entry(cred_key).or_default();
        let oauth = entry.oauth.get_or_insert_with(Default::default);
        oauth.tokens = Some(tokens);
        oauth.pending = None;
        oauth.updated_at = now_epoch_ms();
    })?;

    Ok(McpAuthMutationResult {
        name: resolved.config.name,
        source: resolved.source,
        mode: McpAuthMode::OAuth,
        ok: true,
        message: "OAuth authorization completed.".to_owned(),
    })
}

/// Refreshes an OAuth access token on runtime `401`/`403` and persists rotated tokens (`0600`),
/// preserving the existing `refresh_token` if the authorization server omits a new one.
pub async fn refresh_oauth_access_token(ctx: &McpOAuthRuntimeContext) -> Result<String, String> {
    let store = read_credentials_file(&ctx.credentials_path);
    let oauth_entry = store
        .servers
        .get(&ctx.server_name)
        .and_then(|s| s.oauth.clone())
        .ok_or_else(|| format!("No stored OAuth state for \"{}\".", ctx.server_name))?;
    let prev_tokens = oauth_entry
        .tokens
        .ok_or_else(|| format!("No stored OAuth tokens for \"{}\".", ctx.server_name))?;
    let refresh_token = prev_tokens.refresh_token.clone().ok_or_else(|| {
        format!(
            "OAuth token expired for \"{}\" and no refresh_token is available.",
            ctx.server_name
        )
    })?;
    let client_info = oauth_entry
        .client_info
        .unwrap_or_else(|| StoredOAuthClientInfo {
            client_id: "cowork-mcp-client".to_owned(),
            client_secret: None,
            token_endpoint_auth_method: Some("none".to_owned()),
            redirect_uris: None,
        });

    let http_client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let endpoints = discover_oauth_endpoints(
        &http_client,
        &ctx.remote_url,
        ctx.configured_resource.as_deref(),
    )
    .await?;

    let mut form = vec![
        ("grant_type".to_owned(), "refresh_token".to_owned()),
        ("refresh_token".to_owned(), refresh_token.clone()),
        ("client_id".to_owned(), client_info.client_id.clone()),
    ];
    if let Some(secret) = client_info.client_secret.as_ref() {
        form.push(("client_secret".to_owned(), secret.clone()));
    }
    if let Some(res) = ctx.configured_resource.as_ref() {
        form.push(("resource".to_owned(), res.clone()));
    }

    let encoded_form: String = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(form.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .finish();

    let resp = http_client
        .post(&endpoints.token_endpoint)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(encoded_form)
        .send()
        .await
        .map_err(|e| format!("OAuth token refresh failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "OAuth token refresh failed with HTTP {}",
            resp.status()
        ));
    }

    let tok_json: Value = resp.json().await.map_err(|e| e.to_string())?;
    let new_access_token = tok_json
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or_else(|| "OAuth refresh response missing access_token".to_owned())?
        .to_owned();
    let expires_at = tok_json
        .get("expires_in")
        .and_then(Value::as_u64)
        .map(|secs| now_epoch_ms() + secs.saturating_mul(1_000));
    let next_refresh_token = tok_json
        .get("refresh_token")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or(Some(refresh_token));

    let server_key = ctx.server_name.clone();
    let new_access_clone = new_access_token.clone();
    mutate_credentials_file(&ctx.lock_root, &ctx.credentials_path, move |file| {
        let entry = file.servers.entry(server_key).or_default();
        let oauth = entry.oauth.get_or_insert_with(Default::default);
        oauth.tokens = Some(StoredOAuthTokens {
            access_token: new_access_clone,
            token_type: tok_json
                .get("token_type")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or(prev_tokens.token_type),
            refresh_token: next_refresh_token,
            expires_at,
            scope: tok_json
                .get("scope")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or(prev_tokens.scope),
        });
        oauth.updated_at = now_epoch_ms();
    })?;

    Ok(new_access_token)
}
