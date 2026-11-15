//! Developer & Diagnostics settings page (`apps/desktop/src/ui/settings/pages/DeveloperPage.tsx`).

use rune::{El, TextEdit, col, el, row, text};
use rune_kit::{
    Button, ButtonVariant, ControlSize, Kit, Select, SelectAppearance, Switch, TextInput,
};
use serde_json::{Value, json};

use crate::actions::{Action, NativeAction, SettingsAction};
use crate::state::{AppState, ServerLifecycleState, WorkspaceRecord, WorkspaceRuntime};
use crate::theme::ThemeTokens;
use crate::views::settings::icons;
use crate::views::settings::primitives::{
    ConfirmDialogSpec, Section, SettingsRow, StatusTone, confirm_dialog, management_targets,
    operation_banner, settings_page, status_pill, update_desktop_settings,
};
use crate::views::settings::shell::PageContent;

pub const DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS: u64 = 30_000;

/// Extracts `(available_bool, detail_message)` from either `RuntimeLibreOfficeCheckResult`
/// (`{ "status": { "status": "available"|"missing"|"error", ... } }`), a flat
/// `RuntimeLibreOfficeStatusView`, or a legacy `{ "available": bool }` payload.
pub fn parse_libreoffice_status(raw: &Value) -> (Option<bool>, Option<String>) {
    let inner = raw
        .get("status")
        .filter(|candidate| candidate.is_object())
        .unwrap_or(raw);
    let available = match inner.get("status").and_then(Value::as_str) {
        Some("available") => Some(true),
        Some("missing" | "error") => Some(false),
        _ => inner.get("available").and_then(Value::as_bool),
    };
    let mut details: Vec<String> = Vec::new();
    if let Some(version) = inner
        .get("version")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        details.push(format!("Version {version}"));
    }
    if let Some(path) = inner
        .get("resolvedPath")
        .or_else(|| inner.get("path"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        details.push(path.to_string());
    }
    if let Some(msg) = inner
        .get("message")
        .or_else(|| inner.get("error"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        details.push(msg.to_string());
    }
    let detail = if details.is_empty() {
        None
    } else {
        Some(details.join(" · "))
    };
    (available, detail)
}

/// Resolves `(overflow_enabled, uses_inherited, inherited_is_null, persisted_threshold)`
/// from workspace defaults and runtime `controlSessionConfig`.
pub fn resolve_workspace_overflow_config(
    ws_record: Option<&WorkspaceRecord>,
    runtime: Option<&WorkspaceRuntime>,
) -> (bool, bool, bool, u64) {
    let inherited_chars = runtime
        .and_then(|rt| rt.control_session_config.as_ref())
        .and_then(|cfg| cfg.get("toolOutputOverflowChars"));
    let explicit_val = ws_record
        .and_then(|w| w.defaults.as_object())
        .and_then(|obj| obj.get("defaultToolOutputOverflowChars"));
    let uses_inherited = explicit_val.is_none();
    let inherited_is_null = matches!(inherited_chars, Some(Value::Null));
    let overflow_enabled = match explicit_val {
        Some(Value::Null) => false,
        Some(Value::Number(_)) => true,
        _ => !inherited_is_null,
    };
    let persisted_threshold = explicit_val
        .and_then(Value::as_u64)
        .or_else(|| inherited_chars.and_then(Value::as_u64))
        .unwrap_or(DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS);
    (
        overflow_enabled,
        uses_inherited,
        inherited_is_null,
        persisted_threshold,
    )
}

/// Parses a non-negative integer overflow threshold input.
pub fn parse_overflow_threshold_draft(raw: &str) -> Option<u64> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || !trimmed.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    trimmed.parse::<u64>().ok()
}

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

