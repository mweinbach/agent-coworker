//! Guided 5-step Desktop Onboarding modal (`apps/desktop/src/ui/onboarding/DesktopOnboarding.tsx`).
//!
//! Steps:
//! 1. `welcome`     — Overview of workspace, provider, and defaults setup
//! 2. `workspace`   — Choose or add a project folder with live runtime status
//! 3. `provider`    — Inline API key, OAuth, and LM Studio setup
//! 4. `defaults`    — Default provider, default model, MCP servers, and backups toggles
//! 5. `firstThread` — Starter prompts or blank thread launch

use rune::{El, Icon, ScrollSpec, TextEdit, TextStyle, col, el, icon, row, spacer, text};
use rune_kit::{
    Button, ButtonVariant, ControlSize, Dialog, IconButton, IconButtonVariant, Kit, Select,
    SelectAppearance, TextInput,
};
use serde_json::{Value, json};

use crate::actions::{Action, ChatAction, NativeAction, NavAction, SettingsAction, ShellAction};
use crate::router::ViewId;
use crate::state::{
    AppState, ProviderStatusSummary, ProviderSummary, ServerLifecycleState, ThreadBusyPolicy,
    WindowMode, WorkspaceRecord,
};
use crate::theme::ThemeTokens;
use crate::views::settings::icons as settings_icons;
use crate::views::settings::primitives::{
    EntityIconSize, StatusTone, entity_icon, mini_switch, status_pill,
};
use crate::views::settings::providers::{
    fallback_providers, is_provider_connected, provider_display_title, provider_oauth_spec,
    provider_supports_api_key, provider_supports_oauth,
};
use crate::views::settings::providers_utils::sort_and_filter_providers;

use super::icons;

const ONBOARDING_STEP_COUNT: usize = 5;

const STARTER_PROMPTS: &[(&str, &str)] = &[
    (
        "Summarize this repo",
        "Give me a high-level summary of this repository — what it does, the key technologies, and how it's structured.",
    ),
    (
        "Find setup risks",
        "Look through the repo for any setup issues, missing configs, or common gotchas a new contributor might hit.",
    ),
    (
        "Plan first tasks",
        "Based on the current state of this repo, suggest 3-5 actionable first tasks I could work on.",
    ),
];

/// True when the guided onboarding modal should be displayed over the main workspace shell.
pub(crate) fn is_onboarding_visible(s: &AppState) -> bool {
    !s.scene_mode
        && s.window_mode == WindowMode::Main
        && s.route().view != ViewId::Settings
        && !s.onboarding.completed
        && !s.onboarding.dismissed
}

/// Resolves non-archived project workspaces (falling back to any non-archived workspace if only
/// a quick-chat workspace exists).
fn onboarding_workspaces(s: &AppState) -> Vec<&WorkspaceRecord> {
    let projects: Vec<&WorkspaceRecord> = s
        .workspaces
        .iter()
        .filter(|w| !w.archived && !w.one_off_chat)
        .collect();
    if !projects.is_empty() {
        projects
    } else {
        s.workspaces.iter().filter(|w| !w.archived).collect()
    }
}

fn active_onboarding_workspace<'a>(
    s: &'a AppState,
    candidates: &[&'a WorkspaceRecord],
) -> Option<&'a WorkspaceRecord> {
    if let Some(active_id) = s.active_workspace_id.as_deref()
        && let Some(found) = candidates.iter().copied().find(|w| w.id == active_id)
    {
        return Some(found);
    }
    if let Some(mgmt_id) = s.resolve_management_workspace_id()
        && let Some(found) = candidates.iter().copied().find(|w| w.id == mgmt_id)
    {
        return Some(found);
    }
    candidates.first().copied()
}

fn workspace_display_name(ws: &WorkspaceRecord) -> String {
    if ws.one_off_chat {
        "Chats".to_owned()
    } else if ws.name.trim().is_empty() {
        ws.path.clone()
    } else {
        ws.name.clone()
    }
}

fn catalog_or_fallback(s: &AppState) -> Vec<ProviderSummary> {
    let source = if s.provider_catalog.is_empty() {
        fallback_providers()
    } else {
        s.provider_catalog.clone()
    };
    source.into_iter().filter(|p| p.id != "bedrock").collect()
}

fn provider_statuses<'a>(
    s: &'a AppState,
    active_ws: Option<&'a WorkspaceRecord>,
) -> &'a [ProviderStatusSummary] {
    let ws_id = active_ws
        .map(|w| w.id.as_str())
        .or_else(|| s.resolve_management_workspace_id());
    ws_id
        .and_then(|id| s.workspace_runtime_by_id.get(id))
        .map(|rt| rt.provider_statuses.as_slice())
        .unwrap_or(&[])
}

fn connected_provider_count(
    s: &AppState,
    providers: &[ProviderSummary],
    active_ws: Option<&WorkspaceRecord>,
) -> usize {
    let statuses = provider_statuses(s, active_ws);
    providers
        .iter()
        .filter(|p| {
            let status = statuses.iter().find(|st| st.provider == p.id);
            is_provider_connected(p, status, active_ws)
        })
        .count()
}

/// Requests dismissal of onboarding, prompting for confirmation first when workspace or provider
/// setup is still incomplete (matching Electron's `requestDismiss`).
pub(crate) fn request_dismiss_onboarding(s: &mut AppState) {
    let candidates = onboarding_workspaces(s);
    let active_ws = active_onboarding_workspace(s, &candidates);
    let providers = catalog_or_fallback(s);
    let has_ws = active_ws.is_some();
    let has_provider = connected_provider_count(s, &providers, active_ws) > 0;
    s.shell_ui.onboarding_open_select = None;
    if !has_ws || !has_provider {
        s.shell_ui.onboarding_confirm_discard = true;
    } else {
        s.dispatch(Action::Shell(ShellAction::SkipOnboarding));
    }
}

/// Syncs workspace default provider/model to the first connected provider when the current
/// workspace default is unset or disconnected.
fn sync_connected_workspace_defaults(s: &mut AppState) {
    let candidates = onboarding_workspaces(s);
    let Some(ws) = active_onboarding_workspace(s, &candidates) else {
        return;
    };
    let ws_id = ws.id.clone();
    let current_prov = ws.default_provider.clone().unwrap_or_default();
    let providers = catalog_or_fallback(s);
    let statuses = provider_statuses(s, Some(ws));
    let sorted = sort_and_filter_providers(&providers, statuses, "");
    let connected: Vec<&ProviderSummary> = sorted
        .into_iter()
        .filter(|p| {
            let st = statuses.iter().find(|st| st.provider == p.id);
            is_provider_connected(p, st, Some(ws))
        })
        .collect();
    if connected.is_empty() {
        return;
    }
    let already_connected = connected.iter().any(|p| p.id == current_prov);
    if already_connected {
        return;
    }
    let chosen = connected[0];
    let pid = chosen.id.clone();
    let next_model = s
        .default_model_by_provider
        .get(&pid)
        .cloned()
        .filter(|m| !m.trim().is_empty())
        .or_else(|| {
            chosen
                .models
                .iter()
                .find(|m| m.enabled)
                .or_else(|| chosen.models.first())
                .map(|m| m.id.clone())
        })
        .unwrap_or_default();

    let mut patch = serde_json::Map::new();
    patch.insert("defaultProvider".to_owned(), Value::String(pid.clone()));
    if !next_model.is_empty() {
        patch.insert("defaultModel".to_owned(), Value::String(next_model.clone()));
        patch.insert(
            "defaultPreferredChildModel".to_owned(),
            Value::String(next_model.clone()),
        );
        patch.insert(
            "defaultPreferredChildModelRef".to_owned(),
            Value::String(format!("{pid}:{next_model}")),
        );
    }
    s.dispatch(Action::Settings(SettingsAction::UpdateWorkspaceDefaults {
        workspace_id: ws_id,
        defaults: Value::Object(patch),
    }));
}

/// Mounts the onboarding modal, any open onboarding `Select` popups, and the skip-confirmation
/// dialog onto `layer` in proper paint/hit order.
pub(crate) fn push_onboarding_overlays(
    s: &AppState,
    k: &Kit,
    t: &ThemeTokens,
    layer: &mut Vec<El>,
) {
    if !is_onboarding_visible(s) {
        return;
    }

    if s.shell_ui.onboarding_confirm_discard {
        push_skip_confirm_dialog(k, t, layer);
        return;
    }

    let step_idx = s.shell_ui.onboarding_step.min(ONBOARDING_STEP_COUNT - 1);
    let mut select_overlays: Vec<El> = Vec::new();

    let top_bar = build_top_bar(s, step_idx, k, t);
    let (step_body, footer) = match step_idx {
        0 => build_welcome_step(k, t),
        1 => build_workspace_step(s, k, t, &mut select_overlays),
        2 => build_provider_step(s, k, t),
        3 => build_defaults_step(s, k, t, &mut select_overlays),
        _ => build_first_thread_step(s, k, t),
    };

    let card = col()
        .key("desktop-onboarding-card")
        .role("dialog")
        .label("Welcome to Cowork")
        .w_full()
        .max_w(520.0)
        .padding(24.0)
        .gap(20.0)
        .radius(14.0)
        .continuous_corners()
        .fill(t.popover_bg)
        .token_motion(k.motion.overlay)
        .child(top_bar)
        .child(
            el().key(format!("onboarding-step-body-{step_idx}"))
                .w_full()
                .transition(rune::Transition::none())
                .child(step_body),
        )
        .child(
            el().key(format!("onboarding-step-footer-{step_idx}"))
                .w_full()
                .transition(rune::Transition::none())
                .child(footer),
        );

    let elevated_card = k.elevate(card, &k.elevation.overlay);

    let blur_sigma = if s.desktop_settings.reduced_transparency {
        0.0
    } else {
        5.0
    };

    layer.push(
        col()
            .key("desktop-onboarding-backdrop")
            .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
            .backdrop_blur(blur_sigma)
            .fill(t.scrim)
            .center()
            .padding(24.0)
            .modal(false, |_: &mut AppState| {})
            .child(elevated_card),
    );

    layer.extend(select_overlays);
}

