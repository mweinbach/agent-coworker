//! Read-only side drawer inspecting a spawned child subagent's live or historical run feed.

use std::collections::HashMap;
use std::sync::LazyLock;

use rune::{El, col, icon, row, spacer, text};
use rune_kit::{ControlSize, IconButton, IconButtonVariant, Kit};

use crate::actions::{Action, ChatAction};
use crate::state::{AppState, FeedItem, ThreadAgentSummary};
use crate::theme::ThemeTokens;

use super::components::{StatusPillTone, status_pill};
use super::feed::{ChatFeedProps, FeedSource, build_chat_feed};
use super::icons;
use super::model::is_active_child_agent;

static EMPTY_ERRORS: LazyLock<HashMap<String, String>> = LazyLock::new(HashMap::new);

/// Builds the subagent transcript drawer when `AppState::agent_viewer` is active.
pub fn build_agent_run_drawer(
    s: &AppState,
    k: &Kit,
    t: &ThemeTokens,
    chat_view_width: Option<f32>,
) -> Option<El> {
    let viewer = s.agent_viewer.as_ref()?;
    let rt = s.thread_runtime_by_id.get(&viewer.thread_id);
    let child_rt = s.thread_runtime_by_id.get(&viewer.agent_id);
    let agent = rt.and_then(|r| r.agents.iter().find(|a| a.agent_id == viewer.agent_id));
    let raw_feed: &[FeedItem] = child_rt
        .map(|r| r.feed.as_slice())
        .filter(|items| !items.is_empty())
        .or_else(|| {
            rt.and_then(|r| r.agent_run_feeds.get(&viewer.agent_id))
                .map(Vec::as_slice)
        })
        .unwrap_or(&[]);

    let thread = s.threads.iter().find(|th| th.id == viewer.thread_id);
    let workspace = thread.and_then(|th| s.workspaces.iter().find(|w| w.id == th.workspace_id));
    let workspace_id = thread.map(|th| th.workspace_id.as_str());
    let workspace_path = workspace.map(|w| w.path.as_str());

    let title = resolve_agent_title(&viewer.title, agent);
    let is_active = agent.is_some_and(is_active_child_agent)
        || child_rt.is_some_and(|r| r.streaming || r.active_turn_id.is_some());
    let is_hydrating = child_rt.is_some_and(|r| r.hydrating) || (is_active && raw_feed.is_empty());
    let (status_label, status_tone) = resolve_agent_status(agent, is_active);
    let subtitle = format_agent_metadata(agent);

    let close_btn = IconButton::new(k.glyph.close)
        .variant(IconButtonVariant::Ghost)
        .control_size(ControlSize::Small)
        .label("Close subagent viewer")
        .on_press(|s: &mut AppState| {
            s.dispatch(Action::Chat(ChatAction::CloseAgentViewer));
        })
        .build(k)
        .key("agent-viewer-close");

    let mut header = col()
        .key("agent-viewer-header")
        .w_full()
        .gap(6.0)
        .px(16.0)
        .py(12.0)
        .border_sides([0.0, 0.0, 1.0, 0.0], t.border_muted)
        .child(
            row()
                .w_full()
                .items_center()
                .gap(8.0)
                .child(icon(&icons::BOT, 15.0).color(t.accent))
                .child(
                    text(title)
                        .font(k.ty.body_medium)
                        .color(t.text_base)
                        .truncate()
                        .grow(1.0)
                        .min_w(0.0),
                )
                .child(status_pill(k, t, status_label, status_tone))
                .child(close_btn),
        );

    if let Some(meta) = subtitle {
        header = header.child(
            text(meta)
                .font(k.ty.text_xsmall)
                .color(t.text_muted)
                .truncate()
                .w_full(),
        );
    }

    if let Some(err) = agent
        .and_then(|a| a.error.as_deref())
        .map(str::trim)
        .filter(|e| !e.is_empty())
    {
        header = header.child(
            row()
                .w_full()
                .items_start()
                .gap(8.0)
                .px(10.0)
                .py(8.0)
                .radius(8.0)
                .fill(k.alpha(t.danger, 0.10))
                .border(1.0, k.alpha(t.danger, 0.28))
                .child(icon(&icons::ALERT, 13.0).color(t.danger).mt(2.0))
                .child(
                    text(err.to_string())
                        .font(k.ty.text_xsmall)
                        .color(t.danger)
                        .wrap()
                        .grow(1.0)
                        .min_w(0.0),
                ),
        );
    }

    let agent_feed_key = format!("agent:{}", viewer.agent_id);
    let body = if raw_feed.is_empty() && !is_active && !is_hydrating {
        col()
            .w_full()
            .grow(1.0)
            .min_h(0.0)
            .items_center()
            .justify_center()
            .padding(24.0)
            .gap(8.0)
            .child(icon(&icons::BOT, 22.0).color(t.text_faint))
            .child(
                text("No messages recorded for this subagent yet.")
                    .font(k.ty.ui)
                    .color(t.text_muted),
            )
            .child(spacer())
    } else {
        build_chat_feed(
            s,
            k,
            t,
            &ChatFeedProps {
                thread_key: &agent_feed_key,
                source: FeedSource::AgentRun {
                    thread_id: viewer.thread_id.clone(),
                    agent_id: viewer.agent_id.clone(),
                },
                thread_busy: is_active,
                hydrating: is_hydrating,
                transcript_only: false,
                disconnected: false,
                reconnecting: false,
                interaction_errors: &EMPTY_ERRORS,
                workspace_id,
                workspace_path,
                external_cache: None,
                is_agent_viewer: true,
                scroll_area_key: "agent-feed-area",
                viewport_key: "agent-feed-scroll",
                frame_key: "agent-feed-frame",
            },
        )
    };

    let overlay_w = chat_view_width
        .filter(|&w| w < 820.0)
        .map(|w| (w - 32.0).clamp(280.0, 432.0));

    let mut drawer = col()
        .key("agent-run-viewer")
        .h_full()
        .min_h(0.0)
        .fill(if overlay_w.is_some() {
            t.popover_bg
        } else {
            t.panel_bg
        })
        .border_sides([0.0, 0.0, 0.0, 1.0], t.border_muted)
        .child(header)
        .child(body);
    drawer = if let Some(w) = overlay_w {
        drawer.w(w).border(1.0, t.border_strong)
    } else {
        drawer.w(432.0).min_w(340.0).max_w(480.0)
    };
    Some(drawer)
}

