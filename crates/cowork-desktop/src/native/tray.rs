//! System tray icon (Linux/Windows via `rune::tray::Tray`; documented gap on macOS) and
//! global Quick Chat shortcut registration (`AppHandle::register_shortcut`), matching
//! `apps/desktop/electron/services/quickChatController.ts` and `trayIcon.ts`.

use std::str::FromStr;
use std::sync::{Arc, Mutex};

use rune::tray::{Tray, TrayError, TrayEvent, TrayIcon, TrayItem, TraySpec};
use rune::{AppHandle, Shortcut, ShortcutId};
use serde_json::json;

use crate::actions::StoreEvent;
use crate::state::{AppState, DesktopSettings};

use super::local_logs::LocalLogger;
use super::window_lifecycle::reveal_and_activate_main_window;

pub const DEFAULT_QUICK_CHAT_ACCELERATOR: &str = "CommandOrControl+Shift+Space";
const TRAY_ID: &str = "ai.cowork.desktop";

/// Normalizes Electron-style accelerator strings (e.g. `CommandOrControl+Shift+Space`)
/// into Rune's [`Shortcut`] syntax (`mod+shift+space`).
pub fn parse_quick_chat_shortcut(raw: &str) -> Result<Shortcut, String> {
    let trimmed = raw.trim();
    let candidate = if trimmed.is_empty() {
        DEFAULT_QUICK_CHAT_ACCELERATOR
    } else {
        trimmed
    };

    let mut normalized_parts = Vec::new();
    for segment in candidate.split('+') {
        let token = segment.trim();
        if token.is_empty() {
            continue;
        }
        let mapped = match token.to_ascii_lowercase().as_str() {
            "commandorcontrol" | "cmdorctrl" => "mod".to_string(),
            "command" | "cmd" | "super" | "meta" => "super".to_string(),
            "control" | "ctrl" => "ctrl".to_string(),
            "option" | "opt" | "alt" => "alt".to_string(),
            "shift" => "shift".to_string(),
            "spacebar" | "space" => "space".to_string(),
            other => other.to_string(),
        };
        normalized_parts.push(mapped);
    }

    let joined = normalized_parts.join("+");
    Shortcut::from_str(&joined).map_err(|err| err.to_string())
}

fn default_tray_bitmap() -> TrayIcon {
    // Simple 16x16 high-contrast geometric glyph so Tray::new has valid straight-RGBA pixels
    // without external image asset dependencies at runtime.
    let size = 16usize;
    let mut rgba = vec![0u8; size * size * 4];
    for y in 0..size {
        for x in 0..size {
            let border = x == 2 || x == size - 3 || y == 2 || y == size - 3;
            let inner = (5..=10).contains(&x) && (5..=10).contains(&y);
            if border || inner {
                let idx = (y * size + x) * 4;
                rgba[idx] = 240;
                rgba[idx + 1] = 240;
                rgba[idx + 2] = 245;
                rgba[idx + 3] = 255;
            }
        }
    }
    TrayIcon::rgba(size as u32, size as u32, rgba)
}

fn build_tray_menu() -> Vec<TrayItem> {
    vec![
        TrayItem::action("quick_chat", "Open Quick Chat"),
        TrayItem::action("new_chat", "New Chat"),
        TrayItem::Separator,
        TrayItem::action("show_main", "Show Cowork"),
        TrayItem::Separator,
        TrayItem::action("quit", "Quit Cowork"),
    ]
}

#[derive(Default)]
struct TrayControllerInner {
    tray: Option<Tray>,
    tray_unsupported_logged: bool,
    shortcut_id: Option<ShortcutId>,
    registered_accelerator: Option<String>,
    quick_chat_icon_enabled: bool,
    quick_chat_shortcut_enabled: bool,
    quick_chat_accelerator: String,
    menu_bar_enabled: bool,
}

/// Manages system tray presence and the global Quick Chat shortcut registration.
#[derive(Clone, Default)]
pub struct QuickChatTrayController {
    inner: Arc<Mutex<TrayControllerInner>>,
    logger: Option<Arc<LocalLogger>>,
}

impl QuickChatTrayController {
    pub fn new(logger: Option<Arc<LocalLogger>>) -> Self {
        Self {
            inner: Arc::new(Mutex::new(TrayControllerInner {
                menu_bar_enabled: true,
                quick_chat_icon_enabled: true,
                quick_chat_accelerator: DEFAULT_QUICK_CHAT_ACCELERATOR.to_string(),
                ..Default::default()
            })),
            logger,
        }
    }

    pub fn sync_from_settings(
        &self,
        settings: &DesktopSettings,
        menu_bar_enabled: bool,
        app_handle: Option<&AppHandle<AppState>>,
    ) {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard.menu_bar_enabled = menu_bar_enabled;
        guard.quick_chat_icon_enabled = settings.quick_chat_icon_enabled;
        guard.quick_chat_shortcut_enabled = settings.quick_chat_shortcut_enabled;
        guard.quick_chat_accelerator = if settings.quick_chat_shortcut.trim().is_empty() {
            DEFAULT_QUICK_CHAT_ACCELERATOR.to_string()
        } else {
            settings.quick_chat_shortcut.clone()
        };

        self.sync_tray_locked(&mut guard, app_handle);
        self.sync_shortcut_locked(&mut guard, app_handle);
    }

