//! Primary content wrapper: startup progress, recovery cards, connection banner,
//! creation readiness notices, and the inline file preview split pane.

use cowork_protocol::{CreationReadinessCheck, CreationRepairAction};
use rune::{Color, El, ScrollSpec, col, el, icon, row, spacer, text};
use rune_kit::{
    Badge, BadgeVariant, Button, ButtonVariant, ControlSize, IconButton, IconButtonVariant, Kit,
    Spinner,
};

use crate::actions::{Action, NativeAction, NavAction, SettingsAction, ShellAction};
use crate::router::{SettingsPageId, ViewId};
use crate::state::{AppState, FilePreviewState, ServerLifecycleState, WorkspaceRuntime};
use crate::theme::{ThemeTokens, composite_srgb_over, warning_ink};
use crate::ws::WsConnectionState;

use super::{helpers, icons};

const TOP_BANNER_MAX_WIDTH: f32 = 860.0;

struct BannerSurface {
    fill: Color,
    border: Color,
    badge_bg: Color,
}

/// Computes cohesive tinted banner fill, subtle semantic border, and icon badge surface
/// without harsh 100%-opacity outlines or overlapping left accent stripes.
fn banner_surface(tone: Color, t: &ThemeTokens) -> BannerSurface {
    let tint_alpha = if t.dark { 0.09 } else { 0.055 };
    let border_alpha = if t.dark { 0.28 } else { 0.30 };
    let badge_alpha = if t.dark { 0.16 } else { 0.13 };
    BannerSurface {
        fill: composite_srgb_over(tone.alpha(tint_alpha), t.elevated_bg),
        border: tone.alpha(border_alpha),
        badge_bg: tone.alpha(badge_alpha),
    }
}

fn banner_icon_badge(child: El, badge_bg: Color, size: f32, radius: f32) -> El {
    el().size(size, size)
        .shrink()
        .radius(radius)
        .continuous_corners()
        .fill(badge_bg)
        .center()
        .child(child)
        .a11y_hidden()
}

