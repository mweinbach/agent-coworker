use std::collections::{HashMap, HashSet};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

/// Formats an occurrence-indexed item ID (`base_id` for occurrence `<= 1`, else `base_id:N`).
pub fn occurrence_item_id(base_id: &str, occurrence: usize) -> String {
    if occurrence <= 1 {
        base_id.to_owned()
    } else {
        format!("{base_id}:{occurrence}")
    }
}

/// Formats a prefixed item ID (`prefix:seed`).
pub fn make_item_id(prefix: &str, seed: &str) -> String {
    format!("{prefix}:{seed}")
}

/// Reconstructed turn summary returned by `thread/read` and `thread/hydrate` when `includeTurns: true`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedTurn {
    pub id: String,
    pub status: String,
    pub items: Vec<Value>,
}

/// Crate-agnostic view over a persisted journal event so `cowork-protocol` stays zero-internal-dep.
#[derive(Debug, Clone, Copy)]
pub struct PersistedJournalEventView<'a> {
    pub event_type: &'a str,
    pub turn_id: Option<&'a str>,
    pub item_id: Option<&'a str>,
    pub payload: &'a Value,
}

#[derive(Debug, Default)]
struct ProjectedTurnState {
    id: String,
    status: String,
    items: HashMap<String, Map<String, Value>>,
    item_order: Vec<String>,
    current_projected_id_by_raw_id: HashMap<String, String>,
    seen_occurrences_by_raw_id: HashMap<String, usize>,
    legacy_assistant_occurrence_ids: HashSet<String>,
    reasoning_closed_by_boundary_raw_ids: HashSet<String>,
    reasoning_restarted_by_boundary_raw_ids: HashSet<String>,
}

/// Occurrence-stable turn projector over persisted `ThreadJournal` events (`threadReadProjector.ts` parity).
#[derive(Debug, Default)]
pub struct ThreadTurnProjector {
    turns: HashMap<String, ProjectedTurnState>,
    order: Vec<String>,
}

impl ThreadTurnProjector {
    pub fn new() -> Self {
        Self::default()
    }

    fn ensure_turn(&mut self, turn_id: &str) -> &mut ProjectedTurnState {
        if !self.turns.contains_key(turn_id) {
            self.order.push(turn_id.to_owned());
            self.turns.insert(
                turn_id.to_owned(),
                ProjectedTurnState {
                    id: turn_id.to_owned(),
                    status: "inProgress".to_owned(),
                    ..Default::default()
                },
            );
        }
        self.turns.get_mut(turn_id).expect("turn inserted above")
    }

    fn project_started_item_id(turn: &mut ProjectedTurnState, raw_id: &str) -> String {
        let next = turn
            .seen_occurrences_by_raw_id
            .get(raw_id)
            .copied()
            .unwrap_or(0)
            + 1;
        turn.seen_occurrences_by_raw_id
            .insert(raw_id.to_owned(), next);
        let projected_id = occurrence_item_id(raw_id, next);
        turn.current_projected_id_by_raw_id
            .insert(raw_id.to_owned(), projected_id.clone());
        turn.reasoning_closed_by_boundary_raw_ids.remove(raw_id);
        if !turn.items.contains_key(&projected_id) {
            turn.item_order.push(projected_id.clone());
        }
        projected_id
    }

    fn current_projected_item_id(turn: &ProjectedTurnState, raw_id: &str) -> String {
        turn.current_projected_id_by_raw_id
            .get(raw_id)
            .cloned()
            .unwrap_or_else(|| raw_id.to_owned())
    }

    fn close_reasoning_for_item_boundary(turn: &mut ProjectedTurnState) {
        let to_close: Vec<String> = turn
            .current_projected_id_by_raw_id
            .iter()
            .filter_map(|(raw_id, projected_id)| {
                let is_reasoning = turn
                    .items
                    .get(projected_id)
                    .and_then(|item| item.get("type"))
                    .and_then(Value::as_str)
                    == Some("reasoning");
                is_reasoning.then(|| raw_id.clone())
            })
            .collect();
        for raw_id in to_close {
            turn.reasoning_closed_by_boundary_raw_ids.insert(raw_id);
        }
    }

