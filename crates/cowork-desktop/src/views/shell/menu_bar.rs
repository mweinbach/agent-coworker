//! In-window application menu bar for Linux and Windows (`desktop_settings.show_menu_bar`).
//!
//! macOS uses the native global `NSMenu` bar driven by `crate::native::menu`, so this bar
//! stays hidden whenever `effective_desktop_platform().is_macos()` is true (unless overridden via
//! `COWORK_MENU_BAR_PLATFORM` / `menu_platform_override` for tests and headless `--snap`).
//!
//! Layout and behavior:
//! - Wide viewports: renders an inline compact strip (`File  Edit  View  Window  Help`)
//!   inside `ShellToolbar` left-aligned after leading chrome insets, with `&`-mnemonic
//!   underlines during `Alt` / `F10` keyboard navigation, hover-to-switch across open top menus,
//!   and keyboard traversal across menus and dropdown items.
//! - Narrow / tight toolbars (`< NARROW_BREAKPOINT` or limited width): collapses cleanly to a
//!   single `"☰"` button whose popup drills into each top-level menu category.
//! - Hidden mode (`show_menu_bar == false`): remains collapsed until `Alt` tap, `F10`, or
//!   `Alt+<mnemonic>` temporarily reveals it, hiding again upon dismissal or command execution.

use rune::{
    Align, Color, Cursor, El, Key, KeyEvent, Modifier, Side, Span, TextStyle, Tx, col, el, icon,
    row, text,
};
use rune_kit::Kit;

use super::icons;

use crate::router::ViewId;
use crate::state::{AppState, WindowMode};
use crate::theme::ThemeTokens;
use crate::{ApplicationMenu, ApplicationMenuEntry, ApplicationMenuItem, build_application_menu};

use super::helpers::NARROW_BREAKPOINT;
use super::state::any_non_menu_overlay_open;

/// Maximum number of top-level menus in non-macOS mode (`File`, `Edit`, `View`, `Window`, `Help`).
pub const MENU_BAR_COUNT: usize = 5;

#[derive(Clone, Copy)]
struct StaticTopMenu {
    label: &'static str,
    title: &'static str,
    mnemonic: char,
}

/// Static non-macOS top-level menu headers matching `crate::native::menu::build_application_menu`,
/// so rendering the strip and fast-pathing key events avoid rebuilding all menu items every frame.
const STATIC_TOP_MENUS: [StaticTopMenu; MENU_BAR_COUNT] = [
    StaticTopMenu {
        label: "&File",
        title: "File",
        mnemonic: 'F',
    },
    StaticTopMenu {
        label: "&Edit",
        title: "Edit",
        mnemonic: 'E',
    },
    StaticTopMenu {
        label: "&View",
        title: "View",
        mnemonic: 'V',
    },
    StaticTopMenu {
        label: "&Window",
        title: "Window",
        mnemonic: 'W',
    },
    StaticTopMenu {
        label: "&Help",
        title: "Help",
        mnemonic: 'H',
    },
];

fn find_static_top_menu_by_mnemonic(ch: char) -> Option<usize> {
    let target = ch.to_ascii_uppercase();
    STATIC_TOP_MENUS
        .iter()
        .position(|menu| menu.mnemonic == target)
}

const MENU_STRIP_KEY: &str = "menu-bar-strip";
const MENU_HAMBURGER_KEY: &str = "menu-bar-hamburger";
const MENU_DROPDOWN_MODAL_KEY: &str = "menu-bar-dropdown-modal";
const MENU_DROPDOWN_SCOPE_KEY: &str = "menu-bar-dropdown-scope";
const MENU_FOCUS_BACKDROP_KEY: &str = "menu-bar-focus-backdrop";
const MENU_BAR_MIN_INLINE_WIDTH: f32 = 520.0;
const WINDOWS_CAPTION_RESERVE_ESTIMATE: f32 = 138.0;

/// Transient state for the Linux/Windows in-window application menu bar.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct MenuBarUiState {
    /// Currently expanded top-level menu dropdown (`0..menus.len()`).
    pub open_menu_idx: Option<usize>,
    /// Keyboard-focused top-level menu item while navigating the menu bar.
    pub focused_top_idx: Option<usize>,
    /// Keyboard/hover highlighted index within `menu.items` (never points to a separator or disabled item).
    pub active_item_idx: Option<usize>,
    /// True when the narrow `"☰"` popup is open (`open_menu_idx == None` shows category list,
    /// `Some(i)` shows category `i`'s items).
    pub narrow_menu_open: bool,
    /// Active category cursor in the narrow `"☰"` root menu list.
    pub narrow_root_idx: usize,
    /// True when a dropdown was opened from keyboard bar focus (`F10` / `Alt` -> `Down`/`Enter`),
    /// so `Escape` pops back to the bar button before dismissing the bar.
    pub opened_via_bar_focus: bool,
    /// Temporarily shows the menu bar when `desktop_settings.show_menu_bar == false`.
    pub temp_revealed: bool,
    /// True while an `Alt` modifier key is held down.
    pub alt_held: bool,
    /// Armed on bare `Alt` press and cleared if any non-Alt key runs before `Alt` release.
    pub alt_tap_armed: bool,
    /// Element key focused prior to opening/focusing the menu bar, restored on dismiss/command.
    pub saved_focus_key: Option<String>,
    /// View-space `[x, y, w, h]` rects of top-level menu buttons for hover-to-switch bridges.
    pub button_rects: [[f32; 4]; MENU_BAR_COUNT],
    /// Shows underlined `&` mnemonic letters (during `Alt` hold or keyboard bar/menu focus).
    pub show_mnemonics: bool,
}

impl MenuBarUiState {
    /// Whether the menu bar currently holds focus or an open popup.
    pub fn is_active(&self) -> bool {
        self.open_menu_idx.is_some() || self.focused_top_idx.is_some() || self.narrow_menu_open
    }

    /// Whether the in-window menu bar should be mounted in the top toolbar right now.
    pub fn is_bar_visible(&self, s: &AppState) -> bool {
        s.window_mode == WindowMode::Main
            && !s.effective_desktop_platform().is_macos()
            && (s.desktop_settings.show_menu_bar || self.temp_revealed || self.is_active())
    }

    /// Updates cached layout bounds of top-level menu button `idx`, returning whether it changed.
    pub fn set_button_rect(&mut self, idx: usize, rect: [f32; 4]) -> bool {
        if let Some(slot) = self.button_rects.get_mut(idx)
            && *slot != rect
        {
            *slot = rect;
            return true;
        }
        false
    }

    /// Switches the open dropdown in wide mode when hovering or pressing Left/Right.
    pub fn switch_open_menu(&mut self, idx: usize, select_first: Option<usize>) {
        self.open_menu_idx = Some(idx);
        self.active_item_idx = select_first;
        if self.focused_top_idx.is_some() {
            self.focused_top_idx = Some(idx);
        }
    }

    /// Clears transient open/reveal state while leaving `saved_focus_key` ready to consume.
    pub fn clear_active(&mut self) {
        self.open_menu_idx = None;
        self.focused_top_idx = None;
        self.active_item_idx = None;
        self.narrow_menu_open = false;
        self.opened_via_bar_focus = false;
        self.temp_revealed = false;
        self.alt_tap_armed = false;
        self.show_mnemonics = false;
    }

    /// Takes any saved pre-menu focus key.
    pub fn take_saved_focus(&mut self) -> Option<String> {
        self.saved_focus_key.take()
    }
}

/// Parses an Electron-style `&Mnemonic` label into `(display, byte_span, mnemonic_char)`.
///
/// Escaped `&&` renders as a literal `&` without starting a mnemonic.
pub fn parse_mnemonic_label(raw: &str) -> (String, Option<(usize, usize)>, Option<char>) {
    let mut display = String::with_capacity(raw.len());
    let mut span = None;
    let mut mnemonic = None;
    let mut chars = raw.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '&' {
            if let Some(&next) = chars.peek() {
                if next == '&' {
                    display.push('&');
                    chars.next();
                    continue;
                }
                if span.is_none() {
                    let start = display.len();
                    display.push(next);
                    let end = display.len();
                    span = Some((start, end));
                    mnemonic = Some(next.to_ascii_uppercase());
                    chars.next();
                    continue;
                }
            }
            continue;
        }
        display.push(ch);
    }
    (display, span, mnemonic)
}

