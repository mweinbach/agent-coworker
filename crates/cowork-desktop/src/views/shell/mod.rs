//! Application shell frame, sidebar, topbar, command palette, toasts, and task/onboarding views
//! (owned by `shell`).
//!
//! Ported from `apps/desktop/src/ui/Sidebar.tsx`, `layout/`, `CommandPalette.tsx`,
//! `InAppToasts.tsx`, `OperationFeedback.tsx`, `OverlayStack.tsx`, `onboarding/`, `tasks/`,
//! `creation/`, `quickChat/`, and `recovery/`.

use rune::{Cx, El, col, el, row, text};
use rune_kit::{Button, ButtonVariant, Kit};

use crate::actions::{Action, NavAction, ShellAction};
use crate::router::ViewId;
use crate::state::AppState;
use crate::theme::{self, ThemeTokens};
use crate::views::{chat, settings};

/// Renders the root application frame for the active `ViewId`, composing `chat::view` or
/// `settings::view` alongside sidebar, topbar, overlays, command palette, and toast stack.
pub fn view(s: &AppState, cx: &mut Cx<AppState>, k: &Kit, t: &ThemeTokens) -> El {
    match s.route().view {
        ViewId::Settings => {
            let sub = settings::view(s, cx, k);
            compose_with_overlays(sub.content, sub.overlays)
        }
        ViewId::Task => {
            let title = s
                .active_task
                .as_ref()
                .map(|task| task.summary.title.clone())
                .unwrap_or_else(|| "Tasks".to_string());
            shell_frame(
                s,
                k,
                t,
                col()
                    .key("task-view-stub")
                    .grow(1.0)
                    .padding(24.0)
                    .child(text(title).font(k.ty.body_medium).color(k.c.text_base)),
            )
        }
        ViewId::Chat => {
            let sub = chat::view(s, cx, k);
            let main = shell_frame(s, k, t, sub.content);
            compose_with_overlays(main, sub.overlays)
        }
    }
}

fn compose_with_overlays(base: El, overlays: Vec<El>) -> El {
    if overlays.is_empty() {
        return base;
    }
    el().grow(1.0).w_full().h_full().child(base).children(
        overlays
            .into_iter()
            .map(|overlay| overlay.absolute(0.0, 0.0).w_full().h_full()),
    )
}

fn shell_frame(s: &AppState, k: &Kit, t: &ThemeTokens, main_content: El) -> El {
    let mut children = Vec::new();
    if s.sidebar.is_open() {
        children.push(
            col()
                .key("sidebar-stub")
                .w(theme::layout::SIDEBAR_DEFAULT_WIDTH)
                .h_full()
                .fill(t.sidebar_bg)
                .padding(16.0)
                .gap(8.0)
                .child(text("Cowork").font(k.ty.body_medium).color(t.text_base))
                .child(
                    text(format!("{} workspaces", s.workspaces.len()))
                        .font(k.ty.small)
                        .color(t.text_muted),
                )
                .child(
                    Button::new("Toggle Sidebar")
                        .variant(ButtonVariant::Ghost)
                        .on_press_tx(|s: &mut AppState, _tx| {
                            s.dispatch(Action::Shell(ShellAction::ToggleSidebar));
                        })
                        .build(k),
                )
                .child(
                    Button::new("Settings")
                        .variant(ButtonVariant::Ghost)
                        .on_press_tx(|s: &mut AppState, _tx| {
                            s.dispatch(Action::Navigate(NavAction::OpenSettings(None)));
                        })
                        .build(k),
                ),
        );
    }

    children.push(
        col()
            .key("main-pane")
            .grow(1.0)
            .h_full()
            .fill(t.panel_bg)
            .child(main_content),
    );

    row()
        .key("shell-root")
        .w_full()
        .h_full()
        .fill(t.app_bg)
        .children(children)
}
