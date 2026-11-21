//! Desktop application shell: `SplitView`, sidebar, adaptive topbar, context inspector,
//! Command Palette, toasts/dialogs/onboarding overlays, task view, and compact shells.

pub mod banners;
pub mod context_sidebar;
pub mod helpers;
pub mod icons;
pub mod menu_bar;
pub mod onboarding;
pub mod overlays;
pub mod palette;
pub mod sidebar;
pub mod split_frame;
pub mod state;
pub mod tasks;
pub mod top_bar;
pub mod windows;

pub use state::{ShellUiState, handle_key};

use rune::{Cx, El, Spring, col, el};
use rune_kit::Kit;

use crate::router::ViewId;
use crate::state::{AppState, WindowMode};
use crate::theme::ThemeTokens;
use split_frame::FullBleedSplit;

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
        WindowMode::Main => {
            let tb_height = crate::theme::layout::SHELL_TOOLBAR_HEIGHT * s.ui_scale;
            let tl_y = ((tb_height - 14.0) / 2.0).max(0.0).round();
            cx.set_titlebar(rune::Titlebar::new(tb_height).traffic_lights(16.0, tl_y));
        }
    }

    let route = s.route().clone();
    let mut layer = Vec::new();
    let base = match route.view {
        ViewId::Settings => {
            let layout = crate::views::settings::build_layout(s, cx, k, t);
            build_settings_frame(s, cx, k, t, layout, &mut layer)
        }
        ViewId::Chat => {
            let subview = crate::views::chat::view(s, cx, k);
            layer.extend(subview.overlays);
            build_workspace_split_frame(s, cx, k, t, subview.content, &mut layer)
        }
        ViewId::Task => {
            let content = tasks::build_task_view(s, cx, k, t, &mut layer);
            build_workspace_split_frame(s, cx, k, t, content, &mut layer)
        }
    };

    rune_kit::root(base, overlays::build_overlays(s, k, t, layer)).on_layout::<AppState>(
        |s, rect| {
            let width = rect[2];
            if width > 0.0 && (width - s.shell_ui.viewport_width).abs() > 1.0 {
                s.shell_ui.viewport_width = width;
                if width >= helpers::NARROW_BREAKPOINT {
                    s.shell_ui.left_overlay_open = false;
                    s.settings_ui.mobile_nav_open = false;
                }
                if !state::right_rail_uses_overlay(s) {
                    s.shell_ui.right_overlay_open = false;
                }
            }
            let next_canvas_key = state::active_canvas_target_key(s);
            if next_canvas_key != s.shell_ui.last_canvas_key {
                s.shell_ui.last_canvas_key = next_canvas_key.clone();
                s.shell_ui.canvas_overlay_dismissed_key = None;
                if next_canvas_key.is_some() {
                    s.shell_ui.canvas_pane.set_open(true);
                }
            }
        },
    )
}

/// Tint alpha over the sidebar's native vibrancy material, or `None` for an opaque sidebar.
///
/// Only macOS composites a material behind the window (Rune's `El::system_material`), and only
/// when the main window was created transparent (`native::main_window_uses_vibrancy`). Reduce
/// Transparency, high contrast and the `COWORK_MACOS_NATIVE_GLASS=0` opt-out keep it opaque.
pub(crate) fn sidebar_vibrancy_alpha(s: &AppState, t: &ThemeTokens) -> Option<f32> {
    if !crate::native::main_window_uses_vibrancy()
        || s.desktop_settings.reduced_transparency
        || s.desktop_settings.high_contrast
        || s.scene_mode
    {
        return None;
    }
    Some(if t.dark {
        crate::theme::layout::SIDEBAR_TINT_ALPHA_DARK
    } else {
        crate::theme::layout::SIDEBAR_TINT_ALPHA_LIGHT
    })
}

fn push_left_drawer_overlay(
    layer: &mut Vec<El>,
    chrome: rune::ChromeInsets,
    leading_lights: f32,
    t: &ThemeTokens,
    sidebar_el: El,
    on_close: fn(&mut AppState),
) {
    let left_drawer_top = if leading_lights > 0.0 {
        chrome
            .height
            .max(crate::theme::layout::SHELL_TOOLBAR_HEIGHT)
    } else {
        0.0
    };
    layer.push(
        col()
            .key("adaptive-left-drawer-backdrop")
            .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
            .fill(t.scrim)
            .items_start()
            .modal(true, on_close)
            .child(
                el().key("adaptive-left-drawer-panel")
                    .w(280.0)
                    .h_full()
                    .min_h(0.0)
                    .pt(left_drawer_top)
                    .fill(t.popover_bg)
                    .child(sidebar_el)
                    .child(
                        el().key("adaptive-left-drawer-divider")
                            .pin(None, Some(0.0), Some(0.0), Some(0.0))
                            .w(1.0)
                            .fill(t.border_strong)
                            .a11y_hidden(),
                    ),
            ),
    );
}

/// Resolves adaptive split-shell layout using identical right-rail and pane rules across frame builders and key handlers.
pub(super) fn resolve_shell_adaptive_layout(
    s: &AppState,
    canvas_active: bool,
) -> helpers::AdaptiveLayout {
    let route_view = s.route().view;
    if route_view == ViewId::Settings {
        return helpers::resolve_adaptive_layout(
            s.shell_ui.viewport_width,
            true,
            s.settings_ui.nav_pane.width(),
            false,
            false,
            0.0,
            helpers::RightRailKind::Context,
        );
    }

    let canvas_maximized = canvas_active && crate::views::chat::is_canvas_maximized(s);
    let right_kind = if canvas_active {
        helpers::RightRailKind::Canvas
    } else if route_view == ViewId::Task {
        helpers::RightRailKind::Task
    } else {
        helpers::RightRailKind::Context
    };
    let right_open = if canvas_active {
        !canvas_maximized && s.shell_ui.canvas_pane.is_open()
    } else {
        s.context_sidebar.is_open()
    };
    let right_width_pref = if canvas_active {
        s.shell_ui.canvas_pane.width()
    } else {
        s.context_sidebar.width()
    };
    helpers::resolve_adaptive_layout(
        s.shell_ui.viewport_width,
        s.sidebar.is_open(),
        s.sidebar.width(),
        !canvas_maximized,
        right_open,
        right_width_pref,
        right_kind,
    )
}

