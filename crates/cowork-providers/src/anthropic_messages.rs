use std::collections::BTreeMap;

use async_trait::async_trait;
use chrono::Utc;
use cowork_inference::{
    CanonicalMessage, Citation, ContentBlock, MediaKind, MediaSource, MessageRole,
    ProviderOpaqueMeta, ProviderTransportError, ReasoningStreamMode, StepBudget, StopReason,
    StreamEvent, ToolResultPart, TurnUsage, execute_step_with_sink, extract_nested_citations,
    filter_persisted_assistant_history, parse_partial_json_object,
};
use futures_util::StreamExt;
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderName, HeaderValue};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use uuid::Uuid;

use crate::sse::{build_http_client, post_json_sse};
use crate::transport::{
    ProviderStepRequest, ProviderStepResult, ProviderTransport, StreamEventCallback, ToolDefinition,
};

const DEFAULT_ANTHROPIC_BASE_URL: &str = "https://api.anthropic.com";
const ANTHROPIC_API_VERSION: &str = "2023-06-01";
const CLAUDE_CODE_IDENTITY: &str = "You are Claude Code, Anthropic's official CLI for Claude.";

const CLAUDE_CODE_CANONICAL_TOOLS: &[&str] = &[
    "Read",
    "Write",
    "Edit",
    "Bash",
    "Grep",
    "Glob",
    "AskUserQuestion",
    "EnterPlanMode",
    "ExitPlanMode",
    "KillShell",
    "NotebookEdit",
    "Skill",
    "Task",
    "TaskOutput",
    "TodoWrite",
    "WebFetch",
    "WebSearch",
];

/// Native Rust SSE wire transport for the Anthropic Messages API (`POST /v1/messages`).
#[derive(Debug, Clone)]
pub struct AnthropicMessagesTransport {
    client: reqwest::Client,
}

impl Default for AnthropicMessagesTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl AnthropicMessagesTransport {
    pub fn new() -> Self {
        Self {
            client: build_http_client().expect("rustls HTTP client"),
        }
    }
}

/// Loose SSE payload for Anthropic Messages events.
/// Intentionally omits `#[serde(deny_unknown_fields)]` so additive vendor fields never break streaming.
#[derive(Debug, Clone, Deserialize)]
struct AnthropicSseEvent {
    #[serde(rename = "type")]
    event_type: String,
    #[serde(default)]
    index: Option<usize>,
    #[serde(default)]
    message: Option<Value>,
    #[serde(default)]
    content_block: Option<Value>,
    #[serde(default)]
    delta: Option<Value>,
    #[serde(default)]
    usage: Option<Value>,
    #[serde(default)]
    error: Option<Value>,
}

