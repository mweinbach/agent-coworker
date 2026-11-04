//! `providerOptions.bedrock.profile` selects the AWS profile Bedrock requests are signed with
//! (TS `piRuntimeOptions.ts` forwarded it as `options.profile` to the Bedrock client, whose
//! default credential chain then used that profile). Explicitly saved auth (API key, access
//! keys, saved profile) keeps precedence; the default chain (`aws_default`) yields to it.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use axum::routing::post;
use cowork_config::{ConnectionStore, get_ai_coworker_paths, write_connection_store};
use cowork_inference::{
    CanonicalMessage, ContentBlock, MessageRole, ProviderOpaqueMeta, ProviderTransportError,
    RequestPolicy, StepBudget,
};
use cowork_providers::bedrock::{
    BedrockAuthMethod, BedrockConverseTransport, encode_eventstream_json_frame,
    resolve_bedrock_auth_config, try_resolve_bedrock_auth_config_with_profile,
};
use cowork_providers::{ProviderStepRequest, ProviderTransport};
use serde_json::{Map, Value, json};
use tokio::net::TcpListener;

const CREDENTIALS: &str = "[default]\naws_access_key_id = AKIADEFAULTACCOUNT\naws_secret_access_key = DEFAULTSECRET\n\n[sandbox]\naws_access_key_id = AKIASANDBOXACCOUNT\naws_secret_access_key = SANDBOXSECRET\n\n[dev]\naws_access_key_id = AKIADEVACCOUNT\naws_secret_access_key = DEVSECRET\n";
const CONFIG: &str = "[default]\nregion = us-east-1\n\n[profile sandbox]\nregion = eu-west-1\n";

fn home_with_aws(credentials: &str, config: &str) -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let home = fs::canonicalize(tmp.path()).unwrap();
    fs::create_dir_all(home.join(".aws")).unwrap();
    fs::write(home.join(".aws/credentials"), credentials).unwrap();
    fs::write(home.join(".aws/config"), config).unwrap();
    (tmp, home)
}

fn env_for(home: &Path) -> HashMap<String, String> {
    HashMap::from([("HOME".to_string(), home.to_string_lossy().into_owned())])
}

fn saved_store(method_id: &str, values: Value) -> ConnectionStore {
    serde_json::from_value(json!({
        "version": 1,
        "updatedAt": "2026-01-01T00:00:00.000Z",
        "services": {
            "bedrock": {
                "service": "bedrock",
                "mode": "credentials",
                "methodId": method_id,
                "values": values,
                "updatedAt": "2026-01-01T00:00:00.000Z"
            }
        }
    }))
    .expect("connection store fixture")
}

async fn save_store(home: &Path, store: &ConnectionStore) {
    let paths = get_ai_coworker_paths(Some(home), &env_for(home));
    write_connection_store(&paths, store).await.unwrap();
}

type SeenAuthorization = Arc<Mutex<Vec<String>>>;

