use std::collections::HashMap;

use cowork_protocol::{
    JsonRpcLiteNotification, make_item_id, occurrence_item_id, project_tool_retry_compatibility,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use uuid::Uuid;

use crate::partial_json::{StreamingToolDeltaParser, parse_partial_json_object};
use crate::stream::{ReasoningStreamMode, StreamEvent};

/// Negotiated client feature capabilities affecting outbound JSON-RPC projection.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientCapabilities {
    #[serde(default)]
    pub tool_retry_lineage: bool,
}

impl From<&cowork_protocol::ClientCapabilities> for ClientCapabilities {
    fn from(proto: &cowork_protocol::ClientCapabilities) -> Self {
        Self {
            tool_retry_lineage: proto.tool_retry_lineage.unwrap_or(false),
        }
    }
}

/// Outbound JSON-RPC-lite notification (`"jsonrpc"` omitted per wire contract).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProjectedNotification {
    pub method: String,
    pub params: Value,
}

impl ProjectedNotification {
    pub fn to_jsonrpc_notification(&self) -> JsonRpcLiteNotification {
        JsonRpcLiteNotification {
            method: self.method.clone(),
            params: Some(self.params.clone()),
        }
    }

    pub fn to_jsonrpc_value(&self) -> Value {
        serde_json::to_value(self.to_jsonrpc_notification()).expect("serialize notification")
    }
}

#[derive(Debug, Clone)]
struct ActiveAssistantItem {
    item_id: String,
    text: String,
    started: bool,
}

#[derive(Debug, Clone)]
struct ActiveReasoningItem {
    item_id: String,
    mode: ReasoningStreamMode,
    text: String,
    started: bool,
}

#[derive(Debug, Clone)]
struct ActiveToolItem {
    item_id: String,
    name: String,
    state: String,
    parser: StreamingToolDeltaParser,
    args: Option<Map<String, Value>>,
    result: Option<Value>,
    retry_of: Option<String>,
    input_digest: Option<Value>,
    approval: Option<Value>,
    started: bool,
}

impl ActiveToolItem {
    fn is_terminal(&self) -> bool {
        matches!(
            self.state.as_str(),
            "output-available" | "output-error" | "output-denied"
        )
    }

    fn to_item_value(&self) -> Value {
        let mut obj = Map::new();
        obj.insert("id".to_string(), Value::String(self.item_id.clone()));
        obj.insert("type".to_string(), Value::String("toolCall".to_string()));
        obj.insert("toolName".to_string(), Value::String(self.name.clone()));
        obj.insert("state".to_string(), Value::String(self.state.clone()));
        if let Some(args) = &self.args {
            obj.insert("args".to_string(), Value::Object(args.clone()));
        }
        if let Some(result) = &self.result {
            obj.insert("result".to_string(), result.clone());
        }
        if let Some(retry_of) = &self.retry_of {
            obj.insert("retryOf".to_string(), Value::String(retry_of.clone()));
        }
        if let Some(digest) = &self.input_digest {
            obj.insert("inputDigest".to_string(), digest.clone());
        }
        if let Some(approval) = &self.approval {
            obj.insert("approval".to_string(), approval.clone());
        }
        Value::Object(obj)
    }
}

/// Occurrence-stable `StreamEvent` -> JSON-RPC `item/*` & `turn/*` projector (`conversationProjection*.ts` parity).
#[derive(Debug)]
pub struct StreamEventProjector {
    thread_id: String,
    capabilities: ClientCapabilities,
    assistant_occurrence_by_turn: HashMap<String, usize>,
    active_assistant_by_turn: HashMap<String, ActiveAssistantItem>,
    reasoning_occurrence_by_key: HashMap<String, usize>,
    active_reasoning_order: Vec<String>,
    active_reasoning_by_key: HashMap<String, ActiveReasoningItem>,
    tool_occurrence_by_key: HashMap<String, usize>,
    tool_order: Vec<String>,
    tools_by_key: HashMap<String, ActiveToolItem>,
}

impl StreamEventProjector {
    pub fn new(thread_id: impl Into<String>, capabilities: ClientCapabilities) -> Self {
        Self {
            thread_id: thread_id.into(),
            capabilities,
            assistant_occurrence_by_turn: HashMap::new(),
            active_assistant_by_turn: HashMap::new(),
            reasoning_occurrence_by_key: HashMap::new(),
            active_reasoning_order: Vec::new(),
            active_reasoning_by_key: HashMap::new(),
            tool_occurrence_by_key: HashMap::new(),
            tool_order: Vec::new(),
            tools_by_key: HashMap::new(),
        }
    }

