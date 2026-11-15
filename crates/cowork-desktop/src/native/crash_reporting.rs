//! Privacy-first Sentry crash reporting for the native desktop runtime.
//!
//! Mirrors Electron's `src/telemetry/crashReporting.ts` and
//! `apps/desktop/electron/services/crashReporting.ts` contract without requiring
//! an external Sentry SDK crate: builds Sentry envelopes, scrubs events and
//! breadcrumbs through [`DiagnosticsRedactionContext`], respects telemetry
//! consent and `COWORK_DISABLE_NETWORK_TELEMETRY`, records bounded recent crash
//! IDs for diagnostics bundles, and installs a chained panic hook.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::panic::PanicHookInfo;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, Once};
use std::time::Duration;

use chrono::Utc;
use serde_json::{Map, Value, json};
use tokio::sync::{mpsc, oneshot};
use url::Url;
use uuid::Uuid;

use crate::state::PrivacyTelemetrySettings;

use super::local_logs::{DiagnosticsRedactionContext, redact_diagnostic_text, strip_url_secrets};
use super::telemetry_status::{
    build_time_env, coalesce_env, is_network_telemetry_globally_disabled, resolve_packaging_mode,
    resolve_telemetry_consent,
};

const MAX_BREADCRUMBS: usize = 50;
const MAX_RECENT_REPORT_IDS: usize = 10;
const MAX_SCRUB_DEPTH: usize = 4;
const MAX_SCRUB_KEYS: usize = 40;
const MAX_SCRUB_ARRAY_LEN: usize = 20;
const MAX_SCRUB_STRING_LEN: usize = 1024;
const SENTRY_QUEUE_CAPACITY: usize = 32;
const SENTRY_HTTP_TIMEOUT: Duration = Duration::from_secs(3);
const SENTRY_PANIC_FLUSH_TIMEOUT: Duration = Duration::from_secs(2);
const FILTERED_PLACEHOLDER: &str = "[Filtered]";

const SECRET_KEY_TOKENS: &[&str] = &[
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
    "session",
    "jwt",
    "bearer",
    "privatekey",
    "private_key",
    "private-key",
];

const PAYLOAD_KEY_TOKENS: &[&str] = &[
    "prompt",
    "messages",
    "input",
    "output",
    "stdout",
    "stderr",
    "transcript",
    "body",
    "payload",
    "content",
    "contents",
    "raw",
    "patch",
    "diff",
];

const URL_HINT_KEYS: &[&str] = &["url", "uri", "href", "endpoint"];

/// Parsed Sentry DSN target and authentication header.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SentryDsn {
    pub raw: String,
    pub envelope_endpoint: String,
    pub auth_header: String,
    pub project_id: String,
}

/// Parses a Sentry DSN into its envelope endpoint URL and `X-Sentry-Auth` header.
pub fn parse_sentry_dsn(raw: &str, client_header: &str) -> Option<SentryDsn> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let parsed = Url::parse(trimmed).ok()?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return None;
    }
    let public_key = parsed.username().trim();
    if public_key.is_empty() {
        return None;
    }
    let host = parsed.host_str()?;
    let port_part = parsed.port().map(|p| format!(":{p}")).unwrap_or_default();
    let segments: Vec<&str> = parsed
        .path()
        .split('/')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    let project_id = (*segments.last()?).to_string();
    if project_id.is_empty() {
        return None;
    }
    let path_prefix = if segments.len() > 1 {
        format!("/{}", segments[..segments.len() - 1].join("/"))
    } else {
        String::new()
    };
    let envelope_endpoint = format!(
        "{}://{}{}{}/api/{}/envelope/",
        parsed.scheme(),
        host,
        port_part,
        path_prefix,
        project_id
    );
    let auth_header =
        format!("Sentry sentry_version=7, sentry_key={public_key}, sentry_client={client_header}");
    Some(SentryDsn {
        raw: trimmed.to_string(),
        envelope_endpoint,
        auth_header,
        project_id,
    })
}

/// Resolved crash reporting settings for desktop or spawned child servers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CrashReportingConfig {
    pub consent_enabled: bool,
    pub network_telemetry_disabled: bool,
    pub dsn: Option<SentryDsn>,
    pub environment: String,
    pub release: String,
    pub is_packaged: bool,
    pub mode: String,
}

