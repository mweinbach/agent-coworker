//! Left workspace, thread, task, and chat navigation sidebar.
//!
//! Ported from `apps/desktop/src/ui/Sidebar.tsx`, `src/ui/sidebar/`, and `sidebarHelpers.ts`.

use std::collections::HashSet;

use rune::{El, col, el, row, text};
use rune_kit::shell::{RowStatus, Sidebar, SidebarRow, SidebarSection};
use rune_kit::{ControlSize, IconButton, IconButtonVariant, Kit, Menu, MenuItem};

use crate::actions::{Action, ChatAction, NativeAction, NavAction, ShellAction, SidebarSectionKey};
use crate::router::{SettingsPageId, ViewId};
use crate::state::{AppState, ThreadRecord, WorkspaceRecord};
use crate::theme::ThemeTokens;
use crate::views::shell::helpers::{
    filtered_threads, pending_input_count, split_workspaces, thread_row_status,
};
use crate::views::shell::icons;

const MAX_THREADS_PER_WORKSPACE: usize = 5;
/// Row height for every sidebar row: one quiet line of text.
const ROW_H: f32 = 28.0;
/// Space between sections, so each reads as its own group without dividers.
const SECTION_GAP: f32 = 10.0;

/// Renders the left application sidebar with quick actions and ordered sections.
///
/// Deliberately quiet: rows are a single line of text, chat rows carry no icons, ages or
/// counts, and per-row actions only appear under the pointer. Live state (working, needs input,
/// unread) still shows as a small status mark at the row's end.
pub fn build_sidebar(s: &AppState, k: &Kit, _t: &ThemeTokens, layer: &mut Vec<El>) -> El {
    let mut sb = Sidebar::new()
        .label("Workspace navigation")
        .inset(4.0)
        .header_gap(1.0)
        .header_padding(0.0, SECTION_GAP)
        .row_gap(1.0);

    for item in build_header_items(s, k) {
        sb = sb.header(item);
    }

    let query = s.sidebar_search.as_str();
    let pending_filter = s.shell_ui.needs_input_only && pending_input_count(s) > 0;
    let threads = filtered_threads(s, query, pending_filter);
    let (projects, one_off_ids, primary_one_off) = split_workspaces(s);
    let active_thread_id = s.route().active_thread_id.as_deref();
    let active_task_id = s.route().active_task_id.as_deref();

    let mut first_section = true;
    let mut gap = |sb: Sidebar| -> Sidebar {
        if std::mem::take(&mut first_section) {
            sb
        } else {
            sb.child(el().h(SECTION_GAP).a11y_hidden())
        }
    };

    for section_key in &s.desktop_settings.sidebar_section_order {
        match section_key {
            SidebarSectionKey::Pinned => {
                if let Some(sec) = build_pinned_section(s, k, layer, &threads, active_thread_id) {
                    sb = gap(sb).section(sec);
                }
            }
            SidebarSectionKey::Tasks => {
                if let Some(sec) = build_tasks_section(s, k, query, active_task_id) {
                    sb = gap(sb).section(sec);
                }
            }
            SidebarSectionKey::Chats => {
                sb = gap(sb).section(build_chats_section(
                    s,
                    k,
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
                    layer,
                    gap(sb),
                    &projects,
                    &threads,
                    active_thread_id,
                );
            }
        }
    }

    let footer = col().key("sidebar-footer-actions").w_full().child(
        SidebarRow::new("Settings")
            .icon(&icons::SETTINGS)
            .height(ROW_H)
            .selected(s.route().view == ViewId::Settings)
            .on_select(|s: &mut AppState, tx| {
                s.dispatch_tx(Action::Navigate(NavAction::OpenSettings(None)), tx);
            })
            .build(k)
            .key("sidebar-settings"),
    );

    sb.footer(footer)
        .build(k)
        .key("workspace-nav-rail")
        .transition(rune::Transition::none())
}

fn build_header_items(s: &AppState, k: &Kit) -> Vec<El> {
    let new_chat = SidebarRow::new("New chat")
        .icon(&icons::PLUS)
        .detail(crate::shortcut_label("Cmd+N"))
        .height(ROW_H)
        .on_select(|s: &mut AppState, tx| {
            let ws = s.active_workspace_id.clone();
            s.dispatch_tx(
                Action::Navigate(NavAction::OpenNewChat { workspace_id: ws }),
                tx,
            );
        })
        .build(k)
        .key("sidebar-new-chat");

    let search = SidebarRow::new("Search")
        .icon(&icons::SEARCH)
        .height(ROW_H)
        .on_select(|s: &mut AppState, _| {
            super::palette::open_command_palette(s);
        })
        .build(k)
        .key("sidebar-command-palette");

    let mut items = vec![new_chat, search];

    let pending = pending_input_count(s);
    if pending > 0 {
        items.push(
            SidebarRow::new(if s.shell_ui.needs_input_only {
                "Showing needs input"
            } else {
                "Needs input"
            })
            .icon(&icons::ALERT_TRIANGLE)
            .detail(pending.to_string())
            .status(RowStatus::Attention)
            .selected(s.shell_ui.needs_input_only)
            .height(ROW_H)
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
                .height(ROW_H)
                .selected(s.route().view == ViewId::Task)
                .on_select(|s: &mut AppState, tx| {
                    s.dispatch_tx(Action::Navigate(NavAction::OpenView(ViewId::Task)), tx);
                })
                .build(k)
                .key("sidebar-tasks-link"),
        );
    }

    items.push(
        SidebarRow::new("Plugins & tools")
            .icon(&icons::PLUGINS)
            .height(ROW_H)
            .on_select(|s: &mut AppState, tx| {
                s.dispatch_tx(
                    Action::Navigate(NavAction::OpenSettings(Some(SettingsPageId::ToolAccess))),
                    tx,
                );
            })
            .build(k)
            .key("sidebar-plugins-link"),
    );

    items
}

/// A small "+" that only shows while the pointer is on its row or section header.
fn hover_add_button(
    k: &Kit,
    help: &'static str,
    key: String,
    on_press: impl Fn(&mut AppState, &mut rune::Tx) + 'static,
) -> El {
    IconButton::new(&icons::PLUS)
        .variant(IconButtonVariant::GhostMuted)
        .control_size(ControlSize::Mini)
        .help(help)
        .on_press_tx(on_press)
        .build(k)
        .key(key)
        .group_opacity(0.0, 1.0)
}

/// Where a thread row sits: at a section's top level, or nested under a project row.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ThreadIndent {
    /// Label aligned with the section title, like the chats list.
    TopLevel,
    /// Label aligned with its project's name (past the project's folder icon).
    UnderProject,
}

