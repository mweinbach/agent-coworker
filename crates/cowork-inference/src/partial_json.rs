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
    let mut cursor = PartialCursor {
        bytes,
        pos: 0,
        depth: 0,
    };
    cursor
        .parse_value()
        .unwrap_or_else(|| Value::Object(Map::new()))
}

/// Maximum container nesting the fallback parser follows. Bounds recursion so malformed input
/// such as thousands of `[` cannot overflow the stack (matches `serde_json`'s default limit).
const MAX_PARTIAL_DEPTH: usize = 128;

struct PartialCursor<'a> {
    bytes: &'a [u8],
    pos: usize,
    depth: usize,
}

enum HexEscape {
    Value(u32),
    Incomplete,
    Invalid,
}

enum LowSurrogate {
    Value(u32),
    /// Input ends before a following escape could be fully read.
    Incomplete,
    /// Followed by something that is not a low-surrogate escape.
    Missing,
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
            b'{' | b'[' => {
                if self.depth >= MAX_PARTIAL_DEPTH {
                    return None;
                }
                self.depth += 1;
                let value = if b == b'{' {
                    Value::Object(self.parse_object())
                } else {
                    Value::Array(self.parse_array())
                };
                self.depth -= 1;
                Some(value)
            }
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

    /// Parses a (possibly unterminated) JSON string starting at the opening quote.
    ///
    /// Works on bytes and only slices at ASCII delimiters (`"` and `\`), so malformed or
    /// truncated escapes in streamed input can never split a multibyte character. Mirrors the
    /// TS `partial-json` behavior for bad escapes: the string is truncated at the escape and the
    /// rest of the input is treated as not yet received.
    fn parse_string(&mut self) -> String {
        self.pos += 1; // opening '"'
        let mut out = String::new();
        let mut run_start = self.pos;

        while let Some(b) = self.peek() {
            match b {
                b'"' => {
                    self.push_run(&mut out, run_start);
                    self.pos += 1;
                    return out;
                }
                b'\\' => {
                    self.push_run(&mut out, run_start);
                    if !self.parse_escape(&mut out) {
                        // Truncated or invalid escape: stop at it and wait for more bytes.
                        self.pos = self.bytes.len();
                        return out;
                    }
                    run_start = self.pos;
                }
                _ => self.pos += 1,
            }
        }

        // Unclosed string at end of streaming delta.
        self.push_run(&mut out, run_start);
        out
    }

    /// Appends the unescaped bytes in `start..self.pos`. Both ends sit on ASCII delimiters or the
    /// end of the input, so the run is always whole UTF-8; the lossy decode is only a fallback.
    fn push_run(&self, out: &mut String, start: usize) {
        if let Some(run) = self.bytes.get(start..self.pos) {
            out.push_str(&String::from_utf8_lossy(run));
        }
    }

    /// Decodes the escape at `self.pos` (a backslash) into `out` and advances past it.
    /// Returns `false` when the escape is truncated or invalid.
    fn parse_escape(&mut self, out: &mut String) -> bool {
        let Some(esc) = self.bytes.get(self.pos + 1).copied() else {
            return false;
        };
        let decoded = match esc {
            b'"' => '"',
            b'\\' => '\\',
            b'/' => '/',
            b'b' => '\u{0008}',
            b'f' => '\u{000C}',
            b'n' => '\n',
            b'r' => '\r',
            b't' => '\t',
            b'u' => return self.parse_unicode_escape(out),
            _ => return false,
        };
        out.push(decoded);
        self.pos += 2;
        true
    }

    /// Decodes `\uXXXX` (and a following low surrogate for a high one) at `self.pos`.
    fn parse_unicode_escape(&mut self, out: &mut String) -> bool {
        let HexEscape::Value(code) = self.read_hex4(self.pos + 2) else {
            return false;
        };
        let after = self.pos + 6;
        let decoded = match code {
            0xD800..=0xDBFF => match self.read_low_surrogate(after) {
                LowSurrogate::Value(low) => {
                    self.pos = after + 6;
                    let combined = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00);
                    out.push(char::from_u32(combined).unwrap_or(char::REPLACEMENT_CHARACTER));
                    return true;
                }
                // The low half may still be streaming in; drop the high half for now.
                LowSurrogate::Incomplete => return false,
                LowSurrogate::Missing => char::REPLACEMENT_CHARACTER,
            },
            // Lone low surrogate.
            0xDC00..=0xDFFF => char::REPLACEMENT_CHARACTER,
            _ => char::from_u32(code).unwrap_or(char::REPLACEMENT_CHARACTER),
        };
        out.push(decoded);
        self.pos = after;
        true
    }

    /// Reads four ASCII hex digits starting at byte `start` without slicing the input.
    fn read_hex4(&self, start: usize) -> HexEscape {
        let mut value = 0u32;
        for offset in 0..4 {
            let Some(&b) = self.bytes.get(start + offset) else {
                return HexEscape::Incomplete;
            };
            let Some(digit) = char::from(b).to_digit(16) else {
                return HexEscape::Invalid;
            };
            value = value * 16 + digit;
        }
        HexEscape::Value(value)
    }

    /// Looks for a `\uDC00`-`\uDFFF` escape at byte `start`, following a high surrogate.
    fn read_low_surrogate(&self, start: usize) -> LowSurrogate {
        match self.bytes.get(start) {
            None => return LowSurrogate::Incomplete,
            Some(b'\\') => {}
            Some(_) => return LowSurrogate::Missing,
        }
        match self.bytes.get(start + 1) {
            None => return LowSurrogate::Incomplete,
            Some(b'u') => {}
            Some(_) => return LowSurrogate::Missing,
        }
        match self.read_hex4(start + 2) {
            HexEscape::Value(low @ 0xDC00..=0xDFFF) => LowSurrogate::Value(low),
            HexEscape::Incomplete => LowSurrogate::Incomplete,
            HexEscape::Value(_) | HexEscape::Invalid => LowSurrogate::Missing,
        }
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
