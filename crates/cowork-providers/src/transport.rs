use std::collections::HashMap;

use async_trait::async_trait;
use cowork_inference::{
    CanonicalMessage, MessageRole, ProviderContinuationState, ProviderTransportError,
    RequestPolicy, StepBudget, StreamEvent, TurnUsage,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Canonical tool schema definition passed to provider wire transports.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub parameters: Value,
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
}

/// Splits `messages` into `(prefix_up_to_last_assistant_and_paired_tools, delta_after)` for
/// server-managed continuation transports (`previous_response_id` / `previous_interaction_id`).
///
/// Note on stateful continuations:
/// - If the conversation ends with `[..., Assistant(tool_call), Tool(tool_result)]`, the server's
///   prior response ended at `Assistant(tool_call)`, so `prefix` is everything up through that
///   `Assistant` (or prior turn) depending on what the server already holds:
///   - Specifically, when `Assistant` was the server's last response, the server holds everything
///     up to and including `Assistant`, and `delta` is everything *after* the last `Assistant`!
///   - Wait: what if `Tool` results were already sent in an earlier step and now a new `User`
///     message arrives after an `Assistant`? Still everything after the last `Assistant`!
///   - What if `messages` has `[User1, Assistant1, Tool1, User2]` where `previous_interaction_id`
///     was saved before `User2` (e.g., after `Tool1` or `Assistant1`)? Let's expose both helpers:
///     `split_after_last_assistant` (for OpenAI Responses where every step ends on `Assistant`)
///     and `split_trailing_user_or_after_assistant`!
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
/// non-assistant messages (`split_after_last_assistant`), or before trailing user messages if
/// tool results were part of the stored prefix.
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
    candidates
}
