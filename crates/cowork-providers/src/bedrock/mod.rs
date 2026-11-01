pub mod auth;
pub mod discovery;
pub mod eventstream;

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

use async_trait::async_trait;
use chrono::Utc;
use cowork_config::{
    ProviderName, env_map_from_process, get_ai_coworker_paths, host_platform,
    read_connection_store_sync, resolve_home_dir,
};
use cowork_inference::{
    CanonicalMessage, ContentBlock, MediaKind, MediaSource, MessageRole, ProviderOpaqueMeta,
    ProviderTransportError, ReasoningStreamMode, StepBudget, StopReason, StreamEvent,
    ToolResultPart, TurnUsage, execute_step_with_sink, filter_persisted_assistant_history,
    parse_partial_json_object, split_openai_tool_call_id,
};
use futures_util::StreamExt;
use reqwest::header::{ACCEPT, CONTENT_TYPE, HeaderMap, HeaderName, HeaderValue};
use serde_json::{Map, Value, json};
use uuid::Uuid;

use crate::sse::build_http_client;
use crate::transport::{
    ProviderStepRequest, ProviderStepResult, ProviderTransport, StreamEventCallback, ToolDefinition,
};

pub use auth::{
    BedrockAuthConfig, BedrockAuthMethod, mask_bedrock_field_values,
    percent_encode_bedrock_model_id, resolve_bedrock_auth_config,
    should_use_explicit_bedrock_endpoint, sign_bedrock_request, try_resolve_bedrock_auth_config,
};
pub use discovery::{compute_bedrock_auth_fingerprint, discover_bedrock_models};
pub use eventstream::{
    BedrockDecodedEvent, BedrockStreamFrameDecoder, encode_eventstream_exception_frame,
    encode_eventstream_json_frame,
};

fn read_bedrock_opt<'a>(opts: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    opts.get("bedrock")
        .and_then(Value::as_object)
        .and_then(|sub| sub.get(key))
        .or_else(|| opts.get(key))
}

pub fn extract_bedrock_region_override(provider_options: &Map<String, Value>) -> Option<String> {
    read_bedrock_opt(provider_options, "region")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
}

fn homedir_from_cowork_home_option(raw: &str) -> PathBuf {
    let p = PathBuf::from(raw.trim());
    if p.file_name().and_then(|n| n.to_str()) == Some(".cowork") {
        p.parent().map(Path::to_path_buf).unwrap_or(p)
    } else {
        p
    }
}

#[derive(Debug, Clone)]
pub struct BedrockConverseTransport {
    client: reqwest::Client,
    pub explicit_auth: Option<BedrockAuthConfig>,
    isolated_context: Option<(PathBuf, HashMap<String, String>)>,
}

impl Default for BedrockConverseTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl BedrockConverseTransport {
    pub fn new() -> Self {
        Self {
            client: build_http_client().expect("rustls HTTP client"),
            explicit_auth: None,
            isolated_context: None,
        }
    }

    pub fn with_auth(auth: BedrockAuthConfig) -> Self {
        Self {
            client: build_http_client().expect("rustls HTTP client"),
            explicit_auth: Some(auth),
            isolated_context: None,
        }
    }

    pub fn with_isolated_env(homedir: PathBuf, env: HashMap<String, String>) -> Self {
        Self {
            client: build_http_client().expect("rustls HTTP client"),
            explicit_auth: None,
            isolated_context: Some((homedir, env)),
        }
    }

    pub fn client(&self) -> &reqwest::Client {
        &self.client
    }

    fn resolve_auth(
        &self,
        request: &ProviderStepRequest,
    ) -> Result<BedrockAuthConfig, ProviderTransportError> {
        let region_override = extract_bedrock_region_override(&request.provider_options);

        if let Some(explicit) = &self.explicit_auth {
            let mut cfg = explicit.clone();
            if let Some(reg) = region_override {
                cfg.region = reg;
                cfg.has_configured_region = true;
            }
            return Ok(cfg);
        }

        let (homedir, env) = if let Some((h, e)) = &self.isolated_context {
            (h.clone(), e.clone())
        } else if let Some(cowork_home_raw) =
            read_bedrock_opt(&request.provider_options, "coworkHome")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
        {
            let h = homedir_from_cowork_home_option(cowork_home_raw);
            let mut isolated_env = HashMap::new();
            isolated_env.insert("HOME".to_string(), h.to_string_lossy().into_owned());
            isolated_env.insert(
                "COWORK_HOME_OVERRIDE".to_string(),
                h.to_string_lossy().into_owned(),
            );
            (h, isolated_env)
        } else {
            let proc_env = env_map_from_process();
            let h = resolve_home_dir(&proc_env, host_platform());
            (h, proc_env)
        };

        let paths = get_ai_coworker_paths(Some(&homedir), &env);
        let store = read_connection_store_sync(&paths).ok();

        if let Some(key) = request
            .api_key
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            let saved_region = store
                .as_ref()
                .and_then(|s| s.services.get(&ProviderName::Bedrock))
                .and_then(|c| c.values.as_ref())
                .and_then(|v| v.get("region"))
                .map(String::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToOwned::to_owned);
            let env_region = env
                .get("AWS_REGION")
                .or_else(|| env.get("AWS_DEFAULT_REGION"))
                .map(String::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToOwned::to_owned);
            let has_configured_region =
                region_override.is_some() || saved_region.is_some() || env_region.is_some();
            let region = region_override
                .or(saved_region)
                .or(env_region)
                .unwrap_or_else(|| "us-east-1".to_string());
            return Ok(BedrockAuthConfig {
                method_id: "api_key".into(),
                source: "request".into(),
                region,
                has_configured_region,
                has_configured_profile: false,
                auth: BedrockAuthMethod::BearerToken {
                    token: key.to_string(),
                },
            });
        }

