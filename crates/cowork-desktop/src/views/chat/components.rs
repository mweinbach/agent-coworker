//! Shared visual building blocks for chat composer, feed rows, activity timeline, and notices.

use std::rc::Rc;

use rune::{
    Cursor, El, Link, LinkPaint, Span, TextStyle, Tx, col, el, icon, rich, row, spacer, text,
};
use rune_kit::{Button, ButtonVariant, ControlSize, Kit};

use crate::actions::{Action, NavAction};
use crate::state::{AppState, ToolRunStatus};
use crate::theme::ThemeTokens;

use super::icons;
use super::model::{ComposerSegment, MentionCatalog, MentionItem, parse_composer_segments};

pub type MentionClickHandler = Rc<dyn Fn(&mut AppState, usize, &mut Tx)>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StatusPillTone {
    Neutral,
    Danger,
    Warning,
    Success,
    Accent,
}

/// Builds inline background/foreground pill `Span`s for recognized `@`/`$`/`/` mentions inside `TextEdit`.
pub fn composer_mention_spans(
    input_text: &str,
    catalog: &MentionCatalog,
    k: &Kit,
    t: &ThemeTokens,
) -> Vec<Span> {
    let chip_bg = k.alpha(t.accent, if t.dark { 0.18 } else { 0.12 });
    parse_composer_segments(input_text, catalog)
        .into_iter()
        .filter_map(|seg| match seg {
            ComposerSegment::Mention { start, end, .. } if start < end => Some(
                Span::new(start, end)
                    .bg(chip_bg, 3.5)
                    .color(t.accent)
                    .weight(500.0),
            ),
            _ => None,
        })
        .collect()
}

/// Renders sent user message text with interactive mention pills (`@skill`, `$plugin`, `/path`).
pub fn mention_rich_text(
    body_text: &str,
    catalog: &MentionCatalog,
    k: &Kit,
    t: &ThemeTokens,
    style: TextStyle,
    matched_items_out: Option<&mut Vec<MentionItem>>,
    on_click: Option<MentionClickHandler>,
) -> El {
    let segments = parse_composer_segments(body_text, catalog);
    let chip_bg = k.alpha(t.accent, if t.dark { 0.18 } else { 0.13 });
    let hover_bg = k.alpha(t.accent, if t.dark { 0.28 } else { 0.20 });

    let mut spans: Vec<Span> = Vec::new();
    let mut links: Vec<Link> = Vec::new();
    let mut items_for_click: Vec<MentionItem> = Vec::new();

    for seg in segments {
        if let ComposerSegment::Mention {
            kind,
            name,
            start,
            end,
            ..
        } = seg
            && start < end
        {
            spans.push(
                Span::new(start, end)
                    .bg(chip_bg, 4.0)
                    .color(t.accent)
                    .weight(550.0),
            );
            if let Some(found) = catalog
                .items
                .iter()
                .find(|m| m.kind == kind && m.name == name)
            {
                let idx = items_for_click.len();
                let help_text = if found.description.is_empty() {
                    found.badge.clone()
                } else {
                    found.description.clone()
                };
                items_for_click.push(found.clone());
                links.push(
                    Link::new(start..end, format!("mention:{idx}"))
                        .hover(LinkPaint::new().bg(hover_bg).ring(t.accent, 1.0))
                        .help(help_text),
                );
            }
        }
    }

    if let Some(out) = matched_items_out {
        *out = items_for_click;
    }

    let mut el_text = rich(body_text.to_owned(), spans)
        .font(style)
        .color(t.text_base)
        .wrap()
        .selectable(true);

    for lnk in links {
        el_text = el_text.link(lnk);
    }

    if let Some(cb) = on_click {
        el_text = el_text.on_link(move |s: &mut AppState, dest, tx| {
            if let Some(raw_idx) = dest.strip_prefix("mention:")
                && let Ok(idx) = raw_idx.parse::<usize>()
            {
                cb(s, idx, tx);
            }
        });
    }

    el_text
}

