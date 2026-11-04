//! Security: a workspace-controlled config (a cloned repo's `.cowork` config) can set nested
//! provider options such as `bedrock.coworkHome` and `bedrock.profile`. The cowork home decides
//! where `~/.aws/config` / `credentials` are read from, so a nested `bedrock.coworkHome` pointing
//! into the workspace would make Bedrock auth run the repo's own `credential_process` as the user.
//! Only the trusted top-level `coworkHome` the server injects may choose that home (TS resolved
//! the Bedrock home from the server's paths only); a workspace profile name is fine because it is
//! looked up in the trusted home's AWS files.
#![cfg(unix)]

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
use cowork_inference::{
    CanonicalMessage, ContentBlock, MessageRole, ProviderOpaqueMeta, ProviderTransportError,
    RequestPolicy, StepBudget,
};
use cowork_providers::bedrock::{
    BedrockConverseTransport, encode_eventstream_json_frame, resolve_bedrock_auth_config,
};
use cowork_providers::{ProviderStepRequest, ProviderTransport};
use serde_json::{Map, Value, json};
use tokio::net::TcpListener;

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
                turn_id: "turn-bdrk-workspace-home".into(),
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

const TRUSTED_CREDENTIALS: &str = "[default]\naws_access_key_id = AKIATRUSTEDDEFAULT\naws_secret_access_key = TRUSTEDSECRET\n\n[sandbox]\naws_access_key_id = AKIATRUSTEDSANDBOX\naws_secret_access_key = SANDBOXSECRET\n";

/// A workspace whose `.aws/config` runs a `credential_process` for every profile; the process
/// drops a marker file so the test can prove it never ran.
fn hostile_workspace() -> (tempfile::TempDir, PathBuf, PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    let tmp = tempfile::tempdir().unwrap();
    let ws = fs::canonicalize(tmp.path()).unwrap();
    let marker = ws.join("credential-process-ran");
    let script = ws.join("creds.sh");
    fs::write(
        &script,
        format!(
            "#!/bin/sh\ntouch '{}'\necho '{{\"Version\":1,\"AccessKeyId\":\"AKIAWORKSPACEPWNED\",\"SecretAccessKey\":\"x\"}}'\n",
            marker.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
    fs::create_dir_all(ws.join(".aws")).unwrap();
    fs::create_dir_all(ws.join(".cowork")).unwrap();
    fs::write(
        ws.join(".aws/config"),
        format!(
            "[default]\nregion = us-east-1\ncredential_process = {0}\n\n[profile sandbox]\nregion = us-east-1\ncredential_process = {0}\n",
            script.display()
        ),
    )
    .unwrap();
    (tmp, ws, marker)
}

fn hostile_options(
    trusted_home: &Path,
    workspace: &Path,
    profile: Option<&str>,
) -> Map<String, Value> {
    let mut nested = json!({
        "coworkHome": workspace.join(".cowork").to_string_lossy(),
        "region": "us-east-1",
    });
    if let Some(profile) = profile {
        nested["profile"] = json!(profile);
    }
    let mut opts = bedrock_options(nested);
    // The server always injects its trusted cowork home at the top level.
    opts.insert(
        "coworkHome".into(),
        Value::String(trusted_home.join(".cowork").to_string_lossy().into_owned()),
    );
    opts
}

#[tokio::test]
async fn nested_cowork_home_cannot_redirect_profile_resolution_into_the_workspace() {
    let (_trusted_tmp, trusted) = home_with_aws(TRUSTED_CREDENTIALS, CONFIG);
    let (_ws_tmp, workspace, marker) = hostile_workspace();
    let (base_url, seen) = spawn_mock().await;
    // The server pre-resolves the default chain from the trusted home.
    let pre_resolved = resolve_bedrock_auth_config(&trusted, &env_for(&trusted), None)
        .expect("trusted default profile resolves");
    let transport = BedrockConverseTransport::with_auth(pre_resolved);

    run_step(
        &transport,
        &base_url,
        hostile_options(&trusted, &workspace, Some("sandbox")),
    )
    .await
    .expect("workspace profile name resolves against the trusted home");
    assert!(
        !marker.exists(),
        "workspace credential_process must never run"
    );
    let authorization = last_authorization(&seen);
    assert!(
        authorization.contains("Credential=AKIATRUSTEDSANDBOX/"),
        "{authorization}"
    );
}

#[tokio::test]
async fn nested_cowork_home_is_ignored_for_transport_resolved_auth() {
    let (_trusted_tmp, trusted) = home_with_aws(TRUSTED_CREDENTIALS, CONFIG);
    let (_ws_tmp, workspace, marker) = hostile_workspace();
    let (base_url, seen) = spawn_mock().await;
    let transport = BedrockConverseTransport::new();

    run_step(
        &transport,
        &base_url,
        hostile_options(&trusted, &workspace, None),
    )
    .await
    .expect("trusted home's default profile resolves");
    assert!(
        !marker.exists(),
        "workspace credential_process must never run"
    );
    let authorization = last_authorization(&seen);
    assert!(
        authorization.contains("Credential=AKIATRUSTEDDEFAULT/"),
        "{authorization}"
    );
}
