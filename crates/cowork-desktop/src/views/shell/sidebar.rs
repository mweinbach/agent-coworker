//! Left workspace, thread, task, and chat navigation sidebar.
//!
//! Ported from `apps/desktop/src/ui/Sidebar.tsx`, `src/ui/sidebar/`, and `sidebarHelpers.ts`.

use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};

use rune::{El, col, el, memo, row, text};
use rune_kit::shell::{RowStatus, Sidebar, SidebarRow, SidebarSection};
use rune_kit::{ControlSize, IconButton, IconButtonVariant, Kit, Menu, MenuItem};

use crate::actions::{Action, ChatAction, NativeAction, NavAction, ShellAction, SidebarSectionKey};
use crate::router::{SettingsPageId, ViewId};
use crate::state::{AppState, ThreadRecord, WorkspaceRecord};
use crate::theme::ThemeTokens;
use crate::views::shell::helpers::{
    contains_case_insensitive, filtered_threads, pending_input_count, split_workspaces,
    thread_row_status, warm_row, warm_selected,
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
pub fn build_sidebar(s: &AppState, k: &Kit, t: &ThemeTokens, layer: &mut Vec<El>) -> El {
    build_sidebar_with_visibility(s, k, t, layer, true)
}

/// Renders the left application sidebar, optionally suppressing animated busy spinners when
/// the pane is collapsing or hidden, and memoizing the subtree against unrelated commits.
pub(crate) fn build_sidebar_with_visibility(
    s: &AppState,
    k: &Kit,
    t: &ThemeTokens,
    layer: &mut Vec<El>,
    allow_spinners: bool,
) -> El {
    // Push any active thread context menu outside `memo` so menu popups stay live even when
    // the sidebar rows themselves are reused from cache.
    push_thread_context_menu(s, k, layer);

    if s.shell_ui.renaming_thread_id.is_some() {
        return build_sidebar_inner(s, k, t, allow_spinners).key("sidebar");
    }

    let version = sidebar_version(s, t, allow_spinners);
    memo("sidebar", version, || {
        build_sidebar_inner(s, k, t, allow_spinners)
    })
}

fn hash_string_set(set: &HashSet<String>, h: &mut DefaultHasher) {
    set.len().hash(h);
    if set.is_empty() {
        return;
    }
    let mut xor_acc: u64 = 0;
    let mut sum_acc: u64 = 0;
    for item in set {
        let mut item_h = DefaultHasher::new();
        item.hash(&mut item_h);
        let v = item_h.finish();
        xor_acc ^= v;
        sum_acc = sum_acc.wrapping_add(v);
    }
    (xor_acc, sum_acc).hash(h);
}

fn sidebar_version(s: &AppState, t: &ThemeTokens, allow_spinners: bool) -> u64 {
    let mut h = DefaultHasher::new();
    (
        t.dark,
        s.desktop_settings.reduced_transparency,
        s.desktop_settings.high_contrast,
        std::mem::discriminant(&s.desktop_settings.accent_palette),
        s.ui_scale.to_bits(),
        s.desktop_settings.reduce_motion,
        allow_spinners,
    )
        .hash(&mut h);

    let route = s.route();
    (
        std::mem::discriminant(&route.view),
        &route.active_thread_id,
        &route.active_task_id,
        &s.active_workspace_id,
    )
        .hash(&mut h);

    (
        &s.sidebar_search,
        s.shell_ui.needs_input_only,
        s.shell_ui.chats_expanded,
        s.shell_ui.sidebar_reorder_rev,
    )
        .hash(&mut h);

    let tasks_enabled = super::helpers::tasks_feature_enabled(s);
    tasks_enabled.hash(&mut h);

    s.desktop_settings.sidebar_section_order.len().hash(&mut h);
    for section_key in &s.desktop_settings.sidebar_section_order {
        (
            section_key,
            s.collapsed_sidebar_sections.contains(section_key),
        )
            .hash(&mut h);
    }

    s.workspace_order.hash(&mut h);
    hash_string_set(&s.collapsed_workspace_ids, &mut h);
    hash_string_set(&s.shell_ui.expanded_thread_workspaces, &mut h);
    if s.workspaces_rev != 0 {
        (1u8, s.workspaces_rev, s.workspaces.len()).hash(&mut h);
    } else {
        (0u8, s.workspaces.len()).hash(&mut h);
        for ws in &s.workspaces {
            (&ws.id, &ws.name, ws.one_off_chat, ws.archived).hash(&mut h);
        }
    }

    if s.threads_rev != 0 {
        (1u8, s.threads_rev, s.threads.len()).hash(&mut h);
        let mut active_count: usize = 0;
        let mut xor_acc: u64 = 0;
        let mut sum_acc: u64 = 0;
        for (tid, rt) in &s.thread_runtime_by_id {
            let status_tag = if !rt.pending_interactions.is_empty() {
                3u8
            } else if rt.streaming || rt.pending_turn_count > 0 || rt.active_turn_id.is_some() {
                2u8
            } else if rt.unread {
                1u8
            } else {
                0u8
            };
            let pending_len = rt.pending_interactions.len();
            if status_tag == 0 && pending_len == 0 {
                continue;
            }
            active_count += 1;
            let mut entry_h = DefaultHasher::new();
            (tid.as_str(), status_tag, pending_len).hash(&mut entry_h);
            let v = entry_h.finish();
            xor_acc ^= v;
            sum_acc = sum_acc.wrapping_add(v);
        }
        (active_count, xor_acc, sum_acc).hash(&mut h);
    } else {
        0u8.hash(&mut h);
        let search_non_empty = !s.sidebar_search.trim().is_empty();
        for tr in &s.threads {
            if !tr.is_standard_chat() {
                continue;
            }
            let (status_tag, pending_len) = match s.thread_runtime_by_id.get(&tr.id) {
                Some(rt) => {
                    let tag = if !rt.pending_interactions.is_empty() {
                        3u8
                    } else if rt.streaming
                        || rt.pending_turn_count > 0
                        || rt.active_turn_id.is_some()
                    {
                        2u8
                    } else if rt.unread {
                        1u8
                    } else {
                        0u8
                    };
                    (tag, rt.pending_interactions.len())
                }
                None => (0u8, 0usize),
            };
            (
                &tr.id,
                &tr.workspace_id,
                &tr.title,
                tr.pinned,
                tr.updated_at,
                status_tag,
                pending_len,
            )
                .hash(&mut h);
            if search_non_empty {
                tr.preview.hash(&mut h);
            }
        }
    }

    if tasks_enabled {
        s.tasks.len().hash(&mut h);
        for task in &s.tasks {
            (&task.id, &task.title, &task.status).hash(&mut h);
        }
    }

    h.finish()
}

fn build_sidebar_inner(s: &AppState, k: &Kit, t: &ThemeTokens, allow_spinners: bool) -> El {
    let mut sb = Sidebar::new()
        .label("Workspace navigation")
        .inset(4.0)
        .header_gap(1.0)
        .header_padding(0.0, SECTION_GAP)
        .row_gap(1.0);

    let pending_count = pending_input_count(s);
    for item in build_header_items(s, k, t, pending_count) {
        sb = sb.header(item);
    }

    let query = s.sidebar_search.as_str();
    let pending_filter = s.shell_ui.needs_input_only && pending_count > 0;
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
                if let Some(sec) =
                    build_pinned_section(s, k, t, &threads, active_thread_id, allow_spinners)
                {
                    sb = gap(sb).section(sec);
                }
            }
            SidebarSectionKey::Tasks => {
                if let Some(sec) =
                    build_tasks_section(s, k, t, query, active_task_id, allow_spinners)
                {
                    sb = gap(sb).section(sec);
                }
            }
            SidebarSectionKey::Chats => {
                sb = gap(sb).section(build_chats_section(
                    s,
                    k,
                    t,
                    &threads,
                    &one_off_ids,
                    primary_one_off,
                    active_thread_id,
                    allow_spinners,
                ));
            }
            SidebarSectionKey::Workspaces => {
                sb = build_workspaces_section(
                    s,
                    k,
                    t,
                    gap(sb),
                    &projects,
                    &threads,
                    active_thread_id,
                    allow_spinners,
                );
            }
        }
    }

    let settings_selected = s.route().view == ViewId::Settings;
    let footer = col()
        .key("sidebar-footer-actions")
        .w_full()
        .child(warm_selected(
            warm_row(
                SidebarRow::new("Settings"),
                Some(&icons::SETTINGS),
                settings_selected,
                k,
                t,
            )
            .height(ROW_H)
            .selected(settings_selected)
            .on_select(|s: &mut AppState, tx| {
                s.dispatch_tx(Action::Navigate(NavAction::OpenSettings(None)), tx);
            })
            .build(k)
            .key("sidebar-settings"),
            settings_selected,
            t,
        ));

    sb.footer(footer)
        .build(k)
        .transition(rune::Transition::none())
}