    fn current_or_restarted_reasoning_item_id(
        turn: &mut ProjectedTurnState,
        raw_id: &str,
    ) -> String {
        if turn.reasoning_closed_by_boundary_raw_ids.contains(raw_id) {
            turn.reasoning_restarted_by_boundary_raw_ids
                .insert(raw_id.to_owned());
            Self::project_started_item_id(turn, raw_id)
        } else {
            Self::current_projected_item_id(turn, raw_id)
        }
    }

    pub fn handle(&mut self, event: &PersistedJournalEventView<'_>) {
        let Some(payload) = event.payload.as_object() else {
            return;
        };

        match event.event_type {
            "turn/started" => {
                if let Some(turn_obj) = payload.get("turn").and_then(Value::as_object)
                    && let Some(turn_id) = turn_obj.get("id").and_then(Value::as_str)
                {
                    let status = turn_obj
                        .get("status")
                        .and_then(Value::as_str)
                        .unwrap_or("inProgress")
                        .to_owned();
                    self.ensure_turn(turn_id).status = status;
                }
            }
            "item/started" | "item/completed" => {
                let turn_id = payload
                    .get("turnId")
                    .and_then(Value::as_str)
                    .or(event.turn_id);
                let item = payload.get("item").and_then(Value::as_object);
                let (Some(turn_id), Some(item)) = (turn_id, item) else {
                    return;
                };
                let Some(raw_id) = item.get("id").and_then(Value::as_str) else {
                    return;
                };
                let item_type = item.get("type").and_then(Value::as_str).unwrap_or_default();
                let turn = self.ensure_turn(turn_id);

                if item_type != "reasoning" {
                    Self::close_reasoning_for_item_boundary(turn);
                }

                if event.event_type == "item/completed"
                    && item_type == "reasoning"
                    && turn
                        .reasoning_restarted_by_boundary_raw_ids
                        .contains(raw_id)
                {
                    let projected_id = Self::current_projected_item_id(turn, raw_id);
                    if let Some(existing) = turn.items.get(&projected_id) {
                        let existing_text = existing
                            .get("text")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .trim();
                        let completed_text = item
                            .get("text")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .trim();
                        if !existing_text.is_empty()
                            && !completed_text.is_empty()
                            && completed_text != existing_text
                            && completed_text.contains(existing_text)
                        {
                            return;
                        }
                    }
                }

                let projected_id = if event.event_type == "item/started" {
                    Self::project_started_item_id(turn, raw_id)
                } else {
                    Self::current_projected_item_id(turn, raw_id)
                };

                if item_type == "agentMessage" && projected_id != raw_id {
                    turn.legacy_assistant_occurrence_ids
                        .insert(projected_id.clone());
                }
                if event.event_type == "item/completed" && !turn.items.contains_key(&projected_id) {
                    turn.item_order.push(projected_id.clone());
                }

                let mut next_item = item.clone();
                next_item.insert("id".to_owned(), Value::String(projected_id.clone()));
                turn.items.insert(projected_id, next_item);
            }
            "item/agentMessage/delta" => {
                let turn_id = payload
                    .get("turnId")
                    .and_then(Value::as_str)
                    .or(event.turn_id);
                let raw_item_id = payload
                    .get("itemId")
                    .and_then(Value::as_str)
                    .or(event.item_id);
                let delta = payload.get("delta").and_then(Value::as_str).unwrap_or("");
                let (Some(turn_id), Some(raw_item_id)) = (turn_id, raw_item_id) else {
                    return;
                };
                let turn = self.ensure_turn(turn_id);
                Self::close_reasoning_for_item_boundary(turn);
                let item_id = Self::current_projected_item_id(turn, raw_item_id);
                if !turn.items.contains_key(&item_id) {
                    turn.item_order.push(item_id.clone());
                }
                let entry = turn.items.entry(item_id.clone()).or_insert_with(|| {
                    let mut m = Map::new();
                    m.insert("id".to_owned(), Value::String(item_id));
                    m.insert("type".to_owned(), Value::String("agentMessage".to_owned()));
                    m.insert("text".to_owned(), Value::String(String::new()));
                    m
                });
                let prev = entry
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                entry.insert("text".to_owned(), Value::String(format!("{prev}{delta}")));
            }
            "item/reasoning/delta" => {
                let turn_id = payload
                    .get("turnId")
                    .and_then(Value::as_str)
                    .or(event.turn_id);
                let raw_item_id = payload
                    .get("itemId")
                    .and_then(Value::as_str)
                    .or(event.item_id);
                let delta = payload.get("delta").and_then(Value::as_str).unwrap_or("");
                let mode = match payload.get("mode").and_then(Value::as_str) {
                    Some("summary") => "summary",
                    _ => "reasoning",
                };
                let (Some(turn_id), Some(raw_item_id)) = (turn_id, raw_item_id) else {
                    return;
                };
                let turn = self.ensure_turn(turn_id);
                let item_id = Self::current_or_restarted_reasoning_item_id(turn, raw_item_id);
                if !turn.items.contains_key(&item_id) {
                    turn.item_order.push(item_id.clone());
                }
                let entry = turn.items.entry(item_id.clone()).or_insert_with(|| {
                    let mut m = Map::new();
                    m.insert("id".to_owned(), Value::String(item_id));
                    m.insert("type".to_owned(), Value::String("reasoning".to_owned()));
                    m.insert("mode".to_owned(), Value::String(mode.to_owned()));
                    m.insert("text".to_owned(), Value::String(String::new()));
                    m
                });
                let next_text = format!(
                    "{}{delta}",
                    entry
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                );
                entry.insert("mode".to_owned(), Value::String(mode.to_owned()));
                entry.insert("text".to_owned(), Value::String(next_text));
            }
            "turn/completed" => {
                let turn_obj = payload.get("turn").and_then(Value::as_object);
                let turn_id = turn_obj
                    .and_then(|t| t.get("id"))
                    .and_then(Value::as_str)
                    .or(event.turn_id);
                if let Some(turn_id) = turn_id {
                    let status = turn_obj
                        .and_then(|t| t.get("status"))
                        .and_then(Value::as_str)
                        .unwrap_or("completed")
                        .to_owned();
                    self.ensure_turn(turn_id).status = status;
                }
            }
            _ => {}
        }
    }

