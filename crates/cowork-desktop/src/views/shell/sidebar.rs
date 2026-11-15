//! Left workspace, thread, task, and chat navigation sidebar.
//!
//! Ported from `apps/desktop/src/ui/Sidebar.tsx`, `src/ui/sidebar/`, and `sidebarHelpers.ts`.

use std::collections::HashSet;

use rune::{Color, El, TextStyle, col, el, row, text};
use rune_kit::shell::{RowStatus, Sidebar, SidebarRow, SidebarSection};
use rune_kit::{ControlSize, IconButton, IconButtonVariant, Kit, Menu, MenuItem, TextInput};

use crate::actions::{Action, ChatAction, NativeAction, NavAction, ShellAction, SidebarSectionKey};
use crate::router::{SettingsPageId, ViewId};
use crate::state::{AppState, ThreadRecord, WorkspaceRecord};
use crate::theme::{ThemeTokens, contrast_ratio};
use crate::views::shell::helpers::{
    filtered_threads, format_relative_age, pending_input_count, split_workspaces,
    thread_row_status, workspace_badge_color,
};
use crate::views::shell::icons;

const MAX_THREADS_PER_WORKSPACE: usize = 5;

/// Renders the left application sidebar with quick actions, search filter, and ordered sections.
pub fn build_sidebar(s: &AppState, k: &Kit, t: &ThemeTokens, layer: &mut Vec<El>) -> El {
    let mut sb = Sidebar::new()
        .label("Workspace navigation")
        .inset(8.0)
        .header_gap(3.0)
        .header_padding(0.0, 8.0)
        .row_gap(2.0);

    for item in build_header_items(s, k, t) {
        sb = sb.header(item);
    }

    let query = s.sidebar_search.as_str();
    let pending_filter = s.shell_ui.needs_input_only && pending_input_count(s) > 0;
    let threads = filtered_threads(s, query, pending_filter);
    let (projects, one_off_ids, primary_one_off) = split_workspaces(s);
    let active_thread_id = s.route().active_thread_id.as_deref();
    let active_task_id = s.route().active_task_id.as_deref();

    for section_key in &s.desktop_settings.sidebar_section_order {
        match section_key {
            SidebarSectionKey::Pinned => {
                if let Some(sec) = build_pinned_section(s, k, t, layer, &threads, active_thread_id)
                {
                    sb = sb.section(sec);
                }
            }
            SidebarSectionKey::Tasks => {
                if let Some(sec) = build_tasks_section(s, k, query, active_task_id) {
                    sb = sb.section(sec);
                }
            }
            SidebarSectionKey::Chats => {
                sb = sb.section(build_chats_section(
                    s,
                    k,
                    t,
                    layer,
                    &threads,
                    &one_off_ids,
                    primary_one_off,
                    active_thread_id,
                ));
            }
            SidebarSectionKey::Workspaces => {
                sb = build_workspaces_section(
                    s,
                    k,
                    t,
                    layer,
                    sb,
                    &projects,
                    &threads,
                    active_thread_id,
                );
            }
        }
    }

    let footer = col()
        .key("sidebar-footer-actions")
        .w_full()
        .gap(2.0)
        .child(
            SidebarRow::new("Add project")
                .icon(&icons::FOLDER_PLUS)
                .height(30.0)
                .on_select(|s: &mut AppState, _| {
                    s.dispatch(Action::Native(NativeAction::PickWorkspaceFolder));
                })
                .build(k)
                .key("sidebar-add-project"),
        )
        .child(
            SidebarRow::new("Settings")
                .icon(&icons::SETTINGS)
                .height(30.0)
                .selected(s.route().view == ViewId::Settings)
                .on_select(|s: &mut AppState, _| {
                    s.dispatch(Action::Navigate(NavAction::OpenSettings(None)));
                })
                .build(k)
                .key("sidebar-settings"),
        );

    sb.footer(footer).build(k)
}

