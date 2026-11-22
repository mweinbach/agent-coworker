//! Virtualized, bottom-sticky chat feed shared by `ChatView` and `AgentRunViewer`.

use std::borrow::Cow;
use std::cell::OnceCell;
use std::collections::HashMap;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::rc::Rc;
use std::sync::Arc;

use rune::{El, GrowthSpec, ImageCache, ScrollSpec, Tx, col, memo, row};
use rune_kit::{Button, ButtonVariant, ControlSize, Kit, scroll_bar};

use crate::state::{AppState, ChatInteraction, FeedItem, ThreadAgentSummary};
use crate::theme::ThemeTokens;

use super::activity::{ActivityCardContext, build_activity_group_card};
use super::components::{
    day_separator_row, empty_feed_state, scroll_to_latest_pill, transcript_only_banner,
    working_placeholder_row,
};
use super::feed_row::{FeedRowContext, build_feed_row};
use super::interaction::{build_interaction_card, interaction_card_key};
use super::model::{
    ActivityGroup, ChatRenderItem, MentionCatalog, build_activity_group_for_window,
    build_chat_render_items, build_mention_catalog, day_bucket_key, format_day_separator, item_id,
    prepare_feed, select_feed_window, should_show_working_placeholder,
};
use super::row_version::{
    GroupFp, ItemFp, activity_ui_signature, group_has_diff_state, interactions_signature,
    skills_plugins_signature,
};
use super::state::FEED_OLDER_PAGE_SIZE;

/// Where a feed's items live in `AppState`. Transcript rows are built at layout time, only for
/// the mounted window, from the state the window hands them, so they look their items up here.
#[derive(Clone, Debug)]
pub enum FeedSource {
    /// A thread's own transcript and its pending interactions and subagents.
    Thread(String),
    /// A subagent run's transcript, shown in the agent viewer.
    AgentRun { thread_id: String, agent_id: String },
}

/// The state a feed reads, borrowed from `AppState`.
struct FeedRefs<'s> {
    feed: &'s [FeedItem],
    pending_interactions: &'s [ChatInteraction],
    agents: &'s [ThreadAgentSummary],
}

impl FeedSource {
    fn resolve<'s>(&self, s: &'s AppState) -> FeedRefs<'s> {
        match self {
            FeedSource::Thread(id) => {
                let rt = s.thread_runtime_by_id.get(id);
                FeedRefs {
                    feed: rt.map(|r| r.feed.as_slice()).unwrap_or(&[]),
                    pending_interactions: rt
                        .map(|r| r.pending_interactions.as_slice())
                        .unwrap_or(&[]),
                    agents: rt.map(|r| r.agents.as_slice()).unwrap_or(&[]),
                }
            }
            FeedSource::AgentRun {
                thread_id,
                agent_id,
            } => FeedRefs {
                feed: s
                    .thread_runtime_by_id
                    .get(agent_id)
                    .map(|r| r.feed.as_slice())
                    .filter(|items| !items.is_empty())
                    .or_else(|| {
                        s.thread_runtime_by_id
                            .get(thread_id)
                            .and_then(|r| r.agent_run_feeds.get(agent_id))
                            .map(Vec::as_slice)
                    })
                    .unwrap_or(&[]),
                pending_interactions: &[],
                agents: &[],
            },
        }
    }
}

/// Parameters configuring one feed viewport instance (main chat or subagent viewer).
pub struct ChatFeedProps<'a> {
    pub thread_key: &'a str,
    pub source: FeedSource,
    pub thread_busy: bool,
    pub hydrating: bool,
    pub transcript_only: bool,
    pub disconnected: bool,
    pub reconnecting: bool,
    pub interaction_errors: &'a HashMap<String, String>,
    pub workspace_id: Option<&'a str>,
    pub workspace_path: Option<&'a str>,
    pub external_cache: Option<Arc<ImageCache>>,
    pub is_agent_viewer: bool,
    pub scroll_area_key: &'a str,
    pub viewport_key: &'a str,
    pub frame_key: &'a str,
}

/// One row of the virtual transcript stack.
enum RowSpec {
    /// A cheap row the view builds outright (banner, pager, day separator, placeholder, card).
    Ready { key: String, el: El },
    /// A transcript item at `index` in the source feed; its memo version is hashed lazily on mount.
    Item {
        key: String,
        id: String,
        index: usize,
    },
    /// An activity group whose member `FeedItem`s sit at `item_indices` in the source feed.
    Group {
        key: String,
        id: String,
        render_index: usize,
        item_indices: Vec<usize>,
        is_last_render_item: bool,
    },
}

