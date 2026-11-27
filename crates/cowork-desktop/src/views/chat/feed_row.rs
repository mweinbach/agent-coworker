//! Single-row feed items (`User`, `Assistant`, `Error`, `Log`, `System`, `Todos`)
//! and feed-level citation / mention popovers.

use std::borrow::Cow;
use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

use cowork_protocol::TurnAttachmentInputPart;
use rune::{Cursor, El, ImageCache, TextStyle, Tx, col, el, icon, row, spacer, text};
use rune_kit::{
    Button, ButtonVariant, ControlSize, IconButton, IconButtonVariant, Kit, Placement, popover,
    scrim,
};

use crate::actions::{Action, ShellAction};
use crate::state::{AppState, FeedItem, FeedMessageRole, TodoItemView};
use crate::theme::ThemeTokens;

use super::attachments::user_attachment_group;
use super::components::{StatusPillTone, canvas_request_pill, mention_rich_text, status_pill};
use super::icons;
use super::markdown::{
    MarkdownHooks, citation_sources_carousel, desktop_markdown, is_allowed_external_url,
};
use super::model::{
    MentionCatalog, MentionItem, build_visible_user_message, display_domain,
    format_agent_run_message_text, truncate_text,
};
use super::state::{CitationPopoverState, CitationSource, MentionPopoverState};

const MAX_COLLAPSED_ERROR_CHARS: usize = 240;

/// Shared context passed from `ChatFeed` to individual row builders so catalogs and
/// expiration timestamps are computed once per render pass.
pub struct FeedRowContext<'a> {
    pub workspace_id: Option<&'a str>,
    pub workspace_path: Option<&'a str>,
    pub catalog: &'a MentionCatalog,
    pub external_cache: Option<Arc<ImageCache>>,
    pub is_agent_viewer: bool,
    pub copied_key: Option<&'a str>,
}

/// Converts protocol citation sources into the compact format consumed by `markdown.rs`.
pub(super) fn to_chat_citations(sources: &[crate::state::CitationSource]) -> Vec<CitationSource> {
    sources
        .iter()
        .map(|src| CitationSource {
            url: src.url.clone(),
            title: src
                .title
                .clone()
                .or_else(|| src.label.clone())
                .or_else(|| src.domain.clone()),
        })
        .collect()
}

/// Renders one standalone `FeedItem` row (`Message`, `Error`, `Log`, `System`, or `Todos`).
pub fn build_feed_row(
    s: &AppState,
    k: &Kit,
    t: &ThemeTokens,
    item: &FeedItem,
    ctx: &FeedRowContext<'_>,
) -> El {
    match item {
        FeedItem::Message {
            id,
            role: FeedMessageRole::User,
            content,
            attachments,
            streaming,
            ..
        } => {
            let row_el = build_user_message_row(k, t, id, content, attachments, ctx);
            wrap_row_growth(row_el, *streaming)
        }
        FeedItem::Message {
            id,
            role: FeedMessageRole::Assistant,
            content,
            citations,
            streaming,
            ..
        } => {
            let row_el =
                build_assistant_message_row(s, k, t, id, content, citations, *streaming, ctx);
            wrap_row_growth(row_el, *streaming)
        }
        FeedItem::Message {
            id,
            role: FeedMessageRole::System,
            content,
            ..
        } => build_diagnostic_row(k, t, id, "system", content, false).arrives_whole(),
        FeedItem::Error {
            id, message, code, ..
        } => build_error_row(s, k, t, id, message, code.as_deref(), ctx).arrives_whole(),
        FeedItem::Log {
            id, level, message, ..
        } => build_diagnostic_row(k, t, id, level, message, true).arrives_whole(),
        FeedItem::System { id, message, .. } => {
            build_diagnostic_row(k, t, id, "system", message, false).arrives_whole()
        }
        FeedItem::Todos { id, items, .. } => build_todos_row(k, t, id, items).arrives_whole(),
        FeedItem::Reasoning { id, .. } | FeedItem::Tool { id, .. } => {
            // Standalone reasoning/tool items are normally grouped via `ActivityGroup`.
            col().key(format!("row:{id}")).w_full().max_w(768.0)
        }
    }
}

