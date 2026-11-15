//! System tray icon (macOS via `tray-icon`; Linux/Windows via `rune::tray::Tray`) and
//! global Quick Chat shortcut registration (`AppHandle::register_shortcut`), matching
//! `apps/desktop/electron/services/quickChatController.ts` and `trayIcon.ts`.

use std::str::FromStr;
#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

#[cfg(not(target_os = "macos"))]
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

fn build_tray_bitmap_rgba(size: usize) -> Vec<u8> {
    // Simple high-contrast geometric glyph so tray backends have valid straight-RGBA pixels
    // (18x18 template mask on macOS, 16x16 on Linux/Windows) without runtime asset deps.
    let mut rgba = vec![0u8; size * size * 4];
    let margin = 2usize.min(size / 4);
    let max_coord = size.saturating_sub(1 + margin);
    let inner_min = size / 3;
    let inner_max = size.saturating_sub(1 + inner_min);
    for y in 0..size {
        for x in 0..size {
            let in_outer = (margin..=max_coord).contains(&x) && (margin..=max_coord).contains(&y);
            let border =
                in_outer && (x == margin || x == max_coord || y == margin || y == max_coord);
            let inner =
                (inner_min..=inner_max).contains(&x) && (inner_min..=inner_max).contains(&y);
            if border || inner {
                let idx = (y * size + x) * 4;
                rgba[idx] = 240;
                rgba[idx + 1] = 240;
                rgba[idx + 2] = 245;
                rgba[idx + 3] = 255;
            }
        }
    }
    rgba
}

fn handle_tray_activate(handle: &AppHandle<AppState>) {
    handle.update(|state, _| {
        state.apply_store_event(StoreEvent::QuickChatToggled);
    });
    reveal_and_activate_main_window(handle);
}

fn handle_tray_menu_action(handle: &AppHandle<AppState>, id: &str) {
    match id {
        "quick_chat" => handle_tray_activate(handle),
        "new_chat" => {
            handle.update(|state, _| {
                state.apply_store_event(StoreEvent::MenuInvoked("new_chat".to_string()));
            });
            reveal_and_activate_main_window(handle);
        }
        "show_main" => {
            reveal_and_activate_main_window(handle);
        }
        "quit" => {
            handle.quit();
        }
        _ => {}
    }
}

#[cfg(not(target_os = "macos"))]
fn default_tray_bitmap() -> TrayIcon {
    TrayIcon::rgba(16, 16, build_tray_bitmap_rgba(16))
}

#[cfg(not(target_os = "macos"))]
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

#[cfg(target_os = "macos")]
mod macos_tray {
    use std::cell::RefCell;
    use std::sync::{Mutex, Once, OnceLock};

    use rune::AppHandle;
    use serde_json::json;
    use tray_icon::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
    use tray_icon::{
        Icon as TrayIconBitmap, MouseButton, MouseButtonState, TrayIcon as MacOsTrayIcon,
        TrayIconBuilder, TrayIconEvent,
    };

    use crate::state::AppState;

    use super::super::local_logs::LocalLogger;
    use super::{TRAY_ID, build_tray_bitmap_rgba, handle_tray_activate, handle_tray_menu_action};

    // `!Send` AppKit objects live exclusively inside the main UI thread's `thread_local!`.
    struct MacOsTrayHandle {
        _tray: MacOsTrayIcon,
        _menu: Menu,
    }

    thread_local! {
        static MACOS_TRAY: RefCell<Option<MacOsTrayHandle>> = const { RefCell::new(None) };
    }

    static HANDLERS_INIT: Once = Once::new();
    static TRAY_APP_HANDLE: OnceLock<Mutex<Option<AppHandle<AppState>>>> = OnceLock::new();

