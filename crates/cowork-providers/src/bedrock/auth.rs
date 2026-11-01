use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::sync::LazyLock;
use std::time::{Duration, Instant, SystemTime};

use aws_config::Region;
use aws_config::imds::credentials::ImdsCredentialsProvider;
use aws_config::profile::ProfileFileCredentialsProvider;
use aws_config::provider_config::ProviderConfig;
use aws_config::web_identity_token::{StaticConfiguration, WebIdentityTokenCredentialsProvider};
use aws_credential_types::Credentials;
use aws_credential_types::provider::ProvideCredentials;
use aws_runtime::env_config::file::{EnvConfigFileKind, EnvConfigFiles};
use aws_sigv4::http_request::{SignableBody, SignableRequest, SigningSettings, sign};
use aws_sigv4::sign::v4;
use aws_smithy_runtime_api::client::identity::Identity;
use cowork_config::{ConnectionMode, ConnectionStore, ProviderName};
use cowork_inference::ProviderTransportError;
use reqwest::header::{AUTHORIZATION, HeaderMap, HeaderName, HeaderValue};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BedrockAuthMethod {
    BearerToken {
        token: String,
    },
    SigV4 {
        access_key_id: String,
        secret_access_key: String,
        session_token: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BedrockAuthConfig {
    pub method_id: String,
    pub source: String,
    pub region: String,
    pub has_configured_region: bool,
    pub has_configured_profile: bool,
    pub auth: BedrockAuthMethod,
}

/// The few profile fields Cowork reads itself: existence, region, and whether the profile names
/// any credential source. Credentials are always resolved by `aws-config`.
#[derive(Debug, Default, Clone)]
struct AwsIniProfile {
    access_key_id: Option<String>,
    secret_access_key: Option<String>,
    region: Option<String>,
    credential_process: Option<String>,
    /// First profile key that delegates to an SSO / STS AssumeRole / web-identity provider.
    delegated_source_key: Option<String>,
}

/// Profile keys that select an SSO, STS AssumeRole, or web-identity credential provider.
const DELEGATED_PROFILE_SOURCE_KEYS: &[&str] = &[
    "sso_session",
    "sso_start_url",
    "sso_account_id",
    "sso_role_name",
    "role_arn",
    "source_profile",
    "credential_source",
    "web_identity_token_file",
];

const SSO_PROFILE_KEYS: &[&str] = &[
    "sso_session",
    "sso_start_url",
    "sso_account_id",
    "sso_role_name",
];

/// Strip one pair of matching surrounding quotes, but only when the quote
/// character does not also appear inside the value (so a quoted executable in
/// `credential_process = "/path with space/bin" --flag` survives intact).
fn strip_enclosing_quotes(value: &str) -> &str {
    for q in ['"', '\''] {
        if value.len() >= 2
            && value.starts_with(q)
            && value.ends_with(q)
            && !value[1..value.len() - 1].contains(q)
        {
            return &value[1..value.len() - 1];
        }
    }
    value
}

fn parse_aws_ini_sections(
    raw: &str,
    is_config_file: bool,
) -> HashMap<String, HashMap<String, String>> {
    let mut sections: HashMap<String, HashMap<String, String>> = HashMap::new();
    let mut current: Option<String> = None;

    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with(';') {
            continue;
        }
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            let mut name = trimmed[1..trimmed.len() - 1].trim().to_string();
            if is_config_file && let Some(rest) = name.strip_prefix("profile ") {
                name = rest.trim().to_string();
            }
            current = Some(name);
            continue;
        }
        if let (Some(sec), Some((k, v))) = (current.as_ref(), trimmed.split_once('=')) {
            let key = k.trim().to_ascii_lowercase();
            let val = strip_enclosing_quotes(v.trim()).to_string();
            if !key.is_empty() && !val.is_empty() {
                sections.entry(sec.clone()).or_default().insert(key, val);
            }
        }
    }

    sections
}