    pub fn capabilities(&self) -> ClientCapabilities {
        self.capabilities
    }

    pub fn set_capabilities(&mut self, capabilities: ClientCapabilities) {
        self.capabilities = capabilities;
    }

    pub fn project(&mut self, event: &StreamEvent) -> Vec<ProjectedNotification> {
        let mut out = Vec::new();
        match event {
            StreamEvent::TurnStarted { turn_id } => {
                self.push_notification(
                    &mut out,
                    "turn/started",
                    json!({
                        "threadId": self.thread_id,
                        "turn": {
                            "id": turn_id,
                            "status": "inProgress",
                            "items": [],
                        }
                    }),
                );
            }
            StreamEvent::UserMessage {
                turn_id,
                text,
                client_message_id,
                steer_request_id,
                annotations,
            } => {
                let seed = match client_message_id.as_deref().filter(|s| !s.is_empty()) {
                    Some(cid) => format!("{turn_id}:{cid}"),
                    None => format!("{turn_id}:{}", Uuid::new_v4()),
                };
                let mut item = Map::new();
                item.insert(
                    "id".to_string(),
                    Value::String(make_item_id("userMessage", &seed)),
                );
                item.insert("type".to_string(), Value::String("userMessage".to_string()));
                item.insert(
                    "content".to_string(),
                    json!([{"type": "text", "text": text}]),
                );
                if let Some(cid) = client_message_id.as_deref().filter(|s| !s.is_empty()) {
                    item.insert(
                        "clientMessageId".to_string(),
                        Value::String(cid.to_string()),
                    );
                }
                if let Some(sid) = steer_request_id.as_deref().filter(|s| !s.is_empty()) {
                    item.insert("steerRequestId".to_string(), Value::String(sid.to_string()));
                }
                if !annotations.is_empty() {
                    item.insert("annotations".to_string(), Value::Array(annotations.clone()));
                }
                let item_val = Value::Object(item);
                if let Some(projected_item) = project_tool_retry_compatibility(
                    self.capabilities.tool_retry_lineage,
                    &item_val,
                ) {
                    self.emit_item_started(&mut out, turn_id, projected_item.clone());
                    self.emit_item_completed(&mut out, turn_id, projected_item);
                }
            }
            StreamEvent::TextStart { turn_id, .. } => {
                self.close_open_reasoning_for_turn(&mut out, turn_id);
                let item_id = self.ensure_active_assistant(turn_id).item_id.clone();
                self.start_active_assistant_if_needed(&mut out, turn_id, &item_id);
            }
            StreamEvent::TextDelta { turn_id, delta, .. } => {
                self.close_open_reasoning_for_turn(&mut out, turn_id);
                if delta.is_empty() {
                    return out;
                }
                let item_id = {
                    let state = self.ensure_active_assistant(turn_id);
                    state.text.push_str(delta);
                    state.item_id.clone()
                };
                self.start_active_assistant_if_needed(&mut out, turn_id, &item_id);
                self.push_notification(
                    &mut out,
                    "item/agentMessage/delta",
                    json!({
                        "threadId": self.thread_id,
                        "turnId": turn_id,
                        "itemId": item_id,
                        "delta": delta,
                    }),
                );
            }
            StreamEvent::TextEnd {
                turn_id,
                text,
                annotations,
                ..
            } => {
                self.close_open_reasoning_for_turn(&mut out, turn_id);
                self.complete_active_assistant(&mut out, turn_id, Some(text.as_str()), annotations);
            }
            StreamEvent::ThinkingStart {
                turn_id,
                stream_id,
                mode,
            } => {
                // Deterministically close any open assistant text item BEFORE reasoning phase begins!
                self.close_open_assistant_before_boundary(&mut out, turn_id);
                let key = format!("{turn_id}:{stream_id}");
                let item_id = self.ensure_active_reasoning(turn_id, stream_id, *mode);
                self.start_active_reasoning_if_needed(&mut out, turn_id, &key, &item_id);
            }
            StreamEvent::ThinkingDelta {
                turn_id,
                stream_id,
                mode,
                delta,
            } => {
                self.close_open_assistant_before_boundary(&mut out, turn_id);
                let key = format!("{turn_id}:{stream_id}");
                let item_id = self.ensure_active_reasoning(turn_id, stream_id, *mode);
                self.start_active_reasoning_if_needed(&mut out, turn_id, &key, &item_id);
                if !delta.is_empty() {
                    if let Some(r_state) = self.active_reasoning_by_key.get_mut(&key) {
                        r_state.text.push_str(delta);
                        r_state.mode = *mode;
                    }
                    self.push_notification(
                        &mut out,
                        "item/reasoning/delta",
                        json!({
                            "threadId": self.thread_id,
                            "turnId": turn_id,
                            "itemId": item_id,
                            "mode": mode.as_wire_str(),
                            "delta": delta,
                        }),
                    );
                }
            }
            StreamEvent::ThinkingEnd {
                turn_id,
                stream_id,
                mode,
                text,
                ..
            } => {
                self.close_open_assistant_before_boundary(&mut out, turn_id);
                let key = format!("{turn_id}:{stream_id}");
                if let Some(mut r_state) = self.active_reasoning_by_key.remove(&key) {
                    self.active_reasoning_order.retain(|k| k != &key);
                    let final_text = if text.is_empty() {
                        r_state.text.clone()
                    } else {
                        text.clone()
                    };
                    if !r_state.started {
                        r_state.started = true;
                        self.emit_item_started(
                            &mut out,
                            turn_id,
                            json!({
                                "id": r_state.item_id,
                                "type": "reasoning",
                                "mode": mode.as_wire_str(),
                                "text": "",
                            }),
                        );
                    }
                    self.emit_item_completed(
                        &mut out,
                        turn_id,
                        json!({
                            "id": r_state.item_id,
                            "type": "reasoning",
                            "mode": mode.as_wire_str(),
                            "text": final_text,
                        }),
                    );
                } else if !text.trim().is_empty() {
                    let item_id = self.ensure_active_reasoning(turn_id, stream_id, *mode);
                    self.active_reasoning_by_key.remove(&key);
                    self.active_reasoning_order.retain(|k| k != &key);
                    let item = json!({
                        "id": item_id,
                        "type": "reasoning",
                        "mode": mode.as_wire_str(),
                        "text": text,
                    });
                    self.emit_item_started(&mut out, turn_id, item.clone());
                    self.emit_item_completed(&mut out, turn_id, item);
                }
            }
            StreamEvent::ToolCallStart {
                turn_id,
                key,
                name,
                initial_args,
            } => {
                // Deterministically close open assistant & reasoning items BEFORE tool-call phase begins!
                self.close_open_reasoning_for_turn(&mut out, turn_id);
                self.close_open_assistant_before_boundary(&mut out, turn_id);

                let full_key = format!("{turn_id}:{key}");
                let start_new = self.tools_by_key.contains_key(&full_key);
                let tool = self.resolve_tool_state(turn_id, key, name, start_new);
                if let Some(args) = initial_args {
                    tool.args = Some(args.clone());
                }
                tool.state = "input-streaming".to_string();
                let item = tool.to_item_value();
                let was_started = tool.started;
                tool.started = true;
                self.publish_tool_update(&mut out, turn_id, item, was_started);
            }
            StreamEvent::ToolCallDelta {
                turn_id,
                key,
                name,
                delta,
            } => {
                self.close_open_reasoning_for_turn(&mut out, turn_id);
                self.close_open_assistant_before_boundary(&mut out, turn_id);

                let tool = self.resolve_tool_state(turn_id, key, name, false);
                if tool.is_terminal() {
                    return out;
                }
                let partial_args = tool.parser.push_delta(delta);
                tool.args = Some(partial_args);
                let item = tool.to_item_value();
                let was_started = tool.started;
                tool.started = true;
                self.publish_tool_update(&mut out, turn_id, item, was_started);
            }
            StreamEvent::ToolCallEnd {
                turn_id,
                key,
                name,
                arguments,
                retry_of,
                input_digest,
            } => {
                self.close_open_reasoning_for_turn(&mut out, turn_id);
                self.close_open_assistant_before_boundary(&mut out, turn_id);

                let tool = self.resolve_tool_state(turn_id, key, name, false);
                if tool.is_terminal() {
                    return out;
                }
                if let Some(explicit_args) = arguments {
                    tool.args = Some(explicit_args.clone());
                } else if !tool.parser.buffer().is_empty() {
                    tool.args = Some(parse_partial_json_object(tool.parser.buffer()));
                }
                if retry_of.is_some() {
                    tool.retry_of = retry_of.clone();
                }
                if input_digest.is_some() {
                    tool.input_digest = input_digest.clone();
                }
                if tool.state != "approval-requested" {
                    tool.state = "input-available".to_string();
                }
                let item = tool.to_item_value();
                let was_started = tool.started;
                tool.started = true;
                self.publish_tool_update(&mut out, turn_id, item, was_started);
            }
            StreamEvent::ToolApprovalRequested {
                turn_id,
                key,
                name,
                approval,
            } => {
                self.close_open_reasoning_for_turn(&mut out, turn_id);
                self.close_open_assistant_before_boundary(&mut out, turn_id);

                let tool = self.resolve_tool_state(turn_id, key, name, false);
                tool.state = "approval-requested".to_string();
                tool.approval = Some(approval.clone());
                let item = tool.to_item_value();
                let was_started = tool.started;
                tool.started = true;
                self.publish_tool_update(&mut out, turn_id, item, was_started);
            }
            StreamEvent::ToolResult {
                turn_id,
                key,
                name,
                result,
                is_error,
                denied,
            } => {
                self.close_open_reasoning_for_turn(&mut out, turn_id);
                self.close_open_assistant_before_boundary(&mut out, turn_id);

                let tool = self.resolve_tool_state(turn_id, key, name, false);
                tool.state = if *denied {
                    "output-denied".to_string()
                } else if *is_error {
                    "output-error".to_string()
                } else {
                    "output-available".to_string()
                };
                tool.result = Some(result.clone());
                let item = tool.to_item_value();
                let was_started = tool.started;
                tool.started = true;
                if !was_started {
                    self.publish_tool_update(&mut out, turn_id, item.clone(), false);
                }
                self.publish_tool_update(&mut out, turn_id, item, true);
            }
            StreamEvent::TurnCompleted {
                turn_id, status, ..
            } => {
                self.close_open_reasoning_for_turn(&mut out, turn_id);
                self.close_open_assistant_before_boundary(&mut out, turn_id);
                if status == "failed" || status == "interrupted" {
                    self.fail_open_tools_for_turn(
                        &mut out,
                        turn_id,
                        "Turn ended before tool completion.",
                    );
                }
                self.push_notification(
                    &mut out,
                    "turn/completed",
                    json!({
                        "threadId": self.thread_id,
                        "turn": {
                            "id": turn_id,
                            "status": status,
                        }
                    }),
                );
            }
            StreamEvent::Error {
                turn_id,
                message,
                code,
            } => {
                self.close_open_reasoning_for_turn(&mut out, turn_id);
                self.close_open_assistant_before_boundary(&mut out, turn_id);
                self.fail_open_tools_for_turn(&mut out, turn_id, message);
                let mut err_item = Map::new();
                err_item.insert(
                    "id".to_string(),
                    Value::String(make_item_id(
                        "error",
                        &format!("{turn_id}:{}", Uuid::new_v4()),
                    )),
                );
                err_item.insert("type".to_string(), Value::String("error".to_string()));
                err_item.insert("message".to_string(), Value::String(message.clone()));
                if let Some(c) = code {
                    err_item.insert("code".to_string(), Value::String(c.clone()));
                }
                let val = Value::Object(err_item);
                self.emit_item_started(&mut out, turn_id, val.clone());
                self.emit_item_completed(&mut out, turn_id, val);
            }
        }
        out
    }

