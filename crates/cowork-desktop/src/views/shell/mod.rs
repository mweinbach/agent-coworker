//! Desktop application shell: `SplitView`, sidebar, adaptive topbar, context inspector,
//! Command Palette, toasts/dialogs/onboarding overlays, task view, and compact shells.

pub mod banners;
pub mod context_sidebar;
pub mod helpers;
pub mod icons;
pub mod overlays;
pub mod palette;
pub mod sidebar;
pub mod state;
pub mod tasks;
pub mod top_bar;
pub mod windows;

pub use state::{ShellUiState, handle_key};

use rune::{Cx, El, Spring, col, el, row, spacer, text};
use rune_kit::shell::{PaneMotion, SidebarPeek, SidebarToggle, SplitView};
use rune_kit::{Button, ButtonVariant, ControlSize, Kit};

use crate::actions::{Action, NavAction};
use crate::router::ViewId;
use crate::state::{AppState, WindowMode};
use crate::theme::ThemeTokens;
use crate::views::SubviewOutput;

/// Root view of `cowork-desktop`, mounted by `lib.rs` inside the Rune window.
pub fn view(s: &AppState, cx: &mut Cx<AppState>, k: &Kit, t: &ThemeTokens) -> El {
    match s.window_mode {
        WindowMode::Utility => {
            let base = windows::build_utility_window(s, cx, k, t);
            return rune_kit::root(base, overlays::build_overlays(s, k, t, Vec::new()));
        }
        WindowMode::QuickChat => {
            let chat_out = crate::views::chat::view(s, cx, k);
            return windows::build_quick_chat_window(s, cx, k, t, chat_out);
        }
        WindowMode::Main => {}
    }

    let route = s.route().clone();
    let mut subview = match route.view {
        ViewId::Chat => crate::views::chat::view(s, cx, k),
        ViewId::Task => SubviewOutput {
            content: tasks::build_task_view(s, k, t),
            overlays: Vec::new(),
        },
        ViewId::Settings => crate::views::settings::view(s, cx, k),
    };

    if s.quick_chat_open {
        let qc_out = crate::views::chat::view(s, cx, k);
        if let Some(inline_quick_chat) =
            windows::build_inline_quick_chat_overlay(s, k, t, qc_out.content)
        {
            subview.overlays.push(inline_quick_chat);
        }
    }

    let base = if route.view == ViewId::Settings {
        build_settings_frame(s, cx, k, t, subview.content)
    } else {
        build_workspace_split_frame(s, cx, k, t, subview.content, &mut subview.overlays)
    };

    rune_kit::root(base, overlays::build_overlays(s, k, t, subview.overlays)).on_layout::<AppState>(
        |s, rect| {
            let width = rect[2];
            if width > 0.0 && (width - s.shell_ui.viewport_width).abs() > 1.0 {
                s.shell_ui.viewport_width = width;
                if width >= helpers::NARROW_BREAKPOINT {
                    s.shell_ui.left_overlay_open = false;
                    s.shell_ui.right_overlay_open = false;
                }
            }
        },
    )
}

fn build_settings_frame(
    _s: &AppState,
    cx: &mut Cx<AppState>,
    k: &Kit,
    t: &ThemeTokens,
    settings_content: El,
) -> El {
    let top_inset = cx.titlebar_inset().max(8.0);
    let lights_reserve = if top_inset > 20.0 { 92.0 } else { 12.0 };
    let trailing_reserve = cx.chrome_insets().trailing;

    let top_bar = row()
        .key("settings-shell-topbar")
        .w_full()
        .h(top_inset.max(48.0))
        .pl(lights_reserve)
        .pr(trailing_reserve + 12.0)
        .center_y()
        .gap(8.0)
        .fill(t.panel_bg)
        .child(
            Button::new("Back to workspace")
                .variant(ButtonVariant::Ghost)
                .control_size(ControlSize::Small)
                .icon(&icons::ARROW_LEFT)
                .on_press_tx(|s: &mut AppState, _| {
                    if s.nav.can_go_back() {
                        s.dispatch(Action::Navigate(NavAction::GoBack));
                    } else {
                        s.dispatch(Action::Navigate(NavAction::OpenView(ViewId::Chat)));
                    }
                })
                .build(k),
        )
        .child(spacer())
        .child(text("Settings").font(t.label).color(t.text_muted));

    col()
        .key("settings-shell-frame")
        .w_full()
        .h_full()
        .min_h(0.0)
        .fill(t.app_bg)
        .child(top_bar)
        .child(el().w_full().h(1.0).fill(t.border_muted))
        .child(
            el().grow(1.0)
                .shrink()
                .min_h(0.0)
                .w_full()
                .child(settings_content),
        )
}