/// Mock Converse endpoint recording each request's `Authorization` header.
async fn spawn_mock() -> (String, SeenAuthorization) {
    let seen: SeenAuthorization = Arc::default();
    let app = Router::new()
        .route(
            "/model/{model_id}/converse-stream",
            post(
                |State(seen): State<SeenAuthorization>, headers: HeaderMap| async move {
                    seen.lock().unwrap().push(
                        headers
                            .get("authorization")
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or_default()
                            .to_string(),
                    );
                    let mut bytes = Vec::new();
                    for (event, payload) in [
                        ("messageStart", json!({ "role": "assistant" })),
                        (
                            "contentBlockDelta",
                            json!({ "contentBlockIndex": 0, "delta": { "text": "ok" } }),
                        ),
                        ("contentBlockStop", json!({ "contentBlockIndex": 0 })),
                        ("messageStop", json!({ "stopReason": "end_turn" })),
                        (
                            "metadata",
                            json!({ "usage": { "inputTokens": 1, "outputTokens": 1 } }),
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
                },
            ),
        )
        .with_state(Arc::clone(&seen));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("http://{addr}"), seen)
}

fn bedrock_options(bedrock: Value) -> Map<String, Value> {
    let mut opts = Map::new();
    opts.insert("bedrock".into(), bedrock);
    opts
}

async fn run_step(
    transport: &BedrockConverseTransport,
    base_url: &str,
    provider_options: Map<String, Value>,
) -> Result<(), ProviderTransportError> {
    let policy = RequestPolicy {
        max_attempts: 1,
        ..RequestPolicy::default()
    };
    transport
        .stream_step(
            ProviderStepRequest {
                model_id: "us.anthropic.claude-sonnet-4-6-v1:0".into(),
                base_url: Some(base_url.to_string()),
                api_key: None,
                extra_headers: HashMap::new(),
                system_prompt: "System".into(),
                messages: vec![CanonicalMessage {
                    id: "u1".into(),
                    role: MessageRole::User,
                    content: vec![ContentBlock::Text {
                        text: "hi".into(),
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
                provider_options,
                continuation: None,
                policy,
                turn_id: "turn-bdrk-profile".into(),
            },
            &StepBudget::new(10_000, None),
            &mut |_| {},
        )
        .await
        .map(|_| ())
}

fn last_authorization(seen: &SeenAuthorization) -> String {
    seen.lock()
        .unwrap()
        .last()
        .cloned()
        .expect("mock Bedrock endpoint received a request")
}

#[tokio::test]
async fn configured_profile_signs_with_named_profile_instead_of_default() {
    let (_tmp, home) = home_with_aws(CREDENTIALS, CONFIG);
    let (base_url, seen) = spawn_mock().await;
    let transport = BedrockConverseTransport::with_isolated_env(home.clone(), env_for(&home));

    run_step(
        &transport,
        &base_url,
        bedrock_options(json!({ "profile": "sandbox" })),
    )
    .await
    .expect("configured profile resolves");
    let authorization = last_authorization(&seen);
    assert!(
        authorization.contains("Credential=AKIASANDBOXACCOUNT/"),
        "{authorization}"
    );
    // With no explicit or ambient region the selected profile's region applies.
    assert!(
        authorization.contains("/eu-west-1/bedrock/aws4_request"),
        "{authorization}"
    );

    // Without the option the default profile still applies.
    run_step(&transport, &base_url, Map::new()).await.unwrap();
    let authorization = last_authorization(&seen);
    assert!(
        authorization.contains("Credential=AKIADEFAULTACCOUNT/"),
        "{authorization}"
    );
}

#[tokio::test]
async fn pre_resolved_default_chain_auth_yields_to_configured_profile() {
    let (_tmp, home) = home_with_aws(CREDENTIALS, CONFIG);
    let (base_url, seen) = spawn_mock().await;
    // The server pre-resolves auth without provider options: the `[default]` chain.
    let pre_resolved = resolve_bedrock_auth_config(&home, &env_for(&home), None)
        .expect("default profile resolves");
    assert_eq!(pre_resolved.method_id, "aws_default");
    let transport = BedrockConverseTransport::with_auth(pre_resolved);

    let mut opts = bedrock_options(json!({ "profile": "sandbox", "region": "us-west-2" }));
    opts.insert(
        "coworkHome".into(),
        Value::String(home.join(".cowork").to_string_lossy().into_owned()),
    );
    run_step(&transport, &base_url, opts)
        .await
        .expect("configured profile resolves");
    let authorization = last_authorization(&seen);
    assert!(
        authorization.contains("Credential=AKIASANDBOXACCOUNT/"),
        "{authorization}"
    );
    assert!(
        authorization.contains("/us-west-2/bedrock/aws4_request"),
        "providerOptions.bedrock.region still wins: {authorization}"
    );
}

#[tokio::test]
async fn saved_explicit_auth_keeps_precedence_over_configured_profile() {
    let (base_url, seen) = spawn_mock().await;
    let opts = || bedrock_options(json!({ "profile": "sandbox" }));

    // Saved access keys (resolved by the transport, and pre-resolved by the server).
    let (_tmp, home) = home_with_aws(CREDENTIALS, CONFIG);
    let keys = saved_store(
        "aws_keys",
        json!({ "accessKeyId": "AKIASAVEDKEYS", "secretAccessKey": "SAVEDSECRET" }),
    );
    save_store(&home, &keys).await;
    let transport = BedrockConverseTransport::with_isolated_env(home.clone(), env_for(&home));
    run_step(&transport, &base_url, opts()).await.unwrap();
    let authorization = last_authorization(&seen);
    assert!(
        authorization.contains("Credential=AKIASAVEDKEYS/"),
        "{authorization}"
    );
    let pre_resolved = resolve_bedrock_auth_config(&home, &env_for(&home), Some(&keys)).unwrap();
    run_step(
        &BedrockConverseTransport::with_auth(pre_resolved),
        &base_url,
        opts(),
    )
    .await
    .unwrap();
    let authorization = last_authorization(&seen);
    assert!(
        authorization.contains("Credential=AKIASAVEDKEYS/"),
        "{authorization}"
    );

    // A saved profile connection keeps its own profile.
    let (_tmp2, home2) = home_with_aws(CREDENTIALS, CONFIG);
    save_store(
        &home2,
        &saved_store("aws_profile", json!({ "profile": "dev" })),
    )
    .await;
    let transport = BedrockConverseTransport::with_isolated_env(home2.clone(), env_for(&home2));
    run_step(&transport, &base_url, opts()).await.unwrap();
    let authorization = last_authorization(&seen);
    assert!(
        authorization.contains("Credential=AKIADEVACCOUNT/"),
        "{authorization}"
    );
}

#[tokio::test]
async fn missing_configured_profile_errors_instead_of_using_default_credentials() {
    let (_tmp, home) = home_with_aws(CREDENTIALS, CONFIG);
    let (base_url, seen) = spawn_mock().await;
    let transport = BedrockConverseTransport::with_isolated_env(home.clone(), env_for(&home));

    let err = run_step(
        &transport,
        &base_url,
        bedrock_options(json!({ "profile": "missing" })),
    )
    .await
    .expect_err("an unknown selected profile must not fall back to [default]");
    assert!(err.to_string().contains("AWS profile 'missing'"), "{err}");
    assert!(seen.lock().unwrap().is_empty(), "no request may be sent");
}

fn access_key_id(method: &BedrockAuthMethod) -> &str {
    match method {
        BedrockAuthMethod::SigV4 { access_key_id, .. } => access_key_id,
        BedrockAuthMethod::BearerToken { .. } => panic!("expected SigV4 credentials"),
    }
}

#[test]
fn configured_profile_resolves_without_a_default_profile() {
    let (_tmp, home) = home_with_aws(
        "[sandbox]\naws_access_key_id = AKIASANDBOXACCOUNT\naws_secret_access_key = SANDBOXSECRET\n",
        "[profile sandbox]\nregion = eu-west-1\n",
    );
    let env = env_for(&home);
    assert!(resolve_bedrock_auth_config(&home, &env, None).is_none());
    let cfg = try_resolve_bedrock_auth_config_with_profile(&home, &env, None, Some("sandbox"))
        .unwrap()
        .expect("configured profile resolves");
    assert_eq!(cfg.method_id, "aws_profile");
    assert_eq!(access_key_id(&cfg.auth), "AKIASANDBOXACCOUNT");
    assert_eq!(cfg.region, "eu-west-1");
    assert!(cfg.has_configured_profile);
}

#[test]
fn configured_profile_precedence_matches_ts_client_config_merge() {
    let (_tmp, home) = home_with_aws(CREDENTIALS, CONFIG);
    let sandbox = Some("sandbox");

    // AWS_PROFILE resolved as `aws_profile`, whose client `profile` overrode the option in TS.
    let mut env = env_for(&home);
    env.insert("AWS_PROFILE".into(), "dev".into());
    let cfg = try_resolve_bedrock_auth_config_with_profile(&home, &env, None, sandbox)
        .unwrap()
        .unwrap();
    assert_eq!(access_key_id(&cfg.auth), "AKIADEVACCOUNT");

    // Env access keys are explicit client credentials and keep precedence.
    let mut env = env_for(&home);
    env.insert("AWS_ACCESS_KEY_ID".into(), "AKIAENVKEYS".into());
    env.insert("AWS_SECRET_ACCESS_KEY".into(), "ENVSECRET".into());
    let cfg = try_resolve_bedrock_auth_config_with_profile(&home, &env, None, sandbox)
        .unwrap()
        .unwrap();
    assert_eq!(access_key_id(&cfg.auth), "AKIAENVKEYS");
    assert!(cfg.has_configured_profile);
    // No configured region: the SDK took the configured profile's region.
    assert_eq!(cfg.region, "eu-west-1");

    // A saved `aws_default` connection ran the SDK chain with the profile set, which skips env
    // keys; the saved region still wins over the profile's region.
    let store = saved_store("aws_default", json!({ "region": "ap-south-1" }));
    let cfg = try_resolve_bedrock_auth_config_with_profile(&home, &env, Some(&store), sandbox)
        .unwrap()
        .unwrap();
    assert_eq!(access_key_id(&cfg.auth), "AKIASANDBOXACCOUNT");
    assert_eq!(cfg.region, "ap-south-1");
    assert_eq!(cfg.source, "saved");

    // An env bearer token keeps bearer auth; the ambient region beats the profile's region.
    let mut env = env_for(&home);
    env.insert("AWS_BEARER_TOKEN_BEDROCK".into(), "ABSK-env".into());
    env.insert("AWS_REGION".into(), "us-west-2".into());
    let cfg = try_resolve_bedrock_auth_config_with_profile(&home, &env, None, sandbox)
        .unwrap()
        .unwrap();
    assert!(matches!(cfg.auth, BedrockAuthMethod::BearerToken { .. }));
    assert_eq!(cfg.region, "us-west-2");
    assert!(cfg.has_configured_profile);

    // An unusable configured profile in the default chain is an error, not `[default]`.
    let err = try_resolve_bedrock_auth_config_with_profile(
        &home,
        &env_for(&home),
        Some(&saved_store("aws_default", json!({}))),
        Some("missing"),
    )
    .expect_err("missing profile must not fall back");
    assert!(err.contains("AWS profile 'missing'"), "{err}");
}
