//! Command Palette (`Cmd/Ctrl+K`): unified quick switcher for shell actions,
//! threads, tasks, workspaces, settings sections, and slash commands.

use std::collections::HashMap;

use rune::{El, Icon, ScrollSpec, col, el, icon, row, spacer, text};
use rune_kit::{Badge, Button, ButtonVariant, ControlSize, Kit, TextInput};

use crate::actions::{Action, NativeAction, NavAction, ShellAction};
use crate::router::{SettingsPageId, ViewId};
use crate::state::AppState;
use crate::theme::{ThemePreference, ThemeTokens};

use super::icons;

pub(crate) struct PaletteItem {
    pub(crate) key: String,
    pub(crate) section: &'static str,
    pub(crate) title: String,
    pub(crate) subtitle: String,
    pub(crate) icon_glyph: &'static Icon,
    pub(crate) action: Action,
}

/// Open the Command Palette with a clean search query and focused input.
pub(crate) fn open_command_palette(s: &mut AppState) {
    s.shell_ui.command_palette_selected = 0;
    s.command_palette_edit = rune::TextEdit::new("");
    s.command_palette_edit.focused = true;
    s.dispatch(Action::Shell(ShellAction::SetCommandPaletteQuery(
        String::new(),
    )));
    s.dispatch(Action::Shell(ShellAction::SetCommandPaletteOpen(true)));
}

/// Close the Command Palette and clear its search query/selection state.
pub(crate) fn close_command_palette(s: &mut AppState) {
    s.shell_ui.command_palette_selected = 0;
    s.command_palette_edit = rune::TextEdit::new("");
    s.command_palette_edit.focused = false;
    s.dispatch(Action::Shell(ShellAction::SetCommandPaletteQuery(
        String::new(),
    )));
    s.dispatch(Action::Shell(ShellAction::SetCommandPaletteOpen(false)));
}

/// Toggle the Command Palette, resetting query/selection on both open and close.
pub(crate) fn toggle_command_palette(s: &mut AppState) {
    if s.command_palette_open {
        close_command_palette(s);
    } else {
        open_command_palette(s);
    }
}

