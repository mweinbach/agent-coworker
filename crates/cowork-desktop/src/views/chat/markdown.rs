//! Desktop Markdown wrapper over `rune_kit::Markdown` plus citation chips and sources strip.

use std::borrow::Cow;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::rc::Rc;
use std::sync::Arc;

use rune::{
    Color, Cursor, El, ImageCache, LinkPaint, Span, TextStyle, Tx, col, icon, memo, row, spacer,
    text,
};
use rune_kit::{Button, ButtonVariant, ControlSize, Kit, Markdown, MarkdownStyle};

use crate::actions::{Action, NativeAction, ShellAction};
use crate::state::AppState;
use crate::theme::ThemeTokens;

use super::attachments::{
    decode_image_from_uri, image_decode_generation, resolve_lexical_local_path,
    resolve_safe_local_path,
};
use super::icons;
use super::math::{
    MathBlockSegment, MathChunk, MathParagraphKind, markdown_ends_with_list_item,
    markdown_starts_with_list_item, raster_generation, render_display_math_block,
    render_inline_math_paragraph, render_streaming_math_block, split_inline_math_chunks,
    split_math_blocks,
};
use super::model::display_domain;
use super::state::CitationSource;

const CITATION_SCHEME: &str = "cowork-citation:";
const WORKSPACE_FILE_SCHEME: &str = "cowork-file:";

pub type CopyStateCheck = Rc<dyn Fn(&str) -> bool>;
pub type CopyHandler = Rc<dyn Fn(&mut AppState, String, &mut Tx)>;
pub type CitationClickHandler = Rc<dyn Fn(&mut AppState, usize, &mut Tx)>;
type CitationClickRef<'a> = &'a dyn Fn(&mut AppState, usize, &mut Tx);

/// Optional interactive hooks supplied by parent chat rows (copy feedback & inline citation popovers).
#[derive(Clone, Default)]
pub struct MarkdownHooks {
    /// Returns true when the given block copy key (`"{msg_key}:code:{idx}"`) recently copied.
    pub is_copied: Option<CopyStateCheck>,
    /// Currently active copied key, if any, used to scope block-level streaming memo invalidation.
    pub active_copied_key: Option<String>,
    /// Called after copying a code or mermaid source block.
    pub on_copy: Option<CopyHandler>,
    /// Called when clicking a `cowork-citation:<index>` link chip.
    pub on_citation_click: Option<CitationClickHandler>,
    /// Main-loop waker invoked when background KaTeX rasterization finishes.
    pub math_waker: Option<Arc<dyn Fn() + Send + Sync>>,
    /// Effective oversampling scale factor (e.g. `(2.0 * ui_scale).clamp(2.0, 4.0)`).
    pub math_scale: Option<f32>,
}

/// Derives `MarkdownStyle` aligned with cowork's Electron theme tokens and type scale.
pub fn markdown_style(
    k: &Kit,
    t: &ThemeTokens,
    compact: bool,
    text_width: Option<f32>,
) -> MarkdownStyle {
    let body = if compact {
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
    let h1 = TextStyle {
        size: if compact { 15.0 } else { 18.0 },
        weight: 620.0,
        line_height: if compact { 21.0 } else { 25.0 },
        ..body
    };
    let h2 = TextStyle {
        size: if compact { 14.0 } else { 16.0 },
        weight: 600.0,
        line_height: if compact { 20.0 } else { 23.0 },
        ..body
    };
    let h3 = TextStyle {
        size: if compact { 13.0 } else { 14.5 },
        weight: 600.0,
        line_height: 21.0,
        ..body
    };

    let mut style = MarkdownStyle::from_kit(k)
        .text(t.text_base)
        .muted(t.text_muted)
        .link(t.accent)
        .link_hover(t.accent_hover)
        .inline_code_bg(t.code_bg)
        .inline_code_pad(1.5)
        .code_block(Color::TRANSPARENT, Color::TRANSPARENT)
        .code_block_padding(12.0, 10.0)
        .code_block_font(TextStyle {
            size: if compact { 12.0 } else { 12.5 },
            line_height: if compact { 18.0 } else { 19.0 },
            ..t.code
        })
        .code_margin(8.0, 12.0)
        .quote(t.border_strong, 2.5, 12.0, t.text_muted)
        .rule(t.border_muted)
        .body_font(body)
        .heading_font(1, h1)
        .heading_font(2, h2)
        .heading_font(3, h3)
        .selection(t.selection_bg)
        .diff(
            k.alpha(t.success, if t.dark { 0.14 } else { 0.12 }),
            k.alpha(t.danger, if t.dark { 0.14 } else { 0.12 }),
        )
        .diff_text_tint(0.45)
        .diff_hunk(t.text_muted)
        .diagram_surface(t.card_bg, t.border, t.elevated_bg);

    if let Some(w) = text_width {
        style = style.text_width(w);
    }
    style
}

/// Checks whether inline code looks like a workspace-relative or local path safe to preview.
pub fn resolve_workspace_code_link(raw_code: &str, base_path: Option<&str>) -> Option<String> {
    let token = raw_code.trim();
    if token.is_empty()
        || token.len() > 260
        || token.chars().any(char::is_whitespace)
        || token.contains("://")
        || token.starts_with('-')
    {
        return None;
    }

    let (path_only, _line_suffix) = strip_line_col_suffix(token);
    let looks_like_path = path_only.contains('/')
        || path_only.starts_with("./")
        || matches!(
            path_only
                .rsplit('.')
                .next()
                .map(|s| s.to_ascii_lowercase())
                .as_deref(),
            Some(
                "rs" | "ts"
                    | "tsx"
                    | "js"
                    | "jsx"
                    | "json"
                    | "toml"
                    | "md"
                    | "mdx"
                    | "py"
                    | "go"
                    | "css"
                    | "html"
                    | "yml"
                    | "yaml"
                    | "sh"
                    | "sql"
            )
        );
    if !looks_like_path {
        return None;
    }

    let resolved = resolve_lexical_local_path(path_only, base_path)?;
    Some(format!("{WORKSPACE_FILE_SCHEME}{}", resolved.display()))
}

fn strip_line_col_suffix(token: &str) -> (&str, Option<&str>) {
    if let Some((head, tail)) = token.rsplit_once(':')
        && !tail.is_empty()
        && tail.chars().all(|c| c.is_ascii_digit())
    {
        if let Some((head2, line)) = head.rsplit_once(':')
            && !line.is_empty()
            && line.chars().all(|c| c.is_ascii_digit())
        {
            return (head2, Some(line));
        }
        return (head, Some(tail));
    }
    (token, None)
}

/// Rewrites `[label](url)` links matching `citations` into `cowork-citation:<index>` pill targets
/// and strips unrendered provider citation PUA tokens (`\u{e200}cite...\u{e201}`) outside fences.
pub fn normalize_citation_links(src: &str, citations: &[CitationSource]) -> String {
    normalize_citation_links_cow(src, citations).into_owned()
}

fn normalize_citation_links_cow<'a>(src: &'a str, citations: &[CitationSource]) -> Cow<'a, str> {
    let has_pua_cite = src.contains('\u{e200}');
    if !has_pua_cite && (citations.is_empty() || !src.contains("](")) {
        return Cow::Borrowed(src);
    }

    let mut out = String::with_capacity(src.len());
    let mut in_fence = false;
    for segment in src.split_inclusive('\n') {
        let trimmed = segment.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            out.push_str(segment);
            continue;
        }
        if in_fence {
            out.push_str(segment);
            continue;
        }
        let cleaned: Cow<'_, str> = if has_pua_cite && segment.contains('\u{e200}') {
            Cow::Owned(strip_pua_citation_tokens(segment))
        } else {
            Cow::Borrowed(segment)
        };
        if !citations.is_empty() && cleaned.contains("](") {
            out.push_str(&rewrite_line_citations(&cleaned, citations));
        } else {
            out.push_str(&cleaned);
        }
    }
    Cow::Owned(out)
}