fn build_top_bar(s: &AppState, step_idx: usize, k: &Kit, t: &ThemeTokens) -> El {
    let step_labels = [
        "Welcome",
        "Workspace",
        "Provider",
        "Defaults",
        "First thread",
    ];

    let dots = row()
        .key("onboarding-step-indicators")
        .gap(6.0)
        .center_y()
        .children((0..ONBOARDING_STEP_COUNT).map(|i| {
            let active = i == step_idx;
            let step_key = format!("step-{}", i + 1);
            let reachable = i <= step_idx || s.onboarding.completed_steps.contains(&step_key);
            let pill_w = if active { 24.0 } else { 6.0 };
            let pill_fill = if active {
                t.accent
            } else if i < step_idx || s.onboarding.completed_steps.contains(&step_key) {
                t.accent.alpha(0.45)
            } else {
                t.text_muted.alpha(0.24)
            };

            let dot = el()
                .key(format!("ob-step-{i}"))
                .size(pill_w, 6.0)
                .radius(999.0)
                .fill(pill_fill)
                .motion(k.motion.control)
                .label(format!("Step {}: {}", i + 1, step_labels[i]));

            if reachable && !active {
                dot.on_press_tx(move |s: &mut AppState, _| {
                    s.shell_ui.onboarding_step = i;
                    s.shell_ui.onboarding_open_select = None;
                    s.shell_ui.onboarding_confirm_discard = false;
                })
            } else {
                dot
            }
        }));

    let close_btn = IconButton::new(k.glyph.close)
        .variant(IconButtonVariant::GhostMuted)
        .control_size(ControlSize::Regular)
        .label("Close onboarding")
        .on_press(|s: &mut AppState| {
            request_dismiss_onboarding(s);
        })
        .build(k)
        .key("onboarding-close-btn");

    row()
        .key("onboarding-top-bar")
        .w_full()
        .center_y()
        .child(dots)
        .child(spacer())
        .child(
            row()
                .gap(8.0)
                .center_y()
                .child(
                    text(format!("{} / {ONBOARDING_STEP_COUNT}", step_idx + 1))
                        .font(t.caption)
                        .color(t.text_muted),
                )
                .child(close_btn),
        )
}

fn step_header(
    title: impl Into<String>,
    subtitle: impl Into<String>,
    trailing: Option<El>,
    t: &ThemeTokens,
) -> El {
    let heading_font = TextStyle::new(21.0, 600.0).lh(27.0).tracking(-0.28);
    let mut title_row = row().w_full().gap(12.0).center_y().child(
        text(title)
            .font(heading_font)
            .color(t.text_base)
            .grow(1.0)
            .shrink()
            .wrap(),
    );
    if let Some(badge) = trailing {
        title_row = title_row.child(el().shrink().child(badge));
    }

    col()
        .w_full()
        .gap(6.0)
        .child(title_row)
        .child(text(subtitle).font(t.body).color(t.text_muted).wrap())
}

fn tinted_icon_badge(glyph: &'static Icon, size: f32, icon_px: f32, t: &ThemeTokens) -> El {
    el().size(size, size)
        .shrink()
        .radius(8.0)
        .continuous_corners()
        .fill(t.accent_soft)
        .center()
        .child(icon(glyph, icon_px).color(t.accent))
        .a11y_hidden()
}

