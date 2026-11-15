//! Custom MCP servers management tab inside Tool Access (`apps/desktop/src/ui/settings/pages/McpServersPage.tsx`).

use std::cmp::Ordering;

use rune::{El, ScrollSpec, TextEdit, col, el, icon, row, text};
use rune_kit::{
    Button, ButtonVariant, ControlSize, Dialog, Kit, SegmentedControl, Switch, TextArea, TextInput,
};
use serde_json::Value;

use crate::actions::{Action, SettingsAction};
use crate::state::{AppState, McpServerSummary};
use crate::theme::ThemeTokens;
use crate::views::settings::icons;
use crate::views::settings::mcp_server_draft::{
    McpDraftInput, build_mcp_server_config, draft_from_summary,
};
use crate::views::settings::primitives::{
    ConfirmDialogSpec, EmptyState, EntityIconSize, Section, StatusTone, callout_banner,
    confirm_dialog, entity_icon, status_pill,
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
    source_rank(a.source.as_deref())
        .cmp(&source_rank(b.source.as_deref()))
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

/// Stable UI identity key combining source and server name.
pub fn server_identity_key(server: &McpServerSummary) -> String {
    format!(
        "{}:{}",
        server.source.as_deref().unwrap_or("workspace"),
        server.name
    )
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
    let is_oauth = server_auth_type(server) == Some("oauth")
        || matches!(
            server.auth_status.as_deref(),
            Some("oauth" | "oauth_pending")
        );
    is_oauth
        && matches!(
            server
                .auth_status
                .as_deref()
                .or_else(|| server.config.get("authMode").and_then(Value::as_str)),
            Some("missing" | "oauth_pending" | "error")
        )
}

/// Resets the MCP server editor to a blank create draft.
pub fn open_create_editor(s: &mut AppState) {
    s.settings_ui.mcp_editor_open = true;
    s.settings_ui.mcp_editing_name = None;
    s.settings_ui.mcp_transport = "http".to_string();
    s.settings_ui.mcp_enabled = true;
    s.settings_ui.mcp_name_edit = TextEdit::new("");
    s.settings_ui.mcp_command_edit = TextEdit::new("");
    s.settings_ui.mcp_args_edit = TextEdit::new("");
    s.settings_ui.mcp_url_edit = TextEdit::new("");
    s.settings_ui.mcp_env_edit = TextEdit::new("");
    s.settings_ui.mcp_headers_edit = TextEdit::new("");
    s.settings_ui.mcp_editor_error = None;
    s.settings_ui.mcp_editor_advanced_open = false;
}

fn open_edit_editor(s: &mut AppState, summary: &McpServerSummary) {
    let draft = draft_from_summary(summary);
    s.settings_ui.mcp_editor_open = true;
    s.settings_ui.mcp_editing_name = Some(summary.name.clone());
    s.settings_ui.mcp_transport = draft.transport;
    s.settings_ui.mcp_enabled = draft.enabled;
    s.settings_ui.mcp_name_edit = TextEdit::new(draft.name);
    s.settings_ui.mcp_command_edit = TextEdit::new(draft.command);
    s.settings_ui.mcp_args_edit = TextEdit::new(draft.args);
    s.settings_ui.mcp_url_edit = TextEdit::new(draft.url);
    s.settings_ui.mcp_env_edit = TextEdit::new(draft.env_lines);
    s.settings_ui.mcp_headers_edit = TextEdit::new(draft.header_lines);
    s.settings_ui.mcp_editor_error = None;
    s.settings_ui.mcp_editor_advanced_open = false;
}

fn close_editor(s: &mut AppState) {
    s.settings_ui.mcp_editor_open = false;
    s.settings_ui.mcp_editing_name = None;
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
    let add_btn = Button::new("+ Add connector")
        .variant(ButtonVariant::Contrast)
        .control_size(ControlSize::Small)
        .on_press(|s: &mut AppState| {
            open_create_editor(s);
        })
        .build(k);

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
                    || srv.transport.to_ascii_lowercase().contains(&query)
            }
        })
        .collect();

    let mut section = Section::new()
        .title("Custom connectors")
        .description("Connect remote HTTP/SSE MCP servers or run local stdio tools.")
        .action(add_btn);

    if servers.is_empty() {
        let empty = EmptyState::new("No custom connectors configured")
            .icon(&icons::WRENCH)
            .description("Add a hosted remote server URL or a local stdio command.")
            .action(
                Button::new("+ Add connector")
                    .variant(ButtonVariant::Outline)
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
            .gap(12.0)
            .px(16.0)
            .py(12.0)
            .child(
                TextInput::new(&s.settings_ui.mcp_search_edit)
                    .placeholder("Search connectors...")
                    .width(Some(280.0))
                    .on_edit(|s: &mut AppState| &mut s.settings_ui.mcp_search_edit)
                    .build(k),
            )
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
    let source_str = srv.source.as_deref().unwrap_or("workspace").to_string();
    let can_edit = editable_source(srv.source.as_deref()).is_some();
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
        .radius(6.0)
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
                .font(k.ty.body_medium)
                .color(t.text_base)
                .min_w(0.0),
        )
        .child(status_pill(
            source_label(srv.source.as_deref()),
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
    } else if srv.error.is_some() {
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

    controls = controls.child(
        Switch::new(srv.enabled)
            .label(format!("Enable {}", srv.name))
            .hide_label()
            .control_size(ControlSize::Mini)
            .on_toggle(move |s: &mut AppState| {
                s.dispatch(Action::Settings(SettingsAction::SetMcpServerEnabled {
                    workspace_id: ws_enable.clone(),
                    name: srv_name_enable.clone(),
                    source: srv_source_enable.clone(),
                    enabled: enabled_next,
                }));
            })
            .build(k),
    );

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

    if let Some(err) = srv.error.as_deref().filter(|e| !e.trim().is_empty()) {
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
        actions = actions.child(
            Button::new("Remove")
                .variant(ButtonVariant::Danger)
                .control_size(ControlSize::Small)
                .on_press(move |s: &mut AppState| {
                    s.settings_ui.mcp_delete_confirm_name = Some(del_name.clone());
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

    if auth_kind == "api_key" || matches!(srv.auth_status.as_deref(), Some("api_key")) {
        let ws_key = ws_id.to_string();
        let name_key = srv.name.clone();
        let src_key = source_str;
        details = details.child(
            row()
                .w_full()
                .items_center()
                .gap(8.0)
                .pt(4.0)
                .child(
                    TextInput::new(&s.settings_ui.mcp_api_key_edit)
                        .placeholder("Paste API key...")
                        .width(Some(260.0))
                        .on_edit(|s: &mut AppState| &mut s.settings_ui.mcp_api_key_edit)
                        .build(k),
                )
                .child(
                    Button::new("Save key")
                        .variant(ButtonVariant::Outline)
                        .control_size(ControlSize::Small)
                        .on_press(move |s: &mut AppState| {
                            let key = s.settings_ui.mcp_api_key_edit.text.trim().to_string();
                            if !key.is_empty() {
                                s.dispatch(Action::Settings(SettingsAction::SetMcpServerApiKey {
                                    workspace_id: ws_key.clone(),
                                    name: name_key.clone(),
                                    source: src_key.clone(),
                                    api_key: key,
                                }));
                                s.settings_ui.mcp_api_key_edit = TextEdit::new("");
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
                .font(k.ty.text_xsmall_medium)
                .color(t.text_muted)
                .w(110.0)
                .shrink(),
        )
        .child(
            text(value)
                .font(k.ty.text_xsmall)
                .color(t.text_base)
                .grow(1.0)
                .min_w(0.0)
                .wrap(),
        )
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

    let transport_idx = match s.settings_ui.mcp_transport.as_str() {
        "sse" => 1,
        "stdio" => 2,
        _ => 0,
    };
    let transport_seg = SegmentedControl::new(
        &["Remote (HTTP)", "Legacy SSE", "Local (stdio)"],
        Some(transport_idx),
    )
    .label("Connector transport")
    .fit()
    .on_pick(|s: &mut AppState, idx, _tx| {
        s.settings_ui.mcp_transport = match idx {
            1 => "sse".to_string(),
            2 => "stdio".to_string(),
            _ => "http".to_string(),
        };
        s.settings_ui.mcp_editor_error = None;
    })
    .build(k);

    let mut fields = col()
        .w_full()
        .min_w(0.0)
        .gap(12.0)
        .child(
            text("Configure a remote MCP endpoint or a local command-line connector.")
                .font(k.ty.text_small)
                .color(t.text_muted)
                .wrap(),
        )
        .child(transport_seg)
        .child(
            TextInput::new(&s.settings_ui.mcp_name_edit)
                .label("Name")
                .placeholder("e.g. github-tools")
                .width(None)
                .on_edit(|s: &mut AppState| &mut s.settings_ui.mcp_name_edit)
                .build(k),
        );

    if s.settings_ui.mcp_transport == "stdio" {
        fields = fields
            .child(
                TextInput::new(&s.settings_ui.mcp_command_edit)
                    .label("Command")
                    .placeholder("e.g. npx")
                    .width(None)
                    .on_edit(|s: &mut AppState| &mut s.settings_ui.mcp_command_edit)
                    .build(k),
            )
            .child(
                TextInput::new(&s.settings_ui.mcp_args_edit)
                    .label("Arguments")
                    .placeholder("-y @modelcontextprotocol/server-filesystem .")
                    .width(None)
                    .on_edit(|s: &mut AppState| &mut s.settings_ui.mcp_args_edit)
                    .build(k),
            )
            .child(
                TextArea::new(&s.settings_ui.mcp_env_edit)
                    .label("Environment variables (KEY=VALUE per line)")
                    .placeholder("API_TOKEN=secret")
                    .width(None)
                    .rows(3)
                    .on_edit(|s: &mut AppState| &mut s.settings_ui.mcp_env_edit)
                    .build(k),
            );
    } else {
        fields = fields
            .child(
                TextInput::new(&s.settings_ui.mcp_url_edit)
                    .label("Server URL")
                    .placeholder("https://example.com/mcp")
                    .width(None)
                    .on_edit(|s: &mut AppState| &mut s.settings_ui.mcp_url_edit)
                    .build(k),
            )
            .child(
                TextArea::new(&s.settings_ui.mcp_headers_edit)
                    .label("HTTP headers (Name: value per line)")
                    .placeholder("Authorization: Bearer ...")
                    .width(None)
                    .rows(3)
                    .on_edit(|s: &mut AppState| &mut s.settings_ui.mcp_headers_edit)
                    .build(k),
            );
    }

    fields = fields.child(
        row()
            .w_full()
            .items_center()
            .justify_between()
            .child(
                text("Enable connector immediately")
                    .font(k.ty.text_small)
                    .color(t.text_base),
            )
            .child(
                Switch::new(s.settings_ui.mcp_enabled)
                    .label("Enabled")
                    .hide_label()
                    .control_size(ControlSize::Mini)
                    .on_toggle(|s: &mut AppState| {
                        s.settings_ui.mcp_enabled = !s.settings_ui.mcp_enabled;
                    })
                    .build(k),
            ),
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
                .variant(ButtonVariant::Outline)
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
                match build_mcp_server_config(&draft) {
                    Ok((name, config)) => {
                        s.dispatch(Action::Settings(SettingsAction::UpsertMcpServer {
                            workspace_id: ws_save.clone(),
                            name,
                            config,
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
                .max_h(430.0)
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
    let Some(name) = s.settings_ui.mcp_delete_confirm_name.as_deref() else {
        return;
    };
    let ws_del = ws_id.to_string();
    let name_del = name.to_string();
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
        move |s| {
            s.dispatch(Action::Settings(SettingsAction::DeleteMcpServer {
                workspace_id: ws_del.clone(),
                name: name_del.clone(),
            }));
            s.settings_ui.mcp_delete_confirm_name = None;
        },
        |s| {
            s.settings_ui.mcp_delete_confirm_name = None;
        },
        k,
        overlays,
    );
}
