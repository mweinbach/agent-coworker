//! Codex code-mode (`exec` / `wait`) tool display (`codeModeToolDisplay.ts` and the
//! `rawResponseItem/completed` routing in `notifications.ts`).
//!
//! In code mode the model runs a script through the custom `exec` tool, which may call Cowork
//! dynamic tools (`tools.webSearch(...)`) and may keep running in a "cell" polled through the
//! `wait` function. Those calls only surface as raw response items. The script is shown as one
//! tool call named after the tools it calls; nested dynamic tool calls that complete inside a
//! visible script are folded into it (their citation sources move to the script's result), and
//! a script whose nested tool already surfaced on its own is not shown twice.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use cowork_inference::StreamEvent;
use regex::Regex;
use serde_json::{Map, Value};

use super::citations::{projected_tool_output, referenced_citation_sources};
use super::policy::from_codex_mcp_tool_name;

const CODE_MODE_FALLBACK_TOOL_NAME: &str = "codeExecution";

fn is_ident_start(c: Option<&char>) -> bool {
    matches!(c, Some(c) if c.is_ascii_alphabetic() || *c == '_' || *c == '$')
}

fn is_ident_part(c: Option<&char>) -> bool {
    matches!(c, Some(c) if c.is_ascii_alphanumeric() || *c == '_' || *c == '$')
}

fn find_from(s: &[char], start: usize, needle: &[char]) -> Option<usize> {
    (start..s.len()).find(|&i| s[i..].starts_with(needle))
}

fn skip_quoted(s: &[char], start: usize, quote: char) -> usize {
    let mut i = start + 1;
    while i < s.len() {
        if s[i] == '\\' {
            i += 2;
            continue;
        }
        if s[i] == quote {
            return i + 1;
        }
        i += 1;
    }
    s.len()
}

fn skip_line_comment(s: &[char], start: usize) -> usize {
    find_from(s, start + 2, &['\n']).map_or(s.len(), |i| i + 1)
}

fn skip_block_comment(s: &[char], start: usize) -> usize {
    find_from(s, start + 2, &['*', '/']).map_or(s.len(), |i| i + 2)
}

fn is_comment_start(s: &[char], i: usize, second: char) -> bool {
    s[i] == '/' && s.get(i + 1) == Some(&second)
}

fn find_template_interpolation_end(s: &[char], start: usize) -> Option<usize> {
    let mut i = start;
    let mut depth = 1usize;
    while i < s.len() {
        let c = s[i];
        if c == '"' || c == '\'' {
            i = skip_quoted(s, i, c);
            continue;
        }
        if c == '`' {
            i = skip_template_literal(s, i, &mut |_| {});
            continue;
        }
        if is_comment_start(s, i, '/') {
            i = skip_line_comment(s, i);
            continue;
        }
        if is_comment_start(s, i, '*') {
            i = skip_block_comment(s, i);
            continue;
        }
        if c == '{' {
            depth += 1;
        } else if c == '}' {
            depth -= 1;
            if depth == 0 {
                return Some(i);
            }
        }
        i += 1;
    }
    None
}

fn skip_template_literal(
    s: &[char],
    start: usize,
    on_interpolation: &mut dyn FnMut(&[char]),
) -> usize {
    let mut i = start + 1;
    while i < s.len() {
        if s[i] == '\\' {
            i += 2;
            continue;
        }
        if s[i] == '`' {
            return i + 1;
        }
        if s[i] == '$' && s.get(i + 1) == Some(&'{') {
            let expr_start = i + 2;
            let Some(expr_end) = find_template_interpolation_end(s, expr_start) else {
                return s.len();
            };
            on_interpolation(&s[expr_start..expr_end]);
            i = expr_end + 1;
            continue;
        }
        i += 1;
    }
    s.len()
}

fn skip_trivia(s: &[char], start: usize) -> usize {
    let mut i = start;
    while i < s.len() {
        if s[i].is_whitespace() {
            i += 1;
        } else if is_comment_start(s, i, '/') {
            i = skip_line_comment(s, i);
        } else if is_comment_start(s, i, '*') {
            i = skip_block_comment(s, i);
        } else {
            break;
        }
    }
    i
}