fn build_welcome_step(k: &Kit, t: &ThemeTokens) -> (El, El) {
    let items: [(&'static Icon, &str, &str); 3] = [
        (
            &icons::FOLDER_PLUS,
            "Choose a workspace",
            "Pick a folder on disk for Cowork to read and write files in.",
        ),
        (
            &icons::SPARKLES,
            "Connect a provider",
            "Add an API key, sign in with OAuth, or connect LM Studio.",
        ),
        (
            &icons::SETTINGS,
            "Review defaults",
            "Confirm your default model and workspace safety options.",
        ),
    ];

    let mut feature_card = col()
        .w_full()
        .radius(10.0)
        .continuous_corners()
        .clip_rounded(10.0)
        .fill(t.card_bg)
        .border(1.0, t.border_muted);

    for (idx, (glyph, title, desc)) in items.into_iter().enumerate() {
        let mut item_row = row()
            .w_full()
            .px(14.0)
            .py(12.0)
            .gap(12.0)
            .center_y()
            .child(tinted_icon_badge(glyph, 32.0, 15.0, t))
            .child(
                col()
                    .grow(1.0)
                    .min_w(0.0)
                    .gap(2.0)
                    .child(text(title).font(k.ty.ui_medium).color(t.text_base))
                    .child(text(desc).font(t.caption).color(t.text_muted).wrap()),
            );
        if idx > 0 {
            item_row = item_row.border_sides([1.0, 0.0, 0.0, 0.0], t.border_muted);
        }
        feature_card = feature_card.child(item_row);
    }

    let safety_note = row()
        .w_full()
        .gap(8.0)
        .center_y()
        .child(icon(&icons::CHECK_CIRCLE, 14.0).color(t.accent))
        .child(
            text("Command approvals stay enabled by default — Cowork always asks before running commands.")
                .font(t.caption)
                .color(t.text_muted)
                .grow(1.0)
                .shrink()
                .wrap(),
        );

    let body = col()
        .w_full()
        .gap(16.0)
        .child(step_header(
            "Welcome to Cowork",
            "A local-first AI assistant that runs on your machine.",
            None,
            t,
        ))
        .child(feature_card)
        .child(safety_note);

    let footer = row()
        .w_full()
        .pt(2.0)
        .gap(8.0)
        .center_y()
        .child(
            Button::new("Not now")
                .variant(ButtonVariant::GhostMuted)
                .control_size(ControlSize::Large)
                .on_press(|s: &mut AppState| {
                    request_dismiss_onboarding(s);
                })
                .build(k)
                .key("onboarding-not-now"),
        )
        .child(spacer())
        .child(
            Button::new("Get started")
                .variant(ButtonVariant::Contrast)
                .control_size(ControlSize::Large)
                .on_press(|s: &mut AppState| {
                    s.shell_ui.onboarding_step = 1;
                    s.shell_ui.onboarding_confirm_discard = false;
                    s.dispatch(Action::Shell(ShellAction::CompleteOnboardingStep(
                        "step-1".to_owned(),
                    )));
                })
                .build(k)
                .key("onboarding-get-started"),
        );

    (body, footer)
}

fn build_workspace_step(
    s: &AppState,
    k: &Kit,
    t: &ThemeTokens,
    select_overlays: &mut Vec<El>,
) -> (El, El) {
    let candidates = onboarding_workspaces(s);
    let active_ws = active_onboarding_workspace(s, &candidates);
    let has_multiple = candidates.len() > 1;
    let picker_enabled = s
        .feature_flags
        .get("workspacePicker")
        .copied()
        .unwrap_or(true);
    let lifecycle_enabled = s
        .feature_flags
        .get("workspaceLifecycle")
        .copied()
        .unwrap_or(true);

    let heading = if has_multiple {
        "Choose a workspace"
    } else {
        "Add a workspace"
    };
    let subtitle = if !picker_enabled {
        "Connected to the workspace folder Cowork was launched with."
    } else if has_multiple {
        "Select an existing project folder or add another folder from your Mac."
    } else {
        "Choose a folder on your machine. This is where Cowork will read and write files."
    };

    let mut body = col()
        .w_full()
        .gap(16.0)
        .child(step_header(heading, subtitle, None, t));

    if picker_enabled && has_multiple {
        let labels: Vec<String> = candidates
            .iter()
            .map(|w| workspace_display_name(w))
            .collect();
        let label_refs: Vec<&str> = labels.iter().map(String::as_str).collect();
        let pairs: Vec<(String, String)> = candidates
            .iter()
            .map(|w| (workspace_display_name(w), w.id.clone()))
            .collect();
        let current_label = active_ws.map(workspace_display_name);
        let is_open =
            s.shell_ui.onboarding_open_select.as_deref() == Some("onboarding-workspace-select");

        let select_el = Select::new("onboarding-workspace-select", &label_refs)
            .label("Active workspace")
            .appearance(SelectAppearance::Field)
            .width(260.0)
            .current(current_label.as_deref())
            .open(is_open)
            .on_toggle(|s: &mut AppState| {
                let open = s.shell_ui.onboarding_open_select.as_deref()
                    == Some("onboarding-workspace-select");
                s.shell_ui.onboarding_open_select = if open {
                    None
                } else {
                    Some("onboarding-workspace-select".to_owned())
                };
            })
            .on_close(|s: &mut AppState| {
                if s.shell_ui.onboarding_open_select.as_deref()
                    == Some("onboarding-workspace-select")
                {
                    s.shell_ui.onboarding_open_select = None;
                }
            })
            .on_choose(move |s: &mut AppState, chosen, _tx| {
                s.shell_ui.onboarding_open_select = None;
                if let Some((_, ws_id)) = pairs.iter().find(|(lbl, _)| lbl == chosen) {
                    s.dispatch(Action::Navigate(NavAction::SelectWorkspace(ws_id.clone())));
                }
            })
            .build(k, select_overlays);

        body = body.child(
            row()
                .w_full()
                .justify_between()
                .center_y()
                .gap(12.0)
                .child(
                    text("Active workspace")
                        .font(k.ty.ui_medium)
                        .color(t.text_base),
                )
                .child(select_el),
        );
    }

    if let Some(ws) = active_ws {
        let rt = s.workspace_runtime_by_id.get(&ws.id);
        let (pill_label, pill_tone, detail_msg, is_error) = match rt.map(|r| &r.server_state) {
            Some(ServerLifecycleState::Running { .. }) => {
                ("Ready", StatusTone::Success, None, false)
            }
            Some(ServerLifecycleState::Starting { message, .. }) => (
                "Starting…",
                StatusTone::Neutral,
                (!message.trim().is_empty()).then(|| message.clone()),
                false,
            ),
            Some(ServerLifecycleState::Failed { message }) => (
                "Error",
                StatusTone::Danger,
                (!message.trim().is_empty()).then(|| message.clone()),
                true,
            ),
            _ => ("Ready", StatusTone::Success, None, false),
        };

        let mut ws_card = col()
            .key("onboarding-selected-workspace-card")
            .w_full()
            .px(14.0)
            .py(12.0)
            .gap(8.0)
            .radius(10.0)
            .continuous_corners()
            .fill(t.card_bg)
            .border(1.0, t.border_muted)
            .child(
                row()
                    .w_full()
                    .gap(12.0)
                    .center_y()
                    .child(tinted_icon_badge(&icons::FOLDER, 34.0, 16.0, t))
                    .child(
                        col()
                            .grow(1.0)
                            .min_w(0.0)
                            .gap(2.0)
                            .child(
                                text(workspace_display_name(ws))
                                    .font(k.ty.ui_medium)
                                    .color(t.text_base)
                                    .truncate(),
                            )
                            .child(
                                text(ws.path.clone())
                                    .font(t.code)
                                    .color(t.text_muted)
                                    .truncate(),
                            ),
                    )
                    .child(status_pill(pill_label, pill_tone, k, t)),
            );

        if let Some(msg) = detail_msg {
            ws_card = ws_card.child(
                text(msg)
                    .font(t.caption)
                    .color(if is_error { t.danger } else { t.text_muted })
                    .wrap(),
            );
        }

        body = body.child(ws_card);

        if lifecycle_enabled {
            body = body.child(
                row().w_full().child(
                    Button::new("Choose different folder")
                        .variant(ButtonVariant::Outline)
                        .control_size(ControlSize::Regular)
                        .icon(&icons::FOLDER_PLUS)
                        .on_press(|s: &mut AppState| {
                            s.dispatch(Action::Native(NativeAction::PickWorkspaceFolder));
                        })
                        .build(k)
                        .key("onboarding-add-folder"),
                ),
            );
        }
    } else {
        let mut empty_card = row()
            .key("onboarding-empty-workspace-card")
            .w_full()
            .px(16.0)
            .py(16.0)
            .gap(12.0)
            .center_y()
            .radius(10.0)
            .continuous_corners()
            .fill(t.card_bg)
            .border(1.0, t.border_muted)
            .child(tinted_icon_badge(&icons::FOLDER_PLUS, 36.0, 16.0, t))
            .child(
                col()
                    .grow(1.0)
                    .min_w(0.0)
                    .gap(2.0)
                    .child(
                        text("No folder selected yet")
                            .font(k.ty.ui_medium)
                            .color(t.text_base),
                    )
                    .child(
                        text("Cowork launches an isolated workspace runtime for each folder.")
                            .font(t.caption)
                            .color(t.text_muted)
                            .wrap(),
                    ),
            );

        if lifecycle_enabled {
            empty_card = empty_card.child(
                Button::new("Choose folder")
                    .variant(ButtonVariant::Contrast)
                    .control_size(ControlSize::Large)
                    .icon(&icons::FOLDER_PLUS)
                    .on_press(|s: &mut AppState| {
                        s.dispatch(Action::Native(NativeAction::PickWorkspaceFolder));
                    })
                    .build(k)
                    .key("onboarding-add-folder"),
            );
        }

        body = body.child(empty_card);
    }

    let ws_id_for_next = active_ws.map(|w| w.id.clone());
    let can_continue = ws_id_for_next.is_some();

    let footer = row()
        .w_full()
        .pt(2.0)
        .gap(8.0)
        .center_y()
        .child(
            Button::new("Back")
                .variant(ButtonVariant::GhostMuted)
                .control_size(ControlSize::Large)
                .on_press(|s: &mut AppState| {
                    s.shell_ui.onboarding_step = 0;
                    s.shell_ui.onboarding_open_select = None;
                    s.shell_ui.onboarding_confirm_discard = false;
                })
                .build(k)
                .key("onboarding-back"),
        )
        .child(spacer())
        .child(
            Button::new("Continue")
                .variant(ButtonVariant::Contrast)
                .control_size(ControlSize::Large)
                .disabled(!can_continue)
                .on_press(move |s: &mut AppState| {
                    s.shell_ui.onboarding_step = 2;
                    s.shell_ui.onboarding_open_select = None;
                    s.shell_ui.onboarding_confirm_discard = false;
                    s.dispatch(Action::Shell(ShellAction::CompleteOnboardingStep(
                        "step-2".to_owned(),
                    )));
                    if let Some(ws_id) = &ws_id_for_next {
                        s.dispatch(Action::Settings(SettingsAction::RefreshProviderCatalog {
                            workspace_id: ws_id.clone(),
                        }));
                    }
                })
                .build(k)
                .key("onboarding-continue"),
        );

    (body, footer)
}

fn extract_challenge<'a>(s: &'a AppState, provider_id: &str) -> Option<&'a Value> {
    let val = s.last_auth_challenge.as_ref()?;
    let target = val.get("event").unwrap_or(val);
    let prov = target.get("provider").and_then(Value::as_str)?;
    (prov == provider_id).then_some(target)
}

fn safe_auth_link(raw: &str) -> Option<String> {
    let parsed = url::Url::parse(raw.trim()).ok()?;
    if matches!(parsed.scheme(), "https" | "http") && parsed.host_str().is_some() {
        Some(parsed.to_string())
    } else {
        None
    }
}

