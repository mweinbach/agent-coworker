//! Privacy-first PostHog product analytics client for native desktop.
//!
//! Mirrors `src/telemetry/productAnalytics.ts`, `apps/desktop/electron/services/productAnalytics.ts`,
//! and `crates/cowork-server/src/observability.rs`: enforces strict event and property allowlists,
//! drops events containing sensitive keys, credentials, emails, URLs, or file paths, persists a
//! sanitized `anonymousInstallationId` (`anon_<uuid>`) and `lastAppVersion` in `state.json`, and
//! sends anonymized batches to PostHog `{host}/batch/` only when user consent is active and
//! `COWORK_DISABLE_NETWORK_TELEMETRY` is not set.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

use crate::state::PrivacyTelemetrySettings;

use super::persistence::PersistenceService;
use super::telemetry_status::{
    build_time_env, build_time_http_url, coalesce_env, coalesce_env_or_build,
    is_network_telemetry_globally_disabled, normalize_env_value, normalize_http_url,
    resolve_telemetry_consent,
};

const DEFAULT_POSTHOG_HOST: &str = "https://us.i.posthog.com";
const MAX_STRING_LEN: usize = 128;
const MAX_STATUS_LEN: usize = 64;
const MAX_DURATION_MS: f64 = 7.0 * 24.0 * 60.0 * 60.0 * 1000.0;
const MAX_COUNT: f64 = 1_000_000.0;
const ANALYTICS_QUEUE_CAPACITY: usize = 64;
const ANALYTICS_BATCH_SIZE: usize = 20;
const ANALYTICS_HTTP_TIMEOUT: Duration = Duration::from_secs(3);

/// Allowlisted product analytics event names (`src/telemetry/productAnalytics.ts`).
pub const PRODUCT_ANALYTICS_EVENT_NAMES: &[&str] = &[
    "app_started",
    "app_updated",
    "workspace_added",
    "workspace_removed",
    "workspace_server_started",
    "workspace_server_failed",
    "provider_connected",
    "provider_auth_failed",
    "turn_started",
    "turn_completed",
    "turn_failed",
    "tool_approval_requested",
    "mcp_server_added",
    "mcp_server_validation_failed",
    "plugin_installed",
    "skill_installed",
    "quick_chat_opened",
    "mobile_pairing_started",
    "mobile_pairing_completed",
    "update_checked",
    "update_downloaded",
    "update_install_started",
];

const PRODUCT_ANALYTICS_BOOL_PROPS: &[&str] = &[
    "packaged",
    "productAnalyticsEnabled",
    "crashReportsEnabled",
    "aiTraceTelemetryEnabled",
    "aiTracePayloadsEnabled",
    "diagnosticsUploadEnabled",
    "cloudSyncEnabled",
    "mcpEnabled",
    "yoloEnabled",
    "quickChatIconEnabled",
    "quickChatShortcutEnabled",
    "mobilePairingEnabled",
    "hasAttachments",
    "hasReferences",
    "remoteAccessEnabled",
    "openAiNativeConnectorsEnabled",
    "updateAvailable",
];

const PRODUCT_ANALYTICS_STRING_PROPS: &[&str] = &[
    "appVersion",
    "platform",
    "arch",
    "eventSource",
    "provider",
    "model",
    "status",
    "errorCategory",
];

const PRODUCT_ANALYTICS_PROPERTY_NAMES: &[&str] = &[
    "appVersion",
    "platform",
    "arch",
    "packaged",
    "eventSource",
    "provider",
    "model",
    "durationMs",
    "status",
    "errorCategory",
    "workspaceCount",
    "threadCount",
    "providerCount",
    "mcpServerCount",
    "pluginCount",
    "skillCount",
    "toolCount",
    "attachmentCount",
    "referenceCount",
    "productAnalyticsEnabled",
    "crashReportsEnabled",
    "aiTraceTelemetryEnabled",
    "aiTracePayloadsEnabled",
    "diagnosticsUploadEnabled",
    "cloudSyncEnabled",
    "mcpEnabled",
    "yoloEnabled",
    "quickChatIconEnabled",
    "quickChatShortcutEnabled",
    "mobilePairingEnabled",
    "hasAttachments",
    "hasReferences",
    "remoteAccessEnabled",
    "openAiNativeConnectorsEnabled",
    "updateAvailable",
];

const SENSITIVE_KEY_TOKENS: &[&str] = &[
    "prompt",
    "response",
    "completion",
    "transcript",
    "content",
    "contents",
    "filename",
    "file_name",
    "file-name",
    "repo",
    "repository",
    "path",
    "command",
    "stdout",
    "stderr",
    "api_key",
    "apikey",
    "api-key",
    "provider_key",
    "provider-key",
    "secret",
    "token",
    "email",
    "username",
    "user_name",
    "user-name",
    "machine",
    "hostname",
];

/// Persisted installation metadata stored under `state.json`'s `productAnalytics` object.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedProductAnalyticsState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anonymous_installation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_app_version: Option<String>,
}

