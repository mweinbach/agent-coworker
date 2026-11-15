//! LaTeX math delimiter scanning and KaTeX raster rendering matching Electron's
//! `@streamdown/math` (`singleDollarTextMath: false`) and streaming fallbacks.

use std::borrow::Cow;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, OnceLock, mpsc};

use katex_native::katex::KatexContext;
use katex_native::raster::rasterize;
use katex_native::{Color as KatexColor, Layout as KatexLayout};
use rune::{Align, Color, Cursor, El, Pixels, Span, TextStyle, Tx, col, el, row, text};
use rune_kit::Kit;

use crate::state::AppState;
use crate::theme::ThemeTokens;

const DISPLAY_EM_PT: f32 = 16.5;
const INLINE_EM_PT: f32 = 15.0;
const DEFAULT_RENDER_SCALE: f32 = 2.0;
const MAX_CACHE_ENTRIES: usize = 512;

/// A top-level segment produced by scanning Markdown for fenced display math.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MathBlockSegment {
    /// Standard Markdown block content (may still contain inline `$$...$$`).
    Markdown(String),
    /// Fenced multi-line display math (`$$\n...\n$$`).
    DisplayMath(String),
    /// Unclosed fenced display math at EOF while streaming (`$$\n...`).
    StreamingMath(String),
}

/// An inline run within a non-display-block Markdown slice.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InlineMathPart {
    /// Literal Markdown / plain text (includes code spans, code blocks, `$5` prices).
    Text(String),
    /// Closed inline math (`$$...$$`).
    Math(String),
    /// Unclosed trailing math (`$$...`) at EOF while streaming.
    StreamingMath(String),
}

/// Shared line-level state tracking CommonMark fenced and indented code blocks.
#[derive(Debug, Default)]
struct CodeBlockTracker {
    fence: Option<(u8, usize)>,
    prev_was_blank: bool,
    in_indented_code: bool,
    in_list_context: bool,
}

impl CodeBlockTracker {
    /// Advances state across one full line (including trailing `\n` if any) and
    /// returns `true` if this line belongs to a fenced or indented code block.
    fn step_line(&mut self, line: &str) -> bool {
        let stripped = trim_line_end(line);

        if let Some((ch, min_len)) = self.fence {
            if is_fence_closer(stripped, ch, min_len) {
                self.fence = None;
            }
            self.prev_was_blank = false;
            self.in_indented_code = false;
            return true;
        }

        if is_blank_line(stripped) {
            self.prev_was_blank = true;
            return false;
        }

        if !self.in_indented_code
            && let Some((ch, len)) = parse_fence_opener(stripped)
        {
            self.fence = Some((ch, len));
            self.prev_was_blank = false;
            self.in_list_context = false;
            return true;
        }

        let is_indented = starts_with_indented_code(stripped);
        if self.in_indented_code {
            if is_indented {
                self.prev_was_blank = false;
                return true;
            }
            self.in_indented_code = false;
        } else if is_indented && !self.in_list_context && self.prev_was_blank {
            self.in_indented_code = true;
            self.prev_was_blank = false;
            return true;
        }

        self.in_list_context = is_list_item_line(stripped) || (self.in_list_context && is_indented);
        self.prev_was_blank = false;
        false
    }

    fn new() -> Self {
        Self {
            fence: None,
            prev_was_blank: true,
            in_indented_code: false,
            in_list_context: false,
        }
    }
}

fn trim_line_end(line: &str) -> &str {
    line.trim_end_matches(['\n', '\r'])
}

fn is_blank_line(stripped: &str) -> bool {
    stripped.bytes().all(|b| b == b' ' || b == b'\t')
}

fn leading_spaces_up_to_3(s: &str) -> Option<(usize, &str)> {
    let bytes = s.as_bytes();
    let mut spaces = 0;
    while spaces < bytes.len() && bytes[spaces] == b' ' {
        spaces += 1;
        if spaces > 3 {
            return None;
        }
    }
    if bytes.get(spaces) == Some(&b'\t') {
        return None;
    }
    Some((spaces, &s[spaces..]))
}

fn starts_with_indented_code(stripped: &str) -> bool {
    leading_spaces_up_to_3(stripped).is_none()
}

fn parse_fence_opener(stripped: &str) -> Option<(u8, usize)> {
    let (_, rest) = leading_spaces_up_to_3(stripped)?;
    let bytes = rest.as_bytes();
    let ch = *bytes.first()?;
    if ch != b'`' && ch != b'~' {
        return None;
    }
    let count = bytes.iter().take_while(|&&b| b == ch).count();
    if count < 3 {
        return None;
    }
    if ch == b'`' && bytes[count..].contains(&b'`') {
        return None;
    }
    Some((ch, count))
}

fn is_fence_closer(stripped: &str, ch: u8, min_len: usize) -> bool {
    let Some((_, rest)) = leading_spaces_up_to_3(stripped) else {
        return false;
    };
    let bytes = rest.as_bytes();
    let count = bytes.iter().take_while(|&&b| b == ch).count();
    count >= min_len && bytes[count..].iter().all(|&b| b == b' ' || b == b'\t')
}

fn is_list_item_line(stripped: &str) -> bool {
    let trimmed = stripped.trim_start_matches(' ');
    if trimmed.starts_with("- ")
        || trimmed.starts_with("* ")
        || trimmed.starts_with("+ ")
        || trimmed == "-"
        || trimmed == "*"
        || trimmed == "+"
    {
        return true;
    }
    let digits = trimmed.bytes().take_while(|b| b.is_ascii_digit()).count();
    if (1..=9).contains(&digits) {
        let after = &trimmed.as_bytes()[digits..];
        if let Some(&delim) = after.first()
            && (delim == b'.' || delim == b')')
            && matches!(after.get(1), None | Some(b' ') | Some(b'\t'))
        {
            return true;
        }
    }
    false
}

/// Checks if a single line (trailing newline stripped) opens or closes a display `$$` block.
/// Matches CommonMark/remark-math flow math: 0..=3 leading spaces, `$$`, optional horizontal whitespace.
fn parse_display_math_fence(stripped: &str) -> Option<usize> {
    let (indent, rest) = leading_spaces_up_to_3(stripped)?;
    let after = rest.strip_prefix("$$")?;
    if after.bytes().all(|b| b == b' ' || b == b'\t') {
        Some(indent)
    } else {
        None
    }
}

fn normalize_newlines(src: &str) -> Cow<'_, str> {
    if src.contains('\r') {
        Cow::Owned(src.replace("\r\n", "\n").replace('\r', "\n"))
    } else {
        Cow::Borrowed(src)
    }
}

fn strip_leading_up_to(line: &str, max_spaces: usize) -> &str {
    let mut n = 0;
    let bytes = line.as_bytes();
    while n < max_spaces && n < bytes.len() && bytes[n] == b' ' {
        n += 1;
    }
    &line[n..]
}

fn flush_markdown(md_buf: &mut String, out: &mut Vec<MathBlockSegment>) {
    if !md_buf.is_empty() {
        out.push(MathBlockSegment::Markdown(std::mem::take(md_buf)));
    }
}

/// Splits `src` into Markdown chunks and top-level fenced display math blocks (`$$\n...\n$$`).
///
/// Mirrors `@streamdown/math` (`singleDollarTextMath: false`):
/// - Skips fenced and indented code blocks verbatim.
/// - Single `$` never triggers math.
/// - Single-line `$$...$$` stays in `Markdown` so paragraph-level inline math handles it.
/// - Unclosed `$$\n...` at EOF emits `StreamingMath` when `streaming` is `true`, otherwise stays literal Markdown.
pub fn split_math_blocks(src: &str, streaming: bool) -> Vec<MathBlockSegment> {
    if src.is_empty() {
        return Vec::new();
    }
    if !src.contains("$$") {
        return vec![MathBlockSegment::Markdown(src.to_string())];
    }

    let normalized = normalize_newlines(src);
    let mut out = Vec::new();
    let mut md_buf = String::new();
    let mut tracker = CodeBlockTracker::new();

    struct OpenBlock {
        indent: usize,
        raw_lines: String,
        body_lines: Vec<String>,
    }
    let mut open_math: Option<OpenBlock> = None;

    for line in normalized.split_inclusive('\n') {
        if let Some(mut open) = open_math.take() {
            let stripped = trim_line_end(line);
            if parse_display_math_fence(stripped).is_some() {
                flush_markdown(&mut md_buf, &mut out);
                let body = open.body_lines.concat();
                let body = body.trim_end_matches('\n').to_string();
                out.push(MathBlockSegment::DisplayMath(body));
            } else {
                open.raw_lines.push_str(line);
                open.body_lines
                    .push(strip_leading_up_to(line, open.indent).to_string());
                open_math = Some(open);
            }
            continue;
        }

        let is_code_before_fence = tracker.fence.is_some();
        let in_code = tracker.step_line(line);
        if !in_code && !is_code_before_fence {
            let stripped = trim_line_end(line);
            if let Some(indent) = parse_display_math_fence(stripped) {
                open_math = Some(OpenBlock {
                    indent,
                    raw_lines: line.to_string(),
                    body_lines: Vec::new(),
                });
                continue;
            }
        }
        md_buf.push_str(line);
    }

    if let Some(open) = open_math {
        if streaming {
            flush_markdown(&mut md_buf, &mut out);
            let body = open.body_lines.concat();
            let body = body.trim_end_matches('\n').to_string();
            out.push(MathBlockSegment::StreamingMath(body));
        } else {
            md_buf.push_str(&open.raw_lines);
        }
    }

    flush_markdown(&mut md_buf, &mut out);
    out
}

