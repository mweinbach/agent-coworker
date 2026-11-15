//! Custom MCP servers management tab inside Tool Access (`apps/desktop/src/ui/settings/pages/McpServersPage.tsx`).

use std::cmp::Ordering;

use rune::{El, ScrollSpec, TextEdit, col, el, icon, row, text};
use rune_kit::{Button, ButtonVariant, ControlSize, Dialog, Kit, TextArea, TextInput};
use serde_json::Value;

use crate::actions::{Action, SettingsAction};
use crate::state::{AppState, McpServerSummary};
use crate::theme::ThemeTokens;
use crate::views::settings::icons;
use crate::views::settings::mcp_server_draft::{
    McpDraftInput, McpServerDraftExtras, build_mcp_server_config_with_extras,
    draft_extras_from_summary, draft_from_summary,
};
use crate::views::settings::primitives::{
    ConfirmDialogSpec, EmptyState, EntityIconSize, Section, StatusTone, callout_banner,
    compact_tabs, confirm_dialog, entity_icon, mini_switch, search_input, status_pill,
};

fn source_rank(source: Option<&str>) -> u8 {
    match source.unwrap_or("workspace") {
        "user" => 0,
        "workspace" => 1,
        "plugin" => 2,
        "system" => 3,
        _ => 9,
    }
}

/// Stable ordering by source (`user`, `workspace`, `plugin`, `system`) then name.
pub fn compare_mcp_servers(a: &McpServerSummary, b: &McpServerSummary) -> Ordering {
    source_rank(Some(effective_source(a)))
        .cmp(&source_rank(Some(effective_source(b))))
        .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
}

/// Human-friendly source badge matching `McpServersPage.tsx`.
pub fn source_label(source: Option<&str>) -> &'static str {
    match source.unwrap_or("workspace") {
        "user" => "All projects",
        "workspace" => "This project",
        "plugin" => "Plugin",
        "system" => "Built-in",
        _ => "Custom",
    }
}

/// Editable source if the server can be modified directly (`user` or `workspace`).
pub fn editable_source(source: Option<&str>) -> Option<&'static str> {
    match source {
        Some("user") => Some("user"),
        Some("workspace") => Some("workspace"),
        _ => None,
    }
}

/// Resolves the authoritative source from `summary.config["source"]` (live catalog entries)
/// before `summary.source` (which legacy state ingestion may default to `"workspace"`).
pub fn effective_source(server: &McpServerSummary) -> &str {
    server
        .config
        .get("source")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .or(server.source.as_deref())
        .unwrap_or("workspace")
}

/// Resolves the MCP transport protocol type from `summary.config` before `summary.transport`.
pub fn transport_kind_of(server: &McpServerSummary) -> String {
    let transport_obj = server.config.get("transport").unwrap_or(&server.config);
    transport_obj
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or(server.transport.as_str())
        .to_ascii_lowercase()
}

/// Resolves any server error or failed auth message emitted by the MCP catalog.
pub fn server_error_message(server: &McpServerSummary) -> Option<&str> {
    if let Some(err) = server
        .error
        .as_deref()
        .map(str::trim)
        .filter(|e| !e.is_empty())
    {
        return Some(err);
    }
    let auth_mode = server
        .auth_status
        .as_deref()
        .or_else(|| server.config.get("authMode").and_then(Value::as_str));
    if auth_mode == Some("error") {
        return server
            .config
            .get("authMessage")
            .and_then(Value::as_str)
            .or_else(|| {
                server
                    .config
                    .pointer("/authState/message")
                    .and_then(Value::as_str)
            })
            .map(str::trim)
            .filter(|m| !m.is_empty());
    }
    None
}

fn server_has_error(server: &McpServerSummary) -> bool {
    server_error_message(server).is_some()
        || server.auth_status.as_deref() == Some("error")
        || server.config.get("authMode").and_then(Value::as_str) == Some("error")
}

/// Stable UI identity key combining source and server name.
pub fn server_identity_key(server: &McpServerSummary) -> String {
    format!("{}:{}", effective_source(server), server.name)
}