fn wrap_row_growth(el_row: El, streaming: bool) -> El {
    if streaming {
        el_row.streaming(true)
    } else {
        el_row.arrives_whole()
    }
}

fn build_user_message_row(
    k: &Kit,
    t: &ThemeTokens,
    id: &str,
    content: &str,
    attachments: &[TurnAttachmentInputPart],
    ctx: &FeedRowContext<'_>,
) -> El {
    let visible = build_visible_user_message(content);
    let anchor_key = format!("mention-anchor:{id}");
    let copy_key = format!("msg:{id}:user-copy");
    let copied = ctx.copied_key == Some(copy_key.as_str());

    let mut bubble = col()
        .key(anchor_key.clone())
        .max_w(580.0)
        .gap(8.0)
        .px(14.0)
        .py(9.0)
        .radius(16.0)
        .fill(if t.dark {
            k.c.layer_02
        } else {
            k.alpha(t.text_base, 0.05)
        });

    if let Some(title) = visible.canvas_title {
        let spreadsheet = content.contains("<spreadsheet_canvas_request>");
        bubble = bubble.child(canvas_request_pill(k, t, &title, spreadsheet));
    }

    if !visible.text.is_empty() {
        let matched_box: Rc<RefCell<Vec<MentionItem>>> = Rc::new(RefCell::new(Vec::new()));
        let matched_cb = Rc::clone(&matched_box);
        let anchor_cb = anchor_key;
        let body_el = mention_rich_text(
            &visible.text,
            ctx.catalog,
            k,
            t,
            TextStyle {
                line_height: 22.0,
                ..t.body_lg
            },
            Some(&mut *matched_box.borrow_mut()),
            Some(Rc::new(
                move |s: &mut AppState, idx: usize, _tx: &mut Tx| {
                    if let Some(item) = matched_cb.borrow().get(idx).cloned() {
                        s.chat_ui.active_citation_popover = None;
                        s.chat_ui.active_mention_popover = Some(MentionPopoverState {
                            anchor_key: anchor_cb.clone(),
                            item,
                        });
                    }
                },
            )),
        );
        bubble = bubble.child(body_el);
    }

    if let Some(att_group) = user_attachment_group(
        k,
        t,
        attachments,
        &format!("msg:{id}:att"),
        ctx.external_cache.as_deref(),
    ) {
        bubble = bubble.child(att_group);
    } else if !visible.attached_names.is_empty() {
        let mut names_row = row().w_full().flex_wrap().gap(6.0);
        for (idx, name) in visible.attached_names.iter().enumerate() {
            names_row = names_row.child(
                row()
                    .key(format!("msg:{id}:attname:{idx}"))
                    .items_center()
                    .gap(5.0)
                    .px(8.0)
                    .py(3.0)
                    .radius(8.0)
                    .fill(k.c.layer_02)
                    .border(1.0, t.border_muted)
                    .child(icon(&icons::PAPERCLIP, 12.0).color(t.text_muted))
                    .child(
                        text(name.clone())
                            .font(k.ty.small_medium)
                            .color(t.text_muted),
                    ),
            );
        }
        bubble = bubble.child(names_row);
    }

    let mut outer = col()
        .key(format!("row:{id}"))
        .hover_group()
        .w_full()
        .max_w(768.0)
        .items_end()
        .gap(4.0)
        .child(row().w_full().justify_end().child(bubble));

    if !visible.text.is_empty() {
        outer = outer.child(
            row()
                .w_full()
                .justify_end()
                .group_opacity(if copied { 1.0 } else { 0.0 }, 1.0)
                .child(build_copy_chip_button(
                    k,
                    t,
                    copy_key,
                    visible.text,
                    copied,
                    "Copy message",
                )),
        );
    }

    outer
}

