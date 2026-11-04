use std::collections::{BTreeSet, HashMap};

use cowork_config::{
    AgentConfig, ChildModelRoutingMode, ModelRegistry, ProviderName, env_map_from_process,
    parse_child_model_ref, resolve_builtin_dir,
};
use serde_json::{Map, Value};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedChildModel {
    pub provider: ProviderName,
    pub model_id: String,
    pub canonical_ref: String,
    pub requested_model: Option<String>,
    pub requested_reasoning_effort: Option<String>,
    pub effective_reasoning_effort: Option<String>,
}

fn load_registry_with_repo_fallback(cfg: &AgentConfig) -> ModelRegistry {
    if cfg.built_in_dir.join("config/models").is_dir() {
        return ModelRegistry::load_from_builtin_dir(&cfg.built_in_dir);
    }
    if let Ok(root) = resolve_builtin_dir(&env_map_from_process()) {
        return ModelRegistry::load_from_builtin_dir(&root);
    }
    ModelRegistry::load_from_builtin_dir(&cfg.built_in_dir)
}

/// Whether `model_id` is selectable for `provider` using the same catalog the root session
/// resolves models against (`ModelRegistry::resolve_model_for_config`): the bundled registry,
/// the provider discovery cache, and the user's custom-model store (plus LM Studio's arbitrary
/// runtime IDs). That resolver falls back to the provider default for unknown IDs, so an ID is
/// known only when it resolves to itself.
fn is_selectable_model(
    registry: &ModelRegistry,
    cfg: &AgentConfig,
    provider: ProviderName,
    model_id: &str,
) -> bool {
    if registry.get(provider, model_id).is_some() {
        return true;
    }
    // `user_cowork_dir` is `<home>/.cowork`; the resolver derives store paths from `<home>`.
    let Some(homedir) = cfg.user_cowork_dir.parent() else {
        return false;
    };
    let resolved =
        registry.resolve_model_for_config(provider, Some(model_id), homedir, &HashMap::new());
    resolved.id == model_id.trim()
}

/// `OPENAI_COMPATIBLE_PROVIDER_NAMES` (`src/shared/openaiCompatibleOptions.ts`).
fn is_openai_compatible_provider(provider: ProviderName) -> bool {
    matches!(provider, ProviderName::Openai | ProviderName::CodexCli)
}

/// `OPENAI_REASONING_EFFORT_VALUES` (`src/shared/openaiCompatibleOptions.ts`).
fn is_openai_reasoning_effort(value: &str) -> bool {
    matches!(
        value,
        "none" | "minimal" | "light" | "low" | "medium" | "high" | "xhigh" | "max"
    )
}

/// The parent's current effort from its (merged) provider options — `currentReasoningEffort`
/// in `modelRouter.ts`. Only OpenAI-compatible providers carry a `reasoningEffort`.
fn current_reasoning_effort(cfg: &AgentConfig, provider: ProviderName) -> Option<String> {
    if !is_openai_compatible_provider(provider) {
        return None;
    }
    cfg.provider_options
        .as_ref()?
        .get(provider.as_str())?
        .as_object()?
        .get("reasoningEffort")?
        .as_str()
        .filter(|v| is_openai_reasoning_effort(v))
        .map(str::to_owned)
}

/// Resolved `providerOptionsDefaults` of a selectable child model: the bundled registry entry,
/// else the root resolver's view (discovery cache / custom-model store placeholders, which
/// declare no defaults) — `getResolvedModelMetadataSync(...).providerOptionsDefaults`.
fn resolved_provider_option_defaults(
    registry: &ModelRegistry,
    cfg: &AgentConfig,
    provider: ProviderName,
    model_id: &str,
) -> Map<String, Value> {
    if let Some(entry) = registry.get(provider, model_id) {
        return entry.provider_options_defaults.clone();
    }
    let Some(homedir) = cfg.user_cowork_dir.parent() else {
        return Map::new();
    };
    let resolved =
        registry.resolve_model_for_config(provider, Some(model_id), homedir, &HashMap::new());
    if resolved.id == model_id.trim() {
        resolved.provider_options_defaults
    } else {
        Map::new()
    }
}

/// `modelDefaultReasoningEffort` in `modelRouter.ts`.
fn model_default_reasoning_effort(
    registry: &ModelRegistry,
    cfg: &AgentConfig,
    provider: ProviderName,
    model_id: &str,
) -> Option<String> {
    resolved_provider_option_defaults(registry, cfg, provider, model_id)
        .get("reasoningEffort")?
        .as_str()
        .filter(|v| is_openai_reasoning_effort(v))
        .map(str::to_owned)
}

