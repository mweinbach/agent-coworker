//! Shared declarative application menu bar model, macOS `rune::native_menu` driver,
//! unified menu command dispatch (`&mut AppState`, `&mut rune::Tx`), and native popup
//! context menus (`rune::PopupMenu`), matching `apps/desktop/electron/services/menuTemplate.ts`
//! and `menuCommandDispatcher.ts`.

use std::sync::{Mutex, OnceLock};

use rune::{App, MenuItem, PopupItem, PopupMenu, Shortcut, Tx};

use crate::router::ViewId;
use crate::shortcut_label_for_platform;
use crate::state::{
    AppState, DEFAULT_UI_SCALE, DesktopPlatformOverride, MAX_UI_SCALE, MIN_UI_SCALE, WindowMode,
};

const ZOOM_BOUND_EPSILON: f32 = 0.001;

/// Target platform variant for the declarative application menu bar.
pub type MenuPlatform = DesktopPlatformOverride;

/// Semantic menu item role aligned with Electron `menuTemplate.ts` and Rune `standard_menus`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum MenuRole {
    About,
    CheckForUpdates,
    Services,
    Hide,
    HideOthers,
    ShowAll,
    Quit,
    NewChat,
    OpenQuickChat,
    OpenSkills,
    CommandPalette,
    Settings,
    WorkspaceSettings,
    CloseWindow,
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
    ToggleSidebar,
    ResetZoom,
    ZoomIn,
    ZoomOut,
    ToggleFullScreen,
    Minimize,
    Zoom,
    OpenExternalUrl,
}

/// Top-level menu in the shared declarative application menu bar.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApplicationMenu {
    /// Stable menu key (`"app"`, `"file"`, `"edit"`, `"view"`, `"window"`, `"help"`).
    pub id: &'static str,
    /// Raw label matching Electron (`"File"` on macOS, `"&File"` on Linux/Windows).
    pub label: &'static str,
    /// Display title stripped of `&` mnemonic markers (`"File"`).
    pub title: &'static str,
    /// Optional Alt-mnemonic character (`Some('F')` on Linux/Windows, `None` on macOS).
    pub mnemonic: Option<char>,
    pub items: Vec<ApplicationMenuEntry>,
}

/// Single row inside an [`ApplicationMenu`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ApplicationMenuEntry {
    Separator,
    Item(ApplicationMenuItem),
}

/// Concrete interactive item inside an [`ApplicationMenu`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApplicationMenuItem {
    /// Stable unique item identifier (`"app.settings"`, `"file.new_chat"`, `"edit.paste"`, ...).
    pub id: &'static str,
    /// Command identifier passed to `dispatch_menu_command_with_tx` / `StoreEvent::MenuInvoked`.
    pub command_id: &'static str,
    /// Display label (`"Check for Updates…"` uses Unicode ellipsis matching Electron).
    pub label: &'static str,
    /// Optional submenu item mnemonic character (`None` unless defined).
    pub mnemonic: Option<char>,
    /// Raw Electron-style accelerator (`"Cmd+N"`, `"Ctrl+Cmd+F"`, `"F11"`, etc.).
    pub accelerator: Option<&'static str>,
    /// Platform-formatted badge produced via `crate::shortcut_label_for_platform`.
    pub shortcut_label: String,
    pub role: MenuRole,
    pub enabled: bool,
    pub checked: Option<bool>,
}

/// Legacy command enum mapping Cowork UI menu items to `StoreEvent::MenuInvoked` IDs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DesktopMenuCommand {
    NewChat,
    OpenSkills,
    OpenCommandPalette,
    OpenSettings,
    OpenWorkspacesSettings,
    ToggleSidebar,
    ResetZoom,
    ZoomIn,
    ZoomOut,
    OpenUpdates,
}

