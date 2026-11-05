use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use cowork_config::{AgentConfig, ChildModelRoutingMode, ProviderName, UserProfile};
use cowork_providers::{ProviderCatalogEntry, ProviderCatalogPayload, ProviderCatalogSnapshot};
use cowork_tools::{DiscoveredSkill, render_skill_body_for_model};
use regex::Regex;
use serde_json::{Map, Value};

use crate::agents::profiles::AgentProfilesStore;
use crate::extensions::{ExtensionManager, InstalledPluginCatalogEntry};
use crate::prompt_template::{format_agent_profile_prompt_summaries, render_system_template};

const MAX_PROJECT_INSTRUCTIONS_BYTES: usize = 32 * 1024;
const MAX_WORKSPACE_MAP_ENTRIES: usize = 60;

const DEFAULT_BASE_SYSTEM_PROMPT: &str = "You are Cowork, an autonomous local-first software engineering and workspace assistant. Act directly, follow project instructions and safety boundaries, verify changes with appropriate tools, and communicate concisely.";

#[derive(Debug, Clone)]
pub struct SystemPromptBuildOptions {
    pub prompts_dir: Option<PathBuf>,
    pub prompt_template: Option<String>,
    pub working_directory: PathBuf,
    pub output_directory: PathBuf,
    pub uploads_directory: PathBuf,
    pub cowork_home: PathBuf,
    pub provider: ProviderName,
    pub model: String,
    pub sandbox_mode_label: String,
    pub network_enabled: bool,
    pub available_skills: BTreeMap<String, DiscoveredSkill>,
    pub memory_section: Option<String>,
    pub task_context_section: Option<String>,
    pub workspace_context: Option<Value>,
    pub harness_context: Option<Value>,
    pub referenced_plugins: Vec<ReferencedPluginContext>,
    pub deferred_tool_search_enabled: bool,
    pub code_mode_enabled: bool,
    /// Values for the bundled system template's `{{...}}` variables.
    pub template_context: PromptTemplateContext,
}

/// Effective-config inputs for the bundled system template variables (legacy
/// `loadSystemPromptWithSkills` `vars`). Blank profile fields drop their template lines.
#[derive(Debug, Clone, Default)]
pub struct PromptTemplateContext {
    pub user_name: String,
    pub user_profile: UserProfile,
    /// Registry display name of the session model; `None` renders the model id.
    pub model_display_name: Option<String>,
    /// Registry knowledge cutoff of the session model; `None` renders `Unknown`.
    pub knowledge_cutoff: Option<String>,
    /// Whether the session model accepts image input (legacy `supportsImageInput`): keeps or
    /// strips the templates' `<image_input>` spans. `None` resolves it from the bundled
    /// registry, falling back to the placeholder capability for unknown models.
    pub supports_image_input: Option<bool>,
    /// Legacy `config.enableMemory` (`None` = enabled, the legacy `?? true`).
    pub enable_memory: Option<bool>,
    /// Legacy `config.advancedMemory`: strips the legacy memory guidance.
    pub advanced_memory: bool,
    /// The session's effective provider options (legacy `config.providerOptions`); selects the
    /// web-search guidance rewrites. `None` behaves like legacy `providerOptions == null`.
    pub provider_options: Option<Map<String, Value>>,
    /// Legacy `config.childModelRoutingMode`.
    pub child_model_routing_mode: ChildModelRoutingMode,
    /// Legacy `config.allowedChildModelRefs`.
    pub allowed_child_model_refs: Vec<String>,
    /// Legacy `formatAgentProfilePromptSummaries(readAgentProfilesCatalog(config))`.
    pub agent_profile_lines: Vec<String>,
    /// Provider catalog for the spawnAgent model-override list (legacy
    /// `readProviderCatalogSnapshot`). `None` renders the legacy read-failure fallback: the
    /// static registry models with their `bestFor` guidance.
    pub provider_catalog: Option<PromptProviderCatalog>,
    /// True when deferred tool search uses the provider's native wire protocol rather than
    /// Cowork's harness `toolSearch` / `toolCall` meta-tools.
    pub native_tool_search_enabled: bool,
    /// True when programmatic tool calling uses the provider's native code execution wire
    /// protocol rather than Cowork's QuickJS `codeMode` tool.
    pub native_code_execution_enabled: bool,
}

