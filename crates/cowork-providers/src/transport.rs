use std::collections::HashMap;

use async_trait::async_trait;
pub use cowork_inference::ToolDefinition;
use cowork_inference::{
    CanonicalMessage, MessageRole, ProviderContinuationState, ProviderTransportError,
    RequestPolicy, StepBudget, StreamEvent, TurnUsage,
};
use serde_json::{Map, Value};

/// Internal request-scoped `provider_options` flag stamped by the harness when a turn starts with
/// `tools: "none"`, ensuring transports that manage native tools (e.g. Codex app-server) also
/// disable them and compute a distinct continuation fingerprint.
pub const COWORK_TOOLS_DISABLED_OPTION_KEY: &str = "__coworkToolsDisabled";

pub fn request_disables_all_tools(provider_options: &Map<String, Value>) -> bool {
    provider_options
        .get(COWORK_TOOLS_DISABLED_OPTION_KEY)
        .and_then(Value::as_bool)
        == Some(true)
}

/// Single model-step streaming request passed to a `ProviderTransport`.
#[derive(Debug, Clone)]
pub struct ProviderStepRequest {
    pub model_id: String,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    pub extra_headers: HashMap<String, String>,
    pub system_prompt: String,
    pub messages: Vec<CanonicalMessage>,
    pub tools: Vec<ToolDefinition>,
    pub authorized_tool_names: Option<Vec<String>>,
    pub provider_options: Map<String, Value>,
    pub continuation: Option<ProviderContinuationState>,
    pub policy: RequestPolicy,
    pub turn_id: String,
}

/// Completed model-step output returned by a `ProviderTransport`.
#[derive(Debug, Clone)]
pub struct ProviderStepResult {
    pub assistant: CanonicalMessage,
    /// Filtered assistant message for transcript persistence (e.g., omitting OpenAI `commentary`
    /// text blocks while keeping `final_answer`, encrypted reasoning, and tool calls).
    pub persisted_assistant: Option<CanonicalMessage>,
    pub usage: TurnUsage,
    pub continuation: Option<ProviderContinuationState>,
    pub raw_events: Vec<Value>,
}

pub type StreamEventCallback<'a> = dyn FnMut(StreamEvent) + Send + 'a;

/// Common trait implemented by all native Rust provider wire transports.
#[async_trait]
pub trait ProviderTransport: Send + Sync {
    async fn stream_step(
        &self,
        request: ProviderStepRequest,
        budget: &StepBudget,
        on_event: &mut StreamEventCallback<'_>,
    ) -> Result<ProviderStepResult, ProviderTransportError>;

    /// Advertises native tool search and programmatic tool calling capabilities supported by this
    /// wire transport for `(base_url, model_id, strategy)`. Mock/queue transports and non-native
    /// transports inherit `EndpointToolCapabilities::none()`, ensuringCowork's Rust harness is used.
    fn native_tool_capabilities(
        &self,
        _base_url: Option<&str>,
        _model_id: &str,
        _strategy: cowork_config::ToolCallingStrategy,
    ) -> crate::endpoint_capabilities::EndpointToolCapabilities {
        crate::endpoint_capabilities::EndpointToolCapabilities::none()
    }
}

/// Splits `messages` into `(prefix_up_to_last_assistant_and_paired_tools, delta_after)` for
/// server-managed continuation transports (`previous_response_id` / `previous_interaction_id`).
pub fn split_after_last_assistant(
    messages: &[CanonicalMessage],
) -> (&[CanonicalMessage], &[CanonicalMessage]) {
    if let Some(last_assistant_idx) = messages
        .iter()
        .rposition(|m| m.role == MessageRole::Assistant)
    {
        let next_idx = last_assistant_idx + 1;
        if next_idx < messages.len() {
            return (&messages[..=last_assistant_idx], &messages[next_idx..]);
        }
    }
    (&[], messages)
}

/// Splits `messages` for continuation validation, trying first the prefix before trailing
/// non-assistant messages (`split_after_last_assistant`), before trailing user messages if tool
/// results were part of the stored prefix, or `(messages, &[])` when the trailing assistant
/// message requires an immediate server-side continuation step (e.g. `program_output` / `pause_turn`).
pub fn candidate_continuation_splits(
    messages: &[CanonicalMessage],
) -> Vec<(&[CanonicalMessage], &[CanonicalMessage])> {
    let mut candidates = Vec::new();
    let (prefix_a, delta_a) = split_after_last_assistant(messages);
    if !delta_a.is_empty() {
        candidates.push((prefix_a, delta_a));
    }
    // Also check if trailing messages end with User message(s) after a Tool message that was
    // already included in the stored prefix fingerprint.
    if let Some(last_non_user_idx) = messages.iter().rposition(|m| m.role != MessageRole::User) {
        let split_idx = last_non_user_idx + 1;
        if split_idx < messages.len() && split_idx != prefix_a.len() {
            candidates.push((&messages[..split_idx], &messages[split_idx..]));
        }
    }
    // Server-side continuation step (`program_output` without final message, or `pause_turn`):
    // the entire transcript up through the trailing Assistant message matches the stored prefix,
    // and the new delta input is empty (`input: []`).
    if let Some(last) = messages.last()
        && last.role == MessageRole::Assistant
        && last
            .provider_meta
            .extra
            .get("requiresContinuationStep")
            .and_then(Value::as_bool)
            == Some(true)
    {
        candidates.push((messages, &[][..]));
    }
    candidates
}
