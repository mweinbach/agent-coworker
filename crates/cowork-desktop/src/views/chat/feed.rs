//! Virtualized, bottom-sticky chat feed shared by `ChatView` and `AgentRunViewer`.

use std::collections::HashMap;
use std::sync::Arc;

use rune::{El, GrowthSpec, ImageCache, ScrollSpec, Tx, col, el, row, text};
use rune_kit::{Button, ButtonVariant, ControlSize, Kit, scroll_bar};

use crate::state::{AppState, ChatInteraction, FeedItem, ThreadAgentSummary};
use crate::theme::ThemeTokens;

use super::components::{
    day_separator_row, empty_feed_state, scroll_to_latest_pill, transcript_only_banner,
    working_placeholder_row,
};
use super::feed_row::{FeedRowContext, build_feed_row};
use super::model::{
    ChatRenderItem, build_chat_render_items, build_mention_catalog, day_bucket_key,
    format_day_separator, prepare_feed, select_feed_window, should_show_working_placeholder,
};
use super::state::FEED_OLDER_PAGE_SIZE;

/// Parameters configuring one feed viewport instance (main chat or subagent viewer).
pub struct ChatFeedProps<'a> {
    pub thread_key: &'a str,
    pub raw_feed: &'a [FeedItem],
    pub thread_busy: bool,
    pub hydrating: bool,
    pub transcript_only: bool,
    pub disconnected: bool,
    pub reconnecting: bool,
    pub pending_interactions: &'a [ChatInteraction],
    pub interaction_errors: &'a HashMap<String, String>,
    pub agents: &'a [ThreadAgentSummary],
    pub workspace_id: Option<&'a str>,
    pub workspace_path: Option<&'a str>,
    pub external_cache: Option<Arc<ImageCache>>,
    pub is_agent_viewer: bool,
    pub scroll_area_key: &'a str,
    pub viewport_key: &'a str,
    pub frame_key: &'a str,
}