fn build_workspace_split_frame(
    s: &AppState,
    cx: &mut Cx<AppState>,
    k: &Kit,
    t: &ThemeTokens,
    main_subview: El,
    layer: &mut Vec<El>,
) -> El {
    let sidebar_el = sidebar::build_sidebar(s, k, t, layer);
    let inspector_el = context_sidebar::build_context_sidebar(s, k, t);
    let toolbar = top_bar::build_toolbar(s, cx, k, t, layer);
    let primary_el = banners::build_primary_content(s, k, t, main_subview);

    let route_view = s.route().view;
    let right_kind = if route_view == ViewId::Task {
        helpers::RightRailKind::Task
    } else {
        helpers::RightRailKind::Context
    };
    let adaptive = helpers::resolve_adaptive_layout(
        s.shell_ui.viewport_width,
        s.sidebar.is_open(),
        s.sidebar.width(),
        route_view != ViewId::Settings,
        s.context_sidebar.is_open(),
        s.context_sidebar.width(),
        right_kind,
    );

    let mut split = SplitView::new(primary_el).toolbar(toolbar);

    if adaptive.left_overlay {
        if s.shell_ui.left_overlay_open {
            layer.push(
                col()
                    .key("adaptive-left-drawer-backdrop")
                    .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
                    .fill(t.scrim)
                    .items_start()
                    .modal(true, |s: &mut AppState| {
                        s.shell_ui.left_overlay_open = false;
                    })
                    .child(
                        el().key("adaptive-left-drawer-panel")
                            .w(280.0)
                            .h_full()
                            .min_h(0.0)
                            .pt(cx.titlebar_inset())
                            .fill(t.popover_bg)
                            .border(1.0, t.border_strong)
                            .child(sidebar_el),
                    ),
            );
        }
    } else {
        split = split
            .sidebar(&s.sidebar, |s: &mut AppState| &mut s.sidebar, sidebar_el)
            .sidebar_padding(12.0, 8.0)
            .sidebar_toggle(
                SidebarToggle::new()
                    .size(ControlSize::Large)
                    .past_lights(16.0)
                    .edge(18.0)
                    .gap(4.0)
                    .in_header()
                    .unread(helpers::any_background_unread(s)),
            )
            .sidebar_peek(SidebarPeek::new());
    }

    if adaptive.tier == helpers::AdaptiveTier::Narrow || adaptive.right_overlay {
        if s.shell_ui.right_overlay_open {
            layer.push(
                col()
                    .key("adaptive-right-drawer-backdrop")
                    .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
                    .fill(t.scrim)
                    .items_end()
                    .modal(true, |s: &mut AppState| {
                        s.shell_ui.right_overlay_open = false;
                    })
                    .child(
                        el().key("adaptive-right-drawer-panel")
                            .w(300.0)
                            .h_full()
                            .min_h(0.0)
                            .pt(cx.titlebar_inset())
                            .fill(t.popover_bg)
                            .border(1.0, t.border_strong)
                            .child(inspector_el),
                    ),
            );
        }
    } else {
        split = split.inspector(
            &s.context_sidebar,
            |s: &mut AppState| &mut s.context_sidebar,
            inspector_el,
        );
    }

    split
        .titlebar_inset(cx.titlebar_inset())
        .frame_inset(8.0)
        .toolbar_in_panel()
        .pane_motion(PaneMotion::new().spring(Spring::new(0.3, 0.0)))
        .reduced_motion(s.desktop_settings.reduce_motion)
        .build(k)
}