fn strip_pua_citation_tokens(segment: &str) -> String {
    let mut result = String::with_capacity(segment.len());
    let mut rest = segment;
    while let Some(start) = rest.find('\u{e200}') {
        let after_marker = start + '\u{e200}'.len_utf8();
        if let Some(end_rel) = rest[after_marker..].find('\u{e201}')
            && rest[after_marker..].starts_with("cite")
        {
            let before = &rest[..start];
            result.push_str(before.trim_end_matches([' ', '\t']));
            let after = after_marker + end_rel + '\u{e201}'.len_utf8();
            rest = &rest[after..];
        } else {
            result.push_str(&rest[..after_marker]);
            rest = &rest[after_marker..];
        }
    }
    result.push_str(rest);
    result
}

fn rewrite_line_citations(line: &str, citations: &[CitationSource]) -> String {
    let mut result = String::with_capacity(line.len());
    let mut cursor = 0;
    while cursor < line.len() {
        let Some(rel_open) = line[cursor..].find('[') else {
            result.push_str(&line[cursor..]);
            break;
        };
        let open_idx = cursor + rel_open;
        result.push_str(&line[cursor..open_idx]);
        let rest = &line[open_idx..];
        if let Some(close_bracket) = rest.find("](") {
            let label = &rest[1..close_bracket];
            let after_paren = &rest[close_bracket + 2..];
            if !label.contains('\n')
                && !label.is_empty()
                && let Some(close_paren) = after_paren.find(')')
            {
                let url = after_paren[..close_paren].trim();
                if let Some(cit_idx) = citations.iter().position(|c| c.url == url) {
                    let chip_label = if label.trim().is_empty() {
                        display_domain(url)
                    } else {
                        label.trim().to_string()
                    };
                    result.push('[');
                    result.push_str(&chip_label);
                    result.push_str("](");
                    result.push_str(CITATION_SCHEME);
                    result.push_str(&cit_idx.to_string());
                    result.push(')');
                    cursor = open_idx + close_bracket + 2 + close_paren + 1;
                    continue;
                }
            }
        }
        result.push('[');
        cursor = open_idx + 1;
    }
    result
}

fn color_bits(c: Color) -> (u32, u32, u32, u32) {
    (c.r.to_bits(), c.g.to_bits(), c.b.to_bits(), c.a.to_bits())
}

#[allow(clippy::too_many_arguments)]
fn markdown_context_signature(
    t: &ThemeTokens,
    compact: bool,
    reduce_motion: bool,
    workspace_id: Option<&str>,
    workspace_path: Option<&str>,
    citations: &[CitationSource],
    external_cache: Option<&Arc<ImageCache>>,
    hooks: &MarkdownHooks,
) -> u64 {
    let mut h = DefaultHasher::new();
    (
        t.dark,
        color_bits(t.text_base),
        color_bits(t.text_muted),
        color_bits(t.accent),
        color_bits(t.code_bg),
        color_bits(t.card_bg),
        color_bits(t.border_muted),
        color_bits(t.panel_bg),
        color_bits(t.selection_bg),
    )
        .hash(&mut h);
    (
        compact,
        reduce_motion,
        workspace_id,
        workspace_path,
        external_cache.map(|c| Arc::as_ptr(c) as usize),
        hooks.math_waker.is_some(),
        hooks.math_scale.map(f32::to_bits),
    )
        .hash(&mut h);
    citations.len().hash(&mut h);
    for c in citations {
        c.url.hash(&mut h);
        c.title.hash(&mut h);
    }
    h.finish()
}

fn md_leading_spaces_up_to_3(s: &str) -> Option<&str> {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() && bytes[i] == b' ' {
        i += 1;
        if i > 3 {
            return None;
        }
    }
    if bytes.get(i) == Some(&b'\t') {
        return None;
    }
    Some(&s[i..])
}

fn md_strip_list_marker(trimmed: &str) -> Option<&str> {
    if let Some(rest) = trimmed
        .strip_prefix("- ")
        .or_else(|| trimmed.strip_prefix("* "))
        .or_else(|| trimmed.strip_prefix("+ "))
        .or_else(|| trimmed.strip_prefix("-\t"))
        .or_else(|| trimmed.strip_prefix("*\t"))
        .or_else(|| trimmed.strip_prefix("+\t"))
    {
        return Some(rest);
    }
    if matches!(trimmed, "-" | "*" | "+") {
        return Some("");
    }
    let digits = trimmed.bytes().take_while(|b| b.is_ascii_digit()).count();
    if (1..=9).contains(&digits) {
        let after = &trimmed.as_bytes()[digits..];
        if let Some(&delim) = after.first()
            && (delim == b'.' || delim == b')')
        {
            return match after.get(1) {
                None => Some(""),
                Some(b' ' | b'\t') => Some(&trimmed[digits + 2..]),
                _ => None,
            };
        }
    }
    None
}

