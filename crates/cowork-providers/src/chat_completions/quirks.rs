use cowork_config::{ProviderName, ProviderWireProtocol};
use cowork_inference::InferenceModelRegistry;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

const OPENCODE_GO_MODELS: &[&str] = &[
    // Current public Go catalog.
    "deepseek-v4.1-flash",
    "deepseek-v4-pro",
    "glm-5.3",
    "grok-4.7",
    "muse-spark-1.2-contributor",
    "muse-spark-1.3-contributor",
    "glm-5.3-flash",
    "gpt-5.6-luna",
    "gpt-6-luna",
    "claude-haiku-5-5",
    "hy3",
    "hy4-preview",
    "kimi-k2.7-code",
    "kimi-k3",
    "mimo-v2.6-flash",
    "mimo-v2.6-pro",
    "minimax-m3",
    "minimax-m3.1-flash",
    "longcat-2.0",
    "step-5-preview",
    "beam-free",
    "qwen3.8-max",
    "qwen3.8-flash",
    "qwen3.7-plus",
    "kimi-k3.1-pro",
    "iceman-contributor-free",
    "gemini-4-argon",
    "hy4",
    "longcat-2.5-free",
    "hy4-flash-free",
    "qwen4-max",
    // Preserved legacy registry entries.
    "mimo-v2-pro",
    "qwen3.5-plus",
    "mimo-v2-omni",
    "mimo-v2.5-pro",
    "minimax-m2.5",
    "kimi-k2.6",
    "glm-5.1",
    "glm-5",
    "mimo-v2.5",
    "hy3-preview",
    "deepseek-v4-flash",
    "minimax-m2.7",
    "kimi-k2.5",
    "qwen3.7-max",
    "qwen3.6-plus",
];

