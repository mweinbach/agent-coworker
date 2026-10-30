use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use chrono::Utc;
use cowork_config::{
    AiCoworkerPaths, CachedModelDiscoveryModel, CachedModelReasoning, ConnectionMode,
    ConnectionStore, CustomModelEntry, ModelDiscoveryCacheFile, ModelDiscoveryResult,
    ModelDiscoverySource, ModelPreferenceEntry, ModelRegistry, ProviderName, SupportedModel,
    get_ai_coworker_paths, is_model_discovery_cache_fresh, read_connection_store,
    read_custom_model_store, read_model_discovery_cache, read_model_preferences_store,
    write_model_discovery_cache,
};
use regex::Regex;
use reqwest::StatusCode;
use reqwest::header::{ACCEPT, AUTHORIZATION, HeaderMap, HeaderValue};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::bedrock::{
    compute_bedrock_auth_fingerprint, discover_bedrock_models, mask_bedrock_field_values,
    resolve_bedrock_auth_config,
};
use crate::chat_completions::{LmStudioControlClient, resolve_lmstudio_options};
use crate::codex_app_server::{
    CodexAppServerClient, list_codex_models, resolve_codex_app_server_status,
};
use crate::sse::build_http_client;

const DEFAULT_DISCOVERY_TIMEOUT_MS: u64 = 10_000;
const GOOGLE_MODEL_LIST_URL: &str = "https://generativelanguage.googleapis.com/v1beta/models";
const ANTHROPIC_MODEL_LIST_URL: &str = "https://api.anthropic.com/v1/models";

pub fn mask_api_key(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    if chars.len() <= 8 {
        return "*".repeat(chars.len().max(4));
    }
    let first4: String = chars[..4].iter().collect();
    let last4: String = chars[chars.len() - 4..].iter().collect();
    format!("{first4}...{last4}")
}

