//! Pending `ask_user`, command execution approval, and file change approval cards.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use cowork_protocol::{JsonRpcLiteId, ServerRequestReceiptResponse};
use rune::{
    Cursor, Direction, El, Key, ScrollSpec, TextEdit, TextStyle, Tx, col, icon, row, spacer, text,
    text_input,
};
use rune_kit::{Button, ButtonVariant, ControlSize, Kit};
use serde_json::Value;

use crate::actions::{Action, ChatAction};
use crate::state::{AppState, ChatInteraction};
use crate::theme::ThemeTokens;

use super::components::{StatusPillTone, status_pill};
use super::icons;
use super::model::{ASK_SKIP_TOKEN, approval_risk_label, truncate_text};

const ASK_QUESTION_FALLBACK: &str = "The agent needs your input.";
static EMPTY_ASK_EDIT: LazyLock<TextEdit> = LazyLock::new(TextEdit::default);

/// Normalized option inside an interactive `ask` prompt.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AskOptionSpec {
    pub label: String,
    pub description: Option<String>,
}

/// Normalized single question step inside a `ChatInteraction::UserInput`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AskQuestionSpec {
    pub id: String,
    pub header: Option<String>,
    pub question: String,
    pub options: Vec<AskOptionSpec>,
    pub multi_select: bool,
    pub is_secret: bool,
}

/// Parsed structure covering both canonical single-question `ask` payloads and structured
/// multi-question arrays.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AskPromptSpec {
    pub is_multi_structured: bool,
    pub questions: Vec<AskQuestionSpec>,
}

/// Parses raw `ChatInteraction::UserInput.questions` into normalized steps without failing on
/// partial or `Null` payloads.
pub fn parse_ask_prompt_spec(raw: &Value) -> AskPromptSpec {
    if let Some(arr) = raw
        .get("questions")
        .and_then(Value::as_array)
        .or_else(|| raw.as_array())
    {
        let parsed: Vec<AskQuestionSpec> = arr
            .iter()
            .enumerate()
            .filter_map(|(idx, entry)| parse_question_object(entry, idx))
            .collect();
        if !parsed.is_empty() {
            return AskPromptSpec {
                is_multi_structured: true,
                questions: parsed,
            };
        }
    }

    if let Some(single) = parse_question_object(raw, 0) {
        return AskPromptSpec {
            is_multi_structured: false,
            questions: vec![single],
        };
    }

    let text_fallback = raw
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| truncate_text(s, 480))
        .unwrap_or_else(|| ASK_QUESTION_FALLBACK.to_string());

    AskPromptSpec {
        is_multi_structured: false,
        questions: vec![AskQuestionSpec {
            id: "q0".to_string(),
            header: None,
            question: text_fallback,
            options: Vec::new(),
            multi_select: false,
            is_secret: false,
        }],
    }
}

fn parse_question_object(val: &Value, idx: usize) -> Option<AskQuestionSpec> {
    let obj = val.as_object()?;
    let question_raw = obj
        .get("question")
        .or_else(|| obj.get("prompt"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let question = question_raw
        .map(|s| truncate_text(s, 480))
        .unwrap_or_else(|| ASK_QUESTION_FALLBACK.to_string());

    let id = obj
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("q{idx}"));

    let header = obj
        .get("header")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);

    let multi_select = obj
        .get("multiSelect")
        .or_else(|| obj.get("multi_select"))
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let is_secret = obj
        .get("isSecret")
        .or_else(|| obj.get("is_secret"))
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let mut options = Vec::new();
    if let Some(arr) = obj.get("options").and_then(Value::as_array) {
        for opt in arr {
            if let Some(lbl) = opt.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                options.push(AskOptionSpec {
                    label: lbl.to_string(),
                    description: None,
                });
            } else if let Some(o) = opt.as_object()
                && let Some(lbl) = o
                    .get("label")
                    .or_else(|| o.get("value"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
            {
                let description = o
                    .get("description")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned);
                options.push(AskOptionSpec {
                    label: lbl.to_string(),
                    description,
                });
            }
        }
    }

    if question_raw.is_none() && options.is_empty() {
        return None;
    }

    Some(AskQuestionSpec {
        id,
        header,
        question,
        options,
        multi_select,
        is_secret,
    })
}

