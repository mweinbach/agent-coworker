//! Tasks & Workflow Runs views (`TaskView`, `NewTaskLanding`, `WorkflowRunsPanel`).

use rune::{El, ScrollSpec, col, el, icon, row, spacer, text};
use rune_kit::{Badge, Button, ButtonVariant, Card, ControlSize, Kit};

use crate::actions::{Action, NavAction};
use crate::router::ViewId;
use crate::state::{AppState, TaskRecordView, TaskSummaryView, WorkflowRunView};
use crate::theme::ThemeTokens;

use super::{helpers, icons};

/// Render the `ViewId::Task` primary view: either the active `TaskView` workspace
/// or the `NewTaskLanding` overview with recent tasks and workflow runs.
pub fn build_task_view(s: &AppState, k: &Kit, t: &ThemeTokens) -> El {
    let active_ws_id = s
        .active_workspace_id
        .as_deref()
        .or_else(|| s.workspaces.first().map(|w| w.id.as_str()));

    if let Some(task) = s.active_task.as_ref() {
        return build_active_task_workspace(s, task, k, t);
    }

    build_new_task_landing(s, active_ws_id, k, t)
}

fn build_new_task_landing(
    s: &AppState,
    active_ws_id: Option<&str>,
    k: &Kit,
    t: &ThemeTokens,
) -> El {
    let ws_name = active_ws_id
        .and_then(|id| s.workspaces.iter().find(|w| w.id == id))
        .map(|w| w.name.as_str())
        .unwrap_or("No workspace selected");

    let ws_for_btn = active_ws_id.map(str::to_owned);
    let hero = Card::new()
        .accent(t.accent)
        .title("Tasks & Structured Workflows", Some(&icons::CHECK_SQUARE))
        .description(format!(
            "Track multi-step deliverables, review artifacts, and inspect automated workflow runs in {ws_name}."
        ))
        .action(
            Button::new("Start task chat")
                .variant(ButtonVariant::Contrast)
                .icon(&icons::PLUS)
                .on_press_tx(move |s: &mut AppState, _| {
                    s.dispatch(Action::Navigate(NavAction::OpenNewChat {
                        workspace_id: ws_for_btn.clone(),
                    }));
                })
                .build(k),
        )
        .build(k);

    let tasks_section = if s.tasks.is_empty() {
        el().w_full()
            .padding(14.0)
            .radius(8.0)
            .fill(t.card_bg)
            .border(1.0, t.border_muted)
            .child(
                text("No tasks in this workspace yet. Start a conversation or schedule a workflow run.")
                    .font(t.body)
                    .color(t.text_muted),
            )
    } else {
        col()
            .key("task-landing-list")
            .w_full()
            .gap(6.0)
            .children(s.tasks.iter().map(|task| task_list_row(s, task, k, t)))
    };

    let runs_section = build_workflow_runs_panel(s, k, t);

    col()
        .key("new-task-landing")
        .w_full()
        .h_full()
        .min_h(0.0)
        .scroll(ScrollSpec {
            stick_bottom: false,
        })
        .padding(24.0)
        .gap(18.0)
        .child(
            el().w_full()
                .max_w(860.0)
                .fill(t.card_bg)
                .radius(10.0)
                .border(1.0, t.border)
                .child(hero),
        )
        .child(
            col()
                .w_full()
                .max_w(860.0)
                .gap(8.0)
                .child(text("Tasks").font(t.label).color(t.text_base))
                .child(tasks_section),
        )
        .child(el().w_full().max_w(860.0).child(runs_section))
}

