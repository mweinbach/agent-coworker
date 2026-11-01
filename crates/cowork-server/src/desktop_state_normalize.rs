//! Port of the TypeScript `normalizeState` (origin/main
//! `src/server/webDesktopService.ts`) for the desktop `state.json`.
//!
//! `POST /cowork/desktop/state` and `GET /cowork/desktop/state` both run the
//! payload through [`normalize_state`], exactly like `saveState` / `loadState`
//! in TS: workspace paths are canonicalized, workspaces and threads are
//! deduplicated by id, invalid records are dropped, workspace kinds are
//! normalized, and every top-level field is coerced to its typed default.
//! Unknown fields on workspace and thread records are preserved (TS spreads
//! `...item`); unknown top-level keys are dropped, as in TS.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use cowork_config::{
    ensure_private_dir_sync, get_one_off_chats_root, is_inside, normalize_lexical_path,
};
use serde_json::{Map, Value, json};

use crate::http_desktop::fnv1a32_hex;

pub const DEFAULT_QUICK_CHAT_SHORTCUT_ACCELERATOR: &str = "CommandOrControl+Shift+Space";
const FALLBACK_WORKSPACE_ID_PREFIX: &str = "web";
/// `FEATURE_FLAG_IDS` from origin/main `src/shared/featureFlags.ts`.
const FEATURE_FLAG_IDS: [&str; 8] = [
    "menuBar",
    "remoteAccess",
    "workspacePicker",
    "workspaceLifecycle",
    "openAiNativeConnectors",
    "canvas",
    "tasks",
    "workflows",
];

#[derive(Clone, Copy, PartialEq, Eq)]
enum WorkspaceKind {
    Project,
    OneOffChat,
}

impl WorkspaceKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Project => "project",
            Self::OneOffChat => "oneOffChat",
        }
    }
}

fn as_non_empty_string(value: Option<&Value>) -> Option<String> {
    let trimmed = value?.as_str()?.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

fn is_safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 256
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn as_safe_id(value: Option<&Value>) -> Option<String> {
    as_non_empty_string(value).filter(|s| is_safe_id(s))
}

/// Approximates JS `Date.parse(candidate)` being a finite number: accepts
/// RFC 3339 / ISO 8601 timestamps (with or without zone), bare dates, and
/// RFC 2822 dates.
fn is_parseable_timestamp(candidate: &str) -> bool {
    use chrono::{DateTime, NaiveDate, NaiveDateTime};
    DateTime::parse_from_rfc3339(candidate).is_ok()
        || DateTime::parse_from_rfc2822(candidate).is_ok()
        || NaiveDateTime::parse_from_str(candidate, "%Y-%m-%dT%H:%M:%S%.f").is_ok()
        || NaiveDateTime::parse_from_str(candidate, "%Y-%m-%dT%H:%M").is_ok()
        || NaiveDateTime::parse_from_str(candidate, "%Y-%m-%d %H:%M:%S%.f").is_ok()
        || NaiveDate::parse_from_str(candidate, "%Y-%m-%d").is_ok()
}

fn as_timestamp(value: Option<&Value>) -> Option<String> {
    as_non_empty_string(value).filter(|s| is_parseable_timestamp(s))
}

fn as_boolean(value: Option<&Value>, fallback: bool) -> bool {
    value.and_then(Value::as_bool).unwrap_or(fallback)
}

fn integer_value(n: f64) -> Value {
    if n.abs() <= 9_007_199_254_740_991.0 {
        json!(n as i64)
    } else {
        json!(n)
    }
}

fn as_non_negative_integer(value: Option<&Value>, fallback: i64) -> Value {
    match value.and_then(Value::as_f64) {
        Some(n) if n.is_finite() => integer_value(n.floor().max(0.0)),
        _ => json!(fallback),
    }
}

/// `path.resolve(candidate)`: absolute against the process cwd, lexically normalized.
fn resolve_path(candidate: &str) -> PathBuf {
    let p = Path::new(candidate);
    let abs = if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(p))
            .unwrap_or_else(|_| p.to_path_buf())
    };
    normalize_lexical_path(&abs)
}

/// `isPathInsideOneOffChatsRoot`: canonical containment, root itself included.
fn is_path_inside_one_off_chats_root(target: &Path, homedir: &Path) -> bool {
    is_inside(&get_one_off_chats_root(homedir), target)
}

