use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use chrono::Utc;
use cowork_config::{
    FileLockOptions, file_lock_root_for_cowork_home, harden_private_file_sync, with_file_lock_sync,
    write_text_file_atomic,
};
use serde::{Deserialize, Serialize};

use crate::agents::roles::{BUILTIN_AGENT_ROLES, lookup_builtin_role};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentProfileScope {
    Global,
    Workspace,
}

impl AgentProfileScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Global => "global",
            Self::Workspace => "workspace",
        }
    }

    pub fn parse(raw: &str) -> Result<Self, String> {
        match raw.trim() {
            "global" => Ok(Self::Global),
            "workspace" => Ok(Self::Workspace),
            other => Err(format!(
                "Invalid profile scope '{other}'; expected 'global' or 'workspace'."
            )),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProfileDefinition {
    #[serde(default = "default_v1")]
    pub version: u32,
    pub id: String,
    pub display_name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_base_role")]
    pub base_role: String,
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub allowed_built_in_tools: Vec<String>,
    #[serde(default)]
    pub allowed_mcp_servers: Vec<String>,
    #[serde(default)]
    pub skill_names: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_task_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_context_mode: Option<String>,
}

fn default_v1() -> u32 {
    1
}
fn default_true() -> bool {
    true
}
fn default_base_role() -> String {
    "default".to_owned()
}

/// Strict wire snapshot matching `persistentAgentProfileSnapshotSchema` / `agentProfileSnapshotSchema`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProfileSnapshot {
    pub id: String,
    #[serde(rename = "ref")]
    pub profile_ref: String,
    pub scope: AgentProfileScope,
    pub display_name: String,
    pub description: String,
    pub base_role: String,
    pub prompt: String,
    pub allowed_built_in_tools: Vec<String>,
    pub allowed_mcp_servers: Vec<String>,
    pub skill_names: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_task_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_context_mode: Option<String>,
    pub resolved_at: String,
}

/// Strict catalog entry matching `agentProfileCatalogEntrySchema` (`.strict()`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProfileCatalogEntry {
    pub scope: AgentProfileScope,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub built_in: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locked: Option<bool>,
    pub effective: bool,
    pub shadowed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_disabled: Option<bool>,
    pub profile: AgentProfileDefinition,
}

/// Strict diagnostic matching `agentProfileDiagnosticSchema` (`.strict()`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProfileDiagnostic {
    pub scope: AgentProfileScope,
    pub path: String,
    pub severity: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProfilesRootsWire {
    pub global_dir: String,
    pub workspace_dir: String,
}

