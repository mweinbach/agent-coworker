//! Right context rail displaying plan todos, subagents, workflow runs, usage, and workspace files.
//!
//! Ported from `apps/desktop/src/ui/ContextSidebar.tsx`, `WorkflowRunsPanel.tsx`, and
//! workspace file explorer integration.

use std::collections::HashSet;

use rune::{Cursor, El, Icon, Key, ScrollSpec, col, el, row, text, text_input};
use rune_kit::{
    Badge, BadgeVariant, Button, ButtonVariant, ControlSize, Divider, IconButton,
    IconButtonVariant, Kit, Menu, MenuItem, Placement, glyphs,
};

use crate::actions::{Action, ChatAction, NativeAction, ShellAction};
use crate::state::{AppState, FeedItem, ThreadRuntime};
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

/// Clean rounded inspector section card with aligned icon/title header and optional header action.
fn context_section_card(
    key: &'static str,
    title: impl Into<String>,
    glyph: &'static Icon,
    trailing: Option<El>,
    body: El,
    k: &Kit,
    t: &ThemeTokens,
) -> El {
    let title_text = title.into();
    let mut header = row()
        .w_full()
        .gap(7.0)
        .center_y()
        .child(rune::icon(glyph, 13.0).color(t.text_muted).a11y_hidden())
        .child(
            text(title_text.clone())
                .font(k.ty.small_medium)
                .color(t.text_base)
                .truncate()
                .grow(1.0)
                .shrink()
                .min_w(0.0),
        );
    if let Some(action) = trailing {
        header = header.child(el().shrink().child(action));
    }

    col()
        .key(key)
        .role("group")
        .label(title_text)
        .w_full()
        .px(12.0)
        .py(10.0)
        .gap(10.0)
        .radius(10.0)
        .continuous_corners()
        .fill(t.elevated_bg)
        .border(1.0, t.border_muted)
        .child(header)
        .child(body)
}

/// A workspace file created, modified, or read during the active session.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionOutputFile {
    pub path: String,
    pub title: String,
    pub ext_tag: String,
    pub written: bool,
}

/// A tool capability, connector, skill, or memory source used during the active session.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionUsedItem {
    pub label: String,
    pub detail: String,
}

fn is_file_write_tool(lower: &str) -> bool {
    matches!(
        lower,
        "write"
            | "write_file"
            | "create_file"
            | "edit"
            | "edit_file"
            | "multi_edit"
            | "apply_patch"
            | "save_file"
            | "notebook_edit"
            | "file_change"
            | "filechange"
    )
}

fn is_file_read_tool(lower: &str) -> bool {
    matches!(lower, "read" | "read_file" | "view_file" | "open_file")
}

fn extract_tool_file_paths(input: &serde_json::Value) -> Vec<String> {
    let mut paths = Vec::new();
    let Some(obj) = input.as_object() else {
        return paths;
    };
    for key in ["path", "file_path", "filePath", "target_file", "filename"] {
        if let Some(s) = obj
            .get(key)
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            paths.push(s.to_string());
        }
    }
    if let Some(arr) = obj.get("paths").and_then(|v| v.as_array()) {
        for v in arr {
            if let Some(s) = v.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                paths.push(s.to_string());
            }
        }
    }
    paths
}

fn split_output_display(path: &str) -> (String, String) {
    let file_name = path.rsplit(['/', '\\']).next().unwrap_or(path).trim();
    if let Some((stem, ext)) = file_name.rsplit_once('.')
        && !stem.is_empty()
        && !ext.is_empty()
        && ext.len() <= 6
    {
        let humanized = stem.replace(['_', '-'], " ");
        let mut chars = humanized.chars();
        let title = match chars.next() {
            Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
            None => file_name.to_string(),
        };
        return (title, ext.to_ascii_uppercase());
    }
    (file_name.to_string(), "FILE".to_string())
}

