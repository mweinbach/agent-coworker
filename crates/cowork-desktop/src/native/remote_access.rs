//! Native mobile H3 Remote Access coordinator matching
//! `apps/desktop/electron/services/mobileRelayBridge.ts` and `cowork-server`'s `/mobile-h3/*` endpoints.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use chrono::DateTime;
use serde_json::{Map, Value, json};
use tokio::sync::Mutex as AsyncMutex;

use crate::actions::StoreEvent;
use crate::state::{PrivacyTelemetrySettings, RemoteAccessState, TrustedPhoneSummary};

use super::local_logs::{LocalLogFileName, LocalLogLevel, LocalLogger};
use super::product_analytics::ProductAnalyticsService;
use super::server_manager::{
    ServerManager, StartWorkspaceServerOptions, WorkspaceServerFeatureFlags,
};

pub const TRUSTED_PHONE_PERMISSION_KEYS: &[&str] = &[
    "turns",
    "serverRequests",
    "providerAuth",
    "mcpAuth",
    "workspaceSettings",
    "backups",
    "conversations",
];

/// Parses user/UI permission text (JSON object, `"all"`, `"none"`, or CSV keys) into a
/// `MobileDevicePermissions` JSON object suitable for `PATCH /mobile-h3/trusted/<id>/permissions`.
pub fn parse_permissions_patch(raw: &str) -> Result<Map<String, Value>, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Trusted phone permissions cannot be empty.".into());
    }

    if trimmed.starts_with('{') {
        let Value::Object(obj) = serde_json::from_str::<Value>(trimmed)
            .map_err(|e| format!("Invalid permissions JSON: {e}"))?
        else {
            return Err("Permissions JSON must be an object.".into());
        };
        let mut patch = Map::new();
        for key in TRUSTED_PHONE_PERMISSION_KEYS {
            if let Some(val) = obj.get(*key).and_then(Value::as_bool) {
                patch.insert((*key).to_string(), Value::Bool(val));
            }
        }
        if patch.is_empty() {
            return Err(
                "Permissions object contained no recognized boolean permission keys.".into(),
            );
        }
        return Ok(patch);
    }

    let lower = trimmed.to_ascii_lowercase();
    if matches!(lower.as_str(), "all" | "full" | "read-write") {
        return Ok(TRUSTED_PHONE_PERMISSION_KEYS
            .iter()
            .map(|k| ((*k).to_string(), Value::Bool(true)))
            .collect());
    }
    if matches!(lower.as_str(), "none" | "read-only" | "readonly") {
        return Ok(TRUSTED_PHONE_PERMISSION_KEYS
            .iter()
            .map(|k| ((*k).to_string(), Value::Bool(false)))
            .collect());
    }

    let requested: HashSet<String> = trimmed
        .split([',', ' ', ';'])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string)
        .collect();
    let recognized: HashSet<&str> = TRUSTED_PHONE_PERMISSION_KEYS
        .iter()
        .copied()
        .filter(|k| requested.iter().any(|r| r.eq_ignore_ascii_case(k)))
        .collect();
    if recognized.is_empty() {
        return Err(format!("Unrecognized permission string: {trimmed}"));
    }

    Ok(TRUSTED_PHONE_PERMISSION_KEYS
        .iter()
        .map(|k| ((*k).to_string(), Value::Bool(recognized.contains(k))))
        .collect())
}

/// Formats a `MobileDevicePermissions` JSON object as a canonical comma-separated string.
pub fn format_mobile_permissions(perms: &Value) -> String {
    let Some(obj) = perms.as_object() else {
        return "none".to_string();
    };
    let enabled: Vec<&str> = TRUSTED_PHONE_PERMISSION_KEYS
        .iter()
        .copied()
        .filter(|k| obj.get(*k).and_then(Value::as_bool) == Some(true))
        .collect();
    if enabled.is_empty() {
        "none".to_string()
    } else {
        enabled.join(", ")
    }
}

fn parse_epoch_millis(raw: Option<&Value>) -> i64 {
    let Some(s) = raw
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return 0;
    };
    DateTime::parse_from_rfc3339(s)
        .map(|dt| dt.timestamp_millis())
        .unwrap_or(0)
}

