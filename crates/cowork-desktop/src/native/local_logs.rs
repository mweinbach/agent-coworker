//! Local diagnostic logging with redaction and bounded rotation matching
//! `apps/desktop/electron/services/localLogs.ts` and `src/diagnostics/redaction.ts`.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::{Result, bail};
use chrono::Utc;
use cowork_config::{ensure_private_dir_sync, harden_private_file_sync, write_text_file_atomic};
use serde_json::{Map, Value, json};
use url::Url;

const MAX_LOG_FILE_BYTES: u64 = 5 * 1024 * 1024;
const MAX_LOG_RECORD_BYTES: usize = 16 * 1024;
const RETAINED_LOG_BYTES: usize = 1024 * 1024;
const DEFAULT_MAX_STRING_LEN: usize = 1024;
const MAX_META_DEPTH: usize = 5;
const MAX_META_KEYS: usize = 60;
const MAX_META_ARRAY_LEN: usize = 30;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum LocalLogFileName {
    DesktopMain,
    Server,
    Renderer,
    Updater,
}

impl LocalLogFileName {
    pub fn file_name(self) -> &'static str {
        match self {
            Self::DesktopMain => "desktop-main.log",
            Self::Server => "server.log",
            Self::Renderer => "renderer.log",
            Self::Updater => "updater.log",
        }
    }

    pub fn parse(raw: &str) -> Result<Self> {
        match raw.trim() {
            "desktop-main.log" => Ok(Self::DesktopMain),
            "server.log" => Ok(Self::Server),
            "renderer.log" => Ok(Self::Renderer),
            "updater.log" => Ok(Self::Updater),
            other => bail!("Unsupported log file: {other}"),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LocalLogLevel {
    Info,
    Warn,
    Error,
}

impl LocalLogLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Info => "info",
            Self::Warn => "warn",
            Self::Error => "error",
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct DiagnosticsRedactionContext {
    pub home_dir: Option<PathBuf>,
    pub workspace_paths: Vec<PathBuf>,
    pub max_string_length: Option<usize>,
}

/// Strips query parameters and URL fragments so auth tokens such as `?coworkBrowserToken=`
/// never enter logs or diagnostics bundles.
pub fn strip_url_secrets(raw_url: &str) -> String {
    if let Ok(mut parsed) = Url::parse(raw_url) {
        parsed.set_query(None);
        parsed.set_fragment(None);
        return parsed.into();
    }
    raw_url
        .split(['?', '#'])
        .next()
        .unwrap_or(raw_url)
        .to_string()
}

fn replace_known_path(mut text: String, path: &Path, replacement: &str) -> String {
    let raw = path.to_string_lossy().trim().to_string();
    if raw.is_empty() {
        return text;
    }
    let variants = [raw.clone(), raw.replace('\\', "/"), raw.replace('/', "\\")];
    for variant in variants {
        if !variant.is_empty() {
            text = text.replace(&variant, replacement);
        }
    }
    text
}

fn is_path_delimiter(ch: char) -> bool {
    ch.is_whitespace() || matches!(ch, '"' | '\'' | '`' | '<' | '>' | '{' | '}' | '[' | ']')
}

fn redact_path_like_spans(input: &str) -> String {
    let unix_prefixes = [
        "/Users/",
        "/home/",
        "/private/",
        "/tmp/",
        "/var/",
        "/Volumes/",
    ];
    let mut out = String::with_capacity(input.len());
    let mut idx = 0;

    while idx < input.len() {
        let rest = &input[idx..];
        let is_file_scheme = rest.starts_with("file://");
        let candidate = if is_file_scheme { &rest[7..] } else { rest };

        let unix_match = unix_prefixes.iter().any(|p| candidate.starts_with(p));
        let win_match = candidate.len() >= 10
            && candidate.as_bytes()[0].is_ascii_alphabetic()
            && candidate.as_bytes()[1] == b':'
            && candidate.as_bytes()[2] == b'\\'
            && (candidate[3..].starts_with("Users\\")
                || candidate[3..].starts_with("ProgramData\\")
                || candidate[3..].starts_with("Temp\\")
                || candidate[3..].starts_with("tmp\\"));

        let prev_ok = idx == 0
            || input[..idx]
                .chars()
                .next_back()
                .is_some_and(|c| !c.is_ascii_alphanumeric() && !matches!(c, '_' | '.' | '-' | ']'));

        if prev_ok && (unix_match || win_match) {
            let mut end = if is_file_scheme { 7 } else { 0 };
            for (rel, ch) in candidate.char_indices() {
                if is_path_delimiter(ch) {
                    break;
                }
                end = (if is_file_scheme { 7 } else { 0 }) + rel + ch.len_utf8();
            }
            out.push_str("[local-path]");
            idx += end.max(1);
            continue;
        }

        if let Some(ch) = rest.chars().next() {
            out.push(ch);
            idx += ch.len_utf8();
        } else {
            break;
        }
    }

    out
}

fn redact_username_tokens(input: &str, home_dir: Option<&Path>) -> String {
    let Some(home) = home_dir else {
        return input.to_string();
    };
    let Some(username) = home.file_name().and_then(|s| s.to_str()) else {
        return input.to_string();
    };
    if username.len() < 3 {
        return input.to_string();
    }
    let bytes = input.as_bytes();
    let ubytes = username.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i..].starts_with(ubytes) {
            let left_ok = i == 0 || (!bytes[i - 1].is_ascii_alphanumeric() && bytes[i - 1] != b'_');
            let right_idx = i + ubytes.len();
            let right_ok = right_idx == bytes.len()
                || (!bytes[right_idx].is_ascii_alphanumeric() && bytes[right_idx] != b'_');
            if left_ok && right_ok {
                out.push_str("[local-user]");
                i = right_idx;
                continue;
            }
        }
        let ch = input[i..].chars().next().unwrap_or('\0');
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn redact_token_patterns(input: &str) -> String {
    let mut out = input.to_string();

    // Redact URL query tokens (`?coworkBrowserToken=...`, `?token=...`, `&token=...`).
    for needle in [
        "coworkBrowserToken=",
        "access_token=",
        "refresh_token=",
        "id_token=",
        "?token=",
        "&token=",
        "api_key=",
        "apiKey=",
        "secret=",
    ] {
        out = redact_assignment_values(&out, needle);
    }

    // Redact common bearer / provider secret prefixes.
    for prefix in ["Bearer ", "sk-", "AIza", "xoxb-", "ghp_", "gho_"] {
        out = redact_prefixed_tokens(&out, prefix);
    }

    out
}

fn redact_assignment_values(input: &str, needle: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(pos) = rest.find(needle) {
        let prefix_end = pos + needle.len();
        out.push_str(&rest[..prefix_end]);
        out.push_str("[redacted]");
        let after = &rest[prefix_end..];
        let skip = after
            .find(|c: char| is_path_delimiter(c) || c == '&' || c == '#')
            .unwrap_or(after.len());
        rest = &after[skip..];
    }
    out.push_str(rest);
    out
}

fn redact_prefixed_tokens(input: &str, prefix: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(pos) = rest.find(prefix) {
        out.push_str(&rest[..pos]);
        out.push_str(prefix);
        let after = &rest[pos + prefix.len()..];
        let token_len = after
            .find(|c: char| is_path_delimiter(c) || matches!(c, ',' | ';' | '&' | '='))
            .unwrap_or(after.len());
        if token_len >= 8 {
            out.push_str("[redacted]");
            rest = &after[token_len..];
        } else {
            rest = after;
        }
    }
    out.push_str(rest);
    out
}

fn truncate_long_string(value: &str, max_len: usize) -> String {
    if value.chars().count() <= max_len {
        return value.to_string();
    }
    let keep = max_len.saturating_sub(32);
    let prefix: String = value.chars().take(keep).collect();
    format!("{prefix}[redacted-long-string:{}]", value.len())
}

/// Redacts local paths, usernames, auth tokens, and excessive lengths from diagnostic text.
pub fn redact_diagnostic_text(value: &str, context: &DiagnosticsRedactionContext) -> String {
    let home = context.home_dir.clone().or_else(dirs::home_dir);
    let max_len = context.max_string_length.unwrap_or(DEFAULT_MAX_STRING_LEN);
    let mut next = value.to_string();

    for ws in &context.workspace_paths {
        next = replace_known_path(next, ws, "[workspace-path]");
    }
    if let Some(ref home_dir) = home {
        next = replace_known_path(next, home_dir, "[home]");
    }
    next = redact_path_like_spans(&next);
    next = redact_username_tokens(&next, home.as_deref());
    next = redact_token_patterns(&next);
    truncate_long_string(&next, max_len)
}

fn is_secret_key(key: &str) -> bool {
    let k = key.to_ascii_lowercase();
    [
        "token",
        "secret",
        "authorization",
        "apikey",
        "api_key",
        "api-key",
        "cookie",
        "password",
        "privatekey",
        "private_key",
        "private-key",
        "credential",
        "sessionid",
        "session_id",
        "session-id",
    ]
    .iter()
    .any(|needle| k.contains(needle))
}

fn is_body_key(key: &str) -> bool {
    let k = key.to_ascii_lowercase();
    matches!(
        k.as_str(),
        "prompt"
            | "completion"
            | "stdout"
            | "stderr"
            | "command"
            | "filecontent"
            | "file_content"
            | "contents"
            | "transcript"
            | "messages"
            | "requestbody"
            | "request_body"
            | "responsebody"
            | "response_body"
            | "body"
            | "formdata"
            | "form_data"
            | "payload"
            | "response"
    )
}

/// Recursively sanitizes structured metadata values before writing logs or diagnostic bundles.
pub fn sanitize_log_meta(value: &Value, context: &DiagnosticsRedactionContext) -> Value {
    sanitize_meta_inner(value, context, 0)
}

fn sanitize_meta_inner(
    value: &Value,
    context: &DiagnosticsRedactionContext,
    depth: usize,
) -> Value {
    if depth >= MAX_META_DEPTH {
        return Value::String("[truncated]".to_string());
    }
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => value.clone(),
        Value::String(s) => Value::String(redact_diagnostic_text(s, context)),
        Value::Array(items) => {
            let mut out: Vec<Value> = items
                .iter()
                .take(MAX_META_ARRAY_LEN)
                .map(|v| sanitize_meta_inner(v, context, depth + 1))
                .collect();
            if items.len() > MAX_META_ARRAY_LEN {
                out.push(Value::String(format!(
                    "[+{} more items]",
                    items.len() - MAX_META_ARRAY_LEN
                )));
            }
            Value::Array(out)
        }
        Value::Object(map) => {
            let mut out = Map::new();
            for (idx, (k, v)) in map.iter().enumerate() {
                if idx >= MAX_META_KEYS {
                    out.insert(
                        "_truncatedKeys".to_string(),
                        json!(map.len() - MAX_META_KEYS),
                    );
                    break;
                }
                if is_secret_key(k) {
                    out.insert(k.clone(), Value::String("[redacted]".to_string()));
                } else if is_body_key(k) {
                    out.insert(k.clone(), Value::String("[omitted]".to_string()));
                } else {
                    out.insert(k.clone(), sanitize_meta_inner(v, context, depth + 1));
                }
            }
            Value::Object(out)
        }
    }
}

#[derive(Debug)]
struct InnerLogger {
    logs_dir: PathBuf,
    workspace_paths: Vec<PathBuf>,
    file_sizes: HashMap<LocalLogFileName, u64>,
}

/// Serialized, redacting local JSONL logger for `desktop-main.log`, `server.log`,
/// `renderer.log`, and `updater.log`.
#[derive(Clone, Debug)]
pub struct LocalLogger {
    inner: Arc<Mutex<InnerLogger>>,
}

impl LocalLogger {
    pub fn new(user_data_dir: &Path) -> Self {
        Self {
            inner: Arc::new(Mutex::new(InnerLogger {
                logs_dir: user_data_dir.join("logs"),
                workspace_paths: Vec::new(),
                file_sizes: HashMap::new(),
            })),
        }
    }

    pub fn logs_dir(&self) -> PathBuf {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .logs_dir
            .clone()
    }

    pub fn log_path(&self, file_name: LocalLogFileName) -> PathBuf {
        self.logs_dir().join(file_name.file_name())
    }

    pub fn set_workspace_paths(&self, paths: Vec<PathBuf>) {
        if let Ok(mut guard) = self.inner.lock() {
            guard.workspace_paths = paths;
        }
    }

    pub fn info(&self, category: &str, message: &str, meta: Option<&Value>) {
        self.write(
            LocalLogFileName::DesktopMain,
            LocalLogLevel::Info,
            category,
            message,
            meta,
        );
    }

    pub fn warn(&self, category: &str, message: &str, meta: Option<&Value>) {
        self.write(
            LocalLogFileName::DesktopMain,
            LocalLogLevel::Warn,
            category,
            message,
            meta,
        );
    }

    pub fn error(&self, category: &str, message: &str, meta: Option<&Value>) {
        self.write(
            LocalLogFileName::DesktopMain,
            LocalLogLevel::Error,
            category,
            message,
            meta,
        );
    }

    pub fn write(
        &self,
        file_name: LocalLogFileName,
        level: LocalLogLevel,
        category: &str,
        message: &str,
        meta: Option<&Value>,
    ) {
        let Ok(mut guard) = self.inner.lock() else {
            return;
        };
        let context = DiagnosticsRedactionContext {
            home_dir: dirs::home_dir(),
            workspace_paths: guard.workspace_paths.clone(),
            max_string_length: Some(DEFAULT_MAX_STRING_LEN),
        };
        let record = build_log_record(level, category, message, meta, &context);
        let log_path = guard.logs_dir.join(file_name.file_name());
        if append_with_rotation(
            &log_path,
            &record,
            guard.file_sizes.get(&file_name).copied(),
        )
        .is_ok()
        {
            if let Ok(meta) = fs::metadata(&log_path) {
                guard.file_sizes.insert(file_name, meta.len());
            }
        } else {
            guard.file_sizes.remove(&file_name);
        }
    }

    /// Reads up to `max_bytes` (capped at `RETAINED_LOG_BYTES`) from the end of a log file.
    pub fn tail(&self, file_name: LocalLogFileName, max_bytes: usize) -> String {
        tail_log(&self.log_path(file_name), max_bytes)
    }

    /// Acquires and releases the internal lock to ensure any in-flight synchronous log writes complete.
    pub fn flush_all(&self) {
        drop(self.inner.lock());
    }
}

fn build_log_record(
    level: LocalLogLevel,
    category: &str,
    message: &str,
    meta: Option<&Value>,
    context: &DiagnosticsRedactionContext,
) -> String {
    let mut obj = Map::new();
    obj.insert("ts".to_string(), Value::String(Utc::now().to_rfc3339()));
    obj.insert(
        "level".to_string(),
        Value::String(level.as_str().to_string()),
    );
    obj.insert(
        "category".to_string(),
        Value::String(redact_diagnostic_text(category, context)),
    );
    obj.insert(
        "message".to_string(),
        Value::String(redact_diagnostic_text(message, context)),
    );
    if let Some(m) = meta {
        obj.insert("meta".to_string(), sanitize_log_meta(m, context));
    }

    let serialized = format!("{}\n", Value::Object(obj.clone()));
    if serialized.len() <= MAX_LOG_RECORD_BYTES {
        return serialized;
    }
    obj.insert("meta".to_string(), json!({ "truncated": true }));
    format!("{}\n", Value::Object(obj))
}

fn append_with_rotation(log_path: &Path, entry: &str, cached_size: Option<u64>) -> Result<()> {
    if let Some(parent) = log_path.parent() {
        ensure_private_dir_sync(parent)?;
    }

    let current_bytes = match cached_size {
        Some(n) => n,
        None => fs::metadata(log_path).map(|m| m.len()).unwrap_or(0),
    };

    if current_bytes + entry.len() as u64 > MAX_LOG_FILE_BYTES {
        let tail = tail_log(log_path, RETAINED_LOG_BYTES);
        let retained = match (tail.find('\n'), tail.rfind('\n')) {
            (Some(first), Some(last)) if first < last => &tail[first + 1..=last],
            _ => "",
        };
        write_text_file_atomic(log_path, retained, Some(0o600))?;
    }

    let mut opts = OpenOptions::new();
    opts.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts.open(log_path)?;
    file.write_all(entry.as_bytes())?;
    harden_private_file_sync(log_path);
    Ok(())
}

/// Reads the trailing up to `min(max_bytes, RETAINED_LOG_BYTES)` UTF-8 bytes of a log file.
pub fn tail_log(path: &Path, max_bytes: usize) -> String {
    let capped = max_bytes.min(RETAINED_LOG_BYTES);
    if capped == 0 {
        return String::new();
    }
    let Ok(mut file) = File::open(path) else {
        return String::new();
    };
    let Ok(meta) = file.metadata() else {
        return String::new();
    };
    if !meta.is_file() {
        return String::new();
    }
    let start = meta.len().saturating_sub(capped as u64);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return String::new();
    }
    let mut buf = Vec::with_capacity((meta.len() - start) as usize);
    if file.read_to_end(&mut buf).is_err() {
        return String::new();
    }
    String::from_utf8_lossy(&buf).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_url_secrets_drops_query_and_fragment() {
        assert_eq!(
            strip_url_secrets("ws://127.0.0.1:41234/ws?coworkBrowserToken=secret123#frag"),
            "ws://127.0.0.1:41234/ws"
        );
    }

    #[test]
    fn redact_diagnostic_text_scrubs_paths_usernames_and_tokens() {
        let ctx = DiagnosticsRedactionContext {
            home_dir: Some(PathBuf::from("/Users/alice")),
            workspace_paths: vec![PathBuf::from("/Users/alice/projects/cowork")],
            max_string_length: Some(512),
        };
        let raw = "Opening /Users/alice/projects/cowork/secret.txt with ws://127.0.0.1/ws?coworkBrowserToken=tok999 and Bearer mysecrettokenvalue and user alice";
        let redacted = redact_diagnostic_text(raw, &ctx);
        assert!(!redacted.contains("alice"));
        assert!(!redacted.contains("tok999"));
        assert!(!redacted.contains("mysecrettokenvalue"));
        assert!(redacted.contains("[workspace-path]"));
        assert!(redacted.contains("[local-user]"));
    }

    #[test]
    fn sanitize_log_meta_masks_secret_keys_and_bodies() {
        let ctx = DiagnosticsRedactionContext::default();
        let meta = json!({
            "apiKey": "sk-1234567890",
            "prompt": "do something",
            "nested": {
                "safe": "hello",
                "access_token": "abc"
            }
        });
        let sanitized = sanitize_log_meta(&meta, &ctx);
        assert_eq!(sanitized["apiKey"], "[redacted]");
        assert_eq!(sanitized["prompt"], "[omitted]");
        assert_eq!(sanitized["nested"]["safe"], "hello");
        assert_eq!(sanitized["nested"]["access_token"], "[redacted]");
    }

    #[test]
    fn local_logger_writes_and_tails_without_leaking_secrets() {
        let temp = tempfile::tempdir().unwrap();
        let logger = LocalLogger::new(temp.path());
        logger.set_workspace_paths(vec![temp.path().join("my-repo")]);
        logger.info(
            "server",
            "ready at ws://127.0.0.1:7777/ws?coworkBrowserToken=supersecret",
            Some(&json!({ "browserAccessToken": "supersecret", "port": 7777 })),
        );
        let tail = logger.tail(LocalLogFileName::DesktopMain, 4096);
        assert!(!tail.contains("supersecret"));
        assert!(tail.contains("7777"));
    }
}
