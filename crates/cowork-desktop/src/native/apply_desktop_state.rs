//! Applies persisted [`PersistedDesktopState`] changes to native side-effect controllers
//! (`WorkspaceRootsController`, `LocalLogger` workspace redaction, `AppearancePreferences`, and
//! `QuickChatTrayController`) without triggering re-entrant persistence writes.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use rune::{AppHandle, ColorScheme};

use crate::state::{AppState, PersistedDesktopState};

use super::appearance::AppearancePreferences;
use super::local_logs::LocalLogger;
use super::security::{WorkspaceRootsController, resolve_effective_feature_flags};
use super::tray::QuickChatTrayController;

/// Coordinates side effects whenever desktop settings/workspaces are loaded or saved.
#[allow(clippy::too_many_arguments)]
pub fn apply_desktop_state(
    state: &PersistedDesktopState,
    roots: &Arc<Mutex<WorkspaceRootsController>>,
    logger: &Arc<LocalLogger>,
    appearance_prefs: &AppearancePreferences,
    tray: &QuickChatTrayController,
    app_handle: Option<&AppHandle<AppState>>,
    apply_workspace_roots: bool,
    is_packaged: bool,
) {
    let env = cowork_config::env_map_from_process();
    apply_desktop_state_with_env(
        state,
        roots,
        logger,
        appearance_prefs,
        tray,
        app_handle,
        apply_workspace_roots,
        is_packaged,
        &env,
    );
}

/// Same as [`apply_desktop_state`] but reuses a caller-captured process environment map.
#[allow(clippy::too_many_arguments)]
pub(crate) fn apply_desktop_state_with_env(
    state: &PersistedDesktopState,
    roots: &Arc<Mutex<WorkspaceRootsController>>,
    logger: &Arc<LocalLogger>,
    appearance_prefs: &AppearancePreferences,
    tray: &QuickChatTrayController,
    app_handle: Option<&AppHandle<AppState>>,
    apply_workspace_roots: bool,
    is_packaged: bool,
    env: &HashMap<String, String>,
) {
    if apply_workspace_roots {
        let approved = {
            let mut guard = roots.lock().unwrap_or_else(|e| e.into_inner());
            let pairs: Vec<(&str, PathBuf)> = state
                .workspaces
                .iter()
                .map(|ws| (ws.id.as_str(), PathBuf::from(&ws.path)))
                .collect();
            guard.set_persisted_workspaces(pairs.iter().map(|(id, p)| (*id, p.as_path())));
            guard.approved_roots()
        };
        logger.set_workspace_paths(approved);
    }

    let _ = appearance_prefs.save_theme_preference(state.settings.theme);
    if let Some(handle) = app_handle {
        handle.set_color_scheme(match state.settings.theme {
            crate::theme::ThemePreference::System => ColorScheme::System,
            crate::theme::ThemePreference::Light => ColorScheme::Light,
            crate::theme::ThemePreference::Dark => ColorScheme::Dark,
        });
    }
    let effective_flags = resolve_effective_feature_flags(&state.feature_flags, env, is_packaged);
    let menu_bar_enabled = effective_flags.get("menuBar").copied().unwrap_or(true);
    tray.sync_from_settings(&state.settings, menu_bar_enabled, app_handle);
}
