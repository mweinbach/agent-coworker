use std::collections::BTreeSet;
use std::path::Path;

use cowork_config::{
    AgentConfig, ChildModelRoutingMode, ModelRegistry, ProviderName, parse_child_model_ref,
};

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
    let manifest_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent);
    if let Some(root) = manifest_root
        && root.join("config/models").is_dir()
    {
        return ModelRegistry::load_from_builtin_dir(root);
    }
    ModelRegistry::load_from_builtin_dir(&cfg.built_in_dir)
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
            if raw.contains(':') {
                let Some((prov, model_id, full_ref, explicit)) = parse_child_model_ref(raw, None)
                else {
                    return Err(format!("Invalid child model reference '{raw}'."));
                };
                if !explicit {
                    return Err(format!(
                        "Invalid provider prefix in child model reference '{raw}'."
                    ));
                }
                (prov, model_id, full_ref)
            } else {
                if registry.get(parent_provider, raw).is_some()
                    || parent_provider == ProviderName::Lmstudio
                    || raw == parent_model
                {
                    let (_, eff, full_ref, _) =
                        parse_child_model_ref(raw, Some(parent_provider)).unwrap();
                    (parent_provider, eff, full_ref)
                } else {
                    return Err(format!(
                        "Model '{raw}' is not supported by parent provider '{}'. Specify a 'provider:model' ref if cross-provider routing is enabled.",
                        parent_provider.as_str()
                    ));
                }
            }
        }
    };

    if target_provider == parent_provider {
        if target_provider != ProviderName::Lmstudio
            && target_model_id != parent_model
            && registry.get(target_provider, &target_model_id).is_none()
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
        if target_provider != ProviderName::Lmstudio
            && registry.get(target_provider, &target_model_id).is_none()
        {
            return Err(format!(
                "Allowlisted child model '{canonical_ref}' does not exist in the model registry."
            ));
        }
    }

    let req_effort = requested_reasoning_effort
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);

    let effective_reasoning_effort =
        if let Some(entry) = registry.get(target_provider, &target_model_id) {
            match &entry.supported_reasoning_efforts {
                None => None,
                Some(levels) if levels.is_empty() => None,
                Some(levels) => {
                    if let Some(ref eff) = req_effort
                        && levels.iter().any(|l| l == eff)
                    {
                        Some(eff.clone())
                    } else {
                        entry
                            .provider_options_defaults
                            .get("reasoningEffort")
                            .and_then(|v| v.as_str())
                            .map(str::to_owned)
                            .or_else(|| levels.first().cloned())
                    }
                }
            }
        } else {
            req_effort.clone()
        };

    Ok(ResolvedChildModel {
        provider: target_provider,
        model_id: target_model_id,
        canonical_ref,
        requested_model: trimmed_req.map(str::to_owned),
        requested_reasoning_effort: req_effort,
        effective_reasoning_effort,
    })
}
