use std::collections::BTreeMap;

use async_trait::async_trait;
use chrono::Utc;
use cowork_inference::{
    CanonicalMessage, Citation, ContentBlock, ContinuationFingerprintInput, MediaKind, MediaSource,
    MessageRole, ProviderContinuationState, ProviderOpaqueMeta, ProviderTransportError,
    ReasoningStreamMode, StepBudget, StopReason, StreamEvent, TextPhase, ToolResultPart, TurnUsage,
    compose_openai_tool_call_id, compute_continuation_fingerprint, execute_step_with_sink,
    extract_nested_citations, filter_persisted_assistant_history, parse_partial_json_object,
    sanitize_openai_composite_tool_id, split_openai_tool_call_id, validate_continuation_state,
};
use futures_util::StreamExt;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderName, HeaderValue};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use uuid::Uuid;

use crate::sse::{build_http_client, post_json_sse};
use crate::transport::{
    ProviderStepRequest, ProviderStepResult, ProviderTransport, StreamEventCallback,
    ToolDefinition, candidate_continuation_splits,
};

const DEFAULT_OPENAI_BASE_URL: &str = "https://api.openai.com/v1";

/// Native Rust SSE wire transport for the OpenAI Responses API (`POST /v1/responses`).
#[derive(Debug, Clone)]
pub struct OpenAiResponsesTransport {
    client: reqwest::Client,
}

impl Default for OpenAiResponsesTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl OpenAiResponsesTransport {
    pub fn new() -> Self {
        Self {
            client: build_http_client().expect("rustls HTTP client"),
        }
    }
}

/// Loose SSE envelope for OpenAI Responses events.
/// Intentionally omits `#[serde(deny_unknown_fields)]` so additive vendor fields never break streaming.
#[derive(Debug, Clone, Deserialize)]
struct OpenAiResponsesSseEnvelope {
    #[serde(rename = "type")]
    event_type: String,
    #[serde(default)]
    output_index: Option<usize>,
    #[serde(default)]
    item_id: Option<String>,
    #[serde(default)]
    response: Option<Value>,
    #[serde(default)]
    item: Option<Value>,
    #[serde(default)]
    part: Option<Value>,
    #[serde(default)]
    delta: Option<String>,
    #[serde(default)]
    arguments: Option<String>,
    #[serde(default)]
    error: Option<Value>,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    code: Option<String>,
}

#[async_trait]
impl ProviderTransport for OpenAiResponsesTransport {
    async fn stream_step(
        &self,
        request: ProviderStepRequest,
        budget: &StepBudget,
        on_event: &mut StreamEventCallback<'_>,
    ) -> Result<ProviderStepResult, ProviderTransportError> {
        let api_key = resolve_openai_api_key(request.api_key.as_deref())?;
        let base_url = request
            .base_url
            .as_deref()
            .unwrap_or(DEFAULT_OPENAI_BASE_URL)
            .trim_end_matches('/');
        let endpoint = format!("{base_url}/responses");

        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        let auth_val = HeaderValue::from_str(&format!("Bearer {api_key}")).map_err(|e| {
            ProviderTransportError::protocol(format!("Invalid API key header: {e}"))
        })?;
        headers.insert(AUTHORIZATION, auth_val);
        for (k, v) in &request.extra_headers {
            if let (Ok(name), Ok(val)) = (
                HeaderName::from_bytes(k.as_bytes()),
                HeaderValue::from_str(v),
            ) {
                headers.insert(name, val);
            }
        }

        let tool_values: Vec<Value> = request
            .tools
            .iter()
            .map(|t| serde_json::to_value(t).unwrap_or(Value::Null))
            .collect();

        // Check SHA-256 continuation fingerprint against candidate prefixes.
        let mut active_previous_response_id: Option<String> = None;
        let mut input_messages_slice: &[CanonicalMessage] = &request.messages;

        if let Some(stored) = &request.continuation {
            for (prefix, delta) in candidate_continuation_splits(&request.messages) {
                let fp = compute_continuation_fingerprint(&ContinuationFingerprintInput {
                    provider: "openai",
                    model_id: &request.model_id,
                    system_prompt: &request.system_prompt,
                    tools: &tool_values,
                    authorized_tool_names: request.authorized_tool_names.as_deref(),
                    canonical_prefix: prefix,
                    stream_options: &request.provider_options,
                });
                if let Some(ProviderContinuationState::OpenAi { response_id, .. }) =
                    validate_continuation_state(Some(stored), "openai", &request.model_id, &fp)
                {
                    active_previous_response_id = Some(response_id.clone());
                    input_messages_slice = delta;
                    break;
                }
            }
        }

        let wire_body = build_openai_responses_payload(
            &request.model_id,
            &request.system_prompt,
            input_messages_slice,
            &request.tools,
            &request.provider_options,
            active_previous_response_id.as_deref(),
        );

        let client = self.client.clone();
        let turn_id = request.turn_id.clone();
        let model_id = request.model_id.clone();

        let mut step_result = execute_step_with_sink(
            &request.policy,
            budget,
            on_event,
            &mut |_attempt_no, mut emit| {
                let client = client.clone();
                let endpoint = endpoint.clone();
                let headers = headers.clone();
                let wire_body = wire_body.clone();
                let turn_id = turn_id.clone();
                let model_id = model_id.clone();
                let attempt_timeout_ms = request.policy.timeout_ms;

                async move {
                    let timeout_dur = budget.attempt_timeout(attempt_timeout_ms)?;
                    let mut sse =
                        post_json_sse(&client, &endpoint, headers, &wire_body, timeout_dur).await?;

                    let mut decoder = OpenAiStreamState::new(turn_id, model_id);
                    while let Some(frame_res) = sse.next().await {
                        let frame = frame_res?;
                        let trimmed = frame.data.trim();
                        if trimmed.is_empty() || trimmed == "[DONE]" {
                            continue;
                        }
                        let raw_json: Value = serde_json::from_str(trimmed).map_err(|err| {
                            ProviderTransportError::protocol(format!(
                                "Invalid JSON in OpenAI Responses SSE frame: {err}"
                            ))
                        })?;
                        decoder.raw_events.push(raw_json.clone());
                        let env: OpenAiResponsesSseEnvelope = serde_json::from_value(raw_json)
                            .map_err(|err| {
                                ProviderTransportError::protocol(format!(
                                    "Malformed OpenAI Responses event: {err}"
                                ))
                            })?;
                        decoder.handle_event(env, &mut *emit)?;
                    }

                    decoder.finish(String::new())
                }
            },
        )
        .await?;

        if let Some(ProviderContinuationState::OpenAi {
            request_fingerprint,
            ..
        }) = &mut step_result.continuation
        {
            let mut next_prefix = request.messages.clone();
            if let Some(persisted) = &step_result.persisted_assistant {
                next_prefix.push(persisted.clone());
            }
            *request_fingerprint =
                compute_continuation_fingerprint(&ContinuationFingerprintInput {
                    provider: "openai",
                    model_id: &request.model_id,
                    system_prompt: &request.system_prompt,
                    tools: &tool_values,
                    authorized_tool_names: request.authorized_tool_names.as_deref(),
                    canonical_prefix: &next_prefix,
                    stream_options: &request.provider_options,
                });
        }

        Ok(step_result)
    }
}

