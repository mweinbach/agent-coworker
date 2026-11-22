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

use crate::state::{ChatInteraction, FeedItem, PluginSummary, SkillSummary};

use super::model::{ActivityGroup, ActivityNode, item_id};
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

/// The pending interactions activity cards read (which tool items await approval).
pub fn interactions_signature(pending: &[ChatInteraction]) -> u64 {
    let mut h = DefaultHasher::new();
    pending.len().hash(&mut h);
    for p in pending {
        std::mem::discriminant(p).hash(&mut h);
        match p {
            ChatInteraction::CommandApproval { item_id, .. }
            | ChatInteraction::FileChangeApproval { item_id, .. }
            | ChatInteraction::UserInput { item_id, .. } => item_id.hash(&mut h),
        }
    }
    h.finish()
}

/// Zero-allocation signature of the skill/plugin inputs `build_mention_catalog` reads.
pub fn skills_plugins_signature(skills: &[SkillSummary], plugins: &[PluginSummary]) -> u64 {
    let mut h = DefaultHasher::new();
    skills.len().hash(&mut h);
    for skill in skills {
        if skill.enabled && !skill.name.trim().is_empty() {
            (&skill.name, &skill.description, &skill.scope).hash(&mut h);
        }
    }
    plugins.len().hash(&mut h);
    for plugin in plugins {
        if plugin.enabled && !plugin.name.trim().is_empty() {
            (&plugin.name, plugin.display_label(), &plugin.version).hash(&mut h);
        }
    }
    h.finish()
}

/// Order-independent hash of a set's members.
fn set_signature<T: Hash>(items: impl Iterator<Item = T>) -> u64 {
    items
        .map(|item| {
            let mut h = DefaultHasher::new();
            item.hash(&mut h);
            h.finish()
        })
        .fold(0u64, u64::wrapping_add)
}

/// The per-item disclosure toggles activity cards read (`tool_diff_states` excepted: a group
/// showing an interactive diff isn't memoized, see [`group_has_diff_state`]).
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
    h.finish()
}

/// Whether any tool in `group` has interactive diff state (selection, mode), which the card
/// reads while it builds and which has no cheap hash.
pub fn group_has_diff_state(ui: &ChatUiState, group: &ActivityGroup<'_>) -> bool {
    !ui.tool_diff_states.is_empty()
        && group.items.iter().any(|item| {
            matches!(item, FeedItem::Tool { id, .. } if ui.tool_diff_states.contains_key(id))
        })
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
}