/// Extracts deduplicated session output/referenced files and capabilities used from a thread feed.
pub fn collect_session_outputs_and_used(
    rt: &ThreadRuntime,
) -> (Vec<SessionOutputFile>, Vec<SessionUsedItem>) {
    let mut written_files: Vec<SessionOutputFile> = Vec::new();
    let mut read_files: Vec<SessionOutputFile> = Vec::new();
    let mut seen_paths: HashSet<String> = HashSet::new();

    let mut memory_ops = 0usize;
    let mut web_ops = 0usize;
    let mut shell_ops = 0usize;
    let mut mcp_servers: Vec<String> = Vec::new();
    let mut mcp_seen: HashSet<String> = HashSet::new();

    for item in &rt.feed {
        let FeedItem::Tool {
            tool_name, input, ..
        } = item
        else {
            continue;
        };
        let lower = tool_name.to_ascii_lowercase();
        if is_file_write_tool(&lower) || is_file_read_tool(&lower) {
            let written = is_file_write_tool(&lower);
            for raw_path in extract_tool_file_paths(input) {
                if seen_paths.insert(raw_path.clone()) {
                    let (title, ext_tag) = split_output_display(&raw_path);
                    let entry = SessionOutputFile {
                        path: raw_path,
                        title,
                        ext_tag,
                        written,
                    };
                    if written {
                        written_files.push(entry);
                    } else {
                        read_files.push(entry);
                    }
                } else if written {
                    // Promote an earlier read-only entry to written.
                    if let Some(pos) = read_files.iter().position(|f| f.path == raw_path) {
                        let mut promoted = read_files.remove(pos);
                        promoted.written = true;
                        written_files.push(promoted);
                    }
                }
            }
        }
        if lower.contains("memory") {
            memory_ops += 1;
        } else if lower.contains("web") || lower.contains("search") || lower.contains("fetch") {
            web_ops += 1;
        } else if matches!(
            lower.as_str(),
            "bash" | "commandexecution" | "command_execution" | "execute"
        ) {
            shell_ops += 1;
        } else if let Some(rest) = tool_name.strip_prefix("mcp__")
            && let Some((server, _)) = rest.split_once("__")
            && !server.is_empty()
            && mcp_seen.insert(server.to_string())
        {
            mcp_servers.push(server.to_string());
        }
    }

    written_files.extend(read_files);

    let mut used = Vec::new();
    if memory_ops > 0 {
        used.push(SessionUsedItem {
            label: "Memory".to_string(),
            detail: if memory_ops == 1 {
                "1 lookup".to_string()
            } else {
                format!("{memory_ops} lookups")
            },
        });
    }
    if web_ops > 0 {
        used.push(SessionUsedItem {
            label: "Web".to_string(),
            detail: if web_ops == 1 {
                "1 query".to_string()
            } else {
                format!("{web_ops} queries")
            },
        });
    }
    if shell_ops > 0 {
        used.push(SessionUsedItem {
            label: "Terminal".to_string(),
            detail: if shell_ops == 1 {
                "1 command".to_string()
            } else {
                format!("{shell_ops} commands")
            },
        });
    }
    for srv in mcp_servers {
        used.push(SessionUsedItem {
            label: srv,
            detail: "MCP".to_string(),
        });
    }
    if !rt.agents.is_empty() {
        let count = rt.agents.len();
        used.push(SessionUsedItem {
            label: "Subagents".to_string(),
            detail: if count == 1 {
                "1 run".to_string()
            } else {
                format!("{count} runs")
            },
        });
    }

    (written_files, used)
}

