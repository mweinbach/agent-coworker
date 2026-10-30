//! `cowork-providers` — Inference & Scripting Engines Layer.
//!
//! Module boundaries owned by this crate:
//! - **6 native wire transports**:
//!   1. OpenAI Responses SSE (`openai`)
//!   2. Anthropic Messages SSE (`anthropic`)
//!   3. Google Gemini Interactions SSE (`google`)
//!   4. OpenAI Chat Completions SSE + declarative `ProviderQuirks` (`together`, `fireworks`,
//!      `firepass`, `nvidia`, `minimax`, `lmstudio`, `opencode-go`, `opencode-zen`, `baseten`)
//!   5. AWS Bedrock ConverseStream (`bedrock` via `aws-smithy-eventstream` + `aws-sigv4`/Bearer)
//!   6. Codex App-Server stdio JSON-RPC (`codex-cli` under isolated `~/.cowork/auth/codex-cli`)
//! - **Dual-stack OAuth 2.1 PKCE**: Loopback `127.0.0.1` + `[::1]` ephemeral callback listeners,
//!   S256 PKCE verification, and token refresh.

pub mod anthropic_messages;
pub mod bedrock;
pub mod catalog;
pub mod chat_completions;
pub mod codex_app_server;
pub mod google_interactions;
pub mod oauth;
pub mod openai_responses;
pub mod sse;
pub mod transport;

use serde::{Deserialize, Serialize};

pub use anthropic_messages::AnthropicMessagesTransport;
pub use bedrock::BedrockConverseTransport;
pub use catalog::{
    CatalogBuildOptions, ProviderAuthMethod, ProviderAuthMethodField, ProviderCatalogEntry,
    ProviderCatalogModelEntry, ProviderCatalogPayload, ProviderCatalogReasoning,
    ProviderStatusEntry, build_provider_catalog, build_provider_statuses,
    default_provider_auth_methods, default_provider_auth_methods_for, mask_api_key,
    provider_display_label, resolve_provider_api_key, resolve_provider_auth_method,
    validate_structured_provider_config,
};
pub use chat_completions::{ChatCompletionsTransport, ProviderQuirks};
pub use codex_app_server::CodexAppServerTransport;
pub use google_interactions::{
    GoogleInteractionsTransport, GoogleSignatureRepairOutcome, repair_google_tool_call_signatures,
    sanitize_google_replay_messages,
};
pub use oauth::PkceOAuthManager;
pub use openai_responses::OpenAiResponsesTransport;
pub use sse::{BoxedSseStream, SseFrame, build_http_client, post_json_sse};
pub use transport::{
    ProviderStepRequest, ProviderStepResult, ProviderTransport, StreamEventCallback,
    ToolDefinition, candidate_continuation_splits, split_after_last_assistant,
};

/// All 14 registered provider identifiers matching `config/models/<provider>/`.
pub const REGISTERED_PROVIDER_IDS: [&str; 14] = [
    "anthropic",
    "bedrock",
    "baseten",
    "together",
    "fireworks",
    "firepass",
    "nvidia",
    "lmstudio",
    "minimax",
    "opencode-go",
    "opencode-zen",
    "codex-cli",
    "google",
    "openai",
];

/// Native wire transport families implemented by `cowork-providers`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderTransportKind {
    OpenAiResponsesSse,
    AnthropicMessagesSse,
    GeminiInteractionsSse,
    ChatCompletionsSse,
    BedrockConverseStream,
    CodexAppServerStdio,
}

/// Maps a registered provider ID to its native wire transport family.
pub fn transport_for_provider(provider_id: &str) -> Option<ProviderTransportKind> {
    match provider_id {
        "openai" => Some(ProviderTransportKind::OpenAiResponsesSse),
        "anthropic" => Some(ProviderTransportKind::AnthropicMessagesSse),
        "google" => Some(ProviderTransportKind::GeminiInteractionsSse),
        "bedrock" => Some(ProviderTransportKind::BedrockConverseStream),
        "codex-cli" => Some(ProviderTransportKind::CodexAppServerStdio),
        "together" | "fireworks" | "firepass" | "nvidia" | "lmstudio" | "minimax"
        | "opencode-go" | "opencode-zen" | "baseten" => {
            Some(ProviderTransportKind::ChatCompletionsSse)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_fourteen_providers_map_to_a_native_transport() {
        assert_eq!(REGISTERED_PROVIDER_IDS.len(), 14);
        for provider_id in REGISTERED_PROVIDER_IDS {
            assert!(
                transport_for_provider(provider_id).is_some(),
                "missing transport mapping for {provider_id}"
            );
        }
        assert_eq!(transport_for_provider("unknown"), None);
    }
}
