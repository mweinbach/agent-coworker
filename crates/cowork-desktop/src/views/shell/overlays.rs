//! Top-level shell overlays: Toast stack (with OperationFeedback inline claim
//! suppression), External URL modal, Confirm Dialog, LM Studio prompt, and Onboarding.

use cowork_protocol::CreationRepairAction;
use rune::{El, ScrollSpec, col, el, icon, row, spacer, text};
use rune_kit::{Badge, Button, ButtonVariant, Card, ControlSize, Dialog, Kit, Toast, ToastRegion};

use crate::actions::{Action, NativeAction, NavAction, ShellAction};
use crate::router::{SettingsPageId, ViewId};
use crate::state::{AppState, ConfirmDialogRequest, NotificationTone, dismiss_toast};
use crate::theme::ThemeTokens;

use super::{icons, palette};

/// Collect all shell-managed overlays plus subview overlays for `rune_kit::root`.
pub fn build_overlays(
    s: &AppState,
    k: &Kit,
    t: &ThemeTokens,
    mut subview_overlays: Vec<El>,
) -> Vec<El> {
    if let Some(pal) = palette::build_command_palette(s, k, t) {
        subview_overlays.push(pal);
    }

    if let Some(onboarding) = build_onboarding_overlay(s, k, t) {
        subview_overlays.push(onboarding);
    }

    if let Some(lm) = build_lmstudio_start_modal(s, k, t) {
        subview_overlays.push(lm);
    }

    if let Some(ext) = build_external_url_dialog(s.pending_external_url.as_deref(), k, t) {
        subview_overlays.push(ext);
    }

    if let Some(confirm) = build_confirm_dialog(s.pending_confirm_dialog.as_ref(), k) {
        subview_overlays.push(confirm);
    }

    if let Some(toasts) = build_toast_region(s, k, t) {
        subview_overlays.push(toasts);
    }

    subview_overlays
}

fn is_toast_claimed_inline(s: &AppState, toast_key: &str) -> bool {
    let Some(op) = s.operations_by_key.get(toast_key) else {
        return false;
    };
    op.busy && op.error.is_none()
}

fn build_toast_region(s: &AppState, k: &Kit, t: &ThemeTokens) -> Option<El> {
    let visible: Vec<_> = s
        .toasts
        .iter()
        .filter(|toast| !is_toast_claimed_inline(s, &toast.key))
        .collect();

    if visible.is_empty() {
        return None;
    }

    let mut region = ToastRegion::new();
    for toast in visible.into_iter().take(5) {
        let key_for_close = toast.key.clone();
        let (glyph, tint) = match toast.tone {
            NotificationTone::Success => (&icons::CHECK_CIRCLE, t.success),
            NotificationTone::Warning => (&icons::ALERT_TRIANGLE, t.warning),
            NotificationTone::Error => (&icons::ALERT_TRIANGLE, t.danger),
            NotificationTone::Info => (&icons::INFO, t.info),
        };
        let mut built = Toast::new(toast.key.clone(), toast.title.clone())
            .icon(k, glyph)
            .on_close(move |s: &mut AppState| {
                dismiss_toast(s, key_for_close.clone());
            });
        if let Some(desc) = toast.description.as_deref() {
            built = built.description(desc);
        }
        let el_toast = built.build(k).border(1.0, tint);
        region = region.toast(el_toast);
    }

    Some(region.build(k))
}

pub(crate) fn extract_external_url_domain(raw_url: &str) -> String {
    match url::Url::parse(raw_url) {
        Ok(parsed) => parsed
            .host_str()
            .filter(|host| !host.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| parsed.scheme().to_owned()),
        Err(_) => "unknown destination".to_owned(),
    }
}

fn build_external_url_dialog(url: Option<&str>, k: &Kit, t: &ThemeTokens) -> Option<El> {
    let url = url?;
    let mut overlays = Vec::new();
    let domain = extract_external_url_domain(url);

    Dialog::new("confirm-external-url-dialog", "Open external link?")
        .description(format!(
            "Review the destination domain ({domain}) before opening in your browser."
        ))
        .open(true)
        .width(440.0)
        .click_outside(true)
        .on_close(|s: &mut AppState| {
            s.dispatch(Action::Shell(ShellAction::DismissExternalUrl));
        })
        .child(
            col()
                .gap(12.0)
                .child(
                    el().w_full()
                        .px(10.0)
                        .py(8.0)
                        .radius(6.0)
                        .fill(t.elevated_bg)
                        .border(1.0, t.border_muted)
                        .child(text(url).font(t.code).color(t.text_base).wrap()),
                )
                .child(
                    row()
                        .w_full()
                        .gap(8.0)
                        .child(spacer())
                        .child(
                            Button::new("Cancel")
                                .variant(ButtonVariant::Ghost)
                                .on_press_tx(|s: &mut AppState, _| {
                                    s.dispatch(Action::Shell(ShellAction::DismissExternalUrl));
                                })
                                .build(k),
                        )
                        .child(
                            Button::new("Open link")
                                .variant(ButtonVariant::Contrast)
                                .icon(&icons::EXTERNAL_LINK)
                                .on_press_tx(|s: &mut AppState, _| {
                                    s.dispatch(Action::Shell(ShellAction::ConfirmExternalUrl));
                                })
                                .build(k),
                        ),
                ),
        )
        .build(k, &mut overlays);

    overlays.into_iter().next()
}

