//! Collapsible activity group timeline, clustered tools, reasoning sections, and native `DiffView` blocks.

use std::rc::Rc;
use std::sync::Arc;

use rune::{
    Color, Cursor, Direction, El, ImageCache, Spring, Transition, Tx, col, el, icon, row, spacer,
    text,
};
use rune_kit::diff::{DiffMode, DiffState, DiffView, FileDiff, LineKind};
use rune_kit::{Button, ButtonVariant, ControlSize, Kit, Spinner};
use serde_json::Value;

use crate::actions::{Action, ChatAction, ShellAction};
use crate::state::{
    AppState, ChatInteraction, FeedItem, FeedMessageRole, ThreadAgentSummary, ToolRunStatus,
};
use crate::theme::ThemeTokens;

use super::components::{CHAT_COLUMN_MAX_WIDTH, StatusPillTone, status_pill, tool_state_indicator};
use super::feed_row::to_chat_citations;
use super::icons;
use super::markdown::{MarkdownHooks, desktop_markdown};
use super::model::{
    ActivityGroup, ActivityNode, active_child_agent_labels, extract_tool_diff,
    format_duration_compact, format_tool_card, middle_truncate_path, parse_reasoning_sections,
    truncate_text,
};

const RAW_JSON_PREVIEW_LIMIT: usize = 12_000;

/// Context passed into `build_activity_group_card`.
pub struct ActivityCardContext<'a> {
    pub thread_id: &'a str,
    pub workspace_id: Option<&'a str>,
    pub workspace_path: Option<&'a str>,
    pub pending_interactions: &'a [ChatInteraction],
    pub agents: &'a [ThreadAgentSummary],
    pub external_cache: Option<Arc<ImageCache>>,
    pub copied_key: Option<&'a str>,
}

/// Renders one collapsible `ActivityGroup` card (either compact live run or completed separator).
pub fn build_activity_group_card(
    s: &AppState,
    k: &Kit,
    t: &ThemeTokens,
    group: &ActivityGroup<'_>,
    ctx: &ActivityCardContext<'_>,
) -> El {
    let default_open = group.is_live || group.has_pending_approval || group.error_count > 0;
    let expanded = s.chat_ui.is_activity_expanded(&group.id, default_open);

    let header = if group.is_live {
        build_live_group_header(s, k, t, group, expanded, ctx.agents)
    } else {
        build_completed_group_header(k, t, group, expanded, ctx.thread_id)
    };

    let mut card = col()
        .key(format!("group:{}", group.id))
        .w_full()
        .min_w(0.0)
        .max_w(CHAT_COLUMN_MAX_WIDTH)
        .gap(6.0)
        .transition(Transition::none())
        .child(header);

    if expanded && !group.nodes.is_empty() {
        let reasoning_only = group.tool_count == 0 && group.has_reasoning;
        let duration_ms = (group.ended_at_ms - group.started_at_ms).max(0);
        let thought_hdr =
            (reasoning_only && !group.is_live && group.started_at_ms > 0 && duration_ms >= 1000)
                .then(|| format!("Thought for {}", format_duration_compact(duration_ms)));

        let surface_fill = if t.dark {
            k.alpha(t.elevated_bg, 0.55)
        } else {
            t.input_bg
        };

        let mut sheet = col()
            .key(format!("group-body:{}", group.id))
            .w_full()
            .min_w(0.0)
            .radius(10.0)
            .continuous_corners()
            .fill(surface_fill)
            .border(1.0, t.border_muted)
            .border_layout()
            .clip_rounded(10.0)
            .transition(Transition::none());

        if let Some(thought_label) = thought_hdr {
            sheet = sheet.child(
                row().w_full().px(14.0).pt(10.0).pb(4.0).child(
                    text(thought_label)
                        .font(k.ty.text_xsmall)
                        .color(t.text_faint),
                ),
            );
        }

        let total_nodes = group.nodes.len();
        for (idx, node) in group.nodes.iter().enumerate() {
            sheet = sheet.child(build_activity_node(
                s,
                k,
                t,
                &group.id,
                (idx, total_nodes),
                reasoning_only,
                node,
                ctx,
            ));
        }
        card = card.child(sheet);
    }

    if group.is_live {
        card.streaming(true)
    } else {
        card.fold_glide(Spring::new(0.16, 0.0)).fold_feather(0.0)
    }
}