/// Strips CommonMark blockquote (`>`) and list-item (`- `, `1. `) container prefixes together with
/// valid leading indentation. Returns `None` for top-level 4+ space indented code lines outside
/// lists/blockquotes so indented code blocks are not misclassified as fences or reference defs.
fn md_strip_containers(stripped: &str, in_list: bool) -> Option<(&str, bool)> {
    let mut cur = stripped;
    let mut in_container = in_list;
    loop {
        if let Some(after_sp) = md_leading_spaces_up_to_3(cur)
            && let Some(after_gt) = after_sp.strip_prefix('>')
        {
            cur = after_gt.strip_prefix(' ').unwrap_or(after_gt);
            in_container = true;
            continue;
        }
        let trimmed_sp = if in_container {
            cur.trim_start_matches([' ', '\t'])
        } else {
            md_leading_spaces_up_to_3(cur)?
        };
        if let Some(after_marker) = md_strip_list_marker(trimmed_sp) {
            cur = after_marker;
            in_container = true;
            continue;
        }
        return Some((trimmed_sp, in_container));
    }
}

fn md_fence_opener(stripped: &str, in_list: bool) -> Option<(u8, usize, bool)> {
    let (rest, in_container) = md_strip_containers(stripped, in_list)?;
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
    Some((ch, count, in_container))
}

fn md_fence_closer(stripped: &str, ch: u8, min_len: usize, in_container: bool) -> bool {
    let mut cur = stripped;
    while let Some(after_sp) = md_leading_spaces_up_to_3(cur)
        && let Some(after_gt) = after_sp.strip_prefix('>')
    {
        cur = after_gt.strip_prefix(' ').unwrap_or(after_gt);
    }
    let rest = if in_container {
        cur.trim_start_matches([' ', '\t'])
    } else {
        match md_leading_spaces_up_to_3(cur) {
            Some(r) => r,
            None => return false,
        }
    };
    let bytes = rest.as_bytes();
    let count = bytes.iter().take_while(|&&b| b == ch).count();
    count >= min_len && bytes[count..].iter().all(|&b| b == b' ' || b == b'\t')
}

fn md_is_display_math_fence(stripped: &str, in_list: bool) -> bool {
    let Some((rest, _)) = md_strip_containers(stripped, in_list) else {
        return false;
    };
    let Some(after) = rest.strip_prefix("$$") else {
        return false;
    };
    after.bytes().all(|b| b == b' ' || b == b'\t')
}

fn md_is_list_item(stripped: &str) -> bool {
    let trimmed = stripped.trim_start_matches(' ');
    md_strip_list_marker(trimmed).is_some()
}

fn md_is_quote_line(stripped: &str) -> bool {
    md_leading_spaces_up_to_3(stripped).is_some_and(|rest| rest.starts_with('>'))
}

fn md_has_link_ref_def(lines: &[(usize, &str)]) -> bool {
    let mut scan_fence: Option<(u8, usize, bool)> = None;
    let mut scan_in_list = false;
    let mut scan_after_blank = false;
    let mut open_ref_label = false;

    for &(_, line) in lines {
        let stripped = line.trim_end_matches(['\n', '\r']);
        let is_blank = stripped.bytes().all(|b| b == b' ' || b == b'\t');
        if let Some((ch, min_len, in_container)) = scan_fence {
            if md_fence_closer(stripped, ch, min_len, in_container) {
                scan_fence = None;
            }
            continue;
        }
        if is_blank {
            scan_after_blank = true;
            open_ref_label = false;
            continue;
        }
        if scan_after_blank
            && !stripped.starts_with("  ")
            && !stripped.starts_with('\t')
            && !md_is_list_item(stripped)
        {
            scan_in_list = false;
        }
        scan_after_blank = false;
        if md_is_list_item(stripped) {
            scan_in_list = true;
        }
        if let Some(open) = md_fence_opener(stripped, scan_in_list) {
            scan_fence = Some(open);
            open_ref_label = false;
            continue;
        }
        let Some((rest, _)) = md_strip_containers(stripped, scan_in_list) else {
            open_ref_label = false;
            continue;
        };
        if rest.starts_with('[') {
            if rest.contains("]:") {
                return true;
            }
            open_ref_label = !rest.contains(']');
        } else if open_ref_label {
            if rest.contains("]:") {
                return true;
            }
            if rest.contains(']') {
                open_ref_label = false;
            }
        }
    }
    false
}

/// Splits Markdown into stable top-level byte ranges `(start, end)` at blank lines outside open
/// code fences, display math blocks, loose lists, blockquotes, and indented continuations.
/// Keeps documents containing reference link/footnote definitions (`[id]: ...`) intact as one range.
pub(super) fn split_markdown_block_ranges(src: &str) -> Vec<(usize, usize)> {
    if src.is_empty() {
        return Vec::new();
    }
    if !src.contains('\n') {
        return vec![(0, src.len())];
    }

    let mut lines: Vec<(usize, &str)> = Vec::new();
    let mut offset = 0usize;
    for line in src.split_inclusive('\n') {
        lines.push((offset, line));
        offset += line.len();
    }

    // If the document contains reference-style link or footnote definitions outside fences,
    // keep it intact so cross-block references resolve.
    if md_has_link_ref_def(&lines) {
        return vec![(0, src.len())];
    }

    let mut blocks: Vec<(usize, usize)> = Vec::new();
    let mut fence: Option<(u8, usize, bool)> = None;
    let mut in_display_math = false;
    let mut block_start: Option<usize> = None;
    let mut block_end = 0usize;
    let mut in_list = false;
    let mut in_quote = false;

    for (idx, &(line_start, line)) in lines.iter().enumerate() {
        let stripped = line.trim_end_matches(['\n', '\r']);
        let is_blank = stripped.bytes().all(|b| b == b' ' || b == b'\t');

        if let Some((ch, min_len, in_container)) = fence {
            if block_start.is_none() {
                block_start = Some(line_start);
            }
            block_end = line_start + line.len();
            if md_fence_closer(stripped, ch, min_len, in_container) {
                fence = None;
            }
            continue;
        }

        if in_display_math {
            if block_start.is_none() {
                block_start = Some(line_start);
            }
            block_end = line_start + line.len();
            if md_is_display_math_fence(stripped, in_list) {
                in_display_math = false;
            }
            continue;
        }

        if is_blank {
            if let Some(start) = block_start {
                let next_non_blank = lines[idx + 1..].iter().find_map(|&(_, next_line)| {
                    let s = next_line.trim_end_matches(['\n', '\r']);
                    (!s.bytes().all(|b| b == b' ' || b == b'\t')).then_some(s)
                });
                if let Some(next_s) = next_non_blank {
                    let indented_cont = next_s.starts_with("  ") || next_s.starts_with('\t');
                    let list_cont = in_list && (md_is_list_item(next_s) || indented_cont);
                    let quote_cont = in_quote && md_is_quote_line(next_s);
                    if !indented_cont && !list_cont && !quote_cont {
                        let slice = src[start..block_end].trim_end_matches(['\n', '\r']);
                        if !slice.is_empty() {
                            blocks.push((start, start + slice.len()));
                        }
                        block_start = None;
                        in_list = false;
                        in_quote = false;
                    }
                }
            }
            continue;
        }

        if block_start.is_none() {
            block_start = Some(line_start);
            in_list = md_is_list_item(stripped);
            in_quote = md_is_quote_line(stripped);
        } else {
            if md_is_list_item(stripped) {
                in_list = true;
            }
            if md_is_quote_line(stripped) {
                in_quote = true;
            }
        }

        if let Some(open) = md_fence_opener(stripped, in_list) {
            fence = Some(open);
        } else if md_is_display_math_fence(stripped, in_list) {
            in_display_math = true;
        }
        block_end = line_start + line.len();
    }

    if let Some(start) = block_start {
        let tail = &src[start..];
        if !tail.trim().is_empty() {
            blocks.push((start, src.len()));
        }
    }

    if blocks.is_empty() {
        vec![(0, src.len())]
    } else {
        blocks
    }
}