fn trusted_devices_from_mobile_h3(mobile_h3: &Value) -> Vec<TrustedPhoneSummary> {
    let mut records: Vec<&Value> = mobile_h3
        .get("trustedDevices")
        .and_then(Value::as_array)
        .map(|arr| arr.iter().collect())
        .unwrap_or_default();

    if records.is_empty()
        && let Some(single) = mobile_h3.get("trustedDevice")
        && single.is_object()
    {
        records.push(single);
    }

    records
        .into_iter()
        .filter_map(|dev| {
            let obj = dev.as_object()?;
            let id = obj.get("deviceId").and_then(Value::as_str)?.to_string();
            let name = obj
                .get("displayName")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or("Trusted Phone")
                .to_string();
            let paired_at = parse_epoch_millis(obj.get("lastPairedAt"));
            let permissions = obj
                .get("permissions")
                .map(format_mobile_permissions)
                .unwrap_or_else(|| "none".to_string());
            Some(TrustedPhoneSummary {
                id,
                name,
                paired_at,
                permissions,
            })
        })
        .collect()
}

/// Converts a `cowork-server` `mobileH3` listening/snapshot object into UI [`RemoteAccessState`].
pub fn remote_access_state_from_mobile_h3(
    available: bool,
    mobile_h3: Option<&Value>,
    error: Option<String>,
) -> RemoteAccessState {
    let Some(h3) = mobile_h3.filter(|v| v.is_object()) else {
        return RemoteAccessState {
            available,
            running: false,
            pairing_url: None,
            trusted_phones: Vec::new(),
            error,
            relay_url: None,
        };
    };

    let relay_url = h3
        .get("url")
        .and_then(Value::as_str)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let ticket_url = h3
        .get("ticket")
        .and_then(Value::as_str)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let pairing_url = ticket_url.or_else(|| relay_url.clone());
    let trusted_phones = trusted_devices_from_mobile_h3(h3);

    RemoteAccessState {
        available,
        running: pairing_url.is_some(),
        pairing_url,
        trusted_phones,
        error,
        relay_url,
    }
}

#[derive(Clone, Default)]
struct RemoteAccessRuntime {
    available: bool,
    desired_enabled: bool,
    active_workspace_id: Option<String>,
    known_workspaces: HashMap<String, (PathBuf, bool)>,
    preferred_workspace_id: Option<String>,
    last_state: RemoteAccessState,
}

/// Serialized coordinator controlling `--mobile-h3` pairing and `/mobile-h3/trusted` updates.
#[derive(Clone)]
pub struct RemoteAccessBridge {
    server_manager: ServerManager,
    logger: Option<Arc<LocalLogger>>,
    analytics: Option<ProductAnalyticsService>,
    emit: Arc<dyn Fn(StoreEvent) + Send + Sync>,
    state: Arc<Mutex<RemoteAccessRuntime>>,
    mutation_lock: Arc<AsyncMutex<()>>,
}

impl RemoteAccessBridge {
    pub fn new(
        server_manager: ServerManager,
        logger: Option<Arc<LocalLogger>>,
        emit: Arc<dyn Fn(StoreEvent) + Send + Sync>,
        available: bool,
    ) -> Self {
        Self {
            server_manager,
            logger,
            analytics: None,
            emit,
            state: Arc::new(Mutex::new(RemoteAccessRuntime {
                available,
                last_state: RemoteAccessState {
                    available,
                    ..RemoteAccessState::default()
                },
                ..RemoteAccessRuntime::default()
            })),
            mutation_lock: Arc::new(AsyncMutex::new(())),
        }
    }

    pub fn with_analytics(mut self, analytics: ProductAnalyticsService) -> Self {
        self.analytics = Some(analytics);
        self
    }

    pub fn current_state(&self) -> RemoteAccessState {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .last_state
            .clone()
    }

    pub fn desired_for_workspace(&self, workspace_id: &str) -> bool {
        let guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        guard.available
            && guard.desired_enabled
            && guard.active_workspace_id.as_deref() == Some(workspace_id)
    }

