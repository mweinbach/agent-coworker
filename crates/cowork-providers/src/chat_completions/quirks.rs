use cowork_config::ProviderName;
use cowork_inference::InferenceModelRegistry;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const USER_FACING_DISABLED_PROVIDERS: [ProviderName; 1] = [ProviderName::Baseten];

const OPENCODE_GO_MODELS: &[&str] = &[
    "minimax-m3",
    "minimax-m2.7",
    "minimax-m2.5",
    "kimi-k2.6",
    "kimi-k2.5",
    "glm-5.1",
    "glm-5",
    "deepseek-v4-pro",
    "deepseek-v4-flash",
    "qwen3.7-max",
    "qwen3.7-plus",
    "qwen3.6-plus",
    "qwen3.5-plus",
    "mimo-v2-pro",
    "mimo-v2-omni",
    "mimo-v2.5-pro",
    "mimo-v2.5",
    "hy3-preview",
];

const OPENCODE_ZEN_MODELS: &[&str] = &[
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-opus-4-5",
    "claude-opus-4-1",
    "claude-sonnet-4-6",
    "claude-sonnet-4-5",
    "claude-sonnet-4",
    "claude-haiku-4-5",
    "gemini-3.5-flash",
    "gemini-3.1-pro",
    "gemini-3-flash",
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
    "grok-build-0.1",
    "deepseek-v4-flash",
    "glm-5.1",
    "glm-5",
    "minimax-m2.7",
    "minimax-m2.5",
    "kimi-k2.6",
    "kimi-k2.5",
    "qwen3.6-plus",
    "qwen3.5-plus",
    "big-pickle",
    "deepseek-v4-flash-free",
    "mimo-v2.5-free",
    "qwen3.6-plus-free",
    "minimax-m3-free",
    "nemotron-3-ultra-free",
    "north-mini-code-free",
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
    pub env_api_keys: &'static [&'static str],
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
    pub fn for_provider(provider: ProviderName) -> Option<Self> {
        match provider {
            ProviderName::Together => Some(Self {
                provider,
                default_base_url: "https://api.together.xyz/v1",
                env_api_keys: &["TOGETHER_API_KEY"],
                max_tokens_field: MaxTokensField::MaxTokens,
                thinking_format: ThinkingFormat::Together,
                supports_store: false,
                supports_developer_role: false,
                supports_reasoning_effort: false,
                split_inline_think_tags: false,
                fireworks_schema_budget: false,
                nvidia_payload_normalization: false,
                is_user_facing_enabled: true,
                is_public_catalog: false,
                discovery_auth_prefix: "Bearer",
            }),
            ProviderName::Fireworks => Some(Self {
                provider,
                default_base_url: "https://api.fireworks.ai/inference/v1",
                env_api_keys: &["FIREWORKS_API_KEY"],
                max_tokens_field: MaxTokensField::MaxTokens,
                thinking_format: ThinkingFormat::OpenAi,
                supports_store: false,
                supports_developer_role: false,
                supports_reasoning_effort: true,
                split_inline_think_tags: false,
                fireworks_schema_budget: true,
                nvidia_payload_normalization: false,
                is_user_facing_enabled: true,
                is_public_catalog: false,
                discovery_auth_prefix: "Bearer",
            }),
            ProviderName::Firepass => Some(Self {
                provider,
                default_base_url: "https://api.fireworks.ai/inference/v1",
                env_api_keys: &["FIREPASS_API_KEY"],
                max_tokens_field: MaxTokensField::MaxTokens,
                thinking_format: ThinkingFormat::OpenAi,
                supports_store: false,
                supports_developer_role: false,
                supports_reasoning_effort: true,
                split_inline_think_tags: false,
                fireworks_schema_budget: true,
                nvidia_payload_normalization: false,
                is_user_facing_enabled: true,
                is_public_catalog: false,
                discovery_auth_prefix: "Bearer",
            }),
            ProviderName::Nvidia => Some(Self {
                provider,
                default_base_url: "https://integrate.api.nvidia.com/v1",
                env_api_keys: &["NVIDIA_API_KEY"],
                max_tokens_field: MaxTokensField::MaxTokens,
                thinking_format: ThinkingFormat::Qwen,
                supports_store: false,
                supports_developer_role: false,
                supports_reasoning_effort: false,
                split_inline_think_tags: false,
                fireworks_schema_budget: false,
                nvidia_payload_normalization: true,
                is_user_facing_enabled: true,
                is_public_catalog: false,
                discovery_auth_prefix: "Bearer",
            }),
            ProviderName::Minimax => Some(Self {
                provider,
                default_base_url: "https://api.minimax.io/v1",
                env_api_keys: &["MINIMAX_API_KEY"],
                max_tokens_field: MaxTokensField::MaxCompletionTokens,
                thinking_format: ThinkingFormat::OpenAi,
                supports_store: false,
                supports_developer_role: false,
                supports_reasoning_effort: false,
                split_inline_think_tags: true,
                fireworks_schema_budget: false,
                nvidia_payload_normalization: false,
                is_user_facing_enabled: true,
                is_public_catalog: false,
                discovery_auth_prefix: "Bearer",
            }),
            ProviderName::Lmstudio => Some(Self {
                provider,
                default_base_url: "http://localhost:1234/v1",
                env_api_keys: &["LM_STUDIO_API_KEY", "LM_STUDIO_API_TOKEN"],
                max_tokens_field: MaxTokensField::MaxTokens,
                thinking_format: ThinkingFormat::OpenAi,
                supports_store: false,
                supports_developer_role: false,
                supports_reasoning_effort: true,
                split_inline_think_tags: true,
                fireworks_schema_budget: false,
                nvidia_payload_normalization: false,
                is_user_facing_enabled: true,
                is_public_catalog: true,
                discovery_auth_prefix: "Bearer",
            }),
            ProviderName::OpencodeGo => Some(Self {
                provider,
                default_base_url: "https://opencode.ai/zen/go/v1",
                env_api_keys: &["OPENCODE_GO_API_KEY"],
                max_tokens_field: MaxTokensField::MaxCompletionTokens,
                thinking_format: ThinkingFormat::OpenAi,
                supports_store: false,
                supports_developer_role: false,
                supports_reasoning_effort: true,
                split_inline_think_tags: true,
                fireworks_schema_budget: false,
                nvidia_payload_normalization: false,
                is_user_facing_enabled: true,
                is_public_catalog: true,
                discovery_auth_prefix: "Bearer",
            }),
            ProviderName::OpencodeZen => Some(Self {
                provider,
                default_base_url: "https://opencode.ai/zen/v1",
                env_api_keys: &["OPENCODE_ZEN_API_KEY"],
                max_tokens_field: MaxTokensField::MaxCompletionTokens,
                thinking_format: ThinkingFormat::OpenAi,
                supports_store: false,
                supports_developer_role: false,
                supports_reasoning_effort: true,
                split_inline_think_tags: true,
                fireworks_schema_budget: false,
                nvidia_payload_normalization: false,
                is_user_facing_enabled: true,
                is_public_catalog: true,
                discovery_auth_prefix: "Bearer",
            }),
            ProviderName::Baseten => Some(Self {
                provider,
                default_base_url: "https://inference.baseten.co/v1",
                env_api_keys: &["BASETEN_API_KEY"],
                max_tokens_field: MaxTokensField::MaxTokens,
                thinking_format: ThinkingFormat::OpenAi,
                supports_store: false,
                supports_developer_role: false,
                supports_reasoning_effort: false,
                split_inline_think_tags: false,
                fireworks_schema_budget: false,
                nvidia_payload_normalization: false,
                is_user_facing_enabled: false,
                is_public_catalog: false,
                discovery_auth_prefix: "Api-Key",
            }),
            _ => None,
        }
    }
}

pub fn is_user_facing_provider_enabled(provider: ProviderName) -> bool {
    !USER_FACING_DISABLED_PROVIDERS.contains(&provider)
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
    for forbidden in [
        "store",
        "max_tokens",
        "max_completion_tokens",
        "reasoning_budget",
        "reasoning_effort",
        "enable_thinking",
    ] {
        obj.remove(forbidden);
    }
    let mut kwargs = match obj.remove("chat_template_kwargs") {
        Some(Value::Object(existing)) => existing,
        _ => Map::new(),
    };
    kwargs.insert("enable_thinking".to_string(), Value::Bool(true));
    obj.insert("chat_template_kwargs".to_string(), Value::Object(kwargs));
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