/// Renders the canvas file tag pill shown at the top of structured canvas user prompts.
pub fn canvas_request_pill(k: &Kit, t: &ThemeTokens, filename: &str, spreadsheet: bool) -> El {
    let glyph = if spreadsheet {
        &icons::SPREADSHEET
    } else {
        &icons::FILE_TEXT
    };
    row()
        .items_center()
        .gap(5.0)
        .px(7.0)
        .py(3.0)
        .radius(6.0)
        .fill(k.alpha(t.accent, 0.11))
        .border(1.0, k.alpha(t.accent, 0.25))
        .child(icon(glyph, 12.0).color(t.accent))
        .child(
            text(filename.to_owned())
                .font(k.ty.small_medium)
                .color(t.text_base)
                .max_w(200.0)
                .truncate(),
        )
}

/// Renders a compact status badge (`REVIEW`, `RECOVERED`, `RUNNING`, etc.).
pub fn status_pill(k: &Kit, t: &ThemeTokens, label: impl Into<String>, tone: StatusPillTone) -> El {
    let (bg, fg, border) = match tone {
        StatusPillTone::Neutral => (k.c.layer_02, t.text_muted, t.border_muted),
        StatusPillTone::Danger => (k.alpha(t.danger, 0.14), t.danger, k.alpha(t.danger, 0.35)),
        StatusPillTone::Warning => (
            k.alpha(t.warning, 0.14),
            t.warning,
            k.alpha(t.warning, 0.35),
        ),
        StatusPillTone::Success => (
            k.alpha(t.success, 0.14),
            t.success,
            k.alpha(t.success, 0.35),
        ),
        StatusPillTone::Accent => (t.accent_soft, t.accent, k.alpha(t.accent, 0.35)),
    };

    row()
        .items_center()
        .px(7.0)
        .py(2.0)
        .radius(9999.0)
        .fill(bg)
        .border(1.0, border)
        .child(text(label).font(k.ty.small_medium).color(fg))
}

/// Renders a day boundary divider centered across the feed (`Today`, `Yesterday`, `Mar 4`).
pub fn day_separator_row(k: &Kit, t: &ThemeTokens, label: impl Into<String>) -> El {
    let hairline = || el().h(1.0).grow(1.0).fill(k.alpha(t.border, 0.45));
    row()
        .w_full()
        .items_center()
        .gap(12.0)
        .py(4.0)
        .child(hairline())
        .child(
            text(label)
                .font(k.ty.small_medium)
                .color(k.alpha(t.text_muted, 0.85)),
        )
        .child(hairline())
}

/// Renders the initial pending/working row displayed before the first tool/reasoning/reply item lands.
pub fn working_placeholder_row(k: &Kit, t: &ThemeTokens) -> El {
    row().w_full().max_w(768.0).child(
        row()
            .grow(1.0)
            .min_w(0.0)
            .items_center()
            .gap(10.0)
            .px(12.0)
            .py(8.0)
            .radius(12.0)
            .fill(k.alpha(t.elevated_bg, 0.45))
            .border(1.0, t.border_muted)
            .child(
                el().size(16.0, 16.0)
                    .shrink()
                    .center()
                    .child(el().size(7.0, 7.0).radius(9999.0).fill(t.accent)),
            )
            .child(text("Working").font(k.ty.ui_medium).color(t.text_base))
            .child(spacer())
            .child(
                row()
                    .items_center()
                    .gap(4.0)
                    .child(el().size(4.0, 4.0).radius(9999.0).fill(t.text_muted))
                    .child(
                        el().size(4.0, 4.0)
                            .radius(9999.0)
                            .fill(k.alpha(t.text_muted, 0.7)),
                    )
                    .child(
                        el().size(4.0, 4.0)
                            .radius(9999.0)
                            .fill(k.alpha(t.text_muted, 0.45)),
                    ),
            ),
    )
}

/// Renders a single vertical timeline rail node (`TimelineNode`: 20px icon dot + vertical connector).
pub fn timeline_node(k: &Kit, t: &ThemeTokens, dot_icon: El, is_last: bool, content: El) -> El {
    let mut rail = col().items_center().shrink().child(
        el().mt(2.0)
            .size(20.0, 20.0)
            .radius(9999.0)
            .fill(t.card_bg)
            .border(1.0, t.border_muted)
            .center()
            .child(dot_icon),
    );
    if !is_last {
        rail = rail.child(el().mt(4.0).w(1.0).grow(1.0).fill(k.alpha(t.border, 0.45)));
    }

    row()
        .w_full()
        .min_w(0.0)
        .items_stretch()
        .gap(10.0)
        .child(rail)
        .child(col().grow(1.0).min_w(0.0).pb(12.0).child(content))
}

