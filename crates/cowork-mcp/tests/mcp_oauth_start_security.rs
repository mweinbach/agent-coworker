//! MCP OAuth start/callback hardening:
//!
//! * `auto` mode launches the browser server-side (TS `authorizeMCPServerOAuth` called
//!   `openExternalUrl(url)`), since Desktop neither opens nor renders the challenge URL.
//! * Authorization-server metadata endpoints (`authorization_endpoint`, `token_endpoint`,
//!   `registration_endpoint`) and a stored pending `token_endpoint` must be `https://` or
//!   loopback `http://`.
//! * Workspace-owned servers are gated on `trustWorkspaceMcp`.
//! * A manually pasted callback URL must carry the pending `state`; only `http(s)://` input is
//!   parsed as a callback URL (a raw code like `ac:1234` is a code).

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use axum::Router;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use cowork_config::{AgentConfig, LoadConfigOptions, load_config};
use cowork_mcp::{
    McpAuthScope, McpConfigSource, McpOAuthUrlOpener, McpServerAuthConfig, McpServerConfig,
    McpServerTransport, complete_mcp_oauth_callback, credentials_path_for_scope,
    mutate_credentials_for_scope, start_mcp_oauth_authorization_with_opener, upsert_mcp_server,
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

#[derive(Default)]
struct RecordingOpener {
    opened: Mutex<Vec<String>>,
    fail: AtomicBool,
}

#[async_trait::async_trait]
impl McpOAuthUrlOpener for RecordingOpener {
    async fn open_url(&self, url: &str) -> bool {
        self.opened.lock().push(url.to_owned());
        !self.fail.load(Ordering::SeqCst)
    }
}

struct MockAs {
    metadata: Mutex<Value>,
    token_codes: Mutex<Vec<String>>,
}

struct Fixture {
    base: PathBuf,
    base_url: String,
    state: Arc<MockAs>,
    server: tokio::task::JoinHandle<()>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
        let _ = fs::remove_dir_all(&self.base);
    }
}