fn build_provider_step(s: &AppState, k: &Kit, t: &ThemeTokens) -> (El, El) {
    let candidates = onboarding_workspaces(s);
    let active_ws = active_onboarding_workspace(s, &candidates);
    let active_ws_id = active_ws.map(|w| w.id.as_str());
    let providers = catalog_or_fallback(s);
    let statuses = provider_statuses(s, active_ws);
    let sorted = sort_and_filter_providers(&providers, statuses, "");
    let connected_count = connected_provider_count(s, &providers, active_ws);

    let count_badge = el().key("onboarding-provider-badge").child(status_pill(
        if connected_count > 0 {
            format!("{connected_count} connected")
        } else {
            "None connected".to_owned()
        },
        if connected_count > 0 {
            StatusTone::Success
        } else {
            StatusTone::Neutral
        },
        k,
        t,
    ));

    let mut list_col = col().w_full().gap(8.0).pr(2.0).pb(2.0);
    for prov in sorted {
        let status = statuses.iter().find(|st| st.provider == prov.id);
        let connected = is_provider_connected(prov, status, active_ws);
        let expanded = s.shell_ui.onboarding_expanded_provider.as_deref() == Some(prov.id.as_str());
        let display_name = provider_display_title(prov);

        let (badge_label, badge_tone) = if prov.id == "lmstudio" {
            let lm_enabled = active_ws
                .and_then(|w| w.defaults.get("lmStudioEnabled"))
                .and_then(Value::as_bool)
                .unwrap_or(prov.configured);
            if !lm_enabled {
                ("Disabled", StatusTone::Neutral)
            } else if connected {
                ("Connected", StatusTone::Success)
            } else {
                ("Offline", StatusTone::Warning)
            }
        } else if connected {
            ("Connected", StatusTone::Success)
        } else {
            ("Not connected", StatusTone::Neutral)
        };

        let pid_toggle = prov.id.clone();
        let trigger = k
            .interactive(
                row()
                    .key(format!("ob-prov-trigger-{}", prov.id))
                    .w_full()
                    .px(14.0)
                    .py(11.0)
                    .gap(10.0)
                    .center_y()
                    .child(entity_icon(s, None, display_name, EntityIconSize::Sm, k, t))
                    .child(
                        text(display_name)
                            .font(k.ty.ui_medium)
                            .color(t.text_base)
                            .grow(1.0)
                            .shrink()
                            .truncate(),
                    )
                    .child(status_pill(badge_label, badge_tone, k, t))
                    .child(
                        icon(
                            if expanded {
                                k.glyph.chevron_up
                            } else {
                                k.glyph.chevron_down
                            },
                            14.0,
                        )
                        .color(t.text_muted),
                    ),
            )
            .on_press_tx(move |s: &mut AppState, _| {
                let already =
                    s.shell_ui.onboarding_expanded_provider.as_deref() == Some(pid_toggle.as_str());
                if already {
                    s.shell_ui.onboarding_expanded_provider = None;
                } else {
                    s.shell_ui.onboarding_expanded_provider = Some(pid_toggle.clone());
                    s.shell_ui.onboarding_api_key_edit = TextEdit::new("");
                    s.shell_ui.onboarding_api_key_revealed = false;
                    s.shell_ui.onboarding_oauth_code_edit = TextEdit::new("");
                }
            });

        let mut prov_card = col()
            .key(format!("ob-prov-card-{}", prov.id))
            .w_full()
            .radius(10.0)
            .continuous_corners()
            .clip_rounded(10.0)
            .fill(t.card_bg)
            .border(
                1.0,
                if expanded {
                    t.accent.alpha(0.45)
                } else {
                    t.border_muted
                },
            )
            .child(trigger);

        if expanded {
            prov_card = prov_card.child(build_expanded_provider_controls(
                s,
                prov,
                display_name,
                status.and_then(|st| st.saved_api_key_mask.as_deref()),
                active_ws,
                active_ws_id,
                k,
                t,
            ));
        }

        list_col = list_col.child(prov_card);
    }

    let scroll_list = k.scroll_bar(
        col()
            .key("onboarding-provider-scroll")
            .w_full()
            .max_h(312.0)
            .scroll(ScrollSpec {
                stick_bottom: false,
            })
            .child(list_col),
    );

    let body = col()
        .w_full()
        .gap(16.0)
        .child(step_header(
            "Connect a provider",
            "Add an API key or sign in to at least one model provider.",
            Some(count_badge),
            t,
        ))
        .child(scroll_list);

    let can_continue = connected_count > 0;
    let footer = row()
        .w_full()
        .pt(2.0)
        .gap(8.0)
        .center_y()
        .child(
            Button::new("Back")
                .variant(ButtonVariant::GhostMuted)
                .control_size(ControlSize::Large)
                .on_press(|s: &mut AppState| {
                    s.shell_ui.onboarding_step = 1;
                    s.shell_ui.onboarding_open_select = None;
                    s.shell_ui.onboarding_confirm_discard = false;
                })
                .build(k)
                .key("onboarding-back"),
        )
        .child(spacer())
        .child(
            Button::new("Continue")
                .variant(ButtonVariant::Contrast)
                .control_size(ControlSize::Large)
                .disabled(!can_continue)
                .on_press(|s: &mut AppState| {
                    sync_connected_workspace_defaults(s);
                    s.shell_ui.onboarding_step = 3;
                    s.shell_ui.onboarding_open_select = None;
                    s.shell_ui.onboarding_confirm_discard = false;
                    s.dispatch(Action::Shell(ShellAction::CompleteOnboardingStep(
                        "step-3".to_owned(),
                    )));
                })
                .build(k)
                .key("onboarding-continue"),
        );

    (body, footer)
}

#[allow(clippy::too_many_arguments)]
fn build_expanded_provider_controls(
    s: &AppState,
    prov: &ProviderSummary,
    display_name: &str,
    saved_mask: Option<&str>,
    active_ws: Option<&WorkspaceRecord>,
    active_ws_id: Option<&str>,
    k: &Kit,
    t: &ThemeTokens,
) -> El {
    let mut detail = col()
        .w_full()
        .px(14.0)
        .pb(14.0)
        .pt(12.0)
        .gap(12.0)
        .border_sides([1.0, 0.0, 0.0, 0.0], t.border_muted);

    let Some(ws_id) = active_ws_id else {
        return detail.child(
            text("Select a project folder on the previous step first so Cowork can save credentials.")
                .font(t.caption)
                .color(t.text_muted)
                .wrap(),
        );
    };

    if prov.id == "lmstudio" {
        let lm_enabled = active_ws
            .and_then(|w| w.defaults.get("lmStudioEnabled"))
            .and_then(Value::as_bool)
            .unwrap_or(prov.configured);
        let ws_toggle = ws_id.to_owned();
        let ws_check = ws_id.to_owned();
        let ws_start = ws_id.to_owned();

        return detail
            .child(
                text("LM Studio runs models locally on your Mac. Connect it to expose your local models in Cowork.")
                    .font(t.caption)
                    .color(t.text_muted)
                    .wrap(),
            )
            .child(
                row()
                    .w_full()
                    .gap(8.0)
                    .flex_wrap()
                    .center_y()
                    .child(
                        Button::new(if lm_enabled { "Disable" } else { "Connect" })
                            .variant(if lm_enabled {
                                ButtonVariant::Outline
                            } else {
                                ButtonVariant::Contrast
                            })
                            .control_size(ControlSize::Regular)
                            .on_press(move |s: &mut AppState| {
                                s.dispatch(Action::Settings(SettingsAction::SetLmStudioEnabled {
                                    workspace_id: ws_toggle.clone(),
                                    enabled: !lm_enabled,
                                }));
                            })
                            .build(k),
                    )
                    .child(
                        Button::new("Check server")
                            .variant(ButtonVariant::Outline)
                            .control_size(ControlSize::Regular)
                            .on_press(move |s: &mut AppState| {
                                s.dispatch(Action::Settings(SettingsAction::CheckLmStudioStatus {
                                    workspace_id: ws_check.clone(),
                                    base_url: None,
                                }));
                            })
                            .build(k),
                    )
                    .child(
                        Button::new("Start server")
                            .variant(ButtonVariant::Ghost)
                            .control_size(ControlSize::Regular)
                            .on_press(move |s: &mut AppState| {
                                s.dispatch(Action::Settings(SettingsAction::StartLmStudio {
                                    workspace_id: ws_start.clone(),
                                    base_url: None,
                                }));
                            })
                            .build(k),
                    ),
            );
    }

    let methods = s
        .provider_auth_methods
        .get(&prov.id)
        .cloned()
        .unwrap_or_default();
    let has_api = provider_supports_api_key(s, &prov.id);
    let has_oauth = provider_supports_oauth(s, &prov.id);

    if has_api {
        let mask_non_empty = saved_mask.filter(|m| !m.trim().is_empty());
        let mut label_row = row()
            .w_full()
            .justify_between()
            .center_y()
            .child(text("API key").font(k.ty.small_medium).color(t.text_muted));
        if let Some(mask) = mask_non_empty {
            label_row = label_row.child(status_pill(
                format!("Saved ({mask})"),
                StatusTone::Success,
                k,
                t,
            ));
        }

        let input = TextInput::new(&s.shell_ui.onboarding_api_key_edit)
            .label(format!("{display_name} API key"))
            .placeholder(if mask_non_empty.is_some() {
                "Enter replacement API key…"
            } else {
                "Paste your API key…"
            })
            .secure()
            .revealed(s.shell_ui.onboarding_api_key_revealed)
            .width(Some(316.0))
            .on_edit(|s: &mut AppState| &mut s.shell_ui.onboarding_api_key_edit)
            .build(k);

        let reveal_btn = IconButton::new(if s.shell_ui.onboarding_api_key_revealed {
            &settings_icons::EYE_OFF
        } else {
            &settings_icons::EYE
        })
        .variant(IconButtonVariant::GhostMuted)
        .control_size(ControlSize::Regular)
        .label(if s.shell_ui.onboarding_api_key_revealed {
            "Hide API key"
        } else {
            "Reveal API key"
        })
        .on_press(|s: &mut AppState| {
            s.shell_ui.onboarding_api_key_revealed = !s.shell_ui.onboarding_api_key_revealed;
        })
        .build(k);

        let key_empty = s.shell_ui.onboarding_api_key_edit.text.trim().is_empty();
        let ws_save = ws_id.to_owned();
        let prov_save = prov.id.clone();

        detail = detail.child(
            col().w_full().gap(6.0).child(label_row).child(
                row()
                    .w_full()
                    .gap(8.0)
                    .flex_wrap()
                    .center_y()
                    .child(input)
                    .child(reveal_btn)
                    .child(
                        Button::new("Save")
                            .variant(ButtonVariant::Contrast)
                            .control_size(ControlSize::Regular)
                            .disabled(key_empty)
                            .on_press(move |s: &mut AppState| {
                                let val = s.shell_ui.onboarding_api_key_edit.text.trim().to_owned();
                                if !val.is_empty() {
                                    s.dispatch(Action::Settings(
                                        SettingsAction::SetProviderApiKey {
                                            workspace_id: ws_save.clone(),
                                            provider: prov_save.clone(),
                                            api_key: val,
                                        },
                                    ));
                                    s.shell_ui.onboarding_api_key_edit = TextEdit::new("");
                                }
                            })
                            .build(k),
                    ),
            ),
        );
    }

    if has_oauth {
        let ws_oauth = ws_id.to_owned();
        let prov_oauth = prov.id.clone();
        let ws_cb = ws_id.to_owned();
        let prov_cb = prov.id.clone();
        let oauth_spec = provider_oauth_spec(s, &prov.id);
        let method_id = oauth_spec
            .map(|m| m.id.clone())
            .or_else(|| {
                methods
                    .iter()
                    .find(|m| m.to_ascii_lowercase().contains("oauth"))
                    .cloned()
            })
            .unwrap_or_else(|| {
                if matches!(prov.id.as_str(), "codex-cli" | "claude-cli") {
                    "oauth_cli".to_owned()
                } else {
                    "oauth".to_owned()
                }
            });
        let button_label = oauth_spec
            .and_then(|m| m.label.as_deref())
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .unwrap_or("Sign in");
        let challenge = extract_challenge(s, &prov.id);
        let show_code_input =
            oauth_spec.and_then(|m| m.oauth_mode.as_deref()) != Some("auto") || challenge.is_some();
        let code_empty = s.shell_ui.onboarding_oauth_code_edit.text.trim().is_empty();

        let mut oauth_row = row().w_full().gap(8.0).flex_wrap().center_y().child(
            Button::new(button_label)
                .variant(if has_api {
                    ButtonVariant::Outline
                } else {
                    ButtonVariant::Contrast
                })
                .control_size(ControlSize::Regular)
                .on_press(move |s: &mut AppState| {
                    s.dispatch(Action::Settings(SettingsAction::StartProviderAuth {
                        workspace_id: ws_oauth.clone(),
                        provider: prov_oauth.clone(),
                    }));
                })
                .build(k),
        );
        if show_code_input {
            oauth_row = oauth_row
                .child(
                    TextInput::new(&s.shell_ui.onboarding_oauth_code_edit)
                        .label("OAuth authorization code")
                        .placeholder("Paste code if prompted…")
                        .width(Some(272.0))
                        .on_edit(|s: &mut AppState| &mut s.shell_ui.onboarding_oauth_code_edit)
                        .build(k),
                )
                .child(
                    Button::new("Submit")
                        .variant(ButtonVariant::Outline)
                        .control_size(ControlSize::Regular)
                        .disabled(code_empty)
                        .on_press(move |s: &mut AppState| {
                            let code = s.shell_ui.onboarding_oauth_code_edit.text.trim().to_owned();
                            if !code.is_empty() {
                                s.dispatch(Action::Settings(
                                    SettingsAction::CompleteProviderAuthCallback {
                                        workspace_id: ws_cb.clone(),
                                        provider: prov_cb.clone(),
                                        method_id: method_id.clone(),
                                        callback_input: code,
                                    },
                                ));
                                s.shell_ui.onboarding_oauth_code_edit = TextEdit::new("");
                            }
                        })
                        .build(k),
                );
        }

        let mut oauth_col = col().w_full().gap(6.0);
        if has_api {
            oauth_col = oauth_col
                .pt(10.0)
                .border_sides([1.0, 0.0, 0.0, 0.0], t.border_muted);
        }
        oauth_col = oauth_col
            .child(
                text("Browser sign-in")
                    .font(k.ty.small_medium)
                    .color(t.text_muted),
            )
            .child(oauth_row);

        if let Some(ch) = challenge {
            let inner = ch.get("challenge").unwrap_or(ch);
            if let Some(instr) = inner
                .get("instructions")
                .and_then(Value::as_str)
                .filter(|txt| !txt.trim().is_empty())
            {
                oauth_col = oauth_col.child(text(instr).font(t.caption).color(t.text_muted).wrap());
            }
            if let Some(safe_url) = inner
                .get("url")
                .and_then(Value::as_str)
                .and_then(safe_auth_link)
            {
                oauth_col = oauth_col.child(
                    row().child(
                        Button::new("Open verification link")
                            .variant(ButtonVariant::Ghost)
                            .control_size(ControlSize::Small)
                            .icon(&icons::EXTERNAL_LINK)
                            .on_press(move |s: &mut AppState| {
                                s.dispatch(Action::Shell(ShellAction::RequestExternalUrl(
                                    safe_url.clone(),
                                )));
                            })
                            .build(k),
                    ),
                );
            }
        }

        detail = detail.child(oauth_col);
    }

    detail
}

