pub mod remote_source;
pub mod source_hash;
pub mod types;
pub mod watcher;

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

use chrono::Utc;
use cowork_config::{
    AgentConfig, FileLockOptions, file_lock_root_for_cowork_home, harden_private_file_sync,
    with_file_lock_sync, write_text_file_atomic,
};
use cowork_mcp::plugin_overrides::{
    PluginEnableOverride, PluginScope, discover_installed_plugin_roots, mutate_plugin_overrides,
    plugin_skill_override_key, read_plugin_overrides,
};
use cowork_tools::{
    DiscoveredSkill, SkillScope, discover_skills_for_config, parse_and_validate_skill_md,
};
use data_encoding::BASE64;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

pub use remote_source::{materialize_source, parse_extension_source};
pub use source_hash::{
    compute_source_root_hash, copy_dir_confined, unmanaged_skill_installation_id,
};
pub use types::*;
pub use watcher::SkillMutationBus;

pub const BUILTIN_MARKETPLACE_ID: &str = "mweinbach/cowork-skills-plugins";
pub const DEFAULT_MARKETPLACE_PATH: &str = ".agents/plugins/marketplace.json";

/// `~/.cowork/config/marketplaces.json` document version (TS `MARKETPLACES_FILE_VERSION`).
const MARKETPLACES_FILE_VERSION: u64 = 1;
/// TS `normalizePersistedEntry` substitutes `new Date(0).toISOString()` for a missing `addedAt`.
const MISSING_MARKETPLACE_ADDED_AT: &str = "1970-01-01T00:00:00.000Z";

/// A configured marketplace source (TS `ConfiguredMarketplace`).
///
/// The id is never trusted from disk: like TS `marketplaceIdForRepo`, it is always derived from
/// `repo` (trimmed, lowercased), so legacy TS files that never persisted `id` decode the same way
/// as Rust-written ones.
#[derive(Debug, Clone)]
struct StoredMarketplaceRecord {
    id: String,
    repo: String,
    git_ref: String,
    marketplace_path: String,
    built_in: bool,
    /// `None` only for the built-in marketplace (TS omits `addedAt` for it).
    added_at: Option<String>,
}

/// On-disk entry. A superset of TS `PersistedMarketplaceEntry` (`repo`, `ref`, `marketplacePath`,
/// `addedAt`): the extra `id` is ignored by TS and keeps earlier Rust builds of this file decoding.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedMarketplaceEntry<'a> {
    id: &'a str,
    repo: &'a str,
    #[serde(rename = "ref")]
    git_ref: &'a str,
    marketplace_path: &'a str,
    added_at: &'a str,
}

#[derive(Debug, Serialize)]
struct PersistedMarketplacesFile<'a> {
    version: u64,
    marketplaces: Vec<PersistedMarketplaceEntry<'a>>,
}

/// TS `marketplaceIdForRepo`.
fn marketplace_id_for_repo(repo: &str) -> String {
    repo.trim().to_lowercase()
}

/// TS `isValidRepoSlug`: `^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`.
fn is_valid_marketplace_repo_slug(repo: &str) -> bool {
    let valid_part = |part: &str| {
        !part.is_empty()
            && part
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
    };
    repo.split_once('/')
        .is_some_and(|(owner, name)| valid_part(owner) && valid_part(name))
}

fn non_empty_trimmed_str<'a>(
    record: &'a serde_json::Map<String, Value>,
    key: &str,
) -> Option<&'a str> {
    record
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// TS `normalizePersistedEntry`: one invalid element is skipped instead of failing the file.
fn normalize_persisted_marketplace_entry(value: &Value) -> Option<StoredMarketplaceRecord> {
    let record = value.as_object()?;
    let repo = record.get("repo").and_then(Value::as_str)?.trim();
    if !is_valid_marketplace_repo_slug(repo) {
        return None;
    }
    Some(StoredMarketplaceRecord {
        id: marketplace_id_for_repo(repo),
        repo: repo.to_owned(),
        git_ref: non_empty_trimmed_str(record, "ref")
            .unwrap_or("main")
            .to_owned(),
        marketplace_path: non_empty_trimmed_str(record, "marketplacePath")
            .unwrap_or(DEFAULT_MARKETPLACE_PATH)
            .to_owned(),
        built_in: false,
        added_at: Some(
            record
                .get("addedAt")
                .and_then(Value::as_str)
                .unwrap_or(MISSING_MARKETPLACE_ADDED_AT)
                .to_owned(),
        ),
    })
}

/// Decodes `marketplaces.json` (TS `readPersistedMarketplaces`), deduping by derived id and
/// dropping any entry that shadows the built-in marketplace.
///
/// Unlike TS, a document that is not JSON or has an unrecognized shape/version is an error rather
/// than an empty list, so read-modify-write callers never overwrite a file they could not read.
fn parse_marketplaces_document(raw: &str) -> Result<Vec<StoredMarketplaceRecord>, String> {
    let parsed: Value = serde_json::from_str(raw).map_err(|e| format!("invalid JSON: {e}"))?;
    let Some(record) = parsed.as_object() else {
        return Err("expected a JSON object".to_owned());
    };
    if let Some(version) = record.get("version")
        && version.as_f64() != Some(MARKETPLACES_FILE_VERSION as f64)
    {
        return Err(format!("unsupported version {version}"));
    }
    let candidates = match record.get("marketplaces") {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Array(items)) => items,
        Some(_) => return Err("`marketplaces` must be an array".to_owned()),
    };
    let builtin_id = marketplace_id_for_repo(BUILTIN_MARKETPLACE_ID);
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for candidate in candidates {
        let Some(entry) = normalize_persisted_marketplace_entry(candidate) else {
            continue;
        };
        if entry.id == builtin_id || !seen.insert(entry.id.clone()) {
            continue;
        }
        out.push(entry);
    }
    Ok(out)
}

fn marketplaces_file_path(cfg: &AgentConfig) -> PathBuf {
    cfg.user_cowork_dir.join("config").join("marketplaces.json")
}

/// A missing file is an empty registry; any other read failure or an undecodable document is an
/// error so that add/remove never clobber user marketplaces they could not read.
fn try_read_persisted_marketplaces(path: &Path) -> Result<Vec<StoredMarketplaceRecord>, String> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => {
            return Err(format!(
                "Failed to read marketplace registry at {}: {e}",
                path.display()
            ));
        }
    };
    parse_marketplaces_document(&raw).map_err(|e| {
        format!(
            "Invalid marketplace registry at {}: {e}. Fix or remove the file to continue.",
            path.display()
        )
    })
}

