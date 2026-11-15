//! Top application toolbar with history navigation, active thread metadata, usage badge, and rail toggles.
//!
//! Ported from `apps/desktop/src/ui/layout/AppTopBar.tsx` and `PlatformTopBarChrome.tsx`.

use rune::{Cx, el, row, text};
use rune_kit::shell::{self, Toolbar};
use rune_kit::{
    Badge, BadgeVariant, Button, ButtonVariant, ControlSize, IconButton, IconButtonVariant, Kit,
    Spinner,
};

use crate::actions::{Action, ChatAction, NavAction, ShellAction};
use crate::router::ViewId;
use crate::state::AppState;
use crate::theme::ThemeTokens;
use crate::views::shell::helpers::{format_cost_usd, format_tokens};
use crate::views::shell::icons;

/// Builds the main pane top toolbar matching `SplitView`'s 48pt unified drag band.
pub fn build_toolbar(s: &AppState, cx: &Cx<AppState>, k: &Kit, t: &ThemeTokens) -> Toolbar {
    let chrome = cx.chrome_insets();

    let title = match s.route().view {
        ViewId::Task => s
            .active_task
            .as_ref()
            .map(|task| task.summary.title.clone())
            .unwrap_or_else(|| "Tasks".to_string()),
        _ => s
            .active_thread()
            .map(|tr| {
                if tr.title.trim().is_empty() {
                    "Untitled chat".to_string()
                } else {
                    tr.title.clone()
                }
            })
            .unwrap_or_else(|| "New Cowork Chat".to_string()),
    };

    let workspace_label = s
        .active_workspace()
        .filter(|w| !w.one_off_chat)
        .map(|w| w.name.clone());

    let active_rt = s.active_thread_runtime();
    let is_busy = active_rt
        .is_some_and(|rt| rt.streaming || rt.pending_turn_count > 0 || rt.active_turn_id.is_some());

    let back_btn = IconButton::new(&icons::ARROW_LEFT)
        .variant(IconButtonVariant::GhostMuted)
        .control_size(ControlSize::Regular)
        .disabled(!s.nav.can_go_back())
        .help("Back")
        .on_press_tx(|s: &mut AppState, _| {
            s.dispatch(Action::Navigate(NavAction::GoBack));
        })
        .build(k)
        .key("topbar-back");

    let forward_btn = IconButton::new(&icons::ARROW_RIGHT)
        .variant(IconButtonVariant::GhostMuted)
        .control_size(ControlSize::Regular)
        .disabled(!s.nav.can_go_forward())
        .help("Forward")
        .on_press_tx(|s: &mut AppState, _| {
            s.dispatch(Action::Navigate(NavAction::GoForward));
        })
        .build(k)
        .key("topbar-forward");

    let mut heading = row()
        .key("topbar-thread-meta")
        .gap(8.0)
        .center_y()
        .shrink()
        .min_w(0.0)
        .child(
            text(title)
                .key("topbar-title")
                .font(k.ty.ui_medium)
                .color(k.c.text_base)
                .truncate(),
        );

    if let Some(ws_name) = workspace_label {
        heading = heading.child(Badge::new(ws_name).variant(BadgeVariant::Subtle).build(k));
    }

    if is_busy {
        heading = heading.child(
            row()
                .key("topbar-busy-indicator")
                .gap(5.0)
                .px(8.0)
                .h(22.0)
                .radius(999.0)
                .fill(t.accent_soft)
                .center_y()
                .child(Spinner::new().size(12.0).color(t.accent).build(k))
                .child(text("Busy").font(k.ty.small_medium).color(t.accent)),
        );
        if let Some(thread_id) = s.route().active_thread_id.clone() {
            heading = heading.child(
                IconButton::new(&icons::STOP_CIRCLE)
                    .variant(IconButtonVariant::GhostMuted)
                    .control_size(ControlSize::Small)
                    .help("Stop current turn")
                    .shortcut("⌘.")
                    .on_press_tx(move |s: &mut AppState, _| {
                        s.dispatch(Action::Chat(ChatAction::CancelTurn {
                            thread_id: thread_id.clone(),
                            include_subagents: true,
                        }));
                    })
                    .build(k)
                    .key("topbar-stop-turn"),
            );
        }
    }

    let mut toolbar = Toolbar::new()
        .leading(back_btn)
        .leading(forward_btn)
        .leading(heading);

    if let Some(rt) = active_rt
        && let Some(usage) = &rt.usage
    {
        let total_tokens = usage.input_tokens + usage.output_tokens;
        let cost = format_cost_usd(usage.estimated_cost_usd);
        let usage_chip = Badge::new(format!("{cost} · {} tok", format_tokens(total_tokens)))
            .variant(BadgeVariant::Neutral)
            .build(k)
            .key("topbar-usage-chip");
        toolbar = toolbar.trailing(usage_chip);

        if rt.usage_hard_cap_reached
            && let Some(thread_id) = s.route().active_thread_id.clone()
        {
            let reset_btn = Button::new("Clear cap")
                .variant(ButtonVariant::Danger)
                .control_size(ControlSize::Small)
                .on_press_tx(move |s: &mut AppState, _| {
                    s.dispatch(Action::Chat(ChatAction::ClearThreadUsageHardCap(
                        thread_id.clone(),
                    )));
                })
                .build(k)
                .key("topbar-clear-hard-cap");
            toolbar = toolbar.trailing(reset_btn);
        }
    }

    let quick_chat_btn = IconButton::new(&icons::POPOUT)
        .variant(IconButtonVariant::GhostMuted)
        .control_size(ControlSize::Regular)
        .help("Quick Chat")
        .on_press_tx(|s: &mut AppState, _| {
            s.dispatch(Action::Shell(ShellAction::ToggleQuickChat));
        })
        .build(k)
        .key("topbar-quick-chat");

    let inspector_open = s.context_sidebar.is_open();
    let inspector_btn = IconButton::new(&shell::INSPECTOR)
        .variant(IconButtonVariant::GhostMuted)
        .control_size(ControlSize::Regular)
        .expanded(inspector_open)
        .help(if inspector_open {
            "Hide context sidebar"
        } else {
            "Show context sidebar"
        })
        .shortcut("⌥⌘I")
        .on_press_tx(|s: &mut AppState, _| {
            s.dispatch(Action::Shell(ShellAction::ToggleContextSidebar));
        })
        .build(k)
        .key("topbar-inspector-toggle");

    let settings_btn = IconButton::new(&icons::SETTINGS)
        .variant(IconButtonVariant::GhostMuted)
        .control_size(ControlSize::Regular)
        .help("Settings")
        .shortcut("⌘,")
        .on_press_tx(|s: &mut AppState, _| {
            s.dispatch(Action::Navigate(NavAction::OpenSettings(None)));
        })
        .build(k)
        .key("topbar-settings");

    toolbar = toolbar
        .trailing(quick_chat_btn)
        .trailing(inspector_btn)
        .trailing(settings_btn);

    if chrome.trailing > 0.0 {
        toolbar = toolbar.trailing(
            el().key("topbar-caption-reserve")
                .w(chrome.trailing)
                .h(1.0)
                .a11y_hidden(),
        );
    }

    toolbar
}
