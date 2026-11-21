//! Privacy & Telemetry settings page (`apps/desktop/src/ui/settings/pages/PrivacyTelemetryPage.tsx`).

use rune::{El, row};
use rune_kit::{Button, ButtonVariant, ControlSize, Kit};
use serde_json::Value;

use crate::actions::{Action, SettingsAction};
use crate::state::{AppState, PrivacyTelemetrySettings};
use crate::theme::ThemeTokens;
use crate::views::settings::primitives::{
    ConfirmDialogSpec, Section, SettingsRow, StatusTone, callout_banner, confirm_dialog,
    mini_switch, settings_page, status_pill,
};
use crate::views::settings::shell::PageContent;

/// Pure helper computing updated `PrivacyTelemetrySettings` while keeping
/// `ai_trace_payloads_enabled` gated off whenever `ai_trace_telemetry_enabled` is false.
pub fn apply_privacy_patch(
    current: &PrivacyTelemetrySettings,
    mutate: impl FnOnce(&mut PrivacyTelemetrySettings),
) -> PrivacyTelemetrySettings {
    let mut next = current.clone();
    mutate(&mut next);
    if !next.ai_trace_telemetry_enabled {
        next.ai_trace_payloads_enabled = false;
    }
    next
}

fn dispatch_privacy_patch(s: &mut AppState, mutate: impl FnOnce(&mut PrivacyTelemetrySettings)) {
    let next = apply_privacy_patch(&s.desktop_settings.privacy_telemetry, mutate);
    s.dispatch(Action::Settings(SettingsAction::UpdatePrivacyTelemetry(
        next,
    )));
    s.dispatch(Action::Settings(SettingsAction::RefreshTelemetryStatus));
}

fn status_pill_from_snapshot(
    snapshot: Option<&Value>,
    field: &str,
    fallback_label: &str,
    fallback_tone: StatusTone,
    k: &Kit,
    t: &ThemeTokens,
) -> El {
    let entry = snapshot.and_then(|v| v.get(field));
    let label = entry
        .and_then(|e| e.get("label"))
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(fallback_label);
    let tone = match entry.and_then(|e| e.get("status")).and_then(Value::as_str) {
        Some("enabled" | "metadata_only" | "full_payload" | "connected" | "upload_configured") => {
            StatusTone::Success
        }
        Some("error") => StatusTone::Danger,
        Some("not_configured" | "local_only") => StatusTone::Warning,
        Some(_) => StatusTone::Neutral,
        None => fallback_tone,
    };
    status_pill(label, tone, k, t)
}