#[async_trait]
impl ProviderTransport for AnthropicMessagesTransport {
    async fn stream_step(
        &self,
        request: ProviderStepRequest,
        budget: &StepBudget,
        on_event: &mut StreamEventCallback<'_>,
    ) -> Result<ProviderStepResult, ProviderTransportError> {
        let allow_ambient_env = !request.provider_options.contains_key("coworkHome");
        let api_key = resolve_anthropic_api_key(request.api_key.as_deref(), allow_ambient_env)?;
        let is_oauth = api_key.contains("sk-ant-oat");

        let raw_base = request
            .base_url
            .as_deref()
            .unwrap_or(DEFAULT_ANTHROPIC_BASE_URL)
            .trim_end_matches('/');
        let endpoint = if raw_base.ends_with("/v1") {
            format!("{raw_base}/messages")
        } else {
            format!("{raw_base}/v1/messages")
        };

        let (wire_body, beta_features, effort_meta) = build_anthropic_messages_payload(
            &request.model_id,
            &request.system_prompt,
            &request.messages,
            &request.tools,
            &request.provider_options,
            is_oauth,
        );

        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        headers.insert(ACCEPT, HeaderValue::from_static("text/event-stream"));
        headers.insert(
            HeaderName::from_static("anthropic-version"),
            HeaderValue::from_static(ANTHROPIC_API_VERSION),
        );

        if is_oauth {
            let bearer = HeaderValue::from_str(&format!("Bearer {api_key}")).map_err(|e| {
                ProviderTransportError::protocol(format!("Invalid Anthropic OAuth token: {e}"))
            })?;
            headers.insert(AUTHORIZATION, bearer);
        } else {
            let key_val = HeaderValue::from_str(&api_key).map_err(|e| {
                ProviderTransportError::protocol(format!("Invalid Anthropic API key: {e}"))
            })?;
            headers.insert(HeaderName::from_static("x-api-key"), key_val);
        }

        if !beta_features.is_empty()
            && let Ok(beta_val) = HeaderValue::from_str(&beta_features.join(","))
        {
            headers.insert(HeaderName::from_static("anthropic-beta"), beta_val);
        }

        for (k, v) in &request.extra_headers {
            if let (Ok(name), Ok(val)) = (
                HeaderName::from_bytes(k.as_bytes()),
                HeaderValue::from_str(v),
            ) {
                headers.insert(name, val);
            }
        }

        let client = self.client.clone();
        let turn_id = request.turn_id.clone();
        let model_id = request.model_id.clone();
        let declared_tools = request.tools.clone();

        execute_step_with_sink(
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
                let effort_meta = effort_meta.clone();
                let declared_tools = declared_tools.clone();
                let attempt_timeout_ms = request.policy.timeout_ms;

                async move {
                    let timeout_dur = budget.attempt_timeout(attempt_timeout_ms)?;
                    let mut sse =
                        post_json_sse(&client, &endpoint, headers, &wire_body, timeout_dur).await?;

                    let mut decoder =
                        AnthropicStreamState::new(turn_id, model_id, is_oauth, declared_tools);
                    while let Some(frame_res) = sse.next().await {
                        let frame = frame_res?;
                        let trimmed = frame.data.trim();
                        if trimmed.is_empty() || trimmed == "[DONE]" || frame.event == "ping" {
                            continue;
                        }
                        let raw_json: Value = serde_json::from_str(trimmed).map_err(|err| {
                            ProviderTransportError::protocol(format!(
                                "Invalid JSON in Anthropic SSE frame: {err}"
                            ))
                        })?;
                        decoder.raw_events.push(raw_json.clone());
                        let ev: AnthropicSseEvent =
                            serde_json::from_value(raw_json).map_err(|err| {
                                ProviderTransportError::protocol(format!(
                                    "Malformed Anthropic SSE event: {err}"
                                ))
                            })?;
                        decoder.handle_event(ev, &mut *emit)?;
                    }

                    decoder.finish(effort_meta)
                }
            },
        )
        .await
    }
}

fn resolve_anthropic_api_key(
    explicit: Option<&str>,
    allow_ambient_env: bool,
) -> Result<String, ProviderTransportError> {
    if let Some(key) = explicit.map(str::trim).filter(|k| !k.is_empty()) {
        return Ok(key.to_string());
    }
    if allow_ambient_env {
        for var in ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"] {
            if let Ok(val) = std::env::var(var)
                && !val.trim().is_empty()
            {
                return Ok(val.trim().to_string());
            }
        }
    }
    Err(ProviderTransportError::protocol(
        "No API key for provider: anthropic",
    ))
}

fn to_claude_code_name(name: &str) -> String {
    for &canonical in CLAUDE_CODE_CANONICAL_TOOLS {
        if canonical.eq_ignore_ascii_case(name) {
            return canonical.to_string();
        }
    }
    name.to_string()
}

fn from_claude_code_name(name: &str, declared_tools: &[ToolDefinition]) -> String {
    for t in declared_tools {
        if t.name.eq_ignore_ascii_case(name) {
            return t.name.clone();
        }
    }
    name.to_string()
}

fn read_anthropic_opt<'a>(opts: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    opts.get("anthropic")
        .and_then(Value::as_object)
        .and_then(|sub| sub.get(key))
        .or_else(|| opts.get(key))
}

fn model_forces_adaptive_thinking(model_id: &str) -> bool {
    let lower = model_id.trim().to_ascii_lowercase();
    lower.starts_with("claude-opus-4-7") || lower.starts_with("claude-opus-4-8")
}

fn resolve_cache_control(opts: &Map<String, Value>) -> Option<Value> {
    let retention = read_anthropic_opt(opts, "cacheRetention")
        .or_else(|| read_anthropic_opt(opts, "cache_retention"))
        .and_then(Value::as_str)
        .unwrap_or("short");

    match retention {
        "none" => None,
        "long" => Some(json!({ "type": "ephemeral", "ttl": "1h" })),
        _ => Some(json!({ "type": "ephemeral" })),
    }
}

