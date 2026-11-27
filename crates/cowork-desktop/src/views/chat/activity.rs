//! Collapsible activity group timeline, clustered tools, reasoning sections, and native `DiffView` blocks.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::rc::Rc;
use std::sync::Arc;

use rune::{Cursor, Direction, El, ImageCache, Tx, col, icon, memo, row, spacer, text};
use rune_kit::diff::{DiffMode, DiffState, DiffView, FileDiff, LineKind};
use rune_kit::{Button, ButtonVariant, ControlSize, Kit};
use serde::Serialize;
use serde_json::Value;

use crate::actions::{Action, ChatAction, ShellAction};
use crate::state::{
    AppState, ChatInteraction, FeedItem, FeedMessageRole, ThreadAgentSummary, ToolRunStatus,
};
use crate::theme::ThemeTokens;

use super::components::{StatusPillTone, status_pill, timeline_node, tool_state_indicator};
use super::feed_row::to_chat_citations;
use super::icons;
use super::markdown::{MarkdownHooks, desktop_markdown};
use super::model::{
    ActivityGroup, ActivityNode, active_child_agent_labels, extract_tool_diff,
    format_duration_compact, format_tool_card, format_tool_summary, item_is_streaming,
    middle_truncate_path, parse_reasoning_sections, tool_icon_category, truncate_text,
};
use super::row_version::{
    hash_feed_item_or_rev, node_agents_signature, node_copied_key, node_has_active_diff_state,
    node_has_images, node_has_math, node_interactions_signature, node_ui_signature,
    resolve_item_rev_by_ptr,
};

const RAW_JSON_PREVIEW_LIMIT: usize = 12_000;

/// Context passed into `build_activity_group_card`.
pub struct ActivityCardContext<'a> {
    pub thread_id: &'a str,
    pub workspace_id: Option<&'a str>,
    pub workspace_path: Option<&'a str>,
    pub feed: &'a [FeedItem],
    pub item_revs: &'a [u64],
    pub pending_interactions: &'a [ChatInteraction],
    pub agents: &'a [ThreadAgentSummary],
    pub external_cache: Option<Arc<ImageCache>>,
    pub copied_key: Option<&'a str>,
    pub shared_version: u64,
}

fn node_is_streaming(node: &ActivityNode<'_>) -> bool {
    match node {
        ActivityNode::Reasoning(item) | ActivityNode::ProgressMessage(item) => {
            item_is_streaming(item)
        }
        ActivityNode::ToolCluster { items, .. } => items.iter().copied().any(item_is_streaming),
    }
}

