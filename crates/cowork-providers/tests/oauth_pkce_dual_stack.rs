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

#[tokio::test]
async fn binds_dual_stack_ipv4_and_ipv6_loopback_verifies_pkce_s256_state_and_refreshes_tokens() {
    let (verifier, challenge) = generate_pkce_s256_pair();
    assert!(verifier.len() >= 43);
    assert_eq!(
        challenge,
        BASE64URL_NOPAD.encode(&Sha256::digest(verifier.as_bytes()))
    );
    assert!(generate_oauth_state().len() >= 24);

    let dir = PathBuf::from(format!("/private/tmp/cowork-oauth-test-{}", Uuid::new_v4()));
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
    assert!(
        ch1.ipv6_listening,
        "IPv6 [::1] listener must also be bound on macOS loopback"
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

    // Valid callback delivered over IPv6 [::1] on the exact same port!
    let ipv6_resp = http
        .get(format!(
            "http://[::1]:{port1}/oauth/callback?code=valid-auth-code&state={}",
            ch1.state
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(ipv6_resp.status(), 200);

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