fn build_live_group_header(
    s: &AppState,
    k: &Kit,
    t: &ThemeTokens,
    group: &ActivityGroup<'_>,
    expanded: bool,
    agents: &[ThreadAgentSummary],
) -> El {
    let toggle_id = group.id.clone();
    let elapsed_ms = if group.started_at_ms > 0 {
        ((s.now_secs * 1000.0) as i64 - group.started_at_ms).max(0)
    } else {
        0
    };
    let active_agents = active_child_agent_labels(agents);
    let action_text = if active_agents.is_empty() {
        group.current_action.clone()
    } else if active_agents.len() == 1 {
        format!("{} · {}", group.current_action, active_agents[0])
    } else {
        format!(
            "{} · {} subagents active",
            group.current_action,
            active_agents.len()
        )
    };

    let mut meta_parts: Vec<String> = Vec::new();
    if group.tool_count > 0 {
        meta_parts.push(if group.tool_count == 1 {
            "1 step".to_string()
        } else {
            format!("{} steps", group.tool_count)
        });
    }
    if elapsed_ms >= 1000 {
        meta_parts.push(format_duration_compact(elapsed_ms));
    }

    let chevron = if expanded {
        &icons::CHEVRON_DOWN
    } else {
        &icons::CHEVRON_RIGHT
    };

    let hdr_key = format!("group-hdr:{}", group.id);
    let keep_key = hdr_key.clone();
    let mut header = row()
        .key(hdr_key)
        .items_center()
        .gap(8.0)
        .px(8.0)
        .py(5.0)
        .radius(8.0)
        .continuous_corners()
        .hover(t.hover)
        .hover_group()
        .cursor(Cursor::Pointer)
        .role("button")
        .expanded(expanded)
        .label(action_text.clone())
        .transition(Transition::none())
        .on_press_tx(move |s: &mut AppState, tx: &mut Tx| {
            s.chat_ui.toggle_activity(&toggle_id, expanded);
            tx.keep_on_screen(&keep_key);
        });

    if group.has_pending_approval {
        header = header
            .w_full()
            .fill(k.alpha(t.danger, if t.dark { 0.12 } else { 0.06 }))
            .border(1.0, k.alpha(t.danger, 0.35));
    } else {
        header = header.w_full().fill(Color::TRANSPARENT);
    }

    header = header
        .child(Spinner::new().size(13.0).color(t.accent).build(k))
        .child(
            text(action_text)
                .font(k.ty.small_medium)
                .color(t.text_base)
                .truncate()
                .shrink()
                .min_w(0.0),
        );

    if group.has_pending_approval {
        header = header.child(status_pill(k, t, "Needs review", StatusPillTone::Danger));
    }
    if !meta_parts.is_empty() {
        header = header.child(
            text(meta_parts.join(" · "))
                .font(k.ty.text_xsmall)
                .color(t.text_faint),
        );
    }
    header = header.child(
        icon(chevron, 12.0)
            .color(t.text_faint)
            .group_color(t.text_muted),
    );
    header
}

fn build_completed_group_header(
    k: &Kit,
    t: &ThemeTokens,
    group: &ActivityGroup<'_>,
    expanded: bool,
    thread_id: &str,
) -> El {
    let toggle_id = group.id.clone();
    let duration_ms = (group.ended_at_ms - group.started_at_ms).max(0);
    let dur_str = (group.started_at_ms > 0 && duration_ms >= 1000)
        .then(|| format_duration_compact(duration_ms));

    let label = if group.is_retryable {
        match &dur_str {
            Some(d) => format!("Couldn't finish after {d}"),
            None => "Couldn't finish".to_string(),
        }
    } else if group.summary_label == "Reasoning" {
        match &dur_str {
            Some(d) => format!("Thought for {d}"),
            None => "Thought".to_string(),
        }
    } else if group.summary_label.trim().is_empty() {
        match &dur_str {
            Some(d) => format!("Worked for {d}"),
            None => "Activity".to_string(),
        }
    } else if let Some(d) = &dur_str {
        format!("{} · {d}", group.summary_label)
    } else {
        group.summary_label.clone()
    };

    let chevron = if expanded {
        &icons::CHEVRON_DOWN
    } else {
        &icons::CHEVRON_RIGHT
    };

    let hdr_key = format!("group-hdr:{}", group.id);
    let keep_key = hdr_key.clone();
    let mut trigger = row()
        .key(hdr_key)
        .items_center()
        .gap(5.0)
        .px(4.0)
        .py(3.0)
        .radius(6.0)
        .continuous_corners()
        .hover(t.hover)
        .hover_group()
        .cursor(Cursor::Pointer)
        .role("button")
        .expanded(expanded)
        .label(label.clone())
        .transition(Transition::none())
        .on_press_tx(move |s: &mut AppState, tx: &mut Tx| {
            s.chat_ui.toggle_activity(&toggle_id, expanded);
            tx.keep_on_screen(&keep_key);
        });

    if group.is_retryable {
        trigger = trigger.child(icon(&icons::ALERT, 12.0).color(t.danger));
    }

    trigger = trigger
        .child(
            text(label)
                .font(k.ty.small)
                .color(if group.is_retryable {
                    t.danger
                } else {
                    t.text_muted
                })
                .group_color(if group.is_retryable {
                    t.danger
                } else {
                    t.text_base
                }),
        )
        .child(
            icon(chevron, 11.5)
                .color(t.text_faint)
                .group_color(t.text_muted),
        );

    let mut bar = row().w_full().items_center().gap(8.0).child(trigger);

    if group.error_count > 0 && !group.is_retryable {
        bar = bar.child(status_pill(
            k,
            t,
            format!(
                "{} {}",
                group.error_count,
                if group.error_count == 1 {
                    "error"
                } else {
                    "errors"
                }
            ),
            StatusPillTone::Danger,
        ));
    }

    if group.is_retryable {
        let retry_tid = thread_id.to_string();
        bar = bar.child(spacer()).child(
            Button::new("Retry")
                .variant(ButtonVariant::Outline)
                .control_size(ControlSize::Small)
                .icon(&icons::ROTATE_CCW)
                .on_press(move |s: &mut AppState| {
                    s.dispatch(Action::Chat(ChatAction::RetryFailedTurn {
                        thread_id: retry_tid.clone(),
                    }));
                })
                .build(k)
                .key(format!("retry-group:{}", group.id)),
        );
    }

    bar
}

