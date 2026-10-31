use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use cowork_config::{
    AgentConfig, FileLockOptions, canonicalize_sync, file_lock_root_for_cowork_home,
    harden_private_file_sync, is_inside, with_file_lock_sync, write_text_file_atomic,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PluginScope {
    Workspace,
    User,
}

impl PluginScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Workspace => "workspace",
            Self::User => "user",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim() {
            "workspace" | "project" => Some(Self::Workspace),
            "user" | "global" => Some(Self::User),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginEnableOverride {
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginOverridesFile {
    pub version: u32,
    #[serde(default)]
    pub plugins: BTreeMap<String, PluginEnableOverride>,
    #[serde(default)]
    pub skills: BTreeMap<String, PluginEnableOverride>,
    #[serde(default)]
    pub mcp_servers: BTreeMap<String, PluginEnableOverride>,
    #[serde(default)]
    pub removed_default_plugins: Vec<String>,
}

impl Default for PluginOverridesFile {
    fn default() -> Self {
        Self {
            version: 2,
            plugins: BTreeMap::new(),
            skills: BTreeMap::new(),
            mcp_servers: BTreeMap::new(),
            removed_default_plugins: Vec::new(),
        }
    }
}

pub fn plugin_overrides_path(config: &AgentConfig, scope: PluginScope) -> PathBuf {
    match scope {
        PluginScope::Workspace => config.project_cowork_dir.join("plugins.json"),
        PluginScope::User => config.user_cowork_dir.join("config").join("plugins.json"),
    }
}

pub fn plugin_skill_override_key(plugin_id: &str, raw_skill_name: &str) -> String {
    format!("{plugin_id}:{raw_skill_name}")
}

pub fn plugin_mcp_override_key(plugin_id: &str, server_name: &str) -> String {
    format!("{plugin_id}:{server_name}")
}

pub fn read_plugin_overrides(config: &AgentConfig, scope: PluginScope) -> PluginOverridesFile {
    let path = plugin_overrides_path(config, scope);
    let Ok(raw) = fs::read_to_string(&path) else {
        return PluginOverridesFile::default();
    };
    let Ok(val) = serde_json::from_str::<Value>(&raw) else {
        return PluginOverridesFile::default();
    };
    let Some(obj) = val.as_object() else {
        return PluginOverridesFile::default();
    };
    let mut out = PluginOverridesFile {
        version: 2,
        plugins: parse_override_map(obj.get("plugins")),
        skills: parse_override_map(obj.get("skills")),
        mcp_servers: parse_override_map(obj.get("mcpServers")),
        removed_default_plugins: obj
            .get("removedDefaultPlugins")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(Value::as_str)
                    .map(|s| s.trim().to_owned())
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .unwrap_or_default(),
    };
    out.removed_default_plugins.sort();
    out.removed_default_plugins.dedup();
    out
}

fn parse_override_map(val: Option<&Value>) -> BTreeMap<String, PluginEnableOverride> {
    let mut map = BTreeMap::new();
    let Some(obj) = val.and_then(Value::as_object) else {
        return map;
    };
    for (k, v) in obj {
        if let Some(enabled) = v
            .as_object()
            .and_then(|o| o.get("enabled"))
            .and_then(Value::as_bool)
        {
            map.insert(k.clone(), PluginEnableOverride { enabled });
        } else if let Some(enabled) = v.as_bool() {
            map.insert(k.clone(), PluginEnableOverride { enabled });
        }
    }
    map
}

pub fn mutate_plugin_overrides<F, R>(
    config: &AgentConfig,
    scope: PluginScope,
    f: F,
) -> Result<R, String>
where
    F: FnOnce(&mut PluginOverridesFile) -> R,
{
    let path = plugin_overrides_path(config, scope);
    let lock_root = file_lock_root_for_cowork_home(&config.user_cowork_dir);
    with_file_lock_sync::<R, anyhow::Error, _>(
        &path,
        || {
            let mut current = read_plugin_overrides(config, scope);
            let result = f(&mut current);
            current.version = 2;
            current.removed_default_plugins.sort();
            current.removed_default_plugins.dedup();
            let serialized = format!("{}\n", serde_json::to_string_pretty(&current)?);
            write_text_file_atomic(&path, &serialized, Some(0o600))?;
            harden_private_file_sync(&path);
            Ok(result)
        },
        FileLockOptions {
            lock_root: Some(lock_root),
            ..Default::default()
        },
    )
    .map_err(|e| e.to_string())
}

#[derive(Debug, Clone)]
pub struct DiscoveredPluginRoot {
    pub id: String,
    pub name: String,
    pub version: Option<String>,
    pub description: String,
    pub scope: PluginScope,
    pub enabled: bool,
    pub default_enabled: bool,
    pub root_dir: PathBuf,
    pub manifest_path: PathBuf,
    pub skills_rel_path: String,
    pub mcp_rel_path: String,
    pub discovery_kind: &'static str,
    pub marketplace_name: Option<String>,
}

/// Discovers installed plugins across `workspace` (`<cwd>/.cowork/plugins` + `<cwd>/.agents/plugins`)
/// and `user` (`<userCoworkDir>/plugins` + `<userAgentsDir>/plugins`), honoring local `marketplace.json`
/// and `plugins.json` v2 enablement overrides.
pub fn discover_installed_plugin_roots(
    config: &AgentConfig,
) -> (Vec<DiscoveredPluginRoot>, Vec<String>) {
    let mut warnings = Vec::new();
    let mut out = Vec::new();

    let scope_roots: [(PluginScope, Vec<PathBuf>); 2] = [
        (
            PluginScope::Workspace,
            dedup_paths(vec![
                config.workspace_plugins_dir.clone(),
                config.workspace_agents_dir.join("plugins"),
            ]),
        ),
        (
            PluginScope::User,
            dedup_paths(vec![
                config.user_plugins_dir.clone(),
                config.user_agents_dir.join("plugins"),
            ]),
        ),
    ];

    for (scope, bases) in scope_roots {
        let overrides = read_plugin_overrides(config, scope);
        let mut seen_ids = BTreeSet::new();
        let mut seen_canonical_roots = BTreeSet::new();

        for base_dir in bases {
            if !base_dir.is_dir() {
                continue;
            }
            let base_canon = canonicalize_sync(&base_dir);

            // 1. Local `marketplace.json` inside `<base_dir>/marketplace.json` (if present)
            let local_mp_path = base_dir.join("marketplace.json");
            if local_mp_path.is_file() {
                match fs::read_to_string(&local_mp_path)
                    .ok()
                    .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
                {
                    Some(mp_json) => {
                        let mp_name = mp_json
                            .get("name")
                            .and_then(Value::as_str)
                            .map(str::to_owned);
                        if let Some(plugins_arr) = mp_json.get("plugins").and_then(Value::as_array)
                        {
                            for entry in plugins_arr {
                                let Some(src_rel) = entry.get("source").and_then(|s| {
                                    s.as_str().or_else(|| s.get("path").and_then(Value::as_str))
                                }) else {
                                    continue;
                                };
                                let candidate = base_dir.join(src_rel);
                                let candidate_canon = canonicalize_sync(&candidate);
                                if !is_inside(&base_canon, &candidate_canon)
                                    || !candidate_canon.is_dir()
                                {
                                    warnings.push(format!(
                                        "Skipping marketplace plugin entry outside plugins root: {}",
                                        candidate.display()
                                    ));
                                    continue;
                                }
                                let policy_default = entry
                                    .pointer("/policy/installation")
                                    .and_then(Value::as_str)
                                    != Some("NOT_AVAILABLE");
                                if let Some(mut disc) = load_plugin_from_dir(
                                    &candidate_canon,
                                    scope,
                                    &overrides,
                                    policy_default,
                                    "marketplace",
                                    mp_name.clone(),
                                    &mut warnings,
                                ) && seen_ids.insert(disc.id.clone())
                                {
                                    seen_canonical_roots.insert(candidate_canon);
                                    if let Some(entry_name) =
                                        entry.get("name").and_then(Value::as_str)
                                        && disc.name.is_empty()
                                    {
                                        disc.name = entry_name.to_owned();
                                    }
                                    out.push(disc);
                                }
                            }
                        }
                    }
                    None => warnings.push(format!(
                        "Failed to parse local marketplace manifest at {}",
                        local_mp_path.display()
                    )),
                }
            }

            // 2. Direct child directories under `<base_dir>/<dir>`
            let Ok(read_dir) = fs::read_dir(&base_dir) else {
                continue;
            };
            let mut child_dirs: Vec<PathBuf> = read_dir
                .filter_map(Result::ok)
                .filter_map(|e| {
                    let name = e.file_name();
                    let name_str = name.to_string_lossy();
                    if name_str.starts_with('.') {
                        return None;
                    }
                    let p = e.path();
                    if p.is_dir() { Some(p) } else { None }
                })
                .collect();
            child_dirs.sort();

            for child in child_dirs {
                let child_canon = canonicalize_sync(&child);
                if !is_inside(&base_canon, &child_canon) {
                    warnings.push(format!(
                        "Skipping symlink-escaping plugin directory {}",
                        child.display()
                    ));
                    continue;
                }
                if seen_canonical_roots.contains(&child_canon) {
                    continue;
                }
                if let Some(disc) = load_plugin_from_dir(
                    &child_canon,
                    scope,
                    &overrides,
                    true,
                    "directory",
                    None,
                    &mut warnings,
                ) && seen_ids.insert(disc.id.clone())
                {
                    seen_canonical_roots.insert(child_canon);
                    out.push(disc);
                }
            }
        }
    }

    (out, warnings)
}

fn dedup_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for p in paths {
        if seen.insert(p.clone()) {
            out.push(p);
        }
    }
    out
}

fn load_plugin_from_dir(
    plugin_root: &Path,
    scope: PluginScope,
    overrides: &PluginOverridesFile,
    default_enabled: bool,
    discovery_kind: &'static str,
    marketplace_name: Option<String>,
    warnings: &mut Vec<String>,
) -> Option<DiscoveredPluginRoot> {
    let manifest_candidates = [
        plugin_root.join(".cowork-plugin").join("plugin.json"),
        plugin_root.join(".codex-plugin").join("plugin.json"),
        plugin_root.join(".claude-plugin").join("plugin.json"),
    ];
    let manifest_path = manifest_candidates.into_iter().find(|p| p.is_file())?;

    let raw = match fs::read_to_string(&manifest_path) {
        Ok(r) => r,
        Err(e) => {
            warnings.push(format!(
                "Failed to read plugin manifest {}: {e}",
                manifest_path.display()
            ));
            return None;
        }
    };
    let parsed: Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            warnings.push(format!(
                "Invalid JSON in plugin manifest {}: {e}",
                manifest_path.display()
            ));
            return None;
        }
    };
    let Some(obj) = parsed.as_object() else {
        warnings.push(format!(
            "Plugin manifest {} must be a JSON object",
            manifest_path.display()
        ));
        return None;
    };

    let fallback_name = plugin_root
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let name = obj
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&fallback_name)
        .to_owned();
    if name.is_empty() {
        return None;
    }

    let id = name.clone();
    let description = obj
        .get("description")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
        .to_owned();
    let version = obj
        .get("version")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    let skills_rel_path = obj
        .get("skills")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("./skills")
        .to_owned();
    let mcp_rel_path = obj
        .get("mcpServers")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("./.mcp.json")
        .to_owned();

    let enabled = overrides
        .plugins
        .get(&id)
        .map(|o| o.enabled)
        .unwrap_or(default_enabled);

    Some(DiscoveredPluginRoot {
        id,
        name,
        version,
        description,
        scope,
        enabled,
        default_enabled,
        root_dir: plugin_root.to_path_buf(),
        manifest_path,
        skills_rel_path,
        mcp_rel_path,
        discovery_kind,
        marketplace_name,
    })
}
