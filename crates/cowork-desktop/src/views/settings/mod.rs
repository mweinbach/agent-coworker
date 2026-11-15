//! Settings feature view module (owned by `settings`).
//!
//! Ported from `apps/desktop/src/ui/settings/` and `apps/desktop/src/ui/settings/pages/`.

pub mod backup;
pub mod chats;
pub mod desktop;
pub mod developer;
pub mod experiments;
pub mod icons;
pub mod manage_models_dialog;
pub mod mcp_server_draft;
pub mod primitives;
pub mod privacy_telemetry;
pub mod providers;
pub mod providers_utils;
pub mod remote_access;
pub mod shell;
pub mod state;
pub mod updates;
pub mod usage;

#[cfg(test)]
mod tests;

pub use state::SettingsUiState;

use rune::{Cx, el, icon};
use rune_kit::Kit;

use crate::actions::{Action, SettingsAction};
use crate::router::SettingsPageId;
use crate::state::AppState;
use crate::theme::{self, ThemeTokens};
use crate::views::SubviewOutput;
use crate::views::settings::primitives::{EmptyState, Section, settings_page};
use crate::views::settings::shell::{PageContent, resolve_active_page, settings_shell};

fn placeholder_page(s: &AppState, page: SettingsPageId, k: &Kit, t: &ThemeTokens) -> PageContent {
    let summary = match page {
        SettingsPageId::Models => {
            format!("{} providers loaded in catalog.", s.provider_catalog.len())
        }
        SettingsPageId::Subagents => {
            format!("{} subagent profiles configured.", s.subagents.len())
        }
        SettingsPageId::ToolAccess => format!(
            "{} plugins, {} skills, and {} MCP servers available.",
            s.plugins.len(),
            s.skills.len(),
            s.mcp_servers.len()
        ),
        SettingsPageId::Defaults => {
            format!("{} workspaces managed.", s.workspaces.len())
        }
        SettingsPageId::ProfileMemory => {
            format!(
                "{} workspace memory entries stored.",
                s.memory_entries.len()
            )
        }
        SettingsPageId::RemoteAccess => format!(
            "Remote relay {} ({} trusted devices).",
            if s.remote_access.running {
                "running"
            } else {
                "stopped"
            },
            s.remote_access.trusted_phones.len()
        ),
        SettingsPageId::Backup => {
            format!("{} workspace backups indexed.", s.backups.len())
        }
        SettingsPageId::Chats => {
            format!("{} archived threads tracked.", s.archived_threads.len())
        }
        SettingsPageId::Usage => match &s.usage_summary {
            Some(u) => format!(
                "{} input tokens, {} output tokens (${:.2} estimated).",
                u.input_tokens, u.output_tokens, u.estimated_cost_usd
            ),
            None => "Usage summary will populate once sessions run.".to_string(),
        },
        SettingsPageId::Desktop => format!(
            "Quick Chat shortcut: {} ({})",
            s.desktop_settings.quick_chat_shortcut,
            if s.desktop_settings.quick_chat_shortcut_enabled {
                "enabled"
            } else {
                "disabled"
            }
        ),
        SettingsPageId::Diagnostics => {
            if let Some(ws_id) = s.resolve_management_workspace_id() {
                format!("Workspace diagnostics target: {ws_id}.")
            } else {
                "Open or select a workspace to inspect runtime diagnostics.".to_string()
            }
        }
        _ => page.description().to_string(),
    };

    let mut content = EmptyState::new(page.title())
        .icon(icons::page_icon(page))
        .description(summary);

    if page == SettingsPageId::Models
        && let Some(ws_id) = s.resolve_management_workspace_id().map(str::to_string)
    {
        content = content.action(
            rune_kit::Button::new("Refresh providers")
                .variant(rune_kit::ButtonVariant::Outline)
                .on_press(move |s: &mut AppState| {
                    s.dispatch(Action::Settings(SettingsAction::RefreshProviderCatalog {
                        workspace_id: ws_id.clone(),
                    }));
                })
                .build(k),
        );
    }

    let _ = icon(icons::page_icon(page), 16.0);
    PageContent::simple(settings_page(vec![
        Section::new()
            .child(el().w_full().child(content.build(k, t)))
            .build(k, t),
    ]))
}

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
        SettingsPageId::Models => providers::view(s, &resolved_k, &t),
        SettingsPageId::RemoteAccess => remote_access::view(s, &resolved_k, &t),
        SettingsPageId::Backup => backup::view(s, &resolved_k, &t),
        SettingsPageId::Chats => chats::view(s, &resolved_k, &t),
        SettingsPageId::Desktop => desktop::view(s, &resolved_k, &t),
        SettingsPageId::Diagnostics => developer::view(s, &resolved_k, &t),
        SettingsPageId::Experiments => experiments::view(s, &resolved_k, &t),
        SettingsPageId::Updates => updates::view(s, &resolved_k, &t),
        SettingsPageId::Usage => usage::view(s, &resolved_k, &t),
        SettingsPageId::PrivacyTelemetry => privacy_telemetry::view(s, &resolved_k, &t),
        other => placeholder_page(s, other, &resolved_k, &t),
    };

    settings_shell(s, cx, &resolved_k, &t, active_page, content)
}
