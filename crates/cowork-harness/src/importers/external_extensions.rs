//! External skill & plugin importer (`cowork/import/{list,plugin,skill}`).
//!
//! Discovers skills and plugins from `~/.claude` and `~/.codex` (derived from `cfg.user_cowork_dir.parent()`),
//! stages `.claude-plugin` bundles into a temporary `.cowork-plugin` directory without mutating the external
//! home, and installs into Cowork's user or workspace scope via `ExtensionManager`.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use cowork_config::{AgentConfig, canonicalize_sync};
use cowork_tools::{ParsedSkillFrontmatter, split_yaml_frontmatter};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use uuid::Uuid;

use crate::extensions::{
    ExtensionManager, PluginCatalogSnapshot, SkillCatalogSnapshot, copy_dir_confined,
};

const CLAUDE_PLUGIN_MANIFEST_DIR_NAME: &str = ".claude-plugin";
const COWORK_PLUGIN_MANIFEST_DIR_NAME: &str = ".cowork-plugin";
const CODEX_PLUGIN_MANIFEST_DIR_NAME: &str = ".codex-plugin";
const MAX_PLUGIN_WALK_DEPTH: usize = 8;
const STRIP_TOP_LEVEL_KEYS: [&str; 4] = ["commands", "agents", "hooks", "$schema"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExternalImportSource {
    Claude,
    Codex,
}

impl ExternalImportSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }

    pub fn home_dir_name(self) -> &'static str {
        match self {
            Self::Claude => ".claude",
            Self::Codex => ".codex",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImportableKind {
    Plugin,
    Skill,
}

impl ImportableKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Plugin => "plugin",
            Self::Skill => "skill",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportDiagnostic {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportableItem {
    pub kind: ImportableKind,
    pub source: ExternalImportSource,
    pub id: String,
    pub display_name: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub source_path: String,
    pub already_installed_global: bool,
    pub already_installed_workspace: bool,
    pub diagnostics: Vec<ImportDiagnostic>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conversion_required: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportListEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub source: ExternalImportSource,
    pub kind: ImportableKind,
    pub home_exists: bool,
    pub items: Vec<ImportableItem>,
}

#[derive(Debug, Clone)]
pub struct ExternalHome {
    pub source: ExternalImportSource,
    pub home_dir: PathBuf,
    pub exists: bool,
    pub plugin_scan_roots: Vec<PathBuf>,
    pub skills_dir: PathBuf,
}

pub fn is_kebab_case_identifier(s: &str) -> bool {
    if s.is_empty() || s.starts_with('-') || s.ends_with('-') || s.contains("--") {
        return false;
    }
    s.bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

pub fn resolve_external_home(
    cfg: &AgentConfig,
    source: ExternalImportSource,
    home_override: Option<&Path>,
) -> ExternalHome {
    let home_dir = match home_override {
        Some(custom) => custom.to_path_buf(),
        None => {
            let base = ExtensionManager::homedir_for(cfg);
            base.join(source.home_dir_name())
        }
    };
    let exists = home_dir.is_dir();
    let plugins_dir = home_dir.join("plugins");
    let plugin_scan_roots = match source {
        ExternalImportSource::Claude => {
            vec![plugins_dir.join("cache"), plugins_dir.join("marketplaces")]
        }
        ExternalImportSource::Codex => vec![plugins_dir.join("cache")],
    };
    ExternalHome {
        source,
        skills_dir: home_dir.join("skills"),
        home_dir,
        exists,
        plugin_scan_roots,
    }
}

fn should_skip_walk_dir_name(name: &str) -> bool {
    name == ".git"
        || name == "node_modules"
        || name.starts_with("plugin-backup-")
        || name.starts_with("plugin-install-")
}

#[derive(Debug, Clone)]
struct DiscoveredPluginRoot {
    root_dir: PathBuf,
    manifest_dir_name: &'static str,
}

fn manifest_dir_name_at(dir: &Path) -> Option<&'static str> {
    [
        COWORK_PLUGIN_MANIFEST_DIR_NAME,
        CODEX_PLUGIN_MANIFEST_DIR_NAME,
        CLAUDE_PLUGIN_MANIFEST_DIR_NAME,
    ]
    .into_iter()
    .find(|&dir_name| dir.join(dir_name).join("plugin.json").is_file())
}

fn discover_plugin_roots(scan_root: &Path) -> Vec<DiscoveredPluginRoot> {
    let mut found = Vec::new();
    let mut visited = BTreeSet::new();

    fn visit(
        dir: &Path,
        depth: usize,
        visited: &mut BTreeSet<PathBuf>,
        found: &mut Vec<DiscoveredPluginRoot>,
    ) {
        if depth > MAX_PLUGIN_WALK_DEPTH {
            return;
        }
        let canonical = canonicalize_sync(dir);
        if !visited.insert(canonical) {
            return;
        }
        if let Some(manifest_dir_name) = manifest_dir_name_at(dir) {
            found.push(DiscoveredPluginRoot {
                root_dir: dir.to_path_buf(),
                manifest_dir_name,
            });
            return;
        }
        let Ok(read_dir) = fs::read_dir(dir) else {
            return;
        };
        let mut entries: Vec<_> = read_dir.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let name = entry.file_name().to_string_lossy().into_owned();
            if should_skip_walk_dir_name(&name) {
                continue;
            }
            let child_path = entry.path();
            let Ok(ft) = entry.file_type() else {
                continue;
            };
            if ft.is_dir()
                || (ft.is_symlink() && fs::metadata(&child_path).is_ok_and(|m| m.is_dir()))
            {
                visit(&child_path, depth + 1, visited, found);
            }
        }
    }

    if scan_root.exists() {
        visit(scan_root, 0, &mut visited, &mut found);
    }
    found.sort_by(|a, b| a.root_dir.cmp(&b.root_dir));
    found
}

fn build_plugin_item(
    discovered: &DiscoveredPluginRoot,
    source: ExternalImportSource,
    installed_user: &BTreeSet<String>,
    installed_workspace: &BTreeSet<String>,
) -> ImportableItem {
    let conversion_required = discovered.manifest_dir_name == CLAUDE_PLUGIN_MANIFEST_DIR_NAME;
    let manifest_path = discovered
        .root_dir
        .join(discovered.manifest_dir_name)
        .join("plugin.json");
    let source_path = discovered.root_dir.to_string_lossy().into_owned();

    let fallback_invalid = |msg: String| -> ImportableItem {
        let id = discovered
            .root_dir
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "plugin".to_owned());
        ImportableItem {
            kind: ImportableKind::Plugin,
            source,
            display_name: id.clone(),
            id,
            description: "Invalid plugin bundle".to_owned(),
            version: None,
            source_path: source_path.clone(),
            already_installed_global: false,
            already_installed_workspace: false,
            diagnostics: vec![ImportDiagnostic {
                code: "invalid_plugin_manifest".to_owned(),
                message: format!("Invalid or unreadable plugin manifest: {msg}"),
            }],
            conversion_required: Some(conversion_required),
        }
    };

    let raw = match fs::read_to_string(&manifest_path) {
        Ok(s) => s,
        Err(e) => return fallback_invalid(e.to_string()),
    };
    let parsed: Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => return fallback_invalid(e.to_string()),
    };
    let Some(obj) = parsed.as_object() else {
        return fallback_invalid("plugin.json must be a JSON object.".to_owned());
    };
    let Some(name) = obj
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return fallback_invalid("plugin.json missing non-empty name.".to_owned());
    };
    if !conversion_required {
        // Native cowork/codex manifests require non-empty description.
        if obj
            .get("description")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .is_none()
        {
            return fallback_invalid("plugin.json missing non-empty description.".to_owned());
        }
    }

    let mut diagnostics = Vec::new();
    if !is_kebab_case_identifier(name) {
        diagnostics.push(ImportDiagnostic {
            code: "invalid_plugin_name".to_owned(),
            message: format!("Plugin name \"{name}\" is not a valid kebab-case identifier."),
        });
    }
    let display_name = obj
        .get("interface")
        .and_then(Value::as_object)
        .and_then(|iface| iface.get("displayName"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(name)
        .to_owned();
    let description = obj
        .get("description")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(name)
        .to_owned();
    let version = obj
        .get("version")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned);

    ImportableItem {
        kind: ImportableKind::Plugin,
        source,
        id: name.to_owned(),
        display_name,
        description,
        version,
        source_path,
        already_installed_global: installed_user.contains(name),
        already_installed_workspace: installed_workspace.contains(name),
        diagnostics,
        conversion_required: Some(conversion_required),
    }
}

