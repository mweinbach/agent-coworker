//! Updates settings page (`apps/desktop/src/ui/settings/pages/UpdatesPage.tsx`).

use rune::{El, col, row, text};
use rune_kit::{Button, ButtonVariant, ControlSize, Kit, Markdown, Progress};

use crate::actions::{Action, SettingsAction, ShellAction};
use crate::state::AppState;
use crate::theme::ThemeTokens;
use crate::views::settings::primitives::{
    Section, SettingsRow, StatusTone, callout_banner, format_byte_size, settings_page, status_pill,
};
use crate::views::settings::shell::PageContent;

/// Restricts release notes markdown links to safe external URL schemes.
pub fn is_allowed_release_link(raw_url: &str) -> bool {
    url::Url::parse(raw_url.trim())
        .map(|parsed| matches!(parsed.scheme(), "http" | "https" | "mailto"))
        .unwrap_or(false)
}

pub(super) fn updater_status_meta(status: &str, is_packaged: bool) -> (&'static str, StatusTone) {
    match status {
        "checking" => ("Checking", StatusTone::Neutral),
        "available" => ("Update available", StatusTone::Warning),
        "downloading" => ("Downloading", StatusTone::Neutral),
        "downloaded" => ("Ready to install", StatusTone::Success),
        "up-to-date" | "not-available" => ("Up to date", StatusTone::Success),
        "disabled" => (
            if is_packaged {
                "Unavailable"
            } else {
                "Not available in dev mode"
            },
            StatusTone::Neutral,
        ),
        "unavailable" => ("Unavailable", StatusTone::Neutral),
        "error" => ("Error", StatusTone::Danger),
        _ => ("Idle", StatusTone::Neutral),
    }
}

/// Renders the Updates settings page.
pub fn view(s: &AppState, k: &Kit, t: &ThemeTokens) -> PageContent {
    let updater = &s.updater;
    let status = updater.status.trim();
    let is_packaged = s.is_packaged || updater.packaged;
    let is_busy = status == "checking" || status == "downloading";
    let is_disabled = status == "disabled" || status == "unavailable";
    let (status_label, status_tone) = updater_status_meta(status, is_packaged);

    let check_btn = Button::new(if status == "checking" {
        "Checking..."
    } else {
        "Check for updates"
    })
    .variant(ButtonVariant::Outline)
    .control_size(ControlSize::Regular)
    .disabled(is_busy || is_disabled)
    .on_press(|s: &mut AppState| {
        s.dispatch(Action::Settings(SettingsAction::CheckUpdates));
    })
    .build(k)
    .key("updates-check-btn");

    let mut header_actions = Vec::new();
    if status == "available" {
        header_actions.push(
            Button::new("Download update")
                .variant(ButtonVariant::Contrast)
                .control_size(ControlSize::Regular)
                .on_press(|s: &mut AppState| {
                    s.dispatch(Action::Settings(SettingsAction::DownloadUpdate));
                })
                .build(k),
        );
    } else if status == "downloaded" {
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

    let current_version = if updater.current_version.trim().is_empty() {
        env!("CARGO_PKG_VERSION")
    } else {
        updater.current_version.trim()
    };
    let build_mode = if is_packaged {
        "Packaged desktop build"
    } else {
        "Development build"
    };

    let available_ver = updater
        .available_version
        .as_deref()
        .or(updater.version.as_deref())
        .filter(|ver| !ver.trim().is_empty());
    let available_detail = match available_ver {
        Some(ver) => format!("Latest detected version: v{ver}"),
        None if status == "disabled" && !is_packaged => {
            "This is a development build, so in-app update checks are disabled.".to_string()
        }
        None if is_disabled => {
            "Automatic in-app updates are unavailable for this build.".to_string()
        }
        None => "Automatic updates check release channels when packaged.".to_string(),
    };

    let version_row = SettingsRow::new(format!("Cowork Desktop v{current_version}"))
        .description(build_mode)
        .control(status_pill(status_label, status_tone, k, t))
        .build(k, t);

    let mut install_control = row().items_center().gap(8.0);
    if status == "available" {
        install_control = install_control.child(
            Button::new("Download update")
                .variant(ButtonVariant::Contrast)
                .control_size(ControlSize::Regular)
                .on_press(|s: &mut AppState| {
                    s.dispatch(Action::Settings(SettingsAction::DownloadUpdate));
                })
                .build(k),
        );
    } else if status == "downloaded" {
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
            } else if is_disabled {
                "Unavailable"
            } else {
                "No pending restart"
            })
            .font(k.ty.text_xsmall)
            .color(t.text_muted),
        );
    }

    let mut channel_row = SettingsRow::new("Release status")
        .description(available_detail)
        .control(install_control);

    if status == "downloading" {
        let fraction = updater
            .download_progress
            .map(|p| if p > 1.0 { p / 100.0 } else { p }.clamp(0.0, 1.0))
            .or_else(|| match (updater.downloaded_bytes, updater.total_bytes) {
                (Some(done), Some(total)) if total > 0 => {
                    Some((done as f32 / total as f32).clamp(0.0, 1.0))
                }
                _ => None,
            });
        let progress_caption = match (
            updater.downloaded_bytes,
            updater.total_bytes,
            updater.bytes_per_second,
        ) {
            (Some(done), Some(total), Some(bps)) => format!(
                "{} / {} · {}/s",
                format_byte_size(done),
                format_byte_size(total),
                format_byte_size(bps)
            ),
            (Some(done), Some(total), None) => {
                format!("{} / {}", format_byte_size(done), format_byte_size(total))
            }
            (Some(done), None, Some(bps)) => {
                format!("{} · {}/s", format_byte_size(done), format_byte_size(bps))
            }
            _ => "Downloading update package...".to_string(),
        };
        channel_row = channel_row.body(
            col().w_full().gap(6.0).child(
                Progress::new(fraction)
                    .label(progress_caption)
                    .show_value()
                    .build(k),
            ),
        );
    }

    blocks.push(
        Section::new()
            .title("Application updates")
            .description("App version status and restart-based installer controls.")
            .child(version_row)
            .child(channel_row.build(k, t))
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
                    rune::el().w_full().px(16.0).py(14.0).child(
                        Markdown::new(notes)
                            .selectable(true)
                            .on_link(|s: &mut AppState, url| {
                                if is_allowed_release_link(url) {
                                    s.dispatch(Action::Shell(ShellAction::RequestExternalUrl(
                                        url.trim().to_string(),
                                    )));
                                }
                            })
                            .build(k),
                    ),
                )
                .build(k, t),
        );
    }

    PageContent::simple(settings_page(blocks)).with_header_actions(header_actions)
}
