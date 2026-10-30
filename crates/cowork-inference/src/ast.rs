use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Canonical message author role across all provider wire adapters.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MessageRole {
    System,
    Developer,
    User,
    Assistant,
    Tool,
}

/// Assistant text phase (`commentary` vs `final_answer`, used by OpenAI GPT-5/Astra Responses).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TextPhase {
    Commentary,
    FinalAnswer,
}

impl TextPhase {
    pub fn from_wire(raw: &str) -> Option<Self> {
        match raw.trim() {
            "commentary" => Some(Self::Commentary),
            "final_answer" => Some(Self::FinalAnswer),
            _ => None,
        }
    }

    pub fn as_wire_str(self) -> &'static str {
        match self {
            Self::Commentary => "commentary",
            Self::FinalAnswer => "final_answer",
        }
    }
}

/// Normalized stop reason across provider transports.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StopReason {
    Stop,
    Length,
    ToolUse,
    Error,
    Aborted,
}

/// Multimodal attachment category.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaKind {
    Image,
    Audio,
    Video,
    Document,
}

impl MediaKind {
    pub fn as_wire_str(self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::Audio => "audio",
            Self::Video => "video",
            Self::Document => "document",
        }
    }
}

/// Multimodal payload representation (`Base64`, local `FileRef`, or remote `Url`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum MediaSource {
    Base64 {
        mime_type: String,
        data: String,
    },
    FileRef {
        path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        mime_type: Option<String>,
    },
    Url {
        url: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        mime_type: Option<String>,
    },
}

impl MediaSource {
    pub fn mime_type(&self) -> Option<&str> {
        match self {
            Self::Base64 { mime_type, .. } => Some(mime_type.as_str()),
            Self::FileRef { mime_type, .. } | Self::Url { mime_type, .. } => mime_type.as_deref(),
        }
    }
}

/// Grounding citation attached to assistant `Text` or `ProviderNativeTool` blocks (including
/// generic `exec`-wrapped nested citations).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Citation {
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cited_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_index: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_index: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_type: Option<String>,
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub provider_meta: Map<String, Value>,
}

/// Distinguishes provider-hosted built-in tool invocations from results.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderNativeToolRole {
    Call,
    Result,
}

/// Provider-specific opaque metadata preserved losslessly across multi-turn replays.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderOpaqueMeta {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anthropic_thinking_signature: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anthropic_redacted_thinking: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anthropic_effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub openai_response_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub openai_item_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub openai_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub openai_encrypted_reasoning: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub openai_reasoning_item: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub google_interaction_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub google_thought_signature: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub google_signature_provider: Option<String>,
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub extra: Map<String, Value>,
}

impl ProviderOpaqueMeta {
    pub fn is_empty(&self) -> bool {
        self == &Self::default()
    }
}

/// Individual part inside a `ToolResult` block.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ToolResultPart {
    Text {
        text: String,
    },
    Media {
        kind: MediaKind,
        source: MediaSource,
    },
}

/// Canonical content block inside a `CanonicalMessage`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ContentBlock {
    Text {
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        phase: Option<TextPhase>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        citations: Vec<Citation>,
        #[serde(default, skip_serializing_if = "ProviderOpaqueMeta::is_empty")]
        provider_meta: ProviderOpaqueMeta,
    },
    Thinking {
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        summary: Option<String>,
        #[serde(default)]
        redacted: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        signature: Option<String>,
        #[serde(default, skip_serializing_if = "ProviderOpaqueMeta::is_empty")]
        provider_meta: ProviderOpaqueMeta,
    },
    ToolCall {
        id: String,
        name: String,
        #[serde(default)]
        arguments: Map<String, Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        partial_json: Option<String>,
        #[serde(default, skip_serializing_if = "ProviderOpaqueMeta::is_empty")]
        provider_meta: ProviderOpaqueMeta,
    },
    ProviderNativeTool {
        id: String,
        name: String,
        role: ProviderNativeToolRole,
        #[serde(default, skip_serializing_if = "Map::is_empty")]
        arguments: Map<String, Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        result: Option<Value>,
        #[serde(default)]
        is_error: bool,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        citations: Vec<Citation>,
        #[serde(default, skip_serializing_if = "ProviderOpaqueMeta::is_empty")]
        provider_meta: ProviderOpaqueMeta,
    },
    ToolResult {
        tool_call_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        tool_name: Option<String>,
        #[serde(default)]
        content: Vec<ToolResultPart>,
        #[serde(skip_serializing_if = "Option::is_none")]
        structured_meta: Option<Value>,
        #[serde(default)]
        is_error: bool,
        #[serde(default, skip_serializing_if = "ProviderOpaqueMeta::is_empty")]
        provider_meta: ProviderOpaqueMeta,
    },
    Media {
        kind: MediaKind,
        source: MediaSource,
        #[serde(default, skip_serializing_if = "ProviderOpaqueMeta::is_empty")]
        provider_meta: ProviderOpaqueMeta,
    },
}

/// Canonical multi-provider conversation message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalMessage {
    pub id: String,
    pub role: MessageRole,
    pub content: Vec<ContentBlock>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<TextPhase>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<StopReason>,
    #[serde(default, skip_serializing_if = "ProviderOpaqueMeta::is_empty")]
    pub provider_meta: ProviderOpaqueMeta,
    pub created_at: String,
}