fn build_confirm_dialog(pending: Option<&ConfirmDialogRequest>, k: &Kit) -> Option<El> {
    let pending = pending?;
    let mut overlays = Vec::new();
    let confirm_variant = if pending.destructive {
        ButtonVariant::Danger
    } else {
        ButtonVariant::Contrast
    };
    let confirm_label = if pending.confirm_label.is_empty() {
        "Confirm".to_owned()
    } else {
        pending.confirm_label.clone()
    };
    let cancel_label = if pending.cancel_label.is_empty() {
        "Cancel".to_owned()
    } else {
        pending.cancel_label.clone()
    };

    let id_close = pending.id.clone();
    let id_cancel = pending.id.clone();
    let id_confirm = pending.id.clone();

    let mut dlg = Dialog::new("shell-confirm-dialog", pending.title.clone())
        .open(true)
        .width(420.0)
        .click_outside(true)
        .on_close(move |s: &mut AppState| {
            s.dispatch(Action::Shell(ShellAction::ResolveConfirmDialog {
                id: id_close.clone(),
                confirmed: false,
            }));
        })
        .child(
            row()
                .w_full()
                .pt(8.0)
                .gap(8.0)
                .child(spacer())
                .child(
                    Button::new(cancel_label)
                        .variant(ButtonVariant::Ghost)
                        .on_press_tx(move |s: &mut AppState, _| {
                            s.dispatch(Action::Shell(ShellAction::ResolveConfirmDialog {
                                id: id_cancel.clone(),
                                confirmed: false,
                            }));
                        })
                        .build(k),
                )
                .child(
                    Button::new(confirm_label)
                        .variant(confirm_variant)
                        .on_press_tx(move |s: &mut AppState, _| {
                            s.dispatch(Action::Shell(ShellAction::ResolveConfirmDialog {
                                id: id_confirm.clone(),
                                confirmed: true,
                            }));
                        })
                        .build(k),
                ),
        );

    if !pending.message.is_empty() {
        dlg = dlg.description(pending.message.clone());
    }

    dlg.build(k, &mut overlays);
    overlays.into_iter().next()
}

fn build_lmstudio_start_modal(s: &AppState, k: &Kit, t: &ThemeTokens) -> Option<El> {
    let modal = s.lmstudio_start_modal.as_ref()?;

    let mut overlays = Vec::new();
    let desc = match modal.base_url.as_deref() {
        Some(url) if !url.is_empty() => format!(
            "LM Studio local inference at {url} is configured, but the local server is not running."
        ),
        _ => "LM Studio local inference is configured, but the local server does not appear to be running.".to_owned(),
    };

    let mut body = col().gap(12.0);
    if let Some(err) = modal.error.as_deref() {
        body = body.child(
            el().w_full()
                .padding(10.0)
                .radius(6.0)
                .fill(t.elevated_bg)
                .border(1.0, t.danger)
                .child(text(err).font(t.caption).color(t.danger).wrap()),
        );
    }

    let ws_for_start = Some(modal.workspace_id.clone());
    let base_url = modal
        .base_url
        .clone()
        .unwrap_or_else(|| "http://127.0.0.1:1234/v1".to_owned());

    body = body.child(
        row()
            .w_full()
            .gap(8.0)
            .child(
                Button::new("Provider settings")
                    .variant(ButtonVariant::Ghost)
                    .control_size(ControlSize::Small)
                    .on_press_tx(|s: &mut AppState, _| {
                        s.dispatch(Action::Shell(ShellAction::DismissLmStudioStartModal));
                        s.dispatch(Action::Navigate(NavAction::OpenSettingsIntent {
                            page: SettingsPageId::Models,
                            tab: None,
                            section: None,
                            new_provider: false,
                        }));
                    })
                    .build(k),
            )
            .child(spacer())
            .child(
                Button::new("Cancel")
                    .variant(ButtonVariant::Ghost)
                    .on_press_tx(|s: &mut AppState, _| {
                        s.dispatch(Action::Shell(ShellAction::DismissLmStudioStartModal));
                    })
                    .build(k),
            )
            .child(
                Button::new(if modal.starting {
                    "Starting..."
                } else {
                    "Start LM Studio"
                })
                .variant(ButtonVariant::Contrast)
                .disabled(modal.starting)
                .on_press_tx(move |s: &mut AppState, _| {
                    s.dispatch(Action::Shell(ShellAction::RepairCreationReadiness {
                        action: CreationRepairAction::StartLmStudio {
                            base_url: base_url.clone(),
                            can_auto_start: true,
                        },
                        workspace_id: ws_for_start.clone(),
                    }));
                    s.dispatch(Action::Shell(ShellAction::DismissLmStudioStartModal));
                })
                .build(k),
            ),
    );

    Dialog::new("lmstudio-start-dialog", "Start LM Studio server?")
        .description(desc)
        .open(true)
        .width(440.0)
        .click_outside(true)
        .on_close(|s: &mut AppState| {
            s.dispatch(Action::Shell(ShellAction::DismissLmStudioStartModal));
        })
        .child(body)
        .build(k, &mut overlays);

    overlays.into_iter().next()
}

