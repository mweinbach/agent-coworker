//! Settings feature view module (owned by `settings`).
//!
//! Ported from `apps/desktop/src/ui/settings/` and `apps/desktop/src/ui/settings/pages/`.

use rune::{Cx, col, row, text};
use rune_kit::{Button, ButtonVariant, Kit};

use crate::actions::{Action, NavAction};
use crate::router::ViewId;
use crate::state::AppState;
use crate::views::SubviewOutput;

/// Renders the full-window Settings shell, navigation rail, and active settings page.
pub fn view(s: &AppState, _cx: &mut Cx<AppState>, k: &Kit) -> SubviewOutput {
    let page = s.route().settings_page;

    let content = col()
        .key("settings-view")
        .grow(1.0)
        .w_full()
        .h_full()
        .fill(k.c.page)
        .padding(24.0)
        .gap(12.0)
        .child(
            row()
                .w_full()
                .justify_between()
                .items_center()
                .child(
                    text(page.title())
                        .font(k.ty.body_medium)
                        .color(k.c.text_base),
                )
                .child(
                    Button::new("Back to Chat")
                        .variant(ButtonVariant::Ghost)
                        .on_press_tx(|s: &mut AppState, _tx| {
                            s.dispatch(Action::Navigate(NavAction::OpenView(ViewId::Chat)));
                        })
                        .build(k),
                ),
        )
        .child(text(page.description()).font(k.ty.ui).color(k.c.text_muted));

    SubviewOutput {
        content,
        overlays: Vec::new(),
    }
}
