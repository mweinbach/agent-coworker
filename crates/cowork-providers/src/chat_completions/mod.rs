pub mod lmstudio;
pub mod quirks;
pub mod schema_sanitizer;
pub mod sse_decoder;
pub mod think_tags;

use async_trait::async_trait;
use cowork_config::ProviderName;
use cowork_inference::{
    CanonicalMessage, ContentBlock, MediaKind, MediaSource, MessageRole, ProviderOpaqueMeta,
    ProviderTransportError, StepBudget, ToolResultPart, execute_step_with_sink,
    split_openai_tool_call_id,
};
use futures_util::StreamExt;
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderName, HeaderValue};
use serde_json::{Map, Value, json};

use crate::chat_completions::sse_decoder::{
    CHAT_COMPLETIONS_REASONING_FIELD_META_KEY, CHAT_COMPLETIONS_REASONING_FIELDS,
    ChatCompletionsStreamAccumulator,
};
use crate::sse::{build_http_client, post_json_sse};
use crate::transport::{
    ProviderStepRequest, ProviderStepResult, ProviderTransport, StreamEventCallback, ToolDefinition,
};

pub use lmstudio::{
    DEFAULT_LM_STUDIO_BASE_URL, LmStudioControlClient, LmStudioLoadResult, LmStudioLoadedInstance,
    LmStudioLocalService, LmStudioLocalStartResult, LmStudioLocalStatus, LmStudioModelInfo,
    LmStudioOptions, is_loopback_lmstudio_url, normalize_lmstudio_base_url,
    resolve_lmstudio_options,
};
pub use quirks::{
    MaxTokensField, ProviderQuirks, ThinkingFormat, is_opencode_model_supported,
    is_user_facing_provider_enabled, normalize_null_tool_arguments,
    normalize_nvidia_chat_completions_body,
};
pub use schema_sanitizer::{
    FIREWORKS_TOOL_SCHEMA_MAX_BYTES, FIREWORKS_TOTAL_TOOL_SCHEMA_MAX_BYTES,
    normalize_tool_json_schema, sanitize_fireworks_tool_json_schema, sanitize_tools_for_provider,
};
pub use think_tags::{
    ThinkTagChunkOutput, ThinkTagSplitState, flush_think_tag_split_state, split_think_tagged_text,
    split_think_tagged_text_chunk,
};

/// Native OpenAI Chat Completions SSE wire transport parameterized by declarative `ProviderQuirks`.
#[derive(Debug, Clone)]
pub struct ChatCompletionsTransport {
    pub provider: ProviderName,
    pub quirks: ProviderQuirks,
    client: reqwest::Client,
}

impl ChatCompletionsTransport {
    pub fn new(provider: ProviderName) -> Option<Self> {
        let quirks = ProviderQuirks::for_provider(provider)?;
        Some(Self {
            provider,
            quirks,
            client: build_http_client().expect("rustls HTTP client"),
        })
    }

    pub fn client(&self) -> &reqwest::Client {
        &self.client
    }

    fn resolve_api_key(
        &self,
        explicit: Option<&str>,
        allow_ambient_env: bool,
    ) -> Result<Option<String>, ProviderTransportError> {
        if let Some(key) = explicit.map(str::trim).filter(|s| !s.is_empty()) {
            return Ok(Some(key.to_string()));
        }
        if allow_ambient_env {
            for env_name in self.quirks.env_api_keys {
                if let Ok(val) = std::env::var(env_name)
                    && !val.trim().is_empty()
                {
                    return Ok(Some(val.trim().to_string()));
                }
            }
        }
        // Local LM Studio and public OpenCode catalogs permit unauthenticated requests
        if self.quirks.is_public_catalog {
            return Ok(None);
        }
        Err(ProviderTransportError::protocol(format!(
            "Missing API key for provider {}.",
            self.provider.as_str()
        )))
    }

    fn resolve_endpoint(&self, explicit_base: Option<&str>) -> String {
        let raw = explicit_base
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(self.quirks.default_base_url)
            .trim_end_matches('/');
        if raw.ends_with("/chat/completions") {
            return raw.to_string();
        }
        if self.provider == ProviderName::Lmstudio && !raw.ends_with("/v1") {
            let norm = normalize_lmstudio_base_url(Some(raw));
            return format!("{norm}/v1/chat/completions");
        }
        format!("{raw}/chat/completions")
    }
}

/// The canonical `api` label Chat Completions assistant messages carry (pi `model.api`).
const OPENAI_COMPLETIONS_API: &str = "openai-completions";

