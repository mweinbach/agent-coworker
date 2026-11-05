//! Shared per-provider connection resolution: transport construction, endpoint override and
//! Bedrock auth (with the `providerOptions.bedrock.region` override).
//!
//! The server's turn / memory / fork / child-agent paths and the harness skill improver all
//! build model connections the same way; this module is the single implementation they share.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use cowork_config::{ConnectionStore, ProviderName};
use serde_json::{Map, Value};

use crate::bedrock::{
    BedrockAuthConfig, extract_bedrock_region_override, resolve_bedrock_auth_config,
};
use crate::chat_completions::lmstudio::resolve_lmstudio_options;
use crate::{
    AnthropicMessagesTransport, BedrockConverseTransport, ChatCompletionsTransport,
    CodexAppServerTransport, GoogleInteractionsTransport, OpenAiResponsesTransport,
    ProviderTransport,
};

/// Bedrock auth for `provider` (`None` for every other provider, or when Bedrock has no usable
/// credentials). When `region_override_opts` is given, a `providerOptions.bedrock.region` (or
/// top-level `region`) found there replaces the resolved region and marks it as configured.
pub fn resolve_provider_bedrock_auth(
    provider: ProviderName,
    homedir: &Path,
    env: &HashMap<String, String>,
    conn_store: Option<&ConnectionStore>,
    region_override_opts: Option<&Map<String, Value>>,
) -> Option<BedrockAuthConfig> {
    if provider != ProviderName::Bedrock {
        return None;
    }
    let mut auth = resolve_bedrock_auth_config(homedir, env, conn_store);
    if let (Some(region), Some(cfg)) = (
        region_override_opts.and_then(extract_bedrock_region_override),
        auth.as_mut(),
    ) {
        cfg.region = region;
        cfg.has_configured_region = true;
    }
    auth
}

/// Environment variable naming `provider`'s endpoint override: `GEMINI_BASE_URL` (Google),
/// `AWS_BEDROCK_ENDPOINT_URL` (Bedrock), otherwise `<PROVIDER>_BASE_URL` (`-` mapped to `_`).
pub fn provider_base_url_env_key(provider: ProviderName) -> String {
    match provider {
        ProviderName::Google => "GEMINI_BASE_URL".to_owned(),
        ProviderName::Bedrock => "AWS_BEDROCK_ENDPOINT_URL".to_owned(),
        other => format!(
            "{}_BASE_URL",
            other.as_str().to_ascii_uppercase().replace('-', "_")
        ),
    }
}

/// Endpoint override for `provider`: its provider-options section (`{provider}.baseUrl`), the
/// top-level `baseUrl` when `allow_top_level` (options of the chat's own provider), then the
/// `<PROVIDER>_BASE_URL` environment variable (see [`provider_base_url_env_key`]).
pub fn provider_base_url_override(
    provider: ProviderName,
    provider_opts: &Map<String, Value>,
    env: &HashMap<String, String>,
    allow_top_level: bool,
) -> Option<String> {
    let env_key = provider_base_url_env_key(provider);
    provider_opts
        .get(provider.as_str())
        .and_then(Value::as_object)
        .and_then(|o| o.get("baseUrl").or_else(|| o.get("base_url")))
        .or_else(|| {
            allow_top_level
                .then(|| {
                    provider_opts
                        .get("baseUrl")
                        .or_else(|| provider_opts.get("base_url"))
                })
                .flatten()
        })
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            env.get(&env_key)
                .map(String::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
        })
}

/// Inference endpoint for `provider`: LM Studio always resolves its (local) inference URL from
/// its options; every other provider uses [`provider_base_url_override`].
pub fn resolve_provider_base_url(
    provider: ProviderName,
    provider_opts: &Map<String, Value>,
    env: &HashMap<String, String>,
    allow_top_level: bool,
) -> Option<String> {
    match provider {
        ProviderName::Lmstudio => {
            Some(resolve_lmstudio_options(env, Some(provider_opts), None).inference_base_url)
        }
        other => provider_base_url_override(other, provider_opts, env, allow_top_level),
    }
}