fn write_persisted_marketplaces(
    path: &Path,
    entries: &[StoredMarketplaceRecord],
) -> Result<(), String> {
    let doc = PersistedMarketplacesFile {
        version: MARKETPLACES_FILE_VERSION,
        marketplaces: entries
            .iter()
            .map(|m| PersistedMarketplaceEntry {
                id: &m.id,
                repo: &m.repo,
                git_ref: &m.git_ref,
                marketplace_path: &m.marketplace_path,
                added_at: m
                    .added_at
                    .as_deref()
                    .unwrap_or(MISSING_MARKETPLACE_ADDED_AT),
            })
            .collect(),
    };
    let serialized = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    write_text_file_atomic(path, &format!("{serialized}\n"), Some(0o600))
        .map_err(|e| e.to_string())?;
    harden_private_file_sync(path);
    Ok(())
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteMarketplaceJson {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    interface: Option<RemoteMarketplaceInterface>,
    #[serde(default)]
    plugins: Vec<RemoteMarketplacePluginItem>,
    #[serde(default)]
    skills: Vec<RemoteMarketplaceSkillItem>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteMarketplaceInterface {
    #[serde(default)]
    display_name: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteMarketplacePluginItem {
    name: String,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    source: Option<Value>,
    #[serde(default)]
    source_hash: Option<String>,
    #[serde(default)]
    authentication: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteMarketplaceSkillItem {
    name: String,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    source: Option<Value>,
    #[serde(default)]
    source_hash: Option<String>,
}

#[derive(Clone)]
pub struct ExtensionManager {
    env: HashMap<String, String>,
}

impl ExtensionManager {
    pub fn new(env: HashMap<String, String>) -> Self {
        Self { env }
    }

    pub fn homedir_for(cfg: &AgentConfig) -> PathBuf {
        cfg.user_cowork_dir
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| cfg.user_cowork_dir.clone())
    }

    fn run_locked<R, F>(&self, cfg: &AgentConfig, lock_name: &str, f: F) -> Result<R, String>
    where
        F: FnOnce() -> Result<R, String>,
    {
        let lock_target = cfg.user_cowork_dir.join("locks").join(lock_name);
        let lock_root = file_lock_root_for_cowork_home(&cfg.user_cowork_dir);
        with_file_lock_sync::<R, anyhow::Error, _>(
            &lock_target,
            || f().map_err(|m| anyhow::anyhow!(m)),
            FileLockOptions {
                lock_root: Some(lock_root),
                ..Default::default()
            },
        )
        .map_err(|e| e.to_string())
    }

    fn skill_scopes(cfg: &AgentConfig) -> Vec<SkillScopeDescriptor> {
        let builtin = cfg.built_in_dir.join("skills");
        let user_agents = cfg.user_agents_dir.join("skills");
        let global_cowork = cfg.user_cowork_dir.join("skills");
        let ws_claude = cfg.working_directory.join(".claude/skills");
        let ws_agents = cfg.workspace_agents_dir.join("skills");
        let ws_cowork = cfg.project_cowork_dir.join("skills");

        vec![
            SkillScopeDescriptor {
                scope: "built-in".to_owned(),
                skills_dir: builtin.to_string_lossy().into_owned(),
                disabled_skills_dir: None,
                writable: false,
                readable: builtin.is_dir(),
            },
            SkillScopeDescriptor {
                scope: "global".to_owned(),
                skills_dir: global_cowork.to_string_lossy().into_owned(),
                disabled_skills_dir: Some(
                    cfg.user_cowork_dir
                        .join("disabled-skills")
                        .to_string_lossy()
                        .into_owned(),
                ),
                writable: true,
                readable: true,
            },
            SkillScopeDescriptor {
                scope: "user".to_owned(),
                skills_dir: user_agents.to_string_lossy().into_owned(),
                disabled_skills_dir: Some(
                    cfg.user_agents_dir
                        .join("disabled-skills")
                        .to_string_lossy()
                        .into_owned(),
                ),
                writable: true,
                readable: user_agents.is_dir(),
            },
            SkillScopeDescriptor {
                scope: "project".to_owned(),
                skills_dir: ws_cowork.to_string_lossy().into_owned(),
                disabled_skills_dir: Some(
                    cfg.project_cowork_dir
                        .join("disabled-skills")
                        .to_string_lossy()
                        .into_owned(),
                ),
                writable: true,
                readable: true,
            },
            SkillScopeDescriptor {
                scope: "project".to_owned(),
                skills_dir: ws_agents.to_string_lossy().into_owned(),
                disabled_skills_dir: Some(
                    cfg.workspace_agents_dir
                        .join("disabled-skills")
                        .to_string_lossy()
                        .into_owned(),
                ),
                writable: true,
                readable: ws_agents.is_dir(),
            },
            SkillScopeDescriptor {
                scope: "project".to_owned(),
                skills_dir: ws_claude.to_string_lossy().into_owned(),
                disabled_skills_dir: Some(
                    cfg.working_directory
                        .join(".claude/disabled-skills")
                        .to_string_lossy()
                        .into_owned(),
                ),
                writable: true,
                readable: ws_claude.is_dir(),
            },
        ]
    }

    pub fn list_effective_skills(&self, cfg: &AgentConfig) -> Vec<SkillEntryWire> {
        let map = discover_skills_for_config(cfg);
        let (plugin_roots, _) = discover_installed_plugin_roots(cfg);
        map.into_values()
            .map(|s| {
                let plugin_owner = s.plugin_id.as_ref().and_then(|pid| {
                    plugin_roots
                        .iter()
                        .find(|r| &r.id == pid)
                        .map(|r| SkillPluginOwnerWire {
                            plugin_id: r.id.clone(),
                            name: r.name.clone(),
                            display_name: r.name.clone(),
                            scope: r.scope.as_str().to_owned(),
                            discovery_kind: r.discovery_kind.to_owned(),
                            root_dir: r.root_dir.to_string_lossy().into_owned(),
                        })
                });
                SkillEntryWire {
                    name: s.name,
                    path: s.skill_md_path.to_string_lossy().into_owned(),
                    source: s.scope.as_str().to_owned(),
                    enabled: s.enabled,
                    triggers: s.triggers,
                    description: s.description,
                    interface: s.interface,
                    plugin: plugin_owner,
                }
            })
            .collect()
    }

    pub fn read_skill_content(
        &self,
        cfg: &AgentConfig,
        skill_name: &str,
    ) -> Result<(SkillEntryWire, String), String> {
        let list = self.list_effective_skills(cfg);
        let entry = list
            .into_iter()
            .find(|s| s.name == skill_name)
            .ok_or_else(|| format!("Skill '{skill_name}' not found."))?;
        let raw = fs::read_to_string(&entry.path)
            .map_err(|e| format!("Failed reading skill '{}': {e}", entry.name))?;
        Ok((entry, raw))
    }

    pub fn read_skill_installation(
        &self,
        cfg: &AgentConfig,
        installation_id: &str,
    ) -> (Option<SkillInstallationEntry>, Option<String>) {
        let installations = self.collect_skill_installations(cfg);
        let Some(entry) = installations
            .into_iter()
            .find(|i| i.installation_id == installation_id)
        else {
            return (None, None);
        };
        let content = entry
            .skill_path
            .as_deref()
            .and_then(|p| fs::read_to_string(p).ok());
        (Some(entry), content)
    }

    pub fn collect_skill_installations(&self, cfg: &AgentConfig) -> Vec<SkillInstallationEntry> {
        let mut entries: Vec<SkillInstallationEntry> = Vec::new();

        let standalone_layers: Vec<(SkillScope, PathBuf, Option<PathBuf>, bool)> = vec![
            (
                SkillScope::Bundled,
                cfg.built_in_dir.join("skills"),
                None,
                false,
            ),
            (
                SkillScope::User,
                cfg.user_agents_dir.join("skills"),
                Some(cfg.user_agents_dir.join("disabled-skills")),
                true,
            ),
            (
                SkillScope::Global,
                cfg.user_cowork_dir.join("skills"),
                Some(cfg.user_cowork_dir.join("disabled-skills")),
                true,
            ),
        ];

        for (scope, active_dir, disabled_dir, writable) in standalone_layers {
            self.scan_standalone_skill_dir(cfg, scope, &active_dir, true, writable, &mut entries);
            if let Some(dis) = disabled_dir {
                self.scan_standalone_skill_dir(cfg, scope, &dis, false, writable, &mut entries);
            }
        }

        // User plugins then workspace plugins
        self.scan_plugin_skill_installations(cfg, PluginScope::User, &mut entries);
        self.scan_plugin_skill_installations(cfg, PluginScope::Workspace, &mut entries);

        // Workspace standalone layers
        for (active_dir, disabled_dir) in [
            (
                cfg.working_directory.join(".claude/skills"),
                cfg.working_directory.join(".claude/disabled-skills"),
            ),
            (
                cfg.workspace_agents_dir.join("skills"),
                cfg.workspace_agents_dir.join("disabled-skills"),
            ),
            (
                cfg.project_cowork_dir.join("skills"),
                cfg.project_cowork_dir.join("disabled-skills"),
            ),
        ] {
            self.scan_standalone_skill_dir(
                cfg,
                SkillScope::Project,
                &active_dir,
                true,
                true,
                &mut entries,
            );
            self.scan_standalone_skill_dir(
                cfg,
                SkillScope::Project,
                &disabled_dir,
                false,
                true,
                &mut entries,
            );
        }

        // Last enabled valid entry per skill name wins!
        let mut winner_by_name: BTreeMap<String, usize> = BTreeMap::new();
        for (idx, item) in entries.iter().enumerate() {
            if item.enabled && item.state != "invalid" {
                winner_by_name.insert(item.name.clone(), idx);
            }
        }

        let winner_meta: BTreeMap<String, (String, String)> = winner_by_name
            .iter()
            .map(|(k, &idx)| {
                (
                    k.clone(),
                    (
                        entries[idx].installation_id.clone(),
                        entries[idx].scope.clone(),
                    ),
                )
            })
            .collect();

        for (idx, item) in entries.iter_mut().enumerate() {
            if item.state == "invalid" {
                item.effective = false;
                continue;
            }
            if !item.enabled {
                item.state = "disabled".to_owned();
                item.effective = false;
                continue;
            }
            if winner_by_name.get(&item.name).copied() == Some(idx) {
                item.state = "effective".to_owned();
                item.effective = true;
            } else {
                item.state = "shadowed".to_owned();
                item.effective = false;
                if let Some((wid, wscope)) = winner_meta.get(&item.name) {
                    item.shadowed_by_installation_id = Some(wid.clone());
                    item.shadowed_by_scope = Some(wscope.clone());
                }
            }
        }

        entries
    }

    fn scan_standalone_skill_dir(
        &self,
        cfg: &AgentConfig,
        scope: SkillScope,
        dir: &Path,
        enabled: bool,
        writable: bool,
        out: &mut Vec<SkillInstallationEntry>,
    ) {
        let Ok(rd) = fs::read_dir(dir) else {
            return;
        };
        let mut subdirs: Vec<PathBuf> = rd
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                let name = p
                    .file_name()
                    .map(|n| n.to_string_lossy())
                    .unwrap_or_default();
                !name.starts_with('.') && p.is_dir()
            })
            .collect();
        subdirs.sort();

        let scope_str = scope.as_str().to_owned();
        let strict = scope != SkillScope::Bundled;

        for skill_dir in subdirs {
            let dir_name = skill_dir
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            if scope == SkillScope::Bundled {
                if dir_name == "task" && !cfg.tasks_enabled {
                    continue;
                }
                if dir_name == "memories" && !cfg.enable_memory {
                    continue;
                }
                if dir_name == "workflow" && !cfg.workflows_enabled {
                    continue;
                }
            }

            let skill_md = skill_dir.join("SKILL.md");
            let manifest_file = skill_dir.join(".cowork-skill.json");
            let manifest = fs::read_to_string(&manifest_file)
                .ok()
                .and_then(|s| serde_json::from_str::<SkillInstallManifest>(&s).ok());

            let installation_id = manifest
                .as_ref()
                .map(|m| m.installation_id.clone())
                .unwrap_or_else(|| {
                    if scope == SkillScope::Bundled {
                        format!("built-in:{dir_name}")
                    } else {
                        unmanaged_skill_installation_id(&scope_str, &skill_dir)
                    }
                });
            let origin = manifest
                .as_ref()
                .and_then(|m| m.origin.clone())
                .unwrap_or_else(|| SkillOriginMetadata {
                    kind: if scope == SkillScope::Bundled {
                        "bootstrap".to_owned()
                    } else {
                        "manual".to_owned()
                    },
                    url: None,
                    repo: None,
                    git_ref: None,
                    subdir: None,
                    source_path: Some(skill_dir.to_string_lossy().into_owned()),
                    source_hash: None,
                });
            let installed_hash = origin.source_hash.clone();
            let root_dir_str = skill_dir.to_string_lossy().into_owned();
            let skill_md_str = skill_md.to_string_lossy().into_owned();
            let manifest_path_opt = manifest
                .is_some()
                .then(|| manifest_file.to_string_lossy().into_owned());

            if !skill_md.is_file() {
                out.push(SkillInstallationEntry {
                    installation_id,
                    name: dir_name,
                    description: String::new(),
                    scope: scope_str.clone(),
                    enabled,
                    writable,
                    managed: manifest.is_some(),
                    effective: false,
                    state: "invalid".to_owned(),
                    root_dir: root_dir_str.clone(),
                    skill_path: None,
                    manifest_path: manifest_path_opt,
                    path: root_dir_str,
                    triggers: Vec::new(),
                    description_source: "unknown".to_owned(),
                    interface: None,
                    diagnostics: vec![SkillInstallationDiagnostic {
                        code: "missing_skill_md".to_owned(),
                        severity: "error".to_owned(),
                        message: "Skill directory is missing SKILL.md.".to_owned(),
                    }],
                    origin: Some(origin),
                    installed_at: manifest.as_ref().map(|m| m.installed_at.clone()),
                    updated_at: manifest.as_ref().map(|m| m.updated_at.clone()),
                    manifest,
                    shadowed_by_installation_id: None,
                    shadowed_by_scope: None,
                    plugin: None,
                    installed_source_hash: installed_hash,
                    latest_source_hash: None,
                    update_available: Some(false),
                    update_check_reason: None,
                });
                continue;
            }

            let raw = match fs::read_to_string(&skill_md) {
                Ok(s) => s,
                Err(e) => {
                    out.push(SkillInstallationEntry {
                        installation_id,
                        name: dir_name,
                        description: String::new(),
                        scope: scope_str.clone(),
                        enabled,
                        writable,
                        managed: manifest.is_some(),
                        effective: false,
                        state: "invalid".to_owned(),
                        root_dir: root_dir_str,
                        skill_path: Some(skill_md_str.clone()),
                        manifest_path: manifest_path_opt,
                        path: skill_md_str,
                        triggers: Vec::new(),
                        description_source: "unknown".to_owned(),
                        interface: None,
                        diagnostics: vec![SkillInstallationDiagnostic {
                            code: "read_error".to_owned(),
                            severity: "error".to_owned(),
                            message: e.to_string(),
                        }],
                        origin: Some(origin),
                        installed_at: manifest.as_ref().map(|m| m.installed_at.clone()),
                        updated_at: manifest.as_ref().map(|m| m.updated_at.clone()),
                        manifest,
                        shadowed_by_installation_id: None,
                        shadowed_by_scope: None,
                        plugin: None,
                        installed_source_hash: installed_hash,
                        latest_source_hash: None,
                        update_available: Some(false),
                        update_check_reason: None,
                    });
                    continue;
                }
            };

            match parse_and_validate_skill_md(&skill_dir, &skill_md, &raw, scope, strict) {
                Ok(parsed) => {
                    out.push(SkillInstallationEntry {
                        installation_id,
                        name: parsed.name,
                        description: parsed.description,
                        scope: scope_str.clone(),
                        enabled,
                        writable,
                        managed: manifest.is_some(),
                        effective: false,
                        state: if enabled {
                            "effective".to_owned()
                        } else {
                            "disabled".to_owned()
                        },
                        root_dir: root_dir_str,
                        skill_path: Some(skill_md_str.clone()),
                        manifest_path: manifest_path_opt,
                        path: skill_md_str,
                        triggers: parsed.triggers,
                        description_source: "frontmatter".to_owned(),
                        interface: parsed.interface,
                        diagnostics: Vec::new(),
                        origin: Some(origin),
                        installed_at: manifest.as_ref().map(|m| m.installed_at.clone()),
                        updated_at: manifest.as_ref().map(|m| m.updated_at.clone()),
                        manifest,
                        shadowed_by_installation_id: None,
                        shadowed_by_scope: None,
                        plugin: None,
                        installed_source_hash: installed_hash,
                        latest_source_hash: None,
                        update_available: Some(false),
                        update_check_reason: None,
                    });
                }
                Err(msg) => {
                    out.push(SkillInstallationEntry {
                        installation_id,
                        name: dir_name,
                        description: String::new(),
                        scope: scope_str.clone(),
                        enabled,
                        writable,
                        managed: manifest.is_some(),
                        effective: false,
                        state: "invalid".to_owned(),
                        root_dir: root_dir_str,
                        skill_path: Some(skill_md_str.clone()),
                        manifest_path: manifest_path_opt,
                        path: skill_md_str,
                        triggers: Vec::new(),
                        description_source: "unknown".to_owned(),
                        interface: None,
                        diagnostics: vec![SkillInstallationDiagnostic {
                            code: "invalid_frontmatter".to_owned(),
                            severity: "error".to_owned(),
                            message: msg,
                        }],
                        origin: Some(origin),
                        installed_at: manifest.as_ref().map(|m| m.installed_at.clone()),
                        updated_at: manifest.as_ref().map(|m| m.updated_at.clone()),
                        manifest,
                        shadowed_by_installation_id: None,
                        shadowed_by_scope: None,
                        plugin: None,
                        installed_source_hash: installed_hash,
                        latest_source_hash: None,
                        update_available: Some(false),
                        update_check_reason: None,
                    });
                }
            }
        }
    }

    fn scan_plugin_skill_installations(
        &self,
        cfg: &AgentConfig,
        plugin_scope: PluginScope,
        out: &mut Vec<SkillInstallationEntry>,
    ) {
        let (plugins, _) = discover_installed_plugin_roots(cfg);
        let overrides = read_plugin_overrides(cfg, plugin_scope);
        let (skill_scope, scope_label) = match plugin_scope {
            PluginScope::Workspace => (SkillScope::Project, "project"),
            PluginScope::User => (SkillScope::User, "user"),
        };
        for plugin in plugins.into_iter().filter(|p| p.scope == plugin_scope) {
            let skills_dir = plugin.root_dir.join(&plugin.skills_rel_path);
            let Ok(rd) = fs::read_dir(&skills_dir) else {
                continue;
            };
            let mut dirs: Vec<PathBuf> = rd
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect();
            dirs.sort();
            let owner = SkillPluginOwnerWire {
                plugin_id: plugin.id.clone(),
                name: plugin.name.clone(),
                display_name: plugin.name.clone(),
                scope: plugin.scope.as_str().to_owned(),
                discovery_kind: plugin.discovery_kind.to_owned(),
                root_dir: plugin.root_dir.to_string_lossy().into_owned(),
            };
            for sdir in dirs {
                let skill_md = sdir.join("SKILL.md");
                let Ok(raw) = fs::read_to_string(&skill_md) else {
                    continue;
                };
                let Ok(parsed) =
                    parse_and_validate_skill_md(&sdir, &skill_md, &raw, skill_scope, true)
                else {
                    continue;
                };
                let qualified_name = format!("{}:{}", plugin.name, parsed.name);
                let ov_key = plugin_skill_override_key(&plugin.id, &parsed.name);
                let skill_enabled = plugin.enabled
                    && overrides
                        .skills
                        .get(&ov_key)
                        .or_else(|| overrides.skills.get(&qualified_name))
                        .map(|o| o.enabled)
                        .unwrap_or(true);
                let skill_md_str = skill_md.to_string_lossy().into_owned();
                out.push(SkillInstallationEntry {
                    installation_id: format!(
                        "plugin:{}:{}:{}",
                        plugin.scope.as_str(),
                        plugin.id,
                        parsed.name
                    ),
                    name: qualified_name,
                    description: parsed.description,
                    scope: scope_label.to_owned(),
                    enabled: skill_enabled,
                    writable: false,
                    managed: false,
                    effective: false,
                    state: if skill_enabled {
                        "effective".to_owned()
                    } else {
                        "disabled".to_owned()
                    },
                    root_dir: sdir.to_string_lossy().into_owned(),
                    skill_path: Some(skill_md_str.clone()),
                    manifest_path: None,
                    path: skill_md_str,
                    triggers: parsed.triggers,
                    description_source: "frontmatter".to_owned(),
                    interface: parsed.interface,
                    diagnostics: Vec::new(),
                    origin: Some(SkillOriginMetadata {
                        kind: "local".to_owned(),
                        url: None,
                        repo: None,
                        git_ref: None,
                        subdir: None,
                        source_path: Some(plugin.root_dir.to_string_lossy().into_owned()),
                        source_hash: None,
                    }),
                    manifest: None,
                    shadowed_by_installation_id: None,
                    shadowed_by_scope: None,
                    installed_at: None,
                    updated_at: None,
                    plugin: Some(owner.clone()),
                    installed_source_hash: None,
                    latest_source_hash: None,
                    update_available: Some(false),
                    update_check_reason: None,
                });
            }
        }
    }

    pub async fn read_skills_catalog(
        &self,
        cfg: &AgentConfig,
        _force_refresh: bool,
    ) -> Result<SkillCatalogSnapshot, String> {
        let (snap, _partial) = self.read_skills_catalog_with_meta(cfg).await?;
        Ok(snap)
    }

    pub async fn read_skills_catalog_with_meta(
        &self,
        cfg: &AgentConfig,
    ) -> Result<(SkillCatalogSnapshot, bool), String> {
        let mut installations = self.collect_skill_installations(cfg);
        let (_mps, _mp_plugs, available_skills, _warnings, partial) =
            self.load_all_marketplaces(cfg).await;

        for avail in &available_skills {
            for inst in &mut installations {
                if inst.name == avail.name
                    && let (Some(remote_h), Some(local_h)) =
                        (&avail.marketplace.source_hash, &inst.installed_source_hash)
                {
                    inst.latest_source_hash = Some(remote_h.clone());
                    inst.update_available = Some(remote_h != local_h);
                }
            }
        }

        let installed_names: BTreeSet<String> =
            installations.iter().map(|i| i.name.clone()).collect();
        let filtered_available: Vec<MarketplaceSkillCatalogEntry> = available_skills
            .into_iter()
            .filter(|a| !installed_names.contains(&a.name))
            .collect();

        let effective_skills: Vec<SkillInstallationEntry> = installations
            .iter()
            .filter(|i| i.effective)
            .cloned()
            .collect();

        Ok((
            SkillCatalogSnapshot {
                scopes: Self::skill_scopes(cfg),
                effective_skills,
                installations,
                available_skills: filtered_available,
            },
            partial,
        ))
    }

    pub async fn preview_skill_install(
        &self,
        cfg: &AgentConfig,
        source: &str,
        target_scope: &str,
    ) -> Result<SkillInstallPreview, String> {
        validate_skill_target_scope(target_scope)?;
        let homedir = Self::homedir_for(cfg);
        let mat = materialize_source(source, &cfg.working_directory, &homedir, &self.env).await?;
        let discovered = discover_skill_candidates_in_tree(&mat.root_dir)?;
        if discovered.is_empty() {
            return Err(format!("No valid SKILL.md found in source '{source}'."));
        }
        let existing = self.collect_skill_installations(cfg);
        let mut candidates = Vec::new();
        for (rel_subdir, _skill_dir, parsed) in discovered {
            let conflict = existing
                .iter()
                .find(|i| i.scope == target_scope && i.name == parsed.name);
            let shadowed: Vec<String> = existing
                .iter()
                .filter(|i| i.name == parsed.name && i.scope != target_scope)
                .map(|i| i.installation_id.clone())
                .collect();
            let would_be_effective = target_scope == "project"
                || !existing
                    .iter()
                    .any(|i| i.scope == "project" && i.enabled && i.name == parsed.name);
            candidates.push(SkillInstallPreviewCandidate {
                name: parsed.name,
                description: parsed.description,
                relative_root_path: rel_subdir.unwrap_or_else(|| ".".to_owned()),
                conflicts_with_installation_id: conflict.map(|c| c.installation_id.clone()),
                conflicts_with_scope: conflict.map(|c| c.scope.clone()),
                would_be_effective,
                shadowed_installation_ids: shadowed,
                diagnostics: Vec::new(),
            });
        }
        Ok(SkillInstallPreview {
            source: mat.descriptor,
            target_scope: target_scope.to_owned(),
            candidates,
            warnings: Vec::new(),
        })
    }

    pub async fn install_skill(
        &self,
        cfg: &AgentConfig,
        source: &str,
        target_scope: &str,
    ) -> Result<SkillCatalogSnapshot, String> {
        self.install_skill_with_selection(cfg, source, target_scope, None, true)
            .await
    }

    pub async fn install_skill_with_selection(
        &self,
        cfg: &AgentConfig,
        source: &str,
        target_scope: &str,
        selected_names: Option<&[String]>,
        overwrite: bool,
    ) -> Result<SkillCatalogSnapshot, String> {
        validate_skill_target_scope(target_scope)?;
        let homedir = Self::homedir_for(cfg);
        let mat = materialize_source(source, &cfg.working_directory, &homedir, &self.env).await?;
        let candidates = discover_skill_candidates_in_tree(&mat.root_dir)?;
        if candidates.is_empty() {
            return Err(format!("No valid SKILL.md found in source '{source}'."));
        }

        let target_base = match target_scope {
            "global" => cfg.user_cowork_dir.join("skills"),
            "project" => cfg.project_cowork_dir.join("skills"),
            other => return Err(format!("Unsupported skill install scope: {other}")),
        };

        self.run_locked(cfg, "skills-install", || {
            fs::create_dir_all(&target_base).map_err(|e| e.to_string())?;
            for (rel_subdir, cand_dir, parsed) in &candidates {
                if let Some(sel) = selected_names
                    && !sel.is_empty()
                    && !sel.iter().any(|n| n == &parsed.name)
                {
                    continue;
                }
                let final_dir = confined_install_path(&target_base, &parsed.name)?;
                if final_dir.exists() && !overwrite {
                    return Err(format!(
                        "Skill '{}' is already installed in {} scope.",
                        parsed.name, target_scope
                    ));
                }
                let src_hash = compute_source_root_hash(cand_dir)?;
                let staging = confined_install_path(
                    &target_base,
                    &format!(".incoming-{}-{}", parsed.name, Uuid::new_v4()),
                )?;
                copy_dir_confined(cand_dir, &staging)?;

                let now = Utc::now().to_rfc3339();
                let mut origin = mat.origin.clone();
                if let Some(sub) = rel_subdir {
                    origin.subdir = Some(match origin.subdir {
                        Some(prefix) => format!("{prefix}/{sub}"),
                        None => sub.clone(),
                    });
                }
                origin.source_hash = Some(src_hash);

                let existing_id = final_dir
                    .join(".cowork-skill.json")
                    .exists()
                    .then(|| {
                        fs::read_to_string(final_dir.join(".cowork-skill.json"))
                            .ok()
                            .and_then(|s| serde_json::from_str::<SkillInstallManifest>(&s).ok())
                            .map(|m| m.installation_id)
                    })
                    .flatten();

                let manifest = SkillInstallManifest {
                    version: 1,
                    installation_id: existing_id.unwrap_or_else(|| Uuid::new_v4().to_string()),
                    installed_at: now.clone(),
                    updated_at: now,
                    origin: Some(origin),
                };
                let manifest_path = staging.join(".cowork-skill.json");
                write_text_file_atomic(
                    &manifest_path,
                    &format!(
                        "{}\n",
                        serde_json::to_string_pretty(&manifest).unwrap_or_default()
                    ),
                    Some(0o600),
                )
                .map_err(|e| e.to_string())?;
                harden_private_file_sync(&manifest_path);

                if final_dir.exists() {
                    fs::remove_dir_all(&final_dir).map_err(|e| e.to_string())?;
                }
                fs::rename(&staging, &final_dir).map_err(|e| e.to_string())?;
            }
            Ok(())
        })?;

        self.read_skills_catalog(cfg, false).await
    }

    pub fn set_skill_installation_enabled(
        &self,
        cfg: &AgentConfig,
        installation_id: &str,
        enabled: bool,
    ) -> Result<(), String> {
        if let Some(rest) = installation_id.strip_prefix("plugin:") {
            let parts: Vec<&str> = rest.splitn(3, ':').collect();
            if parts.len() != 3 {
                return Err(format!(
                    "Invalid plugin skill installationId: {installation_id}"
                ));
            }
            let (scope_str, plugin_id, raw_name) = (parts[0], parts[1], parts[2]);
            let plugin_scope = PluginScope::parse(scope_str)
                .ok_or_else(|| format!("Invalid plugin scope '{scope_str}'"))?;
            let key = plugin_skill_override_key(plugin_id, raw_name);
            mutate_plugin_overrides(cfg, plugin_scope, |ov| {
                ov.skills.insert(key, PluginEnableOverride { enabled });
            })?;
            return Ok(());
        }

        let installations = self.collect_skill_installations(cfg);
        let entry = installations
            .into_iter()
            .find(|i| i.installation_id == installation_id)
            .ok_or_else(|| format!("Skill installation '{installation_id}' not found."))?;
        if !entry.writable {
            return Err(format!(
                "Skill '{}' in scope '{}' is read-only.",
                entry.name, entry.scope
            ));
        }
        if entry.enabled == enabled {
            return Ok(());
        }

        let cur_dir = PathBuf::from(&entry.root_dir);
        let parent = cur_dir
            .parent()
            .and_then(Path::parent)
            .ok_or_else(|| "Invalid skill directory hierarchy".to_owned())?;
        let target_parent = if enabled {
            parent.join("skills")
        } else {
            parent.join("disabled-skills")
        };
        let dir_name = cur_dir
            .file_name()
            .ok_or_else(|| "Missing skill folder name".to_owned())?
            .to_os_string();
        let dst = target_parent.join(dir_name);

        self.run_locked(cfg, "skills-toggle", || {
            fs::create_dir_all(&target_parent).map_err(|e| e.to_string())?;
            if dst.exists() {
                return Err(format!("Destination '{}' already exists.", dst.display()));
            }
            fs::rename(&cur_dir, &dst).map_err(|e| e.to_string())
        })
    }

    pub fn enable_skill_by_name(&self, cfg: &AgentConfig, name: &str) -> Result<(), String> {
        let installations = self.collect_skill_installations(cfg);
        let candidate = installations
            .iter()
            .rev()
            .find(|i| {
                i.name == name
                    && !i.enabled
                    && (i.writable || i.installation_id.starts_with("plugin:"))
            })
            .or_else(|| installations.iter().rev().find(|i| i.name == name))
            .ok_or_else(|| format!("Skill '{name}' not found."))?;
        self.set_skill_installation_enabled(cfg, &candidate.installation_id, true)
    }

    pub fn disable_skill_by_name(&self, cfg: &AgentConfig, name: &str) -> Result<(), String> {
        let installations = self.collect_skill_installations(cfg);
        let candidate = installations
            .iter()
            .rev()
            .find(|i| {
                i.name == name
                    && i.enabled
                    && (i.writable || i.installation_id.starts_with("plugin:"))
            })
            .or_else(|| installations.iter().rev().find(|i| i.name == name))
            .ok_or_else(|| format!("Skill '{name}' not found."))?;
        self.set_skill_installation_enabled(cfg, &candidate.installation_id, false)
    }

    pub fn delete_skill_by_name(&self, cfg: &AgentConfig, name: &str) -> Result<(), String> {
        let installations = self.collect_skill_installations(cfg);
        let candidate = installations
            .iter()
            .rev()
            .find(|i| i.name == name && i.writable)
            .ok_or_else(|| format!("Writable skill '{name}' not found."))?;
        self.delete_skill_installation(cfg, &candidate.installation_id)
    }

    pub fn delete_skill_installation(
        &self,
        cfg: &AgentConfig,
        installation_id: &str,
    ) -> Result<(), String> {
        let installations = self.collect_skill_installations(cfg);
        let entry = installations
            .into_iter()
            .find(|i| i.installation_id == installation_id)
            .ok_or_else(|| format!("Skill installation '{installation_id}' not found."))?;
        if !entry.writable || entry.scope == "built-in" {
            return Err(format!("Skill '{}' cannot be deleted.", entry.name));
        }
        self.run_locked(cfg, "skills-delete", || {
            fs::remove_dir_all(&entry.root_dir)
                .map_err(|e| format!("Failed deleting skill '{}': {e}", entry.name))
        })
    }

    pub fn copy_skill_installation(
        &self,
        cfg: &AgentConfig,
        installation_id: &str,
        target_scope: &str,
        overwrite: bool,
    ) -> Result<(), String> {
        validate_skill_target_scope(target_scope)?;
        let installations = self.collect_skill_installations(cfg);
        let entry = installations
            .into_iter()
            .find(|i| i.installation_id == installation_id)
            .ok_or_else(|| format!("Skill installation '{installation_id}' not found."))?;
        // TS `copySkillInstallationToScope`: a same-scope copy would delete the source before
        // copying it, so it is rejected up front.
        let same_scope_error = || {
            format!(
                "Cannot copy \"{}\" into the {target_scope} scope because it already lives there; that would delete the source before copying.",
                entry.name
            )
        };
        if entry.scope == target_scope {
            return Err(same_scope_error());
        }
        let target_base = match target_scope {
            "global" => cfg.user_cowork_dir.join("skills"),
            "project" => cfg.project_cowork_dir.join("skills"),
            other => return Err(format!("Unsupported targetScope: {other}")),
        };
        fs::create_dir_all(&target_base).map_err(|e| e.to_string())?;
        let dst = confined_install_path(&target_base, &entry.name)?;
        let src_dir = PathBuf::from(&entry.root_dir);
        // Scopes can still alias on disk (symlinked skill roots), so also compare the resolved
        // directories: replacing `dst` must never remove (part of) the source being copied.
        let canonical_src = fs::canonicalize(&src_dir)
            .map_err(|e| format!("failed to canonicalize {}: {e}", src_dir.display()))?;
        let canonical_dst = fs::canonicalize(&target_base)
            .map_err(|e| format!("Invalid install root: {e}"))?
            .join(&entry.name);
        let canonical_dst = fs::canonicalize(&canonical_dst).unwrap_or(canonical_dst);
        if canonical_src == canonical_dst {
            return Err(same_scope_error());
        }
        if canonical_src.starts_with(&canonical_dst) || canonical_dst.starts_with(&canonical_src) {
            return Err(format!(
                "Cannot copy \"{}\" into the {target_scope} scope because the source and destination directories overlap.",
                entry.name
            ));
        }
        if dst.exists() && !overwrite {
            return Err(format!(
                "Skill '{}' already exists in {target_scope} scope.",
                entry.name
            ));
        }
        let hash = compute_source_root_hash(&src_dir)?;
        let now = Utc::now().to_rfc3339();
        let manifest = SkillInstallManifest {
            version: 1,
            installation_id: Uuid::new_v4().to_string(),
            installed_at: now.clone(),
            updated_at: now,
            origin: Some(SkillOriginMetadata {
                kind: "local".to_owned(),
                url: None,
                repo: None,
                git_ref: None,
                subdir: None,
                source_path: Some(src_dir.to_string_lossy().into_owned()),
                source_hash: Some(hash),
            }),
        };
        self.run_locked(cfg, "skills-copy", || {
            stage_and_swap_skill_root(&src_dir, &target_base, &entry.name, &manifest)
        })
    }

    pub async fn check_skill_installation_update(
        &self,
        cfg: &AgentConfig,
        installation_id: &str,
    ) -> Result<SkillUpdateCheckResult, String> {
        let installations = self.collect_skill_installations(cfg);
        let entry = installations
            .into_iter()
            .find(|i| i.installation_id == installation_id)
            .ok_or_else(|| format!("Skill installation '{installation_id}' not found."))?;
        if !entry.managed {
            return Ok(SkillUpdateCheckResult {
                installation_id: installation_id.to_owned(),
                can_update: false,
                reason: Some("Unmanaged skill installations cannot check for updates.".to_owned()),
                preview: None,
                installed_source_hash: entry.installed_source_hash,
                latest_source_hash: None,
            });
        }
        let current_hash = compute_source_root_hash(Path::new(&entry.root_dir))
            .ok()
            .or(entry.installed_source_hash.clone());
        let remote_src = entry
            .origin
            .as_ref()
            .and_then(reconstruct_origin_source)
            .ok_or_else(|| "Skill installation has no remote/local source URL.".to_owned())?;
        let homedir = Self::homedir_for(cfg);
        let mat =
            materialize_source(&remote_src, &cfg.working_directory, &homedir, &self.env).await?;
        let remote_hash = compute_source_root_hash(&mat.root_dir)?;
        let can_update = current_hash.as_deref() != Some(remote_hash.as_str());
        Ok(SkillUpdateCheckResult {
            installation_id: installation_id.to_owned(),
            can_update,
            reason: (!can_update).then(|| "Already up to date.".to_owned()),
            preview: None,
            installed_source_hash: current_hash,
            latest_source_hash: Some(remote_hash),
        })
    }

    /// TS `updateSkillInstallation`: re-materializes the recorded source and replaces the
    /// installation **in place**: same directory (so a disabled installation stays under
    /// `disabled-skills/`), same installation id and `installedAt`, refreshed origin/source hash.
    pub async fn update_skill_installation(
        &self,
        cfg: &AgentConfig,
        installation_id: &str,
    ) -> Result<SkillCatalogSnapshot, String> {
        let installations = self.collect_skill_installations(cfg);
        let entry = installations
            .into_iter()
            .find(|i| i.installation_id == installation_id)
            .ok_or_else(|| format!("Skill installation '{installation_id}' not found."))?;
        if entry.plugin.is_some() || entry.installation_id.starts_with("plugin:") {
            return Err(
                "Plugin-owned skills are read-only and cannot be updated in phase 1.".to_owned(),
            );
        }
        if !entry.writable || entry.scope == SkillScope::Bundled.as_str() {
            return Err("This installation is read-only and cannot be updated directly".to_owned());
        }
        // Unmanaged installations only carry a synthesized `manual` origin pointing at
        // themselves, which TS `installSourceFromOrigin` does not treat as an update source.
        let remote_src = entry
            .origin
            .as_ref()
            .filter(|o| entry.managed && o.kind != "manual")
            .and_then(reconstruct_origin_source)
            .ok_or_else(|| "No update source is recorded for this installation".to_owned())?;

        let install_root = PathBuf::from(&entry.root_dir);
        let parent = install_root
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| "Invalid skill directory hierarchy".to_owned())?;
        let dir_name = install_root
            .file_name()
            .and_then(|n| n.to_str())
            .map(str::to_owned)
            .ok_or_else(|| "Missing skill folder name".to_owned())?;
        let expected_parent = if entry.enabled {
            "skills"
        } else {
            "disabled-skills"
        };
        if parent.file_name().and_then(|n| n.to_str()) != Some(expected_parent) {
            return Err(format!(
                "Refusing to update skill '{}' outside a {expected_parent}/ directory.",
                entry.name
            ));
        }
        let dest_meta = fs::symlink_metadata(confined_install_path(&parent, &dir_name)?)
            .map_err(|e| format!("Failed reading skill '{}': {e}", entry.name))?;
        if !dest_meta.file_type().is_dir() {
            return Err(format!(
                "Refusing to update skill '{}' because its installation directory is not a real directory.",
                entry.name
            ));
        }
        let homedir = Self::homedir_for(cfg);
        let mat =
            materialize_source(&remote_src, &cfg.working_directory, &homedir, &self.env).await?;
        let candidates = discover_skill_candidates_in_tree(&mat.root_dir)?;
        let mut matching = candidates.iter().filter(|(_, _, p)| p.name == entry.name);
        let (rel_subdir, cand_dir, _) = match (matching.next(), matching.next()) {
            (Some(only), None) => only,
            (Some(_), Some(_)) => {
                return Err(format!(
                    "The update source contains more than one valid skill named \"{}\". Split the source or remove duplicates so each skill name is unique.",
                    entry.name
                ));
            }
            (None, _) => {
                return Err(format!(
                    "Recorded skill \"{}\" was not found in the update source.",
                    entry.name
                ));
            }
        };
        let src_hash = compute_source_root_hash(cand_dir)?;
        let mut origin = mat.origin.clone();
        if let Some(sub) = rel_subdir {
            origin.subdir = Some(match origin.subdir {
                Some(prefix) => format!("{prefix}/{sub}"),
                None => sub.clone(),
            });
        }
        origin.source_hash = Some(src_hash);
        let now = Utc::now().to_rfc3339();
        let manifest = SkillInstallManifest {
            version: 1,
            installation_id: entry.installation_id.clone(),
            installed_at: entry.installed_at.clone().unwrap_or_else(|| now.clone()),
            updated_at: now,
            origin: Some(origin),
        };

        self.run_locked(cfg, "skills-install", || {
            // Staged beside the installation: hidden `.incoming-*` siblings are skipped by both
            // the catalog scan and `copy_dir_confined`, so an overlapping source is safe.
            stage_and_swap_skill_root(cand_dir, &parent, &dir_name, &manifest)
        })?;
        drop(mat);

        self.read_skills_catalog(cfg, false).await
    }

    // =========================================================================
    // Plugins (`cowork/plugins/*`)
    // =========================================================================

    pub async fn read_plugins_catalog(
        &self,
        cfg: &AgentConfig,
        _force_refresh: bool,
    ) -> Result<PluginCatalogSnapshot, String> {
        let (snap, _partial) = self.read_plugins_catalog_with_meta(cfg).await?;
        Ok(snap)
    }

    pub async fn read_plugins_catalog_with_meta(
        &self,
        cfg: &AgentConfig,
    ) -> Result<(PluginCatalogSnapshot, bool), String> {
        let (mut plugins, mut warnings) = self.collect_installed_plugins(cfg);
        let (_mps, available_plugins, _avail_skills, mp_warnings, partial) =
            self.load_all_marketplaces(cfg).await;
        warnings.extend(mp_warnings);

        for avail in &available_plugins {
            for p in &mut plugins {
                if p.name == avail.name
                    && let (Some(rem), Some(cur)) =
                        (&avail.marketplace.source_hash, &p.installed_source_hash)
                {
                    p.latest_source_hash = Some(rem.clone());
                    p.update_available = Some(rem != cur);
                }
            }
        }

        let installed_names: BTreeSet<String> = plugins.iter().map(|p| p.name.clone()).collect();
        let filtered_available: Vec<MarketplacePluginCatalogEntry> = available_plugins
            .into_iter()
            .filter(|a| !installed_names.contains(&a.name))
            .collect();

        Ok((
            PluginCatalogSnapshot {
                plugins,
                available_plugins: filtered_available,
                warnings,
            },
            partial,
        ))
    }

    pub fn collect_installed_plugins(
        &self,
        cfg: &AgentConfig,
    ) -> (Vec<InstalledPluginCatalogEntry>, Vec<String>) {
        let (roots, warnings) = discover_installed_plugin_roots(cfg);
        let ws_overrides = read_plugin_overrides(cfg, PluginScope::Workspace);
        let user_overrides = read_plugin_overrides(cfg, PluginScope::User);

        let mut out = Vec::new();
        for root in roots {
            let overrides = match root.scope {
                PluginScope::Workspace => &ws_overrides,
                PluginScope::User => &user_overrides,
            };
            let manifest_json = read_plugin_manifest_json(&root.root_dir);
            let install_manifest = read_plugin_install_manifest(&root.root_dir);

            let interface_obj = manifest_json.get("interface").and_then(Value::as_object);
            let display_name = interface_obj
                .and_then(|i| i.get("displayName"))
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| root.name.clone());
            let category = interface_obj
                .and_then(|i| i.get("category"))
                .and_then(Value::as_str)
                .map(str::to_owned);
            let brand_color = interface_obj
                .and_then(|i| i.get("brandColor"))
                .and_then(Value::as_str)
                .map(str::to_owned);
            let composer_icon = interface_obj
                .and_then(|i| i.get("composerIcon").or_else(|| i.get("iconSmall")))
                .and_then(Value::as_str)
                .and_then(|rel| encode_plugin_icon(&root.root_dir, rel));
            let logo = interface_obj
                .and_then(|i| i.get("logo").or_else(|| i.get("iconLarge")))
                .and_then(Value::as_str)
                .and_then(|rel| encode_plugin_icon(&root.root_dir, rel));
            let default_prompt = match interface_obj.and_then(|i| i.get("defaultPrompt")) {
                Some(Value::String(s)) => Some(vec![s.clone()]),
                Some(Value::Array(arr)) => Some(
                    arr.iter()
                        .filter_map(Value::as_str)
                        .take(3)
                        .map(str::to_owned)
                        .collect(),
                ),
                _ => None,
            };

            let skills_dir = root.root_dir.join(&root.skills_rel_path);
            let mcp_file = root.root_dir.join(&root.mcp_rel_path);
            let skills_summaries = build_plugin_skill_summaries(
                &skills_dir,
                &root.id,
                &root.name,
                root.enabled,
                overrides,
            );
            let mcp_names = list_plugin_mcp_names(&mcp_file);

            let author_name = match manifest_json.get("author") {
                Some(Value::String(s)) => Some(s.clone()),
                Some(Value::Object(o)) => o.get("name").and_then(Value::as_str).map(str::to_owned),
                _ => None,
            };

            out.push(InstalledPluginCatalogEntry {
                id: root.id,
                name: root.name,
                display_name: display_name.clone(),
                description: root.description,
                scope: root.scope.as_str().to_owned(),
                discovery_kind: root.discovery_kind.to_owned(),
                installed: true,
                enabled: root.enabled,
                root_dir: root.root_dir.to_string_lossy().into_owned(),
                manifest_path: root.manifest_path.to_string_lossy().into_owned(),
                skills_path: skills_dir.to_string_lossy().into_owned(),
                mcp_path: mcp_file
                    .is_file()
                    .then(|| mcp_file.to_string_lossy().into_owned()),
                version: root.version,
                author_name,
                homepage: manifest_json
                    .get("homepage")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                repository: manifest_json
                    .get("repository")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                license: manifest_json
                    .get("license")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                keywords: manifest_json
                    .get("keywords")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(Value::as_str)
                            .map(str::to_owned)
                            .collect()
                    }),
                interface: Some(PluginInterfaceWire {
                    display_name: Some(display_name),
                    short_description: interface_obj
                        .and_then(|i| i.get("shortDescription"))
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    long_description: interface_obj
                        .and_then(|i| i.get("longDescription"))
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    developer_name: interface_obj
                        .and_then(|i| i.get("developerName"))
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    category,
                    default_prompt,
                    brand_color,
                    composer_icon,
                    logo,
                }),
                marketplace: install_manifest
                    .as_ref()
                    .and_then(|m| m.marketplace.clone()),
                install_source: install_manifest
                    .as_ref()
                    .and_then(|m| reconstruct_origin_source(&m.source)),
                installed_source_hash: install_manifest
                    .as_ref()
                    .and_then(|m| m.source_hash.clone()),
                latest_source_hash: None,
                update_available: Some(false),
                update_check_reason: None,
                skills: skills_summaries,
                mcp_servers: mcp_names,
                apps: Vec::new(),
                warnings: Vec::new(),
            });
        }
        (out, warnings)
    }

    pub async fn read_plugin_detail(
        &self,
        cfg: &AgentConfig,
        plugin_id: &str,
        scope: Option<&str>,
    ) -> Result<Option<InstalledPluginCatalogEntry>, String> {
        let cat = self.read_plugins_catalog(cfg, false).await?;
        Ok(cat
            .plugins
            .into_iter()
            .find(|p| p.id == plugin_id && scope.is_none_or(|s| p.scope == s)))
    }

    pub async fn preview_plugin_install(
        &self,
        cfg: &AgentConfig,
        source: &str,
        target_scope: &str,
    ) -> Result<PluginInstallPreview, String> {
        validate_plugin_target_scope(target_scope)?;
        let homedir = Self::homedir_for(cfg);
        let mat = materialize_source(source, &cfg.working_directory, &homedir, &self.env).await?;
        let found = discover_plugin_candidates_in_tree(&mat.root_dir)?;
        if found.is_empty() {
            return Err(format!("No valid plugin manifest found in '{source}'."));
        }
        let (installed, _) = self.collect_installed_plugins(cfg);
        let mut candidates = Vec::new();
        for (subdir, _pdir, manifest) in found {
            let name = manifest
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("plugin")
                .to_owned();
            let display_name = manifest
                .get("interface")
                .and_then(|i| i.get("displayName"))
                .and_then(Value::as_str)
                .unwrap_or(&name)
                .to_owned();
            let description = manifest
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            let mut diagnostics = Vec::new();
            if !is_valid_plugin_name(&name) {
                diagnostics.push(SkillInstallationDiagnostic {
                    code: "invalid_plugin_name".to_owned(),
                    severity: "error".to_owned(),
                    message: format!(
                        "Plugin name '{name}' is not a valid kebab-case identifier; it cannot be installed."
                    ),
                });
            }
            let conflict = installed
                .iter()
                .find(|p| p.scope == target_scope && (p.id == name || p.name == name));
            let would_be_primary = target_scope == "workspace"
                || !installed
                    .iter()
                    .any(|p| p.scope == "workspace" && p.enabled && p.id == name);
            candidates.push(PluginInstallPreviewCandidate {
                plugin_id: name,
                display_name,
                description,
                relative_root_path: subdir.unwrap_or_else(|| ".".to_owned()),
                conflicts_with_plugin_id: conflict.map(|c| c.id.clone()),
                conflicts_with_scope: conflict.map(|c| c.scope.clone()),
                would_be_primary,
                diagnostics,
            });
        }
        let mut desc = mat.descriptor;
        if desc.kind == "skills.sh" {
            desc.kind = "github_shorthand".to_owned();
        }
        Ok(PluginInstallPreview {
            source: desc,
            target_scope: target_scope.to_owned(),
            candidates,
            warnings: Vec::new(),
        })
    }

    pub async fn install_plugin(
        &self,
        cfg: &AgentConfig,
        source: &str,
        target_scope: &str,
    ) -> Result<PluginCatalogSnapshot, String> {
        self.install_plugin_full(cfg, source, target_scope, None, true, None)
            .await
    }

    pub async fn install_plugin_full(
        &self,
        cfg: &AgentConfig,
        source: &str,
        target_scope: &str,
        selected_ids: Option<&[String]>,
        overwrite: bool,
        expected_source_hash: Option<&str>,
    ) -> Result<PluginCatalogSnapshot, String> {
        validate_plugin_target_scope(target_scope)?;
        let homedir = Self::homedir_for(cfg);
        let mat = materialize_source(source, &cfg.working_directory, &homedir, &self.env).await?;
        let found = discover_plugin_candidates_in_tree(&mat.root_dir)?;
        if found.is_empty() {
            return Err(format!("No valid plugin manifest found in '{source}'."));
        }
        let target_base = match target_scope {
            "user" => cfg.user_plugins_dir.clone(),
            "workspace" => cfg.workspace_plugins_dir.clone(),
            other => return Err(format!("Invalid plugin targetScope: {other}")),
        };

        self.run_locked(cfg, "plugins-install", || {
            fs::create_dir_all(&target_base).map_err(|e| e.to_string())?;
            for (rel_subdir, pdir, manifest) in &found {
                let name = manifest
                    .get("name")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "Plugin manifest missing name".to_owned())?;
                if let Some(sel) = selected_ids
                    && !sel.is_empty()
                    && !sel.iter().any(|s| s == name)
                {
                    continue;
                }
                if !is_valid_plugin_name(name) {
                    return Err(format!(
                        "Invalid plugin name '{name}'; expected lowercase alphanumeric words separated by single hyphens."
                    ));
                }
                let computed_hash = compute_source_root_hash(pdir)?;
                if let Some(exp) = expected_source_hash
                    && exp != computed_hash
                {
                    return Err(format!(
                        "Plugin sourceHash mismatch: expected {exp}, got {computed_hash}"
                    ));
                }
                let final_dir = confined_install_path(&target_base, name)?;
                if final_dir.exists() && !overwrite {
                    return Err(format!(
                        "Plugin '{name}' is already installed in {target_scope} scope."
                    ));
                }
                let staging = confined_install_path(
                    &target_base,
                    &format!(".incoming-{name}-{}", Uuid::new_v4()),
                )?;
                copy_dir_confined(pdir, &staging)?;

                let now = Utc::now().to_rfc3339();
                let mut origin = mat.origin.clone();
                if let Some(sub) = rel_subdir {
                    origin.subdir = Some(match origin.subdir {
                        Some(p) => format!("{p}/{sub}"),
                        None => sub.clone(),
                    });
                }
                origin.source_hash = Some(computed_hash.clone());
                let install_record = PluginInstallManifest {
                    version: 1,
                    installed_at: now.clone(),
                    updated_at: now,
                    source: origin,
                    source_hash: Some(computed_hash),
                    marketplace: None,
                };
                let install_dir = staging.join(".cowork-plugin");
                fs::create_dir_all(&install_dir).map_err(|e| e.to_string())?;
                let install_file = install_dir.join("install.json");
                write_text_file_atomic(
                    &install_file,
                    &format!(
                        "{}\n",
                        serde_json::to_string_pretty(&install_record).unwrap_or_default()
                    ),
                    Some(0o600),
                )
                .map_err(|e| e.to_string())?;
                harden_private_file_sync(&install_file);
                if final_dir.exists() {
                    fs::remove_dir_all(&final_dir).map_err(|e| e.to_string())?;
                }
                fs::rename(&staging, &final_dir).map_err(|e| e.to_string())?;
            }
            Ok(())
        })?;

        self.read_plugins_catalog(cfg, false).await
    }

    pub async fn check_plugin_update(
        &self,
        cfg: &AgentConfig,
        plugin_id: &str,
        scope: Option<&str>,
    ) -> Result<PluginUpdateCheckResult, String> {
        let (plugins, _) = self.collect_installed_plugins(cfg);
        let entry = plugins
            .into_iter()
            .find(|p| p.id == plugin_id && scope.is_none_or(|s| p.scope == s))
            .ok_or_else(|| format!("Plugin '{plugin_id}' not found."))?;
        let Some(ref remote_src) = entry.install_source else {
            return Ok(PluginUpdateCheckResult {
                plugin_id: entry.id,
                scope: Some(entry.scope),
                can_update: false,
                reason: Some("Unmanaged plugin cannot check for updates.".to_owned()),
                preview: None,
                installed_source_hash: entry.installed_source_hash,
                latest_source_hash: None,
            });
        };
        let homedir = Self::homedir_for(cfg);
        let mat =
            materialize_source(remote_src, &cfg.working_directory, &homedir, &self.env).await?;
        let remote_hash = compute_source_root_hash(&mat.root_dir)?;
        let current_hash = entry
            .installed_source_hash
            .clone()
            .or_else(|| compute_source_root_hash(Path::new(&entry.root_dir)).ok());
        let can_update = current_hash.as_deref() != Some(remote_hash.as_str());
        Ok(PluginUpdateCheckResult {
            plugin_id: entry.id,
            scope: Some(entry.scope),
            can_update,
            reason: (!can_update).then(|| "Already up to date.".to_owned()),
            preview: None,
            installed_source_hash: current_hash,
            latest_source_hash: Some(remote_hash),
        })
    }

    pub async fn update_plugin(
        &self,
        cfg: &AgentConfig,
        plugin_id: &str,
        scope: Option<&str>,
    ) -> Result<PluginCatalogSnapshot, String> {
        let (plugins, _) = self.collect_installed_plugins(cfg);
        let entry = plugins
            .into_iter()
            .find(|p| p.id == plugin_id && scope.is_none_or(|s| p.scope == s))
            .ok_or_else(|| format!("Plugin '{plugin_id}' not found."))?;
        let remote_src = entry
            .install_source
            .ok_or_else(|| "Unmanaged plugin cannot be updated.".to_owned())?;
        self.install_plugin_full(
            cfg,
            &remote_src,
            &entry.scope,
            Some(std::slice::from_ref(&entry.name)),
            true,
            None,
        )
        .await
    }

    pub fn set_plugin_enabled(
        &self,
        cfg: &AgentConfig,
        plugin_id: &str,
        scope: Option<&str>,
        enabled: bool,
    ) -> Result<(), String> {
        let (plugins, _) = self.collect_installed_plugins(cfg);
        let entry = plugins
            .into_iter()
            .find(|p| p.id == plugin_id && scope.is_none_or(|s| p.scope == s))
            .ok_or_else(|| format!("Plugin '{plugin_id}' not found."))?;
        let pscope = PluginScope::parse(&entry.scope).unwrap_or(PluginScope::Workspace);
        mutate_plugin_overrides(cfg, pscope, |ov| {
            ov.plugins
                .insert(entry.id.clone(), PluginEnableOverride { enabled });
        })
    }

    pub fn delete_plugin(
        &self,
        cfg: &AgentConfig,
        plugin_id: &str,
        scope: Option<&str>,
    ) -> Result<(), String> {
        let (plugins, _) = self.collect_installed_plugins(cfg);
        let entry = plugins
            .into_iter()
            .find(|p| p.id == plugin_id && scope.is_none_or(|s| p.scope == s))
            .ok_or_else(|| format!("Plugin '{plugin_id}' not found."))?;
        let root_path = PathBuf::from(&entry.root_dir);
        self.run_locked(cfg, "plugins-delete", || {
            fs::remove_dir_all(&root_path)
                .map_err(|e| format!("Failed removing plugin '{}': {e}", entry.id))
        })?;
        let pscope = PluginScope::parse(&entry.scope).unwrap_or(PluginScope::Workspace);
        let _ = mutate_plugin_overrides(cfg, pscope, |ov| {
            ov.plugins.remove(&entry.id);
        });
        Ok(())
    }

    // =========================================================================
    // Marketplaces (`cowork/marketplaces/*`)
    // =========================================================================

    /// TS `listConfiguredMarketplaces`: the built-in marketplace followed by persisted entries.
    /// An unreadable registry lists as empty (TS parity) but is left untouched on disk.
    fn read_stored_marketplaces(&self, cfg: &AgentConfig) -> Vec<StoredMarketplaceRecord> {
        let path = marketplaces_file_path(cfg);
        let persisted = try_read_persisted_marketplaces(&path).unwrap_or_else(|error| {
            tracing::warn!(path = %path.display(), %error, "ignoring unreadable marketplace registry");
            Vec::new()
        });
        let builtin = StoredMarketplaceRecord {
            id: marketplace_id_for_repo(BUILTIN_MARKETPLACE_ID),
            repo: BUILTIN_MARKETPLACE_ID.to_owned(),
            git_ref: "main".to_owned(),
            marketplace_path: DEFAULT_MARKETPLACE_PATH.to_owned(),
            built_in: true,
            added_at: None,
        };
        let mut out = vec![builtin];
        out.extend(persisted);
        out
    }

    pub async fn read_marketplaces(
        &self,
        cfg: &AgentConfig,
    ) -> Result<Vec<MarketplaceCatalogEntry>, String> {
        let (mps, _, _, _, _) = self.load_all_marketplaces(cfg).await;
        Ok(mps)
    }

    pub async fn read_marketplace_detail(
        &self,
        cfg: &AgentConfig,
        id: &str,
    ) -> Result<MarketplaceDetail, String> {
        let records = self.read_stored_marketplaces(cfg);
        let wanted = marketplace_id_for_repo(id);
        let rec = records
            .into_iter()
            .find(|m| m.id == wanted)
            .ok_or_else(|| format!("Marketplace '{id}' not found."))?;
        let (entry, plugins, skills) = self.fetch_single_marketplace(rec).await;
        if let Some(ref err) = entry.fetch_error {
            return Err(err.clone());
        }
        let (installed_plugins, _) = self.collect_installed_plugins(cfg);
        let installed_skills = self.collect_skill_installations(cfg);

        let detail_plugins = plugins
            .into_iter()
            .map(|p| {
                let inst = installed_plugins.iter().find(|ip| ip.name == p.name);
                MarketplaceDetailPluginEntry {
                    name: p.name,
                    display_name: p.display_name,
                    category: p.marketplace.category,
                    installed: inst.is_some(),
                    enabled: inst.map(|i| i.enabled),
                    install_source: Some(p.install_source),
                    skills: Vec::new(),
                    mcp_servers: Vec::new(),
                }
            })
            .collect();

        let detail_skills = skills
            .into_iter()
            .map(|s| {
                let inst = installed_skills.iter().find(|is| is.name == s.name);
                MarketplaceDetailSkillEntry {
                    name: s.name,
                    display_name: s.display_name,
                    category: Some(s.category),
                    installed: inst.is_some(),
                    enabled: inst.map(|i| i.enabled),
                    install_source: Some(s.install_source),
                }
            })
            .collect();

        Ok(MarketplaceDetail {
            source: entry,
            plugins: detail_plugins,
            skills: detail_skills,
            connectors: Vec::new(),
        })
    }

    pub async fn add_marketplace(
        &self,
        cfg: &AgentConfig,
        input: MarketplaceSourceInput,
    ) -> Result<Vec<MarketplaceCatalogEntry>, String> {
        let repo = normalize_marketplace_repo(&input.source)?;
        // Same defaults/trimming as the TS read path, so the stored record round-trips unchanged.
        let git_ref = input
            .git_ref
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("main")
            .to_owned();
        let mp_path = input
            .marketplace_path
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(DEFAULT_MARKETPLACE_PATH)
            .to_owned();

        let id = marketplace_id_for_repo(&repo);
        if id == marketplace_id_for_repo(BUILTIN_MARKETPLACE_ID) {
            return Err(format!(
                "Marketplace \"{repo}\" is the built-in marketplace and is always available."
            ));
        }
        let cfg_path = marketplaces_file_path(cfg);
        if try_read_persisted_marketplaces(&cfg_path)?
            .iter()
            .any(|m| m.id == id)
        {
            return Err(format!("Marketplace \"{repo}\" is already configured."));
        }

        let record = StoredMarketplaceRecord {
            id,
            repo,
            git_ref,
            marketplace_path: mp_path,
            built_in: false,
            added_at: Some(Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
        };

        let (entry, _, _) = self.fetch_single_marketplace(record.clone()).await;
        if let Some(err) = entry.fetch_error {
            return Err(format!(
                "Failed to validate marketplace '{}': {err}",
                record.repo
            ));
        }

        self.run_locked(cfg, "marketplaces-json", || {
            let mut existing = try_read_persisted_marketplaces(&cfg_path)?;
            if existing.iter().any(|m| m.id == record.id) {
                return Err(format!(
                    "Marketplace \"{}\" is already configured.",
                    record.repo
                ));
            }
            existing.push(record.clone());
            write_persisted_marketplaces(&cfg_path, &existing)
        })?;

        self.read_marketplaces(cfg).await
    }

    pub async fn remove_marketplace(
        &self,
        cfg: &AgentConfig,
        id: &str,
    ) -> Result<Vec<MarketplaceCatalogEntry>, String> {
        let wanted = marketplace_id_for_repo(id);
        if wanted == marketplace_id_for_repo(BUILTIN_MARKETPLACE_ID) {
            return Err("Built-in marketplace cannot be removed.".to_owned());
        }
        let cfg_path = marketplaces_file_path(cfg);
        self.run_locked(cfg, "marketplaces-json", || {
            let existing = try_read_persisted_marketplaces(&cfg_path)?;
            let before = existing.len();
            let remaining: Vec<_> = existing.into_iter().filter(|m| m.id != wanted).collect();
            if remaining.len() == before {
                return Err(format!("Marketplace \"{id}\" is not configured."));
            }
            write_persisted_marketplaces(&cfg_path, &remaining)
        })?;
        self.read_marketplaces(cfg).await
    }

    async fn load_all_marketplaces(
        &self,
        cfg: &AgentConfig,
    ) -> (
        Vec<MarketplaceCatalogEntry>,
        Vec<MarketplacePluginCatalogEntry>,
        Vec<MarketplaceSkillCatalogEntry>,
        Vec<String>,
        bool,
    ) {
        let records = self.read_stored_marketplaces(cfg);
        let mut entries = Vec::new();
        let mut all_plugins = Vec::new();
        let mut all_skills = Vec::new();
        let mut warnings = Vec::new();
        let mut partial = false;

        for rec in records {
            let (entry, plugs, sks) = self.fetch_single_marketplace(rec).await;
            if let Some(ref err) = entry.fetch_error {
                partial = true;
                warnings.push(format!("Marketplace '{}': {err}", entry.id));
            }
            entries.push(entry);
            all_plugins.extend(plugs);
            all_skills.extend(sks);
        }

        (entries, all_plugins, all_skills, warnings, partial)
    }

    async fn fetch_single_marketplace(
        &self,
        rec: StoredMarketplaceRecord,
    ) -> (
        MarketplaceCatalogEntry,
        Vec<MarketplacePluginCatalogEntry>,
        Vec<MarketplaceSkillCatalogEntry>,
    ) {
        let url = format!("https://github.com/{}", rec.repo);
        let Some((owner, repo_name)) = rec.repo.split_once('/') else {
            return (
                MarketplaceCatalogEntry {
                    id: rec.id,
                    repo: rec.repo,
                    git_ref: rec.git_ref,
                    url,
                    marketplace_path: rec.marketplace_path,
                    built_in: rec.built_in,
                    display_name: None,
                    plugin_count: Some(0),
                    skill_count: Some(0),
                    fetch_error: Some("Invalid owner/repo".to_owned()),
                    added_at: rec.added_at,
                },
                Vec::new(),
                Vec::new(),
            );
        };

        let raw_res = remote_source::fetch_github_raw_text(
            &self.env,
            owner,
            repo_name,
            &rec.git_ref,
            &rec.marketplace_path,
        )
        .await;

        let raw_text = match raw_res {
            Ok(t) => t,
            Err(err) => {
                return (
                    MarketplaceCatalogEntry {
                        id: rec.id,
                        repo: rec.repo,
                        git_ref: rec.git_ref,
                        url,
                        marketplace_path: rec.marketplace_path,
                        built_in: rec.built_in,
                        display_name: None,
                        plugin_count: Some(0),
                        skill_count: Some(0),
                        fetch_error: Some(err),
                        added_at: rec.added_at,
                    },
                    Vec::new(),
                    Vec::new(),
                );
            }
        };

        let parsed: RemoteMarketplaceJson = match serde_json::from_str(&raw_text) {
            Ok(v) => v,
            Err(e) => {
                return (
                    MarketplaceCatalogEntry {
                        id: rec.id,
                        repo: rec.repo,
                        git_ref: rec.git_ref,
                        url,
                        marketplace_path: rec.marketplace_path,
                        built_in: rec.built_in,
                        display_name: None,
                        plugin_count: Some(0),
                        skill_count: Some(0),
                        fetch_error: Some(format!("Invalid marketplace.json: {e}")),
                        added_at: rec.added_at,
                    },
                    Vec::new(),
                    Vec::new(),
                );
            }
        };

        let mp_name = parsed.name.clone().unwrap_or_else(|| rec.id.clone());
        let mp_disp = parsed.interface.and_then(|i| i.display_name);

        let mut plugins = Vec::new();
        for p in parsed.plugins {
            let install_source = resolve_marketplace_item_install_source(
                &rec.repo,
                &rec.git_ref,
                p.source.as_ref(),
                &format!("plugins/{}", p.name),
            );
            let display_name = p.display_name.clone().unwrap_or_else(|| p.name.clone());
            plugins.push(MarketplacePluginCatalogEntry {
                id: format!("{}@{}", p.name, mp_name),
                name: p.name,
                display_name,
                description: p.description.unwrap_or_default(),
                scope: "user".to_owned(),
                discovery_kind: "marketplace".to_owned(),
                installed: false,
                enabled: false,
                interface: None,
                marketplace: MarketplaceMetadataWire {
                    name: mp_name.clone(),
                    display_name: mp_disp.clone(),
                    category: p.category,
                    installation_policy: None,
                    authentication_policy: p.authentication,
                    source_hash: p.source_hash,
                },
                install_source,
                warnings: Vec::new(),
            });
        }

        let mut skills = Vec::new();
        for s in parsed.skills {
            let install_source = resolve_marketplace_item_install_source(
                &rec.repo,
                &rec.git_ref,
                s.source.as_ref(),
                &format!("skills/{}", s.name),
            );
            let display_name = s.display_name.clone().unwrap_or_else(|| s.name.clone());
            let category = s.category.unwrap_or_else(|| "General".to_owned());
            skills.push(MarketplaceSkillCatalogEntry {
                id: format!("{}@{}", s.name, mp_name),
                name: s.name,
                display_name,
                description: s.description.unwrap_or_default(),
                category: category.clone(),
                scope: "user".to_owned(),
                discovery_kind: "marketplace".to_owned(),
                installed: false,
                enabled: false,
                interface: None,
                marketplace: MarketplaceMetadataWire {
                    name: mp_name.clone(),
                    display_name: mp_disp.clone(),
                    category: Some(category),
                    installation_policy: None,
                    authentication_policy: None,
                    source_hash: s.source_hash,
                },
                install_source,
                warnings: Vec::new(),
            });
        }

        let entry = MarketplaceCatalogEntry {
            id: rec.id,
            repo: rec.repo,
            git_ref: rec.git_ref,
            url,
            marketplace_path: rec.marketplace_path,
            built_in: rec.built_in,
            display_name: mp_disp.or(Some(mp_name)),
            plugin_count: Some(plugins.len()),
            skill_count: Some(skills.len()),
            fetch_error: None,
            added_at: rec.added_at,
        };
        (entry, plugins, skills)
    }
}

