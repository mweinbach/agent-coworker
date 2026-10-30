use std::collections::HashMap;
use std::path::Path;
use std::time::SystemTime;

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
            let val = v.trim().trim_matches('"').trim_matches('\'').to_string();
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
    })
}

fn env_trimmed<'a>(env: &'a HashMap<String, String>, key: &str) -> Option<&'a str> {
    env.get(key)
        .map(String::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

pub fn resolve_bedrock_auth_config(
    homedir: &Path,
    env: &HashMap<String, String>,
    store: Option<&ConnectionStore>,
) -> Option<BedrockAuthConfig> {
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
                    return Some(BedrockAuthConfig {
                        method_id: "api_key".into(),
                        source: "saved".into(),
                        region: explicit_region
                            .or(ambient_region)
                            .unwrap_or_else(|| "us-east-1".into()),
                        has_configured_region,
                        has_configured_profile: false,
                        auth: BedrockAuthMethod::BearerToken { token },
                    });
                }
            }
            "aws_keys" => {
                if let (Some(ak), Some(sk)) =
                    (val_trimmed("accessKeyId"), val_trimmed("secretAccessKey"))
                {
                    return Some(BedrockAuthConfig {
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
                    });
                }
            }
            "aws_profile" => {
                if let Some(prof_name) = val_trimmed("profile")
                    && let Some(ini) = load_aws_profile_from_disk(homedir, &prof_name)
                    && let (Some(ak), Some(sk)) = (ini.access_key_id, ini.secret_access_key)
                {
                    let region = explicit_region
                        .clone()
                        .or(ini.region.clone())
                        .or(ambient_region.clone())
                        .unwrap_or_else(|| "us-east-1".into());
                    return Some(BedrockAuthConfig {
                        method_id: "aws_profile".into(),
                        source: "saved".into(),
                        region,
                        has_configured_region: explicit_region.is_some()
                            || ini.region.is_some()
                            || ambient_region.is_some(),
                        has_configured_profile: true,
                        auth: BedrockAuthMethod::SigV4 {
                            access_key_id: ak,
                            secret_access_key: sk,
                            session_token: ini.session_token,
                        },
                    });
                }
            }
            "aws_default" => {
                if let (Some(ak), Some(sk)) = (
                    env_trimmed(env, "AWS_ACCESS_KEY_ID"),
                    env_trimmed(env, "AWS_SECRET_ACCESS_KEY"),
                ) {
                    return Some(BedrockAuthConfig {
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
                    });
                }
                if let Some(ini) = load_aws_profile_from_disk(homedir, "default")
                    && let (Some(ak), Some(sk)) = (ini.access_key_id, ini.secret_access_key)
                {
                    let region = explicit_region
                        .clone()
                        .or(ambient_region.clone())
                        .or(ini.region.clone())
                        .unwrap_or_else(|| "us-east-1".into());
                    return Some(BedrockAuthConfig {
                        method_id: "aws_default".into(),
                        source: "saved".into(),
                        region,
                        has_configured_region: explicit_region.is_some()
                            || ambient_region.is_some()
                            || ini.region.is_some(),
                        has_configured_profile: false,
                        auth: BedrockAuthMethod::SigV4 {
                            access_key_id: ak,
                            secret_access_key: sk,
                            session_token: ini.session_token,
                        },
                    });
                }
            }
            _ => {}
        }
    }

    // 2. Ambient environment + ~/.aws
    if let Some(bearer) = env_trimmed(env, "AWS_BEARER_TOKEN_BEDROCK") {
        return Some(BedrockAuthConfig {
            method_id: "api_key".into(),
            source: "env".into(),
            has_configured_region: ambient_region.is_some(),
            region: ambient_region.unwrap_or_else(|| "us-east-1".into()),
            has_configured_profile: false,
            auth: BedrockAuthMethod::BearerToken {
                token: bearer.to_string(),
            },
        });
    }

    if let (Some(ak), Some(sk)) = (
        env_trimmed(env, "AWS_ACCESS_KEY_ID"),
        env_trimmed(env, "AWS_SECRET_ACCESS_KEY"),
    ) {
        return Some(BedrockAuthConfig {
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
        });
    }

    if let Some(profile_name) = env_trimmed(env, "AWS_PROFILE")
        && let Some(ini) = load_aws_profile_from_disk(homedir, profile_name)
        && let (Some(ak), Some(sk)) = (ini.access_key_id, ini.secret_access_key)
    {
        let has_reg = ambient_region.is_some() || ini.region.is_some();
        return Some(BedrockAuthConfig {
            method_id: "aws_profile".into(),
            source: "env".into(),
            region: ambient_region
                .or(ini.region)
                .unwrap_or_else(|| "us-east-1".into()),
            has_configured_region: has_reg,
            has_configured_profile: true,
            auth: BedrockAuthMethod::SigV4 {
                access_key_id: ak,
                secret_access_key: sk,
                session_token: ini.session_token,
            },
        });
    }

    if let Some(ini) = load_aws_profile_from_disk(homedir, "default")
        && let (Some(ak), Some(sk)) = (ini.access_key_id, ini.secret_access_key)
    {
        let has_reg = ambient_region.is_some() || ini.region.is_some();
        return Some(BedrockAuthConfig {
            method_id: "aws_default".into(),
            source: "env".into(),
            region: ambient_region
                .or(ini.region)
                .unwrap_or_else(|| "us-east-1".into()),
            has_configured_region: has_reg,
            has_configured_profile: false,
            auth: BedrockAuthMethod::SigV4 {
                access_key_id: ak,
                secret_access_key: sk,
                session_token: ini.session_token,
            },
        });
    }

    None
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
