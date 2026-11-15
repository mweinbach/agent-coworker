//! Left workspace, thread, task, and chat navigation sidebar.
//!
//! Ported from `apps/desktop/src/ui/Sidebar.tsx`, `src/ui/sidebar/`, and `sidebarHelpers.ts`.

use std::collections::HashSet;

use rune::{Color, El, TextStyle, col, el, row, text};
use rune_kit::shell::{RowStatus, Sidebar, SidebarRow, SidebarSection};
use rune_kit::{ControlSize, IconButton, IconButtonVariant, Kit, TextInput};

use crate::actions::{Action, ChatAction, NativeAction, NavAction, ShellAction, SidebarSectionKey};
use crate::router::{SettingsPageId, ViewId};
use crate::state::{AppState, ThreadRecord, WorkspaceRecord};
use crate::theme::ThemeTokens;
use crate::views::shell::helpers::{
    filtered_threads, format_relative_age, pending_input_count, split_workspaces,
    thread_row_status, workspace_badge_color,
};
use crate::views::shell::icons;

const MAX_THREADS_PER_WORKSPACE: usize = 5;

/// Renders the left application sidebar with quick actions, search filter, and ordered sections.
pub fn build_sidebar(s: &AppState, k: &Kit, t: &ThemeTokens) -> El {
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
    let threads = filtered_threads(s, query, false);
    let (projects, one_off_ids, primary_one_off) = split_workspaces(s);
    let active_thread_id = s.route().active_thread_id.as_deref();
    let active_task_id = s.route().active_task_id.as_deref();

    for section_key in &s.desktop_settings.sidebar_section_order {
        match section_key {
            SidebarSectionKey::Pinned => {
                if let Some(sec) = build_pinned_section(s, k, t, &threads, active_thread_id) {
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
                    &threads,
                    &one_off_ids,
                    primary_one_off,
                    active_thread_id,
                ));
            }
            SidebarSectionKey::Workspaces => {
                sb = build_workspaces_section(s, k, t, sb, &projects, &threads, active_thread_id);
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
        .detail("⌘N")
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
        .detail("⌘K")
        .height(30.0)
        .on_select(|s: &mut AppState, _| {
            s.dispatch(Action::Shell(ShellAction::SetCommandPaletteOpen(true)));
        })
        .build(k)
        .key("sidebar-command-palette");

    let mut items = vec![new_chat, command_palette];

    let pending = pending_input_count(s);
    if pending > 0 {
        items.push(
            SidebarRow::new("Needs input")
                .icon(&icons::ALERT_TRIANGLE)
                .badge(pending.to_string())
                .status(RowStatus::Attention)
                .height(30.0)
                .on_select(|s: &mut AppState, _| {
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
                .key("sidebar-needs-input"),
        );
    }

    let tasks_enabled = s
        .feature_flags
        .get("tasks_enabled")
        .copied()
        .unwrap_or(true);
    if tasks_enabled || !s.tasks.is_empty() {
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

    items.push(col().w_full().pt(4.0).child(search_input));
    items
}

fn build_pinned_section(
    s: &AppState,
    k: &Kit,
    t: &ThemeTokens,
    threads: &[&ThreadRecord],
    active_thread_id: Option<&str>,
) -> Option<SidebarSection> {
    let pinned: Vec<&ThreadRecord> = threads.iter().copied().filter(|tr| tr.pinned).collect();
    if pinned.is_empty() {
        return None;
    }
    let mut sec = SidebarSection::new("Pinned")
        .key("section-pinned")
        .count(pinned.len());
    for tr in pinned {
        sec = sec.row(thread_row(
            s,
            k,
            t,
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
    let q = query.trim().to_lowercase();
    let visible: Vec<_> = s
        .tasks
        .iter()
        .filter(|task| q.is_empty() || task.title.to_lowercase().contains(&q))
        .collect();
    if visible.is_empty() {
        return None;
    }
    let mut sec = SidebarSection::new("Tasks")
        .key("section-tasks")
        .count(visible.len());
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

fn build_chats_section(
    s: &AppState,
    k: &Kit,
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

    let mut sec = SidebarSection::new("Chats")
        .key("section-chats")
        .count(chat_threads.len());

    if let Some(one_off_ws) = primary_one_off.map(str::to_string) {
        let new_btn = IconButton::new(&icons::PLUS)
            .variant(IconButtonVariant::GhostMuted)
            .control_size(ControlSize::Small)
            .help("New chat")
            .on_press_tx(move |s: &mut AppState, _| {
                s.dispatch(Action::Navigate(NavAction::OpenNewChat {
                    workspace_id: Some(one_off_ws.clone()),
                }));
            })
            .build(k)
            .key("new-oneoff-chat");
        sec = sec.action(new_btn);
    }

    if chat_threads.is_empty() {
        let placeholder = row().key("chats-empty").px(12.0).py(6.0).child(
            text("No quick chats yet")
                .font(k.ty.small)
                .color(k.c.text_faint),
        );
        return sec.row(placeholder);
    }

    for tr in chat_threads {
        sec = sec.row(thread_row_plain(
            s,
            k,
            tr,
            active_thread_id == Some(tr.id.as_str()),
            0,
        ));
    }
    sec
}

fn build_workspaces_section(
    s: &AppState,
    k: &Kit,
    t: &ThemeTokens,
    mut sb: Sidebar,
    projects: &[&WorkspaceRecord],
    threads: &[&ThreadRecord],
    active_thread_id: Option<&str>,
) -> Sidebar {
    if projects.is_empty() {
        let empty = SidebarSection::new("Projects")
            .key("section-projects")
            .count(0)
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

    for ws in projects {
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
            .avatar(workspace_avatar(&ws.name, badge_col, k))
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
            .on_select(move |s: &mut AppState, _| {
                s.dispatch(Action::Shell(ShellAction::ToggleWorkspaceCollapsed(
                    ws_id.clone(),
                )));
            })
            .build(k)
            .key(format!("ws-{}", ws.id));

        projects_header = projects_header.row(ws_row);

        if !collapsed {
            let show_count = if s.sidebar_search.trim().is_empty() {
                MAX_THREADS_PER_WORKSPACE
            } else {
                ws_threads.len()
            };
            for tr in ws_threads.iter().take(show_count) {
                projects_header = projects_header.row(thread_row_plain(
                    s,
                    k,
                    tr,
                    active_thread_id == Some(tr.id.as_str()),
                    1,
                ));
            }
            if ws_threads.len() > show_count {
                let remaining = ws_threads.len() - show_count;
                projects_header = projects_header.row(
                    el().key(format!("ws-more-{}", ws.id))
                        .pl(28.0)
                        .py(4.0)
                        .child(
                            text(format!("{remaining} more threads in search (⌘K)"))
                                .font(k.ty.small)
                                .color(k.c.text_faint),
                        ),
                );
            }
        }
    }

    sb = sb.section(projects_header);
    sb
}

fn workspace_avatar(name: &str, fill: Color, k: &Kit) -> El {
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
                .color(Color::WHITE),
        )
}

fn thread_row(
    s: &AppState,
    k: &Kit,
    t: &ThemeTokens,
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

    let mut r = SidebarRow::new(title)
        .depth(depth)
        .selected(selected)
        .on_select(move |s: &mut AppState, _| {
            s.dispatch(Action::Navigate(NavAction::OpenThread(tid_select.clone())));
        })
        .on_close(move |s: &mut AppState, _| {
            s.dispatch(Action::Chat(ChatAction::ArchiveThread(tid_archive.clone())));
        });

    if show_workspace_avatar {
        if let Some(ws) = s.workspaces.iter().find(|w| w.id == tr.workspace_id) {
            r = r.avatar(workspace_avatar(
                &ws.name,
                workspace_badge_color(&ws.id, t),
                k,
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

    r.build(k).key(format!("thread-{}", tr.id))
}

fn thread_row_plain(s: &AppState, k: &Kit, tr: &ThreadRecord, selected: bool, depth: u8) -> El {
    let title = if tr.title.trim().is_empty() {
        "Untitled chat".to_string()
    } else {
        tr.title.clone()
    };
    let age = format_relative_age(tr.updated_at, s.now_secs);
    let tid_select = tr.id.clone();
    let tid_archive = tr.id.clone();

    let mut r = SidebarRow::new(title)
        .icon(&icons::MESSAGE)
        .depth(depth)
        .selected(selected)
        .on_select(move |s: &mut AppState, _| {
            s.dispatch(Action::Navigate(NavAction::OpenThread(tid_select.clone())));
        })
        .on_close(move |s: &mut AppState, _| {
            s.dispatch(Action::Chat(ChatAction::ArchiveThread(tid_archive.clone())));
        });

    if !age.is_empty() {
        r = r.detail(age);
    }
    if let Some(status) = thread_row_status(s, &tr.id) {
        r = r.status(status);
    }
    r.build(k).key(format!("thread-{}", tr.id))
}