/// Composes an OpenAI Responses `${call_id}|${item.id}` tool-call identifier.
pub fn compose_openai_tool_call_id(call_id: &str, item_id: &str) -> String {
    let call_trimmed = call_id.trim();
    let item_trimmed = item_id.trim();
    if item_trimmed.is_empty() {
        call_trimmed.to_string()
    } else {
        format!("{call_trimmed}|{item_trimmed}")
    }
}

/// Splits an OpenAI Responses `${call_id}|${item.id}` identifier into `(call_id, Option<item_id>)`.
pub fn split_openai_tool_call_id(composite_id: &str) -> (&str, Option<&str>) {
    match composite_id.split_once('|') {
        Some((call_id, item_id)) if !item_id.is_empty() => (call_id, Some(item_id)),
        Some((call_id, _)) => (call_id, None),
        None => (composite_id, None),
    }
}

/// Sanitizes cross-provider composite OpenAI tool IDs (`<= 64` chars, `[a-zA-Z0-9_-]`, `fc_` prefix).
pub fn sanitize_openai_composite_tool_id(id: &str) -> String {
    let Some((raw_call, raw_item)) = id.split_once('|') else {
        return id.to_string();
    };
    let sanitize_part = |s: &str| -> String {
        s.chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                    c
                } else {
                    '_'
                }
            })
            .collect()
    };
    let mut call_part = sanitize_part(raw_call);
    let mut item_part = sanitize_part(raw_item);
    if !item_part.starts_with("fc") {
        item_part = format!("fc_{item_part}");
    }
    if call_part.len() > 64 {
        call_part.truncate(64);
    }
    if item_part.len() > 64 {
        item_part.truncate(64);
    }
    let call_part = call_part.trim_end_matches('_');
    let item_part = item_part.trim_end_matches('_');
    format!("{call_part}|{item_part}")
}

/// Extracts nested citations recursively from arbitrary JSON payloads (including `exec`-wrapped
/// native tool outputs and `sources` / `citations` / `annotations` arrays).
pub fn extract_nested_citations(value: &Value) -> Vec<Citation> {
    let mut out = Vec::new();
    let mut seen_urls = std::collections::HashSet::new();
    collect_citations_recursive(value, None, &mut seen_urls, &mut out);
    out
}

fn collect_citations_recursive(
    value: &Value,
    parent_type: Option<&str>,
    seen: &mut std::collections::HashSet<String>,
    out: &mut Vec<Citation>,
) {
    match value {
        Value::Array(items) => {
            for item in items {
                collect_citations_recursive(item, parent_type, seen, out);
            }
        }
        Value::Object(obj) => {
            let obj_type = obj.get("type").and_then(Value::as_str).or(parent_type);
            let url = obj
                .get("url")
                .or_else(|| obj.get("uri"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|u| !u.is_empty());
            if let Some(url) = url {
                let title = obj
                    .get("title")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|t| !t.is_empty())
                    .map(ToOwned::to_owned);
                let cited_text = obj
                    .get("cited_text")
                    .or_else(|| obj.get("citedText"))
                    .or_else(|| obj.get("snippet"))
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned);
                let start_index = obj
                    .get("start_index")
                    .or_else(|| obj.get("startIndex"))
                    .and_then(Value::as_u64)
                    .map(|n| n as usize);
                let end_index = obj
                    .get("end_index")
                    .or_else(|| obj.get("endIndex"))
                    .and_then(Value::as_u64)
                    .map(|n| n as usize);
                let dedupe_key = format!(
                    "{url}|{start_index:?}|{end_index:?}|{}",
                    title.as_deref().unwrap_or_default()
                );
                if seen.insert(dedupe_key) {
                    out.push(Citation {
                        url: url.to_string(),
                        title,
                        cited_text,
                        start_index,
                        end_index,
                        source_type: obj_type.map(ToOwned::to_owned),
                        provider_meta: Map::new(),
                    });
                }
            }
            for (k, v) in obj {
                let next_parent = if k == "exec" {
                    Some("exec_nested_citation")
                } else {
                    obj_type
                };
                collect_citations_recursive(v, next_parent, seen, out);
            }
        }
        _ => {}
    }
}

/// Filters OpenAI `phase == Commentary` text blocks out of persisted assistant history while
/// retaining `FinalAnswer`, `Thinking` (with encrypted signatures), `ToolCall`, `ProviderNativeTool`,
/// and `Media` blocks (`piMessageBridge.ts` parity).
pub fn filter_persisted_assistant_history(msg: &CanonicalMessage) -> Option<CanonicalMessage> {
    if msg.role != MessageRole::Assistant {
        return Some(msg.clone());
    }
    let filtered_content: Vec<ContentBlock> = msg
        .content
        .iter()
        .filter(|block| {
            !matches!(
                block,
                ContentBlock::Text {
                    phase: Some(TextPhase::Commentary),
                    ..
                }
            )
        })
        .cloned()
        .collect();
    if filtered_content.is_empty() {
        return None;
    }
    let mut next = msg.clone();
    next.content = filtered_content;
    if next.phase == Some(TextPhase::Commentary) {
        next.phase = None;
    }
    Some(next)
}