fn resolve_openai_api_key(explicit: Option<&str>) -> Result<String, ProviderTransportError> {
    if let Some(key) = explicit.map(str::trim).filter(|k| !k.is_empty()) {
        return Ok(key.to_string());
    }
    if let Ok(env_key) = std::env::var("OPENAI_API_KEY")
        && !env_key.trim().is_empty()
    {
        return Ok(env_key.trim().to_string());
    }
    Err(ProviderTransportError::protocol(
        "No API key for provider: openai",
    ))
}

fn is_astra_model(model_id: &str) -> bool {
    let lower = model_id.trim().to_ascii_lowercase();
    lower == "gpt-6-astra" || lower.starts_with("gpt-6-astra-")
}

fn supports_xhigh_reasoning(model_id: &str) -> bool {
    let lower = model_id.trim().to_ascii_lowercase();
    lower == "gpt-5.5"
        || lower.starts_with("gpt-5.5-")
        || lower == "gpt-5.4"
        || lower.starts_with("gpt-5.4-")
        || lower == "gpt-5.2"
        || lower.starts_with("gpt-5.2-")
        || lower.starts_with("gpt-6")
}

fn normalize_openai_reasoning_effort(raw: Option<&str>, model_id: &str) -> Option<String> {
    let is_astra = is_astra_model(model_id);
    let normalized = raw
        .map(str::trim)
        .filter(|s| !s.is_empty())?
        .to_ascii_lowercase();

    // GPT-6 Astra (`agent_docs/astra.md`): `none` is unsupported; migrate `none` or `minimal` -> `low`.
    if is_astra && (normalized == "none" || normalized == "minimal") {
        return Some("low".to_string());
    }
    if normalized == "none" {
        return None;
    }
    if normalized == "xhigh" || normalized == "max" {
        return Some(if supports_xhigh_reasoning(model_id) {
            "xhigh".to_string()
        } else {
            "high".to_string()
        });
    }
    if normalized == "light" {
        return Some("low".to_string());
    }
    if matches!(normalized.as_str(), "minimal" | "low" | "medium" | "high") {
        return Some(normalized);
    }
    None
}

fn read_provider_opt<'a>(opts: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    opts.get(key).or_else(|| {
        opts.get("openai")
            .and_then(Value::as_object)
            .and_then(|sub| sub.get(key))
    })
}

