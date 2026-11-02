//! Legacy `src/prompt.ts` template rendering for the bundled system prompt templates:
//! `renderTemplateVariables` (the `{{...}}` variables of `loadSystemPromptWithSkills`) and
//! `renderSpawnAgentSpecificPrompt` (the `{{spawnAgent*Section}}` placeholders).

use std::sync::OnceLock;

use chrono::{Datelike, NaiveDate};
use cowork_config::ProviderName;
use regex::{Captures, Regex};

use crate::system_prompt::SystemPromptBuildOptions;

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

/// Legacy `buildSpawnAgentPromptBody`. The per-provider model-override list (provider catalog
/// snapshot / child-model `bestFor` table), allowlisted cross-provider refs, and agent-profile
/// lines are not available to the builder, so only their static fallbacks are rendered.
fn build_spawn_agent_prompt_body(opts: &SystemPromptBuildOptions) -> String {
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

    let user_facing = is_user_facing_provider(opts.provider);
    let model_lines = if opts.provider == ProviderName::Lmstudio {
        Some(
            "- Any LM Studio LLM key discovered at runtime is allowed. Use either the bare key or `lmstudio:<modelKey>`.",
        )
    } else if !user_facing {
        Some("- No user-facing child model overrides are available for this provider.")
    } else {
        None
    };
    lines.push(String::new());
    if let Some(model_lines) = model_lines {
        lines.push(format!(
            "Available model overrides for the current provider ({}):",
            provider_prompt_label(opts.provider)
        ));
        lines.push(model_lines.to_owned());
    }
    lines.push(if user_facing {
        format!(
            "- If you omit `model`, the child stays on **{}** (`{}`).",
            model_display_name(opts),
            opts.model
        )
    } else {
        "- If you omit `model`, the child stays on the session's current provider/model.".to_owned()
    });
    lines.join("\n")
}

/// Legacy `renderSpawnAgentSpecificPrompt` for the placeholder forms used by the bundled
/// templates: only the first placeholder kind present is replaced.
pub(crate) fn render_spawn_agent_sections(prompt: &str, opts: &SystemPromptBuildOptions) -> String {
    let placeholders = [
        SPAWN_AGENT_MARKDOWN_SECTION_PLACEHOLDER,
        SPAWN_AGENT_TOOL_SECTION_PLACEHOLDER,
        SPAWN_AGENT_XML_SECTION_PLACEHOLDER,
        SPAWN_AGENT_PROMPT_BODY_PLACEHOLDER,
    ];
    let Some(placeholder) = placeholders.into_iter().find(|p| prompt.contains(p)) else {
        return prompt.to_owned();
    };
    let body = build_spawn_agent_prompt_body(opts);
    let replacement = match placeholder {
        SPAWN_AGENT_MARKDOWN_SECTION_PLACEHOLDER => format!("### spawnAgent\n{body}"),
        SPAWN_AGENT_TOOL_SECTION_PLACEHOLDER => {
            format!("<tool name=\"spawnAgent\">\n{body}\n</tool>")
        }
        SPAWN_AGENT_XML_SECTION_PLACEHOLDER => format!("<spawnAgent>\n{body}\n</spawnAgent>"),
        _ => body,
    };
    prompt.replace(placeholder, &replacement)
}

/// Renders a bundled system template file for `today`: variables first, then spawn-agent
/// sections (legacy `loadSystemPromptWithSkills` ordering).
pub(crate) fn render_system_template(
    template: &str,
    opts: &SystemPromptBuildOptions,
    today: NaiveDate,
) -> String {
    let rendered = render_template_variables(template, &system_template_vars(opts, today));
    render_spawn_agent_sections(&rendered, opts)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::path::{Path, PathBuf};

    use cowork_config::{ProviderName, UserProfile};

    use super::*;
    use crate::system_prompt::{PromptTemplateContext, build_layered_system_prompt};

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
}