/// `ensureOneOffChatWorkspacePath`: creates the private directory and returns
/// its real path when it stays under `~/.cowork/chats`.
fn ensure_one_off_chat_workspace_path(resolved: &Path, homedir: &Path) -> Option<PathBuf> {
    if !is_path_inside_one_off_chats_root(resolved, homedir) {
        return None;
    }
    ensure_private_dir_sync(resolved).ok()?;
    let real = std::fs::canonicalize(resolved).ok()?;
    is_path_inside_one_off_chats_root(&real, homedir).then_some(real)
}

/// `resolveWorkspacePath`.
fn resolve_workspace_path(
    value: Option<&Value>,
    kind: WorkspaceKind,
    homedir: &Path,
) -> Option<PathBuf> {
    let candidate = as_non_empty_string(value)?;
    let resolved = resolve_path(&candidate);
    if kind == WorkspaceKind::OneOffChat {
        return ensure_one_off_chat_workspace_path(&resolved, homedir);
    }
    let meta = std::fs::metadata(&resolved).ok()?;
    if !meta.is_dir() {
        return None;
    }
    std::fs::canonicalize(&resolved).ok()
}

/// `normalizeSavedProjectPath`: realpath when available, otherwise the
/// resolved path (unmounted drives must not delete history).
fn normalize_saved_project_path(value: Option<&Value>) -> Option<PathBuf> {
    let candidate = as_non_empty_string(value)?;
    if candidate.contains('\0') {
        return None;
    }
    let resolved = resolve_path(&candidate);
    Some(std::fs::canonicalize(&resolved).unwrap_or(resolved))
}

fn is_fallback_workspace_id(id: Option<&str>) -> bool {
    id.is_some_and(|id| id.starts_with(&format!("{FALLBACK_WORKSPACE_ID_PREFIX}-")))
}

/// `normalizeWorkspaceKindWithSource` (the source is a non-enumerable marker
/// in TS and never reaches `state.json`, so only the kind is returned).
fn normalize_workspace_kind(
    item: &Map<String, Value>,
    id: Option<&str>,
    raw_workspace_path: Option<&str>,
    homedir: &Path,
) -> WorkspaceKind {
    let is_one_off_path = raw_workspace_path
        .is_some_and(|p| is_path_inside_one_off_chats_root(&resolve_path(p), homedir));
    let raw_kind = item.get("workspaceKind").and_then(Value::as_str);
    if raw_kind == Some("project") && is_fallback_workspace_id(id) && is_one_off_path {
        return WorkspaceKind::OneOffChat;
    }
    match raw_kind {
        Some("project") => WorkspaceKind::Project,
        Some("oneOffChat") => WorkspaceKind::OneOffChat,
        _ if is_one_off_path => WorkspaceKind::OneOffChat,
        _ => WorkspaceKind::Project,
    }
}

/// `normalizeQuickChatShortcutAccelerator`.
pub fn normalize_quick_chat_shortcut_accelerator(value: Option<&str>) -> String {
    value
        .and_then(parse_accelerator)
        .unwrap_or_else(|| DEFAULT_QUICK_CHAT_SHORTCUT_ACCELERATOR.to_owned())
}

fn canonical_modifier_token(token: &str) -> Option<&'static str> {
    match token.trim().to_lowercase().as_str() {
        "cmdorctrl" | "commandorcontrol" => Some("CommandOrControl"),
        "ctrl" | "control" => Some("Ctrl"),
        "alt" | "option" => Some("Alt"),
        "shift" => Some("Shift"),
        _ => None,
    }
}