fn build_openai_responses_payload(
    model_id: &str,
    system_prompt: &str,
    messages: &[CanonicalMessage],
    tools: &[ToolDefinition],
    provider_options: &Map<String, Value>,
    previous_response_id: Option<&str>,
) -> Value {
    let is_astra = is_astra_model(model_id);
    let mut input_items = convert_messages_to_responses_input(model_id, messages);

    let effort_raw = read_provider_opt(provider_options, "reasoningEffort").and_then(Value::as_str);
    let summary_raw =
        read_provider_opt(provider_options, "reasoningSummary").and_then(Value::as_str);

    let effort = normalize_openai_reasoning_effort(effort_raw, model_id)
        .or_else(|| is_astra.then(|| "low".to_string()));

    let reasoning_obj = if effort.is_some() || summary_raw.is_some() {
        Some(json!({
            "effort": effort.unwrap_or_else(|| "medium".to_string()),
            "summary": summary_raw.unwrap_or("auto"),
        }))
    } else {
        None
    };

    // Non-reasoning GPT-5 calls append `# Juice: 0 !important` developer instruction (`openaiNativeResponses.ts`).
    if reasoning_obj.is_none() && model_id.trim().to_ascii_lowercase().starts_with("gpt-5") {
        input_items.push(json!({
            "role": "developer",
            "content": [{"type": "input_text", "text": "# Juice: 0 !important"}]
        }));
    }

    let mut body = Map::new();
    body.insert("model".to_string(), Value::String(model_id.to_string()));
    body.insert(
        "instructions".to_string(),
        Value::String(system_prompt.to_string()),
    );
    body.insert("input".to_string(), Value::Array(input_items));
    body.insert("stream".to_string(), Value::Bool(true));
    body.insert("store".to_string(), Value::Bool(true));

    if let Some(prev_id) = previous_response_id
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        body.insert(
            "previous_response_id".to_string(),
            Value::String(prev_id.to_string()),
        );
        body.insert("truncation".to_string(), Value::String("auto".to_string()));
    }

    if let Some(max_toks) = read_provider_opt(provider_options, "maxTokens")
        .or_else(|| read_provider_opt(provider_options, "maxOutputTokens"))
        .and_then(Value::as_u64)
    {
        body.insert("max_output_tokens".to_string(), json!(max_toks));
    }

    // Sampling / logprobs rules: Astra forbids `temperature`, `top_p`, `top_logprobs`, and `message.output_text.logprobs`.
    if !is_astra {
        if let Some(temp) =
            read_provider_opt(provider_options, "temperature").and_then(Value::as_f64)
        {
            body.insert("temperature".to_string(), json!(temp));
        }
        if let Some(top_p) = read_provider_opt(provider_options, "topP")
            .or_else(|| read_provider_opt(provider_options, "top_p"))
            .and_then(Value::as_f64)
        {
            body.insert("top_p".to_string(), json!(top_p));
        }
        if let Some(top_lp) = read_provider_opt(provider_options, "topLogprobs")
            .or_else(|| read_provider_opt(provider_options, "top_logprobs"))
            .and_then(Value::as_u64)
        {
            body.insert("top_logprobs".to_string(), json!(top_lp));
        }
    }

    let mut include_list: Vec<String> = read_provider_opt(provider_options, "include")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .filter(|item| !(is_astra && *item == "message.output_text.logprobs"))
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default();

    if let Some(reasoning) = reasoning_obj {
        body.insert("reasoning".to_string(), reasoning);
        if !include_list
            .iter()
            .any(|s| s == "reasoning.encrypted_content")
        {
            include_list.push("reasoning.encrypted_content".to_string());
        }
    }
    if !include_list.is_empty() {
        body.insert("include".to_string(), json!(include_list));
    }

    if let Some(verbosity) =
        read_provider_opt(provider_options, "textVerbosity").and_then(Value::as_str)
    {
        body.insert("text".to_string(), json!({ "verbosity": verbosity }));
    }

    // Prompt cache migration: Astra replaces `prompt_cache_retention` with `prompt_cache_options.ttl: "30m"`.
    if let Some(retention) = read_provider_opt(provider_options, "promptCacheRetention")
        .or_else(|| read_provider_opt(provider_options, "prompt_cache_retention"))
        .and_then(Value::as_str)
    {
        if is_astra {
            if retention != "none" {
                body.insert("prompt_cache_options".to_string(), json!({ "ttl": "30m" }));
            }
        } else {
            body.insert(
                "prompt_cache_retention".to_string(),
                Value::String(retention.to_string()),
            );
        }
    } else if is_astra
        && let Some(cache_opts) = read_provider_opt(provider_options, "prompt_cache_options")
    {
        body.insert("prompt_cache_options".to_string(), cache_opts.clone());
    }

    // Service tier: Astra with EU data residency does not support `fast` or `priority`.
    let is_eu_residency = read_provider_opt(provider_options, "dataResidency")
        .or_else(|| read_provider_opt(provider_options, "data_residency"))
        .and_then(Value::as_str)
        .is_some_and(|r| r.eq_ignore_ascii_case("eu"));

    if let Some(tier) = read_provider_opt(provider_options, "serviceTier")
        .or_else(|| read_provider_opt(provider_options, "service_tier"))
        .and_then(Value::as_str)
    {
        let blocked_astra_eu = is_astra
            && is_eu_residency
            && (tier.eq_ignore_ascii_case("fast") || tier.eq_ignore_ascii_case("priority"));
        if !blocked_astra_eu {
            body.insert("service_tier".to_string(), Value::String(tier.to_string()));
        }
    }

    if !tools.is_empty() {
        let converted_tools: Vec<Value> = tools
            .iter()
            .map(|t| {
                json!({
                    "type": "function",
                    "name": t.name,
                    "description": t.description,
                    "parameters": t.parameters,
                    "strict": false,
                })
            })
            .collect();
        body.insert("tools".to_string(), Value::Array(converted_tools));
    }

    Value::Object(body)
}

