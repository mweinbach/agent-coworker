//! Legacy TS Google Interactions history (`providerToolCall` / `providerToolResult` assistant
//! parts) migrates into canonical `ProviderNativeTool` blocks without losing the answer text, and
//! legacy Google user attachment parts (`audio` / `video` / `document`) migrate into `Media` blocks.

use cowork_inference::legacy_messages::LEGACY_UNMIGRATED_PARTS_KEY;
use cowork_inference::{
    CanonicalMessage, ContentBlock, MediaKind, MediaSource, MessageRole, ProviderNativeToolRole,
    ProviderOpaqueMeta, migrate_stored_message,
};
use serde_json::{Value, json};

/// Assistant message as the TS Google runtime persisted it after a native search + URL-context turn.
fn legacy_google_assistant() -> Value {
    json!({
        "role": "assistant",
        "provider": "google",
        "api": "google-interactions",
        "model": "gemini-3.1-pro-preview",
        "timestamp": 1_761_782_400_000_i64,
        "content": [
            { "type": "thinking", "thinking": "Searching docs.", "thinkingSignature": "sig_thought_1" },
            {
                "type": "providerToolCall",
                "id": "gsearch_1",
                "name": "nativeWebSearch",
                "arguments": { "queries": ["rustls 0.23"] },
                "thoughtSignature": "sig_search_call"
            },
            {
                "type": "providerToolResult",
                "callId": "gsearch_1",
                "name": "nativeWebSearch",
                "result": { "sources": [{ "url": "https://docs.rs/rustls", "title": "rustls - Rust" }] }
            },
            {
                "type": "providerToolCall",
                "id": "url_1",
                "name": "nativeUrlContext",
                "arguments": { "urls": ["https://docs.rs/rustls"] },
                "providerOptions": { "google": { "thoughtSignature": "sig_url_call" } }
            },
            {
                "type": "providerToolResult",
                "callId": "url_1",
                "name": "nativeUrlContext",
                "result": [{ "url": "https://docs.rs/rustls", "status": "success" }],
                "isError": true
            },
            { "type": "text", "text": "rustls is memory-safe." }
        ]
    })
}

fn native_blocks(msg: &CanonicalMessage) -> Vec<&ContentBlock> {
    msg.content
        .iter()
        .filter(|b| matches!(b, ContentBlock::ProviderNativeTool { .. }))
        .collect()
}

#[test]
fn legacy_provider_tool_parts_migrate_to_canonical_native_tool_blocks_and_keep_text() {
    let raw = legacy_google_assistant();
    let msg = migrate_stored_message(&raw, 1, None).expect("legacy Google assistant migrates");

    assert_eq!(msg.role, MessageRole::Assistant);
    assert_eq!(msg.provider.as_deref(), Some("google"));
    assert_eq!(msg.created_at, "2025-10-30T00:00:00.000Z");
    assert!(msg.id.starts_with("legacy-1-"));
    assert!(msg.provider_meta.is_empty(), "nothing was skipped");
    assert_eq!(msg.content.len(), 6);
    assert!(matches!(
        msg.content.last(),
        Some(ContentBlock::Text { text, .. }) if text == "rustls is memory-safe."
    ));

    let native = native_blocks(&msg);
    assert_eq!(native.len(), 4);

    let ContentBlock::ProviderNativeTool {
        id,
        name,
        role,
        arguments,
        result,
        is_error,
        citations,
        provider_meta,
    } = native[0]
    else {
        unreachable!()
    };
    assert_eq!(id, "gsearch_1");
    assert_eq!(name, "nativeWebSearch");
    assert_eq!(*role, ProviderNativeToolRole::Call);
    assert_eq!(arguments.get("queries"), Some(&json!(["rustls 0.23"])));
    assert!(result.is_none());
    assert!(!is_error);
    assert!(citations.is_empty());
    assert_eq!(
        provider_meta.google_thought_signature.as_deref(),
        Some("sig_search_call")
    );

    let ContentBlock::ProviderNativeTool {
        id,
        name,
        role,
        arguments,
        result,
        is_error,
        citations,
        provider_meta,
    } = native[1]
    else {
        unreachable!()
    };
    assert_eq!(id, "gsearch_1");
    assert_eq!(name, "nativeWebSearch");
    assert_eq!(*role, ProviderNativeToolRole::Result);
    assert!(arguments.is_empty());
    assert_eq!(
        result.as_ref().unwrap()["sources"][0]["url"],
        "https://docs.rs/rustls"
    );
    assert!(!is_error);
    assert_eq!(citations.len(), 1);
    assert_eq!(citations[0].url, "https://docs.rs/rustls");
    assert!(provider_meta.google_thought_signature.is_none());

    let ContentBlock::ProviderNativeTool {
        name,
        role,
        provider_meta,
        ..
    } = native[2]
    else {
        unreachable!()
    };
    assert_eq!(name, "nativeUrlContext");
    assert_eq!(*role, ProviderNativeToolRole::Call);
    assert_eq!(
        provider_meta.google_thought_signature.as_deref(),
        Some("sig_url_call"),
        "providerOptions.google.thoughtSignature is honored"
    );

    let ContentBlock::ProviderNativeTool {
        id, role, is_error, ..
    } = native[3]
    else {
        unreachable!()
    };
    assert_eq!(id, "url_1");
    assert_eq!(*role, ProviderNativeToolRole::Result);
    assert!(*is_error);

    // The migrated message round-trips through the canonical decoder, so re-persisting and
    // reopening the thread is stable.
    let reparsed: CanonicalMessage =
        serde_json::from_value(serde_json::to_value(&msg).unwrap()).unwrap();
    assert_eq!(reparsed, msg);
    assert_eq!(migrate_stored_message(&raw, 1, None).unwrap(), msg);
}

