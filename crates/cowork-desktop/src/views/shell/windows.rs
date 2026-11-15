//! Secondary desktop shells: Menu Bar Utility popover window and Quick Chat floating shell.

use rune::{Cx, El, ScrollSpec, col, el, icon, row, spacer, text};
use rune_kit::shell::RowStatus;
use rune_kit::{Badge, Button, ButtonVariant, ControlSize, Kit};

use crate::actions::{Action, NavAction, ShellAction};
use crate::state::{AppState, WindowMode};
use crate::theme::ThemeTokens;
use crate::views::SubviewOutput;

use super::{helpers, icons};

/// Render the compact Menu Bar Utility shell when `s.window_mode == WindowMode::Utility`.
pub fn build_utility_window(s: &AppState, cx: &mut Cx<AppState>, k: &Kit, t: &ThemeTokens) -> El {
    let top_pad = cx.titlebar_inset().max(8.0);
    let active_ws = s
        .active_workspace_id
        .as_deref()
        .and_then(|id| s.workspaces.iter().find(|w| w.id == id))
        .or_else(|| s.workspaces.first());

    let recent_threads: Vec<_> = s.threads.iter().filter(|th| !th.archived).take(6).collect();
    let busy_count = s
        .thread_runtime_by_id
        .values()
        .filter(|rt| rt.streaming || rt.pending_turn_count > 0 || rt.active_turn_id.is_some())
        .count();

    let mut header = row()
        .key("utility-header")
        .w_full()
        .px(14.0)
        .pt(top_pad)
        .pb(10.0)
        .gap(8.0)
        .center_y()
        .child(icon(&icons::SPARKLES, 15.0).color(t.accent))
        .child(text("Cowork").font(t.label).color(t.text_base));
    if busy_count > 0 {
        header = header.child(Badge::new(format!("{busy_count} active")).build(k));
    }
    header = header.child(spacer()).child(
        Button::new("Open main")
            .variant(ButtonVariant::Ghost)
            .control_size(ControlSize::Small)
            .icon(&icons::POPOUT)
            .on_press_tx(|s: &mut AppState, _| {
                s.dispatch(Action::Shell(ShellAction::SetWindowMode(WindowMode::Main)));
            })
            .build(k),
    );

    let ws_summary = active_ws.map(|ws| {
        row()
            .w_full()
            .px(10.0)
            .py(8.0)
            .radius(8.0)
            .fill(t.card_bg)
            .border(1.0, t.border_muted)
            .gap(8.0)
            .center_y()
            .child(icon(&icons::FOLDER, 14.0).color(t.accent))
            .child(
                col()
                    .grow(1.0)
                    .shrink()
                    .child(text(&ws.name).font(t.label).color(t.text_base).truncate())
                    .child(
                        text(&ws.path)
                            .font(t.caption)
                            .color(t.text_faint)
                            .truncate(),
                    ),
            )
    });

    let quick_actions = row()
        .key("utility-quick-actions")
        .w_full()
        .gap(8.0)
        .child({
            let ws_id = active_ws.map(|w| w.id.clone());
            let mut primary_kit = k.clone();
            primary_kit.c.bg_icon_button_contrast = t.accent;
            primary_kit.c.submit_fg = t.primary_fg;
            primary_kit.c.submit_icon = t.primary_fg;
            Button::new("New chat")
                .variant(ButtonVariant::Submit)
                .control_size(ControlSize::Small)
                .icon(&icons::PLUS)
                .on_press_tx(move |s: &mut AppState, _| {
                    s.dispatch(Action::Shell(ShellAction::SetWindowMode(WindowMode::Main)));
                    s.dispatch(Action::Navigate(NavAction::OpenNewChat {
                        workspace_id: ws_id.clone(),
                    }));
                })
                .build(&primary_kit)
        })
        .child(
            Button::new("Quick Chat")
                .variant(ButtonVariant::Ghost)
                .control_size(ControlSize::Small)
                .icon(&icons::MESSAGE)
                .on_press_tx(|s: &mut AppState, _| {
                    s.dispatch(Action::Shell(ShellAction::SetWindowMode(
                        WindowMode::QuickChat,
                    )));
                })
                .build(k),
        );

    let thread_list = if recent_threads.is_empty() {
        el().w_full()
            .padding(12.0)
            .radius(8.0)
            .fill(t.card_bg)
            .child(
                text("No recent conversations.")
                    .font(t.caption)
                    .color(t.text_muted),
            )
    } else {
        col()
            .w_full()
            .gap(4.0)
            .children(recent_threads.into_iter().map(|th| {
                let status = helpers::thread_row_status(s, &th.id);
                let tid = th.id.clone();

                let mut item_row = row()
                    .w_full()
                    .gap(8.0)
                    .center_y()
                    .child(icon(&icons::MESSAGE, 13.0).color(t.text_muted))
                    .child(
                        text(&th.title)
                            .font(t.body)
                            .color(t.text_base)
                            .truncate()
                            .grow(1.0),
                    );
                if matches!(status, Some(RowStatus::Busy)) {
                    item_row = item_row.child(Badge::new("Busy").build(k));
                } else if matches!(status, Some(RowStatus::Attention)) {
                    item_row = item_row.child(Badge::new("Input").build(k));
                }

                el().key(format!("util-th-{}", th.id))
                    .w_full()
                    .px(10.0)
                    .py(7.0)
                    .radius(7.0)
                    .fill(t.card_bg)
                    .hover(t.hover)
                    .on_press_tx(move |s: &mut AppState, _| {
                        s.dispatch(Action::Shell(ShellAction::SetWindowMode(WindowMode::Main)));
                        s.dispatch(Action::Navigate(NavAction::OpenThread(tid.clone())));
                    })
                    .child(item_row)
            }))
    };

    col()
        .key("menu-bar-utility-shell")
        .w_full()
        .h_full()
        .min_h(0.0)
        .fill(t.panel_bg)
        .child(header)
        .child(el().w_full().h(1.0).fill(t.border_muted))
        .child(
            col()
                .grow(1.0)
                .shrink()
                .min_h(0.0)
                .w_full()
                .scroll(ScrollSpec {
                    stick_bottom: false,
                })
                .padding(14.0)
                .gap(12.0)
                .children(ws_summary)
                .child(quick_actions)
                .child(
                    text("Recent conversations")
                        .font(t.caption)
                        .color(t.text_faint),
                )
                .child(thread_list),
        )
}

