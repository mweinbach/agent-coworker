//! Legacy TS Google Interactions history (`providerToolCall` / `providerToolResult` assistant
//! parts) migrates into canonical `ProviderNativeTool` blocks without losing the answer text.

use cowork_inference::legacy_messages::LEGACY_UNMIGRATED_PARTS_KEY;
use cowork_inference::{
    CanonicalMessage, ContentBlock, MessageRole, ProviderNativeToolRole, migrate_stored_message,
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
fn unknown_user_parts_still_keep_the_raw_message() {
    let raw = json!({
        "role": "user",
        "content": [{ "type": "text", "text": "hi" }, { "type": "futurePartType" }]
    });
    assert!(migrate_stored_message(&raw, 0, None).is_none());
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
