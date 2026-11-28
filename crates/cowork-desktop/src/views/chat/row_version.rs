//! Memo versions for transcript rows: everything a completed feed row or activity card reads
//! while it builds, hashed so `rune::memo` can reuse the row's subtree across commits.
//!
//! Without them every keystroke, streamed delta or click rebuilt every mounted row (markdown
//! parsing, activity timelines) of the open thread. A row's version must change whenever
//! anything its build reads changes, so each wrapper here hashes the whole item, not a summary.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use cowork_protocol::TurnAttachmentInputPart;
use serde_json::Value;

use crate::state::{ChatInteraction, FeedItem, ThreadAgentSummary, ToolRunStatus};

use super::model::{ActivityGroup, ActivityNode, ascii_contains_ignore_case, item_id};
use super::state::ChatUiState;

/// Hashes every field of a feed item a row's build can read. Inline attachment payloads hash
/// by length (an item's base64 never changes in place, and hashing megabytes per commit would
/// cost more than the build it skips).
pub struct ItemFp<'a>(pub &'a FeedItem);

impl Hash for ItemFp<'_> {
    fn hash<H: Hasher>(&self, h: &mut H) {
        std::mem::discriminant(self.0).hash(h);
        match self.0 {
            FeedItem::Message {
                id,
                role,
                content,
                client_message_id,
                attachments,
                references,
                citations,
                streaming,
                timestamp_ms,
            } => {
                (
                    id,
                    role,
                    content,
                    client_message_id,
                    streaming,
                    timestamp_ms,
                )
                    .hash(h);
                attachments.len().hash(h);
                for part in attachments {
                    match part {
                        TurnAttachmentInputPart::InlineFile {
                            filename,
                            content_base64,
                            mime_type,
                        } => (0u8, filename, mime_type, content_base64.len()).hash(h),
                        TurnAttachmentInputPart::UploadedFile {
                            filename,
                            path,
                            mime_type,
                        } => (1u8, filename, path, mime_type).hash(h),
                    }
                }
                references.len().hash(h);
                for r in references {
                    (&r.kind, &r.name).hash(h);
                }
                citations.hash(h);
            }
            FeedItem::Reasoning {
                id,
                content,
                mode,
                streaming,
                timestamp_ms,
            } => (id, content, mode, streaming, timestamp_ms).hash(h),
            FeedItem::Tool {
                id,
                tool_name,
                title,
                call_id,
                status,
                input,
                output,
                error,
                diff,
                streaming,
                timestamp_ms,
                completed_at_ms,
                output_truncated,
            } => {
                (id, tool_name, title, call_id, status, error, diff).hash(h);
                (streaming, timestamp_ms, completed_at_ms, output_truncated).hash(h);
                ValueFp(input).hash(h);
                output.as_ref().map(ValueFp).hash(h);
            }
            FeedItem::Todos {
                id,
                items,
                timestamp_ms,
            } => (id, items, timestamp_ms).hash(h),
            FeedItem::Log {
                id,
                level,
                message,
                timestamp_ms,
            } => (id, level, message, timestamp_ms).hash(h),
            FeedItem::Error {
                id,
                message,
                code,
                timestamp_ms,
            } => (id, message, code, timestamp_ms).hash(h),
            FeedItem::System {
                id,
                message,
                timestamp_ms,
            } => (id, message, timestamp_ms).hash(h),
        }
    }
}

/// Structural hash of a JSON value (`serde_json::Value` isn't `Hash`).
pub struct ValueFp<'a>(pub &'a Value);

impl Hash for ValueFp<'_> {
    fn hash<H: Hasher>(&self, h: &mut H) {
        std::mem::discriminant(self.0).hash(h);
        match self.0 {
            Value::Null => {}
            Value::Bool(b) => b.hash(h),
            Value::Number(n) => n.hash(h),
            Value::String(s) => s.hash(h),
            Value::Array(items) => {
                items.len().hash(h);
                for v in items {
                    ValueFp(v).hash(h);
                }
            }
            Value::Object(map) => {
                map.len().hash(h);
                for (k, v) in map {
                    k.hash(h);
                    ValueFp(v).hash(h);
                }
            }
        }
    }
}