        let mut resolved = try_resolve_bedrock_auth_config(&homedir, &env, store.as_ref())
            .map_err(|reason| {
                ProviderTransportError::protocol(format!(
                    "Amazon Bedrock credentials are unavailable: {reason}"
                ))
            })?
            .ok_or_else(|| {
                ProviderTransportError::protocol(
                    "Amazon Bedrock credentials are not configured.".to_string(),
                )
            })?;
        if let Some(reg) = region_override {
            resolved.region = reg;
            resolved.has_configured_region = true;
        }
        Ok(resolved)
    }
}

fn is_claude_adaptive_model(model_id: &str) -> bool {
    let lower = model_id.to_ascii_lowercase();
    lower.contains("claude-opus-4-6")
        || lower.contains("claude-sonnet-4-6")
        || lower.contains("claude-opus-4-7")
        || lower.contains("claude-sonnet-4-7")
        || lower.contains("claude-opus-4-8")
        || lower.contains("claude-sonnet-4-8")
}

fn is_claude_budgeted_thinking_model(model_id: &str) -> bool {
    let lower = model_id.to_ascii_lowercase();
    (lower.contains("claude-3-7-sonnet")
        || lower.contains("claude-opus-4")
        || lower.contains("claude-sonnet-4")
        || lower.contains("claude-haiku-4-5"))
        && !is_claude_adaptive_model(&lower)
}

fn normalize_bedrock_tool_id(raw: &str) -> String {
    let (call_part, _) = split_openai_tool_call_id(raw);
    call_part
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .take(64)
        .collect()
}

/// Bedrock Converse `image` content block for base64 image data. Used for both
/// user messages and tool results (e.g. `read` on a PNG).
fn bedrock_image_block(mime_type: &str, data: &str) -> Value {
    let format = match mime_type {
        "image/jpeg" | "image/jpg" => "jpeg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => "png",
    };
    json!({
        "image": {
            "format": format,
            "source": { "bytes": data }
        }
    })
}

/// Prompt-cache retention for Bedrock `cachePoint` blocks (TS `resolveCacheRetention`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BedrockCacheRetention {
    None,
    Short,
    Long,
}

/// `providerOptions.bedrock.cacheRetention` (`none` / `short` / `long`, as forwarded by TS
/// `piRuntimeOptions.ts`), else `PI_CACHE_RETENTION=long`, else `short`.
fn resolve_bedrock_cache_retention(provider_options: &Map<String, Value>) -> BedrockCacheRetention {
    let configured = read_bedrock_opt(provider_options, "cacheRetention")
        .or_else(|| read_bedrock_opt(provider_options, "cache_retention"))
        .and_then(Value::as_str)
        .and_then(|raw| match raw {
            "none" => Some(BedrockCacheRetention::None),
            "short" => Some(BedrockCacheRetention::Short),
            "long" => Some(BedrockCacheRetention::Long),
            _ => None,
        });
    configured.unwrap_or_else(|| {
        if std::env::var("PI_CACHE_RETENTION").as_deref() == Ok("long") {
            BedrockCacheRetention::Long
        } else {
            BedrockCacheRetention::Short
        }
    })
}

/// TS `supportsPromptCaching`: Claude 4.x, Claude 3.7 Sonnet and Claude 3.5 Haiku; non-Claude
/// models only when `AWS_BEDROCK_FORCE_CACHE=1`.
fn bedrock_supports_prompt_caching(model_id: &str) -> bool {
    let id = model_id.to_ascii_lowercase();
    if !id.contains("claude") {
        return std::env::var("AWS_BEDROCK_FORCE_CACHE").as_deref() == Ok("1");
    }
    id.contains("-4-")
        || id.contains("-4.")
        || id.contains("claude-3-7-sonnet")
        || id.contains("claude-3-5-haiku")
}

/// TS `supportsThinkingSignature`: only Anthropic Claude models accept `reasoningText.signature`.
fn bedrock_supports_thinking_signature(model_id: &str) -> bool {
    let id = model_id.to_ascii_lowercase();
    id.contains("anthropic.claude") || id.contains("anthropic/claude")
}