/// Renders the tool status badge/dot on timeline rows (`Pending`, `Running`, `Failed`, `Declined`, approval).
pub fn tool_state_indicator(
    k: &Kit,
    t: &ThemeTokens,
    status: ToolRunStatus,
    awaiting_approval: bool,
) -> Option<El> {
    if awaiting_approval {
        return Some(status_pill(k, t, "Review", StatusPillTone::Danger));
    }
    match status {
        ToolRunStatus::Completed => None,
        ToolRunStatus::Failed | ToolRunStatus::Declined => {
            Some(icon(&icons::X_CIRCLE, 12.0).color(t.danger))
        }
        ToolRunStatus::Pending | ToolRunStatus::Running => {
            Some(icon(&icons::CIRCLE_DASHED, 12.0).color(t.accent))
        }
    }
}

/// Renders empty, hydrating, or disconnected transcript placeholder card (`Empty` in `ChatFeed`).
pub fn empty_feed_state(
    k: &Kit,
    t: &ThemeTokens,
    hydrating: bool,
    disconnected: bool,
    reconnecting: bool,
) -> El {
    let (title, description, glyph) = if hydrating {
        (
            "Loading chat",
            "Restoring messages and reconnecting the session.",
            &icons::CIRCLE_DASHED,
        )
    } else if disconnected {
        if reconnecting {
            (
                "Reconnecting",
                "Reconnecting automatically. Your draft is safe.",
                &icons::CIRCLE_DASHED,
            )
        } else {
            (
                "Disconnected",
                "Send a message or use Reconnect to continue.",
                &icons::MESSAGE_SQUARE,
            )
        }
    } else {
        (
            "No messages yet",
            "Send a message to start.",
            &icons::MESSAGE_SQUARE,
        )
    };

    col()
        .w_full()
        .min_h(288.0)
        .radius(12.0)
        .border(1.0, t.border_muted)
        .fill(k.alpha(t.elevated_bg, 0.25))
        .center()
        .px(24.0)
        .py(32.0)
        .gap(12.0)
        .child(
            el().size(40.0, 40.0)
                .radius(10.0)
                .fill(k.c.layer_02)
                .border(1.0, t.border_muted)
                .center()
                .child(icon(glyph, 20.0).color(t.text_muted)),
        )
        .child(text(title).font(k.ty.body_medium).color(t.text_base))
        .child(
            text(description)
                .font(k.ty.text_small)
                .color(t.text_muted)
                .wrap(),
        )
}

/// Renders the transcript-only notice shown above read-only imported/forked histories.
pub fn transcript_only_banner(k: &Kit, t: &ThemeTokens) -> El {
    row()
        .w_full()
        .items_start()
        .gap(12.0)
        .padding(12.0)
        .radius(12.0)
        .border(1.0, t.border_muted)
        .fill(k.alpha(t.elevated_bg, 0.45))
        .child(
            el().mt(2.0)
                .child(icon(&icons::ALERT, 16.0).color(t.accent)),
        )
        .child(
            col()
                .grow(1.0)
                .min_w(0.0)
                .gap(2.0)
                .child(
                    text("Transcript view")
                        .font(k.ty.ui_medium)
                        .color(t.text_base),
                )
                .child(
                    text("Sending a message will continue in a new chat.")
                        .font(k.ty.text_small)
                        .color(t.text_muted)
                        .wrap(),
                ),
        )
}