fn load_aws_profile_from_disk(homedir: &Path, profile_name: &str) -> Option<AwsIniProfile> {
    let aws_dir = homedir.join(".aws");
    let creds_sections = std::fs::read_to_string(aws_dir.join("credentials"))
        .ok()
        .map(|s| parse_aws_ini_sections(&s, false))
        .unwrap_or_default();
    let config_sections = std::fs::read_to_string(aws_dir.join("config"))
        .ok()
        .map(|s| parse_aws_ini_sections(&s, true))
        .unwrap_or_default();

    let cred_map = creds_sections.get(profile_name);
    let cfg_map = config_sections.get(profile_name);
    if cred_map.is_none() && cfg_map.is_none() {
        return None;
    }

    let get_field = |key: &str| -> Option<String> {
        cred_map
            .and_then(|m| m.get(key))
            .or_else(|| cfg_map.and_then(|m| m.get(key)))
            .cloned()
    };

    Some(AwsIniProfile {
        access_key_id: get_field("aws_access_key_id"),
        secret_access_key: get_field("aws_secret_access_key"),
        region: get_field("region"),
        credential_process: get_field("credential_process"),
        delegated_source_key: DELEGATED_PROFILE_SOURCE_KEYS
            .iter()
            .find(|k| get_field(k).is_some())
            .map(|k| (*k).to_owned()),
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProfileCredentials {
    access_key_id: String,
    secret_access_key: String,
    session_token: Option<String>,
}

#[derive(Debug, Clone)]
struct CachedProfileCredentials {
    credentials: ProfileCredentials,
    /// Refresh after this instant (expiration minus a safety margin).
    refresh_at: Instant,
}

/// Resolved profile credentials keyed by home dir, profile, STS region and a fingerprint of the
/// `~/.aws` files, so edits to the profile take effect immediately while SSO / STS / process
/// round-trips happen at most once per credential lifetime.
static PROFILE_CREDENTIALS_CACHE: LazyLock<
    parking_lot::Mutex<HashMap<String, CachedProfileCredentials>>,
> = LazyLock::new(|| parking_lot::Mutex::new(HashMap::new()));

/// Upper bound for one profile resolution (credential_process, SSO, STS AssumeRole chains).
const PROFILE_RESOLUTION_TIMEOUT: Duration = Duration::from_secs(60);
/// Refresh credentials this long before their reported expiration.
const PROFILE_CREDENTIALS_REFRESH_MARGIN: Duration = Duration::from_secs(5 * 60);
/// Credentials without an expiration are long-term; re-resolve periodically anyway so rotated
/// keys (e.g. a `credential_process` without `Expiration`) are picked up.
const PROFILE_CREDENTIALS_NON_EXPIRING_TTL: Duration = Duration::from_secs(15 * 60);

fn aws_profile_files_fingerprint(homedir: &Path) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    for name in ["config", "credentials"] {
        std::fs::read(homedir.join(".aws").join(name))
            .ok()
            .hash(&mut hasher);
    }
    hasher.finish()
}

/// Resolves `profile_name` through `aws-config`'s profile credentials provider (static keys,
/// `credential_process`, SSO, STS AssumeRole via `source_profile` / `credential_source`, and
/// web identity), reading only `<homedir>/.aws/config` and `<homedir>/.aws/credentials`.
///
/// The public resolver is synchronous and may be called from inside a Tokio runtime, so the
/// async provider runs on a dedicated thread with its own current-thread runtime.
fn load_profile_credentials_via_aws_config(
    homedir: &Path,
    profile_name: &str,
    sts_region: &str,
) -> Result<Credentials, String> {
    let config_file = homedir.join(".aws").join("config");
    let credentials_file = homedir.join(".aws").join("credentials");
    let profile_name = profile_name.to_owned();
    let sts_region = sts_region.to_owned();
    run_credential_resolver("cowork-bedrock-aws-profile", move || async move {
        let files = EnvConfigFiles::builder()
            .with_file(EnvConfigFileKind::Config, config_file)
            .with_file(EnvConfigFileKind::Credentials, credentials_file)
            .build();
        let provider_config =
            ProviderConfig::without_region().with_region(Some(Region::new(sts_region)));
        let provider = ProfileFileCredentialsProvider::builder()
            .configure(&provider_config)
            .profile_files(files)
            .profile_name(profile_name)
            .build();
        provide_with_timeout(&provider).await
    })
}

/// Runs an async credential resolution to completion from the synchronous resolver. The public
/// resolver may be called from inside a Tokio runtime, so the future runs on a dedicated thread
/// with its own current-thread runtime.
fn run_credential_resolver<F, Fut>(thread_name: &str, make_future: F) -> Result<Credentials, String>
where
    F: FnOnce() -> Fut + Send + 'static,
    Fut: std::future::Future<Output = Result<Credentials, String>>,
{
    std::thread::Builder::new()
        .name(thread_name.to_owned())
        .spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|e| format!("could not start credential runtime: {e}"))?;
            runtime.block_on(make_future())
        })
        .map_err(|e| format!("could not start credential resolver thread: {e}"))?
        .join()
        .map_err(|_| "credential resolver thread panicked".to_owned())?
}

async fn provide_with_timeout(provider: &impl ProvideCredentials) -> Result<Credentials, String> {
    match tokio::time::timeout(PROFILE_RESOLUTION_TIMEOUT, provider.provide_credentials()).await {
        Ok(Ok(credentials)) => Ok(credentials),
        Ok(Err(err)) => Err(error_chain(&err)),
        Err(_) => Err(format!(
            "timed out after {}s",
            PROFILE_RESOLUTION_TIMEOUT.as_secs()
        )),
    }
}

/// Joins an error's `Display` source chain (skipping repeats), without the verbose `Debug`
/// dump `DisplayErrorContext` appends (raw HTTP responses etc.).
fn error_chain(err: &(dyn std::error::Error + 'static)) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut current = Some(err);
    while let Some(e) = current {
        let text = e.to_string();
        if !text.is_empty() && parts.last() != Some(&text) {
            parts.push(text);
        }
        current = e.source();
    }
    parts.join(": ")
}

/// Resolve credentials for an explicitly selected profile. Never falls back to
/// other credentials: an unusable profile is an error naming the fix.
fn resolve_profile_credentials(
    homedir: &Path,
    profile_name: &str,
    ini: &AwsIniProfile,
    sts_region: &str,
) -> Result<ProfileCredentials, String> {
    let key = format!(
        "{}\0{profile_name}\0{sts_region}\0{:x}",
        homedir.display(),
        aws_profile_files_fingerprint(homedir)
    );
    if let Some(hit) = PROFILE_CREDENTIALS_CACHE.lock().get(&key)
        && Instant::now() < hit.refresh_at
    {
        return Ok(hit.credentials.clone());
    }

    let credentials = load_profile_credentials_via_aws_config(homedir, profile_name, sts_region)
        .map_err(|detail| profile_resolution_error(profile_name, ini, &detail))?;
    cache_resolved_credentials(key, &credentials)
        .map_err(|detail| profile_resolution_error(profile_name, ini, detail))
}

/// Caches freshly resolved credentials until shortly before they expire (or for
/// [`PROFILE_CREDENTIALS_NON_EXPIRING_TTL`] when they carry no expiration), so expiring role
/// credentials are re-resolved instead of being reused forever.
fn cache_resolved_credentials(
    key: String,
    credentials: &Credentials,
) -> Result<ProfileCredentials, &'static str> {
    let now = Instant::now();
    let refresh_at = match credentials.expiry() {
        Some(expires) => {
            let remaining = expires
                .duration_since(SystemTime::now())
                .unwrap_or_default();
            if remaining.is_zero() {
                return Err("the credential source returned already-expired credentials");
            }
            now + remaining.saturating_sub(PROFILE_CREDENTIALS_REFRESH_MARGIN)
        }
        None => now + PROFILE_CREDENTIALS_NON_EXPIRING_TTL,
    };
    let resolved = ProfileCredentials {
        access_key_id: credentials.access_key_id().to_owned(),
        secret_access_key: credentials.secret_access_key().to_owned(),
        session_token: credentials.session_token().map(ToOwned::to_owned),
    };
    PROFILE_CREDENTIALS_CACHE.lock().insert(
        key,
        CachedProfileCredentials {
            credentials: resolved.clone(),
            refresh_at,
        },
    );
    Ok(resolved)
}