fn read_identifier(s: &[char], start: usize) -> Option<(String, usize)> {
    if !is_ident_start(s.get(start)) {
        return None;
    }
    let mut end = start + 1;
    while is_ident_part(s.get(end)) {
        end += 1;
    }
    Some((s[start..end].iter().collect(), end))
}

fn read_bracket_property(s: &[char], start: usize) -> Option<(String, usize)> {
    let mut i = skip_trivia(s, start + 1);
    let quote = *s.get(i).filter(|c| **c == '"' || **c == '\'')?;
    let value_start = i + 1;
    i = skip_quoted(s, i, quote);
    if i >= s.len() || s[i - 1] != quote {
        return None;
    }
    let value: String = s[value_start..i - 1].iter().collect();
    if value.contains('\\') {
        return None;
    }
    i = skip_trivia(s, i);
    (s.get(i) == Some(&']')).then_some((value, i + 1))
}

fn collect_nested_tool_names(s: &[char], names: &mut Vec<String>, seen: &mut HashSet<String>) {
    let mut i = 0;
    while i < s.len() {
        let c = s[i];
        if c == '"' || c == '\'' {
            i = skip_quoted(s, i, c);
            continue;
        }
        if c == '`' {
            i = skip_template_literal(s, i, &mut |expr| {
                collect_nested_tool_names(expr, names, seen)
            });
            continue;
        }
        if is_comment_start(s, i, '/') {
            i = skip_line_comment(s, i);
            continue;
        }
        if is_comment_start(s, i, '*') {
            i = skip_block_comment(s, i);
            continue;
        }
        let Some((ident, end)) = read_identifier(s, i) else {
            i += 1;
            continue;
        };
        i = end;
        if ident != "tools" {
            continue;
        }
        let mut cursor = skip_trivia(s, i);
        match (s.get(cursor), s.get(cursor + 1)) {
            (Some('?'), Some('.')) => cursor += 2,
            (Some('.'), _) => cursor += 1,
            (Some('['), _) => {}
            _ => continue,
        }
        let property = if s.get(cursor) == Some(&'[') {
            read_bracket_property(s, cursor)
        } else {
            read_identifier(s, skip_trivia(s, cursor))
        };
        let Some((name, end)) = property.filter(|(name, _)| !name.is_empty()) else {
            continue;
        };
        if s.get(skip_trivia(s, end)) != Some(&'(') {
            continue;
        }
        if seen.insert(name.clone()) {
            names.push(name);
        }
    }
}

fn code_mode_source(input: &Value) -> Option<&str> {
    match input {
        Value::String(s) => Some(s),
        Value::Object(map) => map
            .get("code")
            .and_then(Value::as_str)
            .or_else(|| map.get("source").and_then(Value::as_str)),
        _ => None,
    }
}

/// `codeModeNestedToolNames` parity: the `tools.<name>(...)` calls a script makes, in order.
pub fn code_mode_nested_tool_names(input: &Value) -> Vec<String> {
    let Some(source) = code_mode_source(input) else {
        return Vec::new();
    };
    let chars: Vec<char> = source.chars().collect();
    let mut names = Vec::new();
    collect_nested_tool_names(&chars, &mut names, &mut HashSet::new());
    names
}

/// `codeModeDisplayToolName` parity.
pub fn code_mode_display_tool_name(input: &Value) -> String {
    let names = code_mode_nested_tool_names(input);
    match names.as_slice() {
        [] => CODE_MODE_FALLBACK_TOOL_NAME.to_owned(),
        [one] => one.clone(),
        [first, second] => format!("{first} + {second}"),
        [first, rest @ ..] => format!("{first} + {} more", rest.len()),
    }
}

/// `codeModeWaitCellId` parity.
fn code_mode_wait_cell_id(input: &Value) -> Option<String> {
    let parsed;
    let record = match input {
        Value::String(raw) => {
            parsed = serde_json::from_str::<Value>(raw).ok()?;
            &parsed
        }
        other => other,
    };
    record
        .get("cell_id")
        .and_then(Value::as_str)
        .or_else(|| record.get("cellId").and_then(Value::as_str))
        .map(ToOwned::to_owned)
}

