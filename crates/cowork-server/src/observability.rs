//! Credential-redacted daily JSONL server file logs (`<coworkHome>/logs/server-YYYY-MM-DD.log`)
//! and optional non-blocking Langfuse OTLP, Sentry, and PostHog HTTP exporters.

use std::collections::{BTreeMap, HashMap};
use std::fs::{self, OpenOptions};
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use chrono::{NaiveDate, Utc};
use cowork_config::{AgentConfig, ensure_private_dir_sync};
use data_encoding::BASE64;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio::sync::{mpsc, oneshot};
use url::Url;
use uuid::Uuid;

const DEFAULT_RETENTION_DAYS: i64 = 14;
const DEFAULT_MAX_STRING_LENGTH: usize = 1024;
const MAX_OBJECT_DEPTH: usize = 5;
const MAX_OBJECT_KEYS: usize = 60;
const MAX_ARRAY_LENGTH: usize = 30;
const MAX_OTEL_ATTR_LEN: usize = 2048;
/// TS `MAX_STRING_LENGTH`: cap (in UTF-16 code units) for product-analytics
/// string properties, and the longest accepted `model` id.
const PRODUCT_ANALYTICS_MAX_STRING_LEN: usize = 128;
/// TS `MAX_STATUS_LENGTH`: cap (in UTF-16 code units) for `status` and
/// `errorCategory`.
const PRODUCT_ANALYTICS_MAX_STATUS_LEN: usize = 64;
/// TS `MAX_COUNT`: upper clamp for `*Count` properties.
const PRODUCT_ANALYTICS_MAX_COUNT: f64 = 1_000_000.0;
/// TS `MAX_DURATION_MS`: upper clamp for `durationMs` (seven days).
const PRODUCT_ANALYTICS_MAX_DURATION_MS: f64 = 7.0 * 24.0 * 60.0 * 60.0 * 1_000.0;
const TELEMETRY_QUEUE_CAPACITY: usize = 256;
const TELEMETRY_HTTP_TIMEOUT: Duration = Duration::from_secs(3);

const DEFAULT_LANGFUSE_BASE_URL: &str = "https://cloud.langfuse.com";
const DEFAULT_POSTHOG_HOST: &str = "https://us.i.posthog.com";

const PRODUCT_ANALYTICS_EVENT_NAMES: &[&str] = &[
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

/// TS `PRODUCT_ANALYTICS_PROPERTY_NAMES`: every property key an event may
/// carry. Any other key drops the whole event.
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

// =============================================================================
// Redaction Helpers
// =============================================================================

#[derive(Debug, Clone, Default)]
pub struct DiagnosticsRedactionContext {
    pub home_dir: Option<PathBuf>,
    pub workspace_paths: Vec<PathBuf>,
    pub max_string_length: Option<usize>,
}

struct RedactionRegexes {
    email: Regex,
    bearer: Regex,
    assignment_secret: Regex,
    body_assignment: Regex,
    common_secret: Regex,
    credential_url: Regex,
    private_key: Regex,
    secret_key: Regex,
    body_key: Regex,
    json_body_hint: Regex,
    unix_local_path: Regex,
    win_local_path: Regex,
    log_file: Regex,
}

fn regexes() -> &'static RedactionRegexes {
    static REGEXES: OnceLock<RedactionRegexes> = OnceLock::new();
    REGEXES.get_or_init(|| RedactionRegexes {
        email: Regex::new(r"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b").unwrap(),
        bearer: Regex::new(r"(?i)\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}").unwrap(),
        assignment_secret: Regex::new(
            r#"(?i)\b([A-Za-z0-9_.-]*(?:token|secret|api[ _-]?key|apikey|password|authorization|cookie|credential|private[ _-]?key|session[ _-]?id)[A-Za-z0-9_.-]*)\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^"'\s,;}{]{6,})"#,
        )
        .unwrap(),
        body_assignment: Regex::new(
            r"(?im)\b(?:system[_ -]?prompt|prompt|completion|stdout|stderr|command(?:[_ -]?(?:failed|line))?|shell[_ -]?command|file[_ -]?content|contents|transcript|messages|request[_ -]?body|response[_ -]?body|body|form[_ -]?data|payload|response)(?:tail|text|json|data|content|line)?\b\s*[:=]\s*[^\n\r]*",
        )
        .unwrap(),
        common_secret: Regex::new(
            r"\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,})\b",
        )
        .unwrap(),
        credential_url: Regex::new(r"(?i)(\b[a-z][a-z0-9+.-]*://[^:\s/@]+:)[^@\s/]+@").unwrap(),
        private_key: Regex::new(
            r"(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----",
        )
        .unwrap(),
        secret_key: Regex::new(
            r"(?i)(?:token|secret|authorization|api[_-]?key|apikey|cookie|password|private[_-]?key|privatekey|credential|session[_-]?id|refresh[_-]?token|access[_-]?token|id[_-]?token)",
        )
        .unwrap(),
        body_key: Regex::new(
            r"(?i)(?:prompt|completion|stdout|stderr|command|file[_-]?content|contents|transcript|messages|request[_-]?body|response[_-]?body|body|form[_-]?data|payload|response)",
        )
        .unwrap(),
        json_body_hint: Regex::new(
            r#"(?i)"(?:prompt|completion|messages|body|payload|response|token|api[_-]?key|secret)""#,
        )
        .unwrap(),
        unix_local_path: Regex::new(
            r#"(?:file://)?/(?:Users|home|private|tmp|var|Volumes)(?:/[^\s"'`<>{}\[\]]*)?"#,
        )
        .unwrap(),
        win_local_path: Regex::new(
            r#"\b[A-Za-z]:\\(?:Users|Documents and Settings|ProgramData|Temp|tmp)(?:[\\/][^\s"'`<>{}\[\]]*)?"#,
        )
        .unwrap(),
        log_file: Regex::new(r"^server-(\d{4}-\d{2}-\d{2})\.log$").unwrap(),
    })
}

pub fn redact_credential_text(value: &str) -> String {
    let r = regexes();
    let s = r.private_key.replace_all(value, "[redacted-secret]");
    let s = r.bearer.replace_all(&s, "$1 [redacted]");
    let s = r.assignment_secret.replace_all(&s, "$1=[redacted]");
    let s = r.credential_url.replace_all(&s, "${1}[redacted]@");
    r.common_secret
        .replace_all(&s, "[redacted-secret]")
        .into_owned()
}

pub fn redact_sensitive_text(value: &str) -> String {
    let r = regexes();
    let cred = redact_credential_text(value);
    let no_email = r.email.replace_all(&cred, "[redacted-email]");
    let redacted = r
        .body_assignment
        .replace_all(&no_email, "[redacted-body]")
        .into_owned();
    let trimmed = redacted.trim();
    if trimmed.len() >= 24
        && (trimmed.starts_with('{') || trimmed.starts_with('['))
        && r.json_body_hint.is_match(trimmed)
    {
        "[redacted-json-body]".to_owned()
    } else {
        redacted
    }
}

fn replace_known_path(value: &str, known: &Path, replacement: &str) -> String {
    let raw = known.to_string_lossy();
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return value.to_owned();
    }
    let mut variants = vec![
        trimmed.to_owned(),
        trimmed.replace('\\', "/"),
        trimmed.replace('/', "\\"),
    ];
    variants.sort_by_key(|a| std::cmp::Reverse(a.len()));
    variants.dedup();
    let mut next = value.to_owned();
    for v in variants {
        if !v.is_empty() {
            next = next.replace(&v, replacement);
        }
    }
    next
}

pub fn redact_diagnostic_text(value: &str, ctx: &DiagnosticsRedactionContext) -> String {
    let r = regexes();
    let max_len = ctx.max_string_length.unwrap_or(DEFAULT_MAX_STRING_LENGTH);
    let mut next = value.to_owned();

    for wp in &ctx.workspace_paths {
        next = replace_known_path(&next, wp, "[workspace-path]");
    }
    if let Some(ref home) = ctx.home_dir {
        next = replace_known_path(&next, home, "[home]");
    }

    next = r
        .unix_local_path
        .replace_all(&next, "[local-path]")
        .into_owned();
    next = r
        .win_local_path
        .replace_all(&next, "[local-path]")
        .into_owned();

    if let Some(username) = ctx
        .home_dir
        .as_ref()
        .and_then(|h| h.file_name())
        .map(|u| u.to_string_lossy().into_owned())
        .filter(|u| u.len() >= 3)
        && let Ok(user_re) = Regex::new(&format!(r"\b{}\b", regex::escape(&username)))
    {
        next = user_re.replace_all(&next, "[local-user]").into_owned();
    }

    next = redact_sensitive_text(&next);
    let next_len = utf16_len(&next);
    if next_len > max_len {
        let kept = truncate_utf16_prefix(&next, max_len.saturating_sub(32));
        format!("{kept}[redacted-long-string:{next_len}]")
    } else {
        next
    }
}

/// Length of `s` in UTF-16 code units, i.e. the JS `string.length` the TS
/// reference measured telemetry limits in.
fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// Longest prefix of `s` that is at most `max_units` UTF-16 code units long.
///
/// Mirrors JS `value.slice(0, max_units)` but always cuts on a `char`
/// boundary: a character that would straddle the limit (including a
/// surrogate pair such as an emoji) is dropped whole instead of split. It
/// never panics, whatever the input, so telemetry sanitizers built on it
/// cannot unwind into their callers.
fn truncate_utf16_prefix(s: &str, max_units: usize) -> &str {
    let mut units = 0usize;
    for (idx, ch) in s.char_indices() {
        units += ch.len_utf16();
        if units > max_units {
            return &s[..idx];
        }
    }
    s
}