fn profile_resolution_error(profile_name: &str, ini: &AwsIniProfile, detail: &str) -> String {
    let source = if ini.credential_process.is_some() {
        "credential_process failed"
    } else {
        "could not resolve credentials"
    };
    let mut message = format!("AWS profile '{profile_name}': {source}: {detail}");
    if ini
        .delegated_source_key
        .as_deref()
        .is_some_and(|k| SSO_PROFILE_KEYS.contains(&k))
    {
        message.push_str(&format!(
            "\n\nIf the SSO session has expired, run `aws sso login --profile {profile_name}` and retry."
        ));
    }
    message
}

fn env_trimmed<'a>(env: &'a HashMap<String, String>, key: &str) -> Option<&'a str> {
    env.get(key)
        .map(String::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// Resolve Bedrock auth, or `None` when nothing is configured. A profile that
/// is explicitly selected but unusable yields `None` (logged) rather than
/// falling back to unrelated credentials; use
/// [`try_resolve_bedrock_auth_config`] to surface the actionable reason.
pub fn resolve_bedrock_auth_config(
    homedir: &Path,
    env: &HashMap<String, String>,
    store: Option<&ConnectionStore>,
) -> Option<BedrockAuthConfig> {
    match try_resolve_bedrock_auth_config(homedir, env, store) {
        Ok(cfg) => cfg,
        Err(reason) => {
            tracing::warn!("Amazon Bedrock credentials unavailable: {reason}");
            None
        }
    }
}

/// Like [`resolve_bedrock_auth_config`], but returns `Err` with an actionable
/// message when an explicitly selected AWS profile (saved `aws_profile`
/// connection or `AWS_PROFILE`) cannot be used. Profiles resolve through
/// `aws-config` (static keys, `credential_process`, SSO, STS assume-role, web identity).
/// With no keys or profile, ambient role credentials (EKS web identity, ECS task role / EKS Pod
/// Identity, EC2 instance role) advertised by `env` are resolved; `Err` when they are advertised
/// but cannot be fetched.
pub fn try_resolve_bedrock_auth_config(
    homedir: &Path,
    env: &HashMap<String, String>,
    store: Option<&ConnectionStore>,
) -> Result<Option<BedrockAuthConfig>, String> {
    let ambient_region = env_trimmed(env, "AWS_REGION")
        .or_else(|| env_trimmed(env, "AWS_DEFAULT_REGION"))
        .map(ToOwned::to_owned);

    // 1. Saved connection store takes precedence
    if let Some(conn) = store.and_then(|s| s.services.get(&ProviderName::Bedrock))
        && let Some(method_id) = conn
            .method_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .or_else(|| (conn.mode == ConnectionMode::ApiKey).then_some("api_key"))
    {
        let vals = conn.values.clone().unwrap_or_default();
        let val_trimmed = |k: &str| -> Option<String> {
            vals.get(k)
                .map(String::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToOwned::to_owned)
        };
        let explicit_region = val_trimmed("region");
        let has_configured_region = explicit_region.is_some() || ambient_region.is_some();

        match method_id {
            "api_key" => {
                if let Some(token) = val_trimmed("apiKey").or_else(|| conn.api_key.clone()) {
                    return Ok(Some(BedrockAuthConfig {
                        method_id: "api_key".into(),
                        source: "saved".into(),
                        region: explicit_region
                            .or(ambient_region)
                            .unwrap_or_else(|| "us-east-1".into()),
                        has_configured_region,
                        has_configured_profile: false,
                        auth: BedrockAuthMethod::BearerToken { token },
                    }));
                }
            }
            "aws_keys" => {
                if let (Some(ak), Some(sk)) =
                    (val_trimmed("accessKeyId"), val_trimmed("secretAccessKey"))
                {
                    return Ok(Some(BedrockAuthConfig {
                        method_id: "aws_keys".into(),
                        source: "saved".into(),
                        region: explicit_region
                            .or(ambient_region)
                            .unwrap_or_else(|| "us-east-1".into()),
                        has_configured_region,
                        has_configured_profile: false,
                        auth: BedrockAuthMethod::SigV4 {
                            access_key_id: ak,
                            secret_access_key: sk,
                            session_token: val_trimmed("sessionToken"),
                        },
                    }));
                }
            }
            "aws_profile" => {
                if let Some(prof_name) = val_trimmed("profile") {
                    // The profile is explicitly selected: never fall through to
                    // unrelated ambient credentials if it cannot be used.
                    let ini = load_aws_profile_from_disk(homedir, &prof_name).ok_or_else(|| {
                        format!(
                            "AWS profile '{prof_name}' was not found in ~/.aws/config or ~/.aws/credentials."
                        )
                    })?;
                    let region = explicit_region
                        .clone()
                        .or(ini.region.clone())
                        .or(ambient_region.clone())
                        .unwrap_or_else(|| "us-east-1".into());
                    let creds = resolve_profile_credentials(homedir, &prof_name, &ini, &region)?;
                    return Ok(Some(BedrockAuthConfig {
                        method_id: "aws_profile".into(),
                        source: "saved".into(),
                        region,
                        has_configured_region: explicit_region.is_some()
                            || ini.region.is_some()
                            || ambient_region.is_some(),
                        has_configured_profile: true,
                        auth: BedrockAuthMethod::SigV4 {
                            access_key_id: creds.access_key_id,
                            secret_access_key: creds.secret_access_key,
                            session_token: creds.session_token,
                        },
                    }));
                }
            }
            "aws_default" => {
                if let (Some(ak), Some(sk)) = (
                    env_trimmed(env, "AWS_ACCESS_KEY_ID"),
                    env_trimmed(env, "AWS_SECRET_ACCESS_KEY"),
                ) {
                    return Ok(Some(BedrockAuthConfig {
                        method_id: "aws_default".into(),
                        source: "saved".into(),
                        region: explicit_region
                            .or(ambient_region)
                            .unwrap_or_else(|| "us-east-1".into()),
                        has_configured_region,
                        has_configured_profile: false,
                        auth: BedrockAuthMethod::SigV4 {
                            access_key_id: ak.to_string(),
                            secret_access_key: sk.to_string(),
                            session_token: env_trimmed(env, "AWS_SESSION_TOKEN")
                                .map(ToOwned::to_owned),
                        },
                    }));
                }
                if let Some(ini) = load_aws_profile_from_disk(homedir, "default") {
                    let region = explicit_region
                        .clone()
                        .or(ambient_region.clone())
                        .or(ini.region.clone())
                        .unwrap_or_else(|| "us-east-1".into());
                    if let Some(creds) = default_profile_credentials(homedir, &ini, &region)? {
                        return Ok(Some(BedrockAuthConfig {
                            method_id: "aws_default".into(),
                            source: "saved".into(),
                            region,
                            has_configured_region: explicit_region.is_some()
                                || ambient_region.is_some()
                                || ini.region.is_some(),
                            has_configured_profile: false,
                            auth: BedrockAuthMethod::SigV4 {
                                access_key_id: creds.access_key_id,
                                secret_access_key: creds.secret_access_key,
                                session_token: creds.session_token,
                            },
                        }));
                    }
                }
                let region = explicit_region
                    .clone()
                    .or(ambient_region.clone())
                    .unwrap_or_else(|| "us-east-1".into());
                if let Some(creds) = resolve_ambient_role_credentials(env, &region)? {
                    return Ok(Some(ambient_role_auth_config(
                        "saved",
                        region,
                        has_configured_region,
                        creds,
                    )));
                }
            }
            _ => {}
        }
    }

    // 2. Ambient environment + ~/.aws
    if let Some(bearer) = env_trimmed(env, "AWS_BEARER_TOKEN_BEDROCK") {
        return Ok(Some(BedrockAuthConfig {
            method_id: "api_key".into(),
            source: "env".into(),
            has_configured_region: ambient_region.is_some(),
            region: ambient_region.unwrap_or_else(|| "us-east-1".into()),
            has_configured_profile: false,
            auth: BedrockAuthMethod::BearerToken {
                token: bearer.to_string(),
            },
        }));
    }

    if let (Some(ak), Some(sk)) = (
        env_trimmed(env, "AWS_ACCESS_KEY_ID"),
        env_trimmed(env, "AWS_SECRET_ACCESS_KEY"),
    ) {
        return Ok(Some(BedrockAuthConfig {
            method_id: "aws_keys".into(),
            source: "env".into(),
            has_configured_region: ambient_region.is_some(),
            region: ambient_region.unwrap_or_else(|| "us-east-1".into()),
            has_configured_profile: false,
            auth: BedrockAuthMethod::SigV4 {
                access_key_id: ak.to_string(),
                secret_access_key: sk.to_string(),
                session_token: env_trimmed(env, "AWS_SESSION_TOKEN").map(ToOwned::to_owned),
            },
        }));
    }

    if let Some(profile_name) = env_trimmed(env, "AWS_PROFILE") {
        // AWS_PROFILE explicitly selects a profile; like the AWS SDK chain,
        // never substitute the [default] profile when it is unusable.
        let ini = load_aws_profile_from_disk(homedir, profile_name).ok_or_else(|| {
            format!(
                "AWS_PROFILE is set to '{profile_name}', but that profile was not found in ~/.aws/config or ~/.aws/credentials."
            )
        })?;
        let has_reg = ambient_region.is_some() || ini.region.is_some();
        let region = ambient_region
            .or(ini.region.clone())
            .unwrap_or_else(|| "us-east-1".into());
        let creds = resolve_profile_credentials(homedir, profile_name, &ini, &region)?;
        return Ok(Some(BedrockAuthConfig {
            method_id: "aws_profile".into(),
            source: "env".into(),
            region,
            has_configured_region: has_reg,
            has_configured_profile: true,
            auth: BedrockAuthMethod::SigV4 {
                access_key_id: creds.access_key_id,
                secret_access_key: creds.secret_access_key,
                session_token: creds.session_token,
            },
        }));
    }

    if let Some(ini) = load_aws_profile_from_disk(homedir, "default") {
        let has_reg = ambient_region.is_some() || ini.region.is_some();
        let region = ambient_region
            .clone()
            .or(ini.region.clone())
            .unwrap_or_else(|| "us-east-1".into());
        if let Some(creds) = default_profile_credentials(homedir, &ini, &region)? {
            return Ok(Some(BedrockAuthConfig {
                method_id: "aws_default".into(),
                source: "env".into(),
                region,
                has_configured_region: has_reg,
                has_configured_profile: false,
                auth: BedrockAuthMethod::SigV4 {
                    access_key_id: creds.access_key_id,
                    secret_access_key: creds.secret_access_key,
                    session_token: creds.session_token,
                },
            }));
        }
    }

    // 3. Ambient role credentials from the AWS default chain (EKS web identity, ECS task role /
    // EKS Pod Identity, EC2 instance role), as TS delegated `aws_default` to the SDK chain.
    let has_configured_region = ambient_region.is_some();
    let region = ambient_region.unwrap_or_else(|| "us-east-1".into());
    if let Some(creds) = resolve_ambient_role_credentials(env, &region)? {
        return Ok(Some(ambient_role_auth_config(
            "env",
            region,
            has_configured_region,
            creds,
        )));
    }

    Ok(None)
}

fn ambient_role_auth_config(
    source: &str,
    region: String,
    has_configured_region: bool,
    creds: ProfileCredentials,
) -> BedrockAuthConfig {
    BedrockAuthConfig {
        method_id: "aws_default".into(),
        source: source.into(),
        region,
        has_configured_region,
        has_configured_profile: false,
        auth: BedrockAuthMethod::SigV4 {
            access_key_id: creds.access_key_id,
            secret_access_key: creds.secret_access_key,
            session_token: creds.session_token,
        },
    }
}

/// Credentials from the `[default]` profile: `Ok(None)` when it carries no
/// credential source at all (e.g. only a region), so resolution continues.
fn default_profile_credentials(
    homedir: &Path,
    ini: &AwsIniProfile,
    sts_region: &str,
) -> Result<Option<ProfileCredentials>, String> {
    let has_source = ini.delegated_source_key.is_some()
        || ini.credential_process.is_some()
        || (ini.access_key_id.is_some() && ini.secret_access_key.is_some());
    if !has_source {
        return Ok(None);
    }
    resolve_profile_credentials(homedir, "default", ini, sts_region).map(Some)
}

const ENV_WEB_IDENTITY_TOKEN_FILE: &str = "AWS_WEB_IDENTITY_TOKEN_FILE";
const ENV_ROLE_ARN: &str = "AWS_ROLE_ARN";
const ENV_ROLE_SESSION_NAME: &str = "AWS_ROLE_SESSION_NAME";
const ENV_CONTAINER_RELATIVE_URI: &str = "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI";
const ENV_CONTAINER_FULL_URI: &str = "AWS_CONTAINER_CREDENTIALS_FULL_URI";
const ENV_CONTAINER_AUTH_TOKEN: &str = "AWS_CONTAINER_AUTHORIZATION_TOKEN";
const ENV_CONTAINER_AUTH_TOKEN_FILE: &str = "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE";
const ENV_EC2_METADATA_DISABLED: &str = "AWS_EC2_METADATA_DISABLED";
const ENV_EC2_METADATA_ENDPOINT: &str = "AWS_EC2_METADATA_SERVICE_ENDPOINT";
const ENV_EXECUTION_ENV: &str = "AWS_EXECUTION_ENV";

/// Every env var that selects or parameterizes an ambient role-credential source; their values
/// key the credential cache so a changed deployment environment never reuses old credentials.
const AMBIENT_ROLE_ENV_KEYS: &[&str] = &[
    ENV_WEB_IDENTITY_TOKEN_FILE,
    ENV_ROLE_ARN,
    ENV_ROLE_SESSION_NAME,
    ENV_CONTAINER_RELATIVE_URI,
    ENV_CONTAINER_FULL_URI,
    ENV_CONTAINER_AUTH_TOKEN,
    ENV_CONTAINER_AUTH_TOKEN_FILE,
    ENV_EC2_METADATA_DISABLED,
    ENV_EC2_METADATA_ENDPOINT,
    ENV_EXECUTION_ENV,
];

/// ECS task-role credentials host for `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`.
const ECS_CONTAINER_CREDENTIALS_HOST: &str = "http://169.254.170.2";
/// AWS SDK defaults for the container credentials endpoint.
const CONTAINER_CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const CONTAINER_REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const CONTAINER_MAX_ATTEMPTS: u32 = 3;

/// Role-credential sources of the AWS default credential chain that need no static keys or
/// profile: EKS IRSA web identity, ECS task roles / EKS Pod Identity, and EC2 instance roles.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AmbientRoleSource {
    WebIdentity,
    Container,
    Imds,
}