#[test]
fn legacy_provider_tool_parts_accept_alias_fields_and_raw_interactions_content_types() {
    let raw = json!({
        "role": "assistant",
        "content": [
            {
                "type": "providerToolCall",
                "toolCallId": "fs_1",
                "toolName": "file_search_call",
                "input": "{\"query\":\"quarterly\"}"
            },
            {
                "type": "providerToolResult",
                "toolCallId": "fs_1",
                "toolName": "nativeFileSearch",
                "result": { "hits": 2 },
                "is_error": true
            },
            {
                "type": "google_search_call",
                "id": "raw_search",
                "arguments": { "queries": ["gemini"] },
                "signature": "sig_raw"
            },
            {
                "type": "google_search_result",
                "call_id": "raw_search",
                "result": { "sources": [] }
            },
            { "type": "text", "text": "Done." }
        ]
    });
    let msg = migrate_stored_message(&raw, 0, Some("2026-01-01T00:00:00Z")).unwrap();
    assert_eq!(msg.created_at, "2026-01-01T00:00:00Z");
    let native = native_blocks(&msg);
    assert_eq!(native.len(), 4);

    let summary: Vec<(String, String, ProviderNativeToolRole, bool, Option<String>)> = native
        .iter()
        .map(|b| match b {
            ContentBlock::ProviderNativeTool {
                id,
                name,
                role,
                is_error,
                provider_meta,
                ..
            } => (
                id.clone(),
                name.clone(),
                *role,
                *is_error,
                provider_meta.google_thought_signature.clone(),
            ),
            _ => unreachable!(),
        })
        .collect();
    assert_eq!(
        summary,
        vec![
            (
                "fs_1".into(),
                "nativeFileSearch".into(),
                ProviderNativeToolRole::Call,
                false,
                None
            ),
            (
                "fs_1".into(),
                "nativeFileSearch".into(),
                ProviderNativeToolRole::Result,
                true,
                None
            ),
            (
                "raw_search".into(),
                "nativeWebSearch".into(),
                ProviderNativeToolRole::Call,
                false,
                Some("sig_raw".into())
            ),
            (
                "raw_search".into(),
                "nativeWebSearch".into(),
                ProviderNativeToolRole::Result,
                false,
                None
            ),
        ]
    );
    let ContentBlock::ProviderNativeTool { arguments, .. } = native[0] else {
        unreachable!()
    };
    assert_eq!(arguments.get("query"), Some(&json!("quarterly")));
}

#[test]
fn unknown_or_unmappable_assistant_parts_are_skipped_but_preserved_and_text_survives() {
    let code_exec_call = json!({
        "type": "providerToolCall",
        "id": "ce_1",
        "name": "codeExecution",
        "arguments": { "code": "print(1)" }
    });
    let nameless_result = json!({ "type": "providerToolResult", "callId": "x", "result": {} });
    let unknown = json!({ "type": "futurePartType", "payload": 1 });
    let raw = json!({
        "role": "assistant",
        "content": [
            code_exec_call,
            { "type": "text", "text": "Here is the earlier answer." },
            nameless_result,
            unknown,
            42
        ]
    });
    let msg = migrate_stored_message(&raw, 3, None).expect("text keeps the message alive");
    assert_eq!(msg.content.len(), 1);
    assert!(matches!(
        &msg.content[0],
        ContentBlock::Text { text, .. } if text == "Here is the earlier answer."
    ));
    // Disabled native code execution is never turned into a replayable native-tool block.
    assert!(native_blocks(&msg).is_empty());
    assert_eq!(
        msg.provider_meta.extra.get(LEGACY_UNMIGRATED_PARTS_KEY),
        Some(&json!([code_exec_call, nameless_result, unknown, 42])),
        "skipped raw parts are kept so re-persisting is lossless"
    );
    let reparsed: CanonicalMessage =
        serde_json::from_value(serde_json::to_value(&msg).unwrap()).unwrap();
    assert_eq!(reparsed, msg);
}