/// Wrap the active center subview (`chat::view`, `tasks`, etc.) with workspace
/// readiness banners, runtime startup/recovery gates, and optional inline file preview.
pub fn build_primary_content(
    s: &AppState,
    k: &Kit,
    t: &ThemeTokens,
    main_subview: El,
    suppress_file_preview: bool,
) -> El {
    let active_ws = s
        .active_workspace_id
        .as_deref()
        .and_then(|id| s.workspaces.iter().find(|ws| ws.id == id));

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
    let on_creation_screen = match s.route().view {
        ViewId::Chat => s.route().active_thread_id.is_none(),
        ViewId::Task => s.active_task.is_none(),
        ViewId::Settings => false,
    };
    if on_creation_screen
        && let Some(readiness_banner) =
            build_creation_readiness_notice(s, active_ws.map(|w| w.id.clone()), k, t)
    {
        top_banners.push(readiness_banner);
    }
    if let Some(updater_banner) = build_updater_banner(s, k, t) {
        top_banners.push(updater_banner);
    }

    let body = if !suppress_file_preview && let Some(preview) = s.active_file_preview.as_ref() {
        if s.shell_ui.preview_maximized {
            el().key("primary-preview-maximized")
                .w_full()
                .h_full()
                .grow(1.0)
                .shrink()
                .min_h(0.0)
                .transition(rune::Transition::none())
                .child(build_inline_file_preview(s, preview, k, t))
        } else {
            row()
                .key("primary-split-with-preview")
                .w_full()
                .h_full()
                .grow(1.0)
                .shrink()
                .min_h(0.0)
                .transition(rune::Transition::none())
                .child(
                    el().key("primary-subview-pane")
                        .grow(1.0)
                        .shrink()
                        .min_w(240.0)
                        .min_h(0.0)
                        .h_full()
                        .transition(rune::Transition::none())
                        .child(main_subview),
                )
                .child(el().w(1.0).h_full().fill(t.border_muted))
                .child(build_inline_file_preview(s, preview, k, t))
        }
    } else {
        el().key("primary-subview-only")
            .w_full()
            .h_full()
            .grow(1.0)
            .shrink()
            .min_h(0.0)
            .transition(rune::Transition::none())
            .child(main_subview)
    };

    // Keep `"primary-content-stack"` mounted continuously whether banners are present or not so
    // toggling top banners never changes the parent key and remounts the active subview.
    let mut stack = col()
        .key("primary-content-stack")
        .w_full()
        .h_full()
        .grow(1.0)
        .shrink()
        .min_h(0.0)
        .transition(rune::Transition::none());

    if !top_banners.is_empty() {
        stack = stack.child(
            col()
                .key("primary-top-banners")
                .w_full()
                .items_center()
                .px(20.0)
                .pt(12.0)
                .pb(4.0)
                .transition(rune::Transition::none())
                .child(
                    col()
                        .w_full()
                        .max_w(TOP_BANNER_MAX_WIDTH)
                        .gap(8.0)
                        .children(top_banners),
                ),
        );
    }

    stack.child(body)
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
        .w_full()
        .px(12.0)
        .py(10.0)
        .radius(8.0)
        .continuous_corners()
        .fill(t.panel_bg)
        .border(1.0, t.border_muted)
        .gap(10.0)
        .center_y()
        .child(Spinner::new().size(14.0).color(t.accent).build(k))
        .child(
            text(status_label)
                .font(k.ty.small_medium)
                .color(t.text_base),
        );

    let ws_id_owned = ws_id.to_owned();
    let card = col()
        .role("group")
        .label(format!("Starting {ws_name}"))
        .w_full()
        .max_w(480.0)
        .shrink()
        .padding(20.0)
        .gap(16.0)
        .radius(14.0)
        .continuous_corners()
        .fill(t.popover_bg)
        .border(1.0, t.border)
        .child(
            row()
                .w_full()
                .gap(12.0)
                .items_start()
                .child(banner_icon_badge(
                    icon(&icons::SPARKLES, 16.0).color(t.accent),
                    t.accent_soft,
                    36.0,
                    9.0,
                ))
                .child(
                    col()
                        .grow(1.0)
                        .shrink()
                        .min_w(0.0)
                        .gap(4.0)
                        .child(
                            text(format!("Starting {ws_name}"))
                                .font(t.title)
                                .color(t.text_base),
                        )
                        .child(text(detail).font(t.body).color(t.text_muted).wrap()),
                ),
        )
        .child(progress_row)
        .child(
            row()
                .w_full()
                .gap(8.0)
                .center_y()
                .child(spacer())
                .child(
                    Button::new("Runtime settings")
                        .variant(ButtonVariant::Outline)
                        .control_size(ControlSize::Small)
                        .on_press_tx(|s: &mut AppState, tx| {
                            s.dispatch_tx(
                                Action::Navigate(NavAction::OpenSettingsIntent {
                                    page: SettingsPageId::Diagnostics,
                                    tab: None,
                                    section: None,
                                    new_provider: false,
                                }),
                                tx,
                            );
                        })
                        .build(k),
                )
                .child(
                    Button::new("Restart server")
                        .variant(ButtonVariant::Outline)
                        .control_size(ControlSize::Small)
                        .icon(&icons::REFRESH)
                        .on_press_tx(move |s: &mut AppState, _| {
                            s.dispatch(Action::Native(NativeAction::RestartWorkspaceServer(
                                ws_id_owned.clone(),
                            )));
                        })
                        .build(k),
                ),
        );

    el().key("workspace-runtime-progress")
        .w_full()
        .h_full()
        .center()
        .padding(24.0)
        .child(k.elevate(card, &k.elevation.raised))
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

    let surface = banner_surface(t.danger, t);
    let ws_id_restart = ws_id.to_owned();
    let card = col()
        .role("group")
        .label(format!("{ws_name} server unavailable"))
        .w_full()
        .max_w(500.0)
        .shrink()
        .padding(20.0)
        .gap(16.0)
        .radius(14.0)
        .continuous_corners()
        .fill(t.popover_bg)
        .border(1.0, surface.border)
        .child(
            row()
                .w_full()
                .gap(12.0)
                .items_start()
                .child(banner_icon_badge(
                    icon(&icons::ALERT_TRIANGLE, 16.0).color(t.danger),
                    surface.badge_bg,
                    36.0,
                    9.0,
                ))
                .child(
                    col()
                        .grow(1.0)
                        .shrink()
                        .min_w(0.0)
                        .gap(4.0)
                        .child(
                            text(format!("{ws_name} server unavailable"))
                                .font(t.title)
                                .color(t.text_base),
                        )
                        .child(text(err_msg).font(t.body).color(t.text_muted).wrap()),
                ),
        )
        .child(
            row()
                .w_full()
                .gap(8.0)
                .center_y()
                .child(
                    Button::new("Open Settings")
                        .variant(ButtonVariant::Ghost)
                        .control_size(ControlSize::Small)
                        .icon(&icons::SETTINGS)
                        .on_press_tx(|s: &mut AppState, tx| {
                            s.dispatch_tx(Action::Navigate(NavAction::OpenSettings(None)), tx);
                        })
                        .build(k),
                )
                .child(spacer())
                .child(
                    Button::new("Export diagnostics")
                        .variant(ButtonVariant::Outline)
                        .control_size(ControlSize::Small)
                        .on_press_tx(|s: &mut AppState, _| {
                            s.dispatch(Action::Settings(SettingsAction::ExportDiagnosticsBundle));
                        })
                        .build(k),
                )
                .child(
                    Button::new("Retry server start")
                        .variant(ButtonVariant::Contrast)
                        .control_size(ControlSize::Small)
                        .icon(&icons::REFRESH)
                        .on_press_tx(move |s: &mut AppState, _| {
                            s.dispatch(Action::Native(NativeAction::RestartWorkspaceServer(
                                ws_id_restart.clone(),
                            )));
                        })
                        .build(k),
                ),
        );

    el().key("startup-recovery-view")
        .w_full()
        .h_full()
        .center()
        .padding(24.0)
        .child(k.elevate(card, &k.elevation.raised))
}

