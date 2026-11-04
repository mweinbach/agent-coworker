//! `mcp_server_auth_result` parity with TS `McpAuthFlow` (`src/server/session/mcp/McpAuthFlow.ts`).
//!
//! * Auto (loopback) OAuth completion broadcasts `mcp_server_auth_result` over
//!   `cowork/control/event` on success (`mode: "oauth"`, before the refreshed `mcp_servers`) and on
//!   a failed token exchange (`ok: false, mode: "error"`, `MCP OAuth callback failed: …`).
//! * `cowork/mcp/server/auth/authorize` and `cowork/mcp/server/auth/callback` report failures as
//!   `mcp_server_auth_result` outcomes (`missing` / `oauth_pending` / `error`) instead of JSON-RPC
//!   errors; only an unknown server stays a JSON-RPC error (TS resolver session error).

use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use axum::Router;
use axum::http::{StatusCode, header};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use cowork_protocol::WEBSOCKET_SUBPROTOCOL;
use cowork_server::{ServerOptions, start_server};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

struct IsolatedServerEnv {
    _root: TempDir,
    home: PathBuf,
    workspace: PathBuf,
    env: HashMap<String, String>,
}

impl IsolatedServerEnv {
    fn new(prefix: &str) -> Self {
        let temp_base = if cfg!(target_os = "macos") {
            PathBuf::from("/private/tmp")
        } else {
            std::env::temp_dir()
        };
        let root = tempfile::Builder::new()
            .prefix(prefix)
            .tempdir_in(temp_base)
            .expect("tempdir in test temp base");
        let base = fs::canonicalize(root.path()).unwrap();
        let home = base.join("home");
        let workspace = base.join("workspace");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&workspace).unwrap();

        let mut env = HashMap::new();
        env.insert("HOME".into(), home.to_string_lossy().into_owned());
        env.insert(
            "COWORK_HOME_OVERRIDE".into(),
            home.join(".cowork").to_string_lossy().into_owned(),
        );
        env.insert(
            "COWORK_ELECTRON_USER_DATA_DIR".into(),
            base.join("electron").to_string_lossy().into_owned(),
        );
        env.insert(
            "COWORK_DESKTOP_USER_DATA_DIR".into(),
            base.join("desktop").to_string_lossy().into_owned(),
        );
        env.insert("COWORK_DISABLE_RUNTIME".into(), "1".into());
        env.insert("COWORK_DISABLE_BROWSER_OPEN".into(), "1".into());
        env.insert("COWORK_RUNTIME_ALLOW_NETWORK".into(), "0".into());
        env.insert("PATH".into(), "/usr/local/bin:/usr/bin:/bin".into());
        Self {
            _root: root,
            home,
            workspace,
            env,
        }
    }

    fn server_options(&self) -> ServerOptions {
        ServerOptions {
            working_directory: self.workspace.clone(),
            host: "127.0.0.1".into(),
            port: 0,
            yolo: true,
            mobile_h3: false,
            mobile_h3_host: "127.0.0.1".into(),
            mobile_h3_port: 0,
            homedir: Some(self.home.clone()),
            built_in_dir: Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")),
            env: self.env.clone(),
        }
    }
}