fn task_list_row(s: &AppState, task: &TaskSummaryView, k: &Kit, t: &ThemeTokens) -> El {
    let task_id = task.id.clone();
    let badge_txt = task_status_label(&task.status);
    let schedule_or_age = task.schedule.clone().unwrap_or_else(|| {
        task.last_run_at
            .map(|ts| helpers::format_relative_age(ts, s.now_secs))
            .unwrap_or_default()
    });

    let mut meta_col = col()
        .grow(1.0)
        .shrink()
        .gap(2.0)
        .child(text(&task.title).font(t.body).color(t.text_base).truncate());
    if !schedule_or_age.is_empty() {
        meta_col = meta_col.child(
            text(schedule_or_age)
                .font(t.caption)
                .color(t.text_muted)
                .truncate(),
        );
    }

    el().key(format!("task-card-{}", task.id))
        .w_full()
        .padding(12.0)
        .radius(8.0)
        .fill(t.card_bg)
        .border(1.0, t.border)
        .hover(t.hover)
        .on_press_tx(move |s: &mut AppState, _| {
            s.dispatch(Action::Navigate(NavAction::OpenTask(task_id.clone())));
        })
        .child(
            row()
                .w_full()
                .gap(10.0)
                .center_y()
                .child(icon(&icons::CHECK_SQUARE, 15.0).color(t.accent))
                .child(meta_col)
                .child(Badge::new(badge_txt).build(k)),
        )
}

fn build_active_task_workspace(
    s: &AppState,
    task: &TaskRecordView,
    k: &Kit,
    t: &ThemeTokens,
) -> El {
    let mut header_meta = col().grow(1.0).shrink().gap(2.0).child(
        text(&task.summary.title)
            .font(t.title)
            .color(t.text_base)
            .truncate(),
    );
    if !task.prompt.is_empty() {
        header_meta = header_meta.child(
            text(&task.prompt)
                .font(t.caption)
                .color(t.text_muted)
                .truncate(),
        );
    }

    let header = row()
        .key("task-workspace-header")
        .w_full()
        .px(20.0)
        .py(12.0)
        .gap(10.0)
        .center_y()
        .fill(t.panel_bg)
        .child(icon(&icons::CHECK_SQUARE, 16.0).color(t.accent))
        .child(header_meta)
        .child(Badge::new(task_status_label(&task.summary.status)).build(k))
        .child(
            Button::new("All tasks")
                .variant(ButtonVariant::Ghost)
                .control_size(ControlSize::Small)
                .on_press_tx(|s: &mut AppState, _| {
                    s.dispatch(Action::Navigate(NavAction::OpenView(ViewId::Task)));
                })
                .build(k),
        );

    let runs_to_show: Vec<WorkflowRunView> = if task.runs.is_empty() {
        s.workflow_runs.clone()
    } else {
        task.runs.clone()
    };

    let mut main_pane = col()
        .key("task-main-scroll")
        .grow(1.0)
        .shrink()
        .min_h(0.0)
        .h_full()
        .scroll(ScrollSpec {
            stick_bottom: false,
        })
        .padding(20.0)
        .gap(16.0)
        .child(
            el().w_full()
                .padding(14.0)
                .radius(10.0)
                .fill(t.card_bg)
                .border(1.0, t.border)
                .child(
                    Card::new()
                        .accent(t.accent)
                        .title("Task Prompt & Goal", Some(&icons::SPARKLES))
                        .description(if task.prompt.is_empty() {
                            "No prompt recorded for this task."
                        } else {
                            task.prompt.as_str()
                        })
                        .build(k),
                ),
        );

    if !task.artifacts.is_empty() {
        main_pane = main_pane.child(
            col()
                .w_full()
                .padding(14.0)
                .radius(10.0)
                .fill(t.card_bg)
                .border(1.0, t.border)
                .gap(8.0)
                .child(text("Artifacts").font(t.label).color(t.text_base))
                .children(task.artifacts.iter().map(|art| {
                    row()
                        .key(format!("task-art-{}", art.id))
                        .w_full()
                        .gap(8.0)
                        .center_y()
                        .child(icon(&icons::FILE_TEXT, 14.0).color(t.text_muted))
                        .child(text(&art.name).font(t.body).color(t.text_base).truncate())
                        .child(spacer())
                        .child(
                            text(&art.path)
                                .font(t.caption)
                                .color(t.text_faint)
                                .truncate(),
                        )
                })),
        );
    }

    main_pane = main_pane.child(render_runs_list(s, &runs_to_show, k, t));

    let mut summary_card = col()
        .w_full()
        .padding(10.0)
        .radius(8.0)
        .fill(t.card_bg)
        .border(1.0, t.border_muted)
        .gap(4.0)
        .child(text("Status").font(t.caption).color(t.text_faint))
        .child(
            text(task_status_label(&task.summary.status))
                .font(t.body)
                .color(t.text_base),
        );
    if let Some(sched) = task.summary.schedule.as_deref() {
        summary_card = summary_card
            .child(text("Schedule").font(t.caption).color(t.text_faint))
            .child(text(sched).font(t.caption).color(t.text_muted));
    }
    if let Some(ts) = task.summary.last_run_at {
        summary_card = summary_card
            .child(text("Last run").font(t.caption).color(t.text_faint))
            .child(
                text(helpers::format_relative_age(ts, s.now_secs))
                    .font(t.caption)
                    .color(t.text_muted),
            );
    }

    let side_summary = col()
        .key("task-context-summary")
        .w(280.0)
        .h_full()
        .min_h(0.0)
        .scroll(ScrollSpec {
            stick_bottom: false,
        })
        .padding(14.0)
        .gap(12.0)
        .fill(t.panel_bg)
        .child(text("Task Context").font(t.label).color(t.text_base))
        .child(summary_card);

    col()
        .key("active-task-view")
        .w_full()
        .h_full()
        .min_h(0.0)
        .child(header)
        .child(el().w_full().h(1.0).fill(t.border_muted))
        .child(
            row()
                .grow(1.0)
                .shrink()
                .min_h(0.0)
                .w_full()
                .child(main_pane)
                .child(el().w(1.0).h_full().fill(t.border_muted))
                .child(side_summary),
        )
}

