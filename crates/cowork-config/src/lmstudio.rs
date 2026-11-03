//! LM Studio endpoint resolution shared by the provider catalog (which writes the scoped
//! model-discovery cache) and config/session model resolution (which reads it).
//!
//! The discovery cache for LM Studio is keyed by `[baseUrl, apiKey]`
//! (`createLmStudioModelDiscoveryAdapter` in `src/providers/modelDiscoveryAdapters.ts`), so the
//! writer and every reader must derive the same endpoint and the same scope string, or the
//! reader silently misses the cache file.

use std::collections::HashMap;

use serde_json::{Map, Value};

pub const DEFAULT_LM_STUDIO_BASE_URL: &str = "http://localhost:1234";

/// Normalizes an LM Studio base URL to its server root: trims whitespace and trailing slashes and
/// strips a trailing `/api/v1` or `/v1`, defaulting to [`DEFAULT_LM_STUDIO_BASE_URL`].
pub fn normalize_lmstudio_base_url(raw: Option<&str>) -> String {
    let trimmed = raw
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_LM_STUDIO_BASE_URL);
    let mut normalized = trimmed.trim_end_matches('/').to_string();
    if let Some(stripped) = normalized.strip_suffix("/api/v1") {
        normalized = stripped.to_string();
    } else if let Some(stripped) = normalized.strip_suffix("/v1") {
        normalized = stripped.to_string();
    }
    if normalized.is_empty() {
        DEFAULT_LM_STUDIO_BASE_URL.to_string()
    } else {
        normalized
    }
}

/// The LM Studio server the provider catalog discovers models from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LmStudioDiscoveryEndpoint {
    /// Normalized server root (see [`normalize_lmstudio_base_url`]).
    pub base_url: String,
    /// Trimmed, non-empty API key, if any.
    pub api_key: Option<String>,
}

impl LmStudioDiscoveryEndpoint {
    /// The model-discovery cache scope for this endpoint.
    pub fn cache_scope(&self) -> String {
        lmstudio_discovery_cache_scope(&self.base_url, self.api_key.as_deref())
    }
}

/// The model-discovery cache scope for an LM Studio endpoint: `JSON.stringify([baseUrl, apiKey])`
/// with the API key trimmed (empty when absent), as in TypeScript.
pub fn lmstudio_discovery_cache_scope(base_url: &str, api_key: Option<&str>) -> String {
    let key = api_key.map(str::trim).unwrap_or_default();
    Value::Array(vec![
        Value::String(base_url.to_string()),
        Value::String(key.to_string()),
    ])
    .to_string()
}

fn non_empty_str(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// Resolves the LM Studio endpoint the provider catalog discovers against.
///
/// Base URL precedence: `providerOptions.lmstudio.baseUrl` (or `base_url`), then
/// `LM_STUDIO_BASE_URL`, then a root-level `providerOptions.baseUrl` when there is no `lmstudio`
/// section, then [`DEFAULT_LM_STUDIO_BASE_URL`]. API key precedence: the saved connection key,
/// then `LM_STUDIO_API_KEY`, then `LM_STUDIO_API_TOKEN`.
///
/// `provider_options` must be the *trusted* merged options from config load, in which a
/// workspace-supplied non-loopback `lmstudio.baseUrl` has already been stripped.
pub fn resolve_lmstudio_discovery_endpoint(
    env: &HashMap<String, String>,
    provider_options: Option<&Map<String, Value>>,
    saved_api_key: Option<&str>,
) -> LmStudioDiscoveryEndpoint {
    let env_non_empty = |key: &str| -> Option<&str> {
        env.get(key)
            .map(String::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
    };
    let lmstudio_section = provider_options
        .and_then(|po| po.get("lmstudio"))
        .and_then(Value::as_object);

    let raw_base = lmstudio_section
        .and_then(|s| non_empty_str(s.get("baseUrl").or_else(|| s.get("base_url"))))
        .or_else(|| env_non_empty("LM_STUDIO_BASE_URL"))
        .or_else(|| match lmstudio_section {
            Some(_) => None,
            None => non_empty_str(provider_options.and_then(|po| po.get("baseUrl"))),
        });

    let api_key = saved_api_key
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or_else(|| env_non_empty("LM_STUDIO_API_KEY"))
        .or_else(|| env_non_empty("LM_STUDIO_API_TOKEN"))
        .map(ToOwned::to_owned);

    LmStudioDiscoveryEndpoint {
        base_url: normalize_lmstudio_base_url(raw_base),
        api_key,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn scope_matches_typescript_json_stringify() {
        assert_eq!(
            lmstudio_discovery_cache_scope("http://localhost:1234", None),
            r#"["http://localhost:1234",""]"#
        );
        assert_eq!(
            lmstudio_discovery_cache_scope("http://127.0.0.1:9", Some(" sk ")),
            r#"["http://127.0.0.1:9","sk"]"#
        );
    }

    #[test]
    fn endpoint_precedence() {
        let mut env = HashMap::new();
        env.insert(
            "LM_STUDIO_BASE_URL".into(),
            "http://127.0.0.1:2222/v1".into(),
        );
        env.insert("LM_STUDIO_API_TOKEN".into(), "tok".into());
        let po = json!({ "lmstudio": { "baseUrl": "http://localhost:3333/api/v1/" } });
        let ep = resolve_lmstudio_discovery_endpoint(&env, po.as_object(), None);
        assert_eq!(ep.base_url, "http://localhost:3333");
        assert_eq!(ep.api_key.as_deref(), Some("tok"));

        let ep = resolve_lmstudio_discovery_endpoint(&env, None, Some(" saved "));
        assert_eq!(ep.base_url, "http://127.0.0.1:2222");
        assert_eq!(ep.api_key.as_deref(), Some("saved"));

        let ep = resolve_lmstudio_discovery_endpoint(&HashMap::new(), None, None);
        assert_eq!(ep.base_url, DEFAULT_LM_STUDIO_BASE_URL);
        assert_eq!(ep.api_key, None);
    }
}