fn build_connection_recovery_banner(
    s: &AppState,
    ws_id: &str,
    k: &Kit,
    t: &ThemeTokens,
) -> Option<El> {
    let socket = s.workspace_socket_by_id.get(ws_id)?;
    let (label, tone_color, icon_ink, is_busy, detail): (String, Color, Color, bool, String) =
        match socket {
            WsConnectionState::Connected => return None,
            WsConnectionState::Connecting | WsConnectionState::Handshaking => (
                "Connecting to workspace server...".to_owned(),
                t.info,
                t.info,
                true,
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
                warning_ink(t),
                true,
                if reason.is_empty() {
                    "Live turns will resume automatically once connected.".to_owned()
                } else {
                    reason.clone()
                },
            ),
            WsConnectionState::Exhausted { reason } | WsConnectionState::Failed { reason } => (
                "Workspace connection lost".to_owned(),
                t.danger,
                t.danger,
                false,
                if reason.is_empty() {
                    "Restart the workspace server to restore live updates.".to_owned()
                } else {
                    reason.clone()
                },
            ),
            WsConnectionState::Disconnected => (
                "Disconnected from workspace server".to_owned(),
                t.danger,
                t.danger,
                false,
                "Socket closed. Restart to restore live updates.".to_owned(),
            ),
        };

    let surface = banner_surface(tone_color, t);
    let leading = if is_busy {
        Spinner::new().size(13.0).color(icon_ink).build(k)
    } else {
        icon(&icons::ALERT_TRIANGLE, 14.0).color(icon_ink)
    };
    let ws_id_owned = ws_id.to_owned();
    Some(
        row()
            .key("connection-recovery-banner")
            .w_full()
            .px(14.0)
            .py(10.0)
            .radius(10.0)
            .continuous_corners()
            .fill(surface.fill)
            .border(1.0, surface.border)
            .gap(12.0)
            .center_y()
            .child(banner_icon_badge(leading, surface.badge_bg, 28.0, 7.0))
            .child(
                col()
                    .grow(1.0)
                    .shrink()
                    .min_w(0.0)
                    .gap(2.0)
                    .child(text(label).font(k.ty.small_medium).color(t.text_base))
                    .child(text(detail).font(k.ty.small).color(t.text_muted).wrap()),
            )
            .child(
                Button::new("Restart server")
                    .variant(ButtonVariant::Outline)
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

    let first_issue = failing
        .iter()
        .copied()
        .find(|c| c.status == "blocked")
        .or_else(|| failing.first().copied());
    let title = readiness_issue_title(first_issue);
    let detail = first_issue
        .map(|c| c.message.as_str())
        .unwrap_or("Connect a provider or finish runtime checks before starting new chats.");
    let is_pending = first_issue.is_some_and(|c| c.status == "pending");
    let tone = if is_pending { t.accent } else { t.warning };
    let icon_ink = if is_pending { t.accent } else { warning_ink(t) };
    let surface = banner_surface(tone, t);

    let leading = if is_pending {
        Spinner::new().size(13.0).color(icon_ink).build(k)
    } else {
        icon(&icons::ALERT_TRIANGLE, 14.0).color(icon_ink)
    };

    let mut action_buttons: Vec<El> = Vec::new();
    action_buttons.push(
        Button::new("Provider settings")
            .variant(ButtonVariant::Outline)
            .control_size(ControlSize::Small)
            .on_press_tx(|s: &mut AppState, tx| {
                s.dispatch_tx(
                    Action::Navigate(NavAction::OpenSettingsIntent {
                        page: SettingsPageId::Models,
                        tab: None,
                        section: None,
                        new_provider: false,
                    }),
                    tx,
                );
            })
            .build(k),
    );
    if let Some(repair) = first_issue.and_then(|c| c.repair_action.as_ref()) {
        let label = repair_action_label(repair);
        let repair_cloned = repair.clone();
        let ws_cloned = ws_id;
        action_buttons.push(
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

    let copy = col()
        .grow(1.0)
        .shrink()
        .min_w(0.0)
        .gap(2.0)
        .child(text(title).font(k.ty.small_medium).color(t.text_base))
        .child(text(detail).font(k.ty.small).color(t.text_muted).wrap());

    let actions_row = row()
        .shrink()
        .items_center()
        .gap(8.0)
        .children(action_buttons);

    let narrow = s.shell_ui.viewport_width > 0.0 && s.shell_ui.viewport_width < 640.0;
    let notice = if narrow {
        col()
            .key("creation-readiness-notice")
            .role("group")
            .label(title)
            .w_full()
            .px(14.0)
            .py(11.0)
            .gap(10.0)
            .radius(10.0)
            .continuous_corners()
            .fill(surface.fill)
            .border(1.0, surface.border)
            .child(
                row()
                    .w_full()
                    .gap(12.0)
                    .items_start()
                    .child(banner_icon_badge(leading, surface.badge_bg, 28.0, 7.0))
                    .child(copy),
            )
            .child(el().w_full().pl(40.0).child(actions_row))
    } else {
        row()
            .key("creation-readiness-notice")
            .role("group")
            .label(title)
            .w_full()
            .px(14.0)
            .py(11.0)
            .gap(12.0)
            .radius(10.0)
            .continuous_corners()
            .fill(surface.fill)
            .border(1.0, surface.border)
            .center_y()
            .child(banner_icon_badge(leading, surface.badge_bg, 28.0, 7.0))
            .child(copy)
            .child(actions_row)
    };

    Some(notice)
}

fn readiness_issue_title(issue: Option<&CreationReadinessCheck>) -> &'static str {
    let Some(check) = issue else {
        return "Workspace setup required";
    };
    if check.status == "pending" {
        return "Finishing setup";
    }
    match check.id.as_str() {
        "project_access" => "Workspace folder unavailable",
        "provider_connected" => "Provider unavailable",
        "credentials" => "Provider credentials required",
        "model_available" => "Model unavailable",
        "runtime_ready" => "Runtime setup incomplete",
        _ => "Not ready to start",
    }
}

fn repair_action_label(action: &CreationRepairAction) -> &'static str {
    match action {
        CreationRepairAction::ConnectProvider { .. } => "Connect provider",
        CreationRepairAction::OpenProviderSettings { .. } => "Open provider settings",
        CreationRepairAction::StartLmStudio { .. } => "Start LM Studio",
        CreationRepairAction::InstallCodexRuntime => "Install Codex runtime",
    }
}

fn build_updater_banner(s: &AppState, k: &Kit, t: &ThemeTokens) -> Option<El> {
    let version = s
        .updater
        .available_version
        .as_deref()
        .or(s.updater.version.as_deref());
    match s.updater.status.as_str() {
        "downloading" => {
            let mut parts: Vec<String> = Vec::new();
            match (s.updater.downloaded_bytes, s.updater.total_bytes) {
                (Some(dl), Some(tot)) if tot > 0 => {
                    let pct = ((dl as f64 / tot as f64) * 100.0).clamp(0.0, 100.0);
                    parts.push(format!(
                        "{} / {} ({pct:.0}%)",
                        helpers::format_bytes(dl),
                        helpers::format_bytes(tot)
                    ));
                }
                (Some(dl), _) => parts.push(helpers::format_bytes(dl)),
                (_, _) => {
                    if let Some(pct) = s.updater.download_progress {
                        let norm = if pct <= 1.0 { pct * 100.0 } else { pct };
                        parts.push(format!("{:.0}%", norm.clamp(0.0, 100.0)));
                    }
                }
            }
            if let Some(bps) = s.updater.bytes_per_second
                && bps > 0
            {
                parts.push(format!("{}/s", helpers::format_bytes(bps)));
            }

            let ratio = match (s.updater.downloaded_bytes, s.updater.total_bytes) {
                (Some(dl), Some(tot)) if tot > 0 => (dl as f32 / tot as f32).clamp(0.0, 1.0),
                _ => s
                    .updater
                    .download_progress
                    .map(|p| if p <= 1.0 { p } else { p / 100.0 })
                    .unwrap_or(0.0)
                    .clamp(0.0, 1.0),
            };
            let title = match version {
                Some(v) => format!("Downloading Cowork {v}..."),
                None => "Downloading update...".to_owned(),
            };
            let detail = if parts.is_empty() {
                "Fetching release archive in the background.".to_owned()
            } else {
                parts.join(" · ")
            };

            let surface = banner_surface(t.accent, t);
            Some(
                row()
                    .key("updater-download-banner")
                    .w_full()
                    .px(14.0)
                    .py(10.0)
                    .radius(10.0)
                    .continuous_corners()
                    .fill(surface.fill)
                    .border(1.0, surface.border)
                    .gap(12.0)
                    .center_y()
                    .child(banner_icon_badge(
                        Spinner::new().size(13.0).color(t.accent).build(k),
                        surface.badge_bg,
                        28.0,
                        7.0,
                    ))
                    .child(
                        col()
                            .grow(1.0)
                            .shrink()
                            .min_w(0.0)
                            .gap(2.0)
                            .child(text(title).font(k.ty.small_medium).color(t.text_base))
                            .child(text(detail).font(k.ty.small).color(t.text_muted)),
                    )
                    .child(
                        el().w(140.0)
                            .h(6.0)
                            .radius(999.0)
                            .fill(t.border)
                            .child(el().w(140.0 * ratio).h(6.0).radius(999.0).fill(t.accent)),
                    ),
            )
        }
        "downloaded" | "ready" => {
            let title = match version {
                Some(v) => format!("Update {v} ready to install"),
                None => "Update ready to install".to_owned(),
            };
            let surface = banner_surface(t.success, t);
            Some(
                row()
                    .key("updater-ready-banner")
                    .w_full()
                    .px(14.0)
                    .py(10.0)
                    .radius(10.0)
                    .continuous_corners()
                    .fill(surface.fill)
                    .border(1.0, surface.border)
                    .gap(12.0)
                    .center_y()
                    .child(banner_icon_badge(
                        icon(&icons::CHECK_CIRCLE, 14.0).color(t.success),
                        surface.badge_bg,
                        28.0,
                        7.0,
                    ))
                    .child(
                        col()
                            .grow(1.0)
                            .shrink()
                            .min_w(0.0)
                            .gap(2.0)
                            .child(text(title).font(k.ty.small_medium).color(t.text_base))
                            .child(
                                text("Restart Cowork to finish applying the update.")
                                    .font(k.ty.small)
                                    .color(t.text_muted),
                            ),
                    )
                    .child(
                        Button::new("Restart & install")
                            .variant(ButtonVariant::Contrast)
                            .control_size(ControlSize::Small)
                            .on_press_tx(|s: &mut AppState, _| {
                                s.dispatch(Action::Settings(SettingsAction::QuitAndInstallUpdate));
                            })
                            .build(k),
                    ),
            )
        }
        _ => None,
    }
}

fn build_inline_file_preview(
    s: &AppState,
    preview: &FilePreviewState,
    k: &Kit,
    t: &ThemeTokens,
) -> El {
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
    let maximized = s.shell_ui.preview_maximized;

    let mut title_group = row()
        .grow(1.0)
        .shrink()
        .min_w(0.0)
        .gap(8.0)
        .center_y()
        .child(icon(&icons::FILE_TEXT, 14.0).color(t.text_muted))
        .child(
            text(title)
                .font(t.label)
                .color(t.text_base)
                .truncate()
                .shrink()
                .min_w(0.0),
        );

    if preview.is_markdown {
        title_group = title_group.child(Badge::new("MD").variant(BadgeVariant::Subtle).build(k));
    }

    let header = row()
        .key("file-preview-header")
        .w_full()
        .h(40.0)
        .px(12.0)
        .gap(8.0)
        .center_y()
        .fill(t.panel_bg)
        .child(title_group)
        .child(
            Button::new(if maximized { "Restore" } else { "Maximize" })
                .variant(ButtonVariant::Ghost)
                .control_size(ControlSize::Small)
                .on_press_tx(|s: &mut AppState, _| {
                    s.shell_ui.preview_maximized = !s.shell_ui.preview_maximized;
                })
                .build(k),
        )
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
                    s.shell_ui.preview_maximized = false;
                    s.dispatch(Action::Shell(ShellAction::CloseFilePreview));
                })
                .build(k),
        );

    let body = if let Some(err) = preview.error.as_deref() {
        el().w_full()
            .h_full()
            .padding(16.0)
            .child(text(err).font(t.body).color(t.danger).wrap())
    } else if let Some(spreadsheet) = preview.spreadsheet.as_ref() {
        crate::views::preview::render_spreadsheet_preview(s, preview, spreadsheet, k, t)
    } else if let Some(presentation) = preview.presentation.as_deref() {
        crate::views::preview::render_presentation_preview(s, preview, presentation, k, t)
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
                    .color(warning_ink(t)),
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
        .grow(1.65)
        .shrink()
        .min_w(260.0)
        .min_h(0.0)
        .h_full()
        .fill(t.panel_bg)
        .child(header)
        .child(el().w_full().h(1.0).fill(t.border_muted))
        .child(el().grow(1.0).shrink().min_h(0.0).w_full().child(body))
}

