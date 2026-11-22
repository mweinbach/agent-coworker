//! Right context rail displaying plan todos, subagents, workflow runs, usage, and workspace files.
//!
//! Ported from `apps/desktop/src/ui/ContextSidebar.tsx`, `WorkflowRunsPanel.tsx`, and
//! workspace file explorer integration.

use std::collections::HashSet;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use rune::{El, Key, ScrollSpec, col, el, memo, row, spacer, text, text_input};
use rune_kit::{
    Badge, BadgeVariant, Button, ButtonVariant, ControlSize, Divider, IconButton,
    IconButtonVariant, Kit, Menu, MenuItem, Placement, glyphs,
};

use crate::actions::{Action, ChatAction, NativeAction, ShellAction};
use crate::router::ViewId;
use crate::state::{AppState, ThreadRuntime, WorkflowRunView};
use crate::theme::ThemeTokens;
use crate::views::shell::helpers::{format_bytes, format_cost_usd, format_tokens};
use crate::views::shell::icons;
use crate::views::shell::state::ExplorerContextMenu;

/// Closes the inline right context sidebar and any narrow-viewport overlay drawer.
fn close_context_inspector(s: &mut AppState) {
    s.shell_ui.right_overlay_open = false;
    s.dispatch(Action::Shell(ShellAction::SetContextSidebarOpen(false)));
}

/// Closes Context first so opening AgentRunViewer never squeezes chat into 4 panes.
fn open_agent_run_from_context(s: &mut AppState, agent_id: String, title: String) {
    close_context_inspector(s);
    s.dispatch(Action::Chat(ChatAction::OpenAgentThread {
        agent_id,
        title: Some(title),
    }));
}

/// Renders a flat inspector section without a left accent stripe or drop shadow.
fn context_section_unkeyed(
    title: impl Into<String>,
    glyph: &'static rune::Icon,
    trailing: Option<El>,
    body: El,
    k: &Kit,
    t: &ThemeTokens,
) -> El {
    let mut header = row()
        .w_full()
        .items_center()
        .gap(6.0)
        .child(rune::icon(glyph, 13.0).color(t.text_muted))
        .child(
            text(title)
                .font(k.ty.small_medium)
                .color(k.c.text_base)
                .truncate(),
        )
        .child(spacer());
    if let Some(action) = trailing {
        header = header.child(action);
    }
    col()
        .role("group")
        .w_full()
        .gap(8.0)
        .px(12.0)
        .py(10.0)
        .radius(10.0)
        .fill(t.card_bg)
        .border(1.0, t.border_muted)
        .child(header)
        .child(body)
}

fn context_section(
    key: &'static str,
    title: impl Into<String>,
    glyph: &'static rune::Icon,
    trailing: Option<El>,
    body: El,
    k: &Kit,
    t: &ThemeTokens,
) -> El {
    context_section_unkeyed(title, glyph, trailing, body, k, t).key(key)
}

fn hash_theme_fp(s: &AppState, t: &ThemeTokens, h: &mut DefaultHasher) {
    (
        t.dark,
        s.desktop_settings.reduced_transparency,
        s.desktop_settings.high_contrast,
        std::mem::discriminant(&s.desktop_settings.accent_palette),
        s.ui_scale.to_bits(),
    )
        .hash(h);
}