    pub fn sync_catalog(
        &self,
        available: bool,
        preferred_workspace_id: Option<&str>,
        workspaces: &[(String, PathBuf, bool)],
    ) {
        let next_emit = {
            let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
            let prev_avail = guard.available;
            guard.available = available;
            guard.preferred_workspace_id = preferred_workspace_id.map(ToString::to_string);
            guard.known_workspaces.clear();
            for (id, path, yolo) in workspaces {
                guard
                    .known_workspaces
                    .insert(id.clone(), (path.clone(), *yolo));
            }
            if !available {
                guard.desired_enabled = false;
                guard.active_workspace_id = None;
                let stopped = RemoteAccessState {
                    available: false,
                    ..RemoteAccessState::default()
                };
                if guard.last_state != stopped {
                    guard.last_state = stopped.clone();
                    Some(stopped)
                } else {
                    None
                }
            } else if prev_avail != available {
                guard.last_state.available = available;
                Some(guard.last_state.clone())
            } else {
                None
            }
        };
        if let Some(ev) = next_emit {
            (self.emit)(StoreEvent::RemoteAccessChanged(ev));
        }
    }

    pub fn on_server_started(&self, workspace_id: &str, mobile_h3: Option<&Value>) {
        let next_emit = {
            let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
            let is_owner = guard.active_workspace_id.as_deref() == Some(workspace_id);
            if mobile_h3.is_some() || is_owner {
                if mobile_h3.is_some() {
                    guard.active_workspace_id = Some(workspace_id.to_string());
                } else {
                    guard.active_workspace_id = None;
                }
                let next = remote_access_state_from_mobile_h3(guard.available, mobile_h3, None);
                guard.last_state = next.clone();
                Some(next)
            } else {
                None
            }
        };
        if let Some(ev) = next_emit {
            (self.emit)(StoreEvent::RemoteAccessChanged(ev));
        }
    }

    pub fn on_server_exited(&self, workspace_id: &str) {
        let next_emit = {
            let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
            if guard.active_workspace_id.as_deref() == Some(workspace_id) {
                guard.active_workspace_id = None;
                let next = RemoteAccessState {
                    available: guard.available,
                    ..RemoteAccessState::default()
                };
                guard.last_state = next.clone();
                Some(next)
            } else {
                None
            }
        };
        if let Some(ev) = next_emit {
            (self.emit)(StoreEvent::RemoteAccessChanged(ev));
        }
    }

    fn resolve_target(&self) -> Option<(String, PathBuf, bool)> {
        let guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let preferred = guard
            .active_workspace_id
            .as_deref()
            .or(guard.preferred_workspace_id.as_deref());
        if let Some(target) = self.server_manager.preferred_workspace_target(preferred) {
            return Some(target);
        }
        if let Some(id) = preferred
            && let Some((path, yolo)) = guard.known_workspaces.get(id)
        {
            return Some((id.to_string(), path.clone(), *yolo));
        }
        guard
            .known_workspaces
            .iter()
            .next()
            .map(|(id, (path, yolo))| (id.clone(), path.clone(), *yolo))
    }

    pub async fn set_enabled(
        &self,
        enabled: bool,
        feature_flags: WorkspaceServerFeatureFlags,
        privacy_telemetry: Option<PrivacyTelemetrySettings>,
    ) {
        let _lock = self.mutation_lock.lock().await;
        let available = {
            let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
            guard.desired_enabled = enabled && guard.available;
            guard.available
        };

        if !available {
            self.emit_error(
                false,
                "Remote access is disabled or unavailable in packaged builds.",
            );
            return;
        }

        if !enabled {
            let active_ws = {
                let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
                guard.active_workspace_id.take()
            };
            if let Some(ws_id) = active_ws
                && let Some((_, path, yolo)) =
                    self.server_manager.preferred_workspace_target(Some(&ws_id))
            {
                let _ = self
                    .server_manager
                    .start_workspace_server(StartWorkspaceServerOptions {
                        workspace_id: ws_id,
                        workspace_path: path,
                        yolo,
                        force_restart: false,
                        mobile_h3: Some(false),
                        rotate_mobile_h3_tls: false,
                        feature_flags,
                        privacy_telemetry,
                    })
                    .await;
            }
            self.publish_state(RemoteAccessState {
                available: true,
                running: false,
                pairing_url: None,
                trusted_phones: Vec::new(),
                error: None,
                relay_url: None,
            });
            return;
        }

        let Some((ws_id, path, yolo)) = self.resolve_target() else {
            self.emit_error(
                true,
                "Open or add a workspace before enabling Remote Access.",
            );
            return;
        };

        self.start_or_rotate(ws_id, path, yolo, false, feature_flags, privacy_telemetry)
            .await;
    }