impl PromptTemplateContext {
    /// The user name, profile, memory flags, provider options, child-model routing, and agent
    /// profile summaries of `config`, without model metadata or a provider catalog.
    pub fn from_config(config: &AgentConfig) -> Self {
        let profiles = AgentProfilesStore::new(&config.user_cowork_dir, &config.working_directory)
            .read_catalog();
        Self {
            user_name: config.user_name.clone(),
            user_profile: config.user_profile.clone(),
            enable_memory: Some(config.enable_memory),
            advanced_memory: config.advanced_memory,
            provider_options: config.provider_options.clone(),
            child_model_routing_mode: config.child_model_routing_mode,
            allowed_child_model_refs: config.allowed_child_model_refs.clone(),
            agent_profile_lines: format_agent_profile_prompt_summaries(&profiles),
            ..Self::default()
        }
    }
}

/// The provider catalog view the spawnAgent prompt reads (legacy `ProviderCatalogPayload |
/// ProviderCatalogSnapshot`).
#[derive(Debug, Clone, Default)]
pub struct PromptProviderCatalog {
    /// Every provider entry with its models (`enabled: Some(false)` = disabled) and default.
    pub all: Vec<ProviderCatalogEntry>,
    /// Snapshot `configured` providers, or live payload `connected` providers.
    pub available: Vec<ProviderName>,
    /// A cache-only snapshot (legacy `"configured" in catalog`): adds the availability note.
    pub cache_only_snapshot: bool,
}

impl PromptProviderCatalog {
    /// A cache-only snapshot (legacy `readProviderCatalogSnapshot`, what `loadSystemPrompt`
    /// reads): `configured` providers, with the snapshot availability note.
    pub fn from_snapshot(snapshot: ProviderCatalogSnapshot) -> Self {
        Self {
            all: snapshot.all,
            available: snapshot.configured,
            cache_only_snapshot: true,
        }
    }

    /// A live catalog payload (`connected` providers, no snapshot note).
    pub fn from_live_payload(payload: &ProviderCatalogPayload) -> Self {
        Self {
            all: payload.all.clone(),
            available: payload
                .connected
                .iter()
                .filter_map(|p| ProviderName::parse(p))
                .collect(),
            cache_only_snapshot: false,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct ResolvedTurnMentions {
    pub injected_skill_blocks: Vec<String>,
    /// Canonical names of the skills whose bodies were injected, in injection order.
    pub injected_skill_names: Vec<String>,
    pub referenced_plugins: Vec<ReferencedPluginContext>,
}

/// Legacy `ReferencedPluginContext`: an enabled plugin the user referenced, resolved through the
/// installed plugin catalog (soft awareness rendered into the `## Referenced Plugins` section).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReferencedPluginContext {
    /// Catalog plugin name (manifest `name`, not the install directory).
    pub name: String,
    pub display_name: String,
    /// Enabled bundled skills (qualified `plugin:skill`) that are also enabled/available skills.
    pub skill_names: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnReferenceKind {
    Skill,
    Plugin,
}

/// A skill or plugin the client explicitly referenced on `turn/start` / `turn/steer`
/// (`references: [{ "kind": "skill", "name": "documents" }]`, legacy `TurnReference`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnReference {
    pub kind: TurnReferenceKind,
    pub name: String,
}

/// Legacy `turnReferencesSchema` bound: each skill reference injects a full SKILL.md body.
pub const MAX_TURN_REFERENCES: usize = 32;

/// Validates the wire `references` array (`{ kind: "skill" | "plugin", name }`, strict, at most
/// [`MAX_TURN_REFERENCES`], names trimmed and non-empty).
pub fn parse_turn_references(raw: Option<&[Value]>) -> Result<Vec<TurnReference>, String> {
    let Some(raw) = raw else {
        return Ok(Vec::new());
    };
    if raw.len() > MAX_TURN_REFERENCES {
        return Err(format!(
            "references must contain at most {MAX_TURN_REFERENCES} entries"
        ));
    }
    raw.iter()
        .enumerate()
        .map(|(idx, item)| {
            let obj = item
                .as_object()
                .ok_or_else(|| format!("references[{idx}] must be an object"))?;
            if let Some(extra) = obj.keys().find(|k| *k != "kind" && *k != "name") {
                return Err(format!("references[{idx}] has unknown field '{extra}'"));
            }
            let kind = match obj.get("kind").and_then(Value::as_str) {
                Some("skill") => TurnReferenceKind::Skill,
                Some("plugin") => TurnReferenceKind::Plugin,
                _ => {
                    return Err(format!(
                        "references[{idx}].kind must be \"skill\" or \"plugin\""
                    ));
                }
            };
            let name = obj
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|n| !n.is_empty())
                .ok_or_else(|| format!("references[{idx}].name must be a non-empty string"))?;
            Ok(TurnReference {
                kind,
                name: name.to_owned(),
            })
        })
        .collect()
}

/// Exact name first, then a case-insensitive match (`@Documents` → `documents`).
fn lookup_skill<'a>(
    skills: &'a BTreeMap<String, DiscoveredSkill>,
    name: &str,
) -> Option<&'a DiscoveredSkill> {
    skills.get(name).or_else(|| {
        skills
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, skill)| skill)
    })
}

