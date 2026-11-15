//! Desktop settings page (`apps/desktop/src/ui/settings/pages/DesktopPage.tsx`).

use rune::{El, col, el, row, text};
use rune_kit::{Button, ButtonVariant, ControlSize, Kit, Switch};

use crate::actions::{Action, ShellAction};
use crate::state::AppState;
use crate::theme::{ThemePreference, ThemeTokens};
use crate::views::settings::experiments::is_flag_enabled;
use crate::views::settings::primitives::{
    Section, SettingsRow, settings_page, update_desktop_settings,
};
use crate::views::settings::shell::PageContent;

/// Canonical default Quick Chat global accelerator matching Electron `quickChatShortcut.ts`.
pub const DEFAULT_QUICK_CHAT_SHORTCUT_ACCELERATOR: &str = "CommandOrControl+Shift+Space";

/// Formats an Electron accelerator string into a human-friendly platform shortcut badge.
pub fn format_quick_chat_shortcut_label(accelerator: &str) -> String {
    let trimmed = accelerator.trim();
    if trimmed.is_empty() {
        return "Unset".to_string();
    }

    let mac = cfg!(target_os = "macos");
    let parts: Vec<String> = trimmed
        .split('+')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(|part| match part.to_ascii_lowercase().as_str() {
            "commandorcontrol" | "cmdorctrl" | "command" | "cmd" | "super" | "meta" => {
                if mac { "⌘" } else { "Ctrl" }.to_string()
            }
            "control" | "ctrl" => if mac { "⌃" } else { "Ctrl" }.to_string(),
            "alt" | "option" => if mac { "⌥" } else { "Alt" }.to_string(),
            "shift" => if mac { "⇧" } else { "Shift" }.to_string(),
            "space" => "Space".to_string(),
            "arrowup" | "up" => "↑".to_string(),
            "arrowdown" | "down" => "↓".to_string(),
            "arrowleft" | "left" => "←".to_string(),
            "arrowright" | "right" => "→".to_string(),
            other if other.len() == 1 => other.to_ascii_uppercase(),
            _ => part.to_string(),
        })
        .collect();

    if mac {
        parts.join(" ")
    } else {
        parts.join("+")
    }
}

fn theme_button(label: &str, pref: ThemePreference, active: bool, k: &Kit) -> El {
    Button::new(label)
        .variant(if active {
            ButtonVariant::Contrast
        } else {
            ButtonVariant::Outline
        })
        .control_size(ControlSize::Regular)
        .on_press(move |s: &mut AppState| {
            s.dispatch(Action::Shell(ShellAction::SetTheme(pref)));
        })
        .build(k)
}

