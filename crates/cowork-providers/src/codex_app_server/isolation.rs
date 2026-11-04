use std::collections::HashMap;
use std::path::{Path, PathBuf};

use chrono::DateTime;
use cowork_config::{ensure_private_dir_sync, harden_private_file_sync, write_text_file_atomic};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::installer::{
    CodexRuntimeTarget, managed_codex_current_path, managed_codex_root,
    resolve_installed_managed_command,
};

pub const CODEX_APP_SERVER_MANAGED_VERSION: &str = "0.160.0";
const WINDOWS_SANDBOX_SETUP_VERSION: u64 = 5;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexInstallStatus {
    pub available: bool,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pinned_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pin_matches_current: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub managed_path: Option<String>,
    pub message: String,
}

/// Resolves the isolated Cowork-managed Codex CLI home (`<cowork_home>/auth/codex-cli`).
/// Never resolves to or touches `~/.codex`.
pub fn resolve_codex_home(cowork_home: &Path) -> PathBuf {
    cowork_home.join("auth").join("codex-cli")
}

/// Builds the child environment for `codex app-server`:
/// - Creates `<cowork_home>/auth/codex-cli` with `0700` permissions.
/// - Strips every inherited `CODEX_*` variable (case-insensitively) and `COWORK_DESKTOP_PARENT_MANAGED`.
/// - Pins `CODEX_HOME` to `<cowork_home>/auth/codex-cli`.
pub fn build_codex_spawn_env(
    cowork_home: &Path,
    parent_env: &HashMap<String, String>,
) -> HashMap<String, String> {
    let codex_home = resolve_codex_home(cowork_home);
    let _ = ensure_private_dir_sync(&codex_home);
    let sandbox_home = parent_env
        .get("COWORK_WIN_SANDBOX_HOME")
        .map(String::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| cowork_home.to_path_buf());
    let _ = sync_codex_windows_sandbox_setup_state(&sandbox_home, &codex_home);

    let mut spawn_env = HashMap::with_capacity(parent_env.len() + 1);
    for (k, v) in parent_env {
        if k.to_ascii_uppercase().starts_with("CODEX_")
            || k.eq_ignore_ascii_case("COWORK_DESKTOP_PARENT_MANAGED")
        {
            continue;
        }
        spawn_env.insert(k.clone(), v.clone());
    }
    spawn_env.insert(
        "CODEX_HOME".to_string(),
        codex_home.to_string_lossy().into_owned(),
    );
    spawn_env
}

#[derive(Debug, Clone)]
struct SandboxMarkerBundle {
    root: PathBuf,
    marker_raw: String,
    users_raw: String,
    sort_timestamp_ms: i64,
}

fn read_valid_v5_bundle(root: &Path) -> Option<SandboxMarkerBundle> {
    let marker_path = root.join(".sandbox").join("setup_marker.json");
    let users_path = root.join(".sandbox-secrets").join("sandbox_users.json");
    let marker_raw = std::fs::read_to_string(&marker_path).ok()?;
    let users_raw = std::fs::read_to_string(&users_path).ok()?;

    let marker_val: Value = serde_json::from_str(&marker_raw).ok()?;
    let users_val: Value = serde_json::from_str(&users_raw).ok()?;
    if marker_val.get("version").and_then(Value::as_u64) != Some(WINDOWS_SANDBOX_SETUP_VERSION) {
        return None;
    }
    if users_val.get("version").and_then(Value::as_u64) != Some(WINDOWS_SANDBOX_SETUP_VERSION) {
        return None;
    }

    let created_ts = marker_val
        .get("created_at")
        .or_else(|| marker_val.get("updated_at"))
        .and_then(Value::as_str)
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.timestamp_millis())
        .or_else(|| {
            std::fs::metadata(&marker_path)
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
        })
        .unwrap_or(0);

    Some(SandboxMarkerBundle {
        root: root.to_path_buf(),
        marker_raw,
        users_raw,
        sort_timestamp_ms: created_ts,
    })
}

fn write_v5_bundle(target_root: &Path, bundle: &SandboxMarkerBundle) -> bool {
    let sandbox_dir = target_root.join(".sandbox");
    let secrets_dir = target_root.join(".sandbox-secrets");
    if ensure_private_dir_sync(&sandbox_dir).is_err()
        || ensure_private_dir_sync(&secrets_dir).is_err()
    {
        return false;
    }
    let marker_dest = sandbox_dir.join("setup_marker.json");
    let users_dest = secrets_dir.join("sandbox_users.json");
    if write_text_file_atomic(&users_dest, &bundle.users_raw, Some(0o600)).is_err()
        || write_text_file_atomic(&marker_dest, &bundle.marker_raw, Some(0o600)).is_err()
    {
        return false;
    }
    harden_private_file_sync(&users_dest);
    harden_private_file_sync(&marker_dest);
    true
}