/// Mention tokens may carry sentence punctuation (`@documents.`, `@documents:`); strip it.
fn normalize_mention_token(token: &str) -> &str {
    token.trim_end_matches(['.', ',', ':', ';', '!', '?', '-'])
}

/// The installed plugin catalog for `config` (legacy `buildPluginCatalogSnapshot().plugins`),
/// used to resolve plugin references. Local discovery only; no marketplace fetch.
pub fn installed_plugin_catalog(config: &AgentConfig) -> Vec<InstalledPluginCatalogEntry> {
    ExtensionManager::new(HashMap::new())
        .collect_installed_plugins(config)
        .0
}

/// Minimal view of a catalog plugin used by mention resolution.
struct CatalogPlugin {
    name: String,
    display_name: String,
    enabled: bool,
    /// `(qualified skill name, enabled)`.
    skills: Vec<(String, bool)>,
}

impl From<InstalledPluginCatalogEntry> for CatalogPlugin {
    fn from(entry: InstalledPluginCatalogEntry) -> Self {
        Self {
            name: entry.name,
            display_name: entry.display_name,
            enabled: entry.enabled,
            skills: entry
                .skills
                .into_iter()
                .map(|skill| (skill.name, skill.enabled))
                .collect(),
        }
    }
}

/// Without a config, the only plugins knowable are the enabled ones whose skills were discovered
/// (`discover_skills_for_config` only yields skills of enabled plugins).
fn catalog_from_plugin_skills(skills: &BTreeMap<String, DiscoveredSkill>) -> Vec<CatalogPlugin> {
    let mut by_plugin: BTreeMap<&str, Vec<(String, bool)>> = BTreeMap::new();
    for skill in skills.values() {
        if let Some(plugin) = skill.plugin_name.as_deref() {
            by_plugin
                .entry(plugin)
                .or_default()
                .push((skill.name.clone(), skill.enabled));
        }
    }
    by_plugin
        .into_iter()
        .map(|(name, skills)| CatalogPlugin {
            name: name.to_owned(),
            display_name: name.to_owned(),
            enabled: true,
            skills,
        })
        .collect()
}

struct MentionResolver<'a, F> {
    skills: &'a BTreeMap<String, DiscoveredSkill>,
    /// Loaded on the first plugin lookup only.
    load_plugin_catalog: Option<F>,
    plugin_catalog: Vec<CatalogPlugin>,
    out: ResolvedTurnMentions,
    seen_skills: std::collections::BTreeSet<String>,
    seen_plugins: std::collections::BTreeSet<String>,
}