fn push_inline_text(out: &mut Vec<InlineMathPart>, s: &str) {
    if s.is_empty() {
        return;
    }
    if let Some(InlineMathPart::Text(prev)) = out.last_mut() {
        prev.push_str(s);
    } else {
        out.push(InlineMathPart::Text(s.to_string()));
    }
}

fn find_closing_backticks(bytes: &[u8], start: usize, count: usize) -> Option<usize> {
    let mut j = start;
    while j < bytes.len() {
        if bytes[j] == b'\n' {
            // Two consecutive newlines (with optional horizontal space) terminate the paragraph.
            let mut k = j + 1;
            while k < bytes.len() && (bytes[k] == b' ' || bytes[k] == b'\t') {
                k += 1;
            }
            if bytes.get(k) == Some(&b'\n') {
                return None;
            }
            j += 1;
            continue;
        }
        if bytes[j] == b'`' {
            let run = bytes[j..].iter().take_while(|&&b| b == b'`').count();
            if run == count {
                return Some(j + run);
            }
            j += run;
            continue;
        }
        j += 1;
    }
    None
}

/// Searches for a closing `$$` inside the current paragraph (stops at blank lines).
fn find_closing_inline_math(s: &str, start: usize) -> Option<(usize, usize)> {
    let bytes = s.as_bytes();
    let mut j = start;
    while j + 1 < bytes.len() {
        if bytes[j] == b'\n' {
            let mut k = j + 1;
            while k < bytes.len() && (bytes[k] == b' ' || bytes[k] == b'\t') {
                k += 1;
            }
            if bytes.get(k) == Some(&b'\n') {
                return None;
            }
            j += 1;
            continue;
        }
        if bytes[j] == b'$' && bytes[j + 1] == b'$' {
            return Some((j, j + 2));
        }
        j += 1;
    }
    None
}

fn crosses_blank_line(s: &str) -> bool {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\n' {
            let mut k = i + 1;
            while k < bytes.len() && (bytes[k] == b' ' || bytes[k] == b'\t') {
                k += 1;
            }
            if bytes.get(k) == Some(&b'\n') {
                return true;
            }
        }
        i += 1;
    }
    false
}

/// Splits a non-display-block Markdown slice into literal text and inline `$$...$$` runs.
///
/// Mirrors `@streamdown/math` (`singleDollarTextMath: false`):
/// - Fenced and indented code blocks, inline backtick code spans, and backslash escapes (`\$$`) are ignored.
/// - Single `$...$` and bare `$5` prices stay literal text.
/// - Unclosed trailing `$$x + ` at EOF becomes `StreamingMath` only when `streaming` is `true` and non-empty.
pub fn split_inline_math(src: &str, streaming: bool) -> Vec<InlineMathPart> {
    if src.is_empty() {
        return Vec::new();
    }
    if !src.contains("$$") {
        return vec![InlineMathPart::Text(src.to_string())];
    }

    let normalized = normalize_newlines(src);
    let s = normalized.as_ref();
    let bytes = s.as_bytes();
    let mut out = Vec::new();
    let mut tracker = CodeBlockTracker::new();
    let mut i = 0;

    while i < bytes.len() {
        let at_line_start = i == 0 || bytes[i - 1] == b'\n';
        if at_line_start {
            let line_end = bytes[i..]
                .iter()
                .position(|&b| b == b'\n')
                .map_or(bytes.len(), |off| i + off + 1);
            let line = &s[i..line_end];
            if tracker.step_line(line) {
                push_inline_text(&mut out, line);
                i = line_end;
                continue;
            }
            if line
                .trim_end_matches('\n')
                .bytes()
                .all(|b| b == b' ' || b == b'\t')
            {
                push_inline_text(&mut out, line);
                i = line_end;
                continue;
            }
        }

        match bytes[i] {
            b'`' => {
                let count = bytes[i..].iter().take_while(|&&b| b == b'`').count();
                if let Some(close_end) = find_closing_backticks(bytes, i + count, count) {
                    push_inline_text(&mut out, &s[i..close_end]);
                    i = close_end;
                } else {
                    push_inline_text(&mut out, &s[i..i + count]);
                    i += count;
                }
            }
            b'\\' => {
                if i + 1 < bytes.len() {
                    let ch_len = s[i + 1..].chars().next().map_or(1, char::len_utf8);
                    let end = i + 1 + ch_len;
                    push_inline_text(&mut out, &s[i..end]);
                    i = end;
                } else {
                    push_inline_text(&mut out, "\\");
                    i += 1;
                }
            }
            b'$' if bytes.get(i + 1) == Some(&b'$') => {
                if let Some((close_start, close_end)) = find_closing_inline_math(s, i + 2) {
                    let tex = &s[i + 2..close_start];
                    if tex.is_empty() {
                        // Treat empty `$$$$` as literal text rather than an empty formula box.
                        push_inline_text(&mut out, &s[i..close_end]);
                    } else {
                        out.push(InlineMathPart::Math(tex.to_string()));
                    }
                    // If inline math crossed a newline inside a paragraph, keep line-start tracker clean.
                    if tex.contains('\n') {
                        tracker.prev_was_blank = false;
                        tracker.in_indented_code = false;
                    }
                    i = close_end;
                } else {
                    let tail = &s[i + 2..];
                    if streaming && !tail.trim().is_empty() && !crosses_blank_line(tail) {
                        out.push(InlineMathPart::StreamingMath(tail.to_string()));
                        i = bytes.len();
                    } else {
                        push_inline_text(&mut out, "$$");
                        i += 2;
                    }
                }
            }
            _ => {
                let ch_len = s[i..].chars().next().map_or(1, char::len_utf8);
                push_inline_text(&mut out, &s[i..i + ch_len]);
                i += ch_len;
            }
        }
    }

    out
}

/// Converts simple inline TeX syntax into readable Unicode text (useful when comparing
/// wrapped inline images vs Unicode fallback and for compact plain-text accessibility).
#[allow(dead_code)]
pub fn tex_to_unicode_fallback(tex: &str) -> String {
    let mut out = tex.trim().to_string();
    let replacements = [
        ("\\alpha", "α"),
        ("\\beta", "β"),
        ("\\gamma", "γ"),
        ("\\delta", "δ"),
        ("\\epsilon", "ε"),
        ("\\theta", "θ"),
        ("\\lambda", "λ"),
        ("\\mu", "μ"),
        ("\\pi", "π"),
        ("\\sigma", "σ"),
        ("\\phi", "φ"),
        ("\\omega", "ω"),
        ("\\Delta", "Δ"),
        ("\\Sigma", "Σ"),
        ("\\Omega", "Ω"),
        ("\\infty", "∞"),
        ("\\times", "×"),
        ("\\cdot", "·"),
        ("\\pm", "±"),
        ("\\leq", "≤"),
        ("\\le", "≤"),
        ("\\geq", "≥"),
        ("\\ge", "≥"),
        ("\\neq", "≠"),
        ("\\ne", "≠"),
        ("\\approx", "≈"),
        ("\\to", "→"),
        ("\\rightarrow", "→"),
        ("\\implies", "⟹"),
        ("\\in", "∈"),
        ("\\sum", "∑"),
        ("\\prod", "∏"),
        ("\\int", "∫"),
        ("\\sqrt", "√"),
        ("\\partial", "∂"),
        ("\\nabla", "∇"),
        ("\\,", " "),
        ("\\;", " "),
        ("\\quad", "  "),
    ];
    for (pat, rep) in replacements {
        out = out.replace(pat, rep);
    }
    out
}

/// Kind of block-level container for a paragraph/line rendered with inline math.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MathParagraphKind {
    Paragraph,
    Heading { level: u8 },
    ListItem { indent_level: usize, marker: String },
    Blockquote,
}

/// Typed inline span parsed from a Markdown block containing inline math.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MathInlineSpan {
    Text {
        text: String,
        bold: bool,
        italic: bool,
    },
    Code(String),
    Link {
        label: String,
        url: String,
        bold: bool,
        italic: bool,
    },
    Math(String),
    StreamingMath(String),
}

/// Sub-chunk of a Markdown block after isolating paragraphs/lines containing inline math.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MathChunk {
    /// Math-free Markdown chunk (or GFM table with Unicode math fallback) handed straight to `rune_kit::Markdown`.
    Markdown(String),
    /// Math-free indented list continuation split off after an inline-math list item.
    IndentedMarkdown {
        indent_level: usize,
        base_spaces: usize,
        markdown: String,
    },
    /// Single block containing at least one inline math / streaming math run.
    InlineMathParagraph {
        kind: MathParagraphKind,
        spans: Vec<MathInlineSpan>,
    },
}

fn has_inline_math_part(s: &str, streaming: bool) -> bool {
    s.contains("$$")
        && split_inline_math(s, streaming).iter().any(|p| {
            matches!(
                p,
                InlineMathPart::Math(_) | InlineMathPart::StreamingMath(_)
            )
        })
}