    fn app_handle_slot() -> &'static Mutex<Option<AppHandle<AppState>>> {
        TRAY_APP_HANDLE.get_or_init(|| Mutex::new(None))
    }

    pub(super) fn set_app_handle(handle: Option<AppHandle<AppState>>) {
        *app_handle_slot().lock().unwrap_or_else(|e| e.into_inner()) = handle;
    }

    fn current_handle() -> Option<AppHandle<AppState>> {
        app_handle_slot()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    fn ensure_event_handlers() {
        HANDLERS_INIT.call_once(|| {
            TrayIconEvent::set_event_handler(Some(|ev: TrayIconEvent| {
                if let TrayIconEvent::Click {
                    id,
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = ev
                    && id.as_ref() == TRAY_ID
                    && let Some(handle) = current_handle()
                {
                    handle_tray_activate(&handle);
                }
            }));
            MenuEvent::set_event_handler(Some(|ev: MenuEvent| {
                if let Some(handle) = current_handle() {
                    handle_tray_menu_action(&handle, ev.id.as_ref());
                }
            }));
        });
    }

    fn macos_tray_bitmap() -> Result<TrayIconBitmap, String> {
        TrayIconBitmap::from_rgba(build_tray_bitmap_rgba(18), 18, 18).map_err(|err| err.to_string())
    }

    fn build_macos_menu() -> Result<Menu, String> {
        let quick_chat = MenuItem::with_id("quick_chat", "Open Quick Chat", true, None);
        let new_chat = MenuItem::with_id("new_chat", "New Chat", true, None);
        let sep1 = PredefinedMenuItem::separator();
        let show_main = MenuItem::with_id("show_main", "Show Cowork", true, None);
        let sep2 = PredefinedMenuItem::separator();
        let quit = MenuItem::with_id("quit", "Quit Cowork", true, None);

        Menu::with_items(&[&quick_chat, &new_chat, &sep1, &show_main, &sep2, &quit])
            .map_err(|err| err.to_string())
    }

    fn create_macos_tray() -> Result<MacOsTrayHandle, String> {
        ensure_event_handlers();
        let icon = macos_tray_bitmap()?;
        let menu = build_macos_menu()?;
        let tray = TrayIconBuilder::new()
            .with_id(TRAY_ID)
            .with_tooltip("Cowork")
            .with_icon_templated(icon)
            .with_menu(Box::new(menu.clone()))
            .with_menu_on_left_click(false)
            .with_menu_on_right_click(true)
            .with_autosave_name(TRAY_ID)
            .build()
            .map_err(|err| err.to_string())?;
        Ok(MacOsTrayHandle {
            _tray: tray,
            _menu: menu,
        })
    }

    pub(super) fn sync_tray_on_main_thread(should_show: bool, logger: Option<&LocalLogger>) {
        if !should_show {
            destroy_tray();
            return;
        }
        if MACOS_TRAY.with(|cell| cell.borrow().is_some()) {
            return;
        }
        match create_macos_tray() {
            Ok(tray_handle) => {
                MACOS_TRAY.with(|cell| {
                    *cell.borrow_mut() = Some(tray_handle);
                });
            }
            Err(err) => {
                if let Some(logger) = logger {
                    let meta = json!({ "error": err });
                    logger.warn("tray", "failed to create macOS tray icon", Some(&meta));
                }
            }
        }
    }

    pub(super) fn destroy_tray() {
        MACOS_TRAY.with(|cell| {
            *cell.borrow_mut() = None;
        });
    }
}

#[derive(Default)]
struct TrayControllerInner {
    #[cfg(not(target_os = "macos"))]
    tray: Option<Tray>,
    #[cfg(not(target_os = "macos"))]
    tray_unsupported_logged: bool,
    #[cfg(target_os = "macos")]
    macos_tray_desired: bool,
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
    #[cfg(target_os = "macos")]
    macos_desired: Arc<AtomicBool>,
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
            #[cfg(target_os = "macos")]
            macos_desired: Arc::new(AtomicBool::new(false)),
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
        #[cfg(not(target_os = "macos"))]
        {
            guard.tray = None;
        }
        #[cfg(target_os = "macos")]
        {
            guard.macos_tray_desired = false;
            self.macos_desired.store(false, Ordering::Release);
            macos_tray::set_app_handle(None);
            if let Some(handle) = app_handle {
                handle.update(|_state, _tx| {
                    macos_tray::destroy_tray();
                });
            }
        }
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

        #[cfg(target_os = "macos")]
        {
            let Some(handle) = app_handle.cloned() else {
                if !should_show {
                    guard.macos_tray_desired = false;
                    self.macos_desired.store(false, Ordering::Release);
                    macos_tray::set_app_handle(None);
                }
                return;
            };

            if guard.macos_tray_desired == should_show {
                if should_show {
                    macos_tray::set_app_handle(Some(handle));
                }
                return;
            }

            guard.macos_tray_desired = should_show;
            self.macos_desired.store(should_show, Ordering::Release);
            macos_tray::set_app_handle(if should_show {
                Some(handle.clone())
            } else {
                None
            });

            let desired_flag = self.macos_desired.clone();
            let logger = self.logger.clone();
            handle.update(move |_state, _tx| {
                macos_tray::sync_tray_on_main_thread(
                    desired_flag.load(Ordering::Acquire),
                    logger.as_deref(),
                );
            });
        }

        #[cfg(not(target_os = "macos"))]
        {
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
                TrayEvent::Activate { .. } => handle_tray_activate(&handle),
                TrayEvent::Menu(id) => handle_tray_menu_action(&handle, &id),
                _ => {}
            }) {
                Ok(tray) => {
                    guard.tray = Some(tray);
                }
                Err(TrayError::Unsupported) => {
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

    #[test]
    fn builds_non_empty_tray_bitmap_for_macos_and_standard_sizes() {
        for size in [16usize, 18usize] {
            let rgba = build_tray_bitmap_rgba(size);
            assert_eq!(rgba.len(), size * size * 4);
            let opaque_count = rgba.chunks_exact(4).filter(|px| px[3] == 255).count();
            let transparent_count = rgba.chunks_exact(4).filter(|px| px[3] == 0).count();
            assert!(opaque_count > 0);
            assert!(transparent_count > 0);
        }
    }
}
