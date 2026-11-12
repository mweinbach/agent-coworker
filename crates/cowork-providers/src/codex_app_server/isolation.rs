use std::collections::HashMap;
use std::path::{Path, PathBuf};

use cowork_config::ensure_private_dir_sync;
use serde::{Deserialize, Serialize};

use super::installer::{
    CodexRuntimeTarget, managed_codex_current_path, managed_codex_root,
    resolve_installed_managed_command,
};

pub const CODEX_APP_SERVER_MANAGED_VERSION: &str = "0.160.0";

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
    cowork_sandbox::sync_codex_windows_sandbox_setup_state_between(&sandbox_home, &codex_home);

    let mut spawn_env = HashMap::with_capacity(parent_env.len() + 1);
    for (k, v) in parent_env {
        if k.to_ascii_uppercase().starts_with("CODEX_")
            || k.eq_ignore_ascii_case(cowork_sandbox::PARENT_MANAGED_ENV_VAR)
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
