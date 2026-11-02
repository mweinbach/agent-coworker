//! Legacy `src/prompt.ts` template rendering for the bundled system prompt templates:
//! `renderTemplateVariables` (the `{{...}}` variables of `loadSystemPromptWithSkills`), the
//! capability / memory / web-search rewrites, and `renderSpawnAgentSpecificPrompt` (the
//! `{{spawnAgent*Section}}` placeholders and legacy spawnAgent blocks).

mod child_models;

use std::path::Path;
use std::sync::OnceLock;

use chrono::{Datelike, NaiveDate};
use cowork_config::{ChildModelRoutingMode, ProviderName};
use regex::{Captures, NoExpand, Regex};
use serde_json::{Map, Value};

use cowork_providers::web_search_options::{
    google_native_web_search_enabled, local_web_search_provider,
};

use crate::agents::profiles::AgentProfilesCatalog;
use crate::system_prompt::SystemPromptBuildOptions;
use child_models::{
    DEFAULT_BEST_FOR, child_agent_model_best_for, list_child_agent_models_with_info,
    registry_supports_image_input, resolve_child_target_display_name,
};

/// Legacy `ResolvedModelMetadata` placeholder for a model absent from the registry.
const UNKNOWN_KNOWLEDGE_CUTOFF: &str = "Unknown";

const NO_SKILLS_EXAMPLE: &str = "- No skills are available in this run. Continue without the `skill` tool instead of guessing a skill name or path.";

/// Legacy `AGENT_ROLE_DEFINITIONS` (`src/server/agents/roles.ts`) as rendered into the prompt:
/// `(id, description, defaultMode, readOnly)`. No built-in role can ask the user, spawn children,
/// or pin a model, so those capability clauses are constant.
const PROMPT_AGENT_ROLES: [(&str, &str, &str, bool); 5] = [
    (
        "default",
        "General child agent for bounded collaborative work.",
        "collaborative",
        false,
    ),
    (
        "explorer",
        "Read-only discovery and synthesis for focused knowledge work.",
        "collaborative",
        true,
    ),
    (
        "research",
        "Web and docs research with sourced summaries.",
        "collaborative",
        true,
    ),
    (
        "worker",
        "Execution-focused knowledge work with bounded ownership.",
        "collaborative",
        false,
    ),
    (
        "reviewer",
        "Read-only validation and review of assigned work.",
        "delegate",
        true,
    ),
];

/// Legacy `resolveDefaultSubagentRoleIds()` over the static role table: the first read-only
/// role preferring explorer, the first write-capable role preferring worker, and a read-only
/// verifier other than the discovery role preferring reviewer.
const DEFAULT_DISCOVERY_ROLE: &str = "explorer";
const DEFAULT_IMPLEMENTATION_ROLE: &str = "worker";
const DEFAULT_VERIFICATION_ROLE: &str = "reviewer";

const SPAWN_AGENT_PROMPT_OVERVIEW: &str = "Launch a collaborative child agent for a well-scoped task. It returns a durable child handle to use with follow-up agent tools; use waitForAgent with includeFinalMessage/includeReport or inspectAgent to read the child agent's full result.";

const SPAWN_AGENT_WHEN_TO_USE: [(&str, &str); 3] = [
    (
        "Parallelization",
        "Independent work that can proceed concurrently.",
    ),
    (
        "Context isolation",
        "Large codebase reads, heavy research, or deep analysis that would bloat the parent context.",
    ),
    (
        "Verification",
        "Focused review, testing, or validation after implementation.",
    ),
];

const SPAWN_AGENT_ORCHESTRATION_RULES: [&str; 7] = [
    "Provide detailed, self-contained prompts with the exact files, ownership, and expected output.",
    "Prefer `contextMode: \"brief\"` with a concise `briefing` for most delegated tasks; use `contextMode: \"full\"` only when the child needs the transcript.",
    "`contextMode: \"none\"` includes no parent conversation, files, history, or assumptions. Use it only when the child message is fully self-contained.",
    "`targetPaths` are an enforced child file-tool scope that withholds `bash` from the child. Only set paths the child may read or modify, and omit `targetPaths` when the child needs `bash`.",
    "Child-agent results are not visible to the user unless you summarize them.",
    "Child agents cannot spawn more child agents. Coordinate all parallel delegation from the root session.",
    "Child agents should stay bounded; do not use them for vague or open-ended delegation.",
];

const SPAWN_AGENT_COORDINATION_RULES: [&str; 7] = [
    "Use multiple child agents in parallel when research tasks are independent.",
    "After launching child agents, report only what was launched; do not predict their results.",
    "After research completes, synthesize the findings yourself into a concrete follow-up prompt.",
    "Continue with the same child when the next task has high context overlap.",
    "Spawn a fresh child when the next task is narrow and the previous child carried broad context.",
    "After non-trivial implementation, run an independent read-only verifier role for validation.",
    "Prefer one write-capable child per file area at a time to avoid edit collisions.",
];

const SPAWN_AGENT_MODEL_OVERRIDE_GUIDANCE: [&str; 4] = [
    "If `model` is omitted, the child inherits the live parent provider/model unless the role has a fixed model policy.",
    "`model` may be a same-provider model id or a full `provider:modelId` child target ref.",
    "`preferredChildModelRef` is only a workspace/UI suggestion; it does not override the spawn request automatically.",
    "If a cross-provider target is disallowed for this workspace or its provider is disconnected, the spawn request is rejected and no child is started; choose an allowed, connected target instead.",
];

const SPAWN_AGENT_MARKDOWN_SECTION_PLACEHOLDER: &str = "{{spawnAgentMarkdownSection}}";
const SPAWN_AGENT_TOOL_SECTION_PLACEHOLDER: &str = "{{spawnAgentToolSection}}";
const SPAWN_AGENT_XML_SECTION_PLACEHOLDER: &str = "{{spawnAgentXmlSection}}";
const SPAWN_AGENT_PROMPT_BODY_PLACEHOLDER: &str = "{{spawnAgentPromptBody}}";

/// Legacy `PROVIDER_DISPLAY_NAMES` in `src/prompt.ts`.
fn provider_prompt_label(provider: ProviderName) -> &'static str {
    match provider {
        ProviderName::Google => "Google",
        ProviderName::Openai => "OpenAI",
        ProviderName::Anthropic => "Anthropic",
        ProviderName::Bedrock => "Amazon Bedrock",
        ProviderName::Baseten => "Baseten",
        ProviderName::Together => "Together AI",
        ProviderName::Fireworks => "Fireworks AI",
        ProviderName::Firepass => "Fire Pass",
        ProviderName::Nvidia => "NVIDIA",
        ProviderName::Lmstudio => "LM Studio",
        ProviderName::Minimax => "MiniMax",
        ProviderName::OpencodeGo => "OpenCode Go",
        ProviderName::OpencodeZen => "OpenCode Zen",
        ProviderName::CodexCli => "Codex CLI",
    }
}

/// Legacy `isUserFacingProviderEnabled` (`USER_FACING_DISABLED_PROVIDERS = ["baseten"]`).
fn is_user_facing_provider(provider: ProviderName) -> bool {
    provider != ProviderName::Baseten
}

/// `new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long",
/// day: "numeric" })`, e.g. `Monday, November 2, 2026`.
pub(crate) fn format_prompt_date(date: NaiveDate) -> String {
    date.format("%A, %B %-d, %Y").to_string()
}

/// The bundled built-in directory (`<builtInDir>/prompts` is the prompts directory).
fn built_in_dir(opts: &SystemPromptBuildOptions) -> Option<&Path> {
    opts.prompts_dir.as_deref().and_then(Path::parent)
}

fn model_display_name(opts: &SystemPromptBuildOptions) -> String {
    opts.template_context
        .model_display_name
        .clone()
        .unwrap_or_else(|| opts.model.clone())
}

