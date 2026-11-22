//! Tasks & Workflow Runs views (`TaskView`, `NewTaskLanding`, `TaskQuestionsCard`,
//! `ArtifactReviewCard`, `TaskContextSidebar`, `WorkflowRunsPanel`).

use std::collections::HashMap;
use std::sync::LazyLock;

use rune::{Cx, El, ScrollSpec, TextEdit, col, el, icon, row, spacer, text};
use rune_kit::shell::{TabItem, TabOrientation, TabStrip};
use rune_kit::{Badge, BadgeVariant, Button, ButtonVariant, Card, ControlSize, Kit, TextInput};
use serde_json::Value;

use crate::actions::{Action, NavAction, TaskAction, TaskQuestionAnswerParam};
use crate::router::ViewId;
use crate::state::{AppState, TaskArtifactView, TaskRecordView, TaskSummaryView, WorkflowRunView};
use crate::theme::ThemeTokens;

use super::{helpers, icons};

static EMPTY_TASK_QUESTION_REPLY_EDIT: LazyLock<TextEdit> = LazyLock::new(TextEdit::default);

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct TaskQuestionOption {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) description: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct TaskQuestionItem {
    pub(crate) id: String,
    pub(crate) header: String,
    pub(crate) question: String,
    pub(crate) blocking: bool,
    pub(crate) recommended_option_id: Option<String>,
    pub(crate) options: Vec<TaskQuestionOption>,
}

