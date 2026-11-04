use serde_json::{Map, Value, json};

pub const MAX_MCP_DESCRIPTION_CHARS: usize = 4_000;
pub const DESCRIPTION_TRUNCATION_SUFFIX: &str = "… [description truncated]";

/// Truncates MCP tool or schema property descriptions at 4,000 Unicode scalar values.
pub fn truncate_mcp_description(text: &str) -> String {
    let char_count = text.chars().count();
    if char_count <= MAX_MCP_DESCRIPTION_CHARS {
        return text.to_owned();
    }
    let prefix: String = text.chars().take(MAX_MCP_DESCRIPTION_CHARS).collect();
    format!("{prefix}{DESCRIPTION_TRUNCATION_SUFFIX}")
}

/// Replaces runs of characters outside `[A-Za-z0-9-]` with `_` and trims leading/trailing `_`.
pub fn normalize_mcp_name(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut last_underscore = false;
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' {
            out.push(ch);
            last_underscore = false;
        } else if !last_underscore {
            out.push('_');
            last_underscore = true;
        }
    }
    let trimmed = out.trim_matches('_');
    if trimmed.is_empty() {
        "mcp".to_owned()
    } else {
        trimmed.to_owned()
    }
}

/// Builds the canonical `mcp__<server>__<tool>` identifier.
pub fn build_mcp_tool_name(server_name: &str, tool_name: &str) -> String {
    format!(
        "mcp__{}__{}",
        normalize_mcp_name(server_name),
        normalize_mcp_name(tool_name)
    )
}

/// Normalizes an arbitrary MCP JSON Schema (including draft-07 tuple `items: [...]` and
/// draft-2020-12 `prefixItems: [...]`) into strict OpenAI/Anthropic-compatible JSON Schema.
pub fn normalize_mcp_json_schema(schema: &Value, is_root: bool) -> Value {
    normalize_node(schema, is_root)
}

/// Sub-schema keys whose value is a map of name -> schema (TS `MCP_SCHEMA_MAP_KEYS`).
const SCHEMA_MAP_KEYS: [&str; 5] = [
    "$defs",
    "definitions",
    "dependentSchemas",
    "patternProperties",
    "properties",
];

/// Sub-schema keys whose value is a single schema (TS `MCP_SCHEMA_SINGLE_KEYS`).
const SCHEMA_SINGLE_KEYS: [&str; 9] = [
    "additionalProperties",
    "contains",
    "else",
    "if",
    "not",
    "propertyNames",
    "then",
    "unevaluatedItems",
    "unevaluatedProperties",
];

/// The permissive "any JSON value" schema used where a strict validator needs a typed schema.
fn any_value_schema() -> Value {
    json!({ "type": ["string", "number", "boolean", "object", "array", "null"] })
}

/// Whether `type` is `"array"` or a type list that includes it (e.g. `["array", "null"]`).
fn type_includes_array(ty: Option<&Value>) -> bool {
    match ty {
        Some(Value::String(t)) => t == "array",
        Some(Value::Array(types)) => types.iter().any(|t| t.as_str() == Some("array")),
        _ => false,
    }
}