impl CrashReportingConfig {
    /// Returns true when consent is granted, kill switch is inactive, and DSN is valid.
    pub fn is_active(&self) -> bool {
        self.consent_enabled && !self.network_telemetry_disabled && self.dsn.is_some()
    }
}

/// Resolves crash reporting configuration from desktop settings and environment variables.
pub fn resolve_crash_reporting_config(
    settings: &PrivacyTelemetrySettings,
    env: &HashMap<String, String>,
    is_packaged: bool,
    fallback_release: Option<&str>,
) -> CrashReportingConfig {
    let consent = resolve_telemetry_consent(settings, env, is_packaged);
    let mode = resolve_packaging_mode(env, is_packaged);
    let dsn_raw = coalesce_env(env, &["COWORK_SENTRY_DSN", "SENTRY_DSN"])
        .or_else(|| build_time_env(option_env!("COWORK_SENTRY_DSN")));
    let release = coalesce_env(
        env,
        &["COWORK_RELEASE", "SENTRY_RELEASE", "COWORK_APP_VERSION"],
    )
    .or_else(|| {
        fallback_release
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToString::to_string)
    })
    .unwrap_or_else(|| super::resolve_desktop_app_version().to_string());
    let client_header = format!("cowork-desktop/{release}");
    let dsn = dsn_raw
        .as_deref()
        .and_then(|raw| parse_sentry_dsn(raw, &client_header));

    let environment = coalesce_env(env, &["COWORK_SENTRY_ENVIRONMENT", "SENTRY_ENVIRONMENT"])
        .unwrap_or_else(|| {
            if env.get("NODE_ENV").map(|v| v.trim()) == Some("test") {
                "test".to_string()
            } else if is_packaged {
                "packaged".to_string()
            } else {
                "development".to_string()
            }
        });

    CrashReportingConfig {
        consent_enabled: consent.crash_reports_enabled,
        network_telemetry_disabled: consent.network_telemetry_disabled,
        dsn,
        environment,
        release,
        is_packaged,
        mode,
    }
}

/// Builds propagated Sentry environment variables for spawned `cowork-server` processes.
pub fn build_server_crash_reporting_env(
    settings: &PrivacyTelemetrySettings,
    env: &HashMap<String, String>,
    is_packaged: bool,
    fallback_release: Option<&str>,
) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let cfg = resolve_crash_reporting_config(settings, env, is_packaged, fallback_release);
    if !cfg.is_active() {
        out.insert(
            "COWORK_CRASH_REPORTS_ENABLED".to_string(),
            "false".to_string(),
        );
        return out;
    }
    if let Some(ref dsn) = cfg.dsn {
        out.insert(
            "COWORK_CRASH_REPORTS_ENABLED".to_string(),
            "true".to_string(),
        );
        out.insert("COWORK_SENTRY_DSN".to_string(), dsn.raw.clone());
        out.insert("COWORK_RELEASE".to_string(), cfg.release);
        out.insert("COWORK_SENTRY_ENVIRONMENT".to_string(), cfg.environment);
    }
    out
}

fn contains_ascii_ci_token(key: &str, tokens: &[&str]) -> bool {
    let lower = key.to_ascii_lowercase();
    tokens.iter().any(|tok| lower.contains(tok))
}

fn is_sensitive_crash_key(key: &str) -> bool {
    contains_ascii_ci_token(key, SECRET_KEY_TOKENS)
        || contains_ascii_ci_token(key, PAYLOAD_KEY_TOKENS)
}

fn is_url_hint_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    URL_HINT_KEYS.iter().any(|hint| lower.contains(hint))
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let cut = max_chars.saturating_sub(1);
    let prefix: String = text.chars().take(cut).collect();
    format!("{prefix}\u{2026}")
}

fn scrub_string(raw: &str, key_hint: Option<&str>, ctx: &DiagnosticsRedactionContext) -> String {
    let maybe_url_stripped = if key_hint.is_some_and(is_url_hint_key) {
        strip_url_secrets(raw)
    } else {
        raw.to_string()
    };
    let redacted = redact_diagnostic_text(&maybe_url_stripped, ctx);
    truncate_chars(&redacted, MAX_SCRUB_STRING_LEN)
}