fn build_settings_frame(
    s: &AppState,
    cx: &mut Cx<AppState>,
    k: &Kit,
    t: &ThemeTokens,
    layout: crate::views::settings::SettingsLayout,
    layer: &mut Vec<El>,
) -> El {
    let chrome = cx.chrome_insets();
    let leading_lights = chrome.leading.max(cx.titlebar_inset());
    layer.extend(layout.overlays);
    let adaptive = resolve_shell_adaptive_layout(s, false);
    let narrow = adaptive.left_overlay;
    let toolbar = top_bar::build_settings_toolbar(
        s,
        cx,
        k,
        t,
        narrow,
        adaptive.primary_width,
        &layout.title,
        layout.workspace_badge.as_deref(),
        layout.header_actions,
    );

    let mut split = FullBleedSplit::new(layout.main).toolbar(toolbar);
    if narrow {
        if s.settings_ui.mobile_nav_open {
            push_left_drawer_overlay(layer, chrome, leading_lights, t, layout.sidebar, |s| {
                s.settings_ui.mobile_nav_open = false;
            });
        }
    } else {
        split = split
            .sidebar(
                &s.settings_ui.nav_pane,
                s.shell_ui.sidebar_resize_start_width.is_some(),
                |s: &mut AppState| &mut s.settings_ui.nav_pane,
                |s: &mut AppState| &mut s.shell_ui.sidebar_resize_start_width,
                layout.sidebar,
            )
            .sidebar_padding(4.0, 4.0);
    }

    menu_bar::push_menu_bar_overlay(
        s,
        k,
        t,
        Some(adaptive.primary_width),
        chrome.trailing,
        layer,
    );

    // Keep the shared `"shell"` key from `FullBleedSplit::build` so swapping between workspace
    // views and Settings preserves the opaque main column and native vibrancy sidebar slot
    // without unmounting or crossfading the entire window frame.
    split
        .hide_sidebar_toggle()
        .titlebar_inset(leading_lights)
        .sidebar_vibrancy(sidebar_vibrancy_alpha(s, t))
        .spring(Spring::new(0.3, 0.0))
        .reduced_motion(s.desktop_settings.reduce_motion)
        .build(k)
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
    let (canvas_content, canvas_overlays) = match crate::views::chat::canvas_pane(s, cx, k) {
        Some(out) => (Some(out.content), out.overlays),
        None => (None, Vec::new()),
    };
    let canvas_active = canvas_content.is_some();
    let canvas_maximized = canvas_active && crate::views::chat::is_canvas_maximized(s);
    layer.extend(canvas_overlays);

    let adaptive = resolve_shell_adaptive_layout(s, canvas_active);

    // Back and forward live beside the sidebar toggle unless the sidebar is a drawer.
    let toolbar = top_bar::build_toolbar(
        s,
        cx,
        k,
        t,
        adaptive.primary_width,
        adaptive.left_overlay,
        layer,
    );
    let (primary_el, right_panel_el) = if canvas_maximized {
        (
            el().key("primary-canvas-maximized")
                .w_full()
                .h_full()
                .grow(1.0)
                .shrink()
                .min_h(0.0)
                .children(canvas_content),
            None,
        )
    } else {
        let primary = banners::build_primary_content(s, k, t, main_subview, canvas_active);
        let right = canvas_content
            .unwrap_or_else(|| context_sidebar::build_context_sidebar(s, k, t, layer));
        (primary, Some(right))
    };

    let mut split = FullBleedSplit::new(primary_el).toolbar(toolbar);
    let chrome = cx.chrome_insets();
    let leading_lights = chrome.leading.max(cx.titlebar_inset());
    let right_drawer_top = if chrome.trailing > 0.0 {
        chrome.height
    } else {
        0.0
    };

    if adaptive.left_overlay {
        if s.shell_ui.left_overlay_open {
            push_left_drawer_overlay(layer, chrome, leading_lights, t, sidebar_el, |s| {
                s.shell_ui.left_overlay_open = false;
            });
        }
    } else {
        split = split
            .sidebar(
                &s.sidebar,
                s.shell_ui.sidebar_resize_start_width.is_some(),
                |s: &mut AppState| &mut s.sidebar,
                |s: &mut AppState| &mut s.shell_ui.sidebar_resize_start_width,
                sidebar_el,
            )
            .sidebar_padding(4.0, 4.0)
            .sidebar_nav(top_bar::build_nav_buttons(s, k))
            .unread(helpers::any_background_unread(s))
            .toggle_shortcut(crate::shortcut_label("Cmd+Shift+B"));
    }

    if let Some(right_panel_el) = right_panel_el {
        if adaptive.tier == helpers::AdaptiveTier::Narrow || adaptive.right_overlay {
            let show_overlay = if canvas_active {
                state::is_right_overlay_visible(s)
            } else {
                s.shell_ui.right_overlay_open
            };
            if show_overlay {
                let drawer_width = if canvas_active {
                    s.shell_ui
                        .canvas_pane
                        .width()
                        .clamp(320.0, (s.shell_ui.viewport_width - 24.0).max(320.0))
                } else {
                    300.0
                };
                let dismiss_canvas_key = state::active_canvas_target_key(s);
                layer.push(
                    col()
                        .key("adaptive-right-drawer-backdrop")
                        .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
                        .fill(t.scrim)
                        .items_end()
                        .modal(true, move |s: &mut AppState| {
                            s.shell_ui.right_overlay_open = false;
                            if dismiss_canvas_key.is_some() {
                                s.shell_ui.canvas_overlay_dismissed_key =
                                    dismiss_canvas_key.clone();
                            }
                        })
                        .child(
                            el().key("adaptive-right-drawer-panel")
                                .w(drawer_width)
                                .h_full()
                                .min_h(0.0)
                                .pt(right_drawer_top)
                                .fill(t.popover_bg)
                                .child(right_panel_el)
                                .child(
                                    el().key("adaptive-right-drawer-divider")
                                        .pin(Some(0.0), Some(0.0), None, Some(0.0))
                                        .w(1.0)
                                        .fill(t.border_strong)
                                        .a11y_hidden(),
                                ),
                        ),
                );
            }
        } else if canvas_active {
            split = split.inspector(
                &s.shell_ui.canvas_pane,
                s.shell_ui.inspector_resize_start_width.is_some(),
                |s: &mut AppState| &mut s.shell_ui.canvas_pane,
                |s: &mut AppState| &mut s.shell_ui.inspector_resize_start_width,
                right_panel_el,
            );
        } else {
            split = split.inspector(
                &s.context_sidebar,
                s.shell_ui.inspector_resize_start_width.is_some(),
                |s: &mut AppState| &mut s.context_sidebar,
                |s: &mut AppState| &mut s.shell_ui.inspector_resize_start_width,
                right_panel_el,
            );
        }
    }

    menu_bar::push_menu_bar_overlay(
        s,
        k,
        t,
        Some(adaptive.primary_width),
        chrome.trailing,
        layer,
    );

    split
        .titlebar_inset(leading_lights)
        .sidebar_vibrancy(sidebar_vibrancy_alpha(s, t))
        .spring(Spring::new(0.3, 0.0))
        .reduced_motion(s.desktop_settings.reduce_motion)
        .build(k)
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use rune::{Env, Runtime};

    use super::*;
    use crate::actions::{Action, ShellAction};
    use crate::state::{ConfirmDialogRequest, FilePreviewState};
    use crate::theme;

    fn test_shell_root(state: &AppState, cx: &mut Cx<AppState>) -> El {
        cx.zoom(state.ui_scale);
        let dark = state.effective_dark(cx.system_dark());
        let (kit, tokens) = theme::build_kit_with_accent(
            dark,
            state.desktop_settings.reduced_transparency,
            state.desktop_settings.high_contrast,
            state.desktop_settings.accent_palette,
        );
        cx.foreground(tokens.text_base);
        cx.focus_ring(2.0, 2.5, tokens.focus_ring);
        cx.web_focus();
        view(state, cx, &kit, &tokens)
    }

    #[test]
    fn task_tabs_open_and_create_sessions_inside_the_task_conversation() {
        use crate::actions::{NavAction, StoreEvent};
        use crate::state::WorkspaceRecord;
        use crate::ws::WsCommand;
        use serde_json::json;

        let mut s = AppState {
            scene_mode: true,
            ..Default::default()
        };
        s.onboarding.completed = true;
        s.workspaces.push(WorkspaceRecord::new(
            "project",
            "Project",
            "/tmp/project",
            1,
        ));
        s.active_workspace_id = Some("project".into());
        s.dispatch(Action::Navigate(NavAction::OpenTask("task".into())));
        let mut task = json!({
            "id": "task", "title": "Review", "status": "working", "revision": 1,
            "threads": [
                {"id": "link-a", "sessionId": "session-a", "title": "Main"},
                {"id": "link-b", "sessionId": "session-b", "title": "Review"}
            ]
        });
        let response = |method: &str, result| StoreEvent::WsResponse {
            workspace_id: "project".into(),
            request_id: 91,
            method: method.into(),
            result: Ok(result),
        };
        s.apply_store_event(response("task/read", json!({"task": task})));
        s.apply_store_event(response(
            "thread/hydrate",
            json!({
                "coworkSnapshot": {"sessionId": "session-a", "feed": [
                    {"id":"answer", "kind":"assistant", "content":"Task transcript"}
                ]}
            }),
        ));
        let mut rt = Runtime::new(s, test_shell_root, (1440.0, 820.0), Env::new(true, 1.0));
        rt.frame(0.0);
        rt.settle_all();
        assert_eq!(
            rt.state.route().active_thread_id.as_deref(),
            Some("session-a")
        );
        assert!(rt.find("chat-feed-frame").is_some());
        assert!(rt.find("composer-input").is_some());
        let (header, _) = rt.presented("task-workspace-header").unwrap();
        let (transcript, _) = rt.presented("chat-view").unwrap();
        assert!(
            transcript[1] - (header[1] + header[3]) <= 40.0,
            "the conversation tabs must leave the rest of the pane to the transcript"
        );
        rt.set_viewport((840.0, 560.0), 1.0);
        rt.frame(0.0);
        rt.settle_all();
        let (all_tasks, _) = rt.presented("task-all-tasks").unwrap();
        assert!(all_tasks[0] + all_tasks[2] <= 840.0);
        let (x, y) = rt
            .find("t-session-b")
            .expect("second task conversation tab");
        rt.pointer_move(x, y);
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(0.0);
        assert_eq!(rt.state.route().view, ViewId::Task);
        assert_eq!(
            rt.state.route().active_thread_id.as_deref(),
            Some("session-b")
        );
        assert!(rt.state.services.emitted_ws_commands.iter().any(|cmd| matches!(cmd,
            WsCommand::SendRequest { method, workspace_id, params, .. }
            if method == "thread/hydrate" && workspace_id == "project" && params["threadId"] == "session-b"
        )));

        task["threads"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id": "link-c", "sessionId": "session-c", "title": "Follow-up"}));
        rt.state.apply_store_event(response(
            "task/thread/create",
            json!({"task": task, "thread": {"id": "session-c"}}),
        ));
        rt.state
            .apply_store_event(response("thread/list", json!({"threads": []})));
        assert_eq!(rt.state.route().active_task_id.as_deref(), Some("task"));
        assert_eq!(rt.state.active_thread().unwrap().id, "session-c");
        assert!(
            rt.state
                .threads
                .iter()
                .all(|thread| !thread.is_standard_chat())
        );
        task["status"] = json!("failed");
        rt.update(|state, _| {
            state.apply_store_event(StoreEvent::WsNotification {
                workspace_id: "project".into(),
                method: "task/updated".into(),
                params: json!({"task": task}),
            })
        });
        rt.frame(0.0);
        rt.settle_all();
        assert!(rt.find("task-conversation-read-only").is_some());
        assert!(rt.find("composer-input").is_none());
    }

    #[test]
    fn project_disclosure_preserves_draft_and_selection_targets_its_own_chat_or_landing() {
        use crate::actions::NavAction;
        use crate::state::{ThreadRecord, WorkspaceRecord};

        let mut s = AppState {
            scene_mode: true,
            ..Default::default()
        };
        s.onboarding.completed = true;
        for id in ["alpha", "beta", "empty"] {
            s.workspaces
                .push(WorkspaceRecord::new(id, id, format!("/tmp/{id}"), 1));
        }
        for (id, workspace, updated_at) in [
            ("current", "alpha", 1),
            ("other", "alpha", 2),
            ("older", "beta", 3),
            ("recent", "beta", 4),
            ("archived", "beta", 5),
            ("task", "beta", 6),
        ] {
            s.threads.push(ThreadRecord {
                id: id.into(),
                workspace_id: workspace.into(),
                title: id.into(),
                updated_at,
                archived: id == "archived",
                source_task_id: (id == "task").then(|| "task-id".into()),
                ..Default::default()
            });
        }
        s.dispatch(Action::Navigate(NavAction::OpenThread("current".into())));
        s.composer_edit = rune::TextEdit::new("Unsent in alpha");
        let mut rt = Runtime::new(s, test_shell_root, (1280.0, 820.0), Env::new(true, 1.0));
        rt.frame(0.0);
        let click = |rt: &mut Runtime<AppState>, key: &str| {
            let (x, y) = rt.find(key).unwrap_or_else(|| panic!("missing {key}"));
            rt.pointer_move(x, y);
            rt.pointer_down(x, y);
            rt.pointer_up(x, y);
            rt.frame(0.0);
            rt.settle_all();
        };
        click(&mut rt, "ws-toggle-beta");
        assert!(rt.state.collapsed_workspace_ids.contains("beta"));
        assert_eq!(rt.state.active_workspace_id.as_deref(), Some("alpha"));
        assert_eq!(rt.state.composer_edit.text, "Unsent in alpha");
        click(&mut rt, "ws-alpha");
        assert_eq!(
            rt.state.route().active_thread_id.as_deref(),
            Some("current")
        );
        click(&mut rt, "ws-beta");
        assert_eq!(rt.state.route().active_thread_id.as_deref(), Some("recent"));
        assert_eq!(rt.state.active_workspace_id.as_deref(), Some("beta"));
        assert!(rt.state.collapsed_workspace_ids.contains("beta"));
        assert!(rt.state.services.emitted_native_commands.iter().any(|command| matches!(
            command, crate::actions::NativeCommand::StartWorkspaceServer { workspace_id, .. } if workspace_id == "beta"
        )));
        assert_eq!(rt.state.composer_drafts["current"].text, "Unsent in alpha");
        click(&mut rt, "ws-empty");
        assert!(rt.state.route().active_thread_id.is_none());
        assert_eq!(rt.state.landing_workspace_id.as_deref(), Some("empty"));
        assert_eq!(rt.state.threads.len(), 6);
    }

    #[test]
    fn settings_mounts_inside_unified_split_frame_with_toolbar_and_narrow_drawer() {
        use crate::actions::{Action, NavAction};
        use crate::router::{SettingsPageId, ViewId};
        use rune::{Env, Key, KeyEvent, Mods, Runtime, Tx};

        let mut s = AppState {
            scene_mode: true,
            ..Default::default()
        };
        s.onboarding.completed = true;
        s.dispatch(Action::Navigate(NavAction::OpenSettings(Some(
            SettingsPageId::Models,
        ))));
        s.shell_ui.viewport_width = 1280.0;

        let mut rt = Runtime::new(s, test_shell_root, (1280.0, 820.0), Env::new(true, 1.0));
        let mut mac_insets = rune::ChromeInsets::default();
        mac_insets.leading = 72.0;
        mac_insets.height = 38.0;
        rt.set_titlebar_inset(72.0);
        rt.set_chrome_insets(mac_insets);
        rt.frame(0.0);

        let (rail_rect, _) = rt
            .presented("settings-nav-rail")
            .expect("settings nav rail should mount inline on wide viewport");
        let (heading_rect, _) = rt
            .presented("settings-toolbar-heading")
            .expect("settings toolbar heading should mount");
        let (main_rect, _) = rt
            .presented("settings-main-pane")
            .expect("settings main pane should mount");
        assert!(
            rail_rect[1] >= 38.0,
            "settings nav rail must clear 38pt traffic light chrome, got y={}",
            rail_rect[1]
        );
        assert!(
            heading_rect[0] >= rail_rect[0] + rail_rect[2] && heading_rect[1] <= 56.0,
            "settings heading should sit in top panel toolbar right of nav rail, got {heading_rect:?}"
        );
        assert!(
            main_rect[0] >= rail_rect[0] + rail_rect[2],
            "settings main pane must sit right of nav rail"
        );

        // Windows/Linux trailing caption reserve keeps page header actions clear of caption buttons.
        let mut win_s = AppState {
            scene_mode: true,
            ..Default::default()
        };
        win_s.onboarding.completed = true;
        win_s.dispatch(Action::Navigate(NavAction::OpenSettings(Some(
            SettingsPageId::Models,
        ))));
        win_s.shell_ui.viewport_width = 1280.0;
        let mut win_rt = Runtime::new(win_s, test_shell_root, (1280.0, 820.0), Env::new(true, 1.0));
        let mut win_insets = rune::ChromeInsets::default();
        win_insets.trailing = 136.0;
        win_insets.height = 38.0;
        win_rt.set_titlebar_inset(0.0);
        win_rt.set_chrome_insets(win_insets);
        win_rt.frame(0.0);
        let (reserve_rect, _) = win_rt
            .presented("topbar-caption-reserve")
            .expect("Windows/Linux caption reserve must mount when chrome.trailing > 0");
        assert!(
            reserve_rect[2] >= 135.0
                && reserve_rect[0] >= 1100.0
                && reserve_rect[0] + reserve_rect[2] <= 1280.0,
            "caption reserve must occupy trailing edge without overflow, got {reserve_rect:?}"
        );

        // Narrow viewport (< 720px) collapses nav rail behind narrow drawer toggle & Cmd+B / Escape.
        let mut narrow_s = AppState {
            scene_mode: true,
            ..Default::default()
        };
        narrow_s.onboarding.completed = true;
        narrow_s.dispatch(Action::Navigate(NavAction::OpenSettings(Some(
            SettingsPageId::Models,
        ))));
        narrow_s.shell_ui.viewport_width = 640.0;
        let mut narrow_rt = Runtime::new(
            narrow_s,
            test_shell_root,
            (640.0, 820.0),
            Env::new(true, 1.0),
        );
        narrow_rt.set_titlebar_inset(72.0);
        narrow_rt.set_chrome_insets(mac_insets);
        narrow_rt.frame(0.0);
        assert!(
            narrow_rt.presented("settings-nav-rail").is_none(),
            "nav rail must collapse off-canvas below narrow breakpoint"
        );
        let (toggle_rect, _) = narrow_rt
            .presented("topbar-narrow-settings-nav-toggle")
            .expect("narrow settings drawer toggle must render");
        assert!(
            toggle_rect[0] >= 72.0 && toggle_rect[0] <= 112.0,
            "narrow settings drawer toggle should clear traffic lights without double-padding, got x={}",
            toggle_rect[0]
        );

        narrow_rt.pointer_move(
            toggle_rect[0] + toggle_rect[2] * 0.5,
            toggle_rect[1] + toggle_rect[3] * 0.5,
        );
        narrow_rt.pointer_down(
            toggle_rect[0] + toggle_rect[2] * 0.5,
            toggle_rect[1] + toggle_rect[3] * 0.5,
        );
        narrow_rt.pointer_up(
            toggle_rect[0] + toggle_rect[2] * 0.5,
            toggle_rect[1] + toggle_rect[3] * 0.5,
        );
        narrow_rt.frame(0.0);
        assert!(narrow_rt.state.settings_ui.mobile_nav_open);
        assert!(
            narrow_rt.presented("adaptive-left-drawer-panel").is_some()
                && narrow_rt.presented("settings-nav-rail").is_some(),
            "toggling narrow settings button must present nav rail in drawer overlay"
        );

        let esc = KeyEvent {
            key: Key::Escape,
            mods: Mods::default(),
        };
        let mut tx = Tx::default();
        assert!(handle_key(&mut narrow_rt.state, &esc, &mut tx));
        assert!(!narrow_rt.state.settings_ui.mobile_nav_open);
        assert_eq!(narrow_rt.state.route().view, ViewId::Settings);

        let cmd_b = KeyEvent {
            key: Key::Command('b'),
            mods: Mods {
                cmd: true,
                ..Default::default()
            },
        };
        assert!(handle_key(&mut narrow_rt.state, &cmd_b, &mut tx));
        assert!(narrow_rt.state.settings_ui.mobile_nav_open);
        assert!(handle_key(&mut narrow_rt.state, &esc, &mut tx));
        assert!(!narrow_rt.state.settings_ui.mobile_nav_open);
        assert!(handle_key(&mut narrow_rt.state, &esc, &mut tx));
        assert_eq!(narrow_rt.state.route().view, ViewId::Chat);
    }

    #[test]
    fn narrow_toolbar_toggle_clears_leading_insets_without_double_padding() {
        use rune::{Env, Runtime};

        let mut s = AppState {
            scene_mode: true,
            ..Default::default()
        };
        s.onboarding.completed = true;
        s.shell_ui.viewport_width = 640.0;

        let mut rt = Runtime::new(s, test_shell_root, (640.0, 820.0), Env::new(true, 1.0));
        let mut insets = rune::ChromeInsets::default();
        insets.leading = 72.0;
        insets.height = 38.0;
        rt.set_titlebar_inset(72.0);
        rt.set_chrome_insets(insets);
        rt.frame(0.0);

        let (toggle_rect, _) = rt
            .presented("topbar-narrow-sidebar-toggle")
            .expect("narrow sidebar toggle should render in narrow shell");
        assert!(
            toggle_rect[0] >= 72.0 && toggle_rect[0] <= 112.0,
            "narrow toggle should clear traffic lights via SplitView titlebar_inset without double-padding, got x={}",
            toggle_rect[0]
        );
    }

    #[test]
    fn canvas_mounts_in_right_rail_suppresses_inline_preview_and_supports_maximize() {
        let mut s = AppState {
            scene_mode: true,
            ..Default::default()
        };
        s.onboarding.completed = true;
        s.feature_flags.insert("canvas".into(), true);
        s.dispatch(Action::Shell(ShellAction::OpenFilePreview(
            FilePreviewState {
                workspace_id: "ws-1".into(),
                path: "/tmp/ws-1/notes.md".into(),
                title: "notes.md".into(),
                content: Some("# Heading\n\nBody copy".into()),
                is_markdown: true,
                ..Default::default()
            },
        )));

        let mut rt = Runtime::new(s, test_shell_root, (1280.0, 820.0), Env::new(true, 1.0));
        rt.frame(0.0);
        assert!(
            rt.find("canvas-pane").is_some(),
            "Canvas pane should mount in the right rail when canvas flag is true"
        );
        assert!(
            rt.find("primary-split-with-preview").is_none(),
            "Inline split preview must stay hidden while Canvas handles the document"
        );

        let (mx, my) = rt
            .find("canvas-maximize-btn")
            .expect("canvas maximize button should be mounted");
        rt.pointer_move(mx, my);
        rt.pointer_down(mx, my);
        rt.pointer_up(mx, my);
        rt.frame(0.0);
        assert!(
            rt.find("primary-canvas-maximized").is_some(),
            "Maximizing Canvas should expand into primary-canvas-maximized"
        );
        assert!(rt.find("canvas-pane").is_some());
    }

    #[test]
    fn canvas_mounts_as_compact_overlay_below_full_breakpoint() {
        let mut s = AppState {
            scene_mode: true,
            ..Default::default()
        };
        s.onboarding.completed = true;
        s.shell_ui.viewport_width = 900.0;
        s.feature_flags.insert("canvas".into(), true);
        s.dispatch(Action::Shell(ShellAction::OpenFilePreview(
            FilePreviewState {
                workspace_id: "ws-1".into(),
                path: "/tmp/ws-1/notes.md".into(),
                title: "notes.md".into(),
                content: Some("# Compact\n\nOverlay canvas".into()),
                is_markdown: true,
                ..Default::default()
            },
        )));

        let mut rt = Runtime::new(s, test_shell_root, (900.0, 700.0), Env::new(true, 1.0));
        rt.frame(0.0);
        assert!(
            rt.find("adaptive-right-drawer-panel").is_some(),
            "Compact viewport should host Canvas inside adaptive-right-drawer-panel"
        );
        assert!(rt.find("canvas-pane").is_some());
    }

    #[test]
    fn spreadsheet_preview_mounts_in_inline_split_even_with_canvas_flag_enabled() {
        let spreadsheet = crate::views::preview::decode_spreadsheet_preview(
            Path::new("budget.csv"),
            b"item,cost\nCoffee,4\nTea,3\n",
            false,
        )
        .expect("csv should decode cleanly");

        let mut s = AppState {
            scene_mode: true,
            ..Default::default()
        };
        s.onboarding.completed = true;
        s.feature_flags.insert("canvas".into(), true);
        s.dispatch(Action::Shell(ShellAction::OpenFilePreview(
            FilePreviewState {
                workspace_id: "ws-1".into(),
                path: "/tmp/ws-1/budget.csv".into(),
                title: "budget.csv".into(),
                content: Some("item,cost\nCoffee,4\nTea,3\n".into()),
                spreadsheet: Some(spreadsheet),
                ..Default::default()
            },
        )));

        let mut rt = Runtime::new(s, test_shell_root, (1280.0, 820.0), Env::new(true, 1.0));
        rt.frame(0.0);
        assert!(rt.find("primary-split-with-preview").is_some());
        assert!(rt.find("spreadsheet-preview-root").is_some());
        assert!(rt.find("canvas-pane").is_none());
    }

    #[test]
    fn quick_chat_window_mounts_shell_overlays_for_confirm_dialog() {
        let mut s = AppState {
            scene_mode: true,
            window_mode: WindowMode::QuickChat,
            pending_confirm_dialog: Some(ConfirmDialogRequest {
                id: "qc-confirm-1".into(),
                title: "Open launchable file?".into(),
                message: "Proceed outside sandbox?".into(),
                confirm_label: "Open Anyway".into(),
                cancel_label: "Cancel".into(),
                destructive: true,
            }),
            ..Default::default()
        };
        s.onboarding.completed = true;

        let mut rt = Runtime::new(s, test_shell_root, (440.0, 560.0), Env::new(true, 1.0));
        rt.frame(0.0);
        assert!(rt.find("quick-chat-shell").is_some());
        assert!(rt.find("shell-confirm-dialog-dialog").is_some());
    }

    #[test]
    fn move_to_trash_confirmation_dialog_mounts_and_resolves_full_path() {
        let mut s = AppState {
            scene_mode: true,
            ..Default::default()
        };
        s.onboarding.completed = true;
        s.workspaces.push(crate::state::WorkspaceRecord {
            id: "ws-1".into(),
            name: "Demo".into(),
            path: "/tmp/demo-ws".into(),
            ..Default::default()
        });
        s.shell_ui.pending_trash_entry = Some(state::PendingTrashEntry {
            workspace_id: "ws-1".into(),
            path: "src/notes.md".into(),
            name: "notes.md".into(),
            is_dir: false,
        });

        let mut rt = Runtime::new(s, test_shell_root, (1280.0, 820.0), Env::new(true, 1.0));
        rt.frame(0.0);
        assert!(
            rt.find("trash-entry-dialog-dialog").is_some(),
            "Move to Trash confirmation dialog should mount before trashing"
        );
        let (tx, ty) = rt
            .find("trash-entry-confirm-btn")
            .expect("Move to Trash confirm button should be mounted");
        rt.pointer_move(tx, ty);
        rt.pointer_down(tx, ty);
        rt.pointer_up(tx, ty);
        rt.frame(0.0);
        assert!(
            rt.state.shell_ui.pending_trash_entry.is_none(),
            "Confirming Move to Trash should clear pending_trash_entry"
        );
    }

    #[test]
    fn compact_right_drawer_has_no_top_blank_band_and_quick_chat_clears_only_titlebar_band() {
        let mut s = AppState {
            scene_mode: true,
            ..Default::default()
        };
        s.onboarding.completed = true;
        s.shell_ui.viewport_width = 900.0;
        s.feature_flags.insert("canvas".into(), true);
        s.dispatch(Action::Shell(ShellAction::OpenFilePreview(
            FilePreviewState {
                workspace_id: "ws-1".into(),
                path: "/tmp/ws-1/notes.md".into(),
                title: "notes.md".into(),
                content: Some("# Compact\n\nOverlay canvas".into()),
                is_markdown: true,
                ..Default::default()
            },
        )));

        let mut rt = Runtime::new(s, test_shell_root, (900.0, 700.0), Env::new(true, 1.0));
        let mut insets = rune::ChromeInsets::default();
        insets.leading = 72.0;
        insets.height = 38.0;
        rt.set_titlebar_inset(72.0);
        rt.set_chrome_insets(insets);
        rt.frame(0.0);
        let (drawer_rect, _) = rt
            .presented("adaptive-right-drawer-panel")
            .expect("compact overlay drawer should be mounted");
        let (canvas_rect, _) = rt
            .presented("canvas-pane")
            .expect("canvas pane should be mounted in drawer");
        assert_eq!(drawer_rect[1], 0.0);
        assert!(
            canvas_rect[1] <= 2.0,
            "right drawer canvas pane must start flush near y=0, got y={}",
            canvas_rect[1]
        );

        let mut qc = AppState {
            scene_mode: true,
            window_mode: WindowMode::QuickChat,
            ..Default::default()
        };
        qc.onboarding.completed = true;
        let mut qc_rt = Runtime::new(qc, test_shell_root, (440.0, 560.0), Env::new(true, 1.0));
        let mut qc_insets = rune::ChromeInsets::default();
        qc_insets.leading = 72.0;
        qc_insets.height = 38.0;
        qc_rt.set_titlebar_inset(72.0);
        qc_rt.set_chrome_insets(qc_insets);
        qc_rt.frame(0.0);
        let (qc_header_rect, _) = qc_rt
            .presented("quick-chat-header")
            .expect("quick chat header should be mounted");
        assert!(
            qc_header_rect[3] <= 44.0,
            "quick chat header should stay within ~42px titlebar height, got h={}",
            qc_header_rect[3]
        );
    }

    #[test]
    fn inline_spreadsheet_preview_gives_preview_majority_width() {
        let csv = "item,jan,feb,mar,apr\nRent,1200,1200,1200,1200\nFood,350,360,340,370\n";
        let spreadsheet = crate::views::preview::decode_spreadsheet_preview(
            Path::new("budget.csv"),
            csv.as_bytes(),
            false,
        )
        .expect("csv should decode cleanly");

        let mut s = AppState {
            scene_mode: true,
            ..Default::default()
        };
        s.onboarding.completed = true;
        s.feature_flags.insert("canvas".into(), true);
        s.dispatch(Action::Shell(ShellAction::SetContextSidebarOpen(false)));
        s.dispatch(Action::Shell(ShellAction::OpenFilePreview(
            FilePreviewState {
                workspace_id: "ws-1".into(),
                path: "/tmp/ws-1/budget.csv".into(),
                title: "budget.csv".into(),
                content: Some(csv.into()),
                spreadsheet: Some(spreadsheet),
                ..Default::default()
            },
        )));

        let mut rt = Runtime::new(s, test_shell_root, (1280.0, 820.0), Env::new(true, 1.0));
        rt.frame(0.0);
        let (chat_rect, _) = rt
            .presented("primary-subview-pane")
            .expect("chat split pane should be mounted");
        let (preview_rect, _) = rt
            .presented("inline-file-preview")
            .expect("inline preview pane should be mounted");
        assert!(
            preview_rect[2] > chat_rect[2] && preview_rect[2] >= 550.0,
            "preview pane should receive ~62% majority width (>=550px), got preview={} vs chat={}",
            preview_rect[2],
            chat_rect[2]
        );
    }

    #[test]
    fn quick_chat_pop_out_switches_main_window_to_new_chat_from_landing() {
        let mut s = AppState {
            scene_mode: true,
            window_mode: WindowMode::QuickChat,
            active_workspace_id: Some("ws-1".into()),
            ..Default::default()
        };
        s.onboarding.completed = true;
        s.workspaces.push(crate::state::WorkspaceRecord {
            id: "ws-1".into(),
            name: "Alpha".into(),
            path: "/tmp/alpha".into(),
            ..Default::default()
        });

        let mut rt = Runtime::new(s, test_shell_root, (440.0, 560.0), Env::new(true, 1.0));
        rt.frame(0.0);

        let (px, py) = rt
            .find("quick-chat-pop-out")
            .expect("Pop out button must render in Quick Chat");
        rt.pointer_move(px, py);
        rt.pointer_down(px, py);
        rt.pointer_up(px, py);
        rt.frame(0.0);

        assert!(!rt.state.quick_chat_open);
        assert!(matches!(
            rt.state.services.emitted_window_commands.last(),
            Some(crate::state::WindowCommand::FocusMain {
                open_new_chat_workspace: Some(ws),
                open_thread_id: None,
            }) if ws == "ws-1"
        ));
    }

    #[test]
    fn inline_presentation_preview_mounts_and_handles_keys_without_double_dispatch() {
        use crate::views::preview::{PresentationPreviewData, PresentationSlideData};
        use rune::{Key, KeyEvent, Mods};

        let mut s = AppState {
            scene_mode: true,
            ..Default::default()
        };
        s.onboarding.completed = true;
        s.dispatch(Action::Shell(ShellAction::SetContextSidebarOpen(false)));
        s.dispatch(Action::Shell(ShellAction::OpenFilePreview(
            FilePreviewState {
                workspace_id: "ws-1".into(),
                path: "/tmp/ws-1/deck.pptx".into(),
                title: "deck.pptx".into(),
                is_binary: true,
                presentation: Some(Box::new(PresentationPreviewData {
                    loading: false,
                    slides: (0..3)
                        .map(|idx| PresentationSlideData {
                            slide_index: idx,
                            slide_id: Some(format!("s-{idx}")),
                            title: Some(format!("Slide {}", idx + 1)),
                            png_base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=".into(),
                        })
                        .collect(),
                    rendering_mode: Some("rendered".into()),
                    ..Default::default()
                })),
                ..Default::default()
            },
        )));

        let mut rt = Runtime::new(s, test_shell_root, (1280.0, 820.0), Env::new(true, 1.0));
        rt.on_key = Some(handle_key);
        rt.frame(0.0);

        assert!(
            rt.find("pptx-preview-root").is_some(),
            "inline presentation preview must mount instead of binary fallback"
        );
        let (preview_rect, _) = rt
            .presented("inline-file-preview")
            .expect("inline preview pane should be mounted");
        assert!(preview_rect[2] >= 550.0);
        assert_eq!(rt.state.preview_ui.active_slide, 0);

        // Unfocused key goes through shell::handle_key once (0 -> 1).
        rt.key(KeyEvent {
            key: Key::Right,
            mods: Mods::default(),
        });
        rt.frame(0.0);
        assert_eq!(rt.state.preview_ui.active_slide, 1);

        // Focus pptx-preview-root: element .on_key handles once without double-dispatch (1 -> 2).
        let (rx, ry) = rt
            .find("pptx-preview-root")
            .expect("pptx-preview-root must be clickable");
        rt.pointer_move(rx, ry);
        rt.pointer_down(rx, ry);
        rt.pointer_up(rx, ry);
        rt.frame(0.0);
        rt.key(KeyEvent {
            key: Key::Right,
            mods: Mods::default(),
        });
        rt.frame(0.0);
        assert_eq!(rt.state.preview_ui.active_slide, 2);

        // Focus a non-preview text input (composer_edit): slide keys must not hijack it.
        rt.state.composer_edit.focused = true;
        if let Some((cx, cy)) = rt.find("composer-input") {
            rt.pointer_move(cx, cy);
            rt.pointer_down(cx, cy);
            rt.pointer_up(cx, cy);
            rt.frame(0.0);
        }
        rt.key(KeyEvent {
            key: Key::Left,
            mods: Mods::default(),
        });
        rt.frame(0.0);
        assert_eq!(rt.state.preview_ui.active_slide, 2);
    }

    #[test]
    fn swapping_to_settings_and_between_pages_lands_settled_on_first_frame_without_opacity_dip() {
        use crate::state::DesktopPlatformOverride;
        use rune::{Key, KeyEvent, Mods};

        for platform in [
            DesktopPlatformOverride::MacOs,
            DesktopPlatformOverride::Linux,
        ] {
            let mut s = AppState {
                scene_mode: true,
                menu_platform_override: Some(platform),
                ..Default::default()
            };
            s.onboarding.completed = true;
            s.desktop_settings.reduce_motion = false;
            s.workspaces.push(crate::state::WorkspaceRecord::new(
                "ws-1",
                "Demo",
                "/tmp/demo",
                1,
            ));
            s.active_workspace_id = Some("ws-1".into());
            s.threads.push(crate::state::ThreadRecord {
                id: "th-1".into(),
                workspace_id: "ws-1".into(),
                title: "Active chat".into(),
                ..Default::default()
            });
            s.dispatch(Action::Navigate(crate::actions::NavAction::OpenThread(
                "th-1".into(),
            )));

            let mut rt = Runtime::new(s, test_shell_root, (1280.0, 820.0), Env::new(true, 1.0));
            rt.poll = Some(crate::perf_hooks::poll);
            rt.on_key = Some(crate::views::shell::handle_key);
            rt.frame(0.0);
            rt.settle_all();
            rt.frame(1.0 / 60.0);

            let click = |rt: &mut Runtime<AppState>, key: &str| {
                let (x, y) = rt.find(key).unwrap_or_else(|| panic!("missing {key}"));
                rt.pointer_move(x, y);
                rt.pointer_down(x, y);
                rt.pointer_up(x, y);
            };

            let assert_settled_swap = |rt: &mut Runtime<AppState>, step: &str, keys: &[&str]| {
                let commits_before = rt.stats.commits;
                rt.frame(1.0 / 60.0);
                assert!(
                    !rt.state.settle_after_navigation,
                    "{platform:?} {step}: navigation must settle on the triggering frame, not wait for poll_app"
                );
                let els = rt.elements();
                let exiting: Vec<&str> = els
                    .iter()
                    .filter(|e| e.exiting)
                    .map(|e| e.key.as_deref().unwrap_or(e.path.as_str()))
                    .collect();
                assert!(
                    exiting.is_empty(),
                    "{platform:?} {step}: outgoing elements must unmount immediately without exiting fade: {exiting:?}"
                );
                let moving: Vec<&str> = els
                    .iter()
                    .filter(|e| e.moving)
                    .map(|e| e.key.as_deref().unwrap_or(e.path.as_str()))
                    .collect();
                assert!(
                    moving.is_empty(),
                    "{platform:?} {step}: view swap must not leave elements mid-motion on frame 1: {moving:?}"
                );
                for key in keys {
                    let (_, op) = rt
                        .presented(key)
                        .unwrap_or_else(|| panic!("{platform:?} {step}: missing {key} on frame 1"));
                    assert!(
                        (op - 1.0).abs() < 1e-3,
                        "{platform:?} {step}: {key} dipped opacity to {op} on frame 1"
                    );
                }
                let commits_after_first = rt.stats.commits;
                assert!(
                    commits_after_first > commits_before,
                    "{platform:?} {step}: frame 1 should commit the navigation"
                );
                rt.frame(1.0 / 60.0);
                assert_eq!(
                    rt.stats.commits, commits_after_first,
                    "{platform:?} {step}: frame 2 must not trigger a deferred settle commit"
                );
            };

            // 1. Click sidebar Settings row: Frame 1 must show Settings settled at full opacity with
            //    the shared shell frame intact and zero exiting chat elements.
            click(&mut rt, "sidebar-settings");
            assert_settled_swap(
                &mut rt,
                "sidebar-settings -> Settings",
                &[
                    "shell",
                    "sidebar-pane",
                    "main-column",
                    "settings-nav-rail",
                    "settings-main-pane",
                    "settings-page-models",
                ],
            );
            assert_eq!(rt.state.route().view, ViewId::Settings);
            assert!(
                rt.presented("chat-view").is_none()
                    && rt.presented("sidebar-toolbar-cluster").is_none(),
                "outgoing chat chrome must unmount immediately on settings entry frame"
            );

            // 2. Switch Settings page (Models -> Desktop): Frame 1 must land settled at full opacity.
            click(&mut rt, "settings-nav-desktop");
            assert_settled_swap(
                &mut rt,
                "Models -> Desktop",
                &["shell", "settings-main-pane", "settings-page-desktop"],
            );
            assert!(rt.presented("settings-page-models").is_none());

            // 3. Click Back to chat: Frame 1 must return to Chat settled at full opacity.
            click(&mut rt, "settings-back-button");
            assert_settled_swap(
                &mut rt,
                "settings-back-button -> Chat",
                &["shell", "sidebar-pane", "main-column", "chat-view"],
            );
            assert_eq!(rt.state.route().view, ViewId::Chat);
            assert!(rt.presented("settings-main-pane").is_none());

            // 4. Collapse sidebar in Chat, then open Settings via topbar gear button and Escape back.
            rt.state.sidebar.set_open(false);
            rt.settle_all();
            rt.frame(1.0 / 60.0);

            click(&mut rt, "topbar-settings");
            assert_settled_swap(
                &mut rt,
                "collapsed Chat topbar-settings -> Settings",
                &["shell", "sidebar-pane", "main-column", "settings-main-pane"],
            );
            assert_eq!(rt.state.route().view, ViewId::Settings);
            let (sb_rect, sb_op) = rt
                .presented("sidebar-pane")
                .expect("settings sidebar-pane must present immediately");
            assert!(
                (sb_op - 1.0).abs() < 1e-3
                    && (sb_rect[2] - rt.state.settings_ui.nav_pane.width()).abs() < 1.0,
                "settings sidebar-pane should snap to full width & opacity on frame 1: rect={sb_rect:?}, op={sb_op}"
            );

            rt.key(KeyEvent {
                key: Key::Escape,
                mods: Mods::default(),
            });
            assert_settled_swap(
                &mut rt,
                "Escape -> Chat",
                &["shell", "main-column", "chat-view"],
            );
            assert_eq!(rt.state.route().view, ViewId::Chat);

            // 5. Cmd+, opens Settings settled on frame 1.
            rt.key(KeyEvent {
                key: Key::Command(','),
                mods: Mods {
                    cmd: true,
                    ..Default::default()
                },
            });
            assert_settled_swap(
                &mut rt,
                "Cmd+, -> Settings",
                &["shell", "sidebar-pane", "main-column", "settings-main-pane"],
            );
            assert_eq!(rt.state.route().view, ViewId::Settings);
        }
    }
}