fn parse_loose_skill_frontmatter(raw: &str) -> Option<(String, String)> {
    let (yaml_opt, _) = split_yaml_frontmatter(raw);
    let yaml = yaml_opt?;
    if let Ok(fm) = serde_saphyr::from_str::<ParsedSkillFrontmatter>(&yaml) {
        let name = fm
            .name
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())?;
        let desc = fm
            .description
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .to_owned();
        return Some((name.to_owned(), desc));
    }
    None
}

fn build_skill_item(
    skill_root: &Path,
    source: ExternalImportSource,
    installed_global: &BTreeSet<String>,
    installed_project: &BTreeSet<String>,
) -> Option<ImportableItem> {
    let dir_name = skill_root.file_name()?.to_string_lossy().into_owned();
    let skill_path = skill_root.join("SKILL.md");
    let raw = fs::read_to_string(&skill_path).ok()?;
    let source_path = skill_root.to_string_lossy().into_owned();

    let Some((parsed_name, parsed_desc)) = parse_loose_skill_frontmatter(&raw) else {
        return Some(ImportableItem {
            kind: ImportableKind::Skill,
            source,
            id: dir_name.clone(),
            display_name: dir_name,
            description: "Invalid skill source".to_owned(),
            version: None,
            source_path,
            already_installed_global: false,
            already_installed_workspace: false,
            diagnostics: vec![ImportDiagnostic {
                code: "invalid_frontmatter".to_owned(),
                message: "Invalid or missing SKILL.md frontmatter.".to_owned(),
            }],
            conversion_required: None,
        });
    };

    if !is_kebab_case_identifier(&parsed_name) || parsed_name != dir_name {
        let msg = if parsed_name != dir_name {
            format!("Skill name \"{parsed_name}\" does not match its directory \"{dir_name}\".")
        } else {
            format!("Skill name \"{parsed_name}\" is not a valid kebab-case identifier.")
        };
        return Some(ImportableItem {
            kind: ImportableKind::Skill,
            source,
            id: dir_name.clone(),
            display_name: dir_name.clone(),
            description: if parsed_desc.is_empty() {
                dir_name
            } else {
                parsed_desc
            },
            version: None,
            source_path,
            already_installed_global: false,
            already_installed_workspace: false,
            diagnostics: vec![ImportDiagnostic {
                code: "name_mismatch".to_owned(),
                message: msg,
            }],
            conversion_required: None,
        });
    }

    if parsed_desc.trim().is_empty() {
        return Some(ImportableItem {
            kind: ImportableKind::Skill,
            source,
            id: dir_name.clone(),
            display_name: dir_name,
            description: "Invalid skill source".to_owned(),
            version: None,
            source_path,
            already_installed_global: false,
            already_installed_workspace: false,
            diagnostics: vec![ImportDiagnostic {
                code: "invalid_frontmatter".to_owned(),
                message: "Invalid or missing SKILL.md frontmatter.".to_owned(),
            }],
            conversion_required: None,
        });
    }

    Some(ImportableItem {
        kind: ImportableKind::Skill,
        source,
        id: parsed_name.clone(),
        display_name: parsed_name.clone(),
        description: parsed_desc,
        version: None,
        source_path,
        already_installed_global: installed_global.contains(&parsed_name),
        already_installed_workspace: installed_project.contains(&parsed_name),
        diagnostics: Vec::new(),
        conversion_required: None,
    })
}