    pub async fn rotate_session(
        &self,
        feature_flags: WorkspaceServerFeatureFlags,
        privacy_telemetry: Option<PrivacyTelemetrySettings>,
    ) {
        let _lock = self.mutation_lock.lock().await;
        let available = self
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .available;
        if !available {
            self.emit_error(false, "Remote access is unavailable.");
            return;
        }
        let Some((ws_id, path, yolo)) = self.resolve_target() else {
            self.emit_error(
                true,
                "No workspace server is available to rotate Remote Access.",
            );
            return;
        };
        {
            let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
            guard.desired_enabled = true;
        }
        self.start_or_rotate(ws_id, path, yolo, true, feature_flags, privacy_telemetry)
            .await;
    }

    async fn start_or_rotate(
        &self,
        workspace_id: String,
        workspace_path: PathBuf,
        yolo: bool,
        rotate_tls: bool,
        feature_flags: WorkspaceServerFeatureFlags,
        privacy_telemetry: Option<PrivacyTelemetrySettings>,
    ) {
        {
            let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
            guard.active_workspace_id = Some(workspace_id.clone());
        }

        let started_at = Instant::now();
        if let Some(analytics) = &self.analytics {
            let mut props = BTreeMap::new();
            props.insert("status".into(), json!("requested"));
            props.insert("mobilePairingEnabled".into(), json!(true));
            analytics.capture_event("mobile_pairing_started", &props);
        }

        let result = self
            .server_manager
            .start_workspace_server(StartWorkspaceServerOptions {
                workspace_id: workspace_id.clone(),
                workspace_path,
                yolo,
                force_restart: rotate_tls,
                mobile_h3: Some(true),
                rotate_mobile_h3_tls: rotate_tls,
                feature_flags,
                privacy_telemetry,
            })
            .await;

        let duration_ms = started_at.elapsed().as_millis() as u64;
        match result {
            Ok(started) => {
                let next =
                    remote_access_state_from_mobile_h3(true, started.mobile_h3.as_ref(), None);
                if let Some(analytics) = &self.analytics {
                    let mut props = BTreeMap::new();
                    props.insert("durationMs".into(), json!(duration_ms));
                    props.insert(
                        "status".into(),
                        json!(if next.running { "ok" } else { "error" }),
                    );
                    props.insert("mobilePairingEnabled".into(), json!(next.running));
                    analytics.capture_event("mobile_pairing_completed", &props);
                }
                self.publish_state(next);
            }
            Err(err) => {
                if let Some(analytics) = &self.analytics {
                    let mut props = BTreeMap::new();
                    props.insert("durationMs".into(), json!(duration_ms));
                    props.insert("status".into(), json!("error"));
                    props.insert("mobilePairingEnabled".into(), json!(false));
                    analytics.capture_event("mobile_pairing_completed", &props);
                }
                if let Some(logger) = &self.logger {
                    let meta = serde_json::json!({ "workspaceId": workspace_id, "error": err });
                    logger.write(
                        LocalLogFileName::Server,
                        LocalLogLevel::Warn,
                        "remote-access",
                        "failed to start/rotate mobile H3 relay",
                        Some(&meta),
                    );
                }
                self.emit_error(true, &err);
            }
        }
    }

    async fn apply_trusted_device_mutation<F, Fut>(&self, op: F)
    where
        F: FnOnce(String) -> Fut,
        Fut: std::future::Future<Output = Result<Option<Value>, String>>,
    {
        let (available, active_ws) = {
            let guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
            (guard.available, guard.active_workspace_id.clone())
        };
        let Some(ws_id) = active_ws else {
            self.emit_error(available, "Remote access is not currently running.");
            return;
        };
        match op(ws_id).await {
            Ok(updated_h3) => {
                let next = remote_access_state_from_mobile_h3(available, updated_h3.as_ref(), None);
                self.publish_state(next);
            }
            Err(err) => {
                self.emit_error(available, &err);
            }
        }
    }