fn request_id_key(id: &JsonRpcLiteId) -> String {
    match id {
        JsonRpcLiteId::String(s) => s.clone(),
        JsonRpcLiteId::Number(n) => n.to_string(),
    }
}

/// Renders one pending server interaction card (`CommandApproval`, `FileChangeApproval`, or `UserInput`).
#[allow(clippy::too_many_arguments)]
pub fn build_interaction_card(
    s: &AppState,
    k: &Kit,
    t: &ThemeTokens,
    workspace_id: Option<&str>,
    thread_id: &str,
    interaction: &ChatInteraction,
    position: usize,
    total: usize,
    interaction_errors: &HashMap<String, String>,
) -> El {
    let ws_id = workspace_id.unwrap_or_default().to_string();
    match interaction {
        ChatInteraction::CommandApproval {
            request_id,
            item_id,
            command,
            cwd,
            reason,
            risk_code,
        } => build_command_approval_card(
            k,
            t,
            ws_id,
            thread_id.to_string(),
            request_id,
            item_id,
            command.as_deref(),
            cwd.as_deref(),
            reason.as_deref(),
            risk_code.as_deref(),
            position,
            total,
            lookup_interaction_error(interaction_errors, request_id, item_id),
        ),
        ChatInteraction::FileChangeApproval {
            request_id,
            item_id,
            path,
            reason,
        } => build_file_approval_card(
            k,
            t,
            ws_id,
            thread_id.to_string(),
            request_id,
            item_id,
            path.as_deref(),
            reason.as_deref(),
            position,
            total,
            lookup_interaction_error(interaction_errors, request_id, item_id),
        ),
        ChatInteraction::UserInput {
            request_id,
            item_id,
            questions,
        } => build_user_input_card(
            s,
            k,
            t,
            ws_id,
            thread_id.to_string(),
            request_id,
            item_id,
            questions,
            position,
            total,
            lookup_interaction_error(interaction_errors, request_id, item_id),
        ),
    }
}

fn lookup_interaction_error<'a>(
    errors: &'a HashMap<String, String>,
    request_id: &JsonRpcLiteId,
    item_id: &str,
) -> Option<&'a str> {
    let req_key = request_id_key(request_id);
    errors
        .get(&req_key)
        .or_else(|| errors.get(item_id))
        .map(String::as_str)
}