fn build_header_items(s: &AppState, k: &Kit, t: &ThemeTokens, pending: usize) -> Vec<El> {
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

    if pending > 0 {
        let filtering = s.shell_ui.needs_input_only;
        items.push(warm_selected(
            warm_row(
                SidebarRow::new(if filtering {
                    "Showing needs input"
                } else {
                    "Needs input"
                }),
                Some(&icons::ALERT_TRIANGLE),
                filtering,
                k,
                t,
            )
            .detail(pending.to_string())
            .status(RowStatus::Attention)
            .selected(filtering)
            .height(ROW_H)
            .on_select(|s: &mut AppState, _| {
                s.shell_ui.needs_input_only = !s.shell_ui.needs_input_only;
            })
            .build(k)
            .key("sidebar-needs-input"),
            filtering,
            t,
        ));
    }

    if super::helpers::tasks_feature_enabled(s) {
        let tasks_selected = s.route().view == ViewId::Task;
        items.push(warm_selected(
            warm_row(
                SidebarRow::new("Tasks"),
                Some(&icons::CHECK_SQUARE),
                tasks_selected,
                k,
                t,
            )
            .height(ROW_H)
            .selected(tasks_selected)
            .on_select(|s: &mut AppState, tx| {
                s.dispatch_tx(Action::Navigate(NavAction::OpenView(ViewId::Task)), tx);
            })
            .build(k)
            .key("sidebar-tasks-link"),
            tasks_selected,
            t,
        ));
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
        .on_press_tx(move |s: &mut AppState, tx| on_press(s, tx))
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
    t: &ThemeTokens,
    threads: &[&ThreadRecord],
    active_thread_id: Option<&str>,
    allow_spinners: bool,
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
            t,
            tr,
            active_thread_id == Some(tr.id.as_str()),
            ThreadIndent::TopLevel,
            allow_spinners,
        ));
    }
    Some(sec)
}

