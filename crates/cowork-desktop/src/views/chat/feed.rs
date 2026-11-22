//! Virtualized, bottom-sticky chat feed shared by `ChatView` and `AgentRunViewer`.

use std::borrow::Cow;
use std::collections::HashMap;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::rc::Rc;
use std::sync::Arc;

use rune::{El, GrowthSpec, ImageCache, ScrollSpec, Tx, col, memo, row};
use rune_kit::{Button, ButtonVariant, ControlSize, Kit, scroll_bar};

use crate::state::{AppState, ChatInteraction, FeedItem, FeedMessageRole, ThreadAgentSummary};
use crate::theme::ThemeTokens;

use super::activity::{ActivityCardContext, build_activity_group_card};
use super::components::{
    day_separator_row, empty_feed_state, scroll_to_latest_pill, transcript_only_banner,
    working_placeholder_row,
};
use super::feed_row::{FeedRowContext, build_feed_row};
use super::interaction::{build_interaction_card, interaction_card_key};
use super::model::{
    ActivityGroup, ActivityNode, ChatRenderItem, MentionCatalog, build_chat_render_items,
    cached_mention_catalog_for_state, day_bucket_key, format_day_separator, is_hidden_retry_turn,
    item_id, local_day_bucket, prepare_feed, select_feed_window, should_show_working_placeholder,
};
use super::row_version::{
    activity_ui_signature, feed_fast_signature, group_agents_signature, group_copied_key,
    group_has_active_diff_state, group_has_images, group_has_math, group_interactions_signature,
    group_ui_signature, has_any_expanded_diff, hash_feed_item_or_rev, hash_group_or_rev,
    item_has_images, item_has_math, resolve_item_rev, row_copied_key, set_signature,
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
    feed_rev: u64,
    item_revs: &'s [u64],
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
                    feed_rev: rt.map_or(0, |r| r.feed_rev),
                    item_revs: rt.map(|r| r.item_revs.as_slice()).unwrap_or(&[]),
                    pending_interactions: rt
                        .map(|r| r.pending_interactions.as_slice())
                        .unwrap_or(&[]),
                    agents: rt.map(|r| r.agents.as_slice()).unwrap_or(&[]),
                }
            }
            FeedSource::AgentRun {
                thread_id,
                agent_id,
            } => {
                if let Some(rt) = s
                    .thread_runtime_by_id
                    .get(agent_id)
                    .filter(|r| !r.feed.is_empty())
                {
                    return FeedRefs {
                        feed: rt.feed.as_slice(),
                        feed_rev: rt.feed_rev,
                        item_revs: rt.item_revs.as_slice(),
                        pending_interactions: &[],
                        agents: &[],
                    };
                }
                FeedRefs {
                    feed: s
                        .thread_runtime_by_id
                        .get(thread_id)
                        .and_then(|r| r.agent_run_feeds.get(agent_id))
                        .map(Vec::as_slice)
                        .unwrap_or(&[]),
                    feed_rev: 0,
                    item_revs: &[],
                    pending_interactions: &[],
                    agents: &[],
                }
            }
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

/// Owned index-based node layout for an `ActivityGroup` so `FeedRows::build` reconstructs
/// `&FeedItem` references in O(group.len()) without re-running `prepare_feed` / `build_chat_render_items`.
enum OwnedActivityNode {
    Reasoning(usize),
    ProgressMessage(usize),
    ToolCluster {
        cluster_id: String,
        title: String,
        item_indices: Vec<usize>,
    },
}

struct OwnedActivityGroupSpec {
    id: String,
    item_indices: Vec<usize>,
    nodes: Vec<OwnedActivityNode>,
    is_live: bool,
    tool_count: usize,
    has_reasoning: bool,
    error_count: usize,
    has_pending_approval: bool,
    started_at_ms: i64,
    ended_at_ms: i64,
    is_retryable: bool,
    current_action: String,
    summary_label: String,
}

