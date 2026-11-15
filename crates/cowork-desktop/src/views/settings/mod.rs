//! Settings feature view module (owned by `settings`).
//!
//! Ported from `apps/desktop/src/ui/settings/` and `apps/desktop/src/ui/settings/pages/`.

pub mod backup;
pub mod chats;
pub mod connectors;
pub mod desktop;
pub mod developer;
pub mod experiments;
pub mod icons;
pub mod manage_models_dialog;
pub mod mcp_server_draft;
pub mod mcp_servers;
pub mod memory;
pub mod primitives;
pub mod privacy_telemetry;
pub mod providers;
pub mod providers_utils;
pub mod remote_access;
pub mod shell;
pub mod state;
pub mod subagents;
pub mod tool_access;
pub mod updates;
pub mod usage;
pub mod workspaces;

#[cfg(test)]
mod tests;

pub use state::SettingsUiState;

use rune::Cx;
use rune_kit::Kit;

use crate::router::SettingsPageId;
use crate::state::AppState;
use crate::theme;
use crate::views::SubviewOutput;
use crate::views::settings::shell::{resolve_active_page, settings_shell};

/// Renders the full-window Settings shell, navigation rail, and active settings page.
pub fn view(s: &AppState, cx: &mut Cx<AppState>, _k: &Kit) -> SubviewOutput {
    let dark = s.effective_dark(cx.system_dark());
    let (resolved_k, t) = theme::build_kit(
        dark,
        s.desktop_settings.reduced_transparency,
        s.desktop_settings.high_contrast,
    );

    cx.foreground(t.text_base);
    cx.focus_ring(2.0, 2.0, t.focus_ring);
    cx.web_focus();

    let active_page = resolve_active_page(s);
    let content = match active_page {
        SettingsPageId::Models | SettingsPageId::Providers => providers::view(s, &resolved_k, &t),
        SettingsPageId::Subagents => subagents::view(s, &resolved_k, &t),
        SettingsPageId::ToolAccess
        | SettingsPageId::OpenAiNativeConnectors
        | SettingsPageId::Mcp => tool_access::view(s, &resolved_k, &t),
        SettingsPageId::Defaults | SettingsPageId::Workspaces => {
            workspaces::view(s, &resolved_k, &t)
        }
        SettingsPageId::ProfileMemory | SettingsPageId::Memory => memory::view(s, &resolved_k, &t),
        SettingsPageId::RemoteAccess => remote_access::view(s, &resolved_k, &t),
        SettingsPageId::Backup => backup::view(s, &resolved_k, &t),
        SettingsPageId::Chats | SettingsPageId::ArchivedChats => chats::view(s, &resolved_k, &t),
        SettingsPageId::Desktop => desktop::view(s, &resolved_k, &t),
        SettingsPageId::Diagnostics | SettingsPageId::Developer => {
            developer::view(s, &resolved_k, &t)
        }
        SettingsPageId::Experiments | SettingsPageId::FeatureFlags => {
            experiments::view(s, &resolved_k, &t)
        }
        SettingsPageId::Updates => updates::view(s, &resolved_k, &t),
        SettingsPageId::Usage => usage::view(s, &resolved_k, &t),
        SettingsPageId::PrivacyTelemetry => privacy_telemetry::view(s, &resolved_k, &t),
    };

    settings_shell(s, cx, &resolved_k, &t, active_page, content)
}