fn build_tasks_section(
    s: &AppState,
    k: &Kit,
    t: &ThemeTokens,
    query: &str,
    active_task_id: Option<&str>,
    allow_spinners: bool,
) -> Option<SidebarSection> {
    if !super::helpers::tasks_feature_enabled(s) {
        return None;
    }
    let trimmed = query.trim();
    let q = if trimmed.is_empty() {
        String::new()
    } else if trimmed.is_ascii() {
        trimmed.to_ascii_lowercase()
    } else {
        trimmed.to_lowercase()
    };
    let visible: Vec<_> = s
        .tasks
        .iter()
        .filter(|task| q.is_empty() || contains_case_insensitive(&task.title, &q))
        .collect();
    if visible.is_empty() {
        return None;
    }
    let collapsed = s
        .collapsed_sidebar_sections
        .contains(&SidebarSectionKey::Tasks);
    let reduce_motion = s.desktop_settings.reduce_motion;
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
        let selected = s.route().view == ViewId::Task && active_task_id == Some(task.id.as_str());
        let mut r = warm_row(SidebarRow::new(task.title.clone()), None, selected, k, t)
            .height(ROW_H)
            .selected(selected)
            .on_select(move |s: &mut AppState, tx| {
                s.dispatch_tx(Action::Navigate(NavAction::OpenTask(task_id.clone())), tx);
            });
        match status {
            Some(RowStatus::Busy) => {
                if !allow_spinners {
                    // Collapsed/closing pane: omit animated busy spinners.
                } else if reduce_motion {
                    r = r.trailing(el().size(6.0, 6.0).radius(3.0).fill(t.accent).a11y_hidden());
                } else {
                    r = r.status(RowStatus::Busy);
                }
            }
            Some(other) => {
                r = r.status(other);
            }
            None => {}
        }
        sec = sec.row(warm_selected(r.build(k), selected, t).key(format!("task-{}", task.id)));
    }
    Some(sec)
}

#[allow(clippy::too_many_arguments)]
fn build_chats_section(
    s: &AppState,
    k: &Kit,
    t: &ThemeTokens,
    threads: &[&ThreadRecord],
    one_off_ids: &HashSet<&str>,
    primary_one_off: Option<&str>,
    active_thread_id: Option<&str>,
    allow_spinners: bool,
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
            t,
            tr,
            active_thread_id == Some(tr.id.as_str()),
            ThreadIndent::TopLevel,
            allow_spinners,
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
        .on_press_tx(move |s: &mut AppState, tx| on_press(s, tx))
        .build(k)
        .key(key)
}