fn canonical_main_key_token(token: &str) -> Option<String> {
    if token == " " {
        return Some("Space".to_owned());
    }
    let trimmed = token.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut chars = trimmed.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        if c.is_ascii_alphabetic() {
            return Some(c.to_ascii_uppercase().to_string());
        }
        if c.is_ascii_digit() {
            return Some(c.to_string());
        }
    }
    let upper = trimmed.to_uppercase();
    if let Some(n) = upper.strip_prefix('F')
        && !n.starts_with('0')
        && n.parse::<u8>().is_ok_and(|n| (1..=24).contains(&n))
        && n.bytes().all(|b| b.is_ascii_digit())
    {
        return Some(upper);
    }
    let special = match trimmed.to_lowercase().as_str() {
        "space" | "spacebar" => "Space",
        "tab" => "Tab",
        "enter" | "return" => "Enter",
        "escape" | "esc" => "Escape",
        "backspace" => "Backspace",
        "delete" | "del" => "Delete",
        "insert" | "ins" => "Insert",
        "home" => "Home",
        "end" => "End",
        "pageup" => "PageUp",
        "pagedown" => "PageDown",
        "up" | "arrowup" => "Up",
        "down" | "arrowdown" => "Down",
        "left" | "arrowleft" => "Left",
        "right" | "arrowright" => "Right",
        "plus" | "+" => "Plus",
        "minus" | "-" => "Minus",
        _ => return None,
    };
    Some(special.to_owned())
}

fn parse_accelerator(value: &str) -> Option<String> {
    let tokens: Vec<&str> = value
        .split('+')
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .collect();
    if tokens.len() < 2 {
        return None;
    }
    let key = canonical_main_key_token(tokens[tokens.len() - 1])?;
    let mut modifiers: Vec<&'static str> = Vec::new();
    for token in &tokens[..tokens.len() - 1] {
        let normalized = canonical_modifier_token(token)?;
        if modifiers.contains(&normalized) {
            return None;
        }
        modifiers.push(normalized);
    }
    if modifiers.is_empty() {
        return None;
    }
    let mut parts: Vec<String> = modifiers.into_iter().map(str::to_owned).collect();
    parts.push(key);
    Some(parts.join("+"))
}

/// `normalizeCloudSyncEndpoint`.
fn normalize_cloud_sync_endpoint(value: Option<&Value>) -> Option<String> {
    let trimmed = value?.as_str()?.trim();
    if trimmed.is_empty() {
        return None;
    }
    let parsed = url::Url::parse(trimmed).ok()?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return None;
    }
    Some(trimmed.trim_end_matches('/').to_owned())
}

/// `normalizeCloudSyncSettings`.
pub fn normalize_cloud_sync_settings(value: Option<&Map<String, Value>>) -> Value {
    let get = |key: &str| value.and_then(|v| v.get(key));
    let mut out = Map::new();
    out.insert(
        "enabled".to_owned(),
        json!(get("enabled") == Some(&Value::Bool(true))),
    );
    out.insert(
        "provider".to_owned(),
        json!(
            if get("provider").and_then(Value::as_str) == Some("custom") {
                "custom"
            } else {
                "none"
            }
        ),
    );
    if let Some(endpoint) = normalize_cloud_sync_endpoint(get("endpoint")) {
        out.insert("endpoint".to_owned(), json!(endpoint));
    }
    out.insert(
        "syncSettings".to_owned(),
        json!(get("syncSettings") != Some(&Value::Bool(false))),
    );
    out.insert(
        "syncWorkspaceMetadata".to_owned(),
        json!(get("syncWorkspaceMetadata") == Some(&Value::Bool(true))),
    );
    out.insert(
        "syncThreads".to_owned(),
        json!(get("syncThreads") == Some(&Value::Bool(true))),
    );
    Value::Object(out)
}

/// `normalizeDesktopFeatureFlagOverrides(...) ?? {}`.
fn normalize_feature_flag_overrides(value: Option<&Value>) -> Value {
    let mut out = Map::new();
    if let Some(source) = value.and_then(Value::as_object) {
        for id in FEATURE_FLAG_IDS {
            if let Some(b) = source.get(id).and_then(Value::as_bool) {
                out.insert(id.to_owned(), json!(b));
            }
        }
    }
    Value::Object(out)
}

/// `defaultState()`.
pub fn default_state() -> Value {
    json!({
        "version": 2,
        "workspaces": [],
        "threads": [],
        "developerMode": false,
        "showHiddenFiles": false,
        "perWorkspaceSettings": false,
        "desktopSettings": {
            "quickChat": {
                "iconEnabled": true,
                "shortcutEnabled": false,
                "shortcutAccelerator": DEFAULT_QUICK_CHAT_SHORTCUT_ACCELERATOR,
            },
            "archivedChatsAutoDeleteDays": 0,
        },
        "cloudSync": normalize_cloud_sync_settings(None),
        "desktopFeatureFlagOverrides": {},
    })
}

