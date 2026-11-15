//! Right context rail displaying plan todos, subagents, workflow runs, usage, and workspace files.
//!
//! Ported from `apps/desktop/src/ui/ContextSidebar.tsx`, `WorkflowRunsPanel.tsx`, and
//! workspace file explorer integration.

use rune::{El, ScrollSpec, col, row, text};
use rune_kit::{
    Badge, BadgeVariant, Button, ButtonVariant, Card, ControlSize, Divider, IconButton,
    IconButtonVariant, Kit, glyphs,
};

use crate::actions::{Action, ChatAction, NativeAction, ShellAction};
use crate::state::{AppState, ThreadRuntime};
use crate::theme::ThemeTokens;
use crate::views::shell::helpers::{format_bytes, format_cost_usd, format_tokens};
use crate::views::shell::icons;

/// Renders the right inspector sidebar panel for the active chat or task route.
pub fn build_context_sidebar(s: &AppState, k: &Kit, t: &ThemeTokens) -> El {
    let header = row()
        .key("context-sidebar-header")
        .w_full()
        .h(48.0)
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
                    s.dispatch(Action::Shell(ShellAction::SetContextSidebarOpen(false)));
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
            sections.push(build_subagents_card(rt, k));
        }
    }

    if !s.workflow_runs.is_empty() {
        sections.push(build_workflow_runs_card(s, k));
    }

    sections.push(build_workspace_files_card(s, k, t));

    if sections.is_empty() {
        sections.push(
            Card::new()
                .title("No active context", Some(&icons::INFO))
                .description("Select a workspace or start a thread to inspect plans, subagents, workflow runs, and workspace files.")
                .build(k),
        );
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

    Some(
        Card::new()
            .title("Usage", Some(&icons::SPARKLES))
            .child(card_body)
            .build(k)
            .key("context-usage-card"),
    )
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

    Card::new()
        .title("Plan", Some(&icons::CHECK_SQUARE))
        .child(list)
        .build(k)
        .key("context-plan-card")
}

fn build_subagents_card(rt: &ThreadRuntime, k: &Kit) -> El {
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
                    s.dispatch(Action::Chat(ChatAction::OpenAgentThread {
                        agent_id: aid.clone(),
                        title: Some(name.clone()),
                    }));
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

    Card::new()
        .title(
            format!("Subagents ({})", rt.agents.len()),
            Some(&icons::SPARKLES),
        )
        .child(list)
        .build(k)
        .key("context-subagents-card")
}

fn build_workflow_runs_card(s: &AppState, k: &Kit) -> El {
    let mut runs = s.workflow_runs.clone();
    runs.sort_by_key(|b| std::cmp::Reverse(b.started_at));

    let mut list = col().w_full().gap(6.0);
    for run in runs.into_iter().take(6) {
        list = list.child(
            col()
                .key(format!("workflow-run-{}", run.id))
                .w_full()
                .padding(8.0)
                .radius(k.radius.md)
                .fill(k.c.layer_02)
                .gap(4.0)
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

    Card::new()
        .title("Workflow runs", Some(&icons::CLOCK))
        .child(list)
        .build(k)
        .key("context-workflow-runs-card")
}

fn build_workspace_files_card(s: &AppState, k: &Kit, t: &ThemeTokens) -> El {
    let Some(ws) = s.active_workspace() else {
        return Card::new()
            .title("Workspace files", Some(&icons::FOLDER))
            .description("No workspace selected.")
            .build(k)
            .key("context-files-empty");
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
        })
        .build(k)
        .key("context-files-refresh");

    let entries = s
        .explorer_entries_by_dir
        .get(".")
        .map(Vec::as_slice)
        .unwrap_or(&[]);

    let body = if entries.is_empty() {
        text("Click refresh to browse workspace files.")
            .font(k.ty.small)
            .color(k.c.text_muted)
    } else {
        let mut rows = col().w_full().gap(2.0);
        for entry in entries.iter().take(40) {
            let ws_id = ws.id.clone();
            let path = entry.path.clone();
            let is_dir = entry.is_dir;
            let file_glyph = if is_dir {
                &glyphs::FOLDER
            } else {
                &glyphs::FILE
            };
            let mut item = row()
                .key(format!("ws-file-{}", entry.path))
                .w_full()
                .h(26.0)
                .px(6.0)
                .gap(6.0)
                .radius(k.radius.sm)
                .center_y()
                .hover(k.c.hover)
                .on_press_tx(move |s: &mut AppState, _| {
                    if is_dir {
                        s.dispatch(Action::Native(NativeAction::ListWorkspaceFiles {
                            workspace_id: ws_id.clone(),
                            dir: path.clone(),
                        }));
                    } else {
                        s.dispatch(Action::Native(NativeAction::LoadFilePreview {
                            workspace_id: ws_id.clone(),
                            path: path.clone(),
                        }));
                    }
                })
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
            rows = rows.child(item);
        }
        rows
    };

    Card::new()
        .title(format!("Files · {}", ws.name), Some(&icons::FOLDER))
        .action(refresh_btn)
        .child(body)
        .build(k)
        .key("context-files-card")
}