/// Renders the Desktop settings page.
pub fn view(s: &AppState, k: &Kit, t: &ThemeTokens) -> PageContent {
    let ds = &s.desktop_settings;
    let menu_bar_available = is_flag_enabled(s, "menuBar");
    let shortcut_label = format_quick_chat_shortcut_label(&ds.quick_chat_shortcut);
    let is_default_shortcut =
        ds.quick_chat_shortcut.trim() == DEFAULT_QUICK_CHAT_SHORTCUT_ACCELERATOR;

    let open_quick_chat_btn = Button::new("Open quick chat")
        .variant(ButtonVariant::Outline)
        .control_size(ControlSize::Regular)
        .on_press(|s: &mut AppState| {
            s.dispatch(Action::Shell(ShellAction::SetQuickChatOpen(true)));
        })
        .build(k);

    let mut quick_chat_section = Section::new()
        .title("Quick chat")
        .description("Open the lighter-weight floating chat surface without bringing the full app window forward.")
        .action(open_quick_chat_btn);

    let icon_row = SettingsRow::new("Show quick chat icon")
        .description(
            "Keep the compact popup available from the macOS menu bar or Windows system tray.",
        )
        .control(
            Switch::new(ds.quick_chat_icon_enabled)
                .label("Show quick chat icon")
                .hide_label()
                .disabled(!menu_bar_available)
                .on_toggle(|s: &mut AppState| {
                    update_desktop_settings(s, |next| {
                        next.quick_chat_icon_enabled = !next.quick_chat_icon_enabled;
                    });
                })
                .build(k),
        );
    let icon_row = if !menu_bar_available {
        icon_row.meta(if s.is_packaged {
            "Quick chat icon support is unavailable in this build."
        } else {
            "Enable the Menu bar / tray feature flag to show the icon."
        })
    } else {
        icon_row
    };
    quick_chat_section = quick_chat_section.child(icon_row.build(k, t));

    if menu_bar_available {
        quick_chat_section = quick_chat_section.child(
            SettingsRow::new("Enable global shortcut")
                .description(format!("Shortcut: {shortcut_label}"))
                .control(
                    Switch::new(ds.quick_chat_shortcut_enabled)
                        .label("Enable quick chat shortcut")
                        .hide_label()
                        .on_toggle(|s: &mut AppState| {
                            update_desktop_settings(s, |next| {
                                next.quick_chat_shortcut_enabled =
                                    !next.quick_chat_shortcut_enabled;
                            });
                        })
                        .build(k),
                )
                .build(k, t),
        );

        let shortcut_chip = el()
            .w_full()
            .max_w(360.0)
            .px(12.0)
            .py(8.0)
            .radius(8.0)
            .fill(t.input_bg)
            .border(1.0, t.border)
            .child(text(shortcut_label.clone()).font(t.code).color(t.text_base));

        let reset_btn = Button::new("Use default")
            .variant(ButtonVariant::Outline)
            .control_size(ControlSize::Regular)
            .disabled(is_default_shortcut)
            .on_press(|s: &mut AppState| {
                update_desktop_settings(s, |next| {
                    next.quick_chat_shortcut = DEFAULT_QUICK_CHAT_SHORTCUT_ACCELERATOR.to_string();
                });
            })
            .build(k);

        let shortcut_body = col()
            .w_full()
            .gap(10.0)
            .child(shortcut_chip)
            .child(row().gap(8.0).flex_wrap().child(reset_btn))
            .child(
                text(
                    "If macOS or Windows already uses the combination, Cowork may not receive it.",
                )
                .font(k.ty.text_xsmall)
                .color(t.text_muted)
                .wrap(),
            );

        quick_chat_section = quick_chat_section.child(
            SettingsRow::new("Change shortcut")
                .description("Global accelerator registered for summoning the Quick Chat window.")
                .body(shortcut_body)
                .build(k, t),
        );
    }

    let appearance_section = Section::new()
        .title("Appearance & motion")
        .description("Customize window appearance, contrast, and motion across desktop surfaces.")
        .child(
            SettingsRow::new("Theme")
                .description("Follow your OS color scheme or force light or dark appearance.")
                .control(
                    row()
                        .gap(6.0)
                        .child(theme_button(
                            "System",
                            ThemePreference::System,
                            ds.theme == ThemePreference::System,
                            k,
                        ))
                        .child(theme_button(
                            "Light",
                            ThemePreference::Light,
                            ds.theme == ThemePreference::Light,
                            k,
                        ))
                        .child(theme_button(
                            "Dark",
                            ThemePreference::Dark,
                            ds.theme == ThemePreference::Dark,
                            k,
                        )),
                )
                .build(k, t),
        )
        .child(
            SettingsRow::new("Reduce transparency")
                .description(
                    "Use solid opaque sidebar and overlay fills in place of translucent glass.",
                )
                .control(
                    Switch::new(ds.reduced_transparency)
                        .label("Reduce transparency")
                        .hide_label()
                        .on_toggle(|s: &mut AppState| {
                            update_desktop_settings(s, |next| {
                                next.reduced_transparency = !next.reduced_transparency;
                            });
                        })
                        .build(k),
                )
                .build(k, t),
        )
        .child(
            SettingsRow::new("High contrast")
                .description(
                    "Increase borders and surface separation for stronger visual contrast.",
                )
                .control(
                    Switch::new(ds.high_contrast)
                        .label("High contrast")
                        .hide_label()
                        .on_toggle(|s: &mut AppState| {
                            update_desktop_settings(s, |next| {
                                next.high_contrast = !next.high_contrast;
                            });
                        })
                        .build(k),
                )
                .build(k, t),
        )
        .child(
            SettingsRow::new("Reduce motion")
                .description(
                    "Minimize spring and layout transitions throughout the desktop interface.",
                )
                .control(
                    Switch::new(ds.reduce_motion)
                        .label("Reduce motion")
                        .hide_label()
                        .on_toggle(|s: &mut AppState| {
                            update_desktop_settings(s, |next| {
                                next.reduce_motion = !next.reduce_motion;
                            });
                        })
                        .build(k),
                )
                .build(k, t),
        );

    PageContent::simple(settings_page(vec![
        quick_chat_section.build(k, t),
        appearance_section.build(k, t),
    ]))
}
