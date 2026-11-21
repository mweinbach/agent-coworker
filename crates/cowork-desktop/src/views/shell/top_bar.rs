//! Top application toolbar with history navigation, active thread metadata, usage badge, and rail toggles.
//!
//! Ported from `apps/desktop/src/ui/layout/AppTopBar.tsx` and `PlatformTopBarChrome.tsx`.

use rune::{Cx, El, col, el, row, spacer, text};
use rune_kit::shell;
use rune_kit::{
    Badge, BadgeVariant, Button, ButtonVariant, ControlSize, Divider, IconButton,
    IconButtonVariant, Kit, Placement, Popover, Spinner,
};

use crate::actions::{Action, ChatAction, NavAction, ShellAction};
use crate::router::ViewId;
use crate::state::{AppState, ThreadRuntime, UsageSummary};
use crate::theme::ThemeTokens;
use crate::views::shell::helpers::{
    COMPACT_BREAKPOINT, NARROW_BREAKPOINT, format_cost_usd, format_tokens,
};
use crate::views::shell::icons;
use crate::views::shell::split_frame::ShellToolbar;

fn append_caption_reserve(toolbar: ShellToolbar, chrome: rune::ChromeInsets) -> ShellToolbar {
    if chrome.trailing > 0.0 {
        toolbar.trailing(
            el().key("topbar-caption-reserve")
                .w(chrome.trailing)
                .h(1.0)
                .a11y_hidden(),
        )
    } else {
        toolbar
    }
}

/// Builds the Settings surface toolbar hosted inside the full-bleed split frame.
#[allow(clippy::too_many_arguments)]
pub fn build_settings_toolbar(
    s: &AppState,
    cx: &Cx<AppState>,
    k: &Kit,
    t: &ThemeTokens,
    narrow: bool,
    primary_width: f32,
    title: &str,
    workspace_badge: Option<&str>,
    header_actions: Vec<El>,
) -> ShellToolbar {
    let chrome = cx.chrome_insets();
    let mut toolbar = ShellToolbar::new();

    if narrow {
        let drawer_open = s.settings_ui.mobile_nav_open;
        let narrow_nav_btn = IconButton::new(&shell::SIDEBAR)
            .variant(IconButtonVariant::GhostMuted)
            .control_size(ControlSize::Small)
            .help(if drawer_open {
                "Close settings navigation"
            } else {
                "Open settings navigation"
            })
            .on_press(|s: &mut AppState| {
                s.settings_ui.mobile_nav_open = !s.settings_ui.mobile_nav_open;
                if s.settings_ui.mobile_nav_open {
                    s.shell_ui.right_overlay_open = false;
                }
            })
            .build(k)
            .key("topbar-narrow-settings-nav-toggle");
        toolbar = toolbar.leading(narrow_nav_btn);
    }

    if let Some(menu_strip) =
        super::menu_bar::build_menu_bar_strip(s, k, t, Some(primary_width), chrome.trailing)
    {
        toolbar = toolbar.leading(menu_strip).leading(
            el().w(1.0)
                .h(14.0)
                .mx(4.0)
                .fill(t.border_muted)
                .a11y_hidden(),
        );
    }

    let mut heading = row()
        .key("settings-toolbar-heading")
        .items_center()
        .gap(8.0)
        .min_w(0.0)
        .transition(rune::Transition::none())
        .child(
            text(title)
                .font(k.ty.ui_medium)
                .color(t.text_base)
                .truncate(),
        );
    if let Some(badge_label) = workspace_badge {
        heading = heading.child(
            Badge::new(badge_label)
                .variant(BadgeVariant::Subtle)
                .build(k),
        );
    }
    toolbar = toolbar.leading(heading);

    for action in header_actions {
        toolbar = toolbar.trailing(action.transition(rune::Transition::none()));
    }

    append_caption_reserve(toolbar, chrome)
}

/// Builds the main pane top toolbar matching the full-bleed `48`pt titlebar band.
/// Back and forward history buttons. They sit beside the sidebar toggle in the sidebar's title
/// bar, or in the toolbar when the sidebar is a drawer (narrow windows).
pub fn build_nav_buttons(s: &AppState, k: &Kit) -> Vec<El> {
    let back_btn = IconButton::new(&icons::ARROW_LEFT)
        .variant(IconButtonVariant::GhostMuted)
        .control_size(ControlSize::Regular)
        .disabled(!s.nav.can_go_back())
        .help("Back")
        .on_press_tx(|s: &mut AppState, tx| {
            s.dispatch_tx(Action::Navigate(NavAction::GoBack), tx);
        })
        .build(k)
        .key("topbar-back");

    let forward_btn = IconButton::new(&icons::ARROW_RIGHT)
        .variant(IconButtonVariant::GhostMuted)
        .control_size(ControlSize::Regular)
        .disabled(!s.nav.can_go_forward())
        .help("Forward")
        .on_press_tx(|s: &mut AppState, tx| {
            s.dispatch_tx(Action::Navigate(NavAction::GoForward), tx);
        })
        .build(k)
        .key("topbar-forward");
    vec![back_btn, forward_btn]
}

