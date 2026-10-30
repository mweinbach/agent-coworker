use std::collections::HashMap;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::paths::get_ai_coworker_paths;
use crate::providers::{ChildModelRoutingMode, ProviderName};
use crate::stores::{read_custom_model_store_sync, read_model_discovery_cache_sync};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportedModel {
    pub id: String,
    pub provider: ProviderName,
    pub display_name: String,
    pub knowledge_cutoff: String,
    pub supports_image_input: bool,
    pub prompt_template: String,
    #[serde(default)]
    pub provider_options_defaults: Map<String, Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supported_reasoning_efforts: Option<Vec<String>>,
    pub is_default: bool,
}

#[derive(Debug, Clone, Default)]
pub struct ModelRegistry {
    by_key: HashMap<String, SupportedModel>,
    defaults: HashMap<ProviderName, SupportedModel>,
}

pub fn legacy_model_alias(provider: ProviderName, model_id: &str) -> Option<&'static str> {
    match (provider, model_id.trim()) {
        (ProviderName::Openai, "gpt-5.1" | "gpt-5.2-codex") => Some("gpt-5.4"),
        (
            ProviderName::CodexCli,
            "gpt-5-codex" | "gpt-5.1" | "gpt-5.1-codex" | "gpt-5.1-codex-max"
            | "gpt-5.1-codex-mini" | "gpt-5.2-codex",
        ) => Some("gpt-5.4"),
        (ProviderName::Google, "gemini-3-pro-preview") => {
            Some("gemini-3.1-pro-preview-customtools")
        }
        (ProviderName::Google, "gemini-3.1-flash-lite-preview") => Some("gemini-3.1-flash-lite"),
        _ => None,
    }
}

pub fn fallback_default_model_id(provider: ProviderName) -> &'static str {
    match provider {
        ProviderName::Google => "gemini-3.1-pro-preview",
        ProviderName::Openai => "gpt-5.4",
        ProviderName::Anthropic => "claude-opus-4-8",
        ProviderName::Bedrock => "amazon.nova-lite-v1:0",
        ProviderName::Baseten => "moonshotai/Kimi-K2.5",
        ProviderName::Together => "moonshotai/Kimi-K2.5",
        ProviderName::Fireworks => "accounts/fireworks/models/kimi-k2p6",
        ProviderName::Firepass => "accounts/fireworks/routers/kimi-k2p6-turbo",
        ProviderName::Nvidia => "nvidia/nemotron-3-super-120b-a12b",
        ProviderName::Minimax => "MiniMax-M3",
        ProviderName::OpencodeGo => "glm-5",
        ProviderName::OpencodeZen => "glm-5",
        ProviderName::CodexCli => "gpt-5.6-sol",
        ProviderName::Lmstudio => "local-model",
    }
}

fn fallback_supported_model(provider: ProviderName, id: &str) -> SupportedModel {
    SupportedModel {
        id: id.to_string(),
        provider,
        display_name: id.to_string(),
        knowledge_cutoff: "End of May 2025".to_string(),
        supports_image_input: matches!(
            provider,
            ProviderName::Google
                | ProviderName::Openai
                | ProviderName::Anthropic
                | ProviderName::CodexCli
        ),
        prompt_template: "default".to_string(),
        provider_options_defaults: Map::new(),
        supported_reasoning_efforts: None,
        is_default: true,
    }
}

impl ModelRegistry {
    pub fn load_from_builtin_dir(built_in_dir: &Path) -> Self {
        let mut by_key = HashMap::new();
        let mut defaults = HashMap::new();
        let models_root = built_in_dir.join("config").join("models");

        if let Ok(provider_dirs) = fs::read_dir(&models_root) {
            for entry in provider_dirs.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                let Ok(files) = fs::read_dir(&path) else {
                    continue;
                };
                for file in files.flatten() {
                    let fpath = file.path();
                    if fpath.extension().and_then(|e| e.to_str()) != Some("json") {
                        continue;
                    }
                    let Ok(raw) = fs::read_to_string(&fpath) else {
                        continue;
                    };
                    let Ok(parsed) = serde_json::from_str::<SupportedModel>(&raw) else {
                        continue;
                    };
                    let key = format!("{}:{}", parsed.provider.as_str(), parsed.id);
                    if parsed.is_default {
                        defaults.insert(parsed.provider, parsed.clone());
                    }
                    by_key.insert(key, parsed);
                }
            }
        }

