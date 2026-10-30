//! `cowork-js-vm` — Inference & Scripting Engines Layer.
//!
//! Module boundaries owned by this crate:
//! - **TypeScript transpile pipeline (`oxc`)**: Parses `.ts`/`.mts`/`.js` via `oxc_parser`,
//!   populates scoping tables via `oxc_semantic::SemanticBuilder`, strips TypeScript syntax via
//!   `oxc_transformer::Transformer`, and emits ES2022 code via `oxc_codegen`.
//! - **Isolated `rquickjs` runtime**: Cross-platform per-isolate heap limits
//!   (`Runtime::set_memory_limit`), stack limits, wall-clock interrupt handlers, and deterministic
//!   RNG/clock traps with zero ambient filesystem or network globals.
//! - **Execution surfaces**: Host bridges for `codeMode` (`tools.search`, `tools.call`) and
//!   journal-replayed `workflows/*.ts` (`WorkflowJournal` with `resumeFromRunId`).

/// Default per-isolate QuickJS heap ceiling in bytes (`64 MiB`).
pub const DEFAULT_ISOLATE_HEAP_LIMIT_BYTES: usize = 64 * 1024 * 1024;

/// Default per-isolate QuickJS max stack size in bytes (`1 MiB`).
pub const DEFAULT_ISOLATE_MAX_STACK_BYTES: usize = 1024 * 1024;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vm_resource_limits_are_positive_and_bounded() {
        assert_eq!(DEFAULT_ISOLATE_HEAP_LIMIT_BYTES, 64 * 1024 * 1024);
        assert_eq!(DEFAULT_ISOLATE_MAX_STACK_BYTES, 1024 * 1024);
        assert_eq!(cowork_storage::LATEST_SESSION_DB_SCHEMA_VERSION, 28);
    }
}