/// The `vars` record of legacy `loadSystemPromptWithSkills`, evaluated for `today` (local date).
pub(crate) fn system_template_vars(
    opts: &SystemPromptBuildOptions,
    today: NaiveDate,
) -> Vec<(&'static str, String)> {
    let ctx = &opts.template_context;
    let skills: Vec<_> = opts
        .available_skills
        .values()
        .filter(|skill| skill.enabled)
        .collect();
    let skill_names = skills
        .iter()
        .map(|skill| format!("\"{}\"", skill.name))
        .collect::<Vec<_>>()
        .join(", ");
    let skill_examples = skills
        .iter()
        .map(|skill| {
            let activity = skill
                .description
                .split('.')
                .next()
                .filter(|activity| !activity.is_empty())
                .unwrap_or(&skill.name);
            format!(
                "- {activity} → load the \"{}\" skill before starting",
                skill.name
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let available_subagent_types = PROMPT_AGENT_ROLES
        .iter()
        .map(|(id, description, _, _)| format!("- `{id}`: {description}"))
        .collect::<Vec<_>>()
        .join("\n");

    vec![
        (
            "workingDirectory",
            opts.working_directory.display().to_string(),
        ),
        ("currentDate", format_prompt_date(today)),
        ("currentYear", today.year().to_string()),
        ("modelName", model_display_name(opts)),
        ("userName", ctx.user_name.clone()),
        (
            "userProfileInstructions",
            ctx.user_profile.instructions.clone(),
        ),
        ("userProfileWork", ctx.user_profile.work.clone()),
        ("userProfileDetails", ctx.user_profile.details.clone()),
        ("availableSubagentTypes", available_subagent_types),
        ("defaultDiscoveryRole", DEFAULT_DISCOVERY_ROLE.to_owned()),
        (
            "defaultImplementationRole",
            DEFAULT_IMPLEMENTATION_ROLE.to_owned(),
        ),
        (
            "defaultVerificationRole",
            DEFAULT_VERIFICATION_ROLE.to_owned(),
        ),
        (
            "knowledgeCutoff",
            ctx.knowledge_cutoff
                .clone()
                .unwrap_or_else(|| UNKNOWN_KNOWLEDGE_CUTOFF.to_owned()),
        ),
        (
            "skillNames",
            if skill_names.is_empty() {
                "none".to_owned()
            } else {
                skill_names
            },
        ),
        (
            "skillExamples",
            if skill_examples.is_empty() {
                NO_SKILLS_EXAMPLE.to_owned()
            } else {
                skill_examples
            },
        ),
    ]
}

/// Legacy `renderTemplateVariables`: every line mentioning a variable whose value is blank is
/// dropped (with its newline), then `{{name}}` is replaced in a single pass; unknown names are
/// left untouched.
pub(crate) fn render_template_variables(prompt: &str, vars: &[(&str, String)]) -> String {
    static VAR_RE: OnceLock<Regex> = OnceLock::new();
    let mut out = prompt.to_owned();
    for (key, value) in vars {
        if !value.trim().is_empty() {
            continue;
        }
        let needle = format!("{{{{{key}}}}}");
        if out.contains(&needle) {
            out = out
                .split_inclusive('\n')
                .filter(|line| !line.contains(&needle))
                .collect();
        }
    }
    let re = VAR_RE
        .get_or_init(|| Regex::new(r"\{\{([A-Za-z0-9_]+)\}\}").expect("valid template var regex"));
    re.replace_all(&out, |caps: &Captures<'_>| {
        vars.iter()
            .find(|(key, _)| *key == &caps[1])
            .map_or_else(|| caps[0].to_owned(), |(_, value)| value.clone())
    })
    .into_owned()
}

/// Legacy `formatPromptModelLine`.
fn format_prompt_model_line(
    built_in_dir: Option<&Path>,
    provider: ProviderName,
    model_id: &str,
    current_provider: ProviderName,
    active_model: &str,
    default_model: Option<&str>,
) -> String {
    let full_ref = format!("{}:{model_id}", provider.as_str());
    let known = list_child_agent_models_with_info(built_in_dir, provider)
        .into_iter()
        .find(|candidate| candidate.id == model_id);
    let same_provider = provider == current_provider;
    let attributes: Vec<String> = [
        same_provider.then(|| format!("full ref `{full_ref}`")),
        (model_id == active_model).then(|| "active session model".to_owned()),
        (Some(model_id) == default_model).then(|| "provider default".to_owned()),
    ]
    .into_iter()
    .flatten()
    .collect();
    if let Some(known) = known {
        let model_value = if same_provider { model_id } else { &full_ref };
        let attrs = if attributes.is_empty() {
            String::new()
        } else {
            format!(" [{}]", attributes.join("; "))
        };
        return format!(
            "- **{}** (`{model_value}`){attrs}: {}.",
            known.display_name,
            known.best_for.unwrap_or(DEFAULT_BEST_FOR)
        );
    }
    let bare_value = if same_provider {
        format!("; bare value {}", json_string(model_id))
    } else {
        String::new()
    };
    // Legacy quirk: the unknown-model form drops the first attribute.
    let attrs = if attributes.is_empty() {
        String::new()
    } else {
        format!(" [{}]", attributes[1..].join("; "))
    };
    format!(
        "- Exact model value {}{bare_value}{attrs}.",
        json_string(&full_ref)
    )
}

fn json_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| format!("\"{value}\""))
}

/// Legacy `parseChildModelRef(ref, provider, "child target")`, excluding refs whose provider
/// is unknown to the static registry resolution (they would fail metadata resolution).
fn parse_child_target_ref(raw: &str, provider: ProviderName) -> Option<(ProviderName, String)> {
    cowork_config::parse_child_model_ref(raw, Some(provider))
        .map(|(parsed_provider, model_id, _, _)| (parsed_provider, model_id))
}

/// Legacy `crossProviderRefs`: the allowlisted refs rendered from resolved model metadata, used
/// when no provider catalog could be read.
fn cross_provider_fallback_lines(opts: &SystemPromptBuildOptions) -> Vec<String> {
    let built_in_dir = built_in_dir(opts);
    let paths = auth_paths(opts);
    opts.template_context
        .allowed_child_model_refs
        .iter()
        .filter_map(|raw| parse_child_target_ref(raw, opts.provider))
        .filter_map(|(provider, model_id)| {
            let display_name = resolve_child_target_display_name(
                built_in_dir,
                paths.as_ref(),
                provider,
                &model_id,
            )?;
            let best_for =
                child_agent_model_best_for(provider, &model_id).unwrap_or(DEFAULT_BEST_FOR);
            Some(format!(
                "- **{} / {display_name}** (`{}:{model_id}`): {best_for}.",
                provider_prompt_label(provider),
                provider.as_str()
            ))
        })
        .collect()
}

/// The session's auth home paths (`<home>/.cowork` is `cowork_home`), for the discovery cache
/// and custom-model store reads of legacy `resolveAuthHomeDir(config)`.
fn auth_paths(opts: &SystemPromptBuildOptions) -> Option<cowork_config::AiCoworkerPaths> {
    let home = opts.cowork_home.parent()?;
    let paths = cowork_config::get_ai_coworker_paths(Some(home), &Default::default());
    (paths.root_dir == opts.cowork_home).then_some(paths)
}

/// Legacy `buildAllowedCrossProviderModelLines`.
fn allowed_cross_provider_model_lines(opts: &SystemPromptBuildOptions) -> Vec<String> {
    let ctx = &opts.template_context;
    if ctx.child_model_routing_mode != ChildModelRoutingMode::CrossProviderAllowlist {
        return Vec::new();
    }
    let Some(catalog) = ctx.provider_catalog.as_ref() else {
        return cross_provider_fallback_lines(opts);
    };
    let mut lines = Vec::new();
    for raw in &ctx.allowed_child_model_refs {
        let Some((provider, model_id)) = parse_child_target_ref(raw, opts.provider) else {
            continue;
        };
        if provider == opts.provider || !catalog.available.contains(&provider) {
            continue;
        }
        let entry = catalog
            .all
            .iter()
            .find(|candidate| candidate.id == provider);
        let Some(model) = entry.and_then(|entry| {
            entry
                .models
                .iter()
                .find(|candidate| candidate.id == model_id && candidate.enabled != Some(false))
        }) else {
            continue;
        };
        lines.push(format_prompt_model_line(
            built_in_dir(opts),
            provider,
            &model.id,
            opts.provider,
            &opts.model,
            entry.map(|entry| entry.default_model.as_str()),
        ));
    }
    lines
}