/// Builds the scrollable transcript area including day separators, progressive windowing,
/// live growth stack animation, and floating jump-to-latest pill.
pub fn build_chat_feed(s: &AppState, k: &Kit, t: &ThemeTokens, props: &ChatFeedProps<'_>) -> El {
    let developer_mode = s.desktop_settings.developer_mode && !props.is_agent_viewer;
    let prepared = prepare_feed(props.raw_feed, developer_mode);
    let total_items = prepared.len();
    let visible_count = s.chat_ui.visible_count_for(props.thread_key);
    let (visible_slice, hidden_count) = select_feed_window(&prepared, visible_count);

    let _ = (props.interaction_errors, props.agents);

    if visible_slice.is_empty() && props.pending_interactions.is_empty() {
        let mut empty_col = col()
            .key(props.frame_key)
            .w_full()
            .grow(1.0)
            .min_h(0.0)
            .items_center()
            .px(24.0)
            .py(20.0);
        if props.transcript_only {
            empty_col = empty_col.child(
                col()
                    .w_full()
                    .max_w(768.0)
                    .pb(16.0)
                    .child(transcript_only_banner(k, t)),
            );
        }
        return empty_col.child(empty_feed_state(
            k,
            t,
            props.hydrating,
            props.disconnected,
            props.reconnecting,
        ));
    }

    let render_items = build_chat_render_items(visible_slice, props.thread_busy);
    let catalog = build_mention_catalog(&s.skills, &s.plugins);
    let copied_key = s
        .chat_ui
        .copied_feedback
        .as_ref()
        .filter(|(k, _)| s.chat_ui.is_copied(k, s.now_secs))
        .map(|(k, _)| k.as_str());

    let row_ctx = FeedRowContext {
        workspace_id: props.workspace_id,
        workspace_path: props.workspace_path,
        catalog: &catalog,
        external_cache: props.external_cache.clone(),
        is_agent_viewer: props.is_agent_viewer,
        copied_key,
    };

    let mut children: Vec<El> = Vec::with_capacity(render_items.len() + 6);
    if props.transcript_only {
        children.push(
            col()
                .key("transcript-only-banner")
                .w_full()
                .max_w(768.0)
                .child(transcript_only_banner(k, t)),
        );
    }

    if hidden_count > 0 {
        let next_batch = hidden_count.min(FEED_OLDER_PAGE_SIZE);
        let thread_key_older = props.thread_key.to_string();
        let older_btn = Button::new(format!(
            "Show {next_batch} older messages ({hidden_count} hidden)"
        ))
        .variant(ButtonVariant::Outline)
        .control_size(ControlSize::Small)
        .on_press(move |s: &mut AppState| {
            s.chat_ui
                .show_older_messages(&thread_key_older, total_items, FEED_OLDER_PAGE_SIZE);
        })
        .build(k)
        .key("older-messages-btn");
        children.push(
            row()
                .key("older-messages")
                .w_full()
                .max_w(768.0)
                .justify_center()
                .py(4.0)
                .child(older_btn),
        );
    }

    let mut prev_bucket: Option<(i32, u32)> = None;
    for node in &render_items {
        if let Some(ts) = render_item_timestamp(node)
            && let Some(bucket) = day_bucket_key(ts)
        {
            if prev_bucket != Some(bucket) {
                children.push(
                    row()
                        .key(format!("day:{}:{}", bucket.0, bucket.1))
                        .w_full()
                        .max_w(768.0)
                        .child(day_separator_row(
                            k,
                            t,
                            format_day_separator(ts, s.now_secs),
                        )),
                );
            }
            prev_bucket = Some(bucket);
        }

        match node {
            ChatRenderItem::Row(item) => {
                children.push(build_feed_row(s, k, t, item, &row_ctx));
            }
            ChatRenderItem::ActivityGroup(group) => {
                // Full timeline card will replace this placeholder in Slice 3 (`activity.rs`).
                let label = if group.is_live {
                    group.current_action.clone()
                } else {
                    group.summary_label.clone()
                };
                children.push(
                    row()
                        .key(format!("group:{}", group.id))
                        .w_full()
                        .max_w(768.0)
                        .px(12.0)
                        .py(8.0)
                        .radius(10.0)
                        .fill(k.alpha(t.elevated_bg, 0.55))
                        .border(1.0, t.border_muted)
                        .child(text(label).font(k.ty.small_medium).color(t.text_muted)),
                );
            }
        }
    }

    if should_show_working_placeholder(&render_items, props.thread_busy) {
        children.push(working_placeholder_row(k, t).key("working-placeholder"));
    }

    // Pending `ask` / approval cards are mounted here in Slice 3 (`interaction.rs`).
    for (idx, _interaction) in props.pending_interactions.iter().enumerate() {
        children.push(el().key(format!("interaction:{idx}")).w_full().max_w(768.0));
    }

    let tk_at = props.thread_key.to_string();
    let tk_far = props.thread_key.to_string();
    let frame_key_str = props.frame_key.to_string();

    let rows_stack = col()
        .key("chat-feed-rows")
        .w_full()
        .items_center()
        .px(24.0)
        .pt(20.0)
        .pb(20.0)
        .gap(14.0)
        .growth(GrowthSpec::default())
        .virtualize(84.0)
        .children(children);

    let viewport = col()
        .key(props.viewport_key)
        .w_full()
        .grow(1.0)
        .min_h(0.0)
        .scroll(ScrollSpec { stick_bottom: true })
        .on_at_bottom(move |s: &mut AppState, at| {
            s.chat_ui
                .update_scroll_state(&tk_at, Some(at), None, total_items);
        })
        .on_far_from_bottom_under(160.0, &frame_key_str, move |s: &mut AppState, far| {
            s.chat_ui
                .update_scroll_state(&tk_far, None, Some(far), total_items);
        })
        .child(rows_stack);

    let scrolled = scroll_bar(k, props.scroll_area_key, props.viewport_key, viewport)
        .w_full()
        .grow(1.0)
        .min_h(0.0);

    let mut frame = col()
        .key(props.frame_key)
        .w_full()
        .grow(1.0)
        .min_h(0.0)
        .child(scrolled);

    if s.chat_ui.show_jump_to_latest(props.thread_key, total_items) {
        let unseen = s.chat_ui.unseen_update_count(props.thread_key, total_items);
        let tk_jump = props.thread_key.to_string();
        let vp_jump = props.viewport_key.to_string();
        let pill = scroll_to_latest_pill(k, t, unseen, move |s: &mut AppState, tx: &mut Tx| {
            s.chat_ui.mark_jumped_to_latest(&tk_jump, total_items);
            tx.scroll_to_bottom(&vp_jump);
        });
        frame = frame.child(
            row()
                .key("jump-to-latest-wrap")
                .pin(Some(0.0), None, Some(0.0), Some(14.0))
                .justify_center()
                .child(pill),
        );
    }

    frame
}

fn render_item_timestamp(item: &ChatRenderItem<'_>) -> Option<i64> {
    let raw = match item {
        ChatRenderItem::Row(feed_item) => feed_item,
        ChatRenderItem::ActivityGroup(group) => return Some(group.started_at_ms),
    };
    Some(match raw {
        FeedItem::Message { timestamp_ms, .. }
        | FeedItem::Reasoning { timestamp_ms, .. }
        | FeedItem::Tool { timestamp_ms, .. }
        | FeedItem::Todos { timestamp_ms, .. }
        | FeedItem::Log { timestamp_ms, .. }
        | FeedItem::Error { timestamp_ms, .. }
        | FeedItem::System { timestamp_ms, .. } => *timestamp_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn select_feed_window_anchors_latest_messages() {
        let items: Vec<i32> = (0..120).collect();
        let (tail, hidden) = select_feed_window(&items, 40);
        assert_eq!(hidden, 80);
        assert_eq!(tail.first().copied(), Some(80));
        assert_eq!(tail.last().copied(), Some(119));
    }
}