fn validate_skill_target_scope(scope: &str) -> Result<(), String> {
    if scope == "global" || scope == "project" {
        Ok(())
    } else {
        Err(format!(
            "Invalid skill targetScope '{scope}'; expected 'global' or 'project'."
        ))
    }
}

fn validate_plugin_target_scope(scope: &str) -> Result<(), String> {
    if scope == "user" || scope == "workspace" {
        Ok(())
    } else {
        Err(format!(
            "Invalid plugin targetScope '{scope}'; expected 'user' or 'workspace'."
        ))
    }
}

/// Plugin ids become install directory names, so they must be kebab-case: the same rule the
/// original TypeScript manifest schema enforced (`/^[a-z0-9]+(?:-[a-z0-9]+)*$/`).
pub fn is_valid_plugin_name(name: &str) -> bool {
    !name.is_empty()
        && name.split('-').all(|seg| {
            !seg.is_empty()
                && seg
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        })
}

/// Join one directory-name component onto an install root and prove the result is a direct
/// child of that root. Independent of any name validation done by the caller: rejects empty,
/// `.`/`..`, absolute paths and anything containing a path separator, then re-checks the joined
/// path (lexically and against the canonical root) so a later change to name validation cannot
/// reintroduce a traversal.
fn confined_install_path(base: &Path, child: &str) -> Result<PathBuf, String> {
    let reject = || format!("Refusing unsafe install directory name '{child}'.");
    if child.is_empty()
        || child == "."
        || child == ".."
        || child.contains(['/', '\\', '\0'])
        || Path::new(child).is_absolute()
    {
        return Err(reject());
    }
    let joined = base.join(child);
    let mut tail = joined
        .strip_prefix(base)
        .map_err(|_| reject())?
        .components();
    match (tail.next(), tail.next()) {
        (Some(std::path::Component::Normal(c)), None) if c == std::ffi::OsStr::new(child) => {}
        _ => return Err(reject()),
    }
    if joined.parent() != Some(base) {
        return Err(reject());
    }
    // The root itself must exist (callers create it first); its canonical form plus the single
    // validated component must still be inside it once symlinks in the root path are resolved.
    let canonical_base =
        fs::canonicalize(base).map_err(|e| format!("Invalid install root: {e}"))?;
    let canonical_joined = canonical_base.join(child);
    if canonical_joined.parent() != Some(canonical_base.as_path()) {
        return Err(reject());
    }
    Ok(joined)
}