fn hash_explorer_tree_entries(
    s: &AppState,
    ws_id: &str,
    dir: &str,
    depth: usize,
    budget: &mut usize,
    key_buf: &mut String,
    h: &mut DefaultHasher,
) {
    if depth >= 12 || *budget == 0 {
        return;
    }
    let Some(entries) = lookup_explorer_entries(s, dir) else {
        0u8.hash(h);
        return;
    };
    1u8.hash(h);
    entries.len().hash(h);
    for entry in entries {
        if *budget == 0 {
            break;
        }
        *budget -= 1;
        let expanded = if entry.is_dir && !s.explorer_expanded_dirs.is_empty() {
            key_buf.clear();
            key_buf.push_str(ws_id);
            key_buf.push_str("::");
            key_buf.push_str(&entry.path);
            s.explorer_expanded_dirs.contains(key_buf.as_str())
        } else {
            false
        };
        (
            &entry.name,
            &entry.path,
            entry.is_dir,
            entry.size_bytes,
            &entry.git_status,
            expanded,
        )
            .hash(h);
        if expanded {
            match lookup_explorer_entries(s, &entry.path) {
                Some([]) => {
                    if *budget > 0 {
                        *budget -= 1;
                        2u8.hash(h);
                    }
                }
                Some(_) => {
                    hash_explorer_tree_entries(
                        s,
                        ws_id,
                        &entry.path,
                        depth + 1,
                        budget,
                        key_buf,
                        h,
                    );
                }
                None => {
                    if *budget > 0 {
                        *budget -= 1;
                        3u8.hash(h);
                    }
                }
            }
        }
    }
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

fn workspace_files_version(s: &AppState, t: &ThemeTokens) -> u64 {
    let mut h = DefaultHasher::new();
    hash_theme_fp(s, t, &mut h);
    if let Some(ws) = s.active_workspace() {
        1u8.hash(&mut h);
        (&ws.id, &ws.name).hash(&mut h);
        if s.explorer_rev != 0 {
            let root_len = lookup_explorer_entries(s, ".").map(<[_]>::len);
            (
                1u8,
                s.explorer_rev,
                s.explorer_entries_by_dir.len(),
                root_len,
            )
                .hash(&mut h);
            hash_string_set(&s.explorer_expanded_dirs, &mut h);
        } else {
            0u8.hash(&mut h);
            let mut budget = 120usize;
            let mut key_buf = String::new();
            hash_explorer_tree_entries(s, &ws.id, ".", 0, &mut budget, &mut key_buf, &mut h);
        }
    } else {
        0u8.hash(&mut h);
    }
    h.finish()
}

fn hash_workflow_run(run: &WorkflowRunView, h: &mut DefaultHasher) {
    (
        &run.id,
        &run.workspace_id,
        &run.workflow_name,
        &run.status,
        &run.summary,
        run.started_at,
    )
        .hash(h);
}

fn hash_active_context_workflow_runs(s: &AppState, h: &mut DefaultHasher) {
    if s.route().view == ViewId::Task {
        1u8.hash(h);
        if let Some(task) = s.active_task.as_ref() {
            (
                &task.summary.id,
                &task.summary.workspace_id,
                task.runs.len(),
            )
                .hash(h);
            for run in &task.runs {
                hash_workflow_run(run, h);
            }
            for linked in &task.threads {
                linked.session_id.hash(h);
                if let Some(rt) = s.thread_runtime_by_id.get(&linked.session_id) {
                    for run in &rt.workflow_runs {
                        hash_workflow_run(run, h);
                    }
                }
                for run in &s.workflow_runs {
                    if run.session_id.as_deref() == Some(linked.session_id.as_str()) {
                        hash_workflow_run(run, h);
                    }
                }
            }
        }
        return;
    }
    2u8.hash(h);
    if let Some(tid) = s.route().active_thread_id.as_deref() {
        if let Some(rt) = s.thread_runtime_by_id.get(tid) {
            rt.workflow_runs.len().hash(h);
            for run in &rt.workflow_runs {
                hash_workflow_run(run, h);
            }
        }
        for run in &s.workflow_runs {
            if run.session_id.as_deref() == Some(tid) {
                hash_workflow_run(run, h);
            }
        }
    }
}

fn context_sidebar_version(s: &AppState, t: &ThemeTokens, files_ver: u64) -> u64 {
    let mut h = DefaultHasher::new();
    hash_theme_fp(s, t, &mut h);
    files_ver.hash(&mut h);
    let route = s.route();
    (
        std::mem::discriminant(&route.view),
        &route.active_thread_id,
        &route.active_task_id,
        &s.active_workspace_id,
    )
        .hash(&mut h);

    if let Some(rt) = s.active_thread_runtime() {
        1u8.hash(&mut h);
        if let Some(usage) = &rt.usage {
            (
                1u8,
                usage.input_tokens,
                usage.output_tokens,
                usage.cached_tokens,
                usage.estimated_cost_usd.to_bits(),
            )
                .hash(&mut h);
        } else {
            0u8.hash(&mut h);
        }
        (
            rt.usage_hard_cap.map(f64::to_bits),
            rt.usage_hard_cap_reached,
        )
            .hash(&mut h);
        rt.todos.len().hash(&mut h);
        for todo in &rt.todos {
            (&todo.id, &todo.status, &todo.content).hash(&mut h);
        }
        rt.agents.len().hash(&mut h);
        for agent in &rt.agents {
            (&agent.agent_id, &agent.name, &agent.role, &agent.status).hash(&mut h);
        }
    } else {
        0u8.hash(&mut h);
    }

    hash_active_context_workflow_runs(s, &mut h);
    h.finish()
}

/// Renders the right inspector sidebar panel for the active chat or task route.
pub fn build_context_sidebar(s: &AppState, k: &Kit, t: &ThemeTokens, layer: &mut Vec<El>) -> El {
    // Bypass memo while an interactive file context menu (which pushes to `layer`) or inline
    // file rename TextEdit is active so popup anchors and text edits stay live.
    if s.shell_ui.file_context_menu.is_some() || s.shell_ui.renaming_file_key.is_some() {
        return build_context_sidebar_inner(s, k, t, layer, None).key("context-sidebar");
    }

    let files_ver = workspace_files_version(s, t);
    let ctx_ver = context_sidebar_version(s, t, files_ver);
    memo("context-sidebar", ctx_ver, || {
        let mut empty_layer = Vec::new();
        build_context_sidebar_inner(s, k, t, &mut empty_layer, Some(files_ver))
    })
}

fn build_context_sidebar_inner(
    s: &AppState,
    k: &Kit,
    t: &ThemeTokens,
    layer: &mut Vec<El>,
    files_memo_ver: Option<u64>,
) -> El {
    let header = row()
        .key("context-sidebar-header")
        .w_full()
        .h(crate::theme::layout::SHELL_TOOLBAR_HEIGHT)
        .px(12.0)
        .items_center()
        .justify_between()
        .child(text("Context").font(k.ty.ui_medium).color(k.c.text_base))
        .child(
            IconButton::new(k.glyph.close)
                .variant(IconButtonVariant::GhostMuted)
                .control_size(ControlSize::Small)
                .help("Close context sidebar")
                .on_press_tx(|s: &mut AppState, _| {
                    close_context_inspector(s);
                })
                .build(k)
                .key("context-sidebar-close"),
        );

    let mut sections = Vec::new();
    if let Some(rt) = s.active_thread_runtime() {
        if let Some(usage_card) = build_usage_card(s, rt, k, t) {
            sections.push(usage_card);
        }
        if !rt.todos.is_empty() {
            sections.push(build_plan_card(rt, k, t));
        }
        if !rt.agents.is_empty() {
            sections.push(build_subagents_card(rt, k, t));
        }
    }

    let context_runs = s.workflow_runs_for_active_context();
    if !context_runs.is_empty() {
        sections.push(build_workflow_runs_card(context_runs, k, t));
    }

    let files_card = match files_memo_ver {
        Some(ver) => {
            let memo_key = if s.active_workspace().is_some() {
                "context-files-card"
            } else {
                "context-files-empty"
            };
            memo(memo_key, ver, || {
                let mut empty_layer = Vec::new();
                build_workspace_files_card(s, k, t, &mut empty_layer, false)
            })
        }
        None => build_workspace_files_card(s, k, t, layer, true),
    };
    sections.push(files_card);

    if sections.is_empty() {
        sections.push(context_section(
            "context-empty",
            "No active context",
            &icons::INFO,
            None,
            text("Select a workspace or start a thread to inspect plans, subagents, workflow runs, and workspace files.")
                .font(k.ty.small)
                .color(k.c.text_muted)
                .wrap()
                .w_full(),
            k,
            t,
        ));
    }

    col()
        .w_full()
        .h_full()
        .min_h(0.0)
        .child(header)
        .child(Divider::horizontal().build(k))
        .child(
            col()
                .key("context-sidebar-scroll")
                .w_full()
                .grow(1.0)
                .min_h(0.0)
                .scroll(ScrollSpec {
                    stick_bottom: false,
                })
                .padding(12.0)
                .gap(12.0)
                .children(sections),
        )
}

fn build_usage_card(s: &AppState, rt: &ThreadRuntime, k: &Kit, t: &ThemeTokens) -> Option<El> {
    let usage = rt.usage.as_ref()?;
    let stat_col = |label: &str, value: String| {
        col()
            .grow(1.0)
            .min_w(0.0)
            .gap(2.0)
            .child(
                text(label.to_owned())
                    .font(k.ty.text_xsmall)
                    .color(t.text_faint),
            )
            .child(
                text(value)
                    .font(k.ty.small_medium)
                    .color(k.c.text_base)
                    .truncate(),
            )
    };

    let cost_summary = if let Some(cap) = rt.usage_hard_cap {
        format!(
            "{} / {} cap",
            format_cost_usd(usage.estimated_cost_usd),
            format_cost_usd(cap)
        )
    } else {
        format_cost_usd(usage.estimated_cost_usd)
    };

    let mut card_body = col().w_full().gap(8.0).child(
        row()
            .w_full()
            .justify_between()
            .items_center()
            .child(
                text("Estimated cost")
                    .font(k.ty.small)
                    .color(k.c.text_muted),
            )
            .child(text(cost_summary).font(k.ty.small_medium).color(
                if rt.usage_hard_cap_reached {
                    t.danger
                } else {
                    k.c.text_base
                },
            )),
    );

    if let Some(cap) = rt.usage_hard_cap
        && cap > 0.0
    {
        let ratio = (usage.estimated_cost_usd / cap).clamp(0.0, 1.0) as f32;
        let fill_color = if rt.usage_hard_cap_reached || ratio >= 0.95 {
            t.danger
        } else if ratio >= 0.8 {
            t.warning
        } else {
            t.accent
        };
        let mut track = row()
            .w_full()
            .h(5.0)
            .radius(9999.0)
            .fill(t.hover)
            .clip_rounded(9999.0);
        if ratio > 0.0 {
            let filled = ratio.max(0.02);
            track = track
                .child(el().h(5.0).grow(filled).radius(9999.0).fill(fill_color))
                .child(el().h(5.0).grow((1.0 - filled).max(0.0)));
        }
        card_body = card_body.child(track);
    }

    card_body = card_body.child(
        row()
            .w_full()
            .pt(2.0)
            .gap(12.0)
            .child(stat_col("Input", format_tokens(usage.input_tokens)))
            .child(stat_col("Cached", format_tokens(usage.cached_tokens)))
            .child(stat_col("Output", format_tokens(usage.output_tokens))),
    );

    if rt.usage_hard_cap_reached
        && let Some(thread_id) = s.route().active_thread_id.clone()
    {
        card_body = card_body.child(
            row()
                .w_full()
                .pt(2.0)
                .justify_between()
                .items_center()
                .child(
                    text("Hard cap reached")
                        .font(k.ty.small_medium)
                        .color(t.danger),
                )
                .child(
                    Button::new("Clear cap")
                        .variant(ButtonVariant::Danger)
                        .control_size(ControlSize::Small)
                        .on_press_tx(move |s: &mut AppState, _| {
                            s.dispatch(Action::Chat(ChatAction::ClearThreadUsageHardCap(
                                thread_id.clone(),
                            )));
                        })
                        .build(k),
                ),
        );
    }

    Some(context_section(
        "context-usage-card",
        "Usage",
        &icons::SPARKLES,
        None,
        card_body,
        k,
        t,
    ))
}

fn build_plan_card(rt: &ThreadRuntime, k: &Kit, t: &ThemeTokens) -> El {
    let done = rt
        .todos
        .iter()
        .filter(|item| item.status == "completed")
        .count();
    let total = rt.todos.len();

    let mut list = col().w_full().gap(6.0);
    list = list.child(
        row()
            .w_full()
            .justify_between()
            .items_center()
            .child(
                text("Steps completed")
                    .font(k.ty.small)
                    .color(k.c.text_muted),
            )
            .child(
                Badge::new(format!("{done}/{total}"))
                    .variant(BadgeVariant::Subtle)
                    .build(k),
            ),
    );
    for todo in &rt.todos {
        let icon_ref = match todo.status.as_str() {
            "completed" => &icons::CHECK_CIRCLE,
            "in_progress" => &icons::CLOCK,
            _ => &icons::INFO,
        };
        let ink = match todo.status.as_str() {
            "completed" => t.success,
            "in_progress" => t.accent,
            _ => k.c.text_muted,
        };
        list = list.child(
            row()
                .key(format!("todo-{}", todo.id))
                .w_full()
                .gap(8.0)
                .items_start()
                .child(rune::icon(icon_ref, 14.0).color(ink))
                .child(
                    text(todo.content.clone())
                        .font(k.ty.small)
                        .color(k.c.text_base)
                        .wrap()
                        .grow(1.0)
                        .shrink(),
                ),
        );
    }

    context_section(
        "context-plan-card",
        "Plan",
        &icons::CHECK_SQUARE,
        None,
        list,
        k,
        t,
    )
}

fn build_subagents_card(rt: &ThreadRuntime, k: &Kit, t: &ThemeTokens) -> El {
    let mut list = col().w_full().gap(6.0);
    for agent in &rt.agents {
        let aid = agent.agent_id.clone();
        let name = agent.name.clone();
        let status = agent.status.clone();
        list = list.child(
            row()
                .key(format!("subagent-{}", agent.agent_id))
                .w_full()
                .padding(8.0)
                .radius(k.radius.md)
                .fill(k.c.layer_02)
                .hover(k.c.hover)
                .justify_between()
                .items_center()
                .on_press_tx(move |s: &mut AppState, _| {
                    open_agent_run_from_context(s, aid.clone(), name.clone());
                })
                .child(
                    col()
                        .gap(2.0)
                        .shrink()
                        .min_w(0.0)
                        .child(
                            text(agent.name.clone())
                                .font(k.ty.small_medium)
                                .color(k.c.text_base)
                                .truncate(),
                        )
                        .children(agent.role.as_ref().map(|r| {
                            text(r.clone())
                                .font(k.ty.small)
                                .color(k.c.text_muted)
                                .truncate()
                        })),
                )
                .child(Badge::new(status).variant(BadgeVariant::Neutral).build(k)),
        );
    }

    context_section(
        "context-subagents-card",
        format!("Subagents ({})", rt.agents.len()),
        &icons::SPARKLES,
        None,
        list,
        k,
        t,
    )
}

fn build_workflow_runs_card(
    mut runs: Vec<crate::state::WorkflowRunView>,
    k: &Kit,
    t: &ThemeTokens,
) -> El {
    runs.sort_by_key(|b| std::cmp::Reverse(b.started_at));

    let mut list = col().w_full().gap(6.0);
    for run in runs.into_iter().take(6) {
        let run_id = run.id.clone();
        list = list.child(
            col()
                .key(format!("workflow-run-{}", run.id))
                .w_full()
                .padding(8.0)
                .radius(k.radius.md)
                .fill(k.c.layer_02)
                .hover(k.c.hover)
                .gap(4.0)
                .on_press_tx(move |s: &mut AppState, _| {
                    s.shell_ui.selected_workflow_run_id = Some(run_id.clone());
                })
                .child(
                    row()
                        .w_full()
                        .justify_between()
                        .items_center()
                        .child(
                            text(run.workflow_name)
                                .font(k.ty.small_medium)
                                .color(k.c.text_base)
                                .truncate(),
                        )
                        .child(
                            Badge::new(run.status)
                                .variant(BadgeVariant::Neutral)
                                .build(k),
                        ),
                )
                .children(
                    run.summary
                        .map(|summary| text(summary).font(k.ty.small).color(k.c.text_muted).wrap()),
                ),
        );
    }

    context_section(
        "context-workflow-runs-card",
        "Workflow runs",
        &icons::CLOCK,
        None,
        list,
        k,
        t,
    )
}

pub(crate) fn explorer_dir_state_key(workspace_id: &str, dir: &str) -> String {
    format!("{workspace_id}::{dir}")
}

fn lookup_explorer_entries<'a>(
    s: &'a AppState,
    dir: &str,
) -> Option<&'a [crate::state::WorkspaceFileEntry]> {
    s.explorer_entries_by_dir
        .get(dir)
        .or_else(|| {
            dir.strip_prefix("./")
                .and_then(|trimmed| s.explorer_entries_by_dir.get(trimmed))
        })
        .map(Vec::as_slice)
}