fn build_anthropic_messages_payload(
    model_id: &str,
    system_prompt: &str,
    messages: &[CanonicalMessage],
    tools: &[ToolDefinition],
    provider_options: &Map<String, Value>,
    is_oauth: bool,
) -> (Value, Vec<String>, Option<String>) {
    let cache_control = resolve_cache_control(provider_options);
    let mut betas: Vec<String> = Vec::new();
    if is_oauth {
        betas.push("claude-code-20250219".to_string());
        betas.push("oauth-2025-04-20".to_string());
    }
    if !tools.is_empty() {
        betas.push("fine-grained-tool-streaming-2025-05-14".to_string());
    }

    let thinking_cfg = read_anthropic_opt(provider_options, "thinking").and_then(Value::as_object);
    let explicit_thinking_type = thinking_cfg
        .and_then(|t| t.get("type"))
        .and_then(Value::as_str);
    let explicit_effort = read_anthropic_opt(provider_options, "effort")
        .or_else(|| read_anthropic_opt(provider_options, "reasoningEffort"))
        .or_else(|| read_anthropic_opt(provider_options, "reasoning_effort"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty() && *s != "none" && *s != "off")
        .map(ToOwned::to_owned);

    let mut thinking_payload: Option<Value> = None;
    let mut active_effort: Option<String> = None;

    if explicit_thinking_type != Some("disabled") {
        if explicit_thinking_type == Some("adaptive")
            || (explicit_thinking_type.is_none()
                && (model_forces_adaptive_thinking(model_id) || explicit_effort.is_some()))
        {
            thinking_payload = Some(json!({
                "type": "adaptive",
                "display": "summarized",
            }));
            active_effort = Some(explicit_effort.unwrap_or_else(|| "high".to_string()));
        } else if explicit_thinking_type == Some("enabled")
            || thinking_cfg.and_then(|t| t.get("budgetTokens")).is_some()
        {
            let budget_tokens = thinking_cfg
                .and_then(|t| t.get("budgetTokens").or_else(|| t.get("budget_tokens")))
                .and_then(Value::as_u64)
                .unwrap_or(16_000)
                .max(1_024);
            thinking_payload = Some(json!({
                "type": "enabled",
                "budget_tokens": budget_tokens,
                "display": "summarized",
            }));
            betas.push("interleaved-thinking-2025-05-14".to_string());
        }
    }

    let mut max_tokens = read_anthropic_opt(provider_options, "maxTokens")
        .or_else(|| read_anthropic_opt(provider_options, "max_tokens"))
        .or_else(|| read_anthropic_opt(provider_options, "maxOutputTokens"))
        .and_then(Value::as_u64)
        .unwrap_or(32_000);
    if let Some(budget_toks) = thinking_payload
        .as_ref()
        .and_then(|t| t.get("budget_tokens"))
        .and_then(Value::as_u64)
        && max_tokens <= budget_toks
    {
        max_tokens = budget_toks + 8_192;
    }

    let converted_messages =
        convert_messages_to_anthropic(messages, is_oauth, cache_control.as_ref());

    let mut body = Map::new();
    body.insert("model".to_string(), Value::String(model_id.to_string()));
    body.insert("max_tokens".to_string(), json!(max_tokens));
    body.insert("stream".to_string(), Value::Bool(true));
    body.insert("messages".to_string(), Value::Array(converted_messages));

    // System prompt blocks + trailing cache_control breakpoint.
    let mut system_blocks: Vec<Value> = Vec::new();
    if is_oauth {
        system_blocks.push(json!({
            "type": "text",
            "text": CLAUDE_CODE_IDENTITY,
        }));
    }
    if !system_prompt.trim().is_empty() {
        system_blocks.push(json!({
            "type": "text",
            "text": system_prompt,
        }));
    }
    if let (Some(cc), Some(last_sys)) = (&cache_control, system_blocks.last_mut())
        && let Some(obj) = last_sys.as_object_mut()
    {
        obj.insert("cache_control".to_string(), cc.clone());
    }
    if !system_blocks.is_empty() {
        body.insert("system".to_string(), Value::Array(system_blocks));
    }

    // Temperature is incompatible with Anthropic thinking modes (`anthropic-messages.js`).
    if thinking_payload.is_none()
        && let Some(temp) =
            read_anthropic_opt(provider_options, "temperature").and_then(Value::as_f64)
    {
        body.insert("temperature".to_string(), json!(temp));
    }

    if let Some(thinking) = thinking_payload {
        body.insert("thinking".to_string(), thinking);
    }
    if let Some(effort) = &active_effort {
        body.insert("output_config".to_string(), json!({ "effort": effort }));
    }

    if !tools.is_empty() {
        let last_idx = tools.len() - 1;
        let wire_tools: Vec<Value> = tools
            .iter()
            .enumerate()
            .map(|(idx, t)| {
                let props = t
                    .parameters
                    .get("properties")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                let req = t
                    .parameters
                    .get("required")
                    .cloned()
                    .unwrap_or_else(|| json!([]));
                let mut tool_obj = Map::new();
                tool_obj.insert(
                    "name".to_string(),
                    Value::String(if is_oauth {
                        to_claude_code_name(&t.name)
                    } else {
                        t.name.clone()
                    }),
                );
                tool_obj.insert(
                    "description".to_string(),
                    Value::String(t.description.clone()),
                );
                tool_obj.insert(
                    "input_schema".to_string(),
                    json!({
                        "type": "object",
                        "properties": props,
                        "required": req,
                    }),
                );
                if idx == last_idx
                    && let Some(cc) = &cache_control
                {
                    tool_obj.insert("cache_control".to_string(), cc.clone());
                }
                Value::Object(tool_obj)
            })
            .collect();
        body.insert("tools".to_string(), Value::Array(wire_tools));

        if read_anthropic_opt(provider_options, "disableParallelToolUse").and_then(Value::as_bool)
            == Some(true)
        {
            body.insert(
                "tool_choice".to_string(),
                json!({
                    "type": "auto",
                    "disable_parallel_tool_use": true,
                }),
            );
        }
    }

    (Value::Object(body), betas, active_effort)
}

fn convert_messages_to_anthropic(
    messages: &[CanonicalMessage],
    is_oauth: bool,
    cache_control: Option<&Value>,
) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let mut pending_tool_ids: Vec<String> = Vec::new();
    let mut satisfied_tool_ids = std::collections::HashSet::new();

    let flush_orphaned =
        |out: &mut Vec<Value>,
         pending: &mut Vec<String>,
         satisfied: &mut std::collections::HashSet<String>| {
            let missing: Vec<Value> = pending
                .drain(..)
                .filter(|id| !satisfied.contains(id))
                .map(|id| {
                    json!({
                        "type": "tool_result",
                        "tool_use_id": id,
                        "content": "No result provided",
                        "is_error": true,
                    })
                })
                .collect();
            satisfied.clear();
            if !missing.is_empty() {
                out.push(json!({
                    "role": "user",
                    "content": missing,
                }));
            }
        };

    let mut idx = 0;
    while idx < messages.len() {
        let msg = &messages[idx];
        match msg.role {
            MessageRole::System | MessageRole::Developer => {
                idx += 1;
            }
            MessageRole::User => {
                flush_orphaned(&mut out, &mut pending_tool_ids, &mut satisfied_tool_ids);
                let mut blocks = Vec::new();
                for b in &msg.content {
                    match b {
                        ContentBlock::Text { text, .. } if !text.trim().is_empty() => {
                            blocks.push(json!({ "type": "text", "text": text }));
                        }
                        ContentBlock::Media {
                            kind: MediaKind::Image,
                            source: MediaSource::Base64 { mime_type, data },
                            ..
                        } => {
                            blocks.push(json!({
                                "type": "image",
                                "source": {
                                    "type": "base64",
                                    "media_type": mime_type,
                                    "data": data,
                                }
                            }));
                        }
                        ContentBlock::Media {
                            kind: MediaKind::Document,
                            source: MediaSource::Base64 { mime_type, data },
                            ..
                        } => {
                            blocks.push(json!({
                                "type": "document",
                                "source": {
                                    "type": "base64",
                                    "media_type": mime_type,
                                    "data": data,
                                }
                            }));
                        }
                        _ => {}
                    }
                }
                if !blocks.is_empty() {
                    out.push(json!({
                        "role": "user",
                        "content": blocks,
                    }));
                }
                idx += 1;
            }
            MessageRole::Assistant => {
                flush_orphaned(&mut out, &mut pending_tool_ids, &mut satisfied_tool_ids);
                let mut blocks = Vec::new();
                for b in &msg.content {
                    match b {
                        ContentBlock::Thinking {
                            text,
                            redacted,
                            signature,
                            provider_meta,
                            ..
                        } => {
                            if *redacted || provider_meta.anthropic_redacted_thinking.is_some() {
                                let data = provider_meta
                                    .anthropic_redacted_thinking
                                    .as_deref()
                                    .or(signature.as_deref())
                                    .unwrap_or_default();
                                blocks.push(json!({
                                    "type": "redacted_thinking",
                                    "data": data,
                                }));
                                continue;
                            }
                            let sig = provider_meta
                                .anthropic_thinking_signature
                                .as_deref()
                                .or(signature.as_deref())
                                .map(str::trim)
                                .filter(|s| !s.is_empty());
                            if let Some(sig) = sig {
                                blocks.push(json!({
                                    "type": "thinking",
                                    "thinking": text,
                                    "signature": sig,
                                }));
                            } else if !text.trim().is_empty() {
                                blocks.push(json!({
                                    "type": "text",
                                    "text": text,
                                }));
                            }
                        }
                        ContentBlock::Text { text, .. } if !text.trim().is_empty() => {
                            blocks.push(json!({
                                "type": "text",
                                "text": text,
                            }));
                        }
                        ContentBlock::ToolCall {
                            id,
                            name,
                            arguments,
                            ..
                        } => {
                            let clean_id = sanitize_anthropic_tool_id(id);
                            pending_tool_ids.push(clean_id.clone());
                            blocks.push(json!({
                                "type": "tool_use",
                                "id": clean_id,
                                "name": if is_oauth { to_claude_code_name(name) } else { name.clone() },
                                "input": arguments,
                            }));
                        }
                        _ => {}
                    }
                }
                if !blocks.is_empty() {
                    out.push(json!({
                        "role": "assistant",
                        "content": blocks,
                    }));
                }
                idx += 1;
            }
            MessageRole::Tool => {
                // Collect consecutive tool-result messages into a single `user` turn (`anthropic-messages.js`).
                let mut tool_results = Vec::new();
                while idx < messages.len() && messages[idx].role == MessageRole::Tool {
                    for b in &messages[idx].content {
                        if let ContentBlock::ToolResult {
                            tool_call_id,
                            content,
                            is_error,
                            ..
                        } = b
                        {
                            let clean_id = sanitize_anthropic_tool_id(tool_call_id);
                            satisfied_tool_ids.insert(clean_id.clone());
                            let mut inner_parts = Vec::new();
                            for part in content {
                                match part {
                                    ToolResultPart::Text { text } => {
                                        inner_parts.push(json!({ "type": "text", "text": text }));
                                    }
                                    ToolResultPart::Media {
                                        kind: MediaKind::Image,
                                        source: MediaSource::Base64 { mime_type, data },
                                    } => {
                                        inner_parts.push(json!({
                                            "type": "image",
                                            "source": {
                                                "type": "base64",
                                                "media_type": mime_type,
                                                "data": data,
                                            }
                                        }));
                                    }
                                    ToolResultPart::Media {
                                        kind: MediaKind::Document,
                                        source: MediaSource::Base64 { mime_type, data },
                                    } => {
                                        inner_parts.push(json!({
                                            "type": "document",
                                            "source": {
                                                "type": "base64",
                                                "media_type": mime_type,
                                                "data": data,
                                            }
                                        }));
                                    }
                                    _ => {}
                                }
                            }
                            tool_results.push(json!({
                                "type": "tool_result",
                                "tool_use_id": clean_id,
                                "content": inner_parts,
                                "is_error": is_error,
                            }));
                        }
                    }
                    idx += 1;
                }
                if !tool_results.is_empty() {
                    out.push(json!({
                        "role": "user",
                        "content": tool_results,
                    }));
                }
            }
        }
    }

    flush_orphaned(&mut out, &mut pending_tool_ids, &mut satisfied_tool_ids);

    // Attach `cache_control` breakpoint to the last content block of the trailing `user` message.
    if let (Some(cc), Some(last_msg)) = (cache_control, out.last_mut())
        && last_msg.get("role").and_then(Value::as_str) == Some("user")
        && let Some(arr) = last_msg.get_mut("content").and_then(Value::as_array_mut)
        && let Some(last_block) = arr.last_mut().and_then(Value::as_object_mut)
    {
        last_block.insert("cache_control".to_string(), cc.clone());
    }

    out
}

