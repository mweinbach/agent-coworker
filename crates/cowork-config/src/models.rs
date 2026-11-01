use std::collections::HashMap;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::paths::{AiCoworkerPaths, get_ai_coworker_paths};
use crate::providers::{ChildModelRoutingMode, ProviderName};
use crate::stores::{
    CachedModelDiscoveryModel, read_custom_model_store_sync, read_model_discovery_cache_sync,
};

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

/// Placeholder metadata for a Bedrock model ID absent from the bundled
/// manifests (inference-profile ARNs, newly released foundation models, …).
/// Matches `buildBedrockPlaceholderMetadata` in the TypeScript
/// `src/providers/bedrockShared.ts`: the ID is used verbatim, with conservative
/// capabilities (no image input) and the shared `system.md` prompt template.
fn bedrock_placeholder_model(id: &str) -> SupportedModel {
    SupportedModel {
        id: id.to_string(),
        provider: ProviderName::Bedrock,
        display_name: id.to_string(),
        knowledge_cutoff: "Unknown".to_string(),
        supports_image_input: false,
        prompt_template: "system.md".to_string(),
        provider_options_defaults: Map::new(),
        supported_reasoning_efforts: None,
        is_default: false,
    }
}

/// Placeholder metadata for a non-bundled model ID the resolver accepts.
fn placeholder_supported_model(provider: ProviderName, id: &str) -> SupportedModel {
    match provider {
        ProviderName::Bedrock => bedrock_placeholder_model(id),
        _ => fallback_supported_model(provider, id),
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
            let mut m = placeholder_supported_model(provider, &cached.id);
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
            return placeholder_supported_model(provider, normalized_id);
        }

        // Bedrock resolves models at runtime like TypeScript's
        // `isRuntimeDiscoveryProvider` (`src/models/metadata.ts`): any configured
        // identifier — including inference-profile ARNs and foundation models
        // missing from the bundled manifests — is preserved verbatim with
        // placeholder metadata instead of silently switching to the default.
        if provider == ProviderName::Bedrock {
            return bedrock_placeholder_model(normalized_id);
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

/// Effort values recognised as OpenAI-style reasoning efforts (`OPENAI_REASONING_EFFORT_VALUES`
/// in `src/shared/openaiCompatibleOptions.ts`).
const OPENAI_REASONING_EFFORT_VALUES: [&str; 8] = [
    "none", "minimal", "light", "low", "medium", "high", "xhigh", "max",
];

fn is_openai_reasoning_effort(value: &str) -> bool {
    OPENAI_REASONING_EFFORT_VALUES.contains(&value)
}

/// Provider-default keys that make a runtime emit a reasoning/thinking payload
/// (`REASONING_PROVIDER_OPTION_KEYS` in `src/models/metadata.ts`).
fn reasoning_provider_option_keys(provider: ProviderName) -> &'static [&'static str] {
    match provider {
        ProviderName::Openai => &["reasoningEffort", "reasoningSummary"],
        ProviderName::Google => &["thinkingConfig"],
        ProviderName::Anthropic => &["thinking", "effort"],
        _ => &[],
    }
}

/// `customModelIdLikelySupportsReasoning`: only OpenAI has an id-only heuristic; every other
/// provider conservatively assumes a custom id does not reason.
fn custom_model_id_likely_supports_reasoning(provider: ProviderName, model_id: &str) -> bool {
    if provider == ProviderName::Openai {
        let id = model_id.trim().to_ascii_lowercase();
        return id.starts_with('o') || id.starts_with("gpt-5");
    }
    false
}

/// `customModelIdLikelySupportsGpt5Params`: verbosity is GPT-5-family only.
fn custom_model_id_likely_supports_gpt5_params(provider: ProviderName, model_id: &str) -> bool {
    if provider == ProviderName::Openai {
        return model_id.trim().to_ascii_lowercase().starts_with("gpt-5");
    }
    true
}

/// `providerOptionsDefaults` for a non-bundled model id, derived from the provider default
/// model's defaults (`buildProviderPlaceholderMetadata` in `src/models/metadata.ts`).
///
/// `supports_reasoning` is the explicit capability decision a discovered model carries; `None`
/// falls back to the id heuristic used for custom ids.
pub fn placeholder_provider_option_defaults(
    provider: ProviderName,
    model_id: &str,
    provider_default_options: &Map<String, Value>,
    supports_reasoning: Option<bool>,
) -> Map<String, Value> {
    let mut defaults = provider_default_options.clone();
    let supports_reasoning = supports_reasoning
        .unwrap_or_else(|| custom_model_id_likely_supports_reasoning(provider, model_id));
    if !supports_reasoning {
        for key in reasoning_provider_option_keys(provider) {
            defaults.remove(*key);
        }
    }
    if provider == ProviderName::Openai
        && !custom_model_id_likely_supports_gpt5_params(provider, model_id)
    {
        defaults.remove("textVerbosity");
    }
    defaults
}

/// Whether a discovery-cache entry advertises reasoning support: it carries a default effort or
/// at least one available effort (`cacheHasReasoning` in `buildDiscoveredModelMetadata`).
pub fn discovered_model_supports_reasoning(cached: &CachedModelDiscoveryModel) -> bool {
    cached.reasoning.as_ref().is_some_and(|r| {
        r.default_effort.is_some() || r.available_efforts.as_ref().is_some_and(|e| !e.is_empty())
    })
}

/// `providerOptionsDefaults` for a model found in the provider's discovery cache, honouring the
/// cached entry's reasoning info instead of the custom-id heuristic
/// (`buildDiscoveredModelMetadata` in `src/models/metadata.ts`).
pub fn discovered_provider_option_defaults(
    provider: ProviderName,
    cached: &CachedModelDiscoveryModel,
    provider_default_options: &Map<String, Value>,
) -> Map<String, Value> {
    let mut defaults = placeholder_provider_option_defaults(
        provider,
        &cached.id,
        provider_default_options,
        Some(discovered_model_supports_reasoning(cached)),
    );
    if !defaults.contains_key("reasoningEffort") {
        return defaults;
    }
    // Prefer the advertised default, then the provider fallback, then the first advertised
    // choice; never introduce an effort outside the model's declared choices.
    let available = cached
        .reasoning
        .as_ref()
        .and_then(|r| r.available_efforts.as_deref())
        .unwrap_or_default();
    let allowed = |effort: &str| {
        is_openai_reasoning_effort(effort)
            && (available.is_empty() || available.iter().any(|a| a == effort))
    };
    let advertised_default = cached
        .reasoning
        .as_ref()
        .and_then(|r| r.default_effort.clone());
    let fallback_default = defaults
        .get("reasoningEffort")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let chosen = [advertised_default, fallback_default]
        .into_iter()
        .flatten()
        .find(|e| allowed(e))
        .or_else(|| {
            available
                .iter()
                .find(|e| is_openai_reasoning_effort(e))
                .cloned()
        });
    if let Some(effort) = chosen {
        defaults.insert("reasoningEffort".to_owned(), Value::String(effort));
    }
    defaults
}

/// Looks up `model_id` (by `id` or `model`) in the provider's unscoped discovery cache under
/// `paths` (`getDiscoveredModelMetadataSync` in `src/models/metadata.ts`). Missing or invalid
/// caches read as `None`.
pub fn find_discovered_model_sync(
    paths: &AiCoworkerPaths,
    provider: ProviderName,
    model_id: &str,
) -> Option<CachedModelDiscoveryModel> {
    let trimmed = model_id.trim();
    if trimmed.is_empty() {
        return None;
    }
    let cache = read_model_discovery_cache_sync(paths, provider, None)?;
    cache
        .models
        .into_iter()
        .find(|m| m.id == trimmed || m.model.as_deref() == Some(trimmed))
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stores::CachedModelReasoning;
    use serde_json::json;

    fn bundled_registry() -> ModelRegistry {
        let repo_root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(Path::parent)
            .expect("workspace root");
        let registry = ModelRegistry::load_from_builtin_dir(repo_root);
        assert!(
            registry
                .get(ProviderName::Bedrock, "amazon.nova-lite-v1:0")
                .is_some(),
            "bundled bedrock manifests must load"
        );
        registry
    }

    fn resolve_isolated(provider: ProviderName, model: &str) -> SupportedModel {
        let home = tempfile::tempdir().unwrap();
        bundled_registry().resolve_model_for_config(
            provider,
            Some(model),
            home.path(),
            &HashMap::new(),
        )
    }

    fn assert_bedrock_placeholder(resolved: &SupportedModel, id: &str) {
        assert_eq!(resolved.id, id);
        assert_eq!(resolved.provider, ProviderName::Bedrock);
        assert_eq!(resolved.display_name, id);
        assert_eq!(resolved.knowledge_cutoff, "Unknown");
        assert!(!resolved.supports_image_input);
        assert_eq!(resolved.prompt_template, "system.md");
        assert!(resolved.provider_options_defaults.is_empty());
        assert!(resolved.supported_reasoning_efforts.is_none());
    }

    #[test]
    fn bedrock_inference_profile_arn_is_preserved() {
        let arn = "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-x";
        let resolved = resolve_isolated(ProviderName::Bedrock, arn);
        assert_bedrock_placeholder(&resolved, arn);
    }

    #[test]
    fn bedrock_unlisted_model_id_is_preserved() {
        let resolved = resolve_isolated(
            ProviderName::Bedrock,
            "  meta.llama4-maverick-17b-instruct-v1:0 ",
        );
        assert_bedrock_placeholder(&resolved, "meta.llama4-maverick-17b-instruct-v1:0");
    }

    #[test]
    fn bedrock_bundled_model_keeps_manifest_metadata() {
        let resolved = resolve_isolated(ProviderName::Bedrock, "amazon.nova-micro-v1:0");
        assert_eq!(resolved.display_name, "Amazon Nova Micro");
        assert!(!resolved.is_default);
    }

    #[test]
    fn unknown_model_for_static_provider_still_falls_back_to_default() {
        let resolved = resolve_isolated(ProviderName::Openai, "definitely-not-a-model");
        assert_eq!(
            resolved.id,
            bundled_registry().default_for(ProviderName::Openai).id
        );
    }

    fn discovered(id: &str, reasoning: Option<CachedModelReasoning>) -> CachedModelDiscoveryModel {
        CachedModelDiscoveryModel {
            id: id.to_owned(),
            model: None,
            display_name: id.to_owned(),
            description: None,
            knowledge_cutoff: None,
            supports_image_input: None,
            is_default: None,
            reasoning,
            runtime_options: None,
            runtime_overrides: None,
        }
    }

    fn efforts(default: Option<&str>, available: &[&str]) -> Option<CachedModelReasoning> {
        Some(CachedModelReasoning {
            default_effort: default.map(ToOwned::to_owned),
            available_efforts: (!available.is_empty())
                .then(|| available.iter().map(|s| (*s).to_owned()).collect()),
        })
    }

    #[test]
    fn discovered_google_model_keeps_thinking_config_only_with_reasoning_info() {
        let google_defaults = bundled_registry()
            .default_for(ProviderName::Google)
            .provider_options_defaults;
        assert!(google_defaults.contains_key("thinkingConfig"));

        let reasoning = discovered("gemini-x", efforts(Some("high"), &["low", "high"]));
        assert!(discovered_model_supports_reasoning(&reasoning));
        let kept =
            discovered_provider_option_defaults(ProviderName::Google, &reasoning, &google_defaults);
        assert!(kept.contains_key("thinkingConfig"));
        assert!(!kept.contains_key("reasoningEffort"));

        let available_only = discovered("gemini-y", efforts(None, &["low"]));
        assert!(discovered_model_supports_reasoning(&available_only));

        for plain in [
            discovered("gemini-z", None),
            discovered("gemini-z", efforts(None, &[])),
        ] {
            assert!(!discovered_model_supports_reasoning(&plain));
            let pruned =
                discovered_provider_option_defaults(ProviderName::Google, &plain, &google_defaults);
            assert!(!pruned.contains_key("thinkingConfig"));
        }

        // Custom (non-discovered) Google ids keep the conservative no-reasoning heuristic.
        let custom = placeholder_provider_option_defaults(
            ProviderName::Google,
            "gemini-custom",
            &google_defaults,
            None,
        );
        assert!(!custom.contains_key("thinkingConfig"));
    }

    #[test]
    fn discovered_openai_model_uses_advertised_effort_within_declared_choices() {
        let mut openai_defaults = Map::new();
        openai_defaults.insert("reasoningEffort".into(), json!("high"));
        openai_defaults.insert("reasoningSummary".into(), json!("detailed"));
        openai_defaults.insert("textVerbosity".into(), json!("medium"));

        let advertised = discovered("gpt-4.9", efforts(Some("low"), &["low", "medium"]));
        let out = discovered_provider_option_defaults(
            ProviderName::Openai,
            &advertised,
            &openai_defaults,
        );
        assert_eq!(out["reasoningEffort"], "low");
        assert!(out.contains_key("reasoningSummary"));
        // Verbosity stays GPT-5-family only even when discovery advertises reasoning.
        assert!(!out.contains_key("textVerbosity"));

        // Stale default outside the declared choices falls back to the first advertised effort.
        let stale = discovered("gpt-5-x", efforts(Some("max"), &["minimal", "low"]));
        let out =
            discovered_provider_option_defaults(ProviderName::Openai, &stale, &openai_defaults);
        assert_eq!(out["reasoningEffort"], "minimal");
        assert!(out.contains_key("textVerbosity"));

        // No reasoning info: an `o`-prefixed id still loses reasoning keys once discovered.
        let plain = discovered("o9-plain", None);
        let out =
            discovered_provider_option_defaults(ProviderName::Openai, &plain, &openai_defaults);
        assert!(!out.contains_key("reasoningEffort"));
        assert!(!out.contains_key("reasoningSummary"));
    }

    #[test]
    fn find_discovered_model_matches_id_or_model_field() {
        let home = tempfile::tempdir().unwrap();
        let env = HashMap::new();
        let paths = get_ai_coworker_paths(Some(home.path()), &env);
        let mut aliased = discovered("gemini-alias", efforts(Some("high"), &[]));
        aliased.model = Some("models/gemini-alias-001".into());
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(crate::stores::write_model_discovery_cache(
            &paths,
            ProviderName::Google,
            crate::stores::ModelDiscoveryResult {
                provider: ProviderName::Google,
                source: crate::stores::ModelDiscoverySource::Api,
                models: vec![aliased],
                updated_at: None,
                expires_at: None,
                message: None,
            },
            None,
            None,
        ))
        .unwrap();
        assert!(
            find_discovered_model_sync(&paths, ProviderName::Google, " gemini-alias ").is_some()
        );
        assert!(
            find_discovered_model_sync(&paths, ProviderName::Google, "models/gemini-alias-001")
                .is_some()
        );
        assert!(find_discovered_model_sync(&paths, ProviderName::Google, "other").is_none());
        assert!(find_discovered_model_sync(&paths, ProviderName::Openai, "gemini-alias").is_none());
    }
}