/// Resolved PostHog product analytics configuration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProductAnalyticsConfig {
    pub consent_enabled: bool,
    pub network_telemetry_disabled: bool,
    pub api_key: Option<String>,
    pub host: String,
    pub environment: String,
    pub release: String,
    pub app_version: String,
    pub platform: String,
    pub arch: String,
    pub is_packaged: bool,
    pub distinct_id: Option<String>,
    pub event_source: String,
}

impl ProductAnalyticsConfig {
    /// Returns true when consent is granted, kill switch is inactive, API key is set,
    /// and a safe anonymous installation ID exists.
    pub fn is_active(&self) -> bool {
        self.consent_enabled
            && !self.network_telemetry_disabled
            && self.api_key.is_some()
            && self
                .distinct_id
                .as_deref()
                .is_some_and(is_safe_anonymous_id)
    }

    /// Returns the PostHog batch ingestion URL (`{host}/batch/`).
    pub fn batch_endpoint(&self) -> String {
        format!("{}/batch/", self.host)
    }
}

/// Validates that an installation ID matches `/^[A-Za-z0-9_-]{16,128}$/`.
pub fn is_safe_anonymous_id(id: &str) -> bool {
    (16..=128).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Generates a fresh random anonymous installation ID (`anon_<uuid-hex>`).
pub fn generate_anonymous_installation_id() -> String {
    format!("anon_{}", Uuid::new_v4().simple())
}

fn host_platform_node_name() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        "linux" => "linux",
        other => other,
    }
}

fn normalize_environment(
    raw: Option<String>,
    env: &HashMap<String, String>,
    packaged: bool,
) -> String {
    if let Some(explicit) = raw {
        let lower = explicit.trim().to_ascii_lowercase();
        if matches!(
            lower.as_str(),
            "development" | "packaged" | "beta" | "production" | "test"
        ) {
            return lower;
        }
    }
    if let Some(node_env) = normalize_env_value(env.get("NODE_ENV")) {
        if node_env == "test" {
            return "test".to_string();
        }
        if node_env == "production" {
            return "production".to_string();
        }
    }
    if packaged {
        "packaged".to_string()
    } else {
        "development".to_string()
    }
}

/// Resolves product analytics configuration from desktop settings, persisted ID, and env.
pub fn resolve_product_analytics_config(
    settings: &PrivacyTelemetrySettings,
    persisted: Option<&PersistedProductAnalyticsState>,
    env: &HashMap<String, String>,
    is_packaged: bool,
    fallback_version: Option<&str>,
    event_source: &str,
) -> ProductAnalyticsConfig {
    let consent = resolve_telemetry_consent(settings, env, is_packaged);
    let api_key = normalize_env_value(env.get("COWORK_POSTHOG_KEY"))
        .or_else(|| build_time_env(option_env!("COWORK_POSTHOG_KEY")));
    let host = normalize_http_url(env.get("COWORK_POSTHOG_HOST"))
        .or_else(|| build_time_http_url(option_env!("COWORK_POSTHOG_HOST")))
        .unwrap_or_else(|| DEFAULT_POSTHOG_HOST.to_string());
    let app_version = fallback_version
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| super::resolve_desktop_app_version().to_string());
    let release = coalesce_env(env, &["COWORK_RELEASE", "COWORK_APP_VERSION"])
        .unwrap_or_else(|| app_version.clone());
    let env_raw = coalesce_env_or_build(
        env,
        &["COWORK_POSTHOG_ENVIRONMENT", "COWORK_PRODUCT_ANALYTICS_ENV"],
        &[
            option_env!("COWORK_POSTHOG_ENVIRONMENT"),
            option_env!("COWORK_PRODUCT_ANALYTICS_ENV"),
        ],
    );
    let environment = normalize_environment(env_raw, env, is_packaged);
    let distinct_id = persisted
        .and_then(|s| s.anonymous_installation_id.as_deref())
        .map(str::trim)
        .filter(|id| is_safe_anonymous_id(id))
        .map(ToString::to_string)
        .or_else(|| {
            normalize_env_value(env.get("COWORK_PRODUCT_ANALYTICS_INSTALLATION_ID"))
                .filter(|id| is_safe_anonymous_id(id))
        });

    ProductAnalyticsConfig {
        consent_enabled: consent.product_analytics_enabled,
        network_telemetry_disabled: consent.network_telemetry_disabled,
        api_key,
        host,
        environment,
        release,
        app_version,
        platform: host_platform_node_name().to_string(),
        arch: std::env::consts::ARCH.to_string(),
        is_packaged,
        distinct_id,
        event_source: event_source.to_string(),
    }
}