fn sanitize_anthropic_tool_id(raw: &str) -> String {
    let base = raw.split('|').next().unwrap_or(raw);
    let mut cleaned: String = base
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.len() > 64 {
        cleaned.truncate(64);
    }
    cleaned
}

enum AnthropicOpenBlock {
    Text {
        text: String,
        citations: Vec<Citation>,
    },
    Thinking {
        thinking: String,
        signature: String,
    },
    RedactedThinking {
        data: String,
    },
    ToolUse {
        id: String,
        name: String,
        initial_input: Map<String, Value>,
        partial_json: String,
    },
}

struct AnthropicStreamState {
    turn_id: String,
    model_id: String,
    is_oauth: bool,
    declared_tools: Vec<ToolDefinition>,
    message_id: Option<String>,
    open_blocks: BTreeMap<usize, AnthropicOpenBlock>,
    finished_blocks: BTreeMap<usize, ContentBlock>,
    input_tokens: u64,
    cache_read_tokens: u64,
    cache_write_tokens: u64,
    output_tokens: u64,
    stop_reason: StopReason,
    completed: bool,
    raw_events: Vec<Value>,
}

impl AnthropicStreamState {
    fn new(
        turn_id: String,
        model_id: String,
        is_oauth: bool,
        declared_tools: Vec<ToolDefinition>,
    ) -> Self {
        Self {
            turn_id,
            model_id,
            is_oauth,
            declared_tools,
            message_id: None,
            open_blocks: BTreeMap::new(),
            finished_blocks: BTreeMap::new(),
            input_tokens: 0,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            output_tokens: 0,
            stop_reason: StopReason::Stop,
            completed: false,
            raw_events: Vec::new(),
        }
    }