fn build_header_items(s: &AppState, k: &Kit, t: &ThemeTokens) -> Vec<El> {
    let new_chat = SidebarRow::new("New chat")
        .icon(&icons::PLUS)
        .detail(crate::shortcut_label("Cmd+N"))
        .height(30.0)
        .on_select(|s: &mut AppState, _| {
            let ws = s.active_workspace_id.clone();
            s.dispatch(Action::Navigate(NavAction::OpenNewChat {
                workspace_id: ws,
            }));
        })
        .build(k)
        .key("sidebar-new-chat");

    let command_palette = SidebarRow::new("Search & commands")
        .icon(&icons::SEARCH)
        .detail(crate::shortcut_label("Cmd+K"))
        .height(30.0)
        .on_select(|s: &mut AppState, _| {
            super::palette::open_command_palette(s);
        })
        .build(k)
        .key("sidebar-command-palette");

    let mut items = vec![new_chat, command_palette];

    let pending = pending_input_count(s);
    if pending > 0 {
        let jump_btn = IconButton::new(&icons::ARROW_RIGHT)
            .variant(IconButtonVariant::GhostMuted)
            .control_size(ControlSize::Mini)
            .help("Jump to next chat needing input")
            .on_press_tx(|s: &mut AppState, _| {
                if let Some(tid) = s.threads.iter().find_map(|tr| {
                    s.thread_runtime_by_id
                        .get(&tr.id)
                        .is_some_and(|rt| !rt.pending_interactions.is_empty())
                        .then(|| tr.id.clone())
                }) {
                    s.dispatch(Action::Navigate(NavAction::OpenThread(tid)));
                }
            })
            .build(k)
            .key("sidebar-needs-input-jump");

        items.push(
            SidebarRow::new(if s.shell_ui.needs_input_only {
                "Showing needs input"
            } else {
                "Needs input"
            })
            .icon(&icons::ALERT_TRIANGLE)
            .badge(pending.to_string())
            .status(RowStatus::Attention)
            .selected(s.shell_ui.needs_input_only)
            .trailing(jump_btn)
            .height(30.0)
            .on_select(|s: &mut AppState, _| {
                s.shell_ui.needs_input_only = !s.shell_ui.needs_input_only;
            })
            .build(k)
            .key("sidebar-needs-input"),
        );
    }

    if super::helpers::tasks_feature_enabled(s) {
        items.push(
            SidebarRow::new("Tasks")
                .icon(&icons::CHECK_SQUARE)
                .height(30.0)
                .selected(s.route().view == ViewId::Task)
                .on_select(|s: &mut AppState, _| {
                    s.dispatch(Action::Navigate(NavAction::OpenView(ViewId::Task)));
                })
                .build(k)
                .key("sidebar-tasks-link"),
        );
    }

    items.push(
        SidebarRow::new("Plugins & tools")
            .icon(&icons::PLUGINS)
            .height(30.0)
            .on_select(|s: &mut AppState, _| {
                s.dispatch(Action::Navigate(NavAction::OpenSettings(Some(
                    SettingsPageId::ToolAccess,
                ))));
            })
            .build(k)
            .key("sidebar-plugins-link"),
    );

    let search_input = TextInput::new(&s.sidebar_search_edit)
        .placeholder("Filter chats…")
        .label("Filter sidebar threads and tasks")
        .leading_icon(&icons::SEARCH)
        .width(None)
        .clear_button()
        .on_edit(|s: &mut AppState| &mut s.sidebar_search_edit)
        .on_change(|s: &mut AppState, _| {
            let q = s.sidebar_search_edit.text.clone();
            s.dispatch(Action::Shell(ShellAction::SetSidebarSearch(q)));
        })
        .on_action(|s: &mut AppState, _| {
            s.sidebar_search_edit.clear();
            s.dispatch(Action::Shell(ShellAction::SetSidebarSearch(String::new())));
        })
        .build(k)
        .key("sidebar-filter-input")
        .border(1.0, t.border_muted);

    items.push(
        row()
            .w_full()
            .pt(4.0)
            .gap(4.0)
            .center_y()
            .child(el().grow(1.0).shrink().child(search_input))
            .child(
                IconButton::new(&icons::EXTERNAL_LINK)
                    .variant(IconButtonVariant::GhostMuted)
                    .control_size(ControlSize::Small)
                    .help("Open full search")
                    .shortcut(crate::shortcut_label("Cmd+Shift+F"))
                    .on_press_tx(|s: &mut AppState, _| {
                        s.shell_ui.search_overlay_open = true;
                        s.shell_ui.search_selected = 0;
                        s.shell_ui.search_edit.focused = true;
                    })
                    .build(k)
                    .key("sidebar-open-search-overlay"),
            ),
    );
    items
}

