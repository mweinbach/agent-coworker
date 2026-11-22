//! Cross-platform keyboard shortcut formatting helpers.
//!
//! Translates Electron-style accelerator strings (for example `"Cmd+N"`,
//! `"Cmd+Shift+F"`, `"Opt+Cmd+I"`, `"Cmd+1-9"`) into native UI labels:
//! compact macOS glyphs (`⌘N`, `⌘⇧F`, `⌥⌘I`, `⌘1-9`) on macOS, and
//! `Ctrl+Shift+...` notation on Linux and Windows.

use std::borrow::Cow;
use std::cell::RefCell;
use std::collections::HashMap;

const MAX_SHORTCUT_CACHE_ENTRIES: usize = 256;

type ShortcutCacheEntry = (Option<String>, Option<String>);

thread_local! {
    static SHORTCUT_LABEL_CACHE: RefCell<HashMap<String, ShortcutCacheEntry>> =
        RefCell::new(HashMap::new());
}

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

    SHORTCUT_LABEL_CACHE.with(|cell| {
        if let Some(entry) = cell.borrow().get(trimmed) {
            let slot = if is_macos { &entry.0 } else { &entry.1 };
            if let Some(cached) = slot {
                return cached.clone();
            }
        }
        let formatted = format_shortcut_uncached(trimmed, is_macos);
        let mut cache = cell.borrow_mut();
        if cache.len() >= MAX_SHORTCUT_CACHE_ENTRIES && !cache.contains_key(trimmed) {
            cache.clear();
        }
        let entry = cache
            .entry(trimmed.to_string())
            .or_insert_with(|| (None, None));
        if is_macos {
            entry.0 = Some(formatted.clone());
        } else {
            entry.1 = Some(formatted.clone());
        }
        formatted
    })
}

fn format_shortcut_uncached(trimmed: &str, is_macos: bool) -> String {
    let normalized: Cow<'_, str> = if trimmed.contains("++") {
        Cow::Owned(trimmed.replace("++", "+Plus"))
    } else {
        Cow::Borrowed(trimmed)
    };

    let mut out = String::with_capacity(normalized.len() + 4);
    let mut first = true;
    for part in normalized
        .split('+')
        .map(str::trim)
        .filter(|part| !part.is_empty())
    {
        if !first && !is_macos {
            out.push('+');
        }
        first = false;
        push_formatted_token(&mut out, part, is_macos);
    }
    out
}

fn push_formatted_token(out: &mut String, token: &str, is_macos: bool) {
    if token.eq_ignore_ascii_case("commandorcontrol")
        || token.eq_ignore_ascii_case("cmdorctrl")
        || token.eq_ignore_ascii_case("command")
        || token.eq_ignore_ascii_case("cmd")
        || token.eq_ignore_ascii_case("super")
        || token.eq_ignore_ascii_case("meta")
    {
        out.push_str(if is_macos { "⌘" } else { "Ctrl" });
    } else if token.eq_ignore_ascii_case("control") || token.eq_ignore_ascii_case("ctrl") {
        out.push_str(if is_macos { "⌃" } else { "Ctrl" });
    } else if token.eq_ignore_ascii_case("alt")
        || token.eq_ignore_ascii_case("option")
        || token.eq_ignore_ascii_case("opt")
    {
        out.push_str(if is_macos { "⌥" } else { "Alt" });
    } else if token.eq_ignore_ascii_case("shift") {
        out.push_str(if is_macos { "⇧" } else { "Shift" });
    } else if token.eq_ignore_ascii_case("space") {
        out.push_str("Space");
    } else if token.eq_ignore_ascii_case("enter") || token.eq_ignore_ascii_case("return") {
        out.push_str(if is_macos { "↵" } else { "Enter" });
    } else if token.eq_ignore_ascii_case("esc") || token.eq_ignore_ascii_case("escape") {
        out.push_str("Esc");
    } else if token.eq_ignore_ascii_case("backspace") {
        out.push_str(if is_macos { "⌫" } else { "Backspace" });
    } else if token.eq_ignore_ascii_case("delete") || token.eq_ignore_ascii_case("del") {
        out.push_str(if is_macos { "⌦" } else { "Del" });
    } else if token.eq_ignore_ascii_case("tab") {
        out.push_str(if is_macos { "⇥" } else { "Tab" });
    } else if token.eq_ignore_ascii_case("arrowup") || token.eq_ignore_ascii_case("up") {
        out.push('↑');
    } else if token.eq_ignore_ascii_case("arrowdown") || token.eq_ignore_ascii_case("down") {
        out.push('↓');
    } else if token.eq_ignore_ascii_case("arrowleft") || token.eq_ignore_ascii_case("left") {
        out.push('←');
    } else if token.eq_ignore_ascii_case("arrowright") || token.eq_ignore_ascii_case("right") {
        out.push('→');
    } else if token.eq_ignore_ascii_case("plus") {
        out.push('+');
    } else if token.eq_ignore_ascii_case("comma") {
        out.push(',');
    } else if token.eq_ignore_ascii_case("period") {
        out.push('.');
    } else if token.eq_ignore_ascii_case("minus") {
        out.push('-');
    } else if token.eq_ignore_ascii_case("equal") {
        out.push('=');
    } else if token.len() == 1 {
        out.push((token.as_bytes()[0].to_ascii_uppercase()) as char);
    } else {
        out.push_str(token);
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
