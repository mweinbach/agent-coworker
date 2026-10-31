use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use cowork_config::ProviderName;
use cowork_tools::{DiscoveredSkill, render_skill_body_for_model};
use regex::Regex;
use serde_json::Value;

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
    pub workspace_context: Option<Value>,
    pub harness_context: Option<Value>,
    pub referenced_plugins: Vec<(String, String)>,
    pub deferred_tool_search_enabled: bool,
}

#[derive(Debug, Clone, Default)]
pub struct ResolvedTurnMentions {
    pub injected_skill_blocks: Vec<String>,
    pub referenced_plugins: Vec<(String, String)>,
}

/// Resolves `@skill-name` (user-turn skill injection) and `@plugin-name` (system prompt section)
/// mentions in a user prompt.
pub fn resolve_turn_mentions(
    user_text: &str,
    skills: &BTreeMap<String, DiscoveredSkill>,
    cowork_home: &Path,
    working_directory: &Path,
) -> ResolvedTurnMentions {
    static MENTION_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let re = MENTION_RE.get_or_init(|| {
        Regex::new(r"(?:^|[\s(])@([A-Za-z0-9_.:-]+)").expect("valid mention regex")
    });

    let mut out = ResolvedTurnMentions::default();
    let mut seen_skills = std::collections::BTreeSet::new();
    let mut seen_plugins = std::collections::BTreeSet::new();

    for caps in re.captures_iter(user_text) {
        let Some(token) = caps.get(1).map(|m| m.as_str()) else {
            continue;
        };
        if let Some(skill) = skills.get(token)
            && seen_skills.insert(token.to_owned())
            && let Ok(rendered) = render_skill_body_for_model(skill)
        {
            out.injected_skill_blocks.push(format!(
                "<skill_context name={:?}>\n{}\n</skill_context>",
                skill.name, rendered
            ));
            continue;
        }

        if seen_plugins.contains(token) {
            continue;
        }
        for plugin_root in [
            working_directory.join(".cowork").join("plugins"),
            cowork_home.join("plugins"),
        ] {
            let candidate_dir = plugin_root.join(token);
            for doc_name in ["PLUGIN.md", "README.md"] {
                let doc_path = candidate_dir.join(doc_name);
                if let Ok(doc) = fs::read_to_string(&doc_path) {
                    let trimmed = doc.trim();
                    if !trimmed.is_empty() {
                        seen_plugins.insert(token.to_owned());
                        out.referenced_plugins
                            .push((token.to_owned(), trimmed.to_owned()));
                        break;
                    }
                }
            }
            if seen_plugins.contains(token) {
                break;
            }
        }
    }

    out
}

fn load_base_template(prompts_dir: Option<&Path>, template_name: Option<&str>) -> String {
    if let Some(dir) = prompts_dir {
        if let Some(name) = template_name {
            let clean = name.trim_matches(['/', '\\']);
            let file_name = if clean.ends_with(".md") {
                clean.to_owned()
            } else {
                format!("{clean}.md")
            };
            if let Ok(content) = fs::read_to_string(dir.join(file_name))
                && !content.trim().is_empty()
            {
                return content.trim().to_owned();
            }
        }
        if let Ok(sys) = fs::read_to_string(dir.join("system.md"))
            && !sys.trim().is_empty()
        {
            return sys.trim().to_owned();
        }
    }
    DEFAULT_BASE_SYSTEM_PROMPT.to_owned()
}

/// Walks ancestors from git/filesystem boundary down to `working_directory`, collecting
/// `AGENTS.override.md`, `AGENTS.md`, and `CLAUDE.md` up to `MAX_PROJECT_INSTRUCTIONS_BYTES` (32 KiB).
pub fn collect_project_instructions(working_directory: &Path) -> Option<String> {
    let mut chain = Vec::<PathBuf>::new();
    let mut cursor = Some(working_directory);
    while let Some(dir) = cursor {
        chain.push(dir.to_path_buf());
        if dir.join(".git").exists() {
            break;
        }
        cursor = dir.parent();
    }
    chain.reverse();

    let mut remaining = MAX_PROJECT_INSTRUCTIONS_BYTES;
    let mut chunks = Vec::<String>::new();

    for dir in chain {
        for filename in ["AGENTS.override.md", "AGENTS.md", "CLAUDE.md"] {
            if remaining == 0 {
                break;
            }
            let file_path = dir.join(filename);
            let Ok(raw) = fs::read_to_string(&file_path) else {
                continue;
            };
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                continue;
            }
            let slice = if trimmed.len() > remaining {
                let mut end = remaining;
                while !trimmed.is_char_boundary(end) {
                    end -= 1;
                }
                &trimmed[..end]
            } else {
                trimmed
            };
            remaining = remaining.saturating_sub(slice.len());
            chunks.push(format!("### {}\n{}", file_path.display(), slice));
        }
    }

    if chunks.is_empty() {
        None
    } else {
        Some(chunks.join("\n\n"))
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

pub fn build_layered_system_prompt(opts: &SystemPromptBuildOptions) -> String {
    let mut sections = Vec::<String>::new();

    sections.push(load_base_template(
        opts.prompts_dir.as_deref(),
        opts.prompt_template.as_deref(),
    ));

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

    if !opts.referenced_plugins.is_empty() {
        let rendered: Vec<String> = opts
            .referenced_plugins
            .iter()
            .map(|(name, body)| format!("### Plugin: {name}\n{body}"))
            .collect();
        sections.push(format!(
            "## Referenced Plugins\n\n{}",
            rendered.join("\n\n")
        ));
    }

    if opts.deferred_tool_search_enabled {
        sections.push(
            "## Deferred Tool Search\nTools are exposed on demand via `toolSearch` and `toolCall`. Call `toolSearch` with keywords to inspect schemas and activate matching tools for direct invocation, or invoke any discovered tool immediately via `toolCall`.".to_owned(),
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
