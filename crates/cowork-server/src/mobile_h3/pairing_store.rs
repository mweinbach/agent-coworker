use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use chrono::{SecondsFormat, Utc};
use cowork_config::{canonicalize_sync, ensure_private_dir_sync, write_text_file_atomic};
use dashmap::DashMap;
use data_encoding::BASE64URL_NOPAD;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex as AsyncMutex;

use crate::mobile_h3::cert::resolve_h3_pairing_store_dir;
use crate::startup::{MobileDevicePermissions, MobileTrustedDevice};

const DEVICES_FILE_NAME: &str = "devices.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct H3TrustedDeviceRecord {
    pub device_id: String,
    pub identity_pub: String,
    pub display_name: Option<String>,
    pub fingerprint: String,
    pub session_token_hash: String,
    pub last_paired_at: String,
    pub last_connected_at: Option<String>,
    pub permissions: MobileDevicePermissions,
}

impl H3TrustedDeviceRecord {
    pub fn to_summary(&self) -> MobileTrustedDevice {
        MobileTrustedDevice {
            device_id: self.device_id.clone(),
            fingerprint: self.fingerprint.clone(),
            display_name: self.display_name.clone(),
            last_paired_at: Some(self.last_paired_at.clone()),
            last_connected_at: self.last_connected_at.clone(),
            permissions: self.permissions.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct H3PairingStoreState {
    pub version: u8,
    pub trusted_devices: Vec<H3TrustedDeviceRecord>,
}

impl Default for H3PairingStoreState {
    fn default() -> Self {
        Self {
            version: 1,
            trusted_devices: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExpectedDeviceId<'a> {
    Any,
    Header(Option<&'a str>),
}

fn store_locks() -> &'static DashMap<PathBuf, Arc<AsyncMutex<()>>> {
    static LOCKS: OnceLock<DashMap<PathBuf, Arc<AsyncMutex<()>>>> = OnceLock::new();
    LOCKS.get_or_init(DashMap::new)
}

fn lock_for_store(store_root: &Path) -> Arc<AsyncMutex<()>> {
    let key = canonicalize_sync(store_root);
    store_locks()
        .entry(key)
        .or_insert_with(|| Arc::new(AsyncMutex::new(())))
        .value()
        .clone()
}

fn resolve_devices_file(store_root: &Path) -> PathBuf {
    resolve_h3_pairing_store_dir(store_root).join(DEVICES_FILE_NAME)
}

pub fn sha256_base64url(value: &str) -> String {
    BASE64URL_NOPAD.encode(&Sha256::digest(value.as_bytes()))
}

fn now_iso_millis() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn trimmed_non_empty(val: Option<&Value>) -> Option<String> {
    val.and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn normalize_permissions(raw: Option<&Value>) -> MobileDevicePermissions {
    let mut perms = MobileDevicePermissions::default();
    let Some(obj) = raw.and_then(Value::as_object) else {
        return perms;
    };
    perms.turns = obj.get("turns").and_then(Value::as_bool) == Some(true);
    perms.server_requests = obj.get("serverRequests").and_then(Value::as_bool) == Some(true);
    perms.provider_auth = obj.get("providerAuth").and_then(Value::as_bool) == Some(true);
    perms.mcp_auth = obj.get("mcpAuth").and_then(Value::as_bool) == Some(true);
    perms.workspace_settings = obj.get("workspaceSettings").and_then(Value::as_bool) == Some(true);
    perms.backups = obj.get("backups").and_then(Value::as_bool) == Some(true);
    perms.conversations = obj.get("conversations").and_then(Value::as_bool) == Some(true);

    // Grandfather devices paired before `conversations` existed in `devices.json`.
    if !obj.contains_key("conversations") {
        perms.conversations = true;
    }
    perms
}

fn normalize_device_record(raw: &Value) -> Option<H3TrustedDeviceRecord> {
    let obj = raw.as_object()?;
    let device_id = trimmed_non_empty(obj.get("deviceId"))?;
    let identity_pub = trimmed_non_empty(obj.get("identityPub"))?;
    let fingerprint = trimmed_non_empty(obj.get("fingerprint"))?;
    let session_token_hash = trimmed_non_empty(obj.get("sessionTokenHash"))?;
    let display_name = trimmed_non_empty(obj.get("displayName"));
    let last_paired_at = trimmed_non_empty(obj.get("lastPairedAt")).unwrap_or_else(now_iso_millis);
    let last_connected_at = trimmed_non_empty(obj.get("lastConnectedAt"));
    let permissions = normalize_permissions(obj.get("permissions"));

    Some(H3TrustedDeviceRecord {
        device_id,
        identity_pub,
        display_name,
        fingerprint,
        session_token_hash,
        last_paired_at,
        last_connected_at,
        permissions,
    })
}

fn normalize_store_state(raw: &Value) -> H3PairingStoreState {
    let Some(obj) = raw.as_object() else {
        return H3PairingStoreState::default();
    };
    let trusted_devices = obj
        .get("trustedDevices")
        .and_then(Value::as_array)
        .map(|arr| arr.iter().filter_map(normalize_device_record).collect())
        .unwrap_or_default();
    H3PairingStoreState {
        version: 1,
        trusted_devices,
    }
}

fn load_store_unlocked(store_root: &Path) -> H3PairingStoreState {
    let path = resolve_devices_file(store_root);
    let Ok(raw) = std::fs::read_to_string(path) else {
        return H3PairingStoreState::default();
    };
    let Ok(val) = serde_json::from_str::<Value>(&raw) else {
        return H3PairingStoreState::default();
    };
    normalize_store_state(&val)
}

fn persist_store_unlocked(
    store_root: &Path,
    state: &H3PairingStoreState,
) -> anyhow::Result<H3PairingStoreState> {
    let val = serde_json::to_value(state).unwrap_or_else(|_| json!({}));
    let normalized = normalize_store_state(&val);
    let dir = resolve_h3_pairing_store_dir(store_root);
    ensure_private_dir_sync(&dir)?;
    let path = resolve_devices_file(store_root);
    let serialized = serde_json::to_string_pretty(&normalized)?;
    write_text_file_atomic(&path, &serialized, Some(0o600))?;
    Ok(normalized)
}

pub async fn load_h3_pairing_store_state(store_root: &Path) -> H3PairingStoreState {
    load_store_unlocked(store_root)
}

pub async fn list_h3_trusted_devices(store_root: &Path) -> Vec<H3TrustedDeviceRecord> {
    load_store_unlocked(store_root).trusted_devices
}

pub async fn remember_h3_trusted_device(
    store_root: &Path,
    device_id: &str,
    identity_pub: &str,
    display_name: Option<&str>,
    session_token: &str,
) -> anyhow::Result<H3TrustedDeviceRecord> {
    let mutex = lock_for_store(store_root);
    let _guard = mutex.lock().await;

    let now = now_iso_millis();
    let fp_full = sha256_base64url(identity_pub);
    let fingerprint = fp_full.chars().take(16).collect::<String>();
    let state = load_store_unlocked(store_root);
    let existing = state
        .trusted_devices
        .iter()
        .find(|d| d.device_id == device_id);

    let permissions = match existing {
        Some(prev) if prev.identity_pub == identity_pub => prev.permissions.clone(),
        _ => MobileDevicePermissions::default(),
    };

    let record = H3TrustedDeviceRecord {
        device_id: device_id.to_owned(),
        identity_pub: identity_pub.to_owned(),
        display_name: display_name
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned),
        fingerprint,
        session_token_hash: sha256_base64url(session_token),
        last_paired_at: now.clone(),
        last_connected_at: Some(now),
        permissions,
    };

    let mut trusted_devices: Vec<H3TrustedDeviceRecord> = state
        .trusted_devices
        .into_iter()
        .filter(|d| d.device_id != device_id)
        .collect();
    trusted_devices.insert(0, record.clone());
    persist_store_unlocked(
        store_root,
        &H3PairingStoreState {
            version: 1,
            trusted_devices,
        },
    )?;
    Ok(record)
}

pub fn apply_permission_patch(perms: &mut MobileDevicePermissions, patch: &Map<String, Value>) {
    if let Some(v) = patch.get("turns").and_then(Value::as_bool) {
        perms.turns = v;
    }
    if let Some(v) = patch.get("serverRequests").and_then(Value::as_bool) {
        perms.server_requests = v;
    }
    if let Some(v) = patch.get("providerAuth").and_then(Value::as_bool) {
        perms.provider_auth = v;
    }
    if let Some(v) = patch.get("mcpAuth").and_then(Value::as_bool) {
        perms.mcp_auth = v;
    }
    if let Some(v) = patch.get("workspaceSettings").and_then(Value::as_bool) {
        perms.workspace_settings = v;
    }
    if let Some(v) = patch.get("backups").and_then(Value::as_bool) {
        perms.backups = v;
    }
    if let Some(v) = patch.get("conversations").and_then(Value::as_bool) {
        perms.conversations = v;
    }
}

pub async fn update_h3_trusted_device_permissions(
    store_root: &Path,
    device_id: &str,
    permissions_patch: &Map<String, Value>,
) -> anyhow::Result<Option<H3TrustedDeviceRecord>> {
    let normalized_id = device_id.trim();
    if normalized_id.is_empty() {
        return Ok(None);
    }
    let mutex = lock_for_store(store_root);
    let _guard = mutex.lock().await;

    let mut state = load_store_unlocked(store_root);
    let Some(target) = state
        .trusted_devices
        .iter_mut()
        .find(|d| d.device_id == normalized_id)
    else {
        return Ok(None);
    };
    apply_permission_patch(&mut target.permissions, permissions_patch);
    let updated = target.clone();
    persist_store_unlocked(store_root, &state)?;
    Ok(Some(updated))
}

fn parse_expected_device_id<'a>(expected: ExpectedDeviceId<'a>) -> Option<Option<&'a str>> {
    match expected {
        ExpectedDeviceId::Any => Some(None),
        ExpectedDeviceId::Header(None) => None,
        ExpectedDeviceId::Header(Some(raw)) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(Some(trimmed))
            }
        }
    }
}

pub async fn find_h3_trusted_device_by_session_token(
    store_root: &Path,
    session_token: Option<&str>,
    expected_device_id: ExpectedDeviceId<'_>,
) -> Option<H3TrustedDeviceRecord> {
    let token = session_token.filter(|s| !s.is_empty())?;
    let expected = parse_expected_device_id(expected_device_id)?;
    let token_hash = sha256_base64url(token);
    let state = load_store_unlocked(store_root);
    state.trusted_devices.into_iter().find(|d| {
        d.session_token_hash == token_hash
            && expected.is_none_or(|expected_id| d.device_id == expected_id)
    })
}

pub async fn verify_h3_session_token(
    store_root: &Path,
    session_token: Option<&str>,
    expected_device_id: ExpectedDeviceId<'_>,
) -> anyhow::Result<Option<H3TrustedDeviceRecord>> {
    let Some(token) = session_token.filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    let Some(expected) = parse_expected_device_id(expected_device_id) else {
        return Ok(None);
    };
    let mutex = lock_for_store(store_root);
    let _guard = mutex.lock().await;

    let token_hash = sha256_base64url(token);
    let mut state = load_store_unlocked(store_root);
    let Some(matched) = state.trusted_devices.iter_mut().find(|d| {
        d.session_token_hash == token_hash
            && expected.is_none_or(|expected_id| d.device_id == expected_id)
    }) else {
        return Ok(None);
    };
    matched.last_connected_at = Some(now_iso_millis());
    let updated = matched.clone();
    persist_store_unlocked(store_root, &state)?;
    Ok(Some(updated))
}

pub async fn forget_h3_trusted_device(store_root: &Path, device_id: &str) -> anyhow::Result<bool> {
    let normalized_id = device_id.trim();
    if normalized_id.is_empty() {
        return Ok(false);
    }
    let mutex = lock_for_store(store_root);
    let _guard = mutex.lock().await;

    let mut state = load_store_unlocked(store_root);
    let before = state.trusted_devices.len();
    state
        .trusted_devices
        .retain(|d| d.device_id != normalized_id);
    if state.trusted_devices.len() == before {
        return Ok(false);
    }
    persist_store_unlocked(store_root, &state)?;
    Ok(true)
}

pub async fn forget_h3_trusted_devices(store_root: &Path) -> anyhow::Result<()> {
    let mutex = lock_for_store(store_root);
    let _guard = mutex.lock().await;
    persist_store_unlocked(store_root, &H3PairingStoreState::default())?;
    Ok(())
}