    fn handle_event(
        &mut self,
        ev: AnthropicSseEvent,
        emit: &mut dyn FnMut(StreamEvent),
    ) -> Result<(), ProviderTransportError> {
        match ev.event_type.as_str() {
            "message_start" => {
                if let Some(msg) = ev.message.as_ref().and_then(Value::as_object) {
                    if let Some(id) = msg.get("id").and_then(Value::as_str) {
                        self.message_id = Some(id.to_string());
                    }
                    if let Some(u) = msg.get("usage").and_then(Value::as_object) {
                        self.update_usage_counters(u);
                    }
                }
            }
            "content_block_start" => {
                let idx = ev.index.unwrap_or(0);
                let Some(cb) = ev.content_block.as_ref().and_then(Value::as_object) else {
                    return Ok(());
                };
                let cb_type = cb.get("type").and_then(Value::as_str).unwrap_or_default();
                match cb_type {
                    "text" => {
                        let init = cb
                            .get("text")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        emit(StreamEvent::TextStart {
                            turn_id: self.turn_id.clone(),
                            block_index: idx,
                            phase: None,
                        });
                        if !init.is_empty() {
                            emit(StreamEvent::TextDelta {
                                turn_id: self.turn_id.clone(),
                                block_index: idx,
                                delta: init.clone(),
                                phase: None,
                            });
                        }
                        self.open_blocks.insert(
                            idx,
                            AnthropicOpenBlock::Text {
                                text: init,
                                citations: Vec::new(),
                            },
                        );
                    }
                    "thinking" => {
                        let stream_id = format!("thinking_{idx}");
                        emit(StreamEvent::ThinkingStart {
                            turn_id: self.turn_id.clone(),
                            stream_id,
                            mode: ReasoningStreamMode::Reasoning,
                        });
                        self.open_blocks.insert(
                            idx,
                            AnthropicOpenBlock::Thinking {
                                thinking: cb
                                    .get("thinking")
                                    .and_then(Value::as_str)
                                    .unwrap_or_default()
                                    .to_string(),
                                signature: cb
                                    .get("signature")
                                    .and_then(Value::as_str)
                                    .unwrap_or_default()
                                    .to_string(),
                            },
                        );
                    }
                    "redacted_thinking" => {
                        let data = cb
                            .get("data")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        let stream_id = format!("redacted_{idx}");
                        emit(StreamEvent::ThinkingStart {
                            turn_id: self.turn_id.clone(),
                            stream_id,
                            mode: ReasoningStreamMode::Summary,
                        });
                        self.open_blocks
                            .insert(idx, AnthropicOpenBlock::RedactedThinking { data });
                    }
                    "tool_use" => {
                        let id = cb
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or("toolu_0")
                            .to_string();
                        let wire_name = cb.get("name").and_then(Value::as_str).unwrap_or("tool");
                        let name = if self.is_oauth {
                            from_claude_code_name(wire_name, &self.declared_tools)
                        } else {
                            wire_name.to_string()
                        };
                        let initial_input = cb
                            .get("input")
                            .and_then(Value::as_object)
                            .cloned()
                            .unwrap_or_default();
                        emit(StreamEvent::ToolCallStart {
                            turn_id: self.turn_id.clone(),
                            key: id.clone(),
                            name: name.clone(),
                            initial_args: (!initial_input.is_empty())
                                .then(|| initial_input.clone()),
                        });
                        self.open_blocks.insert(
                            idx,
                            AnthropicOpenBlock::ToolUse {
                                id,
                                name,
                                initial_input,
                                partial_json: String::new(),
                            },
                        );
                    }
                    _ => {}
                }
            }
            "content_block_delta" => {
                let idx = ev.index.unwrap_or(0);
                let Some(delta_obj) = ev.delta.as_ref().and_then(Value::as_object) else {
                    return Ok(());
                };
                let d_type = delta_obj
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or_default();

                match (d_type, self.open_blocks.get_mut(&idx)) {
                    ("text_delta", Some(AnthropicOpenBlock::Text { text, .. })) => {
                        if let Some(chunk) = delta_obj.get("text").and_then(Value::as_str) {
                            text.push_str(chunk);
                            emit(StreamEvent::TextDelta {
                                turn_id: self.turn_id.clone(),
                                block_index: idx,
                                delta: chunk.to_string(),
                                phase: None,
                            });
                        }
                    }
                    ("citations_delta", Some(AnthropicOpenBlock::Text { citations, .. })) => {
                        if let Some(cit) = delta_obj.get("citation") {
                            citations.extend(extract_nested_citations(cit));
                        }
                    }
                    ("thinking_delta", Some(AnthropicOpenBlock::Thinking { thinking, .. })) => {
                        if let Some(chunk) = delta_obj.get("thinking").and_then(Value::as_str) {
                            thinking.push_str(chunk);
                            emit(StreamEvent::ThinkingDelta {
                                turn_id: self.turn_id.clone(),
                                stream_id: format!("thinking_{idx}"),
                                mode: ReasoningStreamMode::Reasoning,
                                delta: chunk.to_string(),
                            });
                        }
                    }
                    ("signature_delta", Some(AnthropicOpenBlock::Thinking { signature, .. })) => {
                        if let Some(sig) = delta_obj.get("signature").and_then(Value::as_str) {
                            signature.push_str(sig);
                        }
                    }
                    (
                        "input_json_delta",
                        Some(AnthropicOpenBlock::ToolUse {
                            id,
                            name,
                            partial_json,
                            ..
                        }),
                    ) => {
                        if let Some(chunk) = delta_obj.get("partial_json").and_then(Value::as_str) {
                            partial_json.push_str(chunk);
                            emit(StreamEvent::ToolCallDelta {
                                turn_id: self.turn_id.clone(),
                                key: id.clone(),
                                name: name.clone(),
                                delta: chunk.to_string(),
                            });
                        }
                    }
                    _ => {}
                }
            }
            "content_block_stop" => {
                let idx = ev.index.unwrap_or(0);
                if let Some(open) = self.open_blocks.remove(&idx) {
                    match open {
                        AnthropicOpenBlock::Text { text, citations } => {
                            emit(StreamEvent::TextEnd {
                                turn_id: self.turn_id.clone(),
                                block_index: idx,
                                text: text.clone(),
                                phase: None,
                                citations: citations.clone(),
                                annotations: Vec::new(),
                            });
                            self.finished_blocks.insert(
                                idx,
                                ContentBlock::Text {
                                    text,
                                    phase: None,
                                    citations,
                                    provider_meta: ProviderOpaqueMeta::default(),
                                },
                            );
                        }
                        AnthropicOpenBlock::Thinking {
                            thinking,
                            signature,
                        } => {
                            let sig_opt = (!signature.is_empty()).then_some(signature);
                            emit(StreamEvent::ThinkingEnd {
                                turn_id: self.turn_id.clone(),
                                stream_id: format!("thinking_{idx}"),
                                mode: ReasoningStreamMode::Reasoning,
                                text: thinking.clone(),
                                signature: sig_opt.clone(),
                                redacted: false,
                            });
                            self.finished_blocks.insert(
                                idx,
                                ContentBlock::Thinking {
                                    text: thinking,
                                    summary: None,
                                    redacted: false,
                                    signature: sig_opt.clone(),
                                    provider_meta: ProviderOpaqueMeta {
                                        anthropic_thinking_signature: sig_opt,
                                        ..Default::default()
                                    },
                                },
                            );
                        }
                        AnthropicOpenBlock::RedactedThinking { data } => {
                            emit(StreamEvent::ThinkingEnd {
                                turn_id: self.turn_id.clone(),
                                stream_id: format!("redacted_{idx}"),
                                mode: ReasoningStreamMode::Summary,
                                text: String::new(),
                                signature: Some(data.clone()),
                                redacted: true,
                            });
                            self.finished_blocks.insert(
                                idx,
                                ContentBlock::Thinking {
                                    text: String::new(),
                                    summary: None,
                                    redacted: true,
                                    signature: Some(data.clone()),
                                    provider_meta: ProviderOpaqueMeta {
                                        anthropic_redacted_thinking: Some(data),
                                        ..Default::default()
                                    },
                                },
                            );
                        }
                        AnthropicOpenBlock::ToolUse {
                            id,
                            name,
                            initial_input,
                            partial_json,
                        } => {
                            let args = if !partial_json.trim().is_empty() {
                                parse_partial_json_object(&partial_json)
                            } else {
                                initial_input
                            };
                            emit(StreamEvent::ToolCallEnd {
                                turn_id: self.turn_id.clone(),
                                key: id.clone(),
                                name: name.clone(),
                                arguments: Some(args.clone()),
                                retry_of: None,
                                input_digest: None,
                            });
                            self.finished_blocks.insert(
                                idx,
                                ContentBlock::ToolCall {
                                    id,
                                    name,
                                    arguments: args,
                                    partial_json: None,
                                    provider_meta: ProviderOpaqueMeta::default(),
                                },
                            );
                        }
                    }
                }
            }
            "message_delta" => {
                if let Some(d) = ev.delta.as_ref().and_then(Value::as_object)
                    && let Some(sr) = d.get("stop_reason").and_then(Value::as_str)
                {
                    self.stop_reason = match sr {
                        "tool_use" => StopReason::ToolUse,
                        "max_tokens" => StopReason::Length,
                        "refusal" | "sensitive" => StopReason::Error,
                        _ => StopReason::Stop,
                    };
                }
                if let Some(u) = ev.usage.as_ref().and_then(Value::as_object) {
                    self.update_usage_counters(u);
                }
            }
            "message_stop" => {
                self.completed = true;
            }
            "error" => {
                let msg = ev
                    .error
                    .as_ref()
                    .and_then(|e| e.get("message"))
                    .and_then(Value::as_str)
                    .unwrap_or("Anthropic stream error");
                return Err(ProviderTransportError::protocol(msg));
            }
            _ => {}
        }
        Ok(())
    }

