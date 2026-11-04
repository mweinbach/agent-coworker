use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;

use chrono::{DateTime, Duration as ChronoDuration, Utc};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::error::{ConfigError, Result};
use crate::paths::{
    AiCoworkerPaths, ensure_private_dir_sync, harden_private_file_sync, write_text_file_atomic,
};
use crate::providers::ProviderName;

pub const DEFAULT_MODEL_DISCOVERY_CACHE_TTL_MS: i64 = 24 * 60 * 60 * 1000;
const MODEL_DISCOVERY_CACHE_VERSION: u64 = 1;
const MAX_SANITIZED_DEPTH: usize = 4;
const MAX_SANITIZED_OBJECT_KEYS: usize = 100;
const MAX_SANITIZED_ARRAY_ITEMS: usize = 100;
const MAX_SANITIZED_STRING_LENGTH: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ModelDiscoverySource {
    Api,
    LocalHttp,
    LocalCli,
    AppServer,
    Filesystem,
    Static,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedModelReasoning {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub available_efforts: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedModelDiscoveryModel {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub knowledge_cutoff: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supports_image_input: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_default: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<CachedModelReasoning>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_options: Option<Map<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_overrides: Option<Map<String, Value>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelDiscoveryCacheFile {
    pub version: u8,
    pub provider: ProviderName,
    pub source: ModelDiscoverySource,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    pub models: Vec<CachedModelDiscoveryModel>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelDiscoveryResult {
    pub provider: ProviderName,
    pub source: ModelDiscoverySource,
    pub models: Vec<CachedModelDiscoveryModel>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

fn secret_key_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)(^|[_-])(api[_-]?key|authorization|auth|bearer|credential|password|secret|token)([_-]|$)",
        )
        .expect("valid secret key regex")
    })
}

fn cache_dir(paths: &AiCoworkerPaths) -> PathBuf {
    paths.root_dir.join("cache").join("models")
}

pub fn model_discovery_cache_path(
    paths: &AiCoworkerPaths,
    provider: ProviderName,
    scope: Option<&str>,
) -> PathBuf {
    let suffix = match scope {
        None => String::new(),
        Some(s) => format!("-{}", hex::encode(Sha256::digest(s.as_bytes()))),
    };
    cache_dir(paths).join(format!("{}{suffix}.json", provider.as_str()))
}

fn sanitize_runtime_value(value: &Value, depth: usize) -> Option<Value> {
    if depth > MAX_SANITIZED_DEPTH {
        return None;
    }
    match value {
        Value::Null => Some(Value::Null),
        Value::Bool(b) => Some(Value::Bool(*b)),
        Value::Number(n) => {
            if n.as_f64().is_some_and(f64::is_finite) {
                Some(Value::Number(n.clone()))
            } else {
                None
            }
        }
        Value::String(s) => {
            let truncated: String = s.chars().take(MAX_SANITIZED_STRING_LENGTH).collect();
            Some(Value::String(truncated))
        }
        Value::Array(items) => {
            let mut out = Vec::new();
            for item in items.iter().take(MAX_SANITIZED_ARRAY_ITEMS) {
                if let Some(sanitized) = sanitize_runtime_value(item, depth + 1) {
                    out.push(sanitized);
                }
            }
            Some(Value::Array(out))
        }
        Value::Object(map) => {
            let mut out = Map::new();
            for (k, v) in map.iter().take(MAX_SANITIZED_OBJECT_KEYS) {
                if k.trim().is_empty() || secret_key_regex().is_match(k) {
                    continue;
                }
                if let Some(sanitized) = sanitize_runtime_value(v, depth + 1) {
                    out.insert(k.clone(), sanitized);
                }
            }
            Some(Value::Object(out))
        }
    }
}

fn normalize_runtime_record(record: Option<&Map<String, Value>>) -> Option<Map<String, Value>> {
    let map = record?;
    let Some(Value::Object(sanitized)) = sanitize_runtime_value(&Value::Object(map.clone()), 0)
    else {
        return None;
    };
    if sanitized.is_empty() {
        None
    } else {
        Some(sanitized)
    }
}