fn build_defaults_step(
    s: &AppState,
    k: &Kit,
    t: &ThemeTokens,
    select_overlays: &mut Vec<El>,
) -> (El, El) {
    let candidates = onboarding_workspaces(s);
    let active_ws = active_onboarding_workspace(s, &candidates);
    let ws_label = active_ws
        .map(workspace_display_name)
        .unwrap_or_else(|| "your workspace".to_owned());

    let providers = catalog_or_fallback(s);
    let statuses = provider_statuses(s, active_ws);
    let sorted = sort_and_filter_providers(&providers, statuses, "");
    let connected: Vec<&ProviderSummary> = sorted
        .iter()
        .copied()
        .filter(|p| {
            let st = statuses.iter().find(|st| st.provider == p.id);
            is_provider_connected(p, st, active_ws)
        })
        .collect();
    let selectable_providers: Vec<&ProviderSummary> = if connected.is_empty() {
        sorted
    } else {
        connected
    };

    let raw_prov_id = active_ws
        .and_then(|w| w.default_provider.as_deref())
        .unwrap_or("");
    let effective_provider = selectable_providers
        .iter()
        .copied()
        .find(|p| p.id == raw_prov_id)
        .or_else(|| selectable_providers.first().copied());

    let effective_prov_id = effective_provider
        .map(|p| p.id.clone())
        .unwrap_or_else(|| "anthropic".to_owned());
    let effective_prov_name = effective_provider
        .map(|p| {
            if p.name.trim().is_empty() {
                p.id.clone()
            } else {
                p.name.clone()
            }
        })
        .unwrap_or_else(|| "Anthropic".to_owned());

    let prov_labels: Vec<String> = selectable_providers
        .iter()
        .map(|p| {
            if p.name.trim().is_empty() {
                p.id.clone()
            } else {
                p.name.clone()
            }
        })
        .collect();
    let prov_label_refs: Vec<&str> = prov_labels.iter().map(String::as_str).collect();
    let prov_pairs: Vec<(String, String, Option<String>)> = selectable_providers
        .iter()
        .map(|p| {
            let lbl = if p.name.trim().is_empty() {
                p.id.clone()
            } else {
                p.name.clone()
            };
            let first_m = p
                .models
                .iter()
                .find(|m| m.enabled)
                .or_else(|| p.models.first())
                .map(|m| m.id.clone());
            (lbl, p.id.clone(), first_m)
        })
        .collect();

    let prov_open =
        s.shell_ui.onboarding_open_select.as_deref() == Some("onboarding-default-provider");
    let ws_for_prov = active_ws.map(|w| w.id.clone());
    let prov_select = Select::new("onboarding-default-provider", &prov_label_refs)
        .label("Default provider")
        .appearance(SelectAppearance::Field)
        .width(196.0)
        .current(Some(effective_prov_name.as_str()))
        .disabled(ws_for_prov.is_none() || prov_label_refs.is_empty())
        .open(prov_open)
        .on_toggle(|s: &mut AppState| {
            let open =
                s.shell_ui.onboarding_open_select.as_deref() == Some("onboarding-default-provider");
            s.shell_ui.onboarding_open_select = if open {
                None
            } else {
                Some("onboarding-default-provider".to_owned())
            };
        })
        .on_close(|s: &mut AppState| {
            if s.shell_ui.onboarding_open_select.as_deref() == Some("onboarding-default-provider") {
                s.shell_ui.onboarding_open_select = None;
            }
        })
        .on_choose(move |s: &mut AppState, chosen, _tx| {
            s.shell_ui.onboarding_open_select = None;
            let Some(ws_id) = &ws_for_prov else {
                return;
            };
            if let Some((_, pid, first_m)) = prov_pairs.iter().find(|(lbl, _, _)| lbl == chosen) {
                let next_model = s
                    .default_model_by_provider
                    .get(pid)
                    .cloned()
                    .filter(|m| !m.trim().is_empty())
                    .or_else(|| first_m.clone())
                    .unwrap_or_default();
                let mut patch = serde_json::Map::new();
                patch.insert("defaultProvider".to_owned(), Value::String(pid.clone()));
                if !next_model.is_empty() {
                    patch.insert("defaultModel".to_owned(), Value::String(next_model.clone()));
                    patch.insert(
                        "defaultPreferredChildModel".to_owned(),
                        Value::String(next_model.clone()),
                    );
                    patch.insert(
                        "defaultPreferredChildModelRef".to_owned(),
                        Value::String(format!("{pid}:{next_model}")),
                    );
                }
                s.dispatch(Action::Settings(SettingsAction::UpdateWorkspaceDefaults {
                    workspace_id: ws_id.clone(),
                    defaults: Value::Object(patch),
                }));
            }
        })
        .build(k, select_overlays);

    let mut model_opts: Vec<String> = effective_provider
        .map(|p| {
            let enabled: Vec<String> = p
                .models
                .iter()
                .filter(|m| m.enabled)
                .map(|m| m.id.clone())
                .collect();
            if enabled.is_empty() {
                p.models.iter().map(|m| m.id.clone()).collect()
            } else {
                enabled
            }
        })
        .unwrap_or_default();

    let saved_model = active_ws
        .and_then(|w| w.default_model.clone())
        .filter(|m| !m.trim().is_empty())
        .or_else(|| s.default_model_by_provider.get(&effective_prov_id).cloned())
        .or_else(|| model_opts.first().cloned())
        .unwrap_or_default();

    if !saved_model.is_empty() && !model_opts.iter().any(|m| m == &saved_model) {
        model_opts.insert(0, saved_model.clone());
    }
    let model_refs: Vec<&str> = model_opts.iter().map(String::as_str).collect();
    let mod_open = s.shell_ui.onboarding_open_select.as_deref() == Some("onboarding-default-model");
    let ws_for_mod = active_ws.map(|w| w.id.clone());
    let pid_for_mod = effective_prov_id.clone();

    let model_select = Select::new("onboarding-default-model", &model_refs)
        .label("Default model")
        .appearance(SelectAppearance::Field)
        .width(196.0)
        .current((!saved_model.is_empty()).then_some(saved_model.as_str()))
        .disabled(ws_for_mod.is_none() || model_refs.is_empty())
        .open(mod_open)
        .on_toggle(|s: &mut AppState| {
            let open =
                s.shell_ui.onboarding_open_select.as_deref() == Some("onboarding-default-model");
            s.shell_ui.onboarding_open_select = if open {
                None
            } else {
                Some("onboarding-default-model".to_owned())
            };
        })
        .on_close(|s: &mut AppState| {
            if s.shell_ui.onboarding_open_select.as_deref() == Some("onboarding-default-model") {
                s.shell_ui.onboarding_open_select = None;
            }
        })
        .on_choose(move |s: &mut AppState, chosen, _tx| {
            s.shell_ui.onboarding_open_select = None;
            let Some(ws_id) = &ws_for_mod else {
                return;
            };
            s.dispatch(Action::Settings(SettingsAction::UpdateWorkspaceDefaults {
                workspace_id: ws_id.clone(),
                defaults: json!({
                    "defaultProvider": pid_for_mod,
                    "defaultModel": chosen,
                    "defaultPreferredChildModel": chosen,
                    "defaultPreferredChildModelRef": format!("{pid_for_mod}:{chosen}"),
                }),
            }));
        })
        .build(k, select_overlays);

    let enable_mcp = active_ws.map(|w| w.default_enable_mcp).unwrap_or(true);
    let enable_backups = active_ws
        .map(|w| w.default_backups_enabled)
        .unwrap_or(false);
    let ws_mcp = active_ws.map(|w| w.id.clone());
    let ws_bkp = active_ws.map(|w| w.id.clone());

    let defaults_card = col()
        .key("onboarding-defaults-card")
        .w_full()
        .radius(10.0)
        .continuous_corners()
        .clip_rounded(10.0)
        .fill(t.card_bg)
        .border(1.0, t.border_muted)
        .child(
            row()
                .w_full()
                .px(14.0)
                .py(12.0)
                .gap(12.0)
                .center_y()
                .child(
                    col()
                        .grow(1.0)
                        .min_w(0.0)
                        .gap(2.0)
                        .child(
                            text("Default provider")
                                .font(k.ty.ui_medium)
                                .color(t.text_base),
                        )
                        .child(
                            text("Provider used when starting new chats.")
                                .font(t.caption)
                                .color(t.text_muted)
                                .wrap(),
                        ),
                )
                .child(prov_select),
        )
        .child(
            row()
                .w_full()
                .px(14.0)
                .py(12.0)
                .gap(12.0)
                .center_y()
                .border_sides([1.0, 0.0, 0.0, 0.0], t.border_muted)
                .child(
                    col()
                        .grow(1.0)
                        .min_w(0.0)
                        .gap(2.0)
                        .child(
                            text("Default model")
                                .font(k.ty.ui_medium)
                                .color(t.text_base),
                        )
                        .child(
                            text("Can be switched per thread in the chat bar.")
                                .font(t.caption)
                                .color(t.text_muted)
                                .wrap(),
                        ),
                )
                .child(model_select),
        )
        .child(
            row()
                .w_full()
                .px(14.0)
                .py(12.0)
                .gap(12.0)
                .center_y()
                .border_sides([1.0, 0.0, 0.0, 0.0], t.border_muted)
                .child(
                    col()
                        .grow(1.0)
                        .min_w(0.0)
                        .gap(2.0)
                        .child(text("MCP servers").font(k.ty.ui_medium).color(t.text_base))
                        .child(
                            text("Allow external tool servers configured for this workspace.")
                                .font(t.caption)
                                .color(t.text_muted)
                                .wrap(),
                        ),
                )
                .child(mini_switch(
                    enable_mcp,
                    "MCP servers",
                    ws_mcp.is_none(),
                    move |s: &mut AppState| {
                        if let Some(ws_id) = &ws_mcp {
                            s.dispatch(Action::Settings(SettingsAction::UpdateWorkspaceDefaults {
                                workspace_id: ws_id.clone(),
                                defaults: json!({ "defaultEnableMcp": !enable_mcp }),
                            }));
                        }
                    },
                    k,
                )),
        )
        .child(
            row()
                .w_full()
                .px(14.0)
                .py(12.0)
                .gap(12.0)
                .center_y()
                .border_sides([1.0, 0.0, 0.0, 0.0], t.border_muted)
                .child(
                    col()
                        .grow(1.0)
                        .min_w(0.0)
                        .gap(2.0)
                        .child(text("Backups").font(k.ty.ui_medium).color(t.text_base))
                        .child(
                            text("Opt-in recovery snapshots before workspace edits.")
                                .font(t.caption)
                                .color(t.text_muted)
                                .wrap(),
                        ),
                )
                .child(mini_switch(
                    enable_backups,
                    "Backups",
                    ws_bkp.is_none(),
                    move |s: &mut AppState| {
                        if let Some(ws_id) = &ws_bkp {
                            s.dispatch(Action::Settings(SettingsAction::UpdateWorkspaceDefaults {
                                workspace_id: ws_id.clone(),
                                defaults: json!({ "defaultBackupsEnabled": !enable_backups }),
                            }));
                        }
                    },
                    k,
                )),
        );

    let body = col()
        .w_full()
        .gap(16.0)
        .child(step_header(
            "Review defaults",
            format!("Defaults for {ws_label}. You can always change these later in Settings."),
            None,
            t,
        ))
        .child(defaults_card);

    let footer = row()
        .w_full()
        .pt(2.0)
        .gap(8.0)
        .center_y()
        .child(
            Button::new("Back")
                .variant(ButtonVariant::GhostMuted)
                .control_size(ControlSize::Large)
                .on_press(|s: &mut AppState| {
                    s.shell_ui.onboarding_step = 2;
                    s.shell_ui.onboarding_open_select = None;
                    s.shell_ui.onboarding_confirm_discard = false;
                })
                .build(k)
                .key("onboarding-back"),
        )
        .child(spacer())
        .child(
            Button::new("Continue")
                .variant(ButtonVariant::Contrast)
                .control_size(ControlSize::Large)
                .on_press(|s: &mut AppState| {
                    sync_connected_workspace_defaults(s);
                    s.shell_ui.onboarding_step = 4;
                    s.shell_ui.onboarding_open_select = None;
                    s.shell_ui.onboarding_confirm_discard = false;
                    s.dispatch(Action::Shell(ShellAction::CompleteOnboardingStep(
                        "step-4".to_owned(),
                    )));
                })
                .build(k)
                .key("onboarding-continue"),
        );

    (body, footer)
}