#[allow(clippy::too_many_arguments)]
fn build_command_approval_card(
    k: &Kit,
    t: &ThemeTokens,
    workspace_id: String,
    thread_id: String,
    request_id: &JsonRpcLiteId,
    item_id: &str,
    command: Option<&str>,
    cwd: Option<&str>,
    reason: Option<&str>,
    risk_code: Option<&str>,
    position: usize,
    total: usize,
    error_msg: Option<&str>,
) -> El {
    let req_key = request_id_key(request_id);
    let sandbox = risk_code.is_some_and(|r| r.contains("sandbox"))
        || reason.is_some_and(|r| r.to_ascii_lowercase().contains("sandbox"));
    let dangerous = risk_code.is_some_and(|r| r.contains("dangerous"));

    let heading = if sandbox {
        "Re-run with full access?".to_string()
    } else if let Some(code) = risk_code.filter(|c| !c.trim().is_empty()) {
        approval_risk_label(code)
    } else if let Some(r) = reason.filter(|r| !r.trim().is_empty()) {
        approval_risk_label(r)
    } else {
        "Needs your review".to_string()
    };

    let border_col = if sandbox || dangerous {
        k.alpha(t.danger, 0.35)
    } else {
        k.alpha(t.warning, 0.38)
    };
    let bg_col = if sandbox || dangerous {
        k.alpha(t.danger, 0.06)
    } else {
        k.alpha(t.warning, 0.06)
    };

    let mut card = col()
        .key(format!("interaction:{req_key}:{item_id}"))
        .w_full()
        .min_w(0.0)
        .max_w(768.0)
        .gap(10.0)
        .px(16.0)
        .py(14.0)
        .radius(14.0)
        .fill(bg_col)
        .border(1.0, border_col);

    card = card.child(build_card_header(
        k,
        t,
        if sandbox {
            "Sandbox blocked"
        } else {
            "Approval needed"
        },
        if sandbox || dangerous {
            StatusPillTone::Danger
        } else {
            StatusPillTone::Warning
        },
        &icons::SHIELD_ALERT,
        position,
        total,
    ));

    card = card.child(
        text(heading)
            .font(k.ty.body_medium)
            .color(t.text_base)
            .wrap()
            .w_full(),
    );

    if let Some(r) = reason.filter(|v| !v.trim().is_empty()) {
        card = card.child(
            text(r.to_string())
                .font(k.ty.ui)
                .color(t.text_muted)
                .wrap()
                .w_full(),
        );
    }

    if let Some(cmd) = command.filter(|c| !c.trim().is_empty()) {
        card = card.child(build_code_preview_box(
            t,
            format!("cmd-preview:{req_key}:{item_id}"),
            cmd,
            k.ty.mono,
            10.0,
        ));
    }

    if let Some(dir) = cwd.filter(|c| !c.trim().is_empty()) {
        card = card.child(
            text(format!("Working directory: {dir}"))
                .font(k.ty.text_xsmall)
                .color(t.text_faint)
                .truncate()
                .w_full()
                .min_w(0.0),
        );
    }

    if let Some(err) = error_msg {
        card = card.child(build_error_strip(k, t, err));
    }

    let id_deny = request_id.clone();
    let ws_deny = workspace_id.clone();
    let tid_deny = thread_id.clone();

    let id_allow = request_id.clone();
    let ws_allow = workspace_id;
    let tid_allow = thread_id;

    card.child(
        row()
            .w_full()
            .justify_end()
            .gap(8.0)
            .pt(2.0)
            .child(
                Button::new(if sandbox { "Keep blocked" } else { "Deny" })
                    .variant(ButtonVariant::Outline)
                    .control_size(ControlSize::Small)
                    .on_press(move |s: &mut AppState| {
                        s.dispatch(Action::Chat(ChatAction::ResolveServerRequest {
                            workspace_id: ws_deny.clone(),
                            thread_id: tid_deny.clone(),
                            id: id_deny.clone(),
                            response: ServerRequestReceiptResponse::Approval { approved: false },
                        }));
                    })
                    .build(k)
                    .key(format!("deny:{req_key}")),
            )
            .child(
                Button::new(if sandbox {
                    "Run with full access"
                } else {
                    "Approve"
                })
                .variant(if dangerous {
                    ButtonVariant::Danger
                } else {
                    ButtonVariant::Contrast
                })
                .control_size(ControlSize::Small)
                .on_press(move |s: &mut AppState| {
                    s.dispatch(Action::Chat(ChatAction::ResolveServerRequest {
                        workspace_id: ws_allow.clone(),
                        thread_id: tid_allow.clone(),
                        id: id_allow.clone(),
                        response: ServerRequestReceiptResponse::Approval { approved: true },
                    }));
                })
                .build(k)
                .key(format!("approve:{req_key}")),
            ),
    )
}