/// Builds PostHog environment variables propagated to child `cowork-server` processes.
pub fn build_server_product_analytics_env(
    settings: &PrivacyTelemetrySettings,
    persisted: Option<&PersistedProductAnalyticsState>,
    env: &HashMap<String, String>,
    is_packaged: bool,
    fallback_version: Option<&str>,
) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let cfg = resolve_product_analytics_config(
        settings,
        persisted,
        env,
        is_packaged,
        fallback_version,
        "server",
    );
    if !cfg.is_active() {
        out.insert(
            "COWORK_PRODUCT_ANALYTICS_ENABLED".to_string(),
            "false".to_string(),
        );
        return out;
    }
    if let (Some(api_key), Some(distinct_id)) = (cfg.api_key, cfg.distinct_id) {
        out.insert(
            "COWORK_PRODUCT_ANALYTICS_ENABLED".to_string(),
            "true".to_string(),
        );
        out.insert("COWORK_POSTHOG_KEY".to_string(), api_key);
        out.insert("COWORK_POSTHOG_HOST".to_string(), cfg.host);
        out.insert("COWORK_RELEASE".to_string(), cfg.release);
        out.insert("COWORK_POSTHOG_ENVIRONMENT".to_string(), cfg.environment);
        out.insert("COWORK_PLATFORM".to_string(), cfg.platform);
        out.insert("COWORK_ARCH".to_string(), cfg.arch);
        out.insert(
            "COWORK_PRODUCT_ANALYTICS_INSTALLATION_ID".to_string(),
            distinct_id,
        );
    }
    out
}

/// Reads the sanitized `productAnalytics` state object from a parsed `state.json` value.
pub fn read_persisted_product_analytics_state(doc: &Value) -> PersistedProductAnalyticsState {
    let Some(obj) = doc.get("productAnalytics").and_then(Value::as_object) else {
        return PersistedProductAnalyticsState::default();
    };
    let anonymous_installation_id = obj
        .get("anonymousInstallationId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| is_safe_anonymous_id(id))
        .map(ToString::to_string);
    let last_app_version = obj
        .get("lastAppVersion")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty() && is_safe_version(v))
        .map(ToString::to_string);
    PersistedProductAnalyticsState {
        anonymous_installation_id,
        last_app_version,
    }
}

fn persist_product_analytics_state(
    store: &PersistenceService,
    state: &PersistedProductAnalyticsState,
) {
    let Ok(val) = serde_json::to_value(state) else {
        return;
    };
    let _ = store.update_state_value(|mut doc| {
        if let Some(obj) = doc.as_object_mut() {
            obj.insert("productAnalytics".to_string(), val);
        }
        Ok(doc)
    });
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn truncate_utf16_prefix(s: &str, max_units: usize) -> &str {
    let mut units = 0;
    for (idx, ch) in s.char_indices() {
        let len = ch.len_utf16();
        if units + len > max_units {
            return &s[..idx];
        }
        units += len;
    }
    s
}

fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

fn is_sensitive_property_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    SENSITIVE_KEY_TOKENS.iter().any(|tok| lower.contains(tok))
}

fn contains_email_like(value: &str) -> bool {
    let bytes = value.as_bytes();
    for (at_idx, &b) in bytes.iter().enumerate() {
        if b != b'@' || at_idx == 0 {
            continue;
        }
        let local_ok = bytes[at_idx - 1].is_ascii_alphanumeric()
            || matches!(bytes[at_idx - 1], b'.' | b'_' | b'%' | b'+' | b'-');
        if !local_ok {
            continue;
        }
        let rest = &bytes[at_idx + 1..];
        let mut dot_pos = None;
        let mut domain_end = rest.len();
        for (i, &c) in rest.iter().enumerate() {
            if c == b'.' {
                dot_pos = Some(i);
            } else if !(c.is_ascii_alphanumeric() || c == b'-') {
                domain_end = i;
                break;
            }
        }
        if let Some(dp) = dot_pos
            && dp > 0
            && domain_end > dp + 2
            && rest[dp + 1..domain_end]
                .iter()
                .all(|c| c.is_ascii_alphabetic())
        {
            return true;
        }
    }
    false
}

fn contains_url_scheme(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    for scheme in ["http://", "https://", "file://"] {
        if let Some(pos) = lower.find(scheme) {
            let before_ok = pos == 0
                || !value.as_bytes()[pos - 1].is_ascii_alphanumeric()
                    && value.as_bytes()[pos - 1] != b'_';
            if before_ok {
                return true;
            }
        }
    }
    false
}

fn has_ascii_prefix_run(slice: &str, min_len: usize, allow_dash: bool) -> bool {
    let count = slice
        .bytes()
        .take_while(|&b| b.is_ascii_alphanumeric() || b == b'_' || (allow_dash && b == b'-'))
        .count();
    count >= min_len
}