/// Copies `src` into a hidden `.incoming-*` sibling under `base`, writes `manifest` into it, then
/// swaps it into `base/<dir_name>`. Any existing root is first moved to a `.backup-*` sibling,
/// restored if the swap fails and removed once it succeeds, so a failed copy never loses the
/// previous installation (TS `replacePluginInstallRoot`).
fn stage_and_swap_skill_root(
    src: &Path,
    base: &Path,
    dir_name: &str,
    manifest: &SkillInstallManifest,
) -> Result<(), String> {
    let destination = confined_install_path(base, dir_name)?;
    let staging = confined_install_path(base, &format!(".incoming-{dir_name}-{}", Uuid::new_v4()))?;
    let staged = copy_dir_confined(src, &staging).and_then(|()| {
        let manifest_path = staging.join(".cowork-skill.json");
        write_text_file_atomic(
            &manifest_path,
            &format!(
                "{}\n",
                serde_json::to_string_pretty(manifest).unwrap_or_default()
            ),
            Some(0o600),
        )
        .map_err(|e| e.to_string())?;
        harden_private_file_sync(&manifest_path);
        Ok(())
    });
    if let Err(e) = staged {
        let _ = fs::remove_dir_all(&staging);
        return Err(e);
    }

    let backup = if fs::symlink_metadata(&destination).is_ok() {
        let backup =
            confined_install_path(base, &format!(".backup-{dir_name}-{}", Uuid::new_v4()))?;
        if let Err(e) = fs::rename(&destination, &backup) {
            let _ = fs::remove_dir_all(&staging);
            return Err(format!("Failed replacing skill '{dir_name}': {e}"));
        }
        Some(backup)
    } else {
        None
    };
    if let Err(e) = fs::rename(&staging, &destination) {
        if let Some(backup) = &backup {
            let _ = fs::rename(backup, &destination);
        }
        let _ = fs::remove_dir_all(&staging);
        return Err(format!("Failed replacing skill '{dir_name}': {e}"));
    }
    if let Some(backup) = backup {
        // The new root is live; a leftover hidden backup is harmless and skipped by scans.
        let _ = remove_path_entry(&backup);
    }
    Ok(())
}