pub fn sanitize_log_meta(meta: &Value, ctx: &DiagnosticsRedactionContext) -> Value {
    sanitize_value_inner(meta, ctx, None, 0)
}

fn sanitize_value_inner(
    value: &Value,
    ctx: &DiagnosticsRedactionContext,
    key: Option<&str>,
    depth: usize,
) -> Value {
    let r = regexes();
    if let Some(k) = key {
        if r.secret_key.is_match(k) {
            return Value::String("[redacted]".to_owned());
        }
        if r.body_key.is_match(k) {
            return Value::String("[redacted-body]".to_owned());
        }
    }
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => value.clone(),
        Value::String(s) => Value::String(redact_diagnostic_text(s, ctx)),
        Value::Array(items) => {
            if depth >= MAX_OBJECT_DEPTH {
                return Value::String("[array]".to_owned());
            }
            Value::Array(
                items
                    .iter()
                    .take(MAX_ARRAY_LENGTH)
                    .map(|item| sanitize_value_inner(item, ctx, None, depth + 1))
                    .collect(),
            )
        }
        Value::Object(map) => {
            if depth >= MAX_OBJECT_DEPTH {
                return Value::String("[object]".to_owned());
            }
            let mut out = Map::new();
            for (k, v) in map.iter().take(MAX_OBJECT_KEYS) {
                let safe_k = redact_diagnostic_text(k, ctx);
                out.insert(safe_k, sanitize_value_inner(v, ctx, Some(k), depth + 1));
            }
            Value::Object(out)
        }
    }
}

// =============================================================================
// Daily Redacted JSONL Server File Log
// =============================================================================

pub fn should_enable_server_file_log(env: &HashMap<String, String>) -> bool {
    let val = env
        .get("COWORK_SERVER_FILE_LOGS")
        .map(|s| s.trim().to_ascii_lowercase());
    !matches!(val.as_deref(), Some("0" | "false"))
}

enum FileLogCommand {
    Append { date_stamp: String, line: String },
    Flush(oneshot::Sender<()>),
}

#[derive(Clone)]
pub struct ServerFileLog {
    logs_dir: PathBuf,
    retention_days: i64,
    tx: mpsc::UnboundedSender<FileLogCommand>,
    sweep_started: std::sync::Arc<AtomicBool>,
}

impl ServerFileLog {
    pub fn new(logs_dir: PathBuf, retention_days: Option<i64>) -> Self {
        let retention = retention_days.unwrap_or(DEFAULT_RETENTION_DAYS).max(1);
        let (tx, mut rx) = mpsc::unbounded_channel::<FileLogCommand>();
        let dir_for_worker = logs_dir.clone();

        let worker_fut = async move {
            while let Some(cmd) = rx.recv().await {
                match cmd {
                    FileLogCommand::Append { date_stamp, line } => {
                        let dir = dir_for_worker.clone();
                        let _ = tokio::task::spawn_blocking(move || {
                            append_jsonl_line_sync(&dir, &date_stamp, &line);
                        })
                        .await;
                    }
                    FileLogCommand::Flush(done) => {
                        let _ = done.send(());
                    }
                }
            }
        };

        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(worker_fut);
        } else {
            let _ = std::thread::Builder::new()
                .name("cowork-file-log-worker".to_owned())
                .spawn(move || {
                    if let Ok(rt) = tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                    {
                        rt.block_on(worker_fut);
                    }
                });
        }