/// Returns whether the top-bar menu should collapse into the compact `"☰"` menu button.
pub fn is_compact_menu_bar(
    s: &AppState,
    primary_width_override: Option<f32>,
    chrome_trailing: f32,
) -> bool {
    let vw = s.shell_ui.viewport_width;
    if vw <= 0.0 {
        return false;
    }
    if vw < NARROW_BREAKPOINT {
        return true;
    }
    let layout = super::resolve_shell_adaptive_layout(s, super::state::has_active_canvas_target(s));
    let primary_width = primary_width_override.unwrap_or(layout.primary_width);
    let sidebar_docked_open =
        s.route().view != ViewId::Settings && !layout.left_overlay && s.sidebar.is_open();
    let leading_pad = if s.route().view != ViewId::Settings && !sidebar_docked_open {
        48.0
    } else {
        12.0
    };
    (primary_width - chrome_trailing - leading_pad) < MENU_BAR_MIN_INLINE_WIDTH
}

fn estimated_compact_for_keys(s: &AppState) -> bool {
    let trailing = if s.effective_desktop_platform().is_windows() {
        WINDOWS_CAPTION_RESERVE_ESTIMATE
    } else {
        0.0
    };
    is_compact_menu_bar(s, None, trailing)
}

fn menu_btn_key(idx: usize) -> String {
    format!("menu-bar-item-{idx}")
}

fn capture_focus_before_menu(s: &mut AppState, tx: &Tx) {
    if s.shell_ui.menu_bar.saved_focus_key.is_some() {
        return;
    }
    if let Some(focused) = tx.focused()
        && !focused.starts_with("menu-bar-")
    {
        s.shell_ui.menu_bar.saved_focus_key = Some(focused.to_owned());
    }
}

fn restore_saved_focus(s: &mut AppState, tx: &mut Tx) {
    if let Some(key) = s.shell_ui.menu_bar.take_saved_focus() {
        tx.focus(&key, false);
    } else if tx.focused().is_some_and(|k| k.starts_with("menu-bar-")) {
        tx.blur();
    }
}

/// Dismisses all menu bar popups/focus and returns focus to the pre-menu element when recorded.
pub fn dismiss_menu_bar(s: &mut AppState, tx: &mut Tx, restore_focus: bool) {
    s.shell_ui.menu_bar.clear_active();
    if restore_focus {
        restore_saved_focus(s, tx);
    } else {
        s.shell_ui.menu_bar.saved_focus_key = None;
    }
}

fn execute_menu_item(s: &mut AppState, tx: &mut Tx, command_id: &'static str) {
    s.shell_ui.menu_bar.clear_active();
    restore_saved_focus(s, tx);
    s.queue_menu_command(tx, command_id);
}

fn first_enabled_item(menu: &ApplicationMenu) -> Option<usize> {
    menu.items
        .iter()
        .position(|entry| matches!(entry, ApplicationMenuEntry::Item(item) if item.enabled))
}

fn last_enabled_item(menu: &ApplicationMenu) -> Option<usize> {
    menu.items
        .iter()
        .rposition(|entry| matches!(entry, ApplicationMenuEntry::Item(item) if item.enabled))
}

fn step_enabled_item(
    menu: &ApplicationMenu,
    current: Option<usize>,
    forward: bool,
) -> Option<usize> {
    let len = menu.items.len();
    if len == 0 {
        return None;
    }
    for step in 1..=len {
        let idx = match (current, forward) {
            (None, true) => step - 1,
            (None, false) => len - step,
            (Some(cur), true) => (cur + step) % len,
            (Some(cur), false) => (cur + len - (step % len)) % len,
        };
        if matches!(&menu.items[idx], ApplicationMenuEntry::Item(item) if item.enabled) {
            return Some(idx);
        }
    }
    None
}

fn mnemonic_char_from_event(ev: &KeyEvent, tx: &Tx) -> Option<char> {
    tx.key_base()
        .or_else(|| match &ev.key {
            Key::Text(t) if t.chars().count() == 1 => t.chars().next(),
            _ => None,
        })
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_uppercase())
}

fn item_mnemonic_char(item: &ApplicationMenuItem) -> Option<char> {
    item.mnemonic
        .map(|c| c.to_ascii_uppercase())
        .or_else(|| {
            let (_, _, parsed) = parse_mnemonic_label(item.label);
            parsed
        })
        .or_else(|| {
            item.label
                .chars()
                .find(|c| c.is_ascii_alphanumeric())
                .map(|c| c.to_ascii_uppercase())
        })
}

fn find_next_matching_item(
    menu: &ApplicationMenu,
    current: Option<usize>,
    target: char,
) -> Option<usize> {
    let len = menu.items.len();
    if len == 0 {
        return None;
    }
    let start = current.map(|i| (i + 1) % len).unwrap_or(0);
    for offset in 0..len {
        let idx = (start + offset) % len;
        if let ApplicationMenuEntry::Item(item) = &menu.items[idx]
            && item.enabled
            && item_mnemonic_char(item) == Some(target)
        {
            return Some(idx);
        }
    }
    None
}

fn find_top_menu_by_mnemonic(menus: &[ApplicationMenu], ch: char) -> Option<usize> {
    let target = ch.to_ascii_uppercase();
    menus.iter().position(|menu| {
        let (_, _, parsed) = parse_mnemonic_label(menu.label);
        menu.mnemonic.map(|c| c.to_ascii_uppercase()).or(parsed) == Some(target)
    })
}

fn open_top_menu_dropdown(
    s: &mut AppState,
    tx: &mut Tx,
    idx: usize,
    menus: &[ApplicationMenu],
    via_bar_focus: bool,
    select_first: bool,
) {
    let Some(menu) = menus.get(idx) else {
        return;
    };
    capture_focus_before_menu(s, tx);
    let active_item = if select_first {
        first_enabled_item(menu)
    } else {
        None
    };
    let compact = estimated_compact_for_keys(s);
    if !s.desktop_settings.show_menu_bar {
        s.shell_ui.menu_bar.temp_revealed = true;
    }
    s.shell_ui.menu_bar.narrow_menu_open = compact;
    s.shell_ui.menu_bar.narrow_root_idx = idx;
    s.shell_ui.menu_bar.open_menu_idx = Some(idx);
    s.shell_ui.menu_bar.focused_top_idx = if via_bar_focus { Some(idx) } else { None };
    s.shell_ui.menu_bar.opened_via_bar_focus = via_bar_focus;
    s.shell_ui.menu_bar.active_item_idx = active_item;
    s.shell_ui.menu_bar.show_mnemonics = true;
    tx.focus(MENU_DROPDOWN_MODAL_KEY, true);
}

fn activate_bar_focus(s: &mut AppState, tx: &mut Tx) {
    capture_focus_before_menu(s, tx);
    let compact = estimated_compact_for_keys(s);
    if !s.desktop_settings.show_menu_bar {
        s.shell_ui.menu_bar.temp_revealed = true;
    }
    s.shell_ui.menu_bar.show_mnemonics = true;
    s.shell_ui.menu_bar.open_menu_idx = None;
    s.shell_ui.menu_bar.active_item_idx = None;
    s.shell_ui.menu_bar.opened_via_bar_focus = false;
    if compact {
        s.shell_ui.menu_bar.narrow_menu_open = true;
        s.shell_ui.menu_bar.narrow_root_idx = 0;
        s.shell_ui.menu_bar.focused_top_idx = None;
        tx.focus(MENU_DROPDOWN_MODAL_KEY, true);
    } else {
        s.shell_ui.menu_bar.narrow_menu_open = false;
        s.shell_ui.menu_bar.focused_top_idx = Some(0);
        tx.focus(menu_btn_key(0), true);
    }
}

fn handle_bar_focus_key(s: &mut AppState, ev: &KeyEvent, tx: &mut Tx) -> bool {
    let Some(cur) = s.shell_ui.menu_bar.focused_top_idx else {
        return false;
    };
    let len = STATIC_TOP_MENUS.len();
    match &ev.key {
        Key::Left => {
            let next = (cur + len - 1) % len;
            s.shell_ui.menu_bar.focused_top_idx = Some(next);
            tx.focus(menu_btn_key(next), true);
            true
        }
        Key::Right => {
            let next = (cur + 1) % len;
            s.shell_ui.menu_bar.focused_top_idx = Some(next);
            tx.focus(menu_btn_key(next), true);
            true
        }
        Key::Down | Key::Enter => {
            let menus = build_application_menu(s);
            open_top_menu_dropdown(s, tx, cur, &menus, true, true);
            true
        }
        Key::Text(t) if t == " " && !ev.mods.ctrl && !ev.mods.cmd => {
            let menus = build_application_menu(s);
            open_top_menu_dropdown(s, tx, cur, &menus, true, true);
            true
        }
        Key::Escape => {
            dismiss_menu_bar(s, tx, true);
            true
        }
        Key::Tab => {
            dismiss_menu_bar(s, tx, false);
            false
        }
        Key::Text(_) if !ev.mods.ctrl && !ev.mods.cmd => {
            if let Some(ch) = mnemonic_char_from_event(ev, tx)
                && let Some(idx) = find_static_top_menu_by_mnemonic(ch)
            {
                let menus = build_application_menu(s);
                open_top_menu_dropdown(s, tx, idx, &menus, true, true);
                return true;
            }
            false
        }
        _ => false,
    }
}