/// Hashes an activity group: its items and everything grouping derived from them.
pub struct GroupFp<'a, 'b>(pub &'a ActivityGroup<'b>);

impl Hash for GroupFp<'_, '_> {
    fn hash<H: Hasher>(&self, h: &mut H) {
        let g = self.0;
        (
            &g.id,
            g.is_live,
            g.tool_count,
            g.has_reasoning,
            g.error_count,
        )
            .hash(h);
        (
            g.has_pending_approval,
            g.started_at_ms,
            g.ended_at_ms,
            g.is_retryable,
        )
            .hash(h);
        (&g.current_action, &g.summary_label).hash(h);
        g.items.len().hash(h);
        for item in &g.items {
            ItemFp(item).hash(h);
        }
        g.nodes.len().hash(h);
        for node in &g.nodes {
            match node {
                ActivityNode::Reasoning(item) => (0u8, item_id(item)).hash(h),
                ActivityNode::ProgressMessage(item) => (1u8, item_id(item)).hash(h),
                ActivityNode::ToolCluster {
                    cluster_id,
                    title,
                    items,
                } => {
                    (2u8, cluster_id, title, items.len()).hash(h);
                    for item in items {
                        item_id(item).hash(h);
                    }
                }
            }
        }
    }
}

fn key_matches_prefixed_id(key: &str, prefix: &str, id: &str) -> bool {
    let Some(rest) = key.strip_prefix(prefix) else {
        return false;
    };
    let Some(after) = rest.strip_prefix(id) else {
        return false;
    };
    after.is_empty() || after.starts_with(':')
}

/// Filters the global `copied_key` down to the single feed row it belongs to so clicking
/// Copy only invalidates that row's memo rather than the whole transcript.
pub fn row_copied_key<'a>(copied_key: Option<&'a str>, item: &FeedItem) -> Option<&'a str> {
    let key = copied_key?;
    match item {
        FeedItem::Message { id, .. } => key_matches_prefixed_id(key, "msg:", id).then_some(key),
        FeedItem::Error { id, .. } => key_matches_prefixed_id(key, "err:", id).then_some(key),
        _ => None,
    }
}

fn item_matches_copied_key(key: &str, item: &FeedItem) -> bool {
    match item {
        FeedItem::Reasoning { id, .. } => key_matches_prefixed_id(key, "reason:", id),
        FeedItem::Message { id, .. } => {
            key_matches_prefixed_id(key, "prog:", id) || key_matches_prefixed_id(key, "msg:", id)
        }
        FeedItem::Tool { id, .. } => key_matches_prefixed_id(key, "tool:", id),
        _ => false,
    }
}

/// Filters `copied_key` down to an activity group so Copy feedback only invalidates its owner group.
pub fn group_copied_key<'a>(
    copied_key: Option<&'a str>,
    group: &ActivityGroup<'_>,
) -> Option<&'a str> {
    let key = copied_key?;
    group
        .items
        .iter()
        .any(|item| item_matches_copied_key(key, item))
        .then_some(key)
}

/// Filters `copied_key` down to a single child node inside an activity group.
pub fn node_copied_key<'a>(
    copied_key: Option<&'a str>,
    node: &ActivityNode<'_>,
) -> Option<&'a str> {
    let key = copied_key?;
    let matches = match node {
        ActivityNode::Reasoning(item) | ActivityNode::ProgressMessage(item) => {
            item_matches_copied_key(key, item)
        }
        ActivityNode::ToolCluster { items, .. } => {
            items.iter().any(|item| item_matches_copied_key(key, item))
        }
    };
    matches.then_some(key)
}

/// Order-independent hash of a set's members.
pub fn set_signature<T: Hash>(items: impl Iterator<Item = T>) -> u64 {
    items
        .map(|item| {
            let mut h = DefaultHasher::new();
            item.hash(&mut h);
            h.finish()
        })
        .fold(0u64, u64::wrapping_add)
}

