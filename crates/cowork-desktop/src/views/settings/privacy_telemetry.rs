//! Privacy & Telemetry settings page (`apps/desktop/src/ui/settings/pages/PrivacyTelemetryPage.tsx`).

use rune::{El, row};
use rune_kit::{Button, ButtonVariant, ControlSize, Kit, Switch};

use crate::state::{AppState, PrivacyTelemetrySettings};
use crate::theme::ThemeTokens;
use crate::views::settings::primitives::{
    Section, SettingsRow, StatusTone, callout_banner, settings_page, status_pill,
    update_desktop_settings,
};
use crate::views::settings::shell::PageContent;

fn dispatch_privacy_patch(s: &mut AppState, mutate: impl FnOnce(&mut PrivacyTelemetrySettings)) {
    update_desktop_settings(s, |next| {
        mutate(&mut next.privacy_telemetry);
        if !next.privacy_telemetry.ai_trace_telemetry_enabled {
            next.privacy_telemetry.ai_trace_payloads_enabled = false;
        }
    });
}

/// Renders the Privacy & Telemetry settings page.
pub fn view(s: &AppState, k: &Kit, t: &ThemeTokens) -> PageContent {
    let pt = &s.desktop_settings.privacy_telemetry;
    let any_telemetry = pt.crash_reports_enabled
        || pt.product_analytics_enabled
        || pt.ai_trace_telemetry_enabled
        || pt.ai_trace_payloads_enabled
        || pt.diagnostics_upload_enabled
        || pt.cloud_sync_enabled;

    let mut rows: Vec<El> = Vec::new();

    rows.push(
        SettingsRow::new("Crash reports")
            .description(
                "Send anonymized crash stacks when the desktop client terminates unexpectedly.",
            )
            .control(
                Switch::new(pt.crash_reports_enabled)
                    .label("Crash reports")
                    .hide_label()
                    .on_toggle(|s: &mut AppState| {
                        dispatch_privacy_patch(s, |p| {
                            p.crash_reports_enabled = !p.crash_reports_enabled;
                        });
                    })
                    .build(k),
            )
            .build(k, t),
    );

    rows.push(
        SettingsRow::new("Product analytics")
            .description("Share aggregate feature usage events without file contents or prompts.")
            .control(
                Switch::new(pt.product_analytics_enabled)
                    .label("Product analytics")
                    .hide_label()
                    .on_toggle(|s: &mut AppState| {
                        dispatch_privacy_patch(s, |p| {
                            p.product_analytics_enabled = !p.product_analytics_enabled;
                        });
                    })
                    .build(k),
            )
            .build(k, t),
    );

    rows.push(
        SettingsRow::new("AI trace metadata")
            .description("Record latency, token counts, and tool error summaries for reliability diagnostics.")
            .control(
                Switch::new(pt.ai_trace_telemetry_enabled)
                    .label("AI trace metadata")
                    .hide_label()
                    .on_toggle(|s: &mut AppState| {
                        dispatch_privacy_patch(s, |p| {
                            p.ai_trace_telemetry_enabled = !p.ai_trace_telemetry_enabled;
                        });
                    })
                    .build(k),
            )
            .build(k, t),
    );

    rows.push(
        SettingsRow::new("AI trace payloads")
            .description(
                "Include prompt and tool payload samples in AI traces. Requires AI trace metadata.",
            )
            .control(
                Switch::new(pt.ai_trace_payloads_enabled)
                    .label("AI trace payloads")
                    .hide_label()
                    .disabled(!pt.ai_trace_telemetry_enabled)
                    .on_toggle(|s: &mut AppState| {
                        dispatch_privacy_patch(s, |p| {
                            if p.ai_trace_telemetry_enabled {
                                p.ai_trace_payloads_enabled = !p.ai_trace_payloads_enabled;
                            }
                        });
                    })
                    .build(k),
            )
            .build(k, t),
    );

    rows.push(
        SettingsRow::new("Diagnostics bundle uploads")
            .description("Allow uploading generated diagnostic bundles when requesting support.")
            .control(
                Switch::new(pt.diagnostics_upload_enabled)
                    .label("Diagnostics bundle uploads")
                    .hide_label()
                    .on_toggle(|s: &mut AppState| {
                        dispatch_privacy_patch(s, |p| {
                            p.diagnostics_upload_enabled = !p.diagnostics_upload_enabled;
                        });
                    })
                    .build(k),
            )
            .build(k, t),
    );

    rows.push(
        SettingsRow::new("Cloud preferences sync")
            .description("Sync desktop settings and model preferences across signed-in devices.")
            .control(
                Switch::new(pt.cloud_sync_enabled)
                    .label("Cloud preferences sync")
                    .hide_label()
                    .on_toggle(|s: &mut AppState| {
                        dispatch_privacy_patch(s, |p| {
                            p.cloud_sync_enabled = !p.cloud_sync_enabled;
                        });
                    })
                    .build(k),
            )
            .build(k, t),
    );

    let reset_btn = Button::new("Disable all")
        .variant(ButtonVariant::Outline)
        .control_size(ControlSize::Regular)
        .disabled(!any_telemetry)
        .on_press(|s: &mut AppState| {
            update_desktop_settings(s, |next| {
                next.privacy_telemetry = PrivacyTelemetrySettings::default();
            });
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

    PageContent::simple(settings_page(blocks))
}