fn handle_dropdown_key(
    s: &mut AppState,
    ev: &KeyEvent,
    tx: &mut Tx,
    menus: &[ApplicationMenu],
) -> bool {
    let len = menus.len();
    if len == 0 {
        return false;
    }

    // Narrow hamburger category list (`narrow_menu_open && open_menu_idx.is_none()`).
    if s.shell_ui.menu_bar.narrow_menu_open && s.shell_ui.menu_bar.open_menu_idx.is_none() {
        let cur = s.shell_ui.menu_bar.narrow_root_idx.min(len - 1);
        return match &ev.key {
            Key::Down | Key::Tab if !ev.mods.shift => {
                s.shell_ui.menu_bar.narrow_root_idx = (cur + 1) % len;
                true
            }
            Key::Up | Key::Tab => {
                s.shell_ui.menu_bar.narrow_root_idx = (cur + len - 1) % len;
                true
            }
            Key::Home => {
                s.shell_ui.menu_bar.narrow_root_idx = 0;
                true
            }
            Key::End => {
                s.shell_ui.menu_bar.narrow_root_idx = len - 1;
                true
            }
            Key::Right | Key::Enter => {
                let first = first_enabled_item(&menus[cur]);
                s.shell_ui.menu_bar.open_menu_idx = Some(cur);
                s.shell_ui.menu_bar.active_item_idx = first;
                true
            }
            Key::Text(t) if t == " " => {
                let first = first_enabled_item(&menus[cur]);
                s.shell_ui.menu_bar.open_menu_idx = Some(cur);
                s.shell_ui.menu_bar.active_item_idx = first;
                true
            }
            Key::Escape => {
                dismiss_menu_bar(s, tx, true);
                true
            }
            Key::Text(_) if !ev.mods.ctrl && !ev.mods.cmd => {
                if let Some(ch) = mnemonic_char_from_event(ev, tx)
                    && let Some(idx) = find_top_menu_by_mnemonic(menus, ch)
                {
                    let first = first_enabled_item(&menus[idx]);
                    s.shell_ui.menu_bar.narrow_root_idx = idx;
                    s.shell_ui.menu_bar.open_menu_idx = Some(idx);
                    s.shell_ui.menu_bar.active_item_idx = first;
                    return true;
                }
                false
            }
            _ => false,
        };
    }

    let Some(open_idx) = s.shell_ui.menu_bar.open_menu_idx else {
        return false;
    };
    let Some(menu) = menus.get(open_idx) else {
        dismiss_menu_bar(s, tx, true);
        return true;
    };

    match &ev.key {
        Key::Down | Key::Tab if !ev.mods.shift => {
            s.shell_ui.menu_bar.active_item_idx =
                step_enabled_item(menu, s.shell_ui.menu_bar.active_item_idx, true);
            true
        }
        Key::Up | Key::Tab => {
            s.shell_ui.menu_bar.active_item_idx =
                step_enabled_item(menu, s.shell_ui.menu_bar.active_item_idx, false);
            true
        }
        Key::Home => {
            s.shell_ui.menu_bar.active_item_idx = first_enabled_item(menu);
            true
        }
        Key::End => {
            s.shell_ui.menu_bar.active_item_idx = last_enabled_item(menu);
            true
        }
        Key::Right => {
            if s.shell_ui.menu_bar.narrow_menu_open {
                return false;
            }
            let next = (open_idx + 1) % len;
            let first = first_enabled_item(&menus[next]);
            s.shell_ui.menu_bar.switch_open_menu(next, first);
            true
        }
        Key::Left => {
            if s.shell_ui.menu_bar.narrow_menu_open {
                s.shell_ui.menu_bar.open_menu_idx = None;
                s.shell_ui.menu_bar.active_item_idx = None;
                s.shell_ui.menu_bar.narrow_root_idx = open_idx;
                return true;
            }
            let prev = (open_idx + len - 1) % len;
            let first = first_enabled_item(&menus[prev]);
            s.shell_ui.menu_bar.switch_open_menu(prev, first);
            true
        }
        Key::Enter => {
            if let Some(item_idx) = s.shell_ui.menu_bar.active_item_idx
                && let Some(ApplicationMenuEntry::Item(item)) = menu.items.get(item_idx)
                && item.enabled
            {
                execute_menu_item(s, tx, item.command_id);
                return true;
            }
            false
        }
        Key::Text(t) if t == " " && !ev.mods.ctrl && !ev.mods.cmd => {
            if let Some(item_idx) = s.shell_ui.menu_bar.active_item_idx
                && let Some(ApplicationMenuEntry::Item(item)) = menu.items.get(item_idx)
                && item.enabled
            {
                execute_menu_item(s, tx, item.command_id);
                return true;
            }
            false
        }
        Key::Escape => {
            if s.shell_ui.menu_bar.narrow_menu_open {
                s.shell_ui.menu_bar.open_menu_idx = None;
                s.shell_ui.menu_bar.active_item_idx = None;
                s.shell_ui.menu_bar.narrow_root_idx = open_idx;
                return true;
            }
            if s.shell_ui.menu_bar.opened_via_bar_focus {
                s.shell_ui.menu_bar.open_menu_idx = None;
                s.shell_ui.menu_bar.active_item_idx = None;
                s.shell_ui.menu_bar.opened_via_bar_focus = false;
                s.shell_ui.menu_bar.focused_top_idx = Some(open_idx);
                tx.focus(menu_btn_key(open_idx), true);
                return true;
            }
            dismiss_menu_bar(s, tx, true);
            true
        }
        Key::Text(_) if !ev.mods.ctrl && !ev.mods.cmd => {
            if let Some(ch) = mnemonic_char_from_event(ev, tx) {
                if ev.mods.alt
                    && let Some(top_idx) = find_top_menu_by_mnemonic(menus, ch)
                {
                    let first = first_enabled_item(&menus[top_idx]);
                    s.shell_ui.menu_bar.switch_open_menu(top_idx, first);
                    return true;
                }
                if !ev.mods.alt
                    && let Some(match_idx) =
                        find_next_matching_item(menu, s.shell_ui.menu_bar.active_item_idx, ch)
                {
                    s.shell_ui.menu_bar.active_item_idx = Some(match_idx);
                    return true;
                }
            }
            false
        }
        _ => false,
    }
}

/// Handles global menu-bar activation (`Alt` tap, `F10`, `Alt+<mnemonic>`) and menu keyboard nav.
pub fn handle_key(s: &mut AppState, ev: &KeyEvent, tx: &mut Tx) -> bool {
    if s.window_mode != WindowMode::Main || s.effective_desktop_platform().is_macos() {
        return false;
    }

    // Track Alt modifier hold/release cleanly even if an unrelated overlay closes.
    if let Key::Modifier {
        modifier: Modifier::AltLeft | Modifier::AltRight,
        pressed,
    } = ev.key
    {
        if any_non_menu_overlay_open(s) {
            s.shell_ui.menu_bar.alt_held = pressed;
            s.shell_ui.menu_bar.alt_tap_armed = false;
            return false;
        }
        if pressed {
            let can_arm = !ev.mods.ctrl && !ev.mods.cmd && !ev.mods.shift;
            s.shell_ui.menu_bar.alt_held = true;
            s.shell_ui.menu_bar.alt_tap_armed = can_arm;
            let show_underlines =
                s.desktop_settings.show_menu_bar || s.shell_ui.menu_bar.temp_revealed;
            if show_underlines && !s.shell_ui.menu_bar.show_mnemonics {
                s.shell_ui.menu_bar.show_mnemonics = true;
                return true;
            }
            return false;
        }

        // Alt released: if bare Alt tap was armed, toggle menu bar focus / temp reveal.
        s.shell_ui.menu_bar.alt_held = false;
        let was_armed = std::mem::take(&mut s.shell_ui.menu_bar.alt_tap_armed);
        if was_armed && !ev.mods.ctrl && !ev.mods.cmd && !ev.mods.shift {
            if s.shell_ui.menu_bar.is_active() || s.shell_ui.menu_bar.temp_revealed {
                dismiss_menu_bar(s, tx, true);
            } else {
                activate_bar_focus(s, tx);
            }
            return true;
        }
        if !s.shell_ui.menu_bar.is_active() && s.shell_ui.menu_bar.show_mnemonics {
            s.shell_ui.menu_bar.show_mnemonics = false;
            return true;
        }
        return false;
    }

    // Any other key pressed while Alt is down disarms a bare-Alt toggle.
    s.shell_ui.menu_bar.alt_tap_armed = false;

    if any_non_menu_overlay_open(s) {
        if s.shell_ui.menu_bar.is_active() || s.shell_ui.menu_bar.temp_revealed {
            s.shell_ui.menu_bar.clear_active();
            s.shell_ui.menu_bar.saved_focus_key = None;
        }
        return false;
    }

    // Plain F10 (never Shift+F10, which Rune reserves for context menus) toggles bar focus.
    if matches!(ev.key, Key::Function(10))
        && !ev.mods.shift
        && !ev.mods.ctrl
        && !ev.mods.cmd
        && !ev.mods.alt
    {
        if s.shell_ui.menu_bar.is_active() || s.shell_ui.menu_bar.temp_revealed {
            dismiss_menu_bar(s, tx, true);
        } else {
            activate_bar_focus(s, tx);
        }
        return true;
    }

    // Alt+<mnemonic> (without Ctrl/Cmd to avoid clashing with Windows AltGr chords).
    if ev.mods.alt
        && !ev.mods.ctrl
        && !ev.mods.cmd
        && !ev.mods.shift
        && let Some(ch) = mnemonic_char_from_event(ev, tx)
        && let Some(idx) = find_static_top_menu_by_mnemonic(ch)
    {
        let menus = build_application_menu(s);
        open_top_menu_dropdown(s, tx, idx, &menus, false, true);
        return true;
    }

    if s.shell_ui.menu_bar.open_menu_idx.is_some() || s.shell_ui.menu_bar.narrow_menu_open {
        let menus = build_application_menu(s);
        return handle_dropdown_key(s, ev, tx, &menus);
    }

    if s.shell_ui.menu_bar.focused_top_idx.is_some() {
        return handle_bar_focus_key(s, ev, tx);
    }

    false
}