fn scrub_value(
    val: Value,
    key_hint: Option<&str>,
    ctx: &DiagnosticsRedactionContext,
    depth: usize,
) -> Value {
    if let Some(key) = key_hint
        && is_sensitive_crash_key(key)
    {
        return Value::String(FILTERED_PLACEHOLDER.to_string());
    }
    match val {
        Value::Null | Value::Bool(_) | Value::Number(_) => val,
        Value::String(s) => Value::String(scrub_string(&s, key_hint, ctx)),
        Value::Array(items) => {
            if depth >= MAX_SCRUB_DEPTH {
                return Value::Array(Vec::new());
            }
            let out = items
                .into_iter()
                .take(MAX_SCRUB_ARRAY_LEN)
                .map(|item| scrub_value(item, None, ctx, depth + 1))
                .collect();
            Value::Array(out)
        }
        Value::Object(map) => {
            if depth >= MAX_SCRUB_DEPTH {
                return Value::Object(Map::new());
            }
            let mut out = Map::new();
            for (k, v) in map.into_iter().take(MAX_SCRUB_KEYS) {
                let scrubbed = scrub_value(v, Some(&k), ctx, depth + 1);
                out.insert(k, scrubbed);
            }
            Value::Object(out)
        }
    }
}

fn scrub_request_object(req: &mut Map<String, Value>, ctx: &DiagnosticsRedactionContext) {
    req.remove("cookies");
    req.remove("data");
    if let Some(Value::String(qs)) = req.remove("query_string")
        && !qs.is_empty()
    {
        req.insert(
            "query_string".to_string(),
            Value::String(FILTERED_PLACEHOLDER.to_string()),
        );
    }
    if let Some(Value::String(url)) = req.get("url").cloned() {
        let safe_url = scrub_string(&url, Some("url"), ctx);
        req.insert("url".to_string(), Value::String(safe_url));
    }
    if let Some(Value::Object(headers)) = req.get_mut("headers") {
        let mut clean_headers = Map::new();
        for (k, v) in std::mem::take(headers) {
            if is_sensitive_crash_key(&k) {
                clean_headers.insert(k, Value::String(FILTERED_PLACEHOLDER.to_string()));
            } else {
                clean_headers.insert(k.clone(), scrub_value(v, Some(&k), ctx, 1));
            }
        }
        *headers = clean_headers;
    }
}

fn scrub_exception_object(exc: &mut Map<String, Value>, ctx: &DiagnosticsRedactionContext) {
    let Some(Value::Array(values)) = exc.get_mut("values") else {
        return;
    };
    for item in values.iter_mut().take(MAX_SCRUB_ARRAY_LEN) {
        let Some(item_obj) = item.as_object_mut() else {
            continue;
        };
        if let Some(Value::String(ty)) = item_obj.get("type").cloned() {
            item_obj.insert(
                "type".to_string(),
                Value::String(scrub_string(&ty, None, ctx)),
            );
        }
        if let Some(Value::String(val)) = item_obj.get("value").cloned() {
            item_obj.insert(
                "value".to_string(),
                Value::String(scrub_string(&val, None, ctx)),
            );
        }
        if let Some(Value::Object(st)) = item_obj.get_mut("stacktrace")
            && let Some(Value::Array(frames)) = st.get_mut("frames")
        {
            for frame in frames.iter_mut() {
                let Some(frame_obj) = frame.as_object_mut() else {
                    continue;
                };
                frame_obj.remove("vars");
                frame_obj.remove("pre_context");
                frame_obj.remove("context_line");
                frame_obj.remove("post_context");
                for path_key in ["abs_path", "filename"] {
                    if let Some(Value::String(p)) = frame_obj.get(path_key).cloned() {
                        frame_obj.insert(
                            path_key.to_string(),
                            Value::String(scrub_string(&p, None, ctx)),
                        );
                    }
                }
            }
        }
    }
}