async fn connect_ready_ws(ws_url: &str) -> WsStream {
    let mut req = ws_url.into_client_request().unwrap();
    req.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        WEBSOCKET_SUBPROTOCOL.parse().unwrap(),
    );
    let (mut ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();
    ws.send(WsMessage::Text(
        json!({
            "id": "init-1",
            "method": "initialize",
            "params": {
                "clientInfo": { "name": "mcp-oauth-auth-result", "version": "1.0.0" },
                "capabilities": { "experimentalApi": true }
            }
        })
        .to_string()
        .into(),
    ))
    .await
    .unwrap();
    let _ = ws.next().await.unwrap().unwrap();
    ws.send(WsMessage::Text(
        json!({ "method": "initialized", "params": {} })
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    ws
}

async fn ws_call_collecting(
    ws: &mut WsStream,
    id: &str,
    method: &str,
    params: Value,
    notifs: &mut Vec<Value>,
) -> Value {
    ws.send(WsMessage::Text(
        json!({ "id": id, "method": method, "params": params })
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(15), ws.next())
            .await
            .expect("ws_call timeout")
            .expect("ws open")
            .expect("ws frame ok");
        if let WsMessage::Text(txt) = frame {
            let val: Value = serde_json::from_str(&txt).unwrap();
            if val.get("id") == Some(&json!(id)) && val.get("method").is_none() {
                return val;
            }
            if val.get("method").is_some() {
                notifs.push(val);
            }
        }
    }
}

async fn ws_call(ws: &mut WsStream, id: &str, method: &str, params: Value) -> Value {
    let mut ignored = Vec::new();
    ws_call_collecting(ws, id, method, params, &mut ignored).await
}

async fn collect_until<F>(ws: &mut WsStream, notifs: &mut Vec<Value>, timeout_ms: u64, pred: F)
where
    F: Fn(&[Value]) -> bool,
{
    if pred(notifs) {
        return;
    }
    let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
    while tokio::time::Instant::now() < deadline {
        let rem = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(rem, ws.next()).await {
            Ok(Some(Ok(WsMessage::Text(txt)))) => {
                if let Ok(val) = serde_json::from_str::<Value>(&txt)
                    && val.get("method").is_some()
                {
                    notifs.push(val);
                    if pred(notifs) {
                        return;
                    }
                }
            }
            Ok(Some(Ok(_))) => {}
            _ => break,
        }
    }
}

/// Mock RFC 9728 / RFC 8414 / RFC 7591 authorization server whose dynamic registration and token
/// endpoints can be switched between success and failure.
struct MockOAuthServer {
    base: String,
    register_ok: Arc<AtomicBool>,
    token_ok: Arc<AtomicBool>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for MockOAuthServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn json_body(status: StatusCode, body: Value) -> axum::response::Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/json")],
        body.to_string(),
    )
        .into_response()
}

async fn spawn_mock_oauth_server() -> MockOAuthServer {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let register_ok = Arc::new(AtomicBool::new(true));
    let token_ok = Arc::new(AtomicBool::new(true));

    let prm_base = base.clone();
    let as_base = base.clone();
    let register_flag = Arc::clone(&register_ok);
    let token_flag = Arc::clone(&token_ok);
    let app = Router::new()
        .route(
            "/.well-known/oauth-protected-resource",
            get(move || {
                let b = prm_base.clone();
                async move {
                    json_body(
                        StatusCode::OK,
                        json!({ "resource": format!("{b}/mcp"), "authorization_servers": [b] }),
                    )
                }
            }),
        )
        .route(
            "/.well-known/oauth-authorization-server",
            get(move || {
                let b = as_base.clone();
                async move {
                    json_body(
                        StatusCode::OK,
                        json!({
                            "issuer": b,
                            "authorization_endpoint": format!("{b}/authorize"),
                            "token_endpoint": format!("{b}/token"),
                            "registration_endpoint": format!("{b}/register"),
                            "code_challenge_methods_supported": ["S256"]
                        }),
                    )
                }
            }),
        )
        .route(
            "/register",
            post(move || {
                let ok = register_flag.load(Ordering::SeqCst);
                async move {
                    if ok {
                        json_body(
                            StatusCode::CREATED,
                            json!({ "client_id": "dyn-client-1", "token_endpoint_auth_method": "none" }),
                        )
                    } else {
                        json_body(
                            StatusCode::INTERNAL_SERVER_ERROR,
                            json!({ "error": "server_error" }),
                        )
                    }
                }
            }),
        )
        .route(
            "/token",
            post(move || {
                let ok = token_flag.load(Ordering::SeqCst);
                async move {
                    if ok {
                        json_body(
                            StatusCode::OK,
                            json!({
                                "access_token": "oauth-access-token",
                                "token_type": "Bearer",
                                "expires_in": 3600,
                                "refresh_token": "oauth-refresh-token"
                            }),
                        )
                    } else {
                        json_body(
                            StatusCode::BAD_REQUEST,
                            json!({ "error": "invalid_grant" }),
                        )
                    }
                }
            }),
        )
        // Unauthenticated MCP probe: no `WWW-Authenticate` hint, discovery uses well-knowns.
        .route("/mcp", post(|| async { StatusCode::UNAUTHORIZED }));
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    MockOAuthServer {
        base,
        register_ok,
        token_ok,
        task,
    }
}

async fn upsert_user_server(ws: &mut WsStream, id: &str, server: Value) {
    let res = ws_call(
        ws,
        id,
        "cowork/mcp/server/upsert",
        json!({ "source": "user", "server": server }),
    )
    .await;
    assert!(res.get("error").is_none(), "upsert failed: {res}");
}

fn oauth_server(name: &str, base: &str, oauth_mode: Option<&str>) -> Value {
    let mut auth = json!({ "type": "oauth" });
    if let Some(mode) = oauth_mode {
        auth["oauthMode"] = json!(mode);
    }
    json!({
        "name": name,
        "transport": { "type": "http", "url": format!("{base}/mcp") },
        "auth": auth
    })
}

/// Asserts the exact TS `mcp_server_auth_result` shape and returns the event.
fn assert_auth_result(evt: &Value, name: &str, ok: bool, mode: &str) {
    let keys: BTreeSet<&str> = evt
        .as_object()
        .unwrap_or_else(|| panic!("auth result must be an object: {evt}"))
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        keys,
        BTreeSet::from(["type", "sessionId", "name", "ok", "mode", "message"]),
        "auth result keys: {evt}"
    );
    assert_eq!(evt["type"], json!("mcp_server_auth_result"), "{evt}");
    assert!(
        evt["sessionId"].as_str().is_some_and(|s| !s.is_empty()),
        "{evt}"
    );
    assert_eq!(evt["name"], json!(name), "{evt}");
    assert_eq!(evt["ok"], json!(ok), "{evt}");
    assert_eq!(evt["mode"], json!(mode), "{evt}");
    assert!(
        evt["message"].as_str().is_some_and(|s| !s.is_empty()),
        "{evt}"
    );
}