#[allow(clippy::too_many_arguments)]
fn build_file_approval_card(
    k: &Kit,
    t: &ThemeTokens,
    workspace_id: String,
    thread_id: String,
    request_id: &JsonRpcLiteId,
    item_id: &str,
    path: Option<&str>,
    reason: Option<&str>,
    position: usize,
    total: usize,
    error_msg: Option<&str>,
) -> El {
    let req_key = request_id_key(request_id);
    let mut card = col()
        .key(format!("interaction:{req_key}:{item_id}"))
        .w_full()
        .min_w(0.0)
        .max_w(768.0)
        .gap(10.0)
        .px(16.0)
        .py(14.0)
        .radius(14.0)
        .fill(k.alpha(t.warning, 0.06))
        .border(1.0, k.alpha(t.warning, 0.35))
        .child(build_card_header(
            k,
            t,
            "File access approval",
            StatusPillTone::Warning,
            &icons::SHIELD_ALERT,
            position,
            total,
        ))
        .child(
            text("Allow file access or edit outside default workspace rules?")
                .font(k.ty.body_medium)
                .color(t.text_base)
                .wrap()
                .w_full(),
        );

    if let Some(p) = path.filter(|v| !v.trim().is_empty()) {
        card = card.child(build_code_preview_box(
            t,
            format!("file-preview:{req_key}:{item_id}"),
            p,
            k.ty.mono,
            8.0,
        ));
    }

    if let Some(r) = reason.filter(|v| !v.trim().is_empty()) {
        card = card.child(
            text(approval_risk_label(r))
                .font(k.ty.ui)
                .color(t.text_muted)
                .wrap()
                .w_full(),
        );
    }

    if let Some(err) = error_msg {
        card = card.child(build_error_strip(k, t, err));
    }

    let id_deny = request_id.clone();
    let ws_deny = workspace_id.clone();
    let tid_deny = thread_id.clone();

    let id_allow = request_id.clone();
    let ws_allow = workspace_id;
    let tid_allow = thread_id;

    card.child(
        row()
            .w_full()
            .justify_end()
            .gap(8.0)
            .pt(2.0)
            .child(
                Button::new("Deny")
                    .variant(ButtonVariant::Outline)
                    .control_size(ControlSize::Small)
                    .on_press(move |s: &mut AppState| {
                        s.dispatch(Action::Chat(ChatAction::ResolveServerRequest {
                            workspace_id: ws_deny.clone(),
                            thread_id: tid_deny.clone(),
                            id: id_deny.clone(),
                            response: ServerRequestReceiptResponse::Approval { approved: false },
                        }));
                    })
                    .build(k)
                    .key(format!("file-deny:{req_key}")),
            )
            .child(
                Button::new("Approve")
                    .variant(ButtonVariant::Contrast)
                    .control_size(ControlSize::Small)
                    .on_press(move |s: &mut AppState| {
                        s.dispatch(Action::Chat(ChatAction::ResolveServerRequest {
                            workspace_id: ws_allow.clone(),
                            thread_id: tid_allow.clone(),
                            id: id_allow.clone(),
                            response: ServerRequestReceiptResponse::Approval { approved: true },
                        }));
                    })
                    .build(k)
                    .key(format!("file-allow:{req_key}")),
            ),
    )
}