fn rewrite_inline_math_to_unicode(s: &str, streaming: bool) -> String {
    let mut out = String::with_capacity(s.len());
    for part in split_inline_math(s, streaming) {
        match part {
            InlineMathPart::Text(t) => out.push_str(&t),
            InlineMathPart::Math(tex) => out.push_str(&tex_to_unicode_fallback(&tex)),
            InlineMathPart::StreamingMath(tex) => {
                out.push_str("$$");
                out.push_str(&tex);
            }
        }
    }
    out
}

fn parse_atx_heading(stripped: &str) -> Option<(u8, &str)> {
    let (_, rest) = leading_spaces_up_to_3(stripped)?;
    let hashes = rest.bytes().take_while(|&b| b == b'#').count();
    if !(1..=6).contains(&hashes) {
        return None;
    }
    let after = &rest[hashes..];
    if after.is_empty() {
        return Some((hashes as u8, ""));
    }
    let after = after.strip_prefix([' ', '\t'])?;
    let trimmed = after.trim().trim_end_matches('#').trim_end();
    Some((hashes as u8, trimmed))
}

fn parse_list_prefix_raw(stripped: &str) -> Option<(usize, usize, String, &str)> {
    let leading = stripped.bytes().take_while(|&b| b == b' ').count();
    let rest = &stripped[leading..];
    if let Some(after) = rest
        .strip_prefix("- ")
        .or_else(|| rest.strip_prefix("* "))
        .or_else(|| rest.strip_prefix("+ "))
    {
        return Some((leading, 2, "•".to_string(), after.trim_start()));
    }
    let digits = rest.bytes().take_while(|b| b.is_ascii_digit()).count();
    if (1..=9).contains(&digits) {
        let after_digits = &rest[digits..];
        if let Some(after) = after_digits
            .strip_prefix(". ")
            .or_else(|| after_digits.strip_prefix(") "))
        {
            return Some((
                leading,
                digits + 2,
                format!("{}.", &rest[..digits]),
                after.trim_start(),
            ));
        }
    }
    None
}

fn parse_list_prefix(stripped: &str) -> Option<(usize, String, &str)> {
    let (leading, _, marker, body) = parse_list_prefix_raw(stripped)?;
    Some((leading / 2, marker, body))
}

fn is_thematic_break(stripped: &str) -> bool {
    let Some((_, rest)) = leading_spaces_up_to_3(stripped) else {
        return false;
    };
    let mut marker: Option<u8> = None;
    let mut count = 0usize;
    for b in rest.bytes() {
        if b == b' ' || b == b'\t' {
            continue;
        }
        if b != b'-' && b != b'*' && b != b'_' {
            return false;
        }
        if let Some(prev) = marker
            && prev != b
        {
            return false;
        }
        marker = Some(b);
        count += 1;
    }
    count >= 3
}

fn is_table_separator_line(stripped: &str) -> bool {
    let trimmed = stripped.trim();
    if !trimmed.contains('|') || !trimmed.contains('-') {
        return false;
    }
    trimmed
        .bytes()
        .all(|b| matches!(b, b'|' | b'-' | b':' | b' ' | b'\t'))
}

fn push_markdown_chunk(raw: &str, out: &mut Vec<MathChunk>) {
    if raw.is_empty() {
        return;
    }
    if let Some(MathChunk::Markdown(prev)) = out.last_mut() {
        prev.push_str(raw);
    } else {
        out.push(MathChunk::Markdown(raw.to_string()));
    }
}

fn strip_leading_spaces(raw: &str, count: usize) -> String {
    if count == 0 {
        return raw.to_string();
    }
    let mut out = String::with_capacity(raw.len());
    for line in raw.split_inclusive('\n') {
        let strip = line.bytes().take(count).take_while(|&b| b == b' ').count();
        out.push_str(&line[strip..]);
    }
    out
}

fn push_list_markdown_chunk(
    raw: &str,
    indent_level: usize,
    leading_spaces: usize,
    out: &mut Vec<MathChunk>,
) {
    if raw.is_empty() {
        return;
    }
    if indent_level == 0 {
        push_markdown_chunk(raw, out);
        return;
    }
    match out.last_mut() {
        Some(MathChunk::Markdown(prev)) => {
            prev.push_str(raw);
        }
        Some(MathChunk::IndentedMarkdown {
            base_spaces,
            markdown,
            ..
        }) if leading_spaces >= *base_spaces => {
            markdown.push_str(&strip_leading_spaces(raw, *base_spaces));
        }
        _ => {
            out.push(MathChunk::IndentedMarkdown {
                indent_level,
                base_spaces: leading_spaces,
                markdown: strip_leading_spaces(raw, leading_spaces),
            });
        }
    }
}

/// Returns whether a Markdown chunk begins immediately with a list item (without a leading blank line).
pub(super) fn markdown_starts_with_list_item(md: &str) -> bool {
    md.lines()
        .next()
        .is_some_and(|line| parse_list_prefix(trim_line_end(line)).is_some())
}

/// Returns whether a Markdown chunk ends directly on a list item line (without a trailing blank line).
pub(super) fn markdown_ends_with_list_item(md: &str) -> bool {
    let mut in_list = false;
    let mut ended_blank = false;
    for line in md.lines() {
        let s = trim_line_end(line);
        if is_blank_line(s) {
            ended_blank = true;
        } else if parse_list_prefix(s).is_some() {
            in_list = true;
            ended_blank = false;
        } else if in_list && s.starts_with(' ') && parse_fence_opener(s).is_none() {
            ended_blank = false;
        } else {
            in_list = false;
            ended_blank = false;
        }
    }
    in_list && !ended_blank
}

/// Splits a non-display-block Markdown chunk into native math-free `Markdown` blocks
/// and `InlineMathParagraph` blocks for paragraphs/headings/lists/quotes that actually
/// contain inline `$$...$$` math.
pub fn split_inline_math_chunks(src: &str, streaming: bool) -> Vec<MathChunk> {
    if src.is_empty() {
        return Vec::new();
    }
    if !has_inline_math_part(src, streaming) {
        return vec![MathChunk::Markdown(src.to_string())];
    }

    let normalized = normalize_newlines(src);
    let lines: Vec<&str> = normalized.split_inclusive('\n').collect();
    let mut out = Vec::new();
    let mut tracker = CodeBlockTracker::new();
    let mut list_stack: Vec<usize> = Vec::new();
    let mut idx = 0;

    while idx < lines.len() {
        let line = lines[idx];
        let stripped = trim_line_end(line);

        // Code blocks (fenced / indented) stay verbatim in native Markdown.
        let in_code = tracker.step_line(line);
        if in_code {
            if !tracker.in_indented_code {
                list_stack.clear();
            }
            push_markdown_chunk(line, &mut out);
            idx += 1;
            continue;
        }

        if is_blank_line(stripped) {
            push_markdown_chunk(line, &mut out);
            idx += 1;
            continue;
        }

        if is_thematic_break(stripped) {
            list_stack.clear();
            push_markdown_chunk(line, &mut out);
            idx += 1;
            continue;
        }

        // Headings: single line block.
        if let Some((level, content)) = parse_atx_heading(stripped) {
            list_stack.clear();
            if has_inline_math_part(content, streaming) {
                out.push(MathChunk::InlineMathParagraph {
                    kind: MathParagraphKind::Heading { level },
                    spans: parse_inline_markdown_spans(content, streaming),
                });
            } else {
                push_markdown_chunk(line, &mut out);
            }
            idx += 1;
            continue;
        }

        // GFM tables: header row + separator row + body rows keep native Markdown table structure.
        if stripped.contains('|')
            && idx + 1 < lines.len()
            && is_table_separator_line(trim_line_end(lines[idx + 1]))
        {
            list_stack.clear();
            let start = idx;
            idx += 2;
            while idx < lines.len() {
                let s = trim_line_end(lines[idx]);
                if is_blank_line(s) || !s.contains('|') {
                    break;
                }
                idx += 1;
            }
            let table_raw: String = lines[start..idx].concat();
            let table_md = if has_inline_math_part(&table_raw, streaming) {
                rewrite_inline_math_to_unicode(&table_raw, streaming)
            } else {
                table_raw
            };
            push_markdown_chunk(&table_md, &mut out);
            continue;
        }

        // Blockquotes (`>` lines): handle each contiguous quote block.
        if leading_spaces_up_to_3(stripped).is_some_and(|(_, r)| r.starts_with('>')) {
            list_stack.clear();
            let start = idx;
            let mut inner = String::new();
            while idx < lines.len() {
                let s = trim_line_end(lines[idx]);
                if is_blank_line(s) {
                    break;
                }
                let Some((_, rest)) = leading_spaces_up_to_3(s) else {
                    break;
                };
                if let Some(after_gt) = rest.strip_prefix('>') {
                    let line_body = after_gt.strip_prefix(' ').unwrap_or(after_gt);
                    if !inner.is_empty() {
                        inner.push(' ');
                    }
                    inner.push_str(line_body.trim_end());
                    idx += 1;
                } else {
                    break;
                }
            }
            if has_inline_math_part(&inner, streaming) {
                out.push(MathChunk::InlineMathParagraph {
                    kind: MathParagraphKind::Blockquote,
                    spans: parse_inline_markdown_spans(&inner, streaming),
                });
            } else {
                push_markdown_chunk(&lines[start..idx].concat(), &mut out);
            }
            continue;
        }

        // List item (`- `, `1. `): collects continuation lines until blank, fence, heading, quote, or new item.
        if let Some((leading, marker_cols, marker, first_body)) = parse_list_prefix_raw(stripped)
            && (!list_stack.is_empty() || leading <= 3)
        {
            while list_stack.last().is_some_and(|&col| leading < col) {
                list_stack.pop();
            }
            let indent_level = list_stack.len();
            list_stack.push(leading + marker_cols);
            let start = idx;
            let mut body = first_body.to_string();
            idx += 1;
            while idx < lines.len() {
                let next_line = lines[idx];
                let next_s = trim_line_end(next_line);
                if is_blank_line(next_s)
                    || parse_fence_opener(next_s).is_some()
                    || parse_atx_heading(next_s).is_some()
                    || is_thematic_break(next_s)
                    || parse_list_prefix(next_s).is_some()
                    || leading_spaces_up_to_3(next_s).is_some_and(|(_, r)| r.starts_with('>'))
                {
                    break;
                }
                if !body.is_empty() {
                    body.push(' ');
                }
                body.push_str(next_s.trim());
                idx += 1;
            }
            if has_inline_math_part(&body, streaming) {
                out.push(MathChunk::InlineMathParagraph {
                    kind: MathParagraphKind::ListItem {
                        indent_level,
                        marker,
                    },
                    spans: parse_inline_markdown_spans(&body, streaming),
                });
            } else {
                push_list_markdown_chunk(
                    &lines[start..idx].concat(),
                    indent_level,
                    leading,
                    &mut out,
                );
            }
            continue;
        }

        // Regular paragraph: collects lines until blank or interrupting block construct.
        if stripped.bytes().take_while(|&b| b == b' ').count() == 0 {
            list_stack.clear();
        }
        let start = idx;
        let mut para = stripped.to_string();
        idx += 1;
        while idx < lines.len() {
            let next_line = lines[idx];
            let next_s = trim_line_end(next_line);
            if is_blank_line(next_s)
                || parse_fence_opener(next_s).is_some()
                || parse_atx_heading(next_s).is_some()
                || is_thematic_break(next_s)
                || parse_list_prefix(next_s).is_some()
                || leading_spaces_up_to_3(next_s).is_some_and(|(_, r)| r.starts_with('>'))
            {
                break;
            }
            if !para.is_empty() {
                para.push('\n');
            }
            para.push_str(next_s);
            idx += 1;
        }
        if has_inline_math_part(&para, streaming) {
            out.push(MathChunk::InlineMathParagraph {
                kind: MathParagraphKind::Paragraph,
                spans: parse_inline_markdown_spans(&para, streaming),
            });
        } else {
            push_markdown_chunk(&lines[start..idx].concat(), &mut out);
        }
    }

    out.retain(|chunk| match chunk {
        MathChunk::Markdown(md) | MathChunk::IndentedMarkdown { markdown: md, .. } => {
            !md.trim().is_empty()
        }
        MathChunk::InlineMathParagraph { .. } => true,
    });
    out
}