/// pi `transformMessages` `isSameModel`: signed / redacted reasoning is only replayable to the
/// exact Bedrock model that produced it. Reasoning from any other provider or model is replayed as
/// visible text (redacted payloads are dropped).
fn is_same_bedrock_model(msg: &CanonicalMessage, model_id: &str) -> bool {
    let provider_matches = matches!(
        msg.provider.as_deref(),
        Some("bedrock") | Some("amazon-bedrock")
    );
    let api_matches = msg
        .api
        .as_deref()
        .is_none_or(|api| api == "bedrock-converse-stream");
    provider_matches && api_matches && msg.model.as_deref() == Some(model_id)
}

fn bedrock_cache_point(retention: BedrockCacheRetention) -> Value {
    if retention == BedrockCacheRetention::Long {
        json!({ "cachePoint": { "type": "default", "ttl": "1h" } })
    } else {
        json!({ "cachePoint": { "type": "default" } })
    }
}

pub fn build_converse_request_body(
    model_id: &str,
    system_prompt: &str,
    messages: &[CanonicalMessage],
    tools: &[ToolDefinition],
    provider_options: &Map<String, Value>,
) -> Value {
    let mut body = Map::new();
    let cache_retention = resolve_bedrock_cache_retention(provider_options);
    let use_cache_points =
        cache_retention != BedrockCacheRetention::None && bedrock_supports_prompt_caching(model_id);
    let supports_signature = bedrock_supports_thinking_signature(model_id);

    if !system_prompt.trim().is_empty() {
        let mut system = vec![json!({ "text": system_prompt.trim() })];
        if use_cache_points {
            system.push(bedrock_cache_point(cache_retention));
        }
        body.insert("system".to_string(), Value::Array(system));
    }

    let mut wire_messages: Vec<Value> = Vec::new();
    for msg in messages {
        match msg.role {
            MessageRole::System | MessageRole::Developer => {}
            MessageRole::User => {
                let mut content = Vec::new();
                for block in &msg.content {
                    match block {
                        ContentBlock::Text { text, .. } if !text.is_empty() => {
                            content.push(json!({ "text": text }));
                        }
                        ContentBlock::Media {
                            kind: MediaKind::Image,
                            source: MediaSource::Base64 { mime_type, data },
                            ..
                        } => {
                            content.push(bedrock_image_block(mime_type, data));
                        }
                        _ => {}
                    }
                }
                if !content.is_empty() {
                    wire_messages.push(json!({ "role": "user", "content": content }));
                }
            }
            MessageRole::Assistant => {
                let same_model = is_same_bedrock_model(msg, model_id);
                let mut content = Vec::new();
                for block in &msg.content {
                    match block {
                        ContentBlock::Thinking {
                            text,
                            redacted,
                            signature,
                            provider_meta,
                            ..
                        } => {
                            if *redacted {
                                // Redacted reasoning is opaque and only valid for the model that
                                // produced it; drop it for any other provider / model.
                                if same_model
                                    && let Some(red) = &provider_meta.anthropic_redacted_thinking
                                {
                                    content.push(json!({
                                        "reasoningContent": { "redactedContent": red }
                                    }));
                                }
                                continue;
                            }
                            if text.trim().is_empty() {
                                continue;
                            }
                            if !same_model {
                                // Foreign reasoning (another provider or model) can never verify
                                // as this model's signed reasoning: replay the visible text only.
                                content.push(json!({ "text": text }));
                                continue;
                            }
                            if supports_signature {
                                let sig = signature
                                    .as_deref()
                                    .or(provider_meta.anthropic_thinking_signature.as_deref())
                                    .filter(|s| !s.trim().is_empty());
                                match sig {
                                    Some(sig) => content.push(json!({
                                        "reasoningContent": {
                                            "reasoningText": { "text": text, "signature": sig }
                                        }
                                    })),
                                    None => content.push(json!({ "text": text })),
                                }
                            } else {
                                content.push(json!({
                                    "reasoningContent": { "reasoningText": { "text": text } }
                                }));
                            }
                        }
                        ContentBlock::Text { text, .. } if !text.is_empty() => {
                            content.push(json!({ "text": text }));
                        }
                        ContentBlock::ToolCall {
                            id,
                            name,
                            arguments,
                            ..
                        } => {
                            content.push(json!({
                                "toolUse": {
                                    "toolUseId": normalize_bedrock_tool_id(id),
                                    "name": name,
                                    "input": arguments,
                                }
                            }));
                        }
                        _ => {}
                    }
                }
                if !content.is_empty() {
                    wire_messages.push(json!({ "role": "assistant", "content": content }));
                }
            }
            MessageRole::Tool => {
                let mut content = Vec::new();
                for block in &msg.content {
                    if let ContentBlock::ToolResult {
                        tool_call_id,
                        content: parts,
                        is_error,
                        ..
                    } = block
                    {
                        let text: String = parts
                            .iter()
                            .filter_map(|p| match p {
                                ToolResultPart::Text { text } => Some(text.as_str()),
                                _ => None,
                            })
                            .collect::<Vec<_>>()
                            .join("\n");
                        // Keep image parts as native image blocks so vision
                        // models see the pixels, not just the text label.
                        let images: Vec<Value> = parts
                            .iter()
                            .filter_map(|p| match p {
                                ToolResultPart::Media {
                                    kind: MediaKind::Image,
                                    source: MediaSource::Base64 { mime_type, data },
                                } => Some(bedrock_image_block(mime_type, data)),
                                _ => None,
                            })
                            .collect();
                        let mut result_content = Vec::with_capacity(images.len() + 1);
                        if !text.is_empty() || images.is_empty() {
                            result_content.push(json!({ "text": text }));
                        }
                        result_content.extend(images);
                        content.push(json!({
                            "toolResult": {
                                "toolUseId": normalize_bedrock_tool_id(tool_call_id),
                                "content": result_content,
                                "status": if *is_error { "error" } else { "success" },
                            }
                        }));
                    }
                }
                if !content.is_empty() {
                    wire_messages.push(json!({ "role": "user", "content": content }));
                }
            }
        }
    }
    // TS `convertMessages`: cache everything up to the trailing user turn (tool results included).
    if use_cache_points
        && let Some(last) = wire_messages.last_mut()
        && last.get("role").and_then(Value::as_str) == Some("user")
        && let Some(content) = last.get_mut("content").and_then(Value::as_array_mut)
    {
        content.push(bedrock_cache_point(cache_retention));
    }
    body.insert("messages".to_string(), Value::Array(wire_messages));

    if !tools.is_empty() {
        let tool_specs: Vec<Value> = tools
            .iter()
            .map(|t| {
                json!({
                    "toolSpec": {
                        "name": t.name,
                        "description": t.description,
                        "inputSchema": {
                            "json": t.parameters
                        }
                    }
                })
            })
            .collect();
        body.insert("toolConfig".to_string(), json!({ "tools": tool_specs }));
    }

    let mut inference_cfg = Map::new();
    if let Some(max_tokens) = read_bedrock_opt(provider_options, "maxTokens")
        .or_else(|| read_bedrock_opt(provider_options, "max_tokens"))
        .or_else(|| read_bedrock_opt(provider_options, "maxOutputTokens"))
        .and_then(Value::as_u64)
    {
        inference_cfg.insert("maxTokens".to_string(), json!(max_tokens));
    }
    if let Some(temp) = read_bedrock_opt(provider_options, "temperature").and_then(Value::as_f64)
        && temp.is_finite()
    {
        inference_cfg.insert("temperature".to_string(), json!(temp));
    }
    if !inference_cfg.is_empty() {
        body.insert("inferenceConfig".to_string(), Value::Object(inference_cfg));
    }

    // `reasoning` is the legacy `providerOptions.bedrock.reasoning` key (TS piRuntimeOptions.ts);
    // a nested `bedrock` alias wins over any top-level alias.
    const EFFORT_KEYS: [&str; 4] = ["reasoningEffort", "reasoning_effort", "effort", "reasoning"];
    let nested = provider_options.get("bedrock").and_then(Value::as_object);
    let effort = EFFORT_KEYS
        .iter()
        .find_map(|k| nested.and_then(|sub| sub.get(*k)))
        .or_else(|| EFFORT_KEYS.iter().find_map(|k| provider_options.get(*k)))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty() && *s != "none" && *s != "off");

    let mut additional = Map::new();
    if let Some(eff) = effort {
        if is_claude_adaptive_model(model_id) {
            additional.insert("thinking".to_string(), json!({ "type": "adaptive" }));
            additional.insert("output_config".to_string(), json!({ "effort": eff }));
        } else if is_claude_budgeted_thinking_model(model_id) {
            let budget = match eff {
                "low" | "minimal" => 2048,
                "medium" => 8192,
                _ => 16384,
            };
            additional.insert(
                "thinking".to_string(),
                json!({ "type": "enabled", "budget_tokens": budget }),
            );
        }
    }
    if !additional.is_empty() {
        body.insert(
            "additionalModelRequestFields".to_string(),
            Value::Object(additional),
        );
    }

    Value::Object(body)
}