impl DesktopMenuCommand {
    pub fn as_id(self) -> &'static str {
        match self {
            Self::NewChat => "new_chat",
            Self::OpenSkills => "open_skills",
            Self::OpenCommandPalette => "command_palette",
            Self::OpenSettings => "settings",
            Self::OpenWorkspacesSettings => "open_workspaces_settings",
            Self::ToggleSidebar => "toggle_sidebar",
            Self::ResetZoom => "reset_zoom",
            Self::ZoomIn => "zoom_in",
            Self::ZoomOut => "zoom_out",
            Self::OpenUpdates => "open_updates",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct MenuSyncSignature {
    is_main_window: bool,
    in_settings: bool,
    sidebar_open: bool,
    ui_scale_hundredths: i32,
}

impl MenuSyncSignature {
    fn from_state(state: &AppState) -> Self {
        Self {
            is_main_window: state.window_mode == WindowMode::Main,
            in_settings: state.route().view == ViewId::Settings,
            sidebar_open: state.sidebar.is_open(),
            ui_scale_hundredths: (state.ui_scale * 100.0).round() as i32,
        }
    }
}

static LAST_MENU_SIGNATURE: OnceLock<Mutex<Option<MenuSyncSignature>>> = OnceLock::new();

fn last_menu_signature_slot() -> &'static Mutex<Option<MenuSyncSignature>> {
    LAST_MENU_SIGNATURE.get_or_init(|| Mutex::new(None))
}

fn split_mnemonic_title(raw: &'static str) -> (&'static str, Option<char>) {
    match raw {
        "&File" => ("File", Some('F')),
        "&Edit" => ("Edit", Some('E')),
        "&View" => ("View", Some('V')),
        "&Window" => ("Window", Some('W')),
        "&Help" => ("Help", Some('H')),
        _ => (raw, None),
    }
}

fn build_menu(
    id: &'static str,
    label: &'static str,
    items: Vec<ApplicationMenuEntry>,
) -> ApplicationMenu {
    let (title, mnemonic) = split_mnemonic_title(label);
    ApplicationMenu {
        id,
        label,
        title,
        mnemonic,
        items,
    }
}

struct MenuItemSpec {
    id: &'static str,
    command_id: &'static str,
    label: &'static str,
    accelerator: Option<&'static str>,
    role: MenuRole,
    enabled: bool,
    checked: Option<bool>,
}

fn menu_item(spec: MenuItemSpec, platform: MenuPlatform) -> ApplicationMenuEntry {
    let shortcut_label = spec
        .accelerator
        .map(|accel| shortcut_label_for_platform(accel, platform.is_macos()))
        .unwrap_or_default();
    ApplicationMenuEntry::Item(ApplicationMenuItem {
        id: spec.id,
        command_id: spec.command_id,
        label: spec.label,
        mnemonic: None,
        accelerator: spec.accelerator,
        shortcut_label,
        role: spec.role,
        enabled: spec.enabled,
        checked: spec.checked,
    })
}

/// Builds the full declarative application menu bar for the active runtime platform.
pub fn build_application_menu(state: &AppState) -> Vec<ApplicationMenu> {
    build_application_menu_for_platform(state, state.effective_desktop_platform())
}

/// Builds the full declarative application menu bar for an explicit target `platform`.
///
/// Matches `apps/desktop/electron/services/menuTemplate.ts` across macOS, Linux, and Windows,
/// omitting Electron's Chromium-only DevTools/Reload items because Cowork is native Rust/Rune
/// (and `Opt+Cmd+I` already controls the Context Sidebar).
pub fn build_application_menu_for_platform(
    state: &AppState,
    platform: MenuPlatform,
) -> Vec<ApplicationMenu> {
    let is_macos = platform.is_macos();
    let is_main_window = state.window_mode == WindowMode::Main;
    let can_toggle_sidebar = is_main_window && state.route().view != ViewId::Settings;
    let can_zoom_in = state.ui_scale < MAX_UI_SCALE - ZOOM_BOUND_EPSILON;
    let can_zoom_out = state.ui_scale > MIN_UI_SCALE + ZOOM_BOUND_EPSILON;
    let can_reset_zoom = (state.ui_scale - DEFAULT_UI_SCALE).abs() > ZOOM_BOUND_EPSILON;

    let mut menus = Vec::with_capacity(if is_macos { 6 } else { 5 });

    if is_macos {
        menus.push(build_menu(
            "app",
            "Cowork",
            vec![
                menu_item(
                    MenuItemSpec {
                        id: "app.about",
                        command_id: "app.about",
                        label: "About Cowork",
                        accelerator: None,
                        role: MenuRole::About,
                        enabled: true,
                        checked: None,
                    },
                    platform,
                ),
                menu_item(
                    MenuItemSpec {
                        id: "app.check_for_updates",
                        command_id: "open_updates",
                        label: "Check for Updates…",
                        accelerator: None,
                        role: MenuRole::CheckForUpdates,
                        enabled: true,
                        checked: None,
                    },
                    platform,
                ),
                ApplicationMenuEntry::Separator,
                menu_item(
                    MenuItemSpec {
                        id: "app.settings",
                        command_id: "settings",
                        label: "Settings…",
                        accelerator: Some("Cmd+,"),
                        role: MenuRole::Settings,
                        enabled: true,
                        checked: None,
                    },
                    platform,
                ),
                ApplicationMenuEntry::Separator,
                menu_item(
                    MenuItemSpec {
                        id: "app.services",
                        command_id: "app.services",
                        label: "Services",
                        accelerator: None,
                        role: MenuRole::Services,
                        enabled: true,
                        checked: None,
                    },
                    platform,
                ),
                ApplicationMenuEntry::Separator,
                menu_item(
                    MenuItemSpec {
                        id: "app.hide",
                        command_id: "app.hide",
                        label: "Hide Cowork",
                        accelerator: Some("Cmd+H"),
                        role: MenuRole::Hide,
                        enabled: true,
                        checked: None,
                    },
                    platform,
                ),
                menu_item(
                    MenuItemSpec {
                        id: "app.hide_others",
                        command_id: "app.hide_others",
                        label: "Hide Others",
                        accelerator: Some("Opt+Cmd+H"),
                        role: MenuRole::HideOthers,
                        enabled: true,
                        checked: None,
                    },
                    platform,
                ),
                menu_item(
                    MenuItemSpec {
                        id: "app.show_all",
                        command_id: "app.show_all",
                        label: "Show All",
                        accelerator: None,
                        role: MenuRole::ShowAll,
                        enabled: true,
                        checked: None,
                    },
                    platform,
                ),
                ApplicationMenuEntry::Separator,
                menu_item(
                    MenuItemSpec {
                        id: "app.quit",
                        command_id: "app.quit",
                        label: "Quit Cowork",
                        accelerator: Some("Cmd+Q"),
                        role: MenuRole::Quit,
                        enabled: true,
                        checked: None,
                    },
                    platform,
                ),
            ],
        ));
    }

    let file_label = if is_macos { "File" } else { "&File" };
    let mut file_items = vec![
        menu_item(
            MenuItemSpec {
                id: "file.new_chat",
                command_id: "new_chat",
                label: "New Chat",
                accelerator: Some("Cmd+N"),
                role: MenuRole::NewChat,
                enabled: is_main_window,
                checked: None,
            },
            platform,
        ),
        menu_item(
            MenuItemSpec {
                id: "file.open_quick_chat",
                command_id: "open_quick_chat",
                label: "Open Quick Chat",
                accelerator: None,
                role: MenuRole::OpenQuickChat,
                enabled: true,
                checked: None,
            },
            platform,
        ),
        menu_item(
            MenuItemSpec {
                id: "file.open_skills",
                command_id: "open_skills",
                label: "Skills",
                accelerator: Some("Cmd+Shift+K"),
                role: MenuRole::OpenSkills,
                enabled: is_main_window,
                checked: None,
            },
            platform,
        ),
        menu_item(
            MenuItemSpec {
                id: "file.open_command_palette",
                command_id: "command_palette",
                label: "Command Palette",
                accelerator: Some("Cmd+K"),
                role: MenuRole::CommandPalette,
                enabled: is_main_window,
                checked: None,
            },
            platform,
        ),
        ApplicationMenuEntry::Separator,
        menu_item(
            MenuItemSpec {
                id: "file.open_settings",
                command_id: "settings",
                label: "Settings",
                // On macOS, `app.settings` owns `⌘,`; AppKit only grants an equivalent once.
                accelerator: if is_macos { None } else { Some("Cmd+,") },
                role: MenuRole::Settings,
                enabled: true,
                checked: None,
            },
            platform,
        ),
        menu_item(
            MenuItemSpec {
                id: "file.open_workspaces_settings",
                command_id: "open_workspaces_settings",
                label: "Workspace Settings",
                accelerator: None,
                role: MenuRole::WorkspaceSettings,
                enabled: is_main_window,
                checked: None,
            },
            platform,
        ),
        ApplicationMenuEntry::Separator,
    ];
    if is_macos {
        // Leave `⌘W` on `Window -> Close` via `standard_menus()` so AppKit open/save panels keep it.
        file_items.push(menu_item(
            MenuItemSpec {
                id: "file.close_window",
                command_id: "window.close",
                label: "Close Window",
                accelerator: None,
                role: MenuRole::CloseWindow,
                enabled: true,
                checked: None,
            },
            platform,
        ));
    } else {
        let quit_accel = match platform {
            MenuPlatform::Linux => Some("Ctrl+Q"),
            MenuPlatform::Windows | MenuPlatform::MacOs => None,
        };
        file_items.push(menu_item(
            MenuItemSpec {
                id: "file.quit",
                command_id: "app.quit",
                label: "Quit",
                accelerator: quit_accel,
                role: MenuRole::Quit,
                enabled: true,
                checked: None,
            },
            platform,
        ));
    }
    menus.push(build_menu("file", file_label, file_items));

    let redo_accel = match platform {
        MenuPlatform::Windows => Some("Ctrl+Y"),
        MenuPlatform::MacOs | MenuPlatform::Linux => Some("Cmd+Shift+Z"),
    };
    menus.push(build_menu(
        "edit",
        if is_macos { "Edit" } else { "&Edit" },
        vec![
            menu_item(
                MenuItemSpec {
                    id: "edit.undo",
                    command_id: "edit.undo",
                    label: "Undo",
                    accelerator: Some("Cmd+Z"),
                    role: MenuRole::Undo,
                    enabled: true,
                    checked: None,
                },
                platform,
            ),
            menu_item(
                MenuItemSpec {
                    id: "edit.redo",
                    command_id: "edit.redo",
                    label: "Redo",
                    accelerator: redo_accel,
                    role: MenuRole::Redo,
                    enabled: true,
                    checked: None,
                },
                platform,
            ),
            ApplicationMenuEntry::Separator,
            menu_item(
                MenuItemSpec {
                    id: "edit.cut",
                    command_id: "edit.cut",
                    label: "Cut",
                    accelerator: Some("Cmd+X"),
                    role: MenuRole::Cut,
                    enabled: true,
                    checked: None,
                },
                platform,
            ),
            menu_item(
                MenuItemSpec {
                    id: "edit.copy",
                    command_id: "edit.copy",
                    label: "Copy",
                    accelerator: Some("Cmd+C"),
                    role: MenuRole::Copy,
                    enabled: true,
                    checked: None,
                },
                platform,
            ),
            menu_item(
                MenuItemSpec {
                    id: "edit.paste",
                    command_id: "edit.paste",
                    label: "Paste",
                    accelerator: Some("Cmd+V"),
                    role: MenuRole::Paste,
                    enabled: true,
                    checked: None,
                },
                platform,
            ),
            menu_item(
                MenuItemSpec {
                    id: "edit.select_all",
                    command_id: "edit.select_all",
                    label: "Select All",
                    accelerator: Some("Cmd+A"),
                    role: MenuRole::SelectAll,
                    enabled: true,
                    checked: None,
                },
                platform,
            ),
        ],
    ));

    menus.push(build_menu(
        "view",
        if is_macos { "View" } else { "&View" },
        vec![
            menu_item(
                MenuItemSpec {
                    id: "view.toggle_sidebar",
                    command_id: "toggle_sidebar",
                    label: "Toggle Sidebar",
                    accelerator: Some("Cmd+B"),
                    role: MenuRole::ToggleSidebar,
                    enabled: can_toggle_sidebar,
                    checked: Some(state.sidebar.is_open()),
                },
                platform,
            ),
            ApplicationMenuEntry::Separator,
            menu_item(
                MenuItemSpec {
                    id: "view.reset_zoom",
                    command_id: "reset_zoom",
                    label: "Actual Size",
                    accelerator: Some("Cmd+0"),
                    role: MenuRole::ResetZoom,
                    enabled: can_reset_zoom,
                    checked: None,
                },
                platform,
            ),
            menu_item(
                MenuItemSpec {
                    id: "view.zoom_in",
                    command_id: "zoom_in",
                    label: "Zoom In",
                    accelerator: Some("Cmd+="),
                    role: MenuRole::ZoomIn,
                    enabled: can_zoom_in,
                    checked: None,
                },
                platform,
            ),
            menu_item(
                MenuItemSpec {
                    id: "view.zoom_out",
                    command_id: "zoom_out",
                    label: "Zoom Out",
                    accelerator: Some("Cmd+-"),
                    role: MenuRole::ZoomOut,
                    enabled: can_zoom_out,
                    checked: None,
                },
                platform,
            ),
            ApplicationMenuEntry::Separator,
            menu_item(
                MenuItemSpec {
                    id: "view.toggle_fullscreen",
                    command_id: "view.toggle_fullscreen",
                    label: "Toggle Full Screen",
                    accelerator: Some(if is_macos { "Ctrl+Cmd+F" } else { "F11" }),
                    role: MenuRole::ToggleFullScreen,
                    enabled: true,
                    checked: None,
                },
                platform,
            ),
        ],
    ));

    let window_items = if is_macos {
        vec![
            menu_item(
                MenuItemSpec {
                    id: "window.minimize",
                    command_id: "window.minimize",
                    label: "Minimize",
                    accelerator: Some("Cmd+M"),
                    role: MenuRole::Minimize,
                    enabled: true,
                    checked: None,
                },
                platform,
            ),
            menu_item(
                MenuItemSpec {
                    id: "window.zoom",
                    command_id: "window.zoom",
                    label: "Zoom",
                    accelerator: None,
                    role: MenuRole::Zoom,
                    enabled: true,
                    checked: None,
                },
                platform,
            ),
            menu_item(
                MenuItemSpec {
                    id: "window.close",
                    command_id: "window.close",
                    label: "Close",
                    accelerator: Some("Cmd+W"),
                    role: MenuRole::CloseWindow,
                    enabled: true,
                    checked: None,
                },
                platform,
            ),
        ]
    } else {
        vec![
            menu_item(
                MenuItemSpec {
                    id: "window.minimize",
                    command_id: "window.minimize",
                    label: "Minimize",
                    accelerator: None,
                    role: MenuRole::Minimize,
                    enabled: true,
                    checked: None,
                },
                platform,
            ),
            menu_item(
                MenuItemSpec {
                    id: "window.close",
                    command_id: "window.close",
                    label: "Close",
                    accelerator: Some("Cmd+W"),
                    role: MenuRole::CloseWindow,
                    enabled: true,
                    checked: None,
                },
                platform,
            ),
        ]
    };
    menus.push(build_menu(
        "window",
        if is_macos { "Window" } else { "&Window" },
        window_items,
    ));

    menus.push(build_menu(
        "help",
        if is_macos { "Help" } else { "&Help" },
        vec![
            menu_item(
                MenuItemSpec {
                    id: "help.updates",
                    command_id: "open_updates",
                    label: "Check for Updates…",
                    accelerator: None,
                    role: MenuRole::CheckForUpdates,
                    enabled: true,
                    checked: None,
                },
                platform,
            ),
            ApplicationMenuEntry::Separator,
            menu_item(
                MenuItemSpec {
                    id: "help.github",
                    command_id: "help.github",
                    label: "Cowork on GitHub",
                    accelerator: None,
                    role: MenuRole::OpenExternalUrl,
                    enabled: true,
                    checked: None,
                },
                platform,
            ),
        ],
    ));

    menus
}

/// Dispatches any application menu item ID or `command_id` against `AppState` and `Tx`.
///
/// Covers `StoreEvent::MenuInvoked` workspace/navigation actions, Edit clipboard/undo commands
/// (using `Tx::request_paste()` for Paste because Rune `route_key` skips `Key::Command('v')`),
/// window operations (`minimize`, `toggle_maximized`, `close_window`, `toggle_full_screen`,
/// `quit`), and external Help URL opening.
/// Returns `true` if `command_id` was recognized.
pub fn dispatch_menu_command_with_tx(state: &mut AppState, tx: &mut Tx, command_id: &str) -> bool {
    let normalized = match command_id {
        "file.command_palette" => "command_palette",
        "file.settings" => "settings",
        "file.workspace_settings" => "open_workspaces_settings",
        "file.close" => "window.close",
        "app.check_for_updates" | "help.check_for_updates" => "help.updates",
        other => other,
    };

    if matches!(normalized, "open_quick_chat" | "file.open_quick_chat") {
        super::record_quick_chat_opened(
            state.desktop_settings.quick_chat_icon_enabled,
            state.desktop_settings.quick_chat_shortcut_enabled,
        );
    }

    let handled = state.dispatch_menu_command_with_tx(tx, normalized);
    if handled {
        if matches!(normalized, "open_updates" | "help.updates") {
            state.send_native(crate::actions::NativeCommand::CheckForUpdates);
        }
        sync_application_menu(state);
    }
    handled
}

fn menu_action_for_item_id(id: &str) -> Option<fn(&mut AppState, &mut Tx)> {
    match id {
        "app.check_for_updates" | "help.updates" => Some(menu_action_open_updates),
        "app.settings" | "file.open_settings" => Some(menu_action_settings),
        "file.new_chat" => Some(menu_action_new_chat),
        "file.open_quick_chat" => Some(menu_action_open_quick_chat),
        "file.open_skills" => Some(menu_action_open_skills),
        "file.open_command_palette" => Some(menu_action_command_palette),
        "file.open_workspaces_settings" => Some(menu_action_workspace_settings),
        "file.close_window" => Some(menu_action_close_window),
        "view.toggle_sidebar" => Some(menu_action_toggle_sidebar),
        "view.reset_zoom" => Some(menu_action_reset_zoom),
        "view.zoom_in" => Some(menu_action_zoom_in),
        "view.zoom_out" => Some(menu_action_zoom_out),
        "view.toggle_fullscreen" => Some(menu_action_toggle_fullscreen),
        "window.zoom" => Some(menu_action_window_zoom),
        "help.github" => Some(menu_action_github),
        _ => None,
    }
}

fn menu_action_open_updates(state: &mut AppState, tx: &mut Tx) {
    dispatch_menu_command_with_tx(state, tx, "help.updates");
}

fn menu_action_settings(state: &mut AppState, tx: &mut Tx) {
    dispatch_menu_command_with_tx(state, tx, "settings");
}

fn menu_action_new_chat(state: &mut AppState, tx: &mut Tx) {
    dispatch_menu_command_with_tx(state, tx, "new_chat");
}

fn menu_action_open_quick_chat(state: &mut AppState, tx: &mut Tx) {
    dispatch_menu_command_with_tx(state, tx, "open_quick_chat");
}

fn menu_action_open_skills(state: &mut AppState, tx: &mut Tx) {
    dispatch_menu_command_with_tx(state, tx, "open_skills");
}

fn menu_action_command_palette(state: &mut AppState, tx: &mut Tx) {
    dispatch_menu_command_with_tx(state, tx, "command_palette");
}

fn menu_action_workspace_settings(state: &mut AppState, tx: &mut Tx) {
    dispatch_menu_command_with_tx(state, tx, "open_workspaces_settings");
}

fn menu_action_close_window(state: &mut AppState, tx: &mut Tx) {
    dispatch_menu_command_with_tx(state, tx, "window.close");
}

fn menu_action_toggle_sidebar(state: &mut AppState, tx: &mut Tx) {
    dispatch_menu_command_with_tx(state, tx, "toggle_sidebar");
}

fn menu_action_reset_zoom(state: &mut AppState, tx: &mut Tx) {
    dispatch_menu_command_with_tx(state, tx, "reset_zoom");
}

fn menu_action_zoom_in(state: &mut AppState, tx: &mut Tx) {
    dispatch_menu_command_with_tx(state, tx, "zoom_in");
}

fn menu_action_zoom_out(state: &mut AppState, tx: &mut Tx) {
    dispatch_menu_command_with_tx(state, tx, "zoom_out");
}

fn menu_action_toggle_fullscreen(state: &mut AppState, tx: &mut Tx) {
    dispatch_menu_command_with_tx(state, tx, "view.toggle_fullscreen");
}

fn menu_action_window_zoom(state: &mut AppState, tx: &mut Tx) {
    dispatch_menu_command_with_tx(state, tx, "window.zoom");
}

fn menu_action_github(state: &mut AppState, tx: &mut Tx) {
    dispatch_menu_command_with_tx(state, tx, "help.github");
}

fn rune_shortcut_for_macos_item(item: &ApplicationMenuItem) -> Option<Shortcut> {
    match item.id {
        // Keep `⌘,` on `app.settings` and `⌘W` on `standard_menus()` `Window -> Close`.
        "file.open_settings" | "file.close_window" => None,
        _ => item.accelerator.and_then(|accel| {
            let normalized = match accel {
                "Cmd+," => "mod+comma",
                "Cmd+N" => "mod+n",
                "Cmd+Shift+K" => "mod+shift+k",
                "Cmd+K" => "mod+k",
                "Cmd+B" => "mod+b",
                "Cmd+0" => "mod+0",
                "Cmd+=" => "mod+equal",
                "Cmd+-" => "mod+minus",
                "Ctrl+Cmd+F" => "ctrl+cmd+f",
                other => other,
            };
            Shortcut::parse_on(normalized, rune::KeyPlatform::Mac).ok()
        }),
    }
}

fn build_macos_menu_items(state: &AppState) -> Vec<MenuItem<AppState>> {
    let model = build_application_menu_for_platform(state, MenuPlatform::MacOs);
    let mut items = Vec::new();

    for menu in model {
        // `App::standard_menus()` provides the entire native `Edit` menu with AppKit first-responder
        // selectors and Rune key bridging so both text inputs and AppKit dialogs work cleanly.
        if menu.id == "edit" {
            continue;
        }
        let target_menu = if menu.id == "app" {
            None
        } else {
            Some(menu.title)
        };
        let mut pending_separator = false;
        let mut emitted_in_menu = false;

        for entry in menu.items {
            match entry {
                ApplicationMenuEntry::Separator => {
                    if emitted_in_menu {
                        pending_separator = true;
                    }
                }
                ApplicationMenuEntry::Item(item) => {
                    let Some(action) = menu_action_for_item_id(item.id) else {
                        continue;
                    };
                    if pending_separator {
                        let mut sep = MenuItem::separator();
                        if let Some(title) = target_menu {
                            sep = sep.menu(title);
                        }
                        items.push(sep);
                        pending_separator = false;
                    }
                    let mut native_item = MenuItem::new(item.label, action)
                        .id(item.id)
                        .enabled(item.enabled);
                    if item.id == "window.zoom" {
                        native_item = native_item.after("performMiniaturize:");
                    }
                    if let Some(title) = target_menu {
                        native_item = native_item.menu(title);
                    }
                    if let Some(checked) = item.checked {
                        native_item = native_item.checked(checked);
                    }
                    if let Some(shortcut) = rune_shortcut_for_macos_item(&item) {
                        native_item = native_item.keys_first().key_equivalent(shortcut);
                    }
                    items.push(native_item);
                    emitted_in_menu = true;
                }
            }
        }
    }

    items
}

/// Registers standard macOS Edit/Window menus plus the Cowork declarative menu hierarchy.
/// Uses `.keys_first()` on shortcuts so text inputs and in-app `on_key` handlers win first.
pub fn install_application_menus(app: App<AppState>) -> App<AppState> {
    let initial_state = AppState::default();
    if let Ok(mut slot) = last_menu_signature_slot().lock() {
        *slot = Some(MenuSyncSignature::from_state(&initial_state));
    }

    let mut configured = app.standard_menus();
    for item in build_macos_menu_items(&initial_state) {
        configured = configured.menu_item(item);
    }
    configured
}

/// Refreshes native macOS menu `enabled` / `checked` state via `AppHandle::set_menu` when
/// relevant `AppState` fields change. No-op on non-macOS, headless `--scene` runs, secondary
/// windows (`window_mode != WindowMode::Main`), or unchanged snapshots.
pub fn sync_application_menu(state: &AppState) {
    if !cfg!(target_os = "macos") || state.scene_mode || state.window_mode != WindowMode::Main {
        return;
    }

    let sig = MenuSyncSignature::from_state(state);
    let Ok(mut slot) = last_menu_signature_slot().lock() else {
        return;
    };
    if *slot == Some(sig) {
        return;
    }

    let Some(handle) = super::current_app_handle() else {
        return;
    };
    if handle.set_menu(build_macos_menu_items(state)).is_ok() {
        *slot = Some(sig);
    }
}

/// Builds a native context menu for file explorer rows (`Tx::popup_menu`).
pub fn build_file_explorer_context_menu(is_dir: bool, allow_trash: bool) -> PopupMenu {
    let mut items = vec![
        PopupItem::new("reveal", "Reveal in File Manager"),
        PopupItem::new("copy_path", "Copy Path"),
    ];
    if !is_dir {
        items.insert(0, PopupItem::new("open_default", "Open in Default App"));
    }
    if allow_trash {
        items.push(PopupItem::new("trash", "Move to Trash"));
    }
    PopupMenu::new().items(items)
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use rune::{Env, Key, KeyEvent, Mods, Runtime, TextEdit, TextStyle, col, text_input};

    use super::*;
    use crate::actions::NativeCommand;
    use crate::router::SettingsPageId;

    const GITHUB_URL: &str = "https://github.com/mweinbach/agent-coworker";

    fn menu_shortcut(accel: &str) -> Option<Shortcut> {
        Shortcut::parse_on(accel, rune::KeyPlatform::current()).ok()
    }

    fn all_items(menus: &[ApplicationMenu]) -> Vec<&ApplicationMenuItem> {
        menus
            .iter()
            .flat_map(|menu| menu.items.iter())
            .filter_map(|entry| match entry {
                ApplicationMenuEntry::Item(item) => Some(item),
                ApplicationMenuEntry::Separator => None,
            })
            .collect()
    }

    fn find_item<'a>(menus: &'a [ApplicationMenu], id: &str) -> &'a ApplicationMenuItem {
        all_items(menus)
            .into_iter()
            .find(|item| item.id == id)
            .unwrap_or_else(|| panic!("missing menu item {id}"))
    }

    #[test]
    fn menu_commands_and_shortcuts_parse_cleanly() {
        assert_eq!(DesktopMenuCommand::NewChat.as_id(), "new_chat");
        assert_eq!(DesktopMenuCommand::OpenSettings.as_id(), "settings");
        assert_eq!(DesktopMenuCommand::ToggleSidebar.as_id(), "toggle_sidebar");
        assert_eq!(DesktopMenuCommand::ResetZoom.as_id(), "reset_zoom");
        assert_eq!(DesktopMenuCommand::ZoomIn.as_id(), "zoom_in");
        assert_eq!(DesktopMenuCommand::ZoomOut.as_id(), "zoom_out");
        assert!(menu_shortcut("mod+n").is_some());
        assert!(menu_shortcut("mod+shift+k").is_some());
        assert!(menu_shortcut("mod+comma").is_some());
        assert!(menu_shortcut("mod+0").is_some());
        assert!(menu_shortcut("mod+=").is_some());
        assert!(menu_shortcut("mod+-").is_some());
        assert!(menu_shortcut("ctrl+cmd+f").is_some());
        assert!(menu_shortcut("f11").is_some());
    }

    #[test]
    fn declarative_model_matches_platform_structure_and_electron_items() {
        let override_state = AppState {
            menu_platform_override: Some(MenuPlatform::Windows),
            ..Default::default()
        };
        assert_eq!(
            build_application_menu(&override_state)[0].id,
            "file",
            "build_application_menu respects effective_desktop_platform override"
        );
        let state = AppState::default();

        let mac = build_application_menu_for_platform(&state, MenuPlatform::MacOs);
        let mac_titles: Vec<_> = mac.iter().map(|m| (m.id, m.label, m.mnemonic)).collect();
        assert_eq!(
            mac_titles,
            vec![
                ("app", "Cowork", None),
                ("file", "File", None),
                ("edit", "Edit", None),
                ("view", "View", None),
                ("window", "Window", None),
                ("help", "Help", None),
            ]
        );
        assert_eq!(find_item(&mac, "app.settings").shortcut_label, "⌘,");
        assert_eq!(find_item(&mac, "file.open_settings").shortcut_label, "");
        assert_eq!(find_item(&mac, "file.new_chat").shortcut_label, "⌘N");
        assert_eq!(find_item(&mac, "file.open_skills").shortcut_label, "⌘⇧K");
        assert_eq!(
            find_item(&mac, "file.open_command_palette").shortcut_label,
            "⌘K"
        );
        assert_eq!(find_item(&mac, "view.zoom_in").shortcut_label, "⌘=");
        assert_eq!(
            find_item(&mac, "view.toggle_fullscreen").shortcut_label,
            "⌃⌘F"
        );
        assert_eq!(find_item(&mac, "edit.redo").shortcut_label, "⌘⇧Z");
        assert!(mac.iter().any(|m| {
            m.id == "window"
                && m.items
                    .iter()
                    .any(|e| matches!(e, ApplicationMenuEntry::Item(i) if i.id == "window.zoom"))
        }));

        for (platform, expected_redo, expected_quit_accel) in [
            (MenuPlatform::Linux, "Ctrl+Shift+Z", "Ctrl+Q"),
            (MenuPlatform::Windows, "Ctrl+Y", ""),
        ] {
            let menus = build_application_menu_for_platform(&state, platform);
            let titles: Vec<_> = menus
                .iter()
                .map(|m| (m.id, m.label, m.title, m.mnemonic))
                .collect();
            assert_eq!(
                titles,
                vec![
                    ("file", "&File", "File", Some('F')),
                    ("edit", "&Edit", "Edit", Some('E')),
                    ("view", "&View", "View", Some('V')),
                    ("window", "&Window", "Window", Some('W')),
                    ("help", "&Help", "Help", Some('H')),
                ]
            );
            assert_eq!(
                find_item(&menus, "file.open_settings").shortcut_label,
                "Ctrl+,"
            );
            assert_eq!(
                find_item(&menus, "file.quit").shortcut_label,
                expected_quit_accel
            );
            assert_eq!(find_item(&menus, "edit.redo").shortcut_label, expected_redo);
            assert_eq!(
                find_item(&menus, "view.toggle_fullscreen").shortcut_label,
                "F11"
            );
            assert_eq!(find_item(&menus, "window.close").shortcut_label, "Ctrl+W");
        }

        for platform in [
            MenuPlatform::MacOs,
            MenuPlatform::Linux,
            MenuPlatform::Windows,
        ] {
            let menus = build_application_menu_for_platform(&state, platform);
            let items = all_items(&menus);
            let unique_ids: HashSet<_> = items.iter().map(|i| i.id).collect();
            assert_eq!(
                unique_ids.len(),
                items.len(),
                "duplicate IDs on {platform:?}"
            );
        }
    }

    #[test]
    fn menu_enabled_and_checked_state_tracks_app_state() {
        let mut state = AppState::default();
        let menus = build_application_menu_for_platform(&state, MenuPlatform::Linux);
        assert!(!find_item(&menus, "view.reset_zoom").enabled);
        assert!(find_item(&menus, "view.zoom_in").enabled);
        assert!(find_item(&menus, "view.zoom_out").enabled);
        assert!(find_item(&menus, "view.toggle_sidebar").enabled);
        assert_eq!(find_item(&menus, "view.toggle_sidebar").checked, Some(true));

        state.sidebar.set_open(false);
        state.ui_scale = MAX_UI_SCALE;
        state.dispatch(crate::actions::Action::Navigate(
            crate::actions::NavAction::OpenSettings(Some(SettingsPageId::Desktop)),
        ));
        let updated = build_application_menu_for_platform(&state, MenuPlatform::Linux);
        assert!(find_item(&updated, "view.reset_zoom").enabled);
        assert!(!find_item(&updated, "view.zoom_in").enabled);
        assert!(find_item(&updated, "view.zoom_out").enabled);
        assert!(!find_item(&updated, "view.toggle_sidebar").enabled);
        assert_eq!(
            find_item(&updated, "view.toggle_sidebar").checked,
            Some(false)
        );

        state.ui_scale = MIN_UI_SCALE;
        state.window_mode = WindowMode::QuickChat;
        let quick = build_application_menu_for_platform(&state, MenuPlatform::MacOs);
        assert!(!find_item(&quick, "view.zoom_out").enabled);
        assert!(!find_item(&quick, "file.new_chat").enabled);
        assert!(find_item(&quick, "file.open_quick_chat").enabled);
    }

    #[test]
    fn macos_conversion_preserves_unique_shortcuts_and_skips_os_edit_menu() {
        let state = AppState::default();
        let model = build_application_menu_for_platform(&state, MenuPlatform::MacOs);
        for item in all_items(&model) {
            if matches!(
                item.id,
                "app.settings"
                    | "file.new_chat"
                    | "file.open_skills"
                    | "file.open_command_palette"
                    | "view.toggle_sidebar"
                    | "view.reset_zoom"
                    | "view.zoom_in"
                    | "view.zoom_out"
                    | "view.toggle_fullscreen"
            ) {
                assert!(
                    rune_shortcut_for_macos_item(item).is_some(),
                    "expected Rune shortcut for {}",
                    item.id
                );
            }
        }
        assert!(rune_shortcut_for_macos_item(find_item(&model, "file.open_settings")).is_none());
        assert!(rune_shortcut_for_macos_item(find_item(&model, "file.close_window")).is_none());

        let native_items = build_macos_menu_items(&state);
        assert_eq!(native_items.len(), 23);
    }

    #[test]
    fn dispatch_with_tx_handles_store_actions_window_and_edit_roles() {
        let mut state = AppState::default();
        let mut tx = Tx::default();

        assert!(dispatch_menu_command_with_tx(
            &mut state, &mut tx, "zoom_in"
        ));
        assert!((state.ui_scale - 1.1).abs() < 0.001);
        assert!(dispatch_menu_command_with_tx(
            &mut state,
            &mut tx,
            "help.updates"
        ));
        assert_eq!(state.route().view, ViewId::Settings);
        assert_eq!(state.route().settings_page, SettingsPageId::Updates);
        assert!(
            state
                .services
                .emitted_native_commands
                .iter()
                .any(|c| matches!(c, NativeCommand::CheckForUpdates))
        );
        assert!(dispatch_menu_command_with_tx(
            &mut state,
            &mut tx,
            "open_skills"
        ));
        assert_eq!(state.route().view, ViewId::Settings);
        assert_eq!(state.route().settings_page, SettingsPageId::ToolAccess);
        assert_eq!(state.route().settings_tab.as_deref(), Some("skills"));
        assert!(!dispatch_menu_command_with_tx(
            &mut state,
            &mut tx,
            "nonexistent.cmd"
        ));

        let cb = rune::clipboard::memory();
        let mut rt = Runtime::new(
            (AppState::default(), TextEdit::new("hello")),
            |s, _cx| {
                col().child(
                    text_input(&s.1, TextStyle::new(14.0, 400.0))
                        .key("focused-input")
                        .label("Input")
                        .size(200.0, 28.0)
                        .on_edit(|state: &mut (AppState, TextEdit)| &mut state.1),
                )
            },
            (800.0, 600.0),
            Env::new(true, 1.0),
        );
        rt.use_clipboard(&cb);
        rt.frame(0.0);
        let (x, y) = rt.find("focused-input").expect("input position");
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(0.0);

        rt.update(|s, tx| {
            assert!(dispatch_menu_command_with_tx(
                &mut s.0,
                tx,
                "edit.select_all"
            ));
            assert!(dispatch_menu_command_with_tx(&mut s.0, tx, "edit.cut"));
        });
        rt.frame(0.0);
        assert_eq!(rt.state.1.text, "");
        assert_eq!(cb.text().as_deref().map(String::as_str), Some("hello"));

        rt.update(|s, tx| {
            assert!(dispatch_menu_command_with_tx(&mut s.0, tx, "edit.undo"));
        });
        rt.frame(0.0);
        assert_eq!(rt.state.1.text, "hello");

        rt.update(|s, tx| {
            assert!(dispatch_menu_command_with_tx(&mut s.0, tx, "edit.redo"));
        });
        rt.frame(0.0);
        assert_eq!(rt.state.1.text, "");

        cb.set_text("pasted");
        rt.update(|s, tx| {
            assert!(dispatch_menu_command_with_tx(&mut s.0, tx, "edit.paste"));
        });
        rt.frame(0.0);
        assert_eq!(rt.state.1.text, "pasted");

        rt.update(|s, tx| {
            assert!(dispatch_menu_command_with_tx(
                &mut s.0,
                tx,
                "edit.select_all"
            ));
            assert!(dispatch_menu_command_with_tx(&mut s.0, tx, "edit.copy"));
        });
        rt.frame(0.0);
        assert_eq!(cb.text().as_deref().map(String::as_str), Some("pasted"));

        rt.update(|s, tx| {
            assert!(dispatch_menu_command_with_tx(&mut s.0, tx, "help.github"));
        });
        rt.frame(0.0);
        assert_eq!(rt.take_url_requests(), vec![GITHUB_URL.to_string()]);

        rt.update(|s, tx| {
            let skills_ev = KeyEvent {
                key: Key::Command('k'),
                mods: Mods {
                    cmd: true,
                    shift: true,
                    ctrl: !cfg!(target_os = "macos"),
                    logo: cfg!(target_os = "macos"),
                    alt: false,
                },
            };
            assert!(crate::handle_global_menu_shortcut(&mut s.0, &skills_ev, tx));
        });
        assert_eq!(rt.state.0.route().view, ViewId::Settings);
        assert_eq!(rt.state.0.route().settings_page, SettingsPageId::ToolAccess);
        assert_eq!(rt.state.0.route().settings_tab.as_deref(), Some("skills"));
    }

    #[test]
    fn preview_name_parser_recognizes_platform_aliases() {
        assert_eq!(MenuPlatform::parse("linux"), Some(MenuPlatform::Linux));
        assert_eq!(MenuPlatform::parse("win32"), Some(MenuPlatform::Windows));
        assert_eq!(MenuPlatform::parse("darwin"), Some(MenuPlatform::MacOs));
        assert_eq!(MenuPlatform::parse("unknown"), None);
    }
}