/// Formats transport command or URL for collapsed/expanded inspection rows.
pub fn format_connection_line(server: &McpServerSummary) -> String {
    let transport_obj = server.config.get("transport").unwrap_or(&server.config);
    let kind = transport_obj
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or(server.transport.as_str())
        .to_ascii_lowercase();
    if kind == "stdio" {
        let cmd = transport_obj
            .get("command")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let args: Vec<&str> = transport_obj
            .get("args")
            .and_then(Value::as_array)
            .map(|arr| arr.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        if cmd.is_empty() {
            "stdio".to_string()
        } else if args.is_empty() {
            cmd.to_string()
        } else {
            format!("{cmd} {}", args.join(" "))
        }
    } else {
        transport_obj
            .get("url")
            .and_then(Value::as_str)
            .filter(|u| !u.trim().is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| kind.to_uppercase())
    }
}

/// Reads the auth type declared on an MCP server summary, if any.
pub fn server_auth_type(server: &McpServerSummary) -> Option<&str> {
    server
        .config
        .pointer("/auth/type")
        .and_then(Value::as_str)
        .or_else(|| {
            server
                .config
                .get("transport")
                .and_then(|t| t.pointer("/auth/type"))
                .and_then(Value::as_str)
        })
}

/// Maps server auth mode into a readable status label.
pub fn auth_mode_label(server: &McpServerSummary) -> String {
    let raw = server
        .auth_status
        .as_deref()
        .or_else(|| server.config.get("authMode").and_then(Value::as_str))
        .or_else(|| server_auth_type(server))
        .unwrap_or("none");
    match raw {
        "none" => "None".to_string(),
        "missing" => "Not connected".to_string(),
        "api_key" => "API key".to_string(),
        "oauth" => "OAuth".to_string(),
        "oauth_pending" => "OAuth sign-in pending".to_string(),
        "error" => "Error".to_string(),
        other => other.to_string(),
    }
}

/// True when an OAuth MCP server requires sign-in or re-authorization.
pub fn server_needs_oauth(server: &McpServerSummary) -> bool {
    let auth_mode = server
        .auth_status
        .as_deref()
        .or_else(|| server.config.get("authMode").and_then(Value::as_str));
    let is_oauth = server_auth_type(server) == Some("oauth")
        || matches!(auth_mode, Some("oauth" | "oauth_pending"));
    is_oauth && matches!(auth_mode, Some("missing" | "oauth_pending" | "error"))
}

/// Resets the MCP server editor to a blank create draft.
pub fn open_create_editor(s: &mut AppState) {
    s.settings_ui.mcp_editor_open = true;
    s.settings_ui.mcp_editing_name = None;
    s.settings_ui.mcp_editing_source = Some("user".to_string());
    s.settings_ui.mcp_editing_base_config = None;
    s.settings_ui.mcp_transport = "http".to_string();
    s.settings_ui.mcp_enabled = true;
    s.settings_ui.mcp_name_edit = TextEdit::new("");
    s.settings_ui.mcp_command_edit = TextEdit::new("");
    s.settings_ui.mcp_args_edit = TextEdit::new("");
    s.settings_ui.mcp_url_edit = TextEdit::new("");
    s.settings_ui.mcp_env_edit = TextEdit::new("");
    s.settings_ui.mcp_headers_edit = TextEdit::new("");
    s.settings_ui.mcp_cwd_edit = TextEdit::new("");
    s.settings_ui.mcp_icon_edit = TextEdit::new("");
    s.settings_ui.mcp_required = false;
    s.settings_ui.mcp_retries_edit = TextEdit::new("");
    s.settings_ui.mcp_auth_type = "none".to_string();
    s.settings_ui.mcp_auth_header_name_edit = TextEdit::new("");
    s.settings_ui.mcp_auth_prefix_edit = TextEdit::new("");
    s.settings_ui.mcp_auth_key_id_edit = TextEdit::new("");
    s.settings_ui.mcp_oauth_scope_edit = TextEdit::new("");
    s.settings_ui.mcp_oauth_resource_edit = TextEdit::new("");
    s.settings_ui.mcp_oauth_mode = "auto".to_string();
    s.settings_ui.mcp_editor_error = None;
    s.settings_ui.mcp_editor_advanced_open = false;
}

fn open_edit_editor(s: &mut AppState, summary: &McpServerSummary) {
    let draft = draft_from_summary(summary);
    let extras = draft_extras_from_summary(summary);
    let source = effective_source(summary);
    s.settings_ui.mcp_editor_open = true;
    s.settings_ui.mcp_editing_name = Some(summary.name.clone());
    s.settings_ui.mcp_editing_source =
        Some(editable_source(Some(source)).unwrap_or("user").to_string());
    s.settings_ui.mcp_editing_base_config = Some(summary.config.clone());
    s.settings_ui.mcp_transport = draft.transport;
    s.settings_ui.mcp_enabled = draft.enabled;
    s.settings_ui.mcp_name_edit = TextEdit::new(draft.name);
    s.settings_ui.mcp_command_edit = TextEdit::new(draft.command);
    s.settings_ui.mcp_args_edit = TextEdit::new(draft.args);
    s.settings_ui.mcp_url_edit = TextEdit::new(draft.url);
    s.settings_ui.mcp_env_edit = TextEdit::new(draft.env_lines);
    s.settings_ui.mcp_headers_edit = TextEdit::new(draft.header_lines);
    s.settings_ui.mcp_cwd_edit = TextEdit::new(extras.cwd);
    s.settings_ui.mcp_icon_edit = TextEdit::new(extras.icon);
    s.settings_ui.mcp_required = extras.required;
    s.settings_ui.mcp_retries_edit = TextEdit::new(extras.retries);
    s.settings_ui.mcp_auth_type = extras.auth_type;
    s.settings_ui.mcp_auth_header_name_edit = TextEdit::new(extras.header_name);
    s.settings_ui.mcp_auth_prefix_edit = TextEdit::new(extras.prefix);
    s.settings_ui.mcp_auth_key_id_edit = TextEdit::new(extras.key_id);
    s.settings_ui.mcp_oauth_scope_edit = TextEdit::new(extras.oauth_scope);
    s.settings_ui.mcp_oauth_resource_edit = TextEdit::new(extras.oauth_resource);
    s.settings_ui.mcp_oauth_mode = extras.oauth_mode;
    s.settings_ui.mcp_editor_error = None;
    s.settings_ui.mcp_editor_advanced_open = false;
}

fn close_editor(s: &mut AppState) {
    s.settings_ui.mcp_editor_open = false;
    s.settings_ui.mcp_editing_name = None;
    s.settings_ui.mcp_editing_source = None;
    s.settings_ui.mcp_editing_base_config = None;
    s.settings_ui.mcp_editor_error = None;
}

/// Renders the Custom connectors (MCP servers) tab view inside `ToolAccess`.
pub fn view_tab(
    s: &AppState,
    workspace_id: Option<&str>,
    k: &Kit,
    t: &ThemeTokens,
    overlays: &mut Vec<El>,
) -> El {
    let Some(ws_id) = workspace_id else {
        return Section::new()
            .title("Custom connectors")
            .description("Connect external tools and services via MCP.")
            .child(
                el().px(16.0).py(16.0).child(
                    EmptyState::new("No workspace selected")
                        .icon(&icons::WRENCH)
                        .description("Select or add a workspace to manage custom connectors.")
                        .build(k, t),
                ),
            )
            .build(k, t);
    };

    let ws_for_add = ws_id.to_string();
    let mut servers: Vec<&McpServerSummary> = s.mcp_servers.iter().collect();
    servers.sort_by(|a, b| compare_mcp_servers(a, b));

    let query = s
        .settings_ui
        .mcp_search_edit
        .text
        .trim()
        .to_ascii_lowercase();
    let visible: Vec<&McpServerSummary> = servers
        .iter()
        .copied()
        .filter(|srv| {
            if query.is_empty() {
                true
            } else {
                srv.name.to_ascii_lowercase().contains(&query)
                    || transport_kind_of(srv).contains(&query)
                    || format_connection_line(srv)
                        .to_ascii_lowercase()
                        .contains(&query)
                    || source_label(Some(effective_source(srv)))
                        .to_ascii_lowercase()
                        .contains(&query)
            }
        })
        .collect();

    let mut section = Section::new()
        .title("Custom connectors")
        .description("Connect remote HTTP/SSE MCP servers or run local stdio tools.");

    if !servers.is_empty() {
        section = section.action(
            Button::new("Add connector")
                .variant(ButtonVariant::Contrast)
                .icon(&icons::PLUS)
                .control_size(ControlSize::Small)
                .on_press(|s: &mut AppState| {
                    open_create_editor(s);
                })
                .build(k),
        );
    }

    if servers.is_empty() {
        let empty = EmptyState::new("No custom connectors configured")
            .icon(&icons::WRENCH)
            .description("Add a hosted remote server URL or a local stdio command.")
            .action(
                Button::new("Add connector")
                    .variant(ButtonVariant::Contrast)
                    .icon(&icons::PLUS)
                    .control_size(ControlSize::Regular)
                    .on_press(|s: &mut AppState| {
                        open_create_editor(s);
                    })
                    .build(k),
            )
            .build(k, t);
        section = section.child(el().px(16.0).py(16.0).child(empty));
    } else {
        let filter_bar = row()
            .w_full()
            .items_center()
            .flex_wrap()
            .gap(12.0)
            .px(16.0)
            .py(12.0)
            .child(search_input(
                &s.settings_ui.mcp_search_edit,
                "Search connectors",
                "Search connectors...",
                Some(280.0),
                |s: &mut AppState| &mut s.settings_ui.mcp_search_edit,
                |s: &mut AppState, _tx| {
                    s.settings_ui.mcp_search_edit = TextEdit::new("");
                },
                k,
            ))
            .child(el().grow(1.0))
            .child(status_pill(
                format!("{} of {}", visible.len(), servers.len()),
                StatusTone::Neutral,
                k,
                t,
            ));
        section = section.child(filter_bar);

        if visible.is_empty() {
            section = section.child(
                el().px(16.0).py(16.0).child(
                    EmptyState::new("No matching connectors")
                        .icon(&icons::SEARCH)
                        .description(format!(
                            "No connectors matched \"{}\".",
                            s.settings_ui.mcp_search_edit.text.trim()
                        ))
                        .build(k, t),
                ),
            );
        } else {
            for srv in visible {
                section = section.child(render_server_row(s, srv, ws_id, k, t));
            }
        }
    }

    append_editor_dialog(s, &ws_for_add, k, t, overlays);
    append_delete_confirm_dialog(s, &ws_for_add, k, overlays);

    section.build(k, t)
}

fn render_server_row(
    s: &AppState,
    srv: &McpServerSummary,
    ws_id: &str,
    k: &Kit,
    t: &ThemeTokens,
) -> El {
    let identity = server_identity_key(srv);
    let is_expanded = s.settings_ui.expanded_mcp_servers.contains(&identity);
    let source_str = effective_source(srv).to_string();
    let can_edit = editable_source(Some(source_str.as_str())).is_some();
    let needs_oauth = server_needs_oauth(srv);

    let chevron = if is_expanded {
        &icons::CHEVRON_DOWN
    } else {
        &icons::CHEVRON_RIGHT
    };

    let identity_toggle = identity.clone();
    let expand_header = row()
        .grow(1.0)
        .min_w(0.0)
        .items_center()
        .gap(10.0)
        .radius(k.radius.md)
        .px(4.0)
        .py(4.0)
        .hover(t.hover)
        .role("button")
        .label(format!("Toggle details for {}", srv.name))
        .on_press(move |s: &mut AppState| {
            if s.settings_ui
                .expanded_mcp_servers
                .contains(&identity_toggle)
            {
                s.settings_ui.expanded_mcp_servers.remove(&identity_toggle);
            } else {
                s.settings_ui
                    .expanded_mcp_servers
                    .insert(identity_toggle.clone());
            }
        })
        .child(icon(chevron, 14.0).color(t.text_muted))
        .child(entity_icon(s, None, &srv.name, EntityIconSize::Sm, k, t))
        .child(
            text(&srv.name)
                .font(k.ty.ui_medium)
                .color(t.text_base)
                .min_w(0.0),
        )
        .child(status_pill(
            source_label(Some(&source_str)),
            StatusTone::Neutral,
            k,
            t,
        ));

    let mut badges_header = expand_header;
    if !srv.enabled {
        badges_header = badges_header.child(status_pill("Disabled", StatusTone::Neutral, k, t));
    } else if needs_oauth {
        badges_header =
            badges_header.child(status_pill("Sign-in required", StatusTone::Warning, k, t));
    } else if server_has_error(srv) {
        badges_header = badges_header.child(status_pill("Error", StatusTone::Danger, k, t));
    } else if srv
        .status
        .as_deref()
        .is_some_and(|st| matches!(st, "connected" | "ok" | "ready"))
    {
        badges_header = badges_header.child(status_pill("Connected", StatusTone::Success, k, t));
    }

    let ws_enable = ws_id.to_string();
    let srv_name_enable = srv.name.clone();
    let srv_source_enable = source_str.clone();
    let enabled_next = !srv.enabled;

    let mut controls = row().items_center().gap(8.0).shrink();

    if needs_oauth {
        let ws_auth = ws_id.to_string();
        let name_auth = srv.name.clone();
        let src_auth = source_str.clone();
        controls = controls.child(
            Button::new("Authenticate")
                .variant(ButtonVariant::Outline)
                .control_size(ControlSize::Small)
                .on_press(move |s: &mut AppState| {
                    s.dispatch(Action::Settings(SettingsAction::AuthorizeMcpOAuth {
                        workspace_id: ws_auth.clone(),
                        name: name_auth.clone(),
                        source: src_auth.clone(),
                    }));
                })
                .build(k),
        );
    }

    controls = controls.child(mini_switch(
        srv.enabled,
        format!("Enable {}", srv.name),
        false,
        move |s: &mut AppState| {
            s.dispatch(Action::Settings(SettingsAction::SetMcpServerEnabled {
                workspace_id: ws_enable.clone(),
                name: srv_name_enable.clone(),
                source: srv_source_enable.clone(),
                enabled: enabled_next,
            }));
        },
        k,
    ));

    if can_edit {
        let srv_snapshot = srv.clone();
        controls = controls.child(
            Button::new("Edit")
                .variant(ButtonVariant::Ghost)
                .control_size(ControlSize::Small)
                .on_press(move |s: &mut AppState| {
                    open_edit_editor(s, &srv_snapshot);
                })
                .build(k),
        );
    }

    let top_row = row()
        .w_full()
        .min_w(0.0)
        .items_center()
        .justify_between()
        .gap(12.0)
        .px(16.0)
        .py(10.0)
        .child(badges_header)
        .child(controls);

    let mut container = col().w_full().min_w(0.0).child(top_row);
    if !is_expanded {
        return container;
    }

    let mut details = col()
        .w_full()
        .min_w(0.0)
        .gap(10.0)
        .px(42.0)
        .pb(14.0)
        .child(kv_line("Connection", &format_connection_line(srv), k, t))
        .child(kv_line("Authentication", &auth_mode_label(srv), k, t));

    if let Some(err) = server_error_message(srv) {
        details = details.child(callout_banner(StatusTone::Danger, err, k, t));
    }

    let ws_val = ws_id.to_string();
    let name_val = srv.name.clone();
    let src_val = source_str.clone();
    let mut actions = row().items_center().gap(8.0).pt(4.0).child(
        Button::new("Test connection")
            .variant(ButtonVariant::Outline)
            .control_size(ControlSize::Small)
            .on_press(move |s: &mut AppState| {
                s.dispatch(Action::Settings(SettingsAction::ValidateMcpServer {
                    workspace_id: ws_val.clone(),
                    name: name_val.clone(),
                    source: src_val.clone(),
                }));
            })
            .build(k),
    );

    let auth_kind = server_auth_type(srv).unwrap_or("");
    if auth_kind == "oauth" || needs_oauth {
        let ws_oauth = ws_id.to_string();
        let name_oauth = srv.name.clone();
        let src_oauth = source_str.clone();
        let id_oauth = identity.clone();
        actions = actions
            .child(
                Button::new("Sign in")
                    .variant(ButtonVariant::Contrast)
                    .control_size(ControlSize::Small)
                    .on_press(move |s: &mut AppState| {
                        s.dispatch(Action::Settings(SettingsAction::AuthorizeMcpOAuth {
                            workspace_id: ws_oauth.clone(),
                            name: name_oauth.clone(),
                            source: src_oauth.clone(),
                        }));
                    })
                    .build(k),
            )
            .child(
                Button::new("Paste sign-in code")
                    .variant(ButtonVariant::Ghost)
                    .control_size(ControlSize::Small)
                    .on_press(move |s: &mut AppState| {
                        let same =
                            s.settings_ui.mcp_oauth_entry_key.as_deref() == Some(id_oauth.as_str());
                        s.settings_ui.mcp_oauth_entry_key =
                            if same { None } else { Some(id_oauth.clone()) };
                    })
                    .build(k),
            );
    }

    if can_edit {
        let del_name = srv.name.clone();
        let del_source = source_str.clone();
        actions = actions.child(
            Button::new("Remove")
                .variant(ButtonVariant::Danger)
                .control_size(ControlSize::Small)
                .on_press(move |s: &mut AppState| {
                    s.settings_ui.mcp_delete_confirm = Some((del_name.clone(), del_source.clone()));
                })
                .build(k),
        );
    }

    details = details.child(actions);

    if s.settings_ui.mcp_oauth_entry_key.as_deref() == Some(identity.as_str()) {
        let ws_cb = ws_id.to_string();
        let name_cb = srv.name.clone();
        let src_cb = source_str.clone();
        details = details.child(
            row()
                .w_full()
                .items_center()
                .gap(8.0)
                .pt(4.0)
                .child(
                    TextInput::new(&s.settings_ui.mcp_oauth_code_edit)
                        .placeholder("Paste OAuth callback URL or code...")
                        .width(Some(280.0))
                        .on_edit(|s: &mut AppState| &mut s.settings_ui.mcp_oauth_code_edit)
                        .build(k),
                )
                .child(
                    Button::new("Continue")
                        .variant(ButtonVariant::Outline)
                        .control_size(ControlSize::Small)
                        .on_press(move |s: &mut AppState| {
                            let code = s.settings_ui.mcp_oauth_code_edit.text.trim().to_string();
                            if !code.is_empty() {
                                s.dispatch(Action::Settings(
                                    SettingsAction::CompleteMcpOAuthCallback {
                                        workspace_id: ws_cb.clone(),
                                        name: name_cb.clone(),
                                        source: src_cb.clone(),
                                        callback_url: code,
                                    },
                                ));
                                s.settings_ui.mcp_oauth_code_edit = TextEdit::new("");
                                s.settings_ui.mcp_oauth_entry_key = None;
                            }
                        })
                        .build(k),
                ),
        );
    }

    if auth_kind == "api_key"
        || matches!(
            srv.auth_status
                .as_deref()
                .or_else(|| srv.config.get("authMode").and_then(Value::as_str)),
            Some("api_key")
        )
    {
        let ws_key = ws_id.to_string();
        let name_key = srv.name.clone();
        let src_key = source_str;
        let id_edit = identity.clone();
        let id_save = identity;
        let empty_key_edit = TextEdit::new("");
        let current_key_edit = s
            .settings_ui
            .mcp_api_key_edits
            .get(&id_edit)
            .unwrap_or(&empty_key_edit);
        details = details.child(
            row()
                .w_full()
                .items_center()
                .gap(8.0)
                .pt(4.0)
                .child(
                    TextInput::new(current_key_edit)
                        .placeholder("Paste API key...")
                        .width(Some(260.0))
                        .on_edit(move |s: &mut AppState| {
                            s.settings_ui
                                .mcp_api_key_edits
                                .entry(id_edit.clone())
                                .or_insert_with(|| TextEdit::new(""))
                        })
                        .build(k),
                )
                .child(
                    Button::new("Save key")
                        .variant(ButtonVariant::Outline)
                        .control_size(ControlSize::Small)
                        .on_press(move |s: &mut AppState| {
                            let key = s
                                .settings_ui
                                .mcp_api_key_edits
                                .get(&id_save)
                                .map(|e| e.text.trim().to_string())
                                .unwrap_or_default();
                            if !key.is_empty() {
                                s.dispatch(Action::Settings(SettingsAction::SetMcpServerApiKey {
                                    workspace_id: ws_key.clone(),
                                    name: name_key.clone(),
                                    source: src_key.clone(),
                                    api_key: key,
                                }));
                                s.settings_ui.mcp_api_key_edits.remove(&id_save);
                            }
                        })
                        .build(k),
                ),
        );
    }

    container = container.child(details);
    container
}

fn kv_line(label: &str, value: &str, k: &Kit, t: &ThemeTokens) -> El {
    row()
        .w_full()
        .min_w(0.0)
        .items_start()
        .gap(12.0)
        .child(
            text(label)
                .font(k.ty.small_medium)
                .color(t.text_muted)
                .w(110.0)
                .shrink(),
        )
        .child(
            text(value)
                .font(k.ty.small)
                .color(t.text_base)
                .grow(1.0)
                .min_w(0.0)
                .wrap(),
        )
}

fn labeled_dialog_field(label: &str, child: El, k: &Kit, t: &ThemeTokens) -> El {
    col()
        .w_full()
        .min_w(0.0)
        .gap(4.0)
        .child(text(label).font(k.ty.small_medium).color(t.text_muted))
        .child(child)
}

fn append_editor_dialog(
    s: &AppState,
    ws_id: &str,
    k: &Kit,
    t: &ThemeTokens,
    overlays: &mut Vec<El>,
) {
    if !s.settings_ui.mcp_editor_open {
        return;
    }

    let is_edit = s.settings_ui.mcp_editing_name.is_some();
    let title = if is_edit {
        "Edit connector"
    } else {
        "Add connector"
    };

    let scope_idx = usize::from(s.settings_ui.mcp_editing_source.as_deref() == Some("workspace"));
    let scope_seg = compact_tabs(
        &["User (all workspaces)", "Workspace"],
        scope_idx,
        "Connector scope",
        |s: &mut AppState, idx, _tx| {
            if s.settings_ui.mcp_editing_name.is_none() {
                s.settings_ui.mcp_editing_source = Some(if idx == 1 {
                    "workspace".to_string()
                } else {
                    "user".to_string()
                });
            }
        },
        k,
    );

    let transport_idx = match s.settings_ui.mcp_transport.as_str() {
        "sse" => 1,
        "stdio" => 2,
        _ => 0,
    };
    let transport_seg = compact_tabs(
        &["Remote (HTTP)", "Legacy SSE", "Local (stdio)"],
        transport_idx,
        "Connector transport",
        |s: &mut AppState, idx, _tx| {
            s.settings_ui.mcp_transport = match idx {
                1 => "sse".to_string(),
                2 => "stdio".to_string(),
                _ => "http".to_string(),
            };
            s.settings_ui.mcp_editor_error = None;
        },
        k,
    );

    let mut fields = col().w_full().min_w(0.0).gap(10.0).child(
        text("Configure a remote MCP endpoint or a local command-line connector.")
            .font(k.ty.ui)
            .color(t.text_muted)
            .wrap(),
    );
    if !is_edit {
        fields = fields.child(labeled_dialog_field("Scope", scope_seg, k, t));
    }
    fields = fields
        .child(labeled_dialog_field("Transport", transport_seg, k, t))
        .child(labeled_dialog_field(
            "Name",
            TextInput::new(&s.settings_ui.mcp_name_edit)
                .label("Name")
                .placeholder("e.g. github-tools")
                .width(None)
                .on_edit(|s: &mut AppState| &mut s.settings_ui.mcp_name_edit)
                .build(k),
            k,
            t,
        ));

    if s.settings_ui.mcp_transport == "stdio" {
        fields = fields
            .child(labeled_dialog_field(
                "Command",
                TextInput::new(&s.settings_ui.mcp_command_edit)
                    .label("Command")
                    .placeholder("e.g. npx")
                    .width(None)
                    .on_edit(|s: &mut AppState| &mut s.settings_ui.mcp_command_edit)
                    .build(k),
                k,
                t,
            ))
            .child(labeled_dialog_field(
                "Arguments",
                TextInput::new(&s.settings_ui.mcp_args_edit)
                    .label("Arguments")
                    .placeholder("-y @modelcontextprotocol/server-filesystem .")
                    .width(None)
                    .on_edit(|s: &mut AppState| &mut s.settings_ui.mcp_args_edit)
                    .build(k),
                k,
                t,
            ))
            .child(labeled_dialog_field(
                "Environment variables (KEY=VALUE per line)",
                TextArea::new(&s.settings_ui.mcp_env_edit)
                    .label("Environment variables (KEY=VALUE per line)")
                    .placeholder("API_TOKEN=secret")
                    .width(None)
                    .rows(3)
                    .on_edit(|s: &mut AppState| &mut s.settings_ui.mcp_env_edit)
                    .build(k),
                k,
                t,
            ));
    } else {
        fields = fields
            .child(labeled_dialog_field(
                "Server URL",
                TextInput::new(&s.settings_ui.mcp_url_edit)
                    .label("Server URL")
                    .placeholder("https://example.com/mcp")
                    .width(None)
                    .on_edit(|s: &mut AppState| &mut s.settings_ui.mcp_url_edit)
                    .build(k),
                k,
                t,
            ))
            .child(labeled_dialog_field(
                "Authentication",
                {
                    let auth_idx = match s.settings_ui.mcp_auth_type.as_str() {
                        "api_key" => 1,
                        "oauth" => 2,
                        _ => 0,
                    };
                    compact_tabs(
                        &["None", "API key", "OAuth"],
                        auth_idx,
                        "Authentication",
                        |s: &mut AppState, idx, _tx| {
                            s.settings_ui.mcp_auth_type = match idx {
                                1 => "api_key".to_string(),
                                2 => "oauth".to_string(),
                                _ => "none".to_string(),
                            };
                        },
                        k,
                    )
                },
                k,
                t,
            ))
            .child(labeled_dialog_field(
                "HTTP headers (Name: value per line)",
                TextArea::new(&s.settings_ui.mcp_headers_edit)
                    .label("HTTP headers (Name: value per line)")
                    .placeholder("Authorization: Bearer ...")
                    .width(None)
                    .rows(3)
                    .on_edit(|s: &mut AppState| &mut s.settings_ui.mcp_headers_edit)
                    .build(k),
                k,
                t,
            ));
    }

    let adv_open = s.settings_ui.mcp_editor_advanced_open;
    fields = fields.child(
        row().w_full().child(
            Button::new(if adv_open {
                "Hide advanced"
            } else {
                "Advanced"
            })
            .variant(ButtonVariant::Ghost)
            .control_size(ControlSize::Small)
            .icon(if adv_open {
                &icons::CHEVRON_DOWN
            } else {
                &icons::CHEVRON_RIGHT
            })
            .on_press(|s: &mut AppState| {
                s.settings_ui.mcp_editor_advanced_open = !s.settings_ui.mcp_editor_advanced_open;
            })
            .build(k),
        ),
    );

    if adv_open {
        let mut adv = col().w_full().min_w(0.0).gap(10.0);
        if s.settings_ui.mcp_transport == "stdio" {
            adv = adv.child(labeled_dialog_field(
                "Working directory (optional)",
                TextInput::new(&s.settings_ui.mcp_cwd_edit)
                    .label("Working directory (optional)")
                    .placeholder("/path/to/directory")
                    .width(None)
                    .on_edit(|s: &mut AppState| &mut s.settings_ui.mcp_cwd_edit)
                    .build(k),
                k,
                t,
            ));
        } else if s.settings_ui.mcp_auth_type == "api_key" {
            adv = adv
                .child(labeled_dialog_field(
                    "API key header name (optional)",
                    TextInput::new(&s.settings_ui.mcp_auth_header_name_edit)
                        .label("API key header name (optional)")
                        .placeholder("Authorization")
                        .width(None)
                        .on_edit(|s: &mut AppState| &mut s.settings_ui.mcp_auth_header_name_edit)
                        .build(k),
                    k,
                    t,
                ))
                .child(
                    row()
                        .w_full()
                        .gap(8.0)
                        .child(
                            col()
                                .grow(1.0)
                                .min_w(0.0)
                                .gap(4.0)
                                .child(
                                    text("Prefix (optional)")
                                        .font(k.ty.small_medium)
                                        .color(t.text_muted),
                                )
                                .child(
                                    TextInput::new(&s.settings_ui.mcp_auth_prefix_edit)
                                        .label("Prefix (optional)")
                                        .placeholder("Bearer")
                                        .width(None)
                                        .on_edit(|s: &mut AppState| {
                                            &mut s.settings_ui.mcp_auth_prefix_edit
                                        })
                                        .build(k),
                                ),
                        )
                        .child(
                            col()
                                .grow(1.0)
                                .min_w(0.0)
                                .gap(4.0)
                                .child(
                                    text("Key ID (optional)")
                                        .font(k.ty.small_medium)
                                        .color(t.text_muted),
                                )
                                .child(
                                    TextInput::new(&s.settings_ui.mcp_auth_key_id_edit)
                                        .label("Key ID (optional)")
                                        .placeholder("default")
                                        .width(None)
                                        .on_edit(|s: &mut AppState| {
                                            &mut s.settings_ui.mcp_auth_key_id_edit
                                        })
                                        .build(k),
                                ),
                        ),
                );
        } else if s.settings_ui.mcp_auth_type == "oauth" {
            let mode_idx = usize::from(s.settings_ui.mcp_oauth_mode == "code");
            adv = adv
                .child(labeled_dialog_field(
                    "OAuth flow mode",
                    compact_tabs(
                        &["Automatic", "Paste a code"],
                        mode_idx,
                        "OAuth flow mode",
                        |s: &mut AppState, idx, _tx| {
                            s.settings_ui.mcp_oauth_mode = if idx == 1 {
                                "code".to_string()
                            } else {
                                "auto".to_string()
                            };
                        },
                        k,
                    ),
                    k,
                    t,
                ))
                .child(
                    row()
                        .w_full()
                        .gap(8.0)
                        .child(
                            col()
                                .grow(1.0)
                                .min_w(0.0)
                                .gap(4.0)
                                .child(
                                    text("OAuth scope (optional)")
                                        .font(k.ty.small_medium)
                                        .color(t.text_muted),
                                )
                                .child(
                                    TextInput::new(&s.settings_ui.mcp_oauth_scope_edit)
                                        .label("OAuth scope (optional)")
                                        .placeholder("read write")
                                        .width(None)
                                        .on_edit(|s: &mut AppState| {
                                            &mut s.settings_ui.mcp_oauth_scope_edit
                                        })
                                        .build(k),
                                ),
                        )
                        .child(
                            col()
                                .grow(1.0)
                                .min_w(0.0)
                                .gap(4.0)
                                .child(
                                    text("OAuth resource (optional)")
                                        .font(k.ty.small_medium)
                                        .color(t.text_muted),
                                )
                                .child(
                                    TextInput::new(&s.settings_ui.mcp_oauth_resource_edit)
                                        .label("OAuth resource (optional)")
                                        .placeholder("https://api.example.com")
                                        .width(None)
                                        .on_edit(|s: &mut AppState| {
                                            &mut s.settings_ui.mcp_oauth_resource_edit
                                        })
                                        .build(k),
                                ),
                        ),
                );
        }

        adv = adv
            .child(
                row()
                    .w_full()
                    .gap(8.0)
                    .child(
                        col()
                            .grow(1.0)
                            .min_w(0.0)
                            .gap(4.0)
                            .child(
                                text("Icon URL (optional)")
                                    .font(k.ty.small_medium)
                                    .color(t.text_muted),
                            )
                            .child(
                                TextInput::new(&s.settings_ui.mcp_icon_edit)
                                    .label("Icon URL (optional)")
                                    .placeholder("https://example.com/icon.png")
                                    .width(None)
                                    .on_edit(|s: &mut AppState| &mut s.settings_ui.mcp_icon_edit)
                                    .build(k),
                            ),
                    )
                    .child(
                        col()
                            .w(110.0)
                            .gap(4.0)
                            .child(
                                text("Retries (optional)")
                                    .font(k.ty.small_medium)
                                    .color(t.text_muted),
                            )
                            .child(
                                TextInput::new(&s.settings_ui.mcp_retries_edit)
                                    .label("Retries (optional)")
                                    .placeholder("3")
                                    .width(None)
                                    .on_edit(|s: &mut AppState| &mut s.settings_ui.mcp_retries_edit)
                                    .build(k),
                            ),
                    ),
            )
            .child(
                row()
                    .w_full()
                    .items_center()
                    .justify_between()
                    .child(
                        col()
                            .grow(1.0)
                            .min_w(0.0)
                            .gap(2.0)
                            .child(text("Required").font(k.ty.ui_medium).color(t.text_base))
                            .child(
                                text(
                                    "Treat sessions as broken when this connector fails to start.",
                                )
                                .font(k.ty.small)
                                .color(t.text_muted)
                                .wrap(),
                            ),
                    )
                    .child(mini_switch(
                        s.settings_ui.mcp_required,
                        "Required",
                        false,
                        |s: &mut AppState| {
                            s.settings_ui.mcp_required = !s.settings_ui.mcp_required;
                        },
                        k,
                    )),
            );
        fields = fields.child(adv);
    }

    fields = fields.child(
        row()
            .w_full()
            .items_center()
            .justify_between()
            .child(
                text("Enable connector immediately")
                    .font(k.ty.ui_medium)
                    .color(t.text_base),
            )
            .child(mini_switch(
                s.settings_ui.mcp_enabled,
                "Enabled",
                false,
                |s: &mut AppState| {
                    s.settings_ui.mcp_enabled = !s.settings_ui.mcp_enabled;
                },
                k,
            )),
    );

    if let Some(err) = s.settings_ui.mcp_editor_error.as_deref() {
        fields = fields.child(callout_banner(StatusTone::Danger, err, k, t));
    }

    let ws_save = ws_id.to_string();
    let footer = row()
        .w_full()
        .justify_end()
        .gap(8.0)
        .pt(6.0)
        .child(
            Button::new("Cancel")
                .variant(ButtonVariant::Ghost)
                .control_size(ControlSize::Regular)
                .on_press(|s: &mut AppState| {
                    close_editor(s);
                })
                .build(k),
        )
        .child(
            Button::new(if is_edit {
                "Save connector"
            } else {
                "Add connector"
            })
            .variant(ButtonVariant::Contrast)
            .control_size(ControlSize::Regular)
            .on_press(move |s: &mut AppState| {
                let draft = McpDraftInput {
                    name: s.settings_ui.mcp_name_edit.text.clone(),
                    transport: s.settings_ui.mcp_transport.clone(),
                    enabled: s.settings_ui.mcp_enabled,
                    command: s.settings_ui.mcp_command_edit.text.clone(),
                    args: s.settings_ui.mcp_args_edit.text.clone(),
                    url: s.settings_ui.mcp_url_edit.text.clone(),
                    env_lines: s.settings_ui.mcp_env_edit.text.clone(),
                    header_lines: s.settings_ui.mcp_headers_edit.text.clone(),
                };
                let extras = McpServerDraftExtras {
                    cwd: s.settings_ui.mcp_cwd_edit.text.clone(),
                    icon: s.settings_ui.mcp_icon_edit.text.clone(),
                    required: s.settings_ui.mcp_required,
                    retries: s.settings_ui.mcp_retries_edit.text.clone(),
                    auth_type: s.settings_ui.mcp_auth_type.clone(),
                    header_name: s.settings_ui.mcp_auth_header_name_edit.text.clone(),
                    prefix: s.settings_ui.mcp_auth_prefix_edit.text.clone(),
                    key_id: s.settings_ui.mcp_auth_key_id_edit.text.clone(),
                    oauth_scope: s.settings_ui.mcp_oauth_scope_edit.text.clone(),
                    oauth_resource: s.settings_ui.mcp_oauth_resource_edit.text.clone(),
                    oauth_mode: s.settings_ui.mcp_oauth_mode.clone(),
                };
                match build_mcp_server_config_with_extras(
                    &draft,
                    &extras,
                    s.settings_ui.mcp_editing_base_config.as_ref(),
                ) {
                    Ok((name, config)) => {
                        let source = s
                            .settings_ui
                            .mcp_editing_source
                            .clone()
                            .unwrap_or_else(|| "user".to_string());
                        let previous_name = s
                            .settings_ui
                            .mcp_editing_name
                            .clone()
                            .filter(|prev| prev != &name);
                        s.dispatch(Action::Settings(SettingsAction::UpsertScopedMcpServer {
                            workspace_id: ws_save.clone(),
                            name,
                            source,
                            previous_name,
                            server: config,
                        }));
                        close_editor(s);
                    }
                    Err(err) => {
                        s.settings_ui.mcp_editor_error = Some(err.message);
                    }
                }
            })
            .build(k),
        );

    let body = col()
        .w_full()
        .min_w(0.0)
        .px(16.0)
        .pb(16.0)
        .gap(12.0)
        .child(
            col()
                .w_full()
                .min_w(0.0)
                .max_h(520.0)
                .scroll(ScrollSpec {
                    stick_bottom: false,
                })
                .child(fields),
        )
        .child(footer);

    Dialog::new("mcp-server-editor-dialog", title)
        .open(true)
        .width(520.0)
        .fit()
        .on_close(|s: &mut AppState| {
            close_editor(s);
        })
        .child(body)
        .build(k, overlays);
}

fn append_delete_confirm_dialog(s: &AppState, ws_id: &str, k: &Kit, overlays: &mut Vec<El>) {
    let Some((name, source)) = s.settings_ui.mcp_delete_confirm.as_ref() else {
        return;
    };
    let ws_del = ws_id.to_string();
    let name_del = name.clone();
    let src_del = source.clone();
    confirm_dialog(
        ConfirmDialogSpec {
            key: "mcp-delete-confirm-dialog",
            title: "Remove connector",
            description: format!(
                "Remove connector \"{name}\"? Cowork will no longer be able to use tools from this server."
            ),
            confirm_label: "Remove",
            danger: true,
            open: true,
        },
        |s| {
            s.settings_ui.mcp_delete_confirm = None;
        },
        move |s| {
            s.dispatch(Action::Settings(SettingsAction::DeleteScopedMcpServer {
                workspace_id: ws_del.clone(),
                name: name_del.clone(),
                source: src_del.clone(),
            }));
            s.settings_ui.mcp_delete_confirm = None;
        },
        k,
        overlays,
    );
}