/// Global disclosure signature used only at the coarse feed-surface memo boundary.
pub fn activity_ui_signature(ui: &ChatUiState) -> u64 {
    let mut h = DefaultHasher::new();
    (
        ui.expanded_activity_groups.len(),
        set_signature(ui.expanded_activity_groups.iter()),
    )
        .hash(&mut h);
    (
        ui.expanded_reasoning_sections.len(),
        set_signature(ui.expanded_reasoning_sections.iter()),
    )
        .hash(&mut h);
    (
        ui.expanded_tool_clusters.len(),
        set_signature(ui.expanded_tool_clusters.iter()),
    )
        .hash(&mut h);
    (
        ui.expanded_tool_details.len(),
        set_signature(ui.expanded_tool_details.iter()),
    )
        .hash(&mut h);
    (
        ui.expanded_raw_io.len(),
        set_signature(ui.expanded_raw_io.iter()),
    )
        .hash(&mut h);
    (
        ui.tool_diff_rev.len(),
        set_signature(ui.tool_diff_rev.iter()),
    )
        .hash(&mut h);
    h.finish()
}

fn hash_reasoning_ui<H: Hasher>(ui: &ChatUiState, id: &str, h: &mut H) {
    if ui.expanded_reasoning_sections.is_empty() {
        0u8.hash(h);
        return;
    }
    let prefix = format!("reason:{id}:");
    let sig = set_signature(
        ui.expanded_reasoning_sections
            .iter()
            .filter(|k| k.starts_with(&prefix)),
    );
    sig.hash(h);
}

fn hash_tool_ui<H: Hasher>(ui: &ChatUiState, id: &str, h: &mut H) {
    if !ui.expanded_tool_details.is_empty() {
        ui.expanded_tool_details.get(id).copied().hash(h);
    } else {
        None::<bool>.hash(h);
    }
    if !ui.expanded_raw_io.is_empty() {
        ui.expanded_raw_io.contains(id).hash(h);
    } else {
        false.hash(h);
    }
    if !ui.tool_diff_rev.is_empty() {
        ui.tool_diff_rev.get(id).copied().hash(h);
    } else {
        None::<u64>.hash(h);
    }
}

/// Scoped disclosure signature for a single `ActivityGroup`: toggling one group or tool
/// invalidates only the owning group instead of every group in the transcript.
pub fn group_ui_signature(ui: &ChatUiState, group: &ActivityGroup<'_>) -> u64 {
    let mut h = DefaultHasher::new();
    ui.expanded_activity_groups
        .get(&group.id)
        .copied()
        .hash(&mut h);
    let has_clusters = !ui.expanded_tool_clusters.is_empty();
    for node in &group.nodes {
        match node {
            ActivityNode::Reasoning(FeedItem::Reasoning { id, .. }) => {
                hash_reasoning_ui(ui, id, &mut h);
            }
            ActivityNode::ToolCluster {
                cluster_id, items, ..
            } => {
                if has_clusters {
                    let key = format!("{}:{cluster_id}", group.id);
                    ui.expanded_tool_clusters.contains(&key).hash(&mut h);
                } else {
                    false.hash(&mut h);
                }
                for item in items {
                    if let FeedItem::Tool { id, .. } = item {
                        hash_tool_ui(ui, id, &mut h);
                    }
                }
            }
            _ => {}
        }
    }
    h.finish()
}

/// Scoped disclosure signature for a single child `ActivityNode` inside a live group.
pub fn node_ui_signature(ui: &ChatUiState, group_id: &str, node: &ActivityNode<'_>) -> u64 {
    let mut h = DefaultHasher::new();
    match node {
        ActivityNode::Reasoning(FeedItem::Reasoning { id, .. }) => {
            hash_reasoning_ui(ui, id, &mut h);
        }
        ActivityNode::ToolCluster {
            cluster_id, items, ..
        } => {
            if !ui.expanded_tool_clusters.is_empty() {
                let key = format!("{group_id}:{cluster_id}");
                ui.expanded_tool_clusters.contains(&key).hash(&mut h);
            } else {
                false.hash(&mut h);
            }
            for item in items {
                if let FeedItem::Tool { id, .. } = item {
                    hash_tool_ui(ui, id, &mut h);
                }
            }
        }
        _ => {}
    }
    h.finish()
}