fn render_mnemonic_text(
    label: &str,
    fallback_mnemonic: Option<char>,
    show_underline: bool,
    style: TextStyle,
    color: Color,
) -> El {
    let (display, mut byte_span, _) = parse_mnemonic_label(label);
    if byte_span.is_none()
        && let Some(m) = fallback_mnemonic
        && let Some(pos) = display.find(|c: char| c.eq_ignore_ascii_case(&m))
        && let Some(ch) = display[pos..].chars().next()
    {
        byte_span = Some((pos, pos + ch.len_utf8()));
    }
    let mut t = text(display).font(style).color(color);
    if show_underline && let Some((start, end)) = byte_span {
        t = t.spans([Span::new(start, end).underline(color)]);
    }
    t
}

/// Builds the top-bar menu strip (`File  Edit  View  Window  Help` or `"☰"` when compact),
/// returning `None` on macOS or when `desktop_settings.show_menu_bar == false` and not revealed.
pub fn build_menu_bar_strip(
    s: &AppState,
    _k: &Kit,
    t: &ThemeTokens,
    primary_width: Option<f32>,
    chrome_trailing: f32,
) -> Option<El> {
    if !s.shell_ui.menu_bar.is_bar_visible(s) {
        return None;
    }

    let compact = is_compact_menu_bar(s, primary_width, chrome_trailing);
    if compact {
        let open =
            s.shell_ui.menu_bar.narrow_menu_open || s.shell_ui.menu_bar.open_menu_idx.is_some();
        let btn = el()
            .key(MENU_HAMBURGER_KEY)
            .role("button")
            .label("Application menu")
            .help("Application menu")
            .size(28.0, 28.0)
            .center()
            .radius(6.0)
            .cursor(Cursor::Pointer)
            .keeps_text_selection()
            .fill(if open {
                t.glass_active
            } else {
                Color::TRANSPARENT
            })
            .hover(if open { t.glass_active } else { t.glass_hover })
            .border(
                1.0,
                if open {
                    t.border_muted
                } else {
                    Color::TRANSPARENT
                },
            )
            .on_press_tx(|s: &mut AppState, tx: &mut Tx| {
                if s.shell_ui.menu_bar.narrow_menu_open
                    || s.shell_ui.menu_bar.open_menu_idx.is_some()
                {
                    dismiss_menu_bar(s, tx, true);
                } else {
                    capture_focus_before_menu(s, tx);
                    s.shell_ui.menu_bar.narrow_menu_open = true;
                    s.shell_ui.menu_bar.narrow_root_idx = 0;
                    s.shell_ui.menu_bar.open_menu_idx = None;
                    s.shell_ui.menu_bar.active_item_idx = None;
                    s.shell_ui.menu_bar.show_mnemonics = false;
                }
            })
            .child(text("☰").font(TextStyle::new(14.0, 500.0)).color(if open {
                t.text_base
            } else {
                t.text_muted
            }));
        return Some(btn);
    }

    let show_mnemonics = s.shell_ui.menu_bar.show_mnemonics || s.shell_ui.menu_bar.alt_held;
    let open_idx = s.shell_ui.menu_bar.open_menu_idx;
    let focused_idx = s.shell_ui.menu_bar.focused_top_idx;
    let label_style = TextStyle::new(12.5, 500.0);

    let mut strip = row()
        .key(MENU_STRIP_KEY)
        .role("menubar")
        .h(28.0)
        .gap(1.0)
        .center_y();

    for (idx, menu) in STATIC_TOP_MENUS.iter().enumerate() {
        let is_open = open_idx == Some(idx);
        let is_bar_focused = focused_idx == Some(idx) && open_idx.is_none();
        let fg = if is_open || is_bar_focused {
            t.text_base
        } else {
            t.text_muted
        };
        let bg = if is_open {
            t.glass_active
        } else if is_bar_focused {
            t.glass_hover
        } else {
            Color::TRANSPARENT
        };
        let border_color = if is_open {
            t.border_muted
        } else {
            Color::TRANSPARENT
        };

        let btn = el()
            .key(menu_btn_key(idx))
            .role("menuitem")
            .label(menu.title)
            .expanded(is_open)
            .focusable(is_bar_focused)
            .keeps_text_selection()
            .h(26.0)
            .px(8.0)
            .center()
            .radius(6.0)
            .cursor(Cursor::Pointer)
            .fill(bg)
            .hover(if is_open {
                t.glass_active
            } else {
                t.glass_hover
            })
            .border(1.0, border_color)
            .on_layout_tx(move |s: &mut AppState, rect, tx| {
                let changed = s.shell_ui.menu_bar.set_button_rect(idx, rect);
                if !changed
                    || (!s.shell_ui.menu_bar.is_active() && !s.shell_ui.menu_bar.temp_revealed)
                {
                    tx.live_only();
                }
            })
            .on_press_tx(move |s: &mut AppState, tx: &mut Tx| {
                if s.shell_ui.menu_bar.open_menu_idx == Some(idx) {
                    dismiss_menu_bar(s, tx, true);
                } else {
                    let menus = build_application_menu(s);
                    open_top_menu_dropdown(s, tx, idx, &menus, false, false);
                }
            })
            .on_hover(move |s: &mut AppState| {
                if s.shell_ui.menu_bar.open_menu_idx.is_some()
                    && s.shell_ui.menu_bar.open_menu_idx != Some(idx)
                {
                    s.shell_ui.menu_bar.switch_open_menu(idx, None);
                }
            })
            .on_key(|s: &mut AppState, ev: &KeyEvent, tx: &mut Tx| handle_bar_focus_key(s, ev, tx))
            .child(render_mnemonic_text(
                menu.label,
                Some(menu.mnemonic),
                show_mnemonics,
                label_style,
                fg,
            ));

        strip = strip.child(btn);
    }

    Some(strip)
}

fn build_menu_entry_row(
    k: &Kit,
    t: &ThemeTokens,
    entry_idx: usize,
    entry: &ApplicationMenuEntry,
    active: bool,
    show_mnemonics: bool,
) -> El {
    match entry {
        ApplicationMenuEntry::Separator => el()
            .key(format!("menu-bar-sep-{entry_idx}"))
            .w_full()
            .h(1.0)
            .my(4.0)
            .fill(t.border_muted)
            .a11y_hidden(),
        ApplicationMenuEntry::Item(item) => {
            let enabled = item.enabled;
            let command_id = item.command_id;
            let fg = if !enabled { t.text_faint } else { t.text_base };
            let shortcut_fg = if !enabled { t.text_faint } else { t.text_muted };
            let bg = if enabled && active {
                t.hover
            } else {
                Color::TRANSPARENT
            };
            let check_cell = el()
                .w(16.0)
                .h(16.0)
                .center()
                .child(if item.checked == Some(true) {
                    icon(k.glyph.check, 12.0).color(t.accent)
                } else {
                    el().size(12.0, 12.0)
                });

            let mut row_el = row()
                .key(format!("menu-bar-dropdown-item-{entry_idx}"))
                .role(if item.checked.is_some() {
                    "menuitemcheckbox"
                } else {
                    "menuitem"
                })
                .label(item.label)
                .w_full()
                .h(28.0)
                .px(8.0)
                .gap(8.0)
                .center_y()
                .radius(5.0)
                .fill(bg)
                .keeps_text_selection()
                .child(check_cell)
                .child(el().grow(1.0).child(render_mnemonic_text(
                    item.label,
                    item.mnemonic,
                    show_mnemonics,
                    TextStyle::new(13.0, 400.0),
                    fg,
                )));

            if !item.shortcut_label.is_empty() {
                row_el = row_el.child(
                    text(item.shortcut_label.clone())
                        .font(TextStyle::new(11.5, 400.0))
                        .color(shortcut_fg),
                );
            }

            if enabled {
                row_el = row_el
                    .cursor(Cursor::Pointer)
                    .hover(t.hover)
                    .on_hover(move |s: &mut AppState| {
                        s.shell_ui.menu_bar.active_item_idx = Some(entry_idx);
                    })
                    .on_press_tx(move |s: &mut AppState, tx: &mut Tx| {
                        execute_menu_item(s, tx, command_id);
                    });
            }

            row_el
        }
    }
}

