//! Migration of persisted conversation messages into the canonical AST.
//!
//! Threads written by the legacy TypeScript server (and imported verbatim by
//! `cowork-storage`'s legacy importer) store AI-SDK `ModelMessage`s (`tool-call`, `tool-result`,
//! `reasoning`, `image`/`file` parts) or pi-ai messages (`toolResult` role, `thinking` parts) that
//! lack the canonical `id` / `createdAt` fields. [`migrate_stored_message`] translates those
//! shapes losslessly enough to replay them to any provider, synthesizing stable ids.
//!
//! Google Interactions threads additionally persisted provider-executed built-in tools (native
//! web search, URL context, ...) as `providerToolCall` / `providerToolResult` assistant parts;
//! those become canonical [`ContentBlock::ProviderNativeTool`] blocks, the same shape the Rust
//! Google transport emits and replays.

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::ast::{
    CanonicalMessage, ContentBlock, MediaKind, MediaSource, MessageRole, ProviderNativeToolRole,
    ProviderOpaqueMeta, TextPhase, ToolResultPart, extract_nested_citations,
};

const LEGACY_EPOCH_CREATED_AT: &str = "1970-01-01T00:00:00.000Z";

/// Message-level `providerMeta.extra` key holding raw user/assistant parts that have no canonical
/// representation. They are kept so re-persisting the migrated message stays lossless, but no
/// transport replays them (legacy TS replay skipped such parts the same way).
pub const LEGACY_UNMIGRATED_PARTS_KEY: &str = "legacyUnmigratedParts";

/// Converts one stored message into a [`CanonicalMessage`].
///
/// Canonical messages pass through unchanged. Legacy messages get a deterministic id derived from
/// their position and content, and `createdAt` from their own timestamp when present (else
/// `fallback_created_at`). Returns `None` when the message cannot be represented faithfully
/// (unknown role, unknown tool part type, or no representable content); callers must then keep
/// the raw value instead of dropping it. Unrecognized *user/system/assistant* parts are skipped
/// instead, so one odd part does not hide the prompt or answer text from later turns; the skipped
/// raw parts are preserved under [`LEGACY_UNMIGRATED_PARTS_KEY`] in the message's
/// `provider_meta.extra`.
pub fn migrate_stored_message(
    raw: &Value,
    index: usize,
    fallback_created_at: Option<&str>,
) -> Option<CanonicalMessage> {
    if let Ok(cm) = serde_json::from_value::<CanonicalMessage>(raw.clone()) {
        return Some(cm);
    }
    let obj = raw.as_object()?;
    let role_raw = obj.get("role").and_then(Value::as_str)?;

    let mut skipped_parts = Vec::new();
    let (role, content) = match role_raw {
        "user" => (
            MessageRole::User,
            user_content(obj.get("content")?, &mut skipped_parts)?,
        ),
        "system" => (
            MessageRole::System,
            user_content(obj.get("content")?, &mut skipped_parts)?,
        ),
        "developer" => (
            MessageRole::Developer,
            user_content(obj.get("content")?, &mut skipped_parts)?,
        ),
        "assistant" => (
            MessageRole::Assistant,
            assistant_content(obj.get("content")?, &mut skipped_parts)?,
        ),
        "tool" => (MessageRole::Tool, tool_message_content(obj)?),
        "toolResult" => (MessageRole::Tool, vec![pi_tool_result_block(obj)?]),
        _ => return None,
    };
    if content.is_empty() {
        return None;
    }

    let created_at = message_created_at(obj)
        .or_else(|| fallback_created_at.map(str::to_owned))
        .unwrap_or_else(|| LEGACY_EPOCH_CREATED_AT.to_owned());
    let id = obj
        .get("id")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| synthesize_id(raw, index));

    let mut provider_meta = ProviderOpaqueMeta::default();
    if !skipped_parts.is_empty() {
        provider_meta.extra.insert(
            LEGACY_UNMIGRATED_PARTS_KEY.to_owned(),
            Value::Array(skipped_parts),
        );
    }

    Some(CanonicalMessage {
        id,
        role,
        content,
        phase: None,
        provider: non_empty_str(obj.get("provider")),
        api: non_empty_str(obj.get("api")),
        model: non_empty_str(obj.get("model")),
        stop_reason: None,
        provider_meta,
        created_at,
    })
}

fn synthesize_id(raw: &Value, index: usize) -> String {
    let digest = Sha256::digest(raw.to_string().as_bytes());
    format!("legacy-{index}-{}", &hex::encode(digest)[..16])
}

