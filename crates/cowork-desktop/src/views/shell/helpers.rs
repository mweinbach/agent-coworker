//! Pure presentation, adaptive layout, and workspace/thread grouping helpers for the shell.
//!
//! Ported from `apps/desktop/src/lib/adaptiveLayout.ts` and
//! `apps/desktop/src/ui/sidebarHelpers.ts`.

use std::collections::HashSet;

use rune::Color;
use rune_kit::shell::RowStatus;

use crate::state::{AppState, ThreadRecord, WorkspaceRecord};
use crate::theme::ThemeTokens;

pub const NARROW_BREAKPOINT: f32 = 720.0;
pub const COMPACT_BREAKPOINT: f32 = 960.0;
pub const FULL_BREAKPOINT: f32 = 1120.0;
pub const MIN_PRIMARY_WORKSPACE_WIDTH: f32 = 520.0;
pub const MIN_COMPACT_PRIMARY_WORKSPACE_WIDTH: f32 = 320.0;
pub const LEFT_SIDEBAR_MIN_WIDTH: f32 = 160.0;
pub const LEFT_SIDEBAR_MAX_WIDTH: f32 = 440.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AdaptiveTier {
    Full,
    Compact,
    Narrow,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RightRailKind {
    Context,
    Task,
    Canvas,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AdaptiveLayout {
    pub tier: AdaptiveTier,
    pub left_inline: bool,
    pub left_overlay: bool,
    pub left_width: f32,
    pub right_inline: bool,
    pub right_overlay: bool,
    pub right_width: f32,
    pub primary_width: f32,
}

/// Computes inline vs overlay rail behavior from viewport width while protecting main pane width.
pub fn resolve_adaptive_layout(
    viewport_width: f32,
    sidebar_open: bool,
    sidebar_width: f32,
    has_right_rail: bool,
    right_open: bool,
    right_width_pref: f32,
    right_kind: RightRailKind,
) -> AdaptiveLayout {
    let vw = viewport_width.max(0.0);
    let tier = if vw < NARROW_BREAKPOINT {
        AdaptiveTier::Narrow
    } else if vw < FULL_BREAKPOINT {
        AdaptiveTier::Compact
    } else {
        AdaptiveTier::Full
    };

    let (right_min, right_max): (f32, f32) = match right_kind {
        RightRailKind::Canvas => (320.0, 900.0),
        RightRailKind::Task => (360.0, 600.0),
        RightRailKind::Context => (200.0, 600.0),
    };
    let right_overlay_allowed = right_kind != RightRailKind::Context;
    let left_overlay = tier == AdaptiveTier::Narrow;
    let right_overlay = has_right_rail && right_overlay_allowed && tier != AdaptiveTier::Full;
    let left_inline = !left_overlay && sidebar_open;
    let right_inline = has_right_rail && !right_overlay && right_open;

    let min_primary = if right_inline && tier != AdaptiveTier::Full {
        MIN_COMPACT_PRIMARY_WORKSPACE_WIDTH
    } else {
        MIN_PRIMARY_WORKSPACE_WIDTH
    };
    let capacity = (vw - min_primary).max(0.0);
    let reserved_right_min = if right_inline { right_min } else { 0.0 };

    let left_max = if left_inline {
        (LEFT_SIDEBAR_MAX_WIDTH.min(capacity - reserved_right_min)).max(0.0)
    } else {
        0.0
    };
    let left_min = LEFT_SIDEBAR_MIN_WIDTH.min(left_max);
    let left_width = if left_inline {
        sidebar_width.clamp(left_min, left_max)
    } else {
        0.0
    };

    let right_max_avail = if right_inline {
        right_max.min(capacity - left_width).max(0.0)
    } else {
        0.0
    };
    let right_min_avail = right_min.min(right_max_avail);
    let right_width = if right_inline {
        right_width_pref.clamp(right_min_avail, right_max_avail)
    } else {
        0.0
    };

    AdaptiveLayout {
        tier,
        left_inline,
        left_overlay,
        left_width,
        right_inline,
        right_overlay,
        right_width,
        primary_width: (vw - left_width - right_width).max(0.0),
    }
}

/// Deterministic project badge color matching `base.css` `--search-badge-*` palette.
pub fn workspace_badge_color(workspace_id: &str, t: &ThemeTokens) -> Color {
    let mut hash: usize = 5381;
    for b in workspace_id.bytes() {
        hash = hash.wrapping_mul(33).wrapping_add(b as usize);
    }
    t.search_badges[hash % t.search_badges.len()]
}

/// Formats relative elapsed time concisely (`now`, `5m`, `2h`, `3d`, `2w`, `4mo`, `1y`).
pub fn format_relative_age(updated_at_ms: i64, now_secs: f64) -> String {
    if updated_at_ms <= 0 || now_secs <= 0.0 {
        return String::new();
    }
    let now_ms = (now_secs * 1000.0) as i64;
    let diff_secs = ((now_ms - updated_at_ms).max(0)) / 1000;
    if diff_secs < 60 {
        return "now".to_string();
    }
    let mins = diff_secs / 60;
    if mins < 60 {
        return format!("{mins}m");
    }
    let hours = mins / 60;
    if hours < 24 {
        return format!("{hours}h");
    }
    let days = hours / 24;
    if days < 7 {
        return format!("{days}d");
    }
    let weeks = days / 7;
    if weeks < 5 {
        return format!("{weeks}w");
    }
    let months = days / 30;
    if months < 12 {
        return format!("{}mo", months.max(1));
    }
    format!("{}y", (days / 365).max(1))
}

pub fn format_cost_usd(usd: f64) -> String {
    if usd <= 0.0 {
        "$0.00".to_string()
    } else if usd < 0.01 {
        format!("${usd:.4}")
    } else {
        format!("${usd:.2}")
    }
}

pub fn format_tokens(tokens: u64) -> String {
    if tokens >= 1_000_000 {
        format!("{:.1}M", tokens as f64 / 1_000_000.0)
    } else if tokens >= 1_000 {
        format!("{:.1}k", tokens as f64 / 1_000.0)
    } else {
        tokens.to_string()
    }
}

pub fn format_bytes(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{bytes} B")
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else if bytes < 1024 * 1024 * 1024 {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    } else {
        format!("{:.2} GB", bytes as f64 / (1024.0 * 1024.0 * 1024.0))
    }
}

/// Resolves live indicator status (`Busy`, `Attention`, `Unread`) for a sidebar thread row.
pub fn thread_row_status(s: &AppState, thread_id: &str) -> Option<RowStatus> {
    let rt = s.thread_runtime_by_id.get(thread_id)?;
    if !rt.pending_interactions.is_empty() {
        return Some(RowStatus::Attention);
    }
    if rt.streaming || rt.pending_turn_count > 0 || rt.active_turn_id.is_some() {
        return Some(RowStatus::Busy);
    }
    if rt.unread {
        return Some(RowStatus::Unread);
    }
    None
}

/// Returns total pending user approvals/inputs across all non-archived threads.
pub fn pending_input_count(s: &AppState) -> usize {
    s.threads
        .iter()
        .filter(|t| t.is_standard_chat())
        .filter_map(|t| s.thread_runtime_by_id.get(&t.id))
        .map(|rt| rt.pending_interactions.len())
        .sum()
}

/// Returns whether any non-selected thread has unread updates or needs attention.
pub fn any_background_unread(s: &AppState) -> bool {
    let active_id = s.route().active_thread_id.as_deref();
    s.threads
        .iter()
        .filter(|t| !t.archived && Some(t.id.as_str()) != active_id)
        .filter_map(|t| s.thread_runtime_by_id.get(&t.id))
        .any(|rt| rt.unread || !rt.pending_interactions.is_empty())
}

/// Returns non-archived threads sorted newest-first, matching `sidebarSearch` query if non-empty.
pub fn filtered_threads<'a>(
    s: &'a AppState,
    query: &str,
    needs_input_only: bool,
) -> Vec<&'a ThreadRecord> {
    let q = query.trim().to_lowercase();
    let mut threads: Vec<&ThreadRecord> = s
        .threads
        .iter()
        .filter(|t| t.is_standard_chat())
        .filter(|t| {
            if needs_input_only {
                s.thread_runtime_by_id
                    .get(&t.id)
                    .is_some_and(|rt| !rt.pending_interactions.is_empty())
            } else {
                true
            }
        })
        .filter(|t| {
            q.is_empty()
                || t.title.to_lowercase().contains(&q)
                || t.preview
                    .as_deref()
                    .is_some_and(|p| p.to_lowercase().contains(&q))
        })
        .collect();
    threads.sort_by_key(|b| std::cmp::Reverse(b.updated_at));
    threads
}