/// TS `mapStopReason`: `end_turn` / `stop_sequence` stop, `max_tokens` /
/// `model_context_window_exceeded` are length, `tool_use` is tool use; anything else
/// (`guardrail_intervened`, `content_filtered`, missing or unknown reasons) is an error that fails
/// the turn ("An unknown error occurred" in TS).
fn map_bedrock_stop_reason(reason: Option<&str>) -> Result<StopReason, ProviderTransportError> {
    match reason {
        Some("end_turn") | Some("stop_sequence") => Ok(StopReason::Stop),
        Some("max_tokens") | Some("model_context_window_exceeded") => Ok(StopReason::Length),
        Some("tool_use") => Ok(StopReason::ToolUse),
        other => {
            let explanation = match other {
                Some("guardrail_intervened") => {
                    "a Bedrock guardrail intervened and blocked the response \
                     (stopReason: guardrail_intervened)"
                        .to_string()
                }
                Some("content_filtered") => {
                    "the response was blocked by Bedrock content filtering \
                     (stopReason: content_filtered)"
                        .to_string()
                }
                Some(unknown) => {
                    format!("Bedrock ended the response with stopReason \"{unknown}\"")
                }
                None => "Bedrock messageStop carried no stopReason".to_string(),
            };
            let mut err = ProviderTransportError::protocol(format!(
                "An unknown error occurred: {explanation}."
            ));
            err.code = Some(format!(
                "bedrock_stop_reason:{}",
                other.unwrap_or("missing")
            ));
            Err(err)
        }
    }
}