#[allow(clippy::too_many_arguments)]
fn build_assistant_message_row(
    s: &AppState,
    k: &Kit,
    t: &ThemeTokens,
    id: &str,
    content: &str,
    citations: &[crate::state::CitationSource],
    streaming: bool,
    ctx: &FeedRowContext<'_>,
) -> El {
    let body_text: Cow<'_, str> = if ctx.is_agent_viewer {
        Cow::Owned(format_agent_run_message_text(content))
    } else {
        Cow::Borrowed(content)
    };
    let chat_citations = if citations.is_empty() {
        Vec::new()
    } else {
        to_chat_citations(citations)
    };
    let md_key = format!("msg:{id}");
    let md_anchor = format!("msg:{id}:md");
    let copy_key = format!("msg:{id}:assistant-copy");
    let copied = ctx.copied_key == Some(copy_key.as_str());

    let copied_owned = ctx.copied_key.map(str::to_owned);
    let on_citation_click = if chat_citations.is_empty() {
        None
    } else {
        let cit_for_click = chat_citations.clone();
        let anchor_for_click = md_anchor.clone();
        Some(Rc::new(move |s: &mut AppState, idx: usize, _tx: &mut Tx| {
            if idx < cit_for_click.len() {
                s.chat_ui.active_mention_popover = None;
                s.chat_ui.active_citation_popover = Some(CitationPopoverState {
                    anchor_key: anchor_for_click.clone(),
                    sources: cit_for_click.clone(),
                    active_index: idx,
                });
            }
        }) as super::markdown::CitationClickHandler)
    };
    let hooks = MarkdownHooks {
        is_copied: Some(Rc::new({
            let copied_cb = copied_owned.clone();
            move |key: &str| copied_cb.as_deref() == Some(key)
        })),
        active_copied_key: copied_owned,
        on_copy: Some(Rc::new(
            move |s: &mut AppState, key: String, tx: &mut Tx| {
                let _ = &key;
                s.chat_ui.mark_copied(&key, s.now_secs);
                let _ = tx;
            },
        )),
        on_citation_click,
        math_waker: s.services.waker.clone(),
        math_scale: Some((2.0 * s.ui_scale).clamp(2.0, 4.0)),
    };

    let md_el = desktop_markdown(
        k,
        t,
        body_text.as_ref(),
        &md_key,
        ctx.is_agent_viewer,
        streaming,
        s.desktop_settings.reduce_motion,
        ctx.workspace_id,
        ctx.workspace_path,
        &chat_citations,
        ctx.external_cache.clone(),
        hooks,
    );

    let mut container = col()
        .key(format!("row:{id}"))
        .hover_group()
        .w_full()
        .max_w(768.0)
        .gap(8.0)
        .child(col().key(md_anchor).w_full().child(md_el));

    if let Some(carousel) = citation_sources_carousel(
        k,
        t,
        &chat_citations,
        id,
        s.chat_ui.open_citation_sources.contains(id),
        |s: &mut AppState, msg_id: String| {
            if !s.chat_ui.open_citation_sources.remove(&msg_id) {
                s.chat_ui.open_citation_sources.insert(msg_id);
            }
        },
    ) {
        container = container.child(carousel);
    }

    if !body_text.trim().is_empty() {
        if !streaming {
            container = container.child(
                row()
                    .w_full()
                    .items_center()
                    .group_opacity(if copied { 1.0 } else { 0.0 }, 1.0)
                    .child(build_copy_chip_button(
                        k,
                        t,
                        copy_key,
                        body_text.into_owned(),
                        copied,
                        "Copy response",
                    )),
            );
        } else {
            // Reserve the copy-action bar's height during streaming to prevent a layout jump on completion.
            container = container.child(el().w_full().h(24.0).a11y_hidden());
        }
    }

    container
}

