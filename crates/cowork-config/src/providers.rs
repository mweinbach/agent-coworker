use serde::{Deserialize, Serialize};
use std::fmt;
use std::sync::LazyLock;

use crate::provider_specs::{
    ProviderDiscoveryMode, ProviderSpec, ProviderWireProtocol, provider_spec,
};

/// All 14 supported inference providers. Identity strings, display names and all other static
/// metadata come from `config/providers.json` (`crate::provider_specs`); declaration order must
/// match that file's order (enforced by `provider_specs` tests).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ProviderName {
    Google,
    Openai,
    Anthropic,
    Bedrock,
    Baseten,
    Together,
    Fireworks,
    Firepass,
    Nvidia,
    Lmstudio,
    Minimax,
    OpencodeGo,
    OpencodeZen,
    CodexCli,
}

impl ProviderName {
    pub const ALL: [Self; 14] = [
        Self::Google,
        Self::Openai,
        Self::Anthropic,
        Self::Bedrock,
        Self::Baseten,
        Self::Together,
        Self::Fireworks,
        Self::Firepass,
        Self::Nvidia,
        Self::Lmstudio,
        Self::Minimax,
        Self::OpencodeGo,
        Self::OpencodeZen,
        Self::CodexCli,
    ];

    /// The provider id (`config/providers.json` `id`).
    pub fn as_str(&self) -> &'static str {
        provider_spec(*self).id.as_str()
    }

    /// Parses a provider id, ignoring surrounding whitespace.
    pub fn parse(raw: &str) -> Option<Self> {
        Self::from_id(raw.trim())
    }

    fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|p| p.as_str() == id)
    }

    /// The static `config/providers.json` metadata of this provider.
    pub fn spec(&self) -> &'static ProviderSpec {
        provider_spec(*self)
    }

    /// Providers supporting user-defined custom model IDs (`src/shared/customModels.ts`).
    pub fn supports_custom_model_ids(&self) -> bool {
        !matches!(self, Self::Lmstudio | Self::CodexCli)
    }

    /// Providers supporting enabled/disabled model preferences (`src/shared/modelPreferences.ts`).
    pub fn supports_model_preferences(&self) -> bool {
        !matches!(self, Self::Lmstudio)
    }

    /// Whether the provider is offered to users (`userFacing` in `config/providers.json`).
    pub fn is_user_facing(&self) -> bool {
        self.spec().user_facing
    }

    /// Whether the provider uses runtime discovery as primary model catalog (`lmstudio`).
    pub fn is_runtime_discovery_provider(&self) -> bool {
        self.spec().discovery == ProviderDiscoveryMode::Local
    }
}

impl Serialize for ProviderName {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for ProviderName {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        static IDS: LazyLock<Vec<&'static str>> =
            LazyLock::new(|| ProviderName::ALL.iter().map(ProviderName::as_str).collect());
        let raw = std::borrow::Cow::<'de, str>::deserialize(deserializer)?;
        Self::from_id(&raw).ok_or_else(|| serde::de::Error::unknown_variant(&raw, &IDS))
    }
}

impl fmt::Display for ProviderName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

pub fn resolve_provider_name(value: Option<&serde_json::Value>) -> Option<ProviderName> {
    value?.as_str().and_then(ProviderName::parse)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RuntimeName {
    #[serde(rename = "pi")]
    Pi,
    #[serde(rename = "openai-responses")]
    OpenaiResponses,
    #[serde(rename = "google-interactions")]
    GoogleInteractions,
    #[serde(rename = "codex-app-server")]
    CodexAppServer,
}

impl RuntimeName {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim() {
            "pi" => Some(Self::Pi),
            "openai-responses" => Some(Self::OpenaiResponses),
            "google-interactions" => Some(Self::GoogleInteractions),
            "codex-app-server" => Some(Self::CodexAppServer),
            _ => None,
        }
    }
}