pub(crate) fn validate_explorer_rename(
    original_name: &str,
    candidate: &str,
) -> Result<Option<String>, &'static str> {
    let trimmed = candidate.trim();
    if trimmed.is_empty() {
        return Err("Entry name cannot be empty.");
    }
    if trimmed == "." || trimmed == ".." {
        return Err("Invalid entry name.");
    }
    if candidate.contains('/') || candidate.contains('\\') || candidate.contains('\0') {
        return Err("Name cannot contain path separators.");
    }
    if trimmed == original_name {
        return Ok(None);
    }
    Ok(Some(trimmed.to_string()))
}

pub(crate) fn start_explorer_rename(
    s: &mut AppState,
    workspace_id: String,
    path: String,
    current_name: String,
) {
    s.shell_ui.file_context_menu = None;
    s.shell_ui.renaming_file_error = None;
    s.shell_ui.renaming_file_key = Some((workspace_id, path));
    s.shell_ui.renaming_file_edit.replace_text(&current_name);
    s.shell_ui.renaming_file_edit.focused = true;
}

pub(crate) fn cancel_explorer_rename(s: &mut AppState) {
    s.shell_ui.renaming_file_key = None;
    s.shell_ui.renaming_file_error = None;
}

pub(crate) fn commit_explorer_rename(
    s: &mut AppState,
    workspace_id: &str,
    path: &str,
    original_name: &str,
) {
    match validate_explorer_rename(original_name, &s.shell_ui.renaming_file_edit.text) {
        Err(message) => {
            s.shell_ui.renaming_file_error = Some(message.to_string());
        }
        Ok(None) => {
            cancel_explorer_rename(s);
        }
        Ok(Some(new_name)) => {
            s.dispatch(Action::Native(NativeAction::RenameWorkspaceEntry {
                workspace_id: workspace_id.to_string(),
                path: path.to_string(),
                new_name,
            }));
            cancel_explorer_rename(s);
        }
    }
}

