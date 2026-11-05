use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use chrono::Utc;
use cowork_config::{ProviderName, ToolCallingStrategy};
use cowork_inference::ToolDefinition;
use reqwest::header::{ACCEPT, AUTHORIZATION, HeaderMap, HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use url::Url;

use crate::sse::build_http_client;

/// Internal request-scoped `provider_options` key carrying the resolved [`NativeToolCallingPlan`].
/// Keeping this in `provider_options` avoids breaking `ProviderStepRequest` / `ToolDefinition`
/// struct literals while automatically participating in continuation fingerprints.
pub const COWORK_NATIVE_TOOL_CALLING_OPTION_KEY: &str = "__coworkNativeToolCalling";

/// Core workspace tools kept eagerly loaded (`defer_loading: false`) when native tool search is
/// enabled, matching Cowork's harness `CORE_EAGER_TOOLS`.
pub const NATIVE_EAGER_CORE_TOOLS: &[&str] = &["bash", "read", "write", "edit", "glob", "grep"];

/// Tools that must never be invoked from inside a provider-hosted code execution container
/// (either interactive user-prompt tools or harness-only meta-dispatch tools).
const NON_PROGRAMMATIC_TOOL_NAMES: &[&str] = &[
    "askUserQuestion",
    "toolSearch",
    "toolCall",
    "mcpCall",
    "codeMode",
];

const ANTHROPIC_API_VERSION: &str = "2023-06-01";
const DEFAULT_CAPABILITY_CACHE_TTL: Duration = Duration::from_secs(15 * 60);
const DEFAULT_ENDPOINT_CHECK_TIMEOUT: Duration = Duration::from_millis(2_500);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NativeToolSearchKind {
    OpenAiResponses,
    OpenRouterResponses,
    AnthropicBm25,
    AnthropicRegex,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NativeProgrammaticToolCallingKind {
    OpenAiResponses,
    AnthropicCodeExecution20260120,
    CodexCodeMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EndpointCapabilitySource {
    StaticClassifier,
    EndpointCheck,
    RuntimeFallback,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointToolCapabilities {
    pub provider: String,
    pub model_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint_host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_tool_search: Option<NativeToolSearchKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_programmatic_tool_calling: Option<NativeProgrammaticToolCallingKind>,
    pub source: EndpointCapabilitySource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checked_at_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl EndpointToolCapabilities {
    pub fn none() -> Self {
        Self {
            provider: String::new(),
            model_id: String::new(),
            endpoint_host: None,
            native_tool_search: None,
            native_programmatic_tool_calling: None,
            source: EndpointCapabilitySource::StaticClassifier,
            checked_at_ms: None,
            detail: None,
        }
    }

    pub fn apply_strategy(mut self, provider: ProviderName, strategy: ToolCallingStrategy) -> Self {
        match strategy {
            ToolCallingStrategy::Auto => self,
            ToolCallingStrategy::Harness => {
                self.native_tool_search = None;
                self.native_programmatic_tool_calling = None;
                self
            }
            ToolCallingStrategy::Native => {
                match provider {
                    ProviderName::Openai => {
                        let is_openrouter = self
                            .endpoint_host
                            .as_deref()
                            .is_some_and(is_openrouter_host);
                        if self.native_tool_search.is_none() {
                            self.native_tool_search = Some(if is_openrouter {
                                NativeToolSearchKind::OpenRouterResponses
                            } else {
                                NativeToolSearchKind::OpenAiResponses
                            });
                        }
                        if !is_openrouter && self.native_programmatic_tool_calling.is_none() {
                            self.native_programmatic_tool_calling =
                                Some(NativeProgrammaticToolCallingKind::OpenAiResponses);
                        }
                    }
                    ProviderName::Anthropic => {
                        let is_openrouter = self
                            .endpoint_host
                            .as_deref()
                            .is_some_and(is_openrouter_host);
                        if self.native_tool_search.is_none() {
                            self.native_tool_search = Some(if is_openrouter {
                                NativeToolSearchKind::AnthropicRegex
                            } else {
                                NativeToolSearchKind::AnthropicBm25
                            });
                        }
                        if !is_openrouter && self.native_programmatic_tool_calling.is_none() {
                            self.native_programmatic_tool_calling = Some(
                                NativeProgrammaticToolCallingKind::AnthropicCodeExecution20260120,
                            );
                        }
                    }
                    ProviderName::CodexCli if self.native_programmatic_tool_calling.is_none() => {
                        self.native_programmatic_tool_calling =
                            Some(NativeProgrammaticToolCallingKind::CodexCodeMode);
                    }
                    _ => {}
                }
                self
            }
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeToolCallingPlan {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_search: Option<NativeToolSearchKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub programmatic_tool_calling: Option<NativeProgrammaticToolCallingKind>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub deferred_tool_names: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub programmatic_tool_names: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codex_code_mode: Option<bool>,
}

impl NativeToolCallingPlan {
    pub fn is_empty(&self) -> bool {
        self.tool_search.is_none()
            && self.programmatic_tool_calling.is_none()
            && self.deferred_tool_names.is_empty()
            && self.programmatic_tool_names.is_empty()
            && self.codex_code_mode.is_none()
    }
}

pub fn read_native_tool_calling_plan(
    provider_options: &Map<String, Value>,
) -> Option<NativeToolCallingPlan> {
    let raw = provider_options.get(COWORK_NATIVE_TOOL_CALLING_OPTION_KEY)?;
    serde_json::from_value(raw.clone()).ok()
}

pub fn write_native_tool_calling_plan(
    provider_options: &mut Map<String, Value>,
    plan: &NativeToolCallingPlan,
) {
    if plan.is_empty() {
        provider_options.remove(COWORK_NATIVE_TOOL_CALLING_OPTION_KEY);
    } else if let Ok(val) = serde_json::to_value(plan) {
        provider_options.insert(COWORK_NATIVE_TOOL_CALLING_OPTION_KEY.to_string(), val);
    }
}

pub fn strip_native_tool_calling_plan(provider_options: &mut Map<String, Value>) {
    provider_options.remove(COWORK_NATIVE_TOOL_CALLING_OPTION_KEY);
}

pub fn is_native_eager_core_tool(name: &str) -> bool {
    NATIVE_EAGER_CORE_TOOLS
        .iter()
        .any(|core| core.eq_ignore_ascii_case(name))
}

fn json_contains_ref(value: &Value) -> bool {
    match value {
        Value::Object(map) => map.contains_key("$ref") || map.values().any(json_contains_ref),
        Value::Array(items) => items.iter().any(json_contains_ref),
        _ => false,
    }
}

pub fn is_programmatic_eligible_tool(
    def: &ToolDefinition,
    kind: NativeProgrammaticToolCallingKind,
) -> bool {
    if NON_PROGRAMMATIC_TOOL_NAMES
        .iter()
        .any(|blocked| blocked.eq_ignore_ascii_case(&def.name))
    {
        return false;
    }
    if kind == NativeProgrammaticToolCallingKind::AnthropicCodeExecution20260120
        && json_contains_ref(&def.parameters)
    {
        return false;
    }
    true
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct CapabilityCacheKey {
    provider: ProviderName,
    base_url_key: String,
    model_id: String,
}

#[derive(Debug, Clone)]
struct CachedCapabilityEntry {
    capabilities: EndpointToolCapabilities,
    expires_at: Instant,
    rejected_tool_search: bool,
    rejected_ptc: bool,
}

static CAPABILITY_CACHE: OnceLock<
    parking_lot::RwLock<HashMap<CapabilityCacheKey, CachedCapabilityEntry>>,
> = OnceLock::new();

fn capability_cache()
-> &'static parking_lot::RwLock<HashMap<CapabilityCacheKey, CachedCapabilityEntry>> {
    CAPABILITY_CACHE.get_or_init(|| parking_lot::RwLock::new(HashMap::new()))
}

pub fn clear_endpoint_capability_cache_for_tests() {
    capability_cache().write().clear();
}

fn effective_base_url(provider: ProviderName, base_url: Option<&str>) -> String {
    base_url
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| crate::default_inference_base_url(provider))
        .trim_end_matches('/')
        .to_string()
}

pub fn parse_endpoint_host(raw_url: &str) -> Option<String> {
    if raw_url.trim().is_empty() {
        return None;
    }
    Url::parse(raw_url.trim())
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_ascii_lowercase()))
}

fn cache_key(provider: ProviderName, base_url: Option<&str>, model_id: &str) -> CapabilityCacheKey {
    CapabilityCacheKey {
        provider,
        base_url_key: effective_base_url(provider, base_url).to_ascii_lowercase(),
        model_id: model_id.trim().to_ascii_lowercase(),
    }
}

fn strip_provider_prefix(model_id: &str) -> &str {
    let trimmed = model_id.trim();
    match trimmed.rsplit_once('/') {
        Some((_, tail)) if !tail.is_empty() => tail,
        _ => trimmed,
    }
}

fn is_official_openai_host(host: &str) -> bool {
    host == "api.openai.com" || host.ends_with(".api.openai.com")
}

fn is_official_anthropic_host(host: &str) -> bool {
    host == "api.anthropic.com" || host.ends_with(".anthropic.com")
}

pub fn is_openrouter_host(host: &str) -> bool {
    host == "openrouter.ai" || host.ends_with(".openrouter.ai")
}

/// OpenAI Responses native `tool_search` and `programmatic_tool_calling` require GPT-5.4+ models.
pub fn openai_model_supports_native_tool_features(model_id: &str) -> bool {
    let bare = strip_provider_prefix(model_id).to_ascii_lowercase();
    let Some(rest) = bare.strip_prefix("gpt-") else {
        return false;
    };
    let version_head: String = rest
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    if version_head.is_empty() {
        return false;
    }
    let mut parts = version_head.split('.');
    let Some(major) = parts.next().and_then(|s| s.parse::<u32>().ok()) else {
        return false;
    };
    let minor = parts
        .next()
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(0);
    major > 5 || (major == 5 && minor >= 4)
}

/// Anthropic Messages native `tool_search_tool_*` and `code_execution_20260120` PTC are supported
/// on Claude Sonnet 4+ and Claude Opus 4+ models (Opus 4.5/4.6, Sonnet 4.5/4.6, and newer).
pub fn anthropic_model_supports_native_tool_features(model_id: &str) -> bool {
    let bare = strip_provider_prefix(model_id).to_ascii_lowercase();
    if !bare.starts_with("claude-") {
        return false;
    }
    if bare.contains("haiku-3") || bare.contains("sonnet-3") || bare.contains("opus-3") {
        return false;
    }
    // Haiku 4.5 does not support programmatic tool calling / tool search in Anthropic's model matrix.
    if bare.contains("haiku-4-5") || bare.contains("haiku-4.5") {
        return false;
    }
    bare.contains("opus-4")
        || bare.contains("sonnet-4")
        || bare.contains("opus-5")
        || bare.contains("sonnet-5")
        || bare.contains("claude-4")
        || bare.contains("claude-5")
}

pub fn classify_static_endpoint_capabilities(
    provider: ProviderName,
    base_url: Option<&str>,
    model_id: &str,
) -> EndpointToolCapabilities {
    let eff_url = effective_base_url(provider, base_url);
    let host = parse_endpoint_host(&eff_url);

    match provider {
        ProviderName::CodexCli => EndpointToolCapabilities {
            provider: provider.as_str().to_string(),
            model_id: model_id.to_string(),
            endpoint_host: None,
            native_tool_search: None,
            native_programmatic_tool_calling: Some(
                NativeProgrammaticToolCallingKind::CodexCodeMode,
            ),
            source: EndpointCapabilitySource::StaticClassifier,
            checked_at_ms: None,
            detail: Some("Codex App-Server native code_mode feature".to_string()),
        },
        ProviderName::Openai => {
            let model_ok = openai_model_supports_native_tool_features(model_id);
            let (ts, ptc, detail) = match host.as_deref() {
                Some(h) if is_official_openai_host(h) => {
                    if model_ok {
                        (
                            Some(NativeToolSearchKind::OpenAiResponses),
                            Some(NativeProgrammaticToolCallingKind::OpenAiResponses),
                            Some(
                                "OpenAI Responses native tool_search + programmatic_tool_calling"
                                    .to_string(),
                            ),
                        )
                    } else {
                        (
                            None,
                            None,
                            Some(format!(
                                "Model '{model_id}' uses Cowork harness (OpenAI native tool_search/PTC requires gpt-5.4+)"
                            )),
                        )
                    }
                }
                Some(h) if is_openrouter_host(h) => {
                    if model_ok {
                        (
                            Some(NativeToolSearchKind::OpenRouterResponses),
                            None,
                            Some("OpenRouter Responses openrouter:tool_search + Cowork QuickJS codeMode".to_string()),
                        )
                    } else {
                        (
                            None,
                            None,
                            Some(format!("OpenRouter model '{model_id}' uses Cowork harness")),
                        )
                    }
                }
                Some(h) => (
                    None,
                    None,
                    Some(format!(
                        "Custom OpenAI Responses endpoint '{h}' defaults to Cowork harness until verified via endpoint check"
                    )),
                ),
                None => (None, None, None),
            };
            EndpointToolCapabilities {
                provider: provider.as_str().to_string(),
                model_id: model_id.to_string(),
                endpoint_host: host,
                native_tool_search: ts,
                native_programmatic_tool_calling: ptc,
                source: EndpointCapabilitySource::StaticClassifier,
                checked_at_ms: None,
                detail,
            }
        }
        ProviderName::Anthropic => {
            let model_ok = anthropic_model_supports_native_tool_features(model_id);
            let (ts, ptc, detail) = match host.as_deref() {
                Some(h) if is_official_anthropic_host(h) => {
                    if model_ok {
                        (
                            Some(NativeToolSearchKind::AnthropicBm25),
                            Some(NativeProgrammaticToolCallingKind::AnthropicCodeExecution20260120),
                            Some("Anthropic Messages native BM25 tool search + code_execution_20260120 PTC".to_string()),
                        )
                    } else {
                        (
                            None,
                            None,
                            Some(format!(
                                "Model '{model_id}' uses Cowork harness (Anthropic native tool search/PTC requires Claude Sonnet/Opus 4+)"
                            )),
                        )
                    }
                }
                Some(h) if is_openrouter_host(h) => {
                    if model_ok {
                        (
                            Some(NativeToolSearchKind::AnthropicRegex),
                            None,
                            Some(
                                "OpenRouter Anthropic regex tool search + Cowork QuickJS codeMode"
                                    .to_string(),
                            ),
                        )
                    } else {
                        (
                            None,
                            None,
                            Some(format!("OpenRouter model '{model_id}' uses Cowork harness")),
                        )
                    }
                }
                Some(h) => (
                    None,
                    None,
                    Some(format!(
                        "Custom Anthropic endpoint '{h}' defaults to Cowork harness until verified via /v1/models/{model_id}"
                    )),
                ),
                None => (None, None, None),
            };
            EndpointToolCapabilities {
                provider: provider.as_str().to_string(),
                model_id: model_id.to_string(),
                endpoint_host: host,
                native_tool_search: ts,
                native_programmatic_tool_calling: ptc,
                source: EndpointCapabilitySource::StaticClassifier,
                checked_at_ms: None,
                detail,
            }
        }
        _ => EndpointToolCapabilities {
            provider: provider.as_str().to_string(),
            model_id: model_id.to_string(),
            endpoint_host: host,
            native_tool_search: None,
            native_programmatic_tool_calling: None,
            source: EndpointCapabilitySource::StaticClassifier,
            checked_at_ms: None,
            detail: Some(format!(
                "Provider '{}' uses Cowork's built-in Rust toolSearch and QuickJS codeMode harness",
                provider.as_str()
            )),
        },
    }
}

/// Resolves cached or static endpoint tool capabilities synchronously.
pub fn resolve_endpoint_tool_capabilities(
    provider: ProviderName,
    base_url: Option<&str>,
    model_id: &str,
    strategy: ToolCallingStrategy,
) -> EndpointToolCapabilities {
    let key = cache_key(provider, base_url, model_id);
    let now = Instant::now();
    if let Some(entry) = capability_cache().read().get(&key).cloned()
        && (entry.expires_at > now || entry.rejected_tool_search || entry.rejected_ptc)
    {
        let mut caps = entry.capabilities.apply_strategy(provider, strategy);
        // Even in `Auto`, honor runtime rejections recorded from an actual HTTP 400.
        if strategy == ToolCallingStrategy::Auto {
            if entry.rejected_tool_search {
                caps.native_tool_search = None;
            }
            if entry.rejected_ptc {
                caps.native_programmatic_tool_calling = None;
            }
        }
        return caps;
    }

    classify_static_endpoint_capabilities(provider, base_url, model_id)
        .apply_strategy(provider, strategy)
}

/// Returns whether a fresh active endpoint check is already cached for `(provider, base_url, model_id)`.
pub fn has_cached_endpoint_check(
    provider: ProviderName,
    base_url: Option<&str>,
    model_id: &str,
) -> bool {
    let key = cache_key(provider, base_url, model_id);
    let now = Instant::now();
    capability_cache().read().get(&key).is_some_and(|entry| {
        entry.expires_at > now
            && matches!(
                entry.capabilities.source,
                EndpointCapabilitySource::EndpointCheck | EndpointCapabilitySource::RuntimeFallback
            )
    })
}

/// Records that an endpoint rejected native tool search and/or programmatic tool calling at runtime
/// (e.g. HTTP 400 unsupported tool type), downgrading future turns immediately.
pub fn record_rejected_native_capability(
    provider: ProviderName,
    base_url: Option<&str>,
    model_id: &str,
    reject_tool_search: bool,
    reject_ptc: bool,
    reason: &str,
) {
    let key = cache_key(provider, base_url, model_id);
    let now_ms = Utc::now().timestamp_millis().max(0) as u64;
    let expires_at = Instant::now() + DEFAULT_CAPABILITY_CACHE_TTL;
    let mut guard = capability_cache().write();
    let base_caps = guard
        .get(&key)
        .map(|e| e.capabilities.clone())
        .unwrap_or_else(|| classify_static_endpoint_capabilities(provider, base_url, model_id));
    let prev_rej_ts = guard.get(&key).is_some_and(|e| e.rejected_tool_search);
    let prev_rej_ptc = guard.get(&key).is_some_and(|e| e.rejected_ptc);

    let rejected_tool_search = prev_rej_ts || reject_tool_search;
    let rejected_ptc = prev_rej_ptc || reject_ptc;

    let updated = EndpointToolCapabilities {
        provider: base_caps.provider,
        model_id: base_caps.model_id,
        endpoint_host: base_caps.endpoint_host,
        native_tool_search: if rejected_tool_search {
            None
        } else {
            base_caps.native_tool_search
        },
        native_programmatic_tool_calling: if rejected_ptc {
            None
        } else {
            base_caps.native_programmatic_tool_calling
        },
        source: EndpointCapabilitySource::RuntimeFallback,
        checked_at_ms: Some(now_ms),
        detail: Some(format!(
            "Endpoint rejected native tool feature; fell back to Cowork harness ({reason})"
        )),
    };

    guard.insert(
        key,
        CachedCapabilityEntry {
            capabilities: updated,
            expires_at,
            rejected_tool_search,
            rejected_ptc,
        },
    );
}

fn encode_model_path_segment(model_id: &str) -> String {
    url::form_urlencoded::byte_serialize(model_id.trim().as_bytes()).collect()
}

/// Actively probes the provider's `/models/{model_id}` endpoint to verify native tool search and
/// programmatic tool calling support, caching the result process-wide.
pub async fn check_endpoint_capabilities(
    provider: ProviderName,
    base_url: Option<&str>,
    model_id: &str,
    api_key: Option<&str>,
    extra_headers: Option<&HashMap<String, String>>,
    force_refresh: bool,
) -> EndpointToolCapabilities {
    let key = cache_key(provider, base_url, model_id);
    if !force_refresh {
        let now = Instant::now();
        if let Some(entry) = capability_cache().read().get(&key)
            && entry.expires_at > now
            && matches!(
                entry.capabilities.source,
                EndpointCapabilitySource::EndpointCheck | EndpointCapabilitySource::RuntimeFallback
            )
        {
            return entry.capabilities.clone();
        }
    }

    let static_caps = classify_static_endpoint_capabilities(provider, base_url, model_id);
    let now_ms = Utc::now().timestamp_millis().max(0) as u64;

    if !matches!(provider, ProviderName::Openai | ProviderName::Anthropic) {
        let mut caps = static_caps;
        caps.checked_at_ms = Some(now_ms);
        return caps;
    }

    let Some(key_str) = api_key.map(str::trim).filter(|k| !k.is_empty()) else {
        let mut caps = static_caps;
        caps.checked_at_ms = Some(now_ms);
        caps.detail = Some(match caps.detail {
            Some(d) => format!("{d} (no API key configured for live endpoint probe)"),
            None => "No API key configured for live endpoint probe".to_string(),
        });
        return caps;
    };

    let Ok(client) = build_http_client() else {
        return static_caps;
    };

    let eff_base = effective_base_url(provider, base_url);
    let host = parse_endpoint_host(&eff_base);

    let probed = match provider {
        ProviderName::Anthropic => {
            probe_anthropic_model_endpoint(
                &client,
                &eff_base,
                host.as_deref(),
                model_id,
                key_str,
                extra_headers,
                &static_caps,
                now_ms,
            )
            .await
        }
        ProviderName::Openai => {
            probe_openai_model_endpoint(
                &client,
                &eff_base,
                host.as_deref(),
                model_id,
                key_str,
                extra_headers,
                &static_caps,
                now_ms,
            )
            .await
        }
        _ => unreachable!(),
    };

    let expires_at = Instant::now() + DEFAULT_CAPABILITY_CACHE_TTL;
    let mut guard = capability_cache().write();
    let prev_rej_ts = if force_refresh {
        false
    } else {
        guard.get(&key).is_some_and(|e| e.rejected_tool_search)
    };
    let prev_rej_ptc = if force_refresh {
        false
    } else {
        guard.get(&key).is_some_and(|e| e.rejected_ptc)
    };
    let mut stored = probed.clone();
    if prev_rej_ts {
        stored.native_tool_search = None;
    }
    if prev_rej_ptc {
        stored.native_programmatic_tool_calling = None;
    }
    guard.insert(
        key,
        CachedCapabilityEntry {
            capabilities: stored.clone(),
            expires_at,
            rejected_tool_search: prev_rej_ts,
            rejected_ptc: prev_rej_ptc,
        },
    );
    stored
}

#[allow(clippy::too_many_arguments)]
async fn probe_anthropic_model_endpoint(
    client: &reqwest::Client,
    eff_base: &str,
    host: Option<&str>,
    model_id: &str,
    api_key: &str,
    extra_headers: Option<&HashMap<String, String>>,
    static_caps: &EndpointToolCapabilities,
    now_ms: u64,
) -> EndpointToolCapabilities {
    let encoded_model = encode_model_path_segment(strip_provider_prefix(model_id));
    let url = if eff_base.ends_with("/v1") {
        format!("{eff_base}/models/{encoded_model}")
    } else {
        format!("{eff_base}/v1/models/{encoded_model}")
    };

    let mut headers = HeaderMap::new();
    headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
    headers.insert(
        HeaderName::from_static("anthropic-version"),
        HeaderValue::from_static(ANTHROPIC_API_VERSION),
    );
    let is_oauth = api_key.contains("sk-ant-oat");
    if is_oauth {
        if let Ok(v) = HeaderValue::from_str(&format!("Bearer {api_key}")) {
            headers.insert(AUTHORIZATION, v);
        }
    } else if let Ok(v) = HeaderValue::from_str(api_key) {
        headers.insert(HeaderName::from_static("x-api-key"), v);
    }
    if let Some(extra) = extra_headers {
        for (k, v) in extra {
            if let (Ok(name), Ok(val)) = (
                HeaderName::from_bytes(k.as_bytes()),
                HeaderValue::from_str(v),
            ) {
                headers.insert(name, val);
            }
        }
    }

    let is_official = host.is_some_and(is_official_anthropic_host);
    let is_openrouter = host.is_some_and(is_openrouter_host);

    let resp = match client
        .get(&url)
        .headers(headers)
        .timeout(DEFAULT_ENDPOINT_CHECK_TIMEOUT)
        .send()
        .await
    {
        Ok(r) => r,
        Err(err) => {
            return EndpointToolCapabilities {
                provider: static_caps.provider.clone(),
                model_id: model_id.to_string(),
                endpoint_host: static_caps.endpoint_host.clone(),
                native_tool_search: if is_official || is_openrouter {
                    static_caps.native_tool_search
                } else {
                    None
                },
                native_programmatic_tool_calling: if is_official {
                    static_caps.native_programmatic_tool_calling
                } else {
                    None
                },
                source: EndpointCapabilitySource::EndpointCheck,
                checked_at_ms: Some(now_ms),
                detail: Some(format!(
                    "Endpoint probe failed ({err}); using fallback resolution"
                )),
            };
        }
    };

    let status = resp.status();
    let body_json: Option<Value> = resp.json().await.ok();

    if status.is_success()
        && let Some(json) = body_json
    {
        let caps_obj = json.get("capabilities").and_then(Value::as_object);
        let code_exec_supported = caps_obj
            .and_then(|c| c.get("code_execution"))
            .and_then(|ce| {
                ce.as_bool()
                    .or_else(|| ce.get("supported").and_then(Value::as_bool))
            });
        let tool_search_supported = caps_obj.and_then(|c| c.get("tool_search")).and_then(|ts| {
            ts.as_bool()
                .or_else(|| ts.get("supported").and_then(Value::as_bool))
        });
        let model_ok = anthropic_model_supports_native_tool_features(
            json.get("id").and_then(Value::as_str).unwrap_or(model_id),
        );
        let is_anthropic_model_payload = json.get("type").and_then(Value::as_str) == Some("model");

        let native_ptc = match code_exec_supported {
            Some(true) if !is_openrouter && model_ok => {
                Some(NativeProgrammaticToolCallingKind::AnthropicCodeExecution20260120)
            }
            Some(true) if !is_openrouter && caps_obj.is_some() => {
                Some(NativeProgrammaticToolCallingKind::AnthropicCodeExecution20260120)
            }
            Some(false) => None,
            None if (is_official || is_anthropic_model_payload) && !is_openrouter && model_ok => {
                Some(NativeProgrammaticToolCallingKind::AnthropicCodeExecution20260120)
            }
            _ => None,
        };

        let native_ts = match tool_search_supported {
            Some(true) => Some(if is_openrouter {
                NativeToolSearchKind::AnthropicRegex
            } else {
                NativeToolSearchKind::AnthropicBm25
            }),
            Some(false) => None,
            None if is_openrouter && model_ok => Some(NativeToolSearchKind::AnthropicRegex),
            None if (is_official || is_anthropic_model_payload) && model_ok => {
                // If `capabilities` explicitly disabled `code_execution` on an older/small model,
                // keep tool_search aligned with `model_ok`.
                Some(NativeToolSearchKind::AnthropicBm25)
            }
            _ => None,
        };

        return EndpointToolCapabilities {
            provider: "anthropic".to_string(),
            model_id: model_id.to_string(),
            endpoint_host: static_caps.endpoint_host.clone(),
            native_tool_search: native_ts,
            native_programmatic_tool_calling: native_ptc,
            source: EndpointCapabilitySource::EndpointCheck,
            checked_at_ms: Some(now_ms),
            detail: Some(format!(
                "Verified via GET /v1/models/{encoded_model} (HTTP {})",
                status.as_u16()
            )),
        };
    }

    // Scoped credentials or OAuth tokens on official Anthropic may return 401/403 on `/v1/models`.
    if (status.as_u16() == 401 || status.as_u16() == 403) && (is_official || is_openrouter) {
        return EndpointToolCapabilities {
            provider: "anthropic".to_string(),
            model_id: model_id.to_string(),
            endpoint_host: static_caps.endpoint_host.clone(),
            native_tool_search: static_caps.native_tool_search,
            native_programmatic_tool_calling: static_caps.native_programmatic_tool_calling,
            source: EndpointCapabilitySource::EndpointCheck,
            checked_at_ms: Some(now_ms),
            detail: Some(format!(
                "GET /v1/models/{encoded_model} returned HTTP {}; preserving static host/model capabilities",
                status.as_u16()
            )),
        };
    }

    EndpointToolCapabilities {
        provider: "anthropic".to_string(),
        model_id: model_id.to_string(),
        endpoint_host: static_caps.endpoint_host.clone(),
        native_tool_search: None,
        native_programmatic_tool_calling: None,
        source: EndpointCapabilitySource::EndpointCheck,
        checked_at_ms: Some(now_ms),
        detail: Some(format!(
            "GET /v1/models/{encoded_model} returned HTTP {}; using Cowork harness",
            status.as_u16()
        )),
    }
}

#[allow(clippy::too_many_arguments)]
async fn probe_openai_model_endpoint(
    client: &reqwest::Client,
    eff_base: &str,
    host: Option<&str>,
    model_id: &str,
    api_key: &str,
    extra_headers: Option<&HashMap<String, String>>,
    static_caps: &EndpointToolCapabilities,
    now_ms: u64,
) -> EndpointToolCapabilities {
    let is_official = host.is_some_and(is_official_openai_host);
    let is_openrouter = host.is_some_and(is_openrouter_host);
    let target_model = if is_openrouter {
        model_id.trim()
    } else {
        strip_provider_prefix(model_id)
    };
    let encoded_model = encode_model_path_segment(target_model);
    let url = format!("{eff_base}/models/{encoded_model}");

    let mut headers = HeaderMap::new();
    headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
    if let Ok(v) = HeaderValue::from_str(&format!("Bearer {api_key}")) {
        headers.insert(AUTHORIZATION, v);
    }
    if let Some(extra) = extra_headers {
        for (k, v) in extra {
            if let (Ok(name), Ok(val)) = (
                HeaderName::from_bytes(k.as_bytes()),
                HeaderValue::from_str(v),
            ) {
                headers.insert(name, val);
            }
        }
    }

    let resp = match client
        .get(&url)
        .headers(headers)
        .timeout(DEFAULT_ENDPOINT_CHECK_TIMEOUT)
        .send()
        .await
    {
        Ok(r) => r,
        Err(err) => {
            return EndpointToolCapabilities {
                provider: static_caps.provider.clone(),
                model_id: model_id.to_string(),
                endpoint_host: static_caps.endpoint_host.clone(),
                native_tool_search: if is_official || is_openrouter {
                    static_caps.native_tool_search
                } else {
                    None
                },
                native_programmatic_tool_calling: if is_official {
                    static_caps.native_programmatic_tool_calling
                } else {
                    None
                },
                source: EndpointCapabilitySource::EndpointCheck,
                checked_at_ms: Some(now_ms),
                detail: Some(format!(
                    "Endpoint probe failed ({err}); using fallback resolution"
                )),
            };
        }
    };

    let status = resp.status();
    let has_openai_processing_header = resp.headers().contains_key("openai-processing-ms");
    let body_json: Option<Value> = resp.json().await.ok();

    if status.is_success()
        && let Some(json) = body_json
    {
        let caps_obj = json.get("capabilities").and_then(Value::as_object);
        let explicit_ts = caps_obj.and_then(|c| c.get("tool_search")).and_then(|v| {
            v.as_bool()
                .or_else(|| v.get("supported").and_then(Value::as_bool))
        });
        let explicit_ptc = caps_obj
            .and_then(|c| c.get("programmatic_tool_calling"))
            .and_then(|v| {
                v.as_bool()
                    .or_else(|| v.get("supported").and_then(Value::as_bool))
            });

        let owned_by = json
            .get("owned_by")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_ascii_lowercase();
        let is_openai_owned = matches!(owned_by.as_str(), "openai" | "system" | "openai-internal")
            || has_openai_processing_header;
        let model_ok = openai_model_supports_native_tool_features(
            json.get("id").and_then(Value::as_str).unwrap_or(model_id),
        );

        let native_ts = match explicit_ts {
            Some(true) => Some(if is_openrouter {
                NativeToolSearchKind::OpenRouterResponses
            } else {
                NativeToolSearchKind::OpenAiResponses
            }),
            Some(false) => None,
            None if is_openrouter && model_ok => Some(NativeToolSearchKind::OpenRouterResponses),
            None if (is_official || is_openai_owned) && model_ok => {
                Some(NativeToolSearchKind::OpenAiResponses)
            }
            _ => None,
        };

        let native_ptc = match explicit_ptc {
            Some(true) if !is_openrouter => {
                Some(NativeProgrammaticToolCallingKind::OpenAiResponses)
            }
            Some(false) => None,
            None if (is_official || is_openai_owned) && !is_openrouter && model_ok => {
                Some(NativeProgrammaticToolCallingKind::OpenAiResponses)
            }
            _ => None,
        };

        return EndpointToolCapabilities {
            provider: "openai".to_string(),
            model_id: model_id.to_string(),
            endpoint_host: static_caps.endpoint_host.clone(),
            native_tool_search: native_ts,
            native_programmatic_tool_calling: native_ptc,
            source: EndpointCapabilitySource::EndpointCheck,
            checked_at_ms: Some(now_ms),
            detail: Some(format!(
                "Verified via GET /models/{encoded_model} (HTTP {})",
                status.as_u16()
            )),
        };
    }

    // Scoped OpenAI project keys without `model.read` return 401/403 on `/v1/models/{id}` even
    // when `/v1/responses` works; OpenRouter `/models/{author/slug}` may 404 on single-item GET.
    if ((status.as_u16() == 401 || status.as_u16() == 403) && is_official)
        || (is_openrouter
            && (status.as_u16() == 404 || status.as_u16() == 401 || status.as_u16() == 403))
    {
        return EndpointToolCapabilities {
            provider: "openai".to_string(),
            model_id: model_id.to_string(),
            endpoint_host: static_caps.endpoint_host.clone(),
            native_tool_search: static_caps.native_tool_search,
            native_programmatic_tool_calling: static_caps.native_programmatic_tool_calling,
            source: EndpointCapabilitySource::EndpointCheck,
            checked_at_ms: Some(now_ms),
            detail: Some(format!(
                "GET /models/{encoded_model} returned HTTP {}; preserving host/model capabilities",
                status.as_u16()
            )),
        };
    }

    EndpointToolCapabilities {
        provider: "openai".to_string(),
        model_id: model_id.to_string(),
        endpoint_host: static_caps.endpoint_host.clone(),
        native_tool_search: None,
        native_programmatic_tool_calling: None,
        source: EndpointCapabilitySource::EndpointCheck,
        checked_at_ms: Some(now_ms),
        detail: Some(format!(
            "GET /models/{encoded_model} returned HTTP {}; using Cowork harness",
            status.as_u16()
        )),
    }
}
