use std::path::PathBuf;

use cowork_config::SandboxMode;
use serde_json::{Value, json};

use crate::transport::ToolDefinition;

#[derive(Debug, Clone)]
pub struct CodexSandboxNarrowingInput {
    pub mode: SandboxMode,
    pub network: bool,
    pub yolo: bool,
    pub workspace_dir: PathBuf,
    pub agent_target_paths: Vec<PathBuf>,
    pub read_only_role: bool,
    pub has_mutation_guard_with_dynamic_tools: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CodexSandboxNarrowingOutput {
    pub thread_sandbox: String,
    pub turn_sandbox_policy: Value,
    pub approval_policy: String,
    pub force_disable_web_search: bool,
}

/// Resolves Codex `thread/start` and `turn/start` sandbox & approval policies while preserving
/// Cowork security floors:
/// - `DangerFullAccess` + `network: false` narrows to `workspace-write` + `networkAccess: false` +
///   `force_disable_web_search: true` (since Codex `dangerFullAccess` cannot independently block network).
/// - `ReadOnly` and scoped `agent_target_paths` floors remain enforced even under `yolo: true`.
pub fn resolve_codex_sandbox_and_approval_policy(
    input: &CodexSandboxNarrowingInput,
) -> CodexSandboxNarrowingOutput {
    let has_scoped_paths = !input.agent_target_paths.is_empty();
    let is_read_only = input.mode == SandboxMode::ReadOnly || input.read_only_role;

    let (thread_sandbox, turn_sandbox_policy, force_disable_web_search) = if is_read_only {
        (
            "read-only".to_string(),
            json!({
                "type": "readOnly",
                "networkAccess": input.network,
            }),
            !input.network,
        )
    } else if has_scoped_paths
        || matches!(input.mode, SandboxMode::WorkspaceWrite | SandboxMode::Auto)
        || (input.mode == SandboxMode::DangerFullAccess && !input.network)
    {
        let writable_roots: Vec<String> = if has_scoped_paths {
            input
                .agent_target_paths
                .iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect()
        } else {
            vec![input.workspace_dir.to_string_lossy().into_owned()]
        };

        (
            "workspace-write".to_string(),
            json!({
                "type": "workspaceWrite",
                "writableRoots": writable_roots,
                "networkAccess": input.network,
            }),
            !input.network,
        )
    } else {
        (
            "danger-full-access".to_string(),
            json!({ "type": "dangerFullAccess" }),
            false,
        )
    };

    let approval_policy = if input.yolo
        && !is_read_only
        && !has_scoped_paths
        && !input.has_mutation_guard_with_dynamic_tools
    {
        "never".to_string()
    } else {
        "on-request".to_string()
    };

    CodexSandboxNarrowingOutput {
        thread_sandbox,
        turn_sandbox_policy,
        approval_policy,
        force_disable_web_search,
    }
}

pub fn to_codex_mcp_tool_name(name: &str) -> String {
    if name.starts_with("mcp__") {
        format!("cowork_{name}")
    } else {
        name.to_string()
    }
}

pub fn from_codex_mcp_tool_name(name: &str) -> String {
    if let Some(rest) = name.strip_prefix("cowork_mcp__") {
        format!("mcp__{rest}")
    } else {
        name.to_string()
    }
}

/// Filters Cowork tools across the Codex hybrid tool boundary:
/// - Native shell/mutation/fetch tools (`bash`, `write`, `edit`, `webFetch`) are handled natively
///   by Codex and excluded from `dynamicTools`.
/// - `read`, `glob`, `grep` are excluded unless `preserve_scoped_file_read_tools` is `true`.
/// - `mcp__*` tools are renamed to `cowork_mcp__*` so Codex routes them through `item/tool/call`.
pub fn filter_codex_dynamic_tools(
    tools: &[ToolDefinition],
    preserve_scoped_file_read_tools: bool,
) -> Vec<ToolDefinition> {
    let mut out = Vec::new();
    for tool in tools {
        let name = tool.name.as_str();
        if matches!(name, "bash" | "write" | "edit" | "webFetch" | "web_fetch") {
            continue;
        }
        if !preserve_scoped_file_read_tools && matches!(name, "read" | "glob" | "grep") {
            continue;
        }
        out.push(ToolDefinition {
            name: to_codex_mcp_tool_name(name),
            description: tool.description.clone(),
            parameters: tool.parameters.clone(),
        });
    }
    out
}
