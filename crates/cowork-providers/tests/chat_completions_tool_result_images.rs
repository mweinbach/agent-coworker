//! Regression: image parts in tool results (e.g. `read` on a PNG) must reach Chat Completions
//! vision models. A `tool` message only carries text, so the images follow the run of tool
//! messages as a user `image_url` message (Responses-transport parity).

use cowork_config::ProviderName;
use cowork_inference::CanonicalMessage;
use cowork_providers::chat_completions::{ProviderQuirks, build_chat_completions_payload};
use serde_json::{Map, Value, json};

fn messages() -> Vec<CanonicalMessage> {
    serde_json::from_value(json!([
        {
            "id": "m1",
            "role": "assistant",
            "content": [
                {
                    "type": "toolCall",
                    "id": "call_1",
                    "name": "read",
                    "arguments": { "filePath": "shot.png" }
                },
                {
                    "type": "toolCall",
                    "id": "call_2",
                    "name": "read",
                    "arguments": { "filePath": "notes.txt" }
                }
            ],
            "createdAt": "2026-01-01T00:00:00.000Z"
        },
        {
            "id": "m2",
            "role": "tool",
            "content": [
                {
                    "type": "toolResult",
                    "tool_call_id": "call_1",
                    "tool_name": "read",
                    "content": [
                        { "type": "text", "text": "Image file: shot.png (image/png, 8 bytes)" },
                        {
                            "type": "media",
                            "kind": "image",
                            "source": { "type": "base64", "mime_type": "image/png", "data": "iVBORw0KGgo=" }
                        }
                    ]
                },
                {
                    "type": "toolResult",
                    "tool_call_id": "call_2",
                    "tool_name": "read",
                    "content": [{ "type": "text", "text": "1: hello" }]
                }
            ],
            "createdAt": "2026-01-01T00:00:01.000Z"
        }
    ]))
    .expect("canonical messages fixture")
}

#[test]
fn tool_result_images_follow_tool_messages_as_user_image_message() {
    for provider in [
        ProviderName::Together,
        ProviderName::Fireworks,
        ProviderName::Firepass,
        ProviderName::Nvidia,
        ProviderName::Minimax,
        ProviderName::Lmstudio,
        ProviderName::OpencodeGo,
        ProviderName::OpencodeZen,
        ProviderName::Baseten,
    ] {
        let quirks = ProviderQuirks::for_provider(provider).unwrap();
        let payload = build_chat_completions_payload(
            &quirks,
            "vision-model",
            "",
            &messages(),
            &[],
            &Map::new(),
        );
        let wire: &Vec<Value> = payload["messages"].as_array().unwrap();
        let roles: Vec<&str> = wire.iter().map(|m| m["role"].as_str().unwrap()).collect();
        assert_eq!(
            roles,
            ["assistant", "tool", "tool", "user"],
            "{provider:?}: {wire:#?}"
        );
        assert_eq!(wire[1]["tool_call_id"], json!("call_1"));
        assert_eq!(
            wire[1]["content"],
            json!("Image file: shot.png (image/png, 8 bytes)")
        );
        assert_eq!(wire[2]["tool_call_id"], json!("call_2"));
        assert_eq!(
            wire[3]["content"],
            json!([
                { "type": "text", "text": "Attached image(s) from tool result:" },
                {
                    "type": "image_url",
                    "image_url": { "url": "data:image/png;base64,iVBORw0KGgo=" }
                }
            ])
        );
    }
}