fn normalize_node(node: &Value, prefer_object_fallback: bool) -> Value {
    // Boolean sub-schemas (`true` = anything, `false` = nothing) keep their meaning, as in TS
    // `normalizeMcpJsonSchema`: rewriting `false` into an any-type union would invert
    // `"not": false` or `"properties": { "x": false }`. Only the tool's root schema, which must
    // be an object schema, falls back below.
    if node.is_boolean() && !prefer_object_fallback {
        return node.clone();
    }
    let Some(obj) = node.as_object() else {
        if prefer_object_fallback {
            return json!({ "type": "object", "properties": {} });
        }
        return json!({
            "type": ["string", "number", "boolean", "object", "array", "null"]
        });
    };

    let mut out = Map::new();

    // Extract tuple schemas before copying regular keys
    let tuple_items = obj.get("items").and_then(Value::as_array);
    let prefix_items = obj.get("prefixItems").and_then(Value::as_array);
    let additional_items = obj.get("additionalItems");
    let raw_items = obj.get("items");

    for (k, v) in obj {
        match k.as_str() {
            "$schema" | "prefixItems" | "additionalItems" => continue,
            "description" => {
                if let Some(s) = v.as_str() {
                    out.insert(k.clone(), Value::String(truncate_mcp_description(s)));
                } else {
                    out.insert(k.clone(), v.clone());
                }
            }
            key if SCHEMA_MAP_KEYS.contains(&key) => match v.as_object() {
                Some(props) => {
                    let mut norm_props = Map::new();
                    for (pk, pv) in props {
                        norm_props.insert(pk.clone(), normalize_node(pv, false));
                    }
                    out.insert(k.clone(), Value::Object(norm_props));
                }
                None => {
                    out.insert(k.clone(), v.clone());
                }
            },
            key if SCHEMA_SINGLE_KEYS.contains(&key) => {
                let normalized = if v.is_object() || v.is_boolean() {
                    normalize_node(v, false)
                } else {
                    v.clone()
                };
                out.insert(k.clone(), normalized);
            }
            "items" => {
                // Handled below so tuple `items` and `prefixItems` unify cleanly.
            }
            "anyOf" | "oneOf" | "allOf" => match v.as_array() {
                Some(arr) => {
                    let norm_arr: Vec<Value> = arr
                        .iter()
                        .map(|entry| normalize_node(entry, false))
                        .collect();
                    out.insert(k.clone(), Value::Array(norm_arr));
                }
                None => {
                    out.insert(k.clone(), v.clone());
                }
            },
            _ => {
                out.insert(k.clone(), v.clone());
            }
        }
    }

    // Tuple normalization:
    // 1. Draft-07 `items: [S1, S2, ...]`
    // 2. Draft-2020-12 `prefixItems: [S1, S2, ...]` (with optional `items: false | Schema`)
    if let Some(tuple_arr) = tuple_items.or(prefix_items) {
        let mut variants: Vec<Value> = tuple_arr
            .iter()
            .map(|entry| normalize_node(entry, false))
            .collect();

        // Check if extra items schema was supplied via `additionalItems: { ... }` or (with prefixItems) `items: { ... }`
        let extra_schema = if tuple_items.is_some() {
            additional_items.filter(|v| v.is_object())
        } else {
            raw_items.filter(|v| v.is_object())
        };
        if let Some(extra) = extra_schema {
            variants.push(normalize_node(extra, false));
        }
        // An explicitly open tuple (`additionalItems: true` for draft-07 `items: [...]`, or
        // `items: true` alongside `prefixItems`) allows trailing elements of any type; they
        // must not be narrowed to the prefix element types.
        let explicitly_open = if tuple_items.is_some() {
            additional_items == Some(&Value::Bool(true))
        } else {
            raw_items == Some(&Value::Bool(true))
        };
        if explicitly_open {
            variants.push(any_value_schema());
        }

        let closed_tuple = if tuple_items.is_some() {
            additional_items == Some(&Value::Bool(false))
        } else {
            // In draft-2020-12, `items: false` or omitted `items` alongside `prefixItems` bounds tuple length
            // when no open `items` schema is given.
            raw_items.is_none() || raw_items == Some(&Value::Bool(false))
        };

        if closed_tuple && !out.contains_key("maxItems") {
            out.insert("maxItems".to_owned(), json!(tuple_arr.len()));
        }

        let collapsed_items = collapse_schema_variants(variants);
        out.insert("items".to_owned(), collapsed_items);
        if !out.contains_key("type") {
            out.insert("type".to_owned(), Value::String("array".to_owned()));
        }
    } else if let Some(single_items) = raw_items {
        if single_items.is_object() {
            out.insert("items".to_owned(), normalize_node(single_items, false));
        } else if single_items == &Value::Bool(false) {
            out.insert("maxItems".to_owned(), json!(0));
        }
    }

    // Ensure arrays always carry an `items` schema for strict tool validators
    // (including nullable arrays such as `"type": ["array", "null"]`).
    if type_includes_array(out.get("type")) && !out.contains_key("items") {
        out.insert("items".to_owned(), any_value_schema());
    }

    // Fallback `type` injection when schema lacks `type`, combinators, `$ref`, `enum`, and `const`
    let has_structural_type = out.contains_key("type")
        || out.contains_key("anyOf")
        || out.contains_key("oneOf")
        || out.contains_key("allOf")
        || out.contains_key("$ref")
        || out.contains_key("enum")
        || out.contains_key("const");

    if !has_structural_type {
        if prefer_object_fallback || out.contains_key("properties") || out.contains_key("required")
        {
            out.insert("type".to_owned(), Value::String("object".to_owned()));
            out.entry("properties".to_owned())
                .or_insert_with(|| Value::Object(Map::new()));
        } else {
            out.insert(
                "type".to_owned(),
                json!(["string", "number", "boolean", "object", "array", "null"]),
            );
        }
    } else if prefer_object_fallback
        && out.get("type") == Some(&Value::String("object".to_owned()))
        && !out.contains_key("properties")
    {
        out.insert("properties".to_owned(), Value::Object(Map::new()));
    }

    Value::Object(out)
}