fn build_diagnostic_summary_text(s: &AppState, runtime_summary: &str) -> String {
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    let version = crate::native::resolve_desktop_app_version();
    let bundle_path = s
        .settings_ui
        .last_diagnostics_bundle_path
        .as_deref()
        .unwrap_or("none");
    format!(
        "Cowork Desktop v{version} ({os}/{arch})\nBundle path: {bundle_path}\n{runtime_summary}"
    )
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
    let selected_target_id = s
        .settings_ui
        .developer_overflow_threshold_workspace
        .as_deref()
        .and_then(|id| targets.iter().find(|entry| entry.id == id))
        .map(|entry| entry.id.as_str())
        .or_else(|| s.resolve_management_workspace_id());
    let active_target = selected_target_id
        .and_then(|id| targets.iter().find(|entry| entry.id == id))
        .or_else(|| targets.first());

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

    let bundle_state = s.diagnostics_bundle.as_ref();
    let bundle_path_opt = bundle_state
        .map(|b| b.path.clone())
        .filter(|p| !p.trim().is_empty())
        .or_else(|| s.settings_ui.last_diagnostics_bundle_path.clone());
    let summary_text = build_diagnostic_summary_text(s, &runtime_summary);
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
    diagnostics_actions = diagnostics_actions.child(
        Button::new("Open Logs Folder")
            .variant(ButtonVariant::Outline)
            .icon(&icons::FOLDER)
            .control_size(ControlSize::Regular)
            .on_press(|s: &mut AppState| {
                s.dispatch(Action::Settings(SettingsAction::OpenLogsFolder));
            })
            .build(k),
    );
    if let Some(bundle_path) = bundle_path_opt.clone() {
        let reveal_path = bundle_path.clone();
        diagnostics_actions = diagnostics_actions.child(
            Button::new("Reveal Bundle")
                .variant(ButtonVariant::Outline)
                .control_size(ControlSize::Regular)
                .on_press(move |s: &mut AppState| {
                    s.dispatch(Action::Settings(SettingsAction::RevealDiagnosticsBundle {
                        path: Some(reveal_path.clone()),
                    }));
                })
                .build(k),
        );
        if bundle_state.is_some_and(|b| b.upload_configured && b.upload_enabled) {
            diagnostics_actions = diagnostics_actions.child(
                Button::new("Upload Bundle")
                    .variant(ButtonVariant::Outline)
                    .icon(&icons::UPLOAD)
                    .control_size(ControlSize::Regular)
                    .on_press(|s: &mut AppState| {
                        s.settings_ui.diagnostics_upload_confirm_open = true;
                    })
                    .build(k),
            );
        }
    }
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
    diagnostics_actions = diagnostics_actions.child(
        Button::new("Copy Diagnostic Summary")
            .variant(ButtonVariant::Outline)
            .control_size(ControlSize::Regular)
            .on_press(move |s: &mut AppState| {
                s.dispatch(Action::Native(NativeAction::CopyText(summary_text.clone())));
                s.settings_ui.diagnostics_status_banner =
                    Some("Diagnostic summary copied to clipboard.".to_string());
            })
            .build(k),
    );

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

    let bundle_detail = match bundle_state {
        Some(bundle) if !bundle.path.trim().is_empty() => {
            let mut parts = vec![bundle.path.clone()];
            if !bundle.summary.trim().is_empty() {
                parts.push(bundle.summary.clone());
            }
            if let Some(diag_id) = bundle.diagnostic_id.as_deref().filter(|id| !id.is_empty()) {
                parts.push(format!("Diagnostic ID: {diag_id}"));
            }
            if let Some(msg) = bundle.upload_message.as_deref().filter(|m| !m.is_empty()) {
                parts.push(msg.to_string());
            }
            parts.join("\n")
        }
        _ => bundle_path_opt.clone().unwrap_or_else(|| {
            "No bundle recorded in this session. Use Create Diagnostics Bundle above.".to_string()
        }),
    };

    let mut last_bundle_row = SettingsRow::new("Last bundle").description(bundle_detail);
    if let Some(status_msg) = s
        .settings_ui
        .diagnostics_status_banner
        .as_deref()
        .filter(|msg| !msg.trim().is_empty())
    {
        last_bundle_row = last_bundle_row.meta(status_msg);
    } else if let Some(bundle) = bundle_state {
        if bundle.uploaded {
            last_bundle_row = last_bundle_row.meta("Uploaded");
        } else if !bundle.created_at.trim().is_empty() {
            last_bundle_row = last_bundle_row.meta(format!("Created {}", bundle.created_at));
        }
    }

    diagnostics_section = diagnostics_section
        .child(
            SettingsRow::new("Bundle actions")
                .description(
                    "Export a redacted diagnostics archive excluding prompts, completions, file contents, and credentials.",
                )
                .body(diagnostics_actions)
                .build(k, t),
        )
        .child(last_bundle_row.build(k, t))
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

    let parsed_lo = s.libreoffice_status.as_ref().map(parse_libreoffice_status);
    let lo_available = parsed_lo.as_ref().and_then(|(avail, _)| *avail);
    let lo_detail = parsed_lo
        .and_then(|(_, detail)| detail)
        .unwrap_or_else(|| {
            if active_target.is_some() {
                "Checks whether soffice is available in this workspace runtime for document previews."
                    .to_string()
            } else {
                "Open a workspace to check whether soffice is available in the server runtime for document previews."
                    .to_string()
            }
        });
    let lo_ws_id = active_target.map(|target| target.id.clone());
    let lo_controls = row()
        .items_center()
        .gap(8.0)
        .child(status_pill(
            match lo_available {
                Some(true) => "Available",
                Some(false) => "Not detected",
                None => "Unchecked",
            },
            match lo_available {
                Some(true) => StatusTone::Success,
                Some(false) => StatusTone::Warning,
                None => StatusTone::Neutral,
            },
            k,
            t,
        ))
        .child(
            Button::new("Check runtime")
                .variant(ButtonVariant::Outline)
                .control_size(ControlSize::Regular)
                .disabled(lo_ws_id.is_none())
                .on_press(move |s: &mut AppState| {
                    if let Some(ws_id) = &lo_ws_id {
                        s.dispatch(Action::Settings(SettingsAction::CheckLibreOfficeRuntime {
                            workspace_id: ws_id.clone(),
                        }));
                    }
                })
                .build(k),
        );
    let runtime_checks_section = Section::new()
        .title("Runtime checks")
        .description("Verify optional document conversion and preview dependencies.")
        .child(
            SettingsRow::new("LibreOffice runtime")
                .description(lo_detail)
                .control(lo_controls)
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
                .control(
                    row()
                        .items_center()
                        .gap(8.0)
                        .child(status_pill(onboarding_label, onboarding_tone, k, t))
                        .child(
                            Button::new("Run onboarding again")
                                .variant(ButtonVariant::Outline)
                                .control_size(ControlSize::Regular)
                                .on_press(|s: &mut AppState| {
                                    s.settings_ui.developer_restart_onboarding_confirm_open = true;
                                })
                                .build(k),
                        ),
                )
                .build(k, t),
        );

    let mut overlays = Vec::new();
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
            let ws_id = target.id.clone();
            let ws_record = s.workspaces.iter().find(|w| w.id == ws_id);
            let runtime = s.workspace_runtime_by_id.get(&ws_id);
            let server_pill = match runtime {
                Some(rt) => {
                    let (label, tone) = server_state_meta(&rt.server_state);
                    status_pill(label, tone, k, t)
                }
                None => status_pill("Stopped", StatusTone::Neutral, k, t),
            };

            let (overflow_enabled, overflow_uses_inherited, inherited_is_null, persisted_threshold) =
                resolve_workspace_overflow_config(ws_record, runtime);
            let persisted_str = persisted_threshold.to_string();

            if targets.len() > 1 {
                let labels: Vec<String> = targets.iter().map(|entry| entry.label.clone()).collect();
                let open = s.settings_ui.open_select_key.as_deref() == Some("dev-overflow-ws");
                let target_ids: Vec<(String, String)> = targets
                    .iter()
                    .map(|entry| (entry.label.clone(), entry.id.clone()))
                    .collect();
                let select_el = Select::new("dev-overflow-ws", &labels)
                    .label("Context overflow target workspace")
                    .appearance(SelectAppearance::Field)
                    .width(240.0)
                    .current(Some(target.label.as_str()))
                    .open(open)
                    .on_toggle(|s: &mut AppState| {
                        let currently =
                            s.settings_ui.open_select_key.as_deref() == Some("dev-overflow-ws");
                        s.settings_ui.open_select_key = if currently {
                            None
                        } else {
                            Some("dev-overflow-ws".to_string())
                        };
                    })
                    .on_close(|s: &mut AppState| {
                        if s.settings_ui.open_select_key.as_deref() == Some("dev-overflow-ws") {
                            s.settings_ui.open_select_key = None;
                        }
                    })
                    .on_choose(move |s: &mut AppState, chosen, _tx| {
                        s.settings_ui.open_select_key = None;
                        if let Some((_, id)) = target_ids.iter().find(|(lbl, _)| lbl == chosen) {
                            s.settings_ui.developer_overflow_threshold_workspace = Some(id.clone());
                            let ws_rec = s.workspaces.iter().find(|w| w.id == *id);
                            let rt = s.workspace_runtime_by_id.get(id);
                            let (_, _, _, chars) = resolve_workspace_overflow_config(ws_rec, rt);
                            let chars_str = chars.to_string();
                            s.settings_ui.developer_overflow_threshold_edit =
                                TextEdit::new(chars_str.as_str());
                            s.settings_ui.developer_overflow_threshold_synced = Some(chars_str);
                        }
                    })
                    .build(k, &mut overlays);

                overflow_section = overflow_section.child(
                    SettingsRow::new("Workspace")
                        .description(target.path.clone())
                        .control(select_el)
                        .build(k, t),
                );
            } else {
                overflow_section = overflow_section.child(
                    SettingsRow::new(target.label.clone())
                        .description(target.path.clone())
                        .control(server_pill)
                        .build(k, t),
                );
            }

            let ws_toggle = ws_id.clone();
            overflow_section = overflow_section.child(
                SettingsRow::new("Save oversized tool output to scratch files")
                    .description(
                        "When enabled, oversized tool results are saved to disk instead of filling chat history.",
                    )
                    .control(
                        Switch::new(overflow_enabled)
                            .label("Save oversized tool output to scratch files")
                            .hide_label()
                            .on_toggle(move |s: &mut AppState| {
                                let defaults = if overflow_enabled {
                                    json!({ "defaultToolOutputOverflowChars": Value::Null })
                                } else if inherited_is_null {
                                    json!({ "defaultToolOutputOverflowChars": DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS })
                                } else {
                                    json!({ "clearDefaultToolOutputOverflowChars": true })
                                };
                                s.settings_ui.developer_overflow_threshold_edit = TextEdit::new("");
                                s.settings_ui.developer_overflow_threshold_synced = None;
                                s.dispatch(Action::Settings(
                                    SettingsAction::UpdateWorkspaceDefaults {
                                        workspace_id: ws_toggle.clone(),
                                        defaults,
                                    },
                                ));
                            })
                            .build(k),
                    )
                    .build(k, t),
            );

            let prev_synced = s.settings_ui.developer_overflow_threshold_synced.as_deref();
            let untouched = prev_synced.is_none()
                || Some(
                    s.settings_ui
                        .developer_overflow_threshold_edit
                        .text
                        .as_str(),
                ) == prev_synced;
            let synced_fallback = if untouched && prev_synced != Some(persisted_str.as_str()) {
                Some(TextEdit::new(persisted_str.as_str()))
            } else {
                None
            };
            let display_edit = synced_fallback
                .as_ref()
                .unwrap_or(&s.settings_ui.developer_overflow_threshold_edit);
            let draft_text = &display_edit.text;
            let parsed = parse_overflow_threshold_draft(draft_text);
            let error_msg = if overflow_enabled && parsed.is_none() {
                Some("Use a non-negative whole number.")
            } else {
                None
            };
            let dirty = overflow_enabled && parsed.is_some_and(|val| val != persisted_threshold);

            let ws_save = ws_id.clone();
            let ws_reset = ws_id;
            let persisted_on_save = persisted_str.clone();
            let save_btn = Button::new("Save threshold")
                .variant(ButtonVariant::Contrast)
                .control_size(ControlSize::Regular)
                .disabled(!overflow_enabled || !dirty || error_msg.is_some())
                .on_press(move |s: &mut AppState| {
                    let raw = if s.settings_ui.developer_overflow_threshold_synced.is_none() {
                        persisted_on_save.as_str()
                    } else {
                        s.settings_ui
                            .developer_overflow_threshold_edit
                            .text
                            .as_str()
                    };
                    if let Some(val) = parse_overflow_threshold_draft(raw) {
                        let saved = val.to_string();
                        s.settings_ui.developer_overflow_threshold_edit =
                            TextEdit::new(saved.as_str());
                        s.settings_ui.developer_overflow_threshold_synced = Some(saved);
                        s.dispatch(Action::Settings(SettingsAction::UpdateWorkspaceDefaults {
                            workspace_id: ws_save.clone(),
                            defaults: json!({ "defaultToolOutputOverflowChars": val }),
                        }));
                    }
                })
                .build(k);

            let reset_btn = Button::new("Reset to default")
                .variant(ButtonVariant::Outline)
                .control_size(ControlSize::Regular)
                .disabled(overflow_enabled && overflow_uses_inherited)
                .on_press(move |s: &mut AppState| {
                    s.settings_ui.developer_overflow_threshold_edit = TextEdit::new("");
                    s.settings_ui.developer_overflow_threshold_synced = None;
                    let defaults = if overflow_enabled {
                        json!({ "clearDefaultToolOutputOverflowChars": true })
                    } else if inherited_is_null {
                        json!({ "defaultToolOutputOverflowChars": DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS })
                    } else {
                        json!({ "clearDefaultToolOutputOverflowChars": true })
                    };
                    s.dispatch(Action::Settings(SettingsAction::UpdateWorkspaceDefaults {
                        workspace_id: ws_reset.clone(),
                        defaults,
                    }));
                })
                .build(k);

            let synced_for_edit = persisted_str;
            let input_el = TextInput::new(display_edit)
                .label("Spill after this many characters")
                .placeholder(DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS.to_string())
                .width(Some(220.0))
                .disabled(!overflow_enabled)
                .invalid(error_msg.is_some())
                .on_edit(move |s: &mut AppState| {
                    let prev_synced = s.settings_ui.developer_overflow_threshold_synced.as_deref();
                    let untouched = prev_synced.is_none()
                        || Some(
                            s.settings_ui
                                .developer_overflow_threshold_edit
                                .text
                                .as_str(),
                        ) == prev_synced;
                    if untouched && prev_synced != Some(synced_for_edit.as_str()) {
                        s.settings_ui.developer_overflow_threshold_edit =
                            TextEdit::new(synced_for_edit.as_str());
                        s.settings_ui.developer_overflow_threshold_synced =
                            Some(synced_for_edit.clone());
                    }
                    &mut s.settings_ui.developer_overflow_threshold_edit
                })
                .build(k);

            let mut threshold_body = col().w_full().gap(8.0).child(input_el);
            if let Some(err) = error_msg {
                threshold_body =
                    threshold_body.child(text(err).font(k.ty.text_xsmall).color(t.danger));
            } else {
                threshold_body = threshold_body.child(
                    text(format!(
                        "Active threshold: {persisted_threshold} characters (stored under {}/.ModelScratchpad). Set to 0 to spill immediately.",
                        target.path
                    ))
                    .font(k.ty.text_xsmall)
                    .color(t.text_muted)
                    .wrap(),
                );
            }
            threshold_body =
                threshold_body.child(row().gap(8.0).flex_wrap().child(save_btn).child(reset_btn));

            overflow_section = overflow_section.child(
                SettingsRow::new("Spill after this many characters")
                    .description(
                        "Characters kept inline before writing oversized tool output to disk.",
                    )
                    .body(threshold_body)
                    .build(k, t),
            );
        }
    }

    let blocks: Vec<El> = vec![
        diagnostics_section.build(k, t),
        runtime_checks_section.build(k, t),
        file_explorer_section.build(k, t),
        debugging_section.build(k, t),
        overflow_section.build(k, t),
    ];

    let upload_path = bundle_path_opt;
    confirm_dialog(
        ConfirmDialogSpec {
            key: "developer-diagnostics-upload-confirm",
            open: s.settings_ui.diagnostics_upload_confirm_open,
            title: "Upload diagnostics bundle?",
            description: format!(
                "Uploads the redacted archive{} to diagnostic storage configured in your privacy preferences.",
                upload_path
                    .as_deref()
                    .map(|p| format!(" ({p})"))
                    .unwrap_or_default()
            ),
            confirm_label: "Upload bundle",
            danger: false,
        },
        |s| {
            s.settings_ui.diagnostics_upload_confirm_open = false;
        },
        move |s| {
            s.settings_ui.diagnostics_upload_confirm_open = false;
            s.dispatch(Action::Settings(SettingsAction::UploadDiagnosticsBundle {
                path: upload_path.clone(),
                confirmed: true,
            }));
        },
        k,
        &mut overlays,
    );

    confirm_dialog(
        ConfirmDialogSpec {
            key: "developer-restart-onboarding-confirm",
            open: s.settings_ui.developer_restart_onboarding_confirm_open,
            title: "Run onboarding again?",
            description: "Resets onboarding completion state so the guided desktop setup appears again on the main workspace surface.".to_string(),
            confirm_label: "Restart onboarding",
            danger: false,
        },
        |s| {
            s.settings_ui.developer_restart_onboarding_confirm_open = false;
        },
        |s| {
            s.settings_ui.developer_restart_onboarding_confirm_open = false;
            s.dispatch(Action::Settings(SettingsAction::RestartOnboarding));
        },
        k,
        &mut overlays,
    );

    PageContent::simple(settings_page(blocks)).with_overlays(overlays)
}
