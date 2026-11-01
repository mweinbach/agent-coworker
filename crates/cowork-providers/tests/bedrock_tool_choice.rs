//! Regression: `providerOptions.bedrock.toolChoice` must reach the Converse request the way the
//! TS adapter (`convertToolConfig` + `buildPiStreamOptions`) sent it, instead of always falling
//! back to automatic tool selection.

use cowork_providers::ToolDefinition;
use cowork_providers::bedrock::build_converse_request_body;
use serde_json::{Map, Value, json};

const MODEL: &str = "us.anthropic.claude-sonnet-4-6";

fn tools() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition {
            name: "list_dir".into(),
            description: "List directory".into(),
            parameters: json!({
                "type": "object",
                "properties": { "dir": { "type": "string" } }
            }),
        },
        ToolDefinition {
            name: "read_file".into(),
            description: "Read a file".into(),
            parameters: json!({
                "type": "object",
                "properties": { "path": { "type": "string" } }
            }),
        },
    ]
}

fn body_for(opts: Value) -> Value {
    let opts: Map<String, Value> = opts.as_object().unwrap().clone();
    build_converse_request_body(MODEL, "System", &[], &tools(), &opts)
}

fn expected_tool_specs() -> Value {
    json!([
        {
            "toolSpec": {
                "name": "list_dir",
                "description": "List directory",
                "inputSchema": { "json": {
                    "type": "object",
                    "properties": { "dir": { "type": "string" } }
                } }
            }
        },
        {
            "toolSpec": {
                "name": "read_file",
                "description": "Read a file",
                "inputSchema": { "json": {
                    "type": "object",
                    "properties": { "path": { "type": "string" } }
                } }
            }
        }
    ])
}

#[test]
fn tool_choice_none_omits_tool_config() {
    let body = body_for(json!({ "bedrock": { "toolChoice": "none" } }));
    assert!(body.get("toolConfig").is_none(), "body: {body}");
    // The rest of the request is still built.
    assert!(body.get("messages").is_some());
}

#[test]
fn tool_choice_auto_sends_auto() {
    let body = body_for(json!({ "bedrock": { "toolChoice": "auto" } }));
    assert_eq!(
        body["toolConfig"],
        json!({ "tools": expected_tool_specs(), "toolChoice": { "auto": {} } })
    );
}

#[test]
fn tool_choice_any_sends_any() {
    let body = body_for(json!({ "bedrock": { "toolChoice": "any" } }));
    assert_eq!(
        body["toolConfig"],
        json!({ "tools": expected_tool_specs(), "toolChoice": { "any": {} } })
    );
}

#[test]
fn tool_choice_specific_tool_sends_named_tool() {
    let body = body_for(json!({
        "bedrock": { "toolChoice": { "type": "tool", "name": "read_file" } }
    }));
    assert_eq!(
        body["toolConfig"],
        json!({
            "tools": expected_tool_specs(),
            "toolChoice": { "tool": { "name": "read_file" } }
        })
    );
}

#[test]
fn tool_choice_unset_keeps_tools_without_choice() {
    for opts in [json!({}), json!({ "bedrock": {} })] {
        let body = body_for(opts);
        assert_eq!(
            body["toolConfig"],
            json!({ "tools": expected_tool_specs() })
        );
    }
}

#[test]
fn tool_choice_invalid_forms_are_ignored() {
    for choice in [
        json!("required"),
        json!("NONE"),
        json!(" none "),
        json!(""),
        json!(true),
        json!({ "type": "tool" }),
        json!({ "type": "tool", "name": "   " }),
        json!({ "type": "tool", "name": 7 }),
        json!({ "type": "any" }),
        json!({ "tool": { "name": "read_file" } }),
    ] {
        let body = body_for(json!({ "bedrock": { "toolChoice": choice.clone() } }));
        assert_eq!(
            body["toolConfig"],
            json!({ "tools": expected_tool_specs() }),
            "choice: {choice}"
        );
    }
}

#[test]
fn top_level_tool_choice_is_not_read() {
    // TS read `toolChoice` from the `bedrock` provider section only.
    let body = body_for(json!({ "toolChoice": "none" }));
    assert_eq!(
        body["toolConfig"],
        json!({ "tools": expected_tool_specs() })
    );

    let body = body_for(json!({ "toolChoice": "any", "bedrock": { "toolChoice": "auto" } }));
    assert_eq!(body["toolConfig"]["toolChoice"], json!({ "auto": {} }));
}

#[test]
fn tool_choice_without_tools_sends_no_tool_config() {
    let opts: Map<String, Value> = json!({ "bedrock": { "toolChoice": "any" } })
        .as_object()
        .unwrap()
        .clone();
    let body = build_converse_request_body(MODEL, "System", &[], &[], &opts);
    assert!(body.get("toolConfig").is_none(), "body: {body}");
}
