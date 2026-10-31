//! Built-in agent tools (`bash`, `read`/`write`/`edit`, in-process `glob`/`grep`,
//! SSRF-safe `webFetch`/`webSearch`, `AskUserQuestion`, `todoWrite`, `skill`,
//! SQLite + Markdown memory, `threadManagement`, git `WorktreeService`,
//! `.cowork-scratchpad` overflow spilling, and `deferredToolSearch`).

pub mod bash;
pub mod catalog;
pub mod context;
pub mod fs_tools;
pub mod interactive;
pub mod memory;
pub mod mutation;
pub mod overflow;
pub mod search_tools;
pub mod text_codec;
pub mod thread_tools;
pub mod web;
pub mod worktree;

pub use bash::BashTool;
pub use catalog::{
    DeferredToolCatalog, MAX_PARALLEL_READ_BATCH, ParallelTestHook, ToolBatchCall, ToolBatchResult,
    ToolMap, ToolSearchResult, create_builtin_tools, execute_tool_batch,
};
pub use context::{
    ASK_SKIP_TOKEN, ApprovalDecisionRequest, ApprovalHandler, BuiltinTool, DnsOverrideFn,
    StructuredQuestionOption, StructuredUserQuestion, ThreadControlBridge, TodosUpdatedCallback,
    ToolError, ToolExecutionContext, ToolExecutionPolicy, ToolOutput, ToolResult,
    assert_read_path_allowed, assert_write_path_allowed, canonicalize_with_missing_tail,
    create_read_path_checker, effective_sandbox_mode, normalize_and_validate_args,
    normalize_lexical_path, resolve_tool_path,
};
pub use fs_tools::{EditTool, ReadTool, WriteTool};
pub use interactive::{
    AskUserQuestionTool, DiscoveredSkill, SkillScope, SkillTool, TodoWriteTool, discover_skills,
    render_skill_body_for_model, split_yaml_frontmatter,
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
