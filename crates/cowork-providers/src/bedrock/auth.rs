use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::LazyLock;
use std::time::{Duration, Instant, SystemTime};

use aws_credential_types::Credentials;
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

#[derive(Debug, Default, Clone)]
struct AwsIniProfile {
    access_key_id: Option<String>,
    secret_access_key: Option<String>,
    session_token: Option<String>,
    region: Option<String>,
    credential_process: Option<String>,
    /// First profile key that requires an AWS SDK credential provider Cowork
    /// does not implement (SSO, assume-role, web identity).
    unsupported_source_key: Option<String>,
}

/// Profile keys that select an AWS SDK credential provider which needs
/// `aws-config` (SSO token exchange, STS AssumeRole, web identity).
const UNSUPPORTED_PROFILE_SOURCE_KEYS: &[&str] = &[
    "sso_session",
    "sso_start_url",
    "sso_account_id",
    "sso_role_name",
    "role_arn",
    "source_profile",
    "credential_source",
    "web_identity_token_file",
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
        session_token: get_field("aws_session_token"),
        region: get_field("region"),
        credential_process: get_field("credential_process"),
        unsupported_source_key: UNSUPPORTED_PROFILE_SOURCE_KEYS
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
struct CachedProcessCredentials {
    credentials: ProfileCredentials,
    /// Refresh after this instant (expiration minus a safety margin).
    refresh_at: Instant,
}

static CREDENTIAL_PROCESS_CACHE: LazyLock<
    parking_lot::Mutex<HashMap<String, CachedProcessCredentials>>,
> = LazyLock::new(|| parking_lot::Mutex::new(HashMap::new()));

const CREDENTIAL_PROCESS_TIMEOUT: Duration = Duration::from_secs(60);
/// Refresh credentials this long before their reported expiration.
const CREDENTIAL_PROCESS_REFRESH_MARGIN: Duration = Duration::from_secs(5 * 60);
/// Credentials without an `Expiration` are long-term; re-run the process
/// periodically anyway so rotated keys are picked up.
const CREDENTIAL_PROCESS_NON_EXPIRING_TTL: Duration = Duration::from_secs(15 * 60);

fn run_credential_process(
    profile_name: &str,
    command: &str,
    env: &HashMap<String, String>,
) -> Result<CachedProcessCredentials, String> {
    let fail = |detail: String| {
        format!("AWS profile '{profile_name}': credential_process failed: {detail}")
    };
    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("cmd.exe");
        c.arg("/C").arg(command);
        c
    } else {
        let mut c = Command::new("sh");
        c.arg("-c").arg(command);
        c
    };
    // Overlay the resolver's environment (it may carry an isolated HOME).
    cmd.envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| fail(format!("could not start: {e}")))?;
    let mut stdout = child.stdout.take().expect("piped stdout");
    let mut stderr = child.stderr.take().expect("piped stderr");
    let out_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });
    let err_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf);
        buf
    });
    let deadline = Instant::now() + CREDENTIAL_PROCESS_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(fail(format!(
                    "timed out after {}s",
                    CREDENTIAL_PROCESS_TIMEOUT.as_secs()
                )));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(e) => return Err(fail(format!("wait failed: {e}"))),
        }
    };
    let stdout = out_reader.join().unwrap_or_default();
    let stderr = err_reader.join().unwrap_or_default();
    if !status.success() {
        let stderr = String::from_utf8_lossy(&stderr);
        let stderr = stderr.trim();
        return Err(fail(format!(
            "exited with {status}{}",
            if stderr.is_empty() {
                String::new()
            } else {
                format!(": {stderr}")
            }
        )));
    }
    let parsed: serde_json::Value = serde_json::from_slice(&stdout)
        .map_err(|e| fail(format!("output is not valid JSON: {e}")))?;
    if parsed.get("Version").and_then(serde_json::Value::as_i64) != Some(1) {
        return Err(fail("output must contain \"Version\": 1".to_owned()));
    }
    let field = |k: &str| {
        parsed
            .get(k)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToOwned::to_owned)
    };
    let (Some(access_key_id), Some(secret_access_key)) =
        (field("AccessKeyId"), field("SecretAccessKey"))
    else {
        return Err(fail(
            "output is missing AccessKeyId or SecretAccessKey".to_owned(),
        ));
    };
    let now = Instant::now();
    let refresh_at = match field("Expiration") {
        Some(raw) => {
            let expires = chrono::DateTime::parse_from_rfc3339(&raw)
                .map_err(|e| fail(format!("invalid Expiration '{raw}': {e}")))?;
            let remaining = (expires.with_timezone(&chrono::Utc) - chrono::Utc::now())
                .to_std()
                .unwrap_or_default();
            if remaining <= Duration::ZERO {
                return Err(fail(format!(
                    "returned already-expired credentials ({raw})"
                )));
            }
            now + remaining.saturating_sub(CREDENTIAL_PROCESS_REFRESH_MARGIN)
        }
        None => now + CREDENTIAL_PROCESS_NON_EXPIRING_TTL,
    };
    Ok(CachedProcessCredentials {
        credentials: ProfileCredentials {
            access_key_id,
            secret_access_key,
            session_token: field("SessionToken"),
        },
        refresh_at,
    })
}