#[allow(clippy::too_many_arguments)]
fn build_activity_node(
    s: &AppState,
    k: &Kit,
    t: &ThemeTokens,
    group_id: &str,
    pos: (usize, usize),
    reasoning_only: bool,
    node: &ActivityNode<'_>,
    ctx: &ActivityCardContext<'_>,
) -> El {
    let (node_idx, _total_nodes) = pos;
    let needs_divider = !reasoning_only && node_idx > 0;
    let inner = match node {
        ActivityNode::Reasoning(item) => build_reasoning_node(s, k, t, item, reasoning_only, ctx),
        ActivityNode::ProgressMessage(item) => build_progress_note_node(s, k, t, item, ctx),
        ActivityNode::ToolCluster {
            cluster_id,
            title,
            items,
        } => {
            if items.len() == 1 {
                build_tool_card(s, k, t, items[0], ctx)
            } else {
                build_tool_cluster_card(s, k, t, group_id, cluster_id, title, items, ctx)
            }
        }
    };
    let mut row_wrap = col()
        .key(format!("{group_id}:node:{node_idx}"))
        .w_full()
        .min_w(0.0)
        .transition(Transition::none())
        .child(inner);
    if needs_divider {
        row_wrap = row_wrap.border_sides([1.0, 0.0, 0.0, 0.0], t.border_muted);
    }
    row_wrap
}

fn build_reasoning_node(
    s: &AppState,
    k: &Kit,
    t: &ThemeTokens,
    item: &FeedItem,
    reasoning_only: bool,
    ctx: &ActivityCardContext<'_>,
) -> El {
    let FeedItem::Reasoning {
        id,
        content,
        mode,
        streaming,
        ..
    } = item
    else {
        return col().w_full();
    };

    let sections = parse_reasoning_sections(content);
    let md_hooks = activity_markdown_hooks(s, ctx.copied_key);
    let muted_t = ThemeTokens {
        text_base: t.text_muted,
        ..*t
    };

    if sections.is_empty() {
        let fallback_label = if mode.is_empty() || mode == "reasoning" {
            "Thinking…".to_string()
        } else {
            mode.clone()
        };
        return row()
            .key(format!("reason:{id}"))
            .w_full()
            .px(14.0)
            .py(8.5)
            .transition(Transition::none())
            .child(text(fallback_label).font(k.ty.small).color(t.text_muted));
    }

    // Untitled single prose block: render cleanly inside the unified thought card.
    if sections.len() == 1 && sections[0].title == "Thinking" {
        let body_src = sections[0].body.as_str();
        let mut block = col()
            .key(format!("reason:{id}"))
            .w_full()
            .px(14.0)
            .py(if reasoning_only { 6.0 } else { 9.0 })
            .gap(4.0)
            .transition(Transition::none());
        if !body_src.trim().is_empty() {
            block = block.child(desktop_markdown(
                k,
                &muted_t,
                body_src,
                &format!("reason:{id}"),
                true,
                *streaming,
                s.desktop_settings.reduce_motion,
                ctx.workspace_id,
                ctx.workspace_path,
                &[],
                ctx.external_cache.clone(),
                md_hooks,
            ));
        } else {
            block = block.child(text("Thinking…").font(k.ty.small).color(t.text_muted));
        }
        return block;
    }

    // Clean stacked thought rows (matching Claude's expanded thought card).
    // Inside a multi-step card, each section is hairline-separated; inside a reasoning-only card,
    // sections stack calmly with generous vertical rhythm.
    let mut stack = col()
        .key(format!("reason:{id}"))
        .w_full()
        .py(if reasoning_only { 4.0 } else { 0.0 })
        .transition(Transition::none());
    let total = sections.len();
    for (idx, sec) in sections.iter().enumerate() {
        let sec_key = format!("reason:{id}:{idx}");
        let has_body = !sec.body.trim().is_empty();
        let is_live_tail = *streaming && idx + 1 == total;
        let is_open =
            has_body && (is_live_tail || s.chat_ui.expanded_reasoning_sections.contains(&sec_key));
        let toggle_key = sec_key.clone();
        let keep_key = sec_key.clone();
        let chevron = if is_open {
            &icons::CHEVRON_DOWN
        } else {
            &icons::CHEVRON_RIGHT
        };

        let mut trigger = row()
            .w_full()
            .items_center()
            .gap(6.0)
            .px(14.0)
            .py(if reasoning_only { 6.5 } else { 9.0 })
            .hover_group()
            .child(
                text(sec.title.clone())
                    .font(k.ty.small)
                    .color(if is_open { t.text_base } else { t.text_muted })
                    .group_color(t.text_base)
                    .truncate()
                    .shrink()
                    .min_w(0.0),
            );

        if has_body {
            trigger = trigger
                .hover(t.hover)
                .cursor(Cursor::Pointer)
                .role("button")
                .expanded(is_open)
                .label(sec.title.clone())
                .on_press_tx(move |s: &mut AppState, tx: &mut Tx| {
                    if !s.chat_ui.expanded_reasoning_sections.remove(&toggle_key) {
                        s.chat_ui
                            .expanded_reasoning_sections
                            .insert(toggle_key.clone());
                    }
                    tx.keep_on_screen(&keep_key);
                })
                .child(
                    icon(chevron, 11.0)
                        .color(t.text_faint)
                        .group_color(t.text_muted),
                );
        }

        let mut sec_col = col()
            .key(sec_key.clone())
            .w_full()
            .transition(Transition::none())
            .child(trigger);
        if !reasoning_only && idx > 0 {
            sec_col = sec_col.border_sides([1.0, 0.0, 0.0, 0.0], t.border_muted);
        }
        if is_open {
            sec_col = sec_col.child(
                col()
                    .key(format!("{sec_key}:body"))
                    .w_full()
                    .px(14.0)
                    .pt(2.0)
                    .pb(10.0)
                    .transition(Transition::none())
                    .child(desktop_markdown(
                        k,
                        &muted_t,
                        &sec.body,
                        &sec_key,
                        true,
                        is_live_tail,
                        s.desktop_settings.reduce_motion,
                        ctx.workspace_id,
                        ctx.workspace_path,
                        &[],
                        ctx.external_cache.clone(),
                        md_hooks.clone(),
                    )),
            );
        }
        stack = stack.child(sec_col);
    }
    stack
}