/// Parses inline Markdown formatting (`**bold**`, `*italic*`, `` `code` ``, `[label](url)`)
/// around `$$math$$` / streaming `$$...` runs using non-colliding private-use sentinels.
pub fn parse_inline_markdown_spans(raw: &str, streaming: bool) -> Vec<MathInlineSpan> {
    let parts = split_inline_math(raw, streaming);
    let mut math_payloads: Vec<(bool, String)> = Vec::new();
    let mut combined = String::with_capacity(raw.len());

    for part in parts {
        match part {
            InlineMathPart::Text(t) => combined.push_str(&t),
            InlineMathPart::Math(tex) => {
                let idx = math_payloads.len();
                math_payloads.push((false, tex));
                combined.push('\u{E000}');
                combined.push_str(&idx.to_string());
                combined.push('\u{E001}');
            }
            InlineMathPart::StreamingMath(tex) => {
                let idx = math_payloads.len();
                math_payloads.push((true, tex));
                combined.push('\u{E000}');
                combined.push_str(&idx.to_string());
                combined.push('\u{E001}');
            }
        }
    }

    let mut out = Vec::new();
    parse_inline_range(&combined, false, false, &math_payloads, &mut out);
    out
}

fn push_styled_text(out: &mut Vec<MathInlineSpan>, text: &str, bold: bool, italic: bool) {
    if text.is_empty() {
        return;
    }
    if let Some(MathInlineSpan::Text {
        text: prev,
        bold: pb,
        italic: pi,
    }) = out.last_mut()
        && *pb == bold
        && *pi == italic
    {
        prev.push_str(text);
        return;
    }
    out.push(MathInlineSpan::Text {
        text: text.to_string(),
        bold,
        italic,
    });
}

fn is_ascii_punct(b: u8) -> bool {
    matches!(
        b,
        b'!'..=b'/' | b':'..=b'@' | b'['..=b'`' | b'{'..=b'~'
    )
}

fn find_link_end(s: &str, open_bracket: usize) -> Option<(usize, usize, usize)> {
    let bytes = s.as_bytes();
    let mut j = open_bracket + 1;
    let mut bracket_depth = 1usize;
    while j < bytes.len() {
        if bytes[j] == b'\\' && j + 1 < bytes.len() {
            j += 2;
            continue;
        }
        if bytes[j] == b'[' {
            bracket_depth += 1;
        } else if bytes[j] == b']' {
            bracket_depth -= 1;
            if bracket_depth == 0 {
                break;
            }
        }
        j += 1;
    }
    if bracket_depth != 0 || bytes.get(j + 1) != Some(&b'(') {
        return None;
    }
    let close_bracket = j;
    let mut k = close_bracket + 2;
    let mut paren_depth = 1usize;
    while k < bytes.len() {
        if bytes[k] == b'\\' && k + 1 < bytes.len() {
            k += 2;
            continue;
        }
        if bytes[k] == b'(' {
            paren_depth += 1;
        } else if bytes[k] == b')' {
            paren_depth -= 1;
            if paren_depth == 0 {
                return Some((close_bracket, close_bracket + 2, k));
            }
        }
        k += 1;
    }
    None
}

fn find_emph_closer(s: &str, from: usize, delim: &[u8]) -> Option<usize> {
    let bytes = s.as_bytes();
    let dlen = delim.len();
    let mut j = from;
    while j + dlen <= bytes.len() {
        if bytes[j] == b'\\' && j + 1 < bytes.len() {
            j += 2;
            continue;
        }
        if bytes[j] == b'`' {
            let run = bytes[j..].iter().take_while(|&&b| b == b'`').count();
            if let Some(close) = find_closing_backticks(bytes, j + run, run) {
                j = close;
                continue;
            }
            j += run;
            continue;
        }
        if &bytes[j..j + dlen] == delim {
            if dlen == 1 && delim[0] == b'_' {
                let next_alnum = bytes.get(j + 1).is_some_and(u8::is_ascii_alphanumeric);
                if next_alnum {
                    j += 1;
                    continue;
                }
            }
            // Don't match `**` when searching for `*` closer unless exact.
            if dlen == 1 && bytes.get(j + 1) == Some(&delim[0]) {
                j += 2;
                continue;
            }
            return Some(j);
        }
        j += 1;
    }
    None
}

