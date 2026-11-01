//! Insertion-ordered JSON values serialized with JavaScript `JSON.stringify` semantics.
//!
//! The TypeScript importer derived conversation fingerprints and generated item ids by hashing
//! `JSON.stringify` output of values that came from `JSON.parse`. Those hashes are persisted as
//! the `(source, fingerprint)` dedupe key, so reproducing them byte-for-byte requires
//! JavaScript property order (array-index keys ascending, then the remaining keys in insertion
//! order, duplicate keys keeping their first position and last value) and JavaScript number
//! formatting. `serde_json::Value` sorts object keys (the workspace does not enable
//! `preserve_order`), so the importer parses source records into [`JsJson`] and only converts
//! to `serde_json::Value` for the parts that never reach a hash.

use std::collections::HashMap;
use std::fmt;

use serde::de::{Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Number, Value};

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum JsJson {
    Null,
    Bool(bool),
    Number(Number),
    String(String),
    Array(Vec<JsJson>),
    Object(Vec<(String, JsJson)>),
}

impl JsJson {
    /// `JSON.parse`, returning `None` where it would throw.
    pub(crate) fn parse(text: &str) -> Option<Self> {
        serde_json::from_str(text).ok()
    }

    pub(crate) fn get(&self, key: &str) -> Option<&JsJson> {
        match self {
            Self::Object(entries) => entries.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    pub(crate) fn as_str(&self) -> Option<&str> {
        match self {
            Self::String(s) => Some(s),
            _ => None,
        }
    }

    pub(crate) fn as_array(&self) -> Option<&[JsJson]> {
        match self {
            Self::Array(items) => Some(items),
            _ => None,
        }
    }

    pub(crate) fn is_object(&self) -> bool {
        matches!(self, Self::Object(_))
    }

    pub(crate) fn is_null(&self) -> bool {
        matches!(self, Self::Null)
    }

    pub(crate) fn to_value(&self) -> Value {
        match self {
            Self::Null => Value::Null,
            Self::Bool(b) => Value::Bool(*b),
            Self::Number(n) => Value::Number(n.clone()),
            Self::String(s) => Value::String(s.clone()),
            Self::Array(items) => Value::Array(items.iter().map(Self::to_value).collect()),
            Self::Object(entries) => {
                let mut map = Map::new();
                for (k, v) in entries {
                    map.insert(k.clone(), v.to_value());
                }
                Value::Object(map)
            }
        }
    }

    /// `JSON.stringify(value)`.
    pub(crate) fn stringify(&self) -> String {
        let mut out = String::new();
        self.write_to(&mut out);
        out
    }

    pub(crate) fn write_to(&self, out: &mut String) {
        match self {
            Self::Null => out.push_str("null"),
            Self::Bool(true) => out.push_str("true"),
            Self::Bool(false) => out.push_str("false"),
            Self::Number(n) => write_js_number(out, n.as_f64().unwrap_or(f64::NAN)),
            Self::String(s) => write_js_string(out, s),
            Self::Array(items) => {
                out.push('[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    item.write_to(out);
                }
                out.push(']');
            }
            Self::Object(entries) => {
                // OrdinaryOwnPropertyKeys: array indices ascending, then string keys in
                // creation order.
                let mut indexed: Vec<(u32, &(String, JsJson))> = entries
                    .iter()
                    .filter_map(|entry| array_index(&entry.0).map(|i| (i, entry)))
                    .collect();
                indexed.sort_by_key(|(i, _)| *i);
                let named = entries.iter().filter(|(k, _)| array_index(k).is_none());
                out.push('{');
                for (i, (k, v)) in indexed.into_iter().map(|(_, e)| e).chain(named).enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    write_js_string(out, k);
                    out.push(':');
                    v.write_to(out);
                }
                out.push('}');
            }
        }
    }
}

/// JavaScript `String(value)` for a JSON value (`undefined` is the caller's concern).
pub(crate) fn js_string_coerce(value: &JsJson) -> String {
    match value {
        JsJson::Null => "null".to_owned(),
        JsJson::Bool(b) => b.to_string(),
        JsJson::Number(n) => {
            let mut out = String::new();
            write_js_number(&mut out, n.as_f64().unwrap_or(f64::NAN));
            out
        }
        JsJson::String(s) => s.clone(),
        // Array.prototype.join renders null/undefined elements as empty strings.
        JsJson::Array(items) => items
            .iter()
            .map(|item| {
                if item.is_null() {
                    String::new()
                } else {
                    js_string_coerce(item)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        JsJson::Object(_) => "[object Object]".to_owned(),
    }
}

/// Canonical array-index property key (`0..=2^32 - 2`, no leading zeros).
fn array_index(key: &str) -> Option<u32> {
    let bytes = key.as_bytes();
    if bytes.is_empty() || bytes.len() > 10 || !bytes.iter().all(u8::is_ascii_digit) {
        return None;
    }
    if bytes.len() > 1 && bytes[0] == b'0' {
        return None;
    }
    key.parse::<u64>()
        .ok()
        .filter(|n| *n < u64::from(u32::MAX))
        .map(|n| n as u32)
}

/// `JSON.stringify` string quoting (`QuoteJSONString`). Rust strings cannot hold lone
/// surrogates, the only other code points JavaScript escapes.
pub(crate) fn write_js_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{09}' => out.push_str("\\t"),
            '\u{0a}' => out.push_str("\\n"),
            '\u{0c}' => out.push_str("\\f"),
            '\u{0d}' => out.push_str("\\r"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// `Number.prototype.toString()` as used by `JSON.stringify` (non-finite values become `null`).
pub(crate) fn write_js_number(out: &mut String, n: f64) {
    if !n.is_finite() {
        out.push_str("null");
        return;
    }
    if n == 0.0 {
        // Covers -0, which JavaScript prints as "0".
        out.push('0');
        return;
    }
    if n < 0.0 {
        out.push('-');
    }
    // Rust's `{:e}` prints the shortest round-tripping digits, like ECMAScript's
    // Number::toString, as `d[.ddd]e<exp>`.
    let sci = format!("{:e}", n.abs());
    let (mantissa, exp) = sci.split_once('e').unwrap_or((sci.as_str(), "0"));
    let exp: i32 = exp.parse().unwrap_or(0);
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let point = exp + 1;
    if k <= point && point <= 21 {
        out.push_str(&digits);
        out.extend(std::iter::repeat_n('0', (point - k) as usize));
    } else if 0 < point && point <= 21 {
        let (int, frac) = digits.split_at(point as usize);
        out.push_str(int);
        out.push('.');
        out.push_str(frac);
    } else if -6 < point && point <= 0 {
        out.push_str("0.");
        out.extend(std::iter::repeat_n('0', (-point) as usize));
        out.push_str(&digits);
    } else {
        let (first, rest) = digits.split_at(1);
        out.push_str(first);
        if !rest.is_empty() {
            out.push('.');
            out.push_str(rest);
        }
        let e = point - 1;
        out.push('e');
        out.push(if e >= 0 { '+' } else { '-' });
        out.push_str(&e.abs().to_string());
    }
}

/// Builds a `JSON.stringify` object literal with explicit key order, for the object literals
/// the TypeScript importer hashed. Keys must not be array indices.
pub(crate) struct JsObjectWriter {
    buf: String,
    empty: bool,
}

impl JsObjectWriter {
    pub(crate) fn new() -> Self {
        Self {
            buf: String::from("{"),
            empty: true,
        }
    }

    fn key(&mut self, key: &str) -> &mut String {
        debug_assert!(array_index(key).is_none());
        if !self.empty {
            self.buf.push(',');
        }
        self.empty = false;
        write_js_string(&mut self.buf, key);
        self.buf.push(':');
        &mut self.buf
    }

    pub(crate) fn str(&mut self, key: &str, value: &str) -> &mut Self {
        write_js_string(self.key(key), value);
        self
    }

    pub(crate) fn null(&mut self, key: &str) -> &mut Self {
        self.key(key).push_str("null");
        self
    }

    pub(crate) fn number(&mut self, key: &str, value: f64) -> &mut Self {
        write_js_number(self.key(key), value);
        self
    }

    pub(crate) fn js(&mut self, key: &str, value: &JsJson) -> &mut Self {
        value.write_to(self.key(key));
        self
    }

    /// Inserts an already serialized JSON value.
    pub(crate) fn raw(&mut self, key: &str, json: &str) -> &mut Self {
        self.key(key).push_str(json);
        self
    }

    pub(crate) fn finish(&mut self) -> String {
        let mut out = std::mem::take(&mut self.buf);
        out.push('}');
        out
    }
}

impl<'de> Deserialize<'de> for JsJson {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(JsJsonVisitor)
    }
}

struct JsJsonVisitor;

impl<'de> Visitor<'de> for JsJsonVisitor {
    type Value = JsJson;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("any JSON value")
    }

    fn visit_bool<E>(self, v: bool) -> Result<JsJson, E> {
        Ok(JsJson::Bool(v))
    }

    fn visit_i64<E>(self, v: i64) -> Result<JsJson, E> {
        Ok(JsJson::Number(v.into()))
    }

    fn visit_u64<E>(self, v: u64) -> Result<JsJson, E> {
        Ok(JsJson::Number(v.into()))
    }

    fn visit_f64<E>(self, v: f64) -> Result<JsJson, E> {
        Ok(Number::from_f64(v).map_or(JsJson::Null, JsJson::Number))
    }

    fn visit_str<E>(self, v: &str) -> Result<JsJson, E> {
        Ok(JsJson::String(v.to_owned()))
    }

    fn visit_string<E>(self, v: String) -> Result<JsJson, E> {
        Ok(JsJson::String(v))
    }

    fn visit_unit<E>(self) -> Result<JsJson, E> {
        Ok(JsJson::Null)
    }

    fn visit_none<E>(self) -> Result<JsJson, E> {
        Ok(JsJson::Null)
    }

    fn visit_some<D: Deserializer<'de>>(self, deserializer: D) -> Result<JsJson, D::Error> {
        JsJson::deserialize(deserializer)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<JsJson, A::Error> {
        let mut items = Vec::with_capacity(seq.size_hint().unwrap_or(0));
        while let Some(item) = seq.next_element()? {
            items.push(item);
        }
        Ok(JsJson::Array(items))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<JsJson, A::Error> {
        let mut entries: Vec<(String, JsJson)> = Vec::new();
        let mut positions: HashMap<String, usize> = HashMap::new();
        while let Some((key, value)) = map.next_entry::<String, JsJson>()? {
            // JSON.parse: a repeated key keeps its original position and takes the last value.
            if let Some(&pos) = positions.get(&key) {
                entries[pos].1 = value;
            } else {
                positions.insert(key.clone(), entries.len());
                entries.push((key, value));
            }
        }
        Ok(JsJson::Object(entries))
    }
}