impl RowSpec {
    fn key(&self) -> &str {
        match self {
            RowSpec::Ready { key, .. } | RowSpec::Item { key, .. } | RowSpec::Group { key, .. } => {
                key
            }
        }
    }
}

/// Everything a transcript row's build reads besides `AppState`, owned so the rows can be built
/// at layout time after the view has returned.
struct FeedRows {
    rows: Vec<RowSpec>,
    source: FeedSource,
    developer_mode: bool,
    hidden_count: usize,
    thread_busy: bool,
    thread_key: String,
    workspace_id: Option<String>,
    workspace_path: Option<String>,
    catalog: OnceCell<MentionCatalog>,
    row_version_base: u64,
    group_version_base: u64,
    external_cache: Option<Arc<ImageCache>>,
    is_agent_viewer: bool,
    copied_key: Option<String>,
    kit: Kit,
    tokens: ThemeTokens,
}

impl FeedRows {
    fn resolve_group<'s>(
        &self,
        refs: &FeedRefs<'s>,
        id: &str,
        render_index: usize,
        item_indices: &[usize],
        is_last_render_item: bool,
    ) -> Option<ActivityGroup<'s>> {
        if !item_indices.is_empty() {
            let mut items = Vec::with_capacity(item_indices.len());
            let mut all_in_bounds = true;
            for &idx in item_indices {
                if let Some(item) = refs.feed.get(idx) {
                    items.push(item);
                } else {
                    all_in_bounds = false;
                    break;
                }
            }
            if all_in_bounds {
                let group =
                    build_activity_group_for_window(items, is_last_render_item, self.thread_busy);
                if group.id == id {
                    return Some(group);
                }
            }
        }

        // Fallback if the feed shifted underneath the cached indices.
        let prepared = prepare_feed(refs.feed, self.developer_mode);
        let window = prepared.get(self.hidden_count..).unwrap_or(&[]);
        let items = build_chat_render_items(window, self.thread_busy);
        let is_this = |node: &ChatRenderItem<'_>| matches!(node, ChatRenderItem::ActivityGroup(g) if g.id == id);
        if let Some(ChatRenderItem::ActivityGroup(group)) =
            items.get(render_index).filter(|n| is_this(n))
        {
            return Some(group.clone());
        }
        items.into_iter().find_map(|node| match node {
            ChatRenderItem::ActivityGroup(g) if g.id == id => Some(g),
            _ => None,
        })
    }

    fn build(&self, s: &AppState, i: usize) -> El {
        let Some(spec) = self.rows.get(i) else {
            return col();
        };
        let (k, t) = (&self.kit, &self.tokens);
        match spec {
            RowSpec::Ready { el, .. } => el.clone(),
            RowSpec::Item { key, id, index } => {
                let refs = self.source.resolve(s);
                let item = refs
                    .feed
                    .get(*index)
                    .filter(|item| item_id(item) == id)
                    .or_else(|| refs.feed.iter().find(|item| item_id(item) == id));
                let Some(item) = item else {
                    return col().key(key.as_str());
                };
                let version = (!is_streaming_row(item)).then(|| {
                    let mut h = DefaultHasher::new();
                    self.row_version_base.hash(&mut h);
                    ItemFp(item).hash(&mut h);
                    s.chat_ui
                        .open_citation_sources
                        .contains(id.as_str())
                        .hash(&mut h);
                    s.chat_ui.expanded_errors.contains(id.as_str()).hash(&mut h);
                    h.finish()
                });
                let build = || {
                    let catalog = self
                        .catalog
                        .get_or_init(|| build_mention_catalog(&s.skills, &s.plugins));
                    let ctx = FeedRowContext {
                        workspace_id: self.workspace_id.as_deref(),
                        workspace_path: self.workspace_path.as_deref(),
                        catalog,
                        external_cache: self.external_cache.clone(),
                        is_agent_viewer: self.is_agent_viewer,
                        copied_key: self.copied_key.as_deref(),
                    };
                    build_feed_row(s, k, t, item, &ctx)
                };
                match version {
                    Some(v) => memo(key.as_str(), v, build),
                    None => build(),
                }
            }
            RowSpec::Group {
                key,
                id,
                render_index,
                item_indices,
                is_last_render_item,
            } => {
                let refs = self.source.resolve(s);
                let Some(group) = self.resolve_group(
                    &refs,
                    id,
                    *render_index,
                    item_indices,
                    *is_last_render_item,
                ) else {
                    return col().key(key.as_str());
                };
                let version =
                    (!group.is_live && !group_has_diff_state(&s.chat_ui, &group)).then(|| {
                        let mut h = DefaultHasher::new();
                        self.group_version_base.hash(&mut h);
                        GroupFp(&group).hash(&mut h);
                        h.finish()
                    });
                let build = || {
                    let ctx = ActivityCardContext {
                        thread_id: &self.thread_key,
                        workspace_id: self.workspace_id.as_deref(),
                        workspace_path: self.workspace_path.as_deref(),
                        pending_interactions: refs.pending_interactions,
                        agents: refs.agents,
                        external_cache: self.external_cache.clone(),
                        copied_key: self.copied_key.as_deref(),
                    };
                    build_activity_group_card(s, k, t, &group, &ctx)
                };
                match version {
                    Some(v) => memo(key.as_str(), v, build),
                    None => build(),
                }
            }
        }
    }
}