fn normalize_workspaces(raw: Option<&Value>, homedir: &Path) -> Vec<Value> {
    let mut workspaces = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for item in raw.and_then(Value::as_array).into_iter().flatten() {
        let Some(item) = item.as_object() else {
            continue;
        };
        let id = as_safe_id(item.get("id"));
        let name = as_non_empty_string(item.get("name"));
        let created_at = as_timestamp(item.get("createdAt"));
        let last_opened_at = as_timestamp(item.get("lastOpenedAt"));
        let raw_path = as_non_empty_string(item.get("path"));
        let kind = normalize_workspace_kind(item, id.as_deref(), raw_path.as_deref(), homedir);
        let workspace_path = match kind {
            WorkspaceKind::Project => normalize_saved_project_path(item.get("path")),
            WorkspaceKind::OneOffChat => resolve_workspace_path(item.get("path"), kind, homedir),
        };
        let (Some(id), Some(name), Some(created_at), Some(last_opened_at), Some(path)) =
            (id, name, created_at, last_opened_at, workspace_path)
        else {
            continue;
        };
        if seen.contains(&id) {
            continue;
        }
        let mut record = item.clone();
        let default_enable_mcp = as_boolean(item.get("defaultEnableMcp"), true);
        let default_backups_enabled = as_boolean(item.get("defaultBackupsEnabled"), false);
        record.insert("id".to_owned(), json!(id));
        record.insert("name".to_owned(), json!(name));
        record.insert("path".to_owned(), json!(path.to_string_lossy()));
        record.insert("workspaceKind".to_owned(), json!(kind.as_str()));
        record.insert("createdAt".to_owned(), json!(created_at));
        record.insert("lastOpenedAt".to_owned(), json!(last_opened_at));
        record.insert("wsProtocol".to_owned(), json!("jsonrpc"));
        record.insert("defaultEnableMcp".to_owned(), json!(default_enable_mcp));
        record.insert(
            "defaultBackupsEnabled".to_owned(),
            json!(default_backups_enabled),
        );
        record.insert("yolo".to_owned(), json!(false));
        seen.insert(id);
        workspaces.push(Value::Object(record));
    }
    workspaces
}

fn normalize_threads(raw: Option<&Value>, workspace_ids: &HashSet<String>) -> Vec<Value> {
    let mut threads = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for item in raw.and_then(Value::as_array).into_iter().flatten() {
        let Some(item) = item.as_object() else {
            continue;
        };
        let (Some(id), Some(workspace_id), Some(title), Some(created_at), Some(last_message_at)) = (
            as_safe_id(item.get("id")),
            as_safe_id(item.get("workspaceId")),
            as_non_empty_string(item.get("title")),
            as_timestamp(item.get("createdAt")),
            as_timestamp(item.get("lastMessageAt")),
        ) else {
            continue;
        };
        if seen.contains(&id) || !workspace_ids.contains(&workspace_id) {
            continue;
        }
        let mut record = item.clone();
        let status = if item.get("status").and_then(Value::as_str) == Some("active") {
            "active"
        } else {
            "disconnected"
        };
        let session_id = as_non_empty_string(item.get("sessionId"));
        let message_count = as_non_negative_integer(item.get("messageCount"), 0);
        let last_event_seq = as_non_negative_integer(item.get("lastEventSeq"), 0);
        record.insert("id".to_owned(), json!(id));
        record.insert("workspaceId".to_owned(), json!(workspace_id));
        record.insert("title".to_owned(), json!(title));
        record.insert("createdAt".to_owned(), json!(created_at));
        record.insert("lastMessageAt".to_owned(), json!(last_message_at));
        record.insert("status".to_owned(), json!(status));
        record.insert("sessionId".to_owned(), json!(session_id));
        record.insert("messageCount".to_owned(), message_count);
        record.insert("lastEventSeq".to_owned(), last_event_seq);
        seen.insert(id);
        threads.push(Value::Object(record));
    }
    threads
}