    fn update_usage_counters(&mut self, u: &Map<String, Value>) {
        if let Some(v) = u.get("input_tokens").and_then(Value::as_u64) {
            self.input_tokens = v;
        }
        if let Some(v) = u.get("cache_read_input_tokens").and_then(Value::as_u64) {
            self.cache_read_tokens = v;
        }
        if let Some(v) = u.get("cache_creation_input_tokens").and_then(Value::as_u64) {
            self.cache_write_tokens = v;
        }
        if let Some(v) = u.get("output_tokens").and_then(Value::as_u64) {
            self.output_tokens = v;
        }
    }

    fn finish(
        self,
        effort_meta: Option<String>,
    ) -> Result<ProviderStepResult, ProviderTransportError> {
        if !self.completed && self.finished_blocks.is_empty() {
            return Err(ProviderTransportError::network(
                "Anthropic stream ended before message_stop.",
            ));
        }

        let content: Vec<ContentBlock> = self.finished_blocks.into_values().collect();
        let prompt_tokens = self.input_tokens + self.cache_read_tokens + self.cache_write_tokens;
        let usage = TurnUsage {
            prompt_tokens,
            completion_tokens: self.output_tokens,
            total_tokens: prompt_tokens + self.output_tokens,
            cached_prompt_tokens: (self.cache_read_tokens > 0).then_some(self.cache_read_tokens),
            cache_write_prompt_tokens: (self.cache_write_tokens > 0)
                .then_some(self.cache_write_tokens),
            reasoning_output_tokens: None,
            estimated_cost_usd: None,
        };

        let assistant = CanonicalMessage {
            id: self
                .message_id
                .unwrap_or_else(|| format!("msg_{}", Uuid::new_v4())),
            role: MessageRole::Assistant,
            content,
            phase: None,
            provider: Some("anthropic".to_string()),
            api: Some("anthropic-messages".to_string()),
            model: Some(self.model_id),
            stop_reason: Some(self.stop_reason),
            provider_meta: ProviderOpaqueMeta {
                anthropic_effort: effort_meta,
                ..Default::default()
            },
            created_at: Utc::now().to_rfc3339(),
        };

        let persisted_assistant = filter_persisted_assistant_history(&assistant);
        Ok(ProviderStepResult {
            assistant,
            persisted_assistant,
            usage,
            continuation: None,
            raw_events: self.raw_events,
        })
    }
}