fn build_progress_note_node(
    s: &AppState,
    k: &Kit,
    t: &ThemeTokens,
    item: &FeedItem,
    ctx: &ActivityCardContext<'_>,
) -> El {
    let FeedItem::Message {
        id,
        role: FeedMessageRole::Assistant,
        content,
        citations,
        streaming,
        ..
    } = item
    else {
        return col().w_full();
    };
    let chat_citations = to_chat_citations(citations);
    let muted_t = ThemeTokens {
        text_base: t.text_muted,
        ..*t
    };
    col()
        .key(format!("prog:{id}"))
        .w_full()
        .px(14.0)
        .py(9.0)
        .transition(Transition::none())
        .child(desktop_markdown(
            k,
            &muted_t,
            content,
            &format!("prog:{id}"),
            true,
            *streaming,
            s.desktop_settings.reduce_motion,
            ctx.workspace_id,
            ctx.workspace_path,
            &chat_citations,
            ctx.external_cache.clone(),
            activity_markdown_hooks(s, ctx.copied_key),
        ))
}

#[allow(clippy::too_many_arguments)]
fn build_tool_cluster_card(
    s: &AppState,
    k: &Kit,
    t: &ThemeTokens,
    group_id: &str,
    cluster_id: &str,
    title: &str,
    items: &[&FeedItem],
    ctx: &ActivityCardContext<'_>,
) -> El {
    let cluster_key = format!("{group_id}:{cluster_id}");
    let expanded = s.chat_ui.expanded_tool_clusters.contains(&cluster_key);
    let any_running = items.iter().any(|item| {
        matches!(
            item,
            FeedItem::Tool {
                status: ToolRunStatus::Pending | ToolRunStatus::Running,
                ..
            }
        )
    });
    let fail_count = items
        .iter()
        .filter(|item| {
            matches!(
                item,
                FeedItem::Tool {
                    status: ToolRunStatus::Failed,
                    ..
                }
            )
        })
        .count();

    let preview_summary: Option<String> = items.iter().rev().find_map(|item| match item {
        FeedItem::Tool {
            tool_name,
            input,
            output,
            error,
            status,
            ..
        } => {
            let fmt =
                format_tool_card(tool_name, input, output.as_ref(), error.as_deref(), *status);
            (!fmt.subtitle.is_empty()).then_some(fmt.subtitle)
        }
        _ => None,
    });

    let chevron = if expanded {
        &icons::CHEVRON_DOWN
    } else {
        &icons::CHEVRON_RIGHT
    };
    let toggle_key = cluster_key.clone();
    let keep_key = cluster_key.clone();

    let mut hdr = row()
        .w_full()
        .items_center()
        .gap(8.0)
        .px(14.0)
        .py(9.0)
        .fill(if fail_count > 0 {
            k.alpha(t.danger, if t.dark { 0.10 } else { 0.05 })
        } else {
            Color::TRANSPARENT
        })
        .hover(t.hover)
        .hover_group()
        .cursor(Cursor::Pointer)
        .role("button")
        .expanded(expanded)
        .label(format!("{title} ×{}", items.len()))
        .on_press_tx(move |s: &mut AppState, tx: &mut Tx| {
            if !s.chat_ui.expanded_tool_clusters.remove(&toggle_key) {
                s.chat_ui.expanded_tool_clusters.insert(toggle_key.clone());
            }
            tx.keep_on_screen(&keep_key);
        })
        .child(
            text(title.to_string())
                .font(k.ty.small)
                .color(if fail_count > 0 {
                    t.danger
                } else {
                    t.text_muted
                }),
        )
        .child(
            text(format!("×{}", items.len()))
                .font(k.ty.text_xsmall)
                .color(t.text_faint),
        );

    if !expanded && let Some(preview) = preview_summary {
        hdr = hdr.child(
            text(truncate_text(&preview, 68))
                .font(k.ty.small)
                .color(t.text_base)
                .truncate()
                .grow(1.0)
                .min_w(0.0),
        );
    } else {
        hdr = hdr.child(spacer());
    }

    if fail_count > 0 {
        hdr = hdr.child(status_pill(
            k,
            t,
            format!("{fail_count} failed"),
            StatusPillTone::Danger,
        ));
    } else if any_running {
        hdr = hdr.child(Spinner::new().size(11.0).color(t.accent).build(k));
    }
    hdr = hdr.child(
        icon(chevron, 11.0)
            .color(t.text_faint)
            .group_color(t.text_muted),
    );

    let mut container = col()
        .key(cluster_key.clone())
        .w_full()
        .transition(Transition::none())
        .child(hdr);
    if expanded {
        let sub_fill = if t.dark {
            k.alpha(t.panel_bg, 0.35)
        } else {
            k.alpha(t.elevated_bg, 0.45)
        };
        let mut nested = col()
            .key(format!("{cluster_key}:body"))
            .w_full()
            .fill(sub_fill)
            .border_sides([1.0, 0.0, 0.0, 0.0], t.border_muted)
            .transition(Transition::none());
        for (sub_idx, item) in items.iter().enumerate() {
            let mut sub_row = col()
                .w_full()
                .pl(12.0)
                .child(build_tool_card(s, k, t, item, ctx));
            if sub_idx > 0 {
                sub_row = sub_row.border_sides([1.0, 0.0, 0.0, 0.0], t.border_muted);
            }
            nested = nested.child(sub_row);
        }
        container = container.child(nested);
    }
    container
}

