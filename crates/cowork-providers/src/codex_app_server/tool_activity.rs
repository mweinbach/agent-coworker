//! Native Codex tool activity projected into tool stream events (`notifications.ts`
//! `startedToolCallPart` / `completedToolPart` / output-delta parity).
//!
//! Codex runs its own shell, patch, MCP and dynamic tools inside the app-server turn, so their
//! lifecycle only reaches Cowork as `item/*` notifications. Each item becomes a tool call
//! (`ToolCallStart` + `ToolCallEnd`) on `item/started`, provisional `ToolResult`s while output
//! streams, and a final `ToolResult` (or error result) on `item/completed`. The harness never
//! executes these calls: the step's assistant message carries no `ToolCall` blocks for them.

use std::collections::{HashMap, HashSet};

use cowork_inference::StreamEvent;
use serde_json::{Map, Value, json};

use super::policy::from_codex_mcp_tool_name;

const COMMAND_EXECUTION: &str = "commandExecution";
const FILE_CHANGE: &str = "fileChange";

/// Per-turn bookkeeping for native Codex tool items.
#[derive(Debug, Default)]
pub struct CodexToolActivity {
    /// Item ids whose tool call was already surfaced (or whose output already streamed), so a
    /// late `item/started` never opens a second occurrence of the same tool.
    announced: HashSet<String>,
    /// Output streamed so far per item by incremental delta notifications.
    streamed_output: HashMap<String, String>,
}

/// Returns `true` for item notifications this module projects.
pub fn is_codex_tool_notification(method: &str, item: Option<&Value>) -> bool {
    match method {
        "item/started" | "item/completed" => item.is_some_and(|i| tool_item_name(i).is_some()),
        _ => is_codex_tool_output_delta(method),
    }
}

fn is_codex_tool_output_delta(method: &str) -> bool {
    matches!(
        method,
        "item/commandExecution/outputDelta"
            | "item/fileChange/delta"
            | "item/fileChange/diffDelta"
            | "item/fileChange/patchUpdated"
    )
}

impl CodexToolActivity {
    pub fn new() -> Self {
        Self::default()
    }

    /// Projects one tool notification (see [`is_codex_tool_notification`]) into stream events.
    pub fn handle(
        &mut self,
        method: &str,
        params: &Value,
        turn_id: &str,
        emit: &mut dyn FnMut(StreamEvent),
    ) {
        match method {
            "item/started" => {
                let Some(item) = params.get("item") else {
                    return;
                };
                let Some(call) = started_tool_call(item) else {
                    return;
                };
                if self.announced.insert(call.id.clone()) {
                    emit_tool_call(call, turn_id, emit);
                }
            }
            "item/completed" => {
                let Some(item) = params.get("item") else {
                    return;
                };
                let Some(call) = started_tool_call(item) else {
                    return;
                };
                // Completed without a prior `item/started`: surface the call first so the
                // transcript keeps its input.
                let id = call.id.clone();
                let name = call.name.clone();
                if self.announced.insert(id.clone()) {
                    emit_tool_call(call, turn_id, emit);
                }
                self.streamed_output.remove(&id);
                let (result, is_error) = completed_tool_result(item);
                emit(StreamEvent::ToolResult {
                    turn_id: turn_id.to_owned(),
                    key: id,
                    name,
                    result,
                    is_error,
                    denied: false,
                });
            }
            _ if is_codex_tool_output_delta(method) => {
                let Some(id) = non_empty_str(params, "itemId") else {
                    return;
                };
                let name = if method == "item/commandExecution/outputDelta" {
                    COMMAND_EXECUTION
                } else {
                    FILE_CHANGE
                };
                let output = if method == "item/fileChange/patchUpdated" {
                    // A full patch snapshot replaces whatever streamed before.
                    let mut merged = params
                        .get("item")
                        .and_then(Value::as_object)
                        .cloned()
                        .unwrap_or_default();
                    if let Some(obj) = params.as_object() {
                        merged.extend(obj.iter().map(|(k, v)| (k.clone(), v.clone())));
                    }
                    let output = file_change_output(&Value::Object(merged));
                    if let Some(text) = output.as_str() {
                        self.streamed_output.insert(id.to_owned(), text.to_owned());
                    }
                    output
                } else {
                    let delta = ["delta", "diff", "patch", "summary"]
                        .iter()
                        .find_map(|key| params.get(*key).and_then(Value::as_str))
                        .unwrap_or("");
                    let buffer = self.streamed_output.entry(id.to_owned()).or_default();
                    buffer.push_str(delta);
                    Value::String(buffer.clone())
                };
                self.announced.insert(id.to_owned());
                // Provisional output (`preliminary: true` in TS); the completed item replaces it.
                emit(StreamEvent::ToolResult {
                    turn_id: turn_id.to_owned(),
                    key: id.to_owned(),
                    name: name.to_owned(),
                    result: output,
                    is_error: false,
                    denied: false,
                });
            }
            _ => {}
        }
    }
}