impl<F: FnOnce() -> Vec<CatalogPlugin>> MentionResolver<'_, F> {
    /// Injects the skill named `name` (once). Returns whether `name` resolved to a skill.
    fn try_skill(&mut self, name: &str) -> bool {
        let Some(skill) = lookup_skill(self.skills, name) else {
            return false;
        };
        if self.seen_skills.insert(skill.name.clone())
            && let Ok(rendered) = render_skill_body_for_model(skill)
        {
            self.out.injected_skill_blocks.push(format!(
                "<skill_context name={:?}>\n{}\n</skill_context>",
                skill.name, rendered
            ));
            self.out.injected_skill_names.push(skill.name.clone());
        }
        true
    }

    /// Legacy `resolveReferencedPlugins`: the enabled catalog entry named `name` (exact, then
    /// case-insensitive for desktop-style `@Mentions`) with its enabled bundled skills.
    fn try_plugin(&mut self, name: &str) {
        if self.seen_plugins.contains(name) {
            return;
        }
        if let Some(load) = self.load_plugin_catalog.take() {
            self.plugin_catalog = load();
        }
        let enabled = || self.plugin_catalog.iter().filter(|p| p.enabled);
        let Some(entry) = enabled()
            .find(|p| p.name == name)
            .or_else(|| enabled().find(|p| p.name.eq_ignore_ascii_case(name)))
        else {
            return;
        };
        let display_name = entry.display_name.trim();
        let resolved = ReferencedPluginContext {
            name: entry.name.clone(),
            display_name: if display_name.is_empty() {
                entry.name.clone()
            } else {
                display_name.to_owned()
            },
            skill_names: entry
                .skills
                .iter()
                .filter(|(skill, enabled)| {
                    *enabled && self.skills.get(skill).is_some_and(|s| s.enabled)
                })
                .map(|(skill, _)| skill.clone())
                .collect(),
        };
        let first = self.seen_plugins.insert(resolved.name.clone());
        self.seen_plugins.insert(name.to_owned());
        if first {
            self.out.referenced_plugins.push(resolved);
        }
    }
}

/// Resolves `@skill-name` (user-turn skill injection) and `@plugin-name` (system prompt section)
/// mentions in a user prompt. Without a config, plugins resolve only through the discovered
/// plugin-owned skills; prefer [`resolve_turn_references_with_plugin_catalog`].
pub fn resolve_turn_mentions(
    user_text: &str,
    skills: &BTreeMap<String, DiscoveredSkill>,
    cowork_home: &Path,
    working_directory: &Path,
) -> ResolvedTurnMentions {
    resolve_turn_references(user_text, &[], skills, cowork_home, working_directory)
}

/// [`resolve_turn_references_with_plugin_catalog`] without an installed plugin catalog: plugin
/// references resolve only to enabled plugins that own a discovered skill in `skills`.
/// `cowork_home` / `working_directory` are kept for call-site compatibility.
pub fn resolve_turn_references(
    user_text: &str,
    references: &[TurnReference],
    skills: &BTreeMap<String, DiscoveredSkill>,
    _cowork_home: &Path,
    _working_directory: &Path,
) -> ResolvedTurnMentions {
    resolve_references(user_text, references, skills, || {
        catalog_from_plugin_skills(skills)
    })
}

/// Resolves the explicit `references` first (legacy `resolveReferencedSkills` /
/// `resolveReferencedPlugins`: skills take precedence over a plugin of the same name), then
/// falls back to `@name` mentions in `user_text`, matched case-insensitively with trailing
/// punctuation stripped. Each skill is injected at most once.
///
/// Plugin references resolve through the installed plugin catalog (see
/// [`installed_plugin_catalog`]), which is loaded lazily on the first plugin lookup: only enabled
/// entries match, by catalog name, and each yields its enabled bundled skill names.
pub fn resolve_turn_references_with_plugin_catalog(
    user_text: &str,
    references: &[TurnReference],
    skills: &BTreeMap<String, DiscoveredSkill>,
    plugin_catalog: impl FnOnce() -> Vec<InstalledPluginCatalogEntry>,
) -> ResolvedTurnMentions {
    resolve_references(user_text, references, skills, || {
        plugin_catalog()
            .into_iter()
            .map(CatalogPlugin::from)
            .collect()
    })
}

