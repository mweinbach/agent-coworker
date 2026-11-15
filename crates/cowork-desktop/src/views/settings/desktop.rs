//! Desktop settings page (`apps/desktop/src/ui/settings/pages/DesktopPage.tsx`).

use std::str::FromStr;

use rune::{Shortcut, col, el, row, text};
use rune_kit::{
    Button, ButtonVariant, ControlSize, Kit, SegmentedControl, ShortcutRecorder,
    ShortcutRecorderState,
};

use crate::actions::{Action, SettingsAction, ShellAction};
use crate::state::AppState;
use crate::theme::{self, AccentPalette, ThemePreference, ThemeTokens};
use crate::views::settings::experiments::is_flag_enabled;
use crate::views::settings::primitives::{
    Section, SettingsRow, StatusTone, callout_banner, mini_switch, settings_page,
    update_desktop_settings,
};
use crate::views::settings::shell::PageContent;

/// Canonical default Quick Chat global accelerator matching Electron `quickChatShortcut.ts`.
pub const DEFAULT_QUICK_CHAT_SHORTCUT_ACCELERATOR: &str = "CommandOrControl+Shift+Space";

/// Parses an Electron-style or canonical Rune accelerator string into `rune::Shortcut`.
pub fn parse_quick_chat_accelerator(raw: &str) -> Option<Shortcut> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let normalized = trimmed
        .split('+')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(|part| {
            let lower = part.to_ascii_lowercase();
            match lower.as_str() {
                "commandorcontrol" | "cmdorctrl" => "mod".to_string(),
                "command" | "cmd" => "super".to_string(),
                _ => lower,
            }
        })
        .collect::<Vec<_>>()
        .join("+");
    Shortcut::from_str(&normalized).ok()
}

/// Converts a recorded `rune::Shortcut` into a normalized accelerator string compatible
/// with both `parse_quick_chat_accelerator` and Electron's shortcut registry.
pub fn shortcut_to_accelerator(shortcut: &Shortcut) -> String {
    let mods = shortcut.modifiers();
    let mut parts: Vec<String> = Vec::new();
    if mods.cmd {
        parts.push("CommandOrControl".to_string());
    }
    if mods.ctrl && (!mods.cmd || cfg!(target_os = "macos")) {
        parts.push("Control".to_string());
    }
    if mods.logo && !cfg!(target_os = "macos") {
        parts.push("Super".to_string());
    }
    if mods.alt {
        parts.push("Option".to_string());
    }
    if mods.shift {
        parts.push("Shift".to_string());
    }
    let raw = shortcut.to_string();
    if let Some(key_part) = raw
        .rsplit('+')
        .next()
        .map(str::trim)
        .filter(|k| !k.is_empty())
    {
        let formatted_key = match key_part.to_ascii_lowercase().as_str() {
            "space" => "Space".to_string(),
            other if other.len() == 1 => other.to_ascii_uppercase(),
            other => other.to_string(),
        };
        parts.push(formatted_key);
    }
    parts.join("+")
}

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

