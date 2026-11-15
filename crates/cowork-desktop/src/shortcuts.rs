//! Cross-platform keyboard shortcut formatting helpers.
//!
//! Translates Electron-style accelerator strings (for example `"Cmd+N"`,
//! `"Cmd+Shift+F"`, `"Opt+Cmd+I"`, `"Cmd+1-9"`) into native UI labels:
//! compact macOS glyphs (`⌘N`, `⌘⇧F`, `⌥⌘I`, `⌘1-9`) on macOS, and
//! `Ctrl+Shift+...` notation on Linux and Windows.

/// Returns `true` when compiled for macOS (`⌘`/`⇧`/`⌥` compact glyphs).
pub const fn is_apple_platform() -> bool {
    cfg!(target_os = "macos")
}

/// Formats an Electron-style shortcut accelerator for the current OS platform.
pub fn shortcut_label(accelerator: &str) -> String {
    shortcut_label_for_platform(accelerator, is_apple_platform())
}

/// Formats an Electron-style shortcut accelerator for the specified platform.
///
/// Examples:
/// - `"Cmd+N"` -> `"⌘N"` (macOS) / `"Ctrl+N"` (non-macOS)
/// - `"Cmd+Shift+F"` -> `"⌘⇧F"` (macOS) / `"Ctrl+Shift+F"` (non-macOS)
/// - `"Alt+Cmd+I"` / `"Opt+Cmd+I"` -> `"⌥⌘I"` (macOS) / `"Alt+Ctrl+I"` (non-macOS)
/// - `"Cmd+="` -> `"⌘="` (macOS) / `"Ctrl+="` (non-macOS)
/// - `"Cmd+1-9"` -> `"⌘1-9"` (macOS) / `"Ctrl+1-9"` (non-macOS)
pub fn shortcut_label_for_platform(accelerator: &str, is_macos: bool) -> String {
    let trimmed = accelerator.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed == "+" {
        return "+".to_string();
    }

    let normalized = trimmed.replace("++", "+Plus");
    let parts: Vec<String> = normalized
        .split('+')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(|part| format_token(part, is_macos))
        .collect();

    if is_macos {
        parts.concat()
    } else {
        parts.join("+")
    }
}

fn format_token(token: &str, is_macos: bool) -> String {
    match token.to_ascii_lowercase().as_str() {
        "commandorcontrol" | "cmdorctrl" | "command" | "cmd" | "super" | "meta" => {
            if is_macos { "⌘" } else { "Ctrl" }.to_string()
        }
        "control" | "ctrl" => if is_macos { "⌃" } else { "Ctrl" }.to_string(),
        "alt" | "option" | "opt" => if is_macos { "⌥" } else { "Alt" }.to_string(),
        "shift" => if is_macos { "⇧" } else { "Shift" }.to_string(),
        "space" => "Space".to_string(),
        "enter" | "return" => if is_macos { "↵" } else { "Enter" }.to_string(),
        "esc" | "escape" => "Esc".to_string(),
        "backspace" => if is_macos { "⌫" } else { "Backspace" }.to_string(),
        "delete" | "del" => if is_macos { "⌦" } else { "Del" }.to_string(),
        "tab" => if is_macos { "⇥" } else { "Tab" }.to_string(),
        "arrowup" | "up" => "↑".to_string(),
        "arrowdown" | "down" => "↓".to_string(),
        "arrowleft" | "left" => "←".to_string(),
        "arrowright" | "right" => "→".to_string(),
        "plus" => "+".to_string(),
        "comma" => ",".to_string(),
        "period" => ".".to_string(),
        "minus" => "-".to_string(),
        "equal" => "=".to_string(),
        other if other.len() == 1 => other.to_ascii_uppercase(),
        _ => token.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_macos_and_non_macos_shortcuts() {
        let cases = [
            ("Cmd+N", "⌘N", "Ctrl+N"),
            ("Cmd+K", "⌘K", "Ctrl+K"),
            ("Cmd+.", "⌘.", "Ctrl+."),
            ("Cmd+,", "⌘,", "Ctrl+,"),
            ("Cmd+B", "⌘B", "Ctrl+B"),
            ("Cmd+I", "⌘I", "Ctrl+I"),
            ("Cmd+S", "⌘S", "Ctrl+S"),
            ("Cmd+=", "⌘=", "Ctrl+="),
            ("Cmd+-", "⌘-", "Ctrl+-"),
            ("Cmd+0", "⌘0", "Ctrl+0"),
            ("Cmd+1", "⌘1", "Ctrl+1"),
            ("Cmd+1-9", "⌘1-9", "Ctrl+1-9"),
            ("Cmd+Shift+F", "⌘⇧F", "Ctrl+Shift+F"),
            ("Opt+Cmd+I", "⌥⌘I", "Alt+Ctrl+I"),
            ("Alt+Cmd+I", "⌥⌘I", "Alt+Ctrl+I"),
            ("CmdOrCtrl+Shift+Space", "⌘⇧Space", "Ctrl+Shift+Space"),
            ("Cmd++", "⌘+", "Ctrl++"),
            ("   ", "", ""),
        ];

        for (accel, expected_mac, expected_other) in cases {
            assert_eq!(
                shortcut_label_for_platform(accel, true),
                expected_mac,
                "macOS mismatch for {accel}"
            );
            assert_eq!(
                shortcut_label_for_platform(accel, false),
                expected_other,
                "non-macOS mismatch for {accel}"
            );
        }

        let current = shortcut_label("Cmd+K");
        if cfg!(target_os = "macos") {
            assert_eq!(current, "⌘K");
        } else {
            assert_eq!(current, "Ctrl+K");
        }
    }
}