fn dedupe_importable(items: Vec<ImportableItem>) -> Vec<ImportableItem> {
    let mut by_key: BTreeMap<String, ImportableItem> = BTreeMap::new();
    for item in items {
        let key = format!(
            "{}:{}:{}",
            item.source.as_str(),
            item.kind.as_str(),
            item.id
        );
        let replace = match by_key.get(&key) {
            None => true,
            Some(existing) => !existing.diagnostics.is_empty() && item.diagnostics.is_empty(),
        };
        if replace {
            by_key.insert(key, item);
        }
    }
    let mut out: Vec<ImportableItem> = by_key.into_values().collect();
    out.sort_by(|a, b| a.display_name.cmp(&b.display_name));
    out
}

/// Lists importable plugins or skills from an external Claude or Codex home.
pub fn list_importable(
    ext: &ExtensionManager,
    cfg: &AgentConfig,
    source: ExternalImportSource,
    kind: ImportableKind,
    session_id: Option<String>,
    home_override: Option<&Path>,
) -> ImportListEvent {
    let home = resolve_external_home(cfg, source, home_override);
    let items = if !home.exists {
        Vec::new()
    } else {
        match kind {
            ImportableKind::Plugin => {
                let (installed_plugins, _) = ext.collect_installed_plugins(cfg);
                let installed_user: BTreeSet<String> = installed_plugins
                    .iter()
                    .filter(|p| p.scope == "user")
                    .map(|p| p.id.clone())
                    .collect();
                let installed_workspace: BTreeSet<String> = installed_plugins
                    .iter()
                    .filter(|p| p.scope == "workspace")
                    .map(|p| p.id.clone())
                    .collect();
                let mut raw_items = Vec::new();
                let mut seen = BTreeSet::new();
                for scan_root in &home.plugin_scan_roots {
                    for discovered in discover_plugin_roots(scan_root) {
                        let item = build_plugin_item(
                            &discovered,
                            home.source,
                            &installed_user,
                            &installed_workspace,
                        );
                        let key = format!("{}:{}", home.source.as_str(), item.id);
                        if seen.contains(&key) && item.diagnostics.is_empty() {
                            continue;
                        }
                        seen.insert(key);
                        raw_items.push(item);
                    }
                }
                dedupe_importable(raw_items)
            }
            ImportableKind::Skill => {
                let installations = ext.collect_skill_installations(cfg);
                let installed_global: BTreeSet<String> = installations
                    .iter()
                    .filter(|i| i.plugin.is_none() && i.scope == "global")
                    .map(|i| i.name.clone())
                    .collect();
                let installed_project: BTreeSet<String> = installations
                    .iter()
                    .filter(|i| i.plugin.is_none() && i.scope == "project")
                    .map(|i| i.name.clone())
                    .collect();
                let mut raw_items = Vec::new();
                if let Ok(read_dir) = fs::read_dir(&home.skills_dir) {
                    let mut entries: Vec<_> = read_dir.flatten().collect();
                    entries.sort_by_key(|e| e.file_name());
                    for entry in entries {
                        let child_path = entry.path();
                        let is_dir = entry
                            .file_type()
                            .map(|ft| {
                                ft.is_dir()
                                    || (ft.is_symlink()
                                        && fs::metadata(&child_path).is_ok_and(|m| m.is_dir()))
                            })
                            .unwrap_or(false);
                        if !is_dir {
                            continue;
                        }
                        if let Some(item) = build_skill_item(
                            &child_path,
                            home.source,
                            &installed_global,
                            &installed_project,
                        ) {
                            raw_items.push(item);
                        }
                    }
                }
                dedupe_importable(raw_items)
            }
        }
    };

    ImportListEvent {
        event_type: "import_list".to_owned(),
        session_id,
        source,
        kind,
        home_exists: home.exists,
        items,
    }
}

