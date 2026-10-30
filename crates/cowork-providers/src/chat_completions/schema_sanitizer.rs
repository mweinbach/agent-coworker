use cowork_config::ProviderName;
use serde_json::{Map, Value, json};

use crate::transport::ToolDefinition;

pub const FIREWORKS_TOOL_SCHEMA_MAX_BYTES: usize = 4096;
pub const FIREWORKS_TOTAL_TOOL_SCHEMA_MAX_BYTES: usize = 12288;

fn collapse_tuple_items(items: Vec<Value>) -> Option<Value> {
    if items.is_empty() {
        return None;
    }
    if items.len() == 1 {
        return items.into_iter().next();
    }
    let first = &items[0];
    if items.iter().skip(1).all(|item| item == first) {
        return Some(first.clone());
    }
    Some(json!({ "anyOf": items }))
}

/// Normalizes Draft-07 / Draft 2020-12 JSON Schema constructs (`$schema`, `prefixItems`, tuple
/// `items`, `additionalItems`) into broadly compatible OpenAI tool schema syntax.
pub fn normalize_tool_json_schema(schema: &Value) -> Value {
    match schema {
        Value::Array(arr) => Value::Array(arr.iter().map(normalize_tool_json_schema).collect()),
        Value::Object(obj) => {
            let mut out = Map::new();
            let additional_items = obj.get("additionalItems").cloned();
            let prefix_items = obj.get("prefixItems").cloned();
            let raw_items = obj.get("items").cloned();
            let has_max_items = obj.contains_key("maxItems");

            for (k, v) in obj {
                if matches!(
                    k.as_str(),
                    "$schema" | "additionalItems" | "prefixItems" | "items"
                ) {
                    continue;
                }
                out.insert(k.clone(), normalize_tool_json_schema(v));
            }

            if let Some(Value::Array(tuple)) = prefix_items {
                let normalized_tuple: Vec<Value> =
                    tuple.iter().map(normalize_tool_json_schema).collect();
                let tuple_len = normalized_tuple.len();
                let items_missing_or_bool =
                    raw_items.is_none() || matches!(raw_items, Some(Value::Bool(_)));
                if items_missing_or_bool {
                    if let Some(collapsed) = collapse_tuple_items(normalized_tuple) {
                        out.insert("items".to_string(), collapsed);
                    }
                    if !has_max_items
                        && (raw_items.is_none() || raw_items == Some(Value::Bool(false)))
                        && tuple_len > 0
                    {
                        out.insert("maxItems".to_string(), json!(tuple_len));
                    }
                } else if let Some(existing_items) = raw_items {
                    out.insert(
                        "items".to_string(),
                        normalize_tool_json_schema(&existing_items),
                    );
                }
            } else if let Some(existing_items) = raw_items {
                match existing_items {
                    Value::Array(tuple) => {
                        let normalized_tuple: Vec<Value> =
                            tuple.iter().map(normalize_tool_json_schema).collect();
                        let tuple_len = normalized_tuple.len();
                        if let Some(collapsed) = collapse_tuple_items(normalized_tuple) {
                            out.insert("items".to_string(), collapsed);
                        }
                        if !has_max_items
                            && additional_items == Some(Value::Bool(false))
                            && tuple_len > 0
                        {
                            out.insert("maxItems".to_string(), json!(tuple_len));
                        }
                    }
                    Value::Bool(_) => {}
                    other => {
                        out.insert("items".to_string(), normalize_tool_json_schema(&other));
                    }
                }
            }

            Value::Object(out)
        }
        other => other.clone(),
    }
}