/// `normalizeState(raw, { homedir })`.
pub fn normalize_state(raw: &Value, homedir: &Path) -> Value {
    let Some(raw) = raw.as_object() else {
        return default_state();
    };

    let workspaces = normalize_workspaces(raw.get("workspaces"), homedir);
    let workspace_ids: HashSet<String> = workspaces
        .iter()
        .filter_map(|w| w.get("id").and_then(Value::as_str).map(str::to_owned))
        .collect();
    let threads = normalize_threads(raw.get("threads"), &workspace_ids);

    let version = match raw.get("version").and_then(Value::as_f64) {
        Some(v) if v.is_finite() => integer_value(v.floor().max(2.0)),
        _ => json!(2),
    };
    let desktop_settings = raw.get("desktopSettings").and_then(Value::as_object);
    let quick_chat = desktop_settings
        .and_then(|d| d.get("quickChat"))
        .and_then(Value::as_object);
    let icon_enabled = quick_chat.is_none_or(|q| q.get("iconEnabled") != Some(&Value::Bool(false)));
    let shortcut_enabled =
        quick_chat.is_some_and(|q| q.get("shortcutEnabled") == Some(&Value::Bool(true)));
    let shortcut_accelerator = normalize_quick_chat_shortcut_accelerator(
        quick_chat
            .and_then(|q| q.get("shortcutAccelerator"))
            .and_then(Value::as_str),
    );
    let archived_days = desktop_settings
        .and_then(|d| d.get("archivedChatsAutoDeleteDays"))
        .filter(|v| v.is_number())
        .cloned()
        .unwrap_or_else(|| json!(0));

    let mut out = Map::new();
    out.insert("version".to_owned(), version);
    out.insert("workspaces".to_owned(), Value::Array(workspaces));
    out.insert("threads".to_owned(), Value::Array(threads));
    out.insert(
        "developerMode".to_owned(),
        json!(as_boolean(raw.get("developerMode"), false)),
    );
    out.insert(
        "showHiddenFiles".to_owned(),
        json!(as_boolean(raw.get("showHiddenFiles"), false)),
    );
    out.insert(
        "perWorkspaceSettings".to_owned(),
        json!(as_boolean(raw.get("perWorkspaceSettings"), false)),
    );
    out.insert(
        "desktopSettings".to_owned(),
        json!({
            "quickChat": {
                "iconEnabled": icon_enabled,
                "shortcutEnabled": shortcut_enabled,
                "shortcutAccelerator": shortcut_accelerator,
            },
            "archivedChatsAutoDeleteDays": archived_days,
        }),
    );
    out.insert(
        "cloudSync".to_owned(),
        normalize_cloud_sync_settings(raw.get("cloudSync").and_then(Value::as_object)),
    );
    out.insert(
        "desktopFeatureFlagOverrides".to_owned(),
        normalize_feature_flag_overrides(raw.get("desktopFeatureFlagOverrides")),
    );
    for key in ["providerState", "providerUiState", "onboarding"] {
        if let Some(v) = raw.get(key) {
            out.insert(key.to_owned(), v.clone());
        }
    }
    Value::Object(out)
}

/// `buildFallbackWorkspace(cwd, workspaceKind)` used by `loadState` when the
/// normalized state has no workspaces.
pub fn build_fallback_workspace(fallback_cwd: &Path, homedir: &Path) -> Option<Value> {
    let kind = if is_path_inside_one_off_chats_root(fallback_cwd, homedir) {
        WorkspaceKind::OneOffChat
    } else {
        WorkspaceKind::Project
    };
    let cwd_value = json!(fallback_cwd.to_string_lossy());
    let path = resolve_workspace_path(Some(&cwd_value), kind, homedir)?;
    let path_str = path.to_string_lossy().into_owned();
    let name = path_str
        .split(['/', '\\'])
        .rfind(|s| !s.is_empty())
        .unwrap_or(&path_str)
        .to_owned();
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    Some(json!({
        "id": format!("{FALLBACK_WORKSPACE_ID_PREFIX}-{}", fnv1a32_hex(&path_str)),
        "name": name,
        "path": path_str,
        "createdAt": now,
        "lastOpenedAt": now,
        "wsProtocol": "jsonrpc",
        "workspaceKind": kind.as_str(),
        "defaultEnableMcp": true,
        "defaultBackupsEnabled": false,
        "yolo": false,
    }))
}
