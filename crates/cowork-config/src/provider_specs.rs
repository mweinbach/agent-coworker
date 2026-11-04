//! Static per-provider metadata loaded from `config/providers.json`, the single source of truth
//! for provider identity, display names, wire transport, discovery mode, API-key environment
//! variables, default endpoints, default/title models and static auth methods.
//!
//! Behavioural per-provider logic (Chat Completions quirks, reasoning tables, Bedrock/Codex/LM
//! Studio auth and discovery) stays in code; everything here is plain data so an OpenAI-compatible
//! provider is added with one `providers.json` entry plus its `config/models/<provider>/` files.

use std::sync::LazyLock;

use serde::{Deserialize, Serialize};

use crate::providers::ProviderName;

const PROVIDERS_JSON: &str = include_str!("../../../config/providers.json");

/// Native wire protocol a provider speaks (`transport` in `config/providers.json`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderWireProtocol {
    ChatCompletions,
    OpenaiResponses,
    AnthropicMessages,
    GeminiInteractions,
    BedrockConverse,
    CodexAppServer,
}

/// How a provider's model catalog is discovered (`discovery` in `config/providers.json`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderDiscoveryMode {
    /// Generic HTTP model-list discovery against `discoveryBaseUrl` with an API key.
    Api,
    /// Bundled registry plus provider-specific discovery implemented in code (Bedrock, Codex).
    Static,
    /// Local runtime discovery with no bundled registry (LM Studio).
    Local,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAuthMethodField {
    pub id: String,
    pub label: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAuthMethod {
    pub id: String,
    #[serde(rename = "type")]
    pub method_type: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oauth_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fields: Option<Vec<ProviderAuthMethodField>>,
}

/// One `config/providers.json` entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderSpec {
    pub id: String,
    pub display_name: String,
    /// Name used in system-prompt copy when it differs from `display_name`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_display_name: Option<String>,
    pub transport: ProviderWireProtocol,
    pub user_facing: bool,
    pub discovery: ProviderDiscoveryMode,
    /// Ambient API-key environment variables, in lookup order.
    pub api_key_env_vars: Vec<String>,
    pub inference_base_url: Option<String>,
    pub discovery_base_url: Option<String>,
    pub default_model: String,
    pub title_model: Option<String>,
    pub auth_methods: Vec<ProviderAuthMethod>,
}

impl ProviderSpec {
    /// Display name for system-prompt copy (`promptDisplayName`, else `displayName`).
    pub fn prompt_display_name(&self) -> &str {
        self.prompt_display_name
            .as_deref()
            .unwrap_or(&self.display_name)
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProviderSpecFile {
    providers: Vec<ProviderSpec>,
}

static PROVIDER_SPECS: LazyLock<Vec<ProviderSpec>> = LazyLock::new(|| {
    let file: ProviderSpecFile =
        serde_json::from_str(PROVIDERS_JSON).expect("config/providers.json must be valid");
    assert_eq!(
        file.providers.len(),
        ProviderName::ALL.len(),
        "config/providers.json must list exactly the ProviderName::ALL providers"
    );
    file.providers
});

/// Every provider spec, in canonical `ProviderName::ALL` order.
pub fn provider_specs() -> &'static [ProviderSpec] {
    &PROVIDER_SPECS
}

/// The static spec of `provider`.
pub fn provider_spec(provider: ProviderName) -> &'static ProviderSpec {
    &PROVIDER_SPECS[provider as usize]
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::path::Path;

    use super::*;

