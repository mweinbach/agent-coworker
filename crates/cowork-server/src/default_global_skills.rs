//! Startup installation of the default user-scope marketplace plugins (TS
//! `src/skills/defaultGlobalSkills.ts` `ensureDefaultGlobalSkillsReady`).
//!
//! The plugins come from the built-in marketplace (`BUILTIN_MARKETPLACE_ID`, downloaded from
//! GitHub; nothing is bundled with the app). `~/.cowork/config/default-global-skills.json`
//! records the plugin ids already bootstrapped so later starts skip the network, a removal
//! tombstone in the user `plugins.json` keeps an uninstalled default plugin uninstalled, and a
//! failed attempt writes `default-global-skills.failure.json` and backs off for 30 minutes.

use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::{DateTime, Utc};
use cowork_config::now_iso;
use cowork_config::{
    AgentConfig, FileLockOptions, file_lock_root_for_cowork_home, with_file_lock_sync,
    write_text_file_atomic,
};
use cowork_harness::ExtensionManager;
use cowork_harness::extensions::BUILTIN_MARKETPLACE_ID;
use cowork_harness::extensions::remote_source::is_network_allowed_for_github;
use cowork_mcp::plugin_overrides::{
    PluginScope, canonical_default_marketplace_plugin_id_for_tombstone, read_plugin_overrides,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

const DEFAULT_SKILLS_STATE_FILE: &str = "default-global-skills.json";
const DEFAULT_SKILLS_FAILURE_FILE: &str = "default-global-skills.failure.json";
const INSTALL_STATE_VERSION: u32 = 1;
const FAILURE_STATE_VERSION: u32 = 1;
const BOOTSTRAP_FAILURE_BACKOFF: Duration = Duration::from_secs(30 * 60);
/// TS `DEFAULT_MARKETPLACE_PLUGIN_IDS`.
pub const DEFAULT_MARKETPLACE_PLUGIN_IDS: &[&str] = &["workspace-tools"];
/// TS `LEGACY_SKILL_NAMES` (`coworkRuntime/cleanup.ts`): runtime-bootstrapped skills that the
/// `workspace-tools` plugin replaces.
const LEGACY_PRODUCTIVITY_SKILL_NAMES: &[&str] =
    &["documents", "pdf", "presentations", "spreadsheets"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DefaultGlobalSkillsState {
    version: u32,
    marketplace: String,
    installed_at: String,
    plugins: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DefaultGlobalSkillsFailureState {
    version: u32,
    failed_at: String,
    message: String,
}

/// Outcome of a bootstrap that ran (TS `EnsureDefaultGlobalSkillsInstalledResult`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DefaultGlobalSkillsOutcome {
    pub installed: Vec<String>,
    pub skipped_existing: Vec<String>,
    pub skipped_removed: Vec<String>,
}

fn is_truthy(value: Option<&String>) -> bool {
    value.is_some_and(|v| {
        matches!(
            v.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
}

/// TS `shouldBootstrapDefaultGlobalSkills`: on unless `COWORK_SKIP_DEFAULT_SKILLS_BOOTSTRAP` is
/// truthy or `COWORK_BOOTSTRAP_DEFAULT_SKILLS` is set to a non-truthy value.
pub fn should_bootstrap_default_global_skills(env: &HashMap<String, String>) -> bool {
    if is_truthy(env.get("COWORK_SKIP_DEFAULT_SKILLS_BOOTSTRAP")) {
        return false;
    }
    match env.get("COWORK_BOOTSTRAP_DEFAULT_SKILLS") {
        None => true,
        explicit => is_truthy(explicit),
    }
}

pub fn default_global_skills_state_file(cfg: &AgentConfig) -> PathBuf {
    cfg.user_cowork_dir
        .join("config")
        .join(DEFAULT_SKILLS_STATE_FILE)
}

pub fn default_global_skills_failure_file(cfg: &AgentConfig) -> PathBuf {
    cfg.user_cowork_dir
        .join("config")
        .join(DEFAULT_SKILLS_FAILURE_FILE)
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

fn read_state(path: &Path) -> Option<DefaultGlobalSkillsState> {
    read_json::<DefaultGlobalSkillsState>(path).filter(|s| s.version == INSTALL_STATE_VERSION)
}

fn read_failure_state(path: &Path) -> Option<DefaultGlobalSkillsFailureState> {
    read_json::<DefaultGlobalSkillsFailureState>(path)
        .filter(|s| s.version == FAILURE_STATE_VERSION)
}

fn write_failure_state(path: &Path, message: &str) {
    let state = DefaultGlobalSkillsFailureState {
        version: FAILURE_STATE_VERSION,
        failed_at: now_iso(),
        message: message.to_owned(),
    };
    // Best-effort: failure-state persistence must never mask the original bootstrap error.
    if let Ok(json) = serde_json::to_string_pretty(&state) {
        let _ = write_text_file_atomic(path, &format!("{json}\n"), None);
    }
}

fn clear_failure_state(path: &Path) {
    let _ = fs::remove_file(path);
}

fn is_within_failure_backoff(state: &DefaultGlobalSkillsFailureState) -> bool {
    DateTime::parse_from_rfc3339(&state.failed_at).is_ok_and(|failed_at| {
        Utc::now()
            .signed_duration_since(failed_at.with_timezone(&Utc))
            .to_std()
            .map_or(true, |elapsed| elapsed < BOOTSTRAP_FAILURE_BACKOFF)
    })
}

/// TS `mergeAndWriteState`: serialized read-modify-write that keeps disjoint plugin ids a
/// concurrent peer recorded while this call stays authoritative for the ids it evaluated.
fn merge_and_write_state(
    cfg: &AgentConfig,
    state_file: &Path,
    recorded: &BTreeSet<String>,
    requested: &[&str],
) -> Result<(), String> {
    with_file_lock_sync::<(), anyhow::Error, _>(
        state_file,
        || {
            let mut plugins: BTreeSet<String> = recorded.clone();
            if let Some(current) = read_state(state_file)
                && current.marketplace == BUILTIN_MARKETPLACE_ID
            {
                plugins.extend(
                    current
                        .plugins
                        .into_iter()
                        .filter(|id| !requested.contains(&id.as_str())),
                );
            }
            let state = DefaultGlobalSkillsState {
                version: INSTALL_STATE_VERSION,
                marketplace: BUILTIN_MARKETPLACE_ID.to_owned(),
                installed_at: now_iso(),
                plugins: plugins.into_iter().collect(),
            };
            write_text_file_atomic(
                state_file,
                &format!("{}\n", serde_json::to_string_pretty(&state)?),
                Some(0o600),
            )?;
            Ok(())
        },
        FileLockOptions {
            lock_root: Some(file_lock_root_for_cowork_home(&cfg.user_cowork_dir)),
            ..FileLockOptions::default()
        },
    )
    .map_err(|e| e.to_string())
}

/// TS `cleanupLegacyCoworkProductivitySkills`: once `workspace-tools` is recorded, remove the
/// runtime-bootstrapped legacy productivity skills it replaces (user-authored ones are kept).
fn cleanup_migrated_productivity_skills(cfg: &AgentConfig, recorded: &BTreeSet<String>) {
    if !recorded.contains("workspace-tools") {
        return;
    }
    for name in LEGACY_PRODUCTIVITY_SKILL_NAMES {
        let skill_root = cfg.user_cowork_dir.join("skills").join(name);
        let Some(metadata) = read_json::<Value>(&skill_root.join(".cowork-skill.json")) else {
            continue;
        };
        let bootstrap_origin = metadata
            .get("origin")
            .and_then(|o| o.get("kind"))
            .and_then(Value::as_str)
            == Some("bootstrap");
        let installation_id = metadata.get("installationId").and_then(Value::as_str);
        let managed = installation_id == Some(&format!("bootstrap-{name}"))
            || installation_id == Some(&format!("bootstrap-codex-primary-runtime-{name}"));
        if bootstrap_origin && managed && fs::remove_dir_all(&skill_root).is_ok() {
            tracing::info!(path = %skill_root.display(), "removed legacy Cowork skill");
        }
    }
}

/// TS `findLegacyRuntimeOwnedPluginIds`: user plugins the retired `codex-primary-runtime`
/// bootstrap installed, which the marketplace copy must replace.
fn is_legacy_runtime_owned(plugin_id: &str, root_dir: &str) -> bool {
    let Some(install) = read_json::<Value>(
        &Path::new(root_dir)
            .join(".cowork-plugin")
            .join("install.json"),
    ) else {
        return false;
    };
    let Some(bootstrap) = install.get("bootstrap") else {
        return false;
    };
    let bootstrap_plugin_id = bootstrap
        .get("pluginId")
        .and_then(Value::as_str)
        .unwrap_or(plugin_id);
    bootstrap.get("name").and_then(Value::as_str) == Some("codex-primary-runtime")
        && bootstrap_plugin_id == plugin_id
}

/// TS `ensureDefaultGlobalSkillsReady`: returns `None` when the bootstrap is disabled or failed
/// (the failure is logged and recorded for back-off, never propagated: startup still becomes
/// ready, matching TS).
pub async fn ensure_default_global_skills_ready(
    cfg: &AgentConfig,
    env: &HashMap<String, String>,
) -> Option<DefaultGlobalSkillsOutcome> {
    if !should_bootstrap_default_global_skills(env) {
        return None;
    }
    match ensure_default_global_skills_installed(cfg, env).await {
        Ok(outcome) => Some(outcome),
        Err(message) => {
            tracing::warn!(error = %message, "[default-skills] Default skill bootstrap failed");
            write_failure_state(&default_global_skills_failure_file(cfg), &message);
            None
        }
    }
}

async fn ensure_default_global_skills_installed(
    cfg: &AgentConfig,
    env: &HashMap<String, String>,
) -> Result<DefaultGlobalSkillsOutcome, String> {
    let requested = DEFAULT_MARKETPLACE_PLUGIN_IDS;
    let state_file = default_global_skills_state_file(cfg);
    let failure_file = default_global_skills_failure_file(cfg);
    let ext = ExtensionManager::new(env.clone());

    let overrides = read_plugin_overrides(cfg, PluginScope::User);
    let is_removed = |plugin_id: &str| {
        let canonical =
            canonical_default_marketplace_plugin_id_for_tombstone(plugin_id).unwrap_or(plugin_id);
        overrides
            .removed_default_plugins
            .iter()
            .any(|id| id == canonical)
    };
    let (installed_plugins, _) = ext.collect_installed_plugins(cfg);
    let user_installed = |plugin_id: &str| {
        installed_plugins.iter().any(|p| {
            p.id == plugin_id && p.scope == "user" && !is_legacy_runtime_owned(&p.id, &p.root_dir)
        })
    };

    if let Some(state) = read_state(&state_file)
        && state.marketplace == BUILTIN_MARKETPLACE_ID
        && requested.iter().all(|id| {
            state.plugins.iter().any(|p| p == id) && user_installed(id) && !is_removed(id)
        })
    {
        cleanup_migrated_productivity_skills(
            cfg,
            &requested.iter().map(|id| (*id).to_owned()).collect(),
        );
        clear_failure_state(&failure_file);
        return Ok(DefaultGlobalSkillsOutcome {
            installed: Vec::new(),
            skipped_existing: state.plugins,
            skipped_removed: Vec::new(),
        });
    }

    let mut outcome = DefaultGlobalSkillsOutcome {
        installed: Vec::new(),
        skipped_existing: Vec::new(),
        skipped_removed: Vec::new(),
    };
    let mut recorded = BTreeSet::new();
    let mut needing_install = Vec::new();
    for plugin_id in requested {
        if is_removed(plugin_id) {
            outcome.skipped_removed.push((*plugin_id).to_owned());
        } else if user_installed(plugin_id) {
            outcome.skipped_existing.push((*plugin_id).to_owned());
            recorded.insert((*plugin_id).to_owned());
        } else {
            needing_install.push(*plugin_id);
        }
    }

    let persist_state_and_cleanup = |recorded: &BTreeSet<String>| -> Result<(), String> {
        merge_and_write_state(cfg, &state_file, recorded, requested)?;
        cleanup_migrated_productivity_skills(cfg, recorded);
        clear_failure_state(&failure_file);
        Ok(())
    };

    if needing_install.is_empty() {
        persist_state_and_cleanup(&recorded)?;
        return Ok(outcome);
    }

    // Failed bootstraps back off before any network work so repeated workspace server starts
    // cannot burn the unauthenticated GitHub rate limit.
    if let Some(failure) = read_failure_state(&failure_file)
        && is_within_failure_backoff(&failure)
    {
        tracing::info!(
            failed_at = failure.failed_at.as_str(),
            "[default-skills] Default skill bootstrap skipped: last attempt failed; retrying after 30 minutes."
        );
        return Ok(outcome);
    }
    // The marketplace is downloaded from GitHub; offline hosts skip without recording a failure.
    if !is_network_allowed_for_github(env) {
        tracing::info!(
            "[default-skills] Default skill bootstrap skipped: network access is disabled."
        );
        return Ok(outcome);
    }

    tracing::info!(
        plugins_dir = %cfg.user_plugins_dir.display(),
        "[default-skills] Ensuring default marketplace plugins"
    );
    let marketplace = ext
        .read_marketplace_detail(cfg, BUILTIN_MARKETPLACE_ID)
        .await?;
    for plugin_id in needing_install {
        let Some(source) = marketplace
            .plugins
            .iter()
            .find(|p| p.name == plugin_id)
            .and_then(|p| p.install_source.clone())
        else {
            tracing::warn!(
                plugin_id,
                "[default-skills] Default marketplace plugin is not currently available."
            );
            continue;
        };
        ext.install_plugin_full(cfg, &source, "user", None, true, None)
            .await?;
        outcome.installed.push(plugin_id.to_owned());
        recorded.insert(plugin_id.to_owned());
    }

    persist_state_and_cleanup(&recorded)?;
    Ok(outcome)
}