/// The runtime a provider's wire protocol pins, if any (Codex app-server, OpenAI Responses,
/// Gemini Interactions); every other protocol runs on the generic `pi` runtime.
fn pinned_runtime_name(provider: ProviderName) -> Option<RuntimeName> {
    match provider.spec().transport {
        ProviderWireProtocol::CodexAppServer => Some(RuntimeName::CodexAppServer),
        ProviderWireProtocol::OpenaiResponses => Some(RuntimeName::OpenaiResponses),
        ProviderWireProtocol::GeminiInteractions => Some(RuntimeName::GoogleInteractions),
        ProviderWireProtocol::ChatCompletions
        | ProviderWireProtocol::AnthropicMessages
        | ProviderWireProtocol::BedrockConverse => None,
    }
}

pub fn default_runtime_name_for_provider(provider: ProviderName) -> RuntimeName {
    pinned_runtime_name(provider).unwrap_or(RuntimeName::Pi)
}

pub fn normalize_runtime_name_for_provider(
    provider: ProviderName,
    runtime: Option<RuntimeName>,
) -> RuntimeName {
    match pinned_runtime_name(provider) {
        Some(pinned) => pinned,
        None => match runtime {
            Some(
                RuntimeName::OpenaiResponses
                | RuntimeName::GoogleInteractions
                | RuntimeName::CodexAppServer,
            )
            | None => default_runtime_name_for_provider(provider),
            Some(rt) => rt,
        },
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum SandboxMode {
    Auto,
    ReadOnly,
    #[default]
    WorkspaceWrite,
    DangerFullAccess,
}

impl SandboxMode {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim() {
            "auto" => Some(Self::Auto),
            "read-only" => Some(Self::ReadOnly),
            "workspace-write" => Some(Self::WorkspaceWrite),
            "danger-full-access" => Some(Self::DangerFullAccess),
            _ => None,
        }
    }
}

/// Shell sandbox settings. `network` and `requireBackend` are optional in the TS
/// `SandboxConfig` (and in the `sandbox_json` persistence schema), so a stored policy such as
/// `{"mode":"read-only"}` deserializes with the TS defaults rather than failing: a missing
/// `network` is enabled (`resolveSandboxPolicy`: `config.network ?? true`) and a missing
/// `requireBackend` is off (`DEFAULT_SANDBOX_CONFIG`), matching `merge::resolve_sandbox_config`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxConfig {
    pub mode: SandboxMode,
    #[serde(default = "default_sandbox_network")]
    pub network: bool,
    #[serde(default)]
    pub require_backend: bool,
}

fn default_sandbox_network() -> bool {
    SandboxConfig::default().network
}

impl Default for SandboxConfig {
    fn default() -> Self {
        Self {
            mode: SandboxMode::WorkspaceWrite,
            network: true,
            require_backend: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum ChildModelRoutingMode {
    #[default]
    SameProvider,
    CrossProviderAllowlist,
}

impl ChildModelRoutingMode {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim() {
            "same-provider" => Some(Self::SameProvider),
            "cross-provider-allowlist" => Some(Self::CrossProviderAllowlist),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SkillImprovementScope {
    #[default]
    User,
    All,
}

impl SkillImprovementScope {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "user" => Some(Self::User),
            "all" => Some(Self::All),
            _ => None,
        }
    }
}

#[cfg(test)]
mod sandbox_config_tests {
    use super::*;

    #[test]
    fn missing_optional_sandbox_fields_take_ts_defaults() {
        let ro: SandboxConfig = serde_json::from_str(r#"{"mode":"read-only"}"#).unwrap();
        assert_eq!(
            ro,
            SandboxConfig {
                mode: SandboxMode::ReadOnly,
                network: true,
                require_backend: false,
            }
        );
        let ww: SandboxConfig =
            serde_json::from_str(r#"{"mode":"workspace-write","network":false}"#).unwrap();
        assert_eq!(
            ww,
            SandboxConfig {
                mode: SandboxMode::WorkspaceWrite,
                network: false,
                require_backend: false,
            }
        );
        // `mode` stays required, like the TS persistence schema.
        assert!(serde_json::from_str::<SandboxConfig>(r#"{"network":false}"#).is_err());
    }
}
