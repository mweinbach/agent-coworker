//! `cowork-inference` — Inference & Scripting Engines Layer.
//!
//! Module boundaries owned by this crate:
//! - **Canonical inference AST**: `CanonicalMessage`, `ContentBlock` (`Text`, `Thinking`,
//!   `ToolCall`, `ProviderNativeTool`, `ToolResult`, `Media`), and `ProviderOpaqueMeta` preserving
//!   lossless round-trip state across providers without third-party JS/LLM SDKs.
//! - **Unified `StreamEvent` & projector**: Incremental partial-JSON tool delta parsing and
//!   occurrence-stable projection to `cowork-protocol` `item/*` events.
//! - **Model registry & cost tracking**: Loads `config/models/<provider>/*.json`, computes tiered
//!   USD pricing (`longContextThresholdTokens`), and enforces `warnAtUsd` / `stopAtUsd` budgets.
//! - **Reliability & continuation fingerprinting**: Enforces `120s` HTTP attempt and `300s`
//!   overall step timeouts, pre-first-visible-token jittered `Retry-After` backoff, and SHA-256
//!   continuation-prefix invalidation.

pub mod ast;
pub mod continuation;
pub mod cost_tracker;
pub mod error;
pub mod partial_json;
pub mod pricing;
pub mod projector;
pub mod registry;
pub mod reliability;
pub mod stream;

pub use ast::{
    CanonicalMessage, Citation, ContentBlock, MediaKind, MediaSource, MessageRole,
    ProviderNativeToolRole, ProviderOpaqueMeta, StopReason, TextPhase, ToolDefinition,
    ToolResultPart, compose_openai_tool_call_id, extract_nested_citations,
    filter_persisted_assistant_history, sanitize_openai_composite_tool_id,
    split_openai_tool_call_id,
};
pub use continuation::{
    ContinuationFingerprintInput, ProviderContinuationState, compute_continuation_fingerprint,
    validate_continuation_state,
};
pub use cost_tracker::{
    BudgetStatus, BudgetThresholdUpdate, BudgetThresholds, COMPACT_SNAPSHOT_TURNS_LIMIT,
    CostTrackerEvent, ModelUsageSummary, SessionCostTracker, SessionUsageSnapshot, TurnCostEntry,
    TurnUsage, UsageCostBreakdown,
};
pub use error::InferenceError;
pub use partial_json::{StreamingToolDeltaParser, parse_partial_json, parse_partial_json_object};
pub use pricing::{
    ModelPricing, PricingCatalogEntry, PricingEngine, TokenCostBreakdown,
    calculate_token_cost_breakdown, format_cost, format_token_count,
};
pub use projector::{ClientCapabilities, ProjectedNotification, StreamEventProjector};
pub use registry::InferenceModelRegistry;
pub use reliability::{
    DEFAULT_HTTP_ATTEMPT_TIMEOUT_SECS, DEFAULT_MODEL_STEP_BUDGET_SECS, ProviderTransportError,
    RATE_LIMIT_RETRY_BASE_DELAY_MS, RATE_LIMIT_RETRY_DEFAULT_MAX_ATTEMPTS,
    RATE_LIMIT_RETRY_MAX_DELAY_MS, RequestPolicy, StepBudget, compute_backoff_delay_ms,
    execute_step_with_pre_output_retry, execute_step_with_sink, parse_retry_after_ms,
};
pub use stream::{ReasoningStreamMode, StreamEvent};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inference_budgets_and_roles_match_architecture() {
        assert_eq!(DEFAULT_HTTP_ATTEMPT_TIMEOUT_SECS, 120);
        assert_eq!(DEFAULT_MODEL_STEP_BUDGET_SECS, 300);
        assert_eq!(
            serde_json::to_string(&MessageRole::Assistant).unwrap(),
            "\"assistant\""
        );
        assert_eq!(cowork_protocol::WEBSOCKET_SUBPROTOCOL, "cowork.jsonrpc.v1");
    }
}