impl AmbientRoleSource {
    fn label(self) -> &'static str {
        match self {
            Self::WebIdentity => "web identity (AWS_WEB_IDENTITY_TOKEN_FILE)",
            Self::Container => "container credentials (AWS_CONTAINER_CREDENTIALS_*_URI)",
            Self::Imds => "EC2 instance metadata (IMDS)",
        }
    }
}

/// The ambient role-credential sources the environment advertises, in AWS default-chain order.
/// Mirrors the markers TS `resolveAmbientBedrockAuth` treated as a configured `aws_default`
/// connection (web identity token file, container credentials URIs, and the EC2 hints
/// `AWS_EC2_METADATA_DISABLED=false` / an `AWS_EXECUTION_ENV` naming EC2). IMDS is only probed
/// behind an EC2 hint so non-EC2 hosts never wait on metadata timeouts.
fn ambient_role_sources(env: &HashMap<String, String>) -> Vec<AmbientRoleSource> {
    let mut sources = Vec::new();
    if env_trimmed(env, ENV_WEB_IDENTITY_TOKEN_FILE).is_some() {
        sources.push(AmbientRoleSource::WebIdentity);
    }
    if env_trimmed(env, ENV_CONTAINER_RELATIVE_URI).is_some()
        || env_trimmed(env, ENV_CONTAINER_FULL_URI).is_some()
    {
        sources.push(AmbientRoleSource::Container);
    }
    let metadata_disabled = env_trimmed(env, ENV_EC2_METADATA_DISABLED);
    let ec2_hint = metadata_disabled.is_some_and(|v| v.eq_ignore_ascii_case("false"))
        || env_trimmed(env, ENV_EXECUTION_ENV)
            .is_some_and(|v| v.to_ascii_lowercase().contains("ec2"));
    if ec2_hint && !metadata_disabled.is_some_and(|v| v.eq_ignore_ascii_case("true")) {
        sources.push(AmbientRoleSource::Imds);
    }
    sources
}

