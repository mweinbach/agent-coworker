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

use rune::{Cx, El, Spring, col, el};
use rune_kit::shell::{PaneMotion, SidebarPeek, SidebarToggle, SplitView};
use rune_kit::{ControlSize, Kit};

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
    let subview = match route.view {
        ViewId::Chat => crate::views::chat::view(s, cx, k),
        ViewId::Task => SubviewOutput {
            content: tasks::build_task_view(s, k, t),
            overlays: Vec::new(),
        },
        ViewId::Settings => crate::views::settings::view(s, cx, k),
    };

    let mut layer = subview.overlays;
    let base = if route.view == ViewId::Settings {
        build_settings_frame(t, subview.content)
    } else {
        build_workspace_split_frame(s, cx, k, t, subview.content, &mut layer)
    };

    rune_kit::root(base, overlays::build_overlays(s, k, t, layer)).on_layout::<AppState>(
        |s, rect| {
            let width = rect[2];
            if width > 0.0 && (width - s.shell_ui.viewport_width).abs() > 1.0 {
                s.shell_ui.viewport_width = width;
                if width >= helpers::NARROW_BREAKPOINT {
                    s.shell_ui.left_overlay_open = false;
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

fn build_settings_frame(t: &ThemeTokens, settings_content: El) -> El {
    // `views::settings::shell` renders the full-height nav rail (`cx.titlebar_inset()`
    // top padding) and `<- Back` control directly; avoid duplicating a shell topbar above it.
    el().key("settings-shell-frame")
        .w_full()
        .h_full()
        .min_h(0.0)
        .fill(t.app_bg)
        .child(settings_content)
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

    let toolbar = top_bar::build_toolbar(s, cx, k, t, layer);
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

    let route_view = s.route().view;
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
    let adaptive = helpers::resolve_adaptive_layout(
        s.shell_ui.viewport_width,
        s.sidebar.is_open(),
        s.sidebar.width(),
        route_view != ViewId::Settings && !canvas_maximized,
        right_open,
        right_width_pref,
        right_kind,
    );

    let mut split = SplitView::new(primary_el).toolbar(toolbar);
    let chrome = cx.chrome_insets();
    let left_drawer_top = if chrome.leading > 0.0 {
        chrome.height
    } else {
        0.0
    };
    let right_drawer_top = if chrome.trailing > 0.0 {
        chrome.height
    } else {
        0.0
    };

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
                            .pt(left_drawer_top)
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
                                .border(1.0, t.border_strong)
                                .child(right_panel_el),
                        ),
                );
            }
        } else if canvas_active {
            split = split.inspector(
                &s.shell_ui.canvas_pane,
                |s: &mut AppState| &mut s.shell_ui.canvas_pane,
                right_panel_el,
            );
        } else {
            split = split.inspector(
                &s.context_sidebar,
                |s: &mut AppState| &mut s.context_sidebar,
                right_panel_el,
            );
        }
    }

    split
        .titlebar_inset(cx.titlebar_inset())
        .frame_inset(8.0)
        .toolbar_in_panel()
        .pane_motion(PaneMotion::new().spring(Spring::new(0.3, 0.0)))
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
}