fn contains_secret_token(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    for (idx, _) in lower.match_indices("sk-") {
        if (idx == 0 || !value.as_bytes()[idx - 1].is_ascii_alphanumeric())
            && has_ascii_prefix_run(&value[idx + 3..], 16, true)
        {
            return true;
        }
    }
    for prefix in ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"] {
        for (idx, _) in lower.match_indices(prefix) {
            if (idx == 0 || !value.as_bytes()[idx - 1].is_ascii_alphanumeric())
                && has_ascii_prefix_run(&value[idx + prefix.len()..], 20, false)
            {
                return true;
            }
        }
    }
    for prefix in ["xoxb-", "xoxa-", "xoxp-", "xoxr-", "xoxs-"] {
        for (idx, _) in lower.match_indices(prefix) {
            if (idx == 0 || !value.as_bytes()[idx - 1].is_ascii_alphanumeric())
                && has_ascii_prefix_run(&value[idx + prefix.len()..], 16, true)
            {
                return true;
            }
        }
    }
    for (idx, _) in lower.match_indices("bearer") {
        let before_ok = idx == 0 || !value.as_bytes()[idx - 1].is_ascii_alphanumeric();
        if !before_ok {
            continue;
        }
        let after = &value[idx + 6..];
        let ws_trimmed = after.trim_start_matches(is_js_whitespace);
        if ws_trimmed.len() < after.len() {
            let tok_len = ws_trimmed
                .bytes()
                .take_while(|&b| {
                    b.is_ascii_alphanumeric()
                        || matches!(b, b'.' | b'_' | b'~' | b'+' | b'/' | b'-')
                })
                .count();
            if tok_len >= 12 {
                return true;
            }
        }
    }
    false
}

fn has_sensitive_string_value(value: &str) -> bool {
    contains_email_like(value) || contains_url_scheme(value) || contains_secret_token(value)
}

fn is_path_lead_boundary(value: &str, idx: usize) -> bool {
    if idx == 0 {
        return true;
    }
    let Some(prev) = value[..idx].chars().next_back() else {
        return true;
    };
    is_js_whitespace(prev) || matches!(prev, '"' | '\'' | '`')
}

fn looks_like_path(value: &str) -> bool {
    looks_like_path_inner(value, true)
}

fn looks_like_local_model_path(value: &str) -> bool {
    looks_like_path_inner(value, false) || contains_url_scheme(value)
}

fn looks_like_path_inner(value: &str, check_generic_extension: bool) -> bool {
    if value.contains('\\') {
        return true;
    }
    let lower = value.to_ascii_lowercase();
    for root in [
        "/users",
        "/home",
        "/tmp",
        "/private",
        "/var",
        "/volumes",
        "/applications",
        "/opt",
        "/etc",
    ] {
        for (idx, _) in lower.match_indices(root) {
            if is_path_lead_boundary(value, idx) {
                let end = idx + root.len();
                let next_ok = end == value.len()
                    || !value.as_bytes()[end].is_ascii_alphanumeric()
                        && value.as_bytes()[end] != b'_';
                if next_ok {
                    return true;
                }
            }
        }
    }
    for (idx, _) in value.char_indices() {
        if !is_path_lead_boundary(value, idx) {
            continue;
        }
        let tail = &value[idx..];
        let bytes = tail.as_bytes();
        if bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && (bytes[2] == b'/' || bytes[2] == b'\\')
        {
            return true;
        }
        if tail.starts_with("./") || tail.starts_with("../") || tail.starts_with("~/") {
            return true;
        }
    }
    if check_generic_extension {
        for part in value.split(|c: char| is_js_whitespace(c) || matches!(c, '"' | '\'' | '`')) {
            if let Some((dir, file)) = part.split_once('/')
                && !dir.is_empty()
                && dir
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
                && let Some((_, ext)) = file.rsplit_once('.')
                && (1..=12).contains(&ext.len())
                && ext.bytes().all(|b| b.is_ascii_alphanumeric())
            {
                return true;
            }
        }
    }
    false
}

fn is_safe_slug(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= MAX_STATUS_LEN
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|&b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'))
}

fn is_safe_version(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= MAX_STRING_LEN
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|&b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'+' | b'-'))
}

fn is_safe_model_id(value: &str) -> bool {
    if utf16_len(value) > MAX_STRING_LEN || value.is_empty() {
        return false;
    }
    let bytes = value.as_bytes();
    if !bytes[0].is_ascii_alphanumeric() {
        return false;
    }
    if !bytes.iter().all(|&b| {
        b.is_ascii_alphanumeric()
            || matches!(b, b'_' | b'.' | b':' | b'@' | b'/' | b'+' | b' ' | b'-')
    }) {
        return false;
    }
    if value.starts_with('.') || value.starts_with('~') || value.contains("..") {
        return false;
    }
    !looks_like_local_model_path(value)
}

fn sanitize_string_property(key: &str, value: &str) -> Result<Option<String>, ()> {
    let trimmed = value.trim_matches(is_js_whitespace);
    if trimmed.is_empty() {
        return Ok(None);
    }
    if has_sensitive_string_value(trimmed) {
        return Err(());
    }
    if key == "model" {
        if !is_safe_model_id(trimmed) {
            return Err(());
        }
        return Ok(Some(
            truncate_utf16_prefix(trimmed, MAX_STRING_LEN).to_string(),
        ));
    }
    if looks_like_path(trimmed) {
        return Err(());
    }
    let max_len = match key {
        "status" | "errorCategory" => MAX_STATUS_LEN,
        _ => MAX_STRING_LEN,
    };
    let limited = truncate_utf16_prefix(trimmed, max_len);
    if limited.len() < trimmed.len() && utf16_len(limited) < max_len {
        return Err(());
    }
    let valid = match key {
        "appVersion" => is_safe_version(limited),
        _ => is_safe_slug(limited),
    };
    if valid {
        Ok(Some(limited.to_string()))
    } else {
        Err(())
    }
}