/// Strict catalog matching `agentProfilesCatalogSchema` (`.strict()`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProfilesCatalog {
    pub profiles: Vec<AgentProfileCatalogEntry>,
    pub effective_profiles: Vec<AgentProfileCatalogEntry>,
    pub diagnostics: Vec<AgentProfileDiagnostic>,
    pub roots: AgentProfilesRootsWire,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProfileUpsertInput {
    pub scope: AgentProfileScope,
    #[serde(flatten)]
    pub profile: AgentProfileDefinition,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceProfileOverridesFile {
    #[serde(default = "default_v1")]
    version: u32,
    #[serde(default)]
    disabled_global_profile_ids: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct AgentProfilesStore {
    user_cowork_dir: PathBuf,
    global_dir: PathBuf,
    workspace_profiles_dir: PathBuf,
}

impl AgentProfilesStore {
    pub fn new(user_cowork_dir: &Path, workspace_dir: &Path) -> Self {
        Self {
            user_cowork_dir: user_cowork_dir.to_path_buf(),
            global_dir: user_cowork_dir.join("agent-profiles"),
            workspace_profiles_dir: workspace_dir.join(".cowork/agent-profiles"),
        }
    }

    fn overrides_path(&self) -> PathBuf {
        self.workspace_profiles_dir.join("workspace-overrides.json")
    }

    fn run_locked<R, F>(&self, target: &Path, f: F) -> Result<R, String>
    where
        F: FnOnce() -> Result<R, String>,
    {
        let lock_root = file_lock_root_for_cowork_home(&self.user_cowork_dir);
        with_file_lock_sync::<R, anyhow::Error, _>(
            target,
            || f().map_err(|m| anyhow::anyhow!(m)),
            FileLockOptions {
                lock_root: Some(lock_root),
                ..Default::default()
            },
        )
        .map_err(|e| e.to_string())
    }

    fn read_disabled_globals(&self) -> BTreeSet<String> {
        fs::read_to_string(self.overrides_path())
            .ok()
            .and_then(|s| serde_json::from_str::<WorkspaceProfileOverridesFile>(&s).ok())
            .map(|f| f.disabled_global_profile_ids.into_iter().collect())
            .unwrap_or_default()
    }

    fn read_dir_profiles(
        &self,
        scope: AgentProfileScope,
        dir: &Path,
        diagnostics: &mut Vec<AgentProfileDiagnostic>,
    ) -> Vec<(PathBuf, AgentProfileDefinition)> {
        let Ok(rd) = fs::read_dir(dir) else {
            return Vec::new();
        };
        let mut files: Vec<PathBuf> = rd
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.extension().and_then(|e| e.to_str()) == Some("json")
                    && p.file_name().and_then(|n| n.to_str()) != Some("workspace-overrides.json")
            })
            .collect();
        files.sort();
        let mut out = Vec::new();
        for f in files {
            match fs::read_to_string(&f) {
                Ok(raw) => match serde_json::from_str::<AgentProfileDefinition>(&raw) {
                    Ok(def) => out.push((f, def)),
                    Err(e) => diagnostics.push(AgentProfileDiagnostic {
                        scope,
                        path: f.to_string_lossy().into_owned(),
                        severity: "error".to_owned(),
                        message: format!("Invalid agent profile JSON: {e}"),
                    }),
                },
                Err(e) => diagnostics.push(AgentProfileDiagnostic {
                    scope,
                    path: f.to_string_lossy().into_owned(),
                    severity: "error".to_owned(),
                    message: e.to_string(),
                }),
            }
        }
        out
    }

    pub fn read_catalog(&self) -> AgentProfilesCatalog {
        let disabled_globals = self.read_disabled_globals();
        let mut diagnostics = Vec::new();
        let global_defs = self.read_dir_profiles(
            AgentProfileScope::Global,
            &self.global_dir,
            &mut diagnostics,
        );
        let ws_defs = self.read_dir_profiles(
            AgentProfileScope::Workspace,
            &self.workspace_profiles_dir,
            &mut diagnostics,
        );
        let ws_ids: BTreeSet<String> = ws_defs.iter().map(|(_, d)| d.id.clone()).collect();
        let global_ids: BTreeSet<String> = global_defs.iter().map(|(_, d)| d.id.clone()).collect();

        let mut profiles = Vec::new();

        // 1. Synthesized built-in role profiles (`scope: "global"`, `builtIn: true`)
        for role in BUILTIN_AGENT_ROLES {
            if global_ids.contains(role.name) {
                continue;
            }
            let ws_disabled = disabled_globals.contains(role.name) && role.name != "default";
            let shadowed = ws_ids.contains(role.name);
            let effective = !ws_disabled && !shadowed;
            let def = AgentProfileDefinition {
                version: 1,
                id: role.name.to_owned(),
                display_name: role.display_name.to_owned(),
                description: role.description.to_owned(),
                enabled: true,
                base_role: role.name.to_owned(),
                prompt: String::new(),
                allowed_built_in_tools: role
                    .allowed_builtin_tools
                    .iter()
                    .map(|s| (*s).to_owned())
                    .collect(),
                allowed_mcp_servers: Vec::new(),
                skill_names: Vec::new(),
                model: None,
                reasoning_effort: None,
                default_task_type: None,
                default_context_mode: None,
            };
            profiles.push(AgentProfileCatalogEntry {
                scope: AgentProfileScope::Global,
                path: None,
                built_in: Some(true),
                locked: Some(role.name == "default"),
                effective,
                shadowed,
                workspace_disabled: ws_disabled.then_some(true),
                profile: def,
            });
        }

        // 2. User-authored global profiles
        for (path, def) in global_defs {
            let ws_disabled = disabled_globals.contains(&def.id);
            let shadowed = ws_ids.contains(&def.id);
            let effective = def.enabled && !ws_disabled && !shadowed;
            profiles.push(AgentProfileCatalogEntry {
                scope: AgentProfileScope::Global,
                path: Some(path.to_string_lossy().into_owned()),
                built_in: Some(false),
                locked: Some(false),
                effective,
                shadowed,
                workspace_disabled: ws_disabled.then_some(true),
                profile: def,
            });
        }

        // 3. Workspace profiles
        for (path, def) in ws_defs {
            let effective = def.enabled;
            profiles.push(AgentProfileCatalogEntry {
                scope: AgentProfileScope::Workspace,
                path: Some(path.to_string_lossy().into_owned()),
                built_in: Some(false),
                locked: Some(false),
                effective,
                shadowed: false,
                workspace_disabled: None,
                profile: def,
            });
        }

        let effective_profiles = profiles.iter().filter(|p| p.effective).cloned().collect();

        AgentProfilesCatalog {
            profiles,
            effective_profiles,
            diagnostics,
            roots: AgentProfilesRootsWire {
                global_dir: self.global_dir.to_string_lossy().into_owned(),
                workspace_dir: self.workspace_profiles_dir.to_string_lossy().into_owned(),
            },
        }
    }

    pub fn resolve_profile(&self, raw_ref: &str) -> Result<AgentProfileSnapshot, String> {
        let trimmed = raw_ref.trim();
        let cat = self.read_catalog();

        let matched = if let Some((scope_prefix, id)) = trimmed.split_once(':') {
            let wanted_scope = AgentProfileScope::parse(scope_prefix)?;
            let found = cat
                .profiles
                .into_iter()
                .find(|p| p.scope == wanted_scope && p.profile.id == id)
                .ok_or_else(|| format!("Agent profile '{trimmed}' not found."))?;
            if !found.profile.enabled || found.workspace_disabled == Some(true) {
                return Err(format!(
                    "Agent profile '{trimmed}' is disabled in this workspace."
                ));
            }
            found
        } else {
            // Bare `<id>`: Workspace shadows Global
            let mut winner = None;
            for scope in [AgentProfileScope::Workspace, AgentProfileScope::Global] {
                if let Some(found) = cat
                    .profiles
                    .iter()
                    .find(|p| p.scope == scope && p.profile.id == trimmed)
                {
                    if !found.profile.enabled || found.workspace_disabled == Some(true) {
                        return Err(format!(
                            "Agent profile '{trimmed}' is disabled in this workspace."
                        ));
                    }
                    winner = Some(found.clone());
                    break;
                }
            }
            winner.ok_or_else(|| format!("Agent profile '{trimmed}' not found."))?
        };

        Ok(to_profile_snapshot(matched.scope, &matched.profile))
    }

    pub fn upsert(&self, input: AgentProfileUpsertInput) -> Result<AgentProfilesCatalog, String> {
        validate_profile_id(&input.profile.id)?;
        if input.profile.id == "default" {
            return Err(
                "The 'default' agent profile is locked and cannot be overridden.".to_owned(),
            );
        }
        lookup_builtin_role(&input.profile.base_role)?;

        let dir = match input.scope {
            AgentProfileScope::Global => &self.global_dir,
            AgentProfileScope::Workspace => &self.workspace_profiles_dir,
        };
        let path = dir.join(format!("{}.json", input.profile.id));
        self.run_locked(&path, || {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            let mut normalized = input.profile.clone();
            normalized.version = 1;
            write_text_file_atomic(
                &path,
                &format!(
                    "{}\n",
                    serde_json::to_string_pretty(&normalized).unwrap_or_default()
                ),
                Some(0o600),
            )
            .map_err(|e| e.to_string())?;
            harden_private_file_sync(&path);
            Ok(())
        })?;

        Ok(self.read_catalog())
    }

    pub fn delete(
        &self,
        scope: AgentProfileScope,
        id: &str,
    ) -> Result<AgentProfilesCatalog, String> {
        if id == "default" {
            return Err("Built-in 'default' profile is locked and cannot be deleted.".to_owned());
        }
        let dir = match scope {
            AgentProfileScope::Global => &self.global_dir,
            AgentProfileScope::Workspace => &self.workspace_profiles_dir,
        };
        let path = dir.join(format!("{id}.json"));
        self.run_locked(&path, || {
            if path.exists() {
                fs::remove_file(&path).map_err(|e| e.to_string())?;
            }
            Ok(())
        })?;
        Ok(self.read_catalog())
    }

    pub fn copy_profile(
        &self,
        source_ref: &str,
        target_scope: AgentProfileScope,
        new_id: Option<&str>,
        new_display_name: Option<&str>,
    ) -> Result<AgentProfilesCatalog, String> {
        let cat = self.read_catalog();
        let src = cat
            .profiles
            .into_iter()
            .find(|p| {
                format!("{}:{}", p.scope.as_str(), p.profile.id) == source_ref
                    || p.profile.id == source_ref
            })
            .ok_or_else(|| format!("Source profile '{source_ref}' not found."))?;
        let mut cloned = src.profile;
        if let Some(id) = new_id {
            cloned.id = id.to_owned();
        }
        if let Some(dn) = new_display_name {
            cloned.display_name = dn.to_owned();
        }
        cloned.enabled = true;
        self.upsert(AgentProfileUpsertInput {
            scope: target_scope,
            profile: cloned,
        })
    }

    pub fn set_workspace_availability(
        &self,
        global_profile_id: &str,
        enabled: bool,
    ) -> Result<AgentProfilesCatalog, String> {
        if global_profile_id == "default" {
            return Err("Built-in 'default' profile cannot be disabled.".to_owned());
        }
        let ov_path = self.overrides_path();
        self.run_locked(&ov_path, || {
            fs::create_dir_all(&self.workspace_profiles_dir).map_err(|e| e.to_string())?;
            let mut set = self.read_disabled_globals();
            if enabled {
                set.remove(global_profile_id);
            } else {
                set.insert(global_profile_id.to_owned());
            }
            let file = WorkspaceProfileOverridesFile {
                version: 1,
                disabled_global_profile_ids: set.into_iter().collect(),
            };
            write_text_file_atomic(
                &ov_path,
                &format!(
                    "{}\n",
                    serde_json::to_string_pretty(&file).unwrap_or_default()
                ),
                Some(0o600),
            )
            .map_err(|e| e.to_string())?;
            harden_private_file_sync(&ov_path);
            Ok(())
        })?;
        Ok(self.read_catalog())
    }
}

