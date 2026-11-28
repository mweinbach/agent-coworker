//! Models & Providers settings page (`apps/desktop/src/ui/settings/pages/ProvidersPage.tsx`).

use std::collections::HashMap;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::OnceLock;

use rune::{El, ScrollSpec, col, el, icon, memo, row, text};
use rune_kit::{
    Button, ButtonVariant, ControlSize, Dialog, IconButton, IconButtonVariant, Kit, TextInput,
};
use serde_json::Value;

use crate::actions::{Action, SettingsAction, ShellAction};
use crate::state::{
    AppState, ProviderModelSummary, ProviderStatusSummary, ProviderSummary, WorkspaceRecord,
};
use crate::theme::ThemeTokens;
use crate::views::settings::icons;
use crate::views::settings::manage_models_dialog;
use crate::views::settings::primitives::{
    ConfirmDialogSpec, EmptyState, EntityIconSize, Section, StatusTone, callout_banner,
    confirm_dialog, entity_icon, find_management_target, management_targets, mini_switch,
    search_input, settings_page, status_pill, theme_memo_sig,
};
use crate::views::settings::providers_utils::{
    extract_rate_limit_hint, format_auth_method_label, model_display_name, provider_status_badge,
    sort_and_filter_provider_refs,
};
use crate::views::settings::shell::PageContent;

fn disclosure_chevron(open: bool, size: f32, motion: rune::Spring) -> El {
    icon(&icons::CHEVRON_RIGHT, size)
        .rotate(if open {
            std::f32::consts::FRAC_PI_2
        } else {
            0.0
        })
        .rotate_motion(motion)
}

fn fallback_providers_slice() -> &'static [ProviderSummary] {
    static FALLBACK: OnceLock<Vec<ProviderSummary>> = OnceLock::new();
    FALLBACK.get_or_init(|| {
        cowork_config::provider_specs()
            .iter()
            .filter(|spec| spec.user_facing)
            .map(|spec| ProviderSummary {
                id: spec.id.clone(),
                name: spec.display_name.clone(),
                configured: false,
                models: Vec::new(),
                config: Value::Null,
                capabilities: Value::Null,
            })
            .collect()
    })
}

/// Returns static user-facing provider placeholders from `config/providers.json` when the
/// server catalog has not hydrated yet.
pub fn fallback_providers() -> Vec<ProviderSummary> {
    fallback_providers_slice().to_vec()
}

fn is_user_facing_provider(id: &str) -> bool {
    cowork_config::ProviderName::parse(id)
        .map(|provider| provider.is_user_facing())
        .unwrap_or(true)
}

/// Returns whether a provider is currently connected or configured with a healthy status.
pub fn is_provider_connected(
    summary: &ProviderSummary,
    status: Option<&ProviderStatusSummary>,
    ws: Option<&WorkspaceRecord>,
) -> bool {
    if summary.id == "lmstudio" {
        let lm_enabled = ws
            .and_then(|w| w.defaults.get("lmStudioEnabled"))
            .and_then(Value::as_bool)
            .unwrap_or(summary.configured);
        return lm_enabled && status.is_some_and(|st| st.healthy || st.connected);
    }
    summary.configured || status.is_some_and(|st| st.healthy || st.connected)
}

/// Computes preview labels and overflow count for a provider's model badges.
pub fn provider_model_preview(models: &[ProviderModelSummary]) -> (Vec<&str>, usize) {
    let mut visible: Vec<&str> = models
        .iter()
        .filter(|m| m.enabled)
        .map(model_display_name)
        .collect();
    if visible.is_empty() {
        visible = models.iter().map(model_display_name).collect();
    }
    let total = visible.len();
    let preview: Vec<&str> = visible.into_iter().take(8).collect();
    let hidden = total.saturating_sub(preview.len());
    (preview, hidden)
}

fn provider_display_title(summary: &ProviderSummary) -> &str {
    if summary.name.trim().is_empty() {
        summary.id.as_str()
    } else {
        summary.name.trim()
    }
}

fn resolved_auth_methods(
    s: &AppState,
    provider_id: &str,
) -> Vec<cowork_config::ProviderAuthMethod> {
    if let Some(provider) = cowork_config::ProviderName::parse(provider_id) {
        return provider.spec().auth_methods.clone();
    }
    if let Some(specs) = s.provider_auth_method_specs.get(provider_id) {
        return specs
            .iter()
            .map(|spec| cowork_config::ProviderAuthMethod {
                id: spec.id.clone(),
                method_type: spec.method_type.clone(),
                label: spec
                    .label
                    .clone()
                    .unwrap_or_else(|| format_auth_method_label(&spec.id)),
                oauth_mode: spec.oauth_mode.clone(),
                fields: (!spec.fields.is_empty()).then(|| {
                    spec.fields
                        .iter()
                        .map(|fid| cowork_config::ProviderAuthMethodField {
                            id: fid.clone(),
                            label: format_auth_method_label(fid),
                            kind: if fid.to_ascii_lowercase().contains("secret")
                                || fid.to_ascii_lowercase().contains("key")
                                || fid.to_ascii_lowercase().contains("token")
                            {
                                "password".to_string()
                            } else {
                                "text".to_string()
                            },
                            required: None,
                            secret: None,
                            placeholder: None,
                        })
                        .collect()
                }),
            })
            .collect();
    }
    Vec::new()
}

fn safe_auth_link(raw: &str) -> Option<String> {
    let parsed = url::Url::parse(raw.trim()).ok()?;
    if matches!(parsed.scheme(), "https" | "http") && parsed.host_str().is_some() {
        Some(parsed.to_string())
    } else {
        None
    }
}

fn extract_challenge<'a>(s: &'a AppState, provider_id: &str) -> Option<&'a Value> {
    let val = s.last_auth_challenge.as_ref()?;
    let target = val.get("event").unwrap_or(val);
    let prov = target.get("provider").and_then(Value::as_str)?;
    (prov == provider_id).then_some(target)
}