fn convert_messages_to_responses_input(
    target_model_id: &str,
    messages: &[CanonicalMessage],
) -> Vec<Value> {
    let mut items = Vec::new();
    let mut pending_calls: Vec<(String, String)> = Vec::new(); // (call_id, tool_name)
    let mut satisfied_call_ids = std::collections::HashSet::new();

    let flush_orphaned_calls =
        |items: &mut Vec<Value>,
         pending: &mut Vec<(String, String)>,
         satisfied: &mut std::collections::HashSet<String>| {
            for (call_id, _name) in pending.drain(..) {
                if !satisfied.contains(&call_id) {
                    items.push(json!({
                        "type": "function_call_output",
                        "call_id": call_id,
                        "output": "No result provided",
                    }));
                }
            }
            satisfied.clear();
        };

    for (msg_idx, msg) in messages.iter().enumerate() {
        match msg.role {
            MessageRole::System | MessageRole::Developer => {
                flush_orphaned_calls(&mut items, &mut pending_calls, &mut satisfied_call_ids);
                let text = collect_plain_text(&msg.content);
                if !text.is_empty() {
                    let role = if msg.role == MessageRole::Developer {
                        "developer"
                    } else {
                        "system"
                    };
                    items.push(json!({
                        "role": role,
                        "content": [{"type": "input_text", "text": text}],
                    }));
                }
            }
            MessageRole::User => {
                flush_orphaned_calls(&mut items, &mut pending_calls, &mut satisfied_call_ids);
                let mut parts = Vec::new();
                for block in &msg.content {
                    match block {
                        ContentBlock::Text { text, .. } if !text.is_empty() => {
                            parts.push(json!({"type": "input_text", "text": text}));
                        }
                        ContentBlock::Media {
                            kind: MediaKind::Image,
                            source,
                            ..
                        } => {
                            if let Some(image_url) = media_source_to_openai_image_url(source) {
                                parts.push(json!({
                                    "type": "input_image",
                                    "detail": "auto",
                                    "image_url": image_url,
                                }));
                            }
                        }
                        _ => {}
                    }
                }
                if !parts.is_empty() {
                    items.push(json!({
                        "role": "user",
                        "content": parts,
                    }));
                }
            }
            MessageRole::Assistant => {
                flush_orphaned_calls(&mut items, &mut pending_calls, &mut satisfied_call_ids);
                if matches!(
                    msg.stop_reason,
                    Some(StopReason::Error | StopReason::Aborted)
                ) {
                    continue;
                }
                let is_same_provider = msg.provider.as_deref() == Some("openai");
                let is_different_model =
                    is_same_provider && msg.model.as_deref().is_some_and(|m| m != target_model_id);

                for (b_idx, block) in msg.content.iter().enumerate() {
                    match block {
                        ContentBlock::Thinking {
                            text,
                            signature,
                            provider_meta,
                            ..
                        } => {
                            if is_same_provider {
                                if let Some(item_val) = &provider_meta.openai_reasoning_item {
                                    items.push(item_val.clone());
                                    continue;
                                }
                                if let Some(sig) = signature
                                    && let Ok(parsed_item) = serde_json::from_str::<Value>(sig)
                                    && parsed_item.get("type").and_then(Value::as_str)
                                        == Some("reasoning")
                                {
                                    items.push(parsed_item);
                                    continue;
                                }
                            } else if !text.trim().is_empty() {
                                items.push(json!({
                                    "type": "message",
                                    "role": "assistant",
                                    "status": "completed",
                                    "id": format!("msg_{msg_idx}_{b_idx}"),
                                    "content": [{
                                        "type": "output_text",
                                        "text": text,
                                        "annotations": [],
                                    }],
                                }));
                            }
                        }
                        ContentBlock::Text {
                            text,
                            phase,
                            provider_meta,
                            ..
                        } => {
                            if *phase == Some(TextPhase::Commentary) {
                                continue;
                            }
                            let msg_id = provider_meta
                                .openai_item_id
                                .clone()
                                .filter(|id| id.len() <= 64)
                                .unwrap_or_else(|| format!("msg_{msg_idx}_{b_idx}"));
                            let annotations = provider_meta
                                .extra
                                .get("annotations")
                                .and_then(Value::as_array)
                                .cloned()
                                .unwrap_or_default();
                            items.push(json!({
                                "type": "message",
                                "role": "assistant",
                                "status": "completed",
                                "id": msg_id,
                                "content": [{
                                    "type": "output_text",
                                    "text": text,
                                    "annotations": annotations,
                                }],
                            }));
                        }
                        ContentBlock::ToolCall {
                            id,
                            name,
                            arguments,
                            ..
                        } => {
                            let normalized = if is_same_provider {
                                id.clone()
                            } else {
                                sanitize_openai_composite_tool_id(id)
                            };
                            let (call_id, item_id_opt) = split_openai_tool_call_id(&normalized);
                            let item_id = match item_id_opt {
                                Some(it) if is_different_model && it.starts_with("fc_") => None,
                                other => other,
                            };
                            let mut fc_obj = Map::new();
                            fc_obj.insert(
                                "type".to_string(),
                                Value::String("function_call".to_string()),
                            );
                            if let Some(it) = item_id {
                                fc_obj.insert("id".to_string(), Value::String(it.to_string()));
                            }
                            fc_obj
                                .insert("call_id".to_string(), Value::String(call_id.to_string()));
                            fc_obj.insert("name".to_string(), Value::String(name.clone()));
                            fc_obj.insert(
                                "arguments".to_string(),
                                Value::String(
                                    serde_json::to_string(arguments)
                                        .unwrap_or_else(|_| "{}".to_string()),
                                ),
                            );
                            pending_calls.push((call_id.to_string(), name.clone()));
                            items.push(Value::Object(fc_obj));
                        }
                        _ => {}
                    }
                }
            }
            MessageRole::Tool => {
                for block in &msg.content {
                    if let ContentBlock::ToolResult {
                        tool_call_id,
                        content,
                        ..
                    } = block
                    {
                        let (call_id, _) = split_openai_tool_call_id(tool_call_id);
                        satisfied_call_ids.insert(call_id.to_string());

                        let mut texts = Vec::new();
                        let mut images = Vec::new();
                        for part in content {
                            match part {
                                ToolResultPart::Text { text } => texts.push(text.as_str()),
                                ToolResultPart::Media {
                                    kind: MediaKind::Image,
                                    source,
                                } => {
                                    if let Some(url) = media_source_to_openai_image_url(source) {
                                        images.push(url);
                                    }
                                }
                                _ => {}
                            }
                        }
                        let output_str = if !texts.is_empty() {
                            texts.join("\n")
                        } else if !images.is_empty() {
                            "(see attached image)".to_string()
                        } else {
                            String::new()
                        };
                        items.push(json!({
                            "type": "function_call_output",
                            "call_id": call_id,
                            "output": output_str,
                        }));

                        if !images.is_empty() {
                            let mut user_parts = vec![json!({
                                "type": "input_text",
                                "text": "Attached image(s) from tool result:",
                            })];
                            for url in images {
                                user_parts.push(json!({
                                    "type": "input_image",
                                    "detail": "auto",
                                    "image_url": url,
                                }));
                            }
                            items.push(json!({
                                "role": "user",
                                "content": user_parts,
                            }));
                        }
                    }
                }
            }
        }
    }

    flush_orphaned_calls(&mut items, &mut pending_calls, &mut satisfied_call_ids);
    items
}

