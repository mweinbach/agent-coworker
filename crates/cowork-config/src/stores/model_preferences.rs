use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{ConfigError, Result};
use crate::file_lock::{FileLockOptions, file_lock_root_for_cowork_home, with_file_lock};
use crate::paths::{
    AiCoworkerPaths, ensure_ai_coworker_home, harden_private_file_sync, write_text_file_atomic,
};
use crate::providers::ProviderName;
use crate::stores::normalize_custom_model_id;

const MODEL_PREFERENCES_STORE_FILENAME: &str = "model-preferences.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPreferenceEntry {
    pub id: String,
    pub enabled: bool,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelPreferenceUpdate {
    pub id: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPreferencesStore {
    pub version: u8,
    pub updated_at: String,
    pub providers: BTreeMap<ProviderName, Vec<ModelPreferenceEntry>>,
}

impl ModelPreferencesStore {
    pub fn empty() -> Self {
        Self {
            version: 1,
            updated_at: Utc::now().to_rfc3339(),
            providers: BTreeMap::new(),
        }
    }
}

fn model_preferences_store_path(paths: &AiCoworkerPaths) -> PathBuf {
    paths.config_dir.join(MODEL_PREFERENCES_STORE_FILENAME)
}

fn parse_model_preferences_store_json(
    raw: &str,
    file_path: &Path,
) -> Result<ModelPreferencesStore> {
    let val: Value = serde_json::from_str(raw).map_err(|e| ConfigError::InvalidJson {
        path: file_path.to_path_buf(),
        message: e.to_string(),
    })?;
    let Some(obj) = val.as_object() else {
        return Err(ConfigError::Validation(
            "Invalid model preferences store: root must be object".to_string(),
        ));
    };
    for key in obj.keys() {
        if !matches!(key.as_str(), "version" | "updatedAt" | "providers") {
            return Err(ConfigError::Validation(format!(
                "Invalid model preferences store key: {key}"
            )));
        }
    }
    if obj.get("version").and_then(Value::as_u64) != Some(1) {
        return Err(ConfigError::Validation(
            "Invalid model preferences store version".to_string(),
        ));
    }
    let Some(updated_at) = obj
        .get("updatedAt")
        .and_then(Value::as_str)
        .filter(|s| DateTime::parse_from_rfc3339(s).is_ok())
    else {
        return Err(ConfigError::Validation(
            "Invalid model preferences store updatedAt".to_string(),
        ));
    };
    let Some(raw_providers) = obj.get("providers").and_then(Value::as_object) else {
        return Err(ConfigError::Validation(
            "Invalid model preferences store providers".to_string(),
        ));
    };

    let mut providers = BTreeMap::new();
    for (prov_raw, entries_val) in raw_providers {
        let Some(prov) =
            ProviderName::parse(prov_raw).filter(ProviderName::supports_model_preferences)
        else {
            continue;
        };
        let Some(arr) = entries_val.as_array() else {
            continue;
        };
        let mut by_id: HashMap<String, ModelPreferenceEntry> = HashMap::new();
        for entry_val in arr {
            let Some(eobj) = entry_val.as_object() else {
                continue;
            };
            let Some(id_raw) = eobj.get("id").and_then(Value::as_str) else {
                continue;
            };
            let Some(enabled) = eobj.get("enabled").and_then(Value::as_bool) else {
                continue;
            };
            let Some(ts) = eobj
                .get("updatedAt")
                .and_then(Value::as_str)
                .filter(|s| DateTime::parse_from_rfc3339(s).is_ok())
            else {
                continue;
            };
            let Ok(id) = normalize_custom_model_id(id_raw, "model id") else {
                continue;
            };
            by_id.insert(
                id.clone(),
                ModelPreferenceEntry {
                    id,
                    enabled,
                    updated_at: ts.to_string(),
                },
            );
        }
        if !by_id.is_empty() {
            let mut list: Vec<ModelPreferenceEntry> = by_id.into_values().collect();
            list.sort_by(|a, b| a.id.cmp(&b.id));
            providers.insert(prov, list);
        }
    }

    Ok(ModelPreferencesStore {
        version: 1,
        updated_at: updated_at.to_string(),
        providers,
    })
}

pub fn read_model_preferences_store_sync(paths: &AiCoworkerPaths) -> Result<ModelPreferencesStore> {
    ensure_ai_coworker_home(paths)?;
    let file_path = model_preferences_store_path(paths);
    let raw = match fs::read_to_string(&file_path) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ModelPreferencesStore::empty());
        }
        Err(source) => {
            return Err(ConfigError::Io {
                path: file_path,
                source,
            });
        }
    };
    match parse_model_preferences_store_json(&raw, &file_path) {
        Ok(store) => Ok(store),
        Err(ConfigError::InvalidJson { .. } | ConfigError::Validation(_)) => {
            Ok(ModelPreferencesStore::empty())
        }
        Err(e) => Err(e),
    }
}