/// Resolves ambient role credentials (web identity, container, IMDS) from `env` — the env map
/// the caller was given, never the process environment. `Ok(None)` when no ambient source is
/// advertised; `Err` when one is advertised but every advertised source fails. Credentials are
/// cached until shortly before their expiration, then re-resolved.
fn resolve_ambient_role_credentials(
    env: &HashMap<String, String>,
    sts_region: &str,
) -> Result<Option<ProfileCredentials>, String> {
    let sources = ambient_role_sources(env);
    if sources.is_empty() {
        return Ok(None);
    }

    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    for key in AMBIENT_ROLE_ENV_KEYS {
        env_trimmed(env, key).hash(&mut hasher);
    }
    let cache_key = format!("\0ambient-role\0{sts_region}\0{:x}", hasher.finish());
    if let Some(hit) = PROFILE_CREDENTIALS_CACHE.lock().get(&cache_key)
        && Instant::now() < hit.refresh_at
    {
        return Ok(Some(hit.credentials.clone()));
    }

    let mut failures = Vec::new();
    for source in sources {
        let loaded = match source {
            AmbientRoleSource::WebIdentity => load_web_identity_credentials(env, sts_region),
            AmbientRoleSource::Container => load_container_credentials(env),
            AmbientRoleSource::Imds => load_imds_credentials(env),
        };
        match loaded.and_then(|creds| {
            cache_resolved_credentials(cache_key.clone(), &creds).map_err(str::to_owned)
        }) {
            Ok(resolved) => return Ok(Some(resolved)),
            Err(detail) => failures.push(format!("{}: {detail}", source.label())),
        }
    }
    Err(format!(
        "the AWS default credential chain could not resolve role credentials: {}",
        failures.join("; ")
    ))
}

