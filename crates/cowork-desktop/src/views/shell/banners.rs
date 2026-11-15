//! Primary content wrapper: startup progress, recovery cards, connection banner,
//! creation readiness notices, and the inline file preview split pane.

use cowork_protocol::{CreationReadinessCheck, CreationRepairAction};
use rune::{El, ScrollSpec, col, el, icon, row, spacer, text};
use rune_kit::{
    Badge, BadgeVariant, Button, ButtonVariant, Card, ControlSize, IconButton, IconButtonVariant,
    Kit, Spinner,
};

use crate::actions::{Action, NativeAction, NavAction, SettingsAction, ShellAction};
use crate::router::{SettingsPageId, ViewId};
use crate::state::{AppState, FilePreviewState, ServerLifecycleState, WorkspaceRuntime};
use crate::theme::ThemeTokens;
use crate::ws::WsConnectionState;

use super::icons;

/// Wrap the active center subview (`chat::view`, `tasks`, etc.) with workspace
/// readiness banners, runtime startup/recovery gates, and optional inline file preview.
pub fn build_primary_content(s: &AppState, k: &Kit, t: &ThemeTokens, main_subview: El) -> El {
    let active_ws = s
        .active_workspace_id
        .as_deref()
        .and_then(|id| s.workspaces.iter().find(|ws| ws.id == id));

    if active_ws.is_none() && s.route().view == ViewId::Chat {
        return empty_workspace_gate(k, t);
    }

    if let Some(ws) = active_ws
        && let Some(rt) = s.workspace_runtime_by_id.get(&ws.id)
    {
        match &rt.server_state {
            ServerLifecycleState::Starting { stage, message } => {
                return workspace_runtime_progress_view(
                    ws.name.as_str(),
                    &ws.id,
                    stage.as_str(),
                    message.as_str(),
                    k,
                    t,
                );
            }
            ServerLifecycleState::Failed { message } => {
                return startup_recovery_view(
                    ws.name.as_str(),
                    &ws.id,
                    Some(message.as_str()),
                    rt,
                    k,
                    t,
                );
            }
            ServerLifecycleState::Stopped => {
                return startup_recovery_view(ws.name.as_str(), &ws.id, None, rt, k, t);
            }
            ServerLifecycleState::Running { .. } => {}
        }
    }

    let mut top_banners: Vec<El> = Vec::new();
    if let Some(ws) = active_ws
        && let Some(conn_banner) = build_connection_recovery_banner(s, &ws.id, k, t)
    {
        top_banners.push(conn_banner);
    }
    if let Some(readiness_banner) =
        build_creation_readiness_notice(s, active_ws.map(|w| w.id.clone()), k, t)
    {
        top_banners.push(readiness_banner);
    }

    let body = if let Some(preview) = s.active_file_preview.as_ref() {
        row()
            .key("primary-split-with-preview")
            .w_full()
            .h_full()
            .grow(1.0)
            .shrink()
            .min_h(0.0)
            .child(
                el().key("primary-subview-pane")
                    .grow(1.6)
                    .shrink()
                    .min_h(0.0)
                    .h_full()
                    .child(main_subview),
            )
            .child(el().w(1.0).h_full().fill(t.border_muted))
            .child(build_inline_file_preview(preview, k, t))
    } else {
        el().key("primary-subview-only")
            .w_full()
            .h_full()
            .grow(1.0)
            .shrink()
            .min_h(0.0)
            .child(main_subview)
    };

    if top_banners.is_empty() {
        return body;
    }

    col()
        .key("primary-content-stack")
        .w_full()
        .h_full()
        .grow(1.0)
        .shrink()
        .min_h(0.0)
        .child(
            col()
                .key("primary-top-banners")
                .w_full()
                .px(16.0)
                .py(10.0)
                .gap(8.0)
                .children(top_banners),
        )
        .child(body)
}

fn empty_workspace_gate(k: &Kit, t: &ThemeTokens) -> El {
    let card = Card::new()
        .accent(t.accent)
        .title("Choose a project folder to begin", Some(&icons::FOLDER_PLUS))
        .description(
            "Open a local directory so Antigravity can start a workspace server, track threads, and run tasks.",
        )
        .action(
            Button::new("Add project folder")
                .variant(ButtonVariant::Contrast)
                .icon(&icons::FOLDER_PLUS)
                .on_press_tx(|s: &mut AppState, _| {
                    s.dispatch(Action::Native(NativeAction::PickWorkspaceFolder));
                })
                .build(k),
        )
        .action(
            Button::new("Settings")
                .variant(ButtonVariant::Ghost)
                .icon(&icons::SETTINGS)
                .on_press_tx(|s: &mut AppState, _| {
                    s.dispatch(Action::Navigate(NavAction::OpenSettings(None)));
                })
                .build(k),
        )
        .build(k);

    el().key("empty-workspace-gate")
        .w_full()
        .h_full()
        .center()
        .padding(24.0)
        .child(
            el().w(480.0)
                .shrink()
                .fill(t.card_bg)
                .radius(12.0)
                .border(1.0, t.border)
                .padding(8.0)
                .child(card),
        )
}