#[allow(clippy::too_many_arguments)]
fn build_user_input_card(
    s: &AppState,
    k: &Kit,
    t: &ThemeTokens,
    workspace_id: String,
    thread_id: String,
    request_id: &JsonRpcLiteId,
    item_id: &str,
    raw_questions: &Value,
    position: usize,
    total: usize,
    error_msg: Option<&str>,
) -> El {
    let req_key = request_id_key(request_id);
    let spec = parse_ask_prompt_spec(raw_questions);
    let step_count = spec.questions.len().max(1);
    let active_step = s
        .chat_ui
        .ask_active_question_idx
        .get(&req_key)
        .copied()
        .unwrap_or(0)
        .min(step_count - 1);
    let q = &spec.questions[active_step];
    let q_state_key = format!("{req_key}:{}", q.id);

    let mut card = col()
        .key(format!("interaction:{req_key}:{item_id}"))
        .w_full()
        .min_w(0.0)
        .max_w(768.0)
        .gap(10.0)
        .px(16.0)
        .py(14.0)
        .radius(14.0)
        .fill(k.alpha(t.accent, 0.05))
        .border(1.0, k.alpha(t.accent, 0.28));

    let badge_text = if step_count > 1 {
        format!("Question {} of {step_count}", active_step + 1)
    } else {
        "Needs input".to_string()
    };
    card = card.child(build_card_header(
        k,
        t,
        &badge_text,
        StatusPillTone::Accent,
        &icons::MESSAGE_SQUARE,
        position,
        total,
    ));

    if let Some(h) = &q.header {
        card = card.child(text(h.clone()).font(k.ty.small_medium).color(t.accent));
    }

    card = card.child(
        text(q.question.clone())
            .font(k.ty.body_medium)
            .color(t.text_base)
            .wrap()
            .w_full(),
    );

    let selected = s
        .chat_ui
        .ask_selected_options
        .get(&q_state_key)
        .map(Vec::as_slice)
        .unwrap_or(&[]);

    if !q.options.is_empty() {
        let mut opts_col = col().w_full().gap(6.0);
        for (o_idx, opt) in q.options.iter().enumerate() {
            let is_selected = selected.iter().any(|sel| sel == &opt.label);
            let opt_label = opt.label.clone();
            let q_key_cb = q_state_key.clone();
            let is_single_immediate = !spec.is_multi_structured && !q.multi_select;
            let ws_imm = workspace_id.clone();
            let tid_imm = thread_id.clone();
            let id_imm = request_id.clone();
            let multi_select = q.multi_select;
            let multi_structured = spec.is_multi_structured;
            let req_for_step = req_key.clone();
            let next_step = active_step + 1;

            let mut opt_row = row()
                .key(format!("ask-opt:{q_state_key}:{o_idx}"))
                .w_full()
                .items_center()
                .gap(8.0)
                .px(12.0)
                .py(8.0)
                .radius(10.0)
                .fill(if is_selected {
                    k.alpha(t.accent, 0.14)
                } else {
                    t.card_bg
                })
                .hover(t.elevated_bg)
                .border(
                    1.0,
                    if is_selected {
                        t.accent
                    } else {
                        t.border_muted
                    },
                )
                .cursor(Cursor::Pointer)
                .role("button")
                .label(opt_label.clone())
                .on_press(move |s: &mut AppState| {
                    prune_resolved_ask_state(s);
                    if is_single_immediate {
                        s.dispatch(Action::Chat(ChatAction::ResolveServerRequest {
                            workspace_id: ws_imm.clone(),
                            thread_id: tid_imm.clone(),
                            id: id_imm.clone(),
                            response: ServerRequestReceiptResponse::Ask {
                                answer: opt_label.clone(),
                            },
                        }));
                        return;
                    }

                    let entry = s
                        .chat_ui
                        .ask_selected_options
                        .entry(q_key_cb.clone())
                        .or_default();
                    if multi_select {
                        if let Some(pos) = entry.iter().position(|x| x == &opt_label) {
                            entry.remove(pos);
                        } else {
                            entry.push(opt_label.clone());
                        }
                    } else {
                        entry.clear();
                        entry.push(opt_label.clone());
                        if multi_structured && next_step < step_count {
                            s.chat_ui
                                .ask_active_question_idx
                                .insert(req_for_step.clone(), next_step);
                        }
                    }
                })
                .child(
                    col()
                        .grow(1.0)
                        .min_w(0.0)
                        .gap(2.0)
                        .child(
                            text(opt.label.clone())
                                .font(k.ty.ui_medium)
                                .color(t.text_base)
                                .wrap()
                                .w_full(),
                        )
                        .children(opt.description.as_ref().map(|d| {
                            text(d.clone())
                                .font(k.ty.text_xsmall)
                                .color(t.text_muted)
                                .wrap()
                                .w_full()
                        })),
                );
            if is_selected {
                opt_row = opt_row.child(icon(k.glyph.check, 13.0).color(t.accent));
            }
            opts_col = opts_col.child(opt_row);
        }
        card = card.child(opts_col);
    }

    let edit_ref = s
        .chat_ui
        .ask_text_edits
        .get(&q_state_key)
        .unwrap_or(&EMPTY_ASK_EDIT);
    let current_text = edit_ref.text.trim().to_string();
    let placeholder = if q.options.is_empty() {
        "Type your answer…"
    } else {
        "Or type a custom answer…"
    };

    let edit_change_key = q_state_key.clone();
    let req_enter = req_key.clone();
    let spec_enter = spec.clone();
    let ws_enter = workspace_id.clone();
    let tid_enter = thread_id.clone();
    let id_enter = request_id.clone();

    let mut field = text_input(edit_ref, k.ty.ui)
        .key(format!("ask-input:{q_state_key}"))
        .label(format!("Answer {}", active_step + 1))
        .w_full()
        .placeholder(placeholder, t.text_faint)
        .caret(t.accent, t.selection_bg)
        .on_edit(move |s: &mut AppState| {
            s.chat_ui
                .ask_text_edits
                .entry(edit_change_key.clone())
                .or_default()
        })
        .on_input_key(move |s: &mut AppState, ke, _tx: &mut Tx| {
            if !ke.mods.shift && matches!(ke.key, Key::Enter) && !spec_enter.is_multi_structured {
                return dispatch_ask_submit(
                    s,
                    &req_enter,
                    &spec_enter,
                    &ws_enter,
                    &tid_enter,
                    &id_enter,
                );
            }
            false
        });
    if q.is_secret {
        field = field.secure();
    }

    let input_box = row()
        .w_full()
        .px(10.0)
        .py(8.0)
        .radius(10.0)
        .fill(t.input_bg)
        .border(1.0, t.border)
        .child(field);
    card = card.child(input_box);

    if let Some(err) = error_msg {
        card = card.child(build_error_strip(k, t, err));
    }

    let can_submit_current = !current_text.is_empty() || !selected.is_empty();
    let mut footer = row().w_full().items_center().gap(8.0).pt(2.0);

    if spec.is_multi_structured && active_step > 0 {
        let req_prev = req_key.clone();
        footer = footer.child(
            Button::new("Back")
                .variant(ButtonVariant::Ghost)
                .control_size(ControlSize::Small)
                .on_press(move |s: &mut AppState| {
                    s.chat_ui
                        .ask_active_question_idx
                        .insert(req_prev.clone(), active_step - 1);
                })
                .build(k)
                .key(format!("ask-back:{req_key}")),
        );
    }

    footer = footer.child(spacer());

    let req_skip = req_key.clone();
    let spec_skip = spec.clone();
    let ws_skip = workspace_id.clone();
    let tid_skip = thread_id.clone();
    let id_skip = request_id.clone();
    footer = footer.child(
        Button::new("Skip")
            .variant(ButtonVariant::Ghost)
            .control_size(ControlSize::Small)
            .on_press(move |s: &mut AppState| {
                dispatch_ask_skip(s, &req_skip, &spec_skip, &ws_skip, &tid_skip, &id_skip);
            })
            .build(k)
            .key(format!("ask-skip:{req_key}")),
    );

    if spec.is_multi_structured && active_step + 1 < step_count {
        let req_next = req_key.clone();
        footer = footer.child(
            Button::new("Next")
                .variant(ButtonVariant::Contrast)
                .control_size(ControlSize::Small)
                .disabled(!can_submit_current)
                .on_press(move |s: &mut AppState| {
                    s.chat_ui
                        .ask_active_question_idx
                        .insert(req_next.clone(), active_step + 1);
                })
                .build(k)
                .key(format!("ask-next:{req_key}")),
        );
    } else {
        let req_send = req_key.clone();
        let spec_send = spec;
        let ws_send = workspace_id;
        let tid_send = thread_id;
        let id_send = request_id.clone();
        footer = footer.child(
            Button::new("Send")
                .variant(ButtonVariant::Contrast)
                .control_size(ControlSize::Small)
                .disabled(!can_submit_current)
                .on_press(move |s: &mut AppState| {
                    let _ = dispatch_ask_submit(
                        s, &req_send, &spec_send, &ws_send, &tid_send, &id_send,
                    );
                })
                .build(k)
                .key(format!("ask-send:{req_key}")),
        );
    }

    card.child(footer)
}