/// Synchronizes Windows sandbox `version == 5` setup markers (`setup_marker.json` +
/// `sandbox_users.json`) newest-wins between `<cowork_home>` and `<codex_home>`.
pub fn sync_codex_windows_sandbox_setup_state(cowork_home: &Path, codex_home: &Path) -> bool {
    let cowork_bundle = read_valid_v5_bundle(cowork_home);
    let codex_bundle = read_valid_v5_bundle(codex_home);

    match (cowork_bundle, codex_bundle) {
        (None, None) => false,
        (Some(b), None) => write_v5_bundle(codex_home, &b),
        (None, Some(b)) => write_v5_bundle(cowork_home, &b),
        (Some(a), Some(b)) => {
            if a.sort_timestamp_ms >= b.sort_timestamp_ms {
                if a.marker_raw != b.marker_raw || a.users_raw != b.users_raw {
                    let _ = &a.root;
                    write_v5_bundle(codex_home, &a)
                } else {
                    true
                }
            } else {
                write_v5_bundle(cowork_home, &b)
            }
        }
    }
}

fn parse_override_args(raw: Option<&str>) -> Vec<String> {
    let Some(trimmed) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return Vec::new();
    };
    if trimmed.starts_with('[')
        && trimmed.ends_with(']')
        && let Ok(parsed) = serde_json::from_str::<Vec<String>>(trimmed)
    {
        return parsed;
    }
    let mut out = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut chars = trimmed.chars().peekable();
    while let Some(ch) = chars.next() {
        match quote {
            Some(q) => {
                if ch == '\\'
                    && let Some(&next) = chars.peek()
                    && (next == q || next == '\\')
                {
                    current.push(chars.next().unwrap());
                } else if ch == q {
                    quote = None;
                } else {
                    current.push(ch);
                }
            }
            None => {
                if ch == '"' || ch == '\'' {
                    quote = Some(ch);
                } else if ch.is_whitespace() {
                    if !current.is_empty() {
                        out.push(std::mem::take(&mut current));
                    }
                } else {
                    current.push(ch);
                }
            }
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

/// True when `COWORK_CODEX_APP_SERVER_BIN`/`COWORK_CODEX_APP_SERVER_COMMAND` pins an explicit
/// Codex binary, which wins over the managed runtime.
pub fn codex_app_server_override_configured(env: &HashMap<String, String>) -> bool {
    codex_app_server_override(env).is_some()
}

fn codex_app_server_override(env: &HashMap<String, String>) -> Option<&str> {
    env.get("COWORK_CODEX_APP_SERVER_BIN")
        .or_else(|| env.get("COWORK_CODEX_APP_SERVER_COMMAND"))
        .map(String::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

pub fn resolve_codex_app_server_status(
    cowork_home: &Path,
    env: &HashMap<String, String>,
) -> CodexInstallStatus {
    let target = CodexRuntimeTarget::host().ok();
    let managed_default = target
        .as_ref()
        .map(|t| managed_codex_current_path(cowork_home, t))
        .unwrap_or_else(|| managed_codex_root(cowork_home));
    let managed_str = managed_default.to_string_lossy().into_owned();

    if let Some(override_bin) = codex_app_server_override(env) {
        let args = parse_override_args(env.get("COWORK_CODEX_APP_SERVER_ARGS").map(String::as_str));
        return CodexInstallStatus {
            available: true,
            source: "override".to_string(),
            command: Some(override_bin.to_string()),
            args: Some(args),
            version: None,
            pinned_version: Some(CODEX_APP_SERVER_MANAGED_VERSION.to_string()),
            pin_matches_current: None,
            managed_path: Some(managed_str),
            message: format!("Using overridden Codex app-server binary at {override_bin}."),
        };
    }

    if let Some((managed_path, version)) = target
        .as_ref()
        .and_then(|t| resolve_installed_managed_command(cowork_home, t))
    {
        let managed_str = managed_path.to_string_lossy().into_owned();
        let matches = version.as_deref() == Some(CODEX_APP_SERVER_MANAGED_VERSION);
        let message = format!(
            "Using Cowork-managed Codex runtime {}.",
            version.as_deref().unwrap_or("(unknown version)")
        );
        return CodexInstallStatus {
            available: true,
            source: "managed".to_string(),
            command: Some(managed_str.clone()),
            args: Some(Vec::new()),
            version,
            pinned_version: Some(CODEX_APP_SERVER_MANAGED_VERSION.to_string()),
            pin_matches_current: Some(matches),
            managed_path: Some(managed_str),
            message,
        };
    }

    // TS `getCodexAppServerInstallStatus` parity: only an explicit override or the pinned,
    // checksum-verified managed runtime ever runs. `PATH` is never searched, so a foreign
    // `codex` binary (or one planted in a relative/empty `PATH` entry) is never executed.
    CodexInstallStatus {
        available: false,
        source: "missing".to_string(),
        command: None,
        args: None,
        version: None,
        pinned_version: Some(CODEX_APP_SERVER_MANAGED_VERSION.to_string()),
        pin_matches_current: Some(false),
        managed_path: Some(managed_str),
        message: format!(
            "Cowork-managed Codex runtime {CODEX_APP_SERVER_MANAGED_VERSION} has not been downloaded yet. Account sign-in can still be connected; Cowork will download the runtime before first Codex turn."
        ),
    }
}