/// Build the floating Command Palette modal overlay when `s.command_palette_open` is true.
pub fn build_command_palette(s: &AppState, k: &Kit, t: &ThemeTokens) -> Option<El> {
    if !s.command_palette_open {
        return None;
    }

    let query = s.command_palette_query.trim().to_lowercase();
    let tasks_enabled = super::helpers::tasks_feature_enabled(s);
    let items = collect_palette_items(s, &query);
    let selected_idx = s
        .shell_ui
        .command_palette_selected
        .min(items.len().saturating_sub(1));

    let placeholder = if tasks_enabled {
        "Jump to workspace, thread, task, command, or settings..."
    } else {
        "Jump to workspace, thread, command, or settings..."
    };
    let search_input = TextInput::new(&s.command_palette_edit)
        .placeholder(placeholder)
        .label("Command palette search")
        .leading_icon(&icons::SEARCH)
        .width(None)
        .clear_button()
        .on_edit(|s: &mut AppState| &mut s.command_palette_edit)
        .on_change(|s: &mut AppState, _| {
            let val = s.command_palette_edit.text.clone();
            s.shell_ui.command_palette_selected = 0;
            s.dispatch(Action::Shell(ShellAction::SetCommandPaletteQuery(val)));
        })
        .on_key(|s: &mut AppState, ev, _| match ev.key {
            rune::Key::Up => {
                s.shell_ui.command_palette_selected =
                    s.shell_ui.command_palette_selected.saturating_sub(1);
                true
            }
            rune::Key::Down => {
                let query = s.command_palette_query.trim().to_lowercase();
                let items = collect_palette_items(s, &query);
                if !items.is_empty() {
                    let max_idx = items.len().saturating_sub(1);
                    s.shell_ui.command_palette_selected =
                        (s.shell_ui.command_palette_selected + 1).min(max_idx);
                }
                true
            }
            rune::Key::Escape => {
                close_command_palette(s);
                true
            }
            _ => false,
        })
        .on_action(|s: &mut AppState, tx| {
            let query = s.command_palette_query.trim().to_lowercase();
            let items = collect_palette_items(s, &query);
            let max_idx = items.len().saturating_sub(1);
            if let Some(item) = items.get(s.shell_ui.command_palette_selected.min(max_idx)) {
                let act = item.action.clone();
                close_command_palette(s);
                s.dispatch_tx(act, tx);
            }
        })
        .build(k);

    let mut list_children: Vec<El> = Vec::new();
    if items.is_empty() {
        list_children.push(
            el().w_full().px(16.0).py(28.0).center().child(
                text("No matching actions, threads, or settings.")
                    .font(t.body)
                    .color(t.text_muted),
            ),
        );
    } else {
        let mut last_section: Option<&'static str> = None;
        for (idx, item) in items.into_iter().enumerate() {
            if last_section != Some(item.section) {
                last_section = Some(item.section);
                list_children.push(
                    el().key(format!("pal-sec-{}", item.section))
                        .w_full()
                        .pt(8.0)
                        .pb(4.0)
                        .px(10.0)
                        .child(text(item.section).font(t.caption).color(t.text_faint)),
                );
            }
            list_children.push(palette_row(item, idx == selected_idx, k, t));
        }
    }

    let footer = row()
        .key("command-palette-footer")
        .w_full()
        .h(34.0)
        .px(14.0)
        .gap(12.0)
        .center_y()
        .corners([0.0, 0.0, 11.0, 11.0])
        .continuous_corners()
        .fill(t.panel_bg)
        .child(
            text("↑↓ navigate · Enter run · Esc close")
                .font(t.caption)
                .color(t.text_faint),
        )
        .child(spacer())
        .child(Badge::new("Esc close").build(k));

    let inner = col()
        .w_full()
        .max_h(518.0)
        .radius(11.0)
        .continuous_corners()
        .clip_rounded(11.0)
        .child(
            row()
                .w_full()
                .padding(10.0)
                .gap(8.0)
                .center_y()
                .child(el().grow(1.0).child(search_input))
                .child(
                    Button::new("Close")
                        .variant(ButtonVariant::Ghost)
                        .control_size(ControlSize::Small)
                        .on_press_tx(|s: &mut AppState, _| {
                            close_command_palette(s);
                        })
                        .build(k),
                ),
        )
        .child(el().w_full().h(1.0).fill(t.border_muted))
        .child(
            k.scroll_bar(
                col()
                    .key("command-palette-results")
                    .w_full()
                    .max_h(410.0)
                    .scroll(ScrollSpec {
                        stick_bottom: false,
                    })
                    .padding(8.0)
                    .gap(2.0)
                    .children(list_children),
            ),
        )
        .child(el().w_full().h(1.0).fill(t.border_muted))
        .child(footer);

    let card = k.elevate(
        col()
            .key("command-palette-card")
            .w(580.0)
            .max_h(520.0)
            .padding(1.0)
            .radius(12.0)
            .continuous_corners()
            .fill(t.popover_bg)
            .border(1.0, t.border_strong)
            .child(inner),
        &k.elevation.overlay,
    );

    Some(
        col()
            .key("command-palette-backdrop")
            .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
            .fill(t.scrim)
            .pt(76.0)
            .px(16.0)
            .items_center()
            .modal(true, |s: &mut AppState| {
                close_command_palette(s);
            })
            .child(card),
    )
}