fn resolve_agent_title(viewer_title: &str, agent: Option<&ThreadAgentSummary>) -> String {
    let trimmed = viewer_title.trim();
    if !trimmed.is_empty() {
        return trimmed.to_string();
    }
    if let Some(a) = agent {
        if let Some(t) = a.title.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            return t.to_string();
        }
        if let Some(n) = a
            .nickname
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            return n.to_string();
        }
        let name = a.name.trim();
        if !name.is_empty() {
            return name.to_string();
        }
    }
    "Subagent".to_string()
}

fn resolve_agent_status(
    agent: Option<&ThreadAgentSummary>,
    is_active: bool,
) -> (&'static str, StatusPillTone) {
    if is_active {
        return ("Running", StatusPillTone::Accent);
    }
    let Some(a) = agent else {
        return ("Subagent", StatusPillTone::Neutral);
    };
    match a.status.to_ascii_lowercase().as_str() {
        "failed" | "errored" | "error" => ("Failed", StatusPillTone::Danger),
        "cancelled" | "canceled" => ("Cancelled", StatusPillTone::Warning),
        "completed" | "closed" | "done" => ("Completed", StatusPillTone::Success),
        _ => ("Finished", StatusPillTone::Neutral),
    }
}

fn format_agent_metadata(agent: Option<&ThreadAgentSummary>) -> Option<String> {
    let a = agent?;
    let mut parts = Vec::new();
    if let Some(role) = a.role.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        parts.push(role.to_string());
    }
    if a.depth > 0 {
        parts.push(format!("depth {}", a.depth));
    }
    if let Some(model) = a.model.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        parts.push(model.to_string());
    }
    if let Some(usage) = a
        .usage_label
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        parts.push(usage.to_string());
    }
    (!parts.is_empty()).then(|| parts.join(" · "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_agent_metadata_and_status_handles_running_and_completed() {
        let running = ThreadAgentSummary {
            agent_id: "a1".into(),
            name: "worker".into(),
            role: Some("explorer".into()),
            depth: 1,
            status: "running".into(),
            model: Some("gpt-5".into()),
            usage_label: Some("4.2k tok".into()),
            ..Default::default()
        };
        assert_eq!(resolve_agent_status(Some(&running), true).0, "Running");
        assert_eq!(
            format_agent_metadata(Some(&running)).as_deref(),
            Some("explorer · depth 1 · gpt-5 · 4.2k tok")
        );

        let done = ThreadAgentSummary {
            status: "completed".into(),
            completed_at: Some(10),
            ..running
        };
        assert_eq!(resolve_agent_status(Some(&done), false).0, "Completed");
    }
}
