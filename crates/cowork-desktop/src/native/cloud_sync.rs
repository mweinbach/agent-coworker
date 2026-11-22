//! Privacy-first cloud preferences sync uploader for the native desktop runtime.
//!
//! Mirrors Electron's `src/sync/service.ts`, `src/sync/redaction.ts`, and
//! `src/sync/providers/customHttp.ts`: builds strict allowlist settings snapshots (never
//! transmitting workspace paths, secrets, tokens, or chat transcripts), deduplicates identical
//! preference payloads, POSTs patches asynchronously to `<endpoint>/v1/patch` with optional
//! Bearer auth, honors `COWORK_DISABLE_NETWORK_TELEMETRY`, and exposes real connectivity/error
//! status for `telemetry_status`.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::Utc;
use serde_json::{Map, Value, json};
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

use crate::actions::SidebarSectionKey;
use crate::state::{PersistedDesktopState, PrivacyTelemetrySettings};

use super::local_logs::strip_url_secrets;
use super::telemetry_status::{
    normalize_env_value, normalize_http_url, parse_env_bool, resolve_telemetry_consent,
};

pub const CLOUD_SYNC_PAYLOAD_VERSION: u64 = 1;
pub const CLOUD_SYNC_SETTINGS_DEDUPE_KEY: &str = "settings:v1";
const CLOUD_SYNC_QUEUE_CAPACITY: usize = 32;
const CLOUD_SYNC_HTTP_TIMEOUT: Duration = Duration::from_secs(15);
const DEFAULT_QUICK_CHAT_SHORTCUT_ACCELERATOR: &str = "CommandOrControl+Shift+Space";

const SAFE_ALLOWLIST_KEYS: &[&str] = &[
    "version",
    "kind",
    "privacyTelemetrySettings",
    "crashReportsEnabled",
    "productAnalyticsEnabled",
    "aiTraceTelemetryEnabled",
    "aiTracePayloadsEnabled",
    "diagnosticsUploadEnabled",
    "cloudSyncEnabled",
    "desktopSettings",
    "quickChat",
    "iconEnabled",
    "shortcutEnabled",
    "shortcutAccelerator",
    "archivedChatsAutoDeleteDays",
    "sidebarSectionOrder",
    "desktopFeatureFlagOverrides",
    "appPreferences",
    "developerMode",
    "showHiddenFiles",
    "perWorkspaceSettings",
    "providerUiState",
    "lmstudio",
    "enabled",
];

const FORBIDDEN_KEY_TOKENS: &[&str] = &[
    "prompt",
    "messages",
    "transcript",
    "stdout",
    "stderr",
    "content",
    "token",
    "secret",
    "password",
    "passwd",
    "apikey",
    "api_key",
    "api-key",
    "authorization",
    "cookie",
    "credential",
    "privatekey",
    "private_key",
    "private-key",
];

/// Resolved cloud preferences sync configuration (secret token kept internal to transport).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudSyncConfig {
    pub enabled: bool,
    pub provider_custom: bool,
    pub endpoint: Option<String>,
    pub token: Option<String>,
    pub sync_settings: bool,
    pub network_telemetry_disabled: bool,
}

impl CloudSyncConfig {
    /// Returns true when consent is granted, kill switch is inactive, settings sync is enabled,
    /// and a valid custom HTTP(S) endpoint is configured.
    pub fn is_active(&self) -> bool {
        !self.network_telemetry_disabled
            && self.enabled
            && self.sync_settings
            && self.provider_custom
            && self.endpoint.is_some()
    }

    fn target_key(&self) -> Option<String> {
        let ep = self.endpoint.as_deref()?;
        let tok = self.token.as_deref().unwrap_or("");
        Some(format!("{ep}\0{tok}"))
    }
}

/// Live runtime status of the cloud preferences sync uploader.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudSyncRuntimeStatus {
    pub status: &'static str,
    pub configured: bool,
    pub enabled: bool,
    pub queued: usize,
    pub message: Option<String>,
}

impl CloudSyncRuntimeStatus {
    pub fn disabled() -> Self {
        Self {
            status: "disabled",
            configured: false,
            enabled: false,
            queued: 0,
            message: None,
        }
    }