fn sanitize_property_value(key: &str, value: &Value) -> Result<Option<Value>, ()> {
    if value.is_null() {
        return Ok(Some(Value::Null));
    }
    if PRODUCT_ANALYTICS_BOOL_PROPS.contains(&key) {
        return value.as_bool().map(|b| Some(Value::Bool(b))).ok_or(());
    }
    if key == "durationMs" {
        let n = value.as_f64().filter(|n| n.is_finite()).ok_or(())?;
        let clamped = n.round().clamp(0.0, MAX_DURATION_MS) as u64;
        return Ok(Some(json!(clamped)));
    }
    if key.ends_with("Count") {
        let n = value.as_f64().filter(|n| n.is_finite()).ok_or(())?;
        let clamped = n.floor().clamp(0.0, MAX_COUNT) as u64;
        return Ok(Some(json!(clamped)));
    }
    if !PRODUCT_ANALYTICS_STRING_PROPS.contains(&key) {
        return Err(());
    }
    let raw = value.as_str().ok_or(())?;
    Ok(sanitize_string_property(key, raw)?.map(Value::String))
}

/// Validates and sanitizes an analytics event against `PRODUCT_ANALYTICS_EVENT_NAMES`
/// and `PRODUCT_ANALYTICS_PROPERTY_NAMES`. Returns `None` if the event must be dropped.
pub fn sanitize_product_analytics_event(
    event_name: &str,
    properties: &BTreeMap<String, Value>,
) -> Option<Map<String, Value>> {
    if !PRODUCT_ANALYTICS_EVENT_NAMES.contains(&event_name) {
        return None;
    }
    let mut out = Map::new();
    for (k, v) in properties {
        if !PRODUCT_ANALYTICS_PROPERTY_NAMES.contains(&k.as_str()) || is_sensitive_property_key(k) {
            return None;
        }
        if let Some(safe) = sanitize_property_value(k, v).ok()? {
            out.insert(k.clone(), safe);
        }
    }
    out.insert("$process_person_profile".to_string(), Value::Bool(false));
    Some(out)
}

#[derive(Clone)]
struct QueuedProductEvent {
    endpoint: String,
    api_key: String,
    distinct_id: String,
    event: String,
    timestamp: String,
    properties: Map<String, Value>,
}

enum AnalyticsJob {
    Event(QueuedProductEvent),
    Flush(oneshot::Sender<()>),
}

async fn send_analytics_batch(client: &reqwest::Client, batch: &mut Vec<QueuedProductEvent>) {
    if batch.is_empty() {
        return;
    }
    let first = &batch[0];
    let endpoint = first.endpoint.clone();
    let api_key = first.api_key.clone();
    let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let items: Vec<Value> = batch
        .drain(..)
        .map(|ev| {
            json!({
                "event": ev.event,
                "distinct_id": ev.distinct_id,
                "timestamp": ev.timestamp,
                "properties": ev.properties,
            })
        })
        .collect();
    let body = json!({
        "api_key": api_key,
        "sent_at": now,
        "batch": items,
    });
    let _ = client
        .post(&endpoint)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await;
}

