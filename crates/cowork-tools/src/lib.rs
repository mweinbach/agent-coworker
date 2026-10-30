//! `cowork-tools` — Tools, MCP & Harness Orchestration Layer.
//!
//! Module boundaries owned by this crate:
//! - **Built-in tool catalog**: Canonical tool definitions and executors (`bash`, `read`, `write`,
//!   `edit`, `glob`, `grep`, `webFetch`, `webSearch`, `AskUserQuestion`, `todoWrite`, `skill`,
//!   `memory`, `recallMemory`, `manageMemory`, `readPastConversation`, `threadManagement`,
//!   `toolSearch`, `mcpCall`, `codeMode`, `workflow`, `createTask`, `taskUpdate`, `reviewTask`,
//!   `spawnAgent`, `sendAgent`, `waitAgent`, `closeAgent`).
//! - **Overflow scratchpad spill**: Spills oversized tool outputs to `.cowork-scratchpad` while
//!   strictly exempting `read` and `skill`.
//! - **Atomic file mutation & search**: `withFileMutation` (BOM/EOL preservation + `withFileLock`)
//!   and native `ignore` + `grep-searcher` search.
//! - **SSRF-safe web tools**: DNS-pinned `webFetch` (`scraper` + `htmd`) and `webSearch`.

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
    matches!(tool_id, "read" | "skill")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_tool_ids_and_overflow_exemptions_match_contract() {
        assert_eq!(CANONICAL_BUILTIN_TOOL_IDS.len(), 27);
        assert!(is_overflow_spill_exempt("read"));
        assert!(is_overflow_spill_exempt("skill"));
        assert!(!is_overflow_spill_exempt("bash"));
        assert!(!is_overflow_spill_exempt("grep"));
    }
}