pub fn build_toolbar(
    s: &AppState,
    cx: &Cx<AppState>,
    k: &Kit,
    t: &ThemeTokens,
    primary_width: f32,
    include_nav: bool,
    layer: &mut Vec<El>,
) -> ShellToolbar {
    let chrome = cx.chrome_insets();
    let narrow = s.shell_ui.viewport_width < NARROW_BREAKPOINT;
    let compact = s.shell_ui.viewport_width < COMPACT_BREAKPOINT;

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

    if !compact && let Some(ws_name) = workspace_label {
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
                    .shortcut(crate::shortcut_label("Cmd+."))
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

    let mut toolbar = ShellToolbar::new();
    if narrow {
        // `FullBleedSplit` already pads leading toolbar items past traffic lights on narrow viewports.
        let drawer_open = s.shell_ui.left_overlay_open;
        let narrow_sidebar_btn = IconButton::new(&shell::SIDEBAR)
            .variant(IconButtonVariant::GhostMuted)
            .control_size(ControlSize::Regular)
            .expanded(drawer_open)
            .help("Toggle navigation drawer")
            .shortcut(crate::shortcut_label("Cmd+B"))
            .on_press_tx(|s: &mut AppState, _| {
                s.shell_ui.left_overlay_open = !s.shell_ui.left_overlay_open;
                if s.shell_ui.left_overlay_open {
                    s.shell_ui.right_overlay_open = false;
                }
            })
            .build(k)
            .key("topbar-narrow-sidebar-toggle");
        toolbar = toolbar.leading(narrow_sidebar_btn);
    }

    if let Some(menu_strip) =
        super::menu_bar::build_menu_bar_strip(s, k, t, Some(primary_width), chrome.trailing)
    {
        toolbar = toolbar.leading(menu_strip).leading(
            el().w(1.0)
                .h(14.0)
                .mx(4.0)
                .fill(t.border_muted)
                .a11y_hidden(),
        );
    }

    if include_nav {
        for btn in build_nav_buttons(s, k) {
            toolbar = toolbar.leading(btn);
        }
    }
    toolbar = toolbar.leading(heading);

    if let Some(rt) = active_rt
        && let Some(usage) = &rt.usage
    {
        let usage_popover = build_usage_popover(s, rt, usage, k, t, layer);
        toolbar = toolbar.trailing(usage_popover);
    }

    let quick_chat_btn = IconButton::new(&icons::POPOUT)
        .variant(IconButtonVariant::GhostMuted)
        .control_size(ControlSize::Regular)
        .help("Quick Chat")
        .on_press_tx(|s: &mut AppState, _| {
            s.dispatch(Action::Shell(ShellAction::OpenQuickChatWindow));
        })
        .build(k)
        .key("topbar-quick-chat");

    let right_overlay_mode = super::state::right_rail_uses_overlay(s);
    let canvas_key = super::state::active_canvas_target_key(s);
    let canvas_active = canvas_key.is_some();
    let canvas_max = canvas_active && crate::views::chat::is_canvas_maximized(s);
    let inspector_open = if right_overlay_mode {
        super::state::is_right_overlay_visible(s)
    } else if canvas_active {
        s.shell_ui.canvas_pane.is_open()
    } else {
        s.context_sidebar.is_open()
    };
    let inspector_btn = IconButton::new(&shell::INSPECTOR)
        .variant(IconButtonVariant::GhostMuted)
        .control_size(ControlSize::Regular)
        .expanded(inspector_open && !canvas_max)
        .help(if canvas_active {
            if inspector_open {
                "Hide canvas"
            } else {
                "Show canvas"
            }
        } else if inspector_open {
            "Hide context sidebar"
        } else {
            "Show context sidebar"
        })
        .shortcut(crate::shortcut_label("Opt+Cmd+I"))
        .on_press_tx(move |s: &mut AppState, _| {
            if super::state::right_rail_uses_overlay(s) {
                let next_open = !super::state::is_right_overlay_visible(s);
                s.shell_ui.right_overlay_open = next_open;
                if next_open {
                    s.shell_ui.left_overlay_open = false;
                    s.shell_ui.canvas_overlay_dismissed_key = None;
                } else {
                    s.shell_ui.canvas_overlay_dismissed_key =
                        super::state::active_canvas_target_key(s);
                }
            } else if super::state::active_canvas_target_key(s).is_some() {
                s.shell_ui.canvas_pane.toggle();
            } else {
                s.dispatch(Action::Shell(ShellAction::ToggleContextSidebar));
            }
        })
        .build(k)
        .key("topbar-inspector-toggle");

    let settings_btn = IconButton::new(&icons::SETTINGS)
        .variant(IconButtonVariant::GhostMuted)
        .control_size(ControlSize::Regular)
        .help("Settings")
        .shortcut(crate::shortcut_label("Cmd+,"))
        .on_press_tx(|s: &mut AppState, tx| {
            s.dispatch_tx(Action::Navigate(NavAction::OpenSettings(None)), tx);
        })
        .build(k)
        .key("topbar-settings");

    toolbar = toolbar
        .trailing(quick_chat_btn)
        .trailing(inspector_btn)
        .trailing(settings_btn);

    append_caption_reserve(toolbar, chrome)
}

fn build_usage_popover(
    s: &AppState,
    rt: &ThreadRuntime,
    usage: &UsageSummary,
    k: &Kit,
    t: &ThemeTokens,
    layer: &mut Vec<El>,
) -> El {
    let total_tokens = usage.input_tokens + usage.output_tokens;
    let cost = format_cost_usd(usage.estimated_cost_usd);
    let label = if rt.usage_hard_cap_reached {
        format!("{cost} · {} tok · Cap", format_tokens(total_tokens))
    } else {
        format!("{cost} · {} tok", format_tokens(total_tokens))
    };

    let trigger = Button::new(label)
        .variant(if rt.usage_hard_cap_reached {
            ButtonVariant::Danger
        } else {
            ButtonVariant::Ghost
        })
        .control_size(ControlSize::Small)
        .on_press_tx(|s: &mut AppState, _| {
            s.shell_ui.usage_popover_open = !s.shell_ui.usage_popover_open;
        })
        .build(k)
        .key("topbar-usage-chip");

    let mut body = col()
        .w_full()
        .gap(8.0)
        .child(usage_row(
            "Session tokens",
            format!(
                "{} in · {} out",
                format_tokens(usage.input_tokens),
                format_tokens(usage.output_tokens)
            ),
            t,
        ))
        .child(usage_row(
            "Cached tokens",
            format_tokens(usage.cached_tokens),
            t,
        ))
        .child(usage_row(
            "Estimated cost",
            format_cost_usd(usage.estimated_cost_usd),
            t,
        ));

    if let Some(last_turn) = &rt.last_turn_usage {
        body = body.child(Divider::horizontal().build(k)).child(usage_row(
            "Last turn",
            format!(
                "{} · {} in / {} out",
                format_cost_usd(last_turn.estimated_cost_usd),
                format_tokens(last_turn.input_tokens),
                format_tokens(last_turn.output_tokens),
            ),
            t,
        ));
    }

    if !usage.by_model.is_empty() {
        let mut details = usage.by_model.values().collect::<Vec<_>>();
        details.sort_by(|a, b| {
            b.estimated_cost_usd
                .total_cmp(&a.estimated_cost_usd)
                .then_with(|| a.model.cmp(&b.model))
        });

        body = body.child(
            Button::new(if s.shell_ui.usage_more_details {
                "Hide model breakdown"
            } else {
                "Model breakdown"
            })
            .variant(ButtonVariant::Ghost)
            .control_size(ControlSize::Small)
            .on_press_tx(|s: &mut AppState, _| {
                s.shell_ui.usage_more_details = !s.shell_ui.usage_more_details;
            })
            .build(k)
            .key("usage-more-details-btn"),
        );

        if s.shell_ui.usage_more_details {
            let mut models_col = col().w_full().gap(4.0);
            for entry in details {
                let model_label = if entry.provider.is_empty() {
                    entry.model.clone()
                } else {
                    format!("{}:{}", entry.provider, entry.model)
                };
                models_col = models_col.child(
                    row()
                        .w_full()
                        .gap(8.0)
                        .center_y()
                        .child(
                            text(model_label)
                                .font(t.caption)
                                .color(t.text_base)
                                .truncate()
                                .grow(1.0)
                                .shrink(),
                        )
                        .child(
                            text(format!(
                                "{} · {}t",
                                format_cost_usd(entry.estimated_cost_usd),
                                entry.turns.max(1)
                            ))
                            .font(t.caption)
                            .color(t.text_muted),
                        ),
                );
            }
            body = body.child(models_col);
        }
    }

    if rt.usage_hard_cap_reached
        && let Some(thread_id) = s.route().active_thread_id.clone()
    {
        body = body.child(
            Button::new("Clear usage hard cap")
                .variant(ButtonVariant::Danger)
                .control_size(ControlSize::Small)
                .on_press_tx(move |s: &mut AppState, _| {
                    s.shell_ui.usage_popover_open = false;
                    s.dispatch(Action::Chat(ChatAction::ClearThreadUsageHardCap(
                        thread_id.clone(),
                    )));
                })
                .build(k)
                .key("topbar-clear-hard-cap"),
        );
    }

    Popover::new("topbar-usage-popover")
        .trigger(trigger)
        .title("Thread Usage")
        .placement(Placement::BottomEnd)
        .open(s.shell_ui.usage_popover_open)
        .on_close(|s: &mut AppState| {
            s.shell_ui.usage_popover_open = false;
        })
        .child(body)
        .build(k, layer)
}

fn usage_row(label: &str, value: String, t: &ThemeTokens) -> El {
    row()
        .w_full()
        .gap(12.0)
        .center_y()
        .child(text(label).font(t.caption).color(t.text_muted))
        .child(spacer())
        .child(text(value).font(t.caption).color(t.text_base))
}
