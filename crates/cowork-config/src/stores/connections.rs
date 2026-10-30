use std::collections::HashMap;
use std::fs;
use std::path::Path;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{ConfigError, Result};
use crate::file_lock::{FileLockOptions, file_lock_root_for_cowork_home, with_file_lock};
use crate::paths::{
    AiCoworkerPaths, ensure_ai_coworker_home, get_ai_coworker_paths, harden_private_file_sync,
    write_text_file_atomic,
};
use crate::providers::ProviderName;

pub const TOOL_API_KEY_NAMES: [&str; 2] = ["exa", "parallel"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolApiKeyName {
    Exa,
    Parallel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionMode {
    ApiKey,
    Oauth,
    OauthPending,
    Credentials,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredConnection {
    pub service: ProviderName,
    pub mode: ConnectionMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub method_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub values: Option<HashMap<String, String>>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolApiKeys {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exa: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parallel: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionStore {
    pub version: u8,
    pub updated_at: String,
    pub services: HashMap<ProviderName, StoredConnection>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_api_keys: Option<ToolApiKeys>,
}

impl ConnectionStore {
    pub fn empty() -> Self {
        Self {
            version: 1,
            updated_at: Utc::now().to_rfc3339(),
            services: HashMap::new(),
            tool_api_keys: None,
        }
    }
}

fn validate_iso_timestamp(ts: &str) -> bool {
    DateTime::parse_from_rfc3339(ts).is_ok()
}

/// Parses and validates `connections.json` identically to `src/store/connections.ts`,
/// skipping unknown service keys while rejecting mismatched `service` fields or unknown top-level keys.
pub fn parse_connection_store_json(raw: &str, file_path: &Path) -> Result<ConnectionStore> {
    let value: Value = serde_json::from_str(raw).map_err(|e| ConfigError::InvalidJson {
        path: file_path.to_path_buf(),
        message: e.to_string(),
    })?;
    let Some(obj) = value.as_object() else {
        return Err(ConfigError::Validation(
            "Invalid connection store schema: root must be object".to_string(),
        ));
    };

    for key in obj.keys() {
        if !matches!(
            key.as_str(),
            "version" | "updatedAt" | "services" | "toolApiKeys"
        ) {
            return Err(ConfigError::Validation(format!(
                "Invalid connection store schema: unrecognized key {key}"
            )));
        }
    }

    if obj.get("version").and_then(Value::as_u64) != Some(1) {
        return Err(ConfigError::Validation(
            "Invalid connection store schema: version must be 1".to_string(),
        ));
    }
    let Some(updated_at) = obj
        .get("updatedAt")
        .and_then(Value::as_str)
        .filter(|s| validate_iso_timestamp(s))
    else {
        return Err(ConfigError::Validation(
            "Invalid connection store schema: invalid updatedAt".to_string(),
        ));
    };
    let Some(raw_services) = obj.get("services").and_then(Value::as_object) else {
        return Err(ConfigError::Validation(
            "Invalid connection store schema: services must be object".to_string(),
        ));
    };

    let mut services = HashMap::new();
    for (service_key, conn_val) in raw_services {
        let Some(provider) = ProviderName::parse(service_key) else {
            // Unknown provider keys are skipped cleanly per `src/store/connections.ts`.
            continue;
        };
        let Some(conn_obj) = conn_val.as_object() else {
            return Err(ConfigError::Validation(format!(
                "Invalid connection entry for {service_key}"
            )));
        };
        let inner_service = conn_obj
            .get("service")
            .and_then(Value::as_str)
            .and_then(ProviderName::parse);
        if inner_service != Some(provider) {
            return Err(ConfigError::Validation(format!(
                "Connection service mismatch for key {service_key}"
            )));
        }
        let parsed_conn: StoredConnection =
            serde_json::from_value(conn_val.clone()).map_err(|e| {
                ConfigError::Validation(format!("Invalid connection entry for {service_key}: {e}"))
            })?;
        if !validate_iso_timestamp(&parsed_conn.updated_at) {
            return Err(ConfigError::Validation(format!(
                "Invalid updatedAt for {service_key}"
            )));
        }
        services.insert(provider, parsed_conn);
    }

    let tool_api_keys = match obj.get("toolApiKeys") {
        Some(v) if !v.is_null() => Some(
            serde_json::from_value::<ToolApiKeys>(v.clone())
                .map_err(|e| ConfigError::Validation(format!("Invalid toolApiKeys: {e}")))?,
        ),
        _ => None,
    };

    Ok(ConnectionStore {
        version: 1,
        updated_at: updated_at.to_string(),
        services,
        tool_api_keys,
    })
}

pub fn read_connection_store_sync(paths: &AiCoworkerPaths) -> Result<ConnectionStore> {
    ensure_ai_coworker_home(paths)?;
    let raw = match fs::read_to_string(&paths.connections_file) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(ConnectionStore::empty()),
        Err(source) => {
            return Err(ConfigError::Io {
                path: paths.connections_file.clone(),
                source,
            });
        }
    };

    match parse_connection_store_json(&raw, &paths.connections_file) {
        Ok(store) => Ok(store),
        Err(ConfigError::InvalidJson { .. } | ConfigError::Validation(_)) => {
            Ok(ConnectionStore::empty())
        }
        Err(other) => Err(other),
    }
}

pub async fn read_connection_store(paths: &AiCoworkerPaths) -> Result<ConnectionStore> {
    read_connection_store_sync(paths)
}

pub async fn write_connection_store(
    paths: &AiCoworkerPaths,
    store: &ConnectionStore,
) -> Result<()> {
    ensure_ai_coworker_home(paths)?;
    let serialized =
        serde_json::to_string_pretty(store).map_err(|e| ConfigError::Validation(e.to_string()))?;
    write_text_file_atomic(&paths.connections_file, &serialized, Some(0o600))?;
    harden_private_file_sync(&paths.connections_file);
    Ok(())
}

pub async fn save_provider_connection(
    paths: &AiCoworkerPaths,
    connection: StoredConnection,
) -> Result<ConnectionStore> {
    let lock_root = file_lock_root_for_cowork_home(&paths.root_dir);
    with_file_lock(
        &paths.connections_file,
        || async {
            let mut store = read_connection_store_sync(paths)?;
            store.updated_at = connection.updated_at.clone();
            store.services.insert(connection.service, connection);
            write_connection_store(paths, &store).await?;
            Ok(store)
        },
        FileLockOptions {
            lock_root: Some(lock_root),
            ..Default::default()
        },
    )
    .await
}

pub async fn remove_provider_connection(
    paths: &AiCoworkerPaths,
    provider: ProviderName,
) -> Result<ConnectionStore> {
    let lock_root = file_lock_root_for_cowork_home(&paths.root_dir);
    with_file_lock(
        &paths.connections_file,
        || async {
            let mut store = read_connection_store_sync(paths)?;
            store.services.remove(&provider);
            store.updated_at = Utc::now().to_rfc3339();
            write_connection_store(paths, &store).await?;
            Ok(store)
        },
        FileLockOptions {
            lock_root: Some(lock_root),
            ..Default::default()
        },
    )
    .await
}

/// Looks up a saved API key for `provider` from `<homedir>/.cowork/auth/connections.json`.
pub fn get_saved_provider_api_key(
    homedir: &Path,
    provider: ProviderName,
) -> Result<Option<String>> {
    let empty_env = HashMap::new();
    let paths = get_ai_coworker_paths(Some(homedir), &empty_env);
    let raw = match fs::read_to_string(&paths.connections_file) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(source) => {
            return Err(ConfigError::Io {
                path: paths.connections_file,
                source,
            });
        }
    };
    let parsed = parse_connection_store_json(&raw, &paths.connections_file)?;
    if let Some(conn) = parsed.services.get(&provider)
        && conn.mode == ConnectionMode::ApiKey
        && let Some(key) = conn.api_key.as_ref().filter(|s| !s.trim().is_empty())
    {
        return Ok(Some(key.clone()));
    }
    Ok(None)
}