#[test]
fn assistant_message_with_only_unrepresentable_parts_still_returns_none() {
    let raw = json!({
        "role": "assistant",
        "content": [{ "type": "futurePartType" }, { "type": "providerToolCall", "id": "a" }]
    });
    assert!(migrate_stored_message(&raw, 0, None).is_none());
}

#[test]
fn unknown_user_parts_are_skipped_but_preserved_and_text_survives() {
    // TS replay (`convertRichContentParts`, `modelMessagesToPiMessages`) skipped unknown user parts
    // and still sent the prompt text, so migration must not drop the whole message.
    let raw = json!({
        "role": "user",
        "content": [{ "type": "text", "text": "hi" }, { "type": "futurePartType" }]
    });
    let msg = migrate_stored_message(&raw, 0, None).expect("text keeps the user message alive");
    assert_eq!(msg.role, MessageRole::User);
    assert_eq!(msg.content.len(), 1);
    assert!(matches!(&msg.content[0], ContentBlock::Text { text, .. } if text == "hi"));
    assert_eq!(
        msg.provider_meta.extra.get(LEGACY_UNMIGRATED_PARTS_KEY),
        Some(&json!([{ "type": "futurePartType" }])),
    );
    let reparsed: CanonicalMessage =
        serde_json::from_value(serde_json::to_value(&msg).unwrap()).unwrap();
    assert_eq!(reparsed, msg);
}

#[test]
fn user_message_with_only_unknown_parts_still_keeps_the_raw_message() {
    let raw = json!({ "role": "user", "content": [{ "type": "futurePartType" }] });
    assert!(migrate_stored_message(&raw, 0, None).is_none());
}

/// User message as the TS server built it for a Google model with an uploaded attachment
/// (`userMessageAttachments.ts`): a text prompt, a `[System: ...]` path note, then
/// `{ type: googleMultimodalPartTypeForMime(mime), data: <base64>, mimeType }`.
fn legacy_google_media_user(part_type: &str, mime: &str) -> Value {
    json!({
        "role": "user",
        "content": [
            { "type": "text", "text": "Summarize this attachment." },
            { "type": "text", "text": "[System: The user uploaded a file which has been saved to /tmp/up/f]" },
            { "type": part_type, "data": "QUJD", "mimeType": mime }
        ]
    })
}

#[test]
fn legacy_google_audio_video_pdf_user_parts_migrate_with_text() {
    for (part_type, mime, kind) in [
        ("audio", "audio/mpeg", MediaKind::Audio),
        ("video", "video/mp4", MediaKind::Video),
        ("document", "application/pdf", MediaKind::Document),
    ] {
        let raw = legacy_google_media_user(part_type, mime);
        let msg = migrate_stored_message(&raw, 0, None)
            .unwrap_or_else(|| panic!("legacy {part_type} user message migrates"));
        assert_eq!(msg.role, MessageRole::User);
        assert_eq!(msg.content.len(), 3, "{part_type}: every part survives");
        assert!(
            matches!(&msg.content[0], ContentBlock::Text { text, .. } if text == "Summarize this attachment.")
        );
        assert!(matches!(&msg.content[1], ContentBlock::Text { .. }));
        assert_eq!(
            msg.content[2],
            ContentBlock::Media {
                kind,
                source: MediaSource::Base64 {
                    mime_type: mime.to_owned(),
                    data: "QUJD".to_owned(),
                },
                provider_meta: ProviderOpaqueMeta::default(),
            },
            "{part_type}"
        );
        assert!(
            msg.provider_meta
                .extra
                .get(LEGACY_UNMIGRATED_PARTS_KEY)
                .is_none(),
            "{part_type}: nothing skipped"
        );
    }
}

#[test]
fn legacy_google_media_user_part_accepts_interactions_uri_and_snake_mime() {
    // TS `buildBinaryContent` also replayed `{ uri, mime_type }` binary parts.
    let raw = json!({
        "role": "user",
        "content": [
            { "type": "text", "text": "Watch this." },
            { "type": "video", "uri": "https://example.com/clip.mp4", "mime_type": "video/mp4" }
        ]
    });
    let msg = migrate_stored_message(&raw, 0, None).expect("migrates");
    assert_eq!(
        msg.content[1],
        ContentBlock::Media {
            kind: MediaKind::Video,
            source: MediaSource::Url {
                url: "https://example.com/clip.mp4".to_owned(),
                mime_type: Some("video/mp4".to_owned()),
            },
            provider_meta: ProviderOpaqueMeta::default(),
        }
    );
}