fn spawn_analytics_worker(timeout: Duration) -> mpsc::Sender<AnalyticsJob> {
    let (tx, mut rx) = mpsc::channel::<AnalyticsJob>(ANALYTICS_QUEUE_CAPACITY);
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    let worker = async move {
        let mut pending: Vec<QueuedProductEvent> = Vec::with_capacity(ANALYTICS_BATCH_SIZE);
        while let Some(job) = rx.recv().await {
            match job {
                AnalyticsJob::Event(ev) => {
                    if let Some(first) = pending.first()
                        && (first.endpoint != ev.endpoint || first.api_key != ev.api_key)
                    {
                        send_analytics_batch(&client, &mut pending).await;
                    }
                    pending.push(ev);
                    while let Ok(next_job) = rx.try_recv() {
                        match next_job {
                            AnalyticsJob::Event(more) => {
                                if let Some(first) = pending.first()
                                    && (first.endpoint != more.endpoint
                                        || first.api_key != more.api_key)
                                {
                                    send_analytics_batch(&client, &mut pending).await;
                                }
                                pending.push(more);
                                if pending.len() >= ANALYTICS_BATCH_SIZE {
                                    break;
                                }
                            }
                            AnalyticsJob::Flush(done) => {
                                send_analytics_batch(&client, &mut pending).await;
                                let _ = done.send(());
                            }
                        }
                    }
                    send_analytics_batch(&client, &mut pending).await;
                }
                AnalyticsJob::Flush(done) => {
                    send_analytics_batch(&client, &mut pending).await;
                    let _ = done.send(());
                }
            }
        }
        send_analytics_batch(&client, &mut pending).await;
    };

    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        handle.spawn(worker);
    } else {
        let _ = std::thread::Builder::new()
            .name("cowork-desktop-analytics".to_string())
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

struct ProductAnalyticsInner {
    config: ProductAnalyticsConfig,
    persisted: PersistedProductAnalyticsState,
    sender: Option<mpsc::Sender<AnalyticsJob>>,
    startup_emitted: bool,
}

/// Manages privacy-scrubbed PostHog analytics and persistent anonymous installation state.
#[derive(Clone)]
pub struct ProductAnalyticsService {
    inner: Arc<Mutex<ProductAnalyticsInner>>,
}

impl ProductAnalyticsService {
    /// Initializes product analytics and resolves/generates `anonymousInstallationId` when opted in.
    pub fn new(
        is_packaged: bool,
        settings: &PrivacyTelemetrySettings,
        persisted_state: Option<PersistedProductAnalyticsState>,
        persistence: Option<&PersistenceService>,
        env: &HashMap<String, String>,
    ) -> Self {
        let mut persisted = persisted_state.unwrap_or_default();
        let initial_cfg = resolve_product_analytics_config(
            settings,
            Some(&persisted),
            env,
            is_packaged,
            None,
            "desktop",
        );

        let mut mutated_persisted = false;
        if initial_cfg.consent_enabled
            && !initial_cfg.network_telemetry_disabled
            && persisted
                .anonymous_installation_id
                .as_deref()
                .is_none_or(|id| !is_safe_anonymous_id(id))
        {
            persisted.anonymous_installation_id = Some(generate_anonymous_installation_id());
            mutated_persisted = true;
        }
        let previous_version = persisted.last_app_version.clone();
        if initial_cfg.consent_enabled
            && !initial_cfg.network_telemetry_disabled
            && persisted.last_app_version.as_deref() != Some(initial_cfg.app_version.as_str())
        {
            persisted.last_app_version = Some(initial_cfg.app_version.clone());
            mutated_persisted = true;
        }

        if mutated_persisted && let Some(store) = persistence {
            persist_product_analytics_state(store, &persisted);
        }

        let cfg = resolve_product_analytics_config(
            settings,
            Some(&persisted),
            env,
            is_packaged,
            None,
            "desktop",
        );
        let sender = if cfg.is_active() {
            Some(spawn_analytics_worker(ANALYTICS_HTTP_TIMEOUT))
        } else {
            None
        };

        let service = Self {
            inner: Arc::new(Mutex::new(ProductAnalyticsInner {
                config: cfg,
                persisted,
                sender,
                startup_emitted: false,
            })),
        };
        if let Some(prev) = previous_version
            && prev != super::resolve_desktop_app_version()
        {
            service.emit_app_updated_if_active();
        }
        service.emit_app_started_once();
        service
    }

    /// Reconfigures consent/ID state after desktop settings change.
    pub fn reconfigure(
        &self,
        settings: &PrivacyTelemetrySettings,
        persistence: Option<&PersistenceService>,
        env: &HashMap<String, String>,
    ) {
        let mut emit_startup = false;
        {
            let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            let is_packaged = guard.config.is_packaged;
            let consent = resolve_telemetry_consent(settings, env, is_packaged);
            if consent.product_analytics_enabled
                && !consent.network_telemetry_disabled
                && guard
                    .persisted
                    .anonymous_installation_id
                    .as_deref()
                    .is_none_or(|id| !is_safe_anonymous_id(id))
            {
                guard.persisted.anonymous_installation_id =
                    Some(generate_anonymous_installation_id());
                if guard.persisted.last_app_version.is_none() {
                    guard.persisted.last_app_version =
                        Some(super::resolve_desktop_app_version().to_string());
                }
                if let Some(store) = persistence {
                    persist_product_analytics_state(store, &guard.persisted);
                }
            }
            let next_cfg = resolve_product_analytics_config(
                settings,
                Some(&guard.persisted),
                env,
                is_packaged,
                None,
                "desktop",
            );
            let active = next_cfg.is_active();
            guard.config = next_cfg;
            if active && guard.sender.is_none() {
                guard.sender = Some(spawn_analytics_worker(ANALYTICS_HTTP_TIMEOUT));
            } else if !active {
                guard.sender = None;
            }
            if active && !guard.startup_emitted {
                emit_startup = true;
            }
        }
        if emit_startup {
            self.emit_app_started_once();
        }
    }

    /// Returns true when active PostHog event capture is enabled.
    pub fn is_enabled(&self) -> bool {
        let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard.config.is_active()
    }

    /// Returns a snapshot of the persisted installation state (`anonymousInstallationId`, `lastAppVersion`).
    pub fn persisted_state(&self) -> PersistedProductAnalyticsState {
        let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard.persisted.clone()
    }

    /// Captures an allowlisted product analytics event asynchronously, returning false if dropped.
    pub fn capture_event(&self, event_name: &str, properties: &BTreeMap<String, Value>) -> bool {
        if is_network_telemetry_globally_disabled(&cowork_config::env_map_from_process()) {
            return false;
        }
        let (cfg, tx) = {
            let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            if !guard.config.is_active() {
                return false;
            }
            let Some(tx) = guard.sender.clone() else {
                return false;
            };
            (guard.config.clone(), tx)
        };

        let (Some(api_key), Some(distinct_id)) = (cfg.api_key.clone(), cfg.distinct_id.clone())
        else {
            return false;
        };
        let mut merged = BTreeMap::new();
        merged.insert(
            "appVersion".to_string(),
            Value::String(cfg.app_version.clone()),
        );
        merged.insert("platform".to_string(), Value::String(cfg.platform.clone()));
        merged.insert("arch".to_string(), Value::String(cfg.arch.clone()));
        merged.insert("packaged".to_string(), Value::Bool(cfg.is_packaged));
        merged.insert(
            "eventSource".to_string(),
            Value::String(cfg.event_source.clone()),
        );
        for (k, v) in properties {
            merged.insert(k.clone(), v.clone());
        }
        let Some(mut safe_props) = sanitize_product_analytics_event(event_name, &merged) else {
            return false;
        };
        safe_props.insert(
            "environment".to_string(),
            Value::String(cfg.environment.clone()),
        );
        safe_props.insert("$geoip_disable".to_string(), Value::Bool(true));

        let ev = QueuedProductEvent {
            endpoint: cfg.batch_endpoint(),
            api_key,
            distinct_id,
            event: event_name.to_string(),
            timestamp: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            properties: safe_props,
        };
        tx.try_send(AnalyticsJob::Event(ev)).is_ok()
    }

    fn emit_app_started_once(&self) {
        let should_emit = {
            let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            if guard.config.is_active() && !guard.startup_emitted {
                guard.startup_emitted = true;
                true
            } else {
                false
            }
        };
        if should_emit {
            let _ = self.capture_event("app_started", &BTreeMap::new());
        }
    }

    fn emit_app_updated_if_active(&self) {
        let _ = self.capture_event("app_updated", &BTreeMap::new());
    }

    /// Flushes any queued analytics events to PostHog.
    pub async fn flush(&self) {
        let tx = {
            let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            guard.sender.clone()
        };
        let Some(sender) = tx else {
            return;
        };
        let (done_tx, done_rx) = oneshot::channel();
        if sender.send(AnalyticsJob::Flush(done_tx)).await.is_ok() {
            let _ = tokio::time::timeout(ANALYTICS_HTTP_TIMEOUT, done_rx).await;
        }
    }

    /// Stops accepting analytics events.
    pub fn shutdown(&self) {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard.sender = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use tempfile::tempdir;

    #[test]
    fn sanitize_product_analytics_drops_unknown_events_and_sensitive_values() {
        assert!(sanitize_product_analytics_event("unknown_event", &BTreeMap::new()).is_none());

        let mut bad_key = BTreeMap::new();
        bad_key.insert("customPrompt".to_string(), json!("hello"));
        assert!(sanitize_product_analytics_event("workspace_added", &bad_key).is_none());

        let mut bad_path = BTreeMap::new();
        bad_path.insert("status".to_string(), json!("/Users/alice/secret"));
        assert!(sanitize_product_analytics_event("workspace_added", &bad_path).is_none());

        let mut bad_secret = BTreeMap::new();
        bad_secret.insert(
            "errorCategory".to_string(),
            json!("Bearer secret1234567890"),
        );
        assert!(sanitize_product_analytics_event("turn_failed", &bad_secret).is_none());

        let mut ok = BTreeMap::new();
        ok.insert("workspaceCount".to_string(), json!(3.8));
        ok.insert("durationMs".to_string(), json!(45.6));
        ok.insert("model".to_string(), json!("openai/gpt-5.4"));
        ok.insert("status".to_string(), json!("ok"));
        let safe = sanitize_product_analytics_event("turn_completed", &ok).unwrap();
        assert_eq!(safe["workspaceCount"], json!(3));
        assert_eq!(safe["durationMs"], json!(46));
        assert_eq!(safe["model"], json!("openai/gpt-5.4"));
        assert_eq!(safe["$process_person_profile"], json!(false));
    }

    #[test]
    fn respects_consent_and_kill_switch_with_zero_network_calls() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let addr = listener.local_addr().unwrap();
        let hits = Arc::new(AtomicUsize::new(0));
        let hits_clone = hits.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let stop_clone = stop.clone();
        let accept_thread = std::thread::spawn(move || {
            while !stop_clone.load(Ordering::Relaxed) {
                if let Ok((_s, _)) = listener.accept() {
                    hits_clone.fetch_add(1, Ordering::Relaxed);
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        });

        let mut env = HashMap::new();
        env.insert("COWORK_POSTHOG_KEY".to_string(), "phc_test_key".to_string());
        env.insert("COWORK_POSTHOG_HOST".to_string(), format!("http://{addr}"));
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();

        rt.block_on(async {
            // Opt-out by default -> no network activity, no installation id minted.
            let svc = ProductAnalyticsService::new(
                false,
                &PrivacyTelemetrySettings::default(),
                None,
                None,
                &env,
            );
            assert!(!svc.is_enabled());
            assert!(svc.persisted_state().anonymous_installation_id.is_none());
            assert!(!svc.capture_event("workspace_added", &BTreeMap::new()));
            svc.flush().await;

            // Kill switch overrides opted-in settings.
            let opted_in = PrivacyTelemetrySettings {
                product_analytics_enabled: true,
                ..Default::default()
            };
            let mut kill_env = env.clone();
            kill_env.insert(
                "COWORK_DISABLE_NETWORK_TELEMETRY".to_string(),
                "1".to_string(),
            );
            let killed = ProductAnalyticsService::new(true, &opted_in, None, None, &kill_env);
            assert!(!killed.is_enabled());
            assert!(killed.persisted_state().anonymous_installation_id.is_none());
            assert!(!killed.capture_event("workspace_added", &BTreeMap::new()));
            killed.flush().await;
        });

        stop.store(true, Ordering::Relaxed);
        let _ = accept_thread.join();
        assert_eq!(hits.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn persists_anonymous_id_emits_app_started_and_app_updated_to_mock_posthog() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let captured = Arc::new(Mutex::new(Vec::<String>::new()));
        let captured_clone = captured.clone();
        let server_thread = std::thread::spawn(move || {
            for stream in listener.incoming().take(3) {
                let mut stream = stream.unwrap();
                let mut buf = [0u8; 8192];
                let n = stream.read(&mut buf).unwrap_or(0);
                captured_clone
                    .lock()
                    .unwrap()
                    .push(String::from_utf8_lossy(&buf[..n]).to_string());
                let _ = stream.write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 15\r\nConnection: close\r\n\r\n{\"status\": 1}",
                );
            }
        });

        let tmp = tempdir().unwrap();
        let persistence = PersistenceService::new(tmp.path().to_path_buf(), None, true, None);
        let settings = PrivacyTelemetrySettings {
            product_analytics_enabled: true,
            ..Default::default()
        };
        let mut env = HashMap::new();
        env.insert(
            "COWORK_POSTHOG_KEY".to_string(),
            "phc_live_mock".to_string(),
        );
        env.insert("COWORK_POSTHOG_HOST".to_string(), format!("http://{addr}"));

        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let initial_id = rt.block_on(async {
            let service = ProductAnalyticsService::new(
                false,
                &settings,
                Some(PersistedProductAnalyticsState {
                    anonymous_installation_id: None,
                    last_app_version: Some("0.0.1-prev".to_string()),
                }),
                Some(&persistence),
                &env,
            );
            assert!(service.is_enabled());
            let persisted = service.persisted_state();
            let id = persisted.anonymous_installation_id.clone().unwrap();
            assert!(id.starts_with("anon_"));
            assert_eq!(
                persisted.last_app_version.as_deref(),
                Some(crate::native::resolve_desktop_app_version())
            );

            let mut props = BTreeMap::new();
            props.insert("workspaceCount".to_string(), json!(2));
            assert!(service.capture_event("workspace_added", &props));
            service.flush().await;
            id
        });

        // Verify persistence roundtrip kept `productAnalytics`.
        let doc = persistence.load_state_value().unwrap();
        let reloaded = read_persisted_product_analytics_state(&doc);
        assert_eq!(
            reloaded.anonymous_installation_id.as_deref(),
            Some(initial_id.as_str())
        );

        // Shut down listener nicely if fewer than 3 batches occurred due to batching.
        let _ = std::net::TcpStream::connect(addr);
        let _ = std::net::TcpStream::connect(addr);
        let _ = server_thread.join();

        let body_joined = captured.lock().unwrap().join("\n");
        assert!(body_joined.contains("POST /batch/"));
        assert!(body_joined.contains("app_updated"));
        assert!(body_joined.contains("app_started"));
        assert!(body_joined.contains("workspace_added"));
        assert!(body_joined.contains(&initial_id));
        assert!(body_joined.contains("\"$geoip_disable\":true"));
        assert!(body_joined.contains("\"$process_person_profile\":false"));
    }

    #[test]
    fn runtime_env_overrides_build_time_posthog_environment_fallback() {
        let mut env = HashMap::new();
        let fallback_raw = coalesce_env_or_build(
            &env,
            &["COWORK_POSTHOG_ENVIRONMENT", "COWORK_PRODUCT_ANALYTICS_ENV"],
            &[Some("production")],
        );
        assert_eq!(
            normalize_environment(fallback_raw, &env, true),
            "production"
        );

        env.insert("COWORK_POSTHOG_ENVIRONMENT".to_string(), "beta".to_string());
        let override_raw = coalesce_env_or_build(
            &env,
            &["COWORK_POSTHOG_ENVIRONMENT", "COWORK_PRODUCT_ANALYTICS_ENV"],
            &[Some("production")],
        );
        assert_eq!(normalize_environment(override_raw, &env, true), "beta");
    }
}