fn is_auth_result_notif(n: &Value, name: &str) -> bool {
    n["method"] == "cowork/control/event"
        && n["params"]["type"] == "mcp_server_auth_result"
        && n["params"]["name"] == name
}

fn is_mcp_servers_with_mode(n: &Value, name: &str, auth_mode: &str) -> bool {
    n["method"] == "cowork/control/event"
        && n["params"]["type"] == "mcp_servers"
        && n["params"]["servers"].as_array().is_some_and(|arr| {
            arr.iter()
                .any(|s| s["name"] == name && s["authMode"] == auth_mode)
        })
}

/// Starts auto (loopback) authorization and returns `(challenge event, loopback callback URL)`.
async fn authorize_auto(
    ws: &mut WsStream,
    id: &str,
    name: &str,
    notifs: &mut Vec<Value>,
) -> (Value, String) {
    let res = ws_call_collecting(
        ws,
        id,
        "cowork/mcp/server/auth/authorize",
        json!({ "name": name, "source": "user" }),
        notifs,
    )
    .await;
    let evt = res["result"]["event"].clone();
    assert_eq!(evt["type"], json!("mcp_server_auth_challenge"), "{res}");
    assert_eq!(evt["challenge"]["method"], json!("auto"), "{res}");
    let url = reqwest::Url::parse(evt["challenge"]["url"].as_str().unwrap()).unwrap();
    let mut redirect_uri = String::new();
    let mut state = String::new();
    for (k, v) in url.query_pairs() {
        match k.as_ref() {
            "redirect_uri" => redirect_uri = v.into_owned(),
            "state" => state = v.into_owned(),
            _ => {}
        }
    }
    let callback = format!("{redirect_uri}?code=loopback-code-1&state={state}");
    (evt, callback)
}

