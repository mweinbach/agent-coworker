use serde::{Deserialize, Serialize};
use std::fmt;

/// All 14 supported inference providers matching `src/types.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum ProviderName {
    #[serde(rename = "google")]
    Google,
    #[serde(rename = "openai")]
    Openai,
    #[serde(rename = "anthropic")]
    Anthropic,
    #[serde(rename = "bedrock")]
    Bedrock,
    #[serde(rename = "baseten")]
    Baseten,
    #[serde(rename = "together")]
    Together,
    #[serde(rename = "fireworks")]
    Fireworks,
    #[serde(rename = "firepass")]
    Firepass,
    #[serde(rename = "nvidia")]
    Nvidia,
    #[serde(rename = "lmstudio")]
    Lmstudio,
    #[serde(rename = "minimax")]
    Minimax,
    #[serde(rename = "opencode-go")]
    OpencodeGo,
    #[serde(rename = "opencode-zen")]
    OpencodeZen,
    #[serde(rename = "codex-cli")]
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

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Google => "google",
            Self::Openai => "openai",
            Self::Anthropic => "anthropic",
            Self::Bedrock => "bedrock",
            Self::Baseten => "baseten",
            Self::Together => "together",
            Self::Fireworks => "fireworks",
            Self::Firepass => "firepass",
            Self::Nvidia => "nvidia",
            Self::Lmstudio => "lmstudio",
            Self::Minimax => "minimax",
            Self::OpencodeGo => "opencode-go",
            Self::OpencodeZen => "opencode-zen",
            Self::CodexCli => "codex-cli",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim() {
            "google" => Some(Self::Google),
            "openai" => Some(Self::Openai),
            "anthropic" => Some(Self::Anthropic),
            "bedrock" => Some(Self::Bedrock),
            "baseten" => Some(Self::Baseten),
            "together" => Some(Self::Together),
            "fireworks" => Some(Self::Fireworks),
            "firepass" => Some(Self::Firepass),
            "nvidia" => Some(Self::Nvidia),
            "lmstudio" => Some(Self::Lmstudio),
            "minimax" => Some(Self::Minimax),
            "opencode-go" => Some(Self::OpencodeGo),
            "opencode-zen" => Some(Self::OpencodeZen),
            "codex-cli" => Some(Self::CodexCli),
            _ => None,
        }
    }

    /// Providers supporting user-defined custom model IDs (`src/shared/customModels.ts`).
    pub fn supports_custom_model_ids(&self) -> bool {
        !matches!(self, Self::Lmstudio | Self::CodexCli)
    }

    /// Providers supporting enabled/disabled model preferences (`src/shared/modelPreferences.ts`).
    pub fn supports_model_preferences(&self) -> bool {
        !matches!(self, Self::Lmstudio)
    }

    /// Whether the provider uses runtime discovery as primary model catalog (`lmstudio`).
    pub fn is_runtime_discovery_provider(&self) -> bool {
        matches!(self, Self::Lmstudio)
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

pub fn default_runtime_name_for_provider(provider: ProviderName) -> RuntimeName {
    match provider {
        ProviderName::CodexCli => RuntimeName::CodexAppServer,
        ProviderName::Openai => RuntimeName::OpenaiResponses,
        ProviderName::Google => RuntimeName::GoogleInteractions,
        _ => RuntimeName::Pi,
    }
}

pub fn normalize_runtime_name_for_provider(
    provider: ProviderName,
    runtime: Option<RuntimeName>,
) -> RuntimeName {
    match provider {
        ProviderName::CodexCli => RuntimeName::CodexAppServer,
        ProviderName::Openai => RuntimeName::OpenaiResponses,
        ProviderName::Google => RuntimeName::GoogleInteractions,
        _ => match runtime {
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxConfig {
    pub mode: SandboxMode,
    pub network: bool,
    pub require_backend: bool,
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
