//! Regression test: image parts in tool results (e.g. `read` on a PNG) must be
//! serialized as native Bedrock image blocks, not dropped in favor of the label.

use cowork_inference::CanonicalMessage;
use cowork_providers::bedrock::build_converse_request_body;
use serde_json::{Map, json};

#[test]
fn tool_result_image_parts_become_native_image_blocks() {
    let messages: Vec<CanonicalMessage> = serde_json::from_value(json!([
        {
            "id": "m1",
            "role": "assistant",
            "content": [{
                "type": "toolCall",
                "id": "call_1",
                "name": "read",
                "arguments": { "filePath": "shot.png" }
            }],
            "createdAt": "2026-01-01T00:00:00.000Z"
        },
        {
            "id": "m2",
            "role": "tool",
            "content": [{
                "type": "toolResult",
                "tool_call_id": "call_1",
                "tool_name": "read",
                "content": [
                    { "type": "text", "text": "Image: shot.png" },
                    {
                        "type": "media",
                        "kind": "image",
                        "source": { "type": "base64", "mime_type": "image/png", "data": "iVBORw0KGgo=" }
                    },
                    {
                        "type": "media",
                        "kind": "image",
                        "source": { "type": "base64", "mime_type": "image/jpeg", "data": "/9j/4AAQ" }
                    }
                ]
            }],
            "createdAt": "2026-01-01T00:00:01.000Z"
        }
    ]))
    .expect("canonical messages fixture");

    let body =
        build_converse_request_body("anthropic.claude-test", "", &messages, &[], &Map::new());
    let tool_result = &body["messages"][1]["content"][0]["toolResult"];
    assert_eq!(tool_result["toolUseId"], json!("call_1"));
    assert_eq!(tool_result["status"], json!("success"));
    assert_eq!(
        tool_result["content"],
        json!([
            { "text": "Image: shot.png" },
            { "image": { "format": "png", "source": { "bytes": "iVBORw0KGgo=" } } },
            { "image": { "format": "jpeg", "source": { "bytes": "/9j/4AAQ" } } }
        ])
    );
}

#[test]
fn image_only_tool_result_has_no_empty_text_block() {
    let messages: Vec<CanonicalMessage> = serde_json::from_value(json!([
        {
            "id": "m2",
            "role": "tool",
            "content": [{
                "type": "toolResult",
                "tool_call_id": "call_2",
                "content": [{
                    "type": "media",
                    "kind": "image",
                    "source": { "type": "base64", "mime_type": "image/webp", "data": "UklGR" }
                }]
            }],
            "createdAt": "2026-01-01T00:00:01.000Z"
        }
    ]))
    .unwrap();
    let body = build_converse_request_body("m", "", &messages, &[], &Map::new());
    assert_eq!(
        body["messages"][0]["content"][0]["toolResult"]["content"],
        json!([{ "image": { "format": "webp", "source": { "bytes": "UklGR" } } }])
    );
}