fn tool_has_active_diff_state(
    ui: &ChatUiState,
    item: &FeedItem,
    pending: &[ChatInteraction],
) -> bool {
    let FeedItem::Tool { id, status, .. } = item else {
        return false;
    };
    if !ui.tool_diff_states.contains_key(id) {
        return false;
    }
    let awaiting = pending.iter().any(|p| match p {
        ChatInteraction::CommandApproval { item_id, .. }
        | ChatInteraction::FileChangeApproval { item_id, .. } => item_id == id,
        ChatInteraction::UserInput { .. } => false,
    });
    let default_open = awaiting || matches!(status, ToolRunStatus::Failed);
    ui.is_tool_expanded(id, default_open)
}

/// Returns true only while `group` is currently expanded AND contains an expanded tool with
/// live interactive `DiffState` (collapsing the tool or group immediately restores memoization).
pub fn group_has_active_diff_state(
    ui: &ChatUiState,
    group: &ActivityGroup<'_>,
    pending: &[ChatInteraction],
) -> bool {
    if ui.tool_diff_states.is_empty() {
        return false;
    }
    let default_open = group.is_live || group.has_pending_approval || group.error_count > 0;
    if !ui.is_activity_expanded(&group.id, default_open) {
        return false;
    }
    group
        .items
        .iter()
        .any(|item| tool_has_active_diff_state(ui, item, pending))
}

/// Returns true if `node` currently renders an expanded interactive `DiffView`.
pub fn node_has_active_diff_state(
    ui: &ChatUiState,
    node: &ActivityNode<'_>,
    pending: &[ChatInteraction],
) -> bool {
    if ui.tool_diff_states.is_empty() {
        return false;
    }
    match node {
        ActivityNode::ToolCluster { items, .. } => items
            .iter()
            .any(|item| tool_has_active_diff_state(ui, item, pending)),
        _ => false,
    }
}

/// Returns true if any tool in `feed` currently has an expanded interactive `DiffView`.
pub fn has_any_expanded_diff(ui: &ChatUiState, feed: &[FeedItem]) -> bool {
    if ui.tool_diff_states.is_empty() {
        return false;
    }
    feed.iter().any(|item| {
        matches!(
            item,
            FeedItem::Tool { id, .. }
                if ui.tool_diff_states.contains_key(id)
                    && ui.expanded_tool_details.get(id) != Some(&false)
        )
    })
}

/// Scoped pending-interaction signature matching only tools belonging to `group`.
pub fn group_interactions_signature(pending: &[ChatInteraction], group: &ActivityGroup<'_>) -> u64 {
    if pending.is_empty() {
        return 0;
    }
    let mut h = DefaultHasher::new();
    for p in pending {
        let p_item_id = match p {
            ChatInteraction::CommandApproval { item_id, .. }
            | ChatInteraction::FileChangeApproval { item_id, .. }
            | ChatInteraction::UserInput { item_id, .. } => item_id.as_str(),
        };
        if group
            .items
            .iter()
            .any(|it| matches!(it, FeedItem::Tool { id, .. } if id == p_item_id))
        {
            std::mem::discriminant(p).hash(&mut h);
            p_item_id.hash(&mut h);
        }
    }
    h.finish()
}

/// Scoped pending-interaction signature for a single `ActivityNode`.
pub fn node_interactions_signature(pending: &[ChatInteraction], node: &ActivityNode<'_>) -> u64 {
    if pending.is_empty() {
        return 0;
    }
    let ActivityNode::ToolCluster { items, .. } = node else {
        return 0;
    };
    let mut h = DefaultHasher::new();
    for p in pending {
        let p_item_id = match p {
            ChatInteraction::CommandApproval { item_id, .. }
            | ChatInteraction::FileChangeApproval { item_id, .. }
            | ChatInteraction::UserInput { item_id, .. } => item_id.as_str(),
        };
        if items
            .iter()
            .any(|it| matches!(it, FeedItem::Tool { id, .. } if id == p_item_id))
        {
            std::mem::discriminant(p).hash(&mut h);
            p_item_id.hash(&mut h);
        }
    }
    h.finish()
}

fn tool_is_agent_tool(item: &FeedItem) -> bool {
    matches!(item, FeedItem::Tool { tool_name, .. } if ascii_contains_ignore_case(tool_name, "agent"))
}