pub async fn read_model_preferences_store(
    paths: &AiCoworkerPaths,
) -> Result<ModelPreferencesStore> {
    read_model_preferences_store_sync(paths)
}

pub async fn write_model_preferences_store(
    paths: &AiCoworkerPaths,
    store: &ModelPreferencesStore,
) -> Result<()> {
    ensure_ai_coworker_home(paths)?;
    let file_path = model_preferences_store_path(paths);
    let payload =
        serde_json::to_string_pretty(store).map_err(|e| ConfigError::Validation(e.to_string()))?;
    write_text_file_atomic(&file_path, &payload, Some(0o600))?;
    harden_private_file_sync(&file_path);
    Ok(())
}

pub async fn set_model_preferences(
    paths: &AiCoworkerPaths,
    provider: ProviderName,
    models: &[ModelPreferenceUpdate],
) -> Result<()> {
    if !provider.supports_model_preferences() {
        return Err(ConfigError::UnsupportedProvider(
            provider.as_str().to_string(),
            "model preferences",
        ));
    }
    if models.is_empty() {
        return Ok(());
    }
    let file_path = model_preferences_store_path(paths);
    let lock_root = file_lock_root_for_cowork_home(&paths.root_dir);

    with_file_lock(
        &file_path,
        || async {
            let mut store = read_model_preferences_store_sync(paths)?;
            let now = Utc::now().to_rfc3339();
            let list = store.providers.entry(provider).or_default();
            let mut by_id: HashMap<String, ModelPreferenceEntry> =
                list.drain(..).map(|e| (e.id.clone(), e)).collect();
            for item in models {
                let id = normalize_custom_model_id(&item.id, "model id")?;
                by_id.insert(
                    id.clone(),
                    ModelPreferenceEntry {
                        id,
                        enabled: item.enabled,
                        updated_at: now.clone(),
                    },
                );
            }
            let mut sorted: Vec<ModelPreferenceEntry> = by_id.into_values().collect();
            sorted.sort_by(|a, b| a.id.cmp(&b.id));
            store.providers.insert(provider, sorted);
            store.updated_at = now;
            write_model_preferences_store(paths, &store).await
        },
        FileLockOptions {
            lock_root: Some(lock_root),
            ..Default::default()
        },
    )
    .await
}

pub async fn reset_model_preferences(
    paths: &AiCoworkerPaths,
    provider: ProviderName,
) -> Result<()> {
    if !provider.supports_model_preferences() {
        return Err(ConfigError::UnsupportedProvider(
            provider.as_str().to_string(),
            "model preferences",
        ));
    }
    let file_path = model_preferences_store_path(paths);
    let lock_root = file_lock_root_for_cowork_home(&paths.root_dir);

    with_file_lock(
        &file_path,
        || async {
            let mut store = read_model_preferences_store_sync(paths)?;
            if store.providers.remove(&provider).is_none() {
                return Ok(());
            }
            store.updated_at = Utc::now().to_rfc3339();
            write_model_preferences_store(paths, &store).await
        },
        FileLockOptions {
            lock_root: Some(lock_root),
            ..Default::default()
        },
    )
    .await
}