/// Transparent press/hover bridges laid over the inline menu strip's top buttons (`File`..`Help`)
/// at the strip buttons' window rects. With a dropdown open they are children of the dropdown's
/// modal root, so Rune's modal scope keeps them live; with the bar merely focused they sit above
/// the non-modal click-outside backdrop.
fn top_item_bridges(s: &AppState, menus_len: usize, hover_to_switch: bool) -> Vec<El> {
    let mut bridges = Vec::new();
    for idx in 0..menus_len.min(MENU_BAR_COUNT) {
        let rect = s.shell_ui.menu_bar.button_rects[idx];
        if rect[2] <= 0.0 || rect[3] <= 0.0 {
            continue;
        }
        let mut sensor = el()
            .key(format!("menu-bar-hover-bridge-{idx}"))
            .absolute(rect[0], rect[1])
            .size(rect[2], rect[3])
            .a11y_hidden()
            .cursor(Cursor::Pointer)
            .keeps_text_selection()
            .on_press_tx(move |s: &mut AppState, tx: &mut Tx| {
                if s.shell_ui.menu_bar.open_menu_idx == Some(idx) {
                    dismiss_menu_bar(s, tx, true);
                } else {
                    let menus = build_application_menu(s);
                    open_top_menu_dropdown(s, tx, idx, &menus, false, false);
                }
            });
        if hover_to_switch {
            sensor = sensor.on_hover(move |s: &mut AppState| {
                if s.shell_ui.menu_bar.open_menu_idx.is_some()
                    && s.shell_ui.menu_bar.open_menu_idx != Some(idx)
                {
                    s.shell_ui.menu_bar.switch_open_menu(idx, None);
                }
            });
        }
        bridges.push(sensor);
    }
    bridges
}