/// Models whose pi catalog entry sets `compat.requiresReasoningContentOnAssistantMessages`
/// (all are `reasoning: true`), keyed by the cowork provider that serves them. pi's catalog
/// `opencode` entries apply to OpenCode Zen, and its `fireworks` entries to Fireworks and Firepass
/// (same inference endpoint and model ids).
const REASONING_CONTENT_REQUIRED_MODELS: &[(ProviderName, &[&str])] = &[
    (
        ProviderName::OpencodeGo,
        &[
            "deepseek-v4-flash",
            "deepseek-v4-flash-vision-exp",
            "deepseek-v4-pro",
            "deepseek-v4.1-flash",
        ],
    ),
    (
        ProviderName::OpencodeZen,
        &[
            "deepseek-v4-flash",
            "deepseek-v4-flash-vision-exp",
            "deepseek-v4-pro",
            "deepseek-v4.1-flash",
        ],
    ),
    (
        ProviderName::Fireworks,
        &[
            "accounts/fireworks/models/kimi-k3",
            "accounts/fireworks/routers/kimi-k3-fast",
        ],
    ),
    (
        ProviderName::Firepass,
        &[
            "accounts/fireworks/models/kimi-k3",
            "accounts/fireworks/routers/kimi-k3-fast",
        ],
    ),
    (ProviderName::Nvidia, &["deepseek-ai/deepseek-v4.1-flash"]),
];

/// Request-level compat flags for Chat Completions payload building that depend on the model and
/// resolved endpoint rather than only on the provider's static [`ProviderQuirks`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ChatCompletionsPayloadOptions {
    /// pi `compat.requiresReasoningContentOnAssistantMessages`: every replayed assistant message
    /// carries `reasoning_content` (empty when there is no reasoning to replay). DeepSeek's API
    /// rejects thinking-mode tool loops whose assistant messages omit it.
    pub requires_reasoning_content_on_assistant_messages: bool,
}

impl ChatCompletionsPayloadOptions {
    /// Mirrors pi `getCompat`: the flag comes from the model's catalog compat, or from
    /// `detectCompat` when the endpoint is DeepSeek's (`deepseek.com`); pi's DeepSeek catalog
    /// models are all reasoning models, so `model.reasoning` is taken as satisfied there.
    pub fn detect(provider: ProviderName, model_id: &str, endpoint: &str) -> Self {
        let model_id = model_id.trim();
        let catalog_requires = REASONING_CONTENT_REQUIRED_MODELS
            .iter()
            .any(|(p, models)| *p == provider && models.contains(&model_id));
        let is_deepseek_endpoint = endpoint.to_ascii_lowercase().contains("deepseek.com");
        Self {
            requires_reasoning_content_on_assistant_messages: catalog_requires
                || is_deepseek_endpoint,
        }
    }
}

/// Reads the Chat Completions delta field a thinking block's reasoning streamed under: the
/// provider-meta label this transport records, else a legacy pi `thinkingSignature` (imported as
/// `signature`) that names one of the reasoning fields.
fn thinking_reasoning_field(
    signature: Option<&str>,
    provider_meta: &ProviderOpaqueMeta,
) -> Option<&'static str> {
    let raw = provider_meta
        .extra
        .get(CHAT_COMPLETIONS_REASONING_FIELD_META_KEY)
        .and_then(Value::as_str)
        .or(signature)?;
    CHAT_COMPLETIONS_REASONING_FIELDS
        .iter()
        .copied()
        .find(|field| *field == raw)
}

fn normalize_tool_call_id(raw: &str) -> String {
    let (call_part, _) = split_openai_tool_call_id(raw);
    call_part.to_string()
}