fn build_pinned_section(
    s: &AppState,
    k: &Kit,
    t: &ThemeTokens,
    layer: &mut Vec<El>,
    threads: &[&ThreadRecord],
    active_thread_id: Option<&str>,
) -> Option<SidebarSection> {
    let pinned: Vec<&ThreadRecord> = threads.iter().copied().filter(|tr| tr.pinned).collect();
    if pinned.is_empty() {
        return None;
    }
    let collapsed = s
        .collapsed_sidebar_sections
        .contains(&SidebarSectionKey::Pinned);
    let mut sec = SidebarSection::new("Pinned")
        .key("section-pinned")
        .count(pinned.len())
        .collapsed(collapsed)
        .on_toggle(|s: &mut AppState, _| {
            s.dispatch(Action::Shell(ShellAction::ToggleSidebarSectionCollapsed(
                SidebarSectionKey::Pinned,
            )));
        });
    for tr in pinned {
        sec = sec.row(build_thread_row(
            s,
            k,
            t,
            layer,
            tr,
            active_thread_id == Some(tr.id.as_str()),
            true,
            0,
        ));
    }
    Some(sec)
}

fn build_tasks_section(
    s: &AppState,
    k: &Kit,
    query: &str,
    active_task_id: Option<&str>,
) -> Option<SidebarSection> {
    if !super::helpers::tasks_feature_enabled(s) {
        return None;
    }
    let q = query.trim().to_lowercase();
    let visible: Vec<_> = s
        .tasks
        .iter()
        .filter(|task| q.is_empty() || task.title.to_lowercase().contains(&q))
        .collect();
    if visible.is_empty() {
        return None;
    }
    let collapsed = s
        .collapsed_sidebar_sections
        .contains(&SidebarSectionKey::Tasks);
    let mut sec = SidebarSection::new("Tasks")
        .key("section-tasks")
        .count(visible.len())
        .collapsed(collapsed)
        .on_toggle(|s: &mut AppState, _| {
            s.dispatch(Action::Shell(ShellAction::ToggleSidebarSectionCollapsed(
                SidebarSectionKey::Tasks,
            )));
        });
    for task in visible {
        let task_id = task.id.clone();
        let status = match task.status.as_str() {
            "running" | "in_progress" => Some(RowStatus::Busy),
            "needs_input" | "waiting" | "blocked" => Some(RowStatus::Attention),
            _ => None,
        };
        let mut r = SidebarRow::new(task.title.clone())
            .icon(&icons::CHECK_SQUARE)
            .detail(task.status.clone())
            .selected(s.route().view == ViewId::Task && active_task_id == Some(task.id.as_str()))
            .on_select(move |s: &mut AppState, _| {
                s.dispatch(Action::Navigate(NavAction::OpenTask(task_id.clone())));
            });
        if let Some(st) = status {
            r = r.status(st);
        }
        sec = sec.row(r.build(k).key(format!("task-{}", task.id)));
    }
    Some(sec)
}

