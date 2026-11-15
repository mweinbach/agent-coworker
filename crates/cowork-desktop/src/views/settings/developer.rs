//! Developer & Diagnostics settings page (`apps/desktop/src/ui/settings/pages/DeveloperPage.tsx`).

use rune::{El, col, el, row, text};
use rune_kit::{Button, ButtonVariant, ControlSize, Kit, Switch};

use crate::actions::{Action, SettingsAction};
use crate::state::{AppState, ServerLifecycleState};
use crate::theme::ThemeTokens;
use crate::views::settings::icons;
use crate::views::settings::primitives::{
    Section, SettingsRow, StatusTone, management_targets, operation_banner, settings_page,
    status_pill, update_desktop_settings,
};
use crate::views::settings::shell::PageContent;

const DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS: u64 = 30_000;

fn server_state_meta(state: &ServerLifecycleState) -> (&'static str, StatusTone) {
    match state {
        ServerLifecycleState::Running { .. } => ("Running", StatusTone::Success),
        ServerLifecycleState::Starting { .. } => ("Starting", StatusTone::Neutral),
        ServerLifecycleState::Failed { .. } => ("Failed", StatusTone::Danger),
        ServerLifecycleState::Stopped => ("Stopped", StatusTone::Neutral),
    }
}

fn format_onboarding_status(s: &AppState) -> (String, StatusTone) {
    if s.onboarding.completed {
        (
            format!(
                "Completed ({} steps recorded)",
                s.onboarding.completed_steps.len()
            ),
            StatusTone::Success,
        )
    } else if s.onboarding.dismissed {
        ("Dismissed".to_string(), StatusTone::Neutral)
    } else {
        ("Active".to_string(), StatusTone::Warning)
    }
}