fn workspace_runtime_progress_view(
    ws_name: &str,
    ws_id: &str,
    stage: &str,
    message: &str,
    k: &Kit,
    t: &ThemeTokens,
) -> El {
    let status_label = if stage.trim().is_empty() {
        "Starting workspace server".to_owned()
    } else {
        format!("Workspace setup: {stage}")
    };

    let detail = if message.trim().is_empty() {
        format!("Preparing {ws_name}...")
    } else {
        message.to_owned()
    };

    let progress_row = row()
        .gap(8.0)
        .center_y()
        .child(Spinner::new().size(15.0).color(t.accent).build(k))
        .child(text(status_label).font(t.body).color(t.text_base));

    let ws_id_owned = ws_id.to_owned();
    let card = Card::new()
        .accent(t.accent)
        .title(format!("Starting {ws_name}"), Some(&icons::SPARKLES))
        .description(detail)
        .child(col().gap(10.0).pt(4.0).child(progress_row))
        .action(
            Button::new("Restart server")
                .variant(ButtonVariant::Ghost)
                .control_size(ControlSize::Small)
                .icon(&icons::REFRESH)
                .on_press_tx(move |s: &mut AppState, _| {
                    s.dispatch(Action::Native(NativeAction::RestartWorkspaceServer(
                        ws_id_owned.clone(),
                    )));
                })
                .build(k),
        )
        .action(
            Button::new("Runtime settings")
                .variant(ButtonVariant::Ghost)
                .control_size(ControlSize::Small)
                .on_press_tx(|s: &mut AppState, _| {
                    s.dispatch(Action::Navigate(NavAction::OpenSettingsIntent {
                        page: SettingsPageId::Diagnostics,
                        tab: None,
                        section: None,
                        new_provider: false,
                    }));
                })
                .build(k),
        )
        .build(k);

    el().key("workspace-runtime-progress")
        .w_full()
        .h_full()
        .center()
        .padding(24.0)
        .child(
            el().w(500.0)
                .shrink()
                .fill(t.card_bg)
                .radius(12.0)
                .border(1.0, t.border)
                .padding(8.0)
                .child(card),
        )
}

fn startup_recovery_view(
    ws_name: &str,
    ws_id: &str,
    state_err: Option<&str>,
    rt: &WorkspaceRuntime,
    k: &Kit,
    t: &ThemeTokens,
) -> El {
    let err_msg = state_err
        .map(str::to_owned)
        .or_else(|| rt.last_error.clone())
        .unwrap_or_else(|| "Workspace server is not responding.".to_owned());

    let ws_id_restart = ws_id.to_owned();
    let card = Card::new()
        .accent(t.danger)
        .title(
            format!("{ws_name} server unavailable"),
            Some(&icons::ALERT_TRIANGLE),
        )
        .description(err_msg)
        .action(
            Button::new("Retry server start")
                .variant(ButtonVariant::Contrast)
                .icon(&icons::REFRESH)
                .on_press_tx(move |s: &mut AppState, _| {
                    s.dispatch(Action::Native(NativeAction::RestartWorkspaceServer(
                        ws_id_restart.clone(),
                    )));
                })
                .build(k),
        )
        .action(
            Button::new("Export diagnostics")
                .variant(ButtonVariant::Ghost)
                .on_press_tx(|s: &mut AppState, _| {
                    s.dispatch(Action::Settings(SettingsAction::ExportDiagnosticsBundle));
                })
                .build(k),
        )
        .action(
            Button::new("Open Settings")
                .variant(ButtonVariant::Ghost)
                .icon(&icons::SETTINGS)
                .on_press_tx(|s: &mut AppState, _| {
                    s.dispatch(Action::Navigate(NavAction::OpenSettings(None)));
                })
                .build(k),
        )
        .build(k);

    el().key("startup-recovery-view")
        .w_full()
        .h_full()
        .center()
        .padding(24.0)
        .child(
            el().w(520.0)
                .shrink()
                .fill(t.card_bg)
                .radius(12.0)
                .border(1.0, t.border_strong)
                .padding(8.0)
                .child(card),
        )
}