#[allow(clippy::too_many_arguments)]
fn build_chats_section(
    s: &AppState,
    k: &Kit,
    t: &ThemeTokens,
    layer: &mut Vec<El>,
    threads: &[&ThreadRecord],
    one_off_ids: &HashSet<&str>,
    primary_one_off: Option<&str>,
    active_thread_id: Option<&str>,
) -> SidebarSection {
    let chat_threads: Vec<&ThreadRecord> = threads
        .iter()
        .copied()
        .filter(|tr| one_off_ids.contains(tr.workspace_id.as_str()))
        .collect();

    let collapsed = s
        .collapsed_sidebar_sections
        .contains(&SidebarSectionKey::Chats);
    let mut sec = SidebarSection::new("Chats")
        .key("section-chats")
        .count(chat_threads.len())
        .collapsed(collapsed)
        .on_toggle(|s: &mut AppState, _| {
            s.dispatch(Action::Shell(ShellAction::ToggleSidebarSectionCollapsed(
                SidebarSectionKey::Chats,
            )));
        });

    let one_off_ws = primary_one_off.map(str::to_string);
    let new_btn = IconButton::new(&icons::PLUS)
        .variant(IconButtonVariant::GhostMuted)
        .control_size(ControlSize::Small)
        .help("New chat")
        .on_press_tx(move |s: &mut AppState, _| {
            s.dispatch(Action::Navigate(NavAction::OpenNewChat {
                workspace_id: one_off_ws.clone(),
            }));
        })
        .build(k)
        .key("new-oneoff-chat");
    sec = sec.action(new_btn);

    if chat_threads.is_empty() {
        let placeholder = row().key("chats-empty").px(12.0).py(6.0).child(
            text("No quick chats yet")
                .font(k.ty.small)
                .color(k.c.text_faint),
        );
        return sec.row(placeholder);
    }

    let search_active = !s.sidebar_search.trim().is_empty();
    let show_count = if search_active || s.shell_ui.chats_expanded {
        chat_threads.len()
    } else {
        MAX_THREADS_PER_WORKSPACE
    };

    for tr in chat_threads.iter().take(show_count) {
        sec = sec.row(build_thread_row(
            s,
            k,
            t,
            layer,
            tr,
            active_thread_id == Some(tr.id.as_str()),
            false,
            0,
        ));
    }

    if !search_active && chat_threads.len() > MAX_THREADS_PER_WORKSPACE {
        let label = if s.shell_ui.chats_expanded {
            "Show less".to_string()
        } else {
            format!(
                "Show {} more",
                chat_threads.len() - MAX_THREADS_PER_WORKSPACE
            )
        };
        sec = sec.row(
            SidebarRow::new(label)
                .depth(0)
                .height(26.0)
                .on_select(|s: &mut AppState, _| {
                    s.shell_ui.chats_expanded = !s.shell_ui.chats_expanded;
                })
                .build(k)
                .key("chats-show-more"),
        );
    }
    sec
}