struct StagedPluginGuard {
    stage_dir: PathBuf,
    staged_root: PathBuf,
}

impl Drop for StagedPluginGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.stage_dir);
    }
}

fn sanitize_claude_manifest(parsed: Value) -> Value {
    let Some(mut map) = parsed.as_object().cloned() else {
        return Value::Object(Map::new());
    };
    for key in STRIP_TOP_LEVEL_KEYS {
        map.remove(key);
    }
    if let Some(mcp_val) = map.get("mcpServers")
        && !mcp_val.is_string()
    {
        map.remove("mcpServers");
    }
    if !map.contains_key("description")
        && let Some(name) = map.get("name").cloned()
    {
        map.insert("description".to_owned(), name);
    }
    Value::Object(map)
}

fn stage_claude_plugin_for_install(
    source_root: &Path,
    staging_parent: &Path,
) -> Result<StagedPluginGuard, String> {
    if !source_root.is_dir() {
        return Err(format!(
            "Plugin source directory does not exist: {}",
            source_root.display()
        ));
    }
    let stage_dir = staging_parent.join(format!(
        ".tmp-agent-coworker-import-{}",
        Uuid::new_v4().simple()
    ));
    let base_name = source_root
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "plugin".to_owned());
    let staged_root = stage_dir.join(base_name);
    fs::create_dir_all(&stage_dir).map_err(|e| format!("Failed creating staging dir: {e}"))?;
    let guard = StagedPluginGuard {
        stage_dir,
        staged_root,
    };

    copy_dir_confined(source_root, &guard.staged_root)?;

    let claude_manifest_dir = guard.staged_root.join(CLAUDE_PLUGIN_MANIFEST_DIR_NAME);
    let cowork_manifest_dir = guard.staged_root.join(COWORK_PLUGIN_MANIFEST_DIR_NAME);
    if !claude_manifest_dir.is_dir() {
        return Err(format!(
            "Missing {CLAUDE_PLUGIN_MANIFEST_DIR_NAME} directory in {}",
            source_root.display()
        ));
    }
    if cowork_manifest_dir.exists() {
        let _ = fs::remove_dir_all(&cowork_manifest_dir);
    }
    fs::rename(&claude_manifest_dir, &cowork_manifest_dir)
        .map_err(|e| format!("Failed renaming manifest directory: {e}"))?;

    let manifest_path = cowork_manifest_dir.join("plugin.json");
    let raw = fs::read_to_string(&manifest_path)
        .map_err(|e| format!("Failed reading staged plugin.json: {e}"))?;
    let parsed: Value = serde_json::from_str(&raw)
        .map_err(|e| format!("Invalid JSON in staged plugin.json: {e}"))?;
    let sanitized = sanitize_claude_manifest(parsed);
    let formatted = format!(
        "{}\n",
        serde_json::to_string_pretty(&sanitized).map_err(|e| e.to_string())?
    );
    fs::write(&manifest_path, formatted)
        .map_err(|e| format!("Failed writing converted plugin.json: {e}"))?;

    Ok(guard)
}