#[cfg(test)]
mod tests {
    use super::*;
    use cowork_protocol::CreationPreflightResult;

    #[test]
    fn readiness_issue_title_maps_raw_check_ids_to_human_headings() {
        let blocked_credentials = CreationReadinessCheck {
            id: "credentials".into(),
            status: "blocked".into(),
            message: "Connect OpenAI before starting this chat.".into(),
            repair_action: None,
        };
        assert_eq!(
            readiness_issue_title(Some(&blocked_credentials)),
            "Provider credentials required"
        );

        let pending_runtime = CreationReadinessCheck {
            id: "runtime_ready".into(),
            status: "pending".into(),
            message: "Cowork is finishing setup in the background.".into(),
            repair_action: None,
        };
        assert_eq!(
            readiness_issue_title(Some(&pending_runtime)),
            "Finishing setup"
        );

        let unknown = CreationReadinessCheck {
            id: "custom_check_key".into(),
            status: "blocked".into(),
            message: "Action needed.".into(),
            repair_action: None,
        };
        assert_eq!(readiness_issue_title(Some(&unknown)), "Not ready to start");

        let s = AppState {
            workspace_creation_preflight: Some(CreationPreflightResult {
                ready: false,
                checks: vec![pending_runtime, blocked_credentials],
            }),
            ..Default::default()
        };
        fn notice_view(state: &AppState, cx: &mut rune::Cx<AppState>) -> El {
            let dark = state.effective_dark(cx.system_dark());
            let (kit, tok) = crate::theme::build_kit_with_accent(
                dark,
                state.desktop_settings.reduced_transparency,
                state.desktop_settings.high_contrast,
                state.desktop_settings.accent_palette,
            );
            let notice = build_creation_readiness_notice(state, Some("ws-1".into()), &kit, &tok)
                .expect("notice should render when preflight is not ready");
            el().w_full().h_full().child(notice)
        }
        let mut rt = rune::Runtime::new(s, notice_view, (600.0, 200.0), rune::Env::new(true, 1.0));
        rt.frame(0.0);
        let tree = rt.a11y_json();
        assert!(tree.contains("Provider credentials required"));
        assert!(!tree.contains("\"credentials\""));
    }

