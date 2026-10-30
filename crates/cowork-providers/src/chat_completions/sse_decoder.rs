//! SSE chunk decoding for OpenAI-compatible Chat Completions streams.
//!
//! Intentionally omits `#[serde(deny_unknown_fields)]` on all wire structs so provider-specific
//! telemetry fields (such as LM Studio's `"stats"` and `"model_info"`) never cause parse failures.

use std::collections::{BTreeMap, HashMap};

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
    #[serde(default)]
    pub prompt_tokens_details: Option<PromptTokensDetails>,
    #[serde(default)]
    pub completion_tokens_details: Option<CompletionTokensDetails>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PromptTokensDetails {
    #[serde(default)]
    pub cached_tokens: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CompletionTokensDetails {
    #[serde(default)]
    pub reasoning_tokens: Option<u64>,
}

#[derive(Debug, Default)]
struct ToolCallAcc {
    id: String,
    name: String,
    raw_args: String,
    started: bool,
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
    text_started: bool,
    text_closed: bool,
    visible_text: String,
    tool_calls: BTreeMap<usize, ToolCallAcc>,
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
            text_started: false,
            text_closed: false,
            visible_text: String::new(),
            tool_calls: BTreeMap::new(),
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

        if let Some(u) = chunk.usage {
            let prompt = u.prompt_tokens.unwrap_or(self.usage.prompt_tokens);
            let completion = u.completion_tokens.unwrap_or(self.usage.completion_tokens);
            let total = u.total_tokens.unwrap_or(prompt + completion);
            self.usage.prompt_tokens = prompt;
            self.usage.completion_tokens = completion;
            self.usage.total_tokens = total;
            if let Some(cached) = u.prompt_tokens_details.and_then(|d| d.cached_tokens) {
                self.usage.cached_prompt_tokens = Some(cached);
            }
            if let Some(reasoning) = u.completion_tokens_details.and_then(|d| d.reasoning_tokens) {
                self.usage.reasoning_output_tokens = Some(reasoning);
            }
        }

        for choice in chunk.choices {
            if let Some(reason) = choice.finish_reason.filter(|r| !r.is_empty()) {
                self.finish_reason = Some(reason);
            }
            let Some(delta) = choice.delta else {
                continue;
            };

            if let Some(rc) = delta
                .reasoning_content
                .or(delta.reasoning)
                .filter(|s| !s.is_empty())
            {
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

                    let idx = tc.index.unwrap_or(0);
                    let entry = self.tool_calls.entry(idx).or_default();
                    if let Some(id) = tc.id.filter(|s| !s.is_empty()) {
                        entry.id = id;
                    }
                    if entry.id.is_empty() {
                        entry.id = format!("call_{}_{idx}", self.turn_id);
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

    pub fn finalize(mut self, emit: &mut dyn FnMut(StreamEvent)) -> ProviderStepResult {
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
            content.push(ContentBlock::Thinking {
                text: self.thinking_text.clone(),
                summary: None,
                redacted: false,
                signature: None,
                provider_meta: ProviderOpaqueMeta::default(),
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
        for (idx, mut tc) in self.tool_calls {
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
            let parsed_args: Map<String, Value> = if tc.raw_args.trim().is_empty() {
                Map::new()
            } else {
                serde_json::from_str::<Map<String, Value>>(&tc.raw_args)
                    .unwrap_or_else(|_| parse_partial_json_object(&tc.raw_args))
            };
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

        let stop_reason = if has_tools || self.finish_reason.as_deref() == Some("tool_calls") {
            StopReason::ToolUse
        } else if matches!(self.finish_reason.as_deref(), Some("length" | "max_tokens")) {
            StopReason::Length
        } else {
            StopReason::Stop
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

        ProviderStepResult {
            assistant,
            persisted_assistant,
            usage: self.usage,
            continuation: None,
            raw_events: self.raw_events,
        }
    }
}