fn serialize_messages_for_chat_completions(
    quirks: &ProviderQuirks,
    model_id: &str,
    system_prompt: &str,
    messages: &[CanonicalMessage],
    options: ChatCompletionsPayloadOptions,
) -> Vec<Value> {
    let mut out = Vec::new();
    let trimmed_sys = system_prompt.trim();
    if !trimmed_sys.is_empty() {
        let sys_role = if quirks.supports_developer_role {
            "developer"
        } else {
            "system"
        };
        out.push(json!({
            "role": sys_role,
            "content": trimmed_sys,
        }));
    }

    // Images returned by tools (e.g. `read` on a PNG) cannot ride in a `tool` message, so they
    // are re-sent as a user image message (Responses-transport parity). It is emitted only after
    // the whole run of tool messages so every tool_call keeps an adjacent tool response.
    let mut pending_tool_images: Vec<String> = Vec::new();

    for msg in messages {
        if msg.role != MessageRole::Tool {
            flush_tool_result_images(&mut out, &mut pending_tool_images);
        }
        match msg.role {
            MessageRole::System | MessageRole::Developer => {
                let text: String = msg
                    .content
                    .iter()
                    .filter_map(|b| match b {
                        ContentBlock::Text { text, .. } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                if !text.trim().is_empty() {
                    let role =
                        if msg.role == MessageRole::Developer && quirks.supports_developer_role {
                            "developer"
                        } else {
                            "system"
                        };
                    out.push(json!({ "role": role, "content": text }));
                }
            }
            MessageRole::User => {
                let has_media = msg.content.iter().any(|b| {
                    matches!(
                        b,
                        ContentBlock::Media {
                            kind: MediaKind::Image,
                            ..
                        }
                    )
                });
                if !has_media {
                    let text: String = msg
                        .content
                        .iter()
                        .filter_map(|b| match b {
                            ContentBlock::Text { text, .. } => Some(text.as_str()),
                            _ => None,
                        })
                        .collect::<Vec<_>>()
                        .join("\n");
                    out.push(json!({ "role": "user", "content": text }));
                } else {
                    let mut parts = Vec::new();
                    for block in &msg.content {
                        match block {
                            ContentBlock::Text { text, .. } if !text.is_empty() => {
                                parts.push(json!({ "type": "text", "text": text }));
                            }
                            ContentBlock::Media {
                                kind: MediaKind::Image,
                                source,
                                ..
                            } => match source {
                                MediaSource::Base64 { mime_type, data } => {
                                    parts.push(json!({
                                        "type": "image_url",
                                        "image_url": {
                                            "url": format!("data:{mime_type};base64,{data}")
                                        }
                                    }));
                                }
                                MediaSource::Url { url, .. } => {
                                    parts.push(json!({
                                        "type": "image_url",
                                        "image_url": { "url": url }
                                    }));
                                }
                                MediaSource::FileRef { .. } => {}
                            },
                            _ => {}
                        }
                    }
                    out.push(json!({ "role": "user", "content": parts }));
                }
            }
            MessageRole::Assistant => {
                // pi `transformMessages` keeps thinking blocks (and their replay signature) only
                // for the same provider/api/model; reasoning from another model is not replayed
                // under a provider reasoning field.
                let is_same_model = msg.provider.as_deref() == Some(quirks.provider.as_str())
                    && msg.api.as_deref() == Some(OPENAI_COMPLETIONS_API)
                    && msg.model.as_deref() == Some(model_id);
                let mut text_parts = Vec::new();
                let mut reasoning_parts = Vec::new();
                let mut reasoning_field: Option<&'static str> = None;
                let mut tool_calls = Vec::new();

                for block in &msg.content {
                    match block {
                        ContentBlock::Text { text, .. } if !text.is_empty() => {
                            text_parts.push(text.as_str());
                        }
                        ContentBlock::Thinking {
                            text,
                            redacted,
                            signature,
                            provider_meta,
                            ..
                        } if is_same_model && !*redacted && !text.trim().is_empty() => {
                            // pi: the first non-empty thinking block's signature names the field.
                            if reasoning_parts.is_empty() {
                                reasoning_field =
                                    thinking_reasoning_field(signature.as_deref(), provider_meta);
                            }
                            reasoning_parts.push(text.as_str());
                        }
                        ContentBlock::ToolCall {
                            id,
                            name,
                            arguments,
                            ..
                        } => {
                            let serialized_args =
                                serde_json::to_string(arguments).unwrap_or_else(|_| "{}".into());
                            tool_calls.push(json!({
                                "id": normalize_tool_call_id(id),
                                "type": "function",
                                "function": {
                                    "name": name,
                                    "arguments": serialized_args,
                                }
                            }));
                        }
                        _ => {}
                    }
                }

                let mut assistant_obj = Map::new();
                assistant_obj.insert("role".to_string(), Value::String("assistant".to_string()));
                if !text_parts.is_empty() {
                    assistant_obj.insert("content".to_string(), Value::String(text_parts.join("")));
                } else if tool_calls.is_empty() {
                    assistant_obj.insert("content".to_string(), Value::String(String::new()));
                } else {
                    assistant_obj.insert("content".to_string(), Value::Null);
                }
                if !reasoning_parts.is_empty() {
                    // pi `convertMessages`: write reasoning back under the field it streamed in
                    // (opencode-go `reasoning` is forced to `reasoning_content`); blocks without
                    // a recorded field (e.g. inline `<think>` splits) are not replayed.
                    let field = match reasoning_field {
                        Some("reasoning") if quirks.provider == ProviderName::OpencodeGo => {
                            Some("reasoning_content")
                        }
                        other => other,
                    };
                    if let Some(field) = field {
                        assistant_obj
                            .insert(field.to_string(), Value::String(reasoning_parts.join("\n")));
                    }
                }
                if options.requires_reasoning_content_on_assistant_messages
                    && !assistant_obj.contains_key("reasoning_content")
                {
                    assistant_obj.insert(
                        "reasoning_content".to_string(),
                        Value::String(String::new()),
                    );
                }
                if !tool_calls.is_empty() {
                    assistant_obj.insert("tool_calls".to_string(), Value::Array(tool_calls));
                }
                out.push(Value::Object(assistant_obj));
            }
            MessageRole::Tool => {
                for block in &msg.content {
                    if let ContentBlock::ToolResult {
                        tool_call_id,
                        content,
                        ..
                    } = block
                    {
                        let mut texts = Vec::new();
                        let mut has_image = false;
                        for part in content {
                            match part {
                                ToolResultPart::Text { text } => texts.push(text.as_str()),
                                ToolResultPart::Media {
                                    kind: MediaKind::Image,
                                    source,
                                } => {
                                    if let Some(url) = media_source_to_image_url(source) {
                                        pending_tool_images.push(url);
                                        has_image = true;
                                    }
                                }
                                ToolResultPart::Media { .. } => {}
                            }
                        }
                        let text = if texts.is_empty() && has_image {
                            "(see attached image)".to_owned()
                        } else {
                            texts.join("\n")
                        };
                        out.push(json!({
                            "role": "tool",
                            "tool_call_id": normalize_tool_call_id(tool_call_id),
                            "content": text,
                        }));
                    }
                }
            }
        }
    }
    flush_tool_result_images(&mut out, &mut pending_tool_images);

    out
}

fn media_source_to_image_url(source: &MediaSource) -> Option<String> {
    match source {
        MediaSource::Base64 { mime_type, data } => Some(format!("data:{mime_type};base64,{data}")),
        MediaSource::Url { url, .. } => Some(url.clone()),
        MediaSource::FileRef { .. } => None,
    }
}

fn flush_tool_result_images(out: &mut Vec<Value>, images: &mut Vec<String>) {
    if images.is_empty() {
        return;
    }
    let mut parts = vec![json!({
        "type": "text",
        "text": "Attached image(s) from tool result:",
    })];
    parts.extend(images.drain(..).map(|url| {
        json!({
            "type": "image_url",
            "image_url": { "url": url },
        })
    }));
    out.push(json!({ "role": "user", "content": parts }));
}

fn read_chat_completions_opt<'a>(
    opts: &'a Map<String, Value>,
    provider: ProviderName,
    key: &str,
) -> Option<&'a Value> {
    opts.get(provider.as_str())
        .and_then(Value::as_object)
        .and_then(|sub| sub.get(key))
        .or_else(|| opts.get(key))
}

