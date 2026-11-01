use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
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
    pub task_context_section: Option<String>,
    pub workspace_context: Option<Value>,
    pub harness_context: Option<Value>,
    pub referenced_plugins: Vec<(String, String)>,
    pub deferred_tool_search_enabled: bool,
    pub code_mode_enabled: bool,
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
            if let Ok(content) = fs::read_to_string(dir.join(file_name))
                && !content.trim().is_empty()
            {
                return content.trim().to_owned();
            }
        }
        if name.contains('\n') || name.contains(' ') {
            let trimmed = name.trim();
            if !trimmed.is_empty() {
                return trimmed.to_owned();
            }
        }
    }
    if let Some(dir) = prompts_dir
        && let Ok(sys) = fs::read_to_string(dir.join("system.md"))
        && !sys.trim().is_empty()
    {
        return sys.trim().to_owned();
    }
    DEFAULT_BASE_SYSTEM_PROMPT.to_owned()
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

    if opts.code_mode_enabled {
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