    fn ensure_active_assistant(&mut self, turn_id: &str) -> &mut ActiveAssistantItem {
        if !self.active_assistant_by_turn.contains_key(turn_id) {
            let next_occ = self
                .assistant_occurrence_by_turn
                .get(turn_id)
                .copied()
                .unwrap_or(0)
                + 1;
            self.assistant_occurrence_by_turn
                .insert(turn_id.to_string(), next_occ);
            let item_id = occurrence_item_id(&make_item_id("agentMessage", turn_id), next_occ);
            self.active_assistant_by_turn.insert(
                turn_id.to_string(),
                ActiveAssistantItem {
                    item_id,
                    text: String::new(),
                    started: false,
                },
            );
        }
        self.active_assistant_by_turn
            .get_mut(turn_id)
            .expect("inserted above")
    }

    fn start_active_assistant_if_needed(
        &mut self,
        out: &mut Vec<ProjectedNotification>,
        turn_id: &str,
        item_id: &str,
    ) {
        let should_emit = self
            .active_assistant_by_turn
            .get_mut(turn_id)
            .is_some_and(|s| {
                if s.started {
                    false
                } else {
                    s.started = true;
                    true
                }
            });
        if should_emit {
            self.emit_item_started(
                out,
                turn_id,
                json!({
                    "id": item_id,
                    "type": "agentMessage",
                    "text": "",
                }),
            );
        }
    }

