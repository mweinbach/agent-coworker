//! Regression tests: an explicitly selected Bedrock AWS profile resolves through
//! `aws-config` (static keys, `credential_process`, STS assume-role chains, SSO),
//! reports actionable errors, and never falls back to unrelated credentials.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use cowork_config::{ConnectionMode, ConnectionStore, ProviderName};
use cowork_providers::bedrock::{
    BedrockAuthMethod, resolve_bedrock_auth_config, try_resolve_bedrock_auth_config,
};
use serde_json::json;

fn home_with_aws(credentials: &str, config: &str) -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let home = fs::canonicalize(tmp.path()).unwrap();
    fs::create_dir_all(home.join(".aws")).unwrap();
    fs::write(home.join(".aws/credentials"), credentials).unwrap();
    fs::write(home.join(".aws/config"), config).unwrap();
    (tmp, home)
}

fn env_for(home: &Path) -> HashMap<String, String> {
    let mut env = HashMap::new();
    env.insert("HOME".into(), home.to_string_lossy().into_owned());
    env
}

fn saved_profile_store(profile: &str) -> ConnectionStore {
    serde_json::from_value(json!({
        "version": 1,
        "updatedAt": "2026-01-01T00:00:00.000Z",
        "services": {
            "bedrock": {
                "service": "bedrock",
                "mode": "credentials",
                "methodId": "aws_profile",
                "values": { "profile": profile },
                "updatedAt": "2026-01-01T00:00:00.000Z"
            }
        }
    }))
    .expect("connection store fixture")
}

const DEFAULT_STATIC: &str =
    "[default]\naws_access_key_id = AKIADEFAULTUNRELATED\naws_secret_access_key = DEFAULTSECRET\n";

#[test]
fn saved_sso_profile_without_login_errors_actionably_and_does_not_fall_back_to_default() {
    let (_tmp, home) = home_with_aws(
        DEFAULT_STATIC,
        "[profile work]\nsso_session = corp\nsso_account_id = 123456789012\nsso_role_name = Dev\nregion = us-west-2\n",
    );
    let mut env = env_for(&home);
    env.insert("AWS_ACCESS_KEY_ID".into(), "AKIAENVUNRELATED".into());
    env.insert("AWS_SECRET_ACCESS_KEY".into(), "ENVSECRET".into());
    let store = saved_profile_store("work");
    assert_eq!(
        store.services.get(&ProviderName::Bedrock).map(|c| &c.mode),
        Some(&ConnectionMode::Credentials)
    );

    // SSO is now resolved by aws-config; with no `[sso-session corp]` / cached token it fails
    // with aws-config's reason plus the login hint, and never substitutes other credentials.
    let err = try_resolve_bedrock_auth_config(&home, &env, Some(&store))
        .expect_err("unusable SSO profile must be rejected, not replaced");
    assert!(err.contains("AWS profile 'work'"), "{err}");
    assert!(err.contains("aws sso login --profile work"), "{err}");
    assert!(!err.contains("export-credentials"), "{err}");
    // The Option API must not silently pick up env/default keys either.
    assert!(resolve_bedrock_auth_config(&home, &env, Some(&store)).is_none());
}

/// Minimal STS mock: records each request (Authorization header + form body) and answers
/// `AssumeRole` for `Admin`, `AccessDenied` (403) for anything else.
/// `(Authorization header, form body)` of each request the mock STS received.
type SeenStsRequests = Arc<Mutex<Vec<(String, String)>>>;