fn build_first_thread_step(s: &AppState, k: &Kit, t: &ThemeTokens) -> (El, El) {
    let candidates = onboarding_workspaces(s);
    let active_ws = active_onboarding_workspace(s, &candidates);
    let active_ws_id = active_ws.map(|w| w.id.clone());

    let mut prompts_col = col().w_full().gap(8.0);
    for (idx, (label, prompt)) in STARTER_PROMPTS.iter().copied().enumerate() {
        let prompt_msg = prompt.to_owned();
        let ws_target = active_ws_id.clone();

        let prompt_card = k
            .interactive(
                row()
                    .key(format!("onboarding-starter-{idx}"))
                    .role("button")
                    .label(label)
                    .w_full()
                    .px(14.0)
                    .py(12.0)
                    .gap(12.0)
                    .center_y()
                    .radius(10.0)
                    .continuous_corners()
                    .fill(t.card_bg)
                    .border(1.0, t.border_muted)
                    .child(tinted_icon_badge(&icons::MESSAGE, 30.0, 14.0, t))
                    .child(
                        col()
                            .grow(1.0)
                            .min_w(0.0)
                            .gap(2.0)
                            .child(text(label).font(k.ty.ui_medium).color(t.text_base))
                            .child(text(prompt).font(t.caption).color(t.text_muted).truncate()),
                    )
                    .child(icon(&icons::ARROW_RIGHT, 14.0).color(t.text_faint)),
            )
            .on_press_tx(move |s: &mut AppState, _| {
                if let Some(ws_id) = &ws_target {
                    s.dispatch(Action::Navigate(NavAction::SelectWorkspace(ws_id.clone())));
                    s.dispatch(Action::Shell(ShellAction::SetLandingWorkspace(Some(
                        ws_id.clone(),
                    ))));
                }
                s.dispatch(Action::Shell(ShellAction::CompleteOnboardingStep(
                    "step-5".to_owned(),
                )));
                s.dispatch(Action::Shell(ShellAction::CompleteOnboarding));
                s.dispatch(Action::Chat(ChatAction::SendMessage {
                    thread_id: None,
                    text: prompt_msg.clone(),
                    busy_policy: ThreadBusyPolicy::Queue,
                    attachments: Vec::new(),
                    references: Vec::new(),
                }));
            });

        prompts_col = prompts_col.child(prompt_card);
    }

    let mut body = col().w_full().gap(16.0).child(step_header(
        "Start your first thread",
        "Pick a starter prompt or open a blank chat.",
        None,
        t,
    ));

    if let Some(err) = s.shell_ui.onboarding_completion_error.as_deref() {
        body = body.child(
            el().w_full()
                .px(12.0)
                .py(10.0)
                .radius(8.0)
                .fill(t.danger.alpha(0.10))
                .border(1.0, t.danger.alpha(0.35))
                .child(text(err).font(t.caption).color(t.danger).wrap()),
        );
    }

    body = body.child(prompts_col);

    let ws_blank = active_ws_id.clone();
    let finish_label = if ws_blank.is_some() {
        "Start blank thread"
    } else {
        "Finish setup"
    };

    let footer = row()
        .w_full()
        .pt(2.0)
        .gap(8.0)
        .center_y()
        .child(
            Button::new("Back")
                .variant(ButtonVariant::GhostMuted)
                .control_size(ControlSize::Large)
                .on_press(|s: &mut AppState| {
                    s.shell_ui.onboarding_step = 3;
                    s.shell_ui.onboarding_open_select = None;
                    s.shell_ui.onboarding_confirm_discard = false;
                })
                .build(k)
                .key("onboarding-back"),
        )
        .child(spacer())
        .child(
            Button::new(finish_label)
                .variant(ButtonVariant::Contrast)
                .control_size(ControlSize::Large)
                .on_press(move |s: &mut AppState| {
                    s.dispatch(Action::Shell(ShellAction::CompleteOnboardingStep(
                        "step-5".to_owned(),
                    )));
                    s.dispatch(Action::Shell(ShellAction::CompleteOnboarding));
                    if let Some(ws_id) = &ws_blank {
                        s.dispatch(Action::Navigate(NavAction::OpenNewChat {
                            workspace_id: Some(ws_id.clone()),
                        }));
                    }
                })
                .build(k)
                .key("onboarding-finish-setup"),
        );

    (body, footer)
}

