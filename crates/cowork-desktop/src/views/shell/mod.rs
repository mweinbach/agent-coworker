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
        build_workspace_split_frame(s, cx, k, t, subview.content)
    };

    rune_kit::root(base, overlays::build_overlays(s, k, t, subview.overlays))
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
) -> El {
    let sidebar_el = sidebar::build_sidebar(s, k, t);
    let inspector_el = context_sidebar::build_context_sidebar(s, k, t);
    let toolbar = top_bar::build_toolbar(s, cx, k, t);
    let primary_el = banners::build_primary_content(s, k, t, main_subview);

    SplitView::new(primary_el)
        .sidebar(&s.sidebar, |s: &mut AppState| &mut s.sidebar, sidebar_el)
        .inspector(
            &s.context_sidebar,
            |s: &mut AppState| &mut s.context_sidebar,
            inspector_el,
        )
        .toolbar(toolbar)
        .titlebar_inset(cx.titlebar_inset())
        .frame_inset(8.0)
        .toolbar_in_panel()
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
        .pane_motion(PaneMotion::new().spring(Spring::new(0.3, 0.0)))
        .sidebar_peek(SidebarPeek::new())
        .reduced_motion(s.desktop_settings.reduce_motion)
        .build(k)
}