fn build_connection_recovery_banner(
    s: &AppState,
    ws_id: &str,
    k: &Kit,
    t: &ThemeTokens,
) -> Option<El> {
    let socket = s.workspace_socket_by_id.get(ws_id)?;
    let (label, tone_color, detail): (String, rune::Color, String) = match socket {
        WsConnectionState::Connected => return None,
        WsConnectionState::Connecting | WsConnectionState::Handshaking => (
            "Connecting to workspace server...".to_owned(),
            t.info,
            "Establishing WebSocket JSON-RPC session.".to_owned(),
        ),
        WsConnectionState::Reconnecting {
            attempt,
            max_attempts,
            reason,
            ..
        } => (
            format!("Reconnecting to workspace (attempt {attempt}/{max_attempts})..."),
            t.warning,
            if reason.is_empty() {
                "Live turns will resume automatically once connected.".to_owned()
            } else {
                reason.clone()
            },
        ),
        WsConnectionState::Exhausted { reason } | WsConnectionState::Failed { reason } => (
            "Workspace connection lost".to_owned(),
            t.danger,
            if reason.is_empty() {
                "Restart the workspace server to restore live updates.".to_owned()
            } else {
                reason.clone()
            },
        ),
        WsConnectionState::Disconnected => (
            "Disconnected from workspace server".to_owned(),
            t.danger,
            "Socket closed. Restart to restore live updates.".to_owned(),
        ),
    };

    let ws_id_owned = ws_id.to_owned();
    Some(
        row()
            .key("connection-recovery-banner")
            .w_full()
            .px(12.0)
            .py(8.0)
            .radius(8.0)
            .fill(t.elevated_bg)
            .border(1.0, tone_color)
            .gap(10.0)
            .center_y()
            .child(icon(&icons::ALERT_TRIANGLE, 15.0).color(tone_color))
            .child(
                col()
                    .grow(1.0)
                    .shrink()
                    .gap(2.0)
                    .child(text(label).font(t.label).color(t.text_base))
                    .child(text(detail).font(t.caption).color(t.text_muted)),
            )
            .child(
                Button::new("Restart server")
                    .variant(ButtonVariant::Ghost)
                    .control_size(ControlSize::Small)
                    .icon(&icons::REFRESH)
                    .on_press_tx(move |s: &mut AppState, _| {
                        s.dispatch(Action::Native(NativeAction::RestartWorkspaceServer(
                            ws_id_owned.clone(),
                        )));
                    })
                    .build(k),
            ),
    )
}

fn build_creation_readiness_notice(
    s: &AppState,
    ws_id: Option<String>,
    k: &Kit,
    t: &ThemeTokens,
) -> Option<El> {
    let preflight = s.workspace_creation_preflight.as_ref()?;
    let failing: Vec<&CreationReadinessCheck> = preflight
        .checks
        .iter()
        .filter(|c| c.status != "ready" && c.status != "ok")
        .collect();
    if preflight.ready && failing.is_empty() {
        return None;
    }

    let first_issue = failing.first().copied();
    let title = first_issue
        .map(|c| c.id.as_str())
        .unwrap_or("Workspace creation setup required");
    let detail = first_issue
        .map(|c| c.message.as_str())
        .unwrap_or("Connect a provider or finish runtime checks before starting new chats.");

    let mut card = Card::new()
        .accent(t.warning)
        .title(title, Some(&icons::INFO))
        .description(detail);

    if let Some(repair) = first_issue.and_then(|c| c.repair_action.as_ref()) {
        let label = repair_action_label(repair);
        let repair_cloned = repair.clone();
        let ws_cloned = ws_id;
        card = card.action(
            Button::new(label)
                .variant(ButtonVariant::Contrast)
                .control_size(ControlSize::Small)
                .on_press_tx(move |s: &mut AppState, _| {
                    s.dispatch(Action::Shell(ShellAction::RepairCreationReadiness {
                        action: repair_cloned.clone(),
                        workspace_id: ws_cloned.clone(),
                    }));
                })
                .build(k),
        );
    }

    card = card.action(
        Button::new("Provider settings")
            .variant(ButtonVariant::Ghost)
            .control_size(ControlSize::Small)
            .on_press_tx(|s: &mut AppState, _| {
                s.dispatch(Action::Navigate(NavAction::OpenSettingsIntent {
                    page: SettingsPageId::Models,
                    tab: None,
                    section: None,
                    new_provider: false,
                }));
            })
            .build(k),
    );

    Some(
        el().key("creation-readiness-notice")
            .w_full()
            .fill(t.card_bg)
            .radius(8.0)
            .border(1.0, t.border)
            .child(card.build(k)),
    )
}