fn build_tool_card(
    s: &AppState,
    k: &Kit,
    t: &ThemeTokens,
    item: &FeedItem,
    ctx: &ActivityCardContext<'_>,
) -> El {
    let FeedItem::Tool {
        id,
        tool_name,
        title,
        status,
        input,
        output,
        error,
        diff,
        timestamp_ms,
        completed_at_ms,
        output_truncated,
        ..
    } = item
    else {
        return col().w_full();
    };

    let formatted = format_tool_card(tool_name, input, output.as_ref(), error.as_deref(), *status);
    let awaiting_approval = ctx.pending_interactions.iter().any(|p| match p {
        ChatInteraction::CommandApproval { item_id, .. }
        | ChatInteraction::FileChangeApproval { item_id, .. } => item_id == id,
        ChatInteraction::UserInput { .. } => false,
    });

    let failed = matches!(status, ToolRunStatus::Failed);
    let default_open = awaiting_approval || failed;
    let expanded = s.chat_ui.is_tool_expanded(id, default_open);
    let diff_files = extract_tool_diff(tool_name, input, output.as_ref(), diff.as_deref());

    let display_subtitle = if !formatted.subtitle.is_empty() {
        formatted.subtitle.clone()
    } else {
        title.clone().unwrap_or_default()
    };

    let toggle_id = id.clone();
    let keep_tool_key = format!("tool:{id}");
    let preload_diff = diff_files.clone();
    let chevron = if expanded {
        &icons::CHEVRON_DOWN
    } else {
        &icons::CHEVRON_RIGHT
    };

    let mut hdr = row()
        .w_full()
        .items_center()
        .gap(8.0)
        .px(14.0)
        .py(9.0)
        .fill(if failed || awaiting_approval {
            k.alpha(t.danger, if t.dark { 0.09 } else { 0.045 })
        } else {
            Color::TRANSPARENT
        })
        .hover(t.hover)
        .hover_group()
        .cursor(Cursor::Pointer)
        .role("button")
        .expanded(expanded)
        .label(formatted.title.clone())
        .on_press_tx(move |s: &mut AppState, tx: &mut Tx| {
            s.chat_ui.toggle_tool(&toggle_id, expanded);
            if !expanded && let Some(files) = &preload_diff {
                s.chat_ui
                    .tool_diff_states
                    .entry(toggle_id.clone())
                    .or_insert_with(|| DiffState::new(files.clone()));
            }
            tx.keep_on_screen(&keep_tool_key);
        })
        .child(text(formatted.title.clone()).font(k.ty.small).color(
            if failed || awaiting_approval {
                t.danger
            } else {
                t.text_muted
            },
        ));

    if !display_subtitle.is_empty() {
        hdr = hdr.child(
            text(truncate_text(&display_subtitle, 76))
                .font(k.ty.small)
                .color(t.text_base)
                .truncate()
                .grow(1.0)
                .min_w(0.0),
        );
    } else {
        hdr = hdr.child(spacer());
    }

    if let Some((agent_id, agent_title)) =
        extract_child_agent_ref(tool_name, input, output.as_ref(), ctx.agents)
    {
        let open_id = agent_id;
        let open_title = agent_title;
        hdr = hdr.child(
            Button::new("Inspect")
                .variant(ButtonVariant::Ghost)
                .control_size(ControlSize::Small)
                .icon(&icons::BOT)
                .on_press(move |s: &mut AppState| {
                    s.dispatch(Action::Shell(ShellAction::SetContextSidebarOpen(false)));
                    s.dispatch(Action::Chat(ChatAction::OpenAgentViewer {
                        agent_id: open_id.clone(),
                        title: open_title.clone(),
                    }));
                })
                .build(k)
                .key(format!("tool-agent:{id}")),
        );
    }

    if let Some(ind) = tool_state_indicator(k, t, *status, awaiting_approval) {
        hdr = hdr.child(ind);
    }

    if let Some(end_ms) = completed_at_ms
        && *timestamp_ms > 0
        && *end_ms > *timestamp_ms
    {
        let dur_ms = end_ms - *timestamp_ms;
        if dur_ms >= 500 {
            hdr = hdr.child(
                text(format_duration_compact(dur_ms))
                    .font(k.ty.text_xsmall)
                    .color(t.text_faint),
            );
        }
    }

    hdr = hdr.child(
        icon(chevron, 11.0)
            .color(t.text_faint)
            .group_color(t.text_muted),
    );

    if !expanded {
        return col()
            .key(format!("tool:{id}"))
            .w_full()
            .min_w(0.0)
            .transition(Transition::none())
            .child(hdr);
    }

    let detail_fill = if failed || awaiting_approval {
        k.alpha(t.danger, if t.dark { 0.06 } else { 0.03 })
    } else if t.dark {
        k.alpha(t.panel_bg, 0.35)
    } else {
        k.alpha(t.elevated_bg, 0.45)
    };

    let mut card = col()
        .key(format!("tool:{id}"))
        .w_full()
        .min_w(0.0)
        .transition(Transition::none())
        .child(hdr);

    if expanded {
        let mut details_col = col()
            .key(format!("tool:{id}:details"))
            .w_full()
            .min_w(0.0)
            .gap(8.0)
            .px(14.0)
            .py(10.0)
            .fill(detail_fill)
            .border_sides([1.0, 0.0, 0.0, 0.0], t.border_muted)
            .transition(Transition::none());

        if let Some(err_msg) = error.as_deref().filter(|e| !e.trim().is_empty()) {
            details_col = details_col.child(
                row()
                    .w_full()
                    .items_start()
                    .gap(8.0)
                    .px(10.0)
                    .py(8.0)
                    .radius(8.0)
                    .continuous_corners()
                    .fill(k.alpha(t.danger, 0.10))
                    .border(1.0, k.alpha(t.danger, 0.25))
                    .child(icon(&icons::ALERT, 13.0).color(t.danger).mt(2.0))
                    .child(
                        text(err_msg.to_string())
                            .font(k.ty.text_xsmall)
                            .color(t.text_base)
                            .wrap()
                            .selectable(true)
                            .grow(1.0)
                            .min_w(0.0),
                    ),
            );
        }

        for (d_idx, (label, value)) in formatted.details.iter().enumerate() {
            details_col = details_col.child(
                row()
                    .key(format!("tool:{id}:det:{d_idx}"))
                    .w_full()
                    .items_start()
                    .gap(10.0)
                    .transition(Transition::none())
                    .child(
                        text(label.clone())
                            .font(k.ty.small_medium)
                            .color(t.text_faint)
                            .w(88.0),
                    )
                    .child(
                        text(value.clone())
                            .dir(Direction::Ltr)
                            .font(k.ty.mono)
                            .color(t.text_base)
                            .wrap_anywhere()
                            .selectable(true)
                            .grow(1.0)
                            .min_w(0.0),
                    ),
            );
        }

        if *output_truncated {
            details_col = details_col.child(status_pill(
                k,
                t,
                "Output truncated",
                StatusPillTone::Warning,
            ));
        }

        if let Some(files) = diff_files {
            details_col = details_col.child(build_diff_section(s, k, t, id, &files));
        }

        details_col = details_col.child(build_raw_io_section(
            s,
            k,
            t,
            id,
            input,
            output.as_ref(),
            ctx.copied_key,
        ));

        card = card
            .child(el().w_full().h(1.0).fill(t.border_muted))
            .child(details_col);
    }

    card
}

