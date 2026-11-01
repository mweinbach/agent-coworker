//! SSE chunk decoding for OpenAI-compatible Chat Completions streams.
//!
//! Intentionally omits `#[serde(deny_unknown_fields)]` on all wire structs so provider-specific
//! telemetry fields (such as LM Studio's `"stats"` and `"model_info"`) never cause parse failures.

use std::collections::HashMap;

use chrono::Utc;
use cowork_config::ProviderName;
use cowork_inference::{
    CanonicalMessage, ContentBlock, MessageRole, ProviderOpaqueMeta, ProviderTransportError,
    ReasoningStreamMode, StopReason, StreamEvent, TurnUsage, filter_persisted_assistant_history,
    parse_partial_json_object,
};
use serde::Deserialize;
use serde_json::{Map, Value};
use uuid::Uuid;

use crate::chat_completions::quirks::normalize_null_tool_arguments;
use crate::chat_completions::think_tags::{
    ThinkTagSplitState, flush_think_tag_split_state, split_think_tagged_text_chunk,
};
use crate::transport::{ProviderStepResult, ToolDefinition};

#[derive(Debug, Clone, Deserialize)]
pub struct ChatCompletionsChunk {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub choices: Vec<ChatChoiceDelta>,
    #[serde(default)]
    pub usage: Option<ChatUsageChunk>,
    #[serde(default)]
    pub error: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ChatChoiceDelta {
    #[serde(default)]
    pub index: Option<usize>,
    #[serde(default)]
    pub delta: Option<ChatMessageDelta>,
    #[serde(default)]
    pub finish_reason: Option<String>,
    /// Some providers (e.g. Moonshot) report usage on the choice instead of the chunk.
    #[serde(default)]
    pub usage: Option<ChatUsageChunk>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ChatMessageDelta {
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub reasoning_content: Option<String>,
    #[serde(default)]
    pub reasoning: Option<String>,
    #[serde(default)]
    pub reasoning_text: Option<String>,
    #[serde(default)]
    pub tool_calls: Option<Vec<ChatToolCallDelta>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ChatToolCallDelta {
    #[serde(default)]
    pub index: Option<usize>,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub function: Option<ChatFunctionDelta>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ChatFunctionDelta {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub arguments: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ChatUsageChunk {
    #[serde(default)]
    pub prompt_tokens: Option<u64>,
    #[serde(default)]
    pub completion_tokens: Option<u64>,
    #[serde(default)]
    pub total_tokens: Option<u64>,
    /// DeepSeek cache-hit count.
    #[serde(default)]
    pub prompt_cache_hit_tokens: Option<u64>,
    /// Kimi top-level cache-hit count.
    #[serde(default)]
    pub cached_tokens: Option<u64>,
    #[serde(default)]
    pub prompt_tokens_details: Option<PromptTokensDetails>,
    #[serde(default)]
    pub completion_tokens_details: Option<CompletionTokensDetails>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PromptTokensDetails {
    #[serde(default)]
    pub cached_tokens: Option<u64>,
    #[serde(default)]
    pub cache_write_tokens: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CompletionTokensDetails {
    #[serde(default)]
    pub reasoning_tokens: Option<u64>,
}

/// `ContentBlock::Thinking` provider-meta key recording which Chat Completions delta field
/// (`reasoning_content`, `reasoning` or `reasoning_text`) streamed the reasoning, so replay can
/// write it back under the same field (pi `thinkingSignature` parity).
pub const CHAT_COMPLETIONS_REASONING_FIELD_META_KEY: &str = "openaiCompletionsReasoningField";

/// Delta fields that carry reasoning text, in pi's lookup order (first non-empty wins, so
/// providers that duplicate reasoning across fields, e.g. chutes.ai, are not double counted).
pub const CHAT_COMPLETIONS_REASONING_FIELDS: [&str; 3] =
    ["reasoning_content", "reasoning", "reasoning_text"];

/// Maps a terminal `finish_reason` to a stop reason, or the provider error message for reasons
/// pi `mapStopReason` treats as failures (`content_filter`, `network_error`, unknown values).
pub fn map_chat_completions_finish_reason(reason: &str) -> Result<StopReason, String> {
    match reason {
        "stop" | "end" => Ok(StopReason::Stop),
        "length" => Ok(StopReason::Length),
        "function_call" | "tool_calls" => Ok(StopReason::ToolUse),
        other => Err(format!("Provider finish_reason: {other}")),
    }
}

#[derive(Debug, Default)]
struct ToolCallAcc {
    id: String,
    /// True once `id` holds a provider-sent id (not a synthesized fallback).
    has_provider_id: bool,
    name: String,
    raw_args: String,
    started: bool,
    stream_index: Option<usize>,
}

pub struct ChatCompletionsStreamAccumulator {
    provider: ProviderName,
    model_id: String,
    turn_id: String,
    think_stream_id: String,
    split_inline_think: bool,
    think_state: ThinkTagSplitState,
    thinking_started: bool,
    thinking_closed: bool,
    thinking_text: String,
    thinking_field: Option<&'static str>,
    text_started: bool,
    text_closed: bool,
    visible_text: String,
    tool_calls: Vec<ToolCallAcc>,
    tool_calls_by_index: HashMap<usize, usize>,
    tool_calls_by_id: HashMap<String, usize>,
    finish_reason: Option<String>,
    usage: TurnUsage,
    response_id: Option<String>,
    tool_schemas: HashMap<String, Value>,
    raw_events: Vec<Value>,
}

impl ChatCompletionsStreamAccumulator {
    pub fn new(
        provider: ProviderName,
        model_id: String,
        turn_id: String,
        split_inline_think: bool,
        tools: &[ToolDefinition],
    ) -> Self {
        let mut tool_schemas = HashMap::new();
        for tool in tools {
            tool_schemas.insert(tool.name.clone(), tool.parameters.clone());
        }
        let think_stream_id = format!("{turn_id}:think");
        Self {
            provider,
            model_id,
            turn_id,
            think_stream_id,
            split_inline_think,
            think_state: ThinkTagSplitState::default(),
            thinking_started: false,
            thinking_closed: false,
            thinking_text: String::new(),
            thinking_field: None,
            text_started: false,
            text_closed: false,
            visible_text: String::new(),
            tool_calls: Vec::new(),
            tool_calls_by_index: HashMap::new(),
            tool_calls_by_id: HashMap::new(),
            finish_reason: None,
            usage: TurnUsage::default(),
            response_id: None,
            tool_schemas,
            raw_events: Vec::new(),
        }
    }

    fn emit_thinking_delta(&mut self, delta: &str, emit: &mut dyn FnMut(StreamEvent)) {
        if delta.is_empty() {
            return;
        }
        if !self.thinking_started {
            self.thinking_started = true;
            emit(StreamEvent::ThinkingStart {
                turn_id: self.turn_id.clone(),
                stream_id: self.think_stream_id.clone(),
                mode: ReasoningStreamMode::Reasoning,
            });
        }
        self.thinking_text.push_str(delta);
        emit(StreamEvent::ThinkingDelta {
            turn_id: self.turn_id.clone(),
            stream_id: self.think_stream_id.clone(),
            mode: ReasoningStreamMode::Reasoning,
            delta: delta.to_string(),
        });
    }

    fn close_thinking_if_open(&mut self, emit: &mut dyn FnMut(StreamEvent)) {
        if self.thinking_started && !self.thinking_closed {
            self.thinking_closed = true;
            emit(StreamEvent::ThinkingEnd {
                turn_id: self.turn_id.clone(),
                stream_id: self.think_stream_id.clone(),
                mode: ReasoningStreamMode::Reasoning,
                text: self.thinking_text.clone(),
                signature: None,
                redacted: false,
            });
        }
    }

    fn emit_text_delta(&mut self, delta: &str, emit: &mut dyn FnMut(StreamEvent)) {
        if delta.is_empty() {
            return;
        }
        self.close_thinking_if_open(emit);
        if !self.text_started {
            self.text_started = true;
            emit(StreamEvent::TextStart {
                turn_id: self.turn_id.clone(),
                block_index: 0,
                phase: None,
            });
        }
        self.visible_text.push_str(delta);
        emit(StreamEvent::TextDelta {
            turn_id: self.turn_id.clone(),
            block_index: 0,
            delta: delta.to_string(),
            phase: None,
        });
    }

    fn close_text_if_open(&mut self, emit: &mut dyn FnMut(StreamEvent)) {
        if self.text_started && !self.text_closed {
            self.text_closed = true;
            emit(StreamEvent::TextEnd {
                turn_id: self.turn_id.clone(),
                block_index: 0,
                text: self.visible_text.clone(),
                phase: None,
                citations: Vec::new(),
                annotations: Vec::new(),
            });
        }
    }

    /// pi `parseChunkUsage` parity for the cache fields: cache reads come from
    /// `prompt_tokens_details.cached_tokens` (OpenAI/OpenRouter), then `prompt_cache_hit_tokens`
    /// (DeepSeek), then top-level `cached_tokens` (Kimi); cache writes come from
    /// `prompt_tokens_details.cache_write_tokens`. `prompt_tokens` stays the inclusive total.
    fn apply_usage(&mut self, u: ChatUsageChunk) {
        let prompt = u.prompt_tokens.unwrap_or(self.usage.prompt_tokens);
        let completion = u.completion_tokens.unwrap_or(self.usage.completion_tokens);
        let total = u.total_tokens.unwrap_or(prompt + completion);
        self.usage.prompt_tokens = prompt;
        self.usage.completion_tokens = completion;
        self.usage.total_tokens = total;
        let details = u.prompt_tokens_details.as_ref();
        if let Some(cached) = details
            .and_then(|d| d.cached_tokens)
            .or(u.prompt_cache_hit_tokens)
            .or(u.cached_tokens)
        {
            self.usage.cached_prompt_tokens = Some(cached);
        }
        if let Some(cache_write) = details.and_then(|d| d.cache_write_tokens) {
            self.usage.cache_write_prompt_tokens = Some(cache_write);
        }
        if let Some(reasoning) = u.completion_tokens_details.and_then(|d| d.reasoning_tokens) {
            self.usage.reasoning_output_tokens = Some(reasoning);
        }
    }

    /// pi `ensureToolCallBlock` parity: look the call up by stream `index` when present, else by
    /// `id`, else allocate a new slot. Parallel calls that omit `index` therefore stay distinct
    /// instead of all merging into slot 0.
    fn ensure_tool_call_slot(&mut self, index: Option<usize>, id: Option<&str>) -> usize {
        let mut slot = index.and_then(|i| self.tool_calls_by_index.get(&i).copied());
        if slot.is_none()
            && let Some(id) = id
        {
            slot = self.tool_calls_by_id.get(id).copied();
        }
        let slot = match slot {
            Some(slot) => slot,
            None => {
                self.tool_calls.push(ToolCallAcc {
                    stream_index: index,
                    ..ToolCallAcc::default()
                });
                let slot = self.tool_calls.len() - 1;
                if let Some(i) = index {
                    self.tool_calls_by_index.insert(i, slot);
                }
                slot
            }
        };
        if let Some(i) = index
            && self.tool_calls[slot].stream_index.is_none()
        {
            self.tool_calls[slot].stream_index = Some(i);
            self.tool_calls_by_index.insert(i, slot);
        }
        if let Some(id) = id {
            self.tool_calls_by_id.insert(id.to_string(), slot);
        }
        slot
    }

    pub fn push_data_frame(
        &mut self,
        data: &str,
        emit: &mut dyn FnMut(StreamEvent),
    ) -> Result<bool, ProviderTransportError> {
        let trimmed = data.trim();
        if trimmed.is_empty() {
            return Ok(false);
        }
        if trimmed == "[DONE]" {
            return Ok(true);
        }

        let raw_val: Value = serde_json::from_str(trimmed).map_err(|err| {
            ProviderTransportError::protocol(format!(
                "Invalid Chat Completions SSE JSON chunk: {err}"
            ))
        })?;
        self.raw_events.push(raw_val.clone());

        let chunk: ChatCompletionsChunk = serde_json::from_value(raw_val).map_err(|err| {
            ProviderTransportError::protocol(format!(
                "Failed to decode Chat Completions SSE chunk: {err}"
            ))
        })?;

        if let Some(err_val) = chunk.error {
            let msg = err_val
                .get("message")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
                .unwrap_or_else(|| err_val.to_string());
            return Err(ProviderTransportError::protocol(format!(
                "Provider stream error: {msg}"
            )));
        }

        if let Some(id) = chunk.id.filter(|s| !s.is_empty()) {
            self.response_id = Some(id);
        }

        // Some providers (e.g. Moonshot) report usage in `choices[0].usage` instead of the
        // standard chunk-level `usage`; pi consults it only when `chunk.usage` is absent.
        let usage = chunk
            .usage
            .or_else(|| chunk.choices.first().and_then(|c| c.usage.clone()));
        if let Some(u) = usage {
            self.apply_usage(u);
        }

        for choice in chunk.choices {
            if let Some(reason) = choice.finish_reason.filter(|r| !r.is_empty()) {
                self.finish_reason = Some(reason);
            }
            let Some(delta) = choice.delta else {
                continue;
            };

            let reasoning = [
                (
                    CHAT_COMPLETIONS_REASONING_FIELDS[0],
                    delta.reasoning_content,
                ),
                (CHAT_COMPLETIONS_REASONING_FIELDS[1], delta.reasoning),
                (CHAT_COMPLETIONS_REASONING_FIELDS[2], delta.reasoning_text),
            ]
            .into_iter()
            .find_map(|(field, value)| value.filter(|s| !s.is_empty()).map(|v| (field, v)));
            if let Some((field, rc)) = reasoning {
                // pi `ensureThinkingBlock`: the first reasoning field seen labels the block.
                // opencode-go streams `reasoning` but requires `reasoning_content` on replay.
                if self.thinking_field.is_none() {
                    self.thinking_field = Some(
                        if self.provider == ProviderName::OpencodeGo && field == "reasoning" {
                            "reasoning_content"
                        } else {
                            field
                        },
                    );
                }
                self.emit_thinking_delta(&rc, emit);
            }

            if let Some(content) = delta.content.filter(|s| !s.is_empty()) {
                if self.split_inline_think {
                    let split = split_think_tagged_text_chunk(&mut self.think_state, &content);
                    if !split.thinking_text.is_empty() {
                        self.emit_thinking_delta(&split.thinking_text, emit);
                    }
                    if !split.visible_text.is_empty() {
                        self.emit_text_delta(&split.visible_text, emit);
                    }
                } else {
                    self.emit_text_delta(&content, emit);
                }
            }

            if let Some(tcs) = delta.tool_calls {
                for tc in tcs {
                    self.close_thinking_if_open(emit);
                    self.close_text_if_open(emit);

                    let provider_id = tc.id.filter(|s| !s.is_empty());
                    let slot = self.ensure_tool_call_slot(tc.index, provider_id.as_deref());
                    let turn_id = &self.turn_id;
                    let entry = &mut self.tool_calls[slot];
                    if let Some(id) = provider_id
                        && !entry.has_provider_id
                        && !entry.started
                    {
                        entry.id = id;
                        entry.has_provider_id = true;
                    }
                    if entry.id.is_empty() {
                        entry.id = format!("call_{turn_id}_{slot}");
                    }
                    if let Some(func) = tc.function {
                        if let Some(name) = func.name.filter(|s| !s.is_empty())
                            && entry.name.is_empty()
                        {
                            entry.name = name;
                        }
                        if !entry.started && !entry.name.is_empty() {
                            entry.started = true;
                            emit(StreamEvent::ToolCallStart {
                                turn_id: self.turn_id.clone(),
                                key: entry.id.clone(),
                                name: entry.name.clone(),
                                initial_args: None,
                            });
                        }
                        if let Some(arg_delta) = func.arguments.filter(|s| !s.is_empty()) {
                            entry.raw_args.push_str(&arg_delta);
                            if entry.started {
                                emit(StreamEvent::ToolCallDelta {
                                    turn_id: self.turn_id.clone(),
                                    key: entry.id.clone(),
                                    name: entry.name.clone(),
                                    delta: arg_delta,
                                });
                            }
                        }
                    }
                }
            }
        }

        Ok(false)
    }

    /// Finalizes a stream that ended (via `data: [DONE]` or connection close).
    ///
    /// A choice-level `finish_reason` is the terminal completion signal (some OpenAI-compatible
    /// providers omit `[DONE]`, but all send `finish_reason`). A stream that closes without one
    /// was truncated, so it fails with the same retryable network error kind as the Anthropic and
    /// Google Interactions transports instead of surfacing partial text or partial tool calls as
    /// a normal completion. Tool calls whose accumulated arguments are not a complete JSON object
    /// are likewise rejected rather than repaired, so a truncated command is never executed.
    pub fn finalize(
        mut self,
        emit: &mut dyn FnMut(StreamEvent),
    ) -> Result<ProviderStepResult, ProviderTransportError> {
        let Some(finish_reason) = self.finish_reason.as_deref() else {
            return Err(ProviderTransportError::network(
                "Chat Completions stream ended without a finish_reason.",
            ));
        };
        // pi `mapStopReason` turns `content_filter`, `network_error` and unknown reasons into an
        // error stop, which TS `runTurn` raises as `Provider finish_reason: <reason>`. A protocol
        // error keeps TS retry classification: it is retried only when the message matches the
        // shared transient-failure pattern (TS `isTransientProviderError`), which none of the
        // documented reasons do (`network_error` has an underscore, the pattern needs a space).
        let mapped_stop_reason = map_chat_completions_finish_reason(finish_reason)
            .map_err(ProviderTransportError::protocol)?;
        // `finish_reason: "length"` means the output was cut off at the token limit, so any tool
        // call arguments that do not parse are truncated and must not be repaired into an
        // executable call. For a normal finish (`tool_calls` / `stop`) keep the TS-parity lenient
        // repair, since some OpenAI-compatible models emit slightly malformed but complete JSON.
        let truncated_by_length = self.finish_reason.as_deref() == Some("length");
        let mut parsed_tool_args: Vec<Map<String, Value>> = Vec::new();
        for tc in &self.tool_calls {
            let parsed = if tc.raw_args.trim().is_empty() {
                Map::new()
            } else {
                match serde_json::from_str::<Map<String, Value>>(&tc.raw_args) {
                    Ok(parsed) => parsed,
                    Err(_) if truncated_by_length => {
                        return Err(ProviderTransportError::network(
                            "Chat Completions stream ended with incomplete tool call arguments.",
                        ));
                    }
                    Err(_) => parse_partial_json_object(&tc.raw_args),
                }
            };
            parsed_tool_args.push(parsed);
        }

        if self.split_inline_think {
            let tail = flush_think_tag_split_state(&mut self.think_state);
            if !tail.thinking_text.is_empty() {
                self.emit_thinking_delta(&tail.thinking_text, emit);
            }
            if !tail.visible_text.is_empty() {
                self.emit_text_delta(&tail.visible_text, emit);
            }
        }

        self.close_thinking_if_open(emit);
        self.close_text_if_open(emit);

        let mut content = Vec::new();
        if !self.thinking_text.is_empty() {
            let mut provider_meta = ProviderOpaqueMeta::default();
            if let Some(field) = self.thinking_field {
                provider_meta.extra.insert(
                    CHAT_COMPLETIONS_REASONING_FIELD_META_KEY.to_string(),
                    Value::String(field.to_string()),
                );
            }
            content.push(ContentBlock::Thinking {
                text: self.thinking_text.clone(),
                summary: None,
                redacted: false,
                signature: None,
                provider_meta,
            });
        }
        if !self.visible_text.is_empty() {
            content.push(ContentBlock::Text {
                text: self.visible_text.clone(),
                phase: None,
                citations: Vec::new(),
                provider_meta: ProviderOpaqueMeta::default(),
            });
        }

        let has_tools = !self.tool_calls.is_empty();
        for (idx, (mut tc, parsed_args)) in self
            .tool_calls
            .into_iter()
            .zip(parsed_tool_args)
            .enumerate()
        {
            if tc.id.is_empty() {
                tc.id = format!("call_{}_{idx}", self.turn_id);
            }
            if tc.name.is_empty() {
                tc.name = "unknown_tool".to_string();
            }
            if !tc.started {
                emit(StreamEvent::ToolCallStart {
                    turn_id: self.turn_id.clone(),
                    key: tc.id.clone(),
                    name: tc.name.clone(),
                    initial_args: None,
                });
            }
            let cleaned_args = match self.tool_schemas.get(&tc.name) {
                Some(schema) => normalize_null_tool_arguments(&parsed_args, schema),
                None => parsed_args,
            };

            emit(StreamEvent::ToolCallEnd {
                turn_id: self.turn_id.clone(),
                key: tc.id.clone(),
                name: tc.name.clone(),
                arguments: Some(cleaned_args.clone()),
                retry_of: None,
                input_digest: None,
            });

            content.push(ContentBlock::ToolCall {
                id: tc.id,
                name: tc.name,
                arguments: cleaned_args,
                partial_json: if tc.raw_args.is_empty() {
                    None
                } else {
                    Some(tc.raw_args)
                },
                provider_meta: ProviderOpaqueMeta::default(),
            });
        }

        let stop_reason = if has_tools {
            StopReason::ToolUse
        } else {
            mapped_stop_reason
        };

        let provider_meta = ProviderOpaqueMeta {
            openai_response_id: self.response_id,
            ..Default::default()
        };

        let assistant = CanonicalMessage {
            id: format!("msg-{}", Uuid::new_v4()),
            role: MessageRole::Assistant,
            content,
            phase: None,
            provider: Some(self.provider.as_str().to_string()),
            api: Some("openai-completions".to_string()),
            model: Some(self.model_id),
            stop_reason: Some(stop_reason),
            provider_meta,
            created_at: Utc::now().to_rfc3339(),
        };
        let persisted_assistant = filter_persisted_assistant_history(&assistant);

        Ok(ProviderStepResult {
            assistant,
            persisted_assistant,
            usage: self.usage,
            continuation: None,
            raw_events: self.raw_events,
        })
    }
}