fn node_memo_version(
    s: &AppState,
    group_id: &str,
    pos: (usize, usize),
    node: &ActivityNode<'_>,
    ctx: &ActivityCardContext<'_>,
) -> u64 {
    let mut h = DefaultHasher::new();
    let (node_idx, total_nodes) = pos;
    (ctx.shared_version, node_idx, node_idx + 1 == total_nodes).hash(&mut h);
    match node {
        ActivityNode::Reasoning(item) => {
            0u8.hash(&mut h);
            let rev = resolve_item_rev_by_ptr(ctx.feed, ctx.item_revs, item);
            hash_feed_item_or_rev(item, rev, &mut h);
        }
        ActivityNode::ProgressMessage(item) => {
            1u8.hash(&mut h);
            let rev = resolve_item_rev_by_ptr(ctx.feed, ctx.item_revs, item);
            hash_feed_item_or_rev(item, rev, &mut h);
        }
        ActivityNode::ToolCluster {
            cluster_id,
            title,
            items,
        } => {
            (2u8, cluster_id.as_str(), title.as_str(), items.len()).hash(&mut h);
            for item in items {
                let rev = resolve_item_rev_by_ptr(ctx.feed, ctx.item_revs, item);
                hash_feed_item_or_rev(item, rev, &mut h);
            }
        }
    }
    node_copied_key(ctx.copied_key, node).hash(&mut h);
    node_ui_signature(&s.chat_ui, group_id, node).hash(&mut h);
    node_interactions_signature(ctx.pending_interactions, node).hash(&mut h);
    node_agents_signature(ctx.agents, node).hash(&mut h);
    if node_has_math(node) {
        super::math::raster_generation().hash(&mut h);
    }
    if node_has_images(node) {
        super::attachments::image_decode_generation().hash(&mut h);
    }
    h.finish()
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
        .max_w(768.0)
        .gap(6.0)
        .child(header);

    if expanded && !group.nodes.is_empty() {
        let total_nodes = group.nodes.len();
        let memoize_settled_children = group.is_live
            || super::row_version::group_has_active_diff_state(
                &s.chat_ui,
                group,
                ctx.pending_interactions,
            );
        let mut timeline = col()
            .key(format!("group-body:{}", group.id))
            .w_full()
            .pl(6.0)
            .gap(2.0);
        for (idx, node) in group.nodes.iter().enumerate() {
            let child = if memoize_settled_children
                && !node_is_streaming(node)
                && !node_has_active_diff_state(&s.chat_ui, node, ctx.pending_interactions)
            {
                let ver = node_memo_version(s, &group.id, (idx, total_nodes), node, ctx);
                memo(format!("{}:node:{idx}", group.id), ver, || {
                    build_activity_node(s, k, t, &group.id, (idx, total_nodes), node, ctx)
                })
            } else {
                build_activity_node(s, k, t, &group.id, (idx, total_nodes), node, ctx)
            };
            timeline = timeline.child(child);
        }
        card = card.child(timeline);
    }

    if group.is_live {
        card.streaming(true)
    } else {
        card.arrives_whole()
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

    let chevron = if expanded {
        &icons::CHEVRON_DOWN
    } else {
        &icons::CHEVRON_RIGHT
    };

    let mut header = row()
        .key(format!("group-hdr:{}", group.id))
        .w_full()
        .items_center()
        .gap(8.0)
        .px(12.0)
        .py(8.0)
        .radius(10.0)
        .fill(k.alpha(t.elevated_bg, 0.72))
        .focusable(true)
        .border(
            1.0,
            if group.has_pending_approval {
                k.alpha(t.danger, 0.45)
            } else {
                t.border_muted
            },
        )
        .cursor(Cursor::Pointer)
        .role("button")
        .expanded(expanded)
        .label(action_text.clone())
        .on_press(move |s: &mut AppState| s.chat_ui.toggle_activity(&toggle_id, expanded))
        .child(icon(&icons::CLOCK, 13.0).color(t.accent))
        .child(
            text(action_text)
                .font(k.ty.small_medium)
                .color(t.text_base)
                .truncate()
                .grow(1.0)
                .min_w(0.0),
        );
    header = k.interactive_with(header, t.elevated_bg, t.pressed);

    if group.has_pending_approval {
        header = header.child(status_pill(k, t, "Needs review", StatusPillTone::Danger));
    }
    if group.tool_count > 0 {
        header = header.child(status_pill(
            k,
            t,
            format!(
                "{} {}",
                group.tool_count,
                if group.tool_count == 1 {
                    "step"
                } else {
                    "steps"
                }
            ),
            StatusPillTone::Neutral,
        ));
    }
    if elapsed_ms >= 1000 {
        header = header.child(
            text(format_duration_compact(elapsed_ms))
                .font(k.ty.text_xsmall)
                .color(t.text_faint),
        );
    }
    header.child(icon(chevron, 13.0).color(t.text_muted))
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

    let mut trigger = row()
        .key(format!("group-hdr:{}", group.id))
        .items_center()
        .gap(5.0)
        .px(6.0)
        .py(3.0)
        .radius(6.0)
        .focusable(true)
        .cursor(Cursor::Pointer)
        .role("button")
        .expanded(expanded)
        .label(label.clone())
        .on_press(move |s: &mut AppState| s.chat_ui.toggle_activity(&toggle_id, expanded));
    if group.is_retryable {
        trigger = trigger.child(icon(&icons::ALERT, 12.0).color(t.danger));
    }
    let trigger = trigger
        .child(
            text(label)
                .font(k.ty.small_medium)
                .color(if group.is_retryable {
                    t.danger
                } else {
                    t.text_muted
                }),
        )
        .child(icon(chevron, 12.0).color(t.text_faint));
    let trigger = k.interactive_with(trigger, t.hover, t.pressed);

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
        bar = bar.child(
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

fn build_activity_node(
    s: &AppState,
    k: &Kit,
    t: &ThemeTokens,
    group_id: &str,
    pos: (usize, usize),
    node: &ActivityNode<'_>,
    ctx: &ActivityCardContext<'_>,
) -> El {
    let (node_idx, total_nodes) = pos;
    let is_last = node_idx + 1 == total_nodes;
    match node {
        ActivityNode::Reasoning(item) => {
            let content = build_reasoning_node(s, k, t, item, ctx);
            timeline_node(
                k,
                t,
                icon(&icons::BRAIN, 11.0).color(t.text_muted),
                is_last,
                content,
            )
            .key(format!("{group_id}:node:{node_idx}"))
        }
        ActivityNode::ProgressMessage(item) => {
            let content = build_progress_note_node(s, k, t, item, ctx);
            timeline_node(
                k,
                t,
                icon(&icons::LIGHTBULB, 11.0).color(t.text_muted),
                is_last,
                content,
            )
            .key(format!("{group_id}:node:{node_idx}"))
        }
        ActivityNode::ToolCluster {
            cluster_id,
            title,
            items,
        } => {
            let first_tool_name = items
                .first()
                .and_then(|item| match item {
                    FeedItem::Tool { tool_name, .. } => Some(tool_name.as_str()),
                    _ => None,
                })
                .unwrap_or("tool");
            let dot = icon(icons::tool_icon(tool_icon_category(first_tool_name)), 11.0)
                .color(t.text_muted);

            let content = if items.len() == 1 {
                build_tool_card(s, k, t, items[0], ctx)
            } else {
                build_tool_cluster_card(s, k, t, group_id, cluster_id, title, items, ctx)
            };
            timeline_node(k, t, dot, is_last, content).key(format!("{group_id}:node:{node_idx}"))
        }
    }
}

fn build_reasoning_node(
    s: &AppState,
    k: &Kit,
    t: &ThemeTokens,
    item: &FeedItem,
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

    if sections.len() <= 1 {
        let heading = sections
            .first()
            .map(|sec| sec.title.as_str())
            .filter(|t| !t.is_empty())
            .unwrap_or(if mode.is_empty() {
                "Thinking"
            } else {
                mode.as_str()
            });
        let body_src = sections
            .first()
            .map(|sec| sec.body.as_str())
            .unwrap_or(content.as_str());

        let mut card = col()
            .key(format!("reason:{id}"))
            .w_full()
            .gap(4.0)
            .px(10.0)
            .py(8.0)
            .radius(8.0)
            .fill(k.alpha(t.elevated_bg, 0.35))
            .border(1.0, k.alpha(t.border_muted, 0.7))
            .child(
                text(heading.to_string())
                    .font(k.ty.small_medium)
                    .color(t.text_muted),
            );
        if !body_src.trim().is_empty() {
            card = card.child(desktop_markdown(
                k,
                t,
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
        }
        return card;
    }

    let mut stack = col().key(format!("reason:{id}")).w_full().gap(6.0);
    let total = sections.len();
    for (idx, sec) in sections.iter().enumerate() {
        let sec_key = format!("reason:{id}:{idx}");
        let is_open = (*streaming && idx + 1 == total)
            || s.chat_ui.expanded_reasoning_sections.contains(&sec_key);
        let toggle_key = sec_key.clone();
        let chevron = if is_open {
            &icons::CHEVRON_DOWN
        } else {
            &icons::CHEVRON_RIGHT
        };

        let trigger = row()
            .w_full()
            .items_center()
            .gap(6.0)
            .px(10.0)
            .py(6.0)
            .radius(8.0)
            .fill(k.alpha(t.elevated_bg, 0.35))
            .focusable(true)
            .cursor(Cursor::Pointer)
            .role("button")
            .expanded(is_open)
            .label(sec.title.clone())
            .on_press(move |s: &mut AppState| {
                if !s.chat_ui.expanded_reasoning_sections.remove(&toggle_key) {
                    s.chat_ui
                        .expanded_reasoning_sections
                        .insert(toggle_key.clone());
                }
            })
            .child(icon(chevron, 12.0).color(t.text_faint))
            .child(
                text(sec.title.clone())
                    .font(k.ty.small_medium)
                    .color(t.text_muted)
                    .truncate()
                    .grow(1.0),
            );
        let trigger = k.interactive_with(trigger, t.elevated_bg, t.pressed);

        let mut sec_col = col().key(sec_key.clone()).w_full().gap(4.0).child(trigger);
        if is_open && !sec.body.trim().is_empty() {
            sec_col = sec_col.child(col().w_full().pl(10.0).child(desktop_markdown(
                k,
                t,
                &sec.body,
                &sec_key,
                true,
                *streaming && idx + 1 == total,
                s.desktop_settings.reduce_motion,
                ctx.workspace_id,
                ctx.workspace_path,
                &[],
                ctx.external_cache.clone(),
                md_hooks.clone(),
            )));
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
    col()
        .key(format!("prog:{id}"))
        .w_full()
        .px(10.0)
        .py(6.0)
        .radius(8.0)
        .fill(k.alpha(t.elevated_bg, 0.35))
        .child(desktop_markdown(
            k,
            t,
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

    let status_pill_el = if fail_count > 0 {
        Some(status_pill(
            k,
            t,
            format!("{fail_count} failed"),
            StatusPillTone::Danger,
        ))
    } else if any_running {
        Some(status_pill(k, t, "Running", StatusPillTone::Accent))
    } else {
        None
    };

    let preview_lines: Vec<String> = if expanded {
        Vec::new()
    } else {
        items
            .iter()
            .rev()
            .take(2)
            .filter_map(|item| match item {
                FeedItem::Tool {
                    tool_name,
                    input,
                    status,
                    ..
                } => {
                    let (_, subtitle) = format_tool_summary(tool_name, input, *status);
                    (!subtitle.is_empty()).then_some(subtitle)
                }
                _ => None,
            })
            .collect()
    };

    let chevron = if expanded {
        &icons::CHEVRON_DOWN
    } else {
        &icons::CHEVRON_RIGHT
    };
    let toggle_key = cluster_key.clone();

    let mut hdr = row()
        .w_full()
        .items_center()
        .gap(8.0)
        .child(
            text(title.to_string())
                .font(k.ty.small_medium)
                .color(t.text_base),
        )
        .child(status_pill(
            k,
            t,
            format!("×{}", items.len()),
            StatusPillTone::Neutral,
        ))
        .child(spacer());
    if let Some(pill) = status_pill_el {
        hdr = hdr.child(pill);
    }
    hdr = hdr.child(icon(chevron, 12.0).color(t.text_faint));

    let trigger = col()
        .w_full()
        .gap(3.0)
        .px(8.0)
        .py(5.0)
        .radius(7.0)
        .fill(if fail_count > 0 {
            k.alpha(t.danger, 0.08)
        } else {
            rune::Color::TRANSPARENT
        })
        .hover(t.hover)
        .border(
            1.0,
            if fail_count > 0 {
                k.alpha(t.danger, 0.35)
            } else {
                rune::Color::TRANSPARENT
            },
        )
        .cursor(Cursor::Pointer)
        .role("button")
        .expanded(expanded)
        .label(format!("{title} ×{}", items.len()))
        .on_press(move |s: &mut AppState| {
            if !s.chat_ui.expanded_tool_clusters.remove(&toggle_key) {
                s.chat_ui.expanded_tool_clusters.insert(toggle_key.clone());
            }
        })
        .child(hdr);
    let mut trigger = k.interactive_with(trigger, t.hover, t.pressed);

    if !expanded && !preview_lines.is_empty() {
        for preview in preview_lines {
            trigger = trigger.child(
                text(truncate_text(&preview, 92))
                    .font(k.ty.text_xsmall)
                    .color(t.text_muted)
                    .truncate()
                    .w_full(),
            );
        }
    }

    let mut container = col().key(cluster_key).w_full().gap(6.0).child(trigger);
    if expanded {
        let mut nested = col().w_full().pl(8.0).gap(6.0);
        for item in items {
            nested = nested.child(build_tool_card(s, k, t, item, ctx));
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

    let default_open = awaiting_approval || matches!(status, ToolRunStatus::Failed);
    let expanded = s.chat_ui.is_tool_expanded(id, default_open);

    let display_subtitle = if !formatted.subtitle.is_empty() {
        formatted.subtitle.clone()
    } else {
        title.clone().unwrap_or_default()
    };

    let toggle_id = id.clone();
    let toggle_thread_id = ctx.thread_id.to_string();
    let chevron = if expanded {
        &icons::CHEVRON_DOWN
    } else {
        &icons::CHEVRON_RIGHT
    };

    let attention = awaiting_approval || matches!(status, ToolRunStatus::Failed);
    let mut hdr = row()
        .w_full()
        .items_center()
        .gap(8.0)
        .px(8.0)
        .py(5.0)
        .radius(7.0)
        .fill(if attention {
            k.alpha(t.danger, 0.08)
        } else {
            rune::Color::TRANSPARENT
        })
        .focusable(true)
        .border(
            1.0,
            if attention {
                k.alpha(t.danger, 0.4)
            } else {
                rune::Color::TRANSPARENT
            },
        )
        .cursor(Cursor::Pointer)
        .role("button")
        .expanded(expanded)
        .label(formatted.title.clone())
        .on_press(move |s: &mut AppState| {
            s.chat_ui.toggle_tool(&toggle_id, expanded);
            if !expanded {
                ensure_tool_diff_state_loaded(s, &toggle_thread_id, &toggle_id);
            }
        })
        .child(
            text(formatted.title.clone())
                .font(k.ty.small_medium)
                .color(t.text_base),
        );
    hdr = k.interactive_with(hdr, t.hover, t.pressed);

    if !display_subtitle.is_empty() {
        hdr = hdr.child(
            text(truncate_text(&display_subtitle, 72))
                .font(k.ty.text_xsmall)
                .color(t.text_muted)
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

    hdr = hdr.child(icon(chevron, 12.0).color(t.text_faint));

    let mut card = col()
        .key(format!("tool:{id}"))
        .w_full()
        .min_w(0.0)
        .gap(6.0)
        .child(hdr);

    if expanded {
        let mut details_col = col()
            .w_full()
            .min_w(0.0)
            .gap(8.0)
            .px(12.0)
            .py(10.0)
            .radius(8.0)
            .fill(t.card_bg)
            .border(1.0, t.border_muted)
            .border_layout()
            .clip_rounded(8.0);

        if let Some(err_msg) = error.as_deref().filter(|e| !e.trim().is_empty()) {
            details_col = details_col.child(
                row()
                    .w_full()
                    .items_start()
                    .gap(8.0)
                    .px(10.0)
                    .py(8.0)
                    .radius(8.0)
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

        if s.chat_ui.tool_diff_states.contains_key(id) {
            details_col = details_col.child(build_diff_section_interactive(s, k, t, id));
        } else if let Some(files) =
            extract_tool_diff(tool_name, input, output.as_ref(), diff.as_deref())
        {
            details_col = details_col.child(build_diff_section_preview(k, t, id, &files));
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

        card = card.child(details_col);
    }

    card
}

fn diff_meta_counts(files: &[FileDiff]) -> (usize, usize) {
    let total_lines: usize = files
        .iter()
        .map(|f| f.hunks.iter().map(|h| h.lines.len() + 2).sum::<usize>() + 2)
        .sum();
    (files.len(), total_lines)
}

fn find_tool_item_in_state<'a>(
    s: &'a AppState,
    thread_id: &str,
    tool_id: &str,
) -> Option<&'a FeedItem> {
    let find_in = |feed: &'a [FeedItem]| {
        feed.iter()
            .rev()
            .find(|item| matches!(item, FeedItem::Tool { id, .. } if id == tool_id))
    };
    if let Some(agent_id) = thread_id.strip_prefix("agent:") {
        if let Some(rt) = s.thread_runtime_by_id.get(agent_id)
            && let Some(found) = find_in(&rt.feed)
        {
            return Some(found);
        }
        if let Some(viewer) = s.agent_viewer.as_ref()
            && let Some(rt) = s.thread_runtime_by_id.get(&viewer.thread_id)
            && let Some(feed) = rt.agent_run_feeds.get(agent_id)
            && let Some(found) = find_in(feed)
        {
            return Some(found);
        }
    }
    s.thread_runtime_by_id
        .get(thread_id)
        .and_then(|rt| find_in(&rt.feed))
}

fn ensure_tool_diff_state_loaded(s: &mut AppState, thread_id: &str, tool_id: &str) {
    if s.chat_ui.tool_diff_states.contains_key(tool_id) {
        return;
    }
    let extracted = find_tool_item_in_state(s, thread_id, tool_id).and_then(|item| match item {
        FeedItem::Tool {
            tool_name,
            input,
            output,
            diff,
            ..
        } => extract_tool_diff(tool_name, input, output.as_ref(), diff.as_deref()),
        _ => None,
    });
    if let Some(files) = extracted {
        let meta = diff_meta_counts(&files);
        s.chat_ui
            .tool_diff_states
            .insert(tool_id.to_string(), DiffState::new(files));
        s.chat_ui.tool_diff_meta.insert(tool_id.to_string(), meta);
        s.chat_ui.bump_tool_diff_rev(tool_id);
    }
}

fn build_diff_section_interactive(s: &AppState, k: &Kit, t: &ThemeTokens, tool_id: &str) -> El {
    let Some(diff_state) = s.chat_ui.tool_diff_states.get(tool_id) else {
        return col().w_full();
    };
    let (file_count, total_lines) = s
        .chat_ui
        .tool_diff_meta
        .get(tool_id)
        .copied()
        .unwrap_or((1, 10));
    let bounded_h = ((total_lines as f32) * 20.0 + 52.0).clamp(120.0, 320.0);
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
                "{file_count} {}",
                if file_count == 1 {
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
                        s.chat_ui.bump_tool_diff_rev(&id_unified);
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
                        s.chat_ui.bump_tool_diff_rev(&id_split);
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
    // The box has a bounded height: a bar says the diff continues and how far.
    .scroll_bar(true)
    .build(s, k);

    col().w_full().gap(6.0).child(mode_bar).child(
        col()
            .w_full()
            .h(bounded_h)
            .min_h(120.0)
            .radius(8.0)
            .border(1.0, t.border_muted)
            .child(diff_view),
    )
}

fn build_diff_section_preview(k: &Kit, t: &ThemeTokens, tool_id: &str, files: &[FileDiff]) -> El {
    let meta = diff_meta_counts(files);
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
                            s.chat_ui.tool_diff_meta.insert(init_id.clone(), meta);
                            s.chat_ui.bump_tool_diff_rev(&init_id);
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

    #[derive(Serialize)]
    struct RawToolPayload<'a> {
        input: &'a Value,
        output: &'a Value,
    }
    let payload = RawToolPayload {
        input,
        output: output.unwrap_or(&Value::Null),
    };
    let pretty = serde_json::to_string_pretty(&payload)
        .unwrap_or_else(|_| serde_json::to_string(&payload).unwrap_or_default());
    let truncated = truncate_text(&pretty, RAW_JSON_PREVIEW_LIMIT);
    let copy_key = format!("tool:{tool_id}:raw");
    let copied = copied_key == Some(copy_key.as_str());
    let copy_payload = pretty;
    let copy_key_cb = copy_key.clone();

    root = root.child(
        col()
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
    if !super::model::ascii_contains_ignore_case(tool_name, "agent") {
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
        is_copied: Some(Rc::new({
            let copied_cb = copied_owned.clone();
            move |key: &str| copied_cb.as_deref() == Some(key)
        })),
        active_copied_key: copied_owned,
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