/// Scoped subagent summary signature: only hashes `agents` if `group` is live or contains an agent tool.
pub fn group_agents_signature(agents: &[ThreadAgentSummary], group: &ActivityGroup<'_>) -> u64 {
    if agents.is_empty() || (!group.is_live && !group.items.iter().copied().any(tool_is_agent_tool))
    {
        return 0;
    }
    let mut h = DefaultHasher::new();
    agents.hash(&mut h);
    h.finish()
}

/// Scoped subagent summary signature for a single `ActivityNode`.
pub fn node_agents_signature(agents: &[ThreadAgentSummary], node: &ActivityNode<'_>) -> u64 {
    if agents.is_empty() {
        return 0;
    }
    let ActivityNode::ToolCluster { items, .. } = node else {
        return 0;
    };
    if !items.iter().copied().any(tool_is_agent_tool) {
        return 0;
    }
    let mut h = DefaultHasher::new();
    agents.hash(&mut h);
    h.finish()
}

/// Returns whether a feed item may render KaTeX formulas.
pub fn item_has_math(item: &FeedItem) -> bool {
    match item {
        FeedItem::Message { content, .. } | FeedItem::Reasoning { content, .. } => {
            content.contains("$$")
        }
        _ => false,
    }
}

/// Returns whether a feed item may render inline or attached images.
pub fn item_has_images(item: &FeedItem) -> bool {
    match item {
        FeedItem::Message {
            content,
            attachments,
            ..
        } => !attachments.is_empty() || content.contains("!["),
        FeedItem::Reasoning { content, .. } => content.contains("!["),
        _ => false,
    }
}

pub fn group_has_math(group: &ActivityGroup<'_>) -> bool {
    group.items.iter().copied().any(item_has_math)
}

pub fn group_has_images(group: &ActivityGroup<'_>) -> bool {
    group.items.iter().copied().any(item_has_images)
}

pub fn node_has_math(node: &ActivityNode<'_>) -> bool {
    match node {
        ActivityNode::Reasoning(item) | ActivityNode::ProgressMessage(item) => item_has_math(item),
        ActivityNode::ToolCluster { .. } => false,
    }
}

pub fn node_has_images(node: &ActivityNode<'_>) -> bool {
    match node {
        ActivityNode::Reasoning(item) | ActivityNode::ProgressMessage(item) => {
            item_has_images(item)
        }
        ActivityNode::ToolCluster { .. } => false,
    }
}

fn sample_str_bytes(s: &str) -> (&[u8], &[u8]) {
    let b = s.as_bytes();
    (&b[..b.len().min(32)], &b[b.len().saturating_sub(32)..])
}

fn hash_value_shallow<H: Hasher>(v: &Value, h: &mut H) {
    std::mem::discriminant(v).hash(h);
    match v {
        Value::Null => {}
        Value::Bool(b) => b.hash(h),
        Value::Number(n) => n.hash(h),
        Value::String(s) => (s.len(), s.as_ptr() as usize).hash(h),
        Value::Array(a) => (a.len(), a.as_ptr() as usize).hash(h),
        Value::Object(m) => m.len().hash(h),
    }
}