fn build_outputs_card(
    s: &AppState,
    outputs: &[SessionOutputFile],
    k: &Kit,
    t: &ThemeTokens,
) -> Option<El> {
    if outputs.is_empty() {
        return None;
    }
    let ws_id = s.active_workspace_id.clone();
    let mut list = col().w_full().gap(2.0);
    for (idx, file) in outputs.iter().take(12).enumerate() {
        let path_open = file.path.clone();
        let ws_open = ws_id.clone();
        let mut item_row = row()
            .key(format!("context-output:{idx}"))
            .w_full()
            .items_center()
            .gap(8.0)
            .px(8.0)
            .py(6.5)
            .radius(7.0)
            .continuous_corners()
            .hover(t.hover)
            .cursor(Cursor::Pointer)
            .role("button")
            .label(format!("Open {}", file.title))
            .child(
                rune::icon(&icons::FILE_TEXT, 13.0)
                    .color(if file.written {
                        t.text_base
                    } else {
                        t.text_muted
                    })
                    .a11y_hidden(),
            )
            .child(
                text(file.title.clone())
                    .font(if file.written {
                        k.ty.small_medium
                    } else {
                        k.ty.small
                    })
                    .color(t.text_base)
                    .truncate()
                    .grow(1.0)
                    .shrink()
                    .min_w(0.0),
            )
            .child(
                text(file.ext_tag.clone())
                    .font(k.ty.text_xsmall)
                    .color(t.text_faint),
            );
        if let Some(wid) = ws_open {
            item_row = item_row.on_press(move |s: &mut AppState| {
                s.shell_ui.canvas_overlay_dismissed_key = None;
                if !(s.is_canvas_enabled()
                    && crate::views::chat::is_canvas_document_path(&path_open))
                {
                    close_context_inspector(s);
                }
                s.dispatch(Action::Native(NativeAction::LoadFilePreview {
                    workspace_id: wid.clone(),
                    path: path_open.clone(),
                }));
            });
        }
        list = list.child(item_row);
    }

    Some(context_section_card(
        "context-outputs-card",
        "Outputs",
        &icons::FILE_TEXT,
        Some(
            Badge::new(outputs.len().to_string())
                .variant(BadgeVariant::Subtle)
                .build(k),
        ),
        list,
        k,
        t,
    ))
}

fn build_used_in_session_card(used: &[SessionUsedItem], k: &Kit, t: &ThemeTokens) -> Option<El> {
    if used.is_empty() {
        return None;
    }
    let mut list = col().w_full().gap(6.0);
    for (idx, item) in used.iter().enumerate() {
        list = list.child(
            row()
                .key(format!("context-used:{idx}"))
                .w_full()
                .items_center()
                .justify_between()
                .gap(8.0)
                .px(4.0)
                .child(
                    text(item.label.clone())
                        .font(k.ty.small)
                        .color(t.text_base)
                        .truncate(),
                )
                .child(
                    text(item.detail.clone())
                        .font(k.ty.text_xsmall)
                        .color(t.text_faint),
                ),
        );
    }
    Some(context_section_card(
        "context-used-card",
        "Used in this session",
        &icons::PLUGINS,
        None,
        list,
        k,
        t,
    ))
}

