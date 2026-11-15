//! Native application menu bar items (macOS via `rune::MenuItem`) and popup context menus
//! (`rune::PopupMenu`) matching `apps/desktop/electron/services/menuTemplate.ts` and
//! `menuCommandDispatcher.ts`.

use std::str::FromStr;

use rune::{App, MenuItem, PopupItem, PopupMenu, Shortcut};

use crate::actions::StoreEvent;
use crate::state::AppState;

const GITHUB_URL: &str = "https://github.com/mweinbach/agent-coworker";

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

fn menu_shortcut(accel: &str) -> Option<Shortcut> {
    Shortcut::from_str(accel).ok()
}

fn dispatch_menu_command(state: &mut AppState, cmd: DesktopMenuCommand) {
    state.apply_store_event(StoreEvent::MenuInvoked(cmd.as_id().to_string()));
}

fn build_command_item(
    label: &str,
    action: fn(&mut AppState, &mut rune::Tx),
    id: &str,
    menu: &str,
    accel: Option<&str>,
) -> MenuItem<AppState> {
    let mut item = MenuItem::new(label, action).id(id).menu(menu);
    if let Some(sc) = accel.and_then(menu_shortcut) {
        item = item.keys_first().key_equivalent(sc);
    }
    item
}

/// Registers standard Edit/Window menus plus custom Cowork File/View/Help/App menu items.
/// Uses `.keys_first()` on shortcuts so text inputs and in-app `on_key` handlers win first.
pub fn install_application_menus(app: App<AppState>) -> App<AppState> {
    let mut app = app.standard_menus();

    let mut check_updates_app = MenuItem::new("Check for Updates...", |state: &mut AppState, _| {
        dispatch_menu_command(state, DesktopMenuCommand::OpenUpdates);
        state.send_native(crate::actions::NativeCommand::CheckForUpdates);
    })
    .id("app.check_for_updates");
    let _ = &mut check_updates_app;
    app = app.menu_item(check_updates_app);

    let new_chat = build_command_item(
        "New Chat",
        |state, _| dispatch_menu_command(state, DesktopMenuCommand::NewChat),
        "file.new_chat",
        "File",
        Some("mod+n"),
    );

    let open_quick_chat = MenuItem::new("Open Quick Chat", |state: &mut AppState, _| {
        super::record_quick_chat_opened(
            state.desktop_settings.quick_chat_icon_enabled,
            state.desktop_settings.quick_chat_shortcut_enabled,
        );
        state.apply_store_event(StoreEvent::QuickChatToggled);
    })
    .id("file.open_quick_chat")
    .menu("File");

    let skills = build_command_item(
        "Skills",
        |state, _| dispatch_menu_command(state, DesktopMenuCommand::OpenSkills),
        "file.open_skills",
        "File",
        Some("mod+shift+k"),
    );

    let palette = build_command_item(
        "Command Palette",
        |state, _| dispatch_menu_command(state, DesktopMenuCommand::OpenCommandPalette),
        "file.command_palette",
        "File",
        Some("mod+k"),
    );

    let settings = build_command_item(
        "Settings...",
        |state, _| dispatch_menu_command(state, DesktopMenuCommand::OpenSettings),
        "file.settings",
        "File",
        Some("mod+comma"),
    );

    let ws_settings = build_command_item(
        "Workspace Settings",
        |state, _| dispatch_menu_command(state, DesktopMenuCommand::OpenWorkspacesSettings),
        "file.workspace_settings",
        "File",
        None,
    );

    let toggle_sidebar = build_command_item(
        "Toggle Sidebar",
        |state, _| dispatch_menu_command(state, DesktopMenuCommand::ToggleSidebar),
        "view.toggle_sidebar",
        "View",
        Some("mod+b"),
    );

    let reset_zoom = build_command_item(
        "Actual Size",
        |state, _| dispatch_menu_command(state, DesktopMenuCommand::ResetZoom),
        "view.reset_zoom",
        "View",
        Some("mod+0"),
    );

    let zoom_in = build_command_item(
        "Zoom In",
        |state, _| dispatch_menu_command(state, DesktopMenuCommand::ZoomIn),
        "view.zoom_in",
        "View",
        Some("mod+="),
    );

    let zoom_out = build_command_item(
        "Zoom Out",
        |state, _| dispatch_menu_command(state, DesktopMenuCommand::ZoomOut),
        "view.zoom_out",
        "View",
        Some("mod+-"),
    );

    let help_updates = MenuItem::new("Check for Updates...", |state: &mut AppState, _| {
        dispatch_menu_command(state, DesktopMenuCommand::OpenUpdates);
        state.send_native(crate::actions::NativeCommand::CheckForUpdates);
    })
    .id("help.check_for_updates")
    .menu("Help");

    let help_github = MenuItem::new("Cowork on GitHub", |state: &mut AppState, tx| {
        if tx.open_url(GITHUB_URL).is_err() {
            state.send_native(crate::actions::NativeCommand::OpenExternalUrl(
                GITHUB_URL.to_string(),
            ));
        }
    })
    .id("help.github")
    .menu("Help");

    app.menu_item(new_chat)
        .menu_item(open_quick_chat)
        .menu_item(skills)
        .menu_item(palette)
        .menu_item(MenuItem::separator().menu("File"))
        .menu_item(settings)
        .menu_item(ws_settings)
        .menu_item(toggle_sidebar)
        .menu_item(MenuItem::separator().menu("View"))
        .menu_item(reset_zoom)
        .menu_item(zoom_in)
        .menu_item(zoom_out)
        .menu_item(help_updates)
        .menu_item(MenuItem::separator().menu("Help"))
        .menu_item(help_github)
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
    use super::*;

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
    }
}
