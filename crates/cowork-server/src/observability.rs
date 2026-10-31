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

const PRODUCT_ANALYTICS_NUMBER_PROPS: &[&str] = &[
    "durationMs",
    "workspaceCount",
    "threadCount",
    "providerCount",
    "mcpServerCount",
    "pluginCount",
    "skillCount",
    "toolCount",
    "attachmentCount",
    "referenceCount",
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
    if next.len() > max_len {
        let keep = max_len.saturating_sub(32);
        let mut end = keep.min(next.len());
        while end > 0 && !next.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}[redacted-long-string:{}]", &next[..end], value.len())
    } else {
        next
    }
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
    let allow_env_opt_in = mode == "local-dev" || mode == "self-hosted";
    let release = clean_env(env, "COWORK_RELEASE").or_else(|| clean_env(env, "LANGFUSE_RELEASE"));

    // 1. Langfuse OTLP AI traces
    let ai_enabled = cfg
        .map(|c| c.observability.provider.eq_ignore_ascii_case("langfuse"))
        .unwrap_or(false)
        || (allow_env_opt_in
            && parse_env_bool(env.get("AGENT_OBSERVABILITY_ENABLED")) == Some(true));
    let allow_payloads = (cfg
        .map(|c| c.observability.record_inputs && c.observability.record_outputs)
        .unwrap_or(false))
        || (allow_env_opt_in
            && (parse_env_bool(env.get("AGENT_OBSERVABILITY_RECORD_PAYLOADS")) == Some(true)
                || (parse_env_bool(env.get("AGENT_OBSERVABILITY_RECORD_INPUTS")) == Some(true)
                    && parse_env_bool(env.get("AGENT_OBSERVABILITY_RECORD_OUTPUTS"))
                        == Some(true))));
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

    // 2. Sentry crash reporting
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
                        .unwrap_or_else(|| "development".to_owned()),
                    release: release.clone(),
                },
            )
    } else {
        None
    };

    // 3. PostHog product analytics
    let product_enabled = allow_env_opt_in
        && parse_env_bool(env.get("COWORK_PRODUCT_ANALYTICS_ENABLED")) == Some(true);
    let posthog = if product_enabled {
        let key = clean_env(env, "COWORK_POSTHOG_KEY");
        let distinct_id = clean_env(env, "COWORK_PRODUCT_ANALYTICS_INSTALLATION_ID");
        let host_raw = clean_env(env, "COWORK_POSTHOG_HOST")
            .unwrap_or_else(|| DEFAULT_POSTHOG_HOST.to_owned());
        match (key, distinct_id, normalize_http_url(&host_raw)) {
            (Some(api_key), Some(distinct_id), Some(host)) => Some(PostHogExporterConfig {
                batch_endpoint: format!("{host}/batch/"),
                api_key,
                distinct_id,
                environment: clean_env(env, "COWORK_PRODUCT_ANALYTICS_ENV")
                    .unwrap_or_else(|| "development".to_owned()),
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
                        let truncated = if scrubbed.len() > MAX_OTEL_ATTR_LEN {
                            format!("{}…", &scrubbed[..MAX_OTEL_ATTR_LEN - 1])
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

pub fn sanitize_product_analytics_event(
    event_name: &str,
    properties: &BTreeMap<String, Value>,
) -> Option<Map<String, Value>> {
    if !PRODUCT_ANALYTICS_EVENT_NAMES.contains(&event_name) {
        return None;
    }
    let r = regexes();
    let mut out = Map::new();
    for (k, v) in properties {
        if v.is_null() {
            out.insert(k.clone(), Value::Null);
            continue;
        }
        if r.secret_key.is_match(k) || r.body_key.is_match(k) {
            return None;
        }
        if PRODUCT_ANALYTICS_BOOL_PROPS.contains(&k.as_str()) {
            let b = v.as_bool()?;
            out.insert(k.clone(), Value::Bool(b));
        } else if PRODUCT_ANALYTICS_NUMBER_PROPS.contains(&k.as_str()) {
            let n = v.as_f64()?;
            if !n.is_finite() {
                return None;
            }
            let clamped = n.max(0.0).round() as u64;
            out.insert(k.clone(), json!(clamped));
        } else if PRODUCT_ANALYTICS_STRING_PROPS.contains(&k.as_str()) {
            let s = v.as_str()?.trim();
            if s.is_empty() {
                continue;
            }
            // Reject any string value carrying credentials, emails, or filesystem paths.
            if redact_sensitive_text(s) != s
                || r.unix_local_path.is_match(s)
                || r.win_local_path.is_match(s)
                || s.starts_with('/')
                || s.starts_with('~')
            {
                return None;
            }
            let limited = if s.len() > 120 { &s[..120] } else { s };
            out.insert(k.clone(), Value::String(limited.to_owned()));
        } else {
            return None;
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
        let Some(mut safe_props) = sanitize_product_analytics_event(event_name, properties) else {
            return;
        };
        safe_props.insert(
            "environment".to_owned(),
            Value::String(cfg.environment.clone()),
        );
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