fn normalize_models(models: &[CachedModelDiscoveryModel]) -> Vec<CachedModelDiscoveryModel> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for raw in models {
        let id = raw.id.trim();
        if id.is_empty() || !seen.insert(id.to_string()) {
            continue;
        }
        let display_name = if raw.display_name.trim().is_empty() {
            id.to_string()
        } else {
            raw.display_name.trim().to_string()
        };
        out.push(CachedModelDiscoveryModel {
            id: id.to_string(),
            model: raw
                .model
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToOwned::to_owned),
            display_name,
            description: raw
                .description
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToOwned::to_owned),
            knowledge_cutoff: raw
                .knowledge_cutoff
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToOwned::to_owned),
            supports_image_input: raw.supports_image_input,
            is_default: if raw.is_default == Some(true) {
                Some(true)
            } else {
                None
            },
            reasoning: raw.reasoning.clone(),
            runtime_options: normalize_runtime_record(raw.runtime_options.as_ref()),
            runtime_overrides: normalize_runtime_record(raw.runtime_overrides.as_ref()),
        });
    }
    out
}

pub fn read_model_discovery_cache_sync(
    paths: &AiCoworkerPaths,
    provider: ProviderName,
    scope: Option<&str>,
) -> Option<ModelDiscoveryCacheFile> {
    let file_path = model_discovery_cache_path(paths, provider, scope);
    let raw = fs::read_to_string(file_path).ok()?;
    let val: Value = serde_json::from_str(&raw).ok()?;
    let obj = val.as_object()?;
    if obj.get("version").and_then(Value::as_u64) != Some(MODEL_DISCOVERY_CACHE_VERSION) {
        return None;
    }
    let parsed: ModelDiscoveryCacheFile = serde_json::from_value(val).ok()?;
    if parsed.provider != provider {
        return None;
    }
    if DateTime::parse_from_rfc3339(&parsed.updated_at).is_err() {
        return None;
    }
    Some(ModelDiscoveryCacheFile {
        models: normalize_models(&parsed.models),
        expires_at: parsed
            .expires_at
            .filter(|e| DateTime::parse_from_rfc3339(e).is_ok()),
        ..parsed
    })
}

pub async fn read_model_discovery_cache(
    paths: &AiCoworkerPaths,
    provider: ProviderName,
    scope: Option<&str>,
) -> Option<ModelDiscoveryCacheFile> {
    read_model_discovery_cache_sync(paths, provider, scope)
}

pub fn is_model_discovery_cache_fresh(
    cache: Option<&ModelDiscoveryCacheFile>,
    now_ms: Option<i64>,
) -> bool {
    let Some(expires_str) = cache.and_then(|c| c.expires_at.as_deref()) else {
        return false;
    };
    let Ok(expires_dt) = DateTime::parse_from_rfc3339(expires_str) else {
        return false;
    };
    let current_ms = now_ms.unwrap_or_else(|| Utc::now().timestamp_millis());
    expires_dt.timestamp_millis() > current_ms
}

pub async fn write_model_discovery_cache(
    paths: &AiCoworkerPaths,
    provider: ProviderName,
    result: ModelDiscoveryResult,
    scope: Option<&str>,
    ttl_ms: Option<i64>,
) -> Result<ModelDiscoveryCacheFile> {
    let now = Utc::now();
    let effective_ttl = ttl_ms.unwrap_or(DEFAULT_MODEL_DISCOVERY_CACHE_TTL_MS);
    let expires_at = result.expires_at.or_else(|| {
        if effective_ttl > 0 {
            Some((now + ChronoDuration::milliseconds(effective_ttl)).to_rfc3339())
        } else {
            None
        }
    });

    let cache = ModelDiscoveryCacheFile {
        version: 1,
        provider,
        source: result.source,
        updated_at: result.updated_at.unwrap_or_else(|| now.to_rfc3339()),
        expires_at,
        models: normalize_models(&result.models),
    };

    let dir = cache_dir(paths);
    ensure_private_dir_sync(&dir)?;
    let file_path = model_discovery_cache_path(paths, provider, scope);
    let serialized = format!(
        "{}\n",
        serde_json::to_string_pretty(&cache).map_err(|e| ConfigError::Validation(e.to_string()))?
    );
    write_text_file_atomic(&file_path, &serialized, Some(0o600))?;
    harden_private_file_sync(&file_path);
    Ok(cache)
}
