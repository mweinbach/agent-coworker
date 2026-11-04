//! Regression tests: with no static keys or `~/.aws` profile, Bedrock resolves ambient role
//! credentials the way TS delegated `aws_default` to the AWS SDK default chain (ECS task role /
//! EKS Pod Identity container endpoint, EKS web identity, EC2 IMDS), reading only the env map
//! the transport was given, and re-resolving them as they approach expiry.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Body;
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::Response;
use axum::routing::post;
use cowork_inference::{
    CanonicalMessage, ContentBlock, MessageRole, ProviderOpaqueMeta, RequestPolicy, StepBudget,
};
use cowork_providers::bedrock::{
    BedrockAuthMethod, BedrockConverseTransport, encode_eventstream_json_frame,
    resolve_bedrock_auth_config, try_resolve_bedrock_auth_config,
};
use cowork_providers::{ProviderStepRequest, ProviderTransport};
use serde_json::{Map, json};

fn empty_home() -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let home = std::fs::canonicalize(tmp.path()).unwrap();
    (tmp, home)
}

fn env_for(home: &std::path::Path, extra: &[(&str, &str)]) -> HashMap<String, String> {
    let mut env = HashMap::new();
    env.insert("HOME".into(), home.to_string_lossy().into_owned());
    for (k, v) in extra {
        env.insert((*k).into(), (*v).into());
    }
    env
}

/// `(method, path, Authorization header)` of each request a mock credential endpoint received.
type Seen = Arc<Mutex<Vec<(String, String, String)>>>;

/// Serves `app` on its own thread and runtime: the synchronous resolver blocks the caller's
/// thread (and with it a current-thread test runtime) while it fetches credentials.
fn serve_on_thread(app: Router) -> String {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async move {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            tx.send(listener.local_addr().unwrap()).unwrap();
            axum::serve(listener, app).await.unwrap();
        });
    });
    format!("http://{}", rx.recv().unwrap())
}

/// Mock ECS / EKS Pod Identity credentials endpoint. The n-th fetch returns access key
/// `ASIAECSROLE{n}` expiring at `expiration`.
fn spawn_mock_container_endpoint(expiration: String) -> (String, Seen) {
    let seen: Seen = Arc::default();
    let seen_srv = Arc::clone(&seen);
    let app = Router::new().fallback(move |method: Method, uri: Uri, headers: HeaderMap| {
        let seen = Arc::clone(&seen_srv);
        let expiration = expiration.clone();
        async move {
            let auth = headers
                .get("authorization")
                .and_then(|v| v.to_str().ok())
                .unwrap_or_default()
                .to_owned();
            let n = {
                let mut seen = seen.lock().unwrap();
                seen.push((method.to_string(), uri.path().to_owned(), auth));
                seen.len()
            };
            Response::builder()
                .status(StatusCode::OK)
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "AccessKeyId": format!("ASIAECSROLE{n}"),
                        "SecretAccessKey": format!("ecs-secret-{n}"),
                        "Token": format!("ecs-session-token-{n}"),
                        "Expiration": expiration,
                        "RoleArn": "arn:aws:iam::123456789012:role/task-role"
                    })
                    .to_string(),
                ))
                .unwrap()
        }
    });
    (serve_on_thread(app), seen)
}