    fn repo_root() -> &'static Path {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(Path::parent)
            .expect("workspace root")
    }

    #[test]
    fn spec_ids_match_provider_enum_in_canonical_order() {
        let spec_ids: Vec<&str> = provider_specs().iter().map(|s| s.id.as_str()).collect();
        let enum_ids: Vec<&str> = ProviderName::ALL.iter().map(ProviderName::as_str).collect();
        assert_eq!(spec_ids, enum_ids);
        for (index, provider) in ProviderName::ALL.into_iter().enumerate() {
            assert_eq!(
                provider as usize, index,
                "ALL must follow declaration order"
            );
            assert_eq!(provider_spec(provider).id, spec_ids[index]);
            assert_eq!(ProviderName::parse(provider.as_str()), Some(provider));
            let json = serde_json::to_value(provider).unwrap();
            assert_eq!(json, serde_json::Value::String(provider.as_str().into()));
            assert_eq!(
                serde_json::from_value::<ProviderName>(json).unwrap(),
                provider
            );
        }
        assert_eq!(ProviderName::parse("unknown"), None);
    }

    #[test]
    fn every_transport_string_is_known() {
        let raw: serde_json::Value = serde_json::from_str(PROVIDERS_JSON).unwrap();
        let known = [
            "chat-completions",
            "openai-responses",
            "anthropic-messages",
            "gemini-interactions",
            "bedrock-converse",
            "codex-app-server",
        ];
        for entry in raw["providers"].as_array().unwrap() {
            let transport = entry["transport"].as_str().unwrap();
            assert!(known.contains(&transport), "unknown transport {transport}");
        }
    }

    #[test]
    fn default_and_title_models_exist_in_the_bundled_registry() {
        for spec in provider_specs() {
            let dir = repo_root().join("config").join("models").join(&spec.id);
            if !dir.is_dir() {
                assert_eq!(
                    spec.discovery,
                    ProviderDiscoveryMode::Local,
                    "{} has no config/models directory",
                    spec.id
                );
                continue;
            }
            let ids: HashSet<String> = std::fs::read_dir(&dir)
                .unwrap()
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("json"))
                .filter_map(|p| std::fs::read_to_string(p).ok())
                .filter_map(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
                .filter_map(|v| v.get("id").and_then(|id| id.as_str()).map(str::to_owned))
                .collect();
            assert!(
                ids.contains(&spec.default_model),
                "{}: defaultModel {} missing from config/models",
                spec.id,
                spec.default_model
            );
            if let Some(title) = &spec.title_model {
                assert!(
                    ids.contains(title),
                    "{}: titleModel {title} missing from config/models",
                    spec.id
                );
            }
        }
    }

    #[test]
    fn spec_invariants_hold() {
        for spec in provider_specs() {
            assert!(!spec.display_name.trim().is_empty());
            assert!(
                !spec.auth_methods.is_empty(),
                "{} has no auth methods",
                spec.id
            );
            if spec.discovery == ProviderDiscoveryMode::Api {
                assert!(spec.discovery_base_url.is_some(), "{}", spec.id);
                assert!(!spec.api_key_env_vars.is_empty(), "{}", spec.id);
            }
            if spec.transport == ProviderWireProtocol::ChatCompletions {
                assert!(spec.inference_base_url.is_some(), "{}", spec.id);
            }
        }
    }

    /// `crates/cowork-protocol/src/ws_jsonrpc_schema.json` is hand-maintained; every provider
    /// enum it carries must list exactly the spec ids in canonical order.
    #[test]
    fn protocol_schema_provider_enums_match_spec_ids() {
        fn walk(value: &serde_json::Value, found: &mut Vec<Vec<String>>) {
            match value {
                serde_json::Value::Object(map) => {
                    if let Some(serde_json::Value::Array(items)) = map.get("enum") {
                        let strings: Vec<String> = items
                            .iter()
                            .filter_map(|v| v.as_str().map(str::to_owned))
                            .collect();
                        if strings.iter().any(|s| s == "codex-cli")
                            && strings.iter().any(|s| s == "anthropic")
                        {
                            found.push(strings);
                        }
                    }
                    map.values().for_each(|v| walk(v, found));
                }
                serde_json::Value::Array(items) => items.iter().for_each(|v| walk(v, found)),
                _ => {}
            }
        }
        let schema = cowork_protocol::export_websocket_jsonrpc_schema();
        let mut found = Vec::new();
        walk(&schema, &mut found);
        assert!(!found.is_empty(), "schema carries no provider enum");
        let spec_ids: Vec<String> = provider_specs().iter().map(|s| s.id.clone()).collect();
        for provider_enum in found {
            assert_eq!(provider_enum, spec_ids);
        }
    }
}
