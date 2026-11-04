use std::collections::HashMap;
use std::fs;
use std::path::Path;

use cowork_config::{
    ModelRegistry, ProviderName, SupportedModel, legacy_model_alias,
    reconcile_reasoning_provider_options,
};
use serde_json::{Map, Value};

use crate::error::InferenceError;

/// Validated model registry loaded from `config/models/<provider>/*.json`, bridging static
/// manifests, legacy model aliases, runtime discovery caches, and custom model stores.
#[derive(Debug, Clone)]
pub struct InferenceModelRegistry {
    inner: ModelRegistry,
    models: Vec<SupportedModel>,
    by_provider: HashMap<ProviderName, Vec<SupportedModel>>,
}

impl InferenceModelRegistry {
    /// Strictly loads and validates every `config/models/<provider>/*.json` manifest under `repo_root`.
    pub fn load_from_repo_root(repo_root: &Path) -> Result<Self, InferenceError> {
        let models_root = repo_root.join("config").join("models");
        Self::load_from_models_dir(&models_root, repo_root)
    }

    /// Loads manifests from an explicit `config/models` directory.
    pub fn load_from_models_dir(
        models_dir: &Path,
        built_in_root: &Path,
    ) -> Result<Self, InferenceError> {
        let entries = fs::read_dir(models_dir).map_err(|err| {
            InferenceError::RegistryLoad(format!(
                "Failed to read model registry directory {}: {err}",
                models_dir.display()
            ))
        })?;

        let mut models = Vec::new();
        let mut by_provider: HashMap<ProviderName, Vec<SupportedModel>> = HashMap::new();

        let mut provider_dirs: Vec<_> = entries.flatten().map(|e| e.path()).collect();
        provider_dirs.sort();

        for provider_dir in provider_dirs {
            if !provider_dir.is_dir() {
                continue;
            }
            let dir_entries = fs::read_dir(&provider_dir).map_err(|err| {
                InferenceError::RegistryLoad(format!(
                    "Failed to read provider model directory {}: {err}",
                    provider_dir.display()
                ))
            })?;
            let mut json_paths: Vec<_> = dir_entries
                .flatten()
                .map(|f| f.path())
                .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("json"))
                .collect();
            json_paths.sort();

            for json_path in json_paths {
                let raw = fs::read_to_string(&json_path).map_err(|err| {
                    InferenceError::RegistryLoad(format!(
                        "Failed to read model manifest {}: {err}",
                        json_path.display()
                    ))
                })?;
                let parsed: SupportedModel = serde_json::from_str(&raw).map_err(|err| {
                    InferenceError::RegistryLoad(format!(
                        "Invalid model manifest {}: {err}",
                        json_path.display()
                    ))
                })?;
                by_provider
                    .entry(parsed.provider)
                    .or_default()
                    .push(parsed.clone());
                models.push(parsed);
            }
        }

        let inner = ModelRegistry::load_from_builtin_dir(built_in_root);
        Ok(Self {
            inner,
            models,
            by_provider,
        })
    }

    pub fn all_models(&self) -> &[SupportedModel] {
        &self.models
    }

    pub fn models_for_provider(&self, provider: ProviderName) -> &[SupportedModel] {
        self.by_provider
            .get(&provider)
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }

    pub fn get(&self, provider: ProviderName, model_id: &str) -> Option<&SupportedModel> {
        let trimmed = model_id.trim();
        let effective = legacy_model_alias(provider, trimmed).unwrap_or(trimmed);
        self.inner.get(provider, effective).or_else(|| {
            self.by_provider
                .get(&provider)?
                .iter()
                .find(|m| m.id == effective)
        })
    }

    pub fn default_for(&self, provider: ProviderName) -> SupportedModel {
        self.inner.default_for(provider)
    }

    pub fn resolve_for_session(
        &self,
        provider: ProviderName,
        requested_model: Option<&str>,
        homedir: &Path,
        env: &HashMap<String, String>,
    ) -> SupportedModel {
        self.inner
            .resolve_model_for_config(provider, requested_model, homedir, env)
    }

    pub fn reconcile_provider_options(
        &self,
        provider_options: &Map<String, Value>,
        model: &SupportedModel,
    ) -> Option<Map<String, Value>> {
        reconcile_reasoning_provider_options(
            provider_options,
            model.provider,
            &model.provider_options_defaults,
        )
    }
}