    fn complete_active_assistant(
        &mut self,
        out: &mut Vec<ProjectedNotification>,
        turn_id: &str,
        explicit_text: Option<&str>,
        annotations: &[Value],
    ) {
        let Some(state) = self.active_assistant_by_turn.remove(turn_id) else {
            return;
        };
        let final_text = explicit_text.unwrap_or(state.text.as_str());
        if final_text.trim().is_empty() {
            return;
        }
        if !state.started {
            self.emit_item_started(
                out,
                turn_id,
                json!({
                    "id": state.item_id,
                    "type": "agentMessage",
                    "text": "",
                }),
            );
        }
        let mut item = Map::new();
        item.insert("id".to_string(), Value::String(state.item_id));
        item.insert(
            "type".to_string(),
            Value::String("agentMessage".to_string()),
        );
        item.insert("text".to_string(), Value::String(final_text.to_string()));
        if !annotations.is_empty() {
            item.insert(
                "annotations".to_string(),
                Value::Array(annotations.to_vec()),
            );
        }
        if let Some(projected) = project_tool_retry_compatibility(
            self.capabilities.tool_retry_lineage,
            &Value::Object(item),
        ) {
            self.emit_item_completed(out, turn_id, projected);
        }
    }

    fn close_open_assistant_before_boundary(
        &mut self,
        out: &mut Vec<ProjectedNotification>,
        turn_id: &str,
    ) {
        self.complete_active_assistant(out, turn_id, None, &[]);
    }

