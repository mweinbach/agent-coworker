//! Subagents settings page & profile editor dialog (`SettingsPageId::Subagents`).
//!
//! Ported from `apps/desktop/src/ui/settings/pages/SubagentsPage.tsx`.

use std::collections::HashSet;

use rune::{El, ScrollSpec, TextEdit, col, el, row, text};
use rune_kit::{
    Button, ButtonVariant, Checkbox, ControlSize, Dialog, Kit, Select, SelectAppearance, Switch,
    TextArea, TextInput,
};
use serde_json::{Value, json};

use crate::actions::{Action, SettingsAction};
use crate::state::{AppState, SubagentProfile, WorkspaceRecord};
use crate::theme::ThemeTokens;
use crate::views::settings::icons;
use crate::views::settings::primitives::{
    ConfirmDialogSpec, EmptyState, EntityIconSize, Section, SettingsRow, StatusTone,
    confirm_dialog, entity_icon, settings_page, status_pill,
};
use crate::views::settings::providers::is_provider_connected;
use crate::views::settings::providers_utils::{model_display_name, sort_and_filter_providers};
use crate::views::settings::shell::PageContent;

/// Minimum, maximum, and default workflow concurrency fan-out.
pub const WORKFLOW_CONCURRENCY_MIN: u64 = 1;
pub const WORKFLOW_CONCURRENCY_MAX: u64 = 16;
pub const WORKFLOW_CONCURRENCY_DEFAULT: u64 = 12;

/// Built-in tools configurable for a subagent profile.
pub const BUILT_IN_TOOLS: &[&str] = &[
    "bash",
    "read",
    "write",
    "edit",
    "glob",
    "grep",
    "webSearch",
    "webFetch",
    "skill",
    "memory",
    "todoWrite",
];

/// Supported template base roles and display labels.
pub const ROLE_OPTIONS: &[(&str, &str)] = &[
    ("default", "Default"),
    ("explorer", "Explorer"),
    ("research", "Research"),
    ("worker", "Worker"),
    ("reviewer", "Reviewer"),
];

const REASONING_EFFORTS: &[&str] = &["low", "medium", "high", "xhigh"];

/// Returns default built-in tools for a base role template.
pub fn role_default_tools(role: &str) -> Vec<&'static str> {
    match role {
        "explorer" => vec!["bash", "read", "glob", "grep"],
        "research" => vec!["read", "webSearch", "webFetch"],
        "reviewer" => vec!["bash", "read", "glob", "grep"],
        _ => BUILT_IN_TOOLS.to_vec(),
    }
}

/// Converts a display name into a sanitized lowercase kebab-case profile id.
pub fn profile_id_from_name(value: &str) -> String {
    let mut out = String::with_capacity(value.len().min(80));
    let mut prev_dash = true;
    for ch in value.trim().chars() {
        let lower = ch.to_ascii_lowercase();
        if lower.is_ascii_alphanumeric() {
            out.push(lower);
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
        if out.len() >= 80 {
            break;
        }
    }
    out.trim_matches('-').to_string()
}

/// Clamps user concurrency text into `1..=16`, falling back to `fallback`.
pub fn clamp_workflow_concurrency(raw: &str, fallback: u64) -> u64 {
    raw.trim()
        .parse::<u64>()
        .ok()
        .map(|val| val.clamp(WORKFLOW_CONCURRENCY_MIN, WORKFLOW_CONCURRENCY_MAX))
        .unwrap_or_else(|| fallback.clamp(WORKFLOW_CONCURRENCY_MIN, WORKFLOW_CONCURRENCY_MAX))
}

/// Resolves the non-archived workspaces eligible for workspace-scoped subagents.
pub fn subagent_workspace_choices(s: &AppState) -> Vec<&WorkspaceRecord> {
    let projects: Vec<&WorkspaceRecord> = s
        .workspaces
        .iter()
        .filter(|w| !w.archived && !w.one_off_chat)
        .collect();
    if !projects.is_empty() {
        return projects;
    }
    s.workspaces.iter().filter(|w| !w.archived).collect()
}

/// Resolves the active workspace for subagent profile operations.
pub fn resolve_subagent_workspace(s: &AppState) -> Option<&WorkspaceRecord> {
    let choices = subagent_workspace_choices(s);
    if let Some(pref) = s.settings_ui.subagent_workspace_id.as_deref()
        && let Some(ws) = choices.iter().copied().find(|w| w.id == pref)
    {
        return Some(ws);
    }
    if let Some(selected) = s.active_workspace_id.as_deref()
        && let Some(ws) = choices.iter().copied().find(|w| w.id == selected)
    {
        return Some(ws);
    }
    choices.into_iter().next()
}

/// Resolves saved workflow fan-out concurrency for a workspace.
pub fn resolve_workflow_concurrency(ws: &WorkspaceRecord) -> u64 {
    ws.defaults
        .get("workflowMaxConcurrentAgents")
        .or_else(|| ws.defaults.get("defaultWorkflowMaxConcurrentAgents"))
        .and_then(Value::as_u64)
        .map(|val| val.clamp(WORKFLOW_CONCURRENCY_MIN, WORKFLOW_CONCURRENCY_MAX))
        .unwrap_or(WORKFLOW_CONCURRENCY_DEFAULT)
}

/// Returns true when the selected `<provider>:<model>` target supports reasoning effort.
pub fn model_supports_reasoning(selection: &str) -> bool {
    let provider = selection.split(':').next().unwrap_or("");
    matches!(provider, "openai" | "codex-cli" | "openai-compatible")
}

fn role_label(role: &str) -> &'static str {
    ROLE_OPTIONS
        .iter()
        .find(|(id, _)| *id == role)
        .map(|(_, label)| *label)
        .unwrap_or("Worker")
}