    #[test]
    fn creation_readiness_notice_hidden_on_active_thread_and_task() {
        use cowork_protocol::CreationPreflightResult;

        fn blocked_state() -> AppState {
            let check = CreationReadinessCheck {
                id: "credentials".into(),
                status: "blocked".into(),
                message: "Connect Google before starting this chat.".into(),
                repair_action: Some(CreationRepairAction::ConnectProvider {
                    provider: "google".into(),
                }),
            };
            AppState {
                workspace_creation_preflight: Some(CreationPreflightResult {
                    ready: false,
                    checks: vec![check],
                }),
                ..Default::default()
            }
        }

        fn primary_view(state: &AppState, cx: &mut rune::Cx<AppState>) -> El {
            let dark = state.effective_dark(cx.system_dark());
            let (kit, tok) = crate::theme::build_kit_with_accent(
                dark,
                state.desktop_settings.reduced_transparency,
                state.desktop_settings.high_contrast,
                state.desktop_settings.accent_palette,
            );
            build_primary_content(state, &kit, &tok, el().w_full().h_full(), false)
        }

        // On new chat landing, the notice renders.
        let mut landing_rt = rune::Runtime::new(
            blocked_state(),
            primary_view,
            (800.0, 600.0),
            rune::Env::new(true, 1.0),
        );
        landing_rt.frame(0.0);
        assert!(
            landing_rt
                .a11y_json()
                .contains("Provider credentials required")
        );

        // On an existing thread, the creation notice is suppressed.
        let mut on_thread = blocked_state();
        on_thread.dispatch(Action::Navigate(NavAction::OpenThread("th-1".into())));
        let mut thread_rt = rune::Runtime::new(
            on_thread,
            primary_view,
            (800.0, 600.0),
            rune::Env::new(true, 1.0),
        );
        thread_rt.frame(0.0);
        assert!(
            !thread_rt
                .a11y_json()
                .contains("Provider credentials required")
        );
    }