fn spawn_mock_sts() -> (String, SeenStsRequests) {
    use axum::http::{HeaderMap, StatusCode};
    let seen: SeenStsRequests = Arc::default();
    let seen_srv = Arc::clone(&seen);
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async move {
            let app = axum::Router::new().fallback(move |headers: HeaderMap, body: String| {
                let seen = Arc::clone(&seen_srv);
                async move {
                    let auth = headers
                        .get("authorization")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or_default()
                        .to_owned();
                    seen.lock().unwrap().push((auth, body.clone()));
                    if body.contains("Action=AssumeRole") && body.contains("role%2FAdmin") {
                        (
                            StatusCode::OK,
                            r#"<AssumeRoleResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
  <AssumeRoleResult>
    <AssumedRoleUser>
      <AssumedRoleId>AROAEXAMPLE:cowork</AssumedRoleId>
      <Arn>arn:aws:sts::123456789012:assumed-role/Admin/cowork</Arn>
    </AssumedRoleUser>
    <Credentials>
      <AccessKeyId>ASIAASSUMED</AccessKeyId>
      <SecretAccessKey>ASSUMEDSECRET</SecretAccessKey>
      <SessionToken>ASSUMEDTOKEN</SessionToken>
      <Expiration>2999-01-01T00:00:00Z</Expiration>
    </Credentials>
  </AssumeRoleResult>
  <ResponseMetadata><RequestId>req-1</RequestId></ResponseMetadata>
</AssumeRoleResponse>"#,
                        )
                    } else {
                        (
                            StatusCode::FORBIDDEN,
                            r#"<ErrorResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
  <Error><Type>Sender</Type><Code>AccessDenied</Code><Message>mock sts denied this role</Message></Error>
  <RequestId>req-2</RequestId>
</ErrorResponse>"#,
                        )
                    }
                }
            });
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            tx.send(listener.local_addr().unwrap()).unwrap();
            axum::serve(listener, app).await.unwrap();
        });
    });
    let addr = rx.recv().unwrap();
    (format!("http://{addr}"), seen)
}

#[test]
fn saved_assume_role_profile_resolves_via_sts_with_source_profile_credentials() {
    let (endpoint, seen) = spawn_mock_sts();
    let (_tmp, home) = home_with_aws(
        &format!(
            "{DEFAULT_STATIC}[base]\naws_access_key_id = AKIABASESOURCE\naws_secret_access_key = BASESECRET\n"
        ),
        &format!(
            "[profile admin]\nrole_arn = arn:aws:iam::123456789012:role/Admin\nsource_profile = base\nrole_session_name = cowork\nregion = eu-central-1\nendpoint_url = {endpoint}\n"
        ),
    );
    let store = saved_profile_store("admin");
    for _ in 0..2 {
        let cfg = try_resolve_bedrock_auth_config(&home, &env_for(&home), Some(&store))
            .expect("assume-role profile resolves")
            .expect("credentials");
        assert_eq!(cfg.method_id, "aws_profile");
        assert_eq!(cfg.region, "eu-central-1");
        assert_eq!(
            cfg.auth,
            BedrockAuthMethod::SigV4 {
                access_key_id: "ASIAASSUMED".into(),
                secret_access_key: "ASSUMEDSECRET".into(),
                session_token: Some("ASSUMEDTOKEN".into()),
            }
        );
    }
    let seen = seen.lock().unwrap();
    assert_eq!(
        seen.len(),
        1,
        "assumed-role credentials cached until expiry"
    );
    let (auth, body) = &seen[0];
    assert!(
        auth.contains("Credential=AKIABASESOURCE/"),
        "STS call must be signed with the source_profile keys: {auth}"
    );
    assert!(body.contains("RoleSessionName=cowork"), "{body}");
}

#[test]
fn saved_assume_role_profile_sts_denial_errors_without_fallback() {
    let (endpoint, _seen) = spawn_mock_sts();
    let (_tmp, home) = home_with_aws(
        DEFAULT_STATIC,
        &format!(
            "[profile denied]\nrole_arn = arn:aws:iam::123456789012:role/Nope\nsource_profile = default\nendpoint_url = {endpoint}\n"
        ),
    );
    let mut env = env_for(&home);
    env.insert("AWS_ACCESS_KEY_ID".into(), "AKIAENVUNRELATED".into());
    env.insert("AWS_SECRET_ACCESS_KEY".into(), "ENVSECRET".into());
    let store = saved_profile_store("denied");
    let err = try_resolve_bedrock_auth_config(&home, &env, Some(&store))
        .expect_err("STS denial must not fall back");
    assert!(err.contains("AWS profile 'denied'"), "{err}");
    assert!(err.contains("mock sts denied this role"), "{err}");
    assert!(resolve_bedrock_auth_config(&home, &env, Some(&store)).is_none());
}