    fn ensure_active_reasoning(
        &mut self,
        turn_id: &str,
        stream_id: &str,
        mode: ReasoningStreamMode,
    ) -> String {
        let key = format!("{turn_id}:{stream_id}");
        if let Some(existing) = self.active_reasoning_by_key.get_mut(&key) {
            existing.mode = mode;
            return existing.item_id.clone();
        }
        let next_occ = self
            .reasoning_occurrence_by_key
            .get(&key)
            .copied()
            .unwrap_or(0)
            + 1;
        self.reasoning_occurrence_by_key
            .insert(key.clone(), next_occ);
        let item_id = occurrence_item_id(
            &make_item_id("reasoning", &format!("{turn_id}:{stream_id}")),
            next_occ,
        );
        self.active_reasoning_order.push(key.clone());
        self.active_reasoning_by_key.insert(
            key,
            ActiveReasoningItem {
                item_id: item_id.clone(),
                mode,
                text: String::new(),
                started: false,
            },
        );
        item_id
    }

    fn start_active_reasoning_if_needed(
        &mut self,
        out: &mut Vec<ProjectedNotification>,
        turn_id: &str,
        key: &str,
        item_id: &str,
    ) {
        let mode_opt = self.active_reasoning_by_key.get_mut(key).and_then(|s| {
            if s.started {
                None
            } else {
                s.started = true;
                Some(s.mode)
            }
        });
        if let Some(mode) = mode_opt {
            self.emit_item_started(
                out,
                turn_id,
                json!({
                    "id": item_id,
                    "type": "reasoning",
                    "mode": mode.as_wire_str(),
                    "text": "",
                }),
            );
        }
    }

    fn close_open_reasoning_for_turn(
        &mut self,
        out: &mut Vec<ProjectedNotification>,
        turn_id: &str,
    ) {
        let prefix = format!("{turn_id}:");
        let keys: Vec<String> = self
            .active_reasoning_order
            .iter()
            .filter(|k| k.starts_with(&prefix))
            .cloned()
            .collect();
        for key in keys {
            self.active_reasoning_order.retain(|k| k != &key);
            if let Some(state) = self.active_reasoning_by_key.remove(&key) {
                if !state.text.trim().is_empty() {
                    if !state.started {
                        self.emit_item_started(
                            out,
                            turn_id,
                            json!({
                                "id": state.item_id,
                                "type": "reasoning",
                                "mode": state.mode.as_wire_str(),
                                "text": "",
                            }),
                        );
                    }
                    self.emit_item_completed(
                        out,
                        turn_id,
                        json!({
                            "id": state.item_id,
                            "type": "reasoning",
                            "mode": state.mode.as_wire_str(),
                            "text": state.text,
                        }),
                    );
                } else if state.started {
                    self.emit_item_completed(
                        out,
                        turn_id,
                        json!({
                            "id": state.item_id,
                            "type": "reasoning",
                            "mode": state.mode.as_wire_str(),
                            "text": "",
                        }),
                    );
                }
            }
        }
    }