fn dispatch_ask_skip(
    s: &mut AppState,
    _req_key: &str,
    spec: &AskPromptSpec,
    workspace_id: &str,
    thread_id: &str,
    id: &JsonRpcLiteId,
) {
    prune_resolved_ask_state(s);
    if spec.is_multi_structured {
        let mut answers = HashMap::new();
        for q in &spec.questions {
            answers.insert(
                q.id.clone(),
                serde_json::json!({ "answers": [ASK_SKIP_TOKEN] }),
            );
        }
        s.dispatch(Action::Chat(ChatAction::SubmitUserInput {
            workspace_id: workspace_id.to_string(),
            thread_id: thread_id.to_string(),
            id: id.clone(),
            answers,
        }));
    } else {
        s.dispatch(Action::Chat(ChatAction::ResolveServerRequest {
            workspace_id: workspace_id.to_string(),
            thread_id: thread_id.to_string(),
            id: id.clone(),
            response: ServerRequestReceiptResponse::Ask {
                answer: ASK_SKIP_TOKEN.to_string(),
            },
        }));
    }
}

fn dispatch_ask_submit(
    s: &mut AppState,
    req_key: &str,
    spec: &AskPromptSpec,
    workspace_id: &str,
    thread_id: &str,
    id: &JsonRpcLiteId,
) -> bool {
    prune_resolved_ask_state(s);
    if !spec.is_multi_structured {
        let q = &spec.questions[0];
        let q_state_key = format!("{req_key}:{}", q.id);
        let typed = s
            .chat_ui
            .ask_text_edits
            .get(&q_state_key)
            .map(|e| e.text.trim().to_string())
            .filter(|v| !v.is_empty());
        let selected = s
            .chat_ui
            .ask_selected_options
            .get(&q_state_key)
            .cloned()
            .unwrap_or_default();
        let mut vals = selected;
        if let Some(t) = typed {
            if q.multi_select {
                if !vals.iter().any(|x| x == &t) {
                    vals.push(t);
                }
            } else {
                vals.clear();
                vals.push(t);
            }
        }
        if vals.is_empty() {
            return false;
        }
        let answer = vals.join(", ");
        s.dispatch(Action::Chat(ChatAction::ResolveServerRequest {
            workspace_id: workspace_id.to_string(),
            thread_id: thread_id.to_string(),
            id: id.clone(),
            response: ServerRequestReceiptResponse::Ask { answer },
        }));
        return true;
    }

    let mut answers = HashMap::new();
    for q in &spec.questions {
        let q_state_key = format!("{req_key}:{}", q.id);
        let mut vals = s
            .chat_ui
            .ask_selected_options
            .get(&q_state_key)
            .cloned()
            .unwrap_or_default();
        if let Some(typed) = s
            .chat_ui
            .ask_text_edits
            .get(&q_state_key)
            .map(|e| e.text.trim().to_string())
            .filter(|v| !v.is_empty())
        {
            vals.push(typed);
        }
        if vals.is_empty() {
            vals.push(ASK_SKIP_TOKEN.to_string());
        }
        answers.insert(q.id.clone(), serde_json::json!({ "answers": vals }));
    }

    s.dispatch(Action::Chat(ChatAction::SubmitUserInput {
        workspace_id: workspace_id.to_string(),
        thread_id: thread_id.to_string(),
        id: id.clone(),
        answers,
    }));
    true
}

