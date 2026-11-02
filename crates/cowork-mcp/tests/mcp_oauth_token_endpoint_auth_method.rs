//! Token-endpoint client authentication for MCP OAuth (TS parity: the MCP SDK's
//! `selectClientAuthMethod` + `applyClientAuthentication` in `exchangeAuthorization` and
//! `refreshAuthorization`). A client registered for `client_secret_basic` must authenticate with
//! an HTTP Basic `Authorization` header on both the authorization-code exchange and the refresh,
//! never by sending its secret in the request body.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use cowork_config::{LoadConfigOptions, load_config};
use cowork_mcp::{
    McpConfigSource, McpServerAuthConfig, McpServerConfig, McpServerTransport,
    complete_mcp_oauth_callback, start_mcp_oauth_authorization, upsert_mcp_server,
    validate_mcp_server,
};
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio::net::TcpListener;
use uuid::Uuid;

fn test_temp_base() -> PathBuf {
    if cfg!(target_os = "macos") {
        PathBuf::from("/private/tmp")
    } else {
        std::env::temp_dir()
    }
}

/// One request the mock token endpoint received.
#[derive(Debug, Clone)]
struct TokenRequest {
    authorization: Option<String>,
    form: HashMap<String, String>,
}

struct MockAuthServer {
    /// Fields of the dynamic client registration response.
    registration: Value,
    /// `token_endpoint_auth_methods_supported` advertised by the AS metadata (omitted when None).
    supported_methods: Option<Vec<&'static str>>,
    /// What the token endpoint requires: `Some((id, secret))` for HTTP Basic only.
    require_basic: Option<(&'static str, &'static str)>,
    token_requests: Mutex<Vec<TokenRequest>>,
}