fn parse_inline_range(
    s: &str,
    bold: bool,
    italic: bool,
    math_payloads: &[(bool, String)],
    out: &mut Vec<MathInlineSpan>,
) {
    let bytes = s.as_bytes();
    let mut i = 0;

    while i < bytes.len() {
        // Private-use sentinel wrapping one Math / StreamingMath token.
        if s[i..].starts_with('\u{E000}')
            && let Some(end_rel) = s[i + '\u{E000}'.len_utf8()..].find('\u{E001}')
        {
            let num_start = i + '\u{E000}'.len_utf8();
            let num_end = num_start + end_rel;
            if let Ok(idx) = s[num_start..num_end].parse::<usize>()
                && let Some((is_streaming, tex)) = math_payloads.get(idx)
            {
                if *is_streaming {
                    out.push(MathInlineSpan::StreamingMath(tex.clone()));
                } else {
                    out.push(MathInlineSpan::Math(tex.clone()));
                }
                i = num_end + '\u{E001}'.len_utf8();
                continue;
            }
        }

        // Normalize soft newlines in text to spaces.
        if bytes[i] == b'\n' {
            push_styled_text(out, " ", bold, italic);
            i += 1;
            continue;
        }

        if bytes[i] == b'`' {
            let count = bytes[i..].iter().take_while(|&&b| b == b'`').count();
            if let Some(close_end) = find_closing_backticks(bytes, i + count, count) {
                let inner = &s[i + count..close_end - count];
                let code = if inner.len() >= 2
                    && inner.starts_with(' ')
                    && inner.ends_with(' ')
                    && !inner.trim().is_empty()
                {
                    inner[1..inner.len() - 1].to_string()
                } else {
                    inner.to_string()
                };
                out.push(MathInlineSpan::Code(code));
                i = close_end;
                continue;
            }
            push_styled_text(out, &s[i..i + count], bold, italic);
            i += count;
            continue;
        }

        if bytes[i] == b'\\' && i + 1 < bytes.len() && is_ascii_punct(bytes[i + 1]) {
            push_styled_text(out, &s[i + 1..i + 2], bold, italic);
            i += 2;
            continue;
        }

        if bytes[i] == b'['
            && let Some((close_bracket, url_start, url_end)) = find_link_end(s, i)
        {
            let label = &s[i + 1..close_bracket];
            let url = s[url_start..url_end].trim().to_string();
            if !label.contains('\u{E000}') {
                out.push(MathInlineSpan::Link {
                    label: label.to_string(),
                    url,
                    bold,
                    italic,
                });
                i = url_end + 1;
                continue;
            }
        }

        if (s[i..].starts_with("**") || s[i..].starts_with("__"))
            && let Some(close) = find_emph_closer(s, i + 2, &bytes[i..i + 2])
            && close > i + 2
        {
            parse_inline_range(&s[i + 2..close], true, italic, math_payloads, out);
            i = close + 2;
            continue;
        }

        if (bytes[i] == b'*'
            || (bytes[i] == b'_' && (i == 0 || !bytes[i - 1].is_ascii_alphanumeric())))
            && bytes.get(i + 1) != Some(&bytes[i])
            && !bytes.get(i + 1).is_some_and(|b| *b == b' ' || *b == b'\t')
            && let Some(close) = find_emph_closer(s, i + 1, &bytes[i..i + 1])
            && close > i + 1
        {
            parse_inline_range(&s[i + 1..close], bold, true, math_payloads, out);
            i = close + 1;
            continue;
        }

        let ch_len = s[i..].chars().next().map_or(1, char::len_utf8);
        push_styled_text(out, &s[i..i + ch_len], bold, italic);
        i += ch_len;
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct MathCacheKey {
    tex: String,
    display: bool,
    rgba32: u32,
    px_per_em_bits: u32,
}

#[derive(Clone)]
enum CachedMathEntry {
    Pending {
        pixels: Pixels,
        width_pt: f32,
        height_pt: f32,
        baseline_pt: f32,
    },
    Ready {
        pixels: Pixels,
        width_pt: f32,
        height_pt: f32,
        baseline_pt: f32,
    },
    Empty,
    Failed,
}

/// Outcome of resolving a KaTeX expression against the global raster cache.
pub enum MathRenderOutcome {
    Ready {
        pixels: Pixels,
        width_pt: f32,
        height_pt: f32,
        baseline_pt: f32,
    },
    Pending {
        pixels: Pixels,
        width_pt: f32,
        height_pt: f32,
        baseline_pt: f32,
    },
    Empty,
    Failed,
}

struct RasterJob {
    key: MathCacheKey,
    layout: Arc<KatexLayout>,
    px_per_em: f64,
    color: KatexColor,
    render_scale: f32,
    pixels: Pixels,
    waker: Arc<dyn Fn() + Send + Sync>,
}

struct MathRasterCache {
    ctx: KatexContext,
    entries: Mutex<(
        HashMap<MathCacheKey, CachedMathEntry>,
        VecDeque<MathCacheKey>,
    )>,
    worker_tx: mpsc::Sender<RasterJob>,
}

fn global_math_cache() -> &'static MathRasterCache {
    static CACHE: OnceLock<MathRasterCache> = OnceLock::new();
    CACHE.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<RasterJob>();
        let _ = std::thread::Builder::new()
            .name("cowork-math-raster".into())
            .spawn(move || {
                while let Ok(job) = rx.recv() {
                    let entry = rasterize_layout_to_entry(
                        &job.layout,
                        job.px_per_em,
                        job.color,
                        job.render_scale,
                        Some(job.pixels),
                    );
                    if let Some(cache) = CACHE.get() {
                        cache.insert_entry(job.key, entry);
                    }
                    (job.waker)();
                }
            });
        MathRasterCache {
            ctx: KatexContext::default(),
            entries: Mutex::new((HashMap::new(), VecDeque::new())),
            worker_tx: tx,
        }
    })
}

impl MathRasterCache {
    fn insert_entry(&self, key: MathCacheKey, entry: CachedMathEntry) {
        let Ok(mut guard) = self.entries.lock() else {
            return;
        };
        let (map, order) = &mut *guard;
        if !map.contains_key(&key) {
            if order.len() >= MAX_CACHE_ENTRIES
                && let Some(evicted) = order.pop_front()
            {
                map.remove(&evicted);
            }
            order.push_back(key.clone());
        }
        map.insert(key, entry);
    }
}

fn linear_to_srgb_u8(c: f32) -> u8 {
    let c = c.clamp(0.0, 1.0);
    let srgb = if c <= 0.0031308 {
        c * 12.92
    } else {
        1.055 * c.powf(1.0 / 2.4) - 0.055
    };
    (srgb * 255.0).round().clamp(0.0, 255.0) as u8
}

/// Converts Rune's linear RGBA `Color` into sRGB `u8` color for `katex-native` SVG/raster.
pub fn color_to_katex_srgb(color: Color) -> KatexColor {
    KatexColor {
        r: linear_to_srgb_u8(color.r),
        g: linear_to_srgb_u8(color.g),
        b: linear_to_srgb_u8(color.b),
        a: (color.a.clamp(0.0, 1.0) * 255.0).round() as u8,
    }
}

fn rasterize_layout_to_entry(
    layout: &KatexLayout,
    px_per_em: f64,
    color: KatexColor,
    render_scale: f32,
    reuse_pixels: Option<Pixels>,
) -> CachedMathEntry {
    match rasterize(layout, px_per_em, color) {
        Some(rast) if rast.width > 0 && rast.height > 0 => {
            let pixels = reuse_pixels.unwrap_or_default();
            pixels.set(rast.width, rast.height, rast.rgba);
            let height_pt = (rast.height as f32 / render_scale).max(1.0);
            CachedMathEntry::Ready {
                pixels,
                width_pt: (rast.width as f32 / render_scale).max(1.0),
                height_pt,
                baseline_pt: (rast.baseline as f32 / render_scale).clamp(0.0, height_pt),
            }
        }
        _ => CachedMathEntry::Empty,
    }
}

/// Resolves a TeX formula into cached RGBA `Pixels` sized in logical points.
///
/// When `waker` is `Some`, cache misses lay out metrics synchronously (~50µs) and
/// enqueue SVG rasterization onto a dedicated worker thread so live streaming stays
/// responsive. When `waker` is `None` (headless scenes / tests), rasterization runs
/// synchronously so frame 0 renders formulas immediately.
pub fn resolve_math_formula(
    tex: &str,
    display: bool,
    ink: Color,
    scale: Option<f32>,
    em_pt: f32,
    waker: Option<&Arc<dyn Fn() + Send + Sync>>,
) -> MathRenderOutcome {
    let trimmed = tex.trim();
    if trimmed.is_empty() {
        return MathRenderOutcome::Empty;
    }

    let render_scale = scale.unwrap_or(DEFAULT_RENDER_SCALE).clamp(1.0, 4.0);
    let px_per_em = (em_pt * render_scale) as f64;
    let k_color = color_to_katex_srgb(ink);
    let rgba32 = u32::from_be_bytes([k_color.r, k_color.g, k_color.b, k_color.a]);
    let key = MathCacheKey {
        tex: trimmed.to_string(),
        display,
        rgba32,
        px_per_em_bits: (px_per_em as f32).to_bits(),
    };

    let cache = global_math_cache();
    if let Ok(guard) = cache.entries.lock()
        && let Some(hit) = guard.0.get(&key)
    {
        return match hit {
            CachedMathEntry::Ready {
                pixels,
                width_pt,
                height_pt,
                baseline_pt,
            } => MathRenderOutcome::Ready {
                pixels: pixels.clone(),
                width_pt: *width_pt,
                height_pt: *height_pt,
                baseline_pt: *baseline_pt,
            },
            CachedMathEntry::Pending {
                pixels,
                width_pt,
                height_pt,
                baseline_pt,
            } => MathRenderOutcome::Pending {
                pixels: pixels.clone(),
                width_pt: *width_pt,
                height_pt: *height_pt,
                baseline_pt: *baseline_pt,
            },
            CachedMathEntry::Empty => MathRenderOutcome::Empty,
            CachedMathEntry::Failed => MathRenderOutcome::Failed,
        };
    }

    let layout = match katex_native::layout(&cache.ctx, trimmed, display) {
        Ok(layout) => Arc::new(layout),
        Err(_) => {
            cache.insert_entry(key, CachedMathEntry::Failed);
            return MathRenderOutcome::Failed;
        }
    };

    if let Some(wake) = waker {
        let pixels = Pixels::new();
        let width_pt = ((layout.width as f32 * em_pt) + 2.0).max(4.0);
        let height_pt = (((layout.height + layout.depth) as f32 * em_pt) + 2.0).max(em_pt);
        let baseline_pt = ((layout.height as f32 * em_pt) + 1.0).clamp(0.0, height_pt);
        cache.insert_entry(
            key.clone(),
            CachedMathEntry::Pending {
                pixels: pixels.clone(),
                width_pt,
                height_pt,
                baseline_pt,
            },
        );
        let job = RasterJob {
            key,
            layout,
            px_per_em,
            color: k_color,
            render_scale,
            pixels: pixels.clone(),
            waker: Arc::clone(wake),
        };
        if cache.worker_tx.send(job).is_err() {
            return MathRenderOutcome::Failed;
        }
        return MathRenderOutcome::Pending {
            pixels,
            width_pt,
            height_pt,
            baseline_pt,
        };
    }

    let entry = rasterize_layout_to_entry(&layout, px_per_em, k_color, render_scale, None);
    let outcome = match &entry {
        CachedMathEntry::Ready {
            pixels,
            width_pt,
            height_pt,
            baseline_pt,
        } => MathRenderOutcome::Ready {
            pixels: pixels.clone(),
            width_pt: *width_pt,
            height_pt: *height_pt,
            baseline_pt: *baseline_pt,
        },
        CachedMathEntry::Empty => MathRenderOutcome::Empty,
        _ => MathRenderOutcome::Failed,
    };
    cache.insert_entry(key, entry);
    outcome
}