fn push_skip_confirm_dialog(k: &Kit, t: &ThemeTokens, layer: &mut Vec<El>) {
    let desc = "You haven't finished adding a workspace or connecting a model provider yet. You can reopen guided setup anytime from Settings → Developer.";

    let footer = row()
        .w_full()
        .pt(4.0)
        .gap(8.0)
        .child(spacer())
        .child(
            Button::new("Continue setup")
                .variant(ButtonVariant::Ghost)
                .on_press_tx(|s: &mut AppState, _| {
                    s.shell_ui.onboarding_confirm_discard = false;
                })
                .build(k)
                .key("onboarding-keep-setup"),
        )
        .child(
            Button::new("Skip for now")
                .variant(ButtonVariant::Contrast)
                .on_press_tx(|s: &mut AppState, _| {
                    s.shell_ui.onboarding_confirm_discard = false;
                    s.dispatch(Action::Shell(ShellAction::SkipOnboarding));
                })
                .build(k)
                .key("onboarding-skip-anyway"),
        );

    Dialog::new("onboarding-skip-confirm", "Skip setup?")
        .open(true)
        .width(420.0)
        .fit()
        .click_outside(true)
        .on_close(|s: &mut AppState| {
            s.shell_ui.onboarding_confirm_discard = false;
        })
        .child(
            col()
                .w_full()
                .px(16.0)
                .pb(16.0)
                .gap(12.0)
                .child(text(desc).font(t.body).color(t.text_muted).wrap())
                .child(footer),
        )
        .build(k, layer);
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use rune::render::{Gpu, OFFSCREEN_FORMAT, Offscreen, Renderer, write_png};
    use rune::{Cx, El, Env, Key, KeyEvent, Mods, Runtime, TextEdit, Tx};
    use serde_json::json;

    use super::*;
    use crate::actions::StoreEvent;
    use crate::router::{SettingsPageId, ViewId};
    use crate::state::{PersistedDesktopState, ProviderModelSummary, WorkspaceRuntime};
    use crate::theme::{self, ThemePreference};

    const SNAP_VIEWPORT: (f32, f32) = (1280.0, 820.0);

    fn test_shell_root(state: &AppState, cx: &mut Cx<AppState>) -> El {
        let dark = state.effective_dark(cx.system_dark());
        let (k, t) = theme::build_kit_with_accent(
            dark,
            state.desktop_settings.reduced_transparency,
            state.desktop_settings.high_contrast,
            state.desktop_settings.accent_palette,
        );
        cx.foreground(t.text_base);
        cx.focus_ring(2.0, 2.5, t.focus_ring);
        cx.web_focus();
        crate::views::shell::view(state, cx, &k, &t)
    }

    fn render_offscreen_rgba(
        gpu: &Gpu,
        renderer: &mut Renderer,
        rt: &mut Runtime<AppState>,
        dark: bool,
    ) -> Vec<u8> {
        let scale = rt.env.scale;
        let dw = (SNAP_VIEWPORT.0 * scale) as u32;
        let dh = (SNAP_VIEWPORT.1 * scale) as u32;
        let target = Offscreen::new(&gpu.device, dw, dh);

        renderer.upload_images(&gpu.device, &gpu.queue, &mut rt.images);
        renderer.prepare_surfaces(&gpu.device, &gpu.queue, &rt.surfaces, (dw, dh));
        renderer.prepare(
            &gpu.device,
            &gpu.queue,
            &mut rt.text.atlas,
            &rt.instances,
            (dw, dh),
        );
        let tokens = theme::resolve_tokens_with_accent(
            dark,
            rt.state.desktop_settings.reduced_transparency,
            rt.state.desktop_settings.high_contrast,
            rt.state.desktop_settings.accent_palette,
        );
        let clear = [
            tokens.panel_bg.r,
            tokens.panel_bg.g,
            tokens.panel_bg.b,
            tokens.panel_bg.a,
        ];
        let mut enc = gpu.device.create_command_encoder(&Default::default());
        renderer.draw(&mut enc, &target.view, clear);
        target.copy(&mut enc);
        renderer.submit(&gpu.queue, enc);
        target.read(&gpu.device)
    }

    fn maybe_save_snap(name: &str, rgba: &[u8], scale: f32) {
        let Ok(dir) = std::env::var("COWORK_ONBOARDING_SNAP_DIR") else {
            return;
        };
        let dir = PathBuf::from(dir);
        std::fs::create_dir_all(&dir).expect("create onboarding snap dir");
        let dw = (SNAP_VIEWPORT.0 * scale) as u32;
        let dh = (SNAP_VIEWPORT.1 * scale) as u32;
        write_png(&dir.join(format!("{name}.png")), dw, dh, rgba).expect("write onboarding png");
    }

    fn click_key(rt: &mut Runtime<AppState>, key: &str) {
        let (x, y) = rt
            .find(key)
            .unwrap_or_else(|| panic!("expected interactive element `{key}` in onboarding"));
        rt.pointer_move(x, y);
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(0.0);
        rt.settle_all();
        rt.frame(0.0);
    }

    fn sample_workspace() -> WorkspaceRecord {
        WorkspaceRecord {
            id: "ws-demo".into(),
            name: "agent-coworker".into(),
            path: "/Users/mweinbach/Projects/agent-coworker".into(),
            default_provider: Some("anthropic".into()),
            default_model: Some("claude-sonnet-4-5".into()),
            default_enable_mcp: true,
            defaults: json!({
                "mcpEnabled": true,
                "backupEnabled": false,
            }),
            ..Default::default()
        }
    }

    fn base_state(dark: bool) -> AppState {
        let mut s = AppState::default();
        s.desktop_settings.theme = if dark {
            ThemePreference::Dark
        } else {
            ThemePreference::Light
        };
        s
    }

    fn populated_state(dark: bool) -> AppState {
        let mut s = base_state(dark);
        s.workspaces.push(sample_workspace());
        s.active_workspace_id = Some("ws-demo".into());
        s.workspace_runtime_by_id.insert(
            "ws-demo".into(),
            WorkspaceRuntime {
                server_state: ServerLifecycleState::Running {
                    port: 4100,
                    ws_url: "ws://127.0.0.1:4100".into(),
                },
                provider_statuses: vec![ProviderStatusSummary {
                    provider: "anthropic".into(),
                    connected: true,
                    saved_api_key_mask: Some("sk-ant-•••9f2a".into()),
                    ..Default::default()
                }],
                ..Default::default()
            },
        );
        s
    }

    #[test]
    fn guided_onboarding_five_step_flow_skip_dialog_and_restart() {
        let s = base_state(false);

        let mut rt = Runtime::new(s, test_shell_root, SNAP_VIEWPORT, Env::new(false, 1.0));
        rt.frame(0.0);
        rt.settle_all();
        rt.frame(0.0);

        // Step 0: Welcome — dismissing while incomplete opens confirmation dialog first.
        click_key(&mut rt, "onboarding-not-now");
        assert!(rt.state.shell_ui.onboarding_confirm_discard);
        assert!(!rt.state.onboarding.dismissed);

        click_key(&mut rt, "onboarding-keep-setup");
        assert!(!rt.state.shell_ui.onboarding_confirm_discard);

        // Advance Step 0 -> Step 1 (Workspace).
        click_key(&mut rt, "onboarding-get-started");
        assert_eq!(rt.state.shell_ui.onboarding_step, 1);
        assert!(rt.state.onboarding.completed_steps.contains("step-1"));

        // Without a workspace, Continue is disabled and does not advance.
        click_key(&mut rt, "onboarding-continue");
        assert_eq!(rt.state.shell_ui.onboarding_step, 1);

        // Add workspace -> Continue advances Step 1 -> Step 2 (Provider).
        rt.update(|st, _| {
            st.workspaces.push(sample_workspace());
            st.active_workspace_id = Some("ws-demo".into());
            st.workspace_runtime_by_id.insert(
                "ws-demo".into(),
                WorkspaceRuntime {
                    server_state: ServerLifecycleState::Running {
                        port: 4100,
                        ws_url: "ws://127.0.0.1:4100".into(),
                    },
                    ..Default::default()
                },
            );
        });
        rt.frame(0.0);
        rt.settle_all();
        rt.frame(0.0);

        click_key(&mut rt, "onboarding-continue");
        assert_eq!(rt.state.shell_ui.onboarding_step, 2);
        assert!(rt.state.onboarding.completed_steps.contains("step-2"));

        // Expand Anthropic inline setup -> Continue still disabled until connected.
        click_key(&mut rt, "ob-prov-trigger-anthropic");
        assert_eq!(
            rt.state.shell_ui.onboarding_expanded_provider.as_deref(),
            Some("anthropic")
        );
        click_key(&mut rt, "onboarding-continue");
        assert_eq!(rt.state.shell_ui.onboarding_step, 2);

        // Mark Anthropic connected -> Continue advances Step 2 -> Step 3 (Defaults).
        rt.update(|st, _| {
            st.provider_catalog.push(ProviderSummary {
                id: "anthropic".into(),
                name: "Anthropic".into(),
                configured: true,
                models: vec![ProviderModelSummary {
                    id: "claude-sonnet-4-5".into(),
                    name: "Claude Sonnet 4.5".into(),
                    enabled: true,
                    ..Default::default()
                }],
                ..Default::default()
            });
            if let Some(ws_rt) = st.workspace_runtime_by_id.get_mut("ws-demo") {
                ws_rt.provider_statuses.push(ProviderStatusSummary {
                    provider: "anthropic".into(),
                    connected: true,
                    saved_api_key_mask: Some("sk-ant-•••9f2a".into()),
                    ..Default::default()
                });
            }
        });
        rt.frame(0.0);
        rt.settle_all();
        rt.frame(0.0);

        click_key(&mut rt, "onboarding-continue");
        assert_eq!(rt.state.shell_ui.onboarding_step, 3);
        assert!(rt.state.onboarding.completed_steps.contains("step-3"));

        // Advance Step 3 -> Step 4 (First thread).
        click_key(&mut rt, "onboarding-continue");
        assert_eq!(rt.state.shell_ui.onboarding_step, 4);
        assert!(rt.state.onboarding.completed_steps.contains("step-4"));

        // Clicking a starter prompt completes onboarding and leaves modal hidden.
        click_key(&mut rt, "onboarding-starter-0");
        assert!(rt.state.onboarding.completed);
        assert!(rt.state.onboarding.completed_steps.contains("step-5"));
        assert!(!is_onboarding_visible(&rt.state));

        // Restarting onboarding from Developer Settings navigates back to Chat & Step 0.
        rt.state
            .dispatch(Action::Navigate(NavAction::OpenSettings(Some(
                SettingsPageId::Developer,
            ))));
        assert_eq!(rt.state.route().view, ViewId::Settings);
        rt.state
            .dispatch(Action::Settings(SettingsAction::RestartOnboarding));
        assert_eq!(rt.state.route().view, ViewId::Chat);
        assert_eq!(rt.state.shell_ui.onboarding_step, 0);
        assert!(is_onboarding_visible(&rt.state));

        // Escape while incomplete (remove provider status) prompts skip confirmation, second Escape closes dialog.
        if let Some(ws_rt) = rt.state.workspace_runtime_by_id.get_mut("ws-demo") {
            ws_rt.provider_statuses.clear();
        }
        rt.state.provider_catalog.clear();
        let esc = KeyEvent {
            key: Key::Escape,
            mods: Mods::default(),
        };
        let mut tx = Tx::default();
        assert!(crate::views::shell::state::handle_key(
            &mut rt.state,
            &esc,
            &mut tx
        ));
        assert!(rt.state.shell_ui.onboarding_confirm_discard);
        assert!(crate::views::shell::state::handle_key(
            &mut rt.state,
            &esc,
            &mut tx
        ));
        assert!(!rt.state.shell_ui.onboarding_confirm_discard);
    }

    #[test]
    fn backfills_completed_on_native_ready_when_persisted_workspaces_exist() {
        let mut s = AppState::default();
        let mut persisted = PersistedDesktopState::default();
        persisted.workspaces.push(sample_workspace());
        assert!(!s.onboarding.completed);
        s.apply_store_event(StoreEvent::NativeReady {
            persisted: Box::new(persisted),
            is_packaged: false,
            system_dark: Some(false),
        });
        assert!(s.onboarding.completed);
    }

    #[test]
    fn renders_all_five_steps_headlessly_in_light_and_dark_within_bounds() {
        let gpu = Gpu::headless();
        let mut renderer = Renderer::new(&gpu.device, OFFSCREEN_FORMAT);

        for dark in [false, true] {
            let suffix = if dark { "dark" } else { "light" };

            // 1. Welcome
            {
                let mut rt = Runtime::new(
                    base_state(dark),
                    test_shell_root,
                    SNAP_VIEWPORT,
                    Env::new(dark, 2.0),
                );
                rt.frame(0.0);
                rt.frame(1.0);
                let (card_rect, _) = rt
                    .presented("desktop-onboarding-card")
                    .expect("onboarding card on step 0");
                assert!(card_rect[2] <= 521.0 && card_rect[3] < SNAP_VIEWPORT.1);
                let rgba = render_offscreen_rgba(&gpu, &mut renderer, &mut rt, dark);
                assert!(rgba.chunks_exact(4).any(|px| px[..3] != rgba[..3]));
                maybe_save_snap(&format!("01_welcome_{suffix}"), &rgba, 2.0);
            }

            // 2a. Workspace (empty)
            {
                let mut s = base_state(dark);
                s.shell_ui.onboarding_step = 1;
                let mut rt = Runtime::new(s, test_shell_root, SNAP_VIEWPORT, Env::new(dark, 2.0));
                rt.frame(0.0);
                rt.frame(1.0);
                let rgba = render_offscreen_rgba(&gpu, &mut renderer, &mut rt, dark);
                maybe_save_snap(&format!("02a_workspace_empty_{suffix}"), &rgba, 2.0);
            }

            // 2b. Workspace (selected)
            {
                let mut s = populated_state(dark);
                s.shell_ui.onboarding_step = 1;
                let mut rt = Runtime::new(s, test_shell_root, SNAP_VIEWPORT, Env::new(dark, 2.0));
                rt.frame(0.0);
                rt.frame(1.0);
                let rgba = render_offscreen_rgba(&gpu, &mut renderer, &mut rt, dark);
                maybe_save_snap(&format!("02b_workspace_selected_{suffix}"), &rgba, 2.0);
            }

            // 3. Provider (expanded OpenAI card + connected Anthropic)
            {
                let mut s = populated_state(dark);
                s.shell_ui.onboarding_step = 2;
                s.shell_ui.onboarding_expanded_provider = Some("openai".into());
                s.shell_ui.onboarding_api_key_edit = TextEdit::new("sk-proj-demo123456");
                let mut rt = Runtime::new(s, test_shell_root, SNAP_VIEWPORT, Env::new(dark, 2.0));
                rt.frame(0.0);
                rt.frame(1.0);
                let (card_rect, _) = rt
                    .presented("desktop-onboarding-card")
                    .expect("onboarding card on step 2");
                assert!(card_rect[3] < SNAP_VIEWPORT.1 - 32.0);
                let rgba = render_offscreen_rgba(&gpu, &mut renderer, &mut rt, dark);
                maybe_save_snap(&format!("03_provider_expanded_{suffix}"), &rgba, 2.0);
            }

            // 4. Defaults
            {
                let mut s = populated_state(dark);
                s.shell_ui.onboarding_step = 3;
                let mut rt = Runtime::new(s, test_shell_root, SNAP_VIEWPORT, Env::new(dark, 2.0));
                rt.frame(0.0);
                rt.frame(1.0);
                let rgba = render_offscreen_rgba(&gpu, &mut renderer, &mut rt, dark);
                maybe_save_snap(&format!("04_defaults_{suffix}"), &rgba, 2.0);
            }

            // 5. First thread
            {
                let mut s = populated_state(dark);
                s.shell_ui.onboarding_step = 4;
                let mut rt = Runtime::new(s, test_shell_root, SNAP_VIEWPORT, Env::new(dark, 2.0));
                rt.frame(0.0);
                rt.frame(1.0);
                let rgba = render_offscreen_rgba(&gpu, &mut renderer, &mut rt, dark);
                maybe_save_snap(&format!("05_first_thread_{suffix}"), &rgba, 2.0);
            }

            // 6. Skip confirmation dialog over Welcome
            {
                let mut s = base_state(dark);
                s.shell_ui.onboarding_confirm_discard = true;
                let mut rt = Runtime::new(s, test_shell_root, SNAP_VIEWPORT, Env::new(dark, 2.0));
                rt.frame(0.0);
                rt.frame(1.0);
                let rgba = render_offscreen_rgba(&gpu, &mut renderer, &mut rt, dark);
                maybe_save_snap(&format!("06_skip_confirm_{suffix}"), &rgba, 2.0);
            }
        }
    }
}