/// Removes a directory tree, or a file/symlink, without following a symlink at `path`.
fn remove_path_entry(path: &Path) -> std::io::Result<()> {
    if fs::symlink_metadata(path)?.file_type().is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
}

fn discover_skill_candidates_in_tree(
    root: &Path,
) -> Result<Vec<(Option<String>, PathBuf, DiscoveredSkill)>, String> {
    let root_md = root.join("SKILL.md");
    if root_md.is_file() {
        let raw = fs::read_to_string(&root_md).map_err(|e| e.to_string())?;
        // Root dir name in temp staging may be random (`cowork-gh-src-...`), so validate via parsed name slug!
        let parsed = parse_candidate_skill_md(root, &root_md, &raw, false)?;
        return Ok(vec![(None, root.to_path_buf(), parsed)]);
    }

    let mut out: Vec<(Option<String>, PathBuf, DiscoveredSkill)> = Vec::new();
    for base in [root.to_path_buf(), root.join("skills")] {
        let Ok(rd) = fs::read_dir(&base) else {
            continue;
        };
        let mut dirs: Vec<PathBuf> = rd
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .collect();
        dirs.sort();
        for dir in dirs {
            let md = dir.join("SKILL.md");
            if !md.is_file() {
                continue;
            }
            if let Ok(raw) = fs::read_to_string(&md)
                && let Ok(parsed) = parse_candidate_skill_md(&dir, &md, &raw, true)
            {
                let rel = dir
                    .strip_prefix(root)
                    .ok()
                    .map(|p| p.to_string_lossy().replace('\\', "/"));
                if !out.iter().any(|(_, _, p)| p.name == parsed.name) {
                    out.push((rel, dir, parsed));
                }
            }
        }
    }
    Ok(out)
}