/// `runningCodeModeCellId` parity: the cell id a still-running script reports.
fn running_code_mode_cell_id(output: &Value) -> Option<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    match output {
        Value::String(text) => RE
            .get_or_init(|| {
                Regex::new(r"(?i)Script running with cell ID\s+([^\s.]+)").expect("valid regex")
            })
            .captures(text)
            .map(|caps| caps[1].to_owned()),
        Value::Array(values) => values.iter().find_map(running_code_mode_cell_id),
        Value::Object(map) => map.values().find_map(running_code_mode_cell_id),
        _ => None,
    }
}

fn normalized_tool_name(name: &str) -> String {
    name.chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

fn str_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn present<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.get(key).filter(|v| !v.is_null())
}

fn first_present<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|key| present(value, key))
}

/// Tool-call arguments as an object: objects pass through, JSON-object strings are parsed, and
/// any other script source is shown as `{ code }`.
fn input_arguments(input: &Value) -> Map<String, Value> {
    match input {
        Value::Object(map) => map.clone(),
        Value::String(raw) => serde_json::from_str::<Map<String, Value>>(raw)
            .unwrap_or_else(|_| Map::from_iter([("code".to_owned(), input.clone())])),
        Value::Null => Map::new(),
        other => Map::from_iter([("input".to_owned(), other.clone())]),
    }
}

struct PendingExec {
    tool_name: String,
    input: Value,
    nested_tool_names: HashSet<String>,
    nested_tool_observed: bool,
}

struct Continuation {
    /// `None` when the script was not surfaced (its nested tool showed up on its own).
    visible_call_id: Option<String>,
    tool_name: String,
    nested_tool_names: HashSet<String>,
    citation_sources: Vec<Value>,
}

fn names_nested_tool(nested: &HashSet<String>, dynamic_tool_name: &str) -> bool {
    nested.contains(&normalized_tool_name(dynamic_tool_name))
        || nested.contains(&normalized_tool_name(&from_codex_mcp_tool_name(
            dynamic_tool_name,
        )))
}

/// Per-turn code-mode bookkeeping. Continuations live in an arena so the cell, wait-call and
/// suppressed-tool indexes share one record (TS shares the object by reference).
#[derive(Default)]
pub struct CodexCodeModeActivity {
    pending_execs: Vec<(String, PendingExec)>,
    continuations: Vec<Continuation>,
    by_cell_id: Vec<(String, usize)>,
    by_wait_call_id: Vec<(String, usize)>,
    suppressed_dynamic_tools: HashMap<String, usize>,
}

fn take_entry(entries: &mut Vec<(String, usize)>, key: &str) -> Option<usize> {
    let pos = entries.iter().position(|(k, _)| k == key)?;
    Some(entries.remove(pos).1)
}

fn set_entry(entries: &mut Vec<(String, usize)>, key: String, value: usize) {
    entries.retain(|(k, _)| *k != key);
    entries.push((key, value));
}

impl CodexCodeModeActivity {
    pub fn new() -> Self {
        Self::default()
    }

    fn find_visible_continuation(
        &self,
        entries: &[(String, usize)],
        dynamic_tool_name: &str,
    ) -> Option<usize> {
        entries.iter().map(|(_, id)| *id).find(|id| {
            let c = &self.continuations[*id];
            c.visible_call_id.is_some()
                && names_nested_tool(&c.nested_tool_names, dynamic_tool_name)
        })
    }