fn existing_base_url(summary: &ProviderSummary) -> String {
    summary
        .config
        .get("baseUrl")
        .or_else(|| summary.config.get("baseURL"))
        .or_else(|| summary.config.get("apiBase"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn provider_subtitle(
    summary: &ProviderSummary,
    status: Option<&ProviderStatusSummary>,
    connected: bool,
) -> String {
    if let Some(st) = status {
        if let Some(detail) = st.detail.as_deref().filter(|d| !d.trim().is_empty()) {
            return detail.trim().to_string();
        }
        if let Some(mask) = st
            .saved_api_key_mask
            .as_deref()
            .filter(|m| !m.trim().is_empty())
        {
            return format!("Saved key: {mask}");
        }
        if let Some(method) = st.auth_method.as_deref().filter(|m| !m.trim().is_empty()) {
            return format!("Auth: {}", format_auth_method_label(method));
        }
    }
    if connected {
        let count = summary.models.len();
        format!(
            "{count} model{} available",
            if count == 1 { "" } else { "s" }
        )
    } else {
        "Click to configure credentials or sign in".to_string()
    }
}

fn managed_runtime_section(
    s: &AppState,
    provider_id: &str,
    active_ws_id: Option<&str>,
    k: &Kit,
    t: &ThemeTokens,
) -> El {
    let runtime_title = match provider_id {
        "codex-cli" => "Codex runtime",
        "claude-sdk" => "Claude SDK runtime",
        "antigravity-acp" => "Antigravity ACP runtime",
        _ => "Managed runtime",
    };
    let default_msg = match provider_id {
        "codex-cli" => "Check runtime status to inspect the Codex app-server installation.",
        "claude-sdk" => {
            "Cowork downloads and SHA-256 verifies the pinned Claude Code SDK runtime on demand."
        }
        "antigravity-acp" => {
            "Cowork downloads and SHA-512 verifies the pinned Antigravity ACP runtime on demand."
        }
        _ => "Check runtime status to inspect the managed binary installation.",
    };
    let raw = s
        .provider_runtime_status_by_id
        .get(provider_id)
        .or_else(|| {
            (provider_id == "codex-cli")
                .then_some(s.codex_app_server_status.as_ref())
                .flatten()
        })
        .map(|v| v.get("status").or_else(|| v.get("event")).unwrap_or(v));
    let source = raw
        .and_then(|v| v.get("source"))
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let source_label = match source {
        "system" => "System",
        "managed" => "Downloaded",
        "override" => "Override",
        _ => "Not downloaded",
    };
    let version = raw.and_then(|v| v.get("version")).and_then(Value::as_str);
    let pinned = raw
        .and_then(|v| v.get("pinnedVersion"))
        .and_then(Value::as_str);
    let msg = raw
        .and_then(|v| v.get("message"))
        .and_then(Value::as_str)
        .unwrap_or(default_msg);

    let mut card = col()
        .w_full()
        .gap(8.0)
        .pt(12.0)
        .border_sides([1.0, 0.0, 0.0, 0.0], t.border_muted)
        .child(
            row()
                .w_full()
                .justify_between()
                .items_center()
                .child(
                    text(runtime_title)
                        .font(k.ty.small_medium)
                        .color(t.text_muted),
                )
                .child(status_pill(source_label, StatusTone::Neutral, k, t)),
        );

    if let Some(ver) = version {
        card = card.child(
            text(format!("Installed version: {ver}"))
                .font(k.ty.small)
                .color(t.text_base),
        );
    }
    if let Some(req) = pinned {
        card = card.child(
            text(format!("Pinned version: {req}"))
                .font(k.ty.small)
                .color(t.text_muted),
        );
    }
    card = card.child(text(msg).font(k.ty.small).color(t.text_muted).wrap());

    if let Some(ws_id) = active_ws_id {
        let ws_check = ws_id.to_string();
        let ws_update = ws_id.to_string();
        let pid_check = provider_id.to_string();
        let pid_update = provider_id.to_string();
        card = card.child(
            row()
                .gap(8.0)
                .flex_wrap()
                .child(
                    Button::new("Check runtime")
                        .variant(ButtonVariant::Outline)
                        .icon(&icons::REFRESH_CCW)
                        .control_size(ControlSize::Small)
                        .on_press(move |s: &mut AppState| {
                            s.dispatch(Action::Settings(SettingsAction::CheckProviderRuntime {
                                workspace_id: ws_check.clone(),
                                provider: pid_check.clone(),
                            }));
                        })
                        .build(k),
                )
                .child(
                    Button::new("Download / update runtime")
                        .variant(ButtonVariant::Outline)
                        .icon(&icons::DOWNLOAD)
                        .control_size(ControlSize::Small)
                        .on_press(move |s: &mut AppState| {
                            s.dispatch(Action::Settings(SettingsAction::UpdateProviderRuntime {
                                workspace_id: ws_update.clone(),
                                provider: pid_update.clone(),
                                force: true,
                            }));
                        })
                        .build(k),
                ),
        );
    }

    card
}

fn lmstudio_section(
    s: &AppState,
    summary: &ProviderSummary,
    active_ws: Option<&WorkspaceRecord>,
    k: &Kit,
    t: &ThemeTokens,
) -> El {
    let lm_enabled = active_ws
        .and_then(|w| w.defaults.get("lmStudioEnabled"))
        .and_then(Value::as_bool)
        .unwrap_or(summary.configured);
    let can_mutate = active_ws.is_some();

    let mut col_el = col()
        .w_full()
        .gap(10.0)
        .pt(12.0)
        .border_sides([1.0, 0.0, 0.0, 0.0], t.border_muted)
        .child(
            row()
                .w_full()
                .justify_between()
                .items_center()
                .gap(12.0)
                .child(
                    col()
                        .grow(1.0)
                        .min_w(0.0)
                        .gap(2.0)
                        .child(
                            text("Enable LM Studio integration")
                                .font(k.ty.ui_medium)
                                .color(t.text_base),
                        )
                        .child(
                            text("Connect local LM Studio models into the chat model picker.")
                                .font(k.ty.small)
                                .color(t.text_muted)
                                .wrap(),
                        ),
                )
                .child({
                    let ws_toggle = active_ws.map(|w| w.id.clone());
                    mini_switch(
                        lm_enabled,
                        "Enable LM Studio",
                        !can_mutate,
                        move |s: &mut AppState| {
                            if let Some(ws_id) = &ws_toggle {
                                s.dispatch(Action::Settings(SettingsAction::SetLmStudioEnabled {
                                    workspace_id: ws_id.clone(),
                                    enabled: !lm_enabled,
                                }));
                            }
                        },
                        k,
                    )
                }),
        );

    let ws_check = active_ws.map(|w| w.id.clone());
    let ws_start = active_ws.map(|w| w.id.clone());
    col_el = col_el.child(
        row()
            .w_full()
            .items_end()
            .flex_wrap()
            .gap(8.0)
            .child(
                TextInput::new(&s.settings_ui.provider_lmstudio_url_edit)
                    .label("LM Studio base URL")
                    .placeholder("http://127.0.0.1:1234")
                    .width(Some(260.0))
                    .on_edit(|s: &mut AppState| &mut s.settings_ui.provider_lmstudio_url_edit)
                    .build(k),
            )
            .child(
                Button::new("Check server")
                    .variant(ButtonVariant::Outline)
                    .control_size(ControlSize::Regular)
                    .disabled(!can_mutate)
                    .on_press(move |s: &mut AppState| {
                        if let Some(ws_id) = &ws_check {
                            let url_txt = s
                                .settings_ui
                                .provider_lmstudio_url_edit
                                .text
                                .trim()
                                .to_string();
                            s.dispatch(Action::Settings(SettingsAction::CheckLmStudioStatus {
                                workspace_id: ws_id.clone(),
                                base_url: (!url_txt.is_empty()).then_some(url_txt),
                            }));
                        }
                    })
                    .build(k),
            )
            .child(
                Button::new("Start server")
                    .variant(ButtonVariant::Submit)
                    .control_size(ControlSize::Regular)
                    .disabled(!can_mutate)
                    .on_press(move |s: &mut AppState| {
                        if let Some(ws_id) = &ws_start {
                            let url_txt = s
                                .settings_ui
                                .provider_lmstudio_url_edit
                                .text
                                .trim()
                                .to_string();
                            s.dispatch(Action::Settings(SettingsAction::StartLmStudio {
                                workspace_id: ws_id.clone(),
                                base_url: (!url_txt.is_empty()).then_some(url_txt),
                            }));
                        }
                    })
                    .build(k),
            ),
    );

    if let Some(local_status) = s.lmstudio_local_status.as_ref() {
        let running = local_status
            .get("running")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let installed = local_status
            .get("installed")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let base_url = local_status
            .get("baseUrl")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|v| !v.is_empty());
        let message = local_status
            .get("message")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|v| !v.is_empty());
        let (pill_label, pill_tone, fallback_msg) = if running {
            (
                "Reachable",
                StatusTone::Success,
                match base_url {
                    Some(url) => format!("LM Studio server is reachable at {url}."),
                    None => "LM Studio server is reachable.".to_string(),
                },
            )
        } else if !installed {
            (
                "Not installed",
                StatusTone::Warning,
                "LM Studio CLI was not found on this machine.".to_string(),
            )
        } else {
            (
                "Offline",
                StatusTone::Danger,
                match base_url {
                    Some(url) => format!("LM Studio server is not reachable at {url}."),
                    None => "LM Studio server is not reachable.".to_string(),
                },
            )
        };
        let detail_text = message.map(str::to_string).unwrap_or(fallback_msg);
        col_el = col_el.child(
            row()
                .key("lmstudio-local-status-row")
                .w_full()
                .items_center()
                .flex_wrap()
                .gap(8.0)
                .px(10.0)
                .py(8.0)
                .radius(k.radius.md)
                .fill(t.elevated_bg)
                .child(status_pill(pill_label, pill_tone, k, t))
                .child(
                    text(detail_text)
                        .font(k.ty.small)
                        .color(if running { t.text_base } else { t.text_muted })
                        .wrap(),
                ),
        );
    }

    let ws_token = active_ws.map(|w| w.id.clone());
    let token_empty = s.settings_ui.api_key_edit.text.trim().is_empty();
    col_el = col_el.child(
        row()
            .w_full()
            .items_end()
            .flex_wrap()
            .gap(8.0)
            .child(
                TextInput::new(&s.settings_ui.api_key_edit)
                    .label("API token (optional)")
                    .placeholder("Optional Bearer token...")
                    .secure()
                    .revealed(s.settings_ui.api_key_revealed)
                    .width(Some(260.0))
                    .on_edit(|s: &mut AppState| &mut s.settings_ui.api_key_edit)
                    .build(k),
            )
            .child(
                Button::new("Save token")
                    .variant(ButtonVariant::Outline)
                    .icon(&icons::KEY)
                    .control_size(ControlSize::Regular)
                    .disabled(!can_mutate || token_empty)
                    .on_press(move |s: &mut AppState| {
                        if let Some(ws_id) = &ws_token {
                            let val = s.settings_ui.api_key_edit.text.trim().to_string();
                            if !val.is_empty() {
                                s.dispatch(Action::Settings(
                                    SettingsAction::SetProviderApiKeyForMethod {
                                        workspace_id: ws_id.clone(),
                                        provider: "lmstudio".to_string(),
                                        method_id: "api_key".to_string(),
                                        api_key: val,
                                    },
                                ));
                                s.settings_ui.api_key_edit = rune::TextEdit::new("");
                            }
                        }
                    })
                    .build(k),
            ),
    );

    if !summary.models.is_empty() {
        let mut models_list = col().w_full().gap(6.0);
        models_list = models_list.child(
            text("Discovered local models")
                .font(k.ty.small_medium)
                .color(t.text_muted),
        );
        for model in &summary.models {
            models_list = models_list.child(
                row()
                    .w_full()
                    .justify_between()
                    .items_center()
                    .gap(10.0)
                    .px(10.0)
                    .py(6.0)
                    .radius(k.radius.md)
                    .fill(t.elevated_bg)
                    .child(
                        col()
                            .grow(1.0)
                            .min_w(0.0)
                            .child(
                                text(model_display_name(model))
                                    .font(k.ty.ui)
                                    .color(t.text_base)
                                    .truncate(),
                            )
                            .child(
                                text(model.id.as_str())
                                    .font(t.code)
                                    .color(t.text_muted)
                                    .truncate(),
                            ),
                    ),
            );
        }
        col_el = col_el.child(models_list);
    }

    col_el
}

fn expanded_provider_body(
    s: &AppState,
    summary: &ProviderSummary,
    status: Option<&ProviderStatusSummary>,
    active_ws: Option<&WorkspaceRecord>,
    k: &Kit,
    t: &ThemeTokens,
) -> El {
    let active_ws_id = active_ws.map(|w| w.id.as_str());
    let can_mutate = active_ws_id.is_some();
    let auth_methods = resolved_auth_methods(s, &summary.id);
    let plain_api_methods: Vec<&cowork_config::ProviderAuthMethod> = auth_methods
        .iter()
        .filter(|m| m.method_type == "api" && m.fields.as_deref().is_none_or(<[_]>::is_empty))
        .collect();
    let structured_methods: Vec<&cowork_config::ProviderAuthMethod> = auth_methods
        .iter()
        .filter(|m| m.method_type == "api" && m.fields.as_deref().is_some_and(|f| !f.is_empty()))
        .collect();
    let oauth_methods: Vec<&cowork_config::ProviderAuthMethod> = auth_methods
        .iter()
        .filter(|m| m.method_type == "oauth")
        .collect();

    let mut body = col()
        .w_full()
        .px(16.0)
        .pb(16.0)
        .pt(12.0)
        .gap(14.0)
        .border_sides([1.0, 0.0, 0.0, 0.0], t.border_muted);

    if let Some(hint) = status.and_then(|st| extract_rate_limit_hint(st.rate_limits.as_ref())) {
        body = body.child(callout_banner(StatusTone::Neutral, hint, k, t));
    }

    if summary.id == "lmstudio" {
        body = body.child(lmstudio_section(s, summary, active_ws, k, t));
    } else {
        // 1. Plain API key methods (single or multi-method e.g. Google API key + Exa + Parallel)
        if !plain_api_methods.is_empty() {
            let active_method = if plain_api_methods.len() == 1 {
                plain_api_methods[0]
            } else {
                s.settings_ui
                    .selected_auth_method_id
                    .as_deref()
                    .and_then(|sel| plain_api_methods.iter().copied().find(|m| m.id == sel))
                    .unwrap_or(plain_api_methods[0])
            };
            let saved_mask = status
                .and_then(|st| {
                    st.saved_api_key_masks
                        .get(&active_method.id)
                        .map(String::as_str)
                        .or_else(|| {
                            (active_method.id == "api_key")
                                .then_some(st.saved_api_key_mask.as_deref())
                                .flatten()
                        })
                })
                .filter(|m| !m.trim().is_empty());

            let mut key_col = col().w_full().gap(6.0);
            if plain_api_methods.len() > 1 {
                let mut method_row = row().w_full().flex_wrap().gap(6.0);
                for method in &plain_api_methods {
                    let is_active = method.id == active_method.id;
                    let mid = method.id.clone();
                    method_row = method_row.child(
                        Button::new(method.label.as_str())
                            .variant(if is_active {
                                ButtonVariant::Submit
                            } else {
                                ButtonVariant::Outline
                            })
                            .control_size(ControlSize::Small)
                            .on_press(move |s: &mut AppState| {
                                s.settings_ui.selected_auth_method_id = Some(mid.clone());
                                s.settings_ui.api_key_edit = rune::TextEdit::new("");
                            })
                            .build(k),
                    );
                }
                key_col = key_col.child(method_row);
            }

            let mut label_row = row().w_full().justify_between().items_center().child(
                text(active_method.label.as_str())
                    .font(k.ty.small_medium)
                    .color(t.text_muted),
            );
            if let Some(mask) = saved_mask {
                label_row = label_row.child(status_pill(
                    format!("Saved ({mask})"),
                    StatusTone::Success,
                    k,
                    t,
                ));
            }
            key_col = key_col.child(label_row);

            let key_input = TextInput::new(&s.settings_ui.api_key_edit)
                .label(format!(
                    "{} {}",
                    provider_display_title(summary),
                    active_method.label
                ))
                .placeholder(if saved_mask.is_some() {
                    "Enter replacement API key..."
                } else {
                    "Paste your API key..."
                })
                .secure()
                .revealed(s.settings_ui.api_key_revealed)
                .width(Some(320.0))
                .on_edit(|s: &mut AppState| &mut s.settings_ui.api_key_edit)
                .build(k);

            let reveal_btn = IconButton::new(if s.settings_ui.api_key_revealed {
                &icons::EYE_OFF
            } else {
                &icons::EYE
            })
            .variant(IconButtonVariant::Ghost)
            .control_size(ControlSize::Regular)
            .label(if s.settings_ui.api_key_revealed {
                "Hide API key"
            } else {
                "Reveal API key"
            })
            .on_press(|s: &mut AppState| {
                s.settings_ui.api_key_revealed = !s.settings_ui.api_key_revealed;
            })
            .build(k);

            let ws_key = active_ws_id.map(str::to_owned);
            let prov_key = summary.id.clone();
            let method_key = active_method.id.clone();
            let key_empty = s.settings_ui.api_key_edit.text.trim().is_empty();
            key_col = key_col.child(
                row()
                    .w_full()
                    .items_center()
                    .flex_wrap()
                    .gap(8.0)
                    .child(key_input)
                    .child(reveal_btn)
                    .child(
                        Button::new("Save key")
                            .variant(ButtonVariant::Submit)
                            .icon(&icons::KEY)
                            .control_size(ControlSize::Regular)
                            .disabled(!can_mutate || key_empty)
                            .on_press(move |s: &mut AppState| {
                                if let Some(ws_id) = &ws_key {
                                    let val = s.settings_ui.api_key_edit.text.trim().to_string();
                                    if !val.is_empty() {
                                        s.dispatch(Action::Settings(
                                            SettingsAction::SetProviderApiKeyForMethod {
                                                workspace_id: ws_id.clone(),
                                                provider: prov_key.clone(),
                                                method_id: method_key.clone(),
                                                api_key: val,
                                            },
                                        ));
                                        s.settings_ui.api_key_edit = rune::TextEdit::new("");
                                    }
                                }
                            })
                            .build(k),
                    ),
            );
            body = body.child(key_col);
        }

        // 2. Structured credential methods (e.g. Amazon Bedrock `aws_default`, `aws_profile`, `aws_keys`, `api_key`)
        if !structured_methods.is_empty() {
            let active_method = s
                .settings_ui
                .selected_auth_method_id
                .as_deref()
                .and_then(|sel| structured_methods.iter().copied().find(|m| m.id == sel))
                .or_else(|| {
                    status
                        .and_then(|st| st.auth_method.as_deref())
                        .and_then(|cur| structured_methods.iter().copied().find(|m| m.id == cur))
                })
                .unwrap_or(structured_methods[0]);

            let mut cfg_col = col().w_full().gap(8.0);
            let mut method_row = row().w_full().flex_wrap().gap(6.0);
            for method in &structured_methods {
                let is_active = method.id == active_method.id;
                let mid = method.id.clone();
                method_row = method_row.child(
                    Button::new(method.label.as_str())
                        .variant(if is_active {
                            ButtonVariant::Submit
                        } else {
                            ButtonVariant::Outline
                        })
                        .control_size(ControlSize::Small)
                        .on_press(move |s: &mut AppState| {
                            s.settings_ui.selected_auth_method_id = Some(mid.clone());
                        })
                        .build(k),
                );
            }
            cfg_col = cfg_col.child(method_row);

            let empty_edit = rune::TextEdit::new("");
            let fields = active_method.fields.as_deref().unwrap_or(&[]);
            let mut missing_required = false;
            for field in fields {
                let state_key = format!("{}:{}:{}", summary.id, active_method.id, field.id);
                let current_edit = s
                    .settings_ui
                    .provider_config_field_edits
                    .get(&state_key)
                    .unwrap_or(&empty_edit);
                if field.required == Some(true) && current_edit.text.trim().is_empty() {
                    missing_required = true;
                }
                let saved_mask = status
                    .and_then(|st| st.saved_field_masks.get(&field.id))
                    .filter(|m| !m.trim().is_empty());
                let placeholder = saved_mask
                    .map(|m| format!("Saved ({m})"))
                    .or_else(|| field.placeholder.clone())
                    .unwrap_or_else(|| field.label.clone());
                let is_secret = field.secret == Some(true) || field.kind == "password";
                let key_for_edit = state_key.clone();
                let mut input = TextInput::new(current_edit)
                    .label(field.label.as_str())
                    .placeholder(placeholder)
                    .width(Some(320.0));
                if is_secret {
                    input = input.secure().revealed(s.settings_ui.api_key_revealed);
                }
                cfg_col = cfg_col.child(
                    input
                        .on_edit(move |s: &mut AppState| {
                            s.settings_ui
                                .provider_config_field_edits
                                .entry(key_for_edit.clone())
                                .or_insert_with(|| rune::TextEdit::new(""))
                        })
                        .build(k),
                );
            }

            let ws_cfg = active_ws_id.map(str::to_owned);
            let prov_cfg = summary.id.clone();
            let method_cfg = active_method.id.clone();
            let field_ids: Vec<String> = fields.iter().map(|f| f.id.clone()).collect();
            cfg_col = cfg_col.child(
                row().items_center().gap(8.0).child(
                    Button::new("Save credentials")
                        .variant(ButtonVariant::Submit)
                        .icon(&icons::KEY)
                        .control_size(ControlSize::Regular)
                        .disabled(!can_mutate || missing_required)
                        .on_press(move |s: &mut AppState| {
                            if let Some(ws_id) = &ws_cfg {
                                let mut values = std::collections::HashMap::new();
                                for fid in &field_ids {
                                    let sk = format!("{prov_cfg}:{method_cfg}:{fid}");
                                    if let Some(edit) =
                                        s.settings_ui.provider_config_field_edits.get(&sk)
                                    {
                                        let trimmed = edit.text.trim();
                                        if !trimmed.is_empty() {
                                            values.insert(fid.clone(), trimmed.to_string());
                                        }
                                    }
                                }
                                s.dispatch(Action::Settings(
                                    SettingsAction::SetProviderConfigForMethod {
                                        workspace_id: ws_id.clone(),
                                        provider: prov_cfg.clone(),
                                        method_id: method_cfg.clone(),
                                        values,
                                    },
                                ));
                            }
                        })
                        .build(k),
                ),
            );
            body = body.child(cfg_col);
        }

        // 3. OAuth methods (driven strictly by canonical `authMethods`; hide manual code input for `oauthMode: "auto"`)
        for oauth_method in oauth_methods {
            let ws_oauth = active_ws_id.map(str::to_owned);
            let prov_oauth = summary.id.clone();
            let is_auto = oauth_method.oauth_mode.as_deref() == Some("auto");

            let ws_cb = active_ws_id.map(str::to_owned);
            let prov_cb = summary.id.clone();
            let method_cb = oauth_method.id.clone();
            let code_empty = s.settings_ui.oauth_code_edit.text.trim().is_empty();

            let mut oauth_actions = row().w_full().items_center().flex_wrap().gap(8.0).child(
                Button::new(oauth_method.label.as_str())
                    .variant(ButtonVariant::Outline)
                    .control_size(ControlSize::Regular)
                    .disabled(!can_mutate)
                    .on_press(move |s: &mut AppState| {
                        if let Some(ws_id) = &ws_oauth {
                            s.dispatch(Action::Settings(SettingsAction::StartProviderAuth {
                                workspace_id: ws_id.clone(),
                                provider: prov_oauth.clone(),
                            }));
                        }
                    })
                    .build(k),
            );

            if !is_auto {
                oauth_actions = oauth_actions
                    .child(
                        TextInput::new(&s.settings_ui.oauth_code_edit)
                            .label("OAuth authorization code")
                            .placeholder("Code or callback URL...")
                            .width(Some(240.0))
                            .on_edit(|s: &mut AppState| &mut s.settings_ui.oauth_code_edit)
                            .build(k),
                    )
                    .child(
                        Button::new("Submit code")
                            .variant(ButtonVariant::Outline)
                            .control_size(ControlSize::Regular)
                            .disabled(!can_mutate || code_empty)
                            .on_press(move |s: &mut AppState| {
                                if let Some(ws_id) = &ws_cb {
                                    let code =
                                        s.settings_ui.oauth_code_edit.text.trim().to_string();
                                    if !code.is_empty() {
                                        s.dispatch(Action::Settings(
                                            SettingsAction::CompleteProviderAuthCallback {
                                                workspace_id: ws_id.clone(),
                                                provider: prov_cb.clone(),
                                                method_id: method_cb.clone(),
                                                callback_input: code,
                                            },
                                        ));
                                        s.settings_ui.oauth_code_edit = rune::TextEdit::new("");
                                    }
                                }
                            })
                            .build(k),
                    );
            }

            let mut oauth_col = col()
                .w_full()
                .gap(8.0)
                .pt(10.0)
                .border_sides([1.0, 0.0, 0.0, 0.0], t.border_muted)
                .child(
                    text("OAuth sign-in")
                        .font(k.ty.small_medium)
                        .color(t.text_muted),
                )
                .child(oauth_actions);

            if let Some(ch) = extract_challenge(s, &summary.id) {
                let instr = ch
                    .get("challenge")
                    .unwrap_or(ch)
                    .get("instructions")
                    .and_then(Value::as_str)
                    .unwrap_or(if is_auto {
                        "Complete authorization in your browser to finish signing in."
                    } else {
                        "Complete authorization in your browser, then paste the code above."
                    });
                oauth_col =
                    oauth_col.child(text(instr).font(k.ty.small).color(t.text_muted).wrap());
                if let Some(safe_url) = ch
                    .get("challenge")
                    .unwrap_or(ch)
                    .get("url")
                    .and_then(Value::as_str)
                    .and_then(safe_auth_link)
                {
                    oauth_col = oauth_col.child(
                        row().child(
                            Button::new("Open verification link")
                                .variant(ButtonVariant::Ghost)
                                .icon(&icons::EXTERNAL_LINK)
                                .control_size(ControlSize::Small)
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
            body = body.child(oauth_col);
        }
    }

    if matches!(
        summary.id.as_str(),
        "codex-cli" | "claude-sdk" | "antigravity-acp"
    ) {
        body = body.child(managed_runtime_section(s, &summary.id, active_ws_id, k, t));
    }

    if !summary.models.is_empty() || manage_models_dialog::can_add_custom_model(&summary.id) {
        let (preview, hidden_count) = provider_model_preview(&summary.models);
        let enabled_count = summary.models.iter().filter(|m| m.enabled).count();
        let pid_manage = summary.id.clone();

        let mut models_block = col()
            .w_full()
            .gap(8.0)
            .pt(10.0)
            .border_sides([1.0, 0.0, 0.0, 0.0], t.border_muted)
            .child(
                row()
                    .w_full()
                    .justify_between()
                    .items_center()
                    .gap(8.0)
                    .child(
                        text("Available models")
                            .font(k.ty.small_medium)
                            .color(t.text_muted),
                    )
                    .child(
                        row()
                            .items_center()
                            .gap(8.0)
                            .child(
                                text(if summary.models.is_empty() {
                                    "No discovered models".to_string()
                                } else {
                                    format!("{enabled_count} of {} enabled", summary.models.len())
                                })
                                .font(k.ty.small)
                                .color(t.text_muted),
                            )
                            .child(
                                Button::new("Manage models")
                                    .variant(ButtonVariant::Outline)
                                    .icon(&icons::SLIDERS_HORIZONTAL)
                                    .control_size(ControlSize::Small)
                                    .on_press(move |s: &mut AppState| {
                                        s.settings_ui.manage_models_provider_id =
                                            Some(pid_manage.clone());
                                        if s.settings_ui.manage_models_for.as_deref()
                                            != Some(pid_manage.as_str())
                                        {
                                            s.settings_ui.manage_models_for =
                                                Some(pid_manage.clone());
                                            s.settings_ui.models_search_edit =
                                                rune::TextEdit::new("");
                                            s.settings_ui.custom_model_id_edit =
                                                rune::TextEdit::new("");
                                            s.settings_ui.custom_model_name_edit =
                                                rune::TextEdit::new("");
                                        }
                                    })
                                    .build(k),
                            ),
                    ),
            );

        if !preview.is_empty() {
            let mut pills = row().w_full().flex_wrap().gap(6.0);
            for label in preview {
                pills = pills.child(status_pill(label, StatusTone::Neutral, k, t));
            }
            if hidden_count > 0 {
                pills = pills.child(status_pill(
                    format!("+{hidden_count} more"),
                    StatusTone::Neutral,
                    k,
                    t,
                ));
            }
            models_block = models_block.child(pills);
        }
        body = body.child(models_block);
    }

    if is_provider_connected(summary, status, active_ws) {
        let pid_logout = summary.id.clone();
        body = body.child(
            row()
                .w_full()
                .justify_end()
                .pt(8.0)
                .border_sides([1.0, 0.0, 0.0, 0.0], t.border_muted)
                .child(
                    Button::new("Disconnect provider")
                        .variant(ButtonVariant::Danger)
                        .control_size(ControlSize::Small)
                        .disabled(!can_mutate)
                        .on_press(move |s: &mut AppState| {
                            s.settings_ui.provider_logout_confirm_id = Some(pid_logout.clone());
                        })
                        .build(k),
                ),
        );
    }

    body
}

#[allow(clippy::too_many_arguments)]
fn provider_card(
    s: &AppState,
    summary: &ProviderSummary,
    status: Option<&ProviderStatusSummary>,
    active_ws: Option<&WorkspaceRecord>,
    theme_sig: u64,
    k: &Kit,
    t: &ThemeTokens,
) -> El {
    let expanded = s.settings_ui.expanded_provider_id.as_deref() == Some(summary.id.as_str());
    let connected = is_provider_connected(summary, status, active_ws);
    let (badge_label, badge_tone) = provider_status_badge(summary, status);
    let title = provider_display_title(summary);
    let subtitle = provider_subtitle(summary, status, connected);

    let build_header_row = || {
        let pid_toggle = summary.id.clone();
        let header = row()
            .key(format!("provider-toggle-{}", summary.id))
            .w_full()
            .justify_between()
            .items_center()
            .gap(12.0)
            .px(16.0)
            .py(12.0)
            .focusable(true)
            .role("button")
            .expanded(expanded)
            .label(format!("Toggle {title} settings"))
            .on_press(move |s: &mut AppState| {
                if s.settings_ui.expanded_provider_id.as_deref() == Some(pid_toggle.as_str()) {
                    s.settings_ui.expanded_provider_id = None;
                } else {
                    s.settings_ui.expanded_provider_id = Some(pid_toggle.clone());
                    if s.settings_ui.provider_draft_for.as_deref() != Some(pid_toggle.as_str()) {
                        let initial_base = s
                            .provider_catalog
                            .iter()
                            .find(|entry| entry.id == pid_toggle)
                            .map(existing_base_url)
                            .unwrap_or_default();
                        s.settings_ui.provider_draft_for = Some(pid_toggle.clone());
                        s.settings_ui.api_key_edit = rune::TextEdit::new("");
                        s.settings_ui.api_key_revealed = false;
                        s.settings_ui.base_url_edit = rune::TextEdit::new(initial_base.as_str());
                        s.settings_ui.oauth_code_edit = rune::TextEdit::new("");
                    }
                }
            })
            .child(
                row()
                    .grow(1.0)
                    .min_w(0.0)
                    .items_center()
                    .gap(12.0)
                    .child(entity_icon(s, None, title, EntityIconSize::Md, k, t))
                    .child(
                        col()
                            .grow(1.0)
                            .min_w(0.0)
                            .gap(2.0)
                            .child(
                                text(title)
                                    .font(k.ty.ui_medium)
                                    .color(t.text_base)
                                    .truncate(),
                            )
                            .child(
                                text(subtitle.as_str())
                                    .font(k.ty.small)
                                    .color(t.text_muted)
                                    .truncate(),
                            ),
                    ),
            )
            .child(
                row()
                    .shrink()
                    .items_center()
                    .gap(8.0)
                    .child(status_pill(badge_label, badge_tone, k, t))
                    .child(
                        disclosure_chevron(expanded, 16.0, k.motion.disclosure).color(t.text_muted),
                    ),
            );
        k.interactive_with(header, t.hover, t.pressed)
    };

    if !expanded {
        let mut h = DefaultHasher::new();
        (
            theme_sig,
            summary.id.as_str(),
            title,
            subtitle.as_str(),
            badge_label,
            badge_tone as u8,
        )
            .hash(&mut h);
        let key = format!("provider-card-{}", summary.id);
        return memo(key.as_str(), h.finish(), || {
            col().w_full().child(build_header_row())
        });
    }

    col()
        .key(format!("provider-card-{}", summary.id))
        .w_full()
        .fill(t.elevated_bg)
        .child(build_header_row())
        .child(expanded_provider_body(s, summary, status, active_ws, k, t))
}

/// Renders the Models & Providers settings page.
pub fn view(s: &AppState, k: &Kit, t: &ThemeTokens) -> PageContent {
    let targets = management_targets(s);
    let active_ws_id = find_management_target(s, &targets, s.resolve_management_workspace_id())
        .map(|entry| entry.id.as_str());
    let active_ws: Option<&WorkspaceRecord> =
        active_ws_id.and_then(|id| s.workspaces.iter().find(|w| w.id == id));
    let statuses: &[ProviderStatusSummary] = active_ws_id
        .and_then(|id| s.workspace_runtime_by_id.get(id))
        .map(|rt| rt.provider_statuses.as_slice())
        .unwrap_or(&[]);

    let status_map: HashMap<&str, &ProviderStatusSummary> = statuses
        .iter()
        .map(|st| (st.provider.as_str(), st))
        .collect();

    let raw_catalog: &[ProviderSummary] = if s.provider_catalog.is_empty() {
        fallback_providers_slice()
    } else {
        &s.provider_catalog
    };
    let visible_catalog: Vec<&ProviderSummary> = if s.provider_catalog.is_empty() {
        raw_catalog.iter().collect()
    } else {
        raw_catalog
            .iter()
            .filter(|entry| is_user_facing_provider(&entry.id))
            .collect()
    };

    let filtered = sort_and_filter_provider_refs(
        visible_catalog.iter().copied(),
        &status_map,
        &s.settings_ui.provider_search_edit.text,
    );
    let mut connected_list = Vec::new();
    let mut available_list = Vec::new();
    for entry in filtered {
        let status = status_map.get(entry.id.as_str()).copied();
        if is_provider_connected(entry, status, active_ws) {
            connected_list.push((entry, status));
        } else {
            available_list.push((entry, status));
        }
    }

    let mut disconnected_all: Vec<&ProviderSummary> = Vec::new();
    let mut connected_total_count: usize = 0;
    for &p in &visible_catalog {
        let st = status_map.get(p.id.as_str()).copied();
        if is_provider_connected(p, st, active_ws) {
            connected_total_count += 1;
        } else {
            disconnected_all.push(p);
        }
    }

    let mut header_actions = Vec::new();
    if let Some(ws_id) = active_ws_id {
        let ws_refresh = ws_id.to_string();
        header_actions.push(
            Button::new("Refresh status")
                .variant(ButtonVariant::Outline)
                .icon(&icons::REFRESH_CCW)
                .control_size(ControlSize::Regular)
                .on_press(move |s: &mut AppState| {
                    s.dispatch(Action::Settings(SettingsAction::RefreshProviderCatalog {
                        workspace_id: ws_refresh.clone(),
                    }));
                    s.dispatch(Action::Settings(SettingsAction::CheckCodexAppServer {
                        workspace_id: ws_refresh.clone(),
                    }));
                })
                .build(k),
        );
    }

    if !disconnected_all.is_empty() {
        header_actions.push(
            Button::new("New provider")
                .variant(ButtonVariant::Submit)
                .icon(&icons::PLUS)
                .control_size(ControlSize::Regular)
                .on_press(|s: &mut AppState| {
                    s.settings_ui.provider_new_dialog_open = true;
                })
                .build(k),
        );
    }

    let mut blocks: Vec<El> = Vec::new();
    if active_ws.is_none() {
        blocks.push(callout_banner(
            StatusTone::Warning,
            "Open or add a workspace first to connect AI providers and manage API keys.",
            k,
            t,
        ));
    }
    if let Some(err) = s.settings_mutation_error.as_deref() {
        blocks.push(callout_banner(StatusTone::Danger, err, k, t));
    }

    let search_bar = row()
        .w_full()
        .items_center()
        .justify_between()
        .flex_wrap()
        .gap(10.0)
        .px(16.0)
        .py(12.0)
        .child(search_input(
            &s.settings_ui.provider_search_edit,
            "Filter providers and models",
            "Search providers or model IDs...",
            Some(320.0),
            |s: &mut AppState| &mut s.settings_ui.provider_search_edit,
            |s: &mut AppState, _tx| {
                s.settings_ui.provider_search_edit = rune::TextEdit::new("");
            },
            k,
        ))
        .child(status_pill(
            format!(
                "{connected_total_count} of {} connected",
                visible_catalog.len()
            ),
            if connected_total_count == 0 {
                StatusTone::Neutral
            } else {
                StatusTone::Success
            },
            k,
            t,
        ));

    let mut connected_section = Section::new()
        .title("Connected providers")
        .description("Accounts and API keys active for chat and agent turns.")
        .child(search_bar);

    let theme_sig = theme_memo_sig(s, t);
    if connected_list.is_empty() {
        let query_empty = s.settings_ui.provider_search_edit.text.trim().is_empty();
        let mut empty = EmptyState::new(if query_empty {
            "No providers connected yet"
        } else {
            "No matching connected providers"
        })
        .icon(&icons::BOT)
        .description(if query_empty {
            "Connect a provider below or choose New provider to configure credentials."
        } else {
            "Try another provider or model search query."
        });
        if query_empty && !disconnected_all.is_empty() {
            empty = empty.action(
                Button::new("New provider")
                    .variant(ButtonVariant::Submit)
                    .icon(&icons::PLUS)
                    .control_size(ControlSize::Regular)
                    .on_press(|s: &mut AppState| {
                        s.settings_ui.provider_new_dialog_open = true;
                    })
                    .build(k),
            );
        }
        connected_section = connected_section.child(empty.build(k, t));
    } else {
        for (entry, status) in connected_list {
            connected_section = connected_section
                .child(provider_card(s, entry, status, active_ws, theme_sig, k, t));
        }
    }
    blocks.push(connected_section.build(k, t));

    if !available_list.is_empty() {
        let mut available_section = Section::new()
            .title("Available providers")
            .description("Expand any provider to enter an API key, OAuth flow, or local runtime.");
        for (entry, status) in available_list {
            available_section = available_section
                .child(provider_card(s, entry, status, active_ws, theme_sig, k, t));
        }
        blocks.push(available_section.build(k, t));
    }

    let mut overlays = Vec::new();

    if s.settings_ui.provider_new_dialog_open {
        let mut picker_list = col().w_full().gap(6.0);
        if disconnected_all.is_empty() {
            picker_list = picker_list.child(
                text("All providers in the catalog are already connected.")
                    .font(k.ty.ui)
                    .color(t.text_muted),
            );
        } else {
            for entry in &disconnected_all {
                let title = provider_display_title(entry).to_string();
                let pid = entry.id.clone();
                let init_base = existing_base_url(entry);
                picker_list = picker_list.child(
                    row()
                        .w_full()
                        .justify_between()
                        .items_center()
                        .gap(10.0)
                        .px(12.0)
                        .py(8.0)
                        .radius(k.radius.lg)
                        .fill(t.panel_bg)
                        .border(1.0, t.border_muted)
                        .child(
                            row()
                                .items_center()
                                .gap(10.0)
                                .child(entity_icon(s, None, &title, EntityIconSize::Sm, k, t))
                                .child(text(&title).font(k.ty.ui_medium).color(t.text_base)),
                        )
                        .child(
                            Button::new("Configure")
                                .variant(ButtonVariant::Outline)
                                .control_size(ControlSize::Small)
                                .on_press(move |s: &mut AppState| {
                                    s.settings_ui.provider_new_dialog_open = false;
                                    s.settings_ui.expanded_provider_id = Some(pid.clone());
                                    if s.settings_ui.provider_draft_for.as_deref()
                                        != Some(pid.as_str())
                                    {
                                        s.settings_ui.provider_draft_for = Some(pid.clone());
                                        s.settings_ui.api_key_edit = rune::TextEdit::new("");
                                        s.settings_ui.api_key_revealed = false;
                                        s.settings_ui.base_url_edit =
                                            rune::TextEdit::new(init_base.as_str());
                                        s.settings_ui.oauth_code_edit = rune::TextEdit::new("");
                                    }
                                })
                                .build(k),
                        ),
                );
            }
        }

        let scroll_picker = k.scroll_bar(
            col()
                .w_full()
                .min_h(0.0)
                .scroll(ScrollSpec {
                    stick_bottom: false,
                })
                .child(picker_list),
        );

        Dialog::new("new-provider-dialog", "New provider")
            .open(true)
            .width(500.0)
            .fit()
            .on_close(|s: &mut AppState| {
                s.settings_ui.provider_new_dialog_open = false;
            })
            .child(
                col()
                    .w_full()
                    .min_w(0.0)
                    .px(16.0)
                    .pb(16.0)
                    .gap(12.0)
                    .child(
                        text("Choose a provider to expand and configure credentials or OAuth sign-in.")
                            .font(k.ty.ui)
                            .color(t.text_muted)
                            .wrap(),
                    )
                    .child(el().w_full().h(260.0).child(scroll_picker)),
            )
            .build(k, &mut overlays);
    }

    manage_models_dialog::push_overlay(s, active_ws_id, raw_catalog, k, t, &mut overlays);

    if let Some(logout_id) = s.settings_ui.provider_logout_confirm_id.as_deref() {
        let ws_logout = active_ws_id.map(str::to_owned);
        confirm_dialog(
            ConfirmDialogSpec {
                key: "provider-logout-confirm",
                open: true,
                title: "Disconnect provider?",
                description: format!(
                    "Removes stored authentication credentials for {logout_id} in this workspace."
                ),
                confirm_label: "Disconnect",
                danger: true,
            },
            |s| {
                s.settings_ui.provider_logout_confirm_id = None;
            },
            move |s| {
                if let (Some(ws_id), Some(pid)) =
                    (&ws_logout, s.settings_ui.provider_logout_confirm_id.take())
                {
                    s.dispatch(Action::Settings(SettingsAction::LogoutProvider {
                        workspace_id: ws_id.clone(),
                        provider: pid,
                    }));
                }
            },
            k,
            &mut overlays,
        );
    }

    blocks.extend(
        crate::views::settings::workspaces::models_defaults_sections_with_status_map(
            s,
            active_ws_id,
            &status_map,
            k,
            t,
            &mut overlays,
        ),
    );

    PageContent::simple(settings_page(blocks))
        .with_header_actions(header_actions)
        .with_overlays(overlays)
}