fn to_profile_snapshot(
    scope: AgentProfileScope,
    def: &AgentProfileDefinition,
) -> AgentProfileSnapshot {
    AgentProfileSnapshot {
        id: def.id.clone(),
        profile_ref: format!("{}:{}", scope.as_str(), def.id),
        scope,
        display_name: def.display_name.clone(),
        description: def.description.clone(),
        base_role: def.base_role.clone(),
        prompt: def.prompt.clone(),
        allowed_built_in_tools: def.allowed_built_in_tools.clone(),
        allowed_mcp_servers: def.allowed_mcp_servers.clone(),
        skill_names: def.skill_names.clone(),
        model: def.model.clone(),
        reasoning_effort: def.reasoning_effort.clone(),
        default_task_type: def.default_task_type.clone(),
        default_context_mode: def.default_context_mode.clone(),
        resolved_at: Utc::now().to_rfc3339(),
    }
}

fn validate_profile_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 80 {
        return Err("Profile id must be 1..=80 characters.".to_owned());
    }
    let valid = id.bytes().enumerate().all(|(i, b)| {
        b.is_ascii_lowercase()
            || b.is_ascii_digit()
            || (i > 0 && (b == b'-' || b == b'_' || b == b'.'))
    });
    if !valid {
        return Err(format!(
            "Invalid profile id '{id}'; must start with lowercase alphanumeric and contain only [a-z0-9._-]."
        ));
    }
    Ok(())
}