impl Fixture {
    async fn new() -> Self {
        let base = test_temp_base().join(format!("cowork-mcp-oauth-sec-{}", Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let state = Arc::new(MockAs {
            metadata: Mutex::new(json!({
                "issuer": base_url,
                "authorization_endpoint": format!("{base_url}/authorize"),
                "token_endpoint": format!("{base_url}/token"),
                "registration_endpoint": format!("{base_url}/register"),
            })),
            token_codes: Mutex::new(Vec::new()),
        });
        let app = Router::new()
            .route(
                "/.well-known/oauth-authorization-server",
                get(|State(st): State<Arc<MockAs>>| async move {
                    axum::Json(st.metadata.lock().clone())
                }),
            )
            .route(
                "/register",
                post(|axum::Json(payload): axum::Json<Value>| async move {
                    (
                        StatusCode::CREATED,
                        axum::Json(json!({
                            "client_id": "dyn-client",
                            "token_endpoint_auth_method": "none",
                            "redirect_uris": payload["redirect_uris"],
                        })),
                    )
                }),
            )
            .route(
                "/token",
                post(
                    |State(st): State<Arc<MockAs>>,
                     axum::Form(form): axum::Form<HashMap<String, String>>| async move {
                        st.token_codes
                            .lock()
                            .push(form.get("code").cloned().unwrap_or_default());
                        axum::Json(json!({
                            "access_token": "tok",
                            "token_type": "Bearer",
                            "expires_in": 3600
                        }))
                    },
                ),
            )
            .route(
                "/mcp",
                post(|| async { StatusCode::UNAUTHORIZED.into_response() }),
            )
            .with_state(Arc::clone(&state));
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Self {
            base,
            base_url,
            state,
            server,
        }
    }

    fn config(&self, trust_workspace: bool) -> AgentConfig {
        let home = self.base.join("home");
        let ws = self.base.join("ws");
        let builtin = self.base.join("builtin");
        fs::create_dir_all(home.join(".cowork/config")).unwrap();
        fs::create_dir_all(ws.join(".cowork")).unwrap();
        fs::create_dir_all(builtin.join("config")).unwrap();
        fs::write(
            builtin.join("config/mcp-servers.json"),
            "{\"servers\":[]}\n",
        )
        .unwrap();
        let mut env = HashMap::new();
        env.insert("HOME".to_owned(), home.to_string_lossy().into_owned());
        env.insert(
            "COWORK_HOME_OVERRIDE".to_owned(),
            home.join(".cowork").to_string_lossy().into_owned(),
        );
        env.insert("COWORK_DISABLE_RUNTIME".to_owned(), "1".to_owned());
        env.insert("COWORK_RUNTIME_ALLOW_NETWORK".to_owned(), "0".to_owned());
        if trust_workspace {
            env.insert("AGENT_TRUST_WORKSPACE_MCP".to_owned(), "1".to_owned());
        }
        load_config(LoadConfigOptions {
            cwd: Some(ws),
            homedir: Some(home),
            built_in_dir: Some(builtin),
            env: Some(env),
        })
        .unwrap()
    }

    fn add_server(&self, cfg: &AgentConfig, source: McpConfigSource, mode: &str) {
        upsert_mcp_server(
            cfg,
            source,
            McpServerConfig {
                name: "oauth-srv".to_owned(),
                transport: McpServerTransport::Http {
                    url: format!("{}/mcp", self.base_url),
                    headers: None,
                },
                enabled: None,
                required: None,
                retries: Some(0),
                auth: Some(McpServerAuthConfig::OAuth {
                    scope: None,
                    resource: None,
                    oauth_mode: Some(mode.to_owned()),
                }),
                icon: None,
            },
            None,
        )
        .unwrap();
    }

    fn set_metadata(&self, key: &str, value: &str) {
        self.state.metadata.lock()[key] = json!(value);
    }
}

async fn start(
    cfg: &AgentConfig,
    source: McpConfigSource,
    opener: &RecordingOpener,
) -> Result<cowork_mcp::McpOAuthChallengeResult, String> {
    start_mcp_oauth_authorization_with_opener(cfg, "oauth-srv", Some(source), None, None, opener)
        .await
}

#[tokio::test]
async fn auto_mode_opens_the_authorization_url_in_the_browser() {
    let fx = Fixture::new().await;
    let cfg = fx.config(false);
    fx.add_server(&cfg, McpConfigSource::User, "auto");

    let opener = RecordingOpener::default();
    let challenge = start(&cfg, McpConfigSource::User, &opener).await.unwrap();
    assert_eq!(challenge.challenge.method, "auto");
    assert_eq!(*opener.opened.lock(), vec![challenge.url.clone()]);
    assert!(
        challenge
            .url
            .starts_with(&format!("{}/authorize?", fx.base_url)),
        "{}",
        challenge.url
    );
    assert_eq!(
        challenge.instructions,
        "Complete sign-in in your browser. If redirect fails, paste the OAuth code manually."
    );

    // A failed launch is reported through the instructions, not as an error.
    let opener = RecordingOpener::default();
    opener.fail.store(true, Ordering::SeqCst);
    let challenge = start(&cfg, McpConfigSource::User, &opener).await.unwrap();
    assert_eq!(opener.opened.lock().len(), 1);
    assert_eq!(
        challenge.instructions,
        "Open the OAuth URL in a browser, then paste the OAuth code manually."
    );
}

#[tokio::test]
async fn code_mode_does_not_open_the_browser() {
    let fx = Fixture::new().await;
    let cfg = fx.config(false);
    fx.add_server(&cfg, McpConfigSource::User, "code");
    let opener = RecordingOpener::default();
    let challenge = start(&cfg, McpConfigSource::User, &opener).await.unwrap();
    assert_eq!(challenge.challenge.method, "code");
    assert!(opener.opened.lock().is_empty());
}

#[tokio::test]
async fn non_https_metadata_endpoints_are_rejected() {
    let cases = [
        ("authorization_endpoint", "javascript:alert(1)"),
        ("authorization_endpoint", "file:///etc/passwd"),
        ("authorization_endpoint", "http://evil.example/authorize"),
        ("token_endpoint", "http://evil.example/token"),
        ("token_endpoint", "ftp://evil.example/token"),
        ("registration_endpoint", "http://evil.example/register"),
        ("registration_endpoint", "data:text/plain,x"),
    ];
    for (key, value) in cases {
        let fx = Fixture::new().await;
        let cfg = fx.config(false);
        fx.add_server(&cfg, McpConfigSource::User, "auto");
        fx.set_metadata(key, value);
        let opener = RecordingOpener::default();
        let err = start(&cfg, McpConfigSource::User, &opener)
            .await
            .expect_err(&format!("{key}={value} must be rejected"));
        assert!(err.contains(key), "{key}={value}: {err}");
        assert!(opener.opened.lock().is_empty(), "{key}={value}");
    }

    // `https://` and loopback `http://` (`localhost`, `127.0.0.0/8`, `::1`) stay accepted.
    let fx = Fixture::new().await;
    let cfg = fx.config(false);
    fx.add_server(&cfg, McpConfigSource::User, "code");
    fx.set_metadata("authorization_endpoint", "https://idp.example/authorize");
    let port = fx.base_url.rsplit(':').next().unwrap().to_owned();
    fx.set_metadata("token_endpoint", &format!("http://localhost:{port}/token"));
    let opener = RecordingOpener::default();
    let challenge = start(&cfg, McpConfigSource::User, &opener).await.unwrap();
    assert!(challenge.url.starts_with("https://idp.example/authorize?"));
}

#[tokio::test]
async fn workspace_server_requires_trust_workspace_mcp() {
    let fx = Fixture::new().await;
    let untrusted = fx.config(false);
    fx.add_server(&untrusted, McpConfigSource::Workspace, "auto");
    let opener = RecordingOpener::default();
    let err = start(&untrusted, McpConfigSource::Workspace, &opener)
        .await
        .unwrap_err();
    assert!(err.contains("untrusted"), "{err}");
    assert!(opener.opened.lock().is_empty());
    assert!(
        !credentials_path_for_scope(&untrusted, McpAuthScope::Workspace).exists(),
        "no pending flow may be stored for an untrusted workspace server"
    );

    let trusted = fx.config(true);
    start(&trusted, McpConfigSource::Workspace, &opener)
        .await
        .unwrap();
    assert_eq!(opener.opened.lock().len(), 1);
}

async fn complete(cfg: &AgentConfig, code: &str) -> Result<(), String> {
    complete_mcp_oauth_callback(
        cfg,
        "oauth-srv",
        Some(McpConfigSource::User),
        None,
        None,
        Some(code),
    )
    .await
    .map(|_| ())
}

#[tokio::test]
async fn manual_callback_requires_matching_state_and_accepts_scheme_like_codes() {
    let fx = Fixture::new().await;
    let cfg = fx.config(false);
    fx.add_server(&cfg, McpConfigSource::User, "code");
    let opener = RecordingOpener::default();
    let challenge = start(&cfg, McpConfigSource::User, &opener).await.unwrap();
    let state = url::Url::parse(&challenge.url)
        .unwrap()
        .query_pairs()
        .find(|(k, _)| k == "state")
        .unwrap()
        .1
        .into_owned();

    // A callback URL without `state` must not skip CSRF validation.
    let err = complete(&cfg, "http://127.0.0.1:1/oauth/callback?code=abc")
        .await
        .unwrap_err();
    assert!(err.contains("state mismatch"), "{err}");
    let err = complete(&cfg, "https://app.example/cb?code=abc&state=wrong")
        .await
        .unwrap_err();
    assert!(err.contains("state mismatch"), "{err}");
    assert!(fx.state.token_codes.lock().is_empty());

    // A raw code that merely looks like `<scheme>:` is a code, not a URL.
    complete(&cfg, "ac:1234").await.unwrap();
    assert_eq!(*fx.state.token_codes.lock(), vec!["ac:1234".to_owned()]);

    // A callback URL with the right state works.
    let challenge = start(&cfg, McpConfigSource::User, &opener).await.unwrap();
    let state2 = url::Url::parse(&challenge.url)
        .unwrap()
        .query_pairs()
        .find(|(k, _)| k == "state")
        .unwrap()
        .1
        .into_owned();
    assert_ne!(state, state2);
    complete(
        &cfg,
        &format!("HTTP://127.0.0.1:1/oauth/callback?code=from-url&state={state2}"),
    )
    .await
    .unwrap();
    assert_eq!(fx.state.token_codes.lock().last().unwrap(), "from-url");
}

#[tokio::test]
async fn stored_pending_token_endpoint_must_be_secure() {
    let fx = Fixture::new().await;
    let cfg = fx.config(false);
    fx.add_server(&cfg, McpConfigSource::User, "code");
    let opener = RecordingOpener::default();
    start(&cfg, McpConfigSource::User, &opener).await.unwrap();
    mutate_credentials_for_scope(&cfg, McpAuthScope::User, |store| {
        let pending = store
            .servers
            .get_mut("oauth-srv")
            .and_then(|s| s.oauth.as_mut())
            .and_then(|o| o.pending.as_mut())
            .unwrap();
        pending.token_endpoint = "http://evil.example/token".to_owned();
    })
    .unwrap();
    let err = complete(&cfg, "code-1").await.unwrap_err();
    assert!(err.contains("token_endpoint"), "{err}");
    assert!(fx.state.token_codes.lock().is_empty());
}