/// Builds the native wire transport for `provider`. Bedrock uses `bedrock_auth` when present,
/// otherwise credentials resolved from the isolated `homedir` / `env`. Codex is caller-specific
/// (tool bridges, sandbox restrictions), so `codex_transport` builds it on demand.
pub fn select_provider_transport(
    provider: ProviderName,
    bedrock_auth: Option<BedrockAuthConfig>,
    homedir: &Path,
    env: &HashMap<String, String>,
    codex_transport: impl FnOnce() -> CodexAppServerTransport,
) -> Result<Arc<dyn ProviderTransport>, String> {
    match provider {
        ProviderName::Openai => Ok(Arc::new(OpenAiResponsesTransport::new())),
        ProviderName::Anthropic => Ok(Arc::new(AnthropicMessagesTransport::new())),
        ProviderName::Google => Ok(Arc::new(GoogleInteractionsTransport::new())),
        ProviderName::Bedrock => match bedrock_auth {
            Some(auth) => Ok(Arc::new(BedrockConverseTransport::with_auth(auth))),
            None => Ok(Arc::new(BedrockConverseTransport::with_isolated_env(
                homedir.to_path_buf(),
                env.clone(),
            ))),
        },
        ProviderName::CodexCli => Ok(Arc::new(codex_transport())),
        other => ChatCompletionsTransport::new(other)
            .map(|t| Arc::new(t) as Arc<dyn ProviderTransport>)
            .ok_or_else(|| format!("Unsupported provider transport: {}", other.as_str())),
    }
}

/// A fully resolved model connection: transport, endpoint override and API key.
pub struct ResolvedProviderConnection {
    pub transport: Arc<dyn ProviderTransport>,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
}

/// Resolves `provider`'s API key, Bedrock auth (with the region override from
/// `provider_opts`), endpoint ([`resolve_provider_base_url`]) and transport
/// ([`select_provider_transport`]) in one step.
pub fn resolve_provider_connection(
    provider: ProviderName,
    homedir: &Path,
    env: &HashMap<String, String>,
    conn_store: Option<&ConnectionStore>,
    provider_opts: &Map<String, Value>,
    allow_top_level_base_url: bool,
    codex_transport: impl FnOnce() -> CodexAppServerTransport,
) -> Result<ResolvedProviderConnection, String> {
    let api_key = crate::resolve_provider_api_key(provider, conn_store, env);
    let bedrock_auth =
        resolve_provider_bedrock_auth(provider, homedir, env, conn_store, Some(provider_opts));
    let base_url =
        resolve_provider_base_url(provider, provider_opts, env, allow_top_level_base_url);
    let transport =
        select_provider_transport(provider, bedrock_auth, homedir, env, codex_transport)?;
    Ok(ResolvedProviderConnection {
        transport,
        base_url,
        api_key,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn opts(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap()
    }

    #[test]
    fn base_url_env_keys_follow_the_provider_conventions() {
        assert_eq!(
            provider_base_url_env_key(ProviderName::Google),
            "GEMINI_BASE_URL"
        );
        assert_eq!(
            provider_base_url_env_key(ProviderName::Bedrock),
            "AWS_BEDROCK_ENDPOINT_URL"
        );
        assert_eq!(
            provider_base_url_env_key(ProviderName::Openai),
            "OPENAI_BASE_URL"
        );
        assert_eq!(
            provider_base_url_env_key(ProviderName::CodexCli),
            "CODEX_CLI_BASE_URL"
        );
    }

    #[test]
    fn base_url_override_prefers_section_then_top_level_then_env() {
        let env = HashMap::from([("OPENAI_BASE_URL".to_owned(), " https://env ".to_owned())]);
        let both = opts(json!({
            "openai": { "baseUrl": "https://section" },
            "baseUrl": "https://top",
        }));
        assert_eq!(
            provider_base_url_override(ProviderName::Openai, &both, &env, true).as_deref(),
            Some("https://section")
        );
        let top = opts(json!({ "base_url": "https://top" }));
        assert_eq!(
            provider_base_url_override(ProviderName::Openai, &top, &env, true).as_deref(),
            Some("https://top")
        );
        assert_eq!(
            provider_base_url_override(ProviderName::Openai, &top, &env, false).as_deref(),
            Some("https://env")
        );
        let blank = opts(json!({ "openai": { "baseUrl": "  " } }));
        assert_eq!(
            provider_base_url_override(ProviderName::Openai, &blank, &HashMap::new(), true),
            None
        );
    }

    #[test]
    fn bedrock_auth_is_only_resolved_for_bedrock() {
        let tmp = tempfile::tempdir().unwrap();
        let env = HashMap::from([("AWS_BEARER_TOKEN_BEDROCK".to_owned(), "tok".to_owned())]);
        let region = opts(json!({ "bedrock": { "region": "eu-west-1" } }));
        assert!(
            resolve_provider_bedrock_auth(
                ProviderName::Openai,
                tmp.path(),
                &env,
                None,
                Some(&region)
            )
            .is_none()
        );
        if let Some(auth) = resolve_provider_bedrock_auth(
            ProviderName::Bedrock,
            tmp.path(),
            &env,
            None,
            Some(&region),
        ) {
            assert_eq!(auth.region, "eu-west-1");
            assert!(auth.has_configured_region);
        }
    }
}