fn build_diff_section(
    s: &AppState,
    k: &Kit,
    t: &ThemeTokens,
    tool_id: &str,
    files: &[FileDiff],
) -> El {
    let total_lines: usize = files
        .iter()
        .map(|f| f.hunks.iter().map(|h| h.lines.len() + 2).sum::<usize>() + 2)
        .sum();
    let bounded_h = ((total_lines as f32) * 20.0 + 52.0).clamp(120.0, 320.0);

    if let Some(diff_state) = s.chat_ui.tool_diff_states.get(tool_id) {
        let current_mode = diff_state.mode();
        let id_unified = tool_id.to_string();
        let id_split = tool_id.to_string();
        let id_get = tool_id.to_string();
        let id_get_mut = tool_id.to_string();

        let mode_bar = row()
            .w_full()
            .items_center()
            .gap(6.0)
            .child(
                text(format!(
                    "{} {}",
                    files.len(),
                    if files.len() == 1 {
                        "file changed"
                    } else {
                        "files changed"
                    }
                ))
                .font(k.ty.small_medium)
                .color(t.text_muted),
            )
            .child(spacer())
            .child(
                Button::new("Unified")
                    .variant(if current_mode == DiffMode::Unified {
                        ButtonVariant::Neutral
                    } else {
                        ButtonVariant::Ghost
                    })
                    .control_size(ControlSize::Small)
                    .on_press(move |s: &mut AppState| {
                        if let Some(st) = s.chat_ui.tool_diff_states.get_mut(&id_unified) {
                            st.set_mode(DiffMode::Unified);
                        }
                    })
                    .build(k)
                    .key(format!("diff-unified:{tool_id}")),
            )
            .child(
                Button::new("Split")
                    .variant(if current_mode == DiffMode::Split {
                        ButtonVariant::Neutral
                    } else {
                        ButtonVariant::Ghost
                    })
                    .control_size(ControlSize::Small)
                    .on_press(move |s: &mut AppState| {
                        if let Some(st) = s.chat_ui.tool_diff_states.get_mut(&id_split) {
                            st.set_mode(DiffMode::Split);
                        }
                    })
                    .build(k)
                    .key(format!("diff-split:{tool_id}")),
            );

        let diff_view = DiffView::new(
            move |s: &AppState| {
                s.chat_ui
                    .tool_diff_states
                    .get(&id_get)
                    .unwrap_or(&s.chat_ui.empty_diff_state)
            },
            move |s: &mut AppState| {
                s.chat_ui
                    .tool_diff_states
                    .entry(id_get_mut.clone())
                    .or_insert_with(|| DiffState::new(Vec::new()))
            },
        )
        .key(format!("diffview:{tool_id}"))
        .build(s, k);

        return col().w_full().gap(6.0).child(mode_bar).child(
            col()
                .w_full()
                .h(bounded_h)
                .min_h(120.0)
                .radius(8.0)
                .border(1.0, t.border_muted)
                .child(diff_view),
        );
    }

    // Fallback compact static preview when pre-expanded before first user click.
    let init_id = tool_id.to_string();
    let init_files = files.to_vec();
    let mut preview = col()
        .w_full()
        .gap(4.0)
        .padding(8.0)
        .radius(8.0)
        .fill(t.code_bg)
        .border(1.0, t.border_muted)
        .child(
            row()
                .w_full()
                .items_center()
                .child(
                    text("Changes preview")
                        .font(k.ty.small_medium)
                        .color(t.text_muted),
                )
                .child(spacer())
                .child(
                    Button::new("Interactive diff")
                        .variant(ButtonVariant::Outline)
                        .control_size(ControlSize::Small)
                        .on_press(move |s: &mut AppState| {
                            s.chat_ui
                                .tool_diff_states
                                .insert(init_id.clone(), DiffState::new(init_files.clone()));
                        })
                        .build(k)
                        .key(format!("diff-open:{tool_id}")),
                ),
        );

    for file in files.iter().take(2) {
        let path_lbl = file
            .new_path
            .as_deref()
            .or(file.old_path.as_deref())
            .unwrap_or("file");
        preview = preview.child(
            text(middle_truncate_path(path_lbl, 64))
                .font(k.ty.small_medium)
                .color(t.text_base),
        );
        if let Some(hunk) = file.hunks.first() {
            for line in hunk.lines.iter().take(12) {
                let (prefix, color) = match line.kind {
                    LineKind::Added => ("+", t.success),
                    LineKind::Removed => ("-", t.danger),
                    LineKind::Context => (" ", t.text_muted),
                };
                preview = preview.child(
                    text(format!("{prefix}{}", line.text))
                        .font(k.ty.mono)
                        .color(color)
                        .truncate()
                        .w_full(),
                );
            }
        }
    }
    preview
}