pub fn provider_display_label(provider: ProviderName) -> &'static str {
    match provider {
        ProviderName::Google => "Google",
        ProviderName::Openai => "OpenAI",
        ProviderName::Anthropic => "Anthropic",
        ProviderName::Bedrock => "Amazon Bedrock",
        ProviderName::Baseten => "Baseten",
        ProviderName::Together => "Together AI",
        ProviderName::Fireworks => "Fireworks AI",
        ProviderName::Firepass => "Fire Pass",
        ProviderName::Nvidia => "NVIDIA",
        ProviderName::Lmstudio => "LM Studio",
        ProviderName::Minimax => "MiniMax",
        ProviderName::OpencodeGo => "OpenCode Go",
        ProviderName::OpencodeZen => "OpenCode Zen",
        ProviderName::CodexCli => "Codex",
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAuthMethodField {
    pub id: String,
    pub label: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub required: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secret: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAuthMethod {
    pub id: String,
    #[serde(rename = "type")]
    pub method_type: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oauth_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fields: Option<Vec<ProviderAuthMethodField>>,
}

fn bedrock_region_field(required: bool) -> ProviderAuthMethodField {
    ProviderAuthMethodField {
        id: "region".into(),
        label: "AWS region".into(),
        kind: "text".into(),
        required: required.then_some(true),
        secret: None,
        placeholder: Some("us-east-1".into()),
    }
}

pub fn default_provider_auth_methods_for(provider: ProviderName) -> Vec<ProviderAuthMethod> {
    let simple_api = |id: &str, label: &str| ProviderAuthMethod {
        id: id.into(),
        method_type: "api".into(),
        label: label.into(),
        oauth_mode: None,
        fields: None,
    };

    match provider {
        ProviderName::Google => vec![
            simple_api("api_key", "API key"),
            simple_api("exa_api_key", "Exa API key (web search)"),
            simple_api("parallel_api_key", "Parallel API key (web search)"),
        ],
        ProviderName::Openai
        | ProviderName::Anthropic
        | ProviderName::Baseten
        | ProviderName::Together
        | ProviderName::Fireworks
        | ProviderName::Nvidia
        | ProviderName::Minimax
        | ProviderName::OpencodeGo
        | ProviderName::OpencodeZen => vec![simple_api("api_key", "API key")],
        ProviderName::Firepass => vec![simple_api("api_key", "Fire Pass API key")],
        ProviderName::Lmstudio => vec![simple_api("api_key", "API token (optional)")],
        ProviderName::Bedrock => vec![
            ProviderAuthMethod {
                id: "aws_default".into(),
                method_type: "api".into(),
                label: "AWS default credentials".into(),
                oauth_mode: None,
                fields: Some(vec![bedrock_region_field(false)]),
            },
            ProviderAuthMethod {
                id: "aws_profile".into(),
                method_type: "api".into(),
                label: "AWS profile".into(),
                oauth_mode: None,
                fields: Some(vec![
                    ProviderAuthMethodField {
                        id: "profile".into(),
                        label: "AWS profile".into(),
                        kind: "text".into(),
                        required: Some(true),
                        secret: None,
                        placeholder: Some("default".into()),
                    },
                    bedrock_region_field(false),
                ]),
            },
            ProviderAuthMethod {
                id: "aws_keys".into(),
                method_type: "api".into(),
                label: "AWS access keys".into(),
                oauth_mode: None,
                fields: Some(vec![
                    ProviderAuthMethodField {
                        id: "accessKeyId".into(),
                        label: "Access key ID".into(),
                        kind: "text".into(),
                        required: Some(true),
                        secret: None,
                        placeholder: Some("AKIA...".into()),
                    },
                    ProviderAuthMethodField {
                        id: "secretAccessKey".into(),
                        label: "Secret access key".into(),
                        kind: "password".into(),
                        required: Some(true),
                        secret: Some(true),
                        placeholder: None,
                    },
                    ProviderAuthMethodField {
                        id: "sessionToken".into(),
                        label: "Session token".into(),
                        kind: "password".into(),
                        required: None,
                        secret: Some(true),
                        placeholder: None,
                    },
                    bedrock_region_field(true),
                ]),
            },
            ProviderAuthMethod {
                id: "api_key".into(),
                method_type: "api".into(),
                label: "Bedrock API key".into(),
                oauth_mode: None,
                fields: Some(vec![
                    ProviderAuthMethodField {
                        id: "apiKey".into(),
                        label: "Bedrock API key".into(),
                        kind: "password".into(),
                        required: Some(true),
                        secret: Some(true),
                        placeholder: None,
                    },
                    bedrock_region_field(true),
                ]),
            },
        ],
        ProviderName::CodexCli => vec![ProviderAuthMethod {
            id: "oauth_cli".into(),
            method_type: "oauth".into(),
            label: "Sign in with ChatGPT (browser)".into(),
            oauth_mode: Some("auto".into()),
            fields: None,
        }],
    }
}

pub fn default_provider_auth_methods() -> Map<String, Value> {
    let mut out = Map::new();
    for provider in ProviderName::ALL {
        let methods = default_provider_auth_methods_for(provider);
        out.insert(
            provider.as_str().to_string(),
            serde_json::to_value(methods).unwrap_or_else(|_| Value::Array(Vec::new())),
        );
    }
    out
}

pub fn resolve_provider_auth_method(
    provider: ProviderName,
    method_id: &str,
) -> Option<ProviderAuthMethod> {
    let trimmed = method_id.trim();
    default_provider_auth_methods_for(provider)
        .into_iter()
        .find(|m| m.id == trimmed)
}

pub fn validate_structured_provider_config(
    provider: ProviderName,
    method: &ProviderAuthMethod,
    values: &HashMap<String, String>,
) -> Result<HashMap<String, String>, String> {
    let fields = method.fields.as_deref().unwrap_or(&[]);
    let allowed: HashSet<&str> = fields.iter().map(|f| f.id.as_str()).collect();
    let mut normalized = HashMap::new();
    for (raw_k, raw_v) in values {
        let k = raw_k.trim();
        if k.is_empty() || (!allowed.is_empty() && !allowed.contains(k)) {
            continue;
        }
        normalized.insert(k.to_string(), raw_v.trim().to_string());
    }

    for field in fields {
        if field.required == Some(true)
            && normalized
                .get(&field.id)
                .is_none_or(|v| v.trim().is_empty())
        {
            return Err(format!("{} is required.", field.label));
        }
    }

    if provider == ProviderName::Bedrock {
        let non_empty = |k: &str| normalized.get(k).is_some_and(|v| !v.trim().is_empty());
        match method.id.as_str() {
            "aws_default" => {}
            "aws_profile" => {
                if !non_empty("profile") {
                    return Err("AWS profile is required.".into());
                }
            }
            "aws_keys" => {
                if !non_empty("accessKeyId") {
                    return Err("Access key ID is required.".into());
                }
                if !non_empty("secretAccessKey") {
                    return Err("Secret access key is required.".into());
                }
                if !non_empty("region") {
                    return Err("AWS region is required.".into());
                }
            }
            "api_key" => {
                if !non_empty("apiKey") {
                    return Err("Bedrock API key is required.".into());
                }
                if !non_empty("region") {
                    return Err("AWS region is required.".into());
                }
            }
            _ => {}
        }
    }

    Ok(normalized)
}

pub fn stored_provider_api_key(store: &ConnectionStore, provider: ProviderName) -> Option<String> {
    let entry = store.services.get(&provider)?;
    if entry.mode != ConnectionMode::ApiKey {
        return None;
    }
    entry
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
}

fn env_non_empty<'a>(env: &'a HashMap<String, String>, key: &str) -> Option<&'a str> {
    env.get(key)
        .map(String::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

pub fn is_api_discovery_provider(provider: ProviderName) -> bool {
    matches!(
        provider,
        ProviderName::Openai
            | ProviderName::Anthropic
            | ProviderName::Google
            | ProviderName::Baseten
            | ProviderName::Together
            | ProviderName::Fireworks
            | ProviderName::Firepass
            | ProviderName::Nvidia
            | ProviderName::Minimax
            | ProviderName::OpencodeGo
            | ProviderName::OpencodeZen
    )
}

pub fn resolve_provider_api_key(
    provider: ProviderName,
    store: Option<&ConnectionStore>,
    env: &HashMap<String, String>,
) -> Option<String> {
    if let Some(st) = store
        && let Some(saved) = stored_provider_api_key(st, provider)
    {
        return Some(saved);
    }

    let from_env = match provider {
        ProviderName::Openai => env_non_empty(env, "OPENAI_API_KEY"),
        ProviderName::Anthropic => env_non_empty(env, "ANTHROPIC_API_KEY")
            .or_else(|| env_non_empty(env, "ANTHROPIC_OAUTH_TOKEN")),
        ProviderName::Google => env_non_empty(env, "GOOGLE_GENERATIVE_AI_API_KEY")
            .or_else(|| env_non_empty(env, "GEMINI_API_KEY"))
            .or_else(|| env_non_empty(env, "GOOGLE_API_KEY")),
        ProviderName::Baseten => env_non_empty(env, "BASETEN_API_KEY"),
        ProviderName::Together => env_non_empty(env, "TOGETHER_API_KEY"),
        ProviderName::Fireworks => env_non_empty(env, "FIREWORKS_API_KEY"),
        ProviderName::Firepass => env_non_empty(env, "FIREPASS_API_KEY"),
        ProviderName::Nvidia => env_non_empty(env, "NVIDIA_API_KEY"),
        ProviderName::Minimax => env_non_empty(env, "MINIMAX_API_KEY"),
        ProviderName::OpencodeGo => env_non_empty(env, "OPENCODE_API_KEY"),
        ProviderName::OpencodeZen => env_non_empty(env, "OPENCODE_ZEN_API_KEY"),
        ProviderName::Lmstudio => env_non_empty(env, "LM_STUDIO_API_KEY")
            .or_else(|| env_non_empty(env, "LM_STUDIO_API_TOKEN")),
        ProviderName::Bedrock | ProviderName::CodexCli => None,
    };

    from_env.map(ToOwned::to_owned)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCatalogReasoning {
    pub default_effort: String,
    pub available_efforts: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCatalogModelEntry {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub knowledge_cutoff: String,
    pub supports_image_input: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<ProviderCatalogReasoning>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_options: Option<Map<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_overrides: Option<Map<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCatalogEntry {
    pub id: ProviderName,
    pub name: String,
    pub models: Vec<ProviderCatalogModelEntry>,
    pub default_model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCatalogPayload {
    pub all: Vec<ProviderCatalogEntry>,
    pub default: BTreeMap<String, String>,
    pub connected: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct CatalogBuildOptions {
    pub homedir: PathBuf,
    pub env: HashMap<String, String>,
    pub provider_options: Option<Map<String, Value>>,
    pub refresh: bool,
    pub discovery_timeout_ms: Option<u64>,
    pub base_url_overrides: HashMap<ProviderName, String>,
}

fn default_builtin_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn load_builtin_models_for(built_in_dir: &Path, provider: ProviderName) -> Vec<SupportedModel> {
    let dir = built_in_dir
        .join("config")
        .join("models")
        .join(provider.as_str());
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for entry in rd.flatten() {
            let p = entry.path();
            if p.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            if let Ok(raw) = std::fs::read_to_string(&p)
                && let Ok(m) = serde_json::from_str::<SupportedModel>(&raw)
            {
                out.push(m);
            }
        }
    }
    out.sort_by(|a, b| {
        b.is_default
            .cmp(&a.is_default)
            .then_with(|| a.id.cmp(&b.id))
    });
    if out.is_empty() && provider != ProviderName::Lmstudio {
        let reg = ModelRegistry::load_from_builtin_dir(built_in_dir);
        out.push(reg.default_for(provider));
    }
    out
}

fn model_deny_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)(embedding|embed|rerank|whisper|tts|text[-_ ]?to[-_ ]?speech|speech|audio|transcrib|image|imagen|dall[-_ ]?e|moderation|guard|safety|stable[-_ ]?diffusion|flux|veo|lyria|aqa|bison)",
        )
        .expect("valid model deny regex")
    })
}

fn is_openai_reasoning_id(model_id: &str) -> bool {
    let lower = model_id.trim().to_ascii_lowercase();
    lower.starts_with("gpt-5")
        || lower == "o1"
        || lower == "o3"
        || lower == "o4"
        || lower.starts_with("o1-")
        || lower.starts_with("o1.")
        || lower.starts_with("o3-")
        || lower.starts_with("o3.")
        || lower.starts_with("o4-")
        || lower.starts_with("o4.")
}

fn google_reasoning_for_model(model_id: &str) -> ProviderCatalogReasoning {
    let lower = model_id.to_ascii_lowercase();
    let efforts = if lower.contains("flash-lite") || lower.contains("flash") {
        vec![
            "dynamic".to_string(),
            "minimal".to_string(),
            "low".to_string(),
            "medium".to_string(),
            "high".to_string(),
        ]
    } else {
        vec![
            "dynamic".to_string(),
            "low".to_string(),
            "medium".to_string(),
            "high".to_string(),
        ]
    };
    ProviderCatalogReasoning {
        default_effort: "dynamic".into(),
        available_efforts: efforts,
    }
}

fn static_reasoning_for_supported(model: &SupportedModel) -> Option<ProviderCatalogReasoning> {
    if model.provider == ProviderName::Google {
        return Some(google_reasoning_for_model(&model.id));
    }

    let default_effort = model
        .provider_options_defaults
        .get("reasoningEffort")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned);

    let available = model
        .supported_reasoning_efforts
        .clone()
        .filter(|v| !v.is_empty())
        .or_else(|| {
            default_effort
                .as_ref()
                .map(|_| vec!["low".to_string(), "medium".to_string(), "high".to_string()])
        })?;

    let default = default_effort.unwrap_or_else(|| available[0].clone());
    let mut deduped = Vec::new();
    for item in available {
        if !deduped.contains(&item) {
            deduped.push(item);
        }
    }
    if !deduped.contains(&default) {
        deduped.insert(0, default.clone());
    }
    Some(ProviderCatalogReasoning {
        default_effort: default,
        available_efforts: deduped,
    })
}

fn static_catalog_entry(built_in_dir: &Path, provider: ProviderName) -> ProviderCatalogEntry {
    let supported = load_builtin_models_for(built_in_dir, provider);
    let default_model = if provider == ProviderName::Lmstudio {
        String::new()
    } else {
        supported
            .iter()
            .find(|m| m.is_default)
            .or_else(|| supported.first())
            .map(|m| m.id.clone())
            .unwrap_or_default()
    };
    let models = supported
        .into_iter()
        .map(|m| {
            let reasoning = static_reasoning_for_supported(&m);
            ProviderCatalogModelEntry {
                id: m.id,
                model: None,
                display_name: m.display_name,
                description: None,
                knowledge_cutoff: m.knowledge_cutoff,
                supports_image_input: m.supports_image_input,
                reasoning,
                runtime_options: None,
                runtime_overrides: None,
                enabled: None,
            }
        })
        .collect();

    ProviderCatalogEntry {
        id: provider,
        name: provider_display_label(provider).to_string(),
        models,
        default_model,
        state: None,
        message: None,
    }
}