/// Splits streaming Markdown into stable top-level blocks so settled prefix blocks can be
/// memoized while only the active tail re-parses per delta.
fn split_streaming_markdown_blocks(src: &str) -> Vec<&str> {
    split_markdown_block_ranges(src)
        .into_iter()
        .map(|(start, end)| &src[start..end])
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn render_plain_markdown(
    k: &Kit,
    t: &ThemeTokens,
    normalized: Cow<'_, str>,
    key_prefix: &str,
    compact: bool,
    streaming: bool,
    reduce_motion: bool,
    workspace_id: Option<&str>,
    workspace_path: Option<&str>,
    citations: &[CitationSource],
    external_cache: Option<Arc<ImageCache>>,
    hooks: &MarkdownHooks,
) -> El {
    if streaming {
        let blocks = split_streaming_markdown_blocks(&normalized);
        if blocks.len() > 1 {
            let ctx_sig = markdown_context_signature(
                t,
                compact,
                reduce_motion,
                workspace_id,
                workspace_path,
                citations,
                external_cache.as_ref(),
                hooks,
            );
            let last_idx = blocks.len() - 1;
            let mut stack = col()
                .key(format!("{key_prefix}:stream-blocks"))
                .w_full()
                .gap(if compact { 6.0 } else { 10.0 });
            for (idx, block_str) in blocks.into_iter().enumerate() {
                let block_key = format!("{key_prefix}:sb:{idx}");
                if idx < last_idx {
                    let scoped_copied = hooks
                        .active_copied_key
                        .as_deref()
                        .filter(|ck| ck.starts_with(&block_key));
                    let img_gen = if block_str.contains("![") {
                        image_decode_generation()
                    } else {
                        0
                    };
                    let mut h = DefaultHasher::new();
                    (ctx_sig, block_str, scoped_copied, img_gen).hash(&mut h);
                    let ver = h.finish();
                    let block_el = memo(block_key.as_str(), ver, || {
                        col().w_full().child(desktop_markdown_chunk(
                            k,
                            t,
                            block_str.to_owned(),
                            &block_key,
                            compact,
                            false,
                            reduce_motion,
                            workspace_id,
                            workspace_path,
                            citations,
                            external_cache.clone(),
                            hooks,
                        ))
                    });
                    stack = stack.child(block_el);
                } else {
                    let tail_el =
                        col()
                            .key(block_key.as_str())
                            .w_full()
                            .child(desktop_markdown_chunk(
                                k,
                                t,
                                block_str.to_owned(),
                                &block_key,
                                compact,
                                true,
                                reduce_motion,
                                workspace_id,
                                workspace_path,
                                citations,
                                external_cache.clone(),
                                hooks,
                            ));
                    stack = stack.child(tail_el);
                }
            }
            return stack;
        }
    }

    desktop_markdown_chunk(
        k,
        t,
        normalized.into_owned(),
        key_prefix,
        compact,
        streaming,
        reduce_motion,
        workspace_id,
        workspace_path,
        citations,
        external_cache,
        hooks,
    )
}

enum PreparedMathBlock {
    DisplayMath(String),
    StreamingMath(String),
    Chunks(Vec<MathChunk>),
}

/// Renders assistant, reasoning, or tool Markdown with syntax-highlighted code copy headers,
/// native Mermaid diagram frames, workspace path links, external URL confirmation, and citation chips.
#[allow(clippy::too_many_arguments)]
pub fn desktop_markdown(
    k: &Kit,
    t: &ThemeTokens,
    src: &str,
    key_prefix: &str,
    compact: bool,
    streaming: bool,
    reduce_motion: bool,
    workspace_id: Option<&str>,
    workspace_path: Option<&str>,
    citations: &[CitationSource],
    external_cache: Option<Arc<ImageCache>>,
    hooks: MarkdownHooks,
) -> El {
    let normalized = normalize_citation_links_cow(src, citations);
    if normalized.contains("$$") {
        let block_segments = split_math_blocks(&normalized, streaming);
        let prepared_blocks: Option<Vec<PreparedMathBlock>> = if block_segments.len() == 1
            && let MathBlockSegment::Markdown(md) = &block_segments[0]
        {
            let chunks = split_inline_math_chunks(md, streaming);
            if matches!(chunks.as_slice(), [MathChunk::Markdown(inner)] if inner == md) {
                None
            } else {
                Some(vec![PreparedMathBlock::Chunks(chunks)])
            }
        } else {
            Some(
                block_segments
                    .into_iter()
                    .map(|seg| match seg {
                        MathBlockSegment::DisplayMath(tex) => PreparedMathBlock::DisplayMath(tex),
                        MathBlockSegment::StreamingMath(tex) => {
                            PreparedMathBlock::StreamingMath(tex)
                        }
                        MathBlockSegment::Markdown(md) => {
                            PreparedMathBlock::Chunks(split_inline_math_chunks(&md, streaming))
                        }
                    })
                    .collect(),
            )
        };

        if let Some(prepared_blocks) = prepared_blocks {
            let ctx_sig = streaming.then(|| {
                markdown_context_signature(
                    t,
                    compact,
                    reduce_motion,
                    workspace_id,
                    workspace_path,
                    citations,
                    external_cache.as_ref(),
                    &hooks,
                )
            });
            let raster_gen = if streaming { raster_generation() } else { 0 };
            let ws_id_cb = workspace_id.map(str::to_owned);
            let ws_path_cb = workspace_path.map(str::to_owned);
            let on_cit_cb = hooks.on_citation_click.clone();
            let on_link = move |s: &mut AppState, url: String, tx: &mut Tx| {
                dispatch_link_action(
                    s,
                    &url,
                    ws_id_cb.as_deref(),
                    ws_path_cb.as_deref(),
                    on_cit_cb.as_deref(),
                    Some(tx),
                );
            };
            let mut children = Vec::new();
            let block_gap = if compact { 6.0 } else { 10.0 };
            let mut prev_ended_list = false;
            let mut push_child = |el: El, starts_list: bool, ends_list: bool| {
                let el = if children.is_empty() {
                    el
                } else if prev_ended_list && starts_list {
                    el.mt(4.0)
                } else {
                    el.mt(block_gap)
                };
                children.push(el);
                prev_ended_list = ends_list;
            };

            let last_b = prepared_blocks.len().saturating_sub(1);
            for (b_idx, block) in prepared_blocks.into_iter().enumerate() {
                match block {
                    PreparedMathBlock::DisplayMath(tex) => {
                        let block_key = format!("{key_prefix}:math:{b_idx}");
                        let node = if let Some(csig) = ctx_sig {
                            let mut h = DefaultHasher::new();
                            (csig, &tex, raster_gen).hash(&mut h);
                            memo(block_key.as_str(), h.finish(), || {
                                render_display_math_block(
                                    k,
                                    t,
                                    &tex,
                                    compact,
                                    hooks.math_scale,
                                    hooks.math_waker.as_ref(),
                                    &block_key,
                                )
                            })
                        } else {
                            render_display_math_block(
                                k,
                                t,
                                &tex,
                                compact,
                                hooks.math_scale,
                                hooks.math_waker.as_ref(),
                                &block_key,
                            )
                        };
                        push_child(node, false, false);
                    }
                    PreparedMathBlock::StreamingMath(tex) => {
                        push_child(
                            render_streaming_math_block(
                                k,
                                t,
                                &tex,
                                &format!("{key_prefix}:smath:{b_idx}"),
                            ),
                            false,
                            false,
                        );
                    }
                    PreparedMathBlock::Chunks(chunks) => {
                        let last_c = chunks.len().saturating_sub(1);
                        for (c_idx, chunk) in chunks.into_iter().enumerate() {
                            let is_settled = streaming && (b_idx < last_b || c_idx < last_c);
                            match chunk {
                                MathChunk::Markdown(sub_md) => {
                                    if sub_md.trim().is_empty() {
                                        continue;
                                    }
                                    let starts_list = markdown_starts_with_list_item(&sub_md);
                                    let ends_list = markdown_ends_with_list_item(&sub_md);
                                    let chunk_key = format!("{key_prefix}:mc:{b_idx}:{c_idx}");
                                    let node = if is_settled && let Some(csig) = ctx_sig {
                                        let scoped_copied = hooks
                                            .active_copied_key
                                            .as_deref()
                                            .filter(|ck| ck.starts_with(&chunk_key));
                                        let img_gen = if sub_md.contains("![") {
                                            image_decode_generation()
                                        } else {
                                            0
                                        };
                                        let mut h = DefaultHasher::new();
                                        (csig, &sub_md, scoped_copied, img_gen).hash(&mut h);
                                        memo(chunk_key.as_str(), h.finish(), || {
                                            col().w_full().child(desktop_markdown_chunk(
                                                k,
                                                t,
                                                sub_md.clone(),
                                                &chunk_key,
                                                compact,
                                                false,
                                                reduce_motion,
                                                workspace_id,
                                                workspace_path,
                                                citations,
                                                external_cache.clone(),
                                                &hooks,
                                            ))
                                        })
                                    } else {
                                        render_plain_markdown(
                                            k,
                                            t,
                                            Cow::Owned(sub_md),
                                            &chunk_key,
                                            compact,
                                            streaming,
                                            reduce_motion,
                                            workspace_id,
                                            workspace_path,
                                            citations,
                                            external_cache.clone(),
                                            &hooks,
                                        )
                                    };
                                    push_child(node, starts_list, ends_list);
                                }
                                MathChunk::IndentedMarkdown {
                                    indent_level,
                                    markdown: sub_md,
                                    ..
                                } => {
                                    if sub_md.trim().is_empty() {
                                        continue;
                                    }
                                    let chunk_key = format!("{key_prefix}:imc:{b_idx}:{c_idx}");
                                    let chunk_el = if is_settled && let Some(csig) = ctx_sig {
                                        let scoped_copied = hooks
                                            .active_copied_key
                                            .as_deref()
                                            .filter(|ck| ck.starts_with(&chunk_key));
                                        let img_gen = if sub_md.contains("![") {
                                            image_decode_generation()
                                        } else {
                                            0
                                        };
                                        let mut h = DefaultHasher::new();
                                        (csig, &sub_md, scoped_copied, img_gen).hash(&mut h);
                                        memo(chunk_key.as_str(), h.finish(), || {
                                            col().w_full().child(desktop_markdown_chunk(
                                                k,
                                                t,
                                                sub_md.clone(),
                                                &chunk_key,
                                                compact,
                                                false,
                                                reduce_motion,
                                                workspace_id,
                                                workspace_path,
                                                citations,
                                                external_cache.clone(),
                                                &hooks,
                                            ))
                                        })
                                    } else {
                                        desktop_markdown_chunk(
                                            k,
                                            t,
                                            sub_md,
                                            &chunk_key,
                                            compact,
                                            streaming,
                                            reduce_motion,
                                            workspace_id,
                                            workspace_path,
                                            citations,
                                            external_cache.clone(),
                                            &hooks,
                                        )
                                    };
                                    push_child(
                                        col()
                                            .key(format!("{key_prefix}:imw:{b_idx}:{c_idx}"))
                                            .w_full()
                                            .pl((indent_level as f32) * 32.0)
                                            .child(chunk_el),
                                        true,
                                        true,
                                    );
                                }
                                MathChunk::InlineMathParagraph { kind, spans } => {
                                    let is_list =
                                        matches!(kind, MathParagraphKind::ListItem { .. });
                                    let imp_key = format!("{key_prefix}:imp:{b_idx}:{c_idx}");
                                    let node = if is_settled && let Some(csig) = ctx_sig {
                                        let mut h = DefaultHasher::new();
                                        (csig, &kind, &spans, raster_gen).hash(&mut h);
                                        let imp_memo_key = match kind {
                                            MathParagraphKind::Paragraph => {
                                                format!("{imp_key}:flow")
                                            }
                                            _ => imp_key.clone(),
                                        };
                                        memo(imp_memo_key.as_str(), h.finish(), || {
                                            render_inline_math_paragraph(
                                                k,
                                                t,
                                                &kind,
                                                &spans,
                                                compact,
                                                hooks.math_scale,
                                                hooks.math_waker.as_ref(),
                                                &imp_key,
                                                &on_link,
                                            )
                                        })
                                    } else {
                                        render_inline_math_paragraph(
                                            k,
                                            t,
                                            &kind,
                                            &spans,
                                            compact,
                                            hooks.math_scale,
                                            hooks.math_waker.as_ref(),
                                            &imp_key,
                                            &on_link,
                                        )
                                    };
                                    push_child(node, is_list, is_list);
                                }
                            }
                        }
                    }
                }
            }
            return col()
                .key(format!("{key_prefix}:math-root"))
                .w_full()
                .children(children);
        }
    }

    render_plain_markdown(
        k,
        t,
        normalized,
        key_prefix,
        compact,
        streaming,
        reduce_motion,
        workspace_id,
        workspace_path,
        citations,
        external_cache,
        &hooks,
    )
}

#[allow(clippy::too_many_arguments)]
fn desktop_markdown_chunk(
    k: &Kit,
    t: &ThemeTokens,
    normalized: String,
    key_prefix: &str,
    compact: bool,
    streaming: bool,
    reduce_motion: bool,
    workspace_id: Option<&str>,
    workspace_path: Option<&str>,
    citations: &[CitationSource],
    external_cache: Option<Arc<ImageCache>>,
    hooks: &MarkdownHooks,
) -> El {
    let style = markdown_style(k, t, compact, None);

    let ws_id_link = workspace_id.map(str::to_owned);
    let ws_path_link = workspace_path.map(str::to_owned);
    let ws_id_img = workspace_id.map(str::to_owned);
    let ws_path_img = workspace_path.map(str::to_owned);
    let ws_path_img_decode = ws_path_img.clone();
    let ws_path_code = workspace_path.map(str::to_owned);
    let citations_help: Vec<CitationSource> = citations.to_vec();
    let hooks_link = hooks.clone();

    let chip_bg = k.alpha(t.elevated_bg, 0.9);
    let chip_hover_bg = t.hover;
    let chip_border = t.border;
    let chip_fg = t.text_muted;
    let chip_hover_fg = t.text_base;
    let accent = t.accent;

    let is_copied_code = hooks.is_copied.clone();
    let on_copy_code = hooks.on_copy.clone();
    let key_code = key_prefix.to_owned();
    let kit_code = k.clone();
    let tok_code = *t;

    let is_copied_diag = hooks.is_copied.clone();
    let on_copy_diag = hooks.on_copy.clone();
    let key_diag = key_prefix.to_owned();
    let kit_diag = k.clone();
    let tok_diag = *t;

    let external_cache_owned = external_cache;

    let md = Markdown::new(normalized)
        .style(style)
        .streaming(streaming)
        .reveal(if streaming && !reduce_motion {
            0.16
        } else {
            0.0
        })
        .selectable(true)
        .scroll_wide(true)
        .code_link(t.accent, move |inline_code| {
            resolve_workspace_code_link(inline_code, ws_path_code.as_deref())
        })
        .link_style(move |dest| {
            if dest.starts_with(CITATION_SCHEME) {
                Some((
                    Span::new(0, 0)
                        .color(chip_fg)
                        .bg(chip_bg, 5.0)
                        .size(11.5)
                        .weight(500.0),
                    LinkPaint::new()
                        .color(chip_hover_fg)
                        .bg(chip_hover_bg)
                        .ring(accent, 1.0),
                ))
            } else {
                None
            }
        })
        .link_ring(move |dest| {
            if dest.starts_with(CITATION_SCHEME) {
                Some((chip_border, 1.0))
            } else {
                None
            }
        })
        .link_help(move |dest| {
            if let Some(rest) = dest.strip_prefix(CITATION_SCHEME)
                && let Ok(idx) = rest.parse::<usize>()
                && let Some(source) = citations_help.get(idx)
            {
                return Some(match &source.title {
                    Some(title) if !title.trim().is_empty() => format!("{title} — {}", source.url),
                    _ => source.url.clone(),
                });
            }
            dest.strip_prefix(WORKSPACE_FILE_SCHEME)
                .map(|p| p.to_string())
                .or_else(|| Some(dest.to_string()))
        })
        .images(move |img_src| {
            decode_image_from_uri(
                img_src,
                ws_path_img_decode.as_deref(),
                external_cache_owned.as_deref(),
            )
        })
        .image_frame(move |img_el, frame| {
            let styled = img_el
                .max_h(420.0)
                .radius(8.0)
                .border(1.0, Color::TRANSPARENT);
            let can_open = !frame.src.trim_start().starts_with("data:")
                && (is_allowed_external_url(frame.src)
                    || resolve_safe_workspace_file_link(frame.src, ws_path_img.as_deref())
                        .is_some()
                    || resolve_safe_local_path(frame.src, ws_path_img.as_deref()).is_some());
            if !can_open {
                return styled;
            }
            let src_open = frame.src.to_string();
            let ws_id = ws_id_img.clone();
            let ws_path = ws_path_img.clone();
            styled
                .cursor(Cursor::Pointer)
                .on_press_tx(move |s: &mut AppState, _tx| {
                    dispatch_link_action(
                        s,
                        &src_open,
                        ws_id.as_deref(),
                        ws_path.as_deref(),
                        None,
                        None,
                    );
                })
        })
        .code_frame(move |card, frame| {
            let lang_label = frame
                .language
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .unwrap_or("code")
                .to_string();
            let block_key = format!("{key_code}:code:{}", frame.index);
            let copied = is_copied_code.as_ref().is_some_and(|f| f(&block_key));
            let source_text = frame.source.to_string();
            let on_copy = on_copy_code.clone();
            let block_key_cb = block_key.clone();

            let copy_btn = Button::new(if copied { "Copied" } else { "Copy" })
                .variant(ButtonVariant::Ghost)
                .control_size(ControlSize::Small)
                .icon(if copied {
                    kit_code.glyph.check
                } else {
                    kit_code.glyph.copy
                })
                .on_press_tx(move |s: &mut AppState, tx| {
                    tx.copy(source_text.clone());
                    if let Some(cb) = &on_copy {
                        cb(s, block_key_cb.clone(), tx);
                    }
                })
                .build(&kit_code);

            let header = row()
                .w_full()
                .items_center()
                .px(12.0)
                .py(3.0)
                .child(
                    text(lang_label)
                        .font(kit_code.ty.mono)
                        .color(tok_code.text_faint),
                )
                .child(spacer())
                .child(copy_btn);

            col()
                .key(block_key)
                .w_full()
                .radius(10.0)
                .fill(tok_code.code_bg)
                .border(1.0, tok_code.border_muted)
                .border_layout()
                .clip_rounded(10.0)
                .child(header)
                .child(rune::el().w_full().h(1.0).fill(tok_code.border_muted))
                .child(card)
        })
        .on_link_tx(move |s: &mut AppState, url, tx| {
            dispatch_link_action(
                s,
                url,
                ws_id_link.as_deref(),
                ws_path_link.as_deref(),
                hooks_link.on_citation_click.as_deref(),
                Some(tx),
            );
        })
        .diagram_frame(move |card, frame| {
            let block_key = format!("{key_diag}:diagram:{}", frame.index);
            let copied = is_copied_diag.as_ref().is_some_and(|f| f(&block_key));
            let source_text = frame.source.to_string();
            let on_copy = on_copy_diag.clone();
            let block_key_cb = block_key.clone();

            let copy_btn = Button::new(if copied { "Copied" } else { "Copy source" })
                .variant(ButtonVariant::Ghost)
                .control_size(ControlSize::Small)
                .icon(if copied {
                    kit_diag.glyph.check
                } else {
                    kit_diag.glyph.copy
                })
                .on_press_tx(move |s: &mut AppState, tx| {
                    tx.copy(source_text.clone());
                    if let Some(cb) = &on_copy {
                        cb(s, block_key_cb.clone(), tx);
                    }
                })
                .build(&kit_diag);

            let header = row()
                .w_full()
                .items_center()
                .px(12.0)
                .py(3.0)
                .child(
                    text("Diagram")
                        .font(kit_diag.ty.small_medium)
                        .color(tok_diag.text_faint),
                )
                .child(spacer())
                .child(copy_btn);

            col()
                .key(block_key)
                .w_full()
                .radius(10.0)
                .fill(tok_diag.card_bg)
                .border(1.0, tok_diag.border_muted)
                .border_layout()
                .clip_rounded(10.0)
                .child(header)
                .child(rune::el().w_full().h(1.0).fill(tok_diag.border_muted))
                .child(card)
        });

    md.build(k)
}

pub(super) fn is_allowed_external_url(raw: &str) -> bool {
    url::Url::parse(raw.trim()).is_ok_and(|u| matches!(u.scheme(), "http" | "https" | "mailto"))
}

fn resolve_safe_workspace_file_link(
    url: &str,
    workspace_path: Option<&str>,
) -> Option<std::path::PathBuf> {
    let raw_file = url.strip_prefix(WORKSPACE_FILE_SCHEME)?;
    resolve_safe_local_path(raw_file, workspace_path)
}

fn dispatch_link_action(
    s: &mut AppState,
    url: &str,
    workspace_id: Option<&str>,
    workspace_path: Option<&str>,
    on_citation: Option<CitationClickRef<'_>>,
    tx: Option<&mut Tx>,
) {
    if let Some(rest) = url.strip_prefix(CITATION_SCHEME) {
        if let Ok(idx) = rest.parse::<usize>()
            && let (Some(cb), Some(tx)) = (on_citation, tx)
        {
            cb(s, idx, tx);
        }
        return;
    }

    if url.starts_with(WORKSPACE_FILE_SCHEME) {
        if let (Some(ws_id), Some(safe_path)) = (
            workspace_id,
            resolve_safe_workspace_file_link(url, workspace_path),
        ) {
            s.dispatch(Action::Native(NativeAction::LoadFilePreview {
                workspace_id: ws_id.to_string(),
                path: safe_path.to_string_lossy().into_owned(),
            }));
        }
        return;
    }

    if let Some(local_path) = resolve_safe_local_path(url, workspace_path)
        && let Some(ws_id) = workspace_id
    {
        s.dispatch(Action::Native(NativeAction::LoadFilePreview {
            workspace_id: ws_id.to_string(),
            path: local_path.to_string_lossy().into_owned(),
        }));
        return;
    }

    if is_allowed_external_url(url) {
        s.dispatch(Action::Shell(ShellAction::RequestExternalUrl(
            url.trim().to_string(),
        )));
    }
}

/// Renders the expandable bottom `Sources` pill and horizontal strip of external citation cards.
pub fn citation_sources_carousel(
    k: &Kit,
    t: &ThemeTokens,
    sources: &[CitationSource],
    message_key: &str,
    expanded: bool,
    on_toggle: impl Fn(&mut AppState, String) + 'static,
) -> Option<El> {
    if sources.is_empty() {
        return None;
    }

    let toggle_key = message_key.to_string();
    let count = sources.len();
    let label = if count == 1 {
        "1 source".to_string()
    } else {
        format!("{count} sources")
    };

    let trigger = Button::new(label)
        .variant(ButtonVariant::Ghost)
        .control_size(ControlSize::Small)
        .icon(&icons::GLOBE)
        .expanded(expanded)
        .on_press(move |s: &mut AppState| on_toggle(s, toggle_key.clone()))
        .build(k);

    let mut container = col()
        .key(format!("{message_key}:sources"))
        .w_full()
        .gap(8.0)
        .child(row().items_center().child(trigger));

    if expanded {
        let mut strip = row().w_full().flex_wrap().gap(8.0);
        for (idx, source) in sources.iter().enumerate() {
            let domain = display_domain(&source.url);
            let title_text = source
                .title
                .as_deref()
                .map(str::trim)
                .filter(|t| !t.is_empty())
                .unwrap_or(&domain)
                .to_string();
            let open_url = source.url.clone();

            let mut card = col()
                .key(format!("{message_key}:src:{idx}"))
                .w(212.0)
                .gap(4.0)
                .px(10.0)
                .py(8.0)
                .radius(10.0)
                .fill(t.card_bg)
                .focusable(true)
                .border(1.0, t.border_muted)
                .help(source.url.clone());
            card = k.interactive_with(card, t.elevated_bg, t.pressed);
            if is_allowed_external_url(&open_url) {
                card = card
                    .cursor(Cursor::Pointer)
                    .on_press(move |s: &mut AppState| {
                        s.dispatch(Action::Shell(ShellAction::RequestExternalUrl(
                            open_url.clone(),
                        )));
                    });
            }
            card = card
                .child(
                    row()
                        .w_full()
                        .items_center()
                        .gap(6.0)
                        .child(icon(&icons::GLOBE, 12.0).color(t.text_muted))
                        .child(
                            text(domain)
                                .font(k.ty.small_medium)
                                .color(t.text_muted)
                                .truncate()
                                .grow(1.0),
                        )
                        .child(icon(&icons::EXTERNAL_LINK, 11.0).color(t.text_faint)),
                )
                .child(
                    text(title_text)
                        .font(k.ty.text_xsmall)
                        .color(t.text_base)
                        .wrap()
                        .max_lines(2),
                );
            strip = strip.child(card);
        }
        container = container.child(strip);
    }

    Some(container)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_citation_links_rewrites_matching_urls_outside_fences() {
        let citations = vec![CitationSource {
            url: "https://docs.example.com/guide".to_string(),
            title: Some("Example Guide".to_string()),
        }];
        let input = "See [docs](https://docs.example.com/guide).\n```md\n[code](https://docs.example.com/guide)\n```";
        let normalized = normalize_citation_links(input, &citations);
        assert!(normalized.contains("[docs](cowork-citation:0)"));
        assert!(normalized.contains("[code](https://docs.example.com/guide)"));
    }

    #[test]
    fn resolve_workspace_code_link_accepts_relative_and_rejects_escapes() {
        assert_eq!(
            resolve_workspace_code_link("src/main.rs:42", Some("/repo")),
            Some("cowork-file:/repo/src/main.rs".to_string())
        );
        assert_eq!(
            resolve_workspace_code_link("../../etc/passwd", Some("/repo")),
            None
        );
        assert_eq!(
            resolve_workspace_code_link("https://example.com/a.rs", Some("/repo")),
            None
        );
    }

    #[test]
    fn allowed_external_urls_restrict_schemes_to_http_https_mailto() {
        assert!(is_allowed_external_url("https://example.com/docs"));
        assert!(is_allowed_external_url("http://example.com"));
        assert!(is_allowed_external_url("mailto:support@example.com"));
        assert!(!is_allowed_external_url("data:image/png;base64,AAAA"));
        assert!(!is_allowed_external_url("file:///etc/passwd"));
        assert!(!is_allowed_external_url("javascript:alert(1)"));
    }

    #[test]
    fn workspace_file_links_require_safe_workspace_containment() {
        assert_eq!(
            resolve_safe_workspace_file_link("cowork-file:/repo/src/main.rs", Some("/repo")),
            Some(std::path::PathBuf::from("/repo/src/main.rs"))
        );
        assert_eq!(
            resolve_safe_workspace_file_link("cowork-file:/etc/passwd", Some("/repo")),
            None
        );
        assert_eq!(
            resolve_safe_workspace_file_link("cowork-file:../../etc/passwd", Some("/repo")),
            None
        );
        assert_eq!(
            resolve_safe_workspace_file_link("cowork-file:/repo/src/main.rs", None),
            None
        );
    }

    #[test]
    fn split_streaming_markdown_blocks_preserves_fences_lists_and_ref_links() {
        let doc = "Intro para.\n\n```rust\nfn a() {\n\n    1\n}\n```\n\n- one\n\n- two\n\nTail";
        let blocks = split_streaming_markdown_blocks(doc);
        assert_eq!(blocks.len(), 4);
        assert_eq!(blocks[0], "Intro para.");
        assert!(blocks[1].starts_with("```rust") && blocks[1].ends_with("```"));
        assert!(blocks[2].contains("- one") && blocks[2].contains("- two"));
        assert_eq!(blocks[3], "Tail");

        let ref_doc = "See [docs][ref].\n\n[ref]: https://example.com\n";
        assert_eq!(split_streaming_markdown_blocks(ref_doc), vec![ref_doc]);

        // List-item-line and 4-space list-nested code fences must not split mid-fence.
        let list_fence = "Intro\n\n- ```rust\n  fn a() {}\n\nfn b() {}\n  ```\n\nTail";
        let lf_blocks = split_streaming_markdown_blocks(list_fence);
        assert_eq!(lf_blocks.len(), 3);
        assert_eq!(lf_blocks[0], "Intro");
        assert!(lf_blocks[1].contains("fn a()") && lf_blocks[1].contains("fn b()"));
        assert_eq!(lf_blocks[2], "Tail");

        let nested_fence = "10. Steps:\n\n    ```rust\n    fn a() {}\n\nfn b() {}\n    ```\n\nDone";
        let nf_blocks = split_streaming_markdown_blocks(nested_fence);
        assert_eq!(nf_blocks.len(), 2);
        assert!(nf_blocks[0].contains("fn a()") && nf_blocks[0].contains("fn b()"));
        assert_eq!(nf_blocks[1], "Done");

        // Indented, blockquoted, and multi-line link reference definitions keep doc whole.
        let multi_ref = "See [multi\nline].\n\n[multi\nline]: https://example.com\n";
        assert_eq!(split_streaming_markdown_blocks(multi_ref), vec![multi_ref]);

        let quoted_ref = "> [r]: https://example.com\n\nSee [docs][r].\n";
        assert_eq!(
            split_streaming_markdown_blocks(quoted_ref),
            vec![quoted_ref]
        );

        let list_ref = "- item\n\n    [r]: https://example.com\n\nSee [docs][r].\n";
        assert_eq!(split_streaming_markdown_blocks(list_ref), vec![list_ref]);
    }
}
