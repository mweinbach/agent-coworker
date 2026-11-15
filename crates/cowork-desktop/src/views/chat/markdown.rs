//! Desktop Markdown wrapper over `rune_kit::Markdown` plus citation chips and sources strip.

use std::rc::Rc;
use std::sync::Arc;

use rune::{
    Color, Cursor, El, ImageCache, LinkPaint, Span, TextStyle, Tx, col, icon, row, spacer, text,
};
use rune_kit::{Button, ButtonVariant, ControlSize, Kit, Markdown, MarkdownStyle};

use crate::actions::{Action, NativeAction, ShellAction};
use crate::state::AppState;
use crate::theme::ThemeTokens;

use super::attachments::{decode_image_from_uri, resolve_safe_local_path};
use super::icons;
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
    /// Called after copying a code or mermaid source block.
    pub on_copy: Option<CopyHandler>,
    /// Called when clicking a `cowork-citation:<index>` link chip.
    pub on_citation_click: Option<CitationClickHandler>,
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
            ..t.body
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
        .code_block(t.code_bg, t.border)
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

    let resolved = resolve_safe_local_path(path_only, base_path)?;
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

/// Rewrites `[label](url)` links that match `citations` into `cowork-citation:<index>` pill targets
/// while leaving fenced code blocks untouched.
pub fn normalize_citation_links(src: &str, citations: &[CitationSource]) -> String {
    if citations.is_empty() || !src.contains("](") {
        return src.to_string();
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
        out.push_str(&rewrite_line_citations(segment, citations));
    }
    out
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
    let normalized = normalize_citation_links(src, citations);
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
            let src_open = frame.src.to_string();
            let ws_id = ws_id_img.clone();
            let ws_path = ws_path_img.clone();
            img_el
                .max_h(420.0)
                .radius(8.0)
                .border(1.0, Color::TRANSPARENT)
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
                .px(8.0)
                .py(2.0)
                .child(
                    text(lang_label)
                        .font(kit_code.ty.small_medium)
                        .color(tok_code.text_muted),
                )
                .child(spacer())
                .child(copy_btn);

            col()
                .key(block_key)
                .w_full()
                .gap(4.0)
                .child(header)
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
                .px(8.0)
                .py(2.0)
                .child(
                    text("Diagram")
                        .font(kit_diag.ty.small_medium)
                        .color(tok_diag.text_muted),
                )
                .child(spacer())
                .child(copy_btn);

            col()
                .key(block_key)
                .w_full()
                .gap(4.0)
                .child(header)
                .child(card)
        });

    md.build(k)
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

    if let Some(raw_file) = url.strip_prefix(WORKSPACE_FILE_SCHEME) {
        if let Some(ws_id) = workspace_id {
            s.dispatch(Action::Native(NativeAction::LoadFilePreview {
                workspace_id: ws_id.to_string(),
                path: raw_file.to_string(),
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

    s.dispatch(Action::Shell(ShellAction::RequestExternalUrl(
        url.to_string(),
    )));
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
        .variant(ButtonVariant::Outline)
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

            let card = col()
                .key(format!("{message_key}:src:{idx}"))
                .w(212.0)
                .gap(4.0)
                .px(10.0)
                .py(8.0)
                .radius(10.0)
                .fill(t.card_bg)
                .hover(t.hover)
                .border(1.0, t.border_muted)
                .cursor(Cursor::Pointer)
                .help(source.url.clone())
                .on_press(move |s: &mut AppState| {
                    s.dispatch(Action::Shell(ShellAction::RequestExternalUrl(
                        open_url.clone(),
                    )));
                })
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
}