fn collapse_schema_variants(variants: Vec<Value>) -> Value {
    if variants.is_empty() {
        return json!({
            "type": ["string", "number", "boolean", "object", "array", "null"]
        });
    }
    let mut deduped: Vec<Value> = Vec::with_capacity(variants.len());
    for v in variants {
        if !deduped.contains(&v) {
            deduped.push(v);
        }
    }
    if deduped.len() == 1 {
        deduped.into_iter().next().unwrap()
    } else {
        json!({ "anyOf": deduped })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn any() -> Value {
        any_value_schema()
    }

    #[test]
    fn boolean_sub_schemas_keep_their_meaning() {
        let schema = json!({
            "type": "object",
            "properties": { "never": false, "anything": true },
            "not": false,
            "additionalProperties": false,
            "anyOf": [true, { "type": "string" }]
        });
        let out = normalize_mcp_json_schema(&schema, true);
        assert_eq!(out["properties"]["never"], json!(false));
        assert_eq!(out["properties"]["anything"], json!(true));
        assert_eq!(out["not"], json!(false));
        assert_eq!(out["additionalProperties"], json!(false));
        assert_eq!(out["anyOf"], json!([true, { "type": "string" }]));
        // The root of a tool input schema still falls back to an object schema.
        assert_eq!(
            normalize_mcp_json_schema(&json!(true), true),
            json!({ "type": "object", "properties": {} })
        );
    }

    #[test]
    fn explicitly_open_tuples_allow_any_trailing_items() {
        let prefix_open = normalize_mcp_json_schema(
            &json!({ "type": "array", "prefixItems": [{ "type": "string" }], "items": true }),
            false,
        );
        assert_eq!(
            prefix_open["items"],
            json!({ "anyOf": [{ "type": "string" }, any()] })
        );
        assert!(prefix_open.get("maxItems").is_none(), "{prefix_open}");

        let draft07_open = normalize_mcp_json_schema(
            &json!({ "type": "array", "items": [{ "type": "integer" }], "additionalItems": true }),
            false,
        );
        assert_eq!(
            draft07_open["items"],
            json!({ "anyOf": [{ "type": "integer" }, any()] })
        );
        assert!(draft07_open.get("maxItems").is_none(), "{draft07_open}");

        // Closed tuples are unchanged: prefix types only, length bounded.
        let closed = normalize_mcp_json_schema(
            &json!({ "type": "array", "prefixItems": [{ "type": "string" }], "items": false }),
            false,
        );
        assert_eq!(closed["items"], json!({ "type": "string" }));
        assert_eq!(closed["maxItems"], json!(1));
    }

    #[test]
    fn nullable_arrays_get_a_default_items_schema() {
        let out = normalize_mcp_json_schema(&json!({ "type": ["array", "null"] }), false);
        assert_eq!(out["items"], any());
        let plain = normalize_mcp_json_schema(&json!({ "type": ["string", "null"] }), false);
        assert!(plain.get("items").is_none());
    }

    #[test]
    fn every_sub_schema_keyword_is_normalized() {
        let long = "x".repeat(MAX_MCP_DESCRIPTION_CHARS + 10);
        let nested = json!({ "description": long });
        let normalized_nested = normalize_mcp_json_schema(&nested, false);
        assert_eq!(
            normalized_nested["description"]
                .as_str()
                .unwrap()
                .chars()
                .count(),
            MAX_MCP_DESCRIPTION_CHARS + DESCRIPTION_TRUNCATION_SUFFIX.chars().count()
        );
        let schema = json!({
            "type": "object",
            "properties": {},
            "dependentSchemas": { "a": nested.clone() },
            "contains": nested.clone(),
            "if": nested.clone(),
            "then": nested.clone(),
            "else": false,
            "propertyNames": nested.clone(),
            "unevaluatedItems": nested.clone(),
            "unevaluatedProperties": false
        });
        let out = normalize_mcp_json_schema(&schema, true);
        assert_eq!(out["dependentSchemas"]["a"], normalized_nested);
        for key in [
            "contains",
            "if",
            "then",
            "propertyNames",
            "unevaluatedItems",
        ] {
            assert_eq!(out[key], normalized_nested, "{key}");
        }
        assert_eq!(out["else"], json!(false));
        assert_eq!(out["unevaluatedProperties"], json!(false));
    }
}