/// Builds the scrollable transcript area including day separators, progressive windowing,
/// live growth stack animation, and floating jump-to-latest pill.
pub fn build_chat_feed(s: &AppState, k: &Kit, t: &ThemeTokens, props: &ChatFeedProps<'_>) -> El {
    let developer_mode = s.desktop_settings.developer_mode && !props.is_agent_viewer;
    let refs = props.source.resolve(s);
    let prepared = prepare_feed(refs.feed, developer_mode);
    let total_items = prepared.len();
    let visible_count = s.chat_ui.visible_count_for(props.thread_key);
    let (visible_slice, hidden_count) = select_feed_window(&prepared, visible_count);

    if visible_slice.is_empty() && refs.pending_interactions.is_empty() {
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
    let copied_key = s
        .chat_ui
        .copied_feedback
        .as_ref()
        .filter(|(k, _)| s.chat_ui.is_copied(k, s.now_secs))
        .map(|(k, _)| k.as_str());

    let mut rows: Vec<RowSpec> = Vec::with_capacity(render_items.len() + 6);
    if props.transcript_only {
        rows.push(RowSpec::Ready {
            key: "transcript-only-banner".into(),
            el: col()
                .w_full()
                .max_w(768.0)
                .child(transcript_only_banner(k, t)),
        });
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
        rows.push(RowSpec::Ready {
            key: "older-messages".into(),
            el: row()
                .w_full()
                .max_w(768.0)
                .justify_center()
                .py(4.0)
                .child(older_btn),
        });
    }

    // What every completed row's build reads besides its own item and per-item toggles. A
    // memoized row builds again only when this or its item changes; see `row_version`.
    let shared_version = {
        let mut h = DefaultHasher::new();
        let ds = &s.desktop_settings;
        (
            t.dark,
            ds.reduced_transparency,
            ds.high_contrast,
            ds.accent_palette,
        )
            .hash(&mut h);
        (
            ds.reduce_motion,
            s.ui_scale.to_bits(),
            s.services.waker.is_some(),
        )
            .hash(&mut h);
        (props.thread_key, props.workspace_id, props.workspace_path).hash(&mut h);
        props.is_agent_viewer.hash(&mut h);
        props
            .external_cache
            .as_ref()
            .map(|c| Arc::as_ptr(c) as usize)
            .hash(&mut h);
        copied_key.hash(&mut h);
        super::math::raster_generation().hash(&mut h);
        h.finish()
    };
    let row_version_base = {
        let mut h = DefaultHasher::new();
        shared_version.hash(&mut h);
        skills_plugins_signature(&s.skills, &s.plugins).hash(&mut h);
        h.finish()
    };
    let group_version_base = {
        let mut h = DefaultHasher::new();
        shared_version.hash(&mut h);
        activity_ui_signature(&s.chat_ui).hash(&mut h);
        interactions_signature(refs.pending_interactions).hash(&mut h);
        refs.agents.hash(&mut h);
        h.finish()
    };

    let last_render_idx = render_items.len().saturating_sub(1);
    let mut prev_bucket: Option<(i32, u32)> = None;
    for (index, node) in render_items.iter().enumerate() {
        if let Some(ts) = render_item_timestamp(node)
            && let Some(bucket) = day_bucket_key(ts)
        {
            if prev_bucket.is_some() && prev_bucket != Some(bucket) {
                rows.push(RowSpec::Ready {
                    key: format!("day:{}:{}", bucket.0, bucket.1),
                    el: row().w_full().max_w(768.0).child(day_separator_row(
                        k,
                        t,
                        format_day_separator(ts, s.now_secs),
                    )),
                });
            }
            prev_bucket = Some(bucket);
        }

        match node {
            ChatRenderItem::Row(item) => {
                let id = item_id(item);
                rows.push(RowSpec::Item {
                    key: format!("row:{id}"),
                    id: id.to_string(),
                    index: feed_index(refs.feed, item),
                });
            }
            ChatRenderItem::ActivityGroup(group) => {
                let item_indices = group
                    .items
                    .iter()
                    .map(|item| feed_index(refs.feed, item))
                    .collect();
                rows.push(RowSpec::Group {
                    key: format!("group:{}", group.id),
                    id: group.id.clone(),
                    render_index: index,
                    item_indices,
                    is_last_render_item: index == last_render_idx,
                });
            }
        }
    }

    if should_show_working_placeholder(&render_items, props.thread_busy) {
        rows.push(RowSpec::Ready {
            key: "working-placeholder".into(),
            el: working_placeholder_row(k, t),
        });
    }

    let total_interactions = refs.pending_interactions.len();
    for (idx, interaction) in refs.pending_interactions.iter().enumerate() {
        rows.push(RowSpec::Ready {
            key: interaction_card_key(interaction),
            el: build_interaction_card(
                s,
                k,
                t,
                props.workspace_id,
                props.thread_key,
                interaction,
                idx + 1,
                total_interactions,
                props.interaction_errors,
            ),
        });
    }

    let tk_at = props.thread_key.to_string();
    let tk_far = props.thread_key.to_string();
    let frame_key_str = props.frame_key.to_string();

    // Rows are built by index at layout time, so a commit builds only the mounted window (the
    // viewport and its overscan) rather than every row in the loaded page.
    let row_count = rows.len();
    let keys_version = {
        let mut h = DefaultHasher::new();
        row_count.hash(&mut h);
        for spec in &rows {
            spec.key().hash(&mut h);
        }
        h.finish()
    };
    let feed_rows = Rc::new(FeedRows {
        rows,
        source: props.source.clone(),
        developer_mode,
        hidden_count,
        thread_busy: props.thread_busy,
        thread_key: props.thread_key.to_string(),
        workspace_id: props.workspace_id.map(str::to_string),
        workspace_path: props.workspace_path.map(str::to_string),
        catalog: OnceCell::new(),
        row_version_base,
        group_version_base,
        external_cache: props.external_cache.clone(),
        is_agent_viewer: props.is_agent_viewer,
        copied_key: copied_key.map(str::to_string),
        kit: k.clone(),
        tokens: *t,
    });
    let keys = Rc::clone(&feed_rows);

    let rows_stack = col()
        .key("chat-feed-rows")
        .w_full()
        .items_center()
        .px(24.0)
        .pt(20.0)
        .pb(20.0)
        .gap(14.0)
        .growth(GrowthSpec::default())
        .virtual_rows(
            row_count,
            84.0,
            move |_: &AppState, i| {
                Cow::Owned(
                    keys.rows
                        .get(i)
                        .map(RowSpec::key)
                        .unwrap_or_default()
                        .to_string(),
                )
            },
            move |s: &AppState, i| feed_rows.build(s, i),
        )
        .virtual_rows_version(keys_version);

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

/// A row whose content is still arriving: it changes every delta, so memoizing it only adds a hash.
fn is_streaming_row(item: &FeedItem) -> bool {
    matches!(
        item,
        FeedItem::Message {
            streaming: true,
            ..
        } | FeedItem::Reasoning {
            streaming: true,
            ..
        } | FeedItem::Tool {
            streaming: true,
            ..
        }
    )
}

/// Index of `item`, an element borrowed from `feed`, within `feed`. Rows re-check the id there,
/// so an index from a feed that has since changed only costs a search.
fn feed_index(feed: &[FeedItem], item: &FeedItem) -> usize {
    let offset = std::ptr::from_ref(item)
        .addr()
        .wrapping_sub(feed.as_ptr().addr());
    offset / std::mem::size_of::<FeedItem>().max(1)
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