fn build_raw_io_section(
    s: &AppState,
    k: &Kit,
    t: &ThemeTokens,
    tool_id: &str,
    input: &Value,
    output: Option<&Value>,
    copied_key: Option<&str>,
) -> El {
    let open = s.chat_ui.expanded_raw_io.contains(tool_id);
    let toggle_id = tool_id.to_string();

    let mut root = col().w_full().gap(6.0).child(
        row().w_full().items_center().child(
            Button::new(if open {
                "Hide raw JSON"
            } else {
                "Show raw JSON"
            })
            .variant(ButtonVariant::Ghost)
            .control_size(ControlSize::Small)
            .on_press(move |s: &mut AppState| {
                if !s.chat_ui.expanded_raw_io.remove(&toggle_id) {
                    s.chat_ui.expanded_raw_io.insert(toggle_id.clone());
                }
            })
            .build(k)
            .key(format!("raw-toggle:{tool_id}")),
        ),
    );

    if !open {
        return root;
    }

    let payload = serde_json::json!({
        "input": input,
        "output": output.unwrap_or(&Value::Null),
    });
    let pretty = serde_json::to_string_pretty(&payload).unwrap_or_else(|_| payload.to_string());
    let truncated = truncate_text(&pretty, RAW_JSON_PREVIEW_LIMIT);
    let copy_key = format!("tool:{tool_id}:raw");
    let copied = copied_key == Some(copy_key.as_str());
    let copy_payload = pretty;
    let copy_key_cb = copy_key.clone();

    root = root.child(
        col()
            .key(format!("tool:{tool_id}:raw-box"))
            .dir(Direction::Ltr)
            .w_full()
            .min_w(0.0)
            .gap(6.0)
            .px(12.0)
            .py(10.0)
            .radius(8.0)
            .fill(t.code_bg)
            .border(1.0, t.border_muted)
            .border_layout()
            .clip_rounded(8.0)
            .transition(Transition::none())
            .child(
                row()
                    .w_full()
                    .items_center()
                    .child(
                        text("Raw payload")
                            .font(k.ty.small_medium)
                            .color(t.text_muted),
                    )
                    .child(spacer())
                    .child(
                        Button::new(if copied { "Copied" } else { "Copy JSON" })
                            .variant(ButtonVariant::Ghost)
                            .control_size(ControlSize::Small)
                            .icon(if copied { k.glyph.check } else { k.glyph.copy })
                            .on_press_tx(move |s: &mut AppState, tx: &mut Tx| {
                                tx.copy(&copy_payload);
                                s.chat_ui.mark_copied(&copy_key_cb, s.now_secs);
                            })
                            .build(k)
                            .key(copy_key),
                    ),
            )
            .child(
                text(truncated)
                    .font(k.ty.mono)
                    .color(t.text_base)
                    .wrap_anywhere()
                    .selectable(true)
                    .w_full()
                    .min_w(0.0),
            ),
    );

    root
}

