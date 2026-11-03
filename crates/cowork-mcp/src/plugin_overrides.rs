use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use cowork_config::{
    AgentConfig, FileLockOptions, canonicalize_sync, file_lock_root_for_cowork_home,
    harden_private_file_sync, is_inside, normalize_lexical_path, with_file_lock_sync,
    write_text_file_atomic,
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

/// TS `CURRENT_DOCUMENT_VERSION` for `plugins.json`.
pub const PLUGIN_OVERRIDES_DOCUMENT_VERSION: u32 = 2;

/// TS `DEFAULT_MARKETPLACE_PLUGIN_IDS` with `DEFAULT_MARKETPLACE_PLUGIN_LEGACY_TOMBSTONES`: each
/// default built-in marketplace plugin id and the legacy plugin ids whose removal tombstones it.
const DEFAULT_MARKETPLACE_PLUGIN_TOMBSTONES: &[(&str, &[&str])] = &[(
    "workspace-tools",
    &["documents", "pdf", "presentations", "spreadsheets"],
)];

/// TS `canonicalDefaultMarketplacePluginIdForTombstone`: maps a plugin id (or a legacy alias) to
/// the default marketplace plugin it tombstones, or `None` if it is not a default plugin.
pub fn canonical_default_marketplace_plugin_id_for_tombstone(
    plugin_id: &str,
) -> Option<&'static str> {
    let normalized = plugin_id.trim();
    DEFAULT_MARKETPLACE_PLUGIN_TOMBSTONES
        .iter()
        .find(|(default_id, legacy)| *default_id == normalized || legacy.contains(&normalized))
        .map(|(default_id, _)| *default_id)
}

/// In-memory view of one scope's `plugins.json` (TS `PluginOverrideDocument`).
///
/// On disk this is exactly the TS shape: `plugins`, `skills` and `mcpServers` are
/// `Record<string, boolean>` and `removedDefaultPlugins` is a `Record<string, true>` tombstone
/// map. Decoding also accepts the `{"enabled": bool}` override objects and the
/// `removedDefaultPlugins` string array that earlier Rust builds wrote.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginOverridesFile {
    pub version: u32,
    pub updated_at: Option<String>,
    pub plugins: BTreeMap<String, PluginEnableOverride>,
    pub skills: BTreeMap<String, PluginEnableOverride>,
    pub mcp_servers: BTreeMap<String, PluginEnableOverride>,
    /// Canonical default plugin ids that the user removed (sorted, deduped).
    pub removed_default_plugins: Vec<String>,
}