/// O(1) sanity guard for a feed item (discriminant, id, lengths/ptrs, status/streaming) paired
/// with `item_rev` so direct unit-test field mutations cannot alias an unchanged revision.
fn quick_item_guard<H: Hasher>(item: &FeedItem, h: &mut H) {
    std::mem::discriminant(item).hash(h);
    match item {
        FeedItem::Message {
            id,
            role,
            content,
            attachments,
            references,
            citations,
            streaming,
            timestamp_ms,
            ..
        } => {
            (
                id.as_str(),
                role,
                content.len(),
                content.as_ptr() as usize,
                sample_str_bytes(content),
                attachments.len(),
                attachments.as_ptr() as usize,
                references.len(),
                citations.len(),
                citations.as_ptr() as usize,
                streaming,
                timestamp_ms,
            )
                .hash(h);
        }
        FeedItem::Reasoning {
            id,
            content,
            mode,
            streaming,
            timestamp_ms,
        } => {
            (
                id.as_str(),
                content.len(),
                content.as_ptr() as usize,
                sample_str_bytes(content),
                mode.as_str(),
                streaming,
                timestamp_ms,
            )
                .hash(h);
        }
        FeedItem::Tool {
            id,
            tool_name,
            title,
            status,
            input,
            output,
            error,
            diff,
            streaming,
            timestamp_ms,
            completed_at_ms,
            output_truncated,
            ..
        } => {
            (
                id.as_str(),
                tool_name.as_str(),
                title.as_deref(),
                status,
                error.as_deref(),
                diff.as_ref().map(|d| (d.len(), d.as_ptr() as usize)),
                streaming,
                timestamp_ms,
                completed_at_ms,
                output_truncated,
            )
                .hash(h);
            hash_value_shallow(input, h);
            output.is_some().hash(h);
            if let Some(out) = output {
                hash_value_shallow(out, h);
            }
        }
        FeedItem::Todos {
            id,
            items,
            timestamp_ms,
        } => (id.as_str(), items.len(), timestamp_ms).hash(h),
        FeedItem::Log {
            id,
            level,
            message,
            timestamp_ms,
        } => (
            id.as_str(),
            level.as_str(),
            message.len(),
            message.as_ptr() as usize,
            timestamp_ms,
        )
            .hash(h),
        FeedItem::Error {
            id,
            message,
            code,
            timestamp_ms,
        } => (
            id.as_str(),
            code.as_deref(),
            message.len(),
            message.as_ptr() as usize,
            timestamp_ms,
        )
            .hash(h),
        FeedItem::System {
            id,
            message,
            timestamp_ms,
        } => (
            id.as_str(),
            message.len(),
            message.as_ptr() as usize,
            timestamp_ms,
        )
            .hash(h),
    }
}

/// Resolves the per-item revision for `feed[idx]`, returning `0` when `item_revs` is unpopulated
/// or out of sync with `feed` (triggering full structural hashing fallback).
pub fn resolve_item_rev(feed: &[FeedItem], item_revs: &[u64], idx: usize) -> u64 {
    if item_revs.len() == feed.len() {
        item_revs.get(idx).copied().unwrap_or(0)
    } else {
        0
    }
}

/// Resolves the per-item revision for an `&FeedItem` borrowed from `feed`, returning `0` if
/// `item_revs` is unavailable or `item` does not point inside `feed`.
pub fn resolve_item_rev_by_ptr(feed: &[FeedItem], item_revs: &[u64], item: &FeedItem) -> u64 {
    if item_revs.len() != feed.len() || feed.is_empty() {
        return 0;
    }
    let base = feed.as_ptr().addr();
    let ptr = std::ptr::from_ref(item).addr();
    let stride = std::mem::size_of::<FeedItem>().max(1);
    if ptr >= base && (ptr - base).is_multiple_of(stride) {
        let idx = (ptr - base) / stride;
        if idx < item_revs.len() {
            return item_revs[idx];
        }
    }
    0
}

/// Hashes a single `FeedItem` in O(1) using `(item_rev, quick_item_guard)` when `item_rev != 0`,
/// falling back to full content + JSON `ItemFp` hashing when `item_rev == 0`.
pub fn hash_feed_item_or_rev<H: Hasher>(item: &FeedItem, item_rev: u64, h: &mut H) {
    if item_rev != 0 {
        (1u8, item_rev).hash(h);
        quick_item_guard(item, h);
    } else {
        0u8.hash(h);
        ItemFp(item).hash(h);
    }
}

