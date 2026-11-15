//! Profile & Memory settings page (`SettingsPageId::ProfileMemory`).
//!
//! Ported from `apps/desktop/src/ui/settings/pages/WorkspacesPage.tsx` (`surface="profile"`),
//! `MemoryPage.tsx`, and `AdvancedMemoryPanel.tsx`.

use rune::{El, ScrollSpec, TextEdit, col, row, text};
use rune_kit::{
    Button, ButtonVariant, Checkbox, ControlSize, Dialog, Kit, Select, SelectAppearance, TextArea,
    TextInput,
};
use serde_json::{Value, json};

use crate::actions::{Action, NavAction, SettingsAction};
use crate::state::{AppState, MemoryEntry, ScopedMemoryEntry, WorkspaceRecord};
use crate::theme::ThemeTokens;
use crate::views::settings::icons;
use crate::views::settings::primitives::{
    ConfirmDialogSpec, EmptyState, Section, SettingsRow, StatusTone, compact_tabs, confirm_dialog,
    format_timestamp_friendly, management_targets, mini_switch, search_input, settings_page,
    status_pill,
};
use crate::views::settings::providers::is_provider_connected;
use crate::views::settings::providers_utils::{model_display_name, sort_and_filter_providers};
use crate::views::settings::shell::PageContent;

/// Reserved id for always-included hot workspace memory.
pub const HOT_MEMORY_ID: &str = "hot";

const ADVANCED_MEMORY_TYPES: &[&str] = &["note", "user", "feedback", "project", "reference"];

/// Resolves the draft memory key/id, defaulting blank input to `"hot"`.
pub fn resolve_draft_memory_id(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        HOT_MEMORY_ID.to_string()
    } else {
        trimmed.to_string()
    }
}

