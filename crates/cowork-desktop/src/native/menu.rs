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

    let mut new_chat = MenuItem::new("New Chat", |state: &mut AppState, _| {
        dispatch_menu_command(state, DesktopMenuCommand::NewChat);
    })
    .id("file.new_chat")
    .menu("File")
    .keys_first();
    if let Some(sc) = menu_shortcut("mod+n") {
        new_chat = new_chat.key_equivalent(sc);
    }

    let open_quick_chat = MenuItem::new("Open Quick Chat", |state: &mut AppState, _| {
        state.apply_store_event(StoreEvent::QuickChatToggled);
    })
    .id("file.open_quick_chat")
    .menu("File");

    let mut skills = MenuItem::new("Skills", |state: &mut AppState, _| {
        dispatch_menu_command(state, DesktopMenuCommand::OpenSkills);
    })
    .id("file.open_skills")
    .menu("File")
    .keys_first();
    if let Some(sc) = menu_shortcut("mod+shift+k") {
        skills = skills.key_equivalent(sc);
    }

    let mut palette = MenuItem::new("Command Palette", |state: &mut AppState, _| {
        dispatch_menu_command(state, DesktopMenuCommand::OpenCommandPalette);
    })
    .id("file.command_palette")
    .menu("File")
    .keys_first();
    if let Some(sc) = menu_shortcut("mod+k") {
        palette = palette.key_equivalent(sc);
    }

    let mut settings = MenuItem::new("Settings...", |state: &mut AppState, _| {
        dispatch_menu_command(state, DesktopMenuCommand::OpenSettings);
    })
    .id("file.settings")
    .menu("File")
    .keys_first();
    if let Some(sc) = menu_shortcut("mod+comma") {
        settings = settings.key_equivalent(sc);
    }

    let ws_settings = MenuItem::new("Workspace Settings", |state: &mut AppState, _| {
        dispatch_menu_command(state, DesktopMenuCommand::OpenWorkspacesSettings);
    })
    .id("file.workspace_settings")
    .menu("File");

    let mut toggle_sidebar = MenuItem::new("Toggle Sidebar", |state: &mut AppState, _| {
        dispatch_menu_command(state, DesktopMenuCommand::ToggleSidebar);
    })
    .id("view.toggle_sidebar")
    .menu("View")
    .keys_first();
    if let Some(sc) = menu_shortcut("mod+b") {
        toggle_sidebar = toggle_sidebar.key_equivalent(sc);
    }

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
        assert!(menu_shortcut("mod+n").is_some());
        assert!(menu_shortcut("mod+shift+k").is_some());
        assert!(menu_shortcut("mod+comma").is_some());
    }
}
