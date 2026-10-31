use crate::context::{ToolError, ToolResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextEncoding {
    Utf8,
    Utf8Bom,
    Utf16LeBom,
    Utf16BeBom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineEnding {
    Lf,
    Crlf,
}

#[derive(Debug, Clone)]
pub struct DecodedTextBuffer {
    /// Text normalized to `\n` line endings without leading BOM.
    pub text: String,
    pub encoding: TextEncoding,
    pub dominant_eol: LineEnding,
}

pub fn detect_bom(bytes: &[u8]) -> (TextEncoding, usize) {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        (TextEncoding::Utf8Bom, 3)
    } else if bytes.starts_with(&[0xFF, 0xFE]) {
        (TextEncoding::Utf16LeBom, 2)
    } else if bytes.starts_with(&[0xFE, 0xFF]) {
        (TextEncoding::Utf16BeBom, 2)
    } else {
        (TextEncoding::Utf8, 0)
    }
}

pub fn looks_binary_without_utf16_bom(bytes: &[u8]) -> bool {
    let (enc, offset) = detect_bom(bytes);
    if matches!(enc, TextEncoding::Utf16LeBom | TextEncoding::Utf16BeBom) {
        return false;
    }
    let probe = &bytes[offset..bytes.len().min(offset + 8192)];
    probe.contains(&0)
}

pub fn decode_raw_text_preserving_eol(bytes: &[u8]) -> ToolResult<(String, TextEncoding)> {
    let (encoding, offset) = detect_bom(bytes);
    let body = &bytes[offset..];
    match encoding {
        TextEncoding::Utf8 | TextEncoding::Utf8Bom => {
            if body[..body.len().min(8192)].contains(&0) {
                return Err(ToolError::Execution(
                    "File appears to be binary (contains NUL bytes).".to_owned(),
                ));
            }
            let s = std::str::from_utf8(body)
                .map_err(|_| ToolError::Execution("File is not valid UTF-8 text.".to_owned()))?;
            Ok((s.to_owned(), encoding))
        }
        TextEncoding::Utf16LeBom => {
            if !body.len().is_multiple_of(2) {
                return Err(ToolError::Execution(
                    "Invalid UTF-16LE file (odd byte length).".to_owned(),
                ));
            }
            let units: Vec<u16> = body
                .as_chunks::<2>()
                .0
                .iter()
                .map(|c| u16::from_le_bytes(*c))
                .collect();
            let s = String::from_utf16(&units).map_err(|_| {
                ToolError::Execution("Invalid UTF-16LE surrogate sequence.".to_owned())
            })?;
            Ok((s, encoding))
        }
        TextEncoding::Utf16BeBom => {
            if !body.len().is_multiple_of(2) {
                return Err(ToolError::Execution(
                    "Invalid UTF-16BE file (odd byte length).".to_owned(),
                ));
            }
            let units: Vec<u16> = body
                .as_chunks::<2>()
                .0
                .iter()
                .map(|c| u16::from_be_bytes(*c))
                .collect();
            let s = String::from_utf16(&units).map_err(|_| {
                ToolError::Execution("Invalid UTF-16BE surrogate sequence.".to_owned())
            })?;
            Ok((s, encoding))
        }
    }
}

pub fn detect_dominant_eol(raw_text: &str) -> LineEnding {
    let mut crlf = 0usize;
    let mut bare_lf = 0usize;
    let bytes = raw_text.as_bytes();
    for i in 0..bytes.len() {
        if bytes[i] == b'\n' {
            if i > 0 && bytes[i - 1] == b'\r' {
                crlf += 1;
            } else {
                bare_lf += 1;
            }
        }
    }
    if crlf > 0 && crlf >= bare_lf {
        LineEnding::Crlf
    } else {
        LineEnding::Lf
    }
}

pub fn normalize_to_lf(text: &str) -> String {
    if !text.contains('\r') {
        return text.to_owned();
    }
    text.replace("\r\n", "\n").replace('\r', "\n")
}

pub fn apply_eol(lf_text: &str, eol: LineEnding) -> String {
    let normalized = normalize_to_lf(lf_text);
    match eol {
        LineEnding::Lf => normalized,
        LineEnding::Crlf => normalized.replace('\n', "\r\n"),
    }
}

pub fn decode_text_buffer(bytes: &[u8]) -> ToolResult<DecodedTextBuffer> {
    let (raw, encoding) = decode_raw_text_preserving_eol(bytes)?;
    let dominant_eol = detect_dominant_eol(&raw);
    let text = normalize_to_lf(&raw);
    Ok(DecodedTextBuffer {
        text,
        encoding,
        dominant_eol,
    })
}

pub fn encode_text_buffer(lf_text: &str, encoding: TextEncoding, eol: LineEnding) -> Vec<u8> {
    let with_eol = apply_eol(lf_text, eol);
    let text = with_eol.strip_prefix('\u{feff}').unwrap_or(&with_eol);
    match encoding {
        TextEncoding::Utf8 => text.as_bytes().to_vec(),
        TextEncoding::Utf8Bom => {
            let mut out = Vec::with_capacity(3 + text.len());
            out.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
            out.extend_from_slice(text.as_bytes());
            out
        }
        TextEncoding::Utf16LeBom => {
            let mut out = Vec::with_capacity(2 + text.len() * 2);
            out.extend_from_slice(&[0xFF, 0xFE]);
            for u in text.encode_utf16() {
                out.extend_from_slice(&u.to_le_bytes());
            }
            out
        }
        TextEncoding::Utf16BeBom => {
            let mut out = Vec::with_capacity(2 + text.len() * 2);
            out.extend_from_slice(&[0xFE, 0xFF]);
            for u in text.encode_utf16() {
                out.extend_from_slice(&u.to_be_bytes());
            }
            out
        }
    }
}

/// Literal replacement on LF-normalized text that never interprets `$1` / `$&`
/// and rejects ambiguous matches when `replace_all == false`.
pub fn replace_respecting_eol(
    lf_haystack: &str,
    old_string: &str,
    new_string: &str,
    replace_all: bool,
) -> ToolResult<(String, usize)> {
    let needle = normalize_to_lf(old_string);
    let replacement = normalize_to_lf(new_string);

    if needle.is_empty() {
        return Err(ToolError::InvalidArguments(
            "oldString must not be empty".to_owned(),
        ));
    }
    if needle == replacement {
        return Err(ToolError::InvalidArguments(
            "oldString and newString must be different".to_owned(),
        ));
    }

    let count = lf_haystack.matches(&needle).count();
    if count == 0 {
        return Err(ToolError::Execution(
            "oldString was not found in the file. Read the file again to get exact surrounding lines.".to_owned(),
        ));
    }
    if count > 1 && !replace_all {
        return Err(ToolError::Execution(format!(
            "oldString matched {count} locations. Include more surrounding lines to make oldString unique, or pass replaceAll: true."
        )));
    }

    let updated = if replace_all {
        lf_haystack.replace(&needle, &replacement)
    } else {
        lf_haystack.replacen(&needle, &replacement, 1)
    };
    Ok((updated, if replace_all { count } else { 1 }))
}