impl OwnedActivityGroupSpec {
    fn from_group(feed: &[FeedItem], group: &ActivityGroup<'_>) -> Self {
        let item_indices = group
            .items
            .iter()
            .map(|item| feed_index(feed, item))
            .collect();
        let nodes = group
            .nodes
            .iter()
            .map(|node| match node {
                ActivityNode::Reasoning(item) => {
                    OwnedActivityNode::Reasoning(feed_index(feed, item))
                }
                ActivityNode::ProgressMessage(item) => {
                    OwnedActivityNode::ProgressMessage(feed_index(feed, item))
                }
                ActivityNode::ToolCluster {
                    cluster_id,
                    title,
                    items,
                } => OwnedActivityNode::ToolCluster {
                    cluster_id: cluster_id.clone(),
                    title: title.clone(),
                    item_indices: items.iter().map(|item| feed_index(feed, item)).collect(),
                },
            })
            .collect();
        Self {
            id: group.id.clone(),
            item_indices,
            nodes,
            is_live: group.is_live,
            tool_count: group.tool_count,
            has_reasoning: group.has_reasoning,
            error_count: group.error_count,
            has_pending_approval: group.has_pending_approval,
            started_at_ms: group.started_at_ms,
            ended_at_ms: group.ended_at_ms,
            is_retryable: group.is_retryable,
            current_action: group.current_action.clone(),
            summary_label: group.summary_label.clone(),
        }
    }

    fn resolve<'a>(&self, feed: &'a [FeedItem]) -> Option<ActivityGroup<'a>> {
        let mut items = Vec::with_capacity(self.item_indices.len());
        for &idx in &self.item_indices {
            items.push(feed.get(idx)?);
        }
        let mut nodes = Vec::with_capacity(self.nodes.len());
        for node in &self.nodes {
            match node {
                OwnedActivityNode::Reasoning(idx) => {
                    nodes.push(ActivityNode::Reasoning(feed.get(*idx)?));
                }
                OwnedActivityNode::ProgressMessage(idx) => {
                    nodes.push(ActivityNode::ProgressMessage(feed.get(*idx)?));
                }
                OwnedActivityNode::ToolCluster {
                    cluster_id,
                    title,
                    item_indices,
                } => {
                    let mut cluster_items = Vec::with_capacity(item_indices.len());
                    for &idx in item_indices {
                        cluster_items.push(feed.get(idx)?);
                    }
                    nodes.push(ActivityNode::ToolCluster {
                        cluster_id: cluster_id.clone(),
                        title: title.clone(),
                        items: cluster_items,
                    });
                }
            }
        }
        Some(ActivityGroup {
            id: self.id.clone(),
            items,
            nodes,
            is_live: self.is_live,
            tool_count: self.tool_count,
            has_reasoning: self.has_reasoning,
            error_count: self.error_count,
            has_pending_approval: self.has_pending_approval,
            started_at_ms: self.started_at_ms,
            ended_at_ms: self.ended_at_ms,
            is_retryable: self.is_retryable,
            current_action: self.current_action.clone(),
            summary_label: self.summary_label.clone(),
        })
    }
}