    pub fn not_configured(enabled: bool) -> Self {
        Self {
            status: "not_configured",
            configured: false,
            enabled,
            queued: 0,
            message: None,
        }
    }
}

/// Resolves effective cloud preferences sync configuration from persisted desktop settings,
/// raw `state.json` `cloudSync` config, and process environment variables.
pub fn resolve_cloud_sync_config(
    privacy: &PrivacyTelemetrySettings,
    raw_state_doc: Option<&Value>,
    env: &HashMap<String, String>,
    is_packaged: bool,
) -> CloudSyncConfig {
    let consent = resolve_telemetry_consent(privacy, env, is_packaged);
    let kill_switch = consent.network_telemetry_disabled;
    let cloud_obj = raw_state_doc
        .and_then(|d| d.get("cloudSync"))
        .and_then(Value::as_object);

    let endpoint = normalize_http_url(env.get("COWORK_CLOUD_SYNC_ENDPOINT")).or_else(|| {
        cloud_obj
            .and_then(|o| o.get("endpoint"))
            .and_then(Value::as_str)
            .and_then(|s| normalize_http_url(Some(&s.to_string())))
    });
    let token = normalize_env_value(env.get("COWORK_CLOUD_SYNC_TOKEN"));
    let sync_settings = cloud_obj
        .and_then(|o| o.get("syncSettings"))
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let env_enabled = parse_env_bool(env.get("COWORK_CLOUD_SYNC_ENABLED"));
    let persisted_enabled = cloud_obj
        .and_then(|o| o.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let enabled = !kill_switch
        && env_enabled != Some(false)
        && (persisted_enabled || consent.cloud_sync_enabled);
    let provider_custom = endpoint.is_some()
        || cloud_obj
            .and_then(|o| o.get("provider"))
            .and_then(Value::as_str)
            == Some("custom");

    CloudSyncConfig {
        enabled,
        provider_custom,
        endpoint,
        token,
        sync_settings,
        network_telemetry_disabled: kill_switch,
    }
}

fn normalize_sidebar_order(order: &[SidebarSectionKey]) -> Vec<&'static str> {
    let mut out: Vec<&'static str> = Vec::new();
    for key in order {
        let mapped = match key {
            SidebarSectionKey::Workspaces => Some("projects"),
            SidebarSectionKey::Chats => Some("chats"),
            SidebarSectionKey::Pinned | SidebarSectionKey::Tasks => None,
        };
        if let Some(entry) = mapped
            && !out.contains(&entry)
        {
            out.push(entry);
        }
    }
    for required in ["projects", "chats"] {
        if !out.contains(&required) {
            out.push(required);
        }
    }
    out
}

fn looks_like_host_path(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.starts_with("~/")
        || trimmed.starts_with("/Users/")
        || trimmed.starts_with("/home/")
        || trimmed.starts_with("/var/")
        || trimmed.starts_with("/tmp/")
        || trimmed.starts_with("\\\\")
    {
        return true;
    }
    let bytes = trimmed.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
}

fn looks_like_secret_value(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.contains("bearer ")
        || lower.starts_with("sk-")
        || lower.starts_with("ghp_")
        || lower.starts_with("gho_")
        || lower.starts_with("akia")
        || lower.contains("-----begin ")
}

/// Defense-in-depth check ensuring a cloud-sync payload never carries paths, secrets, or transcripts.
pub fn contains_forbidden_cloud_sync_data(value: &Value) -> bool {
    fn visit(val: &Value, key: Option<&str>) -> bool {
        if let Some(k) = key
            && !SAFE_ALLOWLIST_KEYS.contains(&k)
        {
            let lower = k.to_ascii_lowercase();
            if FORBIDDEN_KEY_TOKENS.iter().any(|tok| lower.contains(tok)) {
                return true;
            }
        }
        match val {
            Value::Null | Value::Bool(_) | Value::Number(_) => false,
            Value::String(s) => looks_like_host_path(s) || looks_like_secret_value(s),
            Value::Array(items) => items.iter().any(|item| visit(item, None)),
            Value::Object(map) => map.iter().any(|(k, v)| visit(v, Some(k))),
        }
    }
    visit(value, None)
}