/// Scrubs a Sentry event JSON object matching `src/telemetry/crashReporting.ts`.
pub fn scrub_sentry_event(mut event: Value, ctx: &DiagnosticsRedactionContext) -> Value {
    let Some(obj) = event.as_object_mut() else {
        return Value::Object(Map::new());
    };
    obj.remove("user");
    obj.remove("server_name");

    if let Some(Value::Object(req)) = obj.get_mut("request") {
        scrub_request_object(req, ctx);
    }
    if let Some(Value::Object(exc)) = obj.get_mut("exception") {
        scrub_exception_object(exc, ctx);
    }
    if let Some(Value::Object(msg)) = obj.get_mut("message")
        && let Some(Value::String(formatted)) = msg.get("formatted").cloned()
    {
        msg.insert(
            "formatted".to_string(),
            Value::String(scrub_string(&formatted, None, ctx)),
        );
    } else if let Some(Value::String(msg)) = obj.get("message").cloned() {
        obj.insert(
            "message".to_string(),
            Value::String(scrub_string(&msg, None, ctx)),
        );
    }

    for section in ["tags", "extra", "contexts"] {
        if let Some(val) = obj.remove(section) {
            obj.insert(section.to_string(), scrub_value(val, None, ctx, 0));
        }
    }
    if let Some(Value::Array(crumbs)) = obj.remove("breadcrumbs") {
        let scrubbed: Vec<Value> = crumbs
            .into_iter()
            .take(MAX_BREADCRUMBS)
            .map(|crumb| scrub_breadcrumb_value(crumb, ctx))
            .collect();
        obj.insert("breadcrumbs".to_string(), Value::Array(scrubbed));
    }

    event
}

fn scrub_breadcrumb_value(crumb: Value, ctx: &DiagnosticsRedactionContext) -> Value {
    let Some(mut map) = crumb.as_object().cloned() else {
        return Value::Object(Map::new());
    };
    for text_key in ["message", "category"] {
        if let Some(Value::String(s)) = map.get(text_key).cloned() {
            map.insert(
                text_key.to_string(),
                Value::String(scrub_string(&s, None, ctx)),
            );
        }
    }
    if let Some(data) = map.remove("data") {
        map.insert("data".to_string(), scrub_value(data, None, ctx, 0));
    }
    Value::Object(map)
}

fn build_envelope_payload(event_id: &str, sent_at: &str, event_json: &Value) -> Option<String> {
    let envelope_header = json!({
        "event_id": event_id,
        "sent_at": sent_at,
    });
    let item_header = json!({
        "type": "event",
        "content_type": "application/json",
    });
    Some(format!(
        "{}\n{}\n{}\n",
        serde_json::to_string(&envelope_header).ok()?,
        serde_json::to_string(&item_header).ok()?,
        serde_json::to_string(event_json).ok()?
    ))
}

enum SentryJob {
    Send {
        endpoint: String,
        auth_header: String,
        envelope: String,
    },
    Flush(oneshot::Sender<()>),
}

