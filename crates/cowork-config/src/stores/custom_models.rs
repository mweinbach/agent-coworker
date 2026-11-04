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

const CUSTOM_MODEL_STORE_FILENAME: &str = "custom-models.json";
const MAX_CUSTOM_MODEL_ID_LENGTH: usize = 2048;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomModelEntry {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomModelStore {
    pub version: u8,
    pub updated_at: String,
    pub providers: BTreeMap<ProviderName, Vec<CustomModelEntry>>,
}

impl CustomModelStore {
    pub fn empty() -> Self {
        Self {
            version: 1,
            updated_at: Utc::now().to_rfc3339(),
            providers: BTreeMap::new(),
        }
    }
}

fn custom_model_store_path(paths: &AiCoworkerPaths) -> PathBuf {
    paths.config_dir.join(CUSTOM_MODEL_STORE_FILENAME)
}

pub fn normalize_custom_model_id(raw: &str, source: &str) -> Result<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(ConfigError::Validation(format!("{source} is required.")));
    }
    if trimmed
        .chars()
        .any(|c| (c as u32) <= 31 || (c as u32) == 127)
    {
        return Err(ConfigError::Validation(format!(
            "{source} cannot contain control characters."
        )));
    }
    if trimmed.len() > MAX_CUSTOM_MODEL_ID_LENGTH {
        return Err(ConfigError::Validation(format!(
            "{source} must be {MAX_CUSTOM_MODEL_ID_LENGTH} characters or fewer."
        )));
    }
    Ok(trimmed.to_string())
}

fn parse_custom_model_store_json(raw: &str, file_path: &Path) -> Result<CustomModelStore> {
    let val: Value = serde_json::from_str(raw).map_err(|e| ConfigError::InvalidJson {
        path: file_path.to_path_buf(),
        message: e.to_string(),
    })?;
    let Some(obj) = val.as_object() else {
        return Err(ConfigError::Validation(
            "Invalid custom model store: root must be object".to_string(),
        ));
    };
    for key in obj.keys() {
        if !matches!(key.as_str(), "version" | "updatedAt" | "providers") {
            return Err(ConfigError::Validation(format!(
                "Invalid custom model store key: {key}"
            )));
        }
    }
    if obj.get("version").and_then(Value::as_u64) != Some(1) {
        return Err(ConfigError::Validation(
            "Invalid custom model store version".to_string(),
        ));
    }
    let Some(updated_at) = obj
        .get("updatedAt")
        .and_then(Value::as_str)
        .filter(|s| DateTime::parse_from_rfc3339(s).is_ok())
    else {
        return Err(ConfigError::Validation(
            "Invalid custom model store updatedAt".to_string(),
        ));
    };
    let Some(raw_providers) = obj.get("providers").and_then(Value::as_object) else {
        return Err(ConfigError::Validation(
            "Invalid custom model store providers".to_string(),
        ));
    };

    let mut providers = BTreeMap::new();
    for (prov_raw, entries_val) in raw_providers {
        let Some(prov) =
            ProviderName::parse(prov_raw).filter(ProviderName::supports_custom_model_ids)
        else {
            continue;
        };
        let Some(arr) = entries_val.as_array() else {
            continue;
        };
        let mut by_id: HashMap<String, CustomModelEntry> = HashMap::new();
        for entry_val in arr {
            let Some(eobj) = entry_val.as_object() else {
                continue;
            };
            let Some(id_raw) = eobj.get("id").and_then(Value::as_str) else {
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
            let display_name = eobj
                .get("displayName")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToOwned::to_owned);
            by_id.insert(
                id.clone(),
                CustomModelEntry {
                    id,
                    display_name,
                    updated_at: ts.to_string(),
                },
            );
        }
        if !by_id.is_empty() {
            let mut list: Vec<CustomModelEntry> = by_id.into_values().collect();
            list.sort_by(|a, b| a.id.cmp(&b.id));
            providers.insert(prov, list);
        }
    }

    Ok(CustomModelStore {
        version: 1,
        updated_at: updated_at.to_string(),
        providers,
    })
}