    /// Code-mode handling of a `dynamicToolCall` item notification. Returns `true` when the
    /// notification is folded into a visible script and must not surface on its own.
    pub fn intercept_dynamic_tool(&mut self, method: &str, item: &Value) -> bool {
        let call_id = str_field(item, "id")
            .or_else(|| str_field(item, "callId"))
            .filter(|id| !id.is_empty());
        if method == "item/completed"
            && let Some(id) = call_id
            && let Some(cont) = self.suppressed_dynamic_tools.remove(id)
        {
            let output = first_present(item, &["result", "contentItems"])
                .cloned()
                .unwrap_or(Value::Null);
            self.continuations[cont]
                .citation_sources
                .extend(referenced_citation_sources(&output));
            return true;
        }
        let Some(tool) = str_field(item, "tool").filter(|t| !t.is_empty()) else {
            return false;
        };
        if method != "item/started" {
            return false;
        }
        if let Some((_, pending)) = self
            .pending_execs
            .iter_mut()
            .find(|(_, p)| names_nested_tool(&p.nested_tool_names, tool))
        {
            pending.nested_tool_observed = true;
            return false;
        }
        let Some(id) = call_id else {
            return false;
        };
        let cont = self
            .find_visible_continuation(&self.by_cell_id, tool)
            .or_else(|| self.find_visible_continuation(&self.by_wait_call_id, tool));
        match cont {
            Some(cont) => {
                self.suppressed_dynamic_tools.insert(id.to_owned(), cont);
                true
            }
            None => false,
        }
    }

    /// Projects one `rawResponseItem/completed` item into tool stream events.
    pub fn handle_raw_response_item(
        &mut self,
        item: &Value,
        turn_id: &str,
        emit: &mut dyn FnMut(StreamEvent),
    ) {
        let Some(item_type) = str_field(item, "type") else {
            return;
        };
        let Some(call_id) = ["call_id", "callId", "id"]
            .iter()
            .find_map(|key| str_field(item, key))
            .filter(|id| !id.is_empty())
            .map(ToOwned::to_owned)
        else {
            return;
        };
        match item_type {
            "custom_tool_call" | "customToolCall" => {
                let name = str_field(item, "name")
                    .or_else(|| str_field(item, "tool"))
                    .unwrap_or("customTool");
                if !matches!(name, "exec" | "functions.exec") {
                    return;
                }
                let input = first_present(item, &["input", "arguments"])
                    .cloned()
                    .unwrap_or_else(|| Value::Object(Map::new()));
                let pending = PendingExec {
                    tool_name: code_mode_display_tool_name(&input),
                    nested_tool_names: code_mode_nested_tool_names(&input)
                        .iter()
                        .map(|n| normalized_tool_name(n))
                        .collect(),
                    input,
                    nested_tool_observed: false,
                };
                self.pending_execs.retain(|(id, _)| *id != call_id);
                self.pending_execs.push((call_id, pending));
            }
            "function_call" | "functionCall" => {
                let name = str_field(item, "name")
                    .or_else(|| str_field(item, "tool"))
                    .unwrap_or("functionTool");
                if !matches!(name, "wait" | "functions.wait") {
                    return;
                }
                let input = first_present(item, &["arguments", "input"])
                    .cloned()
                    .unwrap_or_else(|| Value::Object(Map::new()));
                let cell_id = code_mode_wait_cell_id(&input);
                if let Some(cont) = cell_id
                    .as_deref()
                    .and_then(|cell| take_entry(&mut self.by_cell_id, cell))
                {
                    set_entry(&mut self.by_wait_call_id, call_id, cont);
                    return;
                }
                // A wait for a cell this turn never saw start still shows as a code execution.
                self.continuations.push(Continuation {
                    visible_call_id: Some(call_id.clone()),
                    tool_name: CODE_MODE_FALLBACK_TOOL_NAME.to_owned(),
                    nested_tool_names: HashSet::new(),
                    citation_sources: Vec::new(),
                });
                let cont = self.continuations.len() - 1;
                set_entry(&mut self.by_wait_call_id, call_id.clone(), cont);
                emit_tool_call(
                    &call_id,
                    CODE_MODE_FALLBACK_TOOL_NAME,
                    &input,
                    turn_id,
                    emit,
                );
            }
            "custom_tool_call_output" | "customToolCallOutput" => {
                let Some(pos) = self.pending_execs.iter().position(|(id, _)| *id == call_id) else {
                    return;
                };
                let (_, pending) = self.pending_execs.remove(pos);
                let output = first_present(item, &["output", "result", "contentItems"])
                    .cloned()
                    .unwrap_or(Value::Null);
                let cell_id = running_code_mode_cell_id(&output);
                self.continuations.push(Continuation {
                    visible_call_id: (!pending.nested_tool_observed).then(|| call_id.clone()),
                    tool_name: pending.tool_name.clone(),
                    nested_tool_names: pending.nested_tool_names,
                    citation_sources: Vec::new(),
                });
                let cont = self.continuations.len() - 1;
                if let Some(cell) = &cell_id {
                    set_entry(&mut self.by_cell_id, cell.clone(), cont);
                }
                if pending.nested_tool_observed {
                    return;
                }
                emit_tool_call(&call_id, &pending.tool_name, &pending.input, turn_id, emit);
                if cell_id.is_none() {
                    emit_tool_result(
                        &call_id,
                        &pending.tool_name,
                        projected_tool_output(output, &[]),
                        turn_id,
                        emit,
                    );
                }
            }
            "function_call_output" | "functionCallOutput" => {
                let Some(cont) = take_entry(&mut self.by_wait_call_id, &call_id) else {
                    return;
                };
                let output = first_present(item, &["output", "result", "contentItems"])
                    .cloned()
                    .unwrap_or(Value::Null);
                if let Some(cell) = running_code_mode_cell_id(&output) {
                    set_entry(&mut self.by_cell_id, cell, cont);
                    return;
                }
                let continuation = &self.continuations[cont];
                let Some(visible) = continuation.visible_call_id.clone() else {
                    return;
                };
                let tool_name = continuation.tool_name.clone();
                let result = projected_tool_output(output, &continuation.citation_sources);
                emit_tool_result(&visible, &tool_name, result, turn_id, emit);
            }
            _ => {}
        }
    }
}