fn spawn_sentry_worker(timeout: Duration) -> mpsc::Sender<SentryJob> {
    let (tx, mut rx) = mpsc::channel::<SentryJob>(SENTRY_QUEUE_CAPACITY);
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    let worker = async move {
        while let Some(job) = rx.recv().await {
            match job {
                SentryJob::Send {
                    endpoint,
                    auth_header,
                    envelope,
                } => {
                    let _ = client
                        .post(&endpoint)
                        .header("x-sentry-auth", auth_header)
                        .header("content-type", "application/x-sentry-envelope")
                        .body(envelope)
                        .send()
                        .await;
                }
                SentryJob::Flush(done) => {
                    let _ = done.send(());
                }
            }
        }
    };

    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        handle.spawn(worker);
    } else {
        let _ = std::thread::Builder::new()
            .name("cowork-desktop-sentry".to_string())
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

fn post_envelope_blocking(endpoint: String, auth_header: String, envelope: String) {
    let handle = std::thread::Builder::new()
        .name("cowork-sentry-panic-flush".to_string())
        .spawn(move || {
            let Ok(rt) = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            else {
                return;
            };
            rt.block_on(async move {
                let client = reqwest::Client::builder()
                    .timeout(SENTRY_PANIC_FLUSH_TIMEOUT)
                    .build()
                    .unwrap_or_else(|_| reqwest::Client::new());
                let _ = client
                    .post(&endpoint)
                    .header("x-sentry-auth", auth_header)
                    .header("content-type", "application/x-sentry-envelope")
                    .body(envelope)
                    .send()
                    .await;
            });
        });
    if let Ok(join_handle) = handle {
        let _ = join_handle.join();
    }
}

struct CrashReportingInner {
    config: CrashReportingConfig,
    redaction: DiagnosticsRedactionContext,
    breadcrumbs: VecDeque<Value>,
    recent_report_ids: VecDeque<String>,
    sender: Option<mpsc::Sender<SentryJob>>,
}

/// Manages privacy-scrubbed desktop Sentry reporting, breadcrumbs, and crash IDs.
#[derive(Clone)]
pub struct CrashReportingService {
    inner: Arc<Mutex<CrashReportingInner>>,
}

impl CrashReportingService {
    /// Creates a new crash reporting service using current settings and environment.
    pub fn new(
        is_packaged: bool,
        workspace_paths: Vec<PathBuf>,
        settings: &PrivacyTelemetrySettings,
        env: &HashMap<String, String>,
    ) -> Self {
        let config = resolve_crash_reporting_config(settings, env, is_packaged, None);
        let redaction = DiagnosticsRedactionContext {
            home_dir: dirs::home_dir(),
            workspace_paths,
            max_string_length: Some(MAX_SCRUB_STRING_LEN),
        };
        let sender = if config.is_active() {
            Some(spawn_sentry_worker(SENTRY_HTTP_TIMEOUT))
        } else {
            None
        };
        Self {
            inner: Arc::new(Mutex::new(CrashReportingInner {
                config,
                redaction,
                breadcrumbs: VecDeque::with_capacity(MAX_BREADCRUMBS),
                recent_report_ids: VecDeque::with_capacity(MAX_RECENT_REPORT_IDS),
                sender,
            })),
        }
    }

    /// Re-evaluates consent, DSN config, and workspace path redaction after settings saves.
    pub fn reconfigure(
        &self,
        settings: &PrivacyTelemetrySettings,
        workspace_paths: Vec<PathBuf>,
        env: &HashMap<String, String>,
    ) {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let next_cfg =
            resolve_crash_reporting_config(settings, env, guard.config.is_packaged, None);
        let active = next_cfg.is_active();
        guard.config = next_cfg;
        guard.redaction.workspace_paths = workspace_paths;
        if active && guard.sender.is_none() {
            guard.sender = Some(spawn_sentry_worker(SENTRY_HTTP_TIMEOUT));
        } else if !active {
            guard.sender = None;
        }
    }

    /// Returns whether active crash reporting delivery is currently enabled.
    pub fn is_enabled(&self) -> bool {
        let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard.config.is_active()
    }

    /// Returns a snapshot of recent Sentry event IDs (at most 10, oldest to newest).
    pub fn recent_report_ids(&self) -> Vec<String> {
        let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard.recent_report_ids.iter().cloned().collect()
    }

    /// Records a scrubbed breadcrumb in memory for subsequent crash events.
    pub fn add_breadcrumb(&self, category: &str, level: &str, message: &str, data: Option<Value>) {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if !guard.config.consent_enabled
            || is_network_telemetry_globally_disabled(&cowork_config::env_map_from_process())
        {
            return;
        }
        let mut crumb = json!({
            "timestamp": Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            "type": "default",
            "category": category,
            "level": level,
            "message": message,
        });
        if let Some(extra_data) = data
            && let Some(obj) = crumb.as_object_mut()
        {
            obj.insert("data".to_string(), extra_data);
        }
        let scrubbed = scrub_breadcrumb_value(crumb, &guard.redaction);
        if guard.breadcrumbs.len() == MAX_BREADCRUMBS {
            guard.breadcrumbs.pop_front();
        }
        guard.breadcrumbs.push_back(scrubbed);
    }

    /// Scrubs and asynchronously reports an error event, returning the Sentry event ID if queued.
    pub fn capture_exception(
        &self,
        error_type: &str,
        message: &str,
        tags: BTreeMap<String, String>,
        extra: Option<Value>,
    ) -> Option<String> {
        let (endpoint, auth_header, event_id, envelope) =
            self.prepare_event_envelope("error", Some(error_type), message, tags, extra)?;
        let tx = {
            let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            guard.sender.clone()
        }?;
        if tx
            .try_send(SentryJob::Send {
                endpoint,
                auth_header,
                envelope,
            })
            .is_ok()
        {
            Some(event_id)
        } else {
            None
        }
    }

    /// Scrubs and asynchronously reports a diagnostic message event.
    pub fn capture_message(
        &self,
        level: &str,
        message: &str,
        tags: BTreeMap<String, String>,
    ) -> Option<String> {
        let (endpoint, auth_header, event_id, envelope) =
            self.prepare_event_envelope(level, None, message, tags, None)?;
        let tx = {
            let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            guard.sender.clone()
        }?;
        if tx
            .try_send(SentryJob::Send {
                endpoint,
                auth_header,
                envelope,
            })
            .is_ok()
        {
            Some(event_id)
        } else {
            None
        }
    }

    /// Captures a Rust panic synchronously so the event reaches Sentry before termination.
    pub fn capture_panic_sync(&self, info: &PanicHookInfo<'_>) -> Option<String> {
        let payload = if let Some(s) = info.payload().downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "panic payload non-string".to_string()
        };
        let location = info
            .location()
            .map(|loc| format!("{}:{}:{}", loc.file(), loc.line(), loc.column()));
        let mut extra = Map::new();
        if let Some(loc) = location {
            extra.insert("panicLocation".to_string(), Value::String(loc));
        }
        let mut tags = BTreeMap::new();
        tags.insert("mechanism".to_string(), "panic".to_string());
        let (endpoint, auth_header, event_id, envelope) = self.prepare_event_envelope(
            "fatal",
            Some("RustPanic"),
            &payload,
            tags,
            Some(Value::Object(extra)),
        )?;
        post_envelope_blocking(endpoint, auth_header, envelope);
        Some(event_id)
    }

    /// Installs a one-time chained process panic hook reporting uncaught desktop panics.
    pub fn install_panic_hook(&self) {
        static PANIC_HOOK_ONCE: Once = Once::new();
        let service = self.clone();
        PANIC_HOOK_ONCE.call_once(move || {
            let prev = std::panic::take_hook();
            std::panic::set_hook(Box::new(move |info| {
                let _ = service.capture_panic_sync(info);
                prev(info);
            }));
        });
    }

    /// Waits briefly for pending queued Sentry events to finish HTTP transmission.
    pub async fn flush(&self) {
        let tx = {
            let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            guard.sender.clone()
        };
        let Some(sender) = tx else {
            return;
        };
        let (done_tx, done_rx) = oneshot::channel();
        if sender.send(SentryJob::Flush(done_tx)).await.is_ok() {
            let _ = tokio::time::timeout(SENTRY_HTTP_TIMEOUT, done_rx).await;
        }
    }

    /// Clears the active sender channel without waiting.
    pub fn shutdown(&self) {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard.sender = None;
    }

    fn prepare_event_envelope(
        &self,
        level: &str,
        error_type: Option<&str>,
        message: &str,
        tags: BTreeMap<String, String>,
        extra: Option<Value>,
    ) -> Option<(String, String, String, String)> {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if !guard.config.is_active() {
            return None;
        }
        let dsn = guard.config.dsn.clone()?;
        let event_id = Uuid::new_v4().simple().to_string();
        let sent_at = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

        let mut merged_tags = Map::new();
        merged_tags.insert("component".to_string(), json!("desktop"));
        merged_tags.insert("shell".to_string(), json!("rune"));
        merged_tags.insert("platform".to_string(), json!(std::env::consts::OS));
        merged_tags.insert("arch".to_string(), json!(std::env::consts::ARCH));
        for (k, v) in tags {
            merged_tags.insert(k, Value::String(v));
        }

        let mut raw_event = json!({
            "event_id": event_id,
            "timestamp": sent_at,
            "platform": "other",
            "level": level,
            "environment": guard.config.environment,
            "release": guard.config.release,
            "tags": Value::Object(merged_tags),
            "breadcrumbs": Value::Array(guard.breadcrumbs.iter().cloned().collect()),
        });
        if let Some(obj) = raw_event.as_object_mut() {
            if let Some(ty) = error_type {
                obj.insert(
                    "exception".to_string(),
                    json!({
                        "values": [{
                            "type": ty,
                            "value": message,
                        }]
                    }),
                );
            } else {
                obj.insert("message".to_string(), json!({ "formatted": message }));
            }
            if let Some(extra_val) = extra {
                obj.insert("extra".to_string(), extra_val);
            }
        }

        let scrubbed = scrub_sentry_event(raw_event, &guard.redaction);
        let envelope = build_envelope_payload(&event_id, &sent_at, &scrubbed)?;

        if guard.recent_report_ids.len() == MAX_RECENT_REPORT_IDS {
            guard.recent_report_ids.pop_front();
        }
        guard.recent_report_ids.push_back(event_id.clone());

        Some((dsn.envelope_endpoint, dsn.auth_header, event_id, envelope))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn test_env(dsn: Option<&str>) -> HashMap<String, String> {
        let mut env = HashMap::new();
        if let Some(dsn_val) = dsn {
            env.insert("COWORK_SENTRY_DSN".to_string(), dsn_val.to_string());
        }
        env
    }

    #[test]
    fn parses_sentry_dsn_with_port_and_prefix() {
        let parsed = parse_sentry_dsn(
            "https://pubkey123@sentry.example.com:8443/sub/path/42",
            "cowork-desktop/1.2.3",
        )
        .unwrap();
        assert_eq!(
            parsed.envelope_endpoint,
            "https://sentry.example.com:8443/sub/path/api/42/envelope/"
        );
        assert!(parsed.auth_header.contains("sentry_key=pubkey123"));
        assert!(
            parsed
                .auth_header
                .contains("sentry_client=cowork-desktop/1.2.3")
        );
        assert_eq!(parsed.project_id, "42");

        assert!(parse_sentry_dsn("ftp://key@host/1", "x").is_none());
        assert!(parse_sentry_dsn("https://host/1", "x").is_none());
        assert!(parse_sentry_dsn("https://key@host/", "x").is_none());
    }

    #[test]
    fn scrubs_user_secrets_payloads_and_paths_in_sentry_events() {
        let ctx = DiagnosticsRedactionContext {
            home_dir: Some(PathBuf::from("/Users/alice")),
            workspace_paths: vec![PathBuf::from("/Users/alice/secret-workspace")],
            max_string_length: Some(MAX_SCRUB_STRING_LEN),
        };
        let raw = json!({
            "user": { "email": "alice@example.com" },
            "server_name": "alices-macbook",
            "request": {
                "url": "https://127.0.0.1:7337/ws?coworkBrowserToken=secret123#frag",
                "cookies": "sid=abc",
                "data": "raw body",
                "query_string": "token=xyz",
                "headers": {
                    "Authorization": "Bearer supersecret12345678",
                    "X-Safe": "ok"
                }
            },
            "exception": {
                "values": [{
                    "type": "WsError",
                    "value": "Failed opening /Users/alice/secret-workspace/app.rs token=Bearer abcdef1234567890",
                    "stacktrace": {
                        "frames": [{
                            "abs_path": "/Users/alice/secret-workspace/app.rs",
                            "context_line": "let secret = \"123\";",
                            "vars": { "x": "1" }
                        }]
                    }
                }]
            },
            "extra": {
                "prompt": "my private prompt",
                "apiKey": "sk-12345678901234567890",
                "nested": { "a": { "b": { "c": { "d": { "too_deep": true } } } } }
            }
        });

        let scrubbed = scrub_sentry_event(raw, &ctx);
        assert!(scrubbed.get("user").is_none());
        assert!(scrubbed.get("server_name").is_none());
        assert!(scrubbed["request"].get("cookies").is_none());
        assert!(scrubbed["request"].get("data").is_none());
        assert_eq!(scrubbed["request"]["query_string"], "[Filtered]");
        assert_eq!(scrubbed["request"]["url"], "https://127.0.0.1:7337/ws");
        assert_eq!(
            scrubbed["request"]["headers"]["Authorization"],
            "[Filtered]"
        );
        assert_eq!(scrubbed["request"]["headers"]["X-Safe"], "ok");

        let exc_val = scrubbed["exception"]["values"][0]["value"]
            .as_str()
            .unwrap();
        assert!(!exc_val.contains("/Users/alice"));
        assert!(!exc_val.contains("abcdef1234567890"));
        let frame = &scrubbed["exception"]["values"][0]["stacktrace"]["frames"][0];
        assert!(frame.get("vars").is_none());
        assert!(frame.get("context_line").is_none());
        assert!(!frame["abs_path"].as_str().unwrap().contains("/Users/alice"));

        assert_eq!(scrubbed["extra"]["prompt"], "[Filtered]");
        assert_eq!(scrubbed["extra"]["apiKey"], "[Filtered]");
    }

    #[test]
    fn disabled_or_kill_switched_service_never_opens_network_connections() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let addr = listener.local_addr().unwrap();
        let hits = Arc::new(AtomicUsize::new(0));
        let hits_clone = hits.clone();
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let stop_clone = stop.clone();

        let accept_thread = std::thread::spawn(move || {
            while !stop_clone.load(Ordering::Relaxed) {
                if let Ok((_stream, _)) = listener.accept() {
                    hits_clone.fetch_add(1, Ordering::Relaxed);
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        });

        let dsn = format!("http://testkey@{}/1", addr);
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();

        rt.block_on(async {
            // Opt-out in settings -> suppressed.
            let service = CrashReportingService::new(
                false,
                Vec::new(),
                &PrivacyTelemetrySettings::default(),
                &test_env(Some(&dsn)),
            );
            assert!(!service.is_enabled());
            assert!(
                service
                    .capture_exception("Err", "boom", BTreeMap::new(), None)
                    .is_none()
            );
            service.flush().await;

            // Kill switch overrides opted-in settings.
            let opted_in = PrivacyTelemetrySettings {
                crash_reports_enabled: true,
                ..Default::default()
            };
            let mut env = test_env(Some(&dsn));
            env.insert(
                "COWORK_DISABLE_NETWORK_TELEMETRY".to_string(),
                "1".to_string(),
            );
            let killed = CrashReportingService::new(true, Vec::new(), &opted_in, &env);
            assert!(!killed.is_enabled());
            assert!(
                killed
                    .capture_exception("Err", "boom", BTreeMap::new(), None)
                    .is_none()
            );
            killed.flush().await;
        });

        stop.store(true, Ordering::Relaxed);
        let _ = accept_thread.join();
        assert_eq!(hits.load(Ordering::Relaxed), 0);
        assert_eq!(
            build_server_crash_reporting_env(
                &PrivacyTelemetrySettings {
                    crash_reports_enabled: true,
                    ..Default::default()
                },
                &{
                    let mut e = test_env(Some(&dsn));
                    e.insert(
                        "COWORK_DISABLE_NETWORK_TELEMETRY".to_string(),
                        "1".to_string(),
                    );
                    e
                },
                true,
                Some("0.9.0"),
            )
            .get("COWORK_CRASH_REPORTS_ENABLED")
            .map(String::as_str),
            Some("false")
        );
    }

    #[test]
    fn delivers_envelope_to_mock_sentry_and_caps_recent_report_ids() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let captured = Arc::new(Mutex::new(Vec::<String>::new()));
        let captured_clone = captured.clone();

        let server_thread = std::thread::spawn(move || {
            for stream in listener.incoming().take(12) {
                let mut stream = stream.unwrap();
                let mut buf = [0u8; 8192];
                let n = stream.read(&mut buf).unwrap_or(0);
                let req_text = String::from_utf8_lossy(&buf[..n]).to_string();
                captured_clone.lock().unwrap().push(req_text);
                let _ = stream.write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
                );
            }
        });

        let dsn = format!("http://pubkey@{}/99", addr);
        let settings = PrivacyTelemetrySettings {
            crash_reports_enabled: true,
            ..Default::default()
        };
        let env = test_env(Some(&dsn));

        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let service = CrashReportingService::new(false, Vec::new(), &settings, &env);
            assert!(service.is_enabled());
            service.add_breadcrumb("navigation", "info", "opened thread", None);

            let mut expected_ids = Vec::new();
            for i in 0..12 {
                let id = service
                    .capture_exception("RuntimeError", &format!("boom #{i}"), BTreeMap::new(), None)
                    .unwrap();
                expected_ids.push(id);
            }
            service.flush().await;

            let ids = service.recent_report_ids();
            assert_eq!(ids.len(), MAX_RECENT_REPORT_IDS);
            assert_eq!(ids, expected_ids[2..].to_vec());
        });

        let _ = server_thread.join();
        let reqs = captured.lock().unwrap();
        assert_eq!(reqs.len(), 12);
        let lower = reqs[0].to_ascii_lowercase();
        assert!(lower.contains("post /api/99/envelope/"));
        assert!(lower.contains("x-sentry-auth: sentry sentry_version=7, sentry_key=pubkey"));
        assert!(reqs[0].contains("\"type\":\"event\""));
        assert!(reqs[0].contains("opened thread"));
    }
}