fn palette_row(item: PaletteItem, highlighted: bool, k: &Kit, t: &ThemeTokens) -> El {
    let act = item.action.clone();
    let row_bg = if highlighted {
        t.accent_soft
    } else {
        rune::Color::TRANSPARENT
    };

    let mut text_col = col()
        .grow(1.0)
        .shrink()
        .gap(1.0)
        .child(text(item.title).font(t.body).color(t.text_base).truncate());
    if !item.subtitle.is_empty() {
        text_col = text_col.child(
            text(item.subtitle)
                .font(t.caption)
                .color(t.text_muted)
                .truncate(),
        );
    }

    let mut r = row()
        .w_full()
        .gap(10.0)
        .center_y()
        .child(icon(item.icon_glyph, 15.0).color(t.text_muted))
        .child(text_col);
    if highlighted {
        r = r.child(Badge::new("↵").build(k));
    }

    el().key(item.key)
        .w_full()
        .px(10.0)
        .py(7.0)
        .radius(7.0)
        .fill(row_bg)
        .hover(t.hover)
        .on_press_tx(move |s: &mut AppState, tx| {
            close_command_palette(s);
            s.dispatch_tx(act.clone(), tx);
        })
        .child(r)
}

fn matches_query(query: &str, title: &str, subtitle: &str) -> bool {
    query.is_empty()
        || super::helpers::contains_case_insensitive(title, query)
        || super::helpers::contains_case_insensitive(subtitle, query)
}