fn prune_resolved_ask_state(s: &mut AppState) {
    let active_req_keys: HashSet<String> = s
        .thread_runtime_by_id
        .values()
        .flat_map(|rt| rt.pending_interactions.iter())
        .filter_map(|item| match item {
            ChatInteraction::UserInput { request_id, .. } => Some(request_id_key(request_id)),
            _ => None,
        })
        .collect();
    s.chat_ui.retain_active_ask_requests(&active_req_keys);
}

fn build_card_header(
    k: &Kit,
    t: &ThemeTokens,
    badge: &str,
    tone: StatusPillTone,
    badge_icon: &'static rune::Icon,
    position: usize,
    total: usize,
) -> El {
    let mut hdr = row()
        .w_full()
        .items_center()
        .gap(8.0)
        .child(icon(badge_icon, 14.0).color(match tone {
            StatusPillTone::Danger => t.danger,
            StatusPillTone::Warning => t.warning,
            StatusPillTone::Accent => t.accent,
            _ => t.text_muted,
        }))
        .child(status_pill(k, t, badge, tone))
        .child(spacer());

    if total > 1 {
        hdr = hdr.child(
            text(format!("{position} of {total}"))
                .font(k.ty.text_xsmall)
                .color(t.text_muted),
        );
    }
    hdr
}