fn credential_process_credentials(
    homedir: &Path,
    profile_name: &str,
    command: &str,
    env: &HashMap<String, String>,
) -> Result<ProfileCredentials, String> {
    let key = format!("{}\0{profile_name}\0{command}", homedir.display());
    if let Some(hit) = CREDENTIAL_PROCESS_CACHE.lock().get(&key)
        && Instant::now() < hit.refresh_at
    {
        return Ok(hit.credentials.clone());
    }
    let fresh = run_credential_process(profile_name, command, env)?;
    let creds = fresh.credentials.clone();
    CREDENTIAL_PROCESS_CACHE.lock().insert(key, fresh);
    Ok(creds)
}

/// Resolve credentials for an explicitly selected profile. Never falls back to
/// other credentials: an unusable profile is an error naming the fix.
fn resolve_profile_credentials(
    homedir: &Path,
    env: &HashMap<String, String>,
    profile_name: &str,
    ini: &AwsIniProfile,
) -> Result<ProfileCredentials, String> {
    if let Some(key) = &ini.unsupported_source_key {
        return Err(format!(
            "AWS profile '{profile_name}' uses `{key}` (SSO, assume-role, or web identity), \
             which Cowork cannot resolve directly. Add a profile that exports its credentials, \
             e.g. in ~/.aws/config:\n\n[profile {profile_name}-cowork]\n\
             credential_process = aws configure export-credentials --profile {profile_name} --format process\n\n\
             then select '{profile_name}-cowork' for Amazon Bedrock (for SSO, run \
             `aws sso login --profile {profile_name}` first)."
        ));
    }
    if let (Some(ak), Some(sk)) = (&ini.access_key_id, &ini.secret_access_key) {
        return Ok(ProfileCredentials {
            access_key_id: ak.clone(),
            secret_access_key: sk.clone(),
            session_token: ini.session_token.clone(),
        });
    }
    if let Some(command) = &ini.credential_process {
        return credential_process_credentials(homedir, profile_name, command, env);
    }
    Err(format!(
        "AWS profile '{profile_name}' has no usable credentials: set \
         aws_access_key_id/aws_secret_access_key or credential_process for it in ~/.aws."
    ))
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
/// connection or `AWS_PROFILE`) cannot be used. Supports static keys and
/// `credential_process`; SSO/assume-role profiles need `aws-config`.
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
                    let creds = resolve_profile_credentials(homedir, env, &prof_name, &ini)?;
                    let region = explicit_region
                        .clone()
                        .or(ini.region.clone())
                        .or(ambient_region.clone())
                        .unwrap_or_else(|| "us-east-1".into());
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
                if let Some(ini) = load_aws_profile_from_disk(homedir, "default")
                    && let Some(creds) = default_profile_credentials(homedir, env, &ini)?
                {
                    let region = explicit_region
                        .clone()
                        .or(ambient_region.clone())
                        .or(ini.region.clone())
                        .unwrap_or_else(|| "us-east-1".into());
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
        let creds = resolve_profile_credentials(homedir, env, profile_name, &ini)?;
        let has_reg = ambient_region.is_some() || ini.region.is_some();
        return Ok(Some(BedrockAuthConfig {
            method_id: "aws_profile".into(),
            source: "env".into(),
            region: ambient_region
                .or(ini.region)
                .unwrap_or_else(|| "us-east-1".into()),
            has_configured_region: has_reg,
            has_configured_profile: true,
            auth: BedrockAuthMethod::SigV4 {
                access_key_id: creds.access_key_id,
                secret_access_key: creds.secret_access_key,
                session_token: creds.session_token,
            },
        }));
    }

    if let Some(ini) = load_aws_profile_from_disk(homedir, "default")
        && let Some(creds) = default_profile_credentials(homedir, env, &ini)?
    {
        let has_reg = ambient_region.is_some() || ini.region.is_some();
        return Ok(Some(BedrockAuthConfig {
            method_id: "aws_default".into(),
            source: "env".into(),
            region: ambient_region
                .or(ini.region)
                .unwrap_or_else(|| "us-east-1".into()),
            has_configured_region: has_reg,
            has_configured_profile: false,
            auth: BedrockAuthMethod::SigV4 {
                access_key_id: creds.access_key_id,
                secret_access_key: creds.secret_access_key,
                session_token: creds.session_token,
            },
        }));
    }

    Ok(None)
}

/// Credentials from the `[default]` profile: `Ok(None)` when it carries no
/// credential source at all (e.g. only a region), so resolution continues.
fn default_profile_credentials(
    homedir: &Path,
    env: &HashMap<String, String>,
    ini: &AwsIniProfile,
) -> Result<Option<ProfileCredentials>, String> {
    let has_source = ini.unsupported_source_key.is_some()
        || ini.credential_process.is_some()
        || (ini.access_key_id.is_some() && ini.secret_access_key.is_some());
    if !has_source {
        return Ok(None);
    }
    resolve_profile_credentials(homedir, env, "default", ini).map(Some)
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