pub(crate) fn collect_palette_items(s: &AppState, query: &str) -> Vec<PaletteItem> {
    let mut out = Vec::new();
    let tasks_enabled = super::helpers::tasks_feature_enabled(s);
    let active_ws_id = s
        .active_workspace_id
        .as_deref()
        .or_else(|| s.workspaces.first().map(|w| w.id.as_str()));

    let next_theme = match s.desktop_settings.theme {
        ThemePreference::Dark => ThemePreference::Light,
        ThemePreference::Light | ThemePreference::System => ThemePreference::Dark,
    };

    let push_static = |out: &mut Vec<PaletteItem>,
                       key: &'static str,
                       title: &'static str,
                       subtitle: &'static str,
                       icon_glyph: &'static Icon,
                       action: Action| {
        if matches_query(query, title, subtitle) {
            out.push(PaletteItem {
                key: key.to_owned(),
                section: "Actions",
                title: title.to_owned(),
                subtitle: subtitle.to_owned(),
                icon_glyph,
                action,
            });
        }
    };

    push_static(
        &mut out,
        "pal-act-new-chat",
        "New chat",
        "Start a fresh conversation in the active workspace",
        &icons::PLUS,
        Action::Navigate(NavAction::OpenNewChat {
            workspace_id: active_ws_id.map(str::to_owned),
        }),
    );
    if tasks_enabled {
        push_static(
            &mut out,
            "pal-act-new-task",
            "New task",
            "Create or inspect a structured workspace task",
            &icons::CHECK_SQUARE,
            Action::Navigate(NavAction::OpenView(ViewId::Task)),
        );
    }
    push_static(
        &mut out,
        "pal-act-quick-chat",
        "Open Quick Chat",
        "Launch compact floating Quick Chat",
        &icons::POPOUT,
        Action::Shell(ShellAction::OpenQuickChatWindow),
    );
    for (key, title, subtitle_prefix, accel, icon_glyph, action) in [
        (
            "pal-act-zoom-in",
            "Zoom In",
            "Increase interface scale",
            "Cmd+=",
            &icons::ZOOM_IN,
            Action::Shell(ShellAction::ZoomIn),
        ),
        (
            "pal-act-zoom-out",
            "Zoom Out",
            "Decrease interface scale",
            "Cmd+-",
            &icons::ZOOM_OUT,
            Action::Shell(ShellAction::ZoomOut),
        ),
        (
            "pal-act-zoom-reset",
            "Actual Size",
            "Reset interface zoom scale to 100%",
            "Cmd+0",
            &icons::REFRESH,
            Action::Shell(ShellAction::ResetZoom),
        ),
    ] {
        // Match against static title/prefix first; only format shortcut label if needed.
        if matches_query(query, title, subtitle_prefix) {
            out.push(PaletteItem {
                key: key.to_owned(),
                section: "Actions",
                title: title.to_owned(),
                subtitle: format!("{subtitle_prefix} ({})", crate::shortcut_label(accel)),
                icon_glyph,
                action,
            });
        } else if !query.is_empty() {
            let subtitle = format!("{subtitle_prefix} ({})", crate::shortcut_label(accel));
            if super::helpers::contains_case_insensitive(&subtitle, query) {
                out.push(PaletteItem {
                    key: key.to_owned(),
                    section: "Actions",
                    title: title.to_owned(),
                    subtitle,
                    icon_glyph,
                    action,
                });
            }
        }
    }
    push_static(
        &mut out,
        "pal-act-add-folder",
        "Add project folder...",
        "Choose a workspace directory from disk",
        &icons::FOLDER_PLUS,
        Action::Native(NativeAction::PickWorkspaceFolder),
    );
    push_static(
        &mut out,
        "pal-act-toggle-sidebar",
        "Toggle left sidebar",
        "Show or collapse workspace and thread navigation",
        &icons::FOLDER,
        Action::Shell(ShellAction::ToggleSidebar),
    );
    push_static(
        &mut out,
        "pal-act-toggle-inspector",
        "Toggle context inspector",
        "Show or hide usage, subagents, workflows, and files",
        &icons::FILE_TEXT,
        Action::Shell(ShellAction::ToggleContextSidebar),
    );
    let theme_title = match next_theme {
        ThemePreference::Dark => "Switch to Dark theme",
        ThemePreference::Light => "Switch to Light theme",
        ThemePreference::System => "Switch to System theme",
    };
    push_static(
        &mut out,
        "pal-act-theme",
        theme_title,
        "Toggle appearance mode",
        &icons::SPARKLES,
        Action::Shell(ShellAction::SetTheme(next_theme)),
    );
    push_static(
        &mut out,
        "pal-act-settings",
        "Open Settings",
        "Configure providers, models, MCP, tools, and privacy",
        &icons::SETTINGS,
        Action::Navigate(NavAction::OpenSettings(None)),
    );

    let ws_names: HashMap<&str, &str> = s
        .workspaces
        .iter()
        .map(|w| (w.id.as_str(), w.name.as_str()))
        .collect();

    let mut thread_count = 0usize;
    for th in s.threads.iter().filter(|t| t.is_standard_chat()) {
        if thread_count >= 8 {
            break;
        }
        let ws_name = ws_names
            .get(th.workspace_id.as_str())
            .copied()
            .unwrap_or("Workspace");
        if matches_query(query, &th.title, ws_name) {
            out.push(PaletteItem {
                key: format!("pal-th-{}", th.id),
                section: "Recent Chats",
                title: th.title.clone(),
                subtitle: ws_name.to_owned(),
                icon_glyph: &icons::MESSAGE,
                action: Action::Navigate(NavAction::OpenThread(th.id.clone())),
            });
            thread_count += 1;
        }
    }

    if tasks_enabled {
        for task in s
            .tasks
            .iter()
            .filter(|task| matches_query(query, &task.title, &task.status))
            .take(6)
        {
            out.push(PaletteItem {
                key: format!("pal-task-{}", task.id),
                section: "Tasks",
                title: task.title.clone(),
                subtitle: task.status.clone(),
                icon_glyph: &icons::CHECK_SQUARE,
                action: Action::Navigate(NavAction::OpenTask(task.id.clone())),
            });
        }
    }

    for ws in s.workspaces.iter().filter(|w| !w.one_off_chat) {
        if matches_query(query, &ws.name, &ws.path) {
            out.push(PaletteItem {
                key: format!("pal-ws-{}", ws.id),
                section: "Workspaces",
                title: ws.name.clone(),
                subtitle: ws.path.clone(),
                icon_glyph: &icons::FOLDER,
                action: Action::Navigate(NavAction::SelectWorkspace(ws.id.clone())),
            });
        }
    }

    for page in SettingsPageId::all_canonical() {
        let title = page.title();
        let desc = page.description();
        if matches_query(query, title, desc) {
            out.push(PaletteItem {
                key: format!("pal-set-{page:?}"),
                section: "Settings",
                title: format!("Settings: {title}"),
                subtitle: desc.to_owned(),
                icon_glyph: &icons::SETTINGS,
                action: Action::Navigate(NavAction::OpenSettingsIntent {
                    page: *page,
                    tab: None,
                    section: None,
                    new_provider: false,
                }),
            });
        }
    }

    if let Some(ws_id) = active_ws_id
        && let Some(cmds) = s.commands_by_workspace.get(ws_id)
    {
        for cmd in cmds
            .iter()
            .filter(|cmd| {
                let desc = cmd.description.as_deref().unwrap_or("");
                matches_query(query, &cmd.name, desc)
            })
            .take(6)
        {
            let desc = cmd.description.as_deref().unwrap_or("");
            out.push(PaletteItem {
                key: format!("pal-cmd-{}", cmd.name),
                section: "Commands",
                title: format!("/{}", cmd.name),
                subtitle: desc.to_owned(),
                icon_glyph: &icons::TERMINAL,
                action: Action::Navigate(NavAction::OpenNewChat {
                    workspace_id: Some(ws_id.to_owned()),
                }),
            });
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::TaskSummaryView;

    #[test]
    fn tasks_palette_entries_require_tasks_feature_flag() {
        let mut s = AppState::default();
        s.tasks.push(TaskSummaryView {
            id: "task-1".into(),
            workspace_id: "ws-1".into(),
            title: "Build native shell".into(),
            status: "running".into(),
            ..Default::default()
        });

        let default_items = collect_palette_items(&s, "");
        assert!(!default_items.iter().any(|i| i.key == "pal-act-new-task"));
        assert!(!default_items.iter().any(|i| i.key == "pal-task-task-1"));

        s.feature_flags.insert("tasks".into(), true);
        let enabled_items = collect_palette_items(&s, "");
        assert!(enabled_items.iter().any(|i| i.key == "pal-act-new-task"));
        assert!(enabled_items.iter().any(|i| i.key == "pal-task-task-1"));

        let zoom_items = collect_palette_items(&s, "zoom");
        let zoom_keys: Vec<_> = zoom_items.iter().map(|i| i.key.as_str()).collect();
        assert!(zoom_keys.contains(&"pal-act-zoom-in"));
        assert!(zoom_keys.contains(&"pal-act-zoom-out"));
        assert!(zoom_keys.contains(&"pal-act-zoom-reset"));
    }

    #[test]
    fn command_palette_and_search_overlay_top_and_bottom_corners_match() {
        use std::path::PathBuf;

        use rune::render::{Gpu, OFFSCREEN_FORMAT, Offscreen, Renderer, write_png};
        use rune::{Cx, Env, Runtime};

        const VP: (f32, f32) = (1280.0, 820.0);

        fn shell_root(state: &AppState, cx: &mut Cx<AppState>) -> El {
            let dark = state.effective_dark(cx.system_dark());
            let (k, t) = crate::theme::build_kit_with_accent(
                dark,
                state.desktop_settings.reduced_transparency,
                state.desktop_settings.high_contrast,
                state.desktop_settings.accent_palette,
            );
            cx.foreground(t.text_base);
            cx.focus_ring(2.0, 2.5, t.focus_ring);
            cx.web_focus();
            crate::views::shell::view(state, cx, &k, &t)
        }

        let gpu = Gpu::headless();
        let mut renderer = Renderer::new(&gpu.device, OFFSCREEN_FORMAT);

        for dark in [false, true] {
            let suffix = if dark { "dark" } else { "light" };
            for (is_palette, card_key, snap_prefix) in [
                (true, "command-palette-card", "command_palette"),
                (false, "sidebar-search-overlay-card", "sidebar_search"),
            ] {
                let mut s = AppState::default();
                s.onboarding.completed = true;
                s.desktop_settings.theme = if dark {
                    ThemePreference::Dark
                } else {
                    ThemePreference::Light
                };
                if is_palette {
                    open_command_palette(&mut s);
                } else {
                    s.shell_ui.search_overlay_open = true;
                }

                let scale = 2.0_f32;
                let dw = (VP.0 * scale) as u32;
                let dh = (VP.1 * scale) as u32;
                let mut rt = Runtime::new(s, shell_root, VP, Env::new(dark, scale));
                rt.frame(0.0);
                rt.settle_all();
                rt.frame(0.0);

                let (rect, _) = rt
                    .presented(card_key)
                    .unwrap_or_else(|| panic!("expected `{card_key}` to be mounted"));

                let target = Offscreen::new(&gpu.device, dw, dh);
                renderer.upload_images(&gpu.device, &gpu.queue, &mut rt.images);
                renderer.prepare_surfaces(&gpu.device, &gpu.queue, &rt.surfaces, (dw, dh));
                renderer.prepare(
                    &gpu.device,
                    &gpu.queue,
                    &mut rt.text.atlas,
                    &rt.instances,
                    (dw, dh),
                );
                let tokens = crate::theme::resolve_tokens_with_accent(
                    dark,
                    rt.state.desktop_settings.reduced_transparency,
                    rt.state.desktop_settings.high_contrast,
                    rt.state.desktop_settings.accent_palette,
                );
                let clear = [
                    tokens.panel_bg.r,
                    tokens.panel_bg.g,
                    tokens.panel_bg.b,
                    tokens.panel_bg.a,
                ];
                let mut enc = gpu.device.create_command_encoder(&Default::default());
                renderer.draw(&mut enc, &target.view, clear);
                target.copy(&mut enc);
                renderer.submit(&gpu.queue, enc);
                let rgba = target.read(&gpu.device);

                if let Ok(dir) = std::env::var("COWORK_PALETTE_SNAP_DIR") {
                    let dir = PathBuf::from(dir);
                    std::fs::create_dir_all(&dir).expect("create palette snap dir");
                    write_png(
                        &dir.join(format!("{snap_prefix}_{suffix}.png")),
                        dw,
                        dh,
                        &rgba,
                    )
                    .expect("write palette snap");
                }

                let px = |x: u32, y: u32| -> [u8; 3] {
                    let idx = ((y * dw + x) * 4) as usize;
                    [rgba[idx], rgba[idx + 1], rgba[idx + 2]]
                };

                let x0 = (rect[0] * scale).round() as u32;
                let y0 = (rect[1] * scale).round() as u32;
                let x1 = ((rect[0] + rect[2]) * scale).round() as u32 - 1;
                let y1 = ((rect[1] + rect[3]) * scale).round() as u32 - 1;

                // Compare interior footer fill pixel vs outermost bottom-left/bottom-right corner pixels:
                // rounded bottom corners must NOT paint the interior footer fill out to (x0 + 1, y1 - 1).
                let footer_interior = px(x0 + 40, y1 - 16);
                let bl_outer_corner = px(x0 + 1, y1 - 1);
                let br_outer_corner = px(x1 - 1, y1 - 1);
                let tl_outer_corner = px(x0 + 1, y0 + 1);

                assert_ne!(
                    bl_outer_corner, footer_interior,
                    "{card_key} ({suffix}) bottom-left corner must be rounded, not sharp footer fill"
                );
                assert_ne!(
                    br_outer_corner, footer_interior,
                    "{card_key} ({suffix}) bottom-right corner must be rounded, not sharp footer fill"
                );
                // Top-left and bottom-left outermost corner pixels sit outside the 12pt continuous curve
                // over the uniform scrim (modulo vertical drop shadow alpha, within small shadow delta).
                let luma_diff =
                    (i16::from(tl_outer_corner[0]) - i16::from(bl_outer_corner[0])).abs();
                assert!(
                    luma_diff <= 28,
                    "{card_key} ({suffix}) top-left ({tl_outer_corner:?}) and bottom-left ({bl_outer_corner:?}) outer corner pixels diverged by {luma_diff}"
                );
            }
        }
    }
}