struct CodexToolCall {
    id: String,
    name: String,
    input: Map<String, Value>,
}

fn emit_tool_call(call: CodexToolCall, turn_id: &str, emit: &mut dyn FnMut(StreamEvent)) {
    emit(StreamEvent::ToolCallStart {
        turn_id: turn_id.to_owned(),
        key: call.id.clone(),
        name: call.name.clone(),
        initial_args: (!call.input.is_empty()).then(|| call.input.clone()),
    });
    emit(StreamEvent::ToolCallEnd {
        turn_id: turn_id.to_owned(),
        key: call.id,
        name: call.name,
        arguments: Some(call.input),
        retry_of: None,
        input_digest: None,
    });
}

/// `asString` parity: string values only (empty strings included).
fn str_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn non_empty_str<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    str_field(value, key).filter(|s| !s.is_empty())
}

/// `value ?? fallback` parity: a present, non-null field.
fn present<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.get(key).filter(|v| !v.is_null())
}

fn mcp_tool_name(item: &Value) -> String {
    format!(
        "{}.{}",
        str_field(item, "server").unwrap_or("mcp"),
        str_field(item, "tool").unwrap_or("tool")
    )
}

fn dynamic_tool_name(item: &Value) -> String {
    str_field(item, "tool")
        .filter(|t| !t.is_empty())
        .map(from_codex_mcp_tool_name)
        .unwrap_or_else(|| "dynamicTool".to_owned())
}

/// Display name of a native tool item, or `None` for items that are not tools.
fn tool_item_name(item: &Value) -> Option<String> {
    match str_field(item, "type")? {
        "commandExecution" => Some(COMMAND_EXECUTION.to_owned()),
        "mcpToolCall" => Some(mcp_tool_name(item)),
        "dynamicToolCall" => Some(dynamic_tool_name(item)),
        "fileChange" => Some(FILE_CHANGE.to_owned()),
        _ => None,
    }
}

fn tool_item_id(item: &Value) -> Option<String> {
    let id = non_empty_str(item, "id");
    match str_field(item, "type") {
        Some("dynamicToolCall") => id.or_else(|| non_empty_str(item, "callId")),
        _ => id,
    }
    .map(ToOwned::to_owned)
}

/// Tool arguments must be an object; anything else becomes `{}` (`item.arguments ?? {}`).
fn object_arguments(item: &Value) -> Map<String, Value> {
    match item.get("arguments") {
        Some(Value::Object(map)) => map.clone(),
        Some(Value::String(raw)) => serde_json::from_str::<Map<String, Value>>(raw)
            .ok()
            .unwrap_or_default(),
        _ => Map::new(),
    }
}

fn insert_present(map: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(v) = value.filter(|v| !v.is_null()) {
        map.insert(key.to_owned(), v.clone());
    }
}

/// `startedToolCallPart` parity: the tool call surfaced for a native tool item.
fn started_tool_call(item: &Value) -> Option<CodexToolCall> {
    let name = tool_item_name(item)?;
    let id = tool_item_id(item)?;
    let input = match str_field(item, "type")? {
        "commandExecution" => {
            let mut input = Map::new();
            insert_present(&mut input, "command", item.get("command"));
            insert_present(&mut input, "cwd", item.get("cwd"));
            input
        }
        "fileChange" => {
            let mut input = Map::new();
            insert_present(&mut input, "cwd", item.get("cwd"));
            let paths = present(item, "paths")
                .or_else(|| present(item, "files"))
                .or_else(|| present(item, "path"))
                .cloned()
                .or_else(|| file_change_paths(item));
            insert_present(&mut input, "paths", paths.as_ref());
            insert_present(&mut input, "summary", item.get("summary"));
            input
        }
        _ => object_arguments(item),
    };
    Some(CodexToolCall { id, name, input })
}

/// The pinned app-server reports edited files as `changes: [{ path, kind, diff }]`.
fn file_change_paths(item: &Value) -> Option<Value> {
    let paths: Vec<Value> = item
        .get("changes")?
        .as_array()?
        .iter()
        .filter_map(|change| str_field(change, "path"))
        .map(|path| Value::String(path.to_owned()))
        .collect();
    (!paths.is_empty()).then_some(Value::Array(paths))
}