const OPENCODE_ZEN_MODELS: &[&str] = &[
    "claude-fable-5-2",
    "claude-fable-5-1",
    "claude-fable-5",
    "claude-opus-5-5",
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-opus-4-5",
    "claude-opus-4-1",
    "claude-sonnet-5-5",
    "claude-sonnet-5",
    "claude-sonnet-4-6",
    "claude-sonnet-4-5",
    "claude-sonnet-4",
    "claude-haiku-5-5",
    "claude-haiku-4-5",
    "gemini-4-argon",
    "gemini-4-carbon",
    "gemini-4-hydrogen",
    "gemini-4-neon",
    "gemini-3.8-flash",
    "gemini-3.7-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.1-pro",
    "gemini-3-flash",
    "gpt-6.2-astra",
    "gpt-6.2-sol",
    "gpt-6.1-sol",
    "gpt-6-astra",
    "gpt-6-sol",
    "gpt-6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-5.5-pro",
    "gpt-5.4",
    "gpt-5.4-pro",
    "gpt-5.4-mini",
    "gpt-5.4-nano",
    "gpt-5.3-codex-spark",
    "gpt-5.3-codex",
    "gpt-5.2",
    "gpt-5.2-codex",
    "gpt-5.1",
    "gpt-5.1-codex-max",
    "gpt-5.1-codex",
    "gpt-5.1-codex-mini",
    "gpt-5",
    "gpt-5-codex",
    "gpt-5-nano",
    "grok-4.7",
    "grok-4.6",
    "grok-4.5",
    "grok-build-0.1",
    "deepseek-v4-pro",
    "deepseek-v4.1-flash",
    "deepseek-v4-flash",
    "glm-5.3",
    "glm-5.3-flash",
    "glm-5.1",
    "glm-5",
    "minimax-m3",
    "minimax-m2.7",
    "minimax-m2.5",
    "kimi-k3",
    "kimi-k2.7-code",
    "kimi-k2.6",
    "kimi-k2.5",
    "mistral-large-4",
    "muse-spark-1.3",
    "muse-spark-1.2",
    "muse-wonder-1.0",
    "muse-ember-1.0",
    "qwen3.8-max",
    "qwen3.8-flash",
    "qwen3.6-plus",
    "qwen3.5-plus",
    "big-pickle",
    "deepseek-v4.1-flash-free",
    "deepseek-v4-flash-free",
    "mimo-v2.6-flash-free",
    "mimo-v2.5-free",
    "qwen3.6-plus-free",
    "minimax-m3-free",
    "nemotron-3-ultra-free",
    "nemotron-3.5-super-vl-free",
    "nemotron-3.5-lightning-free",
    "north-mini-code-free",
    "longcat-2.5-free",
    "iceman-free",
    "beam-free",
    "flint-40b-free",
    "hy4-flash-free",
    "tidepool-alpha-free",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MaxTokensField {
    MaxTokens,
    MaxCompletionTokens,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThinkingFormat {
    OpenAi,
    Together,
    Qwen,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderQuirks {
    pub provider: ProviderName,
    pub default_base_url: &'static str,
    pub env_api_keys: &'static [String],
    pub max_tokens_field: MaxTokensField,
    pub thinking_format: ThinkingFormat,
    pub supports_store: bool,
    pub supports_developer_role: bool,
    pub supports_reasoning_effort: bool,
    pub split_inline_think_tags: bool,
    pub fireworks_schema_budget: bool,
    pub nvidia_payload_normalization: bool,
    pub is_user_facing_enabled: bool,
    pub is_public_catalog: bool,
    pub discovery_auth_prefix: &'static str,
}

impl ProviderQuirks {
    /// Quirks for a `chat-completions` provider: endpoint, API-key env vars and user-facing state
    /// come from `config/providers.json`; behavioural flags default to plain OpenAI Chat
    /// Completions and are overridden per provider below. `None` for other wire protocols.
    pub fn for_provider(provider: ProviderName) -> Option<Self> {
        let spec = provider.spec();
        if spec.transport != ProviderWireProtocol::ChatCompletions {
            return None;
        }
        let mut quirks = Self {
            provider,
            default_base_url: spec.inference_base_url.as_deref()?,
            env_api_keys: &spec.api_key_env_vars,
            max_tokens_field: MaxTokensField::MaxTokens,
            thinking_format: ThinkingFormat::OpenAi,
            supports_store: false,
            supports_developer_role: false,
            supports_reasoning_effort: false,
            split_inline_think_tags: false,
            fireworks_schema_budget: false,
            nvidia_payload_normalization: false,
            is_user_facing_enabled: spec.user_facing,
            is_public_catalog: false,
            discovery_auth_prefix: "Bearer",
        };
        match provider {
            ProviderName::Together => {
                quirks.thinking_format = ThinkingFormat::Together;
                quirks.supports_reasoning_effort = true;
            }
            ProviderName::Fireworks | ProviderName::Firepass => {
                quirks.supports_reasoning_effort = true;
                quirks.fireworks_schema_budget = true;
            }
            ProviderName::Nvidia => {
                quirks.thinking_format = ThinkingFormat::Qwen;
                quirks.nvidia_payload_normalization = true;
            }
            ProviderName::Minimax => {
                quirks.max_tokens_field = MaxTokensField::MaxCompletionTokens;
                quirks.supports_reasoning_effort = true;
                quirks.split_inline_think_tags = true;
            }
            ProviderName::Lmstudio => {
                quirks.split_inline_think_tags = true;
                quirks.is_public_catalog = true;
            }
            ProviderName::OpencodeGo | ProviderName::OpencodeZen => {
                quirks.max_tokens_field = MaxTokensField::MaxCompletionTokens;
                quirks.supports_reasoning_effort = true;
                quirks.split_inline_think_tags = true;
                quirks.is_public_catalog = true;
            }
            ProviderName::Baseten => {
                quirks.supports_reasoning_effort = true;
                quirks.discovery_auth_prefix = "Bearer";
            }
            _ => {}
        }
        Some(quirks)
    }
}

pub fn is_user_facing_provider_enabled(provider: ProviderName) -> bool {
    provider.is_user_facing()
}

pub fn is_opencode_model_supported(
    provider: ProviderName,
    model_id: &str,
    registry: &InferenceModelRegistry,
) -> bool {
    let trimmed = model_id.trim();
    if trimmed.is_empty() {
        return false;
    }
    match provider {
        ProviderName::OpencodeGo => {
            OPENCODE_GO_MODELS.contains(&trimmed) || registry.get(provider, trimmed).is_some()
        }
        ProviderName::OpencodeZen => {
            OPENCODE_ZEN_MODELS.contains(&trimmed) || registry.get(provider, trimmed).is_some()
        }
        _ => false,
    }
}

pub fn normalize_nvidia_chat_completions_body(payload: Value) -> Value {
    let Value::Object(mut obj) = payload else {
        return payload;
    };
    for forbidden in ["store", "max_completion_tokens", "enable_thinking"] {
        obj.remove(forbidden);
    }
    let model = obj
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let uses_enable_thinking = matches!(
        model.as_str(),
        "nvidia/nemotron-3-super-120b-a12b"
            | "nvidia/nemotron-3-ultra-550b-a55b"
            | "nvidia/nemotron-3.5-lightning-30b-a3b"
            | "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning"
    );
    let force_nonempty_content = matches!(
        model.as_str(),
        "nvidia/nemotron-3-super-120b-a12b" | "nvidia/nemotron-3-ultra-550b-a55b"
    ) && obj.contains_key("tools");
    let has_reasoning_effort = obj.contains_key("reasoning_effort");

    if (uses_enable_thinking && !has_reasoning_effort) || force_nonempty_content {
        let mut kwargs = match obj.remove("chat_template_kwargs") {
            Some(Value::Object(existing)) => existing,
            _ => Map::new(),
        };
        if uses_enable_thinking && !has_reasoning_effort {
            kwargs.insert("enable_thinking".to_string(), Value::Bool(true));
        }
        if force_nonempty_content {
            kwargs.insert("force_nonempty_content".to_string(), Value::Bool(true));
        }
        obj.insert("chat_template_kwargs".to_string(), Value::Object(kwargs));
    }
    Value::Object(obj)
}

fn schema_allows_null(prop_schema: &Value) -> bool {
    let Some(obj) = prop_schema.as_object() else {
        return false;
    };
    match obj.get("type") {
        Some(Value::String(s)) if s == "null" => return true,
        Some(Value::Array(arr)) if arr.iter().any(|v| v.as_str() == Some("null")) => return true,
        _ => {}
    }
    for union_key in ["anyOf", "oneOf"] {
        if let Some(Value::Array(variants)) = obj.get(union_key)
            && variants.iter().any(schema_allows_null)
        {
            return true;
        }
    }
    false
}

/// Strips `null` values on optional, non-nullable tool arguments so open-weights models that emit
/// `"limit": null` for omitted optional parameters fall back cleanly to tool defaults.
pub fn normalize_null_tool_arguments(
    arguments: &Map<String, Value>,
    schema: &Value,
) -> Map<String, Value> {
    let properties = schema.get("properties").and_then(Value::as_object);
    let required: Vec<&str> = schema
        .get("required")
        .and_then(Value::as_array)
        .map(|arr| arr.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();

    let mut out = Map::new();
    for (key, value) in arguments {
        let prop_schema = properties.and_then(|p| p.get(key));
        if value.is_null() {
            let is_required = required.contains(&key.as_str());
            let nullable = prop_schema.is_some_and(schema_allows_null);
            if !is_required && !nullable {
                continue;
            }
            out.insert(key.clone(), Value::Null);
            continue;
        }
        if let (Value::Object(nested_args), Some(nested_schema)) = (value, prop_schema) {
            out.insert(
                key.clone(),
                Value::Object(normalize_null_tool_arguments(nested_args, nested_schema)),
            );
        } else {
            out.insert(key.clone(), value.clone());
        }
    }
    out
}