/// Renders a monospace command or path preview clipped inside a layout-accounted rounded box
/// so long or unbroken tokens wrap cleanly within generous inner padding.
fn build_code_preview_box(
    t: &ThemeTokens,
    key: String,
    content: &str,
    font: TextStyle,
    py: f32,
) -> El {
    col()
        .key(key.clone())
        .dir(Direction::Ltr)
        .w_full()
        .min_w(0.0)
        .radius(8.0)
        .fill(t.code_bg)
        .border(1.0, t.border_muted)
        .border_layout()
        .clip_rounded(8.0)
        .child(
            col()
                .key(format!("{key}:scroll"))
                .w_full()
                .min_w(0.0)
                .max_h(160.0)
                .scroll(ScrollSpec {
                    stick_bottom: false,
                })
                .scroll_edge_fade(12.0)
                .child(
                    col().w_full().min_w(0.0).px(14.0).py(py).child(
                        text(content.to_string())
                            .key(format!("{key}:text"))
                            .font(font)
                            .color(t.text_base)
                            .wrap_anywhere()
                            .selectable(true)
                            .w_full()
                            .min_w(0.0),
                    ),
                ),
        )
}

fn build_error_strip(k: &Kit, t: &ThemeTokens, err: &str) -> El {
    row()
        .w_full()
        .items_start()
        .gap(8.0)
        .px(10.0)
        .py(8.0)
        .radius(8.0)
        .fill(k.alpha(t.danger, 0.10))
        .border(1.0, k.alpha(t.danger, 0.30))
        .child(icon(&icons::ALERT, 13.0).color(t.danger).mt(2.0))
        .child(
            text(err.to_string())
                .font(k.ty.text_xsmall)
                .color(t.danger)
                .wrap_anywhere()
                .grow(1.0)
                .min_w(0.0),
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_canonical_single_ask_payload() {
        let parsed = parse_ask_prompt_spec(&json!({
            "question": "Which environment?",
            "options": ["staging", "prod"]
        }));
        assert!(!parsed.is_multi_structured);
        assert_eq!(parsed.questions.len(), 1);
        assert_eq!(parsed.questions[0].question, "Which environment?");
        assert_eq!(parsed.questions[0].options.len(), 2);
    }

    #[test]
    fn parses_structured_multi_question_payload_and_null_fallback() {
        let parsed = parse_ask_prompt_spec(&json!({
            "questions": [
                {
                    "id": "framework",
                    "header": "Stack",
                    "question": "Select framework",
                    "multiSelect": true,
                    "options": [{ "label": "Rune", "description": "Native desktop" }]
                }
            ]
        }));
        assert!(parsed.is_multi_structured);
        assert_eq!(parsed.questions[0].id, "framework");
        assert!(parsed.questions[0].multi_select);
        assert_eq!(
            parsed.questions[0].options[0].description.as_deref(),
            Some("Native desktop")
        );

        let fallback = parse_ask_prompt_spec(&Value::Null);
        assert!(!fallback.is_multi_structured);
        assert_eq!(fallback.questions[0].question, ASK_QUESTION_FALLBACK);
    }
}
