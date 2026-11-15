//! Chat-scoped modals and recovery prompts (`CancelSubagentsDialog`, `TranscriptDeliveryRecovery`).

use rune::{El, col, icon, row, spacer, text};
use rune_kit::{Button, ButtonVariant, ControlSize, Dialog, Kit};

use crate::actions::{Action, ChatAction};
use crate::state::{AppState, TranscriptDeliveryFailure};
use crate::theme::ThemeTokens;

use super::icons;
use super::model::count_active_child_agents;

/// Mounts the confirmation dialog when stopping a turn that has running subagents.
pub fn build_cancel_subagents_dialog(s: &AppState, k: &Kit, overlays: &mut Vec<El>) {
    if !s.chat_ui.cancel_subagents_open {
        return;
    }
    let Some(thread) = s
        .chat_ui
        .cancel_subagents_thread_id
        .as_deref()
        .and_then(|id| s.threads.iter().find(|t| t.id == id))
        .or_else(|| s.active_thread())
    else {
        return;
    };
    let tid = thread.id.clone();
    let running_count = s
        .thread_runtime_by_id
        .get(&tid)
        .map(|rt| count_active_child_agents(&rt.agents))
        .unwrap_or(0);

    let description = if running_count == 1 {
        "1 background subagent is still running. Stop it along with this turn, or keep it running?"
            .to_string()
    } else if running_count > 1 {
        format!(
            "{running_count} background subagents are still running. Stop them along with this turn, or keep them running?"
        )
    } else {
        "Stop this active turn and any background subagents?".to_string()
    };

    let tid_keep = tid.clone();
    let tid_all = tid;

    Dialog::new("cancel-subagents-dialog", "Stop running subagents?")
        .open(true)
        .width(460.0)
        .fit()
        .click_outside(true)
        .on_close(close_cancel_subagents_dialog)
        .child(
            col()
                .w_full()
                .min_w(0.0)
                .px(16.0)
                .pb(16.0)
                .gap(12.0)
                .child(
                    text(description)
                        .font(k.ty.ui)
                        .color(k.c.text_muted)
                        .w_full()
                        .min_w(0.0)
                        .wrap(),
                )
                .child(
                    row()
                        .w_full()
                        .gap(8.0)
                        .pt(4.0)
                        .child(spacer())
                        .child(
                            Button::new("Cancel")
                                .variant(ButtonVariant::Ghost)
                                .control_size(ControlSize::Regular)
                                .on_press(close_cancel_subagents_dialog)
                                .build(k)
                                .key("cancel-subagents-cancel"),
                        )
                        .child(
                            Button::new("Keep subagents")
                                .variant(ButtonVariant::Outline)
                                .control_size(ControlSize::Regular)
                                .on_press(move |s: &mut AppState| {
                                    close_cancel_subagents_dialog(s);
                                    s.dispatch(Action::Chat(ChatAction::CancelTurn {
                                        thread_id: tid_keep.clone(),
                                        include_subagents: false,
                                    }));
                                })
                                .build(k)
                                .key("cancel-subagents-keep"),
                        )
                        .child(
                            Button::new("Stop all")
                                .variant(ButtonVariant::Danger)
                                .control_size(ControlSize::Regular)
                                .on_press(move |s: &mut AppState| {
                                    close_cancel_subagents_dialog(s);
                                    s.dispatch(Action::Chat(ChatAction::CancelTurn {
                                        thread_id: tid_all.clone(),
                                        include_subagents: true,
                                    }));
                                })
                                .build(k)
                                .key("cancel-subagents-all"),
                        ),
                ),
        )
        .build(k, overlays);
}

fn close_cancel_subagents_dialog(s: &mut AppState) {
    s.chat_ui.cancel_subagents_open = false;
    s.chat_ui.cancel_subagents_thread_id = None;
}

/// Non-blocking recovery card shown when a thread transcript fails to hydrate or sync cleanly.
pub fn build_transcript_recovery_banner(
    k: &Kit,
    t: &ThemeTokens,
    thread_id: &str,
    failure: &TranscriptDeliveryFailure,
) -> El {
    let tid_dismiss = thread_id.to_string();
    let tid_retry = thread_id.to_string();

    let card = row()
        .key("transcript-delivery-recovery")
        .w_full()
        .max_w(720.0)
        .items_center()
        .gap(12.0)
        .px(12.0)
        .py(10.0)
        .radius(12.0)
        .fill(t.popover_bg)
        .border(1.0, k.alpha(t.danger, 0.35))
        .child(icon(&icons::ALERT, 15.0).color(t.danger))
        .child(
            col()
                .grow(1.0)
                .min_w(0.0)
                .gap(2.0)
                .child(
                    text("Transcript sync issue")
                        .font(k.ty.small_medium)
                        .color(t.text_base),
                )
                .child(
                    text(failure.message.clone())
                        .font(k.ty.text_xsmall)
                        .color(t.text_muted)
                        .wrap()
                        .w_full(),
                ),
        )
        .child(
            row()
                .items_center()
                .gap(6.0)
                .child(
                    Button::new("Dismiss")
                        .variant(ButtonVariant::Ghost)
                        .control_size(ControlSize::Small)
                        .on_press(move |s: &mut AppState| {
                            s.dispatch(Action::Chat(
                                ChatAction::DismissTranscriptDeliveryFailure {
                                    thread_id: tid_dismiss.clone(),
                                },
                            ));
                        })
                        .build(k)
                        .key("recovery-dismiss"),
                )
                .children(failure.recoverable.then(|| {
                    Button::new("Retry sync")
                        .variant(ButtonVariant::Outline)
                        .control_size(ControlSize::Small)
                        .icon(&icons::ROTATE_CCW)
                        .on_press(move |s: &mut AppState| {
                            s.dispatch(Action::Chat(ChatAction::RetryTranscriptDelivery {
                                thread_id: tid_retry.clone(),
                            }));
                        })
                        .build(k)
                        .key("recovery-retry")
                })),
        );

    row()
        .key("transcript-delivery-recovery-wrap")
        .w_full()
        .justify_center()
        .px(20.0)
        .pt(6.0)
        .child(card)
}
