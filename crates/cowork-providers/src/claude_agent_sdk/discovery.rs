//! System Claude Code CLI discovery, environment sanitization, and subscription auth helpers.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use cowork_config::{CachedModelDiscoveryModel, CachedModelReasoning};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

const AUTH_STATUS_TIMEOUT: Duration = Duration::from_secs(5);
const AUTH_LOGOUT_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCliStatus {
    pub available: bool,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeAuthStatus {
    pub installed: bool,
    pub logged_in: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth_method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subscription_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_tier: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub org_name: Option<String>,
    pub message: String,
}

/// Rejects `.bat`/`.cmd` batch scripts on Windows (CVE-2024-27980 / `subprocess_cli.py` parity).
pub(crate) fn is_unsafe_windows_batch_path(cli_path: &str) -> bool {
    if !cfg!(windows) {
        return false;
    }
    cli_path.replace('\\', "/").split('/').any(|component| {
        component.split(':').any(|segment| {
            let trimmed = segment.trim_end_matches(['.', ' ']).to_ascii_lowercase();
            trimmed.ends_with(".bat") || trimmed.ends_with(".cmd")
        })
    })
}

fn claude_cli_override(env: &HashMap<String, String>) -> Option<&str> {
    env.get("COWORK_CLAUDE_AGENT_SDK_BIN")
        .or_else(|| env.get("COWORK_CLAUDE_CLI_BIN"))
        .map(String::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Resolves the system-installed `claude` binary safely:
/// 1. Explicit `COWORK_CLAUDE_AGENT_SDK_BIN` / `COWORK_CLAUDE_CLI_BIN` override.
/// 2. Absolute-only `PATH` segments (never relative or empty segments).
/// 3. Standard user/system Claude Code install locations (`~/.local/bin/claude`,
///    `~/.claude/local/claude`, `~/.npm-global/bin/claude`, `/opt/homebrew/bin/claude`,
///    `/usr/local/bin/claude`).
pub fn resolve_claude_cli_status(homedir: &Path, env: &HashMap<String, String>) -> ClaudeCliStatus {
    if let Some(override_bin) = claude_cli_override(env) {
        if is_unsafe_windows_batch_path(override_bin) {
            return ClaudeCliStatus {
                available: false,
                source: "invalid".to_owned(),
                command: None,
                version: None,
                message: format!(
                    "Refusing to run Windows batch script {override_bin}; point COWORK_CLAUDE_AGENT_SDK_BIN at a native claude.exe."
                ),
            };
        }
        return ClaudeCliStatus {
            available: true,
            source: "override".to_owned(),
            command: Some(override_bin.to_owned()),
            version: None,
            message: format!("Using overridden Claude CLI at {override_bin}."),
        };
    }

    let bin_name = if cfg!(windows) {
        "claude.exe"
    } else {
        "claude"
    };

    if let Some(path_var) = env
        .get("PATH")
        .or_else(|| env.get("Path"))
        .map(String::as_str)
    {
        for entry in std::env::split_paths(path_var) {
            if !entry.is_absolute() || entry.as_os_str().is_empty() {
                continue;
            }
            let candidate = entry.join(bin_name);
            let candidate_str = candidate.to_string_lossy();
            if is_unsafe_windows_batch_path(&candidate_str) {
                continue;
            }
            if is_executable_file(&candidate) {
                return ClaudeCliStatus {
                    available: true,
                    source: "system".to_owned(),
                    command: Some(candidate_str.into_owned()),
                    version: None,
                    message: format!("Using system Claude Code CLI at {}.", candidate.display()),
                };
            }
        }
    }

    let mut standard_locations: Vec<PathBuf> = vec![
        homedir.join(".local").join("bin").join(bin_name),
        homedir.join(".claude").join("local").join(bin_name),
        homedir.join(".npm-global").join("bin").join(bin_name),
    ];
    let real_home = std::env::var_os("HOME").map(PathBuf::from);
    let is_isolated_homedir = real_home.as_deref().is_some_and(|real| real != homedir);
    if !cfg!(windows) && !is_isolated_homedir {
        standard_locations.push(PathBuf::from("/opt/homebrew/bin/claude"));
        standard_locations.push(PathBuf::from("/usr/local/bin/claude"));
    }

    for candidate in standard_locations {
        let candidate_str = candidate.to_string_lossy();
        if is_unsafe_windows_batch_path(&candidate_str) {
            continue;
        }
        if is_executable_file(&candidate) {
            return ClaudeCliStatus {
                available: true,
                source: "system".to_owned(),
                command: Some(candidate_str.into_owned()),
                version: None,
                message: format!("Using system Claude Code CLI at {}.", candidate.display()),
            };
        }
    }

    ClaudeCliStatus {
        available: false,
        source: "missing".to_owned(),
        command: None,
        version: None,
        message: "Claude Code CLI not found. Install Claude Code (`claude`) and sign in with `claude auth login`.".to_owned(),
    }
}

/// Builds the sanitized child environment for the system `claude` CLI:
/// - Strips `CLAUDECODE` so nested Claude Code sessions don't refuse to launch.
/// - Strips `ANTHROPIC_API_KEY` so the CLI uses the user's Claude subscription login rather
///   than accidentally billing an API key from the shell environment.
/// - Sets `CLAUDE_CODE_ENTRYPOINT=sdk-rs` and `CLAUDE_CODE_SDK_READS_SESSION_STATE=1`.
pub fn build_claude_spawn_env(parent_env: &HashMap<String, String>) -> HashMap<String, String> {
    let mut env = HashMap::with_capacity(parent_env.len() + 2);
    for (k, v) in parent_env {
        if k.eq_ignore_ascii_case("CLAUDECODE")
            || k.eq_ignore_ascii_case("ANTHROPIC_API_KEY")
            || k.eq_ignore_ascii_case(cowork_sandbox::PARENT_MANAGED_ENV_VAR)
        {
            continue;
        }
        env.insert(k.clone(), v.clone());
    }
    env.insert("CLAUDE_CODE_ENTRYPOINT".to_owned(), "sdk-rs".to_owned());
    env.insert(
        "CLAUDE_CODE_SDK_READS_SESSION_STATE".to_owned(),
        "1".to_owned(),
    );
    env
}

fn build_claude_auth_env(
    homedir: &Path,
    parent_env: &HashMap<String, String>,
) -> HashMap<String, String> {
    let mut env = build_claude_spawn_env(parent_env);
    let homedir_str = homedir.to_string_lossy().into_owned();
    if !homedir_str.is_empty() {
        env.insert("HOME".to_owned(), homedir_str.clone());
        #[cfg(windows)]
        env.insert("USERPROFILE".to_owned(), homedir_str.clone());
        let real_home = std::env::var_os("HOME").map(PathBuf::from);
        let is_isolated_homedir = real_home.as_deref().is_some_and(|real| real != homedir);
        if is_isolated_homedir
            && !env
                .keys()
                .any(|k| k.eq_ignore_ascii_case("CLAUDE_CONFIG_DIR"))
        {
            env.insert(
                "CLAUDE_CONFIG_DIR".to_owned(),
                homedir.join(".claude").to_string_lossy().into_owned(),
            );
        }
    }
    env
}

pub fn parse_claude_auth_status_json(raw: &str) -> Option<ClaudeAuthStatus> {
    let trimmed = raw.trim();
    let val: Value = serde_json::from_str(trimmed).ok().or_else(|| {
        let start = trimmed.find('{')?;
        let end = trimmed.rfind('}')?;
        if end < start {
            return None;
        }
        serde_json::from_str(&trimmed[start..=end]).ok()
    })?;
    let obj = val.as_object()?;
    let logged_in = obj
        .get("loggedIn")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let auth_method = obj
        .get("authMethod")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    let subscription_type = obj
        .get("subscriptionType")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    let plan_tier = obj
        .get("planTier")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    let email = obj
        .get("email")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    let org_name = obj
        .get("orgName")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);

    let message = if logged_in {
        match (subscription_type.as_deref(), email.as_deref()) {
            (Some(sub), Some(mail)) => format!("Claude {sub} account verified ({mail})."),
            (Some(sub), None) => format!("Claude {sub} account verified."),
            (None, Some(mail)) => format!("Claude account verified ({mail})."),
            (None, None) => "Claude account verified.".to_owned(),
        }
    } else {
        "Claude CLI found, but not signed in. Click Sign in with Claude to connect.".to_owned()
    };

    Some(ClaudeAuthStatus {
        installed: true,
        logged_in,
        auth_method,
        subscription_type,
        plan_tier,
        email,
        org_name,
        message,
    })
}

/// Checks whether the system `claude` CLI is installed and signed in (`claude auth status --json`).
pub async fn read_claude_auth_status(
    homedir: &Path,
    env: &HashMap<String, String>,
) -> ClaudeAuthStatus {
    if env
        .get("COWORK_CLAUDE_CLI_STATUS_DISABLE")
        .map(String::as_str)
        .map(str::trim)
        .is_some_and(|v| v == "1" || v.eq_ignore_ascii_case("true"))
    {
        return ClaudeAuthStatus {
            installed: false,
            logged_in: false,
            message: "Claude CLI status check disabled.".to_owned(),
            ..Default::default()
        };
    }

    let cli = resolve_claude_cli_status(homedir, env);
    let Some(command) = cli.command else {
        return ClaudeAuthStatus {
            installed: false,
            logged_in: false,
            message: cli.message,
            ..Default::default()
        };
    };

    let spawn_env = build_claude_auth_env(homedir, env);
    let mut cmd = tokio::process::Command::new(&command);
    cmd.args(["auth", "status", "--json"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_clear()
        .envs(&spawn_env)
        .kill_on_drop(true);

    let output = match tokio::time::timeout(AUTH_STATUS_TIMEOUT, cmd.output()).await {
        Ok(Ok(out)) => out,
        Ok(Err(err)) => {
            return ClaudeAuthStatus {
                installed: false,
                logged_in: false,
                message: format!("Failed to invoke Claude CLI ({command}): {err}"),
                ..Default::default()
            };
        }
        Err(_) => {
            return ClaudeAuthStatus {
                installed: true,
                logged_in: false,
                message: "Timed out checking Claude CLI authentication status.".to_owned(),
                ..Default::default()
            };
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    if let Some(parsed) = parse_claude_auth_status_json(&stdout) {
        return parsed;
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    ClaudeAuthStatus {
        installed: true,
        logged_in: false,
        message: if stderr.is_empty() {
            "Not signed in to Claude CLI.".to_owned()
        } else {
            stderr
        },
        ..Default::default()
    }
}

/// Launches `claude auth login --claudeai` in a background child process so the user can
/// complete browser sign-in, returning immediately if already logged in.
pub async fn start_claude_login(
    homedir: &Path,
    env: &HashMap<String, String>,
) -> Result<ClaudeAuthStatus, String> {
    let current = read_claude_auth_status(homedir, env).await;
    if current.logged_in {
        return Ok(current);
    }
    let cli = resolve_claude_cli_status(homedir, env);
    let command = cli.command.ok_or_else(|| cli.message.clone())?;
    let spawn_env = build_claude_auth_env(homedir, env);

    let mut cmd = tokio::process::Command::new(&command);
    cmd.args(["auth", "login", "--claudeai"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .env_clear()
        .envs(&spawn_env);

    cmd.spawn()
        .map_err(|err| format!("Failed to launch Claude CLI login ({command}): {err}"))?;

    Ok(ClaudeAuthStatus {
        installed: true,
        logged_in: false,
        message: "Opened Claude sign-in in your browser. Complete sign-in, then refresh status."
            .to_owned(),
        ..Default::default()
    })
}

/// Runs `claude auth logout` to disconnect the Claude CLI account when requested.
pub async fn logout_claude_account(
    homedir: &Path,
    env: &HashMap<String, String>,
) -> Result<(), String> {
    let cli = resolve_claude_cli_status(homedir, env);
    let Some(command) = cli.command else {
        return Ok(());
    };
    let spawn_env = build_claude_auth_env(homedir, env);
    let mut cmd = tokio::process::Command::new(&command);
    cmd.args(["auth", "logout"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .env_clear()
        .envs(&spawn_env)
        .kill_on_drop(true);

    let output = tokio::time::timeout(AUTH_LOGOUT_TIMEOUT, cmd.output())
        .await
        .map_err(|_| "Timed out logging out of Claude CLI.".to_owned())?
        .map_err(|err| format!("Failed to run Claude CLI logout: {err}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        if !detail.is_empty() {
            return Err(format!("Claude CLI logout failed: {detail}"));
        }
    }
    Ok(())
}

fn format_claude_model_display_name(raw_name: &str, description: Option<&str>, id: &str) -> String {
    let mut name = raw_name.trim().to_owned();
    if name.is_empty() || name.to_ascii_lowercase().starts_with("default") {
        if let Some(desc) = description.map(str::trim).filter(|s| !s.is_empty())
            && let Some(prefix) = desc.split('·').next().map(str::trim)
            && !prefix.is_empty()
        {
            name = prefix.to_owned();
        } else {
            name = id.to_owned();
        }
    }
    let lower = name.to_ascii_lowercase();
    if !lower.starts_with("claude") {
        format!("Claude {name}")
    } else {
        name
    }
}

/// Parses the `models` array from a Claude Agent SDK `control_response` (`initialize`) payload
/// into Cowork's normalized discovery-cache model entries.
pub fn parse_claude_initialize_models(models_val: &Value) -> Vec<CachedModelDiscoveryModel> {
    let Some(items) = models_val.as_array() else {
        return Vec::new();
    };

    let default_resolved_id: Option<String> = items.iter().find_map(|item| {
        let value = item.get("value").and_then(Value::as_str).map(str::trim)?;
        if !value.eq_ignore_ascii_case("default") {
            return None;
        }
        item.get("resolvedModel")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    });

    let mut out: Vec<CachedModelDiscoveryModel> = Vec::new();
    let mut index_by_id: HashMap<String, usize> = HashMap::new();
    let mut came_from_default_alias: HashMap<String, bool> = HashMap::new();

    for item in items {
        let Some(obj) = item.as_object() else {
            continue;
        };
        let raw_value = obj
            .get("value")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let resolved = obj
            .get("resolvedModel")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty());

        let is_default_alias = raw_value.is_some_and(|v| v.eq_ignore_ascii_case("default"));
        let Some(canonical_id) = resolved.or_else(|| raw_value.filter(|_| !is_default_alias))
        else {
            continue;
        };

        let raw_display = obj
            .get("displayName")
            .or_else(|| obj.get("display_name"))
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        let description = obj
            .get("description")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        let display_name =
            format_claude_model_display_name(raw_display, description.as_deref(), canonical_id);

        let supported_efforts: Vec<String> = obj
            .get("supportedEffortLevels")
            .or_else(|| obj.get("supported_effort_levels"))
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        let supports_effort = obj
            .get("supportsEffort")
            .or_else(|| obj.get("supports_effort"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let reasoning = if !supported_efforts.is_empty() || supports_effort {
            let available = if supported_efforts.is_empty() {
                vec!["low".to_owned(), "medium".to_owned(), "high".to_owned()]
            } else {
                supported_efforts
            };
            // Claude Code's defaults differ from the Messages API for these models.
            let documented_default = match canonical_id {
                "claude-opus-4-7" => Some("xhigh"),
                "claude-fable-5-2" | "claude-opus-5-5" | "claude-sonnet-5-5"
                | "claude-haiku-5-5" => Some("medium"),
                _ => None,
            };
            let default_effort = documented_default
                .filter(|default| available.iter().any(|effort| effort.as_str() == *default))
                .map(str::to_owned)
                .or_else(|| {
                    ["high", "medium", "low"]
                        .into_iter()
                        .find(|d| available.iter().any(|e| e == d))
                        .map(str::to_owned)
                })
                .or_else(|| available.first().cloned());
            Some(CachedModelReasoning {
                default_effort,
                available_efforts: Some(available),
            })
        } else {
            None
        };

        let is_default = is_default_alias || default_resolved_id.as_deref() == Some(canonical_id);
        let mut runtime_options = Map::new();
        runtime_options.insert(
            "source".to_owned(),
            Value::String("claude-agent-sdk".into()),
        );
        if let Some(alias) = raw_value.filter(|v| *v != canonical_id && !is_default_alias) {
            runtime_options.insert("alias".to_owned(), Value::String(alias.to_owned()));
        }

        let entry = CachedModelDiscoveryModel {
            id: canonical_id.to_owned(),
            model: None,
            display_name,
            description,
            knowledge_cutoff: None,
            supports_image_input: Some(true),
            is_default: is_default.then_some(true),
            reasoning,
            runtime_options: Some(runtime_options),
            runtime_overrides: None,
        };

        if let Some(&existing_idx) = index_by_id.get(canonical_id) {
            // If an earlier `"default"` alias seeded this model, replace its generic label/description
            // with the concrete sibling entry (e.g. `"opus"` -> `"Claude Opus 5.5"`) while keeping default.
            if came_from_default_alias
                .get(canonical_id)
                .copied()
                .unwrap_or(false)
                && !is_default_alias
            {
                let mut updated = entry;
                updated.is_default = Some(true);
                out[existing_idx] = updated;
                came_from_default_alias.insert(canonical_id.to_owned(), false);
            } else if is_default {
                out[existing_idx].is_default = Some(true);
            }
        } else {
            index_by_id.insert(canonical_id.to_owned(), out.len());
            came_from_default_alias.insert(canonical_id.to_owned(), is_default_alias);
            out.push(entry);
        }
    }

    if !out.is_empty() && !out.iter().any(|m| m.is_default == Some(true)) {
        out[0].is_default = Some(true);
    }

    out
}

/// Queries the system Claude Code CLI via the Claude Agent SDK `initialize` control handshake
/// to discover the live models available to the user's Claude subscription.
pub async fn list_claude_sdk_models(
    homedir: &Path,
    env: &HashMap<String, String>,
    timeout: Duration,
) -> Result<Vec<CachedModelDiscoveryModel>, String> {
    let cli = resolve_claude_cli_status(homedir, env);
    let command = cli.command.ok_or_else(|| cli.message.clone())?;
    let spawn_env = build_claude_auth_env(homedir, env);

    let mut cmd = tokio::process::Command::new(&command);
    cmd.args([
        "--output-format",
        "stream-json",
        "--input-format",
        "stream-json",
        "--verbose",
        "--tools",
        "",
        "--setting-sources=",
        "--strict-mcp-config",
        "--permission-mode",
        "bypassPermissions",
    ])
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .env_clear()
    .envs(&spawn_env)
    .kill_on_drop(true);

    let mut child = cmd.spawn().map_err(|err| {
        format!("Failed to spawn Claude CLI ({command}) for model discovery: {err}")
    })?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Claude CLI discovery child missing stdin pipe.".to_owned())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Claude CLI discovery child missing stdout pipe.".to_owned())?;

    let request_id = "cowork-discover-models-1";
    let init_frame = json!({
        "type": "control_request",
        "request_id": request_id,
        "request": { "subtype": "initialize" }
    });
    let mut line = serde_json::to_string(&init_frame).map_err(|e| e.to_string())?;
    line.push('\n');
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|err| format!("Failed to write Claude CLI initialize request: {err}"))?;
    stdin
        .flush()
        .await
        .map_err(|err| format!("Failed to flush Claude CLI initialize request: {err}"))?;

    let effective_timeout = timeout.clamp(Duration::from_secs(2), Duration::from_secs(15));
    let mut reader = BufReader::new(stdout).lines();

    let read_res = tokio::time::timeout(effective_timeout, async {
        while let Some(raw_line) = reader
            .next_line()
            .await
            .map_err(|e| format!("Failed reading Claude CLI discovery output: {e}"))?
        {
            let trimmed = raw_line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(frame) = serde_json::from_str::<Value>(trimmed) else {
                continue;
            };
            if frame.get("type").and_then(Value::as_str) != Some("control_response") {
                continue;
            }
            let Some(resp) = frame.get("response").and_then(Value::as_object) else {
                continue;
            };
            if resp.get("request_id").and_then(Value::as_str) != Some(request_id) {
                continue;
            }
            if resp.get("subtype").and_then(Value::as_str) == Some("error") {
                let err_msg = resp
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("Claude CLI initialize failed during model discovery.");
                return Err(err_msg.to_owned());
            }
            let models_val = resp
                .get("response")
                .and_then(|r| r.get("models"))
                .cloned()
                .unwrap_or(Value::Null);
            return Ok(parse_claude_initialize_models(&models_val));
        }
        Err("Claude CLI exited before responding to model discovery handshake.".to_owned())
    })
    .await;

    drop(stdin);
    let _ = child.start_kill();
    let _ = tokio::time::timeout(Duration::from_secs(1), child.wait()).await;

    match read_res {
        Ok(res) => res,
        Err(_) => Err("Timed out querying Claude Agent SDK for available models.".to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_code_default_efforts_match_model_config() {
        let models = parse_claude_initialize_models(&json!([
            {
                "value": "opus",
                "resolvedModel": "claude-opus-5-5",
                "supportedEffortLevels": ["low", "medium", "high", "xhigh", "max"]
            },
            {
                "value": "claude-opus-4-7",
                "resolvedModel": "claude-opus-4-7",
                "supportedEffortLevels": ["low", "medium", "high", "xhigh", "max"]
            },
            {
                "value": "fable",
                "resolvedModel": "claude-fable-5-2",
                "supportedEffortLevels": ["low", "medium", "high", "xhigh", "max"]
            },
            {
                "value": "sonnet",
                "resolvedModel": "claude-sonnet-5-5",
                "supportedEffortLevels": ["low", "medium", "high", "xhigh", "max"]
            },
            {
                "value": "haiku",
                "resolvedModel": "claude-haiku-5-5",
                "supportedEffortLevels": ["low", "medium", "high", "xhigh", "max"]
            }
        ]));
        let defaults: HashMap<&str, Option<&str>> = models
            .iter()
            .map(|model| {
                (
                    model.id.as_str(),
                    model
                        .reasoning
                        .as_ref()
                        .and_then(|reasoning| reasoning.default_effort.as_deref()),
                )
            })
            .collect();
        assert_eq!(defaults.get("claude-opus-5-5"), Some(&Some("medium")));
        assert_eq!(defaults.get("claude-opus-4-7"), Some(&Some("xhigh")));
        assert_eq!(defaults.get("claude-fable-5-2"), Some(&Some("medium")));
        assert_eq!(defaults.get("claude-sonnet-5-5"), Some(&Some("medium")));
        assert_eq!(defaults.get("claude-haiku-5-5"), Some(&Some("medium")));
    }
}
