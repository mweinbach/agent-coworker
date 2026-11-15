//! OpenAI native ChatGPT connectors tab (`apps/desktop/src/ui/settings/pages/OpenAiNativeConnectorsPage.tsx`).

use rune::{El, col, el, row, text};
use rune_kit::{Button, ButtonVariant, ControlSize, Kit};
use serde_json::Value;

use crate::actions::{Action, SettingsAction, ShellAction};
use crate::state::AppState;
use crate::theme::ThemeTokens;
use crate::views::settings::icons;
use crate::views::settings::primitives::{
    EmptyState, EntityIconSize, Section, StatusTone, entity_icon, mini_switch, search_input,
    status_pill,
};

/// Normalized connector record parsed from `AppState::openai_native_connectors`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConnectorItem {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub logo_url: Option<String>,
    pub is_accessible: bool,
    pub is_enabled: bool,
    pub is_workspace_connector: bool,
    pub install_url: Option<String>,
}

/// Filters external connector links strictly to `http://` or `https://` with a host.
pub fn safe_external_url(raw: Option<&str>) -> Option<String> {
    let trimmed = raw?.trim();
    if trimmed.is_empty() {
        return None;
    }
    let parsed = url::Url::parse(trimmed).ok()?;
    if matches!(parsed.scheme(), "http" | "https") && parsed.host_str().is_some() {
        Some(parsed.to_string())
    } else {
        None
    }
}

/// Parses `AppState::openai_native_connectors` JSON payloads into strongly typed items.
pub fn parse_connectors(raw: &[Value]) -> Vec<ConnectorItem> {
    raw.iter()
        .filter_map(|v| {
            let id = v.get("id").and_then(Value::as_str)?.trim();
            if id.is_empty() {
                return None;
            }
            let name = v
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(id);
            let description = v
                .get("description")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            let logo_url = v
                .get("logoUrl")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            let install_url = safe_external_url(v.get("installUrl").and_then(Value::as_str));
            Some(ConnectorItem {
                id: id.to_string(),
                name: name.to_string(),
                description,
                logo_url,
                is_accessible: v
                    .get("isAccessible")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                is_enabled: v.get("isEnabled").and_then(Value::as_bool).unwrap_or(false),
                is_workspace_connector: v
                    .get("isWorkspaceConnector")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                install_url,
            })
        })
        .collect()
}

/// Filters parsed connectors by search query and the `Enabled only` toggle.
pub fn filter_connectors<'a>(
    items: &'a [ConnectorItem],
    query: &str,
    enabled_only: bool,
) -> Vec<&'a ConnectorItem> {
    let q = query.trim().to_ascii_lowercase();
    items
        .iter()
        .filter(|item| {
            if enabled_only && !item.is_enabled {
                return false;
            }
            if q.is_empty() {
                return true;
            }
            item.name.to_ascii_lowercase().contains(&q)
                || item.id.to_ascii_lowercase().contains(&q)
                || item
                    .description
                    .as_deref()
                    .is_some_and(|d| d.to_ascii_lowercase().contains(&q))
        })
        .collect()
}

/// Checks if the Codex provider status indicates an active sign-in for the workspace.
pub fn is_codex_authenticated(s: &AppState, workspace_id: Option<&str>) -> bool {
    let runtime_connected = workspace_id
        .and_then(|id| s.workspace_runtime_by_id.get(id))
        .is_some_and(|rt| {
            rt.provider_statuses.iter().any(|st| {
                matches!(st.provider.as_str(), "codex" | "codex-cli")
                    && (st.healthy || st.connected)
            })
        });
    if runtime_connected {
        return true;
    }
    s.provider_catalog
        .iter()
        .any(|p| matches!(p.id.as_str(), "codex" | "codex-cli") && p.configured)
}