/// Renders the right inspector sidebar panel for the active chat or task route.
pub fn build_context_sidebar(s: &AppState, k: &Kit, t: &ThemeTokens, layer: &mut Vec<El>) -> El {
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
        let (outputs, used) = collect_session_outputs_and_used(rt);
        if let Some(outputs_card) = build_outputs_card(s, &outputs, k, t) {
            sections.push(outputs_card);
        }
        if let Some(used_card) = build_used_in_session_card(&used, k, t) {
            sections.push(used_card);
        }
        if !rt.todos.is_empty() {
            sections.push(build_plan_card(rt, k, t));
        }
        if !rt.agents.is_empty() {
            sections.push(build_subagents_card(rt, k, t));
        }
        if let Some(usage_card) = build_usage_card(s, rt, k, t) {
            sections.push(usage_card);
        }
    }

    if !s.workflow_runs.is_empty() {
        sections.push(build_workflow_runs_card(s, k, t));
    }

    sections.push(build_workspace_files_card(s, k, t, layer));

    if sections.is_empty() {
        sections.push(context_section_card(
            "context-empty-card",
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
        .key("context-sidebar")
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
    let metric = |label: &str, value: String| {
        row()
            .w_full()
            .justify_between()
            .items_center()
            .child(
                text(label.to_owned())
                    .font(k.ty.small)
                    .color(k.c.text_muted),
            )
            .child(text(value).font(k.ty.small_medium).color(k.c.text_base))
    };

    let mut card_body = col()
        .w_full()
        .gap(6.0)
        .child(metric(
            "Estimated cost",
            format_cost_usd(usage.estimated_cost_usd),
        ))
        .child(metric("Input tokens", format_tokens(usage.input_tokens)))
        .child(metric("Output tokens", format_tokens(usage.output_tokens)))
        .child(metric("Cached tokens", format_tokens(usage.cached_tokens)));

    if let Some(cap) = rt.usage_hard_cap {
        card_body = card_body.child(metric("Hard cap", format_cost_usd(cap)));
    }
    if rt.usage_hard_cap_reached
        && let Some(thread_id) = s.route().active_thread_id.clone()
    {
        card_body = card_body.child(
            row()
                .w_full()
                .pt(4.0)
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

    Some(context_section_card(
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

    context_section_card(
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
                .fill(t.panel_bg)
                .border(1.0, t.border_muted)
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

    context_section_card(
        "context-subagents-card",
        format!("Subagents ({})", rt.agents.len()),
        &icons::SPARKLES,
        None,
        list,
        k,
        t,
    )
}

fn build_workflow_runs_card(s: &AppState, k: &Kit, t: &ThemeTokens) -> El {
    let mut runs = s.workflow_runs.clone();
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
                .fill(t.panel_bg)
                .border(1.0, t.border_muted)
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

    context_section_card(
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
        let dir_key = explorer_dir_state_key(ws_id, &entry.path);
        let expanded = is_dir && s.explorer_expanded_dirs.contains(&dir_key);
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
                    push_explorer_tree(rows, s, ws_id, &entry.path, depth + 1, budget, k, t, layer);
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

fn build_workspace_files_card(s: &AppState, k: &Kit, t: &ThemeTokens, layer: &mut Vec<El>) -> El {
    let Some(ws) = s.active_workspace() else {
        return context_section_card(
            "context-files-empty",
            "Workspace files",
            &icons::FOLDER,
            None,
            text("No workspace selected.")
                .font(k.ty.small)
                .color(k.c.text_muted),
            k,
            t,
        );
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
            push_explorer_tree(&mut rows, s, &ws.id, ".", 0, &mut budget, k, t, layer);
            col().w_full().gap(2.0).children(rows)
        }
    };

    context_section_card(
        "context-files-card",
        format!("Files · {}", ws.name),
        &icons::FOLDER,
        Some(refresh_btn),
        body,
        k,
        t,
    )
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

    #[test]
    fn collect_session_outputs_and_used_prioritizes_written_files_and_summarizes_capabilities() {
        let mut rt = ThreadRuntime::default();
        rt.feed.push(FeedItem::Tool {
            id: "t1".into(),
            tool_name: "read".into(),
            title: None,
            status: crate::state::ToolRunStatus::Completed,
            input: serde_json::json!({ "path": "docs/notes.md" }),
            output: None,
            error: None,
            diff: None,
            timestamp_ms: 1,
            completed_at_ms: Some(2),
            output_truncated: false,
            streaming: false,
            call_id: None,
        });
        rt.feed.push(FeedItem::Tool {
            id: "t2".into(),
            tool_name: "write_file".into(),
            title: None,
            status: crate::state::ToolRunStatus::Completed,
            input: serde_json::json!({ "file_path": "brief/atlas-polish-brief.md" }),
            output: None,
            error: None,
            diff: None,
            timestamp_ms: 3,
            completed_at_ms: Some(4),
            output_truncated: false,
            streaming: false,
            call_id: None,
        });
        rt.feed.push(FeedItem::Tool {
            id: "t3".into(),
            tool_name: "mcp__chrome__click".into(),
            title: None,
            status: crate::state::ToolRunStatus::Completed,
            input: serde_json::json!({}),
            output: None,
            error: None,
            diff: None,
            timestamp_ms: 5,
            completed_at_ms: Some(6),
            output_truncated: false,
            streaming: false,
            call_id: None,
        });
        rt.feed.push(FeedItem::Tool {
            id: "t4".into(),
            tool_name: "read_memory".into(),
            title: None,
            status: crate::state::ToolRunStatus::Completed,
            input: serde_json::json!({}),
            output: None,
            error: None,
            diff: None,
            timestamp_ms: 7,
            completed_at_ms: Some(8),
            output_truncated: false,
            streaming: false,
            call_id: None,
        });

        let (outputs, used) = collect_session_outputs_and_used(&rt);
        assert_eq!(outputs.len(), 2);
        assert_eq!(outputs[0].path, "brief/atlas-polish-brief.md");
        assert_eq!(outputs[0].title, "Atlas polish brief");
        assert_eq!(outputs[0].ext_tag, "MD");
        assert!(outputs[0].written);
        assert_eq!(outputs[1].path, "docs/notes.md");
        assert!(!outputs[1].written);

        let used_labels: Vec<&str> = used.iter().map(|u| u.label.as_str()).collect();
        assert_eq!(used_labels, vec!["Memory", "chrome"]);
    }
}