/// Renders the Developer / Diagnostics settings page.
pub fn view(s: &AppState, k: &Kit, t: &ThemeTokens) -> PageContent {
    let pt = &s.desktop_settings.privacy_telemetry;
    let export_op_key = "settings:exportDiagnosticsBundle";
    let export_busy = s
        .operations_by_key
        .get(export_op_key)
        .is_some_and(|op| op.busy);

    let targets = management_targets(s);
    let active_target = s
        .resolve_management_workspace_id()
        .and_then(|id| targets.iter().find(|entry| entry.id == id))
        .or_else(|| targets.first());

    let refresh_ws_id = active_target.map(|target| target.id.clone());
    let mut diagnostics_actions = row().flex_wrap().gap(8.0).child(
        Button::new("Create Diagnostics Bundle")
            .variant(ButtonVariant::Contrast)
            .icon(&icons::ARCHIVE_RESTORE)
            .control_size(ControlSize::Regular)
            .disabled(export_busy)
            .on_press(|s: &mut AppState| {
                s.dispatch(Action::Settings(SettingsAction::ExportDiagnosticsBundle));
            })
            .build(k),
    );
    if let Some(ws_id) = refresh_ws_id {
        diagnostics_actions = diagnostics_actions.child(
            Button::new("Refresh diagnostics")
                .variant(ButtonVariant::Outline)
                .icon(&icons::REFRESH_CCW)
                .control_size(ControlSize::Regular)
                .on_press(move |s: &mut AppState| {
                    s.dispatch(Action::Settings(SettingsAction::RefreshDiagnostics {
                        workspace_id: ws_id.clone(),
                    }));
                })
                .build(k),
        );
    }

    let mut diagnostics_section = Section::new()
        .title("Diagnostics Bundle")
        .description("Local logs and redacted technical metadata.")
        .action(status_pill(
            if pt.diagnostics_upload_enabled {
                "Uploads allowed"
            } else {
                "Uploads off"
            },
            if pt.diagnostics_upload_enabled {
                StatusTone::Success
            } else {
                StatusTone::Neutral
            },
            k,
            t,
        ));

    if let Some(banner) = operation_banner(s, export_op_key, k, t) {
        diagnostics_section = diagnostics_section.child(el().px(16.0).py(12.0).child(banner));
    }

    let runtime_summary = match &s.runtime_diagnostics {
        Some(diag) => {
            let startup_label = if diag.diagnostics.startup.ready {
                "Ready"
            } else {
                "Starting / degraded"
            };
            let d = &diag.diagnostics;
            format!(
                "Startup: {startup_label} · Queued sends: {} (dropped deltas: {}, send failures: {}) · Journal pending: {} threads (failed writes: {}) · DB waits: {} (max {} ms)",
                d.send_queue.queued_sends,
                d.send_queue.dropped_deltas,
                d.send_queue.send_failures,
                d.journal.pending_thread_count,
                d.journal.failed_write_count,
                d.db_locks.wait_count,
                d.db_locks.max_wait_ms,
            )
        }
        None => {
            "No runtime snapshot loaded yet. Select an active workspace and refresh diagnostics."
                .to_string()
        }
    };

    diagnostics_section = diagnostics_section
        .child(
            SettingsRow::new("Bundle actions")
                .description(
                    "Export a redacted diagnostics archive excluding prompts, completions, file contents, and credentials.",
                )
                .body(diagnostics_actions)
                .build(k, t),
        )
        .child(
            SettingsRow::new("Server runtime telemetry")
                .description(runtime_summary)
                .control(status_pill(
                    if s.runtime_diagnostics.is_some() {
                        "Loaded"
                    } else {
                        "Not loaded"
                    },
                    if s.runtime_diagnostics.is_some() {
                        StatusTone::Success
                    } else {
                        StatusTone::Neutral
                    },
                    k,
                    t,
                ))
                .build(k, t),
        );

    let file_explorer_section = Section::new()
        .title("File Explorer")
        .description("Configure how files are displayed in the workspace.")
        .child(
            SettingsRow::new("Show hidden files")
                .description("Display dotfiles and other hidden system files.")
                .control(
                    Switch::new(s.desktop_settings.show_hidden_files)
                        .label("Show hidden files")
                        .hide_label()
                        .on_toggle(|s: &mut AppState| {
                            update_desktop_settings(s, |next| {
                                next.show_hidden_files = !next.show_hidden_files;
                            });
                        })
                        .build(k),
                )
                .build(k, t),
        );

    let (onboarding_label, onboarding_tone) = format_onboarding_status(s);
    let debugging_section = Section::new()
        .title("System & Debugging")
        .description("Internal visibility and event tracking.")
        .child(
            SettingsRow::new("Developer mode")
                .description("Show internal system notices in the chat feed.")
                .control(
                    Switch::new(s.desktop_settings.developer_mode)
                        .label("Developer mode")
                        .hide_label()
                        .on_toggle(|s: &mut AppState| {
                            update_desktop_settings(s, |next| {
                                next.developer_mode = !next.developer_mode;
                            });
                        })
                        .build(k),
                )
                .build(k, t),
        )
        .child(
            SettingsRow::new("Onboarding")
                .description("First-time desktop setup walkthrough status.")
                .control(status_pill(onboarding_label, onboarding_tone, k, t))
                .build(k, t),
        );

    let mut overflow_section = Section::new()
        .title("Large Tool Output Handling")
        .description(
            "Save very large tool output to scratch files instead of keeping all of it inline.",
        );

    match active_target {
        None => {
            overflow_section = overflow_section.child(
                SettingsRow::new("No workspace available")
                    .description("Add a workspace to configure large tool output handling.")
                    .build(k, t),
            );
        }
        Some(target) => {
            let runtime = s.workspace_runtime_by_id.get(&target.id);
            let server_pill = match runtime {
                Some(rt) => {
                    let (label, tone) = server_state_meta(&rt.server_state);
                    status_pill(label, tone, k, t)
                }
                None => status_pill("Stopped", StatusTone::Neutral, k, t),
            };
            let overflow_chars = runtime
                .and_then(|rt| rt.control_session_config.as_ref())
                .and_then(|cfg| cfg.get("toolOutputOverflowChars"))
                .and_then(|val| val.as_u64())
                .unwrap_or(DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS);

            let note = col().w_full().gap(4.0).child(
                text(format!(
                    "Active spill threshold: {overflow_chars} characters (stored under {}/.ModelScratchpad).",
                    target.path
                ))
                .font(k.ty.text_xsmall)
                .color(t.text_muted)
                .wrap(),
            );

            overflow_section = overflow_section.child(
                SettingsRow::new(target.label.clone())
                    .description(target.path.clone())
                    .control(server_pill)
                    .body(note)
                    .build(k, t),
            );
        }
    }

    let blocks: Vec<El> = vec![
        diagnostics_section.build(k, t),
        file_explorer_section.build(k, t),
        debugging_section.build(k, t),
        overflow_section.build(k, t),
    ];

    PageContent::simple(settings_page(blocks))
}
