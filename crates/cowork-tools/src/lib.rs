//! Built-in agent tools (`bash`, `read`/`write`/`edit`, in-process `glob`/`grep`,
//! SSRF-safe `webFetch`/`webSearch`, `AskUserQuestion`, `todoWrite`, `skill`,
//! SQLite + Markdown memory, `threadManagement`, git `WorktreeService`,
//! `.cowork-scratchpad` overflow spilling, and `deferredToolSearch`).

pub mod agent_tools;
pub mod bash;
pub mod catalog;
pub mod code_mode_tool;
pub mod context;
pub mod fs_tools;
pub mod interactive;
pub mod mcp_tools;
pub mod memory;
pub mod mutation;
pub mod overflow;
pub mod search_tools;
pub mod task_tools;
pub mod text_codec;
pub mod thread_tools;
pub mod web;
pub mod workflow;
pub mod worktree;

pub use agent_tools::{
    CloseAgentTool, InspectAgentTool, ListAgentsTool, ResumeAgentTool, SendAgentInputTool,
    SpawnAgentTool, VALID_AGENT_ROLES, VALID_CONTEXT_MODES, WaitForAgentTool, all_subagent_tools,
    resolve_context_mode_and_briefing, validate_and_resolve_target_paths,
};
pub use bash::BashTool;
pub use catalog::{
    DeferredToolCatalog, MAX_PARALLEL_READ_BATCH, ParallelTestHook, ToolBatchCall, ToolBatchResult,
    ToolMap, ToolSearchResult, create_builtin_tools, execute_tool_batch,
};
pub use code_mode_tool::{
    CODE_MODE_DESCRIPTION, CatalogToolSearchTool, CodeModeTool, is_reserved_code_mode_tool,
};
pub use context::{
    ASK_SKIP_TOKEN, AgentControlBridge, ApprovalDecisionRequest, ApprovalHandler,
    BeforeToolInvocationHook, BuiltinTool, CostTrackerBridge, DnsOverrideFn,
    StructuredQuestionOption, StructuredUserQuestion, TaskToolBridge, ThreadControlBridge,
    TodosUpdatedCallback, ToolError, ToolExecutionContext, ToolExecutionPolicy, ToolOutput,
    ToolResult, WorkflowProgressCallback, assert_read_path_allowed, assert_write_path_allowed,
    canonicalize_with_missing_tail, create_read_path_checker, effective_sandbox_mode,
    normalize_and_validate_args, normalize_lexical_path, resolve_tool_path,
};
pub use fs_tools::{EditTool, ReadTool, WriteTool};
pub use interactive::{
    AskUserQuestionTool, DiscoveredSkill, ParsedSkillFrontmatter, SkillInterfaceMetadata,
    SkillScope, SkillTool, TodoWriteTool, discover_skills, discover_skills_for_config,
    encode_confined_icon_data_url, frame_untrusted_skill_body, is_builtin_skill_feature_gated,
    is_valid_skill_slug, parse_and_validate_skill_md, read_skill_agent_interface_metadata,
    render_skill_body_for_model, skill_policy_overlay, split_yaml_frontmatter,
};
pub use mcp_tools::{
    DEFAULT_TOOL_SEARCH_LIMIT, LoadedMcpBuiltinToolAdapter, MAX_TOOL_SEARCH_LIMIT, McpCallTool,
    McpToolSearchTool, SearchableToolEntry, score_and_paginate_tools, tokenize_search_text,
};
pub use memory::{
    AdvancedMemoryEntry, AdvancedMemoryStore, ManageMemoryTool, MemoryTool,
    ReadPastConversationTool, RecallMemoryTool, slugify,
};
pub use mutation::{
    ExistingFileSnapshot, FileVersion, same_file_version, stat_file_version, with_file_mutation,
};
pub use overflow::{
    DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS, TOOL_OUTPUT_PREVIEW_CHARS, is_overflow_exempt_tool,
    maybe_spill_tool_output, maybe_spill_tool_output_with_inner,
};
pub use search_tools::{GlobTool, GrepTool};
pub use task_tools::{
    CreateTaskTool, ReviewTaskTool, TaskUpdateTool, omit_provider_null_optionals,
    parse_reviewer_verdict, parse_task_update_directive,
};
pub use text_codec::{
    DecodedTextBuffer, LineEnding, TextEncoding, apply_eol, decode_text_buffer, detect_bom,
    detect_dominant_eol, encode_text_buffer, looks_binary_without_utf16_bom, normalize_to_lf,
    replace_respecting_eol,
};
pub use thread_tools::ThreadManagementTool;
pub use web::{
    WebFetchTool, WebSearchTool, html_to_clean_markdown, is_blocked_hostname, is_blocked_ip,
    wrap_untrusted_web_content,
};
pub use workflow::{
    WORKFLOW_TOOL_DESCRIPTION, WorkflowTool,
    input_spill::{
        MODEL_SCRATCHPAD_DIRNAME, WORKFLOW_INLINE_PROMPT_CHARS, WORKFLOW_MAX_PROMPT_CHARS,
        WorkflowInputSpill, spill_workflow_prompt_to_file,
    },
    registry::{
        WORKFLOW_DEFINITION_MAX_BYTES, WorkflowCatalogDiagnostic, WorkflowCatalogEntry,
        WorkflowCatalogSnapshot, WorkflowDefinitionScope, WorkflowRegistryPaths,
        assert_workflow_definition_name, list_workflow_definitions,
        resolve_workflow_definition_for_execution, save_workflow_definition,
    },
    runner::{
        DEFAULT_WORKFLOW_CONCURRENCY, DEFAULT_WORKFLOW_RUN_TIMEOUT_MS,
        MAX_RETAINED_TERMINAL_WORKFLOW_RUNS, MAX_WORKFLOW_CONCURRENCY, MAX_WORKFLOW_LOGS,
        WorkflowProgressAgent, WorkflowProgressPayload, WorkflowRunOptions, WorkflowRunOutcome,
        WorkflowRunSummary, resolve_workflow_concurrency, run_workflow,
        upsert_retained_workflow_run,
    },
};
pub use worktree::{CreatedWorktree, WorktreeCreateOptions, WorktreeService};

/// Canonical built-in tool identifiers registered by the harness.
pub const CANONICAL_BUILTIN_TOOL_IDS: [&str; 27] = [
    "bash",
    "read",
    "write",
    "edit",
    "glob",
    "grep",
    "webFetch",
    "webSearch",
    "AskUserQuestion",
    "todoWrite",
    "skill",
    "memory",
    "recallMemory",
    "manageMemory",
    "readPastConversation",
    "threadManagement",
    "toolSearch",
    "mcpCall",
    "codeMode",
    "workflow",
    "createTask",
    "taskUpdate",
    "reviewTask",
    "spawnAgent",
    "sendAgent",
    "waitAgent",
    "closeAgent",
];

/// Returns `true` if a tool's output is exempt from `.cowork-scratchpad` overflow truncation.
pub fn is_overflow_spill_exempt(tool_id: &str) -> bool {
    is_overflow_exempt_tool(tool_id, None)
}