/// Imports an external plugin (`target_scope`: `"workspace"` | `"user"`), converting `.claude-plugin` if needed.
pub async fn import_external_plugin(
    ext: &ExtensionManager,
    cfg: &AgentConfig,
    source_path: &Path,
    conversion_required: bool,
    target_scope: &str,
) -> Result<PluginCatalogSnapshot, String> {
    if conversion_required {
        let guard = stage_claude_plugin_for_install(source_path, &cfg.user_cowork_dir)?;
        let staged_str = guard.staged_root.to_string_lossy().into_owned();
        ext.install_plugin(cfg, &staged_str, target_scope).await
    } else {
        let src_str = source_path.to_string_lossy().into_owned();
        ext.install_plugin(cfg, &src_str, target_scope).await
    }
}

/// Imports an external skill (`target_scope`: `"workspace"` -> `"project"`, `"user"` -> `"global"`).
pub async fn import_external_skill(
    ext: &ExtensionManager,
    cfg: &AgentConfig,
    source_path: &Path,
    target_scope: &str,
) -> Result<SkillCatalogSnapshot, String> {
    let skill_scope = if target_scope == "user" {
        "global"
    } else {
        "project"
    };
    let src_str = source_path.to_string_lossy().into_owned();
    ext.install_skill(cfg, &src_str, skill_scope).await
}