fn build_error_row(
    s: &AppState,
    k: &Kit,
    t: &ThemeTokens,
    id: &str,
    message: &str,
    code: Option<&str>,
    ctx: &FeedRowContext<'_>,
) -> El {
    let expanded = s.chat_ui.expanded_errors.contains(id);
    let is_long = message.len() > MAX_COLLAPSED_ERROR_CHARS
        && message.chars().count() > MAX_COLLAPSED_ERROR_CHARS;
    let shown_text = if expanded || !is_long {
        message.to_string()
    } else {
        truncate_text(message, MAX_COLLAPSED_ERROR_CHARS)
    };
    let copy_key = format!("err:{id}:copy");
    let copied = ctx.copied_key == Some(copy_key.as_str());

    let mut header = row()
        .w_full()
        .items_center()
        .gap(8.0)
        .child(icon(&icons::ALERT, 15.0).color(t.danger))
        .child(
            text("Turn error")
                .font(k.ty.small_medium)
                .color(t.danger)
                .grow(1.0),
        );
    if let Some(code_str) = code.filter(|c| !c.trim().is_empty()) {
        header = header.child(status_pill(k, t, code_str, StatusPillTone::Danger));
    }

    let mut actions = row().items_center().gap(6.0);
    if is_long {
        let toggle_id = id.to_string();
        actions = actions.child(
            Button::new(if expanded { "Show less" } else { "Show more" })
                .variant(ButtonVariant::Ghost)
                .control_size(ControlSize::Small)
                .on_press(move |s: &mut AppState| {
                    if !s.chat_ui.expanded_errors.remove(&toggle_id) {
                        s.chat_ui.expanded_errors.insert(toggle_id.clone());
                    }
                })
                .build(k)
                .key(format!("err-more:{id}")),
        );
    }
    actions = actions.child(build_copy_chip_button(
        k,
        t,
        copy_key,
        message.to_string(),
        copied,
        "Copy error",
    ));

    col()
        .key(format!("row:{id}"))
        .w_full()
        .max_w(768.0)
        .gap(8.0)
        .px(14.0)
        .py(12.0)
        .radius(12.0)
        .fill(k.alpha(t.danger, 0.10))
        .border(1.0, k.alpha(t.danger, 0.25))
        .child(header)
        .child(
            text(shown_text)
                .font(k.ty.ui)
                .color(t.text_base)
                .wrap()
                .selectable(true)
                .w_full(),
        )
        .child(row().w_full().justify_end().child(actions))
}

fn build_diagnostic_row(
    k: &Kit,
    t: &ThemeTokens,
    id: &str,
    badge: &str,
    message: &str,
    mono: bool,
) -> El {
    let tone = match badge {
        "error" | "fatal" => StatusPillTone::Danger,
        "warn" | "warning" => StatusPillTone::Warning,
        _ => StatusPillTone::Neutral,
    };
    let text_font = if mono { k.ty.mono } else { k.ty.text_xsmall };

    row()
        .key(format!("row:{id}"))
        .w_full()
        .max_w(768.0)
        .items_start()
        .gap(8.0)
        .px(12.0)
        .py(8.0)
        .radius(10.0)
        .fill(k.alpha(t.elevated_bg, 0.45))
        .border(1.0, t.border_muted)
        .child(status_pill(k, t, badge, tone))
        .child(
            text(message.to_string())
                .font(text_font)
                .color(t.text_muted)
                .wrap()
                .selectable(true)
                .grow(1.0)
                .min_w(0.0),
        )
}

fn build_todos_row(k: &Kit, t: &ThemeTokens, id: &str, items: &[TodoItemView]) -> El {
    let mut card = col()
        .key(format!("row:{id}"))
        .w_full()
        .max_w(768.0)
        .gap(8.0)
        .px(14.0)
        .py(12.0)
        .radius(12.0)
        .fill(t.card_bg)
        .border(1.0, t.border_muted)
        .child(
            row()
                .items_center()
                .gap(8.0)
                .child(icon(&icons::CHECKLIST, 14.0).color(t.text_muted))
                .child(
                    text(format!("Plan ({} items)", items.len()))
                        .font(k.ty.small_medium)
                        .color(t.text_base),
                ),
        );

    for item in items {
        let completed = item.status.eq_ignore_ascii_case("completed");
        let in_progress = item.status.eq_ignore_ascii_case("in_progress");
        let (glyph, fg) = if completed {
            (&icons::CHECK_CIRCLE, t.success)
        } else if in_progress {
            (&icons::CLOCK, t.accent)
        } else {
            (&icons::CIRCLE_DASHED, t.text_faint)
        };
        card = card.child(
            row()
                .key(format!("todo:{id}:{}", item.id))
                .w_full()
                .items_start()
                .gap(8.0)
                .child(icon(glyph, 14.0).color(fg).mt(2.0))
                .child(
                    text(item.content.clone())
                        .font(k.ty.ui)
                        .color(if completed { t.text_muted } else { t.text_base })
                        .wrap()
                        .grow(1.0)
                        .min_w(0.0),
                ),
        );
    }

    card
}