    fn resolve_tool_state(
        &mut self,
        turn_id: &str,
        key: &str,
        name: &str,
        start_new_occurrence: bool,
    ) -> &mut ActiveToolItem {
        let full_key = format!("{turn_id}:{key}");
        if !start_new_occurrence && self.tools_by_key.contains_key(&full_key) {
            let existing = self.tools_by_key.get_mut(&full_key).expect("checked above");
            if !name.is_empty() {
                existing.name = name.to_string();
            }
            return existing;
        }

        let next_occ = self
            .tool_occurrence_by_key
            .get(&full_key)
            .copied()
            .unwrap_or(0)
            + 1;
        self.tool_occurrence_by_key
            .insert(full_key.clone(), next_occ);
        let item_id = occurrence_item_id(
            &make_item_id("toolCall", &format!("{turn_id}:{key}")),
            next_occ,
        );
        if !self.tool_order.contains(&full_key) {
            self.tool_order.push(full_key.clone());
        }
        self.tools_by_key.insert(
            full_key.clone(),
            ActiveToolItem {
                item_id,
                name: name.to_string(),
                state: "input-streaming".to_string(),
                parser: StreamingToolDeltaParser::new(),
                args: None,
                result: None,
                retry_of: None,
                input_digest: None,
                approval: None,
                started: false,
            },
        );
        self.tools_by_key
            .get_mut(&full_key)
            .expect("inserted above")
    }

    fn publish_tool_update(
        &self,
        out: &mut Vec<ProjectedNotification>,
        turn_id: &str,
        item: Value,
        already_started: bool,
    ) {
        let Some(projected_item) =
            project_tool_retry_compatibility(self.capabilities.tool_retry_lineage, &item)
        else {
            return;
        };
        if !already_started {
            self.emit_item_started(out, turn_id, projected_item);
        } else {
            self.emit_item_completed(out, turn_id, projected_item);
        }
    }

    fn fail_open_tools_for_turn(
        &mut self,
        out: &mut Vec<ProjectedNotification>,
        turn_id: &str,
        error_message: &str,
    ) {
        let prefix = format!("{turn_id}:");
        let keys: Vec<String> = self
            .tool_order
            .iter()
            .filter(|k| k.starts_with(&prefix))
            .cloned()
            .collect();
        for full_key in keys {
            let mut to_emit = None;
            if let Some(tool) = self.tools_by_key.get_mut(&full_key)
                && !tool.is_terminal()
            {
                if tool.args.is_none() && !tool.parser.buffer().is_empty() {
                    tool.args = Some(parse_partial_json_object(tool.parser.buffer()));
                }
                tool.state = "output-error".to_string();
                tool.result = Some(json!({ "error": error_message }));
                let was_started = tool.started;
                tool.started = true;
                to_emit = Some((was_started, tool.to_item_value()));
            }
            if let Some((was_started, item)) = to_emit {
                if !was_started {
                    self.publish_tool_update(out, turn_id, item.clone(), false);
                }
                self.publish_tool_update(out, turn_id, item, true);
            }
        }
    }

    fn emit_item_started(&self, out: &mut Vec<ProjectedNotification>, turn_id: &str, item: Value) {
        self.push_notification(
            out,
            "item/started",
            json!({
                "threadId": self.thread_id,
                "turnId": turn_id,
                "item": item,
            }),
        );
    }

    fn emit_item_completed(
        &self,
        out: &mut Vec<ProjectedNotification>,
        turn_id: &str,
        item: Value,
    ) {
        self.push_notification(
            out,
            "item/completed",
            json!({
                "threadId": self.thread_id,
                "turnId": turn_id,
                "item": item,
            }),
        );
    }

    fn push_notification(&self, out: &mut Vec<ProjectedNotification>, method: &str, params: Value) {
        out.push(ProjectedNotification {
            method: method.to_string(),
            params,
        });
    }
}