/// Builds the request body with compat options detected from the provider's default base URL.
pub fn build_chat_completions_payload(
    quirks: &ProviderQuirks,
    model_id: &str,
    system_prompt: &str,
    messages: &[CanonicalMessage],
    sanitized_tools: &[ToolDefinition],
    provider_options: &Map<String, Value>,
) -> Value {
    build_chat_completions_payload_with_options(
        quirks,
        model_id,
        system_prompt,
        messages,
        sanitized_tools,
        provider_options,
        ChatCompletionsPayloadOptions::detect(quirks.provider, model_id, quirks.default_base_url),
    )
}

pub fn build_chat_completions_payload_with_options(
    quirks: &ProviderQuirks,
    model_id: &str,
    system_prompt: &str,
    messages: &[CanonicalMessage],
    sanitized_tools: &[ToolDefinition],
    provider_options: &Map<String, Value>,
    options: ChatCompletionsPayloadOptions,
) -> Value {
    let mut body = Map::new();
    body.insert("model".to_string(), Value::String(model_id.to_string()));
    body.insert("stream".to_string(), Value::Bool(true));
    body.insert(
        "stream_options".to_string(),
        json!({ "include_usage": true }),
    );
    body.insert(
        "messages".to_string(),
        Value::Array(serialize_messages_for_chat_completions(
            quirks,
            model_id,
            system_prompt,
            messages,
            options,
        )),
    );

    if !sanitized_tools.is_empty() {
        let wire_tools: Vec<Value> = sanitized_tools
            .iter()
            .map(|t| {
                json!({
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.parameters,
                    }
                })
            })
            .collect();
        body.insert("tools".to_string(), Value::Array(wire_tools));
    }

    if let Some(temp) = read_chat_completions_opt(provider_options, quirks.provider, "temperature")
        .and_then(Value::as_f64)
        && temp.is_finite()
    {
        body.insert("temperature".to_string(), json!(temp));
    }

    if let Some(max_tokens) =
        read_chat_completions_opt(provider_options, quirks.provider, "maxTokens")
            .or_else(|| read_chat_completions_opt(provider_options, quirks.provider, "max_tokens"))
            .or_else(|| {
                read_chat_completions_opt(provider_options, quirks.provider, "maxOutputTokens")
            })
            .and_then(Value::as_u64)
    {
        let key = match quirks.max_tokens_field {
            MaxTokensField::MaxTokens => "max_tokens",
            MaxTokensField::MaxCompletionTokens => "max_completion_tokens",
        };
        body.insert(key.to_string(), json!(max_tokens));
    }

    if quirks.supports_reasoning_effort
        && let Some(effort) =
            read_chat_completions_opt(provider_options, quirks.provider, "reasoningEffort")
                .or_else(|| {
                    read_chat_completions_opt(provider_options, quirks.provider, "reasoning_effort")
                })
                .or_else(|| read_chat_completions_opt(provider_options, quirks.provider, "effort"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty() && *s != "none" && *s != "off")
    {
        body.insert(
            "reasoning_effort".to_string(),
            Value::String(effort.to_string()),
        );
    }

    if quirks.provider == ProviderName::Minimax {
        body.insert("thinking".to_string(), json!({ "type": "adaptive" }));
    }

    let raw = Value::Object(body);
    if quirks.nvidia_payload_normalization {
        normalize_nvidia_chat_completions_body(raw)
    } else {
        raw
    }
}