fn rfc3339_from_now(seconds: i64) -> String {
    (chrono::Utc::now() + chrono::Duration::seconds(seconds))
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn user_request(base_url: String) -> ProviderStepRequest {
    ProviderStepRequest {
        model_id: "anthropic.claude-sonnet-4-5-20250929-v1:0".into(),
        base_url: Some(base_url),
        api_key: None,
        extra_headers: HashMap::new(),
        system_prompt: "You are helpful.".into(),
        messages: vec![CanonicalMessage {
            id: "u1".into(),
            role: MessageRole::User,
            content: vec![ContentBlock::Text {
                text: "hello".into(),
                phase: None,
                citations: Vec::new(),
                provider_meta: ProviderOpaqueMeta::default(),
            }],
            phase: None,
            provider: None,
            api: None,
            model: None,
            stop_reason: None,
            provider_meta: ProviderOpaqueMeta::default(),
            created_at: "2026-11-01T00:00:00Z".into(),
        }],
        tools: Vec::new(),
        authorized_tool_names: None,
        provider_options: Map::new(),
        continuation: None,
        policy: RequestPolicy::default(),
        turn_id: "turn-ambient-role".into(),
    }
}

/// Mock Bedrock runtime: records request headers and streams a one-word reply.
async fn spawn_mock_bedrock() -> (String, Arc<Mutex<Vec<HashMap<String, String>>>>) {
    let captured: Arc<Mutex<Vec<HashMap<String, String>>>> = Arc::default();
    let store = Arc::clone(&captured);
    let app = Router::new().route(
        "/model/{model_id}/converse-stream",
        post(move |headers: HeaderMap| {
            let store = Arc::clone(&store);
            async move {
                store.lock().unwrap().push(
                    headers
                        .iter()
                        .filter_map(|(k, v)| {
                            v.to_str()
                                .ok()
                                .map(|v| (k.as_str().to_ascii_lowercase(), v.to_owned()))
                        })
                        .collect(),
                );
                let mut bytes = Vec::new();
                for (event, payload) in [
                    ("messageStart", json!({ "role": "assistant" })),
                    (
                        "contentBlockDelta",
                        json!({ "contentBlockIndex": 0, "delta": { "text": "hi" } }),
                    ),
                    ("contentBlockStop", json!({ "contentBlockIndex": 0 })),
                    ("messageStop", json!({ "stopReason": "end_turn" })),
                    (
                        "metadata",
                        json!({ "usage": { "inputTokens": 3, "outputTokens": 1 } }),
                    ),
                ] {
                    bytes.extend_from_slice(
                        &encode_eventstream_json_frame(event, &payload).unwrap(),
                    );
                }
                Response::builder()
                    .status(StatusCode::OK)
                    .header("content-type", "application/vnd.amazon.eventstream")
                    .body(Body::from(bytes))
                    .unwrap()
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("http://{addr}"), captured)
}

#[tokio::test]
async fn ecs_container_full_uri_credentials_sign_bedrock_requests() {
    let (ecs_url, ecs_seen) = spawn_mock_container_endpoint(rfc3339_from_now(6 * 3600));
    let (bedrock_url, bedrock_seen) = spawn_mock_bedrock().await;
    let (_tmp, home) = empty_home();
    let full_uri = format!("{ecs_url}/v2/credentials/task-1");
    let env = env_for(
        &home,
        &[
            ("AWS_REGION", "us-west-2"),
            ("AWS_CONTAINER_CREDENTIALS_FULL_URI", &full_uri),
            ("AWS_CONTAINER_AUTHORIZATION_TOKEN", "ecs-auth-token"),
        ],
    );

    // The "configured?" check (catalog / connection status) reports the ambient role.
    let cfg = resolve_bedrock_auth_config(&home, &env, None).expect("ambient ECS role resolves");
    assert_eq!(cfg.method_id, "aws_default");
    assert_eq!(cfg.source, "env");
    assert_eq!(cfg.region, "us-west-2");
    assert!(cfg.has_configured_region);
    assert_eq!(
        cfg.auth,
        BedrockAuthMethod::SigV4 {
            access_key_id: "ASIAECSROLE1".into(),
            secret_access_key: "ecs-secret-1".into(),
            session_token: Some("ecs-session-token-1".into()),
        }
    );

    let transport = BedrockConverseTransport::with_isolated_env(home.clone(), env);
    transport
        .stream_step(
            user_request(bedrock_url),
            &StepBudget::new(30_000, None),
            &mut |_| {},
        )
        .await
        .expect("Bedrock step succeeds with ECS role credentials");

    let reqs = bedrock_seen.lock().unwrap();
    assert_eq!(reqs.len(), 1);
    let authorization = reqs[0].get("authorization").expect("signed request");
    assert!(
        authorization.starts_with("AWS4-HMAC-SHA256 Credential=ASIAECSROLE1/"),
        "{authorization}"
    );
    assert!(
        authorization.contains("/us-west-2/bedrock/aws4_request"),
        "{authorization}"
    );
    assert_eq!(
        reqs[0].get("x-amz-security-token").map(String::as_str),
        Some("ecs-session-token-1")
    );

    // One endpoint fetch serves both resolutions (credentials cached until near expiry), and
    // it carried the container authorization token from the given env map.
    let ecs_seen = ecs_seen.lock().unwrap();
    assert_eq!(ecs_seen.len(), 1, "{ecs_seen:?}");
    assert_eq!(
        ecs_seen[0],
        (
            "GET".to_owned(),
            "/v2/credentials/task-1".to_owned(),
            "ecs-auth-token".to_owned()
        )
    );
}

#[test]
fn container_credentials_reject_redirects_to_another_origin() {
    let (other_uri, seen) = spawn_mock_container_endpoint(rfc3339_from_now(3600));
    let endpoint = serve_on_thread(
        Router::new()
            .fallback(move || async move { axum::response::Redirect::temporary(&other_uri) }),
    );
    let (_tmp, home) = empty_home();
    let env = env_for(&home, &[("AWS_CONTAINER_CREDENTIALS_FULL_URI", &endpoint)]);

    let result = try_resolve_bedrock_auth_config(&home, &env, None);
    assert!(
        seen.lock().unwrap().is_empty(),
        "contacted the redirected credential endpoint"
    );
    assert!(result.unwrap_err().contains("307"));
}

#[test]
fn container_credentials_are_refreshed_as_they_approach_expiry() {
    // Credentials expiring in two minutes are inside the refresh margin, so every resolution
    // re-fetches instead of reusing them until they lapse.
    let (ecs_url, ecs_seen) = spawn_mock_container_endpoint(rfc3339_from_now(120));
    let (_tmp, home) = empty_home();
    let token_file = home.join("eks-pod-identity-token");
    std::fs::write(&token_file, "pod-identity-token\n").unwrap();
    let full_uri = format!("{ecs_url}/v1/credentials");
    let token_path = token_file.to_string_lossy().into_owned();
    let env = env_for(
        &home,
        &[
            ("AWS_CONTAINER_CREDENTIALS_FULL_URI", &full_uri),
            ("AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE", &token_path),
            (
                "AWS_CONTAINER_AUTHORIZATION_TOKEN",
                "ignored-when-token-file-is-set",
            ),
        ],
    );

    let first = try_resolve_bedrock_auth_config(&home, &env, None)
        .expect("resolves")
        .expect("credentials");
    let second = try_resolve_bedrock_auth_config(&home, &env, None)
        .expect("resolves")
        .expect("credentials");
    assert_eq!(first.region, "us-east-1");
    assert!(!first.has_configured_region);
    let key_of = |cfg: &cowork_providers::bedrock::BedrockAuthConfig| match &cfg.auth {
        BedrockAuthMethod::SigV4 { access_key_id, .. } => access_key_id.clone(),
        other => panic!("expected SigV4, got {other:?}"),
    };
    assert_eq!(key_of(&first), "ASIAECSROLE1");
    assert_eq!(key_of(&second), "ASIAECSROLE2");

    let ecs_seen = ecs_seen.lock().unwrap();
    assert_eq!(ecs_seen.len(), 2);
    assert!(
        ecs_seen
            .iter()
            .all(|(_, _, auth)| auth == "pod-identity-token"),
        "token file wins over the inline token: {ecs_seen:?}"
    );
}

#[test]
fn saved_aws_default_connection_uses_ambient_role_credentials() {
    let (ecs_url, _seen) = spawn_mock_container_endpoint(rfc3339_from_now(6 * 3600));
    let (_tmp, home) = empty_home();
    let full_uri = format!("{ecs_url}/saved-default");
    let env = env_for(&home, &[("AWS_CONTAINER_CREDENTIALS_FULL_URI", &full_uri)]);
    let store: cowork_config::ConnectionStore = serde_json::from_value(json!({
        "version": 1,
        "updatedAt": "2026-01-01T00:00:00.000Z",
        "services": {
            "bedrock": {
                "service": "bedrock",
                "mode": "credentials",
                "methodId": "aws_default",
                "values": { "region": "eu-west-1" },
                "updatedAt": "2026-01-01T00:00:00.000Z"
            }
        }
    }))
    .unwrap();

    let cfg = try_resolve_bedrock_auth_config(&home, &env, Some(&store))
        .expect("resolves")
        .expect("credentials");
    assert_eq!(cfg.method_id, "aws_default");
    assert_eq!(cfg.source, "saved");
    assert_eq!(cfg.region, "eu-west-1");
    assert!(matches!(
        cfg.auth,
        BedrockAuthMethod::SigV4 { ref access_key_id, .. } if access_key_id.starts_with("ASIAECSROLE")
    ));
}

#[test]
fn ec2_imds_instance_role_credentials_resolve_behind_an_ec2_hint() {
    let seen: Seen = Arc::default();
    let seen_srv = Arc::clone(&seen);
    let expiration = rfc3339_from_now(6 * 3600);
    let app = Router::new().fallback(move |method: Method, uri: Uri, headers: HeaderMap| {
        let seen = Arc::clone(&seen_srv);
        let expiration = expiration.clone();
        async move {
            let token = headers
                .get("x-aws-ec2-metadata-token")
                .and_then(|v| v.to_str().ok())
                .unwrap_or_default()
                .to_owned();
            seen.lock()
                .unwrap()
                .push((method.to_string(), uri.path().to_owned(), token.clone()));
            let (status, body) = match (method.as_str(), uri.path()) {
                ("PUT", "/latest/api/token") => (StatusCode::OK, "imds-session".to_owned()),
                (_, _) if token != "imds-session" => (StatusCode::UNAUTHORIZED, String::new()),
                ("GET", "/latest/meta-data/iam/security-credentials/") => {
                    (StatusCode::OK, "ec2-role".to_owned())
                }
                ("GET", "/latest/meta-data/iam/security-credentials/ec2-role") => (
                    StatusCode::OK,
                    json!({
                        "Code": "Success",
                        "LastUpdated": "2026-11-01T00:00:00Z",
                        "Type": "AWS-HMAC",
                        "AccessKeyId": "ASIAEC2ROLE",
                        "SecretAccessKey": "ec2-secret",
                        "Token": "ec2-session-token",
                        "Expiration": expiration
                    })
                    .to_string(),
                ),
                _ => (StatusCode::NOT_FOUND, String::new()),
            };
            Response::builder()
                .status(status)
                .header("x-aws-ec2-metadata-token-ttl-seconds", "21600")
                .body(Body::from(body))
                .unwrap()
        }
    });
    let imds_url = serve_on_thread(app);
    let (_tmp, home) = empty_home();
    let env = env_for(
        &home,
        &[
            ("AWS_REGION", "ap-southeast-2"),
            ("AWS_EXECUTION_ENV", "AWS_ECS_EC2"),
            ("AWS_EC2_METADATA_SERVICE_ENDPOINT", &imds_url),
        ],
    );

    let cfg = try_resolve_bedrock_auth_config(&home, &env, None)
        .expect("resolves")
        .expect("credentials");
    assert_eq!(cfg.method_id, "aws_default");
    assert_eq!(cfg.region, "ap-southeast-2");
    assert_eq!(
        cfg.auth,
        BedrockAuthMethod::SigV4 {
            access_key_id: "ASIAEC2ROLE".into(),
            secret_access_key: "ec2-secret".into(),
            session_token: Some("ec2-session-token".into()),
        }
    );
    assert!(
        seen.lock()
            .unwrap()
            .iter()
            .any(|(m, p, _)| m == "PUT" && p == "/latest/api/token"),
        "IMDSv2 session token requested"
    );

    // `AWS_EC2_METADATA_DISABLED=true` overrides the EC2 hint: nothing ambient is configured.
    let mut disabled = env.clone();
    disabled.insert("AWS_EC2_METADATA_DISABLED".into(), "true".into());
    assert!(
        try_resolve_bedrock_auth_config(&home, &disabled, None)
            .expect("no error")
            .is_none()
    );
}

#[tokio::test]
async fn no_ambient_markers_and_no_keys_is_still_not_configured() {
    let (_tmp, home) = empty_home();
    let env = env_for(&home, &[("AWS_REGION", "us-west-2")]);
    assert!(
        try_resolve_bedrock_auth_config(&home, &env, None)
            .expect("no error")
            .is_none()
    );
    assert!(resolve_bedrock_auth_config(&home, &env, None).is_none());

    let transport = BedrockConverseTransport::with_isolated_env(home.clone(), env);
    let err = transport
        .stream_step(
            user_request("http://127.0.0.1:9".into()),
            &StepBudget::new(30_000, None),
            &mut |_| {},
        )
        .await
        .expect_err("no credentials configured");
    assert!(
        err.to_string()
            .contains("Amazon Bedrock credentials are not configured."),
        "{err}"
    );
}

#[test]
fn unusable_ambient_markers_report_actionable_errors() {
    let (_tmp, home) = empty_home();

    // Plain-http credentials from a non-loopback host are refused before any request.
    let env = env_for(
        &home,
        &[(
            "AWS_CONTAINER_CREDENTIALS_FULL_URI",
            "http://198.51.100.7/credentials",
        )],
    );
    let err = try_resolve_bedrock_auth_config(&home, &env, None).expect_err("insecure URI");
    assert!(err.contains("AWS_CONTAINER_CREDENTIALS_FULL_URI"), "{err}");
    assert!(err.contains("must use https"), "{err}");
    assert!(resolve_bedrock_auth_config(&home, &env, None).is_none());

    // A web identity token file without a role to assume names the missing variable.
    let env = env_for(
        &home,
        &[("AWS_WEB_IDENTITY_TOKEN_FILE", "/var/run/secrets/eks/token")],
    );
    let err = try_resolve_bedrock_auth_config(&home, &env, None).expect_err("no role arn");
    assert!(err.contains("AWS_ROLE_ARN"), "{err}");
}
