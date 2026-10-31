//! `cowork-js-vm` — Inference & Scripting Engines Layer.
//!
//! Module boundaries owned by this crate:
//! - **TypeScript transpile pipeline (`oxc`)**: Parses `.ts`/`.mts`/`.js` via `oxc_parser`,
//!   populates scoping tables via `oxc_semantic::SemanticBuilder`, strips TypeScript syntax via
//!   `oxc_transformer::Transformer`, and emits ES2022 code via `oxc_codegen`.
//! - **Isolated `rquickjs` runtime**: Cross-platform per-isolate heap limits
//!   (`Runtime::set_memory_limit`), stack limits, wall-clock interrupt handlers, frozen intrinsics,
//!   and deterministic RNG/clock traps with zero ambient filesystem or network globals.
//! - **Execution surfaces**: Host bridges for `codeMode` (`tools.search`, `tools.call`) and
//!   journal-replayed `workflows/*.ts` (`WorkflowJournal` with `resumeFromRunId`).

pub mod code_mode;
pub mod journal;
pub mod realm;
pub mod transpile;
pub mod workflow_vm;

/// Default per-isolate QuickJS heap ceiling in bytes (`64 MiB`).
pub const DEFAULT_ISOLATE_HEAP_LIMIT_BYTES: usize = 64 * 1024 * 1024;

/// Default per-isolate QuickJS max stack size in bytes (`1 MiB`).
pub const DEFAULT_ISOLATE_MAX_STACK_BYTES: usize = 1024 * 1024;

pub use code_mode::{
    CodeModeCallEvent, CodeModeCallEventSink, CodeModeCatalog, CodeModeExecutionResult,
    CodeModeLimits, CodeModeOptions, RESERVED_CODE_MODE_TOOL_NAMES, execute_code_mode,
};
pub use journal::{
    SchemaValidation, WorkflowJournal, WorkflowJournalEntry, WorkflowJournalOpenOptions,
    assert_safe_workflow_run_id, build_repair_instruction, build_schema_instruction,
    build_schema_system_instruction, canonicalize_json, digest_agent_call, extract_result_envelope,
    hash_workflow_args, validate_against_json_schema, workflow_run_dir,
};
pub use realm::{
    DEFAULT_MAX_CONSOLE_LINE_CHARS, DEFAULT_MAX_CONSOLE_LOGS, DEFAULT_WALL_CLOCK_TIMEOUT_MS,
    DeterminismMode, IsolateLimits, VmError, VmEvalOptions, VmEvalResult, eval_isolated_module,
};
pub use transpile::{
    CompileIssue, WorkflowCompileResult, compile_code_mode_module, compile_workflow_source,
    strip_typescript,
};
pub use workflow_vm::{
    DEFAULT_INSPECTION_TIMEOUT_MS, InspectedWorkflow, WORKFLOW_MAX_AGENTS_PER_RUN,
    WorkflowAgentBridgeReply, WorkflowMeta, WorkflowVmBridge, WorkflowVmRunOptions,
    execute_workflow_module, inspect_workflow_source, validate_workflow_meta_value,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vm_resource_limits_are_positive_and_bounded() {
        assert_eq!(DEFAULT_ISOLATE_HEAP_LIMIT_BYTES, 64 * 1024 * 1024);
        assert_eq!(DEFAULT_ISOLATE_MAX_STACK_BYTES, 1024 * 1024);
        assert_eq!(DEFAULT_WALL_CLOCK_TIMEOUT_MS, 30_000);
        assert_eq!(cowork_storage::LATEST_SESSION_DB_SCHEMA_VERSION, 28);
    }
}