#[async_trait]
impl ProviderTransport for ChatCompletionsTransport {
    async fn stream_step(
        &self,
        request: ProviderStepRequest,
        budget: &StepBudget,
        on_event: &mut StreamEventCallback<'_>,
    ) -> Result<ProviderStepResult, ProviderTransportError> {
        let allow_ambient_env = !request.provider_options.contains_key("coworkHome");
        let api_key = self.resolve_api_key(request.api_key.as_deref(), allow_ambient_env)?;
        let endpoint = self.resolve_endpoint(request.base_url.as_deref());
        let sanitized_tools = sanitize_tools_for_provider(self.provider, &request.tools);
        let wire_body = build_chat_completions_payload_with_options(
            &self.quirks,
            &request.model_id,
            &request.system_prompt,
            &request.messages,
            &sanitized_tools,
            &request.provider_options,
            ChatCompletionsPayloadOptions::detect(self.provider, &request.model_id, &endpoint),
        );

        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        headers.insert(ACCEPT, HeaderValue::from_static("text/event-stream"));
        if let Some(key) = api_key {
            let auth_hv = HeaderValue::from_str(&format!("Bearer {key}")).map_err(|e| {
                ProviderTransportError::protocol(format!("Invalid API key header: {e}"))
            })?;
            headers.insert(AUTHORIZATION, auth_hv);
        }
        for (k, v) in &request.extra_headers {
            if let (Ok(hn), Ok(hv)) = (
                HeaderName::from_bytes(k.as_bytes()),
                HeaderValue::from_str(v),
            ) {
                headers.insert(hn, hv);
            }
        }

        let client = self.client.clone();
        let provider = self.provider;
        let model_id = request.model_id.clone();
        let turn_id = request.turn_id.clone();
        let split_inline_think = self.quirks.split_inline_think_tags;
        let original_tools = request.tools.clone();
        let attempt_timeout = std::time::Duration::from_millis(request.policy.timeout_ms.max(1));

        execute_step_with_sink(
            &request.policy,
            budget,
            on_event,
            &mut |_attempt, mut emit| {
                let client = client.clone();
                let endpoint = endpoint.clone();
                let headers = headers.clone();
                let wire_body = wire_body.clone();
                let model_id = model_id.clone();
                let turn_id = turn_id.clone();
                let tools_for_acc = original_tools.clone();

                async move {
                    let mut stream =
                        post_json_sse(&client, &endpoint, headers, &wire_body, attempt_timeout)
                            .await?;

                    let mut acc = ChatCompletionsStreamAccumulator::new(
                        provider,
                        model_id,
                        turn_id,
                        split_inline_think,
                        &tools_for_acc,
                    );

                    while let Some(frame_res) = stream.next().await {
                        let frame = frame_res?;
                        if acc.push_data_frame(&frame.data, &mut *emit)? {
                            break;
                        }
                    }

                    acc.finalize(&mut *emit)
                }
            },
        )
        .await
    }
}