/// EKS IRSA / generic web identity: `AssumeRoleWithWebIdentity` through `aws-config`, configured
/// statically from `env` (`AWS_WEB_IDENTITY_TOKEN_FILE`, `AWS_ROLE_ARN`, `AWS_ROLE_SESSION_NAME`).
fn load_web_identity_credentials(
    env: &HashMap<String, String>,
    sts_region: &str,
) -> Result<Credentials, String> {
    let token_file = env_trimmed(env, ENV_WEB_IDENTITY_TOKEN_FILE)
        .ok_or_else(|| format!("{ENV_WEB_IDENTITY_TOKEN_FILE} is not set"))?;
    let role_arn = env_trimmed(env, ENV_ROLE_ARN)
        .ok_or_else(|| format!("{ENV_WEB_IDENTITY_TOKEN_FILE} is set but {ENV_ROLE_ARN} is not"))?
        .to_owned();
    let session_name = env_trimmed(env, ENV_ROLE_SESSION_NAME)
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| {
            let millis = SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis();
            format!("cowork-bedrock-{millis}")
        });
    let token_file = std::path::PathBuf::from(token_file);
    let sts_region = sts_region.to_owned();
    run_credential_resolver("cowork-bedrock-web-identity", move || async move {
        let provider_config =
            ProviderConfig::without_region().with_region(Some(Region::new(sts_region)));
        let provider = WebIdentityTokenCredentialsProvider::builder()
            .configure(&provider_config)
            .static_configuration(StaticConfiguration {
                web_identity_token_file: token_file,
                role_arn,
                session_name,
            })
            .build();
        provide_with_timeout(&provider).await
    })
}

/// ECS task roles (`AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`) and EKS Pod Identity / generic HTTP
/// credentials (`AWS_CONTAINER_CREDENTIALS_FULL_URI`), with the optional authorization token.
fn load_container_credentials(env: &HashMap<String, String>) -> Result<Credentials, String> {
    let uri = if let Some(relative) = env_trimmed(env, ENV_CONTAINER_RELATIVE_URI) {
        let sep = if relative.starts_with('/') { "" } else { "/" };
        format!("{ECS_CONTAINER_CREDENTIALS_HOST}{sep}{relative}")
    } else if let Some(full) = env_trimmed(env, ENV_CONTAINER_FULL_URI) {
        validate_container_full_uri(full)?;
        full.to_owned()
    } else {
        return Err("no container credentials URI is set".to_owned());
    };
    let token = match env_trimmed(env, ENV_CONTAINER_AUTH_TOKEN_FILE) {
        Some(path) => Some(
            std::fs::read_to_string(path)
                .map_err(|e| {
                    format!("could not read {ENV_CONTAINER_AUTH_TOKEN_FILE} '{path}': {e}")
                })?
                .trim()
                .to_owned(),
        ),
        None => env_trimmed(env, ENV_CONTAINER_AUTH_TOKEN).map(ToOwned::to_owned),
    };
    run_credential_resolver("cowork-bedrock-container-credentials", move || async move {
        fetch_container_credentials(&uri, token.as_deref()).await
    })
}