#[allow(clippy::too_many_arguments)]
fn build_workspaces_section(
    s: &AppState,
    k: &Kit,
    t: &ThemeTokens,
    layer: &mut Vec<El>,
    mut sb: Sidebar,
    projects: &[&WorkspaceRecord],
    threads: &[&ThreadRecord],
    active_thread_id: Option<&str>,
) -> Sidebar {
    let section_collapsed = s
        .collapsed_sidebar_sections
        .contains(&SidebarSectionKey::Workspaces);
    if projects.is_empty() {
        let empty = SidebarSection::new("Projects")
            .key("section-projects")
            .count(0)
            .collapsed(section_collapsed)
            .on_toggle(|s: &mut AppState, _| {
                s.dispatch(Action::Shell(ShellAction::ToggleSidebarSectionCollapsed(
                    SidebarSectionKey::Workspaces,
                )));
            })
            .row(
                SidebarRow::new("Open project folder…")
                    .icon(&icons::FOLDER_PLUS)
                    .on_select(|s: &mut AppState, _| {
                        s.dispatch(Action::Native(NativeAction::PickWorkspaceFolder));
                    })
                    .build(k)
                    .key("projects-empty-add"),
            );
        return sb.section(empty);
    }

    let mut projects_header = SidebarSection::new("Projects")
        .key("section-projects")
        .count(projects.len())
        .collapsed(section_collapsed)
        .on_toggle(|s: &mut AppState, _| {
            s.dispatch(Action::Shell(ShellAction::ToggleSidebarSectionCollapsed(
                SidebarSectionKey::Workspaces,
            )));
        })
        .action(
            IconButton::new(&icons::PLUS)
                .variant(IconButtonVariant::GhostMuted)
                .control_size(ControlSize::Small)
                .help("Add project folder")
                .on_press_tx(|s: &mut AppState, _| {
                    s.dispatch(Action::Native(NativeAction::PickWorkspaceFolder));
                })
                .build(k)
                .key("projects-add-btn"),
        );

    let project_count = projects.len();
    for (idx, ws) in projects.iter().enumerate() {
        let ws_id = ws.id.clone();
        let ws_id_new = ws.id.clone();
        let collapsed = s.collapsed_workspace_ids.contains(&ws.id);
        let is_active_ws = s.active_workspace_id.as_deref() == Some(ws.id.as_str());
        let badge_col = workspace_badge_color(&ws.id, t);
        let ws_threads: Vec<&ThreadRecord> = threads
            .iter()
            .copied()
            .filter(|tr| tr.workspace_id == ws.id)
            .collect();

        let ws_row = SidebarRow::new(ws.name.clone())
            .avatar(workspace_avatar(&ws.name, badge_col, k, t))
            .detail(ws_threads.len().to_string())
            .selected(is_active_ws && active_thread_id.is_none())
            .trailing(
                IconButton::new(&icons::PLUS)
                    .variant(IconButtonVariant::GhostMuted)
                    .control_size(ControlSize::Mini)
                    .help("New chat in workspace")
                    .on_press_tx(move |s: &mut AppState, _| {
                        s.dispatch(Action::Navigate(NavAction::OpenNewChat {
                            workspace_id: Some(ws_id_new.clone()),
                        }));
                    })
                    .build(k)
                    .key(format!("ws-new-chat-{}", ws.id)),
            )
            .reorder(
                &s.shell_ui.sidebar_reorder,
                idx,
                project_count,
                |s: &mut AppState| &mut s.shell_ui.sidebar_reorder,
                |s: &mut AppState, from, to| {
                    let order = reorder_project_workspaces(s, from, to);
                    if !order.is_empty() {
                        s.dispatch(Action::Shell(ShellAction::ReorderWorkspaces(order)));
                    }
                },
            )
            .on_select(move |s: &mut AppState, _| {
                s.dispatch(Action::Shell(ShellAction::ToggleWorkspaceCollapsed(
                    ws_id.clone(),
                )));
            })
            .build(k)
            .key(format!("ws-{}", ws.id));

        projects_header = projects_header.row(ws_row);

        if !collapsed {
            let search_active = !s.sidebar_search.trim().is_empty();
            let expanded = s.shell_ui.expanded_thread_workspaces.contains(&ws.id);
            let show_count = if search_active || expanded {
                ws_threads.len()
            } else {
                MAX_THREADS_PER_WORKSPACE
            };
            for tr in ws_threads.iter().take(show_count) {
                projects_header = projects_header.row(build_thread_row(
                    s,
                    k,
                    t,
                    layer,
                    tr,
                    active_thread_id == Some(tr.id.as_str()),
                    false,
                    1,
                ));
            }
            if !search_active && ws_threads.len() > MAX_THREADS_PER_WORKSPACE {
                let ws_toggle = ws.id.clone();
                let label = if expanded {
                    "Show less".to_string()
                } else {
                    format!("Show {} more", ws_threads.len() - MAX_THREADS_PER_WORKSPACE)
                };
                projects_header = projects_header.row(
                    SidebarRow::new(label)
                        .depth(1)
                        .height(26.0)
                        .on_select(move |s: &mut AppState, _| {
                            if !s.shell_ui.expanded_thread_workspaces.remove(&ws_toggle) {
                                s.shell_ui
                                    .expanded_thread_workspaces
                                    .insert(ws_toggle.clone());
                            }
                        })
                        .build(k)
                        .key(format!("ws-more-{}", ws.id)),
                );
            }
        }
    }

    sb = sb.section(projects_header);
    sb
}

pub(crate) fn reorder_project_workspaces(s: &AppState, from: usize, to: usize) -> Vec<String> {
    let ordered = s.resolve_workspace_display_targets();
    let mut project_ids: Vec<String> = ordered
        .iter()
        .filter(|w| !w.one_off_chat)
        .map(|w| w.id.clone())
        .collect();
    if from >= project_ids.len() || to >= project_ids.len() || from == to {
        return Vec::new();
    }
    let moved = project_ids.remove(from);
    project_ids.insert(to, moved);
    for ws in ordered.iter().filter(|w| w.one_off_chat) {
        project_ids.push(ws.id.clone());
    }
    project_ids
}