#[tokio::test]
async fn auto_oauth_success_broadcasts_auth_result_before_mcp_servers() {
    let iso = IsolatedServerEnv::new("cowork-mcp-oauth-ok-");
    let oauth = spawn_mock_oauth_server().await;
    let server = start_server(iso.server_options()).await.unwrap();
    let mut ws = connect_ready_ws(server.ws_url()).await;
    let _ = ws_call(&mut ws, "read-1", "cowork/mcp/servers/read", json!({})).await;
    upsert_user_server(
        &mut ws,
        "up-1",
        oauth_server("remote_oauth", &oauth.base, None),
    )
    .await;

    let mut notifs = Vec::new();
    let (challenge, callback_url) =
        authorize_auto(&mut ws, "auth-1", "remote_oauth", &mut notifs).await;

    // Manual callback before the browser redirect: TS `oauth_pending` (`ok: true`) outcome.
    let pending = ws_call_collecting(
        &mut ws,
        "cb-pending",
        "cowork/mcp/server/auth/callback",
        json!({ "name": "remote_oauth", "source": "user" }),
        &mut notifs,
    )
    .await;
    let pending_evt = &pending["result"]["event"];
    assert_auth_result(pending_evt, "remote_oauth", true, "oauth_pending");
    assert_eq!(
        pending_evt["message"],
        json!("OAuth callback is still pending. Paste a code to continue manually.")
    );

    let resp = reqwest::get(&callback_url).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    collect_until(&mut ws, &mut notifs, 10_000, |ns| {
        ns.iter()
            .any(|n| is_mcp_servers_with_mode(n, "remote_oauth", "oauth"))
    })
    .await;

    let auth_idx = notifs
        .iter()
        .position(|n| is_auth_result_notif(n, "remote_oauth"))
        .unwrap_or_else(|| panic!("auto OAuth must broadcast mcp_server_auth_result: {notifs:?}"));
    let evt = &notifs[auth_idx]["params"];
    assert_auth_result(evt, "remote_oauth", true, "oauth");
    assert_eq!(evt["sessionId"], challenge["sessionId"]);
    let servers_idx = notifs
        .iter()
        .position(|n| is_mcp_servers_with_mode(n, "remote_oauth", "oauth"))
        .expect("authenticated mcp_servers broadcast");
    assert!(
        auth_idx < servers_idx,
        "TS emits mcp_server_auth_result before mcp_servers: {notifs:?}"
    );
    assert_eq!(
        notifs
            .iter()
            .filter(|n| is_auth_result_notif(n, "remote_oauth"))
            .count(),
        1,
        "exactly one auth result broadcast: {notifs:?}"
    );
}

#[tokio::test]
async fn auto_oauth_token_exchange_failure_broadcasts_error_auth_result() {
    let iso = IsolatedServerEnv::new("cowork-mcp-oauth-fail-");
    let oauth = spawn_mock_oauth_server().await;
    oauth.token_ok.store(false, Ordering::SeqCst);
    let server = start_server(iso.server_options()).await.unwrap();
    let mut ws = connect_ready_ws(server.ws_url()).await;
    let _ = ws_call(&mut ws, "read-1", "cowork/mcp/servers/read", json!({})).await;
    upsert_user_server(
        &mut ws,
        "up-1",
        oauth_server("remote_oauth", &oauth.base, None),
    )
    .await;

    let mut notifs = Vec::new();
    let (_challenge, callback_url) =
        authorize_auto(&mut ws, "auth-1", "remote_oauth", &mut notifs).await;
    let resp = reqwest::get(&callback_url).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    collect_until(&mut ws, &mut notifs, 10_000, |ns| {
        ns.iter().any(|n| is_auth_result_notif(n, "remote_oauth"))
    })
    .await;
    let evt = &notifs
        .iter()
        .find(|n| is_auth_result_notif(n, "remote_oauth"))
        .unwrap_or_else(|| {
            panic!("failed auto OAuth must broadcast mcp_server_auth_result: {notifs:?}")
        })["params"];
    assert_auth_result(evt, "remote_oauth", false, "error");
    let message = evt["message"].as_str().unwrap();
    assert!(
        message.starts_with("MCP OAuth callback failed: OAuth token exchange failed (400"),
        "message={message}"
    );
    assert!(message.contains("invalid_grant"), "message={message}");
    assert!(
        !notifs
            .iter()
            .any(|n| is_mcp_servers_with_mode(n, "remote_oauth", "oauth")),
        "failed exchange must not report an authenticated server: {notifs:?}"
    );
}