fn repair_action_label(action: &CreationRepairAction) -> &'static str {
    match action {
        CreationRepairAction::ConnectProvider { .. } => "Connect provider",
        CreationRepairAction::OpenProviderSettings { .. } => "Open provider settings",
        CreationRepairAction::StartLmStudio { .. } => "Start LM Studio",
        CreationRepairAction::InstallCodexRuntime => "Install Codex runtime",
    }
}

fn build_inline_file_preview(preview: &FilePreviewState, k: &Kit, t: &ThemeTokens) -> El {
    let title = if preview.title.is_empty() {
        preview
            .path
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(preview.path.as_str())
    } else {
        preview.title.as_str()
    };
    let path_for_reveal = preview.path.clone();
    let path_for_open = preview.path.clone();

    let mut header = row()
        .key("file-preview-header")
        .w_full()
        .h(40.0)
        .px(12.0)
        .gap(8.0)
        .center_y()
        .fill(t.panel_bg)
        .child(icon(&icons::FILE_TEXT, 14.0).color(t.text_muted))
        .child(
            text(title)
                .font(t.label)
                .color(t.text_base)
                .truncate()
                .grow(1.0),
        );

    if preview.is_markdown {
        header = header.child(Badge::new("MD").variant(BadgeVariant::Subtle).build(k));
    }

    header = header
        .child(spacer())
        .child(
            IconButton::new(&icons::EXTERNAL_LINK)
                .variant(IconButtonVariant::GhostMuted)
                .control_size(ControlSize::Small)
                .help("Open in default app")
                .on_press_tx(move |s: &mut AppState, _| {
                    s.dispatch(Action::Native(NativeAction::OpenInDefaultApp(
                        path_for_open.clone(),
                    )));
                })
                .build(k),
        )
        .child(
            IconButton::new(&icons::FOLDER)
                .variant(IconButtonVariant::GhostMuted)
                .control_size(ControlSize::Small)
                .help("Reveal in file manager")
                .on_press_tx(move |s: &mut AppState, _| {
                    s.dispatch(Action::Native(NativeAction::RevealInOs(
                        path_for_reveal.clone(),
                    )));
                })
                .build(k),
        )
        .child(
            Button::new("Close")
                .variant(ButtonVariant::Ghost)
                .control_size(ControlSize::Small)
                .on_press_tx(|s: &mut AppState, _| {
                    s.dispatch(Action::Shell(ShellAction::CloseFilePreview));
                })
                .build(k),
        );

    let body = if let Some(err) = preview.error.as_deref() {
        el().w_full()
            .h_full()
            .padding(16.0)
            .child(text(err).font(t.body).color(t.danger).wrap())
    } else if preview.is_binary {
        el().w_full().h_full().center().padding(16.0).child(
            text("Binary file preview is not supported inline. Use Open in default app.")
                .font(t.body)
                .color(t.text_muted)
                .wrap(),
        )
    } else if let Some(content) = preview.content.as_deref() {
        let mut scroll_col = col()
            .key("file-preview-content-scroll")
            .w_full()
            .h_full()
            .min_h(0.0)
            .scroll(ScrollSpec {
                stick_bottom: false,
            })
            .padding(12.0)
            .gap(8.0)
            .child(
                text(preview.path.as_str())
                    .font(t.caption)
                    .color(t.text_faint)
                    .truncate(),
            );
        if preview.truncated {
            scroll_col = scroll_col.child(
                text("Preview truncated for large file.")
                    .font(t.caption)
                    .color(t.warning),
            );
        }
        scroll_col.child(
            text(content)
                .font(t.code)
                .color(t.text_base)
                .wrap()
                .w_full(),
        )
    } else {
        el().w_full()
            .h_full()
            .center()
            .child(Spinner::new().size(18.0).color(t.accent).build(k))
    };

    col()
        .key("inline-file-preview")
        .grow(1.0)
        .shrink()
        .min_w(260.0)
        .min_h(0.0)
        .h_full()
        .fill(t.panel_bg)
        .child(header)
        .child(el().w_full().h(1.0).fill(t.border_muted))
        .child(el().grow(1.0).shrink().min_h(0.0).w_full().child(body))
}