/// Render the Quick Chat floating shell when `s.window_mode == WindowMode::QuickChat`.
pub fn build_quick_chat_window(
    s: &AppState,
    cx: &mut Cx<AppState>,
    k: &Kit,
    t: &ThemeTokens,
    chat_subview: SubviewOutput,
) -> El {
    let top_pad = cx.titlebar_inset().max(8.0);
    let ws_name = s
        .active_workspace_id
        .as_deref()
        .and_then(|id| s.workspaces.iter().find(|w| w.id == id && !w.one_off_chat))
        .map(|w| w.name.as_str());

    let header = row()
        .key("quick-chat-header")
        .w_full()
        .px(14.0)
        .pt(top_pad)
        .pb(8.0)
        .gap(8.0)
        .center_y()
        .fill(t.panel_bg)
        .child(icon(&icons::SPARKLES, 14.0).color(t.accent))
        .child(text("Quick Chat").font(t.label).color(t.text_base))
        .children(ws_name.map(|name| Badge::new(name).build(k)))
        .child(spacer())
        .child(
            Button::new("Pop out")
                .variant(ButtonVariant::Ghost)
                .control_size(ControlSize::Small)
                .icon(&icons::POPOUT)
                .on_press_tx(|s: &mut AppState, _| {
                    s.dispatch(Action::Shell(ShellAction::SetWindowMode(WindowMode::Main)));
                    s.dispatch(Action::Shell(ShellAction::SetQuickChatOpen(false)));
                })
                .build(k),
        );

    let frame = col()
        .key("quick-chat-shell")
        .w_full()
        .h_full()
        .min_h(0.0)
        .fill(t.app_bg)
        .child(header)
        .child(el().w_full().h(1.0).fill(t.border_muted))
        .child(
            el().grow(1.0)
                .shrink()
                .min_h(0.0)
                .w_full()
                .child(chat_subview.content),
        );

    rune_kit::root(frame, chat_subview.overlays)
}

/// Fallback centered Quick Chat spotlight sheet when opened inside the Main window.
pub fn build_inline_quick_chat_overlay(
    s: &AppState,
    k: &Kit,
    t: &ThemeTokens,
    chat_content: El,
) -> Option<El> {
    if !s.quick_chat_open || s.window_mode != WindowMode::Main {
        return None;
    }

    let ws_name = s
        .active_workspace_id
        .as_deref()
        .and_then(|id| s.workspaces.iter().find(|w| w.id == id && !w.one_off_chat))
        .map(|w| w.name.as_str());

    let sheet = col()
        .key("inline-quick-chat-sheet")
        .w(640.0)
        .h(520.0)
        .max_h(560.0)
        .radius(14.0)
        .fill(t.panel_bg)
        .border(1.0, t.border_strong)
        .child(
            row()
                .w_full()
                .h(42.0)
                .px(14.0)
                .gap(8.0)
                .center_y()
                .fill(t.elevated_bg)
                .child(icon(&icons::SPARKLES, 14.0).color(t.accent))
                .child(text("Quick Chat").font(t.label).color(t.text_base))
                .children(ws_name.map(|name| Badge::new(name).build(k)))
                .child(spacer())
                .child(
                    Button::new("Close")
                        .variant(ButtonVariant::Ghost)
                        .control_size(ControlSize::Small)
                        .on_press_tx(|s: &mut AppState, _| {
                            s.dispatch(Action::Shell(ShellAction::SetQuickChatOpen(false)));
                        })
                        .build(k),
                ),
        )
        .child(el().w_full().h(1.0).fill(t.border_muted))
        .child(
            el().grow(1.0)
                .shrink()
                .min_h(0.0)
                .w_full()
                .child(chat_content),
        );

    Some(
        el().key("inline-quick-chat-backdrop")
            .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
            .fill(t.scrim)
            .center()
            .padding(24.0)
            .modal(true, |s: &mut AppState| {
                s.dispatch(Action::Shell(ShellAction::SetQuickChatOpen(false)));
            })
            .child(sheet),
    )
}