fn resolve_references(
    user_text: &str,
    references: &[TurnReference],
    skills: &BTreeMap<String, DiscoveredSkill>,
    load_plugin_catalog: impl FnOnce() -> Vec<CatalogPlugin>,
) -> ResolvedTurnMentions {
    static MENTION_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let re = MENTION_RE.get_or_init(|| {
        Regex::new(r"(?:^|[\s(])@([A-Za-z0-9_.:-]+)").expect("valid mention regex")
    });

    let mut resolver = MentionResolver {
        skills,
        load_plugin_catalog: Some(load_plugin_catalog),
        plugin_catalog: Vec::new(),
        out: ResolvedTurnMentions::default(),
        seen_skills: std::collections::BTreeSet::new(),
        seen_plugins: std::collections::BTreeSet::new(),
    };

    for reference in references
        .iter()
        .filter(|r| r.kind == TurnReferenceKind::Skill)
    {
        resolver.try_skill(&reference.name);
    }
    for reference in references
        .iter()
        .filter(|r| r.kind == TurnReferenceKind::Plugin)
    {
        if lookup_skill(skills, &reference.name).is_none() {
            resolver.try_plugin(&reference.name);
        }
    }

    for caps in re.captures_iter(user_text) {
        let Some(raw) = caps.get(1).map(|m| m.as_str()) else {
            continue;
        };
        let token = normalize_mention_token(raw);
        if token.is_empty() {
            continue;
        }
        if resolver.try_skill(token) || (raw != token && resolver.try_skill(raw)) {
            continue;
        }
        resolver.try_plugin(token);
    }

    resolver.out
}

/// The base system prompt: a bundled template file (rendered with template variables, like
/// legacy `loadSystemPromptWithSkills`) or inline text (role prompts, the built-in default),
/// which is used verbatim like legacy `loadAgentPrompt`.
enum BaseTemplate {
    File(String),
    Inline(String),
}

fn read_template_file(path: &Path) -> Option<String> {
    let content = fs::read_to_string(path).ok()?;
    let trimmed = content.trim();
    (!trimmed.is_empty()).then(|| trimmed.replace("\r\n", "\n").replace('\r', "\n"))
}

fn load_base_template(prompts_dir: Option<&Path>, template_name: Option<&str>) -> BaseTemplate {
    if let Some(name) = template_name {
        if let Some(dir) = prompts_dir
            && !name.contains('\n')
            && !name.contains(' ')
        {
            let clean = name.trim_matches(['/', '\\']);
            let file_name = if clean.ends_with(".md") {
                clean.to_owned()
            } else {
                format!("{clean}.md")
            };
            if let Some(content) = read_template_file(&dir.join(file_name)) {
                return BaseTemplate::File(content);
            }
        }
        if name.contains('\n') || name.contains(' ') {
            let trimmed = name.trim();
            if !trimmed.is_empty() {
                return BaseTemplate::Inline(trimmed.to_owned());
            }
        }
    }
    if let Some(dir) = prompts_dir
        && let Some(sys) = read_template_file(&dir.join("system.md"))
    {
        return BaseTemplate::File(sys);
    }
    BaseTemplate::Inline(DEFAULT_BASE_SYSTEM_PROMPT.to_owned())
}

/// Highest-precedence first; only the first readable file in a directory is used, so
/// `AGENTS.override.md` supersedes `AGENTS.md` (and `CLAUDE.md` is only a fallback).
const PROJECT_INSTRUCTION_FILENAMES: [&str; 3] = ["AGENTS.override.md", "AGENTS.md", "CLAUDE.md"];
const PROJECT_INSTRUCTIONS_TRUNCATED_NOTICE: &str =
    "... (truncated: kept the most specific project instructions within the byte limit)";
const PROJECT_INSTRUCTIONS_FILE_TRUNCATED_SUFFIX: &str =
    "\n\n… (truncated: project instructions exceeded byte limit)";

struct LoadedInstructionFile {
    path: PathBuf,
    content: String,
    truncated: bool,
}

