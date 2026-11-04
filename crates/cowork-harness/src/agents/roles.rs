use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

#[derive(Debug, Clone)]
pub struct BuiltinAgentRoleSpec {
    pub name: &'static str,
    pub display_name: &'static str,
    pub description: &'static str,
    pub mode: &'static str,
    pub read_only: bool,
    pub allowed_builtin_tools: &'static [&'static str],
}

const DEFAULT_WORKER_TOOLS: &[&str] = &[
    "bash",
    "read",
    "write",
    "edit",
    "glob",
    "grep",
    "webSearch",
    "webFetch",
    "todoWrite",
    "skill",
    "memory",
    "recallMemory",
    "readPastConversation",
    "manageMemory",
];

const EXPLORER_REVIEWER_TOOLS: &[&str] = &["bash", "read", "glob", "grep"];
const RESEARCH_TOOLS: &[&str] = &["read", "webSearch", "webFetch"];

pub const BUILTIN_AGENT_ROLES: &[BuiltinAgentRoleSpec] = &[
    BuiltinAgentRoleSpec {
        name: "default",
        display_name: "Default",
        description: "General-purpose collaborative sub-agent.",
        mode: "collaborative",
        read_only: false,
        allowed_builtin_tools: DEFAULT_WORKER_TOOLS,
    },
    BuiltinAgentRoleSpec {
        name: "explorer",
        display_name: "Explorer",
        description: "Fast read-only codebase explorer.",
        mode: "collaborative",
        read_only: true,
        allowed_builtin_tools: EXPLORER_REVIEWER_TOOLS,
    },
    BuiltinAgentRoleSpec {
        name: "research",
        display_name: "Research",
        description: "Read-only web and documentation researcher.",
        mode: "collaborative",
        read_only: true,
        allowed_builtin_tools: RESEARCH_TOOLS,
    },
    BuiltinAgentRoleSpec {
        name: "worker",
        display_name: "Worker",
        description: "Focused implementation and verification worker.",
        mode: "collaborative",
        read_only: false,
        allowed_builtin_tools: DEFAULT_WORKER_TOOLS,
    },
    BuiltinAgentRoleSpec {
        name: "reviewer",
        display_name: "Reviewer",
        description: "Read-only code and contract reviewer.",
        mode: "delegate",
        read_only: true,
        allowed_builtin_tools: EXPLORER_REVIEWER_TOOLS,
    },
];

pub fn lookup_builtin_role(name: &str) -> Result<&'static BuiltinAgentRoleSpec, String> {
    let trimmed = name.trim();
    BUILTIN_AGENT_ROLES
        .iter()
        .find(|r| r.name == trimmed)
        .ok_or_else(|| {
            format!(
                "Unknown agent role '{trimmed}'. Expected one of: default, explorer, research, worker, reviewer."
            )
        })
}

/// Enforces the `baseRole` tool ceiling FIRST, then intersects with any profile `allowedBuiltInTools`.
pub fn compute_effective_builtin_tools(
    role: &BuiltinAgentRoleSpec,
    profile_allowed: Option<&[String]>,
) -> BTreeSet<String> {
    let role_set: BTreeSet<String> = role
        .allowed_builtin_tools
        .iter()
        .map(|s| (*s).to_owned())
        .collect();
    match profile_allowed {
        None => role_set,
        Some(list) => list
            .iter()
            .filter(|id| role_set.contains(id.as_str()))
            .cloned()
            .collect(),
    }
}

pub fn load_role_prompt(
    built_in_dir: &Path,
    role_name: &str,
    custom_prompt: Option<&str>,
) -> String {
    let sub_dir = built_in_dir.join("prompts/sub-agents");
    let base_prompt = fs::read_to_string(sub_dir.join("base.md")).unwrap_or_else(|_| {
        "You are a focused child sub-agent working on behalf of a parent session.\n\
         Stay within your assigned scope and end your final response with a valid `<agent_report>` JSON block."
            .to_owned()
    });
    let role_body = if let Some(p) = custom_prompt.filter(|s| !s.trim().is_empty()) {
        p.trim().to_owned()
    } else {
        fs::read_to_string(sub_dir.join(format!("{role_name}.md"))).unwrap_or_else(|_| {
            format!("Assigned sub-agent role: {role_name}. Execute the delegated task accurately.")
        })
    };
    format!("{}\n\n{}", base_prompt.trim(), role_body.trim())
}