fn open_or_toggle_explorer_entry(s: &mut AppState, ws_id: &str, path: &str, is_dir: bool) {
    if is_dir {
        let dir_key = explorer_dir_state_key(ws_id, path);
        if !s.explorer_expanded_dirs.remove(&dir_key) {
            s.explorer_expanded_dirs.insert(dir_key);
            s.dispatch(Action::Native(NativeAction::ListWorkspaceFiles {
                workspace_id: ws_id.to_string(),
                dir: path.to_string(),
            }));
        }
    } else {
        s.shell_ui.canvas_overlay_dismissed_key = None;
        if !(s.is_canvas_enabled() && crate::views::chat::is_canvas_document_path(path)) {
            close_context_inspector(s);
        }
        s.dispatch(Action::Native(NativeAction::LoadFilePreview {
            workspace_id: ws_id.to_string(),
            path: path.to_string(),
        }));
    }
}

#[allow(clippy::too_many_arguments)]
fn build_explorer_rename_row(
    s: &AppState,
    ws_id: &str,
    entry: &crate::state::WorkspaceFileEntry,
    indent: f32,
    leading: El,
    file_glyph: &'static rune::Icon,
    k: &Kit,
    t: &ThemeTokens,
) -> El {
    let ws_submit = ws_id.to_owned();
    let path_submit = entry.path.clone();
    let name_submit = entry.name.clone();
    let ws_save = ws_id.to_owned();
    let path_save = entry.path.clone();
    let name_save = entry.name.clone();
    let has_err = s.shell_ui.renaming_file_error.is_some();

    let input_box = el()
        .grow(1.0)
        .shrink()
        .min_w(0.0)
        .h(22.0)
        .px(6.0)
        .radius(k.radius.sm)
        .fill(t.input_bg)
        .border(1.0, if has_err { t.danger } else { t.border_strong })
        .center_y()
        .child(
            text_input(&s.shell_ui.renaming_file_edit, k.ty.small)
                .single_line()
                .key(format!("ws-file-rename-input-{}", entry.path))
                .label(format!("Rename {}", entry.name))
                .focus_selected(true)
                .focus_return(format!("ws-file-{}", entry.path))
                .w_full()
                .color(k.c.text_base)
                .caret(k.c.text_base, k.selection())
                .on_edit(|s: &mut AppState| &mut s.shell_ui.renaming_file_edit)
                .on_input_change(|s: &mut AppState, _| {
                    s.shell_ui.renaming_file_error = None;
                })
                .on_submit(move |s: &mut AppState, _| {
                    commit_explorer_rename(s, &ws_submit, &path_submit, &name_submit);
                })
                .on_input_key(|s: &mut AppState, ev, _| {
                    if ev.key == Key::Escape {
                        cancel_explorer_rename(s);
                        return true;
                    }
                    false
                }),
        );

    let save_btn = IconButton::new(&glyphs::CHECK)
        .variant(IconButtonVariant::GhostMuted)
        .control_size(ControlSize::Small)
        .help("Save name")
        .on_press_tx(move |s: &mut AppState, _| {
            commit_explorer_rename(s, &ws_save, &path_save, &name_save);
        })
        .build(k)
        .key(format!("ws-file-rename-save-{}", entry.path));

    let cancel_btn = IconButton::new(&glyphs::CLOSE)
        .variant(IconButtonVariant::GhostMuted)
        .control_size(ControlSize::Small)
        .help("Cancel rename")
        .on_press_tx(|s: &mut AppState, _| {
            cancel_explorer_rename(s);
        })
        .build(k)
        .key(format!("ws-file-rename-cancel-{}", entry.path));

    let edit_row = row()
        .key(format!("ws-file-rename-{}", entry.path))
        .w_full()
        .h(28.0)
        .pl(indent)
        .pr(4.0)
        .gap(4.0)
        .radius(k.radius.sm)
        .center_y()
        .fill(k.c.hover)
        .child(leading)
        .child(rune::icon(file_glyph, 14.0).color(k.c.icon_muted))
        .child(input_box)
        .child(save_btn)
        .child(cancel_btn);

    if let Some(err) = s.shell_ui.renaming_file_error.as_deref() {
        col().w_full().gap(2.0).child(edit_row).child(
            el().w_full().pl(indent + 32.0).pr(6.0).child(
                text(err.to_owned())
                    .key(format!("ws-file-rename-error-{}", entry.path))
                    .font(k.ty.small)
                    .color(t.danger)
                    .wrap(),
            ),
        )
    } else {
        edit_row
    }
}