#[test]
fn saved_missing_profile_errors_instead_of_using_default() {
    let (_tmp, home) = home_with_aws(DEFAULT_STATIC, "");
    let err = try_resolve_bedrock_auth_config(
        &home,
        &env_for(&home),
        Some(&saved_profile_store("ghost")),
    )
    .expect_err("missing profile must be rejected");
    assert!(
        err.contains("'ghost'") && err.contains("not found"),
        "{err}"
    );
}

#[test]
fn aws_profile_env_selecting_sso_profile_does_not_fall_back_to_default() {
    let (_tmp, home) = home_with_aws(
        DEFAULT_STATIC,
        "[profile work]\nsso_start_url = https://corp.awsapps.com/start\n",
    );
    let mut env = env_for(&home);
    env.insert("AWS_PROFILE".into(), "work".into());
    let err =
        try_resolve_bedrock_auth_config(&home, &env, None).expect_err("must not use [default]");
    assert!(err.contains("AWS profile 'work'"), "{err}");
    assert!(err.contains("aws sso login --profile work"), "{err}");
}

#[cfg(unix)]
#[test]
fn saved_credential_process_profile_resolves_and_caches_until_expiration() {
    let tmp_scripts = tempfile::tempdir().unwrap();
    let counter = tmp_scripts.path().join("count");
    let script = tmp_scripts.path().join("creds.sh");
    fs::write(
        &script,
        format!(
            "#!/bin/sh\necho x >> '{}'\nprintf '%s' '{{\"Version\":1,\"AccessKeyId\":\"AKIAPROCESS\",\"SecretAccessKey\":\"PROCSECRET\",\"SessionToken\":\"PROCTOKEN\",\"Expiration\":\"2999-01-01T00:00:00Z\"}}'\n",
            counter.display()
        ),
    )
    .unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
    }
    let (_tmp, home) = home_with_aws(
        DEFAULT_STATIC,
        &format!(
            "[profile proc]\ncredential_process = \"{}\" --profile proc\nregion = eu-west-1\n",
            script.display()
        ),
    );
    let env = env_for(&home);
    let store = saved_profile_store("proc");

    for _ in 0..3 {
        let cfg = try_resolve_bedrock_auth_config(&home, &env, Some(&store))
            .unwrap()
            .expect("credential_process profile resolves");
        assert_eq!(cfg.method_id, "aws_profile");
        assert_eq!(cfg.region, "eu-west-1");
        assert_eq!(
            cfg.auth,
            BedrockAuthMethod::SigV4 {
                access_key_id: "AKIAPROCESS".into(),
                secret_access_key: "PROCSECRET".into(),
                session_token: Some("PROCTOKEN".into()),
            }
        );
    }
    let runs = fs::read_to_string(&counter).unwrap().lines().count();
    assert_eq!(runs, 1, "credentials cached until expiration");
}

#[cfg(unix)]
#[test]
fn failing_credential_process_reports_error_without_fallback() {
    let (_tmp, home) = home_with_aws(
        DEFAULT_STATIC,
        "[profile broken]\ncredential_process = sh -c 'echo nope >&2; exit 3'\n",
    );
    let err = try_resolve_bedrock_auth_config(
        &home,
        &env_for(&home),
        Some(&saved_profile_store("broken")),
    )
    .expect_err("failing process must not fall back");
    assert!(
        err.contains("credential_process failed") && err.contains("nope"),
        "{err}"
    );
}

#[test]
fn static_key_profile_still_resolves() {
    let (_tmp, home) = home_with_aws(
        "[dev]\naws_access_key_id = AKIADEV\naws_secret_access_key = DEVSECRET\n",
        "",
    );
    let cfg =
        try_resolve_bedrock_auth_config(&home, &env_for(&home), Some(&saved_profile_store("dev")))
            .unwrap()
            .unwrap();
    assert_eq!(
        cfg.auth,
        BedrockAuthMethod::SigV4 {
            access_key_id: "AKIADEV".into(),
            secret_access_key: "DEVSECRET".into(),
            session_token: None,
        }
    );
}