fn parse_candidate_skill_md(
    dir: &Path,
    skill_md: &Path,
    raw: &str,
    enforce_dir_match: bool,
) -> Result<DiscoveredSkill, String> {
    if enforce_dir_match {
        return parse_and_validate_skill_md(dir, skill_md, raw, SkillScope::Global, true);
    }
    // Single-skill root: copy/alias check by parsing without dir-name mismatch, then enforcing frontmatter slug
    let (yaml_opt, _) = cowork_tools::split_yaml_frontmatter(raw);
    let yaml = yaml_opt.ok_or_else(|| "Missing YAML frontmatter in SKILL.md.".to_owned())?;
    let fm: cowork_tools::ParsedSkillFrontmatter =
        serde_saphyr::from_str(&yaml).map_err(|e| format!("Invalid YAML frontmatter: {e}"))?;
    let slug = fm
        .name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "SKILL.md frontmatter missing 'name'.".to_owned())?;
    if !cowork_tools::is_valid_skill_slug(slug) {
        return Err(format!("Invalid skill name slug '{slug}'."));
    }
    if fm
        .description
        .as_deref()
        .map(str::trim)
        .unwrap_or_default()
        .is_empty()
    {
        return Err("SKILL.md frontmatter missing 'description'.".to_owned());
    }
    parse_and_validate_skill_md(dir, skill_md, raw, SkillScope::Bundled, false)
}