pub(crate) fn is_onboarding_visible(s: &AppState) -> bool {
    !s.scene_mode
        && s.route().view != ViewId::Settings
        && !s.onboarding.completed
        && !s.onboarding.dismissed
}

fn build_onboarding_overlay(s: &AppState, k: &Kit, t: &ThemeTokens) -> Option<El> {
    if !is_onboarding_visible(s) {
        return None;
    }

    let step_idx = s.onboarding.completed_steps.len().min(4);
    let step_titles = [
        ("1. Choose a project folder", &icons::FOLDER_PLUS),
        ("2. Connect a model provider", &icons::SPARKLES),
        ("3. Explore skills & tools", &icons::PLUGINS),
        ("4. Quick Chat & palette shortcuts", &icons::TERMINAL),
        ("5. Ready to work together", &icons::CHECK_CIRCLE),
    ];

    let has_ws = !s.workspaces.is_empty();
    let configured_providers = s.provider_catalog.iter().filter(|p| p.configured).count();

    let (title, glyph) = step_titles[step_idx];
    let step_cards = row()
        .w_full()
        .gap(6.0)
        .children(step_titles.iter().enumerate().map(|(i, _)| {
            let active = i == step_idx;
            let done = i < step_idx;
            let badge_txt = if done {
                format!("✓ {}", i + 1)
            } else {
                format!("{}", i + 1)
            };
            el().key(format!("ob-step-{i}"))
                .grow(1.0)
                .h(26.0)
                .radius(6.0)
                .center()
                .fill(if active { t.accent_soft } else { t.elevated_bg })
                .border(1.0, if active { t.accent } else { t.border_muted })
                .child(text(badge_txt).font(t.caption).color(if active {
                    t.text_base
                } else {
                    t.text_muted
                }))
        }));

    let mut content_col = col().gap(12.0).child(step_cards);

    let step_body = match step_idx {
        0 => Card::new()
            .accent(t.accent)
            .title(title, Some(glyph))
            .description(
                "Add a folder from your computer so Antigravity can launch an isolated workspace runtime.",
            )
            .child(
                row()
                    .gap(8.0)
                    .center_y()
                    .child(Badge::new(if has_ws {
                        "Workspace added"
                    } else {
                        "No folder selected yet"
                    })
                    .build(k)),
            )
            .action(
                Button::new("Add project folder")
                    .variant(ButtonVariant::Contrast)
                    .icon(&icons::FOLDER_PLUS)
                    .on_press_tx(|s: &mut AppState, _| {
                        s.dispatch(Action::Native(NativeAction::PickWorkspaceFolder));
                    })
                    .build(k),
            )
            .build(k),
        1 => Card::new()
            .accent(t.accent)
            .title(title, Some(glyph))
            .description(
                "Sign in with OpenAI, Anthropic, Google, or a local model server such as LM Studio.",
            )
            .child(Badge::new(format!("{configured_providers} configured provider(s)")).build(k))
            .action(
                Button::new("Configure providers")
                    .variant(ButtonVariant::Contrast)
                    .icon(&icons::SETTINGS)
                    .on_press_tx(|s: &mut AppState, _| {
                        s.dispatch(Action::Navigate(NavAction::OpenSettingsIntent {
                            page: SettingsPageId::Models,
                            tab: None,
                            section: None,
                            new_provider: false,
                        }));
                    })
                    .build(k),
            )
            .build(k),
        2 => Card::new()
            .accent(t.accent)
            .title(title, Some(glyph))
            .description(
                "Connect MCP servers, skills, and plugins anytime from Tool Access settings.",
            )
            .action(
                Button::new("Browse Tool Access")
                    .variant(ButtonVariant::Ghost)
                    .icon(&icons::PLUGINS)
                    .on_press_tx(|s: &mut AppState, _| {
                        s.dispatch(Action::Navigate(NavAction::OpenSettingsIntent {
                            page: SettingsPageId::ToolAccess,
                            tab: None,
                            section: None,
                            new_provider: false,
                        }));
                    })
                    .build(k),
            )
            .build(k),
        3 => Card::new()
            .accent(t.accent)
            .title(title, Some(glyph))
            .description(
                "Press Cmd/Ctrl+K anywhere for the Command Palette, Cmd/Ctrl+B for sidebar, and Cmd/Ctrl+Shift+Space for Quick Chat.",
            )
            .build(k),
        _ => Card::new()
            .accent(t.success)
            .title(title, Some(glyph))
            .description(
                "Your native Rust workspace shell is ready. Open a new chat or create a task whenever you're ready.",
            )
            .build(k),
    };

    content_col = content_col.child(step_body);

    let step_name = format!("step-{}", step_idx + 1);
    let next_btn = if step_idx >= 4 {
        Button::new("Finish setup")
            .variant(ButtonVariant::Contrast)
            .on_press_tx(|s: &mut AppState, _| {
                s.dispatch(Action::Shell(ShellAction::SkipOnboarding));
            })
            .build(k)
    } else {
        Button::new("Next")
            .variant(ButtonVariant::Contrast)
            .on_press_tx(move |s: &mut AppState, _| {
                s.dispatch(Action::Shell(ShellAction::CompleteOnboardingStep(
                    step_name.clone(),
                )));
            })
            .build(k)
    };

    let footer = row()
        .w_full()
        .pt(8.0)
        .gap(8.0)
        .child(
            Button::new("Skip onboarding")
                .variant(ButtonVariant::Ghost)
                .on_press_tx(|s: &mut AppState, _| {
                    s.dispatch(Action::Shell(ShellAction::SkipOnboarding));
                })
                .build(k),
        )
        .child(spacer())
        .child(next_btn);

    let card = col()
        .key("desktop-onboarding-card")
        .w(560.0)
        .max_h(560.0)
        .padding(20.0)
        .gap(16.0)
        .radius(14.0)
        .fill(t.popover_bg)
        .border(1.0, t.border_strong)
        .child(
            row()
                .w_full()
                .center_y()
                .child(icon(&icons::SPARKLES, 18.0).color(t.accent))
                .child(el().w(8.0))
                .child(
                    text("Welcome to Antigravity")
                        .font(t.title)
                        .color(t.text_base),
                )
                .child(spacer())
                .child(Badge::new(format!("Step {} / 5", step_idx + 1)).build(k)),
        )
        .child(
            col()
                .w_full()
                .max_h(360.0)
                .scroll(ScrollSpec {
                    stick_bottom: false,
                })
                .child(content_col),
        )
        .child(footer);

    Some(
        el().key("desktop-onboarding-backdrop")
            .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
            .fill(t.scrim)
            .center()
            .padding(24.0)
            .modal(false, |_: &mut AppState| {})
            .child(card),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::actions::{Action, NavAction};

    #[test]
    fn onboarding_hidden_in_scene_mode_and_settings() {
        let mut s = AppState::default();
        assert!(is_onboarding_visible(&s));

        s.scene_mode = true;
        assert!(!is_onboarding_visible(&s));
        s.scene_mode = false;

        s.dispatch(Action::Navigate(NavAction::OpenSettings(Some(
            SettingsPageId::Models,
        ))));
        assert!(!is_onboarding_visible(&s));

        s.dispatch(Action::Navigate(NavAction::GoBack));
        assert!(is_onboarding_visible(&s));

        s.onboarding.dismissed = true;
        assert!(!is_onboarding_visible(&s));
    }

    #[test]
    fn external_url_domain_strips_userinfo_query_and_fragment() {
        assert_eq!(
            extract_external_url_domain("https://trusted.com@evil.com/path"),
            "evil.com"
        );
        assert_eq!(
            extract_external_url_domain("https://user:pass@evil.com:8443?next=trusted.com#frag"),
            "evil.com"
        );
        assert_eq!(
            extract_external_url_domain("https://example.org?redirect=evil.com"),
            "example.org"
        );
        assert_eq!(
            extract_external_url_domain("https://example.org#trusted.com"),
            "example.org"
        );
        assert_eq!(
            extract_external_url_domain("mailto:user@example.com"),
            "mailto"
        );
        assert_eq!(
            extract_external_url_domain("not a url"),
            "unknown destination"
        );
    }
}
