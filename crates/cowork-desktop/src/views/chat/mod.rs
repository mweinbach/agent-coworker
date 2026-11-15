//! Chat feature view module (owned by `chat`).
//!
//! Ported from `apps/desktop/src/ui/ChatView.tsx`, `src/ui/chat/`, `src/ui/composer/`,
//! `src/ui/markdown/`, `src/ui/attachments/`, and `src/ui/AgentRunViewer.tsx`.

pub mod attachments;
pub mod components;
pub mod composer;
pub mod icons;
pub mod landing;
pub mod markdown;
pub mod model;
pub mod state;

pub use state::ChatUiState;

use rune::{Cx, col, el, text};
use rune_kit::Kit;

use crate::state::AppState;
use crate::theme;
use crate::views::SubviewOutput;

/// Renders the active chat landing view or thread transcript + composer + chat overlays.
pub fn view(s: &AppState, cx: &mut Cx<AppState>, k: &Kit) -> SubviewOutput {
    let dark = s.effective_dark(cx.system_dark());
    let t = theme::resolve_tokens(
        dark,
        s.desktop_settings.reduced_transparency,
        s.desktop_settings.high_contrast,
    );

    let mut overlays = Vec::new();
    let content = if let Some(thread) = s.active_thread() {
        let rt = s.active_thread_runtime();
        let feed_count = rt.map(|r| r.feed.len()).unwrap_or(0);
        let placeholder_feed = col()
            .key("chat-feed-placeholder")
            .w_full()
            .grow(1.0)
            .min_h(0.0)
            .items_center()
            .justify_center()
            .padding(24.0)
            .child(
                text(format!("{} ({feed_count} feed items)", thread.title))
                    .font(k.ty.ui)
                    .color(t.text_muted),
            );
        let dock = composer::build_composer(s, k, &t, &mut overlays, false);

        col()
            .key("chat-view")
            .w_full()
            .grow(1.0)
            .min_h(0.0)
            .child(el().w_full().grow(1.0).min_h(0.0).child(placeholder_feed))
            .child(dock)
    } else {
        col()
            .key("chat-view")
            .w_full()
            .grow(1.0)
            .min_h(0.0)
            .child(landing::build_landing_view(s, k, &t, &mut overlays))
    };

    SubviewOutput { content, overlays }
}
