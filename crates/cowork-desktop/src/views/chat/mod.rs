//! Chat feature view module (owned by `chat`).
//!
//! Ported from `apps/desktop/src/ui/ChatView.tsx`, `src/ui/chat/`, `src/ui/composer/`,
//! `src/ui/markdown/`, `src/ui/attachments/`, and `src/ui/AgentRunViewer.tsx`.

pub mod attachments;
pub mod components;
pub mod icons;
pub mod markdown;
pub mod model;
pub mod state;

pub use state::ChatUiState;

use rune::{Cx, col, text};
use rune_kit::{Button, ButtonVariant, Kit};

use crate::actions::{Action, NavAction};
use crate::state::AppState;
use crate::views::SubviewOutput;

/// Renders the active chat landing view or thread transcript + composer + chat overlays.
pub fn view(s: &AppState, _cx: &mut Cx<AppState>, k: &Kit) -> SubviewOutput {
    let title = s
        .active_thread()
        .map(|t| t.title.clone())
        .unwrap_or_else(|| "New Cowork Chat".to_string());

    let feed_count = s
        .active_thread_runtime()
        .map(|rt| rt.feed.len())
        .unwrap_or(0);

    let content = col()
        .key("chat-view")
        .grow(1.0)
        .w_full()
        .h_full()
        .padding(24.0)
        .gap(12.0)
        .child(text(title).font(k.ty.body_medium).color(k.c.text_base))
        .child(
            text(format!("Chat view ready ({feed_count} feed items)"))
                .font(k.ty.ui)
                .color(k.c.text_muted),
        )
        .child(
            Button::new("Open Settings")
                .variant(ButtonVariant::Neutral)
                .on_press_tx(|s: &mut AppState, _tx| {
                    s.dispatch(Action::Navigate(NavAction::OpenSettings(None)));
                })
                .build(k),
        );

    SubviewOutput {
        content,
        overlays: Vec::new(),
    }
}