/// Builds a strictly allowlisted `CloudSyncSettingsSnapshot` matching `src/sync/redaction.ts`.
pub fn build_cloud_sync_settings_snapshot(
    state: &PersistedDesktopState,
    raw_state_doc: Option<&Value>,
) -> Value {
    let privacy = &state.settings.privacy_telemetry;
    let shortcut = state.settings.quick_chat_shortcut.trim();
    let shortcut_accelerator = if shortcut.is_empty()
        || looks_like_host_path(shortcut)
        || looks_like_secret_value(shortcut)
    {
        DEFAULT_QUICK_CHAT_SHORTCUT_ACCELERATOR.to_string()
    } else {
        shortcut.to_string()
    };

    let mut feature_flags = BTreeMap::new();
    for (k, &v) in &state.feature_flags {
        if !k.is_empty() && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            feature_flags.insert(k.clone(), Value::Bool(v));
        }
    }
    let feature_flags_obj: Map<String, Value> = feature_flags.into_iter().collect();

    let lmstudio_enabled = raw_state_doc
        .and_then(|d| d.pointer("/providerUiState/lmstudio/enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(false);

    json!({
        "version": CLOUD_SYNC_PAYLOAD_VERSION,
        "kind": "settings",
        "privacyTelemetrySettings": {
            "crashReportsEnabled": privacy.crash_reports_enabled,
            "productAnalyticsEnabled": privacy.product_analytics_enabled,
            "aiTraceTelemetryEnabled": privacy.ai_trace_telemetry_enabled,
            "aiTracePayloadsEnabled": privacy.ai_trace_telemetry_enabled && privacy.ai_trace_payloads_enabled,
            "diagnosticsUploadEnabled": privacy.diagnostics_upload_enabled,
            "cloudSyncEnabled": false,
        },
        "desktopSettings": {
            "quickChat": {
                "iconEnabled": state.settings.quick_chat_icon_enabled,
                "shortcutEnabled": state.settings.quick_chat_shortcut_enabled,
                "shortcutAccelerator": shortcut_accelerator,
            },
            "archivedChatsAutoDeleteDays": state.settings.archived_chats_auto_delete_days,
            "sidebarSectionOrder": normalize_sidebar_order(&state.settings.sidebar_section_order),
        },
        "desktopFeatureFlagOverrides": Value::Object(feature_flags_obj),
        "appPreferences": {
            "developerMode": state.settings.developer_mode,
            "showHiddenFiles": state.settings.show_hidden_files,
            "perWorkspaceSettings": state.settings.per_workspace_settings,
        },
        "providerUiState": {
            "lmstudio": {
                "enabled": lmstudio_enabled,
            },
        },
    })
}

enum CloudSyncJob {
    Push {
        generation: u64,
        endpoint: String,
        token: Option<String>,
        target_key: String,
        digest: String,
        patch: Value,
    },
    Flush(oneshot::Sender<()>),
}

type StatusChangeCallback = Arc<dyn Fn(&CloudSyncRuntimeStatus) + Send + Sync>;

struct CloudSyncInner {
    is_packaged: bool,
    generation: u64,
    config: CloudSyncConfig,
    status: CloudSyncRuntimeStatus,
    last_target_key: Option<String>,
    last_synced_digest: Option<String>,
    pending_jobs: usize,
    sender: Option<mpsc::Sender<CloudSyncJob>>,
    on_status_change: Option<StatusChangeCallback>,
}

/// Manages asynchronous, privacy-redacted cloud preferences patch uploads and live status tracking.
#[derive(Clone)]
pub struct CloudSyncService {
    inner: Arc<Mutex<CloudSyncInner>>,
    http_timeout: Duration,
}

impl CloudSyncService {
    /// Creates a new cloud sync service. Network requests are only issued once
    /// [`Self::sync_persisted_state`] is called with an active configuration.
    pub fn new(
        is_packaged: bool,
        privacy: &PrivacyTelemetrySettings,
        raw_state_doc: Option<&Value>,
        env: &HashMap<String, String>,
        on_status_change: Option<StatusChangeCallback>,
    ) -> Self {
        Self::with_timeout(
            is_packaged,
            privacy,
            raw_state_doc,
            env,
            on_status_change,
            CLOUD_SYNC_HTTP_TIMEOUT,
        )
    }

    fn with_timeout(
        is_packaged: bool,
        privacy: &PrivacyTelemetrySettings,
        raw_state_doc: Option<&Value>,
        env: &HashMap<String, String>,
        on_status_change: Option<StatusChangeCallback>,
        http_timeout: Duration,
    ) -> Self {
        let config = resolve_cloud_sync_config(privacy, raw_state_doc, env, is_packaged);
        let status = initial_status_for_config(&config);
        Self {
            inner: Arc::new(Mutex::new(CloudSyncInner {
                is_packaged,
                generation: 0,
                config,
                status,
                last_target_key: None,
                last_synced_digest: None,
                pending_jobs: 0,
                sender: None,
                on_status_change,
            })),
            http_timeout,
        }
    }

    /// Re-evaluates configuration and enqueues a sanitized settings patch upload when active.
    pub fn sync_persisted_state(
        &self,
        state: &PersistedDesktopState,
        raw_state_doc: Option<&Value>,
        env: &HashMap<String, String>,
    ) -> CloudSyncRuntimeStatus {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let next_cfg = resolve_cloud_sync_config(
            &state.settings.privacy_telemetry,
            raw_state_doc,
            env,
            guard.is_packaged,
        );
        let target_key = next_cfg.target_key();
        if target_key != guard.last_target_key {
            guard.generation = guard.generation.wrapping_add(1);
            guard.last_target_key = target_key.clone();
            guard.last_synced_digest = None;
            guard.pending_jobs = 0;
            guard.sender = None;
        }
        guard.config = next_cfg.clone();

        if next_cfg.network_telemetry_disabled || !next_cfg.enabled || !next_cfg.sync_settings {
            guard.generation = guard.generation.wrapping_add(1);
            guard.sender = None;
            guard.pending_jobs = 0;
            guard.last_synced_digest = None;
            guard.status = CloudSyncRuntimeStatus::disabled();
            return guard.status.clone();
        }

        if !next_cfg.provider_custom || next_cfg.endpoint.is_none() {
            guard.generation = guard.generation.wrapping_add(1);
            guard.sender = None;
            guard.pending_jobs = 0;
            guard.last_synced_digest = None;
            guard.status = CloudSyncRuntimeStatus::not_configured(next_cfg.enabled);
            return guard.status.clone();
        }

        let payload = build_cloud_sync_settings_snapshot(state, raw_state_doc);
        if contains_forbidden_cloud_sync_data(&payload) {
            guard.status = CloudSyncRuntimeStatus {
                status: "error",
                configured: true,
                enabled: true,
                queued: guard.pending_jobs,
                message: Some("Cloud sync blocked an unsafe settings payload.".to_string()),
            };
            return guard.status.clone();
        }

        let digest = serde_json::to_string(&payload).unwrap_or_default();
        if guard.last_synced_digest.as_deref() == Some(digest.as_str())
            && guard.status.status == "connected"
            && guard.pending_jobs == 0
        {
            return guard.status.clone();
        }

        if guard.sender.is_none() {
            guard.sender = Some(spawn_cloud_sync_worker(
                Arc::clone(&self.inner),
                self.http_timeout,
            ));
        }
        let generation = guard.generation;
        let sender = guard.sender.clone();
        let endpoint = next_cfg.endpoint.clone().unwrap_or_default();
        let target_key = target_key.unwrap_or_default();
        let patch = json!({
            "version": CLOUD_SYNC_PAYLOAD_VERSION,
            "id": Uuid::new_v4().to_string(),
            "scope": "settings",
            "dedupeKey": CLOUD_SYNC_SETTINGS_DEDUPE_KEY,
            "createdAt": Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            "payload": payload,
        });

        if let Some(tx) = sender {
            match tx.try_send(CloudSyncJob::Push {
                generation,
                endpoint,
                token: next_cfg.token,
                target_key,
                digest,
                patch,
            }) {
                Ok(()) => {
                    guard.pending_jobs += 1;
                    if guard.status.status != "connected" {
                        guard.status = CloudSyncRuntimeStatus {
                            status: "queued",
                            configured: true,
                            enabled: true,
                            queued: guard.pending_jobs,
                            message: None,
                        };
                    } else {
                        guard.status.queued = guard.pending_jobs;
                    }
                }
                Err(_) => {
                    guard.status = CloudSyncRuntimeStatus {
                        status: "error",
                        configured: true,
                        enabled: true,
                        queued: guard.pending_jobs,
                        message: Some("Cloud sync queue is full.".to_string()),
                    };
                }
            }
        }
        guard.status.clone()
    }

    /// Returns the effective runtime status for the given settings/env snapshot.
    pub fn status_for_env(
        &self,
        privacy: &PrivacyTelemetrySettings,
        raw_state_doc: Option<&Value>,
        env: &HashMap<String, String>,
    ) -> CloudSyncRuntimeStatus {
        let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let cfg = resolve_cloud_sync_config(privacy, raw_state_doc, env, guard.is_packaged);
        if cfg.network_telemetry_disabled || !cfg.enabled || !cfg.sync_settings {
            return CloudSyncRuntimeStatus::disabled();
        }
        if !cfg.provider_custom || cfg.endpoint.is_none() {
            return CloudSyncRuntimeStatus::not_configured(cfg.enabled);
        }
        if cfg.target_key() == guard.last_target_key {
            return guard.status.clone();
        }
        CloudSyncRuntimeStatus {
            status: "queued",
            configured: true,
            enabled: true,
            queued: guard.pending_jobs,
            message: None,
        }
    }

    /// Waits briefly for pending cloud-sync patch uploads to finish.
    pub async fn flush(&self) {
        let tx = {
            let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            guard.sender.clone()
        };
        let Some(sender) = tx else {
            return;
        };
        let (done_tx, done_rx) = oneshot::channel();
        if sender.send(CloudSyncJob::Flush(done_tx)).await.is_ok() {
            let _ = tokio::time::timeout(self.http_timeout, done_rx).await;
        }
    }

    /// Stops accepting new upload jobs without blocking.
    pub fn shutdown(&self) {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard.generation = guard.generation.wrapping_add(1);
        guard.sender = None;
        guard.pending_jobs = 0;
    }
}

fn initial_status_for_config(cfg: &CloudSyncConfig) -> CloudSyncRuntimeStatus {
    if cfg.network_telemetry_disabled || !cfg.enabled || !cfg.sync_settings {
        CloudSyncRuntimeStatus::disabled()
    } else if !cfg.provider_custom || cfg.endpoint.is_none() {
        CloudSyncRuntimeStatus::not_configured(cfg.enabled)
    } else {
        CloudSyncRuntimeStatus {
            status: "queued",
            configured: true,
            enabled: true,
            queued: 0,
            message: None,
        }
    }
}

fn sanitize_sync_error(raw: &str) -> String {
    let scrubbed = strip_url_secrets(raw);
    let trimmed = scrubbed.trim();
    if trimmed.len() > 240 {
        format!("{}…", trimmed.chars().take(239).collect::<String>())
    } else {
        trimmed.to_string()
    }
}

fn spawn_cloud_sync_worker(
    inner: Arc<Mutex<CloudSyncInner>>,
    timeout: Duration,
) -> mpsc::Sender<CloudSyncJob> {
    let (tx, mut rx) = mpsc::channel::<CloudSyncJob>(CLOUD_SYNC_QUEUE_CAPACITY);
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    let worker = async move {
        while let Some(job) = rx.recv().await {
            match job {
                CloudSyncJob::Push {
                    generation,
                    endpoint,
                    token,
                    target_key,
                    digest,
                    patch,
                } => {
                    // Revalidate consent and active target before every POST so turning off
                    // cloud sync or changing endpoints discards buffered jobs without sending.
                    let still_authorized = {
                        let guard = inner.lock().unwrap_or_else(|e| e.into_inner());
                        guard.generation == generation
                            && guard.config.is_active()
                            && guard.last_target_key.as_deref() == Some(target_key.as_str())
                    };
                    if !still_authorized {
                        continue;
                    }

                    let url = format!("{}/v1/patch", endpoint.trim_end_matches('/'));
                    let mut req = client
                        .post(&url)
                        .header("content-type", "application/json")
                        .json(&patch);
                    if let Some(tok) = token.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                        req = req.header("authorization", format!("Bearer {tok}"));
                    }
                    let outcome = match req.send().await {
                        Ok(resp) if resp.status().is_success() => Ok(()),
                        Ok(resp) => Err(format!("HTTP {}", resp.status().as_u16())),
                        Err(err) => Err(sanitize_sync_error(&err.to_string())),
                    };

                    let maybe_notify = {
                        let mut guard = inner.lock().unwrap_or_else(|e| e.into_inner());
                        if guard.generation == generation
                            && guard.last_target_key.as_deref() == Some(target_key.as_str())
                            && guard.config.is_active()
                        {
                            guard.pending_jobs = guard.pending_jobs.saturating_sub(1);
                            let next = match outcome {
                                Ok(()) => {
                                    guard.last_synced_digest = Some(digest);
                                    CloudSyncRuntimeStatus {
                                        status: "connected",
                                        configured: true,
                                        enabled: true,
                                        queued: guard.pending_jobs,
                                        message: None,
                                    }
                                }
                                Err(msg) => CloudSyncRuntimeStatus {
                                    status: "error",
                                    configured: true,
                                    enabled: true,
                                    queued: guard.pending_jobs,
                                    message: Some(msg),
                                },
                            };
                            let changed = guard.status != next;
                            guard.status = next.clone();
                            changed
                                .then(|| guard.on_status_change.clone().map(|cb| (cb, next)))
                                .flatten()
                        } else {
                            None
                        }
                    };

                    if let Some((cb, next_status)) = maybe_notify {
                        cb(&next_status);
                    }
                }
                CloudSyncJob::Flush(done) => {
                    let _ = done.send(());
                }
            }
        }
    };

    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        handle.spawn(worker);
    } else {
        let _ = std::thread::Builder::new()
            .name("cowork-desktop-cloud-sync".to_string())
            .spawn(move || {
                if let Ok(rt) = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    rt.block_on(worker);
                }
            });
    }
    tx
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    async fn read_http_request(
        stream: &mut tokio::net::TcpStream,
    ) -> Option<(String, Option<String>, Value)> {
        let mut buf = Vec::new();
        let mut tmp = [0u8; 4096];
        let header_end = loop {
            let n = stream.read(&mut tmp).await.ok()?;
            if n == 0 {
                return None;
            }
            buf.extend_from_slice(&tmp[..n]);
            if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                break pos + 4;
            }
        };
        let head = String::from_utf8_lossy(&buf[..header_end]).to_string();
        let request_line = head.lines().next()?.to_string();
        let mut content_length = 0usize;
        let mut auth = None;
        for line in head.lines().skip(1) {
            if let Some((k, v)) = line.split_once(':') {
                if k.eq_ignore_ascii_case("content-length") {
                    content_length = v.trim().parse().unwrap_or(0);
                } else if k.eq_ignore_ascii_case("authorization") {
                    auth = Some(v.trim().to_string());
                }
            }
        }
        while buf.len() < header_end + content_length {
            let n = stream.read(&mut tmp).await.ok()?;
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&tmp[..n]);
        }
        let body_bytes = &buf[header_end..header_end + content_length.min(buf.len() - header_end)];
        let json_body = serde_json::from_slice::<Value>(body_bytes).ok()?;
        Some((request_line, auth, json_body))
    }

    #[tokio::test]
    async fn uploads_sanitized_settings_patch_reports_connected_and_surfaces_http_errors() {
        let status_code = Arc::new(Mutex::new(200u16));
        let received = Arc::new(Mutex::new(Vec::<(String, Option<String>, Value)>::new()));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        let status_srv = Arc::clone(&status_code);
        let received_srv = Arc::clone(&received);
        let server = tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                let status_srv = Arc::clone(&status_srv);
                let received_srv = Arc::clone(&received_srv);
                tokio::spawn(async move {
                    if let Some((req_line, auth, body)) = read_http_request(&mut stream).await {
                        received_srv.lock().unwrap().push((req_line, auth, body));
                        let code = *status_srv.lock().unwrap();
                        let (reason, payload) = if (200..300).contains(&code) {
                            ("OK", r#"{"cursor":"cur-1"}"#)
                        } else {
                            ("Service Unavailable", r#"{"error":"upstream unavailable"}"#)
                        };
                        let resp = format!(
                            "HTTP/1.1 {code} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
                            payload.len()
                        );
                        let _ = stream.write_all(resp.as_bytes()).await;
                    }
                });
            }
        });

        let mut env = HashMap::new();
        env.insert(
            "COWORK_CLOUD_SYNC_ENDPOINT".into(),
            format!("http://127.0.0.1:{port}"),
        );
        env.insert("COWORK_CLOUD_SYNC_TOKEN".into(), "sync-secret-tok".into());

        let mut persisted = PersistedDesktopState::default();
        persisted.settings.privacy_telemetry.cloud_sync_enabled = true;
        persisted.settings.developer_mode = true;
        persisted.settings.show_hidden_files = true;
        persisted
            .workspaces
            .push(crate::state::WorkspaceRecord::new(
                "ws-1",
                "SecretRepo",
                "/Users/alice/private-repo",
                1,
            ));

        let observed = Arc::new(Mutex::new(Vec::<String>::new()));
        let observed_cb = Arc::clone(&observed);
        let svc = CloudSyncService::with_timeout(
            false,
            &persisted.settings.privacy_telemetry,
            None,
            &env,
            Some(Arc::new(move |st| {
                observed_cb.lock().unwrap().push(st.status.to_string());
            })),
            Duration::from_secs(3),
        );

        // Before upload completes, service is NOT falsely reported as Connected.
        let initial = svc.status_for_env(&persisted.settings.privacy_telemetry, None, &env);
        assert_eq!(initial.status, "queued");

        let _ = svc.sync_persisted_state(&persisted, None, &env);
        svc.flush().await;

        let after_ok = svc.status_for_env(&persisted.settings.privacy_telemetry, None, &env);
        assert_eq!(after_ok.status, "connected");
        assert!(after_ok.message.is_none());

        // Identical save deduplicates without issuing another HTTP request.
        let _ = svc.sync_persisted_state(&persisted, None, &env);
        svc.flush().await;
        {
            let reqs = received.lock().unwrap();
            assert_eq!(reqs.len(), 1);
            assert!(reqs[0].0.starts_with("POST /v1/patch "));
            assert_eq!(reqs[0].1.as_deref(), Some("Bearer sync-secret-tok"));
            let patch = &reqs[0].2;
            assert_eq!(patch["scope"], "settings");
            assert_eq!(patch["payload"]["appPreferences"]["developerMode"], true);
            assert_eq!(patch["payload"]["appPreferences"]["showHiddenFiles"], true);
            assert!(
                !patch.to_string().contains("/Users/alice/private-repo"),
                "workspace paths must never leak in cloud sync payload"
            );
            assert!(
                !patch.to_string().contains("sync-secret-tok"),
                "auth token must never appear in cloud sync payload"
            );
        }

        // Subsequent preference change hitting HTTP 503 transitions live status to Error.
        *status_code.lock().unwrap() = 503;
        persisted.settings.developer_mode = false;
        let _ = svc.sync_persisted_state(&persisted, None, &env);
        svc.flush().await;

        let after_err = svc.status_for_env(&persisted.settings.privacy_telemetry, None, &env);
        assert_eq!(after_err.status, "error");
        assert_eq!(after_err.message.as_deref(), Some("HTTP 503"));
        assert!(observed.lock().unwrap().iter().any(|s| s == "connected"));
        assert!(observed.lock().unwrap().iter().any(|s| s == "error"));

        // Kill switch disables sync immediately with zero network traffic.
        env.insert("COWORK_DISABLE_NETWORK_TELEMETRY".into(), "1".into());
        let before_kill_count = received.lock().unwrap().len();
        persisted.settings.developer_mode = true;
        let killed = svc.sync_persisted_state(&persisted, None, &env);
        svc.flush().await;
        assert_eq!(killed.status, "disabled");
        assert_eq!(received.lock().unwrap().len(), before_kill_count);

        svc.shutdown();
        server.abort();
    }

    #[tokio::test]
    async fn disabling_cloud_sync_discards_buffered_uploads_without_sending() {
        let received = Arc::new(Mutex::new(Vec::<Value>::new()));
        let first_started = Arc::new(tokio::sync::Notify::new());
        let release_first = Arc::new(tokio::sync::Notify::new());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        let received_srv = Arc::clone(&received);
        let first_started_srv = Arc::clone(&first_started);
        let release_first_srv = Arc::clone(&release_first);
        let server = tokio::spawn(async move {
            let mut req_idx = 0usize;
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                req_idx += 1;
                let idx = req_idx;
                let received_srv = Arc::clone(&received_srv);
                let first_started_srv = Arc::clone(&first_started_srv);
                let release_first_srv = Arc::clone(&release_first_srv);
                tokio::spawn(async move {
                    if let Some((_req_line, _auth, body)) = read_http_request(&mut stream).await {
                        received_srv.lock().unwrap().push(body);
                        if idx == 1 {
                            first_started_srv.notify_one();
                            release_first_srv.notified().await;
                        }
                        let payload = r#"{"cursor":"cur-1"}"#;
                        let resp = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
                            payload.len()
                        );
                        let _ = stream.write_all(resp.as_bytes()).await;
                    }
                });
            }
        });

        let mut env = HashMap::new();
        env.insert(
            "COWORK_CLOUD_SYNC_ENDPOINT".into(),
            format!("http://127.0.0.1:{port}"),
        );

        let mut persisted = PersistedDesktopState::default();
        persisted.settings.privacy_telemetry.cloud_sync_enabled = true;
        persisted.settings.developer_mode = true;

        let svc = CloudSyncService::with_timeout(
            false,
            &persisted.settings.privacy_telemetry,
            None,
            &env,
            None,
            Duration::from_secs(3),
        );

        // Start upload #1 and wait until the server has accepted it (blocking its response).
        let _ = svc.sync_persisted_state(&persisted, None, &env);
        tokio::time::timeout(Duration::from_secs(2), first_started.notified())
            .await
            .expect("first upload should reach server");

        // Enqueue upload #2 while upload #1 is still in flight.
        persisted.settings.show_hidden_files = true;
        let _ = svc.sync_persisted_state(&persisted, None, &env);

        // Disable cloud sync before upload #1 finishes; upload #2 is buffered in the channel.
        persisted.settings.privacy_telemetry.cloud_sync_enabled = false;
        let disabled = svc.sync_persisted_state(&persisted, None, &env);
        assert_eq!(disabled.status, "disabled");

        // Release upload #1 and allow the worker loop to drain the closed channel.
        release_first.notify_one();
        tokio::time::sleep(Duration::from_millis(120)).await;

        assert_eq!(
            received.lock().unwrap().len(),
            1,
            "buffered upload #2 must be discarded once cloud sync consent is revoked"
        );
        let final_status = svc.status_for_env(&persisted.settings.privacy_telemetry, None, &env);
        assert_eq!(final_status.status, "disabled");

        svc.shutdown();
        server.abort();
    }

    #[test]
    fn explicit_env_opt_out_disables_cloud_sync_and_packaged_blocks_env_opt_in() {
        let mut privacy = PrivacyTelemetrySettings {
            cloud_sync_enabled: true,
            ..PrivacyTelemetrySettings::default()
        };
        let raw_doc = json!({
            "cloudSync": {
                "enabled": true,
                "provider": "custom",
                "endpoint": "https://sync.example.com"
            }
        });
        let mut env = HashMap::new();
        env.insert("COWORK_CLOUD_SYNC_ENABLED".into(), "false".into());
        env.insert(
            "COWORK_CLOUD_SYNC_ENDPOINT".into(),
            "https://sync.example.com".into(),
        );

        let opted_out = resolve_cloud_sync_config(&privacy, Some(&raw_doc), &env, false);
        assert!(!opted_out.enabled);
        assert!(!opted_out.is_active());

        // In packaged builds, env opt-in must not override missing user consent.
        privacy.cloud_sync_enabled = false;
        env.insert("COWORK_CLOUD_SYNC_ENABLED".into(), "true".into());
        let dev_opt_in = resolve_cloud_sync_config(&privacy, None, &env, false);
        assert!(dev_opt_in.enabled);
        assert!(dev_opt_in.is_active());
        let packaged_opt_in = resolve_cloud_sync_config(&privacy, None, &env, true);
        assert!(!packaged_opt_in.enabled);
        assert!(!packaged_opt_in.is_active());
    }
}