fn render_math_code_block_fallback(
    k: &Kit,
    t: &ThemeTokens,
    tex: &str,
    is_streaming: bool,
    key_prefix: &str,
) -> El {
    let border_color = if is_streaming {
        t.border_muted
    } else {
        k.alpha(t.danger, 0.35)
    };
    let text_color = if is_streaming {
        t.text_muted
    } else {
        t.text_base
    };
    let body = if tex.trim().is_empty() {
        "$$".to_string()
    } else if is_streaming {
        format!("$$\n{tex}")
    } else {
        format!("$$\n{}\n$$", tex.trim())
    };
    col()
        .key(key_prefix.to_string())
        .w_full()
        .px(12.0)
        .py(8.0)
        .radius(6.0)
        .fill(t.code_bg)
        .border(1.0, border_color)
        .child(text(body).font(t.code).color(text_color).wrap())
}

fn render_math_code_inline_fallback(
    k: &Kit,
    t: &ThemeTokens,
    tex: &str,
    is_streaming: bool,
    key_prefix: &str,
) -> El {
    let border_color = if is_streaming {
        t.border_muted
    } else {
        k.alpha(t.danger, 0.35)
    };
    let label = if is_streaming {
        format!("$${tex}")
    } else {
        format!("$${tex}$$")
    };
    row()
        .key(key_prefix.to_string())
        .items_center()
        .px(5.0)
        .py(1.0)
        .radius(4.0)
        .fill(t.code_bg)
        .border(1.0, border_color)
        .child(text(label).font(t.code).color(t.text_muted))
}

/// Renders a top-level fenced display math block (`$$\n...\n$$`) centered with horizontal scroll
/// for wide equations, falling back cleanly to a code-styled card if TeX fails to parse.
pub fn render_display_math_block(
    k: &Kit,
    t: &ThemeTokens,
    tex: &str,
    compact: bool,
    scale: Option<f32>,
    waker: Option<&Arc<dyn Fn() + Send + Sync>>,
    key_prefix: &str,
) -> El {
    let em_pt = if compact { 14.5 } else { DISPLAY_EM_PT };
    match resolve_math_formula(tex, true, t.text_base, scale, em_pt, waker) {
        MathRenderOutcome::Ready {
            pixels,
            width_pt,
            height_pt,
            ..
        }
        | MathRenderOutcome::Pending {
            pixels,
            width_pt,
            height_pt,
            ..
        } => {
            let img = el()
                .key(format!("{key_prefix}:img"))
                .pixels(&pixels)
                .w(width_pt)
                .min_w(width_pt)
                .h(height_pt);
            col()
                .key(key_prefix.to_string())
                .w_full()
                .scroll_x()
                .py(if compact { 6.0 } else { 10.0 })
                .px(4.0)
                .child(row().w_full().justify_center().child(img))
        }
        MathRenderOutcome::Empty => el().key(key_prefix.to_string()).w(0.0).h(0.0),
        MathRenderOutcome::Failed => render_math_code_block_fallback(k, t, tex, false, key_prefix),
    }
}

/// Renders an unclosed streaming display math block (`$$\n...`) as a clean code-styled card.
pub fn render_streaming_math_block(k: &Kit, t: &ThemeTokens, tex: &str, key_prefix: &str) -> El {
    render_math_code_block_fallback(k, t, tex, true, key_prefix)
}

fn split_word_atoms(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut start = 0usize;
    let bytes = s.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b' ' {
            while i < bytes.len() && bytes[i] == b' ' {
                i += 1;
            }
            out.push(s[start..i].to_string());
            start = i;
        } else {
            i += 1;
        }
    }
    if start < s.len() {
        out.push(s[start..].to_string());
    }
    out
}

fn heading_style(t: &ThemeTokens, level: u8, compact: bool) -> (TextStyle, f32) {
    let base_body = if compact { 12.5 } else { 13.0 };
    match level {
        1 => (TextStyle::new(18.0, 600.0).lh(25.0), 19.0),
        2 => (TextStyle::new(16.0, 600.0).lh(22.0), 17.0),
        3 => (TextStyle::new(14.5, 600.0).lh(20.0), 15.5),
        4..=6 => (TextStyle::new(base_body, 600.0).lh(19.0), base_body * 1.08),
        _ => (t.body, INLINE_EM_PT),
    }
}

fn apply_span_style(word: &str, bold: bool, italic: bool) -> Option<Vec<Span>> {
    if !bold && !italic {
        return None;
    }
    let mut sp = Span::new(0, word.len());
    if bold {
        sp = sp.bold();
    }
    if italic {
        sp = sp.italic();
    }
    Some(vec![sp])
}

#[allow(clippy::too_many_arguments)]
fn append_inline_node_with_punct(
    mut flow: El,
    node: El,
    spans: &[MathInlineSpan],
    idx: usize,
    key_prefix: &str,
    base_font: TextStyle,
    ink: Color,
    carry_leading_space: &mut bool,
) -> (El, usize) {
    if let Some(MathInlineSpan::Text { text: next_t, .. }) = spans.get(idx + 1) {
        if let Some(first_ch) = next_t.chars().next()
            && matches!(first_ch, '.' | ',' | ';' | ':' | '!' | '?' | ')')
        {
            let punct_len = next_t.find(' ').unwrap_or(next_t.len());
            let punct = &next_t[..punct_len];
            let has_space_after = next_t[punct_len..].starts_with(' ');
            let mut grouped = row()
                .key(format!("{key_prefix}:g:{idx}"))
                .items_center()
                .child(node)
                .child(text(punct.to_string()).font(base_font).color(ink));
            if has_space_after {
                grouped = grouped.mr(3.5);
            }
            flow = flow.child(grouped);
            let rest = next_t[punct_len..].trim_start_matches(' ');
            if !rest.is_empty()
                && let MathInlineSpan::Text { bold, italic, .. } = &spans[idx + 1]
            {
                for (w_i, atom) in split_word_atoms(rest).into_iter().enumerate() {
                    if atom.is_empty() {
                        continue;
                    }
                    let mut w_el = text(atom.clone()).font(base_font).color(ink);
                    if let Some(sp) = apply_span_style(&atom, *bold, *italic) {
                        w_el = w_el.spans(sp);
                    }
                    flow = flow.child(w_el.key(format!("{key_prefix}:w:{}:{w_i}", idx + 1)));
                }
            }
            return (flow, idx + 2);
        } else if next_t.starts_with(' ') {
            *carry_leading_space = true;
            return (flow.child(node.mr(3.5)), idx + 1);
        }
    }
    (flow.child(node), idx + 1)
}