/// Directories from the git root down to and including `working_directory`, or just
/// `working_directory` when it is not inside a git repository.
fn instruction_directories(working_directory: &Path) -> Vec<PathBuf> {
    let mut chain = Vec::<PathBuf>::new();
    let mut cursor = Some(working_directory);
    while let Some(dir) = cursor {
        chain.push(dir.to_path_buf());
        if dir.join(".git").exists() {
            chain.reverse();
            return chain;
        }
        cursor = dir.parent();
    }
    vec![working_directory.to_path_buf()]
}

fn utf8_prefix_within_byte_limit(bytes: &[u8], max_bytes: usize) -> String {
    let mut end = max_bytes.min(bytes.len());
    while end > 0 && end < bytes.len() && (bytes[end] & 0xC0) == 0x80 {
        end -= 1;
    }
    String::from_utf8_lossy(&bytes[..end]).into_owned()
}

fn truncate_utf8_bytes(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_owned();
    }
    let suffix = PROJECT_INSTRUCTIONS_FILE_TRUNCATED_SUFFIX;
    if max_bytes <= suffix.len() {
        return utf8_prefix_within_byte_limit(value.as_bytes(), max_bytes);
    }
    let truncated = utf8_prefix_within_byte_limit(value.as_bytes(), max_bytes - suffix.len());
    if truncated.is_empty() {
        suffix.trim_start().to_owned()
    } else {
        format!("{truncated}{suffix}")
    }
}

/// Returns the highest-precedence readable instruction file in `dir`, reading at most
/// `max_bytes` (plus one byte to detect truncation).
fn load_instruction_file_for_directory(
    dir: &Path,
    max_bytes: usize,
) -> Option<LoadedInstructionFile> {
    for filename in PROJECT_INSTRUCTION_FILENAMES {
        let path = dir.join(filename);
        if !path.is_file() {
            continue;
        }
        let Ok(file) = fs::File::open(&path) else {
            continue;
        };
        let mut buf = Vec::new();
        if file
            .take(max_bytes as u64 + 1)
            .read_to_end(&mut buf)
            .is_err()
        {
            continue;
        }
        let truncated = buf.len() > max_bytes;
        let content = utf8_prefix_within_byte_limit(&buf, max_bytes);
        return Some(LoadedInstructionFile {
            path,
            content,
            truncated,
        });
    }
    None
}

fn render_instruction_block(file: &LoadedInstructionFile) -> String {
    format!("### {}\n{}", file.path.display(), file.content.trim())
}

fn render_project_instructions_within_byte_limit(
    files: &[LoadedInstructionFile],
    max_bytes: usize,
) -> String {
    let blocks: Vec<String> = files.iter().map(render_instruction_block).collect();
    let rendered = blocks.join("\n\n");
    if !files.iter().any(|f| f.truncated) && rendered.len() <= max_bytes {
        return rendered;
    }

    let build_truncated = |selected: &[&str]| -> String {
        std::iter::once(PROJECT_INSTRUCTIONS_TRUNCATED_NOTICE)
            .chain(selected.iter().copied())
            .collect::<Vec<_>>()
            .join("\n\n")
    };

    let Some(most_specific) = blocks.last() else {
        return String::new();
    };
    if build_truncated(&[most_specific]).len() > max_bytes {
        let prefix_len = PROJECT_INSTRUCTIONS_TRUNCATED_NOTICE.len() + 2;
        let truncated = truncate_utf8_bytes(most_specific, max_bytes.saturating_sub(prefix_len));
        return if truncated.is_empty() {
            build_truncated(&[])
        } else {
            build_truncated(&[&truncated])
        };
    }

    // Keep the most specific file, then add ancestors (nearest first) while they fit.
    let mut selected: Vec<&str> = vec![most_specific];
    for i in (0..blocks.len() - 1).rev() {
        if files[i].truncated {
            break;
        }
        let mut candidate = Vec::with_capacity(selected.len() + 1);
        candidate.push(blocks[i].as_str());
        candidate.extend(selected.iter().copied());
        if build_truncated(&candidate).len() > max_bytes {
            break;
        }
        selected = candidate;
    }
    build_truncated(&selected)
}