/// Hashes an `ActivityGroup` using per-item revisions when available, avoiding nested JSON and
/// full-prose walks across completed tool cards while falling back to `GroupFp` when unpopulated.
pub fn hash_group_or_rev<H: Hasher>(
    group: &ActivityGroup<'_>,
    feed: &[FeedItem],
    item_revs: &[u64],
    item_indices: &[usize],
    h: &mut H,
) {
    if item_revs.len() != feed.len() || item_indices.len() != group.items.len() {
        0u8.hash(h);
        GroupFp(group).hash(h);
        return;
    }
    1u8.hash(h);
    (
        &group.id,
        group.is_live,
        group.tool_count,
        group.has_reasoning,
        group.error_count,
    )
        .hash(h);
    (
        group.has_pending_approval,
        group.started_at_ms,
        group.ended_at_ms,
        group.is_retryable,
    )
        .hash(h);
    (&group.current_action, &group.summary_label).hash(h);
    group.items.len().hash(h);
    for (item, &idx) in group.items.iter().zip(item_indices.iter()) {
        let rev = item_revs.get(idx).copied().unwrap_or(0);
        hash_feed_item_or_rev(item, rev, h);
    }
    group.nodes.len().hash(h);
    for node in &group.nodes {
        match node {
            ActivityNode::Reasoning(item) => (0u8, item_id(item)).hash(h),
            ActivityNode::ProgressMessage(item) => (1u8, item_id(item)).hash(h),
            ActivityNode::ToolCluster {
                cluster_id,
                title,
                items,
            } => {
                (2u8, cluster_id, title, items.len()).hash(h);
                for item in items {
                    item_id(item).hash(h);
                }
            }
        }
    }
}

/// Fast fingerprint of `feed` used by the outer `chat-feed-surface` memo.
/// Runs in O(1) when `feed_rev != 0` and `item_revs` matches `feed.len()` (checking `feed_rev`,
/// length/ptr, first item, and last 4 tail items via `quick_item_guard`), falling back to full
/// structural `ItemFp` hashing when `feed_rev == 0` (such as `AgentRun` feeds or direct tests).
pub fn feed_fast_signature(feed: &[FeedItem], feed_rev: u64, item_revs: &[u64]) -> u64 {
    let mut h = DefaultHasher::new();
    (feed.len(), feed.as_ptr() as usize).hash(&mut h);
    if feed_rev != 0 && item_revs.len() == feed.len() {
        (1u8, feed_rev).hash(&mut h);
        if let Some(first) = feed.first() {
            (item_revs[0], item_id(first)).hash(&mut h);
            quick_item_guard(first, &mut h);
        }
        let tail_start = feed.len().saturating_sub(4);
        for (idx, item) in feed.iter().enumerate().skip(tail_start) {
            item_revs[idx].hash(&mut h);
            quick_item_guard(item, &mut h);
        }
        return h.finish();
    }
    0u8.hash(&mut h);
    for item in feed {
        ItemFp(item).hash(&mut h);
    }
    h.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fp(v: &impl Hash) -> u64 {
        let mut h = DefaultHasher::new();
        v.hash(&mut h);
        h.finish()
    }

    fn tool(output: Value) -> FeedItem {
        FeedItem::Tool {
            id: "t1".into(),
            tool_name: "read".into(),
            title: None,
            call_id: None,
            status: crate::state::ToolRunStatus::Completed,
            input: serde_json::json!({ "path": "a.rs" }),
            output: Some(output),
            error: None,
            diff: None,
            streaming: false,
            timestamp_ms: 1,
            completed_at_ms: Some(2),
            output_truncated: false,
        }
    }

    #[test]
    fn tool_fingerprint_sees_nested_output_changes() {
        let a = tool(serde_json::json!({ "lines": ["x", "y"] }));
        let b = tool(serde_json::json!({ "lines": ["x", "z"] }));
        assert_ne!(fp(&ItemFp(&a)), fp(&ItemFp(&b)));
        assert_eq!(fp(&ItemFp(&a)), fp(&ItemFp(&a.clone())));
    }

    #[test]
    fn feed_fast_signature_fallback_sees_nested_changes_in_early_items() {
        let mut feed_a = vec![
            tool(serde_json::json!({ "nested": { "score": 1.25 } })),
            tool(serde_json::json!({ "ok": true })),
            tool(serde_json::json!({ "ok": true })),
            tool(serde_json::json!({ "ok": true })),
            tool(serde_json::json!({ "ok": true })),
            tool(serde_json::json!({ "ok": true })),
        ];
        let sig_a = feed_fast_signature(&feed_a, 0, &[]);
        if let FeedItem::Tool { output, .. } = &mut feed_a[0] {
            *output = Some(serde_json::json!({ "nested": { "score": 2.75 } }));
        }
        let sig_b = feed_fast_signature(&feed_a, 0, &[]);
        assert_ne!(sig_a, sig_b);
    }
}
