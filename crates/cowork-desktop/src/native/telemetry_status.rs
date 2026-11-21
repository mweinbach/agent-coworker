//! Desktop telemetry consent and status snapshot resolution matching
//! `apps/desktop/electron/services/telemetryStatus.ts` and `src/telemetry/config.ts`.

use std::collections::HashMap;

use serde_json::{Map, Value, json};

use crate::state::{PersistedDesktopState, PrivacyTelemetrySettings};

const DEFAULT_LANGFUSE_BASE_URL: &str = "https://cloud.langfuse.com";

pub(crate) fn normalize_env_value(value: Option<&String>) -> Option<String> {
    value
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

pub(crate) fn build_time_env(value: Option<&'static str>) -> Option<String> {
    value
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

pub(crate) fn build_time_http_url(value: Option<&'static str>) -> Option<String> {
    let owned = build_time_env(value)?;
    normalize_http_url(Some(&owned))
}

fn parse_env_bool(value: Option<&String>) -> Option<bool> {
    let raw = value?.trim().to_ascii_lowercase();
    match raw.as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

pub(crate) fn coalesce_env(env: &HashMap<String, String>, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(val) = normalize_env_value(env.get(*key)) {
            return Some(val);
        }
    }
    None
}

pub(crate) fn coalesce_env_or_build(
    env: &HashMap<String, String>,
    keys: &[&str],
    build_fallbacks: &[Option<&'static str>],
) -> Option<String> {
    coalesce_env(env, keys).or_else(|| build_fallbacks.iter().find_map(|raw| build_time_env(*raw)))
}

pub(crate) fn normalize_http_url(raw: Option<&String>) -> Option<String> {
    let candidate = normalize_env_value(raw)?;
    let parsed = url::Url::parse(&candidate).ok()?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return None;
    }
    Some(parsed.as_str().trim_end_matches('/').to_string())
}

/// Returns true when the process-wide `COWORK_DISABLE_NETWORK_TELEMETRY` kill switch is set.
pub fn is_network_telemetry_globally_disabled(env: &HashMap<String, String>) -> bool {
    parse_env_bool(env.get("COWORK_DISABLE_NETWORK_TELEMETRY")) == Some(true)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedTelemetryConsent {
    pub crash_reports_enabled: bool,
    pub product_analytics_enabled: bool,
    pub ai_trace_telemetry_enabled: bool,
    pub ai_trace_payloads_enabled: bool,
    pub diagnostics_upload_enabled: bool,
    pub cloud_sync_enabled: bool,
    pub mode: String,
    pub network_telemetry_disabled: bool,
}

pub(crate) fn resolve_packaging_mode(env: &HashMap<String, String>, is_packaged: bool) -> String {
    if let Some(raw) = normalize_env_value(env.get("COWORK_TELEMETRY_MODE")) {
        let lower = raw.to_ascii_lowercase();
        if matches!(
            lower.as_str(),
            "local-dev" | "packaged-public" | "self-hosted" | "enterprise/offline"
        ) {
            return lower;
        }
    }
    if is_network_telemetry_globally_disabled(env) {
        return "enterprise/offline".to_string();
    }
    if is_packaged {
        "packaged-public".to_string()
    } else {
        "local-dev".to_string()
    }
}

fn resolve_trace_payload_env(env: &HashMap<String, String>) -> Option<bool> {
    if let Some(v) = parse_env_bool(env.get("AGENT_OBSERVABILITY_RECORD_PAYLOADS")) {
        return Some(v);
    }
    let rec_in = parse_env_bool(env.get("AGENT_OBSERVABILITY_RECORD_INPUTS"));
    let rec_out = parse_env_bool(env.get("AGENT_OBSERVABILITY_RECORD_OUTPUTS"));
    if rec_in == Some(true) || rec_out == Some(true) {
        return Some(true);
    }
    if rec_in == Some(false) && rec_out == Some(false) {
        return Some(false);
    }
    None
}

pub fn resolve_telemetry_consent(
    settings: &PrivacyTelemetrySettings,
    env: &HashMap<String, String>,
    is_packaged: bool,
) -> ResolvedTelemetryConsent {
    let mode = resolve_packaging_mode(env, is_packaged);
    let network_disabled = is_network_telemetry_globally_disabled(env);
    if network_disabled {
        return ResolvedTelemetryConsent {
            crash_reports_enabled: false,
            product_analytics_enabled: false,
            ai_trace_telemetry_enabled: false,
            ai_trace_payloads_enabled: false,
            diagnostics_upload_enabled: false,
            cloud_sync_enabled: false,
            mode,
            network_telemetry_disabled: true,
        };
    }

    let allow_env_opt_in = mode == "local-dev" || mode == "self-hosted";
    let crash_reports_enabled = settings.crash_reports_enabled
        || (allow_env_opt_in
            && parse_env_bool(env.get("COWORK_CRASH_REPORTS_ENABLED")) == Some(true));
    let product_analytics_enabled = settings.product_analytics_enabled
        || (allow_env_opt_in
            && parse_env_bool(env.get("COWORK_PRODUCT_ANALYTICS_ENABLED")) == Some(true));
    let ai_trace_telemetry_enabled = settings.ai_trace_telemetry_enabled
        || (allow_env_opt_in
            && parse_env_bool(env.get("AGENT_OBSERVABILITY_ENABLED")) == Some(true));
    let ai_trace_payloads_enabled = ai_trace_telemetry_enabled
        && (settings.ai_trace_payloads_enabled
            || (allow_env_opt_in && resolve_trace_payload_env(env) == Some(true)));
    let cloud_sync_enabled = settings.cloud_sync_enabled
        || (allow_env_opt_in && parse_env_bool(env.get("COWORK_CLOUD_SYNC_ENABLED")) == Some(true));

    ResolvedTelemetryConsent {
        crash_reports_enabled,
        product_analytics_enabled,
        ai_trace_telemetry_enabled,
        ai_trace_payloads_enabled,
        diagnostics_upload_enabled: settings.diagnostics_upload_enabled,
        cloud_sync_enabled,
        mode,
        network_telemetry_disabled: false,
    }
}

fn status_label(status: &str) -> &'static str {
    match status {
        "disabled" => "Disabled",
        "not_configured" => "Not configured",
        "enabled" => "Enabled",
        "metadata_only" => "Metadata only",
        "full_payload" => "Full payload",
        "local_only" => "Local only",
        "upload_configured" => "Upload configured",
        "connected" => "Connected",
        "error" => "Error",
        _ => "Disabled",
    }
}

fn status_entry(status: &str, configured: bool, enabled: bool, message: Option<&str>) -> Value {
    let mut obj = Map::new();
    obj.insert("label".into(), Value::String(status_label(status).into()));
    obj.insert("status".into(), Value::String(status.into()));
    obj.insert("configured".into(), Value::Bool(configured));
    obj.insert("enabled".into(), Value::Bool(enabled));
    if let Some(msg) = message.map(str::trim).filter(|s| !s.is_empty()) {
        obj.insert("message".into(), Value::String(msg.to_string()));
    }
    Value::Object(obj)
}

/// Builds a sanitized `TelemetryStatusSnapshot` JSON object matching `desktopApi.getTelemetryStatus`.
pub fn resolve_desktop_telemetry_status(
    snapshot: &PersistedDesktopState,
    raw_state_doc: Option<&Value>,
    env: &HashMap<String, String>,
    is_packaged: bool,
) -> Value {
    let consent = resolve_telemetry_consent(&snapshot.settings.privacy_telemetry, env, is_packaged);
    let kill_switch = consent.network_telemetry_disabled;

    let sentry_dsn = coalesce_env(env, &["COWORK_SENTRY_DSN", "SENTRY_DSN"])
        .or_else(|| build_time_env(option_env!("COWORK_SENTRY_DSN")));
    let crash_enabled = !kill_switch && consent.crash_reports_enabled && sentry_dsn.is_some();
    let crash_status = if kill_switch || !consent.crash_reports_enabled {
        "disabled"
    } else if sentry_dsn.is_some() {
        "enabled"
    } else {
        "not_configured"
    };

    let posthog_key = normalize_env_value(env.get("COWORK_POSTHOG_KEY"))
        .or_else(|| build_time_env(option_env!("COWORK_POSTHOG_KEY")));
    let anon_id = raw_state_doc
        .and_then(|d| d.get("productAnalytics"))
        .and_then(|pa| pa.get("anonymousInstallationId"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string)
        .or_else(|| normalize_env_value(env.get("COWORK_PRODUCT_ANALYTICS_INSTALLATION_ID")));
    let product_enabled = !kill_switch
        && consent.product_analytics_enabled
        && posthog_key.is_some()
        && anon_id.is_some();
    let product_status = if kill_switch || !consent.product_analytics_enabled {
        "disabled"
    } else if posthog_key.is_some() && anon_id.is_some() {
        "enabled"
    } else {
        "not_configured"
    };

    let langfuse_base = normalize_http_url(env.get("LANGFUSE_BASE_URL"))
        .unwrap_or_else(|| DEFAULT_LANGFUSE_BASE_URL.into());
    let langfuse_public = normalize_env_value(env.get("LANGFUSE_PUBLIC_KEY"));
    let langfuse_secret = normalize_env_value(env.get("LANGFUSE_SECRET_KEY"));
    let langfuse_public_ready = !langfuse_base.is_empty() && langfuse_public.is_some();
    let langfuse_configured = langfuse_public_ready && langfuse_secret.is_some();
    let ai_entry = if kill_switch || !consent.ai_trace_telemetry_enabled {
        status_entry("disabled", false, false, None)
    } else if !langfuse_public_ready || !langfuse_configured {
        status_entry("not_configured", false, false, None)
    } else if consent.ai_trace_payloads_enabled {
        status_entry("full_payload", true, true, None)
    } else {
        status_entry("metadata_only", true, true, None)
    };

    let diag_url = if kill_switch {
        None
    } else {
        normalize_http_url(env.get("COWORK_DIAGNOSTICS_UPLOAD_URL"))
    };
    let diag_enabled = !kill_switch && consent.diagnostics_upload_enabled && diag_url.is_some();
    let diag_status = if kill_switch || !consent.diagnostics_upload_enabled {
        "disabled"
    } else if diag_url.is_some() {
        "upload_configured"
    } else {
        "local_only"
    };

    let cloud_obj = raw_state_doc
        .and_then(|d| d.get("cloudSync"))
        .and_then(Value::as_object);
    let cloud_endpoint = normalize_http_url(env.get("COWORK_CLOUD_SYNC_ENDPOINT")).or_else(|| {
        cloud_obj
            .and_then(|o| o.get("endpoint"))
            .and_then(Value::as_str)
            .and_then(|s| normalize_http_url(Some(&s.to_string())))
    });
    let cloud_sync_settings = cloud_obj
        .and_then(|o| o.get("syncSettings"))
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let cloud_env_enabled = parse_env_bool(env.get("COWORK_CLOUD_SYNC_ENABLED"));
    let cloud_persisted_enabled = cloud_obj
        .and_then(|o| o.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let cloud_enabled = !kill_switch
        && (cloud_env_enabled.unwrap_or(cloud_persisted_enabled) || consent.cloud_sync_enabled);
    let cloud_provider_custom = cloud_endpoint.is_some()
        || cloud_obj
            .and_then(|o| o.get("provider"))
            .and_then(Value::as_str)
            == Some("custom");

    let cloud_entry = if kill_switch || !cloud_enabled || !cloud_sync_settings {
        status_entry("disabled", false, false, None)
    } else if !cloud_provider_custom || cloud_endpoint.is_none() {
        status_entry("not_configured", false, cloud_enabled, None)
    } else {
        status_entry("connected", true, true, None)
    };

    json!({
        "globalKillSwitchActive": kill_switch,
        "crashReports": status_entry(crash_status, sentry_dsn.is_some(), crash_enabled, None),
        "productAnalytics": status_entry(
            product_status,
            posthog_key.is_some(),
            product_enabled,
            None,
        ),
        "aiTraces": ai_entry,
        "diagnosticsUpload": status_entry(diag_status, diag_url.is_some(), diag_enabled, None),
        "cloudSync": cloud_entry,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_disabled_states_by_default_and_under_kill_switch() {
        let state = PersistedDesktopState::default();
        let env = HashMap::new();
        let snap = resolve_desktop_telemetry_status(&state, None, &env, false);

        assert_eq!(snap["globalKillSwitchActive"], false);
        assert_eq!(snap["crashReports"]["status"], "disabled");
        assert_eq!(snap["aiTraces"]["status"], "disabled");
        assert_eq!(snap["diagnosticsUpload"]["status"], "disabled");

        let mut env_kill = HashMap::new();
        env_kill.insert("COWORK_DISABLE_NETWORK_TELEMETRY".into(), "1".into());
        env_kill.insert("COWORK_SENTRY_DSN".into(), "https://dsn.example/1".into());
        let mut enabled_state = PersistedDesktopState::default();
        enabled_state
            .settings
            .privacy_telemetry
            .crash_reports_enabled = true;
        enabled_state
            .settings
            .privacy_telemetry
            .diagnostics_upload_enabled = true;
        let killed = resolve_desktop_telemetry_status(&enabled_state, None, &env_kill, false);
        assert_eq!(killed["globalKillSwitchActive"], true);
        assert_eq!(killed["crashReports"]["enabled"], false);
        assert_eq!(killed["crashReports"]["status"], "disabled");
        assert_eq!(killed["diagnosticsUpload"]["status"], "disabled");
    }

    #[test]
    fn resolves_configured_opt_in_statuses() {
        let mut state = PersistedDesktopState::default();
        state.settings.privacy_telemetry.crash_reports_enabled = true;
        state.settings.privacy_telemetry.ai_trace_telemetry_enabled = true;
        state.settings.privacy_telemetry.ai_trace_payloads_enabled = true;
        state.settings.privacy_telemetry.diagnostics_upload_enabled = true;

        let mut env = HashMap::new();
        env.insert(
            "COWORK_SENTRY_DSN".into(),
            "https://sentry.example/1".into(),
        );
        env.insert("LANGFUSE_PUBLIC_KEY".into(), "pk-lf-1".into());
        env.insert("LANGFUSE_SECRET_KEY".into(), "sk-lf-secret".into());

        let snap = resolve_desktop_telemetry_status(&state, None, &env, false);
        assert_eq!(snap["crashReports"]["status"], "enabled");
        assert_eq!(snap["crashReports"]["enabled"], true);
        assert_eq!(snap["aiTraces"]["status"], "full_payload");
        assert_eq!(snap["aiTraces"]["label"], "Full payload");
        assert_eq!(snap["diagnosticsUpload"]["status"], "local_only");
        // Secrets must never appear in telemetry snapshot output.
        assert!(!snap.to_string().contains("sk-lf-secret"));
    }
}