fn build_workflow_runs_panel(s: &AppState, k: &Kit, t: &ThemeTokens) -> El {
    render_runs_list(s, &s.workflow_runs, k, t)
}

fn render_runs_list(s: &AppState, runs: &[WorkflowRunView], k: &Kit, t: &ThemeTokens) -> El {
    let panel = col().key("workflow-runs-panel").w_full().gap(8.0).child(
        row()
            .w_full()
            .center_y()
            .child(text("Workflow Runs").font(t.label).color(t.text_base))
            .child(spacer())
            .child(Badge::new(runs.len().to_string()).build(k)),
    );

    if runs.is_empty() {
        return panel.child(
            el().w_full()
                .padding(14.0)
                .radius(8.0)
                .fill(t.card_bg)
                .border(1.0, t.border_muted)
                .child(
                    text("No workflow runs recorded for this workspace.")
                        .font(t.body)
                        .color(t.text_muted),
                ),
        );
    }

    panel.children(runs.iter().map(|run| workflow_run_row(s, run, k, t)))
}

fn workflow_run_row(s: &AppState, run: &WorkflowRunView, k: &Kit, t: &ThemeTokens) -> El {
    let run_label = if run.workflow_name.is_empty() {
        run.id.as_str()
    } else {
        run.workflow_name.as_str()
    };
    let age = helpers::format_relative_age(run.started_at, s.now_secs);

    let mut label_col = col()
        .grow(1.0)
        .shrink()
        .gap(1.0)
        .child(text(run_label).font(t.body).color(t.text_base).truncate());
    if !age.is_empty() {
        label_col = label_col.child(text(age).font(t.caption).color(t.text_faint));
    }

    el().key(format!("wf-panel-row-{}", run.id))
        .w_full()
        .padding(10.0)
        .radius(8.0)
        .fill(t.card_bg)
        .border(1.0, t.border_muted)
        .child(
            row()
                .w_full()
                .gap(8.0)
                .center_y()
                .child(icon(&icons::CLOCK, 14.0).color(t.text_muted))
                .child(label_col)
                .child(Badge::new(run.status.as_str()).build(k)),
        )
}

fn task_status_label(status: &str) -> &str {
    match status {
        "draft" => "Draft",
        "running" | "in_progress" => "Running",
        "waiting_for_input" | "waiting" | "needs_input" => "Waiting for input",
        "completed" => "Completed",
        "failed" => "Failed",
        "cancelled" => "Cancelled",
        "" => "Scheduled",
        other => other,
    }
}