/// Walks from the git root (or just `working_directory` outside a repo) down to
/// `working_directory`, taking the highest-precedence instruction file per directory
/// (`AGENTS.override.md` > `AGENTS.md` > `CLAUDE.md`). Within the 32 KiB budget the most
/// specific file is kept first and ancestors are added only while space remains; retained
/// files render in hierarchy order (root first).
pub fn collect_project_instructions(working_directory: &Path) -> Option<String> {
    let mut files = Vec::<LoadedInstructionFile>::new();
    let mut remaining = MAX_PROJECT_INSTRUCTIONS_BYTES;
    for dir in instruction_directories(working_directory).iter().rev() {
        let Some(file) = load_instruction_file_for_directory(dir, remaining) else {
            continue;
        };
        if !file.truncated && file.content.trim().is_empty() {
            continue;
        }
        let truncated = file.truncated;
        remaining = remaining.saturating_sub(file.content.len());
        files.insert(0, file);
        let inner_len = files
            .iter()
            .map(|f| render_instruction_block(f).len() + 2)
            .sum::<usize>()
            .saturating_sub(2);
        if truncated || inner_len > MAX_PROJECT_INSTRUCTIONS_BYTES {
            break;
        }
    }
    if files.is_empty() {
        return None;
    }
    let rendered =
        render_project_instructions_within_byte_limit(&files, MAX_PROJECT_INSTRUCTIONS_BYTES);
    if rendered.trim().is_empty() {
        None
    } else {
        Some(rendered)
    }
}

fn build_workspace_map(working_directory: &Path) -> Option<String> {
    let Ok(rd) = fs::read_dir(working_directory) else {
        return None;
    };
    let mut entries = Vec::<String>::new();
    for item in rd.flatten() {
        let name = item.file_name().to_string_lossy().into_owned();
        if matches!(name.as_str(), ".git" | "node_modules" | ".cowork") {
            continue;
        }
        let is_dir = item.file_type().is_ok_and(|ft| ft.is_dir());
        entries.push(if is_dir { format!("{name}/") } else { name });
    }
    entries.sort();
    if entries.is_empty() {
        return None;
    }
    let truncated = entries.len() > MAX_WORKSPACE_MAP_ENTRIES;
    let mut lines: Vec<String> = entries
        .into_iter()
        .take(MAX_WORKSPACE_MAP_ENTRIES)
        .collect();
    if truncated {
        lines.push("... (truncated)".to_owned());
    }
    Some(lines.join("\n"))
}

/// Legacy `renderReferencedPluginsSection`.
fn render_referenced_plugins_section(plugins: &[ReferencedPluginContext]) -> String {
    let lines: Vec<String> = plugins
        .iter()
        .filter_map(|plugin| {
            let display_name = Some(plugin.display_name.trim())
                .filter(|d| !d.is_empty())
                .unwrap_or_else(|| plugin.name.trim());
            if display_name.is_empty() {
                return None;
            }
            let skill_names: Vec<&str> = plugin
                .skill_names
                .iter()
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .collect();
            let skill_list = if skill_names.is_empty() {
                String::new()
            } else {
                format!(" (bundled skills: {})", skill_names.join(", "))
            };
            Some(format!("- {display_name}{skill_list}"))
        })
        .collect();
    if lines.is_empty() {
        return String::new();
    }
    format!(
        "## Referenced Plugins\n\nThe user explicitly referenced the following plugin(s) for this request.\nPrefer their bundled skills when relevant. Load a specific skill with the `skill` tool only when you actually need its instructions.\n\n{}",
        lines.join("\n")
    )
}

