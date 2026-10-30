use serde_json::{Map, Number, Value};

use crate::error::InferenceError;

/// Best-effort incremental parser for streaming JSON tool-call argument fragments.
///
/// Converts incomplete JSON prefixes such as `{"cmd": "ls -la` or `{"nested": {"flags": ["--all`
/// into valid `serde_json::Value` structures without any JavaScript runtime dependency, while
/// enforcing strict object validation on `finalize()`.
#[derive(Debug, Clone, Default)]
pub struct StreamingToolDeltaParser {
    buffer: String,
}

impl StreamingToolDeltaParser {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn buffer(&self) -> &str {
        &self.buffer
    }

    pub fn push_delta(&mut self, delta: &str) -> Map<String, Value> {
        self.buffer.push_str(delta);
        parse_partial_json_object(&self.buffer)
    }

    pub fn finalize(&self) -> Result<Map<String, Value>, InferenceError> {
        let trimmed = self.buffer.trim();
        if trimmed.is_empty() {
            return Ok(Map::new());
        }
        match serde_json::from_str::<Value>(trimmed) {
            Ok(Value::Object(map)) => Ok(map),
            Ok(_) => Err(InferenceError::InvalidToolArguments(
                "Tool call arguments must decode to a JSON object.".to_string(),
            )),
            Err(err) => Err(InferenceError::InvalidToolArguments(format!(
                "Invalid JSON tool call arguments: {err}"
            ))),
        }
    }
}

/// Parses a partial or complete JSON string into a best-effort JSON object (`{}` on non-object).
pub fn parse_partial_json_object(input: &str) -> Map<String, Value> {
    match parse_partial_json(input) {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

/// Parses a partial or complete JSON fragment into a best-effort `serde_json::Value`.
pub fn parse_partial_json(input: &str) -> Value {
    let trimmed = input.trim_start();
    if trimmed.is_empty() {
        return Value::Object(Map::new());
    }
    if let Ok(exact) = serde_json::from_str::<Value>(trimmed) {
        return exact;
    }

    let bytes = trimmed.as_bytes();
    let mut cursor = PartialCursor { bytes, pos: 0 };
    cursor
        .parse_value()
        .unwrap_or_else(|| Value::Object(Map::new()))
}

struct PartialCursor<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> PartialCursor<'a> {
    fn skip_ws(&mut self) {
        while self.pos < self.bytes.len() && self.bytes[self.pos].is_ascii_whitespace() {
            self.pos += 1;
        }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn parse_value(&mut self) -> Option<Value> {
        self.skip_ws();
        let b = self.peek()?;
        match b {
            b'{' => Some(Value::Object(self.parse_object())),
            b'[' => Some(Value::Array(self.parse_array())),
            b'"' => Some(Value::String(self.parse_string())),
            b't' => self.parse_keyword_prefix(b"true", Value::Bool(true)),
            b'f' => self.parse_keyword_prefix(b"false", Value::Bool(false)),
            b'n' => self.parse_keyword_prefix(b"null", Value::Null),
            b'-' | b'0'..=b'9' => self.parse_number(),
            _ => None,
        }
    }

    fn parse_object(&mut self) -> Map<String, Value> {
        let mut map = Map::new();
        self.pos += 1; // '{'
        loop {
            self.skip_ws();
            match self.peek() {
                None => break,
                Some(b'}') => {
                    self.pos += 1;
                    break;
                }
                Some(b',') => {
                    self.pos += 1;
                    continue;
                }
                Some(b'"') => {
                    let key = self.parse_string();
                    self.skip_ws();
                    match self.peek() {
                        Some(b':') => {
                            self.pos += 1;
                            if let Some(val) = self.parse_value() {
                                map.insert(key, val);
                            } else {
                                break;
                            }
                        }
                        _ => {
                            // Key not yet followed by ':' — wait for more streaming bytes.
                            break;
                        }
                    }
                }
                Some(_) => break,
            }
        }
        map
    }

    fn parse_array(&mut self) -> Vec<Value> {
        let mut items = Vec::new();
        self.pos += 1; // '['
        loop {
            self.skip_ws();
            match self.peek() {
                None => break,
                Some(b']') => {
                    self.pos += 1;
                    break;
                }
                Some(b',') => {
                    self.pos += 1;
                    continue;
                }
                Some(_) => {
                    if let Some(val) = self.parse_value() {
                        items.push(val);
                    } else {
                        break;
                    }
                }
            }
        }
        items
    }

    fn parse_string(&mut self) -> String {
        self.pos += 1; // opening '"'
        let mut out = String::new();
        let src = std::str::from_utf8(&self.bytes[self.pos..]).unwrap_or_default();
        let mut chars = src.char_indices();

        while let Some((byte_idx, ch)) = chars.next() {
            if ch == '"' {
                self.pos += byte_idx + 1;
                return out;
            }
            if ch == '\\' {
                let Some((esc_idx, esc)) = chars.next() else {
                    // Trailing backslash at end of stream; drop incomplete escape.
                    self.pos = self.bytes.len();
                    return out;
                };
                match esc {
                    '"' => out.push('"'),
                    '\\' => out.push('\\'),
                    '/' => out.push('/'),
                    'b' => out.push('\u{0008}'),
                    'f' => out.push('\u{000C}'),
                    'n' => out.push('\n'),
                    'r' => out.push('\r'),
                    't' => out.push('\t'),
                    'u' => {
                        let rest = &src[esc_idx + 1..];
                        if rest.len() < 4 {
                            self.pos = self.bytes.len();
                            return out;
                        }
                        let hex_slice = &rest[..4];
                        if let Ok(code) = u16::from_str_radix(hex_slice, 16)
                            && let Some(decoded) = char::from_u32(u32::from(code))
                        {
                            out.push(decoded);
                        }
                        for _ in 0..4 {
                            let _ = chars.next();
                        }
                    }
                    other => out.push(other),
                }
            } else {
                out.push(ch);
            }
        }

        // Unclosed string at end of streaming delta.
        self.pos = self.bytes.len();
        out
    }

    fn parse_keyword_prefix(&mut self, target: &[u8], value: Value) -> Option<Value> {
        let remaining = &self.bytes[self.pos..];
        let cmp_len = remaining.len().min(target.len());
        if remaining[..cmp_len] == target[..cmp_len] {
            self.pos += cmp_len;
            Some(value)
        } else {
            None
        }
    }

    fn parse_number(&mut self) -> Option<Value> {
        let start = self.pos;
        while self.pos < self.bytes.len() {
            let b = self.bytes[self.pos];
            if b.is_ascii_digit() || matches!(b, b'-' | b'+' | b'.' | b'e' | b'E') {
                self.pos += 1;
            } else {
                break;
            }
        }
        let mut raw = std::str::from_utf8(&self.bytes[start..self.pos]).ok()?;
        raw = raw.trim_end_matches(['.', 'e', 'E', '+', '-']);
        if raw.is_empty() || raw == "-" {
            return None;
        }
        if let Ok(int_val) = raw.parse::<i64>() {
            return Some(Value::Number(Number::from(int_val)));
        }
        if let Ok(uint_val) = raw.parse::<u64>() {
            return Some(Value::Number(Number::from(uint_val)));
        }
        let float_val = raw.parse::<f64>().ok()?;
        Some(Value::Number(Number::from_f64(float_val)?))
    }
}