/// Like the AWS SDKs, a full URI must be https or point at a loopback, ECS, or EKS Pod Identity
/// address, so credentials are never fetched in cleartext from an arbitrary host.
fn validate_container_full_uri(full: &str) -> Result<(), String> {
    let parsed = url::Url::parse(full)
        .map_err(|e| format!("{ENV_CONTAINER_FULL_URI} '{full}' is not a valid URL: {e}"))?;
    let allowed = match parsed.scheme() {
        "https" => true,
        "http" => match parsed.host() {
            Some(url::Host::Ipv4(ip)) => {
                ip.is_loopback()
                    || ip == std::net::Ipv4Addr::new(169, 254, 170, 2)
                    || ip == std::net::Ipv4Addr::new(169, 254, 170, 23)
            }
            Some(url::Host::Ipv6(ip)) => {
                ip.is_loopback()
                    || ip == std::net::Ipv6Addr::new(0xfd00, 0xec2, 0, 0, 0, 0, 0, 0x23)
            }
            Some(url::Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
            None => false,
        },
        _ => false,
    };
    if allowed {
        Ok(())
    } else {
        Err(format!(
            "{ENV_CONTAINER_FULL_URI} '{full}' must use https, or http with a loopback, ECS (169.254.170.2) or EKS Pod Identity (169.254.170.23 / fd00:ec2::23) address"
        ))
    }
}

async fn fetch_container_credentials(
    uri: &str,
    token: Option<&str>,
) -> Result<Credentials, String> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(CONTAINER_CONNECT_TIMEOUT)
        .timeout(CONTAINER_REQUEST_TIMEOUT)
        .build()
        .map_err(|e| format!("could not build HTTP client: {}", error_chain(&e)))?;
    let mut last_error = String::new();
    for attempt in 0..CONTAINER_MAX_ATTEMPTS {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(100 * u64::from(attempt))).await;
        }
        let mut request = client
            .get(uri)
            .header(reqwest::header::ACCEPT, "application/json");
        if let Some(token) = token {
            request = request.header(AUTHORIZATION, token);
        }
        let response = match request.send().await {
            Ok(response) => response,
            Err(err) if err.is_builder() => return Err(error_chain(&err)),
            Err(err) => {
                last_error = error_chain(&err);
                continue;
            }
        };
        let status = response.status();
        let body = match response.text().await {
            Ok(body) => body,
            Err(err) => {
                last_error = error_chain(&err);
                continue;
            }
        };
        if !status.is_success() {
            let snippet: String = body.trim().chars().take(200).collect();
            last_error = format!("HTTP {status}: {snippet}");
            if status.is_server_error() || status.as_u16() == 429 {
                continue;
            }
            return Err(last_error);
        }
        return parse_container_credentials(&body);
    }
    Err(last_error)
}

/// Parses the container credentials JSON (`AccessKeyId`, `SecretAccessKey`, `Token`,
/// `Expiration`) shared by ECS, EKS Pod Identity and generic HTTP credential endpoints.
fn parse_container_credentials(body: &str) -> Result<Credentials, String> {
    let json: serde_json::Value = serde_json::from_str(body)
        .map_err(|e| format!("credentials endpoint returned invalid JSON: {e}"))?;
    let field = |key: &str| {
        json.get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
    };
    if let Some(code) = field("Code")
        && !code.eq_ignore_ascii_case("Success")
    {
        return Err(format!(
            "credentials endpoint returned {code}: {}",
            field("Message").unwrap_or("no message")
        ));
    }
    let access_key_id =
        field("AccessKeyId").ok_or("credentials endpoint response is missing AccessKeyId")?;
    let secret_access_key = field("SecretAccessKey")
        .ok_or("credentials endpoint response is missing SecretAccessKey")?;
    let expiry = field("Expiration")
        .map(|raw| {
            chrono::DateTime::parse_from_rfc3339(raw)
                .map(SystemTime::from)
                .map_err(|e| {
                    format!("credentials endpoint returned an invalid Expiration '{raw}': {e}")
                })
        })
        .transpose()?;
    Ok(Credentials::new(
        access_key_id,
        secret_access_key,
        field("Token").map(ToOwned::to_owned),
        expiry,
        "cowork-bedrock-container",
    ))
}

/// EC2 instance-role credentials through `aws-config`'s IMDSv2 provider, honoring an
/// `AWS_EC2_METADATA_SERVICE_ENDPOINT` override from `env`.
fn load_imds_credentials(env: &HashMap<String, String>) -> Result<Credentials, String> {
    let endpoint = env_trimmed(env, ENV_EC2_METADATA_ENDPOINT).map(ToOwned::to_owned);
    run_credential_resolver("cowork-bedrock-imds", move || async move {
        let provider_config = ProviderConfig::without_region();
        let mut client = aws_config::imds::Client::builder().configure(&provider_config);
        if let Some(endpoint) = endpoint {
            client = client
                .endpoint(endpoint)
                .map_err(|e| format!("invalid {ENV_EC2_METADATA_ENDPOINT}: {e}"))?;
        }
        let provider = ImdsCredentialsProvider::builder()
            .configure(&provider_config)
            .imds_client(client.build())
            .build();
        provide_with_timeout(&provider).await
    })
}