        Self {
            logs_dir,
            retention_days: retention,
            tx,
            sweep_started: std::sync::Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn logs_dir(&self) -> &Path {
        &self.logs_dir
    }

    pub fn append_log(&self, session_id: &str, line: &str, ctx: &DiagnosticsRedactionContext) {
        let now = Utc::now();
        let ts = now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let date_stamp = now.format("%Y-%m-%d").to_string();
        let payload = json!({
            "ts": ts,
            "sessionId": session_id,
            "kind": "log",
            "line": redact_diagnostic_text(line, ctx),
        });
        self.enqueue(date_stamp, payload);
    }

    pub fn append_error(
        &self,
        session_id: &str,
        message: &str,
        code: Option<&str>,
        source: Option<&str>,
        ctx: &DiagnosticsRedactionContext,
    ) {
        let now = Utc::now();
        let ts = now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let date_stamp = now.format("%Y-%m-%d").to_string();
        let mut obj = Map::new();
        obj.insert("ts".to_owned(), Value::String(ts));
        obj.insert("sessionId".to_owned(), Value::String(session_id.to_owned()));
        obj.insert("kind".to_owned(), Value::String("error".to_owned()));
        obj.insert(
            "message".to_owned(),
            Value::String(redact_diagnostic_text(message, ctx)),
        );
        if let Some(c) = code {
            obj.insert("code".to_owned(), Value::String(c.to_owned()));
        }
        if let Some(s) = source {
            obj.insert("source".to_owned(), Value::String(s.to_owned()));
        }
        self.enqueue(date_stamp, Value::Object(obj));
    }

    pub fn append_event(
        &self,
        level: &str,
        event: &str,
        session_id: Option<&str>,
        meta: Option<&Value>,
        ctx: &DiagnosticsRedactionContext,
    ) {
        let now = Utc::now();
        let ts = now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let date_stamp = now.format("%Y-%m-%d").to_string();
        let mut obj = Map::new();
        obj.insert("ts".to_owned(), Value::String(ts));
        obj.insert("level".to_owned(), Value::String(level.to_owned()));
        obj.insert("event".to_owned(), Value::String(event.to_owned()));
        if let Some(sid) = session_id {
            obj.insert("sessionId".to_owned(), Value::String(sid.to_owned()));
        }
        if let Some(m) = meta
            && let Value::Object(redacted) = sanitize_log_meta(m, ctx)
        {
            for (k, v) in redacted {
                if !matches!(k.as_str(), "ts" | "level" | "event" | "sessionId") {
                    obj.insert(k, v);
                }
            }
        }
        self.enqueue(date_stamp, Value::Object(obj));
    }

    fn enqueue(&self, date_stamp: String, payload: Value) {
        if let Ok(mut serialized) = serde_json::to_string(&payload) {
            serialized.push('\n');
            let _ = self.tx.send(FileLogCommand::Append {
                date_stamp,
                line: serialized,
            });
        }
        if !self.sweep_started.swap(true, Ordering::SeqCst) {
            let dir = self.logs_dir.clone();
            let retention_days = self.retention_days;
            tokio::task::spawn_blocking(move || {
                sweep_expired_logs_sync(&dir, retention_days);
            });
        }
    }

    pub async fn flush(&self) {
        let (tx, rx) = oneshot::channel();
        if self.tx.send(FileLogCommand::Flush(tx)).is_ok() {
            let _ = tokio::time::timeout(Duration::from_secs(2), rx).await;
        }
    }
}

fn append_jsonl_line_sync(logs_dir: &Path, date_stamp: &str, line: &str) {
    if ensure_private_dir_sync(logs_dir).is_err() {
        return;
    }
    let log_path = logs_dir.join(format!("server-{date_stamp}.log"));
    let mut opts = OpenOptions::new();
    opts.create(true).append(true);
    #[cfg(unix)]
    {
        opts.mode(0o600);
    }
    if let Ok(mut file) = opts.open(&log_path) {
        #[cfg(unix)]
        {
            let _ = fs::set_permissions(&log_path, fs::Permissions::from_mode(0o600));
        }
        let _ = file.write_all(line.as_bytes());
    }
}

pub fn sweep_expired_logs_sync(logs_dir: &Path, retention_days: i64) {
    let Ok(rd) = fs::read_dir(logs_dir) else {
        return;
    };
    let cutoff = Utc::now().date_naive() - chrono::Duration::days(retention_days.max(1));
    let log_re = &regexes().log_file;
    for entry in rd.flatten() {
        let file_name = entry.file_name().to_string_lossy().into_owned();
        let Some(caps) = log_re.captures(&file_name) else {
            continue;
        };
        let Some(date_str) = caps.get(1).map(|m| m.as_str()) else {
            continue;
        };
        if let Ok(file_date) = NaiveDate::parse_from_str(date_str, "%Y-%m-%d")
            && file_date < cutoff
        {
            let _ = fs::remove_file(entry.path());
        }
    }
}

// =============================================================================
// Optional Non-Blocking Telemetry Exporters (Langfuse OTLP / Sentry / PostHog)
// =============================================================================

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LangfuseExporterConfig {
    pub traces_endpoint: String,
    pub basic_auth_header: String,
    pub environment: String,
    pub release: Option<String>,
    pub allow_payload_attributes: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SentryExporterConfig {
    pub envelope_endpoint: String,
    pub sentry_auth_header: String,
    pub environment: String,
    pub release: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PostHogExporterConfig {
    pub batch_endpoint: String,
    pub api_key: String,
    pub distinct_id: String,
    pub environment: String,
    pub app_version: Option<String>,
    pub platform: Option<String>,
    pub arch: Option<String>,
    pub packaged: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ResolvedServerTelemetryExporters {
    pub network_telemetry_disabled: bool,
    pub langfuse: Option<LangfuseExporterConfig>,
    pub sentry: Option<SentryExporterConfig>,
    pub posthog: Option<PostHogExporterConfig>,
}

impl ResolvedServerTelemetryExporters {
    pub fn is_inert(&self) -> bool {
        self.network_telemetry_disabled
            || (self.langfuse.is_none() && self.sentry.is_none() && self.posthog.is_none())
    }
}

fn parse_env_bool(raw: Option<&String>) -> Option<bool> {
    let trimmed = raw?.trim().to_ascii_lowercase();
    match trimmed.as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

fn clean_env(env: &HashMap<String, String>, key: &str) -> Option<String> {
    env.get(key)
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
}

fn normalize_http_url(raw: &str) -> Option<String> {
    let parsed = Url::parse(raw.trim()).ok()?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return None;
    }
    Some(parsed.as_str().trim_end_matches('/').to_owned())
}

pub fn parse_sentry_dsn(raw: &str) -> Option<(String, String)> {
    let parsed = Url::parse(raw.trim()).ok()?;
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
    let project_id = *segments.last()?;
    if project_id.is_empty() {
        return None;
    }
    let path_prefix = if segments.len() > 1 {
        format!("/{}", segments[..segments.len() - 1].join("/"))
    } else {
        String::new()
    };
    let endpoint = format!(
        "{}://{}{}{}/api/{}/envelope/",
        parsed.scheme(),
        host,
        port_part,
        path_prefix,
        project_id
    );
    let auth = format!(
        "Sentry sentry_version=7, sentry_key={public_key}, sentry_client=cowork-server/0.1.0"
    );
    Some((endpoint, auth))
}

fn normalize_posthog_environment_value(raw: &str, packaged: bool) -> String {
    let lower = raw.trim().to_ascii_lowercase();
    match lower.as_str() {
        "development" | "packaged" | "beta" | "production" | "test" => lower,
        _ => {
            if packaged {
                "packaged".to_owned()
            } else {
                "development".to_owned()
            }
        }
    }
}

/// TS `SAFE_ANONYMOUS_ID_PATTERN` (`/^[A-Za-z0-9_-]{16,128}$/`): an
/// installation id outside this shape disables product analytics (every
/// event is dropped) rather than being sent as the PostHog `distinct_id`.
/// The desktop generates `anon_<uuid-without-dashes>` (37 chars), which
/// always matches.
fn is_safe_anonymous_id(id: &str) -> bool {
    (16..=128).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn resolve_posthog_environment(env: &HashMap<String, String>, packaged: bool) -> String {
    if let Some(explicit) = clean_env(env, "COWORK_POSTHOG_ENVIRONMENT")
        .or_else(|| clean_env(env, "COWORK_PRODUCT_ANALYTICS_ENV"))
    {
        return normalize_posthog_environment_value(&explicit, packaged);
    }
    if let Some(node_env) = clean_env(env, "NODE_ENV") {
        if node_env == "test" {
            return "test".to_owned();
        }
        if node_env == "production" {
            return "production".to_owned();
        }
    }
    if packaged {
        "packaged".to_owned()
    } else {
        "development".to_owned()
    }
}

pub fn resolve_server_telemetry_exporters(
    env: &HashMap<String, String>,
    cfg: Option<&AgentConfig>,
) -> ResolvedServerTelemetryExporters {
    if parse_env_bool(env.get("COWORK_DISABLE_NETWORK_TELEMETRY")) == Some(true) {
        return ResolvedServerTelemetryExporters {
            network_telemetry_disabled: true,
            ..Default::default()
        };
    }

    let mode = clean_env(env, "COWORK_TELEMETRY_MODE")
        .map(|m| m.to_ascii_lowercase())
        .unwrap_or_else(|| "local-dev".to_owned());
    let is_enterprise_offline = mode == "enterprise/offline";
    let allow_env_opt_in =
        mode == "local-dev" || mode == "self-hosted" || mode == "packaged-public";
    let packaged =
        parse_env_bool(env.get("COWORK_IS_PACKAGED")) == Some(true) || mode == "packaged-public";
    let release = clean_env(env, "COWORK_RELEASE").or_else(|| clean_env(env, "LANGFUSE_RELEASE"));

    // 1. Langfuse OTLP AI traces (gated strictly on `cfg.observability_enabled` / `AGENT_OBSERVABILITY_ENABLED`)
    let ai_enabled = if is_enterprise_offline {
        false
    } else {
        match parse_env_bool(env.get("AGENT_OBSERVABILITY_ENABLED")) {
            Some(false) => false,
            Some(true) => allow_env_opt_in,
            None => cfg
                .map(|c| {
                    c.observability_enabled
                        && c.observability.provider.eq_ignore_ascii_case("langfuse")
                })
                .unwrap_or(false),
        }
    };
    let env_payloads_opt =
        parse_env_bool(env.get("AGENT_OBSERVABILITY_RECORD_PAYLOADS")).or_else(|| {
            match (
                parse_env_bool(env.get("AGENT_OBSERVABILITY_RECORD_INPUTS")),
                parse_env_bool(env.get("AGENT_OBSERVABILITY_RECORD_OUTPUTS")),
            ) {
                (Some(false), _) | (_, Some(false)) => Some(false),
                (Some(true), Some(true)) => Some(true),
                _ => None,
            }
        });
    let allow_payloads = match env_payloads_opt {
        Some(false) => false,
        Some(true) => allow_env_opt_in,
        None => cfg
            .map(|c| c.observability.record_inputs && c.observability.record_outputs)
            .unwrap_or(false),
    };
    let langfuse = if ai_enabled {
        let pk = clean_env(env, "LANGFUSE_PUBLIC_KEY")
            .or_else(|| cfg.and_then(|c| c.observability.public_key.clone()));
        let sk = clean_env(env, "LANGFUSE_SECRET_KEY")
            .or_else(|| cfg.and_then(|c| c.observability.secret_key.clone()));
        let base_raw = clean_env(env, "LANGFUSE_BASE_URL")
            .or_else(|| {
                cfg.and_then(|c| {
                    let trimmed = c.observability.base_url.trim();
                    (!trimmed.is_empty()).then(|| trimmed.to_owned())
                })
            })
            .unwrap_or_else(|| DEFAULT_LANGFUSE_BASE_URL.to_owned());
        match (pk, sk, normalize_http_url(&base_raw)) {
            (Some(public_key), Some(secret_key), Some(base_url)) => {
                let encoded = BASE64.encode(format!("{public_key}:{secret_key}").as_bytes());
                Some(LangfuseExporterConfig {
                    traces_endpoint: format!("{base_url}/api/public/otel/v1/traces"),
                    basic_auth_header: format!("Basic {encoded}"),
                    environment: clean_env(env, "LANGFUSE_TRACING_ENVIRONMENT")
                        .unwrap_or_else(|| "development".to_owned()),
                    release: release.clone(),
                    allow_payload_attributes: allow_payloads,
                })
            }
            _ => None,
        }
    } else {
        None
    };

    // 2. Sentry crash reporting (honors explicit desktop consent in packaged-public, local-dev, and self-hosted)
    let crash_enabled =
        allow_env_opt_in && parse_env_bool(env.get("COWORK_CRASH_REPORTS_ENABLED")) == Some(true);
    let sentry = if crash_enabled {
        clean_env(env, "COWORK_SENTRY_DSN")
            .or_else(|| clean_env(env, "SENTRY_DSN"))
            .and_then(|dsn| parse_sentry_dsn(&dsn))
            .map(
                |(envelope_endpoint, sentry_auth_header)| SentryExporterConfig {
                    envelope_endpoint,
                    sentry_auth_header,
                    environment: clean_env(env, "COWORK_SENTRY_ENVIRONMENT")
                        .or_else(|| clean_env(env, "SENTRY_ENVIRONMENT"))
                        .unwrap_or_else(|| {
                            if packaged {
                                "packaged".to_owned()
                            } else {
                                "development".to_owned()
                            }
                        }),
                    release: release.clone(),
                },
            )
    } else {
        None
    };

    // 3. PostHog product analytics (honors explicit desktop consent in packaged-public, local-dev, and self-hosted)
    let product_enabled = allow_env_opt_in
        && parse_env_bool(env.get("COWORK_PRODUCT_ANALYTICS_ENABLED")) == Some(true);
    let posthog = if product_enabled {
        let key = clean_env(env, "COWORK_POSTHOG_KEY");
        let distinct_id = clean_env(env, "COWORK_PRODUCT_ANALYTICS_INSTALLATION_ID")
            .filter(|id| is_safe_anonymous_id(id));
        let host_raw = clean_env(env, "COWORK_POSTHOG_HOST")
            .unwrap_or_else(|| DEFAULT_POSTHOG_HOST.to_owned());
        match (key, distinct_id, normalize_http_url(&host_raw)) {
            (Some(api_key), Some(distinct_id), Some(host)) => Some(PostHogExporterConfig {
                batch_endpoint: format!("{host}/batch/"),
                api_key,
                distinct_id,
                environment: resolve_posthog_environment(env, packaged),
                app_version: clean_env(env, "COWORK_RELEASE"),
                platform: clean_env(env, "COWORK_PLATFORM"),
                arch: clean_env(env, "COWORK_ARCH"),
                packaged,
            }),
            _ => None,
        }
    } else {
        None
    };

    ResolvedServerTelemetryExporters {
        network_telemetry_disabled: false,
        langfuse,
        sentry,
        posthog,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObservabilitySpanAttribute {
    pub key: String,
    pub value: Value,
}

#[derive(Debug, Clone)]
pub struct ObservabilitySpanInput {
    pub name: String,
    pub status_error: bool,
    pub duration_ms: u64,
    pub attributes: BTreeMap<String, Value>,
}

fn is_secret_otel_key(key: &str) -> bool {
    let lowered = key.to_ascii_lowercase();
    let compact: String = lowered
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    if compact.contains("token")
        && ![
            "access", "auth", "api", "bearer", "cookie", "password", "private", "refresh",
            "secret", "session",
        ]
        .iter()
        .any(|p| compact.contains(p))
    {
        return false;
    }
    [
        "api_key",
        "apikey",
        "secret",
        "token",
        "authorization",
        "cookie",
        "password",
        "privatekey",
        "secretkey",
    ]
    .iter()
    .any(|tok| lowered.contains(tok))
}

fn is_payload_otel_key(key: &str) -> bool {
    let lowered = key.to_ascii_lowercase();
    let compact: String = lowered
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    let safe = [
        "token", "tokens", "cost", "count", "duration", "latency", "attempt", "status", "provider",
        "model", "session", "turn", "run", "step", "id", "bytes", "size",
    ];
    if safe
        .iter()
        .any(|s| lowered.contains(s) || compact.contains(s))
    {
        return false;
    }
    [
        "prompt",
        "input",
        "message",
        "response",
        "output",
        "completion",
        "command",
        "stdout",
        "stderr",
        "path",
        "filepath",
        "filename",
        "transcript",
        "uploaded",
        "log",
        "error",
    ]
    .iter()
    .any(|tok| lowered.contains(tok) || compact.contains(tok))
}

fn build_otlp_trace_payload(
    cfg: &LangfuseExporterConfig,
    span: &ObservabilitySpanInput,
    ctx: &DiagnosticsRedactionContext,
) -> Value {
    let end_ns = Utc::now().timestamp_nanos_opt().unwrap_or(0).max(0) as u64;
    let start_ns = end_ns.saturating_sub(span.duration_ms.saturating_mul(1_000_000));
    let trace_id = Uuid::new_v4().simple().to_string();
    let span_id = Uuid::new_v4().simple().to_string()[..16].to_owned();

    let mut attrs = Vec::new();
    for (k, v) in &span.attributes {
        let otlp_val =
            if is_secret_otel_key(k) || (!cfg.allow_payload_attributes && is_payload_otel_key(k)) {
                json!({ "stringValue": "[REDACTED]" })
            } else {
                match v {
                    Value::Bool(b) => json!({ "boolValue": b }),
                    Value::Number(n) => {
                        if let Some(i) = n.as_i64() {
                            json!({ "intValue": i.to_string() })
                        } else if let Some(f) = n.as_f64() {
                            json!({ "doubleValue": f })
                        } else {
                            continue;
                        }
                    }
                    Value::String(s) => {
                        let scrubbed = if cfg.allow_payload_attributes {
                            redact_credential_text(s)
                        } else {
                            redact_diagnostic_text(s, ctx)
                        };
                        let truncated = if utf16_len(&scrubbed) > MAX_OTEL_ATTR_LEN {
                            format!(
                                "{}…",
                                truncate_utf16_prefix(&scrubbed, MAX_OTEL_ATTR_LEN - 1)
                            )
                        } else {
                            scrubbed
                        };
                        json!({ "stringValue": truncated })
                    }
                    _ => continue,
                }
            };
        attrs.push(json!({ "key": k, "value": otlp_val }));
    }

    let mut resource_attrs = vec![
        json!({ "key": "service.name", "value": { "stringValue": "cowork-server" } }),
        json!({ "key": "deployment.environment", "value": { "stringValue": cfg.environment } }),
    ];
    if let Some(ref rel) = cfg.release {
        resource_attrs.push(json!({
            "key": "service.version",
            "value": { "stringValue": rel }
        }));
    }

    json!({
        "resourceSpans": [{
            "resource": { "attributes": resource_attrs },
            "scopeSpans": [{
                "scope": { "name": "cowork.observability" },
                "spans": [{
                    "traceId": trace_id,
                    "spanId": span_id,
                    "name": span.name,
                    "kind": 1,
                    "startTimeUnixNano": start_ns.to_string(),
                    "endTimeUnixNano": end_ns.to_string(),
                    "attributes": attrs,
                    "status": {
                        "code": if span.status_error { 2 } else { 1 }
                    }
                }]
            }]
        }]
    })
}

fn build_sentry_envelope(
    cfg: &SentryExporterConfig,
    error_type: &str,
    message: &str,
    tags: &BTreeMap<String, String>,
    ctx: &DiagnosticsRedactionContext,
) -> String {
    let event_id = Uuid::new_v4().simple().to_string();
    let sent_at = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let safe_msg = redact_diagnostic_text(message, ctx);
    let mut safe_tags = Map::new();
    safe_tags.insert(
        "component".to_owned(),
        Value::String("cowork-server".to_owned()),
    );
    for (k, v) in tags {
        if !regexes().secret_key.is_match(k) && !regexes().body_key.is_match(k) {
            safe_tags.insert(k.clone(), Value::String(redact_diagnostic_text(v, ctx)));
        }
    }

    let mut event = json!({
        "event_id": event_id,
        "timestamp": sent_at,
        "platform": "other",
        "level": "error",
        "environment": cfg.environment,
        "tags": safe_tags,
        "exception": {
            "values": [{
                "type": redact_diagnostic_text(error_type, ctx),
                "value": safe_msg,
            }]
        }
    });
    if let Some(ref rel) = cfg.release
        && let Some(obj) = event.as_object_mut()
    {
        obj.insert("release".to_owned(), Value::String(rel.clone()));
    }

    let envelope_header = json!({
        "event_id": event_id,
        "sent_at": sent_at,
    });
    let item_header = json!({
        "type": "event",
        "content_type": "application/json",
    });

    format!(
        "{}\n{}\n{}\n",
        serde_json::to_string(&envelope_header).unwrap_or_default(),
        serde_json::to_string(&item_header).unwrap_or_default(),
        serde_json::to_string(&event).unwrap_or_default()
    )
}

// -----------------------------------------------------------------------------
// Product analytics (PostHog) sanitization — port of `sanitizeProductEvent` in
// the TS `src/telemetry/productAnalytics.ts`.
//
// JS regexes without the `u` flag treat `\w`, `\b` and `[A-Z]` under `i` as
// ASCII-only, while `\s` is the ECMAScript WhiteSpace/LineTerminator set. The
// Rust translations below therefore spell out ASCII classes, scope the `i`
// flag to ASCII (`(?i-u:..)`), use ASCII word boundaries (`(?-u:\b)`), and use
// an explicit class for JS `\s` (Rust's Unicode `\s` adds U+0085 and lacks
// U+FEFF).
// -----------------------------------------------------------------------------

/// The ECMAScript `\s` set (WhiteSpace + LineTerminator), as regex class items.
const JS_WS_CLASS: &str = r"\t\n\x0B\x0C\r\x20\x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";

struct ProductAnalyticsPatterns {
    /// TS `SENSITIVE_KEY_PATTERN`.
    sensitive_key: Regex,
    /// TS `EMAIL_PATTERN`.
    email: Regex,
    /// TS `URL_PATTERN`.
    url: Regex,
    /// TS `SECRET_VALUE_PATTERN`.
    secret_value: Regex,
    /// TS `ABSOLUTE_POSIX_PATH_PATTERN`.
    absolute_posix_path: Regex,
    /// TS `WINDOWS_PATH_PATTERN`.
    windows_path: Regex,
    /// TS `RELATIVE_PATH_PATTERN`.
    relative_path: Regex,
    /// TS `GENERIC_PATH_WITH_EXTENSION_PATTERN`.
    generic_path_with_extension: Regex,
    /// TS `SAFE_SLUG_PATTERN`.
    safe_slug: Regex,
    /// TS `SAFE_VERSION_PATTERN`.
    safe_version: Regex,
    /// TS `SAFE_MODEL_PATTERN`.
    safe_model: Regex,
}

impl ProductAnalyticsPatterns {
    fn compile() -> Option<Self> {
        let ws = JS_WS_CLASS;
        // `(?:^|[\s"'`])` prefix shared by the path patterns.
        let lead = format!(r#"(?:^|[{ws}"'`])"#);
        // `[^\s"'`<>{}[\]]` path-segment class shared by the path patterns.
        let seg = format!(r#"[^{ws}"'`<>{{}}\[\]]"#);
        Some(Self {
            sensitive_key: Regex::new(
                r"(?i-u:prompt|response|completion|transcript|content|contents|filename|fileName|file[_-]?name|repo|repository|path|command|stdout|stderr|api[_-]?key|apikey|provider[_-]?key|secret|token|email|username|user[_-]?name|machine|hostname)",
            )
            .ok()?,
            email: Regex::new(
                r"(?-u:\b)[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?-u:\b)",
            )
            .ok()?,
            url: Regex::new(r"(?-u:\b)(?i-u:https?|file)://").ok()?,
            secret_value: Regex::new(&format!(
                r"(?-u:\b)(?:(?i-u:sk-[A-Za-z0-9_-]{{16,}}|gh[pousr]_[A-Za-z0-9_]{{20,}}|xox[baprs]-[A-Za-z0-9-]{{16,}})|(?i-u:Bearer)[{ws}]+(?i-u:[A-Za-z0-9._~+/-]{{12,}}))(?-u:\b)"
            ))
            .ok()?,
            absolute_posix_path: Regex::new(&format!(
                r"{lead}/(?i-u:Users|home|tmp|private|var|Volumes|Applications|opt|etc)(?-u:\b)"
            ))
            .ok()?,
            windows_path: Regex::new(&format!(r"{lead}(?:[A-Za-z]:[\\/]|\\\\){seg}*")).ok()?,
            relative_path: Regex::new(&format!(r"{lead}(?:\.{{1,2}}[\\/]|~[\\/])")).ok()?,
            generic_path_with_extension: Regex::new(&format!(
                r"{lead}[A-Za-z0-9_.-]+[\\/]{seg}+\.[A-Za-z0-9]{{1,12}}(?-u:\b)"
            ))
            .ok()?,
            safe_slug: Regex::new(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$").ok()?,
            safe_version: Regex::new(r"^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,127}$").ok()?,
            safe_model: Regex::new(r"^[A-Za-z0-9][A-Za-z0-9_.:@/+ -]{0,127}$").ok()?,
        })
    }

    /// TS `hasSensitiveStringValue`.
    fn has_sensitive_string_value(&self, value: &str) -> bool {
        self.email.is_match(value) || self.url.is_match(value) || self.secret_value.is_match(value)
    }

    /// TS `looksLikePath`.
    fn looks_like_path(&self, value: &str) -> bool {
        self.absolute_posix_path.is_match(value)
            || self.windows_path.is_match(value)
            || self.relative_path.is_match(value)
            || self.generic_path_with_extension.is_match(value)
            || value.contains('\\')
    }

    /// TS `isSafeModelId`.
    fn is_safe_model_id(&self, value: &str) -> bool {
        if utf16_len(value) > PRODUCT_ANALYTICS_MAX_STRING_LEN || !self.safe_model.is_match(value) {
            return false;
        }
        if value.starts_with('.') || value.starts_with('~') || value.contains("..") {
            return false;
        }
        !self.looks_like_local_model_path(value)
    }

    /// TS `looksLikeLocalModelPath`.
    fn looks_like_local_model_path(&self, value: &str) -> bool {
        self.absolute_posix_path.is_match(value)
            || self.windows_path.is_match(value)
            || self.relative_path.is_match(value)
            || self.url.is_match(value)
            || value.contains('\\')
    }

    /// TS `limitString(value, maxLength)` followed by `pattern.test(..)`.
    ///
    /// JS `slice` counts UTF-16 units and can cut a surrogate pair in half,
    /// leaving a lone surrogate that no (ASCII-only) safe pattern accepts. The
    /// char-safe prefix drops that character whole instead, so a split is
    /// reported as a failed match to keep the TS accept/reject outcome.
    fn limit_and_match<'a>(&self, pattern: &Regex, value: &'a str, max: usize) -> Option<&'a str> {
        let limited = truncate_utf16_prefix(value, max);
        let split_surrogate = limited.len() < value.len() && utf16_len(limited) < max;
        (!split_surrogate && pattern.is_match(limited)).then_some(limited)
    }
}

/// Compiled product-analytics patterns, or `None` if any failed to compile —
/// in which case every event is dropped (fail closed) instead of panicking.
fn product_analytics_patterns() -> Option<&'static ProductAnalyticsPatterns> {
    static PATTERNS: OnceLock<Option<ProductAnalyticsPatterns>> = OnceLock::new();
    PATTERNS
        .get_or_init(ProductAnalyticsPatterns::compile)
        .as_ref()
}

/// The ECMAScript WhiteSpace + LineTerminator code points `String.prototype.trim`
/// strips (unlike `char::is_whitespace`, includes U+FEFF and excludes U+0085).
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

/// Port of TS `sanitizeStringProperty`. `Err(())` drops the whole event,
/// `Ok(None)` omits the property (blank after trimming).
fn sanitize_product_string_property(
    p: &ProductAnalyticsPatterns,
    key: &str,
    value: &str,
) -> Result<Option<String>, ()> {
    let trimmed = value.trim_matches(is_js_whitespace);
    if trimmed.is_empty() {
        return Ok(None);
    }
    if p.has_sensitive_string_value(trimmed) {
        return Err(());
    }
    if key == "model" {
        if !p.is_safe_model_id(trimmed) {
            return Err(());
        }
        // `isSafeModelId` already bounds the id to the cap, so this is a no-op
        // kept for parity with `limitString(trimmed, MAX_STRING_LENGTH)`.
        let limited = truncate_utf16_prefix(trimmed, PRODUCT_ANALYTICS_MAX_STRING_LEN);
        return Ok(Some(limited.to_owned()));
    }
    if p.looks_like_path(trimmed) {
        return Err(());
    }
    let (pattern, max) = match key {
        "appVersion" => (&p.safe_version, PRODUCT_ANALYTICS_MAX_STRING_LEN),
        "status" | "errorCategory" => (&p.safe_slug, PRODUCT_ANALYTICS_MAX_STATUS_LEN),
        _ => (&p.safe_slug, PRODUCT_ANALYTICS_MAX_STRING_LEN),
    };
    p.limit_and_match(pattern, trimmed, max)
        .map(|limited| Some(limited.to_owned()))
        .ok_or(())
}

/// Port of TS `sanitizePropertyValue`. `Err(())` drops the whole event,
/// `Ok(None)` omits the property.
fn sanitize_product_property_value(
    p: &ProductAnalyticsPatterns,
    key: &str,
    value: &Value,
) -> Result<Option<Value>, ()> {
    if value.is_null() {
        return Ok(Some(Value::Null));
    }
    if PRODUCT_ANALYTICS_BOOL_PROPS.contains(&key) {
        return value.as_bool().map(|b| Some(Value::Bool(b))).ok_or(());
    }
    // Non-finite inputs are rejected first; `clamp` only panics on bad bounds
    // (ours are constant, ordered and finite) and `as u64` saturates, so the
    // numeric paths cannot panic.
    let finite_number = || value.as_f64().filter(|n| n.is_finite()).ok_or(());
    if key == "durationMs" {
        // JS `Math.round` rounds halves toward +inf and Rust `round` away from
        // zero; they only differ on negative halves, which clamp to 0 anyway.
        let n = finite_number()?
            .round()
            .clamp(0.0, PRODUCT_ANALYTICS_MAX_DURATION_MS);
        return Ok(Some(json!(n as u64)));
    }
    if key.ends_with("Count") {
        let n = finite_number()?
            .floor()
            .clamp(0.0, PRODUCT_ANALYTICS_MAX_COUNT);
        return Ok(Some(json!(n as u64)));
    }
    if !PRODUCT_ANALYTICS_STRING_PROPS.contains(&key) {
        return Err(());
    }
    let s = value.as_str().ok_or(())?;
    Ok(sanitize_product_string_property(p, key, s)?.map(Value::String))
}

/// Port of TS `sanitizeProductEvent`: returns the safe property map, or
/// `None` when the event must be dropped (unknown event name, unknown or
/// sensitive key, wrong value type, or a sensitive/invalid string value).
/// Blank strings are omitted; `null` is kept for any allowed key.
pub fn sanitize_product_analytics_event(
    event_name: &str,
    properties: &BTreeMap<String, Value>,
) -> Option<Map<String, Value>> {
    if !PRODUCT_ANALYTICS_EVENT_NAMES.contains(&event_name) {
        return None;
    }
    let p = product_analytics_patterns()?;
    let mut out = Map::new();
    for (k, v) in properties {
        // TS `sanitizePropertyKey`.
        if !PRODUCT_ANALYTICS_PROPERTY_NAMES.contains(&k.as_str()) || p.sensitive_key.is_match(k) {
            return None;
        }
        if let Some(safe) = sanitize_product_property_value(p, k, v).ok()? {
            out.insert(k.clone(), safe);
        }
    }
    out.insert("$process_person_profile".to_owned(), Value::Bool(false));
    Some(out)
}

enum TelemetryCommand {
    Langfuse {
        endpoint: String,
        auth: String,
        body: Value,
    },
    Sentry {
        endpoint: String,
        auth: String,
        envelope: String,
    },
    PostHog {
        endpoint: String,
        body: Value,
    },
    Flush(oneshot::Sender<()>),
}

#[derive(Clone)]
pub struct ServerTelemetry {
    resolved: ResolvedServerTelemetryExporters,
    tx: Option<mpsc::Sender<TelemetryCommand>>,
}

impl ServerTelemetry {
    pub fn new(resolved: ResolvedServerTelemetryExporters) -> Self {
        if resolved.is_inert() {
            return Self { resolved, tx: None };
        }

        let (tx, mut rx) = mpsc::channel::<TelemetryCommand>(TELEMETRY_QUEUE_CAPACITY);
        let client = reqwest::Client::builder()
            .timeout(TELEMETRY_HTTP_TIMEOUT)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());

        let worker_fut = async move {
            while let Some(cmd) = rx.recv().await {
                match cmd {
                    TelemetryCommand::Langfuse {
                        endpoint,
                        auth,
                        body,
                    } => {
                        let _ = client
                            .post(&endpoint)
                            .header("authorization", auth)
                            .header("content-type", "application/json")
                            .json(&body)
                            .send()
                            .await;
                    }
                    TelemetryCommand::Sentry {
                        endpoint,
                        auth,
                        envelope,
                    } => {
                        let _ = client
                            .post(&endpoint)
                            .header("x-sentry-auth", auth)
                            .header("content-type", "application/x-sentry-envelope")
                            .body(envelope)
                            .send()
                            .await;
                    }
                    TelemetryCommand::PostHog { endpoint, body } => {
                        let _ = client
                            .post(&endpoint)
                            .header("content-type", "application/json")
                            .json(&body)
                            .send()
                            .await;
                    }
                    TelemetryCommand::Flush(done) => {
                        let _ = done.send(());
                    }
                }
            }
        };

        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(worker_fut);
        } else {
            let _ = std::thread::Builder::new()
                .name("cowork-telemetry".to_owned())
                .spawn(move || {
                    if let Ok(rt) = tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                    {
                        rt.block_on(worker_fut);
                    }
                });
        }

        Self {
            resolved,
            tx: Some(tx),
        }
    }

    pub fn is_inert(&self) -> bool {
        self.tx.is_none()
    }

    pub fn resolved(&self) -> &ResolvedServerTelemetryExporters {
        &self.resolved
    }

    pub fn emit_span(&self, span: &ObservabilitySpanInput, ctx: &DiagnosticsRedactionContext) {
        let (Some(tx), Some(cfg)) = (&self.tx, &self.resolved.langfuse) else {
            return;
        };
        let body = build_otlp_trace_payload(cfg, span, ctx);
        let _ = tx.try_send(TelemetryCommand::Langfuse {
            endpoint: cfg.traces_endpoint.clone(),
            auth: cfg.basic_auth_header.clone(),
            body,
        });
    }

    pub fn capture_error(
        &self,
        error_type: &str,
        message: &str,
        tags: &BTreeMap<String, String>,
        ctx: &DiagnosticsRedactionContext,
    ) {
        let (Some(tx), Some(cfg)) = (&self.tx, &self.resolved.sentry) else {
            return;
        };
        let envelope = build_sentry_envelope(cfg, error_type, message, tags, ctx);
        let _ = tx.try_send(TelemetryCommand::Sentry {
            endpoint: cfg.envelope_endpoint.clone(),
            auth: cfg.sentry_auth_header.clone(),
            envelope,
        });
    }

    pub fn capture_product_event(&self, event_name: &str, properties: &BTreeMap<String, Value>) {
        let (Some(tx), Some(cfg)) = (&self.tx, &self.resolved.posthog) else {
            return;
        };
        let mut merged = BTreeMap::new();
        if let Some(ref v) = cfg.app_version {
            merged.insert("appVersion".to_owned(), Value::String(v.clone()));
        }
        if let Some(ref p) = cfg.platform {
            merged.insert("platform".to_owned(), Value::String(p.clone()));
        }
        if let Some(ref a) = cfg.arch {
            merged.insert("arch".to_owned(), Value::String(a.clone()));
        }
        merged.insert("packaged".to_owned(), Value::Bool(cfg.packaged));
        merged.insert("eventSource".to_owned(), Value::String("server".to_owned()));
        for (k, v) in properties {
            merged.insert(k.clone(), v.clone());
        }
        let Some(mut safe_props) = sanitize_product_analytics_event(event_name, &merged) else {
            return;
        };
        safe_props.insert(
            "environment".to_owned(),
            Value::String(cfg.environment.clone()),
        );
        safe_props.insert("$geoip_disable".to_owned(), Value::Bool(true));
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let body = json!({
            "api_key": cfg.api_key,
            "sent_at": now,
            "batch": [{
                "event": event_name,
                "distinct_id": cfg.distinct_id,
                "timestamp": now,
                "properties": safe_props,
            }]
        });
        let _ = tx.try_send(TelemetryCommand::PostHog {
            endpoint: cfg.batch_endpoint.clone(),
            body,
        });
    }

    pub async fn flush(&self) {
        let Some(ref tx) = self.tx else {
            return;
        };
        let (done_tx, done_rx) = oneshot::channel();
        if tx.send(TelemetryCommand::Flush(done_tx)).await.is_ok() {
            let _ = tokio::time::timeout(Duration::from_secs(3), done_rx).await;
        }
    }
}

// =============================================================================
// Unified ServerObservability Facade
// =============================================================================

#[derive(Clone)]
pub struct ServerObservability {
    file_log: Option<ServerFileLog>,
    telemetry: ServerTelemetry,
    redaction_ctx: DiagnosticsRedactionContext,
}

impl ServerObservability {
    pub fn new(
        cowork_home: &Path,
        homedir: &Path,
        working_directory: &Path,
        env: &HashMap<String, String>,
        cfg: Option<&AgentConfig>,
    ) -> Self {
        let file_log = should_enable_server_file_log(env)
            .then(|| ServerFileLog::new(cowork_home.join("logs"), None));
        let resolved = resolve_server_telemetry_exporters(env, cfg);
        let telemetry = ServerTelemetry::new(resolved);
        let redaction_ctx = DiagnosticsRedactionContext {
            home_dir: Some(homedir.to_path_buf()),
            workspace_paths: vec![working_directory.to_path_buf()],
            max_string_length: Some(DEFAULT_MAX_STRING_LENGTH),
        };
        Self {
            file_log,
            telemetry,
            redaction_ctx,
        }
    }

    pub fn file_log(&self) -> Option<&ServerFileLog> {
        self.file_log.as_ref()
    }

    pub fn telemetry(&self) -> &ServerTelemetry {
        &self.telemetry
    }

    pub fn redaction_context(&self) -> &DiagnosticsRedactionContext {
        &self.redaction_ctx
    }

    pub fn record_session_log(&self, session_id: &str, line: &str) {
        if let Some(ref fl) = self.file_log {
            fl.append_log(session_id, line, &self.redaction_ctx);
        }
    }

    pub fn record_session_error(
        &self,
        session_id: &str,
        message: &str,
        code: Option<&str>,
        source: Option<&str>,
    ) {
        if let Some(ref fl) = self.file_log {
            fl.append_error(session_id, message, code, source, &self.redaction_ctx);
        }
        let mut tags = BTreeMap::new();
        if let Some(c) = code {
            tags.insert("code".to_owned(), c.to_owned());
        }
        if let Some(s) = source {
            tags.insert("source".to_owned(), s.to_owned());
        }
        self.telemetry
            .capture_error("SessionError", message, &tags, &self.redaction_ctx);
    }

    pub fn record_server_event(
        &self,
        level: &str,
        event: &str,
        session_id: Option<&str>,
        meta: Option<&Value>,
    ) {
        if let Some(ref fl) = self.file_log {
            fl.append_event(level, event, session_id, meta, &self.redaction_ctx);
        }
    }

    pub fn emit_span(&self, span: &ObservabilitySpanInput) {
        self.telemetry.emit_span(span, &self.redaction_ctx);
    }

    pub fn capture_product_event(&self, event_name: &str, properties: &BTreeMap<String, Value>) {
        self.telemetry.capture_product_event(event_name, properties);
    }

    pub async fn flush(&self) {
        if let Some(ref fl) = self.file_log {
            fl.flush().await;
        }
        self.telemetry.flush().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs the sanitizer on a JSON object of properties and returns the
    /// kept properties (minus the constant `$process_person_profile`), or
    /// `None` when the event is dropped: the shape of the TS
    /// `sanitizeProductEvent` result.
    fn sanitize(event: &str, props: Value) -> Option<Value> {
        let props: BTreeMap<String, Value> = props
            .as_object()
            .expect("props object")
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        let mut out = sanitize_product_analytics_event(event, &props)?;
        assert_eq!(
            out.remove("$process_person_profile"),
            Some(Value::Bool(false))
        );
        Some(Value::Object(out))
    }

    fn one(key: &str, value: Value) -> Option<Value> {
        sanitize("turn_completed", json!({ key: value }))
    }

    fn kept(key: &str, value: &str) -> Value {
        json!({ key: value })
    }

    #[test]
    fn truncate_utf16_prefix_keeps_whole_chars_within_the_limit() {
        assert_eq!(truncate_utf16_prefix("", 0), "");
        assert_eq!(truncate_utf16_prefix("abc", 0), "");
        assert_eq!(truncate_utf16_prefix("abc", 3), "abc");
        assert_eq!(truncate_utf16_prefix("abcd", 3), "abc");
        // `é` is one UTF-16 unit (two UTF-8 bytes).
        assert_eq!(truncate_utf16_prefix("aéb", 2), "aé");
        // An emoji is a surrogate pair: it is dropped whole, never split.
        assert_eq!(truncate_utf16_prefix("a😀", 2), "a");
        assert_eq!(truncate_utf16_prefix("a😀", 3), "a😀");
        // CJK is one UTF-16 unit but three UTF-8 bytes.
        assert_eq!(truncate_utf16_prefix("漢字漢字", 3), "漢字漢");
        assert_eq!(utf16_len("a😀漢é"), 5);
    }

    // Golden outputs below were produced by running the TS reference
    // `__internal.sanitizeProductEvent` / `isSafeModelId` / `looksLikePath`
    // (origin/main `src/telemetry/productAnalytics.ts`) under bun.

    #[test]
    fn product_analytics_patterns_compile() {
        assert!(product_analytics_patterns().is_some());
    }

    #[test]
    fn product_analytics_event_and_key_allowlists() {
        assert_eq!(sanitize("nope", json!({})), None);
        assert_eq!(sanitize("turn_started", json!({})), Some(json!({})));
        // Unknown keys drop the event, even with a `null` value.
        assert_eq!(sanitize("turn_started", json!({ "bogus": null })), None);
        assert_eq!(sanitize("turn_started", json!({ "bogus": 1 })), None);
        // `null` is kept for any allowed key.
        assert_eq!(
            sanitize(
                "turn_started",
                json!({ "model": null, "status": null, "packaged": null })
            ),
            Some(json!({ "model": null, "status": null, "packaged": null }))
        );
        // `SENSITIVE_KEY_PATTERN` is applied to keys after the allowlist.
        let p = product_analytics_patterns().expect("patterns");
        // TS quirk kept for parity: `crashReportsEnabled` contains "repo", so
        // it is the one allowlisted key that trips the pattern, and any event
        // carrying it (even as `null`) is dropped.
        for key in PRODUCT_ANALYTICS_PROPERTY_NAMES {
            assert_eq!(
                p.sensitive_key.is_match(key),
                *key == "crashReportsEnabled",
                "{key}"
            );
        }
        assert_eq!(
            sanitize("app_started", json!({ "crashReportsEnabled": true })),
            None
        );
        assert_eq!(
            sanitize("app_started", json!({ "crashReportsEnabled": null })),
            None
        );
        for key in ["userPrompt", "FILE-NAME", "api_key", "hostName", "repoUrl"] {
            assert!(p.sensitive_key.is_match(key), "{key}");
        }
        // Every bool/string key is allowlisted.
        for key in PRODUCT_ANALYTICS_BOOL_PROPS
            .iter()
            .chain(PRODUCT_ANALYTICS_STRING_PROPS)
        {
            assert!(PRODUCT_ANALYTICS_PROPERTY_NAMES.contains(key), "{key}");
        }
    }

    #[test]
    fn product_analytics_booleans_require_bool_values() {
        assert_eq!(one("packaged", json!("true")), None);
        assert_eq!(one("packaged", json!(1)), None);
        assert_eq!(
            sanitize(
                "turn_started",
                json!({ "packaged": true, "mcpEnabled": false })
            ),
            Some(json!({ "packaged": true, "mcpEnabled": false }))
        );
    }

    #[test]
    fn product_analytics_duration_is_rounded_and_clamped_to_seven_days() {
        assert_eq!(
            one("durationMs", json!(12.5)),
            Some(json!({ "durationMs": 13 }))
        );
        assert_eq!(
            one("durationMs", json!(12.4999)),
            Some(json!({ "durationMs": 12 }))
        );
        assert_eq!(
            one("durationMs", json!(-3)),
            Some(json!({ "durationMs": 0 }))
        );
        assert_eq!(
            one("durationMs", json!(1e12)),
            Some(json!({ "durationMs": 604_800_000 }))
        );
        assert_eq!(
            one("durationMs", json!(604_800_000)),
            Some(json!({ "durationMs": 604_800_000 }))
        );
        assert_eq!(one("durationMs", json!("5")), None);
        assert_eq!(
            one("durationMs", json!(u64::MAX)),
            Some(json!({ "durationMs": 604_800_000 }))
        );
        assert_eq!(
            one("durationMs", json!(i64::MIN)),
            Some(json!({ "durationMs": 0 }))
        );
    }

    #[test]
    fn product_analytics_counts_are_floored_and_clamped_to_one_million() {
        assert_eq!(
            one("toolCount", json!(3.9)),
            Some(json!({ "toolCount": 3 }))
        );
        assert_eq!(
            one("toolCount", json!(-1.5)),
            Some(json!({ "toolCount": 0 }))
        );
        assert_eq!(
            one("toolCount", json!(5e6)),
            Some(json!({ "toolCount": 1_000_000 }))
        );
        assert_eq!(
            one("toolCount", json!(1_000_000.7)),
            Some(json!({ "toolCount": 1_000_000 }))
        );
        assert_eq!(one("toolCount", json!(true)), None);
        assert_eq!(
            sanitize(
                "turn_completed",
                json!({ "workspaceCount": 2, "threadCount": 0.2 })
            ),
            Some(json!({ "workspaceCount": 2, "threadCount": 0 }))
        );
    }

    #[test]
    fn product_analytics_strings_are_trimmed_like_js() {
        assert_eq!(
            one("status", json!("  completed  ")),
            Some(kept("status", "completed"))
        );
        assert_eq!(
            one("status", json!("ready\n")),
            Some(kept("status", "ready"))
        );
        // Blank strings omit the property but keep the event.
        assert_eq!(one("status", json!("   ")), Some(json!({})));
        assert_eq!(one("status", json!("")), Some(json!({})));
        // JS `trim` strips U+FEFF but not U+0085 (Rust `str::trim` is the reverse).
        assert_eq!(
            one("status", json!("\u{FEFF}ready\u{FEFF}")),
            Some(kept("status", "ready"))
        );
        assert_eq!(one("status", json!("\u{0085}ready")), None);
        assert_eq!(one("status", json!(5)), None);
    }

    #[test]
    fn product_analytics_status_and_error_category_cap_at_64_units() {
        let s64 = "s".repeat(64);
        assert_eq!(one("status", json!(s64)), Some(kept("status", &s64)));
        // Longer values are truncated to 64, then must match SAFE_SLUG_PATTERN.
        assert_eq!(
            one("status", json!("s".repeat(65))),
            Some(kept("status", &s64))
        );
        assert_eq!(
            one("status", json!("s".repeat(200))),
            Some(kept("status", &s64))
        );
        assert_eq!(
            one("errorCategory", json!("e".repeat(70))),
            Some(kept("errorCategory", &"e".repeat(64)))
        );
        // A surrogate pair split by the JS slice leaves a lone surrogate that
        // fails the pattern: the event is dropped, not shortened.
        assert_eq!(one("status", json!(format!("{}😀", "s".repeat(63)))), None);
        // An emoji wholly past the cut is just truncated away.
        assert_eq!(
            one("status", json!(format!("{s64}😀"))),
            Some(kept("status", &s64))
        );
        // Sensitivity/path checks run on the untruncated value.
        assert_eq!(one("status", json!(format!("{s64} /home/x"))), None);
    }

    #[test]
    fn product_analytics_safe_slug_pattern() {
        assert_eq!(
            one("errorCategory", json!("rate_limit:429.x-y")),
            Some(kept("errorCategory", "rate_limit:429.x-y"))
        );
        for bad in ["-leading", "has space", "a+b", "a@b", "café"] {
            assert_eq!(one("errorCategory", json!(bad)), None, "{bad}");
        }
        assert_eq!(
            one("provider", json!("openai")),
            Some(kept("provider", "openai"))
        );
        assert_eq!(
            one("status", json!("x.json")),
            Some(kept("status", "x.json"))
        );
        assert_eq!(one("provider", json!("C:x")), Some(kept("provider", "C:x")));
        // Non-status strings are cut at 128 but the slug allows only 64.
        let p64 = "p".repeat(64);
        assert_eq!(one("provider", json!(p64)), Some(kept("provider", &p64)));
        assert_eq!(one("provider", json!("p".repeat(65))), None);
        assert_eq!(one("provider", json!("p".repeat(129))), None);
        assert_eq!(
            sanitize(
                "turn_completed",
                json!({ "platform": "darwin", "arch": "arm64", "eventSource": "server" })
            ),
            Some(json!({ "platform": "darwin", "arch": "arm64", "eventSource": "server" }))
        );
        // Path-looking values are rejected before the slug check.
        for bad in ["a/b.txt", "./x", "a\\b"] {
            assert_eq!(one("provider", json!(bad)), None, "{bad}");
        }
    }

    #[test]
    fn product_analytics_safe_version_pattern_and_128_unit_cap() {
        for ok in ["1.2.3", "1.2.3+build.5-beta:1"] {
            assert_eq!(one("appVersion", json!(ok)), Some(kept("appVersion", ok)));
        }
        for bad in ["v1.2.3/x", ".1", "1.2.3 beta"] {
            assert_eq!(one("appVersion", json!(bad)), None, "{bad}");
        }
        let v128 = "1".repeat(128);
        assert_eq!(
            one("appVersion", json!(v128)),
            Some(kept("appVersion", &v128))
        );
        assert_eq!(
            one("appVersion", json!("1".repeat(129))),
            Some(kept("appVersion", &v128))
        );
        // Emoji straddling unit 128 is split by JS -> rejected.
        assert_eq!(
            one("appVersion", json!(format!("{}😀", "1".repeat(127)))),
            None
        );
    }

    #[test]
    fn product_analytics_model_ids_use_safe_model_pattern() {
        for ok in [
            "moonshotai/Kimi-K2.5",
            "anthropic/claude-sonnet-4@20250514",
            "gpt 4o mini",
            "openai/gpt-4.1+fast",
            // The generic path-with-extension check does not apply to models.
            "openai/gpt-4.1.json",
            // `\b` after the directory keyword.
            "m /homestead",
            "m sk-aaaaaaaaaaaaaaa",
            "ghx_aaaaaaaaaaaaaaaaaaaa",
            "bearer  aaaaaaaaaaa",
        ] {
            assert_eq!(one("model", json!(ok)), Some(kept("model", ok)), "{ok}");
        }
        let m128 = "m".repeat(128);
        assert_eq!(one("model", json!(m128)), Some(kept("model", &m128)));
        assert_eq!(
            one("model", json!(format!("  {m128}  "))),
            Some(kept("model", &m128))
        );
        // Over 128 units drops the event (not truncated).
        assert_eq!(one("model", json!("m".repeat(129))), None);
        for bad in [
            "a..b",
            ".hidden",
            "~/models/x",
            "m /home/me/model",
            "m /HOME/me",
            "m C:/models",
            "m ./x",
            "/home/me/x",
            "file://x",
            "m https://x",
            "m HTTPS://x",
            "x@y.io",
            "user@example.com",
            "kimi-k2é",
            "漢漢漢漢漢漢漢漢漢漢",
        ] {
            assert_eq!(one("model", json!(bad)), None, "{bad}");
        }
        let p = product_analytics_patterns().expect("patterns");
        for (value, safe) in [
            ("a b", true),
            ("a\\b", false),
            ("a/b", true),
            ("a//b", true),
            ("a:b", true),
            ("x://y", false),
        ] {
            assert_eq!(p.is_safe_model_id(value), safe, "{value}");
        }
    }

    #[test]
    fn product_analytics_sensitive_values_drop_the_event() {
        for bad in [
            format!("m sk-{}", "a".repeat(16)),
            format!("SK-{}", "a".repeat(16)),
            format!("ghp_{}", "a".repeat(20)),
            format!("xoxb-{}", "a".repeat(16)),
            format!("Bearer {}", "a".repeat(12)),
            format!("bearer\u{3000}{}", "a".repeat(12)),
        ] {
            assert_eq!(one("model", json!(bad)), None, "{bad}");
        }
        let p = product_analytics_patterns().expect("patterns");
        // ASCII-only `i`: the long s / Kelvin sign do not case-fold to ASCII.
        assert!(!p.secret_value.is_match(&format!("ſk-{}", "a".repeat(16))));
        // JS `\s` covers U+3000 but not U+0085.
        assert!(
            p.secret_value
                .is_match(&format!("bearer\u{3000}{}", "a".repeat(12)))
        );
        assert!(
            !p.secret_value
                .is_match(&format!("Bearer\u{0085}{}", "a".repeat(12)))
        );
        assert!(!p.email.is_match("a@b.\u{212A}\u{212A}"));
    }

    #[test]
    fn product_analytics_looks_like_path_matches_ts() {
        let p = product_analytics_patterns().expect("patterns");
        for (value, expected) in [
            ("a/b.txt", true),
            ("a/b", false),
            ("src/x.rs", true),
            ("x .\\y", true),
            ("\\\\server\\share", true),
            ("D:\\x", true),
            ("'/etc/passwd", true),
            ("q\"/var", true),
            ("/varnish", false),
            ("v1.2/x.y", true),
            // JS `\w` is ASCII: `é` breaks the leading segment.
            ("word café/x.y", false),
            // ...and counts as a non-word char for `\b`.
            ("a/b.cé", true),
        ] {
            assert_eq!(p.looks_like_path(value), expected, "{value}");
        }
    }

    #[test]
    fn product_analytics_full_event_passes_through() {
        let props = json!({
            "provider": "openai", "model": "gpt-4o", "status": "completed",
            "durationMs": 10, "toolCount": 2, "packaged": true, "appVersion": "1.0.0",
            "platform": "linux", "arch": "x64", "eventSource": "server"
        });
        assert_eq!(sanitize("turn_completed", props.clone()), Some(props));
        // One bad property drops the whole event.
        assert_eq!(
            sanitize(
                "turn_completed",
                json!({ "provider": "openai", "model": "/home/me/x" })
            ),
            None
        );
    }

    #[test]
    fn product_analytics_never_panics_on_awkward_strings() {
        let inputs = [
            "😀".repeat(100),
            "漢".repeat(200),
            format!("{}é", "a".repeat(127)),
            format!("{}é", "a".repeat(63)),
            "\u{FEFF}".repeat(10),
            "\0".to_owned(),
        ];
        for key in PRODUCT_ANALYTICS_STRING_PROPS {
            for input in &inputs {
                let _ = one(key, json!(input));
            }
        }
    }

    #[test]
    fn redact_diagnostic_text_truncates_multibyte_text_on_char_boundaries() {
        let ctx = DiagnosticsRedactionContext {
            max_string_length: Some(40),
            ..Default::default()
        };
        // 50 CJK chars: keep 40 - 32 = 8 chars; the marker reports the UTF-16
        // length of the redacted text, like the TS `value.length`.
        let out = redact_diagnostic_text(&"漢".repeat(50), &ctx);
        assert_eq!(out, format!("{}[redacted-long-string:50]", "漢".repeat(8)));

        // Emoji straddling the cut is dropped whole.
        let input = format!("{}😀{}", "x".repeat(7), "y".repeat(40));
        let out = redact_diagnostic_text(&input, &ctx);
        assert_eq!(out, format!("{}[redacted-long-string:49]", "x".repeat(7)));

        // Under the limit in UTF-16 units: untouched even though it is longer in bytes.
        let input = "漢".repeat(40);
        assert_eq!(redact_diagnostic_text(&input, &ctx), input);
    }

    #[test]
    fn otel_string_attributes_truncate_on_char_boundaries() {
        let cfg = LangfuseExporterConfig {
            traces_endpoint: "https://example.invalid/v1/traces".to_owned(),
            basic_auth_header: "Basic x".to_owned(),
            environment: "test".to_owned(),
            release: None,
            allow_payload_attributes: true,
        };
        let ctx = DiagnosticsRedactionContext::default();
        let attr_value = |value: String| {
            let span = ObservabilitySpanInput {
                name: "span".to_owned(),
                status_error: false,
                duration_ms: 1,
                attributes: BTreeMap::from([("label".to_owned(), Value::String(value))]),
            };
            let payload = build_otlp_trace_payload(&cfg, &span, &ctx);
            payload["resourceSpans"][0]["scopeSpans"][0]["spans"][0]["attributes"][0]["value"]
                ["stringValue"]
                .as_str()
                .expect("string attribute")
                .to_owned()
        };

        // `é` straddles UTF-8 byte 2047 (the old `&s[..2047]` panicked).
        let out = attr_value(format!("{}é{}", "a".repeat(2046), "b".repeat(10)));
        assert_eq!(out, format!("{}é…", "a".repeat(2046)));

        // Emoji straddling UTF-16 unit 2047 is dropped whole.
        let out = attr_value(format!("{}😀{}", "a".repeat(2046), "b".repeat(10)));
        assert_eq!(out, format!("{}…", "a".repeat(2046)));

        // CJK under the cap in UTF-16 units passes through untouched.
        let cjk = "漢".repeat(MAX_OTEL_ATTR_LEN);
        assert_eq!(attr_value(cjk.clone()), cjk);
        let out = attr_value("漢".repeat(MAX_OTEL_ATTR_LEN + 1));
        assert_eq!(out, format!("{}…", "漢".repeat(MAX_OTEL_ATTR_LEN - 1)));
    }

    #[test]
    fn product_analytics_requires_a_safe_installation_id() {
        let posthog_for = |id: Option<&str>| {
            let mut env = HashMap::from([
                ("COWORK_TELEMETRY_MODE".to_owned(), "local-dev".to_owned()),
                (
                    "COWORK_PRODUCT_ANALYTICS_ENABLED".to_owned(),
                    "1".to_owned(),
                ),
                ("COWORK_POSTHOG_KEY".to_owned(), "phc_test_key".to_owned()),
            ]);
            if let Some(id) = id {
                env.insert(
                    "COWORK_PRODUCT_ANALYTICS_INSTALLATION_ID".to_owned(),
                    id.to_owned(),
                );
            }
            resolve_server_telemetry_exporters(&env, None).posthog
        };

        // Desktop-generated shape: `anon_` + UUID without dashes.
        let generated = "anon_0123456789abcdef0123456789abcdef";
        let cfg = posthog_for(Some(generated)).expect("valid id enables PostHog");
        assert_eq!(cfg.distinct_id, generated);
        // Trimmed like the TS `normalizeEnvValue`.
        let cfg = posthog_for(Some("  abcdefghijklmnop  ")).expect("16 chars is enough");
        assert_eq!(cfg.distinct_id, "abcdefghijklmnop");
        assert!(posthog_for(Some(&"a".repeat(128))).is_some());

        for bad in [
            "inst-test-1",
            "abcdefghijklmno",
            "user@example.com-0123456789",
            "anon 0123456789abcdef",
            "anon.0123456789abcdef",
            "anon_0123456789abcdé",
        ] {
            assert!(posthog_for(Some(bad)).is_none(), "{bad:?} must be rejected");
        }
        assert!(posthog_for(Some(&"a".repeat(129))).is_none());
        assert!(posthog_for(None).is_none());
    }
}
