//! Updates settings page (`apps/desktop/src/ui/settings/pages/UpdatesPage.tsx`).

use rune::{El, row, text};
use rune_kit::{Button, ButtonVariant, ControlSize, Kit, Markdown};

use crate::actions::{Action, SettingsAction};
use crate::state::AppState;
use crate::theme::ThemeTokens;
use crate::views::settings::primitives::{
    Section, SettingsRow, StatusTone, callout_banner, settings_page, status_pill,
};
use crate::views::settings::shell::PageContent;

fn updater_status_meta(status: &str) -> (&'static str, StatusTone) {
    match status {
        "checking" => ("Checking", StatusTone::Neutral),
        "available" => ("Update available", StatusTone::Warning),
        "downloading" => ("Downloading", StatusTone::Neutral),
        "downloaded" => ("Ready to install", StatusTone::Success),
        "up-to-date" | "not-available" => ("Up to date", StatusTone::Success),
        "error" => ("Error", StatusTone::Danger),
        _ => ("Idle", StatusTone::Neutral),
    }
}

/// Renders the Updates settings page.
pub fn view(s: &AppState, k: &Kit, t: &ThemeTokens) -> PageContent {
    let updater = &s.updater;
    let status = updater.status.trim();
    let is_busy = status == "checking" || status == "downloading";
    let (status_label, status_tone) = updater_status_meta(status);

    let check_btn = Button::new(if status == "checking" {
        "Checking..."
    } else {
        "Check for updates"
    })
    .variant(ButtonVariant::Outline)
    .control_size(ControlSize::Regular)
    .disabled(is_busy)
    .on_press(|s: &mut AppState| {
        s.dispatch(Action::Settings(SettingsAction::CheckUpdates));
    })
    .build(k);

    let mut header_actions = Vec::new();
    if status == "downloaded" {
        header_actions.push(
            Button::new("Restart to update")
                .variant(ButtonVariant::Contrast)
                .control_size(ControlSize::Regular)
                .on_press(|s: &mut AppState| {
                    s.dispatch(Action::Settings(SettingsAction::QuitAndInstallUpdate));
                })
                .build(k),
        );
    }
    header_actions.push(check_btn);

    let mut blocks: Vec<El> = Vec::new();

    if let Some(err) = updater
        .error
        .as_deref()
        .filter(|msg| !msg.trim().is_empty())
    {
        blocks.push(callout_banner(StatusTone::Danger, err, k, t));
    }

    let current_version = env!("CARGO_PKG_VERSION");
    let build_mode = if s.is_packaged {
        "Packaged desktop build"
    } else {
        "Development build"
    };

    let available_detail = match updater.version.as_deref() {
        Some(ver) if !ver.trim().is_empty() => format!("Latest detected version: v{ver}"),
        _ => "Automatic updates check release channels when packaged.".to_string(),
    };

    let version_row = SettingsRow::new(format!("Cowork Desktop v{current_version}"))
        .description(build_mode)
        .control(status_pill(status_label, status_tone, k, t))
        .build(k, t);

    let mut install_control = row().items_center().gap(8.0);
    if status == "downloaded" {
        install_control = install_control.child(
            Button::new("Restart & Install")
                .variant(ButtonVariant::Submit)
                .control_size(ControlSize::Regular)
                .on_press(|s: &mut AppState| {
                    s.dispatch(Action::Settings(SettingsAction::QuitAndInstallUpdate));
                })
                .build(k),
        );
    } else {
        install_control = install_control.child(
            text(if is_busy {
                "In progress"
            } else {
                "No pending restart"
            })
            .font(k.ty.text_xsmall)
            .color(t.text_muted),
        );
    }

    let channel_row = SettingsRow::new("Release status")
        .description(available_detail)
        .control(install_control)
        .build(k, t);

    blocks.push(
        Section::new()
            .title("Application updates")
            .description("App version status and restart-based installer controls.")
            .child(version_row)
            .child(channel_row)
            .build(k, t),
    );

    if let Some(notes) = updater
        .notes
        .as_deref()
        .filter(|raw| !raw.trim().is_empty())
    {
        blocks.push(
            Section::new()
                .title("Release notes")
                .child(
                    rune::el()
                        .w_full()
                        .px(16.0)
                        .py(14.0)
                        .child(Markdown::new(notes).selectable(true).build(k)),
                )
                .build(k, t),
        );
    }

    PageContent::simple(settings_page(blocks)).with_header_actions(header_actions)
}