fn collect_plain_text(blocks: &[ContentBlock]) -> String {
    blocks
        .iter()
        .filter_map(|b| match b {
            ContentBlock::Text { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn media_source_to_openai_image_url(source: &MediaSource) -> Option<String> {
    match source {
        MediaSource::Base64 { mime_type, data } => Some(format!("data:{mime_type};base64,{data}")),
        MediaSource::Url { url, .. } => Some(url.clone()),
        MediaSource::FileRef { .. } => None,
    }
}

struct OpenAiStreamState {
    turn_id: String,
    model_id: String,
    response_id: Option<String>,
    open_items: BTreeMap<usize, OpenAiActiveItem>,
    finished_blocks: BTreeMap<usize, ContentBlock>,
    next_auto_slot: usize,
    last_slot: Option<usize>,
    usage: TurnUsage,
    stop_reason: StopReason,
    completed: bool,
    raw_events: Vec<Value>,
}

enum OpenAiActiveItem {
    Reasoning {
        item_id: String,
        summary_parts: Vec<String>,
    },
    Message {
        block_index: usize,
        item_id: String,
        phase: Option<TextPhase>,
        text_buf: String,
    },
    FunctionCall {
        item_id: String,
        key: String,
        name: String,
        partial_json: String,
    },
}

impl OpenAiActiveItem {
    fn item_id(&self) -> &str {
        match self {
            Self::Reasoning { item_id, .. }
            | Self::Message { item_id, .. }
            | Self::FunctionCall { item_id, .. } => item_id,
        }
    }
}

impl OpenAiStreamState {
    fn new(turn_id: String, model_id: String) -> Self {
        Self {
            turn_id,
            model_id,
            response_id: None,
            open_items: BTreeMap::new(),
            finished_blocks: BTreeMap::new(),
            next_auto_slot: 0,
            last_slot: None,
            usage: TurnUsage::default(),
            stop_reason: StopReason::Stop,
            completed: false,
            raw_events: Vec::new(),
        }
    }

    fn resolve_open_slot(
        &self,
        output_index: Option<usize>,
        item_id: Option<&str>,
    ) -> Option<usize> {
        if let Some(idx) = output_index
            && self.open_items.contains_key(&idx)
        {
            return Some(idx);
        }
        if let Some(target_id) = item_id
            && let Some((&slot, _)) = self
                .open_items
                .iter()
                .find(|(_, active)| active.item_id() == target_id)
        {
            return Some(slot);
        }
        self.last_slot
            .filter(|slot| self.open_items.contains_key(slot))
            .or_else(|| self.open_items.keys().next_back().copied())
    }

    fn handle_event(
        &mut self,
        env: OpenAiResponsesSseEnvelope,
        emit: &mut dyn FnMut(StreamEvent),
    ) -> Result<(), ProviderTransportError> {
        if let Some(resp) = &env.response
            && let Some(id) = resp
                .get("id")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
        {
            self.response_id = Some(id.to_string());
        }

        match env.event_type.as_str() {
            "response.output_item.added" => {
                let Some(item) = env.item.as_ref().and_then(Value::as_object) else {
                    return Ok(());
                };
                let slot = env.output_index.unwrap_or(self.next_auto_slot);
                self.next_auto_slot = self.next_auto_slot.max(slot + 1);
                let item_type = item.get("type").and_then(Value::as_str).unwrap_or_default();
                let item_id = item
                    .get("id")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
                    .unwrap_or_else(|| format!("item_{slot}"));

                match item_type {
                    "reasoning" => {
                        emit(StreamEvent::ThinkingStart {
                            turn_id: self.turn_id.clone(),
                            stream_id: item_id.clone(),
                            mode: ReasoningStreamMode::Summary,
                        });
                        self.open_items.insert(
                            slot,
                            OpenAiActiveItem::Reasoning {
                                item_id,
                                summary_parts: Vec::new(),
                            },
                        );
                        self.last_slot = Some(slot);
                    }
                    "message" => {
                        let phase = item
                            .get("phase")
                            .and_then(Value::as_str)
                            .and_then(TextPhase::from_wire);
                        emit(StreamEvent::TextStart {
                            turn_id: self.turn_id.clone(),
                            block_index: slot,
                            phase,
                        });
                        self.open_items.insert(
                            slot,
                            OpenAiActiveItem::Message {
                                block_index: slot,
                                item_id,
                                phase,
                                text_buf: String::new(),
                            },
                        );
                        self.last_slot = Some(slot);
                    }
                    "function_call" => {
                        let call_id = item
                            .get("call_id")
                            .and_then(Value::as_str)
                            .unwrap_or(&item_id);
                        let composite = compose_openai_tool_call_id(call_id, &item_id);
                        let name = item
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("tool")
                            .to_string();
                        let initial_partial = item
                            .get("arguments")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        emit(StreamEvent::ToolCallStart {
                            turn_id: self.turn_id.clone(),
                            key: composite.clone(),
                            name: name.clone(),
                            initial_args: None,
                        });
                        self.open_items.insert(
                            slot,
                            OpenAiActiveItem::FunctionCall {
                                item_id,
                                key: composite,
                                name,
                                partial_json: initial_partial,
                            },
                        );
                        self.last_slot = Some(slot);
                    }
                    _ => {}
                }
            }
            "response.reasoning_summary_part.added" => {
                if let Some(slot) = self.resolve_open_slot(env.output_index, env.item_id.as_deref())
                    && let Some(OpenAiActiveItem::Reasoning { summary_parts, .. }) =
                        self.open_items.get_mut(&slot)
                {
                    let init_text = env
                        .part
                        .as_ref()
                        .and_then(|p| p.get("text"))
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    summary_parts.push(init_text);
                }
            }
            "response.reasoning_summary_text.delta" => {
                if let Some(delta) = env.delta.as_deref()
                    && let Some(slot) =
                        self.resolve_open_slot(env.output_index, env.item_id.as_deref())
                    && let Some(OpenAiActiveItem::Reasoning {
                        item_id,
                        summary_parts,
                    }) = self.open_items.get_mut(&slot)
                {
                    if summary_parts.is_empty() {
                        summary_parts.push(String::new());
                    }
                    if let Some(last) = summary_parts.last_mut() {
                        last.push_str(delta);
                    }
                    emit(StreamEvent::ThinkingDelta {
                        turn_id: self.turn_id.clone(),
                        stream_id: item_id.clone(),
                        mode: ReasoningStreamMode::Summary,
                        delta: delta.to_string(),
                    });
                }
            }
            "response.reasoning_summary_part.done" => {
                if let Some(slot) = self.resolve_open_slot(env.output_index, env.item_id.as_deref())
                    && let Some(OpenAiActiveItem::Reasoning { item_id, .. }) =
                        self.open_items.get(&slot)
                {
                    emit(StreamEvent::ThinkingDelta {
                        turn_id: self.turn_id.clone(),
                        stream_id: item_id.clone(),
                        mode: ReasoningStreamMode::Summary,
                        delta: "\n\n".to_string(),
                    });
                }
            }
            "response.output_text.delta" | "response.refusal.delta" => {
                if let Some(delta) = env.delta.as_deref()
                    && let Some(slot) =
                        self.resolve_open_slot(env.output_index, env.item_id.as_deref())
                    && let Some(OpenAiActiveItem::Message {
                        block_index,
                        phase,
                        text_buf,
                        ..
                    }) = self.open_items.get_mut(&slot)
                {
                    text_buf.push_str(delta);
                    emit(StreamEvent::TextDelta {
                        turn_id: self.turn_id.clone(),
                        block_index: *block_index,
                        delta: delta.to_string(),
                        phase: *phase,
                    });
                }
            }
            "response.function_call_arguments.delta" => {
                if let Some(delta) = env.delta.as_deref()
                    && let Some(slot) =
                        self.resolve_open_slot(env.output_index, env.item_id.as_deref())
                    && let Some(OpenAiActiveItem::FunctionCall {
                        key,
                        name,
                        partial_json,
                        ..
                    }) = self.open_items.get_mut(&slot)
                {
                    partial_json.push_str(delta);
                    emit(StreamEvent::ToolCallDelta {
                        turn_id: self.turn_id.clone(),
                        key: key.clone(),
                        name: name.clone(),
                        delta: delta.to_string(),
                    });
                }
            }
            "response.function_call_arguments.done" => {
                if let Some(args) = env.arguments
                    && let Some(slot) =
                        self.resolve_open_slot(env.output_index, env.item_id.as_deref())
                    && let Some(OpenAiActiveItem::FunctionCall { partial_json, .. }) =
                        self.open_items.get_mut(&slot)
                {
                    *partial_json = args;
                }
            }
            "response.output_item.done" => {
                let Some(item_val) = env.item else {
                    return Ok(());
                };
                let Some(item) = item_val.as_object() else {
                    return Ok(());
                };
                let item_type = item.get("type").and_then(Value::as_str).unwrap_or_default();
                let done_item_id = item.get("id").and_then(Value::as_str);
                let resolved_slot = self.resolve_open_slot(env.output_index, done_item_id);
                let removed_active = resolved_slot.and_then(|s| self.open_items.remove(&s));
                let slot = resolved_slot.unwrap_or_else(|| {
                    let s = env.output_index.unwrap_or(self.next_auto_slot);
                    self.next_auto_slot = self.next_auto_slot.max(s + 1);
                    s
                });

                match item_type {
                    "reasoning" => {
                        let fallback_rs_id = match &removed_active {
                            Some(OpenAiActiveItem::Reasoning { item_id, .. }) => item_id.as_str(),
                            _ => "rs_0",
                        };
                        let item_id = done_item_id.unwrap_or(fallback_rs_id).to_string();
                        let summary_text = item
                            .get("summary")
                            .and_then(Value::as_array)
                            .map(|arr| {
                                arr.iter()
                                    .filter_map(|p| p.get("text").and_then(Value::as_str))
                                    .collect::<Vec<_>>()
                                    .join("\n\n")
                            })
                            .unwrap_or_default();
                        let serialized_item = serde_json::to_string(&item_val).ok();
                        let encrypted_content = item.get("encrypted_content").cloned();

                        emit(StreamEvent::ThinkingEnd {
                            turn_id: self.turn_id.clone(),
                            stream_id: item_id.clone(),
                            mode: ReasoningStreamMode::Summary,
                            text: summary_text.clone(),
                            signature: serialized_item.clone(),
                            redacted: false,
                        });

                        self.finished_blocks.insert(
                            slot,
                            ContentBlock::Thinking {
                                text: summary_text.clone(),
                                summary: (!summary_text.is_empty()).then_some(summary_text),
                                redacted: false,
                                signature: serialized_item,
                                provider_meta: ProviderOpaqueMeta {
                                    openai_response_id: self.response_id.clone(),
                                    openai_item_id: Some(item_id),
                                    openai_encrypted_reasoning: encrypted_content,
                                    openai_reasoning_item: Some(item_val),
                                    ..Default::default()
                                },
                            },
                        );
                    }
                    "message" => {
                        let fallback_item_id = match &removed_active {
                            Some(OpenAiActiveItem::Message { item_id, .. }) => item_id.as_str(),
                            _ => "msg_0",
                        };
                        let item_id = done_item_id.unwrap_or(fallback_item_id).to_string();
                        let phase = item
                            .get("phase")
                            .and_then(Value::as_str)
                            .and_then(TextPhase::from_wire);
                        let mut full_text = String::new();
                        let mut raw_annotations = Vec::new();
                        if let Some(parts) = item.get("content").and_then(Value::as_array) {
                            for p in parts {
                                let p_type =
                                    p.get("type").and_then(Value::as_str).unwrap_or_default();
                                if p_type == "output_text" {
                                    if let Some(t) = p.get("text").and_then(Value::as_str) {
                                        full_text.push_str(t);
                                    }
                                    if let Some(anns) =
                                        p.get("annotations").and_then(Value::as_array)
                                    {
                                        raw_annotations.extend(anns.iter().cloned());
                                    }
                                } else if let Some(r) = p.get("refusal").and_then(Value::as_str) {
                                    full_text.push_str(r);
                                }
                            }
                        }
                        if full_text.is_empty()
                            && let Some(OpenAiActiveItem::Message { text_buf, .. }) =
                                &removed_active
                        {
                            full_text = text_buf.clone();
                        }

                        let citations: Vec<Citation> =
                            extract_nested_citations(&Value::Array(raw_annotations.clone()));
                        let block_index = match &removed_active {
                            Some(OpenAiActiveItem::Message { block_index, .. }) => *block_index,
                            _ => slot,
                        };

                        emit(StreamEvent::TextEnd {
                            turn_id: self.turn_id.clone(),
                            block_index,
                            text: full_text.clone(),
                            phase,
                            citations: citations.clone(),
                            annotations: raw_annotations.clone(),
                        });

                        let mut extra = Map::new();
                        if !raw_annotations.is_empty() {
                            extra.insert("annotations".to_string(), Value::Array(raw_annotations));
                        }
                        self.finished_blocks.insert(
                            slot,
                            ContentBlock::Text {
                                text: full_text,
                                phase,
                                citations,
                                provider_meta: ProviderOpaqueMeta {
                                    openai_response_id: self.response_id.clone(),
                                    openai_item_id: Some(item_id),
                                    extra,
                                    ..Default::default()
                                },
                            },
                        );
                    }
                    "function_call" => {
                        let fallback_fc_id = match &removed_active {
                            Some(OpenAiActiveItem::FunctionCall { item_id, .. }) => {
                                item_id.as_str()
                            }
                            _ => "fc_0",
                        };
                        let item_id = done_item_id.unwrap_or(fallback_fc_id).to_string();
                        let call_id = item
                            .get("call_id")
                            .and_then(Value::as_str)
                            .unwrap_or(&item_id)
                            .to_string();
                        let composite = compose_openai_tool_call_id(&call_id, &item_id);
                        let name = item
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("tool")
                            .to_string();
                        let raw_args = match &removed_active {
                            Some(OpenAiActiveItem::FunctionCall { partial_json, .. })
                                if !partial_json.is_empty() =>
                            {
                                partial_json.as_str()
                            }
                            _ => item
                                .get("arguments")
                                .and_then(Value::as_str)
                                .unwrap_or("{}"),
                        };
                        let parsed_args = parse_partial_json_object(raw_args);

                        emit(StreamEvent::ToolCallEnd {
                            turn_id: self.turn_id.clone(),
                            key: composite.clone(),
                            name: name.clone(),
                            arguments: Some(parsed_args.clone()),
                            retry_of: None,
                            input_digest: None,
                        });

                        self.finished_blocks.insert(
                            slot,
                            ContentBlock::ToolCall {
                                id: composite,
                                name,
                                arguments: parsed_args,
                                partial_json: None,
                                provider_meta: ProviderOpaqueMeta {
                                    openai_response_id: self.response_id.clone(),
                                    openai_item_id: Some(item_id),
                                    openai_call_id: Some(call_id),
                                    ..Default::default()
                                },
                            },
                        );
                    }
                    _ => {}
                }
            }
            "response.completed" | "response.incomplete" | "response.failed" => {
                if let Some(resp) = env.response.as_ref().and_then(Value::as_object) {
                    if let Some(usage) = resp.get("usage").and_then(Value::as_object) {
                        let input_tokens = usage
                            .get("input_tokens")
                            .and_then(Value::as_u64)
                            .unwrap_or(0);
                        let cached_tokens = usage
                            .get("input_tokens_details")
                            .and_then(|d| d.get("cached_tokens"))
                            .and_then(Value::as_u64)
                            .unwrap_or(0);
                        let output_tokens = usage
                            .get("output_tokens")
                            .and_then(Value::as_u64)
                            .unwrap_or(0);
                        let reasoning_tokens = usage
                            .get("output_tokens_details")
                            .and_then(|d| d.get("reasoning_tokens"))
                            .and_then(Value::as_u64);
                        let total_tokens = usage
                            .get("total_tokens")
                            .and_then(Value::as_u64)
                            .unwrap_or(input_tokens + output_tokens);

                        self.usage = TurnUsage {
                            prompt_tokens: input_tokens,
                            completion_tokens: output_tokens,
                            total_tokens,
                            cached_prompt_tokens: (cached_tokens > 0).then_some(cached_tokens),
                            cache_write_prompt_tokens: None,
                            reasoning_output_tokens: reasoning_tokens,
                            estimated_cost_usd: None,
                        };
                    }
                    if env.event_type != "response.completed" {
                        let err_msg = resp
                            .get("error")
                            .and_then(|e| e.get("message"))
                            .and_then(Value::as_str)
                            .or(env.message.as_deref())
                            .unwrap_or("OpenAI response failed.");
                        return Err(ProviderTransportError::protocol(err_msg));
                    }
                    self.stop_reason = if self
                        .finished_blocks
                        .values()
                        .any(|b| matches!(b, ContentBlock::ToolCall { .. }))
                    {
                        StopReason::ToolUse
                    } else {
                        StopReason::Stop
                    };
                }
                self.completed = true;
            }
            "error" => {
                let msg = env
                    .error
                    .as_ref()
                    .and_then(|e| e.get("message"))
                    .and_then(Value::as_str)
                    .or(env.message.as_deref())
                    .unwrap_or("OpenAI stream error");
                let mut err = ProviderTransportError::protocol(msg);
                err.code = env.code;
                return Err(err);
            }
            _ => {}
        }

        Ok(())
    }

    fn finish(
        self,
        next_fingerprint: String,
    ) -> Result<ProviderStepResult, ProviderTransportError> {
        if !self.completed {
            return Err(ProviderTransportError::network(
                "OpenAI response stream ended before completion.",
            ));
        }

        let content: Vec<ContentBlock> = self.finished_blocks.into_values().collect();
        let phase = content.iter().rev().find_map(|b| match b {
            ContentBlock::Text { phase: Some(p), .. } => Some(*p),
            _ => None,
        });

        let assistant = CanonicalMessage {
            id: self
                .response_id
                .clone()
                .unwrap_or_else(|| format!("resp_{}", Uuid::new_v4())),
            role: MessageRole::Assistant,
            content,
            phase,
            provider: Some("openai".to_string()),
            api: Some("openai-responses".to_string()),
            model: Some(self.model_id.clone()),
            stop_reason: Some(self.stop_reason),
            provider_meta: ProviderOpaqueMeta {
                openai_response_id: self.response_id.clone(),
                ..Default::default()
            },
            created_at: Utc::now().to_rfc3339(),
        };

        let persisted_assistant = filter_persisted_assistant_history(&assistant);
        let continuation = self
            .response_id
            .map(|resp_id| ProviderContinuationState::OpenAi {
                model: self.model_id,
                response_id: resp_id,
                updated_at: Utc::now().to_rfc3339(),
                request_fingerprint: next_fingerprint,
            });

        Ok(ProviderStepResult {
            assistant,
            persisted_assistant,
            usage: self.usage,
            continuation,
            raw_events: self.raw_events,
        })
    }
}