/// Renders one paragraph/heading/list-item/blockquote containing inline `$$...$$` math
/// using `row().flex_wrap()` with cached inline KaTeX `Pixels` images, formatted spans,
/// clickable links/citations, and code-styled streaming/error fallbacks.
#[allow(clippy::too_many_arguments)]
pub fn render_inline_math_paragraph<F>(
    k: &Kit,
    t: &ThemeTokens,
    kind: &MathParagraphKind,
    spans: &[MathInlineSpan],
    compact: bool,
    scale: Option<f32>,
    waker: Option<&Arc<dyn Fn() + Send + Sync>>,
    key_prefix: &str,
    on_link: &F,
) -> El
where
    F: Fn(&mut AppState, String, &mut Tx) + Clone + 'static,
{
    let md_body = if compact {
        TextStyle {
            line_height: 19.0,
            ..k.ty.text_small
        }
    } else {
        TextStyle {
            line_height: 22.4,
            ..t.body_lg
        }
    };
    let (base_font, em_pt, ink) = match kind {
        MathParagraphKind::Heading { level } => {
            let (style, em) = heading_style(t, *level, compact);
            (style, em, t.text_base)
        }
        MathParagraphKind::Blockquote => (
            md_body,
            if compact { 13.0 } else { INLINE_EM_PT },
            t.text_muted,
        ),
        MathParagraphKind::Paragraph | MathParagraphKind::ListItem { .. } => (
            md_body,
            if compact { 13.0 } else { INLINE_EM_PT },
            t.text_base,
        ),
    };

    let mut flow = row()
        .key(format!("{key_prefix}:flow"))
        .w_full()
        .flex_wrap()
        .items_center()
        .gaps(2.0, 0.0);

    let mut idx = 0usize;
    let mut carry_leading_space = false;
    while idx < spans.len() {
        match &spans[idx] {
            MathInlineSpan::Text {
                text: txt,
                bold,
                italic,
            } => {
                let mut slice = txt.as_str();
                if carry_leading_space {
                    slice = slice.trim_start_matches(' ');
                    carry_leading_space = false;
                }
                for (w_i, atom) in split_word_atoms(slice).into_iter().enumerate() {
                    if atom.is_empty() {
                        continue;
                    }
                    let mut el_word = text(atom.clone()).font(base_font).color(ink);
                    if let Some(sp) = apply_span_style(&atom, *bold, *italic) {
                        el_word = el_word.spans(sp);
                    }
                    flow = flow.child(el_word.key(format!("{key_prefix}:w:{idx}:{w_i}")));
                }
                idx += 1;
            }
            MathInlineSpan::Code(code) => {
                let pill = row()
                    .key(format!("{key_prefix}:c:{idx}"))
                    .items_center()
                    .px(4.0)
                    .py(1.0)
                    .radius(4.0)
                    .fill(t.code_bg)
                    .child(text(code.clone()).font(t.code).color(t.text_base));
                (flow, idx) = append_inline_node_with_punct(
                    flow,
                    pill,
                    spans,
                    idx,
                    key_prefix,
                    base_font,
                    ink,
                    &mut carry_leading_space,
                );
            }
            MathInlineSpan::Link {
                label,
                url,
                bold,
                italic,
            } => {
                let url_owned = url.clone();
                let handler = on_link.clone();
                let link_el = if url.starts_with("cowork-citation:") {
                    row()
                        .key(format!("{key_prefix}:a:{idx}"))
                        .items_center()
                        .px(4.5)
                        .py(1.0)
                        .radius(5.0)
                        .fill(k.alpha(t.elevated_bg, 0.9))
                        .hover(t.hover)
                        .border(1.0, t.border)
                        .cursor(Cursor::Pointer)
                        .on_press_tx(move |s: &mut AppState, tx: &mut Tx| {
                            handler(s, url_owned.clone(), tx);
                        })
                        .child(
                            text(label.clone())
                                .font(rune::TextStyle::new(11.5, 500.0))
                                .color(t.text_muted),
                        )
                } else {
                    let mut sp = Span::new(0, label.len()).underline(t.accent);
                    if *bold {
                        sp = sp.bold();
                    }
                    if *italic {
                        sp = sp.italic();
                    }
                    text(label.clone())
                        .key(format!("{key_prefix}:a:{idx}"))
                        .font(base_font)
                        .color(t.accent)
                        .spans(vec![sp])
                        .cursor(Cursor::Pointer)
                        .on_press_tx(move |s: &mut AppState, tx: &mut Tx| {
                            handler(s, url_owned.clone(), tx);
                        })
                };
                (flow, idx) = append_inline_node_with_punct(
                    flow,
                    link_el,
                    spans,
                    idx,
                    key_prefix,
                    base_font,
                    ink,
                    &mut carry_leading_space,
                );
            }
            MathInlineSpan::Math(tex) => {
                let math_node = match resolve_math_formula(tex, false, ink, scale, em_pt, waker) {
                    MathRenderOutcome::Ready {
                        pixels,
                        width_pt,
                        height_pt,
                        baseline_pt,
                    }
                    | MathRenderOutcome::Pending {
                        pixels,
                        width_pt,
                        height_pt,
                        baseline_pt,
                    } => {
                        let img = el()
                            .key(format!("{key_prefix}:m:{idx}"))
                            .pixels(&pixels)
                            .w(width_pt)
                            .min_w(width_pt)
                            .h(height_pt)
                            .mx(1.5);
                        // Align TeX baseline with UI sans baseline (`(ascent - descent) / 2 ≈ 0.36 * size`)
                        // inside the `items_center()` flex-wrap row without scaling the image box itself.
                        let text_base_offset = 0.36 * base_font.size;
                        let math_base_offset = baseline_pt - height_pt * 0.5;
                        let diff = text_base_offset - math_base_offset;
                        if diff > 0.25 {
                            row()
                                .key(format!("{key_prefix}:mb:{idx}"))
                                .pt((2.0 * diff).min(24.0))
                                .child(img)
                        } else if diff < -0.25 {
                            row()
                                .key(format!("{key_prefix}:mb:{idx}"))
                                .pb((2.0 * (-diff)).min(24.0))
                                .child(img)
                        } else {
                            img
                        }
                    }
                    MathRenderOutcome::Empty => {
                        el().key(format!("{key_prefix}:m:{idx}")).w(0.0).h(0.0)
                    }
                    MathRenderOutcome::Failed => render_math_code_inline_fallback(
                        k,
                        t,
                        tex,
                        false,
                        &format!("{key_prefix}:m:{idx}"),
                    ),
                };

                (flow, idx) = append_inline_node_with_punct(
                    flow,
                    math_node,
                    spans,
                    idx,
                    key_prefix,
                    base_font,
                    ink,
                    &mut carry_leading_space,
                );
            }
            MathInlineSpan::StreamingMath(tex) => {
                flow = flow.child(render_math_code_inline_fallback(
                    k,
                    t,
                    tex,
                    true,
                    &format!("{key_prefix}:sm:{idx}"),
                ));
                idx += 1;
            }
        }
    }

    match kind {
        MathParagraphKind::Paragraph => flow,
        MathParagraphKind::Heading { .. } => col()
            .key(key_prefix.to_string())
            .w_full()
            .pt(4.0)
            .pb(2.0)
            .child(flow),
        MathParagraphKind::ListItem {
            indent_level,
            marker,
        } => {
            // Match `rune_kit::MarkdownStyle::from_kit` list geometry (`list_indent = 32.0`,
            // centered marker column, zero extra gap) so mixed plain/math list items align.
            const LIST_INDENT: f32 = 32.0;
            row()
                .key(key_prefix.to_string())
                .role("listitem")
                .w_full()
                .items_start()
                .pl((*indent_level as f32) * LIST_INDENT)
                .child(
                    text(marker.clone())
                        .key(format!("{key_prefix}:marker"))
                        .font(base_font)
                        .color(t.text_muted)
                        .exact_lines()
                        .w(LIST_INDENT)
                        .align(Align::Center),
                )
                .child(
                    col()
                        .key(format!("{key_prefix}:body"))
                        .grow(1.0)
                        .min_w(0.0)
                        .child(flow),
                )
        }
        MathParagraphKind::Blockquote => row()
            .key(key_prefix.to_string())
            .w_full()
            .border_sides([0.0, 0.0, 0.0, 3.0], t.border_strong)
            .pl(12.0)
            .child(flow),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_dollar_prices_and_expressions_stay_literal() {
        let src = "It costs $5 and $10, while $x = 5$ is literal.";
        assert_eq!(
            split_math_blocks(src, false),
            vec![MathBlockSegment::Markdown(src.to_string())]
        );
        assert_eq!(
            split_inline_math(src, false),
            vec![InlineMathPart::Text(src.to_string())]
        );
    }

    #[test]
    fn inline_double_dollar_parses_around_prices_and_text() {
        let src = "Price $5, formula $$E = mc^2$$, tip $10, second $$a + b$$.";
        assert_eq!(
            split_inline_math(src, false),
            vec![
                InlineMathPart::Text("Price $5, formula ".into()),
                InlineMathPart::Math("E = mc^2".into()),
                InlineMathPart::Text(", tip $10, second ".into()),
                InlineMathPart::Math("a + b".into()),
                InlineMathPart::Text(".".into()),
            ]
        );
    }

    #[test]
    fn display_math_blocks_split_cleanly_and_ignore_inline_only_lines() {
        let src = "Intro $$x^2$$\n\n$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$\n\nOutro.";
        assert_eq!(
            split_math_blocks(src, false),
            vec![
                MathBlockSegment::Markdown("Intro $$x^2$$\n\n".into()),
                MathBlockSegment::DisplayMath("\\int_0^1 x^2\\,dx = \\frac{1}{3}".into()),
                MathBlockSegment::Markdown("\nOutro.".into()),
            ]
        );
    }

    #[test]
    fn display_math_allows_blank_lines_and_strips_opening_indent() {
        let src = "  $$\n  a + b\n\n  c + d\n  $$\n";
        assert_eq!(
            split_math_blocks(src, false),
            vec![MathBlockSegment::DisplayMath("a + b\n\nc + d".into())]
        );
    }

    #[test]
    fn fenced_and_indented_code_blocks_ignore_math_delimiters() {
        let fenced = "Before\n\n```latex\n$$\n\\alpha + \\beta\n$$\n```\n\nInline `$$not_math$$` and `` `$$also_not$$` `` ok.\n\n    $$\n    indented_code\n    $$\n";
        assert_eq!(
            split_math_blocks(fenced, false),
            vec![MathBlockSegment::Markdown(fenced.to_string())]
        );
        assert_eq!(
            split_inline_math(fenced, false),
            vec![InlineMathPart::Text(fenced.to_string())]
        );
    }

    #[test]
    fn escaped_delimiters_and_escaped_backslash_match_remark() {
        assert_eq!(
            split_inline_math(r"\$$x + y$$", false),
            vec![InlineMathPart::Text(r"\$$x + y$$".into())]
        );
        assert_eq!(
            split_inline_math(r"\\$$x + y$$", false),
            vec![
                InlineMathPart::Text(r"\\".into()),
                InlineMathPart::Math("x + y".into()),
            ]
        );
        assert_eq!(
            split_inline_math(r"$$\$5 + x$$", false),
            vec![InlineMathPart::Math(r"\$5 + x".into())]
        );
        assert_eq!(
            split_inline_math(r"$$x + \\$$", false),
            vec![InlineMathPart::Math(r"x + \\".into())]
        );
    }

    #[test]
    fn streaming_unclosed_math_emits_graceful_fallback_without_breaking_completed() {
        assert_eq!(
            split_inline_math("Working on $$x + ", true),
            vec![
                InlineMathPart::Text("Working on ".into()),
                InlineMathPart::StreamingMath("x + ".into()),
            ]
        );
        assert_eq!(
            split_inline_math("Working on $$x + ", false),
            vec![InlineMathPart::Text("Working on $$x + ".into())]
        );
        assert_eq!(
            split_inline_math("Done $$", true),
            vec![InlineMathPart::Text("Done $$".into())]
        );
        assert_eq!(
            split_math_blocks("Start\n\n$$\n\\int_0^1 x", true),
            vec![
                MathBlockSegment::Markdown("Start\n\n".into()),
                MathBlockSegment::StreamingMath("\\int_0^1 x".into()),
            ]
        );
        assert_eq!(
            split_math_blocks("Start\n\n$$\n\\int_0^1 x", false),
            vec![MathBlockSegment::Markdown(
                "Start\n\n$$\n\\int_0^1 x".into()
            )]
        );
    }

    #[test]
    fn inline_math_does_not_span_blank_lines_or_backticks_inside_math() {
        assert_eq!(
            split_inline_math("$$unclosed\n\n$$ok$$", false),
            vec![
                InlineMathPart::Text("$$unclosed\n\n".into()),
                InlineMathPart::Math("ok".into()),
            ]
        );
        assert_eq!(
            split_inline_math("$$`code_like` + x$$", false),
            vec![InlineMathPart::Math("`code_like` + x".into())]
        );
    }

    #[test]
    fn list_continuation_can_contain_math_while_top_level_indent_is_code() {
        let src = "- First item\n\n    $$a^2 + b^2$$\n";
        assert_eq!(
            split_inline_math(src, false),
            vec![
                InlineMathPart::Text("- First item\n\n    ".into()),
                InlineMathPart::Math("a^2 + b^2".into()),
                InlineMathPart::Text("\n".into()),
            ]
        );
    }

    #[test]
    fn inline_chunker_isolates_math_paragraphs_and_preserves_tables_and_code() {
        let src = "\
# Heading $$\\alpha$$

Plain paragraph stays native.

Result is **$$E = mc^2$$** in `foo_bar` ([spec](cit://1)), price \\$5.

- Bullet with $$x_i$$
- Regular bullet

| Col | Formula |
| --- | --- |
| A | $$\\alpha + \\beta$$ |
";
        let chunks = split_inline_math_chunks(src, false);
        assert!(matches!(
            &chunks[0],
            MathChunk::InlineMathParagraph {
                kind: MathParagraphKind::Heading { level: 1 },
                spans,
            } if spans.len() == 2
        ));
        assert!(matches!(&chunks[1], MathChunk::Markdown(md) if md.contains("Plain paragraph")));
        assert!(matches!(
            &chunks[2],
            MathChunk::InlineMathParagraph {
                kind: MathParagraphKind::Paragraph,
                spans,
            } if spans.iter().any(|s| matches!(s, MathInlineSpan::Math(t) if t == "E = mc^2"))
                && spans.iter().any(|s| matches!(s, MathInlineSpan::Code(c) if c == "foo_bar"))
                && spans.iter().any(|s| matches!(s, MathInlineSpan::Link { label, url, .. } if label == "spec" && url == "cit://1"))
                && spans.iter().any(|s| matches!(s, MathInlineSpan::Text { text, .. } if text.contains("$5")))
        ));
        assert!(matches!(
            &chunks[3],
            MathChunk::InlineMathParagraph {
                kind: MathParagraphKind::ListItem { indent_level: 0, marker },
                ..
            } if marker == "•"
        ));
        assert!(matches!(
            &chunks[4],
            MathChunk::Markdown(md) if md.contains("- Regular bullet") && md.contains("| A | α + β |")
        ));
    }

    #[test]
    fn inline_markdown_preserves_snake_case_and_bold_around_math() {
        let spans = parse_inline_markdown_spans(
            "Use `a_b` and my_var_name with **bold $$x^2$$** end.",
            false,
        );
        assert!(spans.iter().any(|s| matches!(s, MathInlineSpan::Text { text, bold: false, italic: false } if text.contains("my_var_name"))));
        assert!(spans.iter().any(
            |s| matches!(s, MathInlineSpan::Text { text, bold: true, .. } if text == "bold ")
        ));
        assert!(
            spans
                .iter()
                .any(|s| matches!(s, MathInlineSpan::Math(t) if t == "x^2"))
        );
    }

    #[test]
    fn theme_color_linear_to_srgb_matches_dark_ink_and_cache_keys_distinguish_variants() {
        let dark_tokens = crate::theme::tokens(true);
        let light_tokens = crate::theme::tokens(false);
        let dark_ink = color_to_katex_srgb(dark_tokens.text_base);
        assert_eq!(
            (dark_ink.r, dark_ink.g, dark_ink.b, dark_ink.a),
            (233, 233, 231, 255)
        );

        let sync_display = resolve_math_formula(
            r"\frac{a}{b}",
            true,
            light_tokens.text_base,
            Some(2.0),
            DISPLAY_EM_PT,
            None,
        );
        let sync_inline = resolve_math_formula(
            r"\frac{a}{b}",
            false,
            light_tokens.text_base,
            Some(2.0),
            INLINE_EM_PT,
            None,
        );
        match (&sync_display, &sync_inline) {
            (
                MathRenderOutcome::Ready { height_pt: hd, .. },
                MathRenderOutcome::Ready { height_pt: hi, .. },
            ) => {
                assert!(
                    hd > hi,
                    "display math height {hd} should exceed inline {hi}"
                );
            }
            _ => panic!("expected synchronous Ready outcomes when waker is None"),
        }

        // Malformed LaTeX fails cleanly without panicking.
        assert!(matches!(
            resolve_math_formula(
                r"\frac{1}{",
                true,
                light_tokens.text_base,
                Some(2.0),
                DISPLAY_EM_PT,
                None
            ),
            MathRenderOutcome::Failed
        ));
        assert!(matches!(
            resolve_math_formula(
                r"\nonexistentmacro{x}",
                false,
                light_tokens.text_base,
                Some(2.0),
                INLINE_EM_PT,
                None
            ),
            MathRenderOutcome::Failed
        ));
    }

    #[test]
    fn async_worker_rasterizes_off_ui_thread_and_invokes_waker() {
        let (tx, rx) = mpsc::channel::<()>();
        let waker: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            let _ = tx.send(());
        });
        let light_tokens = crate::theme::tokens(false);
        let unique_tex = r"\sum_{k=1}^{7} \alpha_k^2";
        let first = resolve_math_formula(
            unique_tex,
            true,
            light_tokens.text_base,
            Some(2.0),
            DISPLAY_EM_PT,
            Some(&waker),
        );
        assert!(
            matches!(first, MathRenderOutcome::Pending { width_pt, height_pt, .. } if width_pt > 0.0 && height_pt > 0.0)
        );
        rx.recv_timeout(std::time::Duration::from_secs(5))
            .expect("background math worker should notify waker");
        let cached = resolve_math_formula(
            unique_tex,
            true,
            light_tokens.text_base,
            Some(2.0),
            DISPLAY_EM_PT,
            Some(&waker),
        );
        assert!(matches!(cached, MathRenderOutcome::Ready { .. }));
    }

    #[test]
    fn list_chunker_matches_commonmark_nesting_for_two_and_four_space_indents() {
        let src = "\
- Top plain
- Top $$\\alpha$$
  - Nested 2-space $$\\beta$$
    - Deep 4-space $$\\gamma$$
- Top 2
    - Nested 4-space direct $$\\delta$$
";
        let chunks = split_inline_math_chunks(src, false);
        let levels: Vec<(usize, String)> = chunks
            .into_iter()
            .filter_map(|c| match c {
                MathChunk::InlineMathParagraph {
                    kind:
                        MathParagraphKind::ListItem {
                            indent_level,
                            marker,
                        },
                    ..
                } => Some((indent_level, marker)),
                _ => None,
            })
            .collect();
        assert_eq!(
            levels,
            vec![
                (0, "•".to_string()),
                (1, "•".to_string()),
                (2, "•".to_string()),
                (1, "•".to_string()),
            ]
        );
    }
}