/// Resolves a workspace-relative explorer entry path against the owning workspace root.
pub(crate) fn resolve_explorer_fs_path(s: &AppState, workspace_id: &str, raw: &str) -> String {
    let Some(root) = s
        .workspaces
        .iter()
        .find(|w| w.id == workspace_id)
        .map(|w| w.path.as_str())
    else {
        return raw.to_string();
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() || matches!(trimmed, "." | "./") {
        return root.to_string();
    }
    let mut rel = trimmed;
    while let Some(rest) = rel.strip_prefix("./") {
        rel = rest;
    }
    if rel.is_empty() || rel == "." {
        return root.to_string();
    }
    if std::path::Path::new(rel).is_absolute() {
        raw.to_string()
    } else {
        std::path::Path::new(root)
            .join(rel)
            .to_string_lossy()
            .into_owned()
    }
}

/// Computes the workspace-relative parent directory for refreshing `ListWorkspaceFiles`.
pub(crate) fn explorer_parent_dir(s: &AppState, workspace_id: &str, raw: &str) -> String {
    let trimmed = raw.trim();
    let mut rel = trimmed;
    while let Some(rest) = rel.strip_prefix("./") {
        rel = rest;
    }
    let rel_path = if std::path::Path::new(rel).is_absolute() {
        s.workspaces
            .iter()
            .find(|w| w.id == workspace_id)
            .and_then(|w| std::path::Path::new(rel).strip_prefix(&w.path).ok())
            .unwrap_or_else(|| std::path::Path::new(""))
    } else {
        std::path::Path::new(rel)
    };
    rel_path
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
        .filter(|p| p != ".")
        .unwrap_or_default()
}

fn build_explorer_context_menu(
    menu: &super::state::ExplorerContextMenu,
    expanded: bool,
    trigger: Option<El>,
    k: &Kit,
    layer: &mut Vec<El>,
) -> Option<El> {
    let ws_open = menu.workspace_id.clone();
    let path_open = menu.path.clone();
    let is_dir = menu.is_dir;

    let ws_rename = menu.workspace_id.clone();
    let path_rename = menu.path.clone();
    let name_rename = menu.name.clone();

    let ws_reveal = menu.workspace_id.clone();
    let path_reveal = menu.path.clone();
    let ws_copy = menu.workspace_id.clone();
    let path_copy = menu.path.clone();
    let ws_trash = menu.workspace_id.clone();
    let path_trash = menu.path.clone();
    let name_trash = menu.name.clone();

    let open_label = if is_dir {
        if expanded {
            "Collapse folder"
        } else {
            "Expand folder"
        }
    } else {
        "Open file"
    };

    let mut builder = Menu::new(format!("ws-file-ctx-{}", menu.path))
        .standard()
        .min_width(220.0)
        .open(true)
        .on_close(|s: &mut AppState| {
            s.shell_ui.file_context_menu = None;
        });

    if let Some(trig) = trigger {
        builder = builder.placement(Placement::BottomEnd).trigger(trig);
    } else if let Some(pt) = menu.point {
        builder = builder.at(pt.x, pt.y);
    }

    let menu_el =
        builder
            .item(
                MenuItem::new(open_label).on_select(move |s: &mut AppState| {
                    s.shell_ui.file_context_menu = None;
                    open_or_toggle_explorer_entry(s, &ws_open, &path_open, is_dir);
                }),
            )
            .item(MenuItem::new("Rename").icon(&icons::PENCIL).on_select(
                move |s: &mut AppState| {
                    start_explorer_rename(
                        s,
                        ws_rename.clone(),
                        path_rename.clone(),
                        name_rename.clone(),
                    );
                },
            ))
            .separator()
            .item(
                MenuItem::new("Reveal in File Manager").on_select(move |s: &mut AppState| {
                    s.shell_ui.file_context_menu = None;
                    let full_path = resolve_explorer_fs_path(s, &ws_reveal, &path_reveal);
                    s.dispatch(Action::Native(NativeAction::RevealInOs(full_path)));
                }),
            )
            .item(
                MenuItem::new("Copy Full Path")
                    .icon(&glyphs::COPY)
                    .on_select(move |s: &mut AppState| {
                        s.shell_ui.file_context_menu = None;
                        let full_path = resolve_explorer_fs_path(s, &ws_copy, &path_copy);
                        s.dispatch(Action::Native(NativeAction::CopyText(full_path)));
                    }),
            )
            .separator()
            .item(
                MenuItem::new("Move to Trash")
                    .danger(true)
                    .on_select(move |s: &mut AppState| {
                        s.shell_ui.file_context_menu = None;
                        s.shell_ui.pending_trash_entry = Some(super::state::PendingTrashEntry {
                            workspace_id: ws_trash.clone(),
                            path: path_trash.clone(),
                            name: name_trash.clone(),
                            is_dir,
                        });
                    }),
            )
            .build(k, layer);

    menu.point.is_none().then_some(menu_el)
}

#[allow(clippy::too_many_arguments)]
fn push_explorer_tree(
    rows: &mut Vec<El>,
    s: &AppState,
    ws_id: &str,
    dir: &str,
    depth: usize,
    budget: &mut usize,
    dir_key_buf: &mut String,
    k: &Kit,
    t: &ThemeTokens,
    layer: &mut Vec<El>,
) {
    if depth >= 12 || *budget == 0 {
        return;
    }
    let Some(entries) = lookup_explorer_entries(s, dir) else {
        return;
    };

    for entry in entries {
        if *budget == 0 {
            break;
        }
        *budget -= 1;

        let indent = 6.0 + (depth as f32) * 14.0;
        let ws_id_owned = ws_id.to_owned();
        let path = entry.path.clone();
        let is_dir = entry.is_dir;
        let expanded = if is_dir && !s.explorer_expanded_dirs.is_empty() {
            dir_key_buf.clear();
            dir_key_buf.push_str(ws_id);
            dir_key_buf.push_str("::");
            dir_key_buf.push_str(&entry.path);
            s.explorer_expanded_dirs.contains(dir_key_buf.as_str())
        } else {
            false
        };
        let file_glyph = if is_dir {
            &glyphs::FOLDER
        } else {
            &glyphs::FILE
        };

        let leading = if is_dir {
            let chev = if expanded {
                &glyphs::CHEVRON_DOWN
            } else {
                &icons::CHEVRON_RIGHT
            };
            rune::icon(chev, 12.0).color(k.c.icon_muted)
        } else {
            el().w(12.0).h(12.0)
        };

        let is_renaming = s
            .shell_ui
            .renaming_file_key
            .as_ref()
            .is_some_and(|(w, p)| w == ws_id && p == &entry.path);

        if is_renaming {
            rows.push(build_explorer_rename_row(
                s, ws_id, entry, indent, leading, file_glyph, k, t,
            ));
        } else {
            let ws_ctx = ws_id.to_owned();
            let path_ctx = entry.path.clone();
            let name_ctx = entry.name.clone();
            let ws_btn = ws_id.to_owned();
            let path_btn = entry.path.clone();
            let name_btn = entry.name.clone();

            let mut item = row()
                .key(format!("ws-file-{}", entry.path))
                .w_full()
                .h(26.0)
                .pl(indent)
                .pr(4.0)
                .gap(6.0)
                .radius(k.radius.sm)
                .center_y()
                .hover(k.c.hover)
                .on_press_tx(move |s: &mut AppState, _| {
                    open_or_toggle_explorer_entry(s, &ws_id_owned, &path, is_dir);
                })
                .on_secondary_press(move |s: &mut AppState, pt, _| {
                    s.shell_ui.file_context_menu = Some(ExplorerContextMenu {
                        workspace_id: ws_ctx.clone(),
                        path: path_ctx.clone(),
                        name: name_ctx.clone(),
                        is_dir,
                        point: Some(pt),
                    });
                })
                .child(leading)
                .child(rune::icon(file_glyph, 14.0).color(k.c.icon_muted))
                .child(
                    text(entry.name.clone())
                        .font(k.ty.small)
                        .color(k.c.text_base)
                        .truncate()
                        .grow(1.0)
                        .shrink(),
                );
            if let Some(git_st) = &entry.git_status {
                item = item.child(text(git_st.clone()).font(k.ty.small_medium).color(t.accent));
            } else if let Some(size) = entry.size_bytes
                && !entry.is_dir
            {
                item = item.child(
                    text(format_bytes(size))
                        .font(k.ty.small)
                        .color(k.c.text_faint),
                );
            }

            let actions_btn = IconButton::new(&icons::MORE_HORIZONTAL)
                .variant(IconButtonVariant::GhostMuted)
                .control_size(ControlSize::Small)
                .help("File actions")
                .on_press_tx(move |s: &mut AppState, _| {
                    s.shell_ui.file_context_menu = Some(ExplorerContextMenu {
                        workspace_id: ws_btn.clone(),
                        path: path_btn.clone(),
                        name: name_btn.clone(),
                        is_dir,
                        point: None,
                    });
                })
                .build(k)
                .key(format!("ws-file-actions-{}", entry.path));

            let active_menu = s
                .shell_ui
                .file_context_menu
                .as_ref()
                .filter(|m| m.workspace_id == ws_id && m.path == entry.path);
            let trailing_control = if let Some(menu) = active_menu {
                if menu.point.is_none() {
                    build_explorer_context_menu(menu, expanded, Some(actions_btn.clone()), k, layer)
                        .unwrap_or(actions_btn)
                } else {
                    let _ = build_explorer_context_menu(menu, expanded, None, k, layer);
                    actions_btn
                }
            } else {
                actions_btn
            };

            rows.push(item.child(trailing_control));
        }

        if expanded {
            let child_indent = 20.0 + (depth as f32) * 14.0;
            match lookup_explorer_entries(s, &entry.path) {
                Some([]) => {
                    if *budget > 0 {
                        *budget -= 1;
                        rows.push(
                            row()
                                .key(format!("ws-dir-empty-{}", entry.path))
                                .w_full()
                                .h(22.0)
                                .pl(child_indent)
                                .center_y()
                                .child(text("Empty folder").font(k.ty.small).color(k.c.text_faint)),
                        );
                    }
                }
                Some(_) => {
                    push_explorer_tree(
                        rows,
                        s,
                        ws_id,
                        &entry.path,
                        depth + 1,
                        budget,
                        dir_key_buf,
                        k,
                        t,
                        layer,
                    );
                }
                None => {
                    if *budget > 0 {
                        *budget -= 1;
                        rows.push(
                            row()
                                .key(format!("ws-dir-loading-{}", entry.path))
                                .w_full()
                                .h(22.0)
                                .pl(child_indent)
                                .center_y()
                                .child(text("Loading…").font(k.ty.small).color(k.c.text_faint)),
                        );
                    }
                }
            }
        }
    }
}

fn build_workspace_files_card(
    s: &AppState,
    k: &Kit,
    t: &ThemeTokens,
    layer: &mut Vec<El>,
    apply_root_key: bool,
) -> El {
    let Some(ws) = s.active_workspace() else {
        let card = context_section_unkeyed(
            "Workspace files",
            &icons::FOLDER,
            None,
            text("No workspace selected.")
                .font(k.ty.small)
                .color(k.c.text_muted),
            k,
            t,
        );
        return if apply_root_key {
            card.key("context-files-empty")
        } else {
            card
        };
    };

    let ws_id_refresh = ws.id.clone();
    let refresh_btn = Button::new("Refresh")
        .variant(ButtonVariant::GhostMuted)
        .control_size(ControlSize::Small)
        .icon(&icons::REFRESH)
        .on_press_tx(move |s: &mut AppState, _| {
            s.dispatch(Action::Native(NativeAction::ListWorkspaceFiles {
                workspace_id: ws_id_refresh.clone(),
                dir: ".".to_string(),
            }));
            let prefix = format!("{ws_id_refresh}::");
            let expanded: Vec<String> = s
                .explorer_expanded_dirs
                .iter()
                .filter_map(|key| key.strip_prefix(&prefix).map(str::to_owned))
                .collect();
            for dir in expanded {
                s.dispatch(Action::Native(NativeAction::ListWorkspaceFiles {
                    workspace_id: ws_id_refresh.clone(),
                    dir,
                }));
            }
        })
        .build(k)
        .key("context-files-refresh");

    let root_entries = lookup_explorer_entries(s, ".");
    let body = match root_entries {
        None => text("Click refresh to browse workspace files.")
            .font(k.ty.small)
            .color(k.c.text_muted),
        Some([]) => text("Workspace folder is empty.")
            .font(k.ty.small)
            .color(k.c.text_muted),
        Some(_) => {
            let mut rows = Vec::new();
            let mut budget = 120usize;
            let mut dir_key_buf = String::new();
            push_explorer_tree(
                &mut rows,
                s,
                &ws.id,
                ".",
                0,
                &mut budget,
                &mut dir_key_buf,
                k,
                t,
                layer,
            );
            col().w_full().gap(2.0).children(rows)
        }
    };

    let card = context_section_unkeyed(
        format!("Files · {}", ws.name),
        &icons::FOLDER,
        Some(refresh_btn),
        body,
        k,
        t,
    );
    if apply_root_key {
        card.key("context-files-card")
    } else {
        card
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::WorkspaceFileEntry;

    #[test]
    fn explorer_lookup_handles_dot_slash_and_workspace_scoping() {
        let mut s = AppState::default();
        s.explorer_entries_by_dir.insert(
            "src".into(),
            vec![WorkspaceFileEntry {
                name: "main.rs".into(),
                path: "src/main.rs".into(),
                is_dir: false,
                size_bytes: Some(128),
                git_status: None,
            }],
        );
        assert!(lookup_explorer_entries(&s, "./src").is_some());
        assert_ne!(
            explorer_dir_state_key("ws-1", "src"),
            explorer_dir_state_key("ws-2", "src")
        );
    }

    #[test]
    fn opening_agent_run_from_context_closes_sidebar_and_narrow_drawer() {
        let mut s = AppState::default();
        s.dispatch(Action::Shell(ShellAction::SetContextSidebarOpen(true)));
        s.shell_ui.right_overlay_open = true;
        s.dispatch(Action::Navigate(crate::actions::NavAction::OpenThread(
            "th-1".into(),
        )));

        assert!(s.context_sidebar.is_open());
        open_agent_run_from_context(&mut s, "sub-rev-1".into(), "Reviewer".into());

        assert!(!s.context_sidebar.is_open());
        assert!(!s.shell_ui.right_overlay_open);
        assert!(s.agent_viewer.is_some());
    }

    #[test]
    fn explorer_rename_validation_and_escape_lifecycle() {
        assert!(validate_explorer_rename("notes.md", "   ").is_err());
        assert!(validate_explorer_rename("notes.md", ".").is_err());
        assert!(validate_explorer_rename("notes.md", "..").is_err());
        assert!(validate_explorer_rename("notes.md", "sub/notes.md").is_err());
        assert!(validate_explorer_rename("notes.md", r"sub\notes.md").is_err());
        assert!(validate_explorer_rename("notes.md", "bad\0name").is_err());
        assert_eq!(validate_explorer_rename("notes.md", " notes.md "), Ok(None));
        assert_eq!(
            validate_explorer_rename("notes.md", "Notes.md"),
            Ok(Some("Notes.md".to_string()))
        );
        assert_eq!(
            validate_explorer_rename("notes.md", " summary.md "),
            Ok(Some("summary.md".to_string()))
        );

        let mut s = AppState::default();
        start_explorer_rename(
            &mut s,
            "ws-1".into(),
            "/tmp/ws-1/notes.md".into(),
            "notes.md".into(),
        );
        assert_eq!(
            s.shell_ui.renaming_file_key,
            Some(("ws-1".into(), "/tmp/ws-1/notes.md".into()))
        );
        assert_eq!(s.shell_ui.renaming_file_edit.text, "notes.md");
        assert!(s.shell_ui.renaming_file_edit.focused);

        s.shell_ui.renaming_file_edit.replace_text("bad/name");
        commit_explorer_rename(&mut s, "ws-1", "/tmp/ws-1/notes.md", "notes.md");
        assert!(s.shell_ui.renaming_file_key.is_some());
        assert!(s.shell_ui.renaming_file_error.is_some());

        assert!(crate::views::shell::state::handle_escape(&mut s));
        assert!(s.shell_ui.renaming_file_key.is_none());
        assert!(s.shell_ui.renaming_file_error.is_none());

        start_explorer_rename(
            &mut s,
            "ws-1".into(),
            "/tmp/ws-1/notes.md".into(),
            "notes.md".into(),
        );
        s.shell_ui.renaming_file_edit.replace_text(" summary.md ");
        commit_explorer_rename(&mut s, "ws-1", "/tmp/ws-1/notes.md", "notes.md");
        assert!(s.shell_ui.renaming_file_key.is_none());
        assert!(s.shell_ui.renaming_file_error.is_none());
    }

    #[test]
    fn explorer_fs_path_resolution_and_parent_dir_handle_relative_and_absolute() {
        let mut s = AppState::default();
        s.workspaces.push(crate::state::WorkspaceRecord {
            id: "ws-1".into(),
            name: "Demo".into(),
            path: "/tmp/demo-ws".into(),
            ..Default::default()
        });

        assert_eq!(
            resolve_explorer_fs_path(&s, "ws-1", "src/main.rs"),
            "/tmp/demo-ws/src/main.rs"
        );
        assert_eq!(
            resolve_explorer_fs_path(&s, "ws-1", "./notes.md"),
            "/tmp/demo-ws/notes.md"
        );
        assert_eq!(resolve_explorer_fs_path(&s, "ws-1", "."), "/tmp/demo-ws");
        assert_eq!(
            resolve_explorer_fs_path(&s, "ws-1", "/tmp/demo-ws/README.md"),
            "/tmp/demo-ws/README.md"
        );

        assert_eq!(explorer_parent_dir(&s, "ws-1", "notes.md"), "");
        assert_eq!(explorer_parent_dir(&s, "ws-1", "src/main.rs"), "src");
        assert_eq!(
            explorer_parent_dir(&s, "ws-1", "/tmp/demo-ws/src/nested/a.rs"),
            "src/nested"
        );
        assert_eq!(
            explorer_parent_dir(&s, "ws-1", "/tmp/demo-ws/README.md"),
            ""
        );

        s.shell_ui.pending_trash_entry = Some(crate::views::shell::state::PendingTrashEntry {
            workspace_id: "ws-1".into(),
            path: "src/main.rs".into(),
            name: "main.rs".into(),
            is_dir: false,
        });
        assert!(crate::views::shell::state::handle_escape(&mut s));
        assert!(s.shell_ui.pending_trash_entry.is_none());
    }

    #[test]
    fn opening_non_canvas_file_from_context_closes_context_and_menu_has_full_width() {
        let mut s = AppState::default();
        s.workspaces.push(crate::state::WorkspaceRecord {
            id: "ws-1".into(),
            name: "Demo".into(),
            path: "/tmp/demo-ws".into(),
            ..Default::default()
        });
        s.active_workspace_id = Some("ws-1".into());
        s.feature_flags.insert("canvas".into(), true);
        s.dispatch(Action::Shell(ShellAction::SetContextSidebarOpen(true)));
        s.shell_ui.right_overlay_open = true;

        open_or_toggle_explorer_entry(&mut s, "ws-1", "notes.md", false);
        assert!(
            s.context_sidebar.is_open(),
            "Canvas-supported file replaces context rail cleanly without closing context preference"
        );

        open_or_toggle_explorer_entry(&mut s, "ws-1", "budget.csv", false);
        assert!(
            !s.context_sidebar.is_open() && !s.shell_ui.right_overlay_open,
            "Non-canvas inline preview should close Context to avoid a 4-pane squeeze"
        );

        let mut s_menu = AppState::default();
        s_menu.workspaces.push(crate::state::WorkspaceRecord {
            id: "ws-1".into(),
            name: "Demo".into(),
            path: "/tmp/demo-ws".into(),
            ..Default::default()
        });
        s_menu.active_workspace_id = Some("ws-1".into());
        s_menu.explorer_entries_by_dir.insert(
            ".".into(),
            vec![WorkspaceFileEntry {
                name: "budget.csv".into(),
                path: "budget.csv".into(),
                is_dir: false,
                size_bytes: Some(128),
                git_status: None,
            }],
        );
        s_menu.shell_ui.file_context_menu = Some(ExplorerContextMenu {
            workspace_id: "ws-1".into(),
            path: "budget.csv".into(),
            name: "budget.csv".into(),
            is_dir: false,
            point: None,
        });

        let mut rt = rune::Runtime::new(
            s_menu,
            |state: &AppState, cx: &mut rune::Cx<AppState>| {
                let dark = state.effective_dark(cx.system_dark());
                let (kit, tokens) = crate::theme::build_kit_with_accent(
                    dark,
                    state.desktop_settings.reduced_transparency,
                    state.desktop_settings.high_contrast,
                    state.desktop_settings.accent_palette,
                );
                let mut layer = Vec::new();
                let body = build_context_sidebar(state, &kit, &tokens, &mut layer);
                rune_kit::root(body, layer)
            },
            (360.0, 600.0),
            rune::Env::new(true, 1.0),
        );
        rt.frame(0.0);
        let (menu_rect, _) = rt
            .presented("ws-file-ctx-budget.csv-menu")
            .expect("explorer context menu should be mounted");
        assert!(
            menu_rect[2] >= 220.0,
            "explorer menu must expand to >= 220px to avoid label truncation, got w={}",
            menu_rect[2]
        );
    }
}