/// Renders the Privacy & Telemetry settings page.
pub fn view(s: &AppState, k: &Kit, t: &ThemeTokens) -> PageContent {
    let pt = &s.desktop_settings.privacy_telemetry;
    let snapshot = s.telemetry_status.as_ref();
    let kill_switch_active = snapshot
        .and_then(|v| v.get("globalKillSwitchActive"))
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let any_telemetry = pt.crash_reports_enabled
        || pt.product_analytics_enabled
        || pt.ai_trace_telemetry_enabled
        || pt.ai_trace_payloads_enabled
        || pt.diagnostics_upload_enabled
        || pt.cloud_sync_enabled;

    let mut rows: Vec<El> = Vec::new();

    if kill_switch_active {
        rows.push(
            SettingsRow::new("Global kill switch")
                .description(
                    "COWORK_DISABLE_NETWORK_TELEMETRY is active. Network telemetry is disabled.",
                )
                .control(status_pill("Active", StatusTone::Neutral, k, t))
                .build(k, t),
        );
    }

    rows.push(
        SettingsRow::new("Crash reports")
            .description(
                "Send anonymized crash stacks when the desktop client terminates unexpectedly.",
            )
            .control(
                row()
                    .items_center()
                    .gap(8.0)
                    .child(status_pill_from_snapshot(
                        snapshot,
                        "crashReports",
                        if pt.crash_reports_enabled {
                            "Enabled"
                        } else {
                            "Disabled"
                        },
                        if pt.crash_reports_enabled {
                            StatusTone::Success
                        } else {
                            StatusTone::Neutral
                        },
                        k,
                        t,
                    ))
                    .child(mini_switch(
                        pt.crash_reports_enabled,
                        "Crash reports",
                        false,
                        |s: &mut AppState| {
                            dispatch_privacy_patch(s, |p| {
                                p.crash_reports_enabled = !p.crash_reports_enabled;
                            });
                        },
                        k,
                    )),
            )
            .build(k, t),
    );

    rows.push(
        SettingsRow::new("Product analytics")
            .description("Share aggregate feature usage events without file contents or prompts.")
            .control(
                row()
                    .items_center()
                    .gap(8.0)
                    .child(status_pill_from_snapshot(
                        snapshot,
                        "productAnalytics",
                        if pt.product_analytics_enabled {
                            "Enabled"
                        } else {
                            "Disabled"
                        },
                        if pt.product_analytics_enabled {
                            StatusTone::Success
                        } else {
                            StatusTone::Neutral
                        },
                        k,
                        t,
                    ))
                    .child(mini_switch(
                        pt.product_analytics_enabled,
                        "Product analytics",
                        false,
                        |s: &mut AppState| {
                            dispatch_privacy_patch(s, |p| {
                                p.product_analytics_enabled = !p.product_analytics_enabled;
                            });
                        },
                        k,
                    )),
            )
            .build(k, t),
    );

    rows.push(
        SettingsRow::new("AI trace metadata")
            .description(
                "Record latency, token counts, and tool error summaries for reliability diagnostics.",
            )
            .control(
                row()
                    .items_center()
                    .gap(8.0)
                    .child(status_pill_from_snapshot(
                        snapshot,
                        "aiTraces",
                        if !pt.ai_trace_telemetry_enabled {
                            "Disabled"
                        } else if pt.ai_trace_payloads_enabled {
                            "Full payload"
                        } else {
                            "Metadata only"
                        },
                        if pt.ai_trace_telemetry_enabled {
                            StatusTone::Success
                        } else {
                            StatusTone::Neutral
                        },
                        k,
                        t,
                    ))
                    .child(mini_switch(
                        pt.ai_trace_telemetry_enabled,
                        "AI trace metadata",
                        false,
                        |s: &mut AppState| {
                            dispatch_privacy_patch(s, |p| {
                                p.ai_trace_telemetry_enabled = !p.ai_trace_telemetry_enabled;
                            });
                        },
                        k,
                    )),
            )
            .build(k, t),
    );

    // Full-payload capture exposes prompts, tool outputs, commands, logs, and file paths;
    // require explicit confirmation modal before turning ON while turning OFF remains one click.
    let (payload_label, payload_tone) = if !pt.ai_trace_telemetry_enabled {
        ("Requires metadata", StatusTone::Neutral)
    } else if pt.ai_trace_payloads_enabled {
        ("Full payload", StatusTone::Success)
    } else {
        ("Disabled", StatusTone::Neutral)
    };
    let payloads_row = SettingsRow::new("AI trace payloads")
        .description(
            "Include prompt and tool payload samples in AI traces. Requires AI trace metadata.",
        )
        .control(
            row()
                .items_center()
                .gap(8.0)
                .child(status_pill(payload_label, payload_tone, k, t))
                .child(mini_switch(
                    pt.ai_trace_payloads_enabled,
                    "AI trace payloads",
                    !pt.ai_trace_telemetry_enabled,
                    |s: &mut AppState| {
                        if s.desktop_settings
                            .privacy_telemetry
                            .ai_trace_payloads_enabled
                        {
                            dispatch_privacy_patch(s, |p| {
                                p.ai_trace_payloads_enabled = false;
                            });
                        } else if s
                            .desktop_settings
                            .privacy_telemetry
                            .ai_trace_telemetry_enabled
                        {
                            s.settings_ui.privacy_trace_payloads_confirm_open = true;
                        }
                    },
                    k,
                )),
        );
    let payloads_row = if !pt.ai_trace_payloads_enabled && pt.ai_trace_telemetry_enabled {
        payloads_row
            .meta("Enabling full-payload capture prompts for confirmation because traces include prompt and tool data.")
    } else {
        payloads_row
    };
    rows.push(payloads_row.build(k, t));

    rows.push(
        SettingsRow::new("Diagnostics bundle uploads")
            .description("Allow uploading generated diagnostic bundles when requesting support.")
            .control(
                row()
                    .items_center()
                    .gap(8.0)
                    .child(status_pill_from_snapshot(
                        snapshot,
                        "diagnosticsUpload",
                        if pt.diagnostics_upload_enabled {
                            "Local only"
                        } else {
                            "Disabled"
                        },
                        if pt.diagnostics_upload_enabled {
                            StatusTone::Warning
                        } else {
                            StatusTone::Neutral
                        },
                        k,
                        t,
                    ))
                    .child(mini_switch(
                        pt.diagnostics_upload_enabled,
                        "Diagnostics bundle uploads",
                        false,
                        |s: &mut AppState| {
                            dispatch_privacy_patch(s, |p| {
                                p.diagnostics_upload_enabled = !p.diagnostics_upload_enabled;
                            });
                        },
                        k,
                    )),
            )
            .build(k, t),
    );

    rows.push(
        SettingsRow::new("Cloud preferences sync")
            .description("Sync desktop settings and model preferences across signed-in devices.")
            .control(
                row()
                    .items_center()
                    .gap(8.0)
                    .child(status_pill_from_snapshot(
                        snapshot,
                        "cloudSync",
                        if pt.cloud_sync_enabled {
                            "Enabled"
                        } else {
                            "Disabled"
                        },
                        if pt.cloud_sync_enabled {
                            StatusTone::Success
                        } else {
                            StatusTone::Neutral
                        },
                        k,
                        t,
                    ))
                    .child(mini_switch(
                        pt.cloud_sync_enabled,
                        "Cloud preferences sync",
                        false,
                        |s: &mut AppState| {
                            dispatch_privacy_patch(s, |p| {
                                p.cloud_sync_enabled = !p.cloud_sync_enabled;
                            });
                        },
                        k,
                    )),
            )
            .build(k, t),
    );

    let reset_btn = Button::new("Disable all")
        .variant(ButtonVariant::Outline)
        .control_size(ControlSize::Regular)
        .disabled(!any_telemetry)
        .on_press(|s: &mut AppState| {
            s.settings_ui.privacy_disable_all_confirm_open = true;
        })
        .build(k);

    let summary_row = SettingsRow::new("Consent summary")
        .description(if any_telemetry {
            "One or more optional reporting channels are enabled."
        } else {
            "All optional crash, analytics, and trace telemetry channels are turned off."
        })
        .control(
            row()
                .items_center()
                .gap(8.0)
                .child(status_pill(
                    if any_telemetry { "Custom" } else { "Minimal" },
                    if any_telemetry {
                        StatusTone::Neutral
                    } else {
                        StatusTone::Success
                    },
                    k,
                    t,
                ))
                .child(reset_btn),
        )
        .build(k, t);

    let blocks = vec![
        callout_banner(
            StatusTone::Neutral,
            "Telemetry preferences are stored locally and respected immediately across new sessions.",
            k,
            t,
        ),
        Section::new()
            .title("Telemetry & reporting")
            .description("Control optional crash reports, usage metrics, and AI trace consent.")
            .children(rows)
            .build(k, t),
        Section::new()
            .title("Quick controls")
            .child(summary_row)
            .build(k, t),
    ];

    let mut overlays = Vec::new();
    confirm_dialog(
        ConfirmDialogSpec {
            key: "privacy-trace-payloads-confirm",
            open: s.settings_ui.privacy_trace_payloads_confirm_open,
            title: "Enable full-payload AI traces?",
            description: "Full-payload traces include prompt text, tool inputs and outputs, shell commands, log lines, and workspace file paths when AI trace metadata is enabled. Leave this off unless actively debugging.".to_string(),
            confirm_label: "Enable full payloads",
            danger: true,
        },
        |s| {
            s.settings_ui.privacy_trace_payloads_confirm_open = false;
        },
        |s| {
            s.settings_ui.privacy_trace_payloads_confirm_open = false;
            dispatch_privacy_patch(s, |p| {
                if p.ai_trace_telemetry_enabled {
                    p.ai_trace_payloads_enabled = true;
                }
            });
        },
        k,
        &mut overlays,
    );

    confirm_dialog(
        ConfirmDialogSpec {
            key: "privacy-disable-all-confirm",
            open: s.settings_ui.privacy_disable_all_confirm_open,
            title: "Disable all optional telemetry?",
            description: "Turns off crash reports, product analytics, AI trace diagnostics, full-payload traces, diagnostics uploads, and cloud preference sync.".to_string(),
            confirm_label: "Disable all",
            danger: false,
        },
        |s| {
            s.settings_ui.privacy_disable_all_confirm_open = false;
        },
        |s| {
            s.settings_ui.privacy_disable_all_confirm_open = false;
            dispatch_privacy_patch(s, |p| {
                *p = PrivacyTelemetrySettings::default();
            });
        },
        k,
        &mut overlays,
    );

    PageContent::simple(settings_page(blocks)).with_overlays(overlays)
}