    #[test]
    fn creation_readiness_notice_aligns_copy_cleanly_and_stays_compact() {
        let check = CreationReadinessCheck {
            id: "credentials".into(),
            status: "blocked".into(),
            message: "Connect Google before starting this chat.".into(),
            repair_action: Some(CreationRepairAction::ConnectProvider {
                provider: "google".into(),
            }),
        };

        let mut wide_state = AppState {
            workspace_creation_preflight: Some(CreationPreflightResult {
                ready: false,
                checks: vec![check.clone()],
            }),
            ..Default::default()
        };
        wide_state.shell_ui.viewport_width = 1024.0;

        fn primary_view(state: &AppState, cx: &mut rune::Cx<AppState>) -> El {
            let dark = state.effective_dark(cx.system_dark());
            let (kit, tok) = crate::theme::build_kit_with_accent(
                dark,
                state.desktop_settings.reduced_transparency,
                state.desktop_settings.high_contrast,
                state.desktop_settings.accent_palette,
            );
            build_primary_content(state, &kit, &tok, el().w_full().h_full(), false)
        }

        let mut rt = rune::Runtime::new(
            wide_state,
            primary_view,
            (1024.0, 200.0),
            rune::Env::new(false, 1.0),
        );
        rt.frame(0.0);
        let els = rt.elements();
        let notice = els
            .iter()
            .find(|e| e.key.as_deref() == Some("creation-readiness-notice"))
            .expect("notice element present");
        let title_el = els
            .iter()
            .find(|e| e.text.as_deref() == Some("Provider credentials required"))
            .expect("title text present");
        let detail_el = els
            .iter()
            .find(|e| e.text.as_deref() == Some("Connect Google before starting this chat."))
            .expect("detail text present");

        assert!(
            (title_el.rect[0] - detail_el.rect[0]).abs() < 0.5,
            "title x ({}) and detail x ({}) must align without zig-zag indent",
            title_el.rect[0],
            detail_el.rect[0]
        );
        assert!(
            notice.rect[2] <= TOP_BANNER_MAX_WIDTH + 0.5,
            "desktop notice width ({}) should stay bounded to {TOP_BANNER_MAX_WIDTH}",
            notice.rect[2]
        );
        assert!(
            notice.rect[3] <= 72.0,
            "desktop horizontal notice height ({}) should remain compact",
            notice.rect[3]
        );

        // Light-mode warning ink must maintain readable contrast against the tinted banner surface.
        let light_tok = crate::theme::resolve_tokens(false, false, false);
        let light_surface = banner_surface(light_tok.warning, &light_tok);
        let ratio = crate::theme::contrast_ratio(warning_ink(&light_tok), light_surface.fill);
        assert!(
            ratio >= 3.5,
            "light-mode warning ink contrast ({ratio:.2}) must be >= 3.5 against banner fill"
        );
    }
}
