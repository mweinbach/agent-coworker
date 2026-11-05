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
pub mod connection;
pub mod google_interactions;
pub mod oauth;
pub mod openai_responses;
pub mod sse;
pub mod transport;

use cowork_config::{ProviderName, ProviderWireProtocol};
use serde::{Deserialize, Serialize};

pub use anthropic_messages::AnthropicMessagesTransport;
pub use bedrock::BedrockConverseTransport;
pub use catalog::{
    CatalogBuildOptions, ProviderAuthMethod, ProviderAuthMethodField, ProviderCatalogEntry,
    ProviderCatalogModelEntry, ProviderCatalogPayload, ProviderCatalogReasoning,
    ProviderCatalogSnapshot, ProviderStatusEntry, build_provider_catalog, build_provider_statuses,
    default_provider_auth_methods, default_provider_auth_methods_for, mask_api_key,
    provider_display_label, read_provider_catalog_snapshot, resolve_provider_api_key,
    resolve_provider_auth_method, validate_structured_provider_config,
};
pub use chat_completions::{ChatCompletionsTransport, ProviderQuirks};
pub use codex_app_server::CodexAppServerTransport;
pub use connection::{
    ResolvedProviderConnection, provider_base_url_env_key, provider_base_url_override,
    resolve_provider_base_url, resolve_provider_bedrock_auth, resolve_provider_connection,
    select_provider_transport,
};
pub use google_interactions::{
    GoogleInteractionsTransport, GoogleSignatureRepairOutcome, repair_google_tool_call_signatures,
    sanitize_google_replay_messages,
};
pub use oauth::PkceOAuthManager;
pub use openai_responses::OpenAiResponsesTransport;
pub use sse::{BoxedSseStream, SseFrame, build_http_client, post_json_sse};
pub use transport::{
    COWORK_TOOLS_DISABLED_OPTION_KEY, ProviderStepRequest, ProviderStepResult, ProviderTransport,
    StreamEventCallback, ToolDefinition, candidate_continuation_splits, request_disables_all_tools,
    split_after_last_assistant,
};

/// Every registered provider identifier, in canonical order (`config/providers.json`, matching
/// `config/models/<provider>/`).
pub fn registered_provider_ids() -> impl Iterator<Item = &'static str> {
    cowork_config::provider_specs()
        .iter()
        .map(|spec| spec.id.as_str())
}

/// Default inference endpoint of `provider` (`inferenceBaseUrl` in `config/providers.json`), or
/// `""` for providers without an HTTP endpoint (Bedrock resolves per region, Codex is stdio).
pub fn default_inference_base_url(provider: ProviderName) -> &'static str {
    provider
        .spec()
        .inference_base_url
        .as_deref()
        .unwrap_or_default()
}

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

impl From<ProviderWireProtocol> for ProviderTransportKind {
    fn from(protocol: ProviderWireProtocol) -> Self {
        match protocol {
            ProviderWireProtocol::OpenaiResponses => Self::OpenAiResponsesSse,
            ProviderWireProtocol::AnthropicMessages => Self::AnthropicMessagesSse,
            ProviderWireProtocol::GeminiInteractions => Self::GeminiInteractionsSse,
            ProviderWireProtocol::ChatCompletions => Self::ChatCompletionsSse,
            ProviderWireProtocol::BedrockConverse => Self::BedrockConverseStream,
            ProviderWireProtocol::CodexAppServer => Self::CodexAppServerStdio,
        }
    }
}

/// Maps a registered provider ID to its native wire transport family (`transport` in
/// `config/providers.json`).
pub fn transport_for_provider(provider_id: &str) -> Option<ProviderTransportKind> {
    ProviderName::parse(provider_id).map(|provider| provider.spec().transport.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_registered_provider_maps_to_a_native_transport() {
        assert_eq!(registered_provider_ids().count(), ProviderName::ALL.len());
        for provider_id in registered_provider_ids() {
            assert!(
                transport_for_provider(provider_id).is_some(),
                "missing transport mapping for {provider_id}"
            );
        }
        assert_eq!(transport_for_provider("unknown"), None);
        assert_eq!(
            transport_for_provider("fireworks"),
            Some(ProviderTransportKind::ChatCompletionsSse)
        );
        assert_eq!(
            transport_for_provider("codex-cli"),
            Some(ProviderTransportKind::CodexAppServerStdio)
        );
    }
}