fn message_created_at(obj: &Map<String, Value>) -> Option<String> {
    if let Some(s) = ["createdAt", "created_at", "timestamp", "ts"]
        .iter()
        .find_map(|k| obj.get(*k).and_then(Value::as_str))
        .filter(|s| chrono::DateTime::parse_from_rfc3339(s).is_ok())
    {
        return Some(s.to_owned());
    }
    let millis = obj.get("timestamp").and_then(Value::as_i64)?;
    chrono::DateTime::from_timestamp_millis(millis)
        .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

fn non_empty_str(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn text_block(text: &str, phase: Option<TextPhase>) -> ContentBlock {
    ContentBlock::Text {
        text: text.to_owned(),
        phase,
        citations: Vec::new(),
        provider_meta: ProviderOpaqueMeta::default(),
    }
}

fn media_kind_for_mime(mime: Option<&str>, hint: &str) -> MediaKind {
    match mime.map(|m| m.split('/').next().unwrap_or_default()) {
        Some("image") => MediaKind::Image,
        Some("audio") => MediaKind::Audio,
        Some("video") => MediaKind::Video,
        _ => match hint {
            "image" | "input_image" | "image_url" => MediaKind::Image,
            "audio" => MediaKind::Audio,
            "video" => MediaKind::Video,
            _ => MediaKind::Document,
        },
    }
}

/// Builds a [`MediaSource`] from inline base64, a `data:` URL, or a remote URL.
fn media_source(data: &str, mime: Option<&str>) -> Option<MediaSource> {
    let data = data.trim();
    if data.is_empty() {
        return None;
    }
    if let Some(rest) = data.strip_prefix("data:") {
        let (meta, payload) = rest.split_once(',')?;
        let mime_type = meta
            .split(';')
            .next()
            .filter(|m| !m.is_empty())
            .or(mime)?
            .to_owned();
        return Some(MediaSource::Base64 {
            mime_type,
            data: payload.to_owned(),
        });
    }
    if data.starts_with("http://") || data.starts_with("https://") {
        return Some(MediaSource::Url {
            url: data.to_owned(),
            mime_type: mime.map(str::to_owned),
        });
    }
    Some(MediaSource::Base64 {
        mime_type: mime?.to_owned(),
        data: data.to_owned(),
    })
}

fn media_block_from_part(part: &Map<String, Value>, part_type: &str) -> Option<ContentBlock> {
    let mime = ["mimeType", "mediaType", "mime_type"]
        .iter()
        .find_map(|k| part.get(*k).and_then(Value::as_str));
    let data = [
        "data",
        "image",
        "url",
        "uri",
        "imageUrl",
        "image_url",
        "file",
    ]
    .iter()
    .find_map(|k| match part.get(*k) {
        Some(Value::String(s)) => Some(s.as_str()),
        Some(Value::Object(o)) => o.get("url").and_then(Value::as_str),
        _ => None,
    })?;
    let source = media_source(data, mime)?;
    Some(ContentBlock::Media {
        kind: media_kind_for_mime(source.mime_type(), part_type),
        source,
        provider_meta: ProviderOpaqueMeta::default(),
    })
}

/// User/system content: string, or parts of text / media. Media parts cover AI-SDK `image` /
/// `file`, OpenAI `input_image` / `image_url`, and the TS server's Google multimodal attachment
/// parts (`{ type: "audio" | "video" | "document", data, mimeType }`, see TS
/// `googleMultimodalPartTypeForMime`). Parts with no canonical representation are moved to
/// `skipped` (raw) instead of failing the whole message: TS replay skipped unknown user parts and
/// still sent the text.
fn user_content(content: &Value, skipped: &mut Vec<Value>) -> Option<Vec<ContentBlock>> {
    let parts = match content {
        Value::String(text) => {
            return Some(if text.is_empty() {
                Vec::new()
            } else {
                vec![text_block(text, None)]
            });
        }
        Value::Array(parts) => parts,
        _ => return None,
    };
    let mut out = Vec::with_capacity(parts.len());
    for part in parts {
        match user_part(part) {
            Some(block) => out.push(block),
            None => skipped.push(part.clone()),
        }
    }
    Some(out)
}

fn user_part(part: &Value) -> Option<ContentBlock> {
    let obj = match part {
        Value::String(text) => return Some(text_block(text, None)),
        Value::Object(obj) => obj,
        _ => return None,
    };
    let ty = obj.get("type").and_then(Value::as_str).unwrap_or("text");
    match ty {
        "text" | "input_text" | "inputText" => {
            let text = obj
                .get("text")
                .or_else(|| obj.get("inputText"))
                .and_then(Value::as_str)?;
            Some(text_block(text, None))
        }
        "image" | "input_image" | "image_url" | "audio" | "video" | "document" | "file"
        | "media" => media_block_from_part(obj, ty)
            .or_else(|| serde_json::from_value::<ContentBlock>(part.clone()).ok()),
        _ => serde_json::from_value::<ContentBlock>(part.clone()).ok(),
    }
}

fn parse_arguments(v: Option<&Value>) -> Map<String, Value> {
    match v {
        Some(Value::Object(map)) => map.clone(),
        Some(Value::String(s)) => match serde_json::from_str::<Value>(s) {
            Ok(Value::Object(map)) => map,
            _ => Map::new(),
        },
        _ => Map::new(),
    }
}

/// Assistant content: string, or parts. Parts with no canonical representation are moved to
/// `skipped` (raw) instead of failing the whole message.
fn assistant_content(content: &Value, skipped: &mut Vec<Value>) -> Option<Vec<ContentBlock>> {
    let parts = match content {
        Value::String(text) => {
            return Some(if text.is_empty() {
                Vec::new()
            } else {
                vec![text_block(text, None)]
            });
        }
        Value::Array(parts) => parts,
        _ => return None,
    };
    let mut out = Vec::with_capacity(parts.len());
    for part in parts {
        match assistant_part(part) {
            Some(block) => out.push(block),
            None => skipped.push(part.clone()),
        }
    }
    Some(out)
}

fn assistant_part(part: &Value) -> Option<ContentBlock> {
    let obj = match part {
        Value::String(text) => return Some(text_block(text, None)),
        Value::Object(obj) => obj,
        _ => return None,
    };
    let ty = obj.get("type").and_then(Value::as_str).unwrap_or("text");
    match ty {
        "text" => {
            let text = obj.get("text").and_then(Value::as_str)?;
            let phase = obj
                .get("phase")
                .and_then(Value::as_str)
                .and_then(TextPhase::from_wire);
            Some(text_block(text, phase))
        }
        "reasoning" | "thinking" => {
            let text = obj
                .get("text")
                .or_else(|| obj.get("thinking"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            let signature = obj
                .get("signature")
                .or_else(|| obj.get("thinkingSignature"))
                .and_then(Value::as_str)
                .map(str::to_owned);
            // The TS Google runtime persisted thought parts unstamped, with the Gemini signature
            // under `providerOptions.google.thoughtSignature` next to the generic
            // `thinkingSignature`. Keep the Google-specific one where the Google transport reads
            // it for unstamped history; the generic signature alone is never trusted as Gemini's.
            let provider_meta = ProviderOpaqueMeta {
                google_thought_signature: legacy_google_thought_signature(obj, false),
                ..ProviderOpaqueMeta::default()
            };
            Some(ContentBlock::Thinking {
                text: text.to_owned(),
                summary: None,
                redacted: obj.get("redacted").and_then(Value::as_bool) == Some(true),
                signature,
                provider_meta,
            })
        }
        "tool-call" | "toolCall" | "tool_call" => {
            let id = ["toolCallId", "id", "callId"]
                .iter()
                .find_map(|k| obj.get(*k).and_then(Value::as_str))
                .filter(|s| !s.trim().is_empty())?;
            let name = obj
                .get("toolName")
                .or_else(|| obj.get("name"))
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .unwrap_or("tool");
            let provider_meta = ProviderOpaqueMeta {
                google_thought_signature: legacy_google_thought_signature(obj, false),
                ..ProviderOpaqueMeta::default()
            };
            Some(ContentBlock::ToolCall {
                id: id.to_owned(),
                name: name.to_owned(),
                arguments: parse_arguments(obj.get("input").or_else(|| obj.get("arguments"))),
                partial_json: None,
                provider_meta,
            })
        }
        "providerToolCall" => legacy_native_tool_block(obj, ProviderNativeToolRole::Call, None),
        "providerToolResult" => legacy_native_tool_block(obj, ProviderNativeToolRole::Result, None),
        other => match native_google_tool_name(other) {
            // Raw Interactions content (`google_search_call`, `url_context_result`, ...).
            Some(name) => {
                let role = if other.ends_with("_call") {
                    ProviderNativeToolRole::Call
                } else {
                    ProviderNativeToolRole::Result
                };
                legacy_native_tool_block(obj, role, Some(name))
            }
            None => serde_json::from_value::<ContentBlock>(part.clone()).ok(),
        },
    }
}

/// Canonical native Google tool name for a legacy `NativeGoogleToolName` or an Interactions
/// content type (TS `nativeToolNameFromWireName`). Anything else, including the disabled
/// `codeExecution` tool, has no canonical native-tool form; TS replay skipped those parts.
fn native_google_tool_name(raw: &str) -> Option<&'static str> {
    match raw.trim() {
        "nativeWebSearch" | "google_search_call" | "google_search_result" => {
            Some("nativeWebSearch")
        }
        "nativeUrlContext" | "url_context_call" | "url_context_result" => Some("nativeUrlContext"),
        "nativeFileSearch" | "file_search_call" | "file_search_result" => Some("nativeFileSearch"),
        "nativeGoogleMaps" | "google_maps_call" | "google_maps_result" => Some("nativeGoogleMaps"),
        "nativeMcpServerTool" | "mcp_server_tool_call" | "mcp_server_tool_result" => {
            Some("nativeMcpServerTool")
        }
        _ => None,
    }
}

/// Gemini thought signature on a legacy part (TS `getGoogleThoughtSignature`): the direct
/// `thoughtSignature` field, optionally the generic `thinkingSignature` / `signature` fields, then
/// `providerOptions.{google,vertex}.thoughtSignature` (camel or snake case), then the same keys
/// under the AI-SDK response-side `providerMetadata`.
fn legacy_google_thought_signature(
    obj: &Map<String, Value>,
    include_generic: bool,
) -> Option<String> {
    let direct_keys: &[&str] = if include_generic {
        &["thoughtSignature", "thinkingSignature", "signature"]
    } else {
        &["thoughtSignature"]
    };
    let direct = direct_keys.iter().find_map(|k| non_empty_str(obj.get(*k)));
    if direct.is_some() {
        return direct;
    }
    ["providerOptions", "providerMetadata"]
        .iter()
        .filter_map(|container| obj.get(*container).and_then(Value::as_object))
        .find_map(|by_provider| {
            ["google", "vertex"].iter().find_map(|provider| {
                let opts = by_provider.get(*provider).and_then(Value::as_object)?;
                [
                    "thoughtSignature",
                    "thought_signature",
                    "thinkingSignature",
                    "thinking_signature",
                ]
                .iter()
                .find_map(|k| non_empty_str(opts.get(*k)))
            })
        })
}

/// Converts a legacy TS `providerToolCall` (`{id, name, arguments}`) / `providerToolResult`
/// (`{callId, name, result, isError}`) part, or a raw Interactions native-tool content part, into
/// a canonical `ProviderNativeTool` block. `name_override` is set for raw content parts, whose
/// tool is implied by their `type`.
fn legacy_native_tool_block(
    obj: &Map<String, Value>,
    role: ProviderNativeToolRole,
    name_override: Option<&'static str>,
) -> Option<ContentBlock> {
    let name = match name_override {
        Some(name) => name,
        None => ["name", "toolName"]
            .iter()
            .find_map(|k| obj.get(*k).and_then(Value::as_str))
            .and_then(native_google_tool_name)?,
    };
    let id_keys: &[&str] = match role {
        ProviderNativeToolRole::Call => &["id", "toolCallId"],
        ProviderNativeToolRole::Result => &["callId", "call_id", "toolCallId", "id"],
    };
    let id = id_keys.iter().find_map(|k| non_empty_str(obj.get(*k)))?;
    let (arguments, result) = match role {
        ProviderNativeToolRole::Call => (
            parse_arguments(obj.get("arguments").or_else(|| obj.get("input"))),
            None,
        ),
        ProviderNativeToolRole::Result => (
            Map::new(),
            obj.get("result").filter(|v| !v.is_null()).cloned(),
        ),
    };
    let citations = result
        .as_ref()
        .map(extract_nested_citations)
        .unwrap_or_default();
    let is_error = role == ProviderNativeToolRole::Result
        && ["isError", "is_error"]
            .iter()
            .any(|k| obj.get(*k).and_then(Value::as_bool) == Some(true));
    Some(ContentBlock::ProviderNativeTool {
        id,
        name: name.to_owned(),
        role,
        arguments,
        result,
        is_error,
        citations,
        provider_meta: ProviderOpaqueMeta {
            google_thought_signature: legacy_google_thought_signature(obj, true),
            ..ProviderOpaqueMeta::default()
        },
    })
}

fn tool_result_part(part: &Value) -> Option<ToolResultPart> {
    let obj = part.as_object()?;
    match obj.get("type").and_then(Value::as_str)? {
        "text" => Some(ToolResultPart::Text {
            text: obj.get("text").and_then(Value::as_str)?.to_owned(),
        }),
        ty @ ("image" | "audio" | "video" | "document" | "file" | "media") => {
            let ContentBlock::Media { kind, source, .. } = media_block_from_part(obj, ty)? else {
                return None;
            };
            Some(ToolResultPart::Media { kind, source })
        }
        _ => None,
    }
}

/// Converts a legacy tool output (`{type:"text"|"json"|"error-text"|"content", value}`, raw
/// string, or parts array) into result parts plus an error flag.
fn tool_output_parts(output: Option<&Value>) -> (Vec<ToolResultPart>, bool) {
    let text = |t: String| vec![ToolResultPart::Text { text: t }];
    let Some(output) = output else {
        return (text(String::new()), false);
    };
    if let Value::Array(items) = output
        && let Some(parts) = items
            .iter()
            .map(tool_result_part)
            .collect::<Option<Vec<_>>>()
        && !parts.is_empty()
    {
        return (parts, false);
    }
    match output {
        Value::String(s) => (text(s.clone()), false),
        Value::Null => (text(String::new()), false),
        Value::Object(obj) => {
            let ty = obj.get("type").and_then(Value::as_str).unwrap_or_default();
            let is_error = ty.starts_with("error");
            if ty == "content"
                && let Some(Value::Array(items)) = obj.get("content").or_else(|| obj.get("value"))
                && let Some(parts) = items
                    .iter()
                    .map(tool_result_part)
                    .collect::<Option<Vec<_>>>()
                && !parts.is_empty()
            {
                return (parts, is_error);
            }
            match obj.get("value") {
                Some(Value::String(s)) => (text(s.clone()), is_error),
                Some(v) => (text(v.to_string()), is_error),
                None => (text(output.to_string()), is_error),
            }
        }
        other => (text(other.to_string()), false),
    }
}

fn structured_meta_for(output: Option<&Value>) -> Option<Value> {
    match output? {
        Value::Object(obj) if obj.get("type").and_then(Value::as_str) == Some("json") => {
            obj.get("value").cloned()
        }
        Value::Object(obj) if obj.get("type").and_then(Value::as_str).is_some() => None,
        v @ Value::Object(_) => Some(v.clone()),
        _ => None,
    }
}

fn tool_result_block(
    part: &Map<String, Value>,
    fallback_id: Option<&str>,
    fallback_name: Option<&str>,
) -> Option<ContentBlock> {
    let tool_call_id = ["toolCallId", "tool_call_id", "id"]
        .iter()
        .find_map(|k| part.get(*k).and_then(Value::as_str))
        .or(fallback_id)
        .filter(|s| !s.trim().is_empty())?;
    let tool_name = ["toolName", "tool_name", "name"]
        .iter()
        .find_map(|k| part.get(*k).and_then(Value::as_str))
        .or(fallback_name)
        .map(str::to_owned);
    let output = part.get("output").or_else(|| part.get("content"));
    let (content, output_error) = tool_output_parts(output);
    Some(ContentBlock::ToolResult {
        tool_call_id: tool_call_id.to_owned(),
        tool_name,
        content,
        structured_meta: structured_meta_for(output),
        is_error: part.get("isError").and_then(Value::as_bool) == Some(true) || output_error,
        provider_meta: ProviderOpaqueMeta::default(),
    })
}

/// AI-SDK `role: "tool"` message (parts of `tool-result`) or OpenAI-style
/// `{ role: "tool", tool_call_id, content: "..." }`.
fn tool_message_content(obj: &Map<String, Value>) -> Option<Vec<ContentBlock>> {
    let msg_id = ["toolCallId", "tool_call_id"]
        .iter()
        .find_map(|k| obj.get(*k).and_then(Value::as_str));
    let msg_name = ["toolName", "tool_name", "name"]
        .iter()
        .find_map(|k| obj.get(*k).and_then(Value::as_str));
    match obj.get("content")? {
        Value::Array(parts) => {
            let mut out = Vec::with_capacity(parts.len());
            for part in parts {
                let p = part.as_object()?;
                match p.get("type").and_then(Value::as_str) {
                    Some("tool-result" | "toolResult" | "tool_result") => {
                        out.push(tool_result_block(p, msg_id, msg_name)?);
                    }
                    _ => out.push(serde_json::from_value::<ContentBlock>(part.clone()).ok()?),
                }
            }
            Some(out)
        }
        Value::String(_) => Some(vec![tool_result_block(obj, msg_id, msg_name)?]),
        _ => None,
    }
}

/// pi-ai `{ role: "toolResult", toolCallId, toolName, content: [...], isError }`.
fn pi_tool_result_block(obj: &Map<String, Value>) -> Option<ContentBlock> {
    tool_result_block(obj, None, None)
}
