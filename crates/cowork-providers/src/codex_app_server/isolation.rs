use std::collections::HashMap;
use std::path::{Path, PathBuf};

use chrono::DateTime;
use cowork_config::{ensure_private_dir_sync, harden_private_file_sync, write_text_file_atomic};
use serde::{Deserialize, Serialize};
use serde_json::Value;

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
    let _ = sync_codex_windows_sandbox_setup_state(cowork_home, &codex_home);

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
    if write_text_file_atomic(&marker_dest, &bundle.marker_raw, Some(0o600)).is_err()
        || write_text_file_atomic(&users_dest, &bundle.users_raw, Some(0o600)).is_err()
    {
        return false;
    }
    harden_private_file_sync(&marker_dest);
    harden_private_file_sync(&users_dest);
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

fn find_executable_in_path(bin_name: &str, path_env: Option<&str>) -> Option<PathBuf> {
    let raw_path = path_env?;
    for entry in std::env::split_paths(raw_path) {
        let candidate = entry.join(bin_name);
        if candidate.is_file() {
            return Some(candidate);
        }
        #[cfg(windows)]
        {
            let exe = entry.join(format!("{bin_name}.exe"));
            if exe.is_file() {
                return Some(exe);
            }
        }
    }
    None
}

pub fn resolve_codex_app_server_status(
    cowork_home: &Path,
    env: &HashMap<String, String>,
) -> CodexInstallStatus {
    let managed_bin_name = if cfg!(windows) {
        "codex-app-server.exe"
    } else {
        "codex-app-server"
    };
    let managed_path = cowork_home
        .join("runtimes")
        .join("codex-app-server")
        .join("current")
        .join(managed_bin_name);
    let managed_str = managed_path.to_string_lossy().into_owned();

    if let Some(override_bin) = env
        .get("COWORK_CODEX_APP_SERVER_BIN")
        .map(String::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return CodexInstallStatus {
            available: true,
            source: "override".to_string(),
            command: Some(override_bin.to_string()),
            args: Some(Vec::new()),
            version: None,
            pinned_version: Some(CODEX_APP_SERVER_MANAGED_VERSION.to_string()),
            pin_matches_current: None,
            managed_path: Some(managed_str),
            message: format!("Using overridden Codex app-server binary at {override_bin}."),
        };
    }

    if managed_path.is_file() {
        let version_file = cowork_home
            .join("runtimes")
            .join("codex-app-server")
            .join("current")
            .join("version.txt");
        let current_ver = std::fs::read_to_string(version_file)
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| CODEX_APP_SERVER_MANAGED_VERSION.to_string());
        let matches = current_ver == CODEX_APP_SERVER_MANAGED_VERSION;
        return CodexInstallStatus {
            available: true,
            source: "managed".to_string(),
            command: Some(managed_str.clone()),
            args: Some(Vec::new()),
            version: Some(current_ver),
            pinned_version: Some(CODEX_APP_SERVER_MANAGED_VERSION.to_string()),
            pin_matches_current: Some(matches),
            managed_path: Some(managed_str),
            message: "Managed Codex app-server runtime is installed.".to_string(),
        };
    }

    let path_var = env
        .get("PATH")
        .map(String::as_str)
        .or_else(|| env.get("Path").map(String::as_str));
    if let Some(sys_codex) = find_executable_in_path("codex", path_var) {
        let cmd_str = sys_codex.to_string_lossy().into_owned();
        return CodexInstallStatus {
            available: true,
            source: "system".to_string(),
            command: Some(cmd_str),
            args: Some(vec!["app-server".to_string()]),
            version: None,
            pinned_version: Some(CODEX_APP_SERVER_MANAGED_VERSION.to_string()),
            pin_matches_current: None,
            managed_path: Some(managed_str),
            message: "System codex CLI is available.".to_string(),
        };
    }

    CodexInstallStatus {
        available: false,
        source: "missing".to_string(),
        command: None,
        args: None,
        version: None,
        pinned_version: Some(CODEX_APP_SERVER_MANAGED_VERSION.to_string()),
        pin_matches_current: Some(false),
        managed_path: Some(managed_str),
        message: "Codex app-server runtime is not installed.".to_string(),
    }
}
