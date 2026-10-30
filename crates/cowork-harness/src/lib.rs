//! `cowork-harness` — Tools, MCP & Harness Orchestration Layer.
//!
//! Module boundaries owned by this crate:
//! - **Turn loop orchestration**: `TurnStepRunner`, mid-turn `SteerCoordinator`, cascading
//!   `turn/interrupt`, and receipt-tracked `InteractionManager` (`requestApproval`,
//!   `requestUserInput`).
//! - **Collaborative subagents (`AgentControl`)**: Enforces `MAX_SUBAGENT_DEPTH = 1` and
//!   `MAX_ACTIVE_SUBAGENTS = 16`, role floors, `targetPaths`, and cross-provider child routing.
//! - **Durable Task mode (`TaskCoordinator`)**: Optimistic concurrency (`expectedRevision`), DAG
//!   work-item claims, blocking questions auto-resume, `ArtifactVersionStore`, and minimum 3-round
//!   independent reviewer verification.
//! - **Workspace & lifecycle services**: Skills/plugins/marketplaces, native OOXML/Canvas/Univer
//!   handlers, workspace backups, conversation/skill importers, `SkillImprovementService`, and
//!   redacted observability exporters.

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