fn discover_plugin_candidates_in_tree(
    root: &Path,
) -> Result<Vec<(Option<String>, PathBuf, Value)>, String> {
    if has_plugin_manifest_file(root) {
        return Ok(vec![(
            None,
            root.to_path_buf(),
            read_plugin_manifest_json(root),
        )]);
    }
    let mut out = Vec::new();
    for base in [root.to_path_buf(), root.join("plugins")] {
        let Ok(rd) = fs::read_dir(&base) else {
            continue;
        };
        let mut dirs: Vec<PathBuf> = rd
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .collect();
        dirs.sort();
        for dir in dirs {
            if has_plugin_manifest_file(&dir) {
                let rel = dir
                    .strip_prefix(root)
                    .ok()
                    .map(|p| p.to_string_lossy().replace('\\', "/"));
                out.push((rel, dir.clone(), read_plugin_manifest_json(&dir)));
            }
        }
    }
    Ok(out)
}

fn has_plugin_manifest_file(dir: &Path) -> bool {
    [
        ".cowork-plugin/plugin.json",
        ".codex-plugin/plugin.json",
        ".claude-plugin/plugin.json",
    ]
    .iter()
    .any(|rel| dir.join(rel).is_file())
}

fn read_plugin_manifest_json(dir: &Path) -> Value {
    for rel in [
        ".cowork-plugin/plugin.json",
        ".codex-plugin/plugin.json",
        ".claude-plugin/plugin.json",
    ] {
        let p = dir.join(rel);
        if let Ok(s) = fs::read_to_string(&p)
            && let Ok(v) = serde_json::from_str::<Value>(&s)
        {
            return v;
        }
    }
    json!({})
}