fn toggle_quick_chat_icon(s: &mut AppState) {
    update_desktop_settings(s, |next| {
        next.quick_chat_icon_enabled = !next.quick_chat_icon_enabled;
    });
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
            "Keep the compact popup available from the macOS menu bar or Windows/Linux system tray.",
        )
        .control(mini_switch(
            ds.quick_chat_icon_enabled,
            "Show quick chat icon",
            !menu_bar_available,
            toggle_quick_chat_icon,
            k,
        ));
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
                .control(mini_switch(
                    ds.quick_chat_shortcut_enabled,
                    "Enable quick chat shortcut",
                    false,
                    |s: &mut AppState| {
                        update_desktop_settings(s, |next| {
                            next.quick_chat_shortcut_enabled = !next.quick_chat_shortcut_enabled;
                        });
                    },
                    k,
                ))
                .build(k, t),
        );

        let recorder_view = if s.settings_ui.quick_chat_recorder.is_recording()
            || s.settings_ui.quick_chat_recorder.error().is_some()
            || s.settings_ui.quick_chat_synced_accel.as_deref()
                == Some(ds.quick_chat_shortcut.as_str())
        {
            s.settings_ui.quick_chat_recorder.clone()
        } else {
            ShortcutRecorderState::new(parse_quick_chat_accelerator(&ds.quick_chat_shortcut))
        };

        let recorder = ShortcutRecorder::new(
            "quick-chat-shortcut-recorder",
            &recorder_view,
            |s: &mut AppState| &mut s.settings_ui.quick_chat_recorder,
        )
        .label("Quick chat global shortcut")
        .width(260.0)
        .on_change(|s: &mut AppState, next: Option<&Shortcut>, _tx| {
            let accel = next.map(shortcut_to_accelerator).unwrap_or_default();
            s.settings_ui.quick_chat_synced_accel = Some(accel.clone());
            s.settings_ui.quick_chat_shortcut_error = None;
            update_desktop_settings(s, |settings| {
                settings.quick_chat_shortcut = accel.clone();
            });
            Ok(())
        })
        .build(k);

        let reset_btn = Button::new("Use default")
            .variant(ButtonVariant::Outline)
            .control_size(ControlSize::Regular)
            .disabled(is_default_shortcut)
            .on_press(|s: &mut AppState| {
                let default_accel = DEFAULT_QUICK_CHAT_SHORTCUT_ACCELERATOR.to_string();
                s.settings_ui.quick_chat_recorder =
                    ShortcutRecorderState::new(parse_quick_chat_accelerator(&default_accel));
                s.settings_ui.quick_chat_synced_accel = Some(default_accel.clone());
                s.settings_ui.quick_chat_shortcut_error = None;
                update_desktop_settings(s, |next| {
                    next.quick_chat_shortcut = default_accel;
                });
            })
            .build(k);

        let clear_btn = Button::new("Clear")
            .variant(ButtonVariant::Ghost)
            .control_size(ControlSize::Regular)
            .disabled(ds.quick_chat_shortcut.trim().is_empty())
            .on_press(|s: &mut AppState| {
                s.settings_ui.quick_chat_recorder = ShortcutRecorderState::new(None);
                s.settings_ui.quick_chat_synced_accel = Some(String::new());
                s.settings_ui.quick_chat_shortcut_error = None;
                update_desktop_settings(s, |next| {
                    next.quick_chat_shortcut.clear();
                });
            })
            .build(k);

        let mut shortcut_body = col()
            .w_full()
            .gap(10.0)
            .child(
                row()
                    .w_full()
                    .items_center()
                    .gap(8.0)
                    .flex_wrap()
                    .child(recorder)
                    .child(reset_btn)
                    .child(clear_btn),
            )
            .child(
                text(
                    "Click the recorder and press a modifier combination. Press Escape to cancel or Backspace to clear.",
                )
                .font(k.ty.small)
                .color(t.text_muted)
                .wrap(),
            );

        if let Some(err) = s
            .quick_chat_shortcut_error
            .as_deref()
            .or(s.settings_ui.quick_chat_shortcut_error.as_deref())
            .filter(|msg| !msg.trim().is_empty())
        {
            shortcut_body = shortcut_body.child(callout_banner(StatusTone::Danger, err, k, t));
        }

        quick_chat_section = quick_chat_section.child(
            SettingsRow::new("Change shortcut")
                .description("Global accelerator registered for summoning the Quick Chat window.")
                .body(shortcut_body)
                .build(k, t),
        );
    }

    let theme_idx = match ds.theme {
        ThemePreference::System => 0,
        ThemePreference::Light => 1,
        ThemePreference::Dark => 2,
    };
    let theme_picker = SegmentedControl::new(&["System", "Light", "Dark"], Some(theme_idx))
        .label("Theme")
        .fit()
        .on_pick(|s: &mut AppState, idx, _tx| {
            let next = match idx {
                1 => ThemePreference::Light,
                2 => ThemePreference::Dark,
                _ => ThemePreference::System,
            };
            s.dispatch(Action::Shell(ShellAction::SetTheme(next)));
        })
        .build(k);

    let accent_labels: Vec<&'static str> = AccentPalette::ALL.iter().map(|p| p.label()).collect();
    let accent_idx = AccentPalette::ALL
        .iter()
        .position(|p| *p == ds.accent_palette)
        .unwrap_or(2);
    let accent_swatches =
        row()
            .items_center()
            .gap(5.0)
            .a11y_hidden()
            .children(AccentPalette::ALL.iter().map(|&palette| {
                let swatch = theme::resolve_tokens_with_accent(
                    t.dark,
                    ds.reduced_transparency,
                    ds.high_contrast,
                    palette,
                )
                .accent;
                let active = palette == ds.accent_palette;
                let dot_size = if active { 12.0 } else { 10.0 };
                el().size(dot_size, dot_size)
                    .radius(theme::layout::RADIUS_PILL)
                    .fill(swatch)
                    .border(1.0, if active { t.text_base } else { t.border_muted })
            }));
    let accent_picker = row().items_center().gap(10.0).child(accent_swatches).child(
        SegmentedControl::new(&accent_labels, Some(accent_idx))
            .label("Accent color")
            .fit()
            .on_pick(|s: &mut AppState, idx, _tx| {
                if let Some(&palette) = AccentPalette::ALL.get(idx) {
                    s.dispatch(Action::Settings(SettingsAction::SetAccentPalette(palette)));
                }
            })
            .build(k),
    );

    let appearance_section = Section::new()
        .title("Appearance & motion")
        .description("Customize window appearance, accent palette, contrast, and motion across desktop surfaces.")
        .child(
            SettingsRow::new("Theme")
                .description("Follow your OS color scheme or force light or dark appearance.")
                .control(theme_picker)
                .build(k, t),
        )
        .child(
            SettingsRow::new("Accent color")
                .description(ds.accent_palette.description())
                .control(accent_picker)
                .build(k, t),
        )
        .child(
            SettingsRow::new("Reduce transparency")
                .description(
                    "Use solid opaque sidebar and overlay fills in place of translucent glass.",
                )
                .control(mini_switch(
                    ds.reduced_transparency,
                    "Reduce transparency",
                    false,
                    |s: &mut AppState| {
                        update_desktop_settings(s, |next| {
                            next.reduced_transparency = !next.reduced_transparency;
                        });
                    },
                    k,
                ))
                .build(k, t),
        )
        .child(
            SettingsRow::new("High contrast")
                .description(
                    "Increase borders and surface separation for stronger visual contrast.",
                )
                .control(mini_switch(
                    ds.high_contrast,
                    "High contrast",
                    false,
                    |s: &mut AppState| {
                        update_desktop_settings(s, |next| {
                            next.high_contrast = !next.high_contrast;
                        });
                    },
                    k,
                ))
                .build(k, t),
        )
        .child(
            SettingsRow::new("Reduce motion")
                .description(
                    "Minimize spring and layout transitions throughout the desktop interface.",
                )
                .control(mini_switch(
                    ds.reduce_motion,
                    "Reduce motion",
                    false,
                    |s: &mut AppState| {
                        update_desktop_settings(s, |next| {
                            next.reduce_motion = !next.reduce_motion;
                        });
                    },
                    k,
                ))
                .build(k, t),
        );

    PageContent::simple(settings_page(vec![
        quick_chat_section.build(k, t),
        appearance_section.build(k, t),
    ]))
}