impl Default for PluginOverridesFile {
    fn default() -> Self {
        Self {
            version: PLUGIN_OVERRIDES_DOCUMENT_VERSION,
            updated_at: None,
            plugins: BTreeMap::new(),
            skills: BTreeMap::new(),
            mcp_servers: BTreeMap::new(),
            removed_default_plugins: Vec::new(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginOverridesDocumentOut<'a> {
    version: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    updated_at: Option<&'a str>,
    plugins: BTreeMap<&'a str, bool>,
    skills: BTreeMap<&'a str, bool>,
    mcp_servers: BTreeMap<&'a str, bool>,
    removed_default_plugins: BTreeMap<&'a str, bool>,
}

fn boolean_map_out(map: &BTreeMap<String, PluginEnableOverride>) -> BTreeMap<&str, bool> {
    map.iter()
        .map(|(key, value)| (key.trim(), value.enabled))
        .filter(|(key, _)| !key.is_empty())
        .collect()
}

impl Serialize for PluginOverridesFile {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        PluginOverridesDocumentOut {
            version: PLUGIN_OVERRIDES_DOCUMENT_VERSION,
            updated_at: self.updated_at.as_deref(),
            plugins: boolean_map_out(&self.plugins),
            skills: boolean_map_out(&self.skills),
            mcp_servers: boolean_map_out(&self.mcp_servers),
            removed_default_plugins: self
                .removed_default_plugins
                .iter()
                .filter_map(|id| canonical_default_marketplace_plugin_id_for_tombstone(id))
                .map(|id| (id, true))
                .collect(),
        }
        .serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for PluginOverridesFile {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(normalize_plugin_overrides_document(&Value::deserialize(
            deserializer,
        )?))
    }
}

/// TS `normalizeBooleanMap`: trimmed non-empty keys with boolean values; anything else is dropped.
/// `{"enabled": bool}` values (written by earlier Rust builds) are accepted too.
fn parse_override_map(val: Option<&Value>) -> BTreeMap<String, PluginEnableOverride> {
    let mut map = BTreeMap::new();
    let Some(obj) = val.and_then(Value::as_object) else {
        return map;
    };
    for (raw_key, raw) in obj {
        let key = raw_key.trim();
        if key.is_empty() {
            continue;
        }
        let enabled = raw.as_bool().or_else(|| {
            raw.as_object()
                .and_then(|o| o.get("enabled"))
                .and_then(Value::as_bool)
        });
        if let Some(enabled) = enabled {
            map.insert(key.to_owned(), PluginEnableOverride { enabled });
        }
    }
    map
}

/// TS `normalizeDefaultPluginTombstones` over a `Record<string, boolean>`, plus the string array
/// earlier Rust builds wrote. Only `true` entries naming a default plugin survive, canonicalized.
fn parse_default_plugin_tombstones(val: Option<&Value>) -> BTreeSet<String> {
    let removed_ids: Vec<String> = match val {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
        Some(Value::Object(_)) => parse_override_map(val)
            .into_iter()
            .filter(|(_, removed)| removed.enabled)
            .map(|(id, _)| id)
            .collect(),
        _ => Vec::new(),
    };
    removed_ids
        .iter()
        .filter_map(|id| canonical_default_marketplace_plugin_id_for_tombstone(id))
        .map(str::to_owned)
        .collect()
}

/// TS `normalizeDocument`, including the v1 -> v2 migration that turns `plugins[defaultId] =
/// false` into a `removedDefaultPlugins` tombstone. A non-object document is the empty default.
pub fn normalize_plugin_overrides_document(value: &Value) -> PluginOverridesFile {
    let Some(record) = value.as_object() else {
        return PluginOverridesFile::default();
    };
    let version = record
        .get("version")
        .and_then(Value::as_f64)
        .filter(|v| v.fract() == 0.0 && *v > 0.0)
        .unwrap_or(1.0);
    let migrate_tombstones = version < f64::from(PLUGIN_OVERRIDES_DOCUMENT_VERSION);

    let mut plugins = BTreeMap::new();
    let mut tombstones = BTreeSet::new();
    for (plugin_id, value) in parse_override_map(record.get("plugins")) {
        let migrated = if migrate_tombstones && !value.enabled {
            canonical_default_marketplace_plugin_id_for_tombstone(&plugin_id)
        } else {
            None
        };
        match migrated {
            Some(default_id) => {
                tombstones.insert(default_id.to_owned());
            }
            None => {
                plugins.insert(plugin_id, value);
            }
        }
    }
    tombstones.extend(parse_default_plugin_tombstones(
        record.get("removedDefaultPlugins"),
    ));

    PluginOverridesFile {
        version: PLUGIN_OVERRIDES_DOCUMENT_VERSION,
        updated_at: record
            .get("updatedAt")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .map(str::to_owned),
        plugins,
        skills: parse_override_map(record.get("skills")),
        mcp_servers: parse_override_map(record.get("mcpServers")),
        removed_default_plugins: tombstones.into_iter().collect(),
    }
}

pub fn plugin_overrides_path(config: &AgentConfig, scope: PluginScope) -> PathBuf {
    match scope {
        PluginScope::Workspace => config.project_cowork_dir.join("plugins.json"),
        PluginScope::User => config.user_cowork_dir.join("config").join("plugins.json"),
    }
}

/// TS `pluginScopedOverrideKey`: `<pluginId>:<skillName>`, both parts trimmed.
pub fn plugin_skill_override_key(plugin_id: &str, raw_skill_name: &str) -> String {
    format!("{}:{}", plugin_id.trim(), raw_skill_name.trim())
}

/// TS `pluginScopedOverrideKey`: `<pluginId>:<serverName>`, both parts trimmed.
pub fn plugin_mcp_override_key(plugin_id: &str, server_name: &str) -> String {
    format!("{}:{}", plugin_id.trim(), server_name.trim())
}

/// Strict read for read-modify-write: a missing file is the empty default, while an unreadable
/// file or one that is not a JSON object is an error so it is never overwritten.
pub fn try_read_plugin_overrides_file(path: &Path) -> Result<PluginOverridesFile, String> {
    let raw = match crate::read_config_file(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(PluginOverridesFile::default());
        }
        Err(error) => {
            return Err(format!(
                "Failed to read plugin overrides at {}: {error}",
                path.display()
            ));
        }
    };
    let value: Value = serde_json::from_str(&raw).map_err(|error| {
        format!(
            "Invalid plugin overrides at {}: {error}. Fix or remove the file to continue.",
            path.display()
        )
    })?;
    if !value.is_object() {
        return Err(format!(
            "Invalid plugin overrides at {}: expected a JSON object. Fix or remove the file to continue.",
            path.display()
        ));
    }
    Ok(normalize_plugin_overrides_document(&value))
}

/// A workspace `.cowork/plugins.json` reached through a symbolic link under `.cowork` is
/// refused: it could read or rewrite the user's global plugin overrides.
fn guard_plugin_overrides_path(
    config: &AgentConfig,
    scope: PluginScope,
    path: &Path,
) -> Result<(), String> {
    if scope != PluginScope::Workspace {
        return Ok(());
    }
    crate::ensure_unlinked_workspace_path(&config.project_cowork_dir, path).map_err(|error| {
        format!(
            "Failed to read plugin overrides at {}: {error}",
            path.display()
        )
    })
}

/// Lenient read (TS `readDocument`): an unreadable file is treated as empty for lookups only.
pub fn read_plugin_overrides(config: &AgentConfig, scope: PluginScope) -> PluginOverridesFile {
    let path = plugin_overrides_path(config, scope);
    guard_plugin_overrides_path(config, scope, &path)
        .and_then(|()| try_read_plugin_overrides_file(&path))
        .unwrap_or_else(|error| {
            tracing::warn!(path = %path.display(), %error, "ignoring unreadable plugin overrides");
            PluginOverridesFile::default()
        })
}

/// TS `mutateScopeDocument`. Refuses (rather than clobbering) a file that exists but cannot be
/// decoded; always writes the TS v2 document with a fresh `updatedAt`.
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
    guard_plugin_overrides_path(config, scope, &path)?;
    with_file_lock_sync::<R, anyhow::Error, _>(
        &path,
        || {
            guard_plugin_overrides_path(config, scope, &path).map_err(|e| anyhow::anyhow!(e))?;
            let mut current =
                try_read_plugin_overrides_file(&path).map_err(|e| anyhow::anyhow!(e))?;
            let result = f(&mut current);
            current.version = PLUGIN_OVERRIDES_DOCUMENT_VERSION;
            current.updated_at =
                Some(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
            let tombstones: BTreeSet<String> = current
                .removed_default_plugins
                .iter()
                .filter_map(|id| canonical_default_marketplace_plugin_id_for_tombstone(id))
                .map(str::to_owned)
                .collect();
            current.removed_default_plugins = tombstones.into_iter().collect();
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
    /// TS catalog `displayName`: manifest `interface.displayName`, else `name`.
    pub display_name: String,
    /// TS `plugin.interface?.composerIcon ?? plugin.interface?.logo` (raw manifest value), the
    /// icon a plugin MCP server inherits when it sets none of its own.
    pub icon: Option<String>,
    pub version: Option<String>,
    pub description: String,
    pub scope: PluginScope,
    pub enabled: bool,
    pub default_enabled: bool,
    pub root_dir: PathBuf,
    pub manifest_path: PathBuf,
    /// Every bundled skills directory the manifest declares (`skills` may be a string or an array
    /// of strings), resolved against `root_dir` and verified to stay inside it. Never empty: the
    /// first entry is the primary skills path (TS `skillsPath`), the rest follow manifest order
    /// (TS `skillsPaths`).
    pub skills_dirs: Vec<PathBuf>,
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
                match crate::read_config_file(&local_mp_path)
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
                    "direct",
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

    let raw = match crate::read_config_file(&manifest_path) {
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
    let skills_dirs =
        match resolve_plugin_skills_dirs(plugin_root, obj.get("skills"), &manifest_path) {
            Ok(dirs) => dirs,
            Err(e) => {
                warnings.push(format!(
                    "Failed to catalog plugin at {}: {e}",
                    plugin_root.display()
                ));
                return None;
            }
        };
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

    let interface = obj.get("interface").and_then(Value::as_object);
    let interface_str = |key: &str| {
        interface
            .and_then(|i| i.get(key))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    let display_name = interface_str("displayName").unwrap_or_else(|| name.clone());
    let icon = interface_str("composerIcon").or_else(|| interface_str("logo"));

    let (effective_discovery_kind, effective_marketplace_name) =
        match read_install_marketplace_name(plugin_root) {
            Some(mp_from_install) => ("marketplace", marketplace_name.or(mp_from_install)),
            None => (discovery_kind, marketplace_name),
        };

    Some(DiscoveredPluginRoot {
        id,
        name,
        display_name,
        icon,
        version,
        description,
        scope,
        enabled,
        default_enabled,
        root_dir: plugin_root.to_path_buf(),
        manifest_path,
        skills_dirs,
        mcp_rel_path,
        discovery_kind: effective_discovery_kind,
        marketplace_name: effective_marketplace_name,
    })
}

const DEFAULT_PLUGIN_SKILLS_PATH: &str = "./skills/";

/// Port of TS `resolvePluginSkillsPaths` (`src/plugins/manifest.ts`). The manifest `skills` field
/// is a non-empty string or an array of non-empty strings (trimmed); absent or an empty array falls
/// back to `./skills/`. Each path resolves against the plugin root (absolute paths are kept), must
/// canonicalize inside the root, and duplicates collapse. Explicitly declared paths must exist and
/// be directories; the implicit default may be missing.
fn resolve_plugin_skills_dirs(
    plugin_root: &Path,
    skills_value: Option<&Value>,
    manifest_path: &Path,
) -> Result<Vec<PathBuf>, String> {
    let invalid = || {
        format!(
            "Plugin manifest at {} has an invalid skills value: expected a non-empty string or an array of non-empty strings.",
            manifest_path.display()
        )
    };
    let non_empty = |v: &Value| {
        v.as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    let requested: Vec<Option<String>> = match skills_value {
        None => vec![None],
        Some(Value::Array(items)) if items.is_empty() => vec![None],
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| non_empty(item).map(Some).ok_or_else(invalid))
            .collect::<Result<_, _>>()?,
        Some(other) => vec![Some(non_empty(other).ok_or_else(invalid)?)],
    };
    let validate_existing = requested.iter().all(Option::is_some);

    let mut resolved_dirs: Vec<PathBuf> = Vec::new();
    for requested_value in requested {
        let selected = requested_value
            .as_deref()
            .unwrap_or(DEFAULT_PLUGIN_SKILLS_PATH);
        let skills_dir = normalize_lexical_path(&plugin_root.join(selected));
        // `is_inside` canonicalizes both sides (TS `canonicalizePathForBoundaryCheckSync`).
        if !is_inside(plugin_root, &skills_dir) {
            return Err(format!(
                "Plugin manifest at {} resolves skills outside the plugin root.",
                manifest_path.display()
            ));
        }
        if resolved_dirs.contains(&skills_dir) {
            continue;
        }
        if validate_existing {
            match fs::metadata(&skills_dir) {
                Ok(meta) if meta.is_dir() => {}
                Ok(_) => {
                    return Err(format!(
                        "Plugin manifest at {} declares skills path {}, but it is not a directory.",
                        manifest_path.display(),
                        skills_dir.display()
                    ));
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    return Err(format!(
                        "Plugin manifest at {} declares skills path {}, but that directory does not exist.",
                        manifest_path.display(),
                        skills_dir.display()
                    ));
                }
                Err(e) => return Err(e.to_string()),
            }
        }
        resolved_dirs.push(skills_dir);
    }
    Ok(resolved_dirs)
}

fn read_install_marketplace_name(plugin_root: &Path) -> Option<Option<String>> {
    for rel in [".cowork-plugin/install.json", ".codex-plugin/install.json"] {
        let p = plugin_root.join(rel);
        let Ok(raw) = crate::read_config_file(&p) else {
            continue;
        };
        let Ok(val) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        if let Some(mp_obj) = val.get("marketplace").and_then(Value::as_object) {
            let mp_name = mp_obj
                .get("name")
                .or_else(|| mp_obj.get("id"))
                .or_else(|| mp_obj.get("repo"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned);
            return Some(mp_name);
        }
    }
    None
}