/// `fileChangeOutput` parity.
fn file_change_output(value: &Value) -> Value {
    if !value.is_object() {
        return Value::Null;
    }
    str_field(value, "patch")
        .or_else(|| str_field(value, "diff"))
        .map(|s| Value::String(s.to_owned()))
        .or_else(|| present(value, "changes").cloned())
        .or_else(|| str_field(value, "summary").map(|s| Value::String(s.to_owned())))
        .or_else(|| present(value, "result").cloned())
        .unwrap_or(Value::Null)
}

/// `dynamicToolErrorText` parity.
fn dynamic_tool_error_text(item: &Value) -> String {
    if let Some(error) = non_empty_str(item, "error") {
        return error.to_owned();
    }
    item.get("contentItems")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|content| str_field(content, "text"))
        .find(|text| !text.trim().is_empty())
        .unwrap_or("dynamic tool failed")
        .to_owned()
}

/// Tool-error payload, shaped like the projected `tool_error` result (`{ error }`).
fn error_result(error: Value) -> Value {
    json!({ "error": error })
}

/// `completedToolPart` parity: `(result, is_error)` for a completed native tool item.
fn completed_tool_result(item: &Value) -> (Value, bool) {
    let failed = str_field(item, "status") == Some("failed");
    match str_field(item, "type") {
        Some("commandExecution") => {
            let output = present(item, "aggregatedOutput").cloned();
            if failed {
                (
                    error_result(output.unwrap_or_else(|| json!("command failed"))),
                    true,
                )
            } else {
                (output.unwrap_or_else(|| json!("")), false)
            }
        }
        Some("mcpToolCall") => {
            if failed {
                let error = present(item, "error")
                    .cloned()
                    .unwrap_or_else(|| json!("unknown_error"));
                (error_result(error), true)
            } else {
                (
                    present(item, "result").cloned().unwrap_or(Value::Null),
                    false,
                )
            }
        }
        Some("dynamicToolCall") => {
            let failed = failed || item.get("success").and_then(Value::as_bool) == Some(false);
            if failed {
                (error_result(json!(dynamic_tool_error_text(item))), true)
            } else {
                let output = present(item, "result")
                    .or_else(|| present(item, "contentItems"))
                    .cloned()
                    .unwrap_or(Value::Null);
                (output, false)
            }
        }
        Some("fileChange") => {
            if failed {
                let error = present(item, "error")
                    .cloned()
                    .unwrap_or_else(|| json!("file change failed"));
                (error_result(error), true)
            } else {
                (file_change_output(item), false)
            }
        }
        _ => (Value::Null, false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(notifications: &[(&str, Value)]) -> Vec<StreamEvent> {
        let mut activity = CodexToolActivity::new();
        let mut events = Vec::new();
        for (method, params) in notifications {
            activity.handle(method, params, "t1", &mut |ev| events.push(ev));
        }
        events
    }

    #[test]
    fn failed_mcp_and_dynamic_tools_surface_error_results() {
        let events = run(&[
            (
                "item/completed",
                json!({ "item": { "type": "mcpToolCall", "id": "m1", "server": "docs",
                    "tool": "search", "arguments": { "q": "x" }, "status": "failed",
                    "error": { "message": "boom" } } }),
            ),
            (
                "item/completed",
                json!({ "item": { "type": "dynamicToolCall", "callId": "d1",
                    "tool": "cowork_mcp__srv__lookup", "success": false,
                    "contentItems": [{ "type": "inputText", "text": "denied" }] } }),
            ),
        ]);
        let results: Vec<_> = events
            .iter()
            .filter_map(|ev| match ev {
                StreamEvent::ToolResult {
                    key,
                    name,
                    result,
                    is_error,
                    ..
                } => Some((key.as_str(), name.as_str(), result.clone(), *is_error)),
                _ => None,
            })
            .collect();
        assert_eq!(
            results,
            vec![
                (
                    "m1",
                    "docs.search",
                    json!({ "error": { "message": "boom" } }),
                    true
                ),
                ("d1", "mcp__srv__lookup", json!({ "error": "denied" }), true),
            ]
        );
        // Completed-only items still surface their call (with input) first.
        assert!(matches!(
            &events[1],
            StreamEvent::ToolCallEnd { key, arguments: Some(args), .. }
                if key == "m1" && args.get("q") == Some(&json!("x"))
        ));
    }

    #[test]
    fn non_tool_items_are_ignored() {
        assert!(!is_codex_tool_notification(
            "item/started",
            Some(&json!({ "type": "agentMessage", "id": "a1" }))
        ));
        assert!(!is_codex_tool_notification(
            "item/completed",
            Some(&json!({ "type": "reasoning", "id": "r1" }))
        ));
        assert!(is_codex_tool_notification(
            "item/commandExecution/outputDelta",
            None
        ));
    }
}