fn extract_child_agent_ref(
    tool_name: &str,
    input: &Value,
    output: Option<&Value>,
    agents: &[ThreadAgentSummary],
) -> Option<(String, Option<String>)> {
    if !tool_name.to_ascii_lowercase().contains("agent") {
        return None;
    }
    let id_from_val = |v: &Value| -> Option<String> {
        v.as_object().and_then(|obj| {
            ["agentId", "agent_id", "id"]
                .into_iter()
                .find_map(|key| obj.get(key).and_then(Value::as_str))
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
        })
    };

    let agent_id = output
        .and_then(id_from_val)
        .or_else(|| id_from_val(input))?;
    let title = agents
        .iter()
        .find(|a| a.agent_id == agent_id)
        .map(|a| a.title.clone().unwrap_or_else(|| a.name.clone()));
    Some((agent_id, title))
}

fn activity_markdown_hooks(s: &AppState, copied_key: Option<&str>) -> MarkdownHooks {
    let copied_owned = copied_key.map(str::to_owned);
    MarkdownHooks {
        is_copied: Some(Rc::new(move |key: &str| {
            copied_owned.as_deref() == Some(key)
        })),
        on_copy: Some(Rc::new(|s: &mut AppState, key: String, _tx: &mut Tx| {
            s.chat_ui.mark_copied(&key, s.now_secs);
        })),
        on_citation_click: None,
        math_waker: s.services.waker.clone(),
        math_scale: Some((2.0 * s.ui_scale).clamp(2.0, 4.0)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extract_child_agent_ref_matches_agent_tools_and_titles() {
        let agents = vec![ThreadAgentSummary {
            agent_id: "sub-42".into(),
            name: "researcher".into(),
            title: Some("Code Explorer".into()),
            ..Default::default()
        }];
        let found = extract_child_agent_ref(
            "spawnAgent",
            &json!({"task": "check"}),
            Some(&json!({"agentId": "sub-42"})),
            &agents,
        );
        assert_eq!(
            found,
            Some(("sub-42".to_string(), Some("Code Explorer".to_string())))
        );
        assert_eq!(
            extract_child_agent_ref("read_file", &json!({"id": "sub-42"}), None, &agents),
            None
        );
    }

    #[test]
    fn unused_test_placeholder_removed() {
        assert!(extract_tool_diff("read", &json!({}), None, None).is_none());
    }
}