/// Legacy `modelLines` of `buildSpawnAgentPromptBody`: the enabled catalog models of the
/// current provider, else the LM Studio / non-user-facing notes, else the static registry
/// models with their `bestFor` guidance.
fn current_provider_model_lines(opts: &SystemPromptBuildOptions) -> String {
    let built_in_dir = built_in_dir(opts);
    let catalog_entry = opts
        .template_context
        .provider_catalog
        .as_ref()
        .and_then(|catalog| catalog.all.iter().find(|entry| entry.id == opts.provider));
    if let Some(entry) = catalog_entry {
        let lines: Vec<String> = entry
            .models
            .iter()
            .filter(|model| model.enabled != Some(false))
            .map(|model| {
                format_prompt_model_line(
                    built_in_dir,
                    opts.provider,
                    &model.id,
                    opts.provider,
                    &opts.model,
                    Some(&entry.default_model),
                )
            })
            .collect();
        return if lines.is_empty() {
            "- No enabled child model overrides are currently available for this provider."
                .to_owned()
        } else {
            lines.join("\n")
        };
    }
    if opts.provider == ProviderName::Lmstudio {
        return "- Any LM Studio LLM key discovered at runtime is allowed. Use either the bare key or `lmstudio:<modelKey>`.".to_owned();
    }
    if !is_user_facing_provider(opts.provider) {
        return "- No user-facing child model overrides are available for this provider."
            .to_owned();
    }
    list_child_agent_models_with_info(built_in_dir, opts.provider)
        .into_iter()
        .map(|model| {
            format!(
                "- **{}** (`{}`): {}.",
                model.display_name,
                model.id,
                model.best_for.unwrap_or(DEFAULT_BEST_FOR)
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Legacy `buildSpawnAgentPromptBody`.
fn build_spawn_agent_prompt_body(opts: &SystemPromptBuildOptions) -> String {
    let ctx = &opts.template_context;
    let mut lines: Vec<String> = vec![
        SPAWN_AGENT_PROMPT_OVERVIEW.to_owned(),
        String::new(),
        "When to use:".to_owned(),
    ];
    lines.extend(
        SPAWN_AGENT_WHEN_TO_USE
            .iter()
            .map(|(label, description)| format!("- **{label}**: {description}")),
    );
    lines.push(String::new());
    lines.push("Orchestration rules:".to_owned());
    lines.extend(
        SPAWN_AGENT_ORCHESTRATION_RULES
            .iter()
            .map(|rule| format!("- {rule}")),
    );
    lines.push(String::new());
    lines.push("Coordinator rules:".to_owned());
    lines.extend(
        SPAWN_AGENT_COORDINATION_RULES
            .iter()
            .map(|rule| format!("- {rule}")),
    );
    lines.push(String::new());
    lines.push("Model override guidance:".to_owned());
    lines.extend(
        SPAWN_AGENT_MODEL_OVERRIDE_GUIDANCE
            .iter()
            .map(|rule| format!("- {rule}")),
    );
    lines.push(String::new());
    lines.push("Available child-agent roles:".to_owned());
    lines.extend(
        PROMPT_AGENT_ROLES
            .iter()
            .map(|(id, description, mode, read_only)| {
                format!(
                    "- **{id}**: {description} Default mode: {mode}. {} Cannot ask the user directly. Cannot spawn child agents; recursive delegation is disabled.",
                    if *read_only { "Read-only." } else { "Write-capable." }
                )
            }),
    );
    if !ctx.agent_profile_lines.is_empty() {
        lines.push(String::new());
        lines.push("Available specialized subagent profiles:".to_owned());
        lines.push("Use `profileRef` with either the scoped ref or the bare id. If both `profileRef` and `role` are present, `profileRef` wins.".to_owned());
        lines.extend(ctx.agent_profile_lines.iter().cloned());
    }

    lines.push(String::new());
    lines.push(format!(
        "Available model overrides for the current provider ({}):",
        provider_prompt_label(opts.provider)
    ));
    lines.push(current_provider_model_lines(opts));
    let cross_provider_lines = allowed_cross_provider_model_lines(opts);
    if !cross_provider_lines.is_empty() {
        lines.push(String::new());
        lines.push("Available allowed child target refs for this workspace:".to_owned());
        lines.extend(cross_provider_lines);
    }
    lines.push(if is_user_facing_provider(opts.provider) {
        format!(
            "- If you omit `model`, the child stays on **{}** (`{}`).",
            model_display_name(opts),
            opts.model
        )
    } else {
        "- If you omit `model`, the child stays on the session's current provider/model.".to_owned()
    });
    if ctx
        .provider_catalog
        .as_ref()
        .is_some_and(|catalog| catalog.cache_only_snapshot)
    {
        lines.push(String::new());
        lines.push("Model candidates above come from saved settings and cached discovery. Availability is checked when spawning; configuration is not proof of a live connection.".to_owned());
    }
    lines.join("\n")
}

/// Legacy `renderSpawnAgentSpecificPrompt`: the first placeholder kind present is replaced;
/// otherwise a legacy hand-written `<tool name="spawnAgent">`, `<spawnAgent>`, or
/// `### spawnAgent` block (up to `### skill`) is rewritten.
pub(crate) fn render_spawn_agent_sections(prompt: &str, opts: &SystemPromptBuildOptions) -> String {
    static TOOL_BLOCK_RE: OnceLock<Regex> = OnceLock::new();
    static XML_BLOCK_RE: OnceLock<Regex> = OnceLock::new();
    static MARKDOWN_BLOCK_RE: OnceLock<Regex> = OnceLock::new();
    static NEXT_SKILL_RE: OnceLock<Regex> = OnceLock::new();

    let placeholders = [
        SPAWN_AGENT_MARKDOWN_SECTION_PLACEHOLDER,
        SPAWN_AGENT_TOOL_SECTION_PLACEHOLDER,
        SPAWN_AGENT_XML_SECTION_PLACEHOLDER,
        SPAWN_AGENT_PROMPT_BODY_PLACEHOLDER,
    ];
    let has_legacy_block = prompt.contains("<tool name=\"spawnAgent\">")
        || prompt.contains("<spawnAgent>")
        || prompt.contains("### spawnAgent");
    let placeholder = placeholders.into_iter().find(|p| prompt.contains(p));
    if placeholder.is_none() && !has_legacy_block {
        return prompt.to_owned();
    }
    let body = build_spawn_agent_prompt_body(opts);
    let markdown_section = format!("### spawnAgent\n{body}");
    let tool_section = format!("<tool name=\"spawnAgent\">\n{body}\n</tool>");
    let xml_section = format!("<spawnAgent>\n{body}\n</spawnAgent>");

    if let Some(placeholder) = placeholder {
        let replacement = match placeholder {
            SPAWN_AGENT_MARKDOWN_SECTION_PLACEHOLDER => &markdown_section,
            SPAWN_AGENT_TOOL_SECTION_PLACEHOLDER => &tool_section,
            SPAWN_AGENT_XML_SECTION_PLACEHOLDER => &xml_section,
            _ => &body,
        };
        return prompt.replace(placeholder, replacement);
    }
    if prompt.contains("<tool name=\"spawnAgent\">") {
        let re = TOOL_BLOCK_RE.get_or_init(|| {
            Regex::new(r#"(?is)<tool name="spawnAgent">.*?</tool>"#).expect("valid regex")
        });
        return re.replace(prompt, NoExpand(&tool_section)).into_owned();
    }
    if prompt.contains("<spawnAgent>") {
        let re = XML_BLOCK_RE
            .get_or_init(|| Regex::new(r"(?is)<spawnAgent>.*?</spawnAgent>").expect("valid regex"));
        return re.replace(prompt, NoExpand(&xml_section)).into_owned();
    }
    // `/### spawnAgent[\s\S]*?(?=\n### skill\b)/i`: lazily up to the next `### skill` heading;
    // without one the prompt is left unchanged.
    let start_re =
        MARKDOWN_BLOCK_RE.get_or_init(|| Regex::new(r"(?i)### spawnAgent").expect("valid regex"));
    let next_re =
        NEXT_SKILL_RE.get_or_init(|| Regex::new(r"(?i)\n### skill\b").expect("valid regex"));
    for start in start_re.find_iter(prompt) {
        if let Some(end) = next_re.find_at(prompt, start.end()) {
            return format!(
                "{}{markdown_section}{}",
                &prompt[..start.start()],
                &prompt[end.start()..]
            );
        }
    }
    prompt.to_owned()
}

/// Legacy `renderCapabilitySpecificPrompt`: multimodal models keep the `<image_input>`
/// guidance without its delimiters; text-only models drop the spans and collapse the blank
/// lines left behind.
pub(crate) fn render_capability_specific_prompt(
    prompt: &str,
    supports_image_input: bool,
) -> String {
    static SPAN_RE: OnceLock<Regex> = OnceLock::new();
    static DELIMITER_RE: OnceLock<Regex> = OnceLock::new();
    if supports_image_input {
        let re = DELIMITER_RE.get_or_init(|| Regex::new(r"</?image_input>").expect("valid regex"));
        return re.replace_all(prompt, "").into_owned();
    }
    let re = SPAN_RE
        .get_or_init(|| Regex::new(r"(?s)<image_input>.*?</image_input>").expect("valid regex"));
    collapse_blank_lines(&re.replace_all(prompt, ""))
}

/// JS `.replace(/\n{3,}/g, "\n\n")`.
fn collapse_blank_lines(prompt: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\n{3,}").expect("valid regex"))
        .replace_all(prompt, "\n\n")
        .into_owned()
}

/// The session model's image capability: the caller's value, else the bundled registry entry,
/// else the legacy placeholder metadata (`supportsImageInput: false`).
fn supports_image_input(opts: &SystemPromptBuildOptions) -> bool {
    opts.template_context
        .supports_image_input
        .or_else(|| registry_supports_image_input(built_in_dir(opts), opts.provider, &opts.model))
        .unwrap_or(false)
}

const MEMORY_DISABLED_SECTION: &str = "## Memory Disabled\n\nPersistent memory is disabled for this workspace. Do not read or write AGENT.md and do not call the memory tool.";

/// Legacy `renderMemorySpecificPrompt`: with memory disabled or advanced memory on, the legacy
/// `memory` tool guidance and AGENT.md memory lines are stripped; disabled (non-advanced)
/// memory then appends the `## Memory Disabled` notice.
pub(crate) fn render_memory_specific_prompt(prompt: &str, enabled: bool, advanced: bool) -> String {
    static MARKDOWN_START_RE: OnceLock<Regex> = OnceLock::new();
    static MARKDOWN_END_RE: OnceLock<Regex> = OnceLock::new();
    static TOOL_BLOCK_RE: OnceLock<Regex> = OnceLock::new();
    static XML_BLOCK_RE: OnceLock<Regex> = OnceLock::new();
    static MEMORY_LINE_RE: OnceLock<Regex> = OnceLock::new();

    if enabled && !advanced {
        return prompt.to_owned();
    }

    let mut out = prompt.to_owned();
    // `/\n### memory\n[\s\S]*?(?=\n## [^\n]+\n|\n# [^\n]+\n|$)/i` → "\n".
    let start_re =
        MARKDOWN_START_RE.get_or_init(|| Regex::new(r"(?i)\n### memory\n").expect("valid regex"));
    if let Some(start) = start_re.find(&out) {
        let end_re = MARKDOWN_END_RE
            .get_or_init(|| Regex::new(r"\n(?:## |# )[^\n]+\n").expect("valid regex"));
        let end = end_re
            .find_at(&out, start.end())
            .map_or(out.len(), |m| m.start());
        out = format!("{}\n{}", &out[..start.start()], &out[end..]);
    }
    let tool_re = TOOL_BLOCK_RE.get_or_init(|| {
        Regex::new(r#"(?is)\n<tool name="memory">.*?</tool>\n?"#).expect("valid regex")
    });
    out = tool_re.replace(&out, "\n").into_owned();
    let xml_re = XML_BLOCK_RE
        .get_or_init(|| Regex::new(r"(?is)\n<memory>.*?</memory>\n?").expect("valid regex"));
    out = xml_re.replace(&out, "\n").into_owned();

    let line_re = MEMORY_LINE_RE.get_or_init(|| {
        Regex::new(r"(?i)^\s*(?:-\s*Memory:\s*`?|Memory:\s*)\.(?:agent|cowork)/AGENT\.md")
            .expect("valid regex")
    });
    out = out
        .split('\n')
        .filter(|line| !line_re.is_match(line))
        .collect::<Vec<_>>()
        .join("\n");
    out = collapse_blank_lines(&out).trim_end().to_owned();

    if advanced {
        return out;
    }
    format!("{out}\n\n{MEMORY_DISABLED_SECTION}")
}

fn local_web_search_provider_name(options: Option<&Map<String, Value>>) -> &'static str {
    if local_web_search_provider(options) == "parallel" {
        "Parallel"
    } else {
        "Exa"
    }
}

/// Legacy `renderLocalWebToolProviderPrompt`: the Exa credential guidance lines become the
/// configured local provider's, and `Exa-extracted content` names that provider.
pub(crate) fn render_local_web_tool_provider_prompt(
    prompt: &str,
    options: Option<&Map<String, Value>>,
) -> String {
    static EXA_GUIDANCE_RE: OnceLock<Regex> = OnceLock::new();
    let parallel = local_web_search_provider(options) == "parallel";
    let provider_name = if parallel { "Parallel" } else { "Exa" };
    let api_key_env = if parallel {
        "PARALLEL_API_KEY"
    } else {
        "EXA_API_KEY"
    };
    let credential_guidance = format!(
        "- For local webSearch, this workspace uses {provider_name}. If credentials are missing, ask the user to save a {provider_name} API key in Providers > Tool Providers or set `{api_key_env}`."
    );
    let re = EXA_GUIDANCE_RE.get_or_init(|| {
        Regex::new(concat!(
            r"(?m)^(?:- )?(?:",
            r"For the Google provider in this app, webSearch is Exa-backed\. If credentials are missing, ask the user to save an Exa API key in provider settings \(Google -> Exa API key\) or set `EXA_API_KEY`\.",
            r"|",
            r"For the Google provider in this app, webSearch uses Exa\. If webSearch is disabled due missing credentials, ask the user to save an Exa API key in provider settings \(Google -> Exa API key\) or set `EXA_API_KEY`\.",
            r")$"
        ))
        .expect("valid regex")
    });
    re.replace_all(prompt, NoExpand(&credential_guidance))
        .replace(
            "Exa-extracted content",
            &format!("{provider_name}-extracted content"),
        )
}

const CODEX_WEB_SEARCH_SECTION: &str = "## Codex Web Search Backend\n\nCodex app-server owns web search and page fetching for this Codex CLI session.\n\n- Use Codex-native web search/fetch capabilities for current web lookup and page reading.\n- Do not call local Cowork webSearch or webFetch tools; they are reserved for non-Codex providers.";

/// Legacy `renderCodexNativeWebSearchPrompt`.
pub(crate) fn render_codex_native_web_search_prompt(
    prompt: &str,
    provider: ProviderName,
) -> String {
    if provider != ProviderName::CodexCli {
        return prompt.to_owned();
    }
    format!("{prompt}\n\n{CODEX_WEB_SEARCH_SECTION}")
}

/// Legacy `renderGoogleNativeToolsPrompt`.
pub(crate) fn render_google_native_tools_prompt(
    prompt: &str,
    provider: ProviderName,
    options: Option<&Map<String, Value>>,
) -> String {
    if provider != ProviderName::Google {
        return prompt.to_owned();
    }
    if !google_native_web_search_enabled(options) {
        let provider_name = local_web_search_provider_name(options);
        return format!(
            "{prompt}\n\n## Gemini Web Search Fallback\n\nThis Gemini API session is configured to use the local {provider_name}-backed webSearch tool when current web search is needed.\n\n- Use the local webSearch tool for current web lookup instead of Gemini built-in Google Search.\n- Use local webFetch when you need the full contents of a specific page or need to download a direct file.\n- Do not assume provider-native citations or provider-native URL Context are available in this session."
        );
    }
    let sections = [
        "## Gemini Native Web Tools",
        "",
        "This Gemini API session is configured to use provider-native Google Search and URL Context for web access.",
        "",
        "- Use Gemini's built-in web search for current web lookup instead of the local `webSearch` tool.",
        "- Use Gemini's built-in URL Context instead of local `webFetch` for ordinary page reading.",
        "- Prefer provider-native citations and sources when they are available. Do not add a manual \"Sources:\" section just to compensate for native citations.",
        "- Only use local file tools when the task explicitly requires saving content into the workspace.",
    ];
    format!("{prompt}\n\n{}", sections.join("\n"))
}

/// Legacy `formatAgentProfilePromptSummaries`.
pub(crate) fn format_agent_profile_prompt_summaries(catalog: &AgentProfilesCatalog) -> Vec<String> {
    catalog
        .effective_profiles
        .iter()
        .map(|entry| {
            let profile = &entry.profile;
            let profile_ref = format!("{}:{}", entry.scope.as_str(), profile.id);
            let mut details = vec![if profile.description.is_empty() {
                "No description.".to_owned()
            } else {
                profile.description.clone()
            }];
            details.push(format!("Base role: `{}`.", profile.base_role));
            if let Some(model) = profile.model.as_deref().filter(|m| !m.is_empty()) {
                details.push(format!("Default model: `{model}`."));
            }
            if let Some(effort) = profile
                .reasoning_effort
                .as_deref()
                .filter(|e| !e.is_empty())
            {
                details.push(format!("Default reasoning: `{effort}`."));
            }
            format!(
                "- **{}** (`{profile_ref}`, bare ref `{}`): {}",
                profile.display_name,
                profile.id,
                details.join(" ")
            )
        })
        .collect()
}

/// Renders a bundled system template file for `today` in legacy `loadSystemPromptWithSkills`
/// order: variables, image-input spans, memory, local web tool provider, Codex web search,
/// Google native tools, then spawn-agent sections.
pub(crate) fn render_system_template(
    template: &str,
    opts: &SystemPromptBuildOptions,
    today: NaiveDate,
) -> String {
    let ctx = &opts.template_context;
    let options = ctx.provider_options.as_ref();
    let mut prompt = render_template_variables(template, &system_template_vars(opts, today));
    prompt = render_capability_specific_prompt(&prompt, supports_image_input(opts));
    prompt = render_memory_specific_prompt(
        &prompt,
        ctx.enable_memory.unwrap_or(true),
        ctx.advanced_memory,
    );
    prompt = render_local_web_tool_provider_prompt(&prompt, options);
    prompt = render_codex_native_web_search_prompt(&prompt, opts.provider);
    prompt = render_google_native_tools_prompt(&prompt, opts.provider, options);
    render_spawn_agent_sections(&prompt, opts)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::path::{Path, PathBuf};

    use cowork_config::{ProviderName, UserProfile};

    use super::*;
    use crate::system_prompt::{
        PromptProviderCatalog, PromptTemplateContext, build_layered_system_prompt,
    };

    fn bundled_prompts_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../prompts")
    }

    fn configured_context() -> PromptTemplateContext {
        PromptTemplateContext {
            user_name: "Ada Lovelace".to_owned(),
            user_profile: UserProfile {
                instructions: "Always answer in haiku.".to_owned(),
                work: "Analytical engine programmer".to_owned(),
                details: "Prefers metric units.".to_owned(),
            },
            model_display_name: Some("GPT-5.4".to_owned()),
            knowledge_cutoff: Some("August 2025".to_owned()),
            ..PromptTemplateContext::default()
        }
    }

    fn options(
        working_directory: &Path,
        prompt_template: Option<&str>,
        template_context: PromptTemplateContext,
    ) -> SystemPromptBuildOptions {
        SystemPromptBuildOptions {
            prompts_dir: Some(bundled_prompts_dir()),
            prompt_template: prompt_template.map(str::to_owned),
            working_directory: working_directory.to_path_buf(),
            output_directory: working_directory.join("output"),
            uploads_directory: working_directory.join("uploads"),
            cowork_home: working_directory.join(".cowork-home"),
            provider: ProviderName::Openai,
            model: "gpt-5.4".to_owned(),
            sandbox_mode_label: "workspace-write".to_owned(),
            network_enabled: true,
            available_skills: BTreeMap::new(),
            memory_section: None,
            task_context_section: None,
            workspace_context: None,
            harness_context: None,
            referenced_plugins: Vec::new(),
            deferred_tool_search_enabled: false,
            code_mode_enabled: false,
            template_context,
        }
    }

    fn fixed_today() -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 11, 2).unwrap()
    }

    #[test]
    fn prompt_date_matches_en_us_long_locale_format() {
        assert_eq!(
            format_prompt_date(fixed_today()),
            "Monday, November 2, 2026"
        );
        assert_eq!(
            format_prompt_date(NaiveDate::from_ymd_opt(2027, 1, 9).unwrap()),
            "Saturday, January 9, 2027"
        );
    }

    #[test]
    fn renders_every_template_variable_with_configured_values() {
        let ws = tempfile::tempdir().unwrap();
        let opts = options(ws.path(), None, configured_context());
        let template = "\
- Working directory: {{workingDirectory}}
- Current date: {{currentDate}}
- Current year: {{currentYear}}
- Model: {{modelName}}
- User name: {{userName}}
- User profile work/job: {{userProfileWork}}
- User profile instructions: {{userProfileInstructions}}
- User profile details the agent should know: {{userProfileDetails}}
- Knowledge cutoff: {{knowledgeCutoff}}
Roles: {{defaultDiscoveryRole}} / {{defaultImplementationRole}} / {{defaultVerificationRole}}
{{availableSubagentTypes}}
Skills: {{skillNames}}
{{skillExamples}}
Unknown stays: {{notAVariable}}

{{spawnAgentMarkdownSection}}";

        let rendered = render_system_template(template, &opts, fixed_today());

        let expected_head = format!(
            "\
- Working directory: {}
- Current date: Monday, November 2, 2026
- Current year: 2026
- Model: GPT-5.4
- User name: Ada Lovelace
- User profile work/job: Analytical engine programmer
- User profile instructions: Always answer in haiku.
- User profile details the agent should know: Prefers metric units.
- Knowledge cutoff: August 2025
Roles: explorer / worker / reviewer
- `default`: General child agent for bounded collaborative work.
- `explorer`: Read-only discovery and synthesis for focused knowledge work.
- `research`: Web and docs research with sourced summaries.
- `worker`: Execution-focused knowledge work with bounded ownership.
- `reviewer`: Read-only validation and review of assigned work.
Skills: none
- No skills are available in this run. Continue without the `skill` tool instead of guessing a skill name or path.
Unknown stays: {{{{notAVariable}}}}

### spawnAgent
Launch a collaborative child agent",
            ws.path().display()
        );
        assert!(
            rendered.starts_with(&expected_head),
            "unexpected render:\n{rendered}"
        );
        assert!(rendered.contains(
            "- **reviewer**: Read-only validation and review of assigned work. Default mode: delegate. Read-only. Cannot ask the user directly. Cannot spawn child agents; recursive delegation is disabled."
        ));
        assert!(
            rendered
                .ends_with("- If you omit `model`, the child stays on **GPT-5.4** (`gpt-5.4`).")
        );
    }

    #[test]
    fn values_are_inserted_literally_in_a_single_pass() {
        let rendered = render_template_variables(
            "A: {{userName}} B: {{userProfileWork}}",
            &[
                ("userName", "{{userProfileWork}} $1 $&".to_owned()),
                ("userProfileWork", "work".to_owned()),
            ],
        );
        assert_eq!(rendered, "A: {{userProfileWork}} $1 $& B: work");
    }

    #[test]
    fn unset_profile_drops_lines_and_model_metadata_falls_back_like_legacy() {
        let ws = tempfile::tempdir().unwrap();
        let opts = options(ws.path(), None, PromptTemplateContext::default());
        let template = "\
<environment>
- Model: {{modelName}}
- User name: {{userName}}
- User profile work/job: {{userProfileWork}}
- User profile instructions: {{userProfileInstructions}}
- User profile details the agent should know: {{userProfileDetails}}
- Knowledge cutoff: {{knowledgeCutoff}} (search the web)
</environment>
Hello {{userName}}, again";

        assert_eq!(
            render_system_template(template, &opts, fixed_today()),
            "\
<environment>
- Model: gpt-5.4
- Knowledge cutoff: Unknown (search the web)
</environment>
"
        );

        // A blank (but present) knowledge cutoff drops its line too.
        let mut ctx = configured_context();
        ctx.knowledge_cutoff = Some("  ".to_owned());
        ctx.user_profile.details = " \n".to_owned();
        let opts = options(ws.path(), None, ctx);
        assert_eq!(
            render_system_template(template, &opts, fixed_today()),
            "\
<environment>
- Model: GPT-5.4
- User name: Ada Lovelace
- User profile work/job: Analytical engine programmer
- User profile instructions: Always answer in haiku.
</environment>
Hello Ada Lovelace, again"
        );
    }

    fn bundled_system_templates() -> Vec<Option<String>> {
        let mut templates = vec![None];
        let models_dir = bundled_prompts_dir().join("system-models");
        let mut names: Vec<String> = std::fs::read_dir(&models_dir)
            .unwrap()
            .flatten()
            .filter(|entry| entry.file_type().is_ok_and(|ft| ft.is_file()))
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".md"))
            .collect();
        names.sort();
        assert!(names.len() >= 10, "expected bundled model templates");
        templates.extend(
            names
                .into_iter()
                .map(|name| Some(format!("system-models/{name}"))),
        );
        templates
    }

    #[test]
    fn bundled_templates_render_without_placeholders_and_with_profile_values() {
        let ws = tempfile::tempdir().unwrap();
        for template in bundled_system_templates() {
            let raw = std::fs::read_to_string(
                bundled_prompts_dir().join(template.as_deref().unwrap_or("system.md")),
            )
            .unwrap();
            assert!(raw.contains("{{userProfileInstructions}}"), "{template:?}");

            let prompt = build_layered_system_prompt(&options(
                ws.path(),
                template.as_deref(),
                configured_context(),
            ));
            assert!(!prompt.contains("{{"), "{template:?} left a placeholder");
            for value in [
                "User profile instructions: Always answer in haiku.",
                "Analytical engine programmer",
                "Prefers metric units.",
                "Ada Lovelace",
                "August 2025",
                "spawnAgent",
            ] {
                assert!(prompt.contains(value), "{template:?} missing {value:?}");
            }

            let unset = build_layered_system_prompt(&options(
                ws.path(),
                template.as_deref(),
                PromptTemplateContext::default(),
            ));
            assert!(!unset.contains("{{"), "{template:?} left a placeholder");
            assert!(
                !unset.contains("User profile instructions:"),
                "{template:?}"
            );
            assert!(!unset.contains("User name:"), "{template:?}");
        }
    }

    #[test]
    fn inline_role_prompts_are_not_template_rendered() {
        let ws = tempfile::tempdir().unwrap();
        let prompt = build_layered_system_prompt(&options(
            ws.path(),
            Some("You are a reviewer child.\nKeep {{userName}} literal."),
            configured_context(),
        ));
        assert!(prompt.starts_with("You are a reviewer child.\nKeep {{userName}} literal."));
    }

    fn catalog_model(
        id: &str,
        enabled: Option<bool>,
    ) -> cowork_providers::ProviderCatalogModelEntry {
        cowork_providers::ProviderCatalogModelEntry {
            id: id.to_owned(),
            model: None,
            display_name: id.to_owned(),
            description: None,
            knowledge_cutoff: "Unknown".to_owned(),
            supports_image_input: true,
            reasoning: None,
            runtime_options: None,
            runtime_overrides: None,
            enabled,
        }
    }

    fn catalog_entry(
        id: ProviderName,
        default_model: &str,
        models: &[(&str, Option<bool>)],
    ) -> cowork_providers::ProviderCatalogEntry {
        cowork_providers::ProviderCatalogEntry {
            id,
            name: provider_prompt_label(id).to_owned(),
            models: models
                .iter()
                .map(|(model, enabled)| catalog_model(model, *enabled))
                .collect(),
            default_model: default_model.to_owned(),
            state: None,
            message: None,
        }
    }

    #[test]
    fn image_input_spans_follow_model_capability() {
        let template = "Intro.\n\n<image_input>Use `read` on images.</image_input>\n\nTools: read<image_input> (and images)</image_input>.\n";
        assert_eq!(
            render_capability_specific_prompt(template, true),
            "Intro.\n\nUse `read` on images.\n\nTools: read (and images).\n"
        );
        assert_eq!(
            render_capability_specific_prompt(template, false),
            "Intro.\n\nTools: read.\n"
        );

        // `None` resolves from the bundled registry; unknown models are text-only placeholders.
        let ws = tempfile::tempdir().unwrap();
        let mut opts = options(ws.path(), None, configured_context());
        assert!(supports_image_input(&opts));
        opts.model = "not-a-registry-model".to_owned();
        assert!(!supports_image_input(&opts));
        opts.template_context.supports_image_input = Some(true);
        assert!(supports_image_input(&opts));

        for template in bundled_system_templates() {
            for supports in [true, false] {
                let mut ctx = configured_context();
                ctx.supports_image_input = Some(supports);
                let prompt =
                    build_layered_system_prompt(&options(ws.path(), template.as_deref(), ctx));
                assert!(!prompt.contains("image_input>"), "{template:?} {supports}");
                // Only text-only rendering collapses blank-line runs (legacy parity).
                assert!(supports || !prompt.contains("\n\n\n"), "{template:?}");
            }
        }
        let raw = std::fs::read_to_string(bundled_prompts_dir().join("system.md")).unwrap();
        let span = Regex::new(r"(?s)<image_input>(.*?)</image_input>").unwrap();
        let guidance = span.captures(&raw).unwrap()[1].trim().to_owned();
        let render = |supports| {
            let mut ctx = configured_context();
            ctx.supports_image_input = Some(supports);
            build_layered_system_prompt(&options(ws.path(), None, ctx))
        };
        assert!(render(true).contains(&guidance));
        assert!(!render(false).contains(&guidance));
    }

    #[test]
    fn memory_guidance_is_stripped_when_disabled_or_advanced() {
        let template = "\
# Cowork
- Memory: `.agent/AGENT.md` (project)
Memory: .cowork/AGENT.md
- Keep me

### memory
Use the memory tool.
More memory.

## Next Section
Body
<tool name=\"memory\">
Memory tool docs
</tool>
<memory>
xml memory
</memory>
Tail";
        assert_eq!(
            render_memory_specific_prompt(template, true, false),
            template
        );
        let expected_stripped = "\
# Cowork
- Keep me

## Next Section
Body
Tail";
        assert_eq!(
            render_memory_specific_prompt(template, true, true),
            expected_stripped
        );
        assert_eq!(
            render_memory_specific_prompt(template, false, true),
            expected_stripped
        );
        assert_eq!(
            render_memory_specific_prompt(template, false, false),
            format!(
                "{expected_stripped}\n\n## Memory Disabled\n\nPersistent memory is disabled for this workspace. Do not read or write AGENT.md and do not call the memory tool."
            )
        );
        // A trailing `### memory` section runs to the end of the prompt.
        assert_eq!(
            render_memory_specific_prompt("Head\n### Memory\nlast\n", true, true),
            "Head"
        );

        let ws = tempfile::tempdir().unwrap();
        for template in bundled_system_templates() {
            let mut ctx = configured_context();
            ctx.enable_memory = Some(false);
            let prompt = build_layered_system_prompt(&options(ws.path(), template.as_deref(), ctx));
            assert!(!prompt.contains("### memory"), "{template:?}");
            assert!(!prompt.contains("<tool name=\"memory\">"), "{template:?}");
            assert!(!prompt.contains("\n<memory>"), "{template:?}");
            assert!(prompt.contains("## Memory Disabled\n"), "{template:?}");

            let enabled = build_layered_system_prompt(&options(
                ws.path(),
                template.as_deref(),
                configured_context(),
            ));
            assert!(!enabled.contains("## Memory Disabled"), "{template:?}");
        }
    }

    #[test]
    fn local_web_tool_provider_rewrites_exa_guidance() {
        let template = "\
- For the Google provider in this app, webSearch is Exa-backed. If credentials are missing, ask the user to save an Exa API key in provider settings (Google -> Exa API key) or set `EXA_API_KEY`.
For the Google provider in this app, webSearch uses Exa. If webSearch is disabled due missing credentials, ask the user to save an Exa API key in provider settings (Google -> Exa API key) or set `EXA_API_KEY`.
Fetch a URL and return Exa-extracted content.";
        let parallel: Map<String, Value> = serde_json::from_value(serde_json::json!({
            "codex-cli": { "webSearchBackend": "native", "webSearchFallbackBackend": "parallel" }
        }))
        .unwrap();
        let parallel_guidance = "- For local webSearch, this workspace uses Parallel. If credentials are missing, ask the user to save a Parallel API key in Providers > Tool Providers or set `PARALLEL_API_KEY`.";
        assert_eq!(
            render_local_web_tool_provider_prompt(template, Some(&parallel)),
            format!(
                "{parallel_guidance}\n{parallel_guidance}\nFetch a URL and return Parallel-extracted content."
            )
        );
        let exa_guidance = "- For local webSearch, this workspace uses Exa. If credentials are missing, ask the user to save a Exa API key in Providers > Tool Providers or set `EXA_API_KEY`.";
        assert_eq!(
            render_local_web_tool_provider_prompt(template, None),
            format!(
                "{exa_guidance}\n{exa_guidance}\nFetch a URL and return Exa-extracted content."
            )
        );
        // The Codex backend itself wins over the fallback when it is a local provider.
        let exa_backend: Map<String, Value> = serde_json::from_value(serde_json::json!({
            "codex-cli": { "webSearchBackend": "exa", "webSearchFallbackBackend": "parallel" }
        }))
        .unwrap();
        assert_eq!(local_web_search_provider(Some(&exa_backend)), "exa");
    }

    #[test]
    fn codex_and_google_web_search_sections_follow_provider_and_options() {
        assert_eq!(
            render_codex_native_web_search_prompt("P", ProviderName::Openai),
            "P"
        );
        assert_eq!(
            render_codex_native_web_search_prompt("P", ProviderName::CodexCli),
            "P\n\n## Codex Web Search Backend\n\nCodex app-server owns web search and page fetching for this Codex CLI session.\n\n- Use Codex-native web search/fetch capabilities for current web lookup and page reading.\n- Do not call local Cowork webSearch or webFetch tools; they are reserved for non-Codex providers."
        );

        assert_eq!(
            render_google_native_tools_prompt("P", ProviderName::Openai, None),
            "P"
        );
        let native = render_google_native_tools_prompt("P", ProviderName::Google, None);
        assert!(native.starts_with("P\n\n## Gemini Native Web Tools\n\nThis Gemini API session is configured to use provider-native Google Search and URL Context for web access.\n\n- Use Gemini's built-in web search"));
        assert!(native.ends_with("- Only use local file tools when the task explicitly requires saving content into the workspace."));
        let empty = Map::new();
        assert_eq!(
            render_google_native_tools_prompt("P", ProviderName::Google, Some(&empty)),
            native
        );

        let disabled: Map<String, Value> = serde_json::from_value(serde_json::json!({
            "google": { "nativeWebSearch": "off" },
            "codex-cli": { "webSearchFallbackBackend": "parallel" }
        }))
        .unwrap();
        assert_eq!(
            render_google_native_tools_prompt("P", ProviderName::Google, Some(&disabled)),
            "P\n\n## Gemini Web Search Fallback\n\nThis Gemini API session is configured to use the local Parallel-backed webSearch tool when current web search is needed.\n\n- Use the local webSearch tool for current web lookup instead of Gemini built-in Google Search.\n- Use local webFetch when you need the full contents of a specific page or need to download a direct file.\n- Do not assume provider-native citations or provider-native URL Context are available in this session."
        );
        // Without an explicit Google flag, a non-native Codex backend disables native search;
        // an explicit flag wins over it.
        let codex_exa: Map<String, Value> = serde_json::from_value(
            serde_json::json!({ "codex-cli": { "webSearchBackend": "exa" } }),
        )
        .unwrap();
        assert!(!google_native_web_search_enabled(Some(&codex_exa)));
        let explicit_on: Map<String, Value> = serde_json::from_value(serde_json::json!({
            "google": { "nativeWebSearch": true },
            "codex-cli": { "webSearchBackend": "exa" }
        }))
        .unwrap();
        assert!(google_native_web_search_enabled(Some(&explicit_on)));

        // The bundled Gemini template gets the rewrites end to end.
        let ws = tempfile::tempdir().unwrap();
        let mut opts = options(
            ws.path(),
            Some("system-models/gemini-3.1-pro-preview.md"),
            PromptTemplateContext {
                provider_options: Some(disabled),
                ..configured_context()
            },
        );
        opts.provider = ProviderName::Google;
        opts.model = "gemini-3.1-pro-preview".to_owned();
        let prompt = build_layered_system_prompt(&opts);
        assert!(prompt.contains("- For local webSearch, this workspace uses Parallel."));
        assert!(prompt.contains("Parallel-extracted content"));
        assert!(!prompt.contains("Exa-backed"));
        assert!(prompt.contains("## Gemini Web Search Fallback"));
    }

    #[test]
    fn spawn_agent_lists_registry_models_without_a_catalog() {
        let ws = tempfile::tempdir().unwrap();
        let opts = options(ws.path(), None, configured_context());
        let body = build_spawn_agent_prompt_body(&opts);
        let expected = "\
Available model overrides for the current provider (OpenAI):
- **GPT-5 Mini** (`gpt-5-mini`): fast lower-cost general work, smaller coding tasks, and lightweight verification passes.
- **GPT-5.2** (`gpt-5.2`): strong general-purpose coding and reasoning with a balanced quality-latency tradeoff.
- **GPT-5.2 Pro** (`gpt-5.2-pro`): highest-accuracy deep analysis and difficult tasks where latency matters less.
- **GPT-5.4** (`gpt-5.4`): frontier coding, agentic workflows, and the hardest reasoning-heavy tasks.
- **GPT-5.4 Mini** (`gpt-5.4-mini`): frontier coding, agentic workflows, and the hardest reasoning-heavy tasks.
- **GPT-5.4 Nano** (`gpt-5.4-nano`): fast lower-cost general work, smaller coding tasks, and lightweight verification passes.
- **GPT-5.4 Pro** (`gpt-5.4-pro`): highest-accuracy deep analysis and difficult tasks where latency matters less.
- **GPT-5.5** (`gpt-5.5`): frontier coding, agentic workflows, and the hardest reasoning-heavy tasks.
- If you omit `model`, the child stays on **GPT-5.4** (`gpt-5.4`).";
        assert!(body.ends_with(expected), "unexpected body:\n{body}");
        assert!(!body.contains("specialized subagent profiles"));

        let mut lm = options(ws.path(), None, configured_context());
        lm.provider = ProviderName::Lmstudio;
        assert!(build_spawn_agent_prompt_body(&lm).contains(
            "Available model overrides for the current provider (LM Studio):\n- Any LM Studio LLM key discovered at runtime is allowed."
        ));
    }

    #[test]
    fn spawn_agent_lists_catalog_models_profiles_and_allowlisted_refs() {
        let ws = tempfile::tempdir().unwrap();
        let mut ctx = configured_context();
        ctx.child_model_routing_mode = ChildModelRoutingMode::CrossProviderAllowlist;
        ctx.allowed_child_model_refs = vec![
            "anthropic:claude-opus-4-8".to_owned(),
            "google:gemini-3.5-flash".to_owned(),
            "anthropic:claude-disabled".to_owned(),
            "gpt-5.2".to_owned(),
        ];
        ctx.agent_profile_lines = vec![
            "- **Docs** (`workspace:docs`, bare ref `docs`): Writes docs. Base role: `worker`."
                .to_owned(),
        ];
        ctx.provider_catalog = Some(PromptProviderCatalog {
            all: vec![
                catalog_entry(
                    ProviderName::Openai,
                    "gpt-5.5",
                    &[
                        ("gpt-5.4", None),
                        ("gpt-5.5", Some(true)),
                        ("gpt-5.2", Some(false)),
                        ("ft:custom", None),
                    ],
                ),
                catalog_entry(
                    ProviderName::Anthropic,
                    "claude-opus-4-8",
                    &[("claude-opus-4-8", None), ("claude-disabled", Some(false))],
                ),
                catalog_entry(
                    ProviderName::Google,
                    "gemini-3.5-flash",
                    &[("gemini-3.5-flash", None)],
                ),
            ],
            available: vec![ProviderName::Openai, ProviderName::Anthropic],
            cache_only_snapshot: true,
        });
        let body = build_spawn_agent_prompt_body(&options(ws.path(), None, ctx.clone()));
        let expected = "\
Available specialized subagent profiles:
Use `profileRef` with either the scoped ref or the bare id. If both `profileRef` and `role` are present, `profileRef` wins.
- **Docs** (`workspace:docs`, bare ref `docs`): Writes docs. Base role: `worker`.

Available model overrides for the current provider (OpenAI):
- **GPT-5.4** (`gpt-5.4`) [full ref `openai:gpt-5.4`; active session model]: frontier coding, agentic workflows, and the hardest reasoning-heavy tasks.
- **GPT-5.5** (`gpt-5.5`) [full ref `openai:gpt-5.5`; provider default]: frontier coding, agentic workflows, and the hardest reasoning-heavy tasks.
- Exact model value \"openai:ft:custom\"; bare value \"ft:custom\" [].

Available allowed child target refs for this workspace:
- **Claude Opus 4.8** (`anthropic:claude-opus-4-8`) [provider default]: top-tier long-running coding, deep analysis, and high-stakes agent work.
- If you omit `model`, the child stays on **GPT-5.4** (`gpt-5.4`).

Model candidates above come from saved settings and cached discovery. Availability is checked when spawning; configuration is not proof of a live connection.";
        assert!(body.ends_with(expected), "unexpected body:\n{body}");

        // Without a catalog the allowlisted refs render from registry metadata.
        ctx.provider_catalog = None;
        let body = build_spawn_agent_prompt_body(&options(ws.path(), None, ctx.clone()));
        assert!(body.contains("\n\nAvailable allowed child target refs for this workspace:\n- **Anthropic / Claude Opus 4.8** (`anthropic:claude-opus-4-8`): top-tier long-running coding, deep analysis, and high-stakes agent work.\n- **Google / Gemini 3.5 Flash** (`google:gemini-3.5-flash`): lower-latency multimodal tasks, quick synthesis, and lighter coding or retrieval work.\n- **Anthropic / claude-disabled** (`anthropic:claude-disabled`): general-purpose work on this provider.\n- **OpenAI / GPT-5.2** (`openai:gpt-5.2`): strong general-purpose coding"), "unexpected body:\n{body}");
        assert!(!body.contains("Model candidates above"));

        // Same-provider routing never lists allowlisted refs.
        ctx.child_model_routing_mode = ChildModelRoutingMode::SameProvider;
        let body = build_spawn_agent_prompt_body(&options(ws.path(), None, ctx));
        assert!(!body.contains("Available allowed child target refs"));
    }

    #[test]
    fn legacy_spawn_agent_blocks_are_rewritten() {
        let ws = tempfile::tempdir().unwrap();
        let opts = options(ws.path(), None, configured_context());
        let body = build_spawn_agent_prompt_body(&opts);

        assert_eq!(
            render_spawn_agent_sections("A\n<tool name=\"spawnAgent\">\nold\n</tool>\nB", &opts),
            format!("A\n<tool name=\"spawnAgent\">\n{body}\n</tool>\nB")
        );
        assert_eq!(
            render_spawn_agent_sections("A\n<spawnAgent>old</spawnAgent>\nB", &opts),
            format!("A\n<spawnAgent>\n{body}\n</spawnAgent>\nB")
        );
        assert_eq!(
            render_spawn_agent_sections("A\n### spawnAgent\nold\n### skill\nB", &opts),
            format!("A\n### spawnAgent\n{body}\n### skill\nB")
        );
        // Without a following `### skill` heading the markdown block is left alone.
        assert_eq!(
            render_spawn_agent_sections("A\n### spawnAgent\nold", &opts),
            "A\n### spawnAgent\nold"
        );
        // Placeholders win over legacy blocks.
        assert_eq!(
            render_spawn_agent_sections(
                "{{spawnAgentPromptBody}}\n<spawnAgent>x</spawnAgent>",
                &opts
            ),
            format!("{body}\n<spawnAgent>x</spawnAgent>")
        );
    }

    #[test]
    fn agent_profile_summaries_match_legacy_format() {
        let home = tempfile::tempdir().unwrap();
        let ws = tempfile::tempdir().unwrap();
        let profiles_dir = ws.path().join(".cowork/agent-profiles");
        std::fs::create_dir_all(&profiles_dir).unwrap();
        std::fs::write(
            profiles_dir.join("docs.json"),
            serde_json::json!({
                "version": 1,
                "id": "docs",
                "displayName": "Docs Writer",
                "description": "",
                "enabled": true,
                "baseRole": "worker",
                "prompt": "Write docs.",
                "model": "openai:gpt-5.4",
                "reasoningEffort": "high"
            })
            .to_string(),
        )
        .unwrap();
        let catalog =
            crate::agents::profiles::AgentProfilesStore::new(home.path(), ws.path()).read_catalog();
        let lines = format_agent_profile_prompt_summaries(&catalog);
        assert!(
            lines.contains(&"- **Docs Writer** (`workspace:docs`, bare ref `docs`): No description. Base role: `worker`. Default model: `openai:gpt-5.4`. Default reasoning: `high`.".to_owned()),
            "{lines:#?}"
        );
        assert!(
            lines.iter().any(|line| line
                .starts_with("- **Explorer** (`global:explorer`, bare ref `explorer`): ")
                && line.ends_with(" Base role: `explorer`.")),
            "{lines:#?}"
        );
    }

    fn cached_models(models: &[(&str, &str, bool)]) -> cowork_config::ModelDiscoveryResult {
        cowork_config::ModelDiscoveryResult {
            provider: ProviderName::Openai,
            source: cowork_config::ModelDiscoverySource::Api,
            models: models
                .iter()
                .map(|(id, display_name, is_default)| {
                    serde_json::from_value(serde_json::json!({
                        "id": id, "displayName": display_name, "isDefault": is_default,
                    }))
                    .unwrap()
                })
                .collect(),
            updated_at: None,
            expires_at: None,
            message: None,
        }
    }

    async fn seed_discovery_caches(paths: &cowork_config::AiCoworkerPaths) {
        for (provider, models) in [
            (
                ProviderName::Openai,
                cached_models(&[
                    ("gpt-5.4", "GPT-5.4", true),
                    ("ft:team-model", "Team Model", false),
                ]),
            ),
            (
                ProviderName::Anthropic,
                cached_models(&[
                    ("claude-opus-4-8", "Claude Opus 4.8", true),
                    ("claude-team-x", "Claude Team X", false),
                ]),
            ),
        ] {
            let mut models = models;
            models.provider = provider;
            cowork_config::write_model_discovery_cache(paths, provider, models, None, None)
                .await
                .unwrap();
        }
    }

    #[tokio::test]
    async fn spawn_agent_renders_the_cache_only_catalog_snapshot() {
        let home = tempfile::tempdir().unwrap();
        let ws = tempfile::tempdir().unwrap();
        let mut env = std::collections::HashMap::new();
        env.insert("ANTHROPIC_API_KEY".to_owned(), "sk-ant".to_owned());
        let paths = cowork_config::get_ai_coworker_paths(Some(home.path()), &env);
        seed_discovery_caches(&paths).await;
        // Discovered non-registry models start disabled (legacy preference defaults) until the
        // user enables them.
        for (provider, id) in [
            (ProviderName::Openai, "ft:team-model"),
            (ProviderName::Anthropic, "claude-team-x"),
        ] {
            cowork_config::set_model_preferences(
                &paths,
                provider,
                &[cowork_config::ModelPreferenceUpdate {
                    id: id.to_owned(),
                    enabled: true,
                }],
            )
            .await
            .unwrap();
        }

        let snapshot = cowork_providers::read_provider_catalog_snapshot(
            &cowork_providers::CatalogBuildOptions {
                built_in_dir: bundled_prompts_dir().parent().unwrap().to_path_buf(),
                homedir: home.path().to_path_buf(),
                env,
                provider_options: None,
                refresh: false,
                discovery_timeout_ms: None,
                base_url_overrides: Default::default(),
            },
        )
        .await;
        let mut ctx = configured_context();
        ctx.child_model_routing_mode = ChildModelRoutingMode::CrossProviderAllowlist;
        ctx.allowed_child_model_refs = vec![
            "anthropic:claude-team-x".to_owned(),
            "google:gemini-3.5-flash".to_owned(),
        ];
        ctx.provider_catalog = Some(PromptProviderCatalog::from_snapshot(snapshot));
        let mut opts = options(ws.path(), None, ctx);
        opts.cowork_home = paths.root_dir.clone();

        let body = build_spawn_agent_prompt_body(&opts);
        let expected = "\
Available model overrides for the current provider (OpenAI):
- **GPT-5.4** (`gpt-5.4`) [full ref `openai:gpt-5.4`; active session model; provider default]: frontier coding, agentic workflows, and the hardest reasoning-heavy tasks.
- Exact model value \"openai:ft:team-model\"; bare value \"ft:team-model\" [].

Available allowed child target refs for this workspace:
- Exact model value \"anthropic:claude-team-x\".
- If you omit `model`, the child stays on **GPT-5.4** (`gpt-5.4`).

Model candidates above come from saved settings and cached discovery. Availability is checked when spawning; configuration is not proof of a live connection.";
        assert!(body.ends_with(expected), "unexpected body:\n{body}");
    }

    #[tokio::test]
    async fn cross_provider_fallback_names_use_discovery_cache_and_custom_models() {
        let home = tempfile::tempdir().unwrap();
        let ws = tempfile::tempdir().unwrap();
        let paths = cowork_config::get_ai_coworker_paths(Some(home.path()), &Default::default());
        seed_discovery_caches(&paths).await;

        let mut ctx = configured_context();
        ctx.child_model_routing_mode = ChildModelRoutingMode::CrossProviderAllowlist;
        ctx.allowed_child_model_refs = vec![
            "anthropic:claude-team-x".to_owned(),
            // Provably OpenAI's: dropped unless configured as a Together custom model.
            "together:gpt-5.4".to_owned(),
            "lmstudio:qwen/qwen3-8b".to_owned(),
        ];
        let mut opts = options(ws.path(), None, ctx);
        opts.cowork_home = paths.root_dir.clone();

        let body = build_spawn_agent_prompt_body(&opts);
        assert!(
            body.contains("\n\nAvailable allowed child target refs for this workspace:\n- **Anthropic / Claude Team X** (`anthropic:claude-team-x`): general-purpose work on this provider.\n- **LM Studio / qwen/qwen3-8b** (`lmstudio:qwen/qwen3-8b`): general-purpose work on this provider.\n- If you omit"),
            "unexpected body:\n{body}"
        );

        cowork_config::upsert_custom_model(&paths, ProviderName::Together, "gpt-5.4")
            .await
            .unwrap();
        let body = build_spawn_agent_prompt_body(&opts);
        assert!(
            body.contains("- **Together AI / gpt-5.4** (`together:gpt-5.4`): general-purpose work on this provider.\n"),
            "unexpected body:\n{body}"
        );
    }
}