/// Renders the Apps (OpenAI native connectors) tab inside `ToolAccess`.
pub fn view_tab(s: &AppState, workspace_id: Option<&str>, k: &Kit, t: &ThemeTokens) -> El {
    let items = parse_connectors(&s.openai_native_connectors);
    let enabled_count = items.iter().filter(|c| c.is_enabled).count();
    let accessible_count = items.iter().filter(|c| c.is_accessible).count();
    let authenticated = is_codex_authenticated(s, workspace_id);

    let mut section = Section::new().title("ChatGPT apps for Codex").description(
        "Enable ChatGPT apps from the Codex app-server for the current folder or chat.",
    );

    if let Some(ws_id) = workspace_id {
        let ws_refresh = ws_id.to_string();
        section = section.action(
            Button::new("Refresh")
                .variant(ButtonVariant::Outline)
                .control_size(ControlSize::Small)
                .on_press(move |s: &mut AppState| {
                    s.dispatch(Action::Settings(
                        SettingsAction::RefreshOpenAiNativeConnectors {
                            workspace_id: ws_refresh.clone(),
                        },
                    ));
                })
                .build(k),
        );
    }

    let status_bar = row()
        .w_full()
        .items_center()
        .gap(8.0)
        .px(16.0)
        .py(12.0)
        .child(status_pill(
            if authenticated {
                "Codex authenticated"
            } else {
                "Codex sign-in required"
            },
            if authenticated {
                StatusTone::Success
            } else {
                StatusTone::Warning
            },
            k,
            t,
        ))
        .child(status_pill(
            format!("{enabled_count} enabled"),
            StatusTone::Neutral,
            k,
            t,
        ))
        .child(status_pill(
            format!("{accessible_count} connected"),
            StatusTone::Neutral,
            k,
            t,
        ));
    section = section.child(status_bar);

    let Some(ws_id) = workspace_id else {
        return section
            .child(
                el().px(16.0).py(16.0).child(
                    EmptyState::new("No workspace selected")
                        .icon(&icons::BOT)
                        .description("Select a workspace to manage ChatGPT apps.")
                        .build(k, t),
                ),
            )
            .build(k, t);
    };

    if items.is_empty() {
        return section
            .child(
                el().px(16.0).py(16.0).child(
                    EmptyState::new("No connectors loaded")
                        .icon(&icons::SEARCH)
                        .description(
                            "Refresh after signing in to Codex or connecting ChatGPT apps.",
                        )
                        .build(k, t),
                ),
            )
            .build(k, t);
    }

    let filter_bar = row()
        .w_full()
        .items_center()
        .justify_between()
        .flex_wrap()
        .gap(12.0)
        .px(16.0)
        .py(12.0)
        .child(search_input(
            &s.settings_ui.connectors_search_edit,
            "Search connectors",
            "Search connectors by name, id, or description",
            Some(340.0),
            |s: &mut AppState| &mut s.settings_ui.connectors_search_edit,
            |s: &mut AppState, _tx| {
                s.settings_ui.connectors_search_edit = rune::TextEdit::new("");
            },
            k,
        ))
        .child(
            row()
                .items_center()
                .gap(8.0)
                .shrink()
                .child(
                    text("Enabled only")
                        .font(k.ty.small_medium)
                        .color(t.text_muted),
                )
                .child(mini_switch(
                    s.settings_ui.connectors_enabled_only,
                    "Show enabled connectors only",
                    false,
                    |s: &mut AppState| {
                        s.settings_ui.connectors_enabled_only =
                            !s.settings_ui.connectors_enabled_only;
                    },
                    k,
                )),
        );
    section = section.child(filter_bar);

    let visible = filter_connectors(
        &items,
        &s.settings_ui.connectors_search_edit.text,
        s.settings_ui.connectors_enabled_only,
    );
    if visible.is_empty() {
        return section
            .child(
                el().px(16.0).py(16.0).child(
                    EmptyState::new("No connectors match the current filters")
                        .icon(&icons::SEARCH)
                        .description("Adjust the search query or turn off \"Enabled only\".")
                        .build(k, t),
                ),
            )
            .build(k, t);
    }

    for item in visible {
        section = section.child(render_connector_row(s, item, ws_id, k, t));
    }

    section.build(k, t)
}

fn render_connector_row(
    s: &AppState,
    item: &ConnectorItem,
    ws_id: &str,
    k: &Kit,
    t: &ThemeTokens,
) -> El {
    let mut badges = row()
        .items_center()
        .gap(8.0)
        .child(text(&item.name).font(k.ty.ui_medium).color(t.text_base));
    if item.is_workspace_connector {
        badges = badges.child(status_pill("Workspace", StatusTone::Neutral, k, t));
    }
    badges = badges.child(status_pill(
        if item.is_accessible {
            "Connected"
        } else {
            "Directory"
        },
        if item.is_accessible {
            StatusTone::Success
        } else {
            StatusTone::Neutral
        },
        k,
        t,
    ));

    let mut meta_col = col()
        .grow(1.0)
        .min_w(0.0)
        .gap(4.0)
        .child(badges)
        .child(text(&item.id).font(k.ty.small).color(t.text_muted));

    if let Some(desc) = item.description.as_deref() {
        meta_col = meta_col.child(text(desc).font(k.ty.small).color(t.text_muted).wrap());
    }

    if let Some(url) = item.install_url.as_deref() {
        let external = url.to_string();
        meta_col = meta_col.child(
            el().pt(2.0).child(
                Button::new("Manage in ChatGPT")
                    .variant(ButtonVariant::Ghost)
                    .icon(&icons::EXTERNAL_LINK)
                    .control_size(ControlSize::Small)
                    .on_press(move |s: &mut AppState| {
                        s.dispatch(Action::Shell(ShellAction::RequestExternalUrl(
                            external.clone(),
                        )));
                    })
                    .build(k),
            ),
        );
    }

    let ws_toggle = ws_id.to_string();
    let conn_id = item.id.clone();
    let next_enabled = !item.is_enabled;
    let switch_el = mini_switch(
        item.is_enabled,
        format!("Enable {}", item.name),
        !item.is_accessible,
        move |s: &mut AppState| {
            s.dispatch(Action::Settings(
                SettingsAction::SetOpenAiNativeConnectorEnabled {
                    workspace_id: ws_toggle.clone(),
                    connector_id: conn_id.clone(),
                    enabled: next_enabled,
                },
            ));
        },
        k,
    );

    row()
        .w_full()
        .min_w(0.0)
        .items_start()
        .justify_between()
        .gap(12.0)
        .px(16.0)
        .py(12.0)
        .child(
            row()
                .grow(1.0)
                .min_w(0.0)
                .items_start()
                .gap(12.0)
                .child(entity_icon(
                    s,
                    item.logo_url.as_deref(),
                    &item.name,
                    EntityIconSize::Md,
                    k,
                    t,
                ))
                .child(meta_col),
        )
        .child(el().pt(2.0).shrink().child(switch_el))
}