/// Separates project workspaces from hidden `oneOffChat` targets (which collapse under `Chats` per repo contract).
pub fn split_workspaces(s: &AppState) -> (Vec<&WorkspaceRecord>, HashSet<&str>, Option<&str>) {
    let ordered = s.resolve_workspace_display_targets();
    let mut projects = Vec::new();
    let mut one_off_ids = HashSet::new();
    let mut primary_one_off_id = None;
    for ws in ordered {
        if ws.one_off_chat {
            one_off_ids.insert(ws.id.as_str());
            if primary_one_off_id.is_none() {
                primary_one_off_id = Some(ws.id.as_str());
            }
        } else {
            projects.push(ws);
        }
    }
    (projects, one_off_ids, primary_one_off_id)
}

/// Whether durable Tasks surfaces are enabled (`feature_flags["tasks"] == true`, default `false`).
pub fn tasks_feature_enabled(s: &AppState) -> bool {
    s.feature_flags.get("tasks").copied().unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::ChatInteraction;
    use cowork_protocol::JsonRpcLiteId;

    #[test]
    fn adaptive_layout_respects_breakpoints_and_rail_caps() {
        let full = resolve_adaptive_layout(
            1440.0,
            true,
            268.0,
            true,
            true,
            340.0,
            RightRailKind::Context,
        );
        assert_eq!(full.tier, AdaptiveTier::Full);
        assert!(full.left_inline);
        assert!(full.right_inline);
        assert!(!full.left_overlay && !full.right_overlay);
        assert!(full.primary_width >= MIN_PRIMARY_WORKSPACE_WIDTH);

        let compact_canvas =
            resolve_adaptive_layout(900.0, true, 268.0, true, true, 400.0, RightRailKind::Canvas);
        assert_eq!(compact_canvas.tier, AdaptiveTier::Compact);
        assert!(compact_canvas.left_inline);
        assert!(compact_canvas.right_overlay);
        assert!(!compact_canvas.right_inline);

        let narrow = resolve_adaptive_layout(
            680.0,
            true,
            268.0,
            true,
            true,
            340.0,
            RightRailKind::Context,
        );
        assert_eq!(narrow.tier, AdaptiveTier::Narrow);
        assert!(narrow.left_overlay);
        assert!(!narrow.left_inline);
        assert!(narrow.right_inline);
    }

    #[test]
    fn split_workspaces_collapses_one_off_chats() {
        let mut s = AppState::default();
        s.workspaces.push(WorkspaceRecord {
            id: "oneoff-1".into(),
            name: "Hidden".into(),
            path: "/tmp/h1".into(),
            one_off_chat: true,
            ..Default::default()
        });
        s.workspaces.push(WorkspaceRecord {
            id: "proj-1".into(),
            name: "Alpha".into(),
            path: "/tmp/alpha".into(),
            one_off_chat: false,
            ..Default::default()
        });
        s.workspaces.push(WorkspaceRecord {
            id: "oneoff-2".into(),
            name: "Hidden 2".into(),
            path: "/tmp/h2".into(),
            one_off_chat: true,
            ..Default::default()
        });

        let (projects, one_offs, primary_one_off) = split_workspaces(&s);
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].id, "proj-1");
        assert_eq!(one_offs.len(), 2);
        assert_eq!(primary_one_off, Some("oneoff-1"));
    }

    #[test]
    fn format_helpers_and_status_badges() {
        assert_eq!(format_relative_age(95_000, 100.0), "now");
        assert_eq!(format_relative_age(0, 100.0), "");
        assert_eq!(format_relative_age(100_000, 700.0), "10m");
        assert_eq!(format_bytes(512), "512 B");
        assert_eq!(format_bytes(2048), "2.0 KB");
        assert_eq!(format_cost_usd(0.0025), "$0.0025");
        assert_eq!(format_cost_usd(1.5), "$1.50");
        assert_eq!(format_tokens(1500), "1.5k");

        let mut s = AppState::default();
        s.threads.push(ThreadRecord {
            id: "t1".into(),
            workspace_id: "w1".into(),
            title: "Thread".into(),
            ..Default::default()
        });
        s.thread_runtime_by_id
            .entry("t1".into())
            .or_default()
            .unread = true;
        assert!(matches!(
            thread_row_status(&s, "t1"),
            Some(RowStatus::Unread)
        ));
        s.thread_runtime_by_id
            .entry("t1".into())
            .or_default()
            .streaming = true;
        assert!(matches!(thread_row_status(&s, "t1"), Some(RowStatus::Busy)));
        s.thread_runtime_by_id
            .entry("t1".into())
            .or_default()
            .pending_interactions
            .push(ChatInteraction::CommandApproval {
                request_id: JsonRpcLiteId::Number(1),
                item_id: "item".into(),
                command: None,
                cwd: None,
                reason: None,
                risk_code: None,
            });
        assert!(matches!(
            thread_row_status(&s, "t1"),
            Some(RowStatus::Attention)
        ));
        assert_eq!(pending_input_count(&s), 1);
    }

    #[test]
    fn tasks_feature_flag_uses_tasks_key_default_false() {
        let mut s = AppState::default();
        assert!(!tasks_feature_enabled(&s));

        // Legacy/wrong key must not unlock Tasks.
        s.feature_flags.insert("tasks_enabled".into(), true);
        assert!(!tasks_feature_enabled(&s));

        s.feature_flags.insert("tasks".into(), true);
        assert!(tasks_feature_enabled(&s));

        s.feature_flags.insert("tasks".into(), false);
        assert!(!tasks_feature_enabled(&s));
    }
}