    pub fn teardown(&self, app_handle: Option<&AppHandle<AppState>>) {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard.tray = None;
        if let (Some(id), Some(handle)) = (guard.shortcut_id.take(), app_handle) {
            let _ = handle.unregister_shortcut(id);
        }
        guard.registered_accelerator = None;
    }

    fn sync_tray_locked(
        &self,
        guard: &mut TrayControllerInner,
        app_handle: Option<&AppHandle<AppState>>,
    ) {
        let should_show = guard.menu_bar_enabled && guard.quick_chat_icon_enabled;
        if !should_show {
            guard.tray = None;
            return;
        }
        if guard.tray.is_some() {
            return;
        }
        let Some(handle) = app_handle.cloned() else {
            return;
        };

        let spec = TraySpec::new(TRAY_ID, "Cowork", default_tray_bitmap())
            .tooltip("Cowork")
            .menu(build_tray_menu());

        match Tray::new(spec, move |event| match event {
            TrayEvent::Activate { .. } => {
                handle.update(|state, _| {
                    state.apply_store_event(StoreEvent::QuickChatToggled);
                });
                reveal_and_activate_main_window(&handle);
            }
            TrayEvent::Menu(id) => match id.as_str() {
                "quick_chat" => {
                    handle.update(|state, _| {
                        state.apply_store_event(StoreEvent::QuickChatToggled);
                    });
                    reveal_and_activate_main_window(&handle);
                }
                "new_chat" => {
                    handle.update(|state, _| {
                        state.apply_store_event(StoreEvent::MenuInvoked("new_chat".to_string()));
                    });
                    reveal_and_activate_main_window(&handle);
                }
                "show_main" => {
                    reveal_and_activate_main_window(&handle);
                }
                "quit" => {
                    handle.quit();
                }
                _ => {}
            },
            _ => {}
        }) {
            Ok(tray) => {
                guard.tray = Some(tray);
            }
            Err(TrayError::Unsupported) => {
                // Rune currently implements Tray on Linux (SNI/D-Bus) and Windows only;
                // macOS NSStatusBar tray stays a documented gap until Rune adds it.
                if !guard.tray_unsupported_logged {
                    guard.tray_unsupported_logged = true;
                    if let Some(logger) = &self.logger {
                        logger.info(
                            "tray",
                            "system tray icon skipped on unsupported host platform",
                            None,
                        );
                    }
                }
            }
            Err(err) => {
                if let Some(logger) = &self.logger {
                    let meta = json!({ "error": err.to_string() });
                    logger.warn("tray", "failed to create system tray icon", Some(&meta));
                }
            }
        }
    }

    fn sync_shortcut_locked(
        &self,
        guard: &mut TrayControllerInner,
        app_handle: Option<&AppHandle<AppState>>,
    ) {
        let Some(handle) = app_handle else {
            return;
        };

        let desired = if guard.quick_chat_shortcut_enabled {
            Some(guard.quick_chat_accelerator.clone())
        } else {
            None
        };

        if desired == guard.registered_accelerator {
            return;
        }

        if let Some(prev_id) = guard.shortcut_id.take() {
            let _ = handle.unregister_shortcut(prev_id);
        }
        guard.registered_accelerator = None;

        let Some(raw_accel) = desired else {
            return;
        };
        let shortcut = match parse_quick_chat_shortcut(&raw_accel) {
            Ok(sc) => sc,
            Err(err) => {
                if let Some(logger) = &self.logger {
                    let meta = json!({ "accelerator": raw_accel, "error": err });
                    logger.warn("tray", "invalid quick chat global shortcut", Some(&meta));
                }
                return;
            }
        };

        let handle_for_cb = handle.clone();
        match handle.register_shortcut(shortcut, move |state: &mut AppState, _tx| {
            state.apply_store_event(StoreEvent::QuickChatToggled);
            reveal_and_activate_main_window(&handle_for_cb);
        }) {
            Ok(id) => {
                guard.shortcut_id = Some(id);
                guard.registered_accelerator = Some(raw_accel);
            }
            Err(err) => {
                if let Some(logger) = &self.logger {
                    let meta = json!({ "accelerator": raw_accel, "error": err.to_string() });
                    logger.warn(
                        "tray",
                        "failed to register quick chat global shortcut",
                        Some(&meta),
                    );
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_electron_and_rune_accelerators() {
        assert!(parse_quick_chat_shortcut(DEFAULT_QUICK_CHAT_ACCELERATOR).is_ok());
        assert!(parse_quick_chat_shortcut("CmdOrCtrl+Shift+Space").is_ok());
        assert!(parse_quick_chat_shortcut("Alt+Space").is_ok());
        assert!(parse_quick_chat_shortcut("not-a-valid-key-xyz").is_err());
    }
}