#[allow(clippy::too_many_arguments)]
fn build_workspaces_section(
    s: &AppState,
    k: &Kit,
    t: &ThemeTokens,
    mut sb: Sidebar,
    projects: &[&WorkspaceRecord],
    threads: &[&ThreadRecord],
    active_thread_id: Option<&str>,
    allow_spinners: bool,
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

    // Group threads by workspace in a single O(T) pass instead of O(P * T) filtering per project.
    let mut threads_by_ws: HashMap<&str, Vec<&ThreadRecord>> =
        HashMap::with_capacity(projects.len());
    for tr in threads {
        threads_by_ws
            .entry(tr.workspace_id.as_str())
            .or_default()
            .push(tr);
    }

    let search_active = !s.sidebar_search.trim().is_empty();
    let project_count = projects.len();
    for (idx, ws) in projects.iter().enumerate() {
        let ws_id = ws.id.clone();
        let ws_id_new = ws.id.clone();
        let collapsed = !search_active && s.collapsed_workspace_ids.contains(&ws.id);
        let is_active_ws = s.active_workspace_id.as_deref() == Some(ws.id.as_str());
        let ws_threads: &[&ThreadRecord] = threads_by_ws
            .get(ws.id.as_str())
            .map(Vec::as_slice)
            .unwrap_or(&[]);

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

        let ws_selected = is_active_ws && active_thread_id.is_none();
        let ws_row = warm_selected(
            warm_row(SidebarRow::new(ws.name.clone()), None, ws_selected, k, t)
                .height(ROW_H)
                .selected(ws_selected)
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
                    |s: &mut AppState| {
                        s.shell_ui.sidebar_reorder_rev =
                            s.shell_ui.sidebar_reorder_rev.wrapping_add(1);
                        &mut s.shell_ui.sidebar_reorder
                    },
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
                .build(k),
            ws_selected,
            t,
        )
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
                    t,
                    tr,
                    active_thread_id == Some(tr.id.as_str()),
                    ThreadIndent::UnderProject,
                    allow_spinners,
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

fn push_thread_context_menu(s: &AppState, k: &Kit, layer: &mut Vec<El>) {
    let Some(tid) = s.shell_ui.context_menu_thread_id.as_deref() else {
        return;
    };
    let Some(pt) = s.shell_ui.context_menu_point else {
        return;
    };
    let Some(tr) = s.threads.iter().find(|tr| tr.id == tid) else {
        return;
    };
    let current_title = if tr.title.trim().is_empty() {
        "Untitled chat".to_string()
    } else {
        tr.title.clone()
    };
    let tid_rename = tr.id.clone();
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
        .item(
            MenuItem::new("Rename")
                .icon(&icons::FILE_TEXT)
                .on_select(move |s: &mut AppState| {
                    s.shell_ui.context_menu_thread_id = None;
                    s.shell_ui.context_menu_point = None;
                    s.shell_ui.renaming_thread_id = Some(tid_rename.clone());
                    s.shell_ui.rename_edit.replace_text(&current_title);
                    s.shell_ui.rename_edit.focused = true;
                }),
        )
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

/// One chat: its title, plus a status mark only while it is working, waiting on the user or
/// unread. Archive appears under the pointer; everything else is on the context menu.
fn build_thread_row(
    s: &AppState,
    k: &Kit,
    t: &ThemeTokens,
    tr: &ThreadRecord,
    selected: bool,
    indent: ThreadIndent,
    allow_spinners: bool,
) -> El {
    let title = if tr.title.trim().is_empty() {
        "Untitled chat".to_string()
    } else {
        tr.title.clone()
    };
    let tid_select = tr.id.clone();
    let tid_archive = tr.id.clone();
    let tid_ctx = tr.id.clone();

    let mut r = warm_row(SidebarRow::new(title), None, selected, k, t)
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

    match thread_row_status(s, &tr.id) {
        Some(RowStatus::Busy) => {
            if !allow_spinners {
                // Collapsed/closing pane: omit animated busy spinners so invisible rows never
                // keep the animation loop running.
            } else if s.desktop_settings.reduce_motion {
                r = r.trailing(el().size(6.0, 6.0).radius(3.0).fill(t.accent).a11y_hidden());
            } else {
                r = r.status(RowStatus::Busy);
            }
        }
        Some(other) => {
            r = r.status(other);
        }
        None => {}
    }

    warm_selected(r.build(k), selected, t)
        .key(format!("thread-{}", tr.id))
        .on_secondary_press(move |s: &mut AppState, pt, _| {
            s.shell_ui.context_menu_thread_id = Some(tid_ctx.clone());
            s.shell_ui.context_menu_point = Some(pt);
        })
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