/// Runs the full code-mode OAuth flow (DCR -> authorization-code exchange) and then a runtime
/// refresh (the protected MCP endpoint rejects the first token with 401), returning every request
/// the token endpoint saw.
async fn run_flow(server: MockAuthServer) -> Vec<TokenRequest> {
    let base = test_temp_base().join(format!("cowork-mcp-auth-method-{}", Uuid::new_v4()));
    let home = base.join("home");
    let ws = base.join("ws");
    let builtin = base.join("builtin");
    fs::create_dir_all(home.join(".cowork/config")).unwrap();
    fs::create_dir_all(ws.join(".cowork")).unwrap();
    fs::create_dir_all(builtin.join("config")).unwrap();
    fs::write(
        builtin.join("config/mcp-servers.json"),
        "{\n  \"servers\": []\n}\n",
    )
    .unwrap();

    let state = Arc::new(server);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let b = base_url.clone();

    let app = Router::new()
        .route(
            "/.well-known/oauth-protected-resource/mcp",
            get({
                let b = b.clone();
                move || {
                    let b = b.clone();
                    async move {
                        axum::Json(json!({
                            "resource": format!("{b}/mcp"),
                            "authorization_servers": [format!("{b}/issuer")]
                        }))
                    }
                }
            }),
        )
        .route(
            "/.well-known/oauth-authorization-server/issuer",
            get({
                let b = b.clone();
                move |State(st): State<Arc<MockAuthServer>>| {
                    let b = b.clone();
                    async move {
                        let mut meta = json!({
                            "issuer": format!("{b}/issuer"),
                            "authorization_endpoint": format!("{b}/issuer/authorize"),
                            "token_endpoint": format!("{b}/issuer/token"),
                            "registration_endpoint": format!("{b}/issuer/register"),
                            "code_challenge_methods_supported": ["S256"]
                        });
                        if let Some(methods) = &st.supported_methods {
                            meta["token_endpoint_auth_methods_supported"] = json!(methods);
                        }
                        axum::Json(meta)
                    }
                }
            }),
        )
        .route(
            "/issuer/register",
            post(
                |State(st): State<Arc<MockAuthServer>>, axum::Json(payload): axum::Json<Value>| async move {
                    let mut body = st.registration.clone();
                    body["redirect_uris"] = payload["redirect_uris"].clone();
                    (StatusCode::CREATED, axum::Json(body))
                },
            ),
        )
        .route(
            "/issuer/token",
            post(
                |State(st): State<Arc<MockAuthServer>>,
                 headers: HeaderMap,
                 axum::Form(form): axum::Form<HashMap<String, String>>| async move {
                    let authorization = headers
                        .get("authorization")
                        .and_then(|v| v.to_str().ok())
                        .map(str::to_owned);
                    st.token_requests.lock().push(TokenRequest {
                        authorization: authorization.clone(),
                        form: form.clone(),
                    });
                    if let Some((id, secret)) = st.require_basic {
                        let expected = format!(
                            "Basic {}",
                            data_encoding::BASE64.encode(format!("{id}:{secret}").as_bytes())
                        );
                        // A Basic-only server rejects body credentials as `invalid_client`.
                        if authorization.as_deref() != Some(expected.as_str())
                            || form.contains_key("client_secret")
                        {
                            return (
                                StatusCode::UNAUTHORIZED,
                                axum::Json(json!({ "error": "invalid_client" })),
                            )
                                .into_response();
                        }
                    }
                    match form.get("grant_type").map(String::as_str) {
                        Some("authorization_code") => axum::Json(json!({
                            "access_token": "initial-token",
                            "token_type": "Bearer",
                            "expires_in": 3600,
                            "refresh_token": "refresh-tok"
                        }))
                        .into_response(),
                        Some("refresh_token") => axum::Json(json!({
                            "access_token": "fresh-token",
                            "token_type": "Bearer",
                            "expires_in": 3600
                        }))
                        .into_response(),
                        _ => StatusCode::BAD_REQUEST.into_response(),
                    }
                },
            ),
        )
        .route(
            "/mcp",
            post({
                let b = b.clone();
                move |headers: HeaderMap, body: String| {
                    let b = b.clone();
                    async move {
                        let auth = headers
                            .get("authorization")
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or("");
                        if auth != "Bearer fresh-token" {
                            return Response::builder()
                                .status(StatusCode::UNAUTHORIZED)
                                .header(
                                    "www-authenticate",
                                    format!(
                                        "Bearer resource_metadata=\"{b}/.well-known/oauth-protected-resource/mcp\""
                                    ),
                                )
                                .body(Body::from("unauthorized"))
                                .unwrap();
                        }
                        let msg: Value = serde_json::from_str(&body).unwrap();
                        if msg.get("id").is_none() {
                            return StatusCode::ACCEPTED.into_response();
                        }
                        let id = msg["id"].clone();
                        match msg["method"].as_str().unwrap_or("") {
                            "initialize" => axum::Json(json!({
                                "jsonrpc": "2.0",
                                "id": id,
                                "result": {
                                    "protocolVersion": "2025-11-25",
                                    "capabilities": { "tools": {} },
                                    "serverInfo": { "name": "oauth-mcp", "version": "1.0.0" }
                                }
                            }))
                            .into_response(),
                            "tools/list" => axum::Json(json!({
                                "jsonrpc": "2.0",
                                "id": id,
                                "result": { "tools": [] }
                            }))
                            .into_response(),
                            _ => StatusCode::BAD_REQUEST.into_response(),
                        }
                    }
                }
            }),
        )
        .with_state(Arc::clone(&state));
    let srv_task = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    let mut env = HashMap::new();
    env.insert("HOME".to_owned(), home.to_string_lossy().into_owned());
    env.insert(
        "COWORK_HOME_OVERRIDE".to_owned(),
        home.join(".cowork").to_string_lossy().into_owned(),
    );
    env.insert("COWORK_DISABLE_RUNTIME".to_owned(), "1".to_owned());
    env.insert("COWORK_RUNTIME_ALLOW_NETWORK".to_owned(), "0".to_owned());
    env.insert("AGENT_TRUST_WORKSPACE_MCP".to_owned(), "1".to_owned());
    let cfg = load_config(LoadConfigOptions {
        cwd: Some(ws.clone()),
        homedir: Some(home.clone()),
        built_in_dir: Some(builtin),
        env: Some(env),
    })
    .unwrap();

    upsert_mcp_server(
        &cfg,
        McpConfigSource::Workspace,
        McpServerConfig {
            name: "oauth-srv".to_owned(),
            transport: McpServerTransport::Http {
                url: format!("{base_url}/mcp"),
                headers: None,
            },
            enabled: Some(true),
            required: None,
            retries: Some(0),
            auth: Some(McpServerAuthConfig::OAuth {
                scope: None,
                resource: None,
                oauth_mode: Some("code".to_owned()),
            }),
            icon: None,
        },
        None,
    )
    .unwrap();

    start_mcp_oauth_authorization(
        &cfg,
        "oauth-srv",
        Some(McpConfigSource::Workspace),
        None,
        None,
    )
    .await
    .unwrap();
    let completed = complete_mcp_oauth_callback(
        &cfg,
        "oauth-srv",
        Some(McpConfigSource::Workspace),
        None,
        None,
        Some("auth-code-1"),
    )
    .await;
    let after_exchange = state.token_requests.lock().clone();
    completed.unwrap_or_else(|err| {
        panic!("authorization-code exchange failed: {err}; requests={after_exchange:?}")
    });

    let validation = validate_mcp_server(
        &cfg,
        "oauth-srv",
        Some(McpConfigSource::Workspace),
        None,
        None,
    )
    .await
    .unwrap();
    let requests = state.token_requests.lock().clone();
    assert!(
        validation.ok,
        "validation (refresh) failed: {:?}; requests={requests:?}",
        validation.message
    );

    srv_task.abort();
    let _ = fs::remove_dir_all(&base);
    requests
}