pub fn build_layered_system_prompt(opts: &SystemPromptBuildOptions) -> String {
    let mut sections = Vec::<String>::new();

    sections.push(
        match load_base_template(opts.prompts_dir.as_deref(), opts.prompt_template.as_deref()) {
            BaseTemplate::File(template) => {
                render_system_template(&template, opts, chrono::Local::now().date_naive())
            }
            BaseTemplate::Inline(text) => text,
        },
    );

    if let Some(proj) = collect_project_instructions(&opts.working_directory) {
        sections.push(format!("## Project Instructions\n\n{proj}"));
    }

    if let Some(ws_map) = build_workspace_map(&opts.working_directory) {
        sections.push(format!(
            "## Workspace Map\nTop-level entries in `{}`:\n```\n{}\n```",
            opts.working_directory.display(),
            ws_map
        ));
    }

    sections.push(
        "## Skill Loading Policy\nWhen a task matches one of the Available Skills, call the `skill` tool with `skillName` to load its full instructions before acting.".to_owned(),
    );

    sections.push(format!(
        "## Shell Execution Policy\nPrefer dedicated `read`, `write`, `edit`, `glob`, and `grep` tools over shell equivalents. Shell commands run non-interactively inside the `{}` OS sandbox (network: {}).",
        opts.sandbox_mode_label,
        if opts.network_enabled { "enabled" } else { "disabled" }
    ));

    if !opts.available_skills.is_empty() {
        let mut skill_lines = Vec::with_capacity(opts.available_skills.len());
        for s in opts.available_skills.values() {
            if s.description.is_empty() {
                skill_lines.push(format!("- `{}`", s.name));
            } else {
                skill_lines.push(format!("- `{}`: {}", s.name, s.description));
            }
        }
        sections.push(format!("## Available Skills\n{}", skill_lines.join("\n")));
    }

    if let Some(mem) = opts.memory_section.as_deref().map(str::trim)
        && !mem.is_empty()
    {
        sections.push(format!("## Memory\n{mem}"));
    }

    if let Some(task_sec) = opts.task_context_section.as_deref().map(str::trim)
        && !task_sec.is_empty()
    {
        sections.push(task_sec.to_owned());
    }

    if let Some(ws_ctx) = &opts.workspace_context
        && !ws_ctx.is_null()
    {
        sections.push(format!(
            "## Active Workspace Context\n```json\n{}\n```",
            serde_json::to_string_pretty(ws_ctx).unwrap_or_default()
        ));
    }

    if let Some(h_ctx) = &opts.harness_context
        && !h_ctx.is_null()
    {
        sections.push(format!(
            "## Active Harness Context\n```json\n{}\n```",
            serde_json::to_string_pretty(h_ctx).unwrap_or_default()
        ));
    }

    let referenced_plugins = render_referenced_plugins_section(&opts.referenced_plugins);
    if !referenced_plugins.is_empty() {
        sections.push(referenced_plugins);
    }

    if opts.template_context.native_tool_search_enabled {
        sections.push(
            "## Native Tool Search\nAdditional workspace and MCP tools are deferred on the wire (`defer_loading: true`) and loaded automatically through the provider's native tool search capability when needed. Once loaded, invoke discovered tools directly by name.".to_owned(),
        );
    } else if opts.deferred_tool_search_enabled {
        sections.push(
            "## Deferred Tool Search\nTools are exposed on demand via `toolSearch` and `toolCall`. Call `toolSearch` with keywords to inspect schemas and activate matching tools for direct invocation, or invoke any discovered tool immediately via `toolCall`.".to_owned(),
        );
    }

    if opts.template_context.native_code_execution_enabled {
        sections.push(
            "## Programmatic Tool Calling\nWhen chaining multiple tool calls, filtering large results, or coordinating multi-step transformations, prefer native programmatic tool calling / code execution to invoke eligible workspace and MCP tools programmatically in a single pass.".to_owned(),
        );
    } else if opts.code_mode_enabled {
        sections.push(
            "## Code Mode\nWhen chaining multiple tool calls, filtering large results, or coordinating multi-step transformations, prefer `codeMode` to run a sandboxed TypeScript program calling `await tools.search(query)` and `await tools.call(name, args)` in a single pass.".to_owned(),
        );
    }

    sections.push(format!(
        "## Cowork Runtime\n- Working directory: `{}`\n- Output directory: `{}`\n- Uploads directory: `{}`\n- Provider / Model: `{}` / `{}`\n- OS: `{}`",
        opts.working_directory.display(),
        opts.output_directory.display(),
        opts.uploads_directory.display(),
        opts.provider.as_str(),
        opts.model,
        std::env::consts::OS,
    ));

    sections.join("\n\n")
}
