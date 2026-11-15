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

use rune::{Cx, Spring, row, text};
use rune_kit::shell::{PaneMotion, SplitView, Toolbar};
use rune_kit::{Badge, BadgeVariant, Kit};

use crate::router::SettingsPageId;
use crate::state::AppState;
use crate::theme::{self, ThemeTokens};
use crate::views::SubviewOutput;
pub use crate::views::settings::shell::SettingsLayout;
use crate::views::settings::shell::{resolve_active_page, settings_layout};

/// Builds the structural Settings pieces for `views::shell::build_settings_frame`.
pub fn build_layout(s: &AppState, _cx: &Cx<AppState>, k: &Kit, t: &ThemeTokens) -> SettingsLayout {
    let active_page = resolve_active_page(s);
    let content = match active_page {
        SettingsPageId::Models | SettingsPageId::Providers => providers::view(s, k, t),
        SettingsPageId::Subagents => subagents::view(s, k, t),
        SettingsPageId::ToolAccess
        | SettingsPageId::OpenAiNativeConnectors
        | SettingsPageId::Mcp => tool_access::view(s, k, t),
        SettingsPageId::Defaults | SettingsPageId::Workspaces => workspaces::view(s, k, t),
        SettingsPageId::ProfileMemory | SettingsPageId::Memory => memory::view(s, k, t),
        SettingsPageId::RemoteAccess => remote_access::view(s, k, t),
        SettingsPageId::Backup => backup::view(s, k, t),
        SettingsPageId::Chats | SettingsPageId::ArchivedChats => chats::view(s, k, t),
        SettingsPageId::Desktop => desktop::view(s, k, t),
        SettingsPageId::Diagnostics | SettingsPageId::Developer => developer::view(s, k, t),
        SettingsPageId::Experiments | SettingsPageId::FeatureFlags => experiments::view(s, k, t),
        SettingsPageId::Updates => updates::view(s, k, t),
        SettingsPageId::Usage => usage::view(s, k, t),
        SettingsPageId::PrivacyTelemetry => privacy_telemetry::view(s, k, t),
    };

    settings_layout(s, k, t, active_page, content)
}

/// Renders the full-window Settings shell in a standalone `SplitView` (used by settings tests).
pub fn view(s: &AppState, cx: &mut Cx<AppState>, _k: &Kit) -> SubviewOutput {
    let dark = s.effective_dark(cx.system_dark());
    let (resolved_k, t) = theme::build_kit_with_accent(
        dark,
        s.desktop_settings.reduced_transparency,
        s.desktop_settings.high_contrast,
        s.desktop_settings.accent_palette,
    );

    cx.foreground(t.text_base);
    cx.focus_ring(2.0, 2.5, t.focus_ring);
    cx.web_focus();

    let layout = build_layout(s, cx, &resolved_k, &t);

    let mut heading = row().items_center().gap(8.0).min_w(0.0).child(
        text(layout.title)
            .font(resolved_k.ty.ui_medium)
            .color(t.text_base),
    );
    if let Some(badge_label) = layout.workspace_badge.as_deref() {
        heading = heading.child(
            Badge::new(badge_label)
                .variant(BadgeVariant::Subtle)
                .build(&resolved_k),
        );
    }

    let mut toolbar = Toolbar::new().leading(heading);
    for action in layout.header_actions {
        toolbar = toolbar.trailing(action);
    }
    let chrome = cx.chrome_insets();
    if chrome.trailing > 0.0 {
        toolbar = toolbar.trailing(
            rune::el()
                .key("settings-caption-reserve")
                .w(chrome.trailing)
                .h(1.0)
                .a11y_hidden(),
        );
    }

    let content = SplitView::new(layout.main)
        .sidebar(
            &s.settings_ui.nav_pane,
            |s: &mut AppState| &mut s.settings_ui.nav_pane,
            layout.sidebar,
        )
        .sidebar_padding(12.0, 8.0)
        .hide_sidebar_toggle()
        .toolbar(toolbar)
        .titlebar_inset(cx.titlebar_inset())
        .frame_inset(8.0)
        .toolbar_in_panel()
        .pane_motion(PaneMotion::new().spring(Spring::new(0.3, 0.0)))
        .reduced_motion(s.desktop_settings.reduce_motion)
        .build(&resolved_k)
        .key("settings-shell");

    SubviewOutput {
        content,
        overlays: layout.overlays,
    }
}