fn emit_tool_call(
    call_id: &str,
    name: &str,
    input: &Value,
    turn_id: &str,
    emit: &mut dyn FnMut(StreamEvent),
) {
    let args = input_arguments(input);
    emit(StreamEvent::ToolCallStart {
        turn_id: turn_id.to_owned(),
        key: call_id.to_owned(),
        name: name.to_owned(),
        initial_args: (!args.is_empty()).then(|| args.clone()),
    });
    emit(StreamEvent::ToolCallEnd {
        turn_id: turn_id.to_owned(),
        key: call_id.to_owned(),
        name: name.to_owned(),
        arguments: Some(args),
        retry_of: None,
        input_digest: None,
    });
}

fn emit_tool_result(
    call_id: &str,
    name: &str,
    result: Value,
    turn_id: &str,
    emit: &mut dyn FnMut(StreamEvent),
) {
    emit(StreamEvent::ToolResult {
        turn_id: turn_id.to_owned(),
        key: call_id.to_owned(),
        name: name.to_owned(),
        result,
        is_error: false,
        denied: false,
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn nested_tool_names_follow_tools_calls_and_skip_strings_and_comments() {
        let src = r#"
            // tools.commented()
            const a = "tools.inString()";
            const r = await tools.webSearch({ q: `x ${await tools?.webFetch(u)}` });
            /* tools.blocked() */ tools["read"]( 'p' ); tools.notCalled;
            tools . webSearch(1);
        "#;
        assert_eq!(
            code_mode_nested_tool_names(&json!(src)),
            vec!["webSearch", "webFetch", "read"]
        );
        assert_eq!(
            code_mode_display_tool_name(&json!(src)),
            "webSearch + 2 more"
        );
        assert_eq!(
            code_mode_display_tool_name(&json!({ "code": "tools.a(); tools.b()" })),
            "a + b"
        );
        assert_eq!(
            code_mode_display_tool_name(&json!("1 + 1")),
            "codeExecution"
        );
    }

    #[test]
    fn cell_ids_come_from_wait_input_and_running_output() {
        assert_eq!(
            code_mode_wait_cell_id(&json!("{\"cell_id\":\"c7\"}")).as_deref(),
            Some("c7")
        );
        assert_eq!(
            code_mode_wait_cell_id(&json!({ "cellId": "c8" })).as_deref(),
            Some("c8")
        );
        assert_eq!(
            running_code_mode_cell_id(&json!([{ "text": "Script running with cell ID c9." }]))
                .as_deref(),
            Some("c9")
        );
        assert!(running_code_mode_cell_id(&json!("done")).is_none());
    }
}
