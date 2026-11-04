use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Body;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::Response;
use axum::routing::post;
use cowork_providers::oauth::{
    OAuthMode, PkceOAuthConfig, PkceOAuthManager, generate_oauth_state, generate_pkce_s256_pair,
};
use data_encoding::BASE64URL_NOPAD;
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::net::TcpListener;
use uuid::Uuid;

/// Per-test scratch base: the canonical `/private/tmp` Seatbelt scratch root on macOS, the
/// platform temp dir (`/tmp` on Linux) elsewhere.
fn test_temp_base() -> PathBuf {
    if cfg!(target_os = "macos") {
        PathBuf::from("/private/tmp")
    } else {
        std::env::temp_dir()
    }
}

#[tokio::test]
async fn binds_dual_stack_ipv4_and_ipv6_loopback_verifies_pkce_s256_state_and_refreshes_tokens() {
    let (verifier, challenge) = generate_pkce_s256_pair();
    assert!(verifier.len() >= 43);
    assert_eq!(
        challenge,
        BASE64URL_NOPAD.encode(&Sha256::digest(verifier.as_bytes()))
    );
    assert!(generate_oauth_state().len() >= 24);

    let dir = test_temp_base().join(format!("cowork-oauth-test-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let dir = std::fs::canonicalize(&dir).unwrap();
    let creds_file = dir.join("oauth-creds.json");

    // Mock OAuth 2.1 token server verifying S256 code_verifier and refresh_token
    let expected_challenge: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let token_state = expected_challenge.clone();

    let app = Router::new()
        .route(
            "/oauth/token",
            post(
                move |State(exp_ch): State<Arc<Mutex<Option<String>>>>, body: String| async move {
                    let params: Vec<(String, String)> =
                        url::form_urlencoded::parse(body.as_bytes())
                            .into_owned()
                            .collect();
                    let get_param = |k: &str| {
                        params
                            .iter()
                            .find(|(key, _)| key == k)
                            .map(|(_, v)| v.as_str())
                    };
                    match get_param("grant_type") {
                        Some("authorization_code") => {
                            let code = get_param("code").unwrap_or_default();
                            let code_verifier = get_param("code_verifier").unwrap_or_default();
                            let computed =
                                BASE64URL_NOPAD.encode(&Sha256::digest(code_verifier.as_bytes()));
                            let expected = exp_ch.lock().unwrap().clone().unwrap_or_default();
                            if code != "valid-auth-code" || computed != expected {
                                return Response::builder()
                                    .status(StatusCode::BAD_REQUEST)
                                    .body(Body::from("invalid_grant"))
                                    .unwrap();
                            }
                            Response::builder()
                                .status(StatusCode::OK)
                                .header("content-type", "application/json")
                                .body(Body::from(
                                    json!({
                                        "access_token": "acc-tok-initial",
                                        "refresh_token": "ref-tok-initial",
                                        "expires_in": 3600,
                                        "token_type": "Bearer",
                                        "scope": "openid profile"
                                    })
                                    .to_string(),
                                ))
                                .unwrap()
                        }
                        Some("refresh_token") => {
                            if get_param("refresh_token") != Some("ref-tok-initial") {
                                return Response::builder()
                                    .status(StatusCode::BAD_REQUEST)
                                    .body(Body::from("invalid_refresh"))
                                    .unwrap();
                            }
                            Response::builder()
                                .status(StatusCode::OK)
                                .header("content-type", "application/json")
                                .body(Body::from(
                                    json!({
                                        "access_token": "acc-tok-refreshed",
                                        "refresh_token": "ref-tok-rotated",
                                        "expires_in": 7200,
                                        "token_type": "Bearer"
                                    })
                                    .to_string(),
                                ))
                                .unwrap()
                        }
                        _ => Response::builder()
                            .status(StatusCode::BAD_REQUEST)
                            .body(Body::from("unsupported_grant_type"))
                            .unwrap(),
                    }
                },
            ),
        )
        .with_state(token_state);

    let token_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let token_port = token_listener.local_addr().unwrap().port();
    let token_srv = tokio::spawn(async move {
        let _ = axum::serve(token_listener, app).await;
    });

    let mgr = PkceOAuthManager::new();

    // Challenge 1: Deliver callback over IPv6 [::1] while advertised redirect_uri uses "localhost"!
    let ch1 = mgr
        .start_challenge(PkceOAuthConfig {
            client_id: "client-test-1".into(),
            authorize_url: "https://auth.example.com/authorize".into(),
            token_url: format!("http://127.0.0.1:{token_port}/oauth/token"),
            scopes: vec!["openid".into(), "profile".into()],
            advertised_redirect_host: "localhost".into(),
            callback_path: "/oauth/callback".into(),
            mode: OAuthMode::Auto,
            resource: None,
        })
        .await
        .unwrap();

    let port1 = ch1.bound_port.expect("ephemeral port allocated");
    assert!(ch1.ipv4_listening);
    // Hosts/containers without an IPv6 loopback interface degrade to an IPv4-only listener.
    let host_has_ipv6_loopback = std::net::TcpListener::bind("[::1]:0").is_ok();
    assert_eq!(
        ch1.ipv6_listening, host_has_ipv6_loopback,
        "IPv6 [::1] listener must be bound on the same port whenever the host supports IPv6 loopback"
    );
    assert_eq!(
        ch1.redirect_uri,
        format!("http://localhost:{port1}/oauth/callback")
    );
    *expected_challenge.lock().unwrap() = Some(ch1.code_challenge.clone());

    let http = reqwest::Client::new();

    // CSRF state mismatch over IPv4 127.0.0.1 must be rejected with 400!
    let bad_state_resp = http
        .get(format!(
            "http://127.0.0.1:{port1}/oauth/callback?code=valid-auth-code&state=wrong-state"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(bad_state_resp.status(), 400);

    // Valid callback delivered over IPv6 [::1] on the exact same port (IPv4 on IPv4-only hosts)!
    let valid_callback_host = if host_has_ipv6_loopback {
        "[::1]"
    } else {
        "127.0.0.1"
    };
    let valid_resp = http
        .get(format!(
            "http://{valid_callback_host}:{port1}/oauth/callback?code=valid-auth-code&state={}",
            ch1.state
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(valid_resp.status(), 200);

    let saved = mgr
        .complete_challenge(&ch1.challenge_id, None, Some(&creds_file))
        .await
        .unwrap();
    assert_eq!(saved.access_token, "acc-tok-initial");
    assert_eq!(saved.refresh_token.as_deref(), Some("ref-tok-initial"));
    assert_eq!(
        std::fs::metadata(&creds_file).unwrap().permissions().mode() & 0o777,
        0o600
    );

    // Challenge 2: Deliver callback over IPv4 127.0.0.1!
    let ch2 = mgr
        .start_challenge(PkceOAuthConfig {
            client_id: "client-test-1".into(),
            authorize_url: "https://auth.example.com/authorize".into(),
            token_url: format!("http://127.0.0.1:{token_port}/oauth/token"),
            scopes: vec!["openid".into()],
            advertised_redirect_host: "127.0.0.1".into(),
            callback_path: "/oauth/callback".into(),
            mode: OAuthMode::Auto,
            resource: None,
        })
        .await
        .unwrap();
    let port2 = ch2.bound_port.unwrap();
    *expected_challenge.lock().unwrap() = Some(ch2.code_challenge.clone());

    let ipv4_resp = http
        .get(format!(
            "http://127.0.0.1:{port2}/oauth/callback?code=valid-auth-code&state={}",
            ch2.state
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(ipv4_resp.status(), 200);

    let saved2 = mgr
        .complete_challenge(&ch2.challenge_id, None, None)
        .await
        .unwrap();
    assert_eq!(saved2.access_token, "acc-tok-initial");

    // Refresh expired token
    let refreshed = mgr
        .refresh_tokens(
            &format!("http://127.0.0.1:{token_port}/oauth/token"),
            "client-test-1",
            "ref-tok-initial",
            Some(&creds_file),
        )
        .await
        .unwrap();
    assert_eq!(refreshed.access_token, "acc-tok-refreshed");
    assert_eq!(refreshed.refresh_token.as_deref(), Some("ref-tok-rotated"));

    token_srv.abort();
    let _ = std::fs::remove_dir_all(&dir);
}

fn loopback_config(token_url: String) -> PkceOAuthConfig {
    PkceOAuthConfig {
        client_id: "client-test-err".into(),
        authorize_url: "https://auth.example.com/authorize".into(),
        token_url,
        scopes: vec!["openid".into()],
        advertised_redirect_host: "127.0.0.1".into(),
        callback_path: "/oauth/callback".into(),
        mode: OAuthMode::Auto,
        resource: None,
    }
}

/// Polls until nothing accepts connections on `127.0.0.1:port` (the listener task was aborted).
async fn wait_until_listener_closed(port: u16) -> bool {
    for _ in 0..100 {
        if tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_err()
        {
            return true;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    false
}

#[tokio::test]
async fn denied_callback_fails_the_challenge_immediately_and_closes_listeners() {
    let mgr = PkceOAuthManager::new();
    let ch = mgr
        .start_challenge(loopback_config("http://127.0.0.1:9/oauth/token".into()))
        .await
        .unwrap();
    let port = ch.bound_port.unwrap();

    let waiter = {
        let mgr = mgr.clone();
        let id = ch.challenge_id.clone();
        tokio::spawn(async move { mgr.complete_challenge(&id, None, None).await })
    };
    tokio::task::yield_now().await;

    let resp = reqwest::Client::new()
        .get(format!(
            "http://127.0.0.1:{port}/oauth/callback?error=access_denied&error_description=User%20denied&state={}",
            ch.state
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 400);

    // Must not wait out the 180s callback timeout.
    let err = tokio::time::timeout(std::time::Duration::from_secs(5), waiter)
        .await
        .expect("denied consent fails the challenge immediately")
        .unwrap()
        .expect_err("denied consent is an error");
    assert!(
        err.message.contains("access_denied") && err.message.contains("User denied"),
        "{}",
        err.message
    );
    assert!(
        wait_until_listener_closed(port).await,
        "loopback listener must be aborted when the challenge fails"
    );
}

#[tokio::test]
async fn cancelled_challenge_wait_aborts_loopback_listeners() {
    let mgr = PkceOAuthManager::new();
    let ch = mgr
        .start_challenge(loopback_config("http://127.0.0.1:9/oauth/token".into()))
        .await
        .unwrap();
    let port = ch.bound_port.unwrap();
    assert!(
        tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_ok(),
        "listener is up while the challenge is pending"
    );

    // The caller gives up (or its own timeout fires) while waiting for the browser.
    let wait = mgr.complete_challenge(&ch.challenge_id, None, None);
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(200), wait)
            .await
            .is_err()
    );
    assert!(
        wait_until_listener_closed(port).await,
        "dropping the challenge must abort its loopback servers"
    );
}