/// Extract structured task questions from `TaskRecordView.questions` JSON.
pub(crate) fn extract_task_questions(value: &Value) -> Vec<TaskQuestionItem> {
    let arr = match value {
        Value::Array(items) => Some(items),
        Value::Object(map) => map.get("questions").and_then(Value::as_array),
        _ => None,
    };
    let Some(arr) = arr else {
        return Vec::new();
    };

    arr.iter()
        .enumerate()
        .filter_map(|(idx, item)| {
            let obj = item.as_object()?;
            if let Some(status) = obj.get("status").and_then(Value::as_str) {
                if !status.eq_ignore_ascii_case("pending") {
                    return None;
                }
            } else {
                let resolved = obj
                    .get("resolved")
                    .or_else(|| obj.get("answered"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                    || obj
                        .get("resolvedAt")
                        .and_then(Value::as_str)
                        .is_some_and(|s| !s.trim().is_empty());
                if resolved {
                    return None;
                }
            }
            let id = obj
                .get("id")
                .or_else(|| obj.get("questionId"))
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| format!("q-{}", idx + 1));
            let question = obj
                .get("question")
                .or_else(|| obj.get("prompt"))
                .or_else(|| obj.get("text"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            let header = obj
                .get("header")
                .or_else(|| obj.get("title"))
                .and_then(Value::as_str)
                .unwrap_or("Question")
                .to_owned();
            let blocking = obj
                .get("blocking")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let recommended_option_id = obj
                .get("recommendedOptionId")
                .or_else(|| obj.get("recommended_option_id"))
                .and_then(Value::as_str)
                .map(str::to_owned);
            let options: Vec<TaskQuestionOption> = obj
                .get("options")
                .and_then(Value::as_array)
                .map(|opts| {
                    opts.iter()
                        .filter_map(|opt| {
                            let o = opt.as_object()?;
                            let opt_id = o.get("id").and_then(Value::as_str)?.to_owned();
                            let label = o
                                .get("label")
                                .or_else(|| o.get("title"))
                                .and_then(Value::as_str)
                                .unwrap_or(opt_id.as_str())
                                .to_owned();
                            let description = o
                                .get("description")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_owned();
                            Some(TaskQuestionOption {
                                id: opt_id,
                                label,
                                description,
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            if question.is_empty() && options.is_empty() {
                return None;
            }
            Some(TaskQuestionItem {
                id,
                header,
                question,
                blocking,
                recommended_option_id,
                options,
            })
        })
        .collect()
}

/// Render the `ViewId::Task` primary view: either the active `TaskView` workspace
/// or the `NewTaskLanding` overview with inline task creation and workflow runs.
pub fn build_task_view(
    s: &AppState,
    cx: &mut Cx<AppState>,
    k: &Kit,
    t: &ThemeTokens,
    layer: &mut Vec<El>,
) -> El {
    let active_ws_id = s
        .active_workspace_id
        .as_deref()
        .or_else(|| s.workspaces.first().map(|w| w.id.as_str()));

    if let Some(id) = s.route().active_task_id.as_deref() {
        if let Some(task) = s.active_task.as_ref().filter(|task| task.summary.id == id) {
            let conversation = if s.shell_ui.task_conversation_open
                && s.active_thread()
                    .is_some_and(|th| th.source_task_id.as_deref() == Some(id))
            {
                let chat = crate::views::chat::view(s, cx, k);
                layer.extend(chat.overlays);
                let tabs = TabStrip::new("task-conversation-tabs", TabOrientation::Horizontal)
                    .label("Task conversations")
                    .active(s.route().active_thread_id.as_deref())
                    .viewport_width(
                        cx.layout_size("task-conversation-tabs")
                            .map(|[width, _]| width),
                    )
                    .tabs(task.threads.iter().map(|thread| {
                        TabItem::new(thread.session_id.as_str(), thread.title.as_str())
                            .icon(&icons::MESSAGE)
                            .closable(false)
                    }))
                    .on_select(|s: &mut AppState, session_id, tx| {
                        s.dispatch_tx(
                            Action::Navigate(NavAction::OpenThread(session_id.to_owned())),
                            tx,
                        );
                    })
                    .build(k);
                Some(
                    col()
                        .key("task-conversation")
                        .grow(1.0)
                        .min_w(0.0)
                        .min_h(0.0)
                        .child(row().w_full().h(36.0).px(8.0).center_y().child(tabs))
                        .child(chat.content),
                )
            } else {
                None
            };
            return build_active_task_workspace(s, task, conversation, k, t);
        }
        return col()
            .grow(1.0)
            .center()
            .child(text("Loading task…").color(t.text_muted));
    }

    build_new_task_landing(s, active_ws_id, k, t)
}

fn build_new_task_landing(
    s: &AppState,
    active_ws_id: Option<&str>,
    k: &Kit,
    t: &ThemeTokens,
) -> El {
    let description = match active_ws_id
        .and_then(|id| s.workspaces.iter().find(|w| w.id == id))
    {
        Some(w) => format!(
            "Track multi-step deliverables, review artifacts, and inspect automated workflow runs in {}.",
            w.name
        ),
        None => "Select or add a workspace folder to track multi-step deliverables, review artifacts, and automated workflow runs.".to_owned(),
    };

    let new_task = Button::new(if s.shell_ui.task_create_open {
        "Hide task form"
    } else {
        "New task"
    })
    .variant(ButtonVariant::Contrast)
    .icon(&icons::CHECK_SQUARE)
    .on_press_tx(|s: &mut AppState, _| {
        s.shell_ui.task_create_open = !s.shell_ui.task_create_open;
        s.shell_ui.task_create_title_edit.focused = s.shell_ui.task_create_open;
    })
    .build(k);

    let hero = Card::new()
        .accent(t.accent)
        .title("Tasks & Structured Workflows", Some(&icons::CHECK_SQUARE))
        .description(description)
        .action(new_task)
        .build(k);

    let create_form = s
        .shell_ui
        .task_create_open
        .then(|| build_task_create_card(s, active_ws_id, k, t));

    let mut tasks = s
        .tasks
        .iter()
        .filter(|task| Some(task.workspace_id.as_str()) == active_ws_id)
        .peekable();
    let tasks_section = if tasks.peek().is_none() {
        el().w_full()
            .padding(14.0)
            .radius(8.0)
            .fill(t.card_bg)
            .border(1.0, t.border_muted)
            .child(
                text("No tasks in this workspace yet. Create a task or start a workflow run.")
                    .font(t.body)
                    .color(t.text_muted),
            )
    } else {
        col()
            .key("task-landing-list")
            .w_full()
            .gap(6.0)
            .children(tasks.map(|task| task_list_row(s, task, k, t)))
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
        .children(create_form.map(|form| el().w_full().max_w(860.0).child(form)))
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

fn build_task_create_card(
    s: &AppState,
    active_ws_id: Option<&str>,
    k: &Kit,
    t: &ThemeTokens,
) -> El {
    let ws_for_submit = active_ws_id.map(str::to_owned);
    let can_submit = active_ws_id.is_some()
        && !s.shell_ui.task_create_title_edit.text.trim().is_empty()
        && !s.shell_ui.task_create_objective_edit.text.trim().is_empty();

    let title_input = TextInput::new(&s.shell_ui.task_create_title_edit)
        .placeholder("Task title (e.g. Audit dependency updates)")
        .label("Task title")
        .width(None)
        .on_edit(|s: &mut AppState| &mut s.shell_ui.task_create_title_edit)
        .build(k);

    let obj_input = TextInput::new(&s.shell_ui.task_create_objective_edit)
        .placeholder("Objective and acceptance criteria...")
        .label("Task objective")
        .width(None)
        .on_edit(|s: &mut AppState| &mut s.shell_ui.task_create_objective_edit)
        .build(k);

    let mut form = col()
        .key("task-create-card")
        .w_full()
        .padding(16.0)
        .radius(10.0)
        .fill(t.card_bg)
        .border(1.0, t.accent)
        .gap(10.0)
        .child(
            text("Create structured task")
                .font(t.label)
                .color(t.text_base),
        )
        .child(title_input)
        .child(obj_input);

    if active_ws_id.is_none() {
        form = form.child(
            text("Add or select a workspace folder first to create a task.")
                .font(t.caption)
                .color(t.warning),
        );
    }

    form.child(
        row()
            .w_full()
            .gap(8.0)
            .child(spacer())
            .child(
                Button::new("Cancel")
                    .variant(ButtonVariant::Outline)
                    .control_size(ControlSize::Small)
                    .on_press_tx(|s: &mut AppState, _| {
                        s.shell_ui.task_create_open = false;
                    })
                    .build(k),
            )
            .child(
                Button::new("Create task")
                    .variant(ButtonVariant::Contrast)
                    .control_size(ControlSize::Small)
                    .disabled(!can_submit || s.shell_ui.task_create_submitting)
                    .on_press_tx(move |s: &mut AppState, _| {
                        let Some(ws_id) = ws_for_submit.clone() else {
                            return;
                        };
                        let title = s.shell_ui.task_create_title_edit.text.trim().to_owned();
                        let objective =
                            s.shell_ui.task_create_objective_edit.text.trim().to_owned();
                        if title.is_empty() || objective.is_empty() {
                            return;
                        }
                        // Keep form open and inputs intact until the server accepts `task/create`
                        // so transient connection/validation errors remain retryable.
                        s.dispatch(Action::Task(TaskAction::CreateTask {
                            workspace_id: ws_id,
                            title,
                            objective,
                            context: None,
                            review_required: Some(true),
                            provider: None,
                            model: None,
                            idempotency_key: None,
                            requirements: Vec::new(),
                            work_items: Vec::new(),
                        }));
                    })
                    .build(k),
            ),
    )
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

    let mut row_el = row()
        .w_full()
        .gap(8.0)
        .center_y()
        .child(icon(&icons::CHECK_SQUARE, 15.0).color(t.accent))
        .child(meta_col);

    if task.pending_question_count > 0 {
        row_el = row_el.child(
            Badge::new(format!("{} Q", task.pending_question_count))
                .variant(BadgeVariant::Accent)
                .build(k),
        );
    }
    if task.active_blocker_count > 0 {
        row_el = row_el.child(
            Badge::new(format!("{} blocker", task.active_blocker_count))
                .variant(BadgeVariant::Accent)
                .high_contrast()
                .build(k),
        );
    }
    if task.total_work_item_count > 0 {
        row_el = row_el.child(
            Badge::new(format!(
                "{}/{}",
                task.completed_work_item_count, task.total_work_item_count
            ))
            .variant(BadgeVariant::Neutral)
            .build(k),
        );
    }

    el().key(format!("task-card-{}", task.id))
        .w_full()
        .padding(12.0)
        .radius(8.0)
        .fill(t.card_bg)
        .border(1.0, t.border)
        .hover(t.hover)
        .on_press_tx(move |s: &mut AppState, tx| {
            s.dispatch_tx(Action::Navigate(NavAction::OpenTask(task_id.clone())), tx);
        })
        .child(row_el.child(Badge::new(badge_txt).build(k)))
}

fn build_active_task_workspace(
    s: &AppState,
    task: &TaskRecordView,
    conversation: Option<El>,
    k: &Kit,
    t: &ThemeTokens,
) -> El {
    let ws_id = task.summary.workspace_id.clone();
    let task_id = task.summary.id.clone();
    let rev = task.summary.revision;
    let status_lower = task.summary.status.to_ascii_lowercase();
    let is_terminal = task.summary.is_terminal();

    let mut header_meta = col().grow(1.0).min_w(140.0).shrink().gap(2.0).child(
        text(&task.summary.title)
            .font(t.title)
            .color(t.text_base)
            .truncate(),
    );
    let subtitle = if !task.summary.objective.is_empty() {
        task.summary.objective.as_str()
    } else {
        task.prompt.as_str()
    };
    if !subtitle.is_empty() {
        header_meta = header_meta.child(
            text(subtitle)
                .font(t.caption)
                .color(t.text_muted)
                .truncate(),
        );
    }

    let ws_ref = ws_id.clone();
    let tid_ref = task_id.clone();
    let ws_thread = ws_id.clone();
    let tid_thread = task_id.clone();
    let thread_title = format!("{} follow-up", task.summary.title);
    let ws_accept = ws_id.clone();
    let tid_accept = task_id.clone();
    let ws_cancel = ws_id.clone();
    let tid_cancel = task_id.clone();
    let ws_reopen = ws_id.clone();
    let tid_reopen = task_id.clone();
    let ws_retry = ws_id.clone();
    let tid_retry = task_id.clone();

    let mut header = row()
        .key("task-workspace-header")
        .w_full()
        .flex_wrap()
        .px(20.0)
        .py(12.0)
        .gap(8.0)
        .center_y()
        .fill(t.panel_bg)
        .child(icon(&icons::CHECK_SQUARE, 16.0).color(t.accent))
        .child(header_meta)
        .child(Badge::new(task_status_label(&task.summary.status)).build(k))
        .child(
            Button::new("Refresh")
                .variant(ButtonVariant::Ghost)
                .control_size(ControlSize::Small)
                .icon(&icons::REFRESH)
                .on_press_tx(move |s: &mut AppState, _| {
                    s.dispatch(Action::Task(TaskAction::ReadTask {
                        workspace_id: ws_ref.clone(),
                        task_id: tid_ref.clone(),
                    }));
                })
                .build(k),
        )
        .child(
            Button::new("New chat")
                .disabled(is_terminal)
                .variant(ButtonVariant::Ghost)
                .control_size(ControlSize::Small)
                .icon(&icons::MESSAGE)
                .on_press_tx(move |s: &mut AppState, _| {
                    s.dispatch(Action::Task(TaskAction::CreateTaskThread {
                        workspace_id: ws_thread.clone(),
                        task_id: tid_thread.clone(),
                        expected_revision: rev,
                        title: thread_title.clone(),
                        work_item_id: None,
                        provider: None,
                        model: None,
                    }));
                })
                .build(k),
        );

    if !is_terminal {
        header = header
            .child(
                Button::new("Accept")
                    .variant(ButtonVariant::Contrast)
                    .control_size(ControlSize::Small)
                    .on_press_tx(move |s: &mut AppState, _| {
                        s.dispatch(Action::Task(TaskAction::AcceptTask {
                            workspace_id: ws_accept.clone(),
                            task_id: tid_accept.clone(),
                            expected_revision: rev,
                        }));
                    })
                    .build(k),
            )
            .child(
                Button::new("Request changes")
                    .variant(ButtonVariant::Ghost)
                    .control_size(ControlSize::Small)
                    .on_press_tx(|s: &mut AppState, _| {
                        s.shell_ui.task_conversation_open = false;
                        s.shell_ui.task_feedback_open = !s.shell_ui.task_feedback_open;
                        s.shell_ui.task_feedback_edit.focused = s.shell_ui.task_feedback_open;
                    })
                    .build(k),
            )
            .child(
                Button::new("Cancel")
                    .variant(ButtonVariant::Ghost)
                    .control_size(ControlSize::Small)
                    .on_press_tx(move |s: &mut AppState, _| {
                        s.dispatch(Action::Task(TaskAction::CancelTask {
                            workspace_id: ws_cancel.clone(),
                            task_id: tid_cancel.clone(),
                            expected_revision: rev,
                            reason: None,
                        }));
                    })
                    .build(k),
            );
    } else if status_lower != "failed" {
        header = header.child(
            Button::new("Reopen")
                .variant(ButtonVariant::Ghost)
                .control_size(ControlSize::Small)
                .on_press_tx(move |s: &mut AppState, _| {
                    s.dispatch(Action::Task(TaskAction::ReopenTask {
                        workspace_id: ws_reopen.clone(),
                        task_id: tid_reopen.clone(),
                        expected_revision: rev,
                        reason: None,
                    }));
                })
                .build(k),
        );
    }

    if status_lower == "failed" {
        header = header.child(
            Button::new("Retry")
                .variant(ButtonVariant::Ghost)
                .control_size(ControlSize::Small)
                .on_press_tx(move |s: &mut AppState, _| {
                    s.dispatch(Action::Task(TaskAction::RetryTask {
                        workspace_id: ws_retry.clone(),
                        task_id: tid_retry.clone(),
                        expected_revision: rev,
                    }));
                })
                .build(k),
        );
    }

    if !task.threads.is_empty() {
        let showing_thread = conversation.is_some();
        header = header.child(
            Button::new(if showing_thread {
                "Task details"
            } else {
                "Conversation"
            })
            .variant(ButtonVariant::Ghost)
            .control_size(ControlSize::Small)
            .on_press_tx(move |s: &mut AppState, _| {
                s.shell_ui.task_conversation_open = !showing_thread;
            })
            .build(k)
            .key("task-toggle-conversation"),
        );
    }

    header = header.child(
        Button::new("All tasks")
            .variant(ButtonVariant::Ghost)
            .control_size(ControlSize::Small)
            .on_press_tx(|s: &mut AppState, tx| {
                s.dispatch_tx(Action::Navigate(NavAction::OpenView(ViewId::Task)), tx);
            })
            .build(k)
            .key("task-all-tasks"),
    );

    let body = if let Some(conversation) = conversation {
        conversation
    } else {
        build_task_details(s, task, k, t)
    };

    col()
        .key("active-task-view")
        .w_full()
        .h_full()
        .min_h(0.0)
        .child(header)
        .child(el().w_full().h(1.0).fill(t.border_muted))
        .child(body)
}

fn build_task_details(s: &AppState, task: &TaskRecordView, k: &Kit, t: &ThemeTokens) -> El {
    let runs_to_show = s.workflow_runs_for_task(task);

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
        .gap(16.0);

    if s.shell_ui.task_feedback_open {
        let rev = task.summary.revision;
        let ws_fb = task.summary.workspace_id.clone();
        let tid_fb = task.summary.id.clone();
        main_pane = main_pane.child(
            row()
                .key("task-feedback-bar")
                .w_full()
                .padding(12.0)
                .radius(10.0)
                .fill(t.card_bg)
                .border(1.0, t.accent)
                .gap(8.0)
                .center_y()
                .child(
                    el().grow(1.0).shrink().child(
                        TextInput::new(&s.shell_ui.task_feedback_edit)
                            .placeholder("Describe the changes needed...")
                            .label("Task review feedback")
                            .width(None)
                            .on_edit(|s: &mut AppState| &mut s.shell_ui.task_feedback_edit)
                            .build(k),
                    ),
                )
                .child(
                    Button::new("Send")
                        .variant(ButtonVariant::Contrast)
                        .control_size(ControlSize::Small)
                        .disabled(
                            s.shell_ui.task_feedback_edit.text.trim().is_empty()
                                || s.shell_ui.task_feedback_submitting,
                        )
                        .on_press_tx(move |s: &mut AppState, _| {
                            let fb = s.shell_ui.task_feedback_edit.text.trim().to_owned();
                            if fb.is_empty() {
                                return;
                            }
                            // Keep feedback open and intact until `task/requestChanges` succeeds so
                            // connection drops or revision conflicts remain retryable.
                            s.dispatch(Action::Task(TaskAction::RequestChanges {
                                workspace_id: ws_fb.clone(),
                                task_id: tid_fb.clone(),
                                expected_revision: rev,
                                feedback: fb,
                            }));
                        })
                        .build(k),
                )
                .child(
                    Button::new("Cancel")
                        .variant(ButtonVariant::Ghost)
                        .control_size(ControlSize::Small)
                        .on_press_tx(|s: &mut AppState, _| {
                            s.shell_ui.task_feedback_open = false;
                        })
                        .build(k),
                ),
        );
    }

    main_pane = main_pane.child(
        el().w_full()
            .padding(14.0)
            .radius(10.0)
            .fill(t.card_bg)
            .border(1.0, t.border)
            .child(
                Card::new()
                    .accent(t.accent)
                    .title("Task Prompt & Goal", Some(&icons::SPARKLES))
                    .description(if !task.prompt.is_empty() {
                        task.prompt.as_str()
                    } else if !task.summary.objective.is_empty() {
                        task.summary.objective.as_str()
                    } else {
                        "No prompt recorded for this task."
                    })
                    .build(k),
            ),
    );

    let questions = extract_task_questions(&task.questions);
    if !questions.is_empty() {
        main_pane = main_pane.child(build_task_questions_card(s, task, &questions, k, t));
    }

    if !task.artifacts.is_empty() || task.active_artifact_detail.is_some() {
        main_pane = main_pane.child(build_artifact_review_card(task, k, t));
    }

    if let Some(work_graph) = build_work_graph_card(s, task, k, t) {
        main_pane = main_pane.child(work_graph);
    }

    main_pane = main_pane.child(render_runs_list(s, &runs_to_show, k, t));
    row()
        .grow(1.0)
        .shrink()
        .min_h(0.0)
        .w_full()
        .child(main_pane)
        .child(el().w(1.0).h_full().fill(t.border_muted))
        .child(build_task_inspector_sidebar(s, task, t))
}

fn build_task_questions_card(
    s: &AppState,
    task: &TaskRecordView,
    questions: &[TaskQuestionItem],
    k: &Kit,
    t: &ThemeTokens,
) -> El {
    let blocking_count = questions.iter().filter(|q| q.blocking).count();
    let mut header = row()
        .w_full()
        .gap(8.0)
        .center_y()
        .child(icon(&icons::INFO, 15.0).color(t.warning))
        .child(text("Open Questions").font(t.label).color(t.text_base))
        .child(
            Badge::new(questions.len().to_string())
                .variant(BadgeVariant::Accent)
                .build(k),
        );
    if blocking_count > 0 {
        header = header.child(
            Badge::new(format!("{blocking_count} blocking"))
                .variant(BadgeVariant::Accent)
                .high_contrast()
                .build(k),
        );
    }

    let task_id_ref = task.summary.id.as_str();
    let mut card = col()
        .key(format!("task-questions-card-{task_id_ref}"))
        .w_full()
        .padding(14.0)
        .radius(10.0)
        .fill(t.card_bg)
        .border(1.0, t.warning)
        .gap(12.0)
        .child(header);

    for q in questions {
        let q_answer_key = task_question_answer_key(task_id_ref, &q.id);
        let selected_opt = s
            .shell_ui
            .task_question_answers
            .get(&q_answer_key)
            .map(String::as_str);
        let mut q_col = col()
            .key(format!("task-q-{task_id_ref}-{}", q.id))
            .w_full()
            .padding(10.0)
            .radius(8.0)
            .fill(t.elevated_bg)
            .border(1.0, t.border_muted)
            .gap(6.0)
            .child(
                row()
                    .w_full()
                    .gap(6.0)
                    .center_y()
                    .child(text(&q.header).font(t.label).color(t.text_base))
                    .children(q.blocking.then(|| {
                        Badge::new("Blocking")
                            .variant(BadgeVariant::Accent)
                            .high_contrast()
                            .build(k)
                    })),
            )
            .child(text(&q.question).font(t.body).color(t.text_muted).wrap());

        if !q.options.is_empty() {
            let mut opts_row = col().w_full().gap(4.0);
            for opt in &q.options {
                let answer_key = q_answer_key.clone();
                let oid = opt.id.clone();
                let is_sel = selected_opt == Some(opt.id.as_str());
                let is_rec = q.recommended_option_id.as_deref() == Some(opt.id.as_str());
                let label = if is_rec {
                    format!("{} (Recommended)", opt.label)
                } else {
                    opt.label.clone()
                };
                opts_row = opts_row.child(
                    Button::new(label)
                        .variant(if is_sel {
                            ButtonVariant::Contrast
                        } else {
                            ButtonVariant::Ghost
                        })
                        .control_size(ControlSize::Small)
                        .on_press_tx(move |s: &mut AppState, _| {
                            if s.shell_ui.task_question_answers.get(&answer_key) == Some(&oid) {
                                s.shell_ui.task_question_answers.remove(&answer_key);
                            } else {
                                s.shell_ui
                                    .task_question_answers
                                    .insert(answer_key.clone(), oid.clone());
                            }
                        })
                        .build(k),
                );
            }
            q_col = q_col.child(opts_row);
        }

        let reply_edit = s
            .shell_ui
            .task_question_reply_edits
            .get(&q_answer_key)
            .unwrap_or(&EMPTY_TASK_QUESTION_REPLY_EDIT);
        let reply_key = q_answer_key.clone();
        let placeholder = if q.options.is_empty() {
            "Write your reply..."
        } else if selected_opt.is_some() {
            "Optional written reply (deselect option above to send written reply)..."
        } else {
            "Or write a custom reply..."
        };
        let reply_label = if q.header.trim().is_empty() {
            "Task question reply".to_owned()
        } else {
            format!("Reply for {}", q.header)
        };
        q_col = q_col.child(
            el().key(format!("task-q-reply-{task_id_ref}-{}", q.id))
                .w_full()
                .child(
                    TextInput::new(reply_edit)
                        .placeholder(placeholder)
                        .label(reply_label)
                        .width(None)
                        .on_edit(move |s: &mut AppState| {
                            s.shell_ui
                                .task_question_reply_edits
                                .entry(reply_key.clone())
                                .or_insert_with(|| TextEdit::new(""))
                        })
                        .build(k),
                ),
        );
        card = card.child(q_col);
    }

    let ws_id = task.summary.workspace_id.clone();
    let task_id = task.summary.id.clone();
    let rev = task.summary.revision;
    let q_ids: Vec<String> = questions.iter().map(|q| q.id.clone()).collect();
    let submitting = s
        .pending_task_questions_rpcs
        .values()
        .any(|pending| pending.workspace_id == ws_id && pending.task_id == task_id);
    let can_submit = !submitting
        && !resolve_task_question_answers(
            &task_id,
            &q_ids,
            &s.shell_ui.task_question_answers,
            &s.shell_ui.task_question_reply_edits,
        )
        .is_empty();

    card.child(
        row().w_full().child(spacer()).child(
            Button::new(if submitting {
                "Submitting..."
            } else {
                "Submit answers"
            })
            .variant(ButtonVariant::Contrast)
            .control_size(ControlSize::Small)
            .disabled(!can_submit)
            .on_press_tx(move |s: &mut AppState, _| {
                if s.pending_task_questions_rpcs
                    .values()
                    .any(|pending| pending.workspace_id == ws_id && pending.task_id == task_id)
                {
                    return;
                }
                let answers = resolve_task_question_answers(
                    &task_id,
                    &q_ids,
                    &s.shell_ui.task_question_answers,
                    &s.shell_ui.task_question_reply_edits,
                );
                if answers.is_empty() {
                    return;
                }
                // Keep selections and draft replies until the server acknowledges the RPC so transient failures preserve input.
                s.dispatch(Action::Task(TaskAction::ResolveQuestions {
                    workspace_id: ws_id.clone(),
                    task_id: task_id.clone(),
                    expected_revision: rev,
                    answers,
                }));
            })
            .build(k),
        ),
    )
}

pub(crate) fn task_question_answer_key(task_id: &str, question_id: &str) -> (String, String) {
    (task_id.to_owned(), question_id.to_owned())
}

/// Builds `task/questions/resolve` payloads containing only questions the user explicitly answered
/// (via per-question option selection or per-question written reply), enforcing the server's 1..=3
/// limit and `optionId` XOR `text`.
fn resolve_task_question_answers(
    task_id: &str,
    q_ids: &[String],
    selected: &HashMap<(String, String), String>,
    reply_edits: &HashMap<(String, String), TextEdit>,
) -> Vec<TaskQuestionAnswerParam> {
    let mut answers = Vec::new();
    for qid in q_ids {
        if answers.len() >= 3 {
            break;
        }
        let key = task_question_answer_key(task_id, qid);
        if let Some(chosen) = selected.get(&key) {
            answers.push(TaskQuestionAnswerParam {
                question_id: qid.clone(),
                option_id: Some(chosen.clone()),
                text: None,
            });
        } else if let Some(trimmed) = reply_edits
            .get(&key)
            .map(|edit| edit.text.trim())
            .filter(|text| !text.is_empty())
        {
            answers.push(TaskQuestionAnswerParam {
                question_id: qid.clone(),
                option_id: None,
                text: Some(trimmed.to_owned()),
            });
        }
    }
    answers
}

fn build_artifact_review_card(task: &TaskRecordView, k: &Kit, t: &ThemeTokens) -> El {
    let ws_id = task.summary.workspace_id.clone();
    let task_id = task.summary.id.clone();
    let rev = task.summary.revision;

    let mut card = col()
        .key("task-artifact-review-card")
        .w_full()
        .padding(14.0)
        .radius(10.0)
        .fill(t.card_bg)
        .border(1.0, t.border)
        .gap(8.0)
        .child(
            row()
                .w_full()
                .gap(8.0)
                .center_y()
                .child(text("Artifacts").font(t.label).color(t.text_base))
                .child(Badge::new(task.artifacts.len().to_string()).build(k)),
        );

    for art in &task.artifacts {
        let detail = task.artifact_details_by_id.get(&art.id);
        card = card.child(artifact_row(art, detail, &ws_id, &task_id, rev, k, t));
    }

    if let Some(detail) = task.active_artifact_detail.as_ref() {
        card = card.child(build_active_artifact_detail(
            task, detail, &ws_id, &task_id, rev, k, t,
        ));
    }

    card
}

fn artifact_row(
    art: &TaskArtifactView,
    detail: Option<&Value>,
    ws_id: &str,
    task_id: &str,
    rev: i64,
    k: &Kit,
    t: &ThemeTokens,
) -> El {
    let label = if art.title.is_empty() {
        art.name.as_str()
    } else {
        art.title.as_str()
    };
    let latest_vid = art.latest_version_id.clone().or_else(|| {
        detail
            .and_then(|d| d.get("latestVersionId"))
            .and_then(Value::as_str)
            .map(str::to_string)
    });
    let accepted_vid = art.accepted_version_id.clone().or_else(|| {
        detail
            .and_then(|d| d.get("acceptedVersionId"))
            .and_then(Value::as_str)
            .map(str::to_string)
    });
    let accepted = accepted_vid.is_some() && accepted_vid == latest_vid;
    let ws_read = ws_id.to_owned();
    let tid_read = task_id.to_owned();
    let aid_read = art.id.clone();
    let ws_acc = ws_id.to_owned();
    let tid_acc = task_id.to_owned();
    let aid_acc = art.id.clone();

    let mut r = row()
        .key(format!("task-art-{}", art.id))
        .w_full()
        .padding(8.0)
        .radius(8.0)
        .fill(t.elevated_bg)
        .border(1.0, t.border_muted)
        .gap(8.0)
        .center_y()
        .child(icon(&icons::FILE_TEXT, 14.0).color(t.text_muted))
        .child(
            col()
                .grow(1.0)
                .shrink()
                .gap(1.0)
                .child(text(label).font(t.body).color(t.text_base).truncate())
                .child(
                    text(art.path.as_str())
                        .font(t.caption)
                        .color(t.text_faint)
                        .truncate(),
                ),
        );

    if !art.kind.is_empty() {
        r = r.child(
            Badge::new(art.kind.as_str())
                .variant(BadgeVariant::Neutral)
                .build(k),
        );
    }
    r = r
        .child(
            Badge::new(if accepted { "Accepted" } else { "Review" })
                .variant(if accepted {
                    BadgeVariant::Subtle
                } else {
                    BadgeVariant::Accent
                })
                .build(k),
        )
        .child(
            Button::new("Inspect")
                .variant(ButtonVariant::Ghost)
                .control_size(ControlSize::Small)
                .on_press_tx(move |s: &mut AppState, _| {
                    s.dispatch(Action::Task(TaskAction::ReadArtifact {
                        workspace_id: ws_read.clone(),
                        task_id: tid_read.clone(),
                        artifact_id: aid_read.clone(),
                    }));
                })
                .build(k),
        );

    if !accepted {
        r = r.child(
            Button::new("Accept")
                .variant(ButtonVariant::Contrast)
                .control_size(ControlSize::Small)
                .on_press_tx(move |s: &mut AppState, _| {
                    s.dispatch(Action::Task(TaskAction::AcceptArtifactVersion {
                        workspace_id: ws_acc.clone(),
                        task_id: tid_acc.clone(),
                        artifact_id: aid_acc.clone(),
                        version_id: latest_vid.clone(),
                        expected_revision: rev,
                    }));
                })
                .build(k),
        );
    }

    r
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct DecodedArtifactDetail<'a> {
    artifact_id: String,
    title: &'a str,
    content: &'a str,
    current_version_id: Option<&'a str>,
}

fn decode_artifact_detail(detail: &Value) -> DecodedArtifactDetail<'_> {
    let nested = detail.get("artifact").and_then(Value::as_object);
    let versions = detail.get("versions").and_then(Value::as_array);
    let artifact_id = nested
        .and_then(|a| a.get("id").or_else(|| a.get("artifactId")))
        .or_else(|| detail.get("id").or_else(|| detail.get("artifactId")))
        .or_else(|| {
            versions
                .and_then(|arr| arr.first())
                .and_then(|v| v.get("artifactId"))
        })
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let title = nested
        .and_then(|a| {
            a.get("title")
                .or_else(|| a.get("name"))
                .or_else(|| a.get("path"))
        })
        .or_else(|| detail.get("title").or_else(|| detail.get("name")))
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("Artifact detail");
    let content = detail
        .get("content")
        .or_else(|| detail.get("summary"))
        .or_else(|| detail.get("body"))
        .or_else(|| {
            nested.and_then(|a| {
                a.get("content")
                    .or_else(|| a.get("summary"))
                    .or_else(|| a.get("body"))
            })
        })
        .and_then(Value::as_str)
        .unwrap_or("");
    let current_version_id = detail
        .get("latestVersionId")
        .or_else(|| detail.get("currentVersionId"))
        .or_else(|| {
            nested.and_then(|a| {
                a.get("latestVersionId")
                    .or_else(|| a.get("currentVersionId"))
            })
        })
        .and_then(Value::as_str);

    DecodedArtifactDetail {
        artifact_id,
        title,
        content,
        current_version_id,
    }
}

/// Formats a canonical `task/artifact/version/preview` payload (`ArtifactPreviewService::preview`)
/// into human-readable preview text for the artifact inspection card.
fn format_artifact_preview_text(preview: &Value) -> Option<String> {
    let kind = preview
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    let warnings: Vec<&str> = preview
        .get("warnings")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let filename = preview
        .get("filename")
        .and_then(Value::as_str)
        .unwrap_or("artifact");
    let mime_type = preview
        .get("mimeType")
        .and_then(Value::as_str)
        .unwrap_or("application/octet-stream");
    let size_bytes = preview.get("sizeBytes").and_then(Value::as_u64);

    let body = match kind.as_str() {
        "text" => preview
            .get("text")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .filter(|s| !s.is_empty()),
        "docx" => preview
            .get("document")
            .and_then(|d| d.get("paragraphs"))
            .and_then(Value::as_array)
            .map(|paragraphs| {
                paragraphs
                    .iter()
                    .filter_map(|p| p.get("text").and_then(Value::as_str))
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .take(40)
                    .collect::<Vec<_>>()
                    .join("\n\n")
            })
            .filter(|s| !s.is_empty()),
        "pptx" => preview
            .get("presentation")
            .and_then(|p| p.get("slides"))
            .and_then(Value::as_array)
            .map(|slides| {
                slides
                    .iter()
                    .take(20)
                    .enumerate()
                    .filter_map(|(idx, slide)| {
                        let slide_num = slide
                            .get("index")
                            .and_then(Value::as_u64)
                            .map(|n| n + 1)
                            .unwrap_or((idx + 1) as u64);
                        let text = slide
                            .get("text")
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .unwrap_or("");
                        let notes = slide
                            .get("notes")
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .unwrap_or("");
                        if text.is_empty() && notes.is_empty() {
                            return None;
                        }
                        if notes.is_empty() {
                            Some(format!("Slide {slide_num}:\n{text}"))
                        } else if text.is_empty() {
                            Some(format!("Slide {slide_num} (notes):\n{notes}"))
                        } else {
                            Some(format!("Slide {slide_num}:\n{text}\nNotes: {notes}"))
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n\n")
            })
            .filter(|s| !s.is_empty()),
        "xlsx" => preview
            .get("workbook")
            .and_then(|w| w.get("sheets"))
            .and_then(Value::as_array)
            .map(|sheets| {
                sheets
                    .iter()
                    .take(10)
                    .map(|sheet| {
                        let name = sheet.get("name").and_then(Value::as_str).unwrap_or("Sheet");
                        let cell_count = sheet
                            .get("cells")
                            .and_then(Value::as_array)
                            .map(Vec::len)
                            .unwrap_or(0);
                        let sample_cells: Vec<String> = sheet
                            .get("cells")
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten()
                            .take(12)
                            .filter_map(|cell| {
                                let addr = cell
                                    .get("address")
                                    .or_else(|| cell.get("cellRef"))
                                    .or_else(|| cell.get("ref"))
                                    .and_then(Value::as_str)?;
                                let val = cell
                                    .get("displayValue")
                                    .or_else(|| cell.get("value"))
                                    .or_else(|| cell.get("formula"))
                                    .and_then(|v| {
                                        v.as_str()
                                            .map(str::to_owned)
                                            .or_else(|| (!v.is_null()).then(|| v.to_string()))
                                    })?;
                                Some(format!("{addr}={val}"))
                            })
                            .collect();
                        if sample_cells.is_empty() {
                            format!("{name} ({cell_count} cells)")
                        } else {
                            format!("{name} ({cell_count} cells): {}", sample_cells.join(", "))
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .filter(|s| !s.is_empty()),
        "image" => {
            let dims = match (
                preview.get("width").and_then(Value::as_u64),
                preview.get("height").and_then(Value::as_u64),
            ) {
                (Some(w), Some(h)) => format!(" · {w}×{h}"),
                _ => String::new(),
            };
            let size = size_bytes
                .map(|b| format!(" · {b} bytes"))
                .unwrap_or_default();
            Some(format!(
                "Image preview: {filename} ({mime_type}{dims}{size})"
            ))
        }
        "pdf" => {
            let pages = preview
                .get("pageCount")
                .and_then(Value::as_u64)
                .map(|n| format!(" · {n} page{}", if n == 1 { "" } else { "s" }))
                .unwrap_or_default();
            let size = size_bytes
                .map(|b| format!(" · {b} bytes"))
                .unwrap_or_default();
            Some(format!("PDF preview: {filename}{pages}{size}"))
        }
        "binary" => {
            let size = size_bytes
                .map(|b| format!(" · {b} bytes"))
                .unwrap_or_default();
            let sha = preview
                .get("sha256")
                .and_then(Value::as_str)
                .map(|s| format!(" · sha256 {}", &s[..s.len().min(12)]))
                .unwrap_or_default();
            Some(format!(
                "Binary artifact: {filename} ({mime_type}{size}{sha})"
            ))
        }
        "error" => preview
            .get("error")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|msg| format!("Preview unavailable: {msg}")),
        _ => preview
            .get("text")
            .or_else(|| preview.get("content"))
            .and_then(Value::as_str)
            .map(str::to_owned)
            .filter(|s| !s.is_empty()),
    };

    match (body, warnings.is_empty()) {
        (Some(text), true) => Some(text),
        (Some(text), false) => Some(format!("{text}\n\nNote: {}", warnings.join(" "))),
        (None, false) => Some(warnings.join("\n")),
        (None, true) => None,
    }
}

fn resolve_active_artifact_preview_content(
    task: &TaskRecordView,
    detail: &Value,
    decoded: &DecodedArtifactDetail<'_>,
) -> (Option<String>, Option<String>) {
    let versions = detail.get("versions").and_then(Value::as_array);
    let selected_vid = task
        .selected_artifact_version_id
        .as_deref()
        .filter(|vid| {
            decoded.current_version_id == Some(*vid)
                || versions.is_some_and(|arr| {
                    arr.iter()
                        .any(|v| v.get("id").and_then(Value::as_str) == Some(*vid))
                })
        })
        .or(decoded.current_version_id)
        .or_else(|| {
            versions
                .and_then(|arr| arr.last())
                .and_then(|v| v.get("id"))
                .and_then(Value::as_str)
        })
        .map(str::to_owned);

    let preview_text = selected_vid
        .as_deref()
        .and_then(|vid| task.artifact_previews_by_version_id.get(vid))
        .and_then(format_artifact_preview_text)
        .or_else(|| (!decoded.content.is_empty()).then(|| decoded.content.to_owned()));

    (selected_vid, preview_text)
}

fn build_active_artifact_detail(
    task: &TaskRecordView,
    detail: &Value,
    ws_id: &str,
    task_id: &str,
    rev: i64,
    k: &Kit,
    t: &ThemeTokens,
) -> El {
    let decoded = decode_artifact_detail(detail);
    let artifact_id = decoded.artifact_id.clone();
    let title = decoded.title;
    let current_vid = decoded.current_version_id;
    let (selected_vid, content) = resolve_active_artifact_preview_content(task, detail, &decoded);

    let mut box_col = col()
        .key("task-artifact-detail-box")
        .w_full()
        .padding(10.0)
        .radius(8.0)
        .fill(t.panel_bg)
        .border(1.0, t.border_muted)
        .gap(6.0)
        .child(text(title).font(t.label).color(t.text_base));

    if let Some(content) = content {
        box_col = box_col.child(
            col()
                .w_full()
                .max_h(180.0)
                .scroll(ScrollSpec {
                    stick_bottom: false,
                })
                .child(text(content).font(t.code).color(t.text_base).wrap()),
        );
    } else if selected_vid.is_some() {
        box_col = box_col.child(text("Loading preview…").font(t.caption).color(t.text_muted));
    }

    if let Some(versions) = detail.get("versions").and_then(Value::as_array)
        && !versions.is_empty()
        && !artifact_id.is_empty()
    {
        let mut vers_col = col().w_full().gap(4.0);
        for v in versions.iter().rev().take(5) {
            let Some(vid) = v.get("id").and_then(Value::as_str) else {
                continue;
            };
            let is_current = current_vid == Some(vid);
            let is_selected = selected_vid.as_deref() == Some(vid);
            let label = v
                .get("changeSummary")
                .or_else(|| v.get("summary"))
                .and_then(Value::as_str)
                .unwrap_or(vid);
            let ws_p = ws_id.to_owned();
            let tid_p = task_id.to_owned();
            let aid_p = artifact_id.clone();
            let vid_p = vid.to_owned();
            let ws_r = ws_id.to_owned();
            let tid_r = task_id.to_owned();
            let aid_r = artifact_id.clone();
            let vid_r = vid.to_owned();
            vers_col = vers_col.child(
                row()
                    .w_full()
                    .gap(6.0)
                    .center_y()
                    .child(
                        text(label)
                            .font(t.caption)
                            .color(if is_selected {
                                t.text_base
                            } else {
                                t.text_muted
                            })
                            .truncate()
                            .grow(1.0),
                    )
                    .children((!is_selected).then(|| {
                        Button::new("Preview")
                            .variant(ButtonVariant::Ghost)
                            .control_size(ControlSize::Small)
                            .on_press_tx(move |s: &mut AppState, _| {
                                s.dispatch(Action::Task(TaskAction::PreviewArtifactVersion {
                                    workspace_id: ws_p.clone(),
                                    task_id: tid_p.clone(),
                                    artifact_id: aid_p.clone(),
                                    version_id: vid_p.clone(),
                                }));
                            })
                            .build(k)
                    }))
                    .children((!is_current).then(|| {
                        Button::new("Restore")
                            .variant(ButtonVariant::Ghost)
                            .control_size(ControlSize::Small)
                            .on_press_tx(move |s: &mut AppState, _| {
                                s.dispatch(Action::Task(TaskAction::RestoreArtifactVersion {
                                    workspace_id: ws_r.clone(),
                                    task_id: tid_r.clone(),
                                    artifact_id: aid_r.clone(),
                                    version_id: vid_r.clone(),
                                    expected_revision: rev,
                                    change_summary: None,
                                }));
                            })
                            .build(k)
                    })),
            );
        }
        box_col = box_col.child(vers_col);
    }

    box_col
}

fn build_work_graph_card(
    s: &AppState,
    task: &TaskRecordView,
    k: &Kit,
    t: &ThemeTokens,
) -> Option<El> {
    let items = task.work_items.as_array()?;
    if items.is_empty() {
        return None;
    }

    let collapsed = s.shell_ui.task_work_graph_collapsed;
    let mut card = col()
        .key("task-work-graph-card")
        .w_full()
        .padding(14.0)
        .radius(10.0)
        .fill(t.card_bg)
        .border(1.0, t.border)
        .gap(8.0)
        .child(
            row()
                .w_full()
                .gap(8.0)
                .center_y()
                .child(text("Work Items").font(t.label).color(t.text_base))
                .child(
                    Badge::new(format!(
                        "{}/{}",
                        task.summary.completed_work_item_count,
                        items.len()
                    ))
                    .build(k),
                )
                .child(spacer())
                .child(
                    Button::new(if collapsed { "Expand" } else { "Collapse" })
                        .variant(ButtonVariant::Ghost)
                        .control_size(ControlSize::Small)
                        .on_press_tx(|s: &mut AppState, _| {
                            s.shell_ui.task_work_graph_collapsed =
                                !s.shell_ui.task_work_graph_collapsed;
                        })
                        .build(k),
                ),
        );

    if !collapsed {
        for (idx, item) in items.iter().enumerate() {
            let title = item
                .get("title")
                .or_else(|| item.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("Work item");
            let status = item
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("pending");
            card = card.child(
                row()
                    .key(format!("task-wi-{idx}"))
                    .w_full()
                    .padding(8.0)
                    .radius(6.0)
                    .fill(t.elevated_bg)
                    .gap(8.0)
                    .center_y()
                    .child(
                        text(title)
                            .font(t.body)
                            .color(t.text_base)
                            .truncate()
                            .grow(1.0),
                    )
                    .child(Badge::new(status).variant(BadgeVariant::Neutral).build(k)),
            );
        }
    }

    Some(card)
}

fn build_task_inspector_sidebar(s: &AppState, task: &TaskRecordView, t: &ThemeTokens) -> El {
    let mut side = col()
        .key("task-context-summary")
        .w(290.0)
        .h_full()
        .min_h(0.0)
        .scroll(ScrollSpec {
            stick_bottom: false,
        })
        .padding(14.0)
        .gap(12.0)
        .fill(t.panel_bg);
    let mut summary_card = col()
        .w_full()
        .padding(10.0)
        .radius(8.0)
        .fill(t.card_bg)
        .border(1.0, t.border_muted)
        .gap(4.0)
        .child(text("Status").font(t.caption).color(t.text_faint))
        .child(
            text(format!(
                "{} (rev {})",
                task_status_label(&task.summary.status),
                task.summary.revision
            ))
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
    side = side.child(summary_card);

    let active_blockers = extract_active_task_blockers(&task.blockers);
    if !active_blockers.is_empty() {
        let mut b_card = col()
            .w_full()
            .padding(10.0)
            .radius(8.0)
            .fill(t.card_bg)
            .border(1.0, t.danger)
            .gap(4.0)
            .child(text("Active Blockers").font(t.label).color(t.danger));
        for b in active_blockers.into_iter().take(6) {
            let msg = task_blocker_label(b);
            b_card = b_card.child(text(msg).font(t.caption).color(t.text_base).wrap());
        }
        side = side.child(b_card);
    }
    side
}

fn build_workflow_runs_panel(s: &AppState, k: &Kit, t: &ThemeTokens) -> El {
    let runs = s
        .active_workspace_id
        .as_deref()
        .map(|ws_id| s.workflow_runs_for_workspace(ws_id))
        .unwrap_or_default();
    render_runs_list(s, &runs, k, t)
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
    let run_id = run.id.clone();
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
        .hover(t.hover)
        .on_press_tx(move |s: &mut AppState, _| {
            s.shell_ui.selected_workflow_run_id = Some(run_id.clone());
        })
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

fn is_active_task_blocker(blocker: &Value) -> bool {
    match blocker.get("status").and_then(Value::as_str) {
        Some(status) => status.eq_ignore_ascii_case("active"),
        None => true,
    }
}

fn extract_active_task_blockers(blockers: &Value) -> Vec<&Value> {
    blockers
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter(|blocker| is_active_task_blocker(blocker))
                .collect()
        })
        .unwrap_or_default()
}

fn task_blocker_label(blocker: &Value) -> &str {
    blocker
        .get("description")
        .or_else(|| blocker.get("message"))
        .or_else(|| blocker.get("reason"))
        .or_else(|| blocker.get("title"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Blocked")
}

fn task_status_label(status: &str) -> &str {
    match status {
        "draft" => "Draft",
        "running" | "in_progress" => "Running",
        "waiting_for_input" | "waiting" | "needs_input" => "Waiting for input",
        "completed" => "Completed",
        "accepted" => "Accepted",
        "failed" => "Failed",
        "cancelled" => "Cancelled",
        "" => "Scheduled",
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn extract_task_questions_handles_arrays_objects_and_resolved_entries() {
        let payload = json!({
            "questions": [
                {
                    "id": "q-1",
                    "header": "Target API",
                    "question": "Which endpoint version should be updated?",
                    "blocking": true,
                    "recommendedOptionId": "v2",
                    "options": [
                        { "id": "v1", "label": "v1 (legacy)", "description": "" },
                        { "id": "v2", "label": "v2 (current)", "description": "Active clients" }
                    ]
                },
                {
                    "id": "q-2",
                    "header": "Done",
                    "question": "Already answered",
                    "resolved": true
                }
            ]
        });
        let items = extract_task_questions(&payload);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, "q-1");
        assert!(items[0].blocking);
        assert_eq!(items[0].recommended_option_id.as_deref(), Some("v2"));
        assert_eq!(items[0].options.len(), 2);

        let array_payload = json!([
            {
                "questionId": "q-arr",
                "prompt": "Proceed with deployment?",
                "options": []
            }
        ]);
        let arr_items = extract_task_questions(&array_payload);
        assert_eq!(arr_items.len(), 1);
        assert_eq!(arr_items[0].id, "q-arr");
        assert_eq!(arr_items[0].question, "Proceed with deployment?");
    }

    #[test]
    fn resolve_task_question_answers_enforces_option_or_text_xor_and_omits_unanswered() {
        let mut selected = HashMap::new();
        selected.insert(task_question_answer_key("task-1", "q-1"), "v2".to_owned());
        selected.insert(
            task_question_answer_key("other-task", "q-2"),
            "wrong-task".to_owned(),
        );
        let mut replies = HashMap::new();
        replies.insert(
            task_question_answer_key("task-1", "q-1"),
            TextEdit::new("   "),
        );
        replies.insert(
            task_question_answer_key("other-task", "q-2"),
            TextEdit::new("Previous task reply"),
        );

        let q_ids = vec![
            "q-1".to_owned(),
            "q-2".to_owned(),
            "q-3".to_owned(),
            "q-4".to_owned(),
        ];

        // With no written reply on task-1, ONLY q-1 (explicitly chosen by the user) is submitted;
        // other-task's reply must never bleed into task-1, and q-2..q-4 must be omitted.
        let explicit_only = resolve_task_question_answers("task-1", &q_ids, &selected, &replies);
        assert_eq!(explicit_only.len(), 1);
        assert_eq!(explicit_only[0].question_id, "q-1");
        assert_eq!(explicit_only[0].option_id.as_deref(), Some("v2"));
        assert_eq!(explicit_only[0].text, None);

        // With no selections and no reply text for task-1, nothing is submitted even if another task has drafts.
        assert!(
            resolve_task_question_answers("task-1", &q_ids, &HashMap::new(), &replies).is_empty()
        );

        // Answering only q-4 (past index 2) must still submit q-4 rather than truncating before filtering.
        let mut only_fourth = HashMap::new();
        only_fourth.insert(
            task_question_answer_key("task-1", "q-4"),
            "opt-4".to_owned(),
        );
        let fourth_answers =
            resolve_task_question_answers("task-1", &q_ids, &only_fourth, &HashMap::new());
        assert_eq!(fourth_answers.len(), 1);
        assert_eq!(fourth_answers[0].question_id, "q-4");
        assert_eq!(fourth_answers[0].option_id.as_deref(), Some("opt-4"));

        // q-1 has both an option choice and freeform text -> sends optionId only (XOR).
        // q-2 has its own written reply -> sends text for q-2 ONLY; unselected q-3 stays omitted.
        replies.insert(
            task_question_answer_key("task-1", "q-1"),
            TextEdit::new("Ignored because option selected"),
        );
        replies.insert(
            task_question_answer_key("task-1", "q-2"),
            TextEdit::new("  Use custom  "),
        );
        let answers = resolve_task_question_answers("task-1", &q_ids, &selected, &replies);
        assert_eq!(answers.len(), 2);
        assert!(
            answers
                .iter()
                .all(|a| a.option_id.is_some() ^ a.text.is_some()),
            "every answer must set exactly one of option_id or text"
        );
        assert_eq!(answers[0].question_id, "q-1");
        assert_eq!(answers[0].option_id.as_deref(), Some("v2"));
        assert_eq!(answers[0].text, None);

        assert_eq!(answers[1].question_id, "q-2");
        assert_eq!(answers[1].option_id, None);
        assert_eq!(answers[1].text.as_deref(), Some("Use custom"));

        // Adding written replies for q-3 and q-4 hits the server's 3-entry cap cleanly.
        replies.insert(
            task_question_answer_key("task-1", "q-3"),
            TextEdit::new("Third answer"),
        );
        replies.insert(
            task_question_answer_key("task-1", "q-4"),
            TextEdit::new("Fourth answer"),
        );
        let capped = resolve_task_question_answers("task-1", &q_ids, &selected, &replies);
        assert_eq!(capped.len(), 3);
        assert_eq!(capped[2].question_id, "q-3");
        assert_eq!(capped[2].text.as_deref(), Some("Third answer"));
    }

    #[test]
    fn task_blocker_display_prefers_canonical_description() {
        let blocker = json!({
            "id": "blk-1",
            "description": "Waiting on database migration sign-off",
            "severity": "high"
        });
        assert_eq!(
            task_blocker_label(&blocker),
            "Waiting on database migration sign-off"
        );
        assert_eq!(task_blocker_label(&json!({ "id": "blk-2" })), "Blocked");
    }

    #[test]
    fn extract_active_task_blockers_filters_resolved_before_limiting() {
        let mut items = Vec::new();
        for idx in 1..=7 {
            items.push(json!({
                "id": format!("blk-resolved-{idx}"),
                "description": format!("Old resolved blocker {idx}"),
                "status": "resolved"
            }));
        }
        items.push(json!({
            "id": "blk-active-1",
            "description": "Waiting on API key rotation",
            "status": "active"
        }));
        items.push(json!({
            "id": "blk-active-2",
            "description": "Needs staging credentials",
            "status": "active"
        }));

        let payload = Value::Array(items);
        let active = extract_active_task_blockers(&payload);
        assert_eq!(active.len(), 2);
        assert_eq!(task_blocker_label(active[0]), "Waiting on API key rotation");
        assert_eq!(task_blocker_label(active[1]), "Needs staging credentials");

        // All-resolved list yields no active blockers so the card stays hidden.
        let only_resolved = json!([
            { "id": "blk-1", "description": "Done", "status": "resolved" }
        ]);
        assert!(extract_active_task_blockers(&only_resolved).is_empty());
    }

    #[test]
    fn extract_task_questions_filters_canonical_non_pending_statuses() {
        let payload = json!([
            {
                "id": "q-answered-1",
                "header": "Round 1",
                "question": "Old answered question 1",
                "status": "answered",
                "blocking": true,
                "options": []
            },
            {
                "id": "q-defaulted-2",
                "header": "Round 1",
                "question": "Defaulted question",
                "status": "defaulted",
                "blocking": false,
                "options": []
            },
            {
                "id": "q-dismissed-3",
                "header": "Round 1",
                "question": "Dismissed question",
                "status": "dismissed",
                "blocking": false,
                "options": []
            },
            {
                "id": "q-superseded-4",
                "header": "Round 1",
                "question": "Superseded question",
                "status": "superseded",
                "blocking": false,
                "options": []
            },
            {
                "id": "q-pending-5",
                "header": "Round 2",
                "question": "Follow-up pending question",
                "status": "pending",
                "blocking": true,
                "recommendedOptionId": "opt-a",
                "options": [
                    { "id": "opt-a", "label": "Option A", "description": "Preferred" }
                ]
            }
        ]);

        let items = extract_task_questions(&payload);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, "q-pending-5");
        assert_eq!(items[0].question, "Follow-up pending question");
    }

    #[test]
    fn decode_artifact_detail_reads_nested_canonical_task_artifact_detail() {
        let canonical = json!({
            "artifact": {
                "id": "art-42",
                "taskId": "task-1",
                "path": "reports/summary.md",
                "kind": "markdown",
                "title": "Executive Summary",
                "createdBy": "agent",
                "provenance": {},
                "createdAt": "2026-11-22T00:00:00Z"
            },
            "versions": [
                {
                    "id": "ver-2",
                    "artifactId": "art-42",
                    "version": 2,
                    "changeSummary": "Revised recommendations"
                },
                {
                    "id": "ver-1",
                    "artifactId": "art-42",
                    "version": 1,
                    "changeSummary": "Initial draft"
                }
            ],
            "latestVersionId": "ver-2",
            "acceptedVersionId": null
        });

        let decoded = decode_artifact_detail(&canonical);
        assert_eq!(decoded.artifact_id, "art-42");
        assert_eq!(decoded.title, "Executive Summary");
        assert_eq!(decoded.current_version_id, Some("ver-2"));

        // Canonical detail has no inline content; preview text comes from `artifact_previews_by_version_id`.
        let mut task = TaskRecordView {
            selected_artifact_version_id: Some("ver-2".to_owned()),
            ..Default::default()
        };
        task.artifact_previews_by_version_id.insert(
            "ver-2".to_owned(),
            json!({
                "kind": "text",
                "filename": "summary.md",
                "mimeType": "text/markdown",
                "sizeBytes": 24,
                "sha256": "deadbeef",
                "warnings": [],
                "text": "# Summary\nAll checks ok.",
                "encoding": "utf-8"
            }),
        );
        let (vid, content) = resolve_active_artifact_preview_content(&task, &canonical, &decoded);
        assert_eq!(vid.as_deref(), Some("ver-2"));
        assert_eq!(content.as_deref(), Some("# Summary\nAll checks ok."));

        // Structured previews (docx/pdf/binary) render concise readable summaries.
        let docx = format_artifact_preview_text(&json!({
            "kind": "docx",
            "filename": "brief.docx",
            "document": { "paragraphs": [{ "index": 0, "text": "Intro paragraph" }] }
        }));
        assert_eq!(docx.as_deref(), Some("Intro paragraph"));

        let pdf = format_artifact_preview_text(&json!({
            "kind": "pdf",
            "filename": "report.pdf",
            "pageCount": 4,
            "sizeBytes": 12000
        }));
        assert_eq!(
            pdf.as_deref(),
            Some("PDF preview: report.pdf · 4 pages · 12000 bytes")
        );

        let xlsx = format_artifact_preview_text(&json!({
            "kind": "xlsx",
            "filename": "metrics.xlsx",
            "workbook": {
                "sheets": [{
                    "name": "Q4",
                    "index": 0,
                    "hidden": false,
                    "cells": [
                        { "address": "A1", "value": "Revenue", "formula": null, "style": null },
                        { "address": "B1", "value": 42, "formula": "=SUM(B2:B5)", "style": null }
                    ],
                    "merges": [],
                    "columnWidths": [],
                    "tables": [],
                    "charts": []
                }]
            }
        }));
        assert_eq!(xlsx.as_deref(), Some("Q4 (2 cells): A1=Revenue, B1=42"));
    }
}
