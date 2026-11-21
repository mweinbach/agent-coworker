//! Manage Models dialog (`apps/desktop/src/ui/settings/pages/ManageModelsDialog.tsx`).

use rune::{El, ScrollSpec, col, el, row, text};
use rune_kit::{
    Button, ButtonVariant, Checkbox, ControlSize, Dialog, IconButton, IconButtonVariant, Kit,
    TextInput,
};

use crate::actions::{Action, SettingsAction};
use crate::state::{AppState, ProviderModelSummary, ProviderSummary};
use crate::theme::ThemeTokens;
use crate::views::settings::icons;
use crate::views::settings::primitives::{StatusTone, search_input, status_pill};
use crate::views::settings::providers_utils::model_display_name;

/// Filters a provider's model list by case-insensitive ID or display name query.
pub fn filter_provider_models<'a>(
    models: &'a [ProviderModelSummary],
    query: &str,
) -> Vec<&'a ProviderModelSummary> {
    let needle = query.trim().to_ascii_lowercase();
    if needle.is_empty() {
        return models.iter().collect();
    }
    models
        .iter()
        .filter(|m| {
            m.id.to_ascii_lowercase().contains(&needle)
                || m.name.to_ascii_lowercase().contains(&needle)
        })
        .collect()
}

/// Returns whether a provider supports manually adding custom model identifiers.
pub fn can_add_custom_model(provider_id: &str) -> bool {
    !matches!(
        provider_id.trim().to_ascii_lowercase().as_str(),
        "codex-cli" | "openai-codex"
    )
}