/// Pushes the active menu dropdown modal overlay (and wide hover-to-switch bar sensors).
pub fn push_menu_bar_overlay(
    s: &AppState,
    k: &Kit,
    t: &ThemeTokens,
    primary_width: Option<f32>,
    chrome_trailing: f32,
    overlays: &mut Vec<El>,
) {
    if s.window_mode != WindowMode::Main
        || s.effective_desktop_platform().is_macos()
        || any_non_menu_overlay_open(s)
    {
        return;
    }

    let open_idx = s.shell_ui.menu_bar.open_menu_idx;
    let narrow_open = s.shell_ui.menu_bar.narrow_menu_open;
    let bar_focused = s.shell_ui.menu_bar.focused_top_idx.is_some();
    let temp_revealed = s.shell_ui.menu_bar.temp_revealed;
    if open_idx.is_none() && !narrow_open && !bar_focused && !temp_revealed {
        return;
    }

    let compact = is_compact_menu_bar(s, primary_width, chrome_trailing);

    // When `F10` / `Alt`-tap focused or temporarily revealed the inline menu bar without an open
    // dropdown, mount a non-modal transparent click-outside backdrop so outside clicks dismiss
    // focus/reveal without trapping Tab or stealing keyboard focus from the strip button, and keep
    // top-item click bridges above it so clicking `File`..`Help` still opens directly.
    if open_idx.is_none() && (!narrow_open || !compact) {
        if !bar_focused && !temp_revealed {
            return;
        }
        overlays.push(
            el().key(MENU_FOCUS_BACKDROP_KEY)
                .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
                .a11y_hidden()
                .keeps_text_selection()
                .on_press_tx(|s: &mut AppState, tx: &mut Tx| {
                    dismiss_menu_bar(s, tx, false);
                    if tx.focused().is_some_and(|k| k.starts_with("menu-bar-")) {
                        tx.blur();
                    }
                }),
        );
        if !compact {
            overlays.extend(top_item_bridges(s, MENU_BAR_COUNT, false));
        }
        return;
    }

    let show_mnemonics = s.shell_ui.menu_bar.show_mnemonics || s.shell_ui.menu_bar.alt_held;
    let mut bridge_count = MENU_BAR_COUNT;

    let (anchor_key, card_width, list) = if let Some(idx) = open_idx {
        let menus = build_application_menu(s);
        bridge_count = menus.len();
        let Some(menu) = menus.get(idx) else {
            return;
        };
        let anchor = if compact {
            MENU_HAMBURGER_KEY.to_string()
        } else {
            menu_btn_key(idx)
        };
        let mut items_col = col().w_full().items_stretch().padding(4.0);
        if compact {
            let back_row = row()
                .key("menu-bar-narrow-back")
                .role("menuitem")
                .label("Back to menus")
                .w_full()
                .h(28.0)
                .px(8.0)
                .gap(6.0)
                .center_y()
                .radius(5.0)
                .cursor(Cursor::Pointer)
                .hover(t.hover)
                .keeps_text_selection()
                .on_press(move |s: &mut AppState| {
                    s.shell_ui.menu_bar.narrow_menu_open = true;
                    s.shell_ui.menu_bar.open_menu_idx = None;
                    s.shell_ui.menu_bar.active_item_idx = None;
                    s.shell_ui.menu_bar.narrow_root_idx = idx;
                })
                .child(icon(&icons::ARROW_LEFT, 13.0).color(t.text_muted))
                .child(
                    text(menu.title)
                        .font(TextStyle::new(12.5, 600.0))
                        .color(t.text_base),
                );
            items_col = items_col.child(back_row).child(
                el().w_full()
                    .h(1.0)
                    .my(4.0)
                    .fill(t.border_muted)
                    .a11y_hidden(),
            );
        }
        for (entry_idx, entry) in menu.items.iter().enumerate() {
            let active = s.shell_ui.menu_bar.active_item_idx == Some(entry_idx);
            items_col = items_col.child(build_menu_entry_row(
                k,
                t,
                entry_idx,
                entry,
                active,
                show_mnemonics,
            ));
        }
        (anchor, 256.0, items_col)
    } else {
        // Narrow root menu selector (`"☰"` -> File, Edit, View, Window, Help).
        let mut root_col = col().w_full().items_stretch().padding(4.0);
        let active_root = s
            .shell_ui
            .menu_bar
            .narrow_root_idx
            .min(STATIC_TOP_MENUS.len() - 1);
        for (idx, menu) in STATIC_TOP_MENUS.iter().enumerate() {
            let active = idx == active_root;
            let item_row = row()
                .key(format!("menu-bar-narrow-cat-{idx}"))
                .role("menuitem")
                .label(menu.title)
                .w_full()
                .h(30.0)
                .px(10.0)
                .gap(8.0)
                .center_y()
                .radius(5.0)
                .cursor(Cursor::Pointer)
                .fill(if active { t.hover } else { Color::TRANSPARENT })
                .hover(t.hover)
                .keeps_text_selection()
                .on_hover(move |s: &mut AppState| {
                    s.shell_ui.menu_bar.narrow_root_idx = idx;
                })
                .on_press(move |s: &mut AppState| {
                    s.shell_ui.menu_bar.narrow_root_idx = idx;
                    s.shell_ui.menu_bar.open_menu_idx = Some(idx);
                    s.shell_ui.menu_bar.active_item_idx = None;
                })
                .child(el().grow(1.0).child(render_mnemonic_text(
                    menu.label,
                    Some(menu.mnemonic),
                    show_mnemonics,
                    TextStyle::new(13.0, 500.0),
                    t.text_base,
                )))
                .child(icon(&icons::CHEVRON_RIGHT, 13.0).color(t.text_muted));
            root_col = root_col.child(item_row);
        }
        (MENU_HAMBURGER_KEY.to_string(), 220.0, root_col)
    };

    let dropdown = col()
        .key(MENU_DROPDOWN_MODAL_KEY)
        .role("menu")
        .focusable(true)
        .autofocus()
        .focus_ring(0.0, 0.0, Color::TRANSPARENT)
        .w(card_width)
        .radius(8.0)
        .fill(t.popover_bg)
        .border(1.0, t.border_strong)
        .shadow(6.0, 18.0, t.scrim)
        .anchored_fit(&anchor_key, Side::Bottom, Align::Start, 4.0)
        .on_key(|s: &mut AppState, ev: &KeyEvent, tx: &mut Tx| {
            let menus = build_application_menu(s);
            handle_dropdown_key(s, ev, tx, &menus)
        })
        .child(list);

    // Rune's modal scope lets input reach only the open modal's own subtree, the popovers
    // anchored inside it and the window's caption buttons; every other node is inert. The
    // hover-to-switch / click-toggle bridges over the inline menu strip therefore have to live
    // inside the modal: mount the dropdown and its bridges under one modal root. The root is out
    // of flow and sized zero (both children are out of flow), so it covers nothing itself: the
    // bridges keep the strip buttons' window rects, the dropdown still anchors below its button,
    // and a press anywhere else lands outside the modal and dismisses it.
    if !compact && open_idx.is_some() {
        overlays.push(
            col()
                .key(MENU_DROPDOWN_SCOPE_KEY)
                .absolute(0.0, 0.0)
                .modal_tx(true, |s: &mut AppState, tx: &mut Tx| {
                    dismiss_menu_bar(s, tx, true);
                })
                .children(top_item_bridges(s, bridge_count, true))
                .child(dropdown),
        );
    } else {
        overlays.push(dropdown.modal_tx(true, |s: &mut AppState, tx: &mut Tx| {
            dismiss_menu_bar(s, tx, true);
        }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::actions::{Action, ShellAction};
    use crate::router::{SettingsPageId, ViewId};
    use crate::state::DesktopPlatformOverride;
    use crate::theme::ThemePreference;
    use rune::{ChromeInsets, Env, Mods, Runtime, TextEdit};

    fn test_shell_root(s: &AppState, cx: &mut rune::Cx<AppState>) -> El {
        let dark = s.effective_dark(cx.system_dark());
        let (kit, tokens) = crate::theme::build_kit_with_accent(
            dark,
            s.desktop_settings.reduced_transparency,
            s.desktop_settings.high_contrast,
            s.desktop_settings.accent_palette,
        );
        cx.web_focus();
        crate::views::shell::view(s, cx, &kit, &tokens)
    }

    fn make_runtime(
        platform: DesktopPlatformOverride,
        viewport: (f32, f32),
        trailing_chrome: f32,
        configure: impl FnOnce(&mut AppState),
    ) -> Runtime<AppState> {
        let mut s = AppState {
            scene_mode: true,
            system_dark_override: Some(false),
            menu_platform_override: Some(platform),
            ..Default::default()
        };
        s.onboarding.dismissed = true;
        s.desktop_settings.theme = ThemePreference::Light;
        s.shell_ui.viewport_width = viewport.0;
        configure(&mut s);

        let mut rt = Runtime::new(s, test_shell_root, viewport, Env::new(true, 1.0));
        let mut insets = ChromeInsets::default();
        if platform.is_macos() {
            insets.leading = 72.0;
            insets.height = 38.0;
        } else {
            insets.trailing = trailing_chrome;
        }
        rt.set_chrome_insets(insets);
        rt.set_modifier_keys(true);
        rt.on_key = Some(crate::views::shell::handle_key);
        rt.frame(0.0);
        rt.frame(0.016);
        rt
    }

    fn element_rect(rt: &Runtime<AppState>, key: &str) -> Option<[f32; 4]> {
        rt.elements()
            .into_iter()
            .find(|e| !e.exiting && e.key.as_deref() == Some(key))
            .map(|e| e.rect)
    }

    #[test]
    fn visibility_tracks_platform_override_and_macos_hides_in_window_bar() {
        let mac_rt = make_runtime(DesktopPlatformOverride::MacOs, (1280.0, 820.0), 0.0, |_| {});
        assert!(element_rect(&mac_rt, MENU_STRIP_KEY).is_none());
        assert!(element_rect(&mac_rt, MENU_HAMBURGER_KEY).is_none());

        let linux_rt = make_runtime(DesktopPlatformOverride::Linux, (1280.0, 820.0), 0.0, |_| {});
        let strip = element_rect(&linux_rt, MENU_STRIP_KEY).expect("Linux shows inline menu bar");
        assert!(strip[2] > 150.0);
        assert!(element_rect(&linux_rt, MENU_HAMBURGER_KEY).is_none());
        for idx in 0..MENU_BAR_COUNT {
            assert!(
                element_rect(&linux_rt, &menu_btn_key(idx)).is_some(),
                "expected top menu item {idx}"
            );
        }

        let win_rt = make_runtime(
            DesktopPlatformOverride::Windows,
            (1280.0, 820.0),
            138.0,
            |_| {},
        );
        assert!(element_rect(&win_rt, MENU_STRIP_KEY).is_some());
    }

    #[test]
    fn narrow_and_tight_windows_collapse_to_hamburger_and_open_categories() {
        let mut narrow_rt =
            make_runtime(DesktopPlatformOverride::Linux, (640.0, 820.0), 0.0, |_| {});
        assert!(element_rect(&narrow_rt, MENU_STRIP_KEY).is_none());
        let btn = element_rect(&narrow_rt, MENU_HAMBURGER_KEY)
            .expect("narrow viewport shows hamburger menu button");

        let cx = btn[0] + btn[2] * 0.5;
        let cy = btn[1] + btn[3] * 0.5;
        narrow_rt.pointer_down(cx, cy);
        narrow_rt.pointer_up(cx, cy);
        narrow_rt.frame(0.016);

        assert!(narrow_rt.state.shell_ui.menu_bar.narrow_menu_open);
        assert!(element_rect(&narrow_rt, MENU_DROPDOWN_MODAL_KEY).is_some());
        let file_cat = element_rect(&narrow_rt, "menu-bar-narrow-cat-0")
            .expect("hamburger popup lists File category");

        narrow_rt.pointer_down(file_cat[0] + 12.0, file_cat[1] + 10.0);
        narrow_rt.pointer_up(file_cat[0] + 12.0, file_cat[1] + 10.0);
        narrow_rt.frame(0.016);

        assert_eq!(narrow_rt.state.shell_ui.menu_bar.open_menu_idx, Some(0));
        assert!(element_rect(&narrow_rt, "menu-bar-narrow-back").is_some());

        // Windows 840px with open 240px sidebar + 138px caption buttons also collapses cleanly to hamburger.
        let win_tight_rt = make_runtime(
            DesktopPlatformOverride::Windows,
            (840.0, 820.0),
            138.0,
            |_| {},
        );
        assert!(element_rect(&win_tight_rt, MENU_STRIP_KEY).is_none());
        assert!(element_rect(&win_tight_rt, MENU_HAMBURGER_KEY).is_some());
    }

    #[test]
    fn show_menu_bar_false_reveals_on_alt_tap_or_f10_and_ignores_shift_f10() {
        let mut rt = make_runtime(DesktopPlatformOverride::Linux, (1280.0, 820.0), 0.0, |s| {
            s.desktop_settings.show_menu_bar = false;
        });
        assert!(element_rect(&rt, MENU_STRIP_KEY).is_none());

        // Shift+F10 is context menu and must NOT hijack or reveal the menu bar.
        rt.key(KeyEvent {
            key: Key::Function(10),
            mods: Mods {
                shift: true,
                ..Default::default()
            },
        });
        rt.frame(0.016);
        assert!(!rt.state.shell_ui.menu_bar.temp_revealed);
        assert!(element_rect(&rt, MENU_STRIP_KEY).is_none());

        // Plain F10 temporarily reveals and focuses the first menu item.
        rt.key(KeyEvent::from(Key::Function(10)));
        rt.frame(0.016);
        assert!(rt.state.shell_ui.menu_bar.temp_revealed);
        assert_eq!(rt.state.shell_ui.menu_bar.focused_top_idx, Some(0));
        assert!(rt.state.shell_ui.menu_bar.show_mnemonics);
        assert!(element_rect(&rt, MENU_STRIP_KEY).is_some());

        // Escape dismisses focus and hides the bar again.
        rt.key(KeyEvent::from(Key::Escape));
        rt.frame(0.016);
        assert!(!rt.state.shell_ui.menu_bar.temp_revealed);
        assert_eq!(rt.state.shell_ui.menu_bar.focused_top_idx, None);
        assert!(element_rect(&rt, MENU_STRIP_KEY).is_none());

        // Alt down + another key + Alt up disarms tap reveal.
        rt.key(KeyEvent {
            key: Key::Modifier {
                modifier: Modifier::AltLeft,
                pressed: true,
            },
            mods: Mods {
                alt: true,
                ..Default::default()
            },
        });
        rt.key(KeyEvent {
            key: Key::Text("x".to_string()),
            mods: Mods {
                alt: true,
                ..Default::default()
            },
        });
        rt.key(KeyEvent {
            key: Key::Modifier {
                modifier: Modifier::AltLeft,
                pressed: false,
            },
            mods: Mods::default(),
        });
        rt.frame(0.016);
        assert!(!rt.state.shell_ui.menu_bar.temp_revealed);

        // Bare Alt tap reveals bar cleanly.
        rt.key(KeyEvent {
            key: Key::Modifier {
                modifier: Modifier::AltLeft,
                pressed: true,
            },
            mods: Mods {
                alt: true,
                ..Default::default()
            },
        });
        rt.key(KeyEvent {
            key: Key::Modifier {
                modifier: Modifier::AltLeft,
                pressed: false,
            },
            mods: Mods::default(),
        });
        rt.frame(0.016);
        assert!(rt.state.shell_ui.menu_bar.temp_revealed);
        assert_eq!(rt.state.shell_ui.menu_bar.focused_top_idx, Some(0));
    }

    #[test]
    fn hover_to_switch_switches_menus_and_click_outside_dismisses() {
        let mut rt = make_runtime(DesktopPlatformOverride::Linux, (1280.0, 820.0), 0.0, |_| {});
        let file_btn = element_rect(&rt, &menu_btn_key(0)).expect("File button");
        let edit_btn = element_rect(&rt, &menu_btn_key(1)).expect("Edit button");

        rt.pointer_down(file_btn[0] + 10.0, file_btn[1] + 10.0);
        rt.pointer_up(file_btn[0] + 10.0, file_btn[1] + 10.0);
        rt.frame(0.016);
        assert_eq!(rt.state.shell_ui.menu_bar.open_menu_idx, Some(0));

        // Moving pointer over Edit button while File is open must switch immediately to Edit.
        rt.pointer_move(edit_btn[0] + 10.0, edit_btn[1] + 10.0);
        rt.frame(0.016);
        assert_eq!(rt.state.shell_ui.menu_bar.open_menu_idx, Some(1));

        // Hovering View also switches to View.
        let view_btn = element_rect(&rt, &menu_btn_key(2)).expect("View button");
        rt.pointer_move(view_btn[0] + 10.0, view_btn[1] + 10.0);
        rt.frame(0.016);
        assert_eq!(rt.state.shell_ui.menu_bar.open_menu_idx, Some(2));

        // Presses must reach the bridges inside the modal instead of being swallowed as outside
        // clicks: clicking the open menu's own button toggles it closed, and clicking another
        // top button while no menu is open opens that menu directly.
        rt.pointer_down(view_btn[0] + 10.0, view_btn[1] + 10.0);
        rt.pointer_up(view_btn[0] + 10.0, view_btn[1] + 10.0);
        rt.frame(0.016);
        assert_eq!(rt.state.shell_ui.menu_bar.open_menu_idx, None);
        assert!(element_rect(&rt, MENU_DROPDOWN_MODAL_KEY).is_none());

        rt.pointer_down(file_btn[0] + 10.0, file_btn[1] + 10.0);
        rt.pointer_up(file_btn[0] + 10.0, file_btn[1] + 10.0);
        rt.frame(0.016);
        assert_eq!(rt.state.shell_ui.menu_bar.open_menu_idx, Some(0));
        assert!(element_rect(&rt, MENU_DROPDOWN_MODAL_KEY).is_some());

        // Clicking outside dismisses the modal dropdown.
        rt.pointer_down(900.0, 500.0);
        rt.pointer_up(900.0, 500.0);
        rt.frame(0.016);
        assert_eq!(rt.state.shell_ui.menu_bar.open_menu_idx, None);
        assert!(element_rect(&rt, MENU_DROPDOWN_MODAL_KEY).is_none());
    }

    #[test]
    fn arrow_navigation_and_alt_mnemonics_skip_separators_and_disabled_items() {
        let mut rt = make_runtime(DesktopPlatformOverride::Linux, (1280.0, 820.0), 0.0, |s| {
            // In Settings view, `view.toggle_sidebar` is disabled, and at default 1.0 zoom `view.reset_zoom` is disabled.
            s.dispatch(Action::Navigate(crate::actions::NavAction::OpenSettings(
                Some(SettingsPageId::Models),
            )));
            assert_eq!(s.route().view, ViewId::Settings);
        });

        // Alt+V opens View dropdown directly.
        rt.key(KeyEvent {
            key: Key::Text("v".to_string()),
            mods: Mods {
                alt: true,
                ..Default::default()
            },
        });
        rt.frame(0.016);
        assert_eq!(rt.state.shell_ui.menu_bar.open_menu_idx, Some(2));
        // Item 0 (`Toggle Sidebar`, disabled), Item 1 (Separator), Item 2 (`Actual Size`, disabled) -> lands on Item 3 (`Zoom In`).
        assert_eq!(rt.state.shell_ui.menu_bar.active_item_idx, Some(3));

        // ArrowDown skips to Item 4 (`Zoom Out`).
        rt.key(KeyEvent::from(Key::Down));
        rt.frame(0.016);
        assert_eq!(rt.state.shell_ui.menu_bar.active_item_idx, Some(4));

        // ArrowDown again skips Item 5 (Separator) and lands on Item 6 (`Toggle Full Screen`).
        rt.key(KeyEvent::from(Key::Down));
        rt.frame(0.016);
        assert_eq!(rt.state.shell_ui.menu_bar.active_item_idx, Some(6));

        // ArrowRight wraps to Window (`3`), then Help (`4`).
        rt.key(KeyEvent::from(Key::Right));
        rt.frame(0.016);
        assert_eq!(rt.state.shell_ui.menu_bar.open_menu_idx, Some(3));
    }

    #[test]
    fn menu_item_activation_restores_focus_and_queues_menu_command() {
        fn composer_focused_root(s: &AppState, cx: &mut rune::Cx<AppState>) -> El {
            let dark = s.effective_dark(cx.system_dark());
            let (kit, tokens) = crate::theme::build_kit_with_accent(
                dark,
                s.desktop_settings.reduced_transparency,
                s.desktop_settings.high_contrast,
                s.desktop_settings.accent_palette,
            );
            cx.web_focus();
            let mut layer = Vec::new();
            let toolbar = crate::views::shell::top_bar::build_toolbar(
                s, cx, &kit, &tokens, 1040.0, true, &mut layer,
            );
            let input = rune::text_input(&s.composer_edit, tokens.body)
                .key("composer-input")
                .autofocus()
                .on_edit(|state: &mut AppState| &mut state.composer_edit);
            crate::views::shell::menu_bar::push_menu_bar_overlay(
                s,
                &kit,
                &tokens,
                Some(1040.0),
                0.0,
                &mut layer,
            );
            let split = crate::views::shell::FullBleedSplit::new(el().padding(20.0).child(input))
                .toolbar(toolbar)
                .hide_sidebar_toggle()
                .build(&kit);
            el().w_full().h_full().child(split).children(layer)
        }

        let mut s = AppState {
            scene_mode: true,
            menu_platform_override: Some(DesktopPlatformOverride::Windows),
            system_dark_override: Some(false),
            composer_edit: TextEdit::new("hello world"),
            ..Default::default()
        };
        s.desktop_settings.theme = ThemePreference::Light;
        s.shell_ui.viewport_width = 1280.0;
        s.composer_edit.focused = true;

        let mut rt = Runtime::new(
            s,
            composer_focused_root,
            (1280.0, 820.0),
            Env::new(true, 1.0),
        );
        rt.set_modifier_keys(true);
        rt.on_key = Some(crate::views::shell::handle_key);
        rt.frame(0.0);
        rt.frame(0.016);

        // Press F10 (saves `"composer-input"`), Right to `Edit`, Down to open Edit, Down to `Select All` (or Paste), Enter to execute.
        rt.key(KeyEvent::from(Key::Function(10)));
        rt.frame(0.016);
        assert_eq!(
            rt.state.shell_ui.menu_bar.saved_focus_key.as_deref(),
            Some("composer-input")
        );
        rt.key(KeyEvent::from(Key::Right));
        rt.frame(0.016);
        assert_eq!(rt.state.shell_ui.menu_bar.focused_top_idx, Some(1));

        rt.key(KeyEvent::from(Key::Down));
        rt.frame(0.016);
        assert_eq!(rt.state.shell_ui.menu_bar.open_menu_idx, Some(1));
        assert_eq!(rt.state.shell_ui.menu_bar.active_item_idx, Some(0)); // Undo

        // Navigate down to Copy (`entry 4`: Undo=0, Redo=1, Sep=2, Cut=3, Copy=4, Paste=5, SelectAll=6).
        rt.key(KeyEvent::from(Key::Down)); // Redo
        rt.key(KeyEvent::from(Key::Down)); // Cut (skips Sep)
        rt.key(KeyEvent::from(Key::Down)); // Copy
        rt.frame(0.016);
        assert_eq!(rt.state.shell_ui.menu_bar.active_item_idx, Some(4));

        rt.key(KeyEvent::from(Key::Enter));
        rt.frame(0.016);
        assert_eq!(rt.state.pending_menu_command.as_deref(), Some("edit.copy"));
        assert!(!rt.state.shell_ui.menu_bar.is_active());
        // Focus was returned directly to composer-input so poll_app dispatches edit.copy against it.
        assert!(rt.state.composer_edit.focused);

        // Dispatch queued menu command cleanly as poll_app does, and test mnemonic parsing too.
        let pending = rt.state.pending_menu_command.take().unwrap();
        assert!(crate::dispatch_menu_command_with_tx(
            &mut rt.state,
            &mut rune::Tx::default(),
            &pending
        ));
    }

    #[test]
    fn parse_mnemonic_label_handles_ampersands_and_escaped_double_ampersand() {
        assert_eq!(
            parse_mnemonic_label("&File"),
            ("File".to_string(), Some((0, 1)), Some('F'))
        );
        assert_eq!(
            parse_mnemonic_label("Save && &Exit"),
            ("Save & Exit".to_string(), Some((7, 8)), Some('E'))
        );
        assert_eq!(
            parse_mnemonic_label("About"),
            ("About".to_string(), None, None)
        );
    }

    #[test]
    fn checkmarks_and_platform_shortcuts_render_inside_view_dropdown() {
        let mut rt = make_runtime(
            DesktopPlatformOverride::Windows,
            (1280.0, 820.0),
            138.0,
            |s| {
                s.dispatch(Action::Shell(ShellAction::SetSidebarOpen(true)));
            },
        );
        let view_btn = element_rect(&rt, &menu_btn_key(2)).expect("View button");
        rt.pointer_down(view_btn[0] + 10.0, view_btn[1] + 10.0);
        rt.pointer_up(view_btn[0] + 10.0, view_btn[1] + 10.0);
        rt.frame(0.016);

        let dumped = format!("{:#?}", rt.elements());
        assert!(dumped.contains("Toggle Sidebar"));
        assert!(dumped.contains("Ctrl+B"));
        assert!(dumped.contains("F11"));

        // Switch to Edit menu and confirm Windows uses Ctrl+Y for Redo.
        let edit_btn = element_rect(&rt, &menu_btn_key(1)).expect("Edit button");
        rt.pointer_move(edit_btn[0] + 10.0, edit_btn[1] + 10.0);
        rt.frame(0.016);
        let edit_dump = format!("{:#?}", rt.elements());
        assert!(edit_dump.contains("Ctrl+Y"));
    }

    #[test]
    fn f10_bar_focus_dismisses_on_click_outside_and_tab_while_allowing_top_item_click() {
        // Hidden menu bar: F10 reveals & mounts focus backdrop, clicking outside dismisses & hides.
        let mut hidden_rt =
            make_runtime(DesktopPlatformOverride::Linux, (1280.0, 820.0), 0.0, |s| {
                s.desktop_settings.show_menu_bar = false;
            });
        hidden_rt.key(KeyEvent::from(Key::Function(10)));
        hidden_rt.frame(0.016);
        assert!(hidden_rt.state.shell_ui.menu_bar.temp_revealed);
        assert_eq!(hidden_rt.state.shell_ui.menu_bar.focused_top_idx, Some(0));
        assert!(hidden_rt.state.shell_ui.menu_bar.show_mnemonics);
        assert!(element_rect(&hidden_rt, MENU_FOCUS_BACKDROP_KEY).is_some());
        assert!(element_rect(&hidden_rt, MENU_STRIP_KEY).is_some());

        // Clicking into the main pane / composer dismisses temporary reveal, bar focus, and focus ring.
        hidden_rt.pointer_down(600.0, 750.0);
        hidden_rt.pointer_up(600.0, 750.0);
        hidden_rt.frame(0.016);
        assert!(!hidden_rt.state.shell_ui.menu_bar.temp_revealed);
        assert_eq!(hidden_rt.state.shell_ui.menu_bar.focused_top_idx, None);
        assert!(!hidden_rt.state.shell_ui.menu_bar.show_mnemonics);
        assert!(!hidden_rt.state.shell_ui.menu_bar.is_active());
        assert!(element_rect(&hidden_rt, MENU_STRIP_KEY).is_none());
        assert!(element_rect(&hidden_rt, MENU_FOCUS_BACKDROP_KEY).is_none());
        assert!(!hidden_rt.elements().iter().any(|e| !e.exiting && e.focused));

        // Re-open with F10, then click directly on `Edit` through its top-item bridge -> opens Edit.
        hidden_rt.key(KeyEvent::from(Key::Function(10)));
        hidden_rt.frame(0.016);
        let edit_btn = element_rect(&hidden_rt, &menu_btn_key(1)).expect("Edit button");
        hidden_rt.pointer_down(edit_btn[0] + 10.0, edit_btn[1] + 10.0);
        hidden_rt.pointer_up(edit_btn[0] + 10.0, edit_btn[1] + 10.0);
        hidden_rt.frame(0.016);
        assert_eq!(hidden_rt.state.shell_ui.menu_bar.open_menu_idx, Some(1));
        assert!(element_rect(&hidden_rt, MENU_DROPDOWN_MODAL_KEY).is_some());

        // Visible menu bar: F10 -> Tab moves focus out and clears bar focus/mnemonics.
        let mut visible_rt =
            make_runtime(DesktopPlatformOverride::Linux, (1280.0, 820.0), 0.0, |_| {});
        visible_rt.key(KeyEvent::from(Key::Function(10)));
        visible_rt.frame(0.016);
        assert_eq!(visible_rt.state.shell_ui.menu_bar.focused_top_idx, Some(0));
        assert!(
            visible_rt
                .elements()
                .iter()
                .any(|e| !e.exiting && e.focused && e.key.as_deref() == Some("menu-bar-item-0"))
        );

        visible_rt.key(KeyEvent::from(Key::Tab));
        visible_rt.frame(0.016);
        assert_eq!(visible_rt.state.shell_ui.menu_bar.focused_top_idx, None);
        assert!(!visible_rt.state.shell_ui.menu_bar.show_mnemonics);
        assert!(!visible_rt.state.shell_ui.menu_bar.is_active());
        assert!(element_rect(&visible_rt, MENU_FOCUS_BACKDROP_KEY).is_none());
        assert!(!visible_rt.elements().iter().any(|e| !e.exiting
            && e.focused
            && e.key.as_deref().is_some_and(|k| k.starts_with("menu-bar-"))));

        // Shift+Tab from F10 bar focus also exits the entire menu strip cleanly.
        visible_rt.key(KeyEvent::from(Key::Function(10)));
        visible_rt.frame(0.016);
        assert_eq!(visible_rt.state.shell_ui.menu_bar.focused_top_idx, Some(0));
        visible_rt.key(KeyEvent {
            key: Key::Tab,
            mods: Mods {
                shift: true,
                ..Default::default()
            },
        });
        visible_rt.frame(0.016);
        assert_eq!(visible_rt.state.shell_ui.menu_bar.focused_top_idx, None);
        assert!(!visible_rt.state.shell_ui.menu_bar.show_mnemonics);
        assert!(!visible_rt.elements().iter().any(|e| !e.exiting
            && e.focused
            && e.key.as_deref().is_some_and(|k| k.starts_with("menu-bar-"))));
    }

    #[test]
    fn chat_with_background_active_task_uses_context_rail_width_for_menu_bar() {
        let mut rt = make_runtime(DesktopPlatformOverride::Linux, (860.0, 820.0), 0.0, |s| {
            // `ViewId::Chat` with a background `active_task` and collapsed context sidebar:
            // primary pane stays >= 520px wide (860 - 260 = 600px), so the toolbar stays inline.
            s.dispatch(Action::Shell(ShellAction::SetSidebarOpen(true)));
            s.dispatch(Action::Shell(ShellAction::SetContextSidebarOpen(false)));
            s.active_task = Some(crate::state::TaskRecordView::default());
        });

        assert_eq!(rt.state.route().view, ViewId::Chat);
        assert!(element_rect(&rt, MENU_STRIP_KEY).is_some());
        assert!(element_rect(&rt, MENU_HAMBURGER_KEY).is_none());

        // Keyboard F10 / Alt+V must match the wide inline strip rather than triggering narrow `"☰"` mode.
        rt.key(KeyEvent {
            key: Key::Text("v".to_string()),
            mods: Mods {
                alt: true,
                ..Default::default()
            },
        });
        rt.frame(0.016);
        assert!(!rt.state.shell_ui.menu_bar.narrow_menu_open);
        assert_eq!(rt.state.shell_ui.menu_bar.open_menu_idx, Some(2));
        assert!(element_rect(&rt, MENU_DROPDOWN_MODAL_KEY).is_some());
    }
}