fn role_from_label(label: &str) -> &'static str {
    ROLE_OPTIONS
        .iter()
        .find(|(_, l)| *l == label)
        .map(|(id, _)| *id)
        .unwrap_or("worker")
}

fn workspace_display_name(ws: &WorkspaceRecord) -> String {
    if ws.one_off_chat {
        "Chats".to_string()
    } else if ws.name.trim().is_empty() {
        ws.path.clone()
    } else {
        ws.name.clone()
    }
}

fn collect_model_options(s: &AppState, ws: Option<&WorkspaceRecord>) -> Vec<(String, String)> {
    let statuses = ws
        .and_then(|w| s.workspace_runtime_by_id.get(&w.id))
        .map(|rt| rt.provider_statuses.as_slice())
        .unwrap_or(&[]);
    let mut out = Vec::new();
    for p in sort_and_filter_providers(&s.provider_catalog, statuses, "") {
        let status = statuses.iter().find(|st| st.provider == p.id);
        if !is_provider_connected(p, status, ws) {
            continue;
        }
        for m in &p.models {
            if !m.enabled {
                continue;
            }
            let value = format!("{}:{}", p.id, m.id);
            let label = format!("{} · {}", p.name, model_display_name(m));
            out.push((value, label));
        }
    }
    out
}

fn open_create_dialog(s: &mut AppState) {
    let scope = if s.settings_ui.subagent_scope == "workspace" {
        "workspace"
    } else {
        "global"
    };
    s.settings_ui.subagent_editing_id = None;
    s.settings_ui.subagent_scope = scope.to_string();
    s.settings_ui.subagent_base_role = "worker".to_string();
    s.settings_ui.subagent_enabled = true;
    s.settings_ui.subagent_name_edit = TextEdit::new("");
    s.settings_ui.subagent_desc_edit = TextEdit::new("");
    s.settings_ui.subagent_prompt_edit = TextEdit::new("");
    s.settings_ui.subagent_draft_provider.clear();
    s.settings_ui.subagent_draft_model.clear();
    s.settings_ui.subagent_reasoning_effort = None;
    s.settings_ui.subagent_draft_allowed_tools = role_default_tools("worker")
        .into_iter()
        .map(str::to_string)
        .collect();
    s.settings_ui.subagent_draft_mcp_servers = HashSet::new();
    s.settings_ui.subagent_draft_skill_names = HashSet::new();
    s.settings_ui.subagent_dialog_open = true;
}

fn open_edit_dialog(s: &mut AppState, profile: &SubagentProfile) {
    s.settings_ui.subagent_editing_id = Some(profile.id.clone());
    s.settings_ui.subagent_scope = profile
        .scope
        .clone()
        .unwrap_or_else(|| "global".to_string());
    let base_role = profile
        .tool_preset
        .clone()
        .filter(|r| ROLE_OPTIONS.iter().any(|(id, _)| *id == r))
        .unwrap_or_else(|| "worker".to_string());
    s.settings_ui.subagent_base_role = base_role;
    s.settings_ui.subagent_enabled = true;
    s.settings_ui.subagent_name_edit = TextEdit::new(profile.name.as_str());
    s.settings_ui.subagent_desc_edit = TextEdit::new(profile.description.as_str());
    s.settings_ui.subagent_prompt_edit = TextEdit::new(profile.system_prompt.as_str());
    s.settings_ui.subagent_draft_provider = profile.provider.clone().unwrap_or_default();
    s.settings_ui.subagent_draft_model = profile.model.clone().unwrap_or_default();
    s.settings_ui.subagent_reasoning_effort = profile.reasoning_effort.clone();
    s.settings_ui.subagent_draft_allowed_tools = profile.allowed_tools.iter().cloned().collect();
    s.settings_ui.subagent_draft_mcp_servers = HashSet::new();
    s.settings_ui.subagent_draft_skill_names = HashSet::new();
    s.settings_ui.subagent_dialog_open = true;
}