fn toggle_section(key: SidebarSectionKey) -> impl Fn(&mut AppState, &mut rune::Tx) + 'static {
    move |s: &mut AppState, _| {
        s.dispatch(Action::Shell(ShellAction::ToggleSidebarSectionCollapsed(
            key,
        )));
    }
}

/// A faint "Show N more" / "Show less" row under a list.
fn show_more_row(
    k: &Kit,
    label: String,
    indent: ThreadIndent,
    key: String,
    on_select: impl Fn(&mut AppState, &mut rune::Tx) + 'static,
) -> El {
    let mut r = SidebarRow::new(label)
        .title_style(k.ty.small)
        .height(24.0)
        .on_select(on_select);
    if indent == ThreadIndent::UnderProject {
        r = r.avatar(el().size(16.0, 16.0));
    }
    r.build(k).key(key)
}

fn build_pinned_section(
    s: &AppState,
    k: &Kit,
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
        .collapsed(collapsed)
        .on_toggle(toggle_section(SidebarSectionKey::Pinned));
    for tr in pinned {
        sec = sec.row(build_thread_row(
            s,
            k,
            layer,
            tr,
            active_thread_id == Some(tr.id.as_str()),
            ThreadIndent::TopLevel,
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
        .collapsed(collapsed)
        .on_toggle(toggle_section(SidebarSectionKey::Tasks));
    for task in visible {
        let task_id = task.id.clone();
        let status = match task.status.as_str() {
            "running" | "in_progress" => Some(RowStatus::Busy),
            "needs_input" | "waiting" | "blocked" => Some(RowStatus::Attention),
            _ => None,
        };
        let mut r = SidebarRow::new(task.title.clone())
            .height(ROW_H)
            .selected(s.route().view == ViewId::Task && active_task_id == Some(task.id.as_str()))
            .on_select(move |s: &mut AppState, tx| {
                s.dispatch_tx(Action::Navigate(NavAction::OpenTask(task_id.clone())), tx);
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
    let one_off_ws = primary_one_off.map(str::to_string);
    let mut sec = SidebarSection::new("Chats")
        .key("section-chats")
        .collapsed(collapsed)
        .on_toggle(toggle_section(SidebarSectionKey::Chats))
        .action(section_add_button(
            k,
            "New chat",
            "new-oneoff-chat",
            move |s, tx| {
                s.dispatch_tx(
                    Action::Navigate(NavAction::OpenNewChat {
                        workspace_id: one_off_ws.clone(),
                    }),
                    tx,
                );
            },
        ));

    if chat_threads.is_empty() {
        let placeholder = row()
            .key("chats-empty")
            .px(8.0)
            .h(ROW_H)
            .center_y()
            .child(text("No chats yet").font(k.ty.small).color(k.c.text_faint));
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
            layer,
            tr,
            active_thread_id == Some(tr.id.as_str()),
            ThreadIndent::TopLevel,
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
        sec = sec.row(show_more_row(
            k,
            label,
            ThreadIndent::TopLevel,
            "chats-show-more".into(),
            |s: &mut AppState, _| {
                s.shell_ui.chats_expanded = !s.shell_ui.chats_expanded;
            },
        ));
    }
    sec
}

/// A small "+" on a section header. Section headers don't track hover, so it stays visible,
/// but faint and mini-sized so it doesn't compete with the rows.
fn section_add_button(
    k: &Kit,
    help: &'static str,
    key: &'static str,
    on_press: impl Fn(&mut AppState, &mut rune::Tx) + 'static,
) -> El {
    IconButton::new(&icons::PLUS)
        .variant(IconButtonVariant::GhostMuted)
        .control_size(ControlSize::Mini)
        .help(help)
        .on_press_tx(on_press)
        .build(k)
        .key(key)
}

#[allow(clippy::too_many_arguments)]
fn build_workspaces_section(
    s: &AppState,
    k: &Kit,
    layer: &mut Vec<El>,
    mut sb: Sidebar,
    projects: &[&WorkspaceRecord],
    threads: &[&ThreadRecord],
    active_thread_id: Option<&str>,
) -> Sidebar {
    let section_collapsed = s
        .collapsed_sidebar_sections
        .contains(&SidebarSectionKey::Workspaces);
    let mut projects_header = SidebarSection::new("Projects")
        .key("section-projects")
        .collapsed(section_collapsed)
        .on_toggle(toggle_section(SidebarSectionKey::Workspaces))
        .action(section_add_button(
            k,
            "Add project folder",
            "projects-add-btn",
            |s, _| s.dispatch(Action::Native(NativeAction::PickWorkspaceFolder)),
        ));

    if projects.is_empty() {
        let empty = projects_header.row(
            SidebarRow::new("Add a project folder…")
                .icon(&icons::FOLDER_PLUS)
                .height(ROW_H)
                .on_select(|s: &mut AppState, _| {
                    s.dispatch(Action::Native(NativeAction::PickWorkspaceFolder));
                })
                .build(k)
                .key("projects-empty-add"),
        );
        return sb.section(empty);
    }

    let project_count = projects.len();
    for (idx, ws) in projects.iter().enumerate() {
        let ws_id = ws.id.clone();
        let ws_id_new = ws.id.clone();
        let search_active = !s.sidebar_search.trim().is_empty();
        let collapsed = !search_active && s.collapsed_workspace_ids.contains(&ws.id);
        let is_active_ws = s.active_workspace_id.as_deref() == Some(ws.id.as_str());
        let ws_threads: Vec<&ThreadRecord> = threads
            .iter()
            .copied()
            .filter(|tr| tr.workspace_id == ws.id)
            .collect();

        let ws_id_toggle = ws.id.clone();
        let disclosure = IconButton::new(if collapsed {
            &rune_kit::glyphs::FOLDER
        } else {
            &rune_kit::glyphs::FOLDER_OPEN
        })
        .variant(IconButtonVariant::GhostMuted)
        .control_size(ControlSize::Regular)
        .disabled(search_active)
        .help(format!(
            "{} {}",
            if collapsed { "Expand" } else { "Collapse" },
            ws.name
        ))
        .on_press(move |s: &mut AppState| {
            s.dispatch(Action::Shell(ShellAction::ToggleWorkspaceCollapsed(
                ws_id_toggle.clone(),
            )));
        })
        .build(k)
        .expanded(!collapsed)
        .key(format!("ws-toggle-{}", ws.id));

        let ws_row = SidebarRow::new(ws.name.clone())
            .height(ROW_H)
            .selected(is_active_ws && active_thread_id.is_none())
            .trailing(hover_add_button(
                k,
                "New chat in project",
                format!("ws-new-chat-{}", ws.id),
                move |s, tx| {
                    s.dispatch_tx(
                        Action::Navigate(NavAction::OpenNewChat {
                            workspace_id: Some(ws_id_new.clone()),
                        }),
                        tx,
                    );
                },
            ))
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
            .on_select(move |s: &mut AppState, tx| {
                s.dispatch_tx(
                    Action::Navigate(NavAction::SelectWorkspace(ws_id.clone())),
                    tx,
                );
            })
            .build(k)
            .grow(1.0)
            .shrink()
            .min_w(0.0)
            .pl(2.0)
            .key(format!("ws-{}", ws.id));

        projects_header = projects_header.row(
            row()
                .w_full()
                .pl(4.0)
                .center_y()
                .child(disclosure)
                .child(ws_row),
        );

        if !collapsed {
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
                    layer,
                    tr,
                    active_thread_id == Some(tr.id.as_str()),
                    ThreadIndent::UnderProject,
                ));
            }
            if !search_active && ws_threads.len() > MAX_THREADS_PER_WORKSPACE {
                let ws_toggle = ws.id.clone();
                let label = if expanded {
                    "Show less".to_string()
                } else {
                    format!("Show {} more", ws_threads.len() - MAX_THREADS_PER_WORKSPACE)
                };
                projects_header = projects_header.row(show_more_row(
                    k,
                    label,
                    ThreadIndent::UnderProject,
                    format!("ws-more-{}", ws.id),
                    move |s: &mut AppState, _| {
                        if !s.shell_ui.expanded_thread_workspaces.remove(&ws_toggle) {
                            s.shell_ui
                                .expanded_thread_workspaces
                                .insert(ws_toggle.clone());
                        }
                    },
                ));
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

/// One chat: its title, plus a status mark only while it is working, waiting on the user or
/// unread. Archive appears under the pointer; everything else is on the context menu.
fn build_thread_row(
    s: &AppState,
    k: &Kit,
    layer: &mut Vec<El>,
    tr: &ThreadRecord,
    selected: bool,
    indent: ThreadIndent,
) -> El {
    let title = if tr.title.trim().is_empty() {
        "Untitled chat".to_string()
    } else {
        tr.title.clone()
    };
    let tid_select = tr.id.clone();
    let tid_archive = tr.id.clone();
    let tid_ctx = tr.id.clone();

    let mut r = SidebarRow::new(title.clone())
        .height(ROW_H)
        .selected(selected)
        .on_select(move |s: &mut AppState, tx| {
            s.dispatch_tx(
                Action::Navigate(NavAction::OpenThread(tid_select.clone())),
                tx,
            );
        })
        .on_close(move |s: &mut AppState, _| {
            s.dispatch(Action::Chat(ChatAction::ArchiveThread(tid_archive.clone())));
        });
    if indent == ThreadIndent::UnderProject {
        // An empty lead slot lines the title up with the project name above it.
        r = r.avatar(el().size(16.0, 16.0));
    }

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
}