/// Selects whichever foreground (white or theme dark ink) maximizes contrast against a badge fill.
fn workspace_avatar_fg(fill: Color, t: &ThemeTokens) -> Color {
    let dark_ink = if t.dark { t.app_bg } else { t.text_base };
    if contrast_ratio(Color::WHITE, fill) >= contrast_ratio(dark_ink, fill) {
        Color::WHITE
    } else {
        dark_ink
    }
}

fn workspace_avatar(name: &str, fill: Color, k: &Kit, t: &ThemeTokens) -> El {
    let ch = name
        .chars()
        .find(|c| !c.is_whitespace())
        .unwrap_or('W')
        .to_ascii_uppercase()
        .to_string();
    row()
        .size(16.0, 16.0)
        .radius(4.0)
        .center()
        .fill(fill)
        .child(
            text(ch)
                .font(TextStyle {
                    size: 10.0,
                    ..k.ty.small_medium
                })
                .color(workspace_avatar_fg(fill, t)),
        )
}

#[allow(clippy::too_many_arguments)]
fn build_thread_row(
    s: &AppState,
    k: &Kit,
    t: &ThemeTokens,
    layer: &mut Vec<El>,
    tr: &ThreadRecord,
    selected: bool,
    show_workspace_avatar: bool,
    depth: u8,
) -> El {
    let title = if tr.title.trim().is_empty() {
        "Untitled chat".to_string()
    } else {
        tr.title.clone()
    };
    let age = format_relative_age(tr.updated_at, s.now_secs);
    let tid_select = tr.id.clone();
    let tid_archive = tr.id.clone();
    let tid_ctx = tr.id.clone();

    let mut r = SidebarRow::new(title.clone())
        .depth(depth)
        .selected(selected)
        .on_select(move |s: &mut AppState, _| {
            s.dispatch(Action::Navigate(NavAction::OpenThread(tid_select.clone())));
        })
        .on_close(move |s: &mut AppState, _| {
            s.dispatch(Action::Chat(ChatAction::ArchiveThread(tid_archive.clone())));
        });

    if s.shell_ui.renaming_thread_id.as_deref() == Some(tr.id.as_str()) {
        let tid_commit = tr.id.clone();
        r = r.renaming(
            &s.shell_ui.rename_edit,
            |s: &mut AppState| &mut s.shell_ui.rename_edit,
            move |s: &mut AppState, _| {
                let next_title = s.shell_ui.rename_edit.text.trim().to_string();
                s.shell_ui.renaming_thread_id = None;
                if !next_title.is_empty() {
                    s.dispatch(Action::Chat(ChatAction::RenameThread {
                        thread_id: tid_commit.clone(),
                        title: next_title,
                    }));
                }
            },
            |s: &mut AppState, _| {
                s.shell_ui.renaming_thread_id = None;
            },
        );
    }

    if show_workspace_avatar {
        if let Some(ws) = s.workspaces.iter().find(|w| w.id == tr.workspace_id) {
            r = r.avatar(workspace_avatar(
                &ws.name,
                workspace_badge_color(&ws.id, t),
                k,
                t,
            ));
        } else {
            r = r.icon(&icons::PIN);
        }
    } else {
        r = r.icon(&icons::MESSAGE);
    }

    if !age.is_empty() {
        r = r.detail(age);
    }
    if let Some(status) = thread_row_status(s, &tr.id) {
        r = r.status(status);
    }

    let row_el = r
        .build(k)
        .key(format!("thread-{}", tr.id))
        .on_secondary_press(move |s: &mut AppState, pt, _| {
            s.shell_ui.context_menu_thread_id = Some(tid_ctx.clone());
            s.shell_ui.context_menu_point = Some(pt);
        });

    if s.shell_ui.context_menu_thread_id.as_deref() == Some(tr.id.as_str())
        && let Some(pt) = s.shell_ui.context_menu_point
    {
        let tid_rename = tr.id.clone();
        let current_title = title;
        let tid_pin = tr.id.clone();
        let next_pin = !tr.pinned;
        let tid_fork = tr.id.clone();
        let tid_arch = tr.id.clone();
        let tid_del = tr.id.clone();

        Menu::new(format!("thread-ctx-{}", tr.id))
            .standard()
            .at(pt.x, pt.y)
            .open(true)
            .on_close(|s: &mut AppState| {
                s.shell_ui.context_menu_thread_id = None;
                s.shell_ui.context_menu_point = None;
            })
            .item(MenuItem::new("Rename").icon(&icons::FILE_TEXT).on_select(
                move |s: &mut AppState| {
                    s.shell_ui.context_menu_thread_id = None;
                    s.shell_ui.context_menu_point = None;
                    s.shell_ui.renaming_thread_id = Some(tid_rename.clone());
                    s.shell_ui.rename_edit.replace_text(&current_title);
                    s.shell_ui.rename_edit.focused = true;
                },
            ))
            .item(
                MenuItem::new(if tr.pinned { "Unpin chat" } else { "Pin chat" })
                    .icon(&icons::PIN)
                    .on_select(move |s: &mut AppState| {
                        s.shell_ui.context_menu_thread_id = None;
                        s.shell_ui.context_menu_point = None;
                        s.dispatch(Action::Chat(ChatAction::SetThreadPinned {
                            thread_id: tid_pin.clone(),
                            pinned: next_pin,
                        }));
                    }),
            )
            .item(
                MenuItem::new("New branch from here")
                    .icon(&icons::SPARKLES)
                    .on_select(move |s: &mut AppState| {
                        s.shell_ui.context_menu_thread_id = None;
                        s.shell_ui.context_menu_point = None;
                        s.dispatch(Action::Chat(ChatAction::ForkThread {
                            thread_id: tid_fork.clone(),
                            turn_id: None,
                        }));
                    }),
            )
            .item(MenuItem::new("Archive").on_select(move |s: &mut AppState| {
                s.shell_ui.context_menu_thread_id = None;
                s.shell_ui.context_menu_point = None;
                s.dispatch(Action::Chat(ChatAction::ArchiveThread(tid_arch.clone())));
            }))
            .separator()
            .item(
                MenuItem::new("Delete permanently...")
                    .danger(true)
                    .on_select(move |s: &mut AppState| {
                        s.shell_ui.context_menu_thread_id = None;
                        s.shell_ui.context_menu_point = None;
                        s.shell_ui.pending_delete_thread_id = Some(tid_del.clone());
                    }),
            )
            .build(k, layer);
    }

    row_el
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reorder_project_workspaces_preserves_one_off_chats() {
        let mut s = AppState::default();
        s.workspaces.push(WorkspaceRecord {
            id: "ws-a".into(),
            name: "Alpha".into(),
            path: "/tmp/a".into(),
            ..Default::default()
        });
        s.workspaces.push(WorkspaceRecord {
            id: "oneoff".into(),
            name: "Chats".into(),
            path: "/tmp/chats".into(),
            one_off_chat: true,
            ..Default::default()
        });
        s.workspaces.push(WorkspaceRecord {
            id: "ws-b".into(),
            name: "Beta".into(),
            path: "/tmp/b".into(),
            ..Default::default()
        });
        s.workspace_order = vec!["ws-a".into(), "oneoff".into(), "ws-b".into()];

        let next = reorder_project_workspaces(&s, 0, 1);
        assert_eq!(next, vec!["ws-b", "ws-a", "oneoff"]);
    }

    #[test]
    fn workspace_avatar_fg_picks_contrast_safe_ink_across_badges() {
        for dark in [false, true] {
            let tok = crate::theme::tokens(dark);
            for (idx, badge) in tok.search_badges.iter().enumerate() {
                let fg = workspace_avatar_fg(*badge, &tok);
                let chosen = contrast_ratio(fg, *badge);
                let white_only = contrast_ratio(Color::WHITE, *badge);
                assert!(
                    chosen >= white_only && chosen >= 3.9,
                    "badge[{idx}] dark={dark} chosen contrast {chosen:.2} (white={white_only:.2})"
                );
            }
        }
    }
}