fn sanitize_fireworks_recursive(schema: &Value) -> Value {
    match schema {
        Value::Array(arr) => Value::Array(arr.iter().map(sanitize_fireworks_recursive).collect()),
        Value::Object(obj) => {
            let mut out = Map::new();
            let mut one_of_variants: Option<Vec<Value>> = None;

            for (k, v) in obj {
                if matches!(
                    k.as_str(),
                    "maxItems" | "maxLength" | "minItems" | "minLength" | "pattern"
                ) {
                    continue;
                }
                if k == "oneOf" {
                    if let Value::Array(arr) = v {
                        one_of_variants =
                            Some(arr.iter().map(sanitize_fireworks_recursive).collect());
                    }
                    continue;
                }
                // Preserve property names inside `"properties"` even if a property itself is named `"pattern"` etc.
                if k == "properties"
                    && let Value::Object(props) = v
                {
                    let mut clean_props = Map::new();
                    for (prop_name, prop_val) in props {
                        clean_props
                            .insert(prop_name.clone(), sanitize_fireworks_recursive(prop_val));
                    }
                    out.insert("properties".to_string(), Value::Object(clean_props));
                    continue;
                }
                out.insert(k.clone(), sanitize_fireworks_recursive(v));
            }

            if let Some(mut converted) = one_of_variants {
                match out.remove("anyOf") {
                    Some(Value::Array(mut existing)) => {
                        existing.append(&mut converted);
                        out.insert("anyOf".to_string(), Value::Array(existing));
                    }
                    _ => {
                        out.insert("anyOf".to_string(), Value::Array(converted));
                    }
                }
            }

            Value::Object(out)
        }
        other => other.clone(),
    }
}

/// Sanitizes a tool JSON Schema for Fireworks & FirePass grammar compilers.
pub fn sanitize_fireworks_tool_json_schema(schema: &Value) -> Value {
    let normalized = normalize_tool_json_schema(schema);
    sanitize_fireworks_recursive(&normalized)
}

fn build_shallow_object_schema(original: &Value) -> Value {
    let mut props = Map::new();
    if let Some(orig_props) = original.get("properties").and_then(Value::as_object) {
        for key in orig_props.keys() {
            props.insert(key.clone(), json!({}));
        }
    }
    let required: Vec<Value> = original
        .get("required")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .filter(|k| props.contains_key(*k))
                .map(|k| Value::String(k.to_string()))
                .collect()
        })
        .unwrap_or_default();

    let mut out = Map::new();
    out.insert("type".to_string(), Value::String("object".to_string()));
    out.insert("properties".to_string(), Value::Object(props));
    if !required.is_empty() {
        out.insert("required".to_string(), Value::Array(required));
    }
    out.insert("additionalProperties".to_string(), Value::Bool(true));
    Value::Object(out)
}

fn build_relaxed_object_schema() -> Value {
    json!({
        "type": "object",
        "properties": {},
        "additionalProperties": true
    })
}

fn json_byte_len(val: &Value) -> usize {
    serde_json::to_string(val)
        .map(|s| s.len())
        .unwrap_or(usize::MAX)
}

/// Sanitizes tool definitions according to provider-specific schema constraints (`4KB` per tool and
/// `12KB` total UTF-8 JSON bytes for `fireworks` and `firepass`).
pub fn sanitize_tools_for_provider(
    provider: ProviderName,
    tools: &[ToolDefinition],
) -> Vec<ToolDefinition> {
    if !matches!(provider, ProviderName::Fireworks | ProviderName::Firepass) {
        return tools
            .iter()
            .map(|t| ToolDefinition {
                name: t.name.clone(),
                description: t.description.clone(),
                parameters: normalize_tool_json_schema(&t.parameters),
            })
            .collect();
    }

    let relaxed = build_relaxed_object_schema();
    let relaxed_len = json_byte_len(&relaxed);
    let mut cumulative_bytes = 0usize;
    let total_tools = tools.len();
    let mut out = Vec::with_capacity(total_tools);

    for (idx, tool) in tools.iter().enumerate() {
        let remaining_after = total_tools.saturating_sub(idx + 1);
        let reserved_for_rest = remaining_after.saturating_mul(relaxed_len);

        let full = sanitize_fireworks_tool_json_schema(&tool.parameters);
        let shallow = build_shallow_object_schema(&tool.parameters);

        let chosen = [full, shallow, relaxed.clone()]
            .into_iter()
            .find(|candidate| {
                let len = json_byte_len(candidate);
                len <= FIREWORKS_TOOL_SCHEMA_MAX_BYTES
                    && cumulative_bytes
                        .saturating_add(len)
                        .saturating_add(reserved_for_rest)
                        <= FIREWORKS_TOTAL_TOOL_SCHEMA_MAX_BYTES
            })
            .unwrap_or_else(|| relaxed.clone());

        cumulative_bytes = cumulative_bytes.saturating_add(json_byte_len(&chosen));
        out.push(ToolDefinition {
            name: tool.name.clone(),
            description: tool.description.clone(),
            parameters: chosen,
        });
    }

    out
}