/// Tool-use block whose accumulated input was not valid JSON at `contentBlockStop`. Resolution
/// waits for `messageStop`: truncated (`max_tokens`) input fails the step instead of being repaired
/// into an executable call; otherwise it gets the TS-parity lenient partial-JSON repair.
struct DeferredBedrockToolCall {
    index: usize,
    id: String,
    name: String,
    raw_input: String,
}

#[derive(Debug, Default)]
enum ActiveBedrockBlock {
    #[default]
    None,
    Thinking {
        stream_id: String,
        text: String,
        signature: Option<String>,
        redacted_data: Option<String>,
    },
    Text {
        block_index: usize,
        text: String,
    },
    ToolUse {
        id: String,
        name: String,
        raw_input: String,
    },
}

#[async_trait]
impl ProviderTransport for BedrockConverseTransport {
    async fn stream_step(
        &self,
        request: ProviderStepRequest,
        budget: &StepBudget,
        on_event: &mut StreamEventCallback<'_>,
    ) -> Result<ProviderStepResult, ProviderTransportError> {
        let auth_cfg = self.resolve_auth(&request)?;
        let base_url = request
            .base_url
            .as_deref()
            .filter(|u| {
                should_use_explicit_bedrock_endpoint(
                    u,
                    auth_cfg
                        .has_configured_region
                        .then_some(auth_cfg.region.as_str()),
                    auth_cfg.has_configured_profile,
                )
            })
            .map(|u| u.trim_end_matches('/').to_string())
            .unwrap_or_else(|| {
                format!("https://bedrock-runtime.{}.amazonaws.com", auth_cfg.region)
            });

        let encoded_model = percent_encode_bedrock_model_id(&request.model_id);
        let endpoint = format!("{base_url}/model/{encoded_model}/converse-stream");

        let wire_payload = build_converse_request_body(
            &request.model_id,
            &request.system_prompt,
            &request.messages,
            &request.tools,
            &request.provider_options,
        );
        let body_bytes = serde_json::to_vec(&wire_payload).map_err(|err| {
            ProviderTransportError::protocol(format!("Failed to serialize Bedrock payload: {err}"))
        })?;

        let client = self.client.clone();
        let model_id = request.model_id.clone();
        let turn_id = request.turn_id.clone();
        let extra_headers = request.extra_headers.clone();
        let attempt_timeout = std::time::Duration::from_millis(request.policy.timeout_ms.max(1));

        execute_step_with_sink(
            &request.policy,
            budget,
            on_event,
            &mut |_attempt, mut emit| {
                let client = client.clone();
                let endpoint = endpoint.clone();
                let body_bytes = body_bytes.clone();
                let auth_cfg = auth_cfg.clone();
                let model_id = model_id.clone();
                let turn_id = turn_id.clone();
                let extra_headers = extra_headers.clone();

                async move {
                    let mut headers = HeaderMap::new();
                    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
                    headers.insert(
                        ACCEPT,
                        HeaderValue::from_static("application/vnd.amazon.eventstream"),
                    );
                    for (k, v) in &extra_headers {
                        if let (Ok(hn), Ok(hv)) = (
                            HeaderName::from_bytes(k.as_bytes()),
                            HeaderValue::from_str(v),
                        ) {
                            headers.insert(hn, hv);
                        }
                    }

                    sign_bedrock_request("POST", &endpoint, &mut headers, &body_bytes, &auth_cfg)?;

                    // `attempt_timeout` bounds only connect + response headers (TS SDK `timeout`
                    // semantics); the event stream itself is bounded by the step budget.
                    let send = client
                        .post(&endpoint)
                        .headers(headers)
                        .body(body_bytes)
                        .send();
                    let resp = tokio::time::timeout(attempt_timeout, send)
                        .await
                        .map_err(|_| {
                            ProviderTransportError::timeout(format!(
                                "Bedrock request timed out: response headers not received within {}ms",
                                attempt_timeout.as_millis()
                            ))
                        })?
                        .map_err(|err| {
                            if err.is_timeout() {
                                ProviderTransportError::timeout(format!(
                                    "Bedrock request timed out: {err}"
                                ))
                            } else {
                                ProviderTransportError::network(format!(
                                    "Bedrock transport error: {err}"
                                ))
                            }
                        })?;

                    let status = resp.status();
                    if !status.is_success() {
                        let mut hdrs = HashMap::new();
                        for (k, v) in resp.headers() {
                            if let Ok(s) = v.to_str() {
                                hdrs.insert(k.as_str().to_ascii_lowercase(), s.to_string());
                            }
                        }
                        let text = resp.text().await.unwrap_or_default();
                        return Err(ProviderTransportError::http(
                            status.as_u16(),
                            format!("Bedrock HTTP {}: {}", status.as_u16(), text.trim()),
                            hdrs,
                        ));
                    }

                    let mut decoder = BedrockStreamFrameDecoder::new();
                    let mut byte_stream = resp.bytes_stream();
                    let mut active_blocks: BTreeMap<usize, ActiveBedrockBlock> = BTreeMap::new();
                    let mut finished_blocks: BTreeMap<usize, ContentBlock> = BTreeMap::new();
                    let mut deferred_tool_calls: Vec<DeferredBedrockToolCall> = Vec::new();
                    let mut received_message_stop = false;
                    let mut raw_stop_reason: Option<String> = None;
                    let mut input_tokens = 0u64;
                    let mut output_tokens = 0u64;
                    let mut reported_total_tokens: Option<u64> = None;
                    let mut cache_read_tokens: Option<u64> = None;
                    let mut cache_write_tokens: Option<u64> = None;
                    let mut raw_events = Vec::new();

                    while let Some(chunk_res) = byte_stream.next().await {
                        let chunk = chunk_res.map_err(|err| {
                            ProviderTransportError::network(format!(
                                "Bedrock stream read error: {err}"
                            ))
                        })?;
                        let frames = decoder.push_bytes(&chunk)?;
                        for frame in frames {
                            match frame {
                                BedrockDecodedEvent::Exception {
                                    exception_type,
                                    message,
                                } => {
                                    let status = if exception_type
                                        .to_ascii_lowercase()
                                        .contains("throttl")
                                    {
                                        Some(429)
                                    } else if exception_type
                                        .to_ascii_lowercase()
                                        .contains("unavailable")
                                        || exception_type.to_ascii_lowercase().contains("internal")
                                    {
                                        Some(503)
                                    } else {
                                        None
                                    };
                                    let mut err = ProviderTransportError::protocol(format!(
                                        "Bedrock {exception_type}: {message}"
                                    ));
                                    err.status = status;
                                    err.code = Some(exception_type);
                                    return Err(err);
                                }
                                BedrockDecodedEvent::Event {
                                    event_type,
                                    payload,
                                } => {
                                    raw_events.push(json!({
                                        "eventType": event_type,
                                        "payload": payload,
                                    }));
                                    match event_type.as_str() {
                                        "contentBlockStart" => {
                                            let idx = payload
                                                .get("contentBlockIndex")
                                                .and_then(Value::as_u64)
                                                .unwrap_or(0)
                                                as usize;
                                            if let Some(tu) = payload
                                                .get("start")
                                                .and_then(|s| s.get("toolUse"))
                                            {
                                                let id = tu
                                                    .get("toolUseId")
                                                    .and_then(Value::as_str)
                                                    .unwrap_or("toolu_bedrock")
                                                    .to_string();
                                                let name = tu
                                                    .get("name")
                                                    .and_then(Value::as_str)
                                                    .unwrap_or("unknown")
                                                    .to_string();
                                                emit(StreamEvent::ToolCallStart {
                                                    turn_id: turn_id.clone(),
                                                    key: id.clone(),
                                                    name: name.clone(),
                                                    initial_args: None,
                                                });
                                                active_blocks.insert(
                                                    idx,
                                                    ActiveBedrockBlock::ToolUse {
                                                        id,
                                                        name,
                                                        raw_input: String::new(),
                                                    },
                                                );
                                            }
                                        }
                                        "contentBlockDelta" => {
                                            let idx = payload
                                                .get("contentBlockIndex")
                                                .and_then(Value::as_u64)
                                                .unwrap_or(0)
                                                as usize;
                                            let Some(delta) = payload.get("delta") else {
                                                continue;
                                            };

                                            if let Some(rc) = delta.get("reasoningContent") {
                                                let entry = active_blocks.entry(idx).or_insert_with(
                                                    || {
                                                        let sid = format!("{turn_id}:bdrk-think:{idx}");
                                                        emit(StreamEvent::ThinkingStart {
                                                            turn_id: turn_id.clone(),
                                                            stream_id: sid.clone(),
                                                            mode: ReasoningStreamMode::Reasoning,
                                                        });
                                                        ActiveBedrockBlock::Thinking {
                                                            stream_id: sid,
                                                            text: String::new(),
                                                            signature: None,
                                                            redacted_data: None,
                                                        }
                                                    },
                                                );
                                                if let ActiveBedrockBlock::Thinking {
                                                    stream_id,
                                                    text,
                                                    signature,
                                                    redacted_data,
                                                } = entry
                                                {
                                                    if let Some(t) =
                                                        rc.get("text").and_then(Value::as_str)
                                                        && !t.is_empty()
                                                    {
                                                        text.push_str(t);
                                                        emit(StreamEvent::ThinkingDelta {
                                                            turn_id: turn_id.clone(),
                                                            stream_id: stream_id.clone(),
                                                            mode: ReasoningStreamMode::Reasoning,
                                                            delta: t.to_string(),
                                                        });
                                                    }
                                                    if let Some(sig) =
                                                        rc.get("signature").and_then(Value::as_str)
                                                        && !sig.is_empty()
                                                    {
                                                        *signature = Some(sig.to_string());
                                                    }
                                                    if let Some(red) = rc
                                                        .get("redactedContent")
                                                        .and_then(Value::as_str)
                                                        && !red.is_empty()
                                                    {
                                                        *redacted_data = Some(red.to_string());
                                                    }
                                                }
                                            } else if let Some(t) =
                                                delta.get("text").and_then(Value::as_str)
                                            {
                                                let entry = active_blocks.entry(idx).or_insert_with(
                                                    || {
                                                        emit(StreamEvent::TextStart {
                                                            turn_id: turn_id.clone(),
                                                            block_index: idx,
                                                            phase: None,
                                                        });
                                                        ActiveBedrockBlock::Text {
                                                            block_index: idx,
                                                            text: String::new(),
                                                        }
                                                    },
                                                );
                                                if let ActiveBedrockBlock::Text {
                                                    block_index,
                                                    text,
                                                } = entry
                                                    && !t.is_empty()
                                                {
                                                    text.push_str(t);
                                                    emit(StreamEvent::TextDelta {
                                                        turn_id: turn_id.clone(),
                                                        block_index: *block_index,
                                                        delta: t.to_string(),
                                                        phase: None,
                                                    });
                                                }
                                            } else if let Some(tu) = delta.get("toolUse")
                                                && let Some(inp) =
                                                    tu.get("input").and_then(Value::as_str)
                                                && let Some(ActiveBedrockBlock::ToolUse {
                                                    id,
                                                    name,
                                                    raw_input,
                                                }) = active_blocks.get_mut(&idx)
                                                && !inp.is_empty()
                                            {
                                                raw_input.push_str(inp);
                                                emit(StreamEvent::ToolCallDelta {
                                                    turn_id: turn_id.clone(),
                                                    key: id.clone(),
                                                    name: name.clone(),
                                                    delta: inp.to_string(),
                                                });
                                            }
                                        }
                                        "contentBlockStop" => {
                                            let idx = payload
                                                .get("contentBlockIndex")
                                                .and_then(Value::as_u64)
                                                .unwrap_or(0)
                                                as usize;
                                            if let Some(block) = active_blocks.remove(&idx) {
                                                match block {
                                                    ActiveBedrockBlock::Thinking {
                                                        stream_id,
                                                        text,
                                                        signature,
                                                        redacted_data,
                                                    } => {
                                                        let redacted = redacted_data.is_some();
                                                        emit(StreamEvent::ThinkingEnd {
                                                            turn_id: turn_id.clone(),
                                                            stream_id,
                                                            mode: ReasoningStreamMode::Reasoning,
                                                            text: text.clone(),
                                                            signature: signature.clone(),
                                                            redacted,
                                                        });
                                                        let meta = ProviderOpaqueMeta {
                                                            anthropic_thinking_signature: signature
                                                                .clone(),
                                                            anthropic_redacted_thinking:
                                                                redacted_data,
                                                            ..Default::default()
                                                        };
                                                        finished_blocks.insert(
                                                            idx,
                                                            ContentBlock::Thinking {
                                                                text,
                                                                summary: None,
                                                                redacted,
                                                                signature,
                                                                provider_meta: meta,
                                                            },
                                                        );
                                                    }
                                                    ActiveBedrockBlock::Text {
                                                        block_index,
                                                        text,
                                                    } => {
                                                        emit(StreamEvent::TextEnd {
                                                            turn_id: turn_id.clone(),
                                                            block_index,
                                                            text: text.clone(),
                                                            phase: None,
                                                            citations: Vec::new(),
                                                            annotations: Vec::new(),
                                                        });
                                                        finished_blocks.insert(
                                                            idx,
                                                            ContentBlock::Text {
                                                                text,
                                                                phase: None,
                                                                citations: Vec::new(),
                                                                provider_meta:
                                                                    ProviderOpaqueMeta::default(),
                                                            },
                                                        );
                                                    }
                                                    ActiveBedrockBlock::ToolUse {
                                                        id,
                                                        name,
                                                        raw_input,
                                                    } => {
                                                        let parsed = if raw_input.trim().is_empty() {
                                                            Some(Map::new())
                                                        } else {
                                                            serde_json::from_str::<Map<String, Value>>(
                                                                &raw_input,
                                                            )
                                                            .ok()
                                                        };
                                                        let Some(args) = parsed else {
                                                            deferred_tool_calls.push(
                                                                DeferredBedrockToolCall {
                                                                    index: idx,
                                                                    id,
                                                                    name,
                                                                    raw_input,
                                                                },
                                                            );
                                                            continue;
                                                        };
                                                        emit(StreamEvent::ToolCallEnd {
                                                            turn_id: turn_id.clone(),
                                                            key: id.clone(),
                                                            name: name.clone(),
                                                            arguments: Some(args.clone()),
                                                            retry_of: None,
                                                            input_digest: None,
                                                        });
                                                        finished_blocks.insert(
                                                            idx,
                                                            ContentBlock::ToolCall {
                                                                id,
                                                                name,
                                                                arguments: args,
                                                                partial_json: (!raw_input
                                                                    .is_empty())
                                                                .then_some(raw_input),
                                                                provider_meta:
                                                                    ProviderOpaqueMeta::default(),
                                                            },
                                                        );
                                                    }
                                                    ActiveBedrockBlock::None => {}
                                                }
                                            }
                                        }
                                        "messageStop" => {
                                            received_message_stop = true;
                                            raw_stop_reason = payload
                                                .get("stopReason")
                                                .and_then(Value::as_str)
                                                .map(ToOwned::to_owned);
                                        }
                                        "metadata" => {
                                            if let Some(u) = payload.get("usage") {
                                                input_tokens = u
                                                    .get("inputTokens")
                                                    .and_then(Value::as_u64)
                                                    .unwrap_or(0);
                                                output_tokens = u
                                                    .get("outputTokens")
                                                    .and_then(Value::as_u64)
                                                    .unwrap_or(0);
                                                reported_total_tokens =
                                                    u.get("totalTokens").and_then(Value::as_u64);
                                                cache_read_tokens = u
                                                    .get("cacheReadInputTokens")
                                                    .and_then(Value::as_u64);
                                                cache_write_tokens = u
                                                    .get("cacheWriteInputTokens")
                                                    .and_then(Value::as_u64);
                                            }
                                        }
                                        _ => {}
                                    }
                                }
                            }
                        }
                    }

                    // A stream that closes without `messageStop`, with a content block still open,
                    // or mid-frame was truncated: never surface partial output as a successful
                    // step (TS throws; same retryable kind as the other transports).
                    if !received_message_stop {
                        return Err(ProviderTransportError::network(
                            "Bedrock stream ended before messageStop.",
                        ));
                    }
                    if !active_blocks.is_empty() {
                        return Err(ProviderTransportError::network(
                            "Bedrock stream ended before contentBlockStop.",
                        ));
                    }
                    if !decoder.is_empty() {
                        return Err(ProviderTransportError::network(
                            "Bedrock stream ended with an incomplete EventStream frame.",
                        ));
                    }
                    let mut stop_reason = map_bedrock_stop_reason(raw_stop_reason.as_deref())?;

                    // `max_tokens` cut the output off, so tool input that does not parse is
                    // truncated and must not be repaired into an executable call.
                    if stop_reason == StopReason::Length && !deferred_tool_calls.is_empty() {
                        return Err(ProviderTransportError::network(
                            "Bedrock stream ended with incomplete tool call arguments.",
                        ));
                    }
                    for deferred in deferred_tool_calls {
                        let args = parse_partial_json_object(&deferred.raw_input);
                        emit(StreamEvent::ToolCallEnd {
                            turn_id: turn_id.clone(),
                            key: deferred.id.clone(),
                            name: deferred.name.clone(),
                            arguments: Some(args.clone()),
                            retry_of: None,
                            input_digest: None,
                        });
                        finished_blocks.insert(
                            deferred.index,
                            ContentBlock::ToolCall {
                                id: deferred.id,
                                name: deferred.name,
                                arguments: args,
                                partial_json: Some(deferred.raw_input),
                                provider_meta: ProviderOpaqueMeta::default(),
                            },
                        );
                    }

                    // Bedrock `inputTokens` excludes cache reads/writes; the cost tracker prices
                    // `prompt_tokens` as uncached + cached + cache-write buckets.
                    let prompt_tokens = input_tokens
                        + cache_read_tokens.unwrap_or(0)
                        + cache_write_tokens.unwrap_or(0);
                    let usage = TurnUsage {
                        prompt_tokens,
                        completion_tokens: output_tokens,
                        total_tokens: reported_total_tokens
                            .unwrap_or(0)
                            .max(prompt_tokens + output_tokens),
                        cached_prompt_tokens: cache_read_tokens,
                        cache_write_prompt_tokens: cache_write_tokens,
                        ..TurnUsage::default()
                    };

                    let content: Vec<ContentBlock> = finished_blocks.into_values().collect();
                    if content
                        .iter()
                        .any(|b| matches!(b, ContentBlock::ToolCall { .. }))
                    {
                        stop_reason = StopReason::ToolUse;
                    }

                    let assistant = CanonicalMessage {
                        id: format!("msg-{}", Uuid::new_v4()),
                        role: MessageRole::Assistant,
                        content,
                        phase: None,
                        provider: Some("bedrock".to_string()),
                        api: Some("bedrock-converse-stream".to_string()),
                        model: Some(model_id),
                        stop_reason: Some(stop_reason),
                        provider_meta: ProviderOpaqueMeta::default(),
                        created_at: Utc::now().to_rfc3339(),
                    };
                    let persisted_assistant = filter_persisted_assistant_history(&assistant);

                    Ok(ProviderStepResult {
                        assistant,
                        persisted_assistant,
                        usage,
                        continuation: None,
                        raw_events,
                    })
                }
            },
        )
        .await
    }
}