pub fn read_custom_model_store_sync(paths: &AiCoworkerPaths) -> Result<CustomModelStore> {
    ensure_ai_coworker_home(paths)?;
    let file_path = custom_model_store_path(paths);
    let raw = match fs::read_to_string(&file_path) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(CustomModelStore::empty()),
        Err(source) => {
            return Err(ConfigError::Io {
                path: file_path,
                source,
            });
        }
    };
    match parse_custom_model_store_json(&raw, &file_path) {
        Ok(store) => Ok(store),
        Err(ConfigError::InvalidJson { .. } | ConfigError::Validation(_)) => {
            Ok(CustomModelStore::empty())
        }
        Err(e) => Err(e),
    }
}

pub async fn read_custom_model_store(paths: &AiCoworkerPaths) -> Result<CustomModelStore> {
    read_custom_model_store_sync(paths)
}

fn write_custom_model_store_sync(paths: &AiCoworkerPaths, store: &CustomModelStore) -> Result<()> {
    ensure_ai_coworker_home(paths)?;
    let file_path = custom_model_store_path(paths);
    let payload =
        serde_json::to_string_pretty(store).map_err(|e| ConfigError::Validation(e.to_string()))?;
    write_text_file_atomic(&file_path, &payload, Some(0o600))?;
    harden_private_file_sync(&file_path);
    Ok(())
}

pub async fn upsert_custom_model(
    paths: &AiCoworkerPaths,
    provider: ProviderName,
    model_id_raw: &str,
) -> Result<CustomModelEntry> {
    if !provider.supports_custom_model_ids() {
        return Err(ConfigError::UnsupportedProvider(
            provider.as_str().to_string(),
            "custom model IDs",
        ));
    }
    let id = normalize_custom_model_id(model_id_raw, "model id")?;
    let file_path = custom_model_store_path(paths);
    let lock_root = file_lock_root_for_cowork_home(&paths.root_dir);

    with_file_lock(
        &file_path,
        || async {
            let mut store = read_custom_model_store_sync(paths)?;
            let now = Utc::now().to_rfc3339();
            let list = store.providers.entry(provider).or_default();
            let existing_display = list
                .iter()
                .find(|e| e.id == id)
                .and_then(|e| e.display_name.clone());
            list.retain(|e| e.id != id);
            let next_entry = CustomModelEntry {
                id: id.clone(),
                display_name: existing_display,
                updated_at: now.clone(),
            };
            list.push(next_entry.clone());
            list.sort_by(|a, b| a.id.cmp(&b.id));
            store.updated_at = now;
            write_custom_model_store_sync(paths, &store)?;
            Ok(next_entry)
        },
        FileLockOptions {
            lock_root: Some(lock_root),
            ..Default::default()
        },
    )
    .await
}

pub async fn delete_custom_model(
    paths: &AiCoworkerPaths,
    provider: ProviderName,
    model_id_raw: &str,
) -> Result<()> {
    if !provider.supports_custom_model_ids() {
        return Err(ConfigError::UnsupportedProvider(
            provider.as_str().to_string(),
            "custom model IDs",
        ));
    }
    let id = normalize_custom_model_id(model_id_raw, "model id")?;
    let file_path = custom_model_store_path(paths);
    let lock_root = file_lock_root_for_cowork_home(&paths.root_dir);

    with_file_lock(
        &file_path,
        || async {
            let mut store = read_custom_model_store_sync(paths)?;
            let Some(existing) = store.providers.get_mut(&provider) else {
                return Ok(());
            };
            let before = existing.len();
            existing.retain(|e| e.id != id);
            if existing.len() == before {
                return Ok(());
            }
            if existing.is_empty() {
                store.providers.remove(&provider);
            }
            store.updated_at = Utc::now().to_rfc3339();
            write_custom_model_store_sync(paths, &store)?;
            Ok(())
        },
        FileLockOptions {
            lock_root: Some(lock_root),
            ..Default::default()
        },
    )
    .await
}