    pub fn build(&self) -> Vec<ProjectedTurn> {
        self.order
            .iter()
            .map(|turn_id| {
                let Some(turn) = self.turns.get(turn_id) else {
                    return ProjectedTurn {
                        id: turn_id.clone(),
                        status: "completed".to_owned(),
                        items: Vec::new(),
                    };
                };
                let raw_items: Vec<Value> = turn
                    .item_order
                    .iter()
                    .filter_map(|id| turn.items.get(id).cloned().map(Value::Object))
                    .collect();
                ProjectedTurn {
                    id: turn.id.clone(),
                    status: turn.status.clone(),
                    items: dedupe_replay_items(raw_items, &turn.legacy_assistant_occurrence_ids),
                }
            })
            .collect()
    }
}

fn normalize_ws(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn dedupe_replay_items(items: Vec<Value>, legacy_assistant_ids: &HashSet<String>) -> Vec<Value> {
    let mut seen_reasoning = HashSet::new();
    let mut reasoning_history: Vec<String> = Vec::new();
    let mut after_reasoning = Vec::new();

    for item in items {
        let is_reasoning = item.get("type").and_then(Value::as_str) == Some("reasoning");
        if is_reasoning && let Some(text) = item.get("text").and_then(Value::as_str) {
            let trimmed = text.trim();
            if trimmed.is_empty() || seen_reasoning.contains(trimmed) {
                continue;
            }
            let aggregate = normalize_ws(&reasoning_history.join("\n\n"));
            if !aggregate.is_empty() && aggregate == normalize_ws(trimmed) {
                continue;
            }
            seen_reasoning.insert(trimmed.to_owned());
            reasoning_history.push(trimmed.to_owned());
        }
        after_reasoning.push(item);
    }

    let mut assistant_history = String::new();
    let mut out = Vec::new();
    for item in after_reasoning {
        if item.get("type").and_then(Value::as_str) == Some("agentMessage")
            && let Some(text) = item.get("text").and_then(Value::as_str)
        {
            if text.trim().is_empty() {
                continue;
            }
            if let Some(id) = item.get("id").and_then(Value::as_str)
                && legacy_assistant_ids.contains(id)
                && !assistant_history.is_empty()
            {
                let stripped_agg: String = assistant_history
                    .chars()
                    .filter(|c| !c.is_whitespace())
                    .collect();
                let stripped_cur: String = text.chars().filter(|c| !c.is_whitespace()).collect();
                if !stripped_agg.is_empty() && stripped_agg == stripped_cur {
                    continue;
                }
            }
            assistant_history.push_str(text);
        }
        out.push(item);
    }
    out
}

fn is_tool_retry_annotation(val: &Value) -> bool {
    matches!(
        val.as_object()
            .and_then(|o| o.get("type"))
            .and_then(Value::as_str),
        Some("cowork.toolRetryTurn" | "cowork.toolRetryMetadata")
    )
}

fn is_hidden_retry_turn_message(obj: &Map<String, Value>) -> bool {
    let projected_user = obj.get("type").and_then(Value::as_str) == Some("userMessage");
    let feed_user = obj.get("kind").and_then(Value::as_str) == Some("message")
        && obj.get("role").and_then(Value::as_str) == Some("user");
    if !(projected_user || feed_user) {
        return false;
    }
    obj.get("annotations")
        .and_then(Value::as_array)
        .is_some_and(|arr| {
            arr.iter().any(|ann| {
                ann.as_object()
                    .and_then(|o| o.get("type"))
                    .and_then(Value::as_str)
                    == Some("cowork.toolRetryTurn")
            })
        })
}

fn strip_retry_lineage(value: &Value) -> Option<Value> {
    match value {
        Value::Array(arr) => Some(Value::Array(
            arr.iter().filter_map(strip_retry_lineage).collect(),
        )),
        Value::Object(obj) => {
            if is_hidden_retry_turn_message(obj) {
                return None;
            }
            let is_tool = obj.get("type").and_then(Value::as_str) == Some("toolCall")
                || obj.get("kind").and_then(Value::as_str) == Some("tool");
            let is_msg = obj.get("type").and_then(Value::as_str) == Some("userMessage")
                || obj.get("kind").and_then(Value::as_str) == Some("message");

            let mut next = Map::new();
            for (k, v) in obj {
                if is_tool && (k == "retryOf" || k == "inputDigest") {
                    continue;
                }
                if is_msg
                    && k == "annotations"
                    && let Some(arr) = v.as_array()
                {
                    let filtered: Vec<Value> = arr
                        .iter()
                        .filter(|ann| !is_tool_retry_annotation(ann))
                        .filter_map(strip_retry_lineage)
                        .collect();
                    if !filtered.is_empty() {
                        next.insert(k.clone(), json!(filtered));
                    }
                    continue;
                }
                let projected = strip_retry_lineage(v)?;
                next.insert(k.clone(), projected);
            }
            Some(Value::Object(next))
        }
        other => Some(other.clone()),
    }
}

/// Filters `retryOf` / `inputDigest` and hidden retry user messages when client lacks `toolRetryLineage`.
pub fn project_tool_retry_compatibility(
    tool_retry_lineage_enabled: bool,
    payload: &Value,
) -> Option<Value> {
    if tool_retry_lineage_enabled {
        Some(payload.clone())
    } else {
        strip_retry_lineage(payload)
    }
}