        Self { by_key, defaults }
    }

    pub fn get(&self, provider: ProviderName, model_id: &str) -> Option<&SupportedModel> {
        let trimmed = model_id.trim();
        let effective = legacy_model_alias(provider, trimmed).unwrap_or(trimmed);
        let key = format!("{}:{effective}", provider.as_str());
        self.by_key.get(&key)
    }

    pub fn default_for(&self, provider: ProviderName) -> SupportedModel {
        if let Some(found) = self.defaults.get(&provider) {
            return found.clone();
        }
        fallback_supported_model(provider, fallback_default_model_id(provider))
    }

    pub fn resolve_model_for_config(
        &self,
        provider: ProviderName,
        requested_model: Option<&str>,
        homedir: &Path,
        env: &HashMap<String, String>,
    ) -> SupportedModel {
        let paths = get_ai_coworker_paths(Some(homedir), env);
        let Some(raw_id) = requested_model.map(str::trim).filter(|s| !s.is_empty()) else {
            if provider.is_runtime_discovery_provider()
                && let Some(cache) = read_model_discovery_cache_sync(&paths, provider, None)
                && let Some(first) = cache
                    .models
                    .iter()
                    .find(|m| m.is_default == Some(true))
                    .or_else(|| cache.models.first())
            {
                return fallback_supported_model(provider, &first.id);
            }
            return self.default_for(provider);
        };

        let normalized_id = legacy_model_alias(provider, raw_id).unwrap_or(raw_id);
        if let Some(static_model) = self.get(provider, normalized_id) {
            return static_model.clone();
        }

        // Runtime discovery providers (lmstudio) accept arbitrary configured model IDs.
        if provider.is_runtime_discovery_provider() {
            return fallback_supported_model(provider, normalized_id);
        }

        // Check provider discovery cache or user custom-models store.
        if let Some(cache) = read_model_discovery_cache_sync(&paths, provider, None)
            && let Some(cached) = cache.models.iter().find(|m| m.id == normalized_id)
        {
            let mut m = fallback_supported_model(provider, &cached.id);
            if let Some(cutoff) = &cached.knowledge_cutoff {
                m.knowledge_cutoff = cutoff.clone();
            }
            if let Some(img) = cached.supports_image_input {
                m.supports_image_input = img;
            }
            return m;
        }

        if provider.supports_custom_model_ids()
            && let Ok(custom_store) = read_custom_model_store_sync(&paths)
            && custom_store
                .providers
                .get(&provider)
                .is_some_and(|list| list.iter().any(|e| e.id == normalized_id))
        {
            return fallback_supported_model(provider, normalized_id);
        }

        // Intentional resilience matching `src/config.ts`: fall back to provider default.
        self.default_for(provider)
    }
}

/// Drops model-gated reasoning/thinking keys carried over from a previous model when the
/// newly resolved model's `providerOptionsDefaults` does not declare them (`src/models/metadata.ts`).
pub fn reconcile_reasoning_provider_options(
    provider_options: &Map<String, Value>,
    provider: ProviderName,
    resolved_defaults: &Map<String, Value>,
) -> Option<Map<String, Value>> {
    let gated_keys: &[&str] = match provider {
        ProviderName::Openai => &["reasoningEffort", "reasoningSummary", "textVerbosity"],
        ProviderName::Google => &["thinkingConfig"],
        ProviderName::Anthropic => &["thinking", "effort"],
        _ => &[],
    };

    let mut out = provider_options.clone();
    if !gated_keys.is_empty()
        && let Some(Value::Object(section)) = out.get_mut(provider.as_str())
    {
        for key in gated_keys {
            if !resolved_defaults.contains_key(*key) {
                section.remove(*key);
            }
        }
        if section.is_empty() {
            out.remove(provider.as_str());
        }
    }

    if out.is_empty() { None } else { Some(out) }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedChildRouting {
    pub child_model_routing_mode: ChildModelRoutingMode,
    pub preferred_child_model: String,
    pub preferred_child_model_ref: String,
    pub allowed_child_model_refs: Vec<String>,
}

pub fn parse_child_model_ref(
    raw: &str,
    default_provider: Option<ProviderName>,
) -> Option<(ProviderName, String, String, bool)> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(colon) = trimmed.find(':') {
        let p_raw = trimmed[..colon].trim();
        let m_raw = trimmed[colon + 1..].trim();
        if let Some(p) = ProviderName::parse(p_raw) {
            if m_raw.is_empty() {
                return None;
            }
            let effective = legacy_model_alias(p, m_raw).unwrap_or(m_raw).to_string();
            let full_ref = format!("{}:{effective}", p.as_str());
            return Some((p, effective, full_ref, true));
        }
    }
    let p = default_provider?;
    let effective = legacy_model_alias(p, trimmed)
        .unwrap_or(trimmed)
        .to_string();
    let full_ref = format!("{}:{effective}", p.as_str());
    Some((p, effective, full_ref, false))
}

pub fn normalize_child_routing_config(
    provider: ProviderName,
    model: &str,
    mode: ChildModelRoutingMode,
    preferred_ref_raw: Option<&str>,
    allowed_refs_raw: Option<&[String]>,
) -> NormalizedChildRouting {
    let fallback_ref = format!("{}:{model}", provider.as_str());
    let mut allowed = Vec::new();
    if let Some(raw_list) = allowed_refs_raw {
        for item in raw_list {
            if let Some((_, _, r, _)) = parse_child_model_ref(item, Some(provider))
                && !allowed.contains(&r)
            {
                allowed.push(r);
            }
        }
    }

    let mut preferred_ref = fallback_ref.clone();
    if let Some(raw_pref) = preferred_ref_raw.map(str::trim).filter(|s| !s.is_empty())
        && let Some((pref_provider, _, full_ref, _)) =
            parse_child_model_ref(raw_pref, Some(provider))
    {
        match mode {
            ChildModelRoutingMode::SameProvider => {
                if pref_provider == provider {
                    preferred_ref = full_ref;
                }
            }
            ChildModelRoutingMode::CrossProviderAllowlist => {
                preferred_ref = full_ref;
            }
        }
    }

    if mode == ChildModelRoutingMode::CrossProviderAllowlist
        && !allowed.is_empty()
        && !allowed.contains(&preferred_ref)
    {
        preferred_ref = allowed[0].clone();
    }

    let preferred_child_model = parse_child_model_ref(&preferred_ref, Some(provider))
        .filter(|(p, _, _, _)| *p == provider)
        .map(|(_, m, _, _)| m)
        .unwrap_or_else(|| model.to_string());

    NormalizedChildRouting {
        child_model_routing_mode: mode,
        preferred_child_model,
        preferred_child_model_ref: preferred_ref,
        allowed_child_model_refs: allowed,
    }
}