fn build_copy_chip_button(
    k: &Kit,
    t: &ThemeTokens,
    copy_key: String,
    payload: String,
    copied: bool,
    help: &str,
) -> El {
    let glyph = if copied {
        &k.glyph.check
    } else {
        &k.glyph.copy
    };
    let label = if copied { "Copied" } else { "Copy" };
    let fg = if copied { t.success } else { t.text_faint };

    k.interactive_with(
        row()
            .key(copy_key.clone())
            .items_center()
            .gap(4.0)
            .px(6.0)
            .py(3.0)
            .radius(6.0)
            .focusable(true)
            .cursor(Cursor::Pointer)
            .role("button")
            .label(help)
            .help(help)
            .on_press_tx(move |s: &mut AppState, tx: &mut Tx| {
                tx.copy(&payload);
                s.chat_ui.mark_copied(&copy_key, s.now_secs);
            }),
        t.elevated_bg,
        t.pressed,
    )
    .child(icon(glyph, 12.0).color(fg))
    .child(text(label).font(k.ty.small_medium).color(fg))
}

/// Renders active inline citation or mention detail popovers into the shell overlay layer.
pub fn render_active_feed_popovers(s: &AppState, k: &Kit, t: &ThemeTokens, overlays: &mut Vec<El>) {
    if let Some(pop) = &s.chat_ui.active_mention_popover {
        overlays.push(scrim("mention-popover-scrim", |s: &mut AppState| {
            s.chat_ui.active_mention_popover = None;
        }));
        let title = format!("@{}", pop.item.name);
        let desc = if pop.item.description.trim().is_empty() {
            format!("{} reference", pop.item.badge)
        } else {
            pop.item.description.clone()
        };
        let close_btn = IconButton::new(k.glyph.close)
            .variant(IconButtonVariant::Ghost)
            .control_size(ControlSize::Small)
            .label("Close")
            .on_press(|s: &mut AppState| s.chat_ui.active_mention_popover = None)
            .build(k)
            .key("mention-popover-close");
        let card = col()
            .key("mention-popover-card")
            .w(280.0)
            .padding(12.0)
            .gap(8.0)
            .child(
                row()
                    .w_full()
                    .items_center()
                    .gap(8.0)
                    .child(
                        text(title)
                            .font(k.ty.body_medium)
                            .color(t.text_base)
                            .truncate(),
                    )
                    .child(status_pill(
                        k,
                        t,
                        pop.item.badge.clone(),
                        StatusPillTone::Neutral,
                    ))
                    .child(spacer())
                    .child(close_btn),
            )
            .child(text(desc).font(k.ty.ui).color(t.text_muted).wrap().w_full());
        let surface = popover::raised(k, card, k.radius.md);
        overlays.push(popover::anchored(
            k,
            surface,
            &pop.anchor_key,
            Placement::BottomEnd,
            6.0,
        ));
    }

    if let Some(pop) = &s.chat_ui.active_citation_popover
        && !pop.sources.is_empty()
    {
        overlays.push(scrim("citation-popover-scrim", |s: &mut AppState| {
            s.chat_ui.active_citation_popover = None;
        }));
        let total = pop.sources.len();
        let active_idx = pop.active_index.min(total - 1);
        let source = &pop.sources[active_idx];
        let domain = display_domain(&source.url);
        let title_text = source
            .title
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .unwrap_or(&domain)
            .to_string();
        let url_open = source.url.clone();

        let close_btn = IconButton::new(k.glyph.close)
            .variant(IconButtonVariant::Ghost)
            .control_size(ControlSize::Small)
            .label("Close")
            .on_press(|s: &mut AppState| s.chat_ui.active_citation_popover = None)
            .build(k)
            .key("citation-popover-close");

        let mut header = row()
            .w_full()
            .items_center()
            .gap(6.0)
            .child(icon(&icons::GLOBE, 13.0).color(t.text_muted))
            .child(
                text(format!("Source {} of {total}", active_idx + 1))
                    .font(k.ty.small_medium)
                    .color(t.text_muted),
            )
            .child(spacer());

        if total > 1 {
            header = header
                .child(
                    Button::new("Prev")
                        .variant(ButtonVariant::Ghost)
                        .control_size(ControlSize::Small)
                        .on_press(move |s: &mut AppState| {
                            if let Some(c) = &mut s.chat_ui.active_citation_popover {
                                c.active_index = if active_idx == 0 {
                                    total - 1
                                } else {
                                    active_idx - 1
                                };
                            }
                        })
                        .build(k)
                        .key("citation-prev"),
                )
                .child(
                    Button::new("Next")
                        .variant(ButtonVariant::Ghost)
                        .control_size(ControlSize::Small)
                        .on_press(move |s: &mut AppState| {
                            if let Some(c) = &mut s.chat_ui.active_citation_popover {
                                c.active_index = (active_idx + 1) % total;
                            }
                        })
                        .build(k)
                        .key("citation-next"),
                );
        }
        header = header.child(close_btn);

        let mut body = col()
            .w_full()
            .gap(4.0)
            .padding(10.0)
            .radius(8.0)
            .fill(t.card_bg)
            .border(1.0, t.border_muted)
            .child(
                row()
                    .w_full()
                    .items_center()
                    .gap(6.0)
                    .child(
                        text(domain)
                            .font(k.ty.small_medium)
                            .color(t.text_muted)
                            .grow(1.0),
                    )
                    .child(icon(&icons::EXTERNAL_LINK, 12.0).color(t.text_faint)),
            )
            .child(
                text(title_text)
                    .font(k.ty.body_medium)
                    .color(t.text_base)
                    .wrap()
                    .w_full(),
            )
            .child(
                text(source.url.clone())
                    .font(k.ty.text_xsmall)
                    .color(t.text_faint)
                    .truncate()
                    .w_full(),
            );
        if is_allowed_external_url(&url_open) {
            body = k
                .interactive_with(body.focusable(true), t.elevated_bg, t.pressed)
                .cursor(Cursor::Pointer)
                .on_press(move |s: &mut AppState| {
                    s.chat_ui.active_citation_popover = None;
                    s.dispatch(Action::Shell(ShellAction::RequestExternalUrl(
                        url_open.clone(),
                    )));
                });
        }

        let card = col()
            .key("citation-popover-card")
            .w(316.0)
            .padding(12.0)
            .gap(8.0)
            .child(header)
            .child(body);
        let surface = popover::raised(k, card, k.radius.md);
        overlays.push(popover::anchored(
            k,
            surface,
            &pop.anchor_key,
            Placement::BottomStart,
            6.0,
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_chat_citations_prefers_title_then_label_then_domain() {
        let input = vec![
            crate::state::CitationSource {
                label: Some("Docs".into()),
                title: Some("Rune Kit Docs".into()),
                url: "https://rune.example/kit".into(),
                domain: Some("rune.example".into()),
                snippet: None,
                reference_id: None,
            },
            crate::state::CitationSource {
                label: Some("Fallback Label".into()),
                title: None,
                url: "https://example.org/post".into(),
                domain: Some("example.org".into()),
                snippet: None,
                reference_id: None,
            },
        ];
        let converted = to_chat_citations(&input);
        assert_eq!(converted[0].title.as_deref(), Some("Rune Kit Docs"));
        assert_eq!(converted[1].title.as_deref(), Some("Fallback Label"));
    }
}
