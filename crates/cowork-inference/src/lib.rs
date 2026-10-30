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

use serde::{Deserialize, Serialize};

/// Per-HTTP-attempt connection/first-byte/idle timeout in seconds.
pub const DEFAULT_HTTP_ATTEMPT_TIMEOUT_SECS: u64 = 120;

/// Overall single model-step wall-clock budget in seconds.
pub const DEFAULT_MODEL_STEP_BUDGET_SECS: u64 = 300;

/// Canonical message author role across all provider wire adapters.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MessageRole {
    System,
    Developer,
    User,
    Assistant,
    Tool,
}

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