fn first_last_four(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let head: String = chars[..4].iter().collect();
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("{head}...{tail}")
}

pub fn mask_bedrock_field_values(values: &HashMap<String, String>) -> HashMap<String, String> {
    let mut masked = HashMap::new();
    for (k, v) in values {
        let trimmed = v.trim();
        let out = match k.as_str() {
            "region" | "profile" => trimmed.to_string(),
            "accessKeyId" => {
                if trimmed.chars().count() <= 8 {
                    trimmed.to_string()
                } else {
                    first_last_four(trimmed)
                }
            }
            _ => {
                if trimmed.chars().count() <= 8 {
                    "••••••••".to_string()
                } else {
                    first_last_four(trimmed)
                }
            }
        };
        masked.insert(k.clone(), out);
    }
    masked
}

/// Percent-encodes a Bedrock `modelId` (including inference-profile or custom-deployment ARNs
/// containing `:` and `/`) as a single URI path segment.
pub fn percent_encode_bedrock_model_id(model_id: &str) -> String {
    let mut out = String::with_capacity(model_id.len() + 16);
    for byte in model_id.as_bytes() {
        let is_unreserved =
            byte.is_ascii_alphanumeric() || matches!(*byte, b'-' | b'_' | b'.' | b'~');
        if is_unreserved {
            out.push(*byte as char);
        } else {
            out.push_str(&format!("%{:02X}", byte));
        }
    }
    out
}

pub fn should_use_explicit_bedrock_endpoint(
    base_url: &str,
    configured_region: Option<&str>,
    has_configured_profile: bool,
) -> bool {
    let trimmed = base_url.trim();
    if trimmed.is_empty() {
        return false;
    }
    let Ok(parsed) = url::Url::parse(trimmed) else {
        return false;
    };
    let Some(host) = parsed.host_str() else {
        return false;
    };
    let lower_host = host.to_ascii_lowercase();

    // Standard AWS regional runtime endpoints should yield to explicitly configured AWS regions/profiles.
    if let Some(rest) = lower_host.strip_prefix("bedrock-runtime.")
        && let Some(url_region) = rest
            .strip_suffix(".amazonaws.com")
            .or_else(|| rest.strip_suffix(".amazonaws.com.cn"))
    {
        if let Some(cfg_reg) = configured_region.map(str::trim).filter(|s| !s.is_empty())
            && !url_region.eq_ignore_ascii_case(cfg_reg)
        {
            return false;
        }
        if has_configured_profile && configured_region.is_none() {
            return false;
        }
    }

    true
}

pub fn sign_bedrock_request(
    method: &str,
    url: &str,
    headers: &mut HeaderMap,
    body: &[u8],
    auth_cfg: &BedrockAuthConfig,
) -> Result<(), ProviderTransportError> {
    match &auth_cfg.auth {
        BedrockAuthMethod::BearerToken { token } => {
            let hv = HeaderValue::from_str(&format!("Bearer {}", token.trim())).map_err(|err| {
                ProviderTransportError::protocol(format!("Invalid Bedrock bearer token: {err}"))
            })?;
            headers.insert(AUTHORIZATION, hv);
            Ok(())
        }
        BedrockAuthMethod::SigV4 {
            access_key_id,
            secret_access_key,
            session_token,
        } => {
            let credentials = Credentials::new(
                access_key_id.clone(),
                secret_access_key.clone(),
                session_token.clone(),
                None,
                "cowork-bedrock",
            );
            let identity: Identity = credentials.into();

            let mut settings = SigningSettings::default();
            settings.uri_path_normalization_mode =
                aws_sigv4::http_request::UriPathNormalizationMode::Disabled;

            let signing_params: aws_sigv4::http_request::SigningParams<'_> =
                v4::SigningParams::builder()
                    .identity(&identity)
                    .region(&auth_cfg.region)
                    .name("bedrock")
                    .time(SystemTime::now())
                    .settings(settings)
                    .build()
                    .map_err(|err| {
                        ProviderTransportError::protocol(format!(
                            "Failed to build Bedrock SigV4 signing params: {err}"
                        ))
                    })?
                    .into();

            let existing_pairs: Vec<(String, String)> = headers
                .iter()
                .filter_map(|(k, v)| {
                    v.to_str()
                        .ok()
                        .map(|val| (k.as_str().to_string(), val.to_string()))
                })
                .collect();

            let signable_req = SignableRequest::new(
                method,
                url,
                existing_pairs.iter().map(|(k, v)| (k.as_str(), v.as_str())),
                SignableBody::Bytes(body),
            )
            .map_err(|err| {
                ProviderTransportError::protocol(format!(
                    "Failed to construct Bedrock SignableRequest: {err}"
                ))
            })?;

            let (instructions, _sig) = sign(signable_req, &signing_params)
                .map_err(|err| {
                    ProviderTransportError::protocol(format!("Bedrock SigV4 signing failed: {err}"))
                })?
                .into_parts();

            for (name, val) in instructions.headers() {
                let hn = HeaderName::from_bytes(name.as_bytes()).map_err(|err| {
                    ProviderTransportError::protocol(format!(
                        "Invalid signed header name {name}: {err}"
                    ))
                })?;
                let hv = HeaderValue::from_str(val).map_err(|err| {
                    ProviderTransportError::protocol(format!(
                        "Invalid signed header value for {name}: {err}"
                    ))
                })?;
                headers.insert(hn, hv);
            }

            Ok(())
        }
    }
}
