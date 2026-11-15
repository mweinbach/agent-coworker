//! Chat feature view module (owned by `chat`).
//!
//! Ported from `apps/desktop/src/ui/ChatView.tsx`, `src/ui/chat/`, `src/ui/composer/`,
//! `src/ui/markdown/`, `src/ui/attachments/`, and `src/ui/AgentRunViewer.tsx`.

pub mod activity;
pub mod agent_run_viewer;
pub mod attachments;
pub mod canvas;
pub mod components;
pub mod composer;
pub mod dialogs;
pub mod feed;
pub mod feed_row;
pub mod icons;
pub mod interaction;
pub mod landing;
pub mod markdown;
mod math;
pub mod model;
#[cfg(test)]
mod parity_tests;
pub mod state;

pub use canvas::{canvas_pane, is_canvas_document_path, is_canvas_maximized};
pub use state::ChatUiState;

use rune::{Cx, col, row};
use rune_kit::Kit;

use crate::state::{AppState, ServerLifecycleState, ThreadStatus};
use crate::theme;
use crate::views::SubviewOutput;

use self::agent_run_viewer::build_agent_run_drawer;
use self::components::{locked_task_bar, read_only_notice_bar};
use self::dialogs::{build_cancel_subagents_dialog, build_transcript_recovery_banner};
use self::feed::{ChatFeedProps, build_chat_feed};
use self::feed_row::render_active_feed_popovers;
use self::model::workspace_is_reconnecting;

/// Renders the active chat landing view or thread transcript + composer + subagent drawer + overlays.
pub fn view(s: &AppState, cx: &mut Cx<AppState>, k: &Kit) -> SubviewOutput {
    let dark = s.effective_dark(cx.system_dark());
    let t = theme::resolve_tokens_with_accent(
        dark,
        s.desktop_settings.reduced_transparency,
        s.desktop_settings.high_contrast,
        s.desktop_settings.accent_palette,
    );

    let chat_view_width = cx.layout_size("chat-view").map(|[w, _]| w);
    let mut overlays = Vec::new();
    let content = if let Some(thread) = s.active_thread() {
        let rt = s.active_thread_runtime();
        let ws = s.workspaces.iter().find(|w| w.id == thread.workspace_id);
        let ws_rt = s.workspace_runtime_by_id.get(&thread.workspace_id);
        let disconnected = thread.status == ThreadStatus::Disconnected
            || ws_rt
                .is_some_and(|w| !matches!(w.server_state, ServerLifecycleState::Running { .. }));
        let reconnecting = workspace_is_reconnecting(ws_rt);
        let thread_busy = rt.is_some_and(|r| r.streaming || r.active_turn_id.is_some());

        let mut main_col = col()
            .key("chat-main")
            .w_full()
            .grow(1.0)
            .min_w(0.0)
            .min_h(0.0);

        if let Some(notice) = rt.and_then(|r| r.read_only_notice.as_ref()) {
            main_col = main_col.child(read_only_notice_bar(
                k,
                &t,
                &notice.title,
                &notice.detail,
                None,
            ));
        }

        let feed_el = build_chat_feed(
            s,
            k,
            &t,
            &ChatFeedProps {
                thread_key: &thread.id,
                raw_feed: rt.map(|r| r.feed.as_slice()).unwrap_or(&[]),
                thread_busy,
                hydrating: rt.is_some_and(|r| r.hydrating),
                transcript_only: rt.is_some_and(|r| r.transcript_only),
                disconnected,
                reconnecting,
                pending_interactions: rt.map(|r| r.pending_interactions.as_slice()).unwrap_or(&[]),
                interaction_errors: rt
                    .map(|r| &r.interaction_errors)
                    .unwrap_or(&EMPTY_INTERACTION_ERRORS),
                agents: rt.map(|r| r.agents.as_slice()).unwrap_or(&[]),
                workspace_id: Some(thread.workspace_id.as_str()),
                workspace_path: ws.map(|w| w.path.as_str()),
                external_cache: None,
                is_agent_viewer: false,
                scroll_area_key: "chat-feed-area",
                viewport_key: "chat-feed-scroll",
                frame_key: "chat-feed-frame",
            },
        );

        let feed_wrap = col()
            .key("chat-feed-surface")
            .w_full()
            .grow(1.0)
            .min_h(0.0)
            .child(feed_el);
        main_col = main_col.child(feed_wrap);

        if let Some(failure) = rt.and_then(|r| r.transcript_delivery_failure.as_ref()) {
            main_col = main_col.child(build_transcript_recovery_banner(k, &t, &thread.id, failure));
        }

        if let Some(lock) = rt
            .and_then(|r| r.source_task.as_ref())
            .filter(|l| l.read_only)
        {
            main_col = main_col.child(locked_task_bar(
                k,
                &t,
                lock.task_id.clone(),
                lock.task_title.clone(),
            ));
        } else {
            main_col = main_col.child(composer::build_composer(s, k, &t, &mut overlays, false));
        }

        let mut split = row()
            .key("chat-view")
            .w_full()
            .grow(1.0)
            .min_w(0.0)
            .min_h(0.0)
            .child(main_col);
        if let Some(drawer) = build_agent_run_drawer(s, k, &t, chat_view_width) {
            if chat_view_width.is_some_and(|w| w < 820.0) {
                split = split.child(
                    col()
                        .key("agent-run-viewer-backdrop")
                        .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
                        .fill(t.scrim)
                        .items_end()
                        .modal(true, |s: &mut AppState| {
                            s.dispatch(crate::actions::Action::Chat(
                                crate::actions::ChatAction::CloseAgentViewer,
                            ));
                        })
                        .child(drawer),
                );
            } else {
                split = split.child(drawer);
            }
        }
        split
    } else {
        col()
            .key("chat-view")
            .w_full()
            .grow(1.0)
            .min_h(0.0)
            .child(landing::build_landing_view(s, k, &t, &mut overlays))
    };

    build_cancel_subagents_dialog(s, k, &mut overlays);
    render_active_feed_popovers(s, k, &t, &mut overlays);

    SubviewOutput { content, overlays }
}

static EMPTY_INTERACTION_ERRORS: std::sync::LazyLock<std::collections::HashMap<String, String>> =
    std::sync::LazyLock::new(std::collections::HashMap::new);