fn humanize_model_id(model_id: &str) -> String {
    let shortened = model_id
        .strip_prefix("models/")
        .unwrap_or(model_id)
        .strip_prefix("accounts/fireworks/models/")
        .or_else(|| model_id.strip_prefix("accounts/fireworks/routers/"))
        .unwrap_or(model_id.strip_prefix("models/").unwrap_or(model_id));

    shortened
        .split(['/', '_', '-', ' '])
        .filter(|s| !s.is_empty())
        .map(|tok| match tok.to_ascii_lowercase().as_str() {
            "gpt" | "glm" | "qwen" | "vl" | "mcp" | "oss" | "ai" => tok.to_ascii_uppercase(),
            "claude" => "Claude".into(),
            "gemini" => "Gemini".into(),
            "kimi" => "Kimi".into(),
            "minimax" => "MiniMax".into(),
            "nemotron" => "Nemotron".into(),
            "deepseek" => "DeepSeek".into(),
            "mistral" => "Mistral".into(),
            "llama" => "Llama".into(),
            _ => {
                let mut chars = tok.chars();
                match chars.next() {
                    None => String::new(),
                    Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
                }
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn should_include_openai_compat_model(
    provider: ProviderName,
    model_id: &str,
    record: &Map<String, Value>,
    supported_ids: &HashSet<String>,
) -> bool {
    if supported_ids.contains(model_id) {
        return true;
    }
    if model_deny_regex().is_match(model_id) {
        return false;
    }
    if let Some(source_type) = record.get("type").and_then(Value::as_str) {
        let lower_t = source_type.to_ascii_lowercase();
        if !matches!(
            lower_t.as_str(),
            "chat" | "language" | "text" | "model" | "serverless"
        ) {
            return false;
        }
    }

    let lower = model_id.trim().to_ascii_lowercase();
    match provider {
        ProviderName::Openai => {
            lower.starts_with("gpt-")
                || (lower.starts_with('o')
                    && lower.as_bytes().get(1).is_some_and(u8::is_ascii_digit))
        }
        ProviderName::Minimax => lower.starts_with("minimax-"),
        ProviderName::Fireworks | ProviderName::Firepass => {
            lower.starts_with("accounts/fireworks/models/")
                || lower.starts_with("accounts/fireworks/routers/")
                || lower.starts_with("fireworks/")
        }
        ProviderName::Nvidia => lower.starts_with("nvidia/"),
        ProviderName::OpencodeGo | ProviderName::OpencodeZen => true,
        _ => {
            static ALLOW_RE: OnceLock<Regex> = OnceLock::new();
            let re = ALLOW_RE.get_or_init(|| {
                Regex::new(
                    r"(?i)chat|instruct|kimi|qwen|glm|deepseek|llama|mistral|mixtral|gemma|nemotron|minimax|moonshot|claude|gpt",
                )
                .expect("valid allow regex")
            });
            re.is_match(model_id)
        }
    }
}

fn default_discovery_base_url(provider: ProviderName) -> &'static str {
    match provider {
        ProviderName::Openai => "https://api.openai.com/v1",
        ProviderName::Baseten => "https://inference.baseten.co/v1",
        ProviderName::Together => "https://api.together.xyz/v1",
        ProviderName::Fireworks | ProviderName::Firepass => "https://api.fireworks.ai/inference/v1",
        ProviderName::Nvidia => "https://integrate.api.nvidia.com/v1",
        ProviderName::Minimax => "https://api.minimax.io/v1",
        ProviderName::OpencodeGo => "https://opencode.ai/zen/go/v1",
        ProviderName::OpencodeZen => "https://opencode.ai/zen/v1",
        ProviderName::Anthropic => ANTHROPIC_MODEL_LIST_URL,
        ProviderName::Google => GOOGLE_MODEL_LIST_URL,
        ProviderName::Lmstudio => "http://localhost:1234",
        ProviderName::Bedrock | ProviderName::CodexCli => "",
    }
}

fn extract_records_from_payload(payload: &Value) -> Vec<Map<String, Value>> {
    let arr = if let Some(obj) = payload.as_object() {
        obj.get("data")
            .and_then(Value::as_array)
            .filter(|a| !a.is_empty())
            .or_else(|| {
                obj.get("models")
                    .and_then(Value::as_array)
                    .filter(|a| !a.is_empty())
            })
    } else {
        payload.as_array()
    };
    arr.map(|items| items.iter().filter_map(Value::as_object).cloned().collect())
        .unwrap_or_default()
}

async fn discover_api_models_http(
    client: &reqwest::Client,
    built_in_dir: &Path,
    provider: ProviderName,
    api_key: Option<&str>,
    base_url_override: Option<&str>,
    timeout: Duration,
) -> Result<ModelDiscoveryResult, String> {
    let supported = load_builtin_models_for(built_in_dir, provider);
    let supported_by_id: HashMap<String, SupportedModel> = supported
        .iter()
        .cloned()
        .map(|m| (m.id.clone(), m))
        .collect();
    let supported_ids: HashSet<String> = supported_by_id.keys().cloned().collect();
    let static_default_id = supported
        .iter()
        .find(|m| m.is_default)
        .map(|m| m.id.clone());

    if provider == ProviderName::Google {
        let key =
            api_key.ok_or_else(|| "Google API key unavailable for model discovery.".to_string())?;
        let endpoint = base_url_override.unwrap_or(GOOGLE_MODEL_LIST_URL);
        let url = format!("{endpoint}?pageSize=1000");
        let resp = client
            .get(&url)
            .header(ACCEPT, "application/json")
            .header("x-goog-api-key", key)
            .timeout(timeout)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("google model list failed: {}", resp.status()));
        }
        let payload: Value = resp.json().await.map_err(|e| e.to_string())?;
        let mut models = Vec::new();
        for rec in extract_records_from_payload(&payload) {
            let Some(raw_name) = rec
                .get("name")
                .and_then(Value::as_str)
                .map(|s| s.strip_prefix("models/").unwrap_or(s))
                .or_else(|| rec.get("baseModelId").and_then(Value::as_str))
            else {
                continue;
            };
            let methods: Vec<&str> = rec
                .get("supportedGenerationMethods")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            if (!methods.contains(&"generateContent")
                && !methods.contains(&"streamGenerateContent"))
                || !raw_name.to_ascii_lowercase().starts_with("gemini-")
                || model_deny_regex().is_match(raw_name)
            {
                continue;
            }
            let sup = supported_by_id.get(raw_name);
            let gr = google_reasoning_for_model(raw_name);
            models.push(CachedModelDiscoveryModel {
                id: raw_name.to_string(),
                model: None,
                display_name: rec
                    .get("displayName")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
                    .or_else(|| sup.map(|s| s.display_name.clone()))
                    .unwrap_or_else(|| humanize_model_id(raw_name)),
                description: rec
                    .get("description")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
                knowledge_cutoff: sup.map(|s| s.knowledge_cutoff.clone()),
                supports_image_input: Some(sup.map(|s| s.supports_image_input).unwrap_or(true)),
                is_default: (static_default_id.as_deref() == Some(raw_name)).then_some(true),
                reasoning: Some(CachedModelReasoning {
                    default_effort: Some(gr.default_effort),
                    available_efforts: Some(gr.available_efforts),
                }),
                runtime_options: Some(Map::from_iter([(
                    "source".to_string(),
                    Value::String("models-api".to_string()),
                )])),
                runtime_overrides: None,
            });
        }
        return Ok(ModelDiscoveryResult {
            provider,
            source: ModelDiscoverySource::Api,
            models,
            updated_at: None,
            expires_at: None,
            message: None,
        });
    }

    if provider == ProviderName::Anthropic {
        let key = api_key
            .ok_or_else(|| "Anthropic API key unavailable for model discovery.".to_string())?;
        let endpoint = base_url_override.unwrap_or(ANTHROPIC_MODEL_LIST_URL);
        let url = format!("{endpoint}?limit=100");
        let resp = client
            .get(&url)
            .header(ACCEPT, "application/json")
            .header("anthropic-version", "2023-06-01")
            .header("x-api-key", key)
            .timeout(timeout)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("anthropic model list failed: {}", resp.status()));
        }
        let payload: Value = resp.json().await.map_err(|e| e.to_string())?;
        let mut models = Vec::new();
        for rec in extract_records_from_payload(&payload) {
            let Some(model_id) = rec.get("id").and_then(Value::as_str) else {
                continue;
            };
            if !model_id.to_ascii_lowercase().starts_with("claude-") {
                continue;
            }
            let sup = supported_by_id.get(model_id);
            models.push(CachedModelDiscoveryModel {
                id: model_id.to_string(),
                model: None,
                display_name: rec
                    .get("display_name")
                    .or_else(|| rec.get("displayName"))
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
                    .or_else(|| sup.map(|s| s.display_name.clone()))
                    .unwrap_or_else(|| humanize_model_id(model_id)),
                description: None,
                knowledge_cutoff: sup.map(|s| s.knowledge_cutoff.clone()),
                supports_image_input: Some(sup.map(|s| s.supports_image_input).unwrap_or(false)),
                is_default: (static_default_id.as_deref() == Some(model_id)).then_some(true),
                reasoning: None,
                runtime_options: Some(Map::from_iter([(
                    "source".to_string(),
                    Value::String("models-api".to_string()),
                )])),
                runtime_overrides: None,
            });
        }
        return Ok(ModelDiscoveryResult {
            provider,
            source: ModelDiscoverySource::Api,
            models,
            updated_at: None,
            expires_at: None,
            message: None,
        });
    }

    let is_public = matches!(
        provider,
        ProviderName::OpencodeGo | ProviderName::OpencodeZen
    );
    if !is_public && api_key.is_none() {
        return Err(format!(
            "{} API key unavailable for model discovery.",
            provider_display_label(provider)
        ));
    }

    let base_url = base_url_override
        .unwrap_or_else(|| default_discovery_base_url(provider))
        .trim_end_matches('/');
    let url = if base_url.ends_with("/models") {
        base_url.to_string()
    } else {
        format!("{base_url}/models")
    };

    let mut headers = HeaderMap::new();
    headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
    if let Some(k) = api_key {
        let prefix = if provider == ProviderName::Baseten {
            "Api-Key"
        } else {
            "Bearer"
        };
        if let Ok(hv) = HeaderValue::from_str(&format!("{prefix} {k}")) {
            headers.insert(AUTHORIZATION, hv);
        }
    }

    let resp = client
        .get(&url)
        .headers(headers)
        .timeout(timeout)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!(
            "{} model list failed: {}",
            provider.as_str(),
            resp.status()
        ));
    }

    let payload: Value = resp.json().await.map_err(|e| e.to_string())?;
    let mut models = Vec::new();
    for rec in extract_records_from_payload(&payload) {
        let Some(model_id) = rec
            .get("id")
            .or_else(|| rec.get("model"))
            .or_else(|| rec.get("name"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        if !should_include_openai_compat_model(provider, model_id, &rec, &supported_ids) {
            continue;
        }
        let sup = supported_by_id.get(model_id);
        let reasoning = if provider == ProviderName::Openai && is_openai_reasoning_id(model_id) {
            if let Some(sr) = sup.and_then(static_reasoning_for_supported) {
                Some(CachedModelReasoning {
                    default_effort: Some(sr.default_effort),
                    available_efforts: Some(sr.available_efforts),
                })
            } else {
                Some(CachedModelReasoning {
                    default_effort: Some("high".into()),
                    available_efforts: Some(vec!["low".into(), "medium".into(), "high".into()]),
                })
            }
        } else {
            None
        };

        let mut runtime_opts = Map::new();
        runtime_opts.insert("source".into(), Value::String("models-api".into()));
        if let Some(obj_s) = rec.get("object").and_then(Value::as_str) {
            runtime_opts.insert("object".into(), Value::String(obj_s.to_string()));
        }

        let lower_id = model_id.to_ascii_lowercase();
        let vision = sup.map(|s| s.supports_image_input).unwrap_or_else(|| {
            lower_id.contains("vision")
                || lower_id.contains("vl")
                || lower_id.contains("multimodal")
                || lower_id.contains("omni")
        });

        models.push(CachedModelDiscoveryModel {
            id: model_id.to_string(),
            model: None,
            display_name: rec
                .get("display_name")
                .or_else(|| rec.get("displayName"))
                .or_else(|| rec.get("name"))
                .and_then(Value::as_str)
                .filter(|d| *d != model_id)
                .map(ToOwned::to_owned)
                .or_else(|| sup.map(|s| s.display_name.clone()))
                .unwrap_or_else(|| humanize_model_id(model_id)),
            description: rec
                .get("description")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned),
            knowledge_cutoff: sup.map(|s| s.knowledge_cutoff.clone()),
            supports_image_input: Some(vision),
            is_default: (static_default_id.as_deref() == Some(model_id)).then_some(true),
            reasoning,
            runtime_options: Some(runtime_opts),
            runtime_overrides: None,
        });
    }

    Ok(ModelDiscoveryResult {
        provider,
        source: ModelDiscoverySource::Api,
        models,
        updated_at: None,
        expires_at: None,
        message: None,
    })
}