    pub async fn update_trusted_phone_permissions(&self, phone_id: &str, raw_permissions: &str) {
        let _lock = self.mutation_lock.lock().await;
        let patch = match parse_permissions_patch(raw_permissions) {
            Ok(p) => p,
            Err(err) => {
                let available = self
                    .state
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .available;
                self.emit_error(available, &err);
                return;
            }
        };

        let mgr = self.server_manager.clone();
        self.apply_trusted_device_mutation(|ws_id| async move {
            mgr.update_mobile_h3_trusted_device_permissions(&ws_id, phone_id, Value::Object(patch))
                .await
        })
        .await;
    }

    pub async fn forget_trusted_phone(&self, phone_id: &str) {
        let _lock = self.mutation_lock.lock().await;
        let mgr = self.server_manager.clone();
        self.apply_trusted_device_mutation(|ws_id| async move {
            mgr.forget_mobile_h3_trusted_device(&ws_id, phone_id).await
        })
        .await;
    }

    pub async fn revoke_all_trusted_phones(&self) {
        let _lock = self.mutation_lock.lock().await;
        let mgr = self.server_manager.clone();
        self.apply_trusted_device_mutation(|ws_id| async move {
            mgr.revoke_all_mobile_h3_trusted_devices(&ws_id).await
        })
        .await;
    }

    fn publish_state(&self, state: RemoteAccessState) {
        {
            let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
            guard.last_state = state.clone();
        }
        (self.emit)(StoreEvent::RemoteAccessChanged(state));
    }

    fn emit_error(&self, available: bool, message: &str) {
        let mut next = self
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .last_state
            .clone();
        next.available = available;
        next.error = Some(message.to_string());
        self.publish_state(next);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_and_formats_trusted_phone_permissions() {
        let csv_patch = parse_permissions_patch("turns, workspaceSettings").unwrap();
        assert_eq!(csv_patch["turns"], json!(true));
        assert_eq!(csv_patch["workspaceSettings"], json!(true));
        assert_eq!(csv_patch["backups"], json!(false));

        let json_patch = parse_permissions_patch(r#"{"turns":true,"backups":false}"#).unwrap();
        assert_eq!(json_patch["turns"], json!(true));
        assert_eq!(json_patch["backups"], json!(false));

        assert_eq!(
            format_mobile_permissions(&json!({ "turns": true, "backups": true, "mcpAuth": false })),
            "turns, backups"
        );
        assert_eq!(format_mobile_permissions(&json!({})), "none");
        assert!(parse_permissions_patch("invalid_perm").is_err());
    }

    #[test]
    fn maps_mobile_h3_payload_into_remote_access_state() {
        let h3 = json!({
            "url": "https://192.168.1.5:8443",
            "ticket": "cowork://pair?v=1&t=abc",
            "trustedDevices": [
                {
                    "deviceId": "dev-1",
                    "displayName": "iPhone 16",
                    "lastPairedAt": "2026-01-02T00:00:00.000Z",
                    "permissions": {
                        "turns": true,
                        "serverRequests": true,
                        "providerAuth": false,
                        "mcpAuth": false,
                        "workspaceSettings": false,
                        "backups": false,
                        "conversations": true
                    }
                }
            ]
        });

        let state = remote_access_state_from_mobile_h3(true, Some(&h3), None);
        assert!(state.available);
        assert!(state.running);
        assert_eq!(
            state.pairing_url.as_deref(),
            Some("cowork://pair?v=1&t=abc")
        );
        assert_eq!(state.relay_url.as_deref(), Some("https://192.168.1.5:8443"));
        assert_eq!(state.trusted_phones.len(), 1);
        assert_eq!(state.trusted_phones[0].id, "dev-1");
        assert_eq!(state.trusted_phones[0].name, "iPhone 16");
        assert!(state.trusted_phones[0].paired_at > 0);
        assert_eq!(
            state.trusted_phones[0].permissions,
            "turns, serverRequests, conversations"
        );
    }
}