/// Bottom replacement bar when a thread belongs to an active background task.
pub fn locked_task_bar(k: &Kit, t: &ThemeTokens, task_id: String, task_title: String) -> El {
    col()
        .w_full()
        .items_center()
        .border_sides([1.0, 0.0, 0.0, 0.0], t.border_muted)
        .fill(t.panel_bg)
        .px(16.0)
        .py(12.0)
        .child(
            row()
                .w_full()
                .max_w(768.0)
                .items_center()
                .gap(12.0)
                .px(16.0)
                .py(12.0)
                .radius(10.0)
                .border(1.0, t.border)
                .fill(k.alpha(t.elevated_bg, 0.35))
                .child(icon(&icons::LOCK, 16.0).color(t.text_muted))
                .child(
                    col()
                        .grow(1.0)
                        .min_w(0.0)
                        .gap(2.0)
                        .child(
                            text("This chat is locked while its task is active.")
                                .font(k.ty.ui_medium)
                                .color(t.text_base),
                        )
                        .child(
                            text(task_title)
                                .font(k.ty.text_xsmall)
                                .color(t.text_muted)
                                .truncate(),
                        ),
                )
                .child(
                    Button::new("Open task")
                        .variant(ButtonVariant::Contrast)
                        .control_size(ControlSize::Small)
                        .on_press_tx(move |s: &mut AppState, tx| {
                            s.dispatch_tx(
                                Action::Navigate(NavAction::OpenTask(task_id.clone())),
                                tx,
                            );
                        })
                        .build(k),
                ),
        )
}

/// Bottom read-only bar rendered when a thread is archived/locked for viewing only.
pub fn read_only_notice_bar(
    k: &Kit,
    t: &ThemeTokens,
    title: &str,
    detail: &str,
    action_btn: Option<El>,
) -> El {
    let mut inner = row()
        .w_full()
        .max_w(768.0)
        .items_center()
        .gap(12.0)
        .px(16.0)
        .py(12.0)
        .radius(10.0)
        .border(1.0, t.border)
        .fill(k.alpha(t.elevated_bg, 0.35))
        .child(icon(&icons::LOCK, 16.0).color(t.text_muted))
        .child(
            col()
                .grow(1.0)
                .min_w(0.0)
                .gap(2.0)
                .child(
                    text(title.to_owned())
                        .font(k.ty.ui_medium)
                        .color(t.text_base),
                )
                .child(
                    text(detail.to_owned())
                        .font(k.ty.text_xsmall)
                        .color(t.text_muted)
                        .wrap(),
                ),
        );
    if let Some(btn) = action_btn {
        inner = inner.child(btn);
    }

    col()
        .w_full()
        .items_center()
        .border_sides([1.0, 0.0, 0.0, 0.0], t.border_muted)
        .fill(t.panel_bg)
        .px(16.0)
        .py(12.0)
        .child(inner)
}

/// Floating pill shown when the user scrolls away from the bottom of the transcript.
pub fn scroll_to_latest_pill(
    k: &Kit,
    t: &ThemeTokens,
    unseen_count: usize,
    on_press: impl Fn(&mut AppState, &mut Tx) + 'static,
) -> El {
    let label = if unseen_count > 0 {
        format!(
            "{unseen_count} new {}",
            if unseen_count == 1 {
                "update"
            } else {
                "updates"
            }
        )
    } else {
        "Scroll to bottom".to_string()
    };

    row()
        .items_center()
        .gap(6.0)
        .px(12.0)
        .py(6.0)
        .radius(9999.0)
        .fill(t.popover_bg)
        .hover(t.elevated_bg)
        .border(1.0, t.border_strong)
        .cursor(Cursor::Pointer)
        .on_press_tx(on_press)
        .child(icon(&icons::ARROW_DOWN, 14.0).color(t.text_base))
        .child(text(label).font(k.ty.text_xsmall_medium).color(t.text_base))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::SkillSummary;
    use crate::theme;
    use crate::views::chat::model::build_mention_catalog;

    #[test]
    fn composer_mention_spans_highlight_known_tokens_only() {
        let catalog = build_mention_catalog(
            &[SkillSummary {
                name: "review".to_string(),
                description: "Review code".to_string(),
                scope: "project".to_string(),
                enabled: true,
                ..Default::default()
            }],
            &[],
        );
        let (k, t) = theme::build_kit(false, false, false);
        let spans = composer_mention_spans("Run @review and @unknown", &catalog, &k, &t);
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].start, 4);
        assert_eq!(spans[0].end, 11);
    }
}