/// One row of the virtual transcript stack.
enum RowSpec {
    /// A cheap row the view builds outright (banner, pager, day separator, placeholder, card).
    Ready { key: String, el: El },
    /// A transcript item at `index` in the source feed; memo version is computed lazily on mount.
    Item {
        key: String,
        id: String,
        index: usize,
    },
    /// An activity group with pre-indexed feed references; memo version is computed lazily on mount.
    Group {
        key: String,
        group: OwnedActivityGroupSpec,
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
    thread_key: String,
    workspace_id: Option<String>,
    workspace_path: Option<String>,
    catalog: Rc<MentionCatalog>,
    catalog_sig: u64,
    shared_version: u64,
    external_cache: Option<Arc<ImageCache>>,
    is_agent_viewer: bool,
    copied_key: Option<String>,
    kit: Kit,
    tokens: ThemeTokens,
}

impl FeedRows {
    fn build(&self, s: &AppState, i: usize) -> El {
        let Some(spec) = self.rows.get(i) else {
            return col();
        };
        let (k, t) = (&self.kit, &self.tokens);
        match spec {
            RowSpec::Ready { el, .. } => el.clone(),
            RowSpec::Item { key, id, index } => {
                let refs = self.source.resolve(s);
                let resolved = refs
                    .feed
                    .get(*index)
                    .filter(|item| item_id(item) == id)
                    .map(|item| (*index, item))
                    .or_else(|| {
                        refs.feed
                            .iter()
                            .enumerate()
                            .find(|(_, item)| item_id(item) == id)
                    });
                let Some((resolved_idx, item)) = resolved else {
                    return col().key(key.as_str());
                };
                let scoped_copied = row_copied_key(self.copied_key.as_deref(), item);
                let ctx = FeedRowContext {
                    workspace_id: self.workspace_id.as_deref(),
                    workspace_path: self.workspace_path.as_deref(),
                    catalog: &self.catalog,
                    external_cache: self.external_cache.clone(),
                    is_agent_viewer: self.is_agent_viewer,
                    copied_key: scoped_copied,
                };
                if is_streaming_row(item) {
                    return build_feed_row(s, k, t, item, &ctx);
                }
                let mut h = DefaultHasher::new();
                self.shared_version.hash(&mut h);
                let item_rev = resolve_item_rev(refs.feed, refs.item_revs, resolved_idx);
                hash_feed_item_or_rev(item, item_rev, &mut h);
                scoped_copied.hash(&mut h);
                match item {
                    FeedItem::Message {
                        role: FeedMessageRole::User,
                        ..
                    } => {
                        self.catalog_sig.hash(&mut h);
                    }
                    FeedItem::Message {
                        role: FeedMessageRole::Assistant,
                        ..
                    } => {
                        s.chat_ui.open_citation_sources.contains(id).hash(&mut h);
                    }
                    FeedItem::Error { .. } => {
                        s.chat_ui.expanded_errors.contains(id).hash(&mut h);
                    }
                    _ => {}
                }
                if item_has_math(item) {
                    super::math::raster_generation().hash(&mut h);
                }
                if item_has_images(item) {
                    super::attachments::image_decode_generation().hash(&mut h);
                }
                memo(key.as_str(), h.finish(), || {
                    build_feed_row(s, k, t, item, &ctx)
                })
            }
            RowSpec::Group {
                key,
                group: owned_group,
            } => {
                let refs = self.source.resolve(s);
                let Some(group) = owned_group.resolve(refs.feed) else {
                    return col().key(key.as_str());
                };
                let scoped_copied = group_copied_key(self.copied_key.as_deref(), &group);
                let ctx = ActivityCardContext {
                    thread_id: &self.thread_key,
                    workspace_id: self.workspace_id.as_deref(),
                    workspace_path: self.workspace_path.as_deref(),
                    feed: refs.feed,
                    item_revs: refs.item_revs,
                    pending_interactions: refs.pending_interactions,
                    agents: refs.agents,
                    external_cache: self.external_cache.clone(),
                    copied_key: scoped_copied,
                    shared_version: self.shared_version,
                };
                if group.is_live
                    || group_has_active_diff_state(&s.chat_ui, &group, refs.pending_interactions)
                {
                    return build_activity_group_card(s, k, t, &group, &ctx);
                }
                let mut h = DefaultHasher::new();
                self.shared_version.hash(&mut h);
                hash_group_or_rev(
                    &group,
                    refs.feed,
                    refs.item_revs,
                    &owned_group.item_indices,
                    &mut h,
                );
                scoped_copied.hash(&mut h);
                group_ui_signature(&s.chat_ui, &group).hash(&mut h);
                group_interactions_signature(refs.pending_interactions, &group).hash(&mut h);
                group_agents_signature(refs.agents, &group).hash(&mut h);
                if group_has_math(&group) {
                    super::math::raster_generation().hash(&mut h);
                }
                if group_has_images(&group) {
                    super::attachments::image_decode_generation().hash(&mut h);
                }
                memo(key.as_str(), h.finish(), || {
                    build_activity_group_card(s, k, t, &group, &ctx)
                })
            }
        }
    }
}

fn count_prepared_feed(feed: &[FeedItem], developer_mode: bool) -> usize {
    feed.iter()
        .filter(|item| match item {
            FeedItem::Todos { .. } => false,
            FeedItem::Log { .. } | FeedItem::System { .. } => developer_mode,
            FeedItem::Message { .. } => !is_hidden_retry_turn(item),
            FeedItem::Reasoning { .. } | FeedItem::Tool { .. } | FeedItem::Error { .. } => true,
        })
        .count()
}

fn compute_shared_row_version(s: &AppState, t: &ThemeTokens, props: &ChatFeedProps<'_>) -> u64 {
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
    h.finish()
}

/// Computes a lightweight surface-level memo version for `build_chat_feed_memoized`.
/// Returns `None` when interactive cards (pending approvals/asks or expanded diffs) require
/// direct rebuilds so their embedded inputs stay live while unchanged transcript rows still hit
/// their per-row memos.
pub(super) fn compute_feed_surface_version(
    s: &AppState,
    t: &ThemeTokens,
    props: &ChatFeedProps<'_>,
) -> Option<u64> {
    let refs = props.source.resolve(s);
    if !refs.pending_interactions.is_empty() || has_any_expanded_diff(&s.chat_ui, refs.feed) {
        return None;
    }
    let developer_mode = s.desktop_settings.developer_mode && !props.is_agent_viewer;
    let total_items = count_prepared_feed(refs.feed, developer_mode);
    let visible_count = s.chat_ui.visible_count_for(props.thread_key);
    let show_jump = s.chat_ui.show_jump_to_latest(props.thread_key, total_items);
    let unseen = if show_jump {
        s.chat_ui.unseen_update_count(props.thread_key, total_items)
    } else {
        0
    };
    let copied_key = s
        .chat_ui
        .copied_feedback
        .as_ref()
        .filter(|(k, _)| s.chat_ui.is_copied(k, s.now_secs))
        .map(|(k, _)| k.as_str());
    let (_, catalog_sig) = cached_mention_catalog_for_state(s);
    let last_event_seq = match &props.source {
        FeedSource::Thread(id) => s
            .thread_runtime_by_id
            .get(id)
            .map_or(0, |r| r.last_event_seq),
        FeedSource::AgentRun { agent_id, .. } => s
            .thread_runtime_by_id
            .get(agent_id)
            .map_or(0, |r| r.last_event_seq),
    };

    let mut h = DefaultHasher::new();
    compute_shared_row_version(s, t, props).hash(&mut h);
    (
        developer_mode,
        props.thread_busy,
        props.hydrating,
        props.transcript_only,
        props.disconnected,
        props.reconnecting,
        props.scroll_area_key,
        props.viewport_key,
        props.frame_key,
    )
        .hash(&mut h);
    (
        visible_count,
        show_jump,
        unseen,
        copied_key,
        catalog_sig,
        last_event_seq,
    )
        .hash(&mut h);
    feed_fast_signature(refs.feed, refs.feed_rev, refs.item_revs).hash(&mut h);
    refs.agents.hash(&mut h);
    activity_ui_signature(&s.chat_ui).hash(&mut h);
    (
        s.chat_ui.open_citation_sources.len(),
        set_signature(s.chat_ui.open_citation_sources.iter()),
    )
        .hash(&mut h);
    (
        s.chat_ui.expanded_errors.len(),
        set_signature(s.chat_ui.expanded_errors.iter()),
    )
        .hash(&mut h);
    if props.thread_busy {
        (1u8, s.now_secs as i64).hash(&mut h);
    } else {
        (0u8, local_day_bucket(s.now_secs)).hash(&mut h);
    }
    super::math::raster_generation().hash(&mut h);
    super::attachments::image_decode_generation().hash(&mut h);
    Some(h.finish())
}

/// Memoized entry point around `build_chat_feed` wrapped in `surface_key` so typing in the
/// composer, opening pickers, hovering chrome, or editing Canvas skips `prepare_feed` /
/// `build_chat_render_items` entirely while preserving the exact `"chat-feed-surface"` key.
pub fn build_chat_feed_surface(
    s: &AppState,
    k: &Kit,
    t: &ThemeTokens,
    props: &ChatFeedProps<'_>,
    surface_key: &str,
) -> El {
    let build = || {
        col()
            .w_full()
            .grow(1.0)
            .min_h(0.0)
            .child(build_chat_feed(s, k, t, props))
    };
    match compute_feed_surface_version(s, t, props) {
        Some(ver) => memo(surface_key, ver, build),
        None => build().key(surface_key),
    }
}

fn estimate_virtual_row_height(
    render_items: &[ChatRenderItem<'_>],
    ui: &super::state::ChatUiState,
) -> f32 {
    if render_items.is_empty() {
        return 84.0;
    }
    let mut sum = 0.0_f32;
    for node in render_items {
        let est = match node {
            ChatRenderItem::Row(item) => match item {
                FeedItem::Message {
                    role: FeedMessageRole::User,
                    content,
                    attachments,
                    ..
                } => {
                    let lines = (content.len() as f32 / 64.0).max(1.0);
                    let att = if attachments.is_empty() { 0.0 } else { 52.0 };
                    (52.0 + lines * 22.0 + att).clamp(64.0, 320.0)
                }
                FeedItem::Message {
                    role: FeedMessageRole::Assistant,
                    content,
                    ..
                } => {
                    let newlines =
                        content.as_bytes().iter().filter(|&&b| b == b'\n').count() as f32;
                    let wrapped = (content.len() as f32 / 78.0).max(1.0);
                    (46.0 + wrapped.max(newlines) * 22.4).clamp(64.0, 440.0)
                }
                FeedItem::Error { .. } => 104.0,
                _ => 56.0,
            },
            ChatRenderItem::ActivityGroup(group) => {
                let default_open =
                    group.is_live || group.has_pending_approval || group.error_count > 0;
                if ui.is_activity_expanded(&group.id, default_open) {
                    (64.0 + (group.nodes.len() as f32) * 38.0).clamp(96.0, 360.0)
                } else {
                    36.0
                }
            }
        };
        sum += est;
    }
    (sum / render_items.len() as f32).clamp(84.0, 220.0)
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
    let (catalog, catalog_sig) = cached_mention_catalog_for_state(s);
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

    let shared_version = compute_shared_row_version(s, t, props);
    let est_row_height = estimate_virtual_row_height(&render_items, &s.chat_ui);

    let mut prev_bucket: Option<(i32, u32)> = None;
    for node in &render_items {
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
                rows.push(RowSpec::Group {
                    key: format!("group:{}", group.id),
                    group: OwnedActivityGroupSpec::from_group(refs.feed, group),
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

    // Rows are built by index at layout time, so a commit builds and hashes only the mounted
    // window (the viewport and its overscan) rather than every row in the loaded page.
    let row_count = rows.len();
    let feed_rows = Rc::new(FeedRows {
        rows,
        source: props.source.clone(),
        thread_key: props.thread_key.to_string(),
        workspace_id: props.workspace_id.map(str::to_string),
        workspace_path: props.workspace_path.map(str::to_string),
        catalog,
        catalog_sig,
        shared_version,
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
            est_row_height,
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
        );

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