/// Builds and pushes the Manage Models modal into `overlays` when open.
pub fn push_overlay(
    s: &AppState,
    active_ws_id: Option<&str>,
    catalog: &[ProviderSummary],
    k: &Kit,
    t: &ThemeTokens,
    overlays: &mut Vec<El>,
) {
    let Some(provider_id) = s.settings_ui.manage_models_provider_id.as_deref() else {
        return;
    };

    let summary = catalog.iter().find(|entry| entry.id == provider_id);
    let provider_label = summary
        .map(|entry| {
            if entry.name.trim().is_empty() {
                entry.id.as_str()
            } else {
                entry.name.trim()
            }
        })
        .unwrap_or(provider_id);

    let all_models: &[ProviderModelSummary] = summary.map(|p| p.models.as_slice()).unwrap_or(&[]);
    let enabled_count = all_models.iter().filter(|m| m.enabled).count();
    let visible_models = filter_provider_models(all_models, &s.settings_ui.models_search_edit.text);
    let can_mutate = active_ws_id.is_some();

    let mut search_bar = row()
        .w_full()
        .items_center()
        .flex_wrap()
        .gap(8.0)
        .child(search_input(
            &s.settings_ui.models_search_edit,
            format!("Search {provider_label} models"),
            "Search models...",
            Some(240.0),
            |s: &mut AppState| &mut s.settings_ui.models_search_edit,
            |s: &mut AppState, _tx| {
                s.settings_ui.models_search_edit = rune::TextEdit::new("");
            },
            k,
        ));

    if let Some(ws_id) = active_ws_id {
        let enable_ids: Vec<String> = visible_models
            .iter()
            .filter(|m| !m.enabled)
            .map(|m| m.id.clone())
            .collect();
        let disable_ids: Vec<String> = visible_models
            .iter()
            .filter(|m| m.enabled)
            .map(|m| m.id.clone())
            .collect();

        let ws_en = ws_id.to_string();
        let prov_en = provider_id.to_string();
        search_bar = search_bar.child(
            Button::new("Enable all")
                .variant(ButtonVariant::Outline)
                .control_size(ControlSize::Small)
                .disabled(enable_ids.is_empty())
                .on_press(move |s: &mut AppState| {
                    for model in &enable_ids {
                        s.dispatch(Action::Settings(SettingsAction::SetModelEnabled {
                            workspace_id: ws_en.clone(),
                            provider: prov_en.clone(),
                            model: model.clone(),
                            enabled: true,
                        }));
                    }
                })
                .build(k),
        );

        let ws_dis = ws_id.to_string();
        let prov_dis = provider_id.to_string();
        search_bar = search_bar.child(
            Button::new("Disable all")
                .variant(ButtonVariant::Outline)
                .control_size(ControlSize::Small)
                .disabled(disable_ids.is_empty())
                .on_press(move |s: &mut AppState| {
                    for model in &disable_ids {
                        s.dispatch(Action::Settings(SettingsAction::SetModelEnabled {
                            workspace_id: ws_dis.clone(),
                            provider: prov_dis.clone(),
                            model: model.clone(),
                            enabled: false,
                        }));
                    }
                })
                .build(k),
        );

        let ws_reset = ws_id.to_string();
        let prov_reset = provider_id.to_string();
        search_bar = search_bar.child(
            Button::new("Reset defaults")
                .variant(ButtonVariant::Ghost)
                .control_size(ControlSize::Small)
                .on_press(move |s: &mut AppState| {
                    s.dispatch(Action::Settings(
                        SettingsAction::ResetProviderModelPreferences {
                            workspace_id: ws_reset.clone(),
                            provider: prov_reset.clone(),
                        },
                    ));
                })
                .build(k),
        );
    }

    let mut list_col = col().w_full().gap(4.0);
    if visible_models.is_empty() {
        let empty_msg = if all_models.is_empty() {
            if can_add_custom_model(provider_id) {
                "No models discovered yet. Add a custom model ID below to use one right away."
            } else {
                "No models discovered yet for this provider."
            }
        } else {
            "No models match your search."
        };
        list_col = list_col.child(
            el().w_full()
                .py(24.0)
                .center()
                .child(text(empty_msg).font(k.ty.small).color(t.text_muted).wrap()),
        );
    } else {
        for model in visible_models {
            let ws_toggle = active_ws_id.map(str::to_owned);
            let prov_toggle = provider_id.to_string();
            let mid_toggle = model.id.clone();
            let next_enabled = !model.enabled;

            let label_text = model_display_name(model);
            let mut label_col = col().grow(1.0).min_w(0.0).gap(1.0).child(
                text(label_text)
                    .font(k.ty.ui_medium)
                    .color(t.text_base)
                    .truncate(),
            );
            if label_text != model.id {
                label_col = label_col.child(
                    text(model.id.as_str())
                        .font(t.code)
                        .color(t.text_muted)
                        .truncate(),
                );
            }

            let mut model_row = row()
                .key(format!("manage-model-row-{}", model.id))
                .w_full()
                .items_center()
                .justify_between()
                .gap(10.0)
                .px(10.0)
                .py(7.0)
                .radius(k.radius.md)
                .hover(t.hover)
                .child(
                    Checkbox::new(model.enabled)
                        .label(format!(
                            "{} {}",
                            if model.enabled { "Disable" } else { "Enable" },
                            model.id
                        ))
                        .hide_label()
                        .disabled(!can_mutate)
                        .on_toggle(move |s: &mut AppState| {
                            if let Some(ws_id) = &ws_toggle {
                                s.dispatch(Action::Settings(SettingsAction::SetModelEnabled {
                                    workspace_id: ws_id.clone(),
                                    provider: prov_toggle.clone(),
                                    model: mid_toggle.clone(),
                                    enabled: next_enabled,
                                }));
                            }
                        })
                        .build(k),
                )
                .child(label_col);

            if model.supports_reasoning {
                model_row = model_row.child(status_pill("Reasoning", StatusTone::Neutral, k, t));
            }
            if model.custom {
                model_row = model_row.child(status_pill("Custom", StatusTone::Success, k, t));
                if let Some(ws_del) = active_ws_id.map(str::to_owned) {
                    let prov_del = provider_id.to_string();
                    let mid_del = model.id.clone();
                    model_row = model_row.child(
                        IconButton::new(&icons::TRASH)
                            .variant(IconButtonVariant::Ghost)
                            .control_size(ControlSize::Small)
                            .label(format!("Remove custom model {}", model.id))
                            .on_press(move |s: &mut AppState| {
                                s.dispatch(Action::Settings(SettingsAction::DeleteCustomModel {
                                    workspace_id: ws_del.clone(),
                                    provider: prov_del.clone(),
                                    model_id: mid_del.clone(),
                                }));
                            })
                            .build(k),
                    );
                }
            }

            list_col = list_col.child(model_row);
        }
    }

    let scroll_list = k.scroll_bar(
        col()
            .w_full()
            .min_h(0.0)
            .scroll(ScrollSpec {
                stick_bottom: false,
            })
            .child(list_col),
    );

    let header_summary = text(format!(
        "{enabled_count} of {} enabled. Enabled models appear in model pickers; disabling never blocks a model that is already selected.",
        all_models.len()
    ))
    .font(k.ty.ui)
    .color(t.text_muted)
    .wrap();

    let mut body = col()
        .w_full()
        .min_w(0.0)
        .px(16.0)
        .pb(16.0)
        .gap(12.0)
        .child(header_summary)
        .child(search_bar)
        .child(
            el().w_full()
                .h(280.0)
                .radius(k.radius.lg)
                .fill(t.panel_bg)
                .border(1.0, t.border_muted)
                .px(6.0)
                .py(6.0)
                .child(scroll_list),
        );

    if can_add_custom_model(provider_id) {
        let custom_id = s.settings_ui.custom_model_id_edit.text.trim().to_string();
        let add_disabled = !can_mutate || custom_id.is_empty();
        let ws_add = active_ws_id.map(str::to_owned);
        let prov_add = provider_id.to_string();

        body = body.child(
            row()
                .w_full()
                .items_center()
                .flex_wrap()
                .gap(8.0)
                .child(
                    TextInput::new(&s.settings_ui.custom_model_id_edit)
                        .label("Custom model ID")
                        .placeholder("Add custom model ID (e.g. gpt-4.1-mini)")
                        .width(Some(300.0))
                        .on_edit(|s: &mut AppState| &mut s.settings_ui.custom_model_id_edit)
                        .build(k),
                )
                .child(
                    Button::new("Add model")
                        .variant(ButtonVariant::Outline)
                        .icon(&icons::PLUS)
                        .control_size(ControlSize::Regular)
                        .disabled(add_disabled)
                        .on_press(move |s: &mut AppState| {
                            if let Some(ws_id) = &ws_add {
                                let mid =
                                    s.settings_ui.custom_model_id_edit.text.trim().to_string();
                                if !mid.is_empty() {
                                    s.dispatch(Action::Settings(SettingsAction::AddCustomModel {
                                        workspace_id: ws_id.clone(),
                                        provider: prov_add.clone(),
                                        model_id: mid,
                                        display_name: None,
                                    }));
                                    s.settings_ui.custom_model_id_edit = rune::TextEdit::new("");
                                    s.settings_ui.custom_model_name_edit = rune::TextEdit::new("");
                                }
                            }
                        })
                        .build(k),
                ),
        );
    }

    body = body.child(
        row().w_full().justify_end().child(
            Button::new("Done")
                .variant(ButtonVariant::Contrast)
                .control_size(ControlSize::Regular)
                .on_press(|s: &mut AppState| {
                    s.settings_ui.manage_models_provider_id = None;
                })
                .build(k),
        ),
    );

    Dialog::new(
        "manage-models-dialog",
        format!("Manage {provider_label} models"),
    )
    .open(true)
    .width(640.0)
    .fit()
    .on_close(|s: &mut AppState| {
        s.settings_ui.manage_models_provider_id = None;
    })
    .child(body)
    .build(k, overlays);
}