fn read_plugin_install_manifest(dir: &Path) -> Option<PluginInstallManifest> {
    for rel in [".cowork-plugin/install.json", ".codex-plugin/install.json"] {
        let p = dir.join(rel);
        let Ok(s) = fs::read_to_string(&p) else {
            continue;
        };
        if let Ok(m) = serde_json::from_str::<PluginInstallManifest>(&s) {
            return Some(m);
        }
        if let Some(m) = decode_legacy_plugin_install_manifest(&s, &p) {
            return Some(m);
        }
    }
    None
}

/// Install sidecar written by the TypeScript harness: `{ marketplace?: {...}, bootstrap?: {...} }`
/// with no `version` / timestamps / origin. Its `marketplace.sourceInput` was the plugin's update
/// source and `marketplace.sourceHash` its installed hash.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyPluginInstallMetadata {
    #[serde(default)]
    marketplace: Option<LegacyPluginMarketplaceMetadata>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyPluginMarketplaceMetadata {
    name: String,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    installation_policy: Option<String>,
    #[serde(default)]
    authentication_policy: Option<String>,
    #[serde(default)]
    source_input: Option<String>,
    #[serde(default)]
    source_hash: Option<String>,
}

/// Migrates a legacy TypeScript install sidecar in memory so marketplace installs stay managed
/// (updatable from their recorded `sourceInput`). The next update rewrites the file in the
/// current format via `install_plugin_full`.
fn decode_legacy_plugin_install_manifest(raw: &str, path: &Path) -> Option<PluginInstallManifest> {
    let legacy: LegacyPluginInstallMetadata = serde_json::from_str(raw).ok()?;
    let mp = legacy.marketplace?;
    let non_empty = |v: Option<String>| v.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty());
    let name = non_empty(Some(mp.name))?;
    let source_hash = non_empty(mp.source_hash);
    let recorded_at = fs::metadata(path)
        .and_then(|m| m.modified())
        .map(|t| chrono::DateTime::<Utc>::from(t).to_rfc3339())
        .unwrap_or_default();
    Some(PluginInstallManifest {
        version: 0,
        installed_at: recorded_at.clone(),
        updated_at: recorded_at,
        // `reconstruct_origin_source` returns `url` verbatim, preserving the raw source input
        // (shorthand, tree URL, or local path) exactly as the TypeScript updater used it.
        source: SkillOriginMetadata {
            kind: "marketplace".to_owned(),
            url: non_empty(mp.source_input),
            repo: None,
            git_ref: None,
            subdir: None,
            source_path: None,
            source_hash: source_hash.clone(),
        },
        source_hash: source_hash.clone(),
        marketplace: Some(MarketplaceMetadataWire {
            name,
            display_name: non_empty(mp.display_name),
            category: non_empty(mp.category),
            installation_policy: non_empty(mp.installation_policy),
            authentication_policy: non_empty(mp.authentication_policy),
            source_hash,
        }),
    })
}

fn encode_plugin_icon(plugin_root: &Path, raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.contains("://") {
        return None;
    }
    let canonical_root = fs::canonicalize(plugin_root).ok()?;
    let resolved = fs::canonicalize(plugin_root.join(trimmed)).ok()?;
    if !resolved.starts_with(&canonical_root) {
        return None;
    }
    let bytes = fs::read(&resolved).ok()?;
    if bytes.len() > 256 * 1024 {
        return None;
    }
    let mime = match resolved
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .as_deref()
    {
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        _ => return None,
    };
    Some(format!("data:{mime};base64,{}", BASE64.encode(&bytes)))
}

fn build_plugin_skill_summaries(
    skills_dir: &Path,
    plugin_id: &str,
    plugin_name: &str,
    plugin_enabled: bool,
    overrides: &cowork_mcp::plugin_overrides::PluginOverridesFile,
) -> Vec<PluginSkillSummaryWire> {
    let Ok(rd) = fs::read_dir(skills_dir) else {
        return Vec::new();
    };
    let mut dirs: Vec<PathBuf> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    dirs.sort();
    let mut out = Vec::new();
    for dir in dirs {
        let md = dir.join("SKILL.md");
        let Ok(raw) = fs::read_to_string(&md) else {
            continue;
        };
        let Ok(parsed) = parse_and_validate_skill_md(&dir, &md, &raw, SkillScope::Project, true)
        else {
            continue;
        };
        let qualified = format!("{plugin_name}:{}", parsed.name);
        let ov_key = plugin_skill_override_key(plugin_id, &parsed.name);
        let enabled = plugin_enabled
            && overrides
                .skills
                .get(&ov_key)
                .or_else(|| overrides.skills.get(&qualified))
                .map(|o| o.enabled)
                .unwrap_or(true);
        out.push(PluginSkillSummaryWire {
            name: qualified,
            raw_name: parsed.name,
            description: parsed.description,
            enabled,
            root_dir: dir.to_string_lossy().into_owned(),
            skill_path: md.to_string_lossy().into_owned(),
            triggers: parsed.triggers,
            interface: parsed.interface,
        });
    }
    out
}

fn list_plugin_mcp_names(mcp_path: &Path) -> Vec<String> {
    let Ok(raw) = fs::read_to_string(mcp_path) else {
        return Vec::new();
    };
    let Ok(val) = serde_json::from_str::<Value>(&raw) else {
        return Vec::new();
    };
    let map = val
        .get("mcpServers")
        .and_then(Value::as_object)
        .or_else(|| val.as_object());
    let Some(map) = map else {
        return Vec::new();
    };
    let mut names: Vec<String> = map.keys().cloned().collect();
    names.sort();
    names
}

fn reconstruct_origin_source(origin: &SkillOriginMetadata) -> Option<String> {
    if let Some(ref p) = origin.source_path {
        return Some(p.clone());
    }
    if let Some(ref repo) = origin.repo {
        let git_ref = origin.git_ref.as_deref().unwrap_or("main");
        return Some(match origin.subdir {
            Some(ref sub) => format!("https://github.com/{repo}/tree/{git_ref}/{sub}"),
            None => format!("https://github.com/{repo}/tree/{git_ref}"),
        });
    }
    origin.url.clone()
}

/// Resolves `owner/repo` (or a github.com URL) to a repo slug that TS `isValidRepoSlug` accepts;
/// TS silently drops persisted entries whose repo fails that check.
fn normalize_marketplace_repo(raw: &str) -> Result<String, String> {
    let repo = parse_marketplace_repo(raw)?;
    if is_valid_marketplace_repo_slug(&repo) {
        Ok(repo)
    } else {
        Err(format!(
            "Invalid marketplace GitHub repo '{raw}'; expected 'owner/repo'."
        ))
    }
}

fn parse_marketplace_repo(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim().trim_end_matches('/');
    if let Ok(u) = url::Url::parse(trimmed) {
        let segs: Vec<&str> = u
            .path_segments()
            .map(|c| c.filter(|s| !s.is_empty()).collect())
            .unwrap_or_default();
        if segs.len() >= 2 {
            return Ok(format!("{}/{}", segs[0], segs[1].trim_end_matches(".git")));
        }
    }
    let parts: Vec<&str> = trimmed.split('/').filter(|s| !s.is_empty()).collect();
    if parts.len() == 2 {
        return Ok(format!(
            "{}/{}",
            parts[0],
            parts[1].trim_end_matches(".git")
        ));
    }
    Err(format!(
        "Invalid marketplace GitHub repo '{raw}'; expected 'owner/repo'."
    ))
}

fn resolve_marketplace_item_install_source(
    repo: &str,
    git_ref: &str,
    source_val: Option<&Value>,
    default_subdir: &str,
) -> String {
    if let Some(Value::String(s)) = source_val {
        let clean = s.trim_start_matches("./").trim_matches('/');
        if s.starts_with("http://") || s.starts_with("https://") {
            return s.clone();
        }
        return format!("https://github.com/{repo}/tree/{git_ref}/{clean}");
    }
    if let Some(Value::Object(obj)) = source_val {
        if let Some(url) = obj.get("url").and_then(Value::as_str) {
            return url.to_owned();
        }
        if let Some(path) = obj.get("path").and_then(Value::as_str) {
            let clean = path.trim_start_matches("./").trim_matches('/');
            return format!("https://github.com/{repo}/tree/{git_ref}/{clean}");
        }
    }
    format!("https://github.com/{repo}/tree/{git_ref}/{default_subdir}")
}

#[cfg(test)]
mod path_safety_tests {
    use super::confined_install_path;

    #[test]
    fn confined_install_path_rejects_escapes_independently_of_name_rules() {
        let tmp = tempfile::tempdir().unwrap();
        let base = std::fs::canonicalize(tmp.path()).unwrap();
        for bad in [
            "",
            ".",
            "..",
            "../x",
            "a/../../x",
            "a/b",
            "a\\b",
            "/etc",
            "a\0b",
        ] {
            assert!(
                confined_install_path(&base, bad).is_err(),
                "{bad:?} must be rejected"
            );
        }
        assert_eq!(
            confined_install_path(&base, ".incoming-acme-1").unwrap(),
            base.join(".incoming-acme-1")
        );
        assert_eq!(
            confined_install_path(&base, "Not_Kebab.Case").unwrap(),
            base.join("Not_Kebab.Case")
        );
    }
}