#[test]
fn legacy_tool_call_reads_provider_options_thought_signature() {
    let raw = json!({
        "role": "assistant",
        "content": [{
            "type": "tool-call",
            "toolCallId": "call_1",
            "toolName": "read",
            "input": { "path": "a" },
            "providerOptions": { "vertex": { "thought_signature": "sig_vertex" } }
        }]
    });
    let msg = migrate_stored_message(&raw, 0, None).unwrap();
    let ContentBlock::ToolCall { provider_meta, .. } = &msg.content[0] else {
        panic!("expected tool call");
    };
    assert_eq!(
        provider_meta.google_thought_signature.as_deref(),
        Some("sig_vertex")
    );
}

fn thinking_parts(msg: &CanonicalMessage) -> Vec<(Option<String>, Option<String>)> {
    msg.content
        .iter()
        .filter_map(|b| match b {
            ContentBlock::Thinking {
                signature,
                provider_meta,
                ..
            } => Some((
                signature.clone(),
                provider_meta.google_thought_signature.clone(),
            )),
            _ => None,
        })
        .collect()
}

#[test]
fn legacy_unstamped_google_thinking_part_keeps_provider_options_thought_signature() {
    // Shape the TS Google runtime persisted (`googleAssistantContentBlockToModelPart`): no
    // provider stamp on the message, the thought part carrying both the generic
    // `thinkingSignature` and `providerOptions.google.thoughtSignature`, then an unsigned call.
    let raw = json!({
        "role": "assistant",
        "content": [
            {
                "type": "thinking",
                "thinking": "Need to read the file.",
                "thinkingSignature": "sig_generic",
                "providerOptions": { "google": { "thoughtSignature": "sig_gemini" } }
            },
            { "type": "tool-call", "toolCallId": "call_1", "toolName": "read", "input": { "path": "a" } }
        ]
    });
    let msg = migrate_stored_message(&raw, 0, None).expect("migrates");
    assert!(msg.provider.is_none(), "legacy message stays unstamped");
    assert_eq!(
        thinking_parts(&msg),
        vec![(Some("sig_generic".into()), Some("sig_gemini".into()))],
        "generic signature unchanged; Google signature preserved in provider_meta"
    );
    let ContentBlock::ToolCall { provider_meta, .. } = &msg.content[1] else {
        panic!("expected tool call");
    };
    assert!(
        provider_meta.google_thought_signature.is_none(),
        "unsigned call stays unsigned until Google replay repair propagates the thought signature"
    );
    let reparsed: CanonicalMessage =
        serde_json::from_value(serde_json::to_value(&msg).unwrap()).unwrap();
    assert_eq!(reparsed, msg);
}

#[test]
fn legacy_thinking_part_reads_google_signature_variants_but_not_generic_ones() {
    let raw = json!({
        "role": "assistant",
        "content": [
            { "type": "reasoning", "text": "a", "thoughtSignature": "sig_direct" },
            {
                "type": "reasoning",
                "text": "b",
                "providerOptions": { "vertex": { "thought_signature": "sig_vertex_snake" } }
            },
            {
                "type": "reasoning",
                "text": "c",
                "providerMetadata": { "google": { "thoughtSignature": "sig_metadata" } }
            },
            {
                "type": "thinking",
                "thinking": "d",
                "providerOptions": { "google": { "thinking_signature": "sig_thinking_snake" } }
            },
            // Anthropic-style generic signatures must never become Gemini signatures.
            { "type": "reasoning", "text": "e", "signature": "sig_anthropic" },
            { "type": "thinking", "thinking": "f", "thinkingSignature": "sig_pi" },
            {
                "type": "reasoning",
                "text": "g",
                "providerOptions": { "anthropic": { "signature": "sig_other" } }
            }
        ]
    });
    let msg = migrate_stored_message(&raw, 0, None).expect("migrates");
    assert_eq!(
        thinking_parts(&msg),
        vec![
            (None, Some("sig_direct".into())),
            (None, Some("sig_vertex_snake".into())),
            (None, Some("sig_metadata".into())),
            (None, Some("sig_thinking_snake".into())),
            (Some("sig_anthropic".into()), None),
            (Some("sig_pi".into()), None),
            (None, None),
        ]
    );
}

#[test]
fn legacy_tool_call_reads_provider_metadata_thought_signature() {
    let raw = json!({
        "role": "assistant",
        "content": [{
            "type": "tool-call",
            "toolCallId": "call_1",
            "toolName": "read",
            "input": {},
            "providerMetadata": { "google": { "thoughtSignature": "sig_meta_call" } }
        }]
    });
    let msg = migrate_stored_message(&raw, 0, None).unwrap();
    let ContentBlock::ToolCall { provider_meta, .. } = &msg.content[0] else {
        panic!("expected tool call");
    };
    assert_eq!(
        provider_meta.google_thought_signature.as_deref(),
        Some("sig_meta_call")
    );
}