pub fn resolve_child_model_selection(
    cfg: &AgentConfig,
    parent_provider: ProviderName,
    parent_model: &str,
    requested_model: Option<&str>,
    requested_reasoning_effort: Option<&str>,
    connected_providers: &BTreeSet<ProviderName>,
) -> Result<ResolvedChildModel, String> {
    let registry = load_registry_with_repo_fallback(cfg);
    let trimmed_req = requested_model.map(str::trim).filter(|s| !s.is_empty());

    let (target_provider, target_model_id, canonical_ref) = match trimmed_req {
        None => (
            parent_provider,
            parent_model.to_owned(),
            format!("{}:{parent_model}", parent_provider.as_str()),
        ),
        Some(raw) => {
            // `parseChildModelRef(requestedModel, parentConfig.provider, ...)` in
            // `routeAgentConfig` (`src/server/agents/modelRouter.ts`): only a known provider
            // name before the first `:` selects a provider. Any other colon-bearing string
            // (Bedrock `amazon.nova-micro-v1:0`, inference-profile ARNs, Ollama-style
            // `llama3:8b`) is a model ID on the parent provider.
            let Some((prov, model_id, full_ref, explicit)) =
                parse_child_model_ref(raw, Some(parent_provider))
            else {
                return Err(format!("Invalid child model reference '{raw}'."));
            };
            if !explicit
                && raw != parent_model
                && model_id != parent_model
                && !is_selectable_model(&registry, cfg, parent_provider, &model_id)
            {
                return Err(format!(
                    "Model '{raw}' is not supported by parent provider '{}'. Specify a 'provider:model' ref if cross-provider routing is enabled.",
                    parent_provider.as_str()
                ));
            }
            (prov, model_id, full_ref)
        }
    };

    if target_provider == parent_provider {
        // `routeAgentConfig`: a same-provider LM Studio child on a different model needs LM
        // Studio connected. An empty connected set means connectivity is unknown, so the check
        // only applies when the caller reported at least one connected provider.
        if trimmed_req.is_some()
            && target_provider == ProviderName::Lmstudio
            && target_model_id != parent_model
            && !connected_providers.is_empty()
            && !connected_providers.contains(&ProviderName::Lmstudio)
        {
            return Err(format!(
                "Requested child target {canonical_ref} could not be used because LM Studio is not connected. No child was started."
            ));
        }
        if target_model_id != parent_model
            && !is_selectable_model(&registry, cfg, target_provider, &target_model_id)
        {
            return Err(format!(
                "Model '{}' is not registered for provider '{}'.",
                target_model_id,
                target_provider.as_str()
            ));
        }
    } else {
        if cfg.child_model_routing_mode != ChildModelRoutingMode::CrossProviderAllowlist {
            return Err(format!(
                "Cross-provider child model '{canonical_ref}' is blocked because childModelRoutingMode is 'same-provider' (parent provider: '{}').",
                parent_provider.as_str()
            ));
        }
        let allowlisted = cfg
            .allowed_child_model_refs
            .iter()
            .any(|allowed| allowed.trim() == canonical_ref);
        if !allowlisted {
            return Err(format!(
                "Cross-provider child model '{canonical_ref}' is not in allowedChildModelRefs."
            ));
        }
        if !connected_providers.contains(&target_provider) {
            return Err(format!(
                "Target provider '{}' for child model '{canonical_ref}' is not authenticated/connected.",
                target_provider.as_str()
            ));
        }
        if !is_selectable_model(&registry, cfg, target_provider, &target_model_id) {
            return Err(format!(
                "Allowlisted child model '{canonical_ref}' does not exist in the model registry."
            ));
        }
    }

    let req_effort = requested_reasoning_effort
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);

    // `routeAgentConfig` (`src/server/agents/modelRouter.ts`): a requested effort passes through
    // verbatim (the runtime normalizes it per model). Without one, a changed child model uses its
    // own default effort (none for a non-reasoning model, so a reasoning parent's effort is never
    // handed to a model that rejects it); only an unchanged child inherits the parent's current
    // effort. Any explicit model request counts as a change, even one naming the parent's model.
    let child_model_changed = trimmed_req.is_some()
        || target_provider != parent_provider
        || target_model_id != parent_model;
    let effective_reasoning_effort = req_effort.clone().or_else(|| {
        if child_model_changed {
            model_default_reasoning_effort(&registry, cfg, target_provider, &target_model_id)
        } else {
            current_reasoning_effort(cfg, parent_provider)
        }
    });

    Ok(ResolvedChildModel {
        provider: target_provider,
        model_id: target_model_id,
        canonical_ref,
        requested_model: trimmed_req.map(str::to_owned),
        requested_reasoning_effort: req_effort,
        effective_reasoning_effort,
    })
}