#[tokio::test]
async fn authorize_and_manual_callback_report_ts_auth_result_outcomes() {
    let iso = IsolatedServerEnv::new("cowork-mcp-oauth-manual-");
    let oauth = spawn_mock_oauth_server().await;
    let server = start_server(iso.server_options()).await.unwrap();
    let mut ws = connect_ready_ws(server.ws_url()).await;
    let _ = ws_call(&mut ws, "read-1", "cowork/mcp/servers/read", json!({})).await;
    upsert_user_server(
        &mut ws,
        "up-code",
        oauth_server("code_oauth", &oauth.base, Some("code")),
    )
    .await;
    upsert_user_server(
        &mut ws,
        "up-plain",
        json!({
            "name": "plain_http",
            "transport": { "type": "http", "url": format!("{}/mcp", oauth.base) }
        }),
    )
    .await;

    // Unknown server stays a JSON-RPC error (TS resolver emits a session `error`).
    for (id, method) in [
        ("unknown-auth", "cowork/mcp/server/auth/authorize"),
        ("unknown-cb", "cowork/mcp/server/auth/callback"),
    ] {
        let res = ws_call(
            &mut ws,
            id,
            method,
            json!({ "name": "nope", "source": "user" }),
        )
        .await;
        assert!(res.get("error").is_some(), "{method} unknown server: {res}");
    }

    // Non-OAuth server -> `missing` outcome on both routes.
    for (id, method) in [
        ("plain-auth", "cowork/mcp/server/auth/authorize"),
        ("plain-cb", "cowork/mcp/server/auth/callback"),
    ] {
        let res = ws_call(
            &mut ws,
            id,
            method,
            json!({ "name": "plain_http", "source": "user", "code": "abc" }),
        )
        .await;
        let evt = &res["result"]["event"];
        assert_auth_result(evt, "plain_http", false, "missing");
        assert_eq!(
            evt["message"],
            json!("MCP server \"plain_http\" does not support OAuth authorization."),
            "{method}"
        );
    }

    // Callback before authorize -> `missing` (no pending challenge).
    let no_pending = ws_call(
        &mut ws,
        "cb-none",
        "cowork/mcp/server/auth/callback",
        json!({ "name": "code_oauth", "source": "user", "code": "abc" }),
    )
    .await;
    let evt = &no_pending["result"]["event"];
    assert_auth_result(evt, "code_oauth", false, "missing");
    assert_eq!(
        evt["message"],
        json!("No pending OAuth challenge found. Start authorization first.")
    );

    // Authorization failure (dynamic registration HTTP 500) -> `error` outcome.
    oauth.register_ok.store(false, Ordering::SeqCst);
    let auth_fail = ws_call(
        &mut ws,
        "auth-fail",
        "cowork/mcp/server/auth/authorize",
        json!({ "name": "code_oauth", "source": "user" }),
    )
    .await;
    let evt = &auth_fail["result"]["event"];
    assert_auth_result(evt, "code_oauth", false, "error");
    let message = evt["message"].as_str().unwrap();
    assert!(
        message.starts_with("MCP OAuth authorization failed: ")
            && message.contains("registration failed"),
        "message={message}"
    );
    oauth.register_ok.store(true, Ordering::SeqCst);

    let challenge = ws_call(
        &mut ws,
        "auth-code",
        "cowork/mcp/server/auth/authorize",
        json!({ "name": "code_oauth", "source": "user" }),
    )
    .await;
    assert_eq!(
        challenge["result"]["event"]["challenge"]["method"],
        json!("code"),
        "{challenge}"
    );

    // Failed token exchange with a pasted code -> `error` outcome, not a JSON-RPC error.
    oauth.token_ok.store(false, Ordering::SeqCst);
    let cb_fail = ws_call(
        &mut ws,
        "cb-fail",
        "cowork/mcp/server/auth/callback",
        json!({ "name": "code_oauth", "source": "user", "code": "pasted-code" }),
    )
    .await;
    let evt = &cb_fail["result"]["event"];
    assert_auth_result(evt, "code_oauth", false, "error");
    let message = evt["message"].as_str().unwrap();
    assert!(
        message.starts_with("MCP OAuth callback failed: OAuth token exchange failed (400"),
        "message={message}"
    );

    // The pending challenge survives the failure; a retry succeeds with `mode: "oauth"`.
    oauth.token_ok.store(true, Ordering::SeqCst);
    let mut notifs = Vec::new();
    let cb_ok = ws_call_collecting(
        &mut ws,
        "cb-ok",
        "cowork/mcp/server/auth/callback",
        json!({ "name": "code_oauth", "source": "user", "code": "pasted-code" }),
        &mut notifs,
    )
    .await;
    assert_auth_result(&cb_ok["result"]["event"], "code_oauth", true, "oauth");
    assert_eq!(
        cb_ok["result"]["event"]["sessionId"],
        challenge["result"]["event"]["sessionId"]
    );
    collect_until(&mut ws, &mut notifs, 5_000, |ns| {
        ns.iter()
            .any(|n| is_mcp_servers_with_mode(n, "code_oauth", "oauth"))
    })
    .await;
    assert!(
        notifs
            .iter()
            .any(|n| is_mcp_servers_with_mode(n, "code_oauth", "oauth")),
        "successful callback must broadcast authenticated mcp_servers: {notifs:?}"
    );
}
