//! `cowork-harness` — Tools, MCP & Harness Orchestration Layer.
//!
//! Module boundaries owned by this crate:
//! - **Turn loop orchestration**: `TurnStepRunner`, mid-turn `SteerCoordinator`, cascading
//!   `turn/interrupt`, `TurnIdempotencyLedger`, multimodal attachment staging, layered system
//!   prompt assembly, session title generation, `MemoryGenerator`, and receipt-tracked
//!   `InteractionManager` (`requestApproval`, `requestUserInput`).
//! - **Collaborative subagents (`AgentControl`)**: Enforces `MAX_SUBAGENT_DEPTH = 1` and
//!   `MAX_ACTIVE_SUBAGENTS = 16`, role floors, `targetPaths`, and cross-provider child routing.
//! - **Durable Task mode (`TaskCoordinator`)**: Optimistic concurrency (`expectedRevision`), DAG
//!   work-item claims, blocking questions auto-resume, `ArtifactVersionStore`, and minimum 3-round
//!   independent reviewer verification.

pub mod agents;
pub mod attachments;
pub mod extensions;
pub mod idempotency;
pub mod interactions;
pub mod memory_generator;
pub mod steer;
pub mod system_prompt;
pub mod tasks;
pub mod title;
pub mod turn_runner;

pub use agents::{
    AgentControl, AgentControlConfig, AgentEventSink, AgentInspectionPayload, AgentProfileScope,
    AgentProfileSnapshot, AgentProfilesCatalog, AgentProfilesStore, AgentSpawnRequest,
    AgentWaitInspection, AgentWaitOutcome, BUILTIN_AGENT_ROLES, ChildAgentReport,
    ChildTurnExecutor, ChildTurnInput, ChildTurnResult, MAX_ACTIVE_CHILDREN_PER_PARENT,
    MAX_SPAWN_DEPTH, PersistentAgentSummary,
};
pub use attachments::{MaterializedTurnInput, materialize_turn_attachments};
pub use extensions::{ExtensionManager, SkillMutationBus, SkillMutationSignal};
pub use idempotency::{AcceptedTurnRecord, IdempotencyCheckOutcome, TurnIdempotencyLedger};
pub use interactions::{HarnessEventSink, InteractionManager};
pub use memory_generator::{MemoryGenerator, RemoteMemoryModel};
pub use steer::{SteerCoordinator, SteerEntry};
pub use system_prompt::{
    ResolvedTurnMentions, SystemPromptBuildOptions, build_layered_system_prompt,
    collect_project_instructions, resolve_turn_mentions,
};
pub use title::{
    RemoteTitleOptions, generate_heuristic_session_title, generate_remote_session_title,
    preferred_title_model_for_provider,
};
pub use turn_runner::{TurnCancellationHandle, TurnRunConfig, TurnRunOutcome, TurnStepRunner};

/// Maximum allowed subagent nesting depth (children cannot spawn grandchildren).
pub const MAX_SUBAGENT_DEPTH: u8 = 1;

/// Maximum concurrent active child subagents per parent session.
pub const MAX_ACTIVE_SUBAGENTS: usize = 16;

/// Minimum independent reviewer verification rounds enforced by `reviewTask`.
pub const MIN_TASK_REVIEW_ROUNDS: u32 = 3;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn harness_orchestration_limits_match_architecture() {
        assert_eq!(MAX_SUBAGENT_DEPTH, 1);
        assert_eq!(MAX_ACTIVE_SUBAGENTS, 16);
        assert_eq!(MIN_TASK_REVIEW_ROUNDS, 3);
        assert_eq!(cowork_providers::REGISTERED_PROVIDER_IDS.len(), 14);
        assert_eq!(cowork_tools::CANONICAL_BUILTIN_TOOL_IDS.len(), 27);
    }
}