fn grant(req: &TokenRequest) -> &str {
    req.form.get("grant_type").map(String::as_str).unwrap_or("")
}

#[tokio::test]
async fn client_secret_basic_client_uses_http_basic_for_code_exchange_and_refresh() {
    let requests = run_flow(MockAuthServer {
        registration: json!({
            "client_id": "conf-client",
            "client_secret": "s3cr3t",
            "token_endpoint_auth_method": "client_secret_basic"
        }),
        supported_methods: Some(vec!["client_secret_basic", "client_secret_post"]),
        require_basic: Some(("conf-client", "s3cr3t")),
        token_requests: Mutex::new(Vec::new()),
    })
    .await;

    assert_eq!(
        requests.iter().map(grant).collect::<Vec<_>>(),
        ["authorization_code", "refresh_token"],
        "{requests:?}"
    );
    let expected = format!(
        "Basic {}",
        data_encoding::BASE64.encode(b"conf-client:s3cr3t")
    );
    for req in &requests {
        assert_eq!(
            req.authorization.as_deref(),
            Some(expected.as_str()),
            "{req:?}"
        );
        assert!(!req.form.contains_key("client_secret"), "{req:?}");
        // SDK `applyBasicAuth` carries the client id only in the header.
        assert!(!req.form.contains_key("client_id"), "{req:?}");
    }
}

/// RFC 8414 §2: metadata that omits `token_endpoint_auth_methods_supported` defaults to
/// `client_secret_basic`, so a confidential client with no registered method uses Basic too.
#[tokio::test]
async fn confidential_client_without_advertised_methods_defaults_to_http_basic() {
    let requests = run_flow(MockAuthServer {
        registration: json!({ "client_id": "conf-client", "client_secret": "s3cr3t" }),
        supported_methods: None,
        require_basic: Some(("conf-client", "s3cr3t")),
        token_requests: Mutex::new(Vec::new()),
    })
    .await;
    assert_eq!(requests.len(), 2, "{requests:?}");
}

#[tokio::test]
async fn client_secret_post_client_sends_credentials_in_the_body() {
    let requests = run_flow(MockAuthServer {
        registration: json!({
            "client_id": "post-client",
            "client_secret": "p0st",
            "token_endpoint_auth_method": "client_secret_post"
        }),
        supported_methods: Some(vec!["client_secret_basic", "client_secret_post"]),
        require_basic: None,
        token_requests: Mutex::new(Vec::new()),
    })
    .await;

    assert_eq!(requests.len(), 2, "{requests:?}");
    for req in &requests {
        assert_eq!(req.authorization, None, "{req:?}");
        assert_eq!(
            req.form.get("client_id").map(String::as_str),
            Some("post-client")
        );
        assert_eq!(
            req.form.get("client_secret").map(String::as_str),
            Some("p0st")
        );
    }
}

#[tokio::test]
async fn public_client_sends_only_its_client_id() {
    let requests = run_flow(MockAuthServer {
        registration: json!({
            "client_id": "public-client",
            "token_endpoint_auth_method": "none"
        }),
        supported_methods: Some(vec!["none"]),
        require_basic: None,
        token_requests: Mutex::new(Vec::new()),
    })
    .await;

    assert_eq!(requests.len(), 2, "{requests:?}");
    for req in &requests {
        assert_eq!(req.authorization, None, "{req:?}");
        assert_eq!(
            req.form.get("client_id").map(String::as_str),
            Some("public-client")
        );
        assert!(!req.form.contains_key("client_secret"), "{req:?}");
    }
}