/// Builds the Subagents (`SettingsPageId::Subagents`) settings view.
pub fn view(s: &AppState, k: &Kit, t: &ThemeTokens) -> PageContent {
    let Some(ws) = resolve_subagent_workspace(s) else {
        return PageContent::simple(settings_page(vec![
            Section::new()
                .child(
                    EmptyState::new("No workspace selected")
                        .icon(&icons::USERS_ROUND)
                        .description("Select or add a workspace to manage subagent profiles.")
                        .build(k, t),
                )
                .build(k, t),
        ]));
    };

    let ws_id = ws.id.clone();
    let ws_name = workspace_display_name(ws);
    let mut overlays: Vec<El> = Vec::new();
    let mut sections: Vec<El> = Vec::new();

    // 1. Multi-agent workflow limits
    let effective_concurrency = resolve_workflow_concurrency(ws);
    let eff_str = effective_concurrency.to_string();
    let synced_match =
        s.settings_ui.workflow_concurrency_synced_ws.as_deref() == Some(ws_id.as_str());
    let fallback_concurrency_edit = if !synced_match {
        Some(TextEdit::new(eff_str.as_str()))
    } else {
        None
    };
    let display_concurrency_edit = fallback_concurrency_edit
        .as_ref()
        .unwrap_or(&s.settings_ui.workflow_concurrency_edit);

    let ws_dec = ws_id.clone();
    let ws_inc = ws_id.clone();
    let ws_apply = ws_id.clone();
    let ws_sync_on_edit = ws_id.clone();
    let eff_for_edit = eff_str.clone();
    let eff_for_apply = effective_concurrency;

    let concurrency_controls = row()
        .items_center()
        .gap(6.0)
        .child(
            Button::new("-")
                .variant(ButtonVariant::Outline)
                .control_size(ControlSize::Small)
                .disabled(effective_concurrency <= WORKFLOW_CONCURRENCY_MIN)
                .on_press(move |s: &mut AppState| {
                    let next = effective_concurrency
                        .saturating_sub(1)
                        .clamp(WORKFLOW_CONCURRENCY_MIN, WORKFLOW_CONCURRENCY_MAX);
                    s.settings_ui.workflow_concurrency_edit = TextEdit::new(next.to_string());
                    s.settings_ui.workflow_concurrency_synced_ws = Some(ws_dec.clone());
                    s.dispatch(Action::Settings(SettingsAction::UpdateWorkspaceDefaults {
                        workspace_id: ws_dec.clone(),
                        defaults: json!({ "workflowMaxConcurrentAgents": next }),
                    }));
                })
                .build(k),
        )
        .child(
            TextInput::new(display_concurrency_edit)
                .label("Concurrent workflow agents")
                .width(Some(68.0))
                .on_edit(move |s: &mut AppState| {
                    if s.settings_ui.workflow_concurrency_synced_ws.as_deref()
                        != Some(ws_sync_on_edit.as_str())
                    {
                        s.settings_ui.workflow_concurrency_edit =
                            TextEdit::new(eff_for_edit.as_str());
                        s.settings_ui.workflow_concurrency_synced_ws =
                            Some(ws_sync_on_edit.clone());
                    }
                    &mut s.settings_ui.workflow_concurrency_edit
                })
                .build(k),
        )
        .child(
            Button::new("+")
                .variant(ButtonVariant::Outline)
                .control_size(ControlSize::Small)
                .disabled(effective_concurrency >= WORKFLOW_CONCURRENCY_MAX)
                .on_press(move |s: &mut AppState| {
                    let next = (effective_concurrency + 1)
                        .clamp(WORKFLOW_CONCURRENCY_MIN, WORKFLOW_CONCURRENCY_MAX);
                    s.settings_ui.workflow_concurrency_edit = TextEdit::new(next.to_string());
                    s.settings_ui.workflow_concurrency_synced_ws = Some(ws_inc.clone());
                    s.dispatch(Action::Settings(SettingsAction::UpdateWorkspaceDefaults {
                        workspace_id: ws_inc.clone(),
                        defaults: json!({ "workflowMaxConcurrentAgents": next }),
                    }));
                })
                .build(k),
        )
        .child(
            Button::new("Apply")
                .variant(ButtonVariant::Outline)
                .control_size(ControlSize::Small)
                .on_press(move |s: &mut AppState| {
                    let clamped = clamp_workflow_concurrency(
                        &s.settings_ui.workflow_concurrency_edit.text,
                        eff_for_apply,
                    );
                    s.settings_ui.workflow_concurrency_edit = TextEdit::new(clamped.to_string());
                    s.settings_ui.workflow_concurrency_synced_ws = Some(ws_apply.clone());
                    s.dispatch(Action::Settings(SettingsAction::UpdateWorkspaceDefaults {
                        workspace_id: ws_apply.clone(),
                        defaults: json!({ "workflowMaxConcurrentAgents": clamped }),
                    }));
                })
                .build(k),
        );

    sections.push(
        Section::new()
            .title("Multi-agent limits")
            .description("Applies to every workflow run in this workspace.")
            .child(
                SettingsRow::new("Concurrent workflow agents")
                    .description(
                        "How many child agents one workflow run may have in flight (1–16). Lower this for local models to avoid exhausting request pools.",
                    )
                    .control(concurrency_controls)
                    .build(k, t),
            )
            .build(k, t),
    );

    // 2. Scope switch + target workspace picker + search
    let current_scope = if s.settings_ui.subagent_scope == "workspace" {
        "workspace"
    } else {
        "global"
    };
    let scope_bar = row()
        .w_full()
        .items_center()
        .justify_between()
        .flex_wrap()
        .gap(12.0)
        .child(
            row()
                .items_center()
                .gap(4.0)
                .px(3.0)
                .py(3.0)
                .radius(8.0)
                .fill(t.elevated_bg)
                .border(1.0, t.border_muted)
                .child(
                    Button::new("Global")
                        .variant(if current_scope == "global" {
                            ButtonVariant::Outline
                        } else {
                            ButtonVariant::Ghost
                        })
                        .control_size(ControlSize::Small)
                        .on_press(|s: &mut AppState| {
                            s.settings_ui.subagent_scope = "global".to_string();
                        })
                        .build(k),
                )
                .child(
                    Button::new("Workspace")
                        .variant(if current_scope == "workspace" {
                            ButtonVariant::Outline
                        } else {
                            ButtonVariant::Ghost
                        })
                        .control_size(ControlSize::Small)
                        .on_press(|s: &mut AppState| {
                            s.settings_ui.subagent_scope = "workspace".to_string();
                        })
                        .build(k),
                ),
        )
        .child(
            TextInput::new(&s.settings_ui.subagent_search_edit)
                .placeholder("Search subagents…")
                .width(Some(240.0))
                .on_edit(|s: &mut AppState| &mut s.settings_ui.subagent_search_edit)
                .build(k),
        );

    let scope_note = if current_scope == "global" {
        "Global subagents are available in every workspace and chat."
    } else {
        "Workspace subagents only apply to the selected workspace. One-off chats always use global subagents."
    };

    let mut controls_col = col().w_full().gap(8.0).child(scope_bar).child(
        text(scope_note)
            .font(k.ty.text_xsmall)
            .color(t.text_muted)
            .wrap(),
    );

    let choices = subagent_workspace_choices(s);
    if current_scope == "workspace" {
        let picker_control = if choices.len() > 1 {
            let labels: Vec<String> = choices.iter().map(|w| workspace_display_name(w)).collect();
            let label_refs: Vec<&str> = labels.iter().map(String::as_str).collect();
            let pairs: Vec<(String, String)> = choices
                .iter()
                .map(|w| (workspace_display_name(w), w.id.clone()))
                .collect();
            let open =
                s.settings_ui.open_select_key.as_deref() == Some("subagent-workspace-select");
            Some(
                Select::new("subagent-workspace-select", &label_refs)
                    .appearance(SelectAppearance::Field)
                    .width(220.0)
                    .current(Some(ws_name.as_str()))
                    .open(open)
                    .on_toggle(|s: &mut AppState| {
                        let open = s.settings_ui.open_select_key.as_deref()
                            == Some("subagent-workspace-select");
                        s.settings_ui.open_select_key = if open {
                            None
                        } else {
                            Some("subagent-workspace-select".to_string())
                        };
                    })
                    .on_close(|s: &mut AppState| {
                        if s.settings_ui.open_select_key.as_deref()
                            == Some("subagent-workspace-select")
                        {
                            s.settings_ui.open_select_key = None;
                        }
                    })
                    .on_choose(move |s: &mut AppState, chosen, _tx| {
                        s.settings_ui.open_select_key = None;
                        if let Some((_, id)) = pairs.iter().find(|(lbl, _)| lbl == chosen) {
                            s.settings_ui.subagent_workspace_id = Some(id.clone());
                        }
                    })
                    .build(k, &mut overlays),
            )
        } else {
            None
        };

        let mut ws_row =
            SettingsRow::new(format!("Profile workspace: {ws_name}")).description(ws.path.clone());
        if let Some(ctrl) = picker_control {
            ws_row = ws_row.control(ctrl);
        }
        controls_col = controls_col.child(Section::new().child(ws_row.build(k, t)).build(k, t));
    }

    sections.push(controls_col);

    // 3. Profiles list
    let query = s
        .settings_ui
        .subagent_search_edit
        .text
        .trim()
        .to_ascii_lowercase();
    let mut filtered: Vec<&SubagentProfile> = s
        .subagents
        .iter()
        .filter(|p| p.scope.as_deref().unwrap_or("global") == current_scope)
        .filter(|p| {
            query.is_empty()
                || p.name.to_ascii_lowercase().contains(&query)
                || p.id.to_ascii_lowercase().contains(&query)
                || p.description.to_ascii_lowercase().contains(&query)
        })
        .collect();
    filtered.sort_by_key(|a| a.name.to_lowercase());

    if filtered.is_empty() {
        let empty_title = if !query.is_empty() {
            "No matching subagents".to_string()
        } else if current_scope == "workspace" {
            format!("No subagents in {ws_name}")
        } else {
            "No global subagents".to_string()
        };
        let empty_desc = if !query.is_empty() {
            "Clear the search filter or create a new subagent profile."
        } else {
            "Create a subagent to delegate focused work to it from any chat."
        };
        sections.push(
            Section::new()
                .child(
                    EmptyState::new(empty_title)
                        .icon(&icons::USERS_ROUND)
                        .description(empty_desc)
                        .action(
                            Button::new("Create")
                                .variant(ButtonVariant::Contrast)
                                .control_size(ControlSize::Regular)
                                .icon(&icons::PLUS)
                                .on_press(open_create_dialog)
                                .build(k),
                        )
                        .build(k, t),
                )
                .build(k, t),
        );
    } else {
        let mut list_section = Section::new();
        for profile in filtered {
            let p_clone = profile.clone();
            let p_id_copy = profile.id.clone();
            let p_id_del = profile.id.clone();
            let p_scope = profile.scope.as_deref().unwrap_or("global");
            let copy_target_scope = if p_scope == "workspace" {
                "global"
            } else {
                "workspace"
            };
            let ws_copy = ws_id.clone();
            let copy_ref = format!("{p_scope}:{}", profile.id);

            let mut badge_pills: Vec<El> = Vec::new();
            if profile.builtin {
                badge_pills.push(status_pill("Built-in", StatusTone::Neutral, k, t));
            }
            if let Some(preset) = profile.tool_preset.as_deref() {
                badge_pills.push(status_pill(role_label(preset), StatusTone::Neutral, k, t));
            }
            if let Some(model) = profile.model.as_deref()
                && !model.trim().is_empty()
            {
                badge_pills.push(status_pill(model, StatusTone::Success, k, t));
            }

            let title_row = row()
                .items_center()
                .flex_wrap()
                .gap(8.0)
                .child(
                    text(profile.name.clone())
                        .font(k.ty.body_medium)
                        .color(t.text_base),
                )
                .children(badge_pills);

            let desc = if profile.description.trim().is_empty() {
                format!(
                    "{} template · {} tools allowed",
                    role_label(profile.tool_preset.as_deref().unwrap_or("worker")),
                    profile.allowed_tools.len()
                )
            } else {
                profile.description.clone()
            };

            let actions = row()
                .items_center()
                .gap(6.0)
                .child(
                    Button::new("Edit")
                        .variant(ButtonVariant::Outline)
                        .control_size(ControlSize::Small)
                        .on_press(move |s: &mut AppState| {
                            open_edit_dialog(s, &p_clone);
                        })
                        .build(k),
                )
                .child(
                    Button::new(if copy_target_scope == "global" {
                        "Copy global"
                    } else {
                        "Copy local"
                    })
                    .variant(ButtonVariant::Ghost)
                    .control_size(ControlSize::Small)
                    .icon(&icons::COPY)
                    .on_press(move |s: &mut AppState| {
                        let _ = &p_id_copy;
                        s.dispatch(Action::Settings(SettingsAction::CopyAgentProfile {
                            workspace_id: ws_copy.clone(),
                            id: copy_ref.clone(),
                            target_scope: copy_target_scope.to_string(),
                        }));
                        s.settings_ui.subagent_scope = copy_target_scope.to_string();
                    })
                    .build(k),
                )
                .child(
                    Button::new("Delete")
                        .variant(ButtonVariant::Ghost)
                        .control_size(ControlSize::Small)
                        .icon(&icons::TRASH)
                        .disabled(profile.builtin)
                        .on_press(move |s: &mut AppState| {
                            s.settings_ui.subagent_delete_confirm_id = Some(p_id_del.clone());
                        })
                        .build(k),
                );

            let row_card =
                row()
                    .w_full()
                    .px(16.0)
                    .py(14.0)
                    .items_center()
                    .justify_between()
                    .gap(12.0)
                    .child(
                        row()
                            .grow(1.0)
                            .min_w(0.0)
                            .items_center()
                            .gap(12.0)
                            .child(entity_icon(
                                s,
                                None,
                                &profile.name,
                                EntityIconSize::Sm,
                                k,
                                t,
                            ))
                            .child(col().grow(1.0).min_w(0.0).gap(4.0).child(title_row).child(
                                text(desc).font(k.ty.text_xsmall).color(t.text_muted).wrap(),
                            )),
                    )
                    .child(el().shrink().child(actions));

            list_section = list_section.child(row_card);
        }
        sections.push(list_section.build(k, t));
    }

    // 4. Create / Edit Dialog
    if s.settings_ui.subagent_dialog_open {
        let editing_existing = s.settings_ui.subagent_editing_id.is_some();
        let dialog_title = if editing_existing {
            "Edit subagent"
        } else {
            "New subagent"
        };
        let draft_name = s.settings_ui.subagent_name_edit.text.trim();
        let draft_id = s
            .settings_ui
            .subagent_editing_id
            .clone()
            .unwrap_or_else(|| profile_id_from_name(draft_name));
        let can_save = !draft_name.is_empty() && !draft_id.is_empty();

        let scope_label = if s.settings_ui.subagent_scope == "workspace" {
            "Workspace"
        } else {
            "Global"
        };
        let scope_options = ["Global", "Workspace"];
        let scope_open = s.settings_ui.open_select_key.as_deref() == Some("subagent-dialog-scope");
        let scope_select = Select::new("subagent-dialog-scope", &scope_options)
            .appearance(SelectAppearance::Field)
            .width(150.0)
            .disabled(editing_existing)
            .current(Some(scope_label))
            .open(scope_open)
            .on_toggle(|s: &mut AppState| {
                let open =
                    s.settings_ui.open_select_key.as_deref() == Some("subagent-dialog-scope");
                s.settings_ui.open_select_key = if open {
                    None
                } else {
                    Some("subagent-dialog-scope".to_string())
                };
            })
            .on_close(|s: &mut AppState| {
                if s.settings_ui.open_select_key.as_deref() == Some("subagent-dialog-scope") {
                    s.settings_ui.open_select_key = None;
                }
            })
            .on_choose(|s: &mut AppState, chosen, _tx| {
                s.settings_ui.open_select_key = None;
                s.settings_ui.subagent_scope = if chosen == "Workspace" {
                    "workspace".to_string()
                } else {
                    "global".to_string()
                };
            })
            .build(k, &mut overlays);

        let role_labels: Vec<&str> = ROLE_OPTIONS.iter().map(|(_, l)| *l).collect();
        let role_open = s.settings_ui.open_select_key.as_deref() == Some("subagent-dialog-role");
        let current_role_label = role_label(&s.settings_ui.subagent_base_role);
        let role_select = Select::new("subagent-dialog-role", &role_labels)
            .appearance(SelectAppearance::Field)
            .width(160.0)
            .current(Some(current_role_label))
            .open(role_open)
            .on_toggle(|s: &mut AppState| {
                let open = s.settings_ui.open_select_key.as_deref() == Some("subagent-dialog-role");
                s.settings_ui.open_select_key = if open {
                    None
                } else {
                    Some("subagent-dialog-role".to_string())
                };
            })
            .on_close(|s: &mut AppState| {
                if s.settings_ui.open_select_key.as_deref() == Some("subagent-dialog-role") {
                    s.settings_ui.open_select_key = None;
                }
            })
            .on_choose(|s: &mut AppState, chosen, _tx| {
                s.settings_ui.open_select_key = None;
                let role = role_from_label(chosen);
                s.settings_ui.subagent_base_role = role.to_string();
                s.settings_ui.subagent_draft_allowed_tools = role_default_tools(role)
                    .into_iter()
                    .map(str::to_string)
                    .collect();
            })
            .build(k, &mut overlays);

        let model_options = collect_model_options(s, Some(ws));
        let mut model_labels = vec!["Inherit parent model".to_string()];
        for (_, label) in &model_options {
            model_labels.push(label.clone());
        }
        let model_label_refs: Vec<&str> = model_labels.iter().map(String::as_str).collect();
        let selected_model_value = if s.settings_ui.subagent_draft_model.is_empty() {
            String::new()
        } else if s.settings_ui.subagent_draft_provider.is_empty() {
            s.settings_ui.subagent_draft_model.clone()
        } else {
            format!(
                "{}:{}",
                s.settings_ui.subagent_draft_provider, s.settings_ui.subagent_draft_model
            )
        };
        let current_model_label = model_options
            .iter()
            .find(|(v, _)| *v == selected_model_value)
            .map(|(_, l)| l.as_str())
            .unwrap_or("Inherit parent model");
        let model_open = s.settings_ui.open_select_key.as_deref() == Some("subagent-dialog-model");
        let model_pairs = model_options.clone();
        let model_select = Select::new("subagent-dialog-model", &model_label_refs)
            .appearance(SelectAppearance::Field)
            .width(260.0)
            .current(Some(current_model_label))
            .open(model_open)
            .on_toggle(|s: &mut AppState| {
                let open =
                    s.settings_ui.open_select_key.as_deref() == Some("subagent-dialog-model");
                s.settings_ui.open_select_key = if open {
                    None
                } else {
                    Some("subagent-dialog-model".to_string())
                };
            })
            .on_close(|s: &mut AppState| {
                if s.settings_ui.open_select_key.as_deref() == Some("subagent-dialog-model") {
                    s.settings_ui.open_select_key = None;
                }
            })
            .on_choose(move |s: &mut AppState, chosen, _tx| {
                s.settings_ui.open_select_key = None;
                if let Some((val, _)) = model_pairs.iter().find(|(_, l)| l == chosen) {
                    if let Some((prov, model)) = val.split_once(':') {
                        s.settings_ui.subagent_draft_provider = prov.to_string();
                        s.settings_ui.subagent_draft_model = model.to_string();
                    } else {
                        s.settings_ui.subagent_draft_provider.clear();
                        s.settings_ui.subagent_draft_model = val.clone();
                    }
                    if !model_supports_reasoning(val) {
                        s.settings_ui.subagent_reasoning_effort = None;
                    }
                } else {
                    s.settings_ui.subagent_draft_provider.clear();
                    s.settings_ui.subagent_draft_model.clear();
                    s.settings_ui.subagent_reasoning_effort = None;
                }
            })
            .build(k, &mut overlays);

        let top_controls = row()
            .w_full()
            .flex_wrap()
            .items_end()
            .gap(12.0)
            .child(
                col()
                    .gap(4.0)
                    .child(text("Scope").font(k.ty.text_xsmall).color(t.text_muted))
                    .child(scope_select),
            )
            .child(
                col()
                    .gap(4.0)
                    .child(text("Template").font(k.ty.text_xsmall).color(t.text_muted))
                    .child(role_select),
            )
            .child(
                row()
                    .items_center()
                    .gap(8.0)
                    .pb(4.0)
                    .child(text("Enabled").font(k.ty.text_xsmall).color(t.text_muted))
                    .child(
                        Switch::new(s.settings_ui.subagent_enabled)
                            .label("Enabled")
                            .hide_label()
                            .control_size(ControlSize::Mini)
                            .on_toggle(|s: &mut AppState| {
                                s.settings_ui.subagent_enabled = !s.settings_ui.subagent_enabled;
                            })
                            .build(k),
                    ),
            );

        let id_preview = if draft_id.is_empty() {
            "generated from name".to_string()
        } else {
            format!("{}:{draft_id}", s.settings_ui.subagent_scope)
        };

        let name_row = row()
            .w_full()
            .items_end()
            .gap(12.0)
            .child(
                col()
                    .grow(1.0)
                    .min_w(0.0)
                    .gap(4.0)
                    .child(text("Name").font(k.ty.text_xsmall).color(t.text_muted))
                    .child(
                        TextInput::new(&s.settings_ui.subagent_name_edit)
                            .label("Name")
                            .placeholder("Code Reviewer")
                            .width(None)
                            .on_edit(|s: &mut AppState| &mut s.settings_ui.subagent_name_edit)
                            .build(k),
                    ),
            )
            .child(
                col()
                    .w(210.0)
                    .gap(4.0)
                    .child(
                        text("Subagent id")
                            .font(k.ty.text_xsmall)
                            .color(t.text_muted),
                    )
                    .child(
                        row()
                            .h(32.0)
                            .px(10.0)
                            .radius(6.0)
                            .fill(t.elevated_bg)
                            .items_center()
                            .child(text(id_preview).font(k.ty.text_xsmall).color(t.text_muted)),
                    ),
            );

        let mut model_row = row().w_full().flex_wrap().items_end().gap(12.0).child(
            col()
                .gap(4.0)
                .child(
                    text("Model target")
                        .font(k.ty.text_xsmall)
                        .color(t.text_muted),
                )
                .child(model_select),
        );

        if model_supports_reasoning(&selected_model_value) {
            let eff_options = ["Inherit", "low", "medium", "high", "xhigh"];
            let eff_cur = s
                .settings_ui
                .subagent_reasoning_effort
                .as_deref()
                .filter(|v| REASONING_EFFORTS.contains(v))
                .unwrap_or("Inherit");
            let eff_open =
                s.settings_ui.open_select_key.as_deref() == Some("subagent-dialog-reasoning");
            let eff_select = Select::new("subagent-dialog-reasoning", &eff_options)
                .appearance(SelectAppearance::Field)
                .width(150.0)
                .current(Some(eff_cur))
                .open(eff_open)
                .on_toggle(|s: &mut AppState| {
                    let open = s.settings_ui.open_select_key.as_deref()
                        == Some("subagent-dialog-reasoning");
                    s.settings_ui.open_select_key = if open {
                        None
                    } else {
                        Some("subagent-dialog-reasoning".to_string())
                    };
                })
                .on_close(|s: &mut AppState| {
                    if s.settings_ui.open_select_key.as_deref() == Some("subagent-dialog-reasoning")
                    {
                        s.settings_ui.open_select_key = None;
                    }
                })
                .on_choose(|s: &mut AppState, chosen, _tx| {
                    s.settings_ui.open_select_key = None;
                    s.settings_ui.subagent_reasoning_effort = if chosen == "Inherit" {
                        None
                    } else {
                        Some(chosen.to_string())
                    };
                })
                .build(k, &mut overlays);
            model_row = model_row.child(
                col()
                    .gap(4.0)
                    .child(text("Reasoning").font(k.ty.text_xsmall).color(t.text_muted))
                    .child(eff_select),
            );
        }

        // Built-in tools checklist
        let tool_checks: Vec<El> = BUILT_IN_TOOLS
            .iter()
            .map(|tool| {
                let checked = s.settings_ui.subagent_draft_allowed_tools.contains(*tool);
                let tool_owned = (*tool).to_string();
                Checkbox::new(checked)
                    .label(*tool)
                    .on_toggle(move |s: &mut AppState| {
                        if s.settings_ui
                            .subagent_draft_allowed_tools
                            .contains(&tool_owned)
                        {
                            s.settings_ui
                                .subagent_draft_allowed_tools
                                .remove(&tool_owned);
                        } else {
                            s.settings_ui
                                .subagent_draft_allowed_tools
                                .insert(tool_owned.clone());
                        }
                    })
                    .build(k)
            })
            .collect();

        let tools_box = col()
            .w_full()
            .gap(6.0)
            .child(
                row()
                    .items_center()
                    .gap(8.0)
                    .child(
                        text("Built-in tools")
                            .font(k.ty.text_xsmall)
                            .color(t.text_muted),
                    )
                    .child(status_pill(
                        s.settings_ui.subagent_draft_allowed_tools.len().to_string(),
                        StatusTone::Neutral,
                        k,
                        t,
                    )),
            )
            .child(
                row()
                    .w_full()
                    .flex_wrap()
                    .gap(10.0)
                    .px(10.0)
                    .py(10.0)
                    .radius(8.0)
                    .border(1.0, t.border_muted)
                    .children(tool_checks),
            );

        // MCP servers checklist
        let mcp_checks: Vec<El> = s
            .mcp_servers
            .iter()
            .map(|srv| {
                let checked = s.settings_ui.subagent_draft_mcp_servers.contains(&srv.name);
                let name = srv.name.clone();
                Checkbox::new(checked)
                    .label(srv.name.clone())
                    .on_toggle(move |s: &mut AppState| {
                        if s.settings_ui.subagent_draft_mcp_servers.contains(&name) {
                            s.settings_ui.subagent_draft_mcp_servers.remove(&name);
                        } else {
                            s.settings_ui
                                .subagent_draft_mcp_servers
                                .insert(name.clone());
                        }
                    })
                    .build(k)
            })
            .collect();

        // Skills checklist
        let skill_checks: Vec<El> = s
            .skills
            .iter()
            .filter(|sk| sk.enabled)
            .map(|sk| {
                let checked = s.settings_ui.subagent_draft_skill_names.contains(&sk.name);
                let name = sk.name.clone();
                Checkbox::new(checked)
                    .label(sk.name.clone())
                    .on_toggle(move |s: &mut AppState| {
                        if s.settings_ui.subagent_draft_skill_names.contains(&name) {
                            s.settings_ui.subagent_draft_skill_names.remove(&name);
                        } else {
                            s.settings_ui
                                .subagent_draft_skill_names
                                .insert(name.clone());
                        }
                    })
                    .build(k)
            })
            .collect();

        let mut scroll_inner = col()
            .w_full()
            .min_w(0.0)
            .gap(12.0)
            .child(
                text(
                    "One-off chats can only use global profiles. Choose Global if this subagent should be available there.",
                )
                .font(k.ty.text_xsmall)
                .color(t.text_muted)
                .wrap(),
            )
            .child(top_controls)
            .child(name_row)
            .child(
                col()
                    .w_full()
                    .gap(4.0)
                    .child(text("Description").font(k.ty.text_xsmall).color(t.text_muted))
                    .child(
                        TextInput::new(&s.settings_ui.subagent_desc_edit)
                            .label("Description")
                            .placeholder("Short summary of when Cowork should delegate to this subagent")
                            .width(None)
                            .on_edit(|s: &mut AppState| &mut s.settings_ui.subagent_desc_edit)
                            .build(k),
                    ),
            )
            .child(
                col()
                    .w_full()
                    .gap(4.0)
                    .child(text("Prompt").font(k.ty.text_xsmall).color(t.text_muted))
                    .child(
                        TextArea::new(&s.settings_ui.subagent_prompt_edit)
                            .label("Prompt")
                            .placeholder("Add or edit this subagent prompt.")
                            .width(None)
                            .rows(4)
                            .on_edit(|s: &mut AppState| &mut s.settings_ui.subagent_prompt_edit)
                            .build(k),
                    ),
            )
            .child(model_row)
            .child(tools_box);

        if !mcp_checks.is_empty() {
            scroll_inner = scroll_inner.child(
                col()
                    .w_full()
                    .gap(6.0)
                    .child(
                        text("MCP servers")
                            .font(k.ty.text_xsmall)
                            .color(t.text_muted),
                    )
                    .child(
                        row()
                            .w_full()
                            .flex_wrap()
                            .gap(10.0)
                            .px(10.0)
                            .py(10.0)
                            .radius(8.0)
                            .border(1.0, t.border_muted)
                            .children(mcp_checks),
                    ),
            );
        }

        if !skill_checks.is_empty() {
            scroll_inner = scroll_inner.child(
                col()
                    .w_full()
                    .gap(6.0)
                    .child(text("Skills").font(k.ty.text_xsmall).color(t.text_muted))
                    .child(
                        row()
                            .w_full()
                            .flex_wrap()
                            .gap(10.0)
                            .px(10.0)
                            .py(10.0)
                            .radius(8.0)
                            .border(1.0, t.border_muted)
                            .children(skill_checks),
                    ),
            );
        }

        let ws_save = ws_id.clone();
        let footer = row()
            .w_full()
            .justify_end()
            .gap(8.0)
            .pt(8.0)
            .child(
                Button::new("Cancel")
                    .variant(ButtonVariant::Outline)
                    .control_size(ControlSize::Regular)
                    .on_press(|s: &mut AppState| {
                        s.settings_ui.subagent_dialog_open = false;
                        s.settings_ui.subagent_editing_id = None;
                    })
                    .build(k),
            )
            .child(
                Button::new("Save")
                    .variant(ButtonVariant::Contrast)
                    .control_size(ControlSize::Regular)
                    .disabled(!can_save)
                    .on_press(move |s: &mut AppState| {
                        let name = s.settings_ui.subagent_name_edit.text.trim().to_string();
                        let id = s
                            .settings_ui
                            .subagent_editing_id
                            .clone()
                            .unwrap_or_else(|| profile_id_from_name(&name));
                        if name.is_empty() || id.is_empty() {
                            return;
                        }
                        let allowed_tools: Vec<String> = BUILT_IN_TOOLS
                            .iter()
                            .filter(|tool| {
                                s.settings_ui.subagent_draft_allowed_tools.contains(**tool)
                            })
                            .map(|t| (*t).to_string())
                            .collect();
                        let profile = SubagentProfile {
                            id,
                            name,
                            description: s.settings_ui.subagent_desc_edit.text.trim().to_string(),
                            provider: (!s.settings_ui.subagent_draft_provider.is_empty())
                                .then(|| s.settings_ui.subagent_draft_provider.clone()),
                            model: (!s.settings_ui.subagent_draft_model.is_empty())
                                .then(|| s.settings_ui.subagent_draft_model.clone()),
                            system_prompt: s
                                .settings_ui
                                .subagent_prompt_edit
                                .text
                                .trim()
                                .to_string(),
                            tool_preset: Some(s.settings_ui.subagent_base_role.clone()),
                            allowed_tools,
                            denied_tools: Vec::new(),
                            builtin: false,
                            reasoning_effort: s.settings_ui.subagent_reasoning_effort.clone(),
                            scope: Some(s.settings_ui.subagent_scope.clone()),
                        };
                        s.dispatch(Action::Settings(SettingsAction::UpsertSubagent {
                            workspace_id: ws_save.clone(),
                            profile,
                        }));
                        s.settings_ui.subagent_dialog_open = false;
                        s.settings_ui.subagent_editing_id = None;
                    })
                    .build(k),
            );

        Dialog::new("subagent-editor-dialog", dialog_title)
            .open(true)
            .width(620.0)
            .fit()
            .on_close(|s: &mut AppState| {
                s.settings_ui.subagent_dialog_open = false;
                s.settings_ui.subagent_editing_id = None;
            })
            .child(
                col()
                    .w_full()
                    .min_w(0.0)
                    .px(16.0)
                    .pb(16.0)
                    .gap(12.0)
                    .child(
                        k.scroll_bar(
                            col()
                                .w_full()
                                .max_h(430.0)
                                .scroll(ScrollSpec {
                                    stick_bottom: false,
                                })
                                .child(scroll_inner),
                        ),
                    )
                    .child(footer),
            )
            .build(k, &mut overlays);
    }

    // 5. Delete confirmation
    if let Some(delete_id) = s.settings_ui.subagent_delete_confirm_id.clone() {
        let display_name = s
            .subagents
            .iter()
            .find(|p| p.id == delete_id)
            .map(|p| p.name.clone())
            .unwrap_or_else(|| delete_id.clone());
        let ws_del = ws_id;
        confirm_dialog(
            ConfirmDialogSpec {
                key: "subagent-delete-confirm",
                open: true,
                title: "Delete subagent",
                description: format!(
                    "Delete the \"{display_name}\" subagent? This subagent will be permanently removed."
                ),
                confirm_label: "Delete",
                danger: true,
            },
            |s| s.settings_ui.subagent_delete_confirm_id = None,
            move |s| {
                s.settings_ui.subagent_delete_confirm_id = None;
                s.dispatch(Action::Settings(SettingsAction::DeleteSubagent {
                    workspace_id: ws_del.clone(),
                    id: delete_id.clone(),
                }));
            },
            k,
            &mut overlays,
        );
    }

    PageContent::simple(settings_page(sections))
        .with_header_actions(vec![
            Button::new("New subagent")
                .variant(ButtonVariant::Outline)
                .control_size(ControlSize::Small)
                .icon(&icons::PLUS)
                .on_press(open_create_dialog)
                .build(k),
        ])
        .with_overlays(overlays)
}