async fn discover_lmstudio_models_read_only(
    client: &reqwest::Client,
    base_url: &str,
    api_key: Option<&str>,
    timeout: Duration,
) -> Result<ModelDiscoveryResult, String> {
    let mut lm_opts = resolve_lmstudio_options(&HashMap::new(), None, api_key);
    let normalized = crate::chat_completions::normalize_lmstudio_base_url(Some(base_url));
    lm_opts.inference_base_url = format!("{normalized}/v1");
    lm_opts.api_base_url = format!("{normalized}/api/v1");
    lm_opts.base_url = normalized.clone();

    let v1_url = format!("{}/models", lm_opts.inference_base_url);
    let mut headers = HeaderMap::new();
    headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
    if let Some(tok) = lm_opts.api_key.as_deref().filter(|s| !s.trim().is_empty())
        && let Ok(hv) = HeaderValue::from_str(&format!("Bearer {}", tok.trim()))
    {
        headers.insert(AUTHORIZATION, hv);
    }

    let v1_resp = client
        .get(&v1_url)
        .headers(headers)
        .timeout(timeout.min(Duration::from_millis(2_500)))
        .send()
        .await
        .map_err(|e| format!("LM Studio server is unreachable at {normalized}: {e}"))?;

    if v1_resp.status() == StatusCode::NOT_FOUND {
        // Fallback for mock servers that only mount `/api/v1/models`
        let ctl = LmStudioControlClient::new(lm_opts);
        let native = ctl.list_native_models().await.map_err(|e| e.message)?;
        let default_key = native
            .iter()
            .find(|m| !m.loaded_instances.is_empty())
            .or_else(|| native.first())
            .map(|m| m.key.clone());
        let models = native
            .into_iter()
            .map(|m| CachedModelDiscoveryModel {
                id: m.key.clone(),
                model: None,
                display_name: m.display_name.unwrap_or_else(|| m.key.clone()),
                description: m.description,
                knowledge_cutoff: Some("Unknown".into()),
                supports_image_input: Some(m.vision.unwrap_or(false)),
                is_default: (default_key.as_deref() == Some(m.key.as_str())).then_some(true),
                reasoning: None,
                runtime_options: None,
                runtime_overrides: None,
            })
            .collect();
        return Ok(ModelDiscoveryResult {
            provider: ProviderName::Lmstudio,
            source: ModelDiscoverySource::LocalHttp,
            models,
            updated_at: None,
            expires_at: None,
            message: None,
        });
    }

    if !v1_resp.status().is_success() {
        return Err(format!(
            "LM Studio request failed at {v1_url} ({})",
            v1_resp.status().as_u16()
        ));
    }

    let payload: Value = v1_resp.json().await.map_err(|e| e.to_string())?;
    let mut raw_ids = Vec::new();
    for rec in extract_records_from_payload(&payload) {
        let Some(id) = rec
            .get("id")
            .or_else(|| rec.get("key"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        let rec_type = rec.get("type").and_then(Value::as_str).unwrap_or("");
        if rec_type.eq_ignore_ascii_case("embedding") || model_deny_regex().is_match(id) {
            continue;
        }
        raw_ids.push(id.to_string());
    }

    // Prefer already-loaded ornith model on local host when present, else first LLM
    let default_id = raw_ids
        .iter()
        .find(|id| id.contains("ornith-1.5-122b-uncensored"))
        .or_else(|| raw_ids.first())
        .cloned();

    let models = raw_ids
        .into_iter()
        .map(|id| CachedModelDiscoveryModel {
            id: id.clone(),
            model: None,
            display_name: id.clone(),
            description: None,
            knowledge_cutoff: Some("Unknown".into()),
            supports_image_input: Some(false),
            is_default: (default_id.as_deref() == Some(id.as_str())).then_some(true),
            reasoning: None,
            runtime_options: Some(Map::from_iter([(
                "source".into(),
                Value::String("local-http".into()),
            )])),
            runtime_overrides: None,
        })
        .collect();

    Ok(ModelDiscoveryResult {
        provider: ProviderName::Lmstudio,
        source: ModelDiscoverySource::LocalHttp,
        models,
        updated_at: None,
        expires_at: None,
        message: None,
    })
}

fn cache_to_discovery(cache: &ModelDiscoveryCacheFile) -> ModelDiscoveryResult {
    ModelDiscoveryResult {
        provider: cache.provider,
        source: cache.source,
        models: cache.models.clone(),
        updated_at: Some(cache.updated_at.clone()),
        expires_at: cache.expires_at.clone(),
        message: None,
    }
}

fn catalog_entry_from_discovery(
    built_in_dir: &Path,
    provider: ProviderName,
    discovery: &ModelDiscoveryResult,
    state: Option<String>,
    message: Option<String>,
) -> ProviderCatalogEntry {
    let supported = load_builtin_models_for(built_in_dir, provider);
    let supported_by_id: HashMap<String, SupportedModel> = supported
        .iter()
        .cloned()
        .map(|m| (m.id.clone(), m))
        .collect();
    let static_default = supported
        .iter()
        .find(|m| m.is_default)
        .map(|m| m.id.clone());

    let mut seen = HashSet::new();
    let mut models = Vec::new();
    let mut discovered_default: Option<String> = None;

    for dm in &discovery.models {
        let sup = dm
            .model
            .as_deref()
            .and_then(|mid| supported_by_id.get(mid))
            .or_else(|| supported_by_id.get(&dm.id));
        let resolved_id = sup
            .map(|s| s.id.clone())
            .or_else(|| dm.model.clone())
            .unwrap_or_else(|| dm.id.clone());
        if dm.is_default == Some(true) && discovered_default.is_none() {
            discovered_default = Some(resolved_id.clone());
        }
        if !seen.insert(resolved_id.clone()) {
            continue;
        }
        let reasoning = dm
            .reasoning
            .as_ref()
            .and_then(|r| {
                let avail = r.available_efforts.clone().unwrap_or_default();
                let def = r
                    .default_effort
                    .clone()
                    .or_else(|| avail.first().cloned())?;
                let mut next = avail;
                if !next.contains(&def) {
                    next.insert(0, def.clone());
                }
                Some(ProviderCatalogReasoning {
                    default_effort: def,
                    available_efforts: next,
                })
            })
            .or_else(|| sup.and_then(static_reasoning_for_supported));

        models.push(ProviderCatalogModelEntry {
            id: resolved_id.clone(),
            model: dm.model.clone().filter(|m| m != &resolved_id),
            display_name: if dm.display_name.trim().is_empty() {
                sup.map(|s| s.display_name.clone())
                    .unwrap_or_else(|| resolved_id.clone())
            } else {
                dm.display_name.clone()
            },
            description: dm.description.clone(),
            knowledge_cutoff: sup
                .map(|s| s.knowledge_cutoff.clone())
                .or_else(|| dm.knowledge_cutoff.clone())
                .unwrap_or_else(|| "Unknown".into()),
            supports_image_input: sup
                .map(|s| s.supports_image_input)
                .or(dm.supports_image_input)
                .unwrap_or(false),
            reasoning,
            runtime_options: dm.runtime_options.clone(),
            runtime_overrides: dm.runtime_overrides.clone(),
            enabled: None,
        });
    }

    let default_model = discovered_default
        .or_else(|| static_default.filter(|sd| models.iter().any(|m| &m.id == sd)))
        .or_else(|| models.first().map(|m| m.id.clone()))
        .unwrap_or_default();

    ProviderCatalogEntry {
        id: provider,
        name: provider_display_label(provider).to_string(),
        models,
        default_model,
        state,
        message,
    }
}

fn is_curated_open_model_default(model_id: &str) -> bool {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| {
        vec![
            Regex::new(r"^nemotron-3-ultra(?:$|[-.])").unwrap(),
            Regex::new(r"^minimax-m3(?:$|[-.])").unwrap(),
            Regex::new(r"^glm-5\.2(?:$|[-.])").unwrap(),
            Regex::new(r"^kimi-k2[.p]6(?:$|[-.])").unwrap(),
            Regex::new(r"^deepseek-v4-pro(?:$|[-.])").unwrap(),
            Regex::new(r"^deepseek-v4-flash(?:$|[-.])").unwrap(),
        ]
    });
    let lower = model_id.trim().to_ascii_lowercase();
    let last_segment = lower.rsplit('/').next().unwrap_or(&lower);
    patterns.iter().any(|re| re.is_match(last_segment))
}

fn is_curated_aggregator(provider: ProviderName) -> bool {
    matches!(
        provider,
        ProviderName::Together
            | ProviderName::Nvidia
            | ProviderName::Minimax
            | ProviderName::Baseten
            | ProviderName::Fireworks
            | ProviderName::Firepass
            | ProviderName::OpencodeGo
            | ProviderName::OpencodeZen
    )
}

fn merge_custom_models_and_preferences(
    built_in_dir: &Path,
    mut entry: ProviderCatalogEntry,
    custom_models: Option<&Vec<CustomModelEntry>>,
    preferences: Option<&Vec<ModelPreferenceEntry>>,
) -> ProviderCatalogEntry {
    let provider = entry.id;
    let supported = load_builtin_models_for(built_in_dir, provider);
    let supported_ids: HashSet<String> = supported.iter().map(|m| m.id.clone()).collect();
    let static_default_id = supported
        .iter()
        .find(|m| m.is_default)
        .or_else(|| supported.first())
        .map(|m| m.id.clone())
        .unwrap_or_default();

    // 1. Merge custom models
    let mut custom_ids = HashSet::new();
    if provider.supports_custom_model_ids()
        && let Some(custom_list) = custom_models.filter(|l| !l.is_empty())
    {
        for cm in custom_list {
            custom_ids.insert(cm.id.clone());
        }
        let existing_ids: HashSet<String> = entry.models.iter().map(|m| m.id.clone()).collect();
        for model in &mut entry.models {
            if custom_ids.contains(&model.id) {
                let mut ro = model.runtime_options.clone().unwrap_or_default();
                ro.insert("source".into(), Value::String("custom".into()));
                model.runtime_options = Some(ro);
            }
        }
        for cm in custom_list {
            if existing_ids.contains(&cm.id) {
                continue;
            }
            let reasoning =
                if matches!(provider, ProviderName::Openai) && is_openai_reasoning_id(&cm.id) {
                    Some(ProviderCatalogReasoning {
                        default_effort: "high".into(),
                        available_efforts: vec!["low".into(), "medium".into(), "high".into()],
                    })
                } else {
                    None
                };
            entry.models.push(ProviderCatalogModelEntry {
                id: cm.id.clone(),
                model: None,
                display_name: cm.display_name.clone().unwrap_or_else(|| cm.id.clone()),
                description: Some("Custom model ID".into()),
                knowledge_cutoff: "Unknown".into(),
                supports_image_input: false,
                reasoning,
                runtime_options: Some(Map::from_iter([(
                    "source".into(),
                    Value::String("custom".into()),
                )])),
                runtime_overrides: None,
                enabled: None,
            });
        }
        if entry.default_model.is_empty()
            && let Some(first) = entry.models.first()
        {
            entry.default_model = first.id.clone();
        }
    }

    // 2. Apply model preferences (`enabled: false` only; omit when enabled; repair `defaultModel`)
    if !provider.supports_model_preferences() || entry.models.is_empty() {
        return entry;
    }

    let overrides: HashMap<String, bool> = preferences
        .map(|prefs| prefs.iter().map(|p| (p.id.clone(), p.enabled)).collect())
        .unwrap_or_default();

    let discovery_authoritative = provider == ProviderName::CodexCli;
    let use_curated = is_curated_aggregator(provider)
        && entry
            .models
            .iter()
            .any(|m| is_curated_open_model_default(&m.id));

    let is_default_enabled = |model_id: &str| -> bool {
        discovery_authoritative
            || (if use_curated {
                is_curated_open_model_default(model_id)
            } else {
                supported_ids.contains(model_id)
            })
            || custom_ids.contains(model_id)
    };

    let fail_open = !entry.models.iter().any(|m| is_default_enabled(&m.id));
    if fail_open && overrides.is_empty() {
        return entry;
    }

    let mut enabled_by_id = HashMap::new();
    for m in &entry.models {
        let def_en = if fail_open {
            true
        } else {
            is_default_enabled(&m.id)
        };
        let eff = overrides.get(&m.id).copied().unwrap_or(def_en);
        enabled_by_id.insert(m.id.clone(), eff);
    }

    let any_enabled = enabled_by_id.values().any(|&v| v);
    for m in &mut entry.models {
        if enabled_by_id.get(&m.id) == Some(&false) {
            m.enabled = Some(false);
        } else {
            m.enabled = None;
        }
    }

    if !entry.default_model.is_empty()
        && any_enabled
        && enabled_by_id.get(&entry.default_model) == Some(&false)
    {
        if enabled_by_id.get(&static_default_id) == Some(&true) {
            entry.default_model = static_default_id;
        } else if let Some(first_enabled) = entry.models.iter().find(|m| m.enabled != Some(false)) {
            entry.default_model = first_enabled.id.clone();
        }
    }

    entry
}

pub async fn build_provider_catalog(opts: &CatalogBuildOptions) -> ProviderCatalogPayload {
    let built_in_dir = default_builtin_dir();
    let paths: AiCoworkerPaths = get_ai_coworker_paths(Some(&opts.homedir), &opts.env);
    let store = read_connection_store(&paths)
        .await
        .unwrap_or_else(|_| ConnectionStore::empty());
    let custom_store = read_custom_model_store(&paths)
        .await
        .unwrap_or_else(|_| cowork_config::CustomModelStore::empty());
    let prefs_store = read_model_preferences_store(&paths)
        .await
        .unwrap_or_else(|_| cowork_config::ModelPreferencesStore::empty());

    let client = build_http_client().expect("rustls HTTP client");
    let timeout = Duration::from_millis(
        opts.discovery_timeout_ms
            .unwrap_or(DEFAULT_DISCOVERY_TIMEOUT_MS),
    );

    let mut all = Vec::with_capacity(ProviderName::ALL.len());
    let mut connected = Vec::new();

    for provider in ProviderName::ALL {
        let (raw_entry, is_connected) = match provider {
            ProviderName::Lmstudio => {
                let saved_key = stored_provider_api_key(&store, ProviderName::Lmstudio);
                let mut lm_opts = resolve_lmstudio_options(
                    &opts.env,
                    opts.provider_options.as_ref(),
                    saved_key.as_deref(),
                );
                if let Some(ov) = opts.base_url_overrides.get(&ProviderName::Lmstudio) {
                    lm_opts.base_url =
                        crate::chat_completions::normalize_lmstudio_base_url(Some(ov));
                }
                let scope = json!([
                    lm_opts.base_url,
                    lm_opts.api_key.clone().unwrap_or_default()
                ])
                .to_string();
                let cached = read_model_discovery_cache(&paths, provider, Some(&scope)).await;
                match discover_lmstudio_models_read_only(
                    &client,
                    &lm_opts.base_url,
                    lm_opts.api_key.as_deref(),
                    timeout,
                )
                .await
                {
                    Ok(disc) => {
                        let _ = write_model_discovery_cache(
                            &paths,
                            provider,
                            disc.clone(),
                            Some(&scope),
                            Some(0),
                        )
                        .await;
                        let st = if disc.models.is_empty() {
                            "empty"
                        } else {
                            "ready"
                        };
                        let msg = disc.models.is_empty().then(|| {
                            format!(
                                "LM Studio server at {} is reachable, but no LLMs are available.",
                                lm_opts.base_url
                            )
                        });
                        (
                            catalog_entry_from_discovery(
                                &built_in_dir,
                                provider,
                                &disc,
                                Some(st.into()),
                                msg,
                            ),
                            true,
                        )
                    }
                    Err(err_msg) => {
                        if let Some(c) = cached {
                            let disc = cache_to_discovery(&c);
                            (
                                catalog_entry_from_discovery(
                                    &built_in_dir,
                                    provider,
                                    &disc,
                                    Some("unreachable".into()),
                                    Some(format!(
                                        "LM Studio model discovery failed: {err_msg} Using cached model catalog from {}.",
                                        c.updated_at
                                    )),
                                ),
                                false,
                            )
                        } else {
                            (
                                ProviderCatalogEntry {
                                    id: provider,
                                    name: provider_display_label(provider).into(),
                                    models: Vec::new(),
                                    default_model: String::new(),
                                    state: Some("unreachable".into()),
                                    message: Some(err_msg),
                                },
                                false,
                            )
                        }
                    }
                }
            }
            ProviderName::Bedrock => {
                let auth_opt = resolve_bedrock_auth_config(&opts.homedir, &opts.env, Some(&store));
                let is_conn = auth_opt.is_some();
                if let Some(auth) = auth_opt {
                    let scope = compute_bedrock_auth_fingerprint(&auth);
                    let cached = read_model_discovery_cache(&paths, provider, Some(&scope)).await;
                    if let Some(c) = cached.as_ref()
                        && !opts.refresh
                        && is_model_discovery_cache_fresh(Some(c), None)
                    {
                        let disc = cache_to_discovery(c);
                        (
                            catalog_entry_from_discovery(
                                &built_in_dir,
                                provider,
                                &disc,
                                Some("ready".into()),
                                None,
                            ),
                            true,
                        )
                    } else if opts.refresh {
                        let base_ov = opts
                            .base_url_overrides
                            .get(&ProviderName::Bedrock)
                            .map(String::as_str);
                        match discover_bedrock_models(&client, &auth, base_ov).await {
                            Ok(models) => {
                                let disc = ModelDiscoveryResult {
                                    provider,
                                    source: ModelDiscoverySource::Api,
                                    models,
                                    updated_at: None,
                                    expires_at: None,
                                    message: None,
                                };
                                let written = write_model_discovery_cache(
                                    &paths,
                                    provider,
                                    disc.clone(),
                                    Some(&scope),
                                    None,
                                )
                                .await
                                .ok();
                                let final_disc =
                                    written.as_ref().map(cache_to_discovery).unwrap_or(disc);
                                let st = if final_disc.models.is_empty() {
                                    "empty"
                                } else {
                                    "ready"
                                };
                                (
                                    catalog_entry_from_discovery(
                                        &built_in_dir,
                                        provider,
                                        &final_disc,
                                        Some(st.into()),
                                        None,
                                    ),
                                    true,
                                )
                            }
                            Err(err) => {
                                if let Some(c) = cached {
                                    let disc = cache_to_discovery(&c);
                                    (
                                        catalog_entry_from_discovery(
                                            &built_in_dir,
                                            provider,
                                            &disc,
                                            Some("unreachable".into()),
                                            Some(format!(
                                                "Amazon Bedrock model discovery failed: {} Using cached model catalog from {}.",
                                                err.message, c.updated_at
                                            )),
                                        ),
                                        true,
                                    )
                                } else {
                                    let mut fallback =
                                        static_catalog_entry(&built_in_dir, provider);
                                    fallback.state = Some("unreachable".into());
                                    fallback.message = Some(format!(
                                        "Bedrock model discovery failed: {}",
                                        err.message
                                    ));
                                    (fallback, true)
                                }
                            }
                        }
                    } else if let Some(c) = cached {
                        let disc = cache_to_discovery(&c);
                        (
                            catalog_entry_from_discovery(
                                &built_in_dir,
                                provider,
                                &disc,
                                Some("ready".into()),
                                None,
                            ),
                            true,
                        )
                    } else {
                        let mut static_e = static_catalog_entry(&built_in_dir, provider);
                        static_e.state = Some("ready".into());
                        (static_e, true)
                    }
                } else {
                    (static_catalog_entry(&built_in_dir, provider), is_conn)
                }
            }
            ProviderName::CodexCli => {
                let has_auth_file = paths.codex_auth_dir.join("auth.json").is_file();
                let has_saved = store.services.get(&provider).is_some_and(|e| {
                    matches!(e.mode, ConnectionMode::ApiKey | ConnectionMode::Oauth)
                });
                let is_conn = has_auth_file || has_saved;
                let has_codex_override = env_non_empty(&opts.env, "COWORK_CODEX_APP_SERVER_BIN")
                    .or_else(|| env_non_empty(&opts.env, "COWORK_CODEX_APP_SERVER_COMMAND"))
                    .is_some();
                let cached = read_model_discovery_cache(&paths, provider, None).await;
                let cached_fresh = is_model_discovery_cache_fresh(cached.as_ref(), None);
                let should_use_live = cached.is_some()
                    || (is_conn && opts.refresh)
                    || (has_codex_override && opts.refresh);

                let entry = if !should_use_live {
                    static_catalog_entry(&built_in_dir, provider)
                } else if !is_conn && !has_codex_override {
                    let c = cached.expect("checked cached.is_some()");
                    let disc = cache_to_discovery(&c);
                    let stale = !cached_fresh || opts.refresh;
                    catalog_entry_from_discovery(
                        &built_in_dir,
                        provider,
                        &disc,
                        Some(if stale { "unreachable" } else { "ready" }.into()),
                        stale.then(|| {
                            format!(
                                "Codex account unavailable. Using cached model catalog from {}.",
                                c.updated_at
                            )
                        }),
                    )
                } else if let Some(c) = cached.as_ref()
                    && !opts.refresh
                    && cached_fresh
                {
                    let disc = cache_to_discovery(c);
                    catalog_entry_from_discovery(
                        &built_in_dir,
                        provider,
                        &disc,
                        Some(
                            if disc.models.is_empty() {
                                "empty"
                            } else {
                                "ready"
                            }
                            .into(),
                        ),
                        None,
                    )
                } else {
                    let spawn_cwd = opts
                        .env
                        .get("AGENT_WORKING_DIR")
                        .map(PathBuf::from)
                        .filter(|p| p.is_dir())
                        .unwrap_or_else(|| opts.homedir.clone());
                    let status = resolve_codex_app_server_status(&paths.root_dir, &opts.env);
                    let live_res: Result<ModelDiscoveryResult, String> = if !status.available {
                        Err(status.message)
                    } else {
                        let cmd = status.command.unwrap_or_else(|| "codex".to_string());
                        let args = status.args.unwrap_or_default();
                        match CodexAppServerClient::spawn_stdio(
                            &cmd,
                            &args,
                            &spawn_cwd,
                            &paths.root_dir,
                            &opts.env,
                            None,
                        )
                        .await
                        {
                            Ok(codex_client) => {
                                let res = list_codex_models(&codex_client, timeout).await;
                                codex_client.close().await;
                                res.map(|models| ModelDiscoveryResult {
                                    provider,
                                    source: ModelDiscoverySource::AppServer,
                                    models,
                                    updated_at: None,
                                    expires_at: None,
                                    message: None,
                                })
                                .map_err(|e| e.message)
                            }
                            Err(e) => Err(e.message),
                        }
                    };

                    match live_res {
                        Ok(disc) => {
                            if disc.models.is_empty()
                                && let Some(c) = cached.as_ref()
                                && c.source != ModelDiscoverySource::Static
                            {
                                let c_disc = cache_to_discovery(c);
                                catalog_entry_from_discovery(
                                    &built_in_dir,
                                    provider,
                                    &c_disc,
                                    Some("unreachable".into()),
                                    Some(format!(
                                        "Codex model discovery returned no usable models. Using cached model catalog from {}.",
                                        c.updated_at
                                    )),
                                )
                            } else {
                                let written = write_model_discovery_cache(
                                    &paths,
                                    provider,
                                    disc.clone(),
                                    None,
                                    None,
                                )
                                .await
                                .ok();
                                let final_disc =
                                    written.as_ref().map(cache_to_discovery).unwrap_or(disc);
                                let st = if final_disc.models.is_empty() {
                                    "empty"
                                } else {
                                    "ready"
                                };
                                catalog_entry_from_discovery(
                                    &built_in_dir,
                                    provider,
                                    &final_disc,
                                    Some(st.into()),
                                    None,
                                )
                            }
                        }
                        Err(err_msg) => {
                            if let Some(c) = cached {
                                let c_disc = cache_to_discovery(&c);
                                catalog_entry_from_discovery(
                                    &built_in_dir,
                                    provider,
                                    &c_disc,
                                    Some("unreachable".into()),
                                    Some(format!(
                                        "Codex model discovery failed: {err_msg} Using cached model catalog from {}.",
                                        c.updated_at
                                    )),
                                )
                            } else {
                                let mut se = static_catalog_entry(&built_in_dir, provider);
                                se.state = Some("unreachable".into());
                                se.message =
                                    Some(format!("Codex model discovery failed: {err_msg}"));
                                se
                            }
                        }
                    }
                };
                (entry, is_conn)
            }
            _ => {
                let api_key = resolve_provider_api_key(provider, Some(&store), &opts.env);
                let has_creds = api_key.is_some()
                    || store.services.get(&provider).is_some_and(|e| {
                        matches!(e.mode, ConnectionMode::ApiKey | ConnectionMode::Oauth)
                    });
                let cached = read_model_discovery_cache(&paths, provider, None).await;
                let cached_fresh = is_model_discovery_cache_fresh(cached.as_ref(), None);
                let is_public = matches!(
                    provider,
                    ProviderName::OpencodeGo | ProviderName::OpencodeZen
                );
                let should_use_live = cached.is_some()
                    || (api_key.is_some() && opts.refresh)
                    || (is_public && opts.refresh);

                let entry = if !should_use_live {
                    static_catalog_entry(&built_in_dir, provider)
                } else if api_key.is_none() && !is_public {
                    let c = cached.expect("checked cached.is_some()");
                    let disc = cache_to_discovery(&c);
                    let stale = !cached_fresh || opts.refresh;
                    catalog_entry_from_discovery(
                        &built_in_dir,
                        provider,
                        &disc,
                        Some(if stale { "unreachable" } else { "ready" }.into()),
                        stale.then(|| {
                            format!(
                                "{} API key unavailable. Using cached model catalog from {}.",
                                provider_display_label(provider),
                                c.updated_at
                            )
                        }),
                    )
                } else if let Some(c) = cached.as_ref()
                    && !opts.refresh
                    && cached_fresh
                {
                    let disc = cache_to_discovery(c);
                    catalog_entry_from_discovery(
                        &built_in_dir,
                        provider,
                        &disc,
                        Some(
                            if disc.models.is_empty() {
                                "empty"
                            } else {
                                "ready"
                            }
                            .into(),
                        ),
                        None,
                    )
                } else {
                    let base_ov = opts.base_url_overrides.get(&provider).map(String::as_str);
                    match discover_api_models_http(
                        &client,
                        &built_in_dir,
                        provider,
                        api_key.as_deref(),
                        base_ov,
                        timeout,
                    )
                    .await
                    {
                        Ok(disc) => {
                            if disc.models.is_empty()
                                && let Some(c) = cached.as_ref()
                                && c.source != ModelDiscoverySource::Static
                            {
                                let c_disc = cache_to_discovery(c);
                                catalog_entry_from_discovery(
                                    &built_in_dir,
                                    provider,
                                    &c_disc,
                                    Some("unreachable".into()),
                                    Some(format!(
                                        "{} model discovery returned no usable models. Using cached model catalog from {}.",
                                        provider_display_label(provider),
                                        c.updated_at
                                    )),
                                )
                            } else {
                                let written = write_model_discovery_cache(
                                    &paths,
                                    provider,
                                    disc.clone(),
                                    None,
                                    None,
                                )
                                .await
                                .ok();
                                let final_disc =
                                    written.as_ref().map(cache_to_discovery).unwrap_or(disc);
                                let st = if final_disc.models.is_empty() {
                                    "empty"
                                } else {
                                    "ready"
                                };
                                let msg = final_disc.models.is_empty().then(|| {
                                    format!(
                                        "{} model discovery returned no usable generation models.",
                                        provider_display_label(provider)
                                    )
                                });
                                catalog_entry_from_discovery(
                                    &built_in_dir,
                                    provider,
                                    &final_disc,
                                    Some(st.into()),
                                    msg,
                                )
                            }
                        }
                        Err(err_msg) => {
                            if let Some(c) = cached {
                                let c_disc = cache_to_discovery(&c);
                                catalog_entry_from_discovery(
                                    &built_in_dir,
                                    provider,
                                    &c_disc,
                                    Some("unreachable".into()),
                                    Some(format!(
                                        "{} model discovery failed: {err_msg} Using cached model catalog from {}.",
                                        provider_display_label(provider),
                                        c.updated_at
                                    )),
                                )
                            } else {
                                let mut fallback = static_catalog_entry(&built_in_dir, provider);
                                fallback.state = Some("unreachable".into());
                                fallback.message = Some(format!(
                                    "{} model discovery failed: {err_msg}. Showing bundled model catalog.",
                                    provider_display_label(provider)
                                ));
                                fallback
                            }
                        }
                    }
                };
                (entry, has_creds)
            }
        };

        if is_connected {
            connected.push(provider.as_str().to_string());
        }

        let finalized = merge_custom_models_and_preferences(
            &built_in_dir,
            raw_entry,
            custom_store.providers.get(&provider),
            prefs_store.providers.get(&provider),
        );
        all.push(finalized);
    }

    let mut default_map = BTreeMap::new();
    for entry in &all {
        default_map.insert(entry.id.as_str().to_string(), entry.default_model.clone());
    }

    ProviderCatalogPayload {
        all,
        default: default_map,
        connected,
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatusEntry {
    pub provider: ProviderName,
    pub authorized: bool,
    pub verified: bool,
    pub mode: String,
    pub account: Option<Value>,
    pub message: String,
    pub checked_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub method_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub saved_api_key_masks: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub saved_field_masks: Option<BTreeMap<String, String>>,
}

fn build_saved_api_key_masks(
    provider: ProviderName,
    store: &ConnectionStore,
) -> Option<BTreeMap<String, String>> {
    let mut out = BTreeMap::new();
    if let Some(k) = stored_provider_api_key(store, provider) {
        out.insert("api_key".into(), mask_api_key(&k));
    }
    if provider == ProviderName::Google
        && let Some(tools) = &store.tool_api_keys
    {
        if let Some(exa) = tools
            .exa
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            out.insert("exa_api_key".into(), mask_api_key(exa));
        }
        if let Some(par) = tools
            .parallel
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            out.insert("parallel_api_key".into(), mask_api_key(par));
        }
    }
    (!out.is_empty()).then_some(out)
}

fn build_saved_field_masks(
    provider: ProviderName,
    store: &ConnectionStore,
) -> Option<BTreeMap<String, String>> {
    if provider != ProviderName::Bedrock {
        return None;
    }
    let entry = store.services.get(&ProviderName::Bedrock)?;
    if entry.mode != ConnectionMode::Credentials {
        return None;
    }
    let values = entry.values.as_ref()?;
    let masked = mask_bedrock_field_values(values);
    let btree: BTreeMap<String, String> = masked.into_iter().collect();
    (!btree.is_empty()).then_some(btree)
}

pub async fn build_provider_statuses(
    opts: &CatalogBuildOptions,
    refresh_bedrock_discovery: bool,
) -> Vec<ProviderStatusEntry> {
    let paths = get_ai_coworker_paths(Some(&opts.homedir), &opts.env);
    let store = read_connection_store(&paths)
        .await
        .unwrap_or_else(|_| ConnectionStore::empty());
    let checked_at = Utc::now().to_rfc3339();
    let client = build_http_client().expect("rustls HTTP client");
    let timeout = Duration::from_millis(
        opts.discovery_timeout_ms
            .unwrap_or(DEFAULT_DISCOVERY_TIMEOUT_MS),
    );

    let mut out = Vec::with_capacity(ProviderName::ALL.len());

    for provider in ProviderName::ALL {
        let saved_api_key_masks = build_saved_api_key_masks(provider, &store);
        let saved_field_masks = build_saved_field_masks(provider, &store);

        if provider == ProviderName::Lmstudio {
            let saved_key = stored_provider_api_key(&store, ProviderName::Lmstudio);
            let mut lm_opts = resolve_lmstudio_options(
                &opts.env,
                opts.provider_options.as_ref(),
                saved_key.as_deref(),
            );
            if let Some(ov) = opts.base_url_overrides.get(&ProviderName::Lmstudio) {
                lm_opts.base_url = crate::chat_completions::normalize_lmstudio_base_url(Some(ov));
            }
            match discover_lmstudio_models_read_only(
                &client,
                &lm_opts.base_url,
                lm_opts.api_key.as_deref(),
                timeout,
            )
            .await
            {
                Ok(disc) => {
                    let scope = json!([
                        lm_opts.base_url,
                        lm_opts.api_key.clone().unwrap_or_default()
                    ])
                    .to_string();
                    let _ = write_model_discovery_cache(
                        &paths,
                        ProviderName::Lmstudio,
                        disc.clone(),
                        Some(&scope),
                        Some(0),
                    )
                    .await;
                    let msg = if disc.models.is_empty() {
                        format!(
                            "LM Studio server reachable at {}, but no LLMs are available.",
                            lm_opts.base_url
                        )
                    } else {
                        format!("LM Studio server reachable at {}.", lm_opts.base_url)
                    };
                    out.push(ProviderStatusEntry {
                        provider,
                        authorized: true,
                        verified: true,
                        mode: "local".into(),
                        account: None,
                        message: msg,
                        checked_at: checked_at.clone(),
                        method_id: None,
                        saved_api_key_masks,
                        saved_field_masks,
                    });
                }
                Err(err_msg) => {
                    out.push(ProviderStatusEntry {
                        provider,
                        authorized: false,
                        verified: false,
                        mode: "error".into(),
                        account: None,
                        message: err_msg,
                        checked_at: checked_at.clone(),
                        method_id: None,
                        saved_api_key_masks,
                        saved_field_masks,
                    });
                }
            }
            continue;
        }

        if provider == ProviderName::Bedrock {
            let auth_opt = resolve_bedrock_auth_config(&opts.homedir, &opts.env, Some(&store));
            if let Some(auth) = auth_opt {
                let mut verified = false;
                let mut msg = "Amazon Bedrock credentials detected.".to_string();
                if store.services.contains_key(&ProviderName::Bedrock) {
                    msg = "Credentials saved.".to_string();
                }
                if refresh_bedrock_discovery {
                    let base_ov = opts
                        .base_url_overrides
                        .get(&ProviderName::Bedrock)
                        .map(String::as_str);
                    if let Ok(models) = discover_bedrock_models(&client, &auth, base_ov).await {
                        verified = true;
                        let scope = compute_bedrock_auth_fingerprint(&auth);
                        let _ = write_model_discovery_cache(
                            &paths,
                            ProviderName::Bedrock,
                            ModelDiscoveryResult {
                                provider: ProviderName::Bedrock,
                                source: ModelDiscoverySource::Api,
                                models,
                                updated_at: None,
                                expires_at: None,
                                message: None,
                            },
                            Some(&scope),
                            None,
                        )
                        .await;
                    }
                }
                let entry_mode = store
                    .services
                    .get(&ProviderName::Bedrock)
                    .map(|e| match e.mode {
                        ConnectionMode::ApiKey => "api_key",
                        ConnectionMode::Oauth => "oauth",
                        ConnectionMode::OauthPending => "oauth_pending",
                        ConnectionMode::Credentials => "credentials",
                    })
                    .unwrap_or("credentials");
                out.push(ProviderStatusEntry {
                    provider,
                    authorized: true,
                    verified,
                    mode: entry_mode.into(),
                    account: None,
                    message: msg,
                    checked_at: checked_at.clone(),
                    method_id: Some(auth.method_id),
                    saved_api_key_masks,
                    saved_field_masks,
                });
                continue;
            }
        }

        if provider == ProviderName::CodexCli {
            if let Some(entry) = store.services.get(&ProviderName::CodexCli)
                && entry.mode == ConnectionMode::ApiKey
                && entry
                    .api_key
                    .as_deref()
                    .is_some_and(|s| !s.trim().is_empty())
            {
                out.push(ProviderStatusEntry {
                    provider,
                    authorized: true,
                    verified: false,
                    mode: "api_key".into(),
                    account: None,
                    message: "API key saved.".into(),
                    checked_at: checked_at.clone(),
                    method_id: None,
                    saved_api_key_masks,
                    saved_field_masks,
                });
                continue;
            }
            if paths.codex_auth_dir.join("auth.json").is_file() {
                out.push(ProviderStatusEntry {
                    provider,
                    authorized: true,
                    verified: true,
                    mode: "oauth".into(),
                    account: None,
                    message: "ChatGPT account verified.".into(),
                    checked_at: checked_at.clone(),
                    method_id: Some("oauth_cli".into()),
                    saved_api_key_masks,
                    saved_field_masks,
                });
                continue;
            }
        }

        if is_api_discovery_provider(provider)
            && stored_provider_api_key(&store, provider).is_none()
            && resolve_provider_api_key(provider, None, &opts.env).is_some()
        {
            out.push(ProviderStatusEntry {
                provider,
                authorized: true,
                verified: false,
                mode: "api_key".into(),
                account: None,
                message: "Using an environment API key.".into(),
                checked_at: checked_at.clone(),
                method_id: None,
                saved_api_key_masks,
                saved_field_masks,
            });
            continue;
        }

        let Some(entry) = store.services.get(&provider) else {
            out.push(ProviderStatusEntry {
                provider,
                authorized: false,
                verified: false,
                mode: "missing".into(),
                account: None,
                message: "Not connected.".into(),
                checked_at: checked_at.clone(),
                method_id: None,
                saved_api_key_masks,
                saved_field_masks,
            });
            continue;
        };

        let (authorized, mode, message) = match entry.mode {
            ConnectionMode::ApiKey => {
                let has = entry
                    .api_key
                    .as_deref()
                    .is_some_and(|s| !s.trim().is_empty());
                (
                    has,
                    "api_key",
                    if has {
                        "API key saved."
                    } else {
                        "API key missing."
                    },
                )
            }
            ConnectionMode::OauthPending => (
                false,
                "oauth_pending",
                "Pending connection (no credentials).",
            ),
            ConnectionMode::Oauth => (true, "oauth", "OAuth connected."),
            ConnectionMode::Credentials => (true, "credentials", "Credentials saved."),
        };

        out.push(ProviderStatusEntry {
            provider,
            authorized,
            verified: false,
            mode: mode.into(),
            account: None,
            message: message.into(),
            checked_at: checked_at.clone(),
            method_id: entry.method_id.clone(),
            saved_api_key_masks,
            saved_field_masks,
        });
    }

    out
}