/// Extracts `(userName, work, instructions, details)` from a workspace record.
pub fn resolve_user_profile(ws: &WorkspaceRecord) -> (String, String, String, String) {
    let name = ws.user_name.clone().unwrap_or_default();
    let up = ws.user_profile.as_ref().and_then(Value::as_object);
    let field = |k: &str| {
        up.and_then(|obj| obj.get(k))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    (name, field("work"), field("instructions"), field("details"))
}

/// Resolves whether Advanced Memory is enabled on the workspace.
pub fn is_advanced_memory_enabled(ws: &WorkspaceRecord) -> bool {
    ws.defaults
        .get("advancedMemory")
        .or_else(|| ws.defaults.get("defaultAdvancedMemory"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn default_str_field<'a>(ws: &'a WorkspaceRecord, key_a: &str, key_b: &str) -> &'a str {
    ws.defaults
        .get(key_a)
        .or_else(|| ws.defaults.get(key_b))
        .and_then(Value::as_str)
        .unwrap_or("")
}

fn default_bool_field(ws: &WorkspaceRecord, key_a: &str, key_b: &str) -> bool {
    ws.defaults
        .get(key_a)
        .or_else(|| ws.defaults.get(key_b))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn excluded_skills_list(ws: &WorkspaceRecord) -> Vec<String> {
    ws.defaults
        .get("skillImprovementExcludedSkills")
        .or_else(|| ws.defaults.get("defaultSkillImprovementExcludedSkills"))
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn build_model_choices(s: &AppState, ws: Option<&WorkspaceRecord>) -> Vec<(String, String)> {
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
            out.push((
                format!("{}:{}", p.id, m.id),
                format!("{} · {}", p.name, model_display_name(m)),
            ));
        }
    }
    out
}

/// Builds strict `MemoryAdvancedUpsertParams` JSON (`slug?`, `name`, `description`, `type?`, `body`).
pub fn build_advanced_memory_payload(
    editing_slug: Option<&str>,
    name: &str,
    description: &str,
    kind: &str,
    body: &str,
) -> Value {
    let mut obj = serde_json::Map::new();
    if let Some(slug) = editing_slug.map(str::trim).filter(|s| !s.is_empty()) {
        obj.insert("slug".to_string(), Value::String(slug.to_string()));
    }
    obj.insert("name".to_string(), Value::String(name.trim().to_string()));
    obj.insert(
        "description".to_string(),
        Value::String(description.trim().to_string()),
    );
    if !kind.trim().is_empty() {
        obj.insert("type".to_string(), Value::String(kind.trim().to_string()));
    }
    obj.insert("body".to_string(), Value::String(body.trim().to_string()));
    Value::Object(obj)
}

fn sync_profile_fields_if_needed(
    s: &mut AppState,
    ws_id: &str,
    name: &str,
    work: &str,
    instructions: &str,
    details: &str,
) {
    if s.settings_ui.profile_synced_workspace_id.as_deref() != Some(ws_id) {
        s.settings_ui.profile_name_edit = TextEdit::new(name);
        s.settings_ui.profile_work_edit = TextEdit::new(work);
        s.settings_ui.profile_instructions_edit = TextEdit::new(instructions);
        s.settings_ui.profile_details_edit = TextEdit::new(details);
        s.settings_ui.profile_synced_workspace_id = Some(ws_id.to_string());
    }
}

fn active_workspace(s: &AppState) -> Option<&WorkspaceRecord> {
    if let Some(id) = s.resolve_management_workspace_id()
        && let Some(ws) = s.workspaces.iter().find(|w| w.id == id && !w.archived)
    {
        return Some(ws);
    }
    s.workspaces.iter().find(|w| !w.archived)
}

/// Builds the Profile & Memory (`SettingsPageId::ProfileMemory`) settings view.
pub fn view(s: &AppState, k: &Kit, t: &ThemeTokens) -> PageContent {
    let Some(ws) = active_workspace(s) else {
        return PageContent::simple(settings_page(vec![
            Section::new()
                .child(
                    EmptyState::new("No workspace selected")
                        .icon(&icons::USER_ROUND_COG)
                        .description(
                            "Select or add a workspace to manage your profile, memory, and skill improvement.",
                        )
                        .build(k, t),
                )
                .build(k, t),
        ]));
    };

    let ws_id = ws.id.clone();
    let targets = management_targets(s);
    let active_target = targets
        .iter()
        .find(|target| target.id == ws_id)
        .or_else(|| targets.first());
    let mut overlays: Vec<El> = Vec::new();
    let mut sections: Vec<El> = Vec::new();

    // Target selector if per-workspace mode with multiple targets
    if s.desktop_settings.per_workspace_settings && targets.len() > 1 {
        let labels: Vec<String> = targets.iter().map(|t| t.label.clone()).collect();
        let label_refs: Vec<&str> = labels.iter().map(String::as_str).collect();
        let pairs: Vec<(String, String)> = targets
            .iter()
            .map(|t| (t.label.clone(), t.id.clone()))
            .collect();
        let current_label = active_target.map(|t| t.label.as_str());
        let open = s.settings_ui.open_select_key.as_deref() == Some("memory-target-select");
        let picker = Select::new("memory-target-select", &label_refs)
            .label("Memory target")
            .appearance(SelectAppearance::Field)
            .width(220.0)
            .current(current_label)
            .open(open)
            .on_toggle(|s: &mut AppState| {
                let open = s.settings_ui.open_select_key.as_deref() == Some("memory-target-select");
                s.settings_ui.open_select_key = if open {
                    None
                } else {
                    Some("memory-target-select".to_string())
                };
            })
            .on_close(|s: &mut AppState| {
                if s.settings_ui.open_select_key.as_deref() == Some("memory-target-select") {
                    s.settings_ui.open_select_key = None;
                }
            })
            .on_choose(move |s: &mut AppState, chosen, _tx| {
                s.settings_ui.open_select_key = None;
                if let Some((_, id)) = pairs.iter().find(|(lbl, _)| lbl == chosen) {
                    s.dispatch(Action::Navigate(NavAction::SelectWorkspace(id.clone())));
                }
            })
            .build(k, &mut overlays);

        sections.push(
            Section::new()
                .title("Memory target")
                .child(
                    SettingsRow::new(
                        active_target
                            .map(|tgt| tgt.label.as_str())
                            .unwrap_or("Workspace"),
                    )
                    .description(active_target.map(|tgt| tgt.path.as_str()).unwrap_or(""))
                    .control(picker)
                    .build(k, t),
                )
                .build(k, t),
        );
    }

    // 1. User Profile Card
    let (saved_name, saved_work, saved_instructions, saved_details) = resolve_user_profile(ws);
    let synced_this_ws =
        s.settings_ui.profile_synced_workspace_id.as_deref() == Some(ws_id.as_str());
    let name_fallback = (!synced_this_ws).then(|| TextEdit::new(saved_name.as_str()));
    let work_fallback = (!synced_this_ws).then(|| TextEdit::new(saved_work.as_str()));
    let inst_fallback = (!synced_this_ws).then(|| TextEdit::new(saved_instructions.as_str()));
    let det_fallback = (!synced_this_ws).then(|| TextEdit::new(saved_details.as_str()));

    let name_edit = name_fallback
        .as_ref()
        .unwrap_or(&s.settings_ui.profile_name_edit);
    let work_edit = work_fallback
        .as_ref()
        .unwrap_or(&s.settings_ui.profile_work_edit);
    let inst_edit = inst_fallback
        .as_ref()
        .unwrap_or(&s.settings_ui.profile_instructions_edit);
    let det_edit = det_fallback
        .as_ref()
        .unwrap_or(&s.settings_ui.profile_details_edit);

    let profile_dirty = name_edit.text != saved_name
        || work_edit.text != saved_work
        || inst_edit.text != saved_instructions
        || det_edit.text != saved_details;

    let sn_1 = saved_name.clone();
    let sw_1 = saved_work.clone();
    let si_1 = saved_instructions.clone();
    let sd_1 = saved_details.clone();
    let ws_1 = ws_id.clone();

    let sn_2 = saved_name.clone();
    let sw_2 = saved_work.clone();
    let si_2 = saved_instructions.clone();
    let sd_2 = saved_details.clone();
    let ws_2 = ws_id.clone();

    let sn_3 = saved_name.clone();
    let sw_3 = saved_work.clone();
    let si_3 = saved_instructions.clone();
    let sd_3 = saved_details.clone();
    let ws_3 = ws_id.clone();

    let sn_4 = saved_name;
    let sw_4 = saved_work;
    let si_4 = saved_instructions;
    let sd_4 = saved_details;
    let ws_4 = ws_id.clone();

    let ws_save_profile = ws_id.clone();
    let cur_name_text = name_edit.text.clone();
    let cur_work_text = work_edit.text.clone();
    let cur_inst_text = inst_edit.text.clone();
    let cur_det_text = det_edit.text.clone();

    let mut save_row = row().items_center().gap(10.0).child(
        Button::new("Save changes")
            .variant(ButtonVariant::Contrast)
            .control_size(ControlSize::Regular)
            .icon(&icons::SAVE)
            .disabled(!profile_dirty)
            .on_press(move |s: &mut AppState| {
                let (name, work, inst, det) =
                    if s.settings_ui.profile_synced_workspace_id.as_deref()
                        == Some(ws_save_profile.as_str())
                    {
                        (
                            s.settings_ui.profile_name_edit.text.clone(),
                            s.settings_ui.profile_work_edit.text.clone(),
                            s.settings_ui.profile_instructions_edit.text.clone(),
                            s.settings_ui.profile_details_edit.text.clone(),
                        )
                    } else {
                        (
                            cur_name_text.clone(),
                            cur_work_text.clone(),
                            cur_inst_text.clone(),
                            cur_det_text.clone(),
                        )
                    };
                s.settings_ui.profile_saved_banner = true;
                s.dispatch(Action::Settings(SettingsAction::UpdateWorkspaceDefaults {
                    workspace_id: ws_save_profile.clone(),
                    defaults: json!({
                        "userName": name,
                        "userProfile": {
                            "work": work,
                            "instructions": inst,
                            "details": det,
                        }
                    }),
                }));
            })
            .build(k),
    );
    if s.settings_ui.profile_saved_banner && !profile_dirty {
        save_row = save_row.child(status_pill("Saved", StatusTone::Success, k, t));
    }

    let profile_body = col()
        .w_full()
        .px(16.0)
        .py(16.0)
        .gap(14.0)
        .child(
            col()
                .w_full()
                .gap(4.0)
                .child(text("Your name").font(k.ty.ui_medium).color(t.text_base))
                .child(
                    TextInput::new(name_edit)
                        .label("Your name")
                        .placeholder("Name used in prompt context")
                        .width(None)
                        .on_edit(move |s: &mut AppState| {
                            s.settings_ui.profile_saved_banner = false;
                            sync_profile_fields_if_needed(s, &ws_1, &sn_1, &sw_1, &si_1, &sd_1);
                            &mut s.settings_ui.profile_name_edit
                        })
                        .build(k),
                ),
        )
        .child(
            col()
                .w_full()
                .gap(4.0)
                .child(
                    text("Role or work context")
                        .font(k.ty.ui_medium)
                        .color(t.text_base),
                )
                .child(
                    TextArea::new(work_edit)
                        .label("Work context")
                        .placeholder("Role, team, domain, or responsibilities")
                        .width(None)
                        .rows(3)
                        .on_edit(move |s: &mut AppState| {
                            s.settings_ui.profile_saved_banner = false;
                            sync_profile_fields_if_needed(s, &ws_2, &sn_2, &sw_2, &si_2, &sd_2);
                            &mut s.settings_ui.profile_work_edit
                        })
                        .build(k),
                ),
        )
        .child(
            col()
                .w_full()
                .gap(4.0)
                .child(text("Instructions").font(k.ty.ui_medium).color(t.text_base))
                .child(
                    TextArea::new(inst_edit)
                        .label("Profile instructions")
                        .placeholder("Behavior instructions the agent should follow")
                        .width(None)
                        .rows(3)
                        .on_edit(move |s: &mut AppState| {
                            s.settings_ui.profile_saved_banner = false;
                            sync_profile_fields_if_needed(s, &ws_3, &sn_3, &sw_3, &si_3, &sd_3);
                            &mut s.settings_ui.profile_instructions_edit
                        })
                        .build(k),
                ),
        )
        .child(
            col()
                .w_full()
                .gap(4.0)
                .child(
                    text("Background details")
                        .font(k.ty.ui_medium)
                        .color(t.text_base),
                )
                .child(
                    TextArea::new(det_edit)
                        .label("Profile details")
                        .placeholder("Personal or project details the agent should remember")
                        .width(None)
                        .rows(3)
                        .on_edit(move |s: &mut AppState| {
                            s.settings_ui.profile_saved_banner = false;
                            sync_profile_fields_if_needed(s, &ws_4, &sn_4, &sw_4, &si_4, &sd_4);
                            &mut s.settings_ui.profile_details_edit
                        })
                        .build(k),
                ),
        )
        .child(save_row);

    sections.push(
        Section::new()
            .title("Your profile")
            .description("Optional context Cowork includes in your prompts.")
            .child(profile_body)
            .build(k, t),
    );

    // 2. Advanced memory section
    let adv_mem_enabled = is_advanced_memory_enabled(ws);
    let model_choices = build_model_choices(s, Some(ws));
    let ws_id_adv = ws_id.clone();

    let mut adv_mem_section = Section::new()
        .title("Advanced memory")
        .description(
            "Agent-driven memory that summarizes each turn into indexed files Cowork can recall.",
        )
        .child(
            SettingsRow::new("Enable advanced memory")
                .description(
                    "Replaces the manual remembered-facts list with agent-maintained memory files.",
                )
                .control(mini_switch(
                    adv_mem_enabled,
                    "Advanced memory",
                    false,
                    move |s: &mut AppState| {
                        s.dispatch(Action::Settings(SettingsAction::UpdateWorkspaceDefaults {
                            workspace_id: ws_id_adv.clone(),
                            defaults: json!({ "advancedMemory": !adv_mem_enabled }),
                        }));
                    },
                    k,
                ))
                .build(k, t),
        );

    if adv_mem_enabled {
        let current_gen_model =
            default_str_field(ws, "memoryGenerationModel", "defaultMemoryGenerationModel");
        let mut gen_labels = vec!["Default (economical)".to_string()];
        for (_, label) in &model_choices {
            gen_labels.push(label.clone());
        }
        let gen_refs: Vec<&str> = gen_labels.iter().map(String::as_str).collect();
        let current_gen_label = model_choices
            .iter()
            .find(|(v, _)| v == current_gen_model)
            .map(|(_, l)| l.as_str())
            .unwrap_or("Default (economical)");
        let gen_open = s.settings_ui.open_select_key.as_deref() == Some("memory-generation-model");
        let gen_pairs = model_choices.clone();
        let ws_id_gen = ws_id.clone();

        let gen_select = Select::new("memory-generation-model", &gen_refs)
            .label("Memory generation model")
            .appearance(SelectAppearance::Field)
            .width(240.0)
            .current(Some(current_gen_label))
            .open(gen_open)
            .on_toggle(|s: &mut AppState| {
                let open =
                    s.settings_ui.open_select_key.as_deref() == Some("memory-generation-model");
                s.settings_ui.open_select_key = if open {
                    None
                } else {
                    Some("memory-generation-model".to_string())
                };
            })
            .on_close(|s: &mut AppState| {
                if s.settings_ui.open_select_key.as_deref() == Some("memory-generation-model") {
                    s.settings_ui.open_select_key = None;
                }
            })
            .on_choose(move |s: &mut AppState, chosen, _tx| {
                s.settings_ui.open_select_key = None;
                let defaults = if let Some((val, _)) = gen_pairs.iter().find(|(_, l)| l == chosen) {
                    json!({ "memoryGenerationModel": val })
                } else {
                    json!({ "clearMemoryGenerationModel": true })
                };
                s.dispatch(Action::Settings(SettingsAction::UpdateWorkspaceDefaults {
                    workspace_id: ws_id_gen.clone(),
                    defaults,
                }));
            })
            .build(k, &mut overlays);

        adv_mem_section = adv_mem_section.child(
            SettingsRow::new("Memory generation model")
                .description("Model used to summarize turns into memory files.")
                .control(gen_select)
                .build(k, t),
        );
    }

    sections.push(adv_mem_section.build(k, t));

    // 3. Skill Improvement (Beta)
    let si_enabled = default_bool_field(
        ws,
        "skillImprovementEnabled",
        "defaultSkillImprovementEnabled",
    );
    let si_expanded = s.settings_ui.skill_improvement_expanded;
    let si_event = s
        .skill_improvement_status
        .as_ref()
        .and_then(|v| v.get("event").or(Some(v)));
    let si_skills = si_event
        .and_then(|e| e.get("eligibleSkills"))
        .and_then(Value::as_array);
    let si_pending = si_event
        .and_then(|e| e.get("pendingJobs"))
        .and_then(Value::as_array);
    let si_history = si_event
        .and_then(|e| e.get("history"))
        .and_then(Value::as_array);
    let si_backups = si_event
        .and_then(|e| e.get("backups"))
        .and_then(Value::as_array);

    let ws_id_si_toggle = ws_id.clone();
    let mut si_section = Section::new()
        .title("Skill Improvement (Beta)")
        .description("Optional maintenance agent that sharpens local skills from recent usage.")
        .child(
            SettingsRow::new("Advanced skill maintenance")
                .description(format!(
                    "{} · model, scope, queue, and history",
                    if si_enabled { "Enabled" } else { "Off" }
                ))
                .control(
                    Button::new(if si_expanded {
                        "Hide settings"
                    } else {
                        "Configure"
                    })
                    .variant(ButtonVariant::Outline)
                    .control_size(ControlSize::Small)
                    .icon(if si_expanded {
                        &icons::CHEVRON_DOWN
                    } else {
                        &icons::CHEVRON_RIGHT
                    })
                    .on_press(move |s: &mut AppState| {
                        s.settings_ui.skill_improvement_expanded =
                            !s.settings_ui.skill_improvement_expanded;
                        if s.settings_ui.skill_improvement_expanded {
                            s.dispatch(Action::Settings(
                                SettingsAction::RefreshSkillImprovementStatus {
                                    workspace_id: ws_id_si_toggle.clone(),
                                },
                            ));
                        }
                    })
                    .build(k),
                )
                .build(k, t),
        );

    if si_expanded {
        let ws_si_en = ws_id.clone();
        si_section = si_section.child(
            SettingsRow::new("Enable skill improvement")
                .description(
                    "Queues improvement runs after skill usage and keeps a restore backup for each changed skill.",
                )
                .control(mini_switch(
                    si_enabled,
                    "Skill improvement",
                    false,
                    move |s: &mut AppState| {
                        s.dispatch(Action::Settings(SettingsAction::UpdateWorkspaceDefaults {
                            workspace_id: ws_si_en.clone(),
                            defaults: json!({ "skillImprovementEnabled": !si_enabled }),
                        }));
                    },
                    k,
                ))
                .build(k, t),
        );

        if si_enabled {
            let si_model =
                default_str_field(ws, "skillImprovementModel", "defaultSkillImprovementModel");
            let mut si_model_labels = vec!["Default (session model)".to_string()];
            for (_, label) in &model_choices {
                si_model_labels.push(label.clone());
            }
            let si_model_refs: Vec<&str> = si_model_labels.iter().map(String::as_str).collect();
            let si_model_cur = model_choices
                .iter()
                .find(|(v, _)| v == si_model)
                .map(|(_, l)| l.as_str())
                .unwrap_or("Default (session model)");
            let si_model_open =
                s.settings_ui.open_select_key.as_deref() == Some("skill-improvement-model");
            let si_model_pairs = model_choices.clone();
            let ws_si_model = ws_id.clone();

            let si_model_select = Select::new("skill-improvement-model", &si_model_refs)
                .label("Skill improvement model")
                .appearance(SelectAppearance::Field)
                .width(240.0)
                .current(Some(si_model_cur))
                .open(si_model_open)
                .on_toggle(|s: &mut AppState| {
                    let open =
                        s.settings_ui.open_select_key.as_deref() == Some("skill-improvement-model");
                    s.settings_ui.open_select_key = if open {
                        None
                    } else {
                        Some("skill-improvement-model".to_string())
                    };
                })
                .on_close(|s: &mut AppState| {
                    if s.settings_ui.open_select_key.as_deref() == Some("skill-improvement-model") {
                        s.settings_ui.open_select_key = None;
                    }
                })
                .on_choose(move |s: &mut AppState, chosen, _tx| {
                    s.settings_ui.open_select_key = None;
                    let defaults =
                        if let Some((val, _)) = si_model_pairs.iter().find(|(_, l)| l == chosen) {
                            json!({ "skillImprovementModel": val })
                        } else {
                            json!({ "clearSkillImprovementModel": true })
                        };
                    s.dispatch(Action::Settings(SettingsAction::UpdateWorkspaceDefaults {
                        workspace_id: ws_si_model.clone(),
                        defaults,
                    }));
                })
                .build(k, &mut overlays);

            si_section = si_section.child(
                SettingsRow::new("Improvement model")
                    .description("Model used by the headless skill improver.")
                    .control(si_model_select)
                    .build(k, t),
            );

            let si_scope =
                default_str_field(ws, "skillImprovementScope", "defaultSkillImprovementScope");
            let si_scope_label = if si_scope == "all" {
                "All eligible skills"
            } else {
                "User skills"
            };
            let si_scope_opts = ["User skills", "All eligible skills"];
            let si_scope_open =
                s.settings_ui.open_select_key.as_deref() == Some("skill-improvement-scope");
            let ws_si_scope = ws_id.clone();
            let si_scope_select = Select::new("skill-improvement-scope", &si_scope_opts)
                .label("Skill improvement scope")
                .appearance(SelectAppearance::Field)
                .width(190.0)
                .current(Some(si_scope_label))
                .open(si_scope_open)
                .on_toggle(|s: &mut AppState| {
                    let open =
                        s.settings_ui.open_select_key.as_deref() == Some("skill-improvement-scope");
                    s.settings_ui.open_select_key = if open {
                        None
                    } else {
                        Some("skill-improvement-scope".to_string())
                    };
                })
                .on_close(|s: &mut AppState| {
                    if s.settings_ui.open_select_key.as_deref() == Some("skill-improvement-scope") {
                        s.settings_ui.open_select_key = None;
                    }
                })
                .on_choose(move |s: &mut AppState, chosen, _tx| {
                    s.settings_ui.open_select_key = None;
                    let val = if chosen == "All eligible skills" {
                        "all"
                    } else {
                        "user"
                    };
                    s.dispatch(Action::Settings(SettingsAction::UpdateWorkspaceDefaults {
                        workspace_id: ws_si_scope.clone(),
                        defaults: json!({ "skillImprovementScope": val }),
                    }));
                })
                .build(k, &mut overlays);

            si_section = si_section.child(
                SettingsRow::new("Improvement scope")
                    .description(
                        "Choose whether only user-authored skills or all eligible local skills can be updated.",
                    )
                    .control(si_scope_select)
                    .build(k, t),
            );

            // Included skills checklist
            let excluded = excluded_skills_list(ws);
            let ws_si_refresh = ws_id.clone();
            let included_body: El = match si_skills {
                Some(items) if !items.is_empty() => {
                    let checks: Vec<El> = items
                        .iter()
                        .filter_map(|item| {
                            let skill_name = item.get("skillName").and_then(Value::as_str)?;
                            let checked = !excluded.iter().any(|ex| ex == skill_name);
                            let name_owned = skill_name.to_string();
                            let excluded_now = excluded.clone();
                            let ws_ex = ws_id.clone();
                            Some(
                                Checkbox::new(checked)
                                    .label(skill_name.to_string())
                                    .on_toggle(move |s: &mut AppState| {
                                        let mut next = excluded_now.clone();
                                        if checked {
                                            if !next.iter().any(|e| e == &name_owned) {
                                                next.push(name_owned.clone());
                                            }
                                        } else {
                                            next.retain(|e| e != &name_owned);
                                        }
                                        s.dispatch(Action::Settings(
                                            SettingsAction::UpdateWorkspaceDefaults {
                                                workspace_id: ws_ex.clone(),
                                                defaults: json!({
                                                    "skillImprovementExcludedSkills": next
                                                }),
                                            },
                                        ));
                                    })
                                    .build(k),
                            )
                        })
                        .collect();
                    row()
                        .w_full()
                        .flex_wrap()
                        .gap(10.0)
                        .px(10.0)
                        .py(10.0)
                        .radius(k.radius.md)
                        .border(1.0, t.border_muted)
                        .children(checks)
                }
                _ => text("No eligible skills found for this scope.")
                    .font(k.ty.small)
                    .color(t.text_muted),
            };

            si_section = si_section.child(
                SettingsRow::new("Included skills")
                    .description("Checked skills can be improved when they are used.")
                    .control(
                        Button::new("Refresh")
                            .variant(ButtonVariant::Outline)
                            .control_size(ControlSize::Small)
                            .icon(&icons::REFRESH_CCW)
                            .on_press(move |s: &mut AppState| {
                                s.dispatch(Action::Settings(
                                    SettingsAction::RefreshSkillImprovementStatus {
                                        workspace_id: ws_si_refresh.clone(),
                                    },
                                ));
                            })
                            .build(k),
                    )
                    .body(included_body)
                    .build(k, t),
            );

            // Queued jobs
            let ws_si_run = ws_id.clone();
            let pending_count = si_pending.map_or(0, Vec::len);
            let pending_body = if let Some(jobs) = si_pending
                && !jobs.is_empty()
            {
                let lines: Vec<El> = jobs
                    .iter()
                    .filter_map(|job| {
                        let name = job.get("skillName").and_then(Value::as_str)?;
                        let uses = job.get("usageCount").and_then(Value::as_u64).unwrap_or(1);
                        Some(
                            text(format!("{name} · {uses} use(s)"))
                                .font(k.ty.small)
                                .color(t.text_muted),
                        )
                    })
                    .collect();
                col().gap(4.0).children(lines)
            } else {
                text("No queued skill jobs.")
                    .font(k.ty.small)
                    .color(t.text_muted)
            };

            si_section = si_section.child(
                SettingsRow::new("Queued jobs")
                    .description(
                        "Queued jobs run after the debounce window or when started manually.",
                    )
                    .control(
                        Button::new("Run queued")
                            .variant(ButtonVariant::Outline)
                            .control_size(ControlSize::Small)
                            .disabled(pending_count == 0)
                            .on_press(move |s: &mut AppState| {
                                s.dispatch(Action::Settings(SettingsAction::RunSkillImprovement {
                                    workspace_id: ws_si_run.clone(),
                                }));
                            })
                            .build(k),
                    )
                    .body(pending_body)
                    .build(k, t),
            );

            // History
            let history_body = if let Some(hist) = si_history
                && !hist.is_empty()
            {
                let items: Vec<El> = hist
                    .iter()
                    .take(5)
                    .filter_map(|entry| {
                        let skill = entry.get("skillName").and_then(Value::as_str)?;
                        let msg = entry.get("message").and_then(Value::as_str).unwrap_or("");
                        let status = entry
                            .get("status")
                            .and_then(Value::as_str)
                            .unwrap_or("done");
                        let tone = match status {
                            "completed" => StatusTone::Success,
                            "failed" => StatusTone::Danger,
                            _ => StatusTone::Neutral,
                        };
                        Some(
                            row()
                                .w_full()
                                .items_center()
                                .justify_between()
                                .gap(8.0)
                                .child(
                                    text(format!("{skill}: {msg}"))
                                        .font(k.ty.small)
                                        .color(t.text_muted)
                                        .wrap(),
                                )
                                .child(status_pill(status, tone, k, t)),
                        )
                    })
                    .collect();
                col().w_full().gap(6.0).children(items)
            } else {
                text("No skill improvement runs yet.")
                    .font(k.ty.small)
                    .color(t.text_muted)
            };
            si_section = si_section.child(
                SettingsRow::new("History")
                    .description("Most recent improvement outcomes.")
                    .body(history_body)
                    .build(k, t),
            );
        }

        // Restore backups
        let backups_body = if let Some(backups) = si_backups
            && !backups.is_empty()
        {
            let items: Vec<El> = backups
                .iter()
                .filter_map(|bk| {
                    let skill_name = bk.get("skillName").and_then(Value::as_str)?;
                    let skill_owned = skill_name.to_string();
                    Some(
                        row()
                            .w_full()
                            .items_center()
                            .justify_between()
                            .gap(8.0)
                            .child(
                                text(skill_name.to_string())
                                    .font(k.ty.small)
                                    .color(t.text_base),
                            )
                            .child(
                                Button::new("Restore")
                                    .variant(ButtonVariant::Outline)
                                    .control_size(ControlSize::Small)
                                    .icon(&icons::REFRESH_CCW)
                                    .on_press(move |s: &mut AppState| {
                                        s.settings_ui.skill_restore_confirm_name =
                                            Some(skill_owned.clone());
                                    })
                                    .build(k),
                            ),
                    )
                })
                .collect();
            col().w_full().gap(6.0).children(items)
        } else {
            text("No restore backups available.")
                .font(k.ty.small)
                .color(t.text_muted)
        };
        si_section = si_section.child(
            SettingsRow::new("Restore backups")
                .description("Backups are created before a skill is changed.")
                .body(backups_body)
                .build(k, t),
        );
    }

    sections.push(si_section.build(k, t));

    // 4. Memory CRUD panel (Advanced file-based OR Legacy remembered facts)
    if adv_mem_enabled {
        sections.push(build_advanced_memory_section(
            s,
            &ws_id,
            k,
            t,
            &mut overlays,
        ));
    } else {
        sections.push(build_legacy_memory_section(s, &ws_id, k, t, &mut overlays));
    }

    // Skill restore confirmation modal
    if let Some(skill_name) = s.settings_ui.skill_restore_confirm_name.clone() {
        let ws_restore = ws_id;
        confirm_dialog(
            ConfirmDialogSpec {
                key: "skill-restore-confirm",
                open: true,
                title: "Restore skill",
                description: format!(
                    "Restore \"{skill_name}\" from its pre-improvement backup? Current local changes in that skill will be replaced by the stored backup."
                ),
                confirm_label: "Restore",
                danger: true,
            },
            |s| s.settings_ui.skill_restore_confirm_name = None,
            move |s| {
                s.settings_ui.skill_restore_confirm_name = None;
                s.dispatch(Action::Settings(SettingsAction::RestoreSkillImprovement {
                    workspace_id: ws_restore.clone(),
                    skill_name: skill_name.clone(),
                }));
            },
            k,
            &mut overlays,
        );
    }

    PageContent::simple(settings_page(sections)).with_overlays(overlays)
}

fn build_advanced_memory_section(
    s: &AppState,
    ws_id: &str,
    k: &Kit,
    t: &ThemeTokens,
    overlays: &mut Vec<El>,
) -> El {
    let mut section = Section::new()
        .title("Memory files")
        .description(
            "Indexed memory files maintained automatically as you work, or added manually.",
        )
        .action(
            Button::new("Add memory")
                .variant(ButtonVariant::Outline)
                .control_size(ControlSize::Small)
                .icon(&icons::PLUS)
                .on_press(|s: &mut AppState| {
                    s.settings_ui.advanced_memory_editing_slug = None;
                    s.settings_ui.advanced_memory_type = "note".to_string();
                    s.settings_ui.advanced_memory_key_edit = TextEdit::new("");
                    s.settings_ui.advanced_memory_desc_edit = TextEdit::new("");
                    s.settings_ui.advanced_memory_content_edit = TextEdit::new("");
                    s.settings_ui.advanced_memory_dialog_open = true;
                })
                .build(k),
        );

    if s.advanced_memories.is_empty() {
        section = section.child(
            EmptyState::new("No memories yet")
                .icon(&icons::BOT)
                .description("They are written automatically as you work, or add one yourself.")
                .build(k, t),
        );
    } else {
        for entry in &s.advanced_memories {
            let slug = entry
                .get("slug")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let name = entry
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(slug.as_str())
                .to_string();
            let desc = entry
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let kind = entry
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("note")
                .to_string();
            let body = entry
                .get("body")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();

            let expanded = s.settings_ui.expanded_advanced_memory_slugs.contains(&slug);
            let slug_toggle = slug.clone();
            let slug_edit = slug.clone();
            let name_edit = name.clone();
            let desc_edit = desc.clone();
            let kind_edit = kind.clone();
            let body_edit = body.clone();
            let slug_del = slug.clone();

            let mut item = col().w_full().px(16.0).py(12.0).gap(8.0).child(
                row()
                    .w_full()
                    .items_center()
                    .justify_between()
                    .gap(12.0)
                    .child(
                        row()
                            .grow(1.0)
                            .min_w(0.0)
                            .items_center()
                            .gap(8.0)
                            .child(
                                Button::new(name.clone())
                                    .variant(ButtonVariant::Ghost)
                                    .control_size(ControlSize::Small)
                                    .icon(if expanded {
                                        &icons::CHEVRON_DOWN
                                    } else {
                                        &icons::CHEVRON_RIGHT
                                    })
                                    .on_press(move |s: &mut AppState| {
                                        if s.settings_ui
                                            .expanded_advanced_memory_slugs
                                            .contains(&slug_toggle)
                                        {
                                            s.settings_ui
                                                .expanded_advanced_memory_slugs
                                                .remove(&slug_toggle);
                                        } else {
                                            s.settings_ui
                                                .expanded_advanced_memory_slugs
                                                .insert(slug_toggle.clone());
                                        }
                                    })
                                    .build(k),
                            )
                            .child(status_pill(kind.to_uppercase(), StatusTone::Neutral, k, t)),
                    )
                    .child(text(desc).font(k.ty.small).color(t.text_muted).wrap()),
            );

            if expanded {
                item = item
                    .child(
                        col()
                            .w_full()
                            .px(12.0)
                            .py(12.0)
                            .radius(k.radius.md)
                            .fill(t.elevated_bg)
                            .child(text(body).font(k.ty.ui).color(t.text_base).wrap()),
                    )
                    .child(
                        row()
                            .items_center()
                            .gap(8.0)
                            .child(
                                Button::new("Edit")
                                    .variant(ButtonVariant::Outline)
                                    .control_size(ControlSize::Small)
                                    .on_press(move |s: &mut AppState| {
                                        s.settings_ui.advanced_memory_editing_slug =
                                            Some(slug_edit.clone());
                                        s.settings_ui.advanced_memory_type = kind_edit.clone();
                                        s.settings_ui.advanced_memory_key_edit =
                                            TextEdit::new(name_edit.as_str());
                                        s.settings_ui.advanced_memory_desc_edit =
                                            TextEdit::new(desc_edit.as_str());
                                        s.settings_ui.advanced_memory_content_edit =
                                            TextEdit::new(body_edit.as_str());
                                        s.settings_ui.advanced_memory_dialog_open = true;
                                    })
                                    .build(k),
                            )
                            .child(
                                Button::new("Delete")
                                    .variant(ButtonVariant::Ghost)
                                    .control_size(ControlSize::Small)
                                    .icon(&icons::TRASH)
                                    .on_press(move |s: &mut AppState| {
                                        s.settings_ui.advanced_memory_delete_confirm_slug =
                                            Some(slug_del.clone());
                                    })
                                    .build(k),
                            ),
                    );
            }

            section = section.child(item);
        }
    }

    // Advanced memory editor dialog
    if s.settings_ui.advanced_memory_dialog_open {
        let editing = s.settings_ui.advanced_memory_editing_slug.is_some();
        let can_save = !s
            .settings_ui
            .advanced_memory_key_edit
            .text
            .trim()
            .is_empty()
            && !s
                .settings_ui
                .advanced_memory_content_edit
                .text
                .trim()
                .is_empty();
        let type_open = s.settings_ui.open_select_key.as_deref() == Some("advanced-memory-type");
        let type_select = Select::new("advanced-memory-type", ADVANCED_MEMORY_TYPES)
            .label("Memory record type")
            .appearance(SelectAppearance::Field)
            .width(180.0)
            .current(Some(s.settings_ui.advanced_memory_type.as_str()))
            .open(type_open)
            .on_toggle(|s: &mut AppState| {
                let open = s.settings_ui.open_select_key.as_deref() == Some("advanced-memory-type");
                s.settings_ui.open_select_key = if open {
                    None
                } else {
                    Some("advanced-memory-type".to_string())
                };
            })
            .on_close(|s: &mut AppState| {
                if s.settings_ui.open_select_key.as_deref() == Some("advanced-memory-type") {
                    s.settings_ui.open_select_key = None;
                }
            })
            .on_choose(|s: &mut AppState, chosen, _tx| {
                s.settings_ui.open_select_key = None;
                s.settings_ui.advanced_memory_type = chosen.to_string();
            })
            .build(k, overlays);

        let ws_save = ws_id.to_string();
        let footer = row()
            .w_full()
            .justify_end()
            .gap(8.0)
            .pt(8.0)
            .child(
                Button::new("Cancel")
                    .variant(ButtonVariant::Ghost)
                    .control_size(ControlSize::Regular)
                    .on_press(|s: &mut AppState| {
                        s.settings_ui.advanced_memory_dialog_open = false;
                        s.settings_ui.advanced_memory_editing_slug = None;
                    })
                    .build(k),
            )
            .child(
                Button::new(if editing {
                    "Save changes"
                } else {
                    "Add memory"
                })
                .variant(ButtonVariant::Contrast)
                .control_size(ControlSize::Regular)
                .disabled(!can_save)
                .on_press(move |s: &mut AppState| {
                    let entry = build_advanced_memory_payload(
                        s.settings_ui.advanced_memory_editing_slug.as_deref(),
                        &s.settings_ui.advanced_memory_key_edit.text,
                        &s.settings_ui.advanced_memory_desc_edit.text,
                        &s.settings_ui.advanced_memory_type,
                        &s.settings_ui.advanced_memory_content_edit.text,
                    );
                    s.dispatch(Action::Settings(SettingsAction::UpsertAdvancedMemory {
                        workspace_id: ws_save.clone(),
                        entry,
                    }));
                    s.settings_ui.advanced_memory_dialog_open = false;
                    s.settings_ui.advanced_memory_editing_slug = None;
                })
                .build(k),
            );

        Dialog::new(
            "advanced-memory-dialog",
            if editing { "Edit memory" } else { "Add memory" },
        )
        .open(true)
        .width(520.0)
        .fit()
        .on_close(|s: &mut AppState| {
            s.settings_ui.advanced_memory_dialog_open = false;
            s.settings_ui.advanced_memory_editing_slug = None;
        })
        .child(
            col()
                .w_full()
                .min_w(0.0)
                .px(16.0)
                .pb(16.0)
                .gap(12.0)
                .child(
                    col()
                        .w_full()
                        .gap(4.0)
                        .child(text("Name").font(k.ty.small_medium).color(t.text_muted))
                        .child(
                            TextInput::new(&s.settings_ui.advanced_memory_key_edit)
                                .label("Name")
                                .placeholder("Project release convention")
                                .width(None)
                                .on_edit(|s: &mut AppState| {
                                    &mut s.settings_ui.advanced_memory_key_edit
                                })
                                .build(k),
                        ),
                )
                .child(
                    col()
                        .w_full()
                        .gap(4.0)
                        .child(text("Type").font(k.ty.small_medium).color(t.text_muted))
                        .child(type_select),
                )
                .child(
                    col()
                        .w_full()
                        .gap(4.0)
                        .child(
                            text("Description")
                                .font(k.ty.small_medium)
                                .color(t.text_muted),
                        )
                        .child(
                            TextInput::new(&s.settings_ui.advanced_memory_desc_edit)
                                .label("Description")
                                .placeholder("Short index summary for recall")
                                .width(None)
                                .on_edit(|s: &mut AppState| {
                                    &mut s.settings_ui.advanced_memory_desc_edit
                                })
                                .build(k),
                        ),
                )
                .child(
                    col()
                        .w_full()
                        .gap(4.0)
                        .child(text("Content").font(k.ty.small_medium).color(t.text_muted))
                        .child(
                            TextArea::new(&s.settings_ui.advanced_memory_content_edit)
                                .label("Content")
                                .placeholder("Details Cowork should recall")
                                .width(None)
                                .rows(5)
                                .on_edit(|s: &mut AppState| {
                                    &mut s.settings_ui.advanced_memory_content_edit
                                })
                                .build(k),
                        ),
                )
                .child(footer),
        )
        .build(k, overlays);
    }

    if let Some(slug) = s.settings_ui.advanced_memory_delete_confirm_slug.clone() {
        let ws_del = ws_id.to_string();
        confirm_dialog(
            ConfirmDialogSpec {
                key: "advanced-memory-delete-confirm",
                open: true,
                title: "Delete memory",
                description: format!(
                    "Delete \"{slug}\"? This memory file will be permanently removed."
                ),
                confirm_label: "Delete",
                danger: true,
            },
            |s| s.settings_ui.advanced_memory_delete_confirm_slug = None,
            move |s| {
                s.settings_ui.advanced_memory_delete_confirm_slug = None;
                s.dispatch(Action::Settings(SettingsAction::DeleteAdvancedMemory {
                    workspace_id: ws_del.clone(),
                    id: slug.clone(),
                }));
            },
            k,
            overlays,
        );
    }

    section.build(k, t)
}

fn scoped_memory_entries(s: &AppState) -> Vec<ScopedMemoryEntry> {
    if !s.scoped_memories.is_empty() {
        return s.scoped_memories.clone();
    }
    s.memory_entries
        .iter()
        .map(|entry: &MemoryEntry| ScopedMemoryEntry {
            id: entry.key.clone(),
            scope: "workspace".to_string(),
            content: entry.content.clone(),
            created_at: None,
            updated_at: None,
            updated_at_ms: entry.updated_at,
        })
        .collect()
}

fn memory_scope_label(scope: &str) -> &'static str {
    if scope == "user" {
        "Everywhere"
    } else {
        "Workspace"
    }
}

fn build_legacy_memory_section(
    s: &AppState,
    ws_id: &str,
    k: &Kit,
    t: &ThemeTokens,
    overlays: &mut Vec<El>,
) -> El {
    let query = s
        .settings_ui
        .memory_filter_edit
        .text
        .trim()
        .to_ascii_lowercase();
    let scope_filter = s.settings_ui.memory_scope_filter.as_str();
    let entries = scoped_memory_entries(s);
    let mut filtered: Vec<ScopedMemoryEntry> = entries
        .into_iter()
        .filter(|entry| {
            let normalized_scope = if entry.scope == "user" {
                "user"
            } else {
                "workspace"
            };
            scope_filter == "all" || normalized_scope == scope_filter
        })
        .filter(|entry| {
            query.is_empty()
                || entry.id.to_ascii_lowercase().contains(&query)
                || entry.content.to_ascii_lowercase().contains(&query)
        })
        .collect();
    filtered.sort_by_key(|e| {
        (
            e.id != HOT_MEMORY_ID,
            e.scope != "user",
            e.id.to_lowercase(),
        )
    });

    let scope_idx = match scope_filter {
        "workspace" => 1,
        "user" => 2,
        _ => 0,
    };
    let ws_refresh = ws_id.to_string();
    let header_actions = row()
        .items_center()
        .flex_wrap()
        .gap(8.0)
        .child(compact_tabs(
            &["All", "Workspace", "Everywhere"],
            scope_idx,
            "Memory scope filter",
            |s: &mut AppState, idx, _tx| {
                s.settings_ui.memory_scope_filter = match idx {
                    1 => "workspace",
                    2 => "user",
                    _ => "all",
                }
                .to_string();
            },
            k,
        ))
        .child(search_input(
            &s.settings_ui.memory_filter_edit,
            "Filter facts",
            "Filter facts…",
            Some(180.0),
            |s: &mut AppState| &mut s.settings_ui.memory_filter_edit,
            |s: &mut AppState, _tx| {
                s.settings_ui.memory_filter_edit = TextEdit::new("");
            },
            k,
        ))
        .child(
            Button::new("Refresh")
                .variant(ButtonVariant::Outline)
                .control_size(ControlSize::Small)
                .icon(&icons::REFRESH_CCW)
                .on_press(move |s: &mut AppState| {
                    s.dispatch(Action::Settings(SettingsAction::ReadMemories {
                        workspace_id: ws_refresh.clone(),
                        scope: None,
                    }));
                })
                .build(k),
        )
        .child(
            Button::new("Add memory")
                .variant(ButtonVariant::Outline)
                .control_size(ControlSize::Small)
                .icon(&icons::PLUS)
                .on_press(|s: &mut AppState| {
                    s.settings_ui.memory_editing_key = None;
                    let default_scope = if s.settings_ui.memory_scope_filter == "user" {
                        "user"
                    } else {
                        "workspace"
                    };
                    s.settings_ui.memory_draft_scope = default_scope.to_string();
                    s.settings_ui.memory_editing_scope = default_scope.to_string();
                    s.settings_ui.memory_key_edit = TextEdit::new("");
                    s.settings_ui.memory_content_edit = TextEdit::new("");
                    s.settings_ui.memory_dialog_open = true;
                })
                .build(k),
        );

    let mut section = Section::new()
        .title("Remembered facts")
        .description("Facts Cowork keeps in mind for this workspace or across every workspace.")
        .action(header_actions);

    if filtered.is_empty() {
        section = section.child(
            EmptyState::new(if query.is_empty() {
                "No remembered facts yet"
            } else {
                "No matching remembered facts"
            })
            .icon(&icons::BOT)
            .action(
                Button::new("Add your first memory")
                    .variant(ButtonVariant::Outline)
                    .control_size(ControlSize::Regular)
                    .icon(&icons::PLUS)
                    .on_press(|s: &mut AppState| {
                        s.settings_ui.memory_editing_key = None;
                        let default_scope = if s.settings_ui.memory_scope_filter == "user" {
                            "user"
                        } else {
                            "workspace"
                        };
                        s.settings_ui.memory_draft_scope = default_scope.to_string();
                        s.settings_ui.memory_editing_scope = default_scope.to_string();
                        s.settings_ui.memory_key_edit = TextEdit::new("");
                        s.settings_ui.memory_content_edit = TextEdit::new("");
                        s.settings_ui.memory_dialog_open = true;
                    })
                    .build(k),
            )
            .build(k, t),
        );
    } else {
        for entry in filtered {
            let entry_scope = if entry.scope == "user" {
                "user".to_string()
            } else {
                "workspace".to_string()
            };
            let title = if entry.id == HOT_MEMORY_ID {
                "Always include".to_string()
            } else {
                entry.id.clone()
            };
            let compound_key = format!("{entry_scope}:{}", entry.id);
            let expanded = s.settings_ui.expanded_memory_keys.contains(&compound_key);
            let key_toggle = compound_key.clone();
            let id_edit = entry.id.clone();
            let scope_edit = entry_scope.clone();
            let content_edit = entry.content.clone();
            let id_del = entry.id.clone();
            let scope_del = entry_scope.clone();

            let updated_label = entry
                .updated_at_ms
                .map(|ts| format!("Updated {}", format_timestamp_friendly(ts)))
                .or_else(|| {
                    entry
                        .updated_at
                        .as_deref()
                        .filter(|u| !u.trim().is_empty())
                        .map(|u| format!("Updated {u}"))
                })
                .unwrap_or_default();

            let mut item = col().w_full().px(16.0).py(12.0).gap(8.0).child(
                row()
                    .w_full()
                    .items_center()
                    .justify_between()
                    .gap(12.0)
                    .child(
                        row()
                            .items_center()
                            .gap(8.0)
                            .child(
                                Button::new(title)
                                    .variant(ButtonVariant::Ghost)
                                    .control_size(ControlSize::Small)
                                    .icon(if expanded {
                                        &icons::CHEVRON_DOWN
                                    } else {
                                        &icons::CHEVRON_RIGHT
                                    })
                                    .on_press(move |s: &mut AppState| {
                                        if s.settings_ui.expanded_memory_keys.contains(&key_toggle)
                                        {
                                            s.settings_ui.expanded_memory_keys.remove(&key_toggle);
                                        } else {
                                            s.settings_ui
                                                .expanded_memory_keys
                                                .insert(key_toggle.clone());
                                        }
                                    })
                                    .build(k),
                            )
                            .child(status_pill(
                                memory_scope_label(&entry_scope),
                                StatusTone::Neutral,
                                k,
                                t,
                            )),
                    )
                    .child(text(updated_label).font(k.ty.small).color(t.text_muted)),
            );

            if expanded {
                item = item
                    .child(
                        col()
                            .w_full()
                            .px(12.0)
                            .py(12.0)
                            .radius(k.radius.md)
                            .fill(t.elevated_bg)
                            .child(
                                text(entry.content.clone())
                                    .font(k.ty.ui)
                                    .color(t.text_base)
                                    .wrap(),
                            ),
                    )
                    .child(
                        row()
                            .items_center()
                            .gap(8.0)
                            .child(
                                Button::new("Edit")
                                    .variant(ButtonVariant::Outline)
                                    .control_size(ControlSize::Small)
                                    .on_press(move |s: &mut AppState| {
                                        s.settings_ui.memory_editing_key = Some(id_edit.clone());
                                        s.settings_ui.memory_editing_scope = scope_edit.clone();
                                        s.settings_ui.memory_draft_scope = scope_edit.clone();
                                        s.settings_ui.memory_key_edit =
                                            TextEdit::new(id_edit.as_str());
                                        s.settings_ui.memory_content_edit =
                                            TextEdit::new(content_edit.as_str());
                                        s.settings_ui.memory_dialog_open = true;
                                    })
                                    .build(k),
                            )
                            .child(
                                Button::new("Delete")
                                    .variant(ButtonVariant::Ghost)
                                    .control_size(ControlSize::Small)
                                    .icon(&icons::TRASH)
                                    .on_press(move |s: &mut AppState| {
                                        s.settings_ui.memory_delete_confirm =
                                            Some((scope_del.clone(), id_del.clone()));
                                    })
                                    .build(k),
                            ),
                    );
            }
            section = section.child(item);
        }
    }

    if s.settings_ui.memory_dialog_open {
        let editing = s.settings_ui.memory_editing_key.is_some();
        let active_scope = if editing {
            s.settings_ui.memory_editing_scope.clone()
        } else {
            s.settings_ui.memory_draft_scope.clone()
        };
        let can_save = !s.settings_ui.memory_content_edit.text.trim().is_empty();
        let ws_save = ws_id.to_string();

        let scope_options = ["Workspace", "Everywhere"];
        let scope_open = s.settings_ui.open_select_key.as_deref() == Some("legacy-memory-scope");
        let scope_select = Select::new("legacy-memory-scope", &scope_options)
            .label("Memory scope")
            .appearance(SelectAppearance::Field)
            .width(180.0)
            .disabled(editing)
            .current(Some(memory_scope_label(&active_scope)))
            .open(scope_open)
            .on_toggle(|s: &mut AppState| {
                let open = s.settings_ui.open_select_key.as_deref() == Some("legacy-memory-scope");
                s.settings_ui.open_select_key = if open {
                    None
                } else {
                    Some("legacy-memory-scope".to_string())
                };
            })
            .on_close(|s: &mut AppState| {
                if s.settings_ui.open_select_key.as_deref() == Some("legacy-memory-scope") {
                    s.settings_ui.open_select_key = None;
                }
            })
            .on_choose(|s: &mut AppState, chosen, _tx| {
                s.settings_ui.open_select_key = None;
                s.settings_ui.memory_draft_scope = if chosen == "Everywhere" {
                    "user".to_string()
                } else {
                    "workspace".to_string()
                };
            })
            .build(k, overlays);

        let footer = row()
            .w_full()
            .justify_end()
            .gap(8.0)
            .pt(8.0)
            .child(
                Button::new("Cancel")
                    .variant(ButtonVariant::Ghost)
                    .control_size(ControlSize::Regular)
                    .on_press(|s: &mut AppState| {
                        s.settings_ui.memory_dialog_open = false;
                        s.settings_ui.memory_editing_key = None;
                    })
                    .build(k),
            )
            .child(
                Button::new(if editing {
                    "Save changes"
                } else {
                    "Add remembered fact"
                })
                .variant(ButtonVariant::Contrast)
                .control_size(ControlSize::Regular)
                .disabled(!can_save)
                .on_press(move |s: &mut AppState| {
                    let editing_id = s.settings_ui.memory_editing_key.clone();
                    let save_scope = if editing_id.is_some() {
                        s.settings_ui.memory_editing_scope.clone()
                    } else {
                        s.settings_ui.memory_draft_scope.clone()
                    };
                    let key = editing_id.unwrap_or_else(|| {
                        resolve_draft_memory_id(&s.settings_ui.memory_key_edit.text)
                    });
                    let content = s.settings_ui.memory_content_edit.text.trim().to_string();
                    if content.is_empty() {
                        return;
                    }
                    s.dispatch(Action::Settings(SettingsAction::UpsertScopedMemory {
                        workspace_id: ws_save.clone(),
                        scope: save_scope,
                        id: Some(key),
                        content,
                        mode: Some("upsert".to_string()),
                    }));
                    s.settings_ui.memory_dialog_open = false;
                    s.settings_ui.memory_editing_key = None;
                })
                .build(k),
            );

        Dialog::new(
            "legacy-memory-dialog",
            if editing {
                "Edit remembered fact"
            } else {
                "Add remembered fact"
            },
        )
        .open(true)
        .width(500.0)
        .fit()
        .on_close(|s: &mut AppState| {
            s.settings_ui.memory_dialog_open = false;
            s.settings_ui.memory_editing_key = None;
        })
        .child(
            k.scroll_bar(
                col()
                    .w_full()
                    .min_w(0.0)
                    .max_h(440.0)
                    .px(16.0)
                    .pb(16.0)
                    .gap(12.0)
                    .scroll(ScrollSpec {
                        stick_bottom: false,
                    })
                    .child(
                        col()
                            .w_full()
                            .gap(4.0)
                            .child(text("Scope").font(k.ty.small_medium).color(t.text_muted))
                            .child(scope_select),
                    )
                    .child(
                        col()
                            .w_full()
                            .gap(4.0)
                            .child(text("Title").font(k.ty.small_medium).color(t.text_muted))
                            .child(
                                TextInput::new(&s.settings_ui.memory_key_edit)
                                    .label("Title")
                                    .placeholder("Optional. Leave blank to always include it.")
                                    .disabled(editing)
                                    .width(None)
                                    .on_edit(|s: &mut AppState| &mut s.settings_ui.memory_key_edit)
                                    .build(k),
                            ),
                    )
                    .child(
                        col()
                            .w_full()
                            .gap(4.0)
                            .child(text("Content").font(k.ty.small_medium).color(t.text_muted))
                            .child(
                                TextArea::new(&s.settings_ui.memory_content_edit)
                                    .label("Content")
                                    .placeholder("What should Cowork remember?")
                                    .width(None)
                                    .rows(6)
                                    .on_edit(|s: &mut AppState| {
                                        &mut s.settings_ui.memory_content_edit
                                    })
                                    .build(k),
                            ),
                    )
                    .child(footer),
            ),
        )
        .build(k, overlays);
    }

    if let Some((del_scope, del_id)) = s.settings_ui.memory_delete_confirm.clone() {
        let ws_del = ws_id.to_string();
        confirm_dialog(
            ConfirmDialogSpec {
                key: "legacy-memory-delete-confirm",
                open: true,
                title: "Delete memory",
                description: format!(
                    "Delete \"{del_id}\" ({})? This memory will be permanently removed.",
                    memory_scope_label(&del_scope)
                ),
                confirm_label: "Delete",
                danger: true,
            },
            |s| s.settings_ui.memory_delete_confirm = None,
            move |s| {
                s.settings_ui.memory_delete_confirm = None;
                s.dispatch(Action::Settings(SettingsAction::DeleteScopedMemory {
                    workspace_id: ws_del.clone(),
                    scope: del_scope.clone(),
                    id: del_id.clone(),
                }));
            },
            k,
            overlays,
        );
    }

    section.build(k, t)
}
